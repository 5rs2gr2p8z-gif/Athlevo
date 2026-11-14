/*
 * Sub-1 10k Challenge (/virtual-run): the server. Runs the REAL handlers against an in-memory
 * Supabase (with PostgREST-style filters), a fake PayMongo client and Resend.
 *
 *   1  closed by default, and what each missing piece does
 *   2  validation (and that the browser's price is never read)
 *   3  registration: pending row, server price, checkout request, limits, failures
 *   4  confirmation status (no personal data before payment)
 *   5  the webhook: verified, idempotent, never marks paid on a wrong amount
 *   6  refunds and the store sign-ups still working
 *   7  the staff admin: who gets in, filters, CSV
 *   8  the gateway wiring
 *
 * Run: node tests/virtual-run-server.test.mjs
 */
import crypto from "node:crypto";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
process.env.RESEND_API_KEY = "re_test_secret";
process.env.SIGNUP_ALERT_EMAIL = "owner@example.com";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test";
process.env.PAYMONGO_SECRET_KEY = "sk_test_abc";
delete process.env.VERCEL_ENV;
delete process.env.VIRTUAL_RUN_SIGNUP_ENABLED;

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (title) => console.log(`\n── ${title}`);

// ---- in-memory Supabase + Resend ---------------------------------------------

const db = { virtual_run_registrations: [], plan_signups: [], rates: new Map() };
const log = { emails: [], requests: [] };
let dbMode = "ok"; // "ok" | "down" (500) | "missing" (404) | "reject" (400) | "throw"

function evalCond(row, column, expression) {
  const dot = expression.indexOf(".");
  const op = expression.slice(0, dot), arg = expression.slice(dot + 1);
  const value = row[column];
  if (op === "eq") return String(value) === arg;
  if (op === "neq") return String(value) !== arg;
  if (op === "in") return arg.slice(1, -1).split(",").includes(String(value));
  if (op === "gt") return value != null && Date.parse(value) > Date.parse(arg);
  if (op === "ilike") {
    const pattern = arg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`, "i").test(String(value == null ? "" : value));
  }
  throw new Error(`mock does not know operator ${op}`);
}
function splitTop(text) {
  const parts = []; let depth = 0, current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}
function evalOr(row, text) {
  return splitTop(text.slice(1, -1)).some((item) => {
    if (item.startsWith("and(")) return splitTop(item.slice(4, -1)).every((c) => evalCond(row, c.slice(0, c.indexOf(".")), c.slice(c.indexOf(".") + 1)));
    return evalCond(row, item.slice(0, item.indexOf(".")), item.slice(item.indexOf(".") + 1));
  });
}
function matches(row, params) {
  for (const [key, value] of params.entries()) {
    if (["select", "limit", "order", "offset"].includes(key)) continue;
    if (key === "or") { if (!evalOr(row, value)) return false; continue; }
    if (!evalCond(row, key, value)) return false;
  }
  return true;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
  if (url.host === "api.resend.com") {
    log.emails.push({ headers: init.headers, body: JSON.parse(init.body) });
    return json({ id: `em_${log.emails.length}` });
  }
  if (url.host !== "db.test") return json({}, 404);
  const table = url.pathname.replace("/rest/v1/", "");
  const params = url.searchParams;
  log.requests.push(`${method} ${table}`);
  const prefer = String((init.headers && init.headers.Prefer) || "");

  if (table === "ai_anon_rate_limits") {
    const key = `${params.get("client_key")}|${params.get("endpoint")}|${params.get("window_start")}`.replace(/eq\./g, "");
    if (method === "GET") { const c = db.rates.get(key); return json(c ? [{ request_count: c }] : []); }
    const body = JSON.parse(init.body);
    db.rates.set(`${body.client_key}|${body.endpoint}|${body.window_start}`, body.request_count);
    return new Response("", { status: 201 });
  }
  if (table === "plan_signups") {
    if (method === "POST") {
      const row = JSON.parse(init.body);
      if (db.plan_signups.some((r) => r.reference_number === row.reference_number)) return json([], 201);
      db.plan_signups.push(row);
      return json([row], 201);
    }
    return json(db.plan_signups.filter((r) => matches(r, params)));
  }
  if (table !== "virtual_run_registrations") return json([]);
  if (dbMode === "throw") throw new TypeError("network down");
  if (dbMode === "down") return json({ message: "boom service-secret" }, 500);
  if (dbMode === "missing") return json({ code: "PGRST205", message: "Could not find the table" }, 404);
  if (dbMode === "reject") return json({ code: "42703", message: "column does not exist" }, 400);

  const rows = db.virtual_run_registrations;
  if (method === "POST") {
    const row = JSON.parse(init.body);
    if (rows.some((r) => r.registration_id === row.registration_id || r.reference_number === row.reference_number)) return json({ code: "23505" }, 409);
    const now = new Date().toISOString();
    rows.push({ id: crypto.randomUUID(), livemode: false, result_status: "not_submitted", metadata: {}, created_at: now, updated_at: now, ...row });
    return new Response(null, { status: 201 });
  }
  if (method === "PATCH") {
    const patch = JSON.parse(init.body);
    const hit = rows.filter((r) => matches(r, params));
    for (const r of hit) {
      if (patch.provider_payment_id && rows.some((o) => o !== r && o.provider_payment_id === patch.provider_payment_id)) return json({ code: "23505" }, 409);
      Object.assign(r, patch);
    }
    return prefer.includes("return=representation") ? json(hit) : new Response(null, { status: 204 });
  }
  let hit = rows.filter((r) => matches(r, params));
  const total = hit.length;
  if (/^created_at\.desc/.test(params.get("order") || "")) hit = hit.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const offset = Number(params.get("offset")) || 0;
  if (offset) hit = hit.slice(offset);
  // Like Supabase, one request never returns more than 1000 rows, whatever limit was asked for.
  const limit = Math.min(1000, Number(params.get("limit")) || 1000);
  hit = hit.slice(0, limit);
  const headers = prefer.includes("count=exact") ? { "content-range": `${hit.length ? `0-${hit.length - 1}` : "*"}/${total}` } : {};
  return json(hit, 200, headers);
};

const errors = [];
const warnings = [];
console.error = (...args) => { errors.push(args.map(String).join(" ")); };
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
console.info = () => {};

function res() {
  return {
    statusCode: 200, body: null, headers: {}, sent: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
    send(v) { this.sent = v; return this; }
  };
}

// ---- modules and fixtures ------------------------------------------------------

const content = await import("../content/virtualRun.mjs");
const server = await import("../lib/server/virtualRun.js");
const payments = await import("../lib/server/virtualRunPayments.js");
const admin = await import("../lib/server/virtualRunAdmin.js");
const { default: webhook } = await import("../lib/server/paymongoWebhookEndpoint.js");
const { AI_LIMITS } = await import("../lib/server/rateLimit.js");

const NOW = new Date("2026-11-20T04:00:00Z");
// A config that is fully ready to sell. The shipped one is closed on purpose (section 1 checks that).
const READY = {
  ...content,
  EVENT: { ...content.EVENT, datesConfirmed: true },
  REGISTRATION: { ...content.REGISTRATION, deadline: "2026-11-30T23:59:00+08:00", opensAt: null, limit: null },
  LEGAL: { ...content.LEGAL, version: "2026-11-a", rulesUrl: "/virtual-run/rules", waiverUrl: "https://athlevo.org/virtual-run/waiver" },
  DELIVERY: { ...content.DELIVERY, confirmed: true, coverage: "Philippines" }
};
const OPEN_ENV = {
  VIRTUAL_RUN_SIGNUP_ENABLED: "true", SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  PAYMONGO_SECRET_KEY: "sk_test_abc", PAYMONGO_WEBHOOK_SECRET: "whsec_test", RESEND_API_KEY: "re_test_secret",
  SIGNUP_ALERT_EMAIL: "owner@example.com"
};
const setEnv = (values) => { Object.entries(values).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); };

const DIGITAL = {
  fullName: "Maria Santos", email: "Maria@Example.com", mobile: "0917 123 4567", dob: "1992-04-18", gender: "",
  pb5k: "24:30", pb10k: "", frequency: "3", goal: "sub-60", packageId: "digital", agreeRules: true, agreePrivacy: true,
  contact_website: ""
};
const SHIPPING = {
  shirtSize: "M", recipient: "Maria Santos", address: "12 Rizal St., Unit 4", province: "Pampanga", city: "Floridablanca",
  barangay: "San Nicolas", postal: "2006"
};
const KIT = { ...DIGITAL, packageId: "finisher-kit", ...SHIPPING };

let ipCounter = 1;
const nextIp = () => `203.0.113.${ipCounter++}`;
const post = (body, ip = nextIp()) => ({ method: "POST", headers: { "x-forwarded-for": ip }, body });
const get = (query = {}, headers = {}) => ({ method: "GET", headers, query });

const checkouts = [];
let paymongoMode = "ok";
const fakePaymongo = {
  async createCheckoutSession(attributes) {
    checkouts.push(attributes);
    if (paymongoMode === "fail") throw new Error("PayMongo API 500");
    return { id: `cs_test_${checkouts.length}`, checkoutUrl: `https://checkout.paymongo.com/cs_test_${checkouts.length}` };
  }
};

