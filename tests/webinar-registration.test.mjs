/*
 * Webinar registration (POST /api/webinar/register): server behaviour.
 * Runs the real handler against an in-memory Supabase and Resend.
 * Run: node tests/webinar-registration.test.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
process.env.RESEND_API_KEY = "re_test_secret";
process.env.SIGNUP_ALERT_EMAIL = "owner@example.com";
delete process.env.WEBINAR_ALERT_EMAIL;

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (title) => console.log(`\n── ${title}`);

// ---- in-memory Supabase + Resend -------------------------------------------

const db = { webinar_registrations: [], rates: new Map() };
const log = { emails: [], tables: [] };
let dbMode = "ok";      // "ok" | "down" (500) | "missing" (404, migration not run) | "throw"
let resendMode = "ok";  // "ok" | "reject" | "throw"

const strip = (v) => String(v || "").replace(/^eq\./, "");

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.host === "api.resend.com") {
    log.emails.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (resendMode === "throw") throw new TypeError("network down");
    if (resendMode === "reject") return json({ message: "rejected" }, 500);
    return json({ id: `em_${log.emails.length}` });
  }
  if (url.host !== "db.test") return json({}, 404);
  const table = url.pathname.replace("/rest/v1/", "");
  log.tables.push(`${method} ${table}`);
  const q = url.searchParams;
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
  if (table === "webinar_registrations") {
    if (dbMode === "throw") throw new TypeError("network down");
    if (dbMode === "down") return json({ message: "boom service-secret" }, 500);
    if (dbMode === "missing") return json({ code: "PGRST205", message: "Could not find the table" }, 404);
    if (method === "POST") {
      const row = JSON.parse(init.body);
      db.webinar_registrations.push({ headers: init.headers, row });
      return new Response(null, { status: 201 });
    }
    return json([]);
  }
  return json([]);
};

const errors = [];
const realError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(" ")); };

function res() {
  return {
    statusCode: 200, body: null, headers: {}, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
    end() { this.ended = true; return this; }
  };
}

let ipCounter = 10;
const nextIp = () => `203.0.113.${ipCounter++}`;
const GOOD = {
  name: "Maria Santos", mobile: "0917 123 4567", email: "maria@example.com",
  distance: "10k", training: "no-plan", question: "How should I pace the last 3k?", contact_website: ""
};
const post = (body, ip = nextIp(), { form = false, method = "POST" } = {}) => ({
  method,
  headers: { "x-forwarded-for": ip, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : { "content-type": "application/json" }) },
  body: form ? new URLSearchParams(body).toString() : body
});
function reset() {
  db.webinar_registrations.length = 0; log.emails.length = 0; log.tables.length = 0; errors.length = 0;
  dbMode = "ok"; resendMode = "ok";
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
  process.env.RESEND_API_KEY = "re_test_secret";
  process.env.SIGNUP_ALERT_EMAIL = "owner@example.com";
  delete process.env.WEBINAR_ALERT_EMAIL;
}

const mod = await import("../lib/server/webinarRegistration.js");
const { default: handler, validateRegistration, registrationRow, registrationAlertEmail, WEBINAR_EVENT, HONEYPOT_FIELD } = mod;
const content = await import("../content/webinar.mjs");
const { AI_LIMITS } = await import("../lib/server/rateLimit.js");

// ---- 1. Validation -----------------------------------------------------------
section("1. Validation");
{
  const ok = validateRegistration(GOOD);
  t("a complete registration is accepted and cleaned", ok.ok && ok.value.name === "Maria Santos" && ok.value.mobile === "09171234567");
  t("email and question are optional",
    validateRegistration({ ...GOOD, email: "", question: "" }).ok &&
    validateRegistration({ ...GOOD, email: undefined, question: undefined }).value.email === null);
  t("an empty form names the four required fields, and not the optional ones",
    Object.keys(validateRegistration({}).fields).sort().join() === "distance,mobile,name,training");
  t("a name under two characters is refused", !validateRegistration({ ...GOOD, name: "M" }).ok && validateRegistration({ ...GOOD, name: " M " }).fields.name === true);
  for (const good of ["0917 123 4567", "+63 917 123 4567", "(0917) 123-4567", "0917.123.4567", "+639171234567", "1234567"]) {
    t(`mobile "${good}" is accepted`, validateRegistration({ ...GOOD, mobile: good }).ok);
  }
  for (const bad of ["", "abc", "12345", "0917-ABC-4567", "+", "12345678901234567", "0917 123 4567 ext 2", "63+9171234567"]) {
    t(`mobile "${bad}" is refused`, validateRegistration({ ...GOOD, mobile: bad }).fields?.mobile === true);
  }
  t("a malformed email is refused", validateRegistration({ ...GOOD, email: "maria@" }).fields?.email === true &&
    validateRegistration({ ...GOOD, email: "not an email" }).fields?.email === true);
  t("only the listed distances are accepted",
    content.DISTANCES.every(o => validateRegistration({ ...GOOD, distance: o.value }).ok) &&
    ["", "42k", "5K", "constructor"].every(v => validateRegistration({ ...GOOD, distance: v }).fields?.distance === true));
  t("only the listed training answers are accepted",
    content.TRAINING.every(o => validateRegistration({ ...GOOD, training: o.value }).ok) &&
    ["", "pro", "__proto__"].every(v => validateRegistration({ ...GOOD, training: v }).fields?.training === true));
  t("objects and arrays never pass as text",
    validateRegistration({ ...GOOD, name: { a: 1 } }).fields?.name === true &&
    validateRegistration({ ...GOOD, mobile: ["0917", "1234567"] }).fields?.mobile === true &&
    validateRegistration({ ...GOOD, distance: ["10k"] }).fields?.distance === true &&
    validateRegistration({ ...GOOD, question: { a: 1 } }).value.question === null);
  t("a non-object body is refused, not thrown on", [null, undefined, "x", 5].every(b => validateRegistration(b).ok === false));
  const long = validateRegistration({ ...GOOD, name: "N".repeat(500), question: "Q".repeat(5000) });
  t("long values are capped", long.value.name.length === 120 && long.value.question.length === 1000);
  const messy = validateRegistration({ ...GOOD, name: "Ma\u0000ria\r\nSan\ttos", question: "line one\r\n\r\n\r\n\r\nline two\u0007" });
  t("control characters are removed and line breaks in the question are kept",
    messy.value.name === "Ma ria San tos" && messy.value.question === "line one\n\nline two");
  const row = registrationRow(ok.value);
  t("the saved row has exactly the table's columns", Object.keys(row).sort().join() === "distance,email,event,mobile,name,question,training" && row.event === WEBINAR_EVENT);
}

// ---- 2. The browser script and the server agree ------------------------------
section("2. js/webinar.js matches the server");
{
  const sandbox = {};
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync("js/webinar.js", "utf8"), sandbox);
  const validate = sandbox.AthlevoWebinar && sandbox.AthlevoWebinar.validate;
  t("the form script exposes validate()", typeof validate === "function");
  const names = ["", "M", "Maria Santos", "  ", "Jo"];
  const mobiles = ["", "abc", "0917 123 4567", "+63 917 123 4567", "12345", "(0917) 123-4567", "12345678901234567"];
  const emails = ["", "maria@example.com", "maria@", "a b@c.d"];
  const distances = ["", "5k", "10k", "16k", "not-registered", "42k"];
  const trainings = ["", "no-plan", "loose-routine", "structured-plan", "pro"];
  let mismatches = 0, cases = 0;
  for (const name of names) for (const mobile of mobiles) for (const email of emails) for (const distance of distances) for (const training of trainings) {
    cases++;
    const server = validateRegistration({ name, mobile, email, distance, training });
    const serverFields = server.ok ? "" : Object.keys(server.fields).sort().join();
    const browserFields = Object.keys(validate({ name, mobile, email, distance, training })).sort().join();
    if (serverFields !== browserFields) mismatches++;
  }
  t(`browser and server agree on ${cases} combinations`, mismatches === 0, `${mismatches} differ`);
  const html = readFileSync("webinar.html", "utf8");
  const optionValues = (id) => [...(html.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`)) || [""])[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  t("the distance options on the page are exactly the ones the server accepts",
    optionValues("webinar-distance").join() === content.DISTANCES.map(o => o.value).join());
  t("the training options on the page are exactly the ones the server accepts",
    optionValues("webinar-training").join() === content.TRAINING.map(o => o.value).join());
}

// ---- 3. The alert email ------------------------------------------------------
section("3. Alert email");
{
  const value = validateRegistration({ ...GOOD, name: "<b>Maria</b> & Co", question: "<script>alert(1)</script>" }).value;
  const mail = registrationAlertEmail(value, ["owner@example.com"], new Date("2026-11-01T02:30:00Z"));
  t("the alert shows every answer in plain words",
    mail.html.includes("10k") && mail.html.includes("No set plan. I run when I can") && mail.text.includes("Mobile: 09171234567") && mail.text.includes("Email: maria@example.com"));
  t("anything the runner typed is escaped in the HTML", !mail.html.includes("<script>") && !mail.html.includes("<b>Maria") && mail.html.includes("&lt;script&gt;"));
  t("the time is shown in Manila", /Nov 1, 2026/.test(mail.text) && mail.text.includes("(Manila)"));
  t("a missing email and question say so",
    registrationAlertEmail(validateRegistration({ ...GOOD, email: "", question: "" }).value, ["o@example.com"]).text.includes("Email: not provided"));
  t("with nobody to send to there is no message", registrationAlertEmail(value, []) === null);
  t("a runner cannot inject headers through the name", !/\n/.test(mail.subject));
}

// ---- 4. The endpoint ---------------------------------------------------------
section("4. Endpoint");
{
  reset();
  const r = res(); await handler(post(GOOD, nextIp(), { method: "GET" }), r);
  t("only POST is allowed", r.statusCode === 405 && r.headers.Allow === "POST");
}
{
  reset();
  const r = res(); await handler(post(GOOD), r);
  t("a good registration answers ok", r.statusCode === 200 && r.body.ok === true);
  t("the answer carries nothing but ok", JSON.stringify(r.body) === '{"ok":true}');
  t("the response is never cached", r.headers["Cache-Control"] === "no-store");
  t("the registration is saved with the event, answers and no honeypot field",
    db.webinar_registrations.length === 1 &&
    db.webinar_registrations[0].row.event === WEBINAR_EVENT &&
    db.webinar_registrations[0].row.mobile === "09171234567" &&
    db.webinar_registrations[0].row.distance === "10k" &&
    !(HONEYPOT_FIELD in db.webinar_registrations[0].row));
  t("the database call uses the service key and asks for no data back",
    db.webinar_registrations[0].headers.Authorization === "Bearer service-secret" && db.webinar_registrations[0].headers.Prefer === "return=minimal");
  t("an alert goes to the owner", log.emails.length === 1 && log.emails[0].body.to.join() === "owner@example.com" && /New webinar registration: Maria Santos/.test(log.emails[0].body.subject));
}
{
  reset();
  process.env.WEBINAR_ALERT_EMAIL = "webinar@example.com, second@example.com";
  const r = res(); await handler(post(GOOD), r);
  t("WEBINAR_ALERT_EMAIL, when set, decides who is alerted", log.emails[0].body.to.join() === "webinar@example.com,second@example.com");
}
{
  reset();
  await handler(post(GOOD), res()); await handler(post(GOOD), res());
  const keys = log.emails.map(e => e.headers["Idempotency-Key"]);
  t("each registration gets its own idempotency key, so two runners are never merged", keys.length === 2 && keys[0] !== keys[1] && keys.every(k => /^webinar-/.test(k)));
}
{
  reset();
  const r = res(); await handler(post({ ...GOOD, email: "" }), r);
  t("a registration without an email is saved with a null email", r.statusCode === 200 && db.webinar_registrations[0].row.email === null);
}
{
  reset();
  const r = res(); await handler({ method: "POST", headers: { "x-forwarded-for": nextIp() }, body: JSON.stringify(GOOD) }, r);
  t("a JSON body sent as text is read", r.statusCode === 200 && db.webinar_registrations.length === 1);
}
{
  reset();
  const r = res(); await handler(post({ ...GOOD, name: "", mobile: "x", distance: "", training: "" }), r);
  t("an invalid form is refused with the fields named", r.statusCode === 400 && r.body.error === "invalid" &&
    ["name", "mobile", "distance", "training"].every(f => r.body.fields[f] === true) && !("email" in r.body.fields));
  t("an invalid form is neither saved nor emailed", db.webinar_registrations.length === 0 && log.emails.length === 0);
}
{
  reset();
  const r = res(); await handler(post("not json {{"), r);
  t("a body that is not a form is a 400, not a crash", r.statusCode === 400);
}

section("5. Spam trap");
{
  reset();
  const r = res(); await handler(post({ ...GOOD, contact_website: "https://spam.example" }), r);
  t("a filled honeypot looks like success to the bot", r.statusCode === 200 && r.body.ok === true);
  t("a filled honeypot stores nothing, emails nothing and does not even use the rate limiter",
    db.webinar_registrations.length === 0 && log.emails.length === 0 && log.tables.length === 0);
}
{
  reset();
  const r = res(); await handler(post({ ...GOOD, contact_website: "   " }), r);
  t("a honeypot holding only spaces is treated as empty", r.statusCode === 200 && db.webinar_registrations.length === 1);
}
{
  reset();
  const r = res(); await handler(post({ ...GOOD, contact_website: { a: 1 } }), r);
  t("a honeypot filled with anything non-empty trips the trap", db.webinar_registrations.length === 0 && r.statusCode === 200);
}
{
  reset();
  const r = res(); await handler(post({ ...GOOD, contact_website: "x" }, nextIp(), { form: true }), r);
  t("a bot posting the plain form is sent on to the thank-you page without storing anything",
    r.statusCode === 303 && r.headers.Location === "/webinar/thank-you" && db.webinar_registrations.length === 0 && log.emails.length === 0);
}

section("6. Rate limit");
{
  reset();
  const ip = nextIp();
  let last;
  const limit = AI_LIMITS["webinar-register"] && AI_LIMITS["webinar-register"].limit;
  t("webinar registration has its own rate limit setting", Boolean(limit) && limit >= 5 && limit <= 60, String(limit));
  for (let i = 0; i < (limit || 20) + 1; i++) { last = res(); await handler(post(GOOD, ip), last); }
  t("one visitor cannot flood the form", last.statusCode === 429 && last.body.code === "RATE_LIMITED");
  t("the blocked request is not saved", db.webinar_registrations.length === (limit || 20));
  const other = res(); await handler(post(GOOD, nextIp()), other);
  t("another visitor is not affected", other.statusCode === 200);
  const unrelated = res(); await handler(post({ ...GOOD, contact_website: "" }, ip, { form: true }), unrelated);
  t("a blocked visitor posting the plain form is sent back to the form", unrelated.statusCode === 303 && unrelated.headers.Location === "/webinar/#register");
}

section("7. Save and alert: either one is enough");
{
  reset(); dbMode = "down";
  const r = res(); await handler(post(GOOD), r);
  t("database down, email sent: the runner is registered", r.statusCode === 200 && log.emails.length === 1);
  t("a database failure never logs the key or the runner's details",
    errors.length > 0 && errors.every(e => !e.includes("service-secret") && !e.includes("Maria") && !e.includes("0917") && !e.includes("maria@")));
}
{
  reset(); dbMode = "missing";
  const r = res(); await handler(post(GOOD), r);
  t("table missing (migration not run), email sent: the runner is registered", r.statusCode === 200);
  t("the log tells you to run the migration", errors.some(e => e.includes("migrations/2026-10-27_webinar_registrations.sql")));
}
{
  reset(); dbMode = "throw";
  const r = res(); await handler(post(GOOD), r);
  t("database unreachable, email sent: the runner is registered", r.statusCode === 200);
}
{
  reset(); resendMode = "reject";
  const r = res(); await handler(post(GOOD), r);
  t("email rejected, row saved: the runner is registered", r.statusCode === 200 && db.webinar_registrations.length === 1);
}
{
  reset(); resendMode = "throw";
  const r = res(); await handler(post(GOOD), r);
  t("email unreachable, row saved: the runner is registered", r.statusCode === 200 && db.webinar_registrations.length === 1);
}
{
  reset(); delete process.env.RESEND_API_KEY;
  const r = res(); await handler(post(GOOD), r);
  t("no email key, row saved: the runner is registered", r.statusCode === 200 && db.webinar_registrations.length === 1 && log.emails.length === 0);
}
{
  reset(); delete process.env.SIGNUP_ALERT_EMAIL;
  const r = res(); await handler(post(GOOD), r);
  t("no alert address, row saved: the runner is registered", r.statusCode === 200 && db.webinar_registrations.length === 1 && log.emails.length === 0);
}
{
  reset(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = res(); await handler(post(GOOD), r);
  t("no database settings, email sent: the runner is registered", r.statusCode === 200 && log.emails.length === 1);
}
{
  reset(); dbMode = "down"; resendMode = "reject";
  const r = res(); await handler(post(GOOD), r);
  t("both fail: the runner is told, with a generic 503", r.statusCode === 503 && r.body.error === "unavailable" && !JSON.stringify(r.body).includes("service-secret"));
  t("both fail: the log says it was lost, without personal details",
    errors.some(e => /registration lost/.test(e)) && errors.every(e => !e.includes("Maria") && !e.includes("0917") && !e.includes("maria@") && !e.includes("re_test_secret")));
}
{
  reset(); delete process.env.SUPABASE_URL; delete process.env.RESEND_API_KEY;
  const r = res(); await handler(post(GOOD), r);
  t("nothing configured at all: an error, never a silent success", r.statusCode === 503);
}

section("8. Plain form post (JavaScript off)");
{
  reset();
  const r = res(); await handler(post(GOOD, nextIp(), { form: true }), r);
  t("a good plain post is redirected to the thank-you page", r.statusCode === 303 && r.headers.Location === "/webinar/thank-you" && r.ended && db.webinar_registrations.length === 1);
}
{
  reset();
  const r = res(); await handler(post({ ...GOOD, mobile: "" }, nextIp(), { form: true }), r);
  t("an invalid plain post goes back to the form", r.statusCode === 303 && r.headers.Location === "/webinar/#register" && db.webinar_registrations.length === 0);
}
{
  reset(); dbMode = "down"; resendMode = "reject";
  const r = res(); await handler(post(GOOD, nextIp(), { form: true }), r);
  t("a plain post that could not be kept goes back to the form, not to thank-you", r.statusCode === 303 && r.headers.Location === "/webinar/#register");
}

// ---- 9. Source and wiring ----------------------------------------------------
section("9. Wiring and safety");
{
  const source = readFileSync("lib/server/webinarRegistration.js", "utf8");
  t("the handler never writes to the log with console.log", !/console\.log/.test(source));
  t("no log line includes the runner's details", !/console\.error\([^)]*\b(value|row|body|checked)\b/.test(source));
  t("the honeypot field name matches the page", readFileSync("webinar.html", "utf8").includes(`name="${HONEYPOT_FIELD}"`));
  const migration = readFileSync("migrations/2026-10-27_webinar_registrations.sql", "utf8").replace(/--.*$/gm, ""); // code only, comments dropped
  t("the migration creates the table once, safely, with row-level security and no public policy",
    /create table if not exists public\.webinar_registrations/.test(migration) && /enable row level security/.test(migration) &&
    !/create policy/i.test(migration) && !/\bdrop\b|\bdelete\b|\btruncate\b/i.test(migration));
  t("the migration does not lock the form's choices into the database", !/\bcheck\s*\(/i.test(migration));
  for (const column of Object.keys(registrationRow(validateRegistration(GOOD).value))) {
    t(`the migration has the "${column}" column`, new RegExp(`^\\s+${column} `, "m").test(migration));
  }
  const gateway = readFileSync("api/providers/index.js", "utf8");
  t("the API gateway imports the handler and answers the webinar_register action",
    /import webinarRegisterHandler from "\.\.\/\.\.\/lib\/server\/webinarRegistration\.js"/.test(gateway) &&
    /action === "webinar_register"[\s\S]{0,80}webinarRegisterHandler\(request, response\)/.test(gateway));
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  t("/api/webinar/register is routed to the gateway",
    vercel.rewrites.some(r => r.source === "/api/webinar/register" && r.destination === "/api/providers?action=webinar_register"));
  t("no new function was added under api/ (the plan is at its function limit)", !existsSync("api/webinar") && !existsSync("api/webinar.js") && !existsSync("api/webinar-register.js"));
  t("the page posts to the same address the server answers on", readFileSync("webinar.html", "utf8").includes(`action="${content.SITE.registerApi}"`));
}

console.error = realError;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
