/*
 * Store sign-up (Athlevo Plan, Athlevo Guided, Athlevo Coaching and Athlevo VIP Coaching, public /programs checkout): server behaviour.
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
const paymentAmounts = new Map(); // payment id -> amount PayMongo reports (default ₱2,997)
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
      return json({ data: { attributes: { amount: paymentAmounts.get(paymentId) || 299700, refunds: [] } } });
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
  // `checkout` and `status` are Guided's (the offer that used to be the Athlevo Plan); the new
  // ₱999 Athlevo Plan is `planCheckout` / `planStatus`.
  guidedSignupCheckoutHandler: checkout, guidedSignupStatusHandler: status, ATHLEVO_GUIDED_PRODUCT,
  planSignupCheckoutHandler: planCheckout, planSignupStatusHandler: planStatus, ATHLEVO_PLAN_PRODUCT,
  coachingSignupCheckoutHandler: coachingCheckout, coachingSignupStatusHandler: coachingStatus,
  ATHLEVO_COACHING_PRODUCT,
  vipSignupCheckoutHandler: vipCheckout, vipSignupStatusHandler: vipStatus, ATHLEVO_VIP_PRODUCT
} = planMod;
const COACHING_QUESTIONNAIRE = "https://forms.example.com/athlevo-coaching-questionnaire";
const COACHING_SCHEDULE = "https://cal.example.com/athlevo-coaching-call";
const VIP_QUESTIONNAIRE = "https://forms.example.com/athlevo-vip-questionnaire";
const VIP_SCHEDULE = "https://cal.example.com/athlevo-vip-call";

const env = (patch) => Object.keys(patch).forEach(k => {
  if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k];
});
// open()/closed() are Athlevo Guided's. closed() also clears the PLAN_* settings, which the other offers
// borrow, so that "closed" really means nothing is configured.
const open = () => env({ GUIDED_SIGNUP_ENABLED: "true", GUIDED_QUESTIONNAIRE_URL: QUESTIONNAIRE, GUIDED_SCHEDULE_URL: SCHEDULE });
const closed = () => env({
  GUIDED_SIGNUP_ENABLED: undefined, GUIDED_QUESTIONNAIRE_URL: undefined, GUIDED_SCHEDULE_URL: undefined, GUIDED_AGREEMENT_URL: undefined,
  PLAN_SIGNUP_ENABLED: undefined, PLAN_QUESTIONNAIRE_URL: undefined, PLAN_SCHEDULE_URL: undefined, PLAN_AGREEMENT_URL: undefined
});
const PLAN_QUESTIONNAIRE = "https://forms.example.com/athlevo-plan-questionnaire";
const openPlan = () => env({ PLAN_SIGNUP_ENABLED: "true", PLAN_QUESTIONNAIRE_URL: PLAN_QUESTIONNAIRE });
const openCoaching = () => env({
  COACHING_SIGNUP_ENABLED: "true", COACHING_QUESTIONNAIRE_URL: COACHING_QUESTIONNAIRE, COACHING_SCHEDULE_URL: COACHING_SCHEDULE
});
const closedCoaching = () => env({
  COACHING_SIGNUP_ENABLED: undefined, COACHING_QUESTIONNAIRE_URL: undefined, COACHING_SCHEDULE_URL: undefined
});
const openVIP = () => env({
  VIP_SIGNUP_ENABLED: "true", VIP_QUESTIONNAIRE_URL: VIP_QUESTIONNAIRE, VIP_SCHEDULE_URL: VIP_SCHEDULE
});
const closedVIP = () => env({
  VIP_SIGNUP_ENABLED: undefined, VIP_QUESTIONNAIRE_URL: undefined, VIP_SCHEDULE_URL: undefined
});
const post = (body, ip = "203.0.113.5") => ({ method: "POST", headers: { "x-forwarded-for": ip }, body });

function paidEvent({ reference, productId = ATHLEVO_GUIDED_PRODUCT.id, amount = 299700, livemode = false,
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
function refundEvent({ paymentId = "pay_1", amount = 299700, id = "evt_r1", type = "payment.refunded" } = {}) {
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
  t("checkout is unavailable until GUIDED_SIGNUP_ENABLED is set", r.statusCode === 503 && log.paymongo.length === before);
  const s = res();
  await status(post({ ref: "ATH-PL-AAAAAAAAAAA-" + "A".repeat(24) }), s);
  t("status still answers while sign-up is closed (buyers keep their confirmation)", s.statusCode === 200 && s.body.status === "pending");
  env({ SUPABASE_URL: undefined });
  const noDb = res();
  await status(post({ ref: "ATH-PL-AAAAAAAAAAA-" + "A".repeat(24) }), noDb);
  env({ SUPABASE_URL: "https://db.test" });
  t("status is unavailable only when the database is not configured", noDb.statusCode === 503);
}
env({ GUIDED_SIGNUP_ENABLED: "true" });
{
  const r = res(); await checkout(post({}), r);
  t("enabled but no questionnaire link: still closed", r.statusCode === 503);
}
env({ GUIDED_QUESTIONNAIRE_URL: "http://forms.example.com/insecure" });
{
  const r = res(); await checkout(post({}), r);
  t("a non-https questionnaire link keeps it closed", r.statusCode === 503);
}
env({ GUIDED_QUESTIONNAIRE_URL: "javascript:alert(1)" });
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
  t("amount is the server-owned ₱2,997 whatever the browser sends",
    a.line_items.length === 1 && a.line_items[0].amount === 299700 && a.line_items[0].currency === "PHP" && a.line_items[0].quantity === 1);
  t("the Guided price matches the price shown on the page",
    (() => {
      const sandbox = {}; sandbox.window = sandbox; sandbox.globalThis = sandbox;
      vm.runInNewContext(readFileSync("js/storeCatalog.js", "utf8"), sandbox);
      const shown = sandbox.AthlevoStoreCatalog.getProduct("athlevo-guided").page.price;
      return shown.amount === "₱" + (ATHLEVO_GUIDED_PRODUCT.priceCents / 100).toLocaleString("en-US") && /month/i.test(shown.period);
    })());
  t("offers the same methods as Athlevo Pro (QRPh, GrabPay, Maya); GCash is not offered",
    JSON.stringify(a.payment_method_types) === '["qrph","grab_pay","paymaya"]');
  t("reference number has the Guided format", /^ATH-PL-[0-9A-F]{8,16}-[0-9A-F]{24}$/.test(reference), reference);
  t("tagged as the Guided product, with no Athlevo user",
    a.metadata.athlevo_product === "ATHLEVO_PLAN_MONTHLY" && !("athlevo_user_id" in a.metadata));
  t("returns to the Guided page with the reference, or back on cancel",
    a.success_url === `https://programs.athlevo.org/athlevo-guided?payment=success&ref=${encodeURIComponent(reference)}` &&
    a.cancel_url === "https://programs.athlevo.org/athlevo-guided?payment=cancelled");
  t("no secret or key reaches the browser", !JSON.stringify(r.body).includes("sk_test"));
  t("asks PayMongo to email a receipt", a.send_email_receipt === true);
}
env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app" });
{
  const r = res(); await checkout(post({}, "203.0.113.6"), r);
  const a = log.paymongo[log.paymongo.length - 1].attributes;
  t("a Vercel preview returns to itself, so a test payment never lands on the live site",
    a.success_url.startsWith("https://athlevo-git-store-x.vercel.app/athlevo-guided?payment=success"));
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
    db.plan_signups.length === 1 && row.reference_number === reference && row.amount_cents === 299700 &&
    row.currency === "PHP" && row.provider_payment_id === "pay_1" && row.provider_checkout_id === "cs_1" && row.status === "paid");
  t("contact details come from PayMongo, email normalised",
    row.customer_name === "Maria Santos" && row.customer_email === "maria@example.com" && row.customer_phone === "+639171234567");
  t("test-mode payments are marked livemode=false", row.livemode === false);
  t("paid_through is 30 days after payment",
    Date.parse(row.paid_through) - Date.parse(row.paid_at) === 30 * 86400000);
  t("a Guided payment touches no app subscription or Pro ledger",
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
  env({ GUIDED_SCHEDULE_URL: undefined });
  const noSchedule = res(); await status(post({ ref: reference }), noSchedule);
  t("without a scheduling link the field is null, not missing or invented", noSchedule.body.schedule_url === null);
  env({ GUIDED_SCHEDULE_URL: "ftp://bad.example.com" });
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
  t("a reference that is not a Guided reference is rejected", badRef.statusCode === 400 && db.plan_signups.length === before);
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
  t("a Pro payment still goes down the Pro path (unknown checkout → 400) and writes no Guided row",
    r.statusCode === 400 && db.plan_signups.length === before);
  const proRefundOpen = await deliver(refundEvent({ paymentId: "pay_pro_1", id: "evt_pr2" }));
  t("a Pro refund falls through to the Pro path (unknown to the Guided table)",
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
  t("before the migration is run, a Pro refund is unaffected by the missing Guided table",
    preMigrationRefund.statusCode === 200 && preMigrationRefund.body.result.reason === "unknown_payment");
  const preMigrationPay = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "F".repeat(24), paymentId: "pay_6", id: "evt_6" }));
  t("a Guided payment with no table fails loudly (500) so PayMongo retries instead of dropping it", preMigrationPay.statusCode === 500);
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
    t("opening the Guided does not open Coaching", r.statusCode === 503);
  }
  closed(); openCoaching();
  {
    const r = res(); await checkout(post({}, "203.0.113.22"), r);
    t("opening Coaching does not open the Guided", r.statusCode === 503);
  }
  env({ COACHING_QUESTIONNAIRE_URL: undefined, COACHING_SCHEDULE_URL: undefined });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.23"), r);
    t("enabled with no questionnaire link anywhere: still closed", r.statusCode === 503);
  }
  env({ PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.24"), r);
    t("with no Coaching link it uses the shared PLAN_ questionnaire (same questionnaire)", r.statusCode === 200);
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
    t("a non-https Coaching link keeps it closed and does not fall back to the shared one", r.statusCode === 503);
  }
  closed(); openCoaching();
  env({ COACHING_QUESTIONNAIRE_URL: "   ", PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.26"), r);
    t("a blank Coaching link counts as not set and uses the shared one", r.statusCode === 200);
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
    t("same payment methods as the Guided; GCash is not offered",
      JSON.stringify(a.payment_method_types) === '["qrph","grab_pay","paymaya"]');
    t("reference number has the Coaching format, never the Guided's", /^ATH-CO-[0-9A-F]{8,16}-[0-9A-F]{24}$/.test(coRef), coRef);
    t("tagged as the Coaching product, with no Athlevo user",
      a.metadata.athlevo_product === "ATHLEVO_COACHING_MONTHLY" && !("athlevo_user_id" in a.metadata));
    t("returns to the Coaching page with the reference, or back on cancel",
      a.success_url === `https://programs.athlevo.org/athlevo-coaching?payment=success&ref=${encodeURIComponent(coRef)}` &&
      a.cancel_url === "https://programs.athlevo.org/athlevo-coaching?payment=cancelled");
  }
  env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app" });
  {
    const r = res(); await coachingCheckout(post({}, "203.0.113.31"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    t("a Vercel preview returns to itself", a.success_url.startsWith("https://athlevo-git-store-x.vercel.app/athlevo-coaching?payment=success"));
  }
  env({ VERCEL_ENV: undefined, VERCEL_URL: undefined });
  {
    let last;
    for (let i = 0; i < 12; i++) { last = res(); await checkout(post({}, "198.51.100.77"), last); }
    open();
    for (let i = 0; i < 12; i++) { last = res(); await checkout(post({}, "198.51.100.77"), last); }
    t("the Guided's rate limit is used up for this visitor", last.statusCode === 429);
    const co = res(); await coachingCheckout(post({}, "198.51.100.77"), co);
    t("Coaching is rate limited separately from the Guided", co.statusCode === 200);
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
    t("a Guided reference is rejected by the Coaching status endpoint", planRef.statusCode === 400);
    const coOnPlan = res(); await status(post({ ref: coRef }), coOnPlan);
    t("a Coaching reference is rejected by the Guided status endpoint", coOnPlan.statusCode === 400);
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
    try { await planMod.applySignupPayment("https://db.test", "service-secret", details, "test"); } catch (error) { threw = true; }
    t("recording a Coaching payment as the Guided product (the default) is refused outright",
      threw && db.plan_signups.length === before);
    const ok = await planMod.applySignupPayment("https://db.test", "service-secret", details, "test", ATHLEVO_COACHING_PRODUCT);
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
    const planPrice = await deliver(coachingPaid({ reference: CO_REF("B"), amount: 299700, paymentId: "pay_co2", id: "evt_co2" }));
    t("the Guided's price on a Coaching payment is rejected and not recorded", planPrice.statusCode === 400 && db.plan_signups.length === before);
    const coachingPriceOnPlan = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "B".repeat(24), amount: 499800, paymentId: "pay_co3", id: "evt_co3" }));
    t("the Coaching price on a Guided payment is rejected too", coachingPriceOnPlan.statusCode === 400 && db.plan_signups.length === before);
    const planRefOnCoaching = await deliver(coachingPaid({ reference: "ATH-PL-1234567890A-" + "C".repeat(24), paymentId: "pay_co4", id: "evt_co4" }));
    t("a Guided reference on a Coaching payment is rejected", planRefOnCoaching.statusCode === 400 && db.plan_signups.length === before);
    const coRefOnPlan = await deliver(paidEvent({ reference: CO_REF("D"), paymentId: "pay_co5", id: "evt_co5" }));
    t("a Coaching reference on a Guided payment is rejected", coRefOnPlan.statusCode === 400 && db.plan_signups.length === before);
    const junk = await deliver(coachingPaid({ reference: "ATH-CO-NOT-A-REFERENCE", paymentId: "pay_co6", id: "evt_co6" }));
    t("a malformed Coaching reference is rejected", junk.statusCode === 400 && db.plan_signups.length === before);
    const unknownProduct = await deliver(paidEvent({ reference: CO_REF("E"), productId: "ATHLEVO_HYBRID_MONTHLY", amount: 799800, paymentId: "pay_co7", id: "evt_co7" }));
    t("an unknown store product is never recorded as a sign-up",
      db.plan_signups.length === before && !db.plan_signups.some(x => x.product_id === "ATHLEVO_HYBRID_MONTHLY"));
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

section("9b. Athlevo VIP Coaching (₱7,998)");
{
  const EL_REF = (c) => "ATH-EL-1234567890A-" + c.repeat(24);
  const vipPaid = (o = {}) => paidEvent({ productId: ATHLEVO_VIP_PRODUCT.id, amount: 799800, ...o });

  // closed by default, and each switch only opens its own offer
  closed(); closedCoaching(); closedVIP();
  {
    const before = log.paymongo.length;
    const r = res(); await vipCheckout(post({}, "203.0.113.40"), r);
    t("VIP checkout is unavailable until VIP_SIGNUP_ENABLED is set", r.statusCode === 503 && log.paymongo.length === before);
    const s1 = res(); await vipStatus(post({ ref: EL_REF("A") }, "203.0.113.40"), s1);
    t("VIP status still answers while closed (buyers keep their confirmation)", s1.statusCode === 200 && s1.body.status === "pending");
  }
  open(); openCoaching();
  {
    const r = res(); await vipCheckout(post({}, "203.0.113.41"), r);
    t("opening the Guided and Coaching does not open VIP", r.statusCode === 503);
  }
  closed(); closedCoaching(); openVIP();
  {
    const p = res(); await checkout(post({}, "203.0.113.42"), p);
    const c = res(); await coachingCheckout(post({}, "203.0.113.42"), c);
    t("opening VIP does not open the Guided or Coaching", p.statusCode === 503 && c.statusCode === 503);
  }
  env({ VIP_QUESTIONNAIRE_URL: undefined, VIP_SCHEDULE_URL: undefined });
  {
    const r = res(); await vipCheckout(post({}, "203.0.113.43"), r);
    t("enabled with no questionnaire link anywhere: still closed", r.statusCode === 503);
  }
  env({ PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE });
  {
    const r = res(); await vipCheckout(post({}, "203.0.113.44"), r);
    t("with no VIP link it uses the shared PLAN_ questionnaire (same questionnaire)", r.statusCode === 200);
    const paidRef = log.paymongo[log.paymongo.length - 1].attributes.reference_number;
    db.plan_signups.push({ id: "row_elfb", reference_number: paidRef, product_id: ATHLEVO_VIP_PRODUCT.id, status: "paid" });
    const s2 = res(); await vipStatus(post({ ref: paidRef }, "203.0.113.44"), s2);
    t("and shows that questionnaire after payment, with no schedule link when none is set",
      s2.body.status === "paid" && s2.body.questionnaire_url === QUESTIONNAIRE && s2.body.schedule_url === null);
    db.plan_signups.pop();
  }
  env({ VIP_QUESTIONNAIRE_URL: "http://forms.example.com/insecure" });
  {
    const r = res(); await vipCheckout(post({}, "203.0.113.45"), r);
    t("a non-https VIP link keeps it closed and does not fall back to the shared one", r.statusCode === 503);
  }
  env({ VIP_QUESTIONNAIRE_URL: "   " });
  {
    const r = res(); await vipCheckout(post({}, "203.0.113.46"), r);
    t("a blank VIP link counts as not set and uses the shared one", r.statusCode === 200);
  }
  closed(); openVIP();
  {
    const r = res(); await vipCheckout({ method: "GET", headers: {} }, r);
    t("VIP checkout is POST-only", r.statusCode === 405 && r.headers.Allow === "POST");
  }

  // the checkout
  let elRef;
  {
    const r = res();
    await vipCheckout(post({ amount: 1, currency: "USD", product: "ATHLEVO_PLAN_MONTHLY", success_url: "https://evil.example" }, "203.0.113.50"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    elRef = a.reference_number;
    t("returns only a checkout URL", r.statusCode === 200 && JSON.stringify(Object.keys(r.body)) === '["checkout_url"]');
    t("amount is the server-owned ₱7,998 whatever the browser sends",
      a.line_items.length === 1 && a.line_items[0].amount === 799800 && a.line_items[0].currency === "PHP" &&
      a.line_items[0].quantity === 1 && a.line_items[0].name === "Athlevo VIP Coaching");
    t("the VIP price matches the price shown on the page",
      (() => {
        const sandbox = {}; sandbox.window = sandbox; sandbox.globalThis = sandbox;
        vm.runInNewContext(readFileSync("js/storeCatalog.js", "utf8"), sandbox);
        const shown = sandbox.AthlevoStoreCatalog.getProduct("athlevo-vip-coaching").page.price;
        return shown.amount === "₱" + (ATHLEVO_VIP_PRODUCT.priceCents / 100).toLocaleString("en-US") && /month/i.test(shown.period);
      })());
    t("same payment methods as the other offers; GCash is not offered",
      JSON.stringify(a.payment_method_types) === '["qrph","grab_pay","paymaya"]');
    t("reference number has the VIP format, never the Guided's or Coaching's", /^ATH-EL-[0-9A-F]{8,16}-[0-9A-F]{24}$/.test(elRef), elRef);
    t("tagged as the VIP product, with no Athlevo user",
      a.metadata.athlevo_product === "ATHLEVO_ELITE_MONTHLY" && !("athlevo_user_id" in a.metadata));
    t("an ordinary VIP checkout carries no discount fields",
      !("partner_code" in a.metadata) && !("discount_percent" in a.metadata) && !/discount/i.test(a.description + a.line_items[0].description));
    t("returns to the VIP page with the reference, or back on cancel",
      a.success_url === `https://programs.athlevo.org/athlevo-vip-coaching?payment=success&ref=${encodeURIComponent(elRef)}` &&
      a.cancel_url === "https://programs.athlevo.org/athlevo-vip-coaching?payment=cancelled");
  }
  env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app" });
  {
    const r = res(); await vipCheckout(post({}, "203.0.113.51"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    t("a Vercel preview returns to itself", a.success_url.startsWith("https://athlevo-git-store-x.vercel.app/athlevo-vip-coaching?payment=success"));
  }
  env({ VERCEL_ENV: undefined, VERCEL_URL: undefined });
  {
    let last;
    for (let i = 0; i < 12; i++) { last = res(); await vipCheckout(post({}, "198.51.100.97"), last); }
    t("VIP checkout creation is rate limited per visitor", last.statusCode === 429 && last.body.code === "RATE_LIMITED");
    open(); openCoaching();
    const pl = res(); await checkout(post({}, "198.51.100.97"), pl);
    const co = res(); await coachingCheckout(post({}, "198.51.100.97"), co);
    t("VIP is rate limited separately from the Guided and Coaching", pl.statusCode === 200 && co.statusCode === 200);
    closed(); closedCoaching(); openVIP();
  }

  // a discount code can't be used on VIP unless a code names it, and a bad code never opens a checkout
  {
    const before = log.paymongo.length;
    const r = res(); await vipCheckout(post({ code: "KQ7MX4RT" }, "203.0.113.52"), r);
    t("with no valid code row, a VIP checkout with a code is refused, not silently charged full price",
      r.statusCode === 400 && r.body.error === "invalid_code" && log.paymongo.length === before);
  }

  // status before payment, and the offers cannot read each other
  {
    const bad = res(); await vipStatus(post({ ref: "nonsense" }), bad);
    t("a malformed reference is rejected", bad.statusCode === 400);
    const planRef = res(); await vipStatus(post({ ref: reference }), planRef);
    t("a Guided reference is rejected by the VIP status endpoint", planRef.statusCode === 400);
    const coachingRef = res(); await vipStatus(post({ ref: "ATH-CO-1234567890A-" + "A".repeat(24) }), coachingRef);
    t("a Coaching reference is rejected by the VIP status endpoint", coachingRef.statusCode === 400);
    const elOnPlan = res(); await status(post({ ref: elRef }), elOnPlan);
    t("a VIP reference is rejected by the Guided status endpoint", elOnPlan.statusCode === 400);
    const elOnCoaching = res(); await coachingStatus(post({ ref: elRef }), elOnCoaching);
    t("a VIP reference is rejected by the Coaching status endpoint", elOnCoaching.statusCode === 400);
    const pending = res(); await vipStatus(post({ ref: elRef }), pending);
    t("before the webhook arrives it reports pending, with no links",
      pending.statusCode === 200 && pending.body.status === "pending" && !("questionnaire_url" in pending.body));
  }

  // recording is tied to the product the payment was made for
  {
    const details = {
      referenceNumber: EL_REF("G"), checkoutId: "cs_elm", paymentId: "pay_elm", amountCents: 799800, currency: "PHP",
      productId: "ATHLEVO_ELITE_MONTHLY", paidAt: new Date().toISOString(), contact: {}, eventId: "evt_elm"
    };
    const before = db.plan_signups.length;
    let threw = false;
    try { await planMod.applySignupPayment("https://db.test", "service-secret", details, "test"); } catch (error) { threw = true; }
    t("recording a VIP payment as the Guided product (the default) is refused outright", threw && db.plan_signups.length === before);
    let threwCoaching = false;
    try { await planMod.applySignupPayment("https://db.test", "service-secret", details, "test", ATHLEVO_COACHING_PRODUCT); } catch (error) { threwCoaching = true; }
    t("recording it as Coaching is refused too", threwCoaching && db.plan_signups.length === before);
    const ok = await planMod.applySignupPayment("https://db.test", "service-secret", details, "test", ATHLEVO_VIP_PRODUCT);
    t("the same payment is recorded when the matching product is given",
      ok.applied === true && db.plan_signups[db.plan_signups.length - 1].product_id === "ATHLEVO_ELITE_MONTHLY");
    db.plan_signups.pop();
  }

  // webhook
  log.tables.length = 0;
  {
    const r = await deliver(vipPaid({ reference: elRef, paymentId: "pay_el1", checkoutId: "cs_el1", id: "evt_el1" }));
    const row = db.plan_signups.find(x => x.reference_number === elRef);
    t("a signed VIP payment is accepted", r.statusCode === 200 && r.body.result.applied === true, JSON.stringify(r.body));
    t("the row carries the VIP product and the verified ₱7,998",
      row && row.product_id === "ATHLEVO_ELITE_MONTHLY" && row.amount_cents === 799800 && row.currency === "PHP" &&
      row.provider_payment_id === "pay_el1" && row.status === "paid" && row.livemode === false);
    t("contact details come from PayMongo, email normalised",
      row.customer_name === "Maria Santos" && row.customer_email === "maria@example.com");
    t("paid_through is 30 days after payment", Date.parse(row.paid_through) - Date.parse(row.paid_at) === 30 * 86400000);
    t("an ordinary VIP payment has no partner columns", !("partner_code" in row) && !("discount_percent" in row));
    t("a VIP payment touches no app subscription or Pro ledger",
      !log.tables.some(x => /subscriptions|payment_transactions|subscription_events/.test(x)), log.tables.join(","));
    const dup = await deliver(vipPaid({ reference: elRef, paymentId: "pay_el1", checkoutId: "cs_el1", id: "evt_el1b" }));
    t("the same payment delivered twice is recorded once",
      dup.statusCode === 200 && dup.body.result.duplicate === true && db.plan_signups.filter(x => x.reference_number === elRef).length === 1);
  }

  // status after payment
  openVIP();
  {
    const r = res(); await vipStatus(post({ ref: elRef }), r);
    t("paid: returns the VIP questionnaire and scheduling links, and no personal data",
      r.statusCode === 200 && r.body.status === "paid" && r.body.questionnaire_url === VIP_QUESTIONNAIRE &&
      r.body.schedule_url === VIP_SCHEDULE && !JSON.stringify(r.body).match(/maria|santos|@|\+63/i));
    const urls = log.urls.filter(u => u.includes(encodeURIComponent(elRef))).slice(-1)[0] || "";
    t("the status lookup is scoped to the VIP product", urls.includes("product_id=eq.ATHLEVO_ELITE_MONTHLY"), urls);
    const odd = EL_REF("9");
    db.plan_signups.push({ id: "row_elodd", reference_number: odd, product_id: "ATHLEVO_PLAN_MONTHLY", status: "paid" });
    const oddStatus = res(); await vipStatus(post({ ref: odd }), oddStatus);
    t("a row for another product is never shown as a VIP sign-up", oddStatus.body.status === "pending");
    db.plan_signups.pop();
  }

  // rejected payments
  {
    const before = db.plan_signups.length;
    const planPrice = await deliver(vipPaid({ reference: EL_REF("B"), amount: 299700, paymentId: "pay_el2", id: "evt_el2" }));
    t("the Guided's price on a VIP payment is rejected and not recorded", planPrice.statusCode === 400 && db.plan_signups.length === before);
    const coachingPrice = await deliver(vipPaid({ reference: EL_REF("C"), amount: 499800, paymentId: "pay_el3", id: "evt_el3" }));
    t("the Coaching price on a VIP payment is rejected too", coachingPrice.statusCode === 400 && db.plan_signups.length === before);
    const vipPriceOnPlan = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "B".repeat(24), amount: 799800, paymentId: "pay_el4", id: "evt_el4" }));
    t("the VIP price on a Guided payment is rejected", vipPriceOnPlan.statusCode === 400 && db.plan_signups.length === before);
    const vipPriceOnCoaching = await deliver(paidEvent({ reference: "ATH-CO-1234567890A-" + "B".repeat(24), productId: ATHLEVO_COACHING_PRODUCT.id, amount: 799800, paymentId: "pay_el5", id: "evt_el5" }));
    t("the VIP price on a Coaching payment is rejected", vipPriceOnCoaching.statusCode === 400 && db.plan_signups.length === before);
    const planRefOnVIP = await deliver(vipPaid({ reference: "ATH-PL-1234567890A-" + "D".repeat(24), paymentId: "pay_el6", id: "evt_el6" }));
    t("a Guided reference on a VIP payment is rejected", planRefOnVIP.statusCode === 400 && db.plan_signups.length === before);
    const vipRefOnPlan = await deliver(paidEvent({ reference: EL_REF("D"), paymentId: "pay_el7", id: "evt_el7" }));
    t("a VIP reference on a Guided payment is rejected", vipRefOnPlan.statusCode === 400 && db.plan_signups.length === before);
    const junk = await deliver(vipPaid({ reference: "ATH-EL-NOT-A-REFERENCE", paymentId: "pay_el8", id: "evt_el8" }));
    t("a malformed VIP reference is rejected", junk.statusCode === 400 && db.plan_signups.length === before);
  }

  // closing it never loses a payment in flight
  closed(); closedCoaching(); closedVIP();
  {
    const ref = EL_REF("F");
    const before = db.plan_signups.length;
    const inFlight = await deliver(vipPaid({ reference: ref, paymentId: "pay_el9", checkoutId: "cs_el9", id: "evt_el9" }));
    t("closing VIP sign-up never loses a payment already in flight",
      inFlight.statusCode === 200 && db.plan_signups.length === before + 1);
    const s3 = res(); await vipStatus(post({ ref }), s3);
    t("and the buyer can still open their confirmation", s3.statusCode === 200 && s3.body.status === "paid");
    const refunded = await deliver(refundEvent({ paymentId: "pay_el9", amount: 799800, id: "evt_el9r" }));
    t("its refund is still applied while closed",
      refunded.statusCode === 200 && refunded.body.result.applied === true &&
      db.plan_signups.find(x => x.provider_payment_id === "pay_el9").status === "refunded");
    const s4 = res(); await vipStatus(post({ ref }), s4);
    t("a refunded VIP sign-up no longer returns the next-step links", s4.body.status === "refunded" && !("questionnaire_url" in s4.body));
  }

  // partial refunds are ignored against the VIP amount
  {
    paymentAmounts.set("pay_el1", 799800);
    const partial = await deliver(refundEvent({ paymentId: "pay_el1", amount: 100000, id: "evt_el1p", type: "payment.refund.updated" }));
    t("a partial refund on a VIP payment is ignored",
      partial.statusCode === 200 && partial.body.result.ignored === true &&
      db.plan_signups.find(x => x.provider_payment_id === "pay_el1").status === "paid", JSON.stringify(partial.body));
    const full = await deliver(refundEvent({ paymentId: "pay_el1", amount: 799800, id: "evt_el1f" }));
    t("a full refund marks it refunded",
      full.statusCode === 200 && full.body.result.applied === true &&
      db.plan_signups.find(x => x.provider_payment_id === "pay_el1").status === "refunded", JSON.stringify(full.body));
  }
  open();
}

section("9c. Test keys never open a checkout on the production site");
{
  const client = await import("../lib/server/paymongoClient.js");
  t("only an sk_test_ key counts as a test key (spaces ignored, live and empty keys do not)",
    client.isTestSecretKey("sk_test_abc") && client.isTestSecretKey("  sk_test_abc  ") && client.isTestSecretKey("SK_TEST_abc") &&
    !client.isTestSecretKey("sk_live_abc") && !client.isTestSecretKey("") && !client.isTestSecretKey(null) && !client.isTestSecretKey("not a key"));
  t("blocked only on production with a test key",
    client.testKeyBlockedHere({ VERCEL_ENV: "production", PAYMONGO_SECRET_KEY: "sk_test_abc" }) === true &&
    client.testKeyBlockedHere({ VERCEL_ENV: "production", PAYMONGO_SECRET_KEY: "sk_live_abc" }) === false &&
    client.testKeyBlockedHere({ VERCEL_ENV: "preview", PAYMONGO_SECRET_KEY: "sk_test_abc" }) === false &&
    client.testKeyBlockedHere({ PAYMONGO_SECRET_KEY: "sk_test_abc" }) === false);

  const savedKey = process.env.PAYMONGO_SECRET_KEY;
  open(); openPlan(); openCoaching(); openVIP();
  const handlers = [["Plan", planCheckout], ["Guided", checkout], ["Coaching", coachingCheckout], ["VIP", vipCheckout]];

  env({ VERCEL_ENV: "production", PAYMONGO_SECRET_KEY: "sk_test_secret" });
  {
    const before = log.paymongo.length;
    const results = [];
    for (const [name, handler] of handlers) {
      const r = res(); await handler(post({}, "203.0.113.90"), r); results.push([name, r]);
      const c = res(); await handler(post({ code: "KQ7MX4RT", check: true }, "203.0.113.91"), c); results.push([name + " code check", c]);
    }
    t("production + test key: every offer's checkout and code check answer 'not open yet' and open nothing",
      results.every(([, r]) => r.statusCode === 503 && r.body.error === "Sign-up is not open yet.") && log.paymongo.length === before,
      JSON.stringify(results.map(([n, r]) => [n, r.statusCode])));
    const s = res(); await coachingStatus(post({ ref: "ATH-CO-1234567890A-" + "A".repeat(24) }, "203.0.113.92"), s);
    t("the status lookup still answers, so a buyer who already paid keeps their confirmation", s.statusCode === 200 && s.body.status === "pending");
  }
  env({ VERCEL_ENV: "production", PAYMONGO_SECRET_KEY: "sk_live_secret" });
  {
    const before = log.paymongo.length;
    const results = [];
    for (const [name, handler] of handlers) { const r = res(); await handler(post({}, "203.0.113.93"), r); results.push([name, r]); }
    t("production + live key: every offer opens its checkout",
      results.every(([, r]) => r.statusCode === 200 && r.body.checkout_url) && log.paymongo.length === before + 4);
  }
  env({ VERCEL_ENV: "preview", VERCEL_URL: "athlevo-git-store-x.vercel.app", PAYMONGO_SECRET_KEY: "sk_test_secret" });
  {
    const r = res(); await checkout(post({}, "203.0.113.94"), r);
    t("a preview deployment may still use a test key", r.statusCode === 200);
  }
  env({ VERCEL_ENV: undefined, VERCEL_URL: undefined, PAYMONGO_SECRET_KEY: savedKey });
  closed(); closedCoaching(); closedVIP();
}

section("9d. Athlevo Plan (₱999, paid once) and the settings Guided borrows");
{
  const TP_REF = (c) => "ATH-TP-1234567890A-" + c.repeat(24);
  const planPaid = (o = {}) => paidEvent({ productId: ATHLEVO_PLAN_PRODUCT.id, amount: 99900, ...o });

  // closed by default, and each switch only opens its own offer
  closed(); closedCoaching(); closedVIP();
  {
    const before = log.paymongo.length;
    const r = res(); await planCheckout(post({}, "203.0.113.120"), r);
    t("Plan checkout is unavailable until PLAN_SIGNUP_ENABLED is set", r.statusCode === 503 && log.paymongo.length === before);
    const s1 = res(); await planStatus(post({ ref: TP_REF("A") }, "203.0.113.120"), s1);
    t("Plan status still answers while closed (buyers keep their confirmation)", s1.statusCode === 200 && s1.body.status === "pending");
  }
  open();
  {
    const r = res(); await planCheckout(post({}, "203.0.113.121"), r);
    t("opening Guided does not open the Plan", r.statusCode === 503);
  }
  closed(); openPlan();
  {
    const g = res(); await checkout(post({}, "203.0.113.122"), g);
    const c = res(); await coachingCheckout(post({}, "203.0.113.122"), c);
    const v = res(); await vipCheckout(post({}, "203.0.113.122"), v);
    t("opening the Plan opens nothing else: Guided does not inherit the Plan's switch",
      g.statusCode === 503 && c.statusCode === 503 && v.statusCode === 503);
  }

  // the checkout
  let tpRef;
  {
    const r = res();
    await planCheckout(post({ amount: 1, currency: "USD", product: "ATHLEVO_PLAN_MONTHLY", success_url: "https://evil.example" }, "203.0.113.123"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    tpRef = a.reference_number;
    t("returns only a checkout URL", r.statusCode === 200 && JSON.stringify(Object.keys(r.body)) === '["checkout_url"]');
    t("amount is the server-owned ₱999 whatever the browser sends, and it is not described as monthly",
      a.line_items.length === 1 && a.line_items[0].amount === 99900 && a.line_items[0].currency === "PHP" &&
      a.line_items[0].quantity === 1 && a.line_items[0].name === "Athlevo Plan" &&
      a.line_items[0].description === "Athlevo Plan — one-time" && !/month/i.test(JSON.stringify(a)));
    t("the Plan price matches the price shown on the page, and the page shows no monthly period",
      (() => {
        const sandbox = {}; sandbox.window = sandbox; sandbox.globalThis = sandbox;
        vm.runInNewContext(readFileSync("js/storeCatalog.js", "utf8"), sandbox);
        const shown = sandbox.AthlevoStoreCatalog.getProduct("athlevo-plan").page.price;
        return shown.amount === "₱" + (ATHLEVO_PLAN_PRODUCT.priceCents / 100).toLocaleString("en-US") && shown.period === "";
      })());
    t("reference number has the Plan format (TP), never Guided's (PL)",
      /^ATH-TP-[0-9A-F]{8,16}-[0-9A-F]{24}$/.test(tpRef) && !/^ATH-PL-/.test(tpRef), tpRef);
    t("tagged as the Plan product with its own id, not Guided's",
      a.metadata.athlevo_product === "ATHLEVO_TRAINING_PLAN" && ATHLEVO_PLAN_PRODUCT.id !== ATHLEVO_GUIDED_PRODUCT.id);
    t("returns to the Plan page with the reference, or back on cancel",
      a.success_url === `https://programs.athlevo.org/athlevo-plan?payment=success&ref=${encodeURIComponent(tpRef)}` &&
      a.cancel_url === "https://programs.athlevo.org/athlevo-plan?payment=cancelled");
  }

  // the status endpoints cannot read each other's sign-ups
  {
    const guidedRef = "ATH-PL-1234567890A-" + "A".repeat(24);
    const g = res(); await planStatus(post({ ref: guidedRef }), g);
    t("a Guided reference is rejected by the Plan status endpoint", g.statusCode === 400);
    const p = res(); await status(post({ ref: tpRef }), p);
    t("a Plan reference is rejected by the Guided status endpoint", p.statusCode === 400);
    const pending = res(); await planStatus(post({ ref: tpRef }), pending);
    t("before the webhook arrives it reports pending, with no links",
      pending.statusCode === 200 && pending.body.status === "pending" && !("questionnaire_url" in pending.body));
  }

  // recording is tied to the product the payment was made for
  {
    const details = {
      referenceNumber: TP_REF("G"), checkoutId: "cs_tpmm", paymentId: "pay_tpmm", amountCents: 99900, currency: "PHP",
      productId: "ATHLEVO_TRAINING_PLAN", paidAt: new Date().toISOString(), contact: {}, eventId: "evt_tpmm"
    };
    const before = db.plan_signups.length;
    let threw = false;
    try { await planMod.applySignupPayment("https://db.test", "service-secret", details, "test", ATHLEVO_GUIDED_PRODUCT); } catch (error) { threw = true; }
    t("recording a Plan payment as the Guided product is refused outright", threw && db.plan_signups.length === before);
  }

  // webhook
  log.tables.length = 0;
  {
    const r = await deliver(planPaid({ reference: tpRef, paymentId: "pay_tp1", checkoutId: "cs_tp1", id: "evt_tp1" }));
    const row = db.plan_signups.find(x => x.reference_number === tpRef);
    t("a signed Plan payment is accepted", r.statusCode === 200 && r.body.result.applied === true, JSON.stringify(r.body));
    t("the row carries the Plan product and the verified ₱999",
      row && row.product_id === "ATHLEVO_TRAINING_PLAN" && row.amount_cents === 99900 && row.currency === "PHP" &&
      row.provider_payment_id === "pay_tp1" && row.status === "paid" && row.livemode === false);
    t("the table still gets its 30-day paid_through", Date.parse(row.paid_through) - Date.parse(row.paid_at) === 30 * 86400000);
    t("a Plan payment touches no app subscription or Pro ledger",
      !log.tables.some(x => /subscriptions|payment_transactions|subscription_events/.test(x)), log.tables.join(","));
    const dup = await deliver(planPaid({ reference: tpRef, paymentId: "pay_tp1", checkoutId: "cs_tp1", id: "evt_tp1b" }));
    t("the same payment delivered twice is recorded once",
      dup.statusCode === 200 && dup.body.result.duplicate === true && db.plan_signups.filter(x => x.reference_number === tpRef).length === 1);
  }

  // status after payment: the Plan has no call, so it never hands out a scheduling link
  {
    env({ PLAN_SCHEDULE_URL: SCHEDULE, PLAN_AGREEMENT_URL: "https://docs.example.com/plan-agreement" });
    const r = res(); await planStatus(post({ ref: tpRef }), r);
    t("paid: the questionnaire and agreement links, and never a scheduling link even when PLAN_SCHEDULE_URL is set",
      r.statusCode === 200 && r.body.status === "paid" && r.body.questionnaire_url === PLAN_QUESTIONNAIRE &&
      r.body.agreement_url === "https://docs.example.com/plan-agreement" && r.body.schedule_url === null &&
      !JSON.stringify(r.body).match(/maria|santos|@|\+63/i));
    const urls = log.urls.filter(u => u.includes(encodeURIComponent(tpRef))).slice(-1)[0] || "";
    t("the status lookup is scoped to the Plan product", urls.includes("product_id=eq.ATHLEVO_TRAINING_PLAN"), urls);
    env({ PLAN_SCHEDULE_URL: undefined, PLAN_AGREEMENT_URL: undefined });
  }

  // rejected payments
  {
    const before = db.plan_signups.length;
    const guidedPrice = await deliver(planPaid({ reference: TP_REF("B"), amount: 299700, paymentId: "pay_tp2", id: "evt_tp2" }));
    t("Guided's price on a Plan payment is rejected and not recorded", guidedPrice.statusCode === 400 && db.plan_signups.length === before);
    const planPriceOnGuided = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "B".repeat(24), amount: 99900, paymentId: "pay_tp3", id: "evt_tp3" }));
    t("the Plan's price on a Guided payment is rejected too", planPriceOnGuided.statusCode === 400 && db.plan_signups.length === before);
    const oldPrice = await deliver(paidEvent({ reference: "ATH-PL-1234567890A-" + "C".repeat(24), amount: 199800, paymentId: "pay_tp4", id: "evt_tp4" }));
    t("a Guided checkout opened at the old ₱1,998 price is rejected, so it can never be recorded at the wrong price",
      oldPrice.statusCode === 400 && db.plan_signups.length === before);
    const guidedRefOnPlan = await deliver(planPaid({ reference: "ATH-PL-1234567890A-" + "D".repeat(24), paymentId: "pay_tp5", id: "evt_tp5" }));
    t("a Guided reference on a Plan payment is rejected", guidedRefOnPlan.statusCode === 400 && db.plan_signups.length === before);
    const planRefOnGuided = await deliver(paidEvent({ reference: TP_REF("E"), paymentId: "pay_tp6", id: "evt_tp6" }));
    t("a Plan reference on a Guided payment is rejected", planRefOnGuided.statusCode === 400 && db.plan_signups.length === before);
    const junk = await deliver(planPaid({ reference: "ATH-TP-NOT-A-REFERENCE", paymentId: "pay_tp7", id: "evt_tp7" }));
    t("a malformed Plan reference is rejected", junk.statusCode === 400 && db.plan_signups.length === before);
  }

  // closing it never loses a payment in flight, and a refund still applies
  closed();
  {
    const ref = TP_REF("F");
    const before = db.plan_signups.length;
    const inFlight = await deliver(planPaid({ reference: ref, paymentId: "pay_tp8", checkoutId: "cs_tp8", id: "evt_tp8" }));
    t("closing Plan sign-up never loses a payment already in flight", inFlight.statusCode === 200 && db.plan_signups.length === before + 1);
    const refunded = await deliver(refundEvent({ paymentId: "pay_tp8", amount: 99900, id: "evt_tp8r" }));
    t("its refund is still applied while closed",
      refunded.statusCode === 200 && refunded.body.result.applied === true &&
      db.plan_signups.find(x => x.provider_payment_id === "pay_tp8").status === "refunded");
  }

  // Guided is the old Plan: it borrows the PLAN_* questionnaire, scheduling and agreement links, but never the switch
  {
    const AGREEMENT = "https://docs.example.com/plan-agreement";
    closed();
    env({ GUIDED_SIGNUP_ENABLED: "true", PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE, PLAN_SCHEDULE_URL: SCHEDULE, PLAN_AGREEMENT_URL: AGREEMENT });
    t("Guided with only PLAN_* links set uses all three, and has a call",
      JSON.stringify(planMod.guidedNextSteps(process.env)) ===
        JSON.stringify({ questionnaireUrl: QUESTIONNAIRE, scheduleUrl: SCHEDULE, agreementUrl: AGREEMENT, call: true }));
    t("so the links already set for the old Plan keep working: Guided is open", planMod.guidedSignupEnabled(process.env) === true);
    const gRef = (() => { const x = "ATH-PL-1234567890A-" + "9".repeat(24); db.plan_signups.push({ id: "row_g9", reference_number: x, product_id: ATHLEVO_GUIDED_PRODUCT.id, status: "paid" }); return x; })();
    const gs = res(); await status(post({ ref: gRef }), gs);
    db.plan_signups.pop();
    t("and the confirmation shows them", gs.body.questionnaire_url === QUESTIONNAIRE && gs.body.schedule_url === SCHEDULE && gs.body.agreement_url === AGREEMENT);
    env({ GUIDED_QUESTIONNAIRE_URL: "https://forms.example.com/guided-own", GUIDED_SCHEDULE_URL: "https://cal.example.com/guided-own", GUIDED_AGREEMENT_URL: "https://docs.example.com/guided-own" });
    const own = planMod.guidedNextSteps(process.env);
    t("Guided's own links win over the PLAN_* ones when set",
      own.questionnaireUrl === "https://forms.example.com/guided-own" && own.scheduleUrl === "https://cal.example.com/guided-own" &&
      own.agreementUrl === "https://docs.example.com/guided-own");
    env({ GUIDED_QUESTIONNAIRE_URL: "http://insecure.example.com/q" });
    t("a non-https Guided link keeps it closed and does not fall back to the PLAN_ one", planMod.guidedSignupEnabled(process.env) === false);
    env({ GUIDED_QUESTIONNAIRE_URL: undefined, GUIDED_SCHEDULE_URL: undefined, GUIDED_AGREEMENT_URL: undefined });
    const co = planMod.coachingNextSteps({ COACHING_SIGNUP_ENABLED: "true", PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE, PLAN_SCHEDULE_URL: SCHEDULE, PLAN_AGREEMENT_URL: AGREEMENT });
    const vp = planMod.vipNextSteps({ VIP_SIGNUP_ENABLED: "true", PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE, PLAN_SCHEDULE_URL: SCHEDULE, PLAN_AGREEMENT_URL: AGREEMENT });
    t("Coaching and VIP borrow only the questionnaire, never the scheduling or agreement links",
      co.questionnaireUrl === QUESTIONNAIRE && co.scheduleUrl === null && co.agreementUrl === null &&
      vp.questionnaireUrl === QUESTIONNAIRE && vp.scheduleUrl === null && vp.agreementUrl === null);
    const pl = planMod.planNextSteps({ PLAN_SIGNUP_ENABLED: "true", PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE, PLAN_SCHEDULE_URL: SCHEDULE });
    t("the Plan has no call, so it never has a scheduling link", pl.call === false && pl.scheduleUrl === null && pl.questionnaireUrl === QUESTIONNAIRE);
    closed();
  }

  // the emails: the Plan says a coach builds the plan and that it is one-time; Guided still says "schedule a call"
  {
    env({ RESEND_API_KEY: "re_test_key", SIGNUP_ALERT_EMAIL: "dean@athlevo.example", SIGNUP_FROM_EMAIL: undefined,
      ATHLEVO_INVITE_FROM_EMAIL: undefined, SIGNUP_REPLY_TO_EMAIL: undefined });
    openPlan(); open();
    log.emails.length = 0;
    await deliver(planPaid({ reference: TP_REF("8"), paymentId: "pay_tp9", checkoutId: "cs_tp9", id: "evt_tp9" }));
    const buyer = log.emails.find(e => e.body.to.join(",").includes("maria@example.com"));
    const owner = log.emails.find(e => e.body.to.join(",").includes("dean@athlevo.example"));
    t("the Plan's buyer email: questionnaire, then 'your coach builds your plan'; no call; says it is one-time",
      buyer && buyer.body.subject === "Welcome to Athlevo Plan: your next steps" &&
      buyer.body.text.includes("₱999") && buyer.body.text.includes(PLAN_QUESTIONNAIRE) &&
      buyer.body.text.includes("2. Your coach builds your plan.") && !/schedule your call|scheduled to schedule|schedule a call/i.test(buyer.body.text + buyer.body.html) &&
      buyer.body.text.includes("This is a one-time payment and nothing renews automatically.") &&
      !/covers one month/i.test(buyer.body.text + buyer.body.html), buyer && buyer.body.text);
    t("the Plan's owner alert says one-time and shows no paid-through date",
      owner && owner.body.text.includes("Offer: Athlevo Plan (one-time)") && !/Paid through/.test(owner.body.text) &&
      owner.body.text.includes("Amount: ₱999"), owner && owner.body.text);
    log.emails.length = 0;
    const gRef2 = "ATH-PL-FEEDFACE09-" + "9".repeat(24);
    await deliver(paidEvent({ reference: gRef2, paymentId: "pay_gd9", checkoutId: "cs_gd9", id: "evt_gd9" }));
    const gBuyer = log.emails.find(e => e.body.to.join(",").includes("maria@example.com"));
    const gOwner = log.emails.find(e => e.body.to.join(",").includes("dean@athlevo.example"));
    t("Guided's buyer email still has the call step and the one-month wording",
      gBuyer && gBuyer.body.subject === "Welcome to Athlevo Guided: your next steps" && gBuyer.body.text.includes("₱2,997") &&
      gBuyer.body.text.includes("2. Schedule your call.") && gBuyer.body.text.includes("Your payment covers one month and does not renew automatically.") &&
      !/one-time/i.test(gBuyer.body.text), gBuyer && gBuyer.body.text);
    t("Guided's owner alert shows the month and the paid-through date",
      gOwner && gOwner.body.text.includes("Offer: Athlevo Guided (1 month)") && /Paid through/.test(gOwner.body.text), gOwner && gOwner.body.text);
    env({ RESEND_API_KEY: undefined, SIGNUP_ALERT_EMAIL: undefined });
  }
  closed(); closedCoaching(); closedVIP();
}

section("10. Wiring");
{
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  const rewrite = (src) => (vercel.rewrites.find(r => r.source === src) || {}).destination;
  const OFFER_KEYS = ["plan", "guided", "coaching", "vip"];
  t("public API paths rewrite to the existing gateway (no new serverless function)",
    OFFER_KEYS.every(k => rewrite(`/api/${k}-signup/checkout`) === `/api/providers?action=${k}_signup_checkout` &&
      rewrite(`/api/${k}-signup/status`) === `/api/providers?action=${k}_signup_status`));
  t("the old Elite Coaching API paths are gone", !rewrite("/api/elite-signup/checkout") && !rewrite("/api/elite-signup/status"));
  const router = readFileSync("api/providers/index.js", "utf8");
  t("the gateway dispatches both actions of every offer",
    OFFER_KEYS.every(k => new RegExp(`action === "${k}_signup_checkout"`).test(router) && new RegExp(`action === "${k}_signup_status"`).test(router)));
  const pairs = OFFER_KEYS.flatMap(k => [[`${k}_signup_checkout`, `${k}SignupCheckoutHandler`], [`${k}_signup_status`, `${k}SignupStatusHandler`]]);
  t("each gateway action calls its own offer's handler (no copy-paste crossover)",
    pairs.every(([action, fn]) => new RegExp(`action === "${action}"\\) \\{\\s*return ${fn}\\(request, response\\);`).test(router)));
  const limits = readFileSync("lib/server/rateLimit.js", "utf8");
  t("each offer has its own rate-limit scopes",
    OFFER_KEYS.every(k => [`${k}-signup`, `${k}-signup-status`, `${k}-signup-code`].every(scope => limits.includes(`"${scope}": {`))) &&
    !limits.includes('"elite-signup'));
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
    PLAN_AGREEMENT_URL: undefined, COACHING_AGREEMENT_URL: undefined, VIP_AGREEMENT_URL: undefined
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
    t("a new Guided payment sends exactly two emails: the buyer's and the owner's",
      r.statusCode === 200 && log.emails.length === 2 && buyer && owner && buyer !== owner);
    t("the buyer's email goes only to the buyer, with the Guided subject and the default sender",
      buyer.body.to.length === 1 && buyer.body.to[0] === "maria@example.com" &&
      buyer.body.subject === "Welcome to Athlevo Guided: your next steps" &&
      buyer.body.from === "Athlevo <noreply@athlevo.org>" && buyer.body.reply_to === "support@athlevo.org");
    t("requests carry the Resend key and a per-email idempotency key built from the reference",
      buyer.headers.Authorization === "Bearer re_test_key" &&
      buyer.headers["Idempotency-Key"] === `signup-buyer-${ref2}` && owner.headers["Idempotency-Key"] === `signup-owner-${ref2}`);
    t("the buyer's email carries the price, reference, questionnaire and scheduling links",
      [buyer.body.html, buyer.body.text].every(x =>
        x.includes("₱2,997") && x.includes(ref2) && x.includes(QUESTIONNAIRE) && x.includes(SCHEDULE)) &&
      buyer.body.text.startsWith("Hi Maria,"));
    t("it links back to the confirmation page for that reference",
      buyer.body.text.includes(`https://programs.athlevo.org/athlevo-guided?payment=success&ref=${ref2}`) &&
      buyer.body.html.includes(`https://programs.athlevo.org/athlevo-guided?payment=success&amp;ref=${ref2}`));
    t("it makes no weekly promise, says it does not renew automatically, and has no agreement link when none is set",
      !/weekly/i.test(buyer.body.text + buyer.body.html) && /does not renew automatically/.test(buyer.body.text) &&
      !/agreement/i.test(buyer.body.text));
    t("it does not repeat the buyer's phone number or any coach's name",
      !/\+63917/.test(buyer.body.html + buyer.body.text) && !/Dean|Christian|Louie/.test(buyer.body.html + buyer.body.text));
    t("the owner's alert goes to every configured recipient in one message",
      owner.body.to.join(",") === "dean@athlevo.example,ops@athlevo.example");
    t("the alert is marked TEST for a test-mode payment and names offer, amount and buyer",
      owner.body.subject === "[TEST] New Athlevo Guided sign-up: ₱2,997 — Maria Santos" &&
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

  // Coaching: its own links, its own agreement, never the Guided's.
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
      all.includes("https://programs.athlevo.org/athlevo-coaching?payment=success"));
    t("it never shows the Guided's questionnaire, scheduling or agreement link",
      !all.includes(QUESTIONNAIRE + "\"") && !all.includes(SCHEDULE) && !all.includes("plan-agreement"));
    t("it shows the Coaching agreement link when one is set",
      all.includes("https://docs.example.com/coaching-agreement") && /Read the Athlevo agreement/.test(buyer.body.html));
    t("the alert names Athlevo Coaching and its price",
      owner.body.subject === "[TEST] New Athlevo Coaching sign-up: ₱4,998 — Maria Santos");
  }
  log.emails.length = 0;

  // Athlevo VIP Coaching: its own subject, price, links and agreement.
  env({ VIP_AGREEMENT_URL: "https://docs.example.com/vip-agreement" });
  openVIP();
  log.emails.length = 0;
  const refVIP = "ATH-EL-FEEDFACE01-" + "E".repeat(24);
  {
    await deliver(paidEvent({ reference: refVIP, productId: ATHLEVO_VIP_PRODUCT.id, amount: 799800, paymentId: "pay_e4el", checkoutId: "cs_e4el", id: "evt_e4el" }));
    const buyer = byTo("maria@example.com")[0];
    const owner = byTo("dean@athlevo.example")[0];
    const all = buyer.body.html + buyer.body.text;
    t("a VIP payment emails the VIP subject, price and links",
      buyer.body.subject === "Welcome to Athlevo VIP Coaching: your next steps" && all.includes("₱7,998") &&
      all.includes(VIP_QUESTIONNAIRE) && all.includes(VIP_SCHEDULE) && all.includes(refVIP) &&
      all.includes("https://programs.athlevo.org/athlevo-vip-coaching?payment=success"));
    t("it never shows the Guided's or Coaching's links",
      !all.includes(QUESTIONNAIRE + "\"") && !all.includes(SCHEDULE) && !all.includes(COACHING_QUESTIONNAIRE) &&
      !all.includes(COACHING_SCHEDULE) && !all.includes("plan-agreement") && !all.includes("coaching-agreement"));
    t("it shows the VIP agreement link when one is set", all.includes("https://docs.example.com/vip-agreement"));
    t("the alert names Athlevo VIP Coaching and its price", owner.body.subject === "[TEST] New Athlevo VIP Coaching sign-up: ₱7,998 — Maria Santos");
  }
  closedVIP();
  env({ VIP_AGREEMENT_URL: undefined });
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: planRef("4"), paymentId: "pay_e4", checkoutId: "cs_e4", id: "evt_e4" }));
    const all = byTo("maria@example.com")[0].body;
    t("a Guided email shows the Guided agreement link and not the Coaching one",
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

  // Coaching borrows the shared PLAN_ questionnaire when it has none of its own, as the page does.
  mailEnv();
  env({ COACHING_QUESTIONNAIRE_URL: undefined, PLAN_QUESTIONNAIRE_URL: QUESTIONNAIRE });
  log.emails.length = 0;
  {
    await deliver(paidEvent({ reference: coRef("5"), productId: ATHLEVO_COACHING_PRODUCT.id, amount: 499800, paymentId: "pay_e5", checkoutId: "cs_e5", id: "evt_e5" }));
    const buyer = byTo("maria@example.com")[0];
    t("Coaching without its own questionnaire link emails the shared PLAN_ one, matching the confirmation page",
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
      /No email address came through/.test(log.emails[0].body.text) && !/\[TEST\] New Athlevo Guided sign-up: .* —/.test(log.emails[0].body.subject));
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
    buyerConfirmationEmail({ product: ATHLEVO_GUIDED_PRODUCT, details: { contact: { email: "x@y.com" }, referenceNumber: "R" }, steps: { questionnaireUrl: null } }) === null &&
    buyerConfirmationEmail({ product: ATHLEVO_GUIDED_PRODUCT, details: { contact: { email: "nope" }, referenceNumber: "R" }, steps: { questionnaireUrl: QUESTIONNAIRE } }) === null);

  // Only the store branch notifies; Pro is untouched; nothing new under api/.
  const endpoint = readFileSync("lib/server/paymongoWebhookEndpoint.js", "utf8");
  const storeBranch = endpoint.slice(endpoint.indexOf("if (storePaid) {"), endpoint.indexOf("const paid = extractPaidCheckout(envelope);"));
  t("the webhook notifies only inside the store branch, after the payment is recorded",
    /applySignupPayment\(/.test(storeBranch) && /notifySignup\(/.test(storeBranch) &&
    storeBranch.indexOf("applySignupPayment(") < storeBranch.indexOf("notifySignup(") &&
    (endpoint.match(/notifySignup\(/g) || []).length === 1);
}

// ---- 11b. a refused payment is loud ---------------------------------------------
section("11b. A payment the server refuses is loud, not silent");
{
  const { rejectedPaymentAlertEmail } = await import("../lib/server/signupNotifications.js");
  const MAIL = {
    RESEND_API_KEY: "re_test_key", SIGNUP_ALERT_EMAIL: "dean@athlevo.example",
    SIGNUP_FROM_EMAIL: undefined, ATHLEVO_INVITE_FROM_EMAIL: undefined, SIGNUP_REPLY_TO_EMAIL: undefined
  };
  env(MAIL);
  resendMode = "ok";
  const ownerAlerts = () => log.emails.filter(e => e.body.to.includes("dean@athlevo.example")).map(e => e.body);
  const logged = [];
  const realError = console.error;
  const quietly = async (fn) => { console.error = (...args) => { logged.push(args.join(" ")); }; try { return await fn(); } finally { console.error = realError; } };
  const before = db.plan_signups.length;
  log.emails.length = 0;

  // A buyer who opened a ₱1,998 Plan checkout before the change and pays after it.
  const oldRef = "ATH-PL-FEEDFACE05-" + "B".repeat(24);
  const oldPrice = await quietly(() => deliver(paidEvent({ reference: oldRef, productId: ATHLEVO_GUIDED_PRODUCT.id, amount: 199800, paymentId: "pay_old1", checkoutId: "cs_old1", id: "evt_old1" })));
  t("a payment at the old ₱1,998 price is still refused with 400 and nothing is recorded",
    oldPrice.statusCode === 400 && oldPrice.body.error === "Payment validation failed." && db.plan_signups.length === before);
  t("the refusal is written to the server log with the reason, reference, payment id and amount",
    logged.some(l => /payment NOT recorded \(wrong_amount\)/.test(l) && l.includes(oldRef) && l.includes("pay_old1") && l.includes("amount_cents=199800")));
  t("the log line carries no buyer name, email or phone", logged.every(l => !/Maria|Example\.com|\+63917/i.test(l)));
  const alerts = ownerAlerts();
  t("the owner is emailed once that a payment was received but not recorded, and the buyer is not emailed",
    alerts.length === 1 && log.emails.length === 1 && /Payment received but NOT recorded/.test(alerts[0].subject) && alerts[0].subject.includes("₱1,998") &&
    /wrong_amount/.test(alerts[0].text) && alerts[0].text.includes(oldRef) && alerts[0].text.includes("pay_old1") && alerts[0].text.includes("cs_old1") &&
    /PayMongo dashboard/.test(alerts[0].text) && !log.emails.some(e => e.body.to.includes("maria@example.com")));
  t("the alert's idempotency key is the payment id, so PayMongo's retries cannot send a dozen emails",
    log.emails[0].headers["Idempotency-Key"] === "signup-rejected-pay_old1");
  t("a TEST payment is labelled as such in the alert",
    /^\[TEST\] Payment received but NOT recorded/.test(alerts[0].subject) && /TEST payment/.test(alerts[0].text));

  // The alert never stops the answer, and a mail outage changes nothing.
  resendMode = "throw"; log.emails.length = 0;
  const outage = await quietly(() => deliver(paidEvent({ reference: oldRef, productId: ATHLEVO_GUIDED_PRODUCT.id, amount: 199800, paymentId: "pay_old2", checkoutId: "cs_old2", id: "evt_old2" })));
  t("with the mail service down the answer is the same 400 and nothing is recorded", outage.statusCode === 400 && db.plan_signups.length === before);
  resendMode = "ok";
  env({ RESEND_API_KEY: undefined, SIGNUP_ALERT_EMAIL: undefined }); log.emails.length = 0;
  const unconfigured = await quietly(() => deliver(paidEvent({ reference: oldRef, productId: ATHLEVO_GUIDED_PRODUCT.id, amount: 199800, paymentId: "pay_old3", checkoutId: "cs_old3", id: "evt_old3" })));
  t("with no mail configured the answer is the same 400, nothing is sent, and the log line is still written",
    unconfigured.statusCode === 400 && log.emails.length === 0 && logged.some(l => l.includes("pay_old3")));
  env(MAIL);

  // A payment that is fine is untouched by all of this.
  log.emails.length = 0; logged.length = 0;
  const good = await quietly(() => deliver(paidEvent({ reference: "ATH-PL-FEEDFACE05-" + "C".repeat(24), productId: ATHLEVO_GUIDED_PRODUCT.id, amount: 299700, paymentId: "pay_ok1", checkoutId: "cs_ok1", id: "evt_ok1" })));
  t("a payment at the current price is recorded as before, with no refusal logged and no 'not recorded' email",
    good.statusCode === 200 && good.body.result.applied === true && logged.length === 0 &&
    !log.emails.some(e => /NOT recorded/.test(e.body.subject)));

  // The email builder.
  const base = { reason: "bad_reference", recipients: ["dean@athlevo.example"],
    details: { amountCents: 99900, productId: "ATHLEVO_TRAINING_PLAN", referenceNumber: "ATH-TP-<b>x</b>", paymentId: "pay_x", checkoutId: "cs_x", livemode: true,
      contact: { name: "<script>alert(1)</script>", email: "not-an-email", phone: "" } } };
  const built = rejectedPaymentAlertEmail(base);
  t("the alert escapes everything the payer controls and says 'not provided' for what is missing or invalid",
    built && !/<script>/.test(built.html) && !/<b>x<\/b>/.test(built.html) && /&lt;script&gt;/.test(built.html) &&
    /Email: not provided/.test(built.text) && /Phone: not provided/.test(built.text) && built.subject === "Payment received but NOT recorded: ₱999");
  t("with no recipient or no payment there is nothing to send",
    rejectedPaymentAlertEmail({ ...base, recipients: [] }) === null && rejectedPaymentAlertEmail({ ...base, details: null }) === null);
  t("every reason the validator can give has a plain-language line in the alert",
    ["wrong_amount", "bad_discount", "bad_reference", "wrong_product", "wrong_currency", "missing_transaction_reference", "unsupported_event"]
      .every(reason => !/failed the server's checks/.test(rejectedPaymentAlertEmail({ ...base, reason }).text)));
  env({ RESEND_API_KEY: undefined, SIGNUP_ALERT_EMAIL: undefined });
  log.emails.length = 0;
}

// ---- 11c. a closed offer says why, and the product is never defaulted -------------
section("11c. Closed offers explain themselves; no payment is checked against a default offer");
{
  env({ GUIDED_SIGNUP_ENABLED: undefined, VIP_SIGNUP_ENABLED: undefined, ELITE_SIGNUP_ENABLED: "true", ELITE_SCHEDULE_URL: "https://example.com/elite-call" });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  const g = res(), v = res();
  try {
    await checkout(post({}, "198.51.100.150"), g);
    await vipCheckout(post({}, "198.51.100.151"), v);
  } finally { console.warn = realWarn; }
  t("a checkout on a closed offer still answers 'not open yet' and opens nothing", g.statusCode === 503 && v.statusCode === 503 && g.body.error === "Sign-up is not open yet.");
  t("the server log names the offer and the switch that is off",
    warnings.some(w => w.includes("Athlevo Guided is closed") && w.includes("GUIDED_SIGNUP_ENABLED=true")) &&
    warnings.some(w => w.includes("Athlevo VIP Coaching is closed") && w.includes("VIP_SIGNUP_ENABLED=true")));
  t("and when an old ELITE_* setting is still present it says those were renamed VIP_* and are ignored",
    warnings.some(w => w.includes("Athlevo VIP Coaching") && /ELITE_\* settings are still present/.test(w)) &&
    !warnings.some(w => w.includes("Athlevo Guided") && /ELITE_/.test(w)));
  t("an old ELITE_* switch does not open VIP Coaching", planMod.vipSignupEnabled() === false);
  env({ ELITE_SIGNUP_ENABLED: undefined, ELITE_SCHEDULE_URL: undefined });

  const good = { productId: ATHLEVO_GUIDED_PRODUCT.id, amountCents: 299700, currency: "PHP", checkoutId: "cs_d", paymentId: "pay_d",
    referenceNumber: "ATH-PL-FEEDFACE06-" + "D".repeat(24), partnerCode: null, discountPercent: null };
  t("validating a payment without naming the offer refuses it instead of assuming the new Plan",
    planMod.validateSignupPayment(good) === "wrong_product" && planMod.validateSignupPayment(good, null) === "wrong_product" &&
    planMod.validateSignupPayment(good, ATHLEVO_GUIDED_PRODUCT) === null);
  let threw = false;
  try { await planMod.applySignupPayment("https://db.test", "service-secret", good, "test"); } catch (error) { threw = true; }
  t("recording a payment without naming the offer throws and writes nothing", threw);
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
    PLAN_AGREEMENT_URL: undefined, COACHING_AGREEMENT_URL: undefined, VIP_AGREEMENT_URL: undefined
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
    pc.discountedCents(299700, 10) === 269730 && pc.discountedCents(499800, 10) === 449820 &&
    pc.discountedCents(299700, 15) === 254745 && pc.discountedCents(1001, 50) === 501 && pc.discountedCents(299700, 100) === 0);
  t("only whole percentages from 1 to 50 are valid",
    [1, 10, 50].every(pc.validDiscountPercent) && [0, -5, 51, 10.5, NaN, null, undefined, "10"].every(v => !pc.validDiscountPercent(v)));

  // Checking a code (no checkout is opened).
  const sessions = () => log.paymongo.length;
  {
    const before = sessions();
    const r = res(); await checkout(post({ code: " kq7m-x4rt ", check: true }, "198.51.100.10"), r);
    t("checking a Guided code answers the discounted price and opens no checkout",
      r.statusCode === 200 && r.body.valid === true && r.body.percent_off === 10 &&
      r.body.price_cents === 269730 && r.body.list_price_cents === 299700 && sessions() === before);
    t("the answer never names the partner or the batch",
      !JSON.stringify(r.body).toLowerCase().includes("acme") && !JSON.stringify(r.body).includes(BATCH));
    const c = res(); await coachingCheckout(post({ code: ALL, check: true }, "198.51.100.11"), c);
    t("the same code gives the Coaching price too (₱4,498.20 off ₱4,998)",
      c.statusCode === 200 && c.body.price_cents === 449820 && c.body.list_price_cents === 499800);
    const w = res(); await checkout(post({ code: TWENTY, check: true }, "198.51.100.12"), w);
    t("the percentage comes from the code's row: a 20% code takes 20% off",
      w.body.percent_off === 20 && w.body.price_cents === 239760);
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

  // Athlevo VIP Coaching: a code with no product list never reaches it. Only a code that names it does.
  openVIP();
  const VIP_ONLY = "XM6D4GHK", ALL_THREE = "TR9V2CNP";
  db.partner_codes.push(
    { code: VIP_ONLY, partner: BATCH, percent_off: 10, product_ids: [ATHLEVO_VIP_PRODUCT.id], active: true, expires_at: null },
    { code: ALL_THREE, partner: BATCH, percent_off: 10, product_ids: [ATHLEVO_GUIDED_PRODUCT.id, ATHLEVO_COACHING_PRODUCT.id, ATHLEVO_VIP_PRODUCT.id], active: true, expires_at: null }
  );
  {
    const before = sessions();
    const refused = [];
    for (const code of [ALL, COACH_ONLY, TWENTY]) {
      const r = res(); await vipCheckout(post({ code, check: true }, "198.51.100.61"), r); refused.push(r);
    }
    t("a code with no product list (or an empty one), or one for another offer, is not valid on VIP",
      refused.every(r => r.statusCode === 400 && r.body.error === "invalid_code" && r.body.message === "That code isn't valid.") && sessions() === before);
    const plan = res(); await checkout(post({ code: VIP_ONLY, check: true }, "198.51.100.62"), plan);
    const coaching = res(); await coachingCheckout(post({ code: VIP_ONLY, check: true }, "198.51.100.62"), coaching);
    t("a code that names only VIP is not valid on the Guided or Coaching",
      plan.statusCode === 400 && coaching.statusCode === 400 && plan.body.error === "invalid_code");
    const ok = res(); await vipCheckout(post({ code: " xm6d-4ghk ", check: true }, "198.51.100.63"), ok);
    t("a code that names VIP checks out at ₱7,198.20 off ₱7,998, with no checkout opened",
      ok.statusCode === 200 && ok.body.valid === true && ok.body.percent_off === 10 &&
      ok.body.price_cents === 719820 && ok.body.list_price_cents === 799800 && sessions() === before &&
      !JSON.stringify(ok.body).toLowerCase().includes("acme"));
    const prices = [];
    for (const [handler, ip] of [[checkout, "198.51.100.64"], [coachingCheckout, "198.51.100.65"], [vipCheckout, "198.51.100.66"]]) {
      const r = res(); await handler(post({ code: ALL_THREE, check: true }, ip), r); prices.push(r.body.price_cents);
    }
    t("a code that lists all three offers works on each, at that offer's own price", JSON.stringify(prices) === "[269730,449820,719820]", JSON.stringify(prices));
  }
  // The ₱999 Athlevo Plan: a code with no product list never reaches it either. Only a code that names it does.
  // And a code made before the rename that names ATHLEVO_PLAN_MONTHLY still works, on Guided (the offer that used to be the Plan).
  closed(); openPlan(); open();
  const PLAN_ONLY = "FP4K7WNC", OLD_PLAN_LIST = "GH8M3TQV";
  db.partner_codes.push(
    { code: PLAN_ONLY, partner: BATCH, percent_off: 10, product_ids: [ATHLEVO_PLAN_PRODUCT.id], active: true, expires_at: null },
    { code: OLD_PLAN_LIST, partner: BATCH, percent_off: 10, product_ids: ["ATHLEVO_PLAN_MONTHLY"], active: true, expires_at: null }
  );
  {
    const before = sessions();
    const refused = [];
    for (const code of [ALL, COACH_ONLY, OLD_PLAN_LIST]) {
      const r = res(); await planCheckout(post({ code, check: true }, "198.51.100.67"), r); refused.push(r);
    }
    t("a code with no product list, or one made for Guided or Coaching, is not valid on the ₱999 Plan",
      refused.every(r => r.statusCode === 400 && r.body.error === "invalid_code" && r.body.message === "That code isn't valid.") && sessions() === before);
    const ok = res(); await planCheckout(post({ code: " fp4k-7wnc ", check: true }, "198.51.100.68"), ok);
    t("a code that names the Plan checks out at ₱899.10 off ₱999, with no checkout opened",
      ok.statusCode === 200 && ok.body.valid === true && ok.body.price_cents === 89910 && ok.body.list_price_cents === 99900 && sessions() === before);
    const wrongWay = res(); await checkout(post({ code: PLAN_ONLY, check: true }, "198.51.100.69"), wrongWay);
    t("a code that names only the Plan is not valid on Guided", wrongWay.statusCode === 400 && wrongWay.body.error === "invalid_code");
    const guided = res(); await checkout(post({ code: OLD_PLAN_LIST, check: true }, "198.51.100.70"), guided);
    t("a code made for 'the Plan' before the rename (it names ATHLEVO_PLAN_MONTHLY) works on Guided, at Guided's price",
      guided.statusCode === 200 && guided.body.price_cents === 269730 && guided.body.list_price_cents === 299700);
    const paid = res(); await planCheckout(post({ code: PLAN_ONLY }, "198.51.100.71"), paid);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    t("a coded Plan checkout is priced by the server and says it is one-time",
      paid.statusCode === 200 && a.line_items[0].amount === 89910 && a.metadata.list_price_cents === "99900" &&
      a.metadata.athlevo_product === "ATHLEVO_TRAINING_PLAN" && /10% discount applied/.test(a.description) && /one-time/.test(a.description));
    const okPay = await deliver(paidEvent({ reference: a.reference_number, productId: ATHLEVO_PLAN_PRODUCT.id, amount: 89910, partnerCode: PLAN_ONLY, discountPercent: 10, paymentId: "pay_tpc1", checkoutId: "cs_tpc1", id: "evt_tpc1" }));
    t("and the webhook accepts exactly that amount for the Plan", okPay.statusCode === 200 && okPay.body.result.applied === true);
    const badPay = await deliver(paidEvent({ reference: "ATH-TP-1234567890A-" + "A".repeat(24), productId: ATHLEVO_PLAN_PRODUCT.id, amount: 99900, partnerCode: PLAN_ONLY, discountPercent: 10, paymentId: "pay_tpc2", id: "evt_tpc2" }));
    t("the Plan's full price with a code on it is rejected", badPay.statusCode === 400);
  }
  env({ PLAN_SIGNUP_ENABLED: undefined, PLAN_QUESTIONNAIRE_URL: undefined });

  let vipCodedRef;
  {
    const before = sessions();
    const bad = res(); await vipCheckout(post({ code: ALL }, "198.51.100.67"), bad);
    t("a VIP checkout with a code that does not cover VIP opens nothing (never silently full price)",
      bad.statusCode === 400 && bad.body.error === "invalid_code" && sessions() === before);
    const r = res(); await vipCheckout(post({ code: VIP_ONLY, percent: 90, amount: 1, price_cents: 1 }, "198.51.100.68"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    vipCodedRef = a.reference_number;
    t("a coded VIP checkout is priced by the server: ₱7,198.20, whatever the browser claims",
      r.statusCode === 200 && sessions() === before + 1 && JSON.stringify(Object.keys(r.body)) === '["checkout_url"]' &&
      a.line_items.length === 1 && a.line_items[0].amount === 719820 && a.line_items[0].name === "Athlevo VIP Coaching");
    t("the VIP session records the code, the percentage and the list price for the webhook to check",
      a.metadata.partner_code === VIP_ONLY && a.metadata.discount_percent === "10" && a.metadata.list_price_cents === "799800" &&
      a.metadata.athlevo_product === "ATHLEVO_ELITE_MONTHLY" && /^ATH-EL-/.test(vipCodedRef) &&
      /10% discount applied/.test(a.description) && !JSON.stringify(a).toLowerCase().includes("acme"));
  }
  {
    log.emails.length = 0;
    const r = await deliver(paidEvent({ reference: vipCodedRef, productId: ATHLEVO_VIP_PRODUCT.id, amount: 719820,
      partnerCode: VIP_ONLY, discountPercent: 10, paymentId: "pay_ed1", checkoutId: "cs_ed1", id: "evt_ed1" }));
    const row = rowFor("pay_ed1");
    t("a VIP payment of exactly the discounted price is recorded with the code and the list price",
      r.statusCode === 200 && r.body.result.applied === true && row && row.product_id === "ATHLEVO_ELITE_MONTHLY" &&
      row.amount_cents === 719820 && row.partner_code === VIP_ONLY && row.list_price_cents === 799800 && row.discount_percent === 10);
    const owner = log.emails.map(e => e.body).find(m => m.to.includes("dean@athlevo.example"));
    t("the owner's alert shows the VIP price and discount",
      owner && owner.subject.includes("Athlevo VIP Coaching") && owner.subject.includes("₱7,198.20") &&
      owner.text.includes("Discount: 10% off the ₱7,998 price"), owner && owner.subject);
    const before = db.plan_signups.length;
    const wrong = {};
    wrong.fullPriceWithCode = await deliver(paidEvent({ reference: ref("EL", 40), productId: ATHLEVO_VIP_PRODUCT.id, amount: 799800, partnerCode: VIP_ONLY, discountPercent: 10, paymentId: "pay_ew1", id: "evt_ew1" }));
    wrong.discountWithoutCode = await deliver(paidEvent({ reference: ref("EL", 41), productId: ATHLEVO_VIP_PRODUCT.id, amount: 719820, paymentId: "pay_ew2", id: "evt_ew2" }));
    wrong.coachingDiscountOnVIP = await deliver(paidEvent({ reference: ref("EL", 42), productId: ATHLEVO_VIP_PRODUCT.id, amount: 449820, partnerCode: VIP_ONLY, discountPercent: 10, paymentId: "pay_ew3", id: "evt_ew3" }));
    wrong.mismatchedPercent = await deliver(paidEvent({ reference: ref("EL", 43), productId: ATHLEVO_VIP_PRODUCT.id, amount: 719820, partnerCode: VIP_ONLY, discountPercent: 20, paymentId: "pay_ew4", id: "evt_ew4" }));
    t("every other VIP amount or half-filled discount is refused and nothing is recorded",
      Object.values(wrong).every(x => x.statusCode === 400 && x.body.error === "Payment validation failed.") && db.plan_signups.length === before,
      JSON.stringify(Object.entries(wrong).map(([k, v]) => [k, v.statusCode, v.body && v.body.error])));
    log.emails.length = 0;
  }
  closedVIP();

  // Starting a checkout with a code.
  let discountedRef;
  {
    const before = sessions();
    const r = res();
    await checkout(post({ code: ALL, percent: 90, amount: 1, price_cents: 1, discount: 99 }, "198.51.100.20"), r);
    const a = log.paymongo[log.paymongo.length - 1].attributes;
    discountedRef = a.reference_number;
    t("a coded checkout is priced by the server: ₱2,697.30, whatever the browser claims",
      r.statusCode === 200 && sessions() === before + 1 && JSON.stringify(Object.keys(r.body)) === '["checkout_url"]' &&
      a.line_items[0].amount === 269730 && a.line_items.length === 1 && a.line_items[0].quantity === 1);
    t("the session records the code, the percentage and the list price for the webhook to check",
      a.metadata.partner_code === ALL && a.metadata.discount_percent === "10" && a.metadata.list_price_cents === "299700" &&
      a.metadata.athlevo_product === "ATHLEVO_PLAN_MONTHLY");
    t("PayMongo shows that a discount was applied, and the line item name is unchanged",
      /10% discount applied/.test(a.description) && /10% discount applied/.test(a.line_items[0].description) && a.line_items[0].name === "Athlevo Guided");
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
    t("a code that is not text is ignored: the normal full-price checkout", numeric.statusCode === 200 && na.line_items[0].amount === 299700 && !("partner_code" in na.metadata));
    const none = res(); await checkout(post({}, "198.51.100.24"), none);
    const noneAttrs = log.paymongo[log.paymongo.length - 1].attributes;
    t("with no code the checkout is exactly as before", none.statusCode === 200 && noneAttrs.line_items[0].amount === 299700 &&
      JSON.stringify(Object.keys(noneAttrs.metadata)) === '["athlevo_product","athlevo_source"]' && noneAttrs.description === "Athlevo Guided — 1 month");
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
    const r = await deliver(paidEvent({ reference: discountedRef, amount: 269730, partnerCode: ALL, discountPercent: 10, paymentId: "pay_d1", id: "evt_d1" }));
    const row = rowFor("pay_d1");
    t("a payment of exactly the discounted price is recorded, with the code and the partner label",
      r.statusCode === 200 && r.body.result.applied === true && row && row.amount_cents === 269730 &&
      row.partner_code === ALL && row.partner === BATCH && row.list_price_cents === 299700 && row.discount_percent === 10);
    t("the sign-up row's metadata also carries the code, and shows no sharing flag the first time",
      row.metadata.partner_code === ALL && row.metadata.discount_percent === 10 && !("code_email_mismatch" in row.metadata), JSON.stringify(row.metadata));
    const owner = msgs().find(m => m.to.includes("dean@athlevo.example"));
    const buyer = msgs().find(m => m.to.includes("maria@example.com"));
    t("the owner's alert shows what was paid, the discount, the code and the partner batch",
      owner && owner.subject.includes("₱2,697.30") && owner.subject.endsWith(` · ${BATCH}`) &&
      owner.text.includes("Discount: 10% off the ₱2,997 price") && owner.text.includes("Discount code: KQ7M-X4RT") &&
      owner.text.includes(`Partner batch: ${BATCH}`) && owner.text.includes("Amount: ₱2,697.30") && !/may have been shared/.test(owner.text));
    t("the buyer's email shows the amount paid and the discount, and never names the partner",
      buyer && buyer.text.includes("Your payment of ₱2,697.30 is confirmed.") && buyer.text.includes("Your discount code took 10% off. Use the same code (KQ7M-X4RT) again when you renew to keep the discount.") &&
      buyer.html.includes("₱2,697.30") && !(buyer.subject + buyer.text + buyer.html).toLowerCase().includes("acme") &&
      !(buyer.subject + buyer.text + buyer.html).includes(BATCH));
    const dup = await deliver(paidEvent({ reference: discountedRef, amount: 269730, partnerCode: ALL, discountPercent: 10, paymentId: "pay_d1", id: "evt_d1" }));
    t("a redelivered discounted event is a duplicate: nothing new is recorded or sent",
      dup.statusCode === 200 && dup.body.result.duplicate === true && db.plan_signups.filter(x => x.provider_payment_id === "pay_d1").length === 1 && msgs().length === 2);
  }
  {
    // Month two: the same runner pays again with the same code. The discount applies again.
    log.emails.length = 0;
    const r = await deliver(paidEvent({ reference: ref("PL", 2), amount: 269730, partnerCode: ALL, discountPercent: 10,
      paymentId: "pay_d2", id: "evt_d2", paidAt: 1762600000 }));
    const row = rowFor("pay_d2");
    const owner = msgs().find(m => m.to.includes("dean@athlevo.example"));
    t("a renewal with the same code from the same email is discounted again and is not flagged",
      r.statusCode === 200 && r.body.result.applied === true && row.partner_code === ALL && !("code_email_mismatch" in row.metadata) &&
      owner && !/may have been shared/.test(owner.text) && r.body.result.partner.mismatch === false);
    // A different person pays with the same code: still accepted (they already paid), but flagged.
    log.emails.length = 0;
    const s2 = await deliver(paidEvent({ reference: ref("PL", 3), amount: 269730, partnerCode: ALL, discountPercent: 10,
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
    wrong.fullPriceWithCode = await deliver(paidEvent({ reference: ref("PL", 4), amount: 299700, partnerCode: ALL, discountPercent: 10, paymentId: "pay_w1", id: "evt_w1" }));
    wrong.discountWithoutCode = await deliver(paidEvent({ reference: ref("PL", 5), amount: 269730, paymentId: "pay_w2", id: "evt_w2" }));
    wrong.codeWithoutPercent = await deliver(paidEvent({ reference: ref("PL", 6), amount: 269730, partnerCode: ALL, paymentId: "pay_w3", id: "evt_w3" }));
    wrong.percentWithoutCode = await deliver(paidEvent({ reference: ref("PL", 7), amount: 269730, discountPercent: 10, paymentId: "pay_w4", id: "evt_w4" }));
    wrong.over50 = await deliver(paidEvent({ reference: ref("PL", 8), amount: 99900, partnerCode: ALL, discountPercent: 51, paymentId: "pay_w5", id: "evt_w5" }));
    wrong.notANumber = await deliver(paidEvent({ reference: ref("PL", 9), amount: 269730, partnerCode: ALL, discountPercent: "abc", paymentId: "pay_w6", id: "evt_w6" }));
    wrong.badCode = await deliver(paidEvent({ reference: ref("PL", 10), amount: 269730, partnerCode: "KQ7MX4R0", discountPercent: 10, paymentId: "pay_w7", id: "evt_w7" }));
    wrong.mismatchedPercent = await deliver(paidEvent({ reference: ref("PL", 11), amount: 269730, partnerCode: ALL, discountPercent: 20, paymentId: "pay_w8", id: "evt_w8" }));
    wrong.coachingAtPlanDiscount = await deliver(paidEvent({ reference: ref("CO", 12), productId: ATHLEVO_COACHING_PRODUCT.id, amount: 269730, partnerCode: ALL, discountPercent: 10, paymentId: "pay_w9", id: "evt_w9" }));
    t("every other amount or half-filled discount is refused with a 400 and nothing is recorded",
      Object.values(wrong).every(r => r.statusCode === 400 && r.body.error === "Payment validation failed.") && db.plan_signups.length === before,
      JSON.stringify(Object.entries(wrong).map(([k, v]) => [k, v.statusCode, v.body && v.body.error])));
    const u = (details, product) => planMod.validateSignupPayment(details, product);
    const base = { amountCents: 269730, currency: "PHP", productId: ATHLEVO_GUIDED_PRODUCT.id, checkoutId: "cs", paymentId: "p",
      referenceNumber: ref("PL", 13), partnerCode: ALL, discountPercent: 10 };
    t("validation names the reason: ok, bad_discount, wrong_amount",
      u(base, ATHLEVO_GUIDED_PRODUCT) === null && u({ ...base, partnerCode: null }, ATHLEVO_GUIDED_PRODUCT) === "bad_discount" &&
      u({ ...base, amountCents: 299700 }, ATHLEVO_GUIDED_PRODUCT) === "wrong_amount" &&
      u({ ...base, partnerCode: undefined, discountPercent: undefined }, ATHLEVO_GUIDED_PRODUCT) === "wrong_amount",
      JSON.stringify([u(base, ATHLEVO_GUIDED_PRODUCT), u({ ...base, partnerCode: null }, ATHLEVO_GUIDED_PRODUCT), u({ ...base, amountCents: 299700 }, ATHLEVO_GUIDED_PRODUCT), u({ ...base, partnerCode: undefined, discountPercent: undefined }, ATHLEVO_GUIDED_PRODUCT)]));
  }
  {
    // Coaching renewal and refund of a discounted payment.
    log.emails.length = 0;
    const r = await deliver(paidEvent({ reference: ref("CO", 14), productId: ATHLEVO_COACHING_PRODUCT.id, amount: 449820,
      partnerCode: COACH_ONLY, discountPercent: 10, paymentId: "pay_c1", id: "evt_c1" }));
    const row = rowFor("pay_c1");
    t("a discounted Coaching payment (₱4,498.20) is recorded under the Coaching product",
      r.statusCode === 200 && row.product_id === ATHLEVO_COACHING_PRODUCT.id && row.amount_cents === 449820 && row.list_price_cents === 499800 && row.partner === BATCH, JSON.stringify([r.statusCode, r.body, row]));
    paymentAmounts.set("pay_d1", 269730);
    const refund = await deliver(refundEvent({ paymentId: "pay_d1", amount: 269730, id: "evt_rd1" }));
    t("a full refund of a discounted payment is recognised against the amount actually paid",
      refund.statusCode === 200 && rowFor("pay_d1").status === "refunded");
  }
  {
    // Before the migration adds the columns, a coded payment is still kept (in metadata).
    extraColumnsMissing = true;
    const r = await deliver(paidEvent({ reference: ref("PL", 15), amount: 269730, partnerCode: ALL, discountPercent: 10, paymentId: "pay_x1", id: "evt_x1" }));
    extraColumnsMissing = false;
    const row = rowFor("pay_x1");
    t("if the new columns are missing, the payment is still recorded with the code in metadata",
      r.statusCode === 200 && r.body.result.applied === true && row && !("partner_code" in row) && row.metadata.partner_code === ALL && row.amount_cents === 269730, JSON.stringify([r.statusCode, r.body, row]));
  }
  t("an ordinary payment's row has no partner columns at all",
    !("partner_code" in rowFor("pay_e2")) && !("partner" in rowFor("pay_e2")) && !("discount_percent" in rowFor("pay_e2")));
  t("the owner's alert for an ordinary payment is unchanged (no discount rows)",
    !/Discount/.test(ownerAlertEmail({ product: ATHLEVO_GUIDED_PRODUCT, details: { amountCents: 299700, contact: {}, referenceNumber: "R" }, recipients: ["a@b.com"] }).text));

  // The code generator.
  {
    const codes = gen.generateCodes(1000);
    t("the generator makes 1000 distinct, valid codes", new Set(codes).size === 1000 && codes.every(c => pc.normalizePartnerCode(c) === c));
    let n = 0;
    const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
    const forced = gen.generateCodes(2, () => seq[n++ % seq.length]);
    t("a repeated code is thrown away, never written twice", forced.length === 2 && forced[0] !== forced[1]);
    const o = gen.parseOptions(["--partner", "acme-2026-11-24", "--count", "50", "--expires", "2026-12-31", "--products", "guided,coaching"]);
    t("options: defaults to 10%, both products means 'every product', expiry is the end of that day in Philippine time",
      o.percent === 10 && o.productIds === null && o.expiresAt === "2026-12-31T23:59:59+08:00" && o.count === 50 && o.out === "partner-codes");
    t("options: leaving --products out means the default scope (Guided and Coaching), stored as no list",
      gen.parseOptions(["--partner", "x", "--count", "1"]).productIds === null);
    t("options: VIP is only ever included when it is named",
      JSON.stringify(gen.parseOptions(["--partner", "x", "--count", "1", "--products", "vip"]).productIds) === '["ATHLEVO_ELITE_MONTHLY"]' &&
      JSON.stringify(gen.parseOptions(["--partner", "x", "--count", "1", "--products", "guided,coaching,vip"]).productIds) ===
        '["ATHLEVO_PLAN_MONTHLY","ATHLEVO_COACHING_MONTHLY","ATHLEVO_ELITE_MONTHLY"]' &&
      gen.parseOptions(["--partner", "x", "--count", "1", "--products", "coaching,guided"]).productIds === null &&
      JSON.stringify(gen.parseOptions(["--partner", "x", "--count", "1", "--products", "elite"]).productIds) === '["ATHLEVO_ELITE_MONTHLY"]');
    t("options: the ₱999 Athlevo Plan is only ever included when it is named, as training-plan",
      JSON.stringify(gen.parseOptions(["--partner", "x", "--count", "1", "--products", "training-plan"]).productIds) === '["ATHLEVO_TRAINING_PLAN"]' &&
      JSON.stringify(gen.parseOptions(["--partner", "x", "--count", "1", "--products", "training-plan,guided,coaching"]).productIds) ===
        '["ATHLEVO_TRAINING_PLAN","ATHLEVO_PLAN_MONTHLY","ATHLEVO_COACHING_MONTHLY"]');
    t("options: the old name 'plan' is refused, with a message that points to guided and training-plan, so an old command cannot quietly make codes for a different offer",
      ["plan", "plan,coaching", "plan,guided,coaching"].every(list => {
        try { gen.parseOptions(["--partner", "x", "--count", "1", "--products", list]); return false; }
        catch (e) { return /guided/.test(e.message) && /training-plan/.test(e.message); }
      }));
    t("options: one product, a custom percent",
      JSON.stringify(gen.parseOptions(["--partner", "x", "--count", "1", "--products", "coaching", "--percent", "15"]).productIds) === '["ATHLEVO_COACHING_MONTHLY"]');
    const bad = [
      [], ["--partner", "Bad Label", "--count", "1"], ["--partner", "x'; drop table", "--count", "1"], ["--partner", "x"],
      ["--partner", "x", "--count", "0"], ["--partner", "x", "--count", "1001"], ["--partner", "x", "--count", "1.5"],
      ["--partner", "x", "--count", "1", "--percent", "0"], ["--partner", "x", "--count", "1", "--percent", "51"],
      ["--partner", "x", "--count", "1", "--expires", "31-12-2026"], ["--partner", "x", "--count", "1", "--expires", "2026-13-40"],
      ["--partner", "x", "--count", "1", "--products", "all"], ["--partner", "x", "--count", "1", "--products", "hybrid"],
      ["--partner", "x", "--count", "1", "--products", ""], ["--partner", "x", "--count", "1", "--bogus", "1"], ["stray"]
    ];
    t("options: every malformed input is refused", bad.every(argv => { try { gen.parseOptions(argv); return false; } catch (e) { return true; } }));
    const sql = gen.buildSql(["KQ7MX4RT", "HT3N8WZC"], gen.parseOptions(["--partner", "acme-test", "--count", "2", "--note", "it's a test", "--products", "guided"]));
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
