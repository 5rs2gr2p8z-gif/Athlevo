/* Shared handler behind POST /api/diagnostic-chat and the consolidated
 * gateway (api/providers?action=diagnostic_chat). CORS is applied by the
 * caller so this file stays a pure business handler. */

import { createHash, randomUUID } from "node:crypto";
import {
  checkAiRateLimit,
  checkAnonymousAiRateLimit,
  rateLimitResponse
} from "./rateLimit.js";
import { verifySupabaseAccessToken } from "./supabaseServer.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TIMEOUT_MS = 12_000;

const ALLOWED_INTENTS = [
  "diagnostic_answer",
  "question_about_athlevo",
  "question_about_training",
  "pricing_question",
  "how_it_works",
  "ready_to_start",
  "objection",
  "clarification",
  "off_topic",
  "unknown"
];

const ALLOWED_NEXT_ACTIONS = [
  "continue_diagnostic",
  "clarify",
  "answer_then_continue",
  "recommend_athlevo",
  "explain_offer",
  "show_checkout",
  "complete_diagnostic",
  "handoff_to_existing_flow"
];

const ALLOWED_PAINS = [
  "guessing",
  "uncertainty",
  "unstructured",
  "injury_concern",
  "schedule",
  "plateau"
];

const ALLOWED_BUYER_INTENT = ["none", "curious", "considering", "ready"];

const ALLOWED_LIMITERS = [
  "consistency",
  "aerobic_base",
  "threshold_capacity",
  "excessive_intensity",
  "aerobic_durability",
  "pacing",
  "timeline_mismatch",
  "injury_risk",
  "unclear_baseline"
];

const LIMITER_LABELS = {
  consistency: "Consistency",
  aerobic_base: "Aerobic base",
  threshold_capacity: "Threshold capacity",
  excessive_intensity: "Intensity density",
  aerobic_durability: "Aerobic durability",
  pacing: "Pacing",
  timeline_mismatch: "Timeline",
  injury_risk: "Injury risk",
  unclear_baseline: "Unclear baseline"
};

const ALLOWED_EXPECTATIONS = [
  "realistic",
  "realistic_aggressive",
  "ambitious",
  "needs_baseline",
  "timeline_too_short",
  "clearance_first"
];

const ALLOWED_CONCERNS = [
  "recent_layoff",
  "recent_sickness",
  "sudden_load_increase",
  "high_intensity_density",
  "long_run_load_mismatch",
  "poor_recovery",
  "recurring_niggle",
  "aggressive_race_start",
  "late_race_fade",
  "low_training_frequency",
  "goal_timeline_mismatch",
  "multiple_races",
  "hidden_cross_training_load",
  "strength_interference",
  "excessive_zone2_focus",
  "low_specificity",
  "inconsistent_training",
  "over_specific_too_early",
  "durability_gap"
];

const ALLOWED_CONTEXT_FLAGS = [
  "high_intensity_density",
  "late_fade",
  "aggressive_start",
  "recent_sickness",
  "recent_return",
  "only_easy_running",
  "short_timeline",
  "low_volume_for_goal",
  "strong_recent_baseline",
  "no_recent_baseline",
  "other_sport_load"
];

const LIMITER_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    key: { type: "string", enum: ALLOWED_LIMITERS },
    label: { type: "string" },
    why: { type: "string" }
  },
  required: ["key", "label", "why"]
};

const EXPECTATION_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    rating: { type: "string", enum: ALLOWED_EXPECTATIONS },
    text: { type: "string" }
  },
  required: ["rating", "text"]
};

const FACT_KEYS = [
  "goal_distance",
  "goal_race",
  "goal_race_date",
  "goal_time",
  "experience",
  "training_status",
  "weekly_mileage",
  "weekly_hours",
  "recent_consistency",
  "recent_longest_run_km",
  "recent_race_dist",
  "recent_race_time",
  "training_days",
  "training_structure",
  "training_structure_other",
  "perceived_limiter",
  "injury_has",
  "injury_area",
  "train_time",
  "schedule_constraints",
  "other_training"
];

const FACT_PROPERTIES = Object.fromEntries(
  FACT_KEYS.map(key => [key, { type: ["string", "null"] }])
);

