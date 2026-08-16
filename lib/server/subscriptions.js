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

import {
  ACCESS_STATES,
  resolveEntitlement,
  canUse,
  PLAN_TIERS
} from "./features.js";

// A missing row means the Free plan (tier 0). Premium = any active paid tier.
export function subscriptionSummary(subscriptionRow, now = Date.now()) {
  const ent = resolveEntitlement(subscriptionRow || null, now);
  const paid = ent.tier > 0 && ent.entitled;
  const expirations = [
    subscriptionRow && subscriptionRow.current_period_end,
    subscriptionRow && subscriptionRow.paid_until
  ].map(value => ({ value, time: value ? Date.parse(value) : NaN }))
    .filter(entry => Number.isFinite(entry.time));
  const expiresAt = expirations.reduce(
    (latest, entry) => !latest || entry.time > latest.time ? entry : latest,
    null
  )?.value || null;
  return {
    active: paid,                       // "subscription_active" (derived, authoritative)
    accessState: ent.accessState,
    plan: paid ? ent.planId : "free",
    tier: ent.tier,
    status: ent.status,
    provider: (subscriptionRow && subscriptionRow.provider) || null,
    expiresAt
  };
}

// THE premium check. True only when a paid tier is currently entitled.
export function isPremium(subscriptionRow, now = Date.now()) {
  return subscriptionSummary(subscriptionRow, now).accessState ===
    ACCESS_STATES.PAID_ACTIVE;
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

export const SUBSCRIPTIONS_HELPER_VERSION = "subscriptions-helper-v1";
