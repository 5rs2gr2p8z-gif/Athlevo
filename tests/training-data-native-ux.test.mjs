/*
 * Athlevo — native training-data onboarding UX.
 *
 * Beta users thought they were connecting Garmin directly and were confused to
 * be redirected to Intervals. This sprint makes Athlevo own the flow and turns
 * Intervals into an invisible "Sync Partner", named only in fine print.
 *
 * Executes the REAL setIntervalsUi / setTrainingDataCount against a mock DOM.
 *
 * Run: node tests/training-data-native-ux.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const brainSrc = readFileSync("./js/brain.js", "utf8");
const connect = readFileSync("./js/onboardingConnect.js", "utf8");
const train = readFileSync("./js/train.js", "utf8");

/* ── mock DOM that mirrors the real Training Data card ids ─────────────── */

function makeCard(initialState = "idle") {
  const ids = ["trainingDataRow", "trainingDataStatus", "trainingDataCopy", "trainingDataProvider",
    "trainingDataMark", "trainingDataConnect", "trainingDataDisconnect", "trainingDataReconnect",
    "trainingDataOpenPartner", "tdSource", "tdCount", "tdLatest", "tdLastSync"];
  const nodes = {};
  ids.forEach(id => { nodes[id] = { id, _text: "", style: {}, dataset: {},
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; } }; });
  nodes.trainingDataRow.dataset.state = initialState;
  return nodes;
}

function loadBrain(nodes, activities = []) {
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || null },
    window: {},
    console: { log() {}, warn() {}, error() {} },
    AthlevoDataSource: { connectionsUrl: "https://intervals.icu/settings" },
    loadAthleteActivities: async () => activities
  };
  sandbox.window = sandbox;
  // Pull the whole functional block (setIntervalsUi … openSyncPartner) out of
  // brain.js by its start and the line AFTER openSyncPartner's closing brace.
  const start = brainSrc.indexOf("function setIntervalsUi");
  const opAt = brainSrc.indexOf("function openSyncPartner");
  const end = brainSrc.indexOf("\n}", opAt) + 2;   // include openSyncPartner's body
  const slice = brainSrc.slice(start, end);
  const factory = new Function("document", "window", "console", "loadAthleteActivities",
    slice + "\nreturn { setIntervalsUi, setTrainingDataCount, openSyncPartner, fmtSyncTime };");
  return factory(sandbox.document, sandbox.window, sandbox.console, sandbox.loadAthleteActivities);
}

/* ══════════ PART 1 — the onboarding flow ═══════════════════════════ */

section("1. The connect step is Athlevo-owned, three-step, partner-hidden");
{
  const fn = connect.slice(connect.indexOf("function stepAuthorize"),
                           connect.indexOf("function stepNoWorkoutsYet"));
  t("title 'Connect your training data'", /Connect your training data/.test(fn));
  t("subtitle names platforms", /Import your workouts automatically from Garmin, COROS/.test(fn));
  t("three steps: Connect Athlevo / Authorize sync / Connect your watch",
    /Connect Athlevo/.test(fn) && /Authorize sync/.test(fn) && /Connect your watch/.test(fn));
  t("step 1 shows complete", /cf-stepline done/.test(fn));
  t("step 2 is active", /cf-stepline active/.test(fn));
  t("primary button 'Continue' launches OAuth", /onclick="AthlevoConnect\.authorize\(\)"/.test(fn));
  t("no provider named in heading/button",
    !/<h[12][^>]*>[^<]*Intervals/.test(fn) && !/<button[^>]*>[^<]*Intervals/.test(fn));
  t("partner disclosed once via serviceName", /our sync partner,\s*\$\{esc\(DS\(\)\.serviceName\)\}/.test(fn));
}

/* ══════════ PART 2 — return states ═════════════════════════════════ */

