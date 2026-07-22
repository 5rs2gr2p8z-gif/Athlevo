
/*
 * PRODUCTION BUILD MARKER — executes the instant this file is parsed.
 *
 * Runtime-cached JS is served stale-while-revalidate, so the first load after
 * a deploy can still run the PREVIOUS copy of this file. Checking a behaviour
 * (a stage log, a network call) cannot distinguish "code is stale" from "code
 * ran and took a different branch". This marker can: if it is undefined in
 * the console, the browser is executing an older brain.js.
 */
try { (typeof window !== "undefined" ? window : globalThis).__ATHLEVO_BRAIN_TRACE_VERSION = "connect-trace-v1"; } catch (e) {}
console.log("Athlevo Brain Loaded");

/*
 * Formats a running pace as "m:ss/km". Rounds the total seconds-per-km
 * BEFORE splitting into minutes and seconds so the seconds field can
 * never be 60 (the "5:60/km" bug). Returns null for missing or
 * impossible inputs so callers can show a clean placeholder.
 *
 * 359.7 s/km -> "6:00/km"    59 s -> "0:59"    60 s -> "1:00"    61 -> "1:01"
 */
function formatPacePerKm(distanceMeters, movingSeconds) {
  const meters = Number(distanceMeters);
  const seconds = Number(movingSeconds);

  if (
    !Number.isFinite(meters) ||
    meters <= 0 ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return null;
  }

  const totalSecondsPerKm = Math.round(seconds / (meters / 1000));

  if (!Number.isFinite(totalSecondsPerKm) || totalSecondsPerKm <= 0) {
    return null;
  }

  const minutes = Math.floor(totalSecondsPerKm / 60);
  const secs = totalSecondsPerKm % 60;

  return `${minutes}:${String(secs).padStart(2, "0")}/km`;
}

/*
 * Formats a duration as "Xh Ym" or "Y min". Rounds to whole minutes
 * FIRST, then splits, so the minutes field can never read 60
 * (e.g. 3599 s must not render "60 min"). Returns "—" for invalid input.
 */
function formatDurationHM(seconds) {
  const value = Number(seconds);

  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }

  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;
}

/* Formats distance in km with one decimal, or "—" for invalid input. */
function formatDistanceKm(meters) {
  const value = Number(meters);

  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }

  return `${(value / 1000).toFixed(1)} km`;
}

/*
 * Returns activities sorted newest-first by real start time, tolerating
 * missing start_date by falling back to start_date_local then
 * created_at. This guarantees "latest" is always the newest imported
 * activity regardless of the order rows arrive in.
 */
function sortActivitiesByStartDesc(activities) {
  const activityTime = activity => {
    const raw =
      activity?.start_date ||
      activity?.start_date_local ||
      activity?.created_at ||
      null;

    const time = raw ? new Date(raw).getTime() : NaN;

    return Number.isFinite(time) ? time : -Infinity;
  };

  return [...(Array.isArray(activities) ? activities : [])].sort(
    (a, b) => activityTime(b) - activityTime(a)
  );
}

async function loadAthleteProfile() {
  const {
    data: { user },
    error: userError
  } = await supabaseClient.auth.getUser();

  if (userError) {
    console.error("Could not get authenticated user:", userError);
    return null;
  }

  if (!user) {
    console.log("No logged-in athlete.");
    return null;
  }

  const { data: profile, error: profileError } = await supabaseClient
  .from("profiles")
  .select("*")
  .eq("id", user.id)
  .maybeSingle();

  if (profileError) {
    console.error("Could not load athlete profile:", profileError);
    return null;
  }

  console.log("Athlete profile loaded:", profile);
  return profile;
}

function buildCoachingContext(
  profile,
  activities = [],
  activitySummary = null
) {
  if (!profile) return null;

  const safeActivities = sortActivitiesByStartDesc(activities);

  const recentActivities = safeActivities
    .slice(0, 5)
    .map(activity => {
      const distanceMeters =
        Number(activity.distance_meters) || 0;

      const movingTimeSeconds =
        Number(activity.moving_time_seconds) || 0;

      const distanceKilometers =
        distanceMeters > 0
          ? Number((distanceMeters / 1000).toFixed(2))
          : null;

      const durationMinutes =
        movingTimeSeconds > 0
          ? Math.round(movingTimeSeconds / 60)
          : null;

      const averagePacePerKilometer = formatPacePerKm(
        distanceMeters,
        movingTimeSeconds
      );

      return {
        // Exposed so the coach can target this activity in a correction
        // proposal. Server re-verifies ownership before applying.
        id: activity.id || null,

        name:
          activity.name ||
          activity.sport_type ||
          activity.activity_type ||
          "Activity",

        sportType:
          activity.sport_type ||
          activity.activity_type ||
          "Unknown",

        startDate: activity.start_date || null,
        distanceKilometers,
        durationMinutes,
        averagePacePerKilometer,

        averageHeartRate:
          Number(activity.average_heartrate) > 0
            ? Math.round(
                Number(activity.average_heartrate)
              )
            : null,

        maximumHeartRate:
          Number(activity.max_heartrate) > 0
            ? Math.round(Number(activity.max_heartrate))
            : null,

        elevationGainMeters:
          Number(activity.elevation_gain_meters) > 0
            ? Math.round(
                Number(activity.elevation_gain_meters)
              )
            : null,

        trainer: Boolean(activity.trainer)
      };
    });

  const weeklyVolumes = Array.isArray(
    activitySummary?.weeklyVolumes
  )
    ? activitySummary.weeklyVolumes.map(
        (week, index) => ({
          weekNumber: index + 1,
          startDate: week.startDate,
          endDate: week.endDate,
          activityCount:
            Number(week.activityCount) || 0,
          distanceKilometers: Number(
            (
              Number(week.distanceKilometers) || 0
            ).toFixed(1)
          )
        })
      )
    : [];

  const latestActivity =
    activitySummary?.latestActivity || null;

  return {
    athlete: {
      id: profile.id,
      name: profile.full_name || "Athlete",
      email: profile.email || null,

      age:
        Number(profile.age) > 0
          ? Number(profile.age)
          : null,

      sex: profile.sex || null,

      heightCentimeters:
        Number(profile.height_cm) > 0
          ? Number(profile.height_cm)
          : null,

      weightKilograms:
        Number(profile.weight_kg) > 0
          ? Number(profile.weight_kg)
          : null
    },

    trainingProfile: {
      goal: profile.goal || "Not provided",
      raceType: profile.race_type || "Not provided",
      targetRace: profile.target_race || null,
      targetRaceDate: profile.target_race_date || null,

      injuryHistory:
        profile.injury_history || "None reported",

      trainingDays:
        profile.training_days ?? null,

      device: profile.device || "None",

      experienceLevel:
        profile.experience_level || null,

      preferredTrainingTime:
        profile.preferred_training_time || null,

      workSchedule:
        profile.work_schedule || null,

      nutritionContext:
        profile.nutrition_context || null,

      coachNotes:
        profile.coach_notes || null,

      additionalContext:
        profile.additional_context || null
    },

    importedTrainingData: {
      source:
        safeActivities.length > 0
          ? "Strava"
          : "No connected training data",

      totalImportedActivities:
        safeActivities.length,

      lastSevenDays: {
        activityCount:
          Number(
            activitySummary?.sevenDayActivityCount
          ) || 0,

        distanceKilometers: Number(
          (
            Number(
              activitySummary
                ?.sevenDayDistanceKilometers
            ) || 0
          ).toFixed(1)
        ),

        trainingHours: Number(
          (
            Number(
              activitySummary?.sevenDayTrainingHours
            ) || 0
          ).toFixed(1)
        ),

        averageHeartRate:
          Number(
            activitySummary?.sevenDayAverageHeartRate
          ) > 0
            ? Math.round(
                Number(
                  activitySummary
                    .sevenDayAverageHeartRate
                )
              )
            : null
      },

      latestActivity: latestActivity
        ? {
            name:
              latestActivity.name ||
              latestActivity.sport_type ||
              latestActivity.activity_type ||
              "Activity",

            sportType:
              latestActivity.sport_type ||
              latestActivity.activity_type ||
              "Unknown",

            startDate:
              latestActivity.start_date || null,

            distanceKilometers:
              Number(latestActivity.distance_meters) > 0
                ? Number(
                    (
                      Number(
                        latestActivity.distance_meters
                      ) / 1000
                    ).toFixed(2)
                  )
                : null,

            durationMinutes:
              Number(
                latestActivity.moving_time_seconds
              ) > 0
                ? Math.round(
                    Number(
                      latestActivity.moving_time_seconds
                    ) / 60
                  )
                : null,

            averageHeartRate:
              Number(
                latestActivity.average_heartrate
              ) > 0
                ? Math.round(
                    Number(
                      latestActivity.average_heartrate
                    )
                  )
                : null
          }
        : null,

      recentActivities,
      sixWeekVolumeHistory: weeklyVolumes
    },

    missingData: {
      sleep:
        true,

      hrv:
        true,

      readiness:
        true,

      recovery:
        true,

      bodyBattery:
        true,

      wearableRecoveryData:
        true,

      heartRate:
        !recentActivities.some(
          activity =>
            Number(activity.averageHeartRate) > 0
        )
    },

    coachingRules: {
      respectInjuries: true,
      prioritizeConsistency: true,
      explainEveryDecision: true,
      avoidGenericAdvice: true,

      neverInventData: true,

      acknowledgeMissingData: true,

      distinguishRecordedFactsFromInference: true,

      doNotClaimSleepHrvRecoveryOrReadinessData:
        true,

      useImportedTrainingDataWhenRelevant: true
    }
  };
}

