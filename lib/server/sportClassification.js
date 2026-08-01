/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Canonical Sport Classification   ·   authoritative, pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The ONE place a provider activity is turned into a canonical sport. Every
 *  import path, metric, Coach-context builder, history view and planner is
 *  meant to read the sport from here — never by re-deriving it from arbitrary
 *  provider strings, titles, speed or distance.
 *
 *  Design rules (from the multi-sport sprint spec):
 *    · Provider activity TYPE is the primary classification signal. We do NOT
 *      classify from speed / distance / title when a reliable provider type
 *      exists.
 *    · Unknown provider types are PRESERVED (never mutated) and classified as
 *      `other` with mappingStatus "unmapped" so they can be logged as a
 *      privacy-safe categorical event and remapped later.
 *    · Nothing is fabricated. Missing power / cadence / load stays null; the
 *      data-quality helpers report availability rather than inventing values.
 *    · Pure and deterministic — no I/O, safe to mirror to the browser
 *      (js/sportClassification.js) and to unit-test directly.
 *
 *  Canonical top-level sports (exhaustive):
 *    run · ride · strength · swim · walk · hike · mobility ·
 *    cross_training · rest · other
 */

export const CANONICAL_SPORTS = [
  "run",
  "ride",
  "strength",
  "swim",
  "walk",
  "hike",
  "mobility",
  "cross_training",
  "rest",
  "other"
];

// Sports whose primary comparable unit is distance/pace (running-family).
// Kept small on purpose — only `run` is pace-in-min/km today.
export const PACE_SPORTS = ["run"];

// Sports whose primary comparable unit is speed (km/h) rather than pace.
export const SPEED_SPORTS = ["ride"];

/*
 * Provider type map. The KEY is the provider's raw activity/sport type,
 * lower-cased. The VALUE carries the canonical sport plus optional flags:
 *   indoor  → the type itself implies an indoor/virtual/trainer session
 *   subtype → a conservative canonical subtype the type alone justifies
 *
 * These lists cover the documented Strava `sport_type`/`type` values and the
 * Intervals.icu `type` values (which reuse the Strava vocabulary). Terra
 * emits a looser vocabulary, so Terra additionally falls back to the keyword
 * heuristic below. This map is NOT assumed exhaustive — anything missing is
 * handled by the heuristic and, failing that, reported as unmapped.
 */
const TYPE_MAP = {
  // ── running ──────────────────────────────────────────────────────────
  run: { sport: "run" },
  running: { sport: "run" },
  trailrun: { sport: "run", subtype: "trail_run" },
  virtualrun: { sport: "run", indoor: true, subtype: "treadmill_run" },
  treadmill: { sport: "run", indoor: true, subtype: "treadmill_run" },
  "treadmill running": { sport: "run", indoor: true, subtype: "treadmill_run" },
  indoorrun: { sport: "run", indoor: true, subtype: "treadmill_run" },

  // ── cycling ──────────────────────────────────────────────────────────
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

  // ── strength ─────────────────────────────────────────────────────────
  weighttraining: { sport: "strength" },
  strengthtraining: { sport: "strength" },
  workout: { sport: "strength" },
  crossfit: { sport: "strength" },

  // ── swim ─────────────────────────────────────────────────────────────
  swim: { sport: "swim" },
  swimming: { sport: "swim" },
  openwaterswim: { sport: "swim" },

  // ── walk ─────────────────────────────────────────────────────────────
  walk: { sport: "walk" },
  walking: { sport: "walk" },

  // ── hike ─────────────────────────────────────────────────────────────
  hike: { sport: "hike" },
  hiking: { sport: "hike" },

  // ── mobility ─────────────────────────────────────────────────────────
  yoga: { sport: "mobility" },
  pilates: { sport: "mobility" },
  mobility: { sport: "mobility" },
  stretching: { sport: "mobility" },

  // ── cross_training (aerobic, non-run/ride) ───────────────────────────
  rowing: { sport: "cross_training" },
  virtualrow: { sport: "cross_training", indoor: true },
  elliptical: { sport: "cross_training", indoor: true },
  stairstepper: { sport: "cross_training", indoor: true },
  crosstraining: { sport: "cross_training" },
  "cross training": { sport: "cross_training" },

  // ── rest ─────────────────────────────────────────────────────────────
  rest: { sport: "rest" },
  rest_day: { sport: "rest" },
  "rest day": { sport: "rest" },

  // ── explicit other (still preserved) ─────────────────────────────────
  other: { sport: "other" },
  workout_other: { sport: "other" }
};

/*
 * Keyword heuristic — the SECOND-choice signal, used only when the provider
 * type is not in TYPE_MAP (mostly Terra's looser vocabulary, or a new value
 * we haven't mapped). Order matters: more specific families first so e.g.
 * "trail run" resolves to run, "mountain bike" to ride.
 */
