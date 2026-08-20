/**
 * Athlevo Coach weekly allowance, error contract, upgrade handoff, and privacy.
 * Run: node tests/coach-limit.test.mjs
 */

import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.OPENAI_API_KEY = "openai-test";

const { default: coachHandler } = await import("../api/coach.js?coach-limit-test");
const {
  consumeFreeUsage
} = await import("../lib/server/freemium.js?coach-limit-test");

const coachSource = readFileSync("./js/coach.js", "utf8");
const registrySource = readFileSync("./js/analyticsRegistry.js", "utf8");

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
const section = name => console.log(`\n──── ${name} ────`);

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

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(value) { this.body = value; return this; }
  };
}

const structuredAnswer = JSON.stringify({
  response_type: "standard",
  headline: null,
  direct_answer: "Keep today controlled.",
  compliment: null,
  sections: [],
  mission: null,
  confidence: null,
  closing: null,
  suggested_replies: [],
  actions: []
});

function createWorld() {
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
      return token === "invalid"
        ? jsonResponse(401, {})
        : jsonResponse(200, { id: token });
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
          current_count: rateDenied ? 41 : 1
        });
      }
      const key = counterKey(body);
      const count = (freeCounters.get(key) || 0) + 1;
      freeCounters.set(key, count);
      return jsonResponse(200, {
        allowed: count <= body.p_limit,
        current_count: count
      });
    }

    if (url.includes("/rest/v1/ai_rate_limits")) {
      const endpointMatch = url.match(/endpoint=eq\.([^&]+)/);
      // The hourly limiter's aggregate query is separate from free usage.
      if (!endpointMatch) return jsonResponse(200, []);
      const userMatch = url.match(/user_id=eq\.([^&]+)/);
      const windowMatch = url.match(/window_start=eq\.([^&]+)/);
      const endpoint = decodeURIComponent(endpointMatch[1]);
      const userId = decodeURIComponent(userMatch?.[1] || "");
      const windowStart = decodeURIComponent(windowMatch?.[1] || "");
      const key = `${userId}:${endpoint}:${windowStart}`;
      const current = freeCounters.get(key);

      if (method === "GET") {
        return jsonResponse(
          200,
          current == null ? [] : [{ request_count: current }]
        );
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
        return jsonResponse(503, { error: { message: "private upstream detail" } });
      }
      return jsonResponse(200, { output_text: structuredAnswer });
    }

    return jsonResponse(404, {});
  }

  async function call(userId, body = {
    question: "How should I train today?",
    context: { profile: { goal: "5K" } }
  }) {
    const req = {
      method: "POST",
      headers: { authorization: `Bearer ${userId}` },
      body
    };
    const res = responseRecorder();
    await coachHandler(req, res);
    return res;
  }

  function freeCountFor(userId) {
    return [...freeCounters.entries()]
      .filter(([key]) => key.startsWith(`${userId}:free:coach_message:`))
      .reduce((sum, [, value]) => sum + value, 0);
  }

  return {
    fetchMock,
    call,
    subscriptions,
    freeCounters,
    freeCountFor,
    failModelOnce() { failNextModel = true; },
    denyRateLimit() { rateDenied = true; },
    modelCalls() { return modelCalls; }
  };
}

const originalFetch = globalThis.fetch;

section("Authoritative weekly allowance");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;
  const first = await world.call("free-user");
  const second = await world.call("free-user");
  const third = await world.call("free-user");
  const fourth = await world.call("free-user");

  test("free messages 1–3 succeed",
    [first, second, third].every(result => result.statusCode === 200));
  test("free message 4 is blocked with the categorical 402 contract",
    fourth.statusCode === 402 &&
    fourth.body?.code === "COACH_WEEKLY_LIMIT_REACHED" &&
    fourth.body?.limit === 3 &&
    fourth.body?.period === "week");
  test("blocked message 4 does not invoke the model",
    world.modelCalls() === 3);
  test("a blocked attempt does not inflate the successful-use count",
    world.freeCountFor("free-user") === 3);
}

