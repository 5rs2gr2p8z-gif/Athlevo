/* Focused public-release lock checks for B2B Coach Workspace. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canAccessCoachDashboard } from "../lib/server/coachRoles.js";

const root = resolve(import.meta.dirname, "..");
const read = path => readFileSync(resolve(root, path), "utf8");
const onboarding = read("js/onboarding.js");
const coachMode = read("js/coachMode.js");
const dashboard = read("js/coachDashboard.js");
const index = read("index.html");
const providerApi = read("api/providers/index.js");

let passed = 0;
function test(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`PASS — ${name}`);
}

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `Could not extract ${startText}`);
  return source.slice(start, end);
}

console.log("\n──── Onboarding public lock ────");
test("Athlete remains a selectable onboarding option",
  /#obRoleAthlete/.test(onboarding) && /obWriteIntent\("athlete"\)[\s\S]{0,100}obStartAthleteFlow\(\)/.test(onboarding));
test("Coach stays visible with a restrained Coming soon state",
  /id="obRoleCoach"/.test(onboarding) && /aria-disabled/.test(onboarding) && /Coming soon/.test(onboarding));
test("one explicit public availability constant is off for release",
  /const COACH_PUBLIC_ACCESS_ENABLED = false;/.test(onboarding));
const coachStart = between(onboarding, "function obStartCoachFlow()", "function obRenderCoachStep()");
test("the coach application function itself is guarded",
  coachStart.indexOf("if (!obCoachPublicAccessEnabled())") >= 0 &&
  coachStart.indexOf("return false") < coachStart.indexOf('_obCurrentFlow = "coach"'));
test("stale coach onboarding intent is cleared instead of resumed",
  /savedIntent === "coach" && obCoachPublicAccessEnabled\(\)/.test(onboarding) &&
  /if \(savedIntent === "coach"\) obClearIntent\(\)/.test(onboarding));
test("existing server-authorized coach/admin onboarding bypass remains",
  /role === "coach" \|\| role === "admin"[\s\S]{0,700}onboarding_complete: true/.test(onboarding));

console.log("\n──── Public Profile and workspace routing ────");
test("the Profile workspace host and its spacer are hidden by default",
  /id="youWorkspaceSection" hidden/.test(index) && /id="youWorkspaceSpacer" hidden/.test(index));
test("only the authorized switcher reveals the Profile workspace section",
  /function setAthleteYouWorkspaceVisible\(visible\)/.test(coachMode) &&
  /if \(!canEnterCoachWorkspace\(\)\)[\s\S]{0,300}setAthleteYouWorkspaceVisible\(false\)[\s\S]{0,120}setAthleteYouWorkspaceVisible\(true\)/.test(coachMode));
const activate = between(coachMode, "function activateCoachWorkspace()", "function activateAthleteWorkspace()");
test("direct workspace entry checks authorization before coach UI can paint",
  activate.indexOf("if (!canEnterCoachWorkspace())") >= 0 &&
  activate.indexOf("if (!canEnterCoachWorkspace())") < activate.indexOf('classList.add("coach-workspace-active")'));
test("unauthorized entry resolves cleanly to athlete Today",
  activate.includes("enforceAthleteWorkspaceFallback()") && activate.includes('window.showScreen("screen-today")'));
const fallback = between(coachMode, "function enforceAthleteWorkspaceFallback()", "function resolveWorkspace()");
test("fallback clears stale coach preference and hides coach-only screens",
  fallback.includes('readWorkspacePref() === "coach_workspace"') &&
  fallback.includes("clearWorkspacePref()") && fallback.includes('el.style.display = "none"'));
test("failed or athlete role resolution applies the same pre-paint fallback",
  /if \(mode !== "coach_mode"\)[\s\S]{0,220}enforceAthleteWorkspaceFallback\(\)/.test(coachMode));
test("the public switch API points only to the guarded activation function",
  /switchToCoachWorkspace: activateCoachWorkspace/.test(coachMode) &&
  /isCoachWorkspace: function \(\) \{ return canEnterCoachWorkspace\(\)/.test(coachMode));

console.log("\n──── Logout, account switch, and deep links ────");
test("logout clears both current and legacy coach clients",
  /AthlevoCoachMode\.clearWorkspaceOnLogout/.test(index) &&
  /AthlevoCoachDashboard\.clearOnLogout/.test(index));
test("legacy dashboard keeps an unexported authorization confirmation",
  /var accessConfirmed = false;/.test(dashboard) &&
  /if \(!accessConfirmed \|\| !state\.enabled/.test(dashboard));
test("legacy 401/403 responses revoke access and silently redirect",
  /res\.status === 401 \|\| res\.status === 403[\s\S]{0,160}clearOnLogout\(\)[\s\S]{0,100}safeRedirect\(\)/.test(dashboard));
test("an athlete deep link is removed without mounting the dashboard",
  /if \(!state\.enabled\)[\s\S]{0,120}location\.hash === "#coach"[\s\S]{0,80}safeRedirect\(\)/.test(dashboard));

console.log("\n──── Trusted backend authorization ────");
test("normal and malformed roles remain denied by the shared server role model",
  !canAccessCoachDashboard({ role: "athlete" }) &&
  !canAccessCoachDashboard({ role: "coach_pending" }) &&
  !canAccessCoachDashboard({ role: null }));
test("only trusted coach/admin roles retain dashboard authorization",
  canAccessCoachDashboard({ role: "coach" }) && canAccessCoachDashboard({ role: "admin" }));
for (const action of ["Roster", "Athlete", "Notes", "Messages", "Review", "Workout"]) {
  const start = `async function actionCoachingDashboard${action}`;
  const next = providerApi.indexOf("async function ", providerApi.indexOf(start) + start.length);
  const section = providerApi.slice(providerApi.indexOf(start), next < 0 ? undefined : next);
  test(`${action} endpoint rechecks the server-loaded profile role`,
    section.includes("loadCoachProfile(user.id)") && section.includes("canAccessCoachDashboard(profile)"));
}

test("athlete Coach/AI screen remains in athlete navigation",
  /screen-coachai/.test(coachMode) && /label: "Coach"/.test(coachMode));

console.log(`\n${passed} public Coach Workspace release-lock tests passed.`);
