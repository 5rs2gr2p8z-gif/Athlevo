import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import handler from "../api/providers/index.js";
import {
  clearWeatherProviderCache,
  fetchWeatherContext,
  mapWeatherCondition,
  normalizeWeatherApiResponse,
  WEATHER_CACHE_TTL_MS
} from "../lib/server/weatherProvider.js";
import { deriveWeatherRisk } from "../lib/server/weatherRisk.js";

const weatherClientSource = readFileSync("js/weather.js", "utf8");
const providerRouteSource = readFileSync("api/providers/index.js", "utf8");
const brainSource = readFileSync("js/brain.js", "utf8");
const coachSource = readFileSync("js/coach.js", "utf8");
const indexSource = readFileSync("index.html", "utf8");
const infoPlistSource = readFileSync("ios/App/App/Info.plist", "utf8");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    console.error(`FAIL — ${name}`);
    throw error;
  }
}

function payload(overrides = {}) {
  const base = {
    location: {
      name: "San Fernando",
      country: "Philippines",
      localtime_epoch: 1786741200
    },
    current: {
      last_updated_epoch: 1786741200,
      temp_c: 31,
      feelslike_c: 36,
      humidity: 84,
      precip_mm: 1.2,
      condition: { code: 1183, text: "Light rain" },
      wind_kph: 18,
      gust_kph: 27,
      dewpoint_c: 25,
      uv: 6
    },
    forecast: {
      forecastday: [{
        day: { daily_chance_of_rain: 65 },
        astro: { sunrise: "05:43 AM", sunset: "06:19 PM" },
        hour: [
          { time_epoch: 1786737600, chance_of_rain: 30 },
          { time_epoch: 1786741200, chance_of_rain: 40 }
        ]
      }]
    }
  };
  return {
    ...base,
    ...overrides,
    location: { ...base.location, ...(overrides.location || {}) },
    current: { ...base.current, ...(overrides.current || {}) },
    forecast: overrides.forecast === null ? null : (overrides.forecast || base.forecast)
  };
}

function apiResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    redirect(code, value) { this.statusCode = code; this.body = value; return this; }
  };
}

function clientWorld({ permission = "prompt", geolocation = "success", responses = [] } = {}) {
  const calls = [];
  const positionCalls = [];
  let responseIndex = 0;
  const root = {
    AthlevoAthleteMode: { mode: () => "self_guided" }
  };
  const sandbox = {
    window: root,
    document: { querySelectorAll: () => [] },
    navigator: {
      permissions: { query: async () => ({ state: permission }) },
      geolocation: {
        getCurrentPosition(success, failure, options) {
          positionCalls.push(options);
          if (geolocation === "success") {
            success({ coords: { latitude: 14.5995123, longitude: 120.9842199 } });
          } else {
            failure({ code: geolocation === "timeout" ? 3 : 1 });
          }
        }
      }
    },
    supabaseClient: {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: "test-token", user: { id: "user-1" } } }
        })
      }
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      const body = responses[Math.min(responseIndex++, responses.length - 1)] || {
        available: true,
        weather: normalizeWeatherApiResponse(payload()),
        risk: deriveWeatherRisk(normalizeWeatherApiResponse(payload()))
      };
      return { ok: true, status: 200, json: async () => body };
    },
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams
  };
  root.window = root;
  vm.createContext(sandbox);
  vm.runInContext(weatherClientSource, sandbox, { filename: "weather.js" });
  return { weather: root.AthlevoWeather, root, calls, positionCalls };
}

console.log("\n──── Weather normalization ────");
await test("normalizes provider current and forecast fields", () => {
  const result = normalizeWeatherApiResponse(payload());
  assert.deepEqual(result.location, { name: "San Fernando, Philippines" });
  assert.equal(result.temperature_c, 31);
  assert.equal(result.feels_like_c, 36);
  assert.equal(result.humidity_pct, 84);
  assert.equal(result.precip_probability_pct, 40);
  assert.equal(result.precip_mm, 1.2);
  assert.equal(result.condition_code, "rain");
  assert.equal(result.sunrise, "05:43 AM");
  assert.equal(result.dew_point_c, 25);
});

