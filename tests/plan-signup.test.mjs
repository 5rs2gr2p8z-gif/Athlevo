/*
 * Store sign-up (Athlevo Plan and Athlevo Coaching, public /programs checkout): server behaviour.
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

const db = { plan_signups: [], partner_codes: [], rates: new Map() };
const log = { paymongo: [], tables: [], urls: [], emails: [] };
let resendMode = "ok"; // "ok" | "reject" | "throw" | "hang"
const paymentAmounts = new Map(); // payment id -> amount PayMongo reports (default ₱1,998)
let paymongoDown = false;
let planTableMissing = false;
let partnerTableMissing = false;
let extraColumnsMissing = false; // the partner-codes migration was not run on plan_signups
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
  if (url.host === "api.resend.com") {
    log.emails.push({ headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
    if (resendMode === "throw") throw new TypeError("network down");
    if (resendMode === "reject") return json({ message: "rejected" }, 500);
    if (resendMode === "hang") {
      return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return json({ id: `em_${log.emails.length}` });
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
  if (table === "partner_codes") {
    if (partnerTableMissing) return json({ code: "PGRST205", message: "Could not find the table 'public.partner_codes'" }, 404);
    const wanted = strip(q.get("code"));
    return json(db.partner_codes.filter(r => !wanted || r.code === wanted));
  }
  if (table === "plan_signups") {
    if (planTableMissing) return json({ code: "PGRST205", message: "Could not find the table 'public.plan_signups'" }, 404);
    if (method === "POST") {
      const row = JSON.parse(init.body);
      if (extraColumnsMissing && "partner_code" in row) return json({ code: "PGRST204", message: "Could not find the 'partner_code' column" }, 400);
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
    if (q.get("partner_code")) rows = rows.filter(r => r.partner_code === strip(q.get("partner_code")));
    if (q.get("order") === "paid_at.asc") rows = [...rows].sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
    if (q.get("limit")) rows = rows.slice(0, Number(q.get("limit")));
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
  paymentId = "pay_1", checkoutId = "cs_1", id = "evt_1", billing, partnerCode, discountPercent, paidAt = 1760000000 } = {}) {
  return { data: { id, type: "event", attributes: {
    type: "checkout_session.payment.paid", livemode, created_at: 1760000000,
    data: { id: checkoutId, type: "checkout_session", attributes: {
      reference_number: reference, metadata: {
        athlevo_product: productId,
        ...(partnerCode !== undefined ? { partner_code: partnerCode } : {}),
        ...(discountPercent !== undefined ? { discount_percent: String(discountPercent) } : {})
      },
      payments: [{ id: paymentId, type: "payment", attributes: {
        status: "paid", amount, currency: "PHP", paid_at: paidAt, source: { type: "qrph" },
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
    a.success_url === `https://athlevo.org/programs/athlevo-plan?payment=success&ref=${encodeURIComponent(reference)}` &&
    a.cancel_url === "https://athlevo.org/programs/athlevo-plan?payment=cancelled");
  t("no secret or key reaches the browser", !JSON.stringify(r.body).includes("sk_test"));
  t("asks PayMongo to email a receipt", a.send_email_receipt === true);
}
env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app" });
{
  const r = res(); await checkout(post({}, "203.0.113.6"), r);
  const a = log.paymongo[log.paymongo.length - 1].attributes;
  t("a Vercel preview returns to itself, so a test payment never lands on the live site",
    a.success_url.startsWith("https://athlevo-git-store-x.vercel.app/programs/athlevo-plan?payment=success"));
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
      a.success_url === `https://athlevo.org/programs/athlevo-coaching?payment=success&ref=${encodeURIComponent(coRef)}` &&
      a.cancel_url === "https://athlevo.org/programs/athlevo-coaching?payment=cancelled");
  }
  env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app" });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.31"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    t("a Vercel preview returns to itself", a.success_url.startsWith("https://athlevo-git-store-x.vercel.app/programs/athlevo-coaching?payment=success"));
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

// ---- 11. emails -------------------------------------------------------------
section("11. Sign-up emails (buyer next steps + owner alert)");
{
  const { alertRecipients, buyerConfirmationEmail } = await import("../lib/server/signupNotifications.js");
  const planRef = (c) => "ATH-PL-FEEDFACE01-" + c.repeat(24);
  const coRef = (c) => "ATH-CO-FEEDFACE01-" + c.repeat(24);
  const MAIL_ENV = {
    RESEND_API_KEY: "re_test_key", SIGNUP_ALERT_EMAIL: "dean@athlevo.example, ops@athlevo.example",
    SIGNUP_FROM_EMAIL: undefined, ATHLEVO_INVITE_FROM_EMAIL: undefined, SIGNUP_REPLY_TO_EMAIL: undefined,
    PLAN_AGREEMENT_URL: undefined, COACHING_AGREEMENT_URL: undefined
  };
  const mailEnv = (extra = {}) => env({ ...MAIL_ENV, ...extra });
  const toList = (e) => e.body.to.join(",");
  const byTo = (needle) => log.emails.filter(e => toList(e).includes(needle));
  const rowFor = (paymentId) => db.plan_signups.find(x => x.provider_payment_id === paymentId);

  // Not configured: the payment is recorded exactly as before and nothing is sent.
  mailEnv({ RESEND_API_KEY: undefined, SIGNUP_ALERT_EMAIL: undefined });
  open(); openCoaching();
  log.emails.length = 0;
  {
    const r = await deliver(paidEvent({ reference: planRef("1"), paymentId: "pay_e1", id: "evt_e1" }));
    t("with no RESEND_API_KEY nothing is sent and the payment is recorded as before",
      r.statusCode === 200 && r.body.result.applied === true && log.emails.length === 0 &&
      rowFor("pay_e1") && !("notifications" in rowFor("pay_e1").metadata));
  }

  // Configured: one email to the buyer, one alert to the owner.
  mailEnv();
  log.emails.length = 0;
  const ref2 = planRef("2");
  {
    const r = await deliver(paidEvent({ reference: ref2, paymentId: "pay_e2", id: "evt_e2" }));
    const buyer = byTo("maria@example.com")[0];
    const owner = byTo("dean@athlevo.example")[0];
    t("a new Plan payment sends exactly two emails: the buyer's and the owner's",
      r.statusCode === 200 && log.emails.length === 2 && buyer && owner && buyer !== owner);
    t("the buyer's email goes only to the buyer, with the Plan subject and the default sender",
      buyer.body.to.length === 1 && buyer.body.to[0] === "maria@example.com" &&
      buyer.body.subject === "Welcome to Athlevo Plan: your next steps" &&
      buyer.body.from === "Athlevo <noreply@athlevo.org>" && buyer.body.reply_to === "support@athlevo.org");
    t("requests carry the Resend key and a per-email idempotency key built from the reference",
      buyer.headers.Authorization === "Bearer re_test_key" &&
      buyer.headers["Idempotency-Key"] === `signup-buyer-${ref2}` && owner.headers["Idempotency-Key"] === `signup-owner-${ref2}`);
    t("the buyer's email carries the price, reference, questionnaire and scheduling links",
      [buyer.body.html, buyer.body.text].every(x =>
        x.includes("₱1,998") && x.includes(ref2) && x.includes(QUESTIONNAIRE) && x.includes(SCHEDULE)) &&
      buyer.body.text.startsWith("Hi Maria,"));
    t("it links back to the confirmation page for that reference",
      buyer.body.text.includes(`https://athlevo.org/programs/athlevo-plan?payment=success&ref=${ref2}`) &&
      buyer.body.html.includes(`https://athlevo.org/programs/athlevo-plan?payment=success&amp;ref=${ref2}`));
    t("it makes no weekly promise, says it does not renew automatically, and has no agreement link when none is set",
      !/weekly/i.test(buyer.body.text + buyer.body.html) && /does not renew automatically/.test(buyer.body.text) &&
      !/agreement/i.test(buyer.body.text));
    t("it does not repeat the buyer's phone number or any coach's name",
      !/\+63917/.test(buyer.body.html + buyer.body.text) && !/Dean|Christian|Louie/.test(buyer.body.html + buyer.body.text));
    t("the owner's alert goes to every configured recipient in one message",
      owner.body.to.join(",") === "dean@athlevo.example,ops@athlevo.example");
    t("the alert is marked TEST for a test-mode payment and names offer, amount and buyer",
      owner.body.subject === "[TEST] New Athlevo Plan sign-up: ₱1,998 — Maria Santos" &&
      /TEST payment/.test(owner.body.html) && /TEST payment/.test(owner.body.text));
    t("the alert lists contact details, reference, payment method and dates",
      [owner.body.html, owner.body.text].every(x =>
        x.includes("Maria Santos") && x.includes("maria@example.com") && x.includes("+639171234567") &&
        x.includes(ref2) && x.includes("QR Ph") && x.includes("Oct 9, 2025") && x.includes("November 8, 2025")));
    t("the row notes how each email went, with statuses only (no personal data)",
      JSON.stringify(rowFor("pay_e2").metadata.notifications).match(/^\{"buyer":"sent","owner":"sent","at":"[^"]+"\}$/) &&
      rowFor("pay_e2").metadata.webhook_mode === "test" && rowFor("pay_e2").metadata.event_id === "evt_e2");
  }

  // Redelivery never sends again.
  {
    const before = log.emails.length;
    await deliver(paidEvent({ reference: ref2, paymentId: "pay_e2", id: "evt_e2" }));
    await deliver(paidEvent({ reference: ref2, paymentId: "pay_e2", id: "evt_e2_retry" }));
    t("a redelivered or retried payment event sends nothing more", log.emails.length === before);
  }

  // Coaching: its own links, its own agreement, never the Plan's.
  mailEnv({ PLAN_AGREEMENT_URL: "https://docs.example.com/plan-agreement", COACHING_AGREEMENT_URL: "https://docs.example.com/coaching-agreement" });
  log.emails.length = 0;
  const ref3 = coRef("3");
  {
    await deliver(paidEvent({ reference: ref3, productId: ATHLEVO_COACHING_PRODUCT.id, amount: 499800, paymentId: "pay_e3", checkoutId: "cs_e3", id: "evt_e3" }));
    const buyer = byTo("maria@example.com")[0];
    const owner = byTo("dean@athlevo.example")[0];
    const all = buyer.body.html + buyer.body.text;
    t("a Coaching payment emails the Coaching subject, price and links",
      buyer.body.subject === "Welcome to Athlevo Coaching: your next steps" && all.includes("₱4,998") &&
      all.includes(COACHING_QUESTIONNAIRE) && all.includes(COACHING_SCHEDULE) && all.includes(ref3) &&
      all.includes("https://athlevo.org/programs/athlevo-coaching?payment=success"));
    t("it never shows the Plan's questionnaire, scheduling or agreement link",
      !all.includes(QUESTIONNAIRE + "\"") && !all.includes(SCHEDULE) && !all.includes("plan-agreement"));
    t("it shows the Coaching agreement link when one is set",
      all.includes("https://docs.example.com/coaching-agreement") && /Read the Athlevo agreement/.test(buyer.body.html));
    t("the alert names Athlevo Coaching and its price",
      owner.body.subject === "[TEST] New Athlevo Coaching sign-up: ₱4,998 — Maria Santos");
  }
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: planRef("4"), paymentId: "pay_e4", checkoutId: "cs_e4", id: "evt_e4" }));
    const all = byTo("maria@example.com")[0].body;
    t("a Plan email shows the Plan agreement link and not the Coaching one",
      all.text.includes("https://docs.example.com/plan-agreement") && !all.text.includes("coaching-agreement"));
  }
  {
    const s1 = res(); await status(post({ ref: ref2 }), s1);
    const s2 = res(); await coachingStatus(post({ ref: ref3 }), s2);
    t("each offer's status returns only its own agreement link",
      s1.body.agreement_url === "https://docs.example.com/plan-agreement" &&
      s2.body.agreement_url === "https://docs.example.com/coaching-agreement" &&
      !JSON.stringify(s1.body).match(/maria|@|\+63/i));
    env({ PLAN_AGREEMENT_URL: "http://insecure.example.com/a" });
    const s3 = res(); await status(post({ ref: ref2 }), s3);
    env({ PLAN_AGREEMENT_URL: undefined });
    const s4 = res(); await status(post({ ref: ref2 }), s4);
    t("an insecure or missing agreement link is null, not invented", s3.body.agreement_url === null && s4.body.agreement_url === null);
    const pending = res(); await status(post({ ref: planRef("A") }), pending);
    t("a pending sign-up exposes no agreement link", pending.body.status === "pending" && !("agreement_url" in pending.body));
  }

  // Coaching borrows the Plan's questionnaire when it has none of its own, as the page does.
  mailEnv();
  env({ COACHING_QUESTIONNAIRE_URL: undefined });
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: coRef("5"), productId: ATHLEVO_COACHING_PRODUCT.id, amount: 499800, paymentId: "pay_e5", checkoutId: "cs_e5", id: "evt_e5" }));
    const buyer = byTo("maria@example.com")[0];
    t("Coaching without its own questionnaire link emails the Plan's, matching the confirmation page",
      buyer && buyer.body.text.includes(QUESTIONNAIRE) && !buyer.body.text.includes(COACHING_QUESTIONNAIRE));
  }
  openCoaching();

  // Hostile contact details never become markup, headers or extra recipients.
  log.emails.length = 0;
  {
    await deliver(paidEvent({
      reference: planRef("6"), paymentId: "pay_e6", checkoutId: "cs_e6", id: "evt_e6",
      billing: { name: "<img src=x onerror=alert(1)>\r\nBcc: evil@example.com", email: "buyer@example.com", phone: "<b>1</b>" }
    }));
    const buyer = byTo("buyer@example.com")[0];
    const owner = byTo("dean@athlevo.example")[0];
    t("the buyer's HTML escapes whatever name PayMongo returned", !/<img/i.test(buyer.body.html) && /&lt;img/.test(buyer.body.html));
    t("the alert's HTML escapes name and phone", !/<img/i.test(owner.body.html) && !/<b>1<\/b>/.test(owner.body.html) && /&lt;b&gt;1/.test(owner.body.html));
    t("no subject carries a line break, and recipients are exactly the validated addresses",
      !/[\r\n]/.test(buyer.body.subject + owner.body.subject) && buyer.body.to.join() === "buyer@example.com" &&
      owner.body.to.join() === "dean@athlevo.example,ops@athlevo.example");
  }
  log.emails.length = 0;
  {
    await deliver(paidEvent({
      reference: planRef("7"), paymentId: "pay_e7", checkoutId: "cs_e7", id: "evt_e7",
      billing: { name: "Two Mails", email: "a@example.com,b@example.com", phone: "" }
    }));
    t("an email field holding several addresses is not used for the buyer",
      byTo("a@example.com").length === 0 && log.emails.length === 1 && /not provided/.test(log.emails[0].body.text));
  }

  // No usable email from PayMongo: the owner is still alerted.
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: planRef("8"), paymentId: "pay_e8", checkoutId: "cs_e8", id: "evt_e8", billing: null }));
    const row = rowFor("pay_e8");
    t("with no buyer email only the alert is sent, and it says so",
      log.emails.length === 1 && log.emails[0].body.to.join() === "dean@athlevo.example,ops@athlevo.example" &&
      /No email address came through/.test(log.emails[0].body.text) && !/\[TEST\] New Athlevo Plan sign-up: .* —/.test(log.emails[0].body.subject));
    t("and the row records the buyer as no_email", row.metadata.notifications.buyer === "no_email" && row.metadata.notifications.owner === "sent");
  }

  // No alert address: the buyer's email still goes.
  mailEnv({ SIGNUP_ALERT_EMAIL: undefined });
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: planRef("9"), paymentId: "pay_e9", checkoutId: "cs_e9", id: "evt_e9" }));
    t("with no SIGNUP_ALERT_EMAIL only the buyer's email is sent",
      log.emails.length === 1 && log.emails[0].body.to.join() === "maria@example.com" &&
      rowFor("pay_e9").metadata.notifications.owner === "no_recipient");
  }
  mailEnv();

  // Sender and reply-to overrides.
  mailEnv({ ATHLEVO_INVITE_FROM_EMAIL: "Athlevo Invites <invites@athlevo.example>", SIGNUP_REPLY_TO_EMAIL: "hello@athlevo.example" });
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: planRef("B"), paymentId: "pay_eb", checkoutId: "cs_eb", id: "evt_eb" }));
    const buyer = byTo("maria@example.com")[0];
    t("the sender falls back to the invite sender, and reply-to is configurable",
      buyer.body.from === "Athlevo Invites <invites@athlevo.example>" && buyer.body.reply_to === "hello@athlevo.example");
  }
  mailEnv({ ATHLEVO_INVITE_FROM_EMAIL: "Athlevo Invites <invites@athlevo.example>", SIGNUP_FROM_EMAIL: "Athlevo <team@athlevo.example>" });
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: planRef("C"), paymentId: "pay_ec", checkoutId: "cs_ec", id: "evt_ec" }));
    t("SIGNUP_FROM_EMAIL wins over the invite sender", log.emails.every(e => e.body.from === "Athlevo <team@athlevo.example>") && log.emails.length === 2);
  }
  mailEnv();

  // A live payment is not marked as a test.
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: planRef("D"), paymentId: "pay_ed", checkoutId: "cs_ed", id: "evt_ed", livemode: true }), { live: true });
    const owner = byTo("dean@athlevo.example")[0];
    t("a live payment's alert is not marked TEST", owner && !/TEST/.test(owner.body.subject + owner.body.text) && /Live payment/.test(owner.body.text));
  }

  // Mail failures never touch the payment.
  for (const mode of ["reject", "throw"]) {
    resendMode = mode;
    log.emails.length = 0;
    const ref = planRef(mode === "reject" ? "E" : "F");
    const id = `pay_ef_${mode}`;
    const r = await deliver(paidEvent({ reference: ref, paymentId: id, checkoutId: `cs_${id}`, id: `evt_${id}` }));
    t(`a ${mode === "reject" ? "rejecting" : "failing"} mail service still returns 200 and records the payment`,
      r.statusCode === 200 && r.body.result.applied === true && rowFor(id) && rowFor(id).status === "paid");
    t(`and the row records both emails as failed (${mode})`,
      rowFor(id).metadata.notifications.buyer === "failed" && rowFor(id).metadata.notifications.owner === "failed");
  }
  {
    resendMode = "hang";
    const started = Date.now();
    const r = await deliver(paidEvent({ reference: planRef("0"), paymentId: "pay_hang", checkoutId: "cs_hang", id: "evt_hang" }));
    const took = Date.now() - started;
    t("a mail service that never answers is given up on within a few seconds, and the payment is still recorded",
      r.statusCode === 200 && r.body.result.applied === true && took < 6000 && rowFor("pay_hang").metadata.notifications.buyer === "failed", `took ${took}ms`);
    resendMode = "ok";
  }

  // Recipient parsing and unit-level guards.
  t("alert recipients: valid, lower-cased, de-duplicated, at most five",
    JSON.stringify(alertRecipients({ SIGNUP_ALERT_EMAIL: "A@x.com; b@y.com, bad, a@x.com, c@z.com d@z.com e@z.com f@z.com" })) ===
    JSON.stringify(["a@x.com", "b@y.com", "c@z.com", "d@z.com", "e@z.com"]) && alertRecipients({}).length === 0);
  t("the buyer's email is not built without a questionnaire link or a usable address",
    buyerConfirmationEmail({ product: ATHLEVO_PLAN_PRODUCT, details: { contact: { email: "x@y.com" }, referenceNumber: "R" }, steps: { questionnaireUrl: null } }) === null &&
    buyerConfirmationEmail({ product: ATHLEVO_PLAN_PRODUCT, details: { contact: { email: "nope" }, referenceNumber: "R" }, steps: { questionnaireUrl: QUESTIONNAIRE } }) === null);

  // Only the store branch notifies; Pro is untouched; nothing new under api/.
  const endpoint = readFileSync("lib/server/paymongoWebhookEndpoint.js", "utf8");
  const storeBranch = endpoint.slice(endpoint.indexOf("if (storePaid) {"), endpoint.indexOf("const paid = extractPaidCheckout(envelope);"));
  t("the webhook notifies only inside the store branch, after the payment is recorded",
    /applyPlanPayment\(/.test(storeBranch) && /notifySignup\(/.test(storeBranch) &&
    storeBranch.indexOf("applyPlanPayment(") < storeBranch.indexOf("notifySignup(") &&
    (endpoint.match(/notifySignup\(/g) || []).length === 1);
}

// ---- 12. partner discount codes ----------------------------------------------
section("12. Partner discount codes (unique per runner, 10% off every payment)");
{
  const pc = await import("../lib/server/partnerCodes.js");
  const gen = await import("../scripts/generate-partner-codes.mjs");
  const { ownerAlertEmail } = await import("../lib/server/signupNotifications.js");
  const MAIL = {
    RESEND_API_KEY: "re_test_key", SIGNUP_ALERT_EMAIL: "dean@athlevo.example",
    SIGNUP_FROM_EMAIL: undefined, ATHLEVO_INVITE_FROM_EMAIL: undefined, SIGNUP_REPLY_TO_EMAIL: undefined,
    PLAN_AGREEMENT_URL: undefined, COACHING_AGREEMENT_URL: undefined
  };
  env(MAIL); open(); openCoaching();
  resendMode = "ok";
  const ref = (code, n) => `ATH-${code}-FEEDFACE02-${n.toString(16).toUpperCase().padStart(24, "0")}`;
  const rowFor = (paymentId) => db.plan_signups.find(x => x.provider_payment_id === paymentId);
  const ALL = "KQ7MX4RT", COACH_ONLY = "HT3N8WZC", EXPIRED = "PD5J2VFG", OFF = "RB6S9YAE", BAD_PCT = "NE8H3TUB", TWENTY = "MC4W7XKD";
  const BATCH = "acme-test-batch";
  db.partner_codes.push(
    { code: ALL, partner: BATCH, percent_off: 10, product_ids: null, active: true, expires_at: null },
    { code: COACH_ONLY, partner: BATCH, percent_off: 10, product_ids: [ATHLEVO_COACHING_PRODUCT.id], active: true, expires_at: null },
    { code: EXPIRED, partner: BATCH, percent_off: 10, product_ids: null, active: true, expires_at: "2020-01-01T00:00:00+08:00" },
    { code: OFF, partner: BATCH, percent_off: 10, product_ids: null, active: false, expires_at: null },
    { code: BAD_PCT, partner: BATCH, percent_off: 80, product_ids: null, active: true, expires_at: null },
    { code: TWENTY, partner: BATCH, percent_off: 20, product_ids: [], active: true, expires_at: "2099-01-01T00:00:00+08:00" }
  );

  // Pure helpers.
  t("a code is read case-insensitively, ignoring spaces and hyphens",
    pc.normalizePartnerCode(" kq7m-x4rt ") === ALL && pc.normalizePartnerCode("KQ7M X4RT") === ALL && pc.formatPartnerCode(ALL) === "KQ7M-X4RT");
  t("anything that cannot be a code is rejected without a lookup (wrong length, 0/1/I/L/O, symbols, non-strings)",
    [null, undefined, "", "KQ7MX4R", "KQ7MX4RTT", "KQ7MX4R0", "KQ7MX4RI", "KQ7MX4RO", "KQ7MX4R'", 12345678, {}].every(v => pc.normalizePartnerCode(v) === null));
  t("the price after a discount is exact whole centavos, rounded half up",
    pc.discountedCents(199800, 10) === 179820 && pc.discountedCents(499800, 10) === 449820 &&
    pc.discountedCents(199800, 15) === 169830 && pc.discountedCents(1001, 50) === 501 && pc.discountedCents(199800, 100) === 0);
  t("only whole percentages from 1 to 50 are valid",
    [1, 10, 50].every(pc.validDiscountPercent) && [0, -5, 51, 10.5, NaN, null, undefined, "10"].every(v => !pc.validDiscountPercent(v)));

  // Checking a code (no checkout is opened).
  const sessions = () => log.paymongo.length;
  {
    const before = sessions();
    const r = res(); await checkout(post({ code: " kq7m-x4rt ", check: true }, "198.51.100.10"), r);
    t("checking a Plan code answers the discounted price and opens no checkout",
      r.statusCode === 200 && r.body.valid === true && r.body.percent_off === 10 &&
      r.body.price_cents === 179820 && r.body.list_price_cents === 199800 && sessions() === before);
    t("the answer never names the partner or the batch",
      !JSON.stringify(r.body).toLowerCase().includes("acme") && !JSON.stringify(r.body).includes(BATCH));
    const c = res(); await coachingCheckout(post({ code: ALL, check: true }, "198.51.100.11"), c);
    t("the same code gives the Coaching price too (₱4,498.20 off ₱4,998)",
      c.statusCode === 200 && c.body.price_cents === 449820 && c.body.list_price_cents === 499800);
    const w = res(); await checkout(post({ code: TWENTY, check: true }, "198.51.100.12"), w);
    t("the percentage comes from the code's row: a 20% code takes 20% off",
      w.body.percent_off === 20 && w.body.price_cents === 159840);
  }
  {
    const bodies = [];
    const tryCode = async (handler, code, check = true) => { const r = res(); await handler(post({ code, check }, "198.51.100.13"), r); bodies.push(r); return r; };
    await tryCode(checkout, "ZZZZZZZZ");
    await tryCode(checkout, EXPIRED);
    await tryCode(checkout, OFF);
    await tryCode(checkout, COACH_ONLY);
    await tryCode(checkout, BAD_PCT);
    await tryCode(checkout, "nope");
    t("an unknown, expired, switched-off, wrong-offer, out-of-range or malformed code is the same 400",
      bodies.every(r => r.statusCode === 400 && r.body.error === "invalid_code" && r.body.message === "That code isn't valid.") &&
      new Set(bodies.map(r => JSON.stringify(r.body))).size === 1);
    const ok = await tryCode(coachingCheckout, COACH_ONLY);
    t("an offer-specific code works on its own offer", ok.statusCode === 200 && ok.body.price_cents === 449820);
    const empty = res(); await checkout(post({ check: true }, "198.51.100.14"), empty);
    t("checking with no code is a 400", empty.statusCode === 400 && empty.body.error === "invalid_code");
  }

  // Starting a checkout with a code.
  let discountedRef;
  {
    const before = sessions();
    const r = res();
    await checkout(post({ code: ALL, percent: 90, amount: 1, price_cents: 1, discount: 99 }, "198.51.100.20"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    discountedRef = a.reference_number;
    t("a coded checkout is priced by the server: ₱1,798.20, whatever the browser claims",
      r.statusCode === 200 && sessions() === before + 1 && JSON.stringify(Object.keys(r.body)) === '["checkout_url"]' &&
      a.line_items[0].amount === 179820 && a.line_items.length === 1 && a.line_items[0].quantity === 1);
    t("the session records the code, the percentage and the list price for the webhook to check",
      a.metadata.partner_code === ALL && a.metadata.discount_percent === "10" && a.metadata.list_price_cents === "199800" &&
      a.metadata.athlevo_product === "ATHLEVO_PLAN_MONTHLY");
    t("PayMongo shows that a discount was applied, and the line item name is unchanged",
      /10% discount applied/.test(a.description) && /10% discount applied/.test(a.line_items[0].description) && a.line_items[0].name === "Athlevo Plan");
    t("nothing in what PayMongo or the browser sees names the partner",
      !JSON.stringify(a).toLowerCase().includes("acme") && !JSON.stringify(r.body).toLowerCase().includes("acme"));
    const co = res(); await coachingCheckout(post({ code: ALL }, "198.51.100.21"), co);
    const ca = log.paymongo[log.paymongo.length - 1].attributes;
    t("a coded Coaching checkout is ₱4,498.20", co.statusCode === 200 && ca.line_items[0].amount === 449820 && ca.metadata.athlevo_product === "ATHLEVO_COACHING_MONTHLY");
  }
  {
    const before = sessions();
    const bad = res(); await checkout(post({ code: EXPIRED }, "198.51.100.22"), bad);
    t("an invalid code never opens a checkout (the buyer is not silently charged full price)",
      bad.statusCode === 400 && bad.body.error === "invalid_code" && sessions() === before);
    const numeric = res(); await checkout(post({ code: 12345678 }, "198.51.100.23"), numeric);
    const na = log.paymongo[log.paymongo.length - 1].attributes;
    t("a code that is not text is ignored: the normal full-price checkout", numeric.statusCode === 200 && na.line_items[0].amount === 199800 && !("partner_code" in na.metadata));
    const none = res(); await checkout(post({}, "198.51.100.24"), none);
    const noneAttrs = log.paymongo[log.paymongo.length - 1].attributes;
    t("with no code the checkout is exactly as before", none.statusCode === 200 && noneAttrs.line_items[0].amount === 199800 &&
      JSON.stringify(Object.keys(noneAttrs.metadata)) === '["athlevo_product","athlevo_source"]' && noneAttrs.description === "Athlevo Plan — 1 month");
  }
  {
    partnerTableMissing = true;
    const before = sessions();
    const check = res(); await checkout(post({ code: ALL, check: true }, "198.51.100.30"), check);
    const coded = res(); await checkout(post({ code: ALL }, "198.51.100.30"), coded);
    const plain = res(); await checkout(post({}, "198.51.100.30"), plain);
    partnerTableMissing = false;
    t("before the migration, codes say 'unavailable' (503) and open no checkout, while a normal sign-up still works",
      check.statusCode === 503 && check.body.error === "codes_unavailable" && coded.statusCode === 503 && plain.statusCode === 200 && sessions() === before + 1);
  }
  {
    const ip = "198.51.100.40";
    let last;
    for (let i = 0; i < 31; i += 1) { last = res(); await checkout(post({ code: "ZZZZZZZZ", check: true }, ip), last); }
    t("code guessing is rate limited (30 checks an hour), separately from opening checkouts", last.statusCode === 429);
    const stillOk = res(); await checkout(post({}, ip), stillOk);
    t("and a rate-limited guesser can still open a normal checkout", stillOk.statusCode === 200);
  }
  t("an owner who switches sign-up off also switches the code check off",
    await (async () => { closed(); const r = res(); await checkout(post({ code: ALL, check: true }, "198.51.100.50"), r); open(); return r.statusCode === 503; })());

  // The webhook: exactly the discounted amount, nothing else.
  const msgs = () => log.emails.map(e => e.body);
  log.emails.length = 0;
  {
    const r = await deliver(paidEvent({ reference: discountedRef, amount: 179820, partnerCode: ALL, discountPercent: 10, paymentId: "pay_d1", id: "evt_d1" }));
    const row = rowFor("pay_d1");
    t("a payment of exactly the discounted price is recorded, with the code and the partner label",
      r.statusCode === 200 && r.body.result.applied === true && row && row.amount_cents === 179820 &&
      row.partner_code === ALL && row.partner === BATCH && row.list_price_cents === 199800 && row.discount_percent === 10);
    t("the sign-up row's metadata also carries the code, and shows no sharing flag the first time",
      row.metadata.partner_code === ALL && row.metadata.discount_percent === 10 && !("code_email_mismatch" in row.metadata), JSON.stringify(row.metadata));
    const owner = msgs().find(m => m.to.includes("dean@athlevo.example"));
    const buyer = msgs().find(m => m.to.includes("maria@example.com"));
    t("the owner's alert shows what was paid, the discount, the code and the partner batch",
      owner && owner.subject.includes("₱1,798.20") && owner.subject.endsWith(` · ${BATCH}`) &&
      owner.text.includes("Discount: 10% off the ₱1,998 price") && owner.text.includes("Discount code: KQ7M-X4RT") &&
      owner.text.includes(`Partner batch: ${BATCH}`) && owner.text.includes("Amount: ₱1,798.20") && !/may have been shared/.test(owner.text));
    t("the buyer's email shows the amount paid and the discount, and never names the partner",
      buyer && buyer.text.includes("Your payment of ₱1,798.20 is confirmed.") && buyer.text.includes("Your discount code took 10% off. Use the same code (KQ7M-X4RT) again when you renew to keep the discount.") &&
      buyer.html.includes("₱1,798.20") && !(buyer.subject + buyer.text + buyer.html).toLowerCase().includes("acme") &&
      !(buyer.subject + buyer.text + buyer.html).includes(BATCH));
    const dup = await deliver(paidEvent({ reference: discountedRef, amount: 179820, partnerCode: ALL, discountPercent: 10, paymentId: "pay_d1", id: "evt_d1" }));
    t("a redelivered discounted event is a duplicate: nothing new is recorded or sent",
      dup.statusCode === 200 && dup.body.result.duplicate === true && db.plan_signups.filter(x => x.provider_payment_id === "pay_d1").length === 1 && msgs().length === 2);
  }
  {
    // Month two: the same runner pays again with the same code. The discount applies again.
    log.emails.length = 0;
    const r = await deliver(paidEvent({ reference: ref("PL", 2), amount: 179820, partnerCode: ALL, discountPercent: 10,
      paymentId: "pay_d2", id: "evt_d2", paidAt: 1762600000 }));
    const row = rowFor("pay_d2");
    const owner = msgs().find(m => m.to.includes("dean@athlevo.example"));
    t("a renewal with the same code from the same email is discounted again and is not flagged",
      r.statusCode === 200 && r.body.result.applied === true && row.partner_code === ALL && !("code_email_mismatch" in row.metadata) &&
      owner && !/may have been shared/.test(owner.text) && r.body.result.partner.mismatch === false);
    // A different person pays with the same code: still accepted (they already paid), but flagged.
    log.emails.length = 0;
    const s2 = await deliver(paidEvent({ reference: ref("PL", 3), amount: 179820, partnerCode: ALL, discountPercent: 10,
      paymentId: "pay_d3", id: "evt_d3", paidAt: 1762700000, billing: { name: "Someone Else", email: "other@example.com", phone: "+639170000000" } }));
    const shared = rowFor("pay_d3");
    const ownerShared = msgs().find(m => m.to.includes("dean@athlevo.example"));
    t("a different email using the same code is still recorded, but flagged on the row and in the alert",
      s2.statusCode === 200 && s2.body.result.applied === true && shared.metadata.code_email_mismatch === true &&
      ownerShared && /may have been shared/.test(ownerShared.text) && ownerShared.text.includes("Discount code: KQ7M-X4RT"), JSON.stringify([s2.statusCode, s2.body, shared && shared.metadata, ownerShared && ownerShared.text]));
  }
  {
    const before = db.plan_signups.length;
    const wrong = {};
    wrong.fullPriceWithCode = await deliver(paidEvent({ reference: ref("PL", 4), amount: 199800, partnerCode: ALL, discountPercent: 10, paymentId: "pay_w1", id: "evt_w1" }));
    wrong.discountWithoutCode = await deliver(paidEvent({ reference: ref("PL", 5), amount: 179820, paymentId: "pay_w2", id: "evt_w2" }));
    wrong.codeWithoutPercent = await deliver(paidEvent({ reference: ref("PL", 6), amount: 179820, partnerCode: ALL, paymentId: "pay_w3", id: "evt_w3" }));
    wrong.percentWithoutCode = await deliver(paidEvent({ reference: ref("PL", 7), amount: 179820, discountPercent: 10, paymentId: "pay_w4", id: "evt_w4" }));
    wrong.over50 = await deliver(paidEvent({ reference: ref("PL", 8), amount: 99900, partnerCode: ALL, discountPercent: 51, paymentId: "pay_w5", id: "evt_w5" }));
    wrong.notANumber = await deliver(paidEvent({ reference: ref("PL", 9), amount: 179820, partnerCode: ALL, discountPercent: "abc", paymentId: "pay_w6", id: "evt_w6" }));
    wrong.badCode = await deliver(paidEvent({ reference: ref("PL", 10), amount: 179820, partnerCode: "KQ7MX4R0", discountPercent: 10, paymentId: "pay_w7", id: "evt_w7" }));
    wrong.mismatchedPercent = await deliver(paidEvent({ reference: ref("PL", 11), amount: 179820, partnerCode: ALL, discountPercent: 20, paymentId: "pay_w8", id: "evt_w8" }));
    wrong.coachingAtPlanDiscount = await deliver(paidEvent({ reference: ref("CO", 12), productId: ATHLEVO_COACHING_PRODUCT.id, amount: 179820, partnerCode: ALL, discountPercent: 10, paymentId: "pay_w9", id: "evt_w9" }));
    t("every other amount or half-filled discount is refused with a 400 and nothing is recorded",
      Object.values(wrong).every(r => r.statusCode === 400 && r.body.error === "Payment validation failed.") && db.plan_signups.length === before,
      JSON.stringify(Object.entries(wrong).map(([k, v]) => [k, v.statusCode, v.body && v.body.error])));
    const u = (details, product) => planMod.validatePlanPayment(details, product);
    const base = { amountCents: 179820, currency: "PHP", productId: ATHLEVO_PLAN_PRODUCT.id, checkoutId: "cs", paymentId: "p",
      referenceNumber: ref("PL", 13), partnerCode: ALL, discountPercent: 10 };
    t("validation names the reason: ok, bad_discount, wrong_amount",
      u(base, ATHLEVO_PLAN_PRODUCT) === null && u({ ...base, partnerCode: null }, ATHLEVO_PLAN_PRODUCT) === "bad_discount" &&
      u({ ...base, amountCents: 199800 }, ATHLEVO_PLAN_PRODUCT) === "wrong_amount" &&
      u({ ...base, partnerCode: undefined, discountPercent: undefined }, ATHLEVO_PLAN_PRODUCT) === "wrong_amount",
      JSON.stringify([u(base, ATHLEVO_PLAN_PRODUCT), u({ ...base, partnerCode: null }, ATHLEVO_PLAN_PRODUCT), u({ ...base, amountCents: 199800 }, ATHLEVO_PLAN_PRODUCT), u({ ...base, partnerCode: undefined, discountPercent: undefined }, ATHLEVO_PLAN_PRODUCT)]));
  }
  {
    // Coaching renewal and refund of a discounted payment.
    log.emails.length = 0;
    const r = await deliver(paidEvent({ reference: ref("CO", 14), productId: ATHLEVO_COACHING_PRODUCT.id, amount: 449820,
      partnerCode: COACH_ONLY, discountPercent: 10, paymentId: "pay_c1", id: "evt_c1" }));
    const row = rowFor("pay_c1");
    t("a discounted Coaching payment (₱4,498.20) is recorded under the Coaching product",
      r.statusCode === 200 && row.product_id === ATHLEVO_COACHING_PRODUCT.id && row.amount_cents === 449820 && row.list_price_cents === 499800 && row.partner === BATCH, JSON.stringify([r.statusCode, r.body, row]));
    paymentAmounts.set("pay_d1", 179820);
    const refund = await deliver(refundEvent({ paymentId: "pay_d1", amount: 179820, id: "evt_rd1" }));
    t("a full refund of a discounted payment is recognised against the amount actually paid",
      refund.statusCode === 200 && rowFor("pay_d1").status === "refunded");
  }
  {
    // Before the migration adds the columns, a coded payment is still kept (in metadata).
    extraColumnsMissing = true;
    const r = await deliver(paidEvent({ reference: ref("PL", 15), amount: 179820, partnerCode: ALL, discountPercent: 10, paymentId: "pay_x1", id: "evt_x1" }));
    extraColumnsMissing = false;
    const row = rowFor("pay_x1");
    t("if the new columns are missing, the payment is still recorded with the code in metadata",
      r.statusCode === 200 && r.body.result.applied === true && row && !("partner_code" in row) && row.metadata.partner_code === ALL && row.amount_cents === 179820, JSON.stringify([r.statusCode, r.body, row]));
  }
  t("an ordinary payment's row has no partner columns at all",
    !("partner_code" in rowFor("pay_e2")) && !("partner" in rowFor("pay_e2")) && !("discount_percent" in rowFor("pay_e2")));
  t("the owner's alert for an ordinary payment is unchanged (no discount rows)",
    !/Discount/.test(ownerAlertEmail({ product: ATHLEVO_PLAN_PRODUCT, details: { amountCents: 199800, contact: {}, referenceNumber: "R" }, recipients: ["a@b.com"] }).text));

  // The code generator.
  {
    const codes = gen.generateCodes(1000);
    t("the generator makes 1000 distinct, valid codes", new Set(codes).size === 1000 && codes.every(c => pc.normalizePartnerCode(c) === c));
    let n = 0;
    const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
    const forced = gen.generateCodes(2, () => seq[n++ % seq.length]);
    t("a repeated code is thrown away, never written twice", forced.length === 2 && forced[0] !== forced[1]);
    const o = gen.parseOptions(["--partner", "acme-2026-11-24", "--count", "50", "--expires", "2026-12-31", "--products", "plan,coaching"]);
    t("options: defaults to 10%, both products means 'every product', expiry is the end of that day in Philippine time",
      o.percent === 10 && o.productIds === null && o.expiresAt === "2026-12-31T23:59:59+08:00" && o.count === 50 && o.out === "partner-codes");
    t("options: one product, a custom percent",
      JSON.stringify(gen.parseOptions(["--partner", "x", "--count", "1", "--products", "coaching", "--percent", "15"]).productIds) === '["ATHLEVO_COACHING_MONTHLY"]');
    const bad = [
      [], ["--partner", "Bad Label", "--count", "1"], ["--partner", "x'; drop table", "--count", "1"], ["--partner", "x"],
      ["--partner", "x", "--count", "0"], ["--partner", "x", "--count", "1001"], ["--partner", "x", "--count", "1.5"],
      ["--partner", "x", "--count", "1", "--percent", "0"], ["--partner", "x", "--count", "1", "--percent", "51"],
      ["--partner", "x", "--count", "1", "--expires", "31-12-2026"], ["--partner", "x", "--count", "1", "--expires", "2026-13-40"],
      ["--partner", "x", "--count", "1", "--products", "elite"], ["--partner", "x", "--count", "1", "--bogus", "1"], ["stray"]
    ];
    t("options: every malformed input is refused", bad.every(argv => { try { gen.parseOptions(argv); return false; } catch (e) { return true; } }));
    const sql = gen.buildSql(["KQ7MX4RT", "HT3N8WZC"], gen.parseOptions(["--partner", "acme-test", "--count", "2", "--note", "it's a test", "--products", "plan"]));
    t("the SQL inserts each code once, quotes text safely, and skips codes that already exist",
      /insert into public\.partner_codes/.test(sql) && sql.includes("('KQ7MX4RT', 'acme-test', 10, array['ATHLEVO_PLAN_MONTHLY']::text[], null, 'it''s a test')") &&
      /on conflict \(code\) do nothing;/.test(sql) && (sql.match(/\('/g) || []).length === 2);
    const csv = gen.buildCsv(["KQ7MX4RT"], gen.parseOptions(["--partner", "acme-test", "--count", "1"]));
    t("the CSV lists codes the way runners type them", csv === "code,batch,percent_off,expires\nKQ7M-X4RT,acme-test,10,\n");
  }

  // Wiring.
  {
    const migration = readFileSync("migrations/2026-10-21_partner_codes.sql", "utf8");
    t("the migration is additive, locks both tables to the service role, and matches the code alphabet",
      /create table if not exists public\.partner_codes/.test(migration) && /enable row level security/.test(migration) &&
      !/\bdrop\b|\bdelete\b|create policy/i.test(migration) && migration.includes(`[${pc.PARTNER_CODE_ALPHABET}]{${pc.PARTNER_CODE_LENGTH}}`) &&
      /add column if not exists partner_code/.test(migration) && /percent_off between 1 and 50/.test(migration));
    const handlerSource = readFileSync("lib/server/planSignup.js", "utf8");
    t("only the code text is read from the browser's request, never an amount or a percentage",
      !/body\.(amount|percent|price|discount)/.test(handlerSource) && /body\.code/.test(handlerSource));
    t("the partner label is never put in anything sent to PayMongo or the browser",
      !/partner:|\.partner\b/.test(handlerSource.slice(handlerSource.indexOf("function checkoutAttributes"), handlerSource.indexOf("function clientIp"))));
    t("the code check reuses the checkout endpoint (no new function under api/)",
      !readFileSync("vercel.json", "utf8").includes("partner") && !readFileSync("vercel.json", "utf8").includes("discount"));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
