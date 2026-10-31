/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach Mode shell + Coach Today command center
 *  window.AthlevoCoachMode
 * ══════════════════════════════════════════════════════════════════════
 *
 *  When the authenticated user has role `coach` or `admin`, the app
 *  enters Coach Mode: the same five-tab navigation renders
 *  coach-specific content instead of athlete content.
 *
 *  Mode resolution is SERVER-AUTHORITATIVE. The browser UI is not the
 *  security boundary — every data read goes through
 *  /api/providers?action=coaching_dashboard_*, which re-checks role +
 *  active assignments server-side.
 *
 *  Three client states:
 *    · athlete_mode  — confirmed `athlete` role
 *    · coach_mode    — confirmed `coach` or `admin` role
 *    · unknown       — loading, auth failure, role verification failure
 *
 *  Rules:
 *    · Role is never inferred from email
 *    · Unknown is never cached as confirmed
 *    · Client-side spoofing cannot activate Coach Mode
 *    · Existing athlete users retain their experience unchanged
 *    · Retry is always available from unknown
 *
 *  Privacy: analytics are categorical only — never name, email, UUID,
 *  workout title, pain notes, readiness values, health metrics, provider
 *  IDs, or raw errors. Active-roster DOM never contains athlete emails; the
 *  pending-invitation list intentionally shows only the coach-entered email.
 */

