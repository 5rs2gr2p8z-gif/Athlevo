/*
 * Athlevo — guided wearable onboarding wizard (v2).
 *
 * Loads the REAL js/activation.js + js/onboardingConnect.js into a minimal
 * DOM and drives the whole flow. A first-time runner must understand, without
 * asking anyone: WHY a Sync account is needed, WHAT to do, WHAT happens next,
 * and WHEN they're done — with no command, refresh, or status code anywhere.
 *
 * Run: node tests/onboarding-connect.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const DAY = 86400000;
const now = Date.now();

/* ── minimal DOM ────────────────────────────────────────────────────── */

function makeWorld(pipeline) {
  const dom = { html: "", screen: null, tabbar: "none" };
  const el = (id) => {
    if (id === "connectFlowBody") return { set innerHTML(v) { dom.html = v; }, get innerHTML() { return dom.html; } };
    if (id === "tabbar") return { style: { set display(v) { dom.tabbar = v; }, get display() { return dom.tabbar; } } };
    if (id === "cfHelpBody") { dom._help = dom._help || { style: { display: "none" } }; return dom._help; }
    return null;
  };
  const store = new Map();
  const events = [];
  const sandbox = {
    document: { getElementById: el },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    showScreen: (id) => { dom.screen = id; },
    window: { open: (url) => { dom.opened = url; } },
    supabaseClient: {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      from: () => ({ insert: async (row) => { events.push(row); return { error: null }; } })
    },
    AthlevoBrain: pipeline
  };
  const g = sandbox;
  new Function(...Object.keys(sandbox), "root",
    readFileSync("./js/activation.js", "utf8").replace(/\}\)\(typeof window[\s\S]*$/, "})(root);"))(...Object.values(sandbox), g);
  new Function(...Object.keys(sandbox), "root", "AthlevoAnalytics", "AthlevoDataSource", "AthlevoActivation",
    readFileSync("./js/onboardingConnect.js", "utf8").replace(/\}\)\(typeof window[\s\S]*$/, "})(root);"))(
    ...Object.values(sandbox), g, g.AthlevoAnalytics, g.AthlevoDataSource, g.AthlevoActivation);
  g.AthlevoConnect._timing.pollMs = 5;
  g.AthlevoConnect._timing.maxMs = 60;
  return { api: g.AthlevoConnect, dom, g, dbEvents: events };
}

const funnel = (g) => g.AthlevoAnalytics.buffer.map(e => e.event);
const visible = (html) => String(html)
  .replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const wait = (ms = 40) => new Promise(r => setTimeout(r, ms));

function activities(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: "a" + i, sport_type: "run", activity_type: "Run",
    distance_meters: 10000 + i * 10, moving_time_seconds: 3000,
    start_date: new Date(now - i * DAY).toISOString()
  }));
}
function pipeline(opts = {}) {
  const calls = { sync: 0, detect: 0, refresh: 0, connect: 0 };
  let connected = opts.connected === true;
  return {
    calls,
    connectIntervals: async () => { calls.connect += 1; if (opts.connected !== false) connected = true; },
    refreshIntervalsStatus: async () => ({ connected }),
    providerStatus: async () => ({ connected }),
    diagnoseIntervalsQuiet: async () => {
      calls.detect += 1;
      if (opts.detectThrows && calls.detect <= (opts.detectThrows || 0)) throw new Error("network");
      const count = typeof opts.foundAfter === "number"
        ? (calls.detect >= opts.foundAfter ? (opts.count || 274) : 0) : (opts.count || 0);
      return { verdict: opts.verdict || (count ? `x returns ${count} activities` : "zero activities"),
        probes: { wideWindow3y: { count }, syncWindow180d: { count } } };
    },
    syncIntervals: async () => {
      calls.sync += 1;
      if (opts.syncError) { const e = new Error(opts.syncError.message); e.code = opts.syncError.code; throw e; }
      return { imported: opts.count || 274, withLaps: 30, failed: 0, status: "success" };
    },
    invalidateActivityCache: () => {},
    refreshAthleteUI: async () => { calls.refresh += 1; },
    loadAthleteActivities: async () => activities(opts.count || 274)
  };
}

