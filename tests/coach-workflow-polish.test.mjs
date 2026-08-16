/* Focused end-to-end Coach Mode workflow refinement assertions. */
import { readFileSync } from "node:fs";

const source = readFileSync("./js/coachMode.js", "utf8");
const index = readFileSync("./index.html", "utf8");
let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}

function extractFunction(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : -1;
  return source.slice(start, end > start ? end : undefined);
}

const openAthlete = extractFunction("openCoachAthletePage", "renderAthletePageLoading");
const closeAthlete = extractFunction("closeAthletePage", "athleteRaceContext");
const renderDetail = extractFunction("renderAthletePage", "metric");
const switchTab = extractFunction("switchAthleteTab", "renderAthletePage");
const workoutDialog = extractFunction("openWorkoutEditor", "saveWorkoutForm");
const workoutSave = extractFunction("saveWorkoutForm", "removeWorkout");
const noteDialog = extractFunction("openCoachNoteDeleteConfirm", "bindAthletePageActions");
const bindDetail = extractFunction("bindAthletePageActions", "openWorkoutEditor");
const globalTrainingStart = source.indexOf("function renderCoachTrain");
const globalAnalyticsStart = source.indexOf("function renderCoachTrends", globalTrainingStart);
const globalYouStart = source.indexOf("function renderCoachYou", globalAnalyticsStart);
const globalTraining = source.slice(globalTrainingStart, globalAnalyticsStart);
const globalAnalytics = source.slice(globalAnalyticsStart, globalYouStart);

console.log("\n──── Navigation and context continuity ────");
test("bottom navigation names global directories by their actual purpose",
  /screen-coach-messaging", label: "Messages"/.test(source) &&
  /screen-coach-trends",\s+label: "Analytics"/.test(source));
test("global Training opens the real athlete Training workspace",
  /openCoachAthletePage\(item\.getAttribute\("data-athlete"\), "training"\)/.test(globalTraining) &&
  !/Coming soon/.test(globalTraining));
test("global Analytics opens the real athlete Analytics workspace",
  globalAnalytics.includes('openCoachAthletePage(item.getAttribute("data-athlete"), "analytics")') &&
  !/coming next|Choose athlete|cmTrendsSelect/i.test(globalAnalytics));
test("every athlete entry activates Today before rendering Athlete Detail",
  openAthlete.indexOf('activateCoachScreen("screen-today")') < openAthlete.indexOf("if (cached)"));
test("returning to Dashboard restores the previous roster scroll position",
  /_coachDashboardScrollTop = todayScreen\.scrollTop/.test(openAthlete) &&
  /el\.scrollTop = _coachDashboardScrollTop/.test(closeAthlete));
test("switching athlete clears ranges while same-athlete returns preserve the selected tab",
  /if \(changedAthlete\) _athleteAnalyticsRange = 4/.test(openAthlete) &&
  /tab \|\| \(changedAthlete \? "overview" : _athleteDetailTab\)/.test(openAthlete));

console.log("\n──── Loading, tabs, and motion ────");
test("cold entry uses the athlete shell while same-athlete refresh keeps identity visible",
  /if \(!existingAthlete\)[\s\S]*renderAthletePageLoading\(\)[\s\S]*else[\s\S]*renderAthletePage\(\)[\s\S]*renderAthletePanelLoading\(\)/.test(openAthlete));
test("week or mutation failure stays inside the athlete panel",
  /if \(existingAthlete\) renderAthletePanelError/.test(openAthlete) &&
  /cmAthletePanelRetry/.test(source));
test("Athlete Detail uses proper tablist, tab, and tabpanel semantics",
  /role="tablist"/.test(renderDetail) && /role="tab"/.test(renderDetail) &&
  /role="tabpanel"/.test(renderDetail) && /aria-selected/.test(renderDetail));
test("tab state and keyboard navigation remain synchronized",
  /setAttribute\("aria-selected"/.test(switchTab) &&
  /ArrowRight/.test(renderDetail) && /ArrowLeft/.test(renderDetail) && /\.focus\(\)/.test(renderDetail));
test("active narrow-screen tab is deliberately scrolled into view",
  /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/.test(source));
test("workflow transitions share restrained timing and reduced-motion handling",
  /cmWorkflowIn var\(--dur-base,200ms\)/.test(source) &&
  /cmCoachDialogIn var\(--dur-base,200ms\)/.test(source) &&
  /prefers-reduced-motion:reduce/.test(source));

console.log("\n──── Mutation, notes, and accessibility ────");
test("read-only permissions still hide mutation entry points",
  /canWrite \? '<button type="button" class="cm-add-workout"/.test(source) &&
  /session && session\.can_remove && canWrite/.test(source));
test("workout sheet traps focus, supports Escape, and restores invoking focus",
  /event\.key !== "Tab"/.test(workoutDialog) && /event\.key === "Escape"/.test(workoutDialog) &&
  /returnFocus\.focus\(\)/.test(workoutDialog));
test("workout save failures restore the contextual action label",
  /var submitLabel = submit \? submit\.textContent/.test(workoutSave) &&
  /submit\.textContent = submitLabel/.test(workoutSave));
test("note deletion traps and restores focus",
  /event\.key === "Tab"/.test(noteDialog) && /returnFocus\.focus\(\)/.test(noteDialog));
test("quick-note Save is disabled until the note contains meaningful text",
  /cm-note-action cm-note-action--primary" disabled>Save/.test(source) &&
  /noteSubmit\.disabled = !noteTextarea \|\| !noteTextarea\.value\.trim\(\)/.test(bindDetail));
test("note composer stays compact until focused",
  /\.cm-note-compose textarea\{min-height:44px/.test(source) &&
  /\.cm-note-compose:focus-within textarea\{min-height:68px/.test(source));

console.log("\n──── Product and security boundaries ────");
test("Coach workflow polish does not add a new API or database route",
  !/workflow|directory/.test(source.slice(source.indexOf('async function api'), source.indexOf('function fmtVal'))) &&
  /js\/coachMode\.js\?v=18/.test(index));
test("workout writes remain athlete scoped and use the existing route",
  /api\("workout", \{ method: session \? "PATCH" : "POST", body: \{ athlete_id: _athleteDetailId/.test(workoutSave));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
