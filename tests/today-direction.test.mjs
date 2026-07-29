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
const readinessPresentationSource = extractFunction(
  html,
  "buildReadinessSignalPresentation"
);
const viewSource = extractFunction(html, "buildAthlevoDirectionView");
const contextSource = extractFunction(html, "buildTodayTrainingContext");
const helpers = new Function(
  `${directionConstants}\n${classifySource}\n${readinessPresentationSource}\n${viewSource}\n${contextSource}
   return {
     classifyAthlevoDirection,
     buildReadinessSignalPresentation,
     buildAthlevoDirectionView,
     buildTodayTrainingContext
   };`
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

console.log("\n──── Readiness ring presentation ────");
test("0–39 maps exactly to Low and the semantic red tone",
  [0, 39].every(score => {
    const signal = helpers.buildReadinessSignalPresentation(score);
    return signal.value === String(score) &&
      signal.note === "Low" &&
      signal.tone === "readiness-low" &&
      signal.progress === score;
  }));
test("40–69 maps exactly to Moderate and the semantic amber tone",
  [40, 61, 69].every(score => {
    const signal = helpers.buildReadinessSignalPresentation(score);
    return signal.value === String(score) &&
      signal.note === "Moderate" &&
      signal.tone === "readiness-moderate" &&
      signal.progress === score;
  }));
test("70–100 maps exactly to Good and the semantic green tone",
  [70, 100].every(score => {
    const signal = helpers.buildReadinessSignalPresentation(score);
    return signal.value === String(score) &&
      signal.note === "Good" &&
      signal.tone === "readiness-good" &&
      signal.progress === score;
  }));
test("missing readiness has no arc and no fabricated number",
  JSON.stringify(helpers.buildReadinessSignalPresentation(null)) ===
    JSON.stringify({
      value: "—",
      note: "No check-in",
      tone: "missing",
      progress: 0,
      progressKind: "missing"
    }) &&
  helpers.buildAthlevoDirectionView({
    readiness: { score: null }
  }).signals.readiness.value === "—");
test("score 61 stays Moderate even when source status metadata says good",
  helpers.buildAthlevoDirectionView({
    readiness: { score: 61, status: "good" }
  }).signals.readiness.note === "Moderate");

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

console.log("\n──── Body feedback presentation ────");
test("no pain or soreness maps to Clear with the positive tone",
  (() => {
    const body = helpers.buildAthlevoDirectionView({
      checkIn: { recorded: true, soreness: 1, painPresent: false }
    }).signals.pain;
    return body.value === "Clear" &&
      body.note === "No issues" &&
      body.tone === "positive";
  })());
test("reported soreness maps to Mild with the warning tone",
  [2, 7].every(soreness => {
    const body = helpers.buildAthlevoDirectionView({
      checkIn: { recorded: true, soreness, painPresent: false }
    }).signals.pain;
    return body.value === "Mild" &&
      body.note === "Some soreness" &&
      body.tone === "warning";
  }));
test("meaningful pain maps to Pain with the risk tone",
  (() => {
    const body = helpers.buildAthlevoDirectionView({
      checkIn: { recorded: true, soreness: 1, painPresent: true },
      pain: { present: true }
    }).signals.pain;
    return body.value === "Pain" &&
      body.note === "Pain reported" &&
      body.tone === "risk";
  })());
test("missing body check-in stays neutral and explicit",
  (() => {
    const body = helpers.buildAthlevoDirectionView({}).signals.pain;
    return body.value === "—" &&
      body.note === "No check-in" &&
      body.tone === "missing" &&
      body.progress === 0;
  })());

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

console.log("\n──── Readiness ring transition behavior ────");
const readinessStateSource = html.slice(
  html.indexOf("var todayReadinessRingState"),
  html.indexOf("function buildReadinessRingTransition")
);
const readinessTransitionSource = extractFunction(
  html,
  "buildReadinessRingTransition"
);
const reducedMotionSource = extractFunction(
  html,
  "todayDirectionPrefersReducedMotion"
);
const readinessRenderSource = extractFunction(
  html,
  "renderTodayReadinessSignal"
);

function makeReadinessRingRuntime(reducedMotion = false) {
  const frames = [];
  const cancelled = new Set();
  let nextFrameId = 1;
  const fakeWindow = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id) {
      cancelled.add(id);
    }
  };
  const api = new Function(
    "window",
    `${readinessStateSource}
     ${readinessTransitionSource}
     ${reducedMotionSource}
     ${readinessRenderSource}
     return {
       renderTodayReadinessSignal,
       buildReadinessRingTransition,
       state: todayReadinessRingState
     };`
  )(fakeWindow);
  function runNextFrame(timestamp) {
    while (frames.length) {
      const frame = frames.shift();
      if (!cancelled.has(frame.id)) {
        frame.callback(timestamp);
        return true;
      }
    }
    return false;
  }
  return { api, frames, runNextFrame };
}

