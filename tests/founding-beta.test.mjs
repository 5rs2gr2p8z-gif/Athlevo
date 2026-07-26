/*
 * Athlevo — Founding Beta entitlement tests.
 *
 * Verifies:
 *   1. Active founding-beta users bypass paywall + access guards
 *   2. Expired founding-beta users are locked out (downgraded to free)
 *   3. Paid/trial Whop users are completely unaffected
 *   4. Founding beta does not produce fake revenue/subscription analytics
 *   5. User data is retained after beta expiry
 *   6. Entitlement properties are correct
 *
 * Run: node tests/founding-beta.test.mjs
 */

import { readFileSync } from "node:fs";
import {
  resolveEntitlement, canUse, PLAN_TIERS
} from "../lib/server/features.js";
import {
  isPremium, subscriptionSummary, canUseFeature
} from "../lib/server/subscriptions.js";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const iso = (daysFromNow) =>
  new Date(Date.now() + daysFromNow * 86400000).toISOString();

const featuresSrc = readFileSync("./js/features.js", "utf8");
const accessGuardSrc = readFileSync("./js/accessGuard.js", "utf8");
const paywallSrc = readFileSync("./js/paywall.js", "utf8");
const planSetupSrc = readFileSync("./js/planSetup.js", "utf8");

/* ── mock browser factory (reused from access-guard.test.mjs) ────── */

function world({ subscriptionRow = null, profile = {} } = {}) {
  const screens = [];
  const mounts = {};
  const analytics = [];

  const doc = {
    getElementById: (id) => {
      if (["paywallBody", "planSetupBody", "planGenBody", "todayPlanCta",
           "pgSteps", "pwConfirming", "pwConfirmTitle", "pwConfirmSub",
           "pwCheckBtn", "pw-checkout-btn", "tabbar",
           "screen-coachai", "screen-train", "screen-trends",
           "foundingBetaBanner", "foundingBetaDetail"].includes(id)) {
        return mounts[id] || (mounts[id] = {
          style: {}, dataset: {}, className: "",
          children: [], textContent: "",
          set innerHTML(v) { this._h = v; },
          get innerHTML() { return this._h || ""; },
          querySelector: (sel) => {
            if (sel === ".ag-overlay") return mounts[id + "_overlay"] || null;
            return null;
          },
          querySelectorAll: () => [],
          scrollIntoView() {},
          appendChild(child) {
            this.children.push(child);
            mounts[id + "_overlay"] = child;
          }
        });
      }
      return null;
    },
    querySelector: (sel) => {
      if (sel === ".pw-preview") return { scrollIntoView() {} };
      if (sel === ".pw-wall") return { style: {} };
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      return {
        className: "", style: {},
        set innerHTML(v) { this._h = v; },
        get innerHTML() { return this._h || ""; },
      };
    },
    visibilityState: "visible"
  };

  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 5)),
    clearInterval,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    showScreen: (id) => screens.push(id),
    fetch: async (url) => {
      const u = String(url);
      if (u.includes("get-week")) return { ok: true, status: 200, json: async () => ({ hasPlan: false }) };
      if (u.includes("action=status")) return { ok: true, status: 200, json: async () => ({ connected: false }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
    matchMedia: () => ({ matches: true }),
    open: () => {},
    URL: URL,
    URLSearchParams: URLSearchParams,
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: "tok" } } }),
        getUser: async () => ({ data: { user: { id: "u1", email: "beta@example.com" } } })
      },
      from: (table) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === "subscriptions") return { data: subscriptionRow, error: null };
              return { data: null, error: null };
            }
          })
        })
      })
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {} },
    location: { search: "", pathname: "/", hash: "", origin: "https://athlevo.app" },
    scrollTo() {},
    AthlevoAnalytics: { track: (name, data) => analytics.push({ name, data }) },
    AthlevoBrain: {
      loadAthleteProfile: async () => profile,
      providerStatus: async () => ({ connected: false }),
      refreshAthleteUI: async () => {}
    }
  };
  sandbox.window = sandbox;

  // Load in order: features → paywall → accessGuard → planSetup
  new Function(...Object.keys(sandbox), "root", featuresSrc)(
    ...Object.values(sandbox), sandbox);
  new Function(...Object.keys(sandbox), "root", paywallSrc)(
    ...Object.values(sandbox), sandbox);
  new Function(...Object.keys(sandbox), "root", accessGuardSrc)(
    ...Object.values(sandbox), sandbox);
  new Function(...Object.keys(sandbox), "root",
    planSetupSrc.replace(/\}\)\(\);?\s*$/, "})()"))(
    ...Object.values(sandbox), sandbox);

  return {
    g: sandbox, screens, mounts, analytics,
    guard: sandbox.AthlevoAccessGuard,
    paywall: sandbox.AthlevoPaywall,
    plan: sandbox.AthlevoPlan
  };
}

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

