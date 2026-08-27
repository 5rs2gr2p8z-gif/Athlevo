/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Diagnostic UI Controller  (Conversation Model)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Renders the pre-signup diagnostic as a continuous guided coaching
 *  conversation. Questions from the DiagnosticEngine appear as Athlevo's
 *  coaching messages; user answers collapse into subtle echo elements;
 *  coaching interpretations flow inline between turns.
 *
 *  REUSES: .ob2-* CSS classes for field rendering (chips, cards, inputs).
 *  ADDS:   .conv-* CSS classes for the conversation thread layout.
 *
 *  DOES NOT TOUCH: Authentication, Supabase, subscriptions, onboarding,
 *  existing navigation, payment config, or entitlement logic.
 */

(function (root) {
"use strict";

/* ═══════════════════════════ CONSTANTS ═══════════════════════════════ */

var EASE = "cubic-bezier(.2,.7,.2,1)";
var EASE_OUT = "cubic-bezier(.34,1.56,.64,1)";

var OPENING_MSG = "I’m Athlevo — I coach endurance athletes using training science and what I learn about you over time.";
var OPENING_FOLLOW = "Let’s figure out where your running is right now and what would actually make the biggest difference.";

/* ═══════════════════════════ STATE ═══════════════════════════════════ */

var engine = null;       // DiagnosticEngine instance
var mode = "question";   // "question" | "result"
var busy = false;
var advanceTimer = null;
var currentFieldData = {};  // tracks field values for the current question
var currentQuestion = null; // the displayed question is the submission source of truth
var resultTrackedFor = null;
var interpretationCache = {}; // questionKey → interpretation text from engine

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

function pop(el) {
  if (!canAnimate(el)) return;
  el.animate(
    [{ transform: "scale(.97)" }, { transform: "scale(1.015)" }, { transform: "scale(1)" }],
    { duration: 240, easing: EASE_OUT });
}

function animateIn(el) {
  if (!canAnimate(el)) return;
  el.animate(
    [{ opacity: 0, transform: "translateY(8px)" },
     { opacity: 1, transform: "translateY(0)" }],
    { duration: 280, easing: EASE, fill: "both" }
  );
}

/* ═══════════════════════════ SCREEN SETUP ═══════════════════════════ */

/**
 * Start or resume the diagnostic. Called from landing page entry points.
 * Shows screen-diagnostic and renders the conversation immediately —
 * no intro screen, no "Start my assessment" gate.
 */
function startDiagnostic() {
  // Resume or create
  var pending = root.AthlevoDiagnostic && root.AthlevoDiagnostic.load();
  if (pending && !pending.completed) {
    engine = pending;
  } else if (pending && pending.completed) {
    engine = pending;
    showScreen("screen-diagnostic");
    renderResult();
    trackEvent("diagnostic_resumed", { state: "completed" });
    return;
  } else {
    engine = root.AthlevoDiagnostic.create();
  }

  showScreen("screen-diagnostic");
  interpretationCache = {};

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

/**
 * Render the conversation opening: brand header, greeting messages,
 * and the first question — all in one view, no button gate.
 */
function renderConversationOpening() {
  mode = "question";
  currentQuestion = null;
  var body = getBody();
  if (!body) return;
  body.innerHTML = "";
  body.scrollTop = 0;

  var thread = document.createElement("div");
  thread.className = "conv-thread";
  body.appendChild(thread);

  // Brand header
  thread.appendChild(createEl(
    '<div class="conv-header">' +
      '<span class="conv-brand">Athlevo<span>.</span></span>' +
      '<span class="conv-role">AI Running Coach</span>' +
    '</div>'
  ));

  // Opening messages
  appendAthlevoMsg(thread, OPENING_MSG);
  appendAthlevoMsg(thread, OPENING_FOLLOW);

  // First question — flows naturally below the greeting
  var q = engine.nextQuestion();
  if (q) {
    appendActiveQuestion(thread, q);
  }

  // Chrome state
  var progress = document.getElementById("diagProgress");
  if (progress) progress.style.visibility = "";
  updateChrome(q);
  focusMain(body.querySelector(".conv-brand"));
}

function showScreen(id) {
  // Use existing showScreen if available, otherwise basic toggle
  if (root.showScreen) {
    root.showScreen(id);
  } else {
    document.querySelectorAll(".screen").forEach(function (s) {
      s.classList.remove("active");
    });
    var el = document.getElementById(id);
    if (el) el.classList.add("active");
  }
  // Hide tabbar during diagnostic
  var tb = document.getElementById("tabbar");
  if (tb) tb.style.display = "none";
}

/* ═══════════════════════════ CONVERSATION THREAD ═══════════════════ */

function ensureThread() {
  var body = getBody();
  if (!body) return null;
  var thread = body.querySelector(".conv-thread");
  if (!thread) {
    thread = document.createElement("div");
    thread.className = "conv-thread";
    body.appendChild(thread);
  }
  return thread;
}

function appendAthlevoMsg(thread, text, skipAnim) {
  var el = createEl('<p class="conv-athlevo-msg">' + esc(text) + '</p>');
  thread.appendChild(el);
  if (!skipAnim) animateIn(el);
  return el;
}

function appendContext(thread, text, skipAnim) {
  var el = createEl('<p class="conv-context">' + esc(text) + '</p>');
  thread.appendChild(el);
  if (!skipAnim) animateIn(el);
  return el;
}

function appendEcho(thread, label, skipAnim) {
  var el = createEl(
    '<div class="conv-echo">' +
      '<span class="conv-echo-label">You</span>' +
      '<span class="conv-echo-value">' + esc(label) + '</span>' +
    '</div>'
  );
  thread.appendChild(el);
  if (!skipAnim) animateIn(el);
  return el;
}

/**
 * Append the active question's fields to the thread. Sets currentQuestion,
 * wires field interactions, and scrolls to the new content.
 */
function appendActiveQuestion(thread, q) {
  currentQuestion = q;
  currentFieldData = {};

  // Pre-fill if revisiting
  if (engine.history.indexOf(q.key) >= 0) {
    prefillFromAnswers(q);
  }

  // Question title as Athlevo coaching message
  var msgEl = appendAthlevoMsg(thread, q.title);
  if (q.sub) appendContext(thread, q.sub);

  // Fields container
  var fieldsHTML = buildFieldsHTML(q);
  var wrap = createEl(
    '<div class="conv-q-wrap" data-question="' + esc(q.key) + '">' +
      fieldsHTML +
    '</div>'
  );
  thread.appendChild(wrap);
  animateIn(wrap);

  wireQuestion(wrap, q);
  showFoot(!q.autoAdvance);
  updateChrome(q);

  // Scroll the new question into view
  scrollToEl(msgEl);
}

function scrollToEl(el) {
  if (!el) return;
  setTimeout(function () {
    try {
      el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    } catch (e) {}
  }, reducedMotion() ? 0 : 60);
}

/**
 * Build a readable summary of the user's answer for the echo element.
 * Returns e.g. "Half marathon" or "30 km · 4 hrs" or "Strength / gym, Cycling".
 */
function getAnswerEchoLabel(q, fieldData) {
  var parts = [];
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    // Check showWhen against the field data
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
      // Single select — find option label
      for (var j = 0; j < f.options.length; j++) {
        if (String(f.options[j].value) === String(v)) {
          parts.push(f.options[j].label);
          break;
        }
      }
    } else if (f.options && Array.isArray(v)) {
      // Multi select
      var labels = [];
      var vStr = v.map(String);
      for (var k = 0; k < f.options.length; k++) {
        if (vStr.indexOf(String(f.options[k].value)) >= 0) {
          labels.push(f.options[k].label);
        }
      }
      if (labels.length) parts.push(labels.join(", "));
    } else if (f.type === "number" && f.unit) {
      parts.push(v + " " + f.unit);
    } else {
      parts.push(String(v));
    }
  }
  return parts.join(" · ") || "Answered";
}

/**
 * Rebuild the entire conversation thread from engine state.
 * Used for back navigation and resume from localStorage.
 */
function rebuildConversation(activeQ) {
  var body = getBody();
  if (!body) return;
  body.innerHTML = "";
  body.scrollTop = 0;
  mode = "question";

  var thread = document.createElement("div");
  thread.className = "conv-thread";
  body.appendChild(thread);

  // Brand header (no animation on rebuild)
  thread.appendChild(createEl(
    '<div class="conv-header">' +
      '<span class="conv-brand">Athlevo<span>.</span></span>' +
      '<span class="conv-role">AI Running Coach</span>' +
    '</div>'
  ));

  // Opening messages
  thread.appendChild(createEl('<p class="conv-athlevo-msg">' + esc(OPENING_MSG) + '</p>'));
  thread.appendChild(createEl('<p class="conv-athlevo-msg">' + esc(OPENING_FOLLOW) + '</p>'));

  // Replay answered questions as echoes
  for (var i = 0; i < engine.history.length; i++) {
    var key = engine.history[i];
    // Stop before the active question — it gets rendered as editable fields
    if (activeQ && key === activeQ.key) break;

    var q = getQuestionDef(key);
    if (!q) continue;

    var fieldData = engine.questionAnswers[key] || {};

    // Athlevo asked this question
    thread.appendChild(createEl('<p class="conv-athlevo-msg">' + esc(q.title) + '</p>'));

    // User's collapsed answer
    var echoLabel = getAnswerEchoLabel(q, fieldData);
    thread.appendChild(createEl(
      '<div class="conv-echo">' +
        '<span class="conv-echo-label">You</span>' +
        '<span class="conv-echo-value">' + esc(echoLabel) + '</span>' +
      '</div>'
    ));

    // Coaching interpretation (from cache or re-generated)
    var interp = interpretationCache[key];
    if (!interp && q.interpret) {
      try { interp = q.interpret(fieldData, engine._stateView()); } catch (e) {}
    }
    if (interp) {
      thread.appendChild(createEl('<p class="conv-athlevo-msg">' + esc(interp) + '</p>'));
    }
  }

  // Active question or completion
  if (!activeQ && engine.canComplete()) {
    completeDiagnostic();
    return;
  }
  if (activeQ) {
    appendActiveQuestion(thread, activeQ);
  }
}

function getQuestionDef(key) {
  if (root.AthlevoDiagnostic && root.AthlevoDiagnostic.getQuestion) {
    return root.AthlevoDiagnostic.getQuestion(key);
  }
  return null;
}

/* ═══════════════════════════ FIELD RENDERING ═══════════════════════ */

function prefillFromAnswers(q) {
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    var val = engine.answers[f.id];
    if (val != null) {
      currentFieldData[f.id] = val;
    }
  }
}

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