await test("missing supported optional fields stay null rather than becoming zero", () => {
  const result = normalizeWeatherApiResponse(payload({
    current: { precip_mm: null, gust_kph: null, dewpoint_c: null, uv: null },
    forecast: null
  }));
  assert.equal(result.precip_probability_pct, null);
  assert.equal(result.precip_mm, null);
  assert.equal(result.wind_gust_kph, null);
  assert.equal(result.sunrise, null);
  assert.equal(result.dew_point_c, null);
  assert.equal(result.uv_index, null);
});

await test("unknown provider codes remain provider-independent unknown", () => {
  assert.equal(mapWeatherCondition(9999, 10), "unknown");
  assert.equal(mapWeatherCondition(9999, 35), "wind");
});

await test("provider failures reject without returning provider payloads", async () => {
  clearWeatherProviderCache();
  await assert.rejects(
    fetchWeatherContext("Pampanga", {
      apiKey: "server-test-key",
      fetchImpl: async () => ({ ok: false, status: 502 })
    }),
    /weather_provider_failed/
  );
});

await test("server provider cache honors 30-minute TTL and location keys", async () => {
  clearWeatherProviderCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => payload() };
  };
  await fetchWeatherContext("Pampanga", { apiKey: "server-test-key", fetchImpl, now: 1000 });
  await fetchWeatherContext("Pampanga", {
    apiKey: "server-test-key", fetchImpl, now: 1000 + WEATHER_CACHE_TTL_MS - 1
  });
  assert.equal(calls, 1);
  await fetchWeatherContext("Pampanga", {
    apiKey: "server-test-key", fetchImpl, now: 1000 + WEATHER_CACHE_TTL_MS + 1
  });
  await fetchWeatherContext("Manila", {
    apiKey: "server-test-key", fetchImpl, now: 1000 + WEATHER_CACHE_TTL_MS + 1
  });
  assert.equal(calls, 3);
});

console.log("\n──── Deterministic risk thresholds ────");
await test("31.9°C feels-like is not high heat and 32.0°C is high heat", () => {
  assert.equal(deriveWeatherRisk({ feels_like_c: 31.9, humidity_pct: 60 }).heat_risk, null);
  const high = deriveWeatherRisk({ feels_like_c: 32, humidity_pct: 60 });
  assert.equal(high.heat_risk, "high");
  assert.equal(high.primary_message, "High heat — use effort/HR rather than forcing pace.");
});

await test("compound warm-humid and humidity rules use centralized boundaries", () => {
  const moderate = deriveWeatherRisk({ feels_like_c: 28, humidity_pct: 80 });
  assert.equal(moderate.heat_risk, "moderate");
  const humid = deriveWeatherRisk({ feels_like_c: 25, humidity_pct: 85 });
  assert.equal(humid.humidity_risk, "moderate");
});

await test("heavy rain, moderate wind, high wind, and gust boundaries are enforced", () => {
  assert.equal(deriveWeatherRisk({ precip_probability_pct: 70, precip_mm: 5 }).rain_risk, "moderate");
  assert.equal(deriveWeatherRisk({ wind_kph: 30 }).wind_risk, "moderate");
  assert.equal(deriveWeatherRisk({ wind_kph: 40 }).wind_risk, "high");
  assert.equal(deriveWeatherRisk({ wind_kph: 1, wind_gust_kph: 55 }).wind_risk, "high");
});

await test("storm is highest priority when multiple risks exist", () => {
  const result = deriveWeatherRisk({
    condition_code: "storm", feels_like_c: 36, humidity_pct: 90,
    precip_probability_pct: 90, precip_mm: 12, wind_kph: 50
  });
  assert.equal(result.storm_risk, "high");
  assert.equal(result.primary_flag, "storm");
  assert.equal(result.effort_first_context, true);
});

