/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Canonical Sport Classification  ·  client mirror of
 *  lib/server/sportClassification.js
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Verbatim-behaviour mirror of the authoritative server module so the
 *  browser screens (Today / Train / Trends / Coach / History) classify a
 *  sport identically to the server and the AI coach. Pure and deterministic;
 *  no DOM, no network. Exposed as window.SportClassification. A parity test
 *  keeps this in sync with the server module.
 */

(function () {
  "use strict";

  const CANONICAL_SPORTS = [
    "run", "ride", "strength", "swim", "walk",
    "hike", "mobility", "cross_training", "rest", "other"
  ];
  const PACE_SPORTS = ["run"];
  const SPEED_SPORTS = ["ride"];

  const TYPE_MAP = {
    run: { sport: "run" },
    running: { sport: "run" },
    trailrun: { sport: "run", subtype: "trail_run" },
    virtualrun: { sport: "run", indoor: true, subtype: "treadmill_run" },
    treadmill: { sport: "run", indoor: true, subtype: "treadmill_run" },
    "treadmill running": { sport: "run", indoor: true, subtype: "treadmill_run" },
    indoorrun: { sport: "run", indoor: true, subtype: "treadmill_run" },

    ride: { sport: "ride" },
    cycling: { sport: "ride" },
    bike: { sport: "ride" },
    biking: { sport: "ride" },
    virtualride: { sport: "ride", indoor: true, subtype: "indoor_ride" },
    indoorcycling: { sport: "ride", indoor: true, subtype: "indoor_ride" },
    "indoor cycling": { sport: "ride", indoor: true, subtype: "indoor_ride" },
    mountainbikeride: { sport: "ride", subtype: "mountain_bike" },
    gravelride: { sport: "ride" },
    ebikeride: { sport: "ride" },
    velomobile: { sport: "ride" },
    handcycle: { sport: "ride" },

    weighttraining: { sport: "strength" },
    strengthtraining: { sport: "strength" },
    workout: { sport: "strength" },
    crossfit: { sport: "strength" },

    swim: { sport: "swim" },
    swimming: { sport: "swim" },
    openwaterswim: { sport: "swim" },

    walk: { sport: "walk" },
    walking: { sport: "walk" },

    hike: { sport: "hike" },
    hiking: { sport: "hike" },

    yoga: { sport: "mobility" },
    pilates: { sport: "mobility" },
    mobility: { sport: "mobility" },
    stretching: { sport: "mobility" },

    rowing: { sport: "cross_training" },
    virtualrow: { sport: "cross_training", indoor: true },
    elliptical: { sport: "cross_training", indoor: true },
    stairstepper: { sport: "cross_training", indoor: true },
    crosstraining: { sport: "cross_training" },
    "cross training": { sport: "cross_training" },

    rest: { sport: "rest" },
    rest_day: { sport: "rest" },
    "rest day": { sport: "rest" },

    other: { sport: "other" },
    workout_other: { sport: "other" }
  };

  function heuristicSport(s) {
    if (!s) return null;
    if (/\brest\b|rest[_ ]?day/.test(s)) return { sport: "rest", source: "heuristic" };
    if (/run|jog|treadmill|sprint/.test(s)) return { sport: "run", source: "heuristic" };
    if (/ride|cycl|bike|biking|peloton|zwift|spin/.test(s)) return { sport: "ride", source: "heuristic" };
    if (/strength|weight|lifting|crossfit|\bgym\b/.test(s)) return { sport: "strength", source: "heuristic" };
    if (/swim/.test(s)) return { sport: "swim", source: "heuristic" };
    if (/hike|hiking|trek/.test(s)) return { sport: "hike", source: "heuristic" };
    if (/walk/.test(s)) return { sport: "walk", source: "heuristic" };
    if (/yoga|pilates|mobility|stretch/.test(s)) return { sport: "mobility", source: "heuristic" };
    if (/row|elliptical|stair|ski|skat|paddle|kayak/.test(s)) return { sport: "cross_training", source: "heuristic" };
    return null;
  }

  function isIndoorSignal(rawType, trainer) {
    if (trainer === true) return true;
    return /indoor|treadmill|virtual|trainer|stationary/i.test(String(rawType || ""));
  }

  function classifyActivity(input) {
    const provider = input && input.provider != null ? String(input.provider) : null;
    const rawType =
      input && input.providerActivityType != null ? String(input.providerActivityType) : null;
    const trainer = input ? input.trainer : null;
    const lower = String(rawType || "").trim().toLowerCase();

    let sport = "other";
    let subtype = null;
    let indoorFromType = false;
    let classificationSource = "unmapped";
    let mappingStatus = "unmapped";

    const mapped = lower ? TYPE_MAP[lower] : null;
    if (mapped) {
      sport = mapped.sport;
      subtype = mapped.subtype || null;
      indoorFromType = mapped.indoor === true;
      classificationSource = "provider_type";
      mappingStatus = "mapped";
    } else {
      const h = lower ? heuristicSport(lower) : null;
      if (h) {
        sport = h.sport;
        classificationSource = "heuristic";
        mappingStatus = "heuristic";
      }
    }

    const indoor =
      rawType == null && trainer == null
        ? null
        : indoorFromType || isIndoorSignal(rawType, trainer);

    if (!subtype) {
      if (sport === "run" && indoor) subtype = "treadmill_run";
      else if (sport === "ride" && indoor) subtype = "indoor_ride";
    }

    return {
      provider,
      providerActivityType: rawType,
      sport,
      subtype,
      indoor,
      classificationSource,
      mappingStatus
    };
  }

  function canonicalSportOf(row) {
    if (!row || typeof row !== "object") return "other";
    const rawData = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
    const normalized = rawData.normalized && typeof rawData.normalized === "object" ? rawData.normalized : {};
    const providerType =
      normalized.activityType ||
      row.activity_type ||
      row.sport_type ||
      row.type ||
      row.workout_type ||
      null;
    return classifyActivity({
      provider: row.source || normalized.provider || null,
      providerActivityType: providerType,
      name: row.name,
      trainer: row.trainer
    }).sport;
  }

  function isRunRow(row) { return canonicalSportOf(row) === "run"; }
  function isRideRow(row) { return canonicalSportOf(row) === "ride"; }
  function isStrengthRow(row) { return canonicalSportOf(row) === "strength"; }

  function loadBucketForSport(sport) {
    if (sport === "run") return "run";
    if (sport === "ride") return "ride";
    if (sport === "strength") return "strength";
    return "other";
  }

  function activityDataQuality(row) {
    const rawData = row && row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
    const finite = v => Number.isFinite(Number(v)) && Number(v) > 0;
    return {
      power_available: finite(rawData.average_power_watts) || finite(rawData.normalized_power_watts),
      heart_rate_available: finite(row && row.average_heartrate),
      cadence_available: finite(row && row.average_cadence),
      load_available: finite(rawData.training_load)
    };
  }

  function metricStyleForSport(sport) {
    if (PACE_SPORTS.includes(sport)) return "pace";
    if (SPEED_SPORTS.includes(sport)) return "speed";
    if (sport === "strength" || sport === "mobility") return "duration";
    return "duration";
  }

  window.SportClassification = {
    CANONICAL_SPORTS,
    PACE_SPORTS,
    SPEED_SPORTS,
    classifyActivity,
    canonicalSportOf,
    isRunRow,
    isRideRow,
    isStrengthRow,
    loadBucketForSport,
    activityDataQuality,
    metricStyleForSport,
    SPORT_CLASSIFICATION_VERSION: "sport-classification-v1"
  };
})();