function reset() {
  db.virtual_run_registrations.length = 0; db.plan_signups.length = 0; db.rates.clear();
  log.emails.length = 0; log.requests.length = 0; checkouts.length = 0; errors.length = 0; warnings.length = 0;
  dbMode = "ok"; paymongoMode = "ok";
  setEnv(OPEN_ENV);
}
const register = (body, opts = {}) => {
  const r = res();
  return server.registerHandler(post(body), r, { env: process.env, now: NOW, cfg: READY, paymongo: fakePaymongo, ...opts }).then(() => r);
};

// ---- 1. closed by default -----------------------------------------------------
section("1. Closed by default");
reset();
{
  const shipped = server.registrationGate({ env: process.env, now: NOW });
  t("the shipped config is closed even with every service set (dates, deadline, rules and waiver are unset)",
    shipped.open === false && shipped.state === "not_open" && shipped.reasons.length >= 4, shipped.reasons.join("; "));
  const avail = res();
  await server.availabilityHandler(get(), avail, { env: process.env, now: NOW });
  t("availability says not_open and closes every package", avail.body.state === "not_open" &&
    avail.body.packages.length === 3 && avail.body.packages.every((p) => p.status === "closed"));
  t("availability carries no personal data and may be cached at the edge",
    !/@|email|mobile/i.test(JSON.stringify(avail.body)) && /s-maxage/.test(avail.headers["Cache-Control"]));
  const r = res();
  await server.registerHandler(post(DIGITAL), r, { env: process.env, now: NOW, paymongo: fakePaymongo });
  t("registering is refused with 503 and saves nothing", r.statusCode === 503 && r.body.error === "not_open" &&
    db.virtual_run_registrations.length === 0 && checkouts.length === 0);

  t("the ready config opens with every service set", server.registrationGate({ env: process.env, now: NOW, cfg: READY }).open === true);
  const pieces = [
    ["the switch", () => setEnv({ VIRTUAL_RUN_SIGNUP_ENABLED: undefined })],
    ["the database URL", () => setEnv({ SUPABASE_URL: undefined })],
    ["the database key", () => setEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined })],
    ["the PayMongo key", () => setEnv({ PAYMONGO_SECRET_KEY: undefined })],
    ["the PayMongo webhook secret (a payment could never be confirmed)", () => setEnv({ PAYMONGO_WEBHOOK_SECRET: undefined })]
  ];
  for (const [label, remove] of pieces) {
    reset(); remove();
    t(`without ${label} registration is closed`, server.registrationGate({ env: process.env, now: NOW, cfg: READY }).open === false);
  }
  reset();
  const closedCfg = [
    ["confirmed dates", { ...READY, EVENT: { ...READY.EVENT, datesConfirmed: false } }],
    ["a registration deadline", { ...READY, REGISTRATION: { ...READY.REGISTRATION, deadline: null } }],
    ["the event rules link", { ...READY, LEGAL: { ...READY.LEGAL, rulesUrl: null } }],
    ["the waiver link", { ...READY, LEGAL: { ...READY.LEGAL, waiverUrl: null } }],
    ["a safe rules link (not http)", { ...READY, LEGAL: { ...READY.LEGAL, rulesUrl: "http://example.com/rules" } }]
  ];
  for (const [label, cfg] of closedCfg) {
    t(`without ${label} registration is closed`, server.registrationGate({ env: process.env, now: NOW, cfg }).open === false);
  }
  const strict = [
    ["a deadline that is only a date (no time or zone)", { ...READY, REGISTRATION: { ...READY.REGISTRATION, deadline: "2026-11-30" } }],
    ["a deadline that is not a date at all", { ...READY, REGISTRATION: { ...READY.REGISTRATION, deadline: "end of November" } }],
    ["an opening time that is not a date", { ...READY, REGISTRATION: { ...READY.REGISTRATION, opensAt: "soon" } }],
    ["a recorded version of the rules and waiver wording", { ...READY, LEGAL: { ...READY.LEGAL, version: "unpublished" } }],
    ["any version of the rules and waiver wording", { ...READY, LEGAL: { ...READY.LEGAL, version: "" } }]
  ];
  for (const [label, cfg] of strict) {
    t(`with ${label} registration is closed, not open for ever`, server.registrationGate({ env: process.env, now: NOW, cfg }).open === false);
  }
  t("a deadline with a time and zone is accepted", server.registrationGate({ env: process.env, now: NOW, cfg: READY }).open === true);
  t("a test PayMongo key on the production site closes registration (its QR codes are real money)",
    server.registrationGate({ env: { ...process.env, VERCEL_ENV: "production" }, now: NOW, cfg: READY }).open === false);
  t("a live key on production is fine", server.registrationGate({
    env: { ...process.env, VERCEL_ENV: "production", PAYMONGO_SECRET_KEY: "sk_live_abc" }, now: NOW, cfg: READY }).open === true);
  t("after the deadline the state is closed", server.registrationGate({ env: process.env, now: new Date("2026-12-01T00:00:00Z"), cfg: READY }).state === "closed");
  t("before the opening time the state is not_open", server.registrationGate({
    env: process.env, now: NOW, cfg: { ...READY, REGISTRATION: { ...READY.REGISTRATION, opensAt: "2026-11-25T09:00:00+08:00" } } }).state === "not_open");
  const late = res();
  await server.registerHandler(post(DIGITAL), late, { env: process.env, now: new Date("2026-12-02T00:00:00Z"), cfg: READY, paymongo: fakePaymongo });
  t("a late registration is answered closed and saves nothing", late.statusCode === 503 && late.body.error === "closed" && db.virtual_run_registrations.length === 0);
}

