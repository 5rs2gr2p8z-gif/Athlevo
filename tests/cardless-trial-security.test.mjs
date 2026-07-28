/*
 * Athlevo — Cardless Trial Security Tests
 *
 * Proves the 10 security invariants required by the trial spec:
 *   1. Frontend cannot create or extend a trial
 *   2. Onboarding replay does not create duplicate trials
 *   3. Browser time does not extend server-controlled access
 *   4. Expired trial cannot call AI endpoints
 *   5. Parallel requests cannot exceed atomic limits
 *   6. Cross-account isolation
 *   7. Free user cannot mark themselves paid
 *   8. Whop webhook still required for paid access
 *   9. Server-time based expiry (no client-supplied dates)
 *  10. Stale sessions see correct expired state
 *
 * Run: node tests/cardless-trial-security.test.mjs
 */

import { readFileSync } from "node:fs";
import {
  resolveAccessState,
  ACCESS_STATES,
  TRIAL_LIMITS,
  isPremium,
  SUBSCRIPTIONS_HELPER_VERSION
} from "../lib/server/subscriptions.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

// Source files for static analysis
const trialStartSrc     = readFileSync("./api/trial.js", "utf8");
const entitlementSrc    = trialStartSrc;
const coachSrc          = readFileSync("./api/coach.js", "utf8");
const generatePlanSrc   = readFileSync("./api/training/generate-plan.js", "utf8");
const weeklyAnalysisSrc = readFileSync("./lib/server/training/weekly-analysis-route.js", "utf8");
const dailyBriefSrc      = readFileSync("./api/daily-brief.js", "utf8");
const getWeekSrc         = readFileSync("./api/training/get-week.js", "utf8");
const trialLimitsSrc    = readFileSync("./lib/server/trialLimits.js", "utf8");
const subscriptionsSrc  = readFileSync("./lib/server/subscriptions.js", "utf8");
const migrationSrc      = readFileSync("./migrations/2026-07-27_cardless_trial.sql", "utf8");
const featuresSrc       = readFileSync("./js/features.js", "utf8");
const onboardingSrc     = readFileSync("./js/onboarding.js", "utf8");
const accessGuardSrc    = readFileSync("./js/accessGuard.js", "utf8");
const planSetupSrc      = readFileSync("./js/planSetup.js", "utf8");
const trialBannerSrc    = readFileSync("./js/trialBanner.js", "utf8");
const webhookSrc        = readFileSync("./api/whop/webhook.js", "utf8");


/* ══════════════════════════════════════════════════════════════════════
 * 1. Frontend cannot create or extend a trial
 * ══════════════════════════════════════════════════════════════════════ */
section("1 — Frontend cannot create or extend a trial");

t("Trial start endpoint uses bearer token auth, not request body user_id",
  trialStartSrc.includes("getBearerToken(req)") &&
  trialStartSrc.includes("getAuthenticatedUser(token)") &&
  !trialStartSrc.includes("req.body.user_id"));

t("Trial start RPC uses verified user.id from token",
  trialStartSrc.includes("p_user_id: user.id"));

t("Trial start does not accept trial_end or trial_days from request body",
  !trialStartSrc.includes("req.body.trial_end") &&
  !trialStartSrc.includes("req.body.trial_days") &&
  !trialStartSrc.includes("req.body.duration"));

t("Database RPC start_cardless_trial is SECURITY DEFINER (owns its own privileges)",
  migrationSrc.includes("SECURITY DEFINER") &&
  migrationSrc.includes("start_cardless_trial"));

t("Database RPC sets trial_end server-side (now() + interval '3 days')",
  migrationSrc.includes("now() + interval '3 days'"));

t("Frontend features.js does not write to subscriptions table directly",
  !featuresSrc.includes("/rest/v1/subscriptions") ||
  (featuresSrc.includes("/rest/v1/subscriptions") && !featuresSrc.includes("method: \"POST\"") && !featuresSrc.includes("method: \"PATCH\"")));

t("Frontend features.js uses consolidated GET/POST /api/trial",
  featuresSrc.includes('fetch("/api/trial"') &&
  !featuresSrc.includes("/api/trial/start") &&
  !featuresSrc.includes("/api/trial/entitlement"));

