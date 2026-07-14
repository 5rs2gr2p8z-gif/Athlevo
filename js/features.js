console.log("Athlevo Plan/Features Loaded");

/*
 * Client mirror of lib/server/features.js. PLAN_TIERS, FEATURE_REGISTRY,
 * resolveEntitlement, and canUse are kept byte-for-byte identical to the
 * server so UI gating matches server enforcement (a parity test guards
 * this). Architecture only — no feature is gated yet; this exposes the
 * tools for when paid plans go live.
 *
 * Usage:
 *   await AthlevoPlan.load();                 // fetch the subscription
 *   if (AthlevoPlan.canUse("workout_modifications")) { ... }
 */

const PLAN_TIERS = {
  free: 0,
  essentials: 1,
  performance: 2,
  elite: 3
};

const PLAN_ORDER = ["free", "essentials", "performance", "elite"];

const FEATURE_REGISTRY = {
  morning_checkin: { label: "Morning Check-in", minPlan: "free", category: "core" },
  readiness: { label: "Daily Readiness", minPlan: "free", category: "core" },
  training_history: { label: "Training History", minPlan: "free", category: "core" },
  strava_sync: { label: "Strava Sync", minPlan: "free", category: "core" },
  train_tab: { label: "Weekly Plan View", minPlan: "free", category: "core" },
  trends: { label: "Trends", minPlan: "free", category: "core" },

  coach_chat: { label: "AI Coach Chat", minPlan: "essentials", category: "coaching" },
  daily_brief: { label: "Daily Coach Brief", minPlan: "essentials", category: "coaching" },
  conversation_memory: { label: "Conversation Memory", minPlan: "essentials", category: "coaching" },

  adaptive_ai: { label: "Adaptive AI Coaching", minPlan: "performance", category: "coaching" },
  workout_modifications: { label: "Workout Modifications", minPlan: "performance", category: "coaching" },
  activity_corrections: { label: "Activity Corrections", minPlan: "performance", category: "coaching" },
  weekly_analysis: { label: "Weekly Analysis", minPlan: "performance", category: "analysis" },
  next_week_generation: { label: "Adaptive Next-Week Plans", minPlan: "performance", category: "coaching" },

  advanced_analytics: { label: "Advanced Analytics", minPlan: "elite", category: "analysis" },
  coach_reports: { label: "Coach Reports", minPlan: "elite", category: "analysis", available: false },
  coach_personalities: { label: "Coach Personalities", minPlan: "elite", category: "coaching", available: false },

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

function resolveEntitlement(subscription, now) {
  now = now || Date.now();

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

  if (planId === "free" || paidTier === 0) {
    return Object.assign({}, free, { planId: planId, isFounder: isFounder });
  }

  const trialEnd = toTime(subscription.trial_end);
  const periodEnd = toTime(subscription.current_period_end);
  const graceUntil = toTime(subscription.grace_until);

  const keep = (reason, extra) =>
    Object.assign(
      {
        planId,
        tier: paidTier,
        status,
        entitled: true,
        inTrial: false,
        inGrace: false,
        isFounder,
        reason
      },
      extra || {}
    );

  const downgrade = reason => ({
    planId: "free",
    tier: 0,
    status: "expired",
    entitled: true,
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
      return periodEnd && periodEnd > now
        ? keep("cancelled_active", { cancelAtPeriodEnd: true })
        : downgrade("cancelled");

    case "expired":
    default:
      return downgrade("expired");
  }
}

function canUseWith(featureName, subscription, now) {
  const feature = FEATURE_REGISTRY[featureName];

  if (!feature) {
    return false;
  }

  if (feature.available === false) {
    return false;
  }

  const resolved = resolveEntitlement(subscription, now);
  return resolved.tier >= tierOf(feature.minPlan);
}

/* ─── stateful client wrapper ─────────────────────────────────── */

let currentSubscription = null;
let subscriptionLoaded = false;

async function loadSubscription() {
  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) {
      currentSubscription = null;
      subscriptionLoaded = true;
      return null;
    }

    // A missing row means Free — never an error state.
    const { data, error } = await supabaseClient
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.warn("Subscription load failed; defaulting to Free:", error.message);
      currentSubscription = null;
    } else {
      currentSubscription = data || null;
    }

    subscriptionLoaded = true;
    return currentSubscription;
  } catch (error) {
    console.warn("Subscription load error; defaulting to Free:", error);
    currentSubscription = null;
    subscriptionLoaded = true;
    return null;
  }
}

window.AthlevoPlan = {
  PLAN_TIERS,
  PLAN_ORDER,
  FEATURE_REGISTRY,

  load: loadSubscription,

  // canUse(feature) uses the cached subscription; pass an explicit
  // subscription as the 2nd arg to check against a specific one.
  canUse(featureName, subscription) {
    return canUseWith(
      featureName,
      subscription === undefined ? currentSubscription : subscription,
      Date.now()
    );
  },

  entitlement(subscription) {
    return resolveEntitlement(
      subscription === undefined ? currentSubscription : subscription,
      Date.now()
    );
  },

  usableFeatures(subscription) {
    const sub = subscription === undefined ? currentSubscription : subscription;
    return Object.keys(FEATURE_REGISTRY).filter(key =>
      canUseWith(key, sub, Date.now())
    );
  },

  getSubscription() {
    return currentSubscription;
  },

  isLoaded() {
    return subscriptionLoaded;
  },

  // Exposed for tests/parity only.
  _resolveEntitlement: resolveEntitlement,
  _canUseWith: canUseWith
};