section("Failure release, paid bypass, and concurrency");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;
  world.failModelOnce();
  const failedCall = await world.call("retry-user");
  const afterFailure = world.freeCountFor("retry-user");
  const retry = await world.call("retry-user");

  test("provider failure is explicit and not disguised as HTTP 200",
    failedCall.statusCode === 503 &&
    failedCall.body?.code === "COACH_PROVIDER_UNAVAILABLE");
  test("failed model request does not consume free allowance",
    afterFailure === 0 && world.freeCountFor("retry-user") === 1);
  test("retry after a failed model request remains allowed",
    retry.statusCode === 200);

  world.subscriptions.set("paid-user", {
    provider: "whop",
    plan_id: "performance",
    status: "active",
    current_period_end: "2099-01-01T00:00:00.000Z"
  });
  const paidResults = [];
  for (let i = 0; i < 5; i += 1) {
    paidResults.push(await world.call("paid-user"));
  }
  test("paid_active user bypasses the weekly free counter",
    paidResults.every(result => result.statusCode === 200) &&
    world.freeCountFor("paid-user") === 0);

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => world.call("concurrent-user"))
  );
  test("concurrent requests cannot exceed three successful free responses",
    concurrent.filter(result => result.statusCode === 200).length === 3 &&
    concurrent.filter(result => result.statusCode === 402).length === 1 &&
    world.freeCountFor("concurrent-user") === 3);
}

section("Authentication, input, context, and abuse-rate errors");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;
  const auth = await world.call("invalid");
  const invalid = await world.call("input-user", {
    question: "   ",
    context: { profile: {} }
  });
  const context = await world.call("context-user", {
    question: "How should I train?",
    context: null
  });
  world.denyRateLimit();
  const rate = await world.call("rate-user");

  test("authentication failure is an explicit 401 and never calls the model",
    auth.statusCode === 401 &&
    auth.body?.code === "AUTH_REQUIRED" &&
    world.modelCalls() === 0);
  test("invalid input is rejected before free usage",
    invalid.statusCode === 400 &&
    invalid.body?.code === "INVALID_COACH_MESSAGE" &&
    world.freeCountFor("input-user") === 0);
  test("missing athlete context is explicit and does not consume usage",
    context.statusCode === 422 &&
    context.body?.code === "COACH_CONTEXT_UNAVAILABLE" &&
    world.freeCountFor("context-user") === 0);
  test("abuse rate limiting is distinct from the free weekly limit",
    rate.statusCode === 429 &&
    rate.body?.code === "RATE_LIMITED" &&
    world.freeCountFor("rate-user") === 0);
}

section("Deterministic Manila-week reset");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;
  // Monday 00:00 in Manila is Sunday 16:00 UTC.
  const beforeReset = Date.parse("2026-08-02T15:59:59.000Z");
  const afterReset = Date.parse("2026-08-02T16:00:00.000Z");
  const before = [];
  for (let i = 0; i < 4; i += 1) {
    before.push(await consumeFreeUsage(
      "reset-user",
      "coach_message",
      beforeReset
    ));
  }
  const after = await consumeFreeUsage(
    "reset-user",
    "coach_message",
    afterReset
  );
  test("the fourth use is blocked before the Manila Monday boundary",
    before.slice(0, 3).every(result => result.allowed) &&
    before[3].allowed === false);
  test("a new allowance begins at Monday 00:00 Asia/Manila",
    after.allowed === true &&
    after.windowStart === "2026-08-02T16:00:00.000Z");
}

