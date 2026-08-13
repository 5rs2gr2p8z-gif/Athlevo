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
  var _cacheKey = null;
  var _lastError = null;  // categorical error reason (never raw message)

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
  async function fetchMode(force) {
    if (_fetching) return;
    if (_confirmed && !force) return;
    _fetching = true;
    _lastError = null;
    try {
      var t = await token();
      if (!t) {
        // No token: cannot verify. Stay unknown.
        _mode = "unknown";
        _confirmed = false;
        _lastError = "no_token";
        _fetching = false;
        return;
      }
      var resp = await fetch("/api/providers?action=athlete_coaching_mode", {
        headers: { Authorization: "Bearer " + t }
      });
      if (!resp.ok) {
        // Server rejected: 401/403/500/503/etc. Stay unknown.
        _mode = "unknown";
        _confirmed = false;
        _lastError = resp.status === 401 || resp.status === 403 ? "auth_failed" : "server_error";
        _fetching = false;
        return;
      }
      var data = await resp.json();
      var serverMode = data.coaching_mode;
      if (serverMode !== "self_guided" && serverMode !== "human_coached") {
        // Unrecognized mode value: do not trust. Stay unknown.
        _mode = "unknown";
        _confirmed = false;
        _lastError = "unrecognized_mode";
        _fetching = false;
        return;
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
    } catch (e) {
      // Network failure, JSON parse error, etc. Stay unknown.
      _mode = "unknown";
      _confirmed = false;
      _coach = null;
      _transition = null;
      _lastError = "network";
    }
    _fetching = false;
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
        el.disabled = true;
        el.style.opacity = "0.35";
        el.title = "Coaching setup could not be verified";
        el.setAttribute("data-am-suppressed", "true");
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

  // ─── Coach tab: human-coach shell ────────────────────────────────────
  // When managed, replaces the Coach tab (AI chat) with a human-coach info
  // panel. The AI must NEVER impersonate the human coach.
  // When unknown, does NOT render coach identity (unverified).
  function renderCoachTab() {
    if (_mode !== "human_coached") return;
    var screen = document.getElementById("screen-coach");
    if (!screen) return;
    track("managed_coach_tab_viewed", {});

    var coachName = (_coach && _coach.display_name) ? esc(_coach.display_name) : "Your Coach";
    var initials = (_coach && _coach.initials) ? esc(_coach.initials) : "C";
    var title = (_coach && _coach.coaching_title) ? esc(_coach.coaching_title) : "Coach";
    var since = (_coach && _coach.assignment_start_date)
      ? "Since " + esc(new Date(_coach.assignment_start_date).toLocaleDateString())
      : "";

    var transitionHtml = "";
    if (_transition && _transition.state && _transition.state !== "resolved") {
      transitionHtml = '<div style="margin-top:var(--s-4);padding:var(--s-3);background:var(--warning-soft);border-radius:var(--ui-radius-control);font-size:var(--fs-body-sm);color:var(--warning);">' +
        'Your coach is setting up your training plan. You\'ll see your new sessions here once they\'re ready.' +
        '</div>';
    }

    screen.innerHTML =
      '<div style="padding:24px;text-align:center;">' +
        '<div style="width:64px;height:64px;border-radius:50%;background:var(--athlevo-red);color:#fff;' +
          'display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;">' +
          initials +
        '</div>' +
        '<h2 style="margin:12px 0 4px;font-size:20px;font-weight:600;">' + coachName + '</h2>' +
        '<p style="color:var(--text-muted);font-size:var(--fs-body-sm);margin:0;">' + title + (since ? ' · ' + since : '') + '</p>' +
        transitionHtml +
        '<div style="margin-top:var(--s-6);padding:var(--s-4);background:var(--surface-soft);border-radius:var(--ui-radius-card);text-align:left;">' +
          '<p style="font-size:var(--fs-body-sm);color:var(--text-secondary);margin:0;">' +
            coachName + ' manages your training plan. ' +
            'Check <strong>Train</strong> for your prescribed sessions, ' +
            'and use <strong>Request Adjustment</strong> if you need a change.' +
          '</p>' +
        '</div>' +
      '</div>';
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

  // ─── You: Assigned Coach section ─────────────────────────────────────
  // Only rendered when human_coached is CONFIRMED. Never for unknown.
  function renderAssignedCoach() {
    if (_mode !== "human_coached" || !_coach) return;
    track("assigned_coach_viewed", {});

    // Find the You screen and inject at top of content
    var youScreen = document.getElementById("screen-you") || document.getElementById("screen-profile");
    if (!youScreen) return;
    if (youScreen.querySelector(".am-assigned-coach")) return; // already rendered

    var coachName = esc(_coach.display_name || "Your Coach");
    var initials = esc(_coach.initials || "C");
    var title = esc(_coach.coaching_title || "Coach");

    var section = document.createElement("div");
    section.className = "am-assigned-coach";
    section.style.cssText = "margin:var(--s-4);padding:var(--s-4);background:var(--surface-soft);border:1px solid var(--border-default);border-radius:var(--ui-radius-card);display:flex;align-items:center;gap:var(--s-3);";
    section.innerHTML =
      '<div style="width:44px;height:44px;border-radius:50%;background:var(--athlevo-red);color:#fff;' +
        'display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;flex-shrink:0;">' +
        initials +
      '</div>' +
      '<div>' +
        '<div style="font-weight:600;font-size:15px;">' + coachName + '</div>' +
        '<div style="font-size:var(--fs-body-sm);color:var(--text-muted);">' + title + '</div>' +
      '</div>';

    // Insert at the top of the content area
    var firstChild = youScreen.querySelector(".you-content, .profile-content");
    if (firstChild) {
      firstChild.insertBefore(section, firstChild.firstChild);
    } else {
      youScreen.insertBefore(section, youScreen.firstChild);
    }
  }

  // ─── Retry: re-fetch mode and apply the result ───────────────────────
  async function retry() {
    await fetchMode(true);
    if (_confirmed) {
      hideUnknownNotice();
      restoreSuppressedControls();
      if (_mode === "human_coached") {
        applyTodayLabels();
        renderCoachTab();
        applyTrainPermissions();
        renderAssignedCoach();
      }
      // self_guided confirmed: controls are restored, no further action needed.
    }
    // Still unknown after retry: notice stays, controls stay suppressed.
  }

  // ─── init(): single call from authenticated boot ─────────────────────
  async function init() {
    await fetchMode();

    if (_mode === "unknown") {
      // Verification failed. Suppress conflicting controls and show notice.
      suppressAIControls();
      showUnknownNotice();
      return;
    }

    if (_mode === "self_guided") {
      // Confirmed self-guided: no-op, everything works as today.
      return;
    }

    // Confirmed human-coached: apply all managed UI.
    applyTodayLabels();
    renderCoachTab();
    applyTrainPermissions();
    renderAssignedCoach();
  }

  function clearOnLogout() {
    _mode = "unknown";
    _coach = null;
    _transition = null;
    _ambiguous = false;
    _confirmed = false;
    _fetching = false;
    _cacheKey = null;
    _lastError = null;
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
