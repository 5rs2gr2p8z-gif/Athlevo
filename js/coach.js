console.log("Athlevo Coach Loaded");

function addChatMessage(role, text) {
  const chatlog = document.getElementById("chatlog");

  if (!chatlog) {
    console.error("Chat log not found.");
    return null;
  }

  const message = document.createElement("div");
  message.className = `msg ${role}`;

  if (role === "user") {
    message.innerHTML = `
      <span class="call">You</span>
      <div class="change"></div>
    `;
  } else {
    message.innerHTML = `
      <span class="call">Athlevo Coach</span>
      <div class="change"></div>
    `;
  }

  message.querySelector(".change").textContent = text;
  chatlog.appendChild(message);
  chatlog.scrollTop = chatlog.scrollHeight;

  requestAnimationFrame(() => {
  const chatlog =
    document.getElementById("chatlog");

  if (chatlog) {
    chatlog.scrollTop =
      chatlog.scrollHeight;
  }
});
  return message;
}
async function saveConversationMessage(role, message) {
  const {
    data: { user },
    error: userError
  } = await supabaseClient.auth.getUser();

  if (userError || !user) {
    console.error("Cannot save message: no authenticated user.", userError);
    return;
  }

  console.log("Saving conversation for:", user.id, role, message);

const { data, error } = await supabaseClient
  .from("coach_conversations")
  .insert([
    {
      user_id: user.id,
      role,
      message
    }
  ])
  .select();

if (error) {
  console.error("Could not save conversation message:", error);
  return;
}

console.log("Conversation saved successfully:", data);
}

