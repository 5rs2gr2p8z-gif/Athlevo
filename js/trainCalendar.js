/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Date-First Training Calendar  (Train primary experience)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The calendar is the source of truth. Everything below it (selected-date
 *  workout, Weekly Progress, Training Context) responds to the selected date
 *  and selected week. Reads plan / executions / activities per week (RLS,
 *  read-only). Does NOT touch workout classification, plan generation, Trends,
 *  or the Athlevo Score — it only READS the recognition engine for the detail
 *  sheet. Exposed as window.AthlevoTrainCalendar.
 */
(function () {
  "use strict";

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const QUALITY_RE = /threshold|tempo|interval|vo2|repetition|\brep\b|reps|speed|hill|race|time.?trial|fartlek|cruise/i;

  let weekStart = null;    // Monday 00:00 local of the shown week
  let selected = null;     // "YYYY-MM-DD"
  let byDate = {};         // date → { session, execution, activities:[] }
  let actById = {};        // activity id → activity (for modal lookup)
  let hasAnyPlan = false;

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

  /* ── data (read-only, RLS) ────────────────────────────────────────── */
  async function loadWeek(monday) {
    byDate = {}; actById = {};
    const start = iso(monday), end = iso(addDays(monday, 6));
    let user = null;
    try { user = (await supabaseClient.auth.getUser()).data.user; } catch (e) {}
    if (!user) return;
    const base = table => supabaseClient.from(table).select("*").eq("user_id", user.id);

    // Scalability: bound every per-week read. Sessions and activities are date
    // ranged; execution records are then fetched ONLY for this week's session
    // ids (previously this pulled the athlete's entire execution history on
    // every week swipe — unbounded and O(history) per navigation).
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

  /* ── calendar strip (unchanged design) ────────────────────────────── */
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
    renderPanel();
    renderWeekProgress();
    renderContext();
  }

  /* ── selected-date panel ──────────────────────────────────────────── */
  function fmtDateLong(dISO) { const [y, m, d] = dISO.split("-").map(Number); const dt = new Date(y, m - 1, d); return `${DOW[(dt.getDay() + 6) % 7]} · ${MONTHS[m - 1].slice(0, 3)} ${d}`; }
  const STATUS_LABEL = { done: "Completed", mod: "Modified", skip: "Skipped", planned: "Planned", rest: "Rest day", activity: "Activity" };
  function section(label, inner) { return `<div class="tcp-sec"><div class="tcp-sec-label">${esc(label)}</div>${inner}</div>`; }
  function listOr(label, arr) { const items = (Array.isArray(arr) ? arr : []).map(x => x == null ? "" : String(x)).filter(Boolean); return items.length ? section(label, `<ul>${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>`) : ""; }
  const sportLabel = a => { const s = String(a.sport_type || a.activity_type || "").toLowerCase(); if (/ride|bike|cycl/.test(s)) return "Ride"; if (/swim/.test(s)) return "Swim"; if (/weight|gym|strength/.test(s)) return "Gym"; if (/brick/.test(s)) return "Brick"; if (/walk|hike/.test(s)) return "Walk"; return "Run"; };

  function renderPanel() {
    const el = document.getElementById("trainDayPanel");
    if (!el) return;
    const entry = byDate[selected] || null;
    const acts = (entry && entry.activities) || [];
    const st = statusOf(entry);

    if (!entry || (!entry.session && !acts.length)) {
      el.innerHTML = `<div class="tcp-card tcp-empty">
        <div class="tcp-empty-icon"><img src="assets/athlevo-icon.png" alt="" width="30" height="30"></div>
        <h3>No planned workout</h3>
        <p>${hasAnyPlan ? "Nothing scheduled for " + esc(fmtDateLong(selected)) + "." : "You don't have a training plan yet."}</p>
        ${hasAnyPlan ? "" : `<button class="tcp-cta" type="button" onclick="(window.AthlevoPlan?AthlevoPlan.start():null)">Build My Plan</button>`}
      </div>`;
      return;
    }

    // No planned session, but one or more imported activities.
    if (!entry.session && acts.length) {
      if (acts.length > 1) {
        el.innerHTML = `<div class="tcp-card"><span class="tcp-date">${esc(fmtDateLong(selected))}</span>
          <span class="tcp-status activity">${acts.length} activities</span>
          <div class="tcp-actlist" style="margin-top:12px">${acts.map((a, i) => actRow(a, i)).join("")}</div></div>`;
      } else {
        // PART 2: show the DETECTED workout, not a generic name.
        const a0 = acts[0];
        const label = (window.AthlevoCoach && AthlevoCoach.activityLabel) ? AthlevoCoach.activityLabel(a0) : (a0.name || "Imported run");
        const auto = window.AthlevoCoach && AthlevoCoach.isAutoDetected && AthlevoCoach.isAutoDetected(a0);
        const summary = window.AthlevoCoach && AthlevoCoach.coachSummary ? AthlevoCoach.coachSummary(a0) : null;
        el.innerHTML = `<div class="tcp-card clickable" onclick="AthlevoTrainCalendar.openModal('${selected}','${a0.id}')">
          <span class="tcp-date">${esc(fmtDateLong(selected))}</span>
          <span class="tcp-status activity">Detected Workout</span>
          <h2 class="tcp-title">${esc(label)}</h2>
          ${auto ? `<span class="tcp-badge">Detected automatically</span>` : ""}
          <div class="tcp-meta">${actMeta(a0)}</div>
          ${summary ? `<p class="tcp-coachsum">${esc(summary)}</p>` : ""}
          <div class="tcp-more">View Analysis ›</div></div>`;
      }
      return;
    }

    // Planned session (+ optional execution / activity). One clickable card.
    let s = entry.session;
    if (window.AthlevoPrescription && typeof window.AthlevoPrescription.repair === "function") s = window.AthlevoPrescription.repair(s);
    const rest = isRest(s);
    const title = rest ? "Rest day" : (typeof formatSessionType === "function" ? formatSessionType(s.session_type) : (s.title || "Workout"));
    const meta = [];
    if (num(s.duration_minutes) > 0) meta.push(`<b>${Math.round(s.duration_minutes)}</b> min`);
    if (num(s.distance_km) > 0) meta.push(`<b>${s.distance_km}</b> km`);
    if (s.pace_guidance) meta.push(`Pace <b>${esc(s.pace_guidance)}</b>`);
    if (s.target_rpe) meta.push(`RPE <b>${esc(s.target_rpe)}</b>`);
    const extra = acts.length ? `<div class="tcp-more">Plan + execution · tap for analysis ›</div>` : (rest ? "" : `<div class="tcp-more">Tap for full workout ›</div>`);
    el.innerHTML = `<div class="tcp-card${rest ? "" : " clickable"}"${rest ? "" : ` onclick="AthlevoTrainCalendar.openModal('${selected}')"`}>
      <span class="tcp-date">${esc(fmtDateLong(selected))}</span>
      <span class="tcp-status ${st || "planned"}">${esc(STATUS_LABEL[st] || "Planned")}</span>
      <h2 class="tcp-title">${esc(title)}</h2>
      ${meta.length ? `<div class="tcp-meta">${meta.join('<span style="color:var(--ink3)">·</span>')}</div>` : ""}
      ${extra}</div>`;
  }
  function actMeta(a) { const km = a.distance_meters ? (a.distance_meters / 1000).toFixed(1) + " km" : ""; const min = a.moving_time_seconds ? Math.round(a.moving_time_seconds / 60) + " min" : ""; return [km ? `<b>${km}</b>` : "", min ? `<b>${min}</b>` : ""].filter(Boolean).join('<span style="color:var(--ink3)">·</span>'); }
  function actRow(a, i) {
    const km = a.distance_meters ? (a.distance_meters / 1000).toFixed(1) + " km" : "";
    const label = (window.AthlevoCoach && AthlevoCoach.activityLabel) ? AthlevoCoach.activityLabel(a) : (a.name || "Activity");
    return `<button class="tcp-actrow" type="button" onclick="AthlevoTrainCalendar.openModal('${selected}','${a.id}')"><span class="tcp-actsport">${esc(sportLabel(a))}</span><b>${esc(label)}</b><small>${esc(km)}</small></button>`;
  }
  function singleCard(date, status, title, meta, onclick) {
    return `<div class="tcp-card clickable" onclick="${onclick}"><span class="tcp-date">${esc(date)}</span>
      <span class="tcp-status activity">${esc(status)}</span><h2 class="tcp-title">${title}</h2>
      ${meta ? `<div class="tcp-meta">${meta}</div>` : ""}<div class="tcp-more">Tap for details ›</div></div>`;
  }

  /* ── weekly progress (selected week, Mon–Sun) ─────────────────────── */
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
    // Add unplanned completed RUNS (activities not already counted via an execution),
    // and never double-count when the day already had a completed execution.
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
    const pct = w.hasPlannedKm && w.plannedKm > 0 ? Math.round((w.completedKm / w.plannedKm) * 100) : null;
    const volLine = w.hasPlannedKm
      ? `${w.completedKm} <small>/ ${w.plannedKm} km</small>`
      : `${w.completedKm} <small>km</small>`;
    el.innerHTML = `
      <div class="twp">
        <div class="twp-top">
          <span class="twp-eyebrow">Weekly progress · ${esc(fmtDateLong(iso(weekStart)).replace(/^[A-Za-z]+ · /, ""))}–${esc(fmtDateLong(iso(addDays(weekStart, 6))).replace(/^[A-Za-z]+ · /, ""))}</span>
          ${pct != null ? `<span class="twp-pct${pct === 0 ? " zero" : ""}">${pct}% complete</span>` : ""}
        </div>
        <div class="twp-vol">${volLine}</div>
        ${w.hasPlannedKm ? `<div class="twp-bar"><i style="width:${Math.min(100, pct || 0)}%"></i></div>` : `<p class="twp-unavail">Planned volume unavailable for this week.</p>`}
        <div class="twp-stats">
          <span><b>${w.completedSessions}</b> / ${w.plannedSessions} sessions</span>
          <span><b>${w.completedQ}</b> / ${w.plannedQ} quality</span>
          <span>Long run <b>${w.plannedLong ? (w.completedLong ? "done" : "pending") : "—"}</b></span>
        </div>
      </div>`;
  }

  /* ── date-aware training context (phase for the selected week) ────── */
  function renderContext() {
    const el = document.getElementById("trainContext");
    if (!el) return;
    // Find any session in the SELECTED WEEK to read the phase that applied then.
    let s = null;
    for (let i = 0; i < 7; i++) { const e = byDate[iso(addDays(weekStart, i))]; if (e && e.session) { s = e.session; break; } }
    if (!s || !(s.phase || s.week_focus || s.weeks_until_race != null)) {
      el.innerHTML = `<div class="tcx"><span class="tcx-eyebrow">Training context</span><p class="tcx-none" style="margin-top:6px">No training plan was active for this date.</p></div>`;
      return;
    }
    const phase = s.phase ? String(s.phase).replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "Training";
    const wtr = num(s.weeks_until_race);
    const race = wtr != null && wtr > 0 ? `${wtr} week${wtr === 1 ? "" : "s"} to race` : (wtr === 0 ? "Race week" : null);
    const purpose = s.week_focus || s.purpose || null;
    const caution = s.coach_reasoning ? String(s.coach_reasoning).split(/[.!?]/)[0].trim() : null;
    el.innerHTML = `
      <div class="tcx">
        <span class="tcx-eyebrow">Training context · as of ${esc(fmtDateLong(selected))}</span>
        <div class="tcx-phase">${esc(phase)}${s.plan_week_start ? `<span class="tcx-wk">week of ${esc(String(s.plan_week_start).slice(5))}</span>` : ""}</div>
        ${purpose ? `<p class="tcx-purpose">${esc(purpose)}</p>` : ""}
        <div class="tcx-meta">${race ? `<span>🏁 <b>${esc(race)}</b></span>` : ""}</div>
        ${caution ? `<p class="tcx-caution">${esc(caution)}.</p>` : ""}
      </div>`;
  }

  /* ── detail sheet (Plan / Execution / Analysis) ───────────────────── */
  function openModal(dISO, activityId) {
    const entry = byDate[dISO] || {};
    let s = entry.session ? entry.session : null;
    if (s && window.AthlevoPrescription && typeof window.AthlevoPrescription.repair === "function") s = window.AthlevoPrescription.repair(s);
    // Choose the activity: explicit id, the execution's linked import, or the day's first activity.
    let act = null;
    if (activityId && actById[String(activityId)]) act = actById[String(activityId)];
    else if (entry.execution && entry.execution.imported_activity_id && actById[String(entry.execution.imported_activity_id)]) act = actById[String(entry.execution.imported_activity_id)];
    else if (entry.activities && entry.activities.length === 1) act = entry.activities[0];
    const ex = entry.execution || null;

    let html = "";
    if (s && !isRest(s)) {
      const title = typeof formatSessionType === "function" ? formatSessionType(s.session_type) : (s.title || "Workout");
      html += `<span class="twm-kicker">Plan · ${esc(fmtDateLong(dISO))}</span><h2 class="twm-title">${esc(title)}</h2>`;
      html += `<div class="twm-block"><div class="twm-block-h">Plan</div>`;
      html += planRow("Session type", typeof formatSessionType === "function" ? formatSessionType(s.session_type) : s.session_type);
      html += planRow("Duration", num(s.duration_minutes) > 0 ? Math.round(s.duration_minutes) + " min" : null);
      html += planRow("Distance", num(s.distance_km) > 0 ? s.distance_km + " km" : null);
      html += planRow("Target pace", s.pace_guidance);
      html += planRow("Target RPE", s.target_rpe);
      html += s.purpose ? `<p class="twm-p">${esc(s.purpose)}</p>` : "";
      html += ul("Warm-up", s.warmup) + ul("Main set", s.main_set) + ul("Cooldown", s.cooldown);
      html += s.coach_reasoning ? `<div class="twm-block-h" style="margin-top:12px">Coach reasoning</div><p class="twm-p">${esc(s.coach_reasoning)}</p>` : "";
      html += `</div>`;
    } else if (s && isRest(s)) {
      html += `<span class="twm-kicker">${esc(fmtDateLong(dISO))}</span><h2 class="twm-title">Rest day</h2><p class="twm-p">Recovery is part of the plan.</p>`;
    }

    // Execution + Analysis (from the imported activity, read-only recognition).
    if (act || (ex && ex.status !== "skipped")) {
      html += `<div class="twm-block"><div class="twm-block-h">Execution</div>`;
      const km = act && act.distance_meters ? (act.distance_meters / 1000).toFixed(1) + " km" : (ex && ex.actual_distance_km ? ex.actual_distance_km + " km" : null);
      const min = act && act.moving_time_seconds ? Math.round(act.moving_time_seconds / 60) + " min" : (ex && ex.actual_duration_minutes ? Math.round(ex.actual_duration_minutes) + " min" : null);
      const avgHr = act && act.average_heartrate ? Math.round(act.average_heartrate) + " bpm" : (ex && ex.actual_average_hr ? ex.actual_average_hr + " bpm" : null);
      const maxHr = act && act.max_heartrate ? Math.round(act.max_heartrate) + " bpm" : null;
      const pace = ex && ex.actual_average_pace ? ex.actual_average_pace + "/km" : (act && act.distance_meters && act.moving_time_seconds ? fmtPace(act.moving_time_seconds / (act.distance_meters / 1000)) : null);
      const elev = act && act.elevation_gain_meters ? Math.round(act.elevation_gain_meters) + " m" : null;
      html += planRow("Status", ex ? (ex.status === "completed" ? "Completed" : ex.status === "modified" ? "Modified" : "Skipped") : "Imported");
      html += planRow("Distance", km) + planRow("Duration", min) + planRow("Average pace", pace) +
        planRow("Average HR", avgHr) + planRow("Max HR", maxHr) + planRow("Elevation", elev) +
        planRow("Athlete RPE", ex && ex.actual_rpe ? String(ex.actual_rpe) : null) +
        planRow("Feeling", ex && ex.overall_feeling ? String(ex.overall_feeling) : null);
      html += `</div>`;

      // PART 5: the STORED recognition — the coach's persisted read of this
      // activity (workout type, confidence, segments, summary, signals). This
      // is the analysis generated ONCE at import, not recomputed here.
      if (act && window.AthlevoCoach) {
        const rec = AthlevoCoach.readRecognition(act);
        if (rec) {
          html += `<div class="twm-block"><div class="twm-block-h">Detected Workout</div>`;
          html += `<div class="twm-row"><span>Workout</span><b>${esc(AthlevoCoach.displayType(rec.workoutType))}</b></div>`;
          html += `<div class="twm-row"><span>Confidence</span><span class="twm-conf ${rec.confidenceLabel === "High" ? "high" : ""}">${esc(rec.confidenceLabel || "")}</span></div>`;
          // Per-block segments (warmup / work / recovery / cooldown), each with
          // its real duration and pace — the reconstructed workout graph.
          const segs = (rec.segments || []).filter(sg => sg.kind !== "steady");
          const works = segs.filter(sg => sg.kind === "work");
          if (works.length) {
            const each = works[0].duration ? Math.round(works[0].duration / 60) : null;
            html += `<div class="twm-row"><span>Detected intervals</span><b>${works.length} × ${each ? each + " min" : "reps"}</b></div>`;
          }
          if (segs.length && segs.some(sg => sg.duration)) {
            const fmtDur = d => Math.floor(d / 60) + ":" + String(Math.round(d % 60)).padStart(2, "0");
            const NAME = { warmup: "Warm-up", work: "Rep", recovery: "Recovery", cooldown: "Cooldown" };
            let repN = 0;
            html += `<div class="twm-segs">` + segs.map(sg => {
              const nm = sg.kind === "work" ? `${NAME.work} ${++repN}` : (NAME[sg.kind] || sg.kind);
              const pace = sg.avgPace ? `${Math.floor(sg.avgPace / 60)}:${String(sg.avgPace % 60).padStart(2, "0")}/km` : "";
              return `<div class="twm-seg"><span>${esc(nm)}</span><b>${sg.duration ? fmtDur(sg.duration) : ""}</b><small>${esc(pace)}</small></div>`;
            }).join("") + `</div>`;
          }
          if (rec.coachSummary) html += `<p class="twm-coachsum">${esc(rec.coachSummary)}</p>`;
          // Recognition signals — compact, why-it-decided.
          if (rec.signals) {
            const sig = Object.keys(rec.signals).map(k => `${k}: ${typeof rec.signals[k] === "object" ? JSON.stringify(rec.signals[k]) : rec.signals[k]}`).join(" · ");
            if (sig) html += `<p class="twm-signals">${esc(sig)}</p>`;
          }
          html += `</div>`;
        }
      }

      // Analysis — READ the recognition engine (no classification change).
      if (act && window.AthlevoWorkoutClassifier) {
        const laps = act.raw_data && (act.raw_data.laps || act.raw_data.splits);
        const cls = window.AthlevoWorkoutClassifier.classifyActivity({
          distanceKm: act.distance_meters ? act.distance_meters / 1000 : null,
          movingSec: act.moving_time_seconds, elapsedSec: act.elapsed_time_seconds,
          avgHr: act.average_heartrate, maxHr: act.max_heartrate, maxSpeed: act.max_speed_mps,
          laps, name: act.name, title: act.name
        }, { zones: null, planned: s ? { session_type: s.session_type, main_set: s.main_set } : null });
        html += `<div class="twm-block"><div class="twm-block-h">Analysis</div>`;
        html += `<div class="twm-row"><span>Detected type</span><b>${esc(cls.primaryType)}</b></div>`;
        html += `<div class="twm-row"><span>Confidence</span><span class="twm-conf ${cls.confidence === "high" ? "high" : ""}">${esc(cls.confidenceLabel)}</span></div>`;
        if (cls.intervals) html += `<div class="twm-row"><span>Detected intervals</span><b>${cls.intervals.reps} × ${cls.intervals.workPaceSec ? fmtPace(cls.intervals.workPaceSec) : "reps"}</b></div>`;
        if (cls.qualityKm && (cls.qualityKm.threshold > 0 || cls.qualityKm.high > 0)) {
          const q = cls.qualityKm.threshold > 0 ? cls.qualityKm.threshold + " km threshold" : cls.qualityKm.high + " km high-intensity";
          html += `<div class="twm-row"><span>Quality contribution</span><b>${esc(q)}${cls.estimated ? " (est.)" : ""}</b></div>`;
        }
        if (s) html += `<div class="twm-row"><span>Matched planned</span><b>${esc(typeof formatSessionType === "function" ? formatSessionType(s.session_type) : s.session_type)}</b></div>`;
        const impact = cls.intensity === "high" ? "Strong speed / top-end stimulus." : cls.intensity === "threshold" ? "Positive threshold-capacity evidence." : "Aerobic base maintained.";
        const recovery = cls.intensity === "easy" ? "You can train normally tomorrow." : "Keep tomorrow easy or recovery.";
        html += `<div class="twm-impact"><b>Training impact:</b> ${esc(impact)}<br><b>Recovery:</b> ${esc(recovery)}</div>`;
        html += `</div>`;
      }
    } else if (ex && ex.status === "skipped") {
      html += `<div class="twm-block"><div class="twm-block-h">Execution</div><p class="twm-p">Skipped${ex.skip_reason ? " — " + esc(ex.skip_reason) : "."}</p></div>`;
    }

    const body = document.getElementById("trainWorkoutModalBody");
    if (body) body.innerHTML = html || `<p class="twm-p">No details available.</p>`;
    const m = document.getElementById("trainWorkoutModal");
    if (m) m.classList.add("show");
  }
  function closeModal() { const m = document.getElementById("trainWorkoutModal"); if (m) m.classList.remove("show"); }
  function planRow(label, value) { return (value == null || value === "") ? "" : `<div class="twm-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }
  function ul(label, arr) { const items = (Array.isArray(arr) ? arr : []).map(x => x == null ? "" : String(x)).filter(Boolean); return items.length ? `<div class="twm-block-h" style="margin-top:12px">${esc(label)}</div><ul class="twm-ul">${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>` : ""; }
  function fmtPace(s) { s = Math.round(s); return `${Math.floor(s / 60)}:${pad(s % 60)}/km`; }

  /* ── navigation ───────────────────────────────────────────────────── */
  function selectedDow() { const [y, m, d] = selected.split("-").map(Number); return (new Date(y, m - 1, d).getDay() + 6) % 7; }
  async function goToWeek(monday, keepDow) {
    weekStart = monday;
    if (keepDow != null) selected = iso(addDays(monday, keepDow));
    render();
    await loadWeek(monday);
    render();
  }
  async function prevWeek() { await goToWeek(addDays(weekStart, -7), selectedDow()); }
  async function nextWeek() { await goToWeek(addDays(weekStart, 7), selectedDow()); }
  async function goToday() { selected = todayISO(); await goToWeek(mondayOf(new Date()), null); selected = todayISO(); render(); }
  function select(dISO) { selected = dISO; render(); }

  function attachSwipe(elem) {
    if (elem._tcSwipe) return; elem._tcSwipe = true;
    let x0 = null, y0 = null;
    elem.addEventListener("touchstart", e => { const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    elem.addEventListener("touchend", e => {
      if (x0 == null) return; const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { dx < 0 ? nextWeek() : prevWeek(); }
      x0 = y0 = null;
    }, { passive: true });
  }

  async function open(planData) {
    hasAnyPlan = !!(planData && planData.hasPlan);
    selected = todayISO(); weekStart = mondayOf(new Date());
    render();
    await loadWeek(weekStart);
    render();
  }

  window.AthlevoTrainCalendar = { open, prevWeek, nextWeek, goToday, select, openModal, closeModal, VERSION: "train-calendar-v2" };
})();
