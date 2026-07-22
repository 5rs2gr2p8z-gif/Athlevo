import { recognizeWorkout } from "../workoutRecognition.js";

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Wearable Normalization Layer
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ONE internal workout format that every provider maps into. The coaching
 *  engine consumes only normalized workouts (via the `activities` table) and
 *  never knows whether the data came from Strava, Terra, Garmin, or WHOOP.
 *
 *  Layers (kept separate on purpose):
 *    · provider mapping   → mapStrava / mapTerra (raw provider → workout)
 *    · normalization      → the Athlevo Workout shape below
 *    · storage adapter    → toActivityRow (workout → existing activities row)
 *
 *  Backward compatible: toActivityRow writes the SAME columns the Strava
 *  importer already used; provider-specific extras (calories, power, GPS,
 *  training load, device) go into the existing `raw_data` jsonb, so no
 *  schema change is required and existing coaching logic is untouched.
 *
 *  Pure and deterministic (no I/O). Adding Garmin/WHOOP/Polar/Fitbit/Suunto
 *  later is a new mapper — everything downstream is unchanged.
 */

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v) {
  return (v === null || v === undefined) ? null : String(v);
}
function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/*
 * The Athlevo Workout — the single internal shape. Every field the task
 * requires is present (null when a provider doesn't supply it).
 */
export function emptyWorkout() {
  return {
    provider: null,            // "strava" | "terra" | …
    providerUserId: null,      // provider's user id, when supplied
    externalId: null,          // provider's activity id
    device: null,              // underlying device / app (e.g. "Garmin Forerunner")
    sport: null,               // normalized: run | ride | swim | walk | other
    activityType: null,        // raw provider type string (e.g. "Run", "running")
    name: null,
    startDate: null,           // ISO 8601 (start_time)
    startDateLocal: null,      // provider's local wall-clock start, when given
    timezone: null,
    upstreamSource: null,      // for gateways: where the workout really came
    upstreamId: null,          //   from (e.g. "STRAVA" + the Strava id)
    laps: null,                // normalized lap/interval structure, when given
    distanceMeters: null,
    durationSeconds: null,     // total duration
    movingTimeSeconds: null,
    elapsedTimeSeconds: null,
    averagePaceSecPerKm: null, // derived from distance + moving time
    averageHeartrate: null,
    maxHeartrate: null,
    elevationGainMeters: null,
    caloriesKcal: null,
    averageCadence: null,
    averagePowerWatts: null,
    trainingLoad: null,        // TSS / load if the device provides it
    hasGps: false,
    hasHeartRate: false,
    trainer: false,            // indoor / treadmill
    importedAt: null           // when Athlevo normalized it
  };
}

// Normalized sport from a provider's sport string.
export function normalizeSport(raw) {
  const s = String(raw || "").toLowerCase();
  if (/run|jog|treadmill|track/.test(s)) return "run";
  if (/ride|cycl|bike|biking/.test(s)) return "ride";
  if (/swim/.test(s)) return "swim";
  if (/walk|hike/.test(s)) return "walk";
  return "other";
}

function derivePace(distanceMeters, movingSeconds) {
  const d = num(distanceMeters), t = num(movingSeconds);
  if (!d || d <= 0 || !t || t <= 0) return null;
  return Math.round(t / (d / 1000)); // sec per km
}

/* ─────────────────────────── Strava mapper ──────────────────────────── */

