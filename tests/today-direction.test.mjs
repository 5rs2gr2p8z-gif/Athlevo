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
const helpers = new Function(
  `${directionConstants}\n${classifySource}\n${viewSource}\n${contextSource}
   return { classifyAthlevoDirection, buildAthlevoDirectionView, buildTodayTrainingContext };`
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
  test("PUSH receives concise presentation copy without changing classification",
    complete.direction.state === "PUSH" &&
    complete.recommendationTitle === "Proceed as planned." &&
    complete.coaching === "Available recovery signals support today’s session.");
  test("complete signal set hides the missing-data indicator", complete.quality === "");
}
{
  const partial = helpers.buildAthlevoDirectionView({});
  test("missing readiness is not replaced with a fabricated score",
    partial.score === null && partial.readiness === "No recent check-in");
  test("missing load and pain are labelled honestly",
    partial.load === "Load unavailable" &&
    partial.pain === "Pain unavailable");
  test("incomplete signals show Limited data", partial.quality === "Limited data");
  test("missing signals retain the controlled-day coaching sentence",
    partial.direction.state === "HOLD" &&
    partial.recommendationTitle === "Keep today controlled." &&
    partial.coaching === "Limited data means today should stay measured.");
}
test("reported soreness is shown from the check-in",
  helpers.buildAthlevoDirectionView({
    checkIn: { recorded: true, soreness: 4, painPresent: false }
  }).pain === "Soreness 4/10");
test("load labels use the same conservative boundaries as Direction",
  helpers.buildAthlevoDirectionView({ recovery: { acwr: 0.7 } }).load === "Load below usual" &&
  helpers.buildAthlevoDirectionView({ recovery: { acwr: 1.3 } }).load === "Load elevated" &&
  helpers.buildAthlevoDirectionView({ recovery: { acwr: 1.5 } }).load === "Load high");
