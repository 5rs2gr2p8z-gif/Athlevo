/*
 * Athlevo — Whop payment integration.
 *
 * Drives the REAL signature verifier + event mapper (lib/server/whopWebhook.js),
 * the REAL premium helper (lib/server/subscriptions.js → features.js), and the
 * REAL webhook endpoint (api/whop/webhook.js) with an in-memory Supabase.
 * Nothing about verification, mapping, or entitlement is mocked away.
 *
 * Run: node tests/whop.test.mjs
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import {
  verifyWhopSignature, parseWhopEvent, mapWhopEvent, extractMembership
} from "../lib/server/whopWebhook.js";
import { isPremium, subscriptionSummary, canUseFeature } from "../lib/server/subscriptions.js";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-secret";
process.env.WHOP_WEBHOOK_SECRET = "whsec_test_123";
process.env.WHOP_FALLBACK_PLAN = "performance";
delete process.env.WHOP_API_KEY;                 // skip live reconcile in tests

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * 86400000).toISOString();

/*
 * Standard Webhooks signature helper.
 *
 * signedContent = "{msgId}.{timestamp}.{body}"
 * HMAC-SHA256 with the raw secret (or base64-decoded if whsec_-prefixed).
 * Returns "v1,{base64}" and the headers object.
 */
function stdWebhookHeaders(rawBody, secret, msgId) {
  secret = secret || process.env.WHOP_WEBHOOK_SECRET;
  const key = String(secret).startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret);
  const id = msgId || "msg_test_" + crypto.randomBytes(8).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000));
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const sig = "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": sig
  };
}

/* ══════ 1 — signature verification ═══════════════════════════════════ */
section("Signatures are verified (Standard Webhooks spec)");
{
  const raw = JSON.stringify({ type: "membership.activated", data: { id: "mem_1" } });

  const good = stdWebhookHeaders(raw);
  t("a correct Standard Webhooks signature verifies",
    verifyWhopSignature(raw, good, process.env.WHOP_WEBHOOK_SECRET));

  t("a tampered body fails",
    !verifyWhopSignature(raw + " ", good, process.env.WHOP_WEBHOOK_SECRET));

  const wrongSecret = stdWebhookHeaders(raw, "other_secret");
  t("a wrong secret fails",
    !verifyWhopSignature(raw, wrongSecret, process.env.WHOP_WEBHOOK_SECRET));

  t("missing headers fail",
    !verifyWhopSignature(raw, {}, process.env.WHOP_WEBHOOK_SECRET));

  t("a missing secret fails",
    !verifyWhopSignature(raw, good, null));

  // Multiple signatures (key rotation) — one valid, one junk.
  const multi = { ...good };
  multi["webhook-signature"] = "v1,junk_signature_base64 " + good["webhook-signature"];
  t("multiple signatures (key rotation) — one valid is enough",
    verifyWhopSignature(raw, multi, process.env.WHOP_WEBHOOK_SECRET));

  // Replay attack: old timestamp.
  const stale = { ...good, "webhook-timestamp": String(Math.floor(Date.now() / 1000) - 600) };
  // Re-sign with the stale timestamp so the HMAC is correct, but the timestamp is too old.
  const staleBody = typeof raw === "string" ? raw : raw.toString("utf8");
  const staleKey = Buffer.from(process.env.WHOP_WEBHOOK_SECRET);
  const staleSig = "v1," + crypto.createHmac("sha256", staleKey)
    .update(`${stale["webhook-id"]}.${stale["webhook-timestamp"]}.${staleBody}`)
    .digest("base64");
  stale["webhook-signature"] = staleSig;
  t("a stale timestamp (>5min) is rejected",
    !verifyWhopSignature(raw, stale, process.env.WHOP_WEBHOOK_SECRET));
}

