const WEATHER_API_URL = "https://api.weatherapi.com/v1/forecast.json";
const WEATHER_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 250;
const cache = new Map();

const CLOUDY_CODES = new Set([1003, 1006, 1009]);
const FOG_CODES = new Set([1030, 1135, 1147]);
const RAIN_CODES = new Set([
  1063, 1069, 1072, 1150, 1153, 1168, 1171,
  1180, 1183, 1186, 1189, 1198, 1204, 1207, 1237, 1240, 1249, 1252, 1261, 1264
]);
const HEAVY_RAIN_CODES = new Set([1192, 1195, 1201, 1243, 1246]);
const STORM_CODES = new Set([1087, 1273, 1276, 1279, 1282]);

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredNumber(value, field) {
  const number = optionalNumber(value);
  if (number === null) throw new Error(`weather_missing_${field}`);
  return number;
}

export function mapWeatherCondition(code, windKph) {
  const numericCode = Number(code);
  let normalized = "unknown";
  if (numericCode === 1000) normalized = "clear";
  else if (CLOUDY_CODES.has(numericCode)) normalized = "cloudy";
  else if (FOG_CODES.has(numericCode)) normalized = "fog";
  else if (STORM_CODES.has(numericCode)) normalized = "storm";
  else if (HEAVY_RAIN_CODES.has(numericCode)) normalized = "heavy_rain";
  else if (RAIN_CODES.has(numericCode)) normalized = "rain";

  if (["clear", "cloudy", "unknown"].includes(normalized) && Number(windKph) >= 30) {
    return "wind";
  }
  return normalized;
}

function nearestForecastHour(payload) {
  const hours = payload?.forecast?.forecastday?.[0]?.hour;
  if (!Array.isArray(hours) || !hours.length) return null;
  const target = optionalNumber(payload?.location?.localtime_epoch) ||
    optionalNumber(payload?.current?.last_updated_epoch);
  if (target === null) return hours[0] || null;
  return hours.reduce((closest, hour) => {
    if (!closest) return hour;
    const currentDistance = Math.abs((optionalNumber(hour?.time_epoch) ?? Infinity) - target);
    const closestDistance = Math.abs((optionalNumber(closest?.time_epoch) ?? Infinity) - target);
    return currentDistance < closestDistance ? hour : closest;
  }, null);
}

export function normalizeWeatherApiResponse(payload) {
  const current = payload?.current;
  const location = payload?.location;
  if (!current || !location) throw new Error("weather_invalid_response");
  const windKph = optionalNumber(current.wind_kph);
  const observedEpoch = optionalNumber(current.last_updated_epoch);
  if (observedEpoch === null) throw new Error("weather_missing_observed_at");
  const nearestHour = nearestForecastHour(payload);
  const forecastDay = payload?.forecast?.forecastday?.[0] || null;
  const locationName = [location.name, location.country]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join(", ");

  return {
    location: { name: locationName || "Local conditions" },
    observed_at: new Date(observedEpoch * 1000).toISOString(),
    temperature_c: requiredNumber(current.temp_c, "temperature_c"),
    feels_like_c: requiredNumber(current.feelslike_c, "feels_like_c"),
    humidity_pct: requiredNumber(current.humidity, "humidity_pct"),
    precip_probability_pct: optionalNumber(
      nearestHour?.chance_of_rain ?? forecastDay?.day?.daily_chance_of_rain
    ),
    precip_mm: optionalNumber(current.precip_mm),
    condition_code: mapWeatherCondition(current?.condition?.code, windKph),
    condition_text: String(current?.condition?.text || "Conditions unavailable").trim(),
    wind_kph: windKph,
    wind_gust_kph: optionalNumber(current.gust_kph),
    sunrise: forecastDay?.astro?.sunrise ? String(forecastDay.astro.sunrise) : null,
    sunset: forecastDay?.astro?.sunset ? String(forecastDay.astro.sunset) : null,
    dew_point_c: optionalNumber(current.dewpoint_c),
    uv_index: optionalNumber(current.uv)
  };
}

function pruneCache() {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function fetchWeatherContext(query, {
  apiKey,
  fetchImpl = fetch,
  now = Date.now(),
  force = false,
  timeoutMs = 8000
} = {}) {
  const cleanQuery = String(query || "").trim();
  if (!apiKey || !cleanQuery) throw new Error("weather_unavailable");
  const cacheKey = cleanQuery.toLowerCase();
  const cached = cache.get(cacheKey);
  if (!force && cached && now - cached.storedAt < WEATHER_TTL_MS) return cached.weather;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(WEATHER_API_URL);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", cleanQuery);
    url.searchParams.set("days", "1");
    url.searchParams.set("aqi", "no");
    url.searchParams.set("alerts", "no");
    const response = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error("weather_provider_failed");
    const weather = normalizeWeatherApiResponse(await response.json());
    pruneCache();
    cache.set(cacheKey, { weather, storedAt: now });
    return weather;
  } finally {
    clearTimeout(timeout);
  }
}

export function clearWeatherProviderCache() {
  cache.clear();
}

export const WEATHER_CACHE_TTL_MS = WEATHER_TTL_MS;