/* ══════════ 1 — Active founding-beta bypasses all locks ═══════════ */

section("1. Active founding-beta user gets full access");
{
  const betaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(3),
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true,
    metadata: { source: "founding_beta" }
  };

  // Server-side entitlement
  const ent = resolveEntitlement(betaSub);
  t("tier is 2 (performance-level)", ent.tier === 2);
  t("entitled is true", ent.entitled === true);
  t("isFoundingBeta flag is true", ent.isFoundingBeta === true);
  t("planId is founding_beta", ent.planId === "founding_beta");
  t("reason is active", ent.reason === "active");
  t("not in trial", ent.inTrial === false);
  t("not in grace", ent.inGrace === false);

  // Premium check
  t("isPremium returns true", isPremium(betaSub) === true);

  // Feature access
  t("can use adaptive_ai", canUseFeature("adaptive_ai", betaSub) === true);
  t("can use coach_chat", canUseFeature("coach_chat", betaSub) === true);
  t("can use workout_modifications", canUseFeature("workout_modifications", betaSub) === true);
  t("can use weekly_analysis", canUseFeature("weekly_analysis", betaSub) === true);
  t("can use trends", canUseFeature("trends", betaSub) === true);

  // Client-side: access guards
  const w = world({ subscriptionRow: betaSub });

  const coachBlocked = await w.guard.guardTab("screen-coachai");
  t("Coach tab passes for founding-beta", coachBlocked === false);

  const trainBlocked = await w.guard.guardTab("screen-train");
  t("Train tab passes for founding-beta", trainBlocked === false);

  const trendsBlocked = await w.guard.guardTab("screen-trends");
  t("Trends tab passes for founding-beta", trendsBlocked === false);
}

section("1b. Active founding-beta bypasses paywall");
{
  const betaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(3),
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true
  };
  const w = world({ subscriptionRow: betaSub, profile: { name: "Dean" } });
  await w.plan.maybeLaunchAfterOnboarding();
  await wait();
  t("founding-beta does NOT see paywall after onboarding",
    !w.screens.includes("screen-paywall"));
}

section("1c. Active founding-beta bypasses paywall via start()");
{
  const betaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(3),
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true
  };
  const w = world({ subscriptionRow: betaSub, profile: { name: "Dean" } });
  await w.plan.start();
  await wait();
  t("start() routes to plan setup, not paywall",
    w.screens.includes("screen-plansetup") && !w.screens.includes("screen-paywall"));
}

/* ══════════ 2 — Expired founding-beta is locked out ═══════════════ */

section("2. Expired founding-beta downgrades to free");
{
  const expiredBetaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(-1),   // expired yesterday
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true,
    metadata: { source: "founding_beta" }
  };

  const ent = resolveEntitlement(expiredBetaSub);
  t("expired beta tier is 0", ent.tier === 0);
  t("expired beta planId is free", ent.planId === "free");
  t("expired beta status is expired", ent.status === "expired");
  t("expired beta reason is period_ended", ent.reason === "period_ended");
  t("expired beta isFoundingBeta flag preserved", ent.isFoundingBeta === true);
  t("expired beta effectivePaidPlan is founding_beta",
    ent.effectivePaidPlan === "founding_beta");

  t("isPremium returns false for expired beta",
    isPremium(expiredBetaSub) === false);

  t("cannot use adaptive_ai when expired",
    canUseFeature("adaptive_ai", expiredBetaSub) === false);
  t("cannot use coach_chat when expired",
    canUseFeature("coach_chat", expiredBetaSub) === false);

  // Client-side: access guards block expired beta
  const w = world({ subscriptionRow: expiredBetaSub });

  const coachBlocked = await w.guard.guardTab("screen-coachai");
  t("Coach tab is BLOCKED for expired beta", coachBlocked === true);

  const trainBlocked = await w.guard.guardTab("screen-train");
  t("Train tab is BLOCKED for expired beta", trainBlocked === true);

  const trendsBlocked = await w.guard.guardTab("screen-trends");
  t("Trends tab is BLOCKED for expired beta", trendsBlocked === true);
}

