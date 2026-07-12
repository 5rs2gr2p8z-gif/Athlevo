console.log("Athlevo Daily Brief Loaded");

function setDailyBriefText(elementId, value, fallback) {
  const element = document.getElementById(elementId);

  if (!element) return;

  const cleanValue =
    typeof value === "string"
      ? value.trim()
      : "";

  element.textContent =
    cleanValue || fallback;
}

function renderDailyBriefLimitations(limitations) {
  const container =
    document.getElementById(
      "dailyBriefLimitations"
    );

  if (!container) return;

  container.innerHTML = "";

  if (
    !Array.isArray(limitations) ||
    limitations.length === 0
  ) {
    return;
  }

  const wrapper =
    document.createElement("div");

  wrapper.className =
    "daily-brief-limitations";

  const title =
    document.createElement("span");

  title.className =
    "daily-brief-limitations-title";

  title.textContent =
    "Current data limitations";

  wrapper.appendChild(title);

  limitations.forEach(item => {
    if (
      typeof item !== "string" ||
      !item.trim()
    ) {
      return;
    }

    const paragraph =
      document.createElement("p");

    paragraph.className =
      "daily-brief-limitation";

    paragraph.textContent =
      `— ${item.trim()}`;

    wrapper.appendChild(paragraph);
  });

  container.appendChild(wrapper);
}

function renderDailyBrief(briefing) {
  if (!briefing) {
    throw new Error(
      "No daily briefing was returned."
    );
  }

  setDailyBriefText(
    "dailyBriefHeadline",
    briefing.headline,
    "Daily coaching brief unavailable."
  );

  setDailyBriefText(
    "dailyBriefTrainingSummary",
    briefing.training_summary,
    "There is not enough recent training data to summarize."
  );

  setDailyBriefText(
    "dailyBriefObservation",
    briefing.coach_observation,
    "No defensible training pattern is available yet."
  );

  setDailyBriefText(
    "dailyBriefRecommendation",
    briefing.recommendation,
    "Continue collecting real training and recovery information."
  );

  setDailyBriefText(
    "dailyBriefReasoning",
    briefing.reasoning,
    "Athlevo does not yet have enough information to explain a specific recommendation."
  );

  renderDailyBriefLimitations(
    briefing.data_limitations
  );
}

function renderDailyBriefLoading() {
  setDailyBriefText(
    "dailyBriefHeadline",
    "Preparing your coaching brief...",
    ""
  );

  setDailyBriefText(
    "dailyBriefTrainingSummary",
    "Athlevo is reviewing your athlete profile and imported training.",
    ""
  );

  setDailyBriefText(
    "dailyBriefObservation",
    "Reviewing your recent workload...",
    ""
  );

  setDailyBriefText(
    "dailyBriefRecommendation",
    "Building a responsible recommendation...",
    ""
  );

  setDailyBriefText(
    "dailyBriefReasoning",
    "The reasoning will appear when the briefing is ready.",
    ""
  );

  const limitations =
    document.getElementById(
      "dailyBriefLimitations"
    );

  if (limitations) {
    limitations.innerHTML = "";
  }

  setDailyBriefText(
    "dailyBriefStatus",
    "Generating briefing...",
    ""
  );
}

function renderDailyBriefError(error) {
  console.error(
    "Daily briefing failed:",
    error
  );

  setDailyBriefText(
    "dailyBriefHeadline",
    "Daily briefing unavailable.",
    ""
  );

  setDailyBriefText(
    "dailyBriefTrainingSummary",
    "Your profile and imported activities are still available, but Athlevo could not generate today’s briefing.",
    ""
  );

  setDailyBriefText(
    "dailyBriefObservation",
    "No AI-generated observation is being shown.",
    ""
  );

  setDailyBriefText(
    "dailyBriefRecommendation",
    "Use your existing training plan until the briefing becomes available.",
    ""
  );

  setDailyBriefText(
    "dailyBriefReasoning",
    "Athlevo avoids displaying invented coaching advice when the briefing request fails.",
    ""
  );

  setDailyBriefText(
    "dailyBriefStatus",
    error?.message ||
      "Could not load the briefing.",
    ""
  );
}

async function loadDailyBrief({
  force = false
} = {}) {
  renderDailyBriefLoading();

  try {
    const {
      data: { session },
      error: sessionError
    } =
      await supabaseClient.auth.getSession();

    if (sessionError) {
      throw sessionError;
    }

    if (!session?.access_token) {
      setDailyBriefText(
        "dailyBriefStatus",
        "Log in to generate your daily briefing.",
        ""
      );

      return null;
    }

    const response = await fetch(
      "/api/daily-brief",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization:
            `Bearer ${session.access_token}`
        },

        body: JSON.stringify({
          force
        })
      }
    );

    const result =
      await response.json();

    if (!response.ok) {
      throw new Error(
        result?.error ||
          "Could not load the daily briefing."
      );
    }

    renderDailyBrief(result.briefing);

    setDailyBriefText(
      "dailyBriefStatus",
      result.cached
        ? "Today’s saved briefing"
        : "Updated from your latest athlete data",
      ""
    );

    return result.briefing;
  } catch (error) {
    renderDailyBriefError(error);
    return null;
  }
}

window.AthlevoDailyBrief = {
  load: loadDailyBrief,
  render: renderDailyBrief
};