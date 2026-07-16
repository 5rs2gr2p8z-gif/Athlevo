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
    timezone: null,
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

/* ───────────────────────── storage adapter ──────────────────────────── */

/*
 * Maps a normalized workout to the EXISTING activities row shape. Known
 * fields go to their columns (so coaching logic is unchanged); the richer
 * normalized fields (device, calories, power, GPS, training load) are kept
 * in the existing `raw_data` jsonb — no migration required.
 */
export function toActivityRow(userId, workout, rawPayload) {
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
      normalized: w,
      provider_payload: rawPayload !== undefined ? rawPayload : null
    },
    updated_at: new Date().toISOString()
  };
}

/*
 * The one entry point the import pipeline calls: given a provider key and a
 * raw provider activity, return the normalized workout. Unknown providers
 * throw a clear error (never silently mis-store).
 */
export function normalizeWorkout(providerKey, raw) {
  switch (providerKey) {
    case "strava": return mapStrava(raw);
    case "terra": return mapTerra(raw);
    default:
      throw new Error(`No normalizer registered for provider "${providerKey}".`);
  }
}

export const NORMALIZER_VERSION = "wearable-normalizer-v1";
