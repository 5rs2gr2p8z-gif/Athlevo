/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Diagnostic Sales Engine  (buyer-intent + conversational router)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The pre-signup diagnostic (js/diagnostic.js + js/diagnosticUI.js) is a
 *  deterministic questionnaire engine. This file adds the layer that lets
 *  Athlevo behave like a coach having a sales conversation ON TOP of that
 *  questionnaire:
 *
 *    1. A cheap, deterministic classifier recognises the obvious buyer-
 *       intent moments (pricing, "how do I start", explicit objections)
 *       without ever calling an API.
 *    2. A small, explainable readiness model (DISCOVERY → VALUE_
 *       DEMONSTRATION → CONSIDERATION → READY_TO_START) tracks how close
 *       the runner is to being ready to start. Explicit signals dominate;
 *       questionnaire completion does not.
 *    3. Personalized replies are grounded in answers the runner actually
 *       supplied plus DiagnosticEngine.currentRecommendation() — the model
 *       (when used) phrases things; it does not invent capabilities or price.
 *    4. callRouter() talks to /api/diagnostic-chat (OpenAI key stays
 *       server-only) and NEVER throws.
 *
 *  DOM-free so the decision logic can be unit-tested without a browser.
 */
(function (root) {
"use strict";

var TRUE_PRICE = "₱597/month";
var ROUTER_ENDPOINT = "/api/diagnostic-chat";
var ROUTER_TIMEOUT_MS = 12000;

/* ═══════════════════════ REAL PRODUCT FACTS ═══════════════════════════
 * Hand-maintained to match js/landingContent.js and the diagnostic result
 * screen. Update alongside those files if pricing, cancellation, or the
 * capability list change. Never invent beyond this list.
 */
var PRODUCT_FACTS = {
  price: TRUE_PRICE,
  billing: "Monthly, recurring. Cancel anytime — cancelling stops future charges; it does not automatically refund past ones unless required by law or Athlevo's refund policy.",
  capabilities: [
    "Personalized training plan built from your goal, schedule, and current training",
    "Daily workout guidance",
    "An AI coach you can talk to about your training",
    "Training adjustments as you log sessions and feedback",
    "Progress and readiness insights"
  ],
  connectsWearables: "Strava, Garmin, Intervals.icu, COROS, Polar, Apple Health, and Suunto",
  notAGuarantee: "Athlevo does not guarantee race results or times — it provides individualized structure, feedback, and decision-making support; outcomes still depend on training, health, recovery, and race-day conditions.",
  notMedical: "Athlevo is not a medical provider and cannot diagnose injuries."
};

/* ═══════════════════════ DETERMINISTIC CLASSIFIER ══════════════════════
 * Conservative on purpose: a false negative falls through to field parsing
 * then the AI router; a false positive would hijack a legitimate answer.
 */
var RE_PRICING = /(how much (is|does|would)|what.?s the price|what does (it|this|athlevo) cost|\bpricing\b|\bcost\b.*(month|athlevo|this)|₱|\bphp\s?\d|per month|monthly (fee|price|cost|charge)|subscription (cost|price|fee))/i;
var RE_READY = /(sign me up|let.?s start|start now|i.?m in\b|how do (i|we) (start|pay)|where do i (sign up|pay)|i.?m ready to start|get started|build my (training|plan|marathon|race)|make my (training )?plan|start (my )?training|start with athlevo|i want to (start|proceed)|what do i do next|how do i pay|where do i pay)/i;
var RE_HOW_IT_WORKS = /(how (do|does|would|can) (you|it|athlevo) (help|work|coach)|how can you help( me)?|what.?s included|what (are|are the) (the )?inclusions|what do i get|how does this work|how would (this|athlevo) help|what happens after i (sign up|start|pay))/i;
var RE_INTERESTED = /(^|\s)(i.?m interested|sounds good|okay,? (i.?m|let.?s|lets))(\s|$|\.)/i;
var RE_SHORT_READY = /^(ok(ay)?[,.]?\s*)?(i.?m ready|let.?s do (it|this)|i want to proceed)\.?$/i;
var RE_OBJ_CHATGPT = /(just chatgpt|use chatgpt|why not chatgpt|why wouldn.?t i just use chatgpt|isn.?t this (just )?chatgpt)/i;
var RE_OBJ_CANCEL = /\bcan i cancel\b|\bcancel anytime\b|\bcancel(lation)?\b/i;
var RE_OBJ_STATIC = /(static plan|just a spreadsheet|excel (sheet|plan)|pdf plan|what.?s different from a static)/i;
var RE_OBJ_DEVICE = /(already (use|have|got) (a )?(garmin|strava|coros|polar|apple watch|suunto)|why .{0,24}(garmin|strava)|garmin (already )?(tracks|does|has))/i;
var RE_OBJ_DIY = /(make my own plan|just make it myself|can.?t i make my own|don.?t need (an app|this|athlevo))/i;
var RE_QUESTION_LEAD = /^\s*(how|what|why|can|could|is|are|do|does|will|would|should|where|when)\b/i;
var RE_NATURAL = /\b(pretty|mostly|fairly|quite|around|about|except|because|don'?t know|not sure|guess|consistent|per week|a week)\b/i;

function classify(message) {
  var m = String(message || "").trim();
  if (!m) return null;

  if (RE_PRICING.test(m)) {
    return { intent: "pricing_question", next_action: "explain_offer", confidence: 0.92 };
  }
  if (RE_SHORT_READY.test(m) || RE_READY.test(m)) {
    return { intent: "ready_to_start", next_action: "show_checkout", confidence: 0.9 };
  }
  if (RE_HOW_IT_WORKS.test(m)) {
    return { intent: "how_it_works", next_action: "recommend_athlevo", confidence: 0.85 };
  }
  if (RE_OBJ_CHATGPT.test(m)) {
    return { intent: "objection", next_action: "answer_then_continue", confidence: 0.85, objection: "chatgpt" };
  }
  if (RE_OBJ_STATIC.test(m)) {
    return { intent: "objection", next_action: "answer_then_continue", confidence: 0.8, objection: "static_plan" };
  }
  if (RE_OBJ_DIY.test(m)) {
    return { intent: "objection", next_action: "answer_then_continue", confidence: 0.75, objection: "diy" };
  }
  if (RE_OBJ_DEVICE.test(m)) {
    return { intent: "objection", next_action: "answer_then_continue", confidence: 0.75, objection: "device" };
  }
  if (RE_OBJ_CANCEL.test(m)) {
    return { intent: "objection", next_action: "answer_then_continue", confidence: 0.8, objection: "cancellation" };
  }
  if (RE_INTERESTED.test(m)) {
    return { intent: "ready_to_start", next_action: "recommend_athlevo", confidence: 0.55 };
  }
  return null;
}

function looksLikeAQuestion(message) {
  var m = String(message || "").trim();
  if (!m) return false;
  if (/\?\s*$/.test(m)) return true;
  if (RE_QUESTION_LEAD.test(m) && m.split(/\s+/).length >= 3) return true;
  return false;
}

/** True when a chips-field answer is a real sentence, not a failed tap. */
function looksLikeNaturalDiagnosticAnswer(message) {
  var m = String(message || "").trim();
  if (!m) return false;
  var words = m.split(/\s+/).filter(Boolean);
  if (words.length >= 8) return true;
  if (words.length >= 5 && RE_NATURAL.test(m)) return true;
  return false;
}

function detectPainPoints(message) {
  var m = String(message || "");
  var out = [];
  if (/guess (what |which )?(workout|session|run)|don'?t know what (workout|to (run|do|train))/i.test(m)) {
    out.push("guessing");
  }
  if (/not sure if .{0,60}structur|don'?t know if .{0,60}structur|unstructur|no (real |actual )?plan\b/i.test(m)) {
    out.push("uncertainty");
  }
  if (/\b(guess|random runs|no structure)\b/i.test(m) && out.indexOf("guessing") < 0) {
    out.push("unstructured");
  }
  if (/\b(no time|too busy|shift work|kids?|childcare)\b/i.test(m)) out.push("schedule");
  return out;
}

/* ═══════════════════════ MINIMUM VIABLE CONTEXT ════════════════════════
 * MUST KNOW before a personalized recommendation: goal + some training level.
 * USEFUL: limiter / pain / race date. OPTIONAL: everything else.
 * Buyer intent is still answered honestly below this bar — Athlevo just
 * asks one more targeted question instead of pretending it can personalize.
 */
function hasMinimumContext(engine) {
  if (!engine || !engine.answers) return false;
  var a = engine.answers;
  var hasGoal = !!a.goal_distance;
  var hasLevel = !!(a.experience || a.training_status || a.weekly_mileage || a.training_days);
  return hasGoal && hasLevel;
}

function hasUsefulLimiter(engine, salesState) {
  var a = (engine && engine.answers) || {};
  if (a.perceived_limiter && a.perceived_limiter !== "unclear") return true;
  if (salesState && salesState.painPointCount > 0) return true;
  return false;
}

/* ═══════════════════════ READINESS MODEL ═══════════════════════════════ */

var READINESS = {
  DISCOVERY: "DISCOVERY",
  VALUE_DEMONSTRATION: "VALUE_DEMONSTRATION",
  CONSIDERATION: "CONSIDERATION",
  READY_TO_START: "READY_TO_START"
};

function computeReadiness(signals) {
  signals = signals || {};
  if (signals.explicitReady) return READINESS.READY_TO_START;
  if (signals.pricingAsked || signals.howItWorksAsked) return READINESS.CONSIDERATION;
  if (signals.hasMinimumContext && (signals.painPointCount > 0 || signals.valuePropsShown > 0)) {
    return READINESS.VALUE_DEMONSTRATION;
  }
  return READINESS.DISCOVERY;
}

function emptySalesState() {
  return {
    readiness: READINESS.DISCOVERY,
    painPoints: [],
    objections: [],
    pricingAsked: false,
    howItWorksAsked: false,
    explicitReady: false,
    painPointCount: 0,
    valuePropsShown: 0
  };
}

function applySalesSignals(state, classification, extraPains, hasContext) {
  var next = state ? {
    readiness: state.readiness,
    painPoints: (state.painPoints || []).slice(),
    objections: (state.objections || []).slice(),
    pricingAsked: !!state.pricingAsked,
    howItWorksAsked: !!state.howItWorksAsked,
    explicitReady: !!state.explicitReady,
    painPointCount: state.painPointCount || 0,
    valuePropsShown: state.valuePropsShown || 0
  } : emptySalesState();

  var pains = extraPains || [];
  for (var i = 0; i < pains.length; i++) {
    if (next.painPoints.indexOf(pains[i]) < 0) next.painPoints.push(pains[i]);
  }
  next.painPointCount = next.painPoints.length;

  if (classification) {
    if (classification.intent === "pricing_question") next.pricingAsked = true;
    if (classification.intent === "how_it_works" || classification.intent === "question_about_athlevo") {
      next.howItWorksAsked = true;
    }
    if (classification.intent === "ready_to_start" && classification.confidence >= 0.7) {
      next.explicitReady = true;
    }
    if (classification.objection && next.objections.indexOf(classification.objection) < 0) {
      next.objections.push(classification.objection);
    }
  }

  next.readiness = computeReadiness({
    explicitReady: next.explicitReady,
    pricingAsked: next.pricingAsked,
    howItWorksAsked: next.howItWorksAsked,
    painPointCount: next.painPointCount,
    valuePropsShown: next.valuePropsShown,
    hasMinimumContext: hasContext !== false
  });
  return next;
}

function markValueShown(state) {
  var next = applySalesSignals(state, null, []);
  next.valuePropsShown = (next.valuePropsShown || 0) + 1;
  next.readiness = computeReadiness({
    explicitReady: next.explicitReady,
    pricingAsked: next.pricingAsked,
    howItWorksAsked: next.howItWorksAsked,
    painPointCount: next.painPointCount,
    valuePropsShown: next.valuePropsShown,
    hasMinimumContext: true
  });
  return next;
}

/* ═══════════════════════ DYNAMIC CTA COPY ══════════════════════════════ */

function ctaLabel(engine, salesState) {
  var a = (engine && engine.answers) || {};
  var goal = a.goal_distance;
  salesState = salesState || {};

  if (salesState.readiness === READINESS.READY_TO_START) {
    return "Start with Athlevo · " + TRUE_PRICE;
  }
  if (salesState.painPointCount > 0) {
    return "Build my training plan · " + TRUE_PRICE;
  }
  if (goal === "Marathon") return "Build my marathon training · " + TRUE_PRICE;
  if (goal === "Half marathon") return "Build my half marathon training · " + TRUE_PRICE;
  if (goal === "10K" || goal === "5K") return "Build my " + goal + " training · " + TRUE_PRICE;
  if (goal === "Ultra") return "Build my ultra training · " + TRUE_PRICE;
  return "Start my training · " + TRUE_PRICE;
}

/* ═══════════════════════ PERSONALIZED REPLIES ═════════════════════════
 * Only uses facts the runner actually supplied. Never fabricates volume,
 * races, or capabilities. 1–2 short bubbles.
 */

function monthFromIso(iso) {
  if (!iso || typeof iso !== "string") return null;
  var m = iso.match(/^(\d{4})-(\d{2})-/);
  if (!m) {
    var named = String(iso).match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
    return named ? named[1].charAt(0).toUpperCase() + named[1].slice(1).toLowerCase() : null;
  }
  var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return months[Number(m[2]) - 1] || null;
}

function statedFacts(engine) {
  var a = (engine && engine.answers) || {};
  var km = a.weekly_mileage != null && a.weekly_mileage !== "" ? Number(a.weekly_mileage) : null;
  return {
    goal: a.goal_distance || null,
    race: a.goal_race || null,
    raceDate: a.goal_race_date || null,
    goalTime: a.goal_time || null,
    km: isFinite(km) ? km : null,
    hours: a.weekly_hours != null && a.weekly_hours !== "" ? Number(a.weekly_hours) : null,
    days: a.training_days != null && a.training_days !== "" ? Number(a.training_days) : null,
    status: a.training_status || null,
    limiter: a.perceived_limiter || null
  };
}

function groundedStrategy(engine) {
  if (!engine || typeof engine.currentRecommendation !== "function") return null;
  var rec = engine.currentRecommendation();
  if (!rec || rec.safetyOverride || !rec.strategy) return null;
  return rec.strategy;
}

function composeHelpReply(engine, salesState) {
  var f = statedFacts(engine);
  var pains = (salesState && salesState.painPoints) || [];
  var guessing = pains.indexOf("guessing") >= 0 || pains.indexOf("unstructured") >= 0 || pains.indexOf("uncertainty") >= 0;
  var month = monthFromIso(f.raceDate);
  var goalBit = f.goal && f.goal !== "General fitness" ? f.goal.toLowerCase() : "goal";
  var whenBit = month ? " toward your " + month + " " + goalBit : (f.goal ? " toward the " + goalBit : "");

  if (!hasMinimumContext(engine)) {
    return {
      reply: "I can — I'd rather be specific than generic.",
      reply_2: f.goal
        ? "What's your current weekly volume look like, roughly?"
        : "What's the distance you're working toward?",
      next_action: "answer_then_continue",
      show_checkout: false
    };
  }

  var reply;
  var reply2;
  if (f.km != null && f.km >= 70 && f.goal === "Marathon") {
    reply = "You're already running around " + Math.round(f.km) + " km a week, so your issue probably isn't motivation or doing more. The bigger question is whether that volume is being distributed well enough for you to absorb the quality work and reach the marathon fresh.";
    reply2 = "Athlevo would build the week around that volume, then adjust as you log sessions — rather than having you add more and hope it sticks.";
  } else if (f.km != null && f.goal) {
    reply = "Based on what you've told me, I'd first focus on building from your current " + Math.round(f.km) + " km weeks safely" + whenBit + " instead of having you guess week to week.";
    reply2 = "Athlevo builds the training around your current volume, race timeline, and how you're responding — then adjusts it as you go.";
  } else {
    var strategy = groundedStrategy(engine);
    reply = strategy || ("Athlevo would start from your current training and build a repeatable week for your " + goalBit + " — then adjust as you go.");
    reply2 = guessing
      ? "Instead of guessing the workout each day, you'd get a session with a purpose."
      : "Want me to build it from here?";
  }

  if (guessing && reply2.indexOf("guess") < 0 && reply2.indexOf("Want me") < 0) {
    reply2 = "Instead of guessing the workout each day, you'd get a session with a purpose and a plan that changes when your week does.";
  }

  return {
    reply: reply,
    reply_2: reply2,
    next_action: "recommend_athlevo",
    show_checkout: false
  };
}

function composeObjectionReply(objection, engine) {
  var f = statedFacts(engine);
  if (objection === "chatgpt") {
    return {
      reply: "ChatGPT can give general running advice, but it doesn't have your Athlevo plan, the sessions you've logged, or the rules that keep load increases conservative.",
      reply_2: "Athlevo actually builds the week and adjusts it from what you do — that's the loop a chat window by itself doesn't have.",
      next_action: "answer_then_continue",
      show_checkout: false
    };
  }
  if (objection === "diy") {
    return {
      reply: "You can write your own plan. The hard part is the daily decision — what to do today, what to change after a missed week, and when to back off.",
      reply_2: "That's the job Athlevo takes: a plan from your current training, then adjustments as you log sessions.",
      next_action: "answer_then_continue",
      show_checkout: false
    };
  }
  if (objection === "device") {
    return {
      reply: "Garmin and the other watches are excellent at tracking. Athlevo uses that data to decide what to train next.",
      reply_2: "Tracking tells you what happened. The plan, the daily session, and the adjustment when you miss or overreach — that's the part Athlevo adds.",
      next_action: "answer_then_continue",
      show_checkout: false
    };
  }
  if (objection === "static_plan") {
    return {
      reply: "A static plan doesn't change when you miss a week, feel wrecked, or run better than expected.",
      reply_2: "Athlevo starts from your current training and adjusts as you log sessions and feedback — not a PDF that stays frozen.",
      next_action: "answer_then_continue",
      show_checkout: false
    };
  }
  if (objection === "cancellation") {
    return {
      reply: "Yes. You can cancel anytime — that stops future charges.",
      reply_2: "Cancelling does not automatically refund past payments unless required by law or Athlevo's refund policy.",
      next_action: "answer_then_continue",
      show_checkout: false
    };
  }
  return composeHelpReply(engine, emptySalesState());
}

function composePriceReply() {
  return {
    reply: "Athlevo AI is " + TRUE_PRICE + ".",
    reply_2: "You can cancel anytime — that stops future charges. Want to start from here?",
    next_action: "explain_offer",
    show_checkout: false
  };
}

function composeReadyReply(engine) {
  var f = statedFacts(engine);
  var bit = f.goal && f.goal !== "General fitness" ? " for your " + f.goal.toLowerCase() : "";
  return {
    reply: "Sounds good" + bit + ". Choose whichever payment method is easiest for you.",
    reply_2: "Your diagnostic is saved either way.",
    next_action: "show_checkout",
    show_checkout: true
  };
}

function composePainAck(engine, pains) {
  var f = statedFacts(engine);
  var guessing = pains.indexOf("guessing") >= 0 || pains.indexOf("unstructured") >= 0;
  if (guessing && f.km != null && f.goal) {
    return {
      reply: "Guessing the workout every day is a structure problem, not a motivation one.",
      reply_2: "With about " + Math.round(f.km) + " km a week toward a " + f.goal.toLowerCase() + ", Athlevo would give each session a purpose and stop you from reinventing the week from scratch.",
      next_action: "recommend_athlevo",
      show_checkout: false
    };
  }
  if (guessing) {
    return {
      reply: "Guessing the workout every day is a structure problem, not a motivation one.",
      reply_2: "Athlevo would give each session a purpose and adjust the week as you go.",
      next_action: "recommend_athlevo",
      show_checkout: false
    };
  }
  if (pains.indexOf("uncertainty") >= 0) {
    return {
      reply: "Not knowing whether the training is actually structured is more common than it sounds — effort without a progression is usually the gap.",
      reply_2: hasMinimumContext(engine)
        ? "Athlevo would organise the week around what you're already doing, then adjust as you respond."
        : "Tell me your goal distance and roughly how much you're running — then I can be specific.",
      next_action: hasMinimumContext(engine) ? "recommend_athlevo" : "answer_then_continue",
      show_checkout: false
    };
  }
  return null;
}

/**
 * Deterministic sales/coaching reply for high-confidence classifications
 * and recognised pain. Returns null when the caller should keep treating
 * the message as a diagnostic field answer (or fall through to AI).
 */
function composeSalesReply(classification, engine, salesState, extraPains) {
  extraPains = extraPains || [];
  if (classification) {
    if (classification.intent === "pricing_question") return composePriceReply();
    if (classification.intent === "ready_to_start" && classification.confidence >= 0.7) {
      return composeReadyReply(engine);
    }
    if (classification.intent === "how_it_works" || classification.intent === "question_about_athlevo") {
      return composeHelpReply(engine, salesState);
    }
    if (classification.intent === "objection") {
      return composeObjectionReply(classification.objection, engine);
    }
    if (classification.intent === "ready_to_start") {
      return composeHelpReply(engine, salesState);
    }
  }
  if (extraPains.length) return composePainAck(engine, extraPains);
  return null;
}

/**
 * Should this unmatched chips answer go to the AI router instead of
 * "pick one"? Quick-reply labels themselves never reach here.
 */
function shouldUseAiFallback(message, field, mappedValue) {
  if (mappedValue != null) return false;
  if (!field) return looksLikeAQuestion(message);
  if (field.type === "chips" || field.type === "multichips") {
    return looksLikeAQuestion(message) || looksLikeNaturalDiagnosticAnswer(message);
  }
  if (looksLikeAQuestion(message)) return true;
  return false;
}

/* ═══════════════════════ ROUTER PAYLOAD / VALIDATION ═══════════════════ */

var KNOWN_ANSWER_KEYS = [
  "goal_distance", "goal_race", "goal_race_date", "goal_time",
  "experience", "training_status", "weekly_mileage", "weekly_hours",
  "recent_consistency", "recent_longest_run_km", "recent_race_dist",
  "recent_race_time", "training_days", "training_structure",
  "training_structure_other", "perceived_limiter", "injury_has",
  "injury_area", "train_time", "schedule_constraints", "other_training"
];

var ALLOWED_INTENTS = [
  "diagnostic_answer", "question_about_athlevo", "question_about_training",
  "pricing_question", "how_it_works", "ready_to_start", "objection",
  "clarification", "off_topic", "unknown"
];
var ALLOWED_NEXT_ACTIONS = [
  "continue_diagnostic", "clarify", "answer_then_continue",
  "recommend_athlevo", "explain_offer", "show_checkout",
  "complete_diagnostic", "handoff_to_existing_flow"
];
var ALLOWED_PAINS = ["guessing", "uncertainty", "unstructured", "injury_concern", "schedule", "plateau"];
var ALLOWED_BUYER_INTENT = ["none", "curious", "considering", "ready"];

function sanitizedAnswers(answers) {
  var out = {};
  answers = answers || {};
  for (var i = 0; i < KNOWN_ANSWER_KEYS.length; i++) {
    var key = KNOWN_ANSWER_KEYS[i];
    var v = answers[key];
    if (v == null || v === "") continue;
    if (typeof v === "string") out[key] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (Array.isArray(v)) out[key] = v.slice(0, 10).map(String);
  }
  return out;
}

function buildRouterPayload(engine, currentQuestionKey, message, salesState, recentTurns) {
  var rec = engine && engine.currentRecommendation ? engine.currentRecommendation() : null;
  var feas = engine && engine.currentFeasibility ? engine.currentFeasibility() : null;
  var limiter = engine && engine.currentPrimaryLimiter ? engine.currentPrimaryLimiter() : null;
  salesState = salesState || {};

  return {
    message: String(message || "").slice(0, 1000),
    current_question_key: currentQuestionKey || null,
    known_answers: sanitizedAnswers(engine ? engine.answers : {}),
    primary_limiter: limiter ? limiter.limiter : null,
    grounded_recommendation: (rec && !rec.safetyOverride) ? {
      strategy: rec.strategy,
      capabilities: rec.capabilities
    } : null,
    grounded_feasibility: feas ? { rating: feas.rating, label: feas.label } : null,
    safety_flags: engine ? engine.safetyFlags : null,
    product: {
      price: PRODUCT_FACTS.price,
      capabilities: PRODUCT_FACTS.capabilities,
      connects_wearables: PRODUCT_FACTS.connectsWearables,
      cancel: PRODUCT_FACTS.billing,
      not_a_guarantee: PRODUCT_FACTS.notAGuarantee,
      not_medical: PRODUCT_FACTS.notMedical
    },
    sales_state: {
      readiness: salesState.readiness || READINESS.DISCOVERY,
      pain_point_count: salesState.painPointCount || 0,
      objections_raised: (salesState.objections || []).slice(0, 5),
      value_shown_count: salesState.valuePropsShown || 0
    },
    recent_turns: (recentTurns || []).slice(-6).map(function (t) {
      return { role: t.role === "athlevo" ? "athlevo" : "athlete", text: String(t.text || "").slice(0, 300) };
    })
  };
}

function validateRouterResponse(raw) {
  if (!raw || typeof raw !== "object") return null;
  var intent = ALLOWED_INTENTS.indexOf(raw.intent) >= 0 ? raw.intent : "unknown";
  var nextAction = ALLOWED_NEXT_ACTIONS.indexOf(raw.next_action) >= 0 ? raw.next_action : "clarify";
  var reply = typeof raw.reply === "string" ? raw.reply.slice(0, 600) : "";
  var reply2 = typeof raw.reply_2 === "string" && raw.reply_2.trim() ? raw.reply_2.slice(0, 600) : null;
  var facts = {};
  if (raw.extracted_facts && typeof raw.extracted_facts === "object") {
    for (var i = 0; i < KNOWN_ANSWER_KEYS.length; i++) {
      var key = KNOWN_ANSWER_KEYS[i];
      var v = raw.extracted_facts[key];
      if (v == null || v === "") continue;
      facts[key] = v;
    }
  }
  var suggestedKey = typeof raw.suggested_question_key === "string" ? raw.suggested_question_key : null;
  var showCheckout = raw.show_checkout === true;
  var confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  var pains = [];
  if (Array.isArray(raw.pain_points)) {
    for (var p = 0; p < raw.pain_points.length && pains.length < 4; p++) {
      if (ALLOWED_PAINS.indexOf(raw.pain_points[p]) >= 0 && pains.indexOf(raw.pain_points[p]) < 0) {
        pains.push(raw.pain_points[p]);
      }
    }
  }
  var buyerIntent = ALLOWED_BUYER_INTENT.indexOf(raw.buyer_intent) >= 0 ? raw.buyer_intent : "none";

  if (!reply) return null;

  return {
    intent: intent,
    next_action: nextAction,
    reply: reply,
    reply_2: reply2,
    extracted_facts: facts,
    suggested_question_key: suggestedKey,
    show_checkout: showCheckout,
    confidence: confidence,
    pain_points: pains,
    buyer_intent: buyerIntent
  };
}

/* ═══════════════════════ NETWORK CALL ═══════════════════════════════════ */

var FALLBACK_RESPONSE = Object.freeze({
  intent: "unknown",
  next_action: "clarify",
  reply: "I want to make sure I understand you correctly.",
  reply_2: null,
  extracted_facts: {},
  suggested_question_key: null,
  show_checkout: false,
  confidence: 0,
  pain_points: [],
  buyer_intent: "none",
  usedFallback: true
});

function callRouter(payload) {
  var fetchFn = (root && root.fetch) ? root.fetch.bind(root) : (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) return Promise.resolve(FALLBACK_RESPONSE);

  var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, ROUTER_TIMEOUT_MS) : null;

  return fetchFn(ROUTER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: controller ? controller.signal : undefined
  })
    .then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) return FALLBACK_RESPONSE;
      return res.json().then(function (body) {
        var validated = validateRouterResponse(body && body.answer ? body.answer : body);
        return validated || FALLBACK_RESPONSE;
      }, function () { return FALLBACK_RESPONSE; });
    })
    .catch(function () {
      if (timer) clearTimeout(timer);
      return FALLBACK_RESPONSE;
    });
}