const ROUTER_SCHEMA = {
  type: "json_schema",
  name: "athlevo_diagnostic_turn",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string", enum: ALLOWED_INTENTS },
      next_action: { type: "string", enum: ALLOWED_NEXT_ACTIONS },
      reply: { type: "string" },
      reply_2: { type: ["string", "null"] },
      extracted_facts: {
        type: "object",
        additionalProperties: false,
        properties: FACT_PROPERTIES,
        required: FACT_KEYS
      },
      suggested_question_key: { type: ["string", "null"] },
      show_checkout: { type: "boolean" },
      confidence: { type: "number" },
      pain_points: {
        type: "array",
        maxItems: 4,
        items: { type: "string", enum: ALLOWED_PAINS }
      },
      buyer_intent: { type: "string", enum: ALLOWED_BUYER_INTENT },
      primary_limiter: LIMITER_SCHEMA,
      secondary_limiter: LIMITER_SCHEMA,
      diagnostic_confidence: { type: ["number", "null"] },
      diagnostic_summary: { type: ["string", "null"] },
      recommended_direction: { type: ["string", "null"] },
      expectation: EXPECTATION_SCHEMA,
      coach_concerns: {
        type: "array",
        maxItems: 8,
        items: { type: "string", enum: ALLOWED_CONCERNS }
      },
      context_flags: {
        type: "array",
        maxItems: 8,
        items: { type: "string", enum: ALLOWED_CONTEXT_FLAGS }
      }
    },
    required: [
      "intent",
      "next_action",
      "reply",
      "reply_2",
      "extracted_facts",
      "suggested_question_key",
      "show_checkout",
      "confidence",
      "pain_points",
      "buyer_intent",
      "primary_limiter",
      "secondary_limiter",
      "diagnostic_confidence",
      "diagnostic_summary",
      "recommended_direction",
      "expectation",
      "coach_concerns",
      "context_flags"
    ]
  }
};

const FALLBACK_ANSWER = Object.freeze({
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
  primary_limiter: null,
  secondary_limiter: null,
  diagnostic_confidence: null,
  diagnostic_summary: null,
  recommended_direction: null,
  expectation: null,
  coach_concerns: Object.freeze([]),
  context_flags: Object.freeze([])
});

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || req.headers.Authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  return authorization.slice(7).trim();
}

function clientIp(req) {
  const headers = req.headers || {};
  const forwarded = headers["x-forwarded-for"] || headers["x-real-ip"] || "";
  const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded)
    .split(",")[0]
    .trim();
  return first || (req.socket && req.socket.remoteAddress) || "";
}

function anonClientKey(req) {
  const ip = clientIp(req);
  if (!ip) return "anon-unknown";
  const salt = process.env.OAUTH_STATE_SECRET || "athlevo-diagnostic-chat";
  return createHash("sha256")
    .update(`diagnostic-chat:${ip}:${salt}`)
    .digest("hex")
    .slice(0, 64);
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return null;
}

function sanitizeKnownAnswers(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of FACT_KEYS) {
    const value = raw[key];
    if (value == null || value === "") continue;
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 10).map(String);
  }
  return out;
}

function sanitizeRecentTurns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-6).map(turn => ({
    role: turn && turn.role === "athlevo" ? "athlevo" : "athlete",
    text: String(turn && turn.text || "").slice(0, 300)
  }));
}

