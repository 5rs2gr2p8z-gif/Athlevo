/*
 * Pay-before-signup Whop claim loop — fixture tests, no live ₱597 charge.
 * Run: node tests/whop-pending-claim.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { mapWhopEvent } from "../lib/server/whopWebhook.js";
import { resolveEntitlement, ACCESS_STATES } from "../lib/server/features.js";
import {
  normalizeWhopEmail,
  pendingRowFromMapped,
  isGrantableWhopStatus
} from "../lib/server/whopPending.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-secret";
process.env.WHOP_WEBHOOK_SECRET = "whsec_test_123";
process.env.WHOP_FALLBACK_PLAN = "performance";
delete process.env.WHOP_API_KEY;
delete process.env.POSTHOG_KEY;

function stdWebhookHeaders(rawBody, secret, msgId) {
  secret = secret || process.env.WHOP_WEBHOOK_SECRET;
  const key = String(secret).startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret);
  const id = msgId || "msg_test_" + crypto.randomBytes(8).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000));
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const sig = "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig };
}

function claimSim(store, userId, email) {
  const normalized = String(email || "").toLowerCase();
  const auth = store.users.find(u => u.id === userId);
  if (!auth || String(auth.email).toLowerCase() !== normalized) {
    return { ok: true, claimed: false, reason: "email_mismatch" };
  }
  const already = store.pending.find(r => r.claimed_user_id === userId);
  const unclaimed = store.pending.filter(r => r.email === normalized && !r.claimed_at);
  const grantable = unclaimed.filter(r => r.status === "active")
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (!grantable.length) {
    if (unclaimed.length) return { ok: true, claimed: false, reason: "invalid_status" };
    if (already) return { ok: true, claimed: true, reason: "already_claimed", membership_id: already.whop_membership_id };
    return { ok: true, claimed: false, reason: "no_pending_purchase" };
  }
  const row = grantable[0];
  const patch = row.subscription_patch || {};
  const sub = {
    user_id: userId,
    plan_id: patch.plan_id || row.plan_id || "performance",
    status: patch.status || row.status,
    provider: "whop",
    provider_subscription_id: row.whop_membership_id,
    current_period_end: patch.current_period_end || row.current_period_end
  };
  const existing = store.subscriptions.findIndex(s => s.user_id === userId);
  if (existing >= 0) store.subscriptions[existing] = sub;
  else store.subscriptions.push(sub);
  unclaimed.forEach(r => { r.claimed_user_id = userId; r.claimed_at = new Date().toISOString(); });
  return { ok: true, claimed: true, reason: "claimed", membership_id: row.whop_membership_id };
}

function claimWorld(seed) {
  const store = {
    users: seed.users || [],
    pending: seed.pending || [],
    subscriptions: seed.subscriptions || [],
    rpcCalls: 0
  };
  globalThis.fetch = async (u, i = {}) => {
    const s = String(u), m = (i.method || "GET").toUpperCase();
    const J = (code, body) => ({
      ok: code >= 200 && code < 300, status: code,
      json: async () => body, text: async () => JSON.stringify(body)
    });
    if (s.includes("/auth/v1/user")) {
      const header = String((i.headers && (i.headers.Authorization || i.headers.authorization)) || "");
      const token = header.replace(/^Bearer\s+/i, "");
      const user = store.users.find(x => x.token === token);
      return user ? J(200, { id: user.id, email: user.email }) : J(401, { error: "no" });
    }
    if (s.includes("/rest/v1/rpc/claim_pending_whop_entitlement")) {
      store.rpcCalls += 1;
      const body = JSON.parse(i.body || "{}");
      return J(200, claimSim(store, body.p_user_id, body.p_email));
    }
    if (s.includes("/rest/v1/pending_whop_entitlements")) return J(200, store.pending.filter(r => !r.claimed_at));
    if (s.includes("i.posthog.com")) return J(200, { ok: true });
    return J(200, []);
  };
  return store;
}

function resObj() {
  const r = { code: null, body: null };
  r.status = c => (r.code = c, r);
  r.json = b => (r.body = b, r);
  r.setHeader = () => {};
  r.end = () => r;
  return r;
}

const activated = {
  type: "membership.activated",
  data: {
    id: "mem_claim",
    email: "buyer@example.com",
    user_id: "wu_claim",
    plan_id: "plan_pro",
    valid: true,
    status: "active",
    created_at: Math.floor(Date.now() / 1000),
    renewal_period_end: Math.floor(Date.now() / 1000) + 30 * 86400
  }
};

section("CASE 1 — existing user still gets a direct subscription");
{
  t("matched mapping still activates", mapWhopEvent(activated).effect === "activate");
}

section("CASE 2 / 7 — unmatched webhook persists one pending row");
{
  const handler = (await import("../api/whop/webhook.js")).default;
  const raw = JSON.stringify(activated);
  const store = { subscriptions: [], subscription_events: [], profiles: [], pending: [] };
  globalThis.fetch = async (u, i = {}) => {
    const s = String(u), m = (i.method || "GET").toUpperCase();
    const J = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) });
    if (s.includes("/auth/v1/admin/users")) return J(200, { users: [] });
    if (s.includes("/rest/v1/profiles")) return J(200, []);
    if (s.includes("/rest/v1/pending_whop_entitlements") && m === "POST") {
      const row = JSON.parse(i.body);
      const existing = store.pending.find(p => p.whop_membership_id === row.whop_membership_id);
      if (existing) Object.assign(existing, row);
      else store.pending.push(row);
      return J(200, [row]);
    }
    if (s.includes("/rest/v1/subscriptions") && m === "POST") {
      store.subscriptions.push(JSON.parse(i.body));
      return J(200, store.subscriptions);
    }
    if (s.includes("/rest/v1/subscription_events") && m === "POST") {
      store.subscription_events.push(JSON.parse(i.body));
      return J(201, []);
    }
    return J(200, []);
  };
  const r1 = resObj();
  await handler({ method: "POST", headers: stdWebhookHeaders(raw, null, "msg_p1"), body: Buffer.from(raw) }, r1);
  const r2 = resObj();
  await handler({ method: "POST", headers: stdWebhookHeaders(raw, null, "msg_p2"), body: Buffer.from(raw) }, r2);
  t("first unmatched webhook stores pending, not a subscription",
    r1.code === 200 && r1.body.pending === true && store.subscriptions.length === 0 && store.pending.length === 1);
  t("duplicate unmatched webhook does not create a second pending row",
    store.pending.length === 1);
}

section("CASE 3 / 8 / 11 — same email claims once, then idempotent");
{
  const handler = (await import("../lib/server/whopClaimEndpoint.js")).default;
  const mapped = mapWhopEvent(activated);
  const pending = pendingRowFromMapped(mapped, "msg_p1");
  const store = claimWorld({
    users: [{ id: "u1", email: "buyer@example.com", token: "tok-u1" }],
    pending: [pending]
  });
  const first = resObj();
  await handler({
    method: "POST",
    headers: { authorization: "Bearer tok-u1" },
    body: JSON.stringify({ email: "attacker@example.com", membership_id: "mem_forged" })
  }, first);
  t("claim creates the canonical Whop subscription",
    first.code === 200 && first.body.claimed === true &&
    store.subscriptions.length === 1 && store.subscriptions[0].provider === "whop");
  const ent = resolveEntitlement(store.subscriptions[0]);
  t("claimed row resolves paid_active", ent.accessState === ACCESS_STATES.PAID_ACTIVE);
  t("pending row is marked claimed", store.pending.every(r => r.claimed_at));
  const second = resObj();
  await handler({ method: "POST", headers: { authorization: "Bearer tok-u1" }, body: "{}" }, second);
  t("second claim is idempotent",
    second.code === 200 && second.body.claimed === true &&
    second.body.reason === "already_claimed" && store.subscriptions.length === 1);
  t("client body email/membership cannot retarget the claim",
    store.subscriptions[0].user_id === "u1");
}

section("CASE 4 — different email cannot claim");
{
  const handler = (await import("../lib/server/whopClaimEndpoint.js")).default;
  const mapped = mapWhopEvent(activated);
  const store = claimWorld({
    users: [{ id: "u2", email: "other@example.com", token: "tok-u2" }],
    pending: [pendingRowFromMapped(mapped, "msg_p1")]
  });
  const res = resObj();
  await handler({ method: "POST", headers: { authorization: "Bearer tok-u2" }, body: "{}" }, res);
  t("other email does not receive a subscription",
    res.code === 200 && res.body.claimed === false &&
    res.body.reason === "no_pending_purchase" && store.subscriptions.length === 0);
}

section("CASE 5 / 6 — query param and localStorage never grant entitlement");
{
  const handler = (await import("../lib/server/whopClaimEndpoint.js")).default;
  const unauth = resObj();
  await handler({ method: "POST", headers: {}, body: "{}" }, unauth);
  t("claim without a session is 401", unauth.code === 401);
  const ui = readFileSync("./js/diagnosticUI.js", "utf8");
  const acq = readFileSync("./js/diagnosticAcquisition.js", "utf8");
  const index = readFileSync("./index.html", "utf8");
  t("checkout_return does not write subscriptions",
    !/from\("subscriptions"\)/.test(ui) && !/from\("subscriptions"\)\.insert/.test(acq));
  t("logged-out checkout_return opens auth, not another checkout",
    /hasCheckoutReturn\(\)/.test(ui) && /showCheckoutReturnWelcome/.test(ui) &&
    /hasWhopCheckoutReturn\(\)/.test(index));
  t("claim is posted to the server with the session bearer only",
    /action=claim_pending_purchase/.test(acq) && /getSession\(\)/.test(acq));
  t("welcome copy does not assert payment success",
    /Create your Athlevo account to continue/.test(index) &&
    !/Payment received\?/.test(index));
}

section("CASE 9 / 10 — Google and Email share routeAfterAuth");
{
  const html = readFileSync("./index.html", "utf8");
  t("email signup awaits routeAfterAuth",
    /closeAuth\(\);\s*await routeAfterAuth\(user\.id\);/.test(html));
  t("email signup no longer jumps to startOnboarding",
    !/closeAuth\(\);\s*startOnboarding\(\);/.test(html));
  t("claim runs before diagnostic attach",
    html.indexOf("reconcileWhopPurchase") < html.indexOf("AthlevoDiagnosticHandoff.attach") &&
    html.indexOf("reconcileWhopPurchase") > html.indexOf("async function routeAfterAuth"));
}

section("CASE 12 — payment claim is server-side, diagnostic localStorage optional");
{
  const acq = readFileSync("./js/diagnosticAcquisition.js", "utf8");
  t("claim fetch does not read diagnostic localStorage",
    /async function reconcileWhopPurchase[\s\S]*?getSession/.test(acq) &&
    !/async function reconcileWhopPurchase[\s\S]*?athlevo_pending_diagnostic/.test(acq));
}

section("CASE 13 — cancelled/expired pending does not grant paid_active");
{
  const cancelled = mapWhopEvent({
    type: "membership.went_invalid",
    data: { id: "mem_x", email: "buyer@example.com", status: "expired", valid: false }
  });
  t("invalid mapping is not grantable", !isGrantableWhopStatus(cancelled.patch && cancelled.patch.status));
  const store = claimWorld({
    users: [{ id: "u1", email: "buyer@example.com", token: "tok-u1" }],
    pending: [pendingRowFromMapped(cancelled, "msg_x")]
  });
  const handler = (await import("../lib/server/whopClaimEndpoint.js")).default;
  const res = resObj();
  await handler({ method: "POST", headers: { authorization: "Bearer tok-u1" }, body: "{}" }, res);
  t("expired pending returns invalid_status and no subscription",
    res.body.reason === "invalid_status" && store.subscriptions.length === 0);
}

section("CASE 14 — Whop trialing still maps to active");
{
  const trial = mapWhopEvent({
    type: "membership.activated",
    data: { id: "mem_t", email: "buyer@example.com", status: "trialing", valid: true }
  });
  t("trialing maps to stored active", trial.patch.status === "active" && trial.effect === "activate");
  t("trialing pending is grantable", isGrantableWhopStatus(trial.patch.status));
}

section("CASE 15 / 16 — onboarding missing-field behavior preserved");
{
  const ob = readFileSync("./js/onboarding.js", "utf8");
  const html = readFileSync("./index.html", "utf8");
  t("prefill still skips satisfied screens",
    /function obNextIncompleteStep/.test(ob) && /obPrefillFromProfile/.test(ob));
  t("paid incomplete still enters onboarding",
    /route === "onboarding"/.test(html) && /startOnboarding\(\)/.test(html));
  t("paid complete still enters the app",
    /onboarding_complete === true/.test(html) && /showScreen\("screen-today"\)/.test(html));
}

section("Security + schema");
{
  const mig = readFileSync("./migrations/2026-08-28_pending_whop_entitlements.sql", "utf8");
  t("pending table has RLS and no client grant",
    /enable row level security/.test(mig) &&
    /grant execute on function public.claim_pending_whop_entitlement/.test(mig) &&
    /to service_role/.test(mig) &&
    /from public, anon, authenticated/.test(mig));
  t("membership id is unique", /pending_whop_entitlements_membership_key unique \(whop_membership_id\)/.test(mig));
  t("ensure_free_trial skips insert while unmatched Whop is pending",
    /pending_whop_entitlements p/.test(mig) && /claimed_at is null/.test(mig));
  t("email helper lowercases", normalizeWhopEmail("  Buyer@Example.com ") === "buyer@example.com");
  const providers = readFileSync("./api/providers/index.js", "utf8");
  t("claim is folded into providers, not a new serverless function",
    /action === "claim_pending_purchase"/.test(providers));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
