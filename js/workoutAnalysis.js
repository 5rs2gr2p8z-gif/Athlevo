/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Latest Workout Analysis  (proactive coaching loop)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  This is NOT another AI feature. It is a deterministic, rule-based
 *  engine that closes the coaching loop: after any workout is performed
 *  (logged manually, or imported from Strava / — in future — Garmin,
 *  COROS, Apple Health, WHOOP), Athlevo automatically:
 *
 *    1. RECOGNISES the workout   — matches the activity to today's
 *       planned session and, when it clearly happened, auto-marks it
 *       Completed / Modified without the athlete pressing anything.
 *    2. ANALYSES the workout     — compares what was planned vs. what
 *       was actually done (type, duration, intensity, objective — not
 *       just distance) and rates the execution.
 *    3. COACHES from it          — writes a short coach insight, a
 *       recovery focus, and a training-impact note.
 *    4. REFRESHES the Today page — the "Latest Workout Analysis" card
 *       updates in place, no page reload.
 *
 *  Everything below is a single reusable analysis engine fed by a
 *  normalised "performed workout" shape, so any activity source plugs in
 *  the same way. No new API endpoint, no LLM call, no new table:
 *    · reads     /api/training/get-week   (plan + matched_activity + execution)
 *    · reads     window.getReadinessForCoach()   (recovery context)
 *    · reads     AthlevoBrain.loadAthleteActivities()  (unplanned fallback)
 *    · writes    /api/training/get-week [POST]  (only to auto-complete
 *                a matched TODAY session that has no execution yet)
 *
 *  DOES NOT touch: authentication, conversation memory, the readiness
 *  engine, subscriptions, coach chat, navigation, or legal pages.
 */

