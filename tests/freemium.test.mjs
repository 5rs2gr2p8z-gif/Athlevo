/*
 * Athlevo freemium contract.
 *
 * Executable checks cover entitlement and atomic free usage. Static assertions
 * bind the server gates and client flow to those helpers. Live Supabase/Whop
 * verification remains a deployment check.
 *
 * Run: node tests/freemium.test.mjs
 */

import { readFileSync } from "node:fs";
import {
  ACCESS_STATES,
  FEATURE_REGISTRY,
  resolveEntitlement
} from "../lib/server/features.js";
import {
  FREE_LIMITS,
  checkAccess,
  consumeFreeUsage
} from "../lib/server/freemium.js";

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

process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

const originalFetch = globalThis.fetch;

section("Entitlement states and Whop authority");
{
  const activeWhop = {
    provider: "whop",
    plan_id: "performance",
    status: "active",
    current_period_end: new Date(Date.now() + 86400000).toISOString()
  };
  const inactiveWhop = {
    provider: "whop",
    plan_id: "performance",
    status: "expired",
    current_period_end: new Date(Date.now() - 86400000).toISOString()
  };
  const forged = {
    provider: "manual",
    plan_id: "performance",
    status: "active",
    current_period_end: new Date(Date.now() + 86400000).toISOString()
  };

  test("missing subscription is free",
    resolveEntitlement(null).accessState === ACCESS_STATES.FREE);
  test("verified active Whop row is paid_active",
    resolveEntitlement(activeWhop).accessState === ACCESS_STATES.PAID_ACTIVE);
  test("inactive Whop row is paid_inactive",
    resolveEntitlement(inactiveWhop).accessState === ACCESS_STATES.PAID_INACTIVE);
  test("non-Whop row cannot grant paid access",
    resolveEntitlement(forged).accessState === ACCESS_STATES.FREE &&
    resolveEntitlement(forged).tier === 0);
  test("timed trial fields do not affect entitlement",
    !/trial_end|inTrial|trial_ended/.test(resolveEntitlement.toString()));
}

section("Feature allocation");
{
  [
    "today", "basic_trends", "training_calendar", "initial_plan",
    "readiness", "coach_chat", "coach_history", "provider_connection",
    "activity_import", "profile_settings"
  ].forEach(feature => {
    test(`${feature} is available on free`,
      FEATURE_REGISTRY[feature]?.minPlan === "free");
  });

  [
    "adaptive_ai", "workout_modifications", "additional_plan_generation",
    "weekly_analysis", "daily_brief", "advanced_trends",
    "premium_recommendations", "workout_analysis"
  ].forEach(feature => {
    test(`${feature} requires Performance`,
      FEATURE_REGISTRY[feature]?.minPlan === "performance");
  });
}

section("Atomic repeatable limits and persisted first-plan allowance");
{
  test("Coach limit is exactly 3 per week",
    FREE_LIMITS.coach_message.limit === 3 &&
    FREE_LIMITS.coach_message.period === "week");
  test("initial plan is not consumed through a pre-AI counter",
    !Object.prototype.hasOwnProperty.call(FREE_LIMITS, "initial_plan"));

  const counters = new Map();
  let subscription = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/rest/v1/subscriptions")) {
      return response(200, subscription ? [subscription] : []);
    }
    if (url.includes("/rpc/increment_rate_limit")) {
      const body = JSON.parse(init.body);
      const key = `${body.p_user_id}:${body.p_endpoint}:${body.p_window_start}`;
      const count = (counters.get(key) || 0) + 1;
      counters.set(key, count);
      return response(200, {
        allowed: count <= body.p_limit,
        current_count: count
      });
    }
    return response(404, {});
  };

  const access = await checkAccess("free-user");
  test("server resolves no subscription row as free",
    access.ok && access.accessState === ACCESS_STATES.FREE);

  const coach = [];
  for (let i = 0; i < 4; i += 1) {
    coach.push(await consumeFreeUsage("free-user", "coach_message"));
  }
  test("first three weekly Coach messages succeed",
    coach.slice(0, 3).every(result => result.allowed));
  test("fourth weekly Coach message is blocked",
    coach[3].allowed === false && coach[3].limit === 3);

  subscription = {
    provider: "whop",
    plan_id: "performance",
    status: "active",
    current_period_end: new Date(Date.now() + 86400000).toISOString()
  };
  const beforePaid = counters.size;
  const paid = await consumeFreeUsage("paid-user", "coach_message");
  test("paid user bypasses free usage counters",
    paid.allowed === true && paid.paid === true && counters.size === beforePaid);
}

globalThis.fetch = originalFetch;

