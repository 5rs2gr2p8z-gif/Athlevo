/* Athlevo — anonymous Coach preview chat.
 *
 * Powers the signed-out Coach conversation (item: "anonymous acquisition
 * funnel"). Distinct from /api/coach on purpose:
 *   - no auth required, no 10-message free quota touched
 *   - no coach_threads / coach_conversations writes — the whole exchange
 *     is stateless server-side; the client is the only place any of it
 *     is remembered (sessionStorage) and only until signup
 *   - never receives trainingState, wearable data, or another athlete's
 *     history — there IS none for an anonymous visitor
 *   - drives the SAME question bank as the old pre-signup diagnostic
 *     (js/diagnostic.js, DiagnosticEngine) one question at a time, so the
 *     facts a visitor gives here land in the existing diagnostic handoff
 *     (js/diagnosticHandoff.js) after signup with no second profile model
 *
 * The client sends exactly one pending diagnostic question's field
 * definitions per turn (from DiagnosticEngine.getQuestions()) and this
 * endpoint asks the model to (a) extract any of those fields the visitor's
 * message actually supplied, using their existing enum options where the
 * field is a chip choice, and (b) write one short, natural coaching reply
 * that gives a small honest insight and asks for whatever is still needed.
 */

import { randomUUID, createHash } from "node:crypto";
import { checkAnonymousAiRateLimit, rateLimitResponse } from "./rateLimit.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TIMEOUT_MS = 12_000;
const MAX_MESSAGE_LENGTH = 800;
const MAX_HISTORY_TURNS = 8;
const MAX_FIELDS_PER_QUESTION = 6;

const FALLBACK_REPLY =
  "I can help you work that out, but I don't have your training history yet — " +
  "tell me a bit about what you're doing now and I'll help you make sense of it.";

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
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
  const salt = process.env.OAUTH_STATE_SECRET || "athlevo-coach-anonymous";
  return createHash("sha256")
    .update(`coach-anonymous:${ip}:${salt}`)
    .digest("hex")
    .slice(0, 64);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength || 200);
}

/* The client hands us one diagnostic question's field defs (id, type,
 * label, options) — never the whole question bank, and never anything
 * shaped like the athlete's stored profile. This validates that shape so
 * a malformed/forged payload can't be used to smuggle something else into
 * the model call. */
function sanitizeQuestionFields(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  const allowedTypes = new Set(["chips", "multichips", "text", "number", "date"]);
  const out = [];
  for (const field of rawFields.slice(0, MAX_FIELDS_PER_QUESTION)) {
    if (!field || typeof field !== "object") continue;
    const id = cleanText(field.id, 60);
    const type = allowedTypes.has(field.type) ? field.type : null;
    if (!id || !type) continue;
    const entry = {
      id,
      type,
      label: cleanText(field.label, 120) || id,
      required: field.required === true
    };
    if (type === "chips" || type === "multichips") {
      const options = Array.isArray(field.options) ? field.options : [];
      entry.options = options
        .slice(0, 12)
        .map(opt => cleanText(opt && opt.value, 60))
        .filter(Boolean);
      if (!entry.options.length) continue;
    }
    out.push(entry);
  }
  return out;
}

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .slice(-MAX_HISTORY_TURNS)
    .map(turn => ({
      role: turn && turn.role === "assistant" ? "assistant" : "user",
      text: cleanText(turn && turn.text, MAX_MESSAGE_LENGTH)
    }))
    .filter(turn => turn.text);
}

function sanitizeBody(body) {
  if (!body || typeof body !== "object") return null;
  const message = cleanText(body.message, MAX_MESSAGE_LENGTH);
  if (!message) return null;
  const questionKey = cleanText(body.question_key, 60) || null;
  const fields = sanitizeQuestionFields(body.question_fields);
  const history = sanitizeHistory(body.history);
  return { message, questionKey, fields, history };
}

function buildExtractionSchema(fields) {
  const properties = {};
  for (const field of fields) {
    if (field.type === "chips") {
      properties[field.id] = { type: ["string", "null"], enum: [...field.options, null] };
    } else if (field.type === "multichips") {
      properties[field.id] = {
        type: "array",
        items: { type: "string", enum: field.options }
      };
    } else if (field.type === "number") {
      properties[field.id] = { type: ["number", "null"] };
    } else {
      properties[field.id] = { type: ["string", "null"] };
    }
  }
  return {
    type: "json_schema",
    name: "athlevo_anonymous_coach_turn",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        extracted: {
          type: "object",
          additionalProperties: false,
          properties,
          required: Object.keys(properties)
        },
        reply: { type: "string" }
      },
      required: ["extracted", "reply"]
    }
  };
}

