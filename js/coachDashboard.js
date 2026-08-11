/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach Dashboard (client)   ·   window.AthlevoCoachDashboard
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The legacy #coach entry is role-gated and now hands confirmed coaches to
 *  the current Coach Workspace command center. The roster-only screen remains
 *  as a defensive fallback for older shells that do not load coachMode.js.
 *  Athletes never see the entry and are redirected if they force the route.
 *  The browser UI is NOT the security boundary — every data read goes through
 *  /api/providers?action=coaching_dashboard_*, which re-checks role + active assignment server-side.
 *
 *  · Route: hash '#coach' (PWA/back/refresh safe). Athlete bottom nav is
 *    untouched; a Coach entry is injected into the You screen only for
 *    coach/admin.
 *  · Renders the roster (with states, sorting, name search) and an athlete
 *    overview drawer. No plan editing, no messaging.
 *  · Never puts athlete name/email/UUID/health values into analytics.
 */

(function () {
  "use strict";

  var ROOT_ID = "screen-coach";
  var state = { role: null, enabled: false, athletes: [], search: "", loading: false, error: null };

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

  async function myRole() {
    var c = sb();
    if (!c) return "athlete";
    try {
      var u = await c.auth.getUser();
      var uid = u && u.data && u.data.user && u.data.user.id;
      if (!uid) return "athlete";
      // RLS allows reading one's OWN profile row.
      var q = await c.from("profiles").select("role").eq("id", uid).maybeSingle();
      var role = q && q.data && q.data.role;
      return role === "coach" || role === "admin" ? role : "athlete";
    } catch (e) { return "athlete"; }
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

  /* ─────────────────────────── DOM ─────────────────────────── */

  function ensureRoot() {
    var el = document.getElementById(ROOT_ID);
    if (el) return el;
    el = document.createElement("section");
    el.id = ROOT_ID;
    el.className = "screen";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Coach dashboard");
    // Reuse existing design tokens; keep layout mobile-safe (no fixed widths).
    el.innerHTML =
      '<div class="cd-wrap" style="max-width:720px;margin:0 auto;padding:16px 14px 96px;">' +
      '  <header class="cd-head" style="display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:14px;">' +
      '    <div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
      '      <button id="cdBack" aria-label="Back to app" style="border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;padding:4px;">‹</button>' +
      '      <h1 style="font-size:18px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Coach dashboard</h1>' +
      '    </div>' +
      '    <button id="cdRefresh" style="border:0;background:transparent;cursor:pointer;font-size:13px;color:var(--ink3,#888);padding:6px;">Refresh</button>' +
      '  </header>' +
      '  <input id="cdSearch" type="search" placeholder="Search athletes by name" ' +
      '     style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line,#e3e3e3);border-radius:12px;margin-bottom:12px;font-size:14px;" />' +
      '  <div id="cdBody" aria-live="polite"></div>' +
      '  <div id="cdDrawer" hidden></div>' +
      "</div>";
    // Append to the app shell if present, else body.
    var host = document.querySelector(".app-shell") || document.body;
    host.appendChild(el);

    el.querySelector("#cdBack").addEventListener("click", closeDashboard);
    el.querySelector("#cdRefresh").addEventListener("click", function () { loadAndRender(true); });
    el.querySelector("#cdSearch").addEventListener("input", function (e) {
      state.search = String(e.target.value || "").toLowerCase();
      renderRoster();
    });
    return el;
  }

  /* ─────────────────────── state helpers ────────────────────── */

  var STATUS_META = {
    needs_attention: { label: "Needs attention", order: 0, color: "#c0392b" },
    monitor:         { label: "Monitor",         order: 1, color: "#c77d0a" },
    no_recent_data:  { label: "No recent data",  order: 2, color: "#888" },
    on_track:        { label: "On track",        order: 3, color: "#2e7d32" }
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
  var SPORT_LABEL = { run: "Run", ride: "Ride", strength: "Strength", swim: "Swim", walk: "Walk", hike: "Hike", mobility: "Mobility", cross_training: "Cross-train", rest: "Rest", other: "Activity" };

  /* ─────────────────────────── render ───────────────────────── */

  function renderRoster() {
    var body = document.getElementById("cdBody");
    if (!body) return;

    if (state.loading) { body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--ink3,#888);">Loading roster…</div>'; return; }
    if (state.error) {
      body.innerHTML = '<div style="padding:24px;text-align:center;color:#c0392b;">' +
        esc(state.error) + '<br><button id="cdRetry" style="margin-top:10px;padding:8px 14px;border-radius:10px;border:1px solid var(--line,#ddd);background:transparent;cursor:pointer;">Try again</button></div>';
      var rb = document.getElementById("cdRetry"); if (rb) rb.addEventListener("click", function () { loadAndRender(true); });
      return;
    }
    if (!state.athletes.length) {
      body.innerHTML = '<div style="padding:40px 16px;text-align:center;color:var(--ink3,#888);">' +
        '<div style="font-size:15px;margin-bottom:6px;">No athletes assigned yet</div>' +
        '<div style="font-size:13px;">Assigned athletes will appear here once an admin links them to you.</div></div>';
      return;
    }

    var q = state.search.trim();
    var visible = sortRoster(state.athletes).filter(function (a) {
      return !q || String(a.name || "").toLowerCase().indexOf(q) !== -1;
    });
    if (!visible.length) { body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--ink3,#888);">No athletes match “' + esc(q) + '”.</div>'; return; }

    body.innerHTML = visible.map(function (a) {
      var meta = STATUS_META[a.attention_status] || STATUS_META.no_recent_data;
      var sport = a.primary_sport ? (SPORT_LABEL[a.primary_sport] || "—") : "—";
      var load = a.seven_day_load != null ? a.seven_day_load : "—";
      var adher = a.adherence_pct != null ? a.adherence_pct + "%" : "—";
      var reasons = (a.attention_reason_keys || []).slice(0, 2).map(function (k) { return esc(k.replace(/_/g, " ")); }).join(", ");
      return '' +
        '<button class="cd-card" data-athlete="' + esc(a.athlete_id) + '" style="width:100%;text-align:left;border:1px solid var(--line,#eee);background:var(--card,#fff);border-radius:14px;padding:12px 14px;margin-bottom:10px;cursor:pointer;display:block;">' +
        '  <div style="display:flex;align-items:center;gap:12px;">' +
        '    <div aria-hidden="true" style="flex:0 0 auto;width:40px;height:40px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;">' + esc(a.initials || "A") + '</div>' +
        '    <div style="min-width:0;flex:1;">' +
        '      <div style="display:flex;align-items:center;gap:8px;">' +
        '        <span style="font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(a.name) + '</span>' +
        '        <span style="flex:0 0 auto;font-size:11px;font-weight:600;color:#fff;background:' + meta.color + ';border-radius:999px;padding:2px 8px;">' + esc(meta.label) + '</span>' +
        '      </div>' +
        '      <div style="font-size:12px;color:var(--ink3,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">' +
                esc(sport) + ' · ' + fmtVal(a.goal) + '</div>' +
        (reasons ? '      <div style="font-size:12px;color:' + meta.color + ';margin-top:3px;">' + reasons + '</div>' : '') +
        '    </div>' +
        '  </div>' +
        '  <div style="display:flex;gap:14px;margin-top:10px;font-size:12px;color:var(--ink2,#555);flex-wrap:wrap;">' +
        '    <span>Readiness: <b>' + fmtVal(a.readiness_status) + '</b></span>' +
        '    <span>Recovery: <b>' + fmtVal(a.recovery_status === "unknown" ? null : a.recovery_status) + '</b></span>' +
        '    <span>7d load: <b>' + esc(load) + '</b></span>' +
        '    <span>Adherence: <b>' + esc(adher) + '</b></span>' +
        '    <span>Active: <b>' + esc(fmtLastActive(a.last_active_at)) + '</b></span>' +
        '  </div>' +
        '</button>';
    }).join("");

    Array.prototype.forEach.call(body.querySelectorAll(".cd-card"), function (btn) {
      btn.addEventListener("click", function () { openAthlete(btn.getAttribute("data-athlete")); });
    });
  }

  async function openAthlete(athleteId) {
    var entry = state.athletes.find(function (a) { return a.athlete_id === athleteId; });
    if (analytics()) try {
      analytics().track("coach_roster_athlete_opened", { dashboard_surface: "coach_dashboard", athlete_sport: (entry && entry.primary_sport) || "unknown" });
    } catch (e) {}

    var drawer = document.getElementById("cdDrawer");
    drawer.hidden = false;
    drawer.innerHTML = '<div style="padding:24px;text-align:center;color:var(--ink3,#888);">Loading athlete…</div>';
    var res = await api("athlete", { query: { athlete_id: athleteId } });
    if (!res.ok || !res.body || !res.body.athlete) {
      drawer.innerHTML = '<div style="padding:24px;text-align:center;color:#c0392b;">' +
        (res.status === 403 ? "You are not assigned to this athlete." : "Could not load this athlete.") +
        '<br><button id="cdDrawerClose" style="margin-top:10px;padding:8px 14px;border-radius:10px;border:1px solid var(--line,#ddd);background:transparent;cursor:pointer;">Close</button></div>';
      var cb = document.getElementById("cdDrawerClose"); if (cb) cb.addEventListener("click", closeDrawer);
      return;
    }
    renderDrawer(res.body.athlete, entry);
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
      bits.push(label);
    } else {
      if (a.duration_min != null) bits.push(a.duration_min + " min");
      if (a.distance_km != null) bits.push(a.distance_km + " km");
    }
    return bits.join(" · ");
  }

  function renderDrawer(ath, rosterEntry) {
    var drawer = document.getElementById("cdDrawer");
    var reasons = (ath.attention_reasons || []).map(function (r) {
      return '<li style="margin-bottom:4px;">' + esc(r.explanation || r.key) + '</li>';
    }).join("");
    var acts = (ath.recent_activities || []).map(function (a) {
      return '<li style="margin-bottom:4px;">' + esc(activityLine(a)) + (a.indoor ? ' · indoor' : '') + '</li>';
    }).join("") || '<li style="color:var(--ink3,#888);">No recent data</li>';
    var wk = ath.week_planned_vs_completed || {};
    var pv = function (v, s) { return v == null ? "—" : esc(v) + (s || ""); };

    drawer.hidden = false;
    drawer.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:60;" id="cdOverlay"></div>' +
      '<div role="dialog" aria-label="Athlete overview" style="position:fixed;left:0;right:0;bottom:0;z-index:61;max-width:720px;margin:0 auto;background:var(--bg,#fff);border-radius:18px 18px 0 0;max-height:88vh;overflow:auto;padding:18px 16px 40px;">' +
      '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '    <div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
      '      <div aria-hidden="true" style="width:38px;height:38px;border-radius:50%;background:var(--tint,#eef);display:flex;align-items:center;justify-content:center;font-weight:600;">' + esc(ath.initials || "A") + '</div>' +
      '      <div style="min-width:0;"><div style="font-weight:700;font-size:16px;">' + esc(ath.name) + '</div>' +
      '      <div style="font-size:12px;color:var(--ink3,#888);">' + esc((SPORT_LABEL[ath.primary_sport] || "—")) + (ath.goal ? ' · ' + esc(ath.goal) : '') + '</div></div>' +
      '    </div>' +
      '    <button id="cdDrawerClose" aria-label="Close" style="border:0;background:transparent;font-size:22px;cursor:pointer;">×</button>' +
      '  </div>' +
      (reasons ? '<div style="margin-bottom:14px;"><div style="font-weight:600;font-size:13px;margin-bottom:6px;">Needs attention</div><ul style="margin:0;padding-left:18px;font-size:13px;">' + reasons + '</ul>' +
        '<button id="cdReview" style="margin-top:8px;padding:7px 12px;border-radius:10px;border:1px solid var(--line,#ddd);background:transparent;cursor:pointer;font-size:13px;">Mark reviewed</button></div>' : '') +
      '  <div style="font-size:13px;line-height:1.7;">' +
      '    <div><b>Event:</b> ' + pv(ath.target_event) + '</div>' +
      '    <div><b>Plan phase:</b> ' + pv(ath.plan_phase) + '</div>' +
      '    <div><b>Today:</b> ' + (ath.today_planned ? esc(ath.today_planned.title || "Planned session") : "—") + '</div>' +
      '    <div><b>This week:</b> ' + pv(wk.completed_minutes, " min") + ' completed of ' + pv(wk.planned_minutes, " min") + ' planned</div>' +
      '    <div><b>Readiness:</b> ' + pv(ath.readiness && ath.readiness.status) + (ath.readiness && ath.readiness.pain_present ? ' · pain reported' : '') + '</div>' +
      '    <div><b>Recovery:</b> ' + pv(ath.recovery_status === "unknown" ? null : ath.recovery_status) + '</div>' +
      '    <div><b>Last sync:</b> ' + esc(fmtLastActive(ath.last_sync_at)) + ' · <b>Last active:</b> ' + esc(fmtLastActive(ath.last_active_at)) + '</div>' +
      '  </div>' +
      '  <div style="margin-top:14px;"><div style="font-weight:600;font-size:13px;margin-bottom:6px;">Recent activities</div><ul style="margin:0;padding-left:18px;font-size:13px;">' + acts + '</ul></div>' +
      '</div>';

    document.getElementById("cdOverlay").addEventListener("click", closeDrawer);
    document.getElementById("cdDrawerClose").addEventListener("click", closeDrawer);
    var rv = document.getElementById("cdReview");
    if (rv) rv.addEventListener("click", function () { markReviewed(ath, rosterEntry); });
  }

  async function markReviewed(ath, rosterEntry) {
    var keys = (ath.attention_reasons || []).map(function (r) { return r.key; });
    var primary = keys[0] || "reviewed";
    var btn = document.getElementById("cdReview");
    if (btn) { btn.disabled = true; btn.textContent = "Reviewing…"; }
    // Review each active alert key (audit trail; does not clear the condition).
    for (var i = 0; i < keys.length; i++) {
      await api("review", { method: "POST", body: { athlete_id: ath.athlete_id, alert_key: keys[i] } });
    }
    if (analytics()) try {
      var sev = (ath.attention_reasons && ath.attention_reasons[0] && ath.attention_reasons[0].severity) || "none";
      analytics().track("coach_attention_item_reviewed", {
        attention_reason: primary, attention_severity: sev,
        athlete_sport: (rosterEntry && rosterEntry.primary_sport) || "unknown"
      });
    } catch (e) {}
    if (btn) btn.textContent = "Reviewed";
  }

  function closeDrawer() {
    var d = document.getElementById("cdDrawer");
    if (d) { d.hidden = true; d.innerHTML = ""; }
  }

  /* ─────────────────────── load + routing ───────────────────── */

  async function loadAndRender(force) {
    state.loading = true; state.error = null; renderRoster();
    var res = await api("roster");
    state.loading = false;
    if (res.status === 401) { state.error = "Your coach session has expired. Please sign in again."; renderRoster(); return; }
    if (res.status === 403) { state.error = "Coach access is required."; renderRoster(); return; }
    if (!res.ok) { state.error = "The dashboard could not load. Please try again."; renderRoster(); return; }
    state.athletes = (res.body && res.body.athletes) || [];
    state.role = (res.body && res.body.role) || state.role;
    renderRoster();
    if (analytics()) try {
      var band = state.athletes.length === 0 ? "0" : state.athletes.length <= 5 ? "1-5" : state.athletes.length <= 15 ? "6-15" : state.athletes.length <= 40 ? "16-40" : "40+";
      analytics().track("coach_dashboard_viewed", { dashboard_surface: "coach_dashboard", roster_size_band: band });
    } catch (e) {}
  }

  function openDashboard() {
    if (!state.enabled) { safeRedirect(); return; }
    // The Coach Workspace owns the current command-center experience. Reuse it
    // instead of mounting the legacy roster-only screen as a second dashboard.
    if (window.AthlevoCoachMode && window.AthlevoCoachMode.isCoachMode &&
        window.AthlevoCoachMode.isCoachMode() && window.AthlevoCoachMode.switchToCoachWorkspace) {
      window.AthlevoCoachMode.switchToCoachWorkspace();
      if (location.hash !== "#coach") location.hash = "#coach";
      return;
    }
    ensureRoot();
    if (typeof window.showScreen === "function") window.showScreen(ROOT_ID);
    else { document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); }); document.getElementById(ROOT_ID).classList.add("active"); }
    if (location.hash !== "#coach") location.hash = "#coach";
    loadAndRender(true);
  }

  function closeDashboard() {
    closeDrawer();
    if (location.hash === "#coach") { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { location.hash = ""; } }
    if (typeof window.showScreen === "function") window.showScreen("screen-today");
  }

  function safeRedirect() {
    // Unauthorized users are never shown coach data.
    if (location.hash === "#coach") { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }
    if (typeof window.showScreen === "function") window.showScreen("screen-today");
  }

  function injectEntry() {
    // Add a Coach entry into the You screen — coach/admin only. Idempotent.
    if (document.getElementById("cdEntryBtn")) return;
    var host = document.getElementById("screen-you") || document.getElementById("screen-profile");
    if (!host) return;
    var btn = document.createElement("button");
    btn.id = "cdEntryBtn";
    btn.textContent = "Open coach dashboard";
    btn.style.cssText = "display:block;width:100%;margin:12px 0;padding:12px;border-radius:12px;border:1px solid var(--line,#ddd);background:var(--card,#fff);font-size:14px;font-weight:600;cursor:pointer;";
    btn.addEventListener("click", openDashboard);
    host.insertBefore(btn, host.firstChild);
  }

  async function init() {
    var role = await myRole();
    state.role = role;
    state.enabled = role === "coach" || role === "admin";
    if (!state.enabled) return; // Athletes: nothing is injected, no entry, no route.
    injectEntry();
    window.addEventListener("hashchange", function () {
      if (location.hash === "#coach") openDashboard();
    });
    if (location.hash === "#coach") openDashboard();
  }

  window.AthlevoCoachDashboard = {
    init: init,
    open: openDashboard,
    close: closeDashboard,
    _loadAndRender: loadAndRender,
    _sortRoster: sortRoster,
    _state: state,
    COACH_DASHBOARD_CLIENT_VERSION: "coach-dashboard-client-v1"
  };
})();
