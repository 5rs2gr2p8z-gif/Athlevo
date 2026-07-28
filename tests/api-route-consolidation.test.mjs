/*
 * Athlevo — serverless route consolidation tests
 *
 * Exercises the consolidated trial route and dispatcher contracts. Supabase
 * and PostHog are in-memory HTTP doubles; live Vercel/Supabase routing remains
 * an integration check.
 *
 * Run: node tests/api-route-consolidation.test.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
process.env.POSTHOG_KEY = "posthog-test";
delete process.env.WEARABLE_TERRA_ENABLED;

const trialHandler = (await import("../api/trial.js")).default;
const stravaHandler = (await import("../api/strava.js")).default;
const trainingInsightsHandler =
  (await import("../api/training/insights.js")).default;
const providersHandler = (await import("../api/providers/index.js")).default;

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

function deployableFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...deployableFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(path);
  }
  return out.sort();
}

function apiResponse() {
  const result = { code: null, body: null, headers: {} };
  result.status = code => {
    result.code = code;
    return result;
  };
  result.json = body => {
    result.body = body;
    return result;
  };
  result.setHeader = (name, value) => {
    result.headers[name] = value;
  };
  result.end = () => result;
  return result;
}

function httpResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () =>
      typeof payload === "string" ? payload : JSON.stringify(payload)
  };
}

section("Deployable function inventory");
{
  const files = deployableFiles("api");
  test("api contains exactly 12 deployable JavaScript files",
    files.length === 12,
    files.join(", "));
  test("Whop webhook remains a dedicated deployable route",
    files.includes(join("api", "whop", "webhook.js")));
  test("removed route files no longer deploy separately",
    !files.some(file =>
      /trial\/(start|entitlement)\.js$/.test(file) ||
      /strava\/(connect|sync)\.js$/.test(file) ||
      /training\/(check-in|weekly-analysis)\.js$/.test(file) ||
      /terra\/index\.js$/.test(file)
    ));
}

section("Consolidated GET/POST /api/trial");
{
  const requests = [];
  let startCalls = 0;
  let analyticsCalls = 0;
  const trialEnd = new Date(Date.now() + 2 * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });

    if (url.includes("/auth/v1/user")) {
      const authorization = init.headers?.Authorization;
      return authorization === "Bearer verified-token"
        ? httpResponse(200, { id: "verified-user" })
        : httpResponse(401, {});
    }

    if (url.includes("/rest/v1/subscriptions")) {
      return httpResponse(200, [{
        user_id: "verified-user",
        provider: "athlevo_trial",
        status: "trialing",
        plan_id: "performance",
        trial_end: trialEnd,
        current_period_end: trialEnd
      }]);
    }

    if (url.includes("/rest/v1/trial_usage")) {
      return httpResponse(200, [{
        user_id: "verified-user",
        plans_generated: 1,
        plan_adjustments: 0,
        coach_messages_today: 2,
        coach_messages_date: today,
        ai_analyses_today: 1,
        ai_analyses_date: today,
        daily_briefs_today: 1,
        daily_briefs_date: today
      }]);
    }

    if (url.includes("/rest/v1/rpc/start_cardless_trial")) {
      startCalls += 1;
      return httpResponse(200, startCalls === 1
        ? {
            created: true,
            status: "trialing",
            trial_end: trialEnd,
            plan_id: "performance"
          }
        : {
            created: false,
            reason: "already_started",
            status: "trialing",
            trial_end: trialEnd,
            plan_id: "performance"
          });
    }

    if (url.includes("posthog.com/capture")) {
      analyticsCalls += 1;
      return httpResponse(200, { ok: true });
    }

    return httpResponse(404, {});
  };

  const getResponse = apiResponse();
  await trialHandler({
    method: "GET",
    headers: { authorization: "Bearer verified-token" }
  }, getResponse);
  test("GET returns normalized active-trial entitlement",
    getResponse.code === 200 &&
    getResponse.body.access_state === "trial_active" &&
    getResponse.body.trial_limits.daily_brief === 1 &&
    getResponse.body.trial_usage.daily_briefs_today === 1,
    JSON.stringify(getResponse.body));

  const firstStart = apiResponse();
  await trialHandler({
    method: "POST",
    headers: { authorization: "Bearer verified-token" },
    body: { user_id: "attacker-supplied-user" }
  }, firstStart);
  test("POST starts a new trial",
    firstStart.code === 200 && firstStart.body.created === true);

  const secondStart = apiResponse();
  await trialHandler({
    method: "POST",
    headers: { authorization: "Bearer verified-token" },
    body: { user_id: "attacker-supplied-user" }
  }, secondStart);
  test("POST replay remains idempotent",
    secondStart.code === 200 &&
    secondStart.body.created === false &&
    secondStart.body.access_state === "trial_active");

  const rpcRequests = requests.filter(request =>
    request.url.includes("/rest/v1/rpc/start_cardless_trial")
  );
  test("trial RPC identity comes from the verified JWT",
    rpcRequests.length === 2 &&
    rpcRequests.every(request =>
      JSON.parse(request.init.body).p_user_id === "verified-user"
    ));
  test("service role remains isolated to server-side database requests",
    requests
      .filter(request => request.url.includes("/rest/v1/"))
      .every(request =>
        request.init.headers?.Authorization === "Bearer service-test"
      ));
  test("trial_started analytics fires only for created:true",
    analyticsCalls === 1);

  const noAuth = apiResponse();
  await trialHandler({ method: "GET", headers: {} }, noAuth);
  test("trial route still requires JWT auth", noAuth.code === 401);

  const wrongMethod = apiResponse();
  await trialHandler({ method: "DELETE", headers: {} }, wrongMethod);
  test("trial route rejects unsupported methods with clear Allow header",
    wrongMethod.code === 405 &&
    wrongMethod.headers.Allow === "GET, POST");
}

section("Closely related route dispatchers");
{
  const stravaConnect = apiResponse();
  await stravaHandler({
    method: "GET",
    query: { action: "connect" },
    headers: {}
  }, stravaConnect);
  test("Strava connect action reaches the original POST-only handler",
    stravaConnect.code === 405 && stravaConnect.headers.Allow === "POST");

  const stravaSync = apiResponse();
  await stravaHandler({
    method: "GET",
    query: { action: "sync" },
    headers: {}
  }, stravaSync);
  test("Strava sync action reaches the original POST-only handler",
    stravaSync.code === 405 && stravaSync.headers.Allow === "POST");

  const weeklyPost = apiResponse();
  await trainingInsightsHandler({
    method: "POST",
    query: { action: "weekly-analysis" },
    headers: {}
  }, weeklyPost);
  test("weekly-analysis retains its GET-only method contract",
    weeklyPost.code === 405 && weeklyPost.headers.Allow === "GET");

  const checkInNoAuth = apiResponse();
  await trainingInsightsHandler({
    method: "GET",
    query: { action: "check-in" },
    headers: {}
  }, checkInNoAuth);
  test("check-in retains its JWT requirement",
    checkInNoAuth.code === 401);

  const terraDisabled = apiResponse();
  await providersHandler({
    method: "GET",
    query: { provider: "terra" },
    headers: {}
  }, terraDisabled);
  test("dormant Terra route preserves disabled response",
    terraDisabled.code === 404 &&
    terraDisabled.body.code === "TERRA_DISABLED");

  process.env.WEARABLE_TERRA_ENABLED = "true";
  const terraEnabled = apiResponse();
  await providersHandler({
    method: "GET",
    query: { provider: "terra" },
    headers: {}
  }, terraEnabled);
  delete process.env.WEARABLE_TERRA_ENABLED;
  test("dormant Terra route preserves enabled-but-unconfigured response",
    terraEnabled.code === 503 &&
    terraEnabled.body.code === "TERRA_NOT_CONFIGURED");
}

section("Static isolation assertions");
{
  const whop = readFileSync("./api/whop/webhook.js", "utf8");
  const trial = readFileSync("./api/trial.js", "utf8");
  const strava = readFileSync("./api/strava.js", "utf8");
  const insights = readFileSync("./api/training/insights.js", "utf8");
  test("Whop webhook was not combined with user-facing gateways",
    whop.includes("verifyWhopSignature") &&
    !trial.includes("verifyWhopSignature") &&
    !strava.includes("verifyWhopSignature") &&
    !insights.includes("verifyWhopSignature"));
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