function updateTodayDashboard(profile) {
  if (!profile) {
    return;
  }

  const nameElement = document.getElementById("todayAthleteName");
  const contextElement = document.getElementById("todayContextLine");

  if (nameElement) {
    const preferredName =
      profile.full_name?.trim() ||
      profile.email?.split("@")[0] ||
      "Athlete";

    nameElement.textContent = preferredName;
  }

  if (contextElement) {
    const sport = profile.primary_sport?.trim();
    const goal = profile.goal?.trim();

    if (sport && goal) {
      contextElement.textContent = `${sport} · ${goal}`;
    } else if (goal) {
      contextElement.textContent = goal;
    } else if (sport) {
      contextElement.textContent = `${sport} athlete profile`;
    } else {
      contextElement.textContent = "Your athlete profile is ready.";
    }
  }
}

function updateAthleteProfileScreens(profile) {
  if (!profile) {
    return;
  }

  const preferredName =
    profile.full_name?.trim() ||
    profile.email?.split("@")[0] ||
    "Athlete";

  const initial = preferredName.charAt(0).toUpperCase();

  const profileName = document.getElementById("profileName");
  const profileInitial = document.getElementById("profileInitial");
  const profileSummary = document.getElementById("profileSummary");

  if (profileName) {
    profileName.textContent = preferredName;
  }

  if (profileInitial) {
    profileInitial.textContent = initial;
  }

  if (profileSummary) {
    const summaryParts = [];

    if (profile.primary_sport) {
      summaryParts.push(profile.primary_sport);
    }

    if (profile.location) {
      summaryParts.push(profile.location);
    }

    if (profile.goal) {
      summaryParts.push(profile.goal);
    }

    profileSummary.textContent =
      summaryParts.length > 0
        ? summaryParts.join(" · ")
        : "Athlete profile";
  }

  const memoryList = document.getElementById("profileMemoryList");

  if (memoryList) {
    memoryList.innerHTML = "";

    const memories = [];

    if (profile.goal) {
      memories.push(`Main goal: ${profile.goal}`);
    }

    if (profile.target_race) {
      const raceDescription = profile.race_date
        ? `${profile.target_race} on ${profile.race_date}`
        : profile.target_race;

      memories.push(`Target event: ${raceDescription}`);
    }

    if (profile.primary_sport) {
      memories.push(`Primary sport: ${profile.primary_sport}`);
    }

    if (profile.available_days || profile.training_days) {
      memories.push(
        `Available training days: ${
          profile.available_days || profile.training_days
        } per week`
      );
    }

    if (profile.weekly_distance !== null && profile.weekly_distance !== undefined) {
      memories.push(
        `Current weekly distance: approximately ${profile.weekly_distance} km`
      );
    }

    if (profile.weekly_hours !== null && profile.weekly_hours !== undefined) {
      memories.push(
        `Current weekly training time: approximately ${profile.weekly_hours} hours`
      );
    }

    if (profile.injury_history) {
      memories.push(`Injury context: ${profile.injury_history}`);
    }

    if (profile.work_schedule) {
      memories.push(`Work or school schedule: ${profile.work_schedule}`);
    }

    if (profile.preferred_training_time) {
      memories.push(
        `Preferred training time: ${profile.preferred_training_time}`
      );
    }

    if (profile.diet) {
      memories.push(`Nutrition context: ${profile.diet}`);
    }

    if (profile.coach_notes) {
      memories.push(`Additional coach context: ${profile.coach_notes}`);
    }

    if (memories.length === 0) {
      const emptyItem = document.createElement("div");
      emptyItem.className = "mem-item";

      const dot = document.createElement("i");
      const text = document.createElement("span");
      text.textContent = "No athlete memory recorded yet.";

      emptyItem.appendChild(dot);
      emptyItem.appendChild(text);
      memoryList.appendChild(emptyItem);
    } else {
      memories.forEach(memory => {
        const item = document.createElement("div");
        item.className = "mem-item";

        const dot = document.createElement("i");
        const text = document.createElement("span");
        text.textContent = memory;

        item.appendChild(dot);
        item.appendChild(text);
        memoryList.appendChild(item);
      });
    }
  }

  const raceName = document.getElementById("todayRaceName");
  const raceContext = document.getElementById("todayRaceContext");
  const raceDays = document.getElementById("todayRaceDays");

  if (profile.target_race) {
    if (raceName) {
      raceName.textContent = profile.target_race;
    }

    if (profile.race_date) {
      const raceDate = new Date(`${profile.race_date}T00:00:00`);
      const today = new Date();

      today.setHours(0, 0, 0, 0);

      const millisecondsRemaining = raceDate.getTime() - today.getTime();
      const daysRemaining = Math.ceil(
        millisecondsRemaining / (1000 * 60 * 60 * 24)
      );

      if (raceDays) {
        raceDays.textContent =
          Number.isFinite(daysRemaining) && daysRemaining >= 0
            ? String(daysRemaining)
            : "—";
      }

      if (raceContext) {
        raceContext.textContent = profile.target_time
          ? `Target: ${profile.target_time} · ${profile.race_date}`
          : profile.race_date;
      }
    } else if (raceContext) {
      raceContext.textContent = profile.target_time
        ? `Target: ${profile.target_time}`
        : "No race date recorded.";
    }
  }

  const coachNote = document.getElementById("todayCoachNote");

  if (coachNote) {
    coachNote.textContent =
      profile.coach_notes?.trim() ||
      "No personal coach note has been recorded yet.";
  }

  const stravaStatus = document.getElementById("stravaConnectionStatus");
  const stravaMark = document.getElementById("stravaConnectionMark");

  if (stravaStatus) {
    stravaStatus.textContent = profile.strava_connected
      ? "Connected"
      : "Not connected";
  }

  if (stravaMark) {
    stravaMark.textContent = profile.strava_connected ? "✓" : "—";
  }

  const garminStatus = document.getElementById("garminConnectionStatus");
  const garminMark = document.getElementById("garminConnectionMark");

  if (garminStatus) {
    garminStatus.textContent = profile.garmin_connected
      ? "Connected"
      : "Not connected";
  }

  // Intervals.icu state lives server-side (tokens never reach the browser),
  // so it is fetched rather than read from the profile row.
  refreshIntervalsStatus(profile);

  if (garminMark) {
    garminMark.textContent = profile.garmin_connected ? "✓" : "—";
  }
    const weeklyDistance =
    profile.weekly_distance !== null &&
    profile.weekly_distance !== undefined
      ? `${profile.weekly_distance} km`
      : "Not provided";

  const weeklyHours =
    profile.weekly_hours !== null &&
    profile.weekly_hours !== undefined
      ? `${profile.weekly_hours} hrs`
      : "Not provided";

  const availableDays =
    profile.available_days ??
    profile.training_days ??
    null;

  const availableDaysText =
    availableDays !== null
      ? `${availableDays} days`
      : "Not provided";

  const preferredTime =
    profile.preferred_training_time?.trim() ||
    "Not provided";

  const trainWeeklyDistance =
    document.getElementById("trainWeeklyDistance");

  const trainWeeklyHours =
    document.getElementById("trainWeeklyHours");

  const trainAvailableDays =
    document.getElementById("trainAvailableDays");

  const trainPreferredTime =
    document.getElementById("trainPreferredTime");

  const trendWeeklyDistance =
    document.getElementById("trendWeeklyDistance");

  const trendWeeklyHours =
    document.getElementById("trendWeeklyHours");

  if (trainWeeklyDistance) {
    trainWeeklyDistance.textContent = weeklyDistance;
  }

  if (trainWeeklyHours) {
    trainWeeklyHours.textContent = weeklyHours;
  }

  if (trainAvailableDays) {
    trainAvailableDays.textContent = availableDaysText;
  }

  if (trainPreferredTime) {
    trainPreferredTime.textContent = preferredTime;
  }

  if (trendWeeklyDistance) {
    trendWeeklyDistance.textContent = weeklyDistance;
  }

  if (trendWeeklyHours) {
    trendWeeklyHours.textContent = weeklyHours;
  }
}

