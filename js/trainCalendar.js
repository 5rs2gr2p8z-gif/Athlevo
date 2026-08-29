/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Date-First Training Calendar  (Train primary experience)
 *  v5 — Selected-day panel + sport-colored activity cards + stream graphs
 * ══════════════════════════════════════════════════════════════════════
 *
 *  PART 1: Compact calendar strip → ONE selected date's planned
 *  workout(s) and/or imported activities. Changing the selected date
 *  replaces the panel; it never appends other days.
 *
 *  PART 2: Activity cards are the primary tap target. Detail sheet:
 *  summary → coach analysis → real stream graphs → deeper metrics.
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
  function civilToday() {
    try {
      if (window.AthlevoCalendar && typeof window.AthlevoCalendar.localCivil === "function") {
        const tz = window.AthlevoCalendar.resolveTimezone(null);
        const c = window.AthlevoCalendar.localCivil(new Date(), tz);
        if (c && Number.isFinite(c.y)) return new Date(c.y, c.m - 1, c.d);
      }
    } catch (e) {}
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  const todayISO = () => iso(civilToday());

  function activityDateKey(activity) {
    const raw = activity && (activity.start_date || activity.start_date_local);
    if (!raw) return null;
    const instant = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(instant.getTime())) {
      const s = String(raw);
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
    }
    try {
      if (window.AthlevoCalendar && typeof window.AthlevoCalendar.localCivil === "function") {
        const tz = window.AthlevoCalendar.resolveTimezone(null);
        const c = window.AthlevoCalendar.localCivil(instant, tz);
        if (c && Number.isFinite(c.y)) return `${c.y}-${pad(c.m)}-${pad(c.d)}`;
      }
    } catch (e) {}
    return iso(instant);
  }
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
  const SPORT_THEME = {
    run: "run", ride: "ride", strength: "strength", swim: "swim",
    walk: "walk", hike: "walk", mobility: "other", cross_training: "other",
    rest: "other", other: "other"
  };
  const sportTheme = a => SPORT_THEME[canonSport(a)] || "other";

  /* ── data (read-only, RLS) ────────────────────────────────────────── */
  async function loadWeek(monday) {
    byDate = {}; actById = {};
    const start = iso(monday), end = iso(addDays(monday, 6));
    const actStart = iso(addDays(monday, -1)), actEnd = iso(addDays(monday, 7));
    let user = null;
    try { user = (await supabaseClient.auth.getUser()).data.user; } catch (e) {}
    if (!user) return;
    const base = table => supabaseClient.from(table).select("*").eq("user_id", user.id);

    const [sessRes, actRes] = await Promise.all([
      base("training_sessions").gte("session_date", start).lte("session_date", end),
      base("activities").gte("start_date", actStart + "T00:00:00").lte("start_date", actEnd + "T23:59:59.999")
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
      const d = activityDateKey(a);
      if (!d) return;
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
      html += `<button class="${cls.join(" ")}" type="button" data-date="${dISO}" aria-pressed="${dISO === selected ? "true" : "false"}">
        <span class="tc-dow">${DOW[i]}</span><span class="tc-num">${d.getDate()}</span><span class="tc-dot ${st || ""}"></span></button>`;
    }
    cal.innerHTML = html + `</div>`;
    bindCalendarInteractions(cal);
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
  function activityRpe(a, ex) {
    if (ex && num(ex.actual_rpe) > 0) return num(ex.actual_rpe);
    const raw = a && a.raw_data && typeof a.raw_data === "object" ? a.raw_data : {};
    if (num(raw.perceived_exertion) > 0) return num(raw.perceived_exertion);
    if (num(raw.icu_rpe) > 0) return num(raw.icu_rpe);
    if (num(raw.rpe) > 0) return num(raw.rpe);
    return null;
  }
  function strengthVolume(a) {
    const raw = a && a.raw_data && typeof a.raw_data === "object" ? a.raw_data : {};
    if (num(raw.total_volume_kg) > 0) return Math.round(raw.total_volume_kg) + " kg";
    if (num(raw.total_volume) > 0) return Math.round(raw.total_volume) + " kg";
    return null;
  }
  function activityPower(a) {
    const raw = a && a.raw_data && typeof a.raw_data === "object" ? a.raw_data : {};
    return num(raw.average_power_watts) || num(raw.average_watts) || num(raw.icu_average_watts) || null;
  }
  function cardMetricItems(a, ex) {
    const sport = canonSport(a);
    const items = [];
    const push = (label, value) => {
      if (value != null && value !== "" && value !== "—") items.push({ label, value: String(value) });
    };
    if (a.moving_time_seconds) push("Duration", fmtDuration(a.moving_time_seconds));
    if (sport === "strength" || sport === "mobility") {
      const load = activityLoad(a);
      if (load) push("Load", String(load));
      const vol = strengthVolume(a);
      if (vol) push("Volume", vol);
      return { sport, items };
    }
    if (a.distance_meters) push("Distance", (a.distance_meters / 1000).toFixed(1) + " km");
    if ((sport === "run" || sport === "walk" || sport === "hike") && a.distance_meters && a.moving_time_seconds) {
      push("Average pace", fmtPace(a.moving_time_seconds / (a.distance_meters / 1000)) + "/km");
    }
    if ((sport === "ride" || sport === "swim") && a.distance_meters && a.moving_time_seconds) {
      push("Average speed", ((a.distance_meters / a.moving_time_seconds) * 3.6).toFixed(1) + " km/h");
    }
    if (a.average_heartrate) push("HR", Math.round(a.average_heartrate) + " bpm");
    const load = activityLoad(a);
    if (load) push("Load", String(load));
    if (sport === "ride") {
      const pwr = activityPower(a);
      if (pwr > 0) push("Average power", Math.round(pwr) + " W");
    }
    const rpe = activityRpe(a, ex);
    if (rpe) push("RPE", String(rpe));
    if (a.elevation_gain_meters && sport !== "ride") push("Elev", Math.round(a.elevation_gain_meters) + " m");
    if (a.average_cadence && (sport === "run" || sport === "ride")) {
      push("Cadence", Math.round(a.average_cadence) + (sport === "ride" ? " rpm" : " spm"));
    }
    return { sport, items };
  }
  function activityMetrics(a) {
    return cardMetricItems(a).items.map(i => i.value).join(" · ");
  }
  function matchedPlanNote(session) {
    if (!session) return "";
    const sType = typeof formatSessionType === "function"
      ? formatSessionType(session.session_type)
      : String(session.session_type || "").replace(/[_-]+/g, " ");
    const title = (session.title && String(session.title).trim()) || sType;
    if (title) return `<span class="af-card-plan">Planned: ${esc(title)}</span>`;
    return `<span class="af-card-plan">Completed as planned</span>`;
  }

  /* ── completed-card mini profile (real laps / segments / cached streams) */
  function storedRecognition(a) {
    if (window.AthlevoCoach && typeof AthlevoCoach.getStoredRecognition === "function") {
      return AthlevoCoach.getStoredRecognition(a);
    }
    const r = a && ((a.raw_data && a.raw_data.recognition) || a.recognition) || null;
    return r && r.workoutType ? r : null;
  }
  function lapList(a) {
    const raw = a && a.raw_data && typeof a.raw_data === "object" ? a.raw_data : {};
    const laps = raw.laps || raw.splits || a.laps || a.splits;
    return Array.isArray(laps) ? laps : [];
  }
  function lapDistanceM(lap) {
    const d = num(lap && (lap.distance_meters || lap.distance));
    return d > 0 ? d : null;
  }
  function lapTimeSec(lap) {
    const t = num(lap && (lap.moving_time_seconds || lap.moving_time || lap.elapsed_time || lap.time_seconds));
    return t > 0 ? t : null;
  }
  function expandWeighted(points) {
    const usable = (points || []).filter(p => p && Number.isFinite(p.value) && p.weight > 0);
    if (usable.length < 2) return null;
    const total = usable.reduce((s, p) => s + p.weight, 0);
    const out = [];
    usable.forEach(p => {
      const n = Math.max(2, Math.round((p.weight / total) * 72));
      for (let i = 0; i < n; i += 1) out.push(p.value);
    });
    return out.length >= 2 ? out : null;
  }
  function downsampleValues(values, cap) {
    if (!values || values.length <= cap) return values ? values.slice() : [];
    const step = Math.ceil(values.length / cap);
    const out = [];
    for (let i = 0; i < values.length; i += step) out.push(values[i]);
    return out;
  }
  function cachedStreamProfile(a, sport) {
    const AS = window.AthlevoActivityStreams;
    if (!AS) return null;
    const id = a && a.id != null ? String(a.id) : null;
    const streams = (id && AS.cacheGet(id)) || AS.streamsFromActivity(a);
    if (!AS.hasUsableStreams(streams)) return null;
    if (sport === "ride") {
      const power = AS.graphSeriesFor(streams, "power");
      if (power && power.filter(Number.isFinite).length >= 3) return { values: downsampleValues(power, 80), invert: false };
      if (streams.velocity && streams.velocity.filter(Number.isFinite).length >= 3) {
        return { values: downsampleValues(streams.velocity, 80), invert: false };
      }
      return null;
    }
    if (sport === "strength" || sport === "mobility") {
      const power = AS.graphSeriesFor(streams, "power");
      return power && power.filter(Number.isFinite).length >= 3
        ? { values: downsampleValues(power, 80), invert: false } : null;
    }
    const pace = AS.graphSeriesFor(streams, "pace");
    if (pace && pace.filter(Number.isFinite).length >= 3) return { values: downsampleValues(pace, 80), invert: true };
    if (streams.velocity && streams.velocity.filter(Number.isFinite).length >= 3) {
      return { values: downsampleValues(streams.velocity, 80), invert: false };
    }
    return null;
  }
  function lapProfileSeries(a, sport) {
    const laps = lapList(a);
    if (laps.length < 2) return null;
    if (sport === "ride") {
      const power = expandWeighted(laps.map(lap => ({
        value: num(lap.average_watts || lap.average_power_watts || lap.avg_watts),
        weight: lapTimeSec(lap) || 1
      })));
      if (power) return { values: power, invert: false };
      const speed = expandWeighted(laps.map(lap => {
        const dist = lapDistanceM(lap), time = lapTimeSec(lap);
        const spd = (dist > 0 && time > 0) ? dist / time : num(lap.average_speed);
        return { value: spd, weight: time || 1 };
      }));
      return speed ? { values: speed, invert: false } : null;
    }
    if (sport === "strength" || sport === "mobility") return null;
    const pace = expandWeighted(laps.map(lap => {
      const dist = lapDistanceM(lap), time = lapTimeSec(lap);
      let value = null;
      if (dist > 20 && time > 0) value = time / (dist / 1000);
      else if (num(lap.average_speed) > 0.3) value = 1000 / num(lap.average_speed);
      else value = num(lap.average_pace || lap.pace);
      return { value, weight: time || (dist > 0 ? dist : 1) };
    }));
    return pace ? { values: pace, invert: true } : null;
  }
  function segmentProfileSeries(a, sport) {
    if (sport === "strength" || sport === "mobility") return null;
    const rec = storedRecognition(a);
    const segs = rec && Array.isArray(rec.segments) ? rec.segments : [];
    const points = segs.map(s => {
      if (!s || !(Number(s.duration) > 0)) return null;
      let value = num(s.avgPace || s.pace || s.average_pace);
      if (!(value > 0) && Number(s.distance) > 20 && Number(s.duration) > 0) {
        value = Number(s.duration) / (Number(s.distance) / 1000);
      }
      return value > 0 ? { value, weight: Number(s.duration) } : null;
    }).filter(Boolean);
    const values = expandWeighted(points);
    return values ? { values, invert: true } : null;
  }
  function cardProfileSeries(a) {
    if (!a) return null;
    const sport = canonSport(a);
    return cachedStreamProfile(a, sport) || lapProfileSeries(a, sport) || segmentProfileSeries(a, sport);
  }
  function renderCardProfileSvg(values, invert) {
    const sampled = downsampleValues(values, 96);
    const finite = sampled.filter(v => Number.isFinite(v));
    if (finite.length < 2) return "";
    const W = 320, H = 48, PAD_X = 0, PAD_Y = 5;
    let min = Math.min.apply(null, finite), max = Math.max.apply(null, finite);
    if (max === min) { min -= 1; max += 1; }
    const range = max - min;
    const pts = [];
    sampled.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = PAD_X + (i / Math.max(1, sampled.length - 1)) * (W - 2 * PAD_X);
      const norm = (v - min) / range;
      const y = invert
        ? PAD_Y + norm * (H - 2 * PAD_Y)
        : H - PAD_Y - norm * (H - 2 * PAD_Y);
      pts.push(x.toFixed(1) + "," + y.toFixed(1));
    });
    if (pts.length < 2) return "";
    const line = "M" + pts.join("L");
    const fill = "M0," + H + "L" + pts.join("L") + "L" + W + "," + H + "Z";
    return `<svg class="af-card-profile-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${fill}" fill="currentColor" fill-opacity=".22"/>
      <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.75" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }
  function cardMiniProfile(a) {
    const series = cardProfileSeries(a);
    if (!series || !series.values) return "";
    const svg = renderCardProfileSvg(series.values, !!series.invert);
    if (!svg) return "";
    return `<div class="af-card-profile" aria-hidden="true">${svg}</div>`;
  }

  /* ── selected-day model (planned + imported for ONE date) ───────── */
  function buildSelectedDayModel(dISO, entry, todayKey) {
    const REST = new Set(["rest", "rest_day", "restday", "off", "day_off"]);
    const session = entry && entry.session ? entry.session : null;
    const execution = entry && entry.execution ? entry.execution : null;
    const activities = Array.isArray(entry && entry.activities) ? entry.activities.slice() : [];
    const type = String(session && session.session_type || "").toLowerCase().replace(/[\s-]+/g, "_");
    const rest = !!(session && REST.has(type));
    const completed = !!(execution && (execution.status === "completed" || execution.status === "modified"));
    const skipped = !!(execution && execution.status === "skipped");
    const past = !!(dISO && todayKey && dISO < todayKey);
    const future = !!(dISO && todayKey && dISO > todayKey);
    const matchedId = execution && execution.imported_activity_id != null
      ? String(execution.imported_activity_id) : null;
    const matchedActs = [];
    const unmatchedActs = [];
    activities.forEach(a => {
      if (matchedId && a && a.id != null && String(a.id) === matchedId) matchedActs.push(a);
      else unmatchedActs.push(a);
    });
    if (completed && !matchedId && unmatchedActs.length === 1 && !matchedActs.length) {
      matchedActs.push(unmatchedActs.shift());
    }
    const hasActs = activities.length > 0;
    const missed = !!(session && !rest && past && !completed && !skipped && !hasActs);
    const showPlan = !!(session && !rest && (
      missed ||
      skipped ||
      (!completed && !hasActs) ||
      (!completed && hasActs) ||
      (completed && !matchedActs.length)
    ));
    return {
      date: dISO,
      session,
      execution,
      rest,
      empty: !session && !hasActs,
      missed,
      skipped,
      completed,
      past,
      future,
      showPlan,
      activities,
      matchedActs,
      unmatchedActs
    };
  }

  function plannedCardHtml(model) {
    const s = model.session;
    const sType = typeof formatSessionType === "function"
      ? formatSessionType(s.session_type)
      : String(s.session_type || "Workout").replace(/[_-]+/g, " ");
    const title = (s.title && String(s.title).trim()) || sType;
    const intensity = s.intensity
      ? String(s.intensity).replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      : "";
    const sub = [title !== sType ? sType : null, intensity].filter(Boolean).join(" · ");
    const meta = [];
    if (num(s.duration_minutes) > 0) meta.push(Math.round(s.duration_minutes) + " min");
    if (num(s.distance_km) > 0) {
      const km = Number(s.distance_km);
      meta.push((Number.isInteger(km) ? String(km) : String(km)) + " km");
    }
    if (s.target_rpe) meta.push("RPE " + s.target_rpe);
    else if (s.pace_guidance) meta.push(s.pace_guidance);
    const badge = model.missed
      ? `<span class="af-card-status af-card-status--missed">Missed</span>`
      : model.skipped
        ? `<span class="af-card-status af-card-status--missed">Not completed</span>`
        : `<span class="af-card-cta">View plan</span>`;
    const cls = ["af-card", "af-card--planned"];
    if (model.missed || model.skipped) cls.push("af-card--missed");
    return `<button type="button" class="${cls.join(" ")}" data-train-item="plan" onclick="AthlevoTrainCalendar.openModal('${model.date}')">
      <div class="af-card-main">
        <div class="af-card-top">
          ${SPORT_ICON.run}
          <div class="af-card-titles">
            <span class="af-card-sport af-card-sport--planned">Planned</span>
            <span class="af-card-name">${esc(title)}</span>
            ${sub ? `<span class="af-card-source">${esc(sub)}</span>` : ""}
          </div>
          ${badge}
        </div>
        ${meta.length ? `<span class="af-card-meta">${esc(meta.join(" · "))}</span>` : ""}
      </div>
    </button>`;
  }

  function activityCardHtml(a, dISO, opts) {
    const done = !!(opts && opts.done);
    const session = opts && opts.session;
    const ex = opts && opts.execution;
    const theme = sportTheme(a);
    const name = sportLabel(a);
    const source = a.name && a.name !== name ? a.name : null;
    const packed = cardMetricItems(a, ex);
    const profile = cardMiniProfile(a);
    const id = a && a.id != null ? String(a.id) : "";
    const grid = packed.items.slice(0, 8).map(i =>
      `<span class="af-card-metric"><b>${esc(i.value)}</b><small>${esc(i.label)}</small></span>`
    ).join("");
    const planNote = done ? matchedPlanNote(session) : "";
    return `<button type="button" class="af-card af-card--activity af-card--${theme}${done ? " af-card--done" : ""}${profile ? " af-card--has-profile" : ""}" data-train-item="activity" data-activity-id="${esc(id)}" onclick="AthlevoTrainCalendar.openModal('${dISO}','${esc(id)}')">
      <span class="af-card-accent" aria-hidden="true"></span>
      <div class="af-card-main">
        <div class="af-card-top">
          ${sportIcon(a)}
          <div class="af-card-titles">
            <span class="af-card-sport">${esc(name)}</span>
            ${source ? `<span class="af-card-name">${esc(source)}</span>` : ""}
          </div>
          <span class="af-card-chevron" aria-hidden="true">›</span>
        </div>
        ${grid ? `<div class="af-card-grid">${grid}</div>` : ""}
        ${planNote}
        ${profile}
      </div>
    </button>`;
  }

  function renderSelectedDayHtml(model) {
    const dISO = model.date;
    const tISO = todayISO();
    const isToday = dISO === tISO;
    const dayLabel = isToday ? "Today" : fmtDayHeader(dISO);
    let html = `<div class="af-day" data-train-day="${esc(dISO)}">`;
    html += `<div class="af-day-head"><span class="af-day-label${isToday ? " af-today" : ""}">${esc(dayLabel)}</span>`;
    if (isToday) html += `<span class="af-day-date">${esc(fmtDayHeader(dISO))}</span>`;
    html += `</div>`;

    if (model.empty) {
      html += `<p class="af-day-empty">${model.rest ? "Rest day" : "No training scheduled"}</p></div>`;
      return html;
    }

    if (model.rest && !model.activities.length) {
      html += `<div class="af-card af-card--rest" data-train-item="rest">
        <div class="af-card-body">
          <span class="af-card-name">Rest day</span>
          <span class="af-card-meta">Recovery is part of the plan</span>
        </div>
      </div></div>`;
      return html;
    }

    const showSections = model.showPlan && model.activities.length > 0;
    if (model.showPlan) {
      if (showSections) html += `<div class="af-section-label">Planned</div>`;
      html += plannedCardHtml(model);
    }
    if (model.activities.length) {
      if (showSections) html += `<div class="af-section-label">Completed</div>`;
      const matchedIds = new Set(model.matchedActs.map(a => a && a.id != null ? String(a.id) : ""));
      model.activities.forEach(a => {
        const done = model.completed && a && a.id != null && matchedIds.has(String(a.id));
        html += activityCardHtml(a, dISO, {
          done,
          session: done ? model.session : null,
          execution: done ? model.execution : null
        });
      });
    }
    html += `</div>`;
    return html;
  }

  /* ── selected-day panel (never a multi-day feed) ────────────────── */
  function renderActivityFeed() {
    const el = document.getElementById("trainDayPanel");
    if (!el) return;
    if (!selected) selected = todayISO();
    const model = buildSelectedDayModel(selected, byDate[selected] || { activities: [] }, todayISO());
    el.innerHTML = renderSelectedDayHtml(model);
    el.dataset.selectedDay = selected;
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
    _openModalToken += 1;
    const modalToken = _openModalToken;

    let html = "";

    /* ── TOP: Activity header ──────────────────────────────────────── */
    if (act) {
      const sport = canonSport(act);
      const name = sportLabel(act);
      const source = act.name && act.name !== name ? act.name : null;
      const device = (act.raw_data && act.raw_data.device_name) || null;
      const dateStr = fmtDayHeader(dISO);
      const startTime = act.start_date ? new Date(act.start_date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;

      html += `<button type="button" class="ad-back" onclick="AthlevoTrainCalendar.closeModal()">Back</button>`;
      html += `<div class="ad-header ad-header--${sportTheme(act)}">
        <div class="ad-header-top">
          ${sportIcon(act)}
          <div class="ad-header-info">
            <h2 class="ad-title">${esc(source || name)}</h2>
            <span class="ad-source">${esc(name)}</span>
          </div>
        </div>
        <div class="ad-header-meta">
          <span>${esc(dateStr)}${startTime ? " · " + esc(startTime) : ""}</span>
          ${device ? `<span>${esc(device)}</span>` : ""}
        </div>
      </div>`;

      html += renderDetailSummary(act, ex, sport);

      const recognition = (window.AthlevoCoach && AthlevoCoach.getStoredRecognition)
        ? AthlevoCoach.getStoredRecognition(act) : null;

      html += renderCoachSection(act, recognition, s);
      html += `<div id="ad-charts-root" class="ad-charts-root" data-activity-id="${esc(act.id != null ? String(act.id) : "")}"></div>`;

      if (recognition) {
        _wsvSegments = normalizeSegments(recognition, act);
        if (_wsvSegments.length > 0) {
          html += `<div class="ad-section">`;
          html += `<div class="ad-section-h">Workout Structure</div>`;
          try {
            html += (window.WorkoutStructureView && WorkoutStructureView.render)
              ? WorkoutStructureView.render(_wsvSegments)
              : "";
          } catch (e) {
            html += `<p class="ad-empty">Workout structure unavailable.</p>`;
          }
          html += `</div>`;
        }

        html += `<div class="ad-section ad-classification">`;
        html += `<div class="ad-class-row">
          <span class="ad-class-type">${esc(AthlevoCoach.displayType ? AthlevoCoach.displayType(recognition.workoutType) : recognition.workoutType)}</span>
          <span class="ad-class-conf ${recognition.confidenceLabel === "High" ? "high" : ""}">${esc(recognition.confidenceLabel || "")}</span>
        </div>`;
        html += `</div>`;
      }

      html += renderHRZones(act);
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
    if (act) loadActivityCharts(act, modalToken);
  }

  let _openModalToken = 0;
  async function loadActivityCharts(act, token) {
    const root = document.getElementById("ad-charts-root");
    if (!root || !window.AthlevoActivityStreams) return;
    const AS = window.AthlevoActivityStreams;
    const sport = canonSport(act);
    const stored = AS.streamsFromActivity(act);
    if (AS.hasUsableStreams(stored)) {
      AS.renderInto(root, stored, sport);
      return;
    }
    root.innerHTML = `<p class="ad-chart-loading">Loading graphs…</p>`;
    let streams = null;
    try { streams = await AS.loadStreams(act); } catch (e) { streams = null; }
    if (token !== _openModalToken) return;
    if (!AS.renderInto(root, streams, sport)) root.innerHTML = "";
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
    if ((sport === "run" || sport === "walk" || sport === "hike") && act.distance_meters && act.moving_time_seconds) {
      const paceSec = act.moving_time_seconds / (act.distance_meters / 1000);
      items.push({ label: "Average pace", value: fmtPace(paceSec), unit: "/km" });
    }
    if ((sport === "ride" || sport === "swim") && act.distance_meters && act.moving_time_seconds) {
      items.push({ label: "Average speed", value: ((act.distance_meters / act.moving_time_seconds) * 3.6).toFixed(1), unit: "km/h" });
    }
    if (act.average_heartrate) {
      items.push({ label: "Average HR", value: Math.round(act.average_heartrate), unit: "bpm" });
    }
    if (act.max_heartrate) {
      items.push({ label: "Max HR", value: Math.round(act.max_heartrate), unit: "bpm" });
    }
    const load = activityLoad(act);
    if (load) items.push({ label: "Load", value: load, unit: "" });
    const rpe = activityRpe(act, ex);
    if (rpe) items.push({ label: "RPE", value: rpe, unit: "/10" });
    if (act.average_cadence) {
      items.push({ label: "Cadence", value: Math.round(act.average_cadence), unit: sport === "ride" ? "rpm" : "spm" });
    }
    if (act.elevation_gain_meters && sport !== "strength" && sport !== "mobility") {
      items.push({ label: "Elevation", value: Math.round(act.elevation_gain_meters), unit: "m" });
    }
    const pwr = activityPower(act);
    if (pwr > 0) items.push({ label: "Average power", value: Math.round(pwr), unit: "W" });
    if (sport === "strength" || sport === "mobility") {
      items.push({ label: "Category", value: sportLabel(act), unit: "" });
    }
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

  /* ── Detail: Chart sections (real streams only) ── */
  function renderChartSections(act, sport) {
    if (!window.AthlevoActivityStreams) return "";
    const streams = window.AthlevoActivityStreams.streamsFromActivity(act);
    if (!window.AthlevoActivityStreams.hasUsableStreams(streams)) return "";
    return window.AthlevoActivityStreams.renderStackedCharts(streams, sport);
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
  async function goToday() { interruptWeekMotion(); selected = todayISO(); await goToWeek(mondayOf(civilToday()), null); selected = todayISO(); render(); }
  function keepSelectedDayInView() {
    const screen = document.getElementById("screen-train");
    const cal = document.getElementById("trainCalendar");
    if (!screen || !cal) return;
    const top = cal.offsetTop;
    if (screen.scrollTop > top + cal.offsetHeight) screen.scrollTop = Math.max(0, top);
  }
  function isDateKey(dISO) {
    return typeof dISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dISO);
  }
  function select(dISO) {
    if (!isDateKey(dISO)) return;
    selected = dISO;
    render();
    keepSelectedDayInView();
    const activeDay = document.querySelector("#trainCalendar .tc-day.sel");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (activeDay && !reduce && typeof activeDay.animate === "function") {
      activeDay.animate([{ transform: "scale(.965)" }, { transform: "scale(1)" }], { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
  }
  function bindCalendarInteractions(cal) {
    if (!cal) return;
    if (!cal._tcClick) {
      cal._tcClick = true;
      cal.addEventListener("click", event => {
        if (event.target.closest && event.target.closest(".tc-nav")) return;
        const day = event.target.closest ? event.target.closest(".tc-day") : null;
        if (!day || (cal.contains && !cal.contains(day))) return;
        const dISO = day.getAttribute && day.getAttribute("data-date");
        if (!dISO) return;
        if (event.preventDefault) event.preventDefault();
        select(dISO);
      });
    }
    attachSwipe(cal);
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
      if (!gesture.captured) {
        try { elem.setPointerCapture(event.pointerId); } catch (e) {}
        gesture.captured = true;
      }
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
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: baseX, baseX, travelX: 0, intent: null, velocity: 0, lastX: event.clientX, lastTime: event.timeStamp || Date.now(), captured: false };
      elem.addEventListener("pointermove", move, { passive: false });
      elem.addEventListener("pointerup", end);
      elem.addEventListener("pointercancel", cancel);
    });
  }

  async function open(planData) {
    hasAnyPlan = !!(planData && planData.hasPlan);
    selected = todayISO(); weekStart = mondayOf(civilToday());
    render();
    await loadWeek(weekStart);
    render();
  }
  function hydrate(monday, selectedISO, map) {
    weekStart = monday instanceof Date ? monday : mondayOf(civilToday());
    selected = isDateKey(selectedISO) ? selectedISO : todayISO();
    byDate = map && typeof map === "object" ? map : {};
    render();
  }
  function getSelectedDate() { return selected; }

  window.AthlevoTrainCalendar = {
    open, prevWeek, nextWeek, goToday, select, openModal, closeModal, askCoach,
    activityDateKey, buildSelectedDayModel, cardMetricItems, sportTheme,
    activityCardHtml, plannedCardHtml, renderSelectedDayHtml,
    cardMiniProfile, cardProfileSeries,
    hydrate, getSelectedDate,
    VERSION: "train-calendar-v7"
  };
})();