(function () {
  "use strict";

  /* ───────────────────────── tuning constants ─────────────────────── */

  // How far back a performed workout can be and still be "latest".
  const LOOKBACK_DAYS = 4;

  // Deviation tolerances for the execution rating (vs. the plan).
  const DURATION_ON_TARGET = 0.15;   // ±15% duration = on target
  const DURATION_HARDER = 0.15;      // >15% longer   = harder
  const DURATION_SHORTFALL = 0.60;   // <60% of plan  = significantly short
  const DISTANCE_ON_TARGET = 0.15;
  const RPE_ON_TARGET = 1;           // ±1 RPE        = on target
  const RPE_HARDER = 2;              // ≥+2 RPE       = harder than planned

  const REST_TYPES = new Set([
    "rest", "rest_day", "restday", "off", "day_off"
  ]);

  /* ───────────────────────── small utilities ──────────────────────── */

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function clean(text) {
    return typeof text === "string" ? text.trim() : "";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Today's date in the athlete's training timezone (Asia/Manila), as a
  // YYYY-MM-DD key that matches session.session_date.
  function manilaTodayKey() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
    } catch (error) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  // Best-effort epoch (ms) for ordering "when was this performed".
  function performedMillis(dateLike) {
    if (!dateLike) return 0;
    const t = Date.parse(dateLike);
    return Number.isFinite(t) ? t : 0;
  }

  function daysBetweenKeys(aKey, bKey) {
    const a = Date.parse(aKey + "T00:00:00Z");
    const b = Date.parse(bKey + "T00:00:00Z");
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
    return Math.round((b - a) / 86400000);
  }

  function isRestSession(session) {
    const raw = clean(session?.session_type)
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    return REST_TYPES.has(raw);
  }

  /* ─────────────────────── formatting helpers ─────────────────────── */

  function fmtDuration(minutes) {
    const m = num(minutes);
    if (m == null || m <= 0) return null;
    const total = Math.round(m);
    const h = Math.floor(total / 60);
    const r = total - h * 60;
    if (h > 0) return r > 0 ? `${h}h ${r}m` : `${h}h`;
    return `${r}m`;
  }

  function fmtDistance(km) {
    const k = num(km);
    if (k == null || k <= 0) return null;
    return `${k.toFixed(k >= 10 ? 0 : 1)} km`;
  }

  // Compute pace (min/km) from distance + duration, guarding the classic
  // "5:60/km" rounding bug by rounding total seconds first.
  function paceFromDistanceDuration(km, minutes) {
    const k = num(km);
    const m = num(minutes);
    if (k == null || m == null || k <= 0 || m <= 0) return null;
    const secPerKm = Math.round((m * 60) / k);
    const mm = Math.floor(secPerKm / 60);
    const ss = secPerKm - mm * 60;
    return `${mm}:${String(ss).padStart(2, "0")}/km`;
  }

  function fmtPace(paceString, km, minutes) {
    const direct = clean(paceString);
    if (direct) {
      // Normalise "5:30 /km" → "5:30/km"; leave others intact.
      return direct.replace(/\s*\/\s*km\s*$/i, "/km");
    }
    return paceFromDistanceDuration(km, minutes);
  }

  function fmtHr(bpm) {
    const b = num(bpm);
    if (b == null || b <= 0) return null;
    return `${Math.round(b)} bpm`;
  }

  function titleCaseType(type) {
    const t = clean(type).replace(/[_-]+/g, " ").toLowerCase();
    if (!t) return "";
    return t.replace(/\b\w/g, c => c.toUpperCase());
  }

  /* ══════════════════════════════════════════════════════════════════
   *  NORMALISERS  —  every source becomes the same "performed" shape.
   *  { source, name, type, dateKey, when, durationMin, distanceKm,
   *    pace, hr, rpe, feeling, painPresent, status, planned,
   *    activityId, sessionId }
   * ══════════════════════════════════════════════════════════════════ */

  // A planned session that was executed (has an execution record and/or a
  // matched imported activity). Carries BOTH planned and actual numbers so
  // the engine can compare them.
  function normaliseFromSession(session) {
    const record = session.execution || null;
    const matched = session.matched_activity || null;
    if (!record && !matched) return null;
    if (record && record.status === "skipped") {
      // Skipped is a recognised outcome but not a "performed workout".
      return { skipped: true, session };
    }

    const durationMin =
      num(record?.actual_duration_minutes) ??
      num(matched?.actual_duration_minutes);
    const distanceKm =
      num(record?.actual_distance_km) ??
      num(matched?.actual_distance_km);

    const planned = {
      type: clean(session.session_type),
      durationMin: num(session.duration_minutes),
      distanceKm: num(session.distance_km),
      targetRpe: num(session.target_rpe),
      purpose: clean(session.purpose) || clean(session.description)
    };

    return {
      source: matched ? "import" : "manual",
      name:
        clean(session.title) ||
        titleCaseType(session.session_type) ||
        "Workout",
      type: clean(session.session_type),
      dateKey: clean(session.session_date),
      when:
        performedMillis(record?.completed_at) ||
        performedMillis(matched?.start_date) ||
        performedMillis(session.session_date),
      durationMin,
      distanceKm,
      pace: fmtPace(
        record?.actual_average_pace || matched?.average_pace,
        distanceKm,
        durationMin
      ),
      hr: num(record?.actual_average_hr) ?? num(matched?.average_heartrate),
      rpe: num(record?.actual_rpe),
      feeling: clean(record?.overall_feeling),
      painPresent: record?.pain_present === true,
      status: record?.status || "completed",
      asPrescribed: record?.as_prescribed !== false,
      planned,
      activityId: matched?.id || null,
      sessionId: session.id || null
    };
  }

  // A raw imported activity with no matching planned session — the
  // athlete trained "off plan". No plan to compare against.
  function normaliseFromActivity(activity) {
    const distanceKm =
      activity.distance_meters != null
        ? num(activity.distance_meters) / 1000
        : null;
    const durationMin =
      activity.moving_time_seconds != null
        ? num(activity.moving_time_seconds) / 60
        : null;
    const startKey = clean(activity.start_date).slice(0, 10);

    return {
      source: clean(activity.source) || "import",
      name:
        clean(activity.name) ||
        titleCaseType(activity.activity_type || activity.sport_type) ||
        "Activity",
      type: clean(activity.activity_type || activity.sport_type),
      dateKey: startKey,
      when: performedMillis(activity.start_date),
      durationMin,
      distanceKm,
      pace: paceFromDistanceDuration(distanceKm, durationMin),
      hr: num(activity.average_heartrate),
      rpe: null,
      feeling: "",
      painPresent: false,
      status: "unplanned",
      asPrescribed: true,
      planned: null,
      activityId: activity.id || null,
      sessionId: null
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   *  EXECUTION RATING ENGINE  —  compares planned vs. actual across
   *  type, duration, intensity and objective (not distance alone).
   *  Returns one of: excellent | harder | different | unplanned.
   * ══════════════════════════════════════════════════════════════════ */

  function rateExecution(perf) {
    // No plan to compare against → simply an unplanned/extra session.
    if (!perf.planned) {
      return { key: "unplanned", label: "Unplanned session", icon: "🟢" };
    }

    // The athlete (or auto-recognition) already flagged it modified, or
    // said it wasn't as prescribed → treat as a real deviation.
    const flaggedModified =
      perf.status === "modified" || perf.asPrescribed === false;

    const p = perf.planned;
    const durRatio =
      p.durationMin && perf.durationMin
        ? perf.durationMin / p.durationMin
        : null;
    const distRatio =
      p.distanceKm && perf.distanceKm
        ? perf.distanceKm / p.distanceKm
        : null;
    const rpeDelta =
      p.targetRpe && perf.rpe ? perf.rpe - p.targetRpe : null;

    // ── Significantly different (🔴) ──
    const bigShort =
      (durRatio != null && durRatio < DURATION_SHORTFALL) ||
      (distRatio != null && distRatio < DURATION_SHORTFALL);
    const bigLong =
      (durRatio != null && durRatio > 1.5) ||
      (distRatio != null && distRatio > 1.5);
    if (flaggedModified || bigShort || bigLong || perf.painPresent) {
      return {
        key: "different",
        label: "Significantly different",
        icon: "🔴"
      };
    }

    // ── Slightly harder than planned (🟡) ──
    const ranLonger =
      durRatio != null && durRatio > 1 + DURATION_HARDER;
    const ranFurther =
      distRatio != null && distRatio > 1 + DISTANCE_ON_TARGET;
    const feltHarder = rpeDelta != null && rpeDelta >= RPE_HARDER;
    if (ranLonger || ranFurther || feltHarder) {
      return {
        key: "harder",
        label: "Slightly harder than planned",
        icon: "🟡"
      };
    }

    // ── Excellent execution (✅) ──
    return { key: "excellent", label: "Excellent execution", icon: "✅" };
  }

  /* ─────────────────── coach insight (2–3 sentences) ──────────────── */

  function buildInsight(perf, rating) {
    const what = perf.name;
    const dur = fmtDuration(perf.durationMin);
    const dist = fmtDistance(perf.distanceKm);
    const did = [dist, dur].filter(Boolean).join(" in ");

    switch (rating.key) {
      case "excellent":
        return (
          `You executed ${escapeHtml(what)} right on target` +
          (did ? ` — ${escapeHtml(did)}.` : ".") +
          ` That's exactly the kind of controlled session that builds` +
          ` durable fitness. Keep stacking clean days like this.`
        );
      case "harder":
        return (
          `You pushed ${escapeHtml(what)} harder than prescribed` +
          (did ? ` (${escapeHtml(did)}).` : ".") +
          ` A little extra now and then is fine, but the plan's easy days` +
          ` are what let the hard days count — bank the fitness and stay` +
          ` disciplined on the next easy one.`
        );
      case "different":
        return (
          `This session ended up quite different from the plan` +
          (did ? ` (${escapeHtml(did)}).` : ".") +
          (perf.painPresent
            ? ` You also flagged some discomfort, so we'll respect that.`
            : ` That's completely normal — life and legs don't always` +
              ` cooperate.`) +
          ` Athlevo has logged it and will keep your week coherent.`
        );
      default: // unplanned
        return (
          `You logged ${escapeHtml(what)}` +
          (did ? ` — ${escapeHtml(did)}.` : ".") +
          ` This wasn't on today's plan, so it counts as bonus work.` +
          ` Athlevo has it on record and will factor it into your load.`
        );
    }
  }

  /* ─────────────────── recovery focus (2–3 items) ─────────────────── */

  function buildRecovery(perf, rating, readiness) {
    const items = [];
    const long = num(perf.durationMin) != null && perf.durationMin >= 75;
    const hard =
      rating.key === "harder" ||
      (num(perf.rpe) != null && perf.rpe >= 7);
    const lowReadiness =
      readiness &&
      num(readiness.readinessScore) != null &&
      readiness.readinessScore < 55;

    if (perf.painPresent) {
      items.push(
        "Gentle mobility around the sore area — no loaded stretching; " +
        "if pain persists tomorrow, back off."
      );
    }

    if (long || hard) {
      items.push(
        "Refuel with protein and carbohydrate within the next hour to " +
        "kick-start repair."
      );
      items.push(
        "Rehydrate steadily — aim for pale-yellow urine before your next " +
        "session."
      );
    } else {
      items.push(
        "Rehydrate and eat a balanced meal — nothing special needed after " +
        "an easy day."
      );
    }

    if (lowReadiness || long || hard) {
      items.push(
        "Protect sleep tonight — 8+ hours is where most of this session's " +
        "adaptation happens."
      );
    }

    if (!perf.painPresent && !long && !hard && !lowReadiness) {
      items.push("Light mobility or a short walk to keep the legs loose.");
    }

    // Cap at three, keep the most relevant (pain/fuel first).
    return items.slice(0, 3);
  }

  /* ─────────────────── training impact (advisory) ─────────────────── */

  function buildImpact(perf, rating, readiness) {
    const lowReadiness =
      readiness &&
      num(readiness.readinessScore) != null &&
      readiness.readinessScore < 55;

    if (rating.key === "excellent" && !lowReadiness) {
      return "Tomorrow's workout remains unchanged — you're on track.";
    }
    if (rating.key === "harder" || lowReadiness) {
      return (
        "Consider easing into tomorrow — if it's a quality session, keep " +
        "the warm-up long and don't chase pace. Athlevo will watch how " +
        "you recover."
      );
    }
    if (rating.key === "different") {
      if (perf.painPresent) {
        return (
          "Athlevo is holding the rest of the week steady; if discomfort " +
          "lingers, log a readiness check and we'll adjust."
        );
      }
      return (
        "The rest of your week stays intact — no need to make up the " +
        "difference. Just pick up the plan tomorrow."
      );
    }
    // unplanned
    return (
      "Your planned week is unchanged. Athlevo counts this toward your " +
      "overall load so tomorrow's guidance already accounts for it."
    );
  }

  /* ══════════════════════════════════════════════════════════════════
   *  DATA LOADING
   * ══════════════════════════════════════════════════════════════════ */

  async function authToken() {
    try {
      const {
        data: { session }
      } = await supabaseClient.auth.getSession();
      return session ? session.access_token : null;
    } catch (error) {
      return null;
    }
  }

  async function fetchWeek(token) {
    const res = await fetch("/api/training/get-week", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return res.json();
  }

  /*
   * AUTOMATIC WORKOUT RECOGNITION / AUTO-COMPLETE
   * ---------------------------------------------
   * Conservative and idempotent. For TODAY's non-rest planned session
   * only: if an activity clearly matches it and there is NO execution
   * record yet, write one automatically so the athlete never has to press
   * "Complete". Never clobbers manual feedback (guarded on execution ===
   * null). Clear completion → Completed; partial → Modified.
   *
   * Returns true if it wrote a record (caller should re-fetch the week).
   */
  async function autoRecogniseToday(week, token) {
    if (!week || !week.hasPlan || !Array.isArray(week.sessions)) return false;

    const todayKey = manilaTodayKey();

    const target = week.sessions.find(
      s =>
        clean(s.session_date) === todayKey &&
        !isRestSession(s) &&
        !s.execution &&                 // never overwrite existing feedback
        s.matched_activity &&           // a same-day activity was matched
        s.matched_activity.id
    );

    if (!target) return false;

    const matched = target.matched_activity;
    const planDur = num(target.duration_minutes);
    const planDist = num(target.distance_km);
    const actDur = num(matched.actual_duration_minutes);
    const actDist = num(matched.actual_distance_km);

    // Decide completed vs. modified using whichever planned metric exists.
    let onTarget = true;
    if (planDur && actDur) {
      const r = actDur / planDur;
      if (r < 1 - DURATION_ON_TARGET || r > 1 + 0.5) onTarget = false;
    }
    if (onTarget && planDist && actDist) {
      const r = actDist / planDist;
      if (r < 1 - DISTANCE_ON_TARGET || r > 1 + 0.5) onTarget = false;
    }

    const body = {
      training_session_id: target.id,
      status: onTarget ? "completed" : "modified",
      imported_activity_id: matched.id,
      manual_activity_override: false,
      as_prescribed: onTarget
    };
    if (actDur) body.actual_duration_minutes = Math.round(actDur * 10) / 10;
    if (actDist) body.actual_distance_km = Math.round(actDist * 100) / 100;
    if (matched.average_pace) body.actual_average_pace = matched.average_pace;
    if (num(matched.average_heartrate)) {
      body.actual_average_hr = Math.round(num(matched.average_heartrate));
    }
    if (!onTarget) {
      body.athlete_notes =
        "Auto-recognised from your imported activity.";
    }

    try {
      const res = await fetch("/api/training/get-week", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      return res.ok;
    } catch (error) {
      console.warn("Auto-recognition could not save:", error);
      return false;
    }
  }

  /*
   * Pick the single most recent PERFORMED workout to analyse:
   *   1. planned sessions that were executed (matched/logged), OR
   *   2. an unplanned imported activity with no session,
   * whichever happened most recently within the lookback window.
   * Planned sessions win ties (they carry a richer comparison).
   */
  function pickLatestPerformed(week, activities) {
    const todayKey = manilaTodayKey();
    const candidates = [];

    if (week && week.hasPlan && Array.isArray(week.sessions)) {
      week.sessions.forEach(session => {
        const perf = normaliseFromSession(session);
        if (perf && !perf.skipped) {
          if (
            perf.dateKey &&
            daysBetweenKeys(perf.dateKey, todayKey) <= LOOKBACK_DAYS &&
            daysBetweenKeys(perf.dateKey, todayKey) >= 0
          ) {
            candidates.push(perf);
          }
        }
      });
    }

    // Session activity ids we've already represented, so an unplanned
    // fallback never double-counts the same import.
    const usedActivityIds = new Set(
      candidates.map(c => c.activityId).filter(Boolean).map(String)
    );

    if (!candidates.length && Array.isArray(activities)) {
      for (const activity of activities) {
        if (activity?.id && usedActivityIds.has(String(activity.id))) continue;
        const startKey = clean(activity.start_date).slice(0, 10);
        if (!startKey) continue;
        const age = daysBetweenKeys(startKey, todayKey);
        if (age < 0 || age > LOOKBACK_DAYS) continue;
        candidates.push(normaliseFromActivity(activity));
        break; // activities are newest-first; first in-window wins
      }
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      if (b.when !== a.when) return b.when - a.when;
      // tie → planned (has planned data) first
      return (b.planned ? 1 : 0) - (a.planned ? 1 : 0);
    });

    return candidates[0];
  }

  /* ══════════════════════════════════════════════════════════════════
   *  RENDERING
   * ══════════════════════════════════════════════════════════════════ */

  function metricBlock(label, value) {
    if (!value) return "";
    return (
      `<div class="lwa-metric"><b>${escapeHtml(value)}</b>` +
      `<small>${escapeHtml(label)}</small></div>`
    );
  }

  function renderCard(mount, perf, rating, insight, recovery, impact) {
    const metrics = [
      metricBlock("Distance", fmtDistance(perf.distanceKm)),
      metricBlock("Duration", fmtDuration(perf.durationMin)),
      metricBlock("Pace", perf.pace),
      metricBlock("Avg HR", fmtHr(perf.hr)),
      metricBlock("RPE", perf.rpe ? `${perf.rpe}/10` : null)
    ].filter(Boolean).join("");

    const recoveryList = recovery.length
      ? `<ul class="lwa-recovery">${recovery
          .map(item => `<li>${escapeHtml(item)}</li>`)
          .join("")}</ul>`
      : "";

    mount.innerHTML = `
      <div class="lwa">
        <div class="lwa-head">
          <span class="lwa-eyebrow">Latest workout analysis</span>
          <span class="lwa-status ${rating.key}">
            ${rating.icon} ${escapeHtml(rating.label)}
          </span>
        </div>

        <h3 class="lwa-title">${escapeHtml(perf.name)}</h3>

        ${metrics ? `<div class="lwa-metrics">${metrics}</div>` : ""}

        <div class="lwa-section">
          <div class="lwa-section-label">Coach insight</div>
          <p>${insight}</p>
        </div>

        ${
          recoveryList
            ? `<div class="lwa-section">
                 <div class="lwa-section-label">Recovery focus</div>
                 ${recoveryList}
               </div>`
            : ""
        }

        <div class="lwa-section">
          <div class="lwa-section-label">Training impact</div>
          <p>${escapeHtml(impact)}</p>
        </div>
      </div>
    `;
  }

  function renderEmpty(mount) {
    // No performed workout in range → hide the card entirely so the Today
    // page stays clean (the daily briefing sits directly below).
    mount.innerHTML = "";
  }

  /* ══════════════════════════════════════════════════════════════════
   *  PUBLIC ENTRY POINT  —  called from brain.js refreshAthleteUI()
   *  and after any manual save / Strava sync. Safe to call repeatedly.
   * ══════════════════════════════════════════════════════════════════ */

  let inFlight = false;

  async function renderLatestWorkoutAnalysis() {
    const mount = document.getElementById("latestWorkoutAnalysis");
    if (!mount) return;
    if (inFlight) return; // coalesce overlapping refreshes
    inFlight = true;

    try {
      const token = await authToken();
      if (!token) {
        renderEmpty(mount);
        return;
      }

      let week = await fetchWeek(token);

      // Auto-recognise & auto-complete today's matched session, then
      // re-read the week so the card reflects the freshly written record.
      if (await autoRecogniseToday(week, token)) {
        week = await fetchWeek(token);
      }

      // Unplanned fallback source (only queried if no planned match).
      let activities = [];
      try {
        if (
          window.AthlevoBrain &&
          typeof window.AthlevoBrain.loadAthleteActivities === "function"
        ) {
          activities = await window.AthlevoBrain.loadAthleteActivities(30);
        }
      } catch (error) {
        activities = [];
      }

      const perf = pickLatestPerformed(week, activities);
      if (!perf) {
        renderEmpty(mount);
        return;
      }

      // Recovery context (read-only; never mutates the readiness engine).
      let readiness = null;
      try {
        if (typeof window.getReadinessForCoach === "function") {
          readiness = await window.getReadinessForCoach();
        }
      } catch (error) {
        readiness = null;
      }

      const rating = rateExecution(perf);
      const insight = buildInsight(perf, rating);
      const recovery = buildRecovery(perf, rating, readiness);
      const impact = buildImpact(perf, rating, readiness);

      renderCard(mount, perf, rating, insight, recovery, impact);
    } catch (error) {
      console.error("Latest workout analysis failed:", error);
      renderEmpty(document.getElementById("latestWorkoutAnalysis"));
    } finally {
      inFlight = false;
    }
  }

  // Expose for refreshAthleteUI + post-save refreshers.
  window.renderLatestWorkoutAnalysis = renderLatestWorkoutAnalysis;

  // Expose the pure engine for unit testing / reuse by other sources.
  window.AthlevoWorkoutAnalysis = {
    rateExecution,
    buildInsight,
    buildRecovery,
    buildImpact,
    normaliseFromSession,
    normaliseFromActivity,
    pickLatestPerformed
  };
})();
