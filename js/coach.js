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

  // Do not log message content (private data).
  const { error } = await supabaseClient
    .from("coach_conversations")
    .insert([
      {
        user_id: user.id,
        role,
        message
      }
    ]);

  if (error) {
    console.error("Could not save conversation message:", error.message);
  }
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

  // Any proposal cards restored from history that were already applied
  // must show Applied (and lose their buttons) so nothing re-applies.
  markAppliedProposals();
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
        // Exposed so the coach can target a specific session in an
        // action proposal. Server re-verifies ownership before applying.
        session_id: item.id || null,
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
 * Loads today's readiness and shapes it (factual, no invented score) for
 * the coach context. Returns null when none is logged.
 */
async function loadTodayReadinessForCoach() {
  try {
    // Reuse the readiness module so the coach receives the SAME
    // calculated score/status/explanation the athlete sees on Today.
    if (typeof window.getReadinessForCoach === "function") {
      return await window.getReadinessForCoach();
    }

    return null;
  } catch (error) {
    console.error("Could not load today's readiness for coach:", error);
    return null;
  }
}

/*
 * Loads a SHORT recent-conversation window (not the whole history) for
 * continuity across turns. Assistant messages are compressed to their
 * one-line answer so the model gets concise context, not a data dump.
 */
async function loadRecentConversationForCoach(limit = 8) {
  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) return [];

    const { data, error } = await supabaseClient
      .from("coach_conversations")
      .select("role, message, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !Array.isArray(data)) return [];

    return data
      .reverse()
      .map(row => {
        let text = row.message;

        if (row.role === "assistant") {
          try {
            const parsed = JSON.parse(row.message);
            text = parsed.direct_answer || parsed.headline || "(coaching reply)";
          } catch (e) {
            /* legacy plain-text assistant message */
          }
        }

        return {
          role: row.role === "assistant" ? "coach" : "athlete",
          text: String(text || "").slice(0, 500)
        };
      });
  } catch (error) {
    console.error("Could not load recent conversation for coach:", error);
    return [];
  }
}

/*
 * Builds the compact "Coach Context" summary shown above a reply. Every
 * item reflects context that was actually assembled and sent — nothing
 * is invented. Items are omitted when the underlying data is absent.
 */
