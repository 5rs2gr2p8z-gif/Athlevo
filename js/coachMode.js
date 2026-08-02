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
  var _initialized = false;
  var _resolving = false;

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
  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) { return String(iso).slice(0, 10); }
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
             d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return String(iso).slice(0, 16); }
  }
  function daysUntil(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.ceil((t - Date.now()) / 86400000);
  }
  function greeting() {
    var h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
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

  var COACH_SCREENS = [
    "screen-coach-today",
    "screen-coach-messaging",
    "screen-coach-train",
    "screen-coach-trends",
    "screen-coach-you"
  ];

  function ensureCoachScreens() {
    if (document.getElementById("screen-coach-today")) return;
    var host = document.querySelector(".app-shell") || document.body;
    COACH_SCREENS.forEach(function (id) {
      var el = document.createElement("section");
      el.id = id;
      el.className = "screen";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", id.replace("screen-coach-", "Coach "));
      host.appendChild(el);
    });
  }

  /* ═══════════════════════ NAVIGATION ══════════════════════════════ */

  var COACH_TABS = [
    { screen: "screen-coach-today",     label: "Today",  icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>' },
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

  /* Coach tab switching — replaces the athlete `go()` for coach screens */
  function coachGo(btn) {
    var screenId = btn.dataset.screen;
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("on"); });
    btn.classList.add("on");
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    var screenEl = document.getElementById(screenId);
    if (screenEl) screenEl.classList.add("active");
    window.scrollTo(0, 0);

    // Analytics
    var TAB_EVENTS = {
      "screen-coach-today": "coach_today_viewed",
      "screen-coach-messaging": "coach_tab_viewed",
      "screen-coach-train": "coach_train_viewed",
      "screen-coach-trends": "coach_trends_viewed",
      "screen-coach-you": "coach_you_viewed"
    };
    var TAB_NAMES = {
      "screen-coach-today": "today",
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
    if (screenId === "screen-coach-today") renderCoachToday();
    if (screenId === "screen-coach-messaging") renderCoachMessaging();
    if (screenId === "screen-coach-train") renderCoachTrain();
    if (screenId === "screen-coach-trends") renderCoachTrends();
    if (screenId === "screen-coach-you") renderCoachYou();
  }

  /* ═══════════════════════ COACH TODAY ═════════════════════════════ */

  function renderCoachToday() {
    var el = document.getElementById("screen-coach-today");
    if (!el) return;

    var sorted = sortRoster(_roster);
    var needsAttn = sorted.filter(function (a) { return a.attention_status === "needs_attention"; });
    var monitoring = sorted.filter(function (a) { return a.attention_status === "monitor"; });
    var onTrack = sorted.filter(function (a) { return a.attention_status === "on_track"; });
    var noData = sorted.filter(function (a) { return a.attention_status === "no_recent_data"; });

    // Training today
    var trainingToday = sorted.filter(function (a) { return a.today_planned; });
    var completedToday = sorted.filter(function (a) {
      return a.today_planned && a.today_planned.status === "completed";
    });

    // Recent activity (from latest_activity on each athlete)
    var recentActs = sorted.filter(function (a) { return a.latest_activity; })
      .map(function (a) { return { name: a.name, initials: a.initials, athlete_id: a.athlete_id, activity: a.latest_activity, primary_sport: a.primary_sport }; })
      .sort(function (a, b) {
        var da = a.activity.date || "", db = b.activity.date || "";
        return db.localeCompare(da);
      }).slice(0, 10);

    // Upcoming events
    var upcoming = sorted.filter(function (a) { return a.target_event; })
      .map(function (a) { return { name: a.name, initials: a.initials, athlete_id: a.athlete_id, event: a.target_event, primary_sport: a.primary_sport }; });

    var name = _coachName || "Coach";
    var firstName = name.split(" ")[0];
    var attnCount = needsAttn.length + monitoring.length;

    el.innerHTML =
      '<div class="cm-wrap" style="max-width:720px;margin:0 auto;padding:16px 14px 96px;">' +
      // Header
      '<div style="margin-bottom:20px;">' +
        '<h1 style="font-size:22px;font-weight:700;margin:0 0 2px;">' + esc(greeting()) + ', Coach ' + esc(firstName) + '</h1>' +
        '<p style="font-size:14px;color:var(--ink3,#888);margin:0;">' +
          (attnCount > 0 ? esc(attnCount) + ' athlete' + (attnCount !== 1 ? 's' : '') + ' need' + (attnCount === 1 ? 's' : '') + ' your attention today' : 'All athletes are on track') +
        '</p>' +
      '</div>' +
      // Summary cards
      renderSummaryCards(sorted.length, needsAttn.length, trainingToday.length, completedToday.length, noData.length) +
      // Needs attention
      (needsAttn.length ? renderAttentionSection(needsAttn) : '') +
      // Monitor
      (monitoring.length ? renderMonitorSection(monitoring) : '') +
      // Training today
      renderTrainingTodaySection(trainingToday) +
      // Recent activity
      renderRecentActivitySection(recentActs) +
      // Upcoming events
      renderUpcomingEventsSection(upcoming) +
      // Roster status
      renderRosterStatusSection(sorted) +
      '</div>';

    // Bind event handlers
    bindCoachTodayEvents(el);
  }

  function renderSummaryCards(total, attn, training, completed, noData) {
    var cards = [
      { label: "Active athletes", value: total, color: "var(--ink1,#333)" },
      { label: "Needs attention", value: attn, color: attn > 0 ? "#c0392b" : "var(--ink1,#333)" },
      { label: "Training today", value: training, color: "var(--ink1,#333)" },
      { label: "Completed today", value: completed, color: completed > 0 ? "#2e7d32" : "var(--ink1,#333)" },
      { label: "No recent data", value: noData, color: noData > 0 ? "#888" : "var(--ink1,#333)" }
    ];
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:20px;">' +
      cards.map(function (c) {
        return '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:12px 10px;text-align:center;">' +
          '<div style="font-size:22px;font-weight:700;color:' + c.color + ';">' + c.value + '</div>' +
          '<div style="font-size:11px;color:var(--ink3,#888);margin-top:2px;">' + c.label + '</div>' +
        '</div>';
      }).join("") +
    '</div>';
  }

  /* ─── Needs Attention ─── */
  function renderAttentionSection(athletes) {
    var html = '<div style="margin-bottom:20px;">' +
      '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px;color:#c0392b;">Needs attention</h2>';
    athletes.forEach(function (a) {
      var reasons = (a.attention_reason_keys || []).slice(0, 3);
      html += renderAttentionCard(a, reasons);
    });
    return html + '</div>';
  }

  function renderMonitorSection(athletes) {
    var html = '<div style="margin-bottom:20px;">' +
      '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px;color:#c77d0a;">Monitor</h2>';
    athletes.forEach(function (a) {
      var reasons = (a.attention_reason_keys || []).slice(0, 3);
      html += renderAttentionCard(a, reasons);
    });
    return html + '</div>';
  }

  function renderAttentionCard(a, reasons) {
    var meta = STATUS_META[a.attention_status] || STATUS_META.no_recent_data;
    var reasonLabels = reasons.map(function (k) { return esc(k.replace(/_/g, " ")); }).join(", ");
    return '<div class="cm-attn-card" style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-left:3px solid ' + meta.color + ';border-radius:12px;padding:12px 14px;margin-bottom:8px;">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
        '<div style="width:36px;height:36px;border-radius:50%;background:' + meta.bg + ';display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;color:' + meta.color + ';">' + esc(a.initials || "A") + '</div>' +
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(a.name) + '</div>' +
          '<div style="font-size:12px;color:var(--ink3,#888);">' + esc(SPORT_LABEL[a.primary_sport] || "—") + '</div>' +
        '</div>' +
        '<span style="font-size:10px;font-weight:600;color:#fff;background:' + meta.color + ';border-radius:999px;padding:2px 8px;">' + esc(a.attention_severity || "medium") + '</span>' +
      '</div>' +
      (reasonLabels ? '<div style="font-size:12px;color:' + meta.color + ';margin-bottom:8px;">' + reasonLabels + '</div>' : '') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="cm-view-athlete" data-athlete="' + esc(a.athlete_id) + '" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid var(--line,#ddd);background:transparent;cursor:pointer;">View athlete</button>' +
        '<button class="cm-mark-reviewed" data-athlete="' + esc(a.athlete_id) + '" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid var(--line,#ddd);background:transparent;cursor:pointer;">Mark reviewed</button>' +
      '</div>' +
    '</div>';
  }

  /* ─── Training Today ─── */
  function renderTrainingTodaySection(athletes) {
    var html = '<div style="margin-bottom:20px;">' +
      '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px;">Training today</h2>';
    if (!athletes.length) {
      return html + '<div style="padding:16px;text-align:center;color:var(--ink3,#888);font-size:13px;">No athletes have planned sessions today.</div></div>';
    }
    athletes.forEach(function (a) {
      var s = a.today_planned || {};
      var sport = SPORT_LABEL[s.sport || a.primary_sport] || "Activity";
      var title = esc(s.title || s.session_type || "Planned session");
      var duration = s.duration_minutes ? s.duration_minutes + " min" : null;
      var distance = s.distance_km ? s.distance_km + " km" : null;
      var details = [sport, duration, distance].filter(Boolean).join(" · ");

      html += '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;">' +
        '<div style="width:36px;height:36px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;">' + esc(a.initials || "A") + '</div>' +
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(a.name) + '</div>' +
          '<div style="font-size:12px;color:var(--ink3,#888);">' + title + '</div>' +
          '<div style="font-size:11px;color:var(--ink3,#888);margin-top:2px;">' + esc(details) + '</div>' +
        '</div>' +
        '<div style="text-align:right;font-size:11px;">' +
          '<div style="color:var(--ink3,#888);">' + esc(a.readiness_status || "—") + '</div>' +
        '</div>' +
      '</div>';
    });
    return html + '</div>';
  }

  /* ─── Recent Activity ─── */
  function renderRecentActivitySection(recentActs) {
    var html = '<div style="margin-bottom:20px;">' +
      '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px;">Recent activity</h2>';
    if (!recentActs.length) {
      return html + '<div style="padding:16px;text-align:center;color:var(--ink3,#888);font-size:13px;">No recent activities across assigned athletes.</div></div>';
    }
    recentActs.forEach(function (r) {
      var act = r.activity;
      var sport = SPORT_LABEL[act.sport] || "Activity";
      var bits = [sport];
      if (act.duration_min) bits.push(act.duration_min + " min");
      if (act.distance_km) bits.push(act.distance_km + " km");
      var summary = bits.join(" · ");
      html += '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;">' + esc(r.initials || "A") + '</div>' +
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-size:13px;"><b>' + esc(r.name) + '</b> · ' + esc(summary) + '</div>' +
          '<div style="font-size:11px;color:var(--ink3,#888);">' + esc(fmtDateTime(act.date)) + '</div>' +
        '</div>' +
      '</div>';
    });
    return html + '</div>';
  }

  /* ─── Upcoming Events ─── */
  function renderUpcomingEventsSection(upcoming) {
    var html = '<div style="margin-bottom:20px;">' +
      '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px;">Upcoming events</h2>';
    if (!upcoming.length) {
      return html + '<div style="padding:16px;text-align:center;color:var(--ink3,#888);font-size:13px;">No athletes have upcoming target events.</div></div>';
    }
    upcoming.forEach(function (u) {
      html += '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;">' + esc(u.initials || "A") + '</div>' +
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(u.name) + '</div>' +
          '<div style="font-size:12px;color:var(--ink3,#888);">' + esc(u.event) + '</div>' +
        '</div>' +
        '<div style="text-align:right;font-size:11px;color:var(--ink3,#888);">' +
          esc(SPORT_LABEL[u.primary_sport] || "—") +
        '</div>' +
      '</div>';
    });
    return html + '</div>';
  }

  /* ─── Roster Status ─── */
  function renderRosterStatusSection(sorted) {
    var html = '<div style="margin-bottom:20px;">' +
      '<h2 style="font-size:16px;font-weight:700;margin:0 0 10px;">Roster status</h2>' +
      '<input id="cmRosterSearch" type="search" placeholder="Search athletes by name" ' +
        'style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--line,#e3e3e3);border-radius:10px;margin-bottom:10px;font-size:13px;" />' +
      '<div id="cmRosterList">';
    html += renderRosterList(sorted, "");
    html += '</div></div>';
    return html;
  }

  function renderRosterList(sorted, query) {
    var q = (query || "").toLowerCase().trim();
    var visible = sorted.filter(function (a) {
      return !q || String(a.name || "").toLowerCase().indexOf(q) !== -1;
    });
    if (!visible.length) {
      return '<div style="padding:16px;text-align:center;color:var(--ink3,#888);font-size:13px;">' +
        (q ? 'No athletes match "' + esc(q) + '".' : 'No athletes assigned yet.') + '</div>';
    }
    return visible.map(function (a) {
      var meta = STATUS_META[a.attention_status] || STATUS_META.no_recent_data;
      var sport = SPORT_LABEL[a.primary_sport] || "—";
      var load = a.seven_day_load != null ? a.seven_day_load : "—";
      var adher = a.adherence_pct != null ? a.adherence_pct + "%" : "—";
      var todayLabel = a.today_planned ? (a.today_planned.title || "Planned") : "—";
      return '<div class="cm-roster-item" data-athlete="' + esc(a.athlete_id) + '" style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:10px 14px;margin-bottom:6px;cursor:pointer;">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">' +
          '<div style="width:32px;height:32px;border-radius:50%;background:' + meta.bg + ';display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;color:' + meta.color + ';">' + esc(a.initials || "A") + '</div>' +
          '<div style="min-width:0;flex:1;">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(a.name) + '</span>' +
              '<span style="flex:0 0 auto;font-size:10px;font-weight:600;color:#fff;background:' + meta.color + ';border-radius:999px;padding:1px 7px;">' + esc(meta.label) + '</span>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--ink3,#888);">' + esc(sport) + ' · ' + fmtVal(a.goal) + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;font-size:11px;color:var(--ink2,#555);flex-wrap:wrap;">' +
          '<span>Today: <b>' + esc(todayLabel).substring(0, 20) + '</b></span>' +
          '<span>Readiness: <b>' + fmtVal(a.readiness_status) + '</b></span>' +
          '<span>Recovery: <b>' + fmtVal(a.recovery_status === "unknown" ? null : a.recovery_status) + '</b></span>' +
          '<span>7d: <b>' + esc(load) + '</b></span>' +
          '<span>Adh: <b>' + esc(adher) + '</b></span>' +
          '<span>Active: <b>' + esc(fmtLastActive(a.last_active_at)) + '</b></span>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  /* ─── Event Binding for Coach Today ─── */
  function bindCoachTodayEvents(container) {
    // View athlete buttons
    container.querySelectorAll(".cm-view-athlete").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-athlete");
        openCoachAthleteDrawer(id);
        trackCoach("coach_today_athlete_opened", { coach_mode: "coach_mode", source_surface: "coach_today" });
      });
    });
    // Mark reviewed buttons
    container.querySelectorAll(".cm-mark-reviewed").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-athlete");
        markAthleteReviewed(id, btn);
      });
    });
    // Roster items
    container.querySelectorAll(".cm-roster-item").forEach(function (item) {
      item.addEventListener("click", function () {
        var id = item.getAttribute("data-athlete");
        openCoachAthleteDrawer(id);
        trackCoach("coach_today_athlete_opened", { coach_mode: "coach_mode", source_surface: "coach_roster" });
      });
    });
    // Roster search
    var searchInput = document.getElementById("cmRosterSearch");
    if (searchInput) {
      searchInput.addEventListener("input", function (e) {
        _search = e.target.value || "";
        var listEl = document.getElementById("cmRosterList");
        if (listEl) listEl.innerHTML = renderRosterList(sortRoster(_roster), _search);
        // Re-bind roster click handlers
        var rosterItems = listEl ? listEl.querySelectorAll(".cm-roster-item") : [];
        rosterItems.forEach(function (item) {
          item.addEventListener("click", function () {
            openCoachAthleteDrawer(item.getAttribute("data-athlete"));
          });
        });
      });
    }
  }

  /* ─── Athlete Drawer (reuses existing Coach Dashboard drawer logic) ─── */
  function openCoachAthleteDrawer(athleteId) {
    // Delegate to existing coach dashboard if available
    if (window.AthlevoCoachDashboard && typeof window.AthlevoCoachDashboard._loadAndRender === "function") {
      // Use the API directly
    }
    var entry = _roster.find(function (a) { return a.athlete_id === athleteId; });
    showDrawer(entry, athleteId);
  }

  async function showDrawer(entry, athleteId) {
    var overlay = document.createElement("div");
    overlay.id = "cmOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:60;";
    var drawer = document.createElement("div");
    drawer.id = "cmDrawer";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-label", "Athlete overview");
    drawer.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:61;max-width:720px;margin:0 auto;background:var(--bg,#fff);border-radius:18px 18px 0 0;max-height:88vh;overflow:auto;padding:18px 16px 40px;";
    drawer.innerHTML = '<div style="padding:24px;text-align:center;color:var(--ink3,#888);">Loading athlete…</div>';
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
    overlay.addEventListener("click", closeDrawer);

    var res = await api("athlete", { query: { athlete_id: athleteId } });
    if (!res.ok || !res.body || !res.body.athlete) {
      drawer.innerHTML = '<div style="padding:24px;text-align:center;color:#c0392b;">' +
        (res.status === 403 ? "You are not assigned to this athlete." : "Could not load this athlete.") +
        '<br><button id="cmDrawerClose" style="margin-top:10px;padding:8px 14px;border-radius:10px;border:1px solid var(--line,#ddd);background:transparent;cursor:pointer;">Close</button></div>';
      var cb = document.getElementById("cmDrawerClose"); if (cb) cb.addEventListener("click", closeDrawer);
      return;
    }
    renderAthleteDrawer(drawer, res.body.athlete, entry);
  }

  function renderAthleteDrawer(drawer, ath, rosterEntry) {
    var reasons = (ath.attention_reasons || []).map(function (r) {
      return '<li style="margin-bottom:4px;">' + esc(r.explanation || r.key) + '</li>';
    }).join("");
    var acts = (ath.recent_activities || []).map(function (a) {
      return '<li style="margin-bottom:4px;">' + esc(activityLine(a)) + (a.indoor ? ' · indoor' : '') + '</li>';
    }).join("") || '<li style="color:var(--ink3,#888);">No recent data</li>';
    var wk = ath.week_planned_vs_completed || {};
    var pv = function (v, s) { return v == null ? "—" : esc(v) + (s || ""); };

    drawer.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '  <div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
      '    <div style="width:38px;height:38px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;">' + esc(ath.initials || "A") + '</div>' +
      '    <div style="min-width:0;"><div style="font-weight:700;font-size:16px;">' + esc(ath.name) + '</div>' +
      '    <div style="font-size:12px;color:var(--ink3,#888);">' + esc(SPORT_LABEL[ath.primary_sport] || "—") + (ath.goal ? ' · ' + esc(ath.goal) : '') + '</div></div>' +
      '  </div>' +
      '  <button id="cmDrawerClose" aria-label="Close" style="border:0;background:transparent;font-size:22px;cursor:pointer;">×</button>' +
      '</div>' +
      (reasons ? '<div style="margin-bottom:14px;"><div style="font-weight:600;font-size:13px;margin-bottom:6px;">Needs attention</div><ul style="margin:0;padding-left:18px;font-size:13px;">' + reasons + '</ul>' +
        '<button id="cmReview" data-athlete="' + esc(ath.athlete_id) + '" style="margin-top:8px;padding:7px 12px;border-radius:10px;border:1px solid var(--line,#ddd);background:transparent;cursor:pointer;font-size:13px;">Mark reviewed</button></div>' : '') +
      '<div style="font-size:13px;line-height:1.7;">' +
      '  <div><b>Event:</b> ' + pv(ath.target_event) + '</div>' +
      '  <div><b>Plan phase:</b> ' + pv(ath.plan_phase) + '</div>' +
      '  <div><b>Today:</b> ' + (ath.today_planned ? esc(ath.today_planned.title || "Planned session") : "—") + '</div>' +
      '  <div><b>This week:</b> ' + pv(wk.completed_minutes, " min") + ' completed of ' + pv(wk.planned_minutes, " min") + ' planned</div>' +
      '  <div><b>Readiness:</b> ' + pv(ath.readiness && ath.readiness.status) + (ath.readiness && ath.readiness.pain_present ? ' · pain reported' : '') + '</div>' +
      '  <div><b>Recovery:</b> ' + pv(ath.recovery_status === "unknown" ? null : ath.recovery_status) + '</div>' +
      '  <div><b>Last sync:</b> ' + esc(fmtLastActive(ath.last_sync_at)) + ' · <b>Last active:</b> ' + esc(fmtLastActive(ath.last_active_at)) + '</div>' +
      '</div>' +
      '<div style="margin-top:14px;"><div style="font-weight:600;font-size:13px;margin-bottom:6px;">Recent activities</div><ul style="margin:0;padding-left:18px;font-size:13px;">' + acts + '</ul></div>';

    document.getElementById("cmDrawerClose").addEventListener("click", closeDrawer);
    var rv = document.getElementById("cmReview");
    if (rv) rv.addEventListener("click", function () { markAthleteReviewed(ath.athlete_id, rv); });
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

  function closeDrawer() {
    var overlay = document.getElementById("cmOverlay");
    var drawer = document.getElementById("cmDrawer");
    if (overlay) overlay.remove();
    if (drawer) drawer.remove();
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
        openCoachAthleteDrawer(item.getAttribute("data-athlete"));
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
    var html = '<div style="max-width:720px;margin:0 auto;padding:16px 14px 96px;">' +
      // Profile header
      '<div style="display:flex;align-items:center;gap:14px;margin-bottom:24px;">' +
        '<div style="width:56px;height:56px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;">' + esc(name.split(" ").map(function(w){return w[0];}).join("").toUpperCase().slice(0,2) || "C") + '</div>' +
        '<div>' +
          '<h1 style="font-size:20px;font-weight:700;margin:0;">' + esc(name) + '</h1>' +
          '<p style="font-size:13px;color:var(--ink3,#888);margin:2px 0 0;text-transform:capitalize;">' + esc(role) + '</p>' +
        '</div>' +
      '</div>' +
      // Stats
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:24px;">' +
        '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:14px;text-align:center;">' +
          '<div style="font-size:24px;font-weight:700;">' + _roster.length + '</div>' +
          '<div style="font-size:12px;color:var(--ink3,#888);">Active athletes</div>' +
        '</div>' +
        '<div style="background:var(--card,#fff);border:1px solid var(--line,#eee);border-radius:12px;padding:14px;text-align:center;">' +
          '<div style="font-size:24px;font-weight:700;color:var(--ink3,#aaa);">—</div>' +
          '<div style="font-size:12px;color:var(--ink3,#888);">Athlete capacity</div>' +
        '</div>' +
      '</div>' +
      // Links
      '<div style="margin-bottom:24px;">';

    var links = [
      { label: "Pending invitations", sub: "Coming soon", action: null },
      { label: "Offers", sub: "Coming soon", action: null },
      { label: "Notification settings", sub: "Coming soon", action: null },
      { label: "Account settings", sub: "Manage your coach account", action: null },
      { label: "Support", sub: "Get help with Athlevo", action: null }
    ];
    links.forEach(function (l) {
      html += '<div style="padding:14px 0;border-bottom:1px solid var(--line,#eee);display:flex;justify-content:space-between;align-items:center;">' +
        '<div><div style="font-size:14px;font-weight:600;">' + esc(l.label) + '</div>' +
        '<div style="font-size:12px;color:var(--ink3,#888);">' + esc(l.sub) + '</div></div>' +
        '<span style="color:var(--ink3,#aaa);">›</span>' +
      '</div>';
    });

    html += '</div>' +
      '<button id="cmLogout" style="width:100%;padding:14px;border:1px solid #c0392b;border-radius:12px;background:transparent;color:#c0392b;font-size:14px;font-weight:600;cursor:pointer;">Log out</button>' +
    '</div>';
    el.innerHTML = html;
    var logoutBtn = document.getElementById("cmLogout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async function () {
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
    var res = await api("roster");
    _rosterLoading = false;
    if (!res.ok) {
      _rosterError = "Could not refresh roster.";
      return;
    }
    _roster = (res.body && res.body.athletes) || [];
    _role = (res.body && res.body.role) || _role;
  }

  /* ═══════════════════════ INITIALIZATION ══════════════════════════ */

  async function init() {
    if (_initialized) return;
    _initialized = true;

    var mode = await resolveMode();
    trackCoach("coach_mode_resolved", { coach_mode: mode });

    if (mode !== "coach_mode") {
      // Athlete or unknown — leave the app unchanged
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

    // Enter Coach Mode
    ensureCoachScreens();
    rewriteNavigation();

    // Hide all athlete screens, show Coach Today
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    document.getElementById("screen-coach-today").classList.add("active");
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
    go: coachGo,
    getMode: function () { return _appMode; },
    isCoachMode: function () { return _appMode === "coach_mode"; },
    _roster: function () { return _roster; },
    _state: function () { return { mode: _appMode, role: _role, coachName: _coachName, rosterSize: _roster.length }; },
    COACH_MODE_VERSION: "coach-mode-v1"
  };
})();
