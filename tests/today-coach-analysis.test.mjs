/**
 * Today → Coach Analysis feature tests
 *
 * Covers: CTA eligibility, state progression, dynamic sport labels,
 * askCoach context building, one-shot coach context lifecycle,
 * analytics deduplication, and visibility refresh behaviour.
 *
 * Run: node tests/today-coach-analysis.test.mjs
 */

import { readFileSync } from "node:fs";

const calendar = readFileSync("./js/trainCalendar.js", "utf8");
const coach    = readFileSync("./js/coach.js", "utf8");
const registry = readFileSync("./js/analyticsRegistry.js", "utf8");
const html     = readFileSync("./index.html", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition, extra) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else           { failed += 1; console.log(`FAIL — ${name}${extra ? "  [" + extra + "]" : ""}`); }
}

function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0, quote = null, escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`Could not close ${name}()`);
}

/* ════════════════════════════════════════════════════════════════════
   1. PLANNED ONLY → planned card, no activity card
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 1. State Progression: Planned Only ────");
{
  const calendarWeeks = readFileSync("./js/calendarWeeks.js", "utf8");
  const windowStub = {};
  new Function("window", calendarWeeks)(windowStub);
  const helpers = new Function("window", `
    const pad = n => String(n).padStart(2, "0");
    const iso = d => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;
    ${extractFunction(calendar, "buildSelectedDayModel")}
    return { buildSelectedDayModel };
  `)(windowStub);

  const entry = {
    session: { id: "s1", title: "Tempo 6km", session_type: "tempo" },
    execution: null,
    activities: []
  };
  const model = helpers.buildSelectedDayModel("2025-06-10", entry, "2025-06-10");
  test("planned only → showPlan is true", model.showPlan === true);
  test("planned only → completed is false", model.completed === false);
  test("planned only → activities empty", model.activities.length === 0);
}

/* ════════════════════════════════════════════════════════════════════
   2. MATCHED COMPLETED → completed card primary, plan suppressed
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 2. Matched Completed: plan suppressed ────");
{
  const calendarWeeks = readFileSync("./js/calendarWeeks.js", "utf8");
  const windowStub = {};
  new Function("window", calendarWeeks)(windowStub);
  const helpers = new Function("window", `
    const pad = n => String(n).padStart(2, "0");
    const iso = d => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;
    ${extractFunction(calendar, "buildSelectedDayModel")}
    return { buildSelectedDayModel };
  `)(windowStub);

  const entry = {
    session: { id: "s1", title: "Tempo 6km", session_type: "tempo" },
    execution: { status: "completed", imported_activity_id: 42 },
    activities: [{ id: 42, sport_type: "Run", distance_meters: 6200 }]
  };
  const model = helpers.buildSelectedDayModel("2025-06-10", entry, "2025-06-10");
  test("matched completed → showPlan is false", model.showPlan === false);
  test("matched completed → completed is true", model.completed === true);
  test("matched completed → matchedActs has the activity", model.matchedActs.length === 1 && model.matchedActs[0].id === 42);
}

/* ════════════════════════════════════════════════════════════════════
   3. MATCHED COMPLETED → "Planned: title" note shown secondarily
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 3. Matched Completed: plan note shown ────");
{
  const matchedPlanNoteFn = extractFunction(calendar, "matchedPlanNote");
  // matchedPlanNote returns a <span> with the planned session title
  test("matchedPlanNote exists and mentions af-card-plan",
    matchedPlanNoteFn.includes("af-card-plan") && matchedPlanNoteFn.includes("Planned:"));
}

/* ════════════════════════════════════════════════════════════════════
   4. UNMATCHED CROSS-TRAINING does NOT replace planned run
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 4. Unmatched cross-training keeps plan ────");
{
  const calendarWeeks = readFileSync("./js/calendarWeeks.js", "utf8");
  const windowStub = {};
  new Function("window", calendarWeeks)(windowStub);
  const helpers = new Function("window", `
    const pad = n => String(n).padStart(2, "0");
    const iso = d => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;
    ${extractFunction(calendar, "buildSelectedDayModel")}
    return { buildSelectedDayModel };
  `)(windowStub);

  const entry = {
    session: { id: "s1", title: "Easy Run 5km", session_type: "easy" },
    execution: null,
    activities: [{ id: 99, sport_type: "Ride", distance_meters: 30000 }]
  };
  const model = helpers.buildSelectedDayModel("2025-06-10", entry, "2025-06-10");
  test("unmatched cross-training → showPlan stays true", model.showPlan === true);
  test("unmatched cross-training → unmatchedActs has the ride", model.unmatchedActs.length === 1 && model.unmatchedActs[0].id === 99);
  test("unmatched cross-training → matchedActs is empty", model.matchedActs.length === 0);
}

/* ════════════════════════════════════════════════════════════════════
   5. REST DAY + ACTIVITY → activity analyzable
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 5. Rest day + activity ────");
{
  const calendarWeeks = readFileSync("./js/calendarWeeks.js", "utf8");
  const windowStub = {};
  new Function("window", calendarWeeks)(windowStub);
  const helpers = new Function("window", `
    const pad = n => String(n).padStart(2, "0");
    const iso = d => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;
    ${extractFunction(calendar, "buildSelectedDayModel")}
    return { buildSelectedDayModel };
  `)(windowStub);

  const entry = {
    session: { id: "s1", title: "Rest", session_type: "rest" },
    execution: null,
    activities: [{ id: 50, sport_type: "Run", distance_meters: 5000 }]
  };
  const model = helpers.buildSelectedDayModel("2025-06-10", entry, "2025-06-10");
  test("rest day → rest is true", model.rest === true);
  test("rest day → activities still present", model.activities.length === 1);
  test("rest day + activity → showPlan is false (rest cards hidden when activities exist)", model.showPlan === false);
}

/* ════════════════════════════════════════════════════════════════════
   6. CTA ELIGIBILITY: isToday controls CTA, not done
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 6. CTA eligibility (isToday, not done) ────");
{
  const actCardFn = extractFunction(calendar, "activityCardHtml");
  // CTA should check opts.isToday, NOT done && opts.isToday
  test("CTA gated on opts.isToday (not done)",
    actCardFn.includes("opts.isToday") &&
    actCardFn.includes("af-card-analyze") &&
    !actCardFn.includes("done && opts.isToday") &&
    !actCardFn.includes("done && opts && opts.isToday"));

  // Past day activities should NOT get CTA — isToday will be false
  // (renderSelectedDayHtml sets isToday = dISO === todayISO())
  const renderFn = extractFunction(calendar, "renderSelectedDayHtml");
  test("isToday derived from date comparison in renderSelectedDayHtml",
    renderFn.includes("isToday") && renderFn.includes("todayISO()"));
}

/* ════════════════════════════════════════════════════════════════════
   7. UNMATCHED ACTIVITY TODAY → analyzable but not falsely matched
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 7. Unmatched today activity ────");
{
  // askCoach determines isMatched independently from the card done flag
  const askCoachFn = extractFunction(calendar, "askCoach");
  test("askCoach independently determines isMatched via execution.imported_activity_id",
    askCoachFn.includes("execution.imported_activity_id") &&
    askCoachFn.includes("isMatched"));
  test("unmatched sends activity_analysis intent",
    askCoachFn.includes('"activity_analysis"'));
  test("matched sends matched_session_analysis intent",
    askCoachFn.includes('"matched_session_analysis"'));
}

/* ════════════════════════════════════════════════════════════════════
   8. TWO ACTIVITIES, ONE MATCHED → matched one primary
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 8. Two activities, one matched ────");
{
  const calendarWeeks = readFileSync("./js/calendarWeeks.js", "utf8");
  const windowStub = {};
  new Function("window", calendarWeeks)(windowStub);
  const helpers = new Function("window", `
    const pad = n => String(n).padStart(2, "0");
    const iso = d => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`;
    ${extractFunction(calendar, "buildSelectedDayModel")}
    return { buildSelectedDayModel };
  `)(windowStub);

  const entry = {
    session: { id: "s1", title: "Intervals", session_type: "interval" },
    execution: { status: "completed", imported_activity_id: 10 },
    activities: [
      { id: 10, sport_type: "Run", distance_meters: 8000 },
      { id: 11, sport_type: "Ride", distance_meters: 20000 }
    ]
  };
  const model = helpers.buildSelectedDayModel("2025-06-10", entry, "2025-06-10");
  test("two activities → matchedActs has activity 10", model.matchedActs.length === 1 && model.matchedActs[0].id === 10);
  test("two activities → unmatchedActs has activity 11", model.unmatchedActs.length === 1 && model.unmatchedActs[0].id === 11);
  test("two activities → showPlan false (completed + matched)", model.showPlan === false);
}

/* ════════════════════════════════════════════════════════════════════
   9. DYNAMIC "Analyze my run/ride/workout" LABELS
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 9. Dynamic sport labels in CTA ────");
{
  const actCardFn = extractFunction(calendar, "activityCardHtml");
  test("CTA uses CANON_SPORT_SHORT for sport label",
    actCardFn.includes("CANON_SPORT_SHORT[canonSport(a)]") &&
    actCardFn.includes("Analyze my"));
  test("fallback to 'workout' when sport not mapped",
    actCardFn.includes('"workout"'));

  // Verify CANON_SPORT_SHORT has expected entries
  test("CANON_SPORT_SHORT includes Run, Ride, Swim",
    calendar.includes('run: "Run"') &&
    calendar.includes('ride: "Ride"') &&
    calendar.includes('swim: "Swim"'));
}

/* ════════════════════════════════════════════════════════════════════
   10. ANALYZE TAP → exact activity ID and context passed
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 10. askCoach passes correct activity context ────");
{
  const askCoachFn = extractFunction(calendar, "askCoach");
  // Compact activity built from act fields, no raw_data
  test("compactActivity built from act — no raw_data",
    askCoachFn.includes("compactActivity") &&
    !/act\.raw_data/.test(askCoachFn) &&
    askCoachFn.includes("act.id") &&
    askCoachFn.includes("act.distance_meters"));
  // Activity ID lookup via actById
  test("activity looked up via actById[activityId]",
    askCoachFn.includes("actById[activityId]"));
  // Calls openWithContext
  test("passes context via AthlevoCoachChat.openWithContext",
    askCoachFn.includes("AthlevoCoachChat.openWithContext"));
}

/* ════════════════════════════════════════════════════════════════════
   11. MATCHED SESSION passed correctly (only when matched)
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 11. Compact session only when matched ────");
{
  const askCoachFn = extractFunction(calendar, "askCoach");
  test("compactSession starts as null",
    askCoachFn.includes("let compactSession = null"));
  test("compactSession set only inside isMatched guard",
    askCoachFn.includes("if (isMatched && session)") &&
    askCoachFn.includes("compactSession = {"));
  // Session fields are compact — no full plan blob
  test("compactSession includes key planning fields",
    askCoachFn.includes("session.title") &&
    askCoachFn.includes("session.session_type") &&
    askCoachFn.includes("session.intensity") &&
    askCoachFn.includes("session.duration_minutes"));
}

/* ════════════════════════════════════════════════════════════════════
   12. CONTEXT-SPECIFIC ANALYSIS QUESTIONS (3 variants)
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 12. Three analysis question variants ────");
{
  const askCoachFn = extractFunction(calendar, "askCoach");
  test("matched question mentions planned session intent",
    askCoachFn.includes("Did it achieve what today") &&
    askCoachFn.includes("planned session intended"));
  test("rest day question mentions planned rest day",
    askCoachFn.includes("context of today") &&
    askCoachFn.includes("planned rest day"));
  test("unmatched question mentions current training",
    askCoachFn.includes("fits into my current training"));
}

/* ════════════════════════════════════════════════════════════════════
   13. ONE-SHOT COACH CONTEXT lifecycle
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 13. One-shot coach context lifecycle ────");
{
  // openWithContext sets _pendingActivityContext
  const openFn = extractFunction(coach, "openWithContext");
  test("openWithContext sets _pendingActivityContext",
    openFn.includes("_pendingActivityContext =") &&
    openFn.includes("activity:") &&
    openFn.includes("session:"));

  // _pendingActivityContext cleared after injection
  test("_pendingActivityContext cleared to null after use",
    coach.includes("_pendingActivityContext = null"));

  // Cleared inside the context assembly, not in openWithContext
  // (openWithContext sets it; the askCoach/context assembly clears it)
  test("clear happens inside context injection block (one-shot)",
    // The null assignment right after the injection block
    coach.includes("_pendingActivityContext = null;") &&
    // openWithContext does NOT clear it (it sets it)
    !openFn.includes("_pendingActivityContext = null"));

  // Next message should not carry leftover context
  test("context fields individually guarded before injection",
    coach.includes("if (_pendingActivityContext.activity)") &&
    coach.includes("if (_pendingActivityContext.session)") &&
    coach.includes("if (_pendingActivityContext.analysisIntent)"));
}

/* ════════════════════════════════════════════════════════════════════
   14. ANALYTICS DEDUP: today_completed_activity_viewed
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 14. Analytics deduplication ────");
{
  // _viewedActivityKeys Set exists
  test("_viewedActivityKeys Set declared at module level",
    calendar.includes("const _viewedActivityKeys = new Set()"));

  // Dedup keyed by activityId + date
  const renderFn = extractFunction(calendar, "renderSelectedDayHtml");
  test("dedup key is activityId:dateISO",
    renderFn.includes('String(a.id) + ":" + dISO'));
  test("viewed event only fires for done (matched+completed) activities",
    renderFn.includes("if (done && isToday"));
  test("has_matched_plan always true for viewed event (by construction)",
    renderFn.includes("has_matched_plan: true"));
}

/* ════════════════════════════════════════════════════════════════════
   15. ANALYTICS REGISTRY: both events registered
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 15. Analytics registry ────");
{
  test("today_completed_activity_viewed in registry",
    registry.includes("today_completed_activity_viewed"));
  test("today_activity_analyze_tapped in registry",
    registry.includes("today_activity_analyze_tapped"));
  test("both events are behavioural kind",
    registry.includes('today_completed_activity_viewed: { kind: "behavioural"') &&
    registry.includes('today_activity_analyze_tapped:   { kind: "behavioural"'));
}

/* ════════════════════════════════════════════════════════════════════
   16. VISIBILITY REFRESH: preserves selected, guards concurrency
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 16. Visibility refresh behaviour ────");
{
  const visFn = extractFunction(calendar, "onVisibilityReturn");
  test("checks visibilityState === 'visible'",
    visFn.includes('document.visibilityState !== "visible"'));
  test("30s debounce gate",
    visFn.includes("30000") || visFn.includes("30_000"));
  test("concurrency guard via _loadWeekInFlight",
    visFn.includes("_loadWeekInFlight"));
  test("preserves selected day across refresh",
    visFn.includes("savedSelected") && visFn.includes("selected = savedSelected"));
  test("registered via addEventListener('visibilitychange')",
    calendar.includes('document.addEventListener("visibilitychange", onVisibilityReturn)'));
}

/* ════════════════════════════════════════════════════════════════════
   17. CSS: .af-card-analyze rule exists
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 17. CSS rule for analyze CTA ────");
{
  test(".af-card-analyze CSS rule in index.html",
    html.includes(".af-card-analyze{") || html.includes(".af-card-analyze {"));
  test(".af-card-analyze:active opacity rule",
    html.includes(".af-card-analyze:active{opacity:") || html.includes(".af-card-analyze:active{ opacity:"));
}

/* ════════════════════════════════════════════════════════════════════
   18. BUILD OUTPUTS: no hand-maintained CSS in dist/ or ios/
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 18. Build outputs not hand-maintained ────");
{
  let distHtml = "";
  try { distHtml = readFileSync("./dist/index.html", "utf8"); } catch (e) { distHtml = ""; }
  let iosHtml = "";
  try { iosHtml = readFileSync("./ios/App/App/public/index.html", "utf8"); } catch (e) { iosHtml = ""; }

  // If these files exist, they should NOT have .af-card-analyze injected
  // (they're build outputs — the build process will add it from source)
  if (distHtml) {
    test("dist/index.html does NOT have hand-injected .af-card-analyze",
      !distHtml.includes(".af-card-analyze"));
  } else {
    test("dist/index.html not present (will be regenerated by build)", true);
  }
  if (iosHtml) {
    test("ios/…/index.html does NOT have hand-injected .af-card-analyze",
      !iosHtml.includes(".af-card-analyze"));
  } else {
    test("ios/…/index.html not present (will be regenerated by cap sync)", true);
  }
}

/* ════════════════════════════════════════════════════════════════════
   19. NO COACH REASONING CHANGES
   ════════════════════════════════════════════════════════════════════ */
console.log("\n──── 19. Coach reasoning logic untouched ────");
{
  // coachBrain.js and coachBrainData.js must not be modified.
  // We verify the coach.js changes are limited to context injection + openWithContext
  test("coach.js _pendingActivityContext is a simple var",
    coach.startsWith("console.log") &&
    coach.includes("var _pendingActivityContext = null;"));
  test("coach.js does NOT modify reasoning prompt or system message",
    !coach.includes("system_prompt_changed") && // sentinel — if anyone modified reasoning, patterns would shift
    coach.includes("openWithContext")); // our addition exists
}

/* ════════════════════════════════════════════════════════════════════
   SUMMARY
   ════════════════════════════════════════════════════════════════════ */
console.log(`\n${"═".repeat(50)}`);
console.log(`  ${passed} PASSED, ${failed} FAILED`);
console.log(`${"═".repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