t("Database RPC REVOKE ALL FROM PUBLIC",
  migrationSrc.includes("REVOKE ALL ON FUNCTION") && migrationSrc.includes("start_cardless_trial"));


/* ══════════════════════════════════════════════════════════════════════
 * 2. Onboarding replay protection (idempotent trial creation)
 * ══════════════════════════════════════════════════════════════════════ */
section("2 — Onboarding replay does not create duplicate trials");

t("Database RPC checks for existing subscription with FOR UPDATE lock",
  migrationSrc.includes("FOR UPDATE") &&
  migrationSrc.includes("SELECT") &&
  migrationSrc.includes("subscriptions"));

t("Database RPC checks subscription_events for prior trial",
  migrationSrc.includes("subscription_events") &&
  migrationSrc.includes("cardless_trial_started"));

t("Database RPC returns existing trial info on replay (not a new trial)",
  migrationSrc.includes("created := false") ||
  migrationSrc.includes("'created', false"));

t("API returns created=false for idempotent replay",
  trialStartSrc.includes("created: result.created"));

t("Server emits trial_started only when created is exactly true",
  trialStartSrc.includes("result && result.created === true"));

t("Onboarding replay continues without emitting trial_started",
  onboardingSrc.includes("showTrialConfirmation(trialResult.created === true)") &&
  onboardingSrc.includes("if (isNewTrial)"));

t("Onboarding calls startCardlessTrial (which calls the idempotent API)",
  onboardingSrc.includes("startCardlessTrial") ||
  onboardingSrc.includes("AthlevoPlan.startCardlessTrial"));

t("Failed onboarding trial start shows retry instead of launching a paywall",
  onboardingSrc.includes("showTrialStartError(trialResult)") &&
  onboardingSrc.includes('id="obTrialRetry"') &&
  !onboardingSrc.slice(
    onboardingSrc.indexOf("async function obFinish"),
    onboardingSrc.indexOf("function showTrialConfirmation")
  ).includes("AthlevoPaywall"));

t("Only the explicitly paid path may use the legacy post-onboarding launcher",
  (() => {
    const flow = onboardingSrc.slice(
      onboardingSrc.indexOf("async function obStartCardlessTrial"),
      onboardingSrc.indexOf("function showTrialStartError")
    );
    return flow.indexOf('trialResult.access_state === "paid_active"') <
      flow.indexOf("maybeLaunchAfterOnboarding");
  })());

t("Successful POST seeds entitlement before refresh can fall back to paywall",
  featuresSrc.indexOf("serverEntitlement = {") <
    featuresSrc.indexOf("await loadSubscription()", featuresSrc.indexOf("async function startCardlessTrial")));

t("Client preserves the exact trial API status and public error",
  featuresSrc.includes("status: res.status") &&
  featuresSrc.includes("(result && result.error)"));


/* ══════════════════════════════════════════════════════════════════════
 * 3. Browser time does not extend server-controlled access
 * ══════════════════════════════════════════════════════════════════════ */
section("3 — Browser time does not extend access");

t("resolveAccessState uses server now parameter, not browser Date",
  subscriptionsSrc.includes("resolveAccessState(subscriptionRow, now = Date.now())"));

t("Entitlement endpoint returns server-calculated trial_seconds_remaining",
  entitlementSrc.includes("trial_seconds_remaining") ||
  subscriptionsSrc.includes("trial_seconds_remaining"));

{
  // Simulate: trial_end is in the past by server time, but a lying client would claim it's valid
  const pastRow = {
    provider: "athlevo_trial",
    status: "trialing",
    plan_id: "performance",
    trial_end: new Date(Date.now() - 60_000).toISOString(), // expired 1 min ago
    current_period_end: new Date(Date.now() + 86400_000).toISOString()
  };
  const state = resolveAccessState(pastRow);
  t("Expired trial returns expired_limited, not trial_active",
    state.access_state === ACCESS_STATES.EXPIRED_LIMITED);
  t("Expired trial has tier 0",
    state.tier === 0);
}

