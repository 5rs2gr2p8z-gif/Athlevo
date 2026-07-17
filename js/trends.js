/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Calendar-Week Trends Engine
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Truthful, calendar-week training trends. Pure engine + a thin renderer.
 *
 *  Sources are merged with a strict PRIORITY and de-duplicated so an
 *  imported activity that is ALSO linked to an execution record is never
 *  counted twice (Part 12):
 *      1 athlete-confirmed correction   (applied to activities upstream)
 *      2 athlete-confirmed race / TT    (scoring only, not volume here)
 *      3 manual workout execution
 *      4 corrected imported activity     (applied upstream)
 *      5 matched imported activity        (execution linked to activity)
 *      6 raw imported activity
 *      7 inference                        (never invents numbers)
 *
 *  Everything is computed from real stored data. When comparison data is
 *  missing we say so ("No comparable data") rather than showing NaN,
 *  Infinity, or a misleading percentage.
 *
 *  Reuses: window.AthlevoCalendar (week math). Does not recompute fitness,
 *  Current Running Level, or paces (those stay in the performance engine).
 */

(function () {
  "use strict";

  /* ─────────────────────────── helpers ────────────────────────────── */

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function firstNum() {
    for (const v of arguments) {
      const n = num(v);
      if (n != null) return n;
    }
    return null;
  }
  function median(values) {
    const s = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function isRunType(text) {
    return /run|jog|tempo|interval|threshold|long|fartlek|race|foundation|stability|recovery|easy|steady/i.test(
      String(text || "")
    );
  }

  const QUALITY_RE = /threshold|tempo|interval|vo2|repetition|rep\b|reps|race|time.?trial|fartlek|speed|cruise|blocks/i;
  const HIGH_RE = /interval|vo2|repetition|rep\b|reps|speed|race|time.?trial|fartlek/i;
  const THRESH_RE = /threshold|tempo|cruise/i;
  const EASY_RE = /easy|recovery|long|foundation|steady|base|jog|shakeout|stability/i;

  // Canonical intensity bucket from a type string. Unnamed/plain runs are
  // treated as easy for volume but NOT counted as quality/threshold/high —
  // we never infer intensity from pace alone.
  function classify(typeText) {
    const t = String(typeText || "").toLowerCase();
    if (!t) return { intensity: "easy", quality: false, known: false };
    if (HIGH_RE.test(t)) return { intensity: "high", quality: true, known: true };
    if (THRESH_RE.test(t)) return { intensity: "threshold", quality: true, known: true };
    if (EASY_RE.test(t)) return { intensity: "easy", quality: false, known: true };
    return { intensity: "easy", quality: false, known: false };
  }

  /* ───────────────── merge + de-duplicate sources ──────────────────── */

  /*
   * Builds a single de-duplicated list of training items from execution
   * records (higher priority) and imported activities. `activities` are
   * assumed already corrected upstream (mergeActivityOverrides), which is
   * how a corrected activity overrides the raw one.
   */
  // Public entry: merged + de-duplicated items (one row per real activity).
  function mergeTrainingItems(activities, executions) {
    return dedupeItems(mergeTrainingItemsRaw(activities, executions));
  }

  // Builds the raw item list (executions win over their linked import via the
  // `consumed` set), but does NOT de-duplicate cross-source — dedupeItems does.
  function mergeTrainingItemsRaw(activities, executions) {
    const acts = Array.isArray(activities) ? activities : [];
    const execs = Array.isArray(executions) ? executions : [];

    const activityById = new Map();
    acts.forEach(a => {
      if (a && a.id != null) activityById.set(String(a.id), a);
    });

    const consumed = new Set();
    execs.forEach(e => {
      if (e && e.imported_activity_id != null) {
        consumed.add(String(e.imported_activity_id));
      }
    });

    const items = [];

    // Execution records (priority 3 / 5) win over the raw activity.
    execs.forEach(e => {
      const status = e.status;
      if (status !== "completed" && status !== "modified" && status !== "skipped") {
        return; // "planned" with no report contributes nothing
      }
      const snap = e.original_session_snapshot || {};
      const linked =
        e.imported_activity_id != null
          ? activityById.get(String(e.imported_activity_id))
          : null;

      const linkedDurMin =
        linked && num(linked.moving_time_seconds) != null
          ? num(linked.moving_time_seconds) / 60
          : null;
      const linkedKm =
        linked && num(linked.distance_meters) != null
          ? num(linked.distance_meters) / 1000
          : null;

      const performed = status !== "skipped";
      const durationMin = performed
        ? firstNum(e.actual_duration_minutes, linkedDurMin, snap.duration_minutes)
        : 0;
      // VOLUME must reflect what was actually RUN, never the planned target.
      // Use the reported actual distance or the linked import; do NOT fall
      // back to the planned snapshot distance (snap.distance_km) — counting a
      // plan target as completed volume is what inflated the weekly total.
      const distanceKm = performed
        ? firstNum(e.actual_distance_km, linkedKm)
        : 0;

      const typeText = snap.session_type || (linked && (linked.sport_type || linked.activity_type)) || "";
      const cls = classify(typeText);

      items.push({
        source: linked ? "matched_execution" : "manual_execution",
        priority: linked ? 5 : 3,
        status,
        performed,
        timestamp: e.completed_at || e.updated_at || (snap.session_date ? snap.session_date + "T12:00:00Z" : null) || e.created_at || null,
        isRun: isRunType(typeText) || cls.intensity !== null,
        distanceKm: distanceKm != null ? distanceKm : 0,
        durationMin: durationMin != null ? durationMin : 0,
        type: typeText || null,
        intensity: cls.intensity,
        quality: cls.quality && performed,
        knownIntensity: cls.known,
        hr: firstNum(e.actual_average_hr, linked && linked.average_heartrate),
        rpe: num(e.actual_rpe),
        trainer: linked ? linked.trainer === true : false,
        painPresent: e.pain_present === true,
        skipReason: e.skip_reason || null,
        activityId: e.imported_activity_id != null ? String(e.imported_activity_id) : null,
        providerId: linked && linked.external_activity_id != null ? String(linked.external_activity_id) : null,
        sport: (linked && (linked.sport_type || linked.activity_type)) || snap.session_type || null,
        sessionId: e.training_session_id != null ? String(e.training_session_id) : null,
        elevation: linked ? num(linked.elevation_gain_meters) : null
      });
    });

    // Raw / corrected imported activities not already consumed (priority 6).
    // Guard against duplicate imports of the SAME activity id (a listed cause
    // of the inflated weekly volume): each activity is counted at most once.
    const seenActivityIds = new Set();
    acts.forEach(a => {
      if (a && a.id != null && consumed.has(String(a.id))) return;
      if (a && a.id != null) {
        const key = String(a.id);
        if (seenActivityIds.has(key)) return;
        seenActivityIds.add(key);
      }
      const durationMin = num(a.moving_time_seconds) != null ? num(a.moving_time_seconds) / 60 : null;
      const distanceKm = num(a.distance_meters) != null ? num(a.distance_meters) / 1000 : null;
      const typeText = a.sport_type || a.activity_type || a.name || "";
      const cls = classify(typeText);
      const paceSec =
        distanceKm && durationMin && distanceKm > 0
          ? (durationMin * 60) / distanceKm
          : null;

      items.push({
        source: "imported_activity",
        priority: 6,
        status: "activity",
        performed: true,
        timestamp: a.start_date || null,
        isRun: isRunType(typeText),
        distanceKm: distanceKm != null ? distanceKm : 0,
        durationMin: durationMin != null ? durationMin : 0,
        type: typeText || null,
        intensity: cls.intensity,
        quality: cls.quality,
        knownIntensity: cls.known,
        hr: num(a.average_heartrate),
        paceSec,
        rpe: null,
        trainer: a.trainer === true,
        painPresent: false,
        skipReason: null,
        activityId: a.id != null ? String(a.id) : null,
        providerId: a.external_activity_id != null ? String(a.external_activity_id) : null,
        sport: a.sport_type || a.activity_type || null,
        sessionId: null,
        elevation: num(a.elevation_gain_meters)
      });
    });

    return items.filter(i => i.timestamp);
  }

  /* ───────────────────────── deduplication ──────────────────────────── */

  /*
   * Deterministic identity for an activity/execution item. Priority:
   *   1. provider activity id  (same Strava activity re-imported by repeated
   *      syncs → one row)
   *   2. canonical internal activity id
   *   3. fingerprint: start-minute + sport + rounded distance + rounded
   *      duration (catches a manual plan record + its matching import, and
   *      duplicate rows with no shared id — WITHOUT merging two genuinely
   *      separate runs, which differ in start time).
   */
  function dedupKey(it) {
    if (it.providerId) return "p:" + it.providerId;
    if (it.activityId) return "c:" + it.activityId;
    const t = Date.parse(it.timestamp);
    const minute = Number.isFinite(t) ? Math.round(t / 60000) : "na";
    const sport = String(it.sport || (it.isRun ? "run" : "other")).toLowerCase();
    const dist = it.distanceKm ? Math.round(it.distanceKm * 10) / 10 : 0;
    const dur = it.durationMin ? Math.round(it.durationMin) : 0;
    return `f:${minute}|${sport}|${dist}|${dur}`;
  }

  // Two items describe the SAME activity when they share a provider id or a
  // canonical id, OR (cross-source: a manual plan record vs its import) when a
  // fuzzy fingerprint matches — same start (±15 min), distance (±5%) and
  // duration (±12%). Different start times keep two separate same-day runs apart.
  function near(x, y, tol) {
    x = Number(x); y = Number(y);
    if (!(x > 0) || !(y > 0)) return false;
    return Math.abs(x - y) / Math.max(x, y) <= tol;
  }
  function sameActivity(a, b) {
    if (a.providerId && b.providerId && a.providerId === b.providerId) return true;
    if (a.activityId && b.activityId && a.activityId === b.activityId) return true;
    const ta = Date.parse(a.timestamp), tb = Date.parse(b.timestamp);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
    if (Math.abs(ta - tb) > 15 * 60000) return false;
    if (!near(a.distanceKm, b.distanceKm, 0.05)) return false;
    if (a.durationMin > 0 && b.durationMin > 0 && !near(a.durationMin, b.durationMin, 0.12)) return false;
    return true;
  }

  // Keep the richest record per activity: a MEASURED import / matched execution
  // is preferred over a manual plan record for the same run.
  const KEEP_RANK = { matched_execution: 0, imported_activity: 1, manual_execution: 2 };
  function dedupeItems(items) {
    const order = items.slice().sort((x, y) => (KEEP_RANK[x.source] ?? 3) - (KEEP_RANK[y.source] ?? 3));
    const kept = [];
    order.forEach(it => { if (!kept.some(k => sameActivity(it, k))) kept.push(it); });
    return kept;
  }

  /*
   * DEV-ONLY diagnostic: reports exactly which activities are counted in the
   * current local week and which are excluded (and why). Not shown to users;
   * call window.AthlevoTrends.diagnoseCurrentWeek() from the console. The
   * visible total is computed from this same included set.
   */
  function diagnoseCurrentWeek(activities, executions, opts) {
    opts = opts || {};
    const C = window.AthlevoCalendar;
    const tz = C.resolveTimezone(opts.timezone);
    const now = opts.now || new Date();
    const win = C.weekWindows(now, tz).thisWeek;

    const raw = mergeTrainingItemsRaw(activities, executions); // pre-dedupe
    const keyOf = new Map();
    const deduped = dedupeItems(raw.filter(i => i.timestamp));
    const keptKeys = new Set(deduped.map(dedupKey));
    const rows = [];
    let includedKm = 0;
    raw.forEach(it => {
      const inWeek = C.inWindow(it.timestamp, win, tz);
      const isRun = it.isRun && it.performed && !it.trainer;
      const key = dedupKey(it);
      const kept = deduped.includes(it);
      let included = false, reason = "";
      if (!it.performed) reason = "not performed / skipped";
      else if (!it.isRun) reason = "non-running sport";
      else if (it.trainer) reason = "indoor/treadmill (trainer)";
      else if (!inWeek) reason = "outside local Mon–Sun week";
      else if (!kept) reason = "duplicate of " + (keyOf.get(key) || "another record");
      else { included = true; reason = "counted"; includedKm += (it.distanceKm || 0); }
      if (kept) keyOf.set(key, it.activityId || it.providerId || "fingerprint");
      rows.push({
        activityId: it.activityId, providerId: it.providerId,
        date: it.timestamp, sport: it.sport, distanceKm: it.distanceKm,
        durationMin: Math.round(it.durationMin || 0), source: it.source,
        dedupKey: key, included, reason
      });
    });
    const includedRows = rows.filter(r => r.included);
    const total = Math.round(includedKm * 10) / 10;
    // eslint-disable-next-line no-console
    console.table(rows);
    console.log(`Current-week running volume: ${total} km from ${includedRows.length} activities`);
    return { total, included: includedRows, all: rows, timezone: tz };
  }

  /* ─────────────────────── per-window metrics ──────────────────────── */

  // Long run: ≥ 90 min, or ≥ 1.5× the athlete's median run distance.
  function longThresholdKm(items) {
    const runKms = items.filter(i => i.isRun && i.performed && i.distanceKm > 0).map(i => i.distanceKm);
    const med = median(runKms);
    return med != null ? Math.max(14, med * 1.5) : 16;
  }

  function windowMetrics(windowItems, longKm) {
    const runs = windowItems.filter(i => i.isRun && i.performed);
    const runVolume = runs.reduce((s, i) => s + (i.distanceKm || 0), 0);
    const runDuration = runs.reduce((s, i) => s + (i.durationMin || 0), 0);
    const totalDuration = windowItems
      .filter(i => i.performed)
      .reduce((s, i) => s + (i.durationMin || 0), 0);

    const completedPlanned = windowItems.filter(i => i.status === "completed").length;
    const modifiedPlanned = windowItems.filter(i => i.status === "modified").length;
    const skippedPlanned = windowItems.filter(i => i.status === "skipped").length;
    const recordedPlanned = completedPlanned + modifiedPlanned + skippedPlanned;

    const qualityCount = windowItems.filter(i => i.quality && i.performed).length;

    const longRuns = runs.filter(i => (i.durationMin >= 90) || (i.distanceKm >= longKm));

    const easyVol = runs.filter(i => i.intensity === "easy").reduce((s, i) => s + (i.distanceKm || 0), 0);
    const threshVol = runs.filter(i => i.intensity === "threshold").reduce((s, i) => s + (i.distanceKm || 0), 0);
    const highVol = runs.filter(i => i.intensity === "high").reduce((s, i) => s + (i.distanceKm || 0), 0);

    // Session load (sRPE) is only valid when RPE is present; never invented.
    const withRpe = windowItems.filter(i => i.performed && num(i.rpe) != null && i.durationMin > 0);
    const sessionLoad = withRpe.length
      ? Math.round(withRpe.reduce((s, i) => s + i.durationMin * i.rpe, 0))
      : null;
    const loadValid = withRpe.length > 0 && withRpe.length >= Math.ceil(runs.length / 2);

    // Consistency: completion rate among recorded planned sessions.
    const consistencyPct = recordedPlanned > 0
      ? Math.round((completedPlanned / recordedPlanned) * 100)
      : null;

    return {
      runDistanceKm: Math.round(runVolume * 10) / 10,
      runDurationMin: Math.round(runDuration),
      totalTrainingMin: Math.round(totalDuration),
      runCount: runs.length,
      qualityCount,
      completedPlanned,
      modifiedPlanned,
      skippedPlanned,
      longRunCount: longRuns.length,
      sessionLoad: loadValid ? sessionLoad : null,
      sessionLoadValid: loadValid,
      easyVolumeKm: Math.round(easyVol * 10) / 10,
      thresholdVolumeKm: Math.round(threshVol * 10) / 10,
      highIntensityVolumeKm: Math.round(highVol * 10) / 10,
      consistencyPct
    };
  }

  /* ───────────────────────── safe diffs ────────────────────────────── */

  /*
   * A human diff that never shows NaN, Infinity, or a misleading %:
   *   both zero      → "Same as last week"
   *   equal          → "Same as last week"
   *   prev 0, cur >0 → "Up N<unit>" (no % — nothing to compare against)
   *   otherwise      → "Up/Down N<unit>" + % only when prev > 0
   */
  function diff(current, previous, unit, opts) {
    opts = opts || {};
    const cur = num(current) || 0;
    const prev = num(previous) || 0;
    const u = unit ? ` ${unit}` : "";
    const fmt = n => {
      const r = opts.decimals != null ? Number(n.toFixed(opts.decimals)) : Math.round(n);
      return `${r}${u}`;
    };

    if (cur === prev) {
      return { text: "Same as last week", absolute: 0, percent: 0, comparable: true };
    }
    const delta = cur - prev;
    const word = delta > 0 ? "Up" : "Down";

    if (prev === 0) {
      return {
        text: `${word} ${fmt(Math.abs(delta))}`,
        absolute: delta,
        percent: null,
        comparable: false
      };
    }

    const percent = Math.round((delta / prev) * 100);
    const showPct = Number.isFinite(percent) && Math.abs(percent) >= 1;
    return {
      text: `${word} ${fmt(Math.abs(delta))}${showPct ? ` (${delta > 0 ? "+" : ""}${percent}%)` : ""}`,
      absolute: delta,
      percent: Number.isFinite(percent) ? percent : null,
      comparable: true
    };
  }

  /* ─────────────────── comparable-performance rules ─────────────────── */

  /*
   * Finds two genuinely comparable EASY runs (same intensity, similar
   * duration, both outdoor, HR present on both, not a race) and reports a
   * cautious pace-at-HR observation. Returns a narrative fragment or a
   * limitation string — never an unsupported fitness claim.
   */
  function comparableEasyRuns(items) {
    const easy = items
      .filter(i =>
        i.isRun && i.performed && i.intensity === "easy" &&
        i.status !== "skipped" && !i.trainer &&
        num(i.hr) != null && i.durationMin > 0 && i.distanceKm > 0 &&
        !QUALITY_RE.test(String(i.type || ""))
      )
      .map(i => ({
        ...i,
        paceSec: i.paceSec != null ? i.paceSec : (i.durationMin * 60) / i.distanceKm,
        ts: Date.parse(i.timestamp)
      }))
      .filter(i => Number.isFinite(i.paceSec) && Number.isFinite(i.ts))
      .sort((a, b) => b.ts - a.ts);

    for (let a = 0; a < easy.length; a += 1) {
      for (let b = a + 1; b < easy.length; b += 1) {
        const A = easy[a], B = easy[b];
        const durRatio = A.durationMin / B.durationMin;
        const hrClose = Math.abs(A.hr - B.hr) <= 3;
        const durClose = durRatio >= 0.75 && durRatio <= 1.33;
        if (hrClose && durClose) {
          const paceDelta = Math.round(B.paceSec - A.paceSec); // + => A faster
          if (Math.abs(paceDelta) < 2) {
            return {
              comparable: true,
              improved: false,
              text: "Two comparable easy runs held a similar pace at a similar average heart rate."
            };
          }
          const faster = paceDelta > 0;
          return {
            comparable: true,
            improved: faster,
            text: `Two comparable easy runs were about ${Math.abs(paceDelta)} sec/km ${faster ? "faster" : "slower"} at a similar average heart rate.`
          };
        }
      }
    }
    return {
      comparable: false,
      improved: false,
      text: "There are not enough comparable runs yet to claim a change in efficiency."
    };
  }

  /* ─────────────────────── build full trends ───────────────────────── */

  function buildTrends(activities, executions, opts) {
    opts = opts || {};
    const C = window.AthlevoCalendar;
    const tz = C.resolveTimezone(opts.timezone);
    const now = opts.now || new Date();

    const items = mergeTrainingItems(activities, executions);
    const longKm = longThresholdKm(items);

    const wins = C.weekWindows(now, tz);
    const pick = w => items.filter(i => C.inWindow(i.timestamp, w, tz));

    const thisWeek = windowMetrics(pick(wins.thisWeek), longKm);
    const lastSame = windowMetrics(pick(wins.lastWeekSamePeriod), longKm);
    const prevFull = windowMetrics(pick(wins.prevFullWeek), longKm);

    // Six calendar weeks (Mon–Sun), oldest→newest, last is in progress.
    const weeks = C.sixWeeks(now, tz);
    const series = weeks.map(w => {
      const wi = items.filter(i => C.bucketIndex(i.timestamp, weeks, tz) === w.index);
      const m = windowMetrics(wi, longKm);
      return {
        label: w.label,
        inProgress: w.inProgress,
        distanceKm: m.runDistanceKm,
        runDurationMin: m.runDurationMin,
        totalTrainingMin: m.totalTrainingMin,
        sessionLoad: m.sessionLoad,
        completionRate: m.consistencyPct
      };
    });

    const diffs = {
      runDistanceKm: diff(thisWeek.runDistanceKm, lastSame.runDistanceKm, "km", { decimals: 1 }),
      runDurationMin: diff(thisWeek.runDurationMin, lastSame.runDurationMin, "min"),
      totalTrainingMin: diff(thisWeek.totalTrainingMin, lastSame.totalTrainingMin, "min"),
      runCount: diff(thisWeek.runCount, lastSame.runCount, ""),
      qualityCount: diff(thisWeek.qualityCount, lastSame.qualityCount, ""),
      completedPlanned: diff(thisWeek.completedPlanned, lastSame.completedPlanned, ""),
      longRunCount: diff(thisWeek.longRunCount, lastSame.longRunCount, ""),
      easyVolumeKm: diff(thisWeek.easyVolumeKm, lastSame.easyVolumeKm, "km", { decimals: 1 }),
      thresholdVolumeKm: diff(thisWeek.thresholdVolumeKm, lastSame.thresholdVolumeKm, "km", { decimals: 1 }),
      highIntensityVolumeKm: diff(thisWeek.highIntensityVolumeKm, lastSame.highIntensityVolumeKm, "km", { decimals: 1 })
    };

    const comparable = comparableEasyRuns(items);
    const narrative = buildNarrative({ thisWeek, lastSame, prevFull, diffs, comparable });

    return {
      timezone: tz,
      thisWeekLabel: wins.thisWeekLabel,
      thisWeek, lastWeekSamePeriod: lastSame, prevFullWeek: prevFull,
      diffs, series, comparable, narrative,
      hasData: items.length > 0
    };
  }

  /* ─────────────────────── deterministic narrative ─────────────────── */

  function buildNarrative(ctx) {
    const { thisWeek, diffs, comparable } = ctx;
    const parts = [];

    if (thisWeek.completedPlanned + thisWeek.modifiedPlanned + thisWeek.skippedPlanned > 0) {
      const planned = thisWeek.completedPlanned + thisWeek.modifiedPlanned + thisWeek.skippedPlanned;
      parts.push(`You completed ${thisWeek.completedPlanned} of ${planned} recorded sessions this week.`);
    } else if (thisWeek.runCount > 0) {
      parts.push(`You've logged ${thisWeek.runCount} run${thisWeek.runCount === 1 ? "" : "s"} so far this week.`);
    }

    if (diffs.runDistanceKm.comparable && diffs.runDistanceKm.absolute !== 0) {
      const d = diffs.runDistanceKm;
      parts.push(`That's ${d.text.toLowerCase()} versus the same point last week.`);
    } else if (!diffs.runDistanceKm.comparable && thisWeek.runDistanceKm > 0) {
      parts.push("There isn't a comparable period last week to measure against yet.");
    }

    if (comparable.comparable) {
      parts.push(comparable.text);
    } else if (thisWeek.runDistanceKm > 0) {
      parts.push("This week's volume is here, but there isn't enough comparable performance data yet to confirm improved fitness.");
    }

    if (thisWeek.longRunCount === 0 && thisWeek.runCount > 0) {
      parts.push("Long-run durability is the main thing still to build.");
    }

    if (!parts.length) {
      return "Import or log a few sessions and your weekly progress will appear here.";
    }
    return parts.join(" ");
  }

  /* ═══════════════════════════ rendering ═══════════════════════════ */

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const METRIC_ROWS = [
    { key: "runDistanceKm", label: "Running distance", unit: "km", d: 1, diff: "runDistanceKm" },
    { key: "runDurationMin", label: "Running duration", unit: "min", diff: "runDurationMin" },
    { key: "totalTrainingMin", label: "Total training", unit: "min", diff: "totalTrainingMin" },
    { key: "runCount", label: "Number of runs", unit: "", diff: "runCount" },
    { key: "qualityCount", label: "Quality sessions", unit: "", diff: "qualityCount" },
    { key: "completedPlanned", label: "Completed sessions", unit: "", diff: "completedPlanned" },
    { key: "modifiedPlanned", label: "Modified sessions", unit: "" },
    { key: "skippedPlanned", label: "Skipped sessions", unit: "" },
    { key: "longRunCount", label: "Long runs", unit: "", diff: "longRunCount" },
    { key: "easyVolumeKm", label: "Easy volume", unit: "km", d: 1, diff: "easyVolumeKm" },
    { key: "thresholdVolumeKm", label: "Threshold volume", unit: "km", d: 1, diff: "thresholdVolumeKm" },
    { key: "highIntensityVolumeKm", label: "High-intensity volume", unit: "km", d: 1, diff: "highIntensityVolumeKm" }
  ];

  function fmtVal(v, unit, d) {
    if (v == null) return "—";
    const n = d != null ? Number(v).toFixed(d) : Math.round(v);
    return unit ? `${n} ${unit}` : `${n}`;
  }

  function renderTrends(trends, targetKm) {
    const narr = document.getElementById("trendNarrative");
    if (narr) narr.textContent = trends.narrative;

    const label = document.getElementById("trendWeekLabel");
    if (label) label.textContent = `This week · ${trends.thisWeekLabel} (in progress)`;

    const metricsHost = document.getElementById("trendMetrics");
    if (metricsHost) {
      metricsHost.innerHTML = METRIC_ROWS.map(row => {
        const cur = trends.thisWeek[row.key];
        const dv = row.diff ? trends.diffs[row.diff] : null;
        const sessionLoadNote =
          row.key === "totalTrainingMin" && trends.thisWeek.sessionLoad != null
            ? ` · load ${trends.thisWeek.sessionLoad}`
            : "";
        return `
          <div class="tm-row">
            <div class="tm-left">
              <span class="tm-label">${esc(row.label)}</span>
              <span class="tm-cur">${esc(fmtVal(cur, row.unit, row.d))}${esc(sessionLoadNote)}</span>
            </div>
            <span class="tm-diff${dv && !dv.comparable ? " muted" : ""}">${esc(dv ? dv.text : "—")}</span>
          </div>`;
      }).join("");
    }

    renderBlockProgress(trends, targetKm);
    renderSixWeekChart(trends.series, targetKm);
  }

  // Part 6: "Current Week 33.7 / 75 km · 45%" + a horizontal bar, plus the
  // Part 7 comparison vs. the same weekday last week (reusing the diff).
  function renderBlockProgress(trends, targetKm) {
    const host = document.getElementById("trendBlockProgress");
    if (!host) return;
    const cur = Number(trends.thisWeek.runDistanceKm) || 0;
    const target = Number(targetKm) > 0 ? Number(targetKm) : null;
    const pct = target ? Math.max(0, Math.min(100, Math.round((cur / target) * 100))) : null;

    const dv = trends.diffs.runDistanceKm;
    let cmp = "";
    if (dv && dv.comparable && dv.absolute !== 0) {
      const abs = `${dv.absolute > 0 ? "+" : "−"}${Math.abs(dv.absolute).toFixed(1)} km`;
      const pctTxt = dv.percent != null && Math.abs(dv.percent) >= 1 ? ` · ${dv.percent > 0 ? "+" : ""}${dv.percent}%` : "";
      cmp = `<span class="tbp-cmp up">${esc(abs)}${esc(pctTxt)} vs same day last week</span>`;
    } else if (dv && !dv.comparable && cur > 0) {
      cmp = `<span class="tbp-cmp muted">No comparable day last week yet</span>`;
    } else if (dv && dv.absolute === 0) {
      cmp = `<span class="tbp-cmp muted">Same as last week</span>`;
    }

    host.innerHTML = `
      <div class="tbp">
        <div class="tbp-top">
          <span class="tbp-label">Current week</span>
          <span class="tbp-val">${cur.toFixed(1)}${target ? ` / ${Math.round(target)}` : ""} km${pct != null ? ` · ${pct}%` : ""}</span>
        </div>
        <div class="tbp-bar"><i style="width:${pct != null ? pct : Math.min(100, cur > 0 ? 100 : 0)}%"></i></div>
        ${cmp}
      </div>`;
  }

  function renderSixWeekChart(series, targetKm) {
    const chart = document.getElementById("trendWeeklyVolumeChart");
    if (!chart) return;
    chart.innerHTML = "";
    if (!series || !series.length) {
      const p = document.createElement("p");
      p.textContent = "No weekly activity history available.";
      chart.appendChild(p);
      return;
    }
    const reduce = (() => {
      try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
      catch (e) { return false; }
    })();
    const target = Number(targetKm) > 0 ? Number(targetKm) : 0;
    const maxKm = Math.max(...series.map(w => w.distanceKm || 0), target, 1);

    series.forEach(w => {
      const km = w.distanceKm || 0;
      const h = Math.max((km / maxKm) * 100, km > 0 ? 6 : 1.5);

      const col = document.createElement("div");
      col.className = "tw-col" + (w.inProgress ? " current" : "");

      const value = document.createElement("small");
      value.className = "tw-val";
      value.textContent = km > 0 ? km.toFixed(0) : "";

      const track = document.createElement("div");
      track.className = "tw-track";

      // Current week: red, and (when a target exists) an OUTLINED remainder
      // up to the planned volume — the "future" portion of the week.
      if (w.inProgress) {
        if (target > 0 && target > km) {
          const remH = Math.max(0, Math.min(100, (target / maxKm) * 100)) - h;
          if (remH > 0) {
            const rem = document.createElement("div");
            rem.className = "tw-rem";
            rem.style.height = `${remH}%`;
            track.appendChild(rem);
          }
        }
        const bar = document.createElement("div");
        bar.className = "tw-bar current";
        bar.style.height = reduce ? `${h}%` : "0%";
        track.appendChild(bar);
        if (!reduce) requestAnimationFrame(() => { bar.style.height = `${h}%`; });
      } else {
        const bar = document.createElement("div");
        bar.className = "tw-bar past";
        bar.style.height = `${h}%`;
        track.appendChild(bar);
      }

      const lab = document.createElement("small");
      lab.className = "tw-lab";
      // Keep every column's label the same short width (date). The current
      // week is highlighted by colour + the ".current" class, not by wider
      // text, so all six columns stay perfectly aligned.
      lab.textContent = w.label;

      col.appendChild(value);
      col.appendChild(track);
      col.appendChild(lab);
      chart.appendChild(col);
    });
  }

  /* ─────────────────── load + refresh (client glue) ─────────────────── */

  async function loadExecutionRecords(userId) {
    try {
      const { data } = await supabaseClient
        .from("workout_execution_records")
        .select(
          "status,completed_at,updated_at,created_at,actual_duration_minutes,actual_distance_km,actual_average_pace,actual_average_hr,actual_rpe,overall_feeling,pain_present,skip_reason,original_session_snapshot,imported_activity_id,manual_activity_override,training_session_id"
        )
        .eq("user_id", userId);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  }

  // Public. `activities` should be the override-applied array; if omitted
  // we load raw. `profile` supplies the athlete timezone.
  async function refresh(activities, profile) {
    const host = document.getElementById("trendMetrics");
    if (!host && !document.getElementById("trendNarrative")) return null;
    try {
      const {
        data: { user }
      } = await supabaseClient.auth.getUser();
      if (!user) return null;

      let acts = activities;
      if (!Array.isArray(acts) && window.AthlevoBrain) {
        acts = await window.AthlevoBrain.loadAthleteActivities(200);
      }
      const executions = await loadExecutionRecords(user.id);

      const trends = buildTrends(acts || [], executions, {
        timezone: profile && profile.timezone,
        now: new Date()
      });
      // Planned weekly volume (athlete's reported target) drives the block
      // progress denominator when available.
      const targetKm = profile && Number(profile.weekly_distance) > 0
        ? Number(profile.weekly_distance) : null;
      renderTrends(trends, targetKm);
      return trends;
    } catch (error) {
      console.error("Trends refresh failed:", error);
      return null;
    }
  }

  window.AthlevoTrends = {
    // pure engine (exported for tests)
    mergeTrainingItems,
    mergeTrainingItemsRaw,
    dedupeItems,
    dedupKey,
    windowMetrics,
    diff,
    comparableEasyRuns,
    buildTrends,
    buildNarrative,
    longThresholdKm,
    // dev-only diagnostic (not shown to users)
    diagnoseCurrentWeek,
    // glue
    refresh,
    renderTrends
  };
  window.refreshTrends = refresh;
})();
