/*
 * Athlevo — executable cardless-trial enforcement tests
 *
 * Runs the real daily-brief and Coach action-apply handlers against an
 * in-memory HTTP/Supabase boundary. This is not a live Supabase test: the
 * deployed increment_trial_usage RPC still requires separate integration
 * verification.
 *
 * Run: node tests/cardless-trial-enforcement.test.mjs
 */

import { readFileSync } from "node:fs";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
process.env.OPENAI_API_KEY = "openai-test";

const dailyBriefHandler = (await import("../api/daily-brief.js")).default;
const getWeekHandler = (await import("../api/training/get-week.js")).default;

let passed = 0;
let failed = 0;
const test = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log("PASS — " + name);
  } else {
    failed += 1;
    console.log("FAIL — " + name + (detail ? `  [${detail}]` : ""));
  }
};
const section = name => console.log(`\n──── ${name} ────`);

function response(status, payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => text
  };
}

function apiResponse() {
  const result = { statusCode: null, body: null, headers: {} };
  result.status = code => {
    result.statusCode = code;
    return result;
  };
  result.json = body => {
    result.body = body;
    return result;
  };
  result.setHeader = (name, value) => {
    result.headers[name] = value;
  };
  return result;
}

function makeWorld({ subscriptions = {}, sessions = [] } = {}) {
  const state = {
    subscriptions,
    sessions: sessions.map(row => ({ ...row })),
    proposals: [],
    trialUsage: new Map(),
    trialRpcCalls: [],
    aiCalls: 0,
    writes: []
  };
  const tokens = {
    "token-active": "active-user",
    "token-expired": "expired-user",
    "token-none": "no-entitlement-user",
    "token-paid": "paid-user",
    "token-plan": "plan-user",
    "token-concurrent": "concurrent-user"
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();

    if (url.includes("/auth/v1/user")) {
      const bearer = String(init.headers?.Authorization || "")
        .replace(/^Bearer\s+/, "");
      const userId = tokens[bearer];
      return userId ? response(200, { id: userId }) : response(401, {});
    }

    if (url.includes("/rest/v1/rpc/increment_trial_usage")) {
      const body = JSON.parse(init.body || "{}");
      const key = `${body.p_user_id}:${body.p_usage_type}`;
      const current = state.trialUsage.get(key) || 0;
      const allowed = current < body.p_limit;
      if (allowed) state.trialUsage.set(key, current + 1);
      state.trialRpcCalls.push({
        userId: body.p_user_id,
        usageType: body.p_usage_type,
        allowed
      });
      return response(200, {
        allowed,
        current_count: allowed ? current + 1 : current,
        limit: body.p_limit
      });
    }

    if (url.includes("/rest/v1/rpc/increment_rate_limit")) {
      return response(200, { allowed: true, current_count: 1 });
    }

    if (url.startsWith("https://api.openai.com/")) {
      state.aiCalls += 1;
      return response(200, {
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              headline: "Training check-in",
              training_summary: "No recent activity was imported.",
              coach_observation: "More training data is needed.",
              recommendation: "Keep today easy.",
              reasoning: "Recovery information is limited.",
              data_limitations: ["No recent imported activities."]
            })
          }]
        }]
      });
    }

    const parsed = new URL(url);
    const marker = "/rest/v1/";
    const relative = parsed.pathname.slice(parsed.pathname.indexOf(marker) + marker.length);
    const table = relative.split("/")[0];

    if (table === "subscriptions" && method === "GET") {
      const userId = parsed.searchParams.get("user_id")?.replace(/^eq\./, "");
      const row = state.subscriptions[userId];
      return response(200, row ? [row] : []);
    }

    if (table === "ai_rate_limits" && method === "GET") {
      return response(200, []);
    }

    if (table === "profiles" && method === "GET") {
      const userId = parsed.searchParams.get("id")?.replace(/^eq\./, "");
      return response(200, [{ id: userId, goal: "general fitness" }]);
    }

    if (
      [
        "athlete_memory",
        "activities",
        "workout_execution_records",
        "activity_data_overrides",
        "daily_readiness",
        "daily_coach_briefings"
      ].includes(table) &&
      method === "GET"
    ) {
      return response(200, []);
    }

    if (table === "daily_coach_briefings" && method === "POST") {
      const row = { id: "brief-1", ...JSON.parse(init.body || "{}") };
      state.writes.push({ table, row });
      return response(201, [row]);
    }

    if (table === "coach_action_proposals" && method === "GET") {
      const userId = parsed.searchParams.get("user_id")?.replace(/^eq\./, "");
      const id = parsed.searchParams.get("id")?.replace(/^eq\./, "");
      return response(200, state.proposals.filter(row =>
        (!userId || row.user_id === userId) && (!id || row.id === id)
      ));
    }

    if (table === "coach_action_proposals" && method === "POST") {
      const incoming = JSON.parse(init.body || "{}");
      const row = { id: incoming.id || `proposal-${state.proposals.length + 1}`, ...incoming };
      const existing = state.proposals.find(item => item.id === row.id);
      if (existing) Object.assign(existing, row);
      else state.proposals.push(row);
      state.writes.push({ table, row: { ...row } });
      return response(201, [row]);
    }

    if (table === "training_sessions" && method === "GET") {
      const userId = parsed.searchParams.get("user_id")?.replace(/^eq\./, "");
      const id = parsed.searchParams.get("id")?.replace(/^eq\./, "");
      return response(200, state.sessions.filter(row =>
        (!userId || row.user_id === userId) && (!id || row.id === id)
      ));
    }

    if (table === "training_sessions" && method === "PATCH") {
      const userId = parsed.searchParams.get("user_id")?.replace(/^eq\./, "");
      const id = parsed.searchParams.get("id")?.replace(/^eq\./, "");
      const patch = JSON.parse(init.body || "{}");
      const matches = state.sessions.filter(row =>
        (!userId || row.user_id === userId) && (!id || row.id === id)
      );
      matches.forEach(row => Object.assign(row, patch));
      state.writes.push({ table, row: { id, user_id: userId, ...patch } });
      return response(200, matches);
    }

    return response(200, []);
  };

  return state;
}