section("2. State B — connected, zero workouts");
{
  const fn = connect.slice(connect.indexOf("function stepNoWorkoutsYet"),
                           connect.indexOf("function toggleHelp"));
  t("headline does NOT say Intervals", !/<h[12][^>]*>[^<]*Intervals/.test(fn));
  t("headline 'Almost there'", /Almost there/.test(fn));
  t("says Athlevo is connected", /Athlevo is now connected/.test(fn));
  t("says no workouts received yet", /haven't received any workouts yet/.test(fn));
  t("names the final step in prose only", /connect your .* inside our sync partner/i.test(fn));
  t("primary 'Open Sync Partner'", /Open Sync Partner/.test(fn));
  t("secondary 'I'll do it later'", /I&#39;ll do it later|I'll do it later/.test(fn));
}

section("2c. State C — connected with activities (card fields)");
{
  const nodes = makeCard("connected");
  const b = loadBrain(nodes, [
    { start_date: "2026-07-22T07:42:00", distance_meters: 12600, activity_type: "Threshold" },
    { start_date: "2026-07-20T06:00:00", distance_meters: 8000, activity_type: "Easy" }
  ]);
  b.setIntervalsUi("connected");
  await b.setTrainingDataCount();
  t("source reads 'Sync Partner'", nodes.tdSource.textContent === "Sync Partner");
  t("imported count is the real number", nodes.tdCount.textContent === "2");
  t("latest activity shows type + distance", /Threshold/.test(nodes.tdLatest.textContent) &&
    /12\.6 km/.test(nodes.tdLatest.textContent), nodes.tdLatest.textContent);
  t("last sync is populated", nodes.tdLastSync.textContent && nodes.tdLastSync.textContent !== "—");
  t("status summarises the count", /2 activities imported/.test(nodes.trainingDataStatus.textContent));
}

section("3. Training Data card — zero imports");
{
  const nodes = makeCard("connected");
  const b = loadBrain(nodes, []);
  b.setIntervalsUi("connected");
  await b.setTrainingDataCount();
  t("count is 0", nodes.tdCount.textContent === "0");
  t("latest activity says 'Waiting for your first workout.'",
    nodes.tdLatest.textContent === "Waiting for your first workout.");
  t("Open Sync Partner is available while connected",
    nodes.trainingDataOpenPartner.style.display === "");
  t("Disconnect is available while connected",
    nodes.trainingDataDisconnect.style.display === "");
}

section("3b. Card controls per state");
{
  const nodes = makeCard("idle");
  const b = loadBrain(nodes, []);
  b.setIntervalsUi("idle");
  t("disconnected: Connect shown", nodes.trainingDataConnect.style.display === "");
  t("disconnected: Disconnect hidden", nodes.trainingDataDisconnect.style.display === "none");
  t("disconnected: Open Sync Partner hidden", nodes.trainingDataOpenPartner.style.display === "none");

  b.setIntervalsUi("reconnect");
  t("reconnect: Reconnect shown", nodes.trainingDataReconnect.style.display === "");

  const gotHtml = html.includes('id="trainingDataReconnect"') &&
    html.includes('id="trainingDataOpenPartner"') && html.includes('id="tdSource"');
  t("the card markup carries all the new controls", gotHtml);
  t("Open Sync Partner is wired to openSyncPartner()",
    /AthlevoBrain\.openSyncPartner\(\)/.test(html));
}

/* ══════════ PART 4 — help ══════════════════════════════════════════ */

section("4. Lightweight help, not a docs page");
{
  const fn = connect.slice(connect.indexOf("function stepNoWorkoutsYet"),
                           connect.indexOf("function toggleHelp") + 200);
  t("a 'Need help?' toggle exists", /Need help/.test(fn));
  t("copy explains the one common fix",
    /Most athletes simply need to connect .* inside our sync\s*partner/i.test(fn));
  t("offers 'Open setup guide'", /Open setup guide/.test(fn));
  t("toggleHelp just shows/hides — no navigation, no docs page",
    /function toggleHelp/.test(connect) && !/location\.href|window\.open.*help/.test(
      connect.slice(connect.indexOf("function toggleHelp"), connect.indexOf("function toggleHelp") + 200)));
}

/* ══════════ PART 5 — Train empty state ═════════════════════════════ */

section("5. Train page — never synced");
{
  const fn = train.slice(train.indexOf("function renderNoPlan"),
                         train.indexOf("function renderWeekHeader"));
  t("shows 'Waiting for your first workout.'", /Waiting for your first workout\./.test(fn));
  t("explains what to do", /Complete a workout with your connected watch/.test(fn));
  t("distinguishes 'has history but no plan' from 'never synced'",
    /No training plan yet/.test(fn) && /peekActivityCount/.test(fn));
  t("brain exposes a synchronous count peek", /function peekActivityCount/.test(brainSrc));
}

/* ══════════ PART 6 — copy hygiene ══════════════════════════════════ */

section("6. Implementation detail does not leak");
{
  // Across onboarding, Intervals is named only through serviceName (fine print).
  const literalHeadings = (connect.match(/<h[12][^>]*>[^<]*Intervals/g) || []).length;
  t("no onboarding HEADING names Intervals", literalHeadings === 0);
  t("'Sync Partner' vocabulary is used", /Sync Partner/.test(connect) || /Sync Partner/.test(html));
  t("Training Data card never shows Strava/Garmin/COROS as separate rows",
    !/<b>Strava<\/b>|<b>Garmin Connect<\/b>|<b>COROS<\/b>/.test(html));
}

/* ══════════ no OAuth regression ════════════════════════════════════ */

section("No OAuth / provider code was touched by this UX sprint");
{
  t("Continue still routes through authorize() → connect()",
    /async function authorize\(\)[\s\S]{0,400}DS\(\)\.connect\(\)/.test(connect));
  t("openSyncPartner opens the existing connections URL, no OAuth",
    /function openSyncPartner[\s\S]{0,220}connectionsUrl/.test(brainSrc) &&
    !/action=connect|oauth\/token/.test(brainSrc.slice(brainSrc.indexOf("function openSyncPartner"),
                                                      brainSrc.indexOf("function openSyncPartner") + 300)));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
