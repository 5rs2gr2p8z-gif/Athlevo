/* Athlevo — anonymous Coach preview conversation.
 *
 * Lets a signed-out visitor actually talk to Athlevo inside the Coach chat
 * instead of hitting a signup wall on the first message. Distinct from the
 * authenticated Coach flow in askCoach():
 *   - never calls /api/coach, never touches the 10-message free quota
 *   - never writes to coach_threads / coach_conversations — everything
 *     lives in sessionStorage only, for this browser tab, until signup
 *   - drives the SAME pre-signup diagnostic question bank
 *     (window.AthlevoDiagnostic, js/diagnostic.js) one question at a time,
 *     so facts collected here flow into the existing diagnostic handoff
 *     (js/diagnosticHandoff.js) after signup — no second athlete-profile
 *     model.
 *
 * askCoach() in js/coach.js calls into askAnonymousCoach() below for every
 * signed-out send (typed or starter tap). That is the only integration
 * point; nothing else about Coach's authenticated behaviour changes.
 */
(function (root) {
  "use strict";

  var HISTORY_KEY = "athlevo_anonymous_coach_history_v1";
  var MAX_HISTORY_TURNS = 8;
  var MIN_TURNS_BEFORE_CTA = 3;

  var _turnCount = 0;
  var _ctaShown = false;

  function readHistory() {
    try {
      var parsed = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeHistory(history) {
    try {
      sessionStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(history.slice(-MAX_HISTORY_TURNS))
      );
    } catch (e) {}
  }

  function appendHistory(role, text) {
    var history = readHistory();
    history.push({ role: role, text: String(text || "").slice(0, 800) });
    writeHistory(history);
    return history;
  }

  function track(name, props) {
    try {
      if (root.AthlevoProductAnalytics) {
        root.AthlevoProductAnalytics.trackAthlevoEvent(
          name,
          Object.assign({ source_surface: "coach_anonymous" }, props || {})
        );
      }
    } catch (e) {}
  }

  /* The engine tracks its own persisted question/answer history
   * (window.AthlevoDiagnostic, same storage the post-signup handoff
   * reads) — that IS the durable "facts learned so far" ledger, so this
   * module does not keep a second one. */
  function getEngine() {
    if (!root.AthlevoDiagnostic) return null;
    var engine = root.AthlevoDiagnostic.load() || root.AthlevoDiagnostic.create();
    if (!engine.begun) engine.begin();
    return engine;
  }

  /* Always the NEXT unanswered question — never engine.currentQuestion(),
   * which (after recordAnswer moves currentIndex to the just-answered
   * question) would hand back something already answered instead of
   * advancing. There is no "revisit previous question" concept here. */
  function currentQuestion(engine) {
    if (!engine) return null;
    try {
      return engine.nextQuestion();
    } catch (e) {
      return null;
    }
  }

  function serializeFields(question) {
    if (!question || !Array.isArray(question.fields)) return [];
    return question.fields.map(function (field) {
      var out = {
        id: field.id,
        type: field.type,
        label: field.label || field.id,
        required: field.required === true
      };
      if (Array.isArray(field.options)) {
        out.options = field.options.map(function (opt) { return { value: opt.value }; });
      }
      return out;
    });
  }

  function hasRequiredFields(question, extracted) {
    if (!question || !Array.isArray(question.fields)) return false;
    var any = false;
    for (var i = 0; i < question.fields.length; i++) {
      var field = question.fields[i];
      var value = extracted && extracted[field.id];
      var present = value !== null && value !== undefined && value !== "" &&
        !(Array.isArray(value) && value.length === 0);
      if (present) any = true;
      if (field.required && !present) return false;
    }
    return any;
  }

  /* Renders the CTA inline, in the same bubble as the reply that earned
   * it — never as a separate interruption, and never before the visitor
   * has gotten real value. The permanent header "Sign up" button covers
   * anyone ready earlier. */
  function appendSignupCta(container) {
    if (_ctaShown) return;
    _ctaShown = true;
    track("coach_anonymous_cta_shown", {});

    var wrap = document.createElement("div");
    wrap.className = "coach-anonymous-cta";
    wrap.style.marginTop = "10px";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "coach-suggestion coach-suggestion--recommended";
    btn.textContent = "Continue with Athlevo";
    btn.addEventListener("click", function () {
      track("coach_anonymous_cta_clicked", {});
      if (typeof root.openSignup === "function") root.openSignup(true);
    });
    wrap.appendChild(btn);
    container.appendChild(wrap);
  }

  async function askAnonymousCoach(question) {
    var cleanQuestion = String(question || "").trim();
    if (!cleanQuestion) return;

    if (typeof root.hideCoachEmptyState === "function") root.hideCoachEmptyState();
    var userMessage = typeof root.addChatMessage === "function"
      ? root.addChatMessage("user", cleanQuestion)
      : null;

    var loadingMessage = typeof root.addChatMessage === "function"
      ? root.addChatMessage("ai", "")
      : null;
    var changeEl = loadingMessage && loadingMessage.querySelector
      ? loadingMessage.querySelector(".change")
      : null;
    if (changeEl && typeof root.createCoachThinkingEl === "function") {
      var thinkingEl = root.createCoachThinkingEl();
      changeEl.innerHTML = "";
      changeEl.appendChild(thinkingEl);
      var labelEl = thinkingEl.querySelector(".coach-thinking-label");
      if (typeof root.startThinkingLabelRotation === "function") {
        root.startThinkingLabelRotation(labelEl);
      }
    }
    if (typeof root.setCoachSendingState === "function") root.setCoachSendingState(true);

    var engine = getEngine();
    var question_obj = currentQuestion(engine);
    var history = appendHistory("user", cleanQuestion);

    try {
      var response = await fetch("/api/coach-anonymous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: cleanQuestion,
          question_key: question_obj ? question_obj.key : null,
          question_fields: serializeFields(question_obj),
          history: history.slice(0, -1)
        })
      });

      var data = null;
      try { data = await response.json(); } catch (e) { data = null; }

      var reply = (data && typeof data.reply === "string" && data.reply.trim()) ||
        "I can help you work that out — tell me a bit more about your running right now.";
      var extracted = (data && data.extracted && typeof data.extracted === "object")
        ? data.extracted
        : {};

      if (engine && question_obj && hasRequiredFields(question_obj, extracted)) {
        try { engine.recordAnswer(question_obj.key, extracted); } catch (e) {}
      }

      if (typeof root.stopThinkingLabelRotation === "function") root.stopThinkingLabelRotation();

      if (changeEl && typeof root.renderCoachResponse === "function") {
        root.renderCoachResponse(changeEl, { direct_answer: reply });
      } else if (changeEl) {
        changeEl.textContent = reply;
      }

      appendHistory("assistant", reply);
      _turnCount += 1;
      track("coach_anonymous_message_completed", { turn: _turnCount });

      var readyToComplete = engine && typeof engine.canComplete === "function" && engine.canComplete();
      if (engine && readyToComplete && !engine.completed) {
        try { engine.complete(); } catch (e) {}
      }
      var shouldOfferSignup = _turnCount >= MIN_TURNS_BEFORE_CTA ||
        (engine && engine.completed);
      if (shouldOfferSignup && changeEl) appendSignupCta(changeEl);
    } catch (error) {
      if (typeof root.stopThinkingLabelRotation === "function") root.stopThinkingLabelRotation();
      if (changeEl) {
        changeEl.textContent =
          "I couldn't reach Athlevo just now — try again in a moment.";
      }
      track("coach_anonymous_message_failed", {});
    } finally {
      if (typeof root.setCoachSendingState === "function") root.setCoachSendingState(false);
    }
  }

  root.AthlevoAnonymousCoach = {
    ask: askAnonymousCoach,
    resetSessionForTest: function () {
      _turnCount = 0;
      _ctaShown = false;
      try { sessionStorage.removeItem(HISTORY_KEY); } catch (e) {}
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { askAnonymousCoach: askAnonymousCoach };
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
