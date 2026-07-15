/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Performance Engine (client mirror of lib/server/performance.js)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Pure, deterministic fitness math exposed as window.AthlevoPerformance.
 *  This is a VERBATIM mirror of the server module so the number an athlete
 *  sees is the number the plan is built from. A parity test keeps the two
 *  in sync. No DOM, no Supabase, no network — only maths on raw inputs.
 *
 *  See lib/server/performance.js for the full design rationale.
 */

(function () {
  "use strict";

  /* ─────────────────────────── VDOT core ────────────────────────────── */

  function oxygenCost(vMetersPerMin) {
    return -4.60 + 0.182258 * vMetersPerMin + 0.000104 * vMetersPerMin * vMetersPerMin;
  }

  function fractionOfMax(minutes) {
    return (
      0.8 +
      0.1894393 * Math.exp(-0.012778 * minutes) +
      0.2989558 * Math.exp(-0.1932605 * minutes)
    );
  }

  function vdotFromRace(distanceMeters, durationSeconds) {
    const meters = Number(distanceMeters);
    const seconds = Number(durationSeconds);

    if (
      !Number.isFinite(meters) || meters < 800 ||
      !Number.isFinite(seconds) || seconds < 90
    ) {
      return null;
    }

    const minutes = seconds / 60;
    const velocity = meters / minutes;
    const vo2 = oxygenCost(velocity);
    const pct = fractionOfMax(minutes);

    if (pct <= 0) return null;

    const vdot = vo2 / pct;

    if (!Number.isFinite(vdot) || vdot < 15 || vdot > 100) return null;

    return Math.round(vdot * 10) / 10;
  }

  function velocityForVo2(targetVo2) {
    const a = 0.000104;
    const b = 0.182258;
    const c = -4.60 - targetVo2;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    return (-b + Math.sqrt(disc)) / (2 * a);
  }

  function paceSecPerKmAtPct(vdot, pct) {
    const targetVo2 = vdot * pct;
    const v = velocityForVo2(targetVo2);
    if (!v || v <= 0) return null;
    return 60000 / v;
  }

  const ZONE_INTENSITY = {
    recovery: 0.63,
    easy: 0.70,
    long: 0.70,
    marathon: 0.84,
    tempo: 0.86,
    threshold: 0.88,
    vo2: 0.98,
    repetition: 1.06
  };

  const ZONE_ORDER = [
    "recovery", "easy", "long", "marathon",
    "tempo", "threshold", "vo2", "repetition"
  ];

  const ZONE_LABELS = {
    recovery: "Recovery",
    easy: "Easy",
    long: "Long Run",
    marathon: "Marathon Pace",
    tempo: "Tempo",
    threshold: "Threshold",
    vo2: "VO2",
    repetition: "Repetition"
  };

  function formatPace(secPerKm) {
    if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) {
      return null;
    }
    const total = Math.round(secPerKm);
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return `${m}:${String(s).padStart(2, "0")}/km`;
  }

  function trainingPaces(vdot) {
    const v = Number(vdot);
    if (!Number.isFinite(v) || v < 15) return null;

    const paces = {};
    for (const zone of ZONE_ORDER) {
      const sec = paceSecPerKmAtPct(v, ZONE_INTENSITY[zone]);
      paces[zone] = {
        zone,
        label: ZONE_LABELS[zone],
        secPerKm: sec != null ? Math.round(sec) : null,
        pace: formatPace(sec)
      };
    }
    return paces;
  }

  /* ────────────────────── Current Running Level ─────────────────────── */

  const LEVEL_TIERS = [
    { min: 75, tier: "World Class" },
    { min: 65, tier: "Elite" },
    { min: 55, tier: "Advanced" },
    { min: 45, tier: "Intermediate" },
    { min: 35, tier: "Recreational" },
    { min: 0, tier: "Beginner" }
  ];

  function vdotToLevel(vdot) {
    const v = Number(vdot);
    if (!Number.isFinite(v)) return null;
    const level = ((v - 25) / (80 - 25)) * 100;
    return Math.max(1, Math.min(99, Math.round(level)));
  }

  function tierForVdot(vdot) {
    const v = Number(vdot);
    if (!Number.isFinite(v)) return "Unrated";
    return (LEVEL_TIERS.find(t => v >= t.min) || LEVEL_TIERS[LEVEL_TIERS.length - 1]).tier;
  }

  function currentRunningLevel(inputs) {
    inputs = inputs || {};
    const components = [];

    if (inputs.vdot != null && Number.isFinite(Number(inputs.vdot))) {
      components.push({
        key: "race_vdot",
        weight: 1.0,
        value: vdotToLevel(inputs.vdot)
      });
    }

    if (!components.length) {
      return { level: null, tier: "Unrated", estimated: false, components: [] };
    }

    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    const level = Math.round(
      components.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight
    );

    return {
      level: Math.max(1, Math.min(99, level)),
      tier: inputs.vdot != null ? tierForVdot(inputs.vdot) : "Unrated",
      estimated: inputs.estimated === true,
      components
    };
  }

  /* ───────────────────────── Athlevo Score ──────────────────────────── */

  const clamp100 = n => Math.max(0, Math.min(100, Math.round(n)));

  function subAerobic(inputs) {
    const level = inputs.level;
    const km = Number(inputs.weeklyDistanceKm);
    if (level == null && !(km > 0)) return null;
    const volume = Number.isFinite(km) ? Math.min(30, km) : 0;
    const base = level != null ? level * 0.72 : 30;
    return { value: clamp100(base + volume), basis: "VDOT + weekly volume" };
  }

  function subThreshold(inputs) {
    const level = inputs.level;
    if (level == null) return null;
    return { value: clamp100(level * 0.95 + 3), basis: "VDOT-derived threshold" };
  }

  function subSpeed(inputs) {
    const level = inputs.level;
    if (level == null) return null;
    let adj = 0;
    const raceKm = Number(inputs.raceDistanceKm);
    if (Number.isFinite(raceKm) && raceKm > 0) {
      if (raceKm <= 10) adj += 6;
      else if (raceKm >= 30) adj -= 6;
    }
    return { value: clamp100(level * 0.9 + adj), basis: "VDOT + race distance" };
  }

  function subDurability(inputs) {
    const longKm = Number(inputs.longRunKm);
    const km = Number(inputs.weeklyDistanceKm);
    const years = Number(inputs.experienceYears);
    if (!(longKm > 0) && !(km > 0) && !(years > 0)) return null;
    const longScore = Number.isFinite(longKm) ? Math.min(45, longKm * 2) : 0;
    const volScore = Number.isFinite(km) ? Math.min(35, km * 0.7) : 0;
    const expScore = Number.isFinite(years) ? Math.min(20, years * 4) : 0;
    return { value: clamp100(longScore + volScore + expScore), basis: "long run + volume + experience" };
  }

  function subConsistency(inputs) {
    const perWeek = Number(inputs.activitiesPerWeek);
    const target = Number(inputs.availableDays);
    if (!(perWeek >= 0) && !(target > 0)) return null;
    if (!(perWeek >= 0)) return null;
    const goalDays = Number.isFinite(target) && target > 0 ? target : 5;
    const ratio = perWeek / goalDays;
    return { value: clamp100(ratio * 100), basis: "sessions/week vs. available days" };
  }

  const SUB_SCORES = [
    { key: "aerobic", label: "Aerobic Base", weight: 0.30, fn: subAerobic },
    { key: "threshold", label: "Threshold", weight: 0.25, fn: subThreshold },
    { key: "speed", label: "Speed", weight: 0.15, fn: subSpeed },
    { key: "durability", label: "Durability", weight: 0.15, fn: subDurability },
    { key: "consistency", label: "Consistency", weight: 0.15, fn: subConsistency }
  ];

  function athlevoScore(inputs) {
    inputs = inputs || {};
    const subs = {};
    let weighted = 0;
    let weightSum = 0;

    for (const def of SUB_SCORES) {
      const result = def.fn(inputs);
      if (result && Number.isFinite(result.value)) {
        subs[def.key] = { label: def.label, value: result.value, basis: result.basis };
        weighted += result.value * def.weight;
        weightSum += def.weight;
      } else {
        subs[def.key] = { label: def.label, value: null, basis: result ? result.basis : "needs more data" };
      }
    }

    const score = weightSum > 0 ? clamp100(weighted / weightSum) : null;
    return { score, subScores: subs, coverage: weightSum };
  }

  function computeFitness(inputs) {
    inputs = inputs || {};
    const vdot = inputs.vdot != null ? Number(inputs.vdot) : null;

    const runningLevel = currentRunningLevel({
      vdot,
      estimated: inputs.estimated === true
    });

    const scoreInputs = Object.assign({}, inputs, { level: runningLevel.level });
    const score = athlevoScore(scoreInputs);
    const paces = vdot != null ? trainingPaces(vdot) : null;

    return {
      vdot,
      estimated: inputs.estimated === true,
      runningLevel,
      athlevoScore: score,
      paces,
      source: inputs.source || null,
      raceDate: inputs.raceDate || null
    };
  }

  window.AthlevoPerformance = {
    vdotFromRace,
    trainingPaces,
    formatPace,
    vdotToLevel,
    tierForVdot,
    currentRunningLevel,
    athlevoScore,
    computeFitness,
    ZONE_INTENSITY,
    ZONE_ORDER,
    ZONE_LABELS,
    SUB_SCORES
  };
})();
