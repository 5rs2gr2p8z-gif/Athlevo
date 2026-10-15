/*
 * Store sign-up (Athlevo Plan and Athlevo Coaching, public /store checkout): server behaviour.
 * Runs the real handlers against an in-memory Supabase and PayMongo, with a
 * correctly signed PayMongo webhook. Run: node tests/plan-signup.test.mjs
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
process.env.PAYMONGO_SECRET_KEY = "sk_test_secret";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test";
process.env.PAYMONGO_PAYMENT_METHODS = "qrph,grab_pay,maya";
const QUESTIONNAIRE = "https://forms.example.com/athlevo-questionnaire";
const SCHEDULE = "https://cal.example.com/athlevo-call";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (title) => console.log(`\n── ${title}`);

// ---- in-memory Supabase + PayMongo -----------------------------------------

const db = { plan_signups: [], rates: new Map() };
const log = { paymongo: [], tables: [], urls: [] };
const paymentAmounts = new Map(); // payment id -> amount PayMongo reports (default ₱1,998)
let paymongoDown = false;
let planTableMissing = false;
let nextId = 1;

function strip(v) { return String(v || "").replace(/^eq\./, ""); }

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.host === "api.paymongo.com") {
    if (url.pathname === "/v2/checkout_sessions" && method === "POST") {
      if (paymongoDown) return json({ errors: [{ detail: "boom sk_test_secret" }] }, 500);
      const attributes = JSON.parse(init.body).data.attributes;
      const id = `cs_${log.paymongo.length + 1}`;
      log.paymongo.push({ id, attributes });
      return json({ data: { id, attributes: { checkout_url: `https://checkout.paymongo.com/${id}`, livemode: false } } });
    }
    if (url.pathname.startsWith("/v1/payments/")) {
      const paymentId = url.pathname.split("/").pop();
      return json({ data: { attributes: { amount: paymentAmounts.get(paymentId) || 199800, refunds: [] } } });
    }
    return json({}, 404);
  }
  if (url.host !== "db.test") return json({}, 404);
  const table = url.pathname.replace("/rest/v1/", "");
  log.tables.push(`${method} ${table}`);
  const q = url.searchParams;
  const prefer = (init.headers && init.headers.Prefer) || "";
  if (table === "ai_anon_rate_limits") {
    const key = `${strip(q.get("client_key"))}|${strip(q.get("endpoint"))}|${strip(q.get("window_start"))}`;
    if (method === "GET") {
      const count = db.rates.get(key);
      return json(count ? [{ request_count: count }] : []);
    }
    const body = JSON.parse(init.body);
    db.rates.set(`${body.client_key}|${body.endpoint}|${body.window_start}`, body.request_count);
    return new Response("", { status: 201 });
  }
  if (table === "plan_signups") {
    if (planTableMissing) return json({ code: "PGRST205", message: "Could not find the table 'public.plan_signups'" }, 404);
    if (method === "POST") {
      const row = JSON.parse(init.body);
      const byRef = db.plan_signups.some(r => r.reference_number === row.reference_number);
      const byPay = db.plan_signups.some(r => r.provider_payment_id === row.provider_payment_id);
      if (byRef) return prefer.includes("ignore-duplicates") ? json([]) : json({ code: "23505" }, 409);
      if (byPay) return json({ code: "23505" }, 409);
      const stored = { id: `row_${nextId++}`, ...row };
      db.plan_signups.push(stored);
      return json([stored], 201);
    }
    let rows = db.plan_signups;
    log.urls.push(url.toString());
    if (q.get("product_id")) rows = rows.filter(r => r.product_id === strip(q.get("product_id")));
    if (q.get("reference_number")) rows = rows.filter(r => r.reference_number === strip(q.get("reference_number")));
    if (q.get("provider_payment_id")) rows = rows.filter(r => r.provider_payment_id === strip(q.get("provider_payment_id")));
    if (q.get("id")) rows = rows.filter(r => r.id === strip(q.get("id")));
    if (q.get("status")) rows = rows.filter(r => r.status === strip(q.get("status")));
    if (method === "PATCH") {
      rows.forEach(r => Object.assign(r, JSON.parse(init.body)));
      return new Response(null, { status: 204 });
    }
    return json(rows);
  }
  return json([]); // payment_transactions, subscriptions, etc.: nothing known
};

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; }
  };
}

const planMod = await import("../lib/server/planSignup.js");
const { default: webhook } = await import("../lib/server/paymongoWebhookEndpoint.js");
const {
  planSignupCheckoutHandler: checkout, planSignupStatusHandler: status, ATHLEVO_PLAN_PRODUCT,
  coachingSignupCheckoutHandler: coachingCheckout, coachingSignupStatusHandler: coachingStatus,
  ATHLEVO_COACHING_PRODUCT
} = planMod;
const COACHING_QUESTIONNAIRE = "https://forms.example.com/athlevo-coaching-questionnaire";
const COACHING_SCHEDULE = "https://cal.example.com/athlevo-coaching-call";

const env = (patch) => Object.keys(patch).forEach(k => {
  if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k];
});
const open = () => env({ PLAN_SIGNUP_ENABLED: "true", PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE, PLAN_SCHEDULE_URL: SCHEDULE });
const closed = () => env({ PLAN_SIGNUP_ENABLED: undefined, PLAN_QUESTIONNAIRE_URL: undefined, PLAN_SCHEDULE_URL: undefined });
const openCoaching = () => env({
  COACHING_SIGNUP_ENABLED: "true", COACHING_QUESTIONNAIRE_URL: COACHING_QUESTIONNAIRE, COACHING_SCHEDULE_URL: COACHING_SCHEDULE
});
const closedCoaching = () => env({
  COACHING_SIGNUP_ENABLED: undefined, COACHING_QUESTIONNAIRE_URL: undefined, COACHING_SCHEDULE_URL: undefined
});
const post = (body, ip = "203.0.113.5") => ({ method: "POST", headers: { "x-forwarded-for": ip }, body });

function paidEvent({ reference, productId = ATHLEVO_PLAN_PRODUCT.id, amount = 199800, livemode = false,
  paymentId = "pay_1", checkoutId = "cs_1", id = "evt_1", billing } = {}) {
  return { data: { id, type: "event", attributes: {
    type: "checkout_session.payment.paid", livemode, created_at: 1760000000,
    data: { id: checkoutId, type: "checkout_session", attributes: {
      reference_number: reference, metadata: { athlevo_product: productId },
      payments: [{ id: paymentId, type: "payment", attributes: {
        status: "paid", amount, currency: "PHP", paid_at: 1760000000, source: { type: "qrph" },
        billing: billing === undefined ? { name: "Maria Santos", email: "Maria@Example.com", phone: "+639171234567" } : billing
      } }]
    } }
  } } };
}
function refundEvent({ paymentId = "pay_1", amount = 199800, id = "evt_r1", type = "payment.refunded" } = {}) {
  return { data: { id, type: "event", attributes: {
    type, livemode: false, created_at: 1760000100,
    data: { id: paymentId, type: "payment", attributes: { amount, status: "succeeded" } }
  } } };
}
async function deliver(event, { live = false, secret = process.env.PAYMONGO_WEBHOOK_SECRET } = {}) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const r = res();
  await webhook({
    method: "POST", body: Buffer.from(body),
    headers: { "paymongo-signature": live ? `t=${ts},te=,li=${sig}` : `t=${ts},te=${sig},li=` }
  }, r);
  return r;
}

// ---- 1. closed by default ---------------------------------------------------
section("1. Closed by default");
closed();
{
  const before = log.paymongo.length;
  const r = res();
  await checkout(post({}), r);
  t("checkout is unavailable until PLAN_SIGNUP_ENABLED is set", r.statusCode === 503 && log.paymongo.length === before);
  const s = res();
  await status(post({ ref: "ATH-PL-AAAAAAAAAAA-" + "A".repeat(24) }), s);
  t("status still answers while sign-up is closed (buyers keep their confirmation)", s.statusCode === 200 && s.body.status === "pending");
  env({ SUPABASE_URL: undefined });
  const noDb = res();
  await status(post({ ref: "ATH-PL-AAAAAAAAAAA-" + "A".repeat(24) }), noDb);
  env({ SUPABASE_URL: "https://db.test" });
  t("status is unavailable only when the database is not configured", noDb.statusCode === 503);
}
env({ PLAN_SIGNUP_ENABLED: "true" });
{
  const r = res(); await checkout(post({}), r);
  t("enabled but no questionnaire link: still closed", r.statusCode === 503);
}
env({ PLAN_QUESTIONNAIRE_URL: "http://forms.example.com/insecure" });
{
  const r = res(); await checkout(post({}), r);
  t("a non-https questionnaire link keeps it closed", r.statusCode === 503);
}
env({ PLAN_QUESTIONNAIRE_URL: "javascript:alert(1)" });
{
  const r = res(); await checkout(post({}), r);
  t("a javascript: questionnaire link keeps it closed", r.statusCode === 503);
}
open();
env({ PAYMONGO_SECRET_KEY: undefined });
{
  const r = res(); await checkout(post({}), r);
  t("without a PayMongo key it is closed", r.statusCode === 503);
}
env({ PAYMONGO_SECRET_KEY: "sk_test_secret" });
{
  const r = res(); await checkout({ method: "GET", headers: {} }, r);
  t("checkout is POST-only", r.statusCode === 405 && r.headers.Allow === "POST");
}

// ---- 2. checkout ------------------------------------------------------------
section("2. Checkout session");
open();
let reference;
{
  const r = res();
  await checkout(post({ amount: 1, currency: "USD", product: "ATHLEVO_PRO_MONTHLY", success_url: "https://evil.example" }), r);
  t("returns only a checkout URL", r.statusCode === 200 && JSON.stringify(Object.keys(r.body)) === '["checkout_url"]' &&
    r.body.checkout_url === "https://checkout.paymongo.com/cs_1");
  const a = log.paymongo[0].attributes;
  reference = a.reference_number;
  t("amount is the server-owned ₱1,998 whatever the browser sends",
    a.line_items.length === 1 && a.line_items[0].amount === 199800 && a.line_items[0].currency === "PHP" && a.line_items[0].quantity === 1);
  t("the Plan price matches the price shown on the page",
    (() => {
      const sandbox = {}; sandbox.window = sandbox; sandbox.globalThis = sandbox;
      vm.runInNewContext(readFileSync("js/storeCatalog.js", "utf8"), sandbox);
      const shown = sandbox.AthlevoStoreCatalog.getProduct("athlevo-plan").page.price;
      return shown.amount === "₱" + (ATHLEVO_PLAN_PRODUCT.priceCents / 100).toLocaleString("en-US") && /month/i.test(shown.period);
    })());
  t("offers the same methods as Athlevo Pro (QRPh, GrabPay, Maya); GCash is not offered",
    JSON.stringify(a.payment_method_types) === '["qrph","grab_pay","paymaya"]');
  t("reference number has the Plan format", /^ATH-PL-[0-9A-F]{8,16}-[0-9A-F]{24}$/.test(reference), reference);
  t("tagged as the Plan product, with no Athlevo user",
    a.metadata.athlevo_product === "ATHLEVO_PLAN_MONTHLY" && !("athlevo_user_id" in a.metadata));
  t("returns to the Plan page with the reference, or back on cancel",
    a.success_url === `https://athlevo.org/store/athlevo-plan?payment=success&ref=${encodeURIComponent(reference)}` &&
    a.cancel_url === "https://athlevo.org/store/athlevo-plan?payment=cancelled");
  t("no secret or key reaches the browser", !JSON.stringify(r.body).includes("sk_test"));
  t("asks PayMongo to email a receipt", a.send_email_receipt === true);
}
env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app" });
{
  const r = res(); await checkout(post({}, "203.0.113.6"), r);
  const a = log.paymongo[log.paymongo.length - 1].attributes;
  t("a Vercel preview returns to itself, so a test payment never lands on the live site",
    a.success_url.startsWith("https://athlevo-git-store-x.vercel.app/store/athlevo-plan?payment=success"));
}
env({ VERCEL_ENV: undefined, VERCEL_URL: undefined });
paymongoDown = true;
{
  const r = res(); await checkout(post({}, "203.0.113.7"), r);
  t("a PayMongo failure is a generic 502 that leaks nothing",
    r.statusCode === 502 && !JSON.stringify(r.body).includes("sk_test") && !JSON.stringify(r.body).includes("boom"));
}
paymongoDown = false;
{
  let last;
  for (let i = 0; i < 12; i++) { last = res(); await checkout(post({}, "198.51.100.9"), last); }
  t("checkout creation is rate limited per visitor", last.statusCode === 429 && last.body.code === "RATE_LIMITED");
}

// ---- 3. status before payment ----------------------------------------------
section("3. Status");
{
  const bad = res(); await status(post({ ref: "nonsense" }), bad);
  t("a malformed reference is rejected", bad.statusCode === 400);
  const none = res(); await status(post({}), none);
  t("a missing reference is rejected", none.statusCode === 400);
  const unknown = res(); await status(post({ ref: reference }), unknown);
  t("before the webhook arrives it reports pending, with no links",
    unknown.statusCode === 200 && unknown.body.status === "pending" && !("questionnaire_url" in unknown.body));
  const wrongMethod = res(); await status({ method: "GET", headers: {} }, wrongMethod);
  t("status is POST-only (the reference never goes in a URL)", wrongMethod.statusCode === 405);
}

// ---- 4. webhook -------------------------------------------------------------
section("4. Webhook records the payment");
log.tables.length = 0;
{
  const forged = res();
  const body = JSON.stringify(paidEvent({ reference }));
  await webhook({ method: "POST", body: Buffer.from(body), headers: { "paymongo-signature": `t=${Math.floor(Date.now() / 1000)},te=deadbeef,li=` } }, forged);
  t("an unsigned or wrongly signed event is rejected and writes nothing", forged.statusCode === 401 && db.plan_signups.length === 0);

  const r = await deliver(paidEvent({ reference }));
  t("a signed payment is accepted", r.statusCode === 200 && r.body.result.applied === true, JSON.stringify(r.body));
  const row = db.plan_signups[0];
  t("one sign-up row exists with the verified amount and ids",
    db.plan_signups.length === 1 && row.reference_number === reference && row.amount_cents === 199800 &&
    row.currency === "PHP" && row.provider_payment_id === "pay_1" && row.provider_checkout_id === "cs_1" && row.status === "paid");
  t("contact details come from PayMongo, email normalised",
    row.customer_name === "Maria Santos" && row.customer_email === "maria@example.com" && row.customer_phone === "+639171234567");
  t("test-mode payments are marked livemode=false", row.livemode === false);
  t("paid_through is 30 days after payment",
    Date.parse(row.paid_through) - Date.parse(row.paid_at) === 30 * 86400000);
  t("a Plan payment touches no app subscription or Pro ledger",
    !log.tables.some(x => /subscriptions|payment_transactions|subscription_events/.test(x)), log.tables.join(","));

  const dup = await deliver(paidEvent({ reference }));
  t("the same delivery twice records it once", dup.statusCode === 200 && dup.body.result.duplicate === true && db.plan_signups.length === 1);
  const retriedNewEvent = await deliver(paidEvent({ reference, id: "evt_other" }));
  t("a retried event with a new event id is also recorded once", retriedNewEvent.statusCode === 200 && db.plan_signups.length === 1);
}

section("5. Status after payment");
{
  const r = res(); await status(post({ ref: reference }), r);
  t("paid: returns the questionnaire and scheduling links, and no personal data",
    r.statusCode === 200 && r.body.status === "paid" && r.body.questionnaire_url === QUESTIONNAIRE &&
    r.body.schedule_url === SCHEDULE && !JSON.stringify(r.body).match(/maria|santos|@|\+63/i));
  t("lower-case reference still resolves", (await (async () => { const x = res(); await status(post({ ref: reference.toLowerCase() }), x); return x.body.status; })()) === "paid");
  env({ PLAN_SCHEDULE_URL: undefined });
  const noSchedule = res(); await status(post({ ref: reference }), noSchedule);
  t("without a scheduling link the field is null, not missing or invented", noSchedule.body.schedule_url === null);
  env({ PLAN_SCHEDULE_URL: "ftp://bad.example.com" });
  const badSchedule = res(); await status(post({ ref: reference }), badSchedule);
  t("a non-https scheduling link is dropped", badSchedule.body.schedule_url === null);
  open();
}

section("6. Rejected payments");
{
  const before = db.plan_signups.length;
  const cheap = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "B".repeat(24), amount: 59700, paymentId: "pay_2", id: "evt_2" }));
  t("the wrong amount is rejected with 400 and not recorded", cheap.statusCode === 400 && db.plan_signups.length === before);
  const badRef = await deliver(paidEvent({ reference: "ATH-PM-NOT-A-PLAN-REFERENCE", paymentId: "pay_3", id: "evt_3" }));
  t("a reference that is not a Plan reference is rejected", badRef.statusCode === 400 && db.plan_signups.length === before);
  const mismatch = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "C".repeat(24), livemode: true, paymentId: "pay_4", id: "evt_4" }));
  t("a live event signed with the test key is rejected", mismatch.statusCode === 401 && db.plan_signups.length === before);
}
{
  const liveRef = "ATH-PL-1234567890A-" + "D".repeat(24);
  const r = await deliver(paidEvent({ reference: liveRef, livemode: true, paymentId: "pay_live", checkoutId: "cs_live", id: "evt_live", billing: null }), { live: true });
  const row = db.plan_signups.find(x => x.reference_number === liveRef);
  t("a live payment is stored as livemode=true, tolerating missing contact details",
    r.statusCode === 200 && row && row.livemode === true && row.customer_email === null && row.customer_name === null);
}

section("7. Athlevo Pro is unaffected");
{
  const before = db.plan_signups.length;
  const proEvent = paidEvent({ reference: "ATH-PM-1-ABCDEF", productId: "ATHLEVO_PRO_MONTHLY", amount: 59700, paymentId: "pay_pro", checkoutId: "cs_pro", id: "evt_pro" });
  proEvent.data.attributes.data.attributes.metadata.athlevo_user_id = "user-1";
  const r = await deliver(proEvent);
  t("a Pro payment still goes down the Pro path (unknown checkout → 400) and writes no Plan row",
    r.statusCode === 400 && db.plan_signups.length === before);
  const proRefundOpen = await deliver(refundEvent({ paymentId: "pay_pro_1", id: "evt_pr2" }));
  t("a Pro refund falls through to the Pro path (unknown to the Plan table)",
    proRefundOpen.statusCode === 200 && proRefundOpen.body.result.reason === "unknown_payment");

  closed();
  const inFlight = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "E".repeat(24), paymentId: "pay_5", id: "evt_5" }));
  t("closing sign-up never loses a payment already in flight: it is still recorded",
    inFlight.statusCode === 200 && db.plan_signups.length === before + 1 && db.plan_signups.some(x => x.provider_payment_id === "pay_5"));
  const stillRefunds = await deliver(refundEvent({ paymentId: "pay_5", id: "evt_5r" }));
  t("and its refund is still applied while closed",
    stillRefunds.statusCode === 200 && stillRefunds.body.result.applied === true &&
    db.plan_signups.find(x => x.provider_payment_id === "pay_5").status === "refunded");
  const inFlightStatus = res();
  await status(post({ ref: "ATH-PL-1234567890A-" + "E".repeat(24) }), inFlightStatus);
  t("a buyer can still open their confirmation after sign-up is closed", inFlightStatus.statusCode === 200 && inFlightStatus.body.status === "refunded");
  open();

  planTableMissing = true;
  const preMigrationRefund = await deliver(refundEvent({ paymentId: "pay_pro_1", id: "evt_pr3" }));
  t("before the migration is run, a Pro refund is unaffected by the missing Plan table",
    preMigrationRefund.statusCode === 200 && preMigrationRefund.body.result.reason === "unknown_payment");
  const preMigrationPay = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "F".repeat(24), paymentId: "pay_6", id: "evt_6" }));
  t("a Plan payment with no table fails loudly (500) so PayMongo retries instead of dropping it", preMigrationPay.statusCode === 500);
  planTableMissing = false;
}

section("8. Refunds");
{
  const full = await deliver(refundEvent({ paymentId: "pay_1" }));
  const row = db.plan_signups.find(x => x.provider_payment_id === "pay_1");
  t("a full refund marks the sign-up refunded", full.statusCode === 200 && full.body.result.applied === true && row.status === "refunded" && !!row.refunded_at, JSON.stringify(full.body));
  const again = await deliver(refundEvent({ paymentId: "pay_1", id: "evt_r2" }));
  t("a repeated refund event is a no-op", again.statusCode === 200 && again.body.result.duplicate === true);
  const s = res(); await status(post({ ref: reference }), s);
  t("a refunded sign-up no longer returns the next-step links", s.body.status === "refunded" && !("questionnaire_url" in s.body));
  const partial = await deliver(refundEvent({ paymentId: "pay_live", amount: 50000, id: "evt_r3", type: "payment.refund.updated" }));
  t("a partial refund is ignored", partial.statusCode === 200 && partial.body.result.ignored === true &&
    db.plan_signups.find(x => x.provider_payment_id === "pay_live").status === "paid", JSON.stringify(partial.body));
}

section("9. Athlevo Coaching (₱4,998)");
{
  const CO_REF = (c) => "ATH-CO-1234567890A-" + c.repeat(24);
  const coachingPaid = (o = {}) => paidEvent({ productId: ATHLEVO_COACHING_PRODUCT.id, amount: 499800, ...o });

  // closed by default, and each switch only opens its own offer
  closed(); closedCoaching();
  {
    const before = log.paymongo.length;
    const r = res(); await coachingCheckout(post({}, "203.0.113.20"), r);
    t("Coaching checkout is unavailable until COACHING_SIGNUP_ENABLED is set",
      r.statusCode === 503 && log.paymongo.length === before);
    const s1 = res(); await coachingStatus(post({ ref: CO_REF("A") }, "203.0.113.20"), s1);
    t("Coaching status still answers while closed (buyers keep their confirmation)", s1.statusCode === 200 && s1.body.status === "pending");
  }
  open();
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.21"), r);
    t("opening the Plan does not open Coaching", r.statusCode === 503);
  }
  closed(); openCoaching();
  {
    const r = res(); await checkout(post({}, "203.0.113.22"), r);
    t("opening Coaching does not open the Plan", r.statusCode === 503);
  }
  env({ COACHING_QUESTIONNAIRE_URL: undefined, COACHING_SCHEDULE_URL: undefined });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.23"), r);
    t("enabled with no questionnaire link anywhere: still closed", r.statusCode === 503);
  }
  env({ PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.24"), r);
    t("with no Coaching link it uses the Plan's questionnaire (same questionnaire)", r.statusCode === 200);
    const paidRef = log.paymongo[log.paymongo.length - 1].attributes.reference_number;
    db.plan_signups.push({ id: "row_fb", reference_number: paidRef, product_id: ATHLEVO_COACHING_PRODUCT.id, status: "paid" });
    const s2 = res(); await coachingStatus(post({ ref: paidRef }, "203.0.113.24"), s2);
    t("and shows that questionnaire after payment, with no schedule link when none is set",
      s2.body.status === "paid" && s2.body.questionnaire_url === QUESTIONNAIRE && s2.body.schedule_url === null);
    db.plan_signups.pop();
  }
  env({ COACHING_QUESTIONNAIRE_URL: "http://forms.example.com/insecure" });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.25"), r);
    t("a non-https Coaching link keeps it closed and does not fall back to the Plan's", r.statusCode === 503);
  }
  closed(); openCoaching();
  env({ COACHING_QUESTIONNAIRE_URL: "   ", PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.26"), r);
    t("a blank Coaching link counts as not set and uses the Plan's", r.statusCode === 200);
  }
  closed(); openCoaching();
  {
    const r = res(); await coachingCheckout({ method: "GET", headers: {} }, r);
    t("Coaching checkout is POST-only", r.statusCode === 405 && r.headers.Allow === "POST");
  }

  // the checkout
  let coRef;
  {
    const r = res();
    await coachingCheckout(post({ amount: 1, currency: "USD", product: "ATHLEVO_PLAN_MONTHLY", success_url: "https://evil.example" }, "203.0.113.30"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    coRef = a.reference_number;
    t("returns only a checkout URL", r.statusCode === 200 && JSON.stringify(Object.keys(r.body)) === '["checkout_url"]');
    t("amount is the server-owned ₱4,998 whatever the browser sends",
      a.line_items.length === 1 && a.line_items[0].amount === 499800 && a.line_items[0].currency === "PHP" &&
      a.line_items[0].quantity === 1 && a.line_items[0].name === "Athlevo Coaching");
    t("the Coaching price matches the price shown on the page",
      (() => {
        const sandbox = {}; sandbox.window = sandbox; sandbox.globalThis = sandbox;
        vm.runInNewContext(readFileSync("js/storeCatalog.js", "utf8"), sandbox);
        const shown = sandbox.AthlevoStoreCatalog.getProduct("athlevo-coaching").page.price;
        return shown.amount === "₱" + (ATHLEVO_COACHING_PRODUCT.priceCents / 100).toLocaleString("en-US") && /month/i.test(shown.period);
      })());
    t("same payment methods as the Plan; GCash is not offered",
      JSON.stringify(a.payment_method_types) === '["qrph","grab_pay","paymaya"]');
    t("reference number has the Coaching format, never the Plan's", /^ATH-CO-[0-9A-F]{8,16}-[0-9A-F]{24}$/.test(coRef), coRef);
    t("tagged as the Coaching product, with no Athlevo user",
      a.metadata.athlevo_product === "ATHLEVO_COACHING_MONTHLY" && !("athlevo_user_id" in a.metadata));
    t("returns to the Coaching page with the reference, or back on cancel",
      a.success_url === `https://athlevo.org/store/athlevo-coaching?payment=success&ref=${encodeURIComponent(coRef)}` &&
      a.cancel_url === "https://athlevo.org/store/athlevo-coaching?payment=cancelled");
  }
  env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app" });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.31"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    t("a Vercel preview returns to itself", a.success_url.startsWith("https://athlevo-git-store-x.vercel.app/store/athlevo-coaching?payment=success"));
  }
  env({ VERCEL_ENV: undefined, VERCEL_URL: undefined });
  {
    let last;
    for (let i = 0; i < 12; i++) { last = res(); await checkout(post({}, "198.51.100.77"), last); }
    open();
    for (let i = 0; i < 12; i++) { last = res(); await checkout(post({}, "198.51.100.77"), last); }
    t("the Plan's rate limit is used up for this visitor", last.statusCode === 429);
    const co = res(); await coachingCheckout(post({}, "198.51.100.77"), co);
    t("Coaching is rate limited separately from the Plan", co.statusCode === 200);
    let coLast;
    for (let i = 0; i < 12; i++) { coLast = res(); await coachingCheckout(post({}, "198.51.100.78"), coLast); }
    t("Coaching checkout creation is rate limited per visitor", coLast.statusCode === 429 && coLast.body.code === "RATE_LIMITED");
    closed();
  }

  // status before payment, and the offers cannot read each other
  {
    const bad = res(); await coachingStatus(post({ ref: "nonsense" }), bad);
    t("a malformed reference is rejected", bad.statusCode === 400);
    const planRef = res(); await coachingStatus(post({ ref: reference }), planRef);
    t("a Plan reference is rejected by the Coaching status endpoint", planRef.statusCode === 400);
    const coOnPlan = res(); await status(post({ ref: coRef }), coOnPlan);
    t("a Coaching reference is rejected by the Plan status endpoint", coOnPlan.statusCode === 400);
    const pending = res(); await coachingStatus(post({ ref: coRef }), pending);
    t("before the webhook arrives it reports pending, with no links",
      pending.statusCode === 200 && pending.body.status === "pending" && !("questionnaire_url" in pending.body));
  }

  // recording is tied to the product the payment was made for
  {
    const details = {
      referenceNumber: CO_REF("G"), checkoutId: "cs_mm", paymentId: "pay_mm", amountCents: 499800, currency: "PHP",
      productId: "ATHLEVO_COACHING_MONTHLY", paidAt: new Date().toISOString(), contact: {}, eventId: "evt_mm"
    };
    const before = db.plan_signups.length;
    let threw = false;
    try { await planMod.applyPlanPayment("https://db.test", "service-secret", details, "test"); } catch (error) { threw = true; }
    t("recording a Coaching payment as the Plan product (the default) is refused outright",
      threw && db.plan_signups.length === before);
    const ok = await planMod.applyPlanPayment("https://db.test", "service-secret", details, "test", ATHLEVO_COACHING_PRODUCT);
    t("the same payment is recorded when the matching product is given",
      ok.applied === true && db.plan_signups[db.plan_signups.length - 1].product_id === "ATHLEVO_COACHING_MONTHLY");
    db.plan_signups.pop();
  }

  // webhook
  log.tables.length = 0;
  {
    const r = await deliver(coachingPaid({ reference: coRef, paymentId: "pay_co1", checkoutId: "cs_co1", id: "evt_co1" }));
    const row = db.plan_signups.find(x => x.reference_number === coRef);
    t("a signed Coaching payment is accepted", r.statusCode === 200 && r.body.result.applied === true, JSON.stringify(r.body));
    t("the row carries the Coaching product and the verified ₱4,998",
      row && row.product_id === "ATHLEVO_COACHING_MONTHLY" && row.amount_cents === 499800 && row.currency === "PHP" &&
      row.provider_payment_id === "pay_co1" && row.status === "paid" && row.livemode === false);
    t("contact details come from PayMongo, email normalised",
      row.customer_name === "Maria Santos" && row.customer_email === "maria@example.com");
    t("paid_through is 30 days after payment", Date.parse(row.paid_through) - Date.parse(row.paid_at) === 30 * 86400000);
    t("a Coaching payment touches no app subscription or Pro ledger",
      !log.tables.some(x => /subscriptions|payment_transactions|subscription_events/.test(x)), log.tables.join(","));
    const dup = await deliver(coachingPaid({ reference: coRef, paymentId: "pay_co1", checkoutId: "cs_co1", id: "evt_co1b" }));
    t("the same payment delivered twice is recorded once",
      dup.statusCode === 200 && dup.body.result.duplicate === true && db.plan_signups.filter(x => x.reference_number === coRef).length === 1);
  }

  // status after payment
  openCoaching();
  {
    const r = res(); await coachingStatus(post({ ref: coRef }), r);
    t("paid: returns the Coaching questionnaire and scheduling links, and no personal data",
      r.statusCode === 200 && r.body.status === "paid" && r.body.questionnaire_url === COACHING_QUESTIONNAIRE &&
      r.body.schedule_url === COACHING_SCHEDULE && !JSON.stringify(r.body).match(/maria|santos|@|\+63/i));
    open();
    const planRow = "ATH-PL-1234567890A-" + "7".repeat(24);
    db.plan_signups.push({ id: "row_pl7", reference_number: planRow, product_id: "ATHLEVO_PLAN_MONTHLY", status: "paid" });
    const planStatus = res(); await status(post({ ref: planRow }), planStatus);
    t("with both open, each offer shows its own next-step links",
      planStatus.body.questionnaire_url === QUESTIONNAIRE && planStatus.body.schedule_url === SCHEDULE &&
      r.body.questionnaire_url === COACHING_QUESTIONNAIRE && r.body.schedule_url === COACHING_SCHEDULE);
    db.plan_signups.pop();
    const urls = log.urls.filter(u => u.includes(encodeURIComponent(coRef))).slice(-1)[0] || "";
    t("the status lookup is scoped to the Coaching product", urls.includes("product_id=eq.ATHLEVO_COACHING_MONTHLY"), urls);
    const odd = CO_REF("9");
    db.plan_signups.push({ id: "row_odd", reference_number: odd, product_id: "ATHLEVO_PLAN_MONTHLY", status: "paid" });
    const oddStatus = res(); await coachingStatus(post({ ref: odd }), oddStatus);
    t("a row for another product is never shown as a Coaching sign-up", oddStatus.body.status === "pending");
    db.plan_signups.pop();
  }

  // rejected payments
  {
    const before = db.plan_signups.length;
    const planPrice = await deliver(coachingPaid({ reference: CO_REF("B"), amount: 199800, paymentId: "pay_co2", id: "evt_co2" }));
    t("the Plan's price on a Coaching payment is rejected and not recorded", planPrice.statusCode === 400 && db.plan_signups.length === before);
    const coachingPriceOnPlan = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "B".repeat(24), amount: 499800, paymentId: "pay_co3", id: "evt_co3" }));
    t("the Coaching price on a Plan payment is rejected too", coachingPriceOnPlan.statusCode === 400 && db.plan_signups.length === before);
    const planRefOnCoaching = await deliver(coachingPaid({ reference: "ATH-PL-1234567890A-" + "C".repeat(24), paymentId: "pay_co4", id: "evt_co4" }));
    t("a Plan reference on a Coaching payment is rejected", planRefOnCoaching.statusCode === 400 && db.plan_signups.length === before);
    const coRefOnPlan = await deliver(paidEvent({ reference: CO_REF("D"), paymentId: "pay_co5", id: "evt_co5" }));
    t("a Coaching reference on a Plan payment is rejected", coRefOnPlan.statusCode === 400 && db.plan_signups.length === before);
    const junk = await deliver(coachingPaid({ reference: "ATH-CO-NOT-A-REFERENCE", paymentId: "pay_co6", id: "evt_co6" }));
    t("a malformed Coaching reference is rejected", junk.statusCode === 400 && db.plan_signups.length === before);
    const unknownProduct = await deliver(paidEvent({ reference: CO_REF("E"), productId: "ATHLEVO_ELITE_MONTHLY", amount: 799800, paymentId: "pay_co7", id: "evt_co7" }));
    t("an unknown store product is never recorded as a sign-up",
      db.plan_signups.length === before && !db.plan_signups.some(x => x.product_id === "ATHLEVO_ELITE_MONTHLY"));
    t("(and falls to the Pro path, which rejects it)", unknownProduct.statusCode === 400);
  }

  // closing it never loses a payment in flight
  closed(); closedCoaching();
  {
    const ref = CO_REF("F");
    const before = db.plan_signups.length;
    const inFlight = await deliver(coachingPaid({ reference: ref, paymentId: "pay_co8", checkoutId: "cs_co8", id: "evt_co8" }));
    t("closing Coaching sign-up never loses a payment already in flight",
      inFlight.statusCode === 200 && db.plan_signups.length === before + 1);
    const s3 = res(); await coachingStatus(post({ ref }), s3);
    t("and the buyer can still open their confirmation", s3.statusCode === 200 && s3.body.status === "paid");
    const refunded = await deliver(refundEvent({ paymentId: "pay_co8", amount: 499800, id: "evt_co8r" }));
    t("its refund is still applied while closed",
      refunded.statusCode === 200 && refunded.body.result.applied === true &&
      db.plan_signups.find(x => x.provider_payment_id === "pay_co8").status === "refunded");
    const s4 = res(); await coachingStatus(post({ ref }), s4);
    t("a refunded Coaching sign-up no longer returns the next-step links", s4.body.status === "refunded" && !("questionnaire_url" in s4.body));
  }

  // partial refunds are ignored against the Coaching amount
  {
    paymentAmounts.set("pay_co1", 499800);
    const partial = await deliver(refundEvent({ paymentId: "pay_co1", amount: 100000, id: "evt_co1p", type: "payment.refund.updated" }));
    t("a partial refund on a Coaching payment is ignored",
      partial.statusCode === 200 && partial.body.result.ignored === true &&
      db.plan_signups.find(x => x.provider_payment_id === "pay_co1").status === "paid", JSON.stringify(partial.body));
    const full = await deliver(refundEvent({ paymentId: "pay_co1", amount: 499800, id: "evt_co1f" }));
    t("a full refund marks it refunded",
      full.statusCode === 200 && full.body.result.applied === true &&
      db.plan_signups.find(x => x.provider_payment_id === "pay_co1").status === "refunded", JSON.stringify(full.body));
  }
  open();
}

section("10. Wiring");
{
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  const rewrite = (src) => (vercel.rewrites.find(r => r.source === src) || {}).destination;
  t("public API paths rewrite to the existing gateway (no new serverless function)",
    rewrite("/api/plan-signup/checkout") === "/api/providers?action=plan_signup_checkout" &&
    rewrite("/api/plan-signup/status") === "/api/providers?action=plan_signup_status" &&
    rewrite("/api/coaching-signup/checkout") === "/api/providers?action=coaching_signup_checkout" &&
    rewrite("/api/coaching-signup/status") === "/api/providers?action=coaching_signup_status");
  const router = readFileSync("api/providers/index.js", "utf8");
  t("the gateway dispatches both actions",
    /action === "plan_signup_checkout"/.test(router) && /action === "plan_signup_status"/.test(router) &&
    /action === "coaching_signup_checkout"/.test(router) && /action === "coaching_signup_status"/.test(router));
  const pairs = [
    ["plan_signup_checkout", "planSignupCheckoutHandler"], ["plan_signup_status", "planSignupStatusHandler"],
    ["coaching_signup_checkout", "coachingSignupCheckoutHandler"], ["coaching_signup_status", "coachingSignupStatusHandler"]
  ];
  t("each gateway action calls its own offer's handler (no copy-paste crossover)",
    pairs.every(([action, fn]) => new RegExp(`action === "${action}"\\) \\{\\s*return ${fn}\\(request, response\\);`).test(router)));
  const limits = readFileSync("lib/server/rateLimit.js", "utf8");
  t("each offer has its own rate-limit scopes",
    ["plan-signup", "plan-signup-status", "coaching-signup", "coaching-signup-status"].every(k => limits.includes(`"${k}": {`)));
  const sql = readFileSync("migrations/2026-10-15_plan_signups.sql", "utf8");
  t("migration enables RLS and defines no policy (service role only)",
    /enable row level security/i.test(sql) && !/create policy/i.test(sql));
  t("migration is re-runnable", !/drop table/i.test(sql) && /create table if not exists public\.plan_signups/i.test(sql));
  t("unique constraints back the idempotent insert",
    /reference_number text not null unique/.test(sql) && /provider_payment_id text not null unique/.test(sql));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
