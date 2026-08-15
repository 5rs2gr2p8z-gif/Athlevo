/*
 * Athlevo Weather V1
 *
 * Small UI, structured coaching context. Provider mapping and the API key
 * stay on the server. Device coordinates are rounded before transmission,
 * kept only in memory, and never sent to analytics or persistent storage.
 */
(function () {
  "use strict";

  var CACHE_TTL_MS = 30 * 60 * 1000;
  var cache = new Map();
  var state = {
    status: "idle",
    available: false,
    weather: null,
    risk: null,
    permission: "unknown",
    locationUnavailable: false
  };
  var loadPromise = null;
  var requestGeneration = 0;
  var now = function () { return Date.now(); };

  function client() {
    return typeof supabaseClient !== "undefined" ? supabaseClient : null;
  }

  async function session() {
    var sb = client();
    if (!sb) return null;
    try {
      var result = await sb.auth.getSession();
      return result && result.data && result.data.session || null;
    } catch (error) {
      return null;
    }
  }

  function roundCoordinates(coords) {
    var latitude = Number(coords && coords.latitude);
    var longitude = Number(coords && coords.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return null;
    }
    return {
      lat: Math.round(latitude * 100) / 100,
      lng: Math.round(longitude * 100) / 100
    };
  }

  async function permissionState() {
    if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
      return "prompt";
    }
    try {
      var result = await navigator.permissions.query({ name: "geolocation" });
      return ["granted", "denied", "prompt"].includes(result.state)
        ? result.state
        : "prompt";
    } catch (error) {
      return "prompt";
    }
  }

  function currentPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== "function") {
        reject(new Error("geolocation_unavailable"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (position) {
          var rounded = roundCoordinates(position && position.coords);
          if (rounded) resolve(rounded);
          else reject(new Error("geolocation_invalid"));
        },
        function () { reject(new Error("geolocation_failed")); },
        { enableHighAccuracy: false, timeout: 6000, maximumAge: CACHE_TTL_MS }
      );
    });
  }

  function mode() {
    var source = window.AthlevoAthleteMode;
    if (!source || typeof source.mode !== "function") return "unknown";
    return source.mode();
  }

  function numberText(value, suffix) {
    var number = Number(value);
    return Number.isFinite(number) ? String(Math.round(number)) + suffix : "";
  }

  function conditionsText(weather) {
    if (!weather) return "";
    return [
      numberText(weather.temperature_c, "°C"),
      Number.isFinite(Number(weather.feels_like_c))
        ? "Feels " + numberText(weather.feels_like_c, "°C")
        : "",
      Number.isFinite(Number(weather.humidity_pct))
        ? "Humidity " + numberText(weather.humidity_pct, "%")
        : "",
      Number.isFinite(Number(weather.precip_probability_pct))
        ? "Rain " + numberText(weather.precip_probability_pct, "%")
        : ""
    ].filter(Boolean).join(" · ");
  }

  function warningText() {
    if (!state.risk) return "";
    var athleteMode = mode();
    if (athleteMode === "self_guided") return state.risk.primary_message || "";
    if (athleteMode === "human_coached" && state.risk.storm_risk === "high") {
      return "Storm conditions possible.";
    }
    return "";
  }

  function render() {
    var slots = document.querySelectorAll("[data-today-weather]");
    Array.prototype.forEach.call(slots, function (slot) {
      var conditions = slot.querySelector("[data-weather-conditions]");
      var warning = slot.querySelector("[data-weather-warning]");
      var permission = slot.querySelector("[data-weather-permission]");
      var explanation = slot.querySelector("[data-weather-explanation]");

      if (state.available && state.weather) {
        slot.hidden = false;
        if (conditions) conditions.textContent = conditionsText(state.weather);
        if (warning) {
          warning.textContent = warningText();
          warning.hidden = !warning.textContent;
        }
        if (permission) permission.hidden = true;
        if (explanation) explanation.hidden = true;
        return;
      }

      var canRequest = state.status === "unavailable" &&
        state.locationUnavailable === true && state.permission === "prompt";
      slot.hidden = !canRequest;
      if (conditions) conditions.textContent = "";
      if (warning) warning.hidden = true;
      if (permission) permission.hidden = !canRequest;
      if (explanation) explanation.hidden = !canRequest;
    });
  }

  function cacheRead(key) {
    var entry = cache.get(key);
    if (!entry || now() - entry.storedAt >= CACHE_TTL_MS) return null;
    return entry.value;
  }

  async function fetchContext(authSession, rounded, cacheKey, force) {
    if (!force) {
      var cached = cacheRead(cacheKey);
      if (cached) return cached;
    }
    var response = await fetch("/api/providers?action=weather_context", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + authSession.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(rounded ? {
        lat: Number(rounded.lat.toFixed(2)),
        lng: Number(rounded.lng.toFixed(2))
      } : {}),
      cache: "no-store"
    });
    if (!response.ok) throw new Error("weather_unavailable");
    var value = await response.json();
    cache.set(cacheKey, { storedAt: now(), value: value });
    return value;
  }

  function applyResult(value, generation) {
    if (generation !== requestGeneration) return state;
    if (value && value.available === true && value.weather) {
      state.status = "ready";
      state.available = true;
      state.weather = value.weather;
      state.risk = value.risk || null;
      state.locationUnavailable = false;
    } else {
      state.status = "unavailable";
      state.available = false;
      state.weather = null;
      state.risk = null;
      state.locationUnavailable = value && value.reason === "location_unavailable";
    }
    render();
    return state;
  }

  function load(options) {
    options = options || {};
    if (loadPromise && !options.force && !options.requestDevice) return loadPromise;
    var generation = ++requestGeneration;
    state.status = "loading";
    render();
    loadPromise = (async function () {
      var authSession = await session();
      if (!authSession || !authSession.access_token) {
        state.status = "unavailable";
        render();
        return state;
      }

      state.permission = await permissionState();
      var rounded = null;
      if (state.permission === "granted" || options.requestDevice === true) {
        try {
          rounded = await currentPosition();
          state.permission = "granted";
        } catch (error) {
          state.permission = await permissionState();
        }
      }

      var userKey = authSession.user && authSession.user.id || "session";
      var profileHint = String(options.savedLocationHint || "").trim().toLowerCase();
      var cacheKey = rounded
        ? userKey + ":coordinates:" + rounded.lat.toFixed(2) + "," + rounded.lng.toFixed(2)
        : userKey + ":profile:" + profileHint;

      try {
        var value = await fetchContext(authSession, rounded, cacheKey, options.force === true);
        return applyResult(value, generation);
      } catch (error) {
        return applyResult({ available: false }, generation);
      }
    })().finally(function () { loadPromise = null; });
    return loadPromise;
  }

  function requestDeviceLocation() {
    return load({ requestDevice: true, force: true });
  }

  function current() {
    return {
      status: state.status,
      available: state.available,
      weather: state.weather,
      risk: state.risk
    };
  }

  function clear() {
    requestGeneration += 1;
    cache.clear();
    loadPromise = null;
    state.status = "idle";
    state.available = false;
    state.weather = null;
    state.risk = null;
    state.permission = "unknown";
    state.locationUnavailable = false;
    render();
  }

  window.AthlevoWeather = {
    load: load,
    render: render,
    current: current,
    requestDeviceLocation: requestDeviceLocation,
    clear: clear,
    _test: {
      roundCoordinates: roundCoordinates,
      conditionsText: conditionsText,
      warningText: warningText,
      setNow: function (fn) { now = fn; },
      resetNow: function () { now = function () { return Date.now(); }; }
    }
  };
})();