test("a partial check-in is not mislabeled as absent",
  helpers.buildAthlevoDirectionView({
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).readiness === "Check-in incomplete");
test("RECOVER receives concise presentation copy without changing classification",
  helpers.buildAthlevoDirectionView({
    pain: { present: true }
  }).recommendationTitle === "Reduce today’s load." &&
  helpers.buildAthlevoDirectionView({
    pain: { present: true }
  }).coaching === "Recovery signals suggest shortening or replacing the session.");

console.log("\n──── Direction safety overrides ────");
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

console.log("\n──── Workout and CTA behavior ────");
const sessionTypeSource = extractFunction(html, "classifyPlannedSessionType");
const workoutCardSource = extractFunction(html, "buildTodayWorkoutCardView");
const workoutHeadlines = html.slice(
  html.indexOf("var TODAY_REC_HEADLINES"),
  html.indexOf("function classifyPlannedSessionType")
);
const workoutHelpers = new Function(
  "formatSessionType",
  `${workoutHeadlines}
   ${sessionTypeSource}
   function todayLocalKey(){ return "2026-07-29"; }
   ${workoutCardSource}
   return { buildTodayWorkoutCardView };`
)(value => String(value || ""));

const noPlanView = workoutHelpers.buildTodayWorkoutCardView({
  hasPlan: false,
  sessions: []
});
test("no plan produces the single Build plan action",
  noPlanView.action === "build" &&
  noPlanView.actionLabel === "Build plan" &&
  noPlanView.recommendationTitle === "No workout yet.");
test("no plan recommendation explains the truthful next step",
  noPlanView.recommendationBody ===
    "Build your first plan so Athlevo can guide today’s training.");

const workoutView = workoutHelpers.buildTodayWorkoutCardView({
  hasPlan: true,
  sessions: [{
    session_date: "2026-07-29",
    session_type: "easy",
    duration_minutes: 35,
    target_rpe: "2–3"
  }]
});
test("today's saved workout produces Open workout and an inline summary",
  workoutView.action === "workout" &&
  workoutView.actionLabel === "Open workout" &&
  workoutView.summary === "Easy Run · 35 min · RPE 2–3");

const noWorkoutView = workoutHelpers.buildTodayWorkoutCardView({
  hasPlan: true,
  sessions: []
});
test("a valid plan without today's workout produces View plan",
  noWorkoutView.action === "view" &&
  noWorkoutView.actionLabel === "View plan" &&
  noWorkoutView.summary === "");

const restView = workoutHelpers.buildTodayWorkoutCardView({
  hasPlan: true,
  sessions: [{ session_date: "2026-07-29", session_type: "rest" }]
});
test("an explicit rest day produces View plan rather than Open workout",
  restView.action === "view" && restView.actionLabel === "View plan");

console.log("\n──── Markup, data wiring, and accessibility ────");
const today = html.slice(
  html.indexOf('<section class="screen" id="screen-today">'),
  html.indexOf('<section class="screen"', html.indexOf('<section class="screen" id="screen-today">') + 1)
);
const directionMarkup = today.slice(
  today.indexOf('<article class="direction-card"'),
  today.indexOf("</article>", today.indexOf('<article class="direction-card"')) + "</article>".length
);
const directionCss = html.slice(
  html.indexOf(".direction-card{"),
  html.indexOf(".direction-why{")
);
const firstViewportMarkup = today.slice(
  0,
  today.indexOf("</article>", today.indexOf('<article class="direction-card"')) + "</article>".length
);
const firstViewportVisibleText = firstViewportMarkup
  .replace(/<[^>]*>/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const positions = [
  today.indexOf("brand-icon"),
  today.indexOf("Good morning,"),
  today.indexOf("todayContextLine"),
  today.indexOf("Athlevo Direction"),
  today.indexOf("todayDirectionAction"),
  today.indexOf('class="direction-signals"'),
  today.indexOf("todayPassiveStatusBlock"),
  today.indexOf("todayWorkoutSummary")
];
test("first viewport follows greeting → one-card action → signals → recommendation → workout summary",
  positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
test("Direction is named for assistive technology without repeated live announcements",
  /<article class="direction-card"[\s\S]*?aria-label="Athlevo Direction\. Training status is loading\."/.test(today) &&
  !/role="(?:button|tab|status)"|aria-live=|aria-pressed=|aria-selected=/.test(directionMarkup));
test("classification words are absent from visible first-viewport text",
  !/\b(?:RECOVER|HOLD|PUSH)\b/.test(firstViewportVisibleText));
test("track, scale, slider, marker, tab, gauge, and needle markup are absent",
  !/direction-band|direction-zone|direction-marker|direction-dial|direction-scale/.test(directionMarkup) &&
  !/role="(?:slider|tab)"|type="range"|aria-valuenow/.test(directionMarkup) &&
  !/<svg/.test(directionMarkup));
test("vertical accent is the sole visual state mapping",
  /\.direction-card::before\{[^}]*inset:0 auto 0 0[^}]*width:4px[^}]*background:var\(--direction-accent\)[^}]*pointer-events:none/.test(html) &&
  /\.direction-card\[data-direction="recover"\]\{--direction-accent:var\(--direction-recover\)\}/.test(html) &&
  /\.direction-card\[data-direction="hold"\]\{--direction-accent:var\(--direction-hold\)\}/.test(html) &&
  /\.direction-card\[data-direction="push"\]\{--direction-accent:var\(--direction-push\)\}/.test(html));
test("controlled recommendation is concise and limited-data aware",
  /id="todayDirectionLabel">Keep today controlled\.<\/p>[\s\S]*?id="todayDirectionCoaching">Limited data means today should stay measured\.<\/p>/.test(today));
test("Direction card has exactly one contextual action",
  (directionMarkup.match(/<button\b/g) || []).length === 1 &&
  /id="todayDirectionAction"[\s\S]*?onclick="todayDirectionPrimaryAction\(\)"/.test(directionMarkup) &&
  !/role="(?:tab|slider)"|onpointer|tabindex=/.test(directionMarkup));
