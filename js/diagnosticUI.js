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
 *  REUSES: diagnostic engine (diagnostic.js). Acquisition intent only
 *  changes the opening conversation; it does not grant access.
 *  DOES NOT TOUCH: Authentication, Supabase, subscriptions, onboarding,
 *  existing navigation, payment config, or entitlement logic.
 */

(function (root) {
"use strict";

/* ═══════════════════════════ CONSTANTS ═══════════════════════════════ */

var MSG_DELAY = 250;        // ms between sequential Athlevo messages
var TYPING_DELAY = 400;     // ms for typing indicator before message
var RESULT_THINK_DELAY = 1600; // ms of dots-only wait before the result card
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
var DEAD_STATE_RETRY_LABEL = "Continue";
var DEAD_STATE_RETRY_VALUE = "__retry_diagnostic";
var DEAD_STATE_MESSAGE = "I still need a bit more to continue. Tell me a little more about your running, or tap Continue.";

function applyComposerBusyUi() {
  var send = document.getElementById("chatSend");
  var input = getComposerInput();
  var composer = getComposer();
  if (send) {
    send.disabled = busy;
    send.setAttribute("aria-disabled", busy ? "true" : "false");
    send.setAttribute("aria-busy", busy ? "true" : "false");
    send.setAttribute("aria-label", busy ? "Athlevo is responding" : "Send");
    if (busy) send.classList.add("is-busy");
    else send.classList.remove("is-busy");
  }
  if (input) {
    input.disabled = busy;
    input.setAttribute("aria-disabled", busy ? "true" : "false");
  }
  if (composer) {
    composer.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) composer.classList.add("is-busy");
    else composer.classList.remove("is-busy");
  }
}

function setDiagnosticBusy(next) {
  busy = !!next;
  applyComposerBusyUi();
}
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
var resultSequenceStarted = false;

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
var skipCannedInterpretations = false;
var diagnosticStartedFired = false;
var diagnosticCompletedFired = false;
var diagnosticAcquisitionActive = false;

function resetSkipCannedInterpretations() {
  skipCannedInterpretations = false;
}

/* Genuine start = at least one recorded diagnostic answer (chip/text),
 * not engine.begin(), greeting paint, or silent autofill. Autofill may
 * write history later; callers must prime this flag BEFORE autofill. */
function hasRecordedDiagnosticAnswers(eng) {
  eng = eng || engine;
  if (!eng) return false;
  if (eng.completed) return true;
  return Array.isArray(eng.history) && eng.history.length > 0;
}

function primeDiagnosticStartedFromEngine(eng) {
  diagnosticStartedFired = hasRecordedDiagnosticAnswers(eng || engine);
}

function currentAcquisitionIntent() {
  try {
    if (engine && engine.acquisitionIntent) {
      return root.AthlevoDiagnostic && AthlevoDiagnostic.resolveAcquisitionIntent
        ? AthlevoDiagnostic.resolveAcquisitionIntent(engine.acquisitionIntent)
        : String(engine.acquisitionIntent);
    }
  } catch (e) {}
  try {
    if (root.AthlevoDiagnostic && typeof AthlevoDiagnostic.readAcquisitionIntentFromLocation === "function") {
      return AthlevoDiagnostic.readAcquisitionIntentFromLocation(root.location);
    }
  } catch (e2) {}
  return "general";
}

function acquisitionAnalyticsProps(extra) {
  var props = extra && typeof extra === "object" ? extra : {};
  var intent = currentAcquisitionIntent();
  if (intent) props.acquisition_intent = intent;
  return props;
}

function trackDiagnosticStep(question, opts) {
  opts = opts || {};
  if (!question || !question.key) return;
  var answerType = opts.answerType === "text" || opts.answerType === "skip" ||
    opts.answerType === "autofill" ? opts.answerType : "chip";
  var stage = "capacity";
  if (question.key === "goal" || question.key === "race_details") stage = "goal";
  else if (question.key === "injury_status") stage = "safety";
  else if (question.key === "training_days" || question.key === "training_structure" ||
      question.key === "schedule" || question.key === "other_training" ||
      question.key === "current_running_frequency") stage = "training";
  else if (question.key === "perceived_limiter") stage = "limiter";
  var props = acquisitionAnalyticsProps({
    step: engine && Array.isArray(engine.history) ? engine.history.length : 0,
    question_id: String(question.key).slice(0, 80),
    answer_type: answerType,
    diagnostic_stage: stage
  });
  var answerId = opts.answerId;
  if (typeof answerId === "string" && /^[a-z0-9_]{1,40}$/.test(answerId)) {
    props.answer_id = answerId;
  }
  trackEvent("diagnostic_step_completed", props);
}

function inferDiagnosticAnswerType(q, data) {
  if (!q || !q.fields || !data) return "chip";
  var hasChip = false;
  var hasText = false;
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (!Object.prototype.hasOwnProperty.call(data, f.id)) continue;
    if (f.type === "chips" || f.type === "multichips") hasChip = true;
    else hasText = true;
  }
  if (hasChip && !hasText) return "chip";
  if (hasText && !hasChip) return "text";
  return hasChip ? "chip" : "text";
}

function normalizedChipAnswerId(q, data) {
  if (!q || !q.fields || !data) return undefined;
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (f.type !== "chips" && f.type !== "multichips") continue;
    var v = data[f.id];
    if (typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v)) return v;
  }
  return undefined;
}

function markDiagnosticStarted(inputType) {
  if (diagnosticStartedFired) return;
  diagnosticStartedFired = true;
  var utm = {};
  try {
    if (root.AthlevoProductAnalytics && typeof root.AthlevoProductAnalytics.attributionProps === "function") {
      utm = root.AthlevoProductAnalytics.attributionProps() || {};
    }
  } catch (e) { utm = {}; }
  trackEvent("diagnostic_started", acquisitionAnalyticsProps({
    first_input_type: inputType === "chip" ? "chip" : "text",
    acquisition_source: utm.utm_source || undefined
  }));
}

