/* Athlevo — Coach Brain V1 (client mirror of lib/server/coachBrain.js).
   Pure reasoning. Exposed as window.AthlevoCoachBrain. Parity-tested. */
(function(){
"use strict";
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/* ═══════════════════════════ insight rules ═══════════════════════════
 *
 * Each rule is a pure function (signals) → insight | null. An insight is:
 *   { type, observation, reasoning, action, confidence, importance }
 * Rules return null when the evidence is insufficient — never a guess.
 * `importance` (0–100) orders which few insights the athlete actually sees;
 * safety/fatigue and compliance rank above positive-progress and info.
 */

// 1 · Threshold pace improvement (with HR context).
function ruleThresholdImprovement(s) {
  const imp = num(get(s, "threshold.improvedSecPerKm"));
  const sessions = num(get(s, "threshold.sessions")) || 0;
  if (imp == null || imp < 3 || sessions < 2) return null;
  const hrStable = get(s, "hr.stable") === true;
  const hrAvail = get(s, "hr.available") === true;
  return {
    type: "threshold_improvement",
    observation: `Threshold pace improved ${Math.round(imp)} sec/km over the last 3 weeks.`,
    reasoning: hrStable
      ? "Heart rate held steady while pace improved, indicating increased aerobic efficiency."
      : "Pace improved across comparable threshold sessions.",
    action: "Increase next week's threshold volume by one interval.",
    confidence: (hrAvail && sessions >= 3) ? "high" : "medium",
    importance: 70
  };
}

// 2 · Long-run durability building.
function ruleDurability(s) {
  const count = num(get(s, "longRun.count")) || 0;
  if (count < 3 || get(s, "longRun.highFatigue") === true) return null;
  return {
    type: "durability",
    observation: `You completed ${count} long runs without excessive fatigue.`,
    reasoning: "Durability is increasing.",
    action: "Long run will increase by about 10 minutes next week.",
    confidence: get(s, "hr.available") === true ? "high" : "medium",
    importance: 60
  };
}

// 3 · Easy pace slowed at similar HR → fatigue / heat.
function ruleEasySlowed(s) {
  const slowed = num(get(s, "easyPace.slowedSecPerKm"));
  if (slowed == null || slowed < 5 || get(s, "hr.similar") !== true) return null;
  return {
    type: "easy_slowed_fatigue",
    observation: "Easy pace slowed despite a similar average heart rate.",
    reasoning: "This usually reflects accumulated fatigue or heat stress.",
    action: "Keep today's run relaxed and skip any progression.",
    confidence: "medium",
    importance: 86
  };
}

// 4 · Missed sessions → rebuild consistency.
function ruleMissed(s) {
  const missed = num(get(s, "missed.count")) || 0;
  if (missed < 2) return null;
  return {
    type: "missed_sessions",
    observation: `${missed} sessions were missed in the last ${num(get(s, "missed.windowDays")) || 10} days.`,
    reasoning: "Consistency drives adaptation more than any single session.",
    action: "The plan eases slightly to rebuild rhythm before progressing.",
    confidence: "high",
    importance: 80
  };
}

// 5 · Load spike / deload from acute:chronic ratio.
function ruleLoadBalance(s) {
  const acwr = num(get(s, "recovery.acwr"));
  if (acwr == null) return null;
  if (acwr > 1.5) {
    return {
      type: "load_spike",
      observation: `Training load rose sharply relative to your recent baseline (ratio ${acwr.toFixed(2)}).`,
      reasoning: "A rapid load increase raises injury and overreaching risk.",
      action: "Hold volume steady this week and protect recovery.",
      confidence: "high",
      importance: 88
    };
  }
  if (acwr < 0.75) {
    return {
      type: "deload",
      observation: "Training load has dropped below your recent baseline.",
      reasoning: "This looks like a deload or a break in training.",
      action: "Ease back in gradually rather than resuming full volume at once.",
      confidence: "medium",
      importance: 55
    };
  }
  return null;
}

// 6 · Low readiness today.
function ruleReadiness(s) {
  const score = num(get(s, "readiness.score"));
  if (score == null || score >= 55) return null;
  return {
    type: "readiness_low",
    observation: `Readiness is low today${get(s, "readiness.status") ? ` (${get(s, "readiness.status")})` : ""}.`,
    reasoning: "Your capacity to absorb hard training is reduced right now.",
    action: "Keep today easy and follow effort rather than pace.",
    confidence: "high",
    importance: 84
  };
}

// 7 · Athlevo Score change.
function ruleScoreChange(s) {
  const change = num(get(s, "athlevoScore.change"));
  if (change == null || change === 0) return null;
  const reason = get(s, "athlevoScore.reason");
  return {
    type: "athlevo_score",
    observation: `Your Athlevo Score ${change > 0 ? "rose" : "eased"} ${Math.abs(change)} recently.`,
    reasoning: reason || (change > 0
      ? "Sustained training evidence supports a higher development estimate."
      : "Recent evidence softened the development estimate slightly."),
    action: change > 0
      ? "Keep the current structure — it is working."
      : "Prioritise consistency to stabilise it; the score resists single sessions.",
    confidence: "medium",
    importance: 48
  };
}

// 8 · Weekly volume change vs. same point last week.
function ruleVolume(s) {
  const dk = num(get(s, "volume.deltaKm"));
  const comparable = get(s, "volume.comparable") === true;
  if (dk == null || !comparable || Math.abs(dk) < 3) return null;
  const up = dk > 0;
  return {
    type: "weekly_volume",
    observation: `Weekly running is ${up ? "up" : "down"} ${Math.abs(dk).toFixed(1)} km versus the same point last week.`,
    reasoning: up
      ? "Volume is progressing within a sustainable range."
      : "A lighter week can be intentional recovery — not a setback.",
    action: up ? "Keep the increase modest to consolidate the load."
      : "Hold the plan steady; there is no need to make up the difference.",
    confidence: "medium",
    importance: 42
  };
}

// 9 · Race proximity → sharpening phase.
function ruleRaceProximity(s) {
  const days = num(get(s, "race.daysToRace"));
  if (days == null || days < 0 || days > 21) return null;
  return {
    type: "race_proximity",
    observation: `Your goal race is ${days} day${days === 1 ? "" : "s"} away.`,
    reasoning: "You are entering the sharpening phase.",
    action: "Volume trends down while intensity stays race-specific.",
    confidence: "high",
    importance: 76
  };
}

// 10 · Strong consistency.
function ruleConsistency(s) {
  const pct = num(get(s, "consistency.completionPct"));
  const weeks = num(get(s, "consistency.weeksActive")) || 0;
  if (pct == null || pct < 80 || weeks < 3) return null;
  return {
    type: "consistency",
    observation: `You've trained consistently for ${weeks} weeks (${Math.round(pct)}% of recorded sessions completed).`,
    reasoning: "Consistent aerobic work is the foundation of durable progress.",
    action: "Maintain the current rhythm before adding load.",
    confidence: "high",
    importance: 40
  };
}

// 11 · Pain feedback → remove intensity.
function rulePain(s) {
  if (get(s, "pain.present") !== true) return null;
  return {
    type: "pain",
    observation: "You reported pain during recent training.",
    reasoning: "Running through altered mechanics risks a larger setback.",
    action: "Remove or reduce intensity, and stop if your stride changes.",
    confidence: "high",
    importance: 92
  };
}

const RULES = [
  rulePain,
  ruleLoadBalance,
  ruleEasySlowed,
  ruleReadiness,
  ruleMissed,
  ruleRaceProximity,
  ruleThresholdImprovement,
  ruleDurability,
  ruleConsistency,
  ruleScoreChange,
  ruleVolume
];

/*
 * Generate ranked coaching insights from a signals bundle. Returns at most
 * `limit` (default 3) — the highest-value ones, ordered by importance then
 * confidence. Never overwhelms; never fabricates.
 */
function generateInsights(signals, options) {
  options = options || {};
  const limit = options.limit || 3;
  const insights = [];
  for (const rule of RULES) {
    try {
      const r = rule(signals || {});
      if (r) insights.push(r);
    } catch (error) { /* a bad signal never breaks the panel */ }
  }
  insights.sort((a, b) =>
    (b.importance - a.importance) ||
    (CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])
  );
  return insights.slice(0, limit);
}

/* ═══════════════════ adaptation explanations (Training Updated) ══════════
 *
 * Turns plan-engine change objects into athlete-facing previous → new → why
 * blocks. Reuses the engine's reasons; adds no new adaptation logic.
 */
const ACTION_TITLES = {
  move_quality: "Quality session moved",
  move_long_run: "Long run rescheduled",
  replace_with_aerobic: "Session replaced",
  reduce_tomorrow: "Tomorrow eased",
  reduce_next_week: "Next week eased",
  reduce_progression: "Progression reduced",
  note_extra_quality: "Extra effort accounted for"
};

function explainAdaptation(changes, options) {
  options = options || {};
  const limit = options.limit || 3;
  const out = [];
  (changes || []).forEach(c => {
    if (!c || !c.action) return;
    const block = {
      title: ACTION_TITLES[c.action] || "Training updated",
      previous: c.previous || defaultPrevious(c),
      next: c.next || defaultNext(c),
      why: c.reason || "Adjusted to keep your week safe and coherent.",
      confidence: c.confidence === "high" ? "high" : c.confidence === "low" ? "low" : "medium",
      needsConfirmation: c.needsConfirmation === true
    };
    out.push(block);
  });
  return out.slice(0, limit);
}

function defaultPrevious(c) {
  switch (c.action) {
    case "move_quality": return "Quality session as originally scheduled";
    case "move_long_run": return "Long run on its planned day";
    case "reduce_tomorrow": return "A harder session tomorrow";
    case "reduce_next_week": return "Next week at full planned load";
    case "reduce_progression": return "Continuing to add load";
    case "replace_with_aerobic": return "A missed quality session";
    default: return "Previous plan";
  }
}
function defaultNext(c) {
  switch (c.action) {
    case "move_quality": return c.targetDate ? `Moved to ${c.targetDate}` : "Rescheduled later this week";
    case "move_long_run": return c.targetDate ? `Rescheduled to ${c.targetDate}` : "Rescheduled later this week";
    case "reduce_tomorrow": return "Tomorrow eased to aid adaptation";
    case "reduce_next_week": return "Next week's load reduced";
    case "reduce_progression": return "Progression paused to rebuild consistency";
    case "replace_with_aerobic": return "Replaced with an easy aerobic run";
    default: return "Updated plan";
  }
}

window.AthlevoCoachBrain = { generateInsights, explainAdaptation, COACH_BRAIN_VERSION:"coach-brain-v1" };

})();
