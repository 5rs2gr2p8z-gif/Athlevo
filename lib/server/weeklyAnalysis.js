/*
 * Pure, deterministic weekly-analysis logic.
 *
 * Everything here is computed from real stored data. Nothing is
 * estimated, extrapolated, or invented. When the data is not good
 * enough to support a claim, the functions return explicit
 * "insufficient" results and the narrative says so.
 */

/* ─── generic helpers ─────────────────────────────────────────── */

export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function manilaDateKey(isoString) {
  if (!isoString) {
    return null;
  }

  const date = new Date(isoString);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  // en-CA produces YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function isRestSession(session) {
  const type = String(session?.session_type || "").toLowerCase();
  const sport = String(session?.sport || "").toLowerCase();
  const intensity = String(session?.intensity || "").toLowerCase();

  return (
    type === "rest" ||
    type === "rest_day" ||
    sport === "rest" ||
    intensity === "rest"
  );
}

export function isRunActivity(activity) {
  const sport = String(
    activity?.sport_type || activity?.activity_type || ""
  ).toLowerCase();

  return sport.includes("run");
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/* ─── session completion matching ─────────────────────────────── */

/*
 * Matches planned (non-rest) sessions to imported activities by
 * calendar day (Asia/Manila). A session counts as completed when
 * an activity exists on that day and, if the session had a planned
 * duration, the activity covered at least 40% of it.
 */
export function matchPlannedSessions(sessions, activities) {
  const activitiesByDay = new Map();

  (activities || []).forEach(activity => {
    const key = manilaDateKey(activity.start_date);

    if (!key) {
      return;
    }

    if (!activitiesByDay.has(key)) {
      activitiesByDay.set(key, []);
    }

    activitiesByDay.get(key).push(activity);
  });

  const planned = (sessions || []).filter(
    session => !isRestSession(session)
  );

  const matches = planned.map(session => {
    const dayActivities =
      activitiesByDay.get(
        String(session.session_date || "").slice(0, 10)
      ) || [];

    const best = dayActivities.reduce(
      (longest, activity) =>
        (toNumber(activity.moving_time_seconds) || 0) >
        (toNumber(longest?.moving_time_seconds) || 0)
          ? activity
          : longest,
      null
    );

    const plannedMinutes = toNumber(session.duration_minutes);
    const actualMinutes = best
      ? Math.round((toNumber(best.moving_time_seconds) || 0) / 60)
      : 0;

    const completed = Boolean(
      best &&
        (!plannedMinutes || actualMinutes >= plannedMinutes * 0.4)
    );

    return {
      session_date: session.session_date,
      title: session.title || null,
      session_type: session.session_type || null,
      planned_minutes: plannedMinutes,
      actual_minutes: best ? actualMinutes : null,
      completed
    };
  });

  const completedCount = matches.filter(m => m.completed).length;

  // Long run: the planned session with a "long" type, else the
  // longest planned duration.
  const longPlanned =
    planned.find(session =>
      String(session.session_type || "").toLowerCase().includes("long")
    ) ||
    planned.reduce(
      (longest, session) =>
        (toNumber(session.duration_minutes) || 0) >
        (toNumber(longest?.duration_minutes) || 0)
          ? session
          : longest,
      null
    );

  const longMatch = longPlanned
    ? matches.find(m => m.session_date === longPlanned.session_date)
    : null;

  return {
    plannedCount: planned.length,
    completedCount,
    completionRate: planned.length
      ? completedCount / planned.length
      : null,
    matches,
    longRun: longPlanned
      ? {
          planned: true,
          session_date: longPlanned.session_date,
          planned_minutes: toNumber(longPlanned.duration_minutes),
          actual_minutes: longMatch?.actual_minutes ?? null,
          completed: Boolean(longMatch?.completed)
        }
      : { planned: false }
  };
}

/* ─── comparable-run pace/HR comparison ───────────────────────── */

function runComparisonProfile(activity) {
  const distanceKm =
    (toNumber(activity.distance_meters) || 0) / 1000;
  const movingSeconds = toNumber(activity.moving_time_seconds) || 0;
  const heartRate = toNumber(activity.average_heartrate);
  const elevation = toNumber(activity.elevation_gain_meters);

  if (
    !isRunActivity(activity) ||
    activity.trainer === true ||
    distanceKm < 3 ||
    movingSeconds < 1500 ||
    !heartRate ||
    heartRate <= 0
  ) {
    return null;
  }

  return {
    id: activity.id || activity.external_activity_id || null,
    name: activity.name || null,
    date: manilaDateKey(activity.start_date),
    distanceKm,
    paceSecPerKm: movingSeconds / distanceKm,
    heartRate,
    elevationPerKm:
      elevation === null ? null : elevation / distanceKm
  };
}

/*
 * Two runs are comparable only when they are genuinely alike:
 * similar distance, similar elevation profile (when known), and a
 * similar average heart rate. Intervals vs easy runs, hill runs vs
 * flat runs, and no-HR runs are never paired. A pace signal is
 * reported only from >= 2 pairs across >= 2 distinct current-week
 * runs.
 */
export function findComparableRuns(weekActivities, baselineActivities) {
  const weekRuns = (weekActivities || [])
    .map(runComparisonProfile)
    .filter(Boolean);

  const baselineRuns = (baselineActivities || [])
    .map(runComparisonProfile)
    .filter(Boolean);

  const paceDeltas = [];
  const hrDeltas = [];
  const pairs = [];
  const weekRunsUsed = new Set();

  weekRuns.forEach(current => {
    baselineRuns.forEach(previous => {
      const distanceTolerance =
        current.elevationPerKm === null ||
        previous.elevationPerKm === null
          ? 0.1
          : 0.15;

      const distanceOk =
        Math.abs(current.distanceKm - previous.distanceKm) <=
        previous.distanceKm * distanceTolerance;

      const elevationOk =
        current.elevationPerKm === null ||
        previous.elevationPerKm === null
          ? true
          : Math.abs(
              current.elevationPerKm - previous.elevationPerKm
            ) <= 3;

      const heartRateOk =
        Math.abs(current.heartRate - previous.heartRate) <= 6;

      if (distanceOk && elevationOk && heartRateOk) {
        paceDeltas.push(
          current.paceSecPerKm - previous.paceSecPerKm
        );
        hrDeltas.push(current.heartRate - previous.heartRate);
        weekRunsUsed.add(current.date + "|" + current.distanceKm);

        pairs.push({
          current: {
            date: current.date,
            distance_km: Number(current.distanceKm.toFixed(2)),
            pace_sec_per_km: Math.round(current.paceSecPerKm),
            avg_hr: Math.round(current.heartRate)
          },
          baseline: {
            date: previous.date,
            distance_km: Number(previous.distanceKm.toFixed(2)),
            pace_sec_per_km: Math.round(previous.paceSecPerKm),
            avg_hr: Math.round(previous.heartRate)
          }
        });
      }
    });
  });

  const sufficient =
    pairs.length >= 2 && weekRunsUsed.size >= 2;

  return {
    pairCount: pairs.length,
    weekRunCount: weekRunsUsed.size,
    sufficient,
    paceChangeSecPerKm: sufficient
      ? Number(median(paceDeltas).toFixed(1))
      : null,
    heartRateChangeBpm: sufficient
      ? Number(median(hrDeltas).toFixed(1))
      : null,
    pairs: pairs.slice(0, 10)
  };
}

/* ─── weekly totals, load, consistency ────────────────────────── */

export function summarizeActivityTotals(activities) {
  let seconds = 0;
  let meters = 0;
  const activeDays = new Set();

  (activities || []).forEach(activity => {
    seconds += toNumber(activity.moving_time_seconds) || 0;
    meters += toNumber(activity.distance_meters) || 0;

    const key = manilaDateKey(activity.start_date);

    if (key) {
      activeDays.add(key);
    }
  });

  return {
    minutes: Math.round(seconds / 60),
    distanceKm: Number((meters / 1000).toFixed(1)),
    activityCount: (activities || []).length,
    activeDayCount: activeDays.size
  };
}

export function computeLoadDirection(thisWeekMinutes, priorWeekMinutes) {
  const active = (priorWeekMinutes || []).filter(m => m > 0);

  if (active.length < 2) {
    return "insufficient_data";
  }

  const priorAverage =
    active.reduce((a, b) => a + b, 0) / active.length;

  if (thisWeekMinutes >= priorAverage * 1.1) {
    return "increasing";
  }

  if (thisWeekMinutes <= priorAverage * 0.9) {
    return "decreasing";
  }

  return "stable";
}

export function computeConsistencyStatus(activeDayCount, completionRate) {
  if (activeDayCount === 0 && completionRate === null) {
    return "insufficient_data";
  }

  if (
    activeDayCount >= 4 ||
    (activeDayCount >= 3 && (completionRate ?? 0) >= 0.75)
  ) {
    return "consistent";
  }

  if (activeDayCount >= 2) {
    return "developing";
  }

  return "sparse";
}

/* ─── check-in interpretation ─────────────────────────────────── */

export function assessRecovery(checkIn) {
  if (!checkIn) {
    return { status: "unknown", score: null };
  }

  const fatigue = toNumber(checkIn.overall_fatigue);
  const sleep = toNumber(checkIn.sleep_quality);
  const soreness = toNumber(checkIn.muscle_soreness);
  const stress = toNumber(checkIn.stress_level);
  const motivation = toNumber(checkIn.motivation);

  const parts = [];

  if (fatigue !== null) parts.push(6 - fatigue);
  if (sleep !== null) parts.push(sleep);
  if (soreness !== null) parts.push(6 - soreness);
  if (stress !== null) parts.push(6 - stress);
  if (motivation !== null) parts.push(motivation);

  if (parts.length < 3) {
    return { status: "unknown", score: null };
  }

  const score =
    parts.reduce((a, b) => a + b, 0) / (parts.length * 5);

  return {
    status: score < 0.45 ? "poor" : score < 0.65 ? "fair" : "good",
    score: Number(score.toFixed(2))
  };
}

export function assessInjuryRisk(checkIn, injuryMemories) {
  if (checkIn?.pain_or_injury === true) {
    return "elevated";
  }

  if ((injuryMemories || []).length > 0) {
    return "monitor";
  }

  return "none_reported";
}

export function filterInjuryMemories(memories) {
  return (memories || []).filter(memory => {
    const haystack = [
      memory.category,
      memory.memory_key,
      memory.content
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return /injur|pain|niggle|strain|tendon|shin|knee|achilles|calf/.test(
      haystack
    );
  });
}

/* ─── trajectory ──────────────────────────────────────────────── */

export function computeTrajectory({
  hasPlan,
  plannedCount,
  completionRate,
  comparable,
  recovery,
  injuryRisk,
  longRun,
  consistencyStatus,
  weeksUntilRace,
  hasCheckIn,
  activityCount,
  historyWeeks
}) {
  const reasons = [];

  // confidence: how much evidence supports the call
  let confidence = 0.3;
  if (hasCheckIn) confidence += 0.2;
  if (comparable?.sufficient) confidence += 0.2;
  if (activityCount >= 3) confidence += 0.1;
  if (historyWeeks >= 4) confidence += 0.15;
  confidence = Math.min(confidence, 0.95);

  const confidenceLabel =
    confidence < 0.45 ? "low" : confidence < 0.7 ? "moderate" : "high";

  if (!hasPlan || plannedCount === 0 || (activityCount === 0 && !hasCheckIn)) {
    return {
      status: "insufficient_data",
      label: "Insufficient Data",
      confidence: Number(Math.min(confidence, 0.4).toFixed(2)),
      confidenceLabel: "low",
      explanation:
        "There is not yet enough planned and completed training in this period to judge trajectory."
    };
  }

  const rate = completionRate ?? 0;

  // At Risk
  if (injuryRisk === "elevated" && rate < 0.6) {
    reasons.push("reported pain plus low completion");
  }
  if (weeksUntilRace !== null && weeksUntilRace <= 4 && rate < 0.5) {
    reasons.push("low completion this close to the race");
  }
  if (recovery.status === "poor" && rate < 0.5) {
    reasons.push("poor recovery combined with low completion");
  }

  if (reasons.length) {
    return {
      status: "at_risk",
      label: "At Risk",
      confidence: Number(confidence.toFixed(2)),
      confidenceLabel,
      explanation: `Preparation is at risk: ${reasons[0]}.`
    };
  }

  // Caution
  if (injuryRisk === "elevated") {
    reasons.push("pain or injury was reported this week");
  }
  if (rate < 0.7) {
    reasons.push("session completion was below 70%");
  }
  if (recovery.status === "poor") {
    reasons.push("the check-in shows poor recovery");
  }
  if (longRun.planned && !longRun.completed) {
    reasons.push("the planned long run was missed");
  }
  if (consistencyStatus === "sparse") {
    reasons.push("training days were sparse");
  }

  if (reasons.length) {
    return {
      status: "caution",
      label: "Caution",
      confidence: Number(confidence.toFixed(2)),
      confidenceLabel,
      explanation: `Watch this: ${reasons[0]}.`
    };
  }

  // Ahead — deliberately conservative: requires hard evidence
  const paceSignalPositive =
    comparable?.sufficient &&
    comparable.paceChangeSecPerKm !== null &&
    comparable.paceChangeSecPerKm <= -2 &&
    comparable.heartRateChangeBpm !== null &&
    comparable.heartRateChangeBpm <= 3;

  if (
    rate >= 0.9 &&
    longRun.planned &&
    longRun.completed &&
    recovery.status === "good" &&
    injuryRisk !== "elevated" &&
    paceSignalPositive
  ) {
    return {
      status: "ahead",
      label: "Ahead",
      confidence: Number(confidence.toFixed(2)),
      confidenceLabel,
      explanation:
        "Completion, long-run execution, recovery, and comparable pace-at-heart-rate all point the right way."
    };
  }

  return {
    status: "on_track",
    label: "On Track",
    confidence: Number(confidence.toFixed(2)),
    confidenceLabel,
    explanation:
      "Completion, consistency, and recovery are holding without warning signs."
  };
}

/* ─── narrative and structured sections ───────────────────────── */

export function buildNarrative({
  matching,
  planned,
  completed,
  comparable,
  recovery,
  injuryRisk,
  checkIn
}) {
  const sentences = [];

  if (matching.plannedCount > 0) {
    sentences.push(
      `You completed ${matching.completedCount} of ${matching.plannedCount} planned sessions.`
    );
  } else {
    sentences.push(
      "No planned sessions were found for this week."
    );
  }

  if (matching.longRun.planned) {
    if (matching.longRun.completed) {
      const plannedMin = matching.longRun.planned_minutes;
      const actualMin = matching.longRun.actual_minutes;

      sentences.push(
        plannedMin && actualMin
          ? `Your long run was completed at ${actualMin} of ${plannedMin} planned minutes.`
          : "Your long run was completed."
      );
    } else {
      sentences.push("The planned long run was missed.");
    }
  }

  if (
    planned.distanceKm !== null &&
    completed.distanceKm !== null &&
    planned.distanceKm > 0
  ) {
    sentences.push(
      `Volume was ${completed.distanceKm} km against roughly ${planned.distanceKm} km planned.`
    );
  }

  if (comparable.sufficient) {
    const pace = comparable.paceChangeSecPerKm;
    const absPace = Math.abs(Math.round(pace));

    if (pace <= -2) {
      sentences.push(
        `${comparable.weekRunCount} comparable runs were approximately ${absPace} sec/km faster at a similar average heart rate — a positive signal, though more weeks of comparable data are needed.`
      );
    } else if (pace >= 2) {
      sentences.push(
        `${comparable.weekRunCount} comparable runs were approximately ${absPace} sec/km slower at a similar average heart rate — worth watching, not yet a trend.`
      );
    } else {
      sentences.push(
        `${comparable.weekRunCount} comparable runs showed stable pace at a similar average heart rate.`
      );
    }
  } else {
    sentences.push(
      "There is not enough comparable running data this week to judge pace or heart-rate change."
    );
  }

  if (checkIn) {
    if (recovery.status === "poor") {
      sentences.push(
        "Your check-in points to poor recovery — next week protects it."
      );
    } else if (recovery.status === "good") {
      sentences.push(
        "Your check-in shows recovery is holding up."
      );
    }

    if (injuryRisk === "elevated") {
      sentences.push(
        "You reported pain or injury, so intensity around the affected area will be handled carefully."
      );
    }
  } else {
    sentences.push(
      "No weekly check-in was submitted, so recovery and soreness are unknown."
    );
  }

  return sentences.join(" ");
}

export function buildKeyWins({ matching, comparable, recovery }) {
  const wins = [];

  if (
    matching.plannedCount > 0 &&
    (matching.completionRate ?? 0) >= 0.85
  ) {
    wins.push(
      `Completed ${matching.completedCount} of ${matching.plannedCount} planned sessions.`
    );
  }

  if (matching.longRun.planned && matching.longRun.completed) {
    wins.push("Long run executed as planned.");
  }

  if (
    comparable.sufficient &&
    comparable.paceChangeSecPerKm !== null &&
    comparable.paceChangeSecPerKm <= -2
  ) {
    wins.push(
      `Comparable runs ~${Math.abs(
        Math.round(comparable.paceChangeSecPerKm)
      )} sec/km faster at similar heart rate.`
    );
  }

  if (recovery.status === "good") {
    wins.push("Recovery markers from your check-in look stable.");
  }

  return wins;
}

export function buildKeyConcerns({
  matching,
  comparable,
  recovery,
  injuryRisk,
  checkIn
}) {
  const concerns = [];

  if (injuryRisk === "elevated") {
    const detail = checkIn?.pain_details
      ? ` (${String(checkIn.pain_details).slice(0, 120)})`
      : "";
    concerns.push(`Pain or injury reported${detail}.`);
  }

  if (
    matching.plannedCount > 0 &&
    (matching.completionRate ?? 0) < 0.6
  ) {
    concerns.push(
      `Only ${matching.completedCount} of ${matching.plannedCount} planned sessions were completed.`
    );
  }

  if (recovery.status === "poor") {
    concerns.push(
      "Check-in reports high fatigue or poor sleep."
    );
  }

  if (
    comparable.sufficient &&
    comparable.paceChangeSecPerKm !== null &&
    comparable.paceChangeSecPerKm >= 4 &&
    comparable.heartRateChangeBpm !== null &&
    comparable.heartRateChangeBpm >= 0
  ) {
    concerns.push(
      "Comparable runs were noticeably slower at similar heart rate."
    );
  }

  if (matching.longRun.planned && !matching.longRun.completed) {
    concerns.push("The planned long run was missed.");
  }

  return concerns;
}

export function buildNextWeekPriorities({
  matching,
  recovery,
  injuryRisk,
  consistencyStatus
}) {
  const priorities = [];

  if (injuryRisk === "elevated") {
    priorities.push(
      "Avoid aggravating intensity and reassess the reported pain before quality work."
    );
  }

  if (recovery.status === "poor") {
    priorities.push("Reduce load enough to restore recovery.");
  }

  if (
    matching.plannedCount > 0 &&
    (matching.completionRate ?? 0) < 0.7
  ) {
    priorities.push(
      "Reorganize the week so sessions fit the real schedule — do not chase missed work."
    );
  }

  if (matching.longRun.planned && !matching.longRun.completed) {
    priorities.push(
      "Protect the long run — it is the anchor of the week."
    );
  }

  if (!priorities.length) {
    if (consistencyStatus === "consistent") {
      priorities.push(
        "Progress load conservatively while recovery supports it."
      );
    } else {
      priorities.push(
        "Build reliable training frequency before adding load."
      );
    }
  }

  return priorities;
}
