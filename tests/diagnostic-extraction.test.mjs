/*
 * Free-text diagnostic extraction + finish-time routing cases.
 * Run: node tests/diagnostic-extraction.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load() {
  const storage = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Uint8Array,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    document: {
      readyState: "complete",
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        appendChild() {},
        setAttribute() {}
      })
    },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: true })
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnostic.js", "utf8"), context, { filename: "diagnostic.js" });
  vm.runInContext(readFileSync("./js/diagnosticSalesEngine.js", "utf8"), context, { filename: "diagnosticSalesEngine.js" });
  vm.runInContext(readFileSync("./js/diagnosticUI.js", "utf8"), context, { filename: "diagnosticUI.js" });
  return context;
}

const ctx = load();
const UI = ctx.AthlevoDiagnosticUI;
const Sales = ctx.AthlevoDiagnosticSales;
assert.ok(UI._internal.extractDiagnosticFacts);

const consistencyField = {
  id: "recent_consistency", type: "chips", required: true,
  options: [
    { label: "No consistent running", value: "none" },
    { label: "Occasional runs", value: "occasional" },
    { label: "Mostly consistent", value: "mostly_consistent" },
    { label: "Consistent every week", value: "consistent" }
  ]
};

{
  const facts = UI._internal.extractDiagnosticFacts(
    "Pretty consistent for the last 5 months except I missed a week.",
    consistencyField,
    { key: "current_capacity" }
  );
  assert.equal(facts.recent_consistency, "mostly_consistent");
}

{
  const facts = UI._internal.extractDiagnosticFacts(
    "I run 40–50km most weeks, around 5 hours, 5 days.",
    { id: "weekly_mileage", type: "number", min: 0, max: 500 },
    { key: "weekly_volume" }
  );
  assert.equal(facts.weekly_mileage, 45);
  assert.equal(facts.weekly_hours, 5);
  assert.equal(facts.training_days, 5);
}

{
  const facts = UI._internal.extractDiagnosticFacts(
    "I run 90km per week, around 9 hours.",
    { id: "weekly_mileage", type: "number", min: 0, max: 500 },
    { key: "weekly_volume" }
  );
  assert.equal(facts.weekly_mileage, 90);
  assert.equal(facts.weekly_hours, 9);
}

{
  const facts = UI._internal.extractDiagnosticFacts(
    "Pampanga Marathon on September 13, aiming for sub 4.",
    { id: "goal_race", type: "text", maxLength: 120 },
    { key: "race_details" }
  );
  assert.equal(facts.goal_race, "Pampanga Marathon");
  assert.match(facts.goal_race_date, /^20\d\d-09-1[23]$/);
  assert.equal(facts.goal_time, "sub-4:00");
  assert.equal(facts.goal_distance, "Marathon");
}

{
  const facts = UI._internal.extractDiagnosticFacts(
    "I've been running consistently for about 5 months, around 40–50km per week, but I don't know if my training is structured properly.",
    consistencyField,
    { key: "current_capacity" }
  );
  assert.equal(facts.recent_consistency, "mostly_consistent");
  assert.equal(facts.weekly_mileage, 45);
  const pains = Sales.detectPainPoints(
    "I've been running consistently for about 5 months, around 40–50km per week, but I don't know if my training is structured properly."
  );
  assert.ok(pains.indexOf("uncertainty") >= 0);
}

{
  const facts = UI._internal.extractDiagnosticFacts(
    "1:43",
    { id: "recent_race_time", type: "text", maxLength: 40 },
    { key: "recent_performance" }
  );
  assert.equal(facts.recent_race_time, "1:43");
}

{
  const distField = {
    id: "recent_race_dist", type: "chips", required: true,
    options: [
      { label: "None", value: "none" },
      { label: "5K", value: "5K" },
      { label: "10K", value: "10K" },
      { label: "Half marathon", value: "Half marathon" },
      { label: "Marathon", value: "Marathon" }
    ]
  };
  const recentQ = { key: "recent_performance" };
  const variants = [
    "half marathon, 1:43, few months ago",
    "half marathon 1:43",
    "HM in 1:43",
    "I ran a half in 1:43",
    "21k, 1 hour 43",
    "my last half was around 1:43"
  ];
  for (const phrase of variants) {
    const facts = UI._internal.extractDiagnosticFacts(phrase, distField, recentQ);
    assert.equal(facts.recent_race_dist, "Half marathon", phrase);
    assert.equal(facts.recent_race_time, "1:43", phrase);
    assert.equal(facts.goal_distance, undefined, phrase);
  }

  const mapped = UI._internal.tryMapTextToValue(
    recentQ,
    distField,
    "half marathon, 1:43, few months ago"
  );
  assert.equal(mapped.value, "Half marathon");
}

{
  const mapped = UI._internal.tryMapTextToValue(
    { key: "goal" },
    {
      id: "goal_distance", type: "chips", required: true,
      options: [{ label: "Marathon", value: "Marathon" }]
    },
    "Marathon"
  );
  assert.equal(mapped.value, "Marathon");
}

{
  const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
  const chipFn = uiSrc.slice(uiSrc.indexOf("function handleChipSelect"), uiSrc.indexOf("function showMultiChipsWithState"));
  assert.doesNotMatch(chipFn, /callRouter/);
  assert.doesNotMatch(chipFn, /routeViaAi/);
}

{
  const Engine = ctx.AthlevoDiagnostic;
  const e = Engine.create();
  e.begin();
  e.recordAnswer("goal", { goal_distance: "Marathon" });
  const restored = Engine.load();
  assert.equal(restored.history[0], "goal");
  assert.equal(restored.answers.goal_distance, "Marathon");
  const raw = JSON.parse(ctx.localStorage.getItem("athlevo_pending_diagnostic_v1"));
  assert.equal(raw.salesState, undefined);
  assert.equal(raw.recentTurns, undefined);
}

{
  const mileage = { id: "weekly_mileage", type: "number", min: 0, max: 500 };
  const facts = UI._internal.extractDiagnosticFacts(
    "around 80, how much is this?",
    mileage,
    { key: "weekly_volume" }
  );
  assert.equal(facts.weekly_mileage, 80);
  assert.equal(UI._internal.factPortionOfMixedMessage("around 80, how much is this?").trim(), "around 80");
}

{
  const days = {
    id: "training_days", type: "chips", required: true,
    options: [
      { label: "2", value: 2 }, { label: "3", value: 3 }, { label: "4", value: 4 },
      { label: "5", value: 5 }, { label: "6", value: 6 }, { label: "7", value: 7 }
    ]
  };
  const facts = UI._internal.extractDiagnosticFacts(
    "usually 5, but how does Athlevo actually help?",
    days,
    { key: "training_days" }
  );
  assert.equal(facts.training_days, 5);
}

{
  const hours = { id: "weekly_hours", type: "number", min: 0, max: 40 };
  const facts = UI._internal.extractDiagnosticFacts(
    "about 6 hours. Can I cancel anytime?",
    hours,
    { key: "weekly_volume" }
  );
  assert.equal(facts.weekly_hours, 6);
}

{
  const longest = { id: "recent_longest_run_km", type: "number", min: 0, max: 200 };
  const facts = UI._internal.extractDiagnosticFacts(
    "26km. How much is the subscription?",
    longest,
    { key: "current_capacity" }
  );
  assert.equal(facts.recent_longest_run_km, 26);
  assert.equal(facts.weekly_mileage, undefined);
}

{
  const mileage = { id: "weekly_mileage", type: "number", min: 0, max: 500 };
  const facts = UI._internal.extractDiagnosticFacts(
    "what are the inclusions?",
    mileage,
    { key: "weekly_volume" }
  );
  assert.equal(facts.weekly_mileage, undefined);
}

{
  assert.equal(UI._internal.isDiagnosticDeferral("Not yet."), true);
  assert.equal(UI._internal.isDiagnosticDeferral("around 80"), false);
}

function bindFreshEngine() {
  const Engine = ctx.AthlevoDiagnostic;
  const engine = Engine.create();
  engine.begin();
  UI._internal.bindEngine(engine);
  UI._internal.resetFactStore();
  return { Engine, engine };
}

{
  for (const [phrase, expected] of [
    ["sub 4", "sub-4:00"],
    ["sub-2", "sub-2:00"],
    ["under 4 hours", "sub-4:00"],
    ["under four hours", "sub-4:00"],
    ["below 4 hours", "sub-4:00"],
    ["aiming for under 4", "sub-4:00"],
    ["hoping to go under 4", "sub-4:00"],
    ["target is 4 hours", "sub-4:00"],
    ["aiming for 3:59", "3:59"],
    ["under 2 hours", "sub-2:00"]
  ]) {
    assert.equal(UI._internal.extractGoalTime(phrase), expected, phrase);
  }
  assert.equal(UI._internal.extractGoalTime("I start training at 5:30"), null);
  assert.equal(UI._internal.extractGoalTime("see you at 4:00"), null);
  const clockGoal = UI._internal.extractDiagnosticFacts(
    "My marathon, aiming for 3:59",
    { id: "goal_distance", type: "chips" },
    { key: "goal" }
  );
  assert.equal(clockGoal.goal_time, "3:59");
  assert.equal(clockGoal.recent_race_time, undefined);
}

{
  const msg = "I run around 30km a week, my longest run is 15km, and I want to run a sub-2 half marathon.";
  const facts = UI._internal.extractDiagnosticFacts(msg, { id: "goal_distance", type: "chips" }, { key: "goal" });
  assert.equal(facts.weekly_mileage, 30);
  assert.equal(facts.recent_longest_run_km, 15);
  assert.equal(facts.goal_distance, "Half marathon");
  assert.equal(facts.goal_time, "sub-2:00");

  const { Engine, engine } = bindFreshEngine();
  UI._internal.applyExtractedFacts(facts, "goal_distance");
  const store = UI._internal.getFactStore();
  assert.equal(store.weekly_mileage, 30);
  assert.equal(store.recent_longest_run_km, 15);
  assert.equal(store.goal_time, "sub-2:00");
  assert.ok(UI._internal.questionFullyKnownFromFacts(Engine.getQuestion("weekly_volume")),
    "weekly mileage already known must complete weekly_volume");
  assert.equal(UI._internal.nextMissingRaceDetailField({}, store), "goal_race",
    "goal time is known; race name/date may still be missing");
  assert.equal(UI._internal.consumeFactForField({
    id: "recent_longest_run_km", type: "number", min: 0, max: 200
  }), 15);
  assert.equal(engine.safetyFlags.injuryReported, false);
}

{
  const msg = "My first marathon is in December. I got sick last month so I only recently got back to running. I’m around 35km per week now and hoping to go under 4 hours.";
  const facts = UI._internal.extractDiagnosticFacts(msg, { id: "goal_distance", type: "chips" }, { key: "goal" });
  assert.equal(facts.goal_distance, "Marathon");
  assert.equal(facts.training_status, "returning");
  assert.equal(facts.weekly_mileage, 35);
  assert.equal(facts.goal_time, "sub-4:00");
  assert.equal(facts.goal_race_date, undefined, "month-only dates must not become a fake day");
  assert.equal(facts.injury_has, undefined);
  assert.equal(facts.injury_area, undefined);
  assert.equal(facts.weekly_hours, undefined, "under 4 hours is a goal, not weekly hours");

  const { engine } = bindFreshEngine();
  UI._internal.applyExtractedFacts(facts, "goal_distance");
  assert.equal(UI._internal.getFactStore().goal_time, "sub-4:00");
  assert.equal(UI._internal.getFactStore().training_status, "returning");
  assert.doesNotMatch(JSON.stringify(engine.getPendingFacts()), /12-01|December 1/i);
  assert.equal(engine.safetyFlags.injuryReported, false);
  assert.equal(engine.safetyFlags.requiresMedicalClearance, false);
}

{
  const msg = "Pampanga Marathon on September 13, aiming for sub 4.";
  const facts = UI._internal.extractDiagnosticFacts(
    msg,
    { id: "goal_race", type: "text", maxLength: 120 },
    { key: "race_details" }
  );
  assert.equal(facts.goal_race, "Pampanga Marathon");
  assert.match(facts.goal_race_date, /^20\d\d-09-1[23]$/);
  assert.equal(facts.goal_time, "sub-4:00");
  assert.equal(
    UI._internal.nextMissingRaceDetailField({}, facts),
    null,
    "all race-detail fields already known must not be asked again"
  );
  assert.match(readFileSync("./js/diagnosticUI.js", "utf8"), /function proceedRaceDetails/);
  assert.match(readFileSync("./js/diagnosticUI.js", "utf8"), /setDiagnosticBusy\(false\);\s*proceedRaceDetails\(\);/);
}

{
  const facts = UI._internal.extractDiagnosticFacts(
    "I run 50km a week. Longest is 26km.",
    { id: "weekly_mileage", type: "number", min: 0, max: 500 },
    { key: "weekly_volume" }
  );
  assert.equal(facts.weekly_mileage, 50);
  assert.equal(facts.recent_longest_run_km, 26);
}

{
  const { Engine } = bindFreshEngine();
  UI._internal.applyExtractedFacts({ weekly_mileage: 40, recent_longest_run_km: 12 }, null);
  assert.equal(Engine.load().getPendingFacts().weekly_mileage, 40);
  assert.equal(Engine.load().getPendingFacts().recent_longest_run_km, 12);

  const restored = Engine.load();
  UI._internal.bindEngine(restored);
  UI._internal.restoreFactStoreFromEngine();
  assert.equal(UI._internal.getFactStore().weekly_mileage, 40);
  assert.equal(UI._internal.consumeFactForField({
    id: "recent_longest_run_km", type: "number", min: 0, max: 200
  }), 12);
  assert.ok(UI._internal.questionFullyKnownFromFacts(Engine.getQuestion("weekly_volume")));
}

{
  const msg = "I got sick two weeks ago but I’m okay now and running again.";
  const facts = UI._internal.extractDiagnosticFacts(msg, { id: "goal_distance", type: "chips" }, { key: "goal" });
  assert.equal(facts.training_status, "returning");
  assert.equal(facts.injury_has, undefined);
  const { engine } = bindFreshEngine();
  UI._internal.applyExtractedFacts(facts, "goal_distance");
  assert.equal(engine.safetyFlags.injuryReported, false);
  assert.equal(engine.safetyFlags.requiresMedicalClearance, false);
  assert.equal(engine.safetyFlags.injurySeverity, null);
}

{
  const { engine } = bindFreshEngine();
  engine.recordAnswer("experience", { experience: "1_2_years" });
  engine.recordAnswer("training_status", { training_status: "building_base" });
  UI._internal.bindEngine(engine);
  const facts = UI._internal.extractDiagnosticFacts(
    "I got sick last month so I only recently got back to running.",
    { id: "weekly_mileage", type: "number", min: 0, max: 500 },
    { key: "weekly_volume" }
  );
  assert.equal(facts.training_status, undefined, "must not overwrite a known training_status");
  assert.equal(engine.answers.training_status, "building_base");
}

console.log("PASS — diagnostic extraction (consistency, multi-fact, finish time, refresh)");