function sanitizeBody(body) {
  if (!body || typeof body !== "object") return null;
  const message = String(body.message || "").trim();
  if (!message || message.length > 1000) return null;
  return {
    message,
    current_question_key: typeof body.current_question_key === "string"
      ? body.current_question_key.slice(0, 80)
      : null,
    known_answers: sanitizeKnownAnswers(body.known_answers),
    primary_limiter: typeof body.primary_limiter === "string"
      ? body.primary_limiter.slice(0, 80)
      : null,
    grounded_recommendation: body.grounded_recommendation &&
      typeof body.grounded_recommendation === "object"
      ? {
          strategy: String(body.grounded_recommendation.strategy || "").slice(0, 600),
          capabilities: Array.isArray(body.grounded_recommendation.capabilities)
            ? body.grounded_recommendation.capabilities.slice(0, 8).map(v => String(v).slice(0, 80))
            : []
        }
      : null,
    grounded_feasibility: body.grounded_feasibility &&
      typeof body.grounded_feasibility === "object"
      ? {
          rating: String(body.grounded_feasibility.rating || "").slice(0, 40),
          label: String(body.grounded_feasibility.label || "").slice(0, 80)
        }
      : null,
    product: body.product && typeof body.product === "object" ? {
      price: String(body.product.price || "₱597/month").slice(0, 40),
      capabilities: Array.isArray(body.product.capabilities)
        ? body.product.capabilities.slice(0, 8).map(v => String(v).slice(0, 120))
        : [],
      connects_wearables: String(body.product.connects_wearables || "").slice(0, 200),
      cancel: String(body.product.cancel || "").slice(0, 300),
      not_a_guarantee: String(body.product.not_a_guarantee || "").slice(0, 300),
      not_medical: String(body.product.not_medical || "").slice(0, 200)
    } : {
      price: "₱597/month",
      capabilities: [
        "Personalized training plan built from your goal, schedule, and current training",
        "Daily workout guidance",
        "An AI coach you can talk to about your training",
        "Training adjustments as you log sessions and feedback",
        "Progress and readiness insights"
      ],
      connects_wearables: "Strava, Garmin, Intervals.icu, COROS, Polar, Apple Health, and Suunto",
      cancel: "Cancel anytime — cancelling stops future charges.",
      not_a_guarantee: "Athlevo does not guarantee race results.",
      not_medical: "Athlevo is not a medical provider."
    },
    sales_state: body.sales_state && typeof body.sales_state === "object" ? {
      readiness: String(body.sales_state.readiness || "DISCOVERY").slice(0, 40),
      pain_point_count: Number(body.sales_state.pain_point_count) || 0,
      objections_raised: Array.isArray(body.sales_state.objections_raised)
        ? body.sales_state.objections_raised.slice(0, 5).map(v => String(v).slice(0, 40))
        : [],
      value_shown_count: Number(body.sales_state.value_shown_count) || 0
    } : { readiness: "DISCOVERY", pain_point_count: 0, objections_raised: [], value_shown_count: 0 },
    recent_turns: sanitizeRecentTurns(body.recent_turns),
    pending_facts: sanitizeKnownAnswers(body.pending_facts),
    missing_question_keys: Array.isArray(body.missing_question_keys)
      ? body.missing_question_keys.slice(0, 12).map(v => String(v).slice(0, 80))
      : [],
    diagnostic_sufficiency: body.diagnostic_sufficiency === true,
    safety_flags: body.safety_flags && typeof body.safety_flags === "object"
      ? {
          injuryReported: body.safety_flags.injuryReported === true,
          requiresMedicalClearance: body.safety_flags.requiresMedicalClearance === true
        }
      : { injuryReported: false, requiresMedicalClearance: false }
  };
}

function sanitizeCoachText(raw, max) {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (/^(n\/a|na|none|null|undefined|unknown|-|—|\.|…)$/i.test(text)) return null;
  return text.slice(0, max);
}

function sanitizeLimiter(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = typeof raw.key === "string" ? raw.key : "";
  if (!ALLOWED_LIMITERS.includes(key)) return null;
  const why = sanitizeCoachText(raw.why, 400);
  if (!why) return null;
  return { key, label: LIMITER_LABELS[key], why };
}

function sanitizeExpectation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rating = typeof raw.rating === "string" ? raw.rating : "";
  if (!ALLOWED_EXPECTATIONS.includes(rating)) return null;
  const text = sanitizeCoachText(raw.text, 300);
  if (!text) return null;
  return { rating, text };
}

function sanitizeKeyedList(raw, allowed, max) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string" || !allowed.includes(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeDiagnosticConfidence(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 1) return null;
  return Math.round(raw * 1000) / 1000;
}

