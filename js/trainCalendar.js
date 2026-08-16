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
  // Canonical sport → short display label (authoritative when the classifier
  // is loaded; falls back to a small heuristic so the UI never breaks).
  const CANON_SPORT_LABEL = {
    run: "Run", ride: "Ride", strength: "Strength", swim: "Swim",
    walk: "Walk", hike: "Hike", mobility: "Mobility",
    cross_training: "Cross-train", rest: "Rest", other: "Activity"
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

    // Completed workout. Order (premium coaching): type → confidence → coach
    // summary → workout structure → raw metrics last.
    if (act || (ex && ex.status !== "skipped")) {
      /*
       * ONE canonical read of the stored recognition, shared with the legacy
       * fallback below so they can never both render. getStoredRecognition
       * checks every real shape (act.recognition, raw_data.recognition, …).
       */
      const recognition = (act && window.AthlevoCoach && AthlevoCoach.getStoredRecognition)
        ? AthlevoCoach.getStoredRecognition(act) : null;

      // 1–4. Detected Workout: type, confidence, concise summary, structure.
      if (act && recognition) {
        const rec = recognition;
        html += `<div class="twm-block"><div class="twm-block-h">Workout</div>`;
        html += `<div class="twm-row"><span>Type</span><b>${esc(AthlevoCoach.displayType(rec.workoutType))}</b></div>`;
        html += `<div class="twm-row"><span>Confidence</span><span class="twm-conf ${rec.confidenceLabel === "High" ? "high" : ""}">${esc(rec.confidenceLabel || "")}</span></div>`;
        // Coach summary — concise, at most three sentences.
        if (rec.coachSummary) {
          const brief = String(rec.coachSummary).split(/(?<=[.!?])\s+/).slice(0, 3).join(" ");
          html += `<p class="twm-coachsum">${esc(brief)}</p>`;
        }
        // Workout Structure Visualization — the centerpiece. One proportional
        // block per segment, rendered by the standalone WorkoutStructureView.
        // Pace is intentionally NOT shown on the graph; it lives in the tap
        // detail card. The component receives ONLY normalized segments.
        _wsvSegments = normalizeSegments(rec, act);
        html += `<div class="twm-struct-h">Workout structure</div>`;
        // The visual graph is the only representation. If the component is
        // missing or throws, show a clean message — NEVER an unstyled text dump.
        try {
          html += (window.WorkoutStructureView && WorkoutStructureView.render)
            ? WorkoutStructureView.render(_wsvSegments)
            : `<p class="wsv__empty">Workout structure unavailable.</p>`;
        } catch (e) {
          html += `<p class="wsv__empty">Workout structure unavailable.</p>`;
        }
        html += `</div>`;
      }

      // 5. Raw metrics — near the bottom. Units are SPORT-AWARE: a ride shows
      // speed (km/h) and power, never running pace; strength shows duration and
      // category rather than distance/pace. Only runs show min/km pace.
      html += `<div class="twm-block"><div class="twm-block-h">Metrics</div>`;
      const sport = act ? canonSport(act) : "run";
      const rawData = (act && act.raw_data && typeof act.raw_data === "object") ? act.raw_data : {};
      const km = act && act.distance_meters ? (act.distance_meters / 1000).toFixed(1) + " km" : (ex && ex.actual_distance_km ? ex.actual_distance_km + " km" : null);
      const min = act && act.moving_time_seconds ? Math.round(act.moving_time_seconds / 60) + " min" : (ex && ex.actual_duration_minutes ? Math.round(ex.actual_duration_minutes) + " min" : null);
      const avgHr = act && act.average_heartrate ? Math.round(act.average_heartrate) + " bpm" : (ex && ex.actual_average_hr ? ex.actual_average_hr + " bpm" : null);
      const maxHr = act && act.max_heartrate ? Math.round(act.max_heartrate) + " bpm" : null;
      const pace = ex && ex.actual_average_pace ? ex.actual_average_pace + "/km" : (act && act.distance_meters && act.moving_time_seconds ? fmtPace(act.moving_time_seconds / (act.distance_meters / 1000)) : null);
      const speedKph = act && act.distance_meters && act.moving_time_seconds ? ((act.distance_meters / act.moving_time_seconds) * 3.6).toFixed(1) + " km/h" : null;
      const powerW = Number(rawData.average_power_watts) > 0 ? Math.round(Number(rawData.average_power_watts)) + " W" : null;
      const cadence = act && act.average_cadence ? Math.round(act.average_cadence) + (sport === "ride" ? " rpm" : " spm") : null;
      const elev = act && act.elevation_gain_meters ? Math.round(act.elevation_gain_meters) + " m" : null;
      html += planRow("Status", ex ? (ex.status === "completed" ? "Completed" : ex.status === "modified" ? "Modified" : "Skipped") : "Imported");
      html += planRow("Sport", CANON_SPORT_LABEL[sport] || "Activity");
      if (sport === "ride") {
        // Ride: duration + distance + speed + power/cadence. No running pace.
        html += planRow("Duration", min) + planRow("Distance", km) +
          planRow("Average speed", speedKph) + planRow("Average power", powerW) +
          planRow("Average HR", avgHr) + planRow("Max HR", maxHr) +
          planRow("Cadence", cadence) + planRow("Elevation", elev);
      } else if (sport === "strength" || sport === "mobility") {
        // Strength/mobility: duration + training category. No distance/pace.
        html += planRow("Duration", min) +
          planRow("Category", CANON_SPORT_LABEL[sport]) +
          planRow("Average HR", avgHr) + planRow("Max HR", maxHr);
      } else if (sport === "run") {
        // Run: distance + pace (min/km).
        html += planRow("Distance", km) + planRow("Duration", min) + planRow("Average pace", pace) +
          planRow("Average HR", avgHr) + planRow("Max HR", maxHr) + planRow("Cadence", cadence) + planRow("Elevation", elev);
      } else {
        // Swim/walk/hike/cross-train/other: duration-first, distance if any,
        // but never running pace.
        html += planRow("Duration", min) + planRow("Distance", km) +
          planRow("Average HR", avgHr) + planRow("Max HR", maxHr) + planRow("Elevation", elev);
      }
      html += planRow("Athlete RPE", ex && ex.actual_rpe ? String(ex.actual_rpe) : null) +
        planRow("Feeling", ex && ex.overall_feeling ? String(ex.overall_feeling) : null);
      html += `</div>`;

      /*
       * ROOT CAUSE of "still shows 17 × 5:11 after analyzing":
       *
       * This legacy block re-classifies the activity LIVE on every render via
       * AthlevoWorkoutClassifier, whose old lap-counting produces "17 × 5:11".
       * It runs IN ADDITION to the stored-recognition block above, so even a
       * perfectly backfilled recognition-v2 record was drowned out by this
       * stale live re-computation.
       *
       * The persisted recognition (above) is now the single source of truth.
       * This block renders ONLY as a fallback when there is no stored
       * recognition at all — never alongside it.
       */
      if (act && !recognition && window.AthlevoWorkoutClassifier) {
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
    if (body) {
      body.innerHTML = html || `<p class="twm-p">No details available.</p>`;
      if (window.WorkoutStructureView) WorkoutStructureView.mount(body, _wsvSegments);
    }
    const m = document.getElementById("trainWorkoutModal");
    if (m && window.AthlevoSheet) {
      window.AthlevoSheet.open({
        root: m,
        sheet: ".tw-modal-box",
        draggable: true,
        initialFocus: ".tw-modal-close",
        fallbackFocus: ".tcp-card.clickable, .tc-day.sel",
        onRequestClose: () => {
          closeModal();
          return false;
        }
      });
    } else if (m) {
      m.classList.add("show");
      m.setAttribute("aria-hidden", "false");
    }
  }
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
  function planRow(label, value) { return (value == null || value === "") ? "" : `<div class="twm-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }
  function ul(label, arr) { const items = (Array.isArray(arr) ? arr : []).map(x => x == null ? "" : String(x)).filter(Boolean); return items.length ? `<div class="twm-block-h" style="margin-top:12px">${esc(label)}</div><ul class="twm-ul">${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>` : ""; }
  function fmtPace(s) { s = Math.round(s); return `${Math.floor(s / 60)}:${pad(s % 60)}/km`; }

  /* ── Workout Structure Visualization: recognition → normalized segments ──
   * The visual component knows nothing about recognition. Here we translate a
   * stored recognition record into its neutral input: colour + label per kind,
   * work colour driven by the detected type. No data is invented.            */
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
    return workTone(type);            // work + steady take the session colour
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
    // Steady run (Easy / Long): a single proportional block across the session.
    const totalSec = (act && act.moving_time_seconds) || (raw[0] && raw[0].duration) || null;
    if (totalSec) {
      const km = act && act.distance_meters ? act.distance_meters / 1000 : null;
      const paceSec = (km && totalSec) ? totalSec / km : null;
      return [{
        kind: "steady",
        label: segLabel("steady", rec.workoutType),
        duration: totalSec,
        tone: segTone("steady", rec.workoutType),
        pace: paceSec ? fmtPace(paceSec) : null,
        distanceKm: km
      }];
    }
    return [];
  }

  /* ── navigation ───────────────────────────────────────────────────── */
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
    if (weekMotion) {
      try { weekMotion.cancel(); } catch (e) {}
      weekMotion = null;
    }
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
      activeDay.animate([
        { transform: "scale(.965)" },
        { transform: "scale(1)" }
      ], { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
  }

  function attachSwipe(elem) {
    if (elem._tcSwipe || !window.PointerEvent) return;
    elem._tcSwipe = true;
    elem.style.touchAction = "pan-y";
    let gesture = null;
    let frame = null;

    const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const presentationX = transform => {
      if (!transform || transform === "none") return 0;
      if (window.DOMMatrixReadOnly) {
        try { return new window.DOMMatrixReadOnly(transform).m41 || 0; } catch (e) {}
      }
      const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
      if (matrix3d) return Number(matrix3d[1].split(",")[12]) || 0;
      const matrix = transform.match(/^matrix\(([^)]+)\)$/);
      return matrix ? Number(matrix[1].split(",")[4]) || 0 : 0;
    };
    const paint = () => {
      frame = null;
      if (!gesture || gesture.intent !== "horizontal") return;
      elem.style.transform = `translate3d(${gesture.dx}px,0,0)`;
    };
    const cleanup = pointerId => {
      elem.removeEventListener("pointermove", move);
      elem.removeEventListener("pointerup", end);
      elem.removeEventListener("pointercancel", cancel);
      if (pointerId != null) {
        try { elem.releasePointerCapture(pointerId); } catch (e) {}
      }
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
    };
    const settle = dx => {
      elem.style.transform = "";
      if (reduced() || typeof elem.animate !== "function") return;
      weekMotion = elem.animate([
        { transform: `translate3d(${dx}px,0,0)` },
        { transform: "translate3d(0,0,0)" }
      ], { duration: 260, easing: "cubic-bezier(.2,.9,.2,1.08)" });
    };
    const navigate = async (direction, dx) => {
      const token = ++weekMotionToken;
      const width = elem.clientWidth || window.innerWidth || 390;
      if (!reduced() && typeof elem.animate === "function") {
        weekMotion = elem.animate([
          { transform: `translate3d(${dx}px,0,0)` },
          { transform: `translate3d(${direction > 0 ? -width : width}px,0,0)` }
        ], { duration: 180, easing: "cubic-bezier(.32,.72,0,1)" });
        try { await weekMotion.finished; } catch (e) {}
      }
      if (token !== weekMotionToken) return;
      elem.style.transform = "";
      const dow = selectedDow();
      await goToWeek(addDays(weekStart, direction * 7), dow);
      if (token !== weekMotionToken || reduced() || typeof elem.animate !== "function") return;
      weekMotion = elem.animate([
        { transform: `translate3d(${direction > 0 ? 28 : -28}px,0,0)`, opacity: .94 },
        { transform: "translate3d(0,0,0)", opacity: 1 }
      ], { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" });
    };
    const move = event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.intent && Math.max(Math.abs(dx), Math.abs(dy)) >= 7) {
        gesture.intent = Math.abs(dx) > Math.abs(dy) * 1.15 ? "horizontal" : "vertical";
      }
      if (gesture.intent === "vertical") {
        const current = gesture.dx;
        cleanup(gesture.id);
        gesture = null;
        settle(current);
        return;
      }
      if (gesture.intent !== "horizontal") return;
      event.preventDefault();
      const now = event.timeStamp || Date.now();
      gesture.velocity = (event.clientX - gesture.lastX) / Math.max(1, now - gesture.lastTime);
      gesture.lastX = event.clientX;
      gesture.lastTime = now;
      gesture.travelX = dx;
      gesture.dx = gesture.baseX + dx;
      if (frame == null) frame = requestAnimationFrame(paint);
    };
    const end = event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const finished = gesture;
      cleanup(finished.id);
      gesture = null;
      const width = elem.clientWidth || window.innerWidth || 390;
      const projected = finished.travelX + finished.velocity * 180;
      const commit = Math.abs(projected) > Math.max(64, width * .22) || Math.abs(finished.velocity) > .48;
      if (finished.intent === "horizontal" && commit) navigate(finished.travelX < 0 ? 1 : -1, finished.dx);
      else settle(finished.dx || 0);
    };
    const cancel = event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = gesture.dx || 0;
      cleanup(gesture.id);
      gesture = null;
      settle(dx);
    };
    elem.addEventListener("pointerdown", event => {
      if (reduced() || !event.isPrimary || event.button !== 0 || gesture) return;
      if (event.target.closest(".tc-nav")) return;
      if (event.clientX < 24 || event.clientX > window.innerWidth - 24) return;
      const computed = window.getComputedStyle ? window.getComputedStyle(elem) : null;
      const currentTransform = computed && computed.transform !== "none"
        ? computed.transform : "translate3d(0,0,0)";
      ++weekMotionToken;
      if (weekMotion) {
        try { weekMotion.cancel(); } catch (e) {}
        weekMotion = null;
      }
      const baseX = presentationX(currentTransform);
      elem.style.transform = currentTransform;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dx: baseX,
        baseX,
        travelX: 0,
        intent: null,
        velocity: 0,
        lastX: event.clientX,
        lastTime: event.timeStamp || Date.now()
      };
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

  window.AthlevoTrainCalendar = { open, prevWeek, nextWeek, goToday, select, openModal, closeModal, VERSION: "train-calendar-v2" };
})();
