console.log("Athlevo Coach Loaded");

/* ══════════════ Empty state + contextual starters ══════════════ */

function setCoachConversationState(isEmpty) {
  const screen = document.getElementById("screen-coachai");
  if (!screen) return;
  screen.classList.toggle("coach-is-empty", !!isEmpty);
  screen.classList.toggle("coach-is-active", !isEmpty);
}

function buildCoachStarterPrompts() {
  const directionCard = document.getElementById("dailyBriefCard");
  const planState = directionCard?.dataset?.planState || "unknown";

  if (planState === "workout") {
    return [
      "Should I complete today’s workout?",
      "How should I pace this session?",
      "Am I recovering well?",
      "Adjust this week around my schedule"
    ];
  }

  if (planState === "no-workout") {
    return [
      "What should I focus on today?",
      "Am I recovering well?",
      "How is my week progressing?",
      "Adjust this week around my schedule"
    ];
  }

  if (planState === "no-plan") {
    return [
      "What should I focus on today?",
      "Am I recovering well?",
      "How should I start training this week?"
    ];
  }

  return [
    "What should I focus on today?",
    "Am I recovering well?",
    "How is my recent training load?"
  ];
}

function renderCoachStarterPrompts() {
  const container = document.getElementById("coachStarters");
  if (!container) return;
  container.innerHTML = "";

  buildCoachStarterPrompts().slice(0, 4).forEach(prompt => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "coach-starter";
    button.dataset.prompt = prompt;
    button.textContent = prompt;
    container.appendChild(button);
  });
}

function hideCoachEmptyState() {
  const el = document.getElementById("coachEmptyState");
  if (el) el.style.display = "none";
  setCoachConversationState(false);
}

function showCoachEmptyState() {
  const el = document.getElementById("coachEmptyState");
  if (el) el.style.display = "";
  setCoachConversationState(true);
  renderCoachStarterPrompts();
  if (typeof renderSuggestedReplies === "function") renderSuggestedReplies([]);
}

/* Kept as a stable public hook for existing callers. The new workspace
   intentionally uses one calm prompt rather than a personalized salutation. */
function personalizeCoachGreeting() {
  const greetEl = document.getElementById("coachEmptyGreeting");
  if (greetEl) greetEl.textContent = "What should we work on?";
}

/* Bind starter-prompt buttons (one-time, delegated). */
function bindCoachStarters() {
  const container = document.getElementById("coachStarters");
  if (!container || container.dataset.bound === "true") return;
  container.dataset.bound = "true";
  container.addEventListener("click", function (e) {
    var btn = e.target.closest(".coach-starter");
    if (!btn) return;
    var prompt = btn.dataset.prompt;
    if (prompt) askCoach(prompt);
  });
}

/* ══════════════ Thinking indicator with rotating labels ══════════ */

var _coachThinkingTimer = null;

/* Labels rotate only while a real request is pending and reflect data
   that was actually assembled into the coach context. */
var COACH_THINKING_LABELS = [
  "Reviewing your training…",
  "Checking your recent workload…",
  "Looking at today's session…",
  "Preparing your recommendation…"
];

function createCoachThinkingEl() {
  var wrap = document.createElement("div");
  wrap.className = "coach-thinking";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", "Coach is thinking");
  wrap.innerHTML =
    '<div class="coach-thinking-mark"><img src="assets/athlevo-logo.png" alt="" /></div>' +
    '<span class="coach-thinking-label">' + COACH_THINKING_LABELS[0] + '</span>';
  return wrap;
}

function startThinkingLabelRotation(labelEl) {
  if (!labelEl) return;
  var idx = 0;
  _coachThinkingTimer = setInterval(function () {
    idx = (idx + 1) % COACH_THINKING_LABELS.length;
    labelEl.style.opacity = "0";
    setTimeout(function () {
      labelEl.textContent = COACH_THINKING_LABELS[idx];
      labelEl.style.opacity = "1";
    }, 160);
  }, 2800);
}

function stopThinkingLabelRotation() {
  if (_coachThinkingTimer) {
    clearInterval(_coachThinkingTimer);
    _coachThinkingTimer = null;
  }
}

/* ══════════════ Textarea auto-grow ═══════════════════════════════ */