/* ═══════════════════════ EXPORT ═════════════════════════════════════════ */

var AthlevoDiagnosticSales = {
  PRODUCT_FACTS: PRODUCT_FACTS,
  READINESS: READINESS,
  TRUE_PRICE: TRUE_PRICE,
  classify: classify,
  looksLikeAQuestion: looksLikeAQuestion,
  looksLikeNaturalDiagnosticAnswer: looksLikeNaturalDiagnosticAnswer,
  detectPainPoints: detectPainPoints,
  hasMinimumContext: hasMinimumContext,
  hasUsefulLimiter: hasUsefulLimiter,
  computeReadiness: computeReadiness,
  emptySalesState: emptySalesState,
  applySalesSignals: applySalesSignals,
  markValueShown: markValueShown,
  ctaLabel: ctaLabel,
  composeSalesReply: composeSalesReply,
  composeHelpReply: composeHelpReply,
  shouldUseAiFallback: shouldUseAiFallback,
  buildRouterPayload: buildRouterPayload,
  validateRouterResponse: validateRouterResponse,
  callRouter: callRouter,
  FALLBACK_RESPONSE: FALLBACK_RESPONSE,
  KNOWN_ANSWER_KEYS: KNOWN_ANSWER_KEYS,
  ALLOWED_INTENTS: ALLOWED_INTENTS,
  ALLOWED_NEXT_ACTIONS: ALLOWED_NEXT_ACTIONS
};

root.AthlevoDiagnosticSales = AthlevoDiagnosticSales;

if (typeof module !== "undefined" && module.exports) {
  module.exports = AthlevoDiagnosticSales;
}

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