function buildCoachContextSummary(context) {
  const items = [];

  if (context?.todayReadiness) {
    items.push("Reviewed today's readiness");
  }

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

let coachRequestInFlight = false;

async function askCoach(question) {
  const cleanQuestion = question?.trim();

  if (!cleanQuestion) return;

  // Prevent duplicate submissions (double-tap / repeated Enter) from
  // creating duplicate stored messages.
  if (coachRequestInFlight) return;
  coachRequestInFlight = true;

  addChatMessage("user", cleanQuestion);
  await saveConversationMessage("user", cleanQuestion);
  await extractAthleteMemoryFromMessage(
  cleanQuestion
);

  // A calm "coach is typing" indicator instead of a verbose status line —
  // it reads like texting a real coach who's thinking, not a loading log.
  const loadingMessage = addChatMessage("ai", "");
  {
    const changeEl = loadingMessage && loadingMessage.querySelector(".change");
    if (changeEl) {
      changeEl.innerHTML =
        '<span class="coach-typing" role="status" aria-label="Coach is typing">' +
        "<i></i><i></i><i></i></span>";
    }
  }

  try {
    const profile =
  await AthlevoBrain.loadAthleteProfile();

if (!profile) {
  throw new Error(
    "No athlete profile was found."
  );
}

const activities =
  await AthlevoBrain.loadAthleteActivities("history");

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

// Durable athlete memory — concise, active facts only. Internal fields
// (id, confidence, importance) are NOT sent to the model. An unverified
// flag lets the coach treat a fact as tentative.
context.longTermMemory = athleteMemory
  .filter(memory => memory.is_active !== false)
  .slice(0, 40)
  .map(memory => {
    const fact = {
      category: memory.category,
      fact: memory.content,
      lastConfirmed:
        memory.last_confirmed_at || memory.updated_at || undefined
    };
    if (memory.verification_state === "unverified") {
      fact.unverified = true;
    }
    return fact;
  });

// This week's prescribed sessions plus the athlete's own execution
// feedback (completed / skipped / modified, with pain and RPE). Best
// effort: coaching must still work if this is unavailable.
context.currentWeekExecution =
  await loadWeekExecutionForCoach();

// Today's readiness — the athlete's own report — is coaching input the
// coach must receive alongside the objective training data.
context.todayReadiness = await loadTodayReadinessForCoach();

// A short recent-conversation window for continuity (not the full
// history). Drop the just-sent question so it isn't duplicated.
context.recentConversation = (await loadRecentConversationForCoach())
  .filter(
    (m, i, arr) =>
      !(i === arr.length - 1 && m.role === "athlete" && m.text === cleanQuestion)
  );
    // The coach endpoint now requires a valid Athlevo session (it spends AI
    // budget), so send the Supabase access token like every other endpoint.
    const { data: { session: coachSession } } = await supabaseClient.auth.getSession();
    if (!coachSession) {
      throw new Error("Your session expired. Please sign in again.");
    }

    const response = await fetch("/api/coach", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${coachSession.access_token}`
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

// Only persist a genuine, successful reply. A missing data.answer means
// the model call did not produce a real structured response, so we show
// the fallback but do NOT store it as a successful coaching message.
if (data.answer) {
  await saveConversationMessage(
    "assistant",
    JSON.stringify(answer)
  );
}
  } catch (error) {
    console.error("Athlevo Coach error:", error);

    loadingMessage.querySelector(".change").textContent =
      "I couldn’t complete that request. Please try again.";
  } finally {
    coachRequestInFlight = false;
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

/* ══════════════ structured coach actions ══════════════ */

function setActionCardStatus(cardEl, label, cls) {
  const status = cardEl.querySelector(".ca-status");

  if (status) {
    status.textContent = label;
    status.className = "ca-status" + (cls ? " " + cls : "");
  }
}

/* "today at 2:40 PM" or "Jul 13 at 2:40 PM" from an applied timestamp. */
function formatAppliedTime(value) {
  const date = value ? new Date(value) : new Date();

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });

  const isToday =
    date.toDateString() === new Date().toDateString();

  if (isToday) {
    return `today at ${time}`;
  }

  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });

  return `${day} at ${time}`;
}

/*
 * Locks a proposal card into its Applied state: status pill, an applied
 * timestamp line, and no action buttons — so the same proposal can never
 * be applied again (from this render or after a chat reload).
 */
function markCardApplied(cardEl, appliedAt) {
  if (!cardEl) {
    return;
  }

  cardEl.dataset.status = "applied";
  setActionCardStatus(cardEl, "Applied", "applied");

  const applyBtn = cardEl.querySelector(".ca-apply");
  const cancelBtn = cardEl.querySelector(".ca-cancel");

  if (applyBtn) applyBtn.remove();
  if (cancelBtn) cancelBtn.remove();

  const message = cardEl.querySelector(".ca-msg");

  if (message) {
    const when = formatAppliedTime(appliedAt);
    message.className = "ca-msg ca-applied";
    message.textContent = "✔ Applied" + (when ? ` · ${when}` : "");
  }
}

/*
 * On chat (re)load, reconcile rendered proposal cards with the stored
 * applied proposals so already-applied changes show Applied and cannot
 * be re-applied. Read-only; user-owned rows via RLS.
 */
async function markAppliedProposals() {
  try {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();

    if (!user) {
      return;
    }

    const { data, error } = await supabaseClient
      .from("coach_action_proposals")
      .select("id, applied_at, status")
      .eq("user_id", user.id)
      .eq("status", "applied");

    if (error || !Array.isArray(data)) {
      return;
    }

    data.forEach(row => {
      const card = document.querySelector(
        `.coach-action[data-proposal-id="${row.id}"]`
      );

      if (card && card.dataset.status !== "applied") {
        markCardApplied(card, row.applied_at);
      }
    });
  } catch (error) {
    console.error("Could not reconcile applied proposals:", error);
  }
}

window.markAppliedProposals = markAppliedProposals;

/*
 * Applies a confirmed coach proposal through the authenticated training
 * endpoint. The server re-validates ownership and every field before it
 * changes anything. Idempotent: a repeated tap can't double-apply.
 */
async function applyCoachAction(proposalId, cardEl) {
  if (!cardEl || cardEl.dataset.status === "applied") {
    return;
  }

  const proposal =
    (window.__coachProposals || {})[proposalId] || null;

  const applyBtn = cardEl.querySelector(".ca-apply");
  const cancelBtn = cardEl.querySelector(".ca-cancel");
  const message = cardEl.querySelector(".ca-msg");

  if (!proposal) {
    if (message) {
      message.textContent = "This proposal is no longer available.";
    }
    return;
  }

  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying…";
  }
  if (cancelBtn) {
    cancelBtn.disabled = true;
  }
  if (message) {
    message.textContent = "";
  }

  try {
    const {
      data: { session }
    } = await supabaseClient.auth.getSession();

    if (!session?.access_token) {
      throw new Error("Please log in again to apply this change.");
    }

    const res = await fetch("/api/training/get-week", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "apply_coach_action",
        proposal
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "That change could not be applied.");
    }

    // Lock the card into Applied (with timestamp) so it can't re-apply.
    markCardApplied(cardEl, data?.proposal?.applied_at);

    if (typeof toast === "function") {
      toast("Workout updated");
    }

    // Refresh the surfaces the change affects: Train, Today, and Coach's
    // own view of the week (used on the next reply).
    if (window.AthlevoBrain?.refreshAthleteUI) {
      await window.AthlevoBrain.refreshAthleteUI();
    }
    if (typeof window.loadWeeklyPlan === "function") {
      await window.loadWeeklyPlan();
    }
  } catch (error) {
    console.error("Apply coach action failed:", error);

    if (message) {
      message.textContent =
        error.message || "Could not apply. Please try again.";
    }
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = "Apply changes";
    }
    if (cancelBtn) {
      cancelBtn.disabled = false;
    }
  }
}

/* Cancel is client-only — it changes no stored data. */
function cancelCoachAction(proposalId, cardEl) {
  if (!cardEl || cardEl.dataset.status === "applied") {
    return;
  }

  cardEl.dataset.status = "cancelled";
  setActionCardStatus(cardEl, "Cancelled", "cancelled");

  const applyBtn = cardEl.querySelector(".ca-apply");
  const cancelBtn = cardEl.querySelector(".ca-cancel");
  const message = cardEl.querySelector(".ca-msg");

  if (applyBtn) applyBtn.remove();
  if (cancelBtn) cancelBtn.remove();
  if (message) message.textContent = "No changes were made.";
}

window.askCoach = askCoach;
window.ask = ask;
window.sendMsg = sendMsg;
window.loadConversationHistory = loadConversationHistory;
window.saveConversationMessage = saveConversationMessage;
window.renderConversationHistory = renderConversationHistory;
window.applyCoachAction = applyCoachAction;
window.cancelCoachAction = cancelCoachAction;