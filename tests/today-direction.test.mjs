/**
 * Focused executable checks for the Today first viewport.
 * Run: node tests/today-direction.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const brain = readFileSync("./js/brain.js", "utf8");
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

const directionConstants = html.slice(
  html.indexOf("var ATHLEVO_DIRECTIONS"),
  html.indexOf("/* Conservative, qualitative classification")
);
const classifySource = extractFunction(html, "classifyAthlevoDirection");
const contextSource = extractFunction(html, "buildTodayTrainingContext");
const helpers = new Function(
  `${directionConstants}\n${classifySource}\n${contextSource}
   return { classifyAthlevoDirection, buildTodayTrainingContext };`
)();

console.log("\n──── Direction behavior ────");
test("missing readiness safely resolves to HOLD",
  helpers.classifyAthlevoDirection({}).state === "HOLD");
test("moderate readiness resolves to HOLD",
  helpers.classifyAthlevoDirection({ readiness: { status: "moderate" } }).state === "HOLD");
test("good readiness resolves to PUSH",
  helpers.classifyAthlevoDirection({ readiness: { status: "good" } }).state === "PUSH");
test("recent pain resolves to RECOVER",
  helpers.classifyAthlevoDirection({ pain: { present: true } }).state === "RECOVER");
test("very high acute load resolves to RECOVER",
  helpers.classifyAthlevoDirection({ recovery: { acwr: 1.5 } }).state === "RECOVER");
test("HOLD uses the approved supporting copy",
  helpers.classifyAthlevoDirection({}).copy ===
    "You’re ready to train, but today should stay controlled.");

console.log("\n──── Training context ────");
test("current plan renders race and exact week position",
  helpers.buildTodayTrainingContext({
    target_race: "Marathon",
    phase_week: 3,
    phase_length_weeks: 12
  }, {}) === "Marathon · Week 3 of 12");
test("plan phase is used when week fields are unavailable",
  helpers.buildTodayTrainingContext({
    target_race: "Marathon",
    phase: "base_build"
  }, {}) === "Marathon · Base build phase");
test("profile supplies a truthful fallback",
  helpers.buildTodayTrainingContext(null, {
    primary_sport: "Running",
    goal: "Marathon"
  }) === "Running · Marathon");
test("missing plan and profile do not invent training position",
  helpers.buildTodayTrainingContext(null, {}) === "Training plan not available yet.");

console.log("\n──── Markup, data wiring, and accessibility ────");
const today = html.slice(
  html.indexOf('<section class="screen" id="screen-today">'),
  html.indexOf('<section class="screen"', html.indexOf('<section class="screen" id="screen-today">') + 1)
);
const positions = [
  today.indexOf("brand-icon"),
  today.indexOf("Good morning,"),
  today.indexOf("todayContextLine"),
  today.indexOf("Athlevo Direction"),
  today.indexOf("Today's recommendation"),
  today.indexOf("Open today's workout")
];
test("first viewport follows mark → greeting → context → direction → recommendation → action",
  positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
test("Direction is a named live status for assistive technology",
  /id="todayPassiveStatusBlock"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"/.test(today));
test("primary action remains a real button with existing Train routing",
  /class="rec-cta"[\s\S]*?onclick="todayGoToTrain\(\)"[\s\S]*?>Open today's workout<\/button>/.test(today));
test("full briefing disclosure retains its accessible relationship",
  /aria-expanded="false"[\s\S]*?aria-controls="dailyBriefFull"/.test(today));
test("current-week data comes from the authenticated server endpoint",
  /fetch\("\/api\/training\/get-week"[\s\S]*?Authorization:\s*"Bearer "\s*\+\s*session\.access_token/.test(html));
test("Today uses the server-selected valid plan and saved sessions",
  /snapshot\.hasPlan\s*\?\s*snapshot\.plan/.test(html) &&
    /snapshot\.hasPlan[\s\S]*?Array\.isArray\(snapshot\.sessions\)/.test(html));
test("greeting uses the athlete's first name without an email fallback",
  /fullName\.split\(\/\\s\+\/\)\[0\]/.test(brain) &&
    !/profile\.email\?\.split\("@"\)\[0\]/.test(extractFunction(brain, "updateTodayDashboard")));
test("Direction uses theme tokens and no gradient",
  /\.direction-card\{[^}]*background:var\(--ink\)/.test(html) &&
    !/\.direction-card\{[^}]*gradient/.test(html));
test("global reduced-motion support remains present",
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