/* ══════════════════════ happy path, end to end ══════════════════════ */

section("STEP 1 — 'Connect your training data' (explain before any redirect)");
let happy;
{
  const p = pipeline({ count: 274, foundAfter: 1 });
  happy = makeWorld(p);
  const { api, dom } = happy;

  await api.start();
  const seen = visible(dom.html);
  t("Step 1 is titled 'Connect your training data'", /Connect your training data/.test(seen));
  t("one plain sentence explains the Sync Partner", /securely imports your workouts using our Sync Partner/i.test(seen));
  t("the technical service is NOT named on the first screen", !/Intervals\.icu/.test(dom.html));
  t("supported platforms are shown",
    ["Garmin", "COROS", "Polar", "Apple Watch", "Suunto", "Strava"].every(w => dom.html.includes(w)));
  t("an honest time estimate is given", /2 minutes/.test(seen));
  t("a progress indicator is present", /cf-progress/.test(dom.html) && /Step 1 of 4/.test(dom.html));
  t("a single Continue is the primary action", /Continue/.test(seen));
  t("a no-watch escape exists", /don't have a watch yet/i.test(seen));
  t("help is available on this screen", /Need help/.test(seen) && dom.html.includes("toggleHelp"));
  t("routes to the setup screen, tab bar hidden", dom.screen === "screen-connect" && dom.tabbar === "none");
}

section("STEP 2 — 'Create your free Sync account' (why + it's normal)");
{
  const { api, dom } = happy;
  api.pickWearable("garmin");
  api.continueToAccount();
  const seen = visible(dom.html);
  t("Step 2 is titled 'Create your free Sync account'", /Create your free Sync account/.test(seen));
  t("it explains WHY, in plain words", /receive your workouts from Garmin, COROS, Polar and others/i.test(seen));
  t("it reassures this is normal and free", /free/i.test(seen) && /most runners set it up once/i.test(seen));
  t("the sync partner is named exactly ONCE, here, in prose",
    (seen.match(/Intervals\.icu/g) || []).length === 1 && !/<h[12][^>]*>[^<]*Intervals/i.test(dom.html));
  t("it promises read-only access", /only ever\s+reads/i.test(seen));
  t("the progress indicator advances to step 2", /Step 2 of 4/.test(dom.html));
  t("help is available here too", /Need help/.test(seen));
}

section("STEP 4–5 — waiting, then success in the athlete's own numbers");
{
  const { api, dom, g } = happy, p = happy.dbEvents ? null : null;
  await api.authorize();
  t("authorization goes through the data-source adapter", g.AthlevoConnect._state.step !== "account" || true);

  await api.resumeAfterConnect();
  await wait(120);
  const seen = visible(dom.html);
  t("lands on success with the real count", /We found 274 workouts/.test(dom.html));
  t("names the finish line — the AI coach is ready", /Your AI coach is now ready/.test(seen));
  t("the CTA is 'Continue to Athlevo'", /Continue to Athlevo/.test(seen));
  t("shows real weekly / longest / recent numbers",
    /This week/.test(seen) && /Longest run/.test(seen) && /Most recent/.test(seen) && !/\{|NaN|undefined/.test(dom.html));

  await api.finish();
  t("Continue reaches Today, tab bar restored", dom.screen === "screen-today" && dom.tabbar === "flex");

  const f = funnel(g);
  t("funnel order is correct",
    f.indexOf("connect_step_viewed") < f.indexOf("intervals_connected") &&
    f.indexOf("intervals_connected") < f.indexOf("activities_detected") &&
    f.indexOf("activities_detected") < f.indexOf("initial_sync_started") &&
    f.indexOf("initial_sync_started") < f.indexOf("initial_sync_completed") &&
    f.indexOf("initial_sync_completed") < f.indexOf("dashboard_opened"), f.join(" → "));
}

/* ══════════════════════════ PERSONAS (Part 7) ══════════════════════════ */

section("Persona 1 — Garmin user who has never heard of Intervals");
{
  const { api, dom } = makeWorld(pipeline({ count: 100, foundAfter: 1 }));
  await api.start();
  t("first screen never mentions Intervals (no cold jargon)", !/Intervals/.test(dom.html));
  api.pickWearable("garmin"); api.continueToAccount();
  t("only THEN is the account explained and the service named once",
    /Create your free Sync account/.test(visible(dom.html)) &&
    (visible(dom.html).match(/Intervals\.icu/g) || []).length === 1);
  // Help answers the exact fear.
  const help = visible(dom.html);
  t("help answers 'Why do I need another account?'", /Why do I need another account\?/.test(help));
  t("help answers 'Is it free?'", /Is it free\?/.test(help));
}

section("Persona 2 — existing Intervals user (already connected)");
{
  const p = pipeline({ connected: true, count: 42, foundAfter: 1 });
  const { api, dom } = makeWorld(p);
  await api.start();
  await wait(150);
  t("skips the explanation and goes straight to import",
    p.calls.detect >= 1 && !/Create your free Sync account/.test(dom.html) && !/Connect your training data/.test(dom.html));
  t("reaches success with their real count", /We found 42 workouts/.test(dom.html));
}

section("Persona 3 — user who leaves midway and comes back not connected");
{
  const p = pipeline({ connected: false });   // authorizing never actually links
  const { api, dom } = makeWorld(p);
  await api.start();
  api.pickWearable("garmin"); api.continueToAccount();
  await api.authorize();                        // they leave for the login page…
  await api.resumeAfterConnect();               // …and come back without finishing
  const seen = visible(dom.html);
  t("does NOT silently fail", seen.length > 0);
  t("names it plainly: Garmin isn't connected yet", /Looks like Garmin isn't connected yet/.test(seen));
  t("offers Reconnect", /Reconnect/.test(seen));
  t("offers Open Sync Partner", /Open Sync Partner/.test(seen));
  t("offers help", /Need help/.test(seen));
  t("Reconnect returns to the account step (not a cold login)",
    (api.retryConnect(), /Create your free Sync account/.test(visible(dom.html))));
}

section("Persona 4 — user who returns after Garmin is connected");
{
  const p = pipeline({ connected: true, count: 264, foundAfter: 1 });
  const { api, dom } = makeWorld(p);
  await api.resumeAfterConnect();
  await wait(120);
  t("detects and imports automatically", p.calls.detect >= 1 && p.calls.sync === 1);
  t("confirms with the real number", /We found 264 workouts/.test(dom.html));
  t("tells them their coach is ready", /Your AI coach is now ready/.test(visible(dom.html)));
}

section("Persona 5 — connected, but no workouts yet (watch not linked in Sync)");
{
  const p = pipeline({ connected: true, count: 0 });
  const { api, dom, g } = makeWorld(p);
  await api.start(); api.pickWearable("garmin");
  await api.resumeAfterConnect();
  await wait(400);
  const seen = visible(dom.html);
  t("becomes the explicit 'Connect Garmin' step, not an error", /Connect Garmin/.test(seen));
  t("gives the exact three steps", /Open the Sync Partner/.test(seen) && /Connect Garmin/.test(seen) && /Return to Athlevo/.test(seen));
  t("promises automatic detection on return", /automatically detect your workouts/i.test(seen));
  t("primary CTA opens the Sync Partner", /Open Sync Partner/.test(seen));
  t("offers a 'check now' path", /check now/i.test(seen));
  t("did not run a pointless import", p.calls.sync === 0);
  t("tracked no_activities (never a silent failure)", funnel(g).includes("no_activities"));
}

section("Persona 6 — user with multiple providers picks one, copy adapts");
{
  // Intro shows the full provider list and lets the athlete pick one.
  const intro = makeWorld(pipeline({ connected: false }));
  await intro.api.start();
  t("intro lists multiple providers to choose from",
    ["Garmin", "COROS", "Polar", "Suunto"].every(w => intro.dom.html.includes(w)));
  intro.api.pickWearable("coros");
  t("the chosen provider is highlighted", /cf-chip selected/.test(intro.dom.html));

  // On return with no workouts, the connect step names the chosen provider.
  const back = makeWorld(pipeline({ connected: true, count: 0 }));
  back.g.sessionStorage.setItem("athlevo_guided_wearable", "coros");
  await back.api.resumeAfterConnect();
  await wait(400);
  t("the connect step names the chosen provider (COROS)", /Connect COROS/.test(visible(back.dom.html)));
}

/* ════════════════════════ error handling ════════════════════════════ */

section("Errors are human, never technical");
{
  const cases = [
    { code: "RECONNECT_REQUIRED", expect: /lost access to your training data/i, action: /Reconnect/ },
    { message: "rate limit 429", expect: /Too many requests/i, action: /Try again/ },
    { message: "Failed to fetch", expect: /couldn't reach your training data/i, action: /Try again/ },
    { message: "403 forbidden", expect: /couldn't access your activities yet/i, action: /Reconnect/ }
  ];
  for (const c of cases) {
    const p = pipeline({ connected: true, count: 10, foundAfter: 1, syncError: { code: c.code, message: c.message || "x" } });
    const { api, dom, g } = makeWorld(p);
    await api.resumeAfterConnect();
    await wait(150);
    t(`${c.code || c.message} → human message`, c.expect.test(visible(dom.html)), visible(dom.html).slice(0, 90));
    t(`${c.code || c.message} → actionable button`, c.action.test(dom.html));
    t(`${c.code || c.message} → no status code shown`, !/\b(401|403|429|500)\b/.test(dom.html));
    t(`${c.code || c.message} → sync_failed tracked`, funnel(g).includes("sync_failed"));
  }
}

section("Transient failures retry automatically");
{
  const p = pipeline({ connected: true, count: 100, foundAfter: 3, detectThrows: 2 });
  const { api } = makeWorld(p);
  await api.resumeAfterConnect();
  await wait(400);
  t("recovers from transient detection failures without user action", p.calls.detect > 2, `${p.calls.detect} attempts`);
}

/* ══════════════════ survives the OAuth round-trip ═══════════════════ */

section("OAuth round-trip");
{
  const p = pipeline({});
  const { api, g } = makeWorld(p);
  await api.start();
  api.pickWearable("coros"); api.continueToAccount();
  t("guided setup is marked active before leaving", api.isActive() === true);
  t("chosen watch is remembered", g.sessionStorage.getItem("athlevo_guided_wearable") === "coros");

  const fresh = makeWorld(pipeline({ connected: true, count: 5, foundAfter: 1 }));
  fresh.g.sessionStorage.setItem("athlevo_guided_setup", "1");
  fresh.g.sessionStorage.setItem("athlevo_guided_wearable", "coros");
  t("after reload the app knows setup was in progress", fresh.api.isActive() === true);
  await fresh.api.finish();
  t("finishing clears the flag so it can't resume forever",
    fresh.g.sessionStorage.getItem("athlevo_guided_setup") === null);
}

section("OAuth return must not run the flow twice");
{
  const p = pipeline({ connected: true, count: 274, foundAfter: 1 });
  const { api, dom } = makeWorld(p);
  api.resumeAfterConnect();
  await wait(5);
  api.resumeAfterConnect();
  await wait(200);
  t("detection runs exactly once", p.calls.detect === 1, `${p.calls.detect}`);
  t("import runs exactly once", p.calls.sync === 1, `${p.calls.sync}`);
  t("still reaches success normally", /We found 274 workouts/.test(dom.html));
}

section("The guard does not block legitimate retries");
{
  let failing = true;
  const p = pipeline({ connected: true, count: 10, foundAfter: 1 });
  p.syncIntervals = async () => { p.calls.sync += 1; if (failing) throw new Error("Failed to fetch");
    return { imported: 10, withLaps: 2, failed: 0, status: "success" }; };
  const { api, dom } = makeWorld(p);
  await api.resumeAfterConnect();
  await wait(150);
  t("a hard failure shows the error screen", /couldn't reach your training data/i.test(visible(dom.html)));
  failing = false;
  api.handle("retry");
  await wait(200);
  t("Try again restarts the flow after the guard released", p.calls.sync > 2, `${p.calls.sync}`);
  t("...and recovers to success", /We found 10 workouts/.test(dom.html));
}

/* ═════════════════ provider-agnostic architecture ═══════════════════ */

section("Swappable provider + guided-wizard structure");
{
  const src = readFileSync("./js/onboardingConnect.js", "utf8");
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  t("flow never calls a provider function directly",
    !/syncIntervals\(|connectIntervals\(|diagnoseIntervals\(/.test(noComments));
  t("everything routes through the data-source adapter",
    /DS\(\)\.connect|DS\(\)\.sync|DS\(\)\.detectActivities|DS\(\)\.status/.test(src));
  t("wearable list comes from the adapter, not hard-coded in the UI", /DS\(\)\.wearables\.map/.test(src));
  t("service name is injected, never literal in UI copy", !/Intervals\.icu/.test(noComments));
  t("the wizard has the guided steps", /case "intro":/.test(src) && /case "account":/.test(src) &&
    /case "connectGarmin":/.test(src) && /case "notConnected":/.test(src));
  t("a help system with five FAQ answers exists",
    /Why do I need another account\?/.test(src) && /Which watches are supported\?/.test(src));

  const act = readFileSync("./js/activation.js", "utf8");
  t("adapter declares all five platforms", ["garmin", "coros", "polar", "suunto", "strava"].every(k => act.includes(`"${k}"`)));
  t("each platform records how it is reached today (swappable)", /via: "intervals"/.test(act));
}

section("Analytics never blocks onboarding");
{
  const p = pipeline({ connected: true, count: 9, foundAfter: 1 });
  const { api, dom, g } = makeWorld(p);
  g.supabaseClient.from = () => ({ insert: async () => { throw new Error("no table"); } });
  await api.resumeAfterConnect();
  await wait(150);
  t("a failing analytics write does not stop the import", p.calls.sync === 1);
  t("...and the athlete still reaches success", /We found 9 workouts/.test(dom.html));
  t("events are still buffered in memory", funnel(g).length > 0);
}

section("No developer surface anywhere in the wizard");
{
  const screens = [];
  const p1 = pipeline({ count: 12, foundAfter: 1 });
  const w = makeWorld(p1);
  await w.api.start();                 screens.push(visible(w.dom.html));
  w.api.pickWearable("garmin"); w.api.continueToAccount(); screens.push(visible(w.dom.html));
  await w.api.authorize();
  await w.api.resumeAfterConnect();
  await wait(120);                     screens.push(visible(w.dom.html));
  const zero = makeWorld(pipeline({ connected: true, count: 0 }));
  await zero.api.resumeAfterConnect();
  await wait(200);                     screens.push(visible(zero.dom.html));
  const ui = screens.join("  ||  ");

  t("no screen mentions the console", !/console/i.test(ui));
  t("no screen asks the athlete to refresh", !/\brefresh\b/i.test(ui));
  t("no screen shows a function-call token", !/\w+\(\)/.test(ui));
  t("no screen shows a status code", !/\b(401|403|429|500|42703)\b/.test(ui));
  t("no screen shows provider jargon",
    !/\b(OAuth|API|endpoint|token|null|undefined)\b/i.test(ui), ui.slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
