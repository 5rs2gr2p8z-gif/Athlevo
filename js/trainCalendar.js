/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Date-First Training Calendar  (Train primary experience)
 *  v8 — Scannable selected-day cards + tightly stacked detail graphs
 * ══════════════════════════════════════════════════════════════════════
 *
 *  PART 1: Compact calendar strip → ONE selected date's planned
 *  workout(s) and/or imported activities. Changing the selected date
 *  replaces the panel; it never appends other days.
 *
 *  PART 2: Activity cards are the primary tap target. Detail sheet:
 *  compact metrics → one coach line → splits strip → stacked graphs.
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
    run: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="14" cy="4" r="2"/><path d="M8 21l2.4-6.5M16.5 21l-1.5-5.5M6.5 11.5l3-2.5 2.5 2.5 4-4.5"/></svg>`,
    ride: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="17" r="3"/><circle cx="17.5" cy="17" r="3"/><path d="M6.5 17l3.5-11h3l2 4h3"/><path d="M10 10l3 7"/></svg>`,
    strength: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 5v14M17.5 5v14M3 8h3.5M17.5 8h3.5M3 16h3.5M17.5 16h3.5M6.5 8h11M6.5 16h11"/></svg>`,
    swim: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0"/><path d="M2 14c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0"/><circle cx="10.5" cy="6" r="2"/><path d="M16 11l-5.5-2-3.5 2"/></svg>`,
    walk: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M10 21l1.5-7M16 21l-1.5-5.5M10.5 11l1-3 3 2"/></svg>`,
    hike: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M10 21l1.5-7M16 21l-1.5-5.5M10.5 11l1-3 3 2"/><line x1="7" y1="6" x2="7" y2="21"/><path d="M7 6l3 2"/></svg>`,
    mobility: `<svg class="af-sport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M9 21l1.5-5M15 21l-1.5-5M9 12c0-2 1.5-3 3-3s3 1 3 3c0 1.5-1.5 3.5-3 5.5-1.5-2-3-4-3-5.5z"/></svg>`
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
    clearTrainExtras();
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
    return rm > 0 ? `${h}h${rm}m` : `${h}h`;
  }
  function fmtSplitClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
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
    const lines = [];
    const push = (label, value) => {
      if (value != null && value !== "" && value !== "—") items.push({ label, value: String(value) });
    };
    const line = (...parts) => {
      const clean = parts.filter(v => v != null && v !== "" && v !== "—");
      if (clean.length) lines.push(clean.join(" · "));
    };

    const dist = (a.distance_meters && sport !== "strength" && sport !== "mobility")
      ? (a.distance_meters / 1000).toFixed(1) + " km" : null;
    const dur = a.moving_time_seconds ? fmtDuration(a.moving_time_seconds) : null;
    const loadVal = activityLoad(a);
    const load = loadVal ? "Load " + loadVal : null;
    const rpeVal = activityRpe(a, ex);
    const rpe = rpeVal ? "RPE " + rpeVal : null;
    const hr = a.average_heartrate ? Math.round(a.average_heartrate) + " bpm" : null;

    if (sport === "strength" || sport === "mobility") {
      if (dur) push("Duration", dur);
      if (loadVal) push("Load", String(loadVal));
      const vol = strengthVolume(a);
      if (vol) push("Volume", vol);
      line(dur, load);
      if (vol) lines.push(vol);
      return { sport, items, lines };
    }

    if (dist) push("Distance", dist);
    if (dur) push("Duration", dur);
    line(dist, dur);

    if (sport === "ride") {
      const spd = (a.distance_meters && a.moving_time_seconds)
        ? ((a.distance_meters / a.moving_time_seconds) * 3.6).toFixed(1) + " km/h" : null;
      if (spd) push("Average speed", spd);
      if (hr) push("HR", hr);
      line(spd, hr);
      const pwrVal = activityPower(a);
      const pwr = pwrVal > 0 ? Math.round(pwrVal) + " W" : null;
      if (pwr) push("Average power", pwr);
      if (loadVal) push("Load", String(loadVal));
      line(load, pwr);
      return { sport, items, lines };
    }

    let pace = null;
    if (a.distance_meters && a.moving_time_seconds) {
      if (sport === "swim") {
        pace = fmtPace(a.moving_time_seconds / (a.distance_meters / 100)) + "/100m";
      } else if (sport === "run" || sport === "walk" || sport === "hike") {
        pace = fmtPace(a.moving_time_seconds / (a.distance_meters / 1000)) + "/km";
      }
      if (pace) push("Average pace", pace);
    }
    if (hr) push("HR", hr);
    line(pace, hr);
    if (loadVal) push("Load", String(loadVal));
    if (rpeVal) push("RPE", String(rpeVal));
    line(load, rpe);
    return { sport, items, lines };
  }
  function activityMetrics(a) {
    const packed = cardMetricItems(a);
    return (packed.lines && packed.lines.length ? packed.lines : packed.items.map(i => i.value)).join(" · ");
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
    const W = 320, H = 50, PAD_X = 0, PAD_Y = 4;
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
      <path d="${fill}" fill="currentColor" fill-opacity=".32"/>
      <path d="${line}" fill="none" stroke="currentColor" stroke-width="2.25" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }
  function cardMiniProfile(a) {
    const series = cardProfileSeries(a);
    if (!series || !series.values) return "";
    const svg = renderCardProfileSvg(series.values, !!series.invert);
    if (!svg) return "";
    return `<div class="af-card-profile" aria-hidden="true">${svg}</div>`;
  }

  /* ── Segmented workout strip for completed activity cards ────────── */
  /*
   * Builds a horizontal segmented strip: red = work, gray = easy/recovery.
   * Segment widths are proportional to duration. Heights vary slightly by
   * relative intensity. Uses real data in priority order:
   *   1. Recognition segments (kind: warmup/work/recovery/cooldown/steady)
   *   2. Lap data with pace-based classification
   *   3. Single block fallback from activity summary
   */
  function classifyLapIntensity(lap, medianPace) {
    const dist = lapDistanceM(lap), time = lapTimeSec(lap);
    if (!dist || !time || dist < 20) return "easy";
    const pace = time / (dist / 1000);
    // If pace is > 8% faster than median, it's work
    if (medianPace && pace < medianPace * 0.92) return "work";
    return "easy";
  }

  function stripSegmentsFromRecognition(a) {
    const rec = storedRecognition(a);
    if (!rec || !Array.isArray(rec.segments)) return null;
    const segs = rec.segments.filter(s => s && Number(s.duration) > 0);
    const structured = segs.filter(s => s.kind && s.kind !== "steady");
    if (structured.length < 1) {
      // Single steady segment — use it but don't fabricate structure
      if (segs.length === 1) return [{
        duration: Number(segs[0].duration),
        intensity: "easy",
        relativeEffort: 0.4
      }];
      return null;
    }
    return structured.map(s => {
      const isWork = s.kind === "work";
      const isRecovery = s.kind === "recovery" || s.kind === "cooldown" || s.kind === "warmup";
      return {
        duration: Number(s.duration),
        intensity: isWork ? "work" : "easy",
        relativeEffort: isWork ? 0.85 : (s.kind === "warmup" || s.kind === "cooldown" ? 0.4 : 0.3)
      };
    });
  }

  function stripSegmentsFromLaps(a) {
    const sport = canonSport(a);
    if (sport === "strength" || sport === "mobility") return null;
    const laps = lapList(a);
    if (laps.length < 2) return null;
    // Compute median pace for classification
    const paces = laps.map(lap => {
      const dist = lapDistanceM(lap), time = lapTimeSec(lap);
      return (dist && dist > 20 && time) ? time / (dist / 1000) : null;
    }).filter(p => p != null).sort((a, b) => a - b);
    const medianPace = paces.length ? paces[Math.floor(paces.length / 2)] : null;
    // Check if there's meaningful variation (>8% spread between fast and slow quartile)
    const hasMeaningfulVariation = paces.length >= 3 &&
      (paces[Math.floor(paces.length * 0.75)] - paces[Math.floor(paces.length * 0.25)]) >
      paces[Math.floor(paces.length * 0.25)] * 0.08;

    return laps.map(lap => {
      const time = lapTimeSec(lap) || 60;
      let intensity = "easy";
      let effort = 0.4;
      if (hasMeaningfulVariation) {
        intensity = classifyLapIntensity(lap, medianPace);
        if (intensity === "work") effort = 0.85;
      }
      return { duration: time, intensity, relativeEffort: effort };
    }).filter(s => s.duration > 0);
  }

  function stripSegmentsFromSummary(a) {
    const sport = canonSport(a);
    const dur = num(a.moving_time_seconds) || num(a.elapsed_time_seconds);
    if (!dur || dur <= 0) return null;
    // For strength / mobility, return a neutral single block
    if (sport === "strength" || sport === "mobility") {
      return [{ duration: dur, intensity: "neutral", relativeEffort: 0.5 }];
    }
    // Check recognition for workout type to determine if this was quality
    const rec = storedRecognition(a);
    const type = rec && rec.workoutType ? rec.workoutType : "";
    const isQuality = /Threshold|VO2|Interval|Tempo|Repetition|Hill|Speed|Race|Time Trial/i.test(type);
    return [{
      duration: dur,
      intensity: isQuality ? "work" : "easy",
      relativeEffort: isQuality ? 0.7 : 0.4
    }];
  }

  function buildStripSegments(a) {
    return stripSegmentsFromRecognition(a)
      || stripSegmentsFromLaps(a)
      || stripSegmentsFromSummary(a)
      || [];
  }

  function cardWorkoutStrip(a) {
    if (!a) return "";
    const sport = canonSport(a);
    const segments = buildStripSegments(a);
    if (!segments.length) return "";
    const totalDur = segments.reduce((s, seg) => s + seg.duration, 0);
    if (totalDur <= 0) return "";

    const blocks = segments.map(seg => {
      const widthPct = (seg.duration / totalDur) * 100;
      // Height: 24px base, up to 38px for max effort
      const minH = 20, maxH = 36;
      const h = Math.round(minH + (seg.relativeEffort || 0.4) * (maxH - minH));
      let cls = "af-strip-seg";
      if (seg.intensity === "work") cls += " af-strip-seg--work";
      else if (seg.intensity === "neutral") cls += " af-strip-seg--neutral";
      else cls += " af-strip-seg--easy";
      return `<div class="${cls}" style="flex-basis:${widthPct.toFixed(2)}%;height:${h}px" aria-hidden="true"></div>`;
    }).join("");

    return `<div class="af-card-strip" aria-label="Workout structure" aria-hidden="true">${blocks}</div>`;
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

  /* ── Planned workout structure strip ─────────────────────────────── */
  /*
   * Builds a visual representation of the PRESCRIBED workout structure.
   * Uses real session data: warmup[], main_set[], cooldown[] arrays,
   * duration_minutes, session_type, and recognized structure patterns.
   * Priority: 1) explicit structured steps  2) session-type heuristic
   *           3) single neutral block fallback
   */
  function parsePrescribedDuration(text) {
    if (!text || typeof text !== "string") return null;
    // "15 min warm-up" → 15*60, "8:00 threshold" → 480, "2km recovery" → ~600
    const minMatch = text.match(/(\d+)\s*(?:min|minutes?|m\b)/i);
    if (minMatch) return Number(minMatch[1]) * 60;
    const clockMatch = text.match(/(\d{1,2}):(\d{2})/);
    if (clockMatch) return Number(clockMatch[1]) * 60 + Number(clockMatch[2]);
    const secMatch = text.match(/(\d+)\s*(?:sec|seconds?|s\b)/i);
    if (secMatch) return Number(secMatch[1]);
    const kmMatch = text.match(/(\d+(?:\.\d+)?)\s*km/i);
    if (kmMatch) return Math.round(Number(kmMatch[1]) * 300); // ~5min/km estimate
    return null;
  }

  function parsePrescribedKind(text, sectionHint) {
    if (!text || typeof text !== "string") return sectionHint || "steady";
    const t = text.toLowerCase();
    if (/warm/i.test(t)) return "warmup";
    if (/cool/i.test(t)) return "cooldown";
    if (/recovery|jog|rest|walk/i.test(t)) return "recovery";
    if (QUALITY_RE.test(t)) return "work";
    if (/easy|steady|aerobic|endurance|long/i.test(t)) return "steady";
    return sectionHint || "steady";
  }

  function extractRepetitions(items) {
    // Parse "3 × 8 min threshold / 2 min recovery" patterns from main_set
    const segments = [];
    items.forEach(text => {
      if (!text || typeof text !== "string") return;
      // Check for repetition pattern: "3x8min threshold w/ 2min rest"
      const repMatch = text.match(/(\d+)\s*[x×]\s*(.*)/i);
      if (repMatch) {
        const reps = Number(repMatch[1]);
        const rest = repMatch[2];
        // Try to split work/recovery from the rest text
        const parts = rest.split(/\s*(?:w(?:\/|ith)|\+|,|\/)\s*/i);
        const workText = parts[0] || rest;
        const recText = parts[1] || null;
        const workDur = parsePrescribedDuration(workText) || 300;
        const recDur = recText ? (parsePrescribedDuration(recText) || 120) : 120;
        for (let i = 0; i < Math.min(reps, 12); i++) {
          segments.push({ kind: "work", duration: workDur, text: workText });
          if (i < reps - 1 && recDur > 0) {
            segments.push({ kind: "recovery", duration: recDur, text: recText || "Recovery" });
          }
        }
        return;
      }
      // Single item
      const kind = parsePrescribedKind(text, "work");
      const dur = parsePrescribedDuration(text) || 300;
      segments.push({ kind, duration: dur, text });
    });
    return segments;
  }

  function buildPlannedStripSegments(session) {
    if (!session) return [];
    const type = String(session.session_type || "").toLowerCase();
    const REST_TYPES = new Set(["rest", "rest_day", "off", "day_off"]);
    if (REST_TYPES.has(type.replace(/[\s-]+/g, "_"))) return [];

    const warmup = Array.isArray(session.warmup) ? session.warmup.filter(Boolean) : [];
    const mainSet = Array.isArray(session.main_set) ? session.main_set.filter(Boolean) : [];
    const cooldown = Array.isArray(session.cooldown) ? session.cooldown.filter(Boolean) : [];
    const hasStructure = warmup.length > 0 || mainSet.length > 0 || cooldown.length > 0;

    if (hasStructure) {
      const segments = [];
      // Warmup
      warmup.forEach(text => {
        const dur = parsePrescribedDuration(text) || (num(session.duration_minutes) ? Math.round(num(session.duration_minutes) * 60 * 0.15) : 600);
        segments.push({ kind: "warmup", duration: dur });
      });
      // Main set — may contain repetitions
      const mainSegments = extractRepetitions(mainSet);
      if (mainSegments.length > 0) {
        segments.push(...mainSegments);
      } else {
        mainSet.forEach(text => {
          const kind = parsePrescribedKind(text, "work");
          const dur = parsePrescribedDuration(text) || 600;
          segments.push({ kind, duration: dur });
        });
      }
      // Cooldown
      cooldown.forEach(text => {
        const dur = parsePrescribedDuration(text) || (num(session.duration_minutes) ? Math.round(num(session.duration_minutes) * 60 * 0.1) : 300);
        segments.push({ kind: "cooldown", duration: dur });
      });
      return segments.filter(s => s.duration > 0);
    }

    // Fallback: use session_type + total duration to create simple block(s)
    const totalSec = (num(session.duration_minutes) || 45) * 60;
    const isQualitySession = QUALITY_RE.test(type);

    if (isQualitySession) {
      // Inferred structure: warmup 15% + work 70% + cooldown 15%
      const warmSec = Math.round(totalSec * 0.15);
      const coolSec = Math.round(totalSec * 0.15);
      const workSec = totalSec - warmSec - coolSec;
      return [
        { kind: "warmup", duration: warmSec },
        { kind: "work", duration: workSec },
        { kind: "cooldown", duration: coolSec }
      ];
    }

    // Simple single block for easy/long/steady runs
    return [{ kind: "steady", duration: totalSec }];
  }

  function plannedWorkoutStrip(session) {
    const segments = buildPlannedStripSegments(session);
    if (!segments.length) return "";
    const totalDur = segments.reduce((s, seg) => s + seg.duration, 0);
    if (totalDur <= 0) return "";

    const KIND_TO_CLS = {
      work: "af-pstrip-seg--work",
      warmup: "af-pstrip-seg--warm",
      recovery: "af-pstrip-seg--recovery",
      cooldown: "af-pstrip-seg--cool",
      steady: "af-pstrip-seg--steady"
    };

    const blocks = segments.map(seg => {
      const widthPct = (seg.duration / totalDur) * 100;
      const cls = "af-pstrip-seg " + (KIND_TO_CLS[seg.kind] || "af-pstrip-seg--steady");
      return `<div class="${cls}" style="flex-basis:${widthPct.toFixed(2)}%" aria-hidden="true"></div>`;
    }).join("");

    return `<div class="af-pstrip" aria-label="Planned workout structure" aria-hidden="true">${blocks}</div>`;
  }

  function plannedCardSportIcon(session) {
    // Determine sport from session type
    const type = String(session.session_type || "").toLowerCase();
    if (/strength|weight|gym/i.test(type)) return SPORT_ICON.strength;
    if (/ride|bike|cycl/i.test(type)) return SPORT_ICON.ride;
    if (/swim/i.test(type)) return SPORT_ICON.swim;
    if (/walk/i.test(type)) return SPORT_ICON.walk;
    if (/hike/i.test(type)) return SPORT_ICON.hike;
    if (/mobil|yoga|stretch|flex/i.test(type)) return SPORT_ICON.mobility;
    return SPORT_ICON.run;
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
    const strip = plannedWorkoutStrip(s);
    return `<button type="button" class="${cls.join(" ")}" data-train-item="plan" onclick="AthlevoTrainCalendar.openModal('${model.date}')">
      <div class="af-card-main">
        <div class="af-card-top">
          ${plannedCardSportIcon(s)}
          <div class="af-card-titles">
            <span class="af-card-sport af-card-sport--planned">Planned</span>
            <span class="af-card-name">${esc(title)}</span>
            ${sub ? `<span class="af-card-source">${esc(sub)}</span>` : ""}
          </div>
          ${badge}
        </div>
        ${strip}
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
    const strip = cardWorkoutStrip(a);
    const id = a && a.id != null ? String(a.id) : "";
    const planNote = done ? matchedPlanNote(session) : "";
    // Device / source line
    const deviceName = a.device_name || (a.raw_data && a.raw_data.device_name) || null;
    const sourceApp = a.source || (a.raw_data && a.raw_data.source) || null;
    const deviceLine = [deviceName, sourceApp].filter(Boolean).join(" · ");
    // Metric values inline — no big labels
    const metricValues = (packed.items || []).slice(0, 5).map(
      item => `<span class="af-card-metric-val">${esc(item.value)}</span>`
    ).join("");
    return `<button type="button" class="af-card af-card--activity af-card--premium af-card--${theme}${done ? " af-card--done" : ""}${strip ? " af-card--has-strip" : ""}" data-train-item="activity" data-activity-id="${esc(id)}" onclick="AthlevoTrainCalendar.openModal('${dISO}','${esc(id)}')">
      <div class="af-card-main">
        <div class="af-card-top">
          ${sportIcon(a)}
          <div class="af-card-titles">
            <span class="af-card-sport">${esc(name)}</span>
            ${source ? `<span class="af-card-name">${esc(source)}</span>` : ""}
            ${deviceLine ? `<span class="af-card-device">${esc(deviceLine)}</span>` : ""}
          </div>
          <span class="af-card-chevron" aria-hidden="true">›</span>
        </div>
        ${strip}
        ${metricValues ? `<div class="af-card-metrics-row">${metricValues}</div>` : ""}
        ${planNote}
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

  function clearTrainExtras() {
    ["trainWeekProgress", "trainContext"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
  }
  function renderWeekProgress() { clearTrainExtras(); }
  function renderContext() { clearTrainExtras(); }

  /* ══════════════════════════════════════════════════════════════════
   *  PART 2 — RICH ACTIVITY DETAIL
   * ══════════════════════════════════════════════════════════════════ */


  /* ── GPS / Route rendering (polyline decode + SVG map) ─────────── */
  /*
   * Lightweight polyline decoder (Google Encoded Polyline Algorithm).
   * No external map library needed — renders a clean SVG route trace.
   */
  function decodePolyline(encoded) {
    if (!encoded || typeof encoded !== "string") return [];
    const points = [];
    let lat = 0, lng = 0, i = 0;
    while (i < encoded.length) {
      let shift = 0, result = 0, b;
      do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  }

  function extractRouteData(act) {
    if (!act) return null;
    const raw = act.raw_data && typeof act.raw_data === "object" ? act.raw_data : {};
    const norm = raw.normalized && typeof raw.normalized === "object" ? raw.normalized : {};

    // Priority 1: stored summary polyline (from Strava map object)
    const mapObj = norm.map || raw.map || null;
    if (mapObj && mapObj.summary_polyline) {
      const pts = decodePolyline(mapObj.summary_polyline);
      if (pts.length >= 2) return pts;
    }
    if (typeof raw.summary_polyline === "string" && raw.summary_polyline) {
      const pts = decodePolyline(raw.summary_polyline);
      if (pts.length >= 2) return pts;
    }
    // Priority 2: stored polyline
    if (typeof raw.polyline === "string" && raw.polyline) {
      const pts = decodePolyline(raw.polyline);
      if (pts.length >= 2) return pts;
    }

    // Priority 3: latlng from activity streams (cached)
    const AS = window.AthlevoActivityStreams;
    if (AS) {
      const id = act.id != null ? String(act.id) : null;
      const streams = (id && AS.cacheGet(id)) || AS.streamsFromActivity(act);
      const latlng = streams && streams.latlng;
      if (Array.isArray(latlng) && latlng.length >= 2) {
        // latlng can be array of [lat,lng] pairs
        if (Array.isArray(latlng[0])) return latlng.filter(p => Array.isArray(p) && p.length >= 2);
        // Or flat alternating lat,lng
        if (latlng.length >= 4 && typeof latlng[0] === "number") {
          const pts = [];
          for (let i = 0; i < latlng.length - 1; i += 2) pts.push([latlng[i], latlng[i + 1]]);
          return pts.length >= 2 ? pts : null;
        }
      }
    }
    return null;
  }

  function isOutdoorGpsSport(act) {
    if (!act) return false;
    const raw = act.raw_data && typeof act.raw_data === "object" ? act.raw_data : {};
    if (raw.trainer) return false;
    const sport = canonSport(act);
    if (sport === "strength" || sport === "mobility") return false;
    const hasGps = raw.has_gps || raw.hasGps;
    // If explicitly flagged as no GPS, skip
    if (hasGps === false) return false;
    // Check for indoor indicators
    const type = String(act.sport_type || act.activity_type || act.name || "").toLowerCase();
    if (/indoor|treadmill|virtual|trainer|zwift|stationary/i.test(type)) return false;
    return true;
  }

  function renderRouteMap(points) {
    if (!points || points.length < 2) return "";
    // Compute bounding box
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    points.forEach(([lat, lng]) => {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    });
    const latRange = maxLat - minLat || 0.001;
    const lngRange = maxLng - minLng || 0.001;
    // Aspect ratio: longitude needs cos(lat) correction
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);
    const effectiveLngRange = lngRange * cosLat;

    const W = 360, PAD = 16;
    const aspect = effectiveLngRange / latRange;
    const H = Math.max(140, Math.min(240, Math.round((W - 2 * PAD) / Math.max(aspect, 0.5)) + 2 * PAD));
    const drawW = W - 2 * PAD, drawH = H - 2 * PAD;

    // Scale and fit
    const scaleX = drawW / (lngRange || 0.001);
    const scaleY = drawH / (latRange || 0.001);
    const scale = Math.min(scaleX, scaleY * cosLat);

    const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
    const toX = lng => W / 2 + (lng - cx) * scale * cosLat;
    const toY = lat => H / 2 - (lat - cy) * scale; // flip Y

    // Downsample for rendering (max ~200 points)
    const step = Math.max(1, Math.ceil(points.length / 200));
    const sampled = [];
    for (let i = 0; i < points.length; i += step) sampled.push(points[i]);
    if (sampled[sampled.length - 1] !== points[points.length - 1]) sampled.push(points[points.length - 1]);

    const pathData = sampled.map((p, i) => {
      const x = toX(p[1]).toFixed(1), y = toY(p[0]).toFixed(1);
      return (i === 0 ? "M" : "L") + x + "," + y;
    }).join("");

    const startPt = sampled[0], endPt = sampled[sampled.length - 1];
    const sx = toX(startPt[1]).toFixed(1), sy = toY(startPt[0]).toFixed(1);
    const ex = toX(endPt[1]).toFixed(1), ey = toY(endPt[0]).toFixed(1);

    return `<div class="ad-route" aria-label="Route map">
      <svg class="ad-route-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <path d="${pathData}" fill="none" stroke="var(--sport-accent,var(--red))" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
        <circle cx="${sx}" cy="${sy}" r="4" fill="var(--sport-accent,var(--red))" opacity=".9"/>
        <circle cx="${ex}" cy="${ey}" r="3.5" fill="var(--paper)" stroke="var(--sport-accent,var(--red))" stroke-width="2"/>
      </svg>
    </div>`;
  }

  function openModal(dISO, activityId) {
    const entry = byDate[dISO] || {};
    let s = entry.session ? entry.session : null;
    if (s && window.AthlevoPrescription && typeof window.AthlevoPrescription.repair === "function") s = window.AthlevoPrescription.repair(s);
    let act = null;
    const fromDay = (entry.activities || []).find(a => a && activityId && String(a.id) === String(activityId));
    if (activityId && actById[String(activityId)]) act = actById[String(activityId)];
    else if (fromDay) act = fromDay;
    else if (entry.execution && entry.execution.imported_activity_id && actById[String(entry.execution.imported_activity_id)]) act = actById[String(entry.execution.imported_activity_id)];
    else if (entry.activities && entry.activities.length === 1) act = entry.activities[0];
    const ex = entry.execution || null;
    _openModalToken += 1;
    const modalToken = _openModalToken;

    let html = "";

    /* ── Completed activity detail (Intervals-style) ───────────────── */
    if (act) {
      const sport = canonSport(act);
      const name = sportLabel(act);
      const source = act.name && act.name !== name ? act.name : null;
      const dateStr = fmtDayHeader(dISO);
      const startTime = act.start_date ? new Date(act.start_date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;

      html += `<button type="button" class="ad-back" onclick="AthlevoTrainCalendar.closeModal()">← Back</button>`;
      html += `<div class="ad-header ad-header--${sportTheme(act)}">
        <div class="ad-header-info">
          <h2 class="ad-title">${esc(source || name)}</h2>
          <div class="ad-header-meta">${esc(dateStr)}${startTime ? " · " + esc(startTime) : ""} · ${esc(name)}</div>
        </div>
      </div>`;

      /* ── Compact metric grid ──────────────────────────────────────── */
      html += renderDetailSummary(act, ex, sport);

      /* ── Coach analysis (1-2 sentences max) ───────────────────────── */
      const recognition = (window.AthlevoCoach && AthlevoCoach.getStoredRecognition)
        ? AthlevoCoach.getStoredRecognition(act) : null;
      html += renderCoachSection(act, recognition, s);

      /* ── GPS Route map (outdoor activities with GPS only) ─────────── */
      if (isOutdoorGpsSport(act)) {
        const routePoints = extractRouteData(act);
        if (routePoints) {
          html += renderRouteMap(routePoints);
        } else {
          // Placeholder — may load after streams arrive
          html += `<div id="ad-route-deferred" class="ad-route-deferred"></div>`;
        }
      }

      /* ── Splits strip (compact horizontal scroll) ─────────────────── */
      html += renderSplitsStrip(act, sport);

      /* ── Synchronized graph stack ─────────────────────────────────── */
      html += `<div id="ad-charts-root" class="ad-charts-root" data-activity-id="${esc(act.id != null ? String(act.id) : "")}"></div>`;

      /* ── Workout structure (segment timeline) ─────────────────────── */
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
      }

      /* ── HR Zones ─────────────────────────────────────────────────── */
      html += renderHRZones(act);

    } else if (s && !isRest(s)) {
      /* ── Plan-only view (no activity yet) ──────────────────────── */
      html += renderPlanDetail(s, dISO, ex);
    } else if (s && isRest(s)) {
      html += `<div class="ad-header"><div class="ad-header-top"><div class="ad-header-info"><h2 class="ad-title">Rest Day</h2></div></div>
        <div class="ad-header-meta"><span>${esc(fmtDayHeader(dISO))}</span></div></div>
        <p class="ad-rest-msg">Recovery is part of the plan. Your body adapts during rest.</p>`;
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
      tryDeferredRoute(act, stored);
      return;
    }
    root.innerHTML = `<p class="ad-chart-loading">Loading graphs…</p>`;
    let streams = null;
    try { streams = await AS.loadStreams(act); } catch (e) { streams = null; }
    if (token !== _openModalToken) return;
    if (!AS.renderInto(root, streams, sport)) root.innerHTML = "";
    tryDeferredRoute(act, streams);
  }

  function tryDeferredRoute(act, streams) {
    const el = document.getElementById("ad-route-deferred");
    if (!el || !isOutdoorGpsSport(act)) return;
    // Try latlng from streams
    if (streams && streams.latlng && Array.isArray(streams.latlng) && streams.latlng.length >= 2) {
      let pts = null;
      if (Array.isArray(streams.latlng[0])) {
        pts = streams.latlng.filter(p => Array.isArray(p) && p.length >= 2);
      } else if (streams.latlng.length >= 4 && typeof streams.latlng[0] === "number") {
        pts = [];
        for (let i = 0; i < streams.latlng.length - 1; i += 2) pts.push([streams.latlng[i], streams.latlng[i + 1]]);
      }
      if (pts && pts.length >= 2) {
        el.outerHTML = renderRouteMap(pts);
        return;
      }
    }
    // Re-check route data now that streams may be cached
    const routePoints = extractRouteData(act);
    if (routePoints) {
      el.outerHTML = renderRouteMap(routePoints);
    } else {
      el.remove();
    }
  }

  /* ── Detail: Intervals-style compact metric grid ────────────────── */
  function renderDetailSummary(act, ex, sport) {
    const raw = act.raw_data && typeof act.raw_data === "object" ? act.raw_data : {};
    const primary = [];
    const secondary = [];
    const addP = (label, value) => { if (value != null && value !== "") primary.push({ label, value: String(value) }); };
    const addS = (label, value) => { if (value != null && value !== "") secondary.push({ label, value: String(value) }); };

    if (act.distance_meters && sport !== "strength" && sport !== "mobility") {
      addP("Distance", (act.distance_meters / 1000).toFixed(2) + " km");
    }
    if (act.moving_time_seconds) addP("Duration", fmtDuration(act.moving_time_seconds));

    if ((sport === "run" || sport === "walk" || sport === "hike") && act.distance_meters && act.moving_time_seconds) {
      addP("Pace", fmtPace(act.moving_time_seconds / (act.distance_meters / 1000)) + "/km");
    } else if (sport === "swim" && act.distance_meters && act.moving_time_seconds) {
      addP("Pace", fmtPace(act.moving_time_seconds / (act.distance_meters / 100)) + "/100m");
    } else if (sport === "ride" && act.distance_meters && act.moving_time_seconds) {
      addP("Speed", ((act.distance_meters / act.moving_time_seconds) * 3.6).toFixed(1) + " km/h");
    }

    if (act.average_heartrate) addP("Avg HR", Math.round(act.average_heartrate) + " bpm");

    const load = activityLoad(act);
    if (load) addP("Load", String(load));
    const rpe = activityRpe(act, ex);
    if (rpe) addP("RPE", String(rpe));

    // Secondary metrics
    const maxHr = num(act.max_heartrate) || num(raw.max_heartrate);
    if (maxHr) addS("Max HR", Math.round(maxHr) + " bpm");
    if (act.average_cadence || raw.average_cadence) {
      const cad = Math.round(num(act.average_cadence) || num(raw.average_cadence));
      addS("Cadence", cad + (sport === "ride" ? " rpm" : " spm"));
    }
    if (act.elevation_gain_meters) addS("Elevation", Math.round(act.elevation_gain_meters) + " m");
    const pwr = activityPower(act);
    if (pwr > 0) addS("Power", Math.round(pwr) + " W");
    if ((sport === "strength" || sport === "mobility") && strengthVolume(act)) {
      addS("Volume", strengthVolume(act));
    }
    const cals = num(raw.calories_kcal);
    if (cals > 0) addS("Calories", Math.round(cals) + " kcal");

    if (!primary.length && !secondary.length) return "";

    let html = `<div class="ad-metric-grid">`;
    primary.forEach(m => {
      html += `<div class="ad-metric-cell"><span class="ad-metric-val">${esc(m.value)}</span><span class="ad-metric-lbl">${esc(m.label)}</span></div>`;
    });
    html += `</div>`;

    if (secondary.length) {
      html += `<div class="ad-metric-grid ad-metric-grid--secondary">`;
      secondary.forEach(m => {
        html += `<div class="ad-metric-cell ad-metric-cell--sm"><span class="ad-metric-val">${esc(m.value)}</span><span class="ad-metric-lbl">${esc(m.label)}</span></div>`;
      });
      html += `</div>`;
    }
    return html;
  }

  function clipCoachText(text) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    const sentences = raw.split(/(?<=[.!?])\s+/).filter(Boolean);
    let out = sentences.slice(0, 2).join(" ");
    if (out.length > 240) {
      const cut = out.slice(0, 220);
      const last = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
      out = (last > 80 ? cut.slice(0, last) : cut).trim();
      if (!/[.!?]$/.test(out)) out += ".";
    }
    return out;
  }

  /* ── Detail: Coach analysis section ────────────────────────────── */
  function renderCoachSection(act, recognition, session) {
    let text = "";
    if (recognition && recognition.coachSummary) {
      text = clipCoachText(recognition.coachSummary);
    } else {
      const sport = canonSport(act);
      if (sport === "run" && act.average_heartrate && act.moving_time_seconds) {
        const min = Math.round(act.moving_time_seconds / 60);
        const hr = Math.round(act.average_heartrate);
        text = `${min} minute ${sportShort(act).toLowerCase()} at ${hr} bpm average heart rate.`;
      }
    }
    if (!text) return "";
    return `<div class="ad-coach"><p class="ad-coach-text">${esc(text)}</p></div>`;
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

  /* ── Detail: compact splits strip (real laps only) ─────────────── */
  function renderSplitsStrip(act, sport) {
    const laps = lapList(act);
    if (laps.length < 2) return "";
    const cells = laps.map(lap => {
      const time = lapTimeSec(lap);
      const dist = lapDistanceM(lap);
      const hr = num(lap && (lap.average_heartrate || lap.avg_hr || lap.average_hr));
      let pace = null;
      if (dist > 20 && time > 0 && sport !== "ride" && sport !== "strength" && sport !== "mobility") {
        pace = sport === "swim"
          ? fmtPace(time / (dist / 100)) + "/100m"
          : fmtPace(time / (dist / 1000)) + "/km";
      }
      const bits = [];
      if (time > 0) bits.push(`<span class="ad-split-time">${esc(fmtSplitClock(time))}</span>`);
      if (pace) bits.push(`<span class="ad-split-pace">${esc(pace)}</span>`);
      if (hr > 0) bits.push(`<span class="ad-split-hr">${Math.round(hr)} bpm</span>`);
      return bits.length ? `<div class="ad-split" role="listitem">${bits.join("")}</div>` : "";
    }).filter(Boolean);
    if (cells.length < 2) return "";
    return `<div class="ad-splits-strip" role="list" aria-label="Splits">${cells.join("")}</div>`;
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
      html += `<p class="ad-metrics">${esc(items.map(i => i.value).join(" · "))}</p>`;
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
    actById = {};
    Object.keys(byDate).forEach(key => {
      const acts = byDate[key] && byDate[key].activities;
      if (!Array.isArray(acts)) return;
      acts.forEach(a => { if (a && a.id != null) actById[String(a.id)] = a; });
    });
    render();
  }
  function getSelectedDate() { return selected; }

  window.AthlevoTrainCalendar = {
    open, prevWeek, nextWeek, goToday, select, openModal, closeModal, askCoach,
    activityDateKey, buildSelectedDayModel, cardMetricItems, sportTheme,
    activityCardHtml, plannedCardHtml, renderSelectedDayHtml,
    cardMiniProfile, cardProfileSeries,
    hydrate, getSelectedDate,
    clipCoachText, renderDetailSummary, renderSplitsStrip, renderCoachSection,
    VERSION: "train-calendar-v8"
  };
})();
