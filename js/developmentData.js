/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Your Development: data collection + rendering
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The DATA + RENDER layers for the "Your Development" Today card (pure
 *  progression/achievement/timeline logic lives in js/developmentEngine.js).
 *
 *  Data-driven and reuse-only:
 *    · current component scores → the Athlevo Score card's live components
 *    · prior (≈30-day) components → persisted athlete_score_history
 *      (existing storage; NO new snapshot table)
 *    · supporting signals + run classification → AthleteEngine
 *    · races → race_results
 *  Achievements and timeline are DERIVED from real history — never hardcoded.
 *  Future device feeds only add rows to the same inputs.
 */

(function () {
  "use strict";

  const DAY = 86400000;

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function ageDays(iso, nowMs) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? (nowMs - t) / DAY : Infinity;
  }
  function mondayOf(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const wd = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - wd);
    return d.toISOString().slice(0, 10);
  }

  async function currentUser() {
    try { const { data: { user } } = await supabaseClient.auth.getUser(); return user || null; }
    catch (e) { return null; }
  }
  async function loadScoreHistory(userId) {
    try {
      const { data } = await supabaseClient
        .from("athlevo_score_history")
        .select("score_date,overall_score,component_scores")
        .eq("user_id", userId)
        .order("score_date", { ascending: false })
        .limit(200);
      return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
  }
  async function loadRaces(userId) {
    try {
      const { data } = await supabaseClient
        .from("race_results")
        .select("race_type,race_date,distance_meters,duration_seconds")
        .eq("user_id", userId);
      return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
  }

  // Canonical run type for achievements/timeline (reuses the classifier).
  function canonicalType(t) {
    const s = String(t || "").toLowerCase();
    if (s.includes("threshold")) return "threshold";
    if (s.includes("long")) return "long";
    if (s.includes("vo2") || s.includes("interval")) return "interval";
    if (s.includes("recovery")) return "recovery";
    if (s.includes("race") || s.includes("time")) return "race";
    return "easy";
  }

  function buildRuns(activities, fitness) {
    const AE = window.AthleteEngine;
    if (!AE) return [];
    const paces = fitness && fitness.vdot != null && window.AthlevoPerformance
      ? window.AthlevoPerformance.trainingPaces(fitness.vdot) : null;
    const ctx = paces ? { easySec: paces.easy.secPerKm, thresholdSec: paces.threshold.secPerKm, intervalSec: paces.vo2.secPerKm } : {};
    return (activities || []).map(a => {
      const meters = num(a.distance_meters), secs = num(a.moving_time_seconds);
      if (!meters || !secs || !a.start_date) return null;
      const paceSec = secs / (meters / 1000);
      const type = AE.classifyWorkout({
        isRun: true, title: a.name || "", distanceKm: meters / 1000, durationMin: secs / 60,
        paceSec, hr: num(a.average_heartrate), maxHr: num(a.max_heartrate),
        elevPerKm: num(a.elevation_gain_meters) != null ? num(a.elevation_gain_meters) / (meters / 1000) : null
      }, ctx).type;
      return { date: String(a.start_date).slice(0, 10), distanceKm: meters / 1000, durationMin: secs / 60, paceSec, hr: num(a.average_heartrate), type: canonicalType(type) };
    }).filter(Boolean);
  }

  function weeklyStreak(runs, nowMs) {
    if (!runs.length) return { streak: 0, endDate: null };
    const weeks = new Set(runs.map(r => mondayOf(r.date)).filter(Boolean));
    let cur = mondayOf(new Date(nowMs).toISOString());
    let streak = 0, last = cur;
    while (weeks.has(cur)) {
      streak += 1; last = cur;
      const d = new Date(cur + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 7); cur = d.toISOString().slice(0, 10);
    }
    return { streak, endDate: last };
  }

  function raceLabel(r) {
    const m = num(r.distance_meters), s = num(r.duration_seconds);
    let dist = null;
    if (m) { const km = m / 1000; dist = Math.abs(km - 21.0975) <= 1 ? "Half marathon" : Math.abs(km - 42.195) <= 1.5 ? "Marathon" : Math.abs(km - 10) <= 0.5 ? "10K" : Math.abs(km - 5) <= 0.3 ? "5K" : `${Math.round(km)} km`; }
    let time = "";
    if (s) { const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; time = h > 0 ? `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`; }
    return `${dist || "Race"}${time ? " · " + time : ""}`;
  }

  /* ─────────────────────── signal collection ──────────────────────── */

  async function collect(profile) {
    const user = await currentUser();
    if (!user) return null;
    const nowMs = Date.now();

    let activities = [];
    try { if (window.AthlevoBrain) activities = await window.AthlevoBrain.loadAthleteActivities("history"); } catch (e) {}
    const races = await loadRaces(user.id);
    const history = await loadScoreHistory(user.id);
    let fitness = null;
    try { if (window.AthleteModel) fitness = await window.AthleteModel.getFitness(); } catch (e) {}

    const runs = buildRuns(activities, fitness);

    // Current components: live from the score card; prior from history.
    const current = (window.__athlevoLastComponents) || latestComponents(history);
    const priorSnap = window.AthlevoDevelopment
      ? window.AthlevoDevelopment.snapshotNearest(history, 30, nowMs) : null;
    const prior = priorSnap && priorSnap.component_scores ? priorSnap.component_scores : {};

    // Supporting signals.
    const within = d => runs.filter(r => ageDays(r.date, nowMs) <= d);
    const between = (a, b) => runs.filter(r => { const x = ageDays(r.date, nowMs); return x > a && x <= b; });
    const sumEasyKm = arr => arr.filter(r => r.type === "easy" || r.type === "recovery" || r.type === "long").reduce((s, r) => s + r.distanceKm, 0);
    const e1 = sumEasyKm(within(28)), e0 = sumEasyKm(between(28, 56));

    let consistency = {};
    try {
      if (window.AthleteEngine) {
        const m = window.AthleteEngine.computeAthleteMetrics({ activities, executions: [], races, profile, now: nowMs });
        consistency = (m.detail && m.detail.consistency) || {};
      }
    } catch (e) {}

    const signals = {
      easyVolumeChangePct: e0 > 0 ? ((e1 - e0) / e0) * 100 : null,
      easyRunCount: within(28).filter(r => r.type === "easy").length,
      longRunCount: within(42).filter(r => r.type === "long").length,
      thresholdSessions: within(28).filter(r => r.type === "threshold").length,
      intervalSessions: within(28).filter(r => r.type === "interval").length,
      completionPct: num(consistency.consistency_percentage),
      weeksActive: num(consistency.weeks_active_6wk),
      longestRunKm: runs.length ? Math.max(...runs.map(r => r.distanceKm)) : null
    };

    // Achievement inputs.
    const streak = weeklyStreak(runs, nowMs);
    const bestConsistency = history.reduce((m, h) => {
      const v = h.component_scores && num(h.component_scores.consistency);
      return v != null && v > (m ? m.v : -1) ? { v, date: h.score_date } : m;
    }, null);
    // New aerobic milestone: current aerobic crossing a 70/80/90 band not
    // previously reached.
    const curAerobic = current && current.aerobic ? num(current.aerobic.score ?? current.aerobic) : null;
    const priorMaxAerobic = history.reduce((m, h) => {
      const v = h.component_scores && num(h.component_scores.aerobic);
      return v != null && v > m ? v : m;
    }, 0);
    let aerobicMilestone = null, aerobicMilestoneDate = null;
    if (curAerobic != null) {
      for (const band of [90, 80, 70]) {
        if (curAerobic >= band && priorMaxAerobic < band) { aerobicMilestone = band; aerobicMilestoneDate = new Date(nowMs).toISOString().slice(0, 10); break; }
      }
    }

    const achData = {
      runs, weekStreak: streak.streak, streakEndDate: streak.endDate,
      bestConsistency: bestConsistency ? bestConsistency.v : null, bestConsistencyDate: bestConsistency ? bestConsistency.date : null,
      aerobicMilestone, aerobicMilestoneDate
    };

    // Timeline inputs.
    const weeklyMap = {};
    runs.forEach(r => { const w = mondayOf(r.date); if (w) weeklyMap[w] = (weeklyMap[w] || 0) + r.distanceKm; });
    const weekly = Object.keys(weeklyMap).map(w => ({ weekStart: w, km: weeklyMap[w] }));
    const raceEvents = races.filter(r => r.race_date && (r.race_type === "official" || r.race_type === "time_trial"))
      .map(r => ({ date: r.race_date, label: raceLabel(r) }));

    return { current, prior, signals, achData, timelineData: { runs, weekly, races: raceEvents, today: new Date(nowMs).toISOString().slice(0, 10) } };
  }

  function latestComponents(history) {
    const h = (history || []).find(x => x.component_scores);
    return h ? h.component_scores : {};
  }

  /* ─────────────────────────── rendering ──────────────────────────── */

  const TREND_CLASS = { Improving: "up", Plateau: "flat", Declining: "down", Building: "build" };

  function progRow(p) {
    const pct = p.progress != null ? p.progress : 0;
    return `
      <div class="dev-prog">
        <div class="dev-prog-top">
          <span class="dev-prog-label">${esc(p.label)}</span>
          <span class="dev-prog-pct">${p.progress != null ? p.progress + "%" : "—"}</span>
        </div>
        <div class="dev-bar"><i class="${esc(TREND_CLASS[p.trend] || "build")}" style="width:${Math.max(2, pct)}%"></i></div>
        <div class="dev-prog-meta">
          <span class="dev-trend ${esc(TREND_CLASS[p.trend] || "build")}">${esc(p.trend)}</span>
          <span class="dev-reason">${esc(p.reason)}</span>
        </div>
        <p class="dev-milestone"><span class="dev-k">Next milestone</span> ${esc(p.nextMilestone)}</p>
      </div>`;
  }

  function achRow(a) {
    return `<div class="dev-ach">
      <span class="dev-ach-title">${esc(a.title)}</span>
      <span class="dev-ach-reason">${esc(a.reason)}${a.date ? ` · ${esc(a.date)}` : ""}</span>
    </div>`;
  }

  function timelineRows(events) {
    return events.map((e, i) => `
      <div class="dev-tl-row${i === events.length - 1 ? " now" : ""}">
        <span class="dev-tl-dot"></span>
        <div class="dev-tl-body"><span class="dev-tl-label">${esc(e.label)}</span>${e.date ? `<span class="dev-tl-date">${esc(e.date)}</span>` : ""}</div>
      </div>`).join("");
  }

  async function renderDevelopment(profile) {
    const mount = document.getElementById("developmentCard");
    if (!mount || !window.AthlevoDevelopment) return;
    try {
      const data = await collect(profile);
      if (!data) { mount.innerHTML = ""; return; }

      const progressions = window.AthlevoDevelopment.buildProgressions({ components: data.current, prior: data.prior, signals: data.signals });
      const achievements = window.AthlevoDevelopment.detectAchievements(data.achData).slice(0, 4);
      const timeline = window.AthlevoDevelopment.buildTimeline(data.timelineData).slice(-6);

      const hasProgress = progressions.some(p => p.progress != null);

      mount.innerHTML = `
        <div class="dev">
          <div class="dev-head">
            <span class="dev-eyebrow">Your Development</span>
            <span class="dev-sub">You are becoming…</span>
          </div>
          ${hasProgress
            ? `<div class="dev-progs">${progressions.map(progRow).join("")}</div>`
            : `<p class="dev-empty">Log a few more sessions and your development picture will build here.</p>`}
          ${achievements.length ? `<div class="dev-section"><span class="dev-section-h">Achievements</span>${achievements.map(achRow).join("")}</div>` : ""}
          ${timeline.length > 1 ? `<div class="dev-section"><span class="dev-section-h">Your journey</span><div class="dev-tl">${timelineRows(timeline)}</div></div>` : ""}
        </div>`;
    } catch (error) {
      console.warn("Development card failed:", error && error.message);
      mount.innerHTML = "";
    }
  }

  window.DevelopmentData = { collect, renderDevelopment };
  window.renderDevelopment = renderDevelopment;
})();