function heuristicSport(lowerType) {
  const s = lowerType;
  if (!s) return null;
  if (/\brest\b|rest[_ ]?day/.test(s)) return { sport: "rest", source: "heuristic" };
  if (/run|jog|treadmill|sprint/.test(s)) return { sport: "run", source: "heuristic" };
  if (/ride|cycl|bike|biking|peloton|zwift|spin/.test(s)) return { sport: "ride", source: "heuristic" };
  if (/strength|weight|lifting|crossfit|\bgym\b/.test(s)) return { sport: "strength", source: "heuristic" };
  if (/swim/.test(s)) return { sport: "swim", source: "heuristic" };
  if (/hike|hiking|trek/.test(s)) return { sport: "hike", source: "heuristic" };
  if (/walk/.test(s)) return { sport: "walk", source: "heuristic" };
  if (/yoga|pilates|mobility|stretch/.test(s)) return { sport: "mobility", source: "heuristic" };
  if (/row|elliptical|stair|ski|skat|paddle|kayak|elliptical/.test(s))
    return { sport: "cross_training", source: "heuristic" };
  return null;
}

function isIndoorSignal(rawType, trainer) {
  if (trainer === true) return true;
  return /indoor|treadmill|virtual|trainer|stationary/i.test(String(rawType || ""));
}

/*
 * classifyActivity — the single entry point.
 *
 * Input (any subset):
 *   { provider, providerActivityType, name, trainer }
 *
 * Output:
 *   {
 *     provider, providerActivityType,          // preserved raw signal
 *     sport,                                    // canonical top-level sport
 *     subtype,                                  // conservative canonical subtype | null
 *     indoor,                                   // boolean | null
 *     classificationSource,                     // "provider_type" | "heuristic" | "unmapped"
 *     mappingStatus                             // "mapped" | "heuristic" | "unmapped"
 *   }
 *
 * The raw providerActivityType is ALWAYS echoed back untouched for debugging
 * and future remapping.
 */
export function classifyActivity(input) {
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
    } else {
      // Unknown → preserve raw, classify safe, flag for a categorical log.
      sport = "other";
      classificationSource = "unmapped";
      mappingStatus = "unmapped";
    }
  }

  const indoor =
    rawType == null && trainer == null
      ? null
      : indoorFromType || isIndoorSignal(rawType, trainer);

  // Derive a conservative subtype for indoor run/ride even when the map only
  // gave the sport (e.g. Terra "indoor" heuristic). Never guess intensity.
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

/*
 * canonicalSportOf — normalization ON READ for a stored `activities` row.
 *
 * Works uniformly across providers despite the historical inconsistency
 * (Strava stores raw CamelCase types in sport_type/activity_type; Terra/
 * Intervals store canonical lowercase). It re-runs the classifier over the
 * best available raw signal and NEVER mutates the row.
 *
 * Preference order for the raw type signal:
 *   1. raw_data.normalized.activityType (the untouched provider type captured
 *      at import, before any column overwrite)
 *   2. activity_type / sport_type columns
 *   3. workout_type (last resort; execution snapshots)
 */
export function canonicalSportOf(row) {
  if (!row || typeof row !== "object") return "other";
  const rawData = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
  const normalized = rawData.normalized && typeof rawData.normalized === "object"
    ? rawData.normalized
    : {};
  const providerType =
    normalized.activityType ||
    row.activity_type ||
    row.sport_type ||
    row.type ||
    row.workout_type ||
    null;
  const c = classifyActivity({
    provider: row.source || normalized.provider || null,
    providerActivityType: providerType,
    name: row.name,
    trainer: row.trainer
  });
  return c.sport;
}

export function isRunRow(row) {
  return canonicalSportOf(row) === "run";
}
export function isRideRow(row) {
  return canonicalSportOf(row) === "ride";
}
export function isStrengthRow(row) {
  return canonicalSportOf(row) === "strength";
}

/*
 * Load bucket — which sport-specific load line a sport contributes to.
 * We keep four explicit buckets plus total; everything not run/ride/strength
 * rolls into `other` (still counted in total systemic load).
 */
export function loadBucketForSport(sport) {
  if (sport === "run") return "run";
  if (sport === "ride") return "ride";
  if (sport === "strength") return "strength";
  return "other";
}

/*
 * Cycling (and general) data-quality indicators. Reports what is genuinely
 * present on the row — never fabricates. `row.raw_data.average_power_watts`
 * is where the normalizer stores power; HR/cadence are top-level columns.
 */
export function activityDataQuality(row) {
  const rawData = row && row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
  const finite = v => Number.isFinite(Number(v)) && Number(v) > 0;
  return {
    power_available: finite(rawData.average_power_watts) || finite(rawData.normalized_power_watts),
    heart_rate_available: finite(row && row.average_heartrate),
    cadence_available: finite(row && row.average_cadence),
    load_available: finite(rawData.training_load)
  };
}

/*
 * How a sport's headline metric should be presented (units). Used by history
 * / summaries so a ride is never shown as min/km and strength is never shown
 * as distance.
 */
export function metricStyleForSport(sport) {
  if (PACE_SPORTS.includes(sport)) return "pace"; // distance + min/km
  if (SPEED_SPORTS.includes(sport)) return "speed"; // duration + distance + km/h + power/cadence
  if (sport === "strength" || sport === "mobility") return "duration"; // duration + category
  return "duration"; // swim/walk/hike/cross_training/other → duration-first
}

export const SPORT_CLASSIFICATION_VERSION = "sport-classification-v1";