// ---- 2. validation ------------------------------------------------------------
section("2. Validation");
{
  const v = (body, cfg = READY) => server.validateRegistration(body, { now: NOW, cfg });
  const good = v(DIGITAL);
  t("a complete Digital Challenge registration is accepted", good.ok === true);
  t("values are cleaned: email lower-cased, mobile digits only, blank gender and PB become null",
    good.value.email === "maria@example.com" && good.value.mobile === "09171234567" && good.value.gender === null &&
    good.value.pb_10k === null && good.value.pb_5k === "24:30");
  t("the Digital Challenge keeps no delivery details even when some are sent",
    v({ ...DIGITAL, ...SHIPPING }).value.shipping === null);
  t("a physical package needs and keeps its delivery details", v(KIT).ok === true && v(KIT).value.shipping.postal === "2006");
  const bad = v({});
  t("an empty body names every required field", bad.ok === false &&
    ["fullName", "email", "mobile", "dob", "frequency", "goal", "package", "rules", "privacy"].every((f) => bad.fields[f]));
  t("a physical package with no delivery details names each one", (() => {
    const r = v({ ...DIGITAL, packageId: "finisher-kit" });
    return !r.ok && ["shirtSize", "recipient", "address", "province", "city", "barangay", "postal"].every((f) => r.fields[f]);
  })());
  t("consent must be an explicit true (the string 'true' or 1 do not count)",
    !v({ ...DIGITAL, agreeRules: "true" }).ok && !v({ ...DIGITAL, agreePrivacy: 1 }).ok && !v({ ...DIGITAL, agreeRules: false }).ok);
  t("a malformed email is refused", !v({ ...DIGITAL, email: "maria@" }).ok && !v({ ...DIGITAL, email: "a b@c.com" }).ok);
  t("mobile must be 7 to 15 digits", !v({ ...DIGITAL, mobile: "12345" }).ok && !v({ ...DIGITAL, mobile: "abc" }).ok && v({ ...DIGITAL, mobile: "+63 917 123 4567" }).ok);
  t("date of birth must be a real date", !v({ ...DIGITAL, dob: "1992-02-31" }).ok && !v({ ...DIGITAL, dob: "18/04/1992" }).ok && !v({ ...DIGITAL, dob: "" }).ok);
  t("a date of birth in the future or over 110 years ago is refused", !v({ ...DIGITAL, dob: "2030-01-01" }).ok && !v({ ...DIGITAL, dob: "1900-01-01" }).ok);
  t("runners under the minimum age are refused with the age message",
    v({ ...DIGITAL, dob: "2010-01-01" }).fields.dob === "dobAge");
  t("someone who turns 18 today is accepted, a day short is not",
    v({ ...DIGITAL, dob: "2008-11-20" }).ok && v({ ...DIGITAL, dob: "2008-11-21" }).fields.dob === "dobAge");
  t("the age rule follows the config", v({ ...DIGITAL, dob: "2010-01-01" }, { ...READY, ELIGIBILITY: { minAge: 13 } }).ok);
  t("personal bests accept m:ss and h:mm:ss and are stored in one shape",
    v({ ...DIGITAL, pb5k: "24:30" }).ok && v({ ...DIGITAL, pb10k: "1:05:00" }).value.pb_10k === "1:05:00" && v({ ...DIGITAL, pb5k: "024:30" }).ok === false);
  t("personal bests reject typos and impossible times",
    !v({ ...DIGITAL, pb5k: "abc" }).ok && !v({ ...DIGITAL, pb5k: "2:30" }).ok && !v({ ...DIGITAL, pb10k: "9:99" }).ok && !v({ ...DIGITAL, pb10k: "5:00:00" }).ok);
  t("gender is optional but must be one of the options when given", v({ ...DIGITAL, gender: "female" }).ok && !v({ ...DIGITAL, gender: "x" }).ok);
  t("frequency and goal must be listed choices", !v({ ...DIGITAL, frequency: "9" }).ok && !v({ ...DIGITAL, goal: "win" }).ok);
  t("an unknown package is refused", !v({ ...DIGITAL, packageId: "vip" }).ok);
  t("a package switched off in the config is refused",
    !v(DIGITAL, { ...READY, PACKAGES: READY.PACKAGES.map((p) => (p.id === "digital" ? { ...p, available: false } : p)) }).ok);
  t("province must be on the list, and inside the delivery coverage when one is set",
    !v({ ...KIT, province: "Atlantis" }).ok && v({ ...KIT, province: "Cebu" }).ok &&
    v({ ...KIT, province: "Cebu" }, { ...READY, DELIVERY: { ...READY.DELIVERY, provinces: ["Pampanga"] } }).fields.province === "delivery");
  t("postal code is four digits and shirt size is a listed size", !v({ ...KIT, postal: "20066" }).ok && !v({ ...KIT, postal: "abcd" }).ok && !v({ ...KIT, shirtSize: "XXL" }).ok);
  t("a name of one character is refused", !v({ ...DIGITAL, fullName: "M" }).ok);
  t("control characters and line breaks never survive into a stored value", !/[\r\n\u0000]/.test(v({ ...DIGITAL, fullName: "Maria\r\nSantos\u0000" }).value.fullName));
  t("objects and arrays in text fields count as empty, not as text", !v({ ...DIGITAL, fullName: { a: 1 } }).ok && !v({ ...DIGITAL, email: ["a@b.co"] }).ok);
}

