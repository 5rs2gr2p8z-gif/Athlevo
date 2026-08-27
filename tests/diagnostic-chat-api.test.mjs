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

{
  assert.doesNotMatch(source, /checkout\(|paymongo|whop/i);
}

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