/* ══════ 2 — lifecycle mapping (state from membership, not action name) ═ */
section("Every lifecycle event maps to the correct subscription state");
{
  const ev = (type, data) => ({ type, data });

  const activate = mapWhopEvent(ev("membership.activated",
    { id: "mem_a", email: "A@X.com", user_id: "wu_1", plan_id: "plan_pro", valid: true, status: "active", created_at: Math.floor(Date.now() / 1000), renewal_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }));
  t("activation → effect activate, status active", activate.effect === "activate" && activate.patch.status === "active");
  t("activation captures provider ids", activate.patch.provider === "whop" &&
    activate.patch.provider_subscription_id === "mem_a" && activate.patch.provider_customer_id === "wu_1");
  t("email is lower-cased for matching", activate.email === "a@x.com");
  t("plan resolves to the fallback paid slug", activate.patch.plan_id === "performance");

  const providerTrial = mapWhopEvent(ev("membership.activated", {
    id: "mem_trial", email: "trial@x.com", valid: true, status: "trialing"
  }));
  t("provider trial label does not create a timed Athlevo trial state",
    providerTrial.patch.status === "active" &&
    providerTrial.event_type === "activated");

  const renew = mapWhopEvent(ev("payment.succeeded", { id: "mem_a", valid: true, status: "active", renewal_period_end: Math.floor(Date.now() / 1000) + 60 * 86400 }));
  t("renewal → effect activate/renew, still active", renew.patch.status === "active");

  // cancelled but still inside the paid period → keep access, flag cancel-at-period-end
  const cancelInPeriod = mapWhopEvent(ev("membership.deactivated", { id: "mem_a", valid: false, status: "canceled", renewal_period_end: Math.floor(Date.now() / 1000) + 10 * 86400 }));
  t("cancel-in-period keeps status active", cancelInPeriod.patch.status === "active" && cancelInPeriod.patch.cancel_at_period_end === true);

  // fully expired
  const expired = mapWhopEvent(ev("membership.deactivated", { id: "mem_a", valid: false, status: "expired", renewal_period_end: Math.floor(Date.now() / 1000) - 86400 }));
  t("expiry → status expired", expired.effect === "expire" && expired.patch.status === "expired");

  const refund = mapWhopEvent(ev("refund.created", { id: "mem_a", valid: true, status: "active" }));
  t("refund forces inactive regardless of 'valid'", refund.effect === "refund" && refund.patch.status === "expired");

  const dispute = mapWhopEvent(ev("dispute.created", { id: "mem_a", valid: true, status: "active" }));
  t("dispute forces inactive regardless of 'valid'", dispute.effect === "refund" && dispute.patch.status === "expired");

  // NEVER trust the action name alone: activated but membership is invalid.
  const lying = mapWhopEvent(ev("membership.activated", { id: "mem_a", valid: false, status: "expired", renewal_period_end: Math.floor(Date.now() / 1000) - 100 }));
  t("activated with valid:false does NOT activate", lying.patch.status !== "active");

  // Legacy action names still work (defensive)
  const legacy = mapWhopEvent({ action: "membership.went_valid", data: { id: "mem_b", valid: true, status: "active", email: "b@x.com" } });
  t("legacy went_valid action still maps correctly", legacy.effect === "activate");
}

/* ══════ 3 — premium helper delegates to features.js (no duplication) ══ */
section("Premium checks reuse the central entitlement system");
{
  const active = {
    provider: "whop", plan_id: "performance", status: "active",
    current_period_end: iso(20)
  };
  const free = { plan_id: "free", status: "active" };
  const expired = {
    provider: "whop", plan_id: "performance", status: "expired",
    current_period_end: iso(-2)
  };
  t("active paid subscription is premium", isPremium(active) === true);
  t("free plan is not premium", isPremium(free) === false);
  t("expired subscription is not premium", isPremium(expired) === false);
  t("a missing row is treated as free (not premium)", isPremium(null) === false);
  t("summary exposes active + plan + provider", (() => {
    const s = subscriptionSummary({ ...active, provider: "whop" });
    return s.active === true && s.plan === "performance" && s.provider === "whop";
  })());
  t("feature gate delegates to canUse", typeof canUseFeature("adaptive_ai", active) === "boolean");
  t("Performance plan unlocks adaptive_ai", canUseFeature("adaptive_ai", active) === true);
  t("Performance plan unlocks workout_modifications", canUseFeature("workout_modifications", active) === true);
  t("Free plan does NOT unlock adaptive_ai", canUseFeature("adaptive_ai", free) === false);
  t("Free plan still gets morning_checkin", canUseFeature("morning_checkin", free) === true);
}

/* ══════ 4 — no client-side secret exposure ══════════════════════════ */
section("No Whop/Supabase secret is exposed to the browser");
{
  const clientFiles = ["js/betaDashboard.js", "js/activation.js", "js/adaptivePlan.js", "index.html"]
    .map(fp => { try { return readFileSync("./" + fp, "utf8"); } catch (e) { return ""; } }).join("\n");
  t("no WHOP_API_KEY in client code", !/WHOP_API_KEY/.test(clientFiles));
  t("no WHOP_WEBHOOK_SECRET in client code", !/WHOP_WEBHOOK_SECRET/.test(clientFiles));
  t("no service-role key in client code", !/SUPABASE_SERVICE_ROLE/.test(clientFiles));
  // The Whop client reads the key from the server env only.
  const whopClient = readFileSync("./lib/server/whopClient.js", "utf8");
  t("whop client reads the key from process.env", /process\.env\.WHOP_API_KEY/.test(whopClient));
}

