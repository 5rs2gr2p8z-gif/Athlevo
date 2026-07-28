/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Trial usage limit enforcement (server-side)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Enforces conservative trial limits via atomic database counters.
 *  Paid users bypass all trial limits. Only cardless-trial users are
 *  checked.
 *
 *  Limits:
 *    - 1 plan generation during entire trial
 *    - 5 coach messages per day
 *    - 1 AI workout analysis per day
 *    - 1 plan adjustment during entire trial
 *
 *  Concurrency: uses the Postgres RPC increment_trial_usage which locks
 *  the row FOR UPDATE, preventing parallel requests from bypassing limits.
 *
 *  Fail-closed for trial users: if the limiter errors, trial users are
 *  BLOCKED (not allowed). This is safer than fail-open for limited trials.
 */

import { TRIAL_LIMITS } from "./subscriptions.js";

function enc(s) { return encodeURIComponent(String(s)); }

/*
 * Check if the user is on a cardless trial.
 * Returns { isTrial, isExpired, subscriptionRow } or null on error.
 */
export async function getTrialStatus(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!userId || !supabaseUrl || !serviceKey) return null;

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/subscriptions?user_id=eq.${enc(userId)}&select=*&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json"
        }
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) return { isTrial: false, isExpired: false, subscriptionRow: null };

    const isCardlessTrial = row.provider === "athlevo_trial";
    if (!isCardlessTrial) {
      // Paid user — not subject to trial limits
      return { isTrial: false, isExpired: false, subscriptionRow: row };
    }

    const trialEnd = row.trial_end ? new Date(row.trial_end).getTime() : null;
    const isExpired = !trialEnd || trialEnd <= Date.now();

    return {
      isTrial: true,
      isExpired,
      subscriptionRow: row
    };
  } catch (e) {
    return null;
  }
}

/*
 * Check and increment a trial usage counter. Returns:
 *   { allowed: true, remaining, limit }
 *   { allowed: false, remaining: 0, limit, message }
 *
 * For non-trial users, always returns { allowed: true, bypass: true }.
 * For expired trial users, always returns { allowed: false }.
 */
export async function checkTrialLimit(userId, usageType) {
  const limit = TRIAL_LIMITS[usageType];
  if (limit === undefined) {
    return { allowed: false, message: "Unknown usage type." };
  }

  const status = await getTrialStatus(userId);

  // Error reading status — fail closed for safety
  if (status === null) {
    return { allowed: false, message: "Could not verify your trial status. Please try again." };
  }

  // Not a trial user — bypass all limits
  if (!status.isTrial) {
    return { allowed: true, bypass: true };
  }

  // Expired trial — block
  if (status.isExpired) {
    return {
      allowed: false,
      remaining: 0,
      limit,
      expired: true,
      message: "Your trial has ended. Upgrade to continue using this feature."
    };
  }

  // Active trial — check and increment atomically
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_trial_usage`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_usage_type: usageType,
        p_limit: limit
      })
    });

    if (!rpcRes.ok) {
      // RPC not available — fail closed for trial users
      return { allowed: false, message: "Could not check usage limits. Please try again." };
    }

    const result = await rpcRes.json();
    if (result && typeof result.allowed === "boolean") {
      if (!result.allowed) {
        return {
          allowed: false,
          remaining: 0,
          limit: result.limit || limit,
          current: result.current_count,
          message: trialLimitMessage(usageType, limit)
        };
      }
      return {
        allowed: true,
        remaining: Math.max(0, (result.limit || limit) - (result.current_count || 0)),
        limit: result.limit || limit,
        current: result.current_count
      };
    }

    // Unexpected response — fail closed
    return { allowed: false, message: "Could not verify usage limits." };
  } catch (e) {
    return { allowed: false, message: "Could not check usage limits. Please try again." };
  }
}

/*
 * User-facing limit messages — helpful, not punishing.
 */
function trialLimitMessage(usageType, limit) {
  switch (usageType) {
    case "plan_generation":
      return "You've used your trial plan generation. Upgrade to Athlevo Pro to generate more plans.";
    case "plan_adjustment":
      return "You've used your trial plan adjustment. Upgrade to Athlevo Pro for unlimited adjustments.";
    case "coach_message":
      return `You've reached your daily Coach message limit (${limit} per day during trial). Upgrade to Athlevo Pro for unlimited coaching.`;
    case "ai_analysis":
      return `You've reached your daily AI analysis limit (${limit} per day during trial). Upgrade to Athlevo Pro for unlimited analysis.`;
    default:
      return "You've reached your trial limit for this feature. Upgrade to continue.";
  }
}

/*
 * Standard 402 response for trial limit exceeded.
 */
export function trialLimitResponse(res, info) {
  return res.status(402).json({
    error: info.message || "Trial limit reached.",
    trial_limit_reached: true,
    usage_type: info.usage_type || null,
    remaining: 0,
    limit: info.limit || null,
    expired: info.expired || false,
    upgrade_url: null  // client knows the Whop URL
  });
}
