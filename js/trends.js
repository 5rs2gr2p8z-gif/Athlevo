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

  /*
   * SEED intensity from a type string only. This is NOT a competing
   * classifier: it delegates its keyword→type decision to the canonical
   * engine (AthlevoWorkoutClassifier) so there is ONE keyword vocabulary,
   * and every item is then overwritten by the full canonical classification
   * in applyClassification() (laps → plan → title → metrics). Kept as a
   * seed/fallback for callers that run before the engine is available.
   */
  function classify(typeText) {
    const t = String(typeText || "").toLowerCase();
    if (!t) return { intensity: "easy", quality: false, known: false };

    const W = (typeof window !== "undefined") ? window.AthlevoWorkoutClassifier : null;
    if (W && typeof W.titleType === "function" && typeof W.intensityOf === "function") {
      // Canonical keyword vocabulary + intensity mapping (single source).
      const type = W.titleType(t);
      if (type) {
        const intensity = W.intensityOf(type);
        return { intensity, quality: intensity !== "easy", known: true };
      }
      return { intensity: "easy", quality: false, known: false };
    }

    // Engine not loaded yet — minimal legacy seed (still overwritten later).
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
  // `zones` (optional athlete pace zones) enables STRUCTURE-AWARE intensity
  // classification via the workout recognition engine.
  function mergeTrainingItems(activities, executions, zones) {
    return dedupeItems(mergeTrainingItemsRaw(activities, executions, zones));
  }

  /*
   * Structure-aware intensity for one run item, using the workout recognition
   * engine (laps → plan → title → summary ensemble). Overwrites the text-only
   * intensity/quality with the recognized values and adds a per-intensity km
   * split so ONLY the quality portion of a mixed session counts as threshold/
   * high volume. No-op when the engine or zones are unavailable (falls back to
   * the original text classification → mileage totals never change).
   */
  function applyClassification(it, zones) {
    if (!it || !it.isRun || !it.performed) return;
    var W = (typeof window !== "undefined") ? window.AthlevoWorkoutClassifier : null;
    // Run whenever the engine is loaded. `zones` (VDOT pace zones) SHARPEN the
    // result but are NOT required: laps give true structure, and the planned
    // session / title are reliable on their own. Gating on zones was the bug
    // that discarded every recognition for athletes without a computed VDOT.
    if (!W) return;
    // A recognized manual correction always wins (set on the item upstream).
    if (it.correctedIntensity) {
      it.intensity = it.correctedIntensity;
      it.quality = it.intensity !== "easy";
      it.knownIntensity = true;
      it.qualityKm = it.qualityKm || { easy: it.intensity === "easy" ? (it.distanceKm || 0) : 0,
        threshold: it.intensity === "threshold" ? (it.distanceKm || 0) : 0,
        high: it.intensity === "high" ? (it.distanceKm || 0) : 0 };
      return;
    }
    var cls = W.classifyActivity({
      distanceKm: it.distanceKm, movingSec: (it.durationMin || 0) * 60, elapsedSec: it.elapsedSec,
      avgPaceSec: it.paceSec, avgHr: it.hr, maxHr: it.maxHr, maxSpeed: it.maxSpeed,
      laps: it.laps, name: it.title || it.type, title: it.title || it.type
    }, { zones: zones || null, planned: it.plannedSnapshot || null });
    it.intensity = cls.intensity;
    it.quality = cls.quality && it.performed;
    // Only credit the Score/quality-count from confident recognitions.
    it.knownIntensity = cls.confidence === "high" || cls.confidence === "moderate";
    it.qualityKm = cls.qualityKm;
    it.classification = {
      primaryType: cls.primaryType, confidence: cls.confidence, confidenceLabel: cls.confidenceLabel,
      secondary: cls.secondary, intervals: cls.intervals, estimated: cls.estimated
    };
  }

  // Builds the raw item list (executions win over their linked import via the
  // `consumed` set), but does NOT de-duplicate cross-source — dedupeItems does.
  function mergeTrainingItemsRaw(activities, executions, zones) {
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
        elevation: linked ? num(linked.elevation_gain_meters) : null,
        // Structure-aware classification inputs.
        title: (linked && linked.name) || typeText,
        maxHr: linked ? num(linked.max_heartrate) : num(e.actual_average_hr),
        maxSpeed: linked ? num(linked.max_speed_mps) : null,
        elapsedSec: linked ? num(linked.elapsed_time_seconds) : null,
        // Laps arrive either aliased (`laps:raw_data->laps` from the activity
        // loader) or nested under raw_data — accept both shapes.
        laps: linked ? (linked.laps || (linked.raw_data && (linked.raw_data.laps || linked.raw_data.splits)) || null) : null,
        plannedSnapshot: (snap && (snap.session_type || snap.main_set)) ? { session_type: snap.session_type, main_set: snap.main_set } : null
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
        elevation: num(a.elevation_gain_meters),
        // Structure-aware classification inputs.
        title: a.name || a.sport_type || a.activity_type || "",
        maxHr: num(a.max_heartrate),
        maxSpeed: num(a.max_speed_mps),
        elapsedSec: num(a.elapsed_time_seconds),
        laps: a.laps || (a.raw_data && (a.raw_data.laps || a.raw_data.splits)) || null,
        plannedSnapshot: null
      });
    });

    var kept = items.filter(i => i.timestamp);
    // Structure-aware intensity (safe no-op without the engine/zones).
    kept.forEach(it => applyClassification(it, zones));
    return kept;
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
    const distOk = near(a.distanceKm, b.distanceKm, 0.05);
    const durOk = !(a.durationMin > 0 && b.durationMin > 0) || near(a.durationMin, b.durationMin, 0.12);

    // Same imported run seen twice (repeat sync / device+phone upload):
    // tight start-time match.
    if (Math.abs(ta - tb) <= 15 * 60000 && distOk && durOk) return true;

    // A MANUAL plan record vs its measured import. The manual record's
    // timestamp is the COMPLETION time (often hours after the run, same day),
    // not the run start — so a 15-minute window misses it and the run gets
    // counted twice. Match on same-day + tight distance AND duration instead.
    // (Two genuinely different same-day runs would differ in distance or
    // duration, so they are NOT merged.)
    const aM = a.source === "manual_execution", bM = b.source === "manual_execution";
    if (aM !== bM && Math.abs(ta - tb) <= 20 * 3600000) {
      const bothDur = a.durationMin > 0 && b.durationMin > 0;
      if (near(a.distanceKm, b.distanceKm, 0.06) && (!bothDur || near(a.durationMin, b.durationMin, 0.12))) {
        return true;
      }
    }
    return false;
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

  function localDate(instant, tz) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(instant)); }
    catch (e) { return String(instant || "").slice(0, 10); }
  }

  /*
   * DEV-ONLY: privacy-safe per-activity CLASSIFICATION diagnostic over the
   * athlete's REAL loaded activities. Run in the console:
   *     await AthlevoTrends.diagnoseClassification()
   * Prints, per run: id, date, title, distance, duration, avg pace, avg/max HR,
   * laps yes/no, splits yes/no, planned-session yes/no, classifier type +
   * confidence, threshold/high km detected, and the reason.
   */
  async function diagnoseClassification(activities, executions) {
    const last = (window.AthlevoTrends && window.AthlevoTrends._last) || null;
    if (activities === undefined && last) { activities = last.activities; executions = last.executions; }
    if (activities === undefined) {
      try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        // Trends charts a 12-month view — needs the history window.
        activities = window.AthlevoBrain ? await window.AthlevoBrain.loadAthleteActivities("history") : [];
        executions = user ? await loadExecutionRecords(user.id) : [];
      } catch (e) { activities = activities || []; executions = executions || []; }
    }
    const zones = await loadAthleteZones();
    const items = mergeTrainingItems(activities || [], executions || [], zones);
    const fmtPace = s => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}/km` : "—");
    const rows = items.filter(i => i.isRun && i.performed).map(i => {
      const c = i.classification || {};
      const reason = i.laps ? "laps → structure" :
        (i.plannedSnapshot ? "planned session" :
          (/threshold|tempo|interval|vo2|rep|hill|race|tt/i.test(i.title || "") ? "title keyword" :
            (c.estimated ? "summary estimate" : "no quality signal → easy")));
      return {
        id: i.activityId || i.providerId, date: localDate(i.timestamp, "Asia/Manila"),
        title: (i.title || "").slice(0, 24), km: i.distanceKm != null ? Math.round(i.distanceKm * 10) / 10 : null,
        min: Math.round(i.durationMin || 0), avgPace: fmtPace(i.paceSec), avgHr: i.hr || "—", maxHr: i.maxHr || "—",
        laps: i.laps ? "yes(" + i.laps.length + ")" : "no", splits: "no",
        planned: i.plannedSnapshot ? (i.plannedSnapshot.session_type || "yes") : "no",
        type: c.primaryType || i.intensity, conf: c.confidence || "-",
        thresholdKm: i.qualityKm ? i.qualityKm.threshold : (i.intensity === "threshold" ? i.distanceKm : 0),
        highKm: i.qualityKm ? i.qualityKm.high : (i.intensity === "high" ? i.distanceKm : 0),
        reason
      };
    });
    const withZones = !!zones;
    const anyLaps = rows.some(r => r.laps !== "no");
    /* eslint-disable no-console */
    console.table(rows);
    console.log("VDOT zones available:", withZones, "| any activity has laps:", anyLaps,
      "| threshold sessions recognized:", rows.filter(r => r.thresholdKm > 0).length,
      "| speed/high recognized:", rows.filter(r => r.highKm > 0).length);
    if (!anyLaps) console.warn("No laps in stored history yet → re-sync Strava so lap structure is imported (recognition of untitled/unplanned runs depends on it).");
    /* eslint-enable no-console */
    return rows;
  }

  /*
   * DEV-ONLY diagnostic. Reports exactly which activities the CURRENT WEEK
   * total is built from. Called with NO arguments it reuses the SAME arrays
   * and result the Trends card last rendered (window.AthlevoTrends._last), so
   * its total is guaranteed identical to the visible card — never a separate
   * calculation. Pass explicit (activities, executions, opts) to test other data.
   */
  function diagnoseCurrentWeek(activities, executions, opts) {
    opts = opts || {};
    const last = (window.AthlevoTrends && window.AthlevoTrends._last) || null;
    if (activities === undefined && last) { activities = last.activities; executions = last.executions; }
    if (executions === undefined && last) { executions = last.executions; }
    activities = activities || [];
    executions = executions || [];

    const C = window.AthlevoCalendar;
    const tz = C.resolveTimezone(opts.timezone || (last && last.timezone));
    const now = opts.now || new Date();
    const win = C.weekWindows(now, tz).thisWeek;

    // Canonical total = the exact value the card renders (buildTrends).
    const trends = buildTrends(activities, executions, { timezone: tz, now });
    const canonicalTotal = trends.thisWeek.runDistanceKm;

    const raw = mergeTrainingItemsRaw(activities, executions);
    const deduped = dedupeItems(raw.filter(i => i.timestamp));
    let sumBefore = 0, sumWeek = 0, sumSport = 0, sumDedup = 0;
    const rows = raw.map(it => {
      const runish = it.isRun && it.performed && !it.trainer;
      const inWeek = C.inWindow(it.timestamp, win, tz);
      const kept = deduped.indexOf(it) !== -1;
      sumBefore += it.distanceKm || 0;
      if (inWeek) sumWeek += it.distanceKm || 0;
      if (inWeek && runish) sumSport += it.distanceKm || 0;
      let included = false, reason = "";
      if (!it.performed) reason = "not performed / skipped";
      else if (!it.isRun) reason = "non-running sport";
      else if (it.trainer) reason = "indoor/treadmill (trainer)";
      else if (!inWeek) reason = "outside local Mon–Sun week";
      else if (!kept) reason = "duplicate of an already-counted run (dedup)";
      else { included = true; reason = "counted"; sumDedup += it.distanceKm || 0; }
      return {
        activityId: it.activityId, providerId: it.providerId,
        rawTimestamp: it.timestamp, localDate: localDate(it.timestamp, tz),
        sport: it.sport, distanceKm: it.distanceKm, durationMin: Math.round(it.durationMin || 0),
        source: it.source, dedupKey: dedupKey(it), included, reason
      };
    });
    const w = C.weekWindows(now, tz);
    const included = rows.filter(r => r.included);
    /* eslint-disable no-console */
    console.table(rows);
    console.log("Timezone:", tz,
      "| week start:", localDate(w.thisWeek.start, tz), "→ end:", localDate(w.nowPseudo, tz));
    console.log("Staged sums →",
      "before filter:", Math.round(sumBefore * 10) / 10,
      "| after week:", Math.round(sumWeek * 10) / 10,
      "| after sport:", Math.round(sumSport * 10) / 10,
      "| after dedup:", Math.round(sumDedup * 10) / 10,
      "| card value:", canonicalTotal);
    console.log(`Current-week running volume: ${canonicalTotal} km from ${included.length} activities` +
      (last ? "  (using the arrays the Trends card last rendered)" : "  (using arrays you passed)"));
    /* eslint-enable no-console */
    return { total: canonicalTotal, included, all: rows, timezone: tz,
      stages: { before: sumBefore, afterWeek: sumWeek, afterSport: sumSport, afterDedup: sumDedup, card: canonicalTotal },
      usingRenderInputs: !!(last && activities === last.activities) };
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

    // Intensity volumes count only the QUALITY PORTION of a mixed session
    // (from the recognition engine's per-intensity km split); when no split is
    // present, fall back to the whole-run-by-bucket behaviour. Total run
    // volume (runVolume/runDistanceKm) is unchanged either way.
    const bucketKm = (i, bucket) =>
      i.qualityKm ? (i.qualityKm[bucket] || 0) : (i.intensity === bucket ? (i.distanceKm || 0) : 0);
    const easyVol = runs.reduce((s, i) => s + bucketKm(i, "easy"), 0);
    const threshVol = runs.reduce((s, i) => s + bucketKm(i, "threshold"), 0);
    const highVol = runs.reduce((s, i) => s + bucketKm(i, "high"), 0);

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

    const items = mergeTrainingItems(activities, executions, opts.zones || null);
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

  // Athlete pace zones (sec/km) for the workout recognition engine.
  async function loadAthleteZones() {
    try {
      const fitness = window.AthleteModel ? await window.AthleteModel.getFitness() : null;
      const vdot = fitness && fitness.vdot != null ? Number(fitness.vdot) : null;
      const P = window.AthlevoPerformance;
      if (vdot == null || !P || !P.trainingPaces) return null;
      const tp = P.trainingPaces(vdot);
      const sec = z => (z && z.secPerKm != null ? Number(z.secPerKm) : null);
      return {
        easySec: sec(tp.easy),
        thresholdSec: sec(tp.threshold),
        intervalSec: sec(tp.vo2),
        repetitionSec: sec(tp.repetition),
        maxHr: (fitness && (fitness.maxHr || fitness.hrMax)) || null
      };
    } catch (e) { return null; }
  }

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
        // Diagnostics mirror the Trends render, so use the same window.
        acts = await window.AthlevoBrain.loadAthleteActivities("history");
      }
      const executions = await loadExecutionRecords(user.id);

      // Athlete pace zones enable structure-aware workout recognition (which
      // portion of a run was threshold / VO2, etc.). Best-effort; if the
      // fitness/pace service isn't ready, classification falls back to
      // title/plan/summary signals — never blocks the render.
      const zones = await loadAthleteZones();

      const trends = buildTrends(acts || [], executions, {
        timezone: profile && profile.timezone,
        now: new Date(),
        zones
      });

      // ONE source of truth: record the EXACT arrays + result the card is
      // about to render, so window.AthlevoTrends.diagnoseCurrentWeek() (no
      // args) reports the same value the DOM shows — never a separate calc.
      window.AthlevoTrends._last = {
        activities: acts || [], executions,
        timezone: (window.AthlevoCalendar || {}).resolveTimezone
          ? window.AthlevoCalendar.resolveTimezone(profile && profile.timezone) : (profile && profile.timezone) || null,
        trends
      };

      // Dev-only trace of the exact value flowing into the DOM.
      if (window.__ATHLEVO_DEBUG_TRENDS) {
        try {
          const items = mergeTrainingItems(acts || [], executions);
          const bySource = items.reduce((m, i) => {
            if (i.isRun && i.performed && !i.trainer) m[i.source] = (m[i.source] || 0) + (i.distanceKm || 0);
            return m;
          }, {});
          console.log("%c[Trends] render source: buildTrends → renderTrends (js/trends.js)", "font-weight:bold");
          console.log("[Trends] deduped run volume by source:", bySource);
          console.log("[Trends] thisWeek.runDistanceKm (→ Current week + six-week bar):", trends.thisWeek.runDistanceKm);
          console.log("[Trends] thisWeek.easyVolumeKm (→ Easy volume row):", trends.thisWeek.easyVolumeKm);
          console.log("[Trends] value passed to DOM (#trendBlockProgress):", Number(trends.thisWeek.runDistanceKm).toFixed(1) + " km");
        } catch (e) { /* logging must never break render */ }
      }

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
    // dev-only diagnostics (not shown to users)
    diagnoseCurrentWeek,
    diagnoseClassification,
    // glue
    refresh,
    renderTrends
  };
  window.refreshTrends = refresh;
})();
