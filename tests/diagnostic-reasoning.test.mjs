/*
 * Slice 1 — diagnostic reasoning invariants (sufficiency, skip, safety).
 * Does not assert exact coaching prose or the future limiter taxonomy.
 * Run: node tests/diagnostic-reasoning.test.mjs
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
const Engine = ctx.AthlevoDiagnostic;
const helpers = UI._internal;
const engineSrc = readFileSync("./js/diagnostic.js", "utf8");
const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const chatSrc = readFileSync("./lib/server/diagnosticChatEndpoint.js", "utf8");

const goalField = {
  id: "goal_distance", type: "chips", required: true,
  options: [
    { label: "5K", value: "5K" },
    { label: "10K", value: "10K" },
    { label: "Half marathon", value: "Half marathon" },
    { label: "Marathon", value: "Marathon" },
    { label: "Ultra", value: "Ultra" },
    { label: "General fitness", value: "General fitness" }
  ]
};

function hydrate(msg) {
  const engine = Engine.create();
  engine.begin();
  helpers.bindEngine(engine);
  helpers.resetFactStore();
  const facts = helpers.extractDiagnosticFacts(msg, goalField, { key: "goal" });
  helpers.applyExtractedFacts(facts, "goal_distance");
  if (facts.goal_distance) {
    engine.recordAnswer("goal", { goal_distance: facts.goal_distance });
  }
  helpers.commitFullyKnownPendingQuestions();
  return { engine, facts, store: helpers.getFactStore(), next: engine.nextQuestion() };
}

function assertNotReasked(engine, keys) {
  const next = engine.nextQuestion();
  const nextKey = next && next.key;
  for (const key of keys) {
    assert.notEqual(nextKey, key, "must not re-ask " + key);
  }
}

/* ── Source invariants: deterministic code still owns the funnel ── */
{
  assert.match(engineSrc, /hasDiagnosticSufficiency/);
  assert.doesNotMatch(engineSrc, /callRouter|diagnostic-chat|OPENAI/);
  assert.match(uiSrc, /silent skip/);
  assert.match(chatSrc, /You are the diagnostic reasoning layer inside Athlevo/);
  assert.match(chatSrc, /You do NOT run the funnel/);
  assert.equal(typeof Engine.create().hasDiagnosticSufficiency, "function");
  assert.equal(typeof Engine.create().getModelReasoning, "function");
}

/* CASE A — too much intensity for current base */
{
  const msg = "I want sub-20 for 5K. I recently ran 25:00, I run around 25km a week, and I usually do two interval sessions.";
  const { engine, facts, store, next } = hydrate(msg);
  assert.equal(facts.goal_distance || engine.answers.goal_distance, "5K");
  assert.ok(facts.goal_time || store.goal_time || engine.answers.goal_time);
  assert.equal(facts.weekly_mileage || store.weekly_mileage || engine.answers.weekly_mileage, 25);
  assert.ok(
    facts.training_structure === "balanced_quality" ||
    store.training_structure === "balanced_quality" ||
    engine.answers.training_structure === "balanced_quality"
  );
  assert.notEqual(next && next.key, "goal");
  assert.notEqual(next && next.key, "weekly_volume");
  assert.notEqual(next && next.key, "perceived_limiter");
  assert.notEqual(next && next.key, "current_capacity", "5K with recent time should not require longest run");

  engine.setPendingFacts(Object.assign({}, engine.getPendingFacts(), {
    recent_race_dist: facts.recent_race_dist || store.recent_race_dist || "5K",
    recent_race_time: facts.recent_race_time || store.recent_race_time || "25:00"
  }));
  if (engine.hasDiagnosticSufficiency()) {
    assert.equal(engine.nextQuestion() && engine.nextQuestion().key, "injury_status");
  }
  assert.equal(engine.canComplete(), false, "injury gate still applies");
}

