/*
 * Activity time-series streams — normalize, downsample, and persist.
 *
 * Graphs must use real samples. This module never invents a series from
 * summary averages (avg HR, avg pace, etc.).
 */

export const STREAM_VERSION = 1;
export const MAX_STREAM_POINTS = 400;

const METRIC_KEYS = ["heartrate", "velocity", "altitude", "cadence", "watts"];
const ALL_KEYS = ["time", "distance", ...METRIC_KEYS];

const TYPE_ALIASES = {
  time: "time",
  timer_time: "time",
  elapsed_time: "time",
  distance: "distance",
  heartrate: "heartrate",
  heart_rate: "heartrate",
  hr: "heartrate",
  velocity: "velocity",
  velocity_smooth: "velocity",
  speed: "velocity",
  altitude: "altitude",
  elevation: "altitude",
  cadence: "cadence",
  watts: "watts",
  power: "watts"
};

function asFiniteArray(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = [];
  let usable = 0;
  for (let i = 0; i < value.length; i += 1) {
    const n = Number(value[i]);
    if (Number.isFinite(n)) {
      out.push(n);
      usable += 1;
    } else {
      out.push(null);
    }
  }
  return usable >= 3 ? out : null;
}

function seriesFromStreamEntry(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) return asFiniteArray(entry);
  if (typeof entry === "object") return asFiniteArray(entry.data || entry.values || entry.stream);
  return null;
}

function emptyStreams() {
  return { version: STREAM_VERSION, time: null, distance: null, heartrate: null, velocity: null, altitude: null, cadence: null, watts: null };
}

export function normalizeProviderStreams(payload) {
  const streams = emptyStreams();
  if (!payload) return streams;

  const apply = (type, data) => {
    const key = TYPE_ALIASES[String(type || "").toLowerCase()];
    if (!key || streams[key]) return;
    const series = seriesFromStreamEntry(data);
    if (series) streams[key] = series;
  };

  if (Array.isArray(payload)) {
    payload.forEach(item => {
      if (!item || typeof item !== "object") return;
      apply(item.type || item.name || item.key, item);
    });
  } else if (typeof payload === "object") {
    Object.keys(payload).forEach(type => apply(type, payload[type]));
  }

  alignSeries(streams);
  return streams;
}

function alignSeries(streams) {
  const lengths = ALL_KEYS.map(k => streams[k] && streams[k].length).filter(n => Number.isFinite(n) && n > 0);
  if (!lengths.length) return;
  const n = Math.min(...lengths);
  ALL_KEYS.forEach(k => {
    if (streams[k] && streams[k].length > n) streams[k] = streams[k].slice(0, n);
  });
}

export function extractStoredStreams(raw) {
  if (!raw || typeof raw !== "object") return emptyStreams();
  const packed = raw.activity_streams || raw.streams || null;
  if (packed && typeof packed === "object") {
    const streams = normalizeProviderStreams(packed);
    if (hasUsableStreams(streams)) return streams;
  }
  const legacy = emptyStreams();
  legacy.heartrate = asFiniteArray(raw.heartrate_stream || raw.hr_stream);
  const paceOrVel = raw.velocity_stream || raw.pace_stream;
  if (Array.isArray(paceOrVel) && paceOrVel.length >= 3) {
    const first = Number(paceOrVel.find(v => Number.isFinite(Number(v))));
    // Stored pace is typically sec/km (>= 150). Velocity is m/s (usually < 20).
    if (Number.isFinite(first) && first >= 40) {
      legacy.velocity = paceOrVel.map(v => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? 1000 / n : null;
      });
    } else {
      legacy.velocity = asFiniteArray(paceOrVel);
    }
  }
  legacy.altitude = asFiniteArray(raw.altitude_stream || raw.elevation_stream);
  legacy.cadence = asFiniteArray(raw.cadence_stream);
  legacy.watts = asFiniteArray(raw.watts_stream || raw.power_stream);
  legacy.time = asFiniteArray(raw.time_stream);
  legacy.distance = asFiniteArray(raw.distance_stream);
  alignSeries(legacy);
  return legacy;
}

export function downsampleStreams(streams, maxPoints) {
  const cap = Number.isFinite(maxPoints) && maxPoints > 8 ? Math.floor(maxPoints) : MAX_STREAM_POINTS;
  const out = emptyStreams();
  if (!streams) return out;
  const sourceLen = ALL_KEYS.reduce((n, k) => Math.max(n, streams[k] ? streams[k].length : 0), 0);
  if (sourceLen < 3) return out;
  const step = sourceLen <= cap ? 1 : Math.ceil(sourceLen / cap);
  ALL_KEYS.forEach(k => {
    const series = streams[k];
    if (!series || !series.length) return;
    const sampled = [];
    for (let i = 0; i < series.length; i += step) sampled.push(series[i]);
    if (sampled.length >= 3) out[k] = sampled;
  });
  out.version = STREAM_VERSION;
  return out;
}

export function hasUsableStreams(streams) {
  if (!streams || typeof streams !== "object") return false;
  return METRIC_KEYS.some(k => Array.isArray(streams[k]) && streams[k].filter(v => Number.isFinite(v)).length >= 3);
}

export function availableGraphKeys(streams, sport) {
  const keys = [];
  if (!hasUsableStreams(streams)) return keys;
  const usable = key => Array.isArray(streams[key]) && streams[key].filter(v => Number.isFinite(v)).length >= 3;
  if (usable("velocity") && sport !== "strength" && sport !== "mobility") keys.push("pace");
  if (usable("heartrate")) keys.push("heartrate");
  if (usable("altitude")) keys.push("elevation");
  if (usable("cadence")) keys.push("cadence");
  if (usable("watts")) keys.push("power");
  return keys;
}

export function paceSeriesFromVelocity(velocity) {
  if (!Array.isArray(velocity)) return null;
  const out = velocity.map(v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0.3 ? 1000 / n : null;
  });
  return out.filter(v => Number.isFinite(v)).length >= 3 ? out : null;
}

export function packStreamsForStore(streams, meta) {
  const packed = downsampleStreams(streams, MAX_STREAM_POINTS);
  if (!hasUsableStreams(packed)) return null;
  const row = { version: STREAM_VERSION, fetchedAt: (meta && meta.fetchedAt) || new Date().toISOString() };
  if (meta && meta.source) row.source = meta.source;
  ALL_KEYS.forEach(k => {
    if (packed[k]) row[k] = packed[k];
  });
  return row;
}

export function graphSeriesFor(streams, key) {
  if (!streams) return null;
  if (key === "pace") return paceSeriesFromVelocity(streams.velocity);
  if (key === "heartrate") return streams.heartrate;
  if (key === "elevation") return streams.altitude;
  if (key === "cadence") return streams.cadence;
  if (key === "power") return streams.watts;
  return null;
}

export const STRAVA_STREAM_KEYS = "time,distance,heartrate,cadence,watts,altitude,velocity_smooth";
export const INTERVALS_STREAM_TYPES = "time,distance,heartrate,cadence,watts,altitude,velocity,velocity_smooth";
