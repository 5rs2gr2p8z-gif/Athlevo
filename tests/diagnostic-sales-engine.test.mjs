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
  assert.match(reply.reply, /₱597/);
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
  assert.equal(Sales.classify("Marathon"), null, "quick-reply labels must not look like buyer intent");
  assert.equal(Sales.classify("1:43"), null);
  assert.equal(Sales.classify("pretty consistent"), null);
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

console.log("PASS — diagnostic sales engine (intent, personalization, objections, fallback)");