function autoGrowComposer() {
  var el = document.getElementById("chatInput");
  if (!el || el.tagName !== "TEXTAREA") return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

/* ══════════════ Chat message rendering ═══════════════════════════ */

function addChatMessage(role, text) {
  const chatlog = document.getElementById("chatlog");

  if (!chatlog) {
    console.error("Chat log not found.");
    return null;
  }

  // Hide the empty state as soon as the first message is added.
  hideCoachEmptyState();

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

  // Smart-scroll: only auto-scroll if the athlete is near the bottom.
  // For user messages, always scroll (they just typed it).
  if (role === "user") {
    requestAnimationFrame(() => {
      const cl = document.getElementById("chatlog");
      if (cl) cl.scrollTo({
        top: cl.scrollHeight,
        behavior: coachScrollBehavior()
      });
    });
  } else {
    requestAnimationFrame(coachSmartScroll);
  }
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
  chatlog.querySelectorAll(".msg").forEach(message => message.remove());

  if (!history.length) {
    // No history: show the workspace prompt and relevant starter actions.
    showCoachEmptyState();
    personalizeCoachGreeting();
    return;
  }

  hideCoachEmptyState();
  renderSuggestedReplies([]);

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
  syncCoachScrollUi();

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

function claimCoachRequest() {
  if (coachRequestInFlight) return false;
  coachRequestInFlight = true;
  return true;
}

/* Track the last question so retry can replay it. */
var _coachLastQuestion = null;
var _coachRetryInFlight = false;

/* ══════════════ Smart scroll + jump-to-latest ═══════════════════ */

var _coachScrollListener = null;
var _coachJumpingToLatest = false;

function coachIsNearBottom() {
  var cl = document.getElementById("chatlog");
  if (!cl) return true;
  return cl.scrollHeight - cl.scrollTop - cl.clientHeight < 80;
}

function coachScrollBehavior() {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return "auto";
  }
  return "smooth";
}

function setCoachFollowUpsVisible(visible) {
  var chips = document.getElementById("chips");
  if (!chips) return;
  var hasSuggestions =
    chips.dataset.hasSuggestions === "true" && chips.children.length > 0;
  chips.style.display = visible && hasSuggestions ? "flex" : "none";
}

function syncCoachScrollUi() {
  var screen = document.getElementById("screen-coachai");
  if (screen && screen.classList.contains("coach-is-empty")) {
    hideJumpToLatest();
    setCoachFollowUpsVisible(false);
    return;
  }

  if (coachIsNearBottom()) {
    _coachJumpingToLatest = false;
    hideJumpToLatest();
    setCoachFollowUpsVisible(!coachRequestInFlight);
    return;
  }

  setCoachFollowUpsVisible(false);
  if (_coachJumpingToLatest) hideJumpToLatest();
  else showJumpToLatest();
}

function coachSmartScroll(forceLatest) {
  var shouldFollowLatest = forceLatest === true || coachIsNearBottom();
  if (shouldFollowLatest) {
    var cl = document.getElementById("chatlog");
    if (cl) {
      if (forceLatest === true && !coachIsNearBottom()) {
        _coachJumpingToLatest = true;
        hideJumpToLatest();
        setCoachFollowUpsVisible(false);
      }
      cl.scrollTo({
        top: cl.scrollHeight,
        behavior: coachScrollBehavior()
      });
    }
  } else {
    syncCoachScrollUi();
  }
}

function showJumpToLatest() {
  var btn = document.getElementById("coachJumpLatest");
  if (btn) btn.hidden = false;
}

function hideJumpToLatest() {
  var el = document.getElementById("coachJumpLatest");
  if (el) el.hidden = true;
}

function jumpToLatestCoachMessage() {
  var cl = document.getElementById("chatlog");
  if (!cl) return;
  _coachJumpingToLatest = true;
  hideJumpToLatest();
  setCoachFollowUpsVisible(false);
  cl.scrollTo({
    top: cl.scrollHeight,
    behavior: coachScrollBehavior()
  });
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(syncCoachScrollUi);
  }
}

function bindCoachScrollWatcher() {
  var cl = document.getElementById("chatlog");
  if (!cl) return;
  // Clean up any previous listener.
  if (_coachScrollListener) {
    cl.removeEventListener("scroll", _coachScrollListener);
  }
  _coachScrollListener = function () {
    syncCoachScrollUi();
  };
  cl.addEventListener("scroll", _coachScrollListener, { passive: true });

  var jumpButton = document.getElementById("coachJumpLatest");
  if (jumpButton && jumpButton.dataset.bound !== "true") {
    jumpButton.dataset.bound = "true";
    jumpButton.addEventListener("click", jumpToLatestCoachMessage);
  }
  syncCoachScrollUi();
}

