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
var activeSubField = null;    // the exact field within the current sub-step group
                               // that is actually on screen right now (may be a
                               // showWhen-dependent field, not fieldGroup[0]) --
                               // see nextActiveDependent().
var interpretationCache = {};
var resultTrackedFor = null;

/* Facts confidently extracted from free-text messages but not yet
 * committed to the engine (they belong to a field/question not currently
 * on screen). Consumed -- and removed -- as soon as their question is
 * reached, so an upcoming question can be silently answered instead of
 * re-asked. Purely in-memory: never persisted, never sent to analytics. */
var factStore = {};

/* Lightweight conversion-conversation memory. In-memory only — never
 * persisted, never sent to analytics. Refresh keeps diagnostic answers
 * (engine localStorage) and drops this, which is intentional. */
var salesState = null;
var recentTurns = [];
var awaitingSalesFollowup = false;

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
function getSales() {
  return root.AthlevoDiagnosticSales || null;
}

function rememberTurn(role, text) {
  recentTurns.push({ role: role, text: String(text || "").slice(0, 300) });
  if (recentTurns.length > 6) recentTurns = recentTurns.slice(-6);
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
  /* Authenticated users never enter the public /ai acquisition chat.
     Paid → existing app routing. Unpaid → existing entitlement, not paid access.
     A stored pending diagnostic must not override a live session. */
  if (root.athlevoSessionUserId) {
    if (typeof root.routeAfterAuth === "function") {
      return root.routeAfterAuth(root.athlevoSessionUserId);
    }
    return;
  }

  if (typeof root.hasReturningAthlevoAccountMarker === "function" &&
      root.hasReturningAthlevoAccountMarker()) {
    if (typeof root.showReturningUserWelcome === "function") {
      root.showReturningUserWelcome();
    } else if (typeof root.openAppEntry === "function") {
      root.openAppEntry();
    } else {
      showScreen("screen-welcome");
    }
    return;
  }

  var checkoutReturn = root.AthlevoDiagnosticAcquisition &&
    typeof root.AthlevoDiagnosticAcquisition.hasCheckoutReturn === "function" &&
    root.AthlevoDiagnosticAcquisition.hasCheckoutReturn();
  if (checkoutReturn) {
    if (typeof root.showCheckoutReturnWelcome === "function") {
      root.showCheckoutReturnWelcome();
    } else if (typeof root.openAppEntry === "function") {
      root.openAppEntry();
    } else {
      showScreen("screen-welcome");
    }
    return;
  }

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
  recentTurns = [];
  salesState = getSales() ? getSales().emptySalesState() : null;
  awaitingSalesFollowup = false;
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
      var chipClass = opt.chipClass ? "chat-qr-chip " + opt.chipClass : "chat-qr-chip";
      var btn = createEl(
        '<button class="' + chipClass + '" type="button">' + esc(opt.label) + '</button>'
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
  activeSubField = null; // a fresh sub-step always starts on its primary field
  var fieldGroup = subStepFields[index];
  var f = fieldGroup[0]; // primary field

  if (isValidFieldValue(f, currentFieldData[f.id])) {
    presentSubStep(index + 1, true);
    return;
  }

  // Already known from an earlier free-text message? Fill it silently and
  // move straight to the next sub-step instead of asking again.
  var preset = consumeFactForField(f);
  if (preset !== undefined) {
    currentFieldData[f.id] = preset;
    trackEvent("diagnostic_field_autofilled", { field_id: f.id });
    presentSubStep(index + 1, true);
    return;
  }

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
/**
 * Given a compound question's field group, the field that was just
 * answered, and the answers collected so far, return the next field
 * in the group that still needs a value (a showWhen-dependent field
 * that has become visible), or null when the group is complete.
 *
 * This is the single source of truth for "what field is on screen" —
 * both handleChipSelect (after a chip pick) and handleComposerSend's
 * afterFieldCommitted (after free-text) call it, so the two paths can
 * never disagree about which field a following message belongs to.
 * `data` is an explicit param (not the currentFieldData closure) so
 * this stays a pure, independently testable function.
 */
function nextActiveDependent(fieldGroup, answeredFieldId, data) {
  for (var i = 0; i < fieldGroup.length; i++) {
    var f = fieldGroup[i];
    if (f.id === answeredFieldId) continue;
    if (Object.prototype.hasOwnProperty.call(data, f.id)) continue;
    if (f.showWhen && !checkShowWhenAgainst(f.showWhen, data)) continue;
    return f;
  }
  return null;
}

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

  absorbGroupFacts(fieldGroup);

  // Check for a dependent field that has just become visible (e.g. a
  // showWhen text field revealed by the chip we just picked).
  var dependent = nextActiveDependent(fieldGroup, field.id, currentFieldData);

  if (dependent) {
    // Show dependent field as next sub-sub-step
    busy = false;
    presentDependentField(dependent);
    return;
  }

  // Auto-advance if single-field question or compound is complete
  activeSubField = null;
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
  var preset = consumeFactForField(dep);
  if (preset !== undefined) {
    currentFieldData[dep.id] = preset;
    var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0] || [];
    absorbGroupFacts(fieldGroup);
    var next = nextActiveDependent(fieldGroup, dep.id, currentFieldData);
    if (next) {
      presentDependentField(next);
      return;
    }
    activeSubField = null;
    advanceAfterChip();
    return;
  }
  activeSubField = dep;
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
 * Conversation-mode (sales CTA) outranks field validation.
 * The previous Athlevo turn asked to start/proceed; the next athlete
 * message is interpreted against that CTA before any diagnostic parser.
 *
 * Returns: "checkout" | "sales" | "resume" | "field"
 */
function decideSalesFollowup(val, classification, extraPains, field, question) {
  var Sales = getSales();
  var ready = classification && classification.intent === "ready_to_start" &&
    classification.confidence >= 0.7;
  if (ready || (Sales && Sales.isSalesCtaConfirmation && Sales.isSalesCtaConfirmation(val))) {
    return "checkout";
  }
  if (classification && classification.confidence >= 0.7) return "sales";
  if (extraPains && extraPains.length && Sales &&
      Sales.composeSalesReply(null, engine, salesState || Sales.emptySalesState(), extraPains)) {
    return "sales";
  }
  if (isDiagnosticDeferral(val)) return "resume";
  var facts = extractDiagnosticFacts(val, field, question);
  if (field && Object.prototype.hasOwnProperty.call(facts, field.id)) {
    var coerced = coerceFactValue(field, facts[field.id]);
    if (isValidFieldValue(field, coerced)) return "field";
  }
  return "resume";
}

/**
 * Handle composer text submission.
 *
 * Deterministic parse first (buyer-intent classifier, fact extraction,
 * chip aliases, numbers). AI router only when the message needs natural-
 * language understanding. Quick-reply chips never reach this function.
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
  var Sales = getSales();

  rememberTurn("athlete", val);

  var classification = Sales ? Sales.classify(val) : null;
  var extraPains = Sales ? Sales.detectPainPoints(val) : [];

  /* Facts first, always — a message may be BOTH a diagnostic answer and a
     sales question. Buyer intent decides the reply, not whether we save. */
  var fieldGroupEarly = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  var fieldEarly = activeSubField || (fieldGroupEarly && fieldGroupEarly[0]);
  if (q && fieldEarly) {
    applyExtractedFacts(extractDiagnosticFacts(val, fieldEarly, q), fieldEarly.id);
  }

  if (awaitingSalesFollowup) {
    var followup = decideSalesFollowup(val, classification, extraPains, fieldEarly, q);
    if (followup === "checkout") {
      if (thread) appendUserMsg(thread, val);
      hideQuickReplies();
      scrollToBottom();
      handleSalesDetour({
        intent: "ready_to_start",
        next_action: "show_checkout",
        confidence: 0.9,
        explicitReady: true
      }, val, extraPains);
      return;
    }
    if (followup === "resume") {
      if (thread) appendUserMsg(thread, val);
      hideQuickReplies();
      scrollToBottom();
      awaitingSalesFollowup = false;
      busy = false;
      resumeDiagnosticAfterSales();
      return;
    }
    /* "sales" continues into the existing high-confidence detour.
       "field" continues into the diagnostic parser. */
  }

  var highConfidenceSales = classification && classification.confidence >= 0.7;
  if (highConfidenceSales) {
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    handleSalesDetour(classification, val, extraPains);
    return;
  }
  if (!classification && extraPains.length && Sales &&
      Sales.composeSalesReply(null, engine, salesState || Sales.emptySalesState(), extraPains)) {
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    handleSalesDetour({
      intent: "question_about_training",
      next_action: "recommend_athlevo",
      confidence: 0.7
    }, val, extraPains);
    return;
  }

  // Special case: race_details gate — collecting race name
  if (q && q.key === "race_details" && currentSubStep === 0.5) {
    currentFieldData.goal_race = val;
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    busy = false;
    (async function () {
      await showTypingThenMessage(getThread(), "And when is it?");
      hideQuickReplies();
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

  if (q && q.key === "race_details" && currentSubStep === 0.6) {
    var parsedDate = parseNaturalDate(val);
    currentFieldData.goal_race_date = parsedDate;
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    busy = false;
    askGoalTime();
    return;
  }

  if (q && q.key === "race_details" && currentSubStep === 0.7) {
    var mappedTime = NUMERIC_ALIASES[val.toLowerCase()] || val;
    currentFieldData.goal_time = mappedTime;
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    busy = false;
    submitCurrentQuestion();
    return;
  }

  if (!q) { busy = false; return; }

  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  if (!fieldGroup) { busy = false; return; }
  var field = activeSubField || fieldGroup[0];

  var facts = extractDiagnosticFacts(val, field, q);
  mergeFactStore(facts, field.id);
  var resolvedValue = Object.prototype.hasOwnProperty.call(facts, field.id) ? facts[field.id] : undefined;

  function afterFieldCommitted() {
    hideQuickReplies();
    scrollToBottom();
    absorbGroupFacts(fieldGroup);
    var dependent = nextActiveDependent(fieldGroup, field.id, currentFieldData);
    if (dependent) {
      busy = false;
      presentDependentField(dependent);
      return;
    }
    activeSubField = null;
    advanceAfterChip();
  }

  function commitCurrent(value) {
    awaitingSalesFollowup = false;
    currentFieldData[field.id] = value;
    if (thread) appendUserMsg(thread, val);
    if (extraPains.length && Sales) {
      salesState = Sales.applySalesSignals(salesState || Sales.emptySalesState(), null, extraPains, Sales.hasMinimumContext(engine));
      var painReply = Sales.composeSalesReply(null, engine, salesState, extraPains);
      if (painReply && Sales.hasMinimumContext(engine)) {
        hideQuickReplies();
        showAthlevoBubbles(painReply.reply, painReply.reply_2, true);
        salesState = Sales.markValueShown(salesState);
        trackEvent("diagnostic_value_demonstrated", { buyer_intent: "curious" });
        busy = false;
        offerFollowUpChips(true);
        return;
      }
    }
    afterFieldCommitted();
  }

  if (resolvedValue !== undefined && isValidFieldValue(field, resolvedValue)) {
    commitCurrent(resolvedValue);
    return;
  }

  var mapped2 = tryMapTextToValue(q, field, val);
  if (mapped2 !== null) {
    commitCurrent(mapped2.value);
    return;
  }

  if (field.type === "chips" || field.type === "multichips") {
    if (awaitingSalesFollowup) {
      awaitingSalesFollowup = false;
      busy = false;
      restoreCurrentFieldInput();
      return;
    }
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    if (Sales && Sales.shouldUseAiFallback(val, field, null)) {
      routeViaAi(val, field, q, fieldGroup);
      return;
    }
    showChipClarification(field);
    busy = false;
    restoreCurrentFieldInput();
    return;
  }

  if (field.type === "number") {
    if (Sales && Sales.looksLikeAQuestion(val)) {
      if (thread) appendUserMsg(thread, val);
      hideQuickReplies();
      scrollToBottom();
      routeViaAi(val, field, q, fieldGroup);
      return;
    }
    var n = parseLooseNumber(factPortionOfMixedMessage(val) || val);
    if (n === null) {
      if (awaitingSalesFollowup) {
        awaitingSalesFollowup = false;
        busy = false;
        restoreCurrentFieldInput();
        return;
      }
      showValidationMsg(conversationalNumberPrompt(field));
      busy = false;
      return;
    }
    if (field.min != null && n < field.min) {
      showValidationMsg("That seems low — " + (field.label || "this") + " should be at least " + field.min + ".");
      busy = false;
      return;
    }
    if (field.max != null && n > field.max) {
      showValidationMsg("That seems high — " + (field.label || "this") + " should be " + field.max + " or less.");
      busy = false;
      return;
    }
    commitCurrent(n);
    return;
  }

  if (Sales && Sales.looksLikeAQuestion(val)) {
    if (thread) appendUserMsg(thread, val);
    hideQuickReplies();
    scrollToBottom();
    routeViaAi(val, field, q, fieldGroup);
    return;
  }

  if (field.maxLength && val.length > field.maxLength) {
    showValidationMsg("Please keep it under " + field.maxLength + " characters.");
    busy = false;
    return;
  }

  commitCurrent(val);
}

function showChipClarification(field) {
  var thread = getThread();
  if (!thread || !field || !field.options) return;
  var optionLabels = field.options.map(function (o) { return o.label; }).join(", ");
  appendAthlevoMsg(thread, "I want to make sure I understand you correctly. Could you pick one? " + optionLabels);
  rememberTurn("athlevo", "Could you pick one?");
  scrollToBottom();
}

function showAthlevoBubbles(reply, reply2, instant) {
  var thread = getThread();
  if (!thread || !reply) return Promise.resolve();
  rememberTurn("athlevo", reply);
  if (instant) {
    appendAthlevoMsg(thread, reply);
    if (reply2) {
      appendAthlevoMsg(thread, reply2);
      rememberTurn("athlevo", reply2);
    }
    scrollToBottom();
    return Promise.resolve();
  }
  return (async function () {
    await showTypingThenMessage(thread, reply);
    if (reply2) {
      rememberTurn("athlevo", reply2);
      await showTypingThenMessage(thread, reply2);
    }
  })();
}

function coerceFactValue(field, value) {
  if (!field) return value;
  if (field.type === "number") {
    if (typeof value === "number" && isFinite(value)) return value;
    return parseLooseNumber(String(value));
  }
  return value;
}

function applyExtractedFacts(facts, currentFieldId) {
  if (!facts) return;
  for (var key in facts) {
    if (!Object.prototype.hasOwnProperty.call(facts, key)) continue;
    var def = findFieldDef(key);
    var coerced = coerceFactValue(def, facts[key]);
    if (!def || !isValidFieldValue(def, coerced)) continue;
    if (key === currentFieldId) {
      currentFieldData[key] = coerced;
    }
    if (!(engine && engine.known && engine.known[key])) {
      factStore[key] = coerced;
    }
  }
}

function handleSalesDetour(classification, message, extraPains) {
  var Sales = getSales();
  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  var field = activeSubField || (fieldGroup && fieldGroup[0]);
  applyExtractedFacts(extractDiagnosticFacts(message, field, currentQuestion), field ? field.id : null);

  if (!Sales) {
    busy = false;
    restoreCurrentFieldInput();
    return;
  }

  salesState = Sales.applySalesSignals(
    salesState || Sales.emptySalesState(),
    classification,
    extraPains,
    Sales.hasMinimumContext(engine)
  );
  var composed = Sales.composeSalesReply(classification, engine, salesState, extraPains);
  if (!composed) {
    busy = false;
    restoreCurrentFieldInput();
    return;
  }

  if (classification.intent === "pricing_question") {
    trackEvent("diagnostic_pricing_asked", {});
    trackEvent("diagnostic_buyer_intent_detected", { buyer_intent: "considering" });
  } else if (classification.intent === "ready_to_start") {
    trackEvent("diagnostic_start_recommended", { buyer_intent: "ready" });
    trackEvent("diagnostic_buyer_intent_detected", { buyer_intent: "ready" });
  } else if (classification.intent === "how_it_works" || classification.topic === "inclusions") {
    trackEvent("diagnostic_value_demonstrated", { buyer_intent: "curious" });
    trackEvent("diagnostic_buyer_intent_detected", { buyer_intent: "curious" });
    salesState = Sales.markValueShown(salesState);
  } else if (classification.intent === "objection") {
    trackEvent("diagnostic_buyer_intent_detected", { buyer_intent: "considering" });
  } else if (extraPains && extraPains.length) {
    trackEvent("diagnostic_value_demonstrated", { buyer_intent: "curious" });
    salesState = Sales.markValueShown(salesState);
  }

  showAthlevoBubbles(composed.reply, composed.reply_2, true);
  busy = false;
  awaitingSalesFollowup = true;
  if (composed.show_checkout || composed.next_action === "show_checkout") {
    offerPaymentBridge();
    return;
  }
  /* Product/commercial answers wait. Do not restore the current
     diagnostic field chips or append the next questionnaire prompt. */
  var includeStart = composed.next_action === "recommend_athlevo" || composed.next_action === "explain_offer";
  var startOptions = [];
  if (includeStart) {
    startOptions.push({
      label: Sales.ctaLabel(engine, salesState) || "Start my training · ₱597/month",
      value: "__start"
    });
  }
  if (startOptions.length) {
    showQuickReplies(startOptions, function (opt) {
      if (opt.value === "__start") {
        hideQuickReplies();
        var ready = Sales.composeSalesReply({
          intent: "ready_to_start",
          next_action: "show_checkout",
          confidence: 0.9,
          explicitReady: true
        }, engine, salesState || Sales.emptySalesState(), []);
        showAthlevoBubbles(
          ready && ready.reply ? ready.reply : "Sounds good. Choose whichever payment method is easiest for you.",
          null,
          true
        );
        offerPaymentBridge();
      }
    });
  } else {
    hideQuickReplies();
  }
  showComposer("Or type here…");
  setComposerMode("text");
}

function routeViaAi(message, field, q, fieldGroup) {
  var Sales = getSales();
  var thread = getThread();
  if (!Sales) {
    showChipClarification(field);
    busy = false;
    restoreCurrentFieldInput();
    return;
  }
  if (thread) {
    appendTypingIndicator(thread);
    scrollToBottom();
  }
  var payload = Sales.buildRouterPayload(
    engine,
    q ? q.key : null,
    message,
    salesState || Sales.emptySalesState(),
    recentTurns
  );
  Sales.callRouter(payload).then(function (result) {
    removeTypingIndicator();
    trackEvent("diagnostic_ai_fallback_used", { question_key: q ? q.key : null });
    applyConversationalResult(result, message, field, fieldGroup);
  });
}

function applyConversationalResult(result, message, field, fieldGroup) {
  var Sales = getSales();
  result = result || (Sales && Sales.FALLBACK_RESPONSE);
  if (!result) {
    busy = false;
    restoreCurrentFieldInput();
    return;
  }

  applyExtractedFacts(result.extracted_facts, field ? field.id : null);
  if (Sales) {
    var classish = { intent: result.intent, next_action: result.next_action, confidence: result.confidence };
    salesState = Sales.applySalesSignals(
      salesState || Sales.emptySalesState(),
      classish,
      result.pain_points || [],
      Sales.hasMinimumContext(engine)
    );
    if (result.next_action === "recommend_athlevo" || result.next_action === "explain_offer") {
      salesState = Sales.markValueShown(salesState);
      trackEvent("diagnostic_value_demonstrated", { buyer_intent: result.buyer_intent || "curious" });
    }
    if (result.intent === "pricing_question") trackEvent("diagnostic_pricing_asked", {});
    if (result.show_checkout || result.next_action === "show_checkout") {
      trackEvent("diagnostic_start_recommended", { buyer_intent: "ready" });
    }
    if (result.intent && result.intent !== "diagnostic_answer" && result.intent !== "unknown") {
      trackEvent("diagnostic_buyer_intent_detected", {
        buyer_intent: result.buyer_intent && result.buyer_intent !== "none" ? result.buyer_intent : "curious"
      });
    }
  }

  showAthlevoBubbles(result.reply, result.reply_2, true);
  busy = false;

  var filled = field && Object.prototype.hasOwnProperty.call(currentFieldData, field.id);
  if (result.next_action === "continue_diagnostic" && filled) {
    awaitingSalesFollowup = false;
    var dependent = nextActiveDependent(fieldGroup || [], field.id, currentFieldData);
    if (dependent) {
      presentDependentField(dependent);
      return;
    }
    activeSubField = null;
    advanceAfterChip();
    return;
  }

  if (result.show_checkout || result.next_action === "show_checkout") {
    offerPaymentBridge();
    return;
  }

  var salesReply = result.intent === "pricing_question" ||
    result.intent === "how_it_works" ||
    result.intent === "question_about_athlevo" ||
    result.intent === "objection" ||
    result.next_action === "recommend_athlevo" ||
    result.next_action === "explain_offer" ||
    result.next_action === "answer_then_continue";
  if (salesReply) {
    awaitingSalesFollowup = true;
    if (filled) {
      showComposer("Or type here…");
      setComposerMode("text");
      return;
    }
  }

  if (result.usedFallback || result.next_action === "clarify") {
    restoreCurrentFieldInput();
    return;
  }

  offerFollowUpChips(
    result.next_action === "recommend_athlevo" || result.next_action === "explain_offer"
  );
}

function restoreCurrentFieldInput() {
  if (!currentQuestion) return;
  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  var f = activeSubField || (fieldGroup && fieldGroup[0]);
  if (!f) {
    showComposer("Type your answer here…");
    setComposerMode("text");
    return;
  }
  if (f.type === "chips" || f.type === "multichips") {
    showQuickReplies(f.options, function (opt) {
      handleChipSelect(f, opt, fieldGroup);
    });
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
  } else {
    hideQuickReplies();
    showComposer(f.placeholder || "Type here…");
    setComposerMode("text");
  }
}

function offerStartChips() {
  offerPaymentBridge();
}

function offerPaymentBridge() {
  trackEvent("diagnostic_payment_options_shown", { surface: "diagnostic" });
  /* Logged-out /ai: PayMongo checkout requires auth and 401s. Show only
     the method that works before signup (Whop card). Authenticated users
     keep the existing local PayMongo chip — do not remove it globally. */
  var paymentOptions = [
    { label: "Debit / Credit Card", value: "__pay_card", chipClass: "chat-qr-pay chat-qr-pay-primary" }
  ];
  if (root.athlevoSessionUserId) {
    paymentOptions.unshift({ label: "QRPh · Maya · GrabPay", value: "__pay_local", chipClass: "chat-qr-pay" });
  }
  showQuickReplies(paymentOptions, function (opt) {
    if (opt.value === "__pay_local") {
      beginCheckoutFromChat("local");
      return;
    }
    if (opt.value === "__pay_card") {
      beginCheckoutFromChat("card");
      return;
    }
    busy = false;
    restoreCurrentFieldInput();
  });
  showComposer("Or type here…");
  setComposerMode("text");
}

function offerFollowUpChips(includeStart) {
  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  var f = activeSubField || (fieldGroup && fieldGroup[0]);
  var options = [];
  if (includeStart) {
    var Sales = getSales();
    options.push({
      label: Sales ? Sales.ctaLabel(engine, salesState) : "Start my training · ₱597/month",
      value: "__start"
    });
  }
  if (f && f.options) {
    for (var i = 0; i < f.options.length; i++) options.push(f.options[i]);
  }
  if (options.length) {
    showQuickReplies(options, function (opt) {
      if (opt.value === "__start") {
        hideQuickReplies();
        var Sales2 = getSales();
        var ready = Sales2 ? Sales2.composeSalesReply({
          intent: "ready_to_start",
          next_action: "show_checkout",
          confidence: 0.9
        }, engine, salesState || Sales2.emptySalesState(), []) : null;
        showAthlevoBubbles(
          ready && ready.reply ? ready.reply : "Sounds good. Choose whichever payment method is easiest for you.",
          null,
          true
        );
        offerPaymentBridge();
        return;
      }
      if (f) handleChipSelect(f, opt, fieldGroup);
    });
  } else {
    restoreCurrentFieldInput();
    return;
  }
  showComposer("Or type here…");
  setComposerMode("text");
}

var checkoutOpening = false;

function beginCheckoutFromChat(method) {
  if (!root.athlevoSessionUserId) {
    if (engine && !engine.completed) {
      var recAnon = engine.currentRecommendation ? engine.currentRecommendation() : null;
      if (recAnon && recAnon.safetyOverride) {
        showAthlevoBubbles(recAnon.strategy, null, true);
        restoreCurrentFieldInput();
        return;
      }
      engine.complete();
    }
    if (root.AthlevoDiagnosticAcquisition && root.AthlevoDiagnosticAcquisition.markDiagnosticCompleted) {
      root.AthlevoDiagnosticAcquisition.markDiagnosticCompleted(engine);
    }
    var resultAnon = engine ? engine.result : null;
    trackEvent("diagnostic_signup_tapped", {
      primary_limiter: resultAnon && resultAnon.primaryLimiter ? resultAnon.primaryLimiter.key : null,
      feasibility_rating: resultAnon && resultAnon.feasibility ? resultAnon.feasibility.rating : null
    });
    trackEvent("signup_started", { source_surface: "diagnostic" });
    if (typeof root.openAiSignup === "function") root.openAiSignup();
    else if (root.openAppEntry) root.openAppEntry();
    else showScreen("screen-welcome");
    return;
  }
  if (method === "local" && !root.athlevoSessionUserId) return;
  if (checkoutOpening) return;
  checkoutOpening = true;
  busy = true;
  hideQuickReplies();
  var checkoutMethod = method === "local" ? "local" : "card";
  trackEvent("diagnostic_checkout_method_selected", {
    surface: "diagnostic",
    checkout_method: checkoutMethod
  });
  if (engine && !engine.completed) {
    var rec = engine.currentRecommendation ? engine.currentRecommendation() : null;
    if (rec && rec.safetyOverride) {
      showAthlevoBubbles(rec.strategy, null, true);
      checkoutOpening = false;
      busy = false;
      restoreCurrentFieldInput();
      return;
    }
    engine.complete();
  }
  var result = engine ? engine.result : null;
  if (root.AthlevoDiagnosticAcquisition && root.AthlevoDiagnosticAcquisition.markDiagnosticCompleted) {
    root.AthlevoDiagnosticAcquisition.markDiagnosticCompleted(engine);
  }
  trackEvent("diagnostic_signup_tapped", {
    primary_limiter: result && result.primaryLimiter ? result.primaryLimiter.key : null,
    feasibility_rating: result && result.feasibility ? result.feasibility.rating : null
  });
  trackEvent("signup_started", { source_surface: "diagnostic" });
  var opener = Promise.resolve(false);
  if (root.AthlevoDiagnosticAcquisition && root.AthlevoDiagnosticAcquisition.checkout) {
    opener = Promise.resolve(root.AthlevoDiagnosticAcquisition.checkout(checkoutMethod));
  } else if (root.openAppEntry) {
    root.openAppEntry();
    opener = Promise.resolve(true);
  } else {
    showScreen("screen-welcome");
    opener = Promise.resolve(true);
  }
  opener.then(function (opened) {
    checkoutOpening = false;
    busy = false;
    if (!opened) {
      showAthlevoBubbles("That payment option isn’t available right now. Card still works from here.", null, true);
      offerPaymentBridge();
    }
  }).catch(function () {
    checkoutOpening = false;
    busy = false;
    offerPaymentBridge();
  });
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

    // Phrase-in-message match — longest label wins so "half marathon"
    // is not stolen by the shorter "Marathon" option.
    var embedded = matchOptionEmbeddedInText(field, lower);
    if (embedded) return embedded;

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

  // For chips fields that require a structured value, can't accept arbitrary
  // text here — the composer router decides between AI fallback and a
  // conversational clarification. Do not append the "pick one" dead-end
  // from inside the mapper; that hijacked natural-language answers.
  if ((field.type === "chips" || field.type === "multichips") && field.required) {
    return null;
  }

  // For free text fields, accept as-is. Number fields are handled by the
  // loose-numeric-parse step in handleComposerSend so a value is always
  // validated against the field it actually belongs to.
  if (field.type === "text") {
    return { value: text, label: text };
  }

  return null;
}

function matchOptionEmbeddedInText(field, lower) {
  var best = null;
  var bestLen = 0;
  for (var i = 0; i < field.options.length; i++) {
    var opt = field.options[i];
    var needles = [String(opt.label || "").toLowerCase(), String(opt.value || "").toLowerCase()];
    for (var n = 0; n < needles.length; n++) {
      var needle = needles[n];
      if (!needle || needle.length < 2 || needle.length <= bestLen) continue;
      var idx = lower.indexOf(needle);
      if (idx < 0) continue;
      var before = idx === 0 ? " " : lower.charAt(idx - 1);
      var after = idx + needle.length >= lower.length ? " " : lower.charAt(idx + needle.length);
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
      best = opt;
      bestLen = needle.length;
    }
  }
  if (!best) {
    var aliasKeys = Object.keys(GOAL_ALIASES).sort(function (a, b) { return b.length - a.length; });
    var allowed = {};
    for (var a = 0; a < field.options.length; a++) allowed[String(field.options[a].value)] = true;
    for (var k = 0; k < aliasKeys.length; k++) {
      var alias = aliasKeys[k];
      var mapped = GOAL_ALIASES[alias];
      if (!allowed[mapped]) continue;
      var re = new RegExp("(?:^|[^a-z0-9])" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:$|[^a-z0-9])", "i");
      if (re.test(lower)) return { value: mapped, label: mapped };
    }
    return null;
  }
  return { value: best.value, label: best.label };
}


/* ═══════════════════════════ FREE-TEXT EXTRACTION ═══════════════════
 * Reads a whole runner message for every diagnostic fact it confidently
 * contains — not just the field currently on screen — and maps it to the
 * SAME field ids the engine already defines (js/diagnostic.js QUESTIONS).
 * Nothing here invents a field: every extracted value is checked against
 * the real field definition (options/min/max/type) before it is trusted.
 * Ambiguous or unitless numbers are left alone so the existing per-field
 * flow (context = the question currently on screen) handles them.
 */

var WEEK_CONTEXT_RE = /\bper\s*week\b|\bweekly\b|\b(?:a|last|this|each|every|per|most)\s*weeks?\b|\/\s*week\b|\bwk\b/i;
var GOAL_TIME_RE = /\bsub[\s-]?(\d{1,2})(?::(\d{2}))?\b/i;
var RACE_NAME_RE = /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}\s+(?:Half\s+Marathon|Ultra\s*Marathon|Marathon|10K|5K))\b/;
var MONTH_NAMES_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
var MONTH_DAY_RE = new RegExp("\\b(" + MONTH_NAMES_RE + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b", "i");
var DAY_MONTH_RE = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + MONTH_NAMES_RE + ")(?:,?\\s+(\\d{4}))?\\b", "i");

// Word-based goal keywords are safe in any message. Numeric ones ("50k",
// "10k", "42.2k"...) are gated separately -- a weekly-mileage sentence
// like "40-50km per week" must never be read as an Ultra/10K race goal.
var GOAL_DISTANCE_WORD_RULES = [
  [/\bhalf[\s-]?marathon\b/i, "Half marathon"],
  [/\bultra\s*-?\s*marathon\b|\bultra\b/i, "Ultra"],
  [/\bfull\s+marathon\b|\bmarathon\b/i, "Marathon"],
  [/\bten\s*k\b/i, "10K"],
  [/\bfive\s*k\b/i, "5K"],
  [/\bgeneral\s+fitness\b|\bjust\s+fitness\b|\bno\s+(?:target\s+)?race\b/i, "General fitness"]
];
var GOAL_DISTANCE_NUMERIC_RULES = [
  [/\b21(?:\.1)?\s*k(?:m)?\b/i, "Half marathon"],
  [/\b(?:50|100)\s*k(?:m)?\b/i, "Ultra"],
  [/\b42\.?2\s*k(?:m)?\b/i, "Marathon"],
  [/\b10\s*-?\s*k(?:m)?\b/i, "10K"],
  [/\b5\s*-?\s*k(?:m)?\b/i, "5K"]
];

// Distances that recent_performance actually accepts (no Ultra / fitness).
var RECENT_RACE_DISTANCE_RULES = [
  [/\bhalf[\s-]?marathon\b/i, "Half marathon"],
  [/\bhm\b/i, "Half marathon"],
  [/\b21(?:\.1)?\s*k(?:m)?\b/i, "Half marathon"],
  [/\b(?:my|last|recent|a)\s+half\b/i, "Half marathon"],
  [/\bran a half\b/i, "Half marathon"],
  [/\bfull[\s-]?marathon\b/i, "Marathon"],
  [/\bmarathon\b/i, "Marathon"],
  [/\b10\s*-?\s*k(?:m)?\b/i, "10K"],
  [/\b5\s*-?\s*k(?:m)?\b/i, "5K"]
];

function detectRecentRaceDistance(text, allowBareHalf) {
  for (var i = 0; i < RECENT_RACE_DISTANCE_RULES.length; i++) {
    if (RECENT_RACE_DISTANCE_RULES[i][0].test(text)) return RECENT_RACE_DISTANCE_RULES[i][1];
  }
  if (allowBareHalf && /(^|[^a-z])half([^a-z]|$)/i.test(text) && !/\bhalf[\s-]?marathon\b/i.test(text)) {
    return "Half marathon";
  }
  return null;
}

function detectFinishClock(text) {
  var clock = String(text).match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  if (clock) return clock[1];
  var hourMin = String(text).match(/\b(\d{1,2})\s*(?:hours?|hrs?|h)\s*(?:and\s*)?(\d{1,2})\b/i);
  if (hourMin) {
    var mins = String(hourMin[2]);
    if (mins.length < 2) mins = "0" + mins;
    return hourMin[1] + ":" + mins;
  }
  return null;
}

/**
 * Parse a loose numeric answer: strips units/words and returns the first
 * number found ("90km" → 90, "9 hrs" → 9, "around 4" → 4). Returns null
 * when no number is present at all.
 */
function parseLooseNumber(text) {
  if (text == null) return null;
  var m = String(text).match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  var n = parseFloat(m[0].replace(",", "."));
  return isFinite(n) ? n : null;
}

/**
 * Split a mixed fact+intent message. Returns the leading diagnostic
 * portion, or "" when the whole message is a product/sales question.
 */
function factPortionOfMixedMessage(text) {
  var m = String(text || "");
  var re = /[,.]?\s*(?:how much|what.?s the price|what (?:are|are the) (?:the )?inclusions|what.?s included|what do i get|what does .{0,40}include|can i cancel|how (?:do|does|can|would) (?:you|it|athlevo)|how can you help|payment methods?|payment options?|how (?:do|can) i pay|\binclusions\b)/i;
  var match = m.match(re);
  if (!match) return m;
  if (match.index === 0) return "";
  return m.slice(0, match.index);
}

function isDiagnosticDeferral(message) {
  return /^(no|nope|not yet|not now|later|maybe later|not right now|hold on)\.?$/i.test(String(message || "").trim());
}

function resumeDiagnosticAfterSales() {
  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  var field = activeSubField || (fieldGroup && fieldGroup[0]);
  if (field && isValidFieldValue(field, currentFieldData[field.id])) {
    var km = currentFieldData.weekly_mileage;
    var dependent = nextActiveDependent(fieldGroup, field.id, currentFieldData);
    if (dependent) {
      presentDependentField(dependent);
      return;
    }
    var nextIdx = Math.floor(currentSubStep) + 1;
    var nextGroup = subStepFields[nextIdx];
    var nextField = nextGroup && nextGroup[0];
    if (nextField && nextField.id === "weekly_hours" && km != null && km !== "") {
      showAthlevoBubbles(
        "No problem. You mentioned you're around " + Math.round(Number(km)) + " km/week — roughly how many hours does that usually take?",
        null,
        true
      );
      presentSubStep(nextIdx, false);
      return;
    }
    activeSubField = null;
    advanceAfterChip();
    return;
  }
  restoreCurrentFieldInput();
}

/** Find a field definition (by id) anywhere in the real question bank. */
function findFieldDef(fieldId) {
  var qs = (root.AthlevoDiagnostic && root.AthlevoDiagnostic.getQuestions) ? root.AthlevoDiagnostic.getQuestions() : [];
  for (var i = 0; i < qs.length; i++) {
    for (var j = 0; j < qs[i].fields.length; j++) {
      if (qs[i].fields[j].id === fieldId) return qs[i].fields[j];
    }
  }
  return null;
}

/** Whether `value` satisfies the real constraints of `field` (never trust
 * an extracted value that wouldn't also pass the engine's own rules). */
function isValidFieldValue(field, value) {
  if (value == null || value === "") return false;
  if (field.options) {
    var vals = field.options.map(function (o) { return String(o.value); });
    return vals.indexOf(String(value)) >= 0;
  }
  if (field.type === "number") {
    var n = Number(value);
    if (!isFinite(n)) return false;
    if (field.min != null && n < field.min) return false;
    if (field.max != null && n > field.max) return false;
    return true;
  }
  if (field.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  if (field.maxLength) return String(value).length <= field.maxLength;
  return true;
}

/**
 * Scan a whole free-text message for every diagnostic fact it confidently
 * contains. `currentField`/`currentQuestion` provide context — a bare
 * number typed for the field on screen is trusted even without a unit
 * word, exactly like the pre-existing per-step behaviour; everywhere else
 * a unit/keyword is required so ambiguous numbers are never guessed at.
 */
function extractDiagnosticFacts(message, currentField, currentQuestion) {
  var facts = {};
  if (!message) return facts;
  var text = String(message);
  var currentId = currentField && currentField.id;
  var factPortion = factPortionOfMixedMessage(text);
  var weekCtx = WEEK_CONTEXT_RE.test(text) || WEEK_CONTEXT_RE.test(factPortion);

  // Weekly distance (km) — supports a simple range ("40-50km" → midpoint).
  var trustDistance = weekCtx || currentId === "weekly_mileage";
  if (trustDistance) {
    var distRange = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?|kms?)\b/i);
    if (distRange) {
      var lo = parseFloat(distRange[1]), hi = parseFloat(distRange[2]);
      if (isFinite(lo) && isFinite(hi)) facts.weekly_mileage = Math.round(((lo + hi) / 2) * 10) / 10;
    } else {
      var distMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?|kms?)\b/i);
      if (distMatch) facts.weekly_mileage = parseFloat(distMatch[1]);
      else if (currentId === "weekly_mileage" && String(factPortion).trim()) {
        var bare = parseLooseNumber(factPortion);
        if (bare != null) facts.weekly_mileage = bare;
      }
    }
  }

  // Weekly hours.
  var trustHours = weekCtx || currentId === "weekly_hours";
  if (trustHours) {
    var hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr)\b/i);
    if (hoursMatch) facts.weekly_hours = parseFloat(hoursMatch[1]);
    else if (currentId === "weekly_hours" && String(factPortion).trim()) {
      var bareH = parseLooseNumber(factPortion);
      if (bareH != null) facts.weekly_hours = bareH;
    }
  }

  // Training days per week.
  var trustDays = weekCtx || currentId === "training_days";
  if (trustDays) {
    var daysMatch = text.match(/\b(\d)\s*(?:-\s*\d)?\s*days?\b/i);
    if (daysMatch) {
      var d = parseInt(daysMatch[1], 10);
      facts.training_days = d;
    } else if (currentId === "training_days" && String(factPortion).trim()) {
      var bareD = parseLooseNumber(factPortion);
      if (bareD != null) facts.training_days = bareD;
    }
  }

  if (currentField && currentField.type === "number" && currentId &&
      !Object.prototype.hasOwnProperty.call(facts, currentId) &&
      String(factPortion).trim()) {
    var genericBare = parseLooseNumber(factPortion);
    if (genericBare != null) facts[currentId] = genericBare;
  }

  // Goal finish time ("sub 4", "sub-3:45").
  var timeMatch = text.match(GOAL_TIME_RE);
  if (timeMatch) {
    facts.goal_time = "sub-" + timeMatch[1] + ":" + (timeMatch[2] || "00");
  }

  var onRecentRace = currentId === "recent_race_dist" || currentId === "recent_race_time" ||
    (currentQuestion && currentQuestion.key === "recent_performance");
  var finishClock = detectFinishClock(text);
  var recentDist = detectRecentRaceDistance(text, onRecentRace || !!finishClock);
  if (recentDist && (onRecentRace || finishClock)) {
    facts.recent_race_dist = recentDist;
  }
  if (finishClock && (onRecentRace || recentDist || currentId === "recent_race_time")) {
    facts.recent_race_time = finishClock;
  }

  // Race name ("Pampanga Marathon", "Chicago Half Marathon").
  var raceMatch = text.match(RACE_NAME_RE);
  if (raceMatch) facts.goal_race = raceMatch[1].trim();

  // Race date, embedded anywhere in the message.
  var dateSubstr = null;
  var md = text.match(MONTH_DAY_RE);
  if (md) {
    dateSubstr = md[1] + " " + md[2] + (md[3] ? " " + md[3] : "");
  } else {
    var dm = text.match(DAY_MONTH_RE);
    if (dm) dateSubstr = dm[2] + " " + dm[1] + (dm[3] ? " " + dm[3] : "");
  }
  if (dateSubstr) {
    var parsedDate = parseNaturalDate(dateSubstr);
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsedDate)) facts.goal_race_date = parsedDate;
  }

  // Goal distance keywords ("marathon", "half marathon", "5k"...). The
  // numeric forms ("50k", "10k") only count outside a weekly-volume
  // sentence, so "40-50km per week" is never misread as an Ultra goal.
  // A recent-result distance already claimed above is not also a new goal.
  if (!(facts.recent_race_dist && (onRecentRace || finishClock) && currentId !== "goal_distance")) {
    var goalRuleSets = weekCtx ? [GOAL_DISTANCE_WORD_RULES] : [GOAL_DISTANCE_WORD_RULES, GOAL_DISTANCE_NUMERIC_RULES];
    outerGoalRules:
    for (var gs = 0; gs < goalRuleSets.length; gs++) {
      var rules = goalRuleSets[gs];
      for (var gi = 0; gi < rules.length; gi++) {
        if (rules[gi][0].test(text)) {
          facts.goal_distance = rules[gi][1];
          break outerGoalRules;
        }
      }
    }
  }

  // Recent consistency — natural sentences, not just chip labels.
  if (currentId === "recent_consistency" || /\b(consistent(?:ly)?|consistency|occasional|on and off|every week|missed a week|haven'?t been running)\b/i.test(text)) {
    if (/\b(no consistent|haven'?t been running|not been running|zero consistency)\b/i.test(text)) {
      facts.recent_consistency = "none";
    } else if (/\b(occasional|on and off|inconsistent|sporadic|now and then|when i can)\b/i.test(text)) {
      facts.recent_consistency = "occasional";
    } else if (/\b(pretty consistent|mostly consistent|fairly consistent|quite consistent|except (for )?(one |a )?(break|week)|missed a week)\b/i.test(text)) {
      facts.recent_consistency = "mostly_consistent";
    } else if (/\b(every week|very consistent|haven'?t missed|consistent every)\b/i.test(text)) {
      facts.recent_consistency = "consistent";
    } else if (/\bconsistent(?:ly)?\b/i.test(text)) {
      facts.recent_consistency = "mostly_consistent";
    }
  }

  // Training structure — only when clearly described.
  if (currentId === "training_structure" || /\b(guess|random|no plan|not structured|unstructured|mostly easy|long run|intervals|tempo)\b/i.test(text)) {
    if (/guess (what |which )?(workout|session|run)|don'?t know what (workout|to (run|do|train))/i.test(text) || /\brandom runs\b/i.test(text)) {
      facts.training_structure = "random";
    } else if (/mostly easy/i.test(text)) {
      facts.training_structure = "mostly_easy";
    } else if (/easy.{0,24}long run/i.test(text) && !/tempo|interval/i.test(text)) {
      facts.training_structure = "easy_long";
    } else if (/\b(tempo|interval)/i.test(text)) {
      facts.training_structure = "balanced_quality";
    } else if (/when i have a race|race only/i.test(text)) {
      facts.training_structure = "race_only";
    } else if (currentId === "training_structure" && /not structured|don'?t know if .{0,40}structur/i.test(text)) {
      facts.training_structure = "random";
    }
  }

  // Finish time when that dependent field is actually on screen, if the
  // compound recent-result parser above did not already capture a clock.
  if (currentId === "recent_race_time" && !facts.recent_race_time) {
    var clock = text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    if (clock) facts.recent_race_time = clock[1];
  }

  // Drop anything that wouldn't actually pass the real field's own rules.
  for (var fid in facts) {
    if (!Object.prototype.hasOwnProperty.call(facts, fid)) continue;
    var def = findFieldDef(fid);
    if (!def || !isValidFieldValue(def, facts[fid])) delete facts[fid];
  }

  return facts;
}

/**
 * Store extracted facts for later questions. `skipFieldId` is the field
 * currently on screen — handled directly by the caller, never stashed.
 * A fact is never allowed to override an answer the engine already has.
 */
function mergeFactStore(facts, skipFieldId) {
  for (var key in facts) {
    if (!Object.prototype.hasOwnProperty.call(facts, key)) continue;
    if (key === skipFieldId) continue;
    if (engine && engine.known && engine.known[key]) continue;
    factStore[key] = facts[key];
  }
}

/** Pull a pending fact for one field, consuming it. Never overrides a
 * value the current sub-step already has. */
function consumeFactForField(f) {
  var existing = currentFieldData[f.id];
  if (existing != null && existing !== "") return undefined;
  if (Object.prototype.hasOwnProperty.call(factStore, f.id)) {
    var v = factStore[f.id];
    delete factStore[f.id];
    return v;
  }
  return undefined;
}

/** Copy any pending extracted facts for this compound group into the
 * in-progress answers so a later dependent field is not re-asked. */
function absorbGroupFacts(fieldGroup) {
  if (!fieldGroup) return;
  for (var i = 0; i < fieldGroup.length; i++) {
    var f = fieldGroup[i];
    if (!f || Object.prototype.hasOwnProperty.call(currentFieldData, f.id)) continue;
    var pending = consumeFactForField(f);
    if (pending !== undefined) currentFieldData[f.id] = pending;
  }
}

/** showWhen check against an arbitrary data object (factStore simulation),
 * distinct from checkShowWhen() which always reads currentFieldData. */
function checkShowWhenAgainst(cond, data) {
  for (var fieldId in cond) {
    if (!cond.hasOwnProperty(fieldId)) continue;
    var val = data[fieldId];
    var expected = cond[fieldId];
    if (Array.isArray(expected)) {
      if (expected.indexOf(val) < 0) return false;
    } else if (val !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * If every currently-visible required field of `q` already has a valid
 * value sitting in factStore, return the answers object ready to hand
 * straight to engine.recordAnswer(). Returns null when the question still
 * needs to be asked (nothing extracted at all, or a required field is
 * still missing).
 */
function questionFullyKnownFromFacts(q) {
  var sim = {};
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (f.showWhen && !checkShowWhenAgainst(f.showWhen, sim)) continue;
    if (Object.prototype.hasOwnProperty.call(factStore, f.id) && isValidFieldValue(f, factStore[f.id])) {
      sim[f.id] = factStore[f.id];
    }
  }
  var hasAny = false;
  for (var k in sim) { if (Object.prototype.hasOwnProperty.call(sim, k)) { hasAny = true; break; } }
  if (!hasAny) return null;

  for (var j = 0; j < q.fields.length; j++) {
    var field = q.fields[j];
    if (field.showWhen && !checkShowWhenAgainst(field.showWhen, sim)) continue;
    if (field.required) {
      var v = sim[field.id];
      var empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) return null;
    }
  }
  return sim;
}

/** Drop any leftover pending facts for a question once it's been recorded
 * (avoids a stale extracted value resurfacing after the runner changes
 * their answer, e.g. via Back). */
function clearConsumedFacts(q) {
  for (var i = 0; i < q.fields.length; i++) delete factStore[q.fields[i].id];
}

function conversationalNumberPrompt(field) {
  var label = field && field.label ? field.label.toLowerCase() : "that";
  var example = field && field.placeholder ? field.placeholder.replace(/^e\.g\.\s*/i, "") : null;
  return "Got it — could you give me " + label + " as a number" + (example ? " (e.g. " + example + ")" : "") + "?";
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
  clearConsumedFacts(q);

  trackEvent("diagnostic_question_answered", {
    question_key: q.key,
    questions_completed: engine.history.length
  });

  updateProgress();

  // Show interpretation inline, then advance — silently auto-answering
  // any upcoming question the runner already told us about instead of
  // re-asking it.
  (async function () {
    var thread = getThread();
    if (interpretation && thread) {
      await delay(MSG_DELAY);
      await showTypingThenMessage(thread, interpretation);
    }
    await advanceFlow(thread);
  })();
}

/**
 * Move forward from "no active question" toward either completion or the
 * next question that genuinely still needs to be asked. Any question
 * that's already fully answerable from previously extracted free-text
 * facts is recorded silently (its interpretation still shown) instead of
 * being re-asked.
 */
async function advanceFlow(thread) {
  thread = thread || getThread();
  for (;;) {
    if (engine.canComplete()) {
      completeDiagnostic();
      return;
    }

    var next = engine.nextQuestion();
    if (!next) return;

    var autoAnswers = questionFullyKnownFromFacts(next);
    if (autoAnswers) {
      for (var fid in autoAnswers) {
        if (Object.prototype.hasOwnProperty.call(autoAnswers, fid)) delete factStore[fid];
      }
      var interp2 = engine.recordAnswer(next.key, autoAnswers);
      if (interp2) interpretationCache[next.key] = interp2;
      trackEvent("diagnostic_question_answered", {
        question_key: next.key,
        questions_completed: engine.history.length,
        autofilled: true
      });
      updateProgress();
      if (interp2 && thread) {
        await delay(MSG_DELAY);
        await showTypingThenMessage(thread, interp2);
      }
      continue; // look for the question after this one
    }

    await delay(MSG_DELAY);
    var subSteps = splitIntoSubSteps(next);
    var prompt = subSteps.length === 1 ? next.title : getSubStepPrompt(next, subSteps[0], 0, subSteps.length);
    if (thread) await showTypingThenMessage(thread, prompt);
    presentQuestion(next);
    return;
  }
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
      if (!isFinite(n)) return conversationalNumberPrompt(f);
      if (f.min != null && n < f.min) return "That seems low for " + (f.label ? f.label.toLowerCase() : "this") + " — should be at least " + f.min + ".";
      if (f.max != null && n > f.max) return "That seems high for " + (f.label ? f.label.toLowerCase() : "this") + " — should be " + f.max + " or less.";
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
          var returnedFromCheckout = root.AthlevoDiagnosticAcquisition &&
            typeof root.AthlevoDiagnosticAcquisition.hasCheckoutReturn === "function" &&
            root.AthlevoDiagnosticAcquisition.hasCheckoutReturn();
          if (returnedFromCheckout) {
            if (typeof root.showCheckoutReturnWelcome === "function") {
              root.showCheckoutReturnWelcome();
            } else if (typeof root.openAiSignup === "function") {
              root.openAiSignup();
            } else if (typeof root.openAppEntry === "function") {
              root.openAppEntry();
            } else {
              showScreen("screen-welcome");
            }
            return;
          }
          // Account-before-payment: never open Whop from the result CTA.
          if (typeof root.openAiSignup === "function") {
            root.openAiSignup();
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
  getEngine: function () { return engine; },
  // Pure helpers exposed for regression testing only (Node/module.exports
  // consumers). Never relied on by the browser runtime itself beyond what
  // the functions above already use internally.
  _internal: {
    nextActiveDependent: nextActiveDependent,
    splitIntoSubSteps: splitIntoSubSteps,
    checkShowWhenAgainst: checkShowWhenAgainst,
    extractDiagnosticFacts: extractDiagnosticFacts,
    parseLooseNumber: parseLooseNumber,
    factPortionOfMixedMessage: factPortionOfMixedMessage,
    isDiagnosticDeferral: isDiagnosticDeferral,
    decideSalesFollowup: decideSalesFollowup,
    isValidFieldValue: isValidFieldValue,
    tryMapTextToValue: tryMapTextToValue,
    absorbGroupFacts: absorbGroupFacts,
    detectRecentRaceDistance: detectRecentRaceDistance,
    detectFinishClock: detectFinishClock
  }
};

root.AthlevoDiagnosticUI = DiagnosticUI;

if (typeof module !== "undefined" && module.exports) {
  module.exports = DiagnosticUI;
}

})(typeof window !== "undefined" ? window : this);