// ---- 3. registration ----------------------------------------------------------
section("3. Registration: pending row, server price, checkout");
reset();
{
  const r = await register({ ...DIGITAL, price: 1, amount: 1, priceCents: 1, total: "₱1", amountCents: 100 });
  const row = db.virtual_run_registrations[0];
  t("a valid registration answers 200 with a checkout link and the secret reference",
    r.statusCode === 200 && /^https:\/\/checkout\.paymongo\.com\//.test(r.body.checkout_url) && server.REFERENCE_PATTERN.test(r.body.ref));
  t("exactly one PENDING row is saved, with a short registration id", db.virtual_run_registrations.length === 1 &&
    row.payment_status === "pending" && server.REGISTRATION_ID_PATTERN.test(row.registration_id));
  t("the saved amount is the server's price (₱399), whatever price the browser sent", row.amount_cents === 39900 && row.currency === "PHP");
  t("the PayMongo line item is the server's price too", checkouts[0].line_items[0].amount === 39900 && checkouts[0].line_items.length === 1);
  t("the row holds the participant, running details and consent with the legal version",
    row.full_name === "Maria Santos" && row.email === "maria@example.com" && row.date_of_birth === "1992-04-18" &&
    row.pb_5k === "24:30" && row.weekly_frequency === "3" && row.primary_goal === "sub-60" &&
    row.legal_version === "2026-11-a" && row.rules_accepted_at && row.privacy_accepted_at);
  t("the checkout carries the registration reference and this event's tag",
    checkouts[0].reference_number === row.reference_number && checkouts[0].metadata.athlevo_source === "virtual-run" &&
    checkouts[0].metadata.athlevo_product === "ATHLEVO_VIRTUAL_RUN_DIGITAL" && checkouts[0].metadata.athlevo_registration === row.registration_id);
  t("PayMongo returns the runner to athlevo.org/virtual-run, on success and on cancel",
    checkouts[0].success_url.startsWith("https://athlevo.org/virtual-run?payment=success&ref=" + row.reference_number) &&
    checkouts[0].cancel_url.startsWith("https://athlevo.org/virtual-run?payment=cancelled"));
  t("the checkout session id is noted on the row", row.provider_checkout_id === "cs_test_1");
  t("no personal details are sent to PayMongo in metadata or description",
    !/maria|@|0917|1992/i.test(JSON.stringify(checkouts[0].metadata) + checkouts[0].description));
  t("the registration is never marked paid by registering", row.payment_status === "pending" && !row.paid_at && !row.provider_payment_id);
  t("the 200 response carries nothing else about the person", Object.keys(r.body).sort().join() === "checkout_url,ref");

  const kit = await register({ ...KIT, email: "kit@example.com" });
  const kitRow = db.virtual_run_registrations[1];
  t("the Finisher Kit is priced ₱1,299 with its shirt size and address saved",
    kit.statusCode === 200 && kitRow.amount_cents === 129900 && kitRow.shirt_size === "M" && kitRow.province === "Pampanga" && kitRow.postal_code === "2006");
  const bundle = await register({ ...KIT, packageId: "performance-bundle", email: "bundle@example.com" });
  t("the Performance Bundle is priced ₱2,499", bundle.statusCode === 200 && db.virtual_run_registrations[2].amount_cents === 249900);
  const digitalRow = db.virtual_run_registrations[0];
  t("the Digital Challenge row has no delivery details", digitalRow.shirt_size === null && digitalRow.address_line === null);

  // A price edited in the config is what gets charged, with no other change.
  const repriced = { ...READY, PACKAGES: READY.PACKAGES.map((p) => (p.id === "digital" ? { ...p, priceCents: 45000 } : p)) };
  await register({ ...DIGITAL, email: "new@example.com" }, { cfg: repriced });
  t("changing a price in the config changes what is charged", db.virtual_run_registrations[3].amount_cents === 45000 && checkouts[3].line_items[0].amount === 45000);

  const before = db.virtual_run_registrations.length;
  const trap = await register({ ...DIGITAL, email: "bot@example.com", contact_website: "http://spam.example" });
  t("a filled honeypot looks successful but saves nothing and opens no checkout",
    trap.statusCode === 200 && trap.body.ok === true && db.virtual_run_registrations.length === before && checkouts.length === 4);
  const invalid = await register({ ...DIGITAL, email: "nope" });
  t("an invalid registration answers 400 with the field names and saves nothing", invalid.statusCode === 400 && invalid.body.fields.email && db.virtual_run_registrations.length === before);
  const notJson = res();
  await server.registerHandler({ method: "POST", headers: { "x-forwarded-for": nextIp() }, body: "{broken" }, notJson, { env: process.env, now: NOW, cfg: READY, paymongo: fakePaymongo });
  t("a broken body answers 400", notJson.statusCode === 400);
  const wrongMethod = res();
  await server.registerHandler({ method: "GET", headers: {}, query: {} }, wrongMethod, { env: process.env, now: NOW, cfg: READY });
  t("only POST is accepted", wrongMethod.statusCode === 405 && wrongMethod.headers.Allow === "POST");
}

reset();
{
  await register({ ...DIGITAL, email: "family@example.com", fullName: "Maria Santos" });
  const first = db.virtual_run_registrations[0];
  first.payment_status = "paid"; first.provider_payment_id = "pay_fam_1";
  const sibling = await register({ ...DIGITAL, email: "family@example.com", fullName: "Juan Santos" });
  t("a family or couple can share one email: a different name is a different runner", sibling.statusCode === 200);
  const same = await register({ ...DIGITAL, email: "family@example.com", fullName: "MARIA SANTOS" });
  t("the same name on that email is the same runner, whatever the capitals", same.statusCode === 409 && same.body.error === "already_registered");
}

reset();
{
  await register({ ...DIGITAL, email: "retry@example.com" });
  await register({ ...DIGITAL, email: "retry@example.com" });
  const rows = db.virtual_run_registrations;
  t("trying again releases the earlier unpaid attempt so it stops holding a spot",
    rows.length === 2 && rows[0].payment_status === "cancelled" && rows[1].payment_status === "pending");
  await register({ ...DIGITAL, email: "retry@example.com", fullName: "Juan Santos" });
  t("and does not touch another runner's attempt on the same email", rows.length === 3 && rows[1].payment_status === "pending" && rows[2].payment_status === "pending");
}

reset();
{
  await register({ ...DIGITAL, email: "paid@example.com" });
  const paidRow = db.virtual_run_registrations[0];
  paidRow.payment_status = "paid"; paidRow.provider_payment_id = "pay_existing";
  const again = await register({ ...DIGITAL, email: "PAID@example.com" });
  t("an email that already has a paid registration cannot register again (no double charge)",
    again.statusCode === 409 && again.body.error === "already_registered" && checkouts.length === 1);
  const other = await register({ ...DIGITAL, email: "someone.else@example.com" });
  t("a different email is unaffected", other.statusCode === 200);
  paidRow.payment_status = "pending";
  const retry = await register({ ...DIGITAL, email: "paid@example.com" });
  t("an unpaid earlier attempt does not block a retry", retry.statusCode === 200);
}

reset();
{
  const limited = { ...READY, REGISTRATION: { ...READY.REGISTRATION, limit: 2 } };
  const one = await register({ ...DIGITAL, email: "a@example.com" }, { cfg: limited });
  const two = await register({ ...DIGITAL, email: "b@example.com" }, { cfg: limited });
  const three = await register({ ...DIGITAL, email: "c@example.com" }, { cfg: limited });
  t("the event limit counts unpaid registrations that are still holding a spot",
    one.statusCode === 200 && two.statusCode === 200 && three.statusCode === 409 && three.body.error === "full" && db.virtual_run_registrations.length === 2);
  db.virtual_run_registrations[0].hold_expires_at = new Date(NOW.getTime() - 60000).toISOString();
  const released = await register({ ...DIGITAL, email: "d@example.com" }, { cfg: limited });
  t("an unpaid registration releases its spot when its hold runs out", released.statusCode === 200);
  db.virtual_run_registrations.forEach((r) => { r.payment_status = "paid"; });
  const full = await register({ ...DIGITAL, email: "e@example.com" }, { cfg: limited });
  t("paid registrations keep their spot", full.statusCode === 409);
  const availability = res();
  await server.availabilityHandler(get(), availability, { env: process.env, now: NOW, cfg: limited });
  t("availability reports sold out when the event is full", availability.body.state === "sold_out");

  reset();
  const pkgLimited = { ...READY, PACKAGES: READY.PACKAGES.map((p) => (p.id === "finisher-kit" ? { ...p, limit: 1 } : p)) };
  await register({ ...KIT, email: "k1@example.com" }, { cfg: pkgLimited });
  const kit2 = await register({ ...KIT, email: "k2@example.com" }, { cfg: pkgLimited });
  const dig = await register({ ...DIGITAL, email: "d1@example.com" }, { cfg: pkgLimited });
  t("a package limit stops that package only", kit2.statusCode === 409 && dig.statusCode === 200);
  const statuses = await server.packageStatuses({ env: process.env, now: NOW, cfg: pkgLimited });
  t("availability marks the full package sold out and leaves the others on sale",
    statuses.find((s) => s.id === "finisher-kit").status === "sold_out" && statuses.find((s) => s.id === "digital").status === "available");
}

reset();
{
  const noDelivery = { ...READY, DELIVERY: { ...READY.DELIVERY, confirmed: false } };
  const kit = await register(KIT, { cfg: noDelivery });
  const dig = await register(DIGITAL, { cfg: noDelivery });
  t("until delivery is confirmed the shirt packages cannot be bought but the Digital Challenge can",
    kit.statusCode === 503 && dig.statusCode === 200 && db.virtual_run_registrations.length === 1);
  const statuses = await server.packageStatuses({ env: process.env, now: NOW, cfg: noDelivery });
  t("availability shows the shirt packages as 'soon'", statuses.filter((s) => s.status === "soon").length === 2);
}

reset();
{
  dbMode = "down";
  const down = await register(DIGITAL);
  t("a database error answers 503 and opens no checkout", down.statusCode === 503 && checkouts.length === 0);
  t("the database error is logged without the key or any personal detail", errors.length > 0 && !errors.join(" ").match(/service-secret|maria|@example/i));
  reset(); dbMode = "missing";
  const missing = await register(DIGITAL);
  t("a missing table (migration not run) answers 503 and the log names the migration",
    missing.statusCode === 503 && errors.join(" ").includes("2026-11-14_virtual_run_registrations.sql"));
  reset(); paymongoMode = "fail";
  const failed = await register(DIGITAL);
  t("when PayMongo cannot open the checkout the runner gets 502 and the row is marked failed (not left pending)",
    failed.statusCode === 502 && db.virtual_run_registrations[0].payment_status === "failed");
  t("a failed checkout is not mistaken for a paid one", !db.virtual_run_registrations[0].paid_at);
}

reset();
{
  let last;
  const ip = "198.51.100.77";
  for (let i = 0; i < AI_LIMITS["virtual-run-register"].limit + 1; i++) {
    const r = res();
    await server.registerHandler(post({ ...DIGITAL, email: `r${i}@example.com` }, ip), r, { env: process.env, now: NOW, cfg: READY, paymongo: fakePaymongo });
    last = r;
  }
  t("one visitor is rate limited after the registration limit (429)", last.statusCode === 429 && last.body.code === "RATE_LIMITED");
  t("the rate limit is 10 an hour for registration and 240 for the status screen",
    AI_LIMITS["virtual-run-register"].limit === 10 && AI_LIMITS["virtual-run-status"].limit === 240);
}

// ---- 4. confirmation status ---------------------------------------------------
section("4. Confirmation status");
reset();
{
  await register(DIGITAL);
  const row = db.virtual_run_registrations[0];
  const status = (ref) => { const r = res(); return server.statusHandler(post({ ref }), r, { env: process.env, cfg: READY }).then(() => r); };
  const pending = await status(row.reference_number);
  t("an unpaid registration reports pending and nothing else", pending.statusCode === 200 && JSON.stringify(pending.body) === '{"status":"pending"}');
  const unknown = await status("ATH-VR-" + "A".repeat(10) + "-" + "B".repeat(24));
  t("an unknown reference also reads as pending (it does not confirm that a reference exists)", unknown.body.status === "pending");
  const bad = await status("nonsense");
  t("a malformed reference is refused with 400", bad.statusCode === 400);
  const registrationIdAsRef = await status(row.registration_id);
  t("the short registration id cannot be used to open someone's confirmation", registrationIdAsRef.statusCode === 400);
  Object.assign(row, { payment_status: "paid", confirmation_email_status: "sent" });
  setEnv({ VIRTUAL_RUN_ASSESSMENT_URL: "https://forms.example.com/assess", VIRTUAL_RUN_TRAINING_URL: "javascript:alert(1)" });
  const paid = await status(row.reference_number);
  t("a paid registration returns the name, registration id and package for the confirmation screen",
    paid.body.status === "paid" && paid.body.name === "Maria Santos" && paid.body.registration_id === row.registration_id &&
    paid.body.package.name === "Digital Challenge" && paid.body.package.physical === false);
  t("it says whether the confirmation email went out", paid.body.email_sent === true);
  t("it returns the next-step links that are valid https and drops any that are not",
    paid.body.assessment_url === "https://forms.example.com/assess" && paid.body.training_url === null);
  t("it never returns the email, mobile, birth date or address", !/example\.com\/|@|0917|1992|Rizal/.test(JSON.stringify({ ...paid.body, assessment_url: "", training_url: "" })));
  row.payment_status = "failed";
  t("a failed registration reports failed", (await status(row.reference_number)).body.status === "failed");
}

// ---- 5. the webhook -------------------------------------------------------------
section("5. The webhook");

function paidEvent(row, { amount = row.amount_cents, productId = row.product_id, registration = row.registration_id, paymentId = "pay_1",
  checkoutId = "cs_test_1", id = "evt_1", livemode = false, source = "virtual-run", reference = row.reference_number, currency = "PHP", event = "athlevo-sub-1-10k-2026" } = {}) {
  return { data: { id, type: "event", attributes: {
    type: "checkout_session.payment.paid", livemode, created_at: 1760000000,
    data: { id: checkoutId, type: "checkout_session", attributes: {
      reference_number: reference,
      metadata: { athlevo_product: productId, athlevo_source: source, athlevo_event: event, athlevo_registration: registration },
      payments: [{ id: paymentId, type: "payment", attributes: {
        status: "paid", amount, currency, paid_at: 1760000000, source: { type: "qrph" },
        billing: { name: "Someone Else", email: "billing@example.com", phone: "+639000000000" }
      } }]
    } }
  } } };
}
async function deliver(event, { live = false, secret = process.env.PAYMONGO_WEBHOOK_SECRET, signed = true } = {}) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = signed ? crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex") : "deadbeef";
  const r = res();
  await webhook({ method: "POST", body: Buffer.from(body), headers: { "paymongo-signature": live ? `t=${ts},te=,li=${sig}` : `t=${ts},te=${sig},li=` } }, r);
  return r;
}
const newRow = async (body = DIGITAL) => { await register(body); return db.virtual_run_registrations[db.virtual_run_registrations.length - 1]; };

