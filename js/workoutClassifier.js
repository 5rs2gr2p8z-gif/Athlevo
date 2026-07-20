/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Workout Recognition Engine  (structure-aware classifier)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Recognises WHAT a run actually was, not just its average pace. It uses
 *  every signal that is available for an activity, in priority order:
 *
 *    1. LAPS / SPLITS   (activity.laps | activity.splits | raw_data.laps) —
 *       true interval structure → highest confidence.
 *    2. PLANNED SESSION for that local date (session_type + main_set) — a
 *       strong intent signal when the athlete follows a plan.
 *    3. TITLE / DESCRIPTION keywords.
 *    4. SUMMARY ENSEMBLE — avg pace, MAX pace (from max_speed), avg HR,
 *       MAX HR vs the athlete's zones, moving-vs-elapsed ratio, elevation.
 *       A quality session diluted by warm-up / cool-down / recoveries has an
 *       EASY AVERAGE but a fast MAX and a hard MAX-HR — that is how we detect
 *       that quality happened inside an "easy-looking" run.
 *
 *  It NEVER classifies from average pace alone, and never claims High
 *  confidence without corroborating structure. When it must estimate the
 *  quality portion of a mixed session (no laps), it returns `estimated:true`.
 *
 *  Pure + deterministic. No I/O. Consumed by the volume/score path.
 */