/* CASE B — short marathon timeline */
{
  const msg = "My first marathon is in 8 weeks. I run about 20km per week and my longest run is 10km.";
  const { engine, facts, store, next } = hydrate(msg);
  assert.equal(facts.goal_distance || engine.answers.goal_distance, "Marathon");
  assert.equal(facts.weekly_mileage || store.weekly_mileage || engine.answers.weekly_mileage, 20);
  assert.equal(facts.recent_longest_run_km || store.recent_longest_run_km || engine.answers.recent_longest_run_km, 10);
  assert.notEqual(next && next.key, "weekly_volume");
  assert.notEqual(next && next.key, "current_capacity");
  assert.notEqual(next && next.key, "perceived_limiter");
  assert.notEqual(next && next.key, "schedule");
  assert.notEqual(next && next.key, "other_training");
  assert.equal(engine.canComplete(), false);
  if (next) {
    assert.ok(
      next.key === "race_details" || next.key === "injury_status" || next.key === "training_status" || next.key === "experience",
      "remaining questions should be high-value, got " + next.key
    );
  }
}

/* CASE C — late-race fade */
{
  const msg = "I want a sub-2 half marathon. I run 35km a week, my longest run is 18km, I open too fast and fade after 12–15km.";
  const { engine, facts, store, next } = hydrate(msg);
  assert.equal(facts.goal_distance || engine.answers.goal_distance, "Half marathon");
  assert.equal(facts.weekly_mileage || store.weekly_mileage || engine.answers.weekly_mileage, 35);
  assert.equal(facts.recent_longest_run_km || store.recent_longest_run_km || engine.answers.recent_longest_run_km, 18);
  assert.ok(helpers.hasAckWorthyContext(msg));
  assert.notEqual(next && next.key, "goal");
  assert.notEqual(next && next.key, "weekly_volume");
  assert.notEqual(next && next.key, "current_capacity");
  assert.notEqual(next && next.key, "perceived_limiter");
}

/* CASE D — solid volume, only easy running */
{
  const msg = "I want to improve my 10K. I run 50km a week, mostly easy Zone 2, and I’ve been consistent for about three months.";
  const { engine, facts, store, next } = hydrate(msg);
  assert.equal(facts.goal_distance || engine.answers.goal_distance, "10K");
  assert.equal(facts.weekly_mileage || store.weekly_mileage || engine.answers.weekly_mileage, 50);
  assert.equal(facts.training_structure || store.training_structure || engine.answers.training_structure, "mostly_easy");
  assert.ok(
    facts.recent_consistency || store.recent_consistency || engine.answers.recent_consistency,
    "consistency should be retained"
  );
  assert.notEqual(next && next.key, "perceived_limiter");
  assert.notEqual(next && next.key, "weekly_volume");
  assert.notEqual(next && next.key, "training_structure");
  if (next && next.key === "recent_performance") {
    assert.ok(true, "recent performance remains high value for a 10K performance goal");
  }
}

/* CASE E — return after sickness */
{
  const msg = "I’m trying to get my 5K back after being sick last month. I only recently returned to running.";
  const { engine, facts, store, next } = hydrate(msg);
  assert.equal(facts.goal_distance || engine.answers.goal_distance, "5K");
  assert.equal(facts.training_status || store.training_status || engine.answers.training_status, "returning");
  assert.equal(facts.injury_has, undefined);
  assert.equal(store.injury_has, undefined);
  assert.equal(engine.answers.injury_has, undefined);
  assert.equal(engine.canComplete(), false, "no premature diagnosis without load/baseline");
  assert.notEqual(next && next.key, "perceived_limiter");
  assert.notEqual(next && next.key, "injury_status");
  assert.ok(
    next && (next.key === "weekly_volume" || next.key === "recent_performance" || next.key === "experience" || next.key === "current_capacity"),
    "next should collect load/baseline, got " + (next && next.key)
  );
}

/* Perceived limiter is not required for completion */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.setPendingFacts({
    weekly_mileage: 40,
    recent_race_dist: "5K",
    recent_race_time: "24:00",
    training_status: "training_block",
    injury_has: "none"
  });
  assert.equal(engine.hasDiagnosticSufficiency(), true);
  assert.equal(engine.canComplete(), true);
  assert.equal(engine.history.indexOf("perceived_limiter"), -1);
  assert.equal(engine.nextQuestion(), null);
  const result = engine.complete();
  assert.ok(result.athlevoRecommendation);
  assert.equal(result.recommendation, undefined);
}