export function mapStrava(raw) {
  const w = emptyWorkout();
  w.provider = "strava";
  w.providerUserId = str(get(raw, "athlete.id"));
  w.externalId = str(raw.id);
  w.device = str(raw.device_name) || "Strava";
  w.sport = normalizeSport(raw.sport_type || raw.type);
  w.activityType = str(raw.sport_type || raw.type);
  w.name = str(raw.name);
  w.startDate = str(raw.start_date);
  w.timezone = str(raw.timezone);
  w.distanceMeters = num(raw.distance);
  w.movingTimeSeconds = num(raw.moving_time);
  w.elapsedTimeSeconds = num(raw.elapsed_time);
  w.durationSeconds = num(raw.elapsed_time) ?? num(raw.moving_time);
  w.importedAt = new Date().toISOString();
  w.averageHeartrate = num(raw.average_heartrate);
  w.maxHeartrate = num(raw.max_heartrate);
  w.elevationGainMeters = num(raw.total_elevation_gain);
  w.caloriesKcal = num(raw.calories) != null ? num(raw.calories)
    : (num(raw.kilojoules) != null ? Math.round(num(raw.kilojoules) / 4.184) : null);
  w.averageCadence = num(raw.average_cadence);
  w.averagePowerWatts = num(raw.average_watts) ?? num(raw.weighted_average_watts);
  w.trainingLoad = num(raw.suffer_score); // Strava's relative-effort proxy
  w.hasGps = Boolean(raw.start_latlng && raw.start_latlng.length) ||
    Boolean(get(raw, "map.summary_polyline"));
  w.hasHeartRate = w.averageHeartrate != null;
  w.trainer = Boolean(raw.trainer);
  w.averagePaceSecPerKm = derivePace(w.distanceMeters, w.movingTimeSeconds);
  return w;
}

/* ─────────────────────────── Terra mapper ───────────────────────────── */

/*
 * Terra normalises every underlying device (Garmin/WHOOP/Apple/Polar/…)
 * into one payload schema, then posts it to our webhook. We map that
 * unified schema into the Athlevo Workout. The `device` records which
 * underlying device it came from; `provider` stays "terra".
 */
export function mapTerra(raw) {
  const w = emptyWorkout();
  w.provider = "terra";

  const meta = raw.metadata || {};
  const dev = raw.device_data || {};
  const dist = raw.distance_data || {};
  const distSummary = dist.summary || {};
  const dur = raw.active_durations_data || {};
  const hr = get(raw, "heart_rate_data.summary") || {};
  const cal = raw.calories_data || {};
  const power = get(raw, "power_data") || {};
  const cadence = get(raw, "movement_data") || {};

  w.providerUserId = str(get(raw, "user.user_id") || get(raw, "user.reference_id"));
  w.externalId = str(meta.summary_id || meta.id || raw.summary_id || meta.start_time);
  w.device = str(dev.name || dev.manufacturer) || "Terra device";
  w.sport = normalizeSport(meta.type || meta.name || meta.activity_type);
  w.activityType = str(meta.type || meta.activity_type);
  w.name = str(meta.name) || (w.sport ? w.sport[0].toUpperCase() + w.sport.slice(1) : null);
  w.startDate = str(meta.start_time || raw.start_time);
  w.timezone = str(meta.timezone || raw.timezone);

  w.distanceMeters = num(distSummary.distance_meters) ?? num(dist.distance_meters);
  w.movingTimeSeconds = num(dur.activity_seconds) ?? num(dur.moving_seconds) ?? num(raw.moving_time_seconds);
  w.elapsedTimeSeconds = num(dur.total_duration_seconds) ?? num(dur.elapsed_seconds) ?? w.movingTimeSeconds;
  w.durationSeconds = w.elapsedTimeSeconds ?? w.movingTimeSeconds;
  w.importedAt = new Date().toISOString();
  w.averageHeartrate = num(hr.avg_hr_bpm);
  w.maxHeartrate = num(hr.max_hr_bpm);
  w.elevationGainMeters = num(get(distSummary, "elevation.gain_actual_meters")) ??
    num(distSummary.elevation_gain_meters);
  w.caloriesKcal = num(cal.total_burned_calories) ?? num(cal.net_activity_calories);
  w.averageCadence = num(get(cadence, "avg_cadence")) ?? num(cadence.avg_cadence_rpm);
  w.averagePowerWatts = num(power.avg_watts) ?? num(get(power, "avg_power_watts"));
  w.trainingLoad = num(raw.TSS) ?? num(get(raw, "strain_data.strain")) ?? num(raw.training_load);
  w.hasGps = Boolean(get(dist, "detailed.distance_samples")) || Boolean(distSummary.distance_meters);
  w.hasHeartRate = w.averageHeartrate != null;
  w.trainer = Boolean(meta.type && /indoor|treadmill|virtual/i.test(String(meta.type)));
  w.averagePaceSecPerKm = derivePace(w.distanceMeters, w.movingTimeSeconds);
  return w;
}

