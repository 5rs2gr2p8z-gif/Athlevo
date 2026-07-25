/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Whop webhook: signature verification + event mapping (pure)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Everything here is PURE and unit-testable — no network, no database. The
 *  api/whop/webhook.js function does the I/O; this module owns the two things
 *  that must be exactly right:
 *
 *    1. verifyWhopSignature(rawBody, header, secret) — HMAC-SHA256 over the
 *       RAW request bytes, compared timing-safely. Anything that fails is
 *       rejected: we NEVER trust an unverified payload.
 *
 *    2. mapWhopEvent(event, opts) — translate a Whop membership/payment event
 *       into a patch for Athlevo's existing, provider-agnostic `subscriptions`
 *       table (status vocabulary: trialing | active | past_due | grace |
 *       cancelled | expired) plus a `subscription_events` audit type. The
 *       subscription's ACTIVE state is derived from Whop's authoritative
 *       membership validity, never from the event NAME alone.
 */

import crypto from "node:crypto";

/* ── 1. Signature verification ─────────────────────────────────────────── */

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch (e) { return false; }
}

/*
 * Whop follows the Standard Webhooks spec (https://www.standardwebhooks.com).
 *
 * Headers:
 *   webhook-id        — unique event id (stable across retries)
 *   webhook-timestamp — unix seconds
 *   webhook-signature — "v1,<base64-hmac-sha256>" (space-separated for rotation)
 *
 * Signed content = "{webhook-id}.{webhook-timestamp}.{rawBody}"
 * Secret: raw string from the Whop dashboard. If the dashboard ever returns a
 *   `whsec_`-prefixed value, strip the prefix and base64-decode to get the key.
 *
 * rawBody MUST be the exact bytes Whop sent (no re-serialization).
 */
export function verifyWhopSignature(rawBody, headers, secret) {
  if (!secret || !headers || rawBody == null) return false;

  const msgId     = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"];
  if (!msgId || !timestamp || !signature) return false;

  // Reject timestamps more than 5 minutes from now (replay-attack guard).
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 300) return false;

  // Decode the HMAC key.
  const key = String(secret).startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret);

  // Standard Webhooks signed content: "{id}.{timestamp}.{body}"
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedContent = `${msgId}.${timestamp}.${body}`;
  const expected = "v1," + crypto.createHmac("sha256", key).update(signedContent).digest("base64");

  // The header may contain multiple space-separated signatures (key rotation).
  return String(signature).split(" ").some(sig => timingSafeEqualStr(sig.trim(), expected));
}