(function (root) {
  "use strict";

  function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
  function lc(v) { return String(v == null ? "" : v).toLowerCase(); }

  var CONF = { high: "High", moderate: "Moderate", low: "Low", insufficient: "Insufficient data" };

  // Intensity zone for a work pace, given the athlete's pace zones (sec/km).
  function paceZone(paceSec, z) {
    if (paceSec == null || !z) return null;
    var thr = n(z.thresholdSec), vo2 = n(z.intervalSec || z.vo2Sec), easy = n(z.easySec), rep = n(z.repetitionSec);
    if (rep != null && paceSec <= rep * 1.02) return "rep";
    if (vo2 != null && paceSec <= vo2 * 1.02) return "vo2";
    if (thr != null && paceSec <= thr * 1.035) return "threshold";
    if (thr != null && paceSec <= thr * 1.09) return "tempo";
    if (easy != null && paceSec >= easy * 1.10) return "recovery";
    return "easy";
  }
  var HIGH_ZONES = { vo2: 1, rep: 1 };
  var THRESH_ZONES = { threshold: 1, tempo: 1, marathon: 1 };

  /* ───────────────────────── lap-based detection ─────────────────────── */

  function lapPaceSec(lap) {
    var d = n(lap.distance), t = n(lap.moving_time != null ? lap.moving_time : lap.elapsed_time);
    if (d && d > 0 && t && t > 0) return t / (d / 1000);
    if (n(lap.average_speed) > 0) return 1000 / n(lap.average_speed);
    return null;
  }

  /*
   * Group laps into WORK vs RECOVERY by pace, then find the repeated work
   * structure. Returns interval stats or null when laps aren't structured.
   */
  function detectFromLaps(laps, zones) {
    if (!Array.isArray(laps) || laps.length < 3) return null;
    var enriched = laps.map(function (l) {
      var p = lapPaceSec(l);
      return {
        paceSec: p,
        distanceM: n(l.distance) || 0,
        durSec: n(l.moving_time != null ? l.moving_time : l.elapsed_time) || 0,
        hr: n(l.average_heartrate),
        zone: paceZone(p, zones)
      };
    }).filter(function (l) { return l.paceSec != null && l.durSec > 0; });
    if (enriched.length < 3) return null;

    var paces = enriched.map(function (l) { return l.paceSec; }).slice().sort(function (a, b) { return a - b; });
    var fast = paces[Math.floor(paces.length * 0.25)];
    var slow = paces[Math.floor(paces.length * 0.75)];
    // Need a real fast/slow separation to be an interval session (>8% spread).
    if (!(slow - fast > fast * 0.08)) return null;
    var cut = (fast + slow) / 2;

    var work = enriched.filter(function (l) { return l.paceSec <= cut; });
    var recov = enriched.filter(function (l) { return l.paceSec > cut; });
    if (work.length < 2) return null;

    var workDur = work.reduce(function (s, l) { return s + l.durSec; }, 0);
    var workDist = work.reduce(function (s, l) { return s + l.distanceM; }, 0);
    var workPace = workDist > 0 ? workDur / (workDist / 1000) : null;
    var recSec = recov.length ? Math.round(recov.reduce(function (s, l) { return s + l.durSec; }, 0) / recov.length) : null;
    var zoneCounts = {};
    work.forEach(function (l) { if (l.zone) zoneCounts[l.zone] = (zoneCounts[l.zone] || 0) + 1; });
    var zone = Object.keys(zoneCounts).sort(function (a, b) { return zoneCounts[b] - zoneCounts[a]; })[0] || paceZone(workPace, zones);

    return {
      reps: work.length,
      workDurationSec: workDur,
      workDistanceM: Math.round(workDist),
      workPaceSec: workPace != null ? Math.round(workPace) : null,
      recoverySec: recSec,
      qualityDistanceKm: Math.round((workDist / 1000) * 100) / 100,
      qualityDurationSec: workDur,
      zone: zone
    };
  }

  var TYPE_FOR_ZONE = { rep: "Repetition", vo2: "VO2 / Interval", threshold: "Threshold", tempo: "Tempo / Control", marathon: "Marathon Pace" };

  function titleType(text) {
    var t = lc(text);
    if (!t) return null;
    if (/\btime.?trial\b|\btt\b/.test(t)) return "Time Trial";
    if (/\brace\b|parkrun|championship|10k race|5k race/.test(t)) return "Race";
    if (/\bbrick\b/.test(t)) return "Brick Run";
    if (/vo2|v-?o2|\binterval/.test(t)) return "VO2 / Interval";
    if (/threshold|\blt\b|cruise/.test(t)) return "Threshold";
    if (/tempo/.test(t)) return "Tempo / Control";
    if (/repetition|\breps?\b|200 ?m|400 ?m/.test(t)) return "Repetition";
    if (/hill/.test(t)) return "Hill Repeats";
    if (/marathon pace|\bmp\b|goal pace/.test(t)) return "Marathon Pace";
    if (/progression|negative split|fast finish/.test(t)) return "Progression Run";
    if (/strides|pick-?ups/.test(t)) return "Easy + Strides";
    if (/long run/.test(t)) return "Long Run";
    if (/recovery|shake ?out/.test(t)) return "Recovery";
    if (/steady/.test(t)) return "Steady";
    if (/easy|aerobic/.test(t)) return "Easy";
    return null;
  }

  function plannedType(planned) {
    if (!planned) return null;
    var s = lc(planned.session_type).replace(/[\s-]+/g, "_");
    var main = lc(Array.isArray(planned.main_set) ? planned.main_set.join(" ") : planned.main_set);
    if (/vo2|interval/.test(s + " " + main)) return "VO2 / Interval";
    if (/threshold|tempo/.test(s + " " + main)) return "Threshold";
    if (/repetition|rep/.test(s)) return "Repetition";
    if (/hill/.test(s)) return "Hill Repeats";
    if (/marathon_pace/.test(s)) return "Marathon Pace";
    if (/progression/.test(s)) return "Progression Run";
    if (/long/.test(s)) return "Long Run";
    if (/steady/.test(s)) return "Steady";
    if (/recovery/.test(s)) return "Recovery";
    if (/easy/.test(s)) return main && /strides/.test(main) ? "Easy + Strides" : "Easy";
    return null;
  }

  // Map a primary type to an intensity bucket used by volume + score.
  function intensityOf(type) {
    if (/VO2|Interval|Repetition|Hill|Time Trial|Race/.test(type)) return "high";
    if (/Threshold|Tempo|Marathon Pace/.test(type)) return "threshold";
    return "easy";
  }

  /*
   * Classify one activity. `a` carries whatever is available; missing signals
   * are simply skipped. `zones` = athlete pace zones (sec/km). `planned` =
   * the planned session for that local date (optional).
   */
  function classifyActivity(a, opts) {
    opts = opts || {};
    var zones = opts.zones || null;
    var planned = opts.planned || null;
    a = a || {};

    var distanceKm = n(a.distanceKm) != null ? n(a.distanceKm) : (n(a.distance_meters) != null ? n(a.distance_meters) / 1000 : null);
    var movingSec = n(a.movingSec) != null ? n(a.movingSec) : n(a.moving_time_seconds);
    var elapsedSec = n(a.elapsedSec) != null ? n(a.elapsedSec) : n(a.elapsed_time_seconds);
    var avgPace = n(a.avgPaceSec) != null ? n(a.avgPaceSec) : (distanceKm && movingSec ? movingSec / distanceKm : null);
    var avgHr = n(a.avgHr) != null ? n(a.avgHr) : n(a.average_heartrate);
    var maxHr = n(a.maxHr) != null ? n(a.maxHr) : n(a.max_heartrate);
    var maxSpeed = n(a.maxSpeed) != null ? n(a.maxSpeed) : n(a.max_speed_mps);
    var maxPaceSec = maxSpeed && maxSpeed > 0 ? 1000 / maxSpeed : null;
    var laps = a.laps || (a.raw_data && a.raw_data.laps) || a.splits || null;
    var title = a.title || a.name || "";

    var secondary = [];
    var estimated = false;
    var primary = null, confidence = "low", intervals = null;

    // ── 1. Laps → true structure (High) ───────────────────────────────
    var lap = detectFromLaps(laps, zones);
    if (lap) {
      intervals = lap;
      primary = TYPE_FOR_ZONE[lap.zone] || "Threshold";
      confidence = "high";
      secondary.push(lap.reps + " × work reps, ~" + Math.round(lap.workDurationSec / Math.max(1, lap.reps)) + "s each");
    }

    // ── 2. Planned session for that date ──────────────────────────────
    var pType = plannedType(planned);
    // ── 3. Title / description ────────────────────────────────────────
    var tType = titleType(title);

    if (!primary) {
      // ── 4. Summary ensemble: detect quality hidden inside an easy avg ──
      var maxZone = maxPaceSec != null ? paceZone(maxPaceSec, zones) : null;
      var avgZone = avgPace != null ? paceZone(avgPace, zones) : null;
      var hrHard = (maxHr != null && zones && n(zones.maxHr) ? maxHr >= n(zones.maxHr) * 0.92 : false);
      var restRatio = (elapsedSec && movingSec && elapsedSec > 0) ? (elapsedSec - movingSec) / elapsedSec : 0;
      var qualityHidden = (maxZone && (HIGH_ZONES[maxZone] || THRESH_ZONES[maxZone]) && avgZone && avgZone !== maxZone) ||
        hrHard || restRatio > 0.12;

      // A planned QUALITY session with a clearly recovery-slow average and no
      // corroborating hard signal → the athlete likely didn't execute it;
      // don't credit quality. Otherwise the plan is a first-class signal.
      var planSkipped = pType && intensityOf(pType) !== "easy" && !qualityHidden && avgZone === "recovery";

      if (pType && tType && pType === tType) { primary = pType; confidence = "high"; }
      else if (pType && !planSkipped) { primary = pType; confidence = qualityHidden ? "high" : "moderate"; if (intensityOf(pType) !== "easy" && !intervals) estimated = true; }
      else if (tType) { primary = tType; confidence = qualityHidden ? "moderate" : "low"; }
      else if (qualityHidden && (maxZone === "vo2" || maxZone === "rep")) { primary = "VO2 / Interval"; confidence = "low"; estimated = true; }
      else if (qualityHidden && maxZone === "threshold") { primary = "Threshold"; confidence = "low"; estimated = true; }
      else {
        // Aerobic by nature. Distinguish long / recovery / easy from summary.
        var longKm = 16;
        if (distanceKm != null && (distanceKm >= longKm || (movingSec != null && movingSec / 60 >= 90))) primary = "Long Run";
        else if (avgZone === "recovery") primary = "Recovery";
        else primary = "Easy";
        confidence = "moderate";
      }

      // Strides / fast finish as SECONDARY inside an easy/long run.
      if (intensityOf(primary) === "easy") {
        if (/strides|pick-?ups/.test(lc(title)) || (maxZone === "rep" && restRatio < 0.2 && intensityOf(primary) === "easy")) {
          secondary.push("Strides detected");
          if (primary === "Easy") primary = "Easy + Strides";
        }
        if (maxZone === "threshold" && primary === "Long Run") secondary.push("Controlled fast finish");
      }
    }

    // ── Quality volume split (mixed sessions) ─────────────────────────
    var intensity = intensityOf(primary);
    var quality = intensity !== "easy";
    var qualityKm = { easy: distanceKm || 0, threshold: 0, high: 0 };
    if (quality && distanceKm != null) {
      var qKm;
      if (intervals && intervals.qualityDistanceKm > 0) {
        qKm = Math.min(distanceKm, intervals.qualityDistanceKm);   // measured from laps
      } else {
        // No laps → transparent estimate of the quality portion of the run.
        var frac = intensity === "high" ? 0.35 : 0.45;             // rest is WU/CD/recovery
        qKm = Math.round(distanceKm * frac * 10) / 10;
        estimated = true;
      }
      qualityKm = { easy: Math.max(0, Math.round((distanceKm - qKm) * 10) / 10), threshold: 0, high: 0 };
      qualityKm[intensity] = qKm;
    }

    return {
      primaryType: primary,
      secondary: secondary,
      intensity: intensity,           // "easy" | "threshold" | "high"
      quality: quality,
      confidence: confidence,
      confidenceLabel: CONF[confidence] || CONF.low,
      intervals: intervals,
      qualityKm: qualityKm,           // km split → threshold/high/easy
      estimated: estimated,
      planMatch: pType ? (tType === pType || (intervals != null)) : null
    };
  }

  var api = {
    classifyActivity: classifyActivity,
    detectFromLaps: detectFromLaps,
    paceZone: paceZone,
    intensityOf: intensityOf,
    // Exported so other modules (e.g. the Trends seed) use ONE keyword
    // vocabulary instead of maintaining a competing regex set.
    titleType: titleType,
    plannedType: plannedType,
    VERSION: "workout-classifier-v1"
  };
  if (root) root.AthlevoWorkoutClassifier = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
