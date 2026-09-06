/*
 * Focused contract for the athlete Train / Coach / Trends shell.
 * Run: node tests/athlete-primary-navigation.test.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const coachMode = readFileSync("./js/coachMode.js", "utf8");
const morning = readFileSync("./js/morningCheckIn.js", "utf8");
const accessGuard = readFileSync("./js/accessGuard.js", "utf8");
const trainCalendar = readFileSync("./js/trainCalendar.js", "utf8");
const onboarding = readFileSync("./js/onboarding.js", "utf8");
const planSetup = readFileSync("./js/planSetup.js", "utf8");
const onboardingConnect = readFileSync("./js/onboardingConnect.js", "utf8");
const coachDashboard = readFileSync("./js/coachDashboard.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`);
  }
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  return from >= 0 && to >= 0 ? source.slice(from, to) : "";
}

const staticNav = between(
  html,
  '<nav class="tabbar" id="tabbar"',
  "</nav>"
);
const staticTabs = [...staticNav.matchAll(
  /<button[^>]*class="([^"]*\btab\b[^"]*)"[^>]*data-screen="([^"]+)"[^>]*aria-selected="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g
)].map(match => ({
  classes: match[1],
  screen: match[2],
  selected: match[3],
  label: match[4]
}));

console.log("\n──── Athlete navigation DOM ────");
test("athlete navigation has exactly three tabs", staticTabs.length === 3,
  staticTabs.map(tab => tab.screen).join(", "));
test("athlete tab order is Train / Coach / Trends",
  staticTabs.map(tab => tab.label).join(" / ") === "Train / Coach / Trends");
test("athlete tab targets use the existing screen IDs",
  staticTabs.map(tab => tab.screen).join(" / ") ===
    "screen-train / screen-coachai / screen-trends");
test("Train alone is selected by default",
  staticTabs[0]?.classes.split(/\s+/).includes("on") === true &&
  staticTabs[0]?.selected === "true" &&
  staticTabs.slice(1).every(tab => tab.selected === "false"));
test("Today and You screens remain in the DOM",
  /<section[^>]+id="screen-today"/.test(html) &&
  /<section[^>]+id="screen-you"/.test(html));

console.log("\n──── Floating capsule and active state ────");
const capsuleCss = between(
  html,
  "body:not(.coach-workspace-active) #tabbar{",
  "body.coach-workspace-active #tabbar{"
);
test("capsule is centered, detached, and sized for three tabs",
  /left:50%;right:auto/.test(capsuleCss) &&
  /transform:translateX\(-50%\)/.test(capsuleCss) &&
  /width:min\(296px,calc\(100% - 40px\)\)/.test(capsuleCss));
test("390px, 430px, and desktop device widths keep the capsule inside the shell",
  [390, 430, 430].every(width => Math.min(296, width - 40) === 296) &&
  /@media\(min-width:480px\)\{\.device\{[^}]*max-width|\.device\{\s*max-width:430px/.test(html));
test("capsule respects the bottom safe area",
  /bottom:calc\(10px \+ var\(--athlevo-safe-bottom,env\(safe-area-inset-bottom,0px\)\)\)/.test(capsuleCss));
test("capsule uses a restrained material without gradients or glow",
  /background:var\(--nav-glass\)/.test(capsuleCss) &&
  /border:1px solid var\(--line\)/.test(capsuleCss) &&
  /box-shadow:var\(--elev-2\)/.test(capsuleCss) &&
  !/gradient|glow/i.test(capsuleCss));
test("tabs meet the practical tap target and active tab uses an inner bubble",
  /min-height:48px/.test(capsuleCss) &&
  /\.tab\.on\{\s*background:var\(--card\);box-shadow:var\(--elev-1\)/.test(capsuleCss));
test("athlete underline is hidden while Coach Workspace retains its override",
  /\.nav-active-indicator\{display:none\}/.test(capsuleCss) &&
  /body\.coach-workspace-active #tabbar[\s\S]*?\.nav-active-indicator\{display:block\}/.test(html));

console.log("\n──── Profile and back behavior ────");
const openProfile = between(html, "function openAthleteProfile()", "window.openAthleteProfile");
const closeProfile = between(html, "function closeAthleteProfile()", "window.closeAthleteProfile");
const closeSettings = between(html, "function closeSettings()", "window.closeSettings");
test("Train header exposes the existing profile through an accessible control",
  /class="train-profile-entry"[\s\S]*?onclick="openAthleteProfile\(\)"[\s\S]*?aria-label="Open profile"/.test(html));
test("profile entry has a 44 by 44 tap target",
  /\.train-profile-entry\{width:44px;height:44px/.test(html));
test("profile remembers Train, Coach, or Trends and falls back to Train",
  /screen-train", "screen-coachai", "screen-trends/.test(openProfile) &&
  /_athleteProfileReturnScreenId = activeId/.test(openProfile) &&
  /showScreen\("screen-you"\)/.test(openProfile) &&
  /: "screen-train"/.test(closeProfile));
{
  let activeId = "screen-coachai";
  const shown = [];
  const profileApi = new Function("document", "showScreen", "window", `
    var _athleteProfileReturnScreenId = "screen-train";
    ${openProfile}
    ${closeProfile}
    return { openAthleteProfile, closeAthleteProfile };
  `)(
    {
      querySelector: selector => selector === ".screen.active" ? { id: activeId } : null,
      getElementById: id => id === "screen-you" ? { scrollTop: 42 } : null
    },
    id => shown.push(id),
    {}
  );
  profileApi.openAthleteProfile();
  activeId = "screen-you";
  profileApi.closeAthleteProfile();
  test("profile entry returns to the athlete surface it opened from",
    shown.join(" / ") === "screen-you / screen-coachai");
}
test("Settings returns to Profile without looking for a removed You tab",
  /showScreen\('screen-you'\)/.test(closeSettings) &&
  !/querySelector|\.tab/.test(closeSettings));
test("hardware back routes Settings to Profile and Profile to its prior athlete screen",
  /classList\.contains\('active'\)[\s\S]*?closeSettings\(\)[\s\S]*?screen-you[\s\S]*?closeAthleteProfile\(\)/.test(html));

console.log("\n──── Athlete home routing ────");
const routeAfterAuth = between(html, "async function routeAfterAuth", "function isStandaloneMode");
test("completed authenticated users enter Train",
  /showScreen\("screen-train"\)/.test(routeAfterAuth));
test("onboarding completion enters Train",
  /showScreen\("screen-train"\)/.test(onboarding) &&
  !/showScreen\("screen-today"\)/.test(onboarding));
test("plan setup returns athletes to Train",
  /showScreen\("screen-train"\)/.test(planSetup) &&
  !/showScreen\("screen-today"\)/.test(planSetup));
test("connection and Coach Dashboard exits enter Train",
  /showScreen\("screen-train"\)/.test(onboardingConnect) &&
  /showScreen\("screen-train"\)/.test(coachDashboard));
test("Train still opens with today selected",
  /async function open\(planData\)\s*\{[\s\S]*?selected = todayISO\(\); weekStart = mondayOf\(civilToday\(\)\)/.test(trainCalendar));

console.log("\n──── Coach Mode isolation ────");
const coachTabs = between(coachMode, "var COACH_TABS = [", "];",);
const restoredAthleteTabs = between(coachMode, "var ATHLETE_TABS = [", "];",);
const activateCoach = between(coachMode, "function activateCoachWorkspace()", "function activateAthleteWorkspace()");
const activateAthlete = between(coachMode, "function activateAthleteWorkspace()", "function injectAthleteYouSwitcher()");
test("Coach Mode still includes its own Today tab",
  /screen-today/.test(coachTabs) && /label: "Today"/.test(coachTabs));
test("Coach Mode still activates screen-today",
  /showImmediately\("screen-today"\)/.test(activateCoach));
test("leaving Coach Mode restores exactly Train / Coach / Trends",
  (restoredAthleteTabs.match(/screen:/g) || []).length === 3 &&
  /screen-train[\s\S]*screen-coachai[\s\S]*screen-trends/.test(restoredAthleteTabs));
test("leaving Coach Mode restores Train and capsule mode",
  /classList\.remove\("coach-workspace-active"\)/.test(activateAthlete) &&
  /restoreAthleteNavigation\(\)/.test(activateAthlete) &&
  /showImmediately\("screen-train"\)/.test(activateAthlete));

console.log("\n──── Navigation behavior and preserved flows ────");
const directionSource = between(html, "function appTabIndexForScreen", "function clearAppScreenMotion");
const navButtons = ["screen-train", "screen-coachai", "screen-trends"].map(screen => ({
  getAttribute: name => name === "data-screen" ? screen : null
}));
const directionApi = new Function("document", `${directionSource}; return { appScreenDirection };`)({
  querySelectorAll: selector => selector === "#tabbar .tab" ? navButtons : []
});
test("tab transition direction follows Train → Coach → Trends",
  directionApi.appScreenDirection("screen-train", "screen-coachai") === 1 &&
  directionApi.appScreenDirection("screen-coachai", "screen-trends") === 1 &&
  directionApi.appScreenDirection("screen-trends", "screen-train") === -1);
test("morning readiness accepts Train while retaining Today compatibility",
  /activeScreen\("screen-train"\) \|\| activeScreen\("screen-today"\)/.test(morning));
test("access guard leaves all three athlete primary tabs accessible",
  /FREE_TABS[\s\S]*?screen-coachai[\s\S]*?screen-train[\s\S]*?screen-trends/.test(accessGuard));
test("activity analysis still targets the Coach tab with exact activity context",
  /\.tab\[data-screen="screen-coachai"\]/.test(trainCalendar) &&
  /activity: compactActivity/.test(trainCalendar) &&
  /session: compactSession/.test(trainCalendar));
test("analytics retain Train, Coach, Trends, Today, and You identities",
  /'screen-today':'today'/.test(html) &&
  /'screen-train':'train'/.test(html) &&
  /'screen-trends':'trends'/.test(html) &&
  /'screen-you':'you'/.test(html) &&
  /'screen-coachai':'coach'/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