section("Client mapping, draft preservation, and duplicate taps");
{
  const classifyCoachFailure = new Function(
    `${extractFunction(coachSource, "classifyCoachFailure")}
     return classifyCoachFailure;`
  )();
  const limit = classifyCoachFailure("COACH_WEEKLY_LIMIT_REACHED", 402);
  const timeout = classifyCoachFailure("COACH_TIMEOUT", 504);
  const auth = classifyCoachFailure("AUTH_REQUIRED", 401);
  const server = classifyCoachFailure("COACH_REQUEST_FAILED", 500);
  const provider = classifyCoachFailure("COACH_PROVIDER_UNAVAILABLE", 503);
  const rate = classifyCoachFailure("RATE_LIMITED", 429);
  const invalid = classifyCoachFailure("INVALID_COACH_MESSAGE", 400);
  const context = classifyCoachFailure("COACH_CONTEXT_UNAVAILABLE", 422);
  test("only weekly/premium errors map to an upgrade",
    limit.upgrade === true &&
    timeout.upgrade !== true &&
    auth.upgrade !== true &&
    server.upgrade !== true &&
    provider.upgrade !== true &&
    rate.upgrade !== true &&
    invalid.upgrade !== true &&
    context.upgrade !== true);
  test("timeout, authentication, and server failures have specific copy",
    /too long/.test(timeout.message) &&
    /sign in/.test(auth.message) &&
    /complete that request/.test(server.message));

  const input = { value: "", tagName: "TEXTAREA" };
  const userMessage = { removed: false, remove() { this.removed = true; } };
  const loadingMessage = { removed: false, remove() { this.removed = true; } };
  const restoreCoachDraft = new Function(
    "document",
    "autoGrowComposer",
    `${extractFunction(coachSource, "restoreCoachDraft")}
     return restoreCoachDraft;`
  )(
    { getElementById: id => id === "chatInput" ? input : null },
    () => {}
  );
  restoreCoachDraft("Should I run today?", userMessage, loadingMessage);
  test("weekly-limit handling restores one draft and removes transient bubbles",
    input.value === "Should I run today?" &&
    userMessage.removed &&
    loadingMessage.removed);

  const sheetCalls = [];
  const analytics = [];
  const fakeWindow = {
    AthlevoAccessGuard: {
      showUpgradeSheet(...args) { sheetCalls.push(args); },
      closeUpgradeSheet() {}
    },
    AthlevoProductAnalytics: {
      trackAthlevoEvent(name, props) { analytics.push({ name, props }); }
    }
  };
  const showCoachLimitUpgrade = new Function(
    "window",
    "AthlevoAccessGuard",
    "AthlevoProductAnalytics",
    `${extractFunction(coachSource, "trackCoachEvent")}
     ${extractFunction(coachSource, "showCoachLimitUpgrade")}
     return showCoachLimitUpgrade;`
  )(
    fakeWindow,
    fakeWindow.AthlevoAccessGuard,
    fakeWindow.AthlevoProductAnalytics
  );
  showCoachLimitUpgrade("free");
  fakeWindow.AthlevoAccessGuard.closeUpgradeSheet();
  const copy = sheetCalls[0]?.[2] || {};
  test("weekly-limit response opens the reusable Coach upgrade sheet",
    sheetCalls.length === 1 &&
    sheetCalls[0][0] === "coach_message" &&
    sheetCalls[0][1] === "coach" &&
    copy.title === "Keep coaching with Athlevo Performance" &&
    copy.primary === "Upgrade to Performance" &&
    copy.secondary === "Not now");
  test("typed question remains after the sheet is dismissed",
    input.value === "Should I run today?");
  test("Coach delegates upgrade-sheet analytics to the visible sheet",
    analytics.length === 0 &&
    !/coach_upgrade_sheet_viewed/.test(
      extractFunction(coachSource, "showCoachLimitUpgrade")
    ));

  const claimCoachRequest = new Function(
    `${extractFunction(coachSource, "claimCoachRequest")}
     var coachRequestInFlight = false;
     return claimCoachRequest;`
  )();
  test("duplicate taps claim only one in-flight Coach request",
    claimCoachRequest() === true && claimCoachRequest() === false);
}

section("Entitlement loading and analytics privacy");
{
  const resolveCoachAccessState = new Function(
    "window",
    "AthlevoAccessGuard",
    "toast",
    `${extractFunction(coachSource, "resolveCoachAccessState")}
     return resolveCoachAccessState;`
  )(
    {
      AthlevoAccessGuard: {
        cachedAccessState: () => "unknown",
        accessState: async () => "unknown"
      }
    },
    {
      cachedAccessState: () => "unknown",
      accessState: async () => "unknown"
    },
    () => {}
  );
  test("unresolved entitlement remains unknown instead of becoming free",
    await resolveCoachAccessState() === "unknown");

  const registryRoot = {};
  new Function("window", "globalThis", "module", registrySource)(
    registryRoot,
    registryRoot,
    { exports: {} }
  );
  const registry = registryRoot.AthlevoAnalyticsRegistry;
  const coachEvents = [
    "coach_message_submitted",
    "coach_message_completed",
    "coach_weekly_limit_reached",
    "upgrade_sheet_viewed",
    "coach_request_failed"
  ];
  test("all categorical Coach events are registered",
    coachEvents.every(name => registry.isKnown(name)));
  test("Coach analytics discard message content and health data",
    coachEvents.every(name => {
      const safe = registry.sanitizeProps(name, {
        access_tier: "free",
        failure_category: "timeout",
        source_surface: "coach",
        message: "private question",
        pain: "private health signal",
        score: 72
      }) || {};
      return !("message" in safe) &&
        !("pain" in safe) &&
        !("score" in safe) &&
        Object.keys(safe).every(key =>
          ["access_tier", "failure_category", "source_surface"].includes(key));
    }));
}