function developerPrompt(fields) {
  const fieldLines = fields
    .map(f => {
      const optionText = f.options ? ` Allowed values: ${f.options.join(", ")}.` : "";
      return `- ${f.id} (${f.type}${f.required ? ", required" : ", optional"}): ${f.label}.${optionText}`;
    })
    .join("\n");

  return `
You are Athlevo's running coach talking to a visitor who has NOT created an
account yet. You are having a real, natural conversation — not running a
form. This is a diagnostic preview, not the athlete's real coach: you have
no training history, no wearable data, no readiness/HRV, no plan, and no
race history for this person. Never claim or imply you already know their
mileage, readiness, fitness, or fatigue — you only know what they just told
you in this conversation.

WHAT YOU ARE TRYING TO LEARN RIGHT NOW
The single most useful thing to learn from their next message is:
${fieldLines || "- nothing specific; just keep the conversation useful and natural."}
Only try to extract these fields, and only from what they actually said —
never guess or invent a value. If they didn't give a field, leave it null.
Chip fields must use one of the exact allowed values, never a paraphrase.

HOW TO REPLY
- Understand -> interpret -> give one small, honest, useful insight ->
  ask the next most useful question. Do this in flowing natural language,
  like a sharp human coach texting back, not a scripted assistant.
- No interrogation. If they already gave you enough for a small insight,
  give it before asking anything else.
- Do not repeat back what they just said. Do not over-praise or use
  exclamation points. Be calm, direct, and specific.
- Keep it short: 1-3 sentences of insight, then at most one question.
- Never fabricate numbers, paces, mileage, or medical/injury advice. For
  pain or injury mentions, be conservative and suggest professional
  assessment if it sounds serious — never diagnose.
- Never mention JSON, schemas, fields, or anything internal.
- If the message is off-topic (e.g. small talk, pricing questions), answer
  briefly and helpfully, then gently steer back to understanding their
  running so you can help.
`.trim();
}

async function interpretTurn(payload) {
  const schema = buildExtractionSchema(payload.fields);
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
          { role: "developer", content: developerPrompt(payload.fields) },
          {
            role: "user",
            content: JSON.stringify({
              latest_message: payload.message,
              recent_turns: payload.history
            })
          }
        ],
        text: { format: schema }
      })
    });

    if (!response.ok) {
      console.warn(JSON.stringify({
        event: "coach_anonymous_failed",
        category: "provider_unavailable",
        providerStatus: response.status,
        correlationId: randomUUID()
      }));
      return null;
    }

    const data = await response.json();
    const text = typeof data?.output_text === "string" && data.output_text.trim()
      ? data.output_text.trim()
      : extractFromOutputArray(data);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.reply !== "string") return null;
      return {
        reply: parsed.reply.slice(0, 1200),
        extracted: parsed.extracted && typeof parsed.extracted === "object" ? parsed.extracted : {}
      };
    } catch {
      return null;
    }
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.warn(JSON.stringify({
      event: "coach_anonymous_failed",
      category: timedOut ? "timeout" : "provider_unavailable",
      correlationId: randomUUID()
    }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractFromOutputArray(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return null;
}

export default async function coachAnonymousHandler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST.", code: "METHOD_NOT_ALLOWED" });
  }

  const payload = sanitizeBody(req.body);
  if (!payload) {
    return sendJson(res, 400, {
      error: "Ask a more specific training question.",
      code: "INVALID_MESSAGE"
    });
  }

  try {
    const limit = await checkAnonymousAiRateLimit(anonClientKey(req), "coach-anonymous");
    if (!limit.allowed) return rateLimitResponse(res, limit);
  } catch {
    // fail-open — the anonymous funnel must still work
  }

  if (!OPENAI_API_KEY) {
    return sendJson(res, 200, { reply: FALLBACK_REPLY, extracted: {} });
  }

  const result = await interpretTurn(payload);
  if (!result) {
    return sendJson(res, 200, { reply: FALLBACK_REPLY, extracted: {} });
  }
  return sendJson(res, 200, result);
}
