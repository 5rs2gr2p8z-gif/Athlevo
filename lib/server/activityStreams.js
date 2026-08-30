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
  fixed_heartrate: "heartrate",
  velocity: "velocity",
  velocity_smooth: "velocity",
  speed: "velocity",
  ga_velocity: "velocity",
  altitude: "altitude",
  elevation: "altitude",
  fixed_altitude: "altitude",
  cadence: "cadence",
  watts: "watts",
  power: "watts",
  raw_watts: "watts",
  fixed_watts: "watts",
  latlng: "latlng",
  lat_lng: "latlng",
  icu_speed: "velocity",
  pace: "velocity",
  fixed_cadence: "cadence"
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

function coerceNumericSeries(value) {
  if (Array.isArray(value)) return asFiniteArray(value);
  if (typeof value === "string") {
    const parts = value.split(/[\s,]+/).filter(Boolean);
    return parts.length >= 3 ? asFiniteArray(parts.map(Number)) : null;
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.data) || Array.isArray(value.values) || Array.isArray(value.stream)) {
      return asFiniteArray(value.data || value.values || value.stream);
    }
    const keys = Object.keys(value);
    if (keys.length >= 3 && keys.every(k => /^\d+$/.test(k))) {
      return asFiniteArray(keys.sort((a, b) => Number(a) - Number(b)).map(k => value[k]));
    }
  }
  return null;
}

function seriesFromStreamEntry(entry) {
  if (entry == null) return null;
  if (Array.isArray(entry) || typeof entry === "string") return coerceNumericSeries(entry);
  if (typeof entry === "object") return coerceNumericSeries(entry.data || entry.values || entry.stream || entry);
  return null;
}

function emptyStreams() {
  return { version: STREAM_VERSION, time: null, distance: null, heartrate: null, velocity: null, altitude: null, cadence: null, watts: null, latlng: null };
}

export function unwrapStreamsPayload(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (payload.streams && (Array.isArray(payload.streams) || typeof payload.streams === "object")) {
      return payload.streams;
    }
    if (payload.data && (Array.isArray(payload.data) || (payload.data && typeof payload.data === "object" && (payload.data.heartrate || payload.data.time || payload.data.streams)))) {
      return payload.data;
    }
  }
  return payload;
}

export function intervalsActivityIdCandidates(externalId) {
  const id = String(externalId || "").trim();
  if (!id) return [];
  const ids = [id];
  if (/^i/i.test(id)) ids.push(id.slice(1));
  else ids.push("i" + id);
  return ids.filter((value, index, all) => value && all.indexOf(value) === index);
}

function maybeVelocityFromPace(series) {
  if (!series) return null;
  const first = series.find(v => Number.isFinite(v));
  if (Number.isFinite(first) && first >= 40) {
    return series.map(v => Number.isFinite(v) && v > 0 ? 1000 / v : null);
  }
  return series;
}

export function deriveVelocityFromDistance(time, distance) {
  if (!Array.isArray(time) || !Array.isArray(distance) || time.length < 3 || distance.length < 3) return null;
  const n = Math.min(time.length, distance.length);
  const out = [];
  let usable = 0;
  for (let i = 0; i < n; i += 1) {
    if (i === 0) {
      out.push(null);
      continue;
    }
    const dt = Number(time[i]) - Number(time[i - 1]);
    const dd = Number(distance[i]) - Number(distance[i - 1]);
    if (Number.isFinite(dt) && dt > 0 && Number.isFinite(dd) && dd >= 0) {
      out.push(dd / dt);
      usable += 1;
    } else out.push(null);
  }
  if (out[0] == null && Number.isFinite(out[1])) out[0] = out[1];
  return usable >= 3 ? out : null;
}

function readLatLng(entry) {
  if (!entry) return null;
  if (Array.isArray(entry) && entry.length >= 2 && Array.isArray(entry[0])) return entry;
  if (Array.isArray(entry.data) && Array.isArray(entry.data2) && entry.data.length >= 2) {
    return entry.data.map((lat, i) => [lat, entry.data2[i]]);
  }
  return null;
}

