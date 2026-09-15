/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Local Training Reminders (Phase 1)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Scope, deliberately narrow:
 *    · Native (Android/iOS) on-device local scheduling only. No server
 *      push, no device tokens, no FCM/APNs, no cron — those are Phase 2.
 *    · Two notification types: workout reminder, recovery/rest reminder.
 *    · Preferences live in one row per athlete in
 *      public.notification_preferences (see migrations/
 *      2026-09-15_notification_preferences.sql).
 *
 *  Design points that matter:
 *    · Deterministic notification IDs (YYYYMMDD of the TRAINING day, not
 *      the fire day) so rescheduling the same date can never duplicate —
 *      scheduling with that ID again simply replaces the pending one.
 *    · Every pending Athlevo notification ID falls inside ID_MIN..ID_MAX,
 *      so "cancel everything Athlevo scheduled" can never touch a
 *      notification some other feature might one day schedule.
 *    · Every public method is wrapped so a failure here can NEVER block
 *      onboarding, plan generation, Calendar, Coach, login, or app
 *      startup — notifications are an enhancement, not a dependency.
 *    · Nothing here ever prompts for OS permission on its own; only
 *      requestPermissionAndEnable() does, and only ever in response to an
 *      explicit user tap (the soft-ask, or a Settings toggle).
 */