/* ══════════════ Follow-up actions ═══════════════════════════════ */

/*
 * Selects up to 2 contextual follow-up actions based on the response
 * type and existing app state. Actions must genuinely work — either
 * sending a useful follow-up prompt or navigating via existing routing.
 */
function buildFollowUpActions(answer) {
  var actions = [];
  var type = answer && answer.response_type || "standard";

  // Always offer a conversational deepener.
  actions.push({ label: "Explain further", type: "prompt",
    prompt: "Can you explain that in more detail?" });

  // Week-impact question when we know a plan exists.
  if (type === "plan_change" || type === "workout_analysis" ||
      (answer && answer.actions && answer.actions.length > 0)) {
    actions.push({ label: "How does this affect my week?", type: "prompt",
      prompt: "How does this affect the rest of my week?" });
  } else {
    actions.push({ label: "How is my week progressing?", type: "prompt",
      prompt: "How is my week progressing?" });
  }

  // Readiness check (navigates to Today).
  actions.push({ label: "Check my readiness", type: "navigate",
    screen: "screen-today" });

  return actions.slice(0, 2);
}

function renderFollowUpActions(answer) {
  var chipsContainer = document.getElementById("chips");
  if (!chipsContainer) return;

  var actions = buildFollowUpActions(answer);
  if (!actions.length) {
    chipsContainer.dataset.hasSuggestions = "false";
    chipsContainer.style.display = "none";
    syncCoachScrollUi();
    return;
  }

  chipsContainer.innerHTML = "";

  actions.forEach(function (action) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = action.label;
    btn.dataset.followupType = action.type;
    btn.addEventListener("click", function () {
      // Analytics: follow-up clicked.
      try {
        if (window.AthlevoProductAnalytics) {
          AthlevoProductAnalytics.trackAthlevoEvent("coach_followup_clicked", {
            followup_type: action.type, action_type: action.label
          });
        }
      } catch (e) {}

      if (action.type === "navigate") {
        if (typeof showScreen === "function") showScreen(action.screen);
        if (typeof go === "function") {
          var tabBtn = document.querySelector("[data-screen=\"" + action.screen + "\"]");
          if (tabBtn) go(tabBtn);
        }
      } else if (action.type === "prompt" && action.prompt) {
        askCoach(action.prompt);
      }
    });
    chipsContainer.appendChild(btn);
  });

  chipsContainer.dataset.hasSuggestions =
    chipsContainer.children.length > 0 ? "true" : "false";
  syncCoachScrollUi();
}

/* ══════════════ Inline error + retry ════════════════════════════ */

function trackCoachEvent(name, accessTier, failureCategory) {
  var props = {
    access_tier: accessTier || "unknown",
    source_surface: "coach"
  };
  if (failureCategory) props.failure_category = failureCategory;
  try {
    if (window.AthlevoProductAnalytics) {
      AthlevoProductAnalytics.trackAthlevoEvent(name, props);
    }
  } catch (e) {}
}

async function resolveCoachAccessState() {
  if (!window.AthlevoAccessGuard) return "unknown";
  var cached = typeof AthlevoAccessGuard.cachedAccessState === "function"
    ? AthlevoAccessGuard.cachedAccessState()
    : "unknown";
  if (cached !== "unknown") return cached;
  if (typeof toast === "function") toast("Checking your Athlevo access…");
  if (typeof AthlevoAccessGuard.accessState !== "function") return "unknown";
  var resolved = await AthlevoAccessGuard.accessState();
  return resolved === "free" ||
    resolved === "paid_active" ||
    resolved === "paid_inactive"
    ? resolved
    : "unknown";
}