function trackAiLandingViewed() {
  var path = "/ai";
  try { path = String(root.location && root.location.pathname || "/ai").replace(/\/+$/, "") || "/ai"; }
  catch (e) { path = "/ai"; }
  var props = acquisitionAnalyticsProps({ path: path, page_path: path });
  try {
    if (root.AthlevoProductAnalytics && typeof root.AthlevoProductAnalytics.landingProps === "function") {
      var landing = root.AthlevoProductAnalytics.landingProps() || {};
      if (landing.referrer) props.referrer = landing.referrer;
      if (landing.page_path) props.page_path = landing.page_path;
    }
    var utm = root.AthlevoProductAnalytics && root.AthlevoProductAnalytics.attributionProps
      ? root.AthlevoProductAnalytics.attributionProps() : {};
    if (utm && utm.utm_source) props.source = utm.utm_source;
  } catch (e) {}
  trackEvent("ai_landing_viewed", props);
}

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
    diagnosticAcquisitionActive = false;
    if (typeof root.routeAfterAuth === "function") {
      return root.routeAfterAuth(root.athlevoSessionUserId);
    }
    return;
  }

  if (typeof root.hasReturningAthlevoAccountMarker === "function" &&
      root.hasReturningAthlevoAccountMarker()) {
    diagnosticAcquisitionActive = false;
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
    diagnosticAcquisitionActive = false;
    if (typeof root.showCheckoutReturnWelcome === "function") {
      root.showCheckoutReturnWelcome();
    } else if (typeof root.openAppEntry === "function") {
      root.openAppEntry();
    } else {
      showScreen("screen-welcome");
    }
    return;
  }

  /* restoreSession may call start() again after an early anonymous /ai
     start. If the acquisition chat is already showing, do not rebuild
     the shell or re-fire view events. If we already left this surface,
     allow a later anonymous start (e.g. after logout). */
  if (diagnosticAcquisitionActive) {
    var shown = document.getElementById("screen-diagnostic");
    if (!shown || (shown.classList && shown.classList.contains("active"))) {
      return;
    }
    diagnosticAcquisitionActive = false;
  }

  var pending = root.AthlevoDiagnostic && root.AthlevoDiagnostic.load();
  if (pending && !pending.completed) {
    engine = pending;
  } else if (pending && pending.completed) {
    engine = pending;
    resultSequenceStarted = true;
    showScreen("screen-diagnostic");
    buildChatShell();
    renderResult({ restored: true });
    trackAiLandingViewed();
    primeDiagnosticStartedFromEngine(engine);
    diagnosticCompletedFired = true;
    trackEvent("diagnostic_resumed", { state: "completed" });
    diagnosticAcquisitionActive = true;
    return;
  } else {
    engine = root.AthlevoDiagnostic.create();
    resultSequenceStarted = false;
  }

  try {
    if (engine && typeof engine.applyAcquisitionIntent === "function") {
      var liveIntent = root.AthlevoDiagnostic &&
        typeof AthlevoDiagnostic.readAcquisitionIntentFromLocation === "function"
        ? AthlevoDiagnostic.readAcquisitionIntentFromLocation(root.location)
        : "general";
      engine.applyAcquisitionIntent(liveIntent);
    }
  } catch (intentErr) {}

  restoreFactStoreFromEngine();

  showScreen("screen-diagnostic");
  interpretationCache = {};
  recentTurns = [];
  salesState = getSales() ? getSales().emptySalesState() : null;
  awaitingSalesFollowup = false;
  buildChatShell();
  trackAiLandingViewed();

  if (!engine.begun) {
    engine.begin();
    diagnosticStartedFired = false;
    diagnosticCompletedFired = false;
    trackEvent("diagnostic_viewed", acquisitionAnalyticsProps({ path: "/ai", page_path: "/ai" }));
    renderConversationOpening();
  } else {
    primeDiagnosticStartedFromEngine(engine);
    trackEvent("diagnostic_resumed", { state: "in_progress" });
    commitFullyKnownPendingQuestions();
    rebuildConversation(engine.nextQuestion());
  }
  diagnosticAcquisitionActive = true;
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
      if (busy) return;
      handleComposerSend();
    }
  });
  send.addEventListener("click", function () {
    if (busy) return;
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
  removeTypingIndicator();
  var el = createEl(
    '<div class="chat-msg chat-msg-athlevo chat-typing" id="chatTyping" role="status" aria-live="polite" aria-label="Athlevo is responding">' +
      '<div class="chat-bubble chat-bubble-athlevo">' +
        '<span class="chat-typing-dots" aria-hidden="true">' +
          '<span class="chat-typing-dot"></span>' +
          '<span class="chat-typing-dot"></span>' +
          '<span class="chat-typing-dot"></span>' +
        '</span>' +
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
  container.removeAttribute("data-locked");
  var openingChips = !!(currentQuestion && currentQuestion.key === "current_running_frequency");
  if (openingChips) container.classList.add("is-opening");
  else container.classList.remove("is-opening");

  for (var i = 0; i < options.length; i++) {
    (function (opt, idx) {
      var chipClass = opt.chipClass ? "chat-qr-chip " + opt.chipClass : "chat-qr-chip";
      if (openingChips && idx === 0) chipClass += " chat-qr-first";
      var btn = createEl(
        '<button class="' + chipClass + '" type="button">' + esc(opt.label) + '</button>'
      );
      btn.addEventListener("click", function () {
        if (busy || container.getAttribute("data-locked") === "1") return;
        container.setAttribute("data-locked", "1");
        btn.classList.add("chat-qr-sel");
        var buttons = container.querySelectorAll("button");
        for (var b = 0; b < buttons.length; b++) buttons[b].disabled = true;
        onSelect(opt);
      });
      container.appendChild(btn);
    })(options[i], i);
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
    if (container.classList && container.classList.remove) container.classList.remove("is-opening");
  }
}

/* ═══════════════════════════ COMPOSER CONTROL ══════════════════════ */

function showComposer(placeholder) {
  var composer = getComposer();
  var input = getComposerInput();
  if (composer) composer.style.display = "";
  if (input) {
    input.placeholder = "Type your answer here…";
    if (!busy) input.value = "";
  }
  applyComposerBusyUi();
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

  if (currentAcquisitionIntent() === "first10k") {
    if (q.key === "current_capacity" && steps.length > 1) {
      steps.sort(function (a, b) {
        var ai = a[0] && a[0].id === "recent_longest_run_km" ? 0 : 1;
        var bi = b[0] && b[0].id === "recent_longest_run_km" ? 0 : 1;
        return ai - bi;
      });
    }
    if (q.key === "race_details" && steps.length > 1) {
      steps.sort(function (a, b) {
        var order = { goal_race_date: 0, goal_race: 1, goal_time: 2 };
        var ai = a[0] && order[a[0].id] != null ? order[a[0].id] : 9;
        var bi = b[0] && order[b[0].id] != null ? order[b[0].id] : 9;
        return ai - bi;
      });
    }
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
    if (f.id === "goal_race_date") {
      if (currentAcquisitionIntent() === "first10k") return "Do you already have a target date for your 10K?";
      return "And when is it?";
    }
    if (f.id === "goal_time") return "Any specific finish time you’re aiming for?";
  }
  if (q.key === "weekly_volume") {
    if (f.id === "weekly_mileage") return "How many kilometres are you running per week right now?";
    if (f.id === "weekly_hours") return "And roughly how many hours per week is that?";
  }
  if (q.key === "current_capacity") {
    if (f.id === "recent_consistency") return "How consistent has your running been over the last 6–8 weeks?";
    if (f.id === "recent_longest_run_km") {
      if (currentAcquisitionIntent() === "first10k") return "What’s your longest run so far?";
      return "What’s the longest run you’ve done recently?";
    }
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

  var first10k = currentAcquisitionIntent() === "first10k";
  if (first10k) {
    // Sequential reveal: messages appear one at a time with subtle entrance
    var msgs = [
      "Let's get you ready for your first 10K.",
      "I'll ask a few things about your current running and schedule para we know exactly where to start."
    ];
    var q = engine.nextQuestion();
    var steps = q ? splitIntoSubSteps(q) : [];
    var questionPrompt = q ? getSubStepPrompt(q, steps[0], 0, steps.length) : null;
    if (questionPrompt) msgs.push(questionPrompt);

    if (reducedMotion()) {
      // Reduced motion: render all immediately, no stagger
      for (var ri = 0; ri < msgs.length; ri++) {
        appendAthlevoMsg(thread, msgs[ri], true);
      }
      scrollToBottom();
      if (q) {
        currentQuestion = q;
        currentFieldData = {};
        currentSubStep = 0;
        subStepFields = steps;
        activeSubField = null;
        presentSubStepInput(subStepFields[0]);
      }
    } else {
      // Animated stagger: subtle delays between messages
      for (var si = 0; si < msgs.length; si++) {
        if (si > 0) await delay(si === 1 ? 300 : 350);
        appendAthlevoMsg(thread, msgs[si]);
        scrollToBottom();
      }
      // Small pause before revealing replies
      await delay(250);
      if (q) {
        currentQuestion = q;
        currentFieldData = {};
        currentSubStep = 0;
        subStepFields = steps;
        activeSubField = null;
        presentSubStepInput(subStepFields[0]);
      }
    }
  } else {
    await showTypingThenMessage(thread, "Hi! I'm Athlevo, your endurance coach.");
    await delay(MSG_DELAY);
    var q = engine.nextQuestion();
    if (q) {
      await presentQuestion(q, { showPrompt: true });
    }
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
async function presentQuestion(q, opts) {
  resetSkipCannedInterpretations();
  currentQuestion = q;
  currentFieldData = {};
  currentSubStep = 0;

  // Pre-fill if revisiting
  if (engine.history.indexOf(q.key) >= 0) {
    prefillFromAnswers(q);
  }

  // Split into sub-steps
  subStepFields = splitIntoSubSteps(q);

  // Opening shows the first prompt. Restore/advance already painted it.
  var showPrompt = !!(opts && opts.showPrompt);
  await presentSubStep(0, showPrompt);
}

/**
 * Present a single sub-step: show its prompt (unless skipPrompt),
 * then quick replies and/or composer.
 */
function presentSubStepInput(fieldGroup) {
  if (!fieldGroup || !fieldGroup.length) return;
  var f = fieldGroup[0];

  if (f.type === "chips" || f.type === "multichips") {
    showQuickReplies(f.options, function (opt) {
      handleChipSelect(f, opt, fieldGroup);
    });
    // Keep composer visible for opening question but show as non-interactive hint
    showComposer("Or type your answer…");
    setComposerMode("text");
  } else if (f.type === "number") {
    hideQuickReplies();
    showComposer(f.placeholder || ("e.g. " + (f.min || "0")));
    setComposerMode("number");
  } else if (f.type === "text") {
    hideQuickReplies();
    showComposer(f.placeholder || "Type here…");
    setComposerMode("text");
  }
  scrollToBottom();
}

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
  if (field.type !== "multichips" &&
      Object.prototype.hasOwnProperty.call(currentFieldData, field.id)) {
    return;
  }
  setDiagnosticBusy(true);

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
    setDiagnosticBusy(false);
    return;
  }

  // Single select
  markDiagnosticStarted("chip");
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
    setDiagnosticBusy(false);
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
    setDiagnosticBusy(true);
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
  setDiagnosticBusy(true);
  markDiagnosticStarted("chip");
  var thread = getThread();

  hideQuickReplies();
  if (thread) appendUserMsg(thread, opt.label);
  scrollToBottom();

  if (opt.value === "__race_no") {
    // Skip all race_details fields — submit empty
    currentFieldData.goal_race = "";
    currentFieldData.goal_race_date = "";
    currentFieldData.goal_time = "";
    setDiagnosticBusy(false);
    submitCurrentQuestion();
    return;
  }

  // "Yes" — skip any race-detail fields already in factStore.
  setDiagnosticBusy(false);
  proceedRaceDetails();
}

function handleSkip(field) {
  if (busy) return;
  setDiagnosticBusy(true);
  markDiagnosticStarted("chip");

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
 * chip aliases, numbers). After a successful extract, natural-language
 * turns may also call the router for leftover NLU + acknowledgement.
 * Chip taps never reach this function. The model never owns checkout,
 * completion, or the next question.
 */
function handleComposerSend() {
  if (busy) return;
  var input = getComposerInput();
  if (!input) return;

  var val = input.value.trim();
  if (!val) return;

  markDiagnosticStarted("text");
  setDiagnosticBusy(true);
  input.value = "";

  var thread = getThread();
  var q = currentQuestion;
  var Sales = getSales();

  rememberTurn("athlete", val);
  if (thread) appendUserMsg(thread, val);
  hideQuickReplies();
  scrollToBottom();

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
      hideQuickReplies();
      scrollToBottom();
      awaitingSalesFollowup = false;
      setDiagnosticBusy(false);
      resumeDiagnosticAfterSales();
      return;
    }
    /* "sales" continues into the existing high-confidence detour.
       "field" continues into the diagnostic parser. */
  }

  var highConfidenceSales = classification && classification.confidence >= 0.7;
  if (highConfidenceSales) {
    hideQuickReplies();
    scrollToBottom();
    handleSalesDetour(classification, val, extraPains);
    return;
  }
  if (!classification && extraPains.length && Sales &&
      Sales.composeSalesReply(null, engine, salesState || Sales.emptySalesState(), extraPains)) {
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
    var nameDef = findFieldDef("goal_race");
    if (!isValidFieldValue(nameDef, currentFieldData.goal_race)) {
      currentFieldData.goal_race = val;
    }
    hideQuickReplies();
    scrollToBottom();
    continueAfterOptionalAcknowledgement(val, nameDef, q, null, function () {
      setDiagnosticBusy(false);
      proceedRaceDetails();
    });
    return;
  }

  if (q && q.key === "race_details" && currentSubStep === 0.6) {
    var parsedDate = parseNaturalDate(val);
    var dateDef = findFieldDef("goal_race_date");
    if (isValidFieldValue(dateDef, parsedDate)) {
      currentFieldData.goal_race_date = parsedDate;
    } else if (!isValidFieldValue(dateDef, currentFieldData.goal_race_date)) {
      currentFieldData.goal_race_date = parsedDate;
    }
    hideQuickReplies();
    scrollToBottom();
    continueAfterOptionalAcknowledgement(val, dateDef, q, null, function () {
      setDiagnosticBusy(false);
      proceedRaceDetails();
    });
    return;
  }

  if (q && q.key === "race_details" && currentSubStep === 0.7) {
    var mappedTime = NUMERIC_ALIASES[val.toLowerCase()] || val;
    currentFieldData.goal_time = mappedTime;
    hideQuickReplies();
    scrollToBottom();
    continueAfterOptionalAcknowledgement(val, findFieldDef("goal_time"), q, null, function () {
      setDiagnosticBusy(false);
      submitCurrentQuestion();
    });
    return;
  }

  if (!q) {
    applyExtractedFacts(extractDiagnosticFacts(val, null, null), null);
    setDiagnosticBusy(false);
    advanceFlow(thread);
    return;
  }

  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  if (!fieldGroup) {
    applyExtractedFacts(extractDiagnosticFacts(val, null, q), null);
    setDiagnosticBusy(false);
    advanceFlow(thread);
    return;
  }
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
      setDiagnosticBusy(false);
      presentDependentField(dependent);
      return;
    }
    activeSubField = null;
    advanceAfterChip();
  }

  function commitCurrent(value) {
    awaitingSalesFollowup = false;
    currentFieldData[field.id] = value;
    if (shouldCallAiAcknowledgement(val, field, q)) {
      hideQuickReplies();
      scrollToBottom();
      continueAfterOptionalAcknowledgement(val, field, q, fieldGroup, afterFieldCommitted);
      return;
    }
    if (extraPains.length && Sales) {
      salesState = Sales.applySalesSignals(salesState || Sales.emptySalesState(), null, extraPains, Sales.hasMinimumContext(engine));
      var painReply = Sales.composeSalesReply(null, engine, salesState, extraPains);
      if (painReply && Sales.hasMinimumContext(engine)) {
        hideQuickReplies();
        showAthlevoBubbles(painReply.reply, painReply.reply_2, true);
        salesState = Sales.markValueShown(salesState);
        trackEvent("diagnostic_value_demonstrated", { buyer_intent: "curious" });
        setDiagnosticBusy(false);
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
      setDiagnosticBusy(false);
      restoreCurrentFieldInput();
      return;
    }
    hideQuickReplies();
    scrollToBottom();
    if (Sales && Sales.looksLikeAQuestion(val)) {
      routeViaAi(val, field, q, fieldGroup);
      return;
    }
    if (shouldCallAiAcknowledgement(val, field, q)) {
      routeViaAiAcknowledgement(val, field, q, fieldGroup, function () {
        if (isValidFieldValue(field, currentFieldData[field.id])) {
          afterFieldCommitted();
          return;
        }
        setDiagnosticBusy(false);
        restoreCurrentFieldInput();
      });
      return;
    }
    if (Sales && Sales.shouldUseAiFallback(val, field, null)) {
      routeViaAi(val, field, q, fieldGroup);
      return;
    }
    showChipClarification(field);
    setDiagnosticBusy(false);
    restoreCurrentFieldInput();
    return;
  }

  if (field.type === "number") {
    if (Sales && Sales.looksLikeAQuestion(val)) {
      hideQuickReplies();
      scrollToBottom();
      routeViaAi(val, field, q, fieldGroup);
      return;
    }
    var n = parseLooseNumber(factPortionOfMixedMessage(val) || val);
    if (n === null) {
      if (awaitingSalesFollowup) {
        awaitingSalesFollowup = false;
        setDiagnosticBusy(false);
        restoreCurrentFieldInput();
        return;
      }
      if (shouldCallAiAcknowledgement(val, field, q)) {
        hideQuickReplies();
        scrollToBottom();
        routeViaAiAcknowledgement(val, field, q, fieldGroup, function () {
          if (isValidFieldValue(field, currentFieldData[field.id])) {
            afterFieldCommitted();
            return;
          }
          setDiagnosticBusy(false);
          restoreCurrentFieldInput();
        });
        return;
      }
      showValidationMsg(conversationalNumberPrompt(field));
      setDiagnosticBusy(false);
      return;
    }
    if (field.min != null && n < field.min) {
      showValidationMsg("That seems low — " + (field.label || "this") + " should be at least " + field.min + ".");
      setDiagnosticBusy(false);
      return;
    }
    if (field.max != null && n > field.max) {
      showValidationMsg("That seems high — " + (field.label || "this") + " should be " + field.max + " or less.");
      setDiagnosticBusy(false);
      return;
    }
    commitCurrent(n);
    return;
  }

  if (Sales && Sales.looksLikeAQuestion(val)) {
    hideQuickReplies();
    scrollToBottom();
    routeViaAi(val, field, q, fieldGroup);
    return;
  }

  if (field.maxLength && val.length > field.maxLength) {
    showValidationMsg("Please keep it under " + field.maxLength + " characters.");
    setDiagnosticBusy(false);
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
  persistFactStore();
}

var ACK_WORTHY_RE = /\b(?:fade|fading|fall(?:s|ing)?\s+apart|blow(?:s|ing)?\s+up|hit(?:s|ting)?\s+a\s+wall|always\s+(?:fade|die|bonk)|frustrated|frustrating|because|injured|injury|niggle|limiter|sick|illness|time off)\b/i;

function hasAckWorthyContext(text) {
  var raw = String(text || "");
  if (!raw.trim()) return false;
  if (RETURNING_STATUS_RE.test(raw)) return true;
  return ACK_WORTHY_RE.test(raw);
}

function countExtractedFacts(facts) {
  var n = 0;
  if (!facts) return 0;
  for (var key in facts) {
    if (Object.prototype.hasOwnProperty.call(facts, key)) n += 1;
  }
  return n;
}

function shouldCallAiAcknowledgement(message, field, q) {
  var Sales = getSales();
  if (!Sales || typeof Sales.shouldUseAiAcknowledgement !== "function") return false;
  return Sales.shouldUseAiAcknowledgement(message, field, {
    hasAckWorthyContext: hasAckWorthyContext(message),
    extractedFactCount: countExtractedFacts(extractDiagnosticFacts(message, field, q))
  });
}

function stripModelRouting(result) {
  if (!result || typeof result !== "object") return result;
  var out = {};
  for (var key in result) {
    if (Object.prototype.hasOwnProperty.call(result, key)) out[key] = result[key];
  }
  out.show_checkout = false;
  out.suggested_question_key = null;
  if (out.next_action === "show_checkout" ||
      out.next_action === "complete_diagnostic" ||
      out.next_action === "handoff_to_existing_flow") {
    out.next_action = "continue_diagnostic";
  }
  return out;
}

function storeModelReasoningFromResult(result) {
  if (!engine || typeof engine.setModelReasoning !== "function") return;
  if (!result || result.usedFallback) return;
  var Sales = getSales();
  var reasoning = Sales && typeof Sales.validateDiagnosticReasoning === "function"
    ? Sales.validateDiagnosticReasoning(result)
    : null;
  if (!reasoning) return;
  var hasJudgment = !!(reasoning.primary_limiter || reasoning.diagnostic_summary ||
    reasoning.recommended_direction || reasoning.expectation);
  if (!hasJudgment && typeof engine.getModelReasoning === "function" && engine.getModelReasoning()) {
    return;
  }
  engine.setModelReasoning(reasoning);
}

function isUsableAcknowledgement(result) {
  if (!result || result.usedFallback) return false;
  var reply = String(result.reply || "").trim();
  if (!reply) return false;
  if (/i want to make sure i understand you correctly/i.test(reply)) return false;
  return true;
}

function acknowledgementText(result) {
  if (!isUsableAcknowledgement(result)) return "";
  var text = String(result.reply || "").trim();
  text = text.replace(
    /(?:\n|\s)+((?:what(?:'s| is)|how many|when is|which|could you (?:tell|give|share)|what(?:'s| is) your).{0,120}\??)\s*$/i,
    ""
  ).trim();
  return text;
}

function mergeAiExtractedFacts(facts, message, currentFieldId) {
  if (!facts) return;
  var copy = {};
  for (var key in facts) {
    if (!Object.prototype.hasOwnProperty.call(facts, key)) continue;
    if (engine && engine.known && engine.known[key]) continue;
    if (Object.prototype.hasOwnProperty.call(factStore, key)) continue;
    if (Object.prototype.hasOwnProperty.call(currentFieldData, key) &&
        currentFieldData[key] != null && currentFieldData[key] !== "") continue;
    copy[key] = facts[key];
  }
  if (RETURNING_STATUS_RE.test(String(message || "")) &&
      !/\b(?:injur(?:y|ed)|hurt|niggle|current (?:pain|issue))\b/i.test(String(message || ""))) {
    delete copy.injury_has;
    delete copy.injury_area;
  }
  applyExtractedFacts(copy, currentFieldId);
}

function continueAfterOptionalAcknowledgement(message, field, q, fieldGroup, onContinue) {
  if (!shouldCallAiAcknowledgement(message, field, q)) {
    onContinue();
    return;
  }
  routeViaAiAcknowledgement(message, field, q, fieldGroup, onContinue);
}

function routeViaAiAcknowledgement(message, field, q, fieldGroup, onContinue) {
  var Sales = getSales();
  var thread = getThread();
  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    onContinue();
  }
  if (!Sales || typeof Sales.callRouter !== "function") {
    finish();
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
  Promise.resolve(Sales.callRouter(payload)).then(function (result) {
    removeTypingIndicator();
    applyAcknowledgementResult(result, message, field, fieldGroup);
    finish();
  }, function () {
    removeTypingIndicator();
    finish();
  });
}

function applyAcknowledgementResult(result, message, field, fieldGroup) {
  result = stripModelRouting(result || {});
  mergeAiExtractedFacts(result.extracted_facts, message, field ? field.id : null);
  storeModelReasoningFromResult(result);
  var ack = acknowledgementText(result);
  if (ack) {
    skipCannedInterpretations = true;
    showAthlevoBubbles(ack, null, true);
  }
  awaitingSalesFollowup = false;
}

function handleSalesDetour(classification, message, extraPains) {
  var Sales = getSales();
  var fieldGroup = subStepFields[Math.floor(currentSubStep)] || subStepFields[0];
  var field = activeSubField || (fieldGroup && fieldGroup[0]);
  applyExtractedFacts(extractDiagnosticFacts(message, field, currentQuestion), field ? field.id : null);

  if (!Sales) {
    setDiagnosticBusy(false);
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
    setDiagnosticBusy(false);
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

  applyAnonymousConversionCopy(composed);
  showAthlevoBubbles(composed.reply, composed.reply_2, true);
  setDiagnosticBusy(false);
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
        presentConversionHandoff(ready);
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
    setDiagnosticBusy(false);
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
    try {
      trackDiagnosticAiFallback(result, q ? q.key : null);
      applyConversationalResult(result, message, field, fieldGroup);
    } catch (err) {
      setDiagnosticBusy(false);
      restoreCurrentFieldInput();
    }
  }, function () {
    removeTypingIndicator();
    setDiagnosticBusy(false);
    restoreCurrentFieldInput();
  });
}