function resetAthleteUI() {
  const setText = (id, value) => {
    const element = document.getElementById(id);

    if (element) {
      element.textContent = value;
    }
  };

  setText("todayAthleteName", "Athlete");
  setText("todayContextLine", "Your athlete profile is loading.");

  setText("profileName", "Athlete");
  setText("profileInitial", "A");
  setText("profileSummary", "Athlete profile");

  setText("todayRaceName", "No target race set");
  setText("todayRaceContext", "Add a race and date in your athlete profile.");
  setText("todayRaceDays", "—");
  setText("todayCoachNote", "No personal coach note has been recorded yet.");

  setText("trainWeeklyDistance", "—");
  setText("trainWeeklyHours", "—");
  setText("trainAvailableDays", "—");
  setText("trainPreferredTime", "—");

  setText("trendWeeklyDistance", "—");
  setText("trendWeeklyHours", "—");

  setText("stravaConnectionStatus", "Not connected");
  setText("stravaConnectionMark", "—");
  setText("garminConnectionStatus", "Not connected");
  setText("garminConnectionMark", "—");

  const memoryList = document.getElementById("profileMemoryList");

  if (memoryList) {
    memoryList.innerHTML = `
      <div class="mem-item">
        <i></i>
        <span>No athlete memory recorded yet.</span>
      </div>
    `;
  }
}

function updateTodayActivityData(summary) {
  const setText = (id, value) => {
    const element = document.getElementById(id);

    if (element) {
      element.textContent = value;
    }
  };

  const formatDistance = formatDistanceKm;
  const formatDuration = formatDurationHM;

  const formatDate = value => {
    if (!value) {
      return "—";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "—";
    }

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  };

  // Readiness is separate from training history. When activities exist,
  // the missing input is readiness/recovery data — never tell a
  // connected athlete to "connect a training source". Nothing here
  // fabricates a readiness, HRV, sleep, or recovery value.
  const hasAnyActivity = Boolean(summary?.latestActivity);

  setText(
    "readinessTitle",
    hasAnyActivity
      ? "Readiness not available yet."
      : "Not enough data yet."
  );

  setText(
    "readinessCopy",
    hasAnyActivity
      ? "Complete today's readiness check or connect a supported recovery source when available. Athlevo will not estimate readiness, HRV, sleep, or recovery it has not been given."
      : "Connect your training data or record a workout to begin your training history, then complete a readiness check."
  );

  if (!summary?.latestActivity) {
    setText("todayLatestActivityName", "No imported activity yet.");
    setText(
      "todayLatestActivitySummary",
      "Connect your training data or record a workout to begin building your training history."
    );
    setText("todayLatestDistance", "—");
    setText("todayLatestDuration", "—");
    setText("todayLatestHeartRate", "—");
    setText("todayLatestDate", "—");
    setText("todaySevenDayDistance", "—");
    setText("todaySevenDayHours", "—");
    setText("todaySevenDayActivities", "0");
    setText("todaySevenDayHeartRate", "—");
    return;
  }

  const activity = summary.latestActivity;

  const activityType =
    activity.sport_type ||
    activity.activity_type ||
    "Activity";

  const distanceText = formatDistance(activity.distance_meters);
  const durationText = formatDuration(activity.moving_time_seconds);

  setText(
    "todayLatestActivityName",
    activity.name || activityType
  );

  setText(
    "todayLatestActivitySummary",
    `${activityType} · ${distanceText} · ${durationText}`
  );

  setText(
    "todayLatestDistance",
    distanceText
  );

  setText(
    "todayLatestDuration",
    durationText
  );

  setText(
    "todayLatestHeartRate",
    Number(activity.average_heartrate) > 0
      ? `${Math.round(Number(activity.average_heartrate))} bpm`
      : "Not recorded"
  );

  setText(
    "todayLatestDate",
    formatDate(activity.start_date)
  );

  setText(
    "todaySevenDayDistance",
    `${summary.sevenDayDistanceKilometers.toFixed(1)} km`
  );

  setText(
    "todaySevenDayHours",
    `${summary.sevenDayTrainingHours.toFixed(1)} hrs`
  );

  setText(
    "todaySevenDayActivities",
    String(summary.sevenDayActivityCount)
  );

  if (summary.sevenDayAverageHeartRate) {
    setText(
      "todaySevenDayHeartRate",
      `${Math.round(summary.sevenDayAverageHeartRate)} bpm`
    );

    setText(
      "todayHeartRateContext",
      "Average across activities with heart-rate data"
    );
  } else {
    setText("todaySevenDayHeartRate", "—");

    setText(
      "todayHeartRateContext",
      "No heart-rate data available from Strava"
    );
  }
}

function updateTrainActivityData(activities = [], summary = null) {
  const setText = (id, value) => {
    const element = document.getElementById(id);

    if (element) {
      element.textContent = value;
    }
  };

  const formatDistance = formatDistanceKm;
  const formatDuration = formatDurationHM;

  const formatPace = activity =>
    formatPacePerKm(
      activity.distance_meters,
      activity.moving_time_seconds
    ) || "—";

  const formatDate = value => {
    if (!value) {
      return "Unknown date";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "Unknown date";
    }

    return date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    });
  };

  const safeActivities = sortActivitiesByStartDesc(activities);

  setText(
    "trainWeeklyDistance",
    summary
      ? `${summary.sevenDayDistanceKilometers.toFixed(1)} km`
      : "—"
  );

  setText(
    "trainWeeklyHours",
    summary
      ? `${summary.sevenDayTrainingHours.toFixed(1)} hrs`
      : "—"
  );

  setText(
    "trainSummaryTitle",
    summary?.sevenDayActivityCount
      ? `${summary.sevenDayActivityCount} activities in the last 7 days`
      : "No recent training recorded."
  );

  setText(
    "trainSummaryContext",
    summary?.sevenDayActivityCount
      ? `${summary.sevenDayDistanceKilometers.toFixed(
          1
        )} km and ${summary.sevenDayTrainingHours.toFixed(
          1
        )} hours imported from Strava.`
      : "Connect your training data or record a workout to begin building your history."
  );

  const container = document.getElementById(
    "trainRecentActivities"
  );

  if (!container) {
    return;
  }

  container.innerHTML = "";

  const recentActivities = safeActivities.slice(0, 5);

  if (!recentActivities.length) {
    container.innerHTML = `
      <div class="decision">
        <h3>No imported activities yet.</h3>
        <p>Connect your training data to begin building your training history.</p>
      </div>
    `;

    return;
  }

  recentActivities.forEach(activity => {
    const card = document.createElement("div");
    card.className = "decision";

    const activityType =
      activity.sport_type ||
      activity.activity_type ||
      "Activity";

    const heartRate =
      Number(activity.average_heartrate) > 0
        ? `${Math.round(
            Number(activity.average_heartrate)
          )} bpm`
        : "No HR data";

    card.innerHTML = `
      <span class="eyebrow">
        ${formatDate(activity.start_date)} · ${activityType}
      </span>

      <h3>${activity.name || activityType}</h3>

      <p>
        ${formatDistance(activity.distance_meters)}
        · ${formatDuration(activity.moving_time_seconds)}
        · ${formatPace(activity)}
      </p>

      <div class="ledger">
        <div class="ledger-inner">
          <div class="factor">
            <span class="f-name">Average heart rate</span>
            <span class="f-val num">${heartRate}</span>
          </div>

          <div class="factor">
            <span class="f-name">Elevation gain</span>
            <span class="f-val num">
              ${
                Number(activity.elevation_gain_meters) > 0
                  ? `${Math.round(
                      Number(activity.elevation_gain_meters)
                    )} m`
                  : "—"
              }
            </span>
          </div>
        </div>
      </div>
    `;

    container.appendChild(card);
  });
}