function renderField(f, q) {
  var label = "";
  if (!f.bare) {
    var optTag = f.optional ? ' <span class="opt">(optional)</span>' : "";
    label = '<label class="ob2-label" for="diagf-' + esc(f.id) + '">' + esc(f.label) + optTag + '</label>';
  }

  var inner = "";

  if (f.type === "chips" && f.layout === "cards") {
    inner = renderCards(f);
  } else if (f.type === "chips") {
    inner = renderChips(f);
  } else if (f.type === "multichips") {
    inner = renderMultiChips(f);
  } else if (f.type === "text") {
    inner = renderTextInput(f);
  } else if (f.type === "number") {
    inner = renderNumberInput(f);
  } else if (f.type === "date") {
    inner = renderDateInput(f);
  }

  return '<div class="ob2-field">' + label + inner + '</div>';
}

function renderCards(f) {
  var html = '<div class="ob2-cards-choice" role="group" aria-label="' + esc(f.label) + '">';
  for (var i = 0; i < f.options.length; i++) {
    var o = f.options[i];
    var sel = currentFieldData[f.id] != null && String(currentFieldData[f.id]) === String(o.value) ? " sel" : "";
    html += '<button class="ob2-card' + sel + '" data-field="' + esc(f.id) +
      '" data-value="' + esc(o.value) + '" type="button" aria-pressed="' + (sel ? 'true' : 'false') + '">' +
      '<span class="ob2-card-label">' + esc(o.label) + '</span>' +
      '<span class="ob2-card-tick"></span>' +
      '</button>';
  }
  html += '</div>';
  return html;
}

