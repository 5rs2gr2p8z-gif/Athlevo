/*
 * Focused contract for the athlete Home / Calendar / Coach / You shell
 * (screen IDs: screen-today / screen-train / screen-coachai / screen-trends).
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
test("athlete navigation has exactly four tabs", staticTabs.length === 4,
  staticTabs.map(tab => tab.screen).join(", "));
test("athlete tab order is Home / Calendar / Coach / You",
  staticTabs.map(tab => tab.label).join(" / ") === "Home / Calendar / Coach / You");
test("athlete tab targets use the existing screen IDs",
  staticTabs.map(tab => tab.screen).join(" / ") ===
    "screen-today / screen-train / screen-coachai / screen-trends");
test("Home alone is selected by default",
  staticTabs[0]?.classes.split(/\s+/).includes("on") === true &&
  staticTabs[0]?.selected === "true" &&
  staticTabs.filter((_,i) => i !== 0).every(tab => tab.selected === "false"));

const tabBlocks = staticNav.split(/(?=<button)/).filter(block => block.trim().startsWith("<button"));
const calendarTabBlock = tabBlocks.find(block => block.includes('data-screen="screen-train"')) || "";
const youTabBlock = tabBlocks.find(block => block.includes('data-screen="screen-trends"')) || "";
test("Calendar tab carries a descriptive aria-label",
  /aria-label="Calendar"/.test(calendarTabBlock));
test("You tab carries a descriptive aria-label",
  /aria-label="You"/.test(youTabBlock));
test("You tab uses a person/profile icon rather than the old trend-chart icon",
  /<circle cx="12" cy="8" r="4"\/><path d="M4 21a8 8 0 0 1 16 0"\/>/.test(youTabBlock) &&
  !/M3 17l6-6 4 4 8-8/.test(youTabBlock));
test("Today and You screens remain in the DOM",
  /<section[^>]+id="screen-today"/.test(html) &&
  /<section[^>]+id="screen-you"/.test(html));
test("tabbar has tabbar--capsule class in markup",
  /class="tabbar tabbar--capsule"/.test(html));
test("all four athlete tabs retain their go() click handler",
  (staticNav.match(/onclick="go\(this\)"/g) || []).length === 4);

console.log("\n──── Floating capsule CSS ────");
const capsuleCss = between(html, ".tabbar {", "/* ----------");
const genericTabbarRules = html.match(/(?:^|\n)\.tabbar\s*\{/g) || [];
test("athlete capsule geometry has a single generic CSS owner",
  genericTabbarRules.length === 1, `${genericTabbarRules.length} generic .tabbar rules`);
test("capsule is centered and detached from edges",
  /left:\s*50%/.test(capsuleCss) &&
  /transform:\s*translateX\(-50%\)/.test(capsuleCss));
test("capsule uses the responsive 352px width sized for four tabs",
  /width:\s*min\(352px,\s*calc\(100% - 20px\)\)/.test(capsuleCss));
test("capsule height is enlarged while retaining responsive side margins",
  /min-height:\s*70px/.test(capsuleCss) &&
  /box-sizing:\s*border-box/.test(capsuleCss));
const responsiveCapsuleWidth = viewport => Math.min(352, viewport - 20);
test("390px, 430px, and narrow shells keep visible symmetric capsule margins",
  responsiveCapsuleWidth(390) === 352 && (390 - responsiveCapsuleWidth(390)) / 2 === 19 &&
  responsiveCapsuleWidth(430) === 352 && (430 - responsiveCapsuleWidth(430)) / 2 === 39 &&
  responsiveCapsuleWidth(320) === 300 && (320 - responsiveCapsuleWidth(320)) / 2 === 10);
test("capsule respects the bottom safe area",
  /bottom:\s*calc\(10px \+ var\(--athlevo-safe-bottom/.test(capsuleCss));
test("capsule uses backdrop-filter blur material",
  /backdrop-filter:\s*blur\(20px\)/.test(capsuleCss));
test("capsule has rounded corners (concentric outer radius token)",
  /border-radius:\s*var\(--radius-surface-outer\)/.test(capsuleCss));
test("capsule does not use gradients or glow",
  !/gradient|glow/i.test(capsuleCss));

console.log("\n──── Active tab styling ────");
test("active tab gets inner background pill",
  /\.tab\.on\{[^}]*background:var\(--nav-tab-active-bg/.test(html));
test("larger tab controls preserve a comfortable tap target",
  /\.tab\{[^}]*min-height:56px/.test(html) &&
  /\.tab svg\{width:23px;height:23px/.test(html));
test("larger labels strengthen the selected state",
  /\.tab span\{font-size:11px;font-weight:650/.test(html) &&
  /\.tab\.on span\{font-weight:750\}/.test(html));
test("legacy sliding indicator is hidden for capsule nav",
  /\.tabbar--capsule \.nav-active-indicator\{display:none\}/.test(html));
test("athlete reserve grows with the capsule while Coach Workspace stays at 64px",
  /--athlevo-tabbar-height:80px/.test(html) &&
  /body\.coach-workspace-active\{--athlevo-tabbar-height:64px\}/.test(html));

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
test("closeProfileScreen returns to active tab's screen, defaulting to screen-today (Home)",
  /querySelector\('#tabbar \.tab\.on'\)/.test(closeProfile) &&
  /dataset\.screen/.test(closeProfile) &&
  /'screen-today'/.test(closeProfile));
test("closeSettings returns to screen-you by default (no source recorded)",
  /getElementById\('screen-you'\)/.test(closeSettings));
test("Settings is now also reachable from the Coach header, so closeSettings returns to whichever screen it was opened from",
  /_settingsReturnScreen/.test(closeSettings) &&
  /tabbar \.tab\[data-screen=/.test(closeSettings));
test("hardware back handles both Settings and Profile back navigation",
  /_handleAndroidBackForProfileSettings/.test(html) &&
  /closeSettings\(\)/.test(html) &&
  /closeProfileScreen\(\)/.test(html));

console.log("\n──── Athlete home routing ────");
const routeAfterAuth = between(html, "async function routeAfterAuth", "function isStandaloneMode");
test("completed authenticated users enter Home",
  /showScreen\("screen-today"\)/.test(routeAfterAuth) &&
  !/showScreen\("screen-coachai"\)/.test(routeAfterAuth));
test("Home-first routing reveals the athlete capsule before Coach workspace resolution",
  routeAfterAuth.indexOf('tabbar").style.display = "flex"') >= 0 &&
  routeAfterAuth.indexOf('tabbar").style.display = "flex"') <
    routeAfterAuth.indexOf("window.AthlevoCoachMode.init(routeContext)"));
test("Home-first routing reveals the athlete capsule before entering Home",
  routeAfterAuth.indexOf('tabbar").style.display = "flex"') <
    routeAfterAuth.indexOf('showScreen("screen-today")') &&
  routeAfterAuth.indexOf('tabbar").style.display = "flex"') <
    routeAfterAuth.indexOf("window.AthlevoAthleteMode.init()"));
test("authenticated landing no longer pre-enters Coach (Coach initialises when opened)",
  !/await enterCoachScreen\(\)/.test(routeAfterAuth));
test("onboarding completion for onboarded/returning athletes enters Home",
  /showScreen\("screen-today"\)/.test(onboarding) &&
  !/showScreen\("screen-train"\)/.test(onboarding));
test("plan setup fallbacks return athletes to Home; viewing the generated plan still opens Calendar",
  /showScreen\("screen-today"\)/.test(planSetup) &&
  /async function enterTrain\(\)[\s\S]*?\.tab\[data-screen="screen-train"\]/.test(planSetup));
test("connection fallback and Coach Dashboard exits enter Home",
  /showScreen\("screen-today"\)/.test(onboardingConnect) &&
  /showScreen\("screen-today"\)/.test(coachDashboard));
test("Train still opens with today selected",
  /selected = todayISO\(\)/.test(trainCalendar));

console.log("\n──── Coach Mode isolation ────");
const coachTabs = between(coachMode, "var COACH_TABS = [", "];");
const restoredAthleteTabs = between(coachMode, "var ATHLETE_TABS = [", "];");
const activateCoach = between(coachMode, "function activateCoachWorkspace()", "function activateAthleteWorkspace()");
const activateAthlete = between(coachMode, "function activateAthleteWorkspace()", "function injectAthleteYouSwitcher");
test("Coach Mode leads with a Home tab (the athlete list) and has no Calendar/Train tab",
  /screen-today/.test(coachTabs) && /label: "Home"/.test(coachTabs) && !/Train|Calendar/.test(coachTabs));
test("Coach Mode still activates screen-today for Coach Today",
  /showImmediately\("screen-today"\)/.test(activateCoach));
test("leaving Coach Mode restores exactly Home / Calendar / Coach / You (screen-today / screen-train / screen-coachai / screen-trends)",
  (restoredAthleteTabs.match(/screen:/g) || []).length === 4 &&
  /screen-today[\s\S]*screen-train[\s\S]*screen-coachai[\s\S]*screen-trends/.test(restoredAthleteTabs));
test("leaving Coach Mode shows Home (screen-today) and reloads today's plan",
  /showImmediately\("screen-today"\)/.test(activateAthlete) &&
  /refreshTodayAfterPlanChange\("screen-enter"\)/.test(activateAthlete));
test("Coach Workspace overrides the capsule with its full-width five-tab layout",
  /body\.coach-workspace-active #tabbar\{[^}]*left:0;right:0;bottom:0;width:100%/.test(html) &&
  /body\.coach-workspace-active #tabbar \.tab\{[^}]*width:64px/.test(html));
test("Coach Workspace restores its shared moving indicator",
  /body\.coach-workspace-active #tabbar \.nav-active-indicator\{display:block\}/.test(html));

console.log("\n──── Navigation behavior and preserved flows ────");
const directionSource = between(html, "function appTabIndexForScreen", "function clearAppScreenMotion");
const navButtons = ["screen-today", "screen-train", "screen-coachai", "screen-trends"].map(screen => ({
  getAttribute: name => name === "data-screen" ? screen : null
}));
const directionApi = new Function("document", `${directionSource}; return { appScreenDirection };`)({
  querySelectorAll: selector => selector === "#tabbar .tab" ? navButtons : []
});
test("tab transition direction follows Home → Calendar → Coach → You",
  directionApi.appScreenDirection("screen-today", "screen-train") === 1 &&
  directionApi.appScreenDirection("screen-train", "screen-coachai") === 1 &&
  directionApi.appScreenDirection("screen-coachai", "screen-trends") === 1 &&
  directionApi.appScreenDirection("screen-trends", "screen-today") === -1);
const goSource = between(html, "async function go(btn)", "/*\n * Canonical Coach-screen entry");
const clickedScreens = [];
const selectedScreens = [];
let trainLoads = 0;
let coachEntries = 0;
const goApi = new Function(
  "window", "selectAppTab", "transitionTopLevelScreen", "enterCoachScreen",
  "refreshTodayAfterPlanChange", "refreshTodayProCard", "animateRing",
  `${goSource}; return go;`
)(
  {
    AthlevoAccessGuard: {
      guardTab: async () => false,
      refreshPremiumViews: () => {}
    },
    loadWeeklyPlan: async () => { trainLoads += 1; }
  },
  btn => { selectedScreens.push(btn.dataset.screen); },
  screen => { clickedScreens.push(screen); return Promise.resolve(); },
  async () => { coachEntries += 1; },
  async () => {}, () => {}, () => {}
);
await goApi({ dataset: { screen: "screen-today" } });
await goApi({ dataset: { screen: "screen-train" } });
await goApi({ dataset: { screen: "screen-coachai" } });
await goApi({ dataset: { screen: "screen-trends" } });
test("Home, Calendar, Coach, and You clicks select and navigate to their own screen",
  selectedScreens.join(" / ") === "screen-today / screen-train / screen-coachai / screen-trends" &&
  clickedScreens.join(" / ") === "screen-today / screen-train / screen-coachai / screen-trends");
test("Train and Coach clicks retain their screen-specific initialization",
  trainLoads === 1 && coachEntries === 1);
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
