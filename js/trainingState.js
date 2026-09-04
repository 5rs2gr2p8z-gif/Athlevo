/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Training State for AI Coach
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Assembles a compact trainingState object from existing canonical
 *  sources for injection into the Coach context. Reuses existing
 *  calculations verbatim — no new computation models.
 *
 *  Sources:
 *    · Provider wellness (Intervals.icu CTL/ATL) → fitness, fatigue, form
 *    · AthlevoTrendsAnalytics.classifyForm()     → formZone
 *    · AthleteEngine.computeAthleteMetrics()     → acwr, trainingBalance,
 *                                                   recentLoadChangePct, weeklyLoad
 *
 *  Caching:
 *    · 5-minute in-memory TTL on the assembled trainingState
 *    · Concurrent calls share one in-flight Promise (no duplicate fetches)
 *    · Errors are never cached — next call retries from canonical sources
 *    · Page navigation / session end clears the cache naturally
 *
 *  Exposed as window.AthlevoTrainingState.
 */
(function (root) {
  "use strict";

  /* ── In-memory cache ──────────────────────────────────────────────── */

  var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  var _cache = {
    state: null,   // the cached trainingState object
    at: 0,         // Date.now() when cached
    inflight: null // Promise if a refresh is in progress
  };

  /**
   * Get a cached-or-fresh trainingState. This is the primary entry point
   * for js/coach.js — it handles fetching wellness data internally.
   *
   * @param {Object} opts
   * @param {Array}       opts.activities    — raw Supabase activities
   * @param {Array}       [opts.executions]  — execution records (optional)
   * @param {Array}       [opts.races]       — race results (optional)
   * @param {Object}      [opts.profile]     — athlete profile (optional)
   * @returns {Promise<Object|null>}  trainingState (11 fields) or null on error
   */
  function getTrainingState(opts) {
    // Return cached value if still fresh
    if (_cache.state && (Date.now() - _cache.at < CACHE_TTL_MS)) {
      return Promise.resolve(_cache.state);
    }

    // If a refresh is already in flight, piggyback on it
    if (_cache.inflight) {
      return _cache.inflight;
    }

    // Start a new refresh
    _cache.inflight = _refreshTrainingState(opts)
      .then(function (state) {
        _cache.state = state;
        _cache.at = Date.now();
        _cache.inflight = null;
        return state;
      })
      .catch(function (err) {
        // Do NOT cache errors — next call retries
        _cache.inflight = null;
        console.warn("[trainingState] refresh failed:", err);
        return null;
      });

    return _cache.inflight;
  }

  /**
   * Invalidate the cache so the next getTrainingState() rebuilds.
   * Does NOT cancel an in-flight refresh.
   */
  function invalidateCache() {
    _cache.state = null;
    _cache.at = 0;
  }

  /* ── Internal refresh ─────────────────────────────────────────────── */

  async function _refreshTrainingState(opts) {
    opts = opts || {};

    // Fetch provider wellness (non-fatal)
    var wellnessDays = null;
    try {
      var Brain = root.AthlevoBrain;
      if (Brain && typeof Brain.loadProviderTrends === "function") {
        var trendData = await Brain.loadProviderTrends("6w");
        if (trendData && Array.isArray(trendData.days)) {
          wellnessDays = trendData.days;
        }
      }
    } catch (e) {
      // Provider unavailable — wellness fields will be null
    }

    return buildTrainingState({
      wellnessDays: wellnessDays,
      activities: opts.activities || [],
      executions: opts.executions || [],
      races: opts.races || [],
      profile: opts.profile || null
    });
  }

  /* ── Core builder (unchanged from Step 2) ─────────────────────────── */

  /**
   * Build the compact trainingState object for the AI Coach context.
   *
   * @param {Object} opts
   * @param {Array|null}  opts.wellnessDays  — normalized provider wellness days
   *                                           (from loadProviderTrends().days)
   * @param {Array}       opts.activities    — raw Supabase activities (same array
   *                                           already loaded for buildCoachingContext)
   * @param {Array}       [opts.executions]  — execution records (optional)
   * @param {Array}       [opts.races]       — race results (optional)
   * @param {Object}      [opts.profile]     — athlete profile (optional)
   * @returns {Object}    trainingState with 11 fields
   */
  function buildTrainingState(opts) {
    opts = opts || {};

    // ── Provider wellness → fitness, fatigue, form, fitnessTrend ──
    var wellness = buildWellnessFields(opts.wellnessDays);

    // ── AthleteEngine → acwr, trainingBalance, recentLoadChangePct, weeklyLoad ──
    var engine = buildEngineFields(opts);

    return {
      fitness:              wellness.fitness,
      fitnessTrend:         wellness.fitnessTrend,
      fatigue:              wellness.fatigue,
      form:                 wellness.form,
      formZone:             wellness.formZone,
      acwr:                 engine.acwr,
      trainingBalance:      engine.trainingBalance,
      recentLoadChangePct:  engine.recentLoadChangePct,
      weeklyLoad:           engine.weeklyLoad,
      trendWindowDays:      42,
      source:               buildSourceTag(wellness, engine)
    };
  }

  /* ── Provider wellness fields ─────────────────────────────────────── */

  function buildWellnessFields(days) {
    var result = {
      fitness: null,
      fitnessTrend: null,
      fatigue: null,
      form: null,
      formZone: null,
      hasWellness: false
    };

    if (!Array.isArray(days) || days.length === 0) return result;

    // Days are sorted chronologically (oldest first) by providerTrends.js.
    // Find the latest day with non-null fitness.
    var latest = findLatestWithField(days, "fitness");
    if (!latest) return result;

    result.fitness = latest.fitness;
    result.fatigue = latest.fatigue != null ? latest.fatigue : null;
    result.form = latest.form != null ? latest.form : null;
    result.hasWellness = true;

    // formZone — reuse the canonical classifyForm from trendsAnalytics.js
    if (result.form != null) {
      var TrendsAnalytics = root.AthlevoTrendsAnalytics;
      if (TrendsAnalytics && typeof TrendsAnalytics.classifyForm === "function") {
        var zone = TrendsAnalytics.classifyForm(result.form);
        result.formZone = zone ? zone.key : null;
      }
    }

    // fitnessTrend — compare latest fitness to ~7 days earlier
    // Same logic as fitnessInterpretation() but returns a direction label.
    result.fitnessTrend = computeFitnessTrend(days, latest);

    return result;
  }

  /**
   * Find the most recent day in the array that has a non-null value for
   * the given field. Days are sorted oldest-first.
   */
  function findLatestWithField(days, field) {
    for (var i = days.length - 1; i >= 0; i--) {
      if (days[i][field] != null) return days[i];
    }
    return null;
  }

  /**
   * Compute fitness trend direction by comparing latest fitness to the
   * value ~7 days earlier. Uses the same approach as
   * trendsAnalytics.js fitnessInterpretation().
   *
   * Returns "increasing" | "stable" | "decreasing" | null.
   */
  function computeFitnessTrend(days, latest) {
    if (!latest || latest.fitness == null) return null;

    // Find the latest day's index
    var latestIdx = days.lastIndexOf(latest);
    if (latestIdx < 0) return null;

    // Look for the value at or before 7 days ago
    var latestDate = new Date(latest.date + "T00:00:00Z");
    var targetDate = new Date(latestDate.getTime() - 7 * 86400000);
    var targetKey = targetDate.toISOString().slice(0, 10);

    var priorFitness = null;
    for (var i = latestIdx; i >= 0; i--) {
      if (days[i].date <= targetKey && days[i].fitness != null) {
        priorFitness = days[i].fitness;
        break;
      }
    }

    if (priorFitness == null) return null;

    var delta = latest.fitness - priorFitness;
    // Threshold: ±1 CTL point over 7 days = stable
    if (delta > 1) return "increasing";
    if (delta < -1) return "decreasing";
    return "stable";
  }

  /* ── AthleteEngine fields ─────────────────────────────────────────── */

  function buildEngineFields(opts) {
    var result = {
      acwr: null,
      trainingBalance: null,
      recentLoadChangePct: null,
      weeklyLoad: 0,
      hasEngine: false
    };

    var AE = root.AthleteEngine;
    if (!AE || typeof AE.computeAthleteMetrics !== "function") return result;

    try {
      var metrics = AE.computeAthleteMetrics({
        activities: opts.activities || [],
        executions: opts.executions || [],
        races: opts.races || [],
        profile: opts.profile || null
      });

      if (metrics && metrics.detail) {
        result.acwr = metrics.detail.acwr;
        result.trainingBalance = metrics.detail.trainingBalance;
        result.recentLoadChangePct = metrics.detail.recoveryTrendPct;
        result.hasEngine = true;
      }
      if (metrics && metrics.snapshot) {
        result.weeklyLoad = metrics.snapshot.weekly_training_load || 0;
      }
    } catch (e) {
      // Non-fatal — Coach continues without engine fields
      console.warn("[trainingState] AthleteEngine error:", e);
    }

    return result;
  }

  /* ── Source tag ────────────────────────────────────────────────────── */

  function buildSourceTag(wellness, engine) {
    var parts = [];
    if (wellness.hasWellness) parts.push("intervals_wellness");
    if (engine.hasEngine) parts.push("athlete_engine");
    return parts.length > 0 ? parts.join("+") : "none";
  }

  /* ── Public API ───────────────────────────────────────────────────── */

  root.AthlevoTrainingState = {
    buildTrainingState:  buildTrainingState,
    getTrainingState:    getTrainingState,
    invalidateCache:     invalidateCache
  };
})(window);