(function (root) {
  "use strict";

  const PREF_TABLE = "notification_preferences";
  const SESSIONS_TABLE = "training_sessions";
  const CHANNEL_ID = "athlevo_training";
  const DEFAULT_REMINDER_TIME = "19:00"; // 7:00 PM, the day before
  const SCHEDULE_WINDOW_DAYS = 7;
  const ID_MIN = 20200101;
  const ID_MAX = 20301231;
  const REST_TYPES = new Set(["rest", "rest_day", "restday", "off", "day_off"]);

  let supabaseClientRef = null;
  let currentUserId = null;
  let prefsCache = null;
  let tapListenerInstalled = false;

  /* ── environment ─────────────────────────────────────────────────── */

  function isNative() {
    try {
      return !!(root.AthlevoRuntime && root.AthlevoRuntime.isNative && root.AthlevoRuntime.isNative());
    } catch (e) { return false; }
  }

  function platformName() {
    try {
      if (root.AthlevoRuntime && typeof root.AthlevoRuntime.nativePlatform === "function") {
        return root.AthlevoRuntime.nativePlatform();
      }
    } catch (e) {}
    return "web";
  }

  function LN() {
    try {
      const cap = root.Capacitor;
      return (cap && cap.Plugins && cap.Plugins.LocalNotifications) || null;
    } catch (e) { return null; }
  }

  // The one gate every scheduling/permission path must pass. Web/PWA never
  // gets fake scheduled notifications — Phase 2 covers web via server push.
  function supported() {
    return isNative() && !!LN();
  }

  function track(name, props) {
    try { if (root.AthlevoAnalytics) root.AthlevoAnalytics.track(name, props || {}); } catch (e) {}
    try {
      if (root.AthlevoProductAnalytics && typeof root.AthlevoProductAnalytics.trackAthlevoEvent === "function") {
        root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
      }
    } catch (e) {}
  }

  function safeWarn(context, error) {
    try { console.warn("Athlevo notifications: " + context, error); } catch (e) {}
  }

  /* ── date helpers (local civil date, no UTC drift) ──────────────────── */

  function pad2(n) { return String(n).padStart(2, "0"); }
  function localISO(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function dateIntId(iso) { return Number(String(iso).replace(/-/g, "")); }

  function parseHHMM(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
    if (!m) return { h: 19, m: 0 };
    return { h: Math.min(23, Math.max(0, Number(m[1]))), m: Math.min(59, Math.max(0, Number(m[2]))) };
  }

  // Reminder for `sessionDateISO` fires the evening BEFORE, at reminderTime.
  function fireDateFor(sessionDateISO, reminderTime) {
    const [y, mo, d] = String(sessionDateISO).split("-").map(Number);
    const t = parseHHMM(reminderTime);
    const fire = new Date(y, mo - 1, d - 1, t.h, t.m, 0, 0);
    return fire;
  }

  function resolveTimezone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) return tz;
    } catch (e) {}
    return "Asia/Manila";
  }

  /* ── preferences ─────────────────────────────────────────────────── */

  function defaultPrefs() {
    return {
      user_id: currentUserId,
      notifications_enabled: false,
      workout_reminders_enabled: true,
      recovery_reminders_enabled: true,
      reminder_time_local: DEFAULT_REMINDER_TIME,
      timezone: resolveTimezone()
    };
  }

  function getPreferences() {
    return prefsCache || defaultPrefs();
  }

  async function loadPreferences() {
    if (!supabaseClientRef || !currentUserId) { prefsCache = null; return null; }
    try {
      const { data, error } = await supabaseClientRef
        .from(PREF_TABLE)
        .select("*")
        .eq("user_id", currentUserId)
        .maybeSingle();
      if (error) throw error;
      prefsCache = data || null;
      return prefsCache;
    } catch (e) {
      safeWarn("loadPreferences failed", e);
      prefsCache = prefsCache || null;
      return prefsCache;
    }
  }

  async function savePreferences(patch) {
    if (!currentUserId) return getPreferences();
    const next = Object.assign({}, getPreferences(), patch, {
      user_id: currentUserId,
      timezone: resolveTimezone()
    });
    prefsCache = next;
    if (supabaseClientRef) {
      try {
        await supabaseClientRef.from(PREF_TABLE).upsert(next, { onConflict: "user_id" });
      } catch (e) {
        safeWarn("savePreferences failed (kept local cache)", e);
      }
    }
    return next;
  }

  /* ── channel (Android) ──────────────────────────────────────────── */

  async function ensureChannel() {
    const ln = LN();
    if (!ln || typeof ln.createChannel !== "function" || platformName() !== "android") return;
    try {
      // importance 3 = Android's IMPORTANCE_DEFAULT — a calm channel with
      // no sound override and no heads-up/alarm-level behavior, matching
      // the "workout reminder, not an alarm" tone this feature needs.
      await ln.createChannel({
        id: CHANNEL_ID,
        name: "Athlevo Training",
        description: "Workout and recovery-day reminders",
        importance: 3,
        visibility: 1
      });
    } catch (e) { safeWarn("createChannel failed", e); }
  }

  /* ── soft-ask + permission ──────────────────────────────────────── */

  function softPromptKey() { return "athlevo_notif_soft_prompt_seen_" + (currentUserId || "anon"); }

  function hasSeenSoftPrompt() {
    try { return root.localStorage.getItem(softPromptKey()) === "1"; } catch (e) { return false; }
  }
  function markSoftPromptSeen() {
    try { root.localStorage.setItem(softPromptKey(), "1"); } catch (e) {}
  }

  // Called after the athlete's first plan is generated. Never fires on web,
  // never fires twice, never fires if the OS has already recorded a
  // decision (granted/denied) for this app.
  async function maybeShowSoftPrompt(source) {
    try {
      if (!supported()) return false;
      if (!currentUserId) return false;
      if (hasSeenSoftPrompt()) return false;
      if (getPreferences().notifications_enabled) return false;

      let perm = null;
      try { perm = await LN().checkPermissions(); } catch (e) {}
      if (perm && perm.display && perm.display !== "prompt") {
        // OS already has a decision on file (e.g. reinstalled app); don't
        // re-surface our own soft-ask on top of that.
        markSoftPromptSeen();
        return false;
      }

      markSoftPromptSeen();
      track("notification_soft_prompt_viewed", {
        notification_type: "soft_prompt", platform: platformName(), trigger: source || "first_plan_generated"
      });

      if (typeof root.showAthlevoNotificationSoftPrompt === "function") {
        root.showAthlevoNotificationSoftPrompt();
        return true;
      }
      return false;
    } catch (e) { safeWarn("maybeShowSoftPrompt failed", e); return false; }
  }

  // The ONLY path that ever calls the native permission dialog. Always a
  // direct result of a user tap (soft-ask "Enable reminders", or the
  // Settings master toggle) — never called on launch or automatically.
  async function requestPermissionAndEnable(source) {
    try {
      if (!supported()) return { granted: false, reason: "unsupported" };
      track("notification_permission_requested", {
        notification_type: "master", platform: platformName(), trigger: source || "soft_prompt"
      });

      let result = null;
      try { result = await LN().requestPermissions(); } catch (e) { safeWarn("requestPermissions failed", e); }
      const granted = !!(result && result.display === "granted");

      track(granted ? "notification_permission_granted" : "notification_permission_denied", {
        notification_type: "master", platform: platformName(), trigger: source || "soft_prompt"
      });

      await savePreferences({ notifications_enabled: granted });

      if (granted) {
        await ensureChannel();
        await rescheduleFromPlan();
      }
      return { granted };
    } catch (e) {
      safeWarn("requestPermissionAndEnable failed", e);
      return { granted: false, reason: "error" };
    }
  }

  /* ── settings actions ────────────────────────────────────────────── */

  async function setMasterEnabled(enabled) {
    try {
      if (enabled) {
        track("notification_setting_changed", { notification_type: "master", platform: platformName(), trigger: "settings" });
        return await requestPermissionAndEnable("settings");
      }
      track("notification_setting_changed", { notification_type: "master", platform: platformName(), trigger: "settings" });
      await savePreferences({ notifications_enabled: false });
      await cancelAll("settings_disabled");
      return { granted: false };
    } catch (e) { safeWarn("setMasterEnabled failed", e); return { granted: false }; }
  }

  async function setCategoryEnabled(category, enabled) {
    try {
      const patch = {};
      if (category === "workout") patch.workout_reminders_enabled = !!enabled;
      else if (category === "recovery") patch.recovery_reminders_enabled = !!enabled;
      else return getPreferences();
      const next = await savePreferences(patch);
      track("notification_setting_changed", { notification_type: category, platform: platformName(), trigger: "settings" });
      await rescheduleFromPlan();
      return next;
    } catch (e) { safeWarn("setCategoryEnabled failed", e); return getPreferences(); }
  }

  async function setReminderTime(hhmm) {
    try {
      const clean = parseHHMM(hhmm);
      const value = pad2(clean.h) + ":" + pad2(clean.m);
      const next = await savePreferences({ reminder_time_local: value });
      track("notification_setting_changed", { notification_type: "reminder_time", platform: platformName(), trigger: "settings" });
      await rescheduleFromPlan();
      return next;
    } catch (e) { safeWarn("setReminderTime failed", e); return getPreferences(); }
  }

  /* ── canonical plan data ─────────────────────────────────────────── */

  function classify(sessionType) {
    const t = String(sessionType || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (!t) return null;
    if (REST_TYPES.has(t)) return "recovery";
    return "workout";
  }

  async function fetchUpcomingSessions() {
    if (!supabaseClientRef || !currentUserId) return [];
    const today = new Date();
    const start = localISO(today);
    const end = localISO(addDays(today, SCHEDULE_WINDOW_DAYS));
    try {
      const { data, error } = await supabaseClientRef
        .from(SESSIONS_TABLE)
        .select("session_date,session_type")
        .eq("user_id", currentUserId)
        .gte("session_date", start)
        .lte("session_date", end);
      if (error) throw error;
      return data || [];
    } catch (e) {
      safeWarn("fetchUpcomingSessions failed", e);
      return [];
    }
  }

  /* ── scheduling primitives ───────────────────────────────────────── */

  async function pendingAthlevoIds() {
    const ln = LN();
    if (!ln) return [];
    try {
      const res = await ln.getPending();
      const list = (res && res.notifications) || [];
      return list.map(n => n.id).filter(id => Number.isFinite(id) && id >= ID_MIN && id <= ID_MAX);
    } catch (e) { safeWarn("getPending failed", e); return []; }
  }

  async function cancelIds(ids) {
    const ln = LN();
    if (!ln || !ids || !ids.length) return;
    try { await ln.cancel({ notifications: ids.map(id => ({ id })) }); } catch (e) { safeWarn("cancel failed", e); }
  }

  // Cancels every Athlevo-owned pending local notification. Safe to call
  // even when nothing is scheduled, and safe on web (no-op).
  async function cancelAll(trigger) {
    if (!supported()) return;
    try {
      const ids = await pendingAthlevoIds();
      if (!ids.length) return;
      await cancelIds(ids);
      track("notification_reminder_cancelled", {
        notification_type: "all", platform: platformName(), trigger: trigger || "cancel_all"
      });
    } catch (e) { safeWarn("cancelAll failed", e); }
  }

  // The single entry point for (re)building the on-device reminder queue
  // from the latest canonical plan data. Cancels every stale Athlevo
  // reminder first, then re-derives the window from scratch — so a plan
  // change, a toggle change, or a reminder-time change can never leave a
  // duplicate or out-of-date notification behind.
  async function rescheduleFromPlan() {
    try {
      if (!supported()) return;
      if (!currentUserId) return;

      const prefs = getPreferences();
      if (!prefs.notifications_enabled) {
        // Master is off — make sure nothing lingers, then stop.
        await cancelAll("reschedule_disabled");
        return;
      }

      let perm = null;
      try { perm = await LN().checkPermissions(); } catch (e) {}
      if (!perm || perm.display !== "granted") {
        // The OS permission was revoked outside the app (device Settings).
        // Reflect that locally and stop — never re-prompt automatically.
        await savePreferences({ notifications_enabled: false });
        await cancelAll("permission_revoked");
        return;
      }

      const sessions = await fetchUpcomingSessions();
      const kindByDate = {};
      sessions.forEach(s => {
        const d = String(s.session_date).slice(0, 10);
        const kind = classify(s.session_type);
        if (kind) kindByDate[d] = kind;
      });

      const staleIds = await pendingAthlevoIds();
      if (staleIds.length) await cancelIds(staleIds);

      const toSchedule = [];
      const today = new Date();
      for (let i = 1; i <= SCHEDULE_WINDOW_DAYS; i++) {
        const dISO = localISO(addDays(today, i));
        const kind = kindByDate[dISO];
        if (!kind) continue;
        if (kind === "workout" && !prefs.workout_reminders_enabled) continue;
        if (kind === "recovery" && !prefs.recovery_reminders_enabled) continue;

        const fireAt = fireDateFor(dISO, prefs.reminder_time_local || DEFAULT_REMINDER_TIME);
        if (fireAt.getTime() <= Date.now()) continue; // never schedule into the past

        const isWorkout = kind === "workout";
        toSchedule.push({
          id: dateIntId(dISO),
          title: isWorkout ? "Tomorrow's training" : "Recovery day tomorrow",
          // Deliberately no distance/pace/HR/session-name — calm, generic,
          // safe to show on a locked screen.
          body: isWorkout ? "Your workout is ready in Athlevo." : "Recovery is part of the plan.",
          schedule: { at: fireAt, allowWhileIdle: true },
          channelId: CHANNEL_ID,
          extra: { athlevoType: isWorkout ? "workout_reminder" : "recovery_reminder", date: dISO, screen: "screen-train" }
        });
      }

      if (!toSchedule.length) return;
      try {
        await LN().schedule({ notifications: toSchedule });
        toSchedule.forEach(n => track("notification_reminder_scheduled", {
          notification_type: n.extra.athlevoType, platform: platformName(), trigger: "plan_change"
        }));
      } catch (e) { safeWarn("schedule failed", e); }
    } catch (e) {
      // Scheduling must never take down plan generation/Calendar/Coach.
      safeWarn("rescheduleFromPlan failed", e);
    }
  }

  /* ── deep-link on tap ────────────────────────────────────────────── */

  function installTapListener() {
    if (tapListenerInstalled) return;
    const ln = LN();
    if (!ln || typeof ln.addListener !== "function") return;
    tapListenerInstalled = true;
    try {
      ln.addListener("localNotificationActionPerformed", function (payload) {
        try {
          const extra = (payload && payload.notification && payload.notification.extra) || {};
          track("notification_opened", { notification_type: extra.athlevoType || "unknown", platform: platformName() });
          const screen = extra.screen || "screen-train";
          // Reuses the existing screen router — no new navigation system.
          // Works cold-start too: App.getLaunchUrl()/appUrlOpen handling in
          // runtimeEnvironment.js already brings the app to a ready state
          // before this listener's callback can fire with a tapped payload.
          if (typeof root.showScreen === "function") root.showScreen(screen);
          root.dispatchEvent(new CustomEvent("athlevo:notification-opened", { detail: extra }));
        } catch (e) { safeWarn("tap handling failed", e); }
      });
    } catch (e) { safeWarn("addListener failed", e); }
  }

  /* ── account lifecycle (multi-account + logout/delete safety) ───── */

  // Called once, early, whenever a session resolves to a signed-in user
  // (fresh login, restored session, or switching to a different account
  // on the same device). Always cancels first — a previous athlete's
  // pending reminders must never survive into the next athlete's session.
  async function onSignIn(client, userId) {
    try {
      if (!userId) return;
      const switchingUser = currentUserId && currentUserId !== userId;
      if (switchingUser) await cancelAll("account_switch");
      supabaseClientRef = client || supabaseClientRef;
      currentUserId = userId;
      await loadPreferences();
      installTapListener();
      if (supported()) await ensureChannel();
      await rescheduleFromPlan();
    } catch (e) { safeWarn("onSignIn failed", e); }
  }

  async function onSignOut() {
    try {
      await cancelAll("logout");
    } finally {
      prefsCache = null;
      currentUserId = null;
    }
  }

  async function onAccountDeleted() {
    try {
      await cancelAll("account_deletion");
      if (supabaseClientRef && currentUserId) {
        try { await supabaseClientRef.from(PREF_TABLE).delete().eq("user_id", currentUserId); }
        catch (e) { safeWarn("preference cleanup on delete failed", e); }
      }
    } finally {
      prefsCache = null;
      currentUserId = null;
    }
  }

  root.AthlevoNotifications = {
    onSignIn,
    onSignOut,
    onAccountDeleted,
    getPreferences,
    setMasterEnabled,
    setCategoryEnabled,
    setReminderTime,
    maybeShowSoftPrompt,
    requestPermissionAndEnable,
    rescheduleFromPlan,
    cancelAll,
    isSupported: supported,
    platformName
  };
})(typeof window !== "undefined" ? window : globalThis);
