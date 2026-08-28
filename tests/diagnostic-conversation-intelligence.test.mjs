/*
 * Slice 2 — acknowledgement + leftover NLU on /ai.
 * The model may extract facts and acknowledge context. Deterministic
 * code still owns the next question, checkout, and routing.
 * Run: node tests/diagnostic-conversation-intelligence.test.mjs
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
const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const helpers = UI._internal;

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
const mileageField = { id: "weekly_mileage", type: "number", min: 0, max: 500 };
const CASE1 = "My first marathon is in December. I got sick last month so I only recently got back to running. I’m around 35km per week now and hoping to go under 4 hours.";
const CASE2 = "I run around 30km a week, my longest run is 15km, and I want to run a sub-2 half marathon.";
const CASE7 = "My speed is okay but I always fall apart after 15km.";

function hydrate(msg, field, q) {
  const engine = Engine.create();
  engine.begin();
  helpers.bindEngine(engine);
  helpers.resetFactStore();
  const facts = helpers.extractDiagnosticFacts(msg, field, q);
  helpers.applyExtractedFacts(facts, field.id);
  if (facts.goal_distance) {
    engine.recordAnswer("goal", { goal_distance: facts.goal_distance });
  }
  helpers.commitFullyKnownPendingQuestions();
  return { engine, facts, store: helpers.getFactStore(), next: engine.nextQuestion() };
}

/* CASE 1 — sickness acknowledgement / extraction */
{
  const { engine, facts, store, next } = hydrate(CASE1, goalField, { key: "goal" });
  assert.equal(facts.training_status, "returning");
  assert.equal(facts.weekly_mileage, 35);
  assert.ok(facts.goal_time);
  assert.equal(facts.injury_has, undefined);
  assert.equal(store.injury_has, undefined);
  assert.equal(engine.answers.training_status || store.training_status, "returning");
  assert.ok(engine.answers.goal_time || store.goal_time);
  assert.notEqual(next && next.key, "race_details");
  assert.doesNotMatch((next && next.title) || "", /finish time|goal finish/i);
  assert.equal(helpers.hasAckWorthyContext(CASE1), true);
  assert.equal(helpers.shouldCallAiAcknowledgement(CASE1, goalField, { key: "goal" }), true);

  helpers.mergeAiExtractedFacts({
    injury_has: "significant",
    injury_area: "knee",
    perceived_limiter: "endurance"
  }, CASE1, goalField.id);
  assert.equal(helpers.getFactStore().injury_has, undefined);
  assert.equal(helpers.getFactStore().injury_area, undefined);
  assert.equal(helpers.getFactStore().perceived_limiter, "endurance");
}

/* CASE 2 — compound facts */
{
  const { engine, facts, store, next } = hydrate(CASE2, goalField, { key: "goal" });
  assert.equal(facts.weekly_mileage, 30);
  assert.equal(facts.recent_longest_run_km, 15);
  assert.equal(facts.goal_distance, "Half marathon");
  assert.ok(facts.goal_time);
  assert.equal(helpers.shouldCallAiAcknowledgement(CASE2, goalField, { key: "goal" }), true);
  const knownMileage = facts.weekly_mileage || store.weekly_mileage || engine.answers.weekly_mileage;
  const knownLongest = facts.recent_longest_run_km || store.recent_longest_run_km || engine.answers.recent_longest_run_km;
  assert.equal(knownMileage, 30);
  assert.equal(knownLongest, 15);
  assert.ok(next);
  assert.notEqual(next.key, "goal");
  assert.notEqual(next.key, "race_details");
}

/* CASE 3 — simple numeric answer does not call the model */
{
  assert.equal(Sales.looksLikeSimpleDiagnosticAnswer("30", mileageField), true);
  assert.equal(helpers.shouldCallAiAcknowledgement("30", mileageField, { key: "weekly_volume" }), false);
  assert.equal(Sales.shouldUseAiAcknowledgement("30km/week", mileageField, { extractedFactCount: 1 }), false);
}

/* CASE 4 — chip tap / exact chip label does not call the model */
{
  const chipFn = uiSrc.slice(
    uiSrc.indexOf("function handleChipSelect"),
    uiSrc.indexOf("function showMultiChipsWithState")
  );
  assert.doesNotMatch(chipFn, /callRouter/);
  assert.doesNotMatch(chipFn, /routeViaAi/);
  assert.doesNotMatch(chipFn, /shouldCallAiAcknowledgement/);
  assert.equal(helpers.shouldCallAiAcknowledgement("Marathon", goalField, { key: "goal" }), false);
}

