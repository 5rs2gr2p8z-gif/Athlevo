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
  '<nav class="tabbar tabbar--capsule" id="tabbar"',
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
test("Coach alone is selected by default",
  staticTabs[1]?.classes.split(/\s+/).includes("on") === true &&
  staticTabs[1]?.selected === "true" &&
  staticTabs.filter((_,i) => i !== 1).every(tab => tab.selected === "false"));
test("Today and You screens remain in the DOM",
  /<section[^>]+id="screen-today"/.test(html) &&
  /<section[^>]+id="screen-you"/.test(html));
test("tabbar has tabbar--capsule class in markup",
  /class="tabbar tabbar--capsule"/.test(html));

console.log("\n──── Floating capsule CSS ────");
const capsuleCss = between(html, ".tabbar {", "/* ----------");
test("capsule is centered and detached from edges",
  /left:\s*50%/.test(capsuleCss) &&
  /transform:\s*translateX\(-50%\)/.test(capsuleCss));
test("capsule uses width:auto for content-sized layout",
  /width:\s*auto/.test(capsuleCss));
test("capsule respects the bottom safe area",
  /bottom:\s*calc\(10px \+ var\(--athlevo-safe-bottom/.test(capsuleCss));
test("capsule uses backdrop-filter blur material",
  /backdrop-filter:\s*blur\(20px\)/.test(capsuleCss));
test("capsule has rounded corners",
  /border-radius:\s*22px/.test(capsuleCss));
test("capsule does not use gradients or glow",
  !/gradient|glow/i.test(capsuleCss));

console.log("\n──── Active tab styling ────");
test("active tab gets inner background pill",
  /\.tab\.on\{[^}]*background:var\(--nav-tab-active-bg/.test(html));
test("active tab text is bold",
  /\.tab\.on span\{font-weight:700\}/.test(html));
test("legacy sliding indicator is hidden for capsule nav",
  /\.tabbar--capsule \.nav-active-indicator\{display:none\}/.test(html));

console.log("\n──── Profile avatar button ────");
test("profile avatar button exists in markup",
  /id="profileAvatarBtn"/.test(html) &&
  /class="athlevo-profile-avatar"/.test(html));
test("profile avatar opens screen-you via openProfileScreen",
  /onclick="openProfileScreen\(\)"/.test(html));
test("profile avatar has accessible label",
  /aria-label="Profile"/.test(html));
test("profile avatar CSS positions at top-right with safe area",
  /\.athlevo-profile-avatar\{[^}]*position:absolute[^}]*top:calc\(10px \+ var\(--athlevo-safe-top/.test(html) &&
  /\.athlevo-profile-avatar\{[^}]*right:16px/.test(html));
test("profile avatar is circular with 34px size",
  /\.athlevo-profile-avatar\{[^}]*width:34px;height:34px;border-radius:50%/.test(html));

console.log("\n──── Profile and back behavior ────");
const openProfile = between(html, "function openProfileScreen()", "window.openProfileScreen");
const closeProfile = between(html, "function closeProfileScreen()", "window.closeProfileScreen");
const closeSettings = between(html, "function closeSettings()", "window.closeSettings");
test("openProfileScreen shows screen-you",
  /getElementById\('screen-you'\)/.test(openProfile) &&
  /classList\.add\('active'\)/.test(openProfile));
test("closeProfileScreen returns to active tab's screen, defaulting to screen-train",
  /querySelector\('#tabbar \.tab\.on'\)/.test(closeProfile) &&
  /dataset\.screen/.test(closeProfile) &&
  /'screen-train'/.test(closeProfile));
test("closeSettings returns to screen-you without looking for a removed You tab",
  /getElementById\('screen-you'\)/.test(closeSettings) &&
  !/querySelector.*\.tab/.test(closeSettings));
test("hardware back handles both Settings and Profile back navigation",
  /_handleAndroidBackForProfileSettings/.test(html) &&
  /closeSettings\(\)/.test(html) &&
  /closeProfileScreen\(\)/.test(html));

console.log("\n──── Athlete home routing ────");
const routeAfterAuth = between(html, "async function routeAfterAuth", "function isStandaloneMode");
test("completed authenticated users enter Coach",
  /showScreen\("screen-coachai"\)/.test(routeAfterAuth));
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
  /selected = todayISO\(\)/.test(trainCalendar));

console.log("\n──── Coach Mode isolation ────");
const coachTabs = between(coachMode, "var COACH_TABS = [", "];");
const restoredAthleteTabs = between(coachMode, "var ATHLETE_TABS = [", "];");
const activateCoach = between(coachMode, "function activateCoachWorkspace()", "function activateAthleteWorkspace()");
const activateAthlete = between(coachMode, "function activateAthleteWorkspace()", "function injectAthleteYouSwitcher");
test("Coach Mode still includes its own Today tab",
  /screen-today/.test(coachTabs) && /label: "Today"/.test(coachTabs));
test("Coach Mode still activates screen-today for Coach Today",
  /showImmediately\("screen-today"\)/.test(activateCoach));
test("leaving Coach Mode restores exactly Train / Coach / Trends",
  (restoredAthleteTabs.match(/screen:/g) || []).length === 3 &&
  /screen-train[\s\S]*screen-coachai[\s\S]*screen-trends/.test(restoredAthleteTabs));
test("leaving Coach Mode shows screen-train",
  /showImmediately\("screen-train"\)/.test(activateAthlete));
test("Coach Workspace overrides the capsule with its full-width five-tab layout",
  /body\.coach-workspace-active #tabbar\{[^}]*left:0;right:0;bottom:0;width:100%/.test(html) &&
  /body\.coach-workspace-active #tabbar \.tab\{[^}]*width:64px/.test(html));
test("Coach Workspace restores its shared moving indicator",
  /body\.coach-workspace-active #tabbar \.nav-active-indicator\{display:block\}/.test(html));

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
