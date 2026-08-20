/*
 * Athlevo central feature-permission system.
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
 * Paid entitlement requires a subscription row from a recognised paid provider
 * (Whop webhook, PayMongo webhook, or admin-managed GCash manual). A browser cannot create that
 * row because subscriptions are webhook/service-role only.
 */

export const ACCESS_STATES = Object.freeze({
  FREE: "free",
  PAID_ACTIVE: "paid_active",
  PAID_INACTIVE: "paid_inactive"
});

// Plan ranks. Higher tier includes everything below it.
export const PLAN_TIERS = {
  free: 0,
  essentials: 1,
  performance: 2,
  founding_beta: 2,           // legacy stored value; never grants access itself
  elite: 3
};

export const PLAN_ORDER = ["free", "essentials", "performance", "founding_beta", "elite"];

/*
 * Providers whose subscription rows may grant paid access.
 * "whop"         — Whop webhook writes these rows automatically.
 * "gcash_manual" — Admin-managed GCash payments; period_end enforced at read time.
 * "paymongo"     — Verified hosted-checkout payments; paid_until enforced at read time.
 * Any provider NOT in this set is treated as free regardless of plan_id.
 */
export const PAID_PROVIDERS = new Set(["whop", "gcash_manual", "paymongo"]);

/*
 * The feature registry. Each feature declares the minimum plan that
 * unlocks it. `available: false` marks a feature that is designed but not
 * shipped yet — canUse returns false regardless of plan so nothing
 * half-built is ever exposed. `category` is for grouping in a future
 * plan/upgrade screen.
 */
