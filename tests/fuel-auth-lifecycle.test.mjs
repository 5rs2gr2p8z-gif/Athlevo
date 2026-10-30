/**
 * Athlevo Fuel — authenticated-session lifecycle regression tests.
 * Run: node tests/fuel-auth-lifecycle.test.mjs
 *
 * Regression for: a signed-in athlete opened Fuel on production and saw
 * "Sign in to use Fuel." index.html declares the Supabase client as a top-level
 * `const supabaseClient`, which is a global LEXICAL binding (readable by bare name,
 * NOT a property of window). fuel.js / aiConsent.js only read window.supabaseClient,
 * so they never found the client.
 *
 * These tests reproduce the production shape exactly — the client exists only as a
 * script-scope `const`, window.supabaseClient is undefined — and drive Fuel through
 * its public entry points (open / Try again / clearOnLogout) against a fake Supabase
 * client that enforces row-level security by the CURRENT session user.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let passed = 0, failed = 0;
function record(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}
async function scenario(name, fn) {
  // A regression may leave a flow waiting forever (e.g. a consent prompt that never resolves):
  // bound every scenario so it FAILS instead of hanging the suite.
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("scenario timed out after 10s")), 10000); });
  try { await Promise.race([fn((label, cond, detail) => record(`${name} — ${label}`, !!cond, detail)), guard]); }
  catch (e) { record(`${name} — scenario threw`, false, String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
  finally { clearTimeout(timer); }
}

const fuelSrc = readFileSync("./js/fuel.js", "utf8");
const consentSrc = readFileSync("./js/aiConsent.js", "utf8");
const authSrc = readFileSync("./js/authSupport.js", "utf8");
const indexHtml = readFileSync("./index.html", "utf8");

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(5); }
  return !!cond();
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function todayKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const SIGN_IN = "Sign in to use Fuel.";
const A = { access_token: "token-A", user: { id: "user-A" } };
const B = { access_token: "token-B", user: { id: "user-B" } };
function meal(userId, name, id) {
  return {
    id, user_id: userId, meal_name: name, meal_type: "lunch", source: "manual",
    local_date: todayKey(), logged_at: new Date().toISOString(),
    calories: 500, carbs_g: 70, protein_g: 25, fat_g: 15, fuel_meal_items: []
  };
}

function makeEl(id) {
  const classes = new Set();
  const el = {
    id, innerHTML: "", hidden: false, style: {}, scrollTop: 0, handlers: {}, attrs: {},
    classList: {
      add: (...n) => n.forEach(x => classes.add(x)),
      remove: (...n) => n.forEach(x => classes.delete(x)),
      contains: n => classes.has(n)
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] ?? null; },
    addEventListener(type, fn) { (el.handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    focus() {}, querySelector: () => null, querySelectorAll: () => []
  };
  return el;
}

/* One isolated browser-like world: fake DOM, fake fetch, fake Supabase client
   (declared as a script-scope `const`, exactly like index.html). */
