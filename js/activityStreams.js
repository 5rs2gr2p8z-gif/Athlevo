/*
 * Athlevo — on-demand activity streams + stacked analysis graphs.
 * Calendar cards stay lightweight. Detail fetches streams once, then caches.
 */
(function (root) {
  "use strict";

  const MAX_POINTS = 400;
  const TYPE_ALIASES = {
    time: "time", timer_time: "time", elapsed_time: "time",
    distance: "distance",
    heartrate: "heartrate", heart_rate: "heartrate", hr: "heartrate",
    velocity: "velocity", velocity_smooth: "velocity", speed: "velocity",
    altitude: "altitude", elevation: "altitude",
    cadence: "cadence",
    watts: "watts", power: "watts"
  };
  const METRIC_KEYS = ["heartrate", "velocity", "altitude", "cadence", "watts"];
  const ALL_KEYS = ["time", "distance"].concat(METRIC_KEYS);
  const GRAPH_ORDER = ["pace", "heartrate", "elevation", "cadence", "power"];
  const GRAPH_META = {
    pace: { label: "Pace", unit: "/km", color: "var(--ad-chart-pace)", invert: true },
    heartrate: { label: "Heart Rate", unit: "bpm", color: "var(--ad-chart-hr)", invert: false },
    elevation: { label: "Elevation", unit: "m", color: "var(--ad-chart-elev)", invert: false },
    cadence: { label: "Cadence", unit: "spm", color: "var(--ad-chart-cadence)", invert: false },
    power: { label: "Power", unit: "W", color: "var(--ad-chart-power)", invert: false }
  };

  const memoryCache = new Map();
  const inflight = new Map();

  function emptyStreams() {
    return { version: 1, time: null, distance: null, heartrate: null, velocity: null, altitude: null, cadence: null, watts: null };
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
    if (!entry) return null;
    if (Array.isArray(entry)) return asFiniteArray(entry);
    if (typeof entry === "object") return asFiniteArray(entry.data || entry.values || entry.stream);
    return null;
  }

  function alignSeries(streams) {
    const lengths = ALL_KEYS.map(k => streams[k] && streams[k].length).filter(n => Number.isFinite(n) && n > 0);
    if (!lengths.length) return;
    const n = Math.min.apply(null, lengths);
    ALL_KEYS.forEach(k => {
      if (streams[k] && streams[k].length > n) streams[k] = streams[k].slice(0, n);
    });
  }

  function normalizeProviderStreams(payload) {
    const streams = emptyStreams();
    if (!payload) return streams;
    const apply = (type, data) => {
      const key = TYPE_ALIASES[String(type || "").toLowerCase()];
      if (!key || streams[key]) return;
      const series = seriesFromEntry(data);
      if (series) streams[key] = series;
    };
    if (Array.isArray(payload)) {
      payload.forEach(item => {
        if (item && typeof item === "object") apply(item.type || item.name || item.key, item);
      });
    } else if (typeof payload === "object") {
      Object.keys(payload).forEach(type => apply(type, payload[type]));
    }
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

  function availableGraphKeys(streams, sport) {
    const keys = [];
    if (!hasUsableStreams(streams)) return keys;
    const usable = key => Array.isArray(streams[key]) && streams[key].filter(v => Number.isFinite(v)).length >= 3;
    if (usable("velocity") && sport !== "strength" && sport !== "mobility") keys.push("pace");
    if (usable("heartrate")) keys.push("heartrate");
    if (usable("altitude")) keys.push("elevation");
    if (usable("cadence")) keys.push("cadence");
    if (usable("watts")) keys.push("power");
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

  function cacheGet(id) {
    return memoryCache.get(String(id)) || null;
  }

  function cacheSet(id, streams) {
    if (id == null) return;
    memoryCache.set(String(id), streams);
  }

  function streamsFromActivity(activity) {
    const raw = activity && activity.raw_data && typeof activity.raw_data === "object" ? activity.raw_data : {};
    return extractStoredStreams(raw);
  }

  function attachStreams(activity, streams) {
    if (!activity || !hasUsableStreams(streams)) return;
    activity.raw_data = activity.raw_data && typeof activity.raw_data === "object" ? activity.raw_data : {};
    activity.raw_data.activity_streams = streams;
  }

  async function fetchRemoteStreams(activityId) {
    if (typeof supabaseClient === "undefined" || !supabaseClient.auth) return null;
    let token = null;
    try {
      const session = await supabaseClient.auth.getSession();
      token = session && session.data && session.data.session && session.data.session.access_token;
    } catch (e) { token = null; }
    if (!token) return null;
    const res = await fetch("/api/providers?action=activity_streams", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ activityId: String(activityId) }),
      cache: "no-store"
    });
    if (!res.ok) return null;
    const body = await res.json();
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
    }).catch(() => emptyStreams()).finally(() => { inflight.delete(id); });
    inflight.set(id, pending);
    return pending;
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function fmtElapsed(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  function fmtPace(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return "—";
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
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

  function axisFor(streams, index) {
    if (streams.time && Number.isFinite(streams.time[index])) return { kind: "time", label: fmtElapsed(streams.time[index]) };
    if (streams.distance && Number.isFinite(streams.distance[index])) {
      return { kind: "distance", label: (streams.distance[index] / 1000).toFixed(2) + " km" };
    }
    return { kind: "index", label: "" };
  }

  function downsampleForDraw(values, maxPoints) {
    if (!values || values.length <= maxPoints) return values ? values.slice() : [];
    const step = Math.ceil(values.length / maxPoints);
    const out = [];
    for (let i = 0; i < values.length; i += step) out.push(values[i]);
    return out;
  }

  function renderLineChart(values, color, invertY) {
    const sampled = downsampleForDraw(values, 220);
    const nums = sampled.filter(v => Number.isFinite(v));
    if (nums.length < 3) return "";
    const W = 360, H = 112, PAD_X = 2, PAD_Y = 8;
    let min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    if (max === min) { min -= 1; max += 1; }
    const range = max - min;
    const points = [];
    sampled.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = PAD_X + (i / Math.max(1, sampled.length - 1)) * (W - 2 * PAD_X);
      const norm = (v - min) / range;
      const y = invertY
        ? PAD_Y + norm * (H - 2 * PAD_Y)
        : H - PAD_Y - norm * (H - 2 * PAD_Y);
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    if (points.length < 3) return "";
    const path = `M${points.join("L")}`;
    const fill = `M${PAD_X},${H}L${points.join("L")}L${W - PAD_X},${H}Z`;
    const y1 = (H / 4).toFixed(1), y2 = (H / 2).toFixed(1), y3 = (H * 3 / 4).toFixed(1);
    return `<svg class="ad-stream-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
      <line x1="${PAD_X}" y1="${y1}" x2="${W - PAD_X}" y2="${y1}" class="ad-chart-grid"/>
      <line x1="${PAD_X}" y1="${y2}" x2="${W - PAD_X}" y2="${y2}" class="ad-chart-grid"/>
      <line x1="${PAD_X}" y1="${y3}" x2="${W - PAD_X}" y2="${y3}" class="ad-chart-grid"/>
      <path d="${fill}" fill="${color}" fill-opacity=".10"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.75" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function renderStackedCharts(streams, sport) {
    const keys = availableGraphKeys(streams, sport);
    if (!keys.length) return "";
    const cadenceMeta = Object.assign({}, GRAPH_META.cadence, { unit: sport === "ride" ? "rpm" : "spm" });
    let html = `<div class="ad-charts" role="group" aria-label="Activity graphs">`;
    keys.forEach(key => {
      const series = graphSeriesFor(streams, key);
      const meta = key === "cadence" ? cadenceMeta : GRAPH_META[key];
      if (!series || !meta) return;
      const finite = series.filter(v => Number.isFinite(v));
      if (finite.length < 3) return;
      const avg = finite.reduce((s, v) => s + v, 0) / finite.length;
      html += `<section class="ad-chart-section" data-stream="${key}">
        <div class="ad-chart-head">
          <div class="ad-section-h">${meta.label}</div>
          <div class="ad-chart-readout" aria-live="polite"></div>
        </div>
        <div class="ad-chart-stats"><span class="ad-chart-stat"><b>${formatMetricValue(key, avg, sport)}</b> avg</span></div>
        ${renderLineChart(series, meta.color, meta.invert)}
      </section>`;
    });
    html += `</div>`;
    return html;
  }

  function bindChartInteraction(rootEl, streams, sport) {
    if (!rootEl || !streams) return;
    const sections = rootEl.querySelectorAll(".ad-chart-section");
    sections.forEach(section => {
      const key = section.getAttribute("data-stream");
      const series = graphSeriesFor(streams, key);
      const svg = section.querySelector(".ad-stream-chart");
      const readout = section.querySelector(".ad-chart-readout");
      if (!series || !svg || !readout) return;
      const showAt = ratio => {
        const idx = Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
        const axis = axisFor(streams, idx);
        const value = formatMetricValue(key, series[idx], sport);
        readout.textContent = [axis.label, value].filter(Boolean).join(" · ");
      };
      const fromEvent = event => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        const x = (event.clientX != null ? event.clientX : (event.touches && event.touches[0] && event.touches[0].clientX)) - rect.left;
        showAt(Math.max(0, Math.min(1, x / rect.width)));
      };
      svg.addEventListener("pointermove", fromEvent);
      svg.addEventListener("pointerdown", fromEvent);
      svg.addEventListener("pointerleave", () => { readout.textContent = ""; });
    });
  }

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
    GRAPH_ORDER
  };
})(typeof window !== "undefined" ? window : globalThis);