console.log("\n──── Location and client cache ────");
await test("already-granted GPS uses one-shot location and sends only rounded coordinates", async () => {
  const world = clientWorld({ permission: "granted" });
  await world.weather.load({ savedLocationHint: "Pampanga" });
  assert.equal(world.positionCalls.length, 1);
  assert.equal(world.calls[0].url, "/api/providers?action=weather_context");
  assert.deepEqual(JSON.parse(world.calls[0].options.body), { lat: 14.6, lng: 120.98 });
  assert.doesNotMatch(world.calls[0].options.body, /14\.5995123|120\.9842199/);
});

await test("denied GPS falls back to the authenticated saved-location route", async () => {
  const world = clientWorld({ permission: "denied", geolocation: "denied" });
  await world.weather.load({ savedLocationHint: "Pampanga" });
  assert.equal(world.positionCalls.length, 0);
  assert.equal(world.calls[0].url, "/api/providers?action=weather_context");
});

await test("explicit GPS timeout falls back to the saved-location route", async () => {
  const world = clientWorld({ permission: "prompt", geolocation: "timeout" });
  await world.weather.load({ requestDevice: true, savedLocationHint: "Pampanga" });
  assert.equal(world.positionCalls.length, 1);
  assert.equal(world.calls[0].url, "/api/providers?action=weather_context");
});

await test("no GPS and no profile location resolves quietly to no weather", async () => {
  const world = clientWorld({
    permission: "denied",
    responses: [{ available: false, weather: null, risk: null, reason: "location_unavailable" }]
  });
  await world.weather.load({ savedLocationHint: "" });
  assert.equal(world.weather.current().available, false);
  assert.equal(world.weather.current().weather, null);
});

await test("second client request within 30 minutes does not refetch", async () => {
  const world = clientWorld({ permission: "denied" });
  let clock = 1000;
  world.weather._test.setNow(() => clock);
  await world.weather.load({ savedLocationHint: "Pampanga" });
  clock += WEATHER_CACHE_TTL_MS - 1;
  await world.weather.load({ savedLocationHint: "Pampanga" });
  assert.equal(world.calls.length, 1);
});

await test("manual Today refresh revalidates through Athlevo without weakening server TTL", async () => {
  const world = clientWorld({ permission: "denied" });
  await world.weather.load({ savedLocationHint: "Pampanga" });
  await world.weather.load({ savedLocationHint: "Pampanga", force: true });
  assert.equal(world.calls.length, 2);
  assert.equal(JSON.parse(world.calls[1].options.body).refresh, undefined);
});

await test("TTL expiration refetches and a saved-location change invalidates the cache", async () => {
  const world = clientWorld({ permission: "denied" });
  let clock = 1000;
  world.weather._test.setNow(() => clock);
  await world.weather.load({ savedLocationHint: "Pampanga" });
  clock += WEATHER_CACHE_TTL_MS + 1;
  await world.weather.load({ savedLocationHint: "Pampanga" });
  await world.weather.load({ savedLocationHint: "Manila" });
  assert.equal(world.calls.length, 3);
});

console.log("\n──── Authenticated provider route ────");
await test("server fallback scopes profile lookup to the verified JWT user", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  const calls = [];
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  process.env.WEATHERAPI_KEY = "weather-server-test";
  clearWeatherProviderCache();
  global.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes("/auth/v1/user")) return { ok: true, json: async () => ({ id: "verified-user" }) };
    if (String(url).includes("/rest/v1/profiles")) return { ok: true, status: 200, json: async () => [{ location: "Pampanga, Philippines" }] };
    return { ok: true, json: async () => payload() };
  };
  try {
    const response = apiResponse();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
      query: { action: "weather_context" },
      body: { athlete_id: "attacker-selected-user" }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.available, true);
    const profileCall = calls.find(url => url.includes("/rest/v1/profiles"));
    assert.match(profileCall, /id=eq\.verified-user/);
    assert.doesNotMatch(profileCall, /attacker-selected-user/);
    assert.equal(JSON.stringify(response.body).includes("weather-server-test"), false);
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

