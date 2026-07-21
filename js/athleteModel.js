/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Athlete Model  (fitness data layer + Athlevo Score card)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The athlete model is the bridge between RAW stored inputs and the pure
 *  performance engine. It:
 *    1. loads raw inputs — confirmed race_results, imported activities,
 *       and the athlete profile;
 *    2. chooses the best fitness evidence (a confirmed race if there is
 *       one, otherwise an ESTIMATE from the athlete's best recent run);
 *    3. builds a normalised inputs bag and asks window.AthlevoPerformance
 *       to compute Current Running Level, training paces and the Athlevo
 *       Score — nothing derived is persisted;
 *    4. renders the Athlevo Score card and exposes a cached getFitness()
 *       plus a refresh() other modules call after a race is confirmed.
 *
 *  Separation of concerns (per the architecture brief):
 *    · calculations  → js/performance.js  (pure, no I/O)
 *    · athlete model → THIS FILE          (load raw inputs, derive)
 *    · UI            → renderScoreCard()   (below, reads the model)
 *    · race detection→ js/raceDetection.js (writes race_results)
 *
 *  Does NOT modify: readiness engine, workout analysis, coach, auth,
 *  onboarding, subscriptions, navigation, or legal.
 */

(function () {
  "use strict";

  const DAY = 86400000;

  /* ─────────────────────────── utilities ──────────────────────────── */

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function ageInDays(dateLike) {
    const t = Date.parse(dateLike);
    if (!Number.isFinite(t)) return Infinity;
    return (Date.now() - t) / DAY;
  }

  function isRunActivity(activity) {
    const t = String(
      activity?.activity_type || activity?.sport_type || ""
    ).toLowerCase();
    return /run|jog|tempo|interval|threshold|long/.test(t);
  }

  async function currentUser() {
    try {
      const {
        data: { user }
      } = await supabaseClient.auth.getUser();
      return user || null;
    } catch (error) {
      return null;
    }
  }

  /* ───────────────────────── raw input loading ─────────────────────── */

  async function loadRaceResults(userId) {
    try {
      const { data, error } = await supabaseClient
        .from("race_results")
        .select("*")
        .eq("user_id", userId)
        .order("race_date", { ascending: false });
      if (error) {
        console.warn("race_results load failed:", error.message);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (error) {
      // Table may not exist yet (migration not run) — degrade silently.
      return [];
    }
  }

  async function loadProfile(userId) {
    try {
      const { data } = await supabaseClient
        .from("profiles")
        .select(
          "weekly_distance, experience_years, available_days, training_days"
        )
        .eq("id", userId)
        .maybeSingle();
      return data || {};
    } catch (error) {
      return {};
    }
  }

  async function loadActivities() {
    try {
      if (
        window.AthlevoBrain &&
        typeof window.AthlevoBrain.loadAthleteActivities === "function"
      ) {
        return await window.AthlevoBrain.loadAthleteActivities("history");
      }
    } catch (error) {
      /* fall through */
    }
    return [];
  }

  /* ─────────────── choose the best fitness evidence ────────────────── */

  const FITNESS_ELIGIBLE = new Set([
    "official",
    "time_trial",
    "training_effort"
  ]);

  // Best confirmed race → { vdot, distanceKm, raceDate, source } or null.
  function bestRaceVdot(raceResults) {
    let best = null;
    const P = window.AthlevoPerformance;

    for (const r of raceResults || []) {
      if (!FITNESS_ELIGIBLE.has(r.race_type)) continue;
      // Recent enough to represent current fitness (≈ 12 months).
      if (r.race_date && ageInDays(r.race_date) > 400) continue;

      const vdot = P.vdotFromRace(r.distance_meters, r.duration_seconds);
      if (vdot == null) continue;

      if (!best || vdot > best.vdot) {
        best = {
          vdot,
          distanceKm: num(r.distance_meters) ? r.distance_meters / 1000 : null,
          raceDate: r.race_date || null,
          source: r.source || "race"
        };
      }
    }
    return best;
  }

  // No confirmed race → estimate from the athlete's best recent run.
  // Clearly flagged `estimated` so the UI can invite a real race for
  // accuracy. Uses whole-activity averages, so it is a soft proxy only.
  function estimateVdotFromActivities(activities) {
    const P = window.AthlevoPerformance;
    let best = null;

    for (const a of activities || []) {
      if (!isRunActivity(a)) continue;
      if (ageInDays(a.start_date) > 120) continue;
      const meters = num(a.distance_meters);
      const seconds = num(a.moving_time_seconds);
      if (!meters || meters < 3000 || !seconds) continue;

      const vdot = P.vdotFromRace(meters, seconds);
      if (vdot == null) continue;

      if (!best || vdot > best.vdot) {
        best = {
          vdot,
          distanceKm: meters / 1000,
          raceDate: a.start_date ? String(a.start_date).slice(0, 10) : null,
          source: "estimate"
        };
      }
    }
    return best;
  }

  /* ─────────────── training-load signals from activities ───────────── */

  function trainingSignals(activities) {
    const runsLast28 = [];
    let longRunKm = 0;

    for (const a of activities || []) {
      const age = ageInDays(a.start_date);
      const km = num(a.distance_meters) ? a.distance_meters / 1000 : 0;

      if (age <= 42 && km > longRunKm) longRunKm = km;
      if (age <= 28) runsLast28.push(km);
    }

    const weeklyDistanceKm = runsLast28.length
      ? runsLast28.reduce((s, k) => s + k, 0) / 4
      : null;
    const activitiesPerWeek = runsLast28.length
      ? runsLast28.length / 4
      : null;

    return {
      weeklyDistanceKm,
      activitiesPerWeek,
      longRunKm: longRunKm || null
    };
  }

  /* ───────────────────── build the fitness picture ─────────────────── */

  let cachedFitness = null;

  async function computeAthleteFitness() {
    const P = window.AthlevoPerformance;
    if (!P) return null;

    const user = await currentUser();
    if (!user) return null;

    const [raceResults, profile, activities] = await Promise.all([
      loadRaceResults(user.id),
      loadProfile(user.id),
      loadActivities()
    ]);

    // Confirmed race wins; otherwise a flagged estimate from recent runs.
    let evidence = bestRaceVdot(raceResults);
    let estimated = false;
    if (!evidence) {
      evidence = estimateVdotFromActivities(activities);
      estimated = Boolean(evidence);
    }

    const signals = trainingSignals(activities);

    // Athlete-reported volume is a fallback when activity history is thin.
    const weeklyDistanceKm =
      signals.weeklyDistanceKm != null
        ? signals.weeklyDistanceKm
        : num(profile.weekly_distance);

    const inputs = {
      vdot: evidence ? evidence.vdot : null,
      estimated,
      source: evidence ? evidence.source : null,
      raceDate: evidence ? evidence.raceDate : null,
      raceDistanceKm: evidence ? evidence.distanceKm : null,
      weeklyDistanceKm,
      experienceYears: num(profile.experience_years),
      longRunKm: signals.longRunKm,
      activitiesPerWeek: signals.activitiesPerWeek,
      availableDays:
        num(profile.available_days) ?? num(profile.training_days)
    };

    const fitness = P.computeFitness(inputs);
    fitness.inputs = inputs;
    fitness.hasConfirmedRace = raceResults.some(r =>
      FITNESS_ELIGIBLE.has(r.race_type)
    );
    cachedFitness = fitness;
    return fitness;
  }

  // Public: cached unless forced. Other modules read this.
  async function getFitness(force) {
    if (cachedFitness && !force) return cachedFitness;
    return computeAthleteFitness();
  }

  /* ═══════════════════════════ rendering ═══════════════════════════ */

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function subScoreBar(sub) {
    const has = sub.value != null;
    const pct = has ? Math.max(4, sub.value) : 0;
    return `
      <div class="asc-sub">
        <div class="asc-sub-top">
          <span class="asc-sub-label">${escapeHtml(sub.label)}</span>
          <span class="asc-sub-val">${has ? sub.value : "—"}</span>
        </div>
        <div class="asc-sub-track"><i style="width:${pct}%"></i></div>
      </div>
    `;
  }

  function pacesBlock(paces) {
    if (!paces) return "";
    const P = window.AthlevoPerformance;
    const rows = P.ZONE_ORDER.map(zone => {
      const p = paces[zone];
      if (!p || !p.pace) return "";
      return `
        <div class="asc-pace">
          <span class="asc-pace-zone">${escapeHtml(p.label)}</span>
          <span class="asc-pace-val">${escapeHtml(p.pace)}</span>
        </div>`;
    }).join("");

    return `
      <details class="asc-paces">
        <summary>Training paces</summary>
        <div class="asc-pace-grid">${rows}</div>
      </details>
    `;
  }

  function renderScoreCard(fitness) {
    const mount = document.getElementById("athlevoScoreCard");
    if (!mount) return;

    const score = fitness?.athlevoScore?.score ?? null;
    const level = fitness?.runningLevel?.level ?? null;

    // Nothing to show yet → subtle CTA, consistent with the minimal UI.
    if (score == null && level == null) {
      mount.innerHTML = `
        <div class="asc asc-empty">
          <span class="asc-eyebrow">Athlevo Score</span>
          <p class="asc-empty-copy">Log a recent race or import a few runs and
          Athlevo will calculate your athletic capability.</p>
        </div>`;
      return;
    }

    const subs = fitness.athlevoScore.subScores;
    const subOrder = window.AthlevoPerformance.SUB_SCORES.map(s => s.key);

    const levelLine =
      level != null
        ? `Current Running Level <b>${level}</b>${
            fitness.runningLevel.tier && fitness.runningLevel.tier !== "Unrated"
              ? ` · ${escapeHtml(fitness.runningLevel.tier)}`
              : ""
          }`
        : "Current Running Level building…";

    const estNote = fitness.estimated
      ? `<p class="asc-est">Estimated from your recent runs · confirm a race for precision</p>`
      : "";

    mount.innerHTML = `
      <div class="asc">
        <div class="asc-head">
          <span class="asc-eyebrow">Athlevo Score</span>
          <div class="asc-score">
            <span class="asc-score-num">${score != null ? score : "—"}</span>
            <span class="asc-score-max">/100</span>
          </div>
        </div>
        <p class="asc-level">${levelLine}</p>
        <div class="asc-subs">
          ${subOrder.map(k => subScoreBar(subs[k])).join("")}
        </div>
        ${pacesBlock(fitness.paces)}
        ${estNote}
      </div>`;
  }

  // Public: recompute the athlete's fitness from raw inputs and cache it.
  // The Athlevo Score card itself is now owned by js/athlevoScore.js (v1);
  // this only refreshes the shared fitness inputs (Current Running Level +
  // paces) that the score model and plan generation both consume.
  async function refresh() {
    try {
      return await computeAthleteFitness();
    } catch (error) {
      console.error("Athlete model refresh failed:", error);
      return null;
    }
  }

  /* ═══════════ Today "Your current training paces" card (V2) ═══════════
   *
   * Predicted paces moved out of the Athlevo Score detail into a dedicated
   * Today card, rendered from the SHARED pace service so Today and Train
   * agree. Reuses getFitness() — no new pace maths here.
   */
  const CONF_CLASS = { high: "strong", moderate: "dev", developing: "dev", insufficient: "lim" };

  async function renderTrainingPacesCard() {
    const mount = document.getElementById("trainingPacesCard");
    if (!mount || !window.AthlevoPaceService) return;
    try {
      const fitness = await getFitness();

      // Feed recent activities + today's readiness so Recovery/Easy/Long are
      // calibrated from real aerobic history and adjusted conservatively for
      // today's context (the SAME service Train and Coach use).
      let activities = [];
      try {
        if (window.AthlevoBrain && window.AthlevoBrain.loadAthleteActivities) {
          activities = await window.AthlevoBrain.loadAthleteActivities("history");
        }
      } catch (e) { activities = []; }

      let readinessScore = null;
      try {
        if (typeof window.getReadinessForCoach === "function") {
          const r = await window.getReadinessForCoach();
          readinessScore = r && r.readinessScore != null ? r.readinessScore : null;
        }
      } catch (e) { readinessScore = null; }

      const paces = window.AthlevoPaceService.getTrainingPaces(fitness || {}, {
        activities,
        daily: readinessScore != null ? { readinessScore } : {}
      });

      // One short coaching sentence per zone — pace range + a single line,
      // never a paragraph (reduces the pace card's visual density).
      const oneSentence = (text) => {
        const s = String(text || "").trim();
        if (!s) return "";
        const first = (s.match(/^[^.!?]*[.!?]?/) || [s])[0].trim();
        const out = first.length > 88 ? first.slice(0, 85).replace(/[,;:\s]+$/, "") + "…" : first;
        return out.replace(/[.!?]*$/, ".");
      };
      const rows = paces.zones.map(z => {
        const pace = z.paceRange ? z.paceRange.text : "By effort";
        const note = oneSentence(z.notes && z.notes.length ? z.notes[0] : z.explanation);
        return `
          <div class="tpc-zone">
            <div class="tpc-zone-head">
              <span class="tpc-zone-label">${escapeHtml(z.label)}</span>
              <span class="tpc-zone-pace">${escapeHtml(pace)}</span>
            </div>
            ${note ? `<p class="tpc-zone-note">${escapeHtml(note)}</p>` : ""}
          </div>`;
      }).join("");

      const confClass = CONF_CLASS[paces.confidence.code] || "lim";
      const aeroLine = paces.aerobicCalibrated
        ? escapeHtml(paces.aerobicReason)
        : escapeHtml(paces.updatedLine || paces.supporting);

      mount.innerHTML = `
        <div class="tpc">
          <div class="tpc-head">
            <div>
              <span class="tpc-eyebrow">${escapeHtml(paces.header)}</span>
              <p class="tpc-support">${aeroLine}</p>
            </div>
            <span class="tpc-conf ${confClass}">${escapeHtml(paces.confidence.label)}</span>
          </div>
          <div class="tpc-zones">${rows}</div>
        </div>`;
    } catch (error) {
      console.warn("Training paces card failed:", error && error.message);
      mount.innerHTML = "";
    }
  }

  window.AthleteModel = {
    getFitness,
    refresh,
    computeAthleteFitness,
    renderScoreCard,
    renderTrainingPacesCard
  };
  window.renderTrainingPacesCard = renderTrainingPacesCard;
})();