function applyConversationalResult(result, message, field, fieldGroup) {
  var Sales = getSales();
  result = result || (Sales && Sales.FALLBACK_RESPONSE);
  if (!result) {
    setDiagnosticBusy(false);
    restoreCurrentFieldInput();
    return;
  }

  result = stripModelRouting(result);
  mergeAiExtractedFacts(result.extracted_facts, message, field ? field.id : null);
  storeModelReasoningFromResult(result);
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
    if (result.intent && result.intent !== "diagnostic_answer" && result.intent !== "unknown") {
      trackEvent("diagnostic_buyer_intent_detected", {
        buyer_intent: result.buyer_intent && result.buyer_intent !== "none" ? result.buyer_intent : "curious"
      });
    }
  }

  var salesReply = result.intent === "pricing_question" ||
    result.intent === "how_it_works" ||
    result.intent === "question_about_athlevo" ||
    result.intent === "objection" ||
    result.next_action === "recommend_athlevo" ||
    result.next_action === "explain_offer" ||
    result.next_action === "answer_then_continue";

  if (salesReply) {
    applyAnonymousConversionCopy(result);
    showAthlevoBubbles(result.reply, result.reply_2, true);
  } else {
    var ack = acknowledgementText(result);
    if (ack) {
      skipCannedInterpretations = true;
      showAthlevoBubbles(ack, null, true);
    } else if (result.reply && !result.usedFallback) {
      showAthlevoBubbles(result.reply, null, true);
    }
  }
  setDiagnosticBusy(false);

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
  resetSkipCannedInterpretations();
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

