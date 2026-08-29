/*
 * Slice 3 — structured diagnostic reasoning contract.
 * The model may diagnose; deterministic code still owns completion, sequencing,
 * checkout, signup, and entitlement. Result card is unchanged.
 * Run: node tests/diagnostic-structured-reasoning.test.mjs
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
  return { ctx: context, storage };
}

const { ctx } = load();
const UI = ctx.AthlevoDiagnosticUI;
const Sales = ctx.AthlevoDiagnosticSales;
const Engine = ctx.AthlevoDiagnostic;
const helpers = UI._internal;
const chatSrc = readFileSync("./lib/server/diagnosticChatEndpoint.js", "utf8");
const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const engineSrc = readFileSync("./js/diagnostic.js", "utf8");

const CASE_A_AEROBIC = ["excessive_intensity", "aerobic_base", "threshold_capacity"];
const CASE_B_LIMITERS = ["timeline_mismatch", "aerobic_durability"];
const CASE_C_LIMITERS = ["pacing", "aerobic_durability"];

function validateCase(raw) {
  return Sales.validateRouterResponse(Object.assign({
    intent: "diagnostic_answer",
    next_action: "continue_diagnostic",
    reply: "",
    extracted_facts: {},
    pain_points: [],
    buyer_intent: "none"
  }, raw));
}

/* ── Prompt invariants ── */
{
  assert.match(chatSrc, /You are the diagnostic reasoning layer inside Athlevo/);
  assert.match(chatSrc, /You do NOT run the funnel/);
  assert.match(chatSrc, /You do NOT decide completion/);
  assert.match(chatSrc, /primary limiting factor/i);
  assert.match(chatSrc, /one primary limiter/i);
  assert.match(chatSrc, /athlete-specific evidence/i);
  assert.match(chatSrc, /generic laundry list/i);
  assert.match(chatSrc, /does not diagnose injuries/i);
  assert.match(chatSrc, /does not guarantee race results/i);
  assert.match(chatSrc, /DIRECTION, NOT A FULL PLAN/);
  assert.match(chatSrc, /Do not ask the next diagnostic question/);
  assert.match(chatSrc, /You do NOT control checkout, signup, or payment/);
  assert.match(chatSrc, /perceived limiter as supporting evidence only/i);
  assert.match(chatSrc, /Do not recommend more intervals just because the goal is faster/);
  assert.match(chatSrc, /Do not treat a late fade automatically as lack of speed/);
  assert.match(chatSrc, /sickness is not an injury diagnosis/i);
}

/* ── Schema is present; limiter enum is not a chip ── */
{
  assert.match(chatSrc, /primary_limiter: LIMITER_SCHEMA/);
  assert.match(chatSrc, /type: \["object", "null"\]/);
  assert.match(engineSrc, /modelReasoning/);
  const renderStart = uiSrc.indexOf("function renderResult");
  assert.ok(renderStart >= 0);
  const renderSrc = uiSrc.slice(renderStart, renderStart + 5000);
  assert.doesNotMatch(renderSrc, /modelReasoning/);
  assert.doesNotMatch(uiSrc, /options:[\s\S]{0,200}excessive_intensity/);
  assert.doesNotMatch(uiSrc, /Choose your limiter/);
}

/* CASE A — sub-20 / 25:00 / 25 km / two intervals */
{
  const out = validateCase({
    reply: "With a 25:00 5K and two interval sessions on only ~25 km/week, more hard running is not the first move.",
    primary_limiter: {
      key: "excessive_intensity",
      label: "Intensity density",
      why: "With a 25:00 5K, ~25 km/week, and two interval sessions already in the week, the bigger issue probably isn't lack of hard running."
    },
    secondary_limiter: {
      key: "aerobic_base",
      label: "Aerobic base",
      why: "Weekly volume is modest for a jump from 25:00 to sub-20."
    },
    diagnostic_confidence: 0.74,
    diagnostic_summary: "With a 25:00 5K at ~25 km/week and two interval sessions, intensity density is ahead of aerobic support.",
    recommended_direction: "Strengthen aerobic and threshold support before adding more 5K-specific intensity.",
    expectation: {
      rating: "realistic_aggressive",
      text: "The goal is realistic, but aggressive relative to the current baseline. I'd think in months rather than weeks."
    },
    coach_concerns: ["high_intensity_density"],
    context_flags: ["high_intensity_density"]
  });
  assert.ok(CASE_A_AEROBIC.includes(out.primary_limiter.key));
  assert.doesNotMatch(out.recommended_direction, /more (intervals|intensity)|add another interval/i);
  assert.match(out.diagnostic_summary, /25:00|25 km/i);
  assert.match(out.primary_limiter.why, /25:00|25 km|interval/i);
}

