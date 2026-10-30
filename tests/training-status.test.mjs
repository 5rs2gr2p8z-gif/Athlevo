/**
 * Training status (Intervals.icu fitness/fatigue/form) for the Home card.
 * Run: node tests/training-status.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let passed = 0, failed = 0;
const test = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name + (detail ? `  [${detail}]` : "")); }
};
const section = n => console.log(`\n──── ${n} ────`);
const read = f => readFileSync(f, "utf8");

const sandbox = { console, Date, Promise, Math, Number, String, Array, Object, isFinite };
sandbox.window = sandbox;
vm.runInNewContext(read("./js/trainingStatus.js"), sandbox);
const TS = sandbox.AthlevoTrainingStatus;

/* A 43-day wellness history ending 2026-10-30; ctl/atl are functions of day index (0..42). */
function series(ctlAt, atlAt, length = 43) {
  const end = Date.parse("2026-10-30T00:00:00Z");
  return Array.from({ length }, (_, i) => {
    const idx = i + (43 - length);
    const date = new Date(end - (length - 1 - i) * 86400000).toISOString().slice(0, 10);
    const fitness = ctlAt(idx), fatigue = atlAt(idx);
    return { date, fitness, fatigue, form: fitness - fatigue };
  });
}
const lerp = (a, b, t) => a + (b - a) * t;

section("Each status");
test("Productive: fitness climbing, carrying fatigue",
  TS.classify(series(i => lerp(40, 52, i / 42), i => lerp(40, 52, i / 42) + 12)).key === "productive");
test("Peaking: fitness built then fatigue dropped (fresh, near the high)",
  TS.classify(series(i => i < 30 ? lerp(40, 60, i / 30) : lerp(60, 59, (i - 30) / 12),
                     i => i < 30 ? lerp(40, 70, i / 30) : lerp(70, 48, (i - 30) / 12))).key === "peaking");
test("Maintaining: fitness flat, form near neutral",
  TS.classify(series(() => 50, () => 52)).key === "maintaining");
test("Recovery: fresh and fitness a little under its high, not climbing",
  TS.classify(series(i => i < 14 ? lerp(48, 60, i / 14) : lerp(60, 55, (i - 14) / 28),
                     i => i < 14 ? 60 : lerp(60, 40, (i - 14) / 28))).key === "recovery");
test("Detraining: fitness fading 25% in four weeks with fresh legs",
  TS.classify(series(i => i < 14 ? 60 : lerp(60, 45, (i - 14) / 28), i => i < 14 ? 60 : lerp(60, 30, (i - 14) / 28))).key === "detraining");
test("Unproductive: heavy load while fitness goes nowhere",
  TS.classify(series(i => lerp(50, 49, i / 42), () => 63)).key === "unproductive");
test("Overreaching: fatigue far above fitness (form -35)",
  TS.classify(series(() => 50, () => 85)).key === "overreaching");
test("Overreaching: a fast ramp with form at -22",
  TS.classify(series(i => i < 35 ? 40 : lerp(40, 49, (i - 35) / 7), i => i < 35 ? 45 : lerp(45, 71, (i - 35) / 7))).key === "overreaching");

section("What the card shows");
const p = TS.classify(series(i => lerp(40, 52, i / 42), i => lerp(40, 52, i / 42) + 12));
test("the ring carries today's fitness, the note a plain-language reason",
  p.available && p.fitness === 52 && p.label === "Productive" && p.tone === "positive" && /^Fitness \+\d+ in 4 wks$/.test(p.note), JSON.stringify(p));
test("ring fill is fitness as a share of the six-week high", p.progress === 100 &&
  TS.classify(series(i => i < 20 ? 60 : lerp(60, 48, (i - 20) / 22), () => 50)).progress === 80);
test("tones: good for productive/peaking, caution for unproductive/detraining, risk for overreaching",
  TS.STATUS.productive.tone === "positive" && TS.STATUS.peaking.tone === "positive" &&
  TS.STATUS.unproductive.tone === "warning" && TS.STATUS.detraining.tone === "warning" && TS.STATUS.overreaching.tone === "risk");

section("Not enough data is never guessed");
test("no days", TS.classify([]).available === false && TS.classify(null).available === false);
test("under two weeks of history", TS.classify(series(() => 50, () => 52, 10)).available === false &&
  TS.classify(series(() => 50, () => 52, 10)).note === "Needs 2 weeks of data");
test("days without fitness are ignored",
  TS.classify(series(() => null, () => null)).available === false);
test("no fatigue figure, no status",
  TS.classify(series(() => 50, () => null).map(d => ({ ...d, form: null }))).available === false);
test("unordered input is sorted before reading", TS.classify(series(i => lerp(40, 52, i / 42), i => lerp(40, 52, i / 42) + 12).reverse()).key === "productive");

