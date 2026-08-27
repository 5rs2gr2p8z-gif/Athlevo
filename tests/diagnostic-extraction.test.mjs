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

console.log("PASS — diagnostic extraction (consistency, multi-fact, finish time, refresh)");
