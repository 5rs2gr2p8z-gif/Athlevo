/*
 * Athlevo — Workout Guidance (client mirror of lib/server/workoutGuidance.js).
 * Verbatim logic; reuses window.AthlevoPaceService. Exposed as
 * window.AthlevoWorkoutGuidance. Parity-tested.
 */
(function(){
  "use strict";
const getZoneGuidance = (fitness,key,opts)=>window.AthlevoPaceService.getZoneGuidance(fitness,key,opts);

const REST_RE = /rest|off|day.?off/i;
const LONG_RE = /long/i;
const THRESHOLD_RE = /threshold/i;
const TEMPO_RE = /tempo|control|cruise|steady/i;
const VO2_RE = /vo2|interval/i;
const REP_RE = /repetition|\brep\b|reps|stride|speed/i;
const MARATHON_RE = /marathon/i;
const PROGRESSION_RE = /progression|prog\b|control|finish/i;
const RECOVERY_RE = /recovery|shakeout/i;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Canonical workout kind from a session type string.
function workoutKind(session) {
  const t = String(session && session.session_type || "").toLowerCase();
  if (REST_RE.test(t)) return "rest";
  if (THRESHOLD_RE.test(t)) return "threshold";
  if (VO2_RE.test(t)) return "vo2";
  if (REP_RE.test(t)) return "repetition";
  if (MARATHON_RE.test(t)) return "marathon";
  if (LONG_RE.test(t)) return "long";
  if (TEMPO_RE.test(t)) return "tempo";
  if (RECOVERY_RE.test(t)) return "recovery";
  return "easy";
}

// Zone guidance → { pace, rpe, explanation } with an effort fallback.
function zone(fitness, key) {
  const g = getZoneGuidance(fitness, key) || {};
  return {
    pace: g.paceRange ? g.paceRange.text : null,
    rpe: g.rpe ? g.rpe.text : null,
    explanation: g.explanation || "",
    hasPace: !!(g.paceRange && g.paceRange.text)
  };
}
function target(z) { return z.pace ? z.pace : "by effort"; }

// Concise, relevant condition rules (Part 7) — never a wall of text.
const RULES = {
  effort: "Use effort rather than pace in heat or on hills.",
  hr: "Don't chase the pace if effort or heart rate is unusually high.",
  pain: "If pain changes your stride, stop the quality portion.",
  strides: "Strides are fast and relaxed, not maximal sprints.",
  treadmill: "On a treadmill or with poor GPS, follow effort and duration."
};
function rulesFor(kind, rpeOnly) {
  let list;
  if (kind === "threshold" || kind === "vo2") list = [RULES.effort, RULES.pain, RULES.hr];
  else if (kind === "repetition") list = [RULES.strides, RULES.pain];
  else if (kind === "long" || kind === "marathon") list = [RULES.effort, RULES.hr];
  else list = [RULES.effort];
  if (rpeOnly) list = [RULES.effort, RULES.treadmill].concat(kind === "repetition" ? [RULES.strides] : []);
  return list.slice(0, 3);
}

function seg(fields) { return fields; }

/*
 * Build the segment list for a workout kind. Prefers explicit fields on the
 * session (structured_segments, warmup/main_set/cooldown, reps) and fills in
 * sensible, athlete-specific defaults otherwise.
 */
function buildSegments(kind, session, fitness) {
  const dur = num(session.duration_minutes);
  const dist = num(session.distance_km);
  const easy = zone(fitness, "easy");
  const recovery = zone(fitness, "recovery");
  const tempo = zone(fitness, "tempo");
  const threshold = zone(fitness, "threshold");
  const vo2 = zone(fitness, "vo2");
  const rep = zone(fitness, "repetition");
  const marathon = zone(fitness, "marathon");
  const longz = zone(fitness, "long");

  const wu = 15, cd = 12; // default warm-up / cool-down minutes for quality

  if (kind === "rest") {
    return [seg({ kind: "rest", label: "Rest", instruction: "Full rest or gentle mobility. Let today's training absorb." })];
  }

  if (kind === "recovery") {
    return [seg({
      kind: "steady", label: "Recovery run",
      durationMin: dur || 30, zone: "recovery", pace: recovery.pace, rpe: recovery.rpe,
      instruction: recovery.explanation
    })];
  }

  if (kind === "easy") {
    return [seg({
      kind: "steady", label: "Easy run",
      durationMin: dur || 45, distanceMeters: dist ? dist * 1000 : null,
      zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: easy.explanation
    })];
  }

  if (kind === "long") {
    const total = dur || 120;
    const wantsControl = PROGRESSION_RE.test(String(session.session_type || "")) ||
      PROGRESSION_RE.test(String(session.purpose || ""));
    if (wantsControl) {
      const controlMin = clamp(Math.round(total * 0.2), 15, 30);
      const cool = clamp(Math.round(total * 0.06), 5, 12);
      const easyMin = total - controlMin - cool;
      return [
        seg({ kind: "steady", label: `First ${easyMin} min`, durationMin: easyMin, zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: "Relaxed, conversational endurance running." }),
        seg({ kind: "control", label: `Final ${controlMin} min — controlled`, durationMin: controlMin, zone: "tempo", pace: tempo.pace, rpe: tempo.rpe, instruction: tempo.explanation, adjustmentRule: "Controlled finish, not a race. If effort rises above RPE 6, slow down." }),
        seg({ kind: "cooldown", label: "Cool-down", durationMin: cool, zone: "recovery", pace: recovery.pace, rpe: recovery.rpe, instruction: "Easy cool-down." })
      ];
    }
    return [seg({
      kind: "steady", label: "Long run", durationMin: total,
      distanceMeters: dist ? dist * 1000 : null,
      zone: "long", pace: longz.pace, rpe: longz.rpe, instruction: longz.explanation
    })];
  }

  if (kind === "threshold") {
    const mainMin = Math.max(16, (dur || 60) - wu - cd);
    const repMin = 8;
    const reps = clamp(Math.round(mainMin / (repMin + 2)), 3, 6);
    return [
      seg({ kind: "warmup", label: "Warm-up", durationMin: `${wu}–${wu + 5}`, zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: "Easy running to prepare for quality work." }),
      seg({ kind: "threshold", label: "Main set", repetitions: reps, repDurationMin: repMin, recoverySec: 120, zone: "threshold", pace: threshold.pace, rpe: threshold.rpe, instruction: threshold.explanation, recoveryInstruction: "2 min easy jog between reps", adjustmentRule: RULES.effort }),
      seg({ kind: "cooldown", label: "Cool-down", durationMin: `${cd}–${cd + 3}`, zone: "recovery", pace: recovery.pace, rpe: recovery.rpe, instruction: "Easy cool-down." })
    ];
  }

  if (kind === "vo2") {
    const mainMin = Math.max(12, (dur || 55) - wu - cd);
    const repMin = 3;
    const reps = clamp(Math.round(mainMin / (repMin + 3)), 4, 8);
    return [
      seg({ kind: "warmup", label: "Warm-up", durationMin: `${wu}–${wu + 5}`, zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: "Easy running, then a few strides." }),
      seg({ kind: "interval", label: "Main set", repetitions: reps, repDurationMin: repMin, recoverySec: 180, zone: "vo2", pace: vo2.pace, rpe: vo2.rpe, instruction: vo2.explanation, recoveryInstruction: "3 min easy jog between reps", adjustmentRule: RULES.pain }),
      seg({ kind: "cooldown", label: "Cool-down", durationMin: `${cd}–${cd + 3}`, zone: "recovery", pace: recovery.pace, rpe: recovery.rpe, instruction: "Easy cool-down." })
    ];
  }

  if (kind === "repetition") {
    return [
      seg({ kind: "warmup", label: "Warm-up", durationMin: `${wu}–${wu + 5}`, zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: "Easy running plus a few build-ups." }),
      seg({ kind: "strides", label: "Reps / strides", repetitions: 8, repDurationSec: 30, recoverySec: 90, zone: "repetition", pace: rep.pace, rpe: rep.rpe, instruction: rep.explanation, recoveryInstruction: "Full easy-jog or walk recovery", adjustmentRule: RULES.strides }),
      seg({ kind: "cooldown", label: "Cool-down", durationMin: `${cd}`, zone: "recovery", pace: recovery.pace, rpe: recovery.rpe, instruction: "Easy cool-down." })
    ];
  }

  if (kind === "tempo") {
    const mainMin = Math.max(15, (dur || 50) - wu - cd);
    return [
      seg({ kind: "warmup", label: "Warm-up", durationMin: `${wu}–${wu + 5}`, zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: "Easy running." }),
      seg({ kind: "steady", label: "Tempo / control", durationMin: mainMin, zone: "tempo", pace: tempo.pace, rpe: tempo.rpe, instruction: tempo.explanation, adjustmentRule: RULES.effort }),
      seg({ kind: "cooldown", label: "Cool-down", durationMin: `${cd}`, zone: "recovery", pace: recovery.pace, rpe: recovery.rpe, instruction: "Easy cool-down." })
    ];
  }

  if (kind === "marathon") {
    const mainMin = Math.max(20, (dur || 70) - wu - cd);
    return [
      seg({ kind: "warmup", label: "Warm-up", durationMin: `${wu}`, zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: "Easy running." }),
      seg({ kind: "steady", label: "Marathon-pace block", durationMin: mainMin, zone: "marathon", pace: marathon.pace, rpe: marathon.rpe, instruction: marathon.explanation, adjustmentRule: RULES.hr }),
      seg({ kind: "cooldown", label: "Cool-down", durationMin: `${cd}`, zone: "recovery", pace: recovery.pace, rpe: recovery.rpe, instruction: "Easy cool-down." })
    ];
  }

  // Fallback: an easy prescription is always safe.
  return [seg({ kind: "steady", label: "Run", durationMin: dur || 40, zone: "easy", pace: easy.pace, rpe: easy.rpe, instruction: easy.explanation })];
}

const PURPOSE = {
  rest: "Recovery so the training you've done can adapt.",
  recovery: "Promote blood flow and recovery without adding stress.",
  easy: "Build aerobic base at a comfortable, sustainable effort.",
  long: "Build endurance and durability over time on feet.",
  threshold: "Raise the pace you can sustain — controlled hard, not all-out.",
  vo2: "Develop top-end aerobic power with hard-but-repeatable efforts.",
  repetition: "Sharpen speed and economy while staying relaxed.",
  tempo: "Practice comfortably focused, controlled running.",
  marathon: "Rehearse goal-race effort and fuelling.",
  progression: "Build endurance while practising a controlled finish without racing it."
};

/*
 * Public: full structured guidance for a planned session. `fitness` is the
 * athlete model / engine fitness object (the pace service reads it).
 */
function generateWorkoutGuidance(session, fitness, options) {
  options = options || {};
  const kind = workoutKind(session);
  const rpeOnly = !zone(fitness, "easy").hasPace; // no reliable paces → RPE-first

  const segments = buildSegments(kind, session, fitness);

  // Primary (collapsed-card) target = the main working segment.
  const main = segments.find(s => ["threshold", "interval", "control", "strides", "steady"].includes(s.kind))
    || segments[0];
  let primaryTargetText;
  if (kind === "long" && segments.some(s => s.kind === "control")) {
    const e = segments[0], c = segments.find(s => s.kind === "control");
    primaryTargetText = `Easy ${target({ pace: e.pace })} · final control ${target({ pace: c.pace })}`;
  } else if (main.repetitions) {
    const unit = main.repDurationMin ? `${main.repDurationMin} min` : `${main.repDurationSec} sec`;
    primaryTargetText = `${main.repetitions} × ${unit} @ ${target({ pace: main.pace })}`;
  } else {
    primaryTargetText = `${main.label.replace(/^First .* min$/, "Easy")} ${target({ pace: main.pace })}`.trim();
  }

  const rpes = segments.map(s => s.rpe).filter(Boolean);

  return {
    version: "workout-guidance-v1",
    sessionType: session.session_type || null,
    kind,
    title: session.title || null,
    purpose: (session.purpose && String(session.purpose).trim()) || PURPOSE[kind] || PURPOSE.easy,
    totalDurationMin: num(session.duration_minutes),
    totalDistanceKm: num(session.distance_km),
    primaryTargetText,
    primaryRpeText: rpes.length ? rangeOf(rpes) : null,
    segments,
    adjustments: rulesFor(kind, rpeOnly),
    rpeOnly,
    paceSource: options.paceSource || null,
    confidence: options.confidence || null
  };
}

// "RPE 2–6" spanning the min/max across segment RPE strings.
function rangeOf(rpeTexts) {
  const nums = [];
  rpeTexts.forEach(t => {
    const m = String(t).match(/(\d+)\D+(\d+)/);
    if (m) { nums.push(Number(m[1]), Number(m[2])); }
  });
  if (!nums.length) return null;
  const lo = Math.min(...nums), hi = Math.max(...nums);
  return lo === hi ? `RPE ${lo}` : `RPE ${lo}–${hi}`;
}

window.AthlevoWorkoutGuidance = { generateWorkoutGuidance, WORKOUT_GUIDANCE_VERSION: "workout-guidance-v1" };

})();
