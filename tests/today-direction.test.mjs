/**
 * Focused executable checks for the Today first viewport.
 * Run: node tests/today-direction.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const brain = readFileSync("./js/brain.js", "utf8");
const coachData = readFileSync("./js/coachBrainData.js", "utf8");
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
const viewSource = extractFunction(html, "buildAthlevoDirectionView");
const contextSource = extractFunction(html, "buildTodayTrainingContext");
const needleSource = extractFunction(html, "directionZoneNeedleDeg");
const helpers = new Function(
  `${directionConstants}\n${classifySource}\n${viewSource}\n${contextSource}\n${needleSource}
   return { classifyAthlevoDirection, buildAthlevoDirectionView, buildTodayTrainingContext, directionZoneNeedleDeg };`
)();

console.log("\n──── Direction score and state behavior ────");
test("missing readiness safely resolves to HOLD",
  helpers.classifyAthlevoDirection({}).state === "HOLD");
test("moderate readiness resolves to HOLD",
  helpers.classifyAthlevoDirection({ readiness: { status: "moderate" } }).state === "HOLD");
test("good readiness resolves to PUSH",
  helpers.classifyAthlevoDirection({ readiness: { status: "good" } }).state === "PUSH");
test("existing readiness thresholds map 0–39 RECOVER, 40–59 HOLD, 60–100 PUSH",
  helpers.classifyAthlevoDirection({ readiness: { score: 39 } }).state === "RECOVER" &&
  helpers.classifyAthlevoDirection({ readiness: { score: 40 } }).state === "HOLD" &&
  helpers.classifyAthlevoDirection({ readiness: { score: 59 } }).state === "HOLD" &&
  helpers.classifyAthlevoDirection({ readiness: { score: 60 } }).state === "PUSH" &&
  helpers.classifyAthlevoDirection({ readiness: { score: 100 } }).state === "PUSH");
test("recent pain resolves to RECOVER",
  helpers.classifyAthlevoDirection({ pain: { present: true } }).state === "RECOVER");
test("very high acute load resolves to RECOVER",
  helpers.classifyAthlevoDirection({ recovery: { acwr: 1.5 } }).state === "RECOVER");
test("direction labels stay short and human",
  helpers.classifyAthlevoDirection({}).label === "Controlled day" &&
  helpers.classifyAthlevoDirection({ readiness: { score: 80 } }).label === "Ready to push" &&
  helpers.classifyAthlevoDirection({ pain: { present: true } }).label === "Recovery first");

console.log("\n──── Truthful contributors and confidence ────");
{
  const complete = helpers.buildAthlevoDirectionView({
    readiness: { score: 72, status: "good" },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  });
  test("real readiness score is displayed without recomputation", complete.score === 72);
  test("readiness signal uses compact label", complete.readiness === "Readiness 72");
  test("stable real load is labelled compactly", complete.load === "Load stable");
  test("completed pain check-in can truthfully say clear", complete.pain === "Pain clear");
  test("complete signal set hides the missing-data indicator", complete.quality === "");
}
{
  const partial = helpers.buildAthlevoDirectionView({});
  test("missing readiness is not replaced with a fabricated score",
    partial.score === null && partial.readiness === "No check-in");
  test("missing load and pain are labelled honestly",
    partial.load === "Load unavailable" &&
    partial.pain === "Pain unavailable");
  test("incomplete signals show Limited data", partial.quality === "Limited data");
}
test("reported soreness is shown from the check-in",
  helpers.buildAthlevoDirectionView({
    checkIn: { recorded: true, soreness: 4, painPresent: false }
  }).pain === "Soreness 4/10");
test("load labels use the same conservative boundaries as Direction",
  helpers.buildAthlevoDirectionView({ recovery: { acwr: 1.3 } }).load === "Load elevated" &&
  helpers.buildAthlevoDirectionView({ recovery: { acwr: 1.5 } }).load === "Load high");
test("a partial check-in is not mislabeled as absent",
  helpers.buildAthlevoDirectionView({
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).readiness === "Check-in incomplete");

console.log("\n──── Instrument needle follows direction, not score ────");
test("needle centers on the recover zone",
  helpers.directionZoneNeedleDeg("recover") === -63);
test("needle centers on the hold zone",
  helpers.directionZoneNeedleDeg("hold") === 0);
test("needle centers on the push zone",
  helpers.directionZoneNeedleDeg("push") === 63);
test("pain override keeps RECOVER even with a high readiness score",
  helpers.classifyAthlevoDirection({
    readiness: { score: 82, status: "good" },
    pain: { present: true }
  }).state === "RECOVER");
test("high load override keeps HOLD even with a high readiness score",
  helpers.classifyAthlevoDirection({
    readiness: { score: 82, status: "good" },
    recovery: { acwr: 1.35 }
  }).state === "HOLD");

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
  today.indexOf("todayPassiveStatusBlock"),
  today.indexOf("todayDirectionDialNeedle"),
  today.indexOf("Today's workout"),
  today.indexOf("Open today's workout")
];
test("first viewport follows mark → greeting → context → instrument → workout → action",
  positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
test("Direction is a named live status for assistive technology",
  /id="todayPassiveStatusBlock"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"/.test(today));
test("instrument has an accessible title and dynamic description",
  /role="img" aria-labelledby="todayDirectionDialTitle todayDirectionDialDescription"/.test(today) &&
  /id="todayDirectionDialDescription"/.test(today));
test("instrument is a three-zone open arc, not a copied circular ring",
  /class="direction-zone direction-zone--recover"[\s\S]*?d="M30 124 A90 90 0 0 1 210 124"/.test(today) &&
  /class="direction-zone direction-zone--hold"/.test(today) &&
  /class="direction-zone direction-zone--push"/.test(today) &&
  !/<circle[^>]+class="direction-zone/.test(today) &&
  !/id="todayDirectionDialValue"/.test(today));
test("active zone styling is driven by data-direction on the card",
  /\.direction-card\[data-direction="recover"\] \.direction-zone--recover/.test(html) &&
  /\.direction-card\[data-direction="hold"\] \.direction-zone--hold/.test(html) &&
  /\.direction-card\[data-direction="push"\] \.direction-zone--push/.test(html));
test("needle follows direction zone, not readiness score arc",
  /directionZoneNeedleDeg\(key\)/.test(html) &&
  !/dialScore \* 1\.8/.test(html));
test("center score and all three evidence values have dedicated mounts",
  /id="todayDirectionScore"/.test(today) &&
  /class="direction-evidence"/.test(today) &&
  /id="todayDirectionRecovery"/.test(today) &&
  /id="todayDirectionLoad"/.test(today) &&
  /id="todayDirectionPain"/.test(today) &&
  !/direction-signal"/.test(today));
test("missing evidence renders as one quiet line",
  /<p class="direction-evidence"[\s\S]*?No check-in[\s\S]*?Load unavailable[\s\S]*?Pain unavailable[\s\S]*?<\/p>/.test(today));
test("instrument is roughly twenty percent larger",
  /\.direction-dial\{[^}]*width:min\(100%,326px\)[^}]*height:146px/.test(html));
test("zone labels use a normal phone-readable type token",
  /\.direction-zone-label\{[^}]*font-size:var\(--fs-caption\)/.test(html));
test("active zone is substantially stronger than inactive zones",
  /\.direction-zone\{[^}]*stroke-width:9[^}]*opacity:\.2/.test(html) &&
  /direction-zone--push\{opacity:1;stroke-width:15\}/.test(html));
test("needle is a short arc pointer clear of the center score",
  /id="todayDirectionDialNeedle" x1="120" y1="47" x2="120" y2="65"/.test(today) &&
  !/class="direction-dial-pivot"/.test(today));
test("Limited data is quiet text rather than a pill",
  /\.direction-quality\{[^}]*color:var\(--ink3\)[^}]*padding:2px 0/.test(html) &&
  !/\.direction-quality\{[^}]*background:/.test(html));
test("narrow phones reduce greeting size with the existing display token",
  /@media \(max-width:380px\)\{[\s\S]*?\.greet h1\{font-size:calc\(var\(--fs-display\) \* \.88\)/.test(html));
test("missing score hides the /100 denominator instead of showing zero",
  /\.direction-card\[data-score="missing"\] \.direction-score-denom\{display:none\}/.test(html) &&
  /value\.score === null \? "—"/.test(html));
test("semantic zone colors are defined without gradients",
  /--zone-recover:#3d6fd4/.test(html) &&
  /--zone-hold:#c4841a/.test(html) &&
  /--zone-push:var\(--red\)/.test(html) &&
  !/\.direction-zone\{[^}]*gradient/.test(html));
test("primary action remains a real button with existing Train routing",
  /class="rec-cta"[\s\S]*?onclick="todayGoToTrain\(\)"[\s\S]*?>Open today's workout<\/button>/.test(today));
test("Why this is a native expandable disclosure below the workout",
  today.indexOf('<details class="direction-why">') > today.indexOf("Open today's workout") &&
  /<details class="direction-why">\s*<summary>Why this\?<\/summary>/.test(today));
test("workout card has real mounts for name, duration/distance, and effort",
  /id="todayRecommendationHeadline"/.test(today) &&
  /id="todayWorkoutMeta"/.test(today) &&
  /id="todayWorkoutEffort"/.test(today));
test("workout renderer uses only saved session metadata with honest fallbacks",
  /Number\(session\.duration_minutes\)/.test(html) &&
  /Number\(session\.distance_km\)/.test(html) &&
  /session\.intensity/.test(html) &&
  /session\.target_rpe/.test(html) &&
  /session\.pace_guidance/.test(html) &&
  /Effort cue unavailable/.test(html));
test("current-week data comes from the authenticated server endpoint",
  /fetch\("\/api\/training\/get-week"[\s\S]*?Authorization:\s*"Bearer "\s*\+\s*session\.access_token/.test(html));
test("Today uses the server-selected valid plan and saved sessions",
  /snapshot\.hasPlan\s*\?\s*snapshot\.plan/.test(html) &&
    /snapshot\.hasPlan[\s\S]*?Array\.isArray\(snapshot\.sessions\)/.test(html));
test("signal collector exposes only real check-in soreness and pain flags",
  /signals\.checkIn\s*=\s*\{[\s\S]*?soreness:\s*num\(r\.muscleSoreness1to10\)[\s\S]*?painPresent:\s*r\.painPresent\s*===\s*true/.test(coachData));
test("greeting uses the athlete's first name without an email fallback",
  /fullName\.split\(\/\\s\+\/\)\[0\]/.test(brain) &&
    !/profile\.email\?\.split\("@"\)\[0\]/.test(extractFunction(brain, "updateTodayDashboard")));
test("Direction uses a theme-aware editorial surface and no gradient",
  /\.direction-card\{[^}]*background:var\(--paper\)/.test(html) &&
    !/\.direction-card\{[^}]*gradient/.test(html));
test("needle appearance uses restrained tokenized motion",
  /\.direction-dial-needle\{[^}]*transition:[^}]*var\(--dur-slow\)[^}]*var\(--ease-standard\)/.test(html));
test("global reduced-motion support remains present",
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
