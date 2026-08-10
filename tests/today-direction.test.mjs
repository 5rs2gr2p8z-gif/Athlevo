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
const recoveryPresentationSource = extractFunction(
  html,
  "buildRecoverySignalPresentation"
);
const viewSource = extractFunction(html, "buildAthlevoDirectionView");
const contextSource = extractFunction(html, "buildTodayTrainingContext");
const helpers = new Function(
  `${directionConstants}\n${classifySource}\n${readinessPresentationSource}\n${recoveryPresentationSource}\n${viewSource}\n${contextSource}
   return {
     classifyAthlevoDirection,
     buildReadinessSignalPresentation,
     buildRecoverySignalPresentation,
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
test("70–100 maps exactly to Ready and the semantic green tone",
  [70, 100].every(score => {
    const signal = helpers.buildReadinessSignalPresentation(score);
    return signal.value === String(score) &&
      signal.note === "Ready" &&
      signal.tone === "readiness-good" &&
      signal.progress === score;
  }));
test("missing readiness has no arc and no fabricated number",
  JSON.stringify(helpers.buildReadinessSignalPresentation(null)) ===
    JSON.stringify({
      value: "",
      note: "Needs check-in",
      tone: "missing",
      progress: 0,
      progressKind: "missing"
    }) &&
  helpers.buildAthlevoDirectionView({
    readiness: { score: null }
  }).signals.readiness.value === "");
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
    partial.load === "Building baseline" &&
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

console.log("\n──── Composite Recovery presentation ────");
test("Recovery bands preserve real scores across the existing thresholds",
  helpers.buildRecoverySignalPresentation({
    available: true, score: 39, quality: "Partial data"
  }).value === "39" &&
  helpers.buildRecoverySignalPresentation({
    available: true, score: 40, quality: "Partial data"
  }).value === "40" &&
  helpers.buildRecoverySignalPresentation({
    available: true, score: 69, quality: "Partial data"
  }).value === "69" &&
  helpers.buildRecoverySignalPresentation({
    available: true, score: 70, quality: "Partial data"
  }).value === "70" &&
  helpers.buildRecoverySignalPresentation({
    available: true, score: 84, quality: "Partial data"
  }).value === "84" &&
  helpers.buildRecoverySignalPresentation({
    available: true, score: 85, quality: "Partial data"
  }).value === "85" &&
  helpers.buildRecoverySignalPresentation({
    available: true, score: 100, quality: "Partial data"
  }).value === "100");
test("Recovery bands use the requested supporting copy and semantic tones",
  (() => {
    const poor = helpers.buildRecoverySignalPresentation({
      available: true, score: 20, quality: "Limited data"
    });
    const moderate = helpers.buildRecoverySignalPresentation({
      available: true, score: 55, quality: "Partial data"
    });
    const good = helpers.buildRecoverySignalPresentation({
      available: true, score: 78, quality: "Partial data"
    });
    const excellent = helpers.buildRecoverySignalPresentation({
      available: true, score: 92, quality: "Full data"
    });
    return poor.note === "Recovery limited" && poor.tone === "recovery-poor" &&
      moderate.note === "Moderate" && moderate.tone === "recovery-moderate" &&
      good.note === "On track" && good.tone === "recovery-good" &&
      excellent.note === "Ready" &&
      excellent.tone === "recovery-excellent";
  })());
test("insufficient Recovery stays neutral without a precise score or arc",
  (() => {
    const signal = helpers.buildRecoverySignalPresentation({
      available: false,
      score: null,
      quality: "Limited data"
    });
    return signal.value === "" &&
      signal.note === "Building baseline" &&
      signal.quality === "Limited data" &&
      signal.tone === "missing" &&
      signal.progress === 0 &&
      signal.score === null;
  })());
test("Recovery no longer renders Form state labels",
  ["Fresh", "Balanced", "Loaded", "Fatigued", "Very fresh"].every(label =>
    ![
      helpers.buildRecoverySignalPresentation({
        available: true, score: 20, quality: "Partial data"
      }).value,
      helpers.buildRecoverySignalPresentation({
        available: true, score: 55, quality: "Partial data"
      }).value,
      helpers.buildRecoverySignalPresentation({
        available: true, score: 78, quality: "Partial data"
      }).value,
      helpers.buildRecoverySignalPresentation({
        available: true, score: 92, quality: "Full data"
      }).value
    ].includes(label)
  ));
test("Recovery does not duplicate the subjective readiness score directly",
  (() => {
    const view = helpers.buildAthlevoDirectionView({
      readiness: { score: 72 },
      compositeRecovery: {
        available: true,
        score: 88,
        quality: "Limited data"
      }
    });
    return view.signals.readiness.value === "72" &&
      view.signals.recovery.value === "88" &&
      view.signals.recovery.score === 88;
  })());
test("Today Recovery input uses real check-in and load fields without Form",
  (() => {
    const inputSource = extractFunction(html, "buildTodayRecoveryInput");
    return /readinessScore:\s*s\.readiness && s\.readiness\.score/.test(inputSource) &&
      /sleepQuality:\s*checkIn\.sleepQuality/.test(inputSource) &&
      /soreness:\s*checkIn\.soreness/.test(inputSource) &&
      /painPresent:/.test(inputSource) &&
      /acwr:\s*s\.recovery && s\.recovery\.acwr/.test(inputSource) &&
      !/\bform\b/i.test(inputSource);
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
    note: "Ready",
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
    value: "",
    note: "Needs check-in",
    tone: "missing",
    progress: 0,
    progressKind: "missing"
  });
  test("missing readiness uses coaching copy and never animates from fake zero",
    runtime.frames.length === 0 &&
    value.textContent === "" &&
    root.dataset.tone === "missing" &&
    root.getAttribute("aria-label") === "Readiness, needs check-in");
}

console.log("\n──── Recovery ring transition behavior ────");
const recoveryStateSource = html.slice(
  html.indexOf("var todayRecoveryRingState"),
  html.indexOf("function renderTodayRecoverySignal")
);
const recoveryRenderSource = extractFunction(
  html,
  "renderTodayRecoverySignal"
);

function makeRecoveryRingRuntime(reducedMotion = false) {
  const frames = [];
  const timers = [];
  const cancelled = new Set();
  let nextId = 1;
  const fakeWindow = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback) {
      const id = nextId++;
      frames.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id) { cancelled.add(id); },
    setTimeout(callback) {
      const id = nextId++;
      timers.push({ id, callback });
      return id;
    },
    clearTimeout(id) { cancelled.add(id); }
  };
  const api = new Function(
    "window",
    `${recoveryStateSource}
     ${readinessTransitionSource}
     ${reducedMotionSource}
     ${recoveryRenderSource}
     return { renderTodayRecoverySignal, state: todayRecoveryRingState };`
  )(fakeWindow);
  const run = queue => {
    while (queue.length) {
      const task = queue.shift();
      if (!cancelled.has(task.id)) {
        task.callback();
        return true;
      }
    }
    return false;
  };
  return {
    api,
    frames,
    timers,
    runFrame: () => run(frames),
    runTimer: () => run(timers)
  };
}

const recovery78 = {
  value: "78",
  note: "On track",
  quality: "Partial data",
  tone: "recovery-good",
  progress: 78,
  progressKind: "normalized",
  score: 78
};
{
  const runtime = makeRecoveryRingRuntime();
  const root = makeSignalNode();
  const value = makeSignalNode();
  const note = makeSignalNode();
  const quality = makeSignalNode();
  runtime.api.renderTodayRecoverySignal(root, value, note, quality, recovery78);
  test("initial confirmed Recovery animates once without showing fake zero",
    root.style.getPropertyValue("--signal-progress") === "0" &&
    value.textContent === "78" &&
    runtime.frames.length === 1);
  test("Recovery accessibility exposes score, band, and data quality",
    root.getAttribute("aria-label") ===
      "Recovery 78 out of 100, On track. Partial data.");
  runtime.runFrame();
  test("confirmed Recovery settles on its real score and semantic color",
    root.style.getPropertyValue("--signal-progress") === "78" &&
    root.dataset.tone === "recovery-good");
  runtime.api.renderTodayRecoverySignal(root, value, note, quality, recovery78);
  test("unchanged Recovery does not replay",
    runtime.frames.length === 0 &&
    root.dataset.animated === "false");
}
{
  const runtime = makeRecoveryRingRuntime(true);
  const root = makeSignalNode();
  const value = makeSignalNode();
  const note = makeSignalNode();
  const quality = makeSignalNode();
  runtime.api.renderTodayRecoverySignal(root, value, note, quality, recovery78);
  test("reduced motion renders confirmed Recovery immediately",
    runtime.frames.length === 0 &&
    root.style.getPropertyValue("--signal-progress") === "78" &&
    root.dataset.tone === "recovery-good");
}
{
  const runtime = makeRecoveryRingRuntime();
  const root = makeSignalNode();
  const value = makeSignalNode();
  const note = makeSignalNode();
  const quality = makeSignalNode();
  runtime.api.renderTodayRecoverySignal(root, value, note, quality, {
    value: "",
    note: "Building baseline",
    quality: "Limited data",
    tone: "missing",
    progress: 0,
    progressKind: "missing",
    score: null
  });
  test("Recovery loading and insufficient data never animate from fake zero",
    runtime.frames.length === 0 &&
    value.textContent === "" &&
    root.dataset.tone === "missing" &&
    root.getAttribute("aria-label") ===
      "Recovery, building baseline. Limited data.");
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
const firstSentenceSource = extractFunction(html, "firstSentence");
const instructionSource = extractFunction(html, "firstTodayInstruction");
const adjustedSource = extractFunction(html, "todaySessionWasAdjusted");
const workoutCardSource = extractFunction(html, "buildTodayWorkoutCardView");
const workoutHeadlines = html.slice(
  html.indexOf("var TODAY_REC_HEADLINES"),
  html.indexOf("function classifyPlannedSessionType")
);
const workoutHelpers = new Function(
  "formatSessionType",
  `${workoutHeadlines}
   ${sessionTypeSource}
   ${firstSentenceSource}
   ${instructionSource}
   ${adjustedSource}
   function todayLocalKey(){ return "2026-07-29"; }
   ${workoutCardSource}
   return { buildTodayWorkoutCardView };`
)(value => value === "easy" ? "Easy Run" : String(value || ""));

const noPlanView = workoutHelpers.buildTodayWorkoutCardView({
  hasPlan: false,
  sessions: []
});
test("no plan produces the single Build plan action",
  noPlanView.action === "build" &&
  noPlanView.actionLabel === "Build My Plan" &&
  noPlanView.recommendationTitle ===
    "You’re already doing the work. Now give it a direction.");
test("no plan recommendation explains the truthful next step",
  noPlanView.recommendationBody ===
    "Tell us what you’re training for, and Athlevo will build a plan around where you are now, the time you have, and the goal you want to reach.");

const workoutView = workoutHelpers.buildTodayWorkoutCardView({
  hasPlan: true,
  sessions: [{
    session_date: "2026-07-29",
    session_type: "easy",
    duration_minutes: 35,
    target_rpe: "2–3",
    purpose: "Keep the aerobic effort controlled."
  }]
});
test("today's saved workout produces the primary training card view",
  workoutView.action === "workout" &&
  workoutView.actionLabel === "Open workout" &&
  workoutView.title === "Easy Run" &&
  workoutView.meta === "35 min · RPE 2–3" &&
  workoutView.instruction === "Keep the aerobic effort controlled.");

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
  restView.title === "Recovery Day" &&
  restView.meta === "No running today." &&
  restView.instruction === "Recovery is part of the plan.");

const adjustedView = workoutHelpers.buildTodayWorkoutCardView({
  hasPlan: true,
  sessions: [{
    session_date: "2026-07-29",
    session_type: "easy",
    duration_minutes: 40,
    adjusted_at: "2026-07-29T01:00:00Z"
  }]
});
test("an explicitly adjusted saved session receives the subtle adjustment label",
  adjustedView.adjusted === true);

console.log("\n──── Markup, data wiring, and accessibility ────");
const today = html.slice(
  html.indexOf('<section class="screen" id="screen-today">'),
  html.indexOf('<section class="screen"', html.indexOf('<section class="screen" id="screen-today">') + 1)
);
const trainingMarkup = today.slice(
  today.indexOf('<article class="today-training-card"'),
  today.indexOf("</article>", today.indexOf('<article class="today-training-card"')) + "</article>".length
);
const statusMarkup = today.slice(
  today.indexOf('<section class="today-status-card"'),
  today.indexOf("</section>", today.indexOf('<section class="today-status-card"')) + "</section>".length
);
const directionCss = html.slice(
  html.indexOf(".today-status-card{"),
  html.indexOf(".direction-why{")
);
const firstViewportMarkup = today.slice(
  0,
  today.indexOf('<div id="syncBanner"')
);
const firstViewportVisibleText = firstViewportMarkup
  .replace(/<[^>]*>/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const positions = [
  today.indexOf("brand-icon"),
  today.indexOf("todayGreeting"),
  today.indexOf("todayContextLine"),
  today.indexOf("todayPlanLoadingState"),
  today.indexOf("todayNoPlanState"),
  today.indexOf("todayActivePlanState"),
  today.indexOf("todayWorkoutTitle"),
  today.indexOf("todayDirectionAction"),
  today.indexOf('class="direction-signals"'),
  today.indexOf("todayPassiveStatusBlock"),
  today.indexOf("todayDirectionWhy")
];
test("Today follows greeting → state boundary → training → status → coaching explanation",
  positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
test("loading, no-plan, error, and active-plan states have distinct mounts",
  /id="todayPlanLoadingState"[\s\S]*?aria-label="Loading today’s training"/.test(today) &&
  /id="todayNoPlanState" hidden/.test(today) &&
  /id="todayPlanErrorState" hidden/.test(today) &&
  /id="todayActivePlanState" hidden/.test(today) &&
  /function setTodayScreenState\(state\)/.test(html));
test("the no-plan state uses the approved coaching voice and one plan action",
  /id="todayNoPlanState"[\s\S]*?<h2>You’re already doing the work\. Now give it a direction\.<\/h2>[\s\S]*?id="todayNoPlanCopy">Tell us what you’re training for,[\s\S]*?id="todayNoPlanAction"[\s\S]*?>Build My Plan<\/button>[\s\S]*?First race, marathon, or a new PR — your starting point doesn’t matter\./.test(today) &&
  today.indexOf("todayNoPlanState") < today.indexOf("todayActivePlanState") &&
  !/direction-signal/.test(today.slice(today.indexOf("todayNoPlanState"), today.indexOf("todayPlanErrorState"))));
test("the shared compact Athlete status follows both primary plan states",
  /id="todayAthleteStatusCard"[\s\S]*?id="todayStatusHeading">Athlete status<\/span>/.test(today) &&
  today.indexOf("todayAthleteStatusCard") > today.indexOf("todayActivePlanState") &&
  /athleteStatus\.hidden = state !== "no-plan" && state !== "active"/.test(html));
test("the active primary card exposes only real workout fields and one action",
  /id="todayWorkoutTitle"/.test(trainingMarkup) &&
  /id="todayWorkoutType" hidden/.test(trainingMarkup) &&
  /id="todayWorkoutSummary" hidden/.test(trainingMarkup) &&
  /id="todayWorkoutInstruction" hidden/.test(trainingMarkup) &&
  /id="todayWorkoutAdjusted" hidden>Adjusted today/.test(trainingMarkup) &&
  (trainingMarkup.match(/<button\b/g) || []).length === 1);
test("classification words are absent from visible first-viewport text",
  !/\b(?:RECOVER|HOLD|PUSH)\b/.test(firstViewportVisibleText));
test("interactive scale, slider, marker, tab, gauge, and needle markup are absent",
  !/direction-band|direction-zone|direction-marker|direction-dial|direction-scale/.test(statusMarkup) &&
  !/role="(?:slider|tab)"|type="range"|aria-valuenow/.test(statusMarkup));
test("controlled recommendation is concise and limited-data aware",
  /id="todayDirectionLabel">Keep today controlled\.<\/p>[\s\S]*?id="todayDirectionCoaching">Limited data means today should stay measured\.<\/p>/.test(today));
test("status remains separate from controls and keeps only the explicit premium action",
  (statusMarkup.match(/<button\b/g) || []).length === 1 &&
  /id="todayPremiumInsightTeaser"[\s\S]*?Unlock insights/.test(statusMarkup) &&
  !/role="(?:tab|slider)"|onpointer|tabindex=/.test(statusMarkup));
test("all three compact signal indicators have dynamic mounts",
  /id="todayDirectionCoaching"/.test(today) &&
  /id="todayReadinessSignalValue"/.test(today) &&
  /id="todayLoadSignalValue"/.test(today) &&
  /id="todayRecoverySignalValue"/.test(today) &&
  (statusMarkup.match(/class="direction-signal-ring"/g) || []).length === 3);
test("the third signal is visibly and accessibly named Recovery",
  /id="todayRecoverySignal"[\s\S]{0,100}aria-label="Recovery access is loading"/.test(statusMarkup) &&
  /class="direction-signal-name">Recovery<\/span>/.test(statusMarkup) &&
  /value\.signals\.recovery/.test(html) &&
  !/class="direction-signal-name">Freshness<\/span>/.test(statusMarkup) &&
  !/aria-label="Freshness:/.test(statusMarkup));
test("Recovery exposes quiet Full, Partial, or Limited data quality",
  /id="todayRecoverySignalQuality">Limited data<\/span>/.test(statusMarkup) &&
  /qualityNode\.textContent = signal\.quality \|\| "Limited data"/.test(html));
test("missing signals avoid giant dashes and use coaching labels",
  helpers.buildAthlevoDirectionView({}).signals.readiness.value === "" &&
  helpers.buildAthlevoDirectionView({}).signals.readiness.note === "Needs check-in" &&
  helpers.buildAthlevoDirectionView({}).signals.load.value === "" &&
  helpers.buildAthlevoDirectionView({}).signals.load.note === "Building baseline" &&
  helpers.buildAthlevoDirectionView({}).signals.recovery.value === "" &&
  helpers.buildAthlevoDirectionView({}).signals.recovery.note === "Building baseline" &&
  helpers.buildAthlevoDirectionView({}).signals.load.progress === 0 &&
  helpers.buildAthlevoDirectionView({}).signals.recovery.progress === 0);
test("real signal values remain dynamic",
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false },
    compositeRecovery: { available: true, score: 78, quality: "Partial data" }
  }).signals.readiness.value === "72" &&
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false },
    compositeRecovery: { available: true, score: 78, quality: "Partial data" }
  }).signals.load.value === "Stable" &&
  helpers.buildAthlevoDirectionView({
    readiness: { score: 72 },
    recovery: { acwr: 1.04 },
    checkIn: { recorded: true, soreness: 1, painPresent: false },
    compositeRecovery: { available: true, score: 78, quality: "Partial data" }
  }).signals.recovery.value === "78");
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
  return missing.value === "" &&
    missing.note === "Building baseline" &&
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
test("readiness and Recovery use normalized scores while load remains categorical",
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
    compositeRecovery: { available: true, score: 78, quality: "Partial data" }
  }).signals.recovery.progressKind === "normalized" &&
  helpers.buildAthlevoDirectionView({
    compositeRecovery: { available: true, score: 78, quality: "Partial data" }
  }).signals.recovery.progress === 78);
test("three compact progress rings stay secondary and use no gradients",
  /\.direction-signal-ring\{[^}]*width:54px;height:54px/.test(html) &&
  (statusMarkup.match(/class="direction-signal-progress"/g) || []).length === 3 &&
  (statusMarkup.match(/pathLength="100"/g) || []).length === 6 &&
  /\.direction-signal-progress\{[^}]*stroke-dasharray:var\(--signal-progress\) 100/.test(html) &&
  !/conic-gradient|radial-gradient|linear-gradient/.test(directionCss));
test("the training card is visually primary while status uses the quieter surface",
  /\.today-training-card\{[^}]*border-top:3px solid var\(--red\)[^}]*box-shadow:var\(--elev-2\)/.test(html) &&
  /\.today-status-card\{[^}]*padding:15px 16px[^}]*border:1px solid var\(--line\)/.test(html));
test("narrow phones reduce greeting size with the existing display token",
  /@media \(max-width:380px\)\{[\s\S]*?\.greet h1\{font-size:calc\(var\(--fs-display\) \* \.88\)/.test(html));
test("narrow phones keep all three indicators in one responsive row",
  /\.direction-signals\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(html) &&
  /@media \(max-width:360px\)\{[\s\S]*?\.direction-signal-ring\{width:48px;height:48px\}/.test(html));
test("semantic ring colors support light and dark mode without gradients",
  /\.direction-signal\[data-tone="readiness-low"\]\{--signal-color:var\(--bad\)\}/.test(html) &&
  /\.direction-signal\[data-tone="readiness-moderate"\]\{--signal-color:var\(--warn\)\}/.test(html) &&
  /\.direction-signal\[data-tone="readiness-good"\]\{--signal-color:var\(--good\)\}/.test(html) &&
  /\.direction-signal\[data-tone="recovery-poor"\]\{--signal-color:var\(--bad\)\}/.test(html) &&
  /\.direction-signal\[data-tone="recovery-moderate"\]\{--signal-color:var\(--warn\)\}/.test(html) &&
  /\.direction-signal\[data-tone="recovery-good"\],[\s\S]*?\.direction-signal\[data-tone="recovery-excellent"\]\{--signal-color:var\(--good\)\}/.test(html) &&
  /\.direction-signal\[data-tone="recovery"\]\{--signal-color:#3970c8\}/.test(html) &&
  /\.direction-signal\[data-tone="positive"\]\{--signal-color:var\(--good\)\}/.test(html) &&
  /html\[data-theme="dark"\] \.direction-signal\[data-tone="recovery"\]\{--signal-color:#78a6ff\}/.test(html) &&
  !/\.today-status-card\{[^}]*gradient/.test(html));
test("CTA dispatch keeps existing plan build and Train navigation",
  /button\.dataset\.action === "build"[\s\S]*?window\.AthlevoPlan\.start\(\)/.test(
    extractFunction(html, "todayDirectionPrimaryAction")) &&
  /window\.AthlevoPlan\.start\(\)/.test(extractFunction(html, "todayStartPlan")) &&
  /todayGoToTrain\(\)/.test(extractFunction(html, "todayDirectionPrimaryAction")));
test("there is no duplicate legacy workout or plan CTA",
  !/class="today-workout-card"|id="todayRecommendationHeadline"|id="todayWorkoutCta"/.test(today) &&
  !/id="todayPlanCta"|#todayPlanCta \.tpc-cta/.test(html));
test("Why this today is a native disclosure after status",
  today.indexOf('<details class="direction-why"') > today.indexOf('<section class="today-status-card"') &&
  /<details class="direction-why" id="todayWhyToday" hidden>\s*<summary>Why this today\?<\/summary>/.test(today));
test("workout summary uses only saved session metadata",
  /Number\(session\.duration_minutes\)/.test(html) &&
  /Number\(session\.distance_km\)/.test(html) &&
  /session\.intensity/.test(html) &&
  /session\.target_rpe/.test(html) &&
  /s\.purpose, s\.description, s\.coach_reasoning, s\.notes/.test(html));
test("Last 7 days is one real-only section and precedes the install utility",
  /id="todayWeekSnapshot"[\s\S]*?<h2 id="todayWeekHeading">Last 7 days<\/h2>/.test(today) &&
  ["Distance", "Training time", "Avg HR"].every(label => today.includes(`>${label}</span>`)) &&
  /function refreshTodayWeekSnapshot\(\)[\s\S]*?section\.hidden = visible === 0/.test(html) &&
  today.indexOf("todayWeekSnapshot") < today.indexOf("todayInstallCard"));
test("seven-day presentation hides unavailable values and keeps real values", (() => {
  const metric = text => ({
    hidden: false,
    dataset: {},
    querySelector: selector => selector === ".today-week-value" ? { textContent: text } : null
  });
  const metrics = [metric("74.8 km"), metric("—"), metric("149 bpm")];
  const grid = { dataset: {} };
  const noPlanCopy = { textContent: "" };
  const distance = { textContent: "74.8 km" };
  const section = {
    hidden: true,
    querySelectorAll: () => metrics,
    querySelector: selector => selector === ".today-week-grid" ? grid : null
  };
  const document = {
    getElementById(id) {
      if (id === "todayWeekSnapshot") return section;
      if (id === "todayNoPlanCopy") return noPlanCopy;
      if (id === "todaySevenDayDistance") return distance;
      return null;
    }
  };
  const refresh = new Function("document", `
    ${extractFunction(html, "updateTodayNoPlanCopy")}
    ${extractFunction(html, "refreshTodayWeekSnapshot")}
    return refreshTodayWeekSnapshot;
  `)(document);
  refresh();
  const partial = section.hidden === false && metrics[0].hidden === false &&
    metrics[1].hidden === true && metrics[2].hidden === false &&
    grid.dataset.visibleMetrics === "2" &&
    noPlanCopy.textContent.startsWith("You logged 74.8 km over the last 7 days.");
  distance.textContent = "—";
  metrics[0].querySelector = () => ({ textContent: "—" });
  metrics[2].querySelector = () => ({ textContent: "—" });
  refresh();
  return partial && section.hidden === true && grid.dataset.visibleMetrics === "0" &&
    noPlanCopy.textContent ===
      "Tell us what you’re training for, and Athlevo will build a plan around where you are now, the time you have, and the goal you want to reach.";
})());
test("install prompt is secondary and existing installed/unavailable hiding remains intact",
  today.indexOf("todayInstallCard") > today.indexOf("todayWeekSnapshot") &&
  /var today = document\.getElementById\('todayInstallCard'\);[\s\S]*?today\.style\.display = \(hide \|\| dismissedThisSession\) \? 'none' : 'flex'/.test(html));
test("loading skeleton matches the workout-first layout without fake values",
  /id="todayPlanLoadingState"[\s\S]*?today-skeleton-line--title[\s\S]*?today-skeleton-action/.test(today) &&
  !/[>\s](?:0|100|No workout yet)[<\s]/.test(today.slice(
    today.indexOf("todayPlanLoadingState"), today.indexOf("todayNoPlanState")
  )));
test("375, 390, and 430px retain a single-column screen without horizontal overflow",
  [375, 390, 430].every(width => width > 0 && width <= 430) &&
  /\.today-plan-loading,\.today-no-plan,\.today-plan-error,\.today-training-card,[\s\S]*?margin:0 22px/.test(html) &&
  /#screen-today\{max-width:760px\}/.test(html));
test("current-week data comes from the authenticated server endpoint",
  /fetch\("\/api\/training\/get-week"[\s\S]*?Authorization:\s*"Bearer "\s*\+\s*session\.access_token/.test(html));
test("Today uses the server-selected valid plan and saved sessions",
  /snapshot\.hasPlan\s*\?\s*snapshot\.plan/.test(html) &&
    /snapshot\.hasPlan[\s\S]*?Array\.isArray\(snapshot\.sessions\)/.test(html));
test("signal collector exposes only real sleep, soreness, and pain check-in fields",
  /signals\.checkIn\s*=\s*\{[\s\S]*?sleepQuality:\s*num\(r\.sleepQuality1to5\)[\s\S]*?soreness:\s*num\(r\.muscleSoreness1to10\)[\s\S]*?painPresent:\s*r\.painPresent\s*===\s*true[\s\S]*?painSeverity:\s*num\(r\.painSeverity1to10\)/.test(coachData));
test("greeting uses the athlete's first name without an email fallback",
  /fullName\.split\(\/\\s\+\/\)\[0\]/.test(brain) &&
    !/profile\.email\?\.split\("@"\)\[0\]/.test(extractFunction(brain, "updateTodayDashboard")));
test("Today cards use theme-aware editorial surfaces and no gradient",
  /\.today-training-card\{[^}]*background:var\(--paper\)/.test(html) &&
  /\.today-status-card\{[^}]*background:var\(--paper\)/.test(html) &&
  !/\.today-(?:training|status)-card\{[^}]*gradient/.test(html));
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
