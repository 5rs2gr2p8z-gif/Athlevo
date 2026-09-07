/*
 * Server-authoritative freemium access and usage.
 *
 * Reuses public.ai_rate_limits + increment_rate_limit for repeatable usage
 * such as Coach messages. The one free initial plan is enforced from the
 * authoritative training_plans row, not a pre-AI counter that could survive a
 * terminated serverless request.
 */

import { ACCESS_STATES, resolveEntitlement } from "./features.js";
import { captureServerEventBestEffort } from "./productAnalytics.js";
import {
  getSupabaseAdminHeaders,
  getSupabaseServerKey
} from "./supabaseServer.js";

/*
 * Tier-scoped Coach message allowances (Free / Athlevo Pro). Athlevo Pro+
 * (plan_id "elite") is unlimited and never consults this table -- see
 * consumeFreeUsage below. Both counted tiers share a calendar-month window
 * so "10/month" and "30/month" mean what the pricing page says, not a
 * lifetime cap.
 */
export const TIER_LIMITS = Object.freeze({
  free: Object.freeze({
    coach_message: Object.freeze({
      limit: 10,
      period: "month",
      endpoint: "free:coach_message"
    })
  }),
  performance: Object.freeze({
    coach_message: Object.freeze({
      limit: 30,
      period: "month",
      endpoint: "pro:coach_message"
    })
  })
});

// Back-compat alias: existing imports (and tests) reference FREE_LIMITS for
// the Free-tier config specifically.
export const FREE_LIMITS = TIER_LIMITS.free;

function dateKey(value) {
  const key = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === key
    ? key
    : null;
}

function embeddedPlanSessions(plan) {
  const candidates = [
    plan?.sessions,
    plan?.week?.sessions,
    plan?.plan?.sessions,
    plan?.plan_payload?.sessions,
    plan?.week_payload?.sessions,
    plan?.weekly_plan?.sessions
  ];
  return candidates.find(value => Array.isArray(value)) || [];
}

/*
 * A training_plans row is only the free athlete's consumed initial plan when
 * it describes a plan the Train screen can actually use now. Placeholder,
 * failed, stale and sessionless rows must remain retryable.
 */
export function usableTrainingPlanSessions({
  plan,
  sessions = [],
  userId,
  currentWeekStart,
  currentWeekEnd
}) {
  if (!plan || String(plan.user_id || "") !== String(userId || "")) {
    return [];
  }

  const status = String(plan.status || "").toLowerCase();
  if (status !== "active" && status !== "current") {
    return [];
  }

  const planStart = dateKey(plan.week_start);
  const planEnd = dateKey(plan.week_end);
  const rangeStart = dateKey(currentWeekStart);
  const rangeEnd = dateKey(currentWeekEnd);
  if (
    !planStart || !planEnd || !rangeStart || !rangeEnd ||
    planStart > planEnd ||
    planStart > rangeStart ||
    planEnd < rangeEnd
  ) {
    return [];
  }

  const saved = (Array.isArray(sessions) ? sessions : []).filter(session => {
    const sessionDate = dateKey(session?.session_date);
    return (
      String(session?.user_id || "") === String(userId) &&
      String(session?.training_plan_id || "") === String(plan.id || "") &&
      sessionDate &&
      sessionDate >= rangeStart &&
      sessionDate <= rangeEnd
    );
  });
  if (saved.length > 0) return saved;

  // Some legacy plan rows carry their week inline rather than in
  // training_sessions. They count only when at least one dated prescription
  // can be displayed for the current week.
  return embeddedPlanSessions(plan).filter(session => {
    const sessionDate = dateKey(session?.session_date || session?.date);
    return session && typeof session === "object" &&
      sessionDate &&
      sessionDate >= rangeStart &&
      sessionDate <= rangeEnd;
  });
}

export function isUsableTrainingPlan(input) {
  return usableTrainingPlanSessions(input).length > 0;
}

function headers() {
  return getSupabaseAdminHeaders();
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function mondayStartManila(nowMs = Date.now()) {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const local = new Date(nowMs + MANILA_OFFSET_MS);
  const weekday = local.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const localMondayUtcMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysSinceMonday
  );
  return new Date(localMondayUtcMs - MANILA_OFFSET_MS).toISOString();
}

