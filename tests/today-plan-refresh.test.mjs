/**
 * Executable state-flow checks for Today plan/workout revalidation.
 * Run: node tests/today-plan-refresh.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const planSetup = readFileSync("./js/planSetup.js", "utf8");
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

const todayHeadlines = html.slice(
  html.indexOf("var TODAY_REC_HEADLINES"),
  html.indexOf("function classifyPlannedSessionType")
);
const stateVariables = html.slice(
  html.indexOf("var todayPlanSnapshotCache"),
  html.indexOf("function invalidateTodayPlanSnapshot")
);
const stateSource = [
  todayHeadlines,
  stateVariables,
  extractFunction(html, "todayLocalKey"),
  extractFunction(html, "classifyPlannedSessionType"),
  extractFunction(html, "invalidateTodayPlanSnapshot"),
  extractFunction(html, "loadTodayPlanSnapshot"),
  extractFunction(html, "buildTodayTrainingContext"),
  extractFunction(html, "applyTodayTrainingContext"),
  extractFunction(html, "firstSentence"),
  extractFunction(html, "firstTodayInstruction"),
  extractFunction(html, "todaySessionWasAdjusted"),
  extractFunction(html, "buildTodayWorkoutCardView"),
  extractFunction(html, "setTodayScreenState"),
  extractFunction(html, "setTodayPlanLoadingState"),
  extractFunction(html, "applyTodayPlanSnapshot"),
  extractFunction(html, "refreshTodayAfterPlanChange")
].join("\n\n");

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function createWorld(initialSnapshot, initialFailure = false) {
  let snapshot = initialSnapshot;
  let failing = initialFailure;
  let fetchCount = 0;
  const elements = {};
  const node = (id) => elements[id] || (elements[id] = {
    id,
    dataset: {},
    hidden: false,
    disabled: false,
    textContent: "",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); }
  });
  node("dailyBriefCard").dataset = {
    direction: "hold",
    planState: "loading",
    recommendationTitle: "Keep today controlled.",
    recommendationBody: "Limited data means today should stay measured."
  };
  [
    "screen-today",
    "todayPlanLoadingState",
    "todayNoPlanState",
    "todayPlanErrorState",
    "todayActivePlanState",
    "todayDirectionLabel",
    "todayDirectionCoaching",
    "todayWorkoutTitle",
    "todayWorkoutType",
    "todayWorkoutSummary",
    "todayWorkoutInstruction",
    "todayWorkoutAdjusted",
    "todayDirectionAction",
    "todayContextLine"
  ].forEach(node);

  const document = { getElementById: node };
  const supabaseClient = { auth: { getSession: async () => ({
    data: { session: { access_token: "token", user: { id: "athlete-1" } } }
  }) } };
  const fetch = async (url, init) => {
    fetchCount += 1;
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      ok: !failing,
      json: async () => snapshot,
      url,
      init
    };
  };

  const factory = new Function(
    "document",
    "supabaseClient",
    "fetch",
    `${stateSource}
     return {
       refreshTodayAfterPlanChange,
       getCache: () => todayPlanSnapshotCache
     };`
  );
  const api = factory(document, supabaseClient, fetch);
  return {
    api,
    elements,
    get fetchCount() { return fetchCount; },
    setSnapshot(value) { snapshot = value; },
    setFailure(value) { failing = value; }
  };
}

console.log("\n──── Authoritative Today revalidation ────");
const world = createWorld({ hasPlan: false, sessions: [] });
await world.api.refreshTodayAfterPlanChange("screen-enter");
test("confirmed no-plan response renders only the dedicated no-plan state",
  world.elements.todayNoPlanState.hidden === false &&
  world.elements.todayActivePlanState.hidden === true &&
  world.elements.todayAthleteStatusCard.hidden === false &&
  world.elements.todayWhyToday.hidden === true &&
  world.elements.todayDirectionAction.hidden === true);
test("the first render reads the authoritative get-week endpoint once",
  world.fetchCount === 1);

world.setSnapshot({
  hasPlan: true,
  plan: { target_race: "Marathon", phase_week: 3, phase_length_weeks: 12 },
  sessions: [{
    session_date: todayKey(),
    session_type: "easy",
    duration_minutes: 35,
    target_rpe: "2–3"
  }]
});
const planRefresh = world.api.refreshTodayAfterPlanChange("plan-change");
test("revalidation hides the stale Build plan CTA while loading",
  world.elements.todayDirectionAction.hidden === true &&
  world.elements.todayDirectionAction.dataset.action === "");
await planRefresh;
test("a successful plan change replaces stale no-plan state with Open workout",
  world.elements.todayDirectionAction.textContent === "Open workout" &&
  world.elements.todayDirectionAction.dataset.action === "workout" &&
  world.elements.todayWorkoutTitle.textContent === "Easy Run" &&
  world.elements.todayWorkoutSummary.textContent === "35 min · RPE 2–3" &&
  world.elements.todayActivePlanState.hidden === false &&
  world.elements.todayAthleteStatusCard.hidden === false &&
  world.elements.todayWhyToday.hidden === false &&
  world.elements.todayNoPlanState.hidden === true);
test("plan change performs a new authoritative fetch",
  world.fetchCount === 2);
test("server plan context replaces the local no-plan context",
  world.elements.todayContextLine.textContent === "Marathon · Week 3 of 12");

world.setSnapshot({
  hasPlan: true,
  sessions: [{ session_date: todayKey(), session_type: "rest" }]
});
await world.api.refreshTodayAfterPlanChange("screen-enter");
test("an explicit rest day renders View plan and a rest-day summary",
  world.elements.todayDirectionAction.textContent === "View plan" &&
  world.elements.todayWorkoutTitle.textContent === "Recovery Day" &&
  world.elements.todayWorkoutSummary.textContent === "No running today.");

world.setFailure(true);
await world.api.refreshTodayAfterPlanChange("app-resume");
test("an API failure retains the last confirmed valid plan state",
  world.elements.todayDirectionAction.textContent === "View plan" &&
  world.elements.todayWorkoutSummary.textContent === "No running today." &&
  world.elements.todayActivePlanState.hidden === false);

const failedWorld = createWorld(null, true);
await failedWorld.api.refreshTodayAfterPlanChange("screen-enter");
test("an API failure without a valid state shows the error state, never no-plan",
  failedWorld.elements.todayPlanErrorState.hidden === false &&
  failedWorld.elements.todayNoPlanState.hidden === true &&
  failedWorld.elements.todayAthleteStatusCard.hidden === true &&
  failedWorld.elements.todayWhyToday.hidden === true &&
  failedWorld.elements.todayDirectionAction.hidden === true);

console.log("\n──── Persistence and lifecycle wiring ────");
const goSource = extractFunction(html, "go");
const showScreenSource = extractFunction(html, "showScreen");
test("returning from Train to Today revalidates before restoring the CTA",
  /screen-today[\s\S]*?refreshTodayAfterPlanChange\("screen-enter"\)/.test(goSource));
test("programmatic Today entry revalidates too",
  /id === "screen-today"[\s\S]*?window\.refreshTodayAfterPlanChange\("screen-enter"\)/.test(showScreenSource));
test("app resume and page restore revalidate only while Today is active",
  /visibilitychange[\s\S]*?app-resume/.test(html) &&
  /pageshow[\s\S]*?page-show/.test(html) &&
  /screen\.classList\.contains\("active"\)/.test(html));
test("successful persistence explicitly clears planSetup state and refreshes Today",
  /async function refreshTodayAfterPlanChange\(\)[\s\S]*?lastHasPlan = null[\s\S]*?window\.refreshTodayAfterPlanChange\("plan-change"\)/.test(planSetup) &&
  /if \(outcome\.ok\)[\s\S]*?completeFinalStep\(\);[\s\S]*?await refreshTodayAfterPlanChange\(\);[\s\S]*?showSuccess/.test(planSetup));
test("Today refresh clears its memoized weekly-plan request",
  /function invalidateTodayPlanSnapshot\(\)[\s\S]*?userId = null[\s\S]*?promise = null/.test(html));

const today = html.slice(
  html.indexOf('<section class="screen" id="screen-today">'),
  html.indexOf('<section class="screen"', html.indexOf('<section class="screen" id="screen-today">') + 1)
);
test("active state keeps one workout CTA and one explicit insight CTA",
  (today.match(/id="todayDirectionAction"/g) || []).length === 1 &&
  (today.match(/id="todayPremiumInsightTeaser"/g) || []).length === 1 &&
  /id="todayActivePlanState"[\s\S]*?id="todayDirectionAction"[\s\S]*?id="todayPremiumInsightTeaser"/.test(today));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
