/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Managed plan guard (service-role IO)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Bridges the pure authority modules to the database. The plan-write
 *  endpoints (generate-plan, weekly-analysis, coach-action apply) call
 *  guardPlanWrite() BEFORE mutating training_sessions so a human coach's plan
 *  can never be silently overwritten by AI/athlete-triggered writes.
 *
 *  Fails SAFE: if mode/authority cannot be determined, it treats the athlete
 *  as human_coached-with-coach-owned-targets (i.e. blocks the direct write)
 *  rather than risk overwriting a coach plan. Self-guided athletes (no active
 *  assignment) are always allowed — their behaviour is unchanged.
 */

import { resolveCoachingMode } from "./coachingMode.js";
import { evaluatePlanWrite, isCoachOwned } from "./planAuthority.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function enc(v) { return encodeURIComponent(String(v)); }

async function sbSelect(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
    });
    if (!r.ok) return { ok: false, rows: [] };
    const data = await r.json();
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  } catch {
    return { ok: false, rows: [] };
  }
}

// Load the athlete's ACTIVE assignments (mode source).
async function loadAthleteAssignments(athleteId) {
  const { ok, rows } = await sbSelect(
    `coach_athlete_assignments?athlete_id=eq.${enc(athleteId)}` +
      `&select=id,coach_id,athlete_id,status,assigned_at`
  );
  return { ok, rows };
}

// Load the athlete's sessions on the target dates (to see which are coach-owned).
async function loadSessionsForDates(athleteId, dates) {
  const list = (dates || []).filter(Boolean);
  if (!list.length) return { ok: true, rows: [] };
  const inList = list.map(enc).join(",");
  return sbSelect(
    `training_sessions?user_id=eq.${enc(athleteId)}` +
      `&session_date=in.(${inList})&select=id,session_date,owner_type,source`
  );
}

/*
 * guardPlanWrite({ userId, targetDates, origin }) →
 *   {
 *     allowed,            // may the direct write proceed?
 *     mode,               // self_guided | human_coached
 *     intent,             // direct | ai_proposal | athlete_request
 *     coachOwnedDates,    // dates that are coach-owned (blocked from overwrite)
 *     reason              // categorical reason when blocked
 *   }
 *
 * origin: "ai" | "athlete" (who triggered the write).
 */
export async function guardPlanWrite({ userId, targetDates, origin }) {
  if (!userId) {
    return { allowed: false, mode: "human_coached", intent: "ai_proposal", coachOwnedDates: [], reason: "missing_user" };
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    // Cannot verify → fail safe (block direct overwrite). Self-guided users are
    // unaffected in practice because config is present in production.
    return { allowed: false, mode: "human_coached", intent: "ai_proposal", coachOwnedDates: [], reason: "unverifiable" };
  }

  const asg = await loadAthleteAssignments(userId);
  if (!asg.ok) {
    return { allowed: false, mode: "human_coached", intent: "ai_proposal", coachOwnedDates: [], reason: "assignment_lookup_failed" };
  }

  const { mode } = resolveCoachingMode(asg.rows, userId);
  if (mode === "self_guided") {
    // Unchanged behaviour: AI owns the plan.
    return { allowed: true, mode, intent: "direct", coachOwnedDates: [], reason: null };
  }

  // Human-coached: only block dates that are actually coach-owned.
  const sess = await loadSessionsForDates(userId, targetDates);
  if (!sess.ok) {
    return { allowed: false, mode, intent: origin === "athlete" ? "athlete_request" : "ai_proposal", coachOwnedDates: [], reason: "session_lookup_failed" };
  }
  const decision = evaluatePlanWrite({ mode, origin, sessions: sess.rows });
  const coachOwnedDates = sess.rows.filter(isCoachOwned).map(s => s.session_date);
  return {
    allowed: decision.allowed,
    mode,
    intent: decision.intent,
    coachOwnedDates,
    reason: decision.reason
  };
}

export const MANAGED_PLAN_VERSION = "managed-plan-v1";