test("all three compact signal indicators have dynamic mounts",
  /id="todayDirectionCoaching"/.test(today) &&
  /id="todayReadinessSignalValue"/.test(today) &&
  /id="todayLoadSignalValue"/.test(today) &&
  /id="todayPainSignalValue"/.test(today) &&
  (directionMarkup.match(/class="direction-signal-ring"/g) || []).length === 3);
test("missing signals render explicit dashes and honest labels",
  helpers.buildAthlevoDirectionView({}).signals.readiness.value === "—" &&
  helpers.buildAthlevoDirectionView({}).signals.readiness.note === "No check-in" &&
  helpers.buildAthlevoDirectionView({}).signals.load.note === "Unavailable" &&
  helpers.buildAthlevoDirectionView({}).signals.pain.note === "No data");
test("real signal values remain dynamic",
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).signals.readiness.value === "72" &&
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).signals.load.value === "Stable" &&
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).signals.pain.value === "Clear");
test("mini-rings stay compact and avoid a WHOOP-style recovery visualization",
  /\.direction-signal-ring\{[^}]*width:52px;height:52px[^}]*border:2px solid var\(--line\)/.test(html) &&
  !/conic-gradient|radial-gradient|stroke-dasharray/.test(directionCss) &&
  !/<svg/.test(directionMarkup));
test("Direction card remains compact enough for the first viewport",
  /\.direction-card\{[^}]*min-height:238px[^}]*box-sizing:border-box/.test(html));
test("narrow phones reduce greeting size with the existing display token",
  /@media \(max-width:380px\)\{[\s\S]*?\.greet h1\{font-size:calc\(var\(--fs-display\) \* \.88\)/.test(html));
test("narrow phones keep all three indicators in one responsive row",
  /\.direction-signals\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(html) &&
  /@media \(max-width:360px\)\{[\s\S]*?\.direction-signal-ring\{width:48px;height:48px\}/.test(html));
test("semantic accent colors support light and dark mode without gradients",
  /--direction-recover:#315eb8/.test(html) &&
  /--direction-hold:#8a5700/.test(html) &&
  /--direction-push:var\(--red\)/.test(html) &&
  /html\[data-theme="dark"\] \.direction-card\{[\s\S]*?--direction-recover:#78a6ff;--direction-hold:#e2a94a/.test(html) &&
  !/\.direction-card\{[^}]*gradient/.test(html));
test("CTA dispatch keeps existing build and Train navigation",
  /button\.dataset\.action === "build"[\s\S]*?window\.AthlevoPlan\.start\(\)/.test(
    extractFunction(html, "todayDirectionPrimaryAction")) &&
  /todayGoToTrain\(\)/.test(extractFunction(html, "todayDirectionPrimaryAction")));
test("separate workout and large Today plan cards are removed",
  !/class="today-workout-card"|id="todayRecommendationHeadline"|id="todayWorkoutCta"/.test(today) &&
  !/id="todayPlanCta"|#todayPlanCta \.tpc-cta/.test(html));
test("only the in-card workout summary remains",
  /class="direction-workout-summary" id="todayWorkoutSummary" hidden/.test(directionMarkup));
test("Why this is a native expandable disclosure immediately below the combined card",
  today.indexOf('<details class="direction-why">') > today.indexOf("</article>") &&
  /<details class="direction-why">\s*<summary>Why this\?<\/summary>/.test(today));
test("workout summary uses only saved session metadata",
  /Number\(session\.duration_minutes\)/.test(html) &&
  /Number\(session\.distance_km\)/.test(html) &&
  /session\.intensity/.test(html) &&
  /session\.target_rpe/.test(html));
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
test("combined card avoids animated charts and preserves restrained button motion",
  !/animation:|(?:^|[;{])transform:|stroke-dasharray/.test(directionCss) &&
  /\.direction-action\{[^}]*transition:opacity var\(--dur-fast\) var\(--ease-standard\)/.test(html));
test("global reduced-motion support remains present",
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
