/*
 * Athlevo Recovery — deterministic, data-availability-aware composite.
 *
 * Nominal weights:
 *   subjective readiness 30% · HRV vs baseline 25%
 *   resting HR vs baseline 15% · sleep quality 20% · body feedback 10%
 *
 * Missing components are omitted and the remaining weights are normalized.
 * At least two valid components are required. ACWR is a modifier only:
 * 1.30–1.49 subtracts 5 points; 1.50+ subtracts 10. Reported pain caps the
 * final score at 39. No value is persisted or inferred.
 */
(function (root) {
  "use strict";

  const WEIGHTS = Object.freeze({
    readiness: 0.30,
    hrv: 0.25,
    restingHeartRate: 0.15,
    sleep: 0.20,
    body: 0.10
  });
  const MINIMUM_COMPONENTS = 2;

  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function bounded(value, min, max) {
    const number = finite(value);
    return number === null ? null : clamp(number, min, max);
  }

  /* 80% of baseline maps to 0, baseline maps to 80, and 105% maps to 100. */
  function hrvScore(current, baseline) {
    const value = finite(current);
    const reference = finite(baseline);
    if (value === null || reference === null || value <= 0 || reference <= 0) {
      return null;
    }
    return clamp(((value / reference) - 0.8) / 0.25 * 100, 0, 100);
  }

  /* 5% below baseline maps to 100; baseline maps to 75; 15% above maps to 0. */
  function restingHeartRateScore(current, baseline) {
    const value = finite(current);
    const reference = finite(baseline);
    if (value === null || reference === null || value <= 0 || reference <= 0) {
      return null;
    }
    return clamp((1.15 - value / reference) / 0.20 * 100, 0, 100);
  }

  function sleepScore(quality) {
    const value = bounded(quality, 1, 5);
    return value === null ? null : (value - 1) / 4 * 100;
  }

  function bodyScore(soreness, painPresent) {
    if (painPresent === true) return 0;
    const value = bounded(soreness, 1, 10);
    return value === null ? null : (10 - value) / 9 * 100;
  }

  function qualityFor(count) {
    if (count >= 5) return "Full data";
    if (count >= 3) return "Partial data";
    return "Limited data";
  }

  function calculateRecovery(input) {
    const source = input && typeof input === "object" ? input : {};
    const components = [];
    const add = (key, score) => {
      if (score === null || !Number.isFinite(score)) return;
      components.push({
        key,
        score: clamp(score, 0, 100),
        weight: WEIGHTS[key]
      });
    };

    add("readiness", bounded(source.readinessScore, 0, 100));
    add("hrv", hrvScore(source.hrv, source.hrvBaseline));
    add(
      "restingHeartRate",
      restingHeartRateScore(
        source.restingHeartRate,
        source.restingHeartRateBaseline
      )
    );
    add("sleep", sleepScore(source.sleepQuality));
    add("body", bodyScore(source.soreness, source.painPresent));

    const quality = qualityFor(components.length);
    if (components.length < MINIMUM_COMPONENTS) {
      return {
        available: false,
        score: null,
        quality,
        componentCount: components.length,
        components: components.map(component => component.key),
        loadModifier: 0,
        painCapped: false
      };
    }

    const availableWeight = components.reduce(
      (total, component) => total + component.weight,
      0
    );
    const weighted = components.reduce(
      (total, component) => total + component.score * component.weight,
      0
    ) / availableWeight;

    const acwr = finite(source.acwr);
    const loadModifier = acwr !== null && acwr >= 1.5
      ? -10
      : acwr !== null && acwr >= 1.3
        ? -5
        : 0;
    let score = clamp(Math.round(weighted + loadModifier), 0, 100);
    const painCapped = source.painPresent === true && score > 39;
    if (painCapped) score = 39;

    return {
      available: true,
      score,
      quality,
      componentCount: components.length,
      components: components.map(component => component.key),
      loadModifier,
      painCapped
    };
  }

  root.AthlevoRecovery = Object.freeze({
    WEIGHTS,
    MINIMUM_COMPONENTS,
    hrvScore,
    restingHeartRateScore,
    sleepScore,
    bodyScore,
    calculateRecovery
  });
})(typeof window !== "undefined" ? window : globalThis);
