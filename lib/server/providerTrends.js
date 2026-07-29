/*
 * Pure normalization for provider-owned training trends.
 *
 * Intervals.icu wellness records expose daily `ctl`, `atl`, `ctlLoad`, and
 * `atlLoad`. Athlevo uses the fitness-model load (`ctlLoad`) for the completed
 * load series and derives absolute Form as CTL - ATL. We do not infer planned
 * load from future fitness projections or from unrelated calendar fields.
 */

export const TREND_RANGES = Object.freeze({
  "6w": 42,
  "3m": 90,
  "6m": 183,
  "1y": 365
});

export function normalizeTrendRange(value) {
  return Object.prototype.hasOwnProperty.call(TREND_RANGES, value)
    ? value
    : "3m";
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function validDateKey(value) {
  const key = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const parsed = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === key
    ? key
    : null;
}

export function dateRangeForTrends(range, now = new Date()) {
  const normalizedRange = normalizeTrendRange(range);
  const newestDate = new Date(now);
  if (!Number.isFinite(newestDate.getTime())) {
    throw new TypeError("A valid date is required.");
  }
  newestDate.setUTCHours(0, 0, 0, 0);
  const oldestDate = new Date(
    newestDate.getTime() - (TREND_RANGES[normalizedRange] - 1) * 86400000
  );
  return {
    range: normalizedRange,
    oldest: oldestDate.toISOString().slice(0, 10),
    newest: newestDate.toISOString().slice(0, 10)
  };
}

export function normalizeIntervalsWellness(records) {
  if (!Array.isArray(records)) return [];

  const byDate = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const date = validDateKey(record.id);
    if (!date) continue;

    const fitness = finiteOrNull(record.ctl);
    const fatigue = finiteOrNull(record.atl);
    const completedLoad = finiteOrNull(record.ctlLoad);

    byDate.set(date, {
      date,
      fitness: round(fitness),
      fatigue: round(fatigue),
      form: fitness !== null && fatigue !== null
        ? round(fitness - fatigue)
        : null,
      completedLoad: round(completedLoad),
      plannedLoad: null
    });
  }

  return Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

export function buildProviderTrendsResponse(records, range, now = new Date()) {
  const dates = dateRangeForTrends(range, now);
  const days = normalizeIntervalsWellness(records).filter(day =>
    day.date >= dates.oldest && day.date <= dates.newest
  );
  return {
    success: true,
    source: "intervals_wellness",
    range: dates.range,
    formMode: "absolute",
    oldest: dates.oldest,
    newest: dates.newest,
    fields: {
      fitness: "ctl",
      fatigue: "atl",
      form: "ctl-atl",
      completedLoad: "ctlLoad",
      plannedLoad: null
    },
    days
  };
}
