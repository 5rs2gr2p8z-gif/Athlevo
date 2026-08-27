/*
 * Diagnostic sales engine — buyer intent, readiness, personalized replies,
 * router validation, and AI-failure fallback.
 * Run: node tests/diagnostic-sales-engine.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadSales(fetchFn) {
  const context = {
    console: { log() {}, warn() {}, error() {} },
    fetch: fetchFn,
    setTimeout,
    clearTimeout,
    AbortController
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnosticSalesEngine.js", "utf8"), context, {
    filename: "diagnosticSalesEngine.js"
  });
  return context.AthlevoDiagnosticSales;
}

const Sales = loadSales();

function engine(answers) {
  return {
    answers: answers || {},
    safetyFlags: { injuryReported: false, requiresMedicalClearance: false },
    currentRecommendation() {
      return {
        safetyOverride: false,
        strategy: "Athlevo would give each session a purpose and progress your training based on how you're responding.",
        capabilities: ["Personalized training plan", "Daily workout guidance"]
      };
    },
    currentFeasibility() { return { rating: "realistic", label: "Realistic" }; },
    currentPrimaryLimiter() { return { limiter: "training_structure" }; }
  };
}

{
  const c = Sales.classify("How much is this?");
  assert.equal(c.intent, "pricing_question");
  const reply = Sales.composeSalesReply(c, engine({}), Sales.emptySalesState(), []);
  assert.match(reply.reply, /₱597\/month/);
  assert.doesNotMatch(reply.reply, /chatgpt|json|openai/i);
}

{
  const c = Sales.classify("Okay, how do we start?");
  assert.equal(c.intent, "ready_to_start");
  assert.equal(c.next_action, "show_checkout");
  const reply = Sales.composeSalesReply(c, engine({ goal_distance: "Marathon" }), Sales.emptySalesState(), []);
  assert.equal(reply.show_checkout, true);
  assert.match(reply.reply, /payment method/i);
  assert.doesNotMatch(reply.reply, /3 days free|trial/i);
}

{
  const c = Sales.classify("How can you help me?");
  assert.equal(c.intent, "how_it_works");
  const known = engine({
    goal_distance: "Marathon",
    goal_race_date: "2026-12-06",
    weekly_mileage: 30
  });
  assert.equal(Sales.hasMinimumContext(known), true);
  const reply = Sales.composeSalesReply(c, known, Sales.emptySalesState(), []);
  assert.match(reply.reply, /30/);
  assert.match(reply.reply.toLowerCase(), /marathon/);
  assert.doesNotMatch(reply.reply, /personalized AI coaching/i);
  assert.notEqual(reply.next_action, "continue_diagnostic");
}

{
  const c = Sales.classify("Why wouldn't I just use ChatGPT?");
  assert.equal(c.objection, "chatgpt");
  const reply = Sales.composeSalesReply(c, engine({}), Sales.emptySalesState(), []);
  assert.match(reply.reply, /plan|logged|adjust/i);
  assert.doesNotMatch(reply.reply, /guarantee your time/i);
}

{
  const c = Sales.classify("I already use Garmin");
  assert.equal(c.objection, "device");
  const reply = Sales.composeSalesReply(c, engine({}), Sales.emptySalesState(), []);
  assert.match(reply.reply, /track/i);
}

{
  const c = Sales.classify("Can I cancel?");
  assert.equal(c.objection, "cancellation");
  const reply = Sales.composeSalesReply(c, engine({}), Sales.emptySalesState(), []);
  assert.match(reply.reply, /cancel anytime/i);
}

{
  const price = Sales.classify("How much is it?");
  assert.equal(price.intent, "pricing_question");
  const priceReply = Sales.composeSalesReply(price, engine({}), Sales.emptySalesState(), []);
  assert.match(priceReply.reply, /₱597\/month/);
  assert.equal(priceReply.show_checkout, false);

  const included = Sales.classify("What are the inclusions?");
  assert.equal(included.intent, "how_it_works");
  assert.equal(included.topic, "inclusions");
  assert.notEqual(included.next_action, "show_checkout");
  const includedReply = Sales.composeSalesReply(included, engine({}), Sales.emptySalesState(), []);
  assert.match(includedReply.reply, /personalized training plan/i);
  assert.match(includedReply.reply, /AI endurance coach/i);
  assert.doesNotMatch(includedReply.reply, /clearer balance between controlled aerobic/i);
  assert.match(includedReply.reply_2, /Want me to build your training from here/i);
  assert.match(includedReply.reply_2, /Strava/);
  assert.match(includedReply.reply_2, /Intervals\.icu/);
  assert.doesNotMatch(includedReply.reply_2, /Garmin|COROS|Polar|Apple Health|Suunto/);
  assert.equal(includedReply.show_checkout, false);

  for (const phrase of [
    "What's included?",
    "What do I get?",
    "What does ₱597 include?"
  ]) {
    const c = Sales.classify(phrase);
    assert.equal(c && c.topic, "inclusions", phrase);
    const r = Sales.composeSalesReply(c, engine({}), Sales.emptySalesState(), []);
    assert.match(r.reply, /personalized training plan/i, phrase);
  }

  for (const phrase of [
    "Okay, I want to start.",
    "Let's do it.",
    "yeah, let's do it",
    "I'm ready.",
    "okay let's go",
    "I want to proceed.",
    "Okay, start my training.",
    "okay sounds good, how do I pay?"
  ]) {
    const ready = Sales.classify(phrase);
    assert.equal(ready && ready.intent, "ready_to_start", phrase);
    assert.ok(ready.confidence >= 0.7, phrase);
    assert.equal(ready.next_action, "show_checkout", phrase);
  }

  const payAsk = Sales.classify("How do I pay?");
  assert.ok(payAsk && payAsk.topics && payAsk.topics.indexOf("payment") >= 0);
  assert.notEqual(payAsk.next_action, "show_checkout");
  const payAskReply = Sales.composeSalesReply(payAsk, engine({}), Sales.emptySalesState(), []);
  assert.match(payAskReply.reply, /debit or credit card/i);
  assert.doesNotMatch(payAskReply.reply + " " + payAskReply.reply_2, /QRPh|Maya|GrabPay|3 days|charged immediately/i);
  assert.equal(payAskReply.show_checkout, false);

  assert.equal(Sales.classify("Marathon"), null, "quick-reply labels must not look like buyer intent");
  assert.equal(Sales.classify("1:43"), null);
  assert.equal(Sales.classify("pretty consistent"), null);
  assert.equal(Sales.classify("yes"), null, "bare yes is CTA-followup only, not global ready");
  assert.equal(Sales.isSalesCtaConfirmation("yes"), true);
  assert.equal(Sales.isSalesCtaConfirmation("proceed"), true);
  assert.equal(Sales.isSalesCtaConfirmation("not yet"), false);
}

{
  const pains = Sales.detectPainPoints("I just guess what workout to do every day.");
  assert.ok(pains.indexOf("guessing") >= 0);
  const reply = Sales.composeSalesReply(null, engine({ weekly_mileage: 40, goal_distance: "Marathon" }), Sales.emptySalesState(), pains);
  assert.match(reply.reply, /structure/i);
}

{
  assert.equal(Sales.looksLikeAQuestion("How can you help me?"), true);
  assert.equal(Sales.looksLikeNaturalDiagnosticAnswer("Pretty consistent for the last 5 months except I missed a week."), true);
  assert.equal(Sales.looksLikeNaturalDiagnosticAnswer("Marathon"), false);
  assert.equal(Sales.shouldUseAiFallback("Marathon", { type: "chips" }, { value: "Marathon" }), false);
  assert.equal(Sales.shouldUseAiFallback("Pretty consistent for the last 5 months except I missed a week.", { type: "chips" }, null), true);
}

{
  const signals = {
    explicitReady: true,
    pricingAsked: true,
    hasMinimumContext: false,
    painPointCount: 0,
    valuePropsShown: 0
  };
  assert.equal(Sales.computeReadiness(signals), Sales.READINESS.READY_TO_START);
  assert.equal(Sales.computeReadiness({ pricingAsked: true }), Sales.READINESS.CONSIDERATION);
  assert.equal(Sales.computeReadiness({ hasMinimumContext: true, painPointCount: 1 }), Sales.READINESS.VALUE_DEMONSTRATION);
  assert.equal(Sales.computeReadiness({}), Sales.READINESS.DISCOVERY);
}

{
  const validated = Sales.validateRouterResponse({
    intent: "drop_table",
    next_action: "launch_missiles",
    reply: "Hello",
    extracted_facts: { goal_distance: "Marathon", password: "secret", weekly_mileage: 40 },
    show_checkout: true,
    confidence: 9,
    pain_points: ["guessing", "ssn"],
    buyer_intent: "steal"
  });
  assert.equal(validated.intent, "unknown");
  assert.equal(validated.next_action, "clarify");
  assert.equal(validated.extracted_facts.goal_distance, "Marathon");
  assert.equal(validated.extracted_facts.password, undefined);
  assert.equal(validated.extracted_facts.weekly_mileage, 40);
  assert.equal(validated.pain_points.length, 1);
  assert.equal(validated.pain_points[0], "guessing");
  assert.equal(validated.buyer_intent, "none");
  assert.ok(validated.confidence <= 1);
}

{
  assert.equal(Sales.validateRouterResponse({ intent: "pricing_question", next_action: "explain_offer" }), null);
}

{
  const failing = loadSales(async () => { throw new Error("OpenAI 500 exploded JSON"); });
  const result = await failing.callRouter({ message: "hi" });
  assert.equal(result.usedFallback, true);
  assert.equal(result.reply, "I want to make sure I understand you correctly.");
  assert.doesNotMatch(result.reply, /openai|json|500/i);
}

{
  const failing = loadSales(async () => ({
    ok: false,
    json: async () => ({ error: "OpenAI overloaded", stack: "trace" })
  }));
  const result = await failing.callRouter({ message: "hi" });
  assert.equal(result.usedFallback, true);
  assert.doesNotMatch(JSON.stringify(result), /OpenAI|stack|overloaded/);
}

{
  assert.equal(Sales.TRUE_PRICE, "₱597/month");
  assert.ok(Sales.PRODUCT_FACTS.capabilities.length >= 4);
  assert.match(Sales.PRODUCT_FACTS.notMedical, /not a medical provider/i);
}

{
  const combo = Sales.classify("inclusions and payment method?");
  assert.ok(combo.topics && combo.topics.indexOf("inclusions") >= 0 && combo.topics.indexOf("payment") >= 0);
  assert.equal(combo.topics.length, 2);
  assert.notEqual(combo.next_action, "show_checkout");
  const comboReply = Sales.composeSalesReply(combo, engine({ weekly_mileage: 80, goal_distance: "Marathon" }), Sales.emptySalesState(), []);
  assert.match(comboReply.reply, /personalized training plan/i);
  assert.match(comboReply.reply, /Strava/i);
  assert.match(comboReply.reply_2, /debit or credit card/i);
  assert.match(comboReply.reply_2, /Want to proceed/i);
  assert.doesNotMatch(comboReply.reply + " " + comboReply.reply_2, /clearer balance between controlled aerobic|How long have you been running/i);
  assert.doesNotMatch(comboReply.reply_2, /QRPh|Maya|GrabPay/);
  assert.equal(comboReply.show_checkout, false);
  assert.equal(comboReply.resume_diagnostic, false);
}

{
  const combo = Sales.classify("how much and what do I get?");
  assert.ok(combo.topics.indexOf("price") >= 0 && combo.topics.indexOf("inclusions") >= 0);
  const reply = Sales.composeSalesReply(combo, engine({}), Sales.emptySalesState(), []);
  assert.match(reply.reply, /₱597\/month/);
  assert.match(reply.reply_2, /personalized training plan/i);
}

{
  const combo = Sales.classify("price and how do I pay?");
  assert.ok(combo.topics.indexOf("price") >= 0 && combo.topics.indexOf("payment") >= 0);
  const reply = Sales.composeSalesReply(combo, engine({}), Sales.emptySalesState(), []);
  assert.match(reply.reply, /₱597\/month/);
  assert.match(reply.reply_2, /debit or credit card/i);
  assert.equal(reply.show_checkout, false);
}

{
  const combo = Sales.classify("what do I get, can I cancel?");
  assert.ok(combo.topics.indexOf("inclusions") >= 0 && combo.topics.indexOf("cancellation") >= 0);
  const reply = Sales.composeSalesReply(combo, engine({}), Sales.emptySalesState(), []);
  assert.match(reply.reply, /personalized training plan/i);
  assert.match(reply.reply_2, /cancel anytime/i);
}

console.log("PASS — diagnostic sales engine (intent, personalization, objections, fallback)");
