export const WEATHER_THRESHOLDS = Object.freeze({
  highHeatFeelsLikeC: 32,
  moderateHeatFeelsLikeC: 28,
  moderateHeatHumidityPct: 80,
  highHumidityPct: 85,
  highHumidityFeelsLikeC: 25,
  heavyRainProbabilityPct: 70,
  heavyRainMm: 5,
  highWindKph: 40,
  highWindGustKph: 55,
  moderateWindKph: 30
});

const MESSAGES = Object.freeze({
  storm: "Storm conditions possible — consider adjusting timing for safety.",
  high_heat: "High heat — use effort/HR rather than forcing pace.",
  high_wind: "Strong wind — pace may be less representative.",
  heavy_rain: "Heavy rain likely — watch footing and visibility.",
  moderate_heat: "Warm and humid — pace may feel harder than usual.",
  high_humidity: "Very humid — hydration and effort matter more today.",
  moderate_wind: "Windy conditions — expect variable pace."
});

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value)
    : null;
}
export function deriveWeatherRisk(weather) {
  const value = weather && typeof weather === "object" ? weather : {};
  const feelsLike = finite(value.feels_like_c);
  const humidity = finite(value.humidity_pct);
  const rainProbability = finite(value.precip_probability_pct);
  const precipitation = finite(value.precip_mm);
  const wind = finite(value.wind_kph);
  const gust = finite(value.wind_gust_kph);

  const storm = value.condition_code === "storm";
  const highHeat = feelsLike !== null && feelsLike >= WEATHER_THRESHOLDS.highHeatFeelsLikeC;
  const moderateHeat = !highHeat && feelsLike !== null && humidity !== null &&
    feelsLike >= WEATHER_THRESHOLDS.moderateHeatFeelsLikeC &&
    humidity >= WEATHER_THRESHOLDS.moderateHeatHumidityPct;
  const highHumidity = feelsLike !== null && humidity !== null &&
    humidity >= WEATHER_THRESHOLDS.highHumidityPct &&
    feelsLike >= WEATHER_THRESHOLDS.highHumidityFeelsLikeC;
  const heavyRain = rainProbability !== null && precipitation !== null &&
    rainProbability >= WEATHER_THRESHOLDS.heavyRainProbabilityPct &&
    precipitation >= WEATHER_THRESHOLDS.heavyRainMm;
  const highWind = (wind !== null && wind >= WEATHER_THRESHOLDS.highWindKph) ||
    (gust !== null && gust >= WEATHER_THRESHOLDS.highWindGustKph);
  const moderateWind = !highWind && wind !== null && wind >= WEATHER_THRESHOLDS.moderateWindKph;

  const candidates = [
    storm && "storm",
    highHeat && "high_heat",
    highWind && "high_wind",
    heavyRain && "heavy_rain",
    moderateHeat && "moderate_heat",
    highHumidity && "high_humidity",
    moderateWind && "moderate_wind"
  ].filter(Boolean);
  const primaryFlag = candidates[0] || null;

  return {
    heat_risk: highHeat ? "high" : (moderateHeat ? "moderate" : null),
    humidity_risk: highHumidity ? "moderate" : null,
    rain_risk: heavyRain ? "moderate" : null,
    wind_risk: highWind ? "high" : (moderateWind ? "moderate" : null),
    storm_risk: storm ? "high" : null,
    primary_flag: primaryFlag,
    primary_message: primaryFlag ? MESSAGES[primaryFlag] : null,
    effort_first_context: candidates.length > 0
  };
}