{
  // Active trial with server time in range
  const activeRow = {
    provider: "athlevo_trial",
    status: "trialing",
    plan_id: "performance",
    trial_end: new Date(Date.now() + 86400_000 * 2).toISOString(), // 2 days left
    current_period_end: new Date(Date.now() + 86400_000 * 2).toISOString()
  };
  const state = resolveAccessState(activeRow);
  t("Active trial returns trial_active",
    state.access_state === ACCESS_STATES.TRIAL_ACTIVE);
  t("Active trial has tier > 0",
    state.tier > 0);
  t("Active trial includes trial_limits",
    state.trial_limits && state.trial_limits.coach_message === 5);
}

t("Trial banner uses server-provided expiry for display (not browser time alone)",
  trialBannerSrc.includes("accessState()") &&
  trialBannerSrc.includes("trial_ends_at"));


/* ══════════════════════════════════════════════════════════════════════
 * 4. Expired trial cannot call AI endpoints
 * ══════════════════════════════════════════════════════════════════════ */
section("4 — Expired trial blocked from AI endpoints");

t("Coach endpoint imports and calls checkTrialLimit before processing",
  coachSrc.includes("checkTrialLimit") &&
  coachSrc.includes("trialLimitResponse"));

t("Generate plan endpoint imports and calls checkTrialLimit",
  generatePlanSrc.includes("checkTrialLimit") &&
  generatePlanSrc.includes("trialLimitResponse"));

t("Weekly analysis endpoint imports and calls checkTrialLimit",
  weeklyAnalysisSrc.includes("checkTrialLimit") &&
  weeklyAnalysisSrc.includes("trialLimitResponse"));

t("Daily Brief derives identity from verified JWT and enforces daily_brief",
  dailyBriefSrc.includes("getAuthenticatedUser(accessToken)") &&
  dailyBriefSrc.includes('checkTrialLimit(user.id, "daily_brief")') &&
  !dailyBriefSrc.includes("req.body.user_id"));

t("Confirmed Coach action enforces plan_adjustment before its first write",
  getWeekSrc.includes('checkTrialLimit(user.id, "plan_adjustment")') &&
  getWeekSrc.indexOf('checkTrialLimit(user.id, "plan_adjustment")') <
    getWeekSrc.indexOf('"coach_action_proposals?on_conflict=id"'));

t("trialLimits.js blocks expired trial users",
  trialLimitsSrc.includes("isExpired") &&
  trialLimitsSrc.includes("allowed: false"));

t("Trial limit response returns 402 status",
  trialLimitsSrc.includes("res.status(402)"));

t("Trial limit response includes trial_limit_reached flag",
  trialLimitsSrc.includes("trial_limit_reached: true"));

t("Explicit trial limits include one Daily Brief per day and one lifetime adjustment",
  TRIAL_LIMITS.daily_brief === 1 &&
  TRIAL_LIMITS.plan_adjustment === 1);


/* ══════════════════════════════════════════════════════════════════════
 * 5. Parallel requests cannot exceed atomic limits
 * ══════════════════════════════════════════════════════════════════════ */
section("5 — Parallel request atomic limits");

t("Trial usage increment uses atomic Postgres RPC (not client-side counter)",
  trialLimitsSrc.includes("increment_trial_usage"));

t("Database RPC increment_trial_usage uses FOR UPDATE row lock",
  migrationSrc.includes("increment_trial_usage") &&
  migrationSrc.includes("FOR UPDATE"));

t("Trial limits fail closed on error (not fail-open)",
  trialLimitsSrc.includes("allowed: false") &&
  trialLimitsSrc.includes("Could not check usage limits") &&
  trialLimitsSrc.includes("Could not verify"));

t("Database start_cardless_trial also uses FOR UPDATE (prevents parallel creation)",
  migrationSrc.includes("start_cardless_trial") &&
  migrationSrc.includes("FOR UPDATE"));


/* ══════════════════════════════════════════════════════════════════════
 * 6. Cross-account isolation
 * ══════════════════════════════════════════════════════════════════════ */
section("6 — Cross-account isolation");

t("RLS enabled on trial_usage table",
  migrationSrc.includes("ALTER TABLE trial_usage ENABLE ROW LEVEL SECURITY") ||
  migrationSrc.includes("ENABLE ROW LEVEL SECURITY"));

t("trial_usage RLS policy restricts to own user_id",
  migrationSrc.includes("auth.uid()") &&
  migrationSrc.includes("trial_usage"));

