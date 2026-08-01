/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach Dashboard API   ·   /api/coach-dashboard
 * ══════════════════════════════════════════════════════════════════════
 *
 *  THE authorization boundary for the coach dashboard. RLS protects the
 *  database; this endpoint enforces role + ACTIVE assignment and returns only
 *  sanitized data. Named coach-dashboard (not coach) to avoid colliding with
 *  the AI-coach endpoint api/coach.js.
 *
 *  Actions (?action=):
 *    · roster   (GET)  — the coach's assigned athletes + attention statuses
 *    · athlete  (GET)  — one assigned athlete's sanitized overview
 *    · review   (POST) — record that the coach reviewed an alert (upsert)
 *
 *  Security invariants (all enforced server-side, never trusting the client):
 *    · role is read from the caller's OWN profiles.role (service role)
 *    · a client-supplied athlete_id is authorized against the caller's ACTIVE
 *      assignments before ANY athlete data is loaded
 *    · provider tokens / payment rows are never selected or returned
 *    · the service-role key never leaves the server
 */

import { canAccessCoachDashboard, resolveRole } from "../lib/server/coachRoles.js";
import {
  assignedAthleteIds,
  canCoachAccessAthlete
} from "../lib/server/coachAssignments.js";
import { classifyAttention } from "../lib/server/attentionClassifier.js";
import {
  buildRosterEntry,
  buildAthleteOverview,
  deriveLastActiveAt
} from "../lib/server/coachSanitize.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sendJson(res, code, body) {
  return res.status(code).json(body);
}

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function getAuthenticatedUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