function classifyCoachFailure(code, status) {
  var value = String(code || "");
  var map = {
    COACH_WEEKLY_LIMIT_REACHED: {
      category: "weekly_limit", upgrade: true,
      message: "You’ve used your 3 free Coach messages for this week."
    },
    PERFORMANCE_REQUIRED: {
      category: "premium_required", upgrade: true,
      message: "This coaching feature requires Athlevo Performance."
    },
    AUTH_REQUIRED: {
      category: "auth", retryable: false,
      message: "Please sign in again."
    },
    RATE_LIMITED: {
      category: "rate_limit",
      message: "Coach has received too many requests. Try again shortly."
    },
    COACH_TIMEOUT: {
      category: "timeout",
      message: "Athlevo Coach is taking too long to respond. Try again."
    },
    COACH_PROVIDER_UNAVAILABLE: {
      category: "provider_unavailable",
      message: "Coach is temporarily unavailable."
    },
    INVALID_COACH_MESSAGE: {
      category: "invalid_input", retryable: false,
      message: "Ask a more specific training question."
    },
    COACH_CONTEXT_UNAVAILABLE: {
      category: "context_unavailable", retryable: false,
      message: "Coach needs your athlete profile before answering."
    },
    ACCESS_UNAVAILABLE: {
      category: "access_unavailable",
      message: "We couldn't verify your access. Try again."
    },
    COACH_REQUEST_FAILED: {
      category: "server",
      message: "Coach couldn't complete that request. Try again."
    }
  };
  if (map[value]) return map[value];
  if (status === 401) return map.AUTH_REQUIRED;
  if (status === 429) return map.RATE_LIMITED;
  if (status >= 500) return map.COACH_REQUEST_FAILED;
  return {
    category: "network",
    message: "Coach couldn't complete that request. Try again."
  };
}

function restoreCoachDraft(question, userMessage, loadingMessage) {
  if (userMessage && typeof userMessage.remove === "function") {
    userMessage.remove();
  }
  if (loadingMessage && typeof loadingMessage.remove === "function") {
    loadingMessage.remove();
  }
  var input = document.getElementById("chatInput");
  if (input && !input.value.trim()) {
    input.value = question;
    if (input.tagName === "TEXTAREA") autoGrowComposer();
  }
}

function showCoachLimitUpgrade(accessTier) {
  if (!window.AthlevoAccessGuard ||
      typeof AthlevoAccessGuard.showUpgradeSheet !== "function") {
    return false;
  }
  AthlevoAccessGuard.showUpgradeSheet("coach_message", "coach", {
    title: "Keep coaching with Athlevo Performance",
    body: "You’ve used your 3 free Coach messages for this week. Upgrade for unlimited questions, deeper training analysis, and ongoing coaching guidance.",
    primary: "Upgrade to Performance",
    secondary: "Not now",
    hideBenefits: true
  });
  trackCoachEvent("coach_upgrade_sheet_viewed", accessTier);
  return true;
}

function renderCoachError(container, question, failure) {
  if (!container) return;
  container.innerHTML = "";
  container.classList.add("coach-rich-response");

  var wrap = document.createElement("div");
  wrap.className = "coach-error";
  wrap.setAttribute("role", "alert");

  var msg = document.createElement("p");
  msg.className = "coach-error-msg";
  msg.textContent = failure?.message ||
    "Coach couldn't complete that request. Try again.";
  wrap.appendChild(msg);

  if (failure?.retryable === false) {
    container.appendChild(wrap);
    return;
  }

  var retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "coach-error-retry";
  retryBtn.textContent = "Try again";
  retryBtn.addEventListener("click", function () {
    if (_coachRetryInFlight || coachRequestInFlight) return;
    _coachRetryInFlight = true;
    retryBtn.disabled = true;
    retryBtn.textContent = "Retrying…";
    // Remove the error bubble entirely, then replay.
    var msgEl = container.closest(".msg");
    if (msgEl) msgEl.remove();
    askCoach(question);
    _coachRetryInFlight = false;
  });
  wrap.appendChild(retryBtn);

  container.appendChild(wrap);
}

/* Flip the send button into its "is-sending" state so the athlete gets
 * instant visual confirmation the tap registered — even before any of the
 * network work starts. Safe to call when the button isn't on screen. */
function setCoachSendingState(isSending) {
  const sendBtn = document.querySelector(".coach-composer .send");
  if (sendBtn) {
    sendBtn.classList.toggle("is-sending", !!isSending);
    sendBtn.disabled = !!isSending;
    sendBtn.setAttribute("aria-busy", isSending ? "true" : "false");
  }

  if (isSending && typeof document.getElementById === "function") {
    const chips = document.getElementById("chips");
    if (chips) {
      chips.innerHTML = "";
      chips.dataset.hasSuggestions = "false";
    }
  }
  if (typeof document.getElementById === "function") syncCoachScrollUi();
}

