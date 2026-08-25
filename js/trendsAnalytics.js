/*
 * Athlevo Trends — graph-first provider analytics.
 *
 * Native SVG keeps this dependency-free. All calculations are deterministic;
 * missing provider days are expanded as explicit null gaps, never zeroes.
 */
(function (root) {
  "use strict";

  const RANGE_LABELS = Object.freeze({
    "6w": "six weeks",
    "3m": "three months",
    "6m": "six months",
    "1y": "one year"
  });

  const FORM_ZONES = Object.freeze([
    { key: "detraining", label: "Detraining", min: 25, max: Infinity },
    { key: "fresh", label: "Fresh", min: 5, max: 25 },
    { key: "maintaining", label: "Maintaining", min: -5, max: 5 },
    { key: "gaining", label: "Gaining Fitness", min: -20, max: -5 },
    { key: "risk", label: "High Risk", min: -Infinity, max: -20 }
  ]);

  let selectedRange = "3m";
  const confirmedCache = new Map();
  let bound = false;

  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const escapeHtml = value => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const dateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
    ? String(value)
    : null;

  const addDays = (key, amount) => {
    const date = new Date(`${key}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  };

  function classifyForm(value) {
    const form = finite(value);
    if (form === null) return null;
    return FORM_ZONES.find(zone => form >= zone.min && form < zone.max) ||
      FORM_ZONES[FORM_ZONES.length - 1];
  }

  function expandTrendDays(oldest, newest, inputDays) {
    const start = dateKey(oldest);
    const end = dateKey(newest);
    if (!start || !end || start > end) return [];

    const source = new Map();
    (Array.isArray(inputDays) ? inputDays : []).forEach(day => {
      const key = dateKey(day && day.date);
      if (key) source.set(key, day);
    });

    const output = [];
    for (let key = start; key <= end; key = addDays(key, 1)) {
      const day = source.get(key) || {};
      output.push({
        date: key,
        fitness: finite(day.fitness),
        fatigue: finite(day.fatigue),
        form: finite(day.form),
        completedLoad: finite(day.completedLoad),
        plannedLoad: finite(day.plannedLoad)
      });
    }
    return output;
  }

  function latestValue(days, key) {
    for (let index = days.length - 1; index >= 0; index -= 1) {
      const value = finite(days[index] && days[index][key]);
      if (value !== null) return { value, day: days[index], index };
    }
    return null;
  }

  function valueAtOrBefore(days, key, beforeIndex) {
    for (let index = Math.min(beforeIndex, days.length - 1); index >= 0; index -= 1) {
      const value = finite(days[index] && days[index][key]);
      if (value !== null) return value;
    }
    return null;
  }

  function fmt(value, signed) {
    const number = finite(value);
    if (number === null) return "—";
    const rounded = Math.round(number);
    return signed && rounded > 0 ? `+${rounded}` : String(rounded);
  }

  function shortDate(key) {
    const date = new Date(`${key}T00:00:00Z`);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  }

  function lineSegments(days, key, x, y) {
    const segments = [];
    let current = [];
    days.forEach((day, index) => {
      const value = finite(day[key]);
      if (value === null) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push({ index, value, date: day.date, x: x(index), y: y(value) });
    });
    if (current.length) segments.push(current);
    return segments;
  }

  function pathFor(points) {
    return points.map((point, index) =>
      `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    ).join(" ");
  }

  function chartDates(days, width, left, right, bottomY) {
    if (!days.length) return "";
    const picks = Array.from(new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]));
    return picks.map(index => {
      const x = left + (index / Math.max(1, days.length - 1)) * (width - left - right);
      return `<text class="trend-axis-label" x="${x}" y="${bottomY}" text-anchor="${index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}">${escapeHtml(shortDate(days[index].date))}</text>`;
    }).join("");
  }

  function accessibleSummary(data, days) {
    const firstFitness = days.find(day => day.fitness !== null);
    const latestFitness = latestValue(days, "fitness");
    const latestFatigue = latestValue(days, "fatigue");
    const latestForm = latestValue(days, "form");
    const parts = [];
    if (firstFitness && latestFitness) {
      parts.push(`fitness moved from ${fmt(firstFitness.fitness)} to ${fmt(latestFitness.value)}`);
    }
    if (latestFatigue) parts.push(`fatigue ended at ${fmt(latestFatigue.value)}`);
    if (latestForm) parts.push(`current form is ${fmt(latestForm.value, true)}`);
    return parts.length
      ? `Over the selected ${RANGE_LABELS[data.range] || "period"}, ${parts.join(", ")}.`
      : `No measured fitness, fatigue, or form values are available for the selected ${RANGE_LABELS[data.range] || "period"}.`;
  }

  function renderStatusChart(host, days) {
    if (!host) return;
    const width = 360, height = 200, left = 8, right = 34, top = 8, bottom = 28;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const values = days.map(day => day.form).filter(value => value !== null);
    if (!values.length) {
      host.innerHTML = '<p class="trend-chart-empty">Form data is unavailable for this range.</p>';
      return;
    }

    const min = Math.min(-30, ...values);
    const max = Math.max(35, ...values);
    const x = index => left + (index / Math.max(1, days.length - 1)) * plotWidth;
    const y = value => top + ((max - value) / Math.max(1, max - min)) * plotHeight;
    const segments = lineSegments(days, "form", x, y);
    const latest = latestValue(days, "form");
    const current = classifyForm(latest.value);
    const latestX = x(latest.index);
    const latestY = y(latest.value);
    const placeLatestLabelLeft = latestX > width - right - 60;
    const latestLabelX = placeLatestLabelLeft ? latestX - 8 : latestX + 8;
    const latestLabelY = Math.max(top + 10, Math.min(height - bottom - 4, latestY - 7));

    const bands = FORM_ZONES.map(zone => {
      const high = Math.min(max, zone.max);
      const low = Math.max(min, zone.min);
      if (high <= min || low >= max || high <= low) return "";
      const bandY = y(high);
      const bandHeight = y(low) - bandY;
      return `
        <rect class="trend-zone trend-zone-${zone.key}" x="${left}" y="${bandY.toFixed(2)}" width="${plotWidth}" height="${bandHeight.toFixed(2)}"></rect>
        <text class="trend-zone-label" x="${left + 6}" y="${(bandY + bandHeight / 2 + 3).toFixed(2)}">${escapeHtml(zone.label)}</text>`;
    }).join("");
    const boundaries = [25, 5, -5, -20].map(value => `
      <line class="trend-zone-boundary" x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"></line>
      <text class="trend-threshold-label" x="${width - right + 5}" y="${y(value) + 3}">${value > 0 ? `+${value}` : `−${Math.abs(value)}`}</text>`
    ).join("");

    const paths = segments.map(points =>
      `<path class="trend-series trend-form-series" d="${pathFor(points)}"></path>`
    ).join("");

    const points = segments.flat().map(point =>
      `<circle class="trend-hit" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="5" data-tooltip="${escapeHtml(`${shortDate(point.date)} · Form ${fmt(point.value, true)}`)}"></circle>`
    ).join("");

    host.innerHTML = `
      <svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Training Status Form chart">
        <rect class="trend-plot-surface" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"></rect>
        ${bands}
        ${boundaries}
        <line class="trend-zero-line" x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}"></line>
        ${paths}${points}
        <circle class="trend-latest trend-latest-${current.key}" cx="${latestX}" cy="${latestY}" r="5"></circle>
        <text class="trend-latest-label trend-latest-label-form" x="${latestLabelX}" y="${latestLabelY}" text-anchor="${placeLatestLabelLeft ? "end" : "start"}">Form ${escapeHtml(fmt(latest.value, true))}</text>
        ${chartDates(days, width, left, right, height - 8)}
      </svg>
      <div class="trend-chart-tooltip" aria-live="polite"></div>`;
    bindChartTooltips(host);
  }

  function renderFitnessChart(host, days) {
    if (!host) return;
    const width = 360, height = 190, left = 34, right = 64, top = 12, bottom = 28;
    const values = days.flatMap(day => [day.fitness, day.fatigue]).filter(value => value !== null);
    if (!values.length) {
      host.innerHTML = '<p class="trend-chart-empty">Fitness and fatigue data are unavailable for this range.</p>';
      return;
    }
    const min = Math.min(0, ...values);
    const max = Math.max(10, ...values);
    const x = index => left + (index / Math.max(1, days.length - 1)) * (width - left - right);
    const y = value => top + ((max - value) / Math.max(1, max - min)) * (height - top - bottom);
    const fitness = lineSegments(days, "fitness", x, y);
    const fatigue = lineSegments(days, "fatigue", x, y);

    const pathMarkup = (segments, className) => segments.map(points =>
      `<path class="trend-series ${className}" d="${pathFor(points)}"></path>`
    ).join("");
    const hits = days.map((day, index) => {
      if (day.fitness === null && day.fatigue === null) return "";
      const tooltip = `${shortDate(day.date)} · Fitness ${fmt(day.fitness)} · Fatigue ${fmt(day.fatigue)}`;
      return `<rect class="trend-hit-area" x="${Math.max(left, x(index) - 4)}" y="${top}" width="8" height="${height - top - bottom}" data-tooltip="${escapeHtml(tooltip)}"></rect>`;
    }).join("");
    const latestFitness = latestValue(days, "fitness");
    const latestFatigue = latestValue(days, "fatigue");
    const ticks = [0, 1, 2, 3].map(index => {
      const value = min + ((max - min) * index / 3);
      return `
        <line class="trend-grid-line" x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"></line>
        <text class="trend-axis-label" x="${left - 6}" y="${y(value) + 3}" text-anchor="end">${escapeHtml(fmt(value))}</text>`;
    }).join("");
    let fitnessLabelY = latestFitness ? y(latestFitness.value) + 3 : null;
    let fatigueLabelY = latestFatigue ? y(latestFatigue.value) + 3 : null;
    if (
      fitnessLabelY !== null &&
      fatigueLabelY !== null &&
      Math.abs(fitnessLabelY - fatigueLabelY) < 12
    ) {
      if (fitnessLabelY <= fatigueLabelY) {
        fitnessLabelY -= 5;
        fatigueLabelY += 7;
      } else {
        fitnessLabelY += 7;
        fatigueLabelY -= 5;
      }
    }
    if (fitnessLabelY !== null) {
      fitnessLabelY = Math.max(top + 9, Math.min(height - bottom - 3, fitnessLabelY));
    }
    if (fatigueLabelY !== null) {
      fatigueLabelY = Math.max(top + 9, Math.min(height - bottom - 3, fatigueLabelY));
    }

    host.innerHTML = `
      <svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Fitness and Fatigue line chart">
        <rect class="trend-plot-surface" x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}"></rect>
        ${ticks}
        ${pathMarkup(fitness, "trend-fitness-series")}
        ${pathMarkup(fatigue, "trend-fatigue-series")}
        ${hits}
        ${latestFitness ? `<circle class="trend-latest trend-fitness-point" cx="${x(latestFitness.index)}" cy="${y(latestFitness.value)}" r="4"></circle>` : ""}
        ${latestFatigue ? `<circle class="trend-latest trend-fatigue-point" cx="${x(latestFatigue.index)}" cy="${y(latestFatigue.value)}" r="4"></circle>` : ""}
        ${latestFitness ? `<text class="trend-latest-label trend-latest-label-fitness" x="${width - right + 7}" y="${fitnessLabelY}">Fitness ${escapeHtml(fmt(latestFitness.value))}</text>` : ""}
        ${latestFatigue ? `<text class="trend-latest-label trend-latest-label-fatigue" x="${width - right + 7}" y="${fatigueLabelY}">Fatigue ${escapeHtml(fmt(latestFatigue.value))}</text>` : ""}
        ${chartDates(days, width, left, right, height - 8)}
      </svg>
      <div class="trend-chart-tooltip" aria-live="polite"></div>`;
    bindChartTooltips(host);
  }

  function mondayKey(dateKeyValue) {
    const date = new Date(`${dateKeyValue}T00:00:00Z`);
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
    return date.toISOString().slice(0, 10);
  }

  function aggregateTrainingLoad(days, range) {
    if (range === "6w") {
      return days.map(day => ({
        key: day.date,
        label: shortDate(day.date),
        completed: day.completedLoad,
        planned: day.plannedLoad,
        measuredDays: day.completedLoad === null ? 0 : 1
      }));
    }

    const weeks = new Map();
    days.forEach(day => {
      const key = mondayKey(day.date);
      if (!weeks.has(key)) {
        weeks.set(key, {
          key,
          label: shortDate(key),
          completed: 0,
          planned: 0,
          measuredDays: 0,
          plannedDays: 0
        });
      }
      const week = weeks.get(key);
      if (day.completedLoad !== null) {
        week.completed += day.completedLoad;
        week.measuredDays += 1;
      }
      if (day.plannedLoad !== null) {
        week.planned += day.plannedLoad;
        week.plannedDays += 1;
      }
    });
    return Array.from(weeks.values()).map(week => ({
      ...week,
      completed: week.measuredDays ? week.completed : null,
      planned: week.plannedDays ? week.planned : null
    }));
  }

  function loadWeekComparison(days, todayKey) {
    const thisWeek = mondayKey(todayKey);
    const previousWeek = addDays(thisWeek, -7);
    const elapsed = Math.max(0, Math.min(6,
      Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${thisWeek}T00:00:00Z`)) / 86400000)
    ));
    const sum = (start, end) => {
      const matching = days.filter(day => day.date >= start && day.date <= end &&
        day.completedLoad !== null);
      return {
        value: matching.length
          ? matching.reduce((total, day) => total + day.completedLoad, 0)
          : null,
        measuredDays: matching.length
      };
    };
    const current = sum(thisWeek, todayKey);
    const previousEnd = addDays(previousWeek, elapsed);
    const previous = sum(previousWeek, previousEnd);
    const percent = current.value !== null && previous.value !== null && previous.value > 0
      ? Math.round(((current.value - previous.value) / previous.value) * 100)
      : null;
    return {
      current: current.value,
      previous: previous.value,
      percent,
      inProgress: elapsed < 6,
      comparable: current.measuredDays > 0 && previous.measuredDays > 0
    };
  }

  function hasPlannedLoad(buckets) {
    return (Array.isArray(buckets) ? buckets : [])
      .some(bucket => finite(bucket && bucket.planned) !== null);
  }

  function renderLoadChart(host, buckets) {
    if (!host) return;
    const valid = buckets.filter(bucket => bucket.completed !== null || bucket.planned !== null);
    if (!valid.length) {
      host.innerHTML = '<p class="trend-chart-empty">Training load is unavailable for this range.</p>';
      return;
    }
    const width = 360, height = 180, left = 26, right = 8, top = 12, bottom = 28;
    const max = Math.max(1, ...valid.flatMap(bucket =>
      [bucket.completed, bucket.planned].filter(value => value !== null)
    ));
    const slot = (width - left - right) / Math.max(1, buckets.length);
    const barWidth = Math.max(2, Math.min(12, slot * 0.6));
    const y = value => top + (1 - value / max) * (height - top - bottom);
    const ticks = [0, max / 2, max].map(value => `
      <line class="trend-grid-line" x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"></line>
      <text class="trend-axis-label" x="${left - 6}" y="${y(value) + 3}" text-anchor="end">${escapeHtml(fmt(value))}</text>`
    ).join("");

    const bars = buckets.map((bucket, index) => {
      const x = left + index * slot + (slot - barWidth) / 2;
      const completed = bucket.completed === null ? "" :
        `<rect class="trend-load-completed" x="${x}" y="${y(bucket.completed)}" width="${barWidth}" height="${height - bottom - y(bucket.completed)}"></rect>`;
      const planned = bucket.planned === null ? "" :
        `<rect class="trend-load-planned" x="${x}" y="${y(bucket.planned)}" width="${barWidth}" height="${height - bottom - y(bucket.planned)}"></rect>`;
      const tooltip = `${bucket.label} · Completed ${fmt(bucket.completed)}${bucket.planned === null ? "" : ` · Planned ${fmt(bucket.planned)}`}`;
      return `${planned}${completed}<rect class="trend-hit-area" x="${left + index * slot}" y="${top}" width="${slot}" height="${height - top - bottom}" data-tooltip="${escapeHtml(tooltip)}"></rect>`;
    }).join("");

    host.innerHTML = `
      <svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Training Load bar chart">
        <rect class="trend-plot-surface" x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}"></rect>
        ${ticks}
        <line class="trend-load-baseline" x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}"></line>
        ${bars}
        ${chartDates(
          buckets.map(bucket => ({ date: bucket.key })),
          width,
          left,
          right,
          height - 8
        )}
      </svg>
      <div class="trend-chart-tooltip" aria-live="polite"></div>`;
    bindChartTooltips(host);
  }

  function bindChartTooltips(host) {
    const tooltip = host.querySelector(".trend-chart-tooltip");
    if (!tooltip) return;
    host.querySelectorAll("[data-tooltip]").forEach((element, index, all) => {
      const show = () => {
        tooltip.textContent = element.getAttribute("data-tooltip") || "";
        all.forEach(item => item.classList.remove("is-active"));
        element.classList.add("is-active");
      };
      element.setAttribute("tabindex", index === all.length - 1 ? "0" : "-1");
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", element.getAttribute("data-tooltip") || "Chart value");
      element.addEventListener("mouseenter", show);
      element.addEventListener("focus", show);
      element.addEventListener("click", show);
    });
  }

  function fitnessInterpretation(days) {
    const fitness = latestValue(days, "fitness");
    const fatigue = latestValue(days, "fatigue");
    if (!fitness && !fatigue) return "Fitness and fatigue need more training history.";

    const deltaFor = (latest, key) => {
      if (!latest) return null;
      const prior = valueAtOrBefore(days, key, latest.index - 7);
      return prior === null ? null : latest.value - prior;
    };
    const fitnessDelta = deltaFor(fitness, "fitness");
    const fatigueDelta = deltaFor(fatigue, "fatigue");

    if (fitnessDelta === null || fatigueDelta === null) {
      return "Your Fitness and Fatigue trend is still forming.";
    }
    if (fatigueDelta < -1 && fatigueDelta < fitnessDelta - 1) {
      return "Fatigue has fallen faster than fitness, leaving you fresher.";
    }
    if (fatigueDelta > 1 && fatigueDelta > fitnessDelta + 1) {
      return "Fatigue has risen faster than fitness, so you are carrying more short-term load.";
    }
    if (fitnessDelta > 1 && fatigueDelta > 1) {
      return "Fitness and fatigue are both rising as recent training accumulates.";
    }
    if (fitnessDelta < -1 && fatigueDelta < -1) {
      return "Fitness and fatigue are both easing after a lighter training period.";
    }
    return "Fitness and fatigue are moving together, keeping Form relatively balanced.";
  }

  function statusCoaching(zone) {
    if (!zone) return "Training status needs more history.";
    if (zone.key === "fresh") {
      return "You are currently fresh enough for a key session, assuming readiness and pain signals remain normal.";
    }
    if (zone.key === "maintaining") {
      return "Training stress and freshness are currently balanced.";
    }
    if (zone.key === "gaining") {
      return "Current training stress is supporting fitness gains; keep recovery signals in view.";
    }
    if (zone.key === "risk") {
      return "Accumulated fatigue is elevated; protect recovery before adding more load.";
    }
    return "Form is very high relative to recent load, which may indicate detraining.";
  }

  function metricMarkup(label, value) {
    return `<div class="trend-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function renderData(data, notice) {
    const content = document.getElementById("trendsContent");
    const state = document.getElementById("trendsState");
    if (!content || !state) return;
    const preview = document.getElementById("trendsPerformancePreview");
    const ranges = document.getElementById("trendRangeControls");
    if (preview) preview.hidden = true;
    if (ranges) ranges.hidden = false;
    const days = expandTrendDays(data.oldest, data.newest, data.days);
    const latestFitness = latestValue(days, "fitness");
    const latestFatigue = latestValue(days, "fatigue");
    const latestForm = latestValue(days, "form");
    const zone = latestForm ? classifyForm(latestForm.value) : null;
    const loadValues = days.slice(-7).filter(day => day.completedLoad !== null);
    const sevenDayLoad = loadValues.length
      ? loadValues.reduce((total, day) => total + day.completedLoad, 0)
      : null;

    state.innerHTML = notice ? `<div class="trend-warning" role="status">${escapeHtml(notice)}</div>` : "";
    content.hidden = false;

    const summary = document.getElementById("trendsHeaderSummary");
    if (summary) {
      const values = [];
      if (zone) values.push(zone.label);
      if (latestFitness) values.push(`Fitness ${fmt(latestFitness.value)}`);
      if (latestFatigue) values.push(`Fatigue ${fmt(latestFatigue.value)}`);
      if (latestForm) values.push(`Form ${fmt(latestForm.value, true)}`);
      summary.textContent = values.length ? values.join(" · ") : "Your training trends are still forming.";
    }

    const strip = document.getElementById("trendMetricStrip");
    if (strip) {
      strip.innerHTML = [
        latestFitness ? metricMarkup("Fitness", fmt(latestFitness.value)) : "",
        latestFatigue ? metricMarkup("Fatigue", fmt(latestFatigue.value)) : "",
        latestForm ? metricMarkup("Form", fmt(latestForm.value, true)) : "",
        sevenDayLoad !== null ? metricMarkup("7-day load", fmt(sevenDayLoad)) : ""
      ].join("");
    }

    const statusTitle = document.getElementById("trendStatusTitle");
    if (statusTitle) statusTitle.textContent = zone
      ? `Training Status: ${zone.label}`
      : "Training Status";
    const statusInterpretation = document.getElementById("trendStatusInterpretation");
    if (statusInterpretation) statusInterpretation.textContent = statusCoaching(zone);
    const statusSummary = document.getElementById("trendStatusSummary");
    if (statusSummary) statusSummary.textContent = accessibleSummary(data, days);
    renderStatusChart(document.getElementById("trendStatusChart"), days);

    const fitnessValues = document.getElementById("trendFitnessValues");
    if (fitnessValues) {
      fitnessValues.textContent = [
        latestFitness ? `Fitness ${fmt(latestFitness.value)}` : "",
        latestFatigue ? `Fatigue ${fmt(latestFatigue.value)}` : ""
      ].filter(Boolean).join(" · ");
    }
    const fitnessCopy = document.getElementById("trendFitnessInterpretation");
    if (fitnessCopy) fitnessCopy.textContent = fitnessInterpretation(days);
    const fitnessSummary = document.getElementById("trendFitnessSummary");
    if (fitnessSummary) fitnessSummary.textContent = accessibleSummary(data, days);
    renderFitnessChart(document.getElementById("trendFitnessChart"), days);

    const buckets = aggregateTrainingLoad(days, data.range);
    const comparison = loadWeekComparison(days, data.newest);
    const loadValuesEl = document.getElementById("trendLoadValues");
    if (loadValuesEl) {
      const current = comparison.current === null ? "—" : fmt(comparison.current);
      loadValuesEl.textContent = `${comparison.inProgress ? "This week in progress" : "Current week"} · ${current}`;
    }
    const loadCopy = document.getElementById("trendLoadInterpretation");
    if (loadCopy) {
      if (!comparison.comparable) {
        loadCopy.textContent = "A same-point prior-week comparison is not available yet.";
      } else if (comparison.percent === null) {
        loadCopy.textContent = `Previous week at the same point: ${fmt(comparison.previous)}.`;
      } else {
        loadCopy.textContent = `${comparison.percent > 0 ? "+" : ""}${comparison.percent}% versus the same elapsed point last week.`;
      }
    }
    const loadSummary = document.getElementById("trendLoadSummary");
    if (loadSummary) {
      loadSummary.textContent = comparison.current === null
        ? "No measured training load is available for the current week."
        : `Current week load is ${fmt(comparison.current)}${comparison.comparable ? ` versus ${fmt(comparison.previous)} at the same point last week` : ""}.`;
    }
    const plannedLegend = document.getElementById("trendPlannedLegend");
    if (plannedLegend) {
      plannedLegend.hidden = !hasPlannedLoad(buckets);
    }
    renderLoadChart(document.getElementById("trendLoadChart"), buckets);

    const noticeEl = document.getElementById("trendHistoryNotice");
    if (noticeEl) {
      const measuredDays = days.filter(day =>
        day.fitness !== null || day.fatigue !== null || day.completedLoad !== null
      ).length;
      noticeEl.hidden = measuredDays >= 7;
    }
  }

  function renderBlockingState(code) {
    const state = document.getElementById("trendsState");
    const content = document.getElementById("trendsContent");
    if (!state || !content) return;
    const preview = document.getElementById("trendsPerformancePreview");
    const ranges = document.getElementById("trendRangeControls");
    if (preview) preview.hidden = true;
    if (ranges) ranges.hidden = false;
    content.hidden = true;

    const reconnect = code === "TRENDS_SCOPE_REQUIRED" || code === "RECONNECT_REQUIRED";
    const disconnected = code === "NOT_CONNECTED";
    const title = disconnected
      ? "Connect training data"
      : reconnect
        ? "Reconnect training data"
        : "Trends are temporarily unavailable";
    const copy = disconnected
      ? "Connect your watch or training platform to see fitness, fatigue, form, and load trends."
      : reconnect
        ? "Reconnect your training data to securely enable fitness, fatigue, form, and load history."
        : "Athlevo could not refresh your training trends. Your provider data was not replaced with zeroes.";
    const label = disconnected
      ? "Connect training data"
      : reconnect
        ? "Reconnect training data"
        : "Retry";
    const action = disconnected || reconnect ? "connect" : "retry";

    state.innerHTML = `
      <div class="trend-state-panel">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(copy)}</p>
        <button type="button" data-trend-state-action="${action}">${escapeHtml(label)}</button>
      </div>`;
  }

  function renderEntitlementLoading(initialLoading) {
    // After first hydration, range/access refreshes stay localized and keep
    // confirmed content visible while the next request is in flight.
    if (!initialLoading) return;
    const state = document.getElementById("trendsState");
    const content = document.getElementById("trendsContent");
    const preview = document.getElementById("trendsPerformancePreview");
    const ranges = document.getElementById("trendRangeControls");
    const summary = document.getElementById("trendsHeaderSummary");
    if (state) state.innerHTML = "";
    if (content) content.hidden = true;
    if (preview) preview.hidden = true;
    if (ranges) ranges.hidden = true;
    if (summary) summary.textContent = "Checking Athlevo Pro access…";
  }

  function renderPerformancePreview() {
    const state = document.getElementById("trendsState");
    const content = document.getElementById("trendsContent");
    const preview = document.getElementById("trendsPerformancePreview");
    const ranges = document.getElementById("trendRangeControls");
    const summary = document.getElementById("trendsHeaderSummary");
    confirmedCache.clear();
    if (state) state.innerHTML = "";
    if (content) content.hidden = true;
    if (preview) preview.hidden = false;
    if (ranges) ranges.hidden = true;
    if (summary) summary.textContent = "Athlevo Pro analytics";
    try {
      if (root.AthlevoAccessGuard) {
        root.AthlevoAccessGuard.trackPremiumView(
          "trends", "trends", preview
        );
      }
    } catch (error) {}
  }

  async function currentUserId() {
    try {
      const result = await supabaseClient.auth.getUser();
      return result && result.data && result.data.user
        ? result.data.user.id
        : null;
    } catch (error) {
      return null;
    }
  }

  async function refresh() {
    bind();
    const loading = root.AthlevoLoadingContinuity;
    const initialLoading = Boolean(loading && loading.begin("trends"));
    renderEntitlementLoading(initialLoading);
    let access = "free";
    try {
      access = root.AthlevoAccessGuard &&
        typeof root.AthlevoAccessGuard.accessState === "function"
        ? await root.AthlevoAccessGuard.accessState()
        : "free";
    } catch (error) {
      renderBlockingState("PROVIDER_UNAVAILABLE");
      if (loading) loading.error("trends");
      return null;
    }
    if (access !== "paid_active") {
      renderPerformancePreview();
      if (loading) loading.success("trends");
      return null;
    }

    const userId = await currentUserId();
    if (!userId || !root.AthlevoBrain ||
        typeof root.AthlevoBrain.loadProviderTrends !== "function") {
      renderBlockingState("PROVIDER_UNAVAILABLE");
      if (loading) loading.error("trends");
      return null;
    }

    try {
      const data = await root.AthlevoBrain.loadProviderTrends(selectedRange);
      if (!data || !Array.isArray(data.days)) throw new Error("Invalid trends response.");
      confirmedCache.set(`${userId}:${selectedRange}`, data);
      renderData(data, "");
      if (loading) loading.success("trends");
      return data;
    } catch (error) {
      if (error && error.code === "PERFORMANCE_REQUIRED") {
        renderPerformancePreview();
        if (loading) loading.success("trends");
        return null;
      }
      const cached = confirmedCache.get(`${userId}:${selectedRange}`);
      if (cached) {
        renderData(
          cached,
          "Could not refresh. Showing your last confirmed trends."
        );
        if (loading) loading.success("trends");
        return cached;
      }
      renderBlockingState(error && error.code);
      if (loading) loading.error("trends");
      return null;
    }
  }

  function selectRange(range) {
    if (!Object.prototype.hasOwnProperty.call(RANGE_LABELS, range)) return;
    selectedRange = range;
    document.querySelectorAll("[data-trend-range]").forEach(button => {
      const active = button.dataset.trendRange === range;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    refresh();
  }

  function bind() {
    if (bound || typeof document === "undefined") return;
    bound = true;
    document.addEventListener("click", event => {
      const rangeButton = event.target.closest("[data-trend-range]");
      if (rangeButton) {
        selectRange(rangeButton.dataset.trendRange);
        return;
      }
      const stateButton = event.target.closest("[data-trend-state-action]");
      if (!stateButton) return;
      if (stateButton.dataset.trendStateAction === "connect" &&
          root.AthlevoBrain && typeof root.AthlevoBrain.connectIntervals === "function") {
        root.AthlevoBrain.connectIntervals();
      } else {
        refresh();
      }
    });
  }

  root.AthlevoTrendsAnalytics = {
    FORM_ZONES,
    classifyForm,
    expandTrendDays,
    lineSegments,
    aggregateTrainingLoad,
    loadWeekComparison,
    hasPlannedLoad,
    accessibleSummary,
    renderStatusChart,
    renderFitnessChart,
    renderLoadChart,
    fitnessInterpretation,
    renderPerformancePreview,
    selectRange,
    refresh,
    renderData
  };
  root.refreshTrends = refresh;

  if (typeof document !== "undefined") bind();
})(window);