function validateAnswer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const reply = typeof raw.reply === "string" ? raw.reply.trim().slice(0, 600) : "";
  const facts = {};
  if (raw.extracted_facts && typeof raw.extracted_facts === "object") {
    for (const key of FACT_KEYS) {
      const value = raw.extracted_facts[key];
      if (value == null || value === "") continue;
      facts[key] = value;
    }
  }
  const pains = Array.isArray(raw.pain_points)
    ? raw.pain_points.filter(p => ALLOWED_PAINS.includes(p)).slice(0, 4)
    : [];
  const primary = sanitizeLimiter(raw.primary_limiter);
  const secondary = primary ? sanitizeLimiter(raw.secondary_limiter) : null;
  return {
    intent: ALLOWED_INTENTS.includes(raw.intent) ? raw.intent : "unknown",
    next_action: ALLOWED_NEXT_ACTIONS.includes(raw.next_action) ? raw.next_action : "clarify",
    reply,
    reply_2: typeof raw.reply_2 === "string" && raw.reply_2.trim()
      ? raw.reply_2.trim().slice(0, 600)
      : null,
    extracted_facts: facts,
    suggested_question_key: typeof raw.suggested_question_key === "string"
      ? raw.suggested_question_key.slice(0, 80)
      : null,
    show_checkout: raw.show_checkout === true,
    confidence: typeof raw.confidence === "number"
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.5,
    pain_points: pains,
    buyer_intent: ALLOWED_BUYER_INTENT.includes(raw.buyer_intent) ? raw.buyer_intent : "none",
    primary_limiter: primary,
    secondary_limiter: secondary && secondary.key !== primary.key ? secondary : null,
    diagnostic_confidence: sanitizeDiagnosticConfidence(raw.diagnostic_confidence),
    diagnostic_summary: sanitizeCoachText(raw.diagnostic_summary, 500),
    recommended_direction: sanitizeCoachText(raw.recommended_direction, 400),
    expectation: sanitizeExpectation(raw.expectation),
    coach_concerns: sanitizeKeyedList(raw.coach_concerns, ALLOWED_CONCERNS, 8),
    context_flags: sanitizeKeyedList(raw.context_flags, ALLOWED_CONTEXT_FLAGS, 8)
  };
}