function renderChips(f) {
  var html = '<div class="ob2-chips" role="group" aria-label="' + esc(f.label) + '">';
  for (var i = 0; i < f.options.length; i++) {
    var o = f.options[i];
    var sel = currentFieldData[f.id] != null && String(currentFieldData[f.id]) === String(o.value) ? " sel" : "";
    html += '<button class="ob2-chip' + sel + '" data-field="' + esc(f.id) +
      '" data-value="' + esc(o.value) + '" type="button" aria-pressed="' + (sel ? 'true' : 'false') + '">' + esc(o.label) + '</button>';
  }
  html += '</div>';
  return html;
}

function renderMultiChips(f) {
  var html = '<div class="ob2-chips" role="group" aria-label="' + esc(f.label) + '">';
  var curArr = Array.isArray(currentFieldData[f.id]) ? currentFieldData[f.id] : [];
  for (var i = 0; i < f.options.length; i++) {
    var o = f.options[i];
    var sel = curArr.indexOf(o.value) >= 0 ? " sel" : "";
    var excl = o.exclusive ? ' data-exclusive="1"' : "";
    html += '<button class="ob2-chip' + sel + '" data-field="' + esc(f.id) +
      '" data-value="' + esc(o.value) + '" data-multi="1"' + excl +
      ' type="button" aria-pressed="' + (sel ? 'true' : 'false') + '">' + esc(o.label) + '</button>';
  }
  html += '</div>';
  return html;
}

