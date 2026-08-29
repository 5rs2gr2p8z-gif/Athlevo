/**
 * Train selected-day panel: the calendar still marks the week, but the
 * detail area under it renders ONE date.
 *
 * Run: node tests/train-selected-day.test.mjs
 */

import { readFileSync } from "node:fs";

const calendar = readFileSync("./js/trainCalendar.js", "utf8");
const calendarWeeks = readFileSync("./js/calendarWeeks.js", "utf8");
const html = readFileSync("./index.html", "utf8");
const train = readFileSync("./js/train.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}${extra ? "  [" + extra + "]" : ""}`);
  }
}

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not close ${name}()`);
}

const windowStub = {};
new Function("window", calendarWeeks)(windowStub);

const helpers = new Function("window", `
  const pad = n => String(n).padStart(2, "0");
  const iso = d => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;
  ${extractFunction(calendar, "activityDateKey")}
  ${extractFunction(calendar, "buildSelectedDayModel")}
  return { activityDateKey, buildSelectedDayModel };
`)(windowStub);

const feed = extractFunction(calendar, "renderActivityFeed");
const render = extractFunction(calendar, "render");
const selectFn = extractFunction(calendar, "select");
const goTodayFn = extractFunction(calendar, "goToday");
const openFn = extractFunction(calendar, "open");

console.log("\n──── Source: selected day replaces the week feed ────");
test("the detail renderer no longer loops seven dates",
  !/for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*7/.test(feed));
test("the calendar strip still walks seven days for markers",
  /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*7/.test(render) &&
  /tc-dot/.test(render) &&
  /statusOf\(byDate\[dISO\]\)/.test(render));
test("selecting a date re-renders in place instead of appending",
  /selected = dISO/.test(selectFn) && /render\(\)/.test(selectFn) &&
  /el\.innerHTML = renderSelectedDayHtml/.test(feed));
test("Train opens on today",
  /selected = todayISO\(\)/.test(openFn) &&
  /AthlevoTrainCalendar\.open/.test(train));
test("Today button resets selected date to today and re-renders",
  /selected = todayISO\(\)/.test(goTodayFn) && /render\(\)/.test(goTodayFn));
test("Review / View plan still open the existing activity-detail modal",
  /openModal\('\$\{/.test(calendar) &&
  /function openModal/.test(calendar) &&
  /id="trainWorkoutModal"/.test(html));

console.log("\n──── Open today / rest / future plan ────");
{
  const today = helpers.buildSelectedDayModel("2026-08-29", {
    session: { session_type: "long_run", title: "Foundation Long", duration_minutes: 105, distance_km: 18, target_rpe: "3–4", intensity: "ground" }
  }, "2026-08-29");
  test("Train today with a plan and no activity shows the planned workout",
    today.showPlan && !today.missed && !today.empty && today.activities.length === 0);
  const rest = helpers.buildSelectedDayModel("2026-08-30", {
    session: { session_type: "rest" }
  }, "2026-08-29");
  test("a rest day with no activity is a clean rest state",
    rest.rest && rest.empty === false && !rest.showPlan);
  const none = helpers.buildSelectedDayModel("2026-08-31", { activities: [] }, "2026-08-29");
  test("no plan and no activity is an empty selected-day state",
    none.empty && !none.showPlan);
  const future = helpers.buildSelectedDayModel("2026-09-02", {
    session: { session_type: "threshold", duration_minutes: 50 }
  }, "2026-08-29");
  test("a future planned day shows the plan and no missed state",
    future.showPlan && future.future && !future.missed);
}

console.log("\n──── Completed, matched, unmatched, missed ────");
{
  const matched = helpers.buildSelectedDayModel("2026-08-25", {
    session: { session_type: "easy" },
    execution: { status: "completed", imported_activity_id: "a1" },
    activities: [{ id: "a1", name: "Morning Run", sport_type: "Run" }]
  }, "2026-08-29");
  test("planned + matched completed does not also show the plan card",
    matched.completed && matched.matchedActs.length === 1 && !matched.showPlan);

  const implicit = helpers.buildSelectedDayModel("2026-08-25", {
    session: { session_type: "easy" },
    execution: { status: "completed" },
    activities: [{ id: "a9", name: "Easy" }]
  }, "2026-08-29");
  test("a completed day with one unmatched activity is treated as matched",
    implicit.matchedActs.length === 1 && !implicit.showPlan);

  const unmatched = helpers.buildSelectedDayModel("2026-08-24", {
    session: { session_type: "long_run", title: "Foundation Long" },
    activities: [
      { id: "r1", name: "Easy jog", sport_type: "Run" },
      { id: "s1", name: "Lift", sport_type: "WeightTraining" }
    ]
  }, "2026-08-29");
  test("planned + unmatched same-day activities keep both",
    unmatched.showPlan && unmatched.activities.length === 2 && unmatched.unmatchedActs.length === 2);

  const multi = helpers.buildSelectedDayModel("2026-08-24", {
    activities: [
      { id: "1", sport_type: "Run" },
      { id: "2", sport_type: "WeightTraining" },
      { id: "3", sport_type: "Run" }
    ]
  }, "2026-08-29");
  test("multiple same-day activities all stay on the selected day",
    multi.activities.length === 3 && !multi.showPlan);

  const missed = helpers.buildSelectedDayModel("2026-08-24", {
    session: { session_type: "threshold", duration_minutes: 40 }
  }, "2026-08-29");
  test("a past planned workout with no activity is missed, not dropped",
    missed.missed && missed.showPlan && missed.past);

  const completedPast = helpers.buildSelectedDayModel("2026-08-25", {
    execution: { status: "completed", imported_activity_id: "x" },
    activities: [{ id: "x", sport_type: "Run" }]
  }, "2026-08-29");
  test("a completed past day shows the imported activity without inventing a plan",
    completedPast.completed && completedPast.activities.length === 1 && !completedPast.showPlan);
}

console.log("\n──── Date isolation and timezone ────");
{
  const aug24 = helpers.buildSelectedDayModel("2026-08-24", {
    session: { session_type: "easy", session_date: "2026-08-24" },
    activities: [{ id: "24", start_date: "2026-08-24T01:00:00" }]
  }, "2026-08-29");
  const aug25 = helpers.buildSelectedDayModel("2026-08-25", {
    session: { session_type: "threshold", session_date: "2026-08-25" }
  }, "2026-08-29");
  test("Aug 24 model does not include Aug 25's session",
    aug24.session.session_date === "2026-08-24" && aug24.date === "2026-08-24");
  test("Aug 25 model does not include Aug 24's activity",
    aug25.date === "2026-08-25" && aug25.activities.length === 0);

  const manilaMorning = helpers.activityDateKey({ start_date: "2026-08-23T22:00:00.000Z" });
  test("early Manila morning stays on the local civil day, not the UTC day",
    manilaMorning === "2026-08-24", manilaMorning);
  const sliceBug = String("2026-08-23T22:00:00.000Z").slice(0, 10);
  test("the old UTC slice would have moved that activity to the previous day",
    sliceBug === "2026-08-23" && manilaMorning !== sliceBug);
  const afternoon = helpers.activityDateKey({ start_date: "2026-08-29T08:00:00.000Z" });
  test("a same-day afternoon UTC timestamp stays on Aug 29 in Manila",
    afternoon === "2026-08-29", afternoon);
}

console.log("\n──── Markup contracts ────");
test("the selected-day wrapper is the only day block written into the panel",
  /data-train-day=/.test(calendar) &&
  /el\.dataset\.selectedDay = selected/.test(feed));
test("calendar marker status still comes from the full week map",
  /function statusOf/.test(calendar) &&
  /tc-dot \$\{st/.test(render));
test("week data is still loaded for the strip, not deleted",
  /base\("training_sessions"\)/.test(calendar) &&
  /base\("activities"\)/.test(calendar) &&
  /base\("workout_execution_records"\)/.test(calendar));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
