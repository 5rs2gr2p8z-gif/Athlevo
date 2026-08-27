/*
 * Mixed fact + sales-intent turns in the conversational diagnostic.
 * Run: node tests/diagnostic-mixed-intent.test.mjs
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
const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");

const mileage = { id: "weekly_mileage", type: "number", min: 0, max: 500 };
const hours = { id: "weekly_hours", type: "number", min: 0, max: 40 };
const days = {
  id: "training_days", type: "chips", required: true,
  options: [2, 3, 4, 5, 6, 7].map(n => ({ label: String(n), value: n }))
};
const longest = { id: "recent_longest_run_km", type: "number", min: 0, max: 200 };

{
  const msg = "around 80, how much is this?";
  const facts = UI._internal.extractDiagnosticFacts(msg, mileage, { key: "weekly_volume" });
  const intent = Sales.classify(msg);
  const reply = Sales.composeSalesReply(intent, { answers: {} }, Sales.emptySalesState(), []);
  assert.equal(facts.weekly_mileage, 80);
  assert.equal(intent.intent, "pricing_question");
  assert.match(reply.reply, /₱597\/month/);
  assert.doesNotMatch(reply.reply, /could you give me weekly distance/i);
}

{
  const msg = "usually 5, but how does Athlevo actually help?";
  const facts = UI._internal.extractDiagnosticFacts(msg, days, { key: "training_days" });
  const intent = Sales.classify(msg);
  const reply = Sales.composeSalesReply(intent, { answers: { training_days: 5 } }, Sales.emptySalesState(), []);
  assert.equal(facts.training_days, 5);
  assert.equal(intent.intent, "how_it_works");
  assert.notEqual(intent.topic, "inclusions");
  assert.doesNotMatch(reply.reply, /could you give me/i);
  assert.doesNotMatch(reply.reply, /personalized training plan, daily workout guidance/);
}

{
  const msg = "about 6 hours. Can I cancel anytime?";
  const facts = UI._internal.extractDiagnosticFacts(msg, hours, { key: "weekly_volume" });
  const intent = Sales.classify(msg);
  const reply = Sales.composeSalesReply(intent, { answers: {} }, Sales.emptySalesState(), []);
  assert.equal(facts.weekly_hours, 6);
  assert.equal(intent.objection, "cancellation");
  assert.match(reply.reply, /cancel anytime/i);
}

{
  const msg = "26km. How much is the subscription?";
  const facts = UI._internal.extractDiagnosticFacts(msg, longest, { key: "current_capacity" });
  const intent = Sales.classify(msg);
  assert.equal(facts.recent_longest_run_km, 26);
  assert.equal(intent.intent, "pricing_question");
}

{
  const intent = Sales.classify("what are the inclusions?");
  const reply = Sales.composeSalesReply(intent, { answers: { weekly_mileage: 80, goal_distance: "Marathon" } }, Sales.emptySalesState(), []);
  assert.equal(intent.topic, "inclusions");
  assert.match(reply.reply, /personalized training plan/i);
  assert.match(reply.reply, /daily workout guidance/i);
  assert.match(reply.reply, /adaptive adjustments/i);
  assert.match(reply.reply, /AI endurance coach/i);
  assert.match(reply.reply_2, /Strava/);
  assert.match(reply.reply_2, /Intervals\.icu/);
  assert.doesNotMatch(reply.reply_2, /Garmin|COROS|Polar|Apple Health|Suunto/);
  assert.doesNotMatch(reply.reply, /clearer balance between controlled aerobic/i);
  assert.doesNotMatch(reply.reply_2, /could you give me/i);
}

assert.match(uiSrc, /applyExtractedFacts\(extractDiagnosticFacts\(val, fieldEarly, q\), fieldEarly\.id\)/);
assert.match(uiSrc, /awaitingSalesFollowup = true/);
assert.match(uiSrc, /if \(awaitingSalesFollowup\) \{\s*awaitingSalesFollowup = false;\s*busy = false;\s*restoreCurrentFieldInput\(\);/);
assert.doesNotMatch(uiSrc, /handleSalesDetour\([\s\S]{0,200}showValidationMsg/);
assert.match(uiSrc, /function resumeDiagnosticAfterSales/);
assert.match(uiSrc, /You mentioned you're around /);

console.log("PASS — mixed-intent diagnostic turns extract facts and answer sales without stale validation");