/* ────────────────────── Intervals.icu mapper ────────────────────────── */

/*
 * Intervals.icu is a GATEWAY, like Terra: the athlete connects Garmin, COROS,
 * Polar, Wahoo (or Strava) to Intervals.icu, and we read one unified activity
 * schema back out. `provider` therefore stays "intervals"; `device` and
 * `upstreamSource` record where the workout actually originated so
 * cross-provider deduplication has real evidence to work with.
 *
 * Field names follow the documented Intervals.icu activity summary. Several
 * optional fields are read through a small fallback chain because the API
 * exposes both plain and `icu_`-prefixed variants depending on the field and
 * the upstream device. Nothing is fabricated: a field Intervals.icu does not
 * supply stays null.
 */
export function mapIntervals(raw) {
  const w = emptyWorkout();
  w.provider = "intervals";
  w.providerUserId = str(raw.athlete_id || get(raw, "athlete.id"));
  w.externalId = str(raw.id);
  w.device = str(raw.device_name || raw.deviceName) || "Intervals.icu";
  w.sport = normalizeSport(raw.type || raw.sport);
  w.activityType = str(raw.type || raw.sport);
  w.name = str(raw.name);

  // Intervals.icu always returns start_date_local; the UTC instant is
  // sometimes present as start_date. Prefer the absolute instant when given.
  w.startDate = str(raw.start_date || raw.start_date_local);
  w.startDateLocal = str(raw.start_date_local);
  w.timezone = str(raw.timezone || raw.icu_timezone);

  w.distanceMeters = num(raw.distance) ?? num(raw.icu_distance);
  w.movingTimeSeconds = num(raw.moving_time) ?? num(raw.icu_moving_time);
  w.elapsedTimeSeconds = num(raw.elapsed_time) ?? w.movingTimeSeconds;
  w.durationSeconds = w.elapsedTimeSeconds ?? w.movingTimeSeconds;

  w.averageHeartrate = num(raw.average_heartrate) ?? num(raw.icu_average_hr);
  w.maxHeartrate = num(raw.max_heartrate) ?? num(raw.icu_max_hr);
  w.elevationGainMeters = num(raw.total_elevation_gain) ?? num(raw.icu_elevation_gain);
  w.caloriesKcal = num(raw.calories) ?? num(raw.icu_calories);
  w.averageCadence = num(raw.average_cadence) ?? num(raw.icu_average_cadence);
  w.averagePowerWatts = num(raw.icu_average_watts) ?? num(raw.average_watts) ??
    num(raw.icu_weighted_avg_watts);
  // Intervals.icu computes its own training load (TSS-equivalent).
  w.trainingLoad = num(raw.icu_training_load) ?? num(raw.training_load);

  w.hasGps = Boolean(raw.start_latlng || raw.map || raw.has_gps);
  w.hasHeartRate = w.averageHeartrate != null;
  w.trainer = Boolean(raw.trainer) ||
    /indoor|treadmill|virtual/i.test(String(raw.type || ""));
  w.averagePaceSecPerKm = derivePace(w.distanceMeters, w.movingTimeSeconds);

  /*
   * Cross-provider evidence. When the athlete has Strava connected to
   * Intervals.icu, the activity carries its Strava origin — which lets us
   * match it to an already-imported Strava row with certainty rather than
   * guessing from timestamps.
   */
  w.upstreamSource = str(raw.source) || null;         // e.g. "STRAVA", "GARMIN"
  w.upstreamId = str(raw.strava_id || raw.external_id) || null;

  w.importedAt = new Date().toISOString();
  return w;
}

