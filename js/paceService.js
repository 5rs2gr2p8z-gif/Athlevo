/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Pace Service (client mirror of lib/server/paceService.js)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  THE single source of training-pace guidance for the browser (Today,
 *  Train, Latest Workout Analysis, Coach). Verbatim mirror of the server
 *  layer so Today and Train can never show different paces. Reuses
 *  window.AthlevoPerformance for the centre pace of each zone — no new
 *  VDOT/pace maths. Exposed as window.AthlevoPaceService. Parity-tested.
 */

(function () {
  "use strict";

  const P = () => window.AthlevoPerformance;

  const ZONE_META = {
    recovery:   { label: "Recovery",        band: 0.05,  rpe: [1, 3], meaning: "Very relaxed, full conversation. Slower is always fine." },
    easy:       { label: "Easy",            band: 0.045, rpe: [2, 4], meaning: "Comfortable enough to speak in full sentences." },
    long:       { label: "Long Run",        band: 0.045, rpe: [2, 4], meaning: "Steady, conversational endurance running." },
    marathon:   { label: "Marathon",        band: 0.022, rpe: [5, 6], meaning: "Comfortably hard goal effort you could hold for a long time." },
    tempo:      { label: "Tempo / Control", band: 0.022, rpe: [5, 6], meaning: "Comfortably focused, never straining." },
    threshold:  { label: "Threshold",       band: 0.018, rpe: [7, 8], meaning: "Controlled hard running. You should not sprint or go all-out." },
    vo2:        { label: "VO2 / Interval",  band: 0.020, rpe: [8, 9], meaning: "Hard but repeatable, not a sprint." },
    repetition: { label: "Repetition",      band: 0.025, rpe: [8, 9], meaning: "Fast and relaxed with full recovery — never maximal." }
  };
  const ZONE_ORDER = ["recovery", "easy", "long", "marathon", "tempo", "threshold", "vo2", "repetition"];

  function distanceLabel(km) {
    const k = Number(km);
    if (!Number.isFinite(k) || k <= 0) return null;
    if (Math.abs(k - 5) <= 0.3) return "5K";
    if (Math.abs(k - 10) <= 0.5) return "10K";
    if (Math.abs(k - 21.0975) <= 1) return "half marathon";
    if (Math.abs(k - 42.195) <= 1.5) return "marathon";
    return `${Math.round(k)} km`;
  }

  const CONFIDENCE_LABELS = {
    high: "High confidence",
    moderate: "Moderate confidence",
    developing: "Developing estimate",
    insufficient: "Confirm with a race"
  };

  function resolvePaceSource(fitness, nowMs) {
    const now = nowMs || Date.now();
    const vdot = fitness && fitness.vdot != null ? Number(fitness.vdot) : null;
    const header = "Your current training paces";
    const supporting = "Updated from your recent training and confirmed performances.";

    if (vdot == null || !Number.isFinite(vdot)) {
      return {
        header, supporting,
        source: { code: "insufficient", label: "Insufficient data" },
        confidence: { code: "insufficient", label: CONFIDENCE_LABELS.insufficient },
        updatedLine: "Estimated from your current training. Confirm a recent race for greater precision.",
        rpeOnly: true
      };
    }

    const estimated = fitness.estimated === true;
    const hasRace = fitness.hasConfirmedRace === true;
    const source = fitness.source || null;
    const raceKm = fitness.raceDistanceKm != null ? Number(fitness.raceDistanceKm) : null;

    if (!estimated && (source === "race" || hasRace)) {
      const ageDays = fitness.raceDate
        ? (now - Date.parse(String(fitness.raceDate) + "T12:00:00Z")) / 86400000
        : null;
      const stale = ageDays != null && ageDays > 120;
      const dl = distanceLabel(raceKm);
      return {
        header, supporting,
        source: { code: "confirmed_race", label: "Confirmed performance" },
        confidence: { code: stale ? "moderate" : "high", label: stale ? CONFIDENCE_LABELS.moderate : CONFIDENCE_LABELS.high },
        updatedLine: dl ? `Updated from your ${dl} result.` : "Updated from your confirmed race.",
        rpeOnly: false
      };
    }

    if (estimated) {
      return {
        header, supporting,
        source: { code: "recent_workout", label: "Recent training" },
        confidence: { code: "developing", label: CONFIDENCE_LABELS.developing },
        updatedLine: "Updated based on your recent run. Confirm a recent race for greater precision.",
        rpeOnly: false
      };
    }

    return {
      header, supporting,
      source: { code: "current_vdot", label: "Current fitness" },
      confidence: { code: "moderate", label: CONFIDENCE_LABELS.moderate },
      updatedLine: "Based on your current training fitness.",
      rpeOnly: false
    };
  }

  function buildZone(key, centreSec, options) {
    const meta = ZONE_META[key];
    const rpe = { min: meta.rpe[0], max: meta.rpe[1], text: `RPE ${meta.rpe[0]}–${meta.rpe[1]}` };

    let paceRange = null;
    if (centreSec != null && Number.isFinite(centreSec) && !(options && options.rpeOnly)) {
      const fast = Math.round(centreSec * (1 - meta.band));
      const slow = Math.round(centreSec * (1 + meta.band));
      const fmt = P().formatPace;
      paceRange = {
        minSecPerKm: fast,
        maxSecPerKm: slow,
        text: `${fmt(fast).replace("/km", "")}–${fmt(slow)}`
      };
    }

    return {
      key,
      label: meta.label,
      paceRange,
      rpe,
      hr: options && options.hr && options.hr[key] ? options.hr[key] : null,
      explanation: meta.meaning
    };
  }

  const AEROBIC_ZONES = new Set(["recovery","easy","long"]);
  const AEROBIC_SAFETY = {
    recovery: "Run by effort first — slower than the range is completely fine.",
    easy: "Run by effort first. The pace is a guide, not a test. Slow down if effort is high.",
    long: "Ease into it — don't chase the fast end early. Slower is fine in heat, hills or fatigue."
  };
  function buildAerobicZone(key, rangeSec, aero, mod) {
    const meta = ZONE_META[key];
    const rpe = { min: meta.rpe[0], max: meta.rpe[1], text: `RPE ${meta.rpe[0]}\u2013${meta.rpe[1]}` };
    const fmt = P().formatPace;
    const fast = Math.round(rangeSec.minSec), slow = Math.round(rangeSec.maxSec);
    const notes = [AEROBIC_SAFETY[key]].concat((mod && mod.notes) || []).slice(0, 2);
    return { key, label: meta.label,
      paceRange: { minSecPerKm: fast, maxSecPerKm: slow, text: `${fmt(fast).replace("/km","")}\u2013${fmt(slow)}` },
      rpe, hr: null, explanation: meta.meaning,
      source: { code: aero.source, label: aero.source === "pace-heart-rate relationship" ? "Pace-to-HR relationship" : "Recent aerobic history" },
      confidence: aero.confidence, lastRecalculated: aero.lastRecalculated, reason: aero.reason,
      effortFirst: !!(mod && mod.rpeFirst), removeIntensity: !!(mod && mod.removeIntensity), notes };
  }

  function getTrainingPaces(fitness, options) {
    options = options || {};
    const resolved = resolvePaceSource(fitness, options.nowMs);
    const vdot = fitness && fitness.vdot != null ? Number(fitness.vdot) : null;
    const centres = (vdot != null && Number.isFinite(vdot)) ? P().trainingPaces(vdot) : null;

    const A = window.AthlevoAerobic;
    const aero = (options.activities && A) ? A.computeAerobicCalibration(options.activities, fitness, options.nowMs) : null;
    const daily = options.daily || {};
    const bias = Number.isFinite(Number(options.feedbackBiasSec)) ? Number(options.feedbackBiasSec) : 0;

    const zones = ZONE_ORDER.map(key => {
      if (AEROBIC_ZONES.has(key) && aero && aero.valid && aero.ranges[key]) {
        const base = { minSec: aero.ranges[key].minSec + bias, maxSec: aero.ranges[key].maxSec + bias };
        const mod = A.applyDailyModifiers(base, daily);
        return buildAerobicZone(key, mod.range, aero, mod);
      }
      const centreSec = centres && centres[key] ? centres[key].secPerKm : null;
      const z = buildZone(key, centreSec, { rpeOnly: resolved.rpeOnly, hr: options.hr });
      if (AEROBIC_ZONES.has(key)) {
        z.source = { code: "profile_estimate", label: "Fitness estimate" };
        z.confidence = resolved.rpeOnly ? "insufficient" : "developing";
        z.reason = "Estimated from your current fitness. Follow effort first.";
        z.notes = [AEROBIC_SAFETY[key]];
      } else {
        z.source = resolved.source; z.confidence = resolved.confidence.code; z.reason = resolved.updatedLine; z.notes = [];
      }
      z.lastRecalculated = z.lastRecalculated || null;
      return z;
    });

    return Object.assign({}, resolved, {
      vdot,
      aerobicCalibrated: !!(aero && aero.valid),
      aerobicSource: aero && aero.valid ? aero.source : null,
      aerobicReason: aero && aero.valid ? aero.reason : "Estimated from limited aerobic data. Follow effort first.",
      zones,
      zoneMap: zones.reduce((m, z) => { m[z.key] = z; return m; }, {})
    });
  }

  function getZoneGuidance(fitness, zoneKey, options) {
    const all = getTrainingPaces(fitness, options);
    return all.zoneMap[zoneKey] || null;
  }

  window.AthlevoPaceService = {
    getTrainingPaces,
    getZoneGuidance,
    resolvePaceSource,
    PACE_ZONE_ORDER: ZONE_ORDER,
    PACE_SERVICE_VERSION: "pace-service-v1"
  };
})();
