import { createHash, randomUUID } from "node:crypto";
import { handleCors } from "../lib/server/cors.js";
import {
  checkAiRateLimit,
  checkAnonymousAiRateLimit,
  rateLimitResponse
} from "../lib/server/rateLimit.js";
import { verifySupabaseAccessToken } from "../lib/server/supabaseServer.js";

export const maxDuration = 20;

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
      buyer_intent: { type: "string", enum: ALLOWED_BUYER_INTENT }
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
      "buyer_intent"
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
  buyer_intent: "none"
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
    recent_turns: sanitizeRecentTurns(body.recent_turns)
  };
}

function validateAnswer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const reply = typeof raw.reply === "string" ? raw.reply.trim().slice(0, 600) : "";
  if (!reply) return null;
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
    buyer_intent: ALLOWED_BUYER_INTENT.includes(raw.buyer_intent) ? raw.buyer_intent : "none"
  };
}

function developerPrompt() {
  return `
You interpret one pre-signup diagnostic chat turn for Athlevo, an endurance training app.

You are a knowledgeable endurance coach, a diagnostic engine, and a consultative sales guide.
Not manipulative. Not aggressive. Not deceptive.

STRICT RULES
- Do not invent product capabilities, prices, guarantees, medical advice, or facts the runner did not state.
- Use only known_answers, grounded_recommendation, and the product facts supplied below.
- Price is ₱597/month. Cancel anytime stops future charges; it does not automatically refund past ones.
- Athlevo is not a medical provider and does not diagnose injuries.
- Athlevo does not guarantee race results.
- Never mention JSON, schemas, models, APIs, or internal fields.
- Never claim a plan, payment, or account change has already happened.
- Reply in 1–3 short sentences. reply_2 is an optional second bubble; use it sparingly.
- Extract a fact only when the runner clearly stated it. Prefer null over a guess.
- If the message answers the current diagnostic question, intent is diagnostic_answer and next_action is continue_diagnostic.
- If they ask how Athlevo helps, price, or how to start, answer that FIRST. Do not ask the next questionnaire question.
- Explicit buyer intent outweighs finishing the questionnaire.
- Keep the voice calm, precise, specific to what they told you.

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

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

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
