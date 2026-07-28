/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Subscription access helpers  (the ONE place feature gates call)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Requirement: future premium checks call a SINGLE function, never duplicate
 *  logic. Entitlement rules already live in lib/server/features.js
 *  (resolveEntitlement / canUse). This module is the thin, provider-agnostic
 *  bridge between "a subscriptions row" and "is this athlete premium / may
 *  they use feature X" — so callers do:
 *
 *      import { isPremium, userCanUse } from "../lib/server/subscriptions.js";
 *      if (!(await userCanUse(userId, "adaptive_plan", loadSub))) return 402;
 *
 *  It never trusts the frontend: the subscription state is whatever the
 *  service-role webhook wrote, re-evaluated against the clock at read time.
 */

import { resolveEntitlement, canUse, PLAN_TIERS } from "./features.js";

/*
 * ── Trial limits (server-enforced) ──────────────────────────────────
 * These are the conservative allowances for the cardless 3-day trial.
 * Paid users are not subject to these limits.
 */
export const TRIAL_LIMITS = {
  plan_generation:  1,   // 1 plan generation during entire trial
  plan_adjustment:  1,   // 1 plan adjustment during entire trial
  coach_message:    5,   // 5 coach messages per day
  ai_analysis:      1,   // 1 AI workout analysis per day
  daily_brief:      1    // 1 daily brief per day
};

/*
 * ── Normalized access states ────────────────────────────────────────
 * Every protected feature receives one of these states. The server
 * determines this from: verified Whop subscription, server-controlled
 * trial timestamps, and current server time.
 */
export const ACCESS_STATES = {
  TRIAL_ACTIVE:     "trial_active",
  PAID_ACTIVE:      "paid_active",
  EXPIRED_LIMITED:  "expired_limited",
  NO_ENTITLEMENT:   "no_entitlement"
};

/*
 * Resolves the normalized access state from a subscription row.
 * This is the SINGLE source of truth for what an athlete can do.
 */
export function resolveAccessState(subscriptionRow, now = Date.now()) {
  if (!subscriptionRow || typeof subscriptionRow !== "object") {
    return {
      access_state: ACCESS_STATES.NO_ENTITLEMENT,
      tier: 0,
      plan_id: "free",
      trial_ends_at: null,
      trial_seconds_remaining: 0,
      paid_plan: null,
      is_cardless_trial: false
    };
  }

  const ent = resolveEntitlement(subscriptionRow, now);
  const provider = subscriptionRow.provider || null;
  const isCardlessTrial = provider === "athlevo_trial";
  const trialEnd = subscriptionRow.trial_end
    ? new Date(subscriptionRow.trial_end).getTime() : null;
  const trialSecondsRemaining = trialEnd
    ? Math.max(0, Math.floor((trialEnd - now) / 1000)) : 0;

  // Paid (non-trial) active subscription
  if (!isCardlessTrial && ent.tier > 0 && ent.entitled && ent.reason !== "trial_ended" && ent.reason !== "expired" && ent.reason !== "period_ended" && ent.reason !== "grace_ended" && ent.reason !== "cancelled") {
    return {
      access_state: ACCESS_STATES.PAID_ACTIVE,
      tier: ent.tier,
      plan_id: ent.planId,
      trial_ends_at: null,
      trial_seconds_remaining: 0,
      paid_plan: ent.planId,
      is_cardless_trial: false
    };
  }

  // Cardless trial — active
  if (isCardlessTrial && ent.tier > 0 && ent.inTrial && trialEnd && trialEnd > now) {
    return {
      access_state: ACCESS_STATES.TRIAL_ACTIVE,
      tier: ent.tier,
      plan_id: ent.planId,
      trial_ends_at: subscriptionRow.trial_end,
      trial_seconds_remaining: trialSecondsRemaining,
      paid_plan: null,
      is_cardless_trial: true,
      trial_limits: TRIAL_LIMITS
    };
  }

  // Cardless trial — expired, OR any expired paid subscription
  if (isCardlessTrial || (ent.tier === 0 && ent.effectivePaidPlan)) {
    return {
      access_state: ACCESS_STATES.EXPIRED_LIMITED,
      tier: 0,
      plan_id: "free",
      trial_ends_at: subscriptionRow.trial_end || null,
      trial_seconds_remaining: 0,
      paid_plan: null,
      is_cardless_trial: isCardlessTrial,
      expired_plan: isCardlessTrial ? "performance" : (ent.effectivePaidPlan || null)
    };
  }

  // Fallback: no entitlement
  return {
    access_state: ACCESS_STATES.NO_ENTITLEMENT,
    tier: 0,
    plan_id: "free",
    trial_ends_at: null,
    trial_seconds_remaining: 0,
    paid_plan: null,
    is_cardless_trial: false
  };
}

// A missing row means the Free plan (tier 0). Premium = any active paid tier.
export function subscriptionSummary(subscriptionRow, now = Date.now()) {
  const ent = resolveEntitlement(subscriptionRow || null, now);
  const paid = ent.tier > 0 && ent.entitled;
  return {
    active: paid,                       // "subscription_active" (derived, authoritative)
    plan: (subscriptionRow && subscriptionRow.plan_id) || "free",
    tier: ent.tier,
    status: ent.status,
    provider: (subscriptionRow && subscriptionRow.provider) || null,
    expiresAt: (subscriptionRow && subscriptionRow.current_period_end) || null
  };
}

// THE premium check. True only when a paid tier is currently entitled.
// Now also returns true for active cardless trial users.
export function isPremium(subscriptionRow, now = Date.now()) {
  const state = resolveAccessState(subscriptionRow, now);
  return state.access_state === ACCESS_STATES.PAID_ACTIVE ||
         state.access_state === ACCESS_STATES.TRIAL_ACTIVE;
}

// Feature-level check, delegating to the central entitlement registry.
export function canUseFeature(featureName, subscriptionRow, now = Date.now()) {
  return canUse(featureName, subscriptionRow || null, now);
}

/*
 * Async convenience: load the row (via an injected loader so this stays pure /
 * testable and free of a Supabase dependency) then evaluate. Server routes
 * pass a loader that reads public.subscriptions with the service role.
 */
export async function userIsPremium(userId, loadSubscription, now = Date.now()) {
  if (!userId || typeof loadSubscription !== "function") return false;
  let row = null;
  try { row = await loadSubscription(userId); } catch (e) { row = null; }
  return isPremium(row, now);
}

export async function userCanUse(userId, featureName, loadSubscription, now = Date.now()) {
  if (!userId || typeof loadSubscription !== "function") return false;
  let row = null;
  try { row = await loadSubscription(userId); } catch (e) { row = null; }
  return canUseFeature(featureName, row, now);
}

/*
 * Full entitlement info for the current user. Safe for client consumption
 * (no billing secrets, no internal webhook data).
 */
export async function userEntitlementInfo(userId, loadSubscription, now = Date.now()) {
  if (!userId || typeof loadSubscription !== "function") {
    return resolveAccessState(null, now);
  }
  let row = null;
  try { row = await loadSubscription(userId); } catch (e) { row = null; }
  return resolveAccessState(row, now);
}

export const SUBSCRIPTIONS_HELPER_VERSION = "subscriptions-helper-v2";