function makeSignalNode() {
  const properties = new Map();
  const attributes = new Map();
  return {
    textContent: "",
    dataset: {},
    style: {
      setProperty(name, value) { properties.set(name, value); },
      getPropertyValue(name) { return properties.get(name); }
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); }
  };
}

const readiness61 = {
  value: "61",
  note: "Moderate",
  tone: "readiness-moderate",
  progress: 61,
  progressKind: "normalized"
};
{
  const runtime = makeReadinessRingRuntime();
  const root = makeSignalNode();
  const value = makeSignalNode();
  const note = makeSignalNode();
  runtime.api.renderTodayReadinessSignal(root, value, note, readiness61);
  test("initial confirmed readiness animates from an empty arc without flashing zero",
    root.style.getPropertyValue("--signal-progress") === "0" &&
    value.textContent === "1" &&
    runtime.frames.length === 1);
  test("accessible readiness text exposes score, scale, and status immediately",
    root.getAttribute("aria-label") ===
      "Readiness 61 out of 100, Moderate");
  runtime.runNextFrame(1000);
  runtime.runNextFrame(1640);
  test("initial animation settles on the confirmed arc, color, and number together",
    root.style.getPropertyValue("--signal-progress") === "61" &&
    root.dataset.tone === "readiness-moderate" &&
    root.dataset.animated === "false" &&
    value.textContent === "61");
  runtime.api.renderTodayReadinessSignal(root, value, note, readiness61);
  test("unchanged readiness renders the final state without replaying",
    runtime.frames.length === 0 &&
    root.dataset.animated === "false" &&
    value.textContent === "61");

  const readiness75 = {
    value: "75",
    note: "Good",
    tone: "readiness-good",
    progress: 75,
    progressKind: "normalized"
  };
  runtime.api.renderTodayReadinessSignal(root, value, note, readiness75);
  test("a changed score begins at the previously confirmed value",
    root.style.getPropertyValue("--signal-progress") === "61" &&
    value.textContent === "61" &&
    runtime.frames.length === 1);
  runtime.runNextFrame(2000);
  runtime.runNextFrame(2640);
  test("a changed score finishes at the new confirmed value and tone",
    root.style.getPropertyValue("--signal-progress") === "75" &&
    root.dataset.tone === "readiness-good" &&
    value.textContent === "75");
}
{
  const runtime = makeReadinessRingRuntime(true);
  const root = makeSignalNode();
  const value = makeSignalNode();
  const note = makeSignalNode();
  runtime.api.renderTodayReadinessSignal(root, value, note, readiness61);
  test("reduced motion renders the final confirmed state immediately",
    runtime.frames.length === 0 &&
    root.style.getPropertyValue("--signal-progress") === "61" &&
    root.dataset.tone === "readiness-moderate" &&
    value.textContent === "61");
}
{
  const runtime = makeReadinessRingRuntime();
  const root = makeSignalNode();
  const value = makeSignalNode();
  const note = makeSignalNode();
  runtime.api.renderTodayReadinessSignal(root, value, note, {
    value: "—",
    note: "No check-in",
    tone: "missing",
    progress: 0,
    progressKind: "missing"
  });
  test("missing readiness is a neutral dash and never animates from fake zero",
    runtime.frames.length === 0 &&
    value.textContent === "—" &&
    root.dataset.tone === "missing" &&
    root.getAttribute("aria-label") === "Readiness, no check-in");
}

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
  restView.action === "view" &&
  restView.actionLabel === "View plan" &&
  restView.summary === "Rest day");

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
test("interactive scale, slider, marker, tab, gauge, and needle markup are absent",
  !/direction-band|direction-zone|direction-marker|direction-dial|direction-scale/.test(directionMarkup) &&
  !/role="(?:slider|tab)"|type="range"|aria-valuenow/.test(directionMarkup));
test("left state accent and its pseudo-element are removed",
  !/\.direction-card::before/.test(directionCss) &&
  !/--direction-accent|--direction-recover|--direction-hold|--direction-push/.test(directionCss));
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
test("the third signal is visibly and accessibly named Body feedback",
  /id="todayPainSignal" aria-label="Body feedback: no check-in"/.test(directionMarkup) &&
  /class="direction-signal-name">Body feedback<\/span>/.test(directionMarkup) &&
  /setSignal\(painSignal, painValue, painNote, value\.signals\.pain, "Body feedback"\)/.test(html) &&
  !/Pain \/ soreness/.test(directionMarkup));
