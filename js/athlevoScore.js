/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo Score v1  —  transparent, deterministic, versioned
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Athlevo Score represents LONGITUDINAL athletic development — not
 *  readiness, not VO2max, not VDOT, not a race prediction, not a medical
 *  measure. It is a blend of six endurance qualities, each of which is
 *  only scored when it has enough real data; otherwise it reports
 *  "Building" (never a fabricated low score, never a missing quality
 *  scored as zero).
 *
 *  Components:
 *    Aerobic Base · Threshold Capacity · Speed/Top-End · Durability ·
 *    Consistency · Current Running Level (reused from the Phase-1
 *    performance engine — NOT recomputed here).
 *
 *  Overall score uses approach B: reweight across the VALID components,
 *  behind a minimum-data GATE (need ≥3 valid components, including Aerobic
 *  Base or Current Running Level). It is smoothed against the last stored
 *  score so an ordinary workout can't move it much, while a confirmed race
 *  can move it more. Everything is deterministic and testable.
 *
 *  Model version: athlevo-score-v1
 *
 *  Reuses: performance engine (Current Running Level via AthleteModel),
 *  trends engine (merged/de-duplicated training items), calendar weeks.
 */

(function () {
  "use strict";

  const MODEL_VERSION = "athlevo-score-v1";
  const HISTORY_DAYS = 56; // ~8 weeks of evidence

  const WEIGHTS = {
    aerobic: 0.25,
    threshold: 0.25,
    durability: 0.20,
    consistency: 0.15,
    speed: 0.10,
    level: 0.05
  };

  const num = v => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
  const daysAgo = (iso, now) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? (now - t) / 86400000 : Infinity;
  };

  /* ───────────── recent-history statistics (shared inputs) ─────────── */

  function isoWeekKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    // Coarse week bucket good enough for "distinct weeks with running".
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day);
    return monday.toISOString().slice(0, 10);
  }

  function deriveStats(items, now) {
    const recent = (items || []).filter(
      i => i.timestamp && daysAgo(i.timestamp, now) <= HISTORY_DAYS
    );
    const runs = recent.filter(i => i.isRun && i.performed);

    const weeks = new Set();
    runs.forEach(i => {
      const k = isoWeekKey(i.timestamp);
      if (k) weeks.add(k);
    });

    const easyRuns = runs.filter(i => i.intensity === "easy");
    const thresholdSessions = runs.filter(i => i.intensity === "threshold" && i.knownIntensity);
    const speedSessions = runs.filter(i => i.intensity === "high" && i.knownIntensity);
    const shortRaces = runs.filter(
      i => /race|time.?trial/i.test(String(i.type || "")) && i.distanceKm > 0 && i.distanceKm <= 10
    );

    const longRuns = runs.filter(i => i.durationMin >= 90 || i.distanceKm >= 16);
    const painLongRuns = longRuns.filter(i => i.painPresent);

    const totalKm = runs.reduce((s, i) => s + (i.distanceKm || 0), 0);
    const weekCount = Math.max(weeks.size, 1);
    const avgWeeklyKm = totalKm / weekCount;

    const hrRuns = runs.filter(i => num(i.hr) != null);

    // Execution-style items for consistency (completed/modified/skipped).
    const recorded = recent.filter(i =>
      i.status === "completed" || i.status === "modified" || i.status === "skipped"
    );
    const completed = recorded.filter(i => i.status === "completed").length;
    const modified = recorded.filter(i => i.status === "modified").length;
    const skipped = recorded.filter(i => i.status === "skipped");
    // Schedule / travel / illness / pain skips are NOT non-compliance.
    const excusedSkip = r => ["schedule", "travel", "illness", "pain"].includes(String(r || "").toLowerCase());
    const unexplainedSkips = skipped.filter(i => !excusedSkip(i.skipReason)).length;
    const painSkips = skipped.filter(i => String(i.skipReason || "").toLowerCase() === "pain").length;

    return {
      weeksWithRunning: weeks.size,
      runCount: runs.length,
      easyRunCount: easyRuns.length,
      thresholdCount: thresholdSessions.length,
      speedCount: speedSessions.length,
      shortRaceCount: shortRaces.length,
      longRunCount: longRuns.length,
      longestLongMin: longRuns.reduce((m, i) => Math.max(m, i.durationMin || 0), 0),
      painLongRunCount: painLongRuns.length,
      avgWeeklyKm,
      hrCoverage: runs.length ? hrRuns.length / runs.length : 0,
      completed,
      modified,
      unexplainedSkips,
      painSkips,
      recordedPlanned: recorded.length,
      latestTs: recent.reduce((m, i) => {
        const t = Date.parse(i.timestamp);
        return Number.isFinite(t) && t > m ? t : m;
      }, 0)
    };
  }

  function coverageFrom(strong, developing) {
    if (strong) return "Strong data";
    if (developing) return "Developing";
    return "Limited data";
  }

  function building(key, label, explanation, needed) {
    return {
      key, label, score: null, status: "Building",
      coverage: "Limited data", explanation,
      supporting: [], limiting: [], dataNeeded: needed || explanation,
      lastUpdated: null
    };
  }

  /* ─────────────────────────── components ──────────────────────────── */

  function aerobicBase(stats, fitness, lastUpdated) {
    if (!(stats.weeksWithRunning >= 2 && stats.easyRunCount >= 4)) {
      return building(
        "aerobic", "Aerobic Base",
        "Log a few weeks of easy running to establish your aerobic base.",
        "More weeks of easy or steady running"
      );
    }
    const level = fitness && fitness.runningLevel ? fitness.runningLevel.level : null;
    const volume = Math.min(30, stats.avgWeeklyKm * 0.6);
    const score = level != null
      ? clamp(level * 0.7 + volume)
      : clamp(30 + Math.min(40, stats.avgWeeklyKm * 0.8) + stats.weeksWithRunning * 2);

    const supporting = [];
    if (stats.avgWeeklyKm >= 25) supporting.push("Consistent easy-run volume");
    if (stats.weeksWithRunning >= 4) supporting.push("Several weeks of continuity");
    const limiting = [];
    if (stats.hrCoverage < 0.4) limiting.push("Heart-rate data is limited, so efficiency isn't measured yet");

    return {
      key: "aerobic", label: "Aerobic Base", score, status: "valid",
      coverage: coverageFrom(stats.hrCoverage >= 0.5 && stats.weeksWithRunning >= 4, stats.weeksWithRunning >= 2),
      explanation: "Based on your easy-running volume and continuity" + (level != null ? " and current running level." : "."),
      supporting, limiting, dataNeeded: null, lastUpdated
    };
  }

  function thresholdCapacity(stats, fitness, lastUpdated) {
    const hasRace = fitness && fitness.hasConfirmedRace === true;
    const enough = stats.thresholdCount >= 2 || (hasRace && stats.weeksWithRunning >= 3);
    if (!enough) {
      return building(
        "threshold", "Threshold Capacity",
        "Complete at least two threshold/tempo sessions (or confirm a recent race) to measure threshold.",
        "Two or more comparable threshold sessions, or a confirmed race"
      );
    }
    const level = fitness && fitness.runningLevel ? fitness.runningLevel.level : null;
    const score = level != null
      ? clamp(level * 0.9 + Math.min(6, stats.thresholdCount * 2))
      : clamp(45 + stats.thresholdCount * 3);

    const supporting = [];
    if (stats.thresholdCount >= 2) supporting.push(`${stats.thresholdCount} threshold-quality sessions`);
    if (hasRace) supporting.push("Confirmed race result");
    const limiting = [];
    if (stats.thresholdCount < 2) limiting.push("Few repeated threshold sessions to compare");

    return {
      key: "threshold", label: "Threshold Capacity", score, status: "valid",
      coverage: coverageFrom(stats.thresholdCount >= 3 || hasRace, stats.thresholdCount >= 2),
      explanation: "Based on your threshold-quality sessions" + (hasRace ? " and confirmed race evidence." : "."),
      supporting, limiting, dataNeeded: null, lastUpdated
    };
  }

  function speedTopEnd(stats, fitness, lastUpdated) {
    if (!(stats.speedCount >= 1 || stats.shortRaceCount >= 1)) {
      return building(
        "speed", "Speed / Top-End",
        "Add short intervals, repetitions, or a short time trial to measure speed.",
        "Short high-intensity sessions or a short race/time trial"
      );
    }
    const level = fitness && fitness.runningLevel ? fitness.runningLevel.level : null;
    const evidence = stats.speedCount + stats.shortRaceCount;
    const score = level != null
      ? clamp(level * 0.85 + Math.min(8, evidence * 3))
      : clamp(40 + evidence * 5);

    return {
      key: "speed", label: "Speed / Top-End", score, status: "valid",
      coverage: coverageFrom(evidence >= 3, evidence >= 1),
      explanation: "Based on your short high-intensity sessions" + (stats.shortRaceCount ? " and short-race results." : "."),
      supporting: evidence ? [`${evidence} speed session${evidence === 1 ? "" : "s"}`] : [],
      limiting: evidence < 2 ? ["Limited speed evidence so far"] : [],
      dataNeeded: null, lastUpdated
    };
  }

  function durability(stats, fitness, lastUpdated) {
    if (!(stats.longRunCount >= 2)) {
      return building(
        "durability", "Durability",
        "Complete a couple of long runs to measure how you hold form deep into sessions.",
        "Two or more long runs"
      );
    }
    const score = clamp(
      Math.min(50, stats.longestLongMin * 0.4) +
      Math.min(30, stats.longRunCount * 8) +
      Math.min(20, stats.avgWeeklyKm * 0.3)
    );
    const limiting = [];
    if (stats.painLongRunCount > 0) limiting.push("Pain reported during long runs");
    return {
      key: "durability", label: "Durability", score, status: "valid",
      coverage: coverageFrom(stats.longRunCount >= 4, stats.longRunCount >= 2),
      explanation: "Based on your long-run duration, frequency and weekly volume.",
      supporting: [`${stats.longRunCount} long runs recently`],
      limiting, dataNeeded: null, lastUpdated
    };
  }

  function consistency(stats, fitness, profile, lastUpdated) {
    if (!(stats.weeksWithRunning >= 2)) {
      return building(
        "consistency", "Consistency",
        "A couple of weeks of continuous training establishes your consistency.",
        "At least two weeks of continuous training"
      );
    }
    // Completion among recorded planned sessions, EXCLUDING excused skips
    // (schedule/travel/illness/pain) from the penalty — a pain-related
    // reduction is good decision-making, not non-compliance.
    const good = stats.completed + stats.modified;
    const denom = good + stats.unexplainedSkips;
    const completionPct = denom > 0 ? (good / denom) * 100 : null;

    const availableDays = num(profile && (profile.available_days ?? profile.training_days)) || 5;
    const runsPerWeek = stats.runCount / Math.max(stats.weeksWithRunning, 1);
    const freqPct = Math.min(100, (runsPerWeek / availableDays) * 100);

    let score;
    if (completionPct != null) score = clamp(completionPct * 0.6 + freqPct * 0.4);
    else score = clamp(freqPct);

    const supporting = [];
    if (stats.weeksWithRunning >= 4) supporting.push("Strong week-to-week continuity");
    if (completionPct != null && completionPct >= 80) supporting.push("High planned-session completion");
    const limiting = [];
    if (stats.unexplainedSkips > 0) limiting.push(`${stats.unexplainedSkips} unexplained skipped session${stats.unexplainedSkips === 1 ? "" : "s"}`);

    return {
      key: "consistency", label: "Consistency", score, status: "valid",
      coverage: coverageFrom(stats.weeksWithRunning >= 4 && stats.recordedPlanned >= 4, stats.weeksWithRunning >= 2),
      explanation: "Based on training frequency and completion of recorded sessions. Pain and schedule skips are not counted against you.",
      supporting, limiting, dataNeeded: null, lastUpdated
    };
  }

  function currentRunningLevel(fitness, lastUpdated) {
    const level = fitness && fitness.runningLevel ? fitness.runningLevel.level : null;
    if (level == null) {
      return building(
        "level", "Current Running Level",
        "Confirm a recent race or time trial to establish your running level.",
        "A confirmed race or time trial"
      );
    }
    const estimated = fitness.runningLevel.estimated === true;
    return {
      key: "level", label: "Current Running Level", score: level, status: "valid",
      coverage: estimated ? "Developing" : "Strong data",
      explanation: estimated
        ? "Estimated from your recent runs — confirm a race for precision."
        : `From your confirmed race evidence (${fitness.runningLevel.tier}).`,
      supporting: estimated ? [] : ["Confirmed race/time-trial result"],
      limiting: estimated ? ["Based on an estimate, not a confirmed race"] : [],
      dataNeeded: null, lastUpdated
    };
  }

  /* ───────────────────────── overall + smoothing ───────────────────── */

  function computeAthlevoScore(inputs) {
    inputs = inputs || {};
    const now = inputs.now ? (inputs.now instanceof Date ? inputs.now.getTime() : inputs.now) : Date.now();
    const items = inputs.items || [];
    const fitness = inputs.fitness || null;
    const profile = inputs.profile || {};
    const raceResults = inputs.raceResults || [];
    const prior = inputs.priorScore || null; // { overall_score, calculated_at } or null

    const stats = deriveStats(items, now);
    const lastUpdated = stats.latestTs ? new Date(stats.latestTs).toISOString().slice(0, 10) : null;

    const components = {
      aerobic: aerobicBase(stats, fitness, lastUpdated),
      threshold: thresholdCapacity(stats, fitness, lastUpdated),
      speed: speedTopEnd(stats, fitness, lastUpdated),
      durability: durability(stats, fitness, lastUpdated),
      consistency: consistency(stats, fitness, profile, lastUpdated),
      level: currentRunningLevel(fitness, lastUpdated)
    };

    const valid = Object.values(components).filter(c => c.status === "valid" && c.score != null);

    // GATE (approach B + minimum set): need ≥3 valid components including
    // Aerobic Base OR Current Running Level.
    const gateMet =
      valid.length >= 3 &&
      (components.aerobic.status === "valid" || components.level.status === "valid");

    let overall = null;
    let raw = null;
    let dataQuality = valid.length >= 5 ? "Strong data" : valid.length >= 3 ? "Developing" : "Limited data";

    if (gateMet) {
      let wsum = 0, acc = 0;
      valid.forEach(c => {
        const w = WEIGHTS[c.key] || 0;
        wsum += w;
        acc += c.score * w;
      });
      raw = wsum > 0 ? clamp(acc / wsum) : null;
    }

    // Smoothing: resist one-run volatility; allow a bigger step after a
    // confirmed major performance (race/TT in the last 10 days).
    const majorEvent = (raceResults || []).some(
      r => (r.race_type === "official" || r.race_type === "time_trial") &&
        r.race_date && daysAgo(r.race_date + "T12:00:00Z", now) <= 10
    );

    const changeReasons = [];
    let change = 0;

    if (raw != null) {
      const priorScore = prior && num(prior.overall_score) != null ? num(prior.overall_score) : null;
      if (priorScore == null) {
        overall = raw;
      } else {
        const step = raw - priorScore;
        const maxStep = majorEvent ? 6 : 2;
        const alpha = majorEvent ? 0.6 : 0.3;
        const moved = Math.max(-maxStep, Math.min(maxStep, Math.round(step * alpha)));
        overall = clamp(priorScore + moved);
        change = overall - priorScore;
      }

      // Human change reasons.
      if (majorEvent && change !== 0) changeReasons.push("A confirmed race updated your running level");
      const improved = valid.filter(c => c.score >= 70).map(c => c.label);
      const weak = valid.filter(c => c.score < 55).map(c => c.label);
      if (change > 0 && improved.length) changeReasons.push(`${improved[0]} is trending well`);
      if (change < 0 && weak.length) changeReasons.push(`${weak[0]} pulled the score down`);
      if (!changeReasons.length) changeReasons.push(change === 0 ? "Steady — no meaningful change" : "Gradual movement from recent training");
    }

    // Strengths / limiter / data-needed for the detail view.
    const sortedValid = [...valid].sort((a, b) => b.score - a.score);
    const strengths = sortedValid.slice(0, 2).map(c => c.label);
    const limiter = sortedValid.length ? sortedValid[sortedValid.length - 1].label : null;
    const dataNeeded = Object.values(components)
      .filter(c => c.status === "Building")
      .map(c => ({ label: c.label, need: c.dataNeeded }));

    const explanation = gateMet
      ? buildOverallExplanation(components, strengths, dataNeeded)
      : "Complete more threshold and long-run sessions to establish your baseline.";

    return {
      version: MODEL_VERSION,
      overall: {
        score: gateMet ? overall : null,
        raw,
        status: gateMet ? "valid" : "Building",
        dataQuality,
        change,
        changeReasons,
        explanation,
        lastUpdated
      },
      components,
      strengths,
      limiter,
      dataNeeded,
      sourceIds: (raceResults || []).map(r => r.id).filter(Boolean),
      majorEvent
    };
  }

  function buildOverallExplanation(components, strengths, dataNeeded) {
    const parts = [];
    if (strengths.length) {
      parts.push(`Your ${strengths.join(" and ").toLowerCase()} ${strengths.length > 1 ? "are" : "is"} strongest right now.`);
    }
    const building = dataNeeded.map(d => d.label);
    if (building.length) {
      parts.push(`${building.slice(0, 2).join(" and ")} data is still limited.`);
    }
    return parts.join(" ") || "Your development is being tracked across all qualities.";
  }

  /* ═══════════════════════════ rendering ═══════════════════════════ */

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ─── segmented score ring (SVG) ─── */

  // Six outer segments from the EXISTING component scores (no new maths).
  // "Recovery Balance" is not a computed score in the model, so the sixth
  // segment reuses Current Running Level rather than fabricating one.
  const RING_SEGMENTS = [
    { key: "aerobic", label: "Aerobic" },
    { key: "durability", label: "Durability" },
    { key: "threshold", label: "Threshold" },
    { key: "speed", label: "Speed" },
    { key: "consistency", label: "Consistency" },
    { key: "level", label: "Level" }
  ];

  function polar(cx, cy, r, ang) {
    const a = (ang - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }
  function arcCW(cx, cy, r, start, end) {
    const s = polar(cx, cy, r, start), e = polar(cx, cy, r, end);
    const large = (((end - start) % 360) + 360) % 360 > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  function buildScoreRing(components, animate) {
    const cx = 100, cy = 100, r = 82, slot = 60, gap = 9;
    // Strongest valid component gets the accent colour.
    let strongest = null, best = -1;
    RING_SEGMENTS.forEach(s => {
      const c = components[s.key];
      if (c && c.status === "valid" && Number(c.score) > best) { best = Number(c.score); strongest = s.key; }
    });

    let paths = "";
    RING_SEGMENTS.forEach((s, i) => {
      const c = components[s.key] || {};
      const score = c.status === "valid" && Number.isFinite(Number(c.score)) ? Number(c.score) : null;
      const start = i * slot + gap / 2;
      const end = (i + 1) * slot - gap / 2;
      const d = arcCW(cx, cy, r, start, end);
      paths += `<path class="asc-ring-track" d="${d}" pathLength="100"></path>`;
      const frac = score != null ? Math.max(0.02, Math.min(1, score / 100)) : 0;
      const target = (100 * (1 - frac)).toFixed(1);
      const initial = animate ? 100 : target;
      paths += `<path class="asc-ring-val${s.key === strongest ? " strong" : ""}" d="${d}" pathLength="100" data-target="${target}" style="stroke-dashoffset:${initial}"></path>`;
    });
    return `<svg class="asc-ring${animate ? " animate" : ""}" viewBox="0 0 200 200" aria-hidden="true">${paths}</svg>`;
  }

  /* ─── deltas over real history (Part 2) ─── */

  function prefersReducedMotion() {
    try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  function computeDelta(history, current) {
    if (current == null) return { text: "Building baseline", improved: false };
    const valid = (history || []).filter(h => h.overall_score != null && h.score_date);
    if (!valid.length) return { text: "Building baseline", improved: false };
    const todayKey = valid[0].score_date;
    const todayMs = Date.parse(todayKey);
    const priorOnly = valid.filter(h => h.score_date !== todayKey);
    if (!priorOnly.length) return { text: "Building baseline", improved: false };

    // Most recent snapshot whose age falls inside a window, so a month-old
    // baseline is never mislabelled "this week".
    const inWindow = (minD, maxD) => {
      for (const h of valid) {
        const age = (todayMs - Date.parse(h.score_date)) / 86400000;
        if (age >= minD && age <= maxD) return Number(h.overall_score);
      }
      return null;
    };
    const wk = inWindow(5, 13);
    const mo = inWindow(20, 45);
    if (wk != null && current - wk !== 0) {
      const d = current - wk;
      return { text: `${d > 0 ? "+" : ""}${d} this week`, improved: d > 0 };
    }
    if (mo != null && current - mo !== 0) {
      const d = current - mo;
      return { text: `${d > 0 ? "+" : ""}${d} this month`, improved: d > 0 };
    }
    return { text: "Stable", improved: false };
  }

  // The five long-term profile axes, in the order the radar draws them.
  const RADAR_AXES = [
    { key: "aerobic",     label: "Aerobic",     full: "Aerobic" },
    { key: "threshold",   label: "Threshold",   full: "Threshold" },
    { key: "speed",       label: "Speed",       full: "Speed / Top-End" },
    { key: "durability",  label: "Durability",  full: "Durability" },
    { key: "consistency", label: "Consistency", full: "Consistency" }
  ];

  // Classify a component for the chart WITHOUT touching score maths:
  //   verified  → valid score with strong data
  //   developing→ valid score, thinner data
  //   missing   → no reliable score yet (NEVER drawn as zero)
  function radarState(c) {
    const ok = c && c.status === "valid" && Number.isFinite(Number(c.score));
    if (!ok) return "missing";
    return c.coverage === "Strong data" ? "verified" : "developing";
  }

  /*
   * Builds the 5-axis athlete-profile radar as inline SVG. Missing axes are
   * shown as dashed spokes with NO vertex (the polygon is drawn only through
   * axes that actually have data, so it never collapses misleadingly to 0).
   */
  function buildRadar(components) {
    // Wide viewBox + generous side margins so long axis labels never clip.
    const cx = 160, cy = 104, R = 66, N = RADAR_AXES.length;
    const ang = i => (-90 + i * (360 / N)) * Math.PI / 180;
    const pt = (i, rad) => [cx + rad * Math.cos(ang(i)), cy + rad * Math.sin(ang(i))];
    const f = n => n.toFixed(1);

    let grid = "";
    [0.25, 0.5, 0.75, 1].forEach(lv => {
      const pts = RADAR_AXES.map((_, i) => pt(i, R * lv).map(f).join(",")).join(" ");
      grid += `<polygon class="asc-radar-grid" points="${pts}"></polygon>`;
    });

    // Neutral placeholder radius for missing axes = mean of known scores (or a
    // mid value). This keeps the polygon a full, neutral pentagon instead of
    // denting to 0 and falsely implying poor performance.
    const known = RADAR_AXES
      .map(a => (components || {})[a.key] || {})
      .filter(c => radarState(c) !== "missing")
      .map(c => Number(c.score));
    const neutral = known.length ? Math.round(known.reduce((s, n) => s + n, 0) / known.length) : 50;

    let spokes = "", labels = "", markers = "", poly = [];
    RADAR_AXES.forEach((ax, i) => {
      const c = (components || {})[ax.key] || {};
      const state = radarState(c);
      const missing = state === "missing";
      const [ex, ey] = pt(i, R);
      spokes += `<line class="asc-radar-spoke${missing ? " missing" : ""}" x1="${cx}" y1="${cy}" x2="${f(ex)}" y2="${f(ey)}"></line>`;

      const [lx, ly] = pt(i, R + 14);
      const anchor = Math.abs(lx - cx) < 6 ? "middle" : (lx > cx ? "start" : "end");
      const dy = ly < cy - 4 ? "-0.15em" : (ly > cy + 4 ? "0.72em" : "0.32em");
      labels += `<text class="asc-radar-label${missing ? " missing" : ""}" x="${f(lx)}" y="${f(ly)}" text-anchor="${anchor}" dy="${dy}">${ax.label}</text>`;
      if (missing) {
        // A small "Needs data" note just outside the axis label.
        const nd = ly < cy - 4 ? "1.15em" : (ly > cy + 4 ? "1.9em" : "1.5em");
        labels += `<text class="asc-radar-need" x="${f(lx)}" y="${f(ly)}" text-anchor="${anchor}" dy="${nd}">Needs data</text>`;
      }

      const val = missing ? neutral : Number(c.score);
      const rad = Math.max(0.06, Math.min(1, val / 100)) * R;
      const [px, py] = pt(i, rad);
      poly.push([px, py]);
      const cls = missing ? "m" : (state === "verified" ? "v" : "d");
      markers += `<circle class="asc-radar-dot ${cls}" cx="${f(px)}" cy="${f(py)}" r="${missing ? 3 : 3.4}"></circle>`;
    });

    const shape = `<polygon class="asc-radar-area" points="${poly.map(p => p.map(f).join(",")).join(" ")}"></polygon>`;

    return `<svg class="asc-radar" viewBox="0 0 320 210" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Athlete profile radar across five abilities">
        <g class="asc-radar-frame">${grid}${spokes}</g>
        ${labels}
        <g class="asc-radar-data">${shape}${markers}</g>
      </svg>`;
  }

  function renderScoreCard(result) {
    const mount = document.getElementById("athlevoScoreCard");
    if (!mount) return;
    const o = result.overall;

    // Expose current component scores for the Development section (reuse —
    // it compares these against persisted history, no recomputation).
    try { window.__athlevoLastComponents = result.components; } catch (e) {}

    const delta = computeDelta(scoreHistory, o.status === "valid" ? o.score : null);
    const deltaClass =
      delta.text === "Stable" ? "stable" :
      delta.text === "Building baseline" ? "building" :
      delta.improved ? "up" : "down";

    // Celebrate ONLY a genuine improvement vs. the last value shown on this
    // device — and never when reduced motion is requested.
    let lastShown = null;
    try { lastShown = Number(window.localStorage.getItem("athlevo_score_last")); } catch (e) {}
    const genuineImprovement = o.status === "valid" && Number.isFinite(lastShown) && o.score > lastShown;
    const animate = genuineImprovement && !prefersReducedMotion();

    const updated = o.lastUpdated
      ? `<span class="asc-updated">Updated ${esc(o.lastUpdated)}</span>` : "";

    const valid = o.status === "valid";
    const cur = valid ? Number(o.score) : null;

    // Trend badges from real persisted history (calculations untouched):
    // all-time "Highest ever", else "Best in 30 days", else the peak marker.
    const histRows = (scoreHistory || [])
      .filter(h => Number.isFinite(Number(h.overall_score)));
    const hist = histRows.map(h => Number(h.overall_score));
    const allVals = cur != null ? hist.concat(cur) : hist;
    const peak = allVals.length ? Math.max(...allVals) : null;

    // Highest score seen in the last 30 days (prior snapshots only).
    const DAY = 86400000, now = Date.now();
    const recent30 = histRows
      .filter(h => {
        const t = Date.parse(h.score_date);
        return Number.isFinite(t) && (now - t) <= 30 * DAY;
      })
      .map(h => Number(h.overall_score));
    const peak30 = recent30.length ? Math.max(...recent30) : null;

    let peakBadge = "", peakMark = "";
    if (valid && peak != null) {
      if (cur >= peak && (hist.length > 1 || delta.improved)) {
        peakBadge = `<span class="asc-peak best">✦ Highest ever</span>`;
      } else if (peak30 != null && cur >= peak30 && recent30.length > 1) {
        peakBadge = `<span class="asc-peak best">Best in 30 days</span>`;
        if (peak > cur) peakMark = `<span class="asc-track-mark" style="left:${peak}%"></span>`;
      } else if (peak > cur) {
        peakBadge = `<span class="asc-peak">Best ${peak}</span>`;
        peakMark = `<span class="asc-track-mark" style="left:${peak}%"></span>`;
      }
    }

    // Component value list — label + number, "—" when data is insufficient
    // (never 0). A coloured dot (not colour alone) marks verified/developing/
    // missing so meaning survives colour-blindness and dark mode.
    const components = result.components || {};
    const compList = RADAR_AXES.map(ax => {
      const c = components[ax.key] || {};
      const state = radarState(c);
      const val = state === "missing" ? "—" : c.score;
      return `
        <div class="asc-crow ${state}">
          <span class="asc-cdot" aria-hidden="true"></span>
          <span class="asc-cname">${esc(ax.full)}</span>
          <span class="asc-cval">${val}</span>
        </div>`;
    }).join("");

    // Which axes still need data, and how to unlock them (truthful, generic).
    const missingLabels = RADAR_AXES
      .filter(ax => radarState(components[ax.key] || {}) === "missing")
      .map(ax => ax.full);
    const needNote = missingLabels.length
      ? `<p class="asc-need">More data needed for ${esc(missingLabels.join(", "))}. Log a race or a threshold session to complete your profile.</p>`
      : "";

    const arrow = deltaClass === "up" ? "▲ " : deltaClass === "down" ? "▼ " : "";

    mount.innerHTML = `
      <div class="asc">
        <div class="asc-head">
          <div class="asc-head-l">
            <span class="asc-eyebrow">Athlevo Score</span>
            <span class="asc-sub-eyebrow">Long-term development</span>
          </div>
          <span class="asc-delta ${deltaClass}">${arrow}${esc(delta.text)}</span>
        </div>

        <div class="asc-hero">
          <div class="asc-scorewrap">
            <span class="asc-score-num" id="ascRingNum">${valid ? o.score : "—"}</span>
            <span class="asc-score-max">/100</span>
          </div>
          ${peakBadge}
        </div>

        <div class="asc-radar-wrap${animate ? " animate" : ""}">${buildRadar(components)}</div>

        <div class="asc-comp-list">${compList}</div>
        ${needNote}

        <p class="asc-explain">${esc(o.explanation)}</p>
        <div class="asc-foot">
          ${updated}
          <button class="asc-details-btn" type="button" onclick="AthlevoScore.openDetails()">View details</button>
        </div>
      </div>`;

    if (valid) {
      try { window.localStorage.setItem("athlevo_score_last", String(o.score)); } catch (e) {}
    }

    if (animate) runScoreCelebration(mount, lastShown, o.score);
  }

  // Count the score number up (the radar polygon animates in via CSS).
  function runScoreCelebration(mount, from, to) {
    const num = mount.querySelector("#ascRingNum");
    if (!num || !Number.isFinite(from)) return;
    const start = performance.now(), dur = 800;
    const step = now => {
      const t = Math.min(1, (now - start) / dur);
      num.textContent = String(Math.round(from + (to - from) * t));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const COVERAGE_CLASS = { "Strong data": "strong", "Developing": "dev", "Limited data": "lim" };

  function componentRow(c) {
    const cov = COVERAGE_CLASS[c.coverage] || "lim";
    return `
      <div class="scd-comp">
        <div class="scd-comp-top">
          <span class="scd-comp-label">${esc(c.label)}</span>
          <span class="scd-comp-val">${c.status === "valid" ? c.score : "Building"}</span>
        </div>
        <div class="scd-track"><i style="width:${c.status === "valid" ? Math.max(4, c.score) : 0}%"></i></div>
        <div class="scd-comp-meta"><span class="scd-cov ${cov}">${esc(c.coverage)}</span></div>
        <p class="scd-comp-exp">${esc(c.explanation)}</p>
      </div>`;
  }

  function openDetails() {
    const modal = document.getElementById("scoreDetailModal");
    const result = lastResult;
    if (!modal || !result) return;

    const o = result.overall;
    const order = ["aerobic", "threshold", "speed", "durability", "consistency", "level"];

    const strengths = result.strengths.length
      ? `<p class="scd-line"><b>Current strengths:</b> ${esc(result.strengths.join(", "))}</p>` : "";
    const limiter = result.limiter
      ? `<p class="scd-line"><b>Current limiter:</b> ${esc(result.limiter)}</p>` : "";
    const needed = result.dataNeeded.length
      ? `<div class="scd-need"><b>Data still needed</b><ul>${result.dataNeeded.map(d => `<li>${esc(d.label)} — ${esc(d.need)}</li>`).join("")}</ul></div>` : "";
    const why = o.changeReasons && o.changeReasons.length
      ? `<p class="scd-line"><b>Why it changed:</b> ${esc(o.changeReasons.join("; "))}</p>` : "";

    const history = renderHistory();

    // Predicted Training Paces moved OUT of the score detail (Training
    // Engine V2). Paces now live in the dedicated Today "Your current
    // training paces" card (#trainingPacesCard), rendered from the shared
    // pace service. The underlying data/calculator is unchanged.

    modal.innerHTML = `
      <div class="scd">
        <div class="scd-header">
          <div>
            <span class="asc-eyebrow">Athlevo Score</span>
            <div class="scd-overall">${o.status === "valid" ? o.score : "Building"}</div>
            <span class="scd-quality">${esc(o.dataQuality)}</span>
          </div>
          <button class="scd-close" type="button" onclick="AthlevoScore.closeDetails()" aria-label="Close">✕</button>
        </div>
        <p class="scd-explain">${esc(o.explanation)}</p>
        ${why}${strengths}${limiter}
        <div class="scd-comps">${order.map(k => componentRow(result.components[k])).join("")}</div>
        ${needed}
        ${history}
      </div>`;
    modal.classList.add("show");
  }

  function renderHistory() {
    if (!scoreHistory || !scoreHistory.length) return "";
    const rows = scoreHistory.slice(0, 8).map(h =>
      `<div class="scd-hist-row"><span>${esc(h.score_date)}</span><span>${h.overall_score != null ? h.overall_score : "Building"}</span></div>`
    ).join("");
    return `<div class="scd-hist"><b>Recent score history</b>${rows}</div>`;
  }

  function closeDetails() {
    const modal = document.getElementById("scoreDetailModal");
    if (modal) { modal.classList.remove("show"); }
  }

  /* ─────────────────── history persistence (client) ────────────────── */

  async function loadPriorScore(userId) {
    try {
      const { data } = await supabaseClient
        .from("athlevo_score_history")
        .select("score_date,overall_score,calculated_at")
        .eq("user_id", userId)
        .eq("model_version", MODEL_VERSION)
        .order("score_date", { ascending: false })
        .limit(10);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  }

  async function saveSnapshot(userId, result, tz) {
    try {
      const today = window.AthlevoCalendar
        ? (() => { const c = window.AthlevoCalendar.localCivil(new Date(), window.AthlevoCalendar.resolveTimezone(tz)); return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`; })()
        : new Date().toISOString().slice(0, 10);

      const componentScores = {};
      const componentStatuses = {};
      Object.values(result.components).forEach(c => {
        componentScores[c.key] = c.score;
        componentStatuses[c.key] = c.status;
      });

      const row = {
        user_id: userId,
        score_date: today,
        overall_score: result.overall.score,
        component_scores: componentScores,
        component_statuses: componentStatuses,
        data_coverage: result.overall.dataQuality,
        model_version: MODEL_VERSION,
        change_from_previous: result.overall.change,
        change_reasons: result.overall.changeReasons,
        source_ids: result.sourceIds,
        calculated_at: new Date().toISOString()
      };
      // Idempotent: one snapshot per user/date/model version.
      await supabaseClient
        .from("athlevo_score_history")
        .upsert(row, { onConflict: "user_id,score_date,model_version" });
    } catch (error) {
      // Table may not be migrated yet — never block the UI.
      console.warn("Score snapshot not saved:", error && error.message);
    }
  }

  /* ─────────────────────── refresh (client glue) ───────────────────── */

  let lastResult = null;
  let lastFitness = null;
  let scoreHistory = [];

  async function refresh(activities, profile) {
    const mount = document.getElementById("athlevoScoreCard");
    if (!mount) return null;
    try {
      const {
        data: { user }
      } = await supabaseClient.auth.getUser();
      if (!user) return null;

      // Reuse existing systems: fitness (level/paces) from AthleteModel,
      // merged/de-duplicated items from the trends engine.
      lastFitness = window.AthleteModel ? await window.AthleteModel.getFitness(true) : null;

      let acts = activities;
      if (!Array.isArray(acts) && window.AthlevoBrain) {
        acts = await window.AthlevoBrain.loadAthleteActivities(200);
      }
      const executions = window.AthlevoTrends
        ? await loadExecutions(user.id) : [];
      const items = window.AthlevoTrends
        ? window.AthlevoTrends.mergeTrainingItems(acts || [], executions) : [];

      const raceResults = await loadRaceResults(user.id);
      scoreHistory = await loadPriorScore(user.id);
      const prior = scoreHistory.find(h => h.overall_score != null) || null;

      const result = computeAthlevoScore({
        items, fitness: lastFitness, profile: profile || {},
        raceResults, priorScore: prior, now: new Date()
      });
      lastResult = result;

      renderScoreCard(result);

      // Persist a daily snapshot (deduped) only when we have a real score,
      // so history reflects genuine development.
      if (result.overall.score != null) {
        await saveSnapshot(user.id, result, profile && profile.timezone);
        scoreHistory = await loadPriorScore(user.id);
      }
      return result;
    } catch (error) {
      console.error("Athlevo Score refresh failed:", error);
      return null;
    }
  }

  async function loadExecutions(userId) {
    try {
      const { data } = await supabaseClient
        .from("workout_execution_records")
        .select("status,completed_at,updated_at,created_at,actual_duration_minutes,actual_distance_km,actual_average_hr,actual_rpe,pain_present,skip_reason,original_session_snapshot,imported_activity_id,training_session_id")
        .eq("user_id", userId);
      return Array.isArray(data) ? data : [];
    } catch (error) { return []; }
  }

  async function loadRaceResults(userId) {
    try {
      const { data } = await supabaseClient
        .from("race_results")
        .select("id,race_type,race_date,distance_meters,duration_seconds,source")
        .eq("user_id", userId);
      return Array.isArray(data) ? data : [];
    } catch (error) { return []; }
  }

  window.AthlevoScore = {
    MODEL_VERSION,
    computeAthlevoScore,   // pure, exported for tests
    deriveStats,
    computeDelta,          // pure, exported for tests (Part 2 deltas)
    refresh,
    openDetails,
    closeDetails,
    renderScoreCard
  };
  window.renderAthlevoScoreCard = refresh; // repoint the existing hook
})();
