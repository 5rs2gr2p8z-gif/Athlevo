/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Automatic Race Detection
 * ══════════════════════════════════════════════════════════════════════
 *
 *  After activities are imported, Athlevo scans them for efforts that
 *  LOOK like a race and proposes the strongest unconfirmed candidate:
 *
 *      "This activity looks like a race."
 *      ○ Official Race   ○ Time Trial   ○ Hard Workout   ○ Not a Race
 *
 *  Detection is deterministic and never changes fitness on its own — it
 *  only PROPOSES. Fitness updates exclusively after the athlete confirms
 *  (Official Race / Time Trial), which writes a race_results row; the
 *  athlete model then recomputes Current Running Level, paces and the
 *  Athlevo Score, and the next generated plan adapts to the new fitness.
 *
 *  A "Hard Workout" or "Not a Race" answer is also stored (as a race_type
 *  the engine ignores) so the same activity is never proposed again.
 *
 *  Separation: the SCORING below is pure and unit-tested; the DOM/DB glue
 *  is kept beneath it. Does not modify readiness, workout analysis, coach,
 *  auth, onboarding, subscriptions, navigation, or legal.
 */

(function () {
  "use strict";

  const DAY = 86400000;
  const PROPOSE_WINDOW_DAYS = 45;   // only propose reasonably recent efforts
  const CONFIDENCE_THRESHOLD = 60;  // below this we stay quiet

  /* ─────────────────────── pure scoring engine ────────────────────── */

  const RACE_KEYWORDS =
    /\b(race|marathon|half|10k|5k|parkrun|championship|grand\s*prix|time\s*trial|\btt\b|\bpr\b|\bpb\b|record|10000m|5000m|10 ?miler|fun run|classic|open)\b/i;

  const CLASSIC_DISTANCES = [1609.34, 5000, 10000, 15000, 21097.5, 42195];

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function isRunActivity(activity) {
    const t = String(
      activity?.activity_type || activity?.sport_type || ""
    ).toLowerCase();
    return /run|jog|tempo|interval|threshold|long/.test(t);
  }

  function nearClassicDistance(meters) {
    return CLASSIC_DISTANCES.some(
      d => Math.abs(meters - d) / d <= 0.03
    );
  }

  /*
   * Scores one activity as a possible race. Pure: all context (the
   * athlete's baseline fitness, HR ceiling, and fastest-by-distance
   * history) is passed in. Returns { confidence 0–100, reasons[] }.
   */
  function scoreActivity(activity, ctx) {
    ctx = ctx || {};
    const P = window.AthlevoPerformance;
    const reasons = [];
    let confidence = 0;

    const meters = num(activity.distance_meters);
    const seconds = num(activity.moving_time_seconds);

    // Title keywords — the strongest single signal.
    if (RACE_KEYWORDS.test(String(activity.name || ""))) {
      confidence += 45;
      reasons.push("race keyword in the title");
    }

    // A classic race distance.
    if (meters && nearClassicDistance(meters)) {
      confidence += 20;
      reasons.push("classic race distance");
    }

    // Exceptional pace vs. the athlete's baseline fitness.
    if (P && meters && meters >= 3000 && seconds) {
      const vdot = P.vdotFromRace(meters, seconds);
      if (vdot != null && ctx.baselineVdot != null) {
        const delta = vdot - ctx.baselineVdot;
        if (delta >= 4) {
          confidence += 35;
          reasons.push("exceptional sustained pace");
        } else if (delta >= 2) {
          confidence += 18;
          reasons.push("faster than usual");
        }
      }
    }

    // Near-maximal heart rate for this athlete.
    const hr = num(activity.average_heartrate);
    if (hr && ctx.hrCeiling && hr >= ctx.hrCeiling * 0.92) {
      confidence += 18;
      reasons.push("near-max heart rate");
    }

    // A personal best over this distance bucket.
    if (ctx.isFastestAtDistance === true) {
      confidence += 15;
      reasons.push("fastest at this distance");
    }

    return { confidence: Math.min(100, confidence), reasons };
  }

  // Rounds a distance to a coarse bucket so "fastest at this distance"
  // compares like with like (5k vs 5k, not 5k vs 21k).
  function distanceBucket(meters) {
    if (!meters) return null;
    return Math.round(meters / 1000);
  }

  /*
   * Evaluates a list of activities and returns scored candidates
   * (highest confidence first), excluding any activity id already
   * recorded in race_results. Pure given its inputs.
   */
  function detectRaceCandidates(activities, ctx) {
    ctx = ctx || {};
    const exclude = ctx.excludeActivityIds || new Set();
    const P = window.AthlevoPerformance;

    const runs = (activities || []).filter(
      a =>
        a &&
        isRunActivity(a) &&
        num(a.distance_meters) &&
        num(a.moving_time_seconds)
    );

    // Baseline VDOT: median of recent runs, so "exceptional" is relative
    // to THIS athlete rather than an absolute cutoff.
    let baselineVdot = ctx.baselineVdot ?? null;
    if (baselineVdot == null && P) {
      const vdots = runs
        .filter(a => (Date.now() - Date.parse(a.start_date)) / DAY <= 120)
        .map(a => P.vdotFromRace(a.distance_meters, a.moving_time_seconds))
        .filter(v => v != null)
        .sort((x, y) => x - y);
      if (vdots.length) baselineVdot = vdots[Math.floor(vdots.length / 2)];
    }

    // HR ceiling: the athlete's highest recent average HR.
    let hrCeiling = ctx.hrCeiling ?? null;
    if (hrCeiling == null) {
      const hrs = runs.map(a => num(a.average_heartrate)).filter(Boolean);
      if (hrs.length) hrCeiling = Math.max(...hrs);
    }

    // Fastest pace per distance bucket, for PR detection.
    const fastestByBucket = new Map();
    for (const a of runs) {
      const bucket = distanceBucket(a.distance_meters);
      const pace = a.moving_time_seconds / (a.distance_meters / 1000);
      const cur = fastestByBucket.get(bucket);
      if (cur == null || pace < cur) fastestByBucket.set(bucket, pace);
    }

    const candidates = [];
    for (const a of runs) {
      if (a.id != null && exclude.has(String(a.id))) continue;
      if ((Date.now() - Date.parse(a.start_date)) / DAY > PROPOSE_WINDOW_DAYS) {
        continue;
      }

      const bucket = distanceBucket(a.distance_meters);
      const pace = a.moving_time_seconds / (a.distance_meters / 1000);
      const isFastest = fastestByBucket.get(bucket) === pace;

      const { confidence, reasons } = scoreActivity(a, {
        baselineVdot,
        hrCeiling,
        isFastestAtDistance: isFastest
      });

      if (confidence >= CONFIDENCE_THRESHOLD) {
        candidates.push({ activity: a, confidence, reasons });
      }
    }

    candidates.sort((x, y) => y.confidence - x.confidence);
    return candidates;
  }

  /* ─────────────────────────── DB glue ────────────────────────────── */

  async function loadConfirmedActivityIds(userId) {
    try {
      const { data } = await supabaseClient
        .from("race_results")
        .select("activity_id")
        .eq("user_id", userId);
      const set = new Set();
      (data || []).forEach(r => {
        if (r.activity_id != null) set.add(String(r.activity_id));
      });
      return set;
    } catch (error) {
      return new Set();
    }
  }

  const OPTION_TYPES = {
    official: "official",
    time_trial: "time_trial",
    hard_workout: "hard_workout",
    not_a_race: "not_a_race"
  };

  async function confirmCandidate(candidate, raceType) {
    const {
      data: { user }
    } = await supabaseClient.auth.getUser();
    if (!user) throw new Error("Not signed in.");

    const a = candidate.activity;
    const activityId = a.id != null ? String(a.id) : null;
    const row = {
      user_id: user.id,
      source: "strava",
      activity_id: activityId,
      race_type: raceType,
      distance_meters: num(a.distance_meters),
      duration_seconds: num(a.moving_time_seconds),
      race_date: a.start_date ? String(a.start_date).slice(0, 10) : null,
      detection_confidence: Math.round(candidate.confidence),
      updated_at: new Date().toISOString()
    };

    // The (user_id, activity_id) uniqueness is enforced by a PARTIAL index
    // (WHERE activity_id IS NOT NULL). Postgres cannot infer a partial index
    // for ON CONFLICT, so a plain upsert(onConflict:"user_id,activity_id")
    // throws — which is why every Save button appeared to "do nothing".
    // Do an explicit update-then-insert instead: idempotent, and it never
    // relies on conflict inference.
    if (activityId != null) {
      const { data: existing, error: selErr } = await supabaseClient
        .from("race_results")
        .update({
          source: row.source,
          race_type: row.race_type,
          distance_meters: row.distance_meters,
          duration_seconds: row.duration_seconds,
          race_date: row.race_date,
          detection_confidence: row.detection_confidence,
          updated_at: row.updated_at
        })
        .eq("user_id", user.id)
        .eq("activity_id", activityId)
        .select("id");
      if (selErr) throw selErr;
      if (existing && existing.length) return; // updated an existing row
    }

    const { error } = await supabaseClient
      .from("race_results")
      .insert(row);

    if (error) throw error;
  }

  /* ─────────────────────────── rendering ──────────────────────────── */

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatKm(meters) {
    const km = meters / 1000;
    return `${km.toFixed(km >= 10 ? 0 : 1)} km`;
  }

  function formatDuration(seconds) {
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
      : `${m}:${String(ss).padStart(2, "0")}`;
  }

  let inFlight = false;
  let currentCandidate = null;

  function renderPrompt(candidate) {
    const mount = document.getElementById("raceDetectCard");
    if (!mount) return;

    if (!candidate) {
      mount.innerHTML = "";
      currentCandidate = null;
      return;
    }

    currentCandidate = candidate;
    const a = candidate.activity;
    const summary = [
      formatKm(num(a.distance_meters)),
      formatDuration(num(a.moving_time_seconds))
    ].join(" · ");

    mount.innerHTML = `
      <div class="rdc">
        <span class="rdc-eyebrow">Looks like a race</span>
        <p class="rdc-title">This activity looks like a race.</p>
        <p class="rdc-summary">${escapeHtml(a.name || "Recent run")} · ${escapeHtml(summary)}</p>
        <p class="rdc-msg" id="rdcMsg"></p>
        <div class="rdc-options">
          <button class="rdc-opt primary" type="button" data-race="official">Official Race</button>
          <button class="rdc-opt" type="button" data-race="time_trial">Time Trial</button>
          <button class="rdc-opt" type="button" data-race="hard_workout">Hard Workout</button>
          <button class="rdc-opt subtle" type="button" data-race="not_a_race">Not a Race</button>
        </div>
      </div>`;

    mount.querySelectorAll("[data-race]").forEach(btn => {
      btn.addEventListener("click", () => onChoose(btn.dataset.race, mount));
    });
  }

  async function onChoose(choice, mount) {
    if (inFlight || !currentCandidate) return;
    const raceType = OPTION_TYPES[choice];
    if (!raceType) return;

    inFlight = true;
    const msg = mount.querySelector("#rdcMsg");
    mount.querySelectorAll("[data-race]").forEach(b => (b.disabled = true));

    try {
      await confirmCandidate(currentCandidate, raceType);

      const willUpdateFitness =
        raceType === "official" || raceType === "time_trial";

      // Recompute fitness ONLY now that the athlete confirmed, then refresh
      // the Athlevo Score (v1) and Trends so the new race flows through.
      if (willUpdateFitness) {
        if (window.AthleteModel) await window.AthleteModel.refresh();
        if (typeof window.renderAthlevoScoreCard === "function") {
          await window.renderAthlevoScoreCard();
        }
        if (typeof window.refreshTrends === "function") {
          window.refreshTrends();
        }
      }

      if (typeof toast === "function") {
        toast(
          willUpdateFitness ? "Fitness updated." : "Got it — noted."
        );
      }

      // Show the next candidate (if any) or clear.
      await run();
    } catch (error) {
      console.error("Race confirmation failed:", error);
      if (msg) msg.textContent = "Couldn't save that — please try again.";
      mount.querySelectorAll("[data-race]").forEach(b => (b.disabled = false));
    } finally {
      inFlight = false;
    }
  }

  /*
   * Public entry: scan activities and, if a strong unconfirmed candidate
   * exists, show the prompt. Safe to call after every import/refresh.
   */
  async function run() {
    const mount = document.getElementById("raceDetectCard");
    if (!mount) return;

    try {
      const {
        data: { user }
      } = await supabaseClient.auth.getUser();
      if (!user) {
        renderPrompt(null);
        return;
      }

      const [activities, excludeActivityIds] = await Promise.all([
        window.AthlevoBrain &&
        typeof window.AthlevoBrain.loadAthleteActivities === "function"
          ? window.AthlevoBrain.loadAthleteActivities(200)
          : [],
        loadConfirmedActivityIds(user.id)
      ]);

      const candidates = detectRaceCandidates(activities, {
        excludeActivityIds
      });

      renderPrompt(candidates[0] || null);
    } catch (error) {
      console.error("Race detection failed:", error);
      renderPrompt(null);
    }
  }

  window.AthlevoRaceDetection = {
    run,
    // exposed for unit testing
    scoreActivity,
    detectRaceCandidates
  };
  window.runRaceDetection = run;
})();
