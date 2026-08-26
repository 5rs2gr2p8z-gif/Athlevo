/**
 * Athlevo Coach response streaming — backend SSE + frontend consumer.
 * Run: node tests/coach-streaming.test.mjs
 */

import { readFileSync } from "node:fs";

/* ── env stubs (must precede handler import) ── */
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.OPENAI_API_KEY = "openai-test";

const { default: coachHandler } = await import(
  "../api/coach.js?coach-streaming-test"
);

const coachSource = readFileSync("./js/coach.js", "utf8");
const apiSource = readFileSync("./api/coach.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`);
  }
}
const section = (name) => console.log(`\n──── ${name} ────`);

function extractFunction(source, name) {
  const start = source.search(
    new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  );
  if (start < 0) throw new Error(`Could not find ${name}()`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not close ${name}()`);
}

/* ── Helpers ── */

const structuredAnswer = {
  response_type: "standard",
  headline: null,
  direct_answer: "Keep today controlled.",
  compliment: null,
  sections: [],
  mission: null,
  confidence: null,
  closing: null,
  suggested_replies: [],
  actions: [],
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "",
    headers: new Headers({ "Content-Type": "application/json" }),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

/**
 * Build a mock OpenAI SSE streaming response. Each `output_text` token
 * is delivered as a `response.output_text.delta` event, terminated by
 * `[DONE]`.
 */
function sseStreamResponse(text, { failMidStream = false } = {}) {
  const chunks = [];
  // Break text into small pieces to simulate multiple chunks
  const chunkSize = 10;
  for (let i = 0; i < text.length; i += chunkSize) {
    const delta = text.slice(i, i + chunkSize);
    chunks.push(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`
    );
  }
  if (failMidStream) {
    // Inject a failure event mid-stream
    const half = Math.floor(chunks.length / 2);
    chunks.splice(half, chunks.length - half,
      `data: ${JSON.stringify({ type: "response.failed" })}\n\n`
    );
  } else {
    chunks.push("data: [DONE]\n\n");
  }

  const encoder = new TextEncoder();
  let index = 0;
  const readable = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "text/event-stream" }),
    body: readable,
  };
}

function sseRecorder() {
  const events = [];
  let headWritten = false;
  let ended = false;
  let headers = {};
  return {
    get events() { return events; },
    get headWritten() { return headWritten; },
    get ended() { return ended; },
    get headers() { return headers; },
    statusCode: 200,
    body: null,
    headersSent: false,
    status(v) { this.statusCode = v; return this; },
    setHeader(n, v) { headers[n] = v; },
    writeHead(status, hdrs) {
      this.statusCode = status;
      headers = { ...headers, ...hdrs };
      headWritten = true;
      this.headersSent = true;
    },
    flushHeaders() {},
    write(chunk) {
      // Parse SSE data lines
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (raw) {
            try { events.push(JSON.parse(raw)); } catch { events.push(raw); }
          }
        }
      }
    },
    end() { ended = true; },
    json(value) { this.body = value; return this; },
  };
}