export function parseWhopEvent(rawBody) {
  try { return JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")); }
  catch (e) { return null; }
}

/* ── 2. Event → subscription mapping ───────────────────────────────────── */

// Whop timestamps are usually unix SECONDS; tolerate ms and ISO strings too.
function toIso(v) {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function pick(obj, keys) {
  for (const k of keys) { if (obj && obj[k] != null && obj[k] !== "") return obj[k]; }
  return null;
}

/*
 * Extract the membership essentials from any reasonable Whop payload shape.
 * Whop has shifted field names across API versions, so we read defensively.
 */
export function extractMembership(event) {
  const d = (event && (event.data || event.membership || event)) || {};
  const user = d.user || d.customer || {};
  return {
    membershipId: pick(d, ["id", "membership_id", "membership"]),
    customerId: pick(d, ["user_id", "customer_id"]) || pick(user, ["id", "user_id"]),
    email: (pick(d, ["email"]) || pick(user, ["email"]) || "").toLowerCase() || null,
    planId: pick(d, ["plan_id", "plan", "product_id", "product", "price_id"]),
    status: (pick(d, ["status"]) || "").toLowerCase() || null,
    valid: typeof d.valid === "boolean" ? d.valid : null,
    createdAt: toIso(pick(d, ["created_at", "created"])),
    periodEnd: toIso(pick(d, ["renewal_period_end", "expires_at", "valid_until", "current_period_end", "renewal_period_start"])),
    interval: (pick(d, ["billing_period", "interval"]) || "").toLowerCase() || null
  };
}

// Map a Whop plan/product id → Athlevo plan slug. Configurable via a JSON map
// (WHOP_PLAN_MAP); defaults to the tier the checkout link sells.
export function resolvePlanSlug(planId, planMap, fallback) {
  const fb = fallback || "performance";
  if (!planId) return fb;
  if (planMap && planMap[planId]) return planMap[planId];
  return fb;
}

function billingInterval(raw) {
  if (/ann|year/i.test(raw || "")) return "annual";
  if (/month/i.test(raw || "")) return "monthly";
  return "none";
}

/*
 * mapWhopEvent(event, { planMap, fallbackPlan, nowMs })
 *   → { effect, event_type, membershipId, customerId, email, patch }
 *     | { effect: "ignore" }
 *
 * effect: "activate" | "renew" | "cancel" | "expire" | "refund" | "ignore".
 * patch: the columns to upsert on public.subscriptions.
 *
 * The final status is derived from Whop's authoritative membership validity
 * (`valid` / `status`) and the action — never the action name in isolation.
 */
export function mapWhopEvent(event, opts = {}) {
  if (!event) return { effect: "ignore" };
  const now = opts.nowMs || Date.now();
  const action = String(event.action || event.type || event.event || "").toLowerCase();
  const m = extractMembership(event);
  if (!m.membershipId && !m.email) return { effect: "ignore" };  // nothing to key on

  const isRefund = /refund|dispute|chargeback/.test(action);
  const isInvalidating = /went_invalid|invalid|deactivat|expired|cancel|deleted|revoked|failed|past_due/.test(action);
  const isValidating = /went_valid|valid|succeeded|created|renew|activ|payment\.succeeded/.test(action);

  // Authoritative "does the athlete currently have access?"
  let hasAccess;
  if (m.valid != null) hasAccess = m.valid;
  else if (m.status) hasAccess = /active|trialing|completed|valid|paid/.test(m.status) && !/cancel|expire|refund|unpaid|past_due/.test(m.status);
  else hasAccess = isValidating && !isInvalidating;
  if (isRefund) hasAccess = false;

  const periodEndMs = m.periodEnd ? Date.parse(m.periodEnd) : null;
  const stillInPeriod = periodEndMs != null && periodEndMs > now;

  // Decide Athlevo lifecycle status + audit event.
  let status, event_type, effect, cancelAtPeriodEnd = false, cancelledAt = null;
  if (isRefund) {
    status = "expired"; event_type = "cancelled"; effect = "refund"; cancelledAt = new Date(now).toISOString();
  } else if (m.status === "trialing" && hasAccess) {
    status = "trialing"; event_type = "trial_started"; effect = "activate";
  } else if (m.status === "past_due" || (isInvalidating && /past_due|unpaid|failed/.test(m.status || action))) {
    status = "past_due"; event_type = "payment_failed"; effect = "cancel";
  } else if (hasAccess && (isValidating || m.status === "active" || m.status === "completed")) {
    status = "active"; event_type = "activated"; effect = "activate";
  } else if (!hasAccess && stillInPeriod) {
    // cancelled but access continues until the end of the paid period.
    status = "active"; cancelAtPeriodEnd = true; event_type = "cancelled"; effect = "cancel";
    cancelledAt = new Date(now).toISOString();
  } else if (!hasAccess) {
    status = "expired"; event_type = "expired"; effect = "expire";
  } else {
    return { effect: "ignore" };
  }

  const patch = {
    plan_id: resolvePlanSlug(m.planId, opts.planMap, opts.fallbackPlan),
    status,
    billing_interval: billingInterval(m.interval),
    current_period_start: m.createdAt || null,
    current_period_end: m.periodEnd || null,
    cancel_at_period_end: cancelAtPeriodEnd,
    cancelled_at: cancelledAt,
    provider: "whop",
    provider_customer_id: m.customerId || null,
    provider_subscription_id: m.membershipId || null,
    provider_price_id: m.planId || null,
    updated_at: new Date(now).toISOString(),
    metadata: {
      whop_membership_id: m.membershipId || null,
      whop_customer_id: m.customerId || null,
      whop_plan: m.planId || null,
      whop_status: m.status || null,
      last_action: action || null
    }
  };
  if (effect === "activate") patch.started_at = m.createdAt || new Date(now).toISOString();

  return {
    effect, event_type, membershipId: m.membershipId, customerId: m.customerId,
    email: m.email, planId: patch.plan_id, patch
  };
}

export const WHOP_WEBHOOK_VERSION = "whop-webhook-v1";