function makeWorld({ session = null, sessionGate = null, clientAsWindowProp = false, loadAuthSupport = true } = {}) {
  const w = { session, sessionGate, db: { fuel_meals: [], fuel_preferences: [], training_sessions: [], activities: [] },
    queries: [], fetchCalls: [], mealGates: [] };

  const client = {
    auth: {
      async getSession() { if (w.sessionGate) await w.sessionGate; return { data: { session: w.session }, error: null }; },
      async getUser() {
        if (w.sessionGate) await w.sessionGate;
        return w.session ? { data: { user: w.session.user }, error: null }
          : { data: { user: null }, error: { message: "Auth session missing!" } };
      }
    },
    from(table) {
      const q = { eq: {}, single: false };
      const b = {
        select() { return b; }, gte() { return b; }, lte() { return b; }, order() { return b; },
        eq(col, val) { q.eq[col] = val; return b; },
        maybeSingle() { q.single = true; return b; },
        then(res, rej) { return run().then(res, rej); }
      };
      async function run() {
        // Row-level security: the database evaluates with the session of the moment the
        // request was sent, regardless of which user_id filter the client asked for.
        const asUser = w.session ? w.session.user.id : null;
        const gate = table === "fuel_meals" ? w.mealGates.shift() : null;
        w.queries.push({ table, eq: { ...q.eq }, asUser });
        const rows = (w.db[table] || [])
          .filter(r => asUser && r.user_id === asUser)
          .filter(r => Object.entries(q.eq).every(([k, v]) => r[k] === v));
        if (gate) await gate.promise;
        return { data: q.single ? (rows[0] || null) : rows, error: null };
      }
      return b;
    }
  };

  const els = {};
  for (const id of ["fuelRoot", "screen-fuel", "fuelSheet", "fuelSheetBody", "homeFuelEntry", "fuelCameraInput", "fuelLibraryInput"]) els[id] = makeEl(id);
  const doc = {
    readyState: "complete", activeElement: null,
    getElementById: id => els[id] || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, contains: () => true
  };

  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Date });
  ctx.window = ctx; ctx.self = ctx;
  ctx.document = doc;
  ctx.navigator = { onLine: true };
  ctx.addEventListener = () => {};
  ctx.AthlevoFeatureFlags = { isEnabled: () => true };
  ctx.fetch = async (url, init) => {
    w.fetchCalls.push({ url, method: init && init.method, headers: (init && init.headers) || {} });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  ctx.__client = client;
  vm.runInContext("const supabaseClient = __client;", ctx); // production shape: lexical, not a window property
  if (clientAsWindowProp) ctx.supabaseClient = client;
  if (loadAuthSupport) vm.runInContext(authSrc, ctx);        // the REAL canonical AthlevoSession helper
  vm.runInContext(fuelSrc, ctx);

  const fuel = ctx.AthlevoFuel;
  return {
    w, ctx, els, fuel, client,
    html: () => els.fuelRoot.innerHTML,
    state: () => fuel._test.runtime && fuel._test.runtime.state,
    openFuel: () => fuel.open("test"),
    clickRetry() {
      const btn = { hasAttribute: a => a === "data-fuel-retry", getAttribute: () => "1" };
      for (const fn of els["screen-fuel"].handlers.click || []) fn({ target: { closest: () => btn } });
    },
    clickMeal(id) {
      const btn = { hasAttribute: a => a === "data-fuel-meal", getAttribute: a => a === "data-fuel-meal" ? id : null };
      for (const fn of els["screen-fuel"].handlers.click || []) fn({ target: { closest: () => btn } });
    }
  };
}

/* ═════════════════ 1. the exact production bug ═════════════════ */
await scenario("signed-in user, client only a script-scope const", async ok => {
  const x = makeWorld({ session: A });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"));
  ok("window.supabaseClient is undefined (as in production)", vm.runInContext("typeof window.supabaseClient", x.ctx) === "undefined");
  ok("the bare identifier IS the client", vm.runInContext("typeof supabaseClient", x.ctx) === "object");
  x.openFuel();
  ok("meals load and render", await until(() => x.html().includes("Alice Oats")), x.html().slice(0, 200));
  ok("never shows 'Sign in to use Fuel.'", !x.html().includes(SIGN_IN));
  ok("queried only the signed-in user's rows", x.w.queries.filter(q => q.table === "fuel_meals").every(q => q.eq.user_id === "user-A" && q.asUser === "user-A"));
});

/* ═════════════════ 2. session still hydrating when Fuel opens ═════════════════ */
await scenario("session hydrating → Fuel opened → auth available → Fuel loads", async ok => {
  const gate = deferred();
  const x = makeWorld({ session: null, sessionGate: gate.promise });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"));
  x.openFuel();
  await sleep(80);
  ok("shows the calm loading state while the session restores", x.html().includes('aria-label="Loading Fuel"'));
  ok("does NOT claim the user is signed out", !x.html().includes(SIGN_IN));
  ok("no data query is sent before a session exists", x.w.queries.filter(q => q.table === "fuel_meals").length === 0);
  x.w.session = A; gate.resolve();                                     // supabase-js finishes restoring
  ok("loads the athlete's meals once auth is available", await until(() => x.html().includes("Alice Oats")), x.html().slice(0, 200));
  ok("no permanent false sign-in state", !x.html().includes(SIGN_IN));
});

/* ═════════════════ 3. truly signed out ═════════════════ */
await scenario("truly logged-out user", async ok => {
  const x = makeWorld({ session: null });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"));
  x.openFuel();
  ok("gets the sign-in state", await until(() => x.html().includes(SIGN_IN)), x.html().slice(0, 200));
  ok("offers Try again", x.html().includes('data-fuel-retry="1"'));
  ok("never queries meals without a session", x.w.queries.filter(q => q.table === "fuel_meals").length === 0);
  ok("shows no meals", !x.html().includes("Alice Oats"));
});

