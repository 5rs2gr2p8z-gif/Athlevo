/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach Timeline & recognition display
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Reads the recognition record the server persisted on each activity
 *  (raw_data.recognition, produced by lib/server/workoutRecognition.js) and
 *  turns it into what the athlete sees:
 *
 *    · readRecognition(activity)  → the stored recognition, or null
 *    · activityLabel(activity)    → "Threshold Session", not "12.6 km"
 *    · syncCelebration(activities)→ first-sync aggregate stats (Part 6)
 *
 *  Pure + deterministic. No I/O, no recognition here — it only READS what the
 *  engine already decided, so the label an athlete sees always matches what
 *  Score, Recovery and the plan consume. Exposed as window.AthlevoCoach.
 */
(function (root) {
  "use strict";

  // PART 9: visible build marker so production can confirm the new JS loaded.
  try { if (root.console) root.console.log("[athlevo] recognition display build: coach-timeline-v4"); } catch (e) {}

  function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

  // The recognition record lives inside raw_data; accept a few shapes so this
  // works whether the caller passes the full row or a decorated activity.
  /*
   * Canonical stored-recognition accessor. Checks every real shape the app
   * uses so callers never guess a nested field the activity may not carry:
   *   · activity.recognition            (selected as a top-level alias)
   *   · activity.raw_data.recognition   (full row)
   *   · activity.rawData.recognition    (camelCase variant)
   *   · activity.raw_data.normalized.recognition (legacy nesting)
   * Returns the record only when it is a real recognition (has workoutType).
   */
  function getStoredRecognition(a) {
    if (!a) return null;
    const r = a.recognition ||
      (a.raw_data && a.raw_data.recognition) ||
      (a.rawData && a.rawData.recognition) ||
      (a.raw_data && a.raw_data.normalized && a.raw_data.normalized.recognition) || null;
    return r && r.workoutType ? r : null;
  }
  // Back-compat alias.
  function readRecognition(a) { return getStoredRecognition(a); }

  // A "Session" suffix for quality types reads better on a card; steady runs
  // keep their plain name.
  const SESSION_SUFFIX = new Set(["Threshold", "VO2", "Tempo", "Intervals", "Speed"]);

  function displayType(type) {
    if (!type) return null;
    return SESSION_SUFFIX.has(type) ? type + " Session" : type;
  }

  /*
   * The label the Train card shows. Uses the recognised type when we have one;
   * otherwise falls back to distance so a card is never blank.
   */
  function activityLabel(a) {
    const r = readRecognition(a);
    if (r && r.workoutType && r.workoutType !== "Unknown") return displayType(r.workoutType);
    const m = num(a && (a.distance_meters != null ? a.distance_meters : (a.raw_data && a.raw_data.normalized && a.raw_data.normalized.distanceMeters)));
    return m != null ? (m / 1000).toFixed(1) + " km Run" : "Run";
  }

  // Detected automatically → true when a confident recognition exists.
  function isAutoDetected(a) {
    const r = readRecognition(a);
    return Boolean(r && r.workoutType && r.workoutType !== "Unknown");
  }

  function coachSummary(a) {
    const r = readRecognition(a);
    return r ? r.coachSummary : null;
  }

  function confidenceLabel(a) {
    const r = readRecognition(a);
    return r ? (r.confidenceLabel || null) : null;
  }


  function startMs(a) {
    const d = a && (a.start_date || (a.raw_data && a.raw_data.normalized && a.raw_data.normalized.startDate));
    const t = d ? Date.parse(d) : NaN;
    return Number.isFinite(t) ? t : 0;
  }

  /* ── Part 6: first-sync celebration aggregates ──────────────────────── */

  const QUALITY = new Set(["Threshold", "VO2", "Intervals", "Speed", "Tempo"]);

  /*
   * Real aggregate stats over the imported, recognised activities. Every value
   * is derived, never invented; a stat is omitted when there is no data for it.
   */
  function syncCelebration(activities) {
    const list = Array.isArray(activities) ? activities : [];
    const total = list.length;
    let threshold = 0, longRuns = 0, quality = 0;
    let earliest = Infinity, latest = -Infinity;

    list.forEach(a => {
      const r = readRecognition(a);
      if (r) {
        if (r.workoutType === "Threshold") threshold += 1;
        if (r.workoutType === "Long Run") longRuns += 1;
        if (QUALITY.has(r.workoutType)) quality += 1;
      }
      const t = startMs(a);
      if (t) { earliest = Math.min(earliest, t); latest = Math.max(latest, t); }
    });

    const weeks = (earliest < Infinity && latest > -Infinity)
      ? Math.max(1, Math.round((latest - earliest) / (7 * 24 * 3600 * 1000)))
      : null;

    return {
      activities: total,
      weeks,
      thresholdSessions: threshold,
      longRuns,
      qualitySessions: quality,
      trainingLoadEstimated: total > 0     // load is derivable once we have data
    };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, m =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

    var CELEBRATE_KEY = "athlevo_analysis_celebrated_v1";

  function hasCelebrated() {
    try { return root.localStorage && root.localStorage.getItem(CELEBRATE_KEY) === "1"; } catch (e) { return false; }
  }

  /*
   * PART 6: the one-time analysis celebration. Real aggregates only; every
   * stat omitted when there is no data for it. Renders AT MOST once — the
   * dismissal is persisted in localStorage, so it never reappears on reload.
   * Returns true if it rendered.
   */
  function renderCelebration(activities, mountId) {
    if (hasCelebrated()) return false;
    const el = (root.document && root.document.getElementById) ? root.document.getElementById(mountId || "analysisCelebration") : null;
    if (!el) return false;
    const c = syncCelebration(activities);
    if (!c.activities) return false;   // nothing analyzed yet — don't celebrate

    const rows = [
      ["Activities analyzed", c.activities],
      c.weeks ? ["Weeks of training", c.weeks] : null,
      c.thresholdSessions ? ["Threshold sessions", c.thresholdSessions] : null,
      c.longRuns ? ["Long runs", c.longRuns] : null,
      c.trainingLoadEstimated ? ["Training load", "Estimated"] : null
    ].filter(Boolean);

    el.innerHTML = `<div class="ac-card"><h3 class="ac-h">We've analyzed your training</h3>` +
      rows.map(function (r) { return `<div class="ac-row"><b>${esc(r[1])}</b><span>${esc(r[0])}</span></div>`; }).join("") +
      `</div>`;
    try { root.localStorage.setItem(CELEBRATE_KEY, "1"); } catch (e) {}
    return true;
  }

  const api = {
    readRecognition, activityLabel, isAutoDetected, coachSummary, confidenceLabel,
    displayType, syncCelebration, renderCelebration,
    hasCelebrated, getStoredRecognition, VERSION: "coach-timeline-v4"
  };
  if (root) root.AthlevoCoach = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
