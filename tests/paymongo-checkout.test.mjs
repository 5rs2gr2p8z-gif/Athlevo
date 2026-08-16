import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
process.env.PAYMONGO_SECRET_KEY = "sk_test_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "qrph,grab_pay,maya";

const { default: handler } = await import("../lib/server/paymongoCheckoutEndpoint.js");

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

const unauthorized = response();
await handler({ method: "POST", headers: {}, body: { amount: 1 } }, unauthorized);
assert.equal(unauthorized.statusCode, 401);

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
  if (url.includes("subscription_plans")) return new Response(JSON.stringify([{
    id: "performance", currency: "PHP", monthly_price_cents: 59700, is_active: true
  }]), { status: 200 });
  if (url.endsWith("/v2/checkout_sessions")) return new Response(JSON.stringify({ data: {
    id: "cs_test", attributes: { checkout_url: "https://checkout.paymongo.com/test", livemode: false }
  }}), { status: 200 });
  if (url.endsWith("/payment_transactions")) return new Response("", { status: 201 });
  return new Response("{}", { status: 404 });
};

const success = response();
await handler({
  method: "POST", headers: { authorization: "Bearer athlete-token" },
  body: { amount: 1, currency: "USD", user_id: "attacker", entitlement_days: 999 }
}, success);
globalThis.fetch = originalFetch;

assert.equal(success.statusCode, 200);
assert.deepEqual(success.body, { checkout_url: "https://checkout.paymongo.com/test" });
const paymongoCall = calls.find(call => call.url.endsWith("/v2/checkout_sessions"));
const checkout = JSON.parse(paymongoCall.init.body).data.attributes;
assert.equal(checkout.line_items[0].amount, 59700);
assert.equal(checkout.line_items[0].currency, "PHP");
assert.equal(checkout.line_items[0].quantity, 1);
assert.deepEqual(checkout.payment_method_types, ["qrph", "grab_pay", "paymaya"]);
assert.equal(checkout.metadata.athlevo_user_id, "user-1");
assert.equal(checkout.metadata.athlevo_product, "ATHLEVO_PRO_MONTHLY");
assert.match(checkout.success_url, /^https:\/\/athlevo\.org\/\?paymongo_return=success/);
const pendingCall = calls.find(call => call.url.endsWith("/payment_transactions"));
const pending = JSON.parse(pendingCall.init.body);
assert.equal(pending.user_id, "user-1");
assert.equal(pending.amount_cents, 59700);
assert.equal(pending.entitlement_days, 30);
assert.equal(pending.status, "pending");
assert.ok(!JSON.stringify(success.body).includes("sk_test_secret"));

console.log("PayMongo checkout: 17 assertions passed");