/* ───────────────────────── storage adapter ──────────────────────────── */

/*
 * Maps a normalized workout to the EXISTING activities row shape. Known
 * fields go to their columns (so coaching logic is unchanged); the richer
 * normalized fields (device, calories, power, GPS, training load) are kept
 * in the existing `raw_data` jsonb — no migration required.
 */
export function toActivityRow(userId, workout, rawPayload, opts) {
  opts = opts || {};
  const w = workout || {};
  const avgSpeed = (num(w.distanceMeters) && num(w.movingTimeSeconds))
    ? w.distanceMeters / w.movingTimeSeconds : null;
  return {
    user_id: userId,
    source: w.provider,
    external_activity_id: w.externalId,
    name: w.name,
    sport_type: w.sport,
    activity_type: w.sport,
    distance_meters: num(w.distanceMeters),
    moving_time_seconds: num(w.movingTimeSeconds),
    elapsed_time_seconds: num(w.elapsedTimeSeconds),
    elevation_gain_meters: num(w.elevationGainMeters),
    average_speed_mps: avgSpeed,
    average_heartrate: num(w.averageHeartrate),
    max_heartrate: num(w.maxHeartrate),
    average_cadence: num(w.averageCadence),
    start_date: w.startDate,
    timezone: w.timezone,
    trainer: Boolean(w.trainer),
    raw_data: {
      // provider extras preserved without a schema change
      device: w.device,
      calories_kcal: num(w.caloriesKcal),
      average_power_watts: num(w.averagePowerWatts),
      training_load: num(w.trainingLoad),
      has_gps: Boolean(w.hasGps),
      has_heart_rate: Boolean(w.hasHeartRate),
      average_pace_sec_per_km: num(w.averagePaceSecPerKm),
      // Gateway provenance — used by cross-provider deduplication.
      upstream_source: w.upstreamSource || null,
      upstream_id: w.upstreamId || null,
      // Lap/interval structure in the SAME shape the Strava importer writes,
      // so js/workoutClassifier.js consumes it with no change whatsoever.
      // Only stored when there is real structure to detect (>1 lap).
      ...(Array.isArray(w.laps) && w.laps.length > 1 ? { laps: w.laps } : {}),
      normalized: w,
      // PART 1: TRUE idempotency. Preserve an existing recognition at the
      // current version EXACTLY (including analyzedAt); only (re)compute when it
      // is missing, stale, or a reanalysis is explicitly forced. A normal
      // provider re-sync therefore never re-runs recognizeWorkout.
      recognition: reuseOrBuildRecognition(w, opts.existingRecognition, opts.forceReanalyze, opts.zones),
      provider_payload: rawPayload !== undefined ? rawPayload : null
    },
    updated_at: new Date().toISOString()
  };
}

/*
 * Runs the recognition engine over a normalized workout and returns a compact,
 * storable record. The coachSummary IS the automatic coaching insight (Part 3):
 * generated once here, stored, and never regenerated on its own. Zones are not
 * available at import time, so recognition uses title + structure + duration;
 * the client can enrich confidence later with the athlete's zones if needed.
 */
export const RECOGNITION_VERSION = "recognition-v2";

/*
 * Idempotency gate. Returns the EXISTING recognition untouched when it is
 * present and already at the current version (unless a reanalysis is forced);
 * otherwise computes a fresh one. This is what makes "analyze once" a real
 * guarantee rather than a claim resting on determinism.
 */
/*
 * Recognition record from an EXISTING stored activities row (backfill path).
 * Reads the row's own fields + raw_data.laps; deterministic, same shape as
 * buildRecognition. Never throws.
 */
