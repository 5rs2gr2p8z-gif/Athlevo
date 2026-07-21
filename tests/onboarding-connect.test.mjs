/*
 * Athlevo — guided onboarding (steps 3–6).
 *
 * Loads the REAL js/activation.js + js/onboardingConnect.js into a minimal
 * DOM and drives the whole flow, asserting that the athlete never has to run
 * a command, refresh, or read a status code.
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
    return null;
  };
  const store = new Map();

  const events = [];
  const sandbox = {
    document: { getElementById: el },
    console: { log(){}, warn(){}, error(){}, debug(){} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),   // fast-forward polls
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
    readFileSync("./js/activation.js", "utf8").replace(
      /\}\)\(typeof window[\s\S]*$/, "})(root);"))(...Object.values(sandbox), g);
  new Function(...Object.keys(sandbox), "root", "AthlevoAnalytics", "AthlevoDataSource", "AthlevoActivation",
    readFileSync("./js/onboardingConnect.js", "utf8").replace(
      /\}\)\(typeof window[\s\S]*$/, "})(root);"))(
    ...Object.values(sandbox), g, g.AthlevoAnalytics, g.AthlevoDataSource, g.AthlevoActivation);

  // Compress the real 5s/90s detection cadence so the suite runs fast.
  g.AthlevoConnect._timing.pollMs = 5;
  g.AthlevoConnect._timing.maxMs = 60;
  return { api: g.AthlevoConnect, dom, g, dbEvents: events };
}

const funnel = (g) => g.AthlevoAnalytics.buffer.map(e => e.event);

/*
 * What the athlete actually reads. esc() encodes apostrophes to &#39; for
 * safety, so asserting on raw HTML would test the escaping, not the copy.
 */
const visible = (html) => String(html)
  .replace(/<[^>]+>/g, " ")
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();
const wait = (ms = 40) => new Promise(r => setTimeout(r, ms));

/* ── pipeline doubles ───────────────────────────────────────────────── */

function activities(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: "a" + i, sport_type: "run", activity_type: "Run",
    distance_meters: 10000 + i * 10, moving_time_seconds: 3000,
    start_date: new Date(now - i * DAY).toISOString()
  }));
}