function developerPrompt() {
  return `
You are the diagnostic reasoning layer inside Athlevo, an endurance training app.

You interpret one pre-signup diagnostic chat turn. You extract facts, write a short acknowledgement, and — when the athlete context is strong enough — produce a structured coaching judgment.

You do NOT run the funnel.
You do NOT decide completion.
You do NOT ask the next diagnostic question. The client will ask the next missing field.
You do NOT control checkout, signup, or payment.

The client owns diagnostic state, known facts, pending facts, question sequencing, injury/safety gates, completion, sales stage, CTA state, signup routing, payment routing, and entitlement.
You never decide that someone is paid, that checkout should open, or that the diagnostic is complete.

YOUR JOBS
1. Extract useful facts from latest_message.
2. Understand the athlete's goal.
3. Compare current ability against goal demand.
4. Weigh training context and constraints.
5. Identify the most likely PRIMARY limiter — the athlete's actual primary limiting factor right now.
6. Optionally identify one SECONDARY limiter only if it materially changes training direction.
7. Explain why using athlete-specific evidence from known_answers, pending_facts, latest_message, and grounded context.
8. Recommend training DIRECTION, not a full plan.
9. Calibrate expectation honestly.
10. Acknowledge meaningful context naturally.

NORTH-STAR
Always try to answer: "What is the athlete's actual primary limiting factor right now?"
Prefer one primary limiter + optional 1 secondary limiter.
Never return a generic laundry list of speed + endurance + strength + consistency + recovery.
The primary limiter should be the factor most likely to change training direction NOW.
The input field primary_limiter (if present) is the deterministic engine's current hypothesis — supporting context only. Do not copy it blindly. Use the controlled limiter enum in your output.
Do not force a diagnosis on every call. If context is too weak, primary_limiter, diagnostic_summary, and recommended_direction may be null, diagnostic_confidence should be low, and expectation may be needs_baseline.

REASONING HIERARCHY
A. GOAL — finish vs performance, race distance, target time/pace, deadline.
B. CURRENT CAPACITY — recent race/TT, weekly volume, longest run, frequency, recent consistency, training age, current structure.
C. GOAL GAP — what the goal requires relative to current ability.
D. CONSTRAINTS — sickness/layoff, injury/niggle, schedule, available days, other sports, recovery, strength, race calendar.
E. PRIMARY LIMITER — choose one from the controlled enum.
F. SECONDARY LIMITER — only if it materially matters.
G. DIRECTION — what training should prioritize first.
H. EXPECTATION — how realistic/aggressive the goal is.

LIMITER ENUM (do not show raw keys to the athlete; use labels in prose)
- consistency
- aerobic_base
- threshold_capacity
- excessive_intensity
- aerobic_durability
- pacing
- timeline_mismatch
- injury_risk
- unclear_baseline

EXPECTATION RATINGS
- realistic — achievable with consistent training; do not invent a fixed timeline.
- realistic_aggressive — realistic but aggressive vs current baseline; think months rather than weeks unless the athlete gave a deadline.
- ambitious — meaningful jump; not impossible, but first phase should build the platform.
- needs_baseline — no current performance baseline; do not fake a judgment.
- timeline_too_short — the timeline is the main problem; durability/safety over forcing pace.
- clearance_first — only with existing safety/injury context. Do not diagnose medically.

COACH CONCERNS are observations to weigh, not automatic diagnoses.
CONTEXT FLAGS must be emitted only when supported by athlete-provided context. Do not invent.

IMPORTANT REASONING RULES
- Do not assume more mileage is always the answer.
- Volume ≠ specificity. High weekly mileage with an adequate long run plus a late fade usually points to race-specific endurance, pacing, fueling, or intensity distribution — not "run more" or "long runs aren't long enough."
- Do not claim long runs "aren't long enough" or that mileage is too low unless the athlete's reported volume and longest run are actually short for the goal.
- A runner can have enough mileage and long-run distance and still lack marathon-specific work, pacing discipline, fueling practice, late-run durability, or threshold development.
- Low volume plus a short long run plus a near-term marathon may still be a genuine endurance/volume gap.
- Do not recommend more intervals just because the goal is faster.
- Do not treat a late fade automatically as lack of speed.
- Do not treat "legs fail first" automatically as weakness.
- Do not treat every long-distance goal as "endurance pacing."
- Do not treat a missing recent race result as proof the goal is unrealistic. If evidence is incomplete, say so (needs_baseline) rather than forcing a hard no.
- Do not let self-reported perceived_limiter automatically become the diagnosis. Treat perceived limiter as supporting evidence only.
- Do not let one metric dominate the whole judgment.
- Distinguish symptom from likely cause when possible.
- Prefer the limiter that changes the next training phase.
- Recent sickness/layoff should make continuity/rebuild more important than chasing old fitness. Sickness is not an injury diagnosis.
- High-intensity density relative to low weekly volume should raise excessive_intensity / aerobic support concern. Do not recommend more intensity.
- High consistent volume with only easy running and a performance goal should raise threshold_capacity / low_specificity concern, not "build more base" as the only answer.
- Short marathon timeline with low volume/longest run should raise timeline_mismatch / durability concern. Do not prescribe an immediate 30km long run.
- Opening too fast and fading late may point to pacing and/or durability, not pure speed.
- No current baseline should reduce confidence and may produce unclear_baseline / needs_baseline.

EVIDENCE
Every non-null diagnosis must reference athlete-specific evidence (paces, volume, structure, timeline, symptoms they actually stated).
BAD: "Your aerobic base is the main limiter."
GOOD: "With a 25:00 5K, ~25 km/week, and two interval sessions already in the week, the bigger issue probably isn't lack of hard running."
Use only facts present in known_answers, pending_facts, current user turn, and grounded context. Do not invent athlete data.

DIRECTION, NOT A FULL PLAN
Allowed: rebuild consistency first; reduce intensity density; strengthen aerobic support; introduce controlled threshold work; improve pacing discipline; build long-run durability gradually; establish a current baseline; prioritize recovery before progression.
Not allowed: workout prescriptions (e.g. 5 × 1 km at 4:05), exact weekly mileage targets, exact long-run distances, medical rehab protocols. The paid product owns detailed programming.

EXPECTATION LANGUAGE
Be honest and calibrated. Never guarantee a race time, promise a percentage improvement, say "you will", or invent an exact number of weeks unless the athlete gave a deadline.

ACKNOWLEDGEMENTS
Keep acknowledgements short. No default "great goal". No unnecessary praise. No full stat recap. Acknowledge only information that changes interpretation. Do not ask the next question.
Reply in 1–2 short sentences. reply_2 must be null unless the runner asked a product question.
If there is nothing meaningful to acknowledge (a simple number or option), reply may be an empty string.

WHEN CONTEXT IS WEAK
If available context is too weak (including when diagnostic_sufficiency is false and this turn does not itself complete the picture):
- primary_limiter may be null
- diagnostic_summary may be empty/null
- recommended_direction may be null
- expectation may be needs_baseline if appropriate
- diagnostic_confidence should be low
Do NOT force a diagnosis on every AI call. Mid-funnel turns are often extraction/acknowledgement only.

ROUTING / SAFETY
- show_checkout must be false. next_action must be continue_diagnostic for diagnostic answers.
- Do not ask the next diagnostic question. The client will ask the next missing field.
- Do not complete the diagnostic, skip the injury gate, open signup/payment, or claim access already exists.
- Do not invent product capabilities, prices, guarantees, medical advice, or facts the runner did not state.
- Price is ₱597/month. Cancel anytime stops future charges; it does not automatically refund past ones.
- Athlevo is not a medical provider and does not diagnose injuries. Do not prescribe medical treatment.
- Resolved sickness or time off is NOT an injury. Do not set injury_has for that.
- Athlevo does not guarantee race results.
- Never mention JSON, schemas, models, APIs, or internal fields.
- Extract EVERY useful athlete fact clearly stated in latest_message, even if it is not the current question.
- Prefer null over a guess. Month-only dates stay null.

PRODUCT FACTS YOU MAY USE
- Personalized training plan from goal, schedule, and current training
- Daily workout guidance
- An AI coach they can talk to after they start
- Training adjustments as they log sessions and feedback
- Progress and readiness insights
- Wearable connections: Strava, Garmin, Intervals.icu, COROS, Polar, Apple Health, Suunto
`.trim();
}

