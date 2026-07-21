import { randomUUID } from "node:crypto";
import { buildAthlevoMethodPrompt } from "../../lib/server/athlevoMethod.js";

import {
  addDays,
  calculateWeeksUntilRace,
  formatDateKey,
  getPlanningWeekStart,
  parseDateValue
} from "../../lib/server/dateUtils.js";

import {
  extractExecutionSignals,
  indexRecordsBySession,
  summarizeExecutionRecord
} from "../../lib/server/executionRecords.js";

import { applyActivityOverrides } from "../../lib/server/coachActions.js";
import { validatePrescription } from "../../lib/server/prescription.js";
import { summarizeReadiness } from "../../lib/server/readiness.js";
import {
  computeFitness,
  vdotFromRace
} from "../../lib/server/performance.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
  {
    method = "GET",
    body,
    headers = {}
  } = {}
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
    const errorText = await response.text();

    throw new Error(
      `Supabase request failed: ${response.status} ${errorText}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();

  return responseText
    ? JSON.parse(responseText)
    : null;
}

async function loadAthleteProfile(userId) {
  const rows = await supabaseRequest(
    [
      "profiles",
      `?id=eq.${encodeURIComponent(userId)}`,
      "&select=*",
      "&limit=1"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function loadAthleteMemories(userId) {
  const rows = await supabaseRequest(
    [
      "athlete_memory",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&is_active=eq.true",
      "&select=category,memory_key,content,importance,updated_at",
      "&order=importance.desc,updated_at.desc",
      "&limit=40"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function loadRecentActivities(userId) {
  const rows = await supabaseRequest(
    [
      "activities",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=id,external_activity_id,name,sport_type,activity_type,distance_meters,moving_time_seconds,elevation_gain_meters,average_heartrate,max_heartrate,average_cadence,start_date,trainer",
      "&order=start_date.desc",
      "&limit=200"
    ].join("")
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function optionalSupabaseRequest(path) {
  try {
    return await supabaseRequest(path);
  } catch (error) {
    console.error(
      "Optional adaptation data unavailable:",
      error?.message
    );
    return null;
  }
}

async function loadRaceResults(userId) {
  const rows = await optionalSupabaseRequest(
    [
      "race_results",
      `?user_id=eq.${encodeURIComponent(userId)}`,
      "&select=source,race_type,distance_meters,duration_seconds,race_date",
      "&order=race_date.desc",
      "&limit=50"
    ].join("")
  );

  return Array.isArray(rows) ? rows : [];
}

const FITNESS_ELIGIBLE_RACE_TYPES = new Set([
  "official",
  "time_trial",
  "training_effort"
]);

/*
 * Derives the athlete's current fitness (Current Running Level + training
 * paces) from RAW inputs — confirmed races first, otherwise a flagged
 * estimate from a recent fast run — using the shared performance engine.
 * Nothing derived is stored; the plan simply receives up-to-date paces so
 * it adapts whenever fitness changes. Returns null when there is no
 * signal at all (the model then prescribes by effort, as before).
 */
function buildPerformanceModel(profile, activities, raceResults) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const ageDays = d => {
    const t = Date.parse(d);
    return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity;
  };
  const isRun = a =>
    /run|jog|tempo|interval|threshold|long/.test(
      String(a?.activity_type || a?.sport_type || "").toLowerCase()
    );

  // Best confirmed race within ~12 months.
  let best = null;
  let estimated = false;
  for (const r of raceResults || []) {
    if (!FITNESS_ELIGIBLE_RACE_TYPES.has(r.race_type)) continue;
    if (r.race_date && ageDays(r.race_date) > 400) continue;
    const vdot = vdotFromRace(r.distance_meters, r.duration_seconds);
    if (vdot == null) continue;
    if (!best || vdot > best.vdot) {
      best = { vdot, distanceKm: num(r.distance_meters) / 1000, raceDate: r.race_date };
    }
  }

  // Otherwise estimate from the best recent run.
  if (!best) {
    for (const a of activities || []) {
      if (!isRun(a) || ageDays(a.start_date) > 120) continue;
      const meters = num(a.distance_meters);
      const seconds = num(a.moving_time_seconds);
      if (!meters || meters < 3000 || !seconds) continue;
      const vdot = vdotFromRace(meters, seconds);
      if (vdot == null) continue;
      if (!best || vdot > best.vdot) {
        best = { vdot, distanceKm: meters / 1000, raceDate: null };
        estimated = true;
      }
    }
  }

  if (!best) return null;

  const fitness = computeFitness({
    vdot: best.vdot,
    estimated,
    raceDistanceKm: best.distanceKm,
    weeklyDistanceKm: num(profile?.weekly_distance)
  });

  const paces = {};
  if (fitness.paces) {
    for (const key of Object.keys(fitness.paces)) {
      if (fitness.paces[key].pace) paces[fitness.paces[key].label] = fitness.paces[key].pace;
    }
  }

  return {
    currentRunningLevel: fitness.runningLevel.level,
    tier: fitness.runningLevel.tier,
    estimated,
    trainingPaces: paces
  };
}

/*
 * Loads last week's plan, its sessions, the stored weekly progress
 * summary, and the most recent check-in. Every part is optional:
 * a missing table or empty result must never block plan
 * generation.
 */
async function loadAdaptationContext(userId, weekStart) {
  const previousWeekStart = formatDateKey(
    addDays(weekStart, -7)
  );

  const encodedUserId = encodeURIComponent(userId);

  const [previousPlans, summaries, checkIns] =
    await Promise.all([
      optionalSupabaseRequest(
        `training_plans?user_id=eq.${encodedUserId}` +
          `&week_start=eq.${previousWeekStart}` +
          "&select=id,week_focus,weekly_intent,phase," +
          "planned_distance_km,planned_hours,coach_summary" +
          "&order=updated_at.desc&limit=1"
      ),

      optionalSupabaseRequest(
        `weekly_progress_summaries?user_id=eq.${encodedUserId}` +
          `&week_start=eq.${previousWeekStart}` +
          "&select=week_start,week_end,planned_sessions," +
          "completed_sessions,completion_rate," +
          "planned_duration_minutes,completed_duration_minutes," +
          "planned_distance_km,completed_distance_km," +
          "comparable_run_count,pace_change_seconds_per_km," +
          "heart_rate_change_bpm,training_load_direction," +
          "consistency_status,recovery_status," +
          "injury_risk_status,trajectory_status," +
          "confidence_score,progress_narrative,key_wins," +
          "key_concerns,next_week_priorities&limit=1"
      ),

      optionalSupabaseRequest(
        `weekly_check_ins?user_id=eq.${encodedUserId}` +
          "&select=week_start,overall_fatigue,sleep_quality," +
          "muscle_soreness,motivation,stress_level," +
          "perceived_training_load,pain_or_injury,pain_details," +
          "sessions_felt,confidence_for_next_week,athlete_notes," +
          "submitted_at&order=week_start.desc&limit=1"
      )
    ]);

  const previousPlan = Array.isArray(previousPlans)
    ? previousPlans[0] || null
    : null;

  let previousSessions = [];
  let previousExecution = [];

  if (previousPlan?.id) {
    const rows = await optionalSupabaseRequest(
      `training_sessions?user_id=eq.${encodedUserId}` +
        `&training_plan_id=eq.${encodeURIComponent(previousPlan.id)}` +
        "&select=id,session_date,title,session_type," +
        "duration_minutes,distance_km,intensity,status" +
        "&order=session_date.asc"
    );

    previousSessions = Array.isArray(rows) ? rows : [];

    const previousSessionIds = previousSessions
      .map(session => session?.id)
      .filter(Boolean);

    if (previousSessionIds.length > 0) {
      const executionRows = await optionalSupabaseRequest(
        "workout_execution_records" +
          `?user_id=eq.${encodedUserId}` +
          `&training_session_id=in.(${previousSessionIds
            .map(id => encodeURIComponent(id))
            .join(",")})` +
          "&select=*"
      );

      previousExecution = Array.isArray(executionRows)
        ? executionRows
        : [];
    }
  }

  // Fold each session's explicit feedback onto the prescription so the
  // model sees prescribed-vs-actual in one place.
  const executionMap = indexRecordsBySession(previousExecution);

  const previousSessionsWithFeedback = previousSessions.map(session => {
    const feedback = session?.id
      ? summarizeExecutionRecord(executionMap.get(String(session.id)))
      : null;

    return feedback
      ? { ...session, athlete_feedback: feedback }
      : session;
  });

  const latestCheckIn = Array.isArray(checkIns)
    ? checkIns[0] || null
    : null;

  // Only use a check-in from the last two weeks.
  const checkInIsRecent =
    latestCheckIn?.week_start &&
    latestCheckIn.week_start >=
      formatDateKey(addDays(weekStart, -14));

  return {
    previousWeekStart,
    previousPlan,
    previousSessions: previousSessionsWithFeedback,
    executionSignals: extractExecutionSignals(previousExecution),
    progressSummary: Array.isArray(summaries)
      ? summaries[0] || null
      : null,
    weeklyCheckIn: checkInIsRecent ? latestCheckIn : null
  };
}

function getTargetRaceDate(profile) {
  return (
    profile?.race_date ||
    profile?.target_race_date ||
    null
  );
}

function getTargetRaceName(profile) {
  const value =
    profile?.target_race ||
    profile?.race_type ||
    null;

  if (
    !value ||
    String(value).trim().toLowerCase() ===
      "none"
  ) {
    return null;
  }

  return String(value).trim();
}

function getActivityDate(activity) {
  if (!activity?.start_date) {
    return null;
  }

  const date = new Date(
    activity.start_date
  );

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function summarizeActivities(
  activities,
  weekStart
) {
  const sixWeeksAgo = addDays(
    weekStart,
    -42
  );

  const sevenDaysAgo = addDays(
    weekStart,
    -7
  );

  const validActivities = activities
    .map(activity => ({
      ...activity,
      parsedDate:
        getActivityDate(activity)
    }))
    .filter(activity => activity.parsedDate);

  const lastSixWeeks =
    validActivities.filter(
      activity =>
        activity.parsedDate >=
          sixWeeksAgo &&
        activity.parsedDate <
          addDays(weekStart, 7)
    );

  const previousSevenDays =
    validActivities.filter(
      activity =>
        activity.parsedDate >=
          sevenDaysAgo &&
        activity.parsedDate <
          weekStart
    );

  const summarizeList = list => {
    const distanceMeters =
      list.reduce(
        (total, activity) =>
          total +
          (Number(
            activity.distance_meters
          ) || 0),
        0
      );

    const movingSeconds =
      list.reduce(
        (total, activity) =>
          total +
          (Number(
            activity.moving_time_seconds
          ) || 0),
        0
      );

    return {
      activityCount: list.length,

      distanceKilometers:
        Number(
          (
            distanceMeters / 1000
          ).toFixed(1)
        ),

      trainingHours:
        Number(
          (
            movingSeconds / 3600
          ).toFixed(1)
        )
    };
  };

  const weeklyHistory = [];

  for (
    let weekIndex = 5;
    weekIndex >= 0;
    weekIndex -= 1
  ) {
    const start = addDays(
      weekStart,
      -weekIndex * 7
    );

    const end = addDays(start, 7);

    const weekActivities =
      validActivities.filter(
        activity =>
          activity.parsedDate >= start &&
          activity.parsedDate < end
      );

    weeklyHistory.push({
      weekStart: formatDateKey(start),
      weekEnd: formatDateKey(
        addDays(end, -1)
      ),
      ...summarizeList(weekActivities)
    });
  }

  const activeWeeks =
    weeklyHistory.filter(
      week =>
        week.activityCount > 0
    );

  const consistentWeeks =
    activeWeeks.filter(
      week =>
        week.activityCount >= 3
    ).length;

  const latestActivities =
    validActivities
      .slice(0, 10)
      .map(activity => ({
        name:
          activity.name ||
          activity.sport_type ||
          activity.activity_type ||
          "Activity",

        sport:
          activity.sport_type ||
          activity.activity_type ||
          "Unknown",

        date:
          activity.start_date,

        distanceKilometers:
          Number(
            (
              (Number(
                activity.distance_meters
              ) || 0) / 1000
            ).toFixed(2)
          ),

        durationMinutes:
          Math.round(
            (Number(
              activity.moving_time_seconds
            ) || 0) / 60
          ),

        averageHeartRate:
          Number(
            activity.average_heartrate
          ) > 0
            ? Math.round(
                Number(
                  activity.average_heartrate
                )
              )
            : null,

        elevationGainMeters:
          Number(
            activity.elevation_gain_meters
          ) > 0
            ? Math.round(
                Number(
                  activity.elevation_gain_meters
                )
              )
            : null
      }));

  return {
    previousSevenDays:
      summarizeList(
        previousSevenDays
      ),

    sixWeekTotals:
      summarizeList(lastSixWeeks),

    weeklyHistory,

    activeWeeks:
      activeWeeks.length,

    consistentWeeks,

    latestActivities
  };
}

function determinePeriodization({
  weeksUntilRace,
  activitySummary,
  profile
}) {
  const availableDays = Number(
    profile?.available_days ??
    profile?.training_days ??
    0
  );

  const hasStableRecentBase =
    activitySummary.consistentWeeks >= 3 &&
    activitySummary.activeWeeks >= 4;

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 0
  ) {
    return {
      phase: "recovery",
      phaseWeek: 1,
      phaseLengthWeeks: 2,
      label: "Post-race recovery",
      compressed: false
    };
  }

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 3
  ) {
    return {
      phase: "taper",
      phaseWeek:
        Math.max(
          1,
          4 - weeksUntilRace
        ),
      phaseLengthWeeks: 3,
      label: "Taper",
      compressed:
        !hasStableRecentBase
    };
  }

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 8
  ) {
    return {
      phase: "race_preparation",
      phaseWeek:
        Math.max(
          1,
          9 - weeksUntilRace
        ),
      phaseLengthWeeks: 5,
      label: "Race preparation",
      compressed:
        !hasStableRecentBase
    };
  }

  if (
    weeksUntilRace !== null &&
    weeksUntilRace <= 14
  ) {
    return {
      phase: "development",
      phaseWeek:
        Math.max(
          1,
          15 - weeksUntilRace
        ),
      phaseLengthWeeks: 6,
      label: "Development",
      compressed:
        !hasStableRecentBase
    };
  }

  if (weeksUntilRace !== null) {
    return {
      phase: "foundation",
      phaseWeek: 1,
      phaseLengthWeeks: 6,
      label: "Foundation",
      compressed: false
    };
  }

  if (
    hasStableRecentBase &&
    availableDays >= 3
  ) {
    return {
      phase: "maintenance",
      phaseWeek: 1,
      phaseLengthWeeks: 4,
      label: "Maintenance and development",
      compressed: false
    };
  }

  return {
    phase: "foundation",
    phaseWeek: 1,
    phaseLengthWeeks: 6,
    label: "Foundation",
    compressed: false
  };
}

function getPhaseGuidance(
  periodization
) {
  const guidance = {
    foundation: {
      intent:
        "Build aerobic durability, tissue tolerance, heat adaptation, and reliable training frequency.",

      distribution: {
        ground: 75,
        control: 17,
        threshold: 3,
        edge: 5
      }
    },

    development: {
      intent:
        "Develop fatigue resistance and controlled Threshold tolerance while maintaining aerobic durability.",

      distribution: {
        ground: 68,
        control: 18,
        threshold: 10,
        edge: 4
      }
    },

    race_preparation: {
      intent:
        "Integrate race-specific work while protecting the lower-tier adaptations that support it.",

      distribution: {
        ground: 65,
        control: 18,
        threshold: 12,
        edge: 5
      }
    },

    taper: {
      intent:
        "Reduce accumulated fatigue while maintaining frequency, race-specific rhythm, and neuromuscular sharpness.",

      distribution: {
        ground: 70,
        control: 15,
        threshold: 10,
        edge: 5
      }
    },

    recovery: {
      intent:
        "Resolve race and block fatigue before beginning another structured progression.",

      distribution: {
        ground: 95,
        control: 0,
        threshold: 0,
        edge: 5
      }
    },

    maintenance: {
      intent:
        "Maintain aerobic durability, fatigue resistance, and speed economy without a fixed race deadline.",

      distribution: {
        ground: 72,
        control: 18,
        threshold: 6,
        edge: 4
      }
    }
  };

  return guidance[
    periodization.phase
  ];
}

function extractResponseText(data) {
  if (
    typeof data.output_text ===
      "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const output =
    Array.isArray(data.output)
      ? data.output
      : [];

  for (const item of output) {
    const content =
      Array.isArray(item.content)
        ? item.content
        : [];

    for (const part of content) {
      if (
        part.type ===
          "output_text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
    }
  }

  return null;
}

async function generateWeeklyPlan({
  profile,
  memories,
  activitySummary,
  performanceModel,
  targetRace,
  raceDate,
  weeksUntilRace,
  weekStart,
  weekEnd,
  periodization,
  phaseGuidance,
  adaptationContext,
  /*
   * Computed in the handler from daily_readiness. It was previously READ
   * here but never PASSED, so every call threw
   * "ReferenceError: recentReadiness is not defined" while building the
   * request body — plan generation failed 100% of the time. Defaulted to []
   * so an omitted argument degrades to "no readiness data" instead of
   * crashing the whole endpoint.
   */
  recentReadiness = []
}) {
  const athlevoMethodPrompt =
    buildAthlevoMethodPrompt();

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          `Bearer ${OPENAI_API_KEY}`
      },

      body: JSON.stringify({
        model: "gpt-5.5",

        reasoning: {
          effort: "medium"
        },

        input: [
          {
            role: "developer",

            content: `
${athlevoMethodPrompt}

WEEKLY TRAINING PLAN GENERATION

Create exactly seven entries, one for each date from Monday through Sunday.

The periodization phase has already been determined by the application. Do not change it.

CURRENT PHASE
${periodization.phase}

PHASE LABEL
${periodization.label}

PHASE INTENT
${phaseGuidance.intent}

WEEK START
${formatDateKey(weekStart)}

WEEK END
${formatDateKey(weekEnd)}

TARGET RACE
${targetRace || "No confirmed target race"}

RACE DATE
${raceDate ? formatDateKey(raceDate) : "No confirmed race date"}

WEEKS UNTIL RACE
${weeksUntilRace === null ? "Not applicable" : weeksUntilRace}

COMPRESSED PREPARATION
${periodization.compressed ? "Yes" : "No"}

Rules:

1. Return one session for every day, including rest days.
2. Respect the athlete's realistic available training days.
3. Do not schedule Threshold on consecutive days.
4. Normally schedule no more than one or two Threshold sessions per week.
5. Never make up missed intensity.
6. Ground must remain the majority of weekly training.
7. Edge volume must remain low.
8. Use the Athlevo workout names where appropriate:
   Foundation Run
   Foundation Long
   Stability Cruise
   Stability Blocks
   Pressure Waves
   Pressure Ladder
   Pressure Cruise
   Surge Strides
   Surge Hills
   Conversion Run
9. Do not invent exact pace or heart-rate targets when the athlete's thresholds or HRmax are unknown.
10. When pace data is uncertain, prescribe using effort, breathing, mechanics, and Athlevo zones. However, when performanceModel.trainingPaces is present, those paces ARE known — use the matching zone's pace for target_pace (e.g. the Threshold pace for a threshold session, Easy for easy running). If performanceModel.estimated is true, treat the paces as a starting guide and lean slightly conservative.
11. Account for injury memories, work schedule, sleep patterns, preferred training time, diet, and other durable athlete constraints.
12. Do not claim access to sleep, HRV, readiness, weather, soreness, or recovery information unless it appears in the supplied data.
13. If preparation is compressed, state that clearly and prioritize safe completion and durability over aggressive race-specific loading.
14. Each session must explain why it exists in the current phase.
15. Rest days must use the same session structure with session_type "rest", sport "rest", duration_minutes null, intensity "Rest", and empty arrays for warmup, main_set, cooldown, instructions, and adjustment_rules.
16. Use ISO dates in YYYY-MM-DD format, and set day to the weekday name that matches session_date.
17. Keep instructions clear and executable.
18. Leave target_pace, target_hr, target_rpe, fueling, notes, or any other text field as an empty string whenever the supplied athlete context is insufficient to fill it. Never invent values.
19. Return valid structured data only.

WEEKLY ADAPTATION RULES

The athlete data may include previousWeek (last week's plan and sessions), weeklyProgressSummary (server-computed truth about what actually happened), and weeklyCheckIn (the athlete's own report). Adapt the new week using them:

1. Trust weeklyProgressSummary numbers over impressions. Never invent completion, pace, heart-rate, sleep, soreness, or recovery information that is not in the supplied data.
2. If completion was low because of schedule constraints, reorganize days or reduce complexity. Do not automatically reduce fitness targets.
3. If the check-in shows high fatigue (4 or 5) or poor sleep (1 or 2), reduce load and protect recovery this week.
4. If pain or injury is reported, avoid aggravating intensity, adjust affected sessions, and state a clear safety recommendation in why_it_changed and in the affected sessions' notes.
5. If completion was strong and recovery is stable, progress load conservatively — roughly 5 to 10 percent, never more.
6. Never move missed sessions into this week. A missed week stays missed.
7. Never let one good or bad workout drive a large change. Adapt to weekly patterns, not single days.
8. Fill what_changed, why_it_changed, and kept_stable with short, specific, truthful statements about this plan versus last week. If there is no previous week data, say so plainly in those fields and plan normally.

SESSION FEEDBACK RULES

Each previousWeek session may carry athlete_feedback (the athlete's own report: completed, skipped, or modified, with actual duration, RPE, feeling, and pain). sessionExecutionSignals summarizes pain reports, skips, and hard sessions across the week. Use them as follows:

a. Never shame the athlete for a skip or modification, in any text field. State facts and adjust plainly.
b. A single skipped or modified session is not a trend. Do not overhaul the week over one day.
c. If a skip reason is schedule, travel, or weather, adjust which days sessions land on. Do not reduce fitness targets for those skips.
d. If any session reports pain (pain_present), treat the affected area carefully next week, avoid aggravating intensity, and name the precaution in why_it_changed and in the affected sessions' notes. Pain is remembered for future planning.
e. If sessions were repeatedly reported as harder than expected or at RPE 8 or above while recovery is not strong, hold or ease intensity rather than progressing.
f. If strong completion and modifications still landed the intended work with stable recovery, conservative progression is acceptable.
g. Only when adjust_remaining_week signals the athlete asked for it should missed days trigger reshaping of the remaining week — and even then, never move missed intensity into the next day.

DAILY READINESS HISTORY

The athlete data may include recentReadiness: their own daily reports of sleep, energy, muscle soreness, mental stress, and pain over the last two weeks. Use the pattern (not a single day) to decide how aggressively to ramp: a run of poor sleep, low energy, high soreness/stress, or repeated pain means ramp conservatively and protect recovery; consistently strong readiness with good completion supports normal progression. Never invent readiness values, and never present a fabricated readiness or recovery score — reason only from the reported inputs.
            `.trim()
          },

          {
            role: "user",

            content: JSON.stringify(
              {
                athleteProfile:
                  profile,

                athleteMemories:
                  memories,

                recentTraining:
                  activitySummary,

                // Athlete's current fitness derived from confirmed races
                // (or a flagged estimate). When present, its trainingPaces
                // are authoritative — prescribe from them instead of
                // leaving pace fields empty.
                performanceModel:
                  performanceModel || null,

                requiredPeriodization: {
                  targetRace,
                  raceDate:
                    raceDate
                      ? formatDateKey(
                          raceDate
                        )
                      : null,

                  weeksUntilRace,
                  phase:
                    periodization.phase,

                  phaseLabel:
                    periodization.label,

                  phaseWeek:
                    periodization.phaseWeek,

                  phaseLengthWeeks:
                    periodization.phaseLengthWeeks,

                  compressed:
                    periodization.compressed,

                  intendedZoneDistribution:
                    phaseGuidance.distribution
                },

                previousWeek:
                  adaptationContext?.previousPlan
                    ? {
                        weekStart:
                          adaptationContext.previousWeekStart,
                        plan:
                          adaptationContext.previousPlan,
                        sessions:
                          adaptationContext.previousSessions
                      }
                    : null,

                weeklyProgressSummary:
                  adaptationContext?.progressSummary ||
                  null,

                weeklyCheckIn:
                  adaptationContext?.weeklyCheckIn ||
                  null,

                sessionExecutionSignals:
                  adaptationContext?.executionSignals ||
                  null,

                recentReadiness:
                  (Array.isArray(recentReadiness) && recentReadiness.length)
                    ? recentReadiness
                    : null
              },
              null,
              2
            )
          }
        ],

        text: {
          format: {
            type: "json_schema",
            name:
              "athlevo_weekly_training_plan",
            strict: true,

            schema: {
              type: "object",
              additionalProperties: false,

              properties: {
                week_focus: {
                  type: "string"
                },

                weekly_intent: {
                  type: "string"
                },

                coach_summary: {
                  type: "string"
                },

                progression_reasoning: {
                  type: "string"
                },

                planned_distance_km: {
                  type: [
                    "number",
                    "null"
                  ]
                },

                planned_hours: {
                  type: [
                    "number",
                    "null"
                  ]
                },

                what_changed: {
                  type: "string"
                },

                why_it_changed: {
                  type: "string"
                },

                kept_stable: {
                  type: "string"
                },

                sessions: {
                  type: "array",
                  minItems: 7,
                  maxItems: 7,

                  items: {
                    type: "object",
                    additionalProperties:
                      false,

                    properties: {
                      session_date: {
                        type: "string",
                        pattern:
                          "^\\d{4}-\\d{2}-\\d{2}$"
                      },

                      day: {
                        type: "string",
                        enum: [
                          "Monday",
                          "Tuesday",
                          "Wednesday",
                          "Thursday",
                          "Friday",
                          "Saturday",
                          "Sunday"
                        ]
                      },

                      title: {
                        type: "string"
                      },

                      sport: {
                        type: "string"
                      },

                      session_type: {
                        type: "string"
                      },

                      duration_minutes: {
                        type: [
                          "integer",
                          "null"
                        ]
                      },

                      distance_km: {
                        type: [
                          "number",
                          "null"
                        ]
                      },

                      intensity: {
                        type: [
                          "string",
                          "null"
                        ]
                      },

                      purpose: {
                        type: "string"
                      },

                      description: {
                        type: "string"
                      },

                      instructions: {
                        type: "array",
                        items: {
                          type: "string"
                        },
                        maxItems: 10
                      },

                      warmup: {
                        type: "array",
                        items: {
                          type: "string"
                        }
                      },

                      main_set: {
                        type: "array",
                        items: {
                          type: "string"
                        }
                      },

                      cooldown: {
                        type: "array",
                        items: {
                          type: "string"
                        }
                      },

                      target_pace: {
                        type: "string"
                      },

                      target_hr: {
                        type: "string"
                      },

                      target_rpe: {
                        type: "string"
                      },

                      fueling: {
                        type: "string"
                      },

                      notes: {
                        type: "string"
                      },

                      adjustment_rules: {
                        type: "array",
                        items: {
                          type: "string"
                        },
                        maxItems: 8
                      },

                      coach_reasoning: {
                        type: "string"
                      }
                    },

                    required: [
                      "session_date",
                      "day",
                      "title",
                      "sport",
                      "session_type",
                      "duration_minutes",
                      "distance_km",
                      "intensity",
                      "purpose",
                      "description",
                      "instructions",
                      "warmup",
                      "main_set",
                      "cooldown",
                      "target_pace",
                      "target_hr",
                      "target_rpe",
                      "fueling",
                      "notes",
                      "adjustment_rules",
                      "coach_reasoning"
                    ]
                  }
                }
              },

              required: [
                "week_focus",
                "weekly_intent",
                "coach_summary",
                "progression_reasoning",
                "planned_distance_km",
                "planned_hours",
                "what_changed",
                "why_it_changed",
                "kept_stable",
                "sessions"
              ]
            }
          }
        }
      })
    }
  );

  const responseData =
    await response.json();

  if (!response.ok) {
    console.error(
      "Training plan OpenAI error:",
      responseData
    );

    throw new Error(
      responseData?.error?.message ||
      "Could not generate the weekly training plan."
    );
  }

  const outputText =
    extractResponseText(
      responseData
    );

  if (!outputText) {
    throw new Error(
      "The generated training plan was empty."
    );
  }

  return JSON.parse(outputText);
}

function validateSessionDates(
  sessions,
  weekStart
) {
  const expectedDates =
    Array.from(
      { length: 7 },
      (_, index) =>
        formatDateKey(
          addDays(
            weekStart,
            index
          )
        )
    );

  const receivedDates =
    sessions.map(
      session =>
        session.session_date
    );

  const datesAreCorrect =
    expectedDates.every(
      expectedDate =>
        receivedDates.includes(
          expectedDate
        )
    );

  if (!datesAreCorrect) {
    throw new Error(
      "The generated plan did not contain the correct seven dates."
    );
  }
}

async function saveTrainingPlan({
  userId,
  plan,
  weekStart,
  weekEnd,
  targetRace,
  raceDate,
  weeksUntilRace,
  periodization,
  phaseGuidance
}) {
  const planBody = {
        user_id: userId,

        week_start:
          formatDateKey(weekStart),

        week_end:
          formatDateKey(weekEnd),

        target_race:
          targetRace,

        race_date:
          raceDate
            ? formatDateKey(
                raceDate
              )
            : null,

        weeks_until_race:
          weeksUntilRace,

        phase:
          periodization.phase,

        phase_week:
          periodization.phaseWeek,

        phase_length_weeks:
          periodization.phaseLengthWeeks,

        week_focus:
          plan.week_focus,

        weekly_intent:
          plan.weekly_intent,

        planned_distance_km:
          plan.planned_distance_km,

        planned_hours:
          plan.planned_hours,

        ground_percentage:
          phaseGuidance
            .distribution.ground,

        control_percentage:
          phaseGuidance
            .distribution.control,

        threshold_percentage:
          phaseGuidance
            .distribution.threshold,

        edge_percentage:
          phaseGuidance
            .distribution.edge,

        coach_summary:
          plan.coach_summary,

        progression_reasoning:
          periodization.compressed
            ? `Compressed preparation: ${plan.progression_reasoning}`
            : plan.progression_reasoning,

        adaptation: {
          what_changed:
            plan.what_changed || "",

          why_it_changed:
            plan.why_it_changed || "",

          kept_stable:
            plan.kept_stable || ""
        },

        status: "active",

        generated_at:
          new Date().toISOString(),

        updated_at:
          new Date().toISOString()
      };

  const upsertPlan = body =>
    supabaseRequest(
      [
        "training_plans",
        "?on_conflict=user_id,week_start"
      ].join(""),
      {
        method: "POST",

        headers: {
          Prefer:
            "resolution=merge-duplicates,return=representation"
        },

        body
      }
    );

  let rows;

  try {
    rows = await upsertPlan(planBody);
  } catch (error) {
    // Backward compatibility: if the adaptation column does not
    // exist yet (migration not run), save the plan without it.
    console.error(
      "Plan save with adaptation failed, retrying without it:",
      error?.message
    );

    const { adaptation, ...legacyBody } = planBody;

    rows = await upsertPlan(legacyBody);
  }

  return Array.isArray(rows)
    ? rows[0] || null
    : rows;
}

async function saveTrainingSessions({
  userId,
  trainingPlanId,
  sessions,
  periodization,
  weekFocus,
  weekStart
}) {
  // Canonical prescription gate: repair any label/main-set contradiction the
  // generator may have produced (e.g. an "easy" session whose main set is a
  // threshold block) BEFORE it is ever stored. Deterministic; logs only.
  const validatedSessions = (Array.isArray(sessions) ? sessions : []).map(s => {
    const v = validatePrescription(s);
    if (v.changed) {
      console.warn("generate-plan: repaired contradictory prescription", {
        date: s && s.session_date, from: s && s.session_type,
        to: v.session.session_type, issues: v.contradictions
      });
    }
    return v.session;
  });

  const rowsToSave =
    validatedSessions.map(session => ({
      user_id: userId,

      training_plan_id:
        trainingPlanId,

      session_date:
        session.session_date,

      title:
        session.title,

      sport:
        session.sport ||
        "run",

      session_type:
        session.session_type,

      duration_minutes:
        session.duration_minutes,

      distance_km:
        session.distance_km,

      intensity:
        session.intensity,

      purpose:
        session.purpose,

      instructions:
        session.instructions || [],

      day:
        session.day,

      description:
        session.description,

      warmup:
        session.warmup || [],

      main_set:
        session.main_set || [],

      cooldown:
        session.cooldown || [],

      pace_guidance:
        session.target_pace,

      heart_rate_guidance:
        session.target_hr,

      target_rpe:
        session.target_rpe,

      fueling_guidance:
        session.fueling,

      notes:
        session.notes,

      adjustment_rules:
        session.adjustment_rules ||
        [],

      coach_reasoning:
        session.coach_reasoning,

      status: "planned",
      source: "ai_generated",

      plan_week_start:
        formatDateKey(weekStart),

      phase:
        periodization.phase,

      weeks_until_race:
        periodization.weeksUntilRace ??
        null,

      week_focus:
        weekFocus,

      updated_at:
        new Date().toISOString()
    }));

  return supabaseRequest(
    [
      "training_sessions",
      "?on_conflict=user_id,session_date"
    ].join(""),
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation"
      },

      body: rowsToSave
    }
  );
}

export default async function handler(
  request,
  response
) {
  if (request.method !== "POST") {
    return sendJson(
      response,
      405,
      {
        error:
          "Method not allowed."
      }
    );
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error("generate-plan: Supabase server configuration is missing.");
    return sendJson(response, 503, {
      error: "Athlevo is having trouble right now. Please try again shortly.",
      code: "PLAN_UNAVAILABLE",
      action: "retry"
    });
  }

  if (!OPENAI_API_KEY) {
    // Never name an environment variable to the athlete.
    console.error("generate-plan: OPENAI_API_KEY is not configured.");
    return sendJson(response, 503, {
      error: "Your coach is unavailable right now. Please try again shortly.",
      code: "PLAN_PROVIDER_UNAVAILABLE",
      action: "retry"
    });
  }

  try {
    const accessToken =
      getBearerToken(request);

    if (!accessToken) {
      return sendJson(response, 401, {
        error: "Please sign in again to build your plan.",
        code: "AUTH_REQUIRED",
        action: "signIn"
      });
    }

    const user =
      await getAuthenticatedUser(
        accessToken
      );

    if (!user?.id) {
      return sendJson(response, 401, {
        error: "Please sign in again to build your plan.",
        code: "AUTH_REQUIRED",
        action: "signIn"
      });
    }

    const [
      profile,
      memories,
      activities
    ] = await Promise.all([
      loadAthleteProfile(user.id),
      loadAthleteMemories(user.id),
      loadRecentActivities(user.id)
    ]);

    if (!profile) {
      return sendJson(response, 404, {
        error: "We need a few details about you before building your plan.",
        code: "PROFILE_INCOMPLETE",
        action: "completeProfile"
      });
    }

    const today = new Date();

const weekStart =
  getPlanningWeekStart();

const weekEnd =
  addDays(weekStart, 6);

    /*
     * ── Idempotency guard ─────────────────────────────────────────────
     * Double-clicks, retries, refreshes and two open tabs all POST here.
     * If a plan already exists for the target week we return it instead of
     * calling the model again — no duplicate AI spend, no rewritten week.
     * An EXPLICIT rebuild (body/query `regenerate: true`) still regenerates,
     * so legitimate regeneration and future plan updates are unaffected.
     * (Row-level duplication is separately impossible: sessions upsert on
     * conflict (user_id, session_date).)
     */
    const explicitRegenerate =
      (request.body && (request.body.regenerate === true || request.body.regenerate === "true")) ||
      (request.query && (request.query.regenerate === "true" || request.query.regenerate === true));

    if (!explicitRegenerate) {
      const existingWeek = await optionalSupabaseRequest(
        `training_sessions?user_id=eq.${encodeURIComponent(user.id)}` +
          `&plan_week_start=eq.${encodeURIComponent(formatDateKey(weekStart))}` +
          `&select=id&limit=1`
      );
      if (Array.isArray(existingWeek) && existingWeek.length > 0) {
        console.log(
          JSON.stringify({
            event: "plan_generation_duplicate_prevented",
            correlationId: randomUUID(),
            weekStart: formatDateKey(weekStart)
          })
        );
        return response.status(200).json({
          success: true,
          alreadyExists: true,
          weekStart: formatDateKey(weekStart),
          message: "A training plan already exists for this week."
        });
      }
    }

    const targetRace =
      getTargetRaceName(profile);

    const raceDate =
      parseDateValue(
        getTargetRaceDate(profile)
      );

    const weeksUntilRace =
      calculateWeeksUntilRace(
        raceDate,
        weekStart
      );

    // Athlete-confirmed activity corrections take priority over raw
    // Strava values when planning the next week.
    const activityOverrides = await optionalSupabaseRequest(
      `activity_data_overrides?user_id=eq.${encodeURIComponent(
        user.id
      )}&select=*`
    );

    const effectiveActivities = applyActivityOverrides(
      activities,
      Array.isArray(activityOverrides) ? activityOverrides : []
    );

    // Historical daily readiness (last ~14 days) informs how hard to
    // ramp the next week — the athlete's own reports, never a score.
    const readinessSinceKey = formatDateKey(addDays(weekStart, -14));
    const readinessRows = await optionalSupabaseRequest(
      `daily_readiness?user_id=eq.${encodeURIComponent(user.id)}` +
        `&readiness_date=gte.${readinessSinceKey}` +
        "&select=*&order=readiness_date.desc&limit=14"
    );

    const recentReadiness = (Array.isArray(readinessRows) ? readinessRows : [])
      .map(summarizeReadiness)
      .filter(Boolean);

    const activitySummary =
      summarizeActivities(
        effectiveActivities,
        weekStart
      );

    // Performance foundation: derive Current Running Level + training
    // paces from raw race_results (or a recent-run estimate) so the plan
    // adapts to the athlete's current fitness. Optional and non-blocking.
    const raceResults = await loadRaceResults(user.id);
    const performanceModel = buildPerformanceModel(
      profile,
      effectiveActivities,
      raceResults
    );

    const periodization =
      determinePeriodization({
        weeksUntilRace,
        activitySummary,
        profile
      });

    periodization.weeksUntilRace =
      weeksUntilRace;

    const phaseGuidance =
      getPhaseGuidance(
        periodization
      );

    const adaptationContext =
      await loadAdaptationContext(
        user.id,
        weekStart
      );

    const generatedPlan =
      await generateWeeklyPlan({
        profile,
        memories,
        activitySummary,
        performanceModel,
        targetRace,
        raceDate,
        weeksUntilRace,
        weekStart,
        weekEnd,
        periodization,
        phaseGuidance,
        adaptationContext,
        recentReadiness
      });

    validateSessionDates(
      generatedPlan.sessions,
      weekStart
    );

    const savedPlan =
      await saveTrainingPlan({
        userId: user.id,
        plan: generatedPlan,
        weekStart,
        weekEnd,
        targetRace,
        raceDate,
        weeksUntilRace,
        periodization,
        phaseGuidance
      });

    if (!savedPlan?.id) {
      throw new Error(
        "The weekly plan could not be saved."
      );
    }

    const savedSessions =
      await saveTrainingSessions({
        userId: user.id,
        trainingPlanId:
          savedPlan.id,

        sessions:
          generatedPlan.sessions,

        periodization,

        weekFocus:
          generatedPlan.week_focus,

        weekStart
      });

    return sendJson(
      response,
      200,
      {
        success: true,

        plan: savedPlan,

        sessions:
          Array.isArray(savedSessions)
            ? savedSessions
            : [],

        periodization: {
          targetRace,
          raceDate:
            raceDate
              ? formatDateKey(
                  raceDate
                )
              : null,

          weeksUntilRace,
          phase:
            periodization.phase,

          phaseLabel:
            periodization.label,

          phaseWeek:
            periodization.phaseWeek,

          phaseLengthWeeks:
            periodization.phaseLengthWeeks,

          compressedPreparation:
            periodization.compressed
        }
      }
    );
  } catch (error) {
    // Full detail to the server log ONLY.
    console.error(
      "Training plan generation failed:",
      error
    );

    const mapped = describePlanFailure(error);
    return sendJson(response, mapped.status, {
      error: mapped.message,
      code: mapped.code,
      action: mapped.action
    });
  }
}

/*
 * Turns any internal failure into something an athlete can read and act on.
 *
 * Previously the raw error was returned verbatim, so a real athlete could see
 * "Supabase request failed: 500 insert failed" or an unhandled SyntaxError
 * from JSON.parse. Those are useless to them and leak our internals. The
 * detail still goes to the server log above; only the mapped message travels
 * to the browser.
 */
function describePlanFailure(error) {
  const raw = String((error && error.message) || "");
  const lower = raw.toLowerCase();

  // The model returned something that wasn't a usable plan.
  if (
    error instanceof SyntaxError ||
    lower.includes("not valid json") ||
    lower.includes("was empty") ||
    lower.includes("correct seven dates")
  ) {
    return {
      status: 502,
      code: "PLAN_INVALID_OUTPUT",
      message: "We couldn't build a complete week just now. Please try again.",
      action: "retry"
    };
  }

  // The AI provider itself failed or timed out.
  if (
    lower.includes("openai") ||
    lower.includes("upstream") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("rate limit") ||
    lower.includes("econnreset") ||
    lower.includes("fetch failed")
  ) {
    return {
      status: 503,
      code: "PLAN_PROVIDER_UNAVAILABLE",
      message: "Your coach is busy right now. Please try again in a moment.",
      action: "retry"
    };
  }

  // Persistence failed — nothing was saved, so a retry is safe.
  if (
    lower.includes("supabase") ||
    lower.includes("could not be saved") ||
    lower.includes("insert") ||
    lower.includes("duplicate key") ||
    lower.includes("constraint")
  ) {
    return {
      status: 500,
      code: "PLAN_SAVE_FAILED",
      message: "We built your plan but couldn't save it. Please try again.",
      action: "retry"
    };
  }

  return {
    status: 500,
    code: "PLAN_FAILED",
    message: "We couldn't create your plan just now. Please try again.",
    action: "retry"
  };
}