/* CASE B — first marathon, 20 km, longest 10 km, 8 weeks */
{
  const out = validateCase({
    primary_limiter: {
      key: "timeline_mismatch",
      label: "Timeline",
      why: "A first marathon in 8 weeks with ~20 km/week and a 10 km long run is a durability/timeline problem, not a missing workout."
    },
    diagnostic_confidence: 0.8,
    diagnostic_summary: "Eight weeks is too short to safely build marathon durability from 20 km weeks and a 10 km long run.",
    recommended_direction: "Build long-run durability gradually and treat the timeline as the constraint.",
    expectation: {
      rating: "timeline_too_short",
      text: "The timeline is the biggest problem here. Safely building durability for this distance matters more than forcing a target pace."
    },
    coach_concerns: ["goal_timeline_mismatch", "durability_gap", "long_run_load_mismatch"],
    context_flags: ["short_timeline", "low_volume_for_goal"]
  });
  assert.ok(CASE_B_LIMITERS.includes(out.primary_limiter.key));
  assert.ok(out.expectation.rating === "timeline_too_short" || out.expectation.rating === "ambitious");
  assert.doesNotMatch(out.recommended_direction, /30\s*km long run immediately|run 60 km next week/i);
}

/* CASE C — sub-2 half, opens fast, fades 12–15 km */
{
  const out = validateCase({
    primary_limiter: {
      key: "pacing",
      label: "Pacing",
      why: "Opening too fast and fading after 12–15 km on 35 km/week with an 18 km long run points to pacing and durability, not a lack of speed."
    },
    secondary_limiter: {
      key: "aerobic_durability",
      label: "Aerobic durability",
      why: "The late fade after 12–15 km suggests the current long-run durability may not support a sub-2 half yet."
    },
    diagnostic_confidence: 0.7,
    diagnostic_summary: "The late fade after an aggressive start is more pacing and durability than pure speed.",
    recommended_direction: "Improve pacing discipline and build late-race durability.",
    expectation: {
      rating: "realistic_aggressive",
      text: "Sub-2 is a meaningful target from here. The first phase should stabilize pacing and durability."
    },
    coach_concerns: ["aggressive_race_start", "late_race_fade"],
    context_flags: ["aggressive_start", "late_fade"]
  });
  assert.ok(CASE_C_LIMITERS.includes(out.primary_limiter.key));
  assert.doesNotMatch(out.recommended_direction, /add(ing)? more (speed|intervals|intensity)/i);
  assert.match(out.recommended_direction, /pacing|durability/i);
}

/* CASE D — 10K, 50 km, consistent Zone 2 */
{
  const out = validateCase({
    primary_limiter: {
      key: "threshold_capacity",
      label: "Threshold capacity",
      why: "50 km/week for 3 months of mostly easy Zone 2 is a solid aerobic platform; a 10K performance goal now needs controlled threshold/specificity, not more base as the only answer."
    },
    diagnostic_confidence: 0.76,
    diagnostic_summary: "With 50 km/week of consistent easy running, the limiter for a faster 10K is likely threshold capacity and specificity.",
    recommended_direction: "Introduce controlled threshold work and 10K-specific sessions while keeping the easy volume.",
    expectation: {
      rating: "realistic",
      text: "This looks achievable with consistent training, but I wouldn't put a fixed timeline on it yet."
    },
    coach_concerns: ["excessive_zone2_focus", "low_specificity"],
    context_flags: ["only_easy_running"]
  });
  assert.equal(out.primary_limiter.key, "threshold_capacity");
  assert.match(out.recommended_direction, /threshold|specificity/i);
  assert.doesNotMatch(out.recommended_direction, /only .{0,20}(more )?base|just build (more )?base/i);
}