/* ═════════════════ 4. API calls carry the current user's token ═════════════════ */
await scenario("Fuel API calls carry the signed-in user's access token", async ok => {
  const x = makeWorld({ session: A });
  const api = x.fuel._test.runtime && x.fuel._test.runtime.api;
  ok("test seam present", typeof api === "function");
  await api("/api/fuel/meals", "POST", { meal_name: "x" });
  ok("Authorization: Bearer <user-A token>", x.w.fetchCalls[0] && x.w.fetchCalls[0].headers.Authorization === "Bearer token-A", JSON.stringify(x.w.fetchCalls[0]));
  x.w.session = B;                                                     // account switch: token must follow the session
  await api("/api/fuel/meals", "POST", { meal_name: "y" });
  ok("a different session sends its own token (nothing cached)", x.w.fetchCalls[1].headers.Authorization === "Bearer token-B");
  x.w.session = null;
  let code = null;
  try { await api("/api/fuel/meals", "POST", {}); } catch (e) { code = e && e.code; }
  ok("no session → AUTH_REQUIRED without sending a request", code === "AUTH_REQUIRED" && x.w.fetchCalls.length === 2);
});

/* ═════════════════ 5. retry works after the session becomes available ═════════════════ */
await scenario("Try again re-fetches once the session exists", async ok => {
  const x = makeWorld({ session: null });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"));
  x.openFuel();
  ok("starts at the sign-in state", await until(() => x.html().includes(SIGN_IN)));
  x.w.session = A;
  x.clickRetry();
  ok("Try again loads the meals", await until(() => x.html().includes("Alice Oats")), x.html().slice(0, 200));
  ok("sign-in message is gone", !x.html().includes(SIGN_IN));
});

/* ═════════════════ 6. logout clears Fuel state ═════════════════ */
await scenario("logout clears Fuel state", async ok => {
  const x = makeWorld({ session: A });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"));
  x.openFuel();
  await until(() => x.html().includes("Alice Oats"));
  x.clickMeal("m1");                                                   // meal detail sheet open, showing the meal
  ok("detail sheet shows the meal before logout", x.els.fuelSheetBody.innerHTML.includes("Alice Oats"), x.els.fuelSheetBody.innerHTML.slice(0, 120));
  ok("clearOnLogout is exposed", typeof x.fuel.clearOnLogout === "function");
  x.fuel.clearOnLogout();
  ok("Fuel screen no longer contains the meal", !x.html().includes("Alice Oats"));
  ok("detail sheet cleared and hidden", !x.els.fuelSheetBody.innerHTML.includes("Alice Oats") && x.els.fuelSheet.attrs["aria-hidden"] === "true");
  const st = x.state();
  ok("in-memory state emptied", st && st.meals.length === 0 && st.userId === null && st.detailMeal === null && st.loaded === false);
});

await scenario("logout while a load is in flight: late results are discarded", async ok => {
  const x = makeWorld({ session: A });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"));
  const gate = deferred(); x.w.mealGates.push(gate);
  x.openFuel();
  await until(() => x.w.queries.some(q => q.table === "fuel_meals"));
  x.fuel.clearOnLogout();                                              // athlete signs out mid-load
  gate.resolve();
  await sleep(80);
  ok("nothing from the old session is rendered", !x.html().includes("Alice Oats") && x.html() === "", x.html().slice(0, 120));
});

/* ═════════════════ 7. account switch never leaks meals ═════════════════ */
await scenario("account switch does not leak meals", async ok => {
  const x = makeWorld({ session: A });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"), meal("user-B", "Bob Bagel", "m2"));
  x.openFuel();
  await until(() => x.html().includes("Alice Oats"));

  // Even if a sign-out hook were ever missed, the next Fuel open must show only the new user.
  x.w.session = B;
  x.openFuel();
  ok("user B sees only B's meals", await until(() => x.html().includes("Bob Bagel")), x.html().slice(0, 200));
  ok("user A's meal is gone", !x.html().includes("Alice Oats"));

  x.w.session = A;                                                     // sign back in as A
  x.openFuel();
  ok("user A's meals return from the server", await until(() => x.html().includes("Alice Oats") && !x.html().includes("Bob Bagel")));
});

await scenario("a slow response for user A cannot overwrite user B", async ok => {
  const x = makeWorld({ session: A });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"), meal("user-B", "Bob Bagel", "m2"));
  const slowA = deferred(); x.w.mealGates.push(slowA);                 // A's request hangs
  x.openFuel();
  await until(() => x.w.queries.some(q => q.table === "fuel_meals"));
  x.w.session = B;                                                     // switch accounts, open Fuel again
  x.openFuel();
  ok("B's meals render", await until(() => x.html().includes("Bob Bagel")));
  slowA.resolve();                                                     // A's stale answer finally arrives
  await sleep(80);
  ok("stale A response is ignored", x.html().includes("Bob Bagel") && !x.html().includes("Alice Oats"), x.html().slice(0, 200));
});