function updateTrendsActivityData(
  activities = [],
  summary = null,
  totalActivityCount = null
) {
  const setText = (id, value) => {
    const element = document.getElementById(id);

    if (element) {
      element.textContent = value;
    }
  };

  const safeActivities = Array.isArray(activities)
    ? activities
    : [];

  const weeklyVolumes = Array.isArray(summary?.weeklyVolumes)
    ? summary.weeklyVolumes
    : [];

  // True total from a count query when available; the loaded array is
  // capped at the query limit, so never present that cap as the total.
  const importedCount =
    Number.isFinite(Number(totalActivityCount)) &&
    Number(totalActivityCount) >= 0
      ? Number(totalActivityCount)
      : safeActivities.length;

  const hasHistory =
    importedCount > 0 ||
    safeActivities.length > 0 ||
    Boolean(summary?.latestActivity);

  // Performance-trends card: distinguish "no history at all" from
  // "history exists but comparable-performance analysis is limited".
  // Never claim improvement without validated comparable data.
  setText(
    "trendPerformanceTitle",
    hasHistory
      ? "Training history imported."
      : "No imported training history yet."
  );

  setText(
    "trendPerformanceContext",
    hasHistory
      ? "More comparable pace, heart-rate, terrain, and workout-structure data is needed before Athlevo can calculate reliable performance trends."
      : "Athlevo will not calculate fitness, fatigue, race predictions, or training trends until it has enough real workout data."
  );

  const currentWeek =
    weeklyVolumes[weeklyVolumes.length - 1] || null;

  const previousWeek =
    weeklyVolumes[weeklyVolumes.length - 2] || null;

  const currentDistance =
    Number(currentWeek?.distanceKilometers) || 0;

  const previousDistance =
    Number(previousWeek?.distanceKilometers) || 0;

  setText(
    "trendCurrentDistance",
    `${currentDistance.toFixed(1)} km`
  );

  setText(
    "trendPreviousDistance",
    `${previousDistance.toFixed(1)} km`
  );

  setText(
    "trendImportedActivities",
    String(importedCount)
  );

  if (previousDistance > 0) {
    const changePercent =
      ((currentDistance - previousDistance) /
        previousDistance) *
      100;

    const roundedChange = Math.round(changePercent);
    const sign = roundedChange > 0 ? "+" : "";

    setText(
      "trendWeeklyChange",
      `${sign}${roundedChange}%`
    );

    if (changePercent > 10) {
      setText(
        "trendWeeklyChangeContext",
        "Volume increased by more than 10%"
      );
    } else if (changePercent < -10) {
      setText(
        "trendWeeklyChangeContext",
        "Volume decreased by more than 10%"
      );
    } else {
      setText(
        "trendWeeklyChangeContext",
        "Volume remained relatively stable"
      );
    }
  } else {
    setText("trendWeeklyChange", "—");
    setText(
      "trendWeeklyChangeContext",
      "Previous-week distance is unavailable"
    );
  }

  const weeksWithTraining = weeklyVolumes.filter(
    week => Number(week.distanceKilometers) > 0
  );

  const highestVolume = weeklyVolumes.reduce(
    (highest, week) =>
      Number(week.distanceKilometers) >
      Number(highest?.distanceKilometers || 0)
        ? week
        : highest,
    null
  );

  if (!weeksWithTraining.length) {
    setText(
      "trendVolumeTitle",
      "No six-week training history yet."
    );

    setText(
      "trendVolumeContext",
      "Complete and import activities to begin building your volume trend."
    );
  } else {
    setText(
      "trendVolumeTitle",
      `${weeksWithTraining.length} of 6 weeks contain training`
    );

    setText(
      "trendVolumeContext",
      highestVolume
        ? `Highest seven-day volume: ${Number(
            highestVolume.distanceKilometers
          ).toFixed(1)} km.`
        : "Weekly volume is being calculated."
    );
  }

  const chart = document.getElementById(
    "trendWeeklyVolumeChart"
  );

  if (!chart) {
    return;
  }

  chart.innerHTML = "";

  if (!weeklyVolumes.length) {
    const emptyMessage = document.createElement("p");
    emptyMessage.textContent =
      "No weekly activity history available.";
    chart.appendChild(emptyMessage);
    return;
  }

  const maximumDistance = Math.max(
    ...weeklyVolumes.map(
      week => Number(week.distanceKilometers) || 0
    ),
    1
  );

  weeklyVolumes.forEach((week, index) => {
    const distance =
      Number(week.distanceKilometers) || 0;

    const heightPercent = Math.max(
      (distance / maximumDistance) * 100,
      distance > 0 ? 8 : 2
    );

    const column = document.createElement("div");

    column.style.flex = "1";
    column.style.minWidth = "0";
    column.style.textAlign = "center";

    const value = document.createElement("small");
    value.textContent = `${distance.toFixed(1)}`;

    const barTrack = document.createElement("div");

    barTrack.style.height = "120px";
    barTrack.style.display = "flex";
    barTrack.style.alignItems = "flex-end";
    barTrack.style.margin = "6px 0";
    barTrack.style.borderRadius = "10px";
    barTrack.style.overflow = "hidden";
    barTrack.style.background = "rgba(0, 0, 0, 0.05)";

    const bar = document.createElement("div");

    bar.style.width = "100%";
    bar.style.height = `${heightPercent}%`;
    bar.style.background = "currentColor";
    bar.style.opacity =
      index === weeklyVolumes.length - 1 ? "1" : "0.25";
    bar.style.borderRadius = "8px 8px 0 0";

    const label = document.createElement("small");
    label.textContent = `W${index + 1}`;

    barTrack.appendChild(bar);
    column.appendChild(value);
    column.appendChild(barTrack);
    column.appendChild(label);
    chart.appendChild(column);
  });
}

