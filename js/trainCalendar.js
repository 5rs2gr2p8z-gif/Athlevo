/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Date-First Training Calendar  (Train primary experience)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Replaces the vertical Train dashboard. The FIRST interaction is choosing a
 *  date: a swipeable Mon–Sun week strip drives ONE selected-date workout
 *  panel. Reads the plan / executions / activities (RLS, read-only) per week —
 *  it does NOT touch classification, Trends, the Athlevo Score, or any
 *  training algorithm. Reuses train.js render helpers for consistency.
 *
 *  Exposed as window.AthlevoTrainCalendar.
 */
(function () {
  "use strict";

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  let weekStart = null;      // Date at Monday 00:00 local of the shown week
  let selected = null;       // "YYYY-MM-DD"
  let byDate = {};           // date → { session, execution, activity }
  let hasAnyPlan = false;

  /* ── date helpers (local) ─────────────────────────────────────────── */
  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function mondayOf(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const wd = (x.getDay() + 6) % 7; // 0 = Monday
    x.setDate(x.getDate() - wd);
    return x;
  }
  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function todayISO() { return iso(new Date()); }

  /* ── data (read-only, RLS) ────────────────────────────────────────── */
  async function loadWeek(monday) {
    byDate = {};
    const start = iso(monday), end = iso(addDays(monday, 6));
    let user = null;
    try { user = (await supabaseClient.auth.getUser()).data.user; } catch (e) {}
    if (!user) return;

    const q = (table, sel, extra) =>
      supabaseClient.from(table).select(sel).eq("user_id", user.id);

    const [sessRes, execRes, actRes] = await Promise.all([
      q("training_sessions", "*").gte("session_date", start).lte("session_date", end),
      q("workout_execution_records", "status,completed_at,updated_at,actual_duration_minutes,actual_distance_km,actual_average_pace,actual_average_hr,actual_rpe,overall_feeling,skip_reason,training_session_id,imported_activity_id"),
      q("activities", "id,name,sport_type,start_date,distance_meters,moving_time_seconds")
        .gte("start_date", start + "T00:00:00").lte("start_date", end + "T23:59:59.999")
    ].map(p => p.then(r => r).catch(() => ({ data: [] }))));

    const sessions = (sessRes && sessRes.data) || [];
    const execs = (execRes && execRes.data) || [];
    const acts = (actRes && actRes.data) || [];
    if (sessions.length) hasAnyPlan = true;

    const execBySession = {};
    execs.forEach(e => { if (e.training_session_id != null) execBySession[String(e.training_session_id)] = e; });

    sessions.forEach(s => {
      const d = String(s.session_date).slice(0, 10);
      byDate[d] = byDate[d] || {};
      byDate[d].session = s;
      byDate[d].execution = s.id != null ? execBySession[String(s.id)] || null : null;
    });
    acts.forEach(a => {
      const d = String(a.start_date).slice(0, 10);
      byDate[d] = byDate[d] || {};
      if (!byDate[d].activity) byDate[d].activity = a;
    });
  }

  /* ── status per day ───────────────────────────────────────────────── */
  function statusOf(entry) {
    if (!entry) return null;
    const s = entry.session, ex = entry.execution;
    const rest = s && typeof isRestSession === "function" && isRestSession(s);
    if (rest) return "rest";
    if (ex) {
      if (ex.status === "completed") return "done";
      if (ex.status === "modified") return "mod";
      if (ex.status === "skipped") return "skip";
    }
    if (s) return "planned";
    if (entry.activity) return "activity";
    return null;
  }

  /* ── calendar render ──────────────────────────────────────────────── */
  function render() {
    const cal = document.getElementById("trainCalendar");
    if (!cal) return;
    const mid = addDays(weekStart, 3); // week's midpoint drives the month label
    let html = `
      <div class="tc-head">
        <span class="tc-month">${MONTHS[mid.getMonth()]} ${mid.getFullYear()}</span>
        <div class="tc-nav">
          <button class="tc-today" type="button" onclick="AthlevoTrainCalendar.goToday()">Today</button>
          <button class="tc-btn" type="button" aria-label="Previous week" onclick="AthlevoTrainCalendar.prevWeek()">‹</button>
          <button class="tc-btn" type="button" aria-label="Next week" onclick="AthlevoTrainCalendar.nextWeek()">›</button>
        </div>
      </div>
      <div class="tc-week" id="tcWeek">`;
    const tISO = todayISO();
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const dISO = iso(d);
      const st = statusOf(byDate[dISO]);
      const cls = ["tc-day"];
      if (dISO === selected) cls.push("sel");
      if (dISO === tISO) cls.push("today");
      html += `
        <button class="${cls.join(" ")}" type="button" onclick="AthlevoTrainCalendar.select('${dISO}')">
          <span class="tc-dow">${DOW[i]}</span>
          <span class="tc-num">${d.getDate()}</span>
          <span class="tc-dot ${st || ""}"></span>
        </button>`;
    }
    html += `</div>`;
    cal.innerHTML = html;
    attachSwipe(cal);
    renderPanel();
  }

  /* ── selected-date panel ──────────────────────────────────────────── */
  function fmtDateLong(dISO) {
    const [y, m, d] = dISO.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return `${DOW[(dt.getDay() + 6) % 7]} · ${MONTHS[m - 1].slice(0, 3)} ${d}`;
  }
  const STATUS_LABEL = { done: "Completed", mod: "Modified", skip: "Skipped", planned: "Planned", rest: "Rest day", activity: "Unplanned activity" };

  function section(label, inner) { return `<div class="tcp-sec"><div class="tcp-sec-label">${esc(label)}</div>${inner}</div>`; }
  function listOr(label, arr) {
    const items = (Array.isArray(arr) ? arr : []).map(x => (x == null ? "" : String(x))).filter(Boolean);
    if (!items.length) return "";
    return section(label, `<ul>${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>`);
  }

  function renderPanel() {
    const el = document.getElementById("trainDayPanel");
    if (!el) return;
    const entry = byDate[selected] || null;
    const st = statusOf(entry);

    // Empty day.
    if (!entry || (!entry.session && !entry.activity)) {
      el.innerHTML = `
        <div class="tcp-card tcp-empty">
          <div class="tcp-empty-icon"><img src="assets/athlevo-icon.png" alt="" width="30" height="30"></div>
          <h3>No planned workout</h3>
          <p>${hasAnyPlan ? "Nothing scheduled for " + esc(fmtDateLong(selected)) + "." : "You don't have a training plan yet."}</p>
          ${hasAnyPlan ? "" : `<button class="tcp-cta" type="button" onclick="(window.AthlevoPlan?AthlevoPlan.start():null)">Build My Plan</button>`}
        </div>`;
      return;
    }

    // Unplanned imported activity (no planned session that day).
    if (!entry.session && entry.activity) {
      const a = entry.activity;
      const km = a.distance_meters ? (a.distance_meters / 1000).toFixed(1) + " km" : null;
      const min = a.moving_time_seconds ? Math.round(a.moving_time_seconds / 60) + " min" : null;
      el.innerHTML = `
        <div class="tcp-card">
          <span class="tcp-date">${esc(fmtDateLong(selected))}</span>
          <span class="tcp-status activity">Unplanned activity</span>
          <h2 class="tcp-title">${esc(a.name || "Imported run")}</h2>
          <div class="tcp-meta">${[km ? `<b>${km}</b>` : "", min ? `<b>${min}</b>` : ""].filter(Boolean).join('<span style="color:var(--ink3)">·</span>')}</div>
        </div>`;
      return;
    }

    // Planned session (with optional execution). Repair label↔detail first.
    let s = entry.session;
    if (window.AthlevoPrescription && typeof window.AthlevoPrescription.repair === "function") s = window.AthlevoPrescription.repair(s);
    const rest = typeof isRestSession === "function" && isRestSession(s);
    const title = rest ? "Rest day"
      : (typeof formatSessionType === "function" ? formatSessionType(s.session_type) : (s.title || "Workout"));

    const meta = [];
    if (Number(s.duration_minutes) > 0) meta.push(`<b>${Math.round(s.duration_minutes)}</b> min`);
    if (Number(s.distance_km) > 0) meta.push(`<b>${s.distance_km}</b> km`);
    if (s.pace_guidance) meta.push(`Pace <b>${esc(s.pace_guidance)}</b>`);
    if (s.target_rpe) meta.push(`RPE <b>${esc(s.target_rpe)}</b>`);

    let structure = "";
    if (!rest) {
      structure +=
        (s.purpose ? section("Purpose", `<p>${esc(s.purpose)}</p>`) : "") +
        listOr("Warm-up", s.warmup) +
        listOr("Main set", s.main_set) +
        listOr("Cooldown", s.cooldown);
    }

    let execBlock = "";
    const ex = entry.execution;
    if (ex && ex.status !== "skipped") {
      const parts = [];
      if (ex.actual_distance_km) parts.push(`${ex.actual_distance_km} km`);
      if (ex.actual_duration_minutes) parts.push(`${Math.round(ex.actual_duration_minutes)} min`);
      if (ex.actual_average_pace) parts.push(`${ex.actual_average_pace}/km`);
      if (ex.actual_average_hr) parts.push(`${ex.actual_average_hr} bpm`);
      if (ex.actual_rpe) parts.push(`RPE ${ex.actual_rpe}`);
      execBlock = `<div class="tcp-exec"><div class="tcp-sec-label">Imported execution</div><p>${esc(parts.join("  ·  ") || "Recorded")}</p></div>`;
    } else if (ex && ex.status === "skipped") {
      execBlock = `<div class="tcp-exec" style="background:var(--red-soft)"><div class="tcp-sec-label" style="color:var(--red)">Skipped</div><p>${esc(ex.skip_reason || "Session skipped")}</p></div>`;
    }

    el.innerHTML = `
      <div class="tcp-card">
        <span class="tcp-date">${esc(fmtDateLong(selected))}</span>
        <span class="tcp-status ${st || "planned"}">${esc(STATUS_LABEL[st] || "Planned")}</span>
        <h2 class="tcp-title">${esc(title)}</h2>
        ${meta.length ? `<div class="tcp-meta">${meta.join('<span style="color:var(--ink3)">·</span>')}</div>` : ""}
        ${structure}
        ${execBlock}
      </div>`;
  }

  /* ── navigation ───────────────────────────────────────────────────── */
  async function goToWeek(monday, keepSelectionDow) {
    weekStart = monday;
    // keep the same weekday selected when paging; else default to Monday
    if (keepSelectionDow != null) selected = iso(addDays(monday, keepSelectionDow));
    render();                 // instant paint (dots fill after load)
    await loadWeek(monday);
    render();
  }
  function selectedDow() { const [y, m, d] = selected.split("-").map(Number); return ( (new Date(y, m - 1, d).getDay() + 6) % 7 ); }

  async function prevWeek() { await goToWeek(addDays(weekStart, -7), selectedDow()); }
  async function nextWeek() { await goToWeek(addDays(weekStart, 7), selectedDow()); }
  async function goToday() { selected = todayISO(); await goToWeek(mondayOf(new Date()), null); selected = todayISO(); render(); }
  function select(dISO) { selected = dISO; render(); }

  /* ── swipe (whole week changes, not card scroll) ──────────────────── */
  function attachSwipe(elem) {
    if (elem._tcSwipe) return;
    elem._tcSwipe = true;
    let x0 = null, y0 = null;
    elem.addEventListener("touchstart", e => { const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    elem.addEventListener("touchend", e => {
      if (x0 == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { dx < 0 ? nextWeek() : prevWeek(); }
      x0 = y0 = null;
    }, { passive: true });
  }

  /* ── public open (called by loadWeeklyPlan) ───────────────────────── */
  async function open(planData) {
    hasAnyPlan = !!(planData && planData.hasPlan);
    selected = todayISO();
    weekStart = mondayOf(new Date());
    render();
    await loadWeek(weekStart);
    render();
  }

  window.AthlevoTrainCalendar = { open, prevWeek, nextWeek, goToday, select, VERSION: "train-calendar-v1" };
})();