/* CASE E — faster 5K after sickness */
{
  const out = validateCase({
    primary_limiter: {
      key: "consistency",
      label: "Consistency",
      why: "After recent sickness, currently low volume, and a historically faster 5K, the first limiter is continuity — rebuild before chasing the old pace."
    },
    diagnostic_confidence: 0.68,
    diagnostic_summary: "Coming back from sickness with low current volume, the job is rebuild consistency rather than immediately chasing the old 5K pace.",
    recommended_direction: "Rebuild training continuity and easy volume first; do not chase the old race pace immediately.",
    expectation: {
      rating: "needs_baseline",
      text: "We need a current performance baseline after the layoff before judging how close you are."
    },
    coach_concerns: ["recent_sickness", "recent_layoff", "inconsistent_training"],
    context_flags: ["recent_sickness", "recent_return"]
  });
  assert.equal(out.primary_limiter.key, "consistency");
  assert.match(out.recommended_direction, /rebuild|continuity/i);
  assert.doesNotMatch(out.recommended_direction, /injury rehab|medical treatment|diagnose/i);
  assert.notEqual(out.primary_limiter.key, "injury_risk");
  assert.equal(out.coach_concerns.includes("recurring_niggle"), false);
}

/* CASE F — time goal, no recent result */
{
  const out = validateCase({
    primary_limiter: {
      key: "unclear_baseline",
      label: "Unclear baseline",
      why: "There is a time goal but no recent race or time trial, so any limiter beyond 'we don't have a current baseline' would be invented."
    },
    diagnostic_confidence: 0.28,
    diagnostic_summary: "There's a time goal but no current result to compare it against.",
    recommended_direction: "Establish a current baseline before judging how close the goal is.",
    expectation: {
      rating: "needs_baseline",
      text: "We need a current performance baseline before judging how close you are."
    },
    context_flags: ["no_recent_baseline"]
  });
  assert.equal(out.primary_limiter.key, "unclear_baseline");
  assert.equal(out.expectation.rating, "needs_baseline");
  assert.ok(out.diagnostic_confidence <= 0.4);
  assert.match(out.diagnostic_summary, /baseline|no current|no recent/i);
}

/* Early-funnel nullable diagnosis still works */
{
  const early = validateCase({
    reply: "That's a clear 5K target.",
    primary_limiter: null,
    secondary_limiter: null,
    diagnostic_confidence: 0.15,
    diagnostic_summary: null,
    recommended_direction: null,
    expectation: { rating: "needs_baseline", text: "We need a current performance baseline before judging how close you are." }
  });
  assert.equal(early.primary_limiter, null);
  assert.equal(early.recommended_direction, null);
  assert.equal(early.expectation.rating, "needs_baseline");
  assert.equal(early.diagnostic_confidence, 0.15);
}

/* Store + stale-signature invalidation */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.setPendingFacts({
    goal_time: "sub-20",
    weekly_mileage: 25,
    recent_race_dist: "5K",
    recent_race_time: "25:00",
    training_structure: "balanced_quality"
  });
  const stored = engine.setModelReasoning({
    primary_limiter: {
      key: "excessive_intensity",
      label: "Intensity density",
      why: "25:00 at 25 km/week with two interval sessions."
    },
    diagnostic_summary: "Intensity density is the limiter.",
    recommended_direction: "Strengthen aerobic support rather than adding more intensity.",
    expectation: { rating: "realistic_aggressive", text: "Aggressive relative to current volume." },
    diagnostic_confidence: 0.7,
    coach_concerns: ["high_intensity_density"],
    context_flags: ["high_intensity_density"]
  });
  assert.equal(stored.primary_limiter.key, "excessive_intensity");
  assert.equal(engine.getModelReasoning().primary_limiter.key, "excessive_intensity");

  engine.setPendingFacts(Object.assign({}, engine.getPendingFacts(), {
    weekly_mileage: 55,
    recent_race_time: "19:40"
  }));
  assert.equal(engine.getModelReasoning(), null, "meaningful new facts must drop stale reasoning");
}

