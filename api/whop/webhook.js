/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Whop webhook endpoint  (server-side payment source of truth)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The ONLY place a subscription becomes active. The browser is never trusted:
 *  entitlement is granted exclusively from Whop's signed webhooks + the Whop
 *  server API.
 *
 *  Flow:
 *    1. Read the RAW request body (bodyParser disabled — HMAC needs exact bytes).
 *    2. Verify the Whop signature. Unverified → 401, nothing is written.
 *    3. Reconcile: re-fetch the membership from Whop's API so we act on the
 *       authoritative state, not the payload alone.
 *    4. Map the event → Athlevo's provider-agnostic subscriptions schema.
 *    5. Find the Supabase user by the checkout email.
 *    6. Idempotently record the audit event and upsert the subscription (service
 *       role). Duplicate deliveries are no-ops.
 *
 *  Always returns 2xx on a handled event so Whop stops retrying; 401 only for a
 *  bad signature, 5xx only for an unexpected server fault (so Whop retries).
 */

import {
  verifyWhopSignature, parseWhopEvent, mapWhopEvent, extractMembership
} from "../../lib/server/whopWebhook.js";
import { makeWhopClient } from "../../lib/server/whopClient.js";
import { captureServerEvent } from "../../lib/server/productAnalytics.js";

// Disable Vercel's body parser so we receive the exact bytes Whop signed.
export const config = { api: { bodyParser: false } };

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;

let PLAN_MAP = {};
try { PLAN_MAP = JSON.parse(process.env.WHOP_PLAN_MAP || "{}"); } catch (e) { PLAN_MAP = {}; }
const FALLBACK_PLAN = process.env.WHOP_FALLBACK_PLAN || "performance";

function send(res, code, payload) { return res.status(code).json(payload); }
function enc(s) { return encodeURIComponent(String(s)); }

// Collect the raw request body as a Buffer.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === "string") return resolve(Buffer.from(req.body));
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Service-role PostgREST helper. Returns parsed JSON; throws with .status.
async function sbRest(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`supabase ${res.status}`); e.status = res.status; e.body = text; throw e; }
  return text ? JSON.parse(text) : [];
}

// Resolve the Supabase auth user id from the checkout email.
async function findUserIdByEmail(email) {
  if (!email) return null;
  // 1) A profiles.email column, if the project has one.
  try {
    const rows = await sbRest(`profiles?email=eq.${enc(email)}&select=id&limit=1`);
    if (Array.isArray(rows) && rows[0] && rows[0].id) return rows[0].id;
  } catch (e) { /* fall through */ }
  // 2) GoTrue admin — filtered, then a bounded scan as a fallback.
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${enc(email)}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if (r.ok) {
      const j = await r.json();
      const users = (j && j.users) || (Array.isArray(j) ? j : []);
      const hit = users.find(u => String(u.email || "").toLowerCase() === email);
      if (hit) return hit.id;
    }
  } catch (e) { /* not found */ }
  return null;
}

// Idempotent audit ledger write. Returns false if this event was already seen.
async function recordEventOnce(userId, subscriptionId, mapped, providerEventId) {
  try {
    await sbRest("subscription_events", {
      method: "POST", prefer: "return=minimal",
      body: {
        user_id: userId,
        subscription_id: subscriptionId || null,
        event_type: mapped.event_type,
        to_plan: mapped.planId,
        to_status: mapped.patch.status,
        provider: "whop",
        provider_event_id: providerEventId,
        metadata: mapped.patch.metadata || {}
      }
    });
    return true;
  } catch (e) {
    if (e.status === 409) return false;      // unique(provider, provider_event_id) → duplicate delivery
    throw e;
  }
}

// Upsert the single subscription row for the athlete (user_id is unique).
async function upsertSubscription(userId, patch) {
  const rows = await sbRest("subscriptions?on_conflict=user_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: { user_id: userId, ...patch }
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed." }); }
  if (!SUPABASE_URL || !KEY) return send(res, 500, { error: "Server not configured." });

  // 1. Raw body.
  let raw;
  try { raw = await readRawBody(req); } catch (e) { return send(res, 400, { error: "Bad body." }); }

  // 2. Verify the signature (Standard Webhooks spec).
  //    Headers: webhook-id, webhook-timestamp, webhook-signature.
  if (!verifyWhopSignature(raw, req.headers, WHOP_WEBHOOK_SECRET)) {
    return send(res, 401, { error: "Invalid signature." });
  }

  const event = parseWhopEvent(raw);
  if (!event) return send(res, 400, { error: "Unparseable event." });

  try {
    // 3. Reconcile against Whop's authoritative API (best-effort).
    let authoritative = event;
    try {
      const membershipId = extractMembership(event).membershipId;
      const whop = makeWhopClient();
      if (membershipId && whop.isConfigured()) {
        const fresh = await whop.getMembership(membershipId);
        if (fresh) authoritative = { action: event.action || event.type, data: fresh };
      }
    } catch (e) { /* Whop unreachable → fall back to the signed payload */ }

    // 4. Map to Athlevo's subscription schema.
    const mapped = mapWhopEvent(authoritative, { planMap: PLAN_MAP, fallbackPlan: FALLBACK_PLAN });
    if (mapped.effect === "ignore") return send(res, 200, { ok: true, ignored: true });

    // The provider event id (stable per Whop delivery). The Standard Webhooks
    // `webhook-id` header is the authoritative dedup key (unchanged across
    // retries). Fall back to event.id or a compound key.
    const providerEventId = req.headers["webhook-id"] || event.id || `${mapped.membershipId}:${mapped.event_type}:${mapped.patch.current_period_end || ""}`;

    // 5. Find the athlete by checkout email.
    const userId = await findUserIdByEmail(mapped.email);
    if (!userId) {
      /*
       * Users may purchase using an email different from their Athlevo account.
       * These logs allow manual reconciliation without interrupting payment
       * processing: we do NOT grant access, do NOT error, and DO return success
       * so Whop stops retrying. The record carries only what support needs —
       * NEVER API keys, webhook secrets, card/payment data, or the raw payload.
       */
      console.warn("[whop] " + JSON.stringify({
        event: "whop_unmatched_user",
        reason: "no_matching_user",
        provider: "whop",
        provider_event_id: providerEventId,
        provider_subscription_id: mapped.membershipId || null,   // Whop membership id
        checkout_email: mapped.email || null,
        webhook_action: String(event.action || event.type || event.event || "") || null,
        occurred_at: new Date().toISOString()
      }));
      return send(res, 200, { ok: true, user_matched: false });
    }

    // 6. Idempotent audit + subscription upsert.
    const first = await recordEventOnce(userId, null, mapped, providerEventId);
    if (!first) return send(res, 200, { ok: true, duplicate: true });

    await upsertSubscription(userId, mapped.patch);

    // Paid activation is authoritative only after signature verification and
    // the idempotent subscription write above.
    if (mapped.effect === "activate" && mapped.patch.status === "active") {
      await captureServerEvent(userId, "subscription_activated", {
        source: "whop_webhook"
      });
    }

    return send(res, 200, { ok: true, effect: mapped.effect, status: mapped.patch.status });
  } catch (err) {
    // Unexpected fault → 500 so Whop retries the delivery.
    console.error("[whop] webhook processing failed:", err && err.message);
    return send(res, 500, { error: "Processing failed." });
  }
}