section("Server enforcement wiring");
{
  const coach = readFileSync("./api/coach.js", "utf8");
  const plan = readFileSync("./api/training/generate-plan.js", "utf8");
  const week = readFileSync("./api/training/get-week.js", "utf8");
  const weekly = readFileSync("./api/training/weekly-analysis.js", "utf8");
  const brief = readFileSync("./api/daily-brief.js", "utf8");

  test("Coach consumes server-side coach_message usage before AI",
    /consumeFreeUsage\(\s*authenticatedUser\.id,\s*"coach_message"\s*\)/.test(coach) &&
    coach.search(/consumeFreeUsage\(\s*authenticatedUser\.id,\s*"coach_message"\s*\)/) <
      coach.indexOf('"https://api.openai.com/v1/responses"'));
  test("plan generation checks persisted plans before AI",
    /training_plans\?user_id=eq\./.test(plan) &&
    plan.indexOf("training_plans?user_id=eq.") <
      plan.indexOf("await generateWeeklyPlan"));
  test("plan generation never consumes a pre-AI lifetime counter",
    !/consumeFreeUsage\(\s*user\.id,\s*"initial_plan"/.test(plan) &&
    !/releaseFreeUsage/.test(plan));
  test("Daily Brief requires paid access before AI",
    brief.includes('requirePaidAccess(user.id, "daily_brief")'));
  test("weekly analysis requires paid access before analysis",
    weekly.includes('requirePaidAccess(user.id, "weekly_analysis")'));
  test("plan adjustments require paid access before writes",
    /requirePaidAccess\(\s*user\.id,\s*"workout_modifications"\s*\)/.test(week) &&
    week.search(/requirePaidAccess\(\s*user\.id,\s*"workout_modifications"\s*\)/) <
      week.indexOf('if (body.intent === "adaptive_preview")'));
}

section("Freemium onboarding, upgrade UI, and removed trial copy");
{
  const onboarding = readFileSync("./js/onboarding.js", "utf8");
  const connect = readFileSync("./js/onboardingConnect.js", "utf8");
  const planSetup = readFileSync("./js/planSetup.js", "utf8");
  const accessGuard = readFileSync("./js/accessGuard.js", "utf8");
  const index = readFileSync("./index.html", "utf8");
  const activeUi = [index, onboarding, connect, planSetup, accessGuard]
    .join("\n");

  const finish = onboarding.slice(
    onboarding.indexOf("async function obFinish"),
    onboarding.indexOf("function obFirstIncompleteStep")
  );
  test("onboarding hands off to provider connection, not paywall",
    /AthlevoConnect\.start/.test(finish) &&
    !/maybeLaunchAfterOnboarding|AthlevoPaywall|checkout/.test(finish));
  test("connection completion builds the first plan",
    /autoBuildFirstPlan/.test(connect));
  test("first-plan UI no longer checks paywall",
    !/shouldShowPaywall/.test(
      planSetup.slice(
        planSetup.indexOf("async function autoBuildFirstPlan"),
        planSetup.indexOf("async function autoBuildFirstPlan") + 700
      )));
  test("free Coach, Train, and Trends tabs are not blocked",
    /FREE_TABS/.test(accessGuard) &&
    /screen-coachai/.test(accessGuard) &&
    /screen-train/.test(accessGuard) &&
    /screen-trends/.test(accessGuard));
  test("landing primary CTA is Build My Training Plan",
    (index.match(/Build My Training Plan/g) || []).length >= 3);
  const inAppUi = [onboarding, connect, planSetup, accessGuard].join("\n");
  test("in-app UI contains no timed free-trial messaging",
    !/start\s+(?:my\s+)?(?:\d+[-\s]day\s+)?free\s+trial|3\s+days\s+free|after\s+(?:the\s+)?trial|trial\s+ends/i.test(inAppUi));
  test("landing contains the approved pricing disclosure exactly once",
    (index.match(/₱0 today, then ₱597\/month\. Cancel anytime before your trial ends\./g) || []).length === 1);
  test("the obsolete paywall screen and bundle are removed",
    !/screen-paywall|paywallBody|js\/paywall\.js|AthlevoPaywall/.test(activeUi));
  test("explicit upgrade UI names Athlevo Performance and ₱597/month",
    /Upgrade to Athlevo Performance/.test(accessGuard) &&
    /₱597\/month/.test(accessGuard));
  test("Whop opens only from the explicit upgrade handler",
    /function checkout\(\)/.test(accessGuard) &&
    /window\.open\(checkoutUrl\(\)/.test(accessGuard));
}

section("Privacy-safe analytics");
{
  const registry = readFileSync("./js/analyticsRegistry.js", "utf8");
  const webhook = readFileSync("./api/whop/webhook.js", "utf8");
  [
    "free_account_created", "onboarding_completed",
    "data_connection_completed", "first_plan_generated",
    "free_limit_reached", "upgrade_clicked", "checkout_opened",
    "paid_subscription_activated"
  ].forEach(event => {
    test(`analytics registry includes ${event}`, registry.includes(event));
  });
  test("paid activation comes from verified Whop webhook",
    webhook.includes('captureServerEvent(userId, "paid_subscription_activated"') &&
    webhook.indexOf("verifyWhopSignature") <
      webhook.indexOf('captureServerEvent(userId, "paid_subscription_activated"'));
  test("analytics registry prohibits sensitive content",
    /email/.test(registry) && /token/.test(registry) &&
    /workout/.test(registry) && /message/.test(registry));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