reset();
{
  const row = await newRow();
  const r = await deliver(paidEvent(row));
  t("a verified payment for the exact amount marks the registration paid", r.statusCode === 200 && r.body.result.applied === true && row.payment_status === "paid");
  t("the payment id, checkout id, method, time and test mode are recorded",
    row.provider_payment_id === "pay_1" && row.provider_checkout_id === "cs_test_1" && row.payment_method_type === "qrph" && row.paid_at && row.livemode === false);
  t("the participant's own details are untouched by the billing details PayMongo sent", row.full_name === "Maria Santos" && row.email === "maria@example.com");
  const buyer = log.emails.find((e) => e.body.to.includes("maria@example.com"));
  const staff = log.emails.find((e) => e.body.to.includes("owner@example.com"));
  t("the participant gets one confirmation with the registration id, and staff get one alert",
    log.emails.length === 2 && buyer && buyer.body.html.includes(row.registration_id) && staff && staff.body.subject.includes("Maria Santos"));
  t("the staff alert carries no address, birth date or mobile number", !/0917|1992|Rizal|09171234567/.test(staff.body.html + staff.body.text));
  t("the confirmation email says it cannot promise a finish time", /cannot promise a finish time/.test(buyer.body.text));
  t("the email outcome is noted on the registration", row.confirmation_email_status === "sent" && row.confirmation_sent_at);

  const again = await deliver(paidEvent(row));
  t("the same payment delivered again (a PayMongo retry) changes nothing", again.statusCode === 200 && again.body.result.duplicate === true && again.body.result.applied === false);
  t("a repeated callback sends no second email", log.emails.length === 2);
  t("still exactly one registration row", db.virtual_run_registrations.length === 1);
  const sameAgain = await deliver(paidEvent(row, { id: "evt_other_id" }));
  t("a repeated payment under a different event id is also a no-op", sameAgain.body.result.duplicate === true && log.emails.length === 2);
}

reset();
{
  const row = await newRow();
  const [a, b, c] = await Promise.all([deliver(paidEvent(row)), deliver(paidEvent(row)), deliver(paidEvent(row))]);
  const applied = [a, b, c].filter((r) => r.body.result.applied).length;
  t("three simultaneous deliveries record the payment exactly once", applied === 1 && row.payment_status === "paid");
  t("and send exactly one participant email and one staff alert", log.emails.length === 2);
}

reset();
{
  const row = await newRow();
  const wrong = await deliver(paidEvent(row, { amount: 100 }));
  t("a payment for the wrong amount is refused (400) and the registration stays pending",
    wrong.statusCode === 400 && row.payment_status === "pending" && !row.provider_payment_id);
  t("a refused payment tells the owner", log.emails.some((e) => /needs attention: wrong_amount/.test(e.body.subject)) && errors.some((m) => /NOT recorded \(wrong_amount\)/.test(m)));
  t("the refusal is logged without personal details", !errors.join(" ").match(/maria|@example/i));
  t("a price paid in the wrong currency is refused", (await deliver(paidEvent(row, { currency: "USD" }))).statusCode === 400);
  t("a different product than the registration's is refused", (await deliver(paidEvent(row, { productId: "ATHLEVO_VIRTUAL_RUN_PERFORMANCE_BUNDLE" }))).statusCode === 400);
  t("a registration id that does not match the reference is refused", (await deliver(paidEvent(row, { registration: "SUB1-ZZZZZZZZ" }))).statusCode === 400);
  t("an unknown reference is refused", (await deliver(paidEvent(row, { reference: "ATH-VR-" + "A".repeat(10) + "-" + "C".repeat(24) }))).statusCode === 400);
  t("a checkout that is not the one opened for this registration is refused", (await deliver(paidEvent(row, { checkoutId: "cs_someone_elses" }))).statusCode === 400);
  t("a different event's registration is refused", (await deliver(paidEvent(row, { event: "another-event-2027" }))).statusCode === 400);
  t("none of those refusals marked anything paid", row.payment_status === "pending");
  const bundleRow = await newRow({ ...KIT, packageId: "performance-bundle", email: "b@example.com" });
  t("paying the Finisher Kit price for a Performance Bundle registration is refused",
    (await deliver(paidEvent(bundleRow, { amount: 129900 }))).statusCode === 400 && bundleRow.payment_status === "pending");
}

