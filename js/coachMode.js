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
 *  IDs, or raw errors. DOM never contains athlete emails or UUIDs.
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
  var _search = "";
  var _rosterFilter = "all";
  var _athleteDetailId = null;
  var _athleteDetail = null;
  var _athleteDetailTab = "overview";
  var _athleteWeekStart = null;
  var _initialized = false;
  var _resolving = false;
  var _athleteTodayHTML = null;   // saved athlete Today innerHTML for restore

  /* ─── Workspace state ─── */
  var WORKSPACE_KEY = "athlevo_workspace";       // localStorage key
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

  async function token() {
    var c = sb();
    if (!c) return null;
    try {
      var r = await c.auth.getSession();
      return (r && r.data && r.data.session && r.data.session.access_token) || null;
    } catch (e) { return null; }
  }

  async function api(action, opts) {
    opts = opts || {};
    var t = await token();
    if (!t) return { ok: false, status: 401, body: { error: "No session" } };
    var url = "/api/providers?action=coaching_dashboard_" + encodeURIComponent(action);
    if (opts.query) Object.keys(opts.query).forEach(function (k) {
      url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(opts.query[k]);
    });
    var init = { method: opts.method || "GET", headers: { Authorization: "Bearer " + t } };
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
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
             d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return String(iso).slice(0, 16); }
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
    needs_attention: { label: "Needs attention", order: 0, color: "#c0392b", bg: "#fef2f2" },
    monitor:         { label: "Monitor",         order: 1, color: "#c77d0a", bg: "#fffbeb" },
    no_recent_data:  { label: "No recent data",  order: 2, color: "#888",    bg: "#f5f5f5" },
    on_track:        { label: "On track",        order: 3, color: "#2e7d32", bg: "#f0fdf4" }
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

  function ensureCoachCommandStyles() {
    if (document.getElementById("coachCommandCenterStyles")) return;
    var style = document.createElement("style");
    style.id = "coachCommandCenterStyles";
    style.textContent = [
      ".cm-command{width:100%;max-width:430px;margin:0 auto;padding:18px 16px 104px;box-sizing:border-box;color:var(--ink1,var(--ink,#171717));}",
      ".cm-command--ready{animation:cmCommandIn var(--dur-base,220ms) var(--ease-standard,ease-out) both;}",
      "@keyframes cmCommandIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}",
      ".cm-command-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px;}",
      ".cm-command-head h1{font-family:var(--serif,serif);font-size:26px;font-weight:520;letter-spacing:-.025em;line-height:1.08;margin:0;}",
      ".cm-command-summary{max-width:620px;margin:6px 0 0;color:var(--ink3,#737373);font-size:13px;line-height:1.4;}",
      ".cm-refresh{border:0;background:transparent;color:var(--ink3,#737373);font:600 12px/1 var(--sans,sans-serif);padding:8px 0;cursor:pointer;flex:0 0 auto;}",
      ".cm-refresh:hover{color:var(--ink1,var(--ink,#171717));}",
      ".cm-refresh:focus-visible,.cm-open-row:focus-visible,.cm-review:focus-visible{outline:2px solid var(--red,#b3292d);outline-offset:3px;}",
      ".cm-summary-strip{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:26px;}",
      ".cm-summary-metric{min-width:0;min-height:66px;padding:12px 13px;background:var(--card2,var(--card,#f5f5f5));border-radius:10px;}",
      ".cm-summary-metric strong{display:block;font-size:21px;line-height:1;font-weight:700;letter-spacing:-.025em;}",
      ".cm-summary-metric span{display:block;margin-top:6px;color:var(--ink3,#737373);font-size:10px;font-weight:700;line-height:1.25;letter-spacing:.055em;text-transform:uppercase;white-space:normal;overflow:visible;}",
      ".cm-command-grid{display:grid;gap:26px;align-items:start;}",
      ".cm-command-pair{display:grid;grid-template-columns:minmax(0,1fr);gap:26px;align-items:start;}",
      ".cm-section{min-width:0;}",
      ".cm-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0;padding-bottom:10px;border-bottom:1px solid var(--line,#e5e5e5);}",
      ".cm-section-title{font-family:var(--sans,sans-serif);font-size:13px;font-weight:760;letter-spacing:.065em;text-transform:uppercase;margin:0;}",
      ".cm-section-count{color:var(--ink3,#737373);font-size:11px;}",
      ".cm-list{border-top:0;}",
      ".cm-row{display:flex;align-items:center;gap:12px;min-width:0;padding:13px 2px;border-bottom:1px solid var(--line,#e5e5e5);}",
      ".cm-open-row{width:100%;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;}",
      ".cm-open-row:hover .cm-row-name{color:var(--red,#b3292d);}",
      ".cm-avatar{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border-radius:50%;background:var(--card2,var(--card,#f4f4f4));color:var(--ink2,#4f4f4f);font-size:11px;font-weight:750;letter-spacing:.02em;}",
      ".cm-row-copy{display:block;min-width:0;flex:1;}",
      ".cm-row-name,.cm-row-primary,.cm-row-meta{display:block;}",
      ".cm-row-name{font-size:13px;font-weight:700;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color var(--dur-fast,140ms) var(--ease-standard,ease);}",
      ".cm-row-primary{font-size:12px;line-height:1.4;color:var(--ink2,#555);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".cm-row-meta{font-size:11px;line-height:1.4;color:var(--ink3,#737373);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".cm-row-status{flex:0 0 auto;max-width:110px;text-align:right;color:var(--ink3,#737373);font-size:11px;line-height:1.25;}",
      ".cm-status-attention{color:#a52a2f;font-weight:700;}",
      ".cm-status-monitor{color:#9a6505;font-weight:700;}",
      ".cm-chevron{flex:0 0 auto;color:var(--ink3,#737373);font-size:17px;line-height:1;}",
      ".cm-review{flex:0 0 auto;border:1px solid var(--line,#d9d9d9);border-radius:999px;background:transparent;color:var(--ink1,var(--ink,#171717));font:700 11px/1 var(--sans,sans-serif);padding:8px 11px;cursor:pointer;}",
      ".cm-review:hover{border-color:var(--ink2,#555);}",
      ".cm-quiet-state{display:flex;align-items:center;gap:10px;margin-top:10px;padding:14px 15px;border-radius:10px;background:var(--card2,var(--card,#f5f5f5));color:var(--ink2,#555);font-size:13px;line-height:1.35;}",
      ".cm-quiet-state::before{content:'';width:18px;height:1px;background:var(--ink3,#737373);opacity:.45;flex:0 0 auto;}",
      ".cm-quiet-state--clear::before{width:7px;height:7px;border-radius:50%;background:var(--good,#2e7d32);opacity:1;}",
      ".cm-search{width:100%;box-sizing:border-box;border:0;border-bottom:1px solid var(--line,#e5e5e5);border-radius:0;background:transparent;color:inherit;padding:10px 0 11px;font:13px/1.3 var(--sans,sans-serif);margin:0;}",
      ".cm-search:focus{outline:0;border-bottom-color:var(--ink2,#555);}",
      ".cm-empty{padding:22px 0;border-block:1px solid var(--line,#e5e5e5);}",
      ".cm-empty strong{display:block;font-family:var(--serif,serif);font-size:20px;font-weight:520;}",
      ".cm-empty p{margin:5px 0 0;color:var(--ink3,#737373);font-size:13px;line-height:1.45;}",
      ".cm-error{padding:18px 0;border-block:1px solid var(--line,#e5e5e5);color:var(--ink2,#555);font-size:13px;}",
      ".cm-error button{margin-top:10px;}",
      ".cm-command-skeleton{width:100%;max-width:430px;margin:0 auto;padding:18px 16px 104px;box-sizing:border-box;}",
      ".cm-skel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px;}",
      ".cm-skel-stack{display:grid;gap:8px;min-width:0;flex:1}.cm-skel-line{display:block;height:12px;border-radius:4px}.cm-skel-line--title{width:min(240px,70%);height:29px}.cm-skel-line--sub{width:min(360px,90%);}",
      ".cm-skel-refresh{display:block;width:48px;height:12px;margin-top:8px;border-radius:4px;flex:0 0 auto;}",
      ".cm-skel-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:26px;}",
      ".cm-skel-stat{display:grid;align-content:center;gap:8px;min-width:0;min-height:66px;padding:12px 13px;box-sizing:border-box;border-radius:10px;background:var(--card2,var(--card,#f5f5f5));}",
      ".cm-skel-number{display:block;width:38px;height:20px;border-radius:4px}.cm-skel-stat-label{display:block;width:min(92px,82%);height:8px;border-radius:3px}",
      ".cm-skel-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}.cm-skel-section{display:grid;gap:10px;min-width:0}.cm-skel-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--line,#e5e5e5)}.cm-skel-label{display:block;width:120px;height:11px;border-radius:4px}.cm-skel-count{display:block;width:18px;height:9px;border-radius:3px}.cm-skel-quiet{display:block;height:46px;border-radius:10px}",
      ".cm-skel-search{display:block;width:100%;height:34px;border-radius:6px}.cm-skel-roster{display:grid}.cm-skel-roster-row{display:flex;align-items:flex-start;gap:12px;min-width:0;padding:14px 2px;border-bottom:1px solid var(--line,#e5e5e5)}.cm-skel-avatar{display:block;width:40px;height:40px;border-radius:50%;flex:0 0 40px}.cm-skel-roster-copy{display:grid;gap:6px;min-width:0;flex:1;padding-top:1px}.cm-skel-name{display:block;width:min(180px,68%);height:13px;border-radius:4px}.cm-skel-context{display:block;width:min(250px,88%);height:10px;border-radius:3px}.cm-skel-status{display:block;width:min(150px,56%);height:9px;border-radius:3px}.cm-skel-chevron{display:block;width:8px;height:14px;margin-top:4px;border-radius:3px;flex:0 0 8px}",
      "body.coach-loading .boot-content{padding:0;overflow:hidden}body.coach-loading .boot-content .cm-command-skeleton{padding-top:calc(18px + env(safe-area-inset-top));}body.coach-loading #tabbar{display:flex!important}",
      ".cm-roster-item .cm-row{align-items:flex-start;padding:16px 2px;}",
      ".cm-roster-item .cm-avatar{width:40px;height:40px;flex-basis:40px;margin-top:1px;font-size:12px;}",
      ".cm-roster-item .cm-row-name{font-size:15px;line-height:1.25;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;}",
      ".cm-roster-item .cm-row-primary{font-size:12px;line-height:1.45;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;}",
      ".cm-roster-item .cm-row-meta{font-size:11px;line-height:1.45;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;}",
      ".cm-roster-item .cm-chevron{margin-top:3px;}",
      ".cm-command--small-roster .cm-command-grid{gap:26px}.cm-command--small-roster .cm-section--roster{padding-top:2px;}",
      ".cm-filter-row{display:flex;gap:14px;overflow-x:auto;padding:12px 0 2px;scrollbar-width:none}.cm-filter-row::-webkit-scrollbar{display:none}.cm-filter{border:0;border-bottom:1px solid transparent;background:transparent;padding:3px 0 6px;color:var(--ink3,#737373);font:700 11px/1 var(--sans,sans-serif);white-space:nowrap;cursor:pointer}.cm-filter.is-active{color:var(--ink1,#171717);border-bottom-color:var(--red,#b3292d)}",
      ".cm-roster-state{flex:0 0 auto;font-size:10px;font-weight:700;color:var(--ink3,#737373);max-width:92px;text-align:right}.cm-roster-state.attention{color:#a52a2f}",
      ".cm-athlete-page{width:100%;max-width:920px;margin:0 auto;padding:16px 16px 108px;box-sizing:border-box;color:var(--ink1,var(--ink,#171717))}.cm-athlete-back{border:0;background:transparent;padding:7px 0;color:var(--ink2,#555);font:700 12px/1 var(--sans,sans-serif);cursor:pointer}.cm-athlete-head{display:flex;align-items:flex-start;gap:12px;margin:14px 0 18px}.cm-athlete-head .cm-avatar{width:44px;height:44px;flex-basis:44px}.cm-athlete-head-copy{min-width:0;flex:1}.cm-athlete-name{font-family:var(--serif,serif);font-size:26px;font-weight:520;line-height:1.08;margin:0;overflow-wrap:anywhere}.cm-athlete-context{margin:5px 0 0;color:var(--ink3,#737373);font-size:12px;line-height:1.4}.cm-athlete-tabs{display:flex;gap:18px;overflow-x:auto;border-bottom:1px solid var(--line,#e5e5e5);scrollbar-width:none}.cm-athlete-tab{border:0;border-bottom:2px solid transparent;background:transparent;padding:10px 0 9px;color:var(--ink3,#737373);font:700 12px/1 var(--sans,sans-serif);white-space:nowrap;cursor:pointer}.cm-athlete-tab.is-active{color:var(--ink1,#171717);border-bottom-color:var(--red,#b3292d)}.cm-athlete-panel{padding-top:20px}.cm-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line,#e5e5e5);border:1px solid var(--line,#e5e5e5)}.cm-detail-metric{min-height:82px;background:var(--bg,#fff);padding:14px}.cm-detail-label{display:block;color:var(--ink3,#737373);font-size:10px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}.cm-detail-value{display:block;margin-top:7px;font-size:14px;font-weight:700;line-height:1.35}.cm-detail-sub{display:block;margin-top:3px;color:var(--ink3,#737373);font-size:11px;line-height:1.4}.cm-detail-section{margin-top:24px}.cm-detail-section h3{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase}.cm-detail-empty{padding:16px 0;border-block:1px solid var(--line,#e5e5e5);color:var(--ink3,#737373);font-size:13px}.cm-activity-list{margin:0;padding:0;list-style:none}.cm-activity-list li{padding:11px 0;border-bottom:1px solid var(--line,#e5e5e5);font-size:13px}.cm-week-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.cm-week-title{font-size:14px;font-weight:750}.cm-week-actions{display:flex;gap:8px}.cm-week-btn{border:1px solid var(--line,#d9d9d9);background:transparent;color:inherit;border-radius:999px;padding:8px 11px;font:700 11px/1 var(--sans,sans-serif);cursor:pointer}.cm-week-btn--primary{border-color:var(--red,#b3292d);color:var(--red,#b3292d)}.cm-workout-list{border-top:1px solid var(--line,#e5e5e5)}.cm-workout-row{display:grid;grid-template-columns:45px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;padding:13px 0;border:0;border-bottom:1px solid var(--line,#e5e5e5);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.cm-workout-date{font-size:10px;color:var(--ink3,#737373);text-transform:uppercase;line-height:1.35}.cm-workout-copy{min-width:0}.cm-workout-title{font-size:13px;font-weight:750;line-height:1.3}.cm-workout-meta{margin-top:4px;color:var(--ink3,#737373);font-size:11px;line-height:1.4}.cm-workout-status{font-size:10px;font-weight:750;text-transform:uppercase;color:var(--ink3,#737373)}.cm-workout-status.completed{color:#2e7d32}.cm-workout-status.modified{color:#9a6505}.cm-workout-status.skipped{color:#a52a2f}.cm-placeholder{padding:28px 0;color:var(--ink3,#737373);font-size:13px;line-height:1.5}.cm-workout-overlay{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.38);display:flex;align-items:flex-end;justify-content:center}.cm-workout-dialog{width:100%;max-width:620px;max-height:90vh;overflow:auto;background:var(--bg,#fff);border-radius:18px 18px 0 0;padding:18px 16px calc(22px + env(safe-area-inset-bottom));box-sizing:border-box}.cm-workout-dialog-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}.cm-workout-dialog h2{margin:0;font-family:var(--serif,serif);font-size:22px}.cm-dialog-close{border:0;background:transparent;font-size:22px;cursor:pointer}.cm-workout-form{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cm-field{display:grid;gap:5px;min-width:0}.cm-field--full{grid-column:1/-1}.cm-field label{font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3,#737373)}.cm-field input,.cm-field textarea,.cm-field select{width:100%;box-sizing:border-box;border:1px solid var(--line,#d9d9d9);border-radius:8px;background:var(--bg,#fff);color:inherit;padding:10px;font:13px/1.35 var(--sans,sans-serif)}.cm-field textarea{min-height:70px;resize:vertical}.cm-form-error{grid-column:1/-1;color:#a52a2f;font-size:12px}.cm-form-actions{grid-column:1/-1;display:flex;justify-content:space-between;gap:10px;margin-top:4px}.cm-form-actions-right{display:flex;gap:8px;margin-left:auto}.cm-danger{color:#a52a2f;border-color:#e5b7b9}.cm-readonly-note{padding:11px 0;color:var(--ink3,#737373);font-size:12px}",
      "@media(min-width:760px){.cm-athlete-page{padding-inline:24px}.cm-detail-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.cm-workout-dialog{align-self:center;border-radius:14px}.cm-athlete-panel{padding-top:24px}}",
      "@media(min-width:760px){.cm-roster-item .cm-row{padding-block:17px}}",
      "@media(min-width:900px){body.coach-workspace-active .device,body.coach-loading .boot-shell{width:calc(100% - 48px);max-width:980px;border-radius:24px}.cm-command,.cm-command-skeleton{max-width:920px;padding-inline:24px}.cm-command-pair{grid-template-columns:repeat(2,minmax(0,1fr))}.cm-summary-strip,.cm-skel-summary{grid-template-columns:repeat(4,minmax(0,1fr))}}",
      "@media(max-width:380px){.cm-command-head h1{font-size:24px}.cm-summary-metric{padding-inline:11px}.cm-summary-metric span{font-size:10px;letter-spacing:.03em}.cm-row-status{max-width:78px}.cm-review{padding:8px 9px}}",
      "@media(prefers-reduced-motion:reduce){.cm-command--ready{animation:none}.cm-row-name{transition:none}}"
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
  async function resolveMode() {
    if (_resolving) return _appMode;
    _resolving = true;
    try {
      var res = await api("roster");
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
    "screen-coach-train",
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
    { screen: "screen-today",            label: "Today",  icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>' },
    { screen: "screen-coach-messaging", label: "Coach",  icon: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>' },
    { screen: "screen-coach-train",     label: "Train",  icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>' },
    { screen: "screen-coach-trends",    label: "Trends", icon: '<svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>' },
    { screen: "screen-coach-you",       label: "You",    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>' }
  ];

  function rewriteNavigation() {
    var tabbar = document.getElementById("tabbar");
    if (!tabbar) return;
    tabbar.innerHTML = "";
    COACH_TABS.forEach(function (tab, i) {
      var btn = document.createElement("button");
      btn.className = "tab" + (i === 0 ? " on" : "");
      btn.setAttribute("data-screen", tab.screen);
      btn.setAttribute("onclick", "AthlevoCoachMode.go(this)");
      btn.innerHTML = tab.icon + "<span>" + tab.label + "</span>" + '<div class="dotmark"></div>';
      tabbar.appendChild(btn);
    });
    tabbar.style.display = "flex";
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
    var ATHLETE_TABS = [
      { screen: "screen-today",    label: "Today",  icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>' },
      { screen: "screen-coachai",  label: "Coach",  icon: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>' },
      { screen: "screen-train",    label: "Train",  icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>' },
      { screen: "screen-trends",   label: "Trends", icon: '<svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>' },
      { screen: "screen-you",      label: "You",    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>' }
    ];
    tabbar.innerHTML = "";
    ATHLETE_TABS.forEach(function (tab, i) {
      var btn = document.createElement("button");
      btn.className = "tab" + (i === 0 ? " on" : "");
      btn.setAttribute("data-screen", tab.screen);
      btn.setAttribute("onclick", "go(this)");
      btn.innerHTML = tab.icon + "<span>" + tab.label + "</span>" + '<div class="dotmark"></div>';
      tabbar.appendChild(btn);
    });
  }

  /* ═══════════════════════ WORKSPACE SWITCHER ═══════════════════════ */

  /*
   * Read the saved workspace preference. Falls back to coach_workspace
   * for coach/admin, silently ignores stale coach_workspace for athletes.
   */
  function readWorkspacePref() {
    try {
      var v = localStorage.getItem(WORKSPACE_KEY);
      if (v === "coach_workspace" || v === "athlete_workspace") return v;
    } catch (e) {}
    return null;
  }

  function writeWorkspacePref(ws) {
    try { localStorage.setItem(WORKSPACE_KEY, ws); } catch (e) {}
  }

  function clearWorkspacePref() {
    try { localStorage.removeItem(WORKSPACE_KEY); } catch (e) {}
  }

  /*
   * Resolve which workspace to show. Only coach/admin users may access
   * coach_workspace. If a stale pref says coach but the user is no longer
   * coach/admin, fall back to athlete_workspace.
   */
  function resolveWorkspace() {
    var isCoach = _role === "coach" || _role === "admin";
    if (!isCoach) {
      // Safety: clear any stale coach pref
      if (readWorkspacePref() === "coach_workspace") clearWorkspacePref();
      return "athlete_workspace";
    }
    var pref = readWorkspacePref();
    if (pref) return pref;
    // Default coach/admin to coach_workspace on first use
    return "coach_workspace";
  }

  /*
   * Activate Coach Workspace — show coach screens, hide athlete screens.
   * Idempotent: calling when already in coach_workspace is a no-op.
   */
  function activateCoachWorkspace() {
    document.body.classList.add("coach-workspace-active");
    if (_workspace === "coach_workspace") return;
    var fromWs = _workspace;
    _workspace = "coach_workspace";
    writeWorkspacePref("coach_workspace");

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
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    var todayEl = document.getElementById("screen-today");
    if (todayEl) todayEl.classList.add("active");
    renderCoachToday();

    if (fromWs) {
      trackCoach("workspace_switched", {
        from_workspace: fromWs,
        to_workspace: "coach_workspace",
        source_surface: "workspace_switcher"
      });
    }
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
    writeWorkspacePref("athlete_workspace");

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

    // Show athlete Today
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    var todayEl = document.getElementById("screen-today");
    if (todayEl) todayEl.classList.add("active");

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
    if (youEl.querySelector("#cmAthleteSwitcher")) return; // already injected
    if (_role !== "coach" && _role !== "admin") return;

    var section = document.getElementById("youWorkspaceSection");
    if (!section) return;

    var switcher = document.createElement("div");
    switcher.id = "cmAthleteSwitcher";
    switcher.innerHTML =
      '<div class="pad"><div class="section-title serif">Workspace</div></div>' +
      '<div class="rowlink" id="cmSwitchToCoach" style="cursor:pointer">' +
        '<div><b>Switch to Coach Workspace</b><small>Open your coaching tools.</small></div><span class="arr">→</span>' +
      '</div>' +
      '<div class="spacer-md" style="height:8px"></div>' +
      '<div class="rowlink" id="cmOpenDashboard" style="cursor:pointer">' +
        '<div><b>Open Coach Dashboard</b><small>View and manage your athletes.</small></div><span class="arr">→</span>' +
      '</div>';

    section.appendChild(switcher);

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
    return '<button id="cmSwitchToAthlete" style="width:100%;padding:14px;border:1px solid var(--accent,#3b82f6);border-radius:12px;background:transparent;color:var(--accent,#3b82f6);font-size:14px;font-weight:600;cursor:pointer;margin-bottom:12px;">' +
      'Switch to My Training' +
    '</button>';
  }

  /* Coach tab switching — replaces the athlete `go()` for coach screens */
  function coachGo(btn) {
    var screenId = btn.dataset.screen;
    var screenEl = document.getElementById(screenId);
    if (window.AthlevoAppMotion) {
      window.AthlevoAppMotion.selectTab(btn, true);
      window.AthlevoAppMotion.transitionTo(screenId);
    } else {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("on"); });
      btn.classList.add("on");
      document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
      if (screenEl) screenEl.classList.add("active");
    }
    if (screenEl) screenEl.scrollTop = 0;

    // Analytics
    var TAB_EVENTS = {
      "screen-today": "coach_today_viewed",
      "screen-coach-messaging": "coach_tab_viewed",
      "screen-coach-train": "coach_train_viewed",
      "screen-coach-trends": "coach_trends_viewed",
      "screen-coach-you": "coach_you_viewed"
    };
    var TAB_NAMES = {
      "screen-today": "today",
      "screen-coach-messaging": "coach",
      "screen-coach-train": "train",
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
    if (screenId === "screen-coach-train") renderCoachTrain();
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
    if (_rosterLoading) {
      el.innerHTML = renderCoachSkeleton();
      return;
    }

    var sorted = sortRoster(_roster);
    var attention = sorted.filter(function (a) {
      return a.attention_status === "needs_attention" || a.attention_status === "monitor";
    });
    var trainingToday = sorted.filter(function (a) { return Boolean(a.today_planned); });
    var recentActs = sorted.filter(function (a) { return Boolean(a.latest_activity); })
      .sort(function (a, b) {
        return String((b.latest_activity || {}).date || "").localeCompare(String((a.latest_activity || {}).date || ""));
      }).slice(0, 8);
    var todayKey = new Date().toISOString().slice(0, 10);
    var raceGoals = sorted.filter(function (a) {
      return Boolean(a.target_event && a.target_date && String(a.target_date).slice(0, 10) >= todayKey);
    }).sort(function (a, b) { return String(a.target_date).localeCompare(String(b.target_date)); });

    var liveSummary = attention.length
      ? attention.length + " athlete" + (attention.length === 1 ? " needs" : "s need") + " review today."
      : trainingToday.length
        ? trainingToday.length + " athlete" + (trainingToday.length === 1 ? " is" : "s are") + " training today."
        : sorted.length ? "No athletes need attention right now." : "No athletes are currently assigned.";
    var rosterSizeClass = sorted.length > 0 && sorted.length <= 3 ? " cm-command--small-roster" : "";

    var content =
      '<div class="cm-command cm-command--ready' + rosterSizeClass + '">' +
        '<header class="cm-command-head">' +
          '<div><h1>Coach Dashboard</h1><p class="cm-command-summary" aria-live="polite">' + esc(liveSummary) + '</p></div>' +
          '<button type="button" class="cm-refresh" id="cmRefresh">Refresh</button>' +
        '</header>';

    if (_rosterError) {
      content += '<div class="cm-error">' + esc(_rosterError) + '<br><button type="button" class="cm-review" id="cmRetry">Try again</button></div></div>';
      el.innerHTML = content;
      bindCoachTodayEvents(el);
      return;
    }

    content += renderSummaryStrip(sorted.length, attention.length, trainingToday.length, raceGoals.length);
    if (!sorted.length) {
      content += '<section class="cm-empty"><strong>No athletes assigned yet.</strong><p>Assigned athletes will appear here when they are connected to your coaching roster.</p></section></div>';
      el.innerHTML = content;
      bindCoachTodayEvents(el);
      return;
    }

    content +=
      '<div class="cm-command-grid">' +
        '<div class="cm-command-pair">' +
          renderAttentionSection(attention) +
          renderTrainingTodaySection(trainingToday) +
        '</div>' +
        '<div class="cm-command-pair">' +
          (recentActs.length ? renderRecentActivitySection(recentActs) : '') +
          renderRaceGoalsSection(raceGoals) +
        '</div>' +
        renderRosterStatusSection(sorted) +
      '</div></div>';

    el.innerHTML = content;
    bindCoachTodayEvents(el);
  }

  function renderCoachSkeleton() {
    var summary = [0, 1, 2, 3].map(function () {
      return '<div class="cm-skel-stat"><span class="skel cm-skel-number"></span><span class="skel cm-skel-stat-label"></span></div>';
    }).join("");
    var compactSection = function () {
      return '<section class="cm-skel-section"><div class="cm-skel-section-head"><span class="skel cm-skel-label"></span><span class="skel cm-skel-count"></span></div><span class="skel cm-skel-quiet"></span></section>';
    };
    var rosterRows = [0, 1].map(function () {
      return '<div class="cm-skel-roster-row"><span class="skel cm-skel-avatar"></span><span class="cm-skel-roster-copy"><span class="skel cm-skel-name"></span><span class="skel cm-skel-context"></span><span class="skel cm-skel-status"></span></span><span class="skel cm-skel-chevron"></span></div>';
    }).join("");
    return '<div class="cm-command-skeleton" role="status" aria-label="Loading Coach Dashboard">' +
      '<div class="cm-skel-head"><div class="cm-skel-stack"><span class="skel cm-skel-line cm-skel-line--title"></span><span class="skel cm-skel-line cm-skel-line--sub"></span></div><span class="skel cm-skel-refresh"></span></div>' +
      '<div class="cm-skel-summary">' + summary + '</div>' +
      '<div class="cm-skel-grid">' + compactSection() + compactSection() +
        '<section class="cm-skel-section cm-skel-section--roster"><div class="cm-skel-section-head"><span class="skel cm-skel-label"></span></div><span class="skel cm-skel-search"></span><div class="cm-skel-roster">' + rosterRows + '</div></section>' +
      '</div>' +
    '</div>';
  }

  function renderSummaryStrip(total, attn, training, races) {
    var metrics = [
      { label: "Athletes", value: total },
      { label: "Need attention", value: attn },
      { label: "Training today", value: training },
      { label: "Upcoming races", value: races }
    ];
    return '<div class="cm-summary-strip" aria-label="Roster summary">' + metrics.map(function (m) {
      return '<div class="cm-summary-metric"><strong>' + esc(m.value) + '</strong><span>' + esc(m.label) + '</span></div>';
    }).join("") + '</div>';
  }

  function sectionHeader(title, count) {
    return '<div class="cm-section-head"><h2 class="cm-section-title">' + esc(title) + '</h2>' +
      (count == null ? '' : '<span class="cm-section-count">' + esc(count) + '</span>') + '</div>';
  }

  /* ─── Needs Attention ─── */
  function renderAttentionSection(athletes) {
    var html = '<section class="cm-section cm-section--attention">' + sectionHeader("Needs Attention", athletes.length);
    if (!athletes.length) return html + '<div class="cm-quiet-state cm-quiet-state--clear">All clear.</div></section>';
    html += '<div class="cm-list">';
    athletes.forEach(function (a) {
      var key = (a.attention_reason_keys || [])[0];
      var status = a.readiness_status && a.readiness_status !== "No recent data"
        ? a.readiness_status + " readiness"
        : a.recovery_status && a.recovery_status !== "unknown" ? a.recovery_status + " recovery" : (STATUS_META[a.attention_status] || STATUS_META.monitor).label;
      html += '<div class="cm-row">' +
        '<span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span>' +
        '<div class="cm-row-copy"><div class="cm-row-name">' + esc(a.name) + '</div><div class="cm-row-primary">' + esc(attentionReasonLabel(key)) + '</div></div>' +
        '<span class="cm-row-status ' + (a.attention_status === "needs_attention" ? "cm-status-attention" : "cm-status-monitor") + '">' + esc(status) + '</span>' +
        '<button type="button" class="cm-review cm-view-athlete" data-athlete="' + esc(a.athlete_id) + '">Review</button>' +
      '</div>';
    });
    return html + '</div></section>';
  }

  /* ─── Training Today ─── */
  function renderTrainingTodaySection(athletes) {
    var html = '<section class="cm-section cm-section--training">' + sectionHeader("Training Today", athletes.length);
    if (!athletes.length) return html + '<div class="cm-quiet-state">No sessions planned today.</div></section>';
    html += '<div class="cm-list">';
    athletes.forEach(function (a) {
      var s = a.today_planned || {};
      var amount = s.duration_minutes != null ? s.duration_minutes + " min" : s.distance_km != null ? s.distance_km + " km" : null;
      var details = [s.title || "Planned session", amount].filter(Boolean).join(" · ");
      var status = s.execution_status || "pending";
      html += '<button type="button" class="cm-open-row" data-open-athlete="' + esc(a.athlete_id) + '"><span class="cm-row">' +
        '<span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span>' +
        '<span class="cm-row-copy"><span class="cm-row-name">' + esc(a.name) + '</span><span class="cm-row-primary">' + esc(details) + '</span></span>' +
        '<span class="cm-row-status ' + (status === "skipped" ? "cm-status-attention" : status === "modified" ? "cm-status-monitor" : "") + '">' + esc(status.replace(/^./, function (c) { return c.toUpperCase(); })) + '</span><span class="cm-chevron" aria-hidden="true">›</span>' +
      '</span></button>';
    });
    return html + '</div></section>';
  }

  /* ─── Recent Activity ─── */
  function renderRecentActivitySection(athletes) {
    var html = '<section class="cm-section cm-section--activity">' + sectionHeader("Recent Activity", athletes.length) + '<div class="cm-list">';
    athletes.forEach(function (a) {
      html += '<button type="button" class="cm-open-row" data-open-athlete="' + esc(a.athlete_id) + '"><span class="cm-row">' +
        '<span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span>' +
        '<span class="cm-row-copy"><span class="cm-row-name">' + esc(a.name) + '</span><span class="cm-row-primary">' + esc(latestActivitySummary(a)) + '</span><span class="cm-row-meta">' + esc(fmtDateTime(a.latest_activity.date)) + '</span></span>' +
        '<span class="cm-chevron" aria-hidden="true">›</span>' +
      '</span></button>';
    });
    return html + '</div></section>';
  }

  function renderRaceGoalsSection(athletes) {
    var html = '<section class="cm-section cm-section--races">' + sectionHeader("Upcoming Races", athletes.length);
    if (!athletes.length) return html + '<div class="cm-quiet-state">No upcoming races scheduled.</div></section>';
    html += '<div class="cm-list">';
    athletes.forEach(function (a) {
      var days = Math.ceil((Date.parse(String(a.target_date).slice(0, 10) + "T00:00:00Z") - Date.now()) / 86400000);
      html += '<button type="button" class="cm-open-row" data-open-athlete="' + esc(a.athlete_id) + '"><span class="cm-row">' +
        '<span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span>' +
        '<span class="cm-row-copy"><span class="cm-row-name">' + esc(a.name) + '</span><span class="cm-row-primary">' + esc(a.target_event) + '</span><span class="cm-row-meta">' + esc(String(a.target_date).slice(0, 10)) + ' · ' + esc(days) + ' days</span></span>' +
        '<span class="cm-chevron" aria-hidden="true">›</span>' +
      '</span></button>';
    });
    return html + '</div></section>';
  }

  /* ─── Athlete Roster ─── */
  function renderRosterStatusSection(sorted) {
    return '<section class="cm-section cm-section--roster">' + sectionHeader("Athletes", sorted.length) +
      '<input class="cm-search" id="cmRosterSearch" type="search" placeholder="Search athletes" aria-label="Search athletes" value="' + esc(_search) + '" />' +
      '<div class="cm-filter-row" aria-label="Filter athletes">' + [
        ["all", "All"], ["attention", "Needs Attention"], ["training", "Training Today"], ["race", "Race Soon"]
      ].map(function (item) { return '<button type="button" class="cm-filter' + (_rosterFilter === item[0] ? ' is-active' : '') + '" data-roster-filter="' + item[0] + '">' + item[1] + '</button>'; }).join("") + '</div>' +
      '<div id="cmRosterList" class="cm-list">' + renderRosterList(sorted, _search, _rosterFilter) + '</div></section>';
  }

  function renderRosterList(sorted, query, filter) {
    var q = (query || "").toLowerCase().trim();
    var visible = sorted.filter(function (a) {
      var textMatches = !q || String(a.name || "").toLowerCase().indexOf(q) !== -1;
      var raceDays = a.target_date ? Math.ceil((Date.parse(String(a.target_date).slice(0, 10) + "T00:00:00Z") - Date.now()) / 86400000) : null;
      var filterMatches = filter === "attention" ? (a.attention_status === "needs_attention" || a.attention_status === "monitor")
        : filter === "training" ? Boolean(a.today_planned)
        : filter === "race" ? (raceDays != null && raceDays >= 0 && raceDays <= 21)
        : true;
      return textMatches && filterMatches;
    });
    if (!visible.length) {
      return '<div style="padding:16px;text-align:center;color:var(--ink3,#888);font-size:13px;">' +
        (q ? 'No athletes match "' + esc(q) + '".' : 'No athletes assigned yet.') + '</div>';
    }
    return visible.map(function (a) {
      var raceDays = a.target_date ? Math.ceil((Date.parse(String(a.target_date).slice(0, 10) + "T00:00:00Z") - Date.now()) / 86400000) : null;
      var state = a.attention_status === "needs_attention" ? "Needs review" : a.today_planned ? "Training today" : raceDays != null && raceDays >= 0 && raceDays <= 21 ? "Race soon" : a.attention_status === "on_track" ? "On track" : "No recent data";
      return '<button type="button" class="cm-open-row cm-roster-item" data-open-athlete="' + esc(a.athlete_id) + '"><span class="cm-row">' +
        '<span class="cm-avatar" aria-hidden="true">' + esc(a.initials || "A") + '</span>' +
        '<span class="cm-row-copy"><span class="cm-row-name">' + esc(a.name) + '</span><span class="cm-row-primary">' + esc(athleteContext(a)) + '</span><span class="cm-row-meta">' + esc(rosterStatusLine(a)) + '</span></span><span class="cm-roster-state' + (state === "Needs review" ? " attention" : "") + '">' + esc(state) + '</span>' +
        '<span class="cm-chevron" aria-hidden="true">›</span>' +
      '</span></button>';
    }).join("");
  }

  /* ─── Event Binding for Coach Today ─── */
  function bindCoachTodayEvents(container) {
    var refresh = container.querySelector("#cmRefresh");
    if (refresh) refresh.addEventListener("click", refreshRoster);
    var retry = container.querySelector("#cmRetry");
    if (retry) retry.addEventListener("click", refreshRoster);

    // View athlete buttons
    container.querySelectorAll(".cm-view-athlete").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-athlete");
        openCoachAthletePage(id, "overview");
        trackCoach("coach_today_athlete_opened", { coach_mode: "coach_mode", source_surface: "coach_today" });
      });
    });
    // Training, activity, race-goal, and roster rows share the existing drawer.
    container.querySelectorAll("[data-open-athlete]").forEach(function (item) {
      item.addEventListener("click", function () {
        var id = item.getAttribute("data-open-athlete");
        openCoachAthletePage(id, item.closest(".cm-section--training") ? "training" : "overview");
        trackCoach("coach_today_athlete_opened", { coach_mode: "coach_mode", source_surface: "coach_roster" });
      });
    });
    // Roster search
    var searchInput = document.getElementById("cmRosterSearch");
    if (searchInput) {
      searchInput.addEventListener("input", function (e) {
        _search = e.target.value || "";
        var listEl = document.getElementById("cmRosterList");
        if (listEl) listEl.innerHTML = renderRosterList(sortRoster(_roster), _search, _rosterFilter);
        var rosterItems = listEl ? listEl.querySelectorAll("[data-open-athlete]") : [];
        rosterItems.forEach(function (item) {
          item.addEventListener("click", function () {
            openCoachAthletePage(item.getAttribute("data-open-athlete"), "overview");
          });
        });
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
  async function openCoachAthletePage(athleteId, tab, weekStart) {
    _athleteDetailId = athleteId;
    _athleteDetailTab = tab || _athleteDetailTab || "overview";
    _athleteWeekStart = weekStart || _athleteWeekStart;
    _athleteDetail = null;
    renderAthletePageLoading();
    var query = { athlete_id: athleteId };
    if (_athleteWeekStart) query.week_start = _athleteWeekStart;
    var res = await api("athlete", { query: query });
    if (_athleteDetailId !== athleteId) return;
    if (!res.ok || !res.body || !res.body.athlete) {
      renderAthletePageError(res.status === 403 ? "You are not assigned to this athlete." : "Could not load this athlete.");
      return;
    }
    _athleteDetail = res.body.athlete;
    _athleteWeekStart = _athleteDetail.training_week && _athleteDetail.training_week.week_start;
    renderAthletePage();
  }

  function renderAthletePageLoading() {
    var el = document.getElementById("screen-today");
    if (!el) return;
    el.innerHTML = '<div class="cm-athlete-page"><button class="cm-athlete-back" type="button">← Athletes</button><div class="cm-placeholder">Loading athlete…</div></div>';
    el.querySelector(".cm-athlete-back").addEventListener("click", closeAthletePage);
  }

  function renderAthletePageError(message) {
    var el = document.getElementById("screen-today");
    if (!el) return;
    el.innerHTML = '<div class="cm-athlete-page"><button class="cm-athlete-back" type="button">← Athletes</button><div class="cm-error">' + esc(message) + '<br><button type="button" class="cm-review" id="cmAthleteRetry">Try again</button></div></div>';
    el.querySelector(".cm-athlete-back").addEventListener("click", closeAthletePage);
    el.querySelector("#cmAthleteRetry").addEventListener("click", function () { openCoachAthletePage(_athleteDetailId, _athleteDetailTab, _athleteWeekStart); });
  }

  function closeAthletePage() {
    _athleteDetailId = null;
    _athleteDetail = null;
    _athleteWeekStart = null;
    renderCoachToday();
  }

  function renderAthletePage() {
    var el = document.getElementById("screen-today");
    var ath = _athleteDetail;
    if (!el || !ath) return;
    var tabs = ["overview", "training", "analytics", "check-ins", "notes"];
    var labels = { overview: "Overview", training: "Training", analytics: "Analytics", "check-ins": "Check-ins", notes: "Notes" };
    el.innerHTML = '<div class="cm-athlete-page">' +
      '<button class="cm-athlete-back" type="button">← Athletes</button>' +
      '<header class="cm-athlete-head"><span class="cm-avatar" aria-hidden="true">' + esc(ath.initials || "A") + '</span><div class="cm-athlete-head-copy"><h1 class="cm-athlete-name">' + esc(ath.name || "Athlete") + '</h1><p class="cm-athlete-context">' + esc([SPORT_LABEL[ath.primary_sport], ath.goal].filter(Boolean).join(" · ") || "Athlete") + '</p></div></header>' +
      '<nav class="cm-athlete-tabs" aria-label="Athlete details">' + tabs.map(function (tab) { return '<button type="button" class="cm-athlete-tab' + (_athleteDetailTab === tab ? ' is-active' : '') + '" data-athlete-tab="' + tab + '">' + labels[tab] + '</button>'; }).join("") + '</nav>' +
      '<div class="cm-athlete-panel">' + (_athleteDetailTab === "overview" ? renderAthleteOverview(ath) : _athleteDetailTab === "training" ? renderAthleteTraining(ath) : '<div class="cm-placeholder"><strong>' + esc(labels[_athleteDetailTab]) + '</strong><br>This workspace is not part of the current sprint yet.</div>') + '</div></div>';
    el.querySelector(".cm-athlete-back").addEventListener("click", closeAthletePage);
    el.querySelectorAll("[data-athlete-tab]").forEach(function (btn) { btn.addEventListener("click", function () { _athleteDetailTab = btn.getAttribute("data-athlete-tab"); renderAthletePage(); }); });
    bindAthletePageActions(el, ath);
  }

  function metric(label, value, sub) {
    return '<div class="cm-detail-metric"><span class="cm-detail-label">' + esc(label) + '</span><span class="cm-detail-value">' + esc(value || "—") + '</span>' + (sub ? '<span class="cm-detail-sub">' + esc(sub) + '</span>' : '') + '</div>';
  }

  function renderAthleteOverview(ath) {
    var wk = ath.week_planned_vs_completed || {};
    var compliance = wk.planned_minutes > 0 && wk.completed_minutes != null ? Math.round((wk.completed_minutes / wk.planned_minutes) * 100) + "%" : null;
    var race = ath.target_event || "No race scheduled";
    var raceSub = ath.target_date ? String(ath.target_date).slice(0, 10) : null;
    var upcoming = ath.upcoming_session;
    var recent = (ath.recent_activities || []).map(function (a) { return '<li>' + esc(activityLine(a)) + (a.indoor ? ' · indoor' : '') + '</li>'; }).join("");
    var plan = ath.plan_phase || ath.plan_week_focus;
    var reasons = (ath.attention_reasons || []).map(function (r) { return '<li>' + esc(r.explanation || attentionReasonLabel(r.key)) + '</li>'; }).join("");
    return '<div class="cm-detail-grid">' +
      metric("Target event", race, raceSub) +
      metric("Current block", plan || "No current block", ath.plan_phase && ath.plan_week_focus ? ath.plan_week_focus : null) +
      metric("Recent volume", wk.completed_minutes != null ? wk.completed_minutes + " min" : "No recent training data", wk.completed_distance_km != null ? wk.completed_distance_km + " km this week" : null) +
      metric("Compliance", compliance || "Not enough data", compliance ? wk.completed_minutes + " of " + wk.planned_minutes + " min" : null) +
      metric("Upcoming", upcoming ? upcoming.title : "No upcoming session", upcoming && upcoming.date ? String(upcoming.date).slice(0, 10) : null) +
      metric("Readiness", ath.readiness && ath.readiness.status || "No recent data", ath.readiness && ath.readiness.check_in_date ? String(ath.readiness.check_in_date).slice(0, 10) : null) +
      metric("Last active", fmtLastActive(ath.last_active_at), null) +
      metric("Plan access", ath.assignment_permission === "read_write" ? "Programming enabled" : "View only", null) +
      '</div>' +
      (reasons ? '<section class="cm-detail-section"><h3>Needs attention</h3><ul class="cm-activity-list">' + reasons + '</ul><button type="button" class="cm-review" id="cmDetailReview">Mark reviewed</button></section>' : '') +
      '<section class="cm-detail-section"><h3>Recent activity</h3>' + (recent ? '<ul class="cm-activity-list">' + recent + '</ul>' : '<div class="cm-detail-empty">No recent training data</div>') + '</section>';
  }

  function workoutMeta(session) {
    return [session.type, session.duration_minutes != null ? session.duration_minutes + " min" : null, session.distance_km != null ? session.distance_km + " km" : null, session.target_rpe ? "RPE " + session.target_rpe : session.intensity, session.pace_guidance].filter(Boolean).join(" · ");
  }

  function renderAthleteTraining(ath) {
    var week = ath.training_week || { sessions: [] };
    var canWrite = ath.assignment_permission === "read_write";
    var rows = (week.sessions || []).map(function (session) {
      var date = session.date ? new Date(session.date + "T00:00:00Z") : null;
      var day = date ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" }) : "—";
      return '<button type="button" class="cm-workout-row" data-workout-id="' + esc(session.id) + '"><span class="cm-workout-date">' + esc(day) + '</span><span class="cm-workout-copy"><span class="cm-workout-title">' + esc(session.title) + '</span><span class="cm-workout-meta">' + esc(workoutMeta(session) || "Prescription details unavailable") + '</span></span><span class="cm-workout-status ' + esc(session.execution_status) + '">' + esc(session.execution_status) + '</span></button>';
    }).join("");
    return '<div class="cm-week-head"><div><div class="cm-week-title">' + esc(week.week_start || "Current week") + ' – ' + esc(week.week_end || "") + '</div><div class="cm-detail-sub">Current training week</div></div><div class="cm-week-actions"><button type="button" class="cm-week-btn" data-week-shift="-7" aria-label="Previous week">←</button><button type="button" class="cm-week-btn" data-week-shift="7" aria-label="Next week">→</button>' + (canWrite ? '<button type="button" class="cm-week-btn cm-week-btn--primary" id="cmAddWorkout">Add workout</button>' : '') + '</div></div>' +
      (!canWrite ? '<div class="cm-readonly-note">This assignment is view-only. A read-write assignment is required to change the plan.</div>' : '') +
      (rows ? '<div class="cm-workout-list">' + rows + '</div>' : '<div class="cm-detail-empty">No workouts scheduled this week.</div>');
  }

  function bindAthletePageActions(el, ath) {
    var review = el.querySelector("#cmDetailReview");
    if (review) review.addEventListener("click", function () { markAthleteReviewed(ath.athlete_id, review); });
    el.querySelectorAll("[data-week-shift]").forEach(function (btn) { btn.addEventListener("click", function () {
      var base = _athleteWeekStart ? new Date(_athleteWeekStart + "T00:00:00Z") : new Date();
      base.setUTCDate(base.getUTCDate() + Number(btn.getAttribute("data-week-shift")));
      openCoachAthletePage(ath.athlete_id, "training", base.toISOString().slice(0, 10));
    }); });
    var add = el.querySelector("#cmAddWorkout");
    if (add) add.addEventListener("click", function () { openWorkoutEditor(null); });
    el.querySelectorAll("[data-workout-id]").forEach(function (row) { row.addEventListener("click", function () {
      var session = ((ath.training_week || {}).sessions || []).find(function (item) { return String(item.id) === String(row.getAttribute("data-workout-id")); });
      if (session) openWorkoutEditor(session);
    }); });
  }

  function openWorkoutEditor(session) {
    var ath = _athleteDetail;
    if (!ath) return;
    var canWrite = ath.assignment_permission === "read_write";
    var editable = canWrite && (!session || session.can_edit);
    var overlay = document.createElement("div");
    overlay.className = "cm-workout-overlay";
    overlay.id = "cmWorkoutOverlay";
    var value = function (key) { return esc(session && session[key] != null ? session[key] : ""); };
    overlay.innerHTML = '<div class="cm-workout-dialog" role="dialog" aria-modal="true" aria-label="' + (session ? "Workout details" : "Add workout") + '"><div class="cm-workout-dialog-head"><h2>' + (session ? "Workout details" : "Add workout") + '</h2><button type="button" class="cm-dialog-close" aria-label="Close">×</button></div><form class="cm-workout-form" id="cmWorkoutForm">' +
      '<div class="cm-field"><label for="cmWorkoutDate">Date</label><input id="cmWorkoutDate" name="session_date" type="date" required value="' + value("date") + '" ' + (!editable || session && !session.can_reschedule ? "disabled" : "") + '></div>' +
      '<div class="cm-field"><label for="cmWorkoutType">Type</label><input id="cmWorkoutType" name="session_type" value="' + value("type") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field"><label for="cmWorkoutSport">Sport</label><input id="cmWorkoutSport" name="sport" value="' + value("sport") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutTitle">Title</label><input id="cmWorkoutTitle" name="title" required value="' + value("title") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field"><label for="cmWorkoutDuration">Duration (min)</label><input id="cmWorkoutDuration" name="duration_minutes" type="number" min="0" max="1440" value="' + value("duration_minutes") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field"><label for="cmWorkoutDistance">Distance (km)</label><input id="cmWorkoutDistance" name="distance_km" type="number" min="0" max="1000" step="0.1" value="' + value("distance_km") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field"><label for="cmWorkoutRpe">Target RPE</label><input id="cmWorkoutRpe" name="target_rpe" value="' + value("target_rpe") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field"><label for="cmWorkoutIntensity">Intensity</label><input id="cmWorkoutIntensity" name="intensity" value="' + value("intensity") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutPace">Pace guidance</label><input id="cmWorkoutPace" name="pace_guidance" value="' + value("pace_guidance") + '" ' + (!editable ? "disabled" : "") + '></div>' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutDescription">Description</label><textarea id="cmWorkoutDescription" name="description" ' + (!editable ? "disabled" : "") + '>' + value("description") + '</textarea></div>' +
      '<div class="cm-field cm-field--full"><label for="cmWorkoutNotes">Coach notes</label><textarea id="cmWorkoutNotes" name="notes" ' + (!editable ? "disabled" : "") + '>' + value("notes") + '</textarea></div>' +
      '<div class="cm-form-error" id="cmWorkoutError" aria-live="polite"></div><div class="cm-form-actions">' + (session && session.can_remove && canWrite ? '<button type="button" class="cm-week-btn cm-danger" id="cmRemoveWorkout">Remove</button>' : '<span></span>') + '<div class="cm-form-actions-right"><button type="button" class="cm-week-btn cm-dialog-close">Close</button>' + (editable ? '<button type="submit" class="cm-week-btn cm-week-btn--primary">Save</button>' : '') + '</div></div></form></div>';
    document.body.appendChild(overlay);
    var previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    var onKey = function (event) { if (event.key === "Escape") close(); };
    var close = function () {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      overlay.remove();
    };
    overlay._closeCoachWorkout = close;
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    overlay.querySelectorAll(".cm-dialog-close").forEach(function (btn) { btn.addEventListener("click", close); });
    var form = overlay.querySelector("#cmWorkoutForm");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); saveWorkoutForm(form, session, overlay); });
    var remove = overlay.querySelector("#cmRemoveWorkout");
    if (remove) remove.addEventListener("click", function () { removeWorkout(session, overlay); });
  }

  async function saveWorkoutForm(form, session, overlay) {
    var error = form.querySelector("#cmWorkoutError");
    var submit = form.querySelector('[type="submit"]');
    var data = new FormData(form);
    var workout = {};
    data.forEach(function (value, key) { workout[key] = value; });
    if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }
    var res = await api("workout", { method: session ? "PATCH" : "POST", body: { athlete_id: _athleteDetailId, session_id: session && session.id, workout: workout } });
    if (!res.ok) {
      if (error) error.textContent = res.body && res.body.error || "The workout could not be saved.";
      if (submit) { submit.disabled = false; submit.textContent = "Save"; }
      return;
    }
    if (overlay._closeCoachWorkout) overlay._closeCoachWorkout(); else overlay.remove();
    openCoachAthletePage(_athleteDetailId, "training", _athleteWeekStart);
  }

  async function removeWorkout(session, overlay) {
    if (!window.confirm("Remove this workout from the athlete's plan?")) return;
    var error = overlay.querySelector("#cmWorkoutError");
    var res = await api("workout", { method: "DELETE", body: { athlete_id: _athleteDetailId, session_id: session.id } });
    if (!res.ok) { if (error) error.textContent = res.body && res.body.error || "The workout could not be removed."; return; }
    if (overlay._closeCoachWorkout) overlay._closeCoachWorkout(); else overlay.remove();
    openCoachAthletePage(_athleteDetailId, "training", _athleteWeekStart);
  }

  function activityLine(a) {
    var label = SPORT_LABEL[a.sport] || "Activity";
    var bits = [label];
    if (a.date) bits.push(esc(String(a.date).slice(0, 10)));
    if (a.sport === "run") {
      if (a.distance_km != null) bits.push(a.distance_km + " km");
      if (a.pace_sec_per_km) bits.push(Math.floor(a.pace_sec_per_km / 60) + ":" + String(a.pace_sec_per_km % 60).padStart(2, "0") + "/km");
    } else if (a.sport === "ride") {
      if (a.duration_min != null) bits.push(a.duration_min + " min");
      if (a.distance_km != null) bits.push(a.distance_km + " km");
      if (a.speed_kph != null) bits.push(a.speed_kph + " km/h");
      if (a.avg_power_watts != null) bits.push(a.avg_power_watts + " W");
    } else if (a.sport === "strength" || a.sport === "mobility") {
      if (a.duration_min != null) bits.push(a.duration_min + " min");
    } else {
      if (a.duration_min != null) bits.push(a.duration_min + " min");
      if (a.distance_km != null) bits.push(a.distance_km + " km");
    }
    return bits.join(" · ");
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

  /* ═══════════════════════ PLACEHOLDER TABS ════════════════════════ */

  /* ─── Coach (Messaging) Tab ─── */
  function renderCoachMessaging() {
    var el = document.getElementById("screen-coach-messaging");
    if (!el) return;
    var sorted = sortRoster(_roster);
    var html = '<div style="max-width:720px;margin:0 auto;padding:16px 14px 96px;">' +
      '<h1 style="font-size:20px;font-weight:700;margin:0 0 16px;">Coach Messaging</h1>';
    if (!sorted.length) {
      html += '<div style="padding:40px 16px;text-align:center;color:var(--ink3,#888);">' +
        '<div style="font-size:40px;margin-bottom:12px;">💬</div>' +
        '<div style="font-size:15px;margin-bottom:6px;">No athletes assigned yet</div>' +
        '<div style="font-size:13px;">Assigned athletes will appear here.</div></div>';
    } else {
      sorted.forEach(function (a) {
        html += '<div class="cm-msg-item" data-athlete="' + esc(a.athlete_id) + '" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line,#eee);cursor:pointer;">' +
          '<div style="width:40px;height:40px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;">' + esc(a.initials || "A") + '</div>' +
          '<div style="min-width:0;flex:1;">' +
            '<div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(a.name) + '</div>' +
            '<div style="font-size:12px;color:var(--ink3,#888);">No messages yet</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--ink3,#aaa);">—</div>' +
        '</div>';
      });
    }
    html += '</div>';
    el.innerHTML = html;
    // Bind click to show messaging placeholder
    el.querySelectorAll(".cm-msg-item").forEach(function (item) {
      item.addEventListener("click", function () {
        showMessagingPlaceholder(item.getAttribute("data-athlete"));
      });
    });
  }

  function showMessagingPlaceholder(athleteId) {
    var entry = _roster.find(function (a) { return a.athlete_id === athleteId; });
    var el = document.getElementById("screen-coach-messaging");
    if (!el) return;
    el.innerHTML = '<div style="max-width:720px;margin:0 auto;padding:16px 14px 96px;">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">' +
        '<button class="cm-msg-back" style="border:0;background:transparent;font-size:20px;cursor:pointer;padding:4px;">‹</button>' +
        '<div style="width:36px;height:36px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;">' + esc(entry ? entry.initials : "A") + '</div>' +
        '<div style="font-weight:600;font-size:16px;">' + esc(entry ? entry.name : "Athlete") + '</div>' +
      '</div>' +
      '<div style="padding:60px 20px;text-align:center;color:var(--ink3,#888);">' +
        '<div style="font-size:36px;margin-bottom:12px;">💬</div>' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:6px;">Human coach messaging will appear here</div>' +
        '<div style="font-size:13px;">Direct messaging with your athletes is coming in a future update.</div>' +
      '</div>' +
    '</div>';
    el.querySelector(".cm-msg-back").addEventListener("click", function () { renderCoachMessaging(); });
  }

  /* ─── Train Tab ─── */
  function renderCoachTrain() {
    var el = document.getElementById("screen-coach-train");
    if (!el) return;
    var sorted = sortRoster(_roster);
    var html = '<div style="max-width:720px;margin:0 auto;padding:16px 14px 96px;">' +
      '<h1 style="font-size:20px;font-weight:700;margin:0 0 16px;">Athlete Training</h1>';
    if (!sorted.length) {
      html += '<div style="padding:40px 16px;text-align:center;color:var(--ink3,#888);">' +
        '<div style="font-size:15px;margin-bottom:6px;">No athletes assigned yet</div>' +
        '<div style="font-size:13px;">Assigned athletes will appear here.</div></div>';
    } else {
      sorted.forEach(function (a) {
        var todayLabel = a.today_planned ? esc(a.today_planned.title || "Planned") : "No session";
        var adher = a.adherence_pct != null ? a.adherence_pct + "%" : "—";
        html += '<div class="cm-train-item" data-athlete="' + esc(a.athlete_id) + '" style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">' +
            '<div style="width:36px;height:36px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;">' + esc(a.initials || "A") + '</div>' +
            '<div style="min-width:0;flex:1;">' +
              '<div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(a.name) + '</div>' +
              '<div style="font-size:12px;color:var(--ink3,#888);">' + esc(SPORT_LABEL[a.primary_sport] || "—") + ' · ' + fmtVal(a.goal) + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:10px;font-size:11px;color:var(--ink2,#555);flex-wrap:wrap;">' +
            '<span>Today: <b>' + todayLabel + '</b></span>' +
            '<span>Adherence: <b>' + esc(adher) + '</b></span>' +
            '<span>Active: <b>' + esc(fmtLastActive(a.last_active_at)) + '</b></span>' +
          '</div>' +
        '</div>';
      });
    }
    // Future sections
    html += '<div style="margin-top:24px;padding:20px;border:1px dashed var(--line,#ddd);border-radius:12px;text-align:center;color:var(--ink3,#888);">' +
      '<div style="font-size:14px;font-weight:600;margin-bottom:6px;">Coming soon</div>' +
      '<div style="font-size:12px;">Calendar · Plan editing · Activities · Feedback</div>' +
    '</div>';
    html += '</div>';
    el.innerHTML = html;
    // Bind clicks
    el.querySelectorAll(".cm-train-item").forEach(function (item) {
      item.addEventListener("click", function () {
        openCoachAthletePage(item.getAttribute("data-athlete"), "training");
      });
    });
  }

  /* ─── Trends Tab ─── */
  function renderCoachTrends() {
    var el = document.getElementById("screen-coach-trends");
    if (!el) return;
    var sorted = sortRoster(_roster);
    var html = '<div style="max-width:720px;margin:0 auto;padding:16px 14px 96px;">' +
      '<h1 style="font-size:20px;font-weight:700;margin:0 0 16px;">Athlete Trends</h1>';
    if (!sorted.length) {
      html += '<div style="padding:40px 16px;text-align:center;color:var(--ink3,#888);">' +
        '<div style="font-size:15px;margin-bottom:6px;">No athletes assigned yet</div>' +
        '<div style="font-size:13px;">Assigned athletes will appear here.</div></div>';
    } else {
      html += '<label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px;">Select an athlete</label>' +
        '<select id="cmTrendsSelect" style="width:100%;padding:10px;border:1px solid var(--line,#ddd);border-radius:10px;font-size:14px;margin-bottom:16px;">' +
        '<option value="">Choose athlete…</option>';
      sorted.forEach(function (a) {
        html += '<option value="' + esc(a.athlete_id) + '">' + esc(a.name) + ' · ' + esc(SPORT_LABEL[a.primary_sport] || "Athlete") + '</option>';
      });
      html += '</select>';
      html += '<div id="cmTrendsBody" style="padding:20px;text-align:center;color:var(--ink3,#888);">' +
        '<div style="font-size:13px;">Select an athlete to view their trends.</div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
    var sel = document.getElementById("cmTrendsSelect");
    if (sel) {
      sel.addEventListener("change", function () {
        var athleteId = sel.value;
        var body = document.getElementById("cmTrendsBody");
        if (!body) return;
        if (!athleteId) { body.innerHTML = '<div style="font-size:13px;">Select an athlete to view their trends.</div>'; return; }
        var entry = _roster.find(function (a) { return a.athlete_id === athleteId; });
        if (!entry) return;
        body.innerHTML =
          '<div style="text-align:left;">' +
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
              '<div style="width:40px;height:40px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;">' + esc(entry.initials || "A") + '</div>' +
              '<div><div style="font-weight:700;font-size:16px;">' + esc(entry.name) + '</div>' +
              '<div style="font-size:12px;color:var(--ink3,#888);">' + esc(SPORT_LABEL[entry.primary_sport] || "—") + '</div></div>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">' +
              '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:11px;color:var(--ink3,#888);">Readiness</div><div style="font-size:16px;font-weight:700;">' + fmtVal(entry.readiness_status) + '</div></div>' +
              '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:11px;color:var(--ink3,#888);">Recovery</div><div style="font-size:16px;font-weight:700;">' + fmtVal(entry.recovery_status === "unknown" ? null : entry.recovery_status) + '</div></div>' +
              '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:11px;color:var(--ink3,#888);">7d Load</div><div style="font-size:16px;font-weight:700;">' + fmtVal(entry.seven_day_load) + '</div></div>' +
              '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:11px;color:var(--ink3,#888);">Adherence</div><div style="font-size:16px;font-weight:700;">' + (entry.adherence_pct != null ? entry.adherence_pct + "%" : "—") + '</div></div>' +
            '</div>' +
            '<div style="padding:20px;border:1px dashed var(--line,#ddd);border-radius:12px;text-align:center;color:var(--ink3,#888);">' +
              '<div style="font-size:14px;font-weight:600;margin-bottom:4px;">Detailed coach trends are coming next</div>' +
              '<div style="font-size:12px;">Training load history, readiness trends, and performance data will appear here.</div>' +
            '</div>' +
          '</div>';
      });
    }
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
        '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:var(--r-lg);padding:14px;text-align:center;">' +
          '<div style="font-size:24px;font-weight:700;">' + _roster.length + '</div>' +
          '<div style="font-size:var(--fs-caption);color:var(--ink3);">Active athletes</div>' +
        '</div>' +
        '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:var(--r-lg);padding:14px;text-align:center;">' +
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
        '<div><b>Open Coach Dashboard</b><small>View and manage your athletes.</small></div><span class="arr">→</span>' +
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
      logoutBtn.addEventListener("click", async function () {
        clearWorkspacePref();
        var c = sb();
        if (c) { try { await c.auth.signOut(); } catch (e) {} }
        location.reload();
      });
    }
  }

  /* ═══════════════════════ REFRESH ═════════════════════════════════ */

  async function refreshRoster() {
    _rosterLoading = true;
    _rosterError = null;
    renderCoachToday();
    var res = await api("roster");
    _rosterLoading = false;
    if (!res.ok) {
      _rosterError = "Could not refresh roster.";
      renderCoachToday();
      return;
    }
    _roster = (res.body && res.body.athletes) || [];
    _role = (res.body && res.body.role) || _role;
    renderCoachToday();
  }

  /* ═══════════════════════ INITIALIZATION ══════════════════════════ */

  /*
   * Replace the first-frame athlete shell only after routeAfterAuth has
   * confirmed an authenticated coach/admin profile. This is visual routing
   * only: the server-authoritative roster request in resolveMode() still
   * decides whether Coach Workspace can actually activate.
   */
  function prepareDashboardLoading(profile) {
    var isCoachProfile = profile && (profile.role === "coach" || profile.role === "admin");
    var gate = document.getElementById("boot-gate");
    var content = gate && gate.querySelector(".boot-content");
    if (!isCoachProfile || readWorkspacePref() === "athlete_workspace" ||
        !document.body.classList.contains("booting") || !content) return false;

    ensureCoachCommandStyles();
    document.body.classList.add("coach-loading");
    gate.setAttribute("aria-label", "Loading Coach Dashboard");
    content.innerHTML = renderCoachSkeleton();

    // Show the real tabbar with coach tabs during loading so bottom
    // navigation stays visible while the boot-gate skeleton is up.
    // The CSS rule body.coach-loading #tabbar{display:flex!important}
    // overrides body.booting #tabbar{display:none!important}.
    rewriteNavigation();
    if (window.AthlevoAppMotion && typeof window.AthlevoAppMotion.syncIndicator === "function") {
      window.AthlevoAppMotion.syncIndicator(false);
    }

    return true;
  }

  async function init() {
    if (_initialized) return;
    _initialized = true;

    var mode = await resolveMode();
    trackCoach("coach_mode_resolved", { coach_mode: mode });

    if (mode !== "coach_mode") {
      // Athlete or unknown — leave the app unchanged.
      // prepareDashboardLoading may have set coach tabs; restore athlete nav.
      restoreAthleteNavigation();
      return;
    }

    // Resolve coach name from Supabase profile
    try {
      var c = sb();
      if (c) {
        var u = await c.auth.getUser();
        var uid = u && u.data && u.data.user && u.data.user.id;
        if (uid) {
          var q = await c.from("profiles").select("full_name").eq("id", uid).maybeSingle();
          _coachName = (q && q.data && q.data.full_name) || null;
        }
      }
    } catch (e) {}

    // Resolve workspace preference
    var ws = resolveWorkspace();

    if (ws === "athlete_workspace") {
      // Coach/admin chose athlete workspace — skip coach UI, let athlete
      // init run in index.html (isCoachMode() returns true but
      // isAthleteWorkspace() tells the caller to continue athlete flow)
      _workspace = "athlete_workspace";
      writeWorkspacePref("athlete_workspace");
      // prepareDashboardLoading may have rewritten the tabbar to coach
      // tabs — restore athlete navigation before handing off.
      restoreAthleteNavigation();
      return;
    }

    // Enter Coach Workspace (default for coach/admin)
    _workspace = "coach_workspace";
    writeWorkspacePref("coach_workspace");

    ensureCoachScreens();
    rewriteNavigation();

    // Hide all athlete screens, show Coach Today inside the existing
    // #screen-today element (same position in the .device flex layout).
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    var todayEl = document.getElementById("screen-today");
    if (todayEl) todayEl.classList.add("active");

    // Hide athlete-only screens so they don't appear in coach workspace
    var athleteOnly = ["screen-coachai", "screen-train", "screen-trends", "screen-you"];
    athleteOnly.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = "none";
    });

    renderCoachToday();

    trackCoach("coach_today_viewed", {
      coach_mode: "coach_mode",
      source_surface: "coach_init",
      roster_size_band: rosterBand(_roster.length)
    });
  }

  /* ═══════════════════════ PUBLIC API ══════════════════════════════ */

  window.AthlevoCoachMode = {
    init: init,
    prepareDashboardLoading: prepareDashboardLoading,
    go: coachGo,
    getMode: function () { return _appMode; },
    isCoachMode: function () { return _appMode === "coach_mode"; },
    isCoachWorkspace: function () { return _appMode === "coach_mode" && _workspace === "coach_workspace"; },
    isAthleteWorkspace: function () { return _workspace === "athlete_workspace"; },
    getWorkspace: function () { return _workspace; },
    switchToCoachWorkspace: activateCoachWorkspace,
    switchToAthleteWorkspace: activateAthleteWorkspace,
    clearWorkspaceOnLogout: clearWorkspacePref,
    injectAthleteYouSwitcher: injectAthleteYouSwitcher,
    _roster: function () { return _roster; },
    _state: function () { return { mode: _appMode, role: _role, coachName: _coachName, rosterSize: _roster.length, workspace: _workspace }; },
    COACH_MODE_VERSION: "coach-mode-v2"
  };
})();