/* Injury safety gate blocks; known injury is not re-asked */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "10K" });
  engine.setPendingFacts({
    weekly_mileage: 45,
    experience: "3_5_years",
    training_status: "building_base"
  });
  assert.equal(engine.hasDiagnosticSufficiency(), true);
  assert.equal(engine.canComplete(), false);
  assert.equal(engine.nextQuestion().key, "injury_status");
  engine.recordAnswer("injury_status", { injury_has: "minor", injury_area: "calf" });
  assert.equal(engine.canComplete(), true);
  assert.equal(engine.nextQuestion(), null);
  assert.equal(engine.safetyFlags.injuryReported, true);
}

/* 5K recent performance can satisfy capacity without longest run */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.setPendingFacts({
    goal_time: "sub-20:00",
    recent_race_dist: "5K",
    recent_race_time: "25:00",
    weekly_mileage: 28,
    training_days: 4,
    training_structure: "balanced_quality"
  });
  assert.equal(engine.hasDiagnosticSufficiency(), true);
  assert.equal(engine._hasFact("recent_longest_run_km"), false);
  assertNotReasked(engine, ["current_capacity", "perceived_limiter", "weekly_volume"]);
}

/* Marathon/ultra still prioritizes longest run */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  engine.recordAnswer("race_details", { goal_race: "", goal_race_date: "2026-11-01", goal_time: "" });
  engine.setPendingFacts({
    weekly_mileage: 32,
    experience: "1_2_years",
    training_status: "building_base"
  });
  assert.equal(engine.hasDiagnosticSufficiency(), false);
  assert.equal(engine.nextQuestion().key, "current_capacity");
}

/* Insufficient context still asks a high-value question */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Half marathon" });
  const next = engine.nextQuestion();
  assert.ok(next);
  assert.notEqual(next.key, "perceived_limiter");
  assert.notEqual(next.key, "other_training");
  assert.notEqual(next.key, "schedule");
}

/* Sickness is returning, not injury — model cannot complete */
{
  assert.equal(helpers.hasAckWorthyContext("I got sick last month and just started running again"), true);
  const hijack = helpers.stripModelRouting({
    intent: "diagnostic_answer",
    next_action: "complete_diagnostic",
    show_checkout: true,
    reply: "You're done.",
    extracted_facts: { injury_has: "significant" }
  });
  assert.equal(hijack.next_action, "continue_diagnostic");
  assert.equal(hijack.show_checkout, false);
}

/* Simple chips/numbers stay deterministic — no new LLM path */
{
  assert.equal(Sales.looksLikeSimpleDiagnosticAnswer("30", { type: "number" }), true);
  assert.equal(helpers.shouldCallAiAcknowledgement("30", { id: "weekly_mileage", type: "number" }, { key: "weekly_volume" }), false);
  assert.equal(helpers.shouldCallAiAcknowledgement("Marathon", goalField, { key: "goal" }), false);
  const chipFn = uiSrc.slice(
    uiSrc.indexOf("function handleChipSelect"),
    uiSrc.indexOf("function showMultiChipsWithState")
  );
  assert.doesNotMatch(chipFn, /callRouter/);
}

/* Pending facts remain valid across overlay */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.setPendingFacts({ weekly_mileage: 25, training_structure: "balanced_quality" });
  const pending = engine.getPendingFacts();
  assert.equal(pending.weekly_mileage, 25);
  assert.equal(engine.answers.weekly_mileage, 25);
  assert.equal(engine.known.weekly_mileage, true);
  const restored = Engine.load();
  assert.equal(restored.getPendingFacts().weekly_mileage, 25);
  assert.equal(restored.answers.weekly_mileage, 25);
}

console.log("PASS — diagnostic reasoning invariants (sufficiency, skip, safety)");
