/*
 * Athlevo Morning Check-In
 *
 * Coordinates the existing daily readiness form on the first meaningful
 * authenticated Today open of each Asia/Manila day. Completion remains
 * authoritative in daily_readiness; localStorage stores only temporary UI
 * suppression and analytics deduplication, keyed by user and local date.
 */
(function (root) {
  "use strict";

  const DISMISS_DELAY_MS = 3 * 60 * 60 * 1000;
  const DISMISS_PREFIX = "athlevo:readiness-dismissed:";
  const SHOWN_PREFIX = "athlevo:readiness-prompt-shown:";
  const openedThisSession = new Set();
  const completedThisSession = new Set();
  let evaluationInFlight = null;

  function scopedKey(userId, dayKey) {
    return `${String(userId || "")}:${String(dayKey || "")}`;
  }

  function storageKey(prefix, userId, dayKey) {
    return prefix + scopedKey(userId, dayKey);
  }

  function readDismissal(userId, dayKey) {
    try {
      const raw = localStorage.getItem(
        storageKey(DISMISS_PREFIX, userId, dayKey)
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Number.isFinite(Number(parsed.dismissedAt))
        ? Number(parsed.dismissedAt)
        : null;
    } catch (error) {
      return null;
    }
  }

  function isDismissalActive(userId, dayKey, nowMs = Date.now()) {
    const dismissedAt = readDismissal(userId, dayKey);
    return dismissedAt !== null &&
      nowMs >= dismissedAt &&
      nowMs - dismissedAt < DISMISS_DELAY_MS;
  }

  function track(name) {
    try {
      if (root.AthlevoProductAnalytics) {
        root.AthlevoProductAnalytics.trackAthlevoEvent(name, {
          source: "morning_prompt"
        });
      }
    } catch (error) {}
  }

  function trackShownOnce(userId, dayKey) {
    const key = storageKey(SHOWN_PREFIX, userId, dayKey);
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch (error) {
      /* Page-session analytics deduplication still applies. */
    }
    track("readiness_prompt_shown");
  }

  function dismiss(userId, dayKey, nowMs = Date.now()) {
    try {
      localStorage.setItem(
        storageKey(DISMISS_PREFIX, userId, dayKey),
        JSON.stringify({ dismissedAt: nowMs })
      );
    } catch (error) {
      /* Session-level suppression still prevents repeated reopening. */
    }
    track("readiness_prompt_dismissed");
  }

  function markCompleted(userId, dayKey) {
    const key = scopedKey(userId, dayKey);
    completedThisSession.add(key);
    openedThisSession.add(key);
    try {
      localStorage.removeItem(
        storageKey(DISMISS_PREFIX, userId, dayKey)
      );
    } catch (error) {}
  }

  function activeScreen(id) {
    const element = document.getElementById(id);
    return Boolean(element && element.classList.contains("active"));
  }

  /*
   * Coach Dashboard and Athlete Detail deliberately reuse #screen-today.
   * Screen visibility alone therefore cannot prove that the signed-in user
   * is operating in their own athlete workspace. AthlevoCoachMode resolves
   * role and workspace from the server-authorized roster response; suppress
   * the athlete prompt until that resolution is complete, and throughout
   * Coach Workspace for both coaches and admins.
   */
  function athleteWorkspaceActive() {
    const coachMode = root.AthlevoCoachMode;
    if (!coachMode || typeof coachMode.getMode !== "function") return true;

    const mode = coachMode.getMode();
    if (mode === "athlete_mode") return true;
    if (mode !== "coach_mode") return false;

    return Boolean(
      typeof coachMode.isAthleteWorkspace === "function" &&
      coachMode.isAthleteWorkspace()
    );
  }

  function authCallbackActive() {
    if (
      root.athlevoFinalizeInFlight ||
      root.__athlevoFinalizePending ||
      root.__athlevoOAuthReturn?.state
    ) {
      return true;
    }
    try {
      const params = new URLSearchParams(root.location.search || "");
      return ["code", "state", "completion", "intervals"].some(name =>
        params.has(name)
      );
    } catch (error) {
      return false;
    }
  }

  function onboardingActive() {
    if (activeScreen("screen-onboard") || activeScreen("screen-connect")) {
      return true;
    }
    try {
      return Boolean(
        root.AthlevoConnect &&
        typeof root.AthlevoConnect.isActive === "function" &&
        root.AthlevoConnect.isActive()
      );
    } catch (error) {
      return false;
    }
  }

  function elementIsOpen(element) {
    if (!element) return false;
    if (element.classList?.contains("show")) return true;
    return element.style?.display === "flex" ||
      element.getAttribute?.("aria-hidden") === "false";
  }

  function blockingModalOpen() {
    const readiness = document.getElementById("readinessModal");
    const modalBacks = Array.from(
      document.querySelectorAll(".modal-back.show")
    ).filter(element => element !== readiness);
    if (modalBacks.length) return true;

    const selectors = [
      "#trainWorkoutModal",
      "#adaptivePlanModal",
      "#authModal",
      "#pwaModal",
      ".ag-overlay"
    ];
    return selectors.some(selector =>
      elementIsOpen(document.querySelector(selector))
    );
  }

  function appReady(options) {
    if (!athleteWorkspaceActive() || !activeScreen("screen-today")) {
      return false;
    }
    if (
      document.visibilityState === "hidden" ||
      onboardingActive() ||
      authCallbackActive() ||
      blockingModalOpen()
    ) {
      return false;
    }
    if (
      options?.allowDuringBoot !== true &&
      document.body?.classList?.contains("booting")
    ) {
      return false;
    }
    return true;
  }

  function firstName(user) {
    const node = document.getElementById("todayAthleteName");
    const visible = node ? String(node.textContent || "").trim() : "";
    if (visible && visible.toLowerCase() !== "athlete") {
      return visible.split(/\s+/)[0];
    }
    const metadata = user?.user_metadata || {};
    const candidate = String(
      metadata.first_name || metadata.full_name || metadata.name || ""
    ).trim();
    return candidate ? candidate.split(/\s+/)[0] : "Athlete";
  }

  async function evaluate(options = {}) {
    if (!appReady(options)) {
      return { shown: false, reason: "app_not_ready" };
    }
    if (
      typeof root.readinessTodayKey !== "function" ||
      typeof root.verifyTodayReadiness !== "function" ||
      typeof root.openReadinessCheck !== "function"
    ) {
      return { shown: false, reason: "readiness_not_ready" };
    }
    if (evaluationInFlight) return evaluationInFlight;

    const now = options.now instanceof Date ? options.now : new Date();
    const nowMs = Number.isFinite(Number(options.nowMs))
      ? Number(options.nowMs)
      : now.getTime();
    const dayKey = root.readinessTodayKey(now);

    evaluationInFlight = (async function () {
      const status = await root.verifyTodayReadiness(dayKey);
      if (!status?.verified || !status.user?.id) {
        return { shown: false, reason: status?.reason || "not_verified" };
      }

      const key = scopedKey(status.user.id, dayKey);
      if (completedThisSession.has(key) || status.record) {
        completedThisSession.add(key);
        return { shown: false, reason: "completed" };
      }
      if (openedThisSession.has(key)) {
        return { shown: false, reason: "already_opened_this_session" };
      }
      if (isDismissalActive(status.user.id, dayKey, nowMs)) {
        return { shown: false, reason: "temporarily_dismissed" };
      }

      // State may have changed while the authenticated query was in flight.
      if (!appReady(options)) {
        return { shown: false, reason: "app_not_ready" };
      }

      openedThisSession.add(key);
      const opened = root.openReadinessCheck({
        automatic: true,
        source: "morning_prompt",
        firstName: firstName(status.user),
        onDismiss: function () {
          dismiss(status.user.id, dayKey, Date.now());
        }
      });

      if (!opened) {
        openedThisSession.delete(key);
        return { shown: false, reason: "modal_unavailable" };
      }

      trackShownOnce(status.user.id, dayKey);
      return { shown: true, reason: "incomplete", dayKey };
    })();

    try {
      return await evaluationInFlight;
    } finally {
      evaluationInFlight = null;
    }
  }

  function evaluateOnResume(reason) {
    evaluate({ reason }).catch(function () {});
  }

  function clearOnLogout() {
    openedThisSession.clear();
    completedThisSession.clear();
    evaluationInFlight = null;
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      evaluateOnResume("app-resume");
    }
  });
  root.addEventListener("pageshow", function () {
    evaluateOnResume("pageshow");
  });

  root.AthlevoMorningCheckIn = {
    evaluate,
    dismiss,
    markCompleted,
    clearOnLogout,
    isDismissalActive,
    DISMISS_DELAY_MS,
    _test: {
      appReady,
      athleteWorkspaceActive,
      authCallbackActive,
      blockingModalOpen,
      firstName,
      scopedKey,
      storageKey,
      openedThisSession,
      completedThisSession
    }
  };
})(window);
