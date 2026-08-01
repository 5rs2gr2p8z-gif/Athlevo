/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Athlete coaching mode API   ·   /api/athlete-mode
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The authoritative source of an athlete's coaching mode for the client. The
 *  browser NEVER decides the mode — it asks this endpoint, which resolves it
 *  server-side from the athlete's own active assignments. Also exposes the SAFE
 *  coach profile and the athlete's plan-change requests, and lets the athlete
 *  file an adjustment request (a safe, non-authoritative action).
 *
 *  Actions:
 *    · mode                (GET)  — coaching_mode + safe coach + transition
 *    · request_adjustment  (POST) — athlete files an athlete_request
 *
 *  Never returns coach email (unless explicitly public), tokens, or payments.
 */

import { resolveCoachingMode, buildSafeCoachProfile } from "../lib/server/coachingMode.js";
import { stripClientAuthorityFields } from "../lib/server/planAuthority.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sendJson(res, code, body) { return res.status(code).json(body); }
function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
function enc(v) { return encodeURIComponent(String(v)); }

async function getAuthenticatedUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function sbSelect(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return sendJson(res, 500, { error: "Server is not configured." });
  const token = bearer(req);
  if (!token) return sendJson(res, 401, { error: "Authentication is required." });
  const user = await getAuthenticatedUser(token);
  if (!user || !user.id) return sendJson(res, 401, { error: "Your session is invalid or expired." });

  const action = (req.query && req.query.action) || "mode";

  // The athlete may only ever see THEIR OWN assignment — scoped to user.id.
  const assignments = await sbSelect(
    `coach_athlete_assignments?athlete_id=eq.${enc(user.id)}` +
      `&select=id,coach_id,athlete_id,status,assigned_at`
  );
  const resolved = resolveCoachingMode(assignments, user.id);

  try {
    if (action === "mode") {
      let coach = null;
      let transition = null;
      if (resolved.mode === "human_coached" && resolved.coachId) {
        // Safe coach profile ONLY — never email/tokens/business fields.
        const rows = await sbSelect(
          `profiles?id=eq.${enc(resolved.coachId)}&select=full_name,coaching_title`
        );
        coach = buildSafeCoachProfile(rows[0] || {}, resolved.assignment);
        const tr = await sbSelect(
          `coaching_transitions?athlete_id=eq.${enc(user.id)}&coach_id=eq.${enc(resolved.coachId)}` +
            `&state=neq.resolved&select=state,effective_date,ai_plan_detected&limit=1`
        );
        transition = tr[0] || null;
      }
      return sendJson(res, 200, {
        coaching_mode: resolved.mode,
        assignment_status: resolved.assignment ? resolved.assignment.status : "none",
        ambiguous: resolved.ambiguous,
        coach,
        transition
      });
    }

    if (action === "request_adjustment") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
      if (resolved.mode !== "human_coached") {
        return sendJson(res, 400, { error: "Adjustment requests are only available when a coach manages your plan." });
      }
      const body = stripClientAuthorityFields(req.body || {});
      const requestType = String(body.request_type || "adjustment");
      const allowed = ["adjustment", "unable_to_complete", "move", "feedback", "availability"];
      const safeType = allowed.includes(requestType) ? requestType : "adjustment";
      // Server sets athlete_id, coach_id, origin — the client cannot forge them.
      const row = {
        athlete_id: user.id,
        coach_id: resolved.coachId,
        session_date: body.session_date || null,
        origin: "athlete_request",
        request_type: safeType,
        status: "pending",
        payload: body.payload && typeof body.payload === "object" ? body.payload : null,
        created_by: user.id
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/managed_plan_change_requests`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json", Prefer: "return=minimal"
        },
        body: JSON.stringify(row)
      });
      if (!r.ok) return sendJson(res, 500, { error: "Your request could not be sent. Please try again." });
      return sendJson(res, 200, { requested: true, request_type: safeType });
    }

    return sendJson(res, 400, { error: "Unknown action." });
  } catch (err) {
    return sendJson(res, 500, { error: "Could not load your coaching status." });
  }
}
