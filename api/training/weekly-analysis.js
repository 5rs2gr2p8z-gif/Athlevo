import {
  addDays,
  calculateWeeksUntilRace,
  createDateFromParts,
  formatDateKey,
  getManilaDateParts,
  getMondayOfCurrentWeek,
  parseDateValue
} from "../../lib/server/dateUtils.js";

import {
  assessInjuryRisk,
  assessRecovery,
  buildKeyConcerns,
  buildKeyWins,
  buildNarrative,
  buildNextWeekPriorities,
  computeConsistencyStatus,
  computeLoadDirection,
  computeTrajectory,
  filterInjuryMemories,
  findComparableRuns,
  isRestSession,
  manilaDateKey,
  matchPlannedSessions,
  summarizeActivityTotals,
  toNumber
} from "../../lib/server/weeklyAnalysis.js";

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
        Authorization: `Bearer ${accessToken}`
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
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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
    const errorText = await response.text();

    throw new Error(
      `Supabase request failed: ${response.status} ${errorText}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  return text ? JSON.parse(text) : null;
}

async function optionalRequest(path) {
  try {
    return await supabaseRequest(path);
  } catch (error) {
    console.error(
      "Optional analysis data unavailable:",
      error?.message
    );
    return null;
  }
}

function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] || null : null;
}

/*
 * The analysis week: the current week when it is nearly complete
 * (Saturday/Sunday in Asia/Manila), otherwise the most recently
 * completed week. An explicit ?week_start=YYYY-MM-DD wins.
 */
function resolveAnalysisWeekStart(request) {
  const requested = parseDateValue(
    String(request.query?.week_start || "")
  );

  if (requested) {
    return requested;
  }

  const currentMonday = getMondayOfCurrentWeek();

  const weekday = createDateFromParts(
    getManilaDateParts()
  ).getUTCDay();

  const nearlyComplete = weekday === 6 || weekday === 0;

  return nearlyComplete
    ? currentMonday
    : addDays(currentMonday, -7);
}

function activityInRange(activity, startKey, endKey) {
  const key = manilaDateKey(activity.start_date);
  return key !== null && key >= startKey && key <= endKey;
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");

    return sendJson(response, 405, {
      error: "Method not allowed."
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(response, 500, {
      error: "Supabase server configuration is missing."
    });
  }

  try {
    const accessToken = getBearerToken(request);

    if (!accessToken) {
      return sendJson(response, 401, {
        error: "Authentication is required."
      });
    }

    const user = await getAuthenticatedUser(accessToken);

    if (!user?.id) {
      return sendJson(response, 401, {
        error:
          "The authenticated athlete could not be verified."
      });
    }

    const userId = encodeURIComponent(user.id);

    const weekStart = resolveAnalysisWeekStart(request);
    const weekEnd = addDays(weekStart, 6);
    const weekStartKey = formatDateKey(weekStart);
    const weekEndKey = formatDateKey(weekEnd);

    const currentMonday = getMondayOfCurrentWeek();
    const historyStartKey = formatDateKey(
      addDays(weekStart, -28)
    );

    const [
      profile,
      plan,
      currentPlan,
      activities,
      checkIn,
      memories
    ] = await Promise.all([
      supabaseRequest(
        `profiles?id=eq.${userId}&select=*&limit=1`
      ).then(firstRow),

      supabaseRequest(
        `training_plans?user_id=eq.${userId}` +
          `&week_start=eq.${weekStartKey}` +
          "&select=*&order=updated_at.desc&limit=1"
      ).then(firstRow),

      supabaseRequest(
        `training_plans?user_id=eq.${userId}` +
          `&week_start=eq.${formatDateKey(currentMonday)}` +
          "&select=phase,phase_week,phase_length_weeks" +
          "&order=updated_at.desc&limit=1"
      ).then(firstRow),

      supabaseRequest(
        `activities?user_id=eq.${userId}` +
          "&select=id,external_activity_id,name,sport_type,activity_type," +
          "distance_meters,moving_time_seconds,elevation_gain_meters," +
          "average_heartrate,start_date,trainer" +
          `&start_date=gte.${historyStartKey}` +
          "&order=start_date.desc&limit=300"
      ).then(rows => (Array.isArray(rows) ? rows : [])),

      optionalRequest(
        `weekly_check_ins?user_id=eq.${userId}` +
          `&week_start=eq.${weekStartKey}&select=*&limit=1`
      ).then(firstRow),

      supabaseRequest(
        `athlete_memory?user_id=eq.${userId}` +
          "&is_active=eq.true" +
          "&select=category,memory_key,content&limit=40"
      ).then(rows => (Array.isArray(rows) ? rows : []))
    ]);

    const sessions = plan
      ? await supabaseRequest(
          `training_sessions?user_id=eq.${userId}` +
            `&training_plan_id=eq.${encodeURIComponent(plan.id)}` +
            "&select=session_date,title,sport,session_type," +
            "duration_minutes,distance_km,intensity,status" +
            "&order=session_date.asc"
        ).then(rows => (Array.isArray(rows) ? rows : []))
      : [];

    /* ── computation ─────────────────────────────────────────── */

    const weekActivities = activities.filter(activity =>
      activityInRange(activity, weekStartKey, weekEndKey)
    );

    const baselineActivities = activities.filter(activity =>
      activityInRange(
        activity,
        formatDateKey(addDays(weekStart, -21)),
        formatDateKey(addDays(weekStart, -1))
      )
    );

    const matching = matchPlannedSessions(
      sessions,
      weekActivities
    );

    const comparable = findComparableRuns(
      weekActivities,
      baselineActivities
    );

    const completedTotals =
      summarizeActivityTotals(weekActivities);

    const plannedDuration = sessions
      .filter(session => !isRestSession(session))
      .reduce(
        (total, session) =>
          total + (toNumber(session.duration_minutes) || 0),
        0
      );

    const plannedDistance = sessions
      .filter(session => !isRestSession(session))
      .reduce(
        (total, session) =>
          total + (toNumber(session.distance_km) || 0),
        0
      );

    // prior weeks (for load direction and confidence)
    const priorWeekMinutes = [];

    for (let index = 1; index <= 4; index += 1) {
      const start = formatDateKey(
        addDays(weekStart, -7 * index)
      );
      const end = formatDateKey(
        addDays(weekStart, -7 * index + 6)
      );

      const totals = summarizeActivityTotals(
        activities.filter(activity =>
          activityInRange(activity, start, end)
        )
      );

      priorWeekMinutes.push(totals.minutes);
    }

    const historyWeeks =
      priorWeekMinutes.filter(minutes => minutes > 0).length +
      (completedTotals.minutes > 0 ? 1 : 0);

    const loadDirection = computeLoadDirection(
      completedTotals.minutes,
      priorWeekMinutes
    );

    const consistencyStatus = computeConsistencyStatus(
      completedTotals.activeDayCount,
      matching.completionRate
    );

    const recovery = assessRecovery(checkIn);
    const injuryMemories = filterInjuryMemories(memories);
    const injuryRisk = assessInjuryRisk(
      checkIn,
      injuryMemories
    );

    /* ── goal countdown ──────────────────────────────────────── */

    const raceDate = parseDateValue(
      profile?.race_date || profile?.target_race_date || null
    );

    const rawRaceName =
      profile?.target_race || profile?.race_type || null;

    const targetRace =
      rawRaceName &&
      String(rawRaceName).trim().toLowerCase() !== "none"
        ? String(rawRaceName).trim()
        : null;

    const manilaToday = createDateFromParts(
      getManilaDateParts()
    );

    const daysUntilRace = raceDate
      ? Math.max(
          0,
          Math.round(
            (raceDate.getTime() - manilaToday.getTime()) /
              (24 * 60 * 60 * 1000)
          )
        )
      : null;

    const weeksUntilRace = raceDate
      ? calculateWeeksUntilRace(raceDate, currentMonday)
      : null;

    /* ── trajectory ──────────────────────────────────────────── */

    const trajectory = computeTrajectory({
      hasPlan: Boolean(plan),
      plannedCount: matching.plannedCount,
      completionRate: matching.completionRate,
      comparable,
      recovery,
      injuryRisk,
      longRun: matching.longRun,
      consistencyStatus,
      weeksUntilRace,
      hasCheckIn: Boolean(checkIn),
      activityCount: completedTotals.activityCount,
      historyWeeks
    });

    /* ── narrative + structured sections ─────────────────────── */

    const planned = {
      distanceKm: plannedDistance
        ? Number(plannedDistance.toFixed(1))
        : null,
      minutes: plannedDuration || null
    };

    const completed = {
      distanceKm: completedTotals.distanceKm,
      minutes: completedTotals.minutes
    };

    const narrative = buildNarrative({
      matching,
      planned,
      completed,
      comparable,
      recovery,
      injuryRisk,
      checkIn
    });

    const keyWins = buildKeyWins({
      matching,
      comparable,
      recovery
    });

    const keyConcerns = buildKeyConcerns({
      matching,
      comparable,
      recovery,
      injuryRisk,
      checkIn
    });

    const priorities = buildNextWeekPriorities({
      matching,
      recovery,
      injuryRisk,
      consistencyStatus
    });

    const summary = {
      user_id: user.id,
      week_start: weekStartKey,
      week_end: weekEndKey,

      planned_sessions: matching.plannedCount,
      completed_sessions: matching.completedCount,
      completion_rate:
        matching.completionRate === null
          ? null
          : Number(matching.completionRate.toFixed(3)),
      planned_duration_minutes: plannedDuration || null,
      completed_duration_minutes: completedTotals.minutes,
      planned_distance_km: planned.distanceKm,
      completed_distance_km: completed.distanceKm,

      comparable_run_count: comparable.weekRunCount,
      pace_change_seconds_per_km:
        comparable.paceChangeSecPerKm,
      heart_rate_change_bpm: comparable.heartRateChangeBpm,

      training_load_direction: loadDirection,
      consistency_status: consistencyStatus,
      recovery_status: recovery.status,
      injury_risk_status: injuryRisk,
      trajectory_status: trajectory.status,
      confidence_score: trajectory.confidence,

      progress_narrative: narrative,
      key_wins: keyWins,
      key_concerns: keyConcerns,
      next_week_priorities: priorities,

      details: {
        session_matches: matching.matches,
        long_run: matching.longRun,
        comparable_pairs: comparable.pairs,
        comparable_pair_count: comparable.pairCount,
        active_day_count: completedTotals.activeDayCount
      },

      updated_at: new Date().toISOString()
    };

    /* ── persist (best effort — table may not exist yet) ─────── */

    let stored = false;

    if (plan) {
      try {
        await supabaseRequest(
          "weekly_progress_summaries?on_conflict=user_id,week_start",
          {
            method: "POST",
            headers: {
              Prefer:
                "resolution=merge-duplicates,return=representation"
            },
            body: summary
          }
        );

        stored = true;
      } catch (error) {
        console.error(
          "Weekly summary could not be stored:",
          error?.message
        );
      }
    }

    return sendJson(response, 200, {
      hasSummary: Boolean(plan),
      stored,
      summary: plan ? summary : null,

      trajectory,

      countdown: {
        targetRace,
        raceDate: raceDate ? formatDateKey(raceDate) : null,
        daysUntilRace,
        weeksUntilRace,
        phase: currentPlan?.phase || plan?.phase || null,
        phaseWeek: currentPlan?.phase_week ?? null,
        phaseLengthWeeks:
          currentPlan?.phase_length_weeks ?? null
      }
    });
  } catch (error) {
    console.error("Weekly analysis failed:", error);

    return sendJson(response, 500, {
      error:
        error?.message ||
        "The weekly analysis could not be completed."
    });
  }
}