var ANON_SIGNUP_REPLY = "Great. Create your Athlevo account first so I can save your training and continue.";
var ANON_SIGNUP_CTA = "Create my Athlevo account";

function isAnonymousDiagnosticVisitor() {
  return !root.athlevoSessionUserId;
}

function applyAnonymousConversionCopy(composed) {
  if (!composed || !isAnonymousDiagnosticVisitor()) return composed;
  if (composed.show_checkout || composed.next_action === "show_checkout") {
    composed.reply = ANON_SIGNUP_REPLY;
    composed.reply_2 = null;
  }
  return composed;
}

function conversionHandoffOptions() {
  if (isAnonymousDiagnosticVisitor()) {
    return [{
      label: ANON_SIGNUP_CTA,
      value: "__ai_signup",
      chipClass: "chat-qr-pay chat-qr-pay-primary"
    }];
  }
  var paymentOptions = [
    { label: "Debit / Credit Card", value: "__pay_card", chipClass: "chat-qr-pay chat-qr-pay-primary" }
  ];
  if (root.athlevoSessionUserId) {
    paymentOptions.unshift({ label: "QRPh · Maya · GrabPay", value: "__pay_local", chipClass: "chat-qr-pay" });
  }
  return paymentOptions;
}

function presentConversionHandoff(ready) {
  var composed = ready || {
    reply: "Sounds good. Choose whichever payment method is easiest for you.",
    reply_2: null,
    next_action: "show_checkout",
    show_checkout: true
  };
  applyAnonymousConversionCopy(composed);
  showAthlevoBubbles(composed.reply, composed.reply_2 || null, true);
  offerPaymentBridge();
}