await scenario("sign-out hook then a different user", async ok => {
  const x = makeWorld({ session: A });
  x.w.db.fuel_meals.push(meal("user-A", "Alice Oats", "m1"), meal("user-B", "Bob Bagel", "m2"));
  x.openFuel();
  await until(() => x.html().includes("Alice Oats"));
  x.fuel.clearOnLogout(); x.w.session = B;
  x.openFuel();
  ok("only B's meals appear", await until(() => x.html().includes("Bob Bagel")) && !x.html().includes("Alice Oats"));
  ok("only B's rows were requested", x.w.queries.filter(q => q.table === "fuel_meals").slice(-1)[0].eq.user_id === "user-B");
});

/* ═════════════════ 8. AI consent shares the same lookup bug ═════════════════ */
function consentWorld(row) {
  const calls = { upserts: [], reads: 0 };
  const client = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { calls.reads += 1; return { data: row, error: null }; },
        async upsert(rec) { calls.upserts.push(rec); return { error: null }; }
      };
    }
  };
  const handlers = {};
  const btn = id => ({ id, addEventListener: (t, fn) => { handlers[id] = fn; }, removeEventListener() {} });
  const modal = { classList: { add() {}, remove() {} } };
  const doc = {
    getElementById: id => id === "aiConsentModal" ? modal
      : ["aiConsentContinueBtn", "aiConsentNotNowBtn", "aiConsentLearnMoreBtn"].includes(id) ? (handlers[`__b_${id}`] ||= btn(id)) : null
  };
  const ctx = vm.createContext({ console, setTimeout });
  ctx.window = ctx; ctx.self = ctx; ctx.document = doc;
  ctx.__client = client;
  vm.runInContext("const supabaseClient = __client;", ctx);
  vm.runInContext(consentSrc, ctx);
  return { ctx, calls, handlers };
}
await scenario("AI consent persists through the script-scope client", async ok => {
  const c = consentWorld(null);
  ok("window.supabaseClient is undefined", vm.runInContext("typeof window.supabaseClient", c.ctx) === "undefined");
  const pending = c.ctx.AthlevoAiConsent.ensure({ authenticated: true, userId: "user-A", source: "fuel" });
  await until(() => typeof c.handlers.aiConsentContinueBtn === "function");
  c.handlers.aiConsentContinueBtn();                                   // athlete taps Continue
  const granted = await pending;
  ok("consent granted", granted === true);
  const rec = c.calls.upserts[0];
  ok("durably written as granted for the current consent version", rec && rec.user_id === "user-A" && rec.status === "granted" && rec.consent_version === "2", JSON.stringify(rec));
});
await scenario("AI consent already granted is read via the script-scope client", async ok => {
  const c = consentWorld({ status: "granted", consent_version: "2" });
  const granted = await c.ctx.AthlevoAiConsent.ensure({ authenticated: true, userId: "user-A", source: "fuel" });
  ok("no prompt needed", granted === true && c.calls.reads === 1 && c.calls.upserts.length === 0);
});
await scenario("AI consent withdrawal in Settings is persisted", async ok => {
  const c = consentWorld(null);
  c.ctx.athlevoSessionUserId = "user-A";
  const done = await c.ctx.AthlevoAiConsent.setStatusFromSettings(false);
  ok("withdrawal written", done === true && c.calls.upserts[0] && c.calls.upserts[0].status === "withdrawn", JSON.stringify(c.calls.upserts[0]));
});

/* ═════════════════ 9. wiring in index.html ═════════════════ */
await scenario("index.html wiring", async ok => {
  const hook = "window.AthlevoFuel.clearOnLogout();";
  ok("Fuel is cleared on logout, delete-account and every account-switch path", indexHtml.split(hook).length - 1 >= 5, String(indexHtml.split(hook).length - 1));
  const logout = indexHtml.slice(indexHtml.indexOf("async function doLogout"), indexHtml.indexOf("async function doLogout") + 9000);
  ok("doLogout clears Fuel", logout.includes(hook));
  ok("fuel.js / aiConsent.js are cache-busted past v1 so the service worker cannot serve the buggy copy",
    /js\/fuel\.js\?v=([2-9]|\d{2,})"/.test(indexHtml) && /js\/aiConsent\.js\?v=([2-9]|\d{2,})"/.test(indexHtml));
  ok("fuel.js loads after authSupport.js (canonical session helper)", indexHtml.indexOf('src="js/fuel.js') > indexHtml.indexOf('src="js/authSupport.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