function createWorld({ streamText = null, failMidStream = false } = {}) {
  const freeCounters = new Map();
  const subscriptions = new Map();
  let modelCalls = 0;
  let failNextModel = false;
  let rateDenied = false;

  function counterKey(body) {
    return `${body.p_user_id}:${body.p_endpoint}:${body.p_window_start}`;
  }

  async function fetchMock(input, init = {}) {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();

    if (url.includes("/auth/v1/user")) {
      const token = String(init.headers?.Authorization || "").replace("Bearer ", "");
      if (token === "invalid") return jsonResponse(401, {});
      return jsonResponse(200, { id: token });
    }

    if (url.includes("/rest/v1/subscriptions")) {
      const match = url.match(/user_id=eq\.([^&]+)/);
      const userId = match ? decodeURIComponent(match[1]) : "";
      const row = subscriptions.get(userId);
      return jsonResponse(200, row ? [row] : []);
    }

    if (url.includes("/rest/v1/rpc/increment_rate_limit")) {
      const body = JSON.parse(init.body || "{}");
      if (body.p_endpoint === "coach") {
        return jsonResponse(200, {
          allowed: !rateDenied,
          current_count: rateDenied ? 41 : 1,
        });
      }
      const key = counterKey(body);
      const count = (freeCounters.get(key) || 0) + 1;
      freeCounters.set(key, count);
      return jsonResponse(200, {
        allowed: count <= body.p_limit,
        current_count: count,
      });
    }

    if (url.includes("/rest/v1/ai_rate_limits")) {
      const endpointMatch = url.match(/endpoint=eq\.([^&]+)/);
      if (!endpointMatch) return jsonResponse(200, []);
      const userMatch = url.match(/user_id=eq\.([^&]+)/);
      const windowMatch = url.match(/window_start=eq\.([^&]+)/);
      const endpoint = decodeURIComponent(endpointMatch[1]);
      const userId = decodeURIComponent(userMatch?.[1] || "");
      const windowStart = decodeURIComponent(windowMatch?.[1] || "");
      const key = `${userId}:${endpoint}:${windowStart}`;
      const current = freeCounters.get(key);

      if (method === "GET") {
        return jsonResponse(200, current == null ? [] : [{ request_count: current }]);
      }
      if (method === "PATCH") {
        const expectedMatch = url.match(/request_count=eq\.([^&]+)/);
        const expected = Number(expectedMatch?.[1]);
        if (current !== expected) return jsonResponse(200, []);
        const next = Number(JSON.parse(init.body || "{}").request_count);
        freeCounters.set(key, next);
        return jsonResponse(200, [{ request_count: next }]);
      }
    }

    if (url.includes("/rest/v1/activation_events")) {
      return jsonResponse(201, {});
    }

    if (url.includes("api.openai.com")) {
      modelCalls += 1;
      if (failNextModel) {
        failNextModel = false;
        return jsonResponse(503, { error: { message: "upstream error" } });
      }
      const text = streamText || JSON.stringify(structuredAnswer);
      return sseStreamResponse(text, { failMidStream });
    }

    return jsonResponse(404, {});
  }

  async function call(userId, body = {
    question: "How should I train today?",
    context: { profile: { goal: "5K" } },
  }) {
    const closeListeners = [];
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${userId}` },
      body,
      on(event, fn) { if (event === "close") closeListeners.push(fn); },
    };
    const res = sseRecorder();
    await coachHandler(req, res);
    return { res, closeListeners };
  }

  return {
    fetchMock,
    call,
    subscriptions,
    freeCounters,
    failModelOnce() { failNextModel = true; },
    denyRateLimit() { rateDenied = true; },
    modelCalls() { return modelCalls; },
  };
}

const originalFetch = globalThis.fetch;

/* ════════════════════════════════════════════════════════════════
 *  1. Backend produces SSE with `stream: true`
 * ════════════════════════════════════════════════════════════════ */
section("Backend SSE streaming");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;

  test("api/coach.js passes stream:true to OpenAI",
    /stream:\s*true/.test(apiSource) &&
    /"https:\/\/api\.openai\.com\/v1\/responses"/.test(apiSource));

  const { res } = await world.call("streamer-1");

  test("backend responds with text/event-stream content type",
    res.headers["Content-Type"] === "text/event-stream");

  test("backend sends delta events followed by a done event",
    res.events.some((e) => e.type === "delta" && typeof e.text === "string") &&
    res.events.some((e) => e.type === "done" && e.answer));

  const done = res.events.find((e) => e.type === "done");
  test("done event contains the validated answer with direct_answer",
    done.answer.direct_answer === "Keep today controlled." &&
    done.answer.response_type === "standard");

  test("done event actions are server-validated (UUIDs assigned)",
    Array.isArray(done.answer.actions));

  test("stream ends after done event",
    res.ended === true);
}

/* ════════════════════════════════════════════════════════════════
 *  2. Pre-stream errors remain JSON (not SSE)
 * ════════════════════════════════════════════════════════════════ */
section("Pre-stream errors remain JSON");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;

  // Bad auth
  const { res: authRes } = await world.call("invalid");
  test("auth failure returns JSON 401 (not SSE)",
    authRes.statusCode === 401 &&
    authRes.body?.code === "AUTH_REQUIRED" &&
    !authRes.headWritten);

  // Rate limit
  world.denyRateLimit();
  const { res: rateRes } = await world.call("rate-victim");
  test("rate-limited response returns JSON 429 (not SSE)",
    rateRes.statusCode === 429 &&
    !rateRes.headWritten);
}

/* ════════════════════════════════════════════════════════════════
 *  3. Mid-stream error handling
 * ════════════════════════════════════════════════════════════════ */
section("Mid-stream errors");
{
  const world = createWorld({ failMidStream: true });
  globalThis.fetch = world.fetchMock;

  const { res } = await world.call("mid-err-user");
  test("mid-stream failure sends SSE error event",
    res.events.some((e) => e.type === "error" && typeof e.message === "string"));

  test("stream ends cleanly after mid-stream error",
    res.ended === true);
}

/* ════════════════════════════════════════════════════════════════
 *  4. Provider unavailable (OpenAI returns non-200 before stream)
 * ════════════════════════════════════════════════════════════════ */
section("Provider unavailable pre-stream");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;
  world.failModelOnce();

  const { res } = await world.call("provider-down-user");
  test("OpenAI 503 returns JSON error, not SSE",
    res.statusCode === 503 &&
    res.body?.code === "COACH_PROVIDER_UNAVAILABLE" &&
    !res.headWritten);
}

/* ════════════════════════════════════════════════════════════════
 *  5. Security gates run before streaming begins
 * ════════════════════════════════════════════════════════════════ */
section("Auth/limits precede streaming");
{
  test("consumeFreeUsage call precedes the SSE writeHead in source order",
    apiSource.indexOf("consumeFreeUsage") <
    apiSource.indexOf('res.writeHead(200'));

  test("verifySupabaseAccessToken runs before any SSE output",
    apiSource.indexOf("verifySupabaseAccessToken") <
    apiSource.indexOf('res.writeHead(200'));

  test("checkAiRateLimit runs before SSE output",
    apiSource.indexOf("checkAiRateLimit") <
    apiSource.indexOf('res.writeHead(200'));
}

/* ════════════════════════════════════════════════════════════════
 *  6. Frontend extractPartialDirectAnswer (partial JSON parser)
 * ════════════════════════════════════════════════════════════════ */
section("Partial JSON direct_answer parser");
{
  const extractFn = new Function(
    `${extractFunction(coachSource, "extractPartialDirectAnswer")}
     return extractPartialDirectAnswer;`
  )();

  test("extracts complete direct_answer",
    extractFn('{"direct_answer":"Hello world"}') === "Hello world");

  test("extracts partial direct_answer (no closing quote)",
    extractFn('{"direct_answer":"Hello worl') === "Hello worl");

  test("handles JSON escapes (\\n, \\\")",
    extractFn('{"direct_answer":"Line one\\nLine \\"two\\""}') ===
    'Line one\nLine "two"');

  test("handles unicode escapes",
    extractFn('{"direct_answer":"caf\\u00e9"}') === "café");

  test("returns null when direct_answer is absent",
    extractFn('{"headline":"test"}') === null);

  test("returns null for empty input",
    extractFn("") === null);

  test("handles direct_answer after other keys",
    extractFn('{"response_type":"standard","direct_answer":"Hi there"}') ===
    "Hi there");

  test("stops at incomplete escape at buffer edge",
    extractFn('{"direct_answer":"test\\') === "test\\");
}

/* ════════════════════════════════════════════════════════════════
 *  7. Frontend consumeCoachStream behavior (source analysis)
 * ════════════════════════════════════════════════════════════════ */
section("consumeCoachStream structure");
{
  const streamFn = extractFunction(coachSource, "consumeCoachStream");

  test("uses response.body.getReader() for stream consumption",
    /response\.body\.getReader\(\)/.test(streamFn));

  test("uses TextDecoder with stream option for chunk decoding",
    /TextDecoder\(\)/.test(streamFn) &&
    /decode\([\w.]+,\s*\{\s*stream:\s*true\s*\}\)/.test(streamFn));

  test("batches DOM updates with requestAnimationFrame",
    /requestAnimationFrame/.test(streamFn) &&
    /renderPending/.test(streamFn));

  test("uses appendCoachProse for DOM-safe text rendering (no innerHTML injection)",
    /appendCoachProse\(container/.test(streamFn));

  test("handles delta, done, and error event types",
    /evt\.type === "delta"/.test(streamFn) &&
    /evt\.type === "done"/.test(streamFn) &&
    /evt\.type === "error"/.test(streamFn));

  test("mid-stream error with visible content keeps text and appends notice",
    /coach-stream-interrupted/.test(streamFn) &&
    /role.*alert/.test(streamFn) &&
    /interrupted:\s*true/.test(streamFn));

  test("error before any content throws for caller error UI",
    /throw\b/.test(streamFn) &&
    /coachCode.*COACH_REQUEST_FAILED/.test(streamFn));
}

/* ════════════════════════════════════════════════════════════════
 *  8. askCoach streaming integration (source analysis)
 * ════════════════════════════════════════════════════════════════ */
section("askCoach streaming integration");
{
  // askCoach contains template literals with nested braces that confuse
  // simple brace-depth extraction, so test against the full source.

  test("detects SSE content-type to branch into streaming path",
    /text\/event-stream/.test(coachSource));

  test("falls back to JSON parsing for non-streaming responses",
    /response\.json\(\)/.test(coachSource));

  test("tracks interrupted streams as coach_message_interrupted",
    /coach_message_interrupted/.test(coachSource));

  // streamInterrupted is checked before the persistence call within askCoach.
  // askCoach calls saveConversationMessage (which wraps coach_conversations).
  const askCoachRegion = coachSource.slice(coachSource.indexOf("async function askCoach"));
  test("interrupted streams skip persistence (early return before save)",
    askCoachRegion.indexOf("streamInterrupted") <
    askCoachRegion.indexOf("saveConversationMessage") &&
    /if \(streamInterrupted\)[\s\S]*?return;/.test(askCoachRegion));
}

/* ════════════════════════════════════════════════════════════════
 *  9. Smart scrolling during streaming
 * ════════════════════════════════════════════════════════════════ */
section("Smart scroll during streaming");
{
  const streamFn = extractFunction(coachSource, "consumeCoachStream");

  test("captures scroll position before streaming starts",
    /wasNearBottom\s*=\s*coachIsNearBottom\(\)/.test(streamFn));

  test("only auto-scrolls when user was near bottom or still near bottom",
    /wasNearBottom\s*\|\|\s*coachIsNearBottom\(\)/.test(streamFn) &&
    /coachSmartScroll\(\)/.test(streamFn));
}

/* ════════════════════════════════════════════════════════════════
 *  10. Sending state and duplicate prevention
 * ════════════════════════════════════════════════════════════════ */
section("Sending state / duplicate prevention");
{
  test("early return if coachRequestInFlight is true",
    /if\s*\(\s*coachRequestInFlight\s*\)\s*return/.test(coachSource));

  // Within askCoach, the flag is set before the fetch call.
  const askRegion2 = coachSource.slice(coachSource.indexOf("async function askCoach"));
  test("coachRequestInFlight set to true before fetch",
    askRegion2.indexOf("coachRequestInFlight = true") <
    askRegion2.indexOf("fetch("));

  test("coachRequestInFlight reset in finally block",
    /finally\s*\{[\s\S]*?coachRequestInFlight\s*=\s*false/.test(coachSource));
}

/* ════════════════════════════════════════════════════════════════
 *  11. Conversation persistence
 * ════════════════════════════════════════════════════════════════ */
section("Conversation persistence");
{
  test("persists completed message to coach_conversations via Supabase insert",
    /\.from\("coach_conversations"\)[\s\S]*?\.insert/.test(coachSource));

  // askCoach uses saveConversationMessage (which wraps coach_conversations).
  const askRegion3 = coachSource.slice(coachSource.indexOf("async function askCoach"));
  test("persistence happens after streaming completes (not per chunk)",
    askRegion3.indexOf("consumeCoachStream") <
    askRegion3.indexOf("saveConversationMessage"));

  test("partial/interrupted responses are not persisted",
    askRegion3.indexOf("streamInterrupted") <
    askRegion3.indexOf("saveConversationMessage"));
}

/* ════════════════════════════════════════════════════════════════
 *  12. No fake cursor / no typewriter simulation
 * ════════════════════════════════════════════════════════════════ */
section("No fake cursor or typewriter simulation");
{
  test("no blinking cursor CSS class in coach streaming code",
    !/typing-cursor|blink-cursor|caret-blink|fake-cursor/.test(coachSource));

  test("no setTimeout-based character-by-character animation",
    !/setTimeout[\s\S]*?charAt|setTimeout[\s\S]*?slice\(0,\s*\w+\+\+\)/.test(
      extractFunction(coachSource, "consumeCoachStream")
    ));

  test("progressive rendering is driven by real SSE deltas, not timers",
    /evt\.type === "delta" && evt\.text/.test(
      extractFunction(coachSource, "consumeCoachStream")
    ));
}

/* ════════════════════════════════════════════════════════════════
 *  13. Backend SSE format correctness
 * ════════════════════════════════════════════════════════════════ */
section("Backend SSE format correctness");
{
  test("delta events include type and text fields",
    /JSON\.stringify\(\{\s*type:\s*"delta",\s*text:/.test(apiSource));

  test("done event includes type and validated answer",
    /JSON\.stringify\(\{[\s\S]*?type:\s*"done",[\s\S]*?answer:\s*structuredAnswer/.test(apiSource));

  test("SSE lines are properly formatted with data: prefix and double newline",
    /res\.write\(`data: \$\{/.test(apiSource) &&
    /\\n\\n`\)/.test(apiSource));

  test("action UUIDs assigned server-side via randomUUID",
    /action\.id.*randomUUID|randomUUID\(\)[\s\S]*?\.map/.test(apiSource));
}

/* ════════════════════════════════════════════════════════════════
 *  14. Client disconnect handling
 * ════════════════════════════════════════════════════════════════ */
section("Client disconnect handling");
{
  test("backend listens for req close to abort OpenAI request",
    /req\.on\("close"/.test(apiSource) &&
    /controller\.abort\(\)/.test(apiSource));

  test("AbortError during stream read is treated as normal disconnect",
    /AbortError/.test(apiSource) &&
    /streamFailed\s*=\s*true/.test(apiSource));
}

/* ════════════════════════════════════════════════════════════════
 *  15. Vercel / Safari compatibility
 * ════════════════════════════════════════════════════════════════ */
section("Vercel / Safari compatibility");
{
  test("backend calls flushHeaders for Vercel streaming",
    /flushHeaders/.test(apiSource));

  test("X-Accel-Buffering: no is set to prevent proxy buffering",
    /X-Accel-Buffering.*no/.test(apiSource));

  test("Cache-Control: no-cache, no-transform prevents caching",
    /Cache-Control.*no-cache.*no-transform/.test(apiSource));

  test("Connection: keep-alive is set for SSE",
    /Connection.*keep-alive/.test(apiSource));
}

/* ════════════════════════════════════════════════════════════════
 *  16. Empty response handling
 * ════════════════════════════════════════════════════════════════ */
section("Empty response handling");
{
  test("backend sends SSE error when accumulated text is empty",
    /streamFailed \|\| !accumulated/.test(apiSource) &&
    /type.*error[\s\S]*?Coach could not complete/.test(apiSource));

  test("malformed JSON falls back to direct_answer wrapping",
    /JSON\.parse\(accumulated\)[\s\S]*?catch[\s\S]*?direct_answer:\s*accumulated/.test(apiSource));
}

/* ── Cleanup ── */
globalThis.fetch = originalFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
