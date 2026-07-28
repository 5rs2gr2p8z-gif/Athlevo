/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Entitlement status endpoint
 * ══════════════════════════════════════════════════════════════════════
 *
 *  GET /api/trial/entitlement
 *
 *  Returns the normalized entitlement state for the authenticated user.
 *  The client uses this to display trial status, remaining time, and
 *  feature availability. Never exposes billing secrets.
 */

import {
  resolveAccessState, ACCESS_STATES, TRIAL_LIMITS
} from "../../lib/server/subscriptions.js";

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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "Method not allowed." });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return send(res, 500, { error: "Server not configured." });
  }

  const token = getBearerToken(req);
  if (!token) return send(res, 401, { error: "Not authenticated." });

  const user = await getAuthenticatedUser(token);
  if (!user || !user.id) return send(res, 401, { error: "Invalid session." });

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