reset();
{
  const row = await newRow();
  const forged = await deliver(paidEvent(row), { signed: false });
  t("an event with an invalid signature is rejected (401) and writes nothing", forged.statusCode === 401 && row.payment_status === "pending" && log.emails.length === 0);
  const wrongSecret = await deliver(paidEvent(row), { secret: "other-secret" });
  t("an event signed with another secret is rejected", wrongSecret.statusCode === 401 && row.payment_status === "pending");
  const modeMismatch = await deliver(paidEvent(row, { livemode: true }), { live: false });
  t("a live event signed as test is rejected", modeMismatch.statusCode === 401 && row.payment_status === "pending");
  const live = await deliver(paidEvent(row, { livemode: true }), { live: true });
  t("a live-mode payment is recorded as live money", live.statusCode === 200 && row.livemode === true && row.payment_status === "paid");
}

reset();
{
  const row = await newRow();
  await deliver(paidEvent(row));
  log.emails.length = 0;
  const second = await deliver(paidEvent(row, { paymentId: "pay_2", id: "evt_2" }));
  t("a second, different payment for an already paid registration is acknowledged but changes nothing",
    second.statusCode === 200 && second.body.result.extra_payment === true && row.provider_payment_id === "pay_1");
  t("it tells the owner so it can be refunded", log.emails.length === 1 && /second_payment_for_registration/.test(log.emails[0].body.subject));
}

reset();
{
  // The same person opens a second checkout (the first is released) and ends up paying both.
  await register({ ...DIGITAL, email: "twice@example.com" });
  await register({ ...DIGITAL, email: "twice@example.com" });
  const [firstTry, secondTry] = db.virtual_run_registrations;
  const one = await deliver(paidEvent(firstTry, { paymentId: "pay_a", id: "evt_a", checkoutId: firstTry.provider_checkout_id }));
  t("a payment for an attempt that was released is still recorded (the money was taken)", one.statusCode === 200 && firstTry.payment_status === "paid");
  log.emails.length = 0;
  const two = await deliver(paidEvent(secondTry, { paymentId: "pay_b", id: "evt_b", checkoutId: secondTry.provider_checkout_id }));
  const alert = log.emails.find((e) => /second_registration_same_runner/.test(e.body.subject));
  t("a second paid registration for the same runner is recorded, and nothing is undone", two.statusCode === 200 && secondTry.payment_status === "paid" && firstTry.payment_status === "paid");
  t("the owner is told, with both registration ids, so one can be refunded by hand",
    alert && alert.body.to.includes("owner@example.com") && alert.body.text.includes(firstTry.registration_id) && alert.body.text.includes(secondTry.registration_id));
  const unrelated = await newRow({ ...DIGITAL, email: "solo@example.com" });
  log.emails.length = 0;
  await deliver(paidEvent(unrelated, { paymentId: "pay_c", id: "evt_c", checkoutId: unrelated.provider_checkout_id }));
  t("an ordinary payment raises no such alert", !log.emails.some((e) => /second_registration_same_runner/.test(e.body.subject)) && log.emails.length === 2);
}

reset();
{
  // PayMongo delivers again because our first answer was lost, and the confirmation email never went out.
  const row = await newRow();
  await deliver(paidEvent(row));
  t("the first delivery records the email as sent", row.confirmation_email_status === "sent");
  row.confirmation_email_status = null; row.confirmation_sent_at = null;
  row.updated_at = new Date(Date.now() - 120000).toISOString();
  log.emails.length = 0;
  const retry = await deliver(paidEvent(row));
  t("a repeated delivery sends the confirmation that never went out", retry.body.result.duplicate === true &&
    log.emails.some((e) => e.body.to.includes("maria@example.com")) && row.confirmation_email_status === "sent");
  log.emails.length = 0;
  await deliver(paidEvent(row));
  t("once it is recorded as sent, a repeat sends nothing", log.emails.length === 0);
  row.confirmation_email_status = null; row.updated_at = new Date().toISOString();
  await deliver(paidEvent(row));
  t("a repeat that arrives while the first is still working sends nothing of its own", log.emails.length === 0);
}

reset();
{
  const row = await newRow();
  row.payment_status = "expired";
  const late = await deliver(paidEvent(row));
  t("a payment that arrives after the hold expired is still recorded (a payment is never lost)", late.statusCode === 200 && row.payment_status === "paid");
  const failedRow = await newRow({ ...DIGITAL, email: "f@example.com" });
  failedRow.payment_status = "failed";
  const f = await deliver(paidEvent(failedRow, { paymentId: "pay_f", id: "evt_f", checkoutId: "cs_test_2" }));
  t("a registration marked failed that was in fact paid is recorded as paid", f.statusCode === 200 && failedRow.payment_status === "paid");
}

reset();
{
  const row = await newRow();
  await deliver(paidEvent(row));
  const refund = { data: { id: "evt_r1", type: "event", attributes: { type: "payment.refunded", livemode: false, created_at: 1760000100,
    data: { id: "pay_1", type: "payment", attributes: { amount: row.amount_cents, status: "succeeded" } } } } };
  const r = await deliver(refund);
  t("a full refund marks the registration refunded", r.statusCode === 200 && row.payment_status === "refunded" && row.refunded_at);
  const late = await deliver(paidEvent(row));
  t("a late 'paid' event never reverses a refund", late.statusCode === 200 && late.body.result.ignored === true && row.payment_status === "refunded");
  const repeat = await deliver(refund);
  t("a repeated refund event is a no-op", repeat.body.result.duplicate === true);
}

reset();
{
  const refundFor = (paymentId) => ({ data: { id: `evt_r_${paymentId}`, type: "event", attributes: { type: "payment.refunded", livemode: false, created_at: 1760000100,
    data: { id: paymentId, type: "payment", attributes: { amount: 39900, status: "succeeded" } } } } });
  dbMode = "reject";
  errors.length = 0;
  const rejected = await deliver(refundFor("pay_unrelated"));
  t("a refund is not held up when the database refuses the Sub-1 10k lookup (the other handlers still get it)", rejected.statusCode === 200);
  t("and the refusal is logged", errors.some((line) => /refund lookup rejected/.test(line)));
  dbMode = "down";
  const outage = await deliver(refundFor("pay_unrelated"));
  t("a database outage is still an error, so PayMongo delivers the refund again", outage.statusCode === 500);
  dbMode = "missing";
  const noTable = await deliver(refundFor("pay_unrelated"));
  t("before the migration is run the refund simply is not ours", noTable.statusCode === 200);
}