section("Loading the data");
function fresh(brain, userId = "u1") {
  const dom = {};
  const el = id => (dom[id] = dom[id] || { id, textContent: "", dataset: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, attrs: {}, handlers: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, addEventListener(type, fn) { this.handlers[type] = fn; } });
  const sb = { console, Date, Promise, Math, Number, String, Array, Object, isFinite, AthlevoBrain: brain,
    supabaseClient: { auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) } },
    document: { getElementById: el } };
  sb.window = sb;
  vm.runInNewContext(read("./js/trainingStatus.js"), sb);
  return { TS: sb.AthlevoTrainingStatus, el, sb };
}
{
  let calls = 0;
  const days = series(i => lerp(40, 52, i / 42), i => lerp(40, 52, i / 42) + 12);
  const { TS: T, el } = fresh({ loadProviderTrends: async range => { calls += 1; return { days, range }; } });
  const view = await T.render();
  test("reads the 6-week provider trends and paints the Home signal",
    view.key === "productive" && calls === 1 &&
    el("todayTrainingStatusSignalNote").textContent === "Productive" && el("todayTrainingStatusSignalValue").textContent === "52" &&
    el("todayTrainingStatusSignal").dataset.tone === "positive" && /Based on Intervals\.icu/.test(el("todayTrainingStatusSignal").attrs["aria-label"]) &&
    /^Fitness \+/.test(el("todayTrainingStatusSignalDetail").textContent));
  await T.render();
  test("a second paint within five minutes reuses the data (no extra Intervals request)", calls === 1);
  T.invalidate(); await T.render();
  test("invalidate() forces a fresh read", calls === 2);
}
{
  const err = code => Object.assign(new Error(code), { code });
  const notConnected = fresh({ loadProviderTrends: async () => { throw err("NOT_CONNECTED"); } });
  await notConnected.TS.render();
  test("not connected: says to connect training data, shows no fake status",
    notConnected.el("todayTrainingStatusSignalNote").textContent === "Connect training data" && notConnected.el("todayTrainingStatusSignalValue").textContent === "" &&
    notConnected.el("todayTrainingStatusSignal").dataset.tone === "missing");
  const reconnect = fresh({ loadProviderTrends: async () => { throw err("TRENDS_SCOPE_REQUIRED"); } });
  await reconnect.TS.render();
  test("missing permission: asks to reconnect", reconnect.el("todayTrainingStatusSignalNote").textContent === "Reconnect training data");
  const down = fresh({ loadProviderTrends: async () => { throw err("BOOM"); } });
  await down.TS.render();
  test("any other failure: 'Unavailable right now', and it is not cached",
    down.el("todayTrainingStatusSignalNote").textContent === "Unavailable right now");
  const out = fresh({ loadProviderTrends: async () => ({ days: [] }) }, null);
  await out.TS.render();
  test("signed out: no request, no status", out.el("todayTrainingStatusSignalNote").textContent === "Sign in to see this");
}
{
  const sbA = fresh({ loadProviderTrends: async () => ({ days: series(() => 50, () => 85) }) }, "athlete-A");
  const first = await sbA.TS.load();
  test("one athlete's cached status is keyed to that user", first.key === "overreaching");
}

section("Connecting from the card");
{
  const err = code => Object.assign(new Error(code), { code });
  let connected = 0;
  const off = fresh({ loadProviderTrends: async () => { throw err("NOT_CONNECTED"); } });
  off.sb.AthlevoPlan = { connectTrainingData: () => { connected += 1; } };
  await off.TS.render();
  const sig = off.el("todayTrainingStatusSignal");
  test("not connected: the signal becomes a button", sig.dataset.connect === "true" && sig.attrs.role === "button" && sig.attrs.tabindex === "0");
  sig.handlers.click();
  sig.handlers.keydown({ key: "Enter", preventDefault() {} });
  test("clicking or pressing Enter opens the connect flow", connected === 2);
  const on = fresh({ loadProviderTrends: async () => ({ days: series(() => 50, () => 52) }) });
  on.sb.AthlevoPlan = { connectTrainingData: () => { connected += 1; } };
  await on.TS.render();
  const live = on.el("todayTrainingStatusSignal");
  live.handlers.click();
  test("with a real status it is not a button and does not open the connect flow", live.dataset.connect === "false" && live.attrs.role === undefined && connected === 2);
}

section("Wired into the app");
const html = read("./index.html"), brain = read("./js/brain.js");
test("the Home card's first signal is Training status, not Readiness",
  /id="todayTrainingStatusSignal"/.test(html) && /<span class="direction-signal-name">Training status<\/span>/.test(html) &&
  !/<span class="direction-signal-name">Readiness<\/span>/.test(html) && !/id="todayReadinessSignal"/.test(html));
test("the renderer asks AthlevoTrainingStatus to paint it", /window\.AthlevoTrainingStatus\.render\(\)/.test(html));
test("the script is loaded after the trends scripts, with a version", /trendsAnalytics\.js\?v=\d+"><\/script>\s*<script src="js\/trainingState\.js\?v=\d+"><\/script>\s*<script src="js\/trainingStatus\.js\?v=\d+"><\/script>/.test(html));
test("the user is read through the global lexical supabaseClient, not window.supabaseClient (a const is not a window property)",
  /typeof supabaseClient !== "undefined" \? supabaseClient : null/.test(read("./js/trainingStatus.js")) && !/root\.supabaseClient/.test(read("./js/trainingStatus.js")));
test("logout reset clears the new signal", /setText\("todayTrainingStatusSignalNote"/.test(brain) && !/todayReadinessSignal/.test(brain));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
