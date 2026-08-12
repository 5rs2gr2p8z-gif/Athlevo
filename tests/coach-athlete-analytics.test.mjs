/* Executable Athlete Detail Analytics aggregation + renderer checks. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildCoachAnalytics } from "../lib/server/coachAnalytics.js";
import { findSensitiveKeys } from "../lib/server/coachSanitize.js";

const source = readFileSync("./js/coachMode.js", "utf8");
const apiSource = readFileSync("./api/providers/index.js", "utf8");
let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}`);
  }
}

function dateAgo(days) {
  return new Date(Date.parse("2026-08-12T12:00:00Z") - days * 86400000).toISOString();
}

function run(days, km, pace = 360, threshold = false) {
  return {
    start_date: dateAgo(days),
    sport_type: "Run",
    activity_type: "Run",
    distance_meters: km * 1000,
    moving_time_seconds: km * pace,
    raw_data: threshold ? { recognition: { workoutType: "Threshold", confidenceLabel: "High", version: "recognition-v2" } } : {}
  };
}

function session(days, id) {
  return { id, session_date: dateAgo(days).slice(0, 10) };
}

function execution(id, status) {
  return { training_session_id: id, status };
}

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const rendererNames = [
  "analyticsChange", "renderAnalyticsLine", "renderAnalyticsVolume",
  "renderAnalyticsAdherence", "formatPace", "renderAnalyticsPerformance",
  "renderAthleteAnalytics"
];
const context = {
  _athleteAnalyticsRange: 4,
  Number,
  Math,
  String,
  esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }
};
vm.runInNewContext(
  `${rendererNames.map(extractFunction).join("\n")}
   this.renderAthleteAnalytics = renderAthleteAnalytics;`,
  context
);

console.log("\n──── Aggregation ────");
{
  const activities = [
    run(3, 12), run(8, 11), run(15, 10), run(22, 9),
    run(31, 8), run(38, 8), run(45, 7), run(52, 7),
    run(5, 10, 300, true), run(18, 10, 306, true),
    run(34, 10, 318, true), run(48, 10, 320, true)
  ];
  const sessions = [
    session(3, "c1"), session(8, "c2"), session(12, "c3"), session(17, "c4"),
    session(31, "p1"), session(38, "p2"), session(45, "p3"), session(50, "p4"),
    { id: "future", session_date: "2026-08-18" }
  ];
  const executions = [
    execution("c1", "completed"), execution("c2", "modified"),
    execution("c3", "completed"), execution("c4", "skipped"),
    execution("p1", "completed"), execution("p2", "skipped"),
    execution("p3", "skipped"), execution("p4", "skipped"),
    execution("future", "skipped")
  ];
  const analytics = buildCoachAnalytics({ activities, sessions, executions, today: "2026-08-12" });
  const four = analytics.ranges["4"];
  test("4W, 8W, and 12W ranges are available", Object.keys(analytics.ranges).join(",") === "4,8,12");
  test("running distance is aggregated without mixing other units", four.volume.available && four.volume.metric === "run_distance" && four.volume.unit === "km");
  test("volume compares current period against the real previous period", four.volume.change_pct != null && four.volume.previous_weekly_average != null);
  test("volume chart contains exactly one point per selected week", four.volume.series.length === 4);
  test("modified counts as completed and skipped remains in adherence denominator", four.adherence.pct === 75 && four.adherence.completed === 3 && four.adherence.recorded === 4);
  test("future sessions never count against adherence", four.adherence.recorded === 4);
  test("performance uses only recognized threshold sessions", four.performance.available && four.performance.metric === "threshold_pace" && four.performance.sample_size === 2);
  test("performance does not claim similar effort without HR/RPE support", !/similar effort/i.test(four.performance.interpretation));
  test("summary is deterministic and evidence-derived", /volume|adherence|threshold/i.test(four.summary) && !/crushing|optimal|guarantee/i.test(four.summary));
  test("aggregated analytics payload contains no sensitive keys", findSensitiveKeys(analytics).length === 0);
}

console.log("\n──── Partial and empty data ────");
{
  const partial = buildCoachAnalytics({
    sessions: [session(2, "a"), session(9, "b")],
    executions: [execution("a", "completed"), execution("b", "skipped")],
    today: "2026-08-12"
  }).ranges["4"];
  test("partial history preserves supported adherence", partial.adherence.available && !partial.volume.available && !partial.performance.available);
  const empty = buildCoachAnalytics({ today: "2026-08-12" }).ranges["4"];
  test("no history returns intentional insufficiency instead of zeros", !empty.has_meaningful_history && /Not enough training history/.test(empty.summary));
  const sparsePerformance = buildCoachAnalytics({ activities: [run(2, 8), run(9, 8)], today: "2026-08-12" }).ranges["4"];
  test("unrecognized runs cannot fabricate a performance trend", !sparsePerformance.performance.available);
}

console.log("\n──── UI and security wiring ────");
{
  const analytics = buildCoachAnalytics({
    activities: [run(3, 10), run(10, 9), run(32, 8), run(39, 7)],
    sessions: [session(2, "x"), session(8, "y")],
    executions: [execution("x", "completed"), execution("y", "modified")],
    today: "2026-08-12"
  });
  let html = context.renderAthleteAnalytics({ coaching_analytics: analytics, assignment_permission: "read" });
  test("Analytics is athlete-scoped with no athlete picker", !/Choose athlete|athlete picker|data-athlete/i.test(html));
  test("UI renders one compact summary and supported modules", /Last 4 weeks/.test(html) && /Training volume/.test(html) && /Adherence/.test(html) && /Performance/.test(html));
  test("unsupported performance renders a truthful state", /More comparable sessions are needed/.test(html));
  test("Analytics introduces no mutation controls", !/Add workout|Adjust session|Mark reviewed|type="submit"/.test(html));
  test("read and read_write permissions produce identical analytics", html === context.renderAthleteAnalytics({ coaching_analytics: analytics, assignment_permission: "read_write" }));
  context._athleteAnalyticsRange = 8;
  html = context.renderAthleteAnalytics({ coaching_analytics: analytics });
  test("range switching changes summary/chart context without changing athlete data", /Last 8 weeks/.test(html) && /data-analytics-range="8" aria-pressed="true"/.test(html));
  context._athleteAnalyticsRange = 4;
  test("range controls are bound locally without another athlete request", /data-analytics-range/.test(source) && /panel\.innerHTML = renderAthleteAnalytics\(ath\)/.test(source));
  const openDetail = extractFunction("openCoachAthletePage");
  test("cached Athlete Detail renders before any loading skeleton", openDetail.indexOf("if (cached)") < openDetail.indexOf("renderAthletePageLoading();"));
  test("Analytics layout remains mobile-first and bounded", /\.cm-athlete-analytics\{display:grid/.test(source) && /max-width:720px/.test(source));
  test("API still checks JWT, coach role, and active assignment before athlete load", /getCoachingUser\(tok\)/.test(apiSource) && /canAccessCoachDashboard\(profile\)/.test(apiSource) && /canCoachAccessAthlete\(assignments, user\.id, athleteId\)/.test(apiSource));
  test("historical reads stay user-scoped and raw history stays server-side", /activities\?user_id=eq\.\$\{idf\}/.test(apiSource) && /recognition:raw_data->recognition/.test(apiSource) && /buildCoachAnalytics/.test(apiSource) && /overview\.coaching_analytics/.test(apiSource));
  test("analytics history does not fetch full provider raw_data payloads", /select=start_date,sport_type,activity_type,distance_meters,moving_time_seconds,recognition:raw_data->recognition/.test(apiSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