/* Resume keeps reasoning when facts are unchanged */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "10K" });
  engine.setPendingFacts({ weekly_mileage: 50, training_structure: "mostly_easy" });
  engine.setModelReasoning({
    primary_limiter: {
      key: "threshold_capacity",
      label: "Threshold capacity",
      why: "50 km/week of easy running with a 10K goal."
    },
    diagnostic_summary: "Threshold/specificity is the likely limiter.",
    recommended_direction: "Introduce controlled threshold work.",
    expectation: { rating: "realistic", text: "Achievable with consistent training." },
    diagnostic_confidence: 0.7
  });
  const restored = Engine.load();
  assert.equal(restored.getModelReasoning().primary_limiter.key, "threshold_capacity");
}

/* UI stores validated reasoning after strip; routing still ignored */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  helpers.bindEngine(engine);
  helpers.resetFactStore();
  helpers.applyAcknowledgementResult({
    usedFallback: false,
    intent: "diagnostic_answer",
    next_action: "complete_diagnostic",
    show_checkout: true,
    suggested_question_key: "injury_status",
    reply: "With 25 km weeks and two interval sessions, more intensity is not the first move.",
    extracted_facts: { weekly_mileage: 25, training_structure: "balanced_quality" },
    primary_limiter: {
      key: "excessive_intensity",
      label: "ignored",
      why: "With ~25 km/week and two interval sessions, hard running is already present."
    },
    diagnostic_summary: "Intensity density is ahead of aerobic support at 25 km/week.",
    recommended_direction: "Strengthen aerobic support first.",
    expectation: { rating: "realistic_aggressive", text: "Aggressive relative to current volume." },
    diagnostic_confidence: 0.7,
    coach_concerns: ["high_intensity_density"],
    context_flags: ["high_intensity_density", "bogus_flag"]
  }, "I want sub-20 and run 25km with two interval sessions.", { id: "goal_distance" }, []);

  const stored = engine.getModelReasoning();
  assert.equal(stored.primary_limiter.key, "excessive_intensity");
  assert.equal(stored.primary_limiter.label, "Intensity density");
  assert.equal(stored.context_flags.join(","), "high_intensity_density");
  assert.equal(engine.answers.weekly_mileage, 25);
  assert.equal(engine.completed, false);
}

/* Fallback must not wipe a live diagnosis when facts did not change */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.setPendingFacts({ weekly_mileage: 25 });
  engine.setModelReasoning({
    primary_limiter: {
      key: "aerobic_base",
      label: "Aerobic base",
      why: "25 km/week is modest for the stated goal."
    },
    diagnostic_summary: "Aerobic support is the current limiter.",
    recommended_direction: "Build aerobic support.",
    expectation: { rating: "realistic", text: "Achievable with consistent training." },
    diagnostic_confidence: 0.6
  });
  helpers.bindEngine(engine);
  helpers.storeModelReasoningFromResult({
    usedFallback: true,
    primary_limiter: null,
    diagnostic_summary: null
  });
  assert.equal(engine.getModelReasoning().primary_limiter.key, "aerobic_base");
}

/* complete() snapshots reasoning without replacing deterministic limiter */
{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.recordAnswer("injury_status", { injury_has: "none" });
  engine.setPendingFacts({
    weekly_mileage: 25,
    recent_race_dist: "5K",
    recent_race_time: "25:00",
    training_structure: "balanced_quality",
    experience: "1_2_years",
    training_status: "training_block"
  });
  engine.setModelReasoning({
    primary_limiter: {
      key: "excessive_intensity",
      label: "Intensity density",
      why: "Two interval sessions at 25 km/week."
    },
    diagnostic_summary: "Intensity density is the limiter.",
    recommended_direction: "Aerobic support first.",
    expectation: { rating: "realistic_aggressive", text: "Aggressive but possible." },
    diagnostic_confidence: 0.7
  });
  assert.equal(engine.canComplete(), true);
  const result = engine.complete();
  assert.equal(result.modelReasoning.primary_limiter.key, "excessive_intensity");
  assert.ok(result.athlevoRecommendation);
  assert.notEqual(result.primaryLimiter && result.primaryLimiter.key, "excessive_intensity");
}

console.log("PASS — diagnostic structured reasoning (schema, cases A–F, storage, staleness, routing)");
