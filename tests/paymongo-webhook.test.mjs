import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import {
  computePaidUntil, extractPaidCheckout, extractPaymongoEvent,
  parsePaymongoEvent, recomputePaymongoPaidUntil, validatePaidCheckout,
  verifyPaymongoSignature
} from "../lib/server/paymongoWebhook.js";

const secret = "whsk_test_secret";
const now = Date.now();
const timestamp = Math.floor(now / 1000);
function signed(raw, at = timestamp) {
  const digest = crypto.createHmac("sha256", secret).update(`${at}.${raw}`).digest("hex");
  return `t=${at},te=${digest},li=`;
}
function event(overrides = {}) {
  return {
    data: {
      id: overrides.eventId || "evt_paid_1",
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        livemode: false,
        created_at: timestamp,
        data: {
          id: "cs_1", type: "checkout_session",
          attributes: {
            reference_number: "ATH-PM-1",
            metadata: {
              athlevo_user_id: overrides.userId === undefined ? "user-1" : overrides.userId,
              athlevo_product: overrides.product || "ATHLEVO_PRO_MONTHLY"
            },
            payments: [{ id: "pay_1", attributes: {
              amount: overrides.amount === undefined ? 59700 : overrides.amount,
              currency: overrides.currency || "PHP", status: "paid", paid_at: timestamp,
              source: { type: "qrph" }
            }}]
          }
        }
      }
    }
  };
}

const raw = JSON.stringify(event());
assert.deepEqual(verifyPaymongoSignature(raw, signed(raw), secret, now), { valid: true, mode: "test" });
assert.equal(verifyPaymongoSignature(raw, signed(raw).replace(/te=[^,]+/, "te=bad"), secret, now).valid, false);
assert.equal(verifyPaymongoSignature(raw, signed(raw, timestamp - 301), secret, now).valid, false);
assert.equal(verifyPaymongoSignature(raw, "", secret, now).valid, false);
const paid = extractPaidCheckout(extractPaymongoEvent(parsePaymongoEvent(raw), raw));
assert.equal(validatePaidCheckout(paid), null);
assert.equal(validatePaidCheckout(extractPaidCheckout(extractPaymongoEvent(event({ amount: 1 }), "a"))), "wrong_amount");
assert.equal(validatePaidCheckout(extractPaidCheckout(extractPaymongoEvent(event({ currency: "USD" }), "b"))), "wrong_currency");
assert.equal(validatePaidCheckout(extractPaidCheckout(extractPaymongoEvent(event({ product: "CHEAP" }), "c"))), "wrong_product");
assert.equal(validatePaidCheckout(extractPaidCheckout(extractPaymongoEvent(event({ userId: null }), "d"))), "missing_user");

assert.equal(computePaidUntil({
  nowMs: Date.parse("2026-09-10T00:00:00Z"),
  currentPeriodEnd: "2026-09-20T00:00:00Z", days: 30
}), "2026-10-20T00:00:00.000Z");
assert.equal(recomputePaymongoPaidUntil([
  { status: "refunded", paid_at: "2026-09-10T00:00:00Z", entitlement_days: 30 },
  { status: "paid", paid_at: "2026-09-11T00:00:00Z", entitlement_days: 30,
    metadata: { whop_period_end_at_payment: "2026-09-20T00:00:00Z" } }
]), "2026-10-20T00:00:00.000Z");

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
process.env.PAYMONGO_WEBHOOK_SECRET = secret;
process.env.PAYMONGO_SECRET_KEY = "sk_test_secret";
delete process.env.POSTHOG_KEY;
const { default: handler } = await import("../lib/server/paymongoWebhookEndpoint.js");
function response() {
  return { statusCode: 200, body: null, headers: {}, setHeader(k,v){this.headers[k]=v;}, status(c){this.statusCode=c;return this;}, json(v){this.body=v;return this;} };
}
async function deliver(payload, header) {
  const body = Buffer.from(JSON.stringify(payload));
  const res = response();
  await handler({ method: "POST", body, headers: { "paymongo-signature": header || signed(body.toString()) } }, res);
  return res;
}

let rpcCalls = 0;
let authLookupStatus = 200;
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = String(input);
  if (url.includes("payment_transactions?provider=eq.paymongo")) return new Response(JSON.stringify([{
    user_id: "user-1", amount_cents: 59700, currency: "PHP",
    product_id: "ATHLEVO_PRO_MONTHLY", entitlement_days: 30, status: "pending",
    metadata: { livemode: false }
  }]), { status: 200 });
  if (url.includes("/auth/v1/admin/users/user-1")) return new Response(
    authLookupStatus === 200 ? JSON.stringify({ id: "user-1" }) : "{}",
    { status: authLookupStatus }
  );
  if (url.endsWith("/rpc/apply_paymongo_payment")) {
    rpcCalls += 1;
    return new Response(JSON.stringify(rpcCalls === 1
      ? { applied: true, duplicate: false, paid_until: "2026-10-20T00:00:00Z" }
      : { applied: false, duplicate: true, paid_until: "2026-10-20T00:00:00Z" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
};
const first = await deliver(event());
const duplicate = await deliver(event());
assert.equal(first.statusCode, 200);
assert.equal(first.body.result.applied, true);
assert.equal(duplicate.statusCode, 200);
assert.equal(duplicate.body.result.duplicate, true);
assert.equal(rpcCalls, 2);
assert.equal((await deliver(event(), "t=1,te=bad,li=")).statusCode, 401);
assert.equal((await deliver(event({ amount: 1 }))).statusCode, 400);
assert.equal((await deliver(event({ userId: null }))).statusCode, 400);
authLookupStatus = 404;
assert.equal((await deliver(event({ eventId: "evt_missing_mapping" }))).statusCode, 400);
authLookupStatus = 503;
assert.equal((await deliver(event({ eventId: "evt_auth_retry" }))).statusCode, 500);
globalThis.fetch = originalFetch;

const migration = readFileSync("./migrations/2026-08-16_paymongo_entitlements.sql", "utf8");
const refundFn = migration.slice(migration.indexOf("create or replace function public.apply_paymongo_refund"));
assert.match(refundFn, /status = 'refunded'/);
assert.match(refundFn, /where provider = 'paymongo'[\s\S]*status = 'paid'/);
assert.doesNotMatch(refundFn, /set current_period_end\s*=/i);
assert.match(migration, /unique index[\s\S]*provider_payment_id/i);
assert.match(migration, /on conflict \(provider, provider_event_id\) do nothing/i);

console.log("PayMongo webhook: 29 assertions passed");