async function interpretTurn(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning: { effort: "low" },
        input: [
          { role: "developer", content: developerPrompt() },
          {
            role: "user",
            content: JSON.stringify({
              latest_message: payload.message,
              current_question_key: payload.current_question_key,
              known_answers: payload.known_answers,
              pending_facts: payload.pending_facts,
              missing_question_keys: payload.missing_question_keys,
              diagnostic_sufficiency: payload.diagnostic_sufficiency,
              safety_flags: payload.safety_flags,
              primary_limiter: payload.primary_limiter,
              grounded_recommendation: payload.grounded_recommendation,
              grounded_feasibility: payload.grounded_feasibility,
              product: payload.product,
              sales_state: payload.sales_state,
              recent_turns: payload.recent_turns
            })
          }
        ],
        text: { format: ROUTER_SCHEMA }
      })
    });

    if (!response.ok) {
      console.warn(JSON.stringify({
        event: "diagnostic_chat_failed",
        category: "provider_unavailable",
        providerStatus: response.status,
        correlationId: randomUUID()
      }));
      return FALLBACK_ANSWER;
    }

    const data = await response.json();
    const text = extractResponseText(data);
    if (!text) return FALLBACK_ANSWER;
    try {
      return validateAnswer(JSON.parse(text)) || FALLBACK_ANSWER;
    } catch {
      return FALLBACK_ANSWER;
    }
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.warn(JSON.stringify({
      event: "diagnostic_chat_failed",
      category: timedOut ? "timeout" : "provider_unavailable",
      correlationId: randomUUID()
    }));
    return FALLBACK_ANSWER;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function diagnosticChatHandler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST.", code: "METHOD_NOT_ALLOWED" });
  }

  const payload = sanitizeBody(req.body);
  if (!payload) {
    return sendJson(res, 200, { answer: FALLBACK_ANSWER });
  }

  try {
    const token = getBearerToken(req);
    if (token) {
      const verified = await verifySupabaseAccessToken(token);
      if (verified && verified.ok && verified.user && verified.user.id) {
        const limit = await checkAiRateLimit(verified.user.id, "diagnostic-chat");
        if (!limit.allowed) return rateLimitResponse(res, limit);
      } else {
        const limit = await checkAnonymousAiRateLimit(anonClientKey(req), "diagnostic-chat");
        if (!limit.allowed) return rateLimitResponse(res, limit);
      }
    } else {
      const limit = await checkAnonymousAiRateLimit(anonClientKey(req), "diagnostic-chat");
      if (!limit.allowed) return rateLimitResponse(res, limit);
    }
  } catch {
    // fail-open — funnel must still work
  }

  if (!OPENAI_API_KEY) {
    return sendJson(res, 200, { answer: FALLBACK_ANSWER });
  }

  const answer = await interpretTurn(payload);
  return sendJson(res, 200, { answer });
}