function renderTextInput(f) {
  var val = currentFieldData[f.id] || "";
  return '<input class="ob2-input" type="text" id="diagf-' + esc(f.id) +
    '" data-field="' + esc(f.id) + '"' +
    (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
    (f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') +
    ' value="' + esc(val) + '"' +
    ' autocomplete="off">';
}

function renderNumberInput(f) {
  var val = currentFieldData[f.id] != null ? currentFieldData[f.id] : "";
  var input = '<input class="ob2-input" type="number" inputmode="decimal" id="diagf-' + esc(f.id) +
    '" data-field="' + esc(f.id) + '"' +
    (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
    (f.min != null ? ' min="' + f.min + '"' : '') +
    (f.max != null ? ' max="' + f.max + '"' : '') +
    ' value="' + esc(val) + '"' +
    ' autocomplete="off">';

  if (f.unit) {
    return '<div class="ob2-affix">' + input + '<span class="unit">' + esc(f.unit) + '</span></div>';
  }
  return input;
}

function renderDateInput(f) {
  var val = currentFieldData[f.id] || "";
  return '<input class="ob2-input" type="date" id="diagf-' + esc(f.id) +
    '" data-field="' + esc(f.id) + '"' +
    ' value="' + esc(val) + '">';
}

/* ═══════════════════════════ FIELD LAYOUT ════════════════════════════ */

/**
 * Build the HTML for a question's fields (chips, inputs, etc.) without
 * the surrounding step wrapper. Used inside .conv-q-wrap.
 */
function buildFieldsHTML(q) {
  var fieldsHTML = "";
  var halfBuf = [];

  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (f.showWhen && !checkShowWhen(f.showWhen)) continue;

    if (f.half) {
      halfBuf.push(f);
      if (halfBuf.length === 2) {
        fieldsHTML += '<div class="ob2-field"><div class="ob2-row">';
        for (var h = 0; h < halfBuf.length; h++) {
          var hf = halfBuf[h];
          var optTag = hf.optional ? ' <span class="opt">(optional)</span>' : "";
          var lab = hf.bare ? "" : '<label class="ob2-label" for="diagf-' + esc(hf.id) + '">' + esc(hf.label) + optTag + '</label>';
          var inner = "";
          if (hf.type === "number") inner = renderNumberInput(hf);
          else if (hf.type === "text") inner = renderTextInput(hf);
          else if (hf.type === "date") inner = renderDateInput(hf);
          fieldsHTML += '<div class="ob2-field">' + lab + inner + '</div>';
        }
        fieldsHTML += '</div></div>';
        halfBuf = [];
      }
    } else {
      // Flush any pending half
      if (halfBuf.length > 0) {
        var hf2 = halfBuf[0];
        fieldsHTML += '<div class="ob2-field">' + renderField(hf2, q) + '</div>';
        halfBuf = [];
      }
      fieldsHTML += renderField(f, q);
    }
  }

  // Flush remaining half field
  if (halfBuf.length > 0) {
    fieldsHTML += renderField(halfBuf[0], q);
  }

  return fieldsHTML;
}

/* ═══════════════════════════ WIRING ═════════════════════════════════ */

function wireQuestion(rootEl, q) {
  // Wire chip/card taps
  rootEl.querySelectorAll("[data-field]").forEach(function (el) {
    if (el.tagName !== "BUTTON") return;
    el.addEventListener("click", function () {
      var fieldId = el.dataset.field;
      var raw = el.dataset.value;
      var scope = el.closest(".conv-q-wrap") || el.closest(".ob2-step") || rootEl;
      clearAdvanceTimer();

      if (el.dataset.multi === "1") {
        // Multi-select
        var cur = Array.isArray(currentFieldData[fieldId]) ? currentFieldData[fieldId].slice() : [];
        if (el.dataset.exclusive === "1") {
          currentFieldData[fieldId] = cur.indexOf(raw) >= 0 ? [] : [raw];
        } else {
          var filtered = cur.filter(function (v) { return v !== "none"; });
          currentFieldData[fieldId] = filtered.indexOf(raw) >= 0
            ? filtered.filter(function (v) { return v !== raw; })
            : filtered.concat(raw);
        }
        refreshSelections(fieldId, scope);
        if (el.classList.contains("sel")) pop(el);
        updateContinueState(q);
        return;
      }

      // Single select
      var opt = findOption(q, fieldId, raw);
      var value = opt ? opt.value : raw;
      var prevValue = currentFieldData[fieldId];
      currentFieldData[fieldId] = value;

      // Check if showWhen visibility changed
      var visChanged = q.fields.some(function (f) {
        if (!f.showWhen) return false;
        var nowMatch = checkShowWhenField(f.showWhen, fieldId, value);
        var prevMatch = checkShowWhenField(f.showWhen, fieldId, prevValue);
        return nowMatch !== prevMatch;
      });

      if (visChanged) {
        // Re-render fields within the conversation wrap
        var wrap = el.closest(".conv-q-wrap");
        if (wrap) {
          wrap.innerHTML = buildFieldsHTML(q);
          wireQuestion(wrap, q);
        }
      } else {
        refreshSelections(fieldId, scope);
        pop(el);
        updateContinueState(q);
      }

      // Auto-advance for single-choice screens
      if (q.autoAdvance && !visChanged && !validateQuestion(q)) {
        scheduleAutoAdvance(q);
      }
    });
  });

  // Wire text/number/date inputs
  rootEl.querySelectorAll("input, textarea").forEach(function (el) {
    var sync = function () {
      collectInputs(q);
      updateContinueState(q);
    };
    el.addEventListener("input", sync);
    el.addEventListener("change", sync);
  });
}

function checkShowWhenField(cond, fieldId, value) {
  if (!(fieldId in cond)) return true; // not related
  var expected = cond[fieldId];
  if (Array.isArray(expected)) return expected.indexOf(value) >= 0;
  return value === expected;
}

function findOption(q, fieldId, rawValue) {
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (f.id !== fieldId || !f.options) continue;
    for (var j = 0; j < f.options.length; j++) {
      if (String(f.options[j].value) === String(rawValue)) return f.options[j];
    }
  }
  return null;
}

function refreshSelections(fieldId, scope) {
  var value = currentFieldData[fieldId];
  scope.querySelectorAll('[data-field="' + fieldId + '"]').forEach(function (el) {
    var raw = el.dataset.value;
    var on;
    if (Array.isArray(value)) {
      on = value.map(String).indexOf(raw) >= 0;
    } else {
      on = value != null && String(value) === raw;
    }
    el.classList.toggle("sel", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function collectInputs(q) {
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    if (["text", "number", "date", "textarea"].indexOf(f.type) >= 0) {
      var el = document.getElementById("diagf-" + f.id);
      if (el) currentFieldData[f.id] = el.value;
    }
  }
}

/* ═══════════════════════════ VALIDATION ═════════════════════════════ */

function validateQuestion(q) {
  for (var i = 0; i < q.fields.length; i++) {
    var f = q.fields[i];
    // Skip hidden conditional fields
    if (f.showWhen && !checkShowWhen(f.showWhen)) continue;

    var value = currentFieldData[f.id];

    if (f.required) {
      var empty = value == null || value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty) return 'Please complete "' + f.label + '" to continue.';
    }

    if (f.type === "number" && value !== "" && value != null) {
      var n = Number(value);
      if (!isFinite(n)) return 'Please enter a valid number for "' + f.label + '".';
      if (f.min != null && n < f.min) return '"' + f.label + '" should be at least ' + f.min + '.';
      if (f.max != null && n > f.max) return '"' + f.label + '" should be ' + f.max + ' or less.';
    }
    if (f.maxLength && typeof value === "string" && value.length > f.maxLength) {
      return '"' + f.label + '" should be ' + f.maxLength + ' characters or less.';
    }
  }
  return null; // valid
}

/* ═══════════════════════════ CHROME ══════════════════════════════════ */

function updateChrome(q) {
  // Progress bar — based on information completeness, not question count
  var fill = document.querySelector("#diagProgress .ob2-fill");
  var progress = document.getElementById("diagProgress");
  if (progress) progress.style.visibility = "";
  if (!fill) {
    var container = document.getElementById("diagProgress");
    if (container) {
      container.innerHTML = '<i class="ob2-fill"></i>';
      fill = container.querySelector(".ob2-fill");
    }
  }
  if (fill) {
    var completeness = engine.completeness();
    fill.style.transform = "scaleX(" + Math.max(0.0001, completeness) + ")";
  }

  // Back button
  var back = document.getElementById("diagBack");
  if (back) {
    var currentHistoryIndex = q ? engine.history.indexOf(q.key) : -1;
    back.disabled = currentHistoryIndex === 0 || (currentHistoryIndex < 0 && engine.history.length === 0);
  }

  updateContinueState(q);
}

function updateContinueState(q) {
  if (mode !== "question") return;
  var cont = document.getElementById("diagContinue");
  if (!cont) return;

  var valid = !validateQuestion(q);
  cont.classList.toggle("ready", valid);
  cont.textContent = "Continue";
  cont.classList.remove("done");
}

function showFoot(visible) {
  var foot = document.getElementById("diagFoot");
  if (foot) foot.style.display = visible ? "" : "none";
}

function setMessage(text) {
  var msg = document.getElementById("diagMsg");
  if (msg) msg.textContent = text || "";
}

/* ═══════════════════════════ NAVIGATION ═════════════════════════════ */

/**
 * Continue: record the current answer, collapse to echo, show
 * interpretation inline, then append the next question.
 */
function diagContinue() {
  if (busy) return;
  clearAdvanceTimer();

  var q = currentQuestion;
  if (!q) return;

  collectInputs(q);
  var problem = validateQuestion(q);
  if (problem) {
    setMessage(problem);
    return;
  }
  setMessage("");

  busy = true;
  var cont = document.getElementById("diagContinue");
  if (cont) cont.disabled = true;

  try {
    // Record answer in engine
    var interpretation = engine.recordAnswer(q.key, currentFieldData);
    if (interpretation) interpretationCache[q.key] = interpretation;

    trackEvent("diagnostic_question_answered", {
      question_key: q.key,
      questions_completed: engine.history.length
    });

    // Collapse the active fields into an echo
    var thread = ensureThread();
    if (thread) {
      var wrap = thread.querySelector(".conv-q-wrap");
      if (wrap) {
        var echoLabel = getAnswerEchoLabel(q, currentFieldData);
        var echoEl = createEl(
          '<div class="conv-echo">' +
            '<span class="conv-echo-label">You</span>' +
            '<span class="conv-echo-value">' + esc(echoLabel) + '</span>' +
          '</div>'
        );
        wrap.replaceWith(echoEl);
        animateIn(echoEl);
      }

      // Show coaching interpretation inline
      if (interpretation) {
        appendAthlevoMsg(thread, interpretation);
      }
    }

    // Check if diagnostic is complete
    if (engine.canComplete()) {
      completeDiagnostic();
      return;
    }

    // Append next question
    var next = engine.nextQuestion();
    if (next && thread) {
      appendActiveQuestion(thread, next);
    } else if (engine.canComplete()) {
      completeDiagnostic();
    }
  } finally {
    busy = false;
    if (cont) cont.disabled = false;
  }
}

/**
 * Back: rewind the engine and rebuild the conversation thread
 * up to the previous question with pre-filled fields.
 */
function diagBack() {
  if (busy) return;
  clearAdvanceTimer();

  var prev = engine.previousQuestion(currentQuestion ? currentQuestion.key : null);
  if (!prev) return;

  currentFieldData = {};
  prefillFromAnswers(prev);
  rebuildConversation(prev);
  mode = "question";
  focusMain(getBody() && getBody().querySelector(".conv-q-wrap"));
}

function getCurrentQuestionDef() {
  return currentQuestion;
}

/* ═══════════════════════════ AUTO-ADVANCE ═══════════════════════════ */

function scheduleAutoAdvance(q) {
  clearAdvanceTimer();
  var delay = reducedMotion() ? 140 : 300;
  advanceTimer = setTimeout(function () {
    advanceTimer = null;
    if (mode === "question") diagContinue();
  }, delay);
}

function clearAdvanceTimer() {
  if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
}

/* ═══════════════════════════ COMPLETION ═════════════════════════════ */

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

/* ═══════════════════════════ BUILD ANIMATION ════════════════════════ */

function showBuildAnimation(result) {
  var body = getBody();
  if (!body) { renderResult(); return; }
  mode = "result";
  showFoot(false);

  // Set progress to 100%
  var fill = document.querySelector("#diagProgress .ob2-fill");
  if (fill) fill.style.transform = "scaleX(1)";

  var lines = [
    "Analysing your running profile",
    "Identifying your primary limiter",
    "Assessing goal feasibility",
    "Building your coaching strategy"
  ];

  var html =
    '<div class="ob2-payoff">' +
      '<div class="ob2-build" id="diagBuild">' +
        '<div class="ob2-build-ring"><span>Building</span></div>' +
        '<h2 class="ob2-title">Building your coaching profile</h2>' +
        '<ul class="ob2-build-lines">';

  for (var i = 0; i < lines.length; i++) {
    html += '<li><i></i>' + esc(lines[i]) + '</li>';
  }

  html += '</ul></div></div>';

  body.innerHTML = html;
  body.scrollTop = 0;

  // Animate lines appearing
  var items = body.querySelectorAll(".ob2-build-lines li");
  var delay = reducedMotion() ? 100 : 500;

  for (var j = 0; j < items.length; j++) {
    (function (item, idx) {
      setTimeout(function () { item.classList.add("on"); }, delay * (idx + 1));
    })(items[j], j);
  }

  // After all lines, show result
  setTimeout(function () {
    renderResult();
  }, delay * (lines.length + 1) + 400);
}

/* ═══════════════════════════ RESULT SCREEN ══════════════════════════ */

function renderResult() {
  var body = getBody();
  if (!body) return;
  mode = "result";
  showFoot(false);

  // Hide back button and progress during result
  var back = document.getElementById("diagBack");
  if (back) back.disabled = true;

  var result = engine.result;
  if (!result) return;
  currentQuestion = null;

  var html = '<div class="diag-result">';

  // ── Athlete Profile Summary ──
  html += '<section class="diag-section">';
  html += '<span class="ob2-eyebrow">Your running profile</span>';
  html += '<h2 class="ob2-title" tabindex="-1">' + esc(result.profile.goal) + '</h2>';
  html += '<div class="diag-profile-meta">';
  html += '<span>' + esc(result.profile.experience) + '</span>';
  html += '<span>' + esc(result.profile.trainingStatus) + '</span>';
  if (result.profile.weeklyMileage) {
    html += '<span>' + Math.round(result.profile.weeklyMileage) + ' km/week</span>';
  }
  if (result.profile.trainingDays) {
    html += '<span>' + result.profile.trainingDays + ' days/week</span>';
  }
  html += '</div>';
  html += '</section>';

  // ── Strengths ──
  if (result.strengths && result.strengths.length > 0) {
    html += '<section class="diag-section">';
    html += '<span class="ob2-eyebrow">What you\'re doing well</span>';
    for (var s = 0; s < result.strengths.length; s++) {
      var str = result.strengths[s];
      html += '<div class="diag-strength">';
      html += '<h3 class="diag-strength-label">' + esc(str.label) + '</h3>';
      html += '<p class="diag-strength-detail">' + esc(str.detail) + '</p>';
      html += '</div>';
    }
    html += '</section>';
  }

  // ── Primary Limiter ──
  if (result.primaryLimiter) {
    html += '<section class="diag-section diag-limiter-section">';
    html += '<span class="ob2-eyebrow">Primary limiter</span>';
    html += '<h2 class="diag-limiter-title">' + esc(result.primaryLimiter.label) + '</h2>';
    html += '<p class="diag-limiter-explanation">' + esc(result.primaryLimiter.explanation) + '</p>';
    html += '</section>';

    // ── What's Holding You Back ──
    if (result.holdingBack) {
      html += '<section class="diag-section">';
      html += '<span class="ob2-eyebrow">What\'s holding you back</span>';
      html += '<p class="diag-narrative">' + esc(result.holdingBack) + '</p>';
      html += '</section>';
    }

    // ── What We'd Change ──
    if (result.whatWedChange && result.whatWedChange.length > 0) {
      html += '<section class="diag-section">';
      html += '<span class="ob2-eyebrow">What we\'d change</span>';
      html += '<ul class="diag-changes">';
      for (var c = 0; c < result.whatWedChange.length; c++) {
        html += '<li>' + esc(result.whatWedChange[c]) + '</li>';
      }
      html += '</ul>';
      html += '</section>';
    }
  }

  // ── Goal Feasibility ──
  if (result.feasibility) {
    var fRatingClass = "diag-feasibility-" + result.feasibility.rating.replace(/_/g, "-");
    html += '<section class="diag-section">';
    html += '<span class="ob2-eyebrow">Goal feasibility</span>';
    html += '<div class="diag-feasibility ' + fRatingClass + '">';
    html += '<span class="diag-feasibility-badge">' + esc(result.feasibility.label) + '</span>';
    html += '<p class="diag-feasibility-text">' + esc(result.feasibility.explanation) + '</p>';
    html += '</div>';
    html += '</section>';
  }

  // ── Safety Notice ──
  if (result.safetyFlags.requiresMedicalClearance) {
    html += '<section class="diag-section diag-safety">';
    html += '<p class="diag-safety-text">Athlevo is not a medical provider. Based on what you\'ve shared, please consult a qualified health professional before beginning or modifying any training program.</p>';
    html += '</section>';
  }

  // ── Personalized Athlevo approach ──
  var rec = result.athlevoRecommendation;
  if (rec) {
    html += '<section class="diag-section diag-recommendation">';
    html += '<span class="ob2-eyebrow">Athlevo AI</span>';
    html += '<div class="diag-rec-card">';
    html += '<h2 class="diag-rec-name">' + esc(rec.heading) + '</h2>';
    html += '<p class="diag-rec-rationale">' + esc(rec.strategy) + '</p>';
    if (!rec.safetyOverride && rec.capabilities) {
      html += '<ul class="diag-rec-caps">';
      for (var cap = 0; cap < rec.capabilities.length; cap++) {
        html += '<li>' + esc(rec.capabilities[cap]) + '</li>';
      }
      html += '</ul>';
    }
    html += '</div>';
    html += '</section>';
  }

  // ── CTA ──
  if (!rec || !rec.safetyOverride) {
    html += '<section class="diag-section diag-cta-section">';
    html += '<p class="diag-cta-price">₱597/month</p>';
    html += '<p class="diag-cta-price-note">Full Athlevo Pro access</p>';
    html += '<button class="diag-cta-primary" id="diagSaveCTA" type="button">Start training with Athlevo</button>';
    html += '<p class="diag-cta-sub">Your diagnostic is saved. Create your account to begin.</p>';
    html += '</section>';
  }

  html += '</div>';

  body.innerHTML = html;
  body.scrollTop = 0;
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

  // Animate entry
  var resultEl = body.querySelector(".diag-result");
  if (canAnimate(resultEl)) {
    resultEl.animate(
      [{ opacity: 0, transform: "translateY(16px)" },
       { opacity: 1, transform: "none" }],
      { duration: 400, easing: EASE, fill: "both" });
  }

  // Wire CTA
  var cta = document.getElementById("diagSaveCTA");
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
      // Navigate to auth screen — diagnostic data persists in localStorage
      // until successfully written to Supabase after auth
      if (root.openAppEntry) {
        root.openAppEntry();
      } else {
        showScreen("screen-welcome");
      }
    });
  }
  focusMain(resultEl ? resultEl.querySelector(".ob2-title") : null);
}