async function refreshAthleteUI() {
  resetAthleteUI();

  try {
    const profile = await loadAthleteProfile();

    if (!profile) {
      console.log("No profile exists for the current athlete.");
      return null;
    }

    updateTodayDashboard(profile);
    updateAthleteProfileScreens(profile);

    // Today + the latest-workout card need recent training only; the
    // heavier surfaces load their own history window.
    const rawActivities = await loadAthleteActivities("recent");

    // Athlete-confirmed corrections take priority over raw Strava on
    // Today, recent activities, and Trends — the raw rows are untouched.
    const overrides = await loadActivityOverrides();
    const activities = mergeActivityOverrides(rawActivities, overrides);

    const activitySummary = buildActivitySummary(activities);

    // Exact total (not the 200-row query cap) for the Trends count.
    const totalActivityCount = await countAthleteActivities();

    updateTodayActivityData(activitySummary);
    updateTrainActivityData(activities, activitySummary);
    // Trends now use true calendar weeks (js/trends.js, called below via
    // window.refreshTrends). The old rolling-7-day updateTrendsActivityData
    // is retained in this file but no longer invoked.

    // Daily readiness owns its card CTA/summary; render it after the
    // generic copy so it reflects whether today's readiness is logged.
    if (typeof window.renderReadinessCard === "function") {
      window.renderReadinessCard();
    }

    // Proactive coaching loop: recognise + analyse the latest performed
    // workout and refresh the Today card in place. Fire-and-forget so a
    // slow analysis never blocks the rest of the dashboard.
    if (typeof window.renderLatestWorkoutAnalysis === "function") {
      window.renderLatestWorkoutAnalysis();
    }

    // Performance foundation: recompute the Athlevo Score (v1) and
    // calendar-week Trends from raw inputs (reusing the override-applied
    // activities + athlete timezone), and scan imported activities for a
    // possible race. All fire-and-forget and read-only until confirmed.
    if (typeof window.renderAthlevoScoreCard === "function") {
      window.renderAthlevoScoreCard(activities, profile);
    }
    // Training Engine V2: the "Your current training paces" card (moved out
    // of the Athlevo Score detail) — reads the same shared pace service.
    if (typeof window.renderTrainingPacesCard === "function") {
      window.renderTrainingPacesCard();
    }
    // Proactive discovery: show the plan-setup CTA on Today whenever the
    // athlete has no plan yet (covers existing users who never found Train).
    if (window.AthlevoPlan && typeof window.AthlevoPlan.refreshTodayCta === "function") {
      window.AthlevoPlan.refreshTodayCta();
    }
    // Coach Brain V1: explain WHY — structured coaching insights on Today,
    // assembled from the systems above (fire-and-forget).
    if (typeof window.renderCoachInsights === "function") {
      window.renderCoachInsights(profile);
    }
    // Athlete Identity & Progression: "Your Development" — reuses the score
    // components + history to show how the athlete is evolving.
    if (typeof window.renderDevelopment === "function") {
      window.renderDevelopment(profile);
    }
    if (typeof window.refreshTrends === "function") {
      window.refreshTrends(activities, profile);
    }
    if (typeof window.runRaceDetection === "function") {
      window.runRaceDetection();
    }

    console.log("Athlete UI updated for:", profile.id);

    return {
      profile,
      activities,
      activitySummary
    };
  } catch (error) {
    console.error("Could not update athlete UI:", error);
    resetAthleteUI();
    return null;
  }
}

async function syncStravaActivities() {
  try {
    const {
      data: { session },
      error: sessionError
    } = await supabaseClient.auth.getSession();

    if (sessionError) {
      throw sessionError;
    }

    if (!session?.access_token) {
      throw new Error("Please log in again before syncing Strava.");
    }

    const response = await fetch("/api/strava/sync", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json"
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || "Could not synchronize Strava activities."
      );
    }

    console.log("Strava synchronization complete:", result);

    return result;
  } catch (error) {
    console.error("Strava synchronization failed:", error);
    throw error;
  }
}

/*
 * Returns the athlete's exact number of imported activities using a
 * head-only count query (no rows fetched), so the Trends "Imported
 * activities" figure reflects the true total rather than the 200-row
 * load cap. Returns null if the count can't be determined.
 */
/*
 * Loads the athlete's confirmed activity corrections. Best-effort: the
 * table may not exist yet, so failure never breaks the UI.
 */
async function loadActivityOverrides() {
  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) {
      return [];
    }

    const { data, error } = await supabaseClient
      .from("activity_data_overrides")
      .select("*")
      .eq("user_id", user.id);

    if (error) {
      console.error("Could not load activity overrides:", error);
      return [];
    }

    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Activity overrides load failed:", error);
    return [];
  }
}

/*
 * Overlays confirmed corrections on raw activities for display. Raw
 * values are preserved on `imported`. A pace-only correction re-derives
 * the effective distance from the untouched duration so pace displays
 * (computed from distance/time) reflect the correction. Mirrors the
 * server helper so client and server agree.
 */
function mergeActivityOverrides(activities, overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return Array.isArray(activities) ? activities : [];
  }

  const map = new Map(
    overrides
      .filter(o => o && o.activity_id)
      .map(o => [String(o.activity_id), o])
  );

  return (Array.isArray(activities) ? activities : []).map(activity => {
    const override = activity?.id ? map.get(String(activity.id)) : null;

    if (!override) {
      return activity;
    }

    const merged = {
      ...activity,
      has_correction: true,
      imported: {
        distance_meters: Number(activity.distance_meters) || null,
        moving_time_seconds: Number(activity.moving_time_seconds) || null,
        sport_type:
          activity.sport_type || activity.activity_type || null
      }
    };

    const km = Number(override.corrected_distance_km);
    if (Number.isFinite(km) && km > 0) {
      merged.distance_meters = Math.round(km * 1000);
    }

    const minutes = Number(override.corrected_duration_minutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      merged.moving_time_seconds = Math.round(minutes * 60);
    }

    const secPerKm = Number(override.corrected_pace_seconds_per_km);
    if (
      Number.isFinite(secPerKm) &&
      secPerKm > 0 &&
      !(Number.isFinite(km) && km > 0)
    ) {
      const seconds = Number(merged.moving_time_seconds);
      if (Number.isFinite(seconds) && seconds > 0) {
        merged.distance_meters = Math.round((seconds / secPerKm) * 1000);
      }
    }

    if (override.corrected_activity_type) {
      merged.sport_type = override.corrected_activity_type;
      merged.activity_type = override.corrected_activity_type;
    }

    return merged;
  });
}

async function countAthleteActivities() {
  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) {
      return null;
    }

    const { count, error } = await supabaseClient
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (error) {
      console.error("Could not count activities:", error);
      return null;
    }

    return Number.isFinite(Number(count)) ? Number(count) : null;
  } catch (error) {
    console.error("Activity count failed:", error);
    return null;
  }
}

/*
 * ── Activity load: request de-duplication + short-lived cache ──────────
 *
 * loadAthleteActivities is called from ~13 places; a single render used to
 * fire that many identical 200-row Supabase queries. Concurrent callers for
 * the SAME authenticated user + limit now share ONE in-flight promise, and a
 * short TTL cache serves repeat calls within a render lifecycle.
 *
 * Safety: the cache key includes the authenticated user id, so one athlete's
 * activities can never be returned to another. Invalidate explicitly after a
 * successful sync / import / logout via invalidateActivityCache().
 */
const ACTIVITY_CACHE_TTL_MS = 30000;
let __activityCache = { key: null, at: 0, data: null };
let __activityInflight = null; // { key, promise }

function invalidateActivityCache() {
  __activityCache = { key: null, at: 0, data: null };
  __activityInflight = null;
}

/* ══════════════════ Intervals.icu (provider-agnostic) ══════════════════
 *
 * Intervals.icu is a peer of Strava, not a replacement: an athlete blocked by
 * Strava's athlete limit can bring Garmin/COROS training in this way instead.
 * Both write the same normalized `activities` rows, so everything downstream
 * — classifier, Today, Train, Trends, Score, Coach — is unchanged.
 */

const INTERVALS_ENDPOINT = "/api/providers?provider=intervals";