export function normalizeProviderStreams(payload) {
  const streams = emptyStreams();
  const incoming = unwrapStreamsPayload(payload);
  if (!incoming) return streams;
  let lat = null;
  let lng = null;

  const apply = (type, data) => {
    const rawType = String(type || "").toLowerCase();
    if (rawType === "lat" || rawType === "latitude") {
      lat = seriesFromStreamEntry(data);
      return;
    }
    if (rawType === "lng" || rawType === "lon" || rawType === "longitude") {
      lng = seriesFromStreamEntry(data);
      return;
    }
    const key = TYPE_ALIASES[rawType];
    if (!key || streams[key]) return;
    if (key === "latlng") {
      const pts = readLatLng(data);
      if (pts && pts.length >= 2) streams.latlng = pts;
      return;
    }
    let series = seriesFromStreamEntry(data);
    if (key === "velocity") series = maybeVelocityFromPace(series);
    if (series) streams[key] = series;
  };

  if (Array.isArray(incoming)) {
    incoming.forEach(item => {
      if (!item || typeof item !== "object") return;
      apply(item.type || item.name || item.key, item);
    });
  } else if (typeof incoming === "object") {
    Object.keys(incoming).forEach(type => apply(type, incoming[type]));
  }

  if (!streams.latlng && lat && lng) {
    const n = Math.min(lat.length, lng.length);
    const pts = [];
    for (let i = 0; i < n; i += 1) {
      if (Number.isFinite(lat[i]) && Number.isFinite(lng[i])) pts.push([lat[i], lng[i]]);
    }
    if (pts.length >= 2) streams.latlng = pts;
  }

  if (!streams.velocity) {
    streams.velocity = deriveVelocityFromDistance(streams.time, streams.distance);
  }

  alignSeries(streams);
  return streams;
}

function alignSeries(streams) {
  const metricMax = METRIC_KEYS.reduce((n, k) => Math.max(n, streams[k] ? streams[k].length : 0), 0);
  const n = (streams.time && streams.time.length >= 3) ? streams.time.length : metricMax;
  if (!n) return;
  ALL_KEYS.forEach(k => {
    if (streams[k] && streams[k].length > n) streams[k] = streams[k].slice(0, n);
  });
}

export function streamSampleCounts(streams) {
  const counts = {};
  if (!streams || typeof streams !== "object") return counts;
  ["time", "distance", ...METRIC_KEYS].forEach(k => {
    if (Array.isArray(streams[k])) counts[k] = streams[k].filter(v => Number.isFinite(v)).length;
  });
  if (Array.isArray(streams.latlng)) counts.latlng = streams.latlng.length;
  return counts;
}

export function payloadShapeKeys(payload) {
  const incoming = unwrapStreamsPayload(payload);
  if (!incoming) return [];
  if (Array.isArray(incoming)) {
    return incoming.map(item => item && (item.type || item.name || item.key)).filter(Boolean).slice(0, 20);
  }
  if (typeof incoming === "object") return Object.keys(incoming).slice(0, 20);
  return [];
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
  if (usable("cadence")) keys.push("cadence");
  if (usable("watts")) keys.push("power");
  if (usable("altitude")) {
    const finite = streams.altitude.filter(v => Number.isFinite(v));
    if (finite.length >= 3 && Math.max.apply(null, finite) - Math.min.apply(null, finite) >= 5) {
      keys.push("elevation");
    }
  }
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

export const STRAVA_STREAM_KEYS = "time,distance,heartrate,cadence,watts,altitude,velocity_smooth,latlng";
/* Official Intervals.icu names only. A bare `velocity` or Strava `latlng`
   type 400s the whole request. `types` is a repeated query param. */
export const INTERVALS_STREAM_TYPES = "time,distance,heartrate,cadence,watts,altitude,velocity_smooth,ga_velocity,lat,lng";

export function intervalsStreamsQuery(types) {
  const list = String(types || INTERVALS_STREAM_TYPES).split(",").map(s => s.trim()).filter(Boolean);
  return list.map(t => `types=${encodeURIComponent(t)}`).join("&") + "&includeDefaults=true";
}

export function parseIntervalsCsv(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 4) return null;
  const headers = lines[0].split(",").map(h => String(h || "").trim().replace(/^"|"$/g, ""));
  if (!headers.length) return null;
  const cols = {};
  headers.forEach(h => { cols[h] = []; });
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(",");
    headers.forEach((h, idx) => {
      const n = Number(parts[idx]);
      cols[h].push(Number.isFinite(n) ? n : null);
    });
  }
  return cols;
}
