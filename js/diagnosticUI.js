/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Diagnostic Chat UI  (Messenger-style conversation)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Renders the pre-signup diagnostic as a real chat interface.
 *  Athlevo messages appear left-aligned; user answers right-aligned.
 *  Quick-reply chips + a persistent text composer at the bottom.
 *  Compound questions are split into sequential sub-steps.
 *
 *  REUSES: diagnostic engine (diagnostic.js) unchanged.
 *  DOES NOT TOUCH: Authentication, Supabase, subscriptions, onboarding,
 *  existing navigation, payment config, or entitlement logic.
 */

(function (root) {
"use strict";

/* ═══════════════════════════ CONSTANTS ═══════════════════════════════ */

var MSG_DELAY = 250;        // ms between sequential Athlevo messages
var TYPING_DELAY = 400;     // ms for typing indicator before message
var SCROLL_DELAY = 60;

/* ─── Text-input mapping tables ─── */
var GOAL_ALIASES = {
  "5k": "5K", "5km": "5K", "five k": "5K",
  "10k": "10K", "10km": "10K", "ten k": "10K",
  "half": "Half marathon", "half marathon": "Half marathon", "21k": "Half marathon", "21km": "Half marathon", "21.1k": "Half marathon", "hm": "Half marathon",
  "marathon": "Marathon", "42k": "Marathon", "42km": "Marathon", "42.2k": "Marathon", "42.2km": "Marathon", "full marathon": "Marathon", "full": "Marathon", "fm": "Marathon",
  "ultra": "Ultra", "ultramarathon": "Ultra", "ultra marathon": "Ultra", "50k": "Ultra", "100k": "Ultra", "50km": "Ultra", "100km": "Ultra",
  "general fitness": "General fitness", "fitness": "General fitness", "general": "General fitness", "just fitness": "General fitness", "no race": "General fitness"
};

var EXPERIENCE_ALIASES = {
  "new": "new", "beginner": "new", "just started": "new", "brand new": "new", "newbie": "new",
  "1 year": "1_2_years", "2 years": "1_2_years", "1-2 years": "1_2_years", "a year": "1_2_years", "couple years": "1_2_years",
  "3 years": "3_5_years", "4 years": "3_5_years", "5 years": "3_5_years", "3-5 years": "3_5_years", "few years": "3_5_years", "several years": "3_5_years",
  "5+ years": "5_plus", "many years": "5_plus", "long time": "5_plus", "10 years": "5_plus", "over 5": "5_plus", "decades": "5_plus"
};

var TRAINING_STATUS_ALIASES = {
  "starting": "starting", "just starting": "starting", "beginning": "starting",
  "building base": "building_base", "base building": "building_base", "building": "building_base",
  "training block": "training_block", "in a block": "training_block", "structured": "training_block",
  "coming back": "returning", "returning": "returning", "back from break": "returning", "break": "returning",
  "maintaining": "maintaining", "maintenance": "maintaining"
};

var NUMERIC_ALIASES = {
  "sub 4": "sub-4:00", "sub 3": "sub-3:00", "sub 5": "sub-5:00",
  "sub 2": "sub-2:00", "sub 1:30": "sub-1:30", "sub 1:45": "sub-1:45",
  "sub 1:50": "sub-1:50", "sub 1:40": "sub-1:40"
};

/* ═══════════════════════════ STATE ═══════════════════════════════════ */

var engine = null;
var mode = "question";   // "question" | "result"
var busy = false;
var currentQuestion = null;
var currentFieldData = {};
var currentSubStep = 0;       // for compound questions split across sub-steps
var subStepFields = [];       // array of field arrays for the current question
var interpretationCache = {};
var resultTrackedFor = null;

/* ═══════════════════════════ HELPERS ════════════════════════════════ */

function esc(s) {
  if (s == null) return "";
  var d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function reducedMotion() {
  return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canAnimate(el) {
  return !reducedMotion() && el && typeof el.animate === "function";
}

function delay(ms) {
  if (reducedMotion()) ms = Math.min(ms, 50);
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* ═══════════════════════════ DOM REFS ══════════════════════════════ */

function getBody() { return document.getElementById("diagBody"); }
function getThread() {
  var body = getBody();
  if (!body) return null;
  return body.querySelector(".chat-thread") || null;
}
function getComposer() { return document.getElementById("chatComposer"); }
function getComposerInput() { return document.getElementById("chatInput"); }
function getQuickReplies() { return document.getElementById("chatQuickReplies"); }

function createEl(html) {
  var tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/* ═══════════════════════════ SCREEN SETUP ═══════════════════════════ */

function startDiagnostic() {
  var pending = root.AthlevoDiagnostic && root.AthlevoDiagnostic.load();
  if (pending && !pending.completed) {
    engine = pending;
  } else if (pending && pending.completed) {
    engine = pending;
    showScreen("screen-diagnostic");
    buildChatShell();
    renderResult();
    trackEvent("diagnostic_resumed", { state: "completed" });
    return;
  } else {
    engine = root.AthlevoDiagnostic.create();
  }

  showScreen("screen-diagnostic");
  interpretationCache = {};
  buildChatShell();

  if (!engine.begun) {
    engine.begin();
    trackEvent("diagnostic_viewed", {});
    trackEvent("diagnostic_started", {});
    renderConversationOpening();
  } else {
    trackEvent("diagnostic_resumed", { state: "in_progress" });
    rebuildConversation(engine.nextQuestion());
  }
}

function showScreen(id) {
  if (root.showScreen) {
    root.showScreen(id);
  } else {
    document.querySelectorAll(".screen").forEach(function (s) {
      s.classList.remove("active");
    });
    var el = document.getElementById(id);
    if (el) el.classList.add("active");
  }
  var tb = document.getElementById("tabbar");
  if (tb) tb.style.display = "none";
}

/* ═══════════════════════════ CHAT SHELL ════════════════════════════ */

/**
 * Replace the diagnostic body + foot with the chat layout:
 *   - compact top header (avatar + name + role)
 *   - scrollable chat thread area
 *   - quick-reply bar
 *   - persistent composer
 */
function buildChatShell() {
  var body = getBody();
  if (!body) return;

  // Hide old footer — we replace it with the composer
  var foot = document.getElementById("diagFoot");
  if (foot) foot.style.display = "none";

  body.innerHTML = "";
  body.className = "chat-body";

  // Chat header
  var header = createEl(
    '<div class="chat-header">' +
      '<img class="chat-avatar" src="/assets/pwa/icon-192.png" alt="Athlevo" width="36" height="36">' +
      '<div class="chat-header-text">' +
        '<span class="chat-header-name">Athlevo</span>' +
        '<span class="chat-header-role">AI Running Coach</span>' +
      '</div>' +
    '</div>'
  );
  body.appendChild(header);

  // Chat thread (scrollable)
  var thread = document.createElement("div");
  thread.className = "chat-thread";
  thread.id = "chatThread";
  body.appendChild(thread);

  // Quick replies container (above composer)
  var qr = document.createElement("div");
  qr.className = "chat-quick-replies";
  qr.id = "chatQuickReplies";
  body.appendChild(qr);

  // Composer
  var composer = createEl(
    '<div class="chat-composer" id="chatComposer">' +
      '<input type="text" class="chat-composer-input" id="chatInput" ' +
        'placeholder="Type your answer here…" autocomplete="off" autocapitalize="sentences" enterkeyhint="send">' +
      '<button class="chat-composer-send" id="chatSend" type="button" aria-label="Send">' +
        '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 10L17 10M17 10L11 4M17 10L11 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button>' +
    '</div>'
  );
  body.appendChild(composer);

  wireComposer();
}

function wireComposer() {
  var input = getComposerInput();
  var send = document.getElementById("chatSend");
  if (!input || !send) return;

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleComposerSend();
    }
  });
  send.addEventListener("click", function () {
    handleComposerSend();
  });
}

/* ═══════════════════════════ MESSAGE RENDERING ═════════════════════ */

function appendAthlevoMsg(thread, text, skipAnim) {
  var el = createEl(
    '<div class="chat-msg chat-msg-athlevo">' +
      '<div class="chat-bubble chat-bubble-athlevo">' + esc(text) + '</div>' +
    '</div>'
  );
  thread.appendChild(el);
  if (!skipAnim) animateIn(el);
  return el;
}

function appendAthlevoMsgHTML(thread, html, skipAnim) {
  var el = createEl(
    '<div class="chat-msg chat-msg-athlevo">' +
      '<div class="chat-bubble chat-bubble-athlevo">' + html + '</div>' +
    '</div>'
  );
  thread.appendChild(el);
  if (!skipAnim) animateIn(el);
  return el;
}

function appendUserMsg(thread, text, skipAnim) {
  var el = createEl(
    '<div class="chat-msg chat-msg-user">' +
      '<div class="chat-bubble chat-bubble-user">' + esc(text) + '</div>' +
    '</div>'
  );
  thread.appendChild(el);
  if (!skipAnim) animateIn(el);
  return el;
}

function appendTypingIndicator(thread) {
  var el = createEl(
    '<div class="chat-msg chat-msg-athlevo chat-typing" id="chatTyping">' +
      '<div class="chat-bubble chat-bubble-athlevo">' +
        '<span class="chat-typing-dot"></span>' +
        '<span class="chat-typing-dot"></span>' +
        '<span class="chat-typing-dot"></span>' +
      '</div>' +
    '</div>'
  );
  thread.appendChild(el);
  animateIn(el);
  return el;
}

function removeTypingIndicator() {
  var el = document.getElementById("chatTyping");
  if (el) el.remove();
}

function animateIn(el) {
  if (!canAnimate(el)) return;
  el.animate(
    [{ opacity: 0, transform: "translateY(8px)" },
     { opacity: 1, transform: "translateY(0)" }],
    { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)", fill: "both" }
  );
}

function scrollToBottom() {
  var thread = getThread();
  if (!thread) return;
  var d = reducedMotion() ? 0 : SCROLL_DELAY;
  setTimeout(function () {
    thread.scrollTo({ top: thread.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }, d);
}

/* ═══════════════════════════ QUICK REPLIES ═════════════════════════ */

function showQuickReplies(options, onSelect) {
  var container = getQuickReplies();
  if (!container) return;
  container.innerHTML = "";

  for (var i = 0; i < options.length; i++) {
    (function (opt) {
      var btn = createEl(
        '<button class="chat-qr-chip" type="button">' + esc(opt.label) + '</button>'
      );
      btn.addEventListener("click", function () {
        onSelect(opt);
      });
      container.appendChild(btn);
    })(options[i]);
  }

  container.style.display = "";
  if (canAnimate(container)) {
    container.animate(
      [{ opacity: 0, transform: "translateY(6px)" },
       { opacity: 1, transform: "translateY(0)" }],
      { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)", fill: "both" }
    );
  }
}

function hideQuickReplies() {
  var container = getQuickReplies();
  if (container) {
    container.innerHTML = "";
    container.style.display = "none";
  }
}

/* ═══════════════════════════ COMPOSER CONTROL ══════════════════════ */

function showComposer(placeholder) {
  var composer = getComposer();
  var input = getComposerInput();
  if (composer) composer.style.display = "";
  if (input) {
    input.placeholder = "Type your answer here…";
    input.value = "";
    input.disabled = false;
  }
}

function hideComposer() {
  var composer = getComposer();
  if (composer) composer.style.display = "none";
}

function setComposerMode(type) {
  var input = getComposerInput();
  if (!input) return;
  // Always keep as text input — dates are typed naturally
  input.type = "text";
  input.inputMode = "";
  if (type === "number") {
    input.inputMode = "decimal";
  }
}

/* ═══════════════════════════ COMPOUND QUESTION SPLITTING ═══════════ */

/**
 * Split a compound question's fields into sequential sub-steps.
 * Each sub-step gets its own Athlevo message + quick replies or input.
 * Fields with showWhen are grouped with their triggering field.
 */
function splitIntoSubSteps(q) {
  var steps = [];
  var used = {};

  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (used[f.id]) continue;

    // Collect this field + any dependent showWhen fields
    var group = [f];
    used[f.id] = true;

    for (var j = i + 1; j < q.fields.length; j++) {
      var dep = q.fields[j];
      if (dep.showWhen && dep.showWhen[f.id] !== undefined) {
        group.push(dep);
        used[dep.id] = true;
      }
    }

    steps.push(group);
  }

  return steps;
}

/**
 * Get the conversational prompt for a sub-step field.
 * Uses the field label or generates natural language.
 */
function getSubStepPrompt(q, fieldGroup, stepIndex, totalSteps) {
  var f = fieldGroup[0];

  // Custom prompts for known compound questions
  if (q.key === "race_details") {
    if (f.id === "goal_race") return "Do you already have a race booked?";
    if (f.id === "goal_race_date") return "And when is it?";
    if (f.id === "goal_time") return "Any specific finish time you’re aiming for?";
  }
  if (q.key === "weekly_volume") {
    if (f.id === "weekly_mileage") return "How many kilometres are you running per week right now?";
    if (f.id === "weekly_hours") return "And roughly how many hours per week is that?";
  }
  if (q.key === "current_capacity") {
    if (f.id === "recent_consistency") return "How consistent has your running been over the last 6–8 weeks?";
    if (f.id === "recent_longest_run_km") return "What’s the longest run you’ve done recently?";
  }
  if (q.key === "recent_performance") {
    if (f.id === "recent_race_dist") return "Do you have a recent race result I can use as a benchmark?";
    if (f.id === "recent_race_time") return "What was your finish time?";
  }
  if (q.key === "injury_status") {
    if (f.id === "injury_has") return q.title;
    if (f.id === "injury_area") return "Where is it?";
  }
  if (q.key === "schedule") {
    if (f.id === "train_time") return "When do you usually train?";
    if (f.id === "schedule_constraints") return "Any scheduling constraints I should know about? Shift work, travel, childcare…";
  }
  if (q.key === "training_structure") {
    if (f.id === "training_structure") return q.title;
    if (f.id === "training_structure_other") return "Tell me a bit about your typical week.";
  }

  // For single-field questions, use the question title
  if (totalSteps === 1) return q.title;

  // Fallback: use field label
  return f.label || q.title;
}

/* ═══════════════════════════ CONVERSATION OPENING ══════════════════ */

async function renderConversationOpening() {
  mode = "question";
  currentQuestion = null;
  var thread = getThread();
  if (!thread) return;

  // Show Athlevo greeting
  await showTypingThenMessage(thread, "Hi! I’m Athlevo, your endurance coach.");
  await delay(MSG_DELAY);
  await showTypingThenMessage(thread, "What are you working toward?");

  // Show first question
  var q = engine.nextQuestion();
  if (q) {
    presentQuestion(q);
  }

  updateProgress();
}

async function showTypingThenMessage(thread, text) {
  appendTypingIndicator(thread);
  scrollToBottom();
  await delay(TYPING_DELAY);
  removeTypingIndicator();
  appendAthlevoMsg(thread, text);
  scrollToBottom();
}

async function showTypingThenMessageHTML(thread, html) {
  appendTypingIndicator(thread);
  scrollToBottom();
  await delay(TYPING_DELAY);
  removeTypingIndicator();
  appendAthlevoMsgHTML(thread, html);
  scrollToBottom();
}

/* ═══════════════════════════ QUESTION PRESENTATION ═════════════════ */

/**
 * Present a question: split it into sub-steps, show the first sub-step.
 */
function presentQuestion(q) {
  currentQuestion = q;
  currentFieldData = {};
  currentSubStep = 0;

  // Pre-fill if revisiting
  if (engine.history.indexOf(q.key) >= 0) {
    prefillFromAnswers(q);
  }

  // Split into sub-steps
  subStepFields = splitIntoSubSteps(q);

  // For single-field questions, use the question title already shown (if it was the opening)
  // For multi-field, we need to show the first sub-step prompt
  if (subStepFields.length === 1) {
    // Single-field question — show quick replies + composer for this field
    presentSubStep(0, false);
  } else {
    // Multi-field compound — show first sub-step
    presentSubStep(0, false);
  }
}

/**
 * Present a single sub-step: show its prompt (unless skipPrompt),
 * then quick replies and/or composer.
 */
async function presentSubStep(index, showPrompt) {
  if (index >= subStepFields.length) {
    // All sub-steps done — submit the compound answer
    submitCurrentQuestion();
    return;
  }

  currentSubStep = index;
  var fieldGroup = subStepFields[index];
  var f = fieldGroup[0]; // primary field

  if (showPrompt) {
    var prompt = getSubStepPrompt(currentQuestion, fieldGroup, index, subStepFields.length);
    var thread = getThread();
    if (thread) {
      await showTypingThenMessage(thread, prompt);
    }
  }

  // Determine input mode
  if (f.type === "chips" || f.type === "multichips") {
    // Show quick-reply chips
    showQuickReplies(f.options, function (opt) {
      handleChipSelect(f, opt, fieldGroup);
    });
    // Also show composer for free-text
    showComposer("Or type your answer…");
    setComposerMode("text");
  } else if (f.type === "number") {
    hideQuickReplies();
    showComposer(f.placeholder || ("e.g. " + (f.min || "0")));
    setComposerMode("number");
  } else if (f.type === "date") {
    hideQuickReplies();
    showComposer("");
    setComposerMode("date");
  } else if (f.type === "text") {
    hideQuickReplies();
    showComposer(f.placeholder || "Type here…");
    setComposerMode("text");
  }

  // Special case: race_details first field — show Yes/Not yet chips instead
  if (currentQuestion.key === "race_details" && f.id === "goal_race") {
    showQuickReplies([
      { label: "Yes", value: "__race_yes" },
      { label: "Not yet", value: "__race_no" }
    ], function (opt) {
      handleRaceGateSelect(opt);
    });
    showComposer("Or type the race name…");
    setComposerMode("text");
  }

  // For optional fields, show a skip option
  if (f.optional && f.type !== "chips") {
    var qr = getQuickReplies();
    if (qr) {
      var skipBtn = createEl('<button class="chat-qr-chip chat-qr-skip" type="button">Skip</button>');
      skipBtn.addEventListener("click", function () {
        handleSkip(f);
      });
      qr.appendChild(skipBtn);
      qr.style.display = "";
    }
  }

  scrollToBottom();
  updateProgress();
}

/* ═══════════════════════════ INPUT HANDLING ════════════════════════ */

/**
 * Handle chip/quick-reply selection.
 */
function handleChipSelect(field, opt, fieldGroup) {
  if (busy) return;
  busy = true;

  var thread = getThread();

  if (field.type === "multichips") {
    // Multi-select: toggle
    var cur = Array.isArray(currentFieldData[field.id]) ? currentFieldData[field.id].slice() : [];
    if (opt.exclusive) {
      currentFieldData[field.id] = cur.indexOf(opt.value) >= 0 ? [] : [opt.value];
    } else {
      var filtered = cur.filter(function (v) { return v !== "none"; });
      if (filtered.indexOf(opt.value) >= 0) {
        currentFieldData[field.id] = filtered.filter(function (v) { return v !== opt.value; });
      } else {
        currentFieldData[field.id] = filtered.concat(opt.value);
      }
    }
    // Re-render chips with selection state
    showMultiChipsWithState(field);
    busy = false;
    return;
  }

  // Single select
  currentFieldData[field.id] = opt.value;
  hideQuickReplies();

  // Show user bubble
  if (thread) appendUserMsg(thread, opt.label);
  scrollToBottom();

  // Check for dependent showWhen fields
  var dependents = fieldGroup.slice(1);
  var activeDependents = dependents.filter(function (dep) {
    if (!dep.showWhen) return true;
    return checkShowWhen(dep.showWhen);
  });

  if (activeDependents.length > 0) {
    // Show dependent field as next sub-sub-step
    busy = false;
    presentDependentField(activeDependents[0]);
    return;
  }

  // Auto-advance if single-field question or compound is complete
  advanceAfterChip();
}

function showMultiChipsWithState(field) {
  var cur = Array.isArray(currentFieldData[field.id]) ? currentFieldData[field.id] : [];
  var container = getQuickReplies();
  if (!container) return;
  container.innerHTML = "";

  for (var i = 0; i < field.options.length; i++) {
    (function (opt) {
      var sel = cur.indexOf(opt.value) >= 0;
      var btn = createEl(
        '<button class="chat-qr-chip' + (sel ? " chat-qr-sel" : "") + '" type="button">' + esc(opt.label) + '</button>'
      );
      btn.addEventListener("click", function () {
        handleChipSelect(field, opt, [field]);
      });
      container.appendChild(btn);
    })(field.options[i]);
  }

  // Add Done button for multi-select
  var doneBtn = createEl('<button class="chat-qr-chip chat-qr-done" type="button">Done</button>');
  doneBtn.addEventListener("click", function () {
    if (busy) return;
    busy = true;
    var labels = [];
    for (var j = 0; j < field.options.length; j++) {
      if (cur.indexOf(field.options[j].value) >= 0) labels.push(field.options[j].label);
    }
    var thread = getThread();
    if (thread) appendUserMsg(thread, labels.join(", ") || "None");
    hideQuickReplies();
    scrollToBottom();
    advanceAfterChip();
  });
  container.appendChild(doneBtn);
  container.style.display = "";
}

function presentDependentField(dep) {
  var thread = getThread();
  (async function () {
    if (thread) {
      var label = dep.label || "Tell me more";
      await showTypingThenMessage(thread, label);
    }
    if (dep.type === "text") {
      hideQuickReplies();
      showComposer(dep.placeholder || "Type here…");
      setComposerMode("text");
    } else if (dep.type === "number") {
      hideQuickReplies();
      showComposer(dep.placeholder || "Enter a number");
      setComposerMode("number");
    }
    scrollToBottom();
  })();
}

function handleRaceGateSelect(opt) {
  if (busy) return;
  busy = true;
  var thread = getThread();

  hideQuickReplies();
  if (thread) appendUserMsg(thread, opt.label);
  scrollToBottom();

  if (opt.value === "__race_no") {
    // Skip all race_details fields — submit empty
    currentFieldData.goal_race = "";
    currentFieldData.goal_race_date = "";
    currentFieldData.goal_time = "";
    busy = false;
    submitCurrentQuestion();
    return;
  }

  // "Yes" — ask for race name
  busy = false;
  (async function () {
    var thread2 = getThread();
    if (thread2) {
      await showTypingThenMessage(thread2, "Nice. What race are you doing?");
    }
    hideQuickReplies();
    showComposer("e.g. Cebu Marathon");
    setComposerMode("text");
    // Mark that we're collecting race name
    currentSubStep = 0.5; // special marker
    scrollToBottom();
  })();
}

function handleSkip(field) {
  if (busy) return;
  busy = true;

  currentFieldData[field.id] = "";
  var thread = getThread();
  if (thread) appendUserMsg(thread, "Skip");
  hideQuickReplies();
  scrollToBottom();

  advanceAfterChip();
}

/**
 * Handle composer text submission.
 */
function handleComposerSend() {
  if (busy) return;
  var input = getComposerInput();
  if (!input) return;

  var val = input.value.trim();
  if (!val) return;

  busy = true;
  input.value = "";

  var thread = getThread();
  var q = currentQuestion;

  // Special case: race_details gate — collecting race name
  if (q && q.key === "race_details" && currentSubStep === 0.5) {
    currentFieldData.goal_race = val;
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    busy = false;
    // Now ask for date
    (async function () {
      await showTypingThenMessage(getThread(), "And when is it?");
      hideQuickReplies();
      // Show skip option for date
      var qr = getQuickReplies();
      if (qr) {
        var skipBtn = createEl('<button class="chat-qr-chip chat-qr-skip" type="button">Skip</button>');
        skipBtn.addEventListener("click", function () {
          if (busy) return;
          busy = true;
          currentFieldData.goal_race_date = "";
          if (getThread()) appendUserMsg(getThread(), "Skip");
          hideQuickReplies();
          scrollToBottom();
          // Move to goal time
          busy = false;
          askGoalTime();
        });
        qr.appendChild(skipBtn);
        qr.style.display = "";
      }
      showComposer("");
      setComposerMode("date");
      currentSubStep = 0.6;
      scrollToBottom();
    })();
    return;
  }

  // Race date
  if (q && q.key === "race_details" && currentSubStep === 0.6) {
    var parsedDate = parseNaturalDate(val);
    currentFieldData.goal_race_date = parsedDate;
    if (thread) appendUserMsg(thread, formatDate(parsedDate));
    hideQuickReplies();
    scrollToBottom();
    busy = false;
    askGoalTime();
    return;
  }

  // Goal time
  if (q && q.key === "race_details" && currentSubStep === 0.7) {
    var mapped = NUMERIC_ALIASES[val.toLowerCase()] || val;
    currentFieldData.goal_time = mapped;
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    busy = false;
    submitCurrentQuestion();
    return;
  }

  if (!q) { busy = false; return; }

  // Determine which field we're filling
  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  if (!fieldGroup) { busy = false; return; }
  var field = fieldGroup[0];

  // Try to map typed text to a chip value
  var mapped2 = tryMapTextToValue(q, field, val);
  if (mapped2 !== null) {
    currentFieldData[field.id] = mapped2.value;
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();

    // Check for dependent showWhen fields
    var dependents = fieldGroup.slice(1);
    var activeDependents = dependents.filter(function (dep) {
      if (!dep.showWhen) return true;
      return checkShowWhen(dep.showWhen);
    });
    if (activeDependents.length > 0) {
      busy = false;
      presentDependentField(activeDependents[0]);
      return;
    }
    advanceAfterChip();
    return;
  }

  // For number fields, validate
  if (field.type === "number") {
    var n = parseFloat(val);
    if (!isFinite(n)) {
      showValidationMsg("Please enter a valid number.");
      busy = false;
      return;
    }
    if (field.min != null && n < field.min) {
      showValidationMsg("Should be at least " + field.min + ".");
      busy = false;
      return;
    }
    if (field.max != null && n > field.max) {
      showValidationMsg("Should be " + field.max + " or less.");
      busy = false;
      return;
    }
    currentFieldData[field.id] = val;
    var displayVal = val + (field.unit ? " " + field.unit : "");
    if (thread) appendUserMsg(thread, displayVal);
    hideQuickReplies();
    scrollToBottom();
    advanceAfterChip();
    return;
  }

  // For text fields with maxLength, validate
  if (field.maxLength && val.length > field.maxLength) {
    showValidationMsg("Please keep it under " + field.maxLength + " characters.");
    busy = false;
    return;
  }

  // Accept text
  currentFieldData[field.id] = val;
  if (thread) appendUserMsg(thread, val);
  hideQuickReplies();
  scrollToBottom();
  advanceAfterChip();
}

function askGoalTime() {
  (async function () {
    await showTypingThenMessage(getThread(), "Any specific finish time you’re aiming for?");
    var qr = getQuickReplies();
    if (qr) {
      var skipBtn = createEl('<button class="chat-qr-chip chat-qr-skip" type="button">No specific goal</button>');
      skipBtn.addEventListener("click", function () {
        if (busy) return;
        busy = true;
        currentFieldData.goal_time = "";
        if (getThread()) appendUserMsg(getThread(), "No specific goal");
        hideQuickReplies();
        scrollToBottom();
        busy = false;
        submitCurrentQuestion();
      });
      qr.appendChild(skipBtn);
      qr.style.display = "";
    }
    showComposer("e.g. sub-4:00, 1:45");
    setComposerMode("text");
    currentSubStep = 0.7;
    scrollToBottom();
  })();
}

function showValidationMsg(text) {
  var thread = getThread();
  if (!thread) return;
  var el = createEl(
    '<div class="chat-msg chat-msg-athlevo">' +
      '<div class="chat-bubble chat-bubble-athlevo chat-bubble-error">' + esc(text) + '</div>' +
    '</div>'
  );
  thread.appendChild(el);
  animateIn(el);
  scrollToBottom();
}


/**
 * Try to parse a naturally-typed date string into YYYY-MM-DD.
 * Supports: "September 13", "Sept 13, 2026", "09/13/2026", "2026-09-13", etc.
 * Returns the ISO string or the original text if parsing fails.
 */
function parseNaturalDate(text) {
  if (!text || !text.trim()) return "";
  var t = text.trim();

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // MM/DD/YYYY or MM-DD-YYYY
  var slashMatch = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (slashMatch) {
    var d = new Date(+slashMatch[3], +slashMatch[1] - 1, +slashMatch[2]);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }

  // MM/DD (no year — assume next occurrence)
  var shortSlash = t.match(/^(\d{1,2})[\/-](\d{1,2})$/);
  if (shortSlash) {
    var now = new Date();
    var yr = now.getFullYear();
    var d2 = new Date(yr, +shortSlash[1] - 1, +shortSlash[2]);
    if (d2 < now) d2.setFullYear(yr + 1);
    if (!isNaN(d2.getTime())) return d2.toISOString().split("T")[0];
  }

  // Month name patterns: "September 13", "Sept 13, 2026", "13 September 2026"
  var months = {
    jan:0, january:0, feb:1, february:1, mar:2, march:2, apr:3, april:3,
    may:4, jun:5, june:5, jul:6, july:6, aug:7, august:7,
    sep:8, sept:8, september:8, oct:9, october:9, nov:10, november:10, dec:11, december:11
  };
  var lower = t.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
  // "Month Day Year" or "Month Day"
  var mdy = lower.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (mdy && months[mdy[1]] !== undefined) {
    var now2 = new Date();
    var y = mdy[3] ? +mdy[3] : now2.getFullYear();
    var d3 = new Date(y, months[mdy[1]], +mdy[2]);
    if (!mdy[3] && d3 < now2) d3.setFullYear(y + 1);
    if (!isNaN(d3.getTime())) return d3.toISOString().split("T")[0];
  }
  // "Day Month Year" or "Day Month"
  var dmy = lower.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
  if (dmy && months[dmy[2]] !== undefined) {
    var now3 = new Date();
    var y2 = dmy[3] ? +dmy[3] : now3.getFullYear();
    var d4 = new Date(y2, months[dmy[2]], +dmy[1]);
    if (!dmy[3] && d4 < now3) d4.setFullYear(y2 + 1);
    if (!isNaN(d4.getTime())) return d4.toISOString().split("T")[0];
  }

  // Last resort: try Date.parse
  var parsed = Date.parse(t);
  if (!isNaN(parsed)) {
    return new Date(parsed).toISOString().split("T")[0];
  }

  // Can't parse — return original, engine will deal with it
  return t;
}

function formatDate(dateStr) {
  try {
    var d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch (e) {
    return dateStr;
  }
}

/**
 * Try to map free text to a known chip value.
 */
function tryMapTextToValue(q, field, text) {
  var lower = text.toLowerCase().trim();

  // Check alias tables first
  if (q.key === "goal" && field.id === "goal_distance") {
    if (GOAL_ALIASES[lower]) return { value: GOAL_ALIASES[lower], label: text };
  }
  if (field.id === "experience") {
    if (EXPERIENCE_ALIASES[lower]) return { value: EXPERIENCE_ALIASES[lower], label: text };
  }
  if (field.id === "training_status") {
    if (TRAINING_STATUS_ALIASES[lower]) return { value: TRAINING_STATUS_ALIASES[lower], label: text };
  }

  // Check option values/labels directly
  if (field.options) {
    for (var i = 0; i < field.options.length; i++) {
      var opt = field.options[i];
      if (opt.label.toLowerCase() === lower || String(opt.value).toLowerCase() === lower) {
        return { value: opt.value, label: opt.label };
      }
    }

    // Partial match — only if unambiguous
    var matches = [];
    for (var j = 0; j < field.options.length; j++) {
      var opt2 = field.options[j];
      if (opt2.label.toLowerCase().indexOf(lower) >= 0) {
        matches.push(opt2);
      }
    }
    if (matches.length === 1) {
      return { value: matches[0].value, label: matches[0].label };
    }
  }

  // For chips fields that require a structured value, can't accept arbitrary text
  if ((field.type === "chips" || field.type === "multichips") && field.required) {
    // Show clarification
    var thread = getThread();
    if (thread) {
      var optionLabels = field.options.map(function (o) { return o.label; }).join(", ");
      appendAthlevoMsg(thread, "I didn’t quite catch that. Could you pick one? " + optionLabels);
      scrollToBottom();
    }
    return null;
  }

  // For text/number fields, accept as-is
  if (field.type === "text" || field.type === "number") {
    return { value: text, label: text };
  }

  return null;
}

/* ═══════════════════════════ ADVANCE LOGIC ═════════════════════════ */

function advanceAfterChip() {
  var nextSubStep = Math.floor(currentSubStep) + 1;

  if (nextSubStep < subStepFields.length) {
    // More sub-steps in this compound question
    busy = false;
    (async function () {
      await delay(MSG_DELAY);
      presentSubStep(nextSubStep, true);
    })();
  } else {
    // All fields collected — submit
    busy = false;
    submitCurrentQuestion();
  }
}

/**
 * Submit the collected fieldData for the current question to the engine.
 */
function submitCurrentQuestion() {
  if (!currentQuestion) return;
  var q = currentQuestion;

  // Validate required fields
  var problem = validateQuestion(q);
  if (problem) {
    showValidationMsg(problem);
    return;
  }

  var interpretation = engine.recordAnswer(q.key, currentFieldData);
  if (interpretation) interpretationCache[q.key] = interpretation;

  trackEvent("diagnostic_question_answered", {
    question_key: q.key,
    questions_completed: engine.history.length
  });

  updateProgress();

  // Show interpretation inline
  (async function () {
    var thread = getThread();
    if (interpretation && thread) {
      await delay(MSG_DELAY);
      await showTypingThenMessage(thread, interpretation);
    }

    // Check completion
    if (engine.canComplete()) {
      completeDiagnostic();
      return;
    }

    // Next question
    var next = engine.nextQuestion();
    if (next) {
      await delay(MSG_DELAY);
      // Show question prompt
      var prompt = getSubStepPrompt(next, splitIntoSubSteps(next)[0], 0, splitIntoSubSteps(next).length);
      // For single-field auto-advance questions, use the question title
      if (splitIntoSubSteps(next).length === 1) {
        prompt = next.title;
      }
      await showTypingThenMessage(thread, prompt);
      presentQuestion(next);
    } else if (engine.canComplete()) {
      completeDiagnostic();
    }
  })();
}

/* ═══════════════════════════ VALIDATION ════════════════════════════ */

function checkShowWhen(cond) {
  for (var fieldId in cond) {
    if (!cond.hasOwnProperty(fieldId)) continue;
    var val = currentFieldData[fieldId];
    var expected = cond[fieldId];
    if (Array.isArray(expected)) {
      if (expected.indexOf(val) < 0) return false;
    } else {
      if (val !== expected) return false;
    }
  }
  return true;
}

function validateQuestion(q) {
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (f.showWhen && !checkShowWhen(f.showWhen)) continue;
    var value = currentFieldData[f.id];
    if (f.required) {
      var empty = value == null || value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty) return null; // Not an error — field might be in a future sub-step
    }
    if (f.type === "number" && value !== "" && value != null) {
      var n = Number(value);
      if (!isFinite(n)) return 'Please enter a valid number for "' + f.label + '".';
      if (f.min != null && n < f.min) return '"' + f.label + '" should be at least ' + f.min + '.';
      if (f.max != null && n > f.max) return '"' + f.label + '" should be ' + f.max + ' or less.';
    }
  }
  return null;
}

function prefillFromAnswers(q) {
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    var val = engine.answers[f.id];
    if (val != null) currentFieldData[f.id] = val;
  }
}

/* ═══════════════════════════ REBUILD (resume/back) ═════════════════ */

function rebuildConversation(activeQ) {
  var thread = getThread();
  if (!thread) return;
  thread.innerHTML = "";
  mode = "question";

  // Opening messages
  thread.appendChild(createEl(
    '<div class="chat-msg chat-msg-athlevo"><div class="chat-bubble chat-bubble-athlevo">Hi! I’m Athlevo, your endurance coach.</div></div>'
  ));
  thread.appendChild(createEl(
    '<div class="chat-msg chat-msg-athlevo"><div class="chat-bubble chat-bubble-athlevo">What are you working toward?</div></div>'
  ));

  // Replay history
  for (var i = 0; i < engine.history.length; i++) {
    var key = engine.history[i];
    if (activeQ && key === activeQ.key) break;

    var q = getQuestionDef(key);
    if (!q) continue;
    var fieldData = engine.questionAnswers[key] || {};

    // Athlevo question
    thread.appendChild(createEl(
      '<div class="chat-msg chat-msg-athlevo"><div class="chat-bubble chat-bubble-athlevo">' + esc(q.title) + '</div></div>'
    ));

    // User answer
    var echoLabel = getAnswerEchoLabel(q, fieldData);
    thread.appendChild(createEl(
      '<div class="chat-msg chat-msg-user"><div class="chat-bubble chat-bubble-user">' + esc(echoLabel) + '</div></div>'
    ));

    // Interpretation
    var interp = interpretationCache[key];
    if (!interp && q.interpret) {
      try { interp = q.interpret(fieldData, engine._stateView()); } catch (e) {}
    }
    if (interp) {
      thread.appendChild(createEl(
        '<div class="chat-msg chat-msg-athlevo"><div class="chat-bubble chat-bubble-athlevo">' + esc(interp) + '</div></div>'
      ));
    }
  }

  // Active question or completion
  if (!activeQ && engine.canComplete()) {
    completeDiagnostic();
    return;
  }
  if (activeQ) {
    thread.appendChild(createEl(
      '<div class="chat-msg chat-msg-athlevo"><div class="chat-bubble chat-bubble-athlevo">' + esc(activeQ.title) + '</div></div>'
    ));
    presentQuestion(activeQ);
  }

  scrollToBottom();
  updateProgress();
}

function getQuestionDef(key) {
  if (root.AthlevoDiagnostic && root.AthlevoDiagnostic.getQuestion) {
    return root.AthlevoDiagnostic.getQuestion(key);
  }
  return null;
}

function getAnswerEchoLabel(q, fieldData) {
  var parts = [];
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (f.showWhen) {
      var visible = true;
      for (var key in f.showWhen) {
        if (!f.showWhen.hasOwnProperty(key)) continue;
        var fval = fieldData[key];
        var expected = f.showWhen[key];
        if (Array.isArray(expected)) {
          if (expected.indexOf(fval) < 0) { visible = false; break; }
        } else {
          if (fval !== expected) { visible = false; break; }
        }
      }
      if (!visible) continue;
    }
    var v = fieldData[f.id];
    if (v == null || v === "") continue;
    if (f.options && !Array.isArray(v)) {
      for (var j = 0; j < f.options.length; j++) {
        if (String(f.options[j].value) === String(v)) { parts.push(f.options[j].label); break; }
      }
    } else if (f.options && Array.isArray(v)) {
      var labels = [];
      var vStr = v.map(String);
      for (var k = 0; k < f.options.length; k++) {
        if (vStr.indexOf(String(f.options[k].value)) >= 0) labels.push(f.options[k].label);
      }
      if (labels.length) parts.push(labels.join(", "));
    } else if (f.type === "number" && f.unit) {
      parts.push(v + " " + f.unit);
    } else {
      parts.push(String(v));
    }
  }
  return parts.join(" · ") || "Answered";
}

/* ═══════════════════════════ BACK NAVIGATION ══════════════════════ */

function diagBack() {
  if (busy) return;
  var prev = engine.previousQuestion(currentQuestion ? currentQuestion.key : null);
  if (!prev) return;
  currentFieldData = {};
  prefillFromAnswers(prev);
  rebuildConversation(prev);
  mode = "question";
}

/* ═══════════════════════════ COMPLETION ════════════════════════════ */

function completeDiagnostic() {
  var result = engine.complete();
  trackEvent("diagnostic_completed", {
    questions_answered: engine.history.length,
    primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
    feasibility_rating: result.feasibility.rating,
    injury_reported: result.safetyFlags.injuryReported
  });
  showBuildAnimation(result);
}

async function showBuildAnimation(result) {
  mode = "result";
  hideQuickReplies();
  hideComposer();

  var thread = getThread();
  if (!thread) { renderResult(); return; }

  // Progress to 100%
  var fill = document.querySelector("#diagProgress .ob2-fill");
  if (fill) fill.style.transform = "scaleX(1)";

  await showTypingThenMessage(thread, "Okay — I have enough to work with.");
  await delay(MSG_DELAY);

  var lines = [
    "Analysing your running profile…",
    "Identifying your primary limiter…",
    "Assessing goal feasibility…",
    "Building your coaching strategy…"
  ];

  for (var i = 0; i < lines.length; i++) {
    await delay(reducedMotion() ? 100 : 400);
    appendAthlevoMsg(thread, lines[i]);
    scrollToBottom();
  }

  await delay(reducedMotion() ? 200 : 600);
  await showTypingThenMessage(thread, "Here’s what I’m seeing.");
  await delay(MSG_DELAY);

  renderResult();
}

/* ═══════════════════════════ RESULT RENDERING ══════════════════════ */

function renderResult() {
  mode = "result";
  hideQuickReplies();
  hideComposer();

  var thread = getThread();
  if (!thread) return;

  var result = engine.result;
  if (!result) return;
  currentQuestion = null;

  // Back button
  var back = document.getElementById("diagBack");
  if (back) back.disabled = true;

  // Build result card inline in the chat
  var html = '<div class="chat-result-card">';

  // Profile summary
  html += '<div class="chat-result-section">';
  html += '<span class="chat-result-eyebrow">Your running profile</span>';
  html += '<h3 class="chat-result-title">' + esc(result.profile.goal) + '</h3>';
  html += '<div class="chat-result-meta">';
  html += '<span>' + esc(result.profile.experience) + '</span>';
  html += '<span>' + esc(result.profile.trainingStatus) + '</span>';
  if (result.profile.weeklyMileage) html += '<span>' + Math.round(result.profile.weeklyMileage) + ' km/week</span>';
  if (result.profile.trainingDays) html += '<span>' + result.profile.trainingDays + ' days/week</span>';
  html += '</div></div>';

  // Primary limiter
  if (result.primaryLimiter) {
    html += '<div class="chat-result-section chat-result-limiter">';
    html += '<span class="chat-result-eyebrow">Primary limiter</span>';
    html += '<h3 class="chat-result-limiter-title">' + esc(result.primaryLimiter.label) + '</h3>';
    html += '<p class="chat-result-text">' + esc(result.primaryLimiter.explanation) + '</p>';
    html += '</div>';

    if (result.holdingBack) {
      html += '<div class="chat-result-section">';
      html += '<span class="chat-result-eyebrow">What’s holding you back</span>';
      html += '<p class="chat-result-text">' + esc(result.holdingBack) + '</p>';
      html += '</div>';
    }

    if (result.whatWedChange && result.whatWedChange.length > 0) {
      html += '<div class="chat-result-section">';
      html += '<span class="chat-result-eyebrow">What we’d change</span>';
      html += '<ul class="chat-result-changes">';
      for (var c = 0; c < result.whatWedChange.length; c++) {
        html += '<li>' + esc(result.whatWedChange[c]) + '</li>';
      }
      html += '</ul></div>';
    }
  }

  // Goal feasibility
  if (result.feasibility) {
    var fClass = "chat-feas-" + result.feasibility.rating.replace(/_/g, "-");
    html += '<div class="chat-result-section">';
    html += '<span class="chat-result-eyebrow">Goal feasibility</span>';
    html += '<div class="chat-result-feasibility ' + fClass + '">';
    html += '<span class="chat-result-feas-badge">' + esc(result.feasibility.label) + '</span>';
    html += '<p class="chat-result-text">' + esc(result.feasibility.explanation) + '</p>';
    html += '</div></div>';
  }

  // Safety
  if (result.safetyFlags.requiresMedicalClearance) {
    html += '<div class="chat-result-section chat-result-safety">';
    html += '<p class="chat-result-text">Athlevo is not a medical provider. Based on what you’ve shared, please consult a qualified health professional before beginning or modifying any training program.</p>';
    html += '</div>';
  }

  // Athlevo recommendation
  var rec = result.athlevoRecommendation;
  if (rec) {
    html += '<div class="chat-result-section">';
    html += '<span class="chat-result-eyebrow">How Athlevo would coach you</span>';
    html += '<h3 class="chat-result-rec-title">' + esc(rec.heading) + '</h3>';
    html += '<p class="chat-result-text">' + esc(rec.strategy) + '</p>';
    if (!rec.safetyOverride && rec.capabilities) {
      html += '<div class="chat-result-caps">';
      for (var cap = 0; cap < rec.capabilities.length; cap++) {
        html += '<span class="chat-result-cap">' + esc(rec.capabilities[cap]) + '</span>';
      }
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div>';

  // Append as a wide Athlevo message
  var resultEl = createEl(
    '<div class="chat-msg chat-msg-athlevo chat-msg-result">' + html + '</div>'
  );
  thread.appendChild(resultEl);
  animateIn(resultEl);
  scrollToBottom();

  // CTA
  if (!rec || !rec.safetyOverride) {
    (async function () {
      await delay(MSG_DELAY * 2);
      var ctaEl = createEl(
        '<div class="chat-msg chat-msg-athlevo chat-msg-cta">' +
          '<div class="chat-cta-card">' +
            '<button class="chat-cta-btn" id="diagCTA" type="button">Start my training · ₱597/month</button>' +
            '<p class="chat-cta-note">Your diagnostic is saved.</p>' +
          '</div>' +
        '</div>'
      );
      thread.appendChild(ctaEl);
      animateIn(ctaEl);
      scrollToBottom();

      // Wire CTA
      var cta = document.getElementById("diagCTA");
      if (cta) {
        cta.addEventListener("click", function () {
          trackEvent("diagnostic_signup_tapped", {
            primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
            feasibility_rating: result.feasibility.rating
          });
          trackEvent("signup_started", { source_surface: "diagnostic" });
          if (root.AthlevoDiagnosticAcquisition && root.AthlevoDiagnosticAcquisition.markDiagnosticCompleted) {
            root.AthlevoDiagnosticAcquisition.markDiagnosticCompleted(engine);
          }
          // Try existing checkout first; fall back to auth entry
          if (root.AthlevoDiagnosticAcquisition && root.AthlevoDiagnosticAcquisition.checkout) {
            root.AthlevoDiagnosticAcquisition.checkout("card");
          } else if (root.openAppEntry) {
            root.openAppEntry();
          } else {
            showScreen("screen-welcome");
          }
        });
      }
    })();
  }

  // Analytics
  var resultKey = engine.importKey ? engine.importKey() : "result";
  if (resultTrackedFor !== resultKey) {
    resultTrackedFor = resultKey;
    trackEvent("diagnostic_result_viewed", {
      primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
      feasibility_rating: result.feasibility ? result.feasibility.rating : null,
      injury_reported: !!(result.safetyFlags && result.safetyFlags.injuryReported)
    });
    if (rec && !rec.safetyOverride) {
      trackEvent("athlevo_recommendation_viewed", {
        primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
        feasibility_rating: result.feasibility ? result.feasibility.rating : null
      });
    }
  }
}

/* ═══════════════════════════ PROGRESS ══════════════════════════════ */

function updateProgress() {
  var fill = document.querySelector("#diagProgress .ob2-fill");
  if (!fill) {
    var container = document.getElementById("diagProgress");
    if (container) {
      container.innerHTML = '<i class="ob2-fill"></i>';
      fill = container.querySelector(".ob2-fill");
    }
  }
  if (fill && engine) {
    var completeness = engine.completeness();
    fill.style.transform = "scaleX(" + Math.max(0.0001, completeness) + ")";
  }

  var back = document.getElementById("diagBack");
  if (back && currentQuestion) {
    var idx = engine.history.indexOf(currentQuestion.key);
    back.disabled = idx === 0 || (idx < 0 && engine.history.length === 0);
  }
}

/* ═══════════════════════════ ANALYTICS ═════════════════════════════ */

function trackEvent(name, props) {
  try {
    if (root.AthlevoAnalytics && root.AthlevoAnalytics.track) {
      root.AthlevoAnalytics.track(name, props || {});
    }
    if (root.AthlevoProductAnalytics && root.AthlevoProductAnalytics.trackAthlevoEvent) {
      root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
    }
  } catch (e) {}
}

/* ═══════════════════════════ DOM INIT ══════════════════════════════ */

function initDOM() {
  var backBtn = document.getElementById("diagBack");
  if (backBtn) {
    backBtn.addEventListener("click", function () { diagBack(); });
  }
  // Legacy continue button — keep wired but hidden
  var contBtn = document.getElementById("diagContinue");
  if (contBtn) {
    contBtn.addEventListener("click", function () {
      // In chat mode, this is handled by composer/chips instead
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDOM);
} else {
  initDOM();
}

/* ═══════════════════════════ EXPORT ════════════════════════════════ */

var DiagnosticUI = {
  start: startDiagnostic,
  continue: function () {},  // Legacy — handled by chat interaction
  back: diagBack,
  getEngine: function () { return engine; }
};

root.AthlevoDiagnosticUI = DiagnosticUI;

if (typeof module !== "undefined" && module.exports) {
  module.exports = DiagnosticUI;
}

})(typeof window !== "undefined" ? window : this);