section("dist/js sync — root cause verification");
{
  const distCoach = readFileSync("./dist/js/coach.js", "utf8");
  const distRegistry = readFileSync("./dist/js/analyticsRegistry.js", "utf8");
  const distAccessGuard = readFileSync("./dist/js/accessGuard.js", "utf8");
  const distFeatures = readFileSync("./dist/js/features.js", "utf8");

  // Root cause: dist had FREE_LIMIT_REACHED instead of COACH_WEEKLY_LIMIT_REACHED
  test("dist/js/coach.js uses COACH_WEEKLY_LIMIT_REACHED (not FREE_LIMIT_REACHED)",
    distCoach.includes("COACH_WEEKLY_LIMIT_REACHED") &&
    !distCoach.includes("FREE_LIMIT_REACHED"));

  test("dist/js/coach.js has classifyCoachFailure",
    distCoach.includes("function classifyCoachFailure("));
  test("dist/js/coach.js has resolveCoachAccessState",
    distCoach.includes("async function resolveCoachAccessState("));
  test("dist/js/coach.js has restoreCoachDraft",
    distCoach.includes("function restoreCoachDraft("));
  test("dist/js/coach.js has showCoachLimitUpgrade",
    distCoach.includes("function showCoachLimitUpgrade("));
  test("dist/js/coach.js has claimCoachRequest",
    distCoach.includes("function claimCoachRequest("));
  test("dist/js/coach.js has trackCoachEvent",
    distCoach.includes("function trackCoachEvent("));

  test("dist/js/coach.js saves user message only after success",
    (() => {
      const saveIdx = distCoach.indexOf("saveConversationMessage(\"user\"");
      const answerGuard = distCoach.lastIndexOf("if (data.answer)", saveIdx);
      return saveIdx > 0 && answerGuard > 0 && answerGuard < saveIdx;
    })());

  test("dist/js/analyticsRegistry.js has coach_weekly_limit_reached",
    distRegistry.includes("coach_weekly_limit_reached"));
  test("dist/js/analyticsRegistry.js has coach_message_submitted",
    distRegistry.includes("coach_message_submitted"));
  test("dist/js/analyticsRegistry.js has coach_request_failed",
    distRegistry.includes("coach_request_failed"));

  test("dist/js/accessGuard.js showUpgradeSheet accepts 3 params (feature, surface, copy)",
    distAccessGuard.includes("function showUpgradeSheet(feature, surface, copy)"));
  test("dist/js/accessGuard.js has configureUpgradeSheet",
    distAccessGuard.includes("function configureUpgradeSheet("));

  test("dist/js/features.js has loadFailed method",
    distFeatures.includes("loadFailed()"));

  // Verify source and dist are identical for coach.js
  test("dist/js/coach.js matches js/coach.js exactly",
    distCoach === coachSource);
  test("dist/js/analyticsRegistry.js matches js/analyticsRegistry.js exactly",
    distRegistry === registrySource);
}

section("Error response never leaks internal details");
{
  const world = createWorld();
  globalThis.fetch = world.fetchMock;
  world.failModelOnce();
  const res = await world.call("leak-user");
  const body = JSON.stringify(res.body || {});
  test("provider failure response body has no stack trace or provider key",
    !body.includes("openai") &&
    !body.includes("stack") &&
    !body.includes("api.openai.com") &&
    !body.includes("OPENAI_API_KEY") &&
    !body.includes("private upstream detail") &&
    res.body?.code === "COACH_PROVIDER_UNAVAILABLE");
}

globalThis.fetch = originalFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