function monthStartManila(nowMs = Date.now()) {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const local = new Date(nowMs + MANILA_OFFSET_MS);
  const localMonthStartUtcMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    1
  );
  return new Date(localMonthStartUtcMs - MANILA_OFFSET_MS).toISOString();
}

function usageWindow(limit, nowMs) {
  if (limit.period === "lifetime") return "1970-01-01T00:00:00.000Z";
  if (limit.period === "month") return monthStartManila(nowMs);
  return mondayStartManila(nowMs);
}

/*
 * Release one previously-acquired free-usage reservation.
 *
 * PostgREST cannot express `request_count = request_count - 1` directly.
 * A conditional PATCH gives us a compare-and-swap loop instead: only the
 * caller that still sees the same count may decrement it. Concurrent
 * reservations/releases either succeed once or retry against the new count,
 * so no decrement is lost and no schema/RPC change is required.
 */
async function releaseUsageReservation(userId, config, windowStart) {
  const url = process.env.SUPABASE_URL;
  if (!url || !userId || !config || !windowStart) return false;

  const rowFilter =
    `user_id=eq.${enc(userId)}` +
    `&endpoint=eq.${enc(config.endpoint)}` +
    `&window_start=eq.${enc(windowStart)}`;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const read = await fetch(
        `${url}/rest/v1/ai_rate_limits?${rowFilter}&select=request_count&limit=1`,
        { headers: headers() }
      );
      if (!read.ok) return false;
      const rows = await read.json();
      const current = Number(Array.isArray(rows) && rows[0]?.request_count);
      if (!Number.isFinite(current)) return false;
      if (current <= 0) return true;

      const update = await fetch(
        `${url}/rest/v1/ai_rate_limits?${rowFilter}` +
          `&request_count=eq.${current}`,
        {
          method: "PATCH",
          headers: {
            ...headers(),
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            request_count: current - 1,
            updated_at: new Date().toISOString()
          })
        }
      );
      if (!update.ok) return false;
      const updatedRows = await update.json();
      if (Array.isArray(updatedRows) && updatedRows.length === 1) return true;
      // Another reservation/release won the comparison. Read and retry.
    } catch (error) {
      return false;
    }
  }
  return false;
}