// ---- 6. other payments are unaffected --------------------------------------------
section("6. The store sign-ups and Athlevo Pro still work");
reset();
{
  const storeRef = "ATH-PL-" + "A".repeat(10) + "-" + "B".repeat(24);
  const storeEvent = { data: { id: "evt_s1", type: "event", attributes: {
    type: "checkout_session.payment.paid", livemode: false, created_at: 1760000000,
    data: { id: "cs_s1", type: "checkout_session", attributes: {
      reference_number: storeRef, metadata: { athlevo_product: "ATHLEVO_PLAN_MONTHLY", athlevo_source: "store" },
      payments: [{ id: "pay_s1", type: "payment", attributes: { status: "paid", amount: 299700, currency: "PHP", paid_at: 1760000000, source: { type: "qrph" }, billing: { name: "Store Buyer", email: "store@example.com" } } }]
    } } } } };
  const r = await deliver(storeEvent);
  t("a store payment is still recorded in plan_signups", r.statusCode === 200 && db.plan_signups.length === 1 && db.virtual_run_registrations.length === 0);
  const ignored = await deliver({ data: { id: "evt_x", type: "event", attributes: { type: "source.chargeable", livemode: false, data: { id: "src_1", type: "source", attributes: {} } } } });
  t("an unrelated event is acknowledged and ignored", ignored.statusCode === 200 && ignored.body.ignored === true);
  const spoof = await deliver({ ...storeEvent, data: { ...storeEvent.data, attributes: { ...storeEvent.data.attributes, data: { ...storeEvent.data.attributes.data, attributes: { ...storeEvent.data.attributes.data.attributes,
    metadata: { athlevo_product: "ATHLEVO_PLAN_MONTHLY", athlevo_source: "virtual-run" } } } } } });
  t("a store checkout cannot be passed off as a Sub-1 registration (and is refused, not recorded as one)",
    spoof.statusCode === 400 && db.virtual_run_registrations.length === 0);
}

// ---- 7. staff admin ---------------------------------------------------------------
section("7. Staff admin");
reset();
{
  const seed = [
    { id: "p1", package: "digital", status: "paid", name: "Ana Reyes", email: "ana@example.com", live: true },
    { id: "p2", package: "finisher-kit", status: "paid", name: "=HYPERLINK(\"http://evil.example\",\"x\")", email: "evil@example.com", live: true },
    { id: "p3", package: "performance-bundle", status: "paid", name: "Carlo \"CJ\" Tan, Jr.", email: "cj@example.com", live: false },
    { id: "p4", package: "finisher-kit", status: "pending", name: "Pending Pat", email: "pat@example.com", live: false },
    { id: "p5", package: "finisher-kit", status: "refunded", name: "Refunded Rey", email: "rey@example.com", live: true }
  ];
  seed.forEach((s, i) => {
    const pkg = content.packageById(s.package);
    db.virtual_run_registrations.push({
      id: s.id, registration_id: `SUB1-AAAAAAA${i + 2}`, reference_number: `ATH-VR-${"A".repeat(10)}-${String(i).padStart(24, "C")}`,
      event: content.EVENT.id, package_id: pkg.id, package_name: pkg.name, product_id: pkg.productId, amount_cents: pkg.priceCents,
      currency: "PHP", payment_status: s.status, full_name: s.name, email: s.email, mobile: i === 0 ? "+639171234567" : "09170000000",
      date_of_birth: "1990-01-01", gender: null, pb_5k: "25:00", pb_10k: null, weekly_frequency: "3", primary_goal: "habit",
      shirt_size: pkg.physical ? "L" : null, recipient_name: pkg.physical ? s.name : null, address_line: pkg.physical ? "5 Main St" : null,
      province: pkg.physical ? "Pampanga" : null, city: pkg.physical ? "Angeles" : null, barangay: pkg.physical ? "Pulung Maragul" : null,
      postal_code: pkg.physical ? "2009" : null, payment_method_type: "qrph", livemode: s.live,
      paid_at: s.status === "paid" ? "2026-11-21T02:30:00Z" : null, created_at: `2026-11-2${i + 1}T01:00:00Z`, result_status: "not_submitted",
      confirmation_email_status: "sent", metadata: { secret: "never-returned" }
    });
  });

  const STAFF = { id: "11111111-aaaa-bbbb-cccc-000000000001", email: "staff@athlevo.org", email_confirmed_at: "2026-10-01T00:00:00Z" };
  const call = async (query, user, env = {}) => {
    const r = res();
    await admin.adminHandler(get(query, { authorization: "Bearer tok" }), r, { authenticate: async () => user, env: { ...process.env, ...env } });
    return r;
  };
  const staffEnv = { VIRTUAL_RUN_STAFF_USER_IDS: STAFF.id };

  const anon = res();
  await admin.adminHandler(get(), anon, { authenticate: async () => null, env: process.env });
  t("no sign-in answers 401 and reads nothing", anon.statusCode === 401 && !log.requests.some((q) => q.includes("virtual_run_registrations")));
  const broken = res();
  await admin.adminHandler(get(), broken, { authenticate: async () => { throw new Error("auth down"); }, env: process.env });
  t("a sign-in check that fails answers 503, never data", broken.statusCode === 503 && broken.body.rows === undefined);
  log.requests.length = 0;
  const outsider = await call({}, { id: "99999999-0000-0000-0000-000000000009", email: "runner@example.com", email_confirmed_at: "x" }, staffEnv);
  t("a signed-in user who is not staff gets 403 and nothing is read", outsider.statusCode === 403 && outsider.body.rows === undefined && !log.requests.some((q) => q.includes("virtual_run_registrations")));
  const nobodyConfigured = await call({}, STAFF, { VIRTUAL_RUN_STAFF_USER_IDS: "", VIRTUAL_RUN_STAFF_EMAILS: "", ADMIN_USER_IDS: "" });
  t("with no staff configured nobody gets in", nobodyConfigured.statusCode === 403);
  t("a staff user id is allowed", (await call({}, STAFF, staffEnv)).statusCode === 200);
  t("the founder's ADMIN_USER_IDS are allowed too", (await call({}, STAFF, { VIRTUAL_RUN_STAFF_USER_IDS: "", ADMIN_USER_IDS: `x,${STAFF.id}` })).statusCode === 200);
  t("a staff email is allowed when Supabase has confirmed it", (await call({}, STAFF, { VIRTUAL_RUN_STAFF_USER_IDS: "", VIRTUAL_RUN_STAFF_EMAILS: "Staff@Athlevo.org" })).statusCode === 200);
  t("an UNconfirmed email on the list is not enough", (await call({}, { ...STAFF, email_confirmed_at: null }, { VIRTUAL_RUN_STAFF_USER_IDS: "", VIRTUAL_RUN_STAFF_EMAILS: STAFF.email })).statusCode === 403);
  t("an email that is not on the list is refused", (await call({}, { id: "z", email: "other@athlevo.org", email_confirmed_at: "x" }, { VIRTUAL_RUN_STAFF_USER_IDS: "", VIRTUAL_RUN_STAFF_EMAILS: STAFF.email })).statusCode === 403);
  const post405 = res();
  await admin.adminHandler({ method: "POST", headers: {}, query: {} }, post405, { authenticate: async () => STAFF, env: { ...process.env, ...staffEnv } });
  t("only GET is accepted", post405.statusCode === 405);

  const all = await call({}, STAFF, staffEnv);
  t("staff get every registration, newest first", all.body.rows.length === 5 && all.body.rows[0].fullName === "Refunded Rey");
  t("every admin response is no-store and noindex", all.headers["Cache-Control"] === "no-store" && /noindex/.test(all.headers["X-Robots-Tag"]));
  t("the full details are there for staff", all.body.rows.some((r) => r.dateOfBirth === "1990-01-01" && r.address === "5 Main St" && r.paymentMethod === "qrph"));
  t("internal metadata is never returned", !JSON.stringify(all.body).includes("never-returned"));
  t("the summary counts every registration by status and package, and live money only",
    all.body.summary.byStatus.paid === 3 && all.body.summary.byStatus.pending === 1 && all.body.summary.byStatus.refunded === 1 &&
    all.body.summary.byPackage["finisher-kit"].paid === 1 && all.body.summary.byPackage["finisher-kit"].pending === 1 &&
    all.body.summary.paidCents === 39900 + 129900);
  const byPackage = await call({ package: "finisher-kit" }, STAFF, staffEnv);
  t("filter by package", byPackage.body.rows.length === 3 && byPackage.body.rows.every((r) => r.packageId === "finisher-kit"));
  const byStatus = await call({ status: "pending" }, STAFF, staffEnv);
  t("filter by payment status", byStatus.body.rows.length === 1 && byStatus.body.rows[0].status === "pending");
  const both = await call({ package: "finisher-kit", status: "paid" }, STAFF, staffEnv);
  t("package and status filters combine", both.body.rows.length === 1);
  const search = await call({ q: "cj@example" }, STAFF, staffEnv);
  t("search finds by email", search.body.rows.length === 1 && search.body.rows[0].email === "cj@example.com");
  const searchId = await call({ q: "sub1-aaaaaaa3" }, STAFF, staffEnv);
  t("search finds by registration id, ignoring case", searchId.body.rows.length === 1);
  const inject = await call({ q: "x),or=(id.neq.0" }, STAFF, staffEnv);
  t("a search cannot inject filters into the query", inject.statusCode === 200 && admin.safeSearch("x),or=(id.neq.0") === "xorid.neq.0" && inject.body.rows.length === 0);
  const unknownFilter = await call({ package: "evil", status: "evil" }, STAFF, staffEnv);
  t("unknown filter values are ignored, not passed to the database", unknownFilter.body.rows.length === 5);
  const fulfil = await call({ fulfillment: "1" }, STAFF, staffEnv);
  t("the fulfillment filter is paid orders that need delivery only", fulfil.body.rows.length === 2 && fulfil.body.rows.every((r) => r.status === "paid" && r.shirtSize));

  const csv = await call({ format: "csv", fulfillment: "1" }, STAFF, staffEnv);
  const text = csv.sent;
  t("the CSV is a download with the right type and a dated file name", /text\/csv/.test(csv.headers["Content-Type"]) &&
    /attachment; filename="athlevo-sub-1-10k-orders-\d{4}-\d{2}-\d{2}\.csv"/.test(csv.headers["Content-Disposition"]));
  t("the CSV starts with a byte-order mark and the fulfillment columns", text.startsWith("﻿Registration ID,Payment status,Test payment,Package,Shirt size,Recipient name,Mobile,Email,Address"));
  const lines = text.trim().split("\r\n");
  t("the CSV has a header and one line per order", lines.length === 3);
  t("text that a spreadsheet would run as a formula is neutralised", text.includes("\"'=HYPERLINK(") && !/(^|,)=HYPERLINK/.test(text));
  t("quotes and commas in a name are escaped", text.includes('"Carlo ""CJ"" Tan, Jr."'));
  t("test-mode payments are flagged so they are not shipped", lines.slice(1).some((l) => l.includes(",yes,")) && lines.slice(1).some((l) => l.includes(",no,")));
  t("the CSV carries no birth date, running details or goals", !/1990-01-01|25:00|habit/.test(text));
  const phone = admin.csvCell("+639171234567");
  t("a plain phone number keeps its plus sign", phone === "+639171234567" && admin.csvCell("-5+3") === "'-5+3" && admin.csvCell("@SUM(1)") === "'@SUM(1)");
  t("Manila time is used for the CSV dates", text.includes("2026-11-21 10:30"));
  const allCsv = await call({ format: "csv" }, STAFF, staffEnv);
  t("an unfiltered export includes pending and refunded rows with their status", allCsv.sent.includes(",pending,") && allCsv.sent.includes(",refunded,"));
}