async function providerRequest(action, body) {
  // TEMPORARY: only the connect hop is traced; other actions are unaffected.
  const stage = (s, d) => {
    try {
      if (action === "connect" && window.__athlevoOAuthStage) {
        window.__athlevoOAuthStage(s, d);
      }
    } catch (e) {}
  };
  stage("providerRequest_connect_entered");
  const { data: { session } } = await supabaseClient.auth.getSession();
  stage("connect_session_checked", { hasSession: Boolean(session) });
  if (!session) throw new Error("Please sign in first.");
  stage("connect_fetch_sent");
  const res = await fetch(`${INTERVALS_ENDPOINT}&action=${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify(body || {})
  });
  stage("connect_fetch_response", { status: res.status });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Something went wrong. Please try again.");
    error.code = data.code;
    throw error;
  }
  return data;
}

/*
 * Completes an OAuth connection that the callback deliberately left pending.
 *
 * The provider redirect could not prove who is signed in, so nothing was
 * saved. This call carries the CURRENT Supabase Bearer token; the server
 * compares its user.id against the account that started the flow and refuses
 * to save if they differ. The completion token is opaque and single-use.
 */
async function finalizeIntervals(completion) {
  return providerRequest("finalize", { completion });
}

/*
 * PART 2: analyse existing activities that predate recognition. Runs at most
 * once per browser (localStorage guard) after the athlete is set up, and can
 * also be triggered by a visible "Analyze existing workouts" action.
 */
async function reanalyzeActivities(opts) {
  try {
    const r = await providerRequest("reanalyze", opts || {});
    // Fresh recognition changed the data; drop the activity cache so the UI
    // re-reads it.
    if (r && r.analyzed > 0) invalidateActivityCache();
    return r;
  } catch (e) { return { scanned: 0, analyzed: 0, skipped: 0, failed: 0, error: e.message }; }
}

const REANALYZE_ONCE_KEY = "athlevo_recognition_backfilled_v3";
async function maybeBackfillRecognitionOnce() {
  try {
    if (localStorage.getItem(REANALYZE_ONCE_KEY)) return null;
    const status = await providerStatus().catch(() => null);
    if (!status || status.connected !== true) return null;   // nothing to backfill
    const r = await reanalyzeActivities();
    /*
     * PART 4: mark "done" ONLY when the request genuinely succeeded. A failure,
     * a non-200, an unreached endpoint, or a bug that scanned zero rows must
     * NOT burn the flag — otherwise the athlete never gets a second attempt.
     */
    const reached = r && !r.error && typeof r.scanned === "number";
    if (reached) { try { localStorage.setItem(REANALYZE_ONCE_KEY, "1"); } catch (e) {} }
    return r;
  } catch (e) { return null; }
}

async function connectIntervals() {
  // TEMPORARY stage trail — see js/onboardingConnect.js authorize().
  const stage = (s, d) => {
    try { if (window.__athlevoOAuthStage) window.__athlevoOAuthStage(s, d); } catch (e) {}
  };
  stage("connectIntervals_entered");
  try {
    setIntervalsUi("connecting");
    const { authorizationUrl } = await providerRequest("connect");
    stage("connect_url_received", { hasUrl: Boolean(authorizationUrl) });
    if (!authorizationUrl) throw new Error("Couldn't start the connection.");
    window.location.href = authorizationUrl;
  } catch (error) {
    stage("connectIntervals_failed", { message: (error && error.message) || "unknown" });
    setIntervalsUi("failed", error.message);
    if (typeof toast === "function") toast(error.message);
  }
}

async function syncIntervals() {
  try {
    setIntervalsUi("syncing");
    const result = await providerRequest("sync");
    // New activities mean the cached set is stale — drop it so the canonical
    // classifier re-runs and every screen picks the new training up.
    invalidateActivityCache();
    const note = result.imported
      ? `Imported ${result.imported} activit${result.imported === 1 ? "y" : "ies"}`
      : "Already up to date";
    setIntervalsUi(result.status === "partial" ? "partial" : "synced", note);
    if (typeof toast === "function") toast(note + ".");
    return result;
  } catch (error) {
    // A failed sync never damages the connection or existing data.
    const reconnect = error.code === "RECONNECT_REQUIRED";
    setIntervalsUi(reconnect ? "reconnect" : "failed", error.message);
    if (typeof toast === "function") toast(error.message);
    throw error;
  }
}

/*
 * Read-only connection probe. Imports nothing and writes nothing — it exists
 * to explain an unexpected sync result (typically "imported: 0") with
 * evidence instead of guesswork. Prints a verdict plus the raw probes.
 *
 * Console:  await AthlevoBrain.diagnoseIntervals()
 */
/*
 * Same probe, no console output. Onboarding calls this internally to decide
 * whether a wearable has pushed workouts through yet — the athlete should
 * never need to run a diagnostic themselves, so it must not print.
 */
async function diagnoseIntervalsQuiet() {
  return providerRequest("diagnose");
}

// Connection status without touching the connections UI. Used by onboarding,
// which renders its own progress rather than the You-screen row.
async function providerStatus() {
  return providerRequest("status");
}

async function diagnoseIntervals() {
  const report = await providerRequest("diagnose");
  console.log("%c" + report.verdict, "font-weight:bold");
  console.table(Object.entries(report.probes).map(([name, p]) => ({
    probe: name,
    http: p.httpStatus ?? "—",
    isArray: p.isArray ?? "—",
    count: p.count ?? "—",
    error: p.error || ""
  })));
  console.log("Full report:", report);
  return report;
}

async function refreshIntervalsStatus(profile) {
  try {
    const s = await providerRequest("status");
    /*
     * Stamp the result onto the profile so activation gates (plan setup, the
     * Today CTA) can read it synchronously alongside strava_connected. The
     * flag is derived server-side; no token ever reaches the browser.
     */
    if (profile) profile.intervals_connected = Boolean(s && s.connected);
    // Decorate the card with the real imported count, best-effort.
    setTrainingDataCount();
    if (!s.available) { setIntervalsUi("unavailable"); return s; }
    if (!s.connected) { setIntervalsUi("idle"); return s; }
    setIntervalsUi(
      s.status === "reconnect_required" ? "reconnect" : "connected",
      s.lastSync ? `Last synced ${new Date(s.lastSync).toLocaleDateString()}` : null
    );
    return s;
  } catch {
    setIntervalsUi("idle");
    return null;
  }
}

// One place that owns every connection state the athlete can see.
function setIntervalsUi(state, detail) {
  /*
   * Drives the single Training Data card. The athlete is connecting their
   * training data, not a named third party, so the copy leads with that and
   * the provider is disclosed quietly underneath.
   */
  const row = document.getElementById("trainingDataRow");
  const status = document.getElementById("trainingDataStatus");
  const copy = document.getElementById("trainingDataCopy");
  const mark = document.getElementById("trainingDataMark");
  const providerNote = document.getElementById("trainingDataProvider");
  const connectBtn = document.getElementById("trainingDataConnect");
  const disconnectBtn = document.getElementById("trainingDataDisconnect");
  if (!status || !mark) return;

  const DISCONNECTED_STATUS = "Garmin, COROS & more";
  const DISCONNECTED_COPY =
    "Connect your training platform to automatically sync your activities with Athlevo.";
  const CONNECTED_COPY = "Your training activities are automatically synced with Athlevo.";

  const STATES = {
    idle:        { text: DISCONNECTED_STATUS, mark: "—", live: false },
    unavailable: { text: "Coming soon",       mark: "—", live: false },
    connecting:  { text: "Connecting…",       mark: "…", live: false },
    connected:   { text: "Connected",         mark: "✓", live: true  },
    syncing:     { text: "Syncing…",          mark: "…", live: true  },
    synced:      { text: "Connected",         mark: "✓", live: true  },
    partial:     { text: "Connected — some activities were skipped", mark: "✓", live: true },
    failed:      { text: "Sync failed — tap to retry", mark: "!", live: true },
    reconnect:   { text: "Reconnect to keep syncing",  mark: "!", live: true }
  };
  const s = STATES[state] || STATES.idle;

  /*
   * "Reconnect required" is an instruction, not a detail, and must win over
   * any stale status text — otherwise the card keeps showing "Connected"
   * while the connection is actually broken.
   */
  status.textContent = (state === "reconnect") ? s.text : (detail || s.text);
  mark.textContent = s.mark;
  if (row) row.dataset.state = state;
  if (copy) copy.textContent = s.live ? CONNECTED_COPY : DISCONNECTED_COPY;
  // Disconnected: the Connect button carries the state, so the "—" glyph is
  // just noise. Show the ✓ / ! glyph only when it means something.
  mark.style.display = s.live ? "" : "none";
  if (providerNote) providerNote.style.display = s.live ? "none" : "";
  if (connectBtn) connectBtn.style.display = s.live ? "none" : "";
  if (disconnectBtn) disconnectBtn.style.display = s.live ? "" : "none";

  // PART 3: connected-state controls. Reconnect restarts OAuth; Open Sync
  // Partner jumps to the platform where the athlete links their watch.
  const reconnectBtn = document.getElementById("trainingDataReconnect");
  const openPartnerBtn = document.getElementById("trainingDataOpenPartner");
  const needsReconnect = state === "reconnect" || state === "failed";
  if (reconnectBtn) reconnectBtn.style.display = needsReconnect ? "" : "none";
  if (openPartnerBtn) openPartnerBtn.style.display = s.live ? "" : "none";
}

/*
 * "264 activities imported" — a real number, only when we actually have one.
 * Reads the already-loaded activity cache; never issues an extra request and
 * never blocks the card from rendering.
 */
function fmtSyncTime(d) {
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    const today = new Date();
    const sameDay = dt.toDateString() === today.toDateString();
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    const day = sameDay ? "Today" : (dt.toDateString() === yest.toDateString() ? "Yesterday"
      : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    return `${day} ${dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) { return null; }
}

/*
 * PART 3: fills the connected Training Data card — Source, count, latest
 * activity and last-sync — from data already loaded. Zero imports show
 * "Waiting for your first workout." Reads the cache only; issues no request.
 */
async function setTrainingDataCount() {
  const row = document.getElementById("trainingDataRow");
  const status = document.getElementById("trainingDataStatus");
  if (!status || !row) return;
  const live = ["connected", "synced", "partial"].includes(row.dataset.state);
  if (!live) return;

  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.textContent = v; };
  set("tdSource", "Sync Partner");

  let acts = [];
  try { acts = await loadAthleteActivities(); } catch (e) { acts = []; }
  const n = Array.isArray(acts) ? acts.length : 0;

  if (n > 0) {
    status.textContent = `Connected · ${n} activities imported`;
    set("tdCount", String(n));
    // Newest activity — the loader returns newest-first, but sort defensively.
    const newest = acts.slice().sort((a, b) =>
      new Date(b.start_date || 0) - new Date(a.start_date || 0))[0];
    if (newest) {
      const km = newest.distance_meters ? (newest.distance_meters / 1000).toFixed(1) + " km" : null;
      const type = newest.workout_type || newest.activity_type || newest.sport_type || "Activity";
      const when = fmtSyncTime(newest.start_date);
      set("tdLatest", [type, km, when].filter(Boolean).join(" · "));
    }
    set("tdLastSync", fmtSyncTime(Date.now()) || "Today");
  } else {
    status.textContent = "Connected";
    set("tdCount", "0");
    set("tdLatest", "Waiting for your first workout.");
    set("tdLastSync", "—");
  }
}