// Service-role SELECT helper. Returns [] on failure (never throws to caller).
async function sbSelect(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function enc(v) {
  return encodeURIComponent(String(v));
}

async function loadCoachProfile(userId) {
  const rows = await sbSelect(
    `profiles?id=eq.${enc(userId)}&select=id,role,full_name`
  );
  return rows[0] || null;
}

async function loadActiveAssignments(coachId) {
  return sbSelect(
    `coach_athlete_assignments?coach_id=eq.${enc(coachId)}&status=eq.active` +
      `&select=id,coach_id,athlete_id,status,permission_level,assigned_at`
  );
}

// Assemble a bounded per-athlete data bundle from service-role reads. Provider
// tokens are never selected — only last_sync_at / last_sync_status.
async function loadAthleteBundle(athleteId) {
  const idf = enc(athleteId);
  const [profile, metrics, weekly, readiness, today, latestAct, provider] =
    await Promise.all([
      sbSelect(`profiles?id=eq.${idf}&select=id,full_name,primary_sport,goal,target_race,target_race_date,race_type,experience_level`),
      sbSelect(`athlete_metrics?user_id=eq.${idf}&select=weekly_training_load,weekly_distance,fatigue_score,fitness_score,last_updated`),
      sbSelect(`weekly_progress_summaries?user_id=eq.${idf}&select=planned_duration_minutes,completed_duration_minutes,planned_distance_km,completed_distance_km,recovery_status,consistency_status,injury_risk_status,trajectory_status,week_start&order=week_start.desc&limit=1`),
      sbSelect(`daily_readiness?user_id=eq.${idf}&select=readiness_date,sleep_quality,energy,muscle_soreness,mental_stress,pain_present,pain_severity&order=readiness_date.desc&limit=1`),
      sbSelect(`training_sessions?user_id=eq.${idf}&select=title,session_type,session_date,duration_minutes,distance_km,sport,status&order=session_date.asc&limit=50`),
      sbSelect(`activities?user_id=eq.${idf}&select=start_date,sport_type,activity_type,source,distance_meters,moving_time_seconds,average_cadence,trainer,raw_data&order=start_date.desc&limit=8`),
      sbSelect(`provider_accounts?user_id=eq.${idf}&select=provider,last_sync_at,last_sync_status`)
    ]);
  return {
    profile: profile[0] || {},
    metrics: metrics[0] || {},
    weeklySummary: weekly[0] || {},
    readiness: readiness[0] || {},
    trainingSessions: today,
    activities: latestAct,
    providerAccount: provider[0] || {}
  };
}

// Compute a wearable-free readiness score (0-100) from the athlete's own raw
// check-in answers only — never fabricated. Null when nothing was reported.
function readinessScoreFrom(rd) {
  if (!rd) return null;
  const energy = Number(rd.energy);        // 1..10
  const soreness = Number(rd.muscle_soreness); // 1..10 (higher = worse)
  const stress = Number(rd.mental_stress);     // 1..10 (higher = worse)
  const sleep = Number(rd.sleep_quality);      // 1..5
  const parts = [];
  if (Number.isFinite(energy)) parts.push((energy / 10) * 100);
  if (Number.isFinite(soreness)) parts.push(((11 - soreness) / 10) * 100);
  if (Number.isFinite(stress)) parts.push(((11 - stress) / 10) * 100);
  if (Number.isFinite(sleep)) parts.push((sleep / 5) * 100);
  if (!parts.length) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

function todaySession(sessions, nowIso) {
  const today = String(nowIso).slice(0, 10);
  return (sessions || []).find(s => String(s.session_date || "").slice(0, 10) === today) || null;
}

// Build the classifier snapshot from a loaded bundle.
function buildSnapshot(bundle, nowIso) {
  const rd = bundle.readiness || {};
  const w = bundle.weeklySummary || {};
  const prov = bundle.providerAccount || {};
  const acts = bundle.activities || [];
  const lastActivityAt = acts.length ? acts[0].start_date : null;
  const lastReadinessAt = rd.readiness_date ? rd.readiness_date + "T12:00:00Z" : null;
  const lastSyncAt = prov.last_sync_at || null;
  const lastActiveAt = deriveLastActiveAt([lastActivityAt, lastReadinessAt, lastSyncAt]);

  return {
    lastActivityAt,
    lastReadinessAt,
    lastActiveAt,
    lastSyncAt,
    readiness: {
      painPresent: rd.pain_present === true,
      painDate: rd.readiness_date || null,
      readinessScore: readinessScoreFrom(rd),
      checkInDate: rd.readiness_date || null
    },
    recoveryStatus: w.recovery_status || "unknown",
    targetEventDate: (bundle.profile && bundle.profile.target_race_date) || null,
    syncFailed: String(prov.last_sync_status || "").toLowerCase() === "failed",
    planMissing: !(bundle.trainingSessions && bundle.trainingSessions.length),
    hasAnyData: Boolean(lastActivityAt || lastReadinessAt || (bundle.metrics && bundle.metrics.last_updated))
  };
}

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return sendJson(res, 500, { error: "Server is not configured." });
  }

  const token = bearer(req);
  if (!token) return sendJson(res, 401, { error: "Authentication is required." });

  const user = await getAuthenticatedUser(token);
  if (!user || !user.id) return sendJson(res, 401, { error: "Your session is invalid or expired." });

  // Role is read from the caller's OWN profile — server-authoritative.
  const profile = await loadCoachProfile(user.id);
  if (!canAccessCoachDashboard(profile)) {
    // Athletes and unknown roles never reach coach data.
    return sendJson(res, 403, { error: "Coach access is required.", role: resolveRole(profile) });
  }

  const assignments = await loadActiveAssignments(user.id);
  const action = (req.query && req.query.action) || "roster";
  const nowIso = new Date().toISOString();

  try {
    if (action === "roster") {
      const ids = assignedAthleteIds(assignments, user.id);
      if (!ids.length) {
        return sendJson(res, 200, { role: resolveRole(profile), athletes: [], roster_size: 0 });
      }
      const reviews = await sbSelect(
        `coach_attention_reviews?coach_id=eq.${enc(user.id)}&select=athlete_id,alert_key,reviewed_at`
      );
      const athletes = [];
      for (const athleteId of ids) {
        const bundle = await loadAthleteBundle(athleteId);
        const snapshot = buildSnapshot(bundle, nowIso);
        const attention = classifyAttention(snapshot, { now: nowIso });
        const entry = buildRosterEntry({
          profile: bundle.profile,
          metrics: bundle.metrics,
          weeklySummary: bundle.weeklySummary,
          readiness: { readinessScore: snapshot.readiness.readinessScore, pain_present: snapshot.readiness.painPresent },
          todaySession: todaySession(bundle.trainingSessions, nowIso),
          latestActivity: (bundle.activities || [])[0] || null,
          providerAccount: { last_sync_at: bundle.providerAccount.last_sync_at, last_sync_status: bundle.providerAccount.last_sync_status },
          attention,
          lastActiveAt: snapshot.lastActiveAt
        });
        // Attach which alert keys this coach has already reviewed (audit-safe;
        // does not clear the underlying condition).
        entry.reviewed_alert_keys = reviews
          .filter(r => String(r.athlete_id) === String(athleteId))
          .map(r => r.alert_key);
        athletes.push(entry);
      }
      return sendJson(res, 200, { role: resolveRole(profile), athletes, roster_size: athletes.length });
    }

    if (action === "athlete") {
      const athleteId = req.query && (req.query.athlete_id || req.query.athleteId);
      if (!athleteId) return sendJson(res, 400, { error: "athlete_id is required." });
      // A client-supplied athlete_id can NEVER bypass authorization.
      if (!canCoachAccessAthlete(assignments, user.id, athleteId)) {
        return sendJson(res, 403, { error: "You are not assigned to this athlete." });
      }
      const bundle = await loadAthleteBundle(athleteId);
      const snapshot = buildSnapshot(bundle, nowIso);
      const attention = classifyAttention(snapshot, { now: nowIso });
      const overview = buildAthleteOverview({
        profile: bundle.profile,
        readiness: { readinessScore: snapshot.readiness.readinessScore, pain_present: snapshot.readiness.painPresent, readiness_date: bundle.readiness.readiness_date },
        weeklySummary: bundle.weeklySummary,
        recentActivities: bundle.activities,
        todaySession: todaySession(bundle.trainingSessions, nowIso),
        attention,
        lastSyncAt: snapshot.lastSyncAt,
        lastActiveAt: snapshot.lastActiveAt
      });
      return sendJson(res, 200, { athlete: overview });
    }

    if (action === "review") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
      const body = req.body || {};
      const athleteId = body.athlete_id;
      const alertKey = body.alert_key;
      if (!athleteId || !alertKey) return sendJson(res, 400, { error: "athlete_id and alert_key are required." });
      if (!canCoachAccessAthlete(assignments, user.id, athleteId)) {
        return sendJson(res, 403, { error: "You are not assigned to this athlete." });
      }
      // Upsert the review (one current row per coach/athlete/alert_key) — does
      // NOT insert a new row per render and does NOT clear the condition.
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_attention_reviews?on_conflict=coach_id,athlete_id,alert_key`,
        {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal"
          },
          body: JSON.stringify({
            coach_id: user.id,
            athlete_id: athleteId,
            alert_key: String(alertKey),
            reviewed_at: nowIso
          })
        }
      );
      if (!r.ok) return sendJson(res, 500, { error: "Could not record the review." });
      return sendJson(res, 200, { reviewed: true });
    }

    return sendJson(res, 400, { error: "Unknown action." });
  } catch (err) {
    // Never leak raw DB errors to the client.
    return sendJson(res, 500, { error: "The coach dashboard could not load." });
  }
}
