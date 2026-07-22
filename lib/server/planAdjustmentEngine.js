/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — PlanAdjustmentEngine   ·  Adaptive Smart Plan v2   ·  pure, no I/O
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The coach's decision layer. Given the athlete's TrainingMemory, the
 *  upcoming (still-planned) sessions, and recent per-discipline outcomes, it
 *  returns the SMALLEST set of changes that keep the plan honest — never a
 *  whole new calendar. Deterministic, rule-based, no AI, no I/O, no UI.
 *
 *  Guarantees:
 *    · Plan stability — only sessions that genuinely need changing appear in
 *      `changes`; everything else is left exactly as prescribed.
 *    · One thing at a time — a "progress" week advances a SINGLE discipline.
 *    · Every change carries a stored, human reason (Part 6).
 *
 *  Input:
 *    adjustPlan({
 *      memory,                      // buildTrainingMemory(...) output
 *      upcoming:[ { id?, date, type, distanceKm, durationMin,
 *                   workMinutes?, reps?, quality?, long? } ],
 *      outcomes?:{ threshold:"easy"|"on_target"|"hard", vo2:…, long:… },
 *      completedWeek?:{ weekStart, sessions:[…] },   // optional → weekly review
 *      todayKey?
 *    })
 */

import { progressDiscipline } from "./progressionRules.js";
import { buildWeeklyReview } from "./weeklyReview.js";

export const ADJUSTMENT_CONFIG = {
  fatigueHoldLevel: "high",        // fatigue level that blocks all progression
  missedQualityReduce: 2,          // ≥ this many missed quality → reduce
  // Which discipline a block progresses when everything is green.
  blockFocus: { Base: "long", Build: "threshold", Peak: "vo2", Recovery: null }
};

export const PLAN_ADJUSTMENT_VERSION = "plan-adjustment-v1";

function typeKey(t) { return String(t || "").toLowerCase().replace(/\s*(session|run)\s*$/, "").trim(); }
function disciplineOf(type) {
  const k = typeKey(type);
  if (/threshold/.test(k)) return "threshold";
  if (/vo2|interval/.test(k)) return "vo2";
  if (/tempo/.test(k)) return "tempo";
  if (/long/.test(k)) return "long";
  if (/recovery/.test(k)) return "recovery";
  return "easy";
}
function nextOfDiscipline(upcoming, disc) {
  return upcoming.find(s => disciplineOf(s.type) === disc) || null;
}
function isEasyOrRestSlot(s) {
  const d = disciplineOf(s.type);
  return d === "easy" || d === "recovery";
}

function change(session, action, field, from, to, reason, confidence) {
  return {
    sessionId: session && session.id != null ? session.id : null,
    date: session && session.date ? String(session.date).slice(0, 10) : null,
    discipline: session ? disciplineOf(session.type) : null,
    action, field,
    from: from != null ? from : null,
    to: to != null ? to : null,
    reason, confidence
  };
}

/*
 * Decide the week's overall posture from the training state. Priority order
 * is deliberate: safety (fatigue) first, then honesty about missed work, then
 * reward for consistency, then the neutral default.
 */
function decidePosture(memory) {
  const fat = memory && memory.fatigue ? memory.fatigue : { level: "moderate", trend: "steady" };
  if (fat.level === ADJUSTMENT_CONFIG.fatigueHoldLevel) return "recover";
  if ((memory.missedQualityCount || 0) >= ADJUSTMENT_CONFIG.missedQualityReduce) return "reduce";
  const excellent = memory.consistency && memory.consistency.label === "Excellent";
  const fresh = fat.level === "low" && fat.trend !== "rising";
  if (excellent && fresh) return "progress";
  return "maintain";
}