export async function checkAccess(userId) {
  const url = process.env.SUPABASE_URL;
  const key = getSupabaseServerKey();
  if (!userId || !url || !key) {
    return { ok: false, accessState: ACCESS_STATES.FREE };
  }

  try {
    // Try ensure_free_trial RPC first (creates/backfills trial_started_at).
    // Falls back to plain SELECT if the RPC is not yet deployed.
    let subscription = null;
    try {
      const rpcResponse = await fetch(
        `${url}/rest/v1/rpc/ensure_free_trial`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ p_user_id: userId })
        }
      );
      if (rpcResponse.ok) {
        const rpcRows = await rpcResponse.json();
        subscription = Array.isArray(rpcRows) ? rpcRows[0] || null : null;
      }
    } catch (rpcErr) { /* fallback below */ }

    if (!subscription) {
      const response = await fetch(
        `${url}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
          "&select=*&limit=1",
        { headers: headers() }
      );
      if (!response.ok) {
        return { ok: false, accessState: ACCESS_STATES.FREE };
      }
      const rows = await response.json();
      subscription = Array.isArray(rows) ? rows[0] || null : null;
    }

    const entitlement = resolveEntitlement(subscription);
    return {
      ok: true,
      paid: entitlement.accessState === ACCESS_STATES.PAID_ACTIVE,
      isPerformanceTrial: entitlement.isPerformanceTrial === true,
      accessState: entitlement.accessState,
      entitlement,
      subscription
    };
  } catch (error) {
    return { ok: false, accessState: ACCESS_STATES.FREE };
  }
}

/*
 * Resolves which counted allowance (if any) applies right now.
 *   - Athlevo Pro+ (plan_id "elite"): unlimited, no counter consulted.
 *   - Athlevo Pro (plan_id "performance"/"essentials"/"founding_beta") and
 *     any other recognised-paid tier: the Pro monthly allowance.
 *   - Free (including the 24h performance trial, which keeps the Coach
 *     limit): the Free monthly allowance.
 * Returns null for unlimited access.
 */
function tierLimitConfig(usageType, access) {
  const planId = String(access?.entitlement?.planId || "free").toLowerCase();
  if (access.paid && !access.isPerformanceTrial) {
    if (planId === "elite") return null; // Athlevo Pro+ -- unlimited
    return TIER_LIMITS.performance[usageType] || null;
  }
  return TIER_LIMITS.free[usageType] || null;
}

export async function consumeFreeUsage(userId, usageType, nowMs = Date.now()) {
  if (!userId || !(usageType in TIER_LIMITS.free)) {
    return { allowed: false, serviceUnavailable: true };
  }

  const access = await checkAccess(userId);
  if (!access.ok) {
    return { allowed: false, serviceUnavailable: true };
  }

  const config = tierLimitConfig(usageType, access);
  if (!config) {
    // Athlevo Pro+ (or any tier with no configured cap): unlimited.
    return {
      allowed: true,
      paid: true,
      unlimited: true,
      planId: access.entitlement?.planId || "elite",
      accessState: ACCESS_STATES.PAID_ACTIVE
    };
  }

  const planId = access.entitlement?.planId || "free";
  const url = process.env.SUPABASE_URL;
  const windowStart = usageWindow(config, nowMs);
  try {
    const response = await fetch(
      `${url}/rest/v1/rpc/increment_rate_limit`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          p_user_id: userId,
          p_endpoint: config.endpoint,
          p_window_start: windowStart,
          p_limit: config.limit
        })
      }
    );
    if (!response.ok) {
      return { allowed: false, serviceUnavailable: true };
    }
    const result = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.allowed !== "boolean"
    ) {
      return { allowed: false, serviceUnavailable: true };
    }
    const usage = {
      allowed: result.allowed,
      paid: access.paid === true,
      planId,
      accessState: access.accessState,
      currentCount: Number(result.current_count) || 0,
      limit: config.limit,
      period: config.period,
      usageType,
      windowStart
    };
    // increment_rate_limit increments even when it returns allowed:false.
    // A blocked request is not usage, so immediately release that reservation.
    if (!usage.allowed) {
      const released = await releaseUsageReservation(
        userId,
        config,
        windowStart
      );
      usage.currentCount = released
        ? Math.max(0, usage.currentCount - 1)
        : usage.currentCount;
    }
    return usage;
  } catch (error) {
    return { allowed: false, serviceUnavailable: true };
  }
}

export async function releaseFreeUsage(userId, usageType, reservation) {
  if (
    !userId ||
    !reservation ||
    reservation.unlimited === true ||
    reservation.allowed !== true ||
    !reservation.windowStart
  ) {
    return false;
  }
  const config = reservation.paid
    ? TIER_LIMITS.performance[usageType]
    : TIER_LIMITS.free[usageType];
  if (!config) return false;
  return releaseUsageReservation(userId, config, reservation.windowStart);
}

export async function requirePaidAccess(userId, feature) {
  const access = await checkAccess(userId);
  if (!access.ok) {
    return { allowed: false, serviceUnavailable: true, feature };
  }
  return {
    allowed: access.paid === true,
    paid: access.paid === true,
    accessState: access.accessState,
    feature
  };
}

export function accessResponse(res, result, userId) {
  if (result?.serviceUnavailable) {
    return res.status(503).json({
      error: "We couldn't verify access right now. Please try again.",
      code: "ACCESS_UNAVAILABLE"
    });
  }
  captureServerEventBestEffort(userId, "free_limit_reached", {
    feature: result?.feature || result?.usageType || "unknown",
    limit_period: result?.period || "feature"
  });
  return res.status(402).json({
    error: result?.error || (result?.limit
      ? `You've reached the free ${result.period} limit. Upgrade to Athlevo Pro to continue.`
      : "This feature is included with Athlevo Pro."),
    code: result?.code || "FREE_LIMIT_REACHED",
    title: result?.title || null,
    feature: result?.feature || result?.usageType || null,
    limit: result?.limit || null,
    period: result?.period || null,
    upgrade_required: true,
    // Which paid tier already applies. A Free athlete hitting their limit
    // has paid:false (offer Athlevo Pro); an Athlevo Pro athlete hitting
    // their (higher) limit has paid:true (offer Athlevo Pro+).
    paid: result?.paid === true,
    upgrade_target: result?.paid === true ? "pro_plus" : "pro",
    action: result?.action || "upgrade",
    secondary_action: result?.secondaryAction || null
  });
}

export const FREEMIUM_VERSION = "freemium-v1";
