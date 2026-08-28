/*
 * Server-side paid conversion analytics: fail-open PostHog capture,
 * first-activation vs renewal, identity, and privacy.
 *
 * Run: node tests/server-paid-conversion-analytics.test.mjs
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import {
  captureServerEvent,
  captureServerEventBestEffort,
  paidActivationProperties
} from "../lib/server/productAnalytics.js";
import { mapWhopEvent } from "../lib/server/whopWebhook.js";
import {
  pendingRowFromMapped
} from "../lib/server/whopPending.js";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-secret";
process.env.WHOP_WEBHOOK_SECRET = "whsec_test_123";
process.env.WHOP_FALLBACK_PLAN = "performance";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsk_test_secret";
process.env.POSTHOG_KEY = "phc_test_server";
process.env.POSTHOG_HOST = "https://us.i.posthog.com";
process.env.POSTHOG_CAPTURE_TIMEOUT_MS = "40";
delete process.env.WHOP_API_KEY;
delete process.env.PAYMONGO_SECRET_KEY;

const USER_ID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "runner@example.com";

let p = 0, f = 0;
const t = (n, c, e) => {
  c ? (p++, console.log("PASS — " + n))
    : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : "")));
};
const section = s => console.log("\n──── " + s + " ────");

function stdWebhookHeaders(rawBody, msgId) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
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

function paymongoSigned(raw, at = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET)
    .update(`${at}.${raw}`).digest("hex");
  return `t=${at},te=${digest},li=`;
}

function paymongoPaidEvent(overrides = {}) {
  return {
    data: {
      id: overrides.eventId || "evt_paid_1",
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        livemode: false,
        created_at: Math.floor(Date.now() / 1000),
        data: {
          id: "cs_1",
          type: "checkout_session",
          attributes: {
            reference_number: "ATH-PM-1",
            checkout_url: "https://checkout.paymongo.com/cs_secret_leak",
            metadata: {
              athlevo_user_id: overrides.userId === undefined ? USER_ID : overrides.userId,
              athlevo_product: overrides.product || "ATHLEVO_PRO_MONTHLY"
            },
            payments: [{
              id: "pay_1",
              attributes: {
                amount: overrides.amount === undefined ? 59700 : overrides.amount,
                currency: overrides.currency || "PHP",
                status: "paid",
                paid_at: Math.floor(Date.now() / 1000),
                source: { type: "qrph" }
              }
            }]
          }
        }
      }
    }
  };
}

function resObj() {
  const r = { code: null, body: null, headers: {} };
  r.status = c => (r.code = c, r);
  r.json = b => (r.body = b, r);
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  return r;
}

function parseCapture(init) {
  try { return JSON.parse(init && init.body ? init.body : "{}"); }
  catch (e) { return {}; }
}

function assertPaidCapture(body, { distinctId, source, provider }) {
  t("event is subscription_activated", body.event === "subscription_activated");
  t("distinct_id is the Supabase UUID", body.properties && body.properties.distinct_id === distinctId);
  t("source is correct", body.properties && body.properties.source === source);
  t("provider is correct", body.properties && body.properties.provider === provider);
  t("plan_id is performance", body.properties && body.properties.plan_id === "performance");
  t("price_php is 597 string", body.properties && body.properties.price_php === "597");
  t("user_id is not an extra event property", !Object.prototype.hasOwnProperty.call(body.properties || {}, "user_id"));
}

function assertNoPii(body) {
  const raw = JSON.stringify(body);
  const props = JSON.stringify(body.properties || {});
  t("PostHog payload has no email", !/email/i.test(props) && !raw.includes(EMAIL));
  t("PostHog payload has no name token checkout URL or bearer",
    !/"name"/i.test(props) && !/token/i.test(props) &&
    !/checkout\.paymongo\.com/i.test(raw) && !/Bearer/i.test(raw) &&
    !/svc-secret/.test(raw) && !/whsec/.test(raw));
}

function whopActivateRaw(email = EMAIL) {
  return JSON.stringify({
    type: "membership.activated",
    data: {
      id: "mem_9",
      email,
      user_id: "wu_9",
      plan_id: "plan_pro",
      valid: true,
      status: "active",
      created_at: Math.floor(Date.now() / 1000),
      renewal_period_end: Math.floor(Date.now() / 1000) + 30 * 86400
    }
  });
}

function whopWorld(seed = {}) {
  const store = {
    subscriptions: seed.subscriptions ? seed.subscriptions.slice() : [],
    subscription_events: [],
    profiles: seed.profiles || [{ id: USER_ID, email: EMAIL }],
    pending: [],
    captures: [],
    posthogStatus: seed.posthogStatus === undefined ? 200 : seed.posthogStatus,
    posthogHang: seed.posthogHang === true,
    posthogThrow: seed.posthogThrow === true,
    dupEvent: seed.dupEvent === true
  };
  globalThis.fetch = async (url, init = {}) => {
    const s = String(url);
    const m = (init.method || "GET").toUpperCase();
    const J = (code, body) => ({
      ok: code >= 200 && code < 300, status: code,
      json: async () => body, text: async () => JSON.stringify(body)
    });
    if (s.includes("/capture/")) {
      if (store.posthogThrow) throw new Error("posthog down");
      if (store.posthogHang) {
        return new Promise((resolve, reject) => {
          if (init.signal) {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      }
      store.captures.push(parseCapture(init));
      return J(store.posthogStatus, { ok: store.posthogStatus < 300 });
    }
    if (s.includes("api.whop.com")) return J(200, null);
    if (s.includes("/auth/v1/admin/users")) {
      return J(200, { users: store.profiles.map(p => ({ id: p.id, email: p.email })) });
    }
    if (s.includes("/rest/v1/profiles")) {
      const email = decodeURIComponent((s.match(/email=eq\.([^&]+)/) || [])[1] || "");
      return J(200, store.profiles.filter(p => String(p.email).toLowerCase() === email.toLowerCase()).map(p => ({ id: p.id })));
    }
    if (s.includes("/rest/v1/pending_whop_entitlements")) {
      if (m === "POST") {
        const row = JSON.parse(init.body);
        store.pending.push(row);
        return J(200, [row]);
      }
      return J(200, store.pending);
    }
    if (s.includes("/rest/v1/subscription_events")) {
      if (m === "POST") {
        if (store.dupEvent) return J(409, { message: "duplicate" });
        store.subscription_events.push(JSON.parse(init.body));
        return J(201, []);
      }
      return J(200, []);
    }
    if (s.includes("/rest/v1/subscriptions")) {
      if (m === "POST") {
        const row = JSON.parse(init.body);
        const idx = store.subscriptions.findIndex(x => x.user_id === row.user_id);
        if (idx >= 0) store.subscriptions[idx] = { ...store.subscriptions[idx], ...row };
        else store.subscriptions.push(row);
        return J(200, [row]);
      }
      return J(200, store.subscriptions);
    }
    return J(200, []);
  };
  return store;
}

async function deliverWhop(handler, raw, headers) {
  const r = resObj();
  await handler({ method: "POST", headers, body: Buffer.from(raw) }, r);
  return r;
}

function paymongoWorld(seed = {}) {
  const store = {
    captures: [],
    rpcCalls: 0,
    applyResult: seed.applyResult || {
      applied: true, duplicate: false, event_type: "activated",
      paid_until: "2026-10-20T00:00:00Z"
    },
    posthogStatus: seed.posthogStatus === undefined ? 200 : seed.posthogStatus,
    posthogHang: seed.posthogHang === true,
    posthogThrow: seed.posthogThrow === true
  };
  globalThis.fetch = async (url, init = {}) => {
    const s = String(url);
    const J = (code, body) => new Response(JSON.stringify(body), { status: code });
    if (s.includes("/capture/")) {
      if (store.posthogThrow) throw new Error("posthog down");
      if (store.posthogHang) {
        return new Promise((resolve, reject) => {
          if (init.signal) {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      }
      store.captures.push(parseCapture(init));
      return J(store.posthogStatus, { ok: true });
    }
    if (s.includes("payment_transactions?provider=eq.paymongo")) {
      return J(200, [{
        user_id: USER_ID, amount_cents: 59700, currency: "PHP",
        product_id: "ATHLEVO_PRO_MONTHLY", entitlement_days: 30, status: "pending",
        metadata: { livemode: false }
      }]);
    }
    if (s.includes("/auth/v1/admin/users/")) return J(200, { id: USER_ID });
    if (s.endsWith("/rpc/apply_paymongo_payment")) {
      store.rpcCalls += 1;
      return J(200, store.applyResult);
    }
    if (s.endsWith("/rpc/apply_paymongo_refund")) {
      return J(200, { applied: true, duplicate: false });
    }
    return J(404, {});
  };
  return store;
}

async function deliverPaymongo(handler, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const r = resObj();
  await handler({
    method: "POST",
    body,
    headers: { "paymongo-signature": paymongoSigned(body.toString()) }
  }, r);
  return r;
}

const { default: whopHandler } = await import("../api/whop/webhook.js");
const { default: paymongoHandler } = await import("../lib/server/paymongoWebhookEndpoint.js");
const { default: claimHandler } = await import("../lib/server/whopClaimEndpoint.js");

section("paidActivationProperties + fail-open helper");
{
  const props = paidActivationProperties("whop_webhook", "whop");
  t("helper sets source/provider/plan/price",
    props.source === "whop_webhook" && props.provider === "whop" &&
    props.plan_id === "performance" && props.price_php === "597");

  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(parseCapture(init));
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  captureServerEventBestEffort(USER_ID, "subscription_activated", {
    ...paidActivationProperties("whop_webhook", "whop"),
    email: EMAIL,
    name: "Runner",
    token: "secret-token",
    checkout_url: "https://checkout.paymongo.com/cs_x"
  });
  t("best-effort capture ran", captured.length === 1);
  assertPaidCapture(captured[0], {
    distinctId: USER_ID, source: "whop_webhook", provider: "whop"
  });
  t("unsafe keys were stripped",
    !captured[0].properties.email && !captured[0].properties.name &&
    !captured[0].properties.token && !captured[0].properties.checkout_url);
}

section("A. Whop first activation");
{
  const store = whopWorld();
  const raw = whopActivateRaw();
  const res = await deliverWhop(whopHandler, raw, stdWebhookHeaders(raw, "msg_first"));
  t("Whop webhook succeeds", res.code === 200 && res.body && res.body.ok === true);
  t("subscription was written", store.subscriptions.length === 1 && store.subscriptions[0].user_id === USER_ID);
  t("capture called once", store.captures.length === 1);
  assertPaidCapture(store.captures[0], {
    distinctId: USER_ID, source: "whop_webhook", provider: "whop"
  });
  assertNoPii(store.captures[0]);
}

section("B. PayMongo first activation");
{
  const store = paymongoWorld();
  const res = await deliverPaymongo(paymongoHandler, paymongoPaidEvent());
  t("PayMongo webhook succeeds", res.code === 200 && res.body && res.body.ok === true);
  t("RPC applied first activation", store.rpcCalls === 1 && res.body.result.applied === true);
  t("capture called once", store.captures.length === 1);
  assertPaidCapture(store.captures[0], {
    distinctId: USER_ID, source: "paymongo_webhook", provider: "paymongo"
  });
  assertNoPii(store.captures[0]);
}

section("C. Whop claim");
{
  const activated = {
    type: "membership.activated",
    data: {
      id: "mem_claim", email: EMAIL, user_id: "wu_claim", plan_id: "plan_pro",
      valid: true, status: "active",
      created_at: Math.floor(Date.now() / 1000),
      renewal_period_end: Math.floor(Date.now() / 1000) + 30 * 86400
    }
  };
  const pending = pendingRowFromMapped(mapWhopEvent(activated), "msg_p1");
  const store = {
    users: [{ id: USER_ID, email: EMAIL, token: "tok-u1" }],
    pending: [pending],
    subscriptions: [],
    captures: []
  };
  function claimSim(userId, email) {
    const normalized = String(email || "").toLowerCase();
    const auth = store.users.find(u => u.id === userId);
    if (!auth || String(auth.email).toLowerCase() !== normalized) {
      return { ok: true, claimed: false, reason: "email_mismatch" };
    }
    const already = store.pending.find(r => r.claimed_user_id === userId);
    const unclaimed = store.pending.filter(r => r.email === normalized && !r.claimed_at);
    const grantable = unclaimed.filter(r => r.status === "active");
    if (!grantable.length) {
      if (already) {
        return {
          ok: true, claimed: true, reason: "already_claimed",
          membership_id: already.whop_membership_id
        };
      }
      return { ok: true, claimed: false, reason: "no_pending_purchase" };
    }
    const row = grantable[0];
    store.subscriptions.push({
      user_id: userId, plan_id: "performance", status: "active", provider: "whop",
      provider_subscription_id: row.whop_membership_id
    });
    unclaimed.forEach(r => {
      r.claimed_user_id = userId;
      r.claimed_at = new Date().toISOString();
    });
    return { ok: true, claimed: true, reason: "claimed", membership_id: row.whop_membership_id };
  }
  globalThis.fetch = async (url, init = {}) => {
    const s = String(url);
    const J = (code, body) => ({
      ok: code >= 200 && code < 300, status: code,
      json: async () => body, text: async () => JSON.stringify(body)
    });
    if (s.includes("/capture/")) {
      store.captures.push(parseCapture(init));
      return J(200, { ok: true });
    }
    if (s.includes("/auth/v1/user")) return J(200, { id: USER_ID, email: EMAIL });
    if (s.includes("/rest/v1/rpc/claim_pending_whop_entitlement")) {
      const body = JSON.parse(init.body || "{}");
      return J(200, claimSim(body.p_user_id, body.p_email));
    }
    if (s.includes("/rest/v1/pending_whop_entitlements")) {
      return J(200, store.pending.filter(r => !r.claimed_at));
    }
    return J(200, []);
  };

  const first = resObj();
  await claimHandler({ method: "POST", headers: { authorization: "Bearer tok-u1" }, body: "{}" }, first);
  t("claim succeeds", first.code === 200 && first.body.reason === "claimed");
  const activations = store.captures.filter(c => c.event === "subscription_activated");
  t("claimed captures subscription_activated once", activations.length === 1);
  assertPaidCapture(activations[0], {
    distinctId: USER_ID, source: "whop_claim", provider: "whop"
  });

  const second = resObj();
  await claimHandler({ method: "POST", headers: { authorization: "Bearer tok-u1" }, body: "{}" }, second);
  t("already_claimed succeeds", second.code === 200 && second.body.reason === "already_claimed");
  t("already_claimed does not recapture subscription_activated",
    store.captures.filter(c => c.event === "subscription_activated").length === 1);
}

section("D. Replay");
{
  const store = whopWorld({ dupEvent: true });
  const raw = whopActivateRaw();
  const res = await deliverWhop(whopHandler, raw, stdWebhookHeaders(raw, "msg_replay"));
  t("replayed Whop webhook is 200 duplicate", res.code === 200 && res.body.duplicate === true);
  t("replayed Whop webhook does not capture", store.captures.length === 0);

  const pm = paymongoWorld({
    applyResult: { applied: false, duplicate: true, paid_until: "2026-10-20T00:00:00Z" }
  });
  const pmRes = await deliverPaymongo(paymongoHandler, paymongoPaidEvent({ eventId: "evt_dup" }));
  t("PayMongo duplicate is 200", pmRes.code === 200 && pmRes.body.result.duplicate === true);
  t("PayMongo applied=false does not capture", pm.captures.length === 0);
}

section("E. PayMongo renewal");
{
  const store = paymongoWorld({
    applyResult: {
      applied: true, duplicate: false, event_type: "renewed",
      paid_until: "2026-11-20T00:00:00Z"
    }
  });
  const res = await deliverPaymongo(paymongoHandler, paymongoPaidEvent({ eventId: "evt_renew" }));
  t("renewal webhook succeeds", res.code === 200 && res.body.ok === true);
  t("renewal still applied entitlement", store.rpcCalls === 1 && res.body.result.applied === true);
  t("renewal paid_until returned", res.body.result.paid_until === "2026-11-20T00:00:00Z");
  t("renewal does not capture subscription_activated", store.captures.length === 0);
}

section("Whop already paid_active is not recaptured");
{
  const future = new Date(Date.now() + 20 * 86400000).toISOString();
  const store = whopWorld({
    subscriptions: [{
      user_id: USER_ID, plan_id: "performance", status: "active",
      provider: "whop", current_period_end: future
    }]
  });
  const raw = JSON.stringify({
    type: "payment.succeeded",
    data: {
      id: "mem_9", email: EMAIL, valid: true, status: "active",
      renewal_period_end: Math.floor(Date.now() / 1000) + 60 * 86400
    }
  });
  const res = await deliverWhop(whopHandler, raw, stdWebhookHeaders(raw, "msg_renew"));
  t("Whop renewal webhook succeeds", res.code === 200 && res.body.ok === true);
  t("Whop still upserts on renewal", store.subscriptions.length === 1);
  t("Whop already paid_active does not recapture", store.captures.length === 0);
}

section("F. PostHog 500");
{
  const store = whopWorld({ posthogStatus: 500 });
  const raw = whopActivateRaw();
  const res = await deliverWhop(whopHandler, raw, stdWebhookHeaders(raw, "msg_500"));
  t("Whop still 200 when PostHog 500", res.code === 200 && store.subscriptions.length === 1);

  const pm = paymongoWorld({ posthogStatus: 500 });
  const pmRes = await deliverPaymongo(paymongoHandler, paymongoPaidEvent({ eventId: "evt_500" }));
  t("PayMongo still 200 when PostHog 500", pmRes.code === 200 && pm.rpcCalls === 1);
}

section("G. PostHog timeout");
{
  const store = whopWorld({ posthogHang: true });
  const raw = whopActivateRaw();
  const started = Date.now();
  const res = await deliverWhop(whopHandler, raw, stdWebhookHeaders(raw, "msg_hang"));
  const elapsed = Date.now() - started;
  t("Whop still 200 when PostHog hangs", res.code === 200 && store.subscriptions.length === 1);
  t("webhook does not wait for PostHog timeout", elapsed < 200);

  const result = await captureServerEvent(
    USER_ID,
    "subscription_activated",
    paidActivationProperties("whop_webhook", "whop")
  );
  t("awaited capture returns false on timeout", result === false);
}

section("H. fetch throws");
{
  const store = whopWorld({ posthogThrow: true });
  const raw = whopActivateRaw();
  const res = await deliverWhop(whopHandler, raw, stdWebhookHeaders(raw, "msg_throw"));
  t("Whop still 200 when PostHog fetch throws", res.code === 200 && store.subscriptions.length === 1);

  const pm = paymongoWorld({ posthogThrow: true });
  const pmRes = await deliverPaymongo(paymongoHandler, paymongoPaidEvent({ eventId: "evt_throw" }));
  t("PayMongo still 200 when PostHog fetch throws", pmRes.code === 200 && pm.rpcCalls === 1);
}

section("I. POSTHOG_KEY missing");
{
  const prev = process.env.POSTHOG_KEY;
  delete process.env.POSTHOG_KEY;
  const store = whopWorld();
  const raw = whopActivateRaw();
  const res = await deliverWhop(whopHandler, raw, stdWebhookHeaders(raw, "msg_nokey"));
  t("Whop still 200 when POSTHOG_KEY missing", res.code === 200 && store.subscriptions.length === 1);
  t("no capture without key", store.captures.length === 0);
  process.env.POSTHOG_KEY = prev;
}

section("K. Non-success events do not capture");
{
  const refundRaw = JSON.stringify({
    type: "refund.created",
    data: { id: "mem_9", email: EMAIL, valid: true, status: "active" }
  });
  const refundStore = whopWorld();
  const refundRes = await deliverWhop(whopHandler, refundRaw, stdWebhookHeaders(refundRaw, "msg_refund"));
  t("refund webhook succeeds", refundRes.code === 200);
  t("refund does not capture activation", refundStore.captures.length === 0);

  const cancelRaw = JSON.stringify({
    type: "membership.deactivated",
    data: {
      id: "mem_9", email: EMAIL, valid: false, status: "canceled",
      renewal_period_end: Math.floor(Date.now() / 1000) + 10 * 86400
    }
  });
  const cancelStore = whopWorld();
  const cancelRes = await deliverWhop(whopHandler, cancelRaw, stdWebhookHeaders(cancelRaw, "msg_cancel"));
  t("cancel-in-period webhook succeeds", cancelRes.code === 200);
  t("cancel does not capture activation", cancelStore.captures.length === 0);

  const ignoreStore = whopWorld();
  const ignoreRaw = JSON.stringify({ type: "ping", data: {} });
  const ignoreRes = await deliverWhop(whopHandler, ignoreRaw, stdWebhookHeaders(ignoreRaw, "msg_ignore"));
  t("ignored event is 200", ignoreRes.code === 200 && ignoreRes.body.ignored === true);
  t("ignored event does not capture", ignoreStore.captures.length === 0);

  const badPay = paymongoWorld();
  const badRes = await deliverPaymongo(paymongoHandler, paymongoPaidEvent({ amount: 1, eventId: "evt_bad" }));
  t("wrong amount is 400", badRes.code === 400);
  t("bad payment does not capture", badPay.captures.length === 0);

  const refundPm = paymongoWorld();
  const refundPayload = {
    data: {
      id: "evt_refund",
      type: "event",
      attributes: {
        type: "payment.refunded",
        livemode: false,
        created_at: Math.floor(Date.now() / 1000),
        data: { id: "pay_1", type: "payment", attributes: { amount: 59700, status: "refunded" } }
      }
    }
  };
  const refundPmRes = await deliverPaymongo(paymongoHandler, refundPayload);
  t("PayMongo refund is 200", refundPmRes.code === 200);
  t("PayMongo refund does not capture activation", refundPm.captures.length === 0);
}

section("Registry + SQL");
{
  const registry = readFileSync("./js/analyticsRegistry.js", "utf8");
  t("registry still marks subscription_activated as milestone",
    /subscription_activated:\s*\{\s*kind:\s*"milestone"/.test(registry));
  t("registry allowlists conversion properties",
    /subscription_activated:[\s\S]*props:\s*\["source", "provider", "plan_id", "price_php"\]/.test(registry));
  const mig = readFileSync("./migrations/2026-08-28_paymongo_payment_event_type.sql", "utf8");
  t("PayMongo RPC returns event_type", /'event_type', v_event_type/.test(mig));
  t("PayMongo already-paid rows are renewed", /v_already_paid/.test(mig) && /'renewed'/.test(mig));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