function offerSignupHandoff() {
  showQuickReplies(conversionHandoffOptions(), function (opt) {
    if (opt.value === "__ai_signup") {
      beginCheckoutFromChat("signup");
      return;
    }
    setDiagnosticBusy(false);
    restoreCurrentFieldInput();
  });
  showComposer("Or type here…");
  setComposerMode("text");
}

function offerPaymentBridge() {
  /* Anonymous /ai never sees payment. Account-before-payment: the only
     conversion destination is /ai-signup. Authenticated unpaid users keep
     the existing in-chat payment chips. */
  if (isAnonymousDiagnosticVisitor()) {
    offerSignupHandoff();
    return;
  }
  trackEvent("diagnostic_payment_options_shown", { surface: "diagnostic" });
  var paymentOptions = conversionHandoffOptions();
  showQuickReplies(paymentOptions, function (opt) {
    if (opt.value === "__pay_local") {
      beginCheckoutFromChat("local");
      return;
    }
    if (opt.value === "__pay_card") {
      beginCheckoutFromChat("card");
      return;
    }
    setDiagnosticBusy(false);
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
        presentConversionHandoff(ready);
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
  setDiagnosticBusy(true);
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
      setDiagnosticBusy(false);
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
    setDiagnosticBusy(false);
    if (!opened) {
      showAthlevoBubbles("That payment option isn’t available right now. Card still works from here.", null, true);
      offerPaymentBridge();
    }
  }).catch(function () {
    checkoutOpening = false;
    setDiagnosticBusy(false);
    offerPaymentBridge();
  });
}

function takeKnownRaceDetail(fieldId) {
  var def = findFieldDef(fieldId);
  if (Object.prototype.hasOwnProperty.call(currentFieldData, fieldId)) {
    var existing = currentFieldData[fieldId];
    if (existing === "" || (def && isValidFieldValue(def, existing))) return true;
  }
  if (!def) return false;
  var preset = consumeFactForField(def);
  if (preset !== undefined) {
    currentFieldData[fieldId] = preset;
    persistFactStore();
    return true;
  }
  return false;
}

function nextMissingRaceDetailField(data, store) {
  var ids = ["goal_race", "goal_race_date", "goal_time"];
  data = data || {};
  store = store || {};
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var def = findFieldDef(id);
    if (def && isValidFieldValue(def, data[id])) continue;
    if (def && isValidFieldValue(def, store[id])) continue;
    return id;
  }
  return null;
}

function proceedRaceDetails() {
  if (!takeKnownRaceDetail("goal_race")) {
    askRaceName();
    return;
  }
  if (!takeKnownRaceDetail("goal_race_date")) {
    askRaceDate();
    return;
  }
  if (!takeKnownRaceDetail("goal_time")) {
    askGoalTime();
    return;
  }
  setDiagnosticBusy(false);
  submitCurrentQuestion();
}

function askRaceName() {
  (async function () {
    var thread2 = getThread();
    if (thread2) {
      await showTypingThenMessage(thread2, "Nice. What race are you doing?");
    }
    hideQuickReplies();
    showComposer("e.g. Cebu Marathon");
    setComposerMode("text");
    currentSubStep = 0.5;
    scrollToBottom();
  })();
}

function askRaceDate() {
  (async function () {
    await showTypingThenMessage(getThread(), "And when is it?");
    hideQuickReplies();
    var qr = getQuickReplies();
    if (qr) {
      var skipBtn = createEl('<button class="chat-qr-chip chat-qr-skip" type="button">Skip</button>');
      skipBtn.addEventListener("click", function () {
        if (busy) return;
        setDiagnosticBusy(true);
        currentFieldData.goal_race_date = "";
        if (getThread()) appendUserMsg(getThread(), "Skip");
        hideQuickReplies();
        scrollToBottom();
        setDiagnosticBusy(false);
        proceedRaceDetails();
      });
      qr.appendChild(skipBtn);
      qr.style.display = "";
    }
    showComposer("");
    setComposerMode("date");
    currentSubStep = 0.6;
    scrollToBottom();
  })();
}