/* ═══════════════════════════ DOM HELPERS ════════════════════════════ */

function getBody() {
  return document.getElementById("diagBody");
}

function createEl(html) {
  var tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function focusMain(el) {
  if (!el || typeof el.focus !== "function") return;
  setTimeout(function () {
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }, reducedMotion() ? 0 : 40);
}

/* ═══════════════════════════ ANALYTICS ══════════════════════════════ */

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

/* ═══════════════════════════ DOM INIT ═══════════════════════════════ */

function initDOM() {
  // Wire back button
  var backBtn = document.getElementById("diagBack");
  if (backBtn) {
    backBtn.addEventListener("click", function () { diagBack(); });
  }
  // Wire continue button
  var contBtn = document.getElementById("diagContinue");
  if (contBtn) {
    contBtn.addEventListener("click", function () { diagContinue(); });
  }
}

// Auto-init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDOM);
} else {
  initDOM();
}

/* ═══════════════════════════ EXPORT ═════════════════════════════════ */

var DiagnosticUI = {
  start: startDiagnostic,
  continue: diagContinue,
  back: diagBack,
  // For testing / external access
  getEngine: function () { return engine; }
};

root.AthlevoDiagnosticUI = DiagnosticUI;

if (typeof module !== "undefined" && module.exports) {
  module.exports = DiagnosticUI;
}

})(typeof window !== "undefined" ? window : this);
