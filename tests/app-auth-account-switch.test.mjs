/* Focused app-entry/logout/account-switch isolation regression checks. */
import { readFileSync } from "node:fs";

const index = readFileSync("./index.html", "utf8");
const coach = readFileSync("./js/coachMode.js", "utf8");
const athlete = readFileSync("./js/athleteMode.js", "utf8");
const morning = readFileSync("./js/morningCheckIn.js", "utf8");
let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}
function fn(source, name, next) {
  const start = source.indexOf(`function ${name}`);
  const end = next ? source.indexOf(`function ${next}`, start + 1) : -1;
  return source.slice(start, end > start ? end : undefined);
}

const logout = fn(index, "doLogout", "openDeleteAccount");
const restore = fn(index, "restoreSession", "endBootGate");
const route = fn(index, "routeAfterAuth", "isStandaloneMode");
const coachClear = fn(coach, "clearWorkspaceOnLogout", "suppressAthleteReadiness");
const coachLogout = coach.slice(coach.indexOf('var logoutBtn = document.getElementById("cmLogout")'), coach.indexOf("/* ═══════════════════════ REFRESH", coach.indexOf('var logoutBtn = document.getElementById("cmLogout")')));
const athleteClear = fn(athlete, "clearOnLogout");
const morningClear = fn(morning, "clearOnLogout", "evaluateOnResume");

console.log("\n──── App versus public routing ────");
test("fresh signed-out browser remains eligible for public landing", /else \{\s*showScreen\("screen-landing"\)/.test(restore));
test("signed-out app intent resolves to welcome instead of landing", /isStandaloneMode\(\) \|\| hasAppEntryIntent\(\)/.test(restore) && /showScreen\("screen-welcome"\)/.test(restore));
test("app intent is explicit and tab-scoped", /sessionStorage\.setItem\('athlevo_app_entry_intent'/.test(index));
test("successful account routing consumes the old signed-out intent", /clearAppEntryIntent\(\)/.test(route));
test("logout installs app entry as the browser-history floor", /rememberAppEntryIntent\('logout'\)/.test(logout) && /history\.replaceState\(\{ athlevoNav: 'entry' \}/.test(logout));
test("coach logout delegates to the same authoritative logout function", /window\.doLogout\(\)/.test(coachLogout) && !/signOut|location\.reload/.test(coachLogout));

console.log("\n──── Coach → athlete → coach isolation ────");
test("logout resets active athlete identity and originating tab", /_athleteDetailId = null/.test(coachClear) && /_athleteDetailTab = "overview"/.test(coachClear));
test("logout clears roster, Athlete Detail, and message caches", /_roster = \[\]/.test(coachClear) && /_athleteDetailCache = Object\.create\(null\)/.test(coachClear) && /_messageThreadCache = Object\.create\(null\)/.test(coachClear));
test("logout resets Coach Mode so the next account is re-authorized", /_appMode = "unknown"/.test(coachClear) && /_initialized = false/.test(coachClear) && /_role = null/.test(coachClear));
test("logout restores athlete navigation and removes coach-only switching", /restoreAthleteToday\(\)/.test(coachClear) && /restoreAthleteNavigation\(\)/.test(coachClear) && /cmAthleteSwitcher/.test(coachClear) && /removeChild\(athleteSwitcher\)/.test(coachClear));
test("managed-athlete mode and identity UI are not cached across accounts", /_mode = "unknown"/.test(athleteClear) && /_coach = null/.test(athleteClear) && /_confirmed = false/.test(athleteClear) && /am-assigned-coach/.test(athleteClear) && /am-authorship-label/.test(athleteClear));
test("managed workout controls are restored without enabling originally disabled controls", /data-am-managed-disabled/.test(athlete) && /data-am-managed-disabled/.test(athleteClear) && /removeAttribute\("data-am-managed-disabled"\)/.test(athleteClear));
test("morning readiness session sets cannot leak between accounts", /openedThisSession\.clear\(\)/.test(morningClear) && /completedThisSession\.clear\(\)/.test(morningClear));
test("an open readiness modal is closed before app entry is shown", /window\.closeReadinessCheck/.test(logout) && logout.indexOf("closeReadinessCheck") < logout.indexOf("showScreen('screen-welcome')"));
test("both coach and athlete logins still use the one role-aware route", /await routeAfterAuth\(user\.id\)/.test(index) && /AthlevoCoachMode\.init/.test(route));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