/* CASE 5 — AI show_checkout cannot open signup/payment */
{
  const hijack = helpers.stripModelRouting({
    intent: "ready_to_start",
    next_action: "show_checkout",
    reply: "Great — let's get you started.",
    reply_2: "Pick a payment method.",
    extracted_facts: { weekly_mileage: 35 },
    suggested_question_key: "experience",
    show_checkout: true,
    complete_diagnostic: true,
    confidence: 0.99
  });
  assert.equal(hijack.show_checkout, false);
  assert.equal(hijack.next_action, "continue_diagnostic");
  assert.equal(hijack.suggested_question_key, null);
  const rewritten = helpers.applyAnonymousConversionCopy({
    reply: hijack.reply,
    next_action: hijack.next_action,
    show_checkout: hijack.show_checkout
  });
  assert.notEqual(
    rewritten.reply,
    "Great. Create your Athlevo account first so I can save your training and continue."
  );

  const applySrc = uiSrc.slice(
    uiSrc.indexOf("function applyConversationalResult"),
    uiSrc.indexOf("function restoreCurrentFieldInput")
  );
  const ackSrc = uiSrc.slice(
    uiSrc.indexOf("function applyAcknowledgementResult"),
    uiSrc.indexOf("function handleSalesDetour")
  );
  assert.doesNotMatch(applySrc, /offerPaymentBridge/);
  assert.doesNotMatch(ackSrc, /offerPaymentBridge/);
  assert.match(applySrc, /stripModelRouting/);
  assert.match(ackSrc, /stripModelRouting/);
  assert.equal(helpers.shouldCallAiAcknowledgement("I run 35km a week.", mileageField, { key: "weekly_volume" }), true);
}

/* CASE 6 — real CTA still uses the deterministic sales engine */
{
  const sendSrc = uiSrc.slice(
    uiSrc.indexOf("function handleComposerSend"),
    uiSrc.indexOf("function showChipClarification")
  );
  assert.ok(
    sendSrc.indexOf("decideSalesFollowup") < sendSrc.indexOf("shouldCallAiAcknowledgement"),
    "sales follow-up must run before acknowledgement"
  );
  assert.ok(
    sendSrc.indexOf("highConfidenceSales") < sendSrc.indexOf("shouldCallAiAcknowledgement"),
    "deterministic sales classifier must run before acknowledgement"
  );
  const classified = Sales.classify("yeah let’s do it");
  assert.equal(classified.intent, "ready_to_start");
  assert.equal(classified.next_action, "show_checkout");
  assert.equal(
    helpers.decideSalesFollowup("yeah let’s do it", classified, [], mileageField, { key: "weekly_volume" }),
    "checkout"
  );
  assert.equal(Sales.shouldUseAiAcknowledgement("yeah let’s do it", null, { salesOwned: true }), false);
}

/* CASE 7 — contextual limiter / fade */
{
  assert.equal(helpers.hasAckWorthyContext(CASE7), true);
  assert.equal(helpers.shouldCallAiAcknowledgement(CASE7, goalField, { key: "goal" }), true);
  helpers.bindEngine(Engine.create());
  helpers.resetFactStore();
  helpers.mergeAiExtractedFacts({ perceived_limiter: "endurance" }, CASE7, goalField.id);
  assert.equal(helpers.getFactStore().perceived_limiter, "endurance");
  const ack = helpers.acknowledgementText({
    usedFallback: false,
    reply: "Falling apart after 15 km is a durability issue, not a speed one. What's your weekly mileage?"
  });
  assert.match(ack, /durability|falling apart|15/i);
  assert.doesNotMatch(ack, /weekly mileage/i);
}

{
  assert.equal(helpers.isUsableAcknowledgement({ usedFallback: true, reply: "Got it." }), false);
  assert.equal(helpers.isUsableAcknowledgement({
    reply: "I want to make sure I understand you correctly."
  }), false);
  assert.equal(helpers.isUsableAcknowledgement({ reply: "" }), false);
  assert.equal(helpers.isUsableAcknowledgement({ reply: "Coming back after sickness, we'll build carefully." }), true);
}

