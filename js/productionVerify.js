/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Production Verification (READ-ONLY diagnostics)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Answers "did the Intervals.icu import actually land correctly?" against
 *  REAL production data, using the REAL engines.
 *
 *  Rules this file obeys, strictly:
 *    · It NEVER writes. No inserts, no updates, no deletes. The one helper
 *      that triggers a write (checkIdempotency) calls the ordinary sync
 *      endpoint and is opt-in.
 *    · It NEVER changes a production calculation. It calls the same
 *      classifier, the same Trends merge and the same Score engine the app
 *      uses. If a number here looks wrong, the number IS wrong — this file
 *      must not be edited to make it look right.
 *    · It reads activities DIRECTLY, bypassing loadAthleteActivities()'s
 *      200-row cap, because a truncated set would silently misreport totals.
 *
 *  Console:  await AthlevoVerify.run()
 */

(function (root) {
  "use strict";

  const DAY = 86400000;
  const sb = () => (typeof supabaseClient !== "undefined" ? supabaseClient : null);

  const km = (m) => Math.round((Number(m) || 0) / 100) / 10;
  const isRun = (a) => /run/i.test(String(a.sport_type || a.activity_type || ""));

  /* ── raw read, uncapped ──────────────────────────────────────────── */

  /*
   * Pages through every activity row for this athlete. The production loader
   * takes only the newest 200; for a 180-day audit across two providers that
   * can truncate, so verification must see everything.
   */
  async function loadAllActivities() {
    const { data: { user } } = await sb().auth.getUser();
    if (!user) throw new Error("Not signed in.");
    /*
     * SCHEMA CONTRACT — every column here is one the production loader in
     * js/brain.js already selects successfully, plus `updated_at` (written by
     * toActivityRow on every import). The `activities` table has NO
     * `created_at`; an earlier version of this file assumed one and failed
     * with Postgres 42703. Activity chronology comes from `start_date`, and
     * import time from raw_data.normalized.importedAt — never from a
     * row-creation timestamp that does not exist.
     */
    const cols = `id,user_id,source,external_activity_id,name,sport_type,activity_type,
      distance_meters,moving_time_seconds,elapsed_time_seconds,elevation_gain_meters,
      average_speed_mps,max_speed_mps,average_heartrate,max_heartrate,average_cadence,
      start_date,timezone,trainer,commute,updated_at,raw_data`.replace(/\s+/g, "");

    const all = [];
    const PAGE = 500;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb()
        .from("activities").select(cols)
        .eq("user_id", user.id)
        .order("start_date", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return { user, rows: all };
  }

  const isSuperseded = (r) => Boolean(r.raw_data && r.raw_data.superseded === true);
  const laps = (r) => (r.raw_data && Array.isArray(r.raw_data.laps)) ? r.raw_data.laps : null;

  /*
   * When was this row imported? The table has no row-creation column, so the
   * authoritative source is the normalizer's own stamp, written into raw_data
   * by toActivityRow for every provider. `updated_at` is only a fallback and
   * a poor one — it is rewritten by the lap backfill and by duplicate
   * marking, so it drifts away from true import time.
   */
  const importedAt = (r) => {
    const n = r.raw_data && r.raw_data.normalized;
    return (n && n.importedAt) || r.updated_at || null;
  };

  // Activity chronology is ALWAYS start_date — when the workout happened.
  const startMs = (r) => Date.parse(r.start_date);

  /* ── duplicate detection (mirrors the server rules exactly) ──────── */

  function upstreamStravaId(r) {
    if (r.source === "strava") return String(r.external_activity_id);
    const rd = r.raw_data || {};
    if (String(rd.upstream_source || "").toLowerCase() === "strava" && rd.upstream_id) {
      return String(rd.upstream_id);
    }
    return null;
  }

  function looksDuplicate(a, b) {
    if (a.source === b.source) return false;
    const ua = upstreamStravaId(a), ub = upstreamStravaId(b);
    if (ua && ub && ua === ub) return { reason: "upstream_id_match" };
    const sa = String(a.sport_type || "").toLowerCase();
    const sb_ = String(b.sport_type || "").toLowerCase();
    if (!sa || sa !== sb_) return false;
    const ta = startMs(a), tb = startMs(b);
    if (!isFinite(ta) || !isFinite(tb) || Math.abs(ta - tb) > 5 * 60000) return false;
    const near = (x, y, tol) => {
      x = Number(x); y = Number(y);
      if (!isFinite(x) || !isFinite(y) || x <= 0 || y <= 0) return false;
      return Math.abs(x - y) / Math.max(x, y) <= tol;
    };
    if (near(a.moving_time_seconds, b.moving_time_seconds, 0.05) &&
        near(a.distance_meters, b.distance_meters, 0.05)) {
      return { reason: "fingerprint_match" };
    }
    return false;
  }

  // Cross-provider pairs, whether or not either side is already flagged.
  function findDuplicatePairs(rows) {
    const byDay = new Map();
    rows.forEach(r => {
      const d = String(r.start_date || "").slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    });
    const pairs = [];
    // Same-day bucketing plus neighbours, so a midnight-boundary pair is
    // still compared.
    const days = [...byDay.keys()].sort();
    days.forEach((d, i) => {
      const bucket = byDay.get(d).concat(byDay.get(days[i + 1]) || []);
      for (let x = 0; x < bucket.length; x++) {
        for (let y = x + 1; y < bucket.length; y++) {
          const m = looksDuplicate(bucket[x], bucket[y]);
          if (m) pairs.push({ a: bucket[x], b: bucket[y], reason: m.reason });
        }
      }
    });
    // De-dupe the pair list itself (neighbour buckets overlap).
    const seen = new Set();
    return pairs.filter(p => {
      const k = [p.a.id, p.b.id].sort().join("|");
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  /* ── volume ─────────────────────────────────────────────────────── */

  function sumKm(rows, sinceMs) {
    const m = rows
      .filter(r => isRun(r) && (!sinceMs || startMs(r) >= sinceMs))
      .reduce((s, r) => s + (Number(r.distance_meters) || 0), 0);
    return Math.round(m / 100) / 10;
  }

  // Monday-start current week in the athlete's local timezone.
  function startOfWeek() {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    return d.getTime();
  }

  /* ── classification through the REAL engine ─────────────────────── */

  async function zones() {
    try {
      if (root.AthlevoPaceService && root.AthlevoPaceService.getZones) {
        return await root.AthlevoPaceService.getZones();
      }
    } catch (e) {}
    try {
      if (root.AthlevoAthleteModel && root.AthlevoAthleteModel.load) {
        const m = await root.AthlevoAthleteModel.load();
        return (m && m.zones) || null;
      }
    } catch (e) {}
    return null;
  }

  function classifyRow(r, z) {
    const W = root.AthlevoWorkoutClassifier;
    if (!W) return null;
    return W.classifyActivity({
      name: r.name,
      sport_type: r.sport_type || r.activity_type,
      distance_meters: r.distance_meters,
      moving_time_seconds: r.moving_time_seconds,
      elapsed_time_seconds: r.elapsed_time_seconds,
      average_heartrate: r.average_heartrate,
      max_heartrate: r.max_heartrate,
      max_speed_mps: r.max_speed_mps,
      laps: laps(r)
    }, { zones: z });
  }

  /* ══════════════════════════ main report ════════════════════════ */

  async function run() {
    if (!sb()) { console.error("Supabase client unavailable."); return null; }
    console.log("%cAthlevo — production verification (read-only)", "font-weight:bold;font-size:13px");

    const { rows } = await loadAllActivities();
    const z = await zones();
    const canonical = rows.filter(r => !isSuperseded(r));
    const superseded = rows.filter(isSuperseded);

    /* 1. counts by source */
    const bySource = {};
    rows.forEach(r => {
      const s = r.source || "unknown";
      bySource[s] = bySource[s] || { total: 0, canonical: 0, superseded: 0, runs: 0, withLaps: 0 };
      bySource[s].total++;
      isSuperseded(r) ? bySource[s].superseded++ : bySource[s].canonical++;
      if (isRun(r)) bySource[s].runs++;
      if (laps(r)) bySource[s].withLaps++;
    });

    /* 2. the 53-vs-58 question — where do the Intervals rows actually sit? */
    const iv = rows.filter(r => r.source === "intervals");
    const now = Date.now();
    const in180 = iv.filter(r => startMs(r) >= now - 180 * DAY);
    const outside180 = iv.filter(r => startMs(r) < now - 180 * DAY);
    const ivDates = iv.map(r => r.start_date).filter(Boolean).sort();
    const ivSports = {};
    iv.forEach(r => { const s = r.sport_type || "?"; ivSports[s] = (ivSports[s] || 0) + 1; });

    // Same-provider duplicate ids would be a real bug (unique index violation).
    const ivIds = iv.map(r => r.external_activity_id);
    const dupIds = ivIds.filter((v, i) => ivIds.indexOf(v) !== i);

    /* 3. dedup */
    const pairs = findDuplicatePairs(rows);
    const unresolved = pairs.filter(p => !isSuperseded(p.a) && !isSuperseded(p.b));
    const resolved = pairs.filter(p => isSuperseded(p.a) || isSuperseded(p.b));

    /* volume before/after dedup */
    const week = startOfWeek();
    const d180 = now - 180 * DAY;
    const vol = {
      week:  { raw: sumKm(rows, week), canonical: sumKm(canonical, week) },
      d180:  { raw: sumKm(rows, d180), canonical: sumKm(canonical, d180) },
      all:   { raw: sumKm(rows, null), canonical: sumKm(canonical, null) }
    };

    /* 6. classification over canonical runs */
    const classified = canonical.filter(isRun).map(r => ({ row: r, cls: classifyRow(r, z) }))
      .filter(x => x.cls);
    const known = classified.filter(x => x.cls.confidence === "high" || x.cls.confidence === "moderate");
    const thresholdSessions = known.filter(x => x.cls.intensity === "threshold");
    const highSessions = known.filter(x => x.cls.intensity === "high");
    const fromIntervals = (arr) => arr.filter(x => x.row.source === "intervals");

    const qualityKm = classified.reduce((acc, x) => {
      const q = x.cls.qualityKm || {};
      acc.threshold += Number(q.threshold) || 0;
      acc.high += Number(q.high) || 0;
      acc.easy += Number(q.easy) || 0;
      return acc;
    }, { threshold: 0, high: 0, easy: 0 });

    /* 7. Score gating */
    const scoreGate = {
      thresholdCount: thresholdSessions.length,
      speedCount: highSessions.length,
      thresholdComponentValid: thresholdSessions.length >= 2,
      speedComponentValid: highSessions.length >= 1,
      rule: "Threshold Capacity needs >=2 threshold sessions (or a confirmed race). " +
            "Speed/Top-End needs >=1 high-intensity session (or a short race). " +
            "Overall score needs >=3 valid components including Aerobic Base or Running Level. " +
            "Only HIGH or MODERATE confidence sessions count (knownIntensity)."
    };

    /* ── print ── */
    console.log("\n%c1. Rows by source", "font-weight:bold");
    console.table(bySource);

    console.log("\n%c2. Intervals import placement (the 53 vs 58 question)", "font-weight:bold");
    console.table([{
      "intervals rows": iv.length,
      "within 180d": in180.length,
      "older than 180d": outside180.length,
      "oldest": ivDates[0] || "—",
      "newest": ivDates[ivDates.length - 1] || "—",
      "duplicate external ids": dupIds.length
    }]);
    console.log("   by sport:", ivSports);

    console.log("\n%c3. Cross-provider duplicates", "font-weight:bold");
    console.table([{
      "pairs detected": pairs.length,
      "resolved (one side superseded)": resolved.length,
      "UNRESOLVED (both visible)": unresolved.length,
      "superseded rows total": superseded.length,
      "canonical rows": canonical.length
    }]);
    if (unresolved.length) {
      console.warn("   Unresolved duplicate pairs — these WOULD double-count:");
      console.table(unresolved.slice(0, 20).map(p => ({
        date: String(p.a.start_date).slice(0, 16),
        reason: p.reason,
        a: `${p.a.source}:${p.a.external_activity_id}`,
        b: `${p.b.source}:${p.b.external_activity_id}`,
        km: km(p.a.distance_meters)
      })));
    }

    console.log("\n%c4. Volume before / after dedup (km)", "font-weight:bold");
    console.table({
      "current week": { raw: vol.week.raw, canonical: vol.week.canonical, delta: +(vol.week.canonical - vol.week.raw).toFixed(1) },
      "last 180 days": { raw: vol.d180.raw, canonical: vol.d180.canonical, delta: +(vol.d180.canonical - vol.d180.raw).toFixed(1) },
      "all time": { raw: vol.all.raw, canonical: vol.all.canonical, delta: +(vol.all.canonical - vol.all.raw).toFixed(1) }
    });

    console.log("\n%c5. Classification (canonical runs, real classifier)", "font-weight:bold");
    console.table([{
      "runs classified": classified.length,
      "high/moderate confidence": known.length,
      "threshold sessions": thresholdSessions.length,
      "  ...from Intervals": fromIntervals(thresholdSessions).length,
      "high-intensity sessions": highSessions.length,
      "  ...from Intervals": fromIntervals(highSessions).length,
      "threshold km": +qualityKm.threshold.toFixed(1),
      "high-intensity km": +qualityKm.high.toFixed(1)
    }]);

    /* 6. one real example of each, end to end */
    const showcase = (label, pick) => {
      if (!pick) { console.log(`\n   ${label}: none found`); return null; }
      const { row, cls } = pick;
      console.log(`\n%c${label}`, "font-weight:bold");
      const summary = {
        source: row.source,
        externalId: row.external_activity_id,
        name: row.name,
        date: row.start_date,
        importedAt: importedAt(row),
        distanceKm: km(row.distance_meters),
        movingTime: row.moving_time_seconds,
        lapCount: laps(row) ? laps(row).length : 0,
        classification: cls.primaryType,
        intensity: cls.intensity,
        confidence: cls.confidence,
        reps: cls.intervals ? cls.intervals.reps : null,
        workPaceSecPerKm: cls.intervals ? cls.intervals.workPaceSec : null,
        qualityKm: cls.qualityKm,
        evidence: cls.estimated ? "summary metrics (estimated)" : "lap/interval structure"
      };
      console.log(summary);
      if (laps(row)) console.table(laps(row).slice(0, 12));
      // Return a self-contained record: the printed summary, the raw row and
      // the full classification, so the report object stands on its own
      // without the caller needing to know the internal pair shape.
      return { summary, row, classification: cls, laps: laps(row) };
    };

    // Prefer an Intervals-sourced example — the whole point is proving the
    // imported data flows end to end — falling back to any provider.
    const exThreshold = showcase("6a. Real THRESHOLD activity (end-to-end)",
      fromIntervals(thresholdSessions)[0] || thresholdSessions[0] || null);
    const exHigh = showcase("6b. Real HIGH-INTENSITY activity (end-to-end)",
      fromIntervals(highSessions)[0] || highSessions[0] || null);

    console.log("\n%c7. Athlevo Score gating", "font-weight:bold");
    console.table([scoreGate]);
    console.log("   " + scoreGate.rule);

    /*
     * 8. Loader truncation guard (regression check).
     *
     * The loader USED to take the newest 200 rows and filter superseded
     * duplicates client-side afterwards, so duplicates consumed slots that
     * real training should have occupied — 74 canonical activities were
     * invisible to Today/Train/Trends/Score/Coach. It now bounds by TIME and
     * pages, with the superseded filter applied server-side.
     *
     * This block stays as a guard: if a row cap is ever reintroduced, the
     * number it would hide is reported here.
     */
    const loaderCap = 200;
    const visibleAfterCap = rows.slice(0, loaderCap).filter(r => !isSuperseded(r)).length;
    const truncation = {
      totalRows: rows.length,
      loaderCap,
      rowsLoaderSees: Math.min(rows.length, loaderCap),
      canonicalAfterCap: visibleAfterCap,
      canonicalTotal: canonical.length,
      hiddenByCap: Math.max(0, canonical.length - visibleAfterCap)
    };
    console.log("\n%c8. Loader truncation (200-row cap)", "font-weight:bold");
    console.table([truncation]);
    if (truncation.hiddenByCap > 0) {
      console.warn(`   ${truncation.hiddenByCap} canonical activities are NOT reaching Today/Train/Trends/Score/Coach.`);
    }

    const report = {
      bySource, intervals: {
        total: iv.length, within180d: in180.length, olderThan180d: outside180.length,
        oldest: ivDates[0], newest: ivDates[ivDates.length - 1], sports: ivSports,
        duplicateExternalIds: dupIds.length
      },
      dedup: { pairs: pairs.length, resolved: resolved.length, unresolved: unresolved.length,
               supersededRows: superseded.length, canonicalRows: canonical.length },
      volumeKm: vol, classification: {
        runsClassified: classified.length, knownConfidence: known.length,
        thresholdSessions: thresholdSessions.length, highSessions: highSessions.length,
        thresholdFromIntervals: fromIntervals(thresholdSessions).length,
        highFromIntervals: fromIntervals(highSessions).length, qualityKm
      },
      scoreGate, truncation,
      examples: { threshold: exThreshold, high: exHigh }
    };
    console.log("\nFull report object:", report);
    return report;
  }

  /*
   * Idempotency check. This DOES trigger a real sync (the only write in this
   * file) and then re-counts, so a repeated sync can be proven not to
   * duplicate anything or inflate mileage.
   */
  async function checkIdempotency() {
    const before = await loadAllActivities();
    const beforeCanonical = before.rows.filter(r => !isSuperseded(r));
    const beforeKm = sumKm(beforeCanonical, null);
    console.log(`Before: ${before.rows.length} rows, ${beforeCanonical.length} canonical, ${beforeKm} km`);

    const result = await root.AthlevoBrain.syncIntervals();
    console.log("Sync result:", result);

    const after = await loadAllActivities();
    const afterCanonical = after.rows.filter(r => !isSuperseded(r));
    const afterKm = sumKm(afterCanonical, null);
    console.log(`After:  ${after.rows.length} rows, ${afterCanonical.length} canonical, ${afterKm} km`);

    const ok = after.rows.length === before.rows.length && Math.abs(afterKm - beforeKm) < 0.05;
    console.log(ok
      ? "%cIDEMPOTENT — no new rows, no mileage change."
      : "%cNOT IDEMPOTENT — row count or mileage changed.",
      `font-weight:bold;color:${ok ? "green" : "red"}`);
    return { ok, before: { rows: before.rows.length, km: beforeKm },
             after: { rows: after.rows.length, km: afterKm }, syncResult: result };
  }

  /*
   * Plan-pipeline probe. READ-ONLY: it never generates, never writes, and
   * never touches an existing plan. Use it to confirm the pipeline is healthy
   * on a real account — including your own — without risking your plan.
   *
   * Console:  await AthlevoVerify.checkPlan()
   */
  async function checkPlan() {
    const { data: { user } } = await sb().auth.getUser();
    if (!user) { console.error("Not signed in."); return null; }

    const out = { userId: user.id.slice(0, 8) + "…" };

    // 1. Is the profile complete enough for the endpoint to proceed?
    const { data: profile } = await sb()
      .from("profiles")
      .select("onboarding_complete,goal,device,training_days,weekly_distance," +
              "long_run_day,experience_level,target_race,target_race_date")
      .eq("id", user.id).maybeSingle();
    out.profile = profile
      ? {
          onboardingComplete: profile.onboarding_complete === true,
          hasGoal: !!profile.goal,
          hasTrainingDays: profile.training_days != null,
          hasWeeklyVolume: profile.weekly_distance != null,
          hasLongRunDay: !!profile.long_run_day,
          hasTargetRace: !!profile.target_race_date
        }
      : { missing: true };

    // 2. Does a plan already exist? (Determines whether the button would
    //    generate or return the existing week.)
    const { data: plans } = await sb()
      .from("training_plans")
      .select("id,week_start,week_end,status")
      .eq("user_id", user.id)
      .order("week_start", { ascending: false })
      .limit(3);
    out.existingPlans = (plans || []).length;
    out.latestPlan = (plans || [])[0] || null;

    // 3. Are this week's sessions present and renderable?
    const { data: sessions } = await sb()
      .from("training_sessions")
      .select("session_date,title,session_type,duration_minutes,distance_km")
      .eq("user_id", user.id)
      .order("session_date", { ascending: true })
      .limit(14);
    out.sessions = (sessions || []).length;
    out.sessionDates = (sessions || []).map(s => s.session_date);
    out.missingFields = (sessions || []).filter(s =>
      !s.title || !s.session_type || s.session_date == null).length;

    const ready = out.profile.onboardingComplete && !out.profile.missing;
    console.log(ready
      ? "%cProfile is complete — the plan button should work."
      : "%cProfile is INCOMPLETE — the button would ask you to finish it first.",
      "font-weight:bold");
    console.log(out.existingPlans
      ? `You already have ${out.existingPlans} plan(s). The button will OPEN the existing week, not regenerate.`
      : "No plan yet. The button will generate one.");
    console.table([{
      onboardingComplete: out.profile.onboardingComplete,
      existingPlans: out.existingPlans,
      sessionsStored: out.sessions,
      sessionsMissingFields: out.missingFields
    }]);
    console.log("Full report:", out);
    return out;
  }

  root.AthlevoVerify = { run, checkIdempotency, loadAllActivities, checkPlan };
})(typeof window !== "undefined" ? window : globalThis);