function askGoalTime() {
  if (takeKnownRaceDetail("goal_time")) {
    setDiagnosticBusy(false);
    submitCurrentQuestion();
    return;
  }
  (async function () {
    await showTypingThenMessage(getThread(), "Any specific finish time you’re aiming for?");
    var qr = getQuickReplies();
    if (qr) {
      var skipBtn = createEl('<button class="chat-qr-chip chat-qr-skip" type="button">No specific goal</button>');
      skipBtn.addEventListener("click", function () {
        if (busy) return;
        setDiagnosticBusy(true);
        currentFieldData.goal_time = "";
        if (getThread()) appendUserMsg(getThread(), "No specific goal");
        hideQuickReplies();
        scrollToBottom();
        setDiagnosticBusy(false);
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
var LONGEST_LABEL_RE = /\b(longest|furthest|farthest)\b/i;
var RETURNING_STATUS_RE = /\b(?:got\s+sick|been\s+sick|after\s+being\s+sick|coming\s+back(?:\s+from|\s+after)?|took\s+(?:a\s+few\s+|some\s+)?(?:weeks?|months?|days?)\s+off|stopped\s+training|returning\s+after|just\s+got\s+back|got\s+back\s+(?:to|into)\s+running|recently\s+got\s+back|back\s+into\s+running|from\s+a\s+break|after\s+a\s+break|time\s+off)\b/i;
var RECENT_RESULT_LANG_RE = /\b(ago|last (?:race|result|time|half|marathon|10k|5k)|recent (?:race|result)|recently ran|ran a|i ran|pb|personal best|finish(?:ed)? in)\b/i;
var GOAL_TIME_HOURS_HINT_RE = /\b(under|below|sub|aiming|target|goal|hoping|finish(?:ing)?)\b/i;
var HOUR_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

// Word-based goal keywords are safe in any message. Numeric ones ("50k",
// "10k", "42.2k"...) are gated separately -- a weekly-mileage sentence
// like "40-50km per week" must never be read as an Ultra/10K race goal.
var GOAL_DISTANCE_WORD_RULES = [
  [/\bhalf[\s-]?marathon\b/i, "Half marathon"],
  [/\bultra\s*-?\s*marathon\b|\bultra\b/i, "Ultra"],
  [/\bfull\s+marathon\b|\bmarathon\b/i, "Marathon"],
  [/\bten\s*k\b|\b10k\b/i, "10K"],
  [/\bfive\s*k\b|\b5k\b/i, "5K"],
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

function parseHourToken(token) {
  if (!token) return null;
  var w = HOUR_WORDS[String(token).toLowerCase()];
  if (w) return w;
  var n = parseInt(token, 10);
  return isFinite(n) ? n : null;
}

function extractGoalTime(text) {
  var raw = String(text || "");
  var sub = raw.match(GOAL_TIME_RE);
  if (sub) return "sub-" + sub[1] + ":" + (sub[2] || "00");

  var under = raw.match(/\b(?:under|below|hoping to (?:go )?under|aiming for under|go under)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*hours?)?\b/i);
  if (under) {
    var n = parseHourToken(under[1]);
    if (n != null && n >= 1 && n <= 12) {
      if (/\bhours?\b/i.test(under[0]) || n <= 6) return "sub-" + n + ":00";
    }
  }

  var hoursGoal = raw.match(/\b(?:target(?:\s+time)?(?:\s+is)?|aiming for|goal (?:is|of|time)|finish(?:ing)?(?:\s+in)?)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*hours?\b/i);
  if (hoursGoal) {
    var n2 = parseHourToken(hoursGoal[1]);
    if (n2 != null && n2 >= 1 && n2 <= 12) return "sub-" + n2 + ":00";
  }

  var clockGoal = raw.match(/\b(?:aiming for|target(?:\s+time)?(?:\s+of|:|is)?|goal (?:is|of|time)|finish(?:ing)?\s+time(?:\s+of)?|hope to (?:run|finish)|hoping (?:to )?(?:run|finish|go))\s+(\d{1,2}:\d{2}(?::\d{2})?)\b/i);
  if (clockGoal) return clockGoal[1];

  return null;
}

function extractLabeledDistances(text, currentId) {
  var facts = {};
  var kmRe = /(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?|kms?)\b|(\d+(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?|kms?)\b/gi;
  var match;
  while ((match = kmRe.exec(text))) {
    var idx = match.index;
    var before = text.slice(Math.max(0, idx - 56), idx).toLowerCase();
    var after = text.slice(idx, Math.min(text.length, idx + match[0].length + 28)).toLowerCase();
    var nearby = before + " " + after;
    var value;
    if (match[1] && match[2]) {
      var lo = parseFloat(match[1]);
      var hi = parseFloat(match[2]);
      if (!isFinite(lo) || !isFinite(hi)) continue;
      value = Math.round(((lo + hi) / 2) * 10) / 10;
    } else {
      value = parseFloat(match[3]);
      if (!isFinite(value)) continue;
    }
    if (LONGEST_LABEL_RE.test(before)) {
      if (facts.recent_longest_run_km == null) facts.recent_longest_run_km = value;
      continue;
    }
    if (WEEK_CONTEXT_RE.test(nearby)) {
      if (facts.weekly_mileage == null) facts.weekly_mileage = value;
      continue;
    }
    if (currentId === "weekly_mileage" && facts.weekly_mileage == null) {
      facts.weekly_mileage = value;
      continue;
    }
    if (currentId === "recent_longest_run_km" && facts.recent_longest_run_km == null) {
      facts.recent_longest_run_km = value;
    }
  }

  if (facts.recent_longest_run_km == null) {
    var bareLongest = text.match(/\b(?:longest|furthest|farthest)(?:\s+run)?(?:\s+(?:i(?:['’]ve| have)\s+(?:done|run))?(?:\s+recently)?)?(?:\s+is)?\s*(?:around|about|roughly)?\s*(\d+(?:\.\d+)?)(?:\s*(?:km|kilometers?|kilometres?|kms?))?\b/i);
    if (bareLongest) {
      var ln = parseFloat(bareLongest[1]);
      if (isFinite(ln)) facts.recent_longest_run_km = ln;
    }
  }
  return facts;
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

  var labeled = extractLabeledDistances(text, currentId);
  if (labeled.weekly_mileage != null) facts.weekly_mileage = labeled.weekly_mileage;
  if (labeled.recent_longest_run_km != null) facts.recent_longest_run_km = labeled.recent_longest_run_km;
  if (currentId === "weekly_mileage" && facts.weekly_mileage == null && String(factPortion).trim()) {
    var bare = parseLooseNumber(factPortion);
    if (bare != null) facts.weekly_mileage = bare;
  }

  // Weekly hours — never steal "under 4 hours" goal language.
  var trustHours = weekCtx || currentId === "weekly_hours";
  if (trustHours) {
    var hoursRe = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr)\b/gi;
    var hoursMatch;
    var foundHours = false;
    while ((hoursMatch = hoursRe.exec(text))) {
      var hoursBefore = text.slice(Math.max(0, hoursMatch.index - 40), hoursMatch.index);
      if (GOAL_TIME_HOURS_HINT_RE.test(hoursBefore)) continue;
      facts.weekly_hours = parseFloat(hoursMatch[1]);
      foundHours = true;
      break;
    }
    if (!foundHours && currentId === "weekly_hours" && String(factPortion).trim()) {
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

  // Goal finish time ("sub 4", "under 4 hours", "aiming for 3:59").
  var extractedGoalTime = extractGoalTime(text);
  if (extractedGoalTime) facts.goal_time = extractedGoalTime;

  var onRecentRace = currentId === "recent_race_dist" || currentId === "recent_race_time" ||
    (currentQuestion && currentQuestion.key === "recent_performance");
  var finishClock = detectFinishClock(text);
  var recentDist = detectRecentRaceDistance(text, onRecentRace || !!finishClock);
  var treatAsRecentResult = onRecentRace || (finishClock && RECENT_RESULT_LANG_RE.test(text));
  if (recentDist && treatAsRecentResult) {
    facts.recent_race_dist = recentDist;
  }
  if (finishClock && (onRecentRace || (recentDist && treatAsRecentResult) || currentId === "recent_race_time")) {
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
  // Month-only mentions ("in December") are remembered as context only —
  // never coerced into a fake YYYY-MM-01 race day.

  if (RETURNING_STATUS_RE.test(text) &&
      !(engine && engine.known && engine.known.training_status)) {
    facts.training_status = "returning";
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
  if (currentId === "training_structure" || /\b(guess|random|no plan|not structured|unstructured|mostly easy|long run|intervals?|tempo)\b/i.test(text)) {
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

function persistFactStore() {
  if (engine && typeof engine.setPendingFacts === "function") {
    engine.setPendingFacts(factStore);
  }
}

function restoreFactStoreFromEngine() {
  factStore = {};
  if (!engine) return;
  var pending = engine.getPendingFacts ? engine.getPendingFacts() : engine.pendingFacts;
  if (!pending) return;
  for (var key in pending) {
    if (Object.prototype.hasOwnProperty.call(pending, key)) factStore[key] = pending[key];
  }
}

function commitFullyKnownPendingQuestions() {
  if (!engine) return;
  for (;;) {
    if (engine.canComplete && engine.canComplete()) return;
    var next = engine.nextQuestion();
    if (!next) return;
    var autoAnswers = questionFullyKnownFromFacts(next);
    if (!autoAnswers) return;
    for (var fid in autoAnswers) {
      if (Object.prototype.hasOwnProperty.call(autoAnswers, fid)) delete factStore[fid];
    }
    persistFactStore();
    engine.recordAnswer(next.key, autoAnswers);
    clearConsumedFacts(next);
  }
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
  persistFactStore();
}

/** Pull a pending fact for one field, consuming it. Never overrides a
 * value the current sub-step already has. */
function consumeFactForField(f) {
  var existing = currentFieldData[f.id];
  if (existing != null && existing !== "") return undefined;
  if (Object.prototype.hasOwnProperty.call(factStore, f.id)) {
    var v = factStore[f.id];
    delete factStore[f.id];
    persistFactStore();
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
  if (engine && typeof engine.canAutoFillQuestion === "function" && !engine.canAutoFillQuestion(q, sim)) {
    return null;
  }
  return sim;
}

/** Drop any leftover pending facts for a question once it's been recorded
 * (avoids a stale extracted value resurfacing after the runner changes
 * their answer, e.g. via Back). */
function clearConsumedFacts(q) {
  for (var i = 0; i < q.fields.length; i++) delete factStore[q.fields[i].id];
  persistFactStore();
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
    setDiagnosticBusy(false);
    (async function () {
      await delay(MSG_DELAY);
      presentSubStep(nextSubStep, true);
    })();
  } else {
    // All fields collected — submit
    setDiagnosticBusy(false);
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
  if (skipCannedInterpretations) interpretation = null;
  if (interpretation) interpretationCache[q.key] = interpretation;
  clearConsumedFacts(q);

  trackEvent("diagnostic_question_answered", {
    question_key: q.key,
    questions_completed: engine.history.length
  });
  trackDiagnosticStep(q, {
    answerType: inferDiagnosticAnswerType(q, currentFieldData),
    answerId: normalizedChipAnswerId(q, currentFieldData)
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
  var recoveredKeys = {};
  for (;;) {
    if (engine.canComplete()) {
      setDiagnosticBusy(false);
      completeDiagnostic();
      return;
    }

    var next = engine.nextQuestion();
    if (!next) {
      next = recoverContinuationQuestion();
      if (!next || recoveredKeys[next.key]) {
        failOpenDeadDiagnostic(thread);
        return;
      }
      recoveredKeys[next.key] = true;
    }

    var autoAnswers = questionFullyKnownFromFacts(next);
    if (autoAnswers) {
      for (var fid in autoAnswers) {
        if (Object.prototype.hasOwnProperty.call(autoAnswers, fid)) delete factStore[fid];
      }
      persistFactStore();
      engine.recordAnswer(next.key, autoAnswers);
      trackEvent("diagnostic_question_answered", {
        question_key: next.key,
        questions_completed: engine.history.length,
        autofilled: true
      });
      trackDiagnosticStep(next, { answerType: "autofill" });
      updateProgress();
      continue; // silent skip — do not dump canned interpretations
    }

    await delay(MSG_DELAY);
    var subSteps = splitIntoSubSteps(next);
    var prompt = subSteps.length === 1 ? next.title : getSubStepPrompt(next, subSteps[0], 0, subSteps.length);
    if (thread) await showTypingThenMessage(thread, prompt);
    setDiagnosticBusy(false);
    presentQuestion(next);
    return;
  }
}

function recoverContinuationQuestion() {
  if (!engine) return null;
  if (typeof engine.recoverContinuationQuestion === "function") {
    return engine.recoverContinuationQuestion();
  }
  if (engine.completed || (typeof engine.canComplete === "function" && engine.canComplete())) {
    return null;
  }
  var live = typeof engine.nextQuestion === "function" ? engine.nextQuestion() : null;
  if (live) return live;
  var Diagnostic = root.AthlevoDiagnostic;
  if (!Diagnostic || typeof Diagnostic.getQuestion !== "function") return null;
  var injurySatisfied = typeof engine._injurySafetySatisfied === "function"
    ? engine._injurySafetySatisfied()
    : !!(engine.known && engine.known.injury_status);
  if (!injurySatisfied) {
    var injury = Diagnostic.getQuestion("injury_status");
    if (injury) return injury;
  }
  var questions = typeof Diagnostic.getQuestions === "function" ? Diagnostic.getQuestions() : [];
  var i;
  var q;
  for (i = 0; i < questions.length; i++) {
    q = questions[i];
    if (q.key === "perceived_limiter") continue;
    if (engine.history && engine.history.indexOf(q.key) >= 0) continue;
    if (q.eligible && engine._stateView && !q.eligible(engine._stateView())) continue;
    return q;
  }
  return null;
}

function failOpenDeadDiagnostic(thread) {
  setDiagnosticBusy(false);
  thread = thread || getThread();
  if (thread) {
    appendAthlevoMsg(thread, DEAD_STATE_MESSAGE);
    rememberTurn("athlevo", DEAD_STATE_MESSAGE);
    scrollToBottom();
  }
  showQuickReplies([{ label: DEAD_STATE_RETRY_LABEL, value: DEAD_STATE_RETRY_VALUE }], function (opt) {
    if (!opt || opt.value !== DEAD_STATE_RETRY_VALUE) return;
    hideQuickReplies();
    setDiagnosticBusy(true);
    Promise.resolve(advanceFlow(getThread())).then(function () {
      setDiagnosticBusy(false);
    }, function () {
      setDiagnosticBusy(false);
      restoreCurrentFieldInput();
    });
  });
  showComposer("Type your answer here…");
  setComposerMode("text");
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

  // Greeting only. The goal question is painted once from history or as
  // the active question — do not hardcode it here or it appears twice.
  thread.appendChild(createEl(
    '<div class="chat-msg chat-msg-athlevo"><div class="chat-bubble chat-bubble-athlevo">Hi! I’m Athlevo, your endurance coach.</div></div>'
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
  if (!activeQ) {
    var recovered = recoverContinuationQuestion();
    if (recovered) {
      thread.appendChild(createEl(
        '<div class="chat-msg chat-msg-athlevo"><div class="chat-bubble chat-bubble-athlevo">' + esc(recovered.title) + '</div></div>'
      ));
      presentQuestion(recovered);
    } else {
      failOpenDeadDiagnostic(thread);
    }
    scrollToBottom();
    updateProgress();
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
  if (!diagnosticCompletedFired) {
    diagnosticCompletedFired = true;
    var profile = result.profile || {};
    trackEvent("diagnostic_completed", acquisitionAnalyticsProps({
      questions_answered: engine.history.length,
      primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
      feasibility_rating: result.feasibility ? result.feasibility.rating : null,
      injury_reported: !!(result.safetyFlags && result.safetyFlags.injuryReported),
      goal_distance: profile.goal || null,
      training_status: profile.trainingStatusRaw || profile.trainingStatus || null,
      weekly_mileage: typeof profile.weeklyMileage === "number" ? profile.weeklyMileage : null,
      has_race: !!(profile.goalRace || profile.goalDate),
      diagnostic_version: result.version != null ? String(result.version) : "1"
    }));
  }
  showBuildAnimation(result);
}

async function showBuildAnimation(result) {
  mode = "result";
  hideQuickReplies();
  hideComposer();

  var thread = getThread();
  if (!thread) { renderResult(); return; }

  var fill = document.querySelector("#diagProgress .ob2-fill");
  if (fill) fill.style.transform = "scaleX(1)";

  if (resultSequenceStarted || thread.querySelector(".chat-msg-result")) {
    renderResult();
    return;
  }
  resultSequenceStarted = true;

  appendTypingIndicator(thread);
  scrollToBottom();
  await delay(reducedMotion() ? 200 : RESULT_THINK_DELAY);
  removeTypingIndicator();
  renderResult();
}

/* ═══════════════════════════ RESULT RENDERING ══════════════════════ */

function renderResult(opts) {
  mode = "result";
  hideQuickReplies();
  hideComposer();

  var thread = getThread();
  if (!thread) return;

  var result = engine.result;
  if (!result) return;
  currentQuestion = null;

  var back = document.getElementById("diagBack");
  if (back) back.disabled = true;

  var fill = document.querySelector("#diagProgress .ob2-fill");
  if (fill) fill.style.transform = "scaleX(1)";

  if (thread.querySelector(".chat-msg-result")) return;

  var rec = result.athlevoRecommendation;
  var limiter = result.primaryLimiter;
  var html = '<div class="chat-result-card">';

  html += '<span class="chat-result-eyebrow">Your diagnosis</span>';
  if (limiter) {
    html += '<h3 class="chat-result-limiter-title">' + esc(limiter.label) + '</h3>';
    html += '<p class="chat-result-text">' + esc(limiter.explanation) + '</p>';
  } else {
    html += '<h3 class="chat-result-limiter-title">Specificity gap</h3>';
    html += '<p class="chat-result-text">The highest-leverage change is making the work you already do more specific to the goal—not adding generic structure.</p>';
  }

  var changes = result.whatWedChange;
  if (changes && changes.length > 0) {
    html += '<div class="chat-result-block">';
    html += '<h4 class="chat-result-subhead">What I’d change</h4>';
    html += '<ul class="chat-result-changes">';
    for (var c = 0; c < Math.min(changes.length, 3); c++) {
      html += '<li>' + esc(changes[c]) + '</li>';
    }
    html += '</ul></div>';
  }

  if (result.feasibility) {
    html += '<div class="chat-result-block">';
    html += '<h4 class="chat-result-subhead">Your goal</h4>';
    html += '<p class="chat-result-status">' + esc(result.feasibility.label) + '</p>';
    html += '<p class="chat-result-text">' + esc(result.feasibility.explanation) + '</p>';
    html += '</div>';
  }

  if (result.safetyFlags && result.safetyFlags.requiresMedicalClearance) {
    html += '<p class="chat-result-safety-note">Athlevo is not a medical provider. Based on what you’ve shared, please consult a qualified health professional before beginning or modifying any training program.</p>';
  }

  if (!rec || !rec.safetyOverride) {
    html += '<div class="chat-result-offer">';
    html += '<h4 class="chat-result-offer-title">Train with Athlevo AI</h4>';
    html += '<p class="chat-result-offer-lead">Your plan doesn’t stay fixed. It evolves with you.</p>';
    html += '<p class="chat-result-offer-features">Personalized training · Adaptive coaching · AI running coach · Readiness &amp; recovery · Progress tracking</p>';
    html += '<button class="chat-cta-btn" id="diagCTA" type="button">Start my training — ₱597/month</button>';
    html += '<p class="chat-cta-annual">or ₱5,498/year — save ₱1,666</p>';
    html += '</div>';
  }

  html += '</div>';

  var resultEl = createEl(
    '<div class="chat-msg chat-msg-athlevo chat-msg-result">' + html + '</div>'
  );
  thread.appendChild(resultEl);
  animateIn(resultEl);
  scrollToBottom();

  if (!rec || !rec.safetyOverride) {
    var cta = document.getElementById("diagCTA");
    if (cta) {
      cta.addEventListener("click", function () {
        trackEvent("diagnostic_signup_tapped", {
          primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
          feasibility_rating: result.feasibility ? result.feasibility.rating : null
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
        if (typeof root.openAiSignup === "function") {
          root.openAiSignup();
        } else if (root.openAppEntry) {
          root.openAppEntry();
        } else {
          showScreen("screen-welcome");
        }
      });
    }
  }

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

function trackDiagnosticAiFallback(result, questionKey) {
  if (!result || result.usedFallback !== true) return;
  trackEvent("diagnostic_ai_fallback_used", { question_key: questionKey || null });
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
    isAnonymousDiagnosticVisitor: isAnonymousDiagnosticVisitor,
    applyAnonymousConversionCopy: applyAnonymousConversionCopy,
    conversionHandoffOptions: conversionHandoffOptions,
    isValidFieldValue: isValidFieldValue,
    tryMapTextToValue: tryMapTextToValue,
    absorbGroupFacts: absorbGroupFacts,
    detectRecentRaceDistance: detectRecentRaceDistance,
    detectFinishClock: detectFinishClock,
    applyExtractedFacts: applyExtractedFacts,
    mergeAiExtractedFacts: mergeAiExtractedFacts,
    stripModelRouting: stripModelRouting,
    storeModelReasoningFromResult: storeModelReasoningFromResult,
    hasAckWorthyContext: hasAckWorthyContext,
    isUsableAcknowledgement: isUsableAcknowledgement,
    acknowledgementText: acknowledgementText,
    shouldCallAiAcknowledgement: shouldCallAiAcknowledgement,
    consumeFactForField: consumeFactForField,
    questionFullyKnownFromFacts: questionFullyKnownFromFacts,
    nextMissingRaceDetailField: nextMissingRaceDetailField,
    persistFactStore: persistFactStore,
    restoreFactStoreFromEngine: restoreFactStoreFromEngine,
    commitFullyKnownPendingQuestions: commitFullyKnownPendingQuestions,
    extractGoalTime: extractGoalTime,
    resetSkipCannedInterpretations: resetSkipCannedInterpretations,
    recoverContinuationQuestion: recoverContinuationQuestion,
    failOpenDeadDiagnostic: failOpenDeadDiagnostic,
    advanceFlow: advanceFlow,
    handleComposerSend: handleComposerSend,
    handleChipSelect: handleChipSelect,
    setDiagnosticBusy: setDiagnosticBusy,
    isBusy: function () { return busy; },
    presentQuestion: presentQuestion,
    presentSubStepInput: presentSubStepInput,
    getSkipCannedInterpretations: function () { return skipCannedInterpretations; },
    markDiagnosticStarted: markDiagnosticStarted,
    hasRecordedDiagnosticAnswers: hasRecordedDiagnosticAnswers,
    primeDiagnosticStartedFromEngine: primeDiagnosticStartedFromEngine,
    trackDiagnosticAiFallback: trackDiagnosticAiFallback,
    trackAiLandingViewed: trackAiLandingViewed,
    showQuickReplies: showQuickReplies,
    hideQuickReplies: hideQuickReplies,
    currentAcquisitionIntent: currentAcquisitionIntent,
    trackDiagnosticStep: trackDiagnosticStep,
    getSubStepPrompt: getSubStepPrompt,
    completeDiagnostic: completeDiagnostic,
    renderResult: renderResult,
    showBuildAnimation: showBuildAnimation,
    getDiagnosticStartedFired: function () { return diagnosticStartedFired; },
    getDiagnosticCompletedFired: function () { return diagnosticCompletedFired; },
    applyAcknowledgementResult: applyAcknowledgementResult,
    restoreCurrentFieldInput: restoreCurrentFieldInput,
    bindEngine: function (e) {
      diagnosticAcquisitionActive = false;
      engine = e;
      currentFieldData = {};
      currentQuestion = null;
      currentSubStep = 0;
      activeSubField = null;
      subStepFields = [];
      resultSequenceStarted = false;
      resetSkipCannedInterpretations();
      setDiagnosticBusy(false);
      diagnosticCompletedFired = false;
    },
    isDiagnosticAcquisitionActive: function () { return diagnosticAcquisitionActive; },
    resetDiagnosticAcquisitionActive: function () { diagnosticAcquisitionActive = false; },
    prepareQuestion: function (q) {
      currentQuestion = q;
      currentFieldData = {};
      currentSubStep = 0;
      activeSubField = null;
      subStepFields = q ? splitIntoSubSteps(q) : [];
    },
    getFactStore: function () { return factStore; },
    resetFactStore: function () {
      factStore = {};
      if (engine && typeof engine.setPendingFacts === "function") engine.setPendingFacts({});
    }
  }
};

root.AthlevoDiagnosticUI = DiagnosticUI;

if (typeof module !== "undefined" && module.exports) {
  module.exports = DiagnosticUI;
}

})(typeof window !== "undefined" ? window : this);