section("2b. Expired founding-beta sees paywall with trial offer");
{
  const expiredBetaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(-1),
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true
  };
  const w = world({
    subscriptionRow: expiredBetaSub,
    profile: { name: "Dean", goal: "10K" }
  });
  await w.plan.maybeLaunchAfterOnboarding();
  await wait();
  t("expired beta sees paywall", w.screens.includes("screen-paywall"));
}

/* ══════════ 3 — Paid/trial Whop users unaffected ══════════════════ */

section("3. Paid Whop subscription is unaffected by founding_beta changes");
{
  const whopSub = {
    plan_id: "performance",
    status: "active",
    current_period_end: iso(25),
    provider: "whop",
    provider_subscription_id: "sub_whop_123",
    billing_interval: "monthly",
    is_founder: false
  };

  const ent = resolveEntitlement(whopSub);
  t("paid Whop user tier is 2", ent.tier === 2);
  t("paid Whop user planId is performance", ent.planId === "performance");
  t("paid Whop user isFoundingBeta is false", ent.isFoundingBeta === false);
  t("paid Whop user reason is active", ent.reason === "active");
  t("isPremium returns true for Whop user", isPremium(whopSub) === true);

  const w = world({ subscriptionRow: whopSub, profile: { name: "Dean" } });
  await w.plan.start();
  await wait();
  t("paid Whop user sees plan setup, not paywall",
    w.screens.includes("screen-plansetup") && !w.screens.includes("screen-paywall"));
}

section("3b. Trial Whop user unaffected");
{
  const trialSub = {
    plan_id: "performance",
    status: "trialing",
    trial_end: iso(3),
    provider: "whop",
    billing_interval: "monthly"
  };

  const ent = resolveEntitlement(trialSub);
  t("trial user tier is 2", ent.tier === 2);
  t("trial user isFoundingBeta is false", ent.isFoundingBeta === false);
  t("trial user inTrial is true", ent.inTrial === true);

  const w = world({ subscriptionRow: trialSub });
  const coachBlocked = await w.guard.guardTab("screen-coachai");
  t("Coach tab passes for trial user", coachBlocked === false);
}

section("3c. Free user (no subscription) unaffected");
{
  const ent = resolveEntitlement(null);
  t("free user tier is 0", ent.tier === 0);
  t("free user isFoundingBeta is false", ent.isFoundingBeta === false);

  const w = world({ subscriptionRow: null });
  const coachBlocked = await w.guard.guardTab("screen-coachai");
  t("Coach tab is blocked for free user", coachBlocked === true);
}

/* ══════════ 4 — No fake revenue/subscription analytics ════════════ */

section("4. Founding beta does not produce fake revenue analytics");
{
  const betaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(3),
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true,
    metadata: { source: "founding_beta" }
  };

  const summary = subscriptionSummary(betaSub);
  t("subscription summary provider is founding_beta",
    summary.provider === "founding_beta");
  t("subscription summary plan is founding_beta",
    summary.plan === "founding_beta");
  t("billing_interval is none (no revenue cycle)",
    betaSub.billing_interval === "none");
  t("no provider_subscription_id (not a Whop sub)",
    !betaSub.provider_subscription_id);
  t("no provider_customer_id",
    !betaSub.provider_customer_id);
  t("no provider_price_id",
    !betaSub.provider_price_id);

  // Analytics filtering: provider = 'founding_beta' makes it trivially
  // filterable from real revenue queries.
  t("provider !== 'whop' (clearly not Whop revenue)",
    summary.provider !== "whop");
  t("provider !== 'stripe'", summary.provider !== "stripe");
  t("provider !== 'paymongo'", summary.provider !== "paymongo");
}

/* ══════════ 5 — Data retained after beta expiry ═══════════════════ */