function pipeline(opts = {}) {
  const calls = { sync: 0, detect: 0, refresh: 0, connect: 0 };
  return {
    calls,
    connectIntervals: async () => { calls.connect += 1; },
    refreshIntervalsStatus: async () => ({ connected: opts.connected || false }),
    providerStatus: async () => ({ connected: opts.connected || false }),
    diagnoseIntervalsQuiet: async () => {
      calls.detect += 1;
      if (opts.detectThrows && calls.detect <= (opts.detectThrows || 0)) throw new Error("network");
      const count = typeof opts.foundAfter === "number"
        ? (calls.detect >= opts.foundAfter ? (opts.count || 274) : 0)
        : (opts.count || 0);
      return {
        verdict: opts.verdict || (count ? `Intervals.icu returns ${count} activities` : "zero activities"),
        probes: { wideWindow3y: { count }, syncWindow180d: { count } }
      };
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

section("Happy path — account → device → auto-detect → auto-import → dashboard");
{
  const p = pipeline({ count: 274, foundAfter: 1 });
  const { api, dom, g } = makeWorld(p);

  await api.start();
  t("starts on the education step", /bring in your training/i.test(dom.html));
  t("explains WHY before asking for anything",
    /analyzes your previous workouts/i.test(dom.html));
  t("names the connection service exactly once, as a means",
    (dom.html.match(/Intervals\.icu/g) || []).length === 1, dom.html.match(/Intervals\.icu/g));
  t("routes to the setup screen", dom.screen === "screen-connect");
  t("hides the tab bar during setup", dom.tabbar === "none");

  api.next("account");
  t("offers BOTH 'I need an account' and 'I already have one'",
    /I need an account/.test(dom.html) && /I already have one/.test(dom.html));

  api.next("wearable");
  ["Garmin", "COROS", "Polar", "Suunto", "Strava"].forEach(w =>
    t(`offers ${w}`, dom.html.includes(w)));
  t("tells them they only need the one they use", /only need one/i.test(dom.html));

  api.pickWearable("garmin");
  t("device step is specific to the chosen watch", /Connect Garmin/.test(dom.html));
  t("gives concrete three-step instructions", (dom.html.match(/<li>/g) || []).length === 3);
  t("reassures about read-only access", /only ever reads/i.test(dom.html));

  await api.authorize();
  t("authorization goes through the data-source adapter", p.calls.connect === 1);

  // The provider returns here. Everything from now on is automatic.
  await api.resumeAfterConnect();
  await wait(120);

  t("detection ran automatically — no user action", p.calls.detect >= 1);
  t("import ran automatically — no console command", p.calls.sync === 1);
  t("derived data was rebuilt through the existing pipeline", p.calls.refresh >= 1);
  t("lands on the success screen", /We found 274 workouts/.test(dom.html));
  t("uses REAL numbers, not placeholders", /274/.test(dom.html) && !/\{|\bNaN\b|undefined/.test(dom.html));
  t("shows weekly mileage", /This week/.test(dom.html));
  t("shows longest run", /Longest run/.test(dom.html));
  t("shows most recent workout", /Most recent/.test(dom.html));

  await api.finish();
  t("Enter Dashboard reaches Today", dom.screen === "screen-today");
  t("tab bar restored", dom.tabbar === "flex");

  const f = funnel(g);
  t("funnel order is correct",
    f.indexOf("connect_step_viewed") < f.indexOf("intervals_connected") &&
    f.indexOf("intervals_connected") < f.indexOf("activities_detected") &&
    f.indexOf("activities_detected") < f.indexOf("initial_sync_started") &&
    f.indexOf("initial_sync_started") < f.indexOf("initial_sync_completed") &&
    f.indexOf("initial_sync_completed") < f.indexOf("dashboard_opened"),
    f.join(" → "));
}

/* ═════════════ watch still syncing — patient detection ══════════════ */

section("Watch hasn't pushed history yet");
{
  // Activities appear only on the 3rd probe — the flow must keep waiting.
  const p = pipeline({ count: 53, foundAfter: 3 });
  const { api, dom, g } = makeWorld(p);
  await api.resumeAfterConnect();
  await wait(200);

  t("polls repeatedly instead of failing on the first empty check", p.calls.detect >= 3);
  t("eventually detects and imports", p.calls.sync === 1);
  t("success reflects the real count", /We found 53 workouts/.test(dom.html));
  t("no technical wording anywhere in the flow",
    !/(403|401|null|undefined|API|endpoint|token|console)/i.test(dom.html), dom.html.slice(0, 120));
}

section("No workouts found at all");
{
  const p = pipeline({ count: 0 });
  const { api, dom, g } = makeWorld(p);
  await api.resumeAfterConnect();
  await wait(400);

  const seen = visible(dom.html);
  t("explains the likely reason in plain language",
    /couldn't find any workouts yet/i.test(seen) && /hasn't finished syncing/i.test(seen), seen.slice(0, 90));
  t("never says 'no activities returned'", !/no activities returned/i.test(dom.html));
  t("offers a way forward", /Check again/.test(dom.html));
  t("offers the connection settings shortcut", /Open connection settings/.test(dom.html));
  t("tracked no_activities", funnel(g).includes("no_activities"));
  t("did NOT run a pointless import", p.calls.sync === 0);
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
    const p = pipeline({ count: 10, foundAfter: 1, syncError: { code: c.code, message: c.message || "x" } });
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
  // First two detect calls throw; the retry helper must absorb them.
  const p = pipeline({ count: 100, foundAfter: 3, detectThrows: 2 });
  const { api, dom } = makeWorld(p);
  await api.resumeAfterConnect();
  await wait(400);
  t("recovers from transient detection failures without user action",
    p.calls.detect > 2, `${p.calls.detect} attempts`);
}

/* ══════════════════ survives the OAuth round-trip ═══════════════════ */

section("OAuth round-trip");
{
  const p = pipeline({});
  const { api, g } = makeWorld(p);
  await api.start();
  api.pickWearable("coros");
  t("guided setup is marked active before leaving", api.isActive() === true);
  t("chosen watch is remembered", g.sessionStorage.getItem("athlevo_guided_wearable") === "coros");

  // Simulate a full page load: fresh module instances, same sessionStorage.
  const fresh = makeWorld(pipeline({ count: 5, foundAfter: 1 }));
  fresh.g.sessionStorage.setItem("athlevo_guided_setup", "1");
  fresh.g.sessionStorage.setItem("athlevo_guided_wearable", "coros");
  t("after reload the app knows setup was in progress", fresh.api.isActive() === true);

  await fresh.api.finish();
  t("finishing clears the flag so it can't resume forever",
    fresh.g.sessionStorage.getItem("athlevo_guided_setup") === null);
}

section("OAuth return must not run the flow twice");
{
  /*
   * index.html reaches resumeAfterConnect() from TWO places on the OAuth
   * return: the ?intervals=connected handler AND routeAfterAuth() during
   * session restore. Both firing produced two detection loops and a second
   * sync that the server's lock rejects — a spurious error mid-import.
   */
  const p = pipeline({ count: 274, foundAfter: 1 });
  const { api, dom } = makeWorld(p);
  api.resumeAfterConnect();          // ?intervals=connected handler
  await wait(5);
  api.resumeAfterConnect();          // routeAfterAuth()
  await wait(200);

  t("detection runs exactly once", p.calls.detect === 1, `${p.calls.detect}`);
  t("import runs exactly once", p.calls.sync === 1, `${p.calls.sync}`);
  t("still reaches success normally", /We found 274 workouts/.test(dom.html));
}

section("The guard does not block legitimate retries");
{
  let failing = true;
  const p = pipeline({ count: 10, foundAfter: 1 });
  const realSync = p.syncIntervals;
  p.syncIntervals = async () => {
    p.calls.sync += 1;
    if (failing) throw new Error("Failed to fetch");
    return { imported: 10, withLaps: 2, failed: 0, status: "success" };
  };
  const { api, dom } = makeWorld(p);
  await api.resumeAfterConnect();
  await wait(150);
  t("a hard failure shows the error screen",
    /couldn't reach your training data/i.test(visible(dom.html)), visible(dom.html).slice(0, 80));

  failing = false;
  api.handle("retry");
  await wait(200);
  t("Try again restarts the flow after the guard released", p.calls.sync > 2, `${p.calls.sync}`);
  t("...and recovers to success", /We found 10 workouts/.test(dom.html), visible(dom.html).slice(0, 80));
}

section("Already-connected athlete skips the explanation");
{
  const p = pipeline({ connected: true, count: 42, foundAfter: 1 });
  const { api, dom } = makeWorld(p);
  await api.start();
  await wait(150);
  t("goes straight to automatic detection/import",
    p.calls.detect >= 1 && !/bring in your training/i.test(dom.html));
}

/* ═════════════════ provider-agnostic architecture ═══════════════════ */

section("Swappable provider (future direct Garmin/COROS)");
{
  const src = readFileSync("./js/onboardingConnect.js", "utf8");
  t("flow never calls a provider function directly",
    !/syncIntervals\(|connectIntervals\(|diagnoseIntervals\(/.test(
      src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "direct provider call found");
  t("everything routes through the data-source adapter",
    /DS\(\)\.connect|DS\(\)\.sync|DS\(\)\.detectActivities|DS\(\)\.status/.test(src));
  t("wearable list comes from the adapter, not hard-coded in the UI",
    /DS\(\)\.wearables\.map/.test(src));
  t("service name is injected, never literal in UI copy",
    !/Intervals\.icu/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));

  const act = readFileSync("./js/activation.js", "utf8");
  t("adapter declares all five platforms",
    ["garmin", "coros", "polar", "suunto", "strava"].every(k => act.includes(`"${k}"`)));
  t("each platform records how it is reached today (swappable)",
    /via: "intervals"/.test(act));
}

section("Analytics never blocks onboarding");
{
  const p = pipeline({ count: 9, foundAfter: 1 });
  const { api, dom, g } = makeWorld(p);
  // Make every DB write fail.
  g.supabaseClient.from = () => ({ insert: async () => { throw new Error("no table"); } });
  await api.resumeAfterConnect();
  await wait(150);
  t("a failing analytics write does not stop the import", p.calls.sync === 1);
  t("...and the athlete still reaches success", /We found 9 workouts/.test(dom.html));
  t("events are still buffered in memory", funnel(g).length > 0);
}

section("No developer surface");
{
  /*
   * Walk every screen the athlete can reach and inspect the RENDERED copy.
   * Testing the source template would let a leak hide inside an expression.
   */
  const screens = [];
  const capture = async () => {
    const p = pipeline({ count: 12, foundAfter: 1 });
    const w = makeWorld(p);
    await w.api.start();                     screens.push(visible(w.dom.html));
    w.api.next("account");                   screens.push(visible(w.dom.html));
    w.api.next("wearable");                  screens.push(visible(w.dom.html));
    w.api.pickWearable("garmin");            screens.push(visible(w.dom.html));
    await w.api.resumeAfterConnect();
    await wait(120);                         screens.push(visible(w.dom.html));

    const bad = makeWorld(pipeline({ count: 0 }));
    await bad.api.resumeAfterConnect();
    await wait(200);                         screens.push(visible(bad.dom.html));
  };
  await capture();
  const ui = screens.join("  ||  ");

  t("no screen mentions the console", !/console/i.test(ui));
  t("no screen asks the athlete to refresh", !/\brefresh\b/i.test(ui));
  t("no screen shows a function name", !/\w+\(\)/.test(ui));
  t("no screen shows a status code", !/\b(401|403|429|500|42703)\b/.test(ui));
  t("no screen shows provider jargon",
    !/\b(OAuth|API|endpoint|token|sync\(\)|null|undefined)\b/i.test(ui), ui.slice(0, 120));
  t("quiet diagnose exists so nothing prints during onboarding",
    /diagnoseIntervalsQuiet/.test(readFileSync("./js/brain.js", "utf8")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
