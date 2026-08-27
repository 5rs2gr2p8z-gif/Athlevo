console.log("Athlevo Plan/Features Loaded");

/*
 * Client mirror of lib/server/features.js. PLAN_TIERS, FEATURE_REGISTRY,
 * resolveEntitlement, and canUse are kept byte-for-byte identical to the
 * server so UI gating matches server enforcement. Paid access comes from
 * recognised paid providers (Whop, PayMongo, or admin-managed GCash manual); all
 * other users retain the free tier.
 *
 * Usage:
 *   await AthlevoPlan.load();                 // fetch the subscription
 *   if (AthlevoPlan.canUse("workout_modifications")) { ... }
 */

const PLAN_TIERS = {
  free: 0,
  essentials: 1,
  performance: 2,
  founding_beta: 2,           // legacy stored value; never grants access itself
  elite: 3
};

const PLAN_ORDER = ["free", "essentials", "performance", "founding_beta", "elite"];

/*
 * Providers whose subscription rows may grant paid access.
 * "whop"         — Whop webhook writes these rows automatically.
 * "gcash_manual" — Admin-managed GCash payments; period_end enforced at read time.
 * "paymongo"     — Verified hosted-checkout payments; paid_until enforced at read time.
 * Any provider NOT in this set is treated as free regardless of plan_id.
 */
const PAID_PROVIDERS = new Set(["whop", "gcash_manual", "paymongo"]);

const ACCESS_STATES = Object.freeze({
  FREE: "free",
  PAID_ACTIVE: "paid_active",
  PAID_INACTIVE: "paid_inactive"
});

const FEATURE_REGISTRY = {
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

  if (
    planId === "free" ||
    paidTier === 0 ||
    !recognisedPaid
  ) {
    // ── 24-hour performance trial for free users ──────────────────
    var trialStart = toTime(subscription.trial_started_at);
    var TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;
    if (trialStart && (trialStart + TRIAL_DURATION_MS) > now) {
      return {
        accessState: ACCESS_STATES.PAID_ACTIVE,
        planId: "performance",
        tier: tierOf("performance"),
        status: "trialing",
        entitled: true,
        inGrace: false,
        isFounder: isFounder,
        reason: "performance_trial",
        isPerformanceTrial: true,
        trialExpiresAt: new Date(trialStart + TRIAL_DURATION_MS).toISOString()
      };
    }
    return Object.assign({}, free, { planId: planId, isFounder: isFounder });
  }

  const periodEnd = toTime(subscription.current_period_end);
  const paidUntil = toTime(subscription.paid_until);
  const effectivePaidEnd = Math.max(periodEnd || 0, paidUntil || 0) || null;
  const graceUntil = toTime(subscription.grace_until);

  const keep = (reason, extra) =>
    Object.assign(
      {
        planId,
        accessState: ACCESS_STATES.PAID_ACTIVE,
        tier: paidTier,
        status,
        entitled: true,
        inGrace: false,
        isFounder,
        reason
      },
      extra || {}
    );

  const downgrade = reason => ({
    accessState: ACCESS_STATES.PAID_INACTIVE,
    planId,
    tier: 0,
    status: "expired",
    entitled: true,
    inGrace: false,
    isFounder,
    reason,
    effectivePaidPlan: planId
  });

  // paid_until is an independent, verified prepaid entitlement lane. It must
  // survive Whop cancellation/refund lifecycle updates to the shared row.
  if (paidUntil && paidUntil > now) {
    return keep("prepaid_active", { effectivePaidEnd: effectivePaidEnd });
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
      return effectivePaidEnd && effectivePaidEnd > now
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
let subscriptionLoadFailed = false;

async function loadSubscription() {
  subscriptionLoadFailed = false;
  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) {
      currentSubscription = null;
      subscriptionLoaded = true;
      return null;
    }

    // Diagnostic-acquisition users must NOT receive a 24-hour trial.
    // isDiagnosticAcquisition checks the durable athlete_diagnostics table,
    // so this survives refresh, OAuth, and cross-session loads.
    let skipTrialRpc = false;
    try {
      if (window.AthlevoDiagnosticAcquisition &&
          typeof window.AthlevoDiagnosticAcquisition.isDiagnosticAcquisition === "function") {
        skipTrialRpc = await window.AthlevoDiagnosticAcquisition.isDiagnosticAcquisition(
          user.id, supabaseClient
        );
      }
    } catch (e) { /* non-fatal; fall through to trial RPC */ }

    // ensure_free_trial creates a subscription row with trial_started_at
    // if none exists, or backfills trial_started_at on existing rows.
    // Falls back to a plain SELECT if the RPC is not yet deployed.
    // Skipped entirely for diagnostic-acquisition users (paid-first path).
    let data = null;
    let error = null;
    if (skipTrialRpc) {
      // Plain SELECT — no trial creation for diagnostic-acquisition users.
      const directRead = await supabaseClient
        .from("subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      data = directRead.data;
      error = directRead.error;
    } else {
      try {
        const rpcResult = await supabaseClient
          .rpc("ensure_free_trial", { p_user_id: user.id })
          .maybeSingle();
        data = rpcResult.data;
        error = rpcResult.error;
      } catch (rpcErr) {
        // RPC not deployed yet — fall back to plain SELECT
        data = null;
        error = { message: "rpc_fallback" };
      }
      if (error) {
        // Fallback: plain SELECT (pre-migration or RPC unavailable)
        const fallback = await supabaseClient
          .from("subscriptions")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();
        data = fallback.data;
        error = fallback.error;
      }
    }

    if (error) {
      console.warn("Subscription load failed; access remains unresolved.");
      currentSubscription = null;
      subscriptionLoaded = false;
      subscriptionLoadFailed = true;
    } else {
      currentSubscription = data || null;
      subscriptionLoaded = true;
    }
    // Render trial countdown if active
    try {
      if (window.AthlevoAccessGuard &&
          typeof window.AthlevoAccessGuard.renderTrialIndicator === "function") {
        window.AthlevoAccessGuard.renderTrialIndicator();
      }
    } catch (e) {}
    return currentSubscription;
  } catch (error) {
    console.warn("Subscription load error; access remains unresolved.");
    currentSubscription = null;
    subscriptionLoaded = false;
    subscriptionLoadFailed = true;
    return null;
  }
}

window.AthlevoPlan = {
  ACCESS_STATES,
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

  loadFailed() {
    return subscriptionLoadFailed;
  },

  // Exposed for tests/parity only.
  _resolveEntitlement: resolveEntitlement,
  _canUseWith: canUseWith
};
