import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = read("index.html");
const coachMode = read("js/coachMode.js");
const dashboard = read("js/coachDashboard.js");
const coach = read("js/coach.js");
const athleteMode = read("js/athleteMode.js");
const calendar = read("js/trainCalendar.js");
const sheet = read("js/sheet.js");

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS — ${name}`);
}

test("public You renders Training Data directly into Preferences", () => {
  const start = html.indexOf('<div id="syncStatusCard"></div>');
  const end = html.indexOf('id="youPreferencesHeading"', start);
  const between = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(between, /Workspace|dashboard|youWorkspace/);
  assert.doesNotMatch(html, /youWorkspaceSection|youWorkspaceSpacer/);
});

test("legacy dashboard cannot inject a public Profile action", () => {
  assert.doesNotMatch(dashboard, /function injectEntry|Open coach dashboard|insertBefore\(btn/);
  assert.doesNotMatch(dashboard, /function myRole|from\("profiles"\)/);
});

test("all workspace entry uses one server-confirmed client authority", () => {
  assert.match(coachMode, /function canAccessCoachWorkspace\(\)[\s\S]{0,180}_appMode === "coach_mode"[\s\S]{0,100}roleCanUseCoachWorkspace\(_role\)/);
  assert.match(coachMode, /canAccessCoachWorkspace: canAccessCoachWorkspace/);
  assert.match(dashboard, /AthlevoCoachMode\.canAccessCoachWorkspace\(\)/);
  assert.match(coachMode, /function injectAthleteYouSwitcher\(\)[\s\S]{0,220}if \(!canAccessCoachWorkspace\(\)\)/);
});

test("authorized switcher is inserted only beside real Profile content", () => {
  assert.match(coachMode, /getElementById\("youPreferencesHeading"\)/);
  assert.match(coachMode, /insertBefore\(switcher, preferencesHeading\)/);
  assert.match(coachMode, /querySelector\("#cmAthleteSwitcher"\)/);
});

test("Android keeps native scrolling while bounding recurring paint", () => {
  assert.match(html, /html\.athlevo-native-android \.screen,[\s\S]{0,150}scroll-behavior:auto/);
  assert.match(html, /html\.athlevo-native-android \.trend-chart\{contain:layout paint\}/);
  assert.match(html, /html\.athlevo-native-android \.asc-mini-area,[\s\S]{0,100}filter:none/);
  assert.match(html, /html\.athlevo-native-android \.skel-line,[\s\S]{0,180}animation:none/);
  assert.doesNotMatch(coachMode, /cm-athlete-page--ready\{[^}]*will-change/);
});

test("chat scroll work is passive and frame-coalesced", () => {
  assert.match(coach, /scrollFrame !== null[\s\S]{0,180}requestAnimationFrame/);
  assert.match(coach, /addEventListener\("scroll", _coachScrollListener, \{ passive: true \}\)/);
  assert.match(athleteMode, /_threadScrollFrame !== null[\s\S]{0,180}requestAnimationFrame/);
  assert.match(athleteMode, /addEventListener\("scroll", function \(\)[\s\S]{0,420}\{ passive: true \}/);
});

test("gesture intent favors vertical scroll and cleans up cancellation", () => {
  assert.match(calendar, />= 12/);
  assert.match(calendar, /Math\.abs\(dx\) > Math\.abs\(dy\) \* 1\.35/);
  assert.match(calendar, /pointercancel/);
  assert.match(calendar, /touchAction = "pan-y"/);
  assert.match(sheet, />= 10/);
  assert.match(sheet, /Math\.abs\(dy\) > Math\.abs\(dx\) \* 1\.2/);
  assert.match(sheet, /pointercancel/);
});

console.log(`\n${passed} Android release-blocker checks passed.`);
