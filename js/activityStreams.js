/*
 * Athlevo — Synchronized Activity Graph Stack
 * Intervals.icu-inspired stacked time-series graphs with shared x-axis,
 * synchronized crosshair, and compact Athlevo styling.
 */
(function (root) {
  "use strict";

  const MAX_POINTS = 400;
  const TYPE_ALIASES = {
    time: "time", timer_time: "time", elapsed_time: "time",
    distance: "distance",
    heartrate: "heartrate", heart_rate: "heartrate", hr: "heartrate",
    fixed_heartrate: "heartrate",
    velocity: "velocity", velocity_smooth: "velocity", speed: "velocity",
    ga_velocity: "velocity",
    altitude: "altitude", elevation: "altitude", fixed_altitude: "altitude",
    cadence: "cadence",
    watts: "watts", power: "watts", raw_watts: "watts", fixed_watts: "watts",
    latlng: "latlng", lat_lng: "latlng",
    icu_speed: "velocity", pace: "velocity", fixed_cadence: "cadence"
  };
  const METRIC_KEYS = ["heartrate", "velocity", "altitude", "cadence", "watts"];
  const ALL_KEYS = ["time", "distance"].concat(METRIC_KEYS).concat(["latlng"]);
  const GRAPH_ORDER = ["pace", "heartrate", "cadence", "power", "elevation"];
  const GRAPH_META = {
    pace:      { label: "PACE",       unit: "/km", color: "#4A6FA5", fillOpacity: 0.20, invert: true },
    power:     { label: "POWER",      unit: "W",   color: "#5E35B1", fillOpacity: 0.18, invert: false },
    heartrate: { label: "HEART RATE", unit: "bpm", color: "#C62828", fillOpacity: 0.18, invert: false },
    cadence:   { label: "CADENCE",    unit: "spm", color: "#7E57C2", fillOpacity: 0.16, invert: false },
    elevation: { label: "ELEVATION",  unit: "m",   color: "#78909C", fillOpacity: 0.22, invert: false }
  };

  /* ── data plumbing (unchanged) ─────────────────────────────────── */

  const memoryCache = new Map();
  const inflight = new Map();
  let lastLoadInfo = null;

  function emptyStreams() {
    return { version: 1, time: null, distance: null, heartrate: null, velocity: null, altitude: null, cadence: null, watts: null, latlng: null };
  }

  function asFiniteArray(value) {
    if (!Array.isArray(value) || value.length < 3) return null;
    const out = [];
    let usable = 0;
    for (let i = 0; i < value.length; i += 1) {
      const n = Number(value[i]);
      if (Number.isFinite(n)) { out.push(n); usable += 1; }
      else out.push(null);
    }
    return usable >= 3 ? out : null;
  }

  function seriesFromEntry(entry) {
    if (entry == null) return null;
    if (Array.isArray(entry)) return asFiniteArray(entry);
    if (typeof entry === "object") return asFiniteArray(entry.data || entry.values || entry.stream);
    return null;
  }

  function alignSeries(streams) {
    const metricMax = METRIC_KEYS.reduce((n, k) => Math.max(n, streams[k] ? streams[k].length : 0), 0);
    const n = (streams.time && streams.time.length >= 3) ? streams.time.length : metricMax;
    if (!n) return;
    ALL_KEYS.forEach(k => {
      if (k === "latlng") return;
      if (streams[k] && streams[k].length > n) streams[k] = streams[k].slice(0, n);
    });
  }

  function unwrapStreamsPayload(payload) {
    if (!payload) return null;
    if (Array.isArray(payload)) return payload;
    if (payload.streams && (Array.isArray(payload.streams) || typeof payload.streams === "object")) return payload.streams;
    return payload;
  }

  function maybeVelocityFromPace(series) {
    if (!series) return null;
    const first = series.find(v => Number.isFinite(v));
    if (Number.isFinite(first) && first >= 40) {
      return series.map(v => Number.isFinite(v) && v > 0 ? 1000 / v : null);
    }
    return series;
  }

  function deriveVelocityFromDistance(time, distance) {
    if (!Array.isArray(time) || !Array.isArray(distance) || time.length < 3 || distance.length < 3) return null;
    const n = Math.min(time.length, distance.length);
    const out = [];
    let usable = 0;
    for (let i = 0; i < n; i += 1) {
      if (i === 0) { out.push(null); continue; }
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

  function normalizeProviderStreams(payload) {
    const streams = emptyStreams();
    const incoming = unwrapStreamsPayload(payload);
    if (!incoming) return streams;
    let lat = null;
    let lng = null;
    const apply = (type, data) => {
      const rawType = String(type || "").toLowerCase();
      if (rawType === "lat" || rawType === "latitude") {
        lat = seriesFromEntry(data);
        return;
      }
      if (rawType === "lng" || rawType === "lon" || rawType === "longitude") {
        lng = seriesFromEntry(data);
        return;
      }
      const key = TYPE_ALIASES[rawType];
      if (!key || streams[key]) return;
      if (key === "latlng") {
        if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[0])) streams.latlng = data;
        else if (data && Array.isArray(data.data) && Array.isArray(data.data2) && data.data.length >= 2) {
          streams.latlng = data.data.map((la, i) => [la, data.data2[i]]);
        } else {
          const arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
          if (arr && arr.length >= 2) streams.latlng = arr;
        }
        return;
      }
      let series = seriesFromEntry(data);
      if (key === "velocity") series = maybeVelocityFromPace(series);
      if (series) streams[key] = series;
    };
    if (Array.isArray(incoming)) {
      incoming.forEach(item => {
        if (item && typeof item === "object") apply(item.type || item.name || item.key, item);
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
    if (!streams.velocity) streams.velocity = deriveVelocityFromDistance(streams.time, streams.distance);
    alignSeries(streams);
    return streams;
  }

  function extractStoredStreams(raw) {
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

  function downsampleStreams(streams, maxPoints) {
    const cap = Number.isFinite(maxPoints) && maxPoints > 8 ? Math.floor(maxPoints) : MAX_POINTS;
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
    return out;
  }

  function hasUsableStreams(streams) {
    if (!streams || typeof streams !== "object") return false;
    return METRIC_KEYS.some(k => Array.isArray(streams[k]) && streams[k].filter(v => Number.isFinite(v)).length >= 3);
  }

  function elevationIsMeaningful(streams) {
    const alt = streams && streams.altitude;
    if (!Array.isArray(alt)) return false;
    const finite = alt.filter(v => Number.isFinite(v));
    if (finite.length < 3) return false;
    return Math.max.apply(null, finite) - Math.min.apply(null, finite) >= 5;
  }

  function availableGraphKeys(streams, sport) {
    const keys = [];
    if (!hasUsableStreams(streams)) return keys;
    const usable = key => Array.isArray(streams[key]) && streams[key].filter(v => Number.isFinite(v)).length >= 3;
    if (usable("velocity") && sport !== "strength" && sport !== "mobility") keys.push("pace");
    if (usable("heartrate")) keys.push("heartrate");
    if (usable("cadence")) keys.push("cadence");
    if (usable("watts")) keys.push("power");
    if (usable("altitude") && elevationIsMeaningful(streams)) keys.push("elevation");
    return GRAPH_ORDER.filter(k => keys.indexOf(k) >= 0);
  }

  function paceSeriesFromVelocity(velocity) {
    if (!Array.isArray(velocity)) return null;
    const out = velocity.map(v => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0.3 ? 1000 / n : null;
    });
    return out.filter(v => Number.isFinite(v)).length >= 3 ? out : null;
  }

  function graphSeriesFor(streams, key) {
    if (!streams) return null;
    if (key === "pace") return paceSeriesFromVelocity(streams.velocity);
    if (key === "heartrate") return streams.heartrate;
    if (key === "elevation") return streams.altitude;
    if (key === "cadence") return streams.cadence;
    if (key === "power") return streams.watts;
    return null;
  }

  function cacheKey(activity) {
    return activity && activity.id != null ? String(activity.id) : null;
  }
  function cacheGet(id) { return memoryCache.get(String(id)) || null; }
  function cacheSet(id, streams) { if (id != null) memoryCache.set(String(id), streams); }

  function streamsFromActivity(activity) {
    const raw = activity && activity.raw_data && typeof activity.raw_data === "object" ? activity.raw_data : {};
    return extractStoredStreams(raw);
  }

  function attachStreams(activity, streams) {
    if (!activity || !hasUsableStreams(streams)) return;
    activity.raw_data = activity.raw_data && typeof activity.raw_data === "object" ? activity.raw_data : {};
    activity.raw_data.activity_streams = streams;
  }

  function rememberLoadInfo(info) {
    lastLoadInfo = info && typeof info === "object" ? info : null;
    return lastLoadInfo;
  }

  async function fetchRemoteStreams(activityId) {
    if (typeof supabaseClient === "undefined" || !supabaseClient.auth) {
      rememberLoadInfo({ reason: "fetch_failed", http_status: 0 });
      return null;
    }
    let token = null;
    try {
      const session = await supabaseClient.auth.getSession();
      token = session && session.data && session.data.session && session.data.session.access_token;
    } catch (e) { token = null; }
    if (!token) {
      rememberLoadInfo({ reason: "fetch_failed", http_status: 401 });
      return null;
    }
    const res = await fetch("/api/providers?action=activity_streams", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ activityId: String(activityId) }),
      cache: "no-store"
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    rememberLoadInfo({
      reason: (body && body.reason) || (res.ok ? "no_streams" : "fetch_failed"),
      http_status: (body && body.http_status) || res.status,
      source: body && body.source || null,
      fetched_from: body && body.fetched_from || null,
      upstream_source: body && body.upstream_source || null,
      external_id: body && body.external_id || null,
      activity_id: body && body.activity_id || null,
      available: (body && body.available) || [],
      sample_counts: (body && body.sample_counts) || {},
      payload_keys: (body && body.payload_keys) || []
    });
    if (!res.ok && (!body || !body.streams)) {
      console.warn("[Athlevo] stream fetch HTTP", res.status, lastLoadInfo && lastLoadInfo.reason);
      return null;
    }
    if (!body || !body.streams) return null;
    const streams = normalizeProviderStreams(body.streams);
    return hasUsableStreams(streams) ? streams : null;
  }

  async function loadStreams(activity) {
    const id = cacheKey(activity);
    if (!id) {
      const local = downsampleStreams(streamsFromActivity(activity));
      return hasUsableStreams(local) ? local : emptyStreams();
    }
    const cached = cacheGet(id);
    if (cached && hasUsableStreams(cached)) return cached;
    const stored = downsampleStreams(streamsFromActivity(activity));
    if (hasUsableStreams(stored)) {
      cacheSet(id, stored);
      return stored;
    }
    if (inflight.has(id)) return inflight.get(id);
    const pending = fetchRemoteStreams(id).then(remote => {
      const streams = remote && hasUsableStreams(remote) ? downsampleStreams(remote) : emptyStreams();
      if (hasUsableStreams(streams)) {
        cacheSet(id, streams);
        attachStreams(activity, streams);
      }
      return streams;
    }).catch(e => {
      console.warn("[Athlevo] stream load error:", e);
      return emptyStreams();
    }).finally(() => { inflight.delete(id); });
    inflight.set(id, pending);
    return pending;
  }

  /* ══════════════════════════════════════════════════════════════════
   *  PART 2 — Synchronized Graph Stack Renderer
   * ══════════════════════════════════════════════════════════════════ */

  function pad(n) { return String(n).padStart(2, "0"); }

  function fmtElapsed(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0 ? h + ":" + pad(m) + ":" + pad(r) : m + ":" + pad(r);
  }

  function fmtPace(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return "—";
    const s = Math.round(sec);
    return Math.floor(s / 60) + ":" + pad(s % 60);
  }

  function formatMetricValue(key, value, sport) {
    if (!Number.isFinite(value)) return "—";
    if (key === "pace") return fmtPace(value) + "/km";
    if (key === "heartrate") return Math.round(value) + " bpm";
    if (key === "elevation") return Math.round(value) + " m";
    if (key === "cadence") return Math.round(value) + (sport === "ride" ? " rpm" : " spm");
    if (key === "power") return Math.round(value) + " W";
    return String(Math.round(value));
  }

  function formatAvgValue(key, values, sport) {
    const finite = values.filter(v => Number.isFinite(v));
    if (!finite.length) return "";
    const avg = finite.reduce((a, b) => a + b, 0) / finite.length;
    return formatMetricValue(key, avg, sport);
  }

  /* ── SVG chart builder ─────────────────────────────────────────── */

  const CHART_W = 640;
  const CHART_H = 100;
  const PAD_Y = 8;

  function niceYTicks(min, max, count) {
    if (max === min) { min -= 1; max += 1; }
    const range = max - min;
    const step = range / (count + 1);
    const ticks = [];
    for (let i = 1; i <= count; i++) ticks.push(min + step * i);
    return ticks;
  }

  function formatYLabel(key, value) {
    if (key === "pace") return fmtPace(value);
    if (key === "heartrate") return String(Math.round(value));
    if (key === "elevation") return String(Math.round(value));
    if (key === "cadence") return String(Math.round(value));
    if (key === "power") return String(Math.round(value));
    return String(Math.round(value));
  }

  function downsamplePaired(values, times, maxPoints) {
    if (!values || !values.length) return { values: [], times: null };
    if (values.length <= maxPoints) {
      return {
        values: values.slice(),
        times: times && times.length === values.length ? times.slice() : null
      };
    }
    const step = Math.ceil(values.length / maxPoints);
    const outV = [];
    const outT = [];
    const keepTime = times && times.length === values.length;
    for (let i = 0; i < values.length; i += step) {
      outV.push(values[i]);
      if (keepTime) outT.push(times[i]);
    }
    return { values: outV, times: outT.length ? outT : null };
  }

  function streamDuration(streams) {
    if (streams && streams.time && streams.time.length >= 2) {
      const t0 = Number(streams.time[0]) || 0;
      const t1 = Number(streams.time[streams.time.length - 1]);
      if (Number.isFinite(t1) && t1 > t0) return t1 - t0;
    }
    return 0;
  }

  function sharedGridRatios(streams) {
    const duration = streamDuration(streams);
    if (duration > 0) {
      let step = 15 * 60;
      if (duration <= 20 * 60) step = 5 * 60;
      else if (duration <= 90 * 60) step = 15 * 60;
      else if (duration <= 3 * 3600) step = 30 * 60;
      else step = 60 * 60;
      const ratios = [];
      for (let t = step; t < duration - step * 0.15; t += step) ratios.push(t / duration);
      if (ratios.length) return ratios;
    }
    return [0.25, 0.5, 0.75];
  }

  function xForSample(i, sampled, sampledTime, plotW) {
    if (sampledTime && sampledTime.length === sampled.length) {
      const t0 = Number(sampledTime[0]) || 0;
      const t1 = Number(sampledTime[sampledTime.length - 1]);
      const t = Number(sampledTime[i]);
      if (Number.isFinite(t) && Number.isFinite(t1) && t1 > t0) {
        return ((t - t0) / (t1 - t0)) * plotW;
      }
    }
    return (i / Math.max(1, sampled.length - 1)) * plotW;
  }

  function buildChartSVG(values, meta, key, gridPositions, times) {
    const sampled = downsamplePaired(values, times, 280);
    const nums = sampled.values.filter(v => Number.isFinite(v));
    if (nums.length < 3) return "";

    const W = CHART_W;
    const H = CHART_H;
    let min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    if (max === min) { min -= 1; max += 1; }
    const rangePad = (max - min) * 0.06;
    min -= rangePad;
    max += rangePad;
    const range = max - min;

    const toY = v => {
      const norm = (v - min) / range;
      return meta.invert
        ? PAD_Y + norm * (H - 2 * PAD_Y)
        : H - PAD_Y - norm * (H - 2 * PAD_Y);
    };

    let gridSvg = "";
    gridPositions.forEach(ratio => {
      const x = (ratio * W).toFixed(2);
      gridSvg += '<line class="adg-vgrid" x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '"/>';
    });

    const yTicks = niceYTicks(min, max, 2);
    let yLabelHtml = "";
    yTicks.forEach(val => {
      const y = toY(val);
      gridSvg += '<line class="adg-hgrid" x1="0" y1="' + y.toFixed(1) + '" x2="' + W + '" y2="' + y.toFixed(1) + '"/>';
      yLabelHtml += '<span class="adg-ylabel" style="top:' + ((y / H) * 100).toFixed(1) + '%">' + formatYLabel(key, val) + '</span>';
    });

    const points = [];
    sampled.values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = xForSample(i, sampled.values, sampled.times, W);
      points.push(x.toFixed(2) + "," + toY(v).toFixed(1));
    });
    if (points.length < 3) return "";

    const clipId = "adg-clip-" + key;
    const linePath = "M" + points.join("L");
    const areaPath = "M0," + H + "L" + points.join("L") + "L" + W + "," + H + "Z";

    const svg = '<svg class="adg-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<defs><clipPath id="' + clipId + '"><rect x="0" y="0" width="' + W + '" height="' + H + '"/></clipPath></defs>'
      + gridSvg
      + '<g clip-path="url(#' + clipId + ')">'
      + '<path class="adg-fill" d="' + areaPath + '" fill="' + meta.color + '" fill-opacity="' + meta.fillOpacity + '"/>'
      + '<path class="adg-line" d="' + linePath + '" fill="none" stroke="' + meta.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + "</g></svg>";

    return { svg: svg, yLabels: yLabelHtml, min: min, max: max };
  }

  /* ── Time axis ─────────────────────────────────────────────────── */

  function buildTimeAxis(streams, gridPositions) {
    const duration = streamDuration(streams);
    const labels = [];
    if (duration > 0) {
      const t0 = Number(streams.time[0]) || 0;
      labels.push({ ratio: 0, text: fmtElapsed(t0) });
      gridPositions.forEach(r => {
        labels.push({ ratio: r, text: fmtElapsed(t0 + r * duration) });
      });
      labels.push({ ratio: 1, text: fmtElapsed(t0 + duration) });
    } else if (streams.distance && streams.distance.length >= 2) {
      const maxD = streams.distance[streams.distance.length - 1] || 0;
      labels.push({ ratio: 0, text: "0 km" });
      gridPositions.forEach(r => {
        const idx = Math.round(r * (streams.distance.length - 1));
        const d = streams.distance[idx];
        if (Number.isFinite(d)) labels.push({ ratio: r, text: (d / 1000).toFixed(1) });
      });
      labels.push({ ratio: 1, text: (maxD / 1000).toFixed(1) + " km" });
    } else {
      return "";
    }

    let html = '<div class="adg-time-axis">';
    labels.forEach(l => {
      html += '<span class="adg-time-label" style="left:' + (l.ratio * 100).toFixed(1) + '%">' + l.text + '</span>';
    });
    html += '</div>';
    return html;
  }

  /* ── Crosshair tooltip ─────────────────────────────────────────── */

  function crosshairValueHtml(streams, keys, index, sport) {
    const parts = [];
    // Time
    if (streams.time && Number.isFinite(streams.time[index])) {
      parts.push('<span class="adg-xh-time">' + fmtElapsed(streams.time[index]) + '</span>');
    }
    keys.forEach(key => {
      const series = graphSeriesFor(streams, key);
      if (!series) return;
      const val = series[index];
      if (!Number.isFinite(val)) return;
      const m = GRAPH_META[key];
      parts.push('<span class="adg-xh-val" style="color:' + m.color + '">'
        + m.label + ' ' + formatMetricValue(key, val, sport) + '</span>');
    });
    return parts.join("");
  }

  /* ── Main render ───────────────────────────────────────────────── */

  function renderStackedCharts(streams, sport) {
    const keys = availableGraphKeys(streams, sport);
    if (!keys.length) return "";

    const gridPositions = sharedGridRatios(streams);

    let html = '<div class="adg-stack" role="group" aria-label="Activity telemetry">';
    html += '<div class="adg-crosshair-tooltip" id="adgCrosshairTooltip"></div>';

    keys.forEach((key, idx) => {
      const series = graphSeriesFor(streams, key);
      const meta = GRAPH_META[key];
      if (!series || !meta) return;

      const finite = series.filter(v => Number.isFinite(v));
      if (finite.length < 3) return;

      const avg = formatAvgValue(key, series, sport);
      const built = buildChartSVG(series, meta, key, gridPositions, streams.time);
      if (!built) return;

      html += '<div class="adg-chart' + (idx === 0 ? " adg-chart--first" : "") + '" data-stream="' + key + '">'
        + '<div class="adg-chart-head">'
        + '<span class="adg-chart-label" style="color:' + meta.color + '">' + meta.label + '</span>'
        + (avg ? '<span class="adg-chart-avg">' + avg + '</span>' : '')
        + '<span class="adg-chart-readout"></span>'
        + '</div>'
        + '<div class="adg-chart-body">'
        + '<div class="adg-ylabels">' + built.yLabels + '</div>'
        + '<div class="adg-plot">'
        + built.svg
        + '<div class="adg-crosshair"></div>'
        + '</div>'
        + '</div>'
        + '</div>';
    });

    html += buildTimeAxis(streams, gridPositions);
    html += '</div>';
    return html;
  }

  /* ── Interaction: synchronized crosshair ───────────────────────── */

  function bindChartInteraction(rootEl, streams, sport) {
    if (!rootEl || !streams) return;

    const stack = rootEl.querySelector(".adg-stack");
    if (!stack) return;

    const charts = stack.querySelectorAll(".adg-chart");
    const keys = [];
    const seriesMap = {};
    charts.forEach(c => {
      const k = c.getAttribute("data-stream");
      keys.push(k);
      seriesMap[k] = graphSeriesFor(streams, k);
    });

    if (!keys.length) return;

    const refSeries = seriesMap[keys[0]];
    if (!refSeries) return;
    const dataLen = refSeries.length;
    const times = streams.time && streams.time.length ? streams.time : null;

    function indexFromRatio(ratio) {
      const clamped = Math.max(0, Math.min(1, ratio));
      if (times && times.length >= 2) {
        const t0 = Number(times[0]) || 0;
        const t1 = Number(times[times.length - 1]);
        if (Number.isFinite(t1) && t1 > t0) {
          const target = t0 + clamped * (t1 - t0);
          let best = 0, bestD = Infinity;
          for (let i = 0; i < times.length; i += 1) {
            const d = Math.abs(Number(times[i]) - target);
            if (d < bestD) { bestD = d; best = i; }
          }
          return best;
        }
      }
      return Math.max(0, Math.min(dataLen - 1, Math.round(clamped * (dataLen - 1))));
    }

    const tooltip = stack.querySelector(".adg-crosshair-tooltip");
    let active = false;

    function showCrosshair(ratio) {
      const clampedRatio = Math.max(0, Math.min(1, ratio));
      const pct = (clampedRatio * 100).toFixed(2) + "%";
      const idx = indexFromRatio(clampedRatio);

      charts.forEach(c => {
        const line = c.querySelector(".adg-crosshair");
        if (line) {
          line.style.left = pct;
          line.classList.add("active");
        }
        const readout = c.querySelector(".adg-chart-readout");
        const key = c.getAttribute("data-stream");
        const series = seriesMap[key];
        if (readout && series) {
          readout.textContent = formatMetricValue(key, series[idx], sport);
        }
      });

      if (tooltip) {
        tooltip.innerHTML = crosshairValueHtml(streams, keys, idx, sport);
        tooltip.style.left = pct;
        tooltip.classList.add("active");
      }
      active = true;
    }

    function hideCrosshair() {
      charts.forEach(c => {
        const line = c.querySelector(".adg-crosshair");
        if (line) line.classList.remove("active");
        const readout = c.querySelector(".adg-chart-readout");
        if (readout) readout.textContent = "";
      });
      if (tooltip) tooltip.classList.remove("active");
      active = false;
    }

    function ratioFromEvent(e, target) {
      const rect = target.getBoundingClientRect();
      if (!rect.width) return -1;
      const clientX = e.clientX != null ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : -1);
      if (clientX < 0) return -1;
      return (clientX - rect.left) / rect.width;
    }

    // Attach to each chart's plot area
    charts.forEach(c => {
      const plot = c.querySelector(".adg-plot");
      if (!plot) return;

      plot.addEventListener("pointerdown", e => {
        e.preventDefault();
        const r = ratioFromEvent(e, plot);
        if (r >= 0) showCrosshair(r);
      });
      plot.addEventListener("pointermove", e => {
        if (e.buttons > 0 || e.pointerType === "mouse") {
          const r = ratioFromEvent(e, plot);
          if (r >= 0) showCrosshair(r);
        }
      });
      plot.addEventListener("pointerleave", () => { hideCrosshair(); });
      plot.addEventListener("pointerup", () => { /* keep visible until leave */ });

      // Touch
      plot.addEventListener("touchstart", e => {
        if (e.touches.length === 1) {
          const touch = e.touches[0];
          const rect = plot.getBoundingClientRect();
          showCrosshair((touch.clientX - rect.left) / rect.width);
        }
      }, { passive: true });
      plot.addEventListener("touchmove", e => {
        if (e.touches.length === 1) {
          const touch = e.touches[0];
          const rect = plot.getBoundingClientRect();
          showCrosshair((touch.clientX - rect.left) / rect.width);
        }
      }, { passive: true });
      plot.addEventListener("touchend", () => { hideCrosshair(); }, { passive: true });
    });
  }

  /* ── Public render entry point ─────────────────────────────────── */

  function renderInto(el, streams, sport) {
    if (!el) return false;
    if (!hasUsableStreams(streams)) {
      el.innerHTML = "";
      return false;
    }
    el.innerHTML = renderStackedCharts(streams, sport);
    bindChartInteraction(el, streams, sport);
    return true;
  }

  /* ── Public API ────────────────────────────────────────────────── */

  root.AthlevoActivityStreams = {
    extractStoredStreams,
    normalizeProviderStreams,
    downsampleStreams,
    hasUsableStreams,
    availableGraphKeys,
    graphSeriesFor,
    paceSeriesFromVelocity,
    loadStreams,
    streamsFromActivity,
    cacheGet,
    cacheSet,
    renderStackedCharts,
    renderInto,
    formatMetricValue,
    lastLoadInfo: () => lastLoadInfo,
    deriveVelocityFromDistance,
    GRAPH_ORDER
  };
})(typeof window !== "undefined" ? window : globalThis);