{
  // Two different users should get independent states
  const user1Row = {
    provider: "athlevo_trial", status: "trialing", plan_id: "performance",
    trial_end: new Date(Date.now() + 86400_000).toISOString(),
    current_period_end: new Date(Date.now() + 86400_000).toISOString()
  };
  const user2Row = {
    provider: "athlevo_trial", status: "trialing", plan_id: "performance",
    trial_end: new Date(Date.now() - 86400_000).toISOString(), // expired
    current_period_end: new Date(Date.now() - 86400_000).toISOString()
  };
  const s1 = resolveAccessState(user1Row);
  const s2 = resolveAccessState(user2Row);
  t("Independent subscription rows resolve independently",
    s1.access_state === ACCESS_STATES.TRIAL_ACTIVE &&
    s2.access_state === ACCESS_STATES.EXPIRED_LIMITED);
}


/* ══════════════════════════════════════════════════════════════════════
 * 7. Free user cannot mark themselves paid
 * ══════════════════════════════════════════════════════════════════════ */
section("7 — Free user cannot mark themselves paid");

{
  const noSub = resolveAccessState(null);
  t("Null subscription → NO_ENTITLEMENT (not paid)",
    noSub.access_state === ACCESS_STATES.NO_ENTITLEMENT);
  t("Null subscription → tier 0",
    noSub.tier === 0);
  t("Null subscription → isPremium false",
    isPremium(null) === false);
}

{
  // A row with provider=athlevo_trial but manually set status=active should NOT grant paid
  const fakeRow = {
    provider: "athlevo_trial", status: "active", plan_id: "performance",
    trial_end: new Date(Date.now() - 86400_000).toISOString(),
    current_period_end: new Date(Date.now() - 86400_000).toISOString()
  };
  const state = resolveAccessState(fakeRow);
  t("athlevo_trial provider with expired trial_end → not trial_active or paid_active",
    state.access_state !== ACCESS_STATES.TRIAL_ACTIVE &&
    state.access_state !== ACCESS_STATES.PAID_ACTIVE);
}

t("Entitlement endpoint authenticates via bearer token",
  entitlementSrc.includes("getBearerToken") || entitlementSrc.includes("Authorization"));

t("Frontend does not directly update subscriptions table",
  !featuresSrc.includes("PATCH") || !featuresSrc.includes("/rest/v1/subscriptions"));


/* ══════════════════════════════════════════════════════════════════════
 * 8. Whop webhook still required for paid access
 * ══════════════════════════════════════════════════════════════════════ */
section("8 — Whop webhook required for paid access");

t("Whop webhook handler exists and verifies signatures",
  webhookSrc.includes("verifyWhopSignature") || webhookSrc.includes("whopWebhook"));

{
  // A Whop-paid subscription should resolve as paid_active
  const paidRow = {
    provider: "whop", status: "active", plan_id: "performance",
    current_period_end: new Date(Date.now() + 86400_000 * 30).toISOString()
  };
  const state = resolveAccessState(paidRow);
  t("Whop active subscription → PAID_ACTIVE",
    state.access_state === ACCESS_STATES.PAID_ACTIVE);
  t("Whop active subscription → isPremium true",
    isPremium(paidRow) === true);
}

{
  // athlevo_trial provider should NEVER resolve as paid_active
  const trialRow = {
    provider: "athlevo_trial", status: "trialing", plan_id: "performance",
    trial_end: new Date(Date.now() + 86400_000).toISOString(),
    current_period_end: new Date(Date.now() + 86400_000).toISOString()
  };
  const state = resolveAccessState(trialRow);
  t("athlevo_trial provider → trial_active, NOT paid_active",
    state.access_state === ACCESS_STATES.TRIAL_ACTIVE &&
    state.is_cardless_trial === true);
}


/* ══════════════════════════════════════════════════════════════════════
 * 9. Server-time based expiry
 * ══════════════════════════════════════════════════════════════════════ */
section("9 — Server-time expiry (no client-supplied dates)");

t("Trial start API does not accept any date/time from request body",
  !trialStartSrc.includes("req.body.trial_end") &&
  !trialStartSrc.includes("req.body.expires") &&
  !trialStartSrc.includes("req.body.end_date"));

t("Database function uses now() for trial start (not a parameter)",
  migrationSrc.includes("now()") &&
  migrationSrc.includes("interval '3 days'"));