await test("server validates and rounds coordinates without reading an arbitrary profile", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  const calls = [];
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  process.env.WEATHERAPI_KEY = "weather-server-test";
  clearWeatherProviderCache();
  global.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes("/auth/v1/user")) return { ok: true, json: async () => ({ id: "verified-user" }) };
    return { ok: true, json: async () => payload() };
  };
  try {
    const response = apiResponse();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
      query: { action: "weather_context" },
      body: { lat: "14.59951", lng: "120.98421", athlete_id: "other" }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(calls.some(url => url.includes("/rest/v1/profiles")), false);
    const providerCall = new URL(calls.find(url => url.startsWith("https://api.weatherapi.com")));
    assert.equal(providerCall.searchParams.get("q"), "14.60,120.98");
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

console.log("\n──── Today, mode, coaching, and privacy wiring ────");
await test("Today uses compact metadata slots and creates no weather dashboard", () => {
  assert.equal((indexSource.match(/data-today-weather/g) || []).length, 2);
  assert.match(indexSource, /todayWorkoutSummary[\s\S]{0,900}data-today-weather/);
  assert.doesNotMatch(indexSource, /weather-dashboard|weatherDashboard|weather-card/);
  assert.match(indexSource, /overflow-wrap:anywhere/);
  assert.match(indexSource, /reason === "manual"[\s\S]{0,180}AthlevoWeather\.load\(\{ force: true \}\)/);
});

await test("self-guided weather warning is contextual while managed mode is factual-only", async () => {
  const world = clientWorld({ permission: "denied" });
  await world.weather.load({ savedLocationHint: "Pampanga" });
  assert.equal(world.weather._test.warningText(), "High heat — use effort/HR rather than forcing pace.");
  world.root.AthlevoAthleteMode.mode = () => "human_coached";
  assert.equal(world.weather._test.warningText(), "");
});

await test("managed athletes may see only the factual severe-storm warning", async () => {
  const weather = normalizeWeatherApiResponse(payload({ current: { condition: { code: 1276, text: "Thunderstorm" } } }));
  const world = clientWorld({
    permission: "denied",
    responses: [{ available: true, weather, risk: deriveWeatherRisk(weather) }]
  });
  world.root.AthlevoAthleteMode.mode = () => "human_coached";
  await world.weather.load({ savedLocationHint: "Pampanga" });
  assert.equal(world.weather._test.warningText(), "Storm conditions possible.");
});

await test("self-guided Coach context receives supplied structured weather only", () => {
  assert.match(brainSource, /coachingMode === "self_guided"[\s\S]{0,240}weatherState\.weather/);
  assert.match(brainSource, /weather: suppliedWeather/);
  assert.match(brainSource, /weather:\s*!suppliedWeather/);
  assert.match(coachSource, /context\.todayWeather = \{[\s\S]{0,120}weather: context\.weather/);
});

await test("weather never mutates workouts, paces, zones, or dormant heat calibration", () => {
  assert.doesNotMatch(weatherClientSource, /getTrainingPaces|training_sessions|paceService|ctx\.heat/);
  assert.doesNotMatch(brainSource, /ctx\.heat\s*=\s*.*weather|heat\s*:\s*suppliedWeather/);
});

await test("client has no provider key, persistence, continuous location, logging, or analytics", () => {
  assert.doesNotMatch(weatherClientSource, /WEATHERAPI_KEY|api\.weatherapi\.com/);
  assert.doesNotMatch(weatherClientSource, /localStorage|sessionStorage|watchPosition/);
  assert.doesNotMatch(weatherClientSource, /AthlevoAnalytics|posthog|\.track\s*\(/i);
  assert.doesNotMatch(weatherClientSource, /console\.(log|warn|error)/);
  assert.doesNotMatch(brainSource, /Athlete profile loaded:", profile/);
  assert.match(providerRouteSource, /actionWeatherContext[\s\S]*verified JWT is the sole/);
});

await test("native browser geolocation has a truthful foreground-only permission purpose", () => {
  assert.match(infoPlistSource, /NSLocationWhenInUseUsageDescription/);
  assert.match(infoPlistSource, /Athlevo uses your location to show local weather conditions for your training\./);
  assert.doesNotMatch(infoPlistSource, /NSLocationAlways/);
});

console.log(`\n${passed} weather checks passed`);
