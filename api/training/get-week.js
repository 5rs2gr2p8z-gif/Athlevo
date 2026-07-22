import {
  buildExecutionRow,
  indexRecordsBySession,
  matchActivitiesToSessions
} from "../../lib/server/executionRecords.js";

import {
  buildActivityOverrideRow,
  buildSessionPatch,
  snapshotSession,
  validateActionForApply
} from "../../lib/server/coachActions.js";

import { buildProposal } from "../../lib/server/adaptivePlanAdapter.js";

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

function sendJson(response, statusCode, payload) {
  return response.status(statusCode).json(payload);
}

function getBearerToken(request) {
  const authorization =
    request.headers.authorization ||
    request.headers.Authorization ||
    "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice(7).trim();
}

async function getAuthenticatedUser(accessToken) {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      method: "GET",

      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function supabaseRequest(
  path,
  { method = "GET", body, headers = {} } = {}
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method,

      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type": "application/json",
        ...headers
      },

      body:
        body === undefined
          ? undefined
          : JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Supabase request failed: ` +
      `${response.status} ${errorText}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  return text
    ? JSON.parse(text)
    : [];
}

// Execution records may be queried before the migration has run. Never
// let a missing table break the Train tab.
async function optionalRequest(path, options) {
  try {
    return await supabaseRequest(path, options);
  } catch (error) {
    console.error(
      "Optional execution data unavailable:",
      error?.message
    );
    return null;
  }
}

function getManilaDate() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(new Date());

  const values = {};

  parts.forEach(part => {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  });

  return new Date(
    Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day)
    )
  );
}

