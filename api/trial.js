/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Cardless trial endpoint
 * ══════════════════════════════════════════════════════════════════════
 *
 *  GET  /api/trial — normalized entitlement
 *  POST /api/trial — idempotently start the cardless trial
 *
 *  Both methods authenticate with the verified Supabase JWT. All subscription
 *  and trial writes use the service role exclusively on the server.
 */

import {
  resolveAccessState, ACCESS_STATES, TRIAL_LIMITS
} from "../lib/server/subscriptions.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

function send(res, code, body) { return res.status(code).json(body); }
function enc(s) { return encodeURIComponent(String(s)); }

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

async function getAuthenticatedUser(accessToken) {
  if (!SUPABASE_URL || !SERVICE_KEY || !accessToken) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` }
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function handleEntitlement(req, res, user) {
  try {
    // Load subscription with service role
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${enc(user.id)}&select=*&limit=1`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    let subscriptionRow = null;
    if (subRes.ok) {
      const rows = await subRes.json();
      subscriptionRow = Array.isArray(rows) && rows[0] ? rows[0] : null;
    }

    const state = resolveAccessState(subscriptionRow, Date.now());

    // Load trial usage if in trial
    let usage = null;
    if (state.access_state === ACCESS_STATES.TRIAL_ACTIVE) {
      try {
        const usageRes = await fetch(
          `${SUPABASE_URL}/rest/v1/trial_usage?user_id=eq.${enc(user.id)}&select=*&limit=1`,
          {
            headers: {
              apikey: SERVICE_KEY,
              Authorization: `Bearer ${SERVICE_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );
        if (usageRes.ok) {
          const usageRows = await usageRes.json();
          const row = Array.isArray(usageRows) && usageRows[0] ? usageRows[0] : null;
          if (row) {
            // Reset daily counters in response if date has changed
            const today = new Date().toISOString().slice(0, 10);
            usage = {
              plans_generated: row.plans_generated || 0,
              plan_adjustments: row.plan_adjustments || 0,
              coach_messages_today: row.coach_messages_date === today ? (row.coach_messages_today || 0) : 0,
              ai_analyses_today: row.ai_analyses_date === today ? (row.ai_analyses_today || 0) : 0,
              daily_briefs_today: row.daily_briefs_date === today ? (row.daily_briefs_today || 0) : 0
            };
          }
        }
      } catch (e) { /* usage display is best-effort */ }
    }

    return send(res, 200, {
      access_state: state.access_state,
      tier: state.tier,
      plan_id: state.plan_id,
      trial_ends_at: state.trial_ends_at || null,
      trial_seconds_remaining: state.trial_seconds_remaining || 0,
      paid_plan: state.paid_plan || null,
      is_cardless_trial: state.is_cardless_trial || false,
      trial_limits: state.access_state === ACCESS_STATES.TRIAL_ACTIVE ? TRIAL_LIMITS : null,
      trial_usage: usage
    });
  } catch (err) {
    console.error("[trial/entitlement] Error:", err && err.message);
    return send(res, 500, { error: "Could not check entitlement." });
  }
}

async function handleStart(req, res, user) {
  try {
    const rpcRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/start_cardless_trial`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ p_user_id: user.id })
      }
    );

    if (!rpcRes.ok) {
      const text = await rpcRes.text();
      console.error("[trial/start] RPC failed:", rpcRes.status, text);
      return send(res, 503, {
        ok: false,
        code: "TRIAL_START_FAILED",
        error: "We couldn't start your trial. Please try again."
      });
    }

    const result = await rpcRes.json();
    if (!result || typeof result !== "object") {
      console.error("[trial/start] RPC returned an invalid response.");
      return send(res, 503, {
        ok: false,
        code: "TRIAL_START_FAILED",
        error: "We couldn't start your trial. Please try again."
      });
    }

    const trialEnd = result.trial_end
      ? new Date(result.trial_end).getTime()
      : null;
    const hasActiveTrial =
      result.created === true ||
      (
        result.reason === "trial_already_exists" &&
        result.status === "trialing" &&
        Number.isFinite(trialEnd) &&
        trialEnd > Date.now()
      );
    const alreadyPaid = result.reason === "already_paid";

    if (!hasActiveTrial && !alreadyPaid) {
      return send(res, 409, {
        ok: false,
        code: "TRIAL_UNAVAILABLE",
        error: "This account isn't eligible for another free trial."
      });
    }

    // Server event is authoritative and only fires for a newly created trial.
    if (result && result.created === true) {
      try {
        const phKey = process.env.POSTHOG_KEY;
        const phHost =
          process.env.POSTHOG_HOST || "https://us.i.posthog.com";
        if (phKey) {
          fetch(phHost + "/capture/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: phKey,
              distinct_id: user.id,
              event: "trial_started",
              properties: {
                source: "cardless_trial",
                trial_days: 3,
                access_state: "trial_active"
              }
            })
          }).catch(() => {});
        }
      } catch (error) {
        // Analytics never blocks trial creation.
      }
    }

    return send(res, 200, {
      ok: true,
      created: result.created === true,
      reason: result.reason || null,
      access_state: alreadyPaid ? "paid_active" : "trial_active",
      trial_ends_at: result.trial_end || null,
      plan_id: result.plan_id || null
    });
  } catch (error) {
    console.error("[trial/start] Unexpected error:", error?.message);
    return send(res, 500, { error: "Could not start trial." });
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Method not allowed." });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return send(res, 500, { error: "Server not configured." });
  }

  const token = getBearerToken(req);
  if (!token) return send(res, 401, { error: "Not authenticated." });

  const user = await getAuthenticatedUser(token);
  if (!user?.id) return send(res, 401, { error: "Invalid session." });

  return req.method === "GET"
    ? handleEntitlement(req, res, user)
    : handleStart(req, res, user);
}
