/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Date-First Training Calendar  (Train primary experience)
 *  v3 — Clean activity-feed + rich activity-detail redesign
 * ══════════════════════════════════════════════════════════════════════
 *
 *  PART 1: Compact calendar strip → chronological activity feed for the
 *  entire week, grouped by day. Each activity is a single compact row
 *  with key metrics. Tapping opens the rich detail view.
 *
 *  PART 2: Full-height detail sheet with: summary → workout structure →
 *  HR zones → chart sections → splits/laps → coach analysis.
 *
 *  Reads plan / executions / activities per week (RLS, read-only).
 *  Does NOT touch workout classification, plan generation, Trends,
 *  or the Athlevo Score. Exposed as window.AthlevoTrainCalendar.
 */
(function () {
  "use strict";

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DOW_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const QUALITY_RE = /threshold|tempo|interval|vo2|repetition|\brep\b|reps|speed|hill|race|time.?trial|fartlek|cruise/i;

  let weekStart = null;    // Monday 00:00 local of the shown week
  let selected = null;     // "YYYY-MM-DD"
  let byDate = {};         // date → { session, execution, activities:[] }
  let actById = {};        // activity id → activity (for modal lookup)
  let hasAnyPlan = false;
  let weekMotion = null;
  let weekMotionToken = 0;

  /* ── date helpers (local) ─────────────────────────────────────────── */
  const pad = n => String(n).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  const esc = v => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const todayISO = () => iso(new Date());
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const isRest = s => s && typeof isRestSession === "function" && isRestSession(s);
  const isRun = a => /run/i.test(a && (a.sport_type || a.activity_type || a.name) || "");
  const isLong = s => s && (/long/i.test(String(s.session_type || "")) || Number(s.duration_minutes) >= 90);
  const isQuality = s => s && QUALITY_RE.test(String(s.session_type || ""));

  /* ── sport helpers ────────────────────────────────────────────────── */
  const CANON_SPORT_LABEL = {
    run: "Running", ride: "Cycling", strength: "Strength Training", swim: "Swimming",
    walk: "Walking", hike: "Hiking", mobility: "Mobility",
    cross_training: "Cross Training", rest: "Rest", other: "Activity"
  };
  const CANON_SPORT_SHORT = {
    run: "Run", ride: "Ride", strength: "Strength", swim: "Swim",
    walk: "Walk", hike: "Hike", mobility: "Mobility",
    cross_training: "Cross-train", rest: "Rest", other: "Activity"
  };
  const SPORT_ICON = {
    run: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M7 21l3-7 2.5 2 4.5-5"/><path d="M17 14l1 7"/><path d="M7 11l2-2 3 3"/></svg>`,
    ride: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17L9 4h4l3 5h3"/><path d="M9 9l3 8"/></svg>`,
    strength: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5v14M18 5v14M3 8h3M18 8h3M3 16h3M18 16h3M6 8h12M6 16h12"/></svg>`,
    swim: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18c1.333-1 2.667-1 4 0s2.667 1 4 0 2.667-1 4 0 2.667 1 4 0"/><path d="M2 14c1.333-1 2.667-1 4 0s2.667 1 4 0 2.667-1 4 0 2.667 1 4 0"/><circle cx="10" cy="6" r="2"/><path d="M16 11l-4-2-4 2"/></svg>`,
    walk: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M10 21l1-7 2 1 3-4"/><path d="M16 14l1 7"/><path d="M10 11l1-3 3 2"/></svg>`,
    hike: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l5-8 4 4 5-9 4 8"/><circle cx="13" cy="4" r="2"/></svg>`,
    mobility: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M8 21l2-6M16 21l-2-6M9 11c0-2 1.5-3 3-3s3 1 3 3-1.5 4-3 6c-1.5-2-3-4-3-6z"/></svg>`
  };
  const canonSport = a => {
    const SC = window.SportClassification;
    if (SC) return SC.canonicalSportOf(a);
    const s = String(a.sport_type || a.activity_type || "").toLowerCase();
    if (/ride|bike|cycl/.test(s)) return "ride";
    if (/swim/.test(s)) return "swim";
    if (/weight|gym|strength/.test(s)) return "strength";
    if (/walk/.test(s)) return "walk";
    if (/hike/.test(s)) return "hike";
    return "run";
  };
  const sportLabel = a => CANON_SPORT_LABEL[canonSport(a)] || "Activity";
  const sportShort = a => CANON_SPORT_SHORT[canonSport(a)] || "Activity";
  const sportIcon = a => SPORT_ICON[canonSport(a)] || SPORT_ICON.run;

  /* ── data (read-only, RLS) ────────────────────────────────────────── */
  async function loadWeek(monday) {
    byDate = {}; actById = {};
    const start = iso(monday), end = iso(addDays(monday, 6));
    let user = null;
    try { user = (await supabaseClient.auth.getUser()).data.user; } catch (e) {}
    if (!user) return;
    const base = table => supabaseClient.from(table).select("*").eq("user_id", user.id);

    const [sessRes, actRes] = await Promise.all([
      base("training_sessions").gte("session_date", start).lte("session_date", end),
      base("activities").gte("start_date", start + "T00:00:00").lte("start_date", end + "T23:59:59.999")
    ].map(p => p.then(r => r).catch(() => ({ data: [] }))));

    const sessions = (sessRes && sessRes.data) || [];
    const acts = (actRes && actRes.data) || [];
    if (sessions.length) hasAnyPlan = true;

    let execs = [];
    const sessionIds = sessions.map(s => s.id).filter(id => id != null);
    if (sessionIds.length) {
      try {
        const r = await base("workout_execution_records").in("training_session_id", sessionIds);
        execs = (r && r.data) || [];
      } catch (e) { execs = []; }
    }

    const execBySession = {};
    execs.forEach(e => { if (e.training_session_id != null) execBySession[String(e.training_session_id)] = e; });

    sessions.forEach(s => {
      const d = String(s.session_date).slice(0, 10);
      byDate[d] = byDate[d] || { activities: [] };
      byDate[d].session = s;
      byDate[d].execution = s.id != null ? (execBySession[String(s.id)] || null) : null;
    });
    acts.forEach(a => {
      const d = String(a.start_date).slice(0, 10);
      byDate[d] = byDate[d] || { activities: [] };
      byDate[d].activities.push(a);
      if (a.id != null) actById[String(a.id)] = a;
    });
  }

  function statusOf(entry) {
    if (!entry) return null;
    const s = entry.session, ex = entry.execution;
    if (isRest(s)) return "rest";
    if (ex) { if (ex.status === "completed") return "done"; if (ex.status === "modified") return "mod"; if (ex.status === "skipped") return "skip"; }
    if (s) return "planned";
    if (entry.activities && entry.activities.length) return "activity";
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════
   *  PART 1 — CLEAN TRAIN SCREEN
   * ══════════════════════════════════════════════════════════════════ */

  /* ── compact calendar strip ──────────────────────────────────────── */
  function render() {
    const cal = document.getElementById("trainCalendar");
    if (!cal) return;
    const mid = addDays(weekStart, 3);
    let html = `
      <div class="tc-head">
        <span class="tc-month">${MONTHS[mid.getMonth()]} ${mid.getFullYear()}</span>
        <div class="tc-nav">
          <button class="tc-today" type="button" onclick="AthlevoTrainCalendar.goToday()">Today</button>
          <button class="tc-btn" type="button" aria-label="Previous week" onclick="AthlevoTrainCalendar.prevWeek()">‹</button>
          <button class="tc-btn" type="button" aria-label="Next week" onclick="AthlevoTrainCalendar.nextWeek()">›</button>
        </div>
      </div>
      <div class="tc-week">`;
    const tISO = todayISO();
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i), dISO = iso(d), st = statusOf(byDate[dISO]);
      const cls = ["tc-day"]; if (dISO === selected) cls.push("sel"); if (dISO === tISO) cls.push("today");
      html += `<button class="${cls.join(" ")}" type="button" onclick="AthlevoTrainCalendar.select('${dISO}')">
        <span class="tc-dow">${DOW[i]}</span><span class="tc-num">${d.getDate()}</span><span class="tc-dot ${st || ""}"></span></button>`;
    }
    cal.innerHTML = html + `</div>`;
    attachSwipe(cal);
    renderActivityFeed();
    renderWeekProgress();
    renderContext();
  }

  /* ── format helpers ──────────────────────────────────────────────── */
  function fmtDayHeader(dISO) {
    const [y, m, d] = dISO.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const dow = DOW_FULL[(dt.getDay() + 6) % 7];
    return `${dow}, ${MONTHS_SHORT[m - 1]} ${d}`;
  }
  function fmtPace(s) { s = Math.round(s); return `${Math.floor(s / 60)}:${pad(s % 60)}`; }
  function fmtDuration(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }

  /* ── compute load from activity ──────────────────────────────────── */
  function activityLoad(a) {
    // Check raw_data for training load / TRIMP
    const raw = a && a.raw_data && typeof a.raw_data === "object" ? a.raw_data : {};
    if (num(raw.training_load) > 0) return Math.round(raw.training_load);
    if (num(raw.trimp) > 0) return Math.round(raw.trimp);
    // Simple TRIMP estimate from HR and duration
    if (a.average_heartrate && a.moving_time_seconds) {
      const hr = a.average_heartrate;
      const min = a.moving_time_seconds / 60;
      // Simplified TRIMP: duration * HR-intensity factor
      const intensity = Math.max(0, (hr - 60) / 120);
      return Math.round(min * intensity);
    }
    return null;
  }

  /* ── activity metrics line ───────────────────────────────────────── */
  function activityMetrics(a) {
    const sport = canonSport(a);
    const parts = [];
    // Duration
    if (a.moving_time_seconds) parts.push(fmtDuration(a.moving_time_seconds));
    // Distance
    if (a.distance_meters && sport !== "strength" && sport !== "mobility") {
      parts.push((a.distance_meters / 1000).toFixed(1) + " km");
    }
    // Pace (runs only)
    if (sport === "run" && a.distance_meters && a.moving_time_seconds) {
      const paceSec = a.moving_time_seconds / (a.distance_meters / 1000);
      parts.push(fmtPace(paceSec) + "/km");
    }
    // Speed (rides)
    if (sport === "ride" && a.distance_meters && a.moving_time_seconds) {
      parts.push(((a.distance_meters / a.moving_time_seconds) * 3.6).toFixed(1) + " km/h");
    }
    // Load
    const load = activityLoad(a);
    if (load) parts.push("Load " + load);

    return parts.join(" · ");
  }

  /* ── compact effort visualization (inline in feed card) ──────────── */
  function miniEffortBar(a) {
    const recognition = (window.AthlevoCoach && AthlevoCoach.getStoredRecognition)
      ? AthlevoCoach.getStoredRecognition(a) : null;
    if (!recognition || !recognition.segments) return "";
    const segs = recognition.segments.filter(s => s && s.duration > 0);
    if (segs.length <= 1) return "";

    const total = segs.reduce((sum, s) => sum + s.duration, 0);
    if (total <= 0) return "";

    const bars = segs.map(s => {
      const pct = Math.max(2, (s.duration / total) * 100);
      let tone = "var(--af-effort-easy)";
      if (s.kind === "warmup") tone = "var(--af-effort-warm)";
      else if (s.kind === "work") tone = "var(--af-effort-work)";
      else if (s.kind === "recovery") tone = "var(--af-effort-recovery)";
      else if (s.kind === "cooldown") tone = "var(--af-effort-cool)";
      return `<span style="flex:${pct};background:${tone}"></span>`;
    }).join("");

    return `<div class="af-effort-bar">${bars}</div>`;
  }

  /* ── activity feed (whole week, grouped by day) ─────────────────── */
  function renderActivityFeed() {
    const el = document.getElementById("trainDayPanel");
    if (!el) return;
    const tISO = todayISO();
    let html = "";
    let hasContent = false;

    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i), dISO = iso(d);
      const entry = byDate[dISO] || null;
      const acts = (entry && entry.activities) || [];
      const session = entry && entry.session ? entry.session : null;
      const ex = entry && entry.execution ? entry.execution : null;
      const st = statusOf(entry);
      const isToday = dISO === tISO;
      const isSelected = dISO === selected;

      // Day has content
      if (session || acts.length) {
        hasContent = true;
        const dayLabel = isToday ? "Today" : fmtDayHeader(dISO);
        html += `<div class="af-day${isSelected ? " af-day--sel" : ""}">`;
        html += `<div class="af-day-head"><span class="af-day-label${isToday ? " af-today" : ""}">${esc(dayLabel)}</span>`;
        if (isToday) html += `<span class="af-day-date">${esc(fmtDayHeader(dISO))}</span>`;
        html += `</div>`;

        // Rest day
        if (session && isRest(session)) {
          html += `<div class="af-card af-card--rest" onclick="AthlevoTrainCalendar.select('${dISO}')">
            <div class="af-card-body">
              <span class="af-card-name">Rest Day</span>
              <span class="af-card-meta">Recovery is part of the plan</span>
            </div>
            ${st === "done" ? '<span class="af-card-status af-card-status--done">✓</span>' : ""}
          </div>`;
          html += `</div>`;
          continue;
        }

        // Planned session (not yet executed, no matching activity)
        if (session && !ex && !acts.length) {
          const sType = typeof formatSessionType === "function" ? formatSessionType(session.session_type) : (session.session_type || "Workout");
          const meta = [];
          if (num(session.duration_minutes) > 0) meta.push(Math.round(session.duration_minutes) + "m");
          if (num(session.distance_km) > 0) meta.push(session.distance_km + " km");
          if (session.pace_guidance) meta.push(session.pace_guidance);
          html += `<div class="af-card af-card--planned" onclick="AthlevoTrainCalendar.openModal('${dISO}')">
            ${SPORT_ICON.run}
            <div class="af-card-body">
              <span class="af-card-name">${esc(sType)}</span>
              ${meta.length ? `<span class="af-card-meta">${esc(meta.join(" · "))}</span>` : ""}
              ${session.purpose ? `<span class="af-card-purpose">${esc(session.purpose.split(/[.!?]/)[0])}</span>` : ""}
            </div>
            <span class="af-card-cta">View</span>
          </div>`;
        }

        // Activities (detected/imported workouts)
        acts.forEach(a => {
          const sport = canonSport(a);
          const name = sportLabel(a);
          const source = a.name && a.name !== name ? a.name : null;
          const device = (a.raw_data && a.raw_data.device_name) || null;
          const metrics = activityMetrics(a);
          const effort = miniEffortBar(a);
          const statusCls = ex && (ex.status === "completed" || ex.status === "modified") ? " af-card--done" : "";

          html += `<div class="af-card${statusCls}" onclick="AthlevoTrainCalendar.openModal('${dISO}','${a.id}')">
            ${sportIcon(a)}
            <div class="af-card-body">
              <span class="af-card-name">${esc(name)}</span>
              ${source ? `<span class="af-card-source">${esc(source)}</span>` : ""}
              ${metrics ? `<span class="af-card-metrics">${esc(metrics)}</span>` : ""}
              ${effort}
            </div>
            <span class="af-card-cta">Review</span>
          </div>`;
        });

        // Planned session WITH activity (show both context)
        if (session && !isRest(session) && acts.length && !ex) {
          const sType = typeof formatSessionType === "function" ? formatSessionType(session.session_type) : (session.session_type || "Workout");
          html += `<div class="af-plan-note" onclick="AthlevoTrainCalendar.openModal('${dISO}')">
            Planned: ${esc(sType)} · <span>View plan</span>
          </div>`;
        }

        html += `</div>`;
      }
    }

    // Empty state
    if (!hasContent) {
      html = `<div class="af-empty">
        <div class="af-empty-icon"><img src="assets/athlevo-icon.png" alt="" width="28" height="28"></div>
        <p>${hasAnyPlan ? "No activities this week." : "No training plan yet."}</p>
        ${hasAnyPlan ? "" : `<button class="af-empty-cta" type="button" onclick="(window.AthlevoPlan?AthlevoPlan.start():null)">Build My Plan</button>`}
      </div>`;
    }

    el.innerHTML = html;
  }

  /* ── weekly progress (compact, near header) ─────────────────────── */
  function weekSummary() {
    let plannedKm = 0, completedKm = 0, plannedSessions = 0, completedSessions = 0,
      plannedQ = 0, completedQ = 0, plannedLong = false, completedLong = false, anyPlan = false, hasPlannedKm = false;
    const consumed = new Set();
    for (let i = 0; i < 7; i++) {
      const e = byDate[iso(addDays(weekStart, i))]; if (!e) continue;
      const s = e.session, ex = e.execution;
      if (s && !isRest(s)) {
        anyPlan = true; plannedSessions++;
        if (num(s.distance_km) > 0) { plannedKm += num(s.distance_km); hasPlannedKm = true; }
        if (isQuality(s)) plannedQ++;
        if (isLong(s)) plannedLong = true;
        if (ex && (ex.status === "completed" || ex.status === "modified")) {
          completedSessions++;
          if (num(ex.actual_distance_km) > 0) completedKm += num(ex.actual_distance_km);
          if (isQuality(s)) completedQ++;
          if (isLong(s)) completedLong = true;
          if (ex.imported_activity_id != null) consumed.add(String(ex.imported_activity_id));
        }
      }
    }
    for (let i = 0; i < 7; i++) {
      const e = byDate[iso(addDays(weekStart, i))]; if (!e || !e.activities) continue;
      const dayHadCompleted = e.execution && (e.execution.status === "completed" || e.execution.status === "modified");
      e.activities.forEach(a => {
        if (!isRun(a)) return;
        if (a.id != null && consumed.has(String(a.id))) return;
        if (dayHadCompleted) return;
        if (num(a.distance_meters) > 0) completedKm += num(a.distance_meters) / 1000;
      });
    }
    return {
      anyPlan, hasPlannedKm,
      plannedKm: Math.round(plannedKm * 10) / 10, completedKm: Math.round(completedKm * 10) / 10,
      plannedSessions, completedSessions, plannedQ, completedQ, plannedLong, completedLong
    };
  }

  function renderWeekProgress() {
    const el = document.getElementById("trainWeekProgress");
    if (!el) return;
    const w = weekSummary();
    if (!w.anyPlan && w.completedKm === 0) { el.innerHTML = ""; return; }

    const pct = w.hasPlannedKm && w.plannedKm > 0 ? Math.round((w.completedKm / w.plannedKm) * 100) : null;

    el.innerHTML = `
      <div class="twp">
        <div class="twp-row">
          <div class="twp-stat">
            <span class="twp-val">${w.completedKm}${w.hasPlannedKm ? `<small>/${w.plannedKm}</small>` : ""}</span>
            <span class="twp-unit">km</span>
          </div>
          <div class="twp-stat">
            <span class="twp-val">${w.completedSessions}${w.anyPlan ? `<small>/${w.plannedSessions}</small>` : ""}</span>
            <span class="twp-unit">sessions</span>
          </div>
          ${w.plannedQ > 0 ? `<div class="twp-stat">
            <span class="twp-val">${w.completedQ}<small>/${w.plannedQ}</small></span>
            <span class="twp-unit">quality</span>
          </div>` : ""}
          ${w.plannedLong ? `<div class="twp-stat">
            <span class="twp-val">${w.completedLong ? "✓" : "—"}</span>
            <span class="twp-unit">long run</span>
          </div>` : ""}
        </div>
        ${w.hasPlannedKm ? `<div class="twp-bar"><i style="width:${Math.min(100, pct || 0)}%"></i></div>` : ""}
      </div>`;
  }

  /* ── training context (compact) ──────────────────────────────────── */
  function renderContext() {
    const el = document.getElementById("trainContext");
    if (!el) return;
    let s = null;
    for (let i = 0; i < 7; i++) { const e = byDate[iso(addDays(weekStart, i))]; if (e && e.session) { s = e.session; break; } }
    if (!s || !(s.phase || s.week_focus || s.weeks_until_race != null)) {
      el.innerHTML = "";
      return;
    }
    const phase = s.phase ? String(s.phase).replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : null;
    const wtr = num(s.weeks_until_race);
    const race = wtr != null && wtr > 0 ? `${wtr}w to race` : (wtr === 0 ? "Race week" : null);
    const focus = s.week_focus || null;

    const parts = [phase, race].filter(Boolean);
    if (!parts.length && !focus) { el.innerHTML = ""; return; }

    el.innerHTML = `<div class="tcx">${parts.length ? `<span class="tcx-inline">${parts.map(p => esc(p)).join(" · ")}</span>` : ""}${focus ? `<span class="tcx-focus">${esc(focus)}</span>` : ""}</div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
   *  PART 2 — RICH ACTIVITY DETAIL
   * ══════════════════════════════════════════════════════════════════ */

  function openModal(dISO, activityId) {
    const entry = byDate[dISO] || {};
    let s = entry.session ? entry.session : null;
    if (s && window.AthlevoPrescription && typeof window.AthlevoPrescription.repair === "function") s = window.AthlevoPrescription.repair(s);
    let act = null;
    if (activityId && actById[String(activityId)]) act = actById[String(activityId)];
    else if (entry.execution && entry.execution.imported_activity_id && actById[String(entry.execution.imported_activity_id)]) act = actById[String(entry.execution.imported_activity_id)];
    else if (entry.activities && entry.activities.length === 1) act = entry.activities[0];
    const ex = entry.execution || null;

    let html = "";

    /* ── TOP: Activity header ──────────────────────────────────────── */
    if (act) {
      const sport = canonSport(act);
      const name = sportLabel(act);
      const source = act.name && act.name !== name ? act.name : null;
      const device = (act.raw_data && act.raw_data.device_name) || null;
      const dateStr = fmtDayHeader(dISO);
      const startTime = act.start_date ? new Date(act.start_date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;

      html += `<div class="ad-header">
        <div class="ad-header-top">
          ${sportIcon(act)}
          <div class="ad-header-info">
            <h2 class="ad-title">${esc(name)}</h2>
            ${source ? `<span class="ad-source">${esc(source)}</span>` : ""}
          </div>
        </div>
        <div class="ad-header-meta">
          <span>${esc(dateStr)}${startTime ? " · " + esc(startTime) : ""}</span>
          ${device ? `<span>${esc(device)}</span>` : ""}
        </div>
      </div>`;

      /* ── SUMMARY STATS ─────────────────────────────────────────── */
      html += renderDetailSummary(act, ex, sport);

      /* ── WORKOUT STRUCTURE VISUALIZATION ────────────────────────── */
      const recognition = (window.AthlevoCoach && AthlevoCoach.getStoredRecognition)
        ? AthlevoCoach.getStoredRecognition(act) : null;

      if (recognition) {
        _wsvSegments = normalizeSegments(recognition, act);
        if (_wsvSegments.length > 0) {
          html += `<div class="ad-section">`;
          html += `<div class="ad-section-h">Workout Structure</div>`;
          try {
            html += (window.WorkoutStructureView && WorkoutStructureView.render)
              ? WorkoutStructureView.render(_wsvSegments)
              : "";
          } catch (e) {}
          html += `</div>`;
        }

        /* ── WORKOUT CLASSIFICATION (compact) ──────────────────── */
        html += `<div class="ad-section ad-classification">`;
        html += `<div class="ad-class-row">
          <span class="ad-class-type">${esc(AthlevoCoach.displayType ? AthlevoCoach.displayType(recognition.workoutType) : recognition.workoutType)}</span>
          <span class="ad-class-conf ${recognition.confidenceLabel === "High" ? "high" : ""}">${esc(recognition.confidenceLabel || "")}</span>
        </div>`;
        if (recognition.coachSummary) {
          const brief = String(recognition.coachSummary).split(/(?<=[.!?])\s+/).slice(0, 3).join(" ");
          html += `<p class="ad-class-summary">${esc(brief)}</p>`;
        }
        html += `</div>`;
      }

      /* ── COACH ANALYSIS (Athlevo differentiator) ───────────────── */
      html += renderCoachSection(act, recognition, s);

      /* ── HR ZONES ──────────────────────────────────────────────── */
      html += renderHRZones(act);

      /* ── CHART SECTIONS ────────────────────────────────────────── */
      html += renderChartSections(act, sport);

      /* ── SPLITS / LAPS ─────────────────────────────────────────── */
      html += renderSplits(act, sport);

    } else if (s && !isRest(s)) {
      /* ── Plan-only view (no activity yet) ──────────────────────── */
      html += renderPlanDetail(s, dISO, ex);
    } else if (s && isRest(s)) {
      html += `<div class="ad-header"><div class="ad-header-top"><div class="ad-header-info"><h2 class="ad-title">Rest Day</h2></div></div>
        <div class="ad-header-meta"><span>${esc(fmtDayHeader(dISO))}</span></div></div>
        <p class="ad-rest-msg">Recovery is part of the plan. Your body adapts during rest.</p>`;
    }

    /* ── Legacy fallback analysis (no stored recognition) ────────── */
    if (act && !((window.AthlevoCoach && AthlevoCoach.getStoredRecognition) ? AthlevoCoach.getStoredRecognition(act) : null) && window.AthlevoWorkoutClassifier) {
      const laps = act.raw_data && (act.raw_data.laps || act.raw_data.splits);
      const cls = window.AthlevoWorkoutClassifier.classifyActivity({
        distanceKm: act.distance_meters ? act.distance_meters / 1000 : null,
        movingSec: act.moving_time_seconds, elapsedSec: act.elapsed_time_seconds,
        avgHr: act.average_heartrate, maxHr: act.max_heartrate, maxSpeed: act.max_speed_mps,
        laps, name: act.name, title: act.name
      }, { zones: null, planned: s ? { session_type: s.session_type, main_set: s.main_set } : null });
      html += `<div class="ad-section"><div class="ad-section-h">Analysis</div>`;
      html += `<div class="ad-kv"><span>Detected type</span><b>${esc(cls.primaryType)}</b></div>`;
      html += `<div class="ad-kv"><span>Confidence</span><span class="ad-class-conf ${cls.confidence === "high" ? "high" : ""}">${esc(cls.confidenceLabel)}</span></div>`;
      if (cls.intervals) html += `<div class="ad-kv"><span>Intervals</span><b>${cls.intervals.reps} × ${cls.intervals.workPaceSec ? fmtPace(cls.intervals.workPaceSec) + "/km" : "reps"}</b></div>`;
      const impact = cls.intensity === "high" ? "Strong speed / top-end stimulus." : cls.intensity === "threshold" ? "Positive threshold-capacity evidence." : "Aerobic base maintained.";
      html += `<div class="ad-impact">${esc(impact)}</div>`;
      html += `</div>`;
    }

    /* ── Render into modal ────────────────────────────────────────── */
    const body = document.getElementById("trainWorkoutModalBody");
    if (body) {
      body.innerHTML = html || `<p class="ad-empty">No details available.</p>`;
      if (window.WorkoutStructureView) WorkoutStructureView.mount(body, _wsvSegments);
    }
    const m = document.getElementById("trainWorkoutModal");
    if (m && window.AthlevoSheet) {
      window.AthlevoSheet.open({
        root: m,
        sheet: ".tw-modal-box",
        draggable: true,
        initialFocus: ".tw-modal-close",
        fallbackFocus: ".af-card, .tc-day.sel",
        onRequestClose: () => { closeModal(); return false; }
      });
    } else if (m) {
      m.classList.add("show");
      m.setAttribute("aria-hidden", "false");
    }
  }

  /* ── Detail: Summary stats grid ────────────────────────────────── */
  function renderDetailSummary(act, ex, sport) {
    const items = [];

    // Distance
    if (act.distance_meters && sport !== "strength" && sport !== "mobility") {
      items.push({ label: "Distance", value: (act.distance_meters / 1000).toFixed(2), unit: "km" });
    }
    // Duration
    if (act.moving_time_seconds) {
      items.push({ label: "Duration", value: fmtDuration(act.moving_time_seconds), unit: "" });
    }
    // Pace (runs)
    if (sport === "run" && act.distance_meters && act.moving_time_seconds) {
      const paceSec = act.moving_time_seconds / (act.distance_meters / 1000);
      items.push({ label: "Avg Pace", value: fmtPace(paceSec), unit: "/km" });
    }
    // Speed (rides)
    if (sport === "ride" && act.distance_meters && act.moving_time_seconds) {
      items.push({ label: "Avg Speed", value: ((act.distance_meters / act.moving_time_seconds) * 3.6).toFixed(1), unit: "km/h" });
    }
    // HR
    if (act.average_heartrate) {
      items.push({ label: "Avg HR", value: Math.round(act.average_heartrate), unit: "bpm" });
    }
    // Load
    const load = activityLoad(act);
    if (load) items.push({ label: "Load", value: load, unit: "" });
    // RPE
    if (ex && ex.actual_rpe) items.push({ label: "RPE", value: ex.actual_rpe, unit: "/10" });
    // Feel
    if (ex && ex.overall_feeling) {
      const feel = ex.overall_feeling === "easier" ? "Easy" : ex.overall_feeling === "harder" ? "Hard" : "Normal";
      items.push({ label: "Feel", value: feel, unit: "" });
    }
    // Calories
    const raw = act.raw_data && typeof act.raw_data === "object" ? act.raw_data : {};
    if (num(raw.calories) > 0) items.push({ label: "Calories", value: Math.round(raw.calories), unit: "kcal" });

    if (!items.length) return "";

    return `<div class="ad-summary">${items.map(i =>
      `<div class="ad-summary-item"><span class="ad-summary-val">${esc(String(i.value))}${i.unit ? `<small>${esc(i.unit)}</small>` : ""}</span><span class="ad-summary-label">${esc(i.label)}</span></div>`
    ).join("")}</div>`;
  }

  /* ── Detail: Coach analysis section ────────────────────────────── */
  function renderCoachSection(act, recognition, session) {
    let html = `<div class="ad-section ad-coach">`;
    html += `<div class="ad-section-h">Coach Analysis</div>`;

    if (recognition && recognition.coachSummary) {
      html += `<p class="ad-coach-text">${esc(recognition.coachSummary)}</p>`;
    } else {
      // Generate a simple interpretation
      const sport = canonSport(act);
      if (sport === "run" && act.average_heartrate && act.moving_time_seconds) {
        const min = Math.round(act.moving_time_seconds / 60);
        const hr = Math.round(act.average_heartrate);
        html += `<p class="ad-coach-text">${min} minute ${sportShort(act).toLowerCase()} at ${hr} bpm average heart rate.</p>`;
      } else {
        html += `<p class="ad-coach-text ad-coach-placeholder">Detailed analysis will appear here after your workout is processed.</p>`;
      }
    }

    html += `<button class="ad-ask-coach" type="button" onclick="AthlevoTrainCalendar.askCoach('${act.id}')">Ask Coach about this activity</button>`;
    html += `</div>`;
    return html;
  }

  /* ── Detail: HR zones ──────────────────────────────────────────── */
  function renderHRZones(act) {
    const raw = act.raw_data && typeof act.raw_data === "object" ? act.raw_data : {};
    const zones = raw.heart_rate_zones || raw.hr_zones || null;
    if (!zones || !Array.isArray(zones) || !zones.length) return "";

    const totalTime = zones.reduce((sum, z) => sum + (z.time_seconds || z.time || 0), 0);
    if (totalTime <= 0) return "";

    const ZONE_COLORS = ["var(--zone-1)", "var(--zone-2)", "var(--zone-3)", "var(--zone-4)", "var(--zone-5)"];
    const ZONE_NAMES = ["Z1 Recovery", "Z2 Endurance", "Z3 Tempo", "Z4 Threshold", "Z5 VO2max"];

    let html = `<div class="ad-section ad-zones"><div class="ad-section-h">Heart Rate Zones</div>`;
    html += `<div class="ad-zones-list">`;
    zones.forEach((z, i) => {
      const time = z.time_seconds || z.time || 0;
      if (time <= 0) return;
      const pct = Math.round((time / totalTime) * 100);
      const min = Math.round(time / 60);
      const name = z.name || ZONE_NAMES[i] || `Z${i + 1}`;
      const color = ZONE_COLORS[Math.min(i, ZONE_COLORS.length - 1)];
      const range = z.min && z.max ? `${Math.round(z.min)}–${Math.round(z.max)} bpm` : "";

      html += `<div class="ad-zone-row">
        <div class="ad-zone-info"><span class="ad-zone-name">${esc(name)}</span>${range ? `<span class="ad-zone-range">${esc(range)}</span>` : ""}</div>
        <div class="ad-zone-bar-wrap"><div class="ad-zone-bar" style="width:${pct}%;background:${color}"></div></div>
        <div class="ad-zone-time"><span>${min}m</span><span class="ad-zone-pct">${pct}%</span></div>
      </div>`;
    });
    html += `</div></div>`;
    return html;
  }

  /* ── Detail: Chart sections (HR, Pace, Power, Elevation, Cadence) ── */
  function renderChartSections(act, sport) {
    const raw = act.raw_data && typeof act.raw_data === "object" ? act.raw_data : {};
    let html = "";

    // Heart Rate chart
    if (act.average_heartrate || act.max_heartrate) {
      html += `<div class="ad-section ad-chart-section">`;
      html += `<div class="ad-section-h">Heart Rate</div>`;
      html += `<div class="ad-chart-stats">`;
      if (act.average_heartrate) html += `<span class="ad-chart-stat"><b>${Math.round(act.average_heartrate)}</b> avg bpm</span>`;
      if (act.max_heartrate) html += `<span class="ad-chart-stat"><b>${Math.round(act.max_heartrate)}</b> max bpm</span>`;
      html += `</div>`;
      // Time-series chart placeholder (ready for stream data)
      const hrStream = raw.heartrate_stream || raw.hr_stream || null;
      if (hrStream && Array.isArray(hrStream) && hrStream.length > 2) {
        html += renderStreamChart(hrStream, "var(--red)", act.average_heartrate);
      } else {
        html += `<div class="ad-chart-placeholder">Heart rate chart available with connected device data</div>`;
      }
      html += `</div>`;
    }

    // Pace chart (runs)
    if (sport === "run" && act.distance_meters && act.moving_time_seconds) {
      const avgPace = act.moving_time_seconds / (act.distance_meters / 1000);
      const gap = raw.gap || raw.grade_adjusted_pace || null;
      html += `<div class="ad-section ad-chart-section">`;
      html += `<div class="ad-section-h">Pace</div>`;
      html += `<div class="ad-chart-stats">`;
      html += `<span class="ad-chart-stat"><b>${fmtPace(avgPace)}</b> avg /km</span>`;
      if (gap) html += `<span class="ad-chart-stat"><b>${esc(String(gap))}</b> GAP</span>`;
      html += `</div>`;
      const paceStream = raw.pace_stream || raw.velocity_stream || null;
      if (paceStream && Array.isArray(paceStream) && paceStream.length > 2) {
        html += renderStreamChart(paceStream, "var(--good)", avgPace, true);
      }
      html += `</div>`;
    }

    // Power chart
    const avgPower = num(raw.average_power_watts) || num(raw.average_watts);
    const maxPower = num(raw.max_power_watts) || num(raw.max_watts);
    if (avgPower > 0 || maxPower > 0) {
      html += `<div class="ad-section ad-chart-section">`;
      html += `<div class="ad-section-h">Power</div>`;
      html += `<div class="ad-chart-stats">`;
      if (avgPower) html += `<span class="ad-chart-stat"><b>${Math.round(avgPower)}</b> avg W</span>`;
      if (maxPower) html += `<span class="ad-chart-stat"><b>${Math.round(maxPower)}</b> max W</span>`;
      html += `</div></div>`;
    }

    // Elevation
    if (act.elevation_gain_meters) {
      html += `<div class="ad-section ad-chart-section">`;
      html += `<div class="ad-section-h">Elevation</div>`;
      html += `<div class="ad-chart-stats">`;
      html += `<span class="ad-chart-stat"><b>${Math.round(act.elevation_gain_meters)}</b> m gain</span>`;
      if (raw.max_elevation) html += `<span class="ad-chart-stat"><b>${Math.round(raw.max_elevation)}</b> m max</span>`;
      html += `</div></div>`;
    }

    // Cadence
    if (act.average_cadence) {
      const unit = sport === "ride" ? "rpm" : "spm";
      html += `<div class="ad-section ad-chart-section">`;
      html += `<div class="ad-section-h">Cadence</div>`;
      html += `<div class="ad-chart-stats">`;
      html += `<span class="ad-chart-stat"><b>${Math.round(act.average_cadence)}</b> avg ${unit}</span>`;
      if (raw.max_cadence) html += `<span class="ad-chart-stat"><b>${Math.round(raw.max_cadence)}</b> max ${unit}</span>`;
      html += `</div></div>`;
    }

    return html;
  }

  /* ── SVG stream chart (inline, performant) ─────────────────────── */
  function renderStreamChart(data, color, avgLine, invertY) {
    if (!data || !data.length) return "";
    const W = 320, H = 80, PAD = 2;
    const vals = data.map(v => num(v)).filter(v => v != null);
    if (vals.length < 3) return "";

    let min = Math.min(...vals), max = Math.max(...vals);
    if (max === min) { min -= 1; max += 1; }
    const range = max - min;

    // Downsample to ~160 points for performance
    const step = Math.max(1, Math.floor(vals.length / 160));
    const sampled = [];
    for (let i = 0; i < vals.length; i += step) sampled.push(vals[i]);

    const points = sampled.map((v, i) => {
      const x = PAD + (i / (sampled.length - 1)) * (W - 2 * PAD);
      let y;
      if (invertY) {
        y = PAD + ((v - min) / range) * (H - 2 * PAD); // lower pace = higher on chart
      } else {
        y = H - PAD - ((v - min) / range) * (H - 2 * PAD);
      }
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const path = `M${points.join("L")}`;
    const fill = `M${PAD},${H}L${points.join("L")}L${W - PAD},${H}Z`;

    let avgY = null;
    if (avgLine != null) {
      avgY = invertY
        ? PAD + ((avgLine - min) / range) * (H - 2 * PAD)
        : H - PAD - ((avgLine - min) / range) * (H - 2 * PAD);
    }

    return `<svg class="ad-stream-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${fill}" fill="${color}" fill-opacity=".12"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      ${avgY != null ? `<line x1="${PAD}" y1="${avgY.toFixed(1)}" x2="${W - PAD}" y2="${avgY.toFixed(1)}" stroke="${color}" stroke-width="0.75" stroke-dasharray="4 3" opacity=".5"/>` : ""}
    </svg>`;
  }

  /* ── Detail: Splits / Laps ─────────────────────────────────────── */
  function renderSplits(act, sport) {
    const raw = act.raw_data && typeof act.raw_data === "object" ? act.raw_data : {};
    const laps = raw.laps || raw.splits || null;
    if (!laps || !Array.isArray(laps) || laps.length < 2) return "";

    let html = `<div class="ad-section ad-splits">`;
    html += `<div class="ad-section-h">Splits</div>`;
    html += `<div class="ad-splits-table"><div class="ad-splits-head">`;
    html += `<span>#</span><span>Dist</span><span>Pace</span>`;
    if (act.average_heartrate) html += `<span>HR</span>`;
    html += `</div>`;

    laps.forEach((lap, i) => {
      const dist = lap.distance || lap.distance_meters;
      const distKm = dist ? (dist > 1000 ? (dist / 1000).toFixed(2) : dist.toFixed(2)) : null;
      const time = lap.moving_time || lap.elapsed_time || lap.time_seconds;
      const pace = (dist && time && sport === "run") ? fmtPace(time / (dist / 1000)) : null;
      const hr = lap.average_heartrate || lap.avg_hr;

      html += `<div class="ad-splits-row">
        <span>${i + 1}</span>
        <span>${distKm ? distKm + " km" : "—"}</span>
        <span>${pace ? pace + "/km" : "—"}</span>
        ${act.average_heartrate ? `<span>${hr ? Math.round(hr) : "—"}</span>` : ""}
      </div>`;
    });

    html += `</div></div>`;
    return html;
  }

  /* ── Detail: Plan-only view ────────────────────────────────────── */
  function renderPlanDetail(s, dISO, ex) {
    const title = typeof formatSessionType === "function" ? formatSessionType(s.session_type) : (s.title || "Workout");
    let html = `<div class="ad-header"><div class="ad-header-top"><div class="ad-header-info">
      <h2 class="ad-title">${esc(title)}</h2>
      <span class="ad-source">Planned Session</span>
    </div></div>
    <div class="ad-header-meta"><span>${esc(fmtDayHeader(dISO))}</span></div></div>`;

    // Plan summary
    const items = [];
    if (num(s.duration_minutes) > 0) items.push({ label: "Duration", value: Math.round(s.duration_minutes) + "m" });
    if (num(s.distance_km) > 0) items.push({ label: "Distance", value: s.distance_km + " km" });
    if (s.pace_guidance) items.push({ label: "Target Pace", value: s.pace_guidance });
    if (s.target_rpe) items.push({ label: "Target RPE", value: s.target_rpe });
    if (items.length) {
      html += `<div class="ad-summary">${items.map(i =>
        `<div class="ad-summary-item"><span class="ad-summary-val">${esc(i.value)}</span><span class="ad-summary-label">${esc(i.label)}</span></div>`
      ).join("")}</div>`;
    }

    if (s.purpose) html += `<div class="ad-section"><div class="ad-section-h">Purpose</div><p class="ad-plan-text">${esc(s.purpose)}</p></div>`;

    const warmup = Array.isArray(s.warmup) ? s.warmup.filter(Boolean) : [];
    const mainSet = Array.isArray(s.main_set) ? s.main_set.filter(Boolean) : [];
    const cooldown = Array.isArray(s.cooldown) ? s.cooldown.filter(Boolean) : [];

    if (warmup.length) html += `<div class="ad-section"><div class="ad-section-h">Warm-up</div><ul class="ad-plan-list">${warmup.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
    if (mainSet.length) html += `<div class="ad-section"><div class="ad-section-h">Main Set</div><ul class="ad-plan-list">${mainSet.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
    if (cooldown.length) html += `<div class="ad-section"><div class="ad-section-h">Cooldown</div><ul class="ad-plan-list">${cooldown.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>`;

    if (s.coach_reasoning) html += `<div class="ad-section"><div class="ad-section-h">Coach Reasoning</div><p class="ad-plan-text ad-coach-text">${esc(s.coach_reasoning)}</p></div>`;

    if (ex && ex.status === "skipped") {
      html += `<div class="ad-section"><div class="ad-section-h">Status</div><p class="ad-plan-text">Skipped${ex.skip_reason ? " — " + esc(ex.skip_reason) : ""}</p></div>`;
    }

    return html;
  }

  /* ── Workout structure normalization (unchanged logic) ──────────── */
  let _wsvSegments = [];
  function workTone(type) {
    type = String(type || "");
    if (/tempo/i.test(type)) return "orange";
    if (/threshold|interval|vo2|speed/i.test(type)) return "red";
    if (/easy|long|recovery/i.test(type)) return "green";
    return "red";
  }
  function segTone(kind, type) {
    if (kind === "warmup") return "warm";
    if (kind === "recovery") return "blue";
    if (kind === "cooldown") return "gray";
    return workTone(type);
  }
  function segLabel(kind, type) {
    if (kind === "warmup") return "Warm-up";
    if (kind === "recovery") return "Recovery";
    if (kind === "cooldown") return "Cooldown";
    if (kind === "work") {
      if (/tempo/i.test(type)) return "Tempo";
      if (/vo2/i.test(type)) return "VO2";
      if (/interval/i.test(type)) return "Interval";
      if (/speed/i.test(type)) return "Speed";
      return "Threshold";
    }
    return (window.AthlevoCoach && AthlevoCoach.displayType ? AthlevoCoach.displayType(type) : type) || "Run";
  }
  function normalizeSegments(rec, act) {
    const raw = ((rec && rec.segments) || []).filter(s => s && s.duration > 0);
    const structured = raw.filter(s => s.kind !== "steady");
    if (structured.length) {
      return structured.map(s => ({
        kind: s.kind,
        label: segLabel(s.kind, rec.workoutType),
        duration: s.duration,
        tone: segTone(s.kind, rec.workoutType),
        pace: s.avgPace ? fmtPace(s.avgPace) : null,
        distanceKm: s.distance ? s.distance / 1000 : null
      }));
    }
    const totalSec = (act && act.moving_time_seconds) || (raw[0] && raw[0].duration) || null;
    if (totalSec) {
      const km = act && act.distance_meters ? act.distance_meters / 1000 : null;
      const paceSec = (km && totalSec) ? totalSec / km : null;
      return [{ kind: "steady", label: segLabel("steady", rec.workoutType), duration: totalSec, tone: segTone("steady", rec.workoutType), pace: paceSec ? fmtPace(paceSec) : null, distanceKm: km }];
    }
    return [];
  }

  /* ── Ask Coach (placeholder → routes to Coach tab) ─────────────── */
  function askCoach(activityId) {
    // Navigate to Coach tab with activity context
    if (window.AthlevoCoachChat && typeof AthlevoCoachChat.openWithContext === "function") {
      AthlevoCoachChat.openWithContext({ activityId });
    } else {
      // Fallback: switch to Coach tab
      const coachTab = document.querySelector('.tab[data-screen="screen-coachai"]');
      if (coachTab && typeof go === "function") go(coachTab);
    }
    closeModal();
  }

  /* ── close modal ────────────────────────────────────────────────── */
  function closeModal() {
    const m = document.getElementById("trainWorkoutModal");
    if (!m) return;
    if (window.AthlevoSheet && window.AthlevoSheet.isOpen(m)) {
      window.AthlevoSheet.close(m);
      return;
    }
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
  }

  /* ── navigation (unchanged) ────────────────────────────────────── */
  function selectedDow() { const [y, m, d] = selected.split("-").map(Number); return (new Date(y, m - 1, d).getDay() + 6) % 7; }
  async function goToWeek(monday, keepDow) {
    weekStart = monday;
    if (keepDow != null) selected = iso(addDays(monday, keepDow));
    render();
    await loadWeek(monday);
    render();
  }
  function interruptWeekMotion() {
    weekMotionToken += 1;
    if (weekMotion) { try { weekMotion.cancel(); } catch (e) {} weekMotion = null; }
    const cal = document.getElementById("trainCalendar");
    if (cal) cal.style.transform = "";
  }
  async function prevWeek() { interruptWeekMotion(); await goToWeek(addDays(weekStart, -7), selectedDow()); }
  async function nextWeek() { interruptWeekMotion(); await goToWeek(addDays(weekStart, 7), selectedDow()); }
  async function goToday() { interruptWeekMotion(); selected = todayISO(); await goToWeek(mondayOf(new Date()), null); selected = todayISO(); render(); }
  function select(dISO) {
    selected = dISO;
    render();
    const activeDay = document.querySelector("#trainCalendar .tc-day.sel");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (activeDay && !reduce && typeof activeDay.animate === "function") {
      activeDay.animate([{ transform: "scale(.965)" }, { transform: "scale(1)" }], { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
  }

  /* ── swipe gestures (unchanged) ──────────────────────────────────── */
  function attachSwipe(elem) {
    if (elem._tcSwipe || !window.PointerEvent) return;
    elem._tcSwipe = true;
    elem.style.touchAction = "pan-y";
    let gesture = null;
    let frame = null;

    const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const presentationX = transform => {
      if (!transform || transform === "none") return 0;
      if (window.DOMMatrixReadOnly) { try { return new window.DOMMatrixReadOnly(transform).m41 || 0; } catch (e) {} }
      const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
      if (matrix3d) return Number(matrix3d[1].split(",")[12]) || 0;
      const matrix = transform.match(/^matrix\(([^)]+)\)$/);
      return matrix ? Number(matrix[1].split(",")[4]) || 0 : 0;
    };
    const paint = () => { frame = null; if (!gesture || gesture.intent !== "horizontal") return; elem.style.transform = `translate3d(${gesture.dx}px,0,0)`; };
    const cleanup = pointerId => {
      elem.removeEventListener("pointermove", move);
      elem.removeEventListener("pointerup", end);
      elem.removeEventListener("pointercancel", cancel);
      if (pointerId != null) { try { elem.releasePointerCapture(pointerId); } catch (e) {} }
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
    };
    const settle = dx => {
      elem.style.transform = "";
      if (reduced() || typeof elem.animate !== "function") return;
      weekMotion = elem.animate([{ transform: `translate3d(${dx}px,0,0)` }, { transform: "translate3d(0,0,0)" }], { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" });
    };
    const navigate = async (direction, dx) => {
      const token = ++weekMotionToken;
      const width = elem.clientWidth || window.innerWidth || 390;
      if (!reduced() && typeof elem.animate === "function") {
        weekMotion = elem.animate([{ transform: `translate3d(${dx}px,0,0)` }, { transform: `translate3d(${direction > 0 ? -width : width}px,0,0)` }], { duration: 180, easing: "cubic-bezier(.32,.72,0,1)" });
        try { await weekMotion.finished; } catch (e) {}
      }
      if (token !== weekMotionToken) return;
      elem.style.transform = "";
      const dow = selectedDow();
      await goToWeek(addDays(weekStart, direction * 7), dow);
      if (token !== weekMotionToken || reduced() || typeof elem.animate !== "function") return;
      weekMotion = elem.animate([{ transform: `translate3d(${direction > 0 ? 28 : -28}px,0,0)`, opacity: .94 }, { transform: "translate3d(0,0,0)", opacity: 1 }], { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" });
    };
    const move = event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (!gesture.intent && Math.max(Math.abs(dx), Math.abs(dy)) >= 12) {
        gesture.intent = Math.abs(dx) > Math.abs(dy) * 1.35 ? "horizontal" : "vertical";
      }
      if (gesture.intent === "vertical") { const current = gesture.dx; cleanup(gesture.id); gesture = null; settle(current); return; }
      if (gesture.intent !== "horizontal") return;
      event.preventDefault();
      const now = event.timeStamp || Date.now();
      gesture.velocity = (event.clientX - gesture.lastX) / Math.max(1, now - gesture.lastTime);
      gesture.lastX = event.clientX; gesture.lastTime = now;
      gesture.travelX = dx; gesture.dx = gesture.baseX + dx;
      if (frame == null) frame = requestAnimationFrame(paint);
    };
    const end = event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const finished = gesture; cleanup(finished.id); gesture = null;
      const width = elem.clientWidth || window.innerWidth || 390;
      const projected = finished.travelX + finished.velocity * 140;
      const commit = Math.abs(projected) > Math.max(72, width * .24) || Math.abs(finished.velocity) > .65;
      if (finished.intent === "horizontal" && commit) navigate(finished.travelX < 0 ? 1 : -1, finished.dx);
      else settle(finished.dx || 0);
    };
    const cancel = event => { if (!gesture || event.pointerId !== gesture.id) return; const dx = gesture.dx || 0; cleanup(gesture.id); gesture = null; settle(dx); };
    elem.addEventListener("pointerdown", event => {
      if (reduced() || !event.isPrimary || event.button !== 0 || gesture) return;
      if (event.target.closest(".tc-nav")) return;
      if (event.clientX < 24 || event.clientX > window.innerWidth - 24) return;
      const computed = window.getComputedStyle ? window.getComputedStyle(elem) : null;
      const currentTransform = computed && computed.transform !== "none" ? computed.transform : "translate3d(0,0,0)";
      ++weekMotionToken;
      if (weekMotion) { try { weekMotion.cancel(); } catch (e) {} weekMotion = null; }
      const baseX = presentationX(currentTransform);
      elem.style.transform = currentTransform;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: baseX, baseX, travelX: 0, intent: null, velocity: 0, lastX: event.clientX, lastTime: event.timeStamp || Date.now() };
      try { elem.setPointerCapture(event.pointerId); } catch (e) {}
      elem.addEventListener("pointermove", move, { passive: false });
      elem.addEventListener("pointerup", end);
      elem.addEventListener("pointercancel", cancel);
    });
  }

  async function open(planData) {
    hasAnyPlan = !!(planData && planData.hasPlan);
    selected = todayISO(); weekStart = mondayOf(new Date());
    render();
    await loadWeek(weekStart);
    render();
  }

  window.AthlevoTrainCalendar = { open, prevWeek, nextWeek, goToday, select, openModal, closeModal, askCoach, VERSION: "train-calendar-v3" };
})();