export function adjustPlan(input = {}) {
  const memory = input.memory || {};
  const upcoming = (Array.isArray(input.upcoming) ? input.upcoming.filter(Boolean) : [])
    .slice().sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  const outcomes = input.outcomes || {};
  const confidence = memory.confidence || "low";
  const posture = decidePosture(memory);
  const changes = [];
  const notes = [];

  // ── 1. Reschedule a missed long run (independent of posture) ─────────
  if (memory.missedLongRun) {
    const missed = (memory.recentMissed || []).find(m => m.long);
    const slot = upcoming.find(isEasyOrRestSlot) || null;
    if (slot) {
      changes.push(change(slot, "reschedule", "type", disciplineOf(slot.type), "long",
        `Long run moved to ${slot.date} because the ${missed ? missed.date + " " : ""}long run was missed.`,
        confidence));
    } else {
      notes.push("Long run missed but no suitable slot to reschedule this cycle.");
    }
  }

  // ── 2. Posture-driven adjustments ────────────────────────────────────
  if (posture === "recover") {
    // Protect recovery: convert the next quality session to easy aerobic.
    const q = upcoming.find(s => ["threshold", "vo2", "tempo"].includes(disciplineOf(s.type)));
    if (q) changes.push(change(q, "convert", "type", disciplineOf(q.type), "easy",
      "Next quality session eased to aerobic — fatigue is high, so maintain rather than progress.",
      confidence));
    else notes.push("Fatigue high — holding the week, no progression.");
  } else if (posture === "reduce") {
    // Two+ missed quality → pull back the next quality session's volume.
    const disc = ["threshold", "vo2", "tempo"].map(d => nextOfDiscipline(upcoming, d)).find(Boolean);
    if (disc) {
      const d = disciplineOf(disc.type);
      const field = d === "vo2" ? "reps" : d === "threshold" ? "workMinutes" : "durationMin";
      const cur = disc[field];
      const to = typeof cur === "number" ? Math.max(1, d === "vo2" ? cur - 1 : Math.round(cur * 0.85)) : cur;
      changes.push(change(disc, "decrease", field, cur, to,
        "Progression reduced after two missed quality sessions — rebuild consistency first.", confidence));
    } else notes.push("Reducing progression after missed quality — no upcoming quality to trim.");
  } else if (posture === "progress") {
    // Advance exactly ONE discipline: the block's focus, if its last outcome
    // was clean; otherwise gently progress the long run.
    const focus = ADJUSTMENT_CONFIG.blockFocus[memory.block] || "long";
    const target = nextOfDiscipline(upcoming, focus);
    const outcome = outcomes[focus] || "on_target";
    const ctx = { allowProgression: true, lastOutcome: outcome,
      missedLastLong: memory.missedLongRun };
    let applied = false;
    if (target && (focus !== "threshold" && focus !== "vo2" ? true : outcome === "easy" || outcome === "on_target")) {
      const p = progressDiscipline(focus, target, ctx);
      if (p.changed) {
        changes.push(change(target, "increase", p.field, p.from, p.to, p.reason, confidence));
        applied = true;
      }
    }
    if (!applied) {
      const longS = nextOfDiscipline(upcoming, "long");
      if (longS) {
        const p = progressDiscipline("long", longS, { allowProgression: true, missedLastLong: memory.missedLongRun });
        if (p.changed) { changes.push(change(longS, "increase", p.field, p.from, p.to, p.reason, confidence)); applied = true; }
      }
    }
    if (!applied) notes.push("Everything is green, but no upcoming session was eligible to progress.");
  } else {
    notes.push("Plan on track — holding steady this week.");
  }

  const review = input.completedWeek ? buildWeeklyReview(input.completedWeek) : null;

  return {
    version: PLAN_ADJUSTMENT_VERSION,
    posture,
    changes,
    changed: changes.length,
    stable: changes.length === 0,              // nothing surprised the athlete
    unchangedCount: Math.max(0, upcoming.length - changes.length),
    reasons: changes.map(c => c.reason),       // Part 6: auditable reasons
    notes,
    weeklyReview: review,
    confidence
  };
}