export function buildRecognitionFromRow(row, zones) {
  return buildRecognition({
    name: row && row.name,
    distanceMeters: row && row.distance_meters,
    movingTimeSeconds: row && row.moving_time_seconds,
    elapsedTimeSeconds: row && row.elapsed_time_seconds,
    averageHeartrate: row && row.average_heartrate,
    maxHeartrate: row && row.max_heartrate,
    elevationGainMeters: row && row.elevation_gain_meters,
    laps: row && row.raw_data ? row.raw_data.laps : null
  }, zones);
}

export function reuseOrBuildRecognition(w, existing, force, zones) {
  if (!force && existing && existing.version === RECOGNITION_VERSION && existing.workoutType) {
    return existing;            // preserve exactly — analyzedAt included
  }
  return buildRecognition(w, zones);
}

export function buildRecognition(w, zones) {
  try {
    const activity = {
      name: w.name,
      distance_meters: w.distanceMeters,
      moving_time_seconds: w.movingTimeSeconds,
      elapsed_time_seconds: w.elapsedTimeSeconds,
      average_heartrate: w.averageHeartrate,
      max_heartrate: w.maxHeartrate,
      total_elevation_gain: w.elevationGainMeters,
      laps: Array.isArray(w.laps) ? w.laps : null
    };
    const r = recognizeWorkout(activity, zones ? { zones } : {});
    return {
      workoutType: r.workoutType,
      confidence: r.confidence,
      confidenceLabel: r.confidenceLabel,
      segments: r.segments,
      coachSummary: r.coachSummary,
      signals: r.signals,
      analyzedAt: new Date().toISOString(),
      version: RECOGNITION_VERSION
    };
  } catch (e) {
    // Recognition must never break an import.
    return null;
  }
}

/*
 * The one entry point the import pipeline calls: given a provider key and a
 * raw provider activity, return the normalized workout. Unknown providers
 * throw a clear error (never silently mis-store).
 */
/*
 * Intervals.icu interval/lap structure → the EXACT lap shape the Strava
 * importer already writes to raw_data.laps, which is what
 * js/workoutClassifier.js reads (distance + moving_time / average_speed).
 *
 * Intervals.icu returns detected intervals with `distance`, `moving_time`,
 * `elapsed_time`, `average_speed` and `average_heartrate`; some payloads use
 * `icu_`-prefixed HR/speed variants, so each is read through a fallback.
 * Anything without a usable distance AND duration is dropped rather than
 * guessed, because a malformed lap would mislead the classifier.
 */
export function normalizeIntervalLaps(rawLaps) {
  if (!Array.isArray(rawLaps)) return null;
  const laps = rawLaps.map((l, i) => {
    const distance = num(l.distance) ?? num(l.icu_distance);
    const moving = num(l.moving_time) ?? num(l.icu_moving_time) ?? num(l.elapsed_time);
    if (!distance || !moving) return null;
    return {
      distance,
      moving_time: moving,
      elapsed_time: num(l.elapsed_time) ?? moving,
      average_speed: num(l.average_speed) ?? (distance / moving),
      average_heartrate: num(l.average_heartrate) ?? num(l.icu_average_hr),
      // Intervals.icu labels structured intervals ("WARMUP" | "WORK" |
      // "RECOVERY" | "COOLDOWN" | "REST"). Preserve it: when present it IS the
      // true structure, so the segmenter uses it directly instead of guessing.
      type: (l.type != null ? String(l.type) : null),
      label: (l.label != null ? String(l.label) : null),
      lap_index: num(l.lap_index) ?? i + 1
    };
  }).filter(Boolean);
  return laps.length ? laps : null;
}

export function normalizeWorkout(providerKey, raw) {
  switch (providerKey) {
    case "strava": return mapStrava(raw);
    case "terra": return mapTerra(raw);
    case "intervals": return mapIntervals(raw);
    default:
      throw new Error(`No normalizer registered for provider "${providerKey}".`);
  }
}

export const NORMALIZER_VERSION = "wearable-normalizer-v1";