async function callDaily(token, body = {}) {
  const res = apiResponse();
  await dailyBriefHandler({
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body
  }, res);
  return res;
}

async function callApply(token, proposal) {
  const res = apiResponse();
  await getWeekHandler({
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: { intent: "apply_coach_action", proposal }
  }, res);
  return res;
}

const future = new Date(Date.now() + 2 * 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();
const activeTrial = {
  provider: "athlevo_trial",
  status: "trialing",
  plan_id: "performance",
  trial_end: future,
  current_period_end: future
};
const expiredTrial = {
  provider: "athlevo_trial",
  status: "trialing",
  plan_id: "performance",
  trial_end: past,
  current_period_end: past
};
const paid = {
  provider: "whop",
  status: "active",
  plan_id: "performance",
  current_period_end: new Date(Date.now() + 30 * 86400000).toISOString()
};

section("EXECUTABLE — Daily Brief entitlement and usage");
{
  const world = makeWorld({
    subscriptions: {
      "active-user": activeTrial,
      "expired-user": expiredTrial,
      "paid-user": paid
    }
  });

  const expired = await callDaily("token-expired", {
    user_id: "paid-user",
    force: true
  });
  test("expired user is blocked before AI execution",
    expired.statusCode === 402 && world.aiCalls === 0,
    JSON.stringify(expired.body));

  const none = await callDaily("token-none", { user_id: "paid-user" });
  test("no-entitlement user is blocked before AI execution",
    none.statusCode === 402 && world.aiCalls === 0,
    JSON.stringify(none.body));

  const first = await callDaily("token-active", { user_id: "paid-user" });
  test("active trial receives one Daily Brief",
    first.statusCode === 200 && world.aiCalls === 1,
    JSON.stringify(first.body));

  const second = await callDaily("token-active");
  test("second Daily Brief on the same day is blocked",
    second.statusCode === 402 && world.aiCalls === 1,
    JSON.stringify(second.body));

  const paidFirst = await callDaily("token-paid");
  const paidSecond = await callDaily("token-paid");
  test("paid user bypasses the Daily Brief trial counter",
    paidFirst.statusCode === 200 &&
    paidSecond.statusCode === 200 &&
    !world.trialRpcCalls.some(call =>
      call.userId === "paid-user" && call.usageType === "daily_brief"
    ));

  test("request-body user_id is never used as the limiter identity",
    world.trialRpcCalls.some(call =>
      call.userId === "active-user" && call.usageType === "daily_brief"
    ) &&
    !world.trialRpcCalls.some(call => call.userId === "paid-user"));
}

section("EXECUTABLE — Confirmed Coach plan adjustment");
{
  const world = makeWorld({
    subscriptions: { "plan-user": activeTrial },
    sessions: [{
      id: "session-1",
      user_id: "plan-user",
      training_plan_id: "plan-1",
      session_date: "2026-07-30",
      session_type: "Easy",
      duration_minutes: 30
    }]
  });
  const firstProposal = {
    id: "coach-proposal-1",
    type: "modify_workout",
    target_session_id: "session-1",
    changes: { duration_minutes: 40 },
    reason: "Add a small progression."
  };
  const secondProposal = {
    ...firstProposal,
    id: "coach-proposal-2",
    changes: { duration_minutes: 45 }
  };

  const first = await callApply("token-plan", firstProposal);
  test("first confirmed plan adjustment succeeds",
    first.statusCode === 200 &&
    world.sessions[0].duration_minutes === 40,
    JSON.stringify(first.body));

  const writeCount = world.writes.length;
  const second = await callApply("token-plan", secondProposal);
  test("second confirmed plan adjustment is blocked before its write",
    second.statusCode === 402 &&
    world.sessions[0].duration_minutes === 40 &&
    world.writes.length === writeCount,
    JSON.stringify(second.body));
}

section("EXECUTABLE — Concurrent plan-adjustment requests");
{
  const world = makeWorld({
    subscriptions: { "concurrent-user": activeTrial },
    sessions: [{
      id: "session-c",
      user_id: "concurrent-user",
      training_plan_id: "plan-c",
      session_date: "2026-07-31",
      session_type: "Easy",
      duration_minutes: 30
    }]
  });
  const proposal = id => ({
    id,
    type: "modify_workout",
    target_session_id: "session-c",
    changes: { duration_minutes: id.endsWith("1") ? 35 : 40 }
  });
  const results = await Promise.all([
    callApply("token-concurrent", proposal("concurrent-1")),
    callApply("token-concurrent", proposal("concurrent-2"))
  ]);
  test("concurrent requests cannot both bypass the one-adjustment limit",
    results.filter(result => result.statusCode === 200).length === 1 &&
    results.filter(result => result.statusCode === 402).length === 1 &&
    world.writes.filter(write => write.table === "training_sessions").length === 1);
}

section("STATIC SOURCE ASSERTIONS — Discussion/generation does not consume adjustment");
{
  const coachSource = readFileSync("./api/coach.js", "utf8");
  const getWeekSource = readFileSync("./api/training/get-week.js", "utf8");
  test("Coach discussion consumes coach_message, not plan_adjustment",
    coachSource.includes('checkTrialLimit(authenticatedUser.id, "coach_message")') &&
    !coachSource.includes('checkTrialLimit(authenticatedUser.id, "plan_adjustment")'));
  test("plan_adjustment is consumed only by server-side apply handlers",
    getWeekSource.includes("async function handleApplyAction") &&
    getWeekSource.includes("async function handleAdaptiveApply") &&
    !getWeekSource.slice(
      getWeekSource.indexOf("async function handleAdaptivePreview"),
      getWeekSource.indexOf("async function handleAdaptiveApply")
    ).includes('checkTrialLimit(user.id, "plan_adjustment")'));
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
