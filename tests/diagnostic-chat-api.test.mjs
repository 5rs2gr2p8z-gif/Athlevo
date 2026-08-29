/*
 * /api/diagnostic-chat — structured-output endpoint, failure fallback,
 * CORS, and no secret leakage.
 * Run: node tests/diagnostic-chat-api.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.OPENAI_API_KEY = "sk-test-diagnostic";

const source = readFileSync("./lib/server/diagnosticChatEndpoint.js", "utf8");
const wrapper = readFileSync("./api/diagnostic-chat.js", "utf8");
const providers = readFileSync("./api/providers/index.js", "utf8");
const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));
const vercelIgnore = readFileSync("./.vercelignore", "utf8");
const ui = readFileSync("./js/diagnosticUI.js", "utf8");
const sales = readFileSync("./js/diagnosticSalesEngine.js", "utf8");
const index = readFileSync("./index.html", "utf8");

assert.match(source, /text:\s*\{\s*format:\s*ROUTER_SCHEMA/);
assert.match(source, /type:\s*"json_schema"/);
assert.match(source, /strict:\s*true/);
assert.match(source, /https:\/\/api\.openai\.com\/v1\/responses/);
assert.match(source, /model:\s*"gpt-5.5"/);
assert.match(source, /checkAnonymousAiRateLimit/);
assert.doesNotMatch(source, /req\.body\.user_id/);
assert.match(source, /I want to make sure I understand you correctly/);
assert.match(wrapper, /if \(handleCors\(/);
assert.match(wrapper, /diagnosticChatHandler/);
assert.match(providers, /action === "diagnostic_chat"/);
assert.ok(vercel.rewrites.some(route =>
  route.source === "/api/diagnostic-chat" &&
  route.destination === "/api/providers?action=diagnostic_chat"
));
assert.match(vercelIgnore, /^api\/diagnostic-chat\.js$/m);

assert.doesNotMatch(ui, /OPENAI_API_KEY|sk-[a-zA-Z0-9]{10,}|api\.openai\.com/);
assert.doesNotMatch(sales, /OPENAI_API_KEY|sk-[a-zA-Z0-9]{10,}|api\.openai\.com/);
assert.match(sales, /\/api\/diagnostic-chat/);
assert.match(index, /js\/diagnosticSalesEngine\.js/);

function recorder() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; }
  };
}

const originalFetch = globalThis.fetch;
let openAiCalls = 0;
let openAiImpl = async () => ({
  ok: true,
  json: async () => ({
    output_text: JSON.stringify({
      intent: "how_it_works",
      next_action: "recommend_athlevo",
      reply: "I'd build from your current 30 km weeks toward the marathon.",
      reply_2: "Want me to build it from here?",
      extracted_facts: {
        goal_distance: null, goal_race: null, goal_race_date: null, goal_time: null,
        experience: null, training_status: null, weekly_mileage: null, weekly_hours: null,
        recent_consistency: null, recent_longest_run_km: null, recent_race_dist: null,
        recent_race_time: null, training_days: null, training_structure: null,
        training_structure_other: null, perceived_limiter: null, injury_has: null,
        injury_area: null, train_time: null, schedule_constraints: null, other_training: null
      },
      suggested_question_key: null,
      show_checkout: false,
      confidence: 0.8,
      pain_points: [],
      buyer_intent: "curious"
    })
  })
});

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("openai.com")) {
    openAiCalls += 1;
    return openAiImpl(url, opts);
  }
  if (u.includes("ai_anon_rate_limits") && (!opts || opts.method === "GET" || !opts.method)) {
    return { ok: true, json: async () => [] };
  }
  if (u.includes("ai_anon_rate_limits")) {
    return { ok: true, json: async () => ({}) };
  }
  return { ok: true, json: async () => ({}) };
};

const { default: handler } = await import("../api/diagnostic-chat.js?diagnostic-chat-test");

{
  const res = recorder();
  await handler({
    method: "OPTIONS",
    headers: { origin: "https://athlevo.org" }
  }, res);
  assert.equal(res.statusCode, 204);
}

{
  openAiCalls = 0;
  const res = recorder();
  await handler({
    method: "POST",
    headers: { origin: "https://athlevo.org", "content-type": "application/json" },
    body: {
      message: "How can you help me?",
      current_question_key: "experience",
      known_answers: { goal_distance: "Marathon", weekly_mileage: 30 }
    }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(openAiCalls, 1);
  assert.equal(res.body.answer.intent, "how_it_works");
  assert.match(res.body.answer.reply, /30 km/);
  assert.equal(res.body.answer.extracted_facts.password, undefined);
}

{
  openAiCalls = 0;
  openAiImpl = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "OpenAI exploded" } }) });
  const res = recorder();
  await handler({
    method: "POST",
    headers: { origin: "https://athlevo.org" },
    body: { message: "Pretty consistent except I missed a week." }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.answer.next_action, "clarify");
  assert.match(res.body.answer.reply, /understand you correctly/);
  const blob = JSON.stringify(res.body);
  assert.doesNotMatch(blob, /OpenAI|exploded|stack|500/);
}

{
  const res = recorder();
  await handler({
    method: "POST",
    headers: { origin: "https://athlevo.org" },
    body: { message: "" }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.answer.next_action, "clarify");
}

assert.doesNotMatch(source, /checkout\(|paymongo|whop/i);
assert.match(source, /Do not ask the next diagnostic question/);
assert.match(source, /show_checkout must be false/);
assert.match(source, /never decide that someone is paid/i);
assert.match(source, /reply may be an empty string/);
assert.doesNotMatch(source, /if \(!reply\) return null/);

{
  openAiCalls = 0;
  openAiImpl = async () => ({
    ok: true,
    json: async () => ({
      output_text: JSON.stringify({
        intent: "diagnostic_answer",
        next_action: "continue_diagnostic",
        reply: "",
        reply_2: null,
        extracted_facts: {
          goal_distance: null, goal_race: null, goal_race_date: null, goal_time: null,
          experience: null, training_status: "returning", weekly_mileage: 35, weekly_hours: null,
          recent_consistency: null, recent_longest_run_km: null, recent_race_dist: null,
          recent_race_time: null, training_days: null, training_structure: null,
          training_structure_other: null, perceived_limiter: null, injury_has: null,
          injury_area: null, train_time: null, schedule_constraints: null, other_training: null
        },
        suggested_question_key: "recent_longest_run_km",
        show_checkout: true,
        confidence: 0.7,
        pain_points: [],
        buyer_intent: "none"
      })
    })
  });
  const res = recorder();
  await handler({
    method: "POST",
    headers: { origin: "https://athlevo.org", "content-type": "application/json" },
    body: { message: "I got sick last month and I'm around 35km per week." }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.answer.reply, "");
  assert.equal(res.body.answer.extracted_facts.weekly_mileage, 35);
  assert.equal(res.body.answer.show_checkout, true, "API may still return the field; the client must ignore it");
  assert.equal(res.body.answer.primary_limiter, null);
  assert.equal(res.body.answer.diagnostic_summary, null);
}

{
  openAiCalls = 0;
  openAiImpl = async () => ({
    ok: true,
    json: async () => ({
      output_text: JSON.stringify({
        intent: "diagnostic_answer",
        next_action: "complete_diagnostic",
        reply: "With a 25:00 5K, ~25 km/week, and two interval sessions, more intensity is not the first move.",
        reply_2: null,
        extracted_facts: {
          goal_distance: "5K", goal_race: null, goal_race_date: null, goal_time: "sub-20",
          experience: null, training_status: null, weekly_mileage: 25, weekly_hours: null,
          recent_consistency: null, recent_longest_run_km: null, recent_race_dist: "5K",
          recent_race_time: "25:00", training_days: null, training_structure: "balanced_quality",
          training_structure_other: null, perceived_limiter: null, injury_has: null,
          injury_area: null, train_time: null, schedule_constraints: null, other_training: null
        },
        suggested_question_key: "injury_status",
        show_checkout: true,
        confidence: 0.8,
        pain_points: ["plateau"],
        buyer_intent: "curious",
        primary_limiter: {
          key: "excessive_intensity",
          label: "ignored",
          why: "With a 25:00 5K, ~25 km/week, and two interval sessions already in the week, the bigger issue is not lack of hard running."
        },
        secondary_limiter: {
          key: "aerobic_base",
          label: "Aerobic base",
          why: "Weekly volume is modest for a sub-20 jump."
        },
        diagnostic_confidence: 0.74,
        diagnostic_summary: "Intensity density is ahead of aerobic and threshold support.",
        recommended_direction: "Strengthen aerobic and threshold support before adding more 5K-specific intensity.",
        expectation: {
          rating: "realistic_aggressive",
          text: "The goal is realistic but aggressive relative to the current baseline."
        },
        coach_concerns: ["high_intensity_density", "low_specificity"],
        context_flags: ["high_intensity_density"]
      })
    })
  });
  const res = recorder();
  await handler({
    method: "POST",
    headers: { origin: "https://athlevo.org", "content-type": "application/json" },
    body: { message: "I want sub-20 for 5K. I recently ran 25:00, I run around 25km a week, and I usually do two interval sessions." }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.answer.primary_limiter.key, "excessive_intensity");
  assert.equal(res.body.answer.primary_limiter.label, "Intensity density");
  assert.equal(res.body.answer.show_checkout, true, "server still does not force show_checkout false");
  assert.equal(res.body.answer.next_action, "complete_diagnostic", "server may echo next_action; the client must ignore it");
  assert.equal(res.body.answer.suggested_question_key, "injury_status");
  assert.equal(res.body.answer.buyer_intent, "curious");
  assert.equal(res.body.answer.extracted_facts.weekly_mileage, 25);
}

{
  openAiImpl = async () => ({
    ok: true,
    json: async () => ({
      output_text: JSON.stringify({
        intent: "diagnostic_answer",
        next_action: "continue_diagnostic",
        reply: "Got it.",
        reply_2: null,
        extracted_facts: {
          goal_distance: null, goal_race: null, goal_race_date: null, goal_time: null,
          experience: null, training_status: null, weekly_mileage: null, weekly_hours: null,
          recent_consistency: null, recent_longest_run_km: null, recent_race_dist: null,
          recent_race_time: null, training_days: null, training_structure: null,
          training_structure_other: null, perceived_limiter: null, injury_has: null,
          injury_area: null, train_time: null, schedule_constraints: null, other_training: null
        },
        suggested_question_key: null,
        show_checkout: false,
        confidence: 0.4,
        pain_points: [],
        buyer_intent: "none",
        primary_limiter: { key: "speed", label: "Speed", why: "Need more speed." },
        secondary_limiter: { key: "endurance", label: "Endurance", why: "Need more endurance." },
        diagnostic_confidence: 9,
        diagnostic_summary: "n/a",
        recommended_direction: "unknown",
        expectation: { rating: "you_will_pr", text: "You will PR." },
        coach_concerns: ["recent_sickness", "not_real"],
        context_flags: ["late_fade", "invented"]
      })
    })
  });
  const res = recorder();
  await handler({
    method: "POST",
    headers: { origin: "https://athlevo.org", "content-type": "application/json" },
    body: { message: "I fade late." }
  }, res);
  assert.equal(res.body.answer.primary_limiter, null);
  assert.equal(res.body.answer.secondary_limiter, null);
  assert.equal(res.body.answer.diagnostic_confidence, null);
  assert.equal(res.body.answer.diagnostic_summary, null);
  assert.equal(res.body.answer.recommended_direction, null);
  assert.equal(res.body.answer.expectation, null);
  assert.deepEqual(res.body.answer.coach_concerns, ["recent_sickness"]);
  assert.deepEqual(res.body.answer.context_flags, ["late_fade"]);
}

assert.match(source, /primary limiting factor/i);
assert.match(source, /one primary limiter/i);
assert.match(source, /athlete-specific evidence/i);
assert.match(source, /generic laundry list/i);
assert.match(source, /does not diagnose injuries/i);
assert.match(source, /does not guarantee race results/i);
assert.match(source, /DIRECTION, NOT A FULL PLAN/);
assert.match(source, /Do not ask the next diagnostic question/);
assert.match(source, /You do NOT control checkout, signup, or payment/);
assert.match(source, /perceived limiter as supporting evidence only/i);
assert.match(source, /show_checkout must be false/);
assert.match(source, /primary_limiter: LIMITER_SCHEMA/);
assert.match(source, /diagnostic_confidence/);
assert.match(source, /coach_concerns/);
assert.match(source, /context_flags/);
assert.match(source, /ALLOWED_LIMITERS/);

{
  const { default: providersHandler } = await import("../api/providers/index.js?diagnostic-chat-providers");
  openAiImpl = async () => ({
    ok: true,
    json: async () => ({
      output_text: JSON.stringify({
        intent: "how_it_works",
        next_action: "recommend_athlevo",
        reply: "I'd build from your current 30 km weeks toward the marathon.",
        reply_2: "Want me to build it from here?",
        extracted_facts: {
          goal_distance: null, goal_race: null, goal_race_date: null, goal_time: null,
          experience: null, training_status: null, weekly_mileage: null, weekly_hours: null,
          recent_consistency: null, recent_longest_run_km: null, recent_race_dist: null,
          recent_race_time: null, training_days: null, training_structure: null,
          training_structure_other: null, perceived_limiter: null, injury_has: null,
          injury_area: null, train_time: null, schedule_constraints: null, other_training: null
        },
        suggested_question_key: null,
        show_checkout: false,
        confidence: 0.8,
        pain_points: [],
        buyer_intent: "curious"
      })
    })
  });
  openAiCalls = 0;
  const res = recorder();
  await providersHandler({
    method: "POST",
    headers: { origin: "https://athlevo.org", "content-type": "application/json" },
    query: { action: "diagnostic_chat" },
    body: {
      message: "How can you help me?",
      current_question_key: "experience",
      known_answers: { goal_distance: "Marathon", weekly_mileage: 30 }
    }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(openAiCalls, 1);
  assert.equal(res.body.answer.intent, "how_it_works");
}

globalThis.fetch = originalFetch;
console.log("PASS — diagnostic-chat API (structured output, fallback, CORS, no leaks)");