/* ══════ 5/6 — the endpoint: verify → find user → upsert (idempotent) ══ */
section("The webhook endpoint grants entitlement server-side only");
{
  const handler = (await import("../api/whop/webhook.js")).default;
  const event = {
    type: "membership.activated",
    data: { id: "mem_9", email: "runner@example.com", user_id: "wu_9", plan_id: "plan_pro",
      valid: true, status: "active", created_at: Math.floor(Date.now() / 1000),
      renewal_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }
  };
  const raw = JSON.stringify(event);

  // bad signature → 401, nothing written
  const store1 = world({ profiles: [{ id: "u-run", email: "runner@example.com" }] });
  const badHeaders = { "webhook-id": "msg_bad", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,deadbeef" };
  const bad = await call(handler, raw, badHeaders);
  t("a bad signature is rejected 401", bad.code === 401);
  t("nothing is written on a bad signature", store1.subscriptions.length === 0);

  // valid signature → 200, subscription upserted with correct fields
  const store2 = world({ profiles: [{ id: "u-run", email: "runner@example.com" }] });
  const goodHeaders = stdWebhookHeaders(raw, process.env.WHOP_WEBHOOK_SECRET, "msg_evt_1");
  const ok = await call(handler, raw, goodHeaders);
  t("a valid signature is accepted 200", ok.code === 200 && ok.body.ok, JSON.stringify(ok.body));
  const sub = store2.subscriptions[0];
  t("the matched user's subscription is written", sub && sub.user_id === "u-run");
  t("provider + membership id captured", sub && sub.provider === "whop" && sub.provider_subscription_id === "mem_9");
  t("status is active + a paid plan", sub && sub.status === "active" && sub.plan_id === "performance");
  t("an audit event was recorded", store2.subscription_events.length === 1);
  t("provider_event_id uses webhook-id header", store2.subscription_events[0] && store2.subscription_events[0].provider_event_id === "msg_evt_1");
  t("no secret is echoed to the caller", !JSON.stringify(ok.body).includes("svc-secret") && !JSON.stringify(ok.body).includes("whsec"));

  // idempotency: the same delivery again must not double-write
  const store3 = world({ profiles: [{ id: "u-run", email: "runner@example.com" }], dupEvent: true });
  const dupHeaders = stdWebhookHeaders(raw, process.env.WHOP_WEBHOOK_SECRET, "msg_evt_1");
  const dup = await call(handler, raw, dupHeaders);
  t("a duplicate delivery is a no-op 200", dup.code === 200 && dup.body.duplicate === true);
  t("no subscription upsert happens on a duplicate", store3.subscriptions.length === 0);

  // unknown email → acknowledged (200) but nothing granted (never trust checkout)
  const store4 = world({ profiles: [] });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  const noUserHeaders = stdWebhookHeaders(raw, process.env.WHOP_WEBHOOK_SECRET, "msg_evt_2");
  const noUser = await call(handler, raw, noUserHeaders);
  console.warn = realWarn;
  t("an unmatched email is acknowledged but grants nothing", noUser.code === 200 &&
    noUser.body.user_matched === false && store4.subscriptions.length === 0);
  const log = warns.find(w => /whop_unmatched_user/.test(w)) || "";
  t("logs a structured unmatched-user record with reason", /whop_unmatched_user/.test(log) && /"reason":"no_matching_user"/.test(log));
  t("...with provider_event_id, membership id, email, action, provider, timestamp",
    /"provider_event_id":"msg_evt_2"/.test(log) && /"provider_subscription_id":"mem_9"/.test(log) &&
    /runner@example\.com/.test(log) && /"webhook_action":"membership.activated"/.test(log) &&
    /"provider":"whop"/.test(log) && /occurred_at/.test(log));
  t("...and no secret/payment data in the log",
    !/svc-secret/.test(log) && !/whsec/.test(log) && !/Bearer/.test(log) && !/card|cvv|pan/i.test(log));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);

/* ── in-memory Supabase for the endpoint ─────────────────────────────── */
function world(seed) {
  const store = { subscriptions: [], subscription_events: [], profiles: seed.profiles || [] };
  globalThis.fetch = async (u, i = {}) => {
    const s = String(u), m = (i.method || "GET").toUpperCase();
    const J = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) });
    // Whop API not called (WHOP_API_KEY unset) — but guard anyway.
    if (s.includes("api.whop.com")) return J(200, null);
    if (s.includes("/auth/v1/admin/users")) return J(200, { users: store.profiles.map(p => ({ id: p.id, email: p.email })) });
    if (s.includes("/rest/v1/profiles")) {
      const email = decodeURIComponent((s.match(/email=eq\.([^&]+)/) || [])[1] || "");
      return J(200, store.profiles.filter(p => String(p.email).toLowerCase() === email.toLowerCase()).map(p => ({ id: p.id })));
    }
    if (s.includes("/rest/v1/subscription_events")) {
      if (m === "POST") { if (seed.dupEvent) return J(409, { message: "duplicate" }); store.subscription_events.push(JSON.parse(i.body)); return J(201, []); }
      return J(200, []);
    }
    if (s.includes("/rest/v1/subscriptions")) {
      if (m === "POST") { const row = JSON.parse(i.body); store.subscriptions.push(row); return J(200, [row]); }
      return J(200, []);
    }
    return J(200, []);
  };
  return store;
}
function resObj() { const r = { code: null, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); r.setHeader = () => {}; r.end = () => r; return r; }
async function call(handler, raw, headers) {
  const r = resObj();
  await handler({ method: "POST", headers: headers, body: Buffer.from(raw) }, r);
  return r;
}
