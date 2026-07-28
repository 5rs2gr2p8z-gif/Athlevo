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
  founding_beta: 2,           // same access as performance; temporary grant
  elite: 3
};

const PLAN_ORDER = ["free", "essentials", "performance", "founding_beta", "elite"];

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
    isFoundingBeta: false,
    reason: "free"
  };

  if (!subscription || typeof subscription !== "object") {
    return free;
  }

  const planId = String(subscription.plan_id || "free").toLowerCase();
  const paidTier = tierOf(planId);
  const status = String(subscription.status || "active").toLowerCase();
  const isFounder = subscription.is_founder === true;
  const isFoundingBeta = planId === "founding_beta";

  if (planId === "free" || paidTier === 0) {
    return Object.assign({}, free, { planId: planId, isFounder: isFounder, isFoundingBeta: false });
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
        isFoundingBeta,
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
    isFoundingBeta,
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
    updateFoundingBetaBanner();
    return currentSubscription;
  } catch (error) {
    console.warn("Subscription load error; defaulting to Free:", error);
    currentSubscription = null;
    subscriptionLoaded = true;
    updateFoundingBetaBanner();
    return null;
  }
}

/*
 * Show/hide the Founding Beta banner on the You screen.
 * Called once after subscription load — not on every navigation.
 */
function updateFoundingBetaBanner() {
  try {
    const banner = document.getElementById("foundingBetaBanner");
    const detail = document.getElementById("foundingBetaDetail");
    if (!banner) return;

    const ent = resolveEntitlement(currentSubscription, Date.now());
    if (ent.isFoundingBeta && ent.tier > 0) {
      const endDate = currentSubscription && currentSubscription.current_period_end;
      let dateStr = "—";
      if (endDate) {
        try {
          dateStr = new Date(endDate).toLocaleDateString("en-PH", {
            month: "short", day: "numeric", year: "numeric"
          });
        } catch (e) { dateStr = String(endDate).slice(0, 10); }
      }
      if (detail) detail.textContent = "Full access until " + dateStr;
      banner.style.display = "block";
    } else {
      banner.style.display = "none";
    }
  } catch (e) { /* never break the app for a UI badge */ }
}

/*
 * ── Server-authoritative entitlement (cardless trial + Whop) ────────
 * Fetches the normalized access state from the server. This is the
 * ONLY source of truth for trial status, remaining time, and limits.
 * The local subscription cache is still used for feature gating (canUse)
 * but the trial UI reads from this server response.
 */
let serverEntitlement = null;

async function loadServerEntitlement() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session || !session.access_token) return null;
    const res = await fetch("/api/trial", {
      headers: { Authorization: "Bearer " + session.access_token }
    });
    if (!res.ok) return null;
    serverEntitlement = await res.json();
    return serverEntitlement;
  } catch (e) {
    return null;
  }
}

/*
 * Start the cardless trial via the server endpoint.
 * Returns a structured result for both success and failure so onboarding can
 * stop safely instead of treating a failed request as a reason to show Whop.
 */
async function startCardlessTrial() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session || !session.access_token) {
      return {
        ok: false,
        status: 401,
        code: "AUTH_REQUIRED",
        error: "Your session expired. Please sign in again and retry."
      };
    }
    const res = await fetch("/api/trial", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      }
    });
    let result = null;
    try { result = await res.json(); } catch (e) { /* handled below */ }
    if (!res.ok || !result || result.ok !== true) {
      return {
        ok: false,
        status: res.status,
        code: (result && result.code) || "TRIAL_START_FAILED",
        error: (result && result.error) ||
          "We couldn't start your trial. Please try again."
      };
    }
    // Seed the authoritative cache immediately. A successful POST must not
    // become a paywall merely because the follow-up refresh is slow or fails.
    serverEntitlement = {
      access_state: result.access_state,
      plan_id: result.plan_id || null,
      trial_ends_at: result.trial_ends_at || null,
      is_cardless_trial: result.access_state === "trial_active"
    };
    // Refresh both caches after trial start
    await loadSubscription();
    await loadServerEntitlement();
    return Object.assign({ status: res.status }, result);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      code: "TRIAL_START_UNREACHABLE",
      error: "We couldn't reach the trial service. Check your connection and try again."
    };
  }
}

window.AthlevoPlan = {
  PLAN_TIERS,
  PLAN_ORDER,
  FEATURE_REGISTRY,

  load: loadSubscription,
  loadEntitlement: loadServerEntitlement,
  startCardlessTrial,

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

  /*
   * Server-authoritative access state. Returns the cached server
   * entitlement, or null if not yet loaded.
   */
  accessState() {
    return serverEntitlement;
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