{
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  helpers.bindEngine(engine);
  helpers.resetFactStore();
  helpers.applyExtractedFacts({ weekly_mileage: 40 }, "goal_distance");
  helpers.mergeAiExtractedFacts({ weekly_mileage: 99, experience: "5_plus" }, "I run 40km a week.", null);
  assert.equal(helpers.getFactStore().weekly_mileage, 40, "AI must not overwrite a valid pending fact");
  assert.equal(helpers.getFactStore().experience, "5_plus");

  const recorded = Engine.create();
  recorded.begin();
  recorded.recordAnswer("goal", { goal_distance: "Marathon" });
  recorded.recordAnswer("experience", { experience: "new" });
  helpers.bindEngine(recorded);
  helpers.resetFactStore();
  helpers.mergeAiExtractedFacts({ experience: "5_plus" }, "I've been running for years.", null);
  assert.equal(recorded.answers.experience, "new");
  assert.equal(helpers.getFactStore().experience, undefined, "AI must not write over a recorded known fact");
}

{
  const payload = Sales.buildRouterPayload({
    answers: { goal_distance: "Marathon" },
    pendingFacts: { weekly_mileage: 35 },
    getPendingFacts() { return this.pendingFacts; },
    missingRequiredKeys() { return ["experience"]; },
    currentRecommendation() { return null; },
    currentFeasibility() { return null; },
    currentPrimaryLimiter() { return null; },
    safetyFlags: null
  }, "goal", "I run 35km a week.", Sales.emptySalesState(), []);
  assert.equal(payload.known_answers.goal_distance, "Marathon");
  assert.equal(payload.known_answers.weekly_mileage, 35);
  assert.equal(payload.pending_facts.weekly_mileage, 35);
  assert.deepEqual(payload.missing_question_keys, ["experience"]);
}

{
  const complete = helpers.stripModelRouting({
    next_action: "complete_diagnostic",
    show_checkout: false,
    reply: "You're done."
  });
  assert.equal(complete.next_action, "continue_diagnostic");
  const handoff = helpers.stripModelRouting({
    next_action: "handoff_to_existing_flow",
    show_checkout: true
  });
  assert.equal(handoff.next_action, "continue_diagnostic");
  assert.equal(handoff.show_checkout, false);
}

/* skipCannedInterpretations applies only to the acknowledged turn */
{
  const engine = Engine.create();
  engine.begin();
  helpers.bindEngine(engine);
  helpers.resetFactStore();
  assert.equal(helpers.getSkipCannedInterpretations(), false);
  assert.equal(helpers.shouldCallAiAcknowledgement(CASE7, goalField, { key: "goal" }), true);

  helpers.applyAcknowledgementResult({
    usedFallback: false,
    reply: "That's useful context — it sounds less like pure speed and more like endurance durability past 15km.",
    extracted_facts: { perceived_limiter: "endurance" },
    next_action: "continue_diagnostic",
    show_checkout: false
  }, CASE7, goalField, [goalField]);

  assert.equal(helpers.getSkipCannedInterpretations(), true,
    "an acknowledged natural-language turn still suppresses its own canned interpretation");
  assert.equal(engine.history.indexOf("goal"), -1,
    "CASE 3-style ack does not recordAnswer the current question");
  const goalQ = Engine.getQuestion("goal");
  const ownTurnInterp = helpers.getSkipCannedInterpretations()
    ? null
    : goalQ.interpret({ goal_distance: "Marathon" }, engine._stateView());
  assert.equal(ownTurnInterp, null);

  helpers.restoreCurrentFieldInput();
  assert.equal(helpers.getSkipCannedInterpretations(), false,
    "presenting/restoring the pending field must clear the skip flag");

  const chipInterp = goalQ.interpret({ goal_distance: "Marathon" }, engine._stateView());
  const shownAfterChip = helpers.getSkipCannedInterpretations() ? null : chipInterp;
  assert.ok(shownAfterChip, "the next chip tap must run its normal canned interpret()");
  assert.match(shownAfterChip, /marathon/i);
  assert.equal(helpers.shouldCallAiAcknowledgement("Marathon", goalField, { key: "goal" }), false,
    "chip labels still do not trigger an LLM acknowledgement");
}

assert.match(
  uiSrc.slice(uiSrc.indexOf("function presentQuestion"), uiSrc.indexOf("async function presentSubStep")),
  /resetSkipCannedInterpretations\(\)/
);
assert.match(
  uiSrc.slice(uiSrc.indexOf("function restoreCurrentFieldInput"), uiSrc.indexOf("function offerStartChips")),
  /resetSkipCannedInterpretations\(\)/
);
assert.match(uiSrc, /skipCannedInterpretations/);
assert.match(uiSrc, /continueAfterOptionalAcknowledgement/);
assert.match(
  uiSrc.slice(uiSrc.indexOf("function handleSalesDetour"), uiSrc.indexOf("function routeViaAi(")),
  /offerPaymentBridge/
);

console.log("PASS — diagnostic conversation intelligence (ack, leftover NLU, no AI checkout)");