function getMonday(date) {
  const result = new Date(date);

  const weekday = result.getUTCDay();

  const daysSinceMonday =
    weekday === 0
      ? 6
      : weekday - 1;

  result.setUTCDate(
    result.getUTCDate() -
      daysSinceMonday
  );

  return result;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

// b - a in whole days: positive when `aKey` is in the past relative to `bKey`.
function daysBetween(aKey, bKey) {
  if (!aKey || !bKey) return null;
  const a = Date.parse(String(aKey).slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(String(bKey).slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

async function loadCurrentPlan(
  userId,
  weekStart
) {
  const rows = await supabaseRequest(
    [
      "training_plans",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&week_start=eq.${weekStart}`,
      "&status=eq.active",
      "&select=*",
      "&order=updated_at.desc",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function loadPlanSessions(
  userId,
  trainingPlanId
) {
  const rows = await supabaseRequest(
    [
      "training_sessions",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&training_plan_id=eq.${encodeURIComponent(trainingPlanId)}`,
      "&select=*",
      "&order=session_date.asc"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function loadExecutionRecords(userId, sessionIds) {
  if (!sessionIds.length) {
    return [];
  }

  const idList = sessionIds
    .map(id => encodeURIComponent(id))
    .join(",");

  const rows = await optionalRequest(
    [
      "workout_execution_records",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&training_session_id=in.(${idList})`,
      "&select=*"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

async function loadWeekActivities(
  userId,
  weekStartKey,
  weekEndKey
) {
  const rows = await optionalRequest(
    [
      "activities",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=id,name,sport_type,activity_type,",
      "distance_meters,moving_time_seconds,average_heartrate,start_date",
      `&start_date=gte.${weekStartKey}T00:00:00`,
      `&start_date=lte.${weekEndKey}T23:59:59`,
      "&order=start_date.desc&limit=100"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

async function loadSessionForUser(userId, sessionId) {
  const rows = await supabaseRequest(
    [
      "training_sessions",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&id=eq.${encodeURIComponent(sessionId)}`,
      "&select=*",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadActivityOverrides(userId) {
  const rows = await optionalRequest(
    [
      "activity_data_overrides",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=*"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

async function loadActivityForUser(userId, activityId) {
  const rows = await optionalRequest(
    [
      "activities",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&id=eq.${encodeURIComponent(activityId)}`,
      "&select=id,name,sport_type,activity_type,distance_meters,moving_time_seconds",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadSessionOnDate(userId, sessionDate) {
  const rows = await optionalRequest(
    [
      "training_sessions",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&session_date=eq.${encodeURIComponent(sessionDate)}`,
      "&select=id,session_date",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadProposalById(userId, proposalId) {
  const rows = await optionalRequest(
    [
      "coach_action_proposals",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&id=eq.${encodeURIComponent(proposalId)}`,
      "&select=*",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

/*
 * Merges the athlete's execution feedback and any same-day Strava match
 * onto each session so the Train tab can render status without a second
 * round trip. The original session shape is preserved; only new keys
 * (execution, matched_activity) are added.
 */
function enrichSessions(sessions, records, activities) {
  const recordMap = indexRecordsBySession(records);
  const matches = matchActivitiesToSessions(sessions, activities);

  return sessions.map(session => {
    const record = session?.id
      ? recordMap.get(String(session.id)) || null
      : null;

    return {
      ...session,
      execution: record,
      matched_activity: session?.id
        ? matches[session.id] || null
        : null
    };
  });
}

async function handleGet(request, response, user) {
  const currentDate = getManilaDate();
  const weekStart = getMonday(currentDate);
  const weekStartKey = toDateKey(weekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekEndKey = toDateKey(weekEnd);

  const plan = await loadCurrentPlan(user.id, weekStartKey);

  if (!plan) {
    return sendJson(response, 200, {
      hasPlan: false,
      weekStart: weekStartKey,
      plan: null,
      sessions: [],
      executionRecords: []
    });
  }

  const sessions = await loadPlanSessions(user.id, plan.id);

  const sessionIds = sessions
    .map(session => session?.id)
    .filter(Boolean);

  const [records, activities, activityOverrides] = await Promise.all([
    loadExecutionRecords(user.id, sessionIds),
    loadWeekActivities(user.id, weekStartKey, weekEndKey),
    loadActivityOverrides(user.id)
  ]);

  const enriched = enrichSessions(sessions, records, activities);

  return sendJson(response, 200, {
    hasPlan: true,
    weekStart: weekStartKey,
    plan,
    sessions: enriched,
    executionRecords: records,
    activityOverrides
  });
}

/*
 * Applies ONE athlete-confirmed coach action proposal. Everything is
 * validated server-side against the database before any write — the
 * model's output is never trusted. Idempotent by proposal id, so a
 * repeated "Apply" tap cannot double-apply.
 */
async function handleApplyAction(response, user, body) {
  const proposal = body.proposal;

  if (!proposal || typeof proposal !== "object") {
    return sendJson(response, 400, {
      error: "A proposal is required to apply a change."
    });
  }

  const proposalId =
    typeof proposal.id === "string" && proposal.id.trim()
      ? proposal.id.trim()
      : null;

  // Idempotency: if this proposal was already applied, return it.
  if (proposalId) {
    const existing = await loadProposalById(user.id, proposalId);
    if (existing && existing.status === "applied") {
      return sendJson(response, 200, {
        success: true,
        alreadyApplied: true,
        proposal: existing
      });
    }
  }

  const { action, error } = validateActionForApply(proposal);

  if (error) {
    return sendJson(response, 400, { error });
  }

  const nowIso = new Date().toISOString();
  const affectedSessionIds = [];
  let originalSnapshot = null;
  let correctedValues = null;

  // Pre-loaded targets (reads + ownership checks) happen BEFORE any write
  // so a 404/409 never leaves partial state.
  let targetSession = null;
  let targetActivity = null;

  if (
    action.type === "move_workout" ||
    action.type === "modify_workout" ||
    action.type === "replace_workout" ||
    action.type === "skip_workout"
  ) {
    targetSession = await loadSessionForUser(
      user.id,
      action.target_session_id
    );

    if (!targetSession) {
      return sendJson(response, 404, {
        error: "That training session could not be found."
      });
    }

    if (action.type === "move_workout") {
      const clash = await loadSessionOnDate(user.id, action.to_date);
      if (clash && String(clash.id) !== String(targetSession.id)) {
        return sendJson(response, 409, {
          error: "There is already a session on that date."
        });
      }
    }

    originalSnapshot = snapshotSession(targetSession);
    affectedSessionIds.push(targetSession.id);
  } else if (action.type === "create_activity_override") {
    // Verify the imported activity belongs to THIS athlete.
    targetActivity = await loadActivityForUser(
      user.id,
      action.target_activity_id
    );

    if (!targetActivity) {
      return sendJson(response, 404, {
        error: "That activity could not be found."
      });
    }

    originalSnapshot = {
      activity_id: targetActivity.id,
      distance_meters: targetActivity.distance_meters,
      moving_time_seconds: targetActivity.moving_time_seconds,
      sport_type:
        targetActivity.sport_type || targetActivity.activity_type || null
    };
    correctedValues = action.corrected_values;
  }

  // 1) Write the proposal FIRST. It is the audit row AND the foreign-key
  //    anchor for an activity override, so it must exist before the
  //    override references it. (This ordering was the correction-apply
  //    bug: the override referenced a proposal row that didn't exist yet.)
  const proposalRow = {
    user_id: user.id,
    source_conversation_id:
      typeof proposal.source_conversation_id === "string"
        ? proposal.source_conversation_id.slice(0, 200)
        : null,
    source_message_id:
      typeof proposal.source_message_id === "string"
        ? proposal.source_message_id.slice(0, 200)
        : null,
    action_type: action.type,
    status: "applied",
    affected_session_ids: affectedSessionIds,
    proposed_changes: {
      changes: action.changes,
      to_date: action.to_date || null,
      from_date: action.from_date || null,
      availability_note: action.availability_note || null,
      preference_note: action.preference_note || null
    },
    original_snapshot: originalSnapshot,
    corrected_values: correctedValues,
    reason: action.reason || null,
    confirmed_at: nowIso,
    applied_at: nowIso,
    updated_at: nowIso
  };

  if (proposalId) {
    proposalRow.id = proposalId;
  }

  let savedProposal;

  try {
    savedProposal = await supabaseRequest(
      "coach_action_proposals?on_conflict=id",
      {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        body: proposalRow
      }
    );
  } catch (proposalError) {
    console.error(
      "Coach action apply — could not record proposal:",
      proposalError?.message || proposalError
    );
    return sendJson(response, 500, {
      error: "That change could not be saved. Please try again."
    });
  }

  const savedProposalRow = Array.isArray(savedProposal)
    ? savedProposal[0] || null
    : savedProposal;

  const savedProposalId =
    (savedProposalRow && savedProposalRow.id) || proposalId || null;

  // 2) Perform the actual mutation. If it fails, roll the proposal back so
  //    it is not falsely left "applied" and the athlete can retry.
  const refreshed = {};

  try {
    if (
      action.type === "move_workout" ||
      action.type === "modify_workout" ||
      action.type === "replace_workout"
    ) {
      const patch = buildSessionPatch(action, targetSession);

      const updated = await supabaseRequest(
        "training_sessions" +
          `?id=eq.${encodeURIComponent(targetSession.id)}` +
          `&user_id=eq.${encodeURIComponent(user.id)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: patch
        }
      );

      refreshed.session = Array.isArray(updated)
        ? updated[0] || null
        : updated;
    } else if (action.type === "skip_workout") {
      const { row } = buildExecutionRow({
        body: {
          status: "skipped",
          training_session_id: targetSession.id,
          skip_reason: "other",
          athlete_notes: action.reason || null
        },
        userId: user.id,
        session: targetSession
      });

      const saved = await supabaseRequest(
        "workout_execution_records" +
          "?on_conflict=user_id,training_session_id",
        {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation"
          },
          body: row
        }
      );

      refreshed.execution = Array.isArray(saved) ? saved[0] || null : saved;
    } else if (action.type === "create_activity_override") {
      const overrideRow = buildActivityOverrideRow({
        userId: user.id,
        action,
        activity: targetActivity,
        activityId: targetActivity.id,
        proposalId: savedProposalId
      });

      const savedOverride = await supabaseRequest(
        "activity_data_overrides?on_conflict=user_id,activity_id",
        {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation"
          },
          body: overrideRow
        }
      );

      refreshed.override = Array.isArray(savedOverride)
        ? savedOverride[0] || null
        : savedOverride;
    } else if (action.type === "update_race_details") {
      const profilePatch = { updated_at: nowIso };
      if (action.race_details.target_race) {
        profilePatch.target_race = action.race_details.target_race;
      }
      if (action.race_details.race_date) {
        profilePatch.race_date = action.race_details.race_date;
      }
      if (action.race_details.target_time) {
        profilePatch.target_time = action.race_details.target_time;
      }

      await supabaseRequest(
        `profiles?id=eq.${encodeURIComponent(user.id)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: profilePatch
        }
      );
    }
    // update_training_preference / update_temporary_availability /
    // adjust_remaining_week: the recorded proposal IS the applied change.
    // They are conservative signals read by next-week generation; we never
    // auto-rewrite the current week (no shoving missed intensity forward).

    return sendJson(response, 200, {
      success: true,
      proposal: savedProposalRow,
      refreshed
    });
  } catch (mutationError) {
    console.error(
      `Coach action apply — mutation failed for ${action.type}:`,
      mutationError?.message || mutationError
    );

    // Roll back the proposal so it isn't falsely "applied" and can retry.
    if (savedProposalId) {
      try {
        await supabaseRequest(
          "coach_action_proposals" +
            `?id=eq.${encodeURIComponent(savedProposalId)}` +
            `&user_id=eq.${encodeURIComponent(user.id)}`,
          { method: "DELETE", headers: { Prefer: "return=minimal" } }
        );
      } catch (rollbackError) {
        console.error(
          "Coach action apply — proposal rollback failed:",
          rollbackError?.message || rollbackError
        );
      }
    }

    return sendJson(response, 500, {
      error: "That change could not be applied. Please try again."
    });
  }
}

/* ══════════════════════ Adaptive Smart Plan v2 wiring ═══════════════════
 *
 *  Preview / apply / dismiss for the pure planning engines. The DB I/O lives
 *  here; the decision logic lives in the pure adapter + engines. Every path is
 *  user-scoped (user_id=eq on every request) and never touches past or
 *  completed workouts.
 */

const ADAPTIVE_HISTORY_DAYS = 35;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function todayKeyFrom(body) {
  const t = body && typeof body.today === "string" ? body.today.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : isoDate(new Date());
}

async function loadActivePlan(userId) {
  const rows = await optionalRequest(
    [
      "training_plans",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&status=eq.active",
      "&select=id,week_start,status,updated_at",
      "&order=updated_at.desc",
      "&limit=1"
    ].join("")
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadRecentActivities(userId, sinceKey) {
  const rows = await optionalRequest(
    [
      "activities",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=id,start_date,distance_meters,moving_time_seconds,",
      "average_heartrate,sport_type,activity_type,recognition:raw_data->recognition",
      `&start_date=gte.${sinceKey}T00:00:00`,
      "&order=start_date.desc&limit=200"
    ].join("")
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadAthleteProfile(userId) {
  const rows = await optionalRequest(
    [
      "profiles",
      `?id=eq.${encodeURIComponent(userId)}`,
      "&select=race_date,target_race,target_time",
      "&limit=1"
    ].join("")
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

// Everything the adapter needs, loaded user-scoped. Pure logic stays elsewhere.
async function loadAdaptiveInputs(userId, todayKey) {
  const plan = await loadActivePlan(userId);
  const sessions = plan ? await loadPlanSessions(userId, plan.id) : [];
  const sinceKey = isoDate(new Date(Date.parse(todayKey + "T00:00:00Z") - ADAPTIVE_HISTORY_DAYS * 86400000));
  const [activities, executions, profile] = await Promise.all([
    loadRecentActivities(userId, sinceKey),
    loadExecutionRecords(userId, sessions.map(s => s.id)),
    loadAthleteProfile(userId)
  ]);
  return { plan, sessions, activities, executions, profile: profile || {}, now: todayKey };
}

// Look up a prior adaptive proposal row by fingerprint + status (dedup/dismissal).
async function findAdaptiveRow(userId, fingerprint, status) {
  const rows = await optionalRequest(
    [
      "coach_action_proposals",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      `&status=eq.${encodeURIComponent(status)}`,
      `&proposed_changes->>fingerprint=eq.${encodeURIComponent(fingerprint)}`,
      "&select=id,status,applied_at,proposed_changes",
      "&order=updated_at.desc&limit=1"
    ].join("")
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

// Safe diagnostics only: posture, counts, fingerprint. No PII, no workout
// contents, no tokens, no provider payloads.
function logAdaptive(stage, fields) {
  try {
    console.log(`[adaptive] ${stage}`, JSON.stringify(fields));
  } catch (e) { /* never throw from a log */ }
}

async function handleAdaptivePreview(response, user, body) {
  const todayKey = todayKeyFrom(body);
  const raw = await loadAdaptiveInputs(user.id, todayKey);
  if (!raw.plan) {
    return sendJson(response, 200, { ok: true, hasPlan: false, stable: true, proposedChanges: [] });
  }
  const proposal = buildProposal(raw);

  let suppressed = false, alreadyApplied = false;
  if (!proposal.stable) {
    const dismissed = await findAdaptiveRow(user.id, proposal.fingerprint, "cancelled");
    const applied = await findAdaptiveRow(user.id, proposal.fingerprint, "applied");
    suppressed = Boolean(dismissed);
    alreadyApplied = Boolean(applied);
  }

  logAdaptive("preview", {
    memoryBlock: proposal.memorySummary && proposal.memorySummary.block,
    fatigue: proposal.memorySummary && proposal.memorySummary.fatigue && proposal.memorySummary.fatigue.level,
    posture: proposal.posture, changes: proposal.proposedChanges.length,
    fingerprint: proposal.fingerprint, suppressed, alreadyApplied,
    taperHold: proposal.guards.taperRaceHold, injuryHold: proposal.guards.injuryHold
  });

  return sendJson(response, 200, {
    ok: true, hasPlan: true,
    posture: proposal.posture,
    stable: proposal.stable,
    suppressed, alreadyApplied,
    memorySummary: proposal.memorySummary,
    proposedChanges: proposal.proposedChanges.map(c => ({
      workoutId: c.workoutId, date: c.date, before: c.before, after: c.after, reason: c.reason
    })),
    weeklyReview: proposal.weeklyReview,
    guards: proposal.guards,
    engineVersion: proposal.engineVersion,
    fingerprint: proposal.fingerprint
  });
}

async function handleAdaptiveApply(response, user, body) {
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
  if (!fingerprint) {
    return sendJson(response, 400, { error: "A proposal fingerprint is required." });
  }
  const todayKey = todayKeyFrom(body);
  const raw = await loadAdaptiveInputs(user.id, todayKey);
  if (!raw.plan) return sendJson(response, 404, { error: "No active plan to adjust." });

  // Recompute server-side — never trust client-provided change values.
  const proposal = buildProposal(raw);
  if (proposal.fingerprint !== fingerprint) {
    logAdaptive("apply.stale", { got: fingerprint, now: proposal.fingerprint });
    return sendJson(response, 409, {
      error: "Your training data changed. Please review the updated recommendation.",
      stale: true, fingerprint: proposal.fingerprint
    });
  }
  if (proposal.stable || proposal.proposedChanges.length === 0) {
    return sendJson(response, 200, { success: true, applied: 0, stable: true });
  }

  // Idempotency: identical proposal already applied → do nothing again.
  const existing = await findAdaptiveRow(user.id, fingerprint, "applied");
  if (existing) {
    return sendJson(response, 200, { success: true, applied: proposal.proposedChanges.length, idempotent: true, proposalId: existing.id });
  }

  const nowIso = new Date().toISOString();

  // Validate + snapshot every target BEFORE mutating anything.
  const plans = [];
  for (const c of proposal.proposedChanges) {
    const session = await loadSessionForUser(user.id, c.workoutId);   // scoped to user
    if (!session) return sendJson(response, 404, { error: "A workout in this proposal no longer exists." });
    const age = daysBetween(session.session_date, todayKey);          // >0 → past
    if (age == null || age >= 0) {                                     // today or past → refuse
      return sendJson(response, 409, { error: "Only future workouts can be adjusted.", stale: true });
    }
    plans.push({
      id: session.id,
      before: { session_type: session.session_type, duration_minutes: session.duration_minutes, distance_km: session.distance_km },
      patch: c.patch, change: c
    });
  }

  const affectedSessionIds = plans.map(p => p.id);
  const envelope = {
    user_id: user.id,
    action_type: "adjust_remaining_week",
    status: "applied",
    affected_session_ids: affectedSessionIds,
    proposed_changes: {
      kind: "adaptive", fingerprint, engineVersion: proposal.engineVersion,
      posture: proposal.posture,
      changes: plans.map(p => ({ workoutId: p.id, before: p.change.before, after: p.change.after, reason: p.change.reason }))
    },
    original_snapshot: { sessions: plans.map(p => ({ id: p.id, ...p.before })) },
    reason: proposal.proposedChanges.map(c => c.reason).join(" · ").slice(0, 500),
    confirmed_at: nowIso, applied_at: nowIso, updated_at: nowIso
  };

  // 1) Audit envelope first (so a mutation failure leaves a rollback anchor).
  let envelopeId = null;
  try {
    const saved = await supabaseRequest("coach_action_proposals?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: envelope
    });
    const row = Array.isArray(saved) ? saved[0] : saved;
    envelopeId = row && row.id;
  } catch (e) {
    logAdaptive("apply.envelope_failed", { fingerprint });
    return sendJson(response, 500, { error: "That change could not be saved. Please try again." });
  }

  // 2) Patch each future session; roll back ALL on any failure.
  const applied = [];
  try {
    for (const p of plans) {
      const updated = await supabaseRequest(
        "training_sessions" +
          `?id=eq.${encodeURIComponent(p.id)}` +
          `&user_id=eq.${encodeURIComponent(user.id)}`,
        { method: "PATCH", headers: { Prefer: "return=representation" },
          body: { ...p.patch, updated_at: nowIso } }
      );
      if (!Array.isArray(updated) || !updated.length) throw new Error("session patch returned no row");
      applied.push(p);
    }
  } catch (mutErr) {
    logAdaptive("apply.rollback", { fingerprint, done: applied.length, of: plans.length });
    // Revert the sessions we already patched, then remove the envelope.
    for (const p of applied) {
      try {
        await supabaseRequest(
          "training_sessions" +
            `?id=eq.${encodeURIComponent(p.id)}` +
            `&user_id=eq.${encodeURIComponent(user.id)}`,
          { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { ...p.before, updated_at: nowIso } }
        );
      } catch (revErr) { /* best-effort; envelope removal still runs */ }
    }
    if (envelopeId) {
      try {
        await supabaseRequest(
          "coach_action_proposals" +
            `?id=eq.${encodeURIComponent(envelopeId)}` +
            `&user_id=eq.${encodeURIComponent(user.id)}`,
          { method: "DELETE", headers: { Prefer: "return=minimal" } }
        );
      } catch (delErr) { /* best-effort */ }
    }
    return sendJson(response, 500, { error: "That change could not be applied. Nothing was changed.", rolledBack: true });
  }

  logAdaptive("apply.success", { fingerprint, applied: applied.length, proposalId: envelopeId });
  return sendJson(response, 200, {
    success: true, applied: applied.length, proposalId: envelopeId, affectedSessionIds
  });
}

async function handleAdaptiveDismiss(response, user, body) {
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
  if (!fingerprint) {
    return sendJson(response, 400, { error: "A proposal fingerprint is required." });
  }
  const nowIso = new Date().toISOString();

  // Don't create duplicate dismissals for the same fingerprint.
  const existing = await findAdaptiveRow(user.id, fingerprint, "cancelled");
  if (existing) return sendJson(response, 200, { success: true, dismissed: true, idempotent: true });

  try {
    await supabaseRequest("coach_action_proposals", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        user_id: user.id,
        action_type: "adjust_remaining_week",
        status: "cancelled",
        affected_session_ids: [],
        proposed_changes: { kind: "adaptive_dismissal", fingerprint },
        reason: "Athlete kept current plan.",
        cancelled_at: nowIso, updated_at: nowIso
      }
    });
  } catch (e) {
    logAdaptive("dismiss.failed", { fingerprint });
    return sendJson(response, 500, { error: "That could not be saved. Please try again." });
  }
  logAdaptive("dismiss.success", { fingerprint });
  return sendJson(response, 200, { success: true, dismissed: true });
}

async function handlePost(request, response, user) {
  const body =
    request.body && typeof request.body === "object"
      ? request.body
      : typeof request.body === "string" && request.body
      ? JSON.parse(request.body)
      : {};

  // Adaptive Smart Plan v2 — preview / apply / dismiss.
  if (body.intent === "adaptive_preview") return await handleAdaptivePreview(response, user, body);
  if (body.intent === "adaptive_apply") return await handleAdaptiveApply(response, user, body);
  if (body.intent === "adaptive_dismiss") return await handleAdaptiveDismiss(response, user, body);

  // Branch: apply a confirmed coach action proposal.
  if (body.intent === "apply_coach_action") {
    return await handleApplyAction(response, user, body);
  }

  const sessionId =
    typeof body.training_session_id === "string"
      ? body.training_session_id.trim()
      : "";

  if (!sessionId) {
    return sendJson(response, 400, {
      error: "A training_session_id is required."
    });
  }

  // Confirms ownership and gives us the prescription to snapshot.
  const session = await loadSessionForUser(user.id, sessionId);

  if (!session) {
    return sendJson(response, 404, {
      error: "That training session could not be found."
    });
  }

  const { row, error } = buildExecutionRow({
    body,
    userId: user.id,
    session
  });

  if (error) {
    return sendJson(response, 400, { error });
  }

  const saved = await supabaseRequest(
    "workout_execution_records" +
      "?on_conflict=user_id,training_session_id",
    {
      method: "POST",
      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation"
      },
      body: row
    }
  );

  return sendJson(response, 200, {
    success: true,
    record: Array.isArray(saved) ? saved[0] || null : saved
  });
}

export default async function handler(
  request,
  response
) {
  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    response.setHeader("Allow", "GET, POST");

    return sendJson(
      response,
      405,
      {
        error: "Method not allowed."
      }
    );
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return sendJson(
      response,
      500,
      {
        error:
          "Supabase server configuration is missing."
      }
    );
  }

  try {
    const accessToken =
      getBearerToken(request);

    if (!accessToken) {
      return sendJson(
        response,
        401,
        {
          error:
            "Authentication is required."
        }
      );
    }

    const user =
      await getAuthenticatedUser(
        accessToken
      );

    if (!user?.id) {
      return sendJson(
        response,
        401,
        {
          error:
            "The authenticated athlete could not be verified."
        }
      );
    }

    if (request.method === "POST") {
      return await handlePost(request, response, user);
    }

    return await handleGet(request, response, user);
  } catch (error) {
    console.error(
      "Could not load or update the weekly plan:",
      error
    );

    return sendJson(
      response,
      500,
      {
        error:
          error?.message ||
          "Could not load the weekly training plan."
      }
    );
  }
}
