/*
 * Athlevo central feature-permission system (architecture only — no
 * payment logic).
 *
 * This is the ONE place plan rules live. Code checks
 *   canUse("workout_modifications", subscription)
 * never
 *   if (plan === "Performance")
 *
 * The client mirror (js/features.js) must stay byte-for-byte identical in
 * PLAN_TIERS, FEATURE_REGISTRY, resolveEntitlement, and canUse so gating
 * is consistent on both sides. A parity test guards that.
 *
 * Entitlement depends ONLY on plan tier + subscription lifecycle — never
 * on the billing provider — so PayMongo can later be swapped for Stripe
 * without touching any feature check.
 */

// Plan ranks. Higher tier includes everything below it.
export const PLAN_TIERS = {
  free: 0,
  essentials: 1,
  performance: 2,
  elite: 3
};

export const PLAN_ORDER = ["free", "essentials", "performance", "elite"];

/*
 * The feature registry. Each feature declares the minimum plan that
 * unlocks it. `available: false` marks a feature that is designed but not
 * shipped yet — canUse returns false regardless of plan so nothing
 * half-built is ever exposed. `category` is for grouping in a future
 * plan/upgrade screen.
 */
export const FEATURE_REGISTRY = {
  // ── Core (Free) ───────────────────────────────────────────────
  morning_checkin: { label: "Morning Check-in", minPlan: "free", category: "core" },
  readiness: { label: "Daily Readiness", minPlan: "free", category: "core" },
  training_history: { label: "Training History", minPlan: "free", category: "core" },
  strava_sync: { label: "Strava Sync", minPlan: "free", category: "core" },
  train_tab: { label: "Weekly Plan View", minPlan: "free", category: "core" },
  trends: { label: "Trends", minPlan: "free", category: "core" },

  // ── Essentials ────────────────────────────────────────────────
  coach_chat: { label: "AI Coach Chat", minPlan: "essentials", category: "coaching" },
  daily_brief: { label: "Daily Coach Brief", minPlan: "essentials", category: "coaching" },
  conversation_memory: { label: "Conversation Memory", minPlan: "essentials", category: "coaching" },

  // ── Performance ───────────────────────────────────────────────
  adaptive_ai: { label: "Adaptive AI Coaching", minPlan: "performance", category: "coaching" },
  workout_modifications: { label: "Workout Modifications", minPlan: "performance", category: "coaching" },
  activity_corrections: { label: "Activity Corrections", minPlan: "performance", category: "coaching" },
  weekly_analysis: { label: "Weekly Analysis", minPlan: "performance", category: "analysis" },
  next_week_generation: { label: "Adaptive Next-Week Plans", minPlan: "performance", category: "coaching" },

  // ── Elite ─────────────────────────────────────────────────────
  advanced_analytics: { label: "Advanced Analytics", minPlan: "elite", category: "analysis" },
  coach_reports: { label: "Coach Reports", minPlan: "elite", category: "analysis", available: false },
  coach_personalities: { label: "Coach Personalities", minPlan: "elite", category: "coaching", available: false },

  // ── Future integrations / AI (designed, not shipped) ──────────
  garmin_recovery: { label: "Garmin Recovery", minPlan: "performance", category: "integrations", available: false },
  apple_health: { label: "Apple Health", minPlan: "essentials", category: "integrations", available: false },
  ai_race_prediction: { label: "AI Race Prediction", minPlan: "elite", category: "ai", available: false },
  ai_pacing: { label: "AI Pacing", minPlan: "elite", category: "ai", available: false }
};

function tierOf(planId) {
  const rank = PLAN_TIERS[String(planId || "free").toLowerCase()];
  return Number.isFinite(rank) ? rank : 0;
}

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/*
 * Resolves what an athlete is ENTITLED to right now from their raw
 * subscription row. Returns the EFFECTIVE plan/tier after applying the
 * lifecycle — an expired or fully-cancelled paid plan collapses to Free,
 * while trial / active / grace / cancel-at-period-end (still in period)
 * keep the paid tier.
 *
 * A null/absent subscription means Free.
 */
export function resolveEntitlement(subscription, now = Date.now()) {
  const free = {
    planId: "free",
    tier: 0,
    status: "active",
    entitled: true,
    inTrial: false,
    inGrace: false,
    isFounder: false,
    reason: "free"
  };

  if (!subscription || typeof subscription !== "object") {
    return free;
  }

  const planId = String(subscription.plan_id || "free").toLowerCase();
  const paidTier = tierOf(planId);
  const status = String(subscription.status || "active").toLowerCase();
  const isFounder = subscription.is_founder === true;

  // Free plan: always entitled at tier 0.
  if (planId === "free" || paidTier === 0) {
    return { ...free, planId, isFounder };
  }

  const trialEnd = toTime(subscription.trial_end);
  const periodEnd = toTime(subscription.current_period_end);
  const graceUntil = toTime(subscription.grace_until);

  const keep = (reason, extra = {}) => ({
    planId,
    tier: paidTier,
    status,
    entitled: true,
    inTrial: false,
    inGrace: false,
    isFounder,
    reason,
    ...extra
  });

  const downgrade = reason => ({
    planId: "free",
    tier: 0,
    status: "expired",
    entitled: true, // still entitled to FREE features
    inTrial: false,
    inGrace: false,
    isFounder,
    reason,
    effectivePaidPlan: planId
  });

  switch (status) {
    case "trialing":
      return trialEnd === null || trialEnd > now
        ? keep("trialing", { inTrial: true })
        : downgrade("trial_ended");

    case "active":
      return periodEnd === null || periodEnd > now
        ? keep("active")
        : graceUntil && graceUntil > now
        ? keep("grace", { inGrace: true })
        : downgrade("period_ended");

    case "grace":
    case "past_due":
      return graceUntil && graceUntil > now
        ? keep(status, { inGrace: true })
        : downgrade("grace_ended");

    case "cancelled":
      // Cancelled but paid through the end of the current period.
      return periodEnd && periodEnd > now
        ? keep("cancelled_active", { cancelAtPeriodEnd: true })
        : downgrade("cancelled");

    case "expired":
    default:
      return downgrade("expired");
  }
}

/*
 * THE central check. Returns true when the athlete's current entitlement
 * unlocks the feature. Unknown or not-yet-shipped features return false.
 */
export function canUse(featureName, subscription, now = Date.now()) {
  const feature = FEATURE_REGISTRY[featureName];

  if (!feature) {
    return false; // unknown feature — deny by default
  }

  if (feature.available === false) {
    return false; // designed but not shipped
  }

  const { tier } = resolveEntitlement(subscription, now);
  return tier >= tierOf(feature.minPlan);
}

/* Every feature the athlete can currently use (shipped + entitled). */
export function listUsableFeatures(subscription, now = Date.now()) {
  return Object.keys(FEATURE_REGISTRY).filter(key =>
    canUse(key, subscription, now)
  );
}

/*
 * A compact, athlete-facing entitlement summary (no provider details).
 * Useful for a plan/upgrade screen or debugging.
 */
export function entitlementSummary(subscription, now = Date.now()) {
  const e = resolveEntitlement(subscription, now);
  return {
    plan: e.planId,
    tier: e.tier,
    status: e.status,
    inTrial: e.inTrial,
    inGrace: e.inGrace,
    isFounder: e.isFounder,
    usableFeatures: listUsableFeatures(subscription, now)
  };
}
