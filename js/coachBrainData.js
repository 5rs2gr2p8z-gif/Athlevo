/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Coach Brain: data collection + rendering
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The DATA and RENDER layers of Coach Brain V1 (the pure reasoning lives
 *  in js/coachBrain.js). This assembles a normalised `signals` bundle from
 *  systems that ALREADY exist — no new metrics are computed here:
 *    · AthleteEngine.computeAthleteMetrics  → load balance (ACWR),
 *      consistency, missed sessions, long-run count, workout classification
 *    · AthlevoTrends.buildTrends            → weekly-volume vs. last week
 *    · getReadinessForCoach                 → today's readiness
 *    · athlete_score_history                → Athlevo Score change
 *    · race_results / profile               → race proximity, pain
 *  It then asks the reasoning engine for the top 3 insights and renders the
 *  "Coach Insights" card (plus "Training Updated" blocks when the plan
 *  changed). Future device feeds (Garmin/WHOOP/COROS) only add signals —
 *  the reasoning and UI are untouched.
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

  async function currentUser() {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      return user || null;
    } catch (e) { return null; }
  }

  async function loadExecutions(userId) {
    try {
      const { data } = await supabaseClient
        .from("workout_execution_records")
        .select("status,completed_at,updated_at,created_at,actual_duration_minutes,actual_distance_km,actual_average_hr,actual_rpe,pain_present,skip_reason,original_session_snapshot,imported_activity_id,training_session_id")
        .eq("user_id", userId);
      return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
  }
  async function loadRaces(userId) {
    try {
      const { data } = await supabaseClient
        .from("race_results")
        .select("id,race_type,race_date,distance_meters,duration_seconds,source")
        .eq("user_id", userId);
      return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
  }
  async function scoreChange(userId) {
    try {
      const { data } = await supabaseClient
        .from("athlevo_score_history")
        .select("score_date,overall_score")
        .eq("user_id", userId)
        .order("score_date", { ascending: false })
        .limit(12);
      const valid = (data || []).filter(h => h.overall_score != null && h.score_date);
      if (valid.length < 2) return null;
      const today = valid[0].score_date;
      const prior = valid.find(h => h.score_date !== today);
      return prior ? Number(valid[0].overall_score) - Number(prior.overall_score) : null;
    } catch (e) { return null; }
  }

  function raceDays(profile, nowMs) {
    if (!profile || !profile.race_date || !profile.target_race) return null;
    const t = Date.parse(String(profile.race_date) + "T00:00:00Z");
    if (!Number.isFinite(t)) return null;
    const days = Math.ceil((t - nowMs) / DAY);
    return days >= 0 ? days : null;
  }

  /* ─────────────────────── signal collection ──────────────────────── */

  async function collectSignals(profile) {
    const user = await currentUser();
    if (!user) return {};
    const nowMs = Date.now();
    const signals = { now: new Date() };

    let activities = [];
    try {
      if (window.AthlevoBrain && window.AthlevoBrain.loadAthleteActivities) {
        // Coach reasoning compares recent load against the season.
        activities = await window.AthlevoBrain.loadAthleteActivities("history");
      }
    } catch (e) { activities = []; }
    const executions = await loadExecutions(user.id);
    const races = await loadRaces(user.id);

    // Reuse the athlete engine for load / consistency / classifications.
    try {
      if (window.AthleteEngine && window.AthleteEngine.computeAthleteMetrics) {
        const m = window.AthleteEngine.computeAthleteMetrics({ activities, executions, races, profile, now: nowMs });
        const d = m.detail || {};
        if (num(d.acwr) != null) signals.recovery = { acwr: num(d.acwr) };
        if (d.consistency) {
          signals.consistency = {
            completionPct: num(d.consistency.consistency_percentage),
            weeksActive: num(d.consistency.weeks_active_6wk)
          };
          if (num(d.consistency.days_missed) != null) {
            signals.missed = { count: num(d.consistency.days_missed), windowDays: 42 };
          }
        }
        const longs = (d.classifications || []).filter(c =>
          c.type === "Long Run" && ageDays(c.timestamp, nowMs) <= 42);
        if (longs.length) signals.longRun = { count: longs.length };
      }
    } catch (e) { /* engine optional */ }

    // Weekly volume vs. same point last week (from the trends engine).
    try {
      if (window.AthlevoTrends && window.AthlevoTrends.buildTrends) {
        const t = window.AthlevoTrends.buildTrends(activities, executions, {
          timezone: profile && profile.timezone, now: new Date()
        });
        const dv = t.diffs && t.diffs.runDistanceKm;
        if (dv) signals.volume = { deltaKm: num(dv.absolute), comparable: dv.comparable === true };
      }
    } catch (e) { /* optional */ }

    // Today's readiness.
    try {
      if (typeof window.getReadinessForCoach === "function") {
        const r = await window.getReadinessForCoach();
        if (r && r.readinessScore != null) {
          signals.readiness = { score: num(r.readinessScore), status: String(r.readinessStatus || "").toLowerCase() };
        }
      }
    } catch (e) { /* optional */ }

    // Athlevo Score change (persisted history).
    const chg = await scoreChange(user.id);
    if (chg != null && chg !== 0) signals.athlevoScore = { change: chg };

    // Race proximity + pain + HR availability.
    const days = raceDays(profile, nowMs);
    if (days != null) signals.race = { daysToRace: days };
    if (executions.some(e => e.pain_present === true && ageDays(e.completed_at || e.updated_at, nowMs) <= 10)) {
      signals.pain = { present: true };
    }
    const hrRuns = activities.filter(a => num(a.average_heartrate) > 0).length;
    signals.hr = { available: hrRuns >= 3 };

    return signals;
  }

  /* ─────────────────────────── rendering ──────────────────────────── */

  const CONF_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
  const CONF_CLASS = { high: "strong", medium: "dev", low: "lim" };

  function insightBlock(i) {
    return `
      <div class="cib">
        <div class="cib-top">
          <span class="cib-tag">Observation</span>
          <span class="cib-conf ${CONF_CLASS[i.confidence] || "lim"}">${esc(CONF_LABEL[i.confidence] || "")}</span>
        </div>
        <p class="cib-obs">${esc(i.observation)}</p>
        <p class="cib-line"><span class="cib-k">Reasoning</span> ${esc(i.reasoning)}</p>
        <p class="cib-line"><span class="cib-k">Action</span> ${esc(i.action)}</p>
      </div>`;
  }

  function adaptationBlock(a) {
    return `
      <div class="cib cib-adapt">
        <span class="cib-tag red">Training updated</span>
        <p class="cib-obs">${esc(a.title)}</p>
        <div class="cib-flow">
          <span class="cib-prev">${esc(a.previous)}</span>
          <span class="cib-arrow">↓</span>
          <span class="cib-next">${esc(a.next)}</span>
        </div>
        <p class="cib-line"><span class="cib-k">Why</span> ${esc(a.why)}</p>
      </div>`;
  }

  async function renderCoachInsights(profile) {
    const mount = document.getElementById("coachInsightsCard");
    if (!mount || !window.AthlevoCoachBrain) return;
    try {
      const signals = await collectSignals(profile);
      const insights = window.AthlevoCoachBrain.generateInsights(signals, { limit: 3 });
      const changes = Array.isArray(window.__athlevoPlanChanges) ? window.__athlevoPlanChanges : [];
      const adaptations = window.AthlevoCoachBrain.explainAdaptation(changes, { limit: 2 });

      if (!insights.length && !adaptations.length) {
        // Never fabricate: show a calm, honest baseline state.
        mount.innerHTML = `
          <div class="cic">
            <div class="cic-head"><span class="cic-eyebrow">Coach Insights</span></div>
            <p class="cic-empty">Building your coaching picture — a few more logged sessions and confirmed data will unlock specific insights.</p>
          </div>`;
        return;
      }

      mount.innerHTML = `
        <div class="cic">
          <div class="cic-head"><span class="cic-eyebrow">Coach Insights</span></div>
          ${adaptations.map(adaptationBlock).join("")}
          ${insights.map(insightBlock).join("")}
        </div>`;
    } catch (error) {
      console.warn("Coach insights failed:", error && error.message);
      mount.innerHTML = "";
    }
  }

  window.CoachBrainData = { collectSignals, renderCoachInsights };
  window.renderCoachInsights = renderCoachInsights;
})();