async function askCoach(question) {
  const cleanQuestion = question?.trim();

  if (!cleanQuestion) return;

  // Prevent duplicate submissions (double-tap / repeated Enter) from
  // creating duplicate stored messages.
  if (!claimCoachRequest()) return;
  _coachLastQuestion = cleanQuestion;
  setCoachSendingState(true);
  var coachAccessTier = "unknown";
  var userMessage = null;
  var loadingMessage = null;

  // Do not classify unresolved entitlement as Free. Keep the duplicate-submit
  // guard active while the verified subscription state loads.
  try {
    coachAccessTier = await resolveCoachAccessState();
  } catch (error) {
    coachAccessTier = "unknown";
  }
  if (coachAccessTier === "unknown") {
    trackCoachEvent(
      "coach_request_failed",
      "unknown",
      "access_unavailable"
    );
    if (typeof toast === "function") {
      toast("We couldn't verify your access. Try again.");
    }
    coachRequestInFlight = false;
    setCoachSendingState(false);
    return;
  }

  // Analytics is categorical only. The question is never included.
  trackCoachEvent("coach_message_submitted", coachAccessTier);

  // The composer is cleared only after entitlement resolves. A blocked limit
  // response restores this exact draft without creating a duplicate message.
  var composerInput = document.getElementById("chatInput");
  if (composerInput && composerInput.value.trim() === cleanQuestion) {
    composerInput.value = "";
    if (composerInput.tagName === "TEXTAREA") composerInput.style.height = "auto";
  }

  // ──────────────────────────────────────────────────────────────────
  // INSTANT FEEDBACK PHASE
  // Everything the user needs to see immediately happens synchronously,
  // in this order, before any await hits the event loop:
  //   1. their own message appears
  //   2. the open "coach is thinking" status appears
  //   3. the send button flips to its sending state
  // ──────────────────────────────────────────────────────────────────
  userMessage = addChatMessage("user", cleanQuestion);

  // Quiet thinking indicator — small Athlevo mark with a breathing pulse
  // and a rotating contextual label. Replaces the bouncing dots.
  loadingMessage = addChatMessage("ai", "");
  {
    const changeEl = loadingMessage && loadingMessage.querySelector(".change");
    if (changeEl) {
      const thinkingEl = createCoachThinkingEl();
      changeEl.innerHTML = "";
      changeEl.appendChild(thinkingEl);
      const labelEl = thinkingEl.querySelector(".coach-thinking-label");
      startThinkingLabelRotation(labelEl);
    }
  }

  try {
    // Memory extraction MUST stay awaited because loadAthleteMemory()
    // below reads what this call writes — firing-and-forgetting would
    // race the two and change the coach's context. But it now runs
    // AFTER the typing indicator is on screen, so the athlete never
    // stares at a blank composer during it.
    await extractAthleteMemoryFromMessage(cleanQuestion);

    const profile =
  await AthlevoBrain.loadAthleteProfile();

if (!profile) {
  var profileError = new Error("Coach needs your athlete profile before answering.");
  profileError.coachCode = "COACH_CONTEXT_UNAVAILABLE";
  throw profileError;
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
  var contextError = new Error("Coach needs your athlete profile before answering.");
  contextError.coachCode = "COACH_CONTEXT_UNAVAILABLE";
  throw contextError;
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
      var authError = new Error("Please sign in again.");
      authError.coachCode = "AUTH_REQUIRED";
      throw authError;
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

    let data;
    try {
      data = await response.json();
    } catch (error) {
      var responseParseError = new Error(
        "Coach couldn't complete that request. Try again."
      );
      responseParseError.coachCode = "COACH_REQUEST_FAILED";
      responseParseError.coachStatus = response.status || 500;
      throw responseParseError;
    }

    if (!response.ok) {
      const failure = classifyCoachFailure(data.code, response.status);
      if (failure.upgrade === true) {
        stopThinkingLabelRotation();
        restoreCoachDraft(cleanQuestion, userMessage, loadingMessage);
        if (failure.category === "weekly_limit") {
          trackCoachEvent(
            "coach_weekly_limit_reached",
            coachAccessTier
          );
        }
        showCoachLimitUpgrade(coachAccessTier);
        return;
      }
      var responseError = new Error(failure.message);
      responseError.coachCode = data.code || "COACH_REQUEST_FAILED";
      responseError.coachStatus = response.status;
      throw responseError;
    }

    if (!data.answer || typeof data.answer !== "object") {
      var malformedError = new Error("Coach couldn't complete that request. Try again.");
      malformedError.coachCode = "COACH_REQUEST_FAILED";
      malformedError.coachStatus = 500;
      throw malformedError;
    }
    const answer = data.answer;

// Attach the truthful Coach Context summary so it renders above the
// reply and persists with the saved conversation history.
answer.coach_context = buildCoachContextSummary(context);

stopThinkingLabelRotation();

const responseContainer =
  loadingMessage.querySelector(".change");

const wasAtLatestBeforeResponse = coachIsNearBottom();

renderCoachResponse(
  responseContainer,
  answer
);

// Follow-up actions (contextual chips in the active tools slot above composer).
// Model-suggested replies take priority; fall back to built-in actions.
if (Array.isArray(answer.suggested_replies) && answer.suggested_replies.length > 0) {
  renderSuggestedReplies(answer.suggested_replies);
} else {
  renderFollowUpActions(answer);
}

// Analytics: successful response.
try { if (window.AthlevoAnalytics) AthlevoAnalytics.track("first_coach_message_sent"); } catch (e) {}
trackCoachEvent("coach_message_completed", coachAccessTier);

// Smart-scroll after response renders.
coachSmartScroll(wasAtLatestBeforeResponse);

// Only persist a genuine, successful reply. A missing data.answer means
// the model call did not produce a real structured response, so we show
// the fallback but do NOT store it as a successful coaching message.
if (data.answer) {
  await saveConversationMessage("user", cleanQuestion);
  await saveConversationMessage(
    "assistant",
    JSON.stringify(answer)
  );
}
  } catch (error) {
    console.error("Athlevo Coach request failed.");
    stopThinkingLabelRotation();

    const failure = classifyCoachFailure(
      error?.coachCode,
      error?.coachStatus || 0
    );
    trackCoachEvent(
      "coach_request_failed",
      coachAccessTier,
      failure.category
    );

    // Inline error with retry button (preserves the user's message above).
    const errorContainer = loadingMessage.querySelector(".change");
    renderCoachError(errorContainer, cleanQuestion, failure);
  } finally {
    coachRequestInFlight = false;
    setCoachSendingState(false);
    // Keep the composer ready for the next question. Refocus is safe on
    // desktop; on iOS Safari the keyboard only reopens if the user was
    // already interacting with the input (a documented, intentional gate).
    const input = document.getElementById("chatInput");
    if (input && document.activeElement !== input) {
      // Do not steal focus from a user who has tapped elsewhere.
      const composerHasFocus = document.activeElement &&
        document.activeElement.closest &&
        document.activeElement.closest(".coach-composer");
      if (composerHasFocus) input.focus();
    }
  }
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

  // Second line of defence against double submissions.
  if (coachRequestInFlight) return;

  const question = input.value.trim();

  if (!question) return;

  // askCoach clears the composer only after entitlement resolves, so a
  // loading/error state cannot erase the athlete's draft.
  askCoach(question);
}

/* Bind Enter-to-send, Shift+Enter for newline, and auto-grow on the
 * composer textarea. Also wires up the empty-state starter prompts. */
function bindCoachComposer() {
  const input = document.getElementById("chatInput");
  if (!input || input.dataset.coachBound === "true") return;
  input.dataset.coachBound = "true";

  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMsg();
    }
  });

  // Auto-grow for textarea.
  if (input.tagName === "TEXTAREA") {
    input.addEventListener("input", autoGrowComposer);
  }

  // Wire up starter prompts, personalize greeting, start scroll watcher.
  bindCoachStarters();
  personalizeCoachGreeting();
  bindCoachScrollWatcher();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindCoachComposer);
  } else {
    bindCoachComposer();
  }
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
window.personalizeCoachGreeting = personalizeCoachGreeting;
window.hideCoachEmptyState = hideCoachEmptyState;
window.showCoachEmptyState = showCoachEmptyState;
window.renderFollowUpActions = renderFollowUpActions;
window.coachSmartScroll = coachSmartScroll;
window.syncCoachScrollUi = syncCoachScrollUi;
