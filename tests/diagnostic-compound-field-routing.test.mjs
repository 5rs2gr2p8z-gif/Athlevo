/*
 * Regression test — compound-question field routing.
 *
 * Production bug: on the "Do you have a recent race result?" question
 * (js/diagnostic.js "recent_performance"), picking a race-distance chip
 * (e.g. "Half marathon") reveals a dependent free-text field ("Finish
 * time"). Typing a finish time like "1:43" was validated against the
 * WRONG field (the chips field the runner had already answered), because
 * diagnosticUI.js's composer handler always assumed the first field in a
 * sub-step group was the one on screen. The runner saw:
 *   "I didn't quite catch that. Could you pick one? None, 5K, 10K, ..."
 * even though they had already picked a valid distance and were now
 * correctly answering the follow-up prompt.
 *
 * Root cause: nothing tracked which field within a compound sub-step
 * group was ACTUALLY being displayed once a showWhen-dependent field
 * replaced the primary field on screen.
 *
 * Fix: js/diagnosticUI.js now tracks `activeSubField` (set by
 * presentDependentField, the only place a dependent field becomes "the
 * field on screen") and both the chip-select and composer-send paths
 * resolve the next dependent through one shared, pure helper —
 * nextActiveDependent(fieldGroup, answeredFieldId, data) — instead of
 * two copies of `fieldGroup.slice(1)` that disagreed once a dependent
 * field had already been answered.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadDiagnosticUI() {
  const src = readFileSync("./js/diagnosticUI.js", "utf8");
  const context = {
    console: { log() {}, warn() {}, error() {} },
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
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "diagnosticUI.js" });
  return context.AthlevoDiagnosticUI;
}

function loadDiagnosticQuestions() {
  const src = readFileSync("./js/diagnostic.js", "utf8");
  const context = {
    console: { log() {}, warn() {} },
    Date, Math,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(src, context, { filename: "diagnostic.js" });
  return context.AthlevoDiagnostic.getQuestions();
}

const UI = loadDiagnosticUI();
assert.ok(UI && UI._internal && typeof UI._internal.nextActiveDependent === "function",
  "diagnosticUI.js must export nextActiveDependent for regression coverage");

const questions = loadDiagnosticQuestions();
const recentPerformance = questions.find(q => q.key === "recent_performance");
assert.ok(recentPerformance, "recent_performance question must still exist in js/diagnostic.js");

const distField = recentPerformance.fields.find(f => f.id === "recent_race_dist");
const timeField = recentPerformance.fields.find(f => f.id === "recent_race_time");
assert.ok(distField && timeField, "recent_race_dist / recent_race_time fields must still exist");
const group = [distField, timeField];

// 1) TEST 8 from the sprint spec: picking "Half marathon" must surface the
//    finish-time field as the next thing on screen -- not silently stay on
//    the chips field.
const afterChip = UI._internal.nextActiveDependent(group, "recent_race_dist", {
  recent_race_dist: "Half marathon"
});
assert.equal(afterChip && afterChip.id, "recent_race_time",
  "picking a real race distance must surface the Finish time field next");

// 2) Typing the finish time ("1:43") must be recognised as completing the
//    group -- not loop back and re-present the finish-time field, and
//    definitely not fall back to re-validating against recent_race_dist's
//    chip options (which produced the "Could you pick one?" bug).
const afterTime = UI._internal.nextActiveDependent(group, "recent_race_time", {
  recent_race_dist: "Half marathon",
  recent_race_time: "1:43"
});
assert.equal(afterTime, null, "the compound question is complete once both fields are answered");

// 3) "None" never reveals the dependent finish-time field (showWhen excludes it).
const afterNone = UI._internal.nextActiveDependent(group, "recent_race_dist", {
  recent_race_dist: "none"
});
assert.equal(afterNone, null, "'None' must not ask for a finish time");

// 4) Generic case: this must not be special-cased to recent_performance --
//    any chips-field + dependent-text-field group behaves the same way.
const genericGroup = [
  { id: "has_injury", type: "chips" },
  { id: "injury_area", type: "text", showWhen: { has_injury: ["yes"] } }
];
const genericAfterChip = UI._internal.nextActiveDependent(genericGroup, "has_injury", { has_injury: "yes" });
assert.equal(genericAfterChip && genericAfterChip.id, "injury_area");
const genericAfterText = UI._internal.nextActiveDependent(genericGroup, "injury_area", {
  has_injury: "yes", injury_area: "left knee"
});
assert.equal(genericAfterText, null);

// 5) Source-level guard against regressing back to the unconditional
//    "always fieldGroup[0]" bug (belt-and-suspenders alongside the
//    behavioural assertions above).
const ui = readFileSync("./js/diagnosticUI.js", "utf8");
assert.match(ui, /var field = activeSubField \|\| fieldGroup\[0\];/,
  "handleComposerSend must resolve the on-screen field via activeSubField, not assume fieldGroup[0]");
assert.match(ui, /activeSubField = dep;/,
  "presentDependentField must record the dependent field as the one now on screen");
assert.match(ui, /function absorbGroupFacts/,
  "compound groups must absorb extracted dependent facts before asking the next field");
assert.match(ui, /function proceedRaceDetails/,
  "race-details Yes path must consume known name/date/time before asking");
assert.match(ui, /function takeKnownRaceDetail/,
  "each race-details sub-step must skip already-known facts");
assert.match(ui, /offerPaymentBridge/,
  "transactional intent must present the in-chat payment-method bridge");
assert.match(ui, /QRPh · Maya · GrabPay/);
assert.match(ui, /Debit \/ Credit Card/);
assert.match(ui, /if \(root\.athlevoSessionUserId\) \{[\s\S]{0,180}QRPh · Maya · GrabPay/,
  "local PayMongo chips are acquisition-visible only when a session exists");
assert.match(ui, /if \(method === "local" && !root\.athlevoSessionUserId\) return;/);
assert.doesNotMatch(ui, /GCash/);
assert.match(ui, /checkout_method: checkoutMethod/);
assert.match(ui, /if \(checkoutOpening\) return;/);
assert.doesNotMatch(ui, /var dependents = fieldGroup\.slice\(1\);/,
  "the two independent fieldGroup.slice(1) dependent-detection copies must be gone");

console.log("PASS — compound-question dependent-field routing (finish-time bug) stays fixed");
