console.log("Athlevo Brain Loaded");

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
    .select(`
      id,
      email,
      full_name,
      goal,
      race_type,
      injury_history,
      training_days,
      device
    `)
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Could not load athlete profile:", profileError);
    return null;
  }

  console.log("Athlete profile loaded:", profile);
  return profile;
}

function buildCoachingContext(profile) {
  if (!profile) return null;

  return {
    athlete: {
      id: profile.id,
      name: profile.full_name || "Athlete",
      email: profile.email || null
    },

    trainingProfile: {
      goal: profile.goal || "Not provided",
      raceType: profile.race_type || "Not provided",
      injuryHistory: profile.injury_history || "None reported",
      trainingDays: profile.training_days || null,
      device: profile.device || "None"
    },

    coachingRules: {
      respectInjuries: true,
      prioritizeConsistency: true,
      explainEveryDecision: true,
      avoidGenericAdvice: true
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

  if (garminMark) {
    garminMark.textContent = profile.garmin_connected ? "✓" : "—";
  }
}

window.AthlevoBrain = {
  loadAthleteProfile,
  buildCoachingContext,
  updateTodayDashboard,
  updateAthleteProfileScreens
};