export const FEATURE_REGISTRY = {
  // ── Core (Free) ───────────────────────────────────────────────
  today: { label: "Today", minPlan: "free", category: "core" },
  basic_trends: { label: "Basic Trends", minPlan: "free", category: "core" },
  training_calendar: { label: "Training Calendar", minPlan: "free", category: "core" },
  initial_plan: { label: "Initial Training Plan", minPlan: "free", category: "core" },
  morning_checkin: { label: "Morning Check-in", minPlan: "free", category: "core" },
  readiness: { label: "Daily Readiness", minPlan: "free", category: "core" },
  training_history: { label: "Training History", minPlan: "free", category: "core" },
  provider_connection: { label: "Provider Connection", minPlan: "free", category: "core" },
  activity_import: { label: "Activity Import", minPlan: "free", category: "core" },
  profile_settings: { label: "Profile and Settings", minPlan: "free", category: "core" },
  strava_sync: { label: "Strava Sync", minPlan: "free", category: "core" },
  train_tab: { label: "Weekly Plan View", minPlan: "free", category: "core" },
  trends: { label: "Trends", minPlan: "free", category: "core" },
  coach_chat: { label: "AI Coach Chat", minPlan: "free", category: "coaching" },
  coach_history: { label: "Coach Conversation History", minPlan: "free", category: "coaching" },

  // ── Athlevo Performance ───────────────────────────────────────
  daily_brief: { label: "Daily Coach Brief", minPlan: "performance", category: "coaching" },
  conversation_memory: { label: "Conversation Memory", minPlan: "free", category: "coaching" },
  adaptive_ai: { label: "Adaptive AI Coaching", minPlan: "performance", category: "coaching" },
  workout_modifications: { label: "Workout Modifications", minPlan: "performance", category: "coaching" },
  additional_plan_generation: { label: "Additional Plan Generation", minPlan: "performance", category: "coaching" },
  activity_corrections: { label: "Activity Corrections", minPlan: "free", category: "coaching" },
  weekly_analysis: { label: "Weekly Analysis", minPlan: "performance", category: "analysis" },
  next_week_generation: { label: "Adaptive Next-Week Plans", minPlan: "performance", category: "coaching" },
  advanced_trends: { label: "Advanced Trends", minPlan: "performance", category: "analysis" },
  premium_recommendations: { label: "Premium Recommendations", minPlan: "performance", category: "coaching" },
  workout_analysis: { label: "Ongoing AI Workout Analysis", minPlan: "performance", category: "analysis" },
  advanced_analytics: { label: "Advanced Analytics", minPlan: "performance", category: "analysis" },
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
 * lifecycle. There is no timed trial state: athletes are free unless a
 * verified Whop row is currently active.
 *
 * A null/absent subscription means Free.
 */
export function resolveEntitlement(subscription, now = Date.now()) {
  const free = {
    accessState: ACCESS_STATES.FREE,
    planId: "free",
    tier: 0,
    status: "active",
    entitled: true,
    inGrace: false,
    isFounder: false,
    reason: "free"
  };

  if (!subscription || typeof subscription !== "object") {
    return free;
  }

  const storedPlanId = String(subscription.plan_id || "free").toLowerCase();
  const provider = String(subscription.provider || "").toLowerCase();
  const recognisedPaid = PAID_PROVIDERS.has(provider) && storedPlanId !== "free";
  // Whop rows always map to "performance"; other providers use the stored plan.
  const planId = (provider === "whop" && recognisedPaid) ? "performance" : storedPlanId;
  const paidTier = tierOf(planId);
  const status = String(subscription.status || "active").toLowerCase();
  const isFounder = subscription.is_founder === true;

  // Only recognised paid providers may grant paid access.
  if (
    planId === "free" ||
    paidTier === 0 ||
    !recognisedPaid
  ) {
    // ── 24-hour performance trial for free users ──────────────────
    // If trial_started_at is set and within 24 hours, grant temporary
    // performance-tier access. isPerformanceTrial stays true so callers
    // that need to distinguish (e.g. Coach limits) can check it.
    const trialStart = toTime(subscription.trial_started_at);
    const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
    if (trialStart && (trialStart + TRIAL_DURATION_MS) > now) {
      return {
        accessState: ACCESS_STATES.PAID_ACTIVE,
        planId: "performance",
        tier: tierOf("performance"),
        status: "trialing",
        entitled: true,
        inGrace: false,
        isFounder,
        reason: "performance_trial",
        isPerformanceTrial: true,
        trialExpiresAt: new Date(trialStart + TRIAL_DURATION_MS).toISOString()
      };
    }
    return { ...free, planId, isFounder };
  }

  const periodEnd = toTime(subscription.current_period_end);
  const paidUntil = toTime(subscription.paid_until);
  const effectivePaidEnd = Math.max(periodEnd || 0, paidUntil || 0) || null;
  const graceUntil = toTime(subscription.grace_until);

  const keep = (reason, extra = {}) => ({
    planId,
    accessState: ACCESS_STATES.PAID_ACTIVE,
    tier: paidTier,
    status,
    entitled: true,
    inGrace: false,
    isFounder,
    reason,
    ...extra
  });

  const downgrade = reason => ({
    accessState: ACCESS_STATES.PAID_INACTIVE,
    planId,
    tier: 0,
    status: "expired",
    entitled: true, // still entitled to FREE features
    inGrace: false,
    isFounder,
    reason,
    effectivePaidPlan: planId
  });

  // paid_until is an independent, verified prepaid entitlement lane. It must
  // survive Whop cancellation/refund lifecycle updates to the shared row.
  if (paidUntil && paidUntil > now) {
    return keep("prepaid_active", { effectivePaidEnd });
  }

  switch (status) {
    case "trialing":
    case "active":
      return effectivePaidEnd === null || effectivePaidEnd > now
        ? keep("active")
        : graceUntil && graceUntil > now
        ? keep("grace", { inGrace: true })
        : downgrade("period_ended");

    case "grace":
      return graceUntil && graceUntil > now
        ? keep(status, { inGrace: true })
        : downgrade("grace_ended");

    case "past_due":
      return downgrade("past_due");

    case "cancelled":
      // Cancelled but paid through the end of the current period.
      return effectivePaidEnd && effectivePaidEnd > now
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
    accessState: e.accessState,
    inGrace: e.inGrace,
    isFounder: e.isFounder,
    usableFeatures: listUsableFeatures(subscription, now)
  };
}
