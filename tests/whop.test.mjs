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
const sign = (raw, secret) => crypto.createHmac("sha256", secret || process.env.WHOP_WEBHOOK_SECRET).update(raw).digest("hex");

/* ══════ 1 — signature verification ═══════════════════════════════════ */
section("Signatures are verified (never trust an unsigned payload)");
{
  const raw = JSON.stringify({ action: "membership.went_valid", data: { id: "mem_1" } });
  t("a correct HMAC-SHA256 signature verifies", verifyWhopSignature(raw, sign(raw), process.env.WHOP_WEBHOOK_SECRET));
  t("a 'sha256=' prefixed signature verifies", verifyWhopSignature(raw, "sha256=" + sign(raw), process.env.WHOP_WEBHOOK_SECRET));
  t("a tampered body fails", !verifyWhopSignature(raw + " ", sign(raw), process.env.WHOP_WEBHOOK_SECRET));
  t("a wrong secret fails", !verifyWhopSignature(raw, sign(raw, "other"), process.env.WHOP_WEBHOOK_SECRET));
  t("a missing signature fails", !verifyWhopSignature(raw, null, process.env.WHOP_WEBHOOK_SECRET));
  t("a missing secret fails", !verifyWhopSignature(raw, sign(raw), null));
}

/* ══════ 2 — lifecycle mapping (state from membership, not action name) ═ */
section("Every lifecycle event maps to the correct subscription state");
{
  const ev = (action, data) => ({ action, data });

  const activate = mapWhopEvent(ev("membership.went_valid",
    { id: "mem_a", email: "A@X.com", user_id: "wu_1", plan_id: "plan_pro", valid: true, status: "active", created_at: Math.floor(Date.now() / 1000), renewal_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }));
  t("activation → effect activate, status active", activate.effect === "activate" && activate.patch.status === "active");
  t("activation captures provider ids", activate.patch.provider === "whop" &&
    activate.patch.provider_subscription_id === "mem_a" && activate.patch.provider_customer_id === "wu_1");
  t("email is lower-cased for matching", activate.email === "a@x.com");
  t("plan resolves to the fallback paid slug", activate.patch.plan_id === "performance");

  const renew = mapWhopEvent(ev("payment.succeeded", { id: "mem_a", valid: true, status: "active", renewal_period_end: Math.floor(Date.now() / 1000) + 60 * 86400 }));
  t("renewal → effect activate/renew, still active", renew.patch.status === "active");

  // cancelled but still inside the paid period → keep access, flag cancel-at-period-end
  const cancelInPeriod = mapWhopEvent(ev("membership.went_invalid", { id: "mem_a", valid: false, status: "canceled", renewal_period_end: Math.floor(Date.now() / 1000) + 10 * 86400 }));
  t("cancel-in-period keeps status active", cancelInPeriod.patch.status === "active" && cancelInPeriod.patch.cancel_at_period_end === true);

  // fully expired
  const expired = mapWhopEvent(ev("membership.went_invalid", { id: "mem_a", valid: false, status: "expired", renewal_period_end: Math.floor(Date.now() / 1000) - 86400 }));
  t("expiry → status expired", expired.effect === "expire" && expired.patch.status === "expired");

  const refund = mapWhopEvent(ev("payment.refunded", { id: "mem_a", valid: true, status: "active" }));
  t("refund forces inactive regardless of 'valid'", refund.effect === "refund" && refund.patch.status === "expired");

  // NEVER trust the action name alone: went_valid but membership is invalid.
  const lying = mapWhopEvent(ev("membership.went_valid", { id: "mem_a", valid: false, status: "expired", renewal_period_end: Math.floor(Date.now() / 1000) - 100 }));
  t("went_valid with valid:false does NOT activate", lying.patch.status !== "active");
}

/* ══════ 3 — premium helper delegates to features.js (no duplication) ══ */
section("Premium checks reuse the central entitlement system");
{
  const active = { plan_id: "performance", status: "active", current_period_end: iso(20) };
  const free = { plan_id: "free", status: "active" };
  const expired = { plan_id: "performance", status: "expired", current_period_end: iso(-2) };
  t("active paid subscription is premium", isPremium(active) === true);
  t("free plan is not premium", isPremium(free) === false);
  t("expired subscription is not premium", isPremium(expired) === false);
  t("a missing row is treated as free (not premium)", isPremium(null) === false);
  t("summary exposes active + plan + provider", (() => {
    const s = subscriptionSummary({ ...active, provider: "whop" });
    return s.active === true && s.plan === "performance" && s.provider === "whop";
  })());
  t("feature gate delegates to canUse", typeof canUseFeature("adaptive_plan", active) === "boolean");
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
    id: "evt_1", action: "membership.went_valid",
    data: { id: "mem_9", email: "runner@example.com", user_id: "wu_9", plan_id: "plan_pro",
      valid: true, status: "active", created_at: Math.floor(Date.now() / 1000),
      renewal_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }
  };
  const raw = JSON.stringify(event);

  // bad signature → 401, nothing written
  const store1 = world({ profiles: [{ id: "u-run", email: "runner@example.com" }] });
  const bad = await call(handler, raw, "deadbeef");
  t("a bad signature is rejected 401", bad.code === 401);
  t("nothing is written on a bad signature", store1.subscriptions.length === 0);

  // valid signature → 200, subscription upserted with correct fields
  const store2 = world({ profiles: [{ id: "u-run", email: "runner@example.com" }] });
  const ok = await call(handler, raw, sign(raw));
  t("a valid signature is accepted 200", ok.code === 200 && ok.body.ok, JSON.stringify(ok.body));
  const sub = store2.subscriptions[0];
  t("the matched user's subscription is written", sub && sub.user_id === "u-run");
  t("provider + membership id captured", sub && sub.provider === "whop" && sub.provider_subscription_id === "mem_9");
  t("status is active + a paid plan", sub && sub.status === "active" && sub.plan_id === "performance");
  t("an audit event was recorded", store2.subscription_events.length === 1);
  t("no secret is echoed to the caller", !JSON.stringify(ok.body).includes("svc-secret") && !JSON.stringify(ok.body).includes("whsec"));

  // idempotency: the same delivery again must not double-write
  const store3 = world({ profiles: [{ id: "u-run", email: "runner@example.com" }], dupEvent: true });
  const dup = await call(handler, raw, sign(raw));
  t("a duplicate delivery is a no-op 200", dup.code === 200 && dup.body.duplicate === true);
  t("no subscription upsert happens on a duplicate", store3.subscriptions.length === 0);

  // unknown email → acknowledged (200) but nothing granted (never trust checkout)
  const store4 = world({ profiles: [] });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  const noUser = await call(handler, raw, sign(raw));
  console.warn = realWarn;
  t("an unmatched email is acknowledged but grants nothing", noUser.code === 200 &&
    noUser.body.user_matched === false && store4.subscriptions.length === 0);
  const log = warns.find(w => /whop_unmatched_user/.test(w)) || "";
  t("logs a structured unmatched-user record with reason", /whop_unmatched_user/.test(log) && /"reason":"no_matching_user"/.test(log));
  t("...with provider_event_id, membership id, email, action, provider, timestamp",
    /"provider_event_id":"evt_1"/.test(log) && /"provider_subscription_id":"mem_9"/.test(log) &&
    /runner@example\.com/.test(log) && /"webhook_action":"membership.went_valid"/.test(log) &&
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
async function call(handler, raw, signature) {
  const r = resObj();
  await handler({ method: "POST", headers: { "x-whop-signature": signature }, body: Buffer.from(raw) }, r);
  return r;
}