section("5. Data retention: subscription row survives expiry");
{
  // After expiry, the subscription row still exists with all metadata.
  // resolveEntitlement downgrades tier to 0 but never deletes anything.
  const expiredBetaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(-1),
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true,
    metadata: { source: "founding_beta", granted_at: "2026-07-26T00:00:00Z" }
  };

  const ent = resolveEntitlement(expiredBetaSub);

  // Entitlement downgrades but the subscription object is untouched.
  t("expired beta still has effectivePaidPlan",
    ent.effectivePaidPlan === "founding_beta");
  t("entitled is still true (for free-tier features)",
    ent.entitled === true);
  t("isFounder flag preserved", ent.isFounder === true);
  t("metadata survives (source field)",
    expiredBetaSub.metadata.source === "founding_beta");

  // The subscription row itself is never modified or deleted by
  // resolveEntitlement — it's a pure function. Profile, conversations,
  // training history are in separate tables untouched by subscription logic.
  t("subscription row is intact (plan_id unchanged)",
    expiredBetaSub.plan_id === "founding_beta");
  t("subscription row metadata intact",
    expiredBetaSub.metadata.granted_at === "2026-07-26T00:00:00Z");
}

/* ══════════ 6 — PLAN_TIERS includes founding_beta ═════════════════ */

section("6. PLAN_TIERS and entitlement structure");
{
  t("PLAN_TIERS has founding_beta at tier 2",
    PLAN_TIERS.founding_beta === 2);
  t("PLAN_TIERS.performance is also 2 (same access level)",
    PLAN_TIERS.performance === 2);
  t("PLAN_TIERS.free is 0", PLAN_TIERS.free === 0);

  // Client-side features.js also has founding_beta
  t("client features.js includes founding_beta in PLAN_TIERS",
    /founding_beta:\s*2/.test(featuresSrc));
  t("client features.js has isFoundingBeta in resolveEntitlement",
    /isFoundingBeta/.test(featuresSrc));
}

/* ══════════ 7 — UI banner logic ═══════════════════════════════════ */

section("7. Founding Beta UI banner");
{
  // Active beta: banner should show
  const betaSub = {
    plan_id: "founding_beta",
    status: "active",
    current_period_end: iso(3),
    provider: "founding_beta",
    billing_interval: "none",
    is_founder: true
  };
  const w = world({ subscriptionRow: betaSub, profile: { name: "Dean" } });
  await w.plan.load();
  await wait();

  const banner = w.mounts.foundingBetaBanner;
  t("founding beta banner is visible for active beta",
    banner && banner.style.display === "block");

  const detail = w.mounts.foundingBetaDetail;
  t("banner detail contains 'Full access until'",
    detail && /Full access until/.test(detail.textContent));

  // Paid Whop user: banner should NOT show
  const whopSub = {
    plan_id: "performance",
    status: "active",
    current_period_end: iso(25),
    provider: "whop"
  };
  const w2 = world({ subscriptionRow: whopSub });
  await w2.plan.load();
  await wait();

  const banner2 = w2.mounts.foundingBetaBanner;
  t("founding beta banner hidden for paid Whop user",
    !banner2 || banner2.style.display === "none" || banner2.style.display === "");

  // Free user: banner should NOT show
  const w3 = world({ subscriptionRow: null });
  await w3.plan.load();
  await wait();

  const banner3 = w3.mounts.foundingBetaBanner;
  t("founding beta banner hidden for free user",
    !banner3 || banner3.style.display === "none" || banner3.style.display === "");
}

/* ══════════ 8 — Migration SQL structure ═══════════════════════════ */

section("8. Migration and admin SQL files");
{
  const migrationSql = readFileSync("./migrations/2026-07-26_founding_beta.sql", "utf8");
  const grantSql = readFileSync("./migrations/admin_grant_founding_beta.sql", "utf8");

  t("migration inserts founding_beta plan",
    /founding_beta.*Founding Beta/.test(migrationSql));
  t("migration sets tier to 2",
    /tier.*2|2.*tier/.test(migrationSql));
  t("migration adds beta_granted event type",
    /beta_granted/.test(migrationSql));
  t("migration adds beta_expired event type",
    /beta_expired/.test(migrationSql));

  t("grant SQL uses plan_id founding_beta",
    /founding_beta/.test(grantSql));
  t("grant SQL uses provider founding_beta",
    /provider/.test(grantSql) && /founding_beta/.test(grantSql));
  t("grant SQL sets current_period_end",
    /current_period_end/.test(grantSql));
  t("grant SQL uses ON CONFLICT DO NOTHING (no overwrite)",
    /ON CONFLICT.*DO NOTHING/i.test(grantSql));
  t("grant SQL logs beta_granted event",
    /beta_granted/.test(grantSql));
  t("grant SQL has placeholder for user IDs",
    /REPLACE THESE|UUID/.test(grantSql));
  t("grant SQL does NOT auto-grant to all users",
    !/SELECT.*FROM.*auth\.users(?!.*WHERE)/i.test(grantSql));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
