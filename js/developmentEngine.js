/* Athlevo — Development Engine (client mirror of lib/server/developmentEngine.js).
   Pure. Exposed as window.AthlevoDevelopment. Parity-tested. */
(function(){
"use strict";
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f; }

/* ═══════════════════════ 1 · development progressions ═══════════════════ */

// Maps a development category to the Athlevo Score component that drives its
// progress %, plus its athlete-facing label.
const CATEGORIES = [
  { key: "aerobic", component: "aerobic", label: "Stronger Aerobic Runner" },
  { key: "durability", component: "durability", label: "Better Long Run Durability" },
  { key: "threshold", component: "threshold", label: "Threshold Development" },
  { key: "speed", component: "speed", label: "Speed Development" },
  { key: "consistency", component: "consistency", label: "Running Consistency" }
];

const IMPROVE_DELTA = 3;   // component-point change that counts as a real move

// Trend from current vs. a prior (≈30-day) component value, falling back to
// activity signals when there's no history yet.
function trendFor(current, prior, positiveSignal) {
  if (current == null) return "Building";
  if (prior != null) {
    const d = current - prior;
    if (d >= IMPROVE_DELTA) return "Improving";
    if (d <= -IMPROVE_DELTA) return "Declining";
    return "Plateau";
  }
  if (positiveSignal === true) return "Improving";
  if (positiveSignal === false) return "Plateau";
  return "Building";
}

// The WHY for each category, grounded only in real signals.
function reasonFor(key, s, trend) {
  s = s || {};
  switch (key) {
    case "aerobic": {
      const pct = num(s.easyVolumeChangePct);
      if (pct != null && pct >= 5) return `Weekly easy-running volume increased ${Math.round(pct)}%.`;
      if (pct != null && pct <= -5) return `Weekly easy-running volume dropped ${Math.abs(Math.round(pct))}%.`;
      if (num(s.easyRunCount) > 0) return `Building aerobic base across ${num(s.easyRunCount)} recent easy runs.`;
      return "Not enough recent easy running to measure aerobic development yet.";
    }
    case "durability": {
      const n = num(s.longRunCount) || 0;
      if (n >= 3) return `You completed ${n} long runs recently without excessive fatigue.`;
      if (n >= 1) return `${n} long run${n === 1 ? "" : "s"} recently — durability is starting to build.`;
      return "No recent long runs to measure durability.";
    }
    case "threshold": {
      const n = num(s.thresholdSessions) || 0;
      const paceUp = num(s.thresholdPaceImprovedSec);
      if (n >= 2 && paceUp != null && paceUp >= 3) return `You completed ${n} threshold sessions in the last four weeks with improving pace and stable heart rate.`;
      if (n >= 2) return `You completed ${n} threshold sessions in the last four weeks.`;
      if (n === 1) return "One recent threshold session — a second lets Athlevo confirm the trend.";
      return "No recent threshold sessions.";
    }
    case "speed": {
      const n = num(s.intervalSessions) || 0;
      if (n >= 2) return `${n} interval/repetition sessions recently sharpening top-end speed.`;
      if (n === 1) return "One recent interval session.";
      return "No recent interval sessions.";
    }
    case "consistency": {
      const pct = num(s.completionPct);
      const weeks = num(s.weeksActive) || 0;
      if (pct != null && weeks >= 2) return `${Math.round(pct)}% of recorded sessions completed across ${weeks} active weeks.`;
      if (weeks >= 1) return `${weeks} active training week${weeks === 1 ? "" : "s"} logged so far.`;
      return "A couple of weeks of continuous training will establish consistency.";
    }
    default:
      return "";
  }
}

// The concrete next step for each category (data-aware).
function milestoneFor(key, s) {
  s = s || {};
  switch (key) {
    case "aerobic":
      return "Add about 10% easy volume over the next two weeks.";
    case "durability": {
      const long = num(s.longestRunKm);
      return long ? `Extend your long run past ${Math.round(long) + 2} km.` : "Complete two long runs of 90+ minutes.";
    }
    case "threshold": {
      const n = num(s.thresholdSessions) || 0;
      return n >= 2
        ? "Increase threshold pace by approximately 5 sec/km."
        : "Complete two quality threshold sessions.";
    }
    case "speed": {
      const n = num(s.intervalSessions) || 0;
      return n >= 1 ? "Add a second short interval session this block." : "Add one short interval or strides session.";
    }
    case "consistency": {
      const pct = num(s.completionPct);
      return pct != null && pct >= 90 ? "Maintain this rhythm through the next block." : "Complete every planned session this week.";
    }
    default:
      return "";
  }
}

function buildProgressions(input) {
  input = input || {};
  const components = input.components || {};
  const prior = input.prior || {};
  const s = input.signals || {};

  return CATEGORIES.map(cat => {
    const c = components[cat.component];
    const cur = c && c.status === "valid" && num(c.score) != null ? num(c.score) : (num(c && c.score));
    const priorC = prior[cat.component];
    const priorVal = priorC != null && num(priorC.score ?? priorC) != null ? num(priorC.score ?? priorC) : null;

    // Positive signal fallback per category (when no history exists).
    let posSignal = null;
    if (cat.key === "aerobic") posSignal = num(s.easyVolumeChangePct) != null ? num(s.easyVolumeChangePct) >= 5 : null;
    else if (cat.key === "durability") posSignal = num(s.longRunCount) != null ? num(s.longRunCount) >= 2 : null;
    else if (cat.key === "threshold") posSignal = num(s.thresholdSessions) != null ? num(s.thresholdSessions) >= 2 : null;
    else if (cat.key === "speed") posSignal = num(s.intervalSessions) != null ? num(s.intervalSessions) >= 1 : null;
    else if (cat.key === "consistency") posSignal = num(s.completionPct) != null ? num(s.completionPct) >= 80 : null;

    const trend = trendFor(cur, priorVal, posSignal);
    return {
      key: cat.key,
      label: cat.label,
      progress: cur != null ? Math.max(0, Math.min(100, Math.round(cur))) : null,
      trend,
      reason: reasonFor(cat.key, s, trend),
      nextMilestone: milestoneFor(cat.key, s)
    };
  });
}

/* ═══════════════════════ 2 · achievements (data-driven) ═════════════════
 *
 * Detected from the athlete's real history — never a hardcoded earned list.
 * Each returns { key, title, date, reason, supporting } or null.
 */

function monthKey(iso) { return String(iso).slice(0, 7); }

function detectAchievements(data) {
  data = data || {};
  const runs = (data.runs || []).filter(r => r && r.date && num(r.distanceKm) != null);
  const out = [];

  // First 100 km month.
  const byMonth = {};
  runs.forEach(r => { const k = monthKey(r.date); byMonth[k] = (byMonth[k] || 0) + (num(r.distanceKm) || 0); });
  const months = Object.keys(byMonth).sort();
  const first100 = months.find(m => byMonth[m] >= 100);
  if (first100) {
    out.push({ key: "first_100km_month", title: "First 100 km month", date: `${first100}-01`,
      reason: `You ran ${Math.round(byMonth[first100])} km in ${first100}.`, supporting: { km: round(byMonth[first100], 0), month: first100 } });
  }

  // Longest long run.
  let longest = null;
  runs.forEach(r => { if (longest == null || r.distanceKm > longest.distanceKm) longest = r; });
  if (longest && longest.distanceKm >= 15) {
    out.push({ key: "longest_long_run", title: "Longest long run", date: longest.date,
      reason: `${round(longest.distanceKm, 1)} km — your longest single run.`, supporting: { km: round(longest.distanceKm, 1) } });
  }

  // Fastest threshold pace (from threshold-classified runs).
  const thr = runs.filter(r => r.type === "threshold" && num(r.paceSec) != null);
  let fastest = null;
  thr.forEach(r => { if (fastest == null || r.paceSec < fastest.paceSec) fastest = r; });
  if (fastest) {
    out.push({ key: "fastest_threshold", title: "Fastest threshold pace", date: fastest.date,
      reason: `Your quickest sustained threshold effort to date.`, supporting: { paceSec: Math.round(fastest.paceSec) } });
  }

  // Training-load PR (highest weekly load).
  if (num(data.maxWeeklyLoad) != null && data.maxWeeklyLoadWeek) {
    out.push({ key: "training_load_pr", title: "Training load PR", date: data.maxWeeklyLoadWeek,
      reason: "Your highest sustainable weekly training load so far.", supporting: { load: Math.round(num(data.maxWeeklyLoad)) } });
  }

  // Longest weekly running streak.
  const streak = num(data.weekStreak);
  if (streak != null && streak >= 4) {
    out.push({ key: "week_streak", title: `${streak}-week training streak`, date: data.streakEndDate || null,
      reason: `${streak} consecutive weeks with training.`, supporting: { weeks: streak } });
  }

  // New aerobic milestone (aerobic component crossing a band, from history).
  if (num(data.aerobicMilestone) != null) {
    out.push({ key: "aerobic_milestone", title: "New aerobic milestone", date: data.aerobicMilestoneDate || null,
      reason: `Aerobic base reached a new level (${Math.round(num(data.aerobicMilestone))}).`, supporting: { level: Math.round(num(data.aerobicMilestone)) } });
  }

  // Highest consistency reached.
  if (num(data.bestConsistency) != null && num(data.bestConsistency) >= 85) {
    out.push({ key: "highest_consistency", title: "Highest consistency", date: data.bestConsistencyDate || null,
      reason: `${Math.round(num(data.bestConsistency))}% session completion — your most consistent stretch.`, supporting: { pct: Math.round(num(data.bestConsistency)) } });
  }

  // Newest first (date desc), undated last.
  out.sort((a, b) => (Date.parse(b.date || "1970-01-01") || 0) - (Date.parse(a.date || "1970-01-01") || 0));
  return out;
}

/* ═══════════════════════ 3 · development timeline ═══════════════════════
 *
 * Ordered milestones telling the athlete's development story. Data-driven
 * from real events; the last node is always "Today".
 */
function buildTimeline(data) {
  data = data || {};
  const runs = (data.runs || []).filter(r => r && r.date).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const events = [];

  if (runs.length) {
    events.push({ key: "started", label: "Started training", date: runs[0].date });
  }
  const firstThr = runs.find(r => r.type === "threshold");
  if (firstThr) events.push({ key: "first_threshold", label: "Completed first threshold workout", date: firstThr.date });

  // First 50 km week.
  if (Array.isArray(data.weekly) && data.weekly.length) {
    const w50 = data.weekly.slice().sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart)).find(w => num(w.km) >= 50);
    if (w50) events.push({ key: "first_50k_week", label: "First 50 km week", date: w50.weekStart });
  }

  // Race PBs (best per distance) from confirmed races.
  (data.races || []).forEach(r => {
    if (r && r.date && r.label) events.push({ key: "race_" + r.date, label: r.label, date: r.date });
  });

  events.push({ key: "today", label: "Today", date: data.today || new Date().toISOString().slice(0, 10) });

  events.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  // De-duplicate exact same label+date.
  const seen = new Set();
  return events.filter(e => { const k = e.label + "|" + e.date; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ═══════════════════ monthly snapshot comparison (reuse) ════════════════
 *
 * Picks the score-history snapshot nearest to N days ago so the UI can show
 * this month vs. last / 3 / 6 months ago WITHOUT a new table.
 */
function snapshotNearest(history, daysAgo, nowMs) {
  const target = (nowMs || Date.now()) - daysAgo * 86400000;
  let best = null, bestGap = Infinity;
  (history || []).forEach(h => {
    if (h.overall_score == null || !h.score_date) return;
    const t = Date.parse(h.score_date + "T12:00:00Z");
    if (!Number.isFinite(t)) return;
    const gap = Math.abs(t - target);
    // Only accept a snapshot within ±20 days of the target window.
    if (gap < bestGap && gap <= 20 * 86400000) { best = h; bestGap = gap; }
  });
  return best;
}

window.AthlevoDevelopment = { buildProgressions, detectAchievements, buildTimeline, snapshotNearest, DEVELOPMENT_ENGINE_VERSION:"development-engine-v1" };

})();
