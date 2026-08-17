/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Managed Athlete Mode (client)   ·   window.AthlevoAthleteMode
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The client-side counterpart to /api/providers?action=athlete_*. The browser NEVER decides
 *  the coaching mode — it fetches the authoritative answer from the server and
 *  then configures the UI accordingly.
 *
 *  THREE client states (the security-critical distinction):
 *
 *    self_guided   — ONLY after the server explicitly confirms no active
 *                    assignment. AI plan generation / editing is enabled.
 *    human_coached — ONLY after the server explicitly confirms an active
 *                    assignment. Coach identity is shown; AI controls are gated.
 *    unknown       — loading, network failure, auth failure, 500, migration
 *                    error, or any other verification failure. This is the
 *                    DEFAULT until the server says otherwise.
 *
 *  For unknown mode:
 *    · AI plan generation / AI plan-editing controls are NOT shown.
 *    · Human coach identity is NOT rendered (unverified).
 *    · Coach-owned workout editing is NOT enabled.
 *    · A neutral recoverable notice is shown with a retry action.
 *    · athlete_coaching_mode_resolved is NOT emitted.
 *    · The unknown result is NOT cached as a confirmed mode.
 *
 *  Privacy: no coach email (unless explicitly public), no tokens, no auth
 *  fields ever written to analytics. Only categorical events are fired.
 */