test("missing signals render explicit dashes and honest labels",
  helpers.buildAthlevoDirectionView({}).signals.readiness.value === "—" &&
  helpers.buildAthlevoDirectionView({}).signals.readiness.note === "No check-in" &&
  helpers.buildAthlevoDirectionView({}).signals.load.note === "Load unavailable" &&
  helpers.buildAthlevoDirectionView({}).signals.pain.note === "No check-in" &&
  helpers.buildAthlevoDirectionView({}).signals.load.progress === 0 &&
  helpers.buildAthlevoDirectionView({}).signals.pain.progress === 0);
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
test("training-load display mapping remains categorical and unchanged", (() => {
  const missing = helpers.buildAthlevoDirectionView({}).signals.load;
  const below = helpers.buildAthlevoDirectionView({
    recovery: { acwr: 0.7 }
  }).signals.load;
  const stable = helpers.buildAthlevoDirectionView({
    recovery: { acwr: 1 }
  }).signals.load;
  const elevated = helpers.buildAthlevoDirectionView({
    recovery: { acwr: 1.3 }
  }).signals.load;
  const high = helpers.buildAthlevoDirectionView({
    recovery: { acwr: 1.5 }
  }).signals.load;
  return missing.value === "—" &&
    missing.note === "Load unavailable" &&
    missing.tone === "missing" &&
    below.value === "Low" &&
    below.note === "Below usual" &&
    below.tone === "recovery" &&
    stable.value === "Stable" &&
    stable.note === "Within range" &&
    stable.tone === "positive" &&
    elevated.value === "High" &&
    elevated.note === "Elevated" &&
    elevated.tone === "warning" &&
    high.value === "High" &&
    high.note === "High load" &&
    high.tone === "risk";
})());
test("readiness uses a normalized real score while load and pain are categorical",
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).signals.readiness.progress === 72 &&
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).signals.readiness.progressKind === "normalized" &&
  helpers.buildAthlevoDirectionView({
    recovery: { acwr: 1.04 }
  }).signals.load.progressKind === "categorical" &&
  helpers.buildAthlevoDirectionView({
    checkIn: { recorded: true, soreness: 1, painPresent: false }
  }).signals.pain.progressKind === "categorical");
test("three thin progress rings meet the standard size without gradients",
  /\.direction-signal-ring\{[^}]*width:72px;height:72px/.test(html) &&
  (directionMarkup.match(/class="direction-signal-progress"/g) || []).length === 3 &&
  (directionMarkup.match(/pathLength="100"/g) || []).length === 6 &&
  /\.direction-signal-progress\{[^}]*stroke-dasharray:var\(--signal-progress\) 100/.test(html) &&
  !/conic-gradient|radial-gradient|linear-gradient/.test(directionCss));
test("Direction card remains compact enough for the first viewport",
  /\.direction-card\{[^}]*min-height:252px[^}]*box-sizing:border-box/.test(html));
test("narrow phones reduce greeting size with the existing display token",
  /@media \(max-width:380px\)\{[\s\S]*?\.greet h1\{font-size:calc\(var\(--fs-display\) \* \.88\)/.test(html));
test("narrow phones keep all three indicators in one responsive row",
  /\.direction-signals\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(html) &&
  /@media \(max-width:360px\)\{[\s\S]*?\.direction-signal-ring\{width:64px;height:64px\}/.test(html));
test("semantic ring colors support light and dark mode without gradients",
  /\.direction-signal\[data-tone="readiness-low"\]\{--signal-color:var\(--bad\)\}/.test(html) &&
  /\.direction-signal\[data-tone="readiness-moderate"\]\{--signal-color:var\(--warn\)\}/.test(html) &&
  /\.direction-signal\[data-tone="readiness-good"\]\{--signal-color:var\(--good\)\}/.test(html) &&
  /\.direction-signal\[data-tone="recovery"\]\{--signal-color:#3970c8\}/.test(html) &&
  /\.direction-signal\[data-tone="positive"\]\{--signal-color:var\(--good\)\}/.test(html) &&
  /html\[data-theme="dark"\] \.direction-signal\[data-tone="recovery"\]\{--signal-color:#78a6ff\}/.test(html) &&
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
test("only confirmed readiness transitions, using the calm 640ms ease-out treatment",
  !/\.direction-signal(?:-ring|-progress)?\{[^}]*animation:/.test(directionCss) &&
  /\.direction-signal\[data-animated="true"\] \.direction-signal-progress\{[^}]*transition:stroke-dasharray calc\(var\(--dur-slow\) \* 2\) var\(--ease-standard\),[\s\S]*?stroke calc\(var\(--dur-slow\) \* 2\) var\(--ease-standard\)/.test(directionCss) &&
  /var duration = 640;/.test(readinessRenderSource) &&
  /\.direction-action\{[^}]*transition:opacity var\(--dur-fast\) var\(--ease-standard\)/.test(html));
test("global reduced-motion support remains present",
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important/.test(html) &&
  /todayDirectionPrefersReducedMotion\(\)/.test(readinessRenderSource));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
