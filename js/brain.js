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

window.AthlevoBrain = {
  loadAthleteProfile,
  buildCoachingContext,
  updateTodayDashboard
};