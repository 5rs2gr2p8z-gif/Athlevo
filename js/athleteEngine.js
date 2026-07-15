/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Athlete Engine (Phase B)  ·  client mirror of
 *  lib/server/athleteEngine.js
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Verbatim mirror of the authoritative server engine so the browser
 *  screens (Today / Train / Trends / Coach) compute the SAME athlete
 *  metrics the AI coach does. Pure and deterministic; no DOM, no network.
 *  Exposed as window.AthleteEngine. A parity test keeps this in sync with
 *  the server module.
 *
 *  Reuses window.AthlevoPerformance for all VDOT / pace / level maths —
 *  the numbers are never re-derived here.
 *
 *  NOTE: this is the engine only. UI wiring happens in the next sprint.
 */

(function () {
  "use strict";

  const P = () => window.AthlevoPerformance;

  /* ─────────────────────────── helpers ────────────────────────────── */

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function clamp100(n) { return Math.max(0, Math.min(100, Math.round(n))); }
  function median(values) {
    const s = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(values) {
    const s = (values || []).filter(Number.isFinite);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  }
  function stdev(values) {
    const s = (values || []).filter(Number.isFinite);
    if (s.length < 2) return null;
    const m = s.reduce((a, b) => a + b, 0) / s.length;
    const v = s.reduce((a, b) => a + (b - m) * (b - m), 0) / s.length;
    return Math.sqrt(v);
  }
  function ageDays(iso, nowMs) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? (nowMs - t) / 86400000 : Infinity;
  }
  function isRunActivity(a) {
    const t = String(a?.activity_type || a?.sport_type || a?.type || "").toLowerCase();
    return /run|jog|tempo|interval|threshold|long|track/.test(t);
  }
  function formatPaceSec(secPerKm) {
    if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return null;
    const total = Math.round(secPerKm);
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return `${m}:${String(s).padStart(2, "0")}/km`;
  }

  /* ═══════════════════════ 1 · VDOT + paces ══════════════════════════ */
  function calculateVdotPaces(distanceMeters, durationSeconds) {
    const vdot = P().vdotFromRace(distanceMeters, durationSeconds);
    if (vdot == null) return null;
    const p = P().trainingPaces(vdot);
    if (!p) return { vdot, paces: null };
    return {
      vdot,
      paces: {
        easy: p.easy.pace, marathon: p.marathon.pace, threshold: p.threshold.pace,
        interval: p.vo2.pace, repetition: p.repetition.pace
      },
      paceSeconds: {
        easy: p.easy.secPerKm, marathon: p.marathon.secPerKm, threshold: p.threshold.secPerKm,
        interval: p.vo2.secPerKm, repetition: p.repetition.secPerKm
      }
    };
  }

  /* ═══════════════════ 2 · merge + de-duplicate ══════════════════════ */
  function mergeTrainingItems(activities, executions) {
    const acts = Array.isArray(activities) ? activities : [];
    const execs = Array.isArray(executions) ? executions : [];

    const byId = new Map();
    acts.forEach(a => { if (a && a.id != null) byId.set(String(a.id), a); });
    const consumed = new Set();
    execs.forEach(e => { if (e && e.imported_activity_id != null) consumed.add(String(e.imported_activity_id)); });

    const items = [];

    execs.forEach(e => {
      if (!["completed", "modified", "skipped"].includes(e.status)) return;
      const snap = e.original_session_snapshot || {};
      const linked = e.imported_activity_id != null ? byId.get(String(e.imported_activity_id)) : null;
      const performed = e.status !== "skipped";

      const durMin = performed
        ? (num(e.actual_duration_minutes)
            ?? (linked ? num(linked.moving_time_seconds) / 60 : null)
            ?? num(snap.duration_minutes))
        : 0;
      const km = performed
        ? (num(e.actual_distance_km)
            ?? (linked ? num(linked.distance_meters) / 1000 : null)
            ?? num(snap.distance_km))
        : 0;

      items.push({
        timestamp: e.completed_at || e.updated_at || (snap.session_date ? snap.session_date + "T12:00:00Z" : null) || e.created_at || null,
        source: linked ? "matched_execution" : "manual_execution",
        priority: linked ? 5 : 3,
        status: e.status,
        performed,
        isRun: isRunActivity({ activity_type: snap.session_type || (linked && (linked.sport_type || linked.activity_type)) }),
        distanceKm: km || 0,
        durationMin: durMin || 0,
        elapsedMin: linked && num(linked.elapsed_time_seconds) != null ? num(linked.elapsed_time_seconds) / 60 : (durMin || 0),
        hr: num(e.actual_average_hr) ?? (linked ? num(linked.average_heartrate) : null),
        maxHr: linked ? num(linked.max_heartrate) : null,
        elevation: linked ? num(linked.elevation_gain_meters) : null,
        rpe: num(e.actual_rpe),
        title: snap.title || (linked && linked.name) || "",
        sportType: snap.session_type || (linked && (linked.sport_type || linked.activity_type)) || "",
        trainer: linked ? linked.trainer === true : false,
        painPresent: e.pain_present === true,
        skipReason: e.skip_reason || null,
        activityId: e.imported_activity_id != null ? String(e.imported_activity_id) : null
      });
    });

    acts.forEach(a => {
      if (a && a.id != null && consumed.has(String(a.id))) return;
      const durMin = num(a.moving_time_seconds) != null ? num(a.moving_time_seconds) / 60 : null;
      const km = num(a.distance_meters) != null ? num(a.distance_meters) / 1000 : null;
      items.push({
        timestamp: a.start_date || null,
        source: "imported_activity",
        priority: 6,
        status: "activity",
        performed: true,
        isRun: isRunActivity(a),
        distanceKm: km || 0,
        durationMin: durMin || 0,
        elapsedMin: num(a.elapsed_time_seconds) != null ? num(a.elapsed_time_seconds) / 60 : (durMin || 0),
        hr: num(a.average_heartrate),
        maxHr: num(a.max_heartrate),
        elevation: num(a.elevation_gain_meters),
        rpe: null,
        title: a.name || "",
        sportType: a.sport_type || a.activity_type || "",
        trainer: a.trainer === true,
        painPresent: false,
        skipReason: null,
        activityId: a.id != null ? String(a.id) : null
      });
    });

    items.forEach(i => {
      i.paceSec = i.distanceKm > 0 && i.durationMin > 0 ? (i.durationMin * 60) / i.distanceKm : null;
      i.elevPerKm = i.distanceKm > 0 && i.elevation != null ? i.elevation / i.distanceKm : null;
    });

    return items.filter(i => i.timestamp);
  }

  /* ═══════════════════ 3 · workout classification ════════════════════ */
  const WORKOUT_TYPES = [
    "Easy", "Recovery", "Long Run", "Tempo", "Threshold",
    "VO2", "Intervals", "Race", "Time Trial", "Progression", "Hill", "Unknown"
  ];
  const INTENSITY_FACTOR = {
    Recovery: 2, Easy: 3, "Long Run": 4, Progression: 5,
    Tempo: 6, Hill: 6, Threshold: 7, Intervals: 8, VO2: 8.5,
    Race: 9, "Time Trial": 9, Unknown: 4
  };

  function classifyWorkout(item, ctx) {
    ctx = ctx || {};
    const title = String(item.title || "").toLowerCase();
    const km = num(item.distanceKm) || 0;
    const durMin = num(item.durationMin) || 0;
    const paceSec = num(item.paceSec);
    const hr = num(item.hr);
    const maxHr = num(item.maxHr) ?? num(ctx.maxHr);
    const elevPerKm = num(item.elevPerKm);

    const done = (type, confidence) => ({
      type, confidence: Math.max(0, Math.min(1, confidence)),
      intensityFactor: INTENSITY_FACTOR[type] || 4
    });

    if (!item.isRun) return done("Unknown", 0.2);

    if (/\btime.?trial\b|\btt\b/.test(title)) return done("Time Trial", 0.9);
    if (/\brace\b|parkrun|championship|grand.?prix|\bgp\b/.test(title)) return done("Race", 0.85);
    if (/progression|\bprog\b|negative split/.test(title)) return done("Progression", 0.7);
    if (/\bhill\b|hilly|hill repeats/.test(title)) return done("Hill", 0.7);

    if (elevPerKm != null && elevPerKm >= 18) return done("Hill", 0.65);

    const eZone = num(ctx.easySec);
    const tZone = num(ctx.thresholdSec);
    const vZone = num(ctx.intervalSec);
    const longKm = num(ctx.longKm) || 16;

    if (paceSec != null && tZone != null) {
      if (vZone != null && paceSec <= vZone * 1.02) {
        return km <= 5 && durMin <= 30 ? done("Intervals", 0.7) : done("VO2", 0.7);
      }
      if (paceSec <= tZone * 1.03) return done("Threshold", 0.7);
      if (paceSec <= tZone * 1.09) return done("Tempo", 0.65);
      if (eZone != null && paceSec >= eZone * 1.12 && durMin <= 55) return done("Recovery", 0.6);
      if (durMin >= 90 || km >= longKm) return done("Long Run", 0.75);
      return done("Easy", 0.7);
    }

    if (hr != null && maxHr != null && maxHr > 0) {
      const pct = hr / maxHr;
      if (pct >= 0.90) return km <= 5 ? done("Intervals", 0.55) : done("VO2", 0.55);
      if (pct >= 0.85) return done("Threshold", 0.55);
      if (pct >= 0.80) return done("Tempo", 0.5);
      if (pct < 0.70) return done("Recovery", 0.5);
      if (durMin >= 90 || km >= longKm) return done("Long Run", 0.6);
      return done("Easy", 0.55);
    }

    if (durMin >= 90 || km >= longKm) return done("Long Run", 0.5);
    if (durMin > 0 && durMin <= 25 && km > 0 && km <= 4) return done("Recovery", 0.4);
    if (durMin > 0) return done("Easy", 0.4);
    return done("Unknown", 0.2);
  }

  /* ═══════════════ 4 · training-load / recovery engine ═══════════════ */
  function sessionLoad(item, classification) {
    const dur = num(item.durationMin);
    if (!dur || dur <= 0 || !item.performed) return 0;
    const rpe = num(item.rpe);
    if (rpe != null && rpe > 0) return dur * rpe;
    const factor = (classification && classification.intensityFactor) || 4;
    return dur * factor;
  }

  function ewma(dailyLoads, tau) {
    const alpha = 2 / (tau + 1);
    let value = 0;
    for (const load of dailyLoads) value = load * alpha + value * (1 - alpha);
    return value;
  }

  function computeTrainingLoad(classifiedItems, nowMs) {
    const DAYS = 42;
    const daily = new Array(DAYS).fill(0);
    for (const ci of classifiedItems) {
      const age = ageDays(ci.item.timestamp, nowMs);
      if (age < 0 || age >= DAYS) continue;
      const idx = DAYS - 1 - Math.floor(age);
      daily[idx] += ci.load;
    }

    const last7 = daily.slice(DAYS - 7);
    const prev7 = daily.slice(DAYS - 14, DAYS - 7);

    const weeklyLoad = Math.round(last7.reduce((a, b) => a + b, 0));
    const acute = ewma(daily.slice(DAYS - 7), 7);
    const chronic = ewma(daily.slice(DAYS - 28), 28);
    const acwr = chronic > 0 ? acute / chronic : null;

    const trainingDays7 = last7.filter(d => d > 0).length;
    const meanDaily7 = mean(last7) || 0;
    const sdDaily7 = stdev(last7);
    const monotony = sdDaily7 && sdDaily7 > 0 ? meanDaily7 / sdDaily7 : null;
    const strain = monotony != null ? Math.round(weeklyLoad * monotony) : null;

    const prevWeekLoad = prev7.reduce((a, b) => a + b, 0);
    const recoveryTrend = prevWeekLoad > 0 ? Math.round(((weeklyLoad - prevWeekLoad) / prevWeekLoad) * 100) : null;

    const fitnessScore = clamp100((chronic / 6));
    const fatigueScore = clamp100((acute / 6));

    let balance = "insufficient data";
    if (acwr != null) {
      if (acwr < 0.8) balance = "detraining";
      else if (acwr <= 1.3) balance = "optimal";
      else if (acwr <= 1.5) balance = "overreaching";
      else balance = "high risk";
    }

    return {
      weekly_training_load: weeklyLoad,
      acute_load: Math.round(acute),
      chronic_load: Math.round(chronic),
      acwr: acwr != null ? Math.round(acwr * 100) / 100 : null,
      training_balance: balance,
      training_monotony: monotony != null ? Math.round(monotony * 100) / 100 : null,
      training_strain: strain,
      recovery_trend_pct: recoveryTrend,
      fatigue_score: fatigueScore,
      fitness_score: fitnessScore,
      training_days_last_7: trainingDays7
    };
  }

  /* ═══════════════════════ 5 · consistency engine ═══════════════════ */
  function computeConsistency(items, profile, nowMs) {
    const runs = items.filter(i => i.isRun && i.performed && i.distanceKm > 0);
    const within = d => runs.filter(i => ageDays(i.timestamp, nowMs) <= d);
    const sumKm = arr => Math.round(arr.reduce((s, i) => s + (i.distanceKm || 0), 0) * 10) / 10;
    const sumMin = arr => Math.round(arr.reduce((s, i) => s + (i.durationMin || 0), 0));

    const last7 = within(7);
    const last28 = within(28);
    const last42 = within(42);

    const longKm = (() => {
      const med = median(runs.map(i => i.distanceKm));
      return med != null ? Math.max(14, med * 1.5) : 16;
    })();
    const longRuns = last42.filter(i => i.durationMin >= 90 || i.distanceKm >= longKm);

    const easyPaces = last42
      .filter(i => i.paceSec && i.classifiedType && /Easy|Recovery|Long Run/.test(i.classifiedType))
      .map(i => i.paceSec);
    const threshPaces = last42
      .filter(i => i.paceSec && i.classifiedType && /Threshold|Tempo/.test(i.classifiedType))
      .map(i => i.paceSec);

    const weeksActive = new Set(
      last42.map(i => {
        const t = new Date(i.timestamp);
        const day = (t.getUTCDay() + 6) % 7;
        const monday = new Date(t);
        monday.setUTCDate(t.getUTCDate() - day);
        return monday.toISOString().slice(0, 10);
      })
    ).size;

    const availableDays = num(profile && (profile.available_days ?? profile.training_days)) || 5;
    const frequencyPerWeek = last28.length ? last28.length / 4 : 0;

    const recorded = items.filter(i => ["completed", "modified", "skipped"].includes(i.status)
      && ageDays(i.timestamp, nowMs) <= 42);
    const excused = r => ["schedule", "travel", "illness", "pain"].includes(String(r || "").toLowerCase());
    const missed = recorded.filter(i => i.status === "skipped" && !excused(i.skipReason)).length;
    const good = recorded.filter(i => i.status === "completed" || i.status === "modified").length;
    const completionPct = (good + missed) > 0 ? (good / (good + missed)) * 100 : null;

    const consistencyPct = completionPct != null
      ? clamp100(completionPct * 0.6 + Math.min(100, (frequencyPerWeek / availableDays) * 100) * 0.4)
      : clamp100(Math.min(100, (frequencyPerWeek / availableDays) * 100));

    return {
      weekly_distance: sumKm(last7),
      weekly_duration: sumMin(last7),
      monthly_mileage: sumKm(last28),
      six_week_volume: sumKm(last42),
      longest_run_km: runs.length ? Math.round(Math.max(...runs.map(i => i.distanceKm)) * 10) / 10 : 0,
      average_long_run_km: longRuns.length ? Math.round(mean(longRuns.map(i => i.distanceKm)) * 10) / 10 : 0,
      average_easy_pace: formatPaceSec(median(easyPaces)),
      average_threshold_pace: formatPaceSec(median(threshPaces)),
      training_frequency_per_week: Math.round(frequencyPerWeek * 10) / 10,
      days_missed: missed,
      consistency_percentage: consistencyPct,
      weeks_active_6wk: weeksActive,
      long_run_threshold_km: Math.round(longKm * 10) / 10
    };
  }

  /* ═══════════ 6 · component scores + Athlevo Score ═══════════ */
  const SCORE_WEIGHTS = {
    aerobic: 20, threshold: 18, speed: 10, endurance: 15,
    consistency: 15, volume: 12, recovery: 5, recent: 5
  };

  function computeComponentScores(inp) {
    const { fitness, load, consistency, items, races, nowMs } = inp;
    const level = fitness && fitness.runningLevel ? fitness.runningLevel.level : null;
    const runs = items.filter(i => i.isRun && i.performed);
    const recent = runs.filter(i => ageDays(i.timestamp, nowMs) <= 42);

    const thresholdSessions = recent.filter(i => /Threshold|Tempo/.test(i.classifiedType || "")).length;
    const speedSessions = recent.filter(i => /VO2|Intervals/.test(i.classifiedType || "")).length;
    const longRuns = recent.filter(i => /Long Run/.test(i.classifiedType || "")).length;
    const easyRuns = recent.filter(i => /Easy|Recovery|Long Run/.test(i.classifiedType || "")).length;
    const weeksActive = consistency.weeks_active_6wk;
    const avgWeeklyKm = consistency.six_week_volume / Math.max(weeksActive, 1);

    const scores = {};

    scores.aerobic = (weeksActive >= 2 && easyRuns >= 4)
      ? { value: clamp100((level != null ? level * 0.7 : 30) + Math.min(30, avgWeeklyKm * 0.6)), status: "valid" }
      : { value: null, status: "Building" };

    const hasRace = (races || []).some(r => ["official", "time_trial"].includes(r.race_type));
    scores.threshold = (thresholdSessions >= 2 || (hasRace && weeksActive >= 3))
      ? { value: clamp100((level != null ? level * 0.9 : 45) + Math.min(6, thresholdSessions * 2)), status: "valid" }
      : { value: null, status: "Building" };

    scores.speed = (speedSessions >= 1)
      ? { value: clamp100((level != null ? level * 0.85 : 40) + Math.min(8, speedSessions * 3)), status: "valid" }
      : { value: null, status: "Building" };

    scores.endurance = (longRuns >= 2)
      ? { value: clamp100(Math.min(55, longRuns * 12) + Math.min(35, avgWeeklyKm * 0.5)), status: "valid" }
      : { value: null, status: "Building" };

    scores.consistency = (weeksActive >= 2)
      ? { value: consistency.consistency_percentage, status: "valid" }
      : { value: null, status: "Building" };

    scores.volume = avgWeeklyKm > 0
      ? { value: clamp100(Math.min(100, (avgWeeklyKm / 60) * 100)), status: "valid" }
      : { value: null, status: "Building" };

    scores.recovery = load.acwr != null
      ? { value: clamp100(load.acwr <= 1.3 ? 100 - Math.abs(load.acwr - 1.0) * 60 : 100 - (load.acwr - 1.3) * 120), status: "valid" }
      : { value: null, status: "Building" };

    const recentRace = (races || [])
      .filter(r => ["official", "time_trial"].includes(r.race_type) && r.race_date)
      .sort((a, b) => Date.parse(b.race_date) - Date.parse(a.race_date))[0];
    scores.recent = recentRace && ageDays(recentRace.race_date + "T12:00:00Z", nowMs) <= 60
      ? { value: level != null ? clamp100(level) : 60, status: "valid" }
      : { value: null, status: "Building" };

    return scores;
  }

  function composeAthlevoScore(componentScores, load) {
    let acc = 0, wsum = 0, valid = 0;
    for (const key of Object.keys(SCORE_WEIGHTS)) {
      const c = componentScores[key];
      if (c && c.status === "valid" && Number.isFinite(c.value)) {
        acc += c.value * SCORE_WEIGHTS[key];
        wsum += SCORE_WEIGHTS[key];
        valid += 1;
      }
    }
    const gate = valid >= 3 &&
      (componentScores.aerobic.status === "valid" ||
       componentScores.threshold.status === "valid" ||
       componentScores.recent.status === "valid");

    if (!gate || wsum === 0) {
      return { score: null, status: "Building", dataQuality: valid >= 3 ? "Developing" : "Limited data", validComponents: valid };
    }

    let raw = acc / wsum;
    if (load.acwr != null && load.acwr > 1.5) raw -= Math.min(6, (load.acwr - 1.5) * 12);

    return {
      score: clamp100(raw),
      status: "valid",
      dataQuality: valid >= 6 ? "Strong data" : valid >= 4 ? "Developing" : "Limited data",
      validComponents: valid
    };
  }

  /* ═══════════════ 7 · current VDOT (best evidence) ═══════════════ */
  function resolveCurrentVdot(races, items, nowMs) {
    let best = null;
    for (const r of races || []) {
      if (!["official", "time_trial", "training_effort"].includes(r.race_type)) continue;
      if (r.race_date && ageDays(r.race_date + "T12:00:00Z", nowMs) > 400) continue;
      const v = P().vdotFromRace(r.distance_meters, r.duration_seconds);
      if (v == null) continue;
      if (!best || v > best.vdot) best = { vdot: v, source: "race", raceDate: r.race_date, distanceKm: (num(r.distance_meters) || 0) / 1000, estimated: false };
    }
    if (best) return best;

    for (const i of items || []) {
      if (!i.isRun || !i.performed) continue;
      if (ageDays(i.timestamp, nowMs) > 120) continue;
      const meters = (num(i.distanceKm) || 0) * 1000;
      const seconds = (num(i.durationMin) || 0) * 60;
      if (meters < 3000 || seconds <= 0) continue;
      const v = P().vdotFromRace(meters, seconds);
      if (v == null) continue;
      if (!best || v > best.vdot) best = { vdot: v, source: "estimate", raceDate: null, distanceKm: meters / 1000, estimated: true };
    }
    return best;
  }

  /* ═══════════ 8 · orchestrator → athlete_metrics snapshot ═══════════ */
  function computeAthleteMetrics(inp) {
    inp = inp || {};
    const { activities, executions, races, profile } = inp;
    const nowMs = inp.now ? (inp.now instanceof Date ? inp.now.getTime() : inp.now) : Date.now();
    const items = mergeTrainingItems(activities, executions);

    const vdotInfo = resolveCurrentVdot(races, items, nowMs);
    const currentVdot = vdotInfo ? vdotInfo.vdot : null;
    const paces = currentVdot != null ? P().trainingPaces(currentVdot) : null;

    const longMed = median(items.filter(i => i.isRun && i.performed && i.distanceKm > 0).map(i => i.distanceKm));
    const classifyCtx = {
      easySec: paces ? paces.easy.secPerKm : null,
      thresholdSec: paces ? paces.threshold.secPerKm : null,
      intervalSec: paces ? paces.vo2.secPerKm : null,
      longKm: longMed != null ? Math.max(14, longMed * 1.5) : 16
    };

    const classified = items.map(item => {
      const c = classifyWorkout(item, classifyCtx);
      item.classifiedType = c.type;
      item.classifiedConfidence = c.confidence;
      const load = sessionLoad(item, c);
      return { item, classification: c, load };
    });

    const fitness = P().currentRunningLevel({ vdot: currentVdot, estimated: vdotInfo ? vdotInfo.estimated : false });
    const fitnessBundle = { runningLevel: fitness };

    const load = computeTrainingLoad(classified, nowMs);
    const consistency = computeConsistency(items, profile, nowMs);
    const components = computeComponentScores({ fitness: fitnessBundle, load, consistency, items, races, nowMs });
    const composite = composeAthlevoScore(components, load);

    const estimatedVo2max = currentVdot != null ? Math.round(currentVdot) : null;

    const snapshot = {
      current_vdot: currentVdot,
      estimated_vo2max: estimatedVo2max,
      aerobic_score: components.aerobic.value,
      threshold_score: components.threshold.value,
      speed_score: components.speed.value,
      endurance_score: components.endurance.value,
      fatigue_score: load.fatigue_score,
      fitness_score: load.fitness_score,
      athlevo_score: composite.score,
      weekly_training_load: load.weekly_training_load,
      weekly_distance: consistency.weekly_distance,
      weekly_duration: consistency.weekly_duration,
      acute_load: load.acute_load,
      chronic_load: load.chronic_load,
      training_monotony: load.training_monotony,
      training_strain: load.training_strain,
      last_updated: new Date(nowMs).toISOString()
    };

    return {
      snapshot,
      detail: {
        model_version: "athlete-engine-v1",
        vdotSource: vdotInfo ? vdotInfo.source : null,
        estimated: vdotInfo ? vdotInfo.estimated : false,
        paces: paces ? {
          easy: paces.easy.pace, marathon: paces.marathon.pace,
          threshold: paces.threshold.pace, interval: paces.vo2.pace,
          repetition: paces.repetition.pace
        } : null,
        trainingBalance: load.training_balance,
        acwr: load.acwr,
        recoveryTrendPct: load.recovery_trend_pct,
        consistency,
        components,
        compositeDataQuality: composite.dataQuality,
        classifications: classified.map(c => ({
          timestamp: c.item.timestamp, type: c.classification.type,
          confidence: c.classification.confidence, load: Math.round(c.load)
        }))
      }
    };
  }

  window.AthleteEngine = {
    calculateVdotPaces,
    mergeTrainingItems,
    classifyWorkout,
    sessionLoad,
    computeTrainingLoad,
    computeConsistency,
    computeComponentScores,
    composeAthlevoScore,
    resolveCurrentVdot,
    computeAthleteMetrics,
    WORKOUT_TYPES,
    ATHLETE_ENGINE_VERSION: "athlete-engine-v1"
  };
})();