{
  // Simulate: force now to be 1 day after trial_end → must be expired
  const row = {
    provider: "athlevo_trial", status: "trialing", plan_id: "performance",
    trial_end: "2026-07-25T00:00:00Z",
    current_period_end: "2026-07-25T00:00:00Z"
  };
  const futureNow = new Date("2026-07-26T00:00:00Z").getTime();
  const state = resolveAccessState(row, futureNow);
  t("resolveAccessState respects server now override (expired)",
    state.access_state === ACCESS_STATES.EXPIRED_LIMITED);

  const pastNow = new Date("2026-07-24T00:00:00Z").getTime();
  const active = resolveAccessState(row, pastNow);
  t("resolveAccessState respects server now override (still active)",
    active.access_state === ACCESS_STATES.TRIAL_ACTIVE);
}


/* ══════════════════════════════════════════════════════════════════════
 * 10. Stale sessions see correct expired state
 * ══════════════════════════════════════════════════════════════════════ */
section("10 — Stale sessions see correct expired state");

t("AccessGuard checks server entitlement (accessState) not just local cache",
  accessGuardSrc.includes("accessState") &&
  accessGuardSrc.includes("hasPaidAccess"));

t("PlanSetup checks server entitlement before showing paywall",
  planSetupSrc.includes("accessState") || planSetupSrc.includes("loadEntitlement"));

t("Trial banner refresh loads fresh entitlement from server",
  trialBannerSrc.includes("loadEntitlement") &&
  trialBannerSrc.includes("refresh"));

{
  // A subscription that was trialing but trial_end has now passed
  const staleRow = {
    provider: "athlevo_trial", status: "trialing", plan_id: "performance",
    trial_end: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    current_period_end: new Date(Date.now() - 3600_000).toISOString()
  };
  const state = resolveAccessState(staleRow);
  t("Just-expired trial resolves as expired_limited immediately",
    state.access_state === ACCESS_STATES.EXPIRED_LIMITED);
  t("Just-expired trial gives zero seconds remaining",
    state.trial_seconds_remaining === 0);
  t("Just-expired trial is not premium",
    isPremium(staleRow) === false);
}


/* ══════════════════════════════════════════════════════════════════════
 * 11. Analytics privacy — trial events don't leak PII
 * ══════════════════════════════════════════════════════════════════════ */
section("11 — Trial analytics don't leak PII");

t("Trial start PostHog event does not include email/name/token",
  !trialStartSrc.includes("user.email") || !trialStartSrc.includes("event:"));

t("Coach trial_limit_reached event does not include message content",
  (() => {
    const eventBlock = coachSrc.slice(
      coachSrc.indexOf("trial_limit_reached"),
      coachSrc.indexOf("trial_limit_reached") + 200
    );
    return !eventBlock.includes("message") || eventBlock.includes("coach_message");
  })());

t("Analytics registry PROHIBITED_KEYS blocks email/name/token/content",
  (() => {
    const regSrc = readFileSync("./js/analyticsRegistry.js", "utf8");
    return regSrc.includes("email") && regSrc.includes("token") &&
           regSrc.includes("content") && regSrc.includes("PROHIBITED_KEYS");
  })());


/* ══════════════════════════════════════════════════════════════════════
 * 12. Migration safety
 * ══════════════════════════════════════════════════════════════════════ */
section("12 — Migration includes rollback");

t("Migration includes ROLLBACK section",
  migrationSrc.includes("ROLLBACK") || migrationSrc.includes("rollback"));

t("Migration creates both RPC functions",
  migrationSrc.includes("start_cardless_trial") &&
  migrationSrc.includes("increment_trial_usage"));

t("Migration creates trial_usage table",
  migrationSrc.includes("CREATE TABLE") &&
  migrationSrc.includes("trial_usage"));

t("subscription_events constraint extended for trial event types",
  migrationSrc.includes("cardless_trial_started") &&
  migrationSrc.includes("cardless_trial_expired") &&
  migrationSrc.includes("upgrade_from_trial"));


/* ══════════════════════════════════════════════════════════════════════
 * Summary
 * ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${"═".repeat(60)}`);
console.log(`  ${p} passed, ${f} failed`);
console.log(`${"═".repeat(60)}`);
process.exit(f > 0 ? 1 : 0);