async function loadConversationHistory() {
  const {
    data: { user },
    error: userError
  } = await supabaseClient.auth.getUser();

  if (userError || !user) {
    console.error("Cannot load history: no authenticated user.", userError);
    return [];
  }

  const { data, error } = await supabaseClient
    .from("coach_conversations")
    .select("role, message, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Could not load conversation history:", error);
    return [];
  }

  return data || [];
}
async function renderConversationHistory() {
  const chatlog = document.getElementById("chatlog");

  if (!chatlog) {
    console.error("Chat log not found.");
    return;
  }

  const history = await loadConversationHistory();

  if (!history.length) return;

  chatlog.innerHTML = "";

  history.forEach(item => {
  const role =
    item.role === "assistant" ? "ai" : "user";

  const messageElement = addChatMessage(
    role,
    item.message
  );

  if (item.role === "assistant") {
    const responseContainer =
      messageElement?.querySelector(".change");

    if (responseContainer) {
      renderCoachResponse(
        responseContainer,
        item.message
      );
    }
  }
});

const latestAssistantMessage =
  [...history]
    .reverse()
    .find(
      item => item.role === "assistant"
    );

if (latestAssistantMessage) {
  try {
    const parsed =
      JSON.parse(
        latestAssistantMessage.message
      );

    renderSuggestedReplies(
      parsed.suggested_replies || []
    );
  } catch (error) {
    renderSuggestedReplies([]);
  }
}

  chatlog.scrollTop = chatlog.scrollHeight;
}
async function extractAthleteMemoryFromMessage(message) {
  try {
    const {
      data: { session },
      error: sessionError
    } = await supabaseClient.auth.getSession();

    if (sessionError) {
      throw sessionError;
    }

    if (!session?.access_token) {
      console.log(
        "Memory extraction skipped: no authenticated session."
      );

      return {
        memories: [],
        extractedCount: 0
      };
    }

    const response = await fetch(
      "/api/memory/extract",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization:
            `Bearer ${session.access_token}`
        },

        body: JSON.stringify({
          message
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result?.error ||
        "Could not extract athlete memory."
      );
    }

    console.log(
      "Athlete memory extraction:",
      result
    );

    return result;
  } catch (error) {
    /*
     * Memory extraction must never prevent the
     * athlete from receiving a coaching response.
     */
    console.error(
      "Athlete memory extraction failed:",
      error
    );

    return {
      memories: [],
      extractedCount: 0,
      error:
        error?.message ||
        "Memory extraction failed."
    };
  }
}
async function loadWeekExecutionForCoach() {
  try {
    const {
      data: { session }
    } = await supabaseClient.auth.getSession();

    if (!session?.access_token) {
      return null;
    }

    const res = await fetch("/api/training/get-week", {
      headers: {
        Authorization: `Bearer ${session.access_token}`
      }
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();

    if (!data?.hasPlan || !Array.isArray(data.sessions)) {
      return null;
    }

    const sessions = data.sessions.map(item => {
      const record = item.execution || null;

      const entry = {
        date: item.session_date || null,
        title: item.title || null,
        type: item.session_type || null,
        status: record?.status || "planned"
      };

      if (record) {
        entry.feedback = {
          asPrescribed: record.as_prescribed,
          actualDurationMinutes: record.actual_duration_minutes,
          actualDistanceKm: record.actual_distance_km,
          actualAveragePace: record.actual_average_pace,
          actualAverageHr: record.actual_average_hr,
          rpe: record.actual_rpe,
          feeling: record.overall_feeling,
          painPresent: record.pain_present === true,
          painLocation: record.pain_location,
          painSeverity: record.pain_severity,
          skipReason: record.skip_reason,
          modificationReason: record.modification_reason,
          notes: record.athlete_notes
        };

        // Drop empty keys so the model never sees null/undefined.
        Object.keys(entry.feedback).forEach(key => {
          const value = entry.feedback[key];

          if (
            value === null ||
            value === undefined ||
            value === "" ||
            value === false
          ) {
            delete entry.feedback[key];
          }
        });
      }

      return entry;
    });

    return {
      weekStart: data.weekStart || null,
      phase: data.plan?.phase || null,
      sessions
    };
  } catch (error) {
    console.error(
      "Could not load week execution for coach:",
      error
    );
    return null;
  }
}

/*
 * Builds the compact "Coach Context" summary shown above a reply. Every
 * item reflects context that was actually assembled and sent — nothing
 * is invented. Items are omitted when the underlying data is absent.
 */
function buildCoachContextSummary(context) {
  const items = [];

  const week = context?.currentWeekExecution || null;
  const sessions = Array.isArray(week?.sessions) ? week.sessions : [];

  const now = new Date();
  const todayKey =
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getDate()).padStart(2, "0")}`;

  const hasToday = sessions.some(
    session => String(session.date || "").slice(0, 10) === todayKey
  );

  if (hasToday) {
    items.push("Reviewed today's workout");
  }

  if (sessions.length > 0) {
    items.push("Checked your weekly plan");
  }

  const recentCount =
    Number(context?.importedTrainingData?.totalImportedActivities) ||
    (Array.isArray(context?.importedTrainingData?.recentActivities)
      ? context.importedTrainingData.recentActivities.length
      : 0);

  if (recentCount > 0) {
    items.push("Reviewed recent training");
  }

  const hasExecution = sessions.some(
    session => session.status && session.status !== "planned"
  );

  if (hasExecution) {
    items.push("Considered workout execution");
  }

  const phase =
    typeof week?.phase === "string" && week.phase.trim()
      ? week.phase.trim()
      : "";

  if (phase) {
    const label = phase.charAt(0).toUpperCase() + phase.slice(1);
    items.push(`Current phase: ${label}`);
  }

  return items;
}

async function askCoach(question) {
  const cleanQuestion = question?.trim();

  if (!cleanQuestion) return;

  addChatMessage("user", cleanQuestion);
  await saveConversationMessage("user", cleanQuestion);
  await extractAthleteMemoryFromMessage(
  cleanQuestion
);

  const loadingMessage = addChatMessage(
    "ai",
    "Reviewing your athlete profile and training context..."
  );

  try {
    const profile =
  await AthlevoBrain.loadAthleteProfile();

if (!profile) {
  throw new Error(
    "No athlete profile was found."
  );
}

const activities =
  await AthlevoBrain.loadAthleteActivities(200);

const activitySummary =
  AthlevoBrain.buildActivitySummary(activities);

const athleteMemory =
  await AthlevoMemory.loadAthleteMemory();

const context =
  AthlevoBrain.buildCoachingContext(
    profile,
    activities,
    activitySummary
  );

if (!context) {
  throw new Error(
    "The athlete coaching context could not be created."
  );
}

context.longTermMemory = athleteMemory.map(memory => ({
  id: memory.id,
  category: memory.category,
  content: memory.content,
  importance: memory.importance,
  updatedAt: memory.updated_at
}));

// This week's prescribed sessions plus the athlete's own execution
// feedback (completed / skipped / modified, with pain and RPE). Best
// effort: coaching must still work if this is unavailable.
context.currentWeekExecution =
  await loadWeekExecutionForCoach();
    const response = await fetch("/api/coach", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        question: cleanQuestion,
        context
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Coach request failed.");
    }

    const answer =
  data.answer || {
    response_type: "standard",
    headline: null,
    direct_answer:
      "I could not generate a response.",
    compliment: null,
    sections: [],
    mission: null,
    confidence: null,
    closing: null,
    suggested_replies: []
  };

// Attach the truthful Coach Context summary so it renders above the
// reply and persists with the saved conversation history.
answer.coach_context = buildCoachContextSummary(context);

const responseContainer =
  loadingMessage.querySelector(".change");

renderCoachResponse(
  responseContainer,
  answer
);

renderSuggestedReplies(
  answer.suggested_replies
);

await saveConversationMessage(
  "assistant",
  JSON.stringify(answer)
);
  } catch (error) {
    console.error("Athlevo Coach error:", error);

    loadingMessage.querySelector(".change").textContent =
      "I couldn’t complete that request. Please try again.";
  }

  const chatlog = document.getElementById("chatlog");
  chatlog.scrollTop = chatlog.scrollHeight;
}

function ask(question) {
  askCoach(question);
}

function sendMsg() {
  const input = document.getElementById("chatInput");

  if (!input) {
    console.error("Chat input not found.");
    return;
  }

  const question = input.value.trim();

  if (!question) return;

  input.value = "";
  askCoach(question);
}

window.askCoach = askCoach;
window.ask = ask;
window.sendMsg = sendMsg;
window.loadConversationHistory = loadConversationHistory;
window.saveConversationMessage = saveConversationMessage;
window.renderConversationHistory = renderConversationHistory;