/*
 * PART 3/4: open the sync partner (where the athlete links Garmin/COROS).
 * Reuses the existing connections URL — no new flow, no OAuth change.
 */
function openSyncPartner() {
  try {
    const url = (window.AthlevoDataSource && window.AthlevoDataSource.connectionsUrl) ||
      "https://intervals.icu/settings";
    window.open(url, "_blank", "noopener");
  } catch (e) {}
}


/*
 * Disconnect. Clears the stored credentials but KEEPS every imported
 * activity — the athlete's training history is theirs, and unlinking a data
 * source must never delete their training record. Confirmed first, because
 * it is not obvious from the label that history survives.
 */
async function disconnectIntervals() {
  const ok = typeof confirm !== "function" || confirm(
    "Disconnect your training data? Your imported activities stay in " +
    "Athlevo — only the connection is removed."
  );
  if (!ok) return;
  try {
    await providerRequest("disconnect");
    setIntervalsUi("idle");
    /*
     * The Today setup card derives step 1 from provider status, so it must be
     * re-rendered here — otherwise it keeps claiming the athlete is connected
     * until the next full load.
     */
    try {
      if (window.AthlevoPlan && window.AthlevoPlan.refreshTodayCta) {
        await window.AthlevoPlan.refreshTodayCta();
      }
    } catch (e) {}
    if (typeof toast === "function") toast("Training data disconnected.");
  } catch (error) {
    if (typeof toast === "function") toast(error.message);
  }
}

/*
 * Tapping the row does the right thing for the current state: connect when
 * not connected, sync when connected, reconnect when the token is stale.
 */
async function onIntervalsRowTap() {
  const row = document.getElementById("trainingDataRow");
  const state = row ? row.dataset.state : "idle";
  if (state === "syncing" || state === "connecting") return;
  /*
   * "reconnect" deliberately falls through to connectIntervals(), which
   * restarts the SAME OAuth authorization flow used for a first connection.
   * Intervals.icu issues a fresh token, and the callback upserts it onto the
   * existing (user_id, provider) row — so reconnecting repairs the
   * connection in place rather than creating a second one.
   */
  if (state === "connected" || state === "synced" || state === "partial" || state === "failed") {
    return syncIntervals().catch(() => {});
  }
  return connectIntervals();
}

/*
 * Provider-agnostic activation. "Training data connected" must NOT mean
 * "Strava connected" — an Intervals.icu athlete is just as connected, and
 * onboarding/plan generation gate on this rather than on any one provider.
 */
async function hasTrainingDataConnected(profile) {
  if (profile && profile.strava_connected === true) return true;
  const status = await providerRequest("status").catch(() => null);
  return Boolean(status && status.connected);
}

/*
 * Historical Strava lap backfill (dev/manual). Repeatedly asks the server for
 * one small batch until every historical run has been checked, then drops the
 * activity cache so the canonical classifier re-runs over the enriched rows.
 *
 * Console:  await AthlevoBrain.backfillStravaLaps()
 */
async function backfillStravaLaps(options) {
  const opts = options || {};
  const batchSize = Number(opts.batchSize) || 25;
  const maxBatches = Number(opts.maxBatches) || 40;   // safety stop
  let totals = { processed: 0, withLaps: 0, batches: 0 };

  for (let i = 0; i < maxBatches; i += 1) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { console.warn("Not signed in."); break; }

    const res = await fetch("/api/strava/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ mode: "backfill", batchSize })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("Backfill failed:", data.error || res.status); break; }

    totals.processed += Number(data.processed) || 0;
    totals.withLaps += Number(data.withLaps) || 0;
    totals.batches += 1;
    console.log(
      `[lap backfill] batch ${totals.batches}: checked ${data.processed}, ` +
      `laps found ${data.withLaps}, remaining ${data.remaining}`
    );

    if (data.rateLimited) {
      console.warn("[lap backfill] Strava rate limit reached — wait ~15 min and run again.");
      break;
    }
    if (data.done || (Number(data.processed) || 0) === 0) break;
  }

  // Fresh classification over the newly enriched rows.
  invalidateActivityCache();
  console.log(
    `[lap backfill] finished — ${totals.processed} activities checked, ` +
    `${totals.withLaps} now have lap structure.`
  );
  return totals;
}

/* ══════════════════ Activity windows (replaces the row cap) ═══════════
 *
 * The loader used to take "the newest 200 rows". That silently truncated
 * training history the moment an athlete connected a second provider — at
 * 274 canonical activities, 74 were invisible to Trends, Score and Coach.
 *
 * A bigger number would only move the cliff. The fix is to stop bounding by
 * ROW COUNT (which has no relationship to what a calculation needs) and bound
 * by TIME instead, then page through every row inside that window:
 *
 *   recent  — 120 days. Today, readiness, the latest-workout card. Short
 *             surfaces stay cheap; they never download years of history.
 *   history — 400 days. Trends, Athlevo Score, Coach context, development.
 *             Comfortably covers a 12-month view plus the previous season
 *             for year-over-year comparison.
 *   full    — everything. All-time bests and race detection only.
 *
 * A window is a statement about what a calculation needs. A row count was an
 * arbitrary guess about how much data an athlete has.
 */
const ACTIVITY_WINDOWS = {
  recent:  { days: 120 },
  history: { days: 400 },
  full:    { days: null }
};
const ACTIVITY_PAGE_SIZE = 500;
// Absolute backstop so a corrupt window can never page forever. Well beyond
// any real athlete: 5000 activities is ~10 years of daily training.
const ACTIVITY_MAX_ROWS = 5000;