(function () {
  "use strict";

  // ─── Internal state (never exposed raw) ──────────────────────────────
  var _mode = "unknown";  // "self_guided" | "human_coached" | "unknown"
  var _coach = null;      // safe coach profile from server (only when human_coached)
  var _transition = null; // pending transition (if any)
  var _ambiguous = false;
  var _confirmed = false; // true ONLY after a successful authoritative server response
  var _fetching = false;
  var _fetchPromise = null;
  var _cacheKey = null;
  var _lastError = null;  // categorical error reason (never raw message)
  var _thread = null;
  var _threadLoading = false;
  var _sendInFlight = false;
  var _threadScroll = { top: 0, nearBottom: true };
  var _renderedThreadCount = 0;
  var _requestGeneration = 0;
  var MODE_STALE_MS = 2 * 60 * 1000;

  // ─── Helpers ─────────────────────────────────────────────────────────
  function sb() { return typeof supabaseClient !== "undefined" ? supabaseClient : null; }
  function analytics() { return window.AthlevoAnalytics || null; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function token() {
    var c = sb();
    if (!c) return null;
    try {
      var r = await c.auth.getSession();
      return (r && r.data && r.data.session && r.data.session.access_token) || null;
    } catch (e) { return null; }
  }

  function track(event, props) {
    var a = analytics();
    if (a && typeof a.track === "function") a.track(event, props || {});
  }

  // ─── Mode fetch (authoritative, server-side) ────────────────────────
  //
  // A confirmed mode requires ALL of:
  //   1. A valid auth token was available
  //   2. The server responded 200
  //   3. The response contained a recognized coaching_mode value
  //
  // Anything else → unknown. Unknown is never cached as confirmed.
  function fetchMode(force) {
    if (_fetchPromise) return _fetchPromise;
    if (_confirmed && !force) return Promise.resolve(_mode);
    _fetching = true;
    _lastError = null;
    var requestGeneration = _requestGeneration;
    var request = (async function () {
      try {
        var t = await token();
        if (requestGeneration !== _requestGeneration) return _mode;
        if (!t) {
          // No token: cannot verify. Stay unknown.
          _mode = "unknown";
          _confirmed = false;
          _lastError = "no_token";
          return _mode;
        }
        var resp = await fetch("/api/providers?action=athlete_coaching_mode", {
          headers: { Authorization: "Bearer " + t }
        });
        if (requestGeneration !== _requestGeneration) return _mode;
        if (!resp.ok) {
          // Server rejected: 401/403/500/503/etc. Stay unknown.
          _mode = "unknown";
          _confirmed = false;
          _lastError = resp.status === 401 || resp.status === 403 ? "auth_failed" : "server_error";
          return _mode;
        }
        var data = await resp.json();
        if (requestGeneration !== _requestGeneration) return _mode;
        var serverMode = data.coaching_mode;
        if (serverMode !== "self_guided" && serverMode !== "human_coached") {
          // Unrecognized mode value: do not trust. Stay unknown.
          _mode = "unknown";
          _confirmed = false;
          _lastError = "unrecognized_mode";
          return _mode;
        }
        // ─── Authoritative confirmation ───
        _mode = serverMode;
        _coach = serverMode === "human_coached" ? (data.coach || null) : null;
        _transition = data.transition || null;
        _ambiguous = !!data.ambiguous;
        _confirmed = true;
        _cacheKey = Date.now();
        _lastError = null;
        track("athlete_coaching_mode_resolved", { coaching_mode: _mode });
        return _mode;
      } catch (e) {
        if (requestGeneration !== _requestGeneration) return _mode;
        // Network failure, JSON parse error, etc. Stay unknown.
        _mode = "unknown";
        _confirmed = false;
        _coach = null;
        _transition = null;
        _lastError = "network";
        return _mode;
      } finally {
        if (_fetchPromise === request) {
          _fetching = false;
          _fetchPromise = null;
        }
      }
    })();
    _fetchPromise = request;
    return _fetchPromise;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  function mode()        { return _mode; }
  function isManaged()   { return _mode === "human_coached"; }
  function isUnknown()   { return _mode === "unknown"; }
  function isConfirmed() { return _confirmed; }
  function coach()       { return _mode === "human_coached" ? _coach : null; }
  function transition()  { return _mode === "human_coached" ? _transition : null; }
  function lastError()   { return _lastError; }

  // ─── Unknown-mode notice ─────────────────────────────────────────────
  // Shows a neutral recoverable notice when mode cannot be verified.
  // Does not expose AI controls or coach identity.
  var _noticeId = "am-unknown-notice";

  function showUnknownNotice() {
    if (_mode !== "unknown") return;
    // Avoid duplicates
    if (document.getElementById(_noticeId)) return;

    var notice = document.createElement("div");
    notice.id = _noticeId;
    notice.style.cssText = "position:fixed;bottom:80px;left:16px;right:16px;z-index:9999;" +
      "padding:14px 16px;background:var(--warning-soft);border:1px solid var(--warning);border-radius:var(--ui-radius-control);" +
      "font-size:var(--fs-body-sm);color:var(--warning);display:flex;align-items:center;gap:var(--s-3);box-shadow:var(--elev-2);";

    var text = document.createElement("span");
    text.style.cssText = "flex:1;";
    text.textContent = "Athlevo couldn’t verify your coaching setup. Refresh and try again.";

    var retryBtn = document.createElement("button");
    retryBtn.textContent = "Retry";
    retryBtn.style.cssText = "min-height:var(--control-height);padding:6px 14px;font-size:var(--fs-body-sm);font-weight:600;border:1px solid var(--warning);" +
      "color:var(--warning);background:transparent;border-radius:var(--r-pill);cursor:pointer;flex-shrink:0;";
    retryBtn.addEventListener("click", function () {
      retryBtn.disabled = true;
      retryBtn.textContent = "Checking…";
      retry().then(function () {
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry";
      });
    });

    notice.appendChild(text);
    notice.appendChild(retryBtn);

    var body = document.body || document.documentElement;
    body.appendChild(notice);
  }

  function hideUnknownNotice() {
    var el = document.getElementById(_noticeId);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ─── AI control suppression for unknown mode ─────────────────────────
  // When mode is unknown, hide AI plan-generation and AI plan-editing
  // controls so neither self_guided nor human_coached authority is assumed.
  function suppressAIControls() {
    if (_mode !== "unknown") return;
    var selectors = [
      "[data-action='generate-plan']",
      "[data-action='regenerate-plan']",
      "[data-action='ai-generate']",
      "[data-action='edit']",
      "[data-action='modify']",
      "[data-action='skip']",
      "[data-action='replace']",
      ".plan-generate-btn",
      ".plan-regenerate-btn"
    ];
    selectors.forEach(function (sel) {
      var els = document.querySelectorAll(sel);
      els.forEach(function (el) {
        if (el.disabled && el.getAttribute("data-am-suppressed") !== "true") return;
        if (!el.disabled) el.setAttribute("data-am-suppressed", "true");
        el.disabled = true;
        el.style.opacity = "0.35";
        el.title = "Coaching setup could not be verified";
      });
    });
  }

  // Restore controls that were suppressed (called after successful retry).
  function restoreSuppressedControls() {
    var els = document.querySelectorAll("[data-am-suppressed='true']");
    els.forEach(function (el) {
      el.disabled = false;
      el.style.opacity = "";
      el.title = "";
      el.removeAttribute("data-am-suppressed");
    });
  }

  // ─── Today: authorship labels ────────────────────────────────────────
  // Returns a label string for a session card, or null if no label applies.
  function authorshipLabel(session) {
    if (_mode !== "human_coached") return null;
    if (!session) return null;
    var owner = String(session.owner_type || session.source || "").toLowerCase();
    if (owner === "human_coach" || owner === "coach") {
      var name = (_coach && _coach.display_name) ? _coach.display_name : "your coach";
      return "Prescribed by " + name;
    }
    return null;
  }

  // Injects authorship labels into Today session cards (idempotent).
  function applyTodayLabels() {
    if (_mode !== "human_coached") return;
    var cards = document.querySelectorAll("[data-session-id]");
    cards.forEach(function (card) {
      if (card.querySelector(".am-authorship-label")) return; // already applied
      var ownerType = card.getAttribute("data-owner-type") || card.getAttribute("data-source") || "";
      var label = authorshipLabel({ owner_type: ownerType });
      if (!label) return;
      var el = document.createElement("div");
      el.className = "am-authorship-label";
      el.style.cssText = "font-size:var(--fs-caption);color:var(--text-muted);margin-top:var(--s-1);font-style:italic;";
      el.textContent = label;
      card.insertBefore(el, card.firstChild);
    });
  }

  // ─── Coach tab: authoritative mode surfaces ─────────────────────────
  // Keep the original AI DOM alive (and its listeners intact), but never
  // expose it until the server has confirmed self-guided mode.
  function coachScreen() {
    return document.getElementById("screen-coachai");
  }

  function setAiCoachVisible(visible) {
    var screen = coachScreen();
    if (!screen) return;
    Array.prototype.forEach.call(screen.children, function (child) {
      if (child.classList && child.classList.contains("am-coach-mode-mount")) return;
      child.hidden = !visible;
      if (child.classList) child.classList.toggle("am-ai-surface-hidden", !visible);
      child.setAttribute("aria-hidden", visible ? "false" : "true");
    });
  }

  function removeCoachModeMounts() {
    document.querySelectorAll("#screen-coachai > .am-coach-mode-mount").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function markCoachSurfaceReady(target) {
    var screen = coachScreen();
    if (!screen) return;
    var surfaces = target ? [target] : Array.prototype.filter.call(screen.children, function (child) {
      return !child.hidden && !(child.classList && child.classList.contains("am-coach-mode-mount"));
    });
    surfaces.forEach(function (surface) { surface.classList.remove("am-coach-surface-enter"); });
    var nextFrame = window.requestAnimationFrame || function (callback) { callback(); };
    nextFrame(function () {
      surfaces.forEach(function (surface) { surface.classList.add("am-coach-surface-enter"); });
      setTimeout(function () {
        surfaces.forEach(function (surface) { surface.classList.remove("am-coach-surface-enter"); });
      }, 120);
    });
  }

  function renderUnknownCoachTab() {
    var screen = coachScreen();
    if (!screen) return;
    setAiCoachVisible(false);
    removeCoachModeMounts();
    var mount = document.createElement("div");
    mount.className = "am-coach-mode-mount am-coach-resolving";
    mount.setAttribute("aria-live", "polite");
    if (_lastError) {
      mount.innerHTML = '<div class="am-coach-resolution-error" role="alert">' +
        '<h2>Coach is temporarily unavailable</h2>' +
        '<p>Athlevo couldn’t verify your coaching setup. Your coaching access remains protected.</p>' +
        '<button type="button" data-am-coach-retry>Try again</button></div>';
      var retryButton = mount.querySelector("[data-am-coach-retry]");
      if (retryButton) retryButton.addEventListener("click", function () { retry(); });
    } else {
      mount.setAttribute("aria-label", "Loading Coach");
      mount.innerHTML = '<div class="am-coach-resolving-head" aria-hidden="true">' +
          '<span class="skel skel-circle"></span><span class="am-coach-resolving-copy">' +
            '<i class="skel"></i><i class="skel"></i></span></div>' +
        '<div class="am-coach-resolving-thread" aria-hidden="true">' +
          '<div class="skel am-coach-context-skeleton"></div>' +
          '<div class="skel am-coach-message-skeleton is-wide"></div>' +
          '<div class="skel am-coach-message-skeleton is-athlete"></div>' +
          '<div class="skel am-coach-message-skeleton"></div></div>' +
        '<div class="skel am-coach-resolving-composer" aria-hidden="true"></div>';
    }
    screen.appendChild(mount);
  }

  function restoreSelfGuidedCoachTab() {
    removeCoachModeMounts();
    setAiCoachVisible(true);
    markCoachSurfaceReady();
  }

  function clearAiCoachDom() {
    var screen = coachScreen();
    if (!screen) return;
    screen.classList.remove("coach-is-active");
    screen.classList.add("coach-is-empty");
    var chatlog = document.getElementById("chatlog");
    if (chatlog) chatlog.querySelectorAll(".msg").forEach(function (el) { el.remove(); });
    var empty = document.getElementById("coachEmptyState");
    if (empty) empty.hidden = false;
    var input = document.getElementById("chatInput");
    if (input) input.value = "";
    var chips = document.getElementById("chips");
    if (chips) {
      chips.innerHTML = "";
      chips.dataset.hasSuggestions = "false";
    }
  }

  function humanMessageTime(value) {
    var date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function humanThreadNearBottom(log) {
    return !log || log.scrollHeight - log.clientHeight - log.scrollTop < 96;
  }

  function syncHumanJumpLatest(log) {
    var button = document.getElementById("amHumanCoachLatest");
    if (button) button.hidden = humanThreadNearBottom(log);
  }

  function scrollHumanThreadToLatest(options) {
    var log = document.getElementById("amHumanCoachThread");
    if (!log) return;
    options = options || {};
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof log.scrollTo === "function") {
      log.scrollTo({ top: log.scrollHeight, behavior: options.immediate || reduce ? "auto" : "smooth" });
    } else {
      log.scrollTop = log.scrollHeight;
    }
    _threadScroll.top = log.scrollHeight;
    _threadScroll.nearBottom = true;
    syncHumanJumpLatest(log);
  }

  function renderHumanThread(options) {
    var log = document.getElementById("amHumanCoachThread");
    if (!log) return;
    options = options || {};
    var hadContent = Boolean(log.children.length);
    var priorTop = hadContent ? log.scrollTop : _threadScroll.top;
    var wasNearBottom = options.forceLatest === true ||
      (hadContent ? humanThreadNearBottom(log) : _threadScroll.nearBottom);
    if (_threadLoading && !_thread) {
      log.innerHTML = '<div class="am-human-thread-loading" aria-label="Loading messages">' +
        '<i></i><i></i><i></i></div>';
      return;
    }
    var messages = _thread && Array.isArray(_thread.messages) ? _thread.messages : [];
    if (!messages.length) {
      log.innerHTML = '<div class="am-human-thread-empty"><strong>Message your coach</strong>' +
        '<p>Ask about your training, schedule, or anything your coach should know.</p></div>';
      return;
    }
    log.innerHTML = messages.map(function (message) {
      var athlete = message.sender_role === "athlete";
      return '<article class="am-human-message ' + (athlete ? "is-athlete" : "is-coach") + '">' +
        '<p>' + esc(message.body) + '</p>' +
        '<time datetime="' + esc(message.created_at || "") + '">' + esc(humanMessageTime(message.created_at)) + '</time>' +
      '</article>';
    }).join("");
    var nextCount = messages.length;
    requestAnimationFrame(function () {
      if (!log.isConnected) return;
      if (wasNearBottom) {
        scrollHumanThreadToLatest({
          immediate: options.forceLatest === true || _renderedThreadCount === 0 || nextCount === _renderedThreadCount
        });
      } else {
        log.scrollTop = priorTop;
        _threadScroll.top = priorTop;
        _threadScroll.nearBottom = false;
        syncHumanJumpLatest(log);
      }
      _renderedThreadCount = nextCount;
    });
  }

  async function athleteMessageRequest(method, message) {
    var t = await token();
    if (!t) throw new Error("auth");
    var options = { method: method, cache: "no-store", headers: { Authorization: "Bearer " + t } };
    if (method === "POST") {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify({ message: message });
    }
    var response = await fetch("/api/providers?action=athlete_messages", options);
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(data.error || "Messages are unavailable right now.");
      error.status = response.status;
      throw error;
    }
    return data.thread || { messages: [], can_send: true };
  }

  async function loadHumanMessages() {
    if (_mode !== "human_coached" || _threadLoading) return;
    var requestGeneration = _requestGeneration;
    _threadLoading = true;
    renderHumanThread();
    try {
      var nextThread = await athleteMessageRequest("GET");
      if (requestGeneration !== _requestGeneration || _mode !== "human_coached") return;
      _thread = nextThread;
    } catch (error) {
      var log = document.getElementById("amHumanCoachThread");
      if (log) log.innerHTML = '<p class="am-human-thread-state">Messages are unavailable right now. Try again.</p>';
      if (error && error.status === 403) await revalidateMode();
      return;
    } finally {
      if (requestGeneration === _requestGeneration) _threadLoading = false;
    }
    if (requestGeneration === _requestGeneration && _mode === "human_coached") renderHumanThread();
  }

  async function sendHumanMessage(message) {
    var clean = String(message || "").trim();
    if (_mode !== "human_coached" || !clean || _sendInFlight) return;
    var input = document.getElementById("amHumanCoachInput");
    var button = document.getElementById("amHumanCoachSend");
    var status = document.getElementById("amHumanCoachStatus");
    var requestGeneration = _requestGeneration;
    _sendInFlight = true;
    if (button) button.disabled = true;
    if (status) status.textContent = "Sending…";
    try {
      var nextThread = await athleteMessageRequest("POST", clean);
      if (requestGeneration !== _requestGeneration || _mode !== "human_coached") return;
      _thread = nextThread;
      if (input) {
        input.value = "";
        input.style.height = "";
      }
      if (status) status.textContent = "";
      renderHumanThread({ forceLatest: true });
    } catch (error) {
      if (status) status.textContent = error && error.message ? error.message : "The message could not be sent.";
      if (error && error.status === 403) await revalidateMode();
    } finally {
      if (requestGeneration === _requestGeneration) {
        _sendInFlight = false;
        if (button) button.disabled = !input || !input.value.trim();
      }
    }
  }

  function syncHumanSendState() {
    var input = document.getElementById("amHumanCoachInput");
    var button = document.getElementById("amHumanCoachSend");
    if (button) button.disabled = _sendInFlight || !input || !input.value.trim();
  }

  function renderCoachTab() {
    if (_mode === "unknown") {
      renderUnknownCoachTab();
      return;
    }
    if (_mode === "self_guided") {
      restoreSelfGuidedCoachTab();
      return;
    }
    var screen = coachScreen();
    if (!screen) return;
    setAiCoachVisible(false);
    removeCoachModeMounts();

    var coachName = (_coach && _coach.display_name) ? esc(_coach.display_name) : "Your Coach";
    var initials = (_coach && _coach.initials) ? esc(_coach.initials) : "C";
    var title = (_coach && _coach.coaching_title) ? esc(_coach.coaching_title) : "Coach";
    var mount = document.createElement("div");
    mount.className = "am-coach-mode-mount am-human-coach";
    mount.innerHTML =
      '<header class="am-human-coach-head">' +
        '<span class="am-human-coach-avatar" aria-hidden="true">' + initials + '</span>' +
        '<span><strong>' + coachName + '</strong><small>' + title + '</small></span>' +
      '</header>' +
      '<div class="am-human-coach-thread" id="amHumanCoachThread" aria-label="Conversation with ' + coachName + '"></div>' +
      '<button class="am-human-coach-latest" id="amHumanCoachLatest" type="button" hidden>Jump to latest</button>' +
      '<form class="am-human-coach-composer" id="amHumanCoachComposer">' +
        '<label class="sr-only" for="amHumanCoachInput">Message ' + coachName + '</label>' +
        '<textarea id="amHumanCoachInput" maxlength="4000" rows="1" placeholder="Message your coach"></textarea>' +
        '<button type="submit" id="amHumanCoachSend" disabled>Send</button>' +
        '<p class="am-human-coach-status" id="amHumanCoachStatus" aria-live="polite"></p>' +
      '</form>';
    screen.appendChild(mount);
    markCoachSurfaceReady(mount);
    var form = document.getElementById("amHumanCoachComposer");
    if (form) form.addEventListener("submit", function (event) {
      event.preventDefault();
      var input = document.getElementById("amHumanCoachInput");
      sendHumanMessage(input ? input.value : "");
    });
    var input = document.getElementById("amHumanCoachInput");
    if (input) input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(120, input.scrollHeight) + "px";
      syncHumanSendState();
    });
    var log = document.getElementById("amHumanCoachThread");
    if (log) log.addEventListener("scroll", function () {
      _threadScroll.top = log.scrollTop;
      _threadScroll.nearBottom = humanThreadNearBottom(log);
      syncHumanJumpLatest(log);
    }, { passive: true });
    var latest = document.getElementById("amHumanCoachLatest");
    if (latest) latest.addEventListener("click", function () {
      scrollHumanThreadToLatest({ immediate: false });
    });
    renderHumanThread();
  }

  // ─── Train: read-only state + request adjustment ─────────────────────
  // For coach-owned workouts, disables edit controls and adds a
  // "Request Adjustment" action.
  // When unknown, does NOT enable any editing (suppressAIControls handles that).
  function applyTrainPermissions() {
    if (_mode !== "human_coached") return;
    track("coach_managed_plan_viewed", {});

    var cards = document.querySelectorAll("[data-session-id]");
    cards.forEach(function (card) {
      var ownerType = card.getAttribute("data-owner-type") || card.getAttribute("data-source") || "";
      if (ownerType !== "human_coach" && ownerType !== "coach") return;

      // Mark read-only (disable edit buttons)
      var editBtns = card.querySelectorAll("[data-action='edit'], [data-action='modify'], [data-action='skip']");
      editBtns.forEach(function (btn) {
        if (!btn.disabled) btn.setAttribute("data-am-managed-disabled", "true");
        btn.disabled = true;
        btn.style.opacity = "0.4";
        btn.title = "This workout is managed by your coach";
      });

      // Add Request Adjustment button if not already present
      if (card.querySelector(".am-request-adjustment")) return;
      var btn = document.createElement("button");
      btn.className = "am-request-adjustment";
      btn.textContent = "Request Adjustment";
      btn.style.cssText = "min-height:var(--control-height);margin-top:var(--s-2);padding:8px 16px;font-size:var(--fs-body-sm);border:1px solid var(--border-default);" +
        "color:var(--athlevo-red);background:var(--surface-base);border-radius:var(--r-pill);cursor:pointer;";
      btn.addEventListener("click", function () {
        var sessionDate = card.getAttribute("data-session-date") || card.getAttribute("data-date") || null;
        requestAdjustment({ session_date: sessionDate, request_type: "adjustment" });
      });
      card.appendChild(btn);
    });
  }

  // ─── Request Adjustment ──────────────────────────────────────────────
  async function requestAdjustment(opts) {
    opts = opts || {};
    try {
      var t = await token();
      if (!t) return { ok: false, error: "Not authenticated" };
      var resp = await fetch("/api/providers?action=athlete_request_adjustment", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + t,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          session_date: opts.session_date || null,
          request_type: opts.request_type || "adjustment",
          payload: opts.payload || null
        })
      });
      var data = await resp.json();
      if (resp.ok && data.requested) {
        track("coach_adjustment_requested", { request_type: opts.request_type || "adjustment" });
        if (typeof toast === "function") toast("Your request has been sent to your coach.");
        return { ok: true };
      }
      if (typeof toast === "function") toast(data.error || "Could not send your request.");
      return { ok: false, error: data.error };
    } catch (e) {
      if (typeof toast === "function") toast("Could not send your request. Please try again.");
      return { ok: false, error: "network" };
    }
  }

  // The Coach tab already establishes the human relationship. Keep You free
  // of a duplicate assigned-coach card, including remnants from older builds.
  function renderAssignedCoach() {
    document.querySelectorAll(".am-assigned-coach").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function setManagedAdviceHidden(hidden) {
    var memory = document.getElementById("coachMemorySection");
    if (memory) memory.hidden = hidden;
    if (window.AthlevoDailyBrief && typeof window.AthlevoDailyBrief.setManaged === "function") {
      window.AthlevoDailyBrief.setManaged(hidden);
    } else {
      var brief = document.getElementById("dailyBriefFull");
      var note = document.getElementById("todayCoachNoteSection");
      if (brief) brief.hidden = hidden;
      if (note) note.hidden = hidden;
    }
  }

  function applyModeUi() {
    renderAssignedCoach();
    renderCoachTab();
    if (window.AthlevoWeather && typeof window.AthlevoWeather.render === "function") {
      window.AthlevoWeather.render();
    }
    if (_mode === "unknown") {
      suppressAIControls();
      setManagedAdviceHidden(true);
      showUnknownNotice();
      return;
    }
    hideUnknownNotice();
    restoreSuppressedControls();
    if (_mode === "self_guided") {
      setManagedAdviceHidden(false);
      return;
    }
    setManagedAdviceHidden(true);
    applyTodayLabels();
    applyTrainPermissions();
  }

  async function revalidateMode() {
    var previousMode = _mode;
    _mode = "unknown";
    _coach = null;
    _transition = null;
    _confirmed = false;
    _thread = null;
    _lastError = null;
    renderAssignedCoach();
    renderCoachTab();
    suppressAIControls();
    setManagedAdviceHidden(true);
    hideUnknownNotice();
    await fetchMode(true);
    applyModeUi();
    if (
      previousMode === "human_coached" &&
      _mode === "self_guided" &&
      window.AthlevoDailyBrief &&
      typeof window.AthlevoDailyBrief.load === "function"
    ) {
      window.AthlevoDailyBrief.load().catch(function () {});
    }
    return _mode;
  }

  async function onCoachTabEnter() {
    var stale = !_cacheKey || (Date.now() - _cacheKey) > MODE_STALE_MS;
    if (_mode === "unknown" || stale) await revalidateMode();
    else applyModeUi();
    if (_mode === "human_coached") {
      track("managed_coach_tab_viewed", {});
      await loadHumanMessages();
    }
    return _mode;
  }

  // ─── Retry: re-fetch mode and apply the result ───────────────────────
  async function retry() {
    return revalidateMode();
  }

  // ─── init(): single call from authenticated boot ─────────────────────
  async function init() {
    // Paint a neutral Coach surface synchronously so hidden app-shell AI
    // content never flashes while the assignment lookup is in flight.
    renderAssignedCoach();
    renderCoachTab();
    suppressAIControls();
    setManagedAdviceHidden(true);
    hideUnknownNotice();
    await fetchMode();
    applyModeUi();
    return _mode;
  }

  function clearOnLogout() {
    _requestGeneration += 1;
    _mode = "unknown";
    _coach = null;
    _transition = null;
    _ambiguous = false;
    _confirmed = false;
    _fetching = false;
    _fetchPromise = null;
    _cacheKey = null;
    _lastError = null;
    _thread = null;
    _threadLoading = false;
    _sendInFlight = false;
    hideUnknownNotice();
    restoreSuppressedControls();
    document.querySelectorAll(".am-authorship-label, .am-request-adjustment, .am-assigned-coach").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll("[data-am-managed-disabled='true']").forEach(function (el) {
      el.disabled = false;
      el.style.opacity = "";
      el.title = "";
      el.removeAttribute("data-am-managed-disabled");
    });
    restoreSelfGuidedCoachTab();
    clearAiCoachDom();
    setManagedAdviceHidden(false);
    if (window.AthlevoWeather && typeof window.AthlevoWeather.clear === "function") {
      window.AthlevoWeather.clear();
    }
  }

  // ─── Expose ──────────────────────────────────────────────────────────
  window.AthlevoAthleteMode = {
    init: init,
    fetchMode: fetchMode,
    retry: retry,
    mode: mode,
    isManaged: isManaged,
    isUnknown: isUnknown,
    isConfirmed: isConfirmed,
    coach: coach,
    transition: transition,
    lastError: lastError,
    authorshipLabel: authorshipLabel,
    applyTodayLabels: applyTodayLabels,
    renderCoachTab: renderCoachTab,
    onCoachTabEnter: onCoachTabEnter,
    loadHumanMessages: loadHumanMessages,
    sendHumanMessage: sendHumanMessage,
    applyTrainPermissions: applyTrainPermissions,
    renderAssignedCoach: renderAssignedCoach,
    requestAdjustment: requestAdjustment,
    clearOnLogout: clearOnLogout,
    // Testing / diagnostics only — not part of the athlete UX contract.
    _test: {
      suppressAIControls: suppressAIControls,
      restoreSuppressedControls: restoreSuppressedControls,
      showUnknownNotice: showUnknownNotice,
      hideUnknownNotice: hideUnknownNotice
    }
  };

})();
