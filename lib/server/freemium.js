/*
 * Server-authoritative freemium access and usage.
 *
 * Reuses public.ai_rate_limits + increment_rate_limit for repeatable usage
 * such as Coach messages. The one free initial plan is enforced from the
 * authoritative training_plans row, not a pre-AI counter that could survive a
 * terminated serverless request.
 */

import { ACCESS_STATES, resolveEntitlement } from "./features.js";
import { captureServerEvent } from "./productAnalytics.js";

export const FREE_LIMITS = Object.freeze({
  coach_message: Object.freeze({
    limit: 3,
    period: "week",
    endpoint: "free:coach_message"
  })
});

function headers() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
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

function usageWindow(limit, nowMs) {
  return limit.period === "lifetime"
    ? "1970-01-01T00:00:00.000Z"
    : mondayStartManila(nowMs);
}

export async function checkAccess(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!userId || !url || !key) {
    return { ok: false, accessState: ACCESS_STATES.FREE };
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
        "&select=*&limit=1",
      { headers: headers() }
    );
    if (!response.ok) {
      return { ok: false, accessState: ACCESS_STATES.FREE };
    }
    const rows = await response.json();
    const subscription = Array.isArray(rows) ? rows[0] || null : null;
    const entitlement = resolveEntitlement(subscription);
    return {
      ok: true,
      paid: entitlement.accessState === ACCESS_STATES.PAID_ACTIVE,
      accessState: entitlement.accessState,
      entitlement,
      subscription
    };
  } catch (error) {
    return { ok: false, accessState: ACCESS_STATES.FREE };
  }
}

export async function consumeFreeUsage(userId, usageType, nowMs = Date.now()) {
  const config = FREE_LIMITS[usageType];
  if (!config || !userId) {
    return { allowed: false, serviceUnavailable: true };
  }

  const access = await checkAccess(userId);
  if (!access.ok) {
    return { allowed: false, serviceUnavailable: true };
  }
  if (access.paid) {
    return {
      allowed: true,
      paid: true,
      accessState: ACCESS_STATES.PAID_ACTIVE
    };
  }

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
    return {
      allowed: result.allowed,
      paid: false,
      accessState: access.accessState,
      currentCount: Number(result.current_count) || 0,
      limit: config.limit,
      period: config.period,
      usageType,
      windowStart
    };
  } catch (error) {
    return { allowed: false, serviceUnavailable: true };
  }
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
  captureServerEvent(userId, "free_limit_reached", {
    feature: result?.feature || result?.usageType || "unknown",
    limit_period: result?.period || "feature"
  }).catch(() => {});
  return res.status(402).json({
    error: result?.error || (result?.limit
      ? `You've reached the free ${result.period} limit. Upgrade to Athlevo Performance to continue.`
      : "This feature is included with Athlevo Performance."),
    code: result?.code || "FREE_LIMIT_REACHED",
    title: result?.title || null,
    feature: result?.feature || result?.usageType || null,
    limit: result?.limit || null,
    period: result?.period || null,
    upgrade_required: true,
    action: result?.action || "upgrade",
    secondary_action: result?.secondaryAction || null
  });
}

export const FREEMIUM_VERSION = "freemium-v1";