(function () {
  "use strict";

  /* ═══════════════════════ STATE ═══════════════════════════════════ */

  var _appMode = "unknown"; // "athlete_mode" | "coach_mode" | "unknown"
  var _role = null;
  var _coachName = null;
  var _roster = [];
  var _rosterLoading = false;
  var _rosterError = null;
  var _invites = [];
  var _invitesLoaded = false;
  var _inviteMutationId = null;
  var _inviteSendInFlight = false;
  var _inviteEmail = "";
  var _invitePreviousFocus = null;
  var _search = "";
  var _rosterFilter = "all";
  var _athleteDetailId = null;
  var _athleteDetail = null;
  var _athleteDetailTab = "overview";
  var _athleteWeekStart = null;
  var _athleteAnalyticsRange = 4;
  var _athleteCheckInsRange = 7;
  var _editingCoachNoteId = null;
  var _messageOrigin = "global";
  var _messageReturnTab = "overview";
  var _messageThreadCache = Object.create(null);
  var _messageRequest = 0;
  var _athleteDetailCache = Object.create(null);
  var _athleteDetailRequest = 0;
  var _athletePanelTransition = 0;
  var _athletePanelTimer = null;
  var _coachDashboardScrollTop = 0;
  var _athleteDetailScrollTop = 0;
  var _athleteDrillPending = false;
  var _athleteDrillAnimation = null;
  var _athleteDrillToken = 0;
  var _initialized = false;
  var _resolving = false;
  var _authUserId = null;
  var _authGeneration = 0;
  var _modeRequest = 0;
  var _athleteTodayHTML = null;   // saved athlete Today innerHTML for restore

  /* ─── Workspace state ─── */
  var LEGACY_WORKSPACE_KEY = "athlevo_workspace";
  var _workspace = null;   // "coach_workspace" | "athlete_workspace" | null (not yet resolved)
  var _athleteUIInitialized = false;  // tracks whether athlete screens have been populated

  /* ═══════════════════════ HELPERS ═════════════════════════════════ */

  function sb() { return typeof supabaseClient !== "undefined" ? supabaseClient : null; }
  function analytics() { return window.AthlevoAnalytics || null; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function authSession(expectedUserId) {
    var c = sb();
    if (!c) return null;
    try {
      var r = await c.auth.getSession();
      var session = r && r.data && r.data.session;
      var userId = session && session.user && session.user.id;
      if (!session || !session.access_token) return null;
      if (expectedUserId && userId !== expectedUserId) return null;
      return { accessToken: session.access_token, userId: userId || null };
    } catch (e) { return null; }
  }

  async function token() {
    var session = await authSession();
    return session && session.accessToken;
  }

  async function api(action, opts) {
    opts = opts || {};
    var session = await authSession(opts.expectedUserId);
    if (!session) return { ok: false, status: 401, body: { error: "No matching session" } };
    var url = "/api/providers?action=coaching_dashboard_" + encodeURIComponent(action);
    if (opts.query) Object.keys(opts.query).forEach(function (k) {
      url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(opts.query[k]);
    });
    var init = { method: opts.method || "GET", headers: { Authorization: "Bearer " + session.accessToken } };
    if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    try {
      var res = await fetch(url, init);
      var body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      return { ok: res.ok, status: res.status, body: body || {} };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "network" } };
    }
  }

  // Coach workout library (js/coachWorkoutBuilder.js calls these).
  async function libraryApi(action, opts) {
    opts = opts || {};
    var session = await authSession();
    if (!session) return { ok: false, status: 401, body: { error: "No matching session" } };
    var init = { method: opts.method || "GET", headers: { Authorization: "Bearer " + session.accessToken } };
    if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    try {
      var res = await fetch("/api/providers?action=coaching_library_" + encodeURIComponent(action), init);
      var body = {};
      try { body = await res.json(); } catch (e) { body = {}; }
      return { ok: res.ok, status: res.status, body: body || {} };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "network" } };
    }
  }

  var workoutLibrary = {
    list: function () {
      return libraryApi("list").then(function (r) {
        return r.ok ? r.body : { items: [], unavailable: true, message: "Your workout library could not be loaded." };
      });
    },
    save: function (item) {
      return libraryApi("save", { method: "POST", body: { item: item } }).then(function (r) {
        return r.ok ? { ok: true, item: r.body.item } : { ok: false, error: r.body && r.body.error };
      });
    }
  };

  async function inviteApi(action, opts) {
    opts = opts || {};
    var t = await token();
    if (!t) return { ok: false, status: 401, body: { error: "No session" } };
    var init = { method: opts.method || "GET", headers: { Authorization: "Bearer " + t } };
    if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    try {
      var res = await fetch("/api/providers?action=coaching_invite_" + encodeURIComponent(action), init);
      var body = {};
      try { body = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, body: body || {} };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "network" } };
    }
  }

  async function providerApi(action, body) {
    var t = await token();
    if (!t) return { ok: false, status: 401, body: { error: "No session" } };
    try {
      var res = await fetch("/api/providers?action=" + encodeURIComponent(action), {
        method: "POST",
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      var parsed = {};
      try { parsed = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, body: parsed || {} };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "network" } };
    }
  }

  function fmtVal(v, suffix) {
    if (v === null || v === undefined || v === "") return "—";
    return esc(v) + (suffix || "");
  }
  function fmtLastActive(iso) {
    if (!iso) return "No recent data";
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return "No recent data";
    var days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return days + " days ago";
    if (days < 30) return Math.floor(days / 7) + "w ago";
    return "30+ days ago";
  }
  function rosterBand(n) {
    if (n === 0) return "0";
    if (n <= 5) return "1-5";
    if (n <= 15) return "6-15";
    if (n <= 40) return "16-40";
    return "40+";
  }

  var SPORT_LABEL = { run: "Run", ride: "Ride", strength: "Strength", swim: "Swim", walk: "Walk", hike: "Hike", mobility: "Mobility", cross_training: "Cross-train", rest: "Rest", other: "Activity" };
  var STATUS_META = {
    needs_attention: { label: "Needs attention", order: 0 },
    monitor:         { label: "Monitor",         order: 1 },
    no_recent_data:  { label: "No recent data",  order: 2 },
    on_track:        { label: "On track",        order: 3 }
  };
  var SEV_RANK = { high: 3, medium: 2, low: 1, none: 0 };

  function sortRoster(list) {
    return list.slice().sort(function (a, b) {
      var oa = (STATUS_META[a.attention_status] || {}).order != null ? STATUS_META[a.attention_status].order : 9;
      var ob = (STATUS_META[b.attention_status] || {}).order != null ? STATUS_META[b.attention_status].order : 9;
      if (oa !== ob) return oa - ob;
      var sa = SEV_RANK[a.attention_severity] || 0, sb2 = SEV_RANK[b.attention_severity] || 0;
      if (sa !== sb2) return sb2 - sa;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  var ATTENTION_REASON_LABELS = {
    pain_reported: "Pain reported",
    illness_reported: "Illness reported",
    very_low_readiness: "Readiness is materially low",
    low_readiness: "Readiness is low",
    low_recovery: "Recovery needs review",
    missed_key_workout: "Key session missed",
    multiple_missed_sessions: "Multiple sessions missed",
    high_recent_load: "Recent training load is unusually high",
    no_readiness_checkin: "Check-in is overdue",
    no_recent_app_activity: "No recent app activity",
    no_recent_activity: "No recent training activity",
    provider_sync_failed: "Training data needs attention",
    no_active_plan: "Training plan is missing",
    event_approaching: "Target race is approaching"
  };

  function attentionReasonLabel(key) {
    if (!key) return "Review athlete status";
    return ATTENTION_REASON_LABELS[key] || String(key).replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function athleteContext(a) {
    var bits = [];
    var sport = SPORT_LABEL[a.primary_sport];
    if (sport) bits.push(sport);
    if (a.goal) bits.push(a.goal);
    return bits.length ? bits.join(" · ") : "Athlete";
  }

  function latestActivitySummary(a) {
    var act = a && a.latest_activity;
    if (!act) return null;
    var bits = [SPORT_LABEL[act.sport] || "Activity"];
    if (act.duration_min != null) bits.push(act.duration_min + " min");
    if (act.distance_km != null) bits.push(act.distance_km + " km");
    return bits.join(" · ");
  }

  function rosterStatusLine(a) {
    var reasons = a.attention_reason_keys || [];
    if ((a.attention_status === "needs_attention" || a.attention_status === "monitor") && reasons.length) {
      return attentionReasonLabel(reasons[0]);
    }
    if (a.today_planned) return (a.today_planned.title || "Session") + " planned today";
    var activity = latestActivitySummary(a);
    if (activity) return activity + " · " + fmtLastActive(a.latest_activity.date);
    if (a.readiness_status && a.readiness_status !== "No recent data") return a.readiness_status + " readiness";
    if (a.last_active_at) return "Last active " + fmtLastActive(a.last_active_at).toLowerCase();
    return "No recent training data";
  }

  function inviteAge(iso) {
    var time = Date.parse(iso || "");
    if (!Number.isFinite(time)) return "Sent recently";
    var minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (minutes < 1) return "Sent just now";
    if (minutes < 60) return "Sent " + minutes + " minute" + (minutes === 1 ? "" : "s") + " ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return "Sent " + hours + " hour" + (hours === 1 ? "" : "s") + " ago";
    var days = Math.floor(hours / 24);
    return "Sent " + days + " day" + (days === 1 ? "" : "s") + " ago";
  }

  function ensureCoachCommandStyles() {
    if (document.getElementById("coachCommandCenterStyles")) return;
    var style = document.createElement("style");
    style.id = "coachCommandCenterStyles";
    style.textContent = [
      ".cm-command{width:100%;max-width:430px;margin:0 auto;padding:18px 16px 104px;box-sizing:border-box;color:var(--ink1,var(--ink,#141416));}",
      ".cm-command--ready{animation:cmCommandIn var(--dur-base,200ms) var(--ease-standard,ease-out) both;}",
      "@keyframes cmCommandIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}",
      ".cm-command-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px;}",
      ".cm-command-head h1{font-family:var(--serif,serif);font-size:26px;font-weight:520;letter-spacing:-.025em;line-height:1.08;margin:0;}",
      ".cm-command-summary{max-width:620px;margin:6px 0 0;color:var(--ink3,#9a9da3);font-size:13px;line-height:1.4;}",
      ".cm-refresh{border:0;background:transparent;color:var(--ink3,#9a9da3);font:600 12px/1 var(--sans,sans-serif);padding:8px 0;cursor:pointer;flex:0 0 auto;}",
      ".cm-head-actions{display:flex;align-items:center;gap:12px;flex:0 0 auto}.cm-invite-trigger{min-height:36px;border:1px solid var(--line,#ebebe8);border-radius:999px;background:transparent;color:var(--ink1,#141416);font:700 11px/1 var(--sans,sans-serif);padding:9px 12px;cursor:pointer;white-space:nowrap}",
      ".cm-refresh:focus-visible,.cm-open-row:focus-visible,.cm-review:focus-visible{outline:2px solid var(--red,#C0272D);outline-offset:3px;}",
      ".cm-section{min-width:0;}",
      ".cm-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0;padding-bottom:10px;border-bottom:1px solid var(--line,#ebebe8);}",
      ".cm-section-title{font-family:var(--sans,sans-serif);font-size:13px;font-weight:760;letter-spacing:.065em;text-transform:uppercase;margin:0;}",
      ".cm-section-count{color:var(--ink3,#9a9da3);font-size:11px;}",
      ".cm-list{border-top:0;}",
      ".cm-row{display:flex;align-items:center;gap:12px;min-width:0;padding:13px 2px;border-bottom:1px solid var(--line,#ebebe8);}",
      ".cm-open-row{width:100%;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;}",
      ".cm-avatar{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border-radius:50%;background:var(--card2,var(--card,#f4f4f4));color:var(--ink2,#4f4f4f);font-size:11px;font-weight:750;letter-spacing:.02em;}",
      ".cm-row-copy{display:block;min-width:0;flex:1;}",
      ".cm-row-name,.cm-row-primary,.cm-row-meta{display:block;}",
      ".cm-row-name{font-size:13px;font-weight:700;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color var(--dur-fast,140ms) var(--ease-standard,ease);}",
      ".cm-row-primary{font-size:12px;line-height:1.4;color:var(--ink2,#6d7075);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".cm-row-meta{font-size:11px;line-height:1.4;color:var(--ink3,#9a9da3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".cm-row-status{flex:0 0 auto;max-width:110px;text-align:right;color:var(--ink3,#9a9da3);font-size:11px;line-height:1.25;}",
      ".cm-status-attention{color:var(--bad,#c0272d);font-weight:700;}",
      ".cm-status-monitor{color:var(--warn,#c98a1e);font-weight:700;}",
      ".cm-chevron{flex:0 0 auto;color:var(--ink3,#9a9da3);font-size:17px;line-height:1;}",
      ".cm-review{flex:0 0 auto;border:1px solid var(--line,#ebebe8);border-radius:999px;background:transparent;color:var(--ink1,var(--ink,#141416));font:700 11px/1 var(--sans,sans-serif);padding:8px 11px;cursor:pointer;}",
      ".cm-quiet-state{display:flex;align-items:center;gap:10px;margin-top:10px;padding:14px 15px;border-radius:10px;background:var(--card2,var(--card,#f6f6f4));color:var(--ink2,#6d7075);font-size:13px;line-height:1.35;}",
      ".cm-quiet-state::before{content:'';width:18px;height:1px;background:var(--ink3,#9a9da3);opacity:.45;flex:0 0 auto;}",
      ".cm-quiet-state--clear::before{width:7px;height:7px;border-radius:50%;background:var(--good,#1f9d5b);opacity:1;}",
      ".cm-search{width:100%;box-sizing:border-box;border:0;border-bottom:1px solid var(--line,#ebebe8);border-radius:0;background:transparent;color:inherit;padding:10px 0 11px;font:13px/1.3 var(--sans,sans-serif);margin:0;}",
      ".cm-search:focus{outline:0;border-bottom-color:var(--ink2,#6d7075);}",
      ".cm-empty{padding:22px 0;border-block:1px solid var(--line,#ebebe8);}",
      ".cm-empty strong{display:block;font-family:var(--serif,serif);font-size:20px;font-weight:520;}",
      ".cm-empty p{margin:5px 0 0;color:var(--ink3,#9a9da3);font-size:13px;line-height:1.45;}",
      ".cm-pending-invites{margin-top:26px}.cm-invite-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line,#ebebe8)}.cm-invite-copy{min-width:0;flex:1}.cm-invite-email{display:block;font-size:13px;font-weight:700;line-height:1.35;overflow-wrap:anywhere}.cm-invite-sent{display:block;margin-top:3px;color:var(--ink3,#9a9da3);font-size:11px}.cm-invite-row-actions{display:flex;gap:10px;flex:0 0 auto}.cm-invite-row-actions button{min-height:34px;border:0;background:transparent;color:var(--ink2,#6d7075);font:700 11px/1 var(--sans,sans-serif);padding:7px 0;cursor:pointer}.cm-invite-row-actions .danger{color:var(--bad,#c0272d)}.cm-invite-row-actions button:disabled{opacity:.5}",
      ".cm-invite-overlay{position:fixed;inset:0;z-index:210;background:var(--backdrop,rgba(20,20,22,.48));display:flex;align-items:flex-end;justify-content:center}.cm-invite-dialog{width:100%;max-width:480px;max-height:90vh;overflow:auto;box-sizing:border-box;background:var(--surface-base,#fff);border-radius:26px 26px 0 0;padding:22px 20px calc(22px + env(safe-area-inset-bottom));box-shadow:var(--elev-3)}.cm-invite-dialog h2{margin:0;font-family:var(--serif,serif);font-size:24px;font-weight:520}.cm-invite-dialog>p{margin:8px 0 20px;color:var(--ink2,#6d7075);font-size:13px;line-height:1.5}.cm-invite-form{display:grid;gap:8px}.cm-invite-form label{font-size:11px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3,#9a9da3)}.cm-invite-form input{width:100%;min-height:46px;box-sizing:border-box;border:1px solid var(--line,#ebebe8);border-radius:10px;background:var(--bg,#fff);color:inherit;padding:11px 12px;font:16px/1.35 var(--sans,sans-serif)}.cm-invite-form-error{min-height:18px;margin:1px 0 0;color:var(--bad,#c0272d);font-size:12px;line-height:1.45}.cm-invite-dialog-actions{display:grid;gap:9px;margin-top:12px}.cm-invite-dialog-actions button{min-height:46px;border:1px solid var(--line,#ebebe8);border-radius:999px;background:transparent;color:inherit;font:700 13px/1 var(--sans,sans-serif);padding:12px 16px;cursor:pointer}.cm-invite-dialog-actions .primary{border-color:var(--red,#c0272d);background:var(--red,#c0272d);color:#fff}.cm-invite-dialog-actions .danger{border-color:var(--bad,#c0272d);color:var(--bad,#c0272d)}.cm-invite-dialog-actions button:disabled{opacity:.52;cursor:default}",
      ".cm-join{display:grid;gap:8px}.cm-join label{font-size:11px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3,#9a9da3)}.cm-join input{width:100%;min-height:46px;box-sizing:border-box;border:1px solid var(--line,#ebebe8);border-radius:10px;background:var(--bg,#fff);color:inherit;padding:11px 12px;font:15px/1.35 var(--sans,sans-serif)}.cm-join-new{background:none!important;border:0!important;min-height:36px!important;font-weight:600!important;font-size:12.5px!important;color:var(--ink2,#6d7075)!important;text-decoration:underline}.cm-invite-or{margin:18px 0 8px!important;font-size:11px!important;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3,#9a9da3)!important}",
      ".cm-error{padding:18px 0;border-block:1px solid var(--line,#ebebe8);color:var(--ink2,#6d7075);font-size:13px;}",
      ".cm-error button{margin-top:10px;}",
      ".cm-command-skeleton{width:100%;max-width:430px;margin:0 auto;padding:18px 16px 104px;box-sizing:border-box;}",
      ".cm-skel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px;}",
      ".cm-skel-stack{display:grid;gap:8px;min-width:0;flex:1}.cm-skel-line{display:block;height:12px;border-radius:4px}.cm-skel-line--title{width:min(240px,70%);height:29px}.cm-skel-line--sub{width:min(360px,90%);}",
      ".cm-skel-refresh{display:block;width:48px;height:12px;margin-top:8px;border-radius:4px;flex:0 0 auto;}",
      "",
      ".cm-skel-section{display:grid;gap:10px;min-width:0}",
      ".cm-skel-search{display:block;width:100%;height:34px;border-radius:6px}.cm-skel-roster{display:grid}.cm-skel-roster-row{display:flex;align-items:flex-start;gap:12px;min-width:0;padding:14px 2px;border-bottom:1px solid var(--line,#ebebe8)}.cm-skel-avatar{display:block;width:40px;height:40px;border-radius:50%;flex:0 0 40px}.cm-skel-roster-copy{display:grid;gap:6px;min-width:0;flex:1;padding-top:1px}.cm-skel-name{display:block;width:min(180px,68%);height:13px;border-radius:4px}.cm-skel-context{display:block;width:min(250px,88%);height:10px;border-radius:3px}.cm-skel-status{display:block;width:min(150px,56%);height:9px;border-radius:3px}.cm-skel-chevron{display:block;width:8px;height:14px;margin-top:4px;border-radius:3px;flex:0 0 8px}",
      "body.coach-loading .boot-content{padding:0;overflow:hidden}body.coach-loading .boot-content .cm-command-skeleton{padding-top:calc(18px + env(safe-area-inset-top));}",
      ".cm-roster-item .cm-row{align-items:flex-start;padding:16px 2px;}",
      ".cm-roster-item .cm-avatar{width:40px;height:40px;flex-basis:40px;margin-top:1px;font-size:12px;}",
      ".cm-roster-item .cm-row-name{font-size:15px;line-height:1.25;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;}",
      ".cm-roster-item .cm-row-primary{font-size:12px;line-height:1.45;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;}",
      ".cm-roster-item .cm-row-meta{font-size:11px;line-height:1.45;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;}",
      ".cm-roster-item .cm-chevron{margin-top:3px;}",
      ".cm-command--small-roster .cm-section--roster{padding-top:2px;}",
      ".cm-filter-row{display:flex;gap:14px;overflow-x:auto;padding:12px 0 2px;scrollbar-width:none}.cm-filter-row::-webkit-scrollbar{display:none}.cm-filter{border:0;border-bottom:1px solid transparent;background:transparent;padding:3px 0 6px;color:var(--ink3,#9a9da3);font:700 11px/1 var(--sans,sans-serif);white-space:nowrap;cursor:pointer}.cm-filter.is-active{color:var(--ink1,#141416);border-bottom-color:var(--red,#C0272D)}",
      /* Adding to a day: empty days are buttons with a +, and a small two-step menu. */
      ".cm-day-empty{cursor:pointer;width:100%}.cm-day-add{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line,#ebebe8);border-radius:50%;color:var(--ink2,#6d7075);font-size:18px;line-height:1}.cm-day-empty:focus-visible{outline:2px solid var(--focus-ring,#C0272D);outline-offset:-2px}",
      ".cm-add-menu{max-width:420px}.cm-add-list{display:grid;gap:8px}.cm-add-choice{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:56px;padding:10px 14px;border:1px solid var(--line,#ebebe8);border-radius:var(--ui-radius-control,12px);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.cm-add-choice b{display:block;font-size:15px}.cm-add-choice small{display:block;margin-top:2px;color:var(--ink3,#9a9da3);font-size:12px}.cm-add-choice i{color:var(--ink3,#9a9da3);font-style:normal;font-size:20px}.cm-add-choice:disabled{opacity:.5}.cm-add-choice:focus-visible,.cm-add-back:focus-visible{outline:2px solid var(--focus-ring,#C0272D);outline-offset:2px}.cm-add-back{justify-self:start;border:0;background:transparent;padding:6px 0;color:var(--ink2,#6d7075);font:700 12px/1 var(--sans,sans-serif);cursor:pointer}",
      "@media(hover:hover) and (pointer:fine){.cm-day-empty:hover .cm-day-add{border-color:var(--red,#C0272D);color:var(--red,#C0272D)}.cm-add-choice:hover{border-color:var(--ink2,#6d7075)}}",
      /* Sheets sit above the tab bar (z-index 1000). The editor keeps Cancel and Save pinned. */
      "body .cm-workout-overlay,body .cm-invite-overlay,body .cm-note-confirm{z-index:1200}",
      ".cm-editor{display:flex;flex-direction:column;padding-bottom:0}.cm-editor .cm-workout-form{display:grid;grid-template-columns:1fr;gap:12px;min-height:0}.cm-editor .cm-field--full{grid-column:1/-1}.cm-field-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.cm-field-hint{color:var(--ink3,#9a9da3);font-size:11px;line-height:1.4}",
      ".cm-editor .cm-form-actions{position:sticky;bottom:0;margin:4px -16px 0;padding:12px 16px calc(14px + env(safe-area-inset-bottom));background:var(--surface-base,#fff);border-top:1px solid var(--line,#ebebe8)}",
      ".cm-field-label{font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3,#9a9da3)}.cm-target{display:grid;gap:6px}.cm-target-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center}.cm-seg{display:inline-flex;padding:3px;gap:2px;border:1px solid var(--border-default,var(--line,#ebebe8));border-radius:var(--r-pill);background:var(--surface-raised,#fff)}.cm-seg-btn{min-height:36px;padding:0 14px;border:0;border-radius:var(--r-pill);background:transparent;color:var(--ink2,#5b5e65);font:700 13px/1 var(--sans,sans-serif);cursor:pointer}.cm-seg-btn[aria-pressed=true]{background:var(--ink1,#141416);color:var(--surface-base,#fff)}.cm-seg-btn:focus-visible{outline:2px solid var(--focus-ring,#C0272D);outline-offset:2px}.cm-seg-btn:disabled{opacity:.6;cursor:default}.cm-target-input{position:relative}.cm-target-input input{padding-right:44px;appearance:textfield;-moz-appearance:textfield}.cm-target-input input::-webkit-outer-spin-button,.cm-target-input input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.cm-target-unit{position:absolute;right:12px;top:50%;transform:translateY(-50%);color:var(--ink3,#9a9da3);font-size:13px;pointer-events:none}",
      ".cm-day-draft{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--r-pill);background:color-mix(in srgb,var(--athlevo-red,#C0272D) 12%,transparent);color:var(--athlevo-red,#C0272D);font:750 9px/1 var(--sans,sans-serif);letter-spacing:.04em;text-transform:uppercase}",
      ".cm-publish-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;border-radius:14px;background:color-mix(in srgb,var(--athlevo-red,#C0272D) 7%,var(--surface-raised,#fff));border:1px solid color-mix(in srgb,var(--athlevo-red,#C0272D) 22%,transparent)}.cm-publish-copy{display:grid;gap:2px}.cm-publish-copy strong{font:750 13px/1.2 var(--sans,sans-serif);color:var(--ink1,#141416)}.cm-publish-copy span{font-size:12px;color:var(--ink2,#5b5e65)}.cm-publish-actions{display:flex;gap:8px;flex-wrap:wrap}.cm-publish-discard{color:var(--ink2,#5b5e65)}",
      ".cm-add-steps{justify-self:start;border:0;background:transparent;padding:4px 0;color:var(--red,#C0272D);font:700 12px/1.3 var(--sans,sans-serif);cursor:pointer}.cm-add-steps:focus-visible{outline:2px solid var(--focus-ring,#C0272D);outline-offset:2px}",
      ".cm-add-menu textarea{width:100%;box-sizing:border-box;border:1px solid var(--line,#ebebe8);border-radius:var(--ui-radius-control,10px);background:var(--surface-raised,#fff);color:inherit;padding:10px;font:14px/1.4 var(--sans,sans-serif);resize:vertical}.cm-add-save{justify-self:end;min-height:44px;padding-inline:22px}.cm-add-menu .cm-field{margin-top:4px}",
      ".cm-day-right{display:flex;align-items:center;gap:8px}.cm-day-grip{color:var(--ink3,#9a9da3);font-size:14px;letter-spacing:-3px;line-height:1;padding:8px 4px;touch-action:none;cursor:grab;user-select:none}",
      ".cm-day-row.is-draggable{cursor:grab;touch-action:pan-y}.cm-day-row.is-drag-source{opacity:.35}.cm-day-row.is-moving{opacity:.5;pointer-events:none}",
      ".cm-drag-ghost{position:fixed;z-index:1300;margin:0;pointer-events:none;background:var(--surface-base,#fff);border:1px solid var(--line,#ebebe8);border-radius:var(--ui-radius-control,12px);box-shadow:var(--elev-3);cursor:grabbing;opacity:.96}",
      ".is-dragging-workout .cm-day-empty{outline:1px dashed var(--line,#c9c9c4);outline-offset:-3px}.is-dragging-workout .cm-day-empty.is-drop-target{outline:2px solid var(--red,#C0272D);background:var(--card2,#f6f6f4)}",
      ".cm-editor .cm-form-actions .cm-week-btn{min-height:44px;padding:0 20px;font:700 13px/1 var(--sans,sans-serif)}.cm-editor .cm-form-actions .cm-week-btn.cm-dialog-close{border:1px solid var(--line,#ebebe8);background:transparent;font-size:13px}",
      "@media(max-width:420px){.cm-field-row{grid-template-columns:repeat(2,minmax(0,1fr))}.cm-field-row .cm-field:last-child{grid-column:1/-1}}",
      ".cm-roster-state{flex:0 0 auto;font-size:10px;font-weight:700;color:var(--ink3,#9a9da3);max-width:92px;text-align:right}.cm-roster-state.attention{color:var(--bad,#c0272d)}",
      /* My Athletes table (coach Home). Wide: a real table. Narrow: one card-like row per athlete. */
      ".cm-command--roster{max-width:1180px}.cm-table-wrap{margin-top:6px;overflow-x:auto}.cm-roster-table{width:100%;border-collapse:collapse;table-layout:auto}",
      ".cm-roster-table th{padding:12px 12px 10px;border-bottom:1px solid var(--line,#ebebe8);color:var(--ink3,#9a9da3);font-size:10px;font-weight:750;letter-spacing:.065em;text-align:left;text-transform:uppercase;white-space:nowrap}",
      ".cm-roster-table td{padding:14px 12px;border-bottom:1px solid var(--line,#ebebe8);font-size:13px;line-height:1.35;vertical-align:middle}",
      ".cm-roster-row{cursor:pointer;transition:background var(--dur-fast,140ms) var(--ease-standard,ease)}.cm-roster-row:focus-visible{outline:2px solid var(--focus-ring,#C0272D);outline-offset:-2px}",
      ".cm-col-athlete{min-width:240px}.cm-athlete-cell{display:flex;align-items:flex-start;gap:12px}.cm-col-today,.cm-col-race{min-width:120px}.cm-col-status{min-width:130px}",
      ".cm-roster-id{display:block;min-width:0}.cm-roster-id .cm-row-name{font-size:15px;white-space:normal;overflow:visible}.cm-roster-id .cm-row-primary{margin-top:3px;white-space:normal;overflow:visible}",
      ".cm-roster-links{display:block;margin-top:5px;color:var(--ink3,#9a9da3);font-size:11px}.cm-roster-links button{border:0;background:transparent;padding:0;color:var(--red,#C0272D);font:600 11px/1.3 var(--sans,sans-serif);cursor:pointer}.cm-roster-links button:focus-visible{outline:2px solid var(--focus-ring,#C0272D);outline-offset:2px;border-radius:2px}",
      ".cm-cell-main{display:block;font-weight:650}.cm-cell-sub{display:block;margin-top:3px;color:var(--ink3,#9a9da3);font-size:11px}.cm-cell-empty{color:var(--ink3,#9a9da3)}.cm-week-pct{display:block;font-weight:700}.cm-week-bar{display:block;width:86px;height:3px;margin-top:6px;border-radius:2px;background:var(--line,#ebebe8);overflow:hidden}.cm-week-bar i{display:block;height:100%;background:var(--red,#C0272D)}",
      ".cm-roster-none td{padding:26px 14px;text-align:center;color:var(--ink3,#9a9da3);font-size:13px}",
      "@media(hover:hover) and (pointer:fine){.cm-roster-row:hover{background:var(--card2,var(--card,#f6f6f4))}.cm-roster-links button:hover{text-decoration:underline}}",
      "@media(max-width:1180px){.cm-col-active{display:none}}",
      "@media(max-width:820px){.cm-roster-table thead{display:none}.cm-roster-table,.cm-roster-table tbody{display:block}.cm-roster-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;padding:14px 2px;border-bottom:1px solid var(--line,#ebebe8)}.cm-roster-table td{display:block;padding:0;border:0}.cm-roster-table td.cm-col-athlete{grid-column:1;min-width:0}.cm-roster-table td.cm-col-status{grid-column:2;grid-row:1;max-width:120px;text-align:right}.cm-roster-table td.cm-col-today,.cm-roster-table td.cm-col-week{grid-column:1/-1;display:flex;align-items:baseline;gap:8px;padding-left:52px;font-size:12px}.cm-roster-table td[data-label]:not(.cm-col-athlete):not(.cm-col-status)::before{content:attr(data-label);flex:0 0 66px;color:var(--ink3,#9a9da3);font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase}.cm-roster-table td.cm-col-last,.cm-roster-table td.cm-col-race,.cm-roster-table td.cm-col-active{display:none}.cm-week-bar{display:none}.cm-week-pct{display:inline}.cm-cell-sub{display:inline;margin:0 0 0 6px}.cm-roster-none{display:block}.cm-roster-none td{display:block}}",
      ".cm-athlete-page{width:100%;max-width:920px;margin:0 auto;padding:16px 16px 108px;box-sizing:border-box;color:var(--ink1,var(--ink,#141416))}.cm-athlete-back{border:0;background:transparent;padding:7px 0;color:var(--ink2,#6d7075);font:700 12px/1 var(--sans,sans-serif);cursor:pointer}.cm-athlete-head{display:flex;align-items:flex-start;gap:12px;margin:14px 0 18px}.cm-athlete-head .cm-avatar{width:44px;height:44px;flex-basis:44px}.cm-athlete-head-copy{min-width:0;flex:1}.cm-athlete-name{font-family:var(--serif,serif);font-size:26px;font-weight:520;line-height:1.08;margin:0;overflow-wrap:anywhere}.cm-athlete-context{margin:5px 0 0;color:var(--ink3,#9a9da3);font-size:12px;line-height:1.4}.cm-athlete-tabs{display:flex;gap:18px;overflow-x:auto;border-bottom:1px solid var(--line,#ebebe8);scrollbar-width:none}.cm-athlete-tab{border:0;border-bottom:2px solid transparent;background:transparent;padding:10px 0 9px;color:var(--ink3,#9a9da3);font:700 12px/1 var(--sans,sans-serif);white-space:nowrap;cursor:pointer}.cm-athlete-tab.is-active{color:var(--ink1,#141416);border-bottom-color:var(--red,#C0272D)}.cm-athlete-panel{padding-top:20px}.cm-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line,#ebebe8);border:1px solid var(--line,#ebebe8)}.cm-detail-metric{min-height:82px;background:var(--bg,#fff);padding:14px}.cm-detail-label{display:block;color:var(--ink3,#9a9da3);font-size:10px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}.cm-detail-value{display:block;margin-top:7px;font-size:14px;font-weight:700;line-height:1.35}.cm-detail-sub{display:block;margin-top:3px;color:var(--ink3,#9a9da3);font-size:11px;line-height:1.4}.cm-detail-section{margin-top:24px}.cm-detail-section h3{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase}.cm-detail-empty{padding:16px 0;border-block:1px solid var(--line,#ebebe8);color:var(--ink3,#9a9da3);font-size:13px}.cm-activity-list{margin:0;padding:0;list-style:none}.cm-activity-list li{padding:11px 0;border-bottom:1px solid var(--line,#ebebe8);font-size:13px}.cm-week-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.cm-week-title{font-size:14px;font-weight:750}.cm-week-actions{display:flex;gap:8px}.cm-week-btn{border:1px solid var(--line,#ebebe8);background:transparent;color:inherit;border-radius:999px;padding:8px 11px;font:700 11px/1 var(--sans,sans-serif);cursor:pointer}.cm-week-btn--primary{border-color:var(--red,#C0272D);color:var(--red,#C0272D)}.cm-workout-list{border-top:1px solid var(--line,#ebebe8)}.cm-workout-row{display:grid;grid-template-columns:45px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;padding:13px 0;border:0;border-bottom:1px solid var(--line,#ebebe8);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.cm-workout-date{font-size:10px;color:var(--ink3,#9a9da3);text-transform:uppercase;line-height:1.35}.cm-workout-copy{min-width:0}.cm-workout-title{font-size:13px;font-weight:750;line-height:1.3}.cm-workout-meta{margin-top:4px;color:var(--ink3,#9a9da3);font-size:11px;line-height:1.4}.cm-workout-status{font-size:10px;font-weight:750;text-transform:uppercase;color:var(--ink3,#9a9da3)}.cm-workout-status.completed{color:var(--good,#1f9d5b)}.cm-workout-status.modified{color:var(--warn,#c98a1e)}.cm-workout-status.skipped{color:var(--bad,#c0272d)}.cm-placeholder{padding:28px 0;color:var(--ink3,#9a9da3);font-size:13px;line-height:1.5}.cm-workout-overlay{position:fixed;inset:0;z-index:80;background:var(--backdrop,rgba(20,20,22,.45));display:flex;align-items:flex-end;justify-content:center}.cm-workout-dialog{width:100%;max-width:620px;max-height:90vh;overflow:auto;background:var(--surface-base,#fff);border-radius:var(--ui-radius-sheet,26px) var(--ui-radius-sheet,26px) 0 0;padding:18px 16px calc(22px + env(safe-area-inset-bottom));box-sizing:border-box}.cm-workout-dialog-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.cm-workout-dialog h2{margin:0;font-family:var(--serif,serif);font-size:22px}.cm-dialog-close{border:0;background:transparent;font-size:22px;cursor:pointer}.cm-workout-form{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cm-field{display:grid;gap:5px;min-width:0}.cm-field--full{grid-column:1/-1}.cm-field label{font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3,#9a9da3)}.cm-field input,.cm-field textarea,.cm-field select{width:100%;box-sizing:border-box;border:1px solid var(--line,#ebebe8);border-radius:8px;background:var(--bg,#fff);color:inherit;padding:10px;font:13px/1.35 var(--sans,sans-serif)}.cm-field textarea{min-height:70px;resize:vertical}.cm-form-error{grid-column:1/-1;color:var(--bad,#c0272d);font-size:12px}.cm-form-actions{grid-column:1/-1;display:flex;justify-content:space-between;gap:10px;margin-top:4px}.cm-form-actions-right{display:flex;gap:8px;margin-left:auto}.cm-danger{color:var(--bad,#c0272d);border-color:#e5b7b9}.cm-readonly-note{padding:11px 0;color:var(--ink3,#9a9da3);font-size:12px}",
      ".cm-athlete-back{display:inline-flex;align-items:center;min-height:34px;margin-bottom:8px}.cm-athlete-head{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;margin:4px 0 18px}.cm-athlete-goal{margin:5px 0 0;color:var(--ink2,#6d7075);font-size:13px;line-height:1.35;overflow-wrap:anywhere}.cm-athlete-race{margin:3px 0 0;color:var(--ink3,#9a9da3);font-size:11px;line-height:1.4}.cm-athlete-head-status{max-width:82px;color:var(--ink2,#6d7075);font-size:10px;font-weight:750;line-height:1.3;text-align:right;text-transform:uppercase;letter-spacing:.04em}.cm-athlete-tabs{position:relative;gap:20px;scrollbar-width:none}.cm-athlete-tabs::-webkit-scrollbar{display:none}.cm-athlete-tab{position:relative;z-index:1;flex:0 0 auto;border-bottom:0}.cm-athlete-tab.is-active{border-bottom-color:transparent}.cm-athlete-tab-indicator{position:absolute;left:0;bottom:0;width:24px;height:2px;border-radius:999px;background:var(--red,#C0272D);transform:translate3d(0,0,0);transition:transform var(--motion-screen,240ms) var(--ease-standard,ease),width var(--motion-screen,240ms) var(--ease-standard,ease)}.cm-athlete-panel{display:grid}.cm-athlete-panel-content{grid-area:1/1;min-width:0;transition:opacity var(--motion-screen,240ms) var(--ease-standard,ease),transform var(--motion-screen,240ms) var(--ease-standard,ease);will-change:opacity,transform}.cm-athlete-panel-content.is-exiting{pointer-events:none;opacity:0;transform:translate3d(var(--athlete-panel-exit-x),0,0)}.cm-athlete-panel-content.is-entering{opacity:0;transform:translate3d(var(--athlete-panel-enter-x),0,0)}.cm-athlete-panel-content.is-entering-active{opacity:1;transform:translate3d(0,0,0)}",
      ".cm-overview{display:grid;gap:22px}.cm-overview-section{min-width:0;padding-top:15px;border-top:1px solid var(--line,#ebebe8)}.cm-overview-section:first-child{padding-top:0;border-top:0}.cm-overview-kicker{display:block;margin-bottom:8px;color:var(--ink3,#9a9da3);font-size:10px;font-weight:750;letter-spacing:.065em;text-transform:uppercase}.cm-overview-title{margin:0;font-family:var(--serif,serif);font-size:22px;font-weight:520;line-height:1.15}.cm-overview-copy{margin:6px 0 0;color:var(--ink2,#6d7075);font-size:12px;line-height:1.5}.cm-overview-status{border-block:1px solid var(--line,#ebebe8)}.cm-status-row{display:grid;grid-template-columns:minmax(86px,.8fr) minmax(0,1fr);align-items:baseline;gap:12px;min-height:42px;padding:9px 0;border-bottom:1px solid var(--line,#ebebe8)}.cm-status-row:last-child{border-bottom:0}.cm-status-label{color:var(--ink3,#9a9da3);font-size:11px;font-weight:650}.cm-status-reading{display:flex;align-items:baseline;justify-content:flex-end;gap:8px;min-width:0;text-align:right}.cm-status-value{font-size:14px;font-weight:750;line-height:1.25;overflow-wrap:anywhere}.cm-status-note{color:var(--ink3,#9a9da3);font-size:10px;line-height:1.3}.cm-week-snapshot{border-block:1px solid var(--line,#ebebe8);padding:13px 0}.cm-week-primary{font-size:15px;font-weight:750;line-height:1.35}.cm-week-detail{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:5px;color:var(--ink2,#6d7075);font-size:11px;line-height:1.4}.cm-week-progress{height:2px;margin-top:12px;background:var(--line,#ebebe8);overflow:hidden}.cm-week-progress span{display:block;height:100%;background:var(--red,#C0272D)}.cm-week-flags{display:flex;gap:18px;margin-top:10px;color:var(--ink3,#9a9da3);font-size:10px}.cm-latest{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start}.cm-latest strong{display:block;font-size:14px}.cm-latest p{margin:4px 0 0;color:var(--ink2,#6d7075);font-size:11px;line-height:1.45}.cm-latest-status,.cm-latest time{color:var(--ink3,#9a9da3);font-size:10px;white-space:nowrap}.cm-latest-status{display:block;margin-top:5px;font-weight:700}.cm-attention-section{border-top-color:rgba(154,101,5,.32)}.cm-attention-list{margin:0;padding:0;list-style:none}.cm-attention-list li{padding:8px 0;border-bottom:1px solid var(--line,#ebebe8);font-size:12px;line-height:1.45}.cm-attention-list li:last-child{border-bottom:0}.cm-attention-action{margin-top:9px}.cm-attention-clear{color:var(--ink2,#6d7075);font-size:12px}.cm-race-line{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:14px}.cm-race-line strong{font-family:var(--serif,serif);font-size:19px;font-weight:520;line-height:1.2}.cm-race-meta{display:block;margin-top:5px;color:var(--ink3,#9a9da3);font-size:11px}.cm-race-countdown{color:var(--ink2,#6d7075);font-size:13px;font-weight:750;text-align:right}",
      ".cm-training-week{display:grid;gap:14px}.cm-week-nav{display:grid;grid-template-columns:42px minmax(0,1fr) 42px;align-items:start;gap:8px}.cm-week-nav button{display:grid;place-items:center;width:38px;height:38px;border:0;background:transparent;color:var(--ink2,#6d7075);font:500 24px/1 var(--sans,sans-serif);cursor:pointer}.cm-week-nav button:last-child{justify-self:end}.cm-week-range{text-align:center;font-size:13px;font-weight:780;letter-spacing:.045em;text-transform:uppercase}.cm-week-volume{text-align:center;color:var(--ink3,#9a9da3);font-size:10px;line-height:1.4;margin-top:4px}.cm-day-list{border-top:1px solid var(--line,#ebebe8)}.cm-day-row{display:grid;grid-template-columns:45px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;min-height:64px;padding:10px 2px;border:0;border-bottom:1px solid var(--line,#ebebe8);background:transparent;color:inherit;text-align:left;font:inherit}.cm-day-row[data-workout-id]{cursor:pointer}.cm-day-row[data-workout-id]:focus-visible,.cm-week-nav button:focus-visible,.cm-add-workout:focus-visible{outline:2px solid var(--red,#C0272D);outline-offset:2px}.cm-day-row.is-today{box-shadow:inset 2px 0 rgba(179,41,45,.58);padding-left:10px;background:rgba(179,41,45,.035)}.cm-day-date{font-size:10px;font-weight:750;line-height:1.3;letter-spacing:.045em;text-transform:uppercase;color:var(--ink3,#9a9da3)}.cm-day-date b{display:block;margin-top:2px;color:var(--ink1,#141416);font-size:13px}.cm-day-copy{min-width:0}.cm-day-title{display:block;font-size:13px;font-weight:750;line-height:1.3;overflow-wrap:anywhere}.cm-day-meta{display:block;margin-top:3px;color:var(--ink3,#9a9da3);font-size:10px;line-height:1.4;overflow-wrap:anywhere}.cm-day-status{max-width:68px;color:var(--ink3,#9a9da3);font-size:9px;font-weight:750;letter-spacing:.035em;text-align:right;text-transform:uppercase}.cm-day-status.completed{color:var(--good,#1f9d5b)}.cm-day-status.modified{color:var(--warn,#c98a1e)}.cm-day-status.skipped{color:var(--bad,#c0272d)}.cm-day-status.pending,.cm-day-status.planned,.cm-day-status.upcoming{color:var(--ink3,#9a9da3)}.cm-day-rest{min-height:55px}.cm-day-rest .cm-day-title,.cm-day-rest .cm-day-status{color:var(--ink3,#9a9da3);font-weight:600}.cm-add-workout{justify-self:start;border:0;border-bottom:1px solid var(--line,#ebebe8);background:transparent;color:var(--ink2,#6d7075);font:700 11px/1 var(--sans,sans-serif);padding:7px 0;cursor:pointer}.cm-no-plan,.cm-athlete-empty{padding:26px 0;border-block:1px solid var(--line,#ebebe8)}.cm-no-plan strong,.cm-athlete-empty h2{margin:0;font-family:var(--serif,serif);font-size:20px;font-weight:520}.cm-no-plan p,.cm-athlete-empty p{margin:7px 0 0;color:var(--ink3,#9a9da3);font-size:13px;line-height:1.5}",
      ".cm-athlete-analytics{display:grid;gap:22px}.cm-analytics-head{display:grid;gap:12px}.cm-analytics-headline{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.cm-analytics-head h2{margin:0;font-family:var(--serif,serif);font-size:22px;font-weight:520}.cm-range-control{display:flex;gap:14px;flex:0 0 auto}.cm-range-btn{border:0;border-bottom:1px solid transparent;background:transparent;color:var(--ink3,#9a9da3);padding:3px 0 6px;font:750 10px/1 var(--sans,sans-serif);cursor:pointer}.cm-range-btn.is-active{border-bottom-color:var(--red,#C0272D);color:var(--ink1,#141416)}.cm-range-btn:focus-visible{outline:2px solid var(--red,#C0272D);outline-offset:3px}.cm-analytics-summary{max-width:640px;margin:0;color:var(--ink2,#6d7075);font-size:14px;line-height:1.55}.cm-analytics-module{min-width:0;padding-top:17px;border-top:1px solid var(--line,#ebebe8)}.cm-analytics-kicker{display:block;color:var(--ink3,#9a9da3);font-size:10px;font-weight:750;letter-spacing:.065em;text-transform:uppercase}.cm-analytics-reading{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px 10px;margin-top:7px}.cm-analytics-value{font-family:var(--serif,serif);font-size:25px;font-weight:520;line-height:1.1}.cm-analytics-compare{color:var(--ink3,#9a9da3);font-size:11px}.cm-analytics-chart{display:block;width:100%;height:64px;margin-top:12px;overflow:visible}.cm-analytics-gridline{stroke:var(--line,#ebebe8);stroke-width:.7}.cm-analytics-line{fill:none;stroke:var(--red,#C0272D);stroke-width:1.35;vector-effect:non-scaling-stroke}.cm-analytics-point{fill:var(--red,#C0272D)}.cm-analytics-bars{display:flex;align-items:flex-end;gap:5px;height:58px;margin-top:12px}.cm-analytics-bar{flex:1;min-width:0;background:var(--line,#ebebe8);border-top:2px solid var(--red,#C0272D)}.cm-analytics-interpretation,.cm-analytics-unavailable{margin:10px 0 0;color:var(--ink2,#6d7075);font-size:12px;line-height:1.5}.cm-analytics-unavailable{color:var(--ink3,#9a9da3)}.cm-analytics-empty{padding:24px 0;border-block:1px solid var(--line,#ebebe8)}.cm-analytics-empty strong{display:block;font-family:var(--serif,serif);font-size:20px;font-weight:520}.cm-analytics-empty p{margin:7px 0 0;max-width:560px;color:var(--ink3,#9a9da3);font-size:13px;line-height:1.55}",
      ".cm-athlete-checkins{display:grid;gap:22px;max-width:720px}.cm-checkins-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.cm-checkins-head h2{margin:0;font-family:var(--serif,serif);font-size:22px;font-weight:520}.cm-checkins-latest{margin-top:5px;color:var(--ink3,#9a9da3);font-size:11px}.cm-checkin-section{padding-top:16px;border-top:1px solid var(--line,#ebebe8)}.cm-checkin-section:first-of-type{padding-top:0;border-top:0}.cm-checkin-rows{border-block:1px solid var(--line,#ebebe8)}.cm-checkin-row{display:grid;grid-template-columns:minmax(92px,.8fr) minmax(0,1fr);align-items:baseline;gap:12px;min-height:40px;padding:8px 0;border-bottom:1px solid var(--line,#ebebe8)}.cm-checkin-row:last-child{border-bottom:0}.cm-checkin-row span{color:var(--ink3,#9a9da3);font-size:11px}.cm-checkin-row strong{font-size:13px;text-align:right}.cm-checkin-note{margin:8px 0 0;padding-left:12px;border-left:2px solid var(--line,#ebebe8);color:var(--ink2,#6d7075);font-family:var(--serif,serif);font-size:16px;line-height:1.5}.cm-checkin-pain{padding:12px 0;border-block:1px solid rgba(165,42,47,.32)}.cm-checkin-pain .cm-analytics-kicker{color:var(--bad,#c0272d)}.cm-checkin-pain strong{display:block;margin-top:7px;color:var(--bad,#c0272d);font-size:14px}.cm-checkin-quiet{color:var(--ink3,#9a9da3);font-size:12px}.cm-subjective-trends{display:grid;gap:11px;margin-top:11px}.cm-subjective-row{display:grid;grid-template-columns:68px minmax(0,1fr);align-items:center;gap:10px}.cm-subjective-label{color:var(--ink2,#6d7075);font-size:11px}.cm-subjective-bars{display:flex;align-items:flex-end;gap:4px;height:24px}.cm-subjective-bar{flex:1;min-width:3px;max-width:18px;background:var(--ink3,#9a9da3);opacity:.38}.cm-subjective-bar.is-missing{height:1px!important;background:var(--line,#ebebe8);opacity:1}.cm-checkin-timeline{margin:8px 0 0;padding:0;list-style:none}.cm-checkin-timeline li{display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px;padding:11px 0;border-bottom:1px solid var(--line,#ebebe8)}.cm-checkin-timeline time{color:var(--ink3,#9a9da3);font-size:10px}.cm-checkin-timeline p{margin:0;color:var(--ink2,#6d7075);font-size:11px;line-height:1.5}.cm-checkin-timeline blockquote{margin:5px 0 0;color:var(--ink1,#141416);font-family:var(--serif,serif);font-size:13px;line-height:1.45}.cm-coaching-signals{margin:8px 0 0;padding:0;list-style:none}.cm-coaching-signals li{padding:7px 0;border-bottom:1px solid var(--line,#ebebe8);color:var(--ink2,#6d7075);font-size:12px;line-height:1.45}.cm-coaching-signals li:last-child{border-bottom:0}",
      ".cm-athlete-notes{display:grid;gap:20px;max-width:720px}.cm-notes-head h2{margin:0;font-family:var(--serif,serif);font-size:22px;font-weight:520}.cm-notes-private{margin:5px 0 0;color:var(--ink3,#9a9da3);font-size:11px}.cm-note-compose{display:grid;gap:9px;padding:14px 0;border-block:1px solid var(--line,#ebebe8)}.cm-note-compose textarea,.cm-note-edit textarea{width:100%;min-height:68px;box-sizing:border-box;resize:vertical;border:0;border-bottom:1px solid var(--line,#ebebe8);border-radius:0;background:transparent;color:inherit;padding:7px 0;font:13px/1.5 var(--sans,sans-serif)}.cm-note-compose textarea:focus,.cm-note-edit textarea:focus{outline:0;border-bottom-color:var(--ink2,#6d7075)}.cm-note-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px}.cm-note-action{border:0;border-bottom:1px solid transparent;background:transparent;color:var(--ink3,#9a9da3);padding:5px 0;font:700 10px/1 var(--sans,sans-serif);cursor:pointer}.cm-note-action:focus-visible{color:var(--ink1,#141416);border-bottom-color:currentColor}.cm-note-action--primary{color:var(--red,#C0272D)}.cm-note-action--danger{color:var(--bad,#c0272d)}.cm-note-action:disabled{cursor:default;opacity:.5}.cm-notes-error{min-height:14px;color:var(--bad,#c0272d);font-size:11px}.cm-note-group{min-width:0}.cm-note-group-title{display:block;padding-bottom:7px;border-bottom:1px solid var(--line,#ebebe8);color:var(--ink3,#9a9da3);font-size:10px;font-weight:750;letter-spacing:.065em;text-transform:uppercase}.cm-note-list{margin:0;padding:0;list-style:none}.cm-note-item{padding:14px 0;border-bottom:1px solid var(--line,#ebebe8)}.cm-note-item-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.cm-note-meta{color:var(--ink3,#9a9da3);font-size:10px;line-height:1.4}.cm-note-pin{color:var(--ink2,#6d7075);font-size:9px;font-weight:750;letter-spacing:.055em;text-transform:uppercase}.cm-note-body{margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink1,#141416);font-family:var(--serif,serif);font-size:15px;line-height:1.52}.cm-note-item-actions{display:flex;flex-wrap:wrap;gap:14px;margin-top:9px}.cm-note-edit{display:grid;gap:9px}.cm-notes-readonly,.cm-notes-unavailable{padding:12px 0;border-block:1px solid var(--line,#ebebe8);color:var(--ink3,#9a9da3);font-size:12px;line-height:1.5}.cm-notes-empty{padding:20px 0;border-bottom:1px solid var(--line,#ebebe8)}.cm-notes-empty strong{display:block;font-family:var(--serif,serif);font-size:19px;font-weight:520}.cm-notes-empty p{margin:6px 0 0;color:var(--ink3,#9a9da3);font-size:12px;line-height:1.5}",
      ".cm-note-confirm{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:18px;background:var(--backdrop,rgba(20,20,22,.45))}.cm-note-confirm-dialog{width:min(100%,360px);box-sizing:border-box;background:var(--bg,#fff);border:1px solid var(--line,#ebebe8);padding:20px}.cm-note-confirm-dialog h2{margin:0;font-family:var(--serif,serif);font-size:21px;font-weight:520}.cm-note-confirm-dialog p{margin:7px 0 18px;color:var(--ink3,#9a9da3);font-size:12px}.cm-note-confirm-actions{display:flex;justify-content:flex-end;gap:16px}",
      ".cm-athlete-head{display:grid;grid-template-columns:44px minmax(0,1fr) auto}.cm-athlete-head-actions{display:grid;justify-items:end;gap:8px}.cm-athlete-message{border:0;border-bottom:1px solid var(--line,#ebebe8);background:transparent;color:var(--ink2,#6d7075);padding:5px 0;font:750 10px/1 var(--sans,sans-serif);cursor:pointer}.cm-athlete-message:focus-visible{color:var(--ink1,#141416);border-bottom-color:currentColor}.cm-msg-directory{width:100%;max-width:720px;margin:0 auto;padding:16px 14px 96px;box-sizing:border-box}.cm-msg-directory h1{margin:0 0 16px;font-family:var(--serif,serif);font-size:22px;font-weight:520}.cm-msg-empty-directory{padding:40px 16px;text-align:center;color:var(--ink3,#9a9da3);font-size:13px}.cm-msg-empty-directory strong{display:block;margin-bottom:6px;color:var(--ink2,#6d7075);font-size:15px}.cm-msg-item{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;padding:12px 0;border:0;border-bottom:1px solid var(--line,#ebebe8);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.cm-msg-item-copy{min-width:0}.cm-msg-item-name{display:block;font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cm-msg-item-meta{display:block;margin-top:3px;color:var(--ink3,#9a9da3);font-size:11px}.cm-msg-item-arrow{color:var(--ink3,#9a9da3)}.cm-msg-thread{display:flex;flex:1;min-height:0;width:100%;max-width:720px;margin:0 auto;flex-direction:column}.cm-msg-thread-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;padding:13px 14px;border-bottom:1px solid var(--line,#ebebe8);flex:0 0 auto}.cm-msg-thread-back{min-width:44px;min-height:40px;border:0;background:transparent;color:var(--ink2,#6d7075);padding:0;text-align:left;font:700 12px/1 var(--sans,sans-serif);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cm-msg-thread-title{min-width:0}.cm-msg-thread-title strong{display:block;font-family:var(--serif,serif);font-size:18px;font-weight:520;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cm-msg-thread-title span{display:block;margin-top:2px;color:var(--ink3,#9a9da3);font-size:10px}.cm-msg-athlete-detail{border:0;background:transparent;color:var(--ink3,#9a9da3);padding:8px 0;font:700 10px/1 var(--sans,sans-serif);cursor:pointer}.cm-msg-log{display:flex;flex:1;min-height:0;overflow-y:auto;flex-direction:column;gap:12px;padding:18px 14px;-webkit-overflow-scrolling:touch}.cm-msg-bubble{max-width:82%;overflow-wrap:anywhere}.cm-msg-bubble p{margin:0;padding:9px 12px;border:1px solid var(--line,#ebebe8);font-size:13px;line-height:1.48;white-space:pre-wrap}.cm-msg-bubble time{display:block;margin-top:4px;color:var(--ink3,#9a9da3);font-size:9px}.cm-msg-bubble.is-coach{align-self:flex-end}.cm-msg-bubble.is-coach p{background:var(--ink1,#141416);border-color:var(--ink1,#141416);color:var(--bg,#fff)}.cm-msg-bubble.is-coach time{text-align:right}.cm-msg-bubble.is-athlete{align-self:flex-start}.cm-msg-thread-empty{margin:auto;padding:30px 14px;text-align:center}.cm-msg-thread-empty strong{display:block;font-family:var(--serif,serif);font-size:20px;font-weight:520}.cm-msg-thread-empty p{margin:6px 0 0;color:var(--ink3,#9a9da3);font-size:12px}.cm-msg-composer{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:9px;padding:10px 14px 12px;border-top:1px solid var(--line,#ebebe8);background:var(--bg,#fff);flex:0 0 auto}.cm-msg-composer textarea{width:100%;min-height:42px;max-height:112px;box-sizing:border-box;resize:none;border:1px solid var(--line,#ebebe8);border-radius:10px;background:var(--field,var(--card,#f6f6f4));color:inherit;padding:10px 11px;font:13px/1.4 var(--sans,sans-serif)}.cm-msg-send{min-width:54px;min-height:42px;border:0;border-radius:10px;background:var(--ink1,#141416);color:var(--bg,#fff);font:750 11px/1 var(--sans,sans-serif);cursor:pointer}.cm-msg-send:disabled{opacity:.5;cursor:default}.cm-msg-error{grid-column:1/-1;min-height:13px;color:var(--bad,#c0272d);font-size:10px}.cm-msg-loading{display:grid;gap:12px;padding:20px 14px}.cm-msg-loading span{display:block;width:72%;height:44px;border-radius:8px}.cm-msg-loading span:nth-child(even){justify-self:end;width:62%}",
      ".cm-msg-thread{height:100%;overflow:hidden;animation:cmMsgScreenIn var(--dur-base,200ms) var(--ease-standard,ease-out) both}.cm-msg-thread-head{min-height:58px;padding-block:9px;background:var(--bg,#fff)}.cm-msg-thread-back,.cm-msg-athlete-detail{min-height:40px}.cm-msg-thread-title strong{font-size:17px}.cm-msg-log{display:block;padding:12px 14px 8px;overscroll-behavior:contain;scroll-behavior:smooth}.cm-msg-log-inner{display:flex;min-height:100%;flex-direction:column;justify-content:flex-end;gap:7px}.cm-msg-date{align-self:center;margin:8px 0 5px;color:var(--ink3,#9a9da3);font-size:9px;font-weight:750;letter-spacing:.09em;text-transform:uppercase}.cm-msg-bubble{width:fit-content;max-width:76%;animation:cmMsgBubbleIn var(--dur-fast,140ms) var(--ease-standard,ease-out) both}.cm-msg-bubble p{padding:8px 11px;border-radius:14px 14px 14px 4px;background:var(--card2,var(--card,#f3f3f3));border-color:transparent;font-size:13px;line-height:1.45}.cm-msg-bubble.is-coach p{border-radius:14px 14px 4px 14px;background:var(--ink1,#141416)}.cm-msg-bubble time{margin-top:2px;padding:0 3px;font-size:8.5px}.cm-msg-bubble.is-pending{opacity:.58}.cm-msg-thread-empty{margin:auto 0 18px;padding:24px 14px;text-align:left}.cm-msg-thread-empty strong{font-size:17px}.cm-msg-thread-empty p{margin-top:4px}.cm-msg-composer{position:sticky;bottom:0;gap:8px;padding:9px 14px calc(9px + env(safe-area-inset-bottom));border-top-color:var(--line,#ebebe8);background:var(--bg,#fff)}.cm-msg-composer textarea{min-height:40px;max-height:96px;border-radius:15px;padding:10px 12px;overflow-y:auto}.cm-msg-composer textarea:focus{outline:2px solid rgba(179,41,45,.28);outline-offset:1px;border-color:var(--red,#C0272D)}.cm-msg-send{min-width:52px;min-height:40px;border-radius:12px}.cm-msg-send:disabled{opacity:.32}.cm-msg-error:empty{display:none}.cm-msg-loading{display:flex;min-height:100%;flex-direction:column;justify-content:flex-end;gap:9px;padding:18px 14px}.cm-msg-loading span{width:min(68%,280px);height:38px;border-radius:14px 14px 14px 4px}.cm-msg-loading span:nth-child(even){width:min(54%,220px);border-radius:14px 14px 4px 14px}@keyframes cmMsgScreenIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@keyframes cmMsgBubbleIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
      ".cm-athlete-page--ready{animation:cmWorkflowIn var(--dur-base,200ms) var(--ease-standard,ease-out) both}.cm-athlete-tabs{scroll-padding-inline:2px;overscroll-behavior-inline:contain}.cm-athlete-tab{min-height:44px}.cm-athlete-tab:focus-visible,.cm-athlete-back:focus-visible,.cm-athlete-message:focus-visible{outline:2px solid var(--red,#C0272D);outline-offset:2px}.cm-athlete-panel[aria-busy='true']{min-height:260px}.cm-panel-loading{display:grid;gap:10px;padding-top:4px}.cm-panel-loading span{display:block;height:11px}.cm-panel-loading span:first-child{width:34%;height:18px}.cm-panel-loading span:nth-child(2){width:78%}.cm-panel-loading span:nth-child(3){width:92%}.cm-panel-loading-row{height:58px!important;border-bottom:1px solid var(--line,#ebebe8)}.cm-status-footnote{margin:9px 0 0;color:var(--ink3,#9a9da3);font-size:10px;line-height:1.45}.cm-global-directory{width:100%;max-width:720px;margin:0 auto;padding:16px 14px 96px;box-sizing:border-box}.cm-global-head{margin-bottom:16px}.cm-global-head h1{margin:0;font-family:var(--serif,serif);font-size:22px;font-weight:520}.cm-global-head p{margin:6px 0 0;max-width:560px;color:var(--ink3,#9a9da3);font-size:12px;line-height:1.5}.cm-global-list{border-top:1px solid var(--line,#ebebe8)}.cm-global-athlete{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;min-height:68px;padding:12px 0;border:0;border-bottom:1px solid var(--line,#ebebe8);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.cm-global-athlete:focus-visible{outline:2px solid var(--red,#C0272D);outline-offset:2px}.cm-global-copy{min-width:0}.cm-global-name{display:block;font-size:14px;font-weight:750;overflow-wrap:anywhere}.cm-global-primary,.cm-global-meta{display:block;margin-top:3px;color:var(--ink2,#6d7075);font-size:11px;line-height:1.4;overflow-wrap:anywhere}.cm-global-meta{color:var(--ink3,#9a9da3);font-size:10px}.cm-global-empty{padding:26px 0;border-block:1px solid var(--line,#ebebe8);color:var(--ink3,#9a9da3);font-size:13px}.cm-note-compose textarea{min-height:44px;transition:min-height var(--dur-fast,140ms) var(--ease-standard,ease)}.cm-note-compose:focus-within textarea{min-height:68px}.cm-workout-overlay,.cm-note-confirm{animation:cmCoachBackdropIn var(--dur-fast,140ms) var(--ease-standard,ease-out) both}.cm-workout-dialog,.cm-note-confirm-dialog{animation:cmCoachDialogIn var(--dur-base,200ms) var(--ease-standard,ease-out) both}.cm-workout-dialog :focus-visible,.cm-note-confirm-dialog :focus-visible{outline:2px solid var(--red,#C0272D);outline-offset:2px}@keyframes cmWorkflowIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@keyframes cmCoachBackdropIn{from{opacity:0}to{opacity:1}}@keyframes cmCoachDialogIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
      ".cm-athlete-skeleton{display:grid;gap:18px}.cm-athlete-skel-back{width:112px;height:11px}.cm-athlete-skel-head{display:grid;grid-template-columns:44px minmax(0,1fr);gap:12px}.cm-athlete-skel-copy{display:grid;gap:7px}.cm-athlete-skel-name{width:min(180px,68%);height:24px}.cm-athlete-skel-sub{width:min(250px,88%);height:11px}.cm-athlete-skel-tabs{display:flex;gap:18px;padding:11px 0;border-bottom:1px solid var(--line,#ebebe8);overflow:hidden}.cm-athlete-skel-tabs span{flex:0 0 58px;height:10px}.cm-athlete-skel-section{display:grid;gap:9px;padding-top:14px;border-top:1px solid var(--line,#ebebe8)}.cm-athlete-skel-section span{height:10px}.cm-athlete-skel-section span:first-child{width:92px}.cm-athlete-skel-section span:nth-child(2){width:76%;height:15px}.cm-athlete-skel-section span:nth-child(3){width:92%}.cm-athlete-skel-rows{display:grid;border-top:1px solid var(--line,#ebebe8)}.cm-athlete-skel-row{height:54px;border-bottom:1px solid var(--line,#ebebe8)}",
      /* Shared Athlevo foundation overrides. Layout stays screen-owned; these
         rules align the coach workspace with app semantics and interaction. */
      ".cm-command,.cm-athlete-page,.cm-msg-directory,.cm-msg-thread,.cm-global-directory{color:var(--text-primary);font-family:var(--font-ui)}",
      ".cm-command-summary,.cm-row-meta,.cm-row-status,.cm-athlete-context,.cm-athlete-race,.cm-msg-item-meta,.cm-status-note,.cm-notes-private{color:var(--text-muted)}",
      ".cm-section-title,.cm-overview-kicker,.cm-detail-label,.cm-detail-section h3,.cm-analytics-kicker,.cm-note-group-title{font-family:var(--font-ui);font-size:var(--fs-micro);line-height:var(--lh-caption);font-weight:var(--fw-bold);letter-spacing:var(--ls-wide);text-transform:uppercase;color:var(--text-muted)}",
      ".cm-quiet-state{border-radius:var(--ui-radius-control);background:var(--surface-soft)}",
      ".cm-status-attention,.cm-roster-state.attention,.cm-workout-status.skipped,.cm-day-status.skipped,.cm-form-error,.cm-danger,.cm-notes-error,.cm-note-action--danger{color:var(--danger)}",
      ".cm-status-monitor,.cm-workout-status.modified,.cm-day-status.modified{color:var(--warning)}",
      ".cm-workout-status.completed,.cm-day-status.completed{color:var(--success)}",
      ".cm-workout-overlay,.cm-note-confirm{background:var(--backdrop)}",
      ".cm-workout-dialog{background:var(--surface-base);border-radius:var(--ui-radius-sheet) var(--ui-radius-sheet) 0 0;box-shadow:var(--elev-3)}",
      ".cm-note-confirm-dialog{background:var(--surface-base);border:1px solid var(--border-default);border-radius:var(--ui-radius-card);box-shadow:var(--elev-3)}",
      ".cm-field input,.cm-field textarea,.cm-field select,.cm-msg-composer textarea{min-height:var(--control-height);border-color:var(--border-default);border-radius:var(--ui-radius-control);background:var(--surface-raised);font-family:var(--font-ui)}",
      ".cm-field input:focus-visible,.cm-field textarea:focus-visible,.cm-field select:focus-visible,.cm-msg-composer textarea:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;border-color:var(--athlevo-red)}",
      ".cm-refresh:focus-visible,.cm-review:focus-visible,.cm-open-row:focus-visible,.cm-filter:focus-visible,.cm-athlete-back:focus-visible,.cm-athlete-tab:focus-visible,.cm-week-btn:focus-visible,.cm-workout-row:focus-visible,.cm-week-nav button:focus-visible,.cm-add-workout:focus-visible,.cm-note-action:focus-visible,.cm-athlete-message:focus-visible,.cm-msg-item:focus-visible,.cm-msg-thread-back:focus-visible,.cm-msg-athlete-detail:focus-visible,.cm-msg-send:focus-visible,.cm-global-athlete:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}",
      "@media(min-width:760px){.cm-athlete-page{padding-inline:24px}.cm-detail-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.cm-workout-dialog{align-self:center;border-radius:var(--ui-radius-card)}.cm-athlete-panel{padding-top:24px}.cm-athlete-analytics{max-width:720px}}",
      "@media(min-width:760px){.cm-roster-item .cm-row{padding-block:17px}}",
      "@media(min-width:600px){.cm-invite-overlay{align-items:center;padding:20px}.cm-invite-dialog{border-radius:22px}}",
      "@media(min-width:900px){body.coach-workspace-active .device,body.coach-loading .boot-shell{width:calc(100% - 48px);max-width:980px;border-radius:24px}.cm-command,.cm-command-skeleton{max-width:920px;padding-inline:24px}}",
      "@media(max-width:380px){.cm-command-head{gap:10px}.cm-command-head h1{font-size:24px}.cm-head-actions{gap:7px}.cm-invite-trigger{padding-inline:9px}.cm-invite-row{align-items:flex-start;display:grid;grid-template-columns:minmax(0,1fr) auto}.cm-row-status{max-width:78px}.cm-review{padding:8px 9px}.cm-athlete-page{padding-inline:14px}.cm-athlete-tabs{gap:17px}.cm-status-row{grid-template-columns:80px minmax(0,1fr)}.cm-day-row{grid-template-columns:42px minmax(0,1fr) auto;gap:8px}.cm-subjective-row{grid-template-columns:62px minmax(0,1fr)}.cm-checkin-timeline li{grid-template-columns:60px minmax(0,1fr)}.cm-note-item-head{display:grid;gap:3px}.cm-note-body{font-size:14px}.cm-athlete-head{grid-template-columns:40px minmax(0,1fr) auto}.cm-athlete-head .cm-avatar{width:40px;height:40px;flex-basis:40px}.cm-athlete-head-actions{gap:5px}.cm-msg-thread-head,.cm-msg-log,.cm-msg-composer{padding-inline:12px}}",
      ".cm-athlete-page--ready{animation:none}.cm-athlete-tabs{-webkit-overflow-scrolling:touch}",
      "@media(hover:hover) and (pointer:fine){.cm-refresh:hover{color:var(--ink1,var(--ink,#141416))}.cm-open-row:hover .cm-row-name{color:var(--red,#C0272D)}.cm-review:hover{border-color:var(--ink2,#6d7075)}.cm-note-action:hover,.cm-athlete-message:hover{color:var(--ink1,#141416);border-bottom-color:currentColor}}",
      "@media(prefers-reduced-motion:reduce){.cm-command--ready,.cm-athlete-page--ready,.cm-msg-thread,.cm-msg-bubble,.cm-workout-overlay,.cm-note-confirm,.cm-workout-dialog,.cm-note-confirm-dialog{animation:none}.cm-row-name,.cm-athlete-panel-content,.cm-athlete-tab-indicator,.cm-msg-log,.cm-note-compose textarea{transition:none;scroll-behavior:auto}.cm-athlete-panel-content{transform:none!important}}"
    ].join("");
    document.head.appendChild(style);
  }

  function trackCoach(event, props) {
    if (!analytics()) return;
    try { analytics().track(event, props || {}); } catch (e) {}
  }

  /* ═══════════════════════ MODE RESOLUTION ═════════════════════════ */

  /*
   * Resolve Coach Mode by calling the existing coaching_dashboard_roster
   * endpoint. If the server says role=coach/admin + returns data, we're in
   * coach_mode. If 403, athlete_mode. Otherwise, unknown with retry.
   *
   * This reuses the EXISTING server-authorized response — no new endpoint.
   */
  function isCurrentAuthContext(context, requestId) {
    var routeCurrent = !window.AthlevoAuthRoute || window.AthlevoAuthRoute.isCurrent(context);
    return routeCurrent && !!context &&
      context.userId === _authUserId &&
      context.generation === _authGeneration &&
      (requestId === undefined || requestId === _modeRequest);
  }

  async function resolveMode(context) {
    var requestId = ++_modeRequest;
    _resolving = true;
    try {
      var res = await api("roster", { expectedUserId: context.userId });
      if (!isCurrentAuthContext(context, requestId)) return "stale";
      if (res.status === 403) {
        _appMode = "athlete_mode";
        _role = (res.body && res.body.role) || "athlete";
        _resolving = false;
        return _appMode;
      }
      if (res.status === 401) {
        _appMode = "unknown";
        _resolving = false;
        return _appMode;
      }
      if (!res.ok) {
        _appMode = "unknown";
        _resolving = false;
        return _appMode;
      }
      // Server confirmed coach/admin role
      _role = (res.body && res.body.role) || "coach";
      if (_role === "coach" || _role === "admin") {
        _appMode = "coach_mode";
        _roster = (res.body && res.body.athletes) || [];
        _rosterError = null;
      } else {
        _appMode = "athlete_mode";
      }
      _resolving = false;
      return _appMode;
    } catch (e) {
      if (!isCurrentAuthContext(context, requestId)) return "stale";
      _appMode = "unknown";
      _resolving = false;
      return _appMode;
    }
  }

  /* ═══════════════════════ COACH SCREENS (DOM) ═════════════════════ */

  /*
   * Coach Today reuses the existing #screen-today element (the same one
   * athlete mode uses) so it inherits the correct position in the .device
   * flex layout.  The remaining four coach tabs get dynamically created
   * sections inserted before #tabbar — the same approach that already
   * works for Coach You, Train, Trends, and Messaging.
   */
  var COACH_SCREENS = [
    "screen-coach-messaging",
    "screen-coach-trends",
    "screen-coach-you"
  ];

  function ensureCoachScreens() {
    ensureCoachCommandStyles();
    if (document.getElementById("screen-coach-you")) return;  // already created
    // Mount inside the existing .device shell so coach screens share
    // the same viewport, safe-area layout, and bottom nav as athlete
    // screens.  Insert before #tabbar so they sit alongside the other
    // <section class="screen"> elements and never after the nav.
    var host = document.querySelector(".device");
    if (!host) return;                                   // safety — no shell yet
    var tabbar = document.getElementById("tabbar");      // insert point
    COACH_SCREENS.forEach(function (id) {
      var el = document.createElement("section");
      el.id = id;
      el.className = "screen";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", id.replace("screen-coach-", "Coach "));
      if (tabbar) {
        host.insertBefore(el, tabbar);
      } else {
        host.appendChild(el);
      }
    });
    // Remove any orphaned screen-coach-today from a previous init
    var orphan = document.getElementById("screen-coach-today");
    if (orphan) orphan.remove();
  }

  /* ═══════════════════════ NAVIGATION ══════════════════════════════ */

  var COACH_TABS = [
    { screen: "screen-today",            label: "Home",  icon: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5.5h4V20"/></svg>' },
    { screen: "screen-coach-messaging", label: "Messages",  icon: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>' },
    { screen: "screen-coach-trends",    label: "Analytics", icon: '<svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>' },
    { screen: "screen-coach-you",       label: "You",    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>' }
  ];

  function rewriteNavigation() {
    var tabbar = document.getElementById("tabbar");
    if (!tabbar) return;
    tabbar.innerHTML = "";
    // Coach workspace uses its own rectangular 5-tab layout
    tabbar.classList.remove("tabbar--capsule");
    // Coach Mode applies full-width edge-to-edge styling
    tabbar.style.cssText = "display:flex;position:absolute;left:0;right:0;bottom:0;width:100%;border-radius:0;transform:none;padding:10px 8px calc(14px + var(--athlevo-safe-bottom, env(safe-area-inset-bottom, 0px)));background:var(--nav-glass);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-top:1px solid var(--line);box-shadow:none";
    COACH_TABS.forEach(function (tab, i) {
      var btn = document.createElement("button");
      btn.className = "tab" + (i === 0 ? " on" : "");
      btn.setAttribute("data-screen", tab.screen);
      btn.setAttribute("onclick", "AthlevoCoachMode.go(this)");
      btn.innerHTML = tab.icon + "<span>" + tab.label + "</span>" + '<div class="dotmark"></div>';
      tabbar.appendChild(btn);
    });
    tabbar.style.display = "flex";
    rewriteRail();
    // Hide athlete profile avatar in coach workspace
    var avatarBtn = document.getElementById("profileAvatarBtn");
    if (avatarBtn) avatarBtn.style.display = "none";
  }

  /*
   * The desktop/tablet sidebar is a static copy of the athlete tabs. For a coach
   * it lists the same tabs as the phone bar (Home, Messages, Analytics, You) plus
   * Settings, so no item points at an athlete-only screen such as Calendar.
   */
  var _athleteRailHTML = null;

  function rewriteRail() {
    var rail = document.querySelector(".coach-rail-nav");
    if (!rail) return;
    if (_athleteRailHTML === null) _athleteRailHTML = rail.innerHTML;
    var settings = rail.querySelector('button[onclick="openSettings()"]');
    rail.innerHTML = COACH_TABS.map(function (tab, i) {
      return '<button class="coach-menu-action' + (i === 0 ? " on" : "") + '" type="button" data-screen="' + tab.screen +
        '" onclick="AthlevoCoachMode.go(this)">' + tab.icon.replace("<svg ", '<svg aria-hidden="true" ') + '<span>' + tab.label + '</span></button>';
    }).join("") + (settings ? settings.outerHTML : "");
  }

  function restoreAthleteRail() {
    var rail = document.querySelector(".coach-rail-nav");
    if (rail && _athleteRailHTML !== null) rail.innerHTML = _athleteRailHTML;
  }

  /* Restore the original athlete Today markup saved before coach render */
  function restoreAthleteToday() {
    if (_athleteTodayHTML === null) return;
    var el = document.getElementById("screen-today");
    if (el) el.innerHTML = _athleteTodayHTML;
    _athleteTodayHTML = null;
  }

  function restoreAthleteNavigation() {
    var tabbar = document.getElementById("tabbar");
    if (!tabbar) return;
    // Athlete navigation: 4-tab floating capsule (Home / Calendar / Coach / You)
    var ATHLETE_TABS = [
      { screen: "screen-today",    label: "Home",  icon: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5.5h4V20"/></svg>' },
      { screen: "screen-train",    label: "Calendar",  icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>' },
      { screen: "screen-coachai",  label: "Coach",  icon: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>' },
      { screen: "screen-trends",   label: "You", icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>' }
    ];
    tabbar.innerHTML = "";
    tabbar.classList.add("tabbar--capsule");
    // Clear Coach Mode's inline rectangular styles so capsule CSS takes over
    tabbar.style.cssText = "";
    ATHLETE_TABS.forEach(function (tab, i) {
      var btn = document.createElement("button");
      btn.className = "tab" + (i === 0 ? " on" : "");
      btn.setAttribute("data-screen", tab.screen);
      btn.setAttribute("onclick", "go(this)");
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", i === 0 ? "true" : "false");
      btn.setAttribute("aria-label", tab.label);
      btn.innerHTML = tab.icon + "<span>" + tab.label + "</span>";
      tabbar.appendChild(btn);
    });
    restoreAthleteRail();
    // Re-show profile avatar
    var avatarBtn = document.getElementById("profileAvatarBtn");
    if (avatarBtn) avatarBtn.style.display = "";
  }

  /* ═══════════════════════ WORKSPACE SWITCHER ═══════════════════════ */

  /* Workspace choice is deliberately session-only. Remove the legacy global
   * preference so no account or cold launch can passively enter Coach Mode. */
  function clearLegacyWorkspacePref() {
    try { localStorage.removeItem(LEGACY_WORKSPACE_KEY); } catch (e) {}
  }

  function roleCanUseCoachWorkspace(role) {
    return role === "coach" || role === "admin";
  }

  /*
   * The one client-side entry guard. _role and _appMode are populated only
   * after the protected roster endpoint resolves, so local/session storage
   * can choose a workspace preference but can never authorize one.
   */
  function canAccessCoachWorkspace() {
    return _appMode === "coach_mode" && roleCanUseCoachWorkspace(_role);
  }

  function clearWorkspaceOnLogout() {
    _modeRequest += 1;
    closeInviteDialog(false, true);
    clearLegacyWorkspacePref();
    suppressAthleteReadiness();
    _appMode = "unknown";
    _role = null;
    _coachName = null;
    _roster = [];
    _rosterLoading = false;
    _rosterError = null;
    _invites = [];
    _invitesLoaded = false;
    _inviteMutationId = null;
    _inviteSendInFlight = false;
    _inviteEmail = "";
    _search = "";
    _rosterFilter = "all";
    _athleteDetailId = null;
    _athleteDetail = null;
    _athleteDetailTab = "overview";
    _athleteWeekStart = null;
    _athleteAnalyticsRange = 4;
    _athleteCheckInsRange = 7;
    _editingCoachNoteId = null;
    _messageThreadCache = Object.create(null);
    _messageRequest += 1;
    _messageOrigin = "global";
    _messageReturnTab = "overview";
    _athleteDetailCache = Object.create(null);
    _athleteDetailRequest += 1;
    _athletePanelTransition = 0;
    if (_athletePanelTimer !== null) clearTimeout(_athletePanelTimer);
    _athletePanelTimer = null;
    _coachDashboardScrollTop = 0;
    _workspace = null;
    _athleteUIInitialized = false;
    _initialized = false;
    _resolving = false;
    _authUserId = null;
    _authGeneration = 0;
    document.body.classList.remove("coach-workspace-active", "coach-loading");
    var athleteSwitcher = document.getElementById("cmAthleteSwitcher");
    if (athleteSwitcher && athleteSwitcher.parentNode) athleteSwitcher.parentNode.removeChild(athleteSwitcher);
    restoreAthleteToday();
    restoreAthleteNavigation();
    COACH_SCREENS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /* Athlete readiness is never collected inside Coach Workspace. Closing a
   * prompt here also releases the inert state if workspace resolution wins a
   * race with a lifecycle-triggered morning-check evaluation. */
  function suppressAthleteReadiness() {
    if (typeof window.closeReadinessCheck !== "function") return;
    try { window.closeReadinessCheck({ immediate: true }); } catch (e) {}
  }

  function enforceAthleteWorkspaceFallback() {
    clearLegacyWorkspacePref();
    _workspace = "athlete_workspace";
    document.body.classList.remove("coach-workspace-active", "coach-loading");
    var athleteSwitcher = document.getElementById("cmAthleteSwitcher");
    if (athleteSwitcher && athleteSwitcher.parentNode) athleteSwitcher.parentNode.removeChild(athleteSwitcher);
    restoreAthleteToday();
    restoreAthleteNavigation();
    COACH_SCREENS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
  }

  /* Passive initialization always enters Athlete Workspace. Coach Workspace
   * can be entered only by an explicit, authorized current-session action. */
  function resolveWorkspace() {
    clearLegacyWorkspacePref();
    return "athlete_workspace";
  }

  /*
   * Activate Coach Workspace — show coach screens, hide athlete screens.
   * Idempotent: calling when already in coach_workspace is a no-op.
   */
  function activateCoachWorkspace() {
    if (!canAccessCoachWorkspace()) {
      enforceAthleteWorkspaceFallback();
      if (typeof window.showScreen === "function") window.showScreen("screen-today");
      return false;
    }
    document.body.classList.add("coach-workspace-active");
    suppressAthleteReadiness();
    if (_workspace === "coach_workspace") return;
    var fromWs = _workspace;
    _workspace = "coach_workspace";

    // Hide athlete screens that Coach Mode replaces
    var athleteOnly = ["screen-coachai", "screen-train", "screen-trends", "screen-you"];
    athleteOnly.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = "none";
    });

    ensureCoachScreens();
    // Show coach-only screens
    COACH_SCREENS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = "";
    });

    rewriteNavigation();

    // Show Coach Today
    var hasImmediateMotion = window.AthlevoAppMotion && typeof window.AthlevoAppMotion.showImmediately === "function";
    var todayEl = hasImmediateMotion
      ? window.AthlevoAppMotion.showImmediately("screen-today")
      : document.getElementById("screen-today");
    if (!hasImmediateMotion) {
      document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
      if (todayEl) todayEl.classList.add("active");
    }
    renderCoachToday();
    if (!_invitesLoaded) loadInvites(true);

    if (fromWs) {
      trackCoach("workspace_switched", {
        from_workspace: fromWs,
        to_workspace: "coach_workspace",
        source_surface: "workspace_switcher"
      });
    }
    return true;
  }

  /*
   * Activate Athlete Workspace — restore athlete screens, hide coach screens.
   * Triggers the athlete data load if not yet done.
   */
  function activateAthleteWorkspace() {
    document.body.classList.remove("coach-workspace-active");
    if (_workspace === "athlete_workspace") return;
    var fromWs = _workspace;
    _workspace = "athlete_workspace";

    // Hide coach-only screens
    COACH_SCREENS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = "none";
    });

    // Show athlete screens
    var athleteOnly = ["screen-coachai", "screen-train", "screen-trends", "screen-you"];
    athleteOnly.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = "";
    });

    // Restore athlete Today if coach had overwritten it
    restoreAthleteToday();
    restoreAthleteNavigation();

    // Show athlete Home (default athlete landing)
    var hasImmediateMotion = window.AthlevoAppMotion && typeof window.AthlevoAppMotion.showImmediately === "function";
    var homeEl = hasImmediateMotion
      ? window.AthlevoAppMotion.showImmediately("screen-today")
      : document.getElementById("screen-today");
    if (!hasImmediateMotion) {
      document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
      if (homeEl) homeEl.classList.add("active");
    }
    // The restored Home markup is a static snapshot — reload today's plan into it.
    if (typeof window.refreshTodayAfterPlanChange === "function") {
      window.refreshTodayAfterPlanChange("screen-enter").catch(function () {});
    }

    // Initialize athlete UI data if not already done
    if (!_athleteUIInitialized) {
      _athleteUIInitialized = true;
      // Call the global athlete data loader (async, best-effort)
      if (window.AthlevoBrain && typeof window.AthlevoBrain.refreshAthleteUI === "function") {
        window.AthlevoBrain.refreshAthleteUI().catch(function () {});
      }
      if (window.AthlevoSyncStatus && typeof window.AthlevoSyncStatus.refresh === "function") {
        window.AthlevoSyncStatus.refresh();
      }
    }

    // Inject the workspace switcher into athlete You screen
    injectAthleteYouSwitcher();

    if (fromWs) {
      trackCoach("workspace_switched", {
        from_workspace: fromWs,
        to_workspace: "athlete_workspace",
        source_surface: "workspace_switcher"
      });
    }
  }

  /*
   * Inject a "Switch to Coach Workspace" button into the athlete You screen.
   * Only for confirmed coach/admin users. Idempotent — checks for existing.
   */
  function injectAthleteYouSwitcher() {
    var youEl = document.getElementById("screen-you");
    if (!youEl) return;
    if (!canAccessCoachWorkspace()) {
      var stale = youEl.querySelector("#cmAthleteSwitcher");
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      return;
    }
    if (youEl.querySelector("#cmAthleteSwitcher")) return; // already injected

    var preferencesHeading = document.getElementById("youPreferencesHeading");
    if (!preferencesHeading || preferencesHeading.parentNode !== youEl) return;

    var switcher = document.createElement("div");
    switcher.id = "cmAthleteSwitcher";
    switcher.innerHTML =
      '<div class="pad"><div class="section-title serif">Workspace</div></div>' +
      '<div class="rowlink" id="cmSwitchToCoach" style="cursor:pointer">' +
        '<div><b>Switch to Coach Workspace</b><small>Open your coaching tools.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" id="cmOpenDashboard" style="cursor:pointer">' +
        '<div><b>Open My Athletes</b><small>View and manage your athletes.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md"></div>';

    youEl.insertBefore(switcher, preferencesHeading);

    document.getElementById("cmSwitchToCoach").addEventListener("click", function () {
      trackCoach("workspace_switcher_viewed", { source_surface: "athlete_you" });
      activateCoachWorkspace();
    });

    document.getElementById("cmOpenDashboard").addEventListener("click", function () {
      activateCoachWorkspace();
    });
  }

  /*
   * Render the workspace switcher inside the Coach You tab.
   * Called by renderCoachYou (adds it to the coach profile screen).
   */
  function renderCoachYouSwitcher() {
    return '<button id="cmSwitchToAthlete" style="width:100%;padding:14px;border:1px solid var(--info,#3970c8);border-radius:var(--ui-radius-control,10px);background:transparent;color:var(--info,#3970c8);font-size:14px;font-weight:600;cursor:pointer;margin-bottom:12px;">' +
      'Switch to My Training' +
    '</button>';
  }

  /* Coach tab switching — replaces the athlete `go()` for coach screens */
  function coachGo(btn) {
    var screenId = btn.dataset.screen;
    if (screenId === "screen-coach-messaging") {
      _messageOrigin = "global";
      _messageRequest += 1;
    }
    var screenEl = document.getElementById(screenId);
    // The desktop rail and the phone tab bar both call this; the tab bar owns the
    // sliding indicator and the rail follows it (selectAppTab keeps them in sync).
    btn = document.querySelector('#tabbar .tab[data-screen="' + screenId + '"]') || btn;
    if (window.AthlevoAppMotion) {
      window.AthlevoAppMotion.selectTab(btn, true);
      window.AthlevoAppMotion.transitionTo(screenId);
    } else {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("on"); });
      btn.classList.add("on");
      document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
      if (screenEl) screenEl.classList.add("active");
    }
    if (screenEl && screenId !== "screen-today") screenEl.scrollTop = 0;

    // Analytics
    var TAB_EVENTS = {
      "screen-today": "coach_today_viewed",
      "screen-coach-messaging": "coach_tab_viewed",
      "screen-coach-trends": "coach_trends_viewed",
      "screen-coach-you": "coach_you_viewed"
    };
    var TAB_NAMES = {
      "screen-today": "today",
      "screen-coach-messaging": "coach",
      "screen-coach-trends": "trends",
      "screen-coach-you": "you"
    };
    var evName = TAB_EVENTS[screenId];
    if (evName) {
      trackCoach(evName, {
        coach_mode: "coach_mode",
        source_surface: "coach_navigation",
        tab_name: TAB_NAMES[screenId] || "unknown"
      });
    }

    // Render content on demand
    if (screenId === "screen-today") renderCoachToday();
    if (screenId === "screen-coach-messaging") renderCoachMessaging();
    if (screenId === "screen-coach-trends") renderCoachTrends();
    if (screenId === "screen-coach-you") renderCoachYou();
  }

  /* ═══════════════════════ COACH TODAY ═════════════════════════════ */

  function renderCoachToday() {
    var el = document.getElementById("screen-today");
    if (!el) return;

    // Save the athlete Today markup on first coach render so it can be
    // restored if the user logs out or switches back to athlete mode.
    if (_athleteTodayHTML === null) {
      _athleteTodayHTML = el.innerHTML;
    }

    ensureCoachCommandStyles();
    // Athlete context remains authoritative until the coach explicitly goes
    // back to the dashboard or opens another athlete. Returning to Today from
    // another top-level tab therefore restores the cached athlete workspace.
    if (_athleteDetailId) {
      if (_athleteDetail) renderAthletePage();
      else renderAthletePageLoading();
      return;
    }
    if (_rosterLoading) {
      el.innerHTML = renderCoachSkeleton();
      return;
    }

    var sorted = sortRoster(_roster);
    var needAttention = sorted.filter(function (a) {
      return a.attention_status === "needs_attention" || a.attention_status === "monitor";
    }).length;
    var trainingToday = sorted.filter(function (a) { return Boolean(a.today_planned); }).length;
    var liveSummary = !sorted.length ? "No athletes are currently assigned."
      : needAttention ? needAttention + " athlete" + (needAttention === 1 ? " needs" : "s need") + " review today."
      : trainingToday ? trainingToday + " athlete" + (trainingToday === 1 ? " is" : "s are") + " training today."
      : "No athletes need attention right now.";
    var rosterSizeClass = sorted.length > 0 && sorted.length <= 3 ? " cm-command--small-roster" : "";

    var content =
      '<div class="cm-command cm-command--ready cm-command--roster' + rosterSizeClass + '">' +
        '<header class="cm-command-head">' +
          '<div><h1>My Athletes</h1><p class="cm-command-summary" aria-live="polite">' + esc(liveSummary) + '</p></div>' +
          '<div class="cm-head-actions">' +
            (_role === "admin" ? '<button type="button" class="cm-invite-trigger" id="cmAddCoach">Add Coach</button>' : '') +
            '<button type="button" class="cm-invite-trigger" id="cmInviteAthlete">Invite Athlete</button></div>' +
        '</header>';

    if (_rosterError) {
      content += '<div class="cm-error">' + esc(_rosterError) + '<br><button type="button" class="cm-review" id="cmRetry">Try again</button></div></div>';
      el.innerHTML = content;
      bindCoachTodayEvents(el);
      return;
    }

    if (!sorted.length) {
      content += '<section class="cm-empty"><strong>No athletes assigned yet.</strong><p>Invite an athlete to connect them to your coaching roster.</p></section>' + renderPendingInvitations() + '</div>';
      el.innerHTML = content;
      bindCoachTodayEvents(el);
      return;
    }

    content += renderRosterTable(sorted) + renderPendingInvitations() + '</div>';

    el.innerHTML = content;
    bindCoachTodayEvents(el);
  }

  function renderCoachSkeleton() {
    var rows = [0, 1, 2, 3].map(function () {
      return '<div class="cm-skel-roster-row"><span class="skel cm-skel-avatar"></span><span class="cm-skel-roster-copy"><span class="skel cm-skel-name"></span><span class="skel cm-skel-context"></span><span class="skel cm-skel-status"></span></span><span class="skel cm-skel-chevron"></span></div>';
    }).join("");
    return '<div class="cm-command-skeleton cm-command-skeleton--roster" role="status" aria-label="Loading your athletes">' +
      '<div class="cm-skel-head"><div class="cm-skel-stack"><span class="skel cm-skel-line cm-skel-line--title"></span><span class="skel cm-skel-line cm-skel-line--sub"></span></div><span class="skel cm-skel-refresh"></span></div>' +
      '<section class="cm-skel-section cm-skel-section--roster"><span class="skel cm-skel-search"></span><div class="cm-skel-roster">' + rows + '</div></section>' +
    '</div>';
  }

  function sectionHeader(title, count) {
    return '<div class="cm-section-head"><h2 class="cm-section-title">' + esc(title) + '</h2>' +
      (count == null ? '' : '<span class="cm-section-count">' + esc(count) + '</span>') + '</div>';
  }

  function renderPendingInvitations() {
    if (!_invitesLoaded) return "";
    var pending = _invites.filter(function (invite) { return invite && invite.status === "pending"; });
    if (!pending.length) return "";
    return '<section class="cm-section cm-pending-invites">' + sectionHeader("Pending Invitations", pending.length) +
      '<div class="cm-list">' + pending.map(function (invite) {
        var busy = _inviteMutationId === invite.id;
        return '<div class="cm-invite-row"><div class="cm-invite-copy"><span class="cm-invite-email">' + esc(invite.email) + '</span><span class="cm-invite-sent">' + esc(inviteAge(invite.created_at)) + '</span></div>' +
          '<div class="cm-invite-row-actions"><button type="button" data-resend-invite="' + esc(invite.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Working…' : 'Resend') + '</button>' +
          '<button type="button" class="danger" data-revoke-invite="' + esc(invite.id) + '"' + (busy ? ' disabled' : '') + '>Revoke</button></div></div>';
      }).join("") + '</div></section>';
  }

  /* ─── My Athletes: the coach's Home. One row per athlete, V.O2-style. ─── */

  var MANILA = "Asia/Manila";

  function shortDate(iso) {
    var t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    try { return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: MANILA }); }
    catch (e) { return String(iso).slice(0, 10); }
  }

  function raceDaysAway(a) {
    if (!a.target_date) return null;
    var t = Date.parse(String(a.target_date).slice(0, 10) + "T00:00:00Z");
    return Number.isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : null;
  }

  function cell(label, className, inner) {
    return '<td class="' + className + '" data-label="' + esc(label) + '">' + inner + '</td>';
  }

  function dash() { return '<span class="cm-cell-empty">–</span>'; }

  function rosterWeekCell(a) {
    if (a.adherence_pct == null) return dash();
    var pct = Math.max(0, Math.min(100, a.adherence_pct));
    return '<span class="cm-week-pct">' + esc(a.adherence_pct) + '%</span>' +
      '<span class="cm-week-bar" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' +
      '<span class="cm-cell-sub">of planned time</span>';
  }

  function rosterLastWorkoutCell(a) {
    var summary = latestActivitySummary(a);
    if (!summary) return dash();
    return '<span class="cm-cell-main">' + esc(summary) + '</span><span class="cm-cell-sub">' + esc(shortDate(a.latest_activity.date)) + '</span>';
  }

  function rosterTodayCell(a) {
    var s = a.today_planned;
    if (!s) return '<span class="cm-cell-empty">Nothing planned</span>';
    var amount = s.duration_minutes != null ? s.duration_minutes + " min" : s.distance_km != null ? s.distance_km + " km" : "";
    var status = s.execution_status && s.execution_status !== "pending" ? s.execution_status : "";
    return '<span class="cm-cell-main">' + esc(s.title || "Planned session") + '</span>' +
      (amount || status ? '<span class="cm-cell-sub' + (status === "skipped" ? " cm-status-attention" : status === "modified" ? " cm-status-monitor" : "") + '">' +
        esc([amount, status ? status.replace(/^./, function (c) { return c.toUpperCase(); }) : ""].filter(Boolean).join(" · ")) + '</span>' : '');
  }

  function rosterRaceCell(a) {
    var days = raceDaysAway(a);
    if (!a.target_event || days == null || days < 0) return dash();
    return '<span class="cm-cell-main">' + esc(a.target_event) + '</span><span class="cm-cell-sub">' + esc(shortDate(a.target_date)) + ' · ' + esc(days) + (days === 1 ? ' day' : ' days') + '</span>';
  }

  function rosterStatusCell(a) {
    var reasons = a.attention_reason_keys || [];
    var needs = a.attention_status === "needs_attention";
    var monitor = a.attention_status === "monitor";
    var label = needs ? "Needs attention" : monitor ? "Monitor" : a.attention_status === "on_track" ? "On track" : "No recent data";
    var cls = needs ? "cm-status-attention" : monitor ? "cm-status-monitor" : "";
    return '<span class="cm-cell-main ' + cls + '">' + esc(label) + '</span>' +
      ((needs || monitor) && reasons.length ? '<span class="cm-cell-sub">' + esc(attentionReasonLabel(reasons[0])) + '</span>' : '');
  }

  function rosterRow(a) {
    var id = esc(a.athlete_id);
    return '<tr class="cm-roster-row cm-roster-item" data-open-athlete="' + id + '" tabindex="0" aria-label="Open ' + esc(a.name) + '\u2019s training calendar">' +
      '<td class="cm-col-athlete"><div class="cm-athlete-cell"><span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span>' +
        '<span class="cm-roster-id"><span class="cm-row-name">' + esc(a.name) + '</span>' +
        '<span class="cm-row-primary">' + esc(athleteContext(a)) + '</span>' +
        '<span class="cm-roster-links"><button type="button" data-athlete-calendar="' + id + '">calendar</button><span aria-hidden="true"> / </span><button type="button" data-athlete-message="' + id + '">message</button></span></span></div></td>' +
      cell("This week", "cm-col-week", rosterWeekCell(a)) +
      cell("Last workout", "cm-col-last", rosterLastWorkoutCell(a)) +
      cell("Today", "cm-col-today", rosterTodayCell(a)) +
      cell("Race", "cm-col-race", rosterRaceCell(a)) +
      cell("Last active", "cm-col-active", a.last_active_at ? '<span class="cm-cell-main">' + esc(fmtLastActive(a.last_active_at)) + '</span>' : dash()) +
      cell("Status", "cm-col-status", rosterStatusCell(a)) +
    '</tr>';
  }

  function renderRosterTable(sorted) {
    return '<section class="cm-section cm-section--roster">' +
      '<input class="cm-search" id="cmRosterSearch" type="search" placeholder="Search athletes" aria-label="Search athletes" value="' + esc(_search) + '" />' +
      '<div class="cm-filter-row" aria-label="Filter athletes">' + [
        ["all", "All"], ["attention", "Needs Attention"], ["training", "Training Today"], ["race", "Race Soon"]
      ].map(function (item) { return '<button type="button" class="cm-filter' + (_rosterFilter === item[0] ? ' is-active' : '') + '" data-roster-filter="' + item[0] + '">' + item[1] + '</button>'; }).join("") + '</div>' +
      '<div class="cm-table-wrap"><table class="cm-roster-table"><thead><tr>' +
        '<th class="cm-col-athlete" scope="col">Athlete</th><th class="cm-col-week" scope="col">This week</th><th class="cm-col-last" scope="col">Last workout</th>' +
        '<th class="cm-col-today" scope="col">Today</th><th class="cm-col-race" scope="col">Race</th><th class="cm-col-active" scope="col">Last active</th><th class="cm-col-status" scope="col">Status</th>' +
      '</tr></thead><tbody id="cmRosterList">' + renderRosterList(sorted, _search, _rosterFilter) + '</tbody></table></div></section>';
  }

  function renderRosterList(sorted, query, filter) {
    var q = (query || "").toLowerCase().trim();
    var visible = sorted.filter(function (a) {
      var textMatches = !q || String(a.name || "").toLowerCase().indexOf(q) !== -1;
      var raceDays = raceDaysAway(a);
      var filterMatches = filter === "attention" ? (a.attention_status === "needs_attention" || a.attention_status === "monitor")
        : filter === "training" ? Boolean(a.today_planned)
        : filter === "race" ? (raceDays != null && raceDays >= 0 && raceDays <= 21)
        : true;
      return textMatches && filterMatches;
    });
    if (!visible.length) {
      return '<tr class="cm-roster-none"><td colspan="7">' + (q ? 'No athletes match \u201c' + esc(q) + '\u201d.' : filter && filter !== "all" ? 'No athletes in this view.' : 'No athletes assigned yet.') + '</td></tr>';
    }
    return visible.map(rosterRow).join("");
  }

  /* Rows open the athlete's training calendar; the two small links skip to it or to messages. */
  function bindRosterRows(container) {
    container.querySelectorAll("[data-open-athlete]").forEach(function (row) {
      function open() {
        openCoachAthletePage(row.getAttribute("data-open-athlete"), "training");
        trackCoach("coach_today_athlete_opened", { coach_mode: "coach_mode", source_surface: "coach_roster" });
      }
      row.addEventListener("click", open);
      row.addEventListener("keydown", function (event) {
        if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); }
      });
    });
    container.querySelectorAll("[data-athlete-calendar]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.stopPropagation();
        openCoachAthletePage(link.getAttribute("data-athlete-calendar"), "training");
      });
    });
    container.querySelectorAll("[data-athlete-message]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.stopPropagation();
        openAthleteMessaging(link.getAttribute("data-athlete-message"), "global", "overview");
      });
    });
  }

  function removeInviteOverlay(overlay) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function closeInviteDialog(resetEmail, immediate) {
    var overlay = document.getElementById("cmInviteOverlay");
    if (resetEmail) _inviteEmail = "";
    if (overlay && overlay.getAttribute("data-athlevo-sheet") === "invite" &&
        window.AthlevoSheet) {
      window.AthlevoSheet.close(overlay, {
        immediate: immediate === true,
        onAfterClose: function () { removeInviteOverlay(overlay); }
      });
      return;
    }
    removeInviteOverlay(overlay);
    document.removeEventListener("keydown", handleInviteEscape);
    if (_invitePreviousFocus && typeof _invitePreviousFocus.focus === "function") {
      try { _invitePreviousFocus.focus(); } catch (e) {}
    }
    _invitePreviousFocus = null;
  }

  function handleInviteEscape(event) {
    if (event.key !== "Escape" || _inviteSendInFlight) return;
    event.preventDefault();
    closeInviteDialog(false);
  }

  function mountInviteDialog(html) {
    // Revoke remains on the existing confirmation path in Phase 3A.
    closeInviteDialog(false, true);
    _invitePreviousFocus = document.activeElement;
    var overlay = document.createElement("div");
    overlay.id = "cmInviteOverlay";
    overlay.className = "cm-invite-overlay";
    overlay.innerHTML = '<section class="cm-invite-dialog" role="dialog" aria-modal="true" aria-labelledby="cmInviteTitle">' + html + '</section>';
    document.body.appendChild(overlay);
    document.addEventListener("keydown", handleInviteEscape);
    return overlay;
  }

  function mountInviteSheet(html, focusSelector) {
    closeInviteDialog(false, true);
    var overlay = document.createElement("div");
    overlay.id = "cmInviteOverlay";
    overlay.className = "cm-invite-overlay";
    overlay.setAttribute("data-athlevo-sheet", "invite");
    overlay.innerHTML = '<section class="cm-invite-dialog" role="dialog" aria-modal="true" aria-labelledby="cmInviteTitle">' + html + '</section>';
    document.body.appendChild(overlay);
    window.AthlevoSheet.open({
      root: overlay,
      sheet: ".cm-invite-dialog",
      draggable: true,
      initialFocus: focusSelector || "#cmJoinLink",
      closeOnEscape: true,
      closeOnBackdrop: true,
      fallbackFocus: "#cmInviteAthlete",
      onRequestClose: function () {
        if (_inviteSendInFlight) return false;
        closeInviteDialog(false);
        return false;
      },
      onAfterClose: function () { removeInviteOverlay(overlay); }
    });
    return overlay;
  }

  function bindJoinLink(overlay) {
    var field = overlay.querySelector("#cmJoinLink");
    var copy = overlay.querySelector("#cmJoinCopy");
    var share = overlay.querySelector("#cmJoinShare");
    var fresh = overlay.querySelector("#cmJoinNew");
    var error = overlay.querySelector("#cmJoinError");
    var url = "";
    function show(body) {
      url = body && body.url || "";
      field.value = url || "Link unavailable";
      copy.disabled = !url;
      if (share && url && navigator.share) share.hidden = false;
      error.textContent = url ? "" : (body && body.error || "Your invite link could not be loaded. Try again.");
    }
    async function load(rotate) {
      copy.disabled = true;
      var result = await providerApi("coaching_join_link", rotate ? { rotate: true } : {});
      show(result.ok ? result.body : { error: result.body && result.body.error });
    }
    copy.addEventListener("click", async function () {
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {
        field.focus(); field.select();
        try { document.execCommand("copy"); } catch (e2) {}
      }
      copy.textContent = "Copied";
      setTimeout(function () { copy.textContent = "Copy link"; }, 2000);
    });
    if (share) share.addEventListener("click", function () {
      if (!url || !navigator.share) return;
      navigator.share({ title: "Train with me on Athlevo", text: "Join my coaching roster on Athlevo:", url: url }).catch(function () {});
    });
    fresh.addEventListener("click", function () {
      if (!window.confirm("Make a new link? The current link will stop working.")) return;
      load(true);
    });
    field.addEventListener("focus", function () { field.select(); });
    load(false);
  }

  function openAddCoachDialog() {
    var overlay = mountInviteSheet(
      '<h2 id="cmInviteTitle">Add Coach</h2>' +
      '<p>Make someone a coach. They need to have signed up to Athlevo first, with this email.</p>' +
      '<form class="cm-invite-form" id="cmCoachForm"><label for="cmCoachEmail">Coach email</label>' +
      '<input id="cmCoachEmail" type="email" inputmode="email" autocomplete="off" placeholder="coach@email.com" required>' +
      '<p class="cm-invite-form-error" id="cmCoachError" role="status" aria-live="polite"></p>' +
      '<div class="cm-invite-dialog-actions"><button class="primary" id="cmCoachSave" type="submit">Make coach</button>' +
      '<button id="cmCoachCancel" type="button">Cancel</button></div></form>',
      "#cmCoachEmail"
    );
    var input = overlay.querySelector("#cmCoachEmail");
    var error = overlay.querySelector("#cmCoachError");
    overlay.querySelector("#cmCoachCancel").addEventListener("click", function () { closeInviteDialog(false); });
    overlay.querySelector("#cmCoachForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      var button = overlay.querySelector("#cmCoachSave");
      if (!input.checkValidity()) { error.textContent = "Enter a valid email."; return; }
      button.disabled = true;
      button.textContent = "Saving…";
      error.textContent = "";
      var grantBody = { role: "coach" };
      grantBody.email = String(input.value || "").trim();
      var result = await providerApi("coaching_grant_coach", grantBody);
      if (!result.ok) {
        error.textContent = result.body && result.body.error || "Coach access could not be updated.";
        button.disabled = false;
        button.textContent = "Make coach";
        return;
      }
      closeInviteDialog(false);
      if (typeof window.toast === "function") window.toast("Coach access added. They can sign in as a coach now.");
    });
  }

  function openInviteDialog() {
    var existingOverlay = document.getElementById("cmInviteOverlay");
    if (existingOverlay && existingOverlay.getAttribute("data-athlevo-sheet") === "invite" &&
        window.AthlevoSheet) {
      var existingPhase = window.AthlevoSheet.phase(existingOverlay);
      if (existingPhase === "opening" || existingPhase === "open") return;
      if (existingPhase === "closing") {
        window.AthlevoSheet.open({ root: existingOverlay });
        return;
      }
    }
    var overlay = mountInviteSheet(
      '<h2 id="cmInviteTitle">Invite Athlete</h2>' +
      '<p>Send this link to your athlete on Messenger, WhatsApp or text. When they sign up and confirm, they join your roster.</p>' +
      '<div class="cm-join" id="cmJoin"><label for="cmJoinLink">Your invite link</label>' +
      '<input id="cmJoinLink" type="text" readonly value="Getting your link…" aria-live="polite">' +
      '<p class="cm-invite-form-error" id="cmJoinError" role="status" aria-live="polite"></p>' +
      '<div class="cm-invite-dialog-actions"><button class="primary" id="cmJoinCopy" type="button" disabled>Copy link</button>' +
      '<button id="cmJoinShare" type="button" hidden>Share…</button>' +
      '<button id="cmJoinNew" type="button" class="cm-join-new">Make a new link (the old one stops working)</button></div></div>' +
      '<p class="cm-invite-or">Or invite by email</p>' +
      '<form class="cm-invite-form" id="cmInviteForm"><label for="cmInviteEmail">Email</label>' +
      '<input id="cmInviteEmail" name="email" type="email" inputmode="email" autocomplete="email" placeholder="athlete@email.com" value="' + esc(_inviteEmail) + '" required>' +
      '<p class="cm-invite-form-error" id="cmInviteError" role="status" aria-live="polite"></p>' +
      '<div class="cm-invite-dialog-actions"><button class="primary" id="cmInviteSend" type="submit">Send Invite</button><button id="cmInviteCancel" type="button">Cancel</button></div></form>'
    );
    var input = overlay.querySelector("#cmInviteEmail");
    bindJoinLink(overlay);
    overlay.querySelector("#cmInviteCancel").addEventListener("click", function () {
      _inviteEmail = input.value;
      closeInviteDialog(false);
    });
    overlay.querySelector("#cmInviteForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      if (_inviteSendInFlight) return;
      _inviteEmail = String(input.value || "").trim();
      var error = overlay.querySelector("#cmInviteError");
      var button = overlay.querySelector("#cmInviteSend");
      if (!input.checkValidity()) {
        error.textContent = "Enter a valid athlete email.";
        input.focus();
        return;
      }
      _inviteSendInFlight = true;
      button.disabled = true;
      button.textContent = "Sending…";
      error.textContent = "";
      var result = await inviteApi("create", { method: "POST", body: { email: _inviteEmail } });
      _inviteSendInFlight = false;
      if (!result.ok) {
        error.textContent = result.body && result.body.error || "The invitation could not be sent. Please try again.";
        button.disabled = false;
        button.textContent = "Send Invite";
        return;
      }
      closeInviteDialog(true);
      if (typeof window.toast === "function") window.toast("Invitation sent.");
      await loadInvites(true);
    });
  }

  async function loadInvites(renderAfter) {
    var result = await inviteApi("list");
    if (result.ok) {
      _invites = result.body && Array.isArray(result.body.invites) ? result.body.invites : [];
      _invitesLoaded = true;
    }
    if (renderAfter && _workspace === "coach_workspace") renderCoachToday();
    return result;
  }

  async function resendInvite(inviteId, button) {
    if (_inviteMutationId) return;
    _inviteMutationId = inviteId;
    if (button) { button.disabled = true; button.textContent = "Sending…"; }
    var result = await inviteApi("resend", { method: "POST", body: { invite_id: inviteId } });
    _inviteMutationId = null;
    if (!result.ok) {
      if (button) { button.disabled = false; button.textContent = "Resend"; }
      if (typeof window.toast === "function") window.toast(result.body && result.body.error || "Could not resend invitation");
      return;
    }
    if (typeof window.toast === "function") window.toast("Invitation resent.");
    await loadInvites(true);
  }

  function openRevokeInvite(inviteId) {
    var invite = _invites.find(function (row) { return row.id === inviteId; });
    if (!invite) return;
    var overlay = mountInviteDialog(
      '<h2 id="cmInviteTitle">Revoke invitation?</h2><p>This invitation link will stop working.</p>' +
      '<div class="cm-invite-dialog-actions"><button type="button" id="cmRevokeCancel">Cancel</button><button type="button" class="danger" id="cmRevokeConfirm">Revoke</button></div>'
    );
    overlay.querySelector("#cmRevokeCancel").addEventListener("click", function () { closeInviteDialog(false); });
    var confirm = overlay.querySelector("#cmRevokeConfirm");
    confirm.addEventListener("click", async function () {
      if (_inviteMutationId) return;
      _inviteMutationId = inviteId;
      confirm.disabled = true;
      confirm.textContent = "Revoking…";
      var result = await inviteApi("revoke", { method: "POST", body: { invite_id: inviteId } });
      _inviteMutationId = null;
      if (!result.ok) {
        confirm.disabled = false;
        confirm.textContent = "Revoke";
        var prior = overlay.querySelector(".cm-invite-form-error");
        if (!prior) {
          prior = document.createElement("p");
          prior.className = "cm-invite-form-error";
          overlay.querySelector(".cm-invite-dialog").insertBefore(prior, overlay.querySelector(".cm-invite-dialog-actions"));
        }
        prior.textContent = result.body && result.body.error || "The invitation could not be revoked.";
        return;
      }
      closeInviteDialog(false);
      if (typeof window.toast === "function") window.toast("Invitation revoked.");
      await loadInvites(true);
    });
    setTimeout(function () { confirm.focus(); }, 0);
  }

  /* ─── Event Binding for Coach Today ─── */
  function bindCoachTodayEvents(container) {
    var refresh = container.querySelector("#cmRefresh");
    if (refresh) refresh.addEventListener("click", refreshRoster);
    var retry = container.querySelector("#cmRetry");
    if (retry) retry.addEventListener("click", refreshRoster);
    var addCoach = container.querySelector("#cmAddCoach");
    if (addCoach) addCoach.addEventListener("click", openAddCoachDialog);
    var invite = container.querySelector("#cmInviteAthlete");
    if (invite) invite.addEventListener("click", openInviteDialog);
    container.querySelectorAll("[data-resend-invite]").forEach(function (button) {
      button.addEventListener("click", function () { resendInvite(button.getAttribute("data-resend-invite"), button); });
    });
    container.querySelectorAll("[data-revoke-invite]").forEach(function (button) {
      button.addEventListener("click", function () { openRevokeInvite(button.getAttribute("data-revoke-invite")); });
    });

    bindRosterRows(container);
    // Roster search
    var searchInput = document.getElementById("cmRosterSearch");
    if (searchInput) {
      searchInput.addEventListener("input", function (e) {
        _search = e.target.value || "";
        var listEl = document.getElementById("cmRosterList");
        if (!listEl) return;
        listEl.innerHTML = renderRosterList(sortRoster(_roster), _search, _rosterFilter);
        bindRosterRows(listEl);
      });
    }
    container.querySelectorAll("[data-roster-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        _rosterFilter = btn.getAttribute("data-roster-filter") || "all";
        renderCoachToday();
      });
    });
  }

  /* ─── Dedicated coach-facing Athlete Detail page ─── */
  function athleteDetailCacheKey(athleteId, weekStart) {
    return String(athleteId || "") + "|" + String(weekStart || "current");
  }

  async function openCoachAthletePage(athleteId, tab, weekStart, force) {
    var changedAthlete = String(_athleteDetailId || "") !== String(athleteId || "");
    var existingAthlete = !changedAthlete && _athleteDetail;
    var todayScreen = document.getElementById("screen-today");
    if (changedAthlete && !_athleteDetailId && todayScreen) {
      _coachDashboardScrollTop = todayScreen.scrollTop || 0;
      _athleteDrillPending = true;
    }
    activateCoachScreen("screen-today");
    if (changedAthlete) _athleteAnalyticsRange = 4;
    if (changedAthlete) _athleteCheckInsRange = 7;
    if (changedAthlete) _editingCoachNoteId = null;
    _athleteDetailId = athleteId;
    _athleteDetailTab = tab || (changedAthlete ? "overview" : _athleteDetailTab) || "overview";
    _athleteWeekStart = weekStart || (changedAthlete ? null : _athleteWeekStart);
    var cacheKey = athleteDetailCacheKey(athleteId, _athleteWeekStart);
    var cached = !force && _athleteDetailCache[cacheKey];
    if (cached) {
      _athleteDetail = cached;
      _athleteWeekStart = cached.training_week && cached.training_week.week_start || _athleteWeekStart;
      renderAthletePage();
      return;
    }

    if (!existingAthlete) {
      _athleteDetail = null;
      renderAthletePageLoading();
    } else {
      _athleteDetail = existingAthlete;
      renderAthletePage();
      renderAthletePanelLoading();
    }
    var requestId = ++_athleteDetailRequest;
    var query = { athlete_id: athleteId };
    if (_athleteWeekStart) query.week_start = _athleteWeekStart;
    var res = await api("athlete", { query: query });
    if (_athleteDetailId !== athleteId || requestId !== _athleteDetailRequest) return;
    if (!res.ok || !res.body || !res.body.athlete) {
      var message = res.status === 403 ? "You are not assigned to this athlete." : "Could not load this athlete.";
      if (existingAthlete) renderAthletePanelError(message);
      else renderAthletePageError(message);
      return;
    }
    _athleteDetail = res.body.athlete;
    _athleteWeekStart = _athleteDetail.training_week && _athleteDetail.training_week.week_start;
    _athleteDetailCache[athleteDetailCacheKey(athleteId, _athleteWeekStart)] = _athleteDetail;
    _athleteDetailCache[cacheKey] = _athleteDetail;
    renderAthletePage();
  }

  function renderAthletePageLoading() {
    var el = document.getElementById("screen-today");
    if (!el) return;
    el.innerHTML = '<div class="cm-athlete-page cm-athlete-skeleton" role="status" aria-label="Loading athlete workspace">' +
      '<span class="skel cm-athlete-skel-back"></span><div class="cm-athlete-skel-head"><span class="skel cm-skel-avatar"></span><span class="cm-athlete-skel-copy"><span class="skel cm-athlete-skel-name"></span><span class="skel cm-athlete-skel-sub"></span><span class="skel cm-athlete-skel-sub"></span></span></div>' +
      '<div class="cm-athlete-skel-tabs">' + [0, 1, 2, 3, 4].map(function () { return '<span class="skel"></span>'; }).join("") + '</div>' +
      '<div class="cm-athlete-skel-section"><span class="skel"></span><span class="skel"></span><span class="skel"></span></div><div class="cm-athlete-skel-section"><span class="skel"></span><span class="skel"></span><span class="skel"></span></div>' +
      '<div class="cm-athlete-skel-rows">' + [0, 1, 2].map(function () { return '<span class="skel cm-athlete-skel-row"></span>'; }).join("") + '</div></div>';
    animateAthleteDrillIn(el.querySelector(".cm-athlete-page"));
  }

  function renderAthletePanelLoading() {
    var panel = document.querySelector(".cm-athlete-panel");
    if (!panel) { renderAthletePageLoading(); return; }
    panel.setAttribute("aria-busy", "true");
    panel.setAttribute("aria-label", "Loading " + (_athleteDetailTab === "training" ? "training week" : "athlete details"));
    panel.innerHTML = '<div class="cm-panel-loading" role="status"><span class="skel"></span><span class="skel"></span><span class="skel"></span><span class="skel cm-panel-loading-row"></span><span class="skel cm-panel-loading-row"></span><span class="skel cm-panel-loading-row"></span></div>';
  }

  function renderAthletePanelError(message) {
    var panel = document.querySelector(".cm-athlete-panel");
    if (!panel) { renderAthletePageError(message); return; }
    panel.removeAttribute("aria-busy");
    panel.removeAttribute("aria-label");
    panel.innerHTML = '<div class="cm-error">' + esc(message) + '<br><button type="button" class="cm-review" id="cmAthletePanelRetry">Try again</button></div>';
    var retry = panel.querySelector("#cmAthletePanelRetry");
    if (retry) retry.addEventListener("click", function () { openCoachAthletePage(_athleteDetailId, _athleteDetailTab, _athleteWeekStart, true); });
  }

  function renderAthletePageError(message) {
    var el = document.getElementById("screen-today");
    if (!el) return;
    el.innerHTML = '<div class="cm-athlete-page"><button class="cm-athlete-back" type="button">← My Athletes</button><div class="cm-error">' + esc(message) + '<br><button type="button" class="cm-review" id="cmAthleteRetry">Try again</button></div></div>';
    el.querySelector(".cm-athlete-back").addEventListener("click", closeAthletePage);
    el.querySelector("#cmAthleteRetry").addEventListener("click", function () { openCoachAthletePage(_athleteDetailId, _athleteDetailTab, _athleteWeekStart); });
  }

  function closeAthletePage() {
    var el = document.getElementById("screen-today");
    var page = el && el.querySelector(".cm-athlete-page");
    var reduced = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var token = ++_athleteDrillToken;
    if (_athleteDrillAnimation) {
      try { _athleteDrillAnimation.cancel(); } catch (error) {}
      _athleteDrillAnimation = null;
    }
    var finish = function () {
      if (token !== _athleteDrillToken) return;
      finishCloseAthletePage();
    };
    if (!page || reduced || typeof page.animate !== "function") {
      finish();
      return;
    }
    var current = window.getComputedStyle ? window.getComputedStyle(page) : null;
    _athleteDrillAnimation = page.animate([
      { transform: current && current.transform !== "none" ? current.transform : "translate3d(0,0,0)", opacity: current ? current.opacity : 1 },
      { transform: "translate3d(24px,0,0)", opacity: .94 }
    ], { duration: 210, easing: "cubic-bezier(.4,0,.8,.2)", fill: "both" });
    _athleteDrillAnimation.onfinish = finish;
  }

  function finishCloseAthletePage() {
    _athleteDetailRequest += 1;
    _athleteDetailId = null;
    _athleteDetail = null;
    _athleteWeekStart = null;
    _athleteAnalyticsRange = 4;
    _athleteCheckInsRange = 7;
    _editingCoachNoteId = null;
    _messageRequest += 1;
    _athleteDetailTab = "overview";
    _athleteDrillPending = false;
    _athleteDrillAnimation = null;
    renderCoachToday();
    var el = document.getElementById("screen-today");
    if (el) el.scrollTop = _coachDashboardScrollTop;
  }

  function animateAthleteDrillIn(page) {
    if (!_athleteDrillPending || !page) return;
    _athleteDrillPending = false;
    var token = ++_athleteDrillToken;
    var reduced = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (_athleteDrillAnimation) {
      try { _athleteDrillAnimation.cancel(); } catch (error) {}
    }
    if (reduced || typeof page.animate !== "function") {
      _athleteDrillAnimation = null;
      return;
    }
    _athleteDrillAnimation = page.animate([
      { transform: "translate3d(24px,0,0)", opacity: .94 },
      { transform: "translate3d(0,0,0)", opacity: 1 }
    ], { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)", fill: "both" });
    _athleteDrillAnimation.onfinish = function () {
      if (token !== _athleteDrillToken) return;
      try { _athleteDrillAnimation.cancel(); } catch (error) {}
      _athleteDrillAnimation = null;
    };
  }

  function athleteRaceContext(ath) {
    if (!ath.target_event && !ath.target_date) return "";
    var bits = [ath.target_event, ath.target_date ? String(ath.target_date).slice(0, 10) : null].filter(Boolean);
    if (ath.target_date) {
      var days = Math.ceil((Date.parse(String(ath.target_date).slice(0, 10) + "T00:00:00Z") - Date.now()) / 86400000);
      if (Number.isFinite(days) && days >= 0) bits.push(days + " days");
    }
    return bits.join(" · ");
  }

  function athletePanelContent(ath) {
    if (_athleteDetailTab === "training") return renderAthleteTraining(ath);
    if (_athleteDetailTab === "analytics") return renderAthleteAnalytics(ath);
    if (_athleteDetailTab === "check-ins") return renderAthleteCheckIns(ath);
    if (_athleteDetailTab === "notes") return renderAthleteNotes(ath);
    return renderAthleteOverview(ath);
  }

  function positionAthleteTabIndicator() {
    var nav = document.querySelector(".cm-athlete-tabs");
    var active = nav && nav.querySelector(".cm-athlete-tab.is-active");
    var indicator = nav && nav.querySelector(".cm-athlete-tab-indicator");
    if (!nav || !active || !indicator || !active.getBoundingClientRect) return;
    var nr = nav.getBoundingClientRect();
    var ar = active.getBoundingClientRect();
    if (!nr.width || !ar.width) return;
    indicator.style.width = Math.round(ar.width) + "px";
    indicator.style.transform = "translate3d(" + Math.round(ar.left - nr.left + nav.scrollLeft) + "px,0,0)";
    if (typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function switchAthleteTab(tab) {
    if (!_athleteDetail || tab === _athleteDetailTab) return;
    var tabs = ["overview", "training", "analytics", "check-ins", "notes"];
    var previousIndex = tabs.indexOf(_athleteDetailTab);
    var targetIndex = tabs.indexOf(tab);
    var direction = previousIndex < 0 || targetIndex < 0 || previousIndex === targetIndex
      ? 0
      : targetIndex > previousIndex ? 1 : -1;
    _athleteDetailTab = tab;
    var panel = document.querySelector(".cm-athlete-panel");
    var token = ++_athletePanelTransition;
    if (_athletePanelTimer !== null) clearTimeout(_athletePanelTimer);
    _athletePanelTimer = null;
    document.querySelectorAll("[data-athlete-tab]").forEach(function (btn) {
      var selected = btn.getAttribute("data-athlete-tab") === tab;
      btn.classList.toggle("is-active", selected);
      btn.setAttribute("aria-selected", selected ? "true" : "false");
      btn.setAttribute("tabindex", selected ? "0" : "-1");
    });
    positionAthleteTabIndicator();
    if (!panel) { renderAthletePage(); return; }
    var reducedMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reducedMotion) {
      panel.innerHTML = '<div class="cm-athlete-panel-content">' + athletePanelContent(_athleteDetail) + '</div>';
      panel.setAttribute("aria-labelledby", "cmAthleteTab-" + tab);
      bindAthletePageActions(document.getElementById("screen-today"), _athleteDetail);
      return;
    }
    var contents = Array.from(panel.querySelectorAll(":scope > .cm-athlete-panel-content"));
    var outgoing = contents.length ? contents[contents.length - 1] : null;
    if (!outgoing) {
      outgoing = document.createElement("div");
      outgoing.className = "cm-athlete-panel-content";
      while (panel.firstChild) outgoing.appendChild(panel.firstChild);
      panel.appendChild(outgoing);
    } else {
      contents.slice(0, -1).forEach(function (content) { content.remove(); });
    }
    outgoing.classList.remove("is-entering", "is-entering-active", "is-exiting");
    outgoing.style.setProperty("--athlete-panel-exit-x", direction < 0 ? "6px" : direction > 0 ? "-6px" : "0px");
    outgoing.setAttribute("aria-hidden", "true");
    outgoing.inert = true;
    var incoming = document.createElement("div");
    incoming.className = "cm-athlete-panel-content is-entering";
    incoming.style.setProperty("--athlete-panel-enter-x", direction < 0 ? "-10px" : direction > 0 ? "10px" : "0px");
    incoming.innerHTML = athletePanelContent(_athleteDetail);
    panel.appendChild(incoming);
    panel.setAttribute("aria-labelledby", "cmAthleteTab-" + tab);
    bindAthletePageActions(document.getElementById("screen-today"), _athleteDetail);
    var begin = function () {
      if (token !== _athletePanelTransition) return;
      outgoing.classList.add("is-exiting");
      incoming.classList.add("is-entering-active");
      _athletePanelTimer = setTimeout(function () {
        if (token !== _athletePanelTransition) return;
        outgoing.remove();
        incoming.classList.remove("is-entering", "is-entering-active");
        incoming.style.removeProperty("--athlete-panel-enter-x");
        _athletePanelTimer = null;
      }, 240);
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(begin);
    else setTimeout(begin, 0);
  }

  function renderAthletePage() {
    var el = document.getElementById("screen-today");
    var ath = _athleteDetail;
    if (!el || !ath) return;
    if (_athletePanelTimer !== null) clearTimeout(_athletePanelTimer);
    _athletePanelTimer = null;
    _athletePanelTransition += 1;
    var tabs = ["overview", "training", "analytics", "check-ins", "notes"];
    var labels = { overview: "Overview", training: "Training", analytics: "Analytics", "check-ins": "Check-ins", notes: "Notes" };
    var headerStatus = ath.readiness && ath.readiness.status && ath.readiness.status !== "No recent data" ? ath.readiness.status + " readiness" : "";
    el.innerHTML = '<div class="cm-athlete-page cm-athlete-page--ready">' +
      '<button class="cm-athlete-back" type="button">← My Athletes</button>' +
      '<header class="cm-athlete-head"><span class="cm-avatar" aria-hidden="true">' + esc(ath.initials || "A") + '</span><div class="cm-athlete-head-copy"><h1 class="cm-athlete-name">' + esc(ath.name || "Athlete") + '</h1><p class="cm-athlete-goal">' + esc(ath.goal || SPORT_LABEL[ath.primary_sport] || "Athlete") + '</p>' + (athleteRaceContext(ath) ? '<p class="cm-athlete-race">' + esc(athleteRaceContext(ath)) + '</p>' : '') + '</div><div class="cm-athlete-head-actions">' + (headerStatus ? '<span class="cm-athlete-head-status">' + esc(headerStatus) + '</span>' : '') + '<button type="button" class="cm-athlete-message" id="cmMessageAthlete">Message</button></div></header>' +
      '<nav class="cm-athlete-tabs" role="tablist" aria-label="Athlete workspace">' + tabs.map(function (tab) { var selected = _athleteDetailTab === tab; return '<button type="button" role="tab" class="cm-athlete-tab' + (selected ? ' is-active' : '') + '" id="cmAthleteTab-' + tab + '" aria-controls="cmAthletePanel" aria-selected="' + (selected ? 'true' : 'false') + '" tabindex="' + (selected ? '0' : '-1') + '" data-athlete-tab="' + tab + '">' + labels[tab] + '</button>'; }).join("") + '<span class="cm-athlete-tab-indicator" aria-hidden="true"></span></nav>' +
      '<div class="cm-athlete-panel" id="cmAthletePanel" role="tabpanel" aria-labelledby="cmAthleteTab-' + esc(_athleteDetailTab) + '"><div class="cm-athlete-panel-content">' + athletePanelContent(ath) + '</div></div></div>';
    animateAthleteDrillIn(el.querySelector(".cm-athlete-page"));
    el.querySelector(".cm-athlete-back").addEventListener("click", closeAthletePage);
    var tabButtons = Array.from(el.querySelectorAll("[data-athlete-tab]"));
    tabButtons.forEach(function (btn, index) {
      btn.addEventListener("click", function () { switchAthleteTab(btn.getAttribute("data-athlete-tab")); });
      btn.addEventListener("keydown", function (event) {
        var direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!direction) return;
        event.preventDefault();
        var next = tabButtons[(index + direction + tabButtons.length) % tabButtons.length];
        if (next) { next.focus(); switchAthleteTab(next.getAttribute("data-athlete-tab")); }
      });
    });
    positionAthleteTabIndicator();
    bindAthletePageActions(el, ath);
  }

  function metric(label, value, sub) {
    return '<div class="cm-detail-metric"><span class="cm-detail-label">' + esc(label) + '</span><span class="cm-detail-value">' + esc(value || "—") + '</span>' + (sub ? '<span class="cm-detail-sub">' + esc(sub) + '</span>' : '') + '</div>';
  }

  function renderAthleteOverview(ath) {
    var wk = ath.week_planned_vs_completed || {};
    var compliance = wk.planned_minutes > 0 && wk.completed_minutes != null ? Math.round((wk.completed_minutes / wk.planned_minutes) * 100) + "%" : null;
    var sessions = (ath.training_week && ath.training_week.sessions) || [];
    var statusCount = function (status) { return sessions.filter(function (s) { return s.execution_status === status; }).length; };
    var completed = statusCount("completed") + statusCount("modified");
    var remaining = sessions.filter(function (s) { return ["pending", "planned", "upcoming"].indexOf(s.execution_status) !== -1; }).length;
    var latest = (ath.recent_activities || [])[0] || null;
    var plan = ath.plan_phase || ath.plan_week_focus;
    var reasons = (ath.attention_reasons || []).map(function (r) { return '<li>' + esc(r.explanation || attentionReasonLabel(r.key)) + '</li>'; }).join("");
    var attention = '<section class="cm-overview-section' + (reasons ? ' cm-attention-section' : '') + '"><span class="cm-overview-kicker">' + (reasons ? 'Needs attention' : 'Attention') + '</span>' + (reasons ? '<ul class="cm-attention-list">' + reasons + '</ul><button type="button" class="cm-review cm-attention-action" id="cmDetailReview">Mark reviewed</button>' : '<div class="cm-attention-clear">No immediate issues.</div>') + '</section>';
    var latestSection = '<section class="cm-overview-section"><span class="cm-overview-kicker">Latest activity</span>' + (latest ? renderLatestActivity(latest) : '<div class="cm-attention-clear">No recent training data.</div>') + '</section>';
    var hasIncompleteStatus = !(ath.readiness && ath.readiness.status && ath.readiness.status !== "No recent data") ||
      !(ath.recovery_status && ath.recovery_status !== "unknown") || ath.training_load == null || !compliance;
    return '<div class="cm-overview"><section class="cm-overview-section"><span class="cm-overview-kicker">Current direction</span><h2 class="cm-overview-title">' + esc(ath.goal || "Goal not recorded") + '</h2><p class="cm-overview-copy">' + esc(plan || "No current training phase is available.") + '</p></section>' +
      '<section class="cm-overview-section"><span class="cm-overview-kicker">Current status</span><div class="cm-overview-status">' +
        statusRow("Readiness", ath.readiness && ath.readiness.status || "Unavailable", ath.readiness && ath.readiness.check_in_date ? "Latest check-in" : "") +
        statusRow("Recovery", titleCase(ath.recovery_status && ath.recovery_status !== "unknown" ? ath.recovery_status : "Unavailable"), ath.recovery_status && ath.recovery_status !== "unknown" ? "Current trend" : "") +
        statusRow("Training load", ath.training_load != null ? ath.training_load : "Unavailable", ath.training_load != null ? "Recent load" : "") +
        statusRow("Adherence", compliance || "Unavailable", compliance ? "Planned vs completed" : "") + '</div>' + (hasIncompleteStatus ? '<p class="cm-status-footnote">Some status signals need more athlete history.</p>' : '') + '</section>' +
      '<section class="cm-overview-section"><span class="cm-overview-kicker">This week</span>' + renderWeekSnapshot(sessions, completed, remaining, statusCount("modified"), statusCount("skipped"), wk) + '</section>' +
      (reasons ? attention + latestSection : latestSection + attention) +
      (ath.target_event || ath.target_date ? renderUpcomingRace(ath) : '') + '</div>';
  }

  function titleCase(value) {
    return String(value || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function statusRow(label, value, note) {
    return '<div class="cm-status-row"><span class="cm-status-label">' + esc(label) + '</span><span class="cm-status-reading"><strong class="cm-status-value">' + esc(value) + '</strong>' + (note ? '<span class="cm-status-note">' + esc(note) + '</span>' : '') + '</span></div>';
  }

  function renderWeekSnapshot(sessions, completed, remaining, modified, skipped, wk) {
    var total = sessions.length;
    var progress = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    var details = [];
    if (wk.completed_distance_km != null) details.push(wk.completed_distance_km + " km completed");
    else if (wk.completed_minutes != null) details.push(wk.completed_minutes + " min completed");
    if (remaining) details.push(remaining + " session" + (remaining === 1 ? "" : "s") + " remaining");
    if (!details.length) details.push(total ? "Execution updates will appear here" : "No sessions scheduled this week");
    return '<div class="cm-week-snapshot"><div class="cm-week-primary">' + esc(total ? completed + " of " + total + " sessions completed" : "No sessions scheduled this week") + '</div><div class="cm-week-detail">' + details.map(function (line) { return '<span>' + esc(line) + '</span>'; }).join("") + '</div>' + (total ? '<div class="cm-week-progress" aria-label="' + esc(progress + "% of sessions completed") + '"><span style="width:' + progress + '%"></span></div>' : '') + '<div class="cm-week-flags"><span>Modified ' + esc(modified) + '</span><span>Skipped ' + esc(skipped) + '</span></div></div>';
  }

  function renderLatestActivity(a) {
    var primary = [];
    var performance = [];
    if (a.distance_km != null) primary.push(a.distance_km + " km");
    if (a.duration_min != null) primary.push(a.duration_min + " min");
    if (a.sport === "run" && a.pace_sec_per_km) performance.push(Math.floor(a.pace_sec_per_km / 60) + ":" + String(a.pace_sec_per_km % 60).padStart(2, "0") + "/km");
    if (a.sport === "ride" && a.speed_kph != null) performance.push(a.speed_kph + " km/h");
    if (a.sport === "ride" && a.avg_power_watts != null) performance.push(a.avg_power_watts + " W");
    if (a.sport === "ride" && a.avg_cadence != null) performance.push(a.avg_cadence + " rpm");
    if (a.indoor) performance.push("Indoor");
    return '<div class="cm-latest"><div><strong>' + esc(SPORT_LABEL[a.sport] || "Activity") + '</strong><p>' + esc(primary.concat([fmtLastActive(a.date)]).join(" · ")) + '</p>' + (performance.length ? '<p>' + esc(performance.join(" · ")) + '</p>' : '') + '<span class="cm-latest-status">Completed</span></div><time>' + esc(a.date ? String(a.date).slice(0, 10) : "") + '</time></div>';
  }

  function renderUpcomingRace(ath) {
    var dateLabel = "";
    var daysLabel = "";
    if (ath.target_date) {
      var parsed = new Date(String(ath.target_date).slice(0, 10) + "T00:00:00Z");
      if (!Number.isNaN(parsed.getTime())) dateLabel = parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
      var days = Math.ceil((parsed.getTime() - Date.now()) / 86400000);
      if (Number.isFinite(days) && days >= 0) daysLabel = days + " days";
    }
    return '<section class="cm-overview-section"><span class="cm-overview-kicker">Upcoming race</span><div class="cm-race-line"><div><strong>' + esc(ath.target_event || "Target race") + '</strong>' + (dateLabel ? '<span class="cm-race-meta">' + esc(dateLabel) + '</span>' : '') + '</div>' + (daysLabel ? '<span class="cm-race-countdown">' + esc(daysLabel) + '</span>' : '') + '</div></section>';
  }

  function workoutMeta(session) {
    return [Number(session.duration_minutes) > 0 ? session.duration_minutes + " min" : null, Number(session.distance_km) > 0 ? session.distance_km + " km" : null, session.target_rpe ? "RPE " + session.target_rpe : session.intensity, session.pace_guidance].filter(Boolean).join(" · ");
  }

  function formatWeekRange(start, end) {
    if (!start || !end) return "Current week";
    try {
      var s = new Date(start + "T00:00:00Z");
      var e = new Date(end + "T00:00:00Z");
      var sameMonth = s.getUTCMonth() === e.getUTCMonth();
      return s.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) +
        (sameMonth ? "–" + e.getUTCDate() : "–" + e.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }));
    } catch (e) { return start + " – " + end; }
  }

  function sessionStatusLabel(status) {
    var map = { completed: "Completed", pending: "Pending", modified: "Modified", skipped: "Skipped", planned: "Planned", upcoming: "Upcoming" };
    return map[status] || "Planned";
  }

  function renderAthleteTraining(ath) {
    var week = ath.training_week || { sessions: [] };
    var canWrite = ath.assignment_permission === "read_write";
    // A coach who can edit needs no existing plan: the server opens the week plan when the first
    // workout is added. Someone who can only view has nothing to add, so say there is no plan.
    var sessionsInWeek = week.sessions || [];
    var hasPlan = Boolean(ath.has_active_plan) || sessionsInWeek.length > 0;
    if (!hasPlan && !canWrite) {
      return '<div class="cm-no-plan"><strong>No active training plan.</strong><p>This athlete has no workouts scheduled.</p></div><div class="cm-readonly-note">This assignment is view-only.</div>';
    }
    var sessions = week.sessions || [];
    var byDate = Object.create(null);
    sessions.forEach(function (session) { if (session.date) byDate[session.date] = session; });
    var rows = [];
    var start = week.week_start ? new Date(week.week_start + "T00:00:00Z") : null;
    for (var i = 0; i < 7; i += 1) {
      var date = start ? new Date(start.getTime() + i * 86400000) : null;
      var key = date ? date.toISOString().slice(0, 10) : null;
      var session = key && byDate[key];
      var dateLabel = date ? date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }) : "Day";
      var dayNumber = date ? date.getUTCDate() : "";
      if (!session) {
        var todayKey = ath.today_key || new Date().toISOString().slice(0, 10);
        if (canWrite && key && key >= todayKey) {
          rows.push('<button type="button" class="cm-day-row cm-day-rest cm-day-empty' + (key === ath.today_key ? ' is-today' : '') + '" data-add-day="' + esc(key) + '" aria-label="Add to ' + esc(dateLabel + " " + dayNumber) + '"><span class="cm-day-date">' + esc(dateLabel) + '<b>' + esc(dayNumber) + '</b></span><span class="cm-day-copy"><span class="cm-day-title">' + (hasPlan ? "Rest" : "Nothing planned") + '</span></span><span class="cm-day-add" aria-hidden="true">+</span></button>');
        } else {
          rows.push('<div class="cm-day-row cm-day-rest' + (key === ath.today_key ? ' is-today' : '') + '"><span class="cm-day-date">' + esc(dateLabel) + '<b>' + esc(dayNumber) + '</b></span><span class="cm-day-copy"><span class="cm-day-title">Rest</span></span><span class="cm-day-status">Rest</span></div>');
        }
        continue;
      }
      rows.push('<button type="button" class="cm-day-row' + (session.date === ath.today_key ? ' is-today' : '') + '" data-workout-id="' + esc(session.id) + '"><span class="cm-day-date">' + esc(dateLabel) + '<b>' + esc(dayNumber) + '</b></span><span class="cm-day-copy"><span class="cm-day-title">' + esc(session.title) + '</span><span class="cm-day-meta">' + esc(workoutMeta(session) || "Prescription details unavailable") + '</span></span><span class="cm-day-right">' + (session.published === false ? '<span class="cm-day-draft">Draft</span>' : '') + '<span class="cm-day-status ' + esc(session.execution_status) + '">' + esc(sessionStatusLabel(session.execution_status)) + '</span>' + (canWrite && session.can_reschedule ? '<span class="cm-day-grip" aria-hidden="true" title="Drag to another day">\u22ee\u22ee</span>' : '') + '</span></button>');
    }
    var draftCount = sessions.filter(function (s) { return s.published === false; }).length;
    var publishBanner = canWrite && draftCount ? '<div class="cm-publish-bar"><div class="cm-publish-copy"><strong>' + draftCount + (draftCount === 1 ? ' workout' : ' workouts') + ' not published</strong><span>Your athlete can\u2019t see ' + (draftCount === 1 ? 'it' : 'them') + ' until you publish.</span></div><div class="cm-publish-actions"><button type="button" class="cm-week-btn cm-publish-discard" data-publish-week="discard">Discard drafts</button><button type="button" class="cm-week-btn cm-week-btn--primary" data-publish-week="publish">Publish week</button></div></div>' : '';
    var completed = sessions.filter(function (s) { return s.execution_status === "completed" || s.execution_status === "modified"; }).length;
    var plannedDistance = sessions.reduce(function (sum, s) { return sum + (Number(s.distance_km) || 0); }, 0);
    var plannedMinutes = sessions.reduce(function (sum, s) { return sum + (Number(s.duration_minutes) || 0); }, 0);
    var plannedLabel = plannedDistance ? Math.round(plannedDistance * 10) / 10 + " km planned" : plannedMinutes ? plannedMinutes + " min planned" : "";
    return '<div class="cm-training-week"><div class="cm-week-nav"><button type="button" data-week-shift="-7" aria-label="Previous week">‹</button><div><div class="cm-week-range">' + esc(formatWeekRange(week.week_start, week.week_end)) + '</div><div class="cm-week-volume">' + esc(completed + " / " + sessions.length + " sessions complete" + (plannedLabel ? " · " + plannedLabel : "")) + '</div></div><button type="button" data-week-shift="7" aria-label="Next week">›</button></div>' +
      (!canWrite ? '<div class="cm-readonly-note">View-only assignment. Workout details are available, but plan changes are disabled.</div>' : '') +
      (canWrite && !hasPlan ? '<div class="cm-readonly-note">No workouts yet. Tap a day to add the first one.</div>' : '') +
      publishBanner +
      '<div class="cm-day-list">' + rows.join("") + '</div>' +
      '</div>';
  }

  function renderAthleteAnalytics(ath) {
    var analyticsData = ath.coaching_analytics || {};
    var ranges = analyticsData.ranges || {};
    var range = ranges[String(_athleteAnalyticsRange)] || ranges[String(analyticsData.default_range_weeks || 4)] || null;
    var controls = '<div class="cm-range-control" aria-label="Analytics time range">' + [4, 8, 12].map(function (weeks) {
      return '<button type="button" class="cm-range-btn' + (_athleteAnalyticsRange === weeks ? ' is-active' : '') + '" data-analytics-range="' + weeks + '" aria-pressed="' + (_athleteAnalyticsRange === weeks ? 'true' : 'false') + '">' + weeks + 'W</button>';
    }).join("") + '</div>';
    if (!range) {
      return '<div class="cm-athlete-analytics"><div class="cm-analytics-head"><div class="cm-analytics-headline"><h2>Analytics</h2>' + controls + '</div></div><div class="cm-analytics-empty"><strong>Not enough training history yet.</strong><p>Useful trends will appear after the athlete records enough comparable training.</p></div></div>';
    }
    var modules = renderAnalyticsVolume(range.volume) + renderAnalyticsAdherence(range.adherence) + renderAnalyticsPerformance(range.performance);
    if (!range.has_meaningful_history) {
      modules = '<div class="cm-analytics-empty"><strong>Not enough training history yet.</strong><p>Keep training consistently and useful trends will appear here once there is enough comparable data.</p></div>';
    }
    return '<div class="cm-athlete-analytics"><div class="cm-analytics-head"><div class="cm-analytics-headline"><h2>Analytics</h2>' + controls + '</div><span class="cm-overview-kicker">Last ' + esc(_athleteAnalyticsRange) + ' weeks</span><p class="cm-analytics-summary">' + esc(range.summary || "Not enough training history yet to identify a reliable trend.") + '</p></div>' + modules + '</div>';
  }

  function analyticsChange(value, suffix) {
    if (value == null) return "No reliable previous-period comparison";
    if (value === 0) return "No change vs previous period";
    return (value > 0 ? "+" : "") + value + (suffix || "%") + " vs previous period";
  }

  function renderAnalyticsVolume(volume) {
    if (!volume || !volume.available) return '<section class="cm-analytics-module"><span class="cm-analytics-kicker">Training volume</span><p class="cm-analytics-unavailable">Not enough completed training data to establish a volume trend.</p></section>';
    var unit = volume.unit === "km" ? "km / week" : "min / week";
    return '<section class="cm-analytics-module"><span class="cm-analytics-kicker">Training volume</span><div class="cm-analytics-reading"><strong class="cm-analytics-value">' + esc(volume.weekly_average) + ' ' + unit + '</strong><span class="cm-analytics-compare">' + esc(analyticsChange(volume.change_pct, "%")) + '</span></div>' + renderAnalyticsLine(volume.series || [], volume.unit) + '<p class="cm-analytics-interpretation">' + esc(volume.interpretation) + '</p></section>';
  }

  function renderAnalyticsLine(series, unit) {
    if (!series.length) return "";
    var values = series.map(function (point) { return Number(point.value) || 0; });
    var max = Math.max.apply(Math, values.concat([1]));
    var lastX = Math.max(1, values.length - 1);
    var points = values.map(function (value, index) {
      return Math.round((index / lastX) * 1000) / 10 + "," + Math.round((54 - (value / max) * 45) * 10) / 10;
    }).join(" ");
    var last = points.split(" ").pop().split(",");
    return '<svg class="cm-analytics-chart" viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label="Weekly ' + esc(unit === "km" ? "running distance" : "training duration") + ' trend"><line class="cm-analytics-gridline" x1="0" y1="54" x2="100" y2="54"></line><polyline class="cm-analytics-line" points="' + points + '"></polyline><circle class="cm-analytics-point" cx="' + last[0] + '" cy="' + last[1] + '" r="1.4"></circle></svg>';
  }

  function renderAnalyticsAdherence(adherence) {
    if (!adherence || !adherence.available) return '<section class="cm-analytics-module"><span class="cm-analytics-kicker">Adherence</span><p class="cm-analytics-unavailable">Not enough recorded session outcomes to calculate adherence.</p></section>';
    return '<section class="cm-analytics-module"><span class="cm-analytics-kicker">Adherence</span><div class="cm-analytics-reading"><strong class="cm-analytics-value">' + esc(adherence.pct) + '%</strong><span class="cm-analytics-compare">' + esc(adherence.completed + " of " + adherence.recorded + " recorded sessions completed") + '</span></div><div class="cm-week-progress" role="img" aria-label="' + esc(adherence.pct + "% adherence") + '"><span style="width:' + Math.max(0, Math.min(100, adherence.pct)) + '%"></span></div><p class="cm-analytics-interpretation">' + esc(adherence.interpretation) + '</p></section>';
  }

  function formatPace(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return "—";
    return Math.floor(Number(seconds) / 60) + ":" + String(Math.round(Number(seconds) % 60)).padStart(2, "0") + "/km";
  }

  function renderAnalyticsPerformance(performance) {
    if (!performance || !performance.available) return '<section class="cm-analytics-module"><span class="cm-analytics-kicker">Performance</span><p class="cm-analytics-unavailable">' + esc(performance && performance.interpretation || "More comparable sessions are needed before performance trend is reliable.") + '</p></section>';
    var delta = Number(performance.delta_sec_per_km);
    var compare = Math.abs(delta) + " sec/km " + (delta < 0 ? "faster" : delta > 0 ? "slower" : "change") + " vs previous period";
    return '<section class="cm-analytics-module"><span class="cm-analytics-kicker">Performance</span><div class="cm-analytics-reading"><strong class="cm-analytics-value">' + esc(formatPace(performance.pace_sec_per_km)) + '</strong><span class="cm-analytics-compare">Threshold pace · ' + esc(compare) + '</span></div><p class="cm-analytics-interpretation">' + esc(performance.interpretation) + '</p></section>';
  }

  function checkInScaleLabel(value, dimension) {
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (dimension === "energy") return n <= 3 ? "Low" : n <= 6 ? "Moderate" : "High";
    if (dimension === "soreness") return n <= 3 ? "Low" : n <= 6 ? "Moderate" : "High";
    if (dimension === "stress") return n <= 3 ? "Low" : n <= 6 ? "Moderate" : "High";
    return String(n);
  }

  function manilaDateKey() {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    var values = {};
    parts.forEach(function (part) { values[part.type] = part.value; });
    return values.year + "-" + values.month + "-" + values.day;
  }

  function formatCheckInDate(record, includeTime) {
    if (!record || !record.date) return "";
    var date = new Date(record.date + "T00:00:00Z");
    var label = date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    var today = manilaDateKey();
    if (record.date === today) label = "Today";
    if (includeTime && record.submitted_at) {
      var stamp = new Date(record.submitted_at);
      if (!Number.isNaN(stamp.getTime())) label += ", " + stamp.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
    }
    return label;
  }

  function latestCheckInRows(record) {
    var rows = [];
    if (record.sleep_label) rows.push(["Sleep", record.sleep_label]);
    if (record.energy != null) rows.push(["Energy", checkInScaleLabel(record.energy, "energy") + " · " + record.energy + "/10"]);
    if (record.muscle_soreness != null) rows.push(["Soreness", checkInScaleLabel(record.muscle_soreness, "soreness") + " · " + record.muscle_soreness + "/10"]);
    if (record.mental_stress != null) rows.push(["Stress", checkInScaleLabel(record.mental_stress, "stress") + " · " + record.mental_stress + "/10"]);
    return rows.map(function (row) { return '<div class="cm-checkin-row"><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong></div>'; }).join("");
  }

  function renderSubjectiveTrends(records) {
    var dimensions = [
      { key: "sleep_quality", label: "Sleep", max: 5 },
      { key: "energy", label: "Energy", max: 10 },
      { key: "muscle_soreness", label: "Soreness", max: 10 },
      { key: "mental_stress", label: "Stress", max: 10 }
    ];
    var chronological = records.slice().reverse();
    return '<div class="cm-subjective-trends">' + dimensions.map(function (dimension) {
      var bars = chronological.map(function (record) {
        var value = Number(record[dimension.key]);
        var available = Number.isFinite(value) && value > 0;
        var height = available ? Math.max(3, Math.round((value / dimension.max) * 24)) : 1;
        return '<span class="cm-subjective-bar' + (available ? '' : ' is-missing') + '" style="height:' + height + 'px" title="' + esc(available ? formatCheckInDate(record, false) + ': ' + value : formatCheckInDate(record, false) + ': unavailable') + '"></span>';
      }).join("");
      return '<div class="cm-subjective-row"><span class="cm-subjective-label">' + dimension.label + '</span><span class="cm-subjective-bars" role="img" aria-label="' + dimension.label + ' reported values over ' + esc(_athleteCheckInsRange) + ' days">' + bars + '</span></div>';
    }).join("") + '</div>';
  }

  function checkInTimelineSummary(record, previous) {
    var bits = [];
    if (record.sleep_label && (!previous || record.sleep_quality !== previous.sleep_quality)) bits.push("Sleep " + record.sleep_label.toLowerCase());
    if (record.energy != null && (!previous || record.energy !== previous.energy)) bits.push("Energy " + checkInScaleLabel(record.energy, "energy").toLowerCase());
    if (record.muscle_soreness != null && (!previous || record.muscle_soreness !== previous.muscle_soreness)) bits.push("Soreness " + checkInScaleLabel(record.muscle_soreness, "soreness").toLowerCase());
    if (record.mental_stress != null && (!previous || record.mental_stress !== previous.mental_stress)) bits.push("Stress " + checkInScaleLabel(record.mental_stress, "stress").toLowerCase());
    if (record.pain_present && (!previous || !previous.pain_present || record.pain_location !== previous.pain_location || record.pain_severity !== previous.pain_severity)) bits.push((record.pain_location || "Pain") + (record.pain_severity != null ? " " + record.pain_severity + "/10" : " reported"));
    return bits.join(" · ");
  }

  function directCheckInSignals(records) {
    var signals = [];
    var recent = records.slice(0, 3);
    if (recent.length === 3 && recent.every(function (record) { return record.sleep_quality != null && record.sleep_quality <= 2; })) signals.push("Sleep has been low for 3 consecutive check-ins.");
    if (recent.length === 3 && recent.every(function (record) { return record.mental_stress != null && record.mental_stress >= 7; })) signals.push("Stress has remained high for 3 consecutive check-ins.");
    if (recent.length === 3 && recent.every(function (record) { return record.muscle_soreness != null && record.muscle_soreness >= 7; })) signals.push("Soreness has remained high for 3 consecutive check-ins.");
    return signals;
  }

  function renderAthleteCheckIns(ath) {
    var allRecords = ath.coach_check_ins && Array.isArray(ath.coach_check_ins.records) ? ath.coach_check_ins.records : [];
    var controls = '<div class="cm-range-control" aria-label="Check-in history range">' + [7, 14].map(function (days) { return '<button type="button" class="cm-range-btn' + (_athleteCheckInsRange === days ? ' is-active' : '') + '" data-checkins-range="' + days + '" aria-pressed="' + (_athleteCheckInsRange === days ? 'true' : 'false') + '">' + days + 'D</button>'; }).join("") + '</div>';
    if (!allRecords.length) return '<div class="cm-athlete-checkins"><div class="cm-checkins-head"><h2>Check-ins</h2>' + controls + '</div><div class="cm-analytics-empty"><strong>No check-ins yet.</strong><p>The athlete’s readiness and feedback will appear here after they complete their first check-in.</p></div></div>';
    var manilaToday = manilaDateKey();
    var cutoff = new Date(manilaToday + "T00:00:00Z");
    cutoff.setUTCDate(cutoff.getUTCDate() - (_athleteCheckInsRange - 1));
    var cutoffKey = cutoff.toISOString().slice(0, 10);
    var records = allRecords.filter(function (record) { return record.date >= cutoffKey; });
    var latest = allRecords[0];
    var painRecords = records.filter(function (record) { return record.pain_present; });
    var signals = directCheckInSignals(records);
    var pain = painRecords.length
      ? '<section class="cm-checkin-section"><span class="cm-analytics-kicker">Pain / issues</span>' + painRecords.map(function (record) { return '<div class="cm-checkin-pain"><span class="cm-checkin-quiet">' + esc(formatCheckInDate(record, false)) + '</span><strong>' + esc(record.pain_location || "Pain reported") + (record.pain_severity != null ? " · " + esc(record.pain_severity) + "/10" : "") + '</strong></div>'; }).join("") + '</section>'
      : '<section class="cm-checkin-section"><span class="cm-analytics-kicker">Pain / issues</span><p class="cm-checkin-quiet">No recent pain reported.</p></section>';
    var timeline = records.map(function (record, index) { var previous = records[index + 1] || null; return '<li><time>' + esc(formatCheckInDate(record, false)) + '</time><div><p>' + esc(checkInTimelineSummary(record, previous) || (record.notes ? "Athlete note added" : "No reported changes")) + '</p>' + (record.notes ? '<blockquote>“' + esc(record.notes) + '”</blockquote>' : '') + '</div></li>'; }).join("");
    return '<div class="cm-athlete-checkins"><div class="cm-checkins-head"><div><h2>Check-ins</h2><p class="cm-checkins-latest">Latest · ' + esc(formatCheckInDate(latest, true)) + '</p></div>' + controls + '</div>' +
      '<section class="cm-checkin-section"><span class="cm-analytics-kicker">Latest check-in</span><div class="cm-checkin-rows">' + (latestCheckInRows(latest) || '<div class="cm-checkin-row"><span>Responses</span><strong>Partial check-in</strong></div>') + '</div></section>' +
      (latest.pain_present ? '<section class="cm-checkin-section cm-checkin-pain"><span class="cm-analytics-kicker">Pain reported</span><strong>' + esc(latest.pain_location || "Location not provided") + (latest.pain_severity != null ? " · " + esc(latest.pain_severity) + "/10" : "") + '</strong></section>' : '') +
      (latest.notes ? '<section class="cm-checkin-section"><span class="cm-analytics-kicker">Athlete note</span><blockquote class="cm-checkin-note">“' + esc(latest.notes) + '”</blockquote></section>' : '') +
      '<section class="cm-checkin-section"><div class="cm-checkins-head"><span class="cm-analytics-kicker">Subjective trend</span></div>' + (records.length ? renderSubjectiveTrends(records) : '<p class="cm-checkin-quiet">No check-ins in this range.</p>') + '</section>' + pain +
      (signals.length ? '<section class="cm-checkin-section"><span class="cm-analytics-kicker">Coaching signals</span><ul class="cm-coaching-signals">' + signals.map(function (signal) { return '<li>' + esc(signal) + '</li>'; }).join("") + '</ul></section>' : '') +
      '<section class="cm-checkin-section"><span class="cm-analytics-kicker">Recent check-ins</span>' + (timeline ? '<ol class="cm-checkin-timeline">' + timeline + '</ol>' : '<p class="cm-checkin-quiet">No check-ins in this range.</p>') + '</section></div>';
  }

  function coachNoteDate(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + " · " +
      date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function renderCoachNoteItem(note) {
    var editing = String(_editingCoachNoteId || "") === String(note.id || "");
    var author = " · " + esc(note.author_name || "Coach");
    var editor = editing
      ? '<form class="cm-note-edit" data-note-edit-form="' + esc(note.id) + '"><textarea name="body" maxlength="4000" aria-label="Edit coach note">' + esc(note.body) + '</textarea><div class="cm-notes-error" aria-live="polite"></div><div class="cm-note-actions"><button type="button" class="cm-note-action" data-note-edit-cancel>Cancel</button><button type="submit" class="cm-note-action cm-note-action--primary">Save changes</button></div></form>'
      : '<p class="cm-note-body">' + esc(note.body) + '</p>';
    var actions = !editing && note.can_edit
      ? '<div class="cm-note-item-actions"><button type="button" class="cm-note-action" data-note-pin="' + esc(note.id) + '" data-pinned="' + (note.pinned ? "true" : "false") + '">' + (note.pinned ? "Unpin" : "Pin") + '</button><button type="button" class="cm-note-action" data-note-edit="' + esc(note.id) + '">Edit</button><button type="button" class="cm-note-action cm-note-action--danger" data-note-delete="' + esc(note.id) + '">Delete</button></div><div class="cm-notes-error" aria-live="polite"></div>'
      : '';
    return '<li class="cm-note-item" data-note-id="' + esc(note.id) + '"><div class="cm-note-item-head"><span class="cm-note-meta">' + esc(coachNoteDate(note.created_at)) + author + '</span>' + (note.pinned ? '<span class="cm-note-pin">Pinned</span>' : '') + '</div>' + editor + actions + '</li>';
  }

  function renderAthleteNotes(ath) {
    var data = ath.coach_notes || { notes: [], can_create: false, unavailable: true };
    var notes = Array.isArray(data.notes) ? data.notes : [];
    var pinned = notes.filter(function (note) { return note.pinned; });
    var recent = notes.filter(function (note) { return !note.pinned; });
    var composer = data.can_create
      ? '<form class="cm-note-compose" id="cmNoteCompose"><textarea name="body" maxlength="4000" aria-label="Add a private coach note" placeholder="Add a note about this athlete…"></textarea><div class="cm-notes-error" aria-live="polite"></div><div class="cm-note-actions"><button type="reset" class="cm-note-action">Cancel</button><button type="submit" class="cm-note-action cm-note-action--primary" disabled>Save</button></div></form>'
      : '<p class="cm-notes-readonly">This assignment allows you to view private coach notes, but not add or change them.</p>';
    if (data.unavailable) composer = '<p class="cm-notes-unavailable">Coach notes are unavailable until the private notes migration is applied.</p>';
    var group = function (title, list) {
      return list.length ? '<section class="cm-note-group"><span class="cm-note-group-title">' + title + '</span><ol class="cm-note-list">' + list.map(function (note) { return renderCoachNoteItem(note); }).join("") + '</ol></section>' : '';
    };
    var empty = !notes.length && !data.unavailable
      ? '<div class="cm-notes-empty"><strong>No coach notes yet.</strong><p>Add private notes here to remember important athlete context.</p></div>'
      : '';
    return '<div class="cm-athlete-notes"><header class="cm-notes-head"><h2>Notes</h2><p class="cm-notes-private">Private to the athlete’s assigned coaching team.</p></header>' + composer + empty + group("Pinned", pinned) + group("Recent notes", recent) + '</div>';
  }

  function renderAthleteEmpty(title, copy) { return '<div class="cm-athlete-empty"><h2>' + esc(title) + '</h2><p>' + esc(copy) + '</p></div>'; }

  function replaceCoachNotes(data) {
    if (!_athleteDetail || _athleteDetailTab !== "notes") return;
    _editingCoachNoteId = null;
    _athleteDetail.coach_notes = data;
    Object.keys(_athleteDetailCache).forEach(function (key) {
      if (key.indexOf(String(_athleteDetailId) + "|") === 0 && _athleteDetailCache[key]) {
        _athleteDetailCache[key].coach_notes = data;
      }
    });
    var panel = document.querySelector(".cm-athlete-panel");
    if (panel) {
      panel.innerHTML = renderAthleteNotes(_athleteDetail);
      bindAthletePageActions(document.getElementById("screen-today"), _athleteDetail);
    }
  }

  async function mutateCoachNote(method, payload, submit, error) {
    if (submit) submit.disabled = true;
    var res = await api("notes", { method: method, body: Object.assign({ athlete_id: _athleteDetailId }, payload) });
    if (!res.ok || !res.body || !res.body.coach_notes) {
      if (error) error.textContent = res.body && res.body.error || "The note could not be saved.";
      if (submit) submit.disabled = false;
      return false;
    }
    replaceCoachNotes(res.body.coach_notes);
    return true;
  }

  function openCoachNoteDeleteConfirm(noteId) {
    var returnFocus = document.activeElement;
    var overlay = document.createElement("div");
    overlay.className = "cm-note-confirm";
    overlay.innerHTML = '<div class="cm-note-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="cmNoteDeleteTitle" aria-describedby="cmNoteDeleteCopy"><h2 id="cmNoteDeleteTitle">Delete this note?</h2><p id="cmNoteDeleteCopy">This cannot be undone.</p><div class="cm-notes-error" aria-live="polite"></div><div class="cm-note-confirm-actions"><button type="button" class="cm-note-action" data-note-delete-cancel>Cancel</button><button type="button" class="cm-note-action cm-note-action--danger" data-note-delete-confirm>Delete</button></div></div>';
    document.body.appendChild(overlay);
    var previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    var cancel = overlay.querySelector("[data-note-delete-cancel]");
    var confirm = overlay.querySelector("[data-note-delete-confirm]");
    var dialog = overlay.querySelector(".cm-note-confirm-dialog");
    var close = function () {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      overlay.remove();
      if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    };
    var onKey = function (event) {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && dialog) {
        var first = cancel;
        var last = confirm;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", function (event) { if (event.target === overlay) close(); });
    cancel.addEventListener("click", close);
    confirm.addEventListener("click", async function () {
      confirm.disabled = true;
      var ok = await mutateCoachNote("DELETE", { note_id: noteId }, confirm, overlay.querySelector(".cm-notes-error"));
      if (ok) close(); else confirm.disabled = false;
    });
    cancel.focus();
  }

  function bindAthletePageActions(el, ath) {
    var review = el.querySelector("#cmDetailReview");
    if (review) review.addEventListener("click", function () { markAthleteReviewed(ath.athlete_id, review); });
    var messageAthlete = el.querySelector("#cmMessageAthlete");
    if (messageAthlete) messageAthlete.addEventListener("click", function () {
      var today = document.getElementById("screen-today");
      _athleteDetailScrollTop = today ? today.scrollTop || 0 : 0;
      openAthleteMessaging(ath.athlete_id, "athlete_detail", _athleteDetailTab);
    });
    el.querySelectorAll("[data-analytics-range]").forEach(function (btn) { btn.addEventListener("click", function () {
      var next = Number(btn.getAttribute("data-analytics-range"));
      if ([4, 8, 12].indexOf(next) === -1 || next === _athleteAnalyticsRange) return;
      _athleteAnalyticsRange = next;
      var panel = el.querySelector(".cm-athlete-panel");
      if (panel && _athleteDetailTab === "analytics") {
        panel.innerHTML = renderAthleteAnalytics(ath);
        bindAthletePageActions(el, ath);
      }
    }); });
    el.querySelectorAll("[data-checkins-range]").forEach(function (btn) { btn.addEventListener("click", function () {
      var next = Number(btn.getAttribute("data-checkins-range"));
      if ([7, 14].indexOf(next) === -1 || next === _athleteCheckInsRange) return;
      _athleteCheckInsRange = next;
      var panel = el.querySelector(".cm-athlete-panel");
      if (panel && _athleteDetailTab === "check-ins") {
        panel.innerHTML = renderAthleteCheckIns(ath);
        bindAthletePageActions(el, ath);
      }
    }); });
    var composer = el.querySelector("#cmNoteCompose");
    if (composer) {
      var noteTextarea = composer.querySelector('textarea[name="body"]');
      var noteSubmit = composer.querySelector('[type="submit"]');
      var syncNoteComposer = function () { if (noteSubmit) noteSubmit.disabled = !noteTextarea || !noteTextarea.value.trim(); };
      if (noteTextarea) noteTextarea.addEventListener("input", syncNoteComposer);
      composer.addEventListener("reset", function () { setTimeout(syncNoteComposer, 0); });
      composer.addEventListener("submit", function (event) {
        event.preventDefault();
        mutateCoachNote("POST", { note: { body: noteTextarea ? noteTextarea.value : "" } }, noteSubmit, composer.querySelector(".cm-notes-error"));
      });
      syncNoteComposer();
    }
    el.querySelectorAll("[data-note-edit]").forEach(function (btn) { btn.addEventListener("click", function () {
      _editingCoachNoteId = btn.getAttribute("data-note-edit");
      var panel = el.querySelector(".cm-athlete-panel");
      if (panel) { panel.innerHTML = renderAthleteNotes(ath); bindAthletePageActions(el, ath); }
    }); });
    el.querySelectorAll("[data-note-edit-cancel]").forEach(function (btn) { btn.addEventListener("click", function () {
      _editingCoachNoteId = null;
      var panel = el.querySelector(".cm-athlete-panel");
      if (panel) { panel.innerHTML = renderAthleteNotes(ath); bindAthletePageActions(el, ath); }
    }); });
    el.querySelectorAll("[data-note-edit-form]").forEach(function (form) { form.addEventListener("submit", function (event) {
      event.preventDefault();
      var textarea = form.querySelector('textarea[name="body"]');
      mutateCoachNote("PATCH", { note_id: form.getAttribute("data-note-edit-form"), note: { body: textarea ? textarea.value : "" } }, form.querySelector('[type="submit"]'), form.querySelector(".cm-notes-error"));
    }); });
    el.querySelectorAll("[data-note-pin]").forEach(function (btn) { btn.addEventListener("click", function () {
      var item = btn.closest(".cm-note-item");
      mutateCoachNote("PATCH", { note_id: btn.getAttribute("data-note-pin"), note: { pinned: btn.getAttribute("data-pinned") !== "true" } }, btn, item && item.querySelector(".cm-notes-error"));
    }); });
    el.querySelectorAll("[data-note-delete]").forEach(function (btn) { btn.addEventListener("click", function () {
      openCoachNoteDeleteConfirm(btn.getAttribute("data-note-delete"));
    }); });
    el.querySelectorAll("[data-week-shift]").forEach(function (btn) { btn.addEventListener("click", function () {
      var base = _athleteWeekStart ? new Date(_athleteWeekStart + "T00:00:00Z") : new Date();
      base.setUTCDate(base.getUTCDate() + Number(btn.getAttribute("data-week-shift")));
      openCoachAthletePage(ath.athlete_id, "training", base.toISOString().slice(0, 10));
    }); });
    el.querySelectorAll("[data-publish-week]").forEach(function (btn) { btn.addEventListener("click", function () {
      publishWeek(ath, btn.getAttribute("data-publish-week") === "discard", btn);
    }); });
    bindWorkoutDrag(el, ath);
    el.querySelectorAll("[data-add-day]").forEach(function (row) { row.addEventListener("click", function () {
      openAddDayMenu(row.getAttribute("data-add-day"), row);
    }); });
    el.querySelectorAll("[data-workout-id]").forEach(function (row) { row.addEventListener("click", function () {
      var session = ((ath.training_week || {}).sessions || []).find(function (item) { return String(item.id) === String(row.getAttribute("data-workout-id")); });
      if (session) openWorkoutEditor(session);
    }); });
  }

  /* What each "Add Activity" choice pre-fills (same four choices V.O2 offers). */
  var ACTIVITY_KINDS = [
    { id: "easy", label: "Easy Run", hint: "Steady, comfortable running", type: "Easy run", sport: "run", template: null, paceZone: "easy" },
    { id: "quality", label: "Quality Session", hint: "Warm-up, hard efforts, cool-down", type: "Quality session", sport: "run", template: "tempo", paceZone: "threshold" },
    { id: "race", label: "Race", hint: "Race day", type: "Race", sport: "run", template: null, paceZone: null },
    { id: "cross", label: "Cross Training", hint: "Bike, swim, strength or other", type: "Cross training", sport: "cross_training", template: null, paceZone: null }
  ];

  function activitySeed(kind, dateKey) {
    var seed = { date: dateKey, kind: kind.id, type: kind.type, sport: kind.sport, title: kind.type, structure: null, paceZone: kind.paceZone };
    var builder = window.AthlevoCoachWorkoutBuilder;
    var tpl = kind.template && builder && builder.TEMPLATES && builder.TEMPLATES.filter(function (t) { return t.id === kind.template; })[0];
    if (tpl) seed.structure = tpl.build();
    return seed;
  }

  /*
   * Pace guidance filled in from the athlete's own fitness (their VDOT paces from a confirmed
   * race or a recent run, the same source the builder uses). The band for each zone matches the
   * athlete's Pace Zones screen. Blank when the athlete has no usable race or run yet.
   */
  function autoPaceText(ath, zone) {
    var ZONE_BANDS = { recovery: 0.05, easy: 0.045, long: 0.045, marathon: 0.022, tempo: 0.022, threshold: 0.018, vo2: 0.02, repetition: 0.025 };
    var zones = ath && ath.training_paces && ath.training_paces.zones;
    var centre = zone && zones && zones[zone] && zones[zone].secPerKm;
    var band = ZONE_BANDS[zone];
    var SW = window.AthlevoStructuredWorkout;
    if (!centre || !band || !SW || typeof SW.fmtPace !== "function") return "";
    return SW.fmtPace(centre * (1 - band)) + "\u2013" + SW.fmtPace(centre * (1 + band)) + " /km";
  }

  /* The one target a coach sets: a distance or a time, never both. */
  function targetKindFor(source) {
    if (source && Number(source.distance_km) > 0) return "distance";
    if (source && Number(source.duration_minutes) > 0) return "time";
    return "distance";
  }

  function dayHeading(dateKey) {
    var d = new Date(dateKey + "T00:00:00Z");
    return isNaN(d.getTime()) ? dateKey : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }

  async function publishWeek(ath, discard, btn) {
    var week = ath.training_week || {};
    var weekStart = week.week_start || _athleteWeekStart;
    if (!weekStart) return;
    if (discard && !window.confirm("Discard all unpublished drafts this week? This can\u2019t be undone.")) return;
    var label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = discard ? "Discarding\u2026" : "Publishing\u2026"; }
    var res = await api("publish", { method: "POST", body: { athlete_id: ath.athlete_id, week_start: weekStart, discard: discard } });
    if (!res.ok) {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      if (typeof window.toast === "function") window.toast(saveErrorText(res, discard ? "Could not discard drafts." : "Could not publish."));
      return;
    }
    if (typeof window.toast === "function") {
      var n = res.body && (discard ? res.body.discarded : res.body.published);
      window.toast(discard ? "Drafts discarded." : (n ? n + (n === 1 ? " workout published." : " workouts published.") : "Week published."));
    }
    refreshTrainingWeek();
  }

  function refreshTrainingWeek() {
    Object.keys(_athleteDetailCache).forEach(function (key) { if (key.indexOf(String(_athleteDetailId) + "|") === 0) delete _athleteDetailCache[key]; });
    return openCoachAthletePage(_athleteDetailId, "training", _athleteWeekStart, true);
  }

  /* Move a workout to another day with the full set of its current fields (the server replaces the row). */
  async function moveWorkoutToDay(session, dateKey) {
    var workout = {
      session_date: dateKey, title: session.title, session_type: session.type, sport: session.sport,
      duration_minutes: session.duration_minutes, distance_km: session.distance_km, intensity: session.intensity,
      target_rpe: session.target_rpe, pace_guidance: session.pace_guidance, heart_rate_guidance: session.heart_rate_guidance,
      description: session.description, notes: session.notes
    };
    if (session.structure) workout.structure = session.structure;
    var res = await api("workout", { method: "PATCH", body: { athlete_id: _athleteDetailId, session_id: session.id, workout: workout } });
    if (!res.ok) {
      if (typeof window.toast === "function") window.toast(res.body && res.body.error || "The workout could not be moved.");
      return false;
    }
    if (typeof window.toast === "function") window.toast("Moved to " + dayHeading(dateKey) + ".");
    await refreshTrainingWeek();
    return true;
  }

  /*
   * Drag a workout onto an empty day (today or later). Mouse: drag the row. Touch: drag the
   * grip, so scrolling the list still works. Dropping anywhere else cancels. The click that
   * ends a drag is swallowed so it does not also open the editor.
   */
  function bindWorkoutDrag(el, ath) {
    if (ath.assignment_permission !== "read_write") return;
    var THRESHOLD = 6;
    el.querySelectorAll(".cm-day-row[data-workout-id]").forEach(function (row) {
      var session = ((ath.training_week || {}).sessions || []).find(function (item) { return String(item.id) === String(row.getAttribute("data-workout-id")); });
      if (!session || !session.can_reschedule) return;
      row.classList.add("is-draggable");
      var dragging = false;
      row.addEventListener("click", function (event) {
        if (dragging) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
      row.addEventListener("pointerdown", function (down) {
        if (down.button != null && down.button !== 0) return;
        if (down.pointerType !== "mouse" && !down.target.closest(".cm-day-grip")) return;
        var startX = down.clientX, startY = down.clientY;
        var overlayGhost = null, hovered = null, active = false;

        function targetAt(x, y) {
          var hit = document.elementFromPoint(x, y);
          var day = hit && hit.closest && hit.closest("[data-add-day]");
          return day && el.contains(day) ? day : null;
        }
        function begin() {
          active = true; dragging = true;
          var box = row.getBoundingClientRect();
          overlayGhost = row.cloneNode(true);
          overlayGhost.classList.add("cm-drag-ghost");
          overlayGhost.style.width = box.width + "px";
          overlayGhost.style.left = box.left + "px";
          overlayGhost.style.top = box.top + "px";
          document.body.appendChild(overlayGhost);
          row.classList.add("is-drag-source");
          el.classList.add("is-dragging-workout");
          document.body.style.userSelect = "none";
        }
        function onMove(move) {
          if (!active) {
            if (Math.abs(move.clientX - startX) < THRESHOLD && Math.abs(move.clientY - startY) < THRESHOLD) return;
            begin();
          }
          move.preventDefault();
          overlayGhost.style.transform = "translate3d(" + (move.clientX - startX) + "px," + (move.clientY - startY) + "px,0)";
          var next = targetAt(move.clientX, move.clientY);
          if (next !== hovered) {
            if (hovered) hovered.classList.remove("is-drop-target");
            hovered = next;
            if (hovered) hovered.classList.add("is-drop-target");
          }
        }
        function finish(up, cancelled) {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          if (!active) return;
          var target = cancelled ? null : targetAt(up.clientX, up.clientY);
          if (overlayGhost) overlayGhost.remove();
          row.classList.remove("is-drag-source");
          el.classList.remove("is-dragging-workout");
          if (hovered) hovered.classList.remove("is-drop-target");
          document.body.style.userSelect = "";
          setTimeout(function () { dragging = false; }, 0);
          if (target) {
            row.classList.add("is-moving");
            moveWorkoutToDay(session, target.getAttribute("data-add-day")).then(function (moved) { if (!moved) row.classList.remove("is-moving"); });
          }
        }
        function onUp(up) { finish(up, false); }
        function onCancel(up) { finish(up, true); }
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
      });
    });
  }

  /* Tap an empty day: Add Activity / Add Rest Day, then the four activity types. */
  function openAddDayMenu(dateKey, returnFocus) {
    if (!_athleteDetail || document.getElementById("cmAddDayOverlay")) return;
    var overlay = document.createElement("div");
    overlay.className = "cm-workout-overlay";
    overlay.id = "cmAddDayOverlay";
    var heading = esc(dayHeading(dateKey));
    function stepOne() {
      return '<button type="button" class="cm-add-choice" data-add-step="activity"><span><b>Add Activity</b><small>Easy run, quality session, race or cross training</small></span><i aria-hidden="true">›</i></button>' +
        '<button type="button" class="cm-add-choice" data-add-step="rest"><span><b>Add Rest Day</b><small>Tell the athlete to take the day off</small></span></button>' +
        '<button type="button" class="cm-add-choice" data-add-step="note"><span><b>Add Note</b><small>A message the athlete sees on this day</small></span><i aria-hidden="true">\u203a</i></button>';
    }
    function stepNote() {
      return '<button type="button" class="cm-add-back" data-add-step="back">\u2039 Back</button>' +
        '<div class="cm-field"><label for="cmNoteText">Note for ' + heading + '</label><textarea id="cmNoteText" rows="4" maxlength="1200" placeholder="Add a note, suggestion or tip\u2026"></textarea></div>' +
        '<button type="button" class="cm-week-btn cm-week-btn--primary cm-add-save" data-add-step="save-note">Save note</button>';
    }
    function stepTwo() {
      return '<button type="button" class="cm-add-back" data-add-step="back">‹ Back</button>' + ACTIVITY_KINDS.map(function (kind) {
        return '<button type="button" class="cm-add-choice" data-add-kind="' + kind.id + '"><span><b>' + esc(kind.label) + '</b><small>' + esc(kind.hint) + '</small></span><i aria-hidden="true">›</i></button>';
      }).join("");
    }
    overlay.innerHTML = '<div class="cm-workout-dialog cm-add-menu" role="dialog" aria-modal="true" aria-label="Add to ' + heading + '"><div class="cm-workout-dialog-head"><h2>' + heading + '</h2><button type="button" class="cm-dialog-close" aria-label="Close">×</button></div><div class="cm-add-list" id="cmAddList">' + stepOne() + '</div><div class="cm-form-error" id="cmAddError" aria-live="polite"></div></div>';
    document.body.appendChild(overlay);
    var previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    var list = overlay.querySelector("#cmAddList");
    var error = overlay.querySelector("#cmAddError");
    var onKey = function (event) { if (event.key === "Escape") close(); };
    var close = function () {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      overlay.remove();
      if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", function (event) { if (event.target === overlay) close(); });
    overlay.querySelector(".cm-dialog-close").addEventListener("click", close);
    function focusFirst() { var first = list.querySelector("button"); if (first) first.focus(); }
    list.addEventListener("click", async function (event) {
      var target = event.target.closest("button");
      if (!target) return;
      var step = target.getAttribute("data-add-step");
      var kindId = target.getAttribute("data-add-kind");
      if (step === "activity") { list.innerHTML = stepTwo(); focusFirst(); return; }
      if (step === "note") { list.innerHTML = stepNote(); var field = list.querySelector("textarea"); if (field) field.focus(); return; }
      if (step === "save-note") {
        var text = (list.querySelector("textarea").value || "").trim();
        if (!text) { error.textContent = "Write the note first."; return; }
        list.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
        error.textContent = "";
        var saved = await api("workout", { method: "POST", body: { athlete_id: _athleteDetailId, workout: { session_date: dateKey, title: "Coach note", session_type: "Note", sport: "other", description: text } } });
        if (!saved.ok) {
          list.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
          error.textContent = saveErrorText(saved, "The note could not be saved.");
          return;
        }
        close();
        if (typeof window.toast === "function") window.toast("Note added.");
        refreshTrainingWeek();
        return;
      }
      if (step === "back") { list.innerHTML = stepOne(); focusFirst(); return; }
      if (kindId) {
        var kind = ACTIVITY_KINDS.filter(function (item) { return item.id === kindId; })[0];
        close();
        openWorkoutEditor(null, activitySeed(kind, dateKey));
        return;
      }
      if (step === "rest") {
        list.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
        error.textContent = "";
        var res = await api("workout", { method: "POST", body: { athlete_id: _athleteDetailId, workout: { session_date: dateKey, title: "Rest day", session_type: "Rest day", sport: "rest" } } });
        if (!res.ok) {
          list.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
          error.textContent = saveErrorText(res, "The rest day could not be added.");
          return;
        }
        close();
        if (typeof window.toast === "function") window.toast("Rest day added.");
        refreshTrainingWeek();
      }
    });
    focusFirst();
  }

  function openWorkoutEditor(session, preset) {
    var ath = _athleteDetail;
    if (!ath) return;
    var seed = !session && preset ? preset : null;
    var canWrite = ath.assignment_permission === "read_write";
    var editable = canWrite && (!session || session.can_edit);
    var returnFocus = document.activeElement;
    var overlay = document.createElement("div");
    overlay.className = "cm-workout-overlay";
    overlay.id = "cmWorkoutOverlay";
    var value = function (key) { var source = session || seed; return esc(source && source[key] != null ? source[key] : ""); };
    var off = !editable ? "disabled" : "";
    var heading = session ? "Workout details" : dayHeading(seed ? seed.date : "") + (seed && seed.type ? " \u00b7 " + seed.type : "");
    var athleteFirstName = String(ath.athlete_name || ath.name || ath.full_name || "").split(" ")[0];
    var paceAuto = seed ? autoPaceText(ath, seed.paceZone) : "";
    var showBuilder = Boolean(session && session.structure || seed && seed.structure);
    var targetKind = targetKindFor(session);
    var targetValue = session ? (targetKind === "distance" ? session.distance_km : session.duration_minutes) : "";
    if (targetValue == null || Number(targetValue) <= 0) targetValue = "";
    // V.O2-style: a workout is a draft until published. New workouts and existing drafts show
    // Publish alongside Save; an already-published workout just saves its changes.
    var showPublish = editable && (!session || session.published === false);
    var saveLabel = session ? (session.published === false ? "Save draft" : "Save changes") : "Save draft";
    var footerButtons = !editable
      ? '<button type="button" class="cm-week-btn cm-dialog-close">Close</button>'
      : '<button type="button" class="cm-week-btn cm-dialog-close">Cancel</button>'
        + '<button type="submit" class="cm-week-btn' + (showPublish ? '' : ' cm-week-btn--primary') + '" id="cmSaveWorkout">' + saveLabel + '</button>'
        + (showPublish ? '<button type="button" class="cm-week-btn cm-week-btn--primary" id="cmPublishWorkout">Publish</button>' : '');
    overlay.innerHTML = '<div class="cm-workout-dialog cm-editor" role="dialog" aria-modal="true" aria-label="' + esc(session ? "Workout details" : "Add workout") + '"><div class="cm-workout-dialog-head"><h2>' + esc(heading) + '</h2><button type="button" class="cm-dialog-close" aria-label="Close">\u00d7</button></div><form class="cm-workout-form" id="cmWorkoutForm">' +
      (session
        ? '<div class="cm-field cm-field--full"><label for="cmWorkoutDate">Move to</label><input id="cmWorkoutDate" name="session_date" type="date" required value="' + value("date") + '" ' + (!editable || !session.can_reschedule ? "disabled" : "") + '></div>'
        : '<input type="hidden" name="session_date" value="' + value("date") + '">') +
      '<input type="hidden" name="session_type" value="' + value("type") + '"><input type="hidden" name="sport" value="' + value("sport") + '">' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutTitle">Title</label><input id="cmWorkoutTitle" name="title" required value="' + value("title") + '" ' + off + '></div>' +
      '<div class="cm-field cm-field--full cm-target" id="cmTargetField"><span class="cm-field-label" id="cmTargetLabel">Target</span>' +
        '<div class="cm-target-row"><div class="cm-seg" role="group" aria-labelledby="cmTargetLabel"><button type="button" class="cm-seg-btn" data-target-kind="distance" aria-pressed="' + (targetKind === "distance") + '" ' + off + '>Distance</button><button type="button" class="cm-seg-btn" data-target-kind="time" aria-pressed="' + (targetKind === "time") + '" ' + off + '>Time</button></div>' +
        '<div class="cm-target-input"><input id="cmTargetValue" type="number" min="0" step="any" inputmode="decimal" aria-labelledby="cmTargetLabel" value="' + esc(targetValue) + '" ' + off + '><span class="cm-target-unit" id="cmTargetUnit">' + (targetKind === "distance" ? "km" : "min") + '</span></div></div>' +
        '<small class="cm-field-hint" id="cmTargetHint">Set a distance or a time, not both.</small></div>' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutRpe">Target RPE</label><input id="cmWorkoutRpe" name="target_rpe" inputmode="numeric" placeholder="1\u201310" value="' + value("target_rpe") + '" ' + off + '></div>' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutPace">Pace guidance</label><input id="cmWorkoutPace" name="pace_guidance" placeholder="e.g. 5:30\u20136:00 /km" value="' + (session ? value("pace_guidance") : esc(paceAuto)) + '" ' + off + '>' +
        (seed && paceAuto ? '<small class="cm-field-hint">Set automatically from ' + esc(athleteFirstName || "the athlete") + '\u2019s pace zones. Edit it if you want.</small>' : '') +
        (seed && !paceAuto && seed.paceZone ? '<small class="cm-field-hint">' + esc(athleteFirstName || "This athlete") + ' has no pace zones yet (they need a recent run or race). Type a pace if you want one.</small>' : '') + '</div>' +
      '<div class="cm-field cm-field--full" id="cmBuilderMount"' + (showBuilder ? '' : ' hidden') + '></div>' +
      (editable && !showBuilder ? '<button type="button" class="cm-add-steps cm-field--full" id="cmAddSteps">+ Build it in steps (warm-up, intervals, cool-down)</button>' : '') +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutDescription">Description</label><textarea id="cmWorkoutDescription" name="description" rows="2" ' + off + '>' + value("description") + '</textarea></div>' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutNotes">Workout notes</label><textarea id="cmWorkoutNotes" name="notes" rows="3" placeholder="Add workout notes, suggestions or tips\u2026" ' + off + '>' + value("notes") + '</textarea></div>' +
      '<div class="cm-form-error" id="cmWorkoutError" aria-live="polite"></div><div class="cm-form-actions">' + (session && session.can_remove && canWrite ? '<button type="button" class="cm-week-btn cm-danger" id="cmRemoveWorkout">Remove from plan</button>' : '<span></span>') + '<div class="cm-form-actions-right">' + footerButtons + '</div></div></form></div>';
    document.body.appendChild(overlay);

    // Structured builder: shows the athlete's own paces, previews the shape,
    // and saves to / loads from the coach's library. Falls back to the simple
    // fields when the coach adds no steps. Quality sessions start with it open;
    // other workouts offer it behind "Build it in steps".
    var builderHost = overlay.querySelector("#cmBuilderMount");
    function mountBuilder(structure) {
      if (!builderHost || !window.AthlevoCoachWorkoutBuilder || overlay._builder) return;
      builderHost.hidden = false;
      var flatFieldIds = ["cmTargetField", "cmWorkoutPace"];
      overlay._builder = window.AthlevoCoachWorkoutBuilder.mount(builderHost, {
        structure: structure,
        paces: ath.training_paces || null,
        athleteName: athleteFirstName,
        readOnly: !editable,
        library: editable ? workoutLibrary : null,
        onChange: function (state) {
          flatFieldIds.forEach(function (id) {
            var field = overlay.querySelector("#" + id);
            field = field && field.closest(".cm-field");
            if (field) field.hidden = state.hasSteps;
          });
        },
        onLoadLibraryItem: function (item) {
          var title = overlay.querySelector("#cmWorkoutTitle");
          if (title && !title.value) title.value = item.name;
        }
      });
    }
    if (showBuilder && (editable || session && session.structure)) mountBuilder(session && session.structure || seed && seed.structure || null);
    var addSteps = overlay.querySelector("#cmAddSteps");
    if (addSteps) addSteps.addEventListener("click", function () { addSteps.hidden = true; mountBuilder(null); });
    // One target: distance or time. Switching clears the number so 8 km never turns into 8 minutes by accident.
    var targetField = overlay.querySelector("#cmTargetField");
    if (targetField) {
      var targetInput = targetField.querySelector("#cmTargetValue");
      var targetUnit = targetField.querySelector("#cmTargetUnit");
      var targetHint = targetField.querySelector("#cmTargetHint");
      var currentKind = targetKind;
      var paceInput = overlay.querySelector("#cmWorkoutPace");
      var refreshTargetHint = function () {
        if (!targetHint) return;
        var amount = Number(targetInput.value);
        var centre = ath && ath.training_paces && ath.training_paces.zones && seed && seed.paceZone && ath.training_paces.zones[seed.paceZone] && ath.training_paces.zones[seed.paceZone].secPerKm;
        if (!(amount > 0) || !centre) { targetHint.textContent = "Set a distance or a time, not both."; return; }
        if (currentKind === "distance") {
          var mins = Math.round(amount * centre / 60);
          targetHint.textContent = "About " + mins + " min at " + (athleteFirstName || "their") + (athleteFirstName ? "\u2019s" : "") + " pace.";
        } else {
          var km = Math.round(amount * 60 / centre * 10) / 10;
          targetHint.textContent = "About " + km + " km at " + (athleteFirstName || "their") + (athleteFirstName ? "\u2019s" : "") + " pace.";
        }
      };
      targetField.querySelectorAll("[data-target-kind]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var nextKind = btn.getAttribute("data-target-kind");
          if (nextKind !== currentKind) targetInput.value = "";
          currentKind = nextKind;
          targetField.querySelectorAll("[data-target-kind]").forEach(function (other) { other.setAttribute("aria-pressed", String(other === btn)); });
          if (targetUnit) targetUnit.textContent = currentKind === "distance" ? "km" : "min";
          targetInput.step = "any";
          refreshTargetHint();
          targetInput.focus();
        });
      });
      targetInput.addEventListener("input", refreshTargetHint);
      targetField._getTarget = function () { return { kind: currentKind, value: targetInput.value }; };
      refreshTargetHint();
    }
    var previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    var onKey = function (event) { if (event.key === "Escape") close(); };
    var close = function () {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      overlay.remove();
      if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    };
    overlay._closeCoachWorkout = close;
    var dialog = overlay.querySelector(".cm-workout-dialog");
    var focusable = function () { return Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')); };
    var trapFocus = function (event) {
      if (event.key !== "Tab") return;
      var items = focusable();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    dialog.addEventListener("keydown", trapFocus);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    overlay.querySelectorAll(".cm-dialog-close").forEach(function (btn) { btn.addEventListener("click", close); });
    var form = overlay.querySelector("#cmWorkoutForm");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); saveWorkoutForm(form, session, overlay, { publish: false, button: overlay.querySelector("#cmSaveWorkout") }); });
    var publishBtn = overlay.querySelector("#cmPublishWorkout");
    if (publishBtn) publishBtn.addEventListener("click", function () { saveWorkoutForm(form, session, overlay, { publish: true, button: publishBtn }); });
    var remove = overlay.querySelector("#cmRemoveWorkout");
    if (remove) remove.addEventListener("click", function () { removeWorkout(session, overlay); });
    var initialFocus = dialog.querySelector("input:not([disabled]):not([type=hidden]), textarea:not([disabled])") || dialog.querySelector("button");
    if (initialFocus) initialFocus.focus();
  }

  /* The server's message, plus its technical detail when it sends one, so a failure can be reported and fixed. */
  function saveErrorText(res, fallback) {
    var body = res && res.body || {};
    var text = body.error || fallback;
    if (body.detail) text += " (" + String(body.detail).slice(0, 160) + ")";
    return text;
  }

  async function saveWorkoutForm(form, session, overlay, opts) {
    opts = opts || {};
    var publish = opts.publish === true;
    var error = form.querySelector("#cmWorkoutError");
    var acting = opts.button || form.querySelector('[type="submit"]');
    var actionButtons = Array.prototype.slice.call(form.querySelectorAll(".cm-form-actions button"));
    var actingLabel = acting ? acting.textContent : "Save";
    var data = new FormData(form);
    var workout = {};
    data.forEach(function (value, key) { workout[key] = value; });
    var targetFieldEl = form.querySelector("#cmTargetField");
    var target = targetFieldEl && targetFieldEl._getTarget ? targetFieldEl._getTarget() : null;
    if (target) {
      // Only the chosen target is saved; the other one is cleared.
      workout.distance_km = target.kind === "distance" ? target.value : "";
      workout.duration_minutes = target.kind === "time" ? target.value : "";
    }
    var builder = overlay._builder;
    if (builder && builder.hasSteps()) {
      var checked = builder.validate();
      if (!checked.ok) { if (error) error.textContent = checked.error; return; }
      workout.structure = checked.value;
      // Derived from the steps and this athlete's paces on the server.
      delete workout.duration_minutes;
      delete workout.distance_km;
      delete workout.pace_guidance;
      delete workout.intensity;
      if (/^\d+ min(?: · [\d.]+ km)?$/.test(String(workout.description || ""))) delete workout.description;
    } else if (builder && session && session.structure) {
      workout.structure = null;
      workout.clear_structure = true;
    }
    if (error) error.textContent = "";
    actionButtons.forEach(function (b) { b.disabled = true; });
    if (acting) acting.textContent = publish ? "Publishing…" : "Saving…";
    var res = await api("workout", { method: session ? "PATCH" : "POST", body: { athlete_id: _athleteDetailId, session_id: session && session.id, workout: workout, publish: publish } });
    if (!res.ok) {
      if (error) error.textContent = saveErrorText(res, "The workout could not be saved.");
      actionButtons.forEach(function (b) { b.disabled = false; });
      if (acting) acting.textContent = actingLabel;
      return;
    }
    if (overlay._closeCoachWorkout) overlay._closeCoachWorkout(); else overlay.remove();
    if (typeof window.toast === "function") {
      var moved = session && workout.session_date && String(workout.session_date) !== String(session.date || "");
      var name = String((_athleteDetail && (_athleteDetail.athlete_name || _athleteDetail.name || _athleteDetail.full_name)) || "").split(" ")[0];
      var published = res.body && res.body.published === true;
      window.toast(
        publish ? (published ? "Published" + (name ? " to " + name : "") + "." : "Workout saved.")
        : moved ? "Workout rescheduled."
        : !session ? (res.body && res.body.published === true ? "Workout added." : "Saved as draft \u2014 publish it when you\u2019re ready.")
        : session.published === false ? "Draft saved."
        : "Workout updated."
      );
    }
    refreshTrainingWeek();
  }

  async function removeWorkout(session, overlay) {
    if (!window.confirm("Remove this workout from the athlete's plan?")) return;
    var error = overlay.querySelector("#cmWorkoutError");
    var res = await api("workout", { method: "DELETE", body: { athlete_id: _athleteDetailId, session_id: session.id } });
    if (!res.ok) { if (error) error.textContent = res.body && res.body.error || "The workout could not be removed."; return; }
    if (overlay._closeCoachWorkout) overlay._closeCoachWorkout(); else overlay.remove();
    Object.keys(_athleteDetailCache).forEach(function (key) { if (key.indexOf(String(_athleteDetailId) + "|") === 0) delete _athleteDetailCache[key]; });
    openCoachAthletePage(_athleteDetailId, "training", _athleteWeekStart, true);
  }

  async function markAthleteReviewed(athleteId, btn) {
    var entry = _roster.find(function (a) { return a.athlete_id === athleteId; });
    var keys = (entry && entry.attention_reason_keys) || ["reviewed"];
    if (btn) { btn.disabled = true; btn.textContent = "Reviewing…"; }
    for (var i = 0; i < keys.length; i++) {
      await api("review", { method: "POST", body: { athlete_id: athleteId, alert_key: keys[i] } });
    }
    trackCoach("coach_attention_item_reviewed", {
      attention_reason: keys[0] || "reviewed",
      attention_severity: (entry && entry.attention_severity) || "none",
      athlete_sport: (entry && entry.primary_sport) || "unknown"
    });
    if (btn) btn.textContent = "Reviewed";
  }

  /* ═══════════════════════ COACH WORKSPACE TABS ════════════════════ */

  /* ─── Coach (Messaging) Tab ─── */
  function activateCoachScreen(screenId) {
    var screen = document.getElementById(screenId);
    var tab = document.querySelector('#tabbar .tab[data-screen="' + screenId + '"]');
    if (window.AthlevoAppMotion && tab) {
      window.AthlevoAppMotion.selectTab(tab, true);
      window.AthlevoAppMotion.transitionTo(screenId);
    } else {
      document.querySelectorAll(".screen").forEach(function (item) { item.classList.remove("active"); });
      if (screen) screen.classList.add("active");
      document.querySelectorAll("#tabbar .tab").forEach(function (item) {
        item.classList.toggle("on", item.getAttribute("data-screen") === screenId);
      });
    }
    return screen;
  }

  function rosterAthlete(athleteId) {
    return _roster.find(function (athlete) { return String(athlete.athlete_id) === String(athleteId); }) ||
      (_athleteDetail && String(_athleteDetail.athlete_id) === String(athleteId) ? _athleteDetail : null);
  }

  function coachMessageTime(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function coachMessageDayKey(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  function coachMessageDayLabel(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    var today = new Date();
    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (coachMessageDayKey(date) === coachMessageDayKey(today)) return "Today";
    if (coachMessageDayKey(date) === coachMessageDayKey(yesterday)) return "Yesterday";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function renderCoachMessageHistory(messages) {
    var day = null;
    return messages.map(function (message) {
      var key = coachMessageDayKey(message.created_at);
      var separator = key && key !== day
        ? '<div class="cm-msg-date" data-message-day="' + esc(key) + '">' + esc(coachMessageDayLabel(message.created_at)) + '</div>'
        : "";
      day = key || day;
      return separator + '<article class="cm-msg-bubble ' + (message.sender_role === "coach" ? "is-coach" : "is-athlete") + '"><p>' + esc(message.body) + '</p><time datetime="' + esc(message.created_at) + '">' + esc(coachMessageTime(message.created_at)) + '</time></article>';
    }).join("");
  }

  function renderCoachThread(athleteId, thread) {
    var athlete = rosterAthlete(athleteId);
    var messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
    var backLabel = _messageOrigin === "athlete_detail" ? "← " + (athlete && athlete.name || "Athlete") : "← Messages";
    var history = thread && thread.error
      ? '<div class="cm-msg-thread-empty"><strong>Messages unavailable.</strong><p>' + esc(thread.error) + '</p></div>'
      : messages.length
      ? renderCoachMessageHistory(messages)
      : '<div class="cm-msg-thread-empty"><strong>No messages yet.</strong><p>Start a conversation with ' + esc(athlete && athlete.name || "this athlete") + '.</p></div>';
    var composer = thread && thread.can_send
      ? '<form class="cm-msg-composer" id="cmMessageComposer"><textarea name="body" maxlength="4000" rows="1" aria-label="Message ' + esc(athlete && athlete.name || "athlete") + '" placeholder="Write a message…"></textarea><button type="submit" class="cm-msg-send" disabled>Send</button><div class="cm-msg-error" aria-live="polite"></div></form>'
      : '<p class="cm-notes-readonly">This conversation is view-only.</p>';
    return '<div class="cm-msg-thread" data-message-athlete="' + esc(athleteId) + '"><header class="cm-msg-thread-head"><button type="button" class="cm-msg-thread-back">' + esc(backLabel) + '</button><div class="cm-msg-thread-title"><strong>' + esc(athlete && athlete.name || "Athlete") + '</strong><span>Athlete</span></div>' + (_messageOrigin === "global" ? '<button type="button" class="cm-msg-athlete-detail">View athlete</button>' : '<span></span>') + '</header><div class="cm-msg-log" id="cmMessageLog"><div class="cm-msg-log-inner">' + history + '</div></div>' + composer + '</div>';
  }

  function renderCoachThreadLoading(athleteId) {
    var athlete = rosterAthlete(athleteId);
    return '<div class="cm-msg-thread" data-message-athlete="' + esc(athleteId) + '"><header class="cm-msg-thread-head"><button type="button" class="cm-msg-thread-back">←</button><div class="cm-msg-thread-title"><strong>' + esc(athlete && athlete.name || "Athlete") + '</strong><span>Athlete</span></div><span></span></header><div class="cm-msg-log"><div class="cm-msg-loading" role="status" aria-label="Loading conversation"><span class="skel"></span><span class="skel"></span><span class="skel"></span></div></div></div>';
  }

  function coachMessageNearBottom(log) {
    return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 96;
  }

  function scrollCoachMessages(log, behavior) {
    if (!log) return;
    if (typeof log.scrollTo === "function") {
      log.scrollTo({ top: log.scrollHeight, behavior: behavior || "auto" });
    } else {
      log.scrollTop = log.scrollHeight;
    }
  }

  function coachMessageScrollSnapshot(log) {
    return log ? {
      nearBottom: coachMessageNearBottom(log),
      top: log.scrollTop,
      height: log.scrollHeight
    } : { nearBottom: true, top: 0, height: 0 };
  }

  function restoreCoachMessageScroll(log, snapshot, behavior) {
    if (!log || !snapshot) return;
    if (snapshot.nearBottom) {
      scrollCoachMessages(log, behavior || "auto");
      return;
    }
    log.scrollTop = snapshot.top + Math.max(0, log.scrollHeight - snapshot.height);
  }

  function resizeCoachMessageInput(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight || 40, 96) + "px";
  }

  function bindCoachThread(el, athleteId) {
    var back = el.querySelector(".cm-msg-thread-back");
    if (back) back.addEventListener("click", function () {
      _messageRequest += 1;
      if (_messageOrigin === "athlete_detail" && _athleteDetailId && _athleteDetail) {
        activateCoachScreen("screen-today");
        _athleteDetailTab = _messageReturnTab || "overview";
        renderAthletePage();
        var today = document.getElementById("screen-today");
        if (today) today.scrollTop = _athleteDetailScrollTop;
      } else {
        _messageOrigin = "global";
        renderCoachMessaging();
      }
    });
    var viewAthlete = el.querySelector(".cm-msg-athlete-detail");
    if (viewAthlete) viewAthlete.addEventListener("click", function () {
      _messageRequest += 1;
      activateCoachScreen("screen-today");
      openCoachAthletePage(athleteId, "overview");
    });
    var form = el.querySelector("#cmMessageComposer");
    if (form) {
      var composerTextarea = form.querySelector('textarea[name="body"]');
      var composerSend = form.querySelector('[type="submit"]');
      var syncComposer = function () {
        resizeCoachMessageInput(composerTextarea);
        if (composerSend) composerSend.disabled = !composerTextarea || !composerTextarea.value.trim();
      };
      if (composerTextarea) {
        composerTextarea.addEventListener("input", syncComposer);
        composerTextarea.addEventListener("keydown", function (event) {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            if (form.dataset.sending !== "true" && composerTextarea.value.trim() && typeof form.requestSubmit === "function") form.requestSubmit();
          }
        });
      }
      syncComposer();
      form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var textarea = form.querySelector('textarea[name="body"]');
      var send = form.querySelector('[type="submit"]');
      var error = form.querySelector(".cm-msg-error");
      var body = textarea ? textarea.value.trim() : "";
      if (!body || form.dataset.sending === "true") return;
      form.dataset.sending = "true";
      if (send) send.disabled = true;
      if (error) error.textContent = "";
      var log = el.querySelector("#cmMessageLog");
      var scrollSnapshot = coachMessageScrollSnapshot(log);
      var inner = log && log.querySelector(".cm-msg-log-inner");
      var pending = document.createElement("article");
      pending.className = "cm-msg-bubble is-coach is-pending";
      pending.setAttribute("aria-label", "Sending message");
      pending.innerHTML = "<p>" + esc(body) + "</p><time>Sending…</time>";
      if (inner) {
        var empty = inner.querySelector(".cm-msg-thread-empty");
        var removedEmpty = empty || null;
        if (empty) empty.remove();
        inner.appendChild(pending);
        if (scrollSnapshot.nearBottom) scrollCoachMessages(log, "smooth");
      }
      var requestId = ++_messageRequest;
      var res = await api("messages", { method: "POST", body: { athlete_id: athleteId, message: { body: body } } });
      if (requestId !== _messageRequest || !el.classList.contains("active")) {
        if (pending && pending.parentNode) pending.remove();
        if (removedEmpty && inner && !inner.querySelector(".cm-msg-thread-empty")) inner.appendChild(removedEmpty);
        return;
      }
      if (!res.ok || !res.body || !res.body.thread) {
        if (pending && pending.parentNode) pending.remove();
        if (removedEmpty && inner && !inner.querySelector(".cm-msg-thread-empty")) inner.appendChild(removedEmpty);
        if (error) error.textContent = res.body && res.body.error || "The message could not be sent.";
        if (send) send.disabled = false;
        form.dataset.sending = "false";
        return;
      }
      _messageThreadCache[String(athleteId)] = res.body.thread;
      el.innerHTML = renderCoachThread(athleteId, res.body.thread);
      bindCoachThread(el, athleteId);
      var confirmedLog = el.querySelector("#cmMessageLog");
      scrollSnapshot.nearBottom = true;
      restoreCoachMessageScroll(confirmedLog, scrollSnapshot, "smooth");
    });
    }
  }

  async function openAthleteMessaging(athleteId, origin, returnTab) {
    var athlete = rosterAthlete(athleteId);
    if (!athlete) return;
    _messageOrigin = origin === "athlete_detail" ? "athlete_detail" : "global";
    _messageReturnTab = returnTab || "overview";
    var el = activateCoachScreen("screen-coach-messaging");
    if (!el) return;
    var cached = _messageThreadCache[String(athleteId)];
    if (cached) {
      el.innerHTML = renderCoachThread(athleteId, cached);
      bindCoachThread(el, athleteId);
      scrollCoachMessages(el.querySelector("#cmMessageLog"), "auto");
    } else {
      el.innerHTML = renderCoachThreadLoading(athleteId);
      bindCoachThread(el, athleteId);
    }
    var requestId = ++_messageRequest;
    var res = await api("messages", { query: { athlete_id: athleteId } });
    if (requestId !== _messageRequest || !el.classList.contains("active")) return;
    if (!res.ok || !res.body || !res.body.thread) {
      el.innerHTML = renderCoachThread(athleteId, {
        messages: [],
        can_send: false,
        error: res.status === 403 ? "You are not assigned to this athlete." : "Try again in a moment."
      });
      bindCoachThread(el, athleteId);
      return;
    }
    var scrollSnapshot = coachMessageScrollSnapshot(el.querySelector("#cmMessageLog"));
    _messageThreadCache[String(athleteId)] = res.body.thread;
    el.innerHTML = renderCoachThread(athleteId, res.body.thread);
    bindCoachThread(el, athleteId);
    var log = el.querySelector("#cmMessageLog");
    restoreCoachMessageScroll(log, scrollSnapshot, "auto");
  }

  function renderCoachMessaging() {
    var el = document.getElementById("screen-coach-messaging");
    if (!el) return;
    _messageRequest += 1;
    _messageOrigin = "global";
    var sorted = sortRoster(_roster);
    var html = '<div class="cm-msg-directory"><h1>Coach Messaging</h1>';
    if (!sorted.length) {
      html += '<div class="cm-msg-empty-directory"><strong>No athletes assigned yet</strong><span>Assigned athletes will appear here.</span></div>';
    } else {
      sorted.forEach(function (a) {
        var cached = _messageThreadCache[String(a.athlete_id)];
        var count = cached && Array.isArray(cached.messages) ? cached.messages.length : null;
        html += '<button type="button" class="cm-msg-item" data-athlete="' + esc(a.athlete_id) + '"><span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span><span class="cm-msg-item-copy"><span class="cm-msg-item-name">' + esc(a.name) + '</span><span class="cm-msg-item-meta">' + (count == null ? "Open conversation" : count ? count + (count === 1 ? " message" : " messages") : "No messages yet") + '</span></span><span class="cm-msg-item-arrow">›</span></button>';
      });
    }
    html += '</div>';
    el.innerHTML = html;
    el.querySelectorAll(".cm-msg-item").forEach(function (item) {
      item.addEventListener("click", function () {
        openAthleteMessaging(item.getAttribute("data-athlete"), "global", "overview");
      });
    });
  }

  /* ─── Trends Tab ─── */
  function renderCoachTrends() {
    var el = document.getElementById("screen-coach-trends");
    if (!el) return;
    var sorted = sortRoster(_roster);
    var html = '<div class="cm-global-directory"><header class="cm-global-head"><h1>Athlete Analytics</h1><p>Choose an athlete to open their decision-oriented training analysis.</p></header>';
    if (!sorted.length) {
      html += '<div class="cm-global-empty">Assigned athletes will appear here.</div>';
    } else {
      html += '<div class="cm-global-list">';
      sorted.forEach(function (a) {
        var readiness = a.readiness_status && a.readiness_status !== "No recent data" ? a.readiness_status + " readiness" : "Readiness unavailable";
        var context = [SPORT_LABEL[a.primary_sport] || "Athlete", a.goal].filter(Boolean).join(" · ");
        html += '<button type="button" class="cm-global-athlete cm-trends-item" data-athlete="' + esc(a.athlete_id) + '"><span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span><span class="cm-global-copy"><span class="cm-global-name">' + esc(a.name) + '</span><span class="cm-global-primary">' + esc(context) + '</span><span class="cm-global-meta">' + esc(readiness) + (a.adherence_pct != null ? ' · ' + esc(a.adherence_pct + "% adherence") : '') + '</span></span><span class="cm-chevron" aria-hidden="true">›</span></button>';
      });
      html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
    el.querySelectorAll(".cm-trends-item").forEach(function (item) {
      item.addEventListener("click", function () {
        openCoachAthletePage(item.getAttribute("data-athlete"), "analytics");
      });
    });
  }

  /* ─── You Tab ─── */
  function renderCoachYou() {
    var el = document.getElementById("screen-coach-you");
    if (!el) return;
    var name = _coachName || "Coach";
    var role = _role || "coach";
    var html = '<div style="max-width:720px;margin:0 auto;padding:16px 0 96px;">' +
      // Profile header
      '<div class="profilehead">' +
        '<div class="pfp serif" style="width:56px;height:56px;font-size:20px;">' + esc(name.split(" ").map(function(w){return w[0];}).join("").toUpperCase().slice(0,2) || "C") + '</div>' +
        '<div>' +
          '<h1 class="serif" style="font-size:var(--fs-h1);font-weight:500;margin:0;">' + esc(name) + '</h1>' +
          '<p style="font-size:var(--fs-body-sm);color:var(--ink2);margin:2px 0 0;text-transform:capitalize;">' + esc(role) + '</p>' +
        '</div>' +
      '</div>' +
      // Stats
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 22px 20px;">' +
        '<div style="background:var(--card,#f6f6f4);border:1px solid var(--line,#ebebe8);border-radius:var(--r-lg);padding:14px;text-align:center;">' +
          '<div style="font-size:24px;font-weight:700;">' + _roster.length + '</div>' +
          '<div style="font-size:var(--fs-caption);color:var(--ink3);">Active athletes</div>' +
        '</div>' +
        '<div style="background:var(--card,#f6f6f4);border:1px solid var(--line,#ebebe8);border-radius:var(--r-lg);padding:14px;text-align:center;">' +
          '<div style="font-size:24px;font-weight:700;color:var(--ink3);">—</div>' +
          '<div style="font-size:var(--fs-caption);color:var(--ink3);">Athlete capacity</div>' +
        '</div>' +
      '</div>' +

      // ── Workspace ──
      '<div class="pad"><div class="section-title serif">Workspace</div></div>' +
      '<div class="rowlink" id="cmSwitchToAthlete" style="cursor:pointer">' +
        '<div><b>Switch to Athlete Workspace</b><small>Return to your athlete workspace.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" id="cmOpenDashboardCoachYou" style="cursor:pointer">' +
        '<div><b>Open My Athletes</b><small>View and manage your athletes.</small></div><span class="arr">→</span>' +
      '</div>' +

      '<div class="spacer-md"></div>' +

      // ── Preferences ──
      '<div class="pad"><div class="section-title serif">Preferences</div></div>' +
      '<div class="appearance appearance-row">' +
        '<span class="appearance-label">Appearance</span>' +
        '<div class="seg" id="coachThemeSeg" role="group" aria-label="Theme">' +
          '<button type="button" class="seg-btn" data-theme-choice="system" onclick="setAthlevoTheme(\'system\')">System</button>' +
          '<button type="button" class="seg-btn" data-theme-choice="light" onclick="setAthlevoTheme(\'light\')">Light</button>' +
          '<button type="button" class="seg-btn" data-theme-choice="dark" onclick="setAthlevoTheme(\'dark\')">Dark</button>' +
        '</div>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" id="coachYouInstallRow" onclick="typeof athlevoInstall===\'function\'?athlevoInstall():void 0">' +
        '<div><b>Install Athlevo</b><small>Add Athlevo to your home screen.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" onclick="toast(\'Notification settings coming soon\')">' +
        '<div><b>Notification Settings</b><small>Manage push and in-app notifications.</small></div><span class="arr">→</span>' +
      '</div>' +

      '<div class="spacer-md"></div>' +

      // ── Support & Legal ──
      '<div class="pad"><div class="section-title serif">Support &amp; Legal</div></div>' +
      '<div class="rowlink" onclick="typeof openBetaFeedback===\'function\'?openBetaFeedback():toast(\'Coming soon\')">' +
        '<div><b>Support</b><small>Get help with Athlevo.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" onclick="openLegal(\'privacy\')">' +
        '<div><b>Privacy Policy</b><small>How Athlevo collects, uses, and protects your data.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" onclick="openLegal(\'terms\')">' +
        '<div><b>Terms of Service</b><small>The terms that govern your use of Athlevo.</small></div><span class="arr">→</span>' +
      '</div>' +

      '<div class="spacer-md"></div>' +

      // ── Account ──
      '<div class="pad"><div class="section-title serif">Account</div></div>' +
      '<div class="rowlink" onclick="toast(\'Account settings coming soon\')">' +
        '<div><b>Account Settings</b><small>Manage your account details.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" id="cmLogout" style="cursor:pointer">' +
        '<div><b>Log Out</b><small>Sign out of your Athlevo account.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="you-delete-divider"></div>' +
      '<div class="rowlink rowlink-danger-subtle" onclick="openDeleteAccount()">' +
        '<div><b>Delete Account</b><small>Permanently delete your account and all data.</small></div><span class="arr">→</span>' +
      '</div>' +

      '<div class="app-version"><div>Athlevo</div><div id="coachAppVersionDisplay">Version 0.6.0</div></div>' +
      '<div class="spacer-md"></div>' +
    '</div>';
    el.innerHTML = html;

    // Sync the theme segmented control to match current theme
    var currentTheme = localStorage.getItem("athlevo_theme") || "system";
    var coachThemeSeg = document.getElementById("coachThemeSeg");
    if (coachThemeSeg) {
      coachThemeSeg.querySelectorAll(".seg-btn").forEach(function (btn) {
        btn.classList.toggle("on", btn.getAttribute("data-theme-choice") === currentTheme);
      });
    }

    // Bind workspace switcher
    var switchBtn = document.getElementById("cmSwitchToAthlete");
    if (switchBtn) {
      switchBtn.addEventListener("click", function () {
        trackCoach("workspace_switcher_viewed", { source_surface: "coach_you" });
        activateAthleteWorkspace();
      });
    }

    // Open Coach Dashboard navigates to the Coach Today tab
    var dashBtn = document.getElementById("cmOpenDashboardCoachYou");
    if (dashBtn) {
      dashBtn.addEventListener("click", function () {
        var todayTab = document.querySelector('.tab[data-screen="screen-today"]');
        if (todayTab) coachGo(todayTab);
      });
    }

    var logoutBtn = document.getElementById("cmLogout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        if (typeof window.doLogout === "function") window.doLogout();
      });
    }
  }

  /* ═══════════════════════ REFRESH ═════════════════════════════════ */

  async function refreshRoster() {
    var context = { userId: _authUserId, generation: _authGeneration };
    var requestId = _modeRequest;
    if (!isCurrentAuthContext(context, requestId) || !canAccessCoachWorkspace()) return;
    _rosterLoading = true;
    _rosterError = null;
    renderCoachToday();
    var res = await api("roster", { expectedUserId: context.userId });
    if (!isCurrentAuthContext(context, requestId)) return;
    _rosterLoading = false;
    if (!res.ok) {
      _rosterError = "Could not refresh roster.";
      renderCoachToday();
      return;
    }
    _roster = (res.body && res.body.athletes) || [];
    _role = (res.body && res.body.role) || _role;
    await loadInvites(false);
    if (!isCurrentAuthContext(context, requestId)) return;
    renderCoachToday();
  }

  /* ═══════════════════════ INITIALIZATION ══════════════════════════ */

  /* Passive boot never paints Coach UI. Kept as a compatibility no-op for
   * callers while older cached shells roll forward. */
  function prepareDashboardLoading() {
    return false;
  }

  async function init(routeContext) {
    if (!routeContext && window.AthlevoAuthRoute) {
      routeContext = window.AthlevoAuthRoute.current();
    }
    if (!routeContext || !routeContext.userId || !routeContext.generation) {
      clearWorkspaceOnLogout();
      enforceAthleteWorkspaceFallback();
      return;
    }

    if (_authUserId !== routeContext.userId || _authGeneration !== routeContext.generation) {
      clearWorkspaceOnLogout();
      _authUserId = routeContext.userId;
      _authGeneration = routeContext.generation;
    }
    if (_initialized) return;
    _initialized = true;

    var mode = await resolveMode(routeContext);
    if (!isCurrentAuthContext(routeContext)) return;
    trackCoach("coach_mode_resolved", { coach_mode: mode });

    if (mode !== "coach_mode") {
      // Athlete or unknown — clear stale workspace state before any coach UI
      // can paint. prepareDashboardLoading may also have set coach tabs.
      enforceAthleteWorkspaceFallback();
      return;
    }

    // Resolve coach name from Supabase profile
    try {
      var c = sb();
      if (c) {
        var u = await c.auth.getUser();
        if (!isCurrentAuthContext(routeContext)) return;
        var uid = u && u.data && u.data.user && u.data.user.id;
        if (uid === routeContext.userId) {
          var q = await c.from("profiles").select("full_name").eq("id", uid).maybeSingle();
          if (!isCurrentAuthContext(routeContext)) return;
          _coachName = (q && q.data && q.data.full_name) || null;
        }
      }
    } catch (e) {}

    // Authorization enables the explicit switcher, but passive routing always
    // starts in Athlete Workspace. Coach UI is mounted only after a user action.
    _workspace = resolveWorkspace();
    restoreAthleteNavigation();
  }

  /* ═══════════════════════ PUBLIC API ══════════════════════════════ */

  window.AthlevoCoachMode = {
    init: init,
    prepareDashboardLoading: prepareDashboardLoading,
    go: coachGo,
    getMode: function () { return _appMode; },
    canAccessCoachWorkspace: canAccessCoachWorkspace,
    isCoachMode: function () { return canAccessCoachWorkspace(); },
    isCoachWorkspace: function () { return canAccessCoachWorkspace() && _workspace === "coach_workspace"; },
    isAthleteWorkspace: function () { return _workspace === "athlete_workspace"; },
    getWorkspace: function () { return _workspace; },
    switchToCoachWorkspace: activateCoachWorkspace,
    switchToAthleteWorkspace: activateAthleteWorkspace,
    clearWorkspaceOnLogout: clearWorkspaceOnLogout,
    injectAthleteYouSwitcher: injectAthleteYouSwitcher,
    _roster: function () { return _roster; },
    _state: function () { return { mode: _appMode, role: _role, coachName: _coachName, rosterSize: _roster.length, workspace: _workspace, authUserId: _authUserId, authGeneration: _authGeneration }; },
    COACH_MODE_VERSION: "coach-mode-v3"
  };

  if (typeof window.addEventListener === "function") {
    window.addEventListener("athlevo:native-back", function (event) {
      if (event.defaultPrevented || !canAccessCoachWorkspace() || _workspace !== "coach_workspace") return;
      var activeScreen = document.querySelector(".screen.active");
      var threadBack = activeScreen && activeScreen.querySelector(".cm-msg-thread-back");
      if (threadBack) {
        event.preventDefault();
        threadBack.click();
        return;
      }
      if (_athleteDetailId) {
        event.preventDefault();
        closeAthletePage();
      }
    });
  }
})();