function resolveActivityWindow(arg) {
  if (typeof arg === "string" && ACTIVITY_WINDOWS[arg]) return arg;
  /*
   * Legacy numeric argument (the old row limit). Callers that still pass a
   * number get the history window rather than a truncated set — silently
   * honouring "200" is what caused the data loss this replaced.
   */
  if (typeof arg === "number") return "history";
  return "history";
}

function peekActivityCount() {
  return __activityCache && Array.isArray(__activityCache.data) ? __activityCache.data.length : null;
}

async function loadAthleteActivities(windowName, options) {
  const forceRefresh = !!(options && options.forceRefresh);
  let uid = null;
  try { uid = (await supabaseClient.auth.getUser()).data?.user?.id || null; } catch (e) { uid = null; }
  if (!uid) return [];

  const win = resolveActivityWindow(windowName);
  const key = `${uid}:${win}`;

  if (!forceRefresh) {
    if (__activityCache.key === key && __activityCache.data &&
        Date.now() - __activityCache.at < ACTIVITY_CACHE_TTL_MS) {
      return __activityCache.data;
    }
    if (__activityInflight && __activityInflight.key === key) {
      return __activityInflight.promise;   // share the in-flight request
    }
  }

  const promise = loadAthleteActivitiesUncached(win)
    .then(rows => {
      __activityCache = { key, at: Date.now(), data: rows };
      return rows;
    })
    .finally(() => {
      if (__activityInflight && __activityInflight.key === key) __activityInflight = null;
    });

  __activityInflight = { key, promise };
  return promise;
}

/*
 * The real query — pages through EVERY canonical activity inside the window.
 *
 * Two things make this safe at scale:
 *   1. The superseded filter runs SERVER-SIDE. Duplicate rows are excluded by
 *      Postgres before paging, so they can never consume the budget and push
 *      real training out of range. (Previously the filter ran client-side,
 *      after the cap, so every duplicate cost one real activity.)
 *   2. Pages are bounded and the loop stops on the first short page, so a
 *      window with 12 activities costs exactly one request.
 */
async function loadAthleteActivitiesUncached(windowName) {
  const {
    data: { user },
    error: userError
  } = await supabaseClient.auth.getUser();

  if (userError) {
    console.error("Could not get current athlete:", userError);
    return [];
  }

  if (!user) {
    console.log("No athlete is logged in.");
    return [];
  }

  const win = ACTIVITY_WINDOWS[windowName] || ACTIVITY_WINDOWS.history;
  const since = win.days
    ? new Date(Date.now() - win.days * 86400000).toISOString()
    : null;

  const COLUMNS = `
        id,
        user_id,
        source,
        external_activity_id,
        name,
        sport_type,
        activity_type,
        distance_meters,
        moving_time_seconds,
        elapsed_time_seconds,
        elevation_gain_meters,
        average_speed_mps,
        average_heartrate,
        max_heartrate,
        max_speed_mps,
        average_cadence,
        start_date,
        timezone,
        trainer,
        commute,
        laps:raw_data->laps,
        recognition:raw_data->recognition,
        superseded:raw_data->superseded
      `;

  const rows = [];
  let pages = 0;

  for (let from = 0; from < ACTIVITY_MAX_ROWS; from += ACTIVITY_PAGE_SIZE) {
    /*
     * Filters first, then ordering, then the page range. Applying a filter
     * after .range() would be ambiguous about whether it narrows the page or
     * the whole set — build the full predicate before slicing it.
     */
    let query = supabaseClient
      .from("activities")
      .select(COLUMNS)
      .eq("user_id", user.id)
      // Exclude superseded duplicates in the DATABASE. A row with no
      // `superseded` key yields SQL NULL, so untouched rows all match.
      .is("raw_data->superseded", null);

    if (since) query = query.gte("start_date", since);

    const { data, error } = await query
      .order("start_date", { ascending: false })
      .range(from, from + ACTIVITY_PAGE_SIZE - 1);

    if (error) {
      console.error("Could not load athlete activities:", error);
      // Partial data beats no data: return whatever paged successfully.
      break;
    }

    pages += 1;
    rows.push(...(data || []));
    if (!data || data.length < ACTIVITY_PAGE_SIZE) break;   // last page
  }

  /*
   * Defence in depth. The server-side filter above is authoritative, but a
   * row explicitly storing `superseded: false` (never written today) would
   * pass it, so the client check stays as a second gate. It is now free —
   * it can no longer cost an activity, because nothing was capped.
   */
  const visible = rows.filter(a => a.superseded !== true);

  console.log(
    `Loaded ${visible.length} canonical activities (window: ${windowName}` +
    `${win.days ? `, ${win.days}d` : ", all time"}, ${pages} page${pages === 1 ? "" : "s"})`
  );

  if (rows.length >= ACTIVITY_MAX_ROWS) {
    console.warn(`Activity paging hit the ${ACTIVITY_MAX_ROWS}-row safety limit.`);
  }

  // Guarantee newest-first regardless of how the rows arrived.
  return sortActivitiesByStartDesc(visible);
}

function buildActivitySummary(activities = []) {
  const validActivities = Array.isArray(activities)
    ? activities.filter(activity => activity?.start_date)
    : [];

  const sortedActivities = [...validActivities].sort(
    (a, b) => new Date(b.start_date) - new Date(a.start_date)
  );

  const latestActivity = sortedActivities[0] || null;

  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);

  const recentActivities = sortedActivities.filter(
    activity => new Date(activity.start_date) >= sevenDaysAgo
  );

  const sevenDayDistanceMeters = recentActivities.reduce(
    (total, activity) =>
      total + (Number(activity.distance_meters) || 0),
    0
  );

  const sevenDayMovingSeconds = recentActivities.reduce(
    (total, activity) =>
      total + (Number(activity.moving_time_seconds) || 0),
    0
  );

  const activitiesWithHeartRate = recentActivities.filter(
    activity =>
      Number.isFinite(Number(activity.average_heartrate)) &&
      Number(activity.average_heartrate) > 0
  );

  const sevenDayAverageHeartRate = activitiesWithHeartRate.length
    ? activitiesWithHeartRate.reduce(
        (total, activity) =>
          total + Number(activity.average_heartrate),
        0
      ) / activitiesWithHeartRate.length
    : null;

  const weeklyVolumes = [];

  for (let weekIndex = 5; weekIndex >= 0; weekIndex -= 1) {
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() - weekIndex * 7);

    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 7);

    const weekActivities = sortedActivities.filter(activity => {
      const activityDate = new Date(activity.start_date);

      return activityDate >= weekStart && activityDate < weekEnd;
    });

    const distanceMeters = weekActivities.reduce(
      (total, activity) =>
        total + (Number(activity.distance_meters) || 0),
      0
    );

    weeklyVolumes.push({
      startDate: weekStart.toISOString(),
      endDate: weekEnd.toISOString(),
      activityCount: weekActivities.length,
      distanceKilometers: distanceMeters / 1000
    });
  }

  return {
    latestActivity,
    sevenDayActivityCount: recentActivities.length,
    sevenDayDistanceKilometers: sevenDayDistanceMeters / 1000,
    sevenDayTrainingHours: sevenDayMovingSeconds / 3600,
    sevenDayAverageHeartRate,
    weeklyVolumes
  };
}

window.AthlevoBrain = {
  loadAthleteProfile,
  loadAthleteActivities,
  invalidateActivityCache,
  backfillStravaLaps,
  connectIntervals,
  finalizeIntervals,
  syncIntervals,
  refreshIntervalsStatus,
  diagnoseIntervals,
  diagnoseIntervalsQuiet,
  providerStatus,
  onIntervalsRowTap,
  disconnectIntervals,
  reanalyzeActivities,
  maybeBackfillRecognitionOnce,
  setTrainingDataCount,
  openSyncPartner,
  peekActivityCount,
  hasTrainingDataConnected,
  buildActivitySummary,
  buildCoachingContext,
  updateTodayDashboard,
  updateTodayActivityData,
  updateAthleteProfileScreens,
  updateTrainActivityData,
  updateTrendsActivityData,
  resetAthleteUI,
  refreshAthleteUI,
  syncStravaActivities
};