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

console.log("PASS — diagnostic extraction (consistency, multi-fact, finish time, refresh)");