reset();
{
  // More registrations than one database request can return (Supabase answers at most 1000 rows at a time).
  const kit = content.packageById("finisher-kit");
  const many = (count, status, extra = () => ({})) => {
    for (let i = 0; i < count; i++) {
      const n = db.virtual_run_registrations.length;
      db.virtual_run_registrations.push({
        id: `m${n}`, registration_id: `SUB1-M${String(n).padStart(7, "0")}`, reference_number: `ATH-VR-${"B".repeat(10)}-${String(n).padStart(24, "D")}`,
        event: content.EVENT.id, package_id: kit.id, package_name: kit.name, product_id: kit.productId, amount_cents: kit.priceCents, currency: "PHP",
        payment_status: status, full_name: `Runner ${n}`, email: `runner${n}@example.com`, mobile: "09170000000", date_of_birth: "1990-01-01",
        weekly_frequency: "3", primary_goal: "habit", shirt_size: "M", recipient_name: `Runner ${n}`, address_line: "1 Main St", province: "Pampanga",
        city: "Angeles", barangay: "Pulung Maragul", postal_code: "2009", payment_method_type: "qrph", livemode: true,
        paid_at: status === "paid" ? "2026-11-21T02:30:00Z" : null, created_at: new Date(Date.parse("2026-11-20T00:00:00Z") + n * 1000).toISOString(),
        result_status: "not_submitted", confirmation_email_status: "sent", metadata: {}, ...extra(n)
      });
    }
  };
  many(2300, "paid");
  const STAFF = { id: "11111111-aaaa-bbbb-cccc-000000000001", email: "staff@athlevo.org", email_confirmed_at: "2026-10-01T00:00:00Z" };
  const call = async (query) => {
    const r = res();
    await admin.adminHandler(get(query, { authorization: "Bearer tok" }), r, { authenticate: async () => STAFF, env: { ...process.env, VIRTUAL_RUN_STAFF_USER_IDS: STAFF.id } });
    return r;
  };
  const csv = await call({ format: "csv", fulfillment: "1" });
  const csvLines = csv.sent.split("\r\n").filter(Boolean);
  t("the CSV export holds every order, not just the first thousand", csvLines.length === 2301, `lines=${csvLines.length}`);
  t("no order appears twice across the pages", new Set(csvLines.map((l) => l.split(",")[0])).size === 2301);
  const list = await call({ limit: "5000" });
  t("the on-screen list is capped at what the database can return in one request", list.body.rows.length === 1000 && list.body.truncated === true);
  t("the counts are of all registrations, not of one page", list.body.summary.total === 2300 && list.body.summary.byStatus.paid === 2300 && list.body.summaryComplete === true);

  reset();
  const hour = 3600000;
  const stamp = (offset) => new Date(Date.now() + offset).toISOString();
  many(2, "pending", () => ({ hold_expires_at: stamp(hour) }));
  many(3, "pending", () => ({ hold_expires_at: stamp(-hour) }));
  many(1, "paid");
  const strip = await call({});
  t("a pending registration whose hold has run out is a lapsed hold, not awaiting payment",
    strip.body.summary.byStatus.pending === 2 && strip.body.summary.lapsedHolds === 3 && strip.body.summary.byPackage["finisher-kit"].pending === 2);
  t("lapsed holds are not counted as paid", strip.body.summary.byStatus.paid === 1 && strip.body.summary.total === 6);
}

// ---- 8. the gateway -----------------------------------------------------------------
section("8. Gateway wiring");
reset();
{
  const { default: gateway } = await import("../api/providers/index.js");
  const call = async (action, request = {}) => {
    const r = res();
    await gateway({ method: "GET", headers: { "x-forwarded-for": nextIp() }, query: { action }, ...request }, r);
    return r;
  };
  const availability = await call("virtual_run_availability");
  t("/api/virtual-run/availability is served by the gateway and the shipped config is closed", availability.statusCode === 200 && availability.body.state === "not_open");
  const register = await call("virtual_run_register", { method: "POST", body: DIGITAL });
  t("/api/virtual-run/register through the gateway is closed by default", register.statusCode === 503 && db.virtual_run_registrations.length === 0);
  const status = await call("virtual_run_status", { method: "POST", body: { ref: "x" } });
  t("/api/virtual-run/status through the gateway checks the reference", status.statusCode === 400);
  const noToken = await call("virtual_run_admin");
  t("/api/virtual-run/admin through the gateway refuses a request with no token", noToken.statusCode === 401 && noToken.body.rows === undefined);
  const badToken = await call("virtual_run_admin", { headers: { authorization: "Bearer not-a-real-token", "x-forwarded-for": nextIp() } });
  t("and a token Supabase does not accept", badToken.statusCode === 401 || badToken.statusCode === 503);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
