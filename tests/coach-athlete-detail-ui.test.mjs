/*
 * Executable Athlete Detail Overview + Training renderer checks.
 * Run: node tests/coach-athlete-detail-ui.test.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("./js/coachMode.js", "utf8");
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
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated function ${name}`);
}

const functionNames = [
  "titleCase",
  "statusRow",
  "renderWeekSnapshot",
  "renderLatestActivity",
  "renderUpcomingRace",
  "renderAthleteOverview",
  "workoutMeta",
  "formatWeekRange",
  "sessionStatusLabel",
  "renderAthleteTraining"
];

const context = {
  SPORT_LABEL: {
    run: "Run",
    ride: "Ride",
    strength: "Strength",
    mobility: "Mobility"
  },
  esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  },
  attentionReasonLabel(key) {
    return String(key || "").replace(/_/g, " ");
  },
  fmtLastActive() {
    return "Yesterday";
  },
  Date,
  Number,
  String,
  Math
};

vm.runInNewContext(
  `${functionNames.map(extractFunction).join("\n")}
   this.renderAthleteOverview = renderAthleteOverview;
   this.renderAthleteTraining = renderAthleteTraining;`,
  context
);

function baseAthlete(overrides = {}) {
  return {
    athlete_id: "athlete-a",
    goal: "Sub-3 marathon",
    plan_phase: "Aerobic build",
    readiness: { status: "Good", check_in_date: "2026-08-12" },
    recovery_status: "on_track",
    training_load: 42,
    assignment_permission: "read_write",
    has_active_plan: true,
    today_key: "2026-08-12",
    week_planned_vs_completed: {
      planned_minutes: 300,
      completed_minutes: 210,
      planned_distance_km: 50,
      completed_distance_km: 32.4
    },
    training_week: {
      week_start: "2026-08-10",
      week_end: "2026-08-16",
      sessions: []
    },
    recent_activities: [],
    attention_reasons: [],
    target_event: null,
    target_date: null,
    ...overrides
  };
}

console.log("\n──── Overview states ────");
{
  const athlete = baseAthlete({
    training_week: {
      week_start: "2026-08-10",
      week_end: "2026-08-16",
      sessions: [
        { execution_status: "completed" },
        { execution_status: "modified" },
        { execution_status: "skipped" },
        { execution_status: "upcoming" }
      ]
    },
    recent_activities: [{
      sport: "run",
      date: "2026-08-11T06:00:00Z",
      distance_km: 8.2,
      duration_min: 48,
      pace_sec_per_km: 351,
      indoor: false
    }],
    attention_reasons: [{
      key: "missed_key_workout",
      explanation: "Missed threshold session yesterday"
    }],
    target_event: "Manila Half Marathon",
    target_date: "2026-10-18"
  });
  const html = context.renderAthleteOverview(athlete);
  test("full Overview keeps the approved hierarchy",
    /Current direction/.test(html) && /Current status/.test(html) &&
    /This week/.test(html) && /Latest activity/.test(html) &&
    /Needs attention/.test(html) && /Upcoming race/.test(html));
  test("attention moves above Latest Activity only when genuine",
    html.indexOf("Needs attention") < html.indexOf("Latest activity"));
  test("weekly summary counts modified as completed and uses real distance",
    /2 of 4 sessions completed/.test(html) && /32\.4 km completed/.test(html) &&
    /Modified 1/.test(html) && /Skipped 1/.test(html));
  test("latest activity includes only available useful metrics",
    /8\.2 km · 48 min · Yesterday/.test(html) && /5:51\/km/.test(html) &&
    /Completed/.test(html));
  test("race uses only existing name/date/countdown data",
    /Manila Half Marathon/.test(html) && /Oct 18/.test(html) && /days/.test(html));
}
{
  const html = context.renderAthleteOverview(baseAthlete({
    readiness: {},
    recovery_status: "unknown",
    training_load: null,
    week_planned_vs_completed: {},
    training_week: { week_start: "2026-08-10", week_end: "2026-08-16", sessions: [] }
  }));
  test("partial/no-data Overview uses quiet truthful language",
    /No recent data/.test(html) && /Building baseline/.test(html) &&
    /Not enough history/.test(html) && !/>—</.test(html));
  test("no attention remains a quiet line after Latest Activity",
    html.indexOf("Latest activity") < html.indexOf(">Attention<") &&
    /No immediate issues\./.test(html));
  test("no race omits the Upcoming Race section", !/Upcoming race/.test(html));
}

console.log("\n──── Training states ────");
const sessions = [
  { id: "s1", date: "2026-08-10", title: "Easy Run", duration_minutes: 45, target_rpe: "2–3", execution_status: "completed", can_edit: false },
  { id: "s2", date: "2026-08-11", title: "Threshold", pace_guidance: "4 × 8 min", execution_status: "modified", can_edit: false },
  { id: "s3", date: "2026-08-12", title: "Easy Run", duration_minutes: 50, execution_status: "skipped", can_edit: false },
  { id: "s4", date: "2026-08-13", title: "Recovery Run", duration_minutes: 30, execution_status: "planned", can_edit: true },
  { id: "s5", date: "2026-08-15", title: "Long Run", distance_km: 18, execution_status: "upcoming", can_edit: true }
];
{
  const html = context.renderAthleteTraining(baseAthlete({
    training_week: { week_start: "2026-08-10", week_end: "2026-08-16", sessions }
  }));
  test("Training renders exactly seven day rows including Rest",
    (html.match(/class="cm-day-row/g) || []).length === 7 && /Rest/.test(html));
  test("all execution-backed statuses remain visible",
    ["Completed", "Modified", "Skipped", "Planned", "Upcoming", "Rest"].every(status => html.includes(status)));
  test("week header is compact and uses truthful planned totals",
    /Aug 10–16/i.test(html) && /2 \/ 5 sessions complete/.test(html) && /18 km planned/.test(html));
  test("today uses the restrained is-today treatment", /cm-day-row is-today/.test(html));
  test("read_write keeps workout details and quiet add action",
    /data-workout-id="s4"/.test(html) && /\+ Add workout/.test(html) &&
    !/View-only assignment/.test(html));
  test("previous and next week controls remain available",
    /data-week-shift="-7"/.test(html) && /data-week-shift="7"/.test(html));
}
{
  const html = context.renderAthleteTraining(baseAthlete({
    assignment_permission: "read",
    training_week: { week_start: "2026-08-10", week_end: "2026-08-16", sessions }
  }));
  test("read-only Training remains navigable/detail-capable without mutation CTA",
    /data-workout-id="s1"/.test(html) && /View-only assignment/.test(html) &&
    !/\+ Add workout/.test(html));
}
{
  const html = context.renderAthleteTraining(baseAthlete({
    has_active_plan: false,
    assignment_permission: "read"
  }));
  test("no-plan Training shows the truthful athlete-scoped empty state",
    /No active training plan\./.test(html) && /view-only/.test(html) &&
    !/Coming soon/.test(html));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
