console.log("Athlevo Diagnostic v1 loaded");

/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Pre-Signup Running Diagnostic  (adaptive state machine)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  An adaptive diagnostic that runs BEFORE authentication to deliver
 *  coaching value upfront. The engine tracks which data points are known,
 *  which are missing, maintains limiter hypotheses, and decides which
 *  question would produce the most useful next information.
 *
 *  ARCHITECTURE:
 *  · Deterministic branching — no AI calls during the diagnostic itself.
 *  · Completion is diagnostic sufficiency (goal, timeline, capacity, load,
 *    context) plus an injury safety gate — not a full questionnaire walk.
 *  · All state in localStorage (survives OAuth redirects, tab interruptions).
 *  · Coaching interpretations are template-driven with clear interface for
 *    future AI-backed generation.
 *  · The result explains how the single Athlevo AI product would help.
 *  · Safety: never medically diagnoses. Injury questions flag for caution only.
 *
 *  DOES NOT TOUCH: Authentication, Supabase, subscriptions, onboarding,
 *  navigation of authenticated screens, payment configuration, or any
 *  existing entitlement logic.
 */

(function (root) {
"use strict";

/* ═══════════════════════════ CONSTANTS ═══════════════════════════════ */

var STORAGE_KEY = "athlevo_pending_diagnostic_v1";
var SCHEMA_VERSION = 1;
var ENGINE_VERSION = "diagnostic-engine-v3";
var STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
var MAX_HISTORY_LENGTH = 20;
var MODEL_REASONING_LIMITERS = [
  "consistency", "aerobic_base", "threshold_capacity", "excessive_intensity",
  "aerobic_durability", "pacing", "timeline_mismatch", "injury_risk", "unclear_baseline"
];
var MODEL_REASONING_EXPECTATIONS = [
  "realistic", "realistic_aggressive", "ambitious",
  "needs_baseline", "timeline_too_short", "clearance_first"
];
var MODEL_REASONING_CONCERNS = [
  "recent_layoff", "recent_sickness", "sudden_load_increase", "high_intensity_density",
  "long_run_load_mismatch", "poor_recovery", "recurring_niggle", "aggressive_race_start",
  "late_race_fade", "low_training_frequency", "goal_timeline_mismatch", "multiple_races",
  "hidden_cross_training_load", "strength_interference", "excessive_zone2_focus",
  "low_specificity", "inconsistent_training", "over_specific_too_early", "durability_gap"
];
var MODEL_REASONING_FLAGS = [
  "high_intensity_density", "late_fade", "aggressive_start", "recent_sickness",
  "recent_return", "only_easy_running", "short_timeline", "low_volume_for_goal",
  "strong_recent_baseline", "no_recent_baseline", "other_sport_load"
];
var MODEL_REASONING_SIGNATURE_KEYS = [
  "goal_distance", "goal_time", "goal_race", "goal_race_date",
  "weekly_mileage", "weekly_hours", "recent_longest_run_km",
  "recent_race_dist", "recent_race_time", "training_structure",
  "training_status", "recent_consistency", "training_days", "experience",
  "injury_has", "injury_status", "perceived_limiter", "other_training"
];
var MAX_TEXT_LENGTHS = {
  goal_race: 120,
  goal_time: 40,
  recent_race_time: 40,
  injury_area: 160,
  schedule_constraints: 240,
  training_structure_other: 160
};

function makeImportKey() {
  var random = "";
  try {
    var bytes = new Uint8Array(8);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i++) random += bytes[i].toString(16).padStart(2, "0");
  } catch (e) {}
  if (!random) random = Math.random().toString(36).slice(2, 14);
  return "diag_" + SCHEMA_VERSION + "_" + Date.now().toString(36) + "_" + random;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isKnownValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function isRaceDistance(distance) {
  return !!distance && distance !== "General fitness";
}

function isLongEnduranceDistance(distance) {
  return distance === "Marathon" || distance === "Ultra";
}

function isEnduranceDistance(distance) {
  return distance === "Half marathon" || distance === "Marathon" || distance === "Ultra";
}

function asKm(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? n : null;
}

function longRunFloorKm(goal) {
  if (goal === "Ultra") return 22;
  if (goal === "Marathon") return 18;
  if (goal === "Half marathon") return 12;
  if (goal === "10K") return 8;
  return 0;
}

function longRunAdequateKm(goal) {
  if (goal === "Ultra") return 28;
  if (goal === "Marathon") return 24;
  if (goal === "Half marathon") return 16;
  return 10;
}

function volumeIsSubstantial(km) {
  return km != null && km >= 50;
}

function volumeIsLowForGoal(goal, km) {
  if (km == null) return false;
  var min = { "5K": 12, "10K": 20, "Half marathon": 28, "Marathon": 40, "Ultra": 50 };
  return km < (min[goal] || 20);
}

function longRunIsShortForGoal(goal, longest) {
  var floor = longRunFloorKm(goal);
  return floor > 0 && longest != null && longest < floor;
}

function longRunIsAdequateForGoal(goal, longest) {
  return longest != null && longest >= longRunAdequateKm(goal);
}

function hasRecentRaceResult(a) {
  return !!(a && a.recent_race_dist && a.recent_race_dist !== "none" && a.recent_race_time);
}

function pendingFactFieldIndex() {
  var index = {};
  for (var i = 0; i < QUESTIONS.length; i++) {
    var fields = QUESTIONS[i].fields || [];
    for (var j = 0; j < fields.length; j++) {
      index[fields[j].id] = fields[j];
    }
  }
  return index;
}

function isValidPendingFactValue(field, value) {
  if (!field || value == null || value === "") return false;
  if (field.options) {
    var allowed = field.options.map(function (opt) { return String(opt.value); });
    if (Array.isArray(value)) {
      if (value.length > 12) return false;
      for (var i = 0; i < value.length; i++) {
        if (allowed.indexOf(String(value[i])) < 0) return false;
      }
      return value.length > 0;
    }
    return allowed.indexOf(String(value)) >= 0;
  }
  if (field.type === "number") {
    var n = Number(value);
    if (!isFinite(n)) return false;
    if (field.min != null && n < field.min) return false;
    if (field.max != null && n > field.max) return false;
    return true;
  }
  if (field.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  if (typeof value === "boolean") return true;
  if (typeof value === "string") {
    var limit = field.maxLength || MAX_TEXT_LENGTHS[field.id] || 200;
    return value.length > 0 && value.length <= limit;
  }
  if (typeof value === "number") return isFinite(value);
  return false;
}

/* Unknown/malformed pendingFacts are dropped, never used to invalidate
 * an otherwise-valid stored diagnostic. */
function sanitizePendingFacts(raw) {
  if (!isPlainObject(raw)) return {};
  var index = pendingFactFieldIndex();
  var out = {};
  var count = 0;
  for (var key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (!index[key] || count >= 24) continue;
    var value = raw[key];
    if (typeof value === "string") {
      var limit = index[key].maxLength || MAX_TEXT_LENGTHS[key] || 200;
      value = value.slice(0, limit);
    } else if (index[key].type === "number" && typeof value !== "number") {
      var parsed = Number(value);
      value = isFinite(parsed) ? parsed : value;
    }
    if (!isValidPendingFactValue(index[key], value)) continue;
    out[key] = value;
    count++;
  }
  return out;
}

function normalizeQuestionAnswers(question, input) {
  var output = {};
  for (var i = 0; i < question.fields.length; i++) {
    var field = question.fields[i];
    var value = input[field.id];
    if (typeof value === "string") {
      value = value.trim();
      var limit = field.maxLength || MAX_TEXT_LENGTHS[field.id] || 200;
      value = value.slice(0, limit);
    } else if (Array.isArray(value)) {
      value = value.slice(0, 12).map(function (item) { return String(item).slice(0, 80); });
    }
    if (value !== undefined) output[field.id] = value;
  }
  return output;
}

function hasOversizedText(questionAnswers) {
  for (var questionKey in questionAnswers) {
    if (!Object.prototype.hasOwnProperty.call(questionAnswers, questionKey)) continue;
    var q = DiagnosticEngine.getQuestion(questionKey);
    if (!q || !isPlainObject(questionAnswers[questionKey])) return true;
    for (var i = 0; i < q.fields.length; i++) {
      var field = q.fields[i];
      var value = questionAnswers[questionKey][field.id];
      var limit = field.maxLength || MAX_TEXT_LENGTHS[field.id] || 200;
      if (limit && typeof value === "string" && value.length > limit) return true;
    }
  }
  return false;
}

/* ═══════════════════════════ DATA POINTS ═════════════════════════════
 * Each data point the engine can collect. The engine tracks which are
 * known vs missing and uses this to decide the next question.
 */
var DATA_POINTS = {
  goal:              { priority: 1, category: "goal" },
  goal_distance:     { priority: 1, category: "goal" },
  goal_time:         { priority: 3, category: "goal" },
  goal_race:         { priority: 4, category: "goal" },
  goal_race_date:    { priority: 3, category: "goal" },
  experience:        { priority: 1, category: "capacity" },
  training_status:   { priority: 1, category: "capacity" },
  weekly_mileage:    { priority: 2, category: "capacity" },
  weekly_hours:      { priority: 4, category: "capacity" },
  recent_consistency:{ priority: 1, category: "capacity" },
  recent_longest_run_km: { priority: 2, category: "capacity" },
  recent_race_dist:  { priority: 3, category: "capacity" },
  recent_race_time:  { priority: 3, category: "capacity" },
  training_days:     { priority: 2, category: "training" },
  training_structure:{ priority: 1, category: "training" },
  train_time:        { priority: 4, category: "training" },
  schedule_constraints: { priority: 4, category: "training" },
  perceived_limiter: { priority: 2, category: "limiter" },
  injury_status:     { priority: 2, category: "safety" },
  other_training:    { priority: 4, category: "training" },
  strength_training: { priority: 4, category: "training" }
};

/* ═══════════════════════════ QUESTION BANK ═══════════════════════════
 * Each question definition. `provides` lists the data points it fills.
 * `eligible` is a function(state) → bool that decides if the question
 * should appear. `extract` maps answers into data point values.
 * `interpret` generates the coaching observation shown after answering.
 */
var QUESTIONS = [

  /* ── 1. Goal ────────────────────────────────────────────────────── */
  {
    key: "goal",
    eyebrow: "Your goal",
    title: "What’s your current running goal?",
    sub: "This shapes everything — how I'd build your training, what to prioritise, and what's realistic.",
    provides: ["goal", "goal_distance"],
    fields: [{
      id: "goal_distance", bare: true, type: "chips", layout: "cards",
      label: "Goal distance", required: true,
      options: [
        { label: "5K", value: "5K" },
        { label: "10K", value: "10K" },
        { label: "Half marathon", value: "Half marathon" },
        { label: "Marathon", value: "Marathon" },
        { label: "Ultra", value: "Ultra" },
        { label: "General fitness", value: "General fitness" }
      ]
    }],
    autoAdvance: true,
    extract: function (answers) {
      var d = answers.goal_distance;
      var goalType = d === "General fitness" ? "fitness" : "race";
      return { goal: goalType, goal_distance: d };
    },
    interpret: function (answers, state) {
      var d = answers.goal_distance;
      if (d === "General fitness") {
        return "No target race — that actually gives us more flexibility. I want to understand where your running is right now so I can find the highest-leverage change.";
      }
      if (d === "Marathon" || d === "Ultra") {
        return "A " + d.toLowerCase() + " is a genuine endurance challenge. The training that gets you there safely looks quite different depending on where you're starting — let me find out.";
      }
      if (d === "Half marathon") {
        return "The half marathon rewards consistency more than heroic volume. Let's see what your current running looks like so I can figure out where the real gains are.";
      }
      return d + " is a distance where specific training structure matters a lot. Let me understand your current capacity.";
    }
  },

  /* ── 2. Race details (conditional) ──────────────────────────────── */
  {
    key: "race_details",
    eyebrow: "Your goal",
    title: "Do you have a race in mind?",
    sub: "A date and target time sharpen everything — skip if you don't have one yet.",
    provides: ["goal_race", "goal_race_date", "goal_time"],
    eligible: function (state) {
      return state.known.goal && state.answers.goal !== "fitness";
    },
    fields: [
      { id: "goal_race", type: "text", label: "Race or event", optional: true,
        placeholder: "e.g. Chicago Marathon", maxLength: 120 },
      { id: "goal_race_date", type: "date", label: "Race date", optional: true },
      { id: "goal_time", type: "text", label: "Goal finish time", optional: true,
        placeholder: "e.g. sub-4:00, 1:45", maxLength: 40 }
    ],
    extract: function (answers) {
      return {
        goal_race: answers.goal_race || null,
        goal_race_date: answers.goal_race_date || null,
        goal_time: answers.goal_time || null
      };
    },
    interpret: function (answers, state) {
      if (answers.goal_race_date && answers.goal_time) {
        return "A concrete date and a target time — that gives me two real constraints to work backward from. Now I need to understand how far you are from that today.";
      }
      if (answers.goal_race_date) {
        return "Having a fixed date changes the training shape — I need to understand your current level to judge how much time we're really working with.";
      }
      return null; // No insight if they skipped everything
    }
  },

  /* ── 3. Experience ──────────────────────────────────────────────── */
  {
    key: "experience",
    eyebrow: "Your background",
    title: "How long have you been running?",
    sub: "This tells me how much training load your body has adapted to over time.",
    provides: ["experience"],
    fields: [{
      id: "experience", bare: true, type: "chips", layout: "cards",
      label: "Running experience", required: true,
      options: [
        { label: "New to running", value: "new" },
        { label: "1–2 years", value: "1_2_years" },
        { label: "3–5 years", value: "3_5_years" },
        { label: "5+ years", value: "5_plus" }
      ]
    }],
    autoAdvance: true,
    extract: function (answers) {
      return { experience: answers.experience };
    },
    interpret: function (answers, state) {
      var e = answers.experience;
      var goal = state.answers.goal_distance;
      if (e === "new") {
        if (goal === "Marathon" || goal === "Ultra") {
          return "New to running with a " + goal.toLowerCase() + " goal — that's ambitious but not impossible. Building your running durability safely is going to be the priority before anything else.";
        }
        return "Early in your running — that's actually an advantage. New runners respond faster to the right stimulus. I want to understand what your current week looks like.";
      }
      if (e === "5_plus") {
        return "With five-plus years, your body has real structural adaptation. The question is whether your current training is actually addressing what's limiting you — or just repeating what's comfortable.";
      }
      if (e === "3_5_years") {
        return "Three to five years means your aerobic foundation is there. At this stage, the biggest gains usually come from how your training is structured, not just from doing more.";
      }
      return "A year or two in — you've built a real base. The key now is whether you're progressing in the right direction or just maintaining.";
    }
  },

  /* ── 4. Current training status ─────────────────────────────────── */
  {
    key: "training_status",
    eyebrow: "Right now",
    title: "Where's your training at?",
    sub: "So I can meet you exactly where you are today.",
    provides: ["training_status"],
    fields: [{
      id: "training_status", bare: true, type: "chips", layout: "cards",
      label: "Current training status", required: true,
      options: [
        { label: "Just starting out", value: "starting" },
        { label: "Building base", value: "building_base" },
        { label: "In a training block", value: "training_block" },
        { label: "Coming back from a break", value: "returning" },
        { label: "Maintaining fitness", value: "maintaining" }
      ]
    }],
    autoAdvance: true,
    extract: function (answers) {
      return { training_status: answers.training_status };
    },
    interpret: function (answers, state) {
      var s = answers.training_status;
      var exp = state.answers.experience;
      if (s === "starting") {
        return "Starting from scratch — that means I need to be careful with how quickly volume builds. Let me understand what your week actually allows.";
      }
      if (s === "returning") {
        if (exp === "5_plus" || exp === "3_5_years") {
          return "Coming back with your experience means your aerobic system remembers more than your muscles do right now. The re-entry needs to respect that gap.";
        }
        return "Returning from a break — the first few weeks are about re-establishing consistency rather than chasing where you were. I need to understand your available time.";
      }
      if (s === "training_block") {
        return "Already in a structured block — so the question isn't whether you're training, but whether the structure is actually addressing your limiter.";
      }
      if (s === "maintaining") {
        return "Maintaining is comfortable, but comfort is often the plateau itself. I want to see whether your current structure is actually driving adaptation or just sustaining the status quo.";
      }
      return "Building a base — good. Let me see how much you're doing and whether the volume is in the right range for what comes next.";
    }
  },

  /* ── 5. Weekly volume ───────────────────────────────────────────── */
  {
    key: "weekly_volume",
    eyebrow: "Current capacity",
    title: "How much are you running right now?",
    sub: "Your current week — roughly is fine.",
    provides: ["weekly_mileage", "weekly_hours"],
    eligible: function (state) {
      // Not useful for true beginners with no running yet
      return state.answers.training_status !== "starting";
    },
    fields: [
      { id: "weekly_mileage", type: "number", label: "Weekly distance",
        unit: "km", min: 0, max: 500, required: true, placeholder: "e.g. 30", half: true },
      { id: "weekly_hours", type: "number", label: "Weekly hours",
        unit: "hrs", min: 0, max: 40, optional: true, placeholder: "e.g. 4", half: true }
    ],
    extract: function (answers) {
      return {
        weekly_mileage: answers.weekly_mileage ? Number(answers.weekly_mileage) : null,
        weekly_hours: answers.weekly_hours ? Number(answers.weekly_hours) : null
      };
    },
    interpret: function (answers, state) {
      var km = Number(answers.weekly_mileage) || 0;
      var goal = state.answers.goal_distance;
      var goalKm = { "5K": 5, "10K": 10, "Half marathon": 21.1, "Marathon": 42.2, "Ultra": 50 };
      var targetKm = goalKm[goal] || 0;

      if (km === 0) {
        return "No current volume — so we're starting from zero. That's a clear starting point, and the first priority is building consistency before anything else.";
      }
      if (targetKm > 0 && km < targetKm * 0.8) {
        return "You're running " + Math.round(km) + " km per week toward a " + goal + ". That gap tells me a lot — building volume safely without injury is going to be a central part of the strategy.";
      }
      if (targetKm > 0 && km >= targetKm * 2.5) {
        return Math.round(km) + " km per week is solid volume for " + goal + ". At this level, the gains are more likely in how sessions are structured than in simply adding more kilometres.";
      }
      if (km > 60) {
        return Math.round(km) + " km per week — that's real volume. The question is whether that mileage is doing the right kind of work. I want to understand how your week is structured.";
      }
      return Math.round(km) + " km per week — that gives me a clear starting baseline. Let me understand how that running time is distributed.";
    }
  },

  /* ── Goal-sensitive recent capacity ─────────────────────────────── */
  {
    key: "current_capacity",
    eyebrow: "Current capacity",
    title: "What has your recent running looked like?",
    sub: "Recent consistency matters more than an old personal best.",
    provides: ["recent_consistency", "recent_longest_run_km"],
    eligible: function (state) {
      if (!state.known.goal) return false;
      return state.answers.training_status === "starting" ||
        !!state.known.weekly_mileage ||
        !!state.known.training_status ||
        !!state.known.experience;
    },
    fields: [
      {
        id: "recent_consistency", type: "chips", label: "Last 6–8 weeks", required: true,
        options: [
          { label: "No consistent running", value: "none" },
          { label: "Occasional runs", value: "occasional" },
          { label: "Mostly consistent", value: "mostly_consistent" },
          { label: "Consistent every week", value: "consistent" }
        ]
      },
      {
        id: "recent_longest_run_km", type: "number", label: "Recent longest run",
        unit: "km", min: 0, max: 200, required: true, placeholder: "e.g. 12"
      }
    ],
    extract: function (answers) {
      return {
        recent_consistency: answers.recent_consistency,
        recent_longest_run_km: Number(answers.recent_longest_run_km) || 0
      };
    },
    interpret: function (answers, state) {
      var longest = Number(answers.recent_longest_run_km) || 0;
      var goal = state.answers.goal_distance;
      if (state.answers.training_status === "returning") {
        return "For a return from time off, recent consistency is the useful baseline — not what you could do before the break. We'll build from what your body is handling now.";
      }
      if ((goal === "Marathon" || goal === "Half marathon" || goal === "Ultra") && longest < 10) {
        return "Your recent longest run is still well below the demands of your goal. The first job is building durable, repeatable distance before adding race-specific work.";
      }
      if (goal === "General fitness") {
        return "That gives me enough of a current baseline for a fitness goal — consistency and a sustainable weekly rhythm matter more than race-specific numbers here.";
      }
      return "Your recent consistency and longest run give me a current-capacity baseline that is more useful than a lifetime best.";
    }
  },

  /* ── Recent performance (only when a time goal needs context) ───── */
  {
    key: "recent_performance",
    eyebrow: "Recent performance",
    title: "Do you have a recent race result?",
    sub: "This helps put a time goal in context. Choose none if you do not have a useful recent result.",
    provides: ["recent_race_dist", "recent_race_time"],
    eligible: function (state) {
      if (!state.known.goal || state.answers.goal === "fitness") return false;
      return !!state.answers.goal_time ||
        state.answers.goal_distance === "5K" ||
        state.answers.goal_distance === "10K" ||
        !!state.known.recent_consistency ||
        !!state.known.weekly_mileage;
    },
    fields: [
      {
        id: "recent_race_dist", type: "chips", label: "Recent race distance", required: true,
        options: [
          { label: "None", value: "none" },
          { label: "5K", value: "5K" },
          { label: "10K", value: "10K" },
          { label: "Half marathon", value: "Half marathon" },
          { label: "Marathon", value: "Marathon" }
        ]
      },
      {
        id: "recent_race_time", type: "text", label: "Finish time", required: true,
        placeholder: "e.g. 48:30 or 1:42:10", maxLength: 40,
        showWhen: { recent_race_dist: ["5K", "10K", "Half marathon", "Marathon"] }
      }
    ],
    extract: function (answers) {
      return {
        recent_race_dist: answers.recent_race_dist,
        recent_race_time: answers.recent_race_dist === "none" ? null : (answers.recent_race_time || null)
      };
    },
    interpret: function (answers) {
      if (answers.recent_race_dist === "none") {
        return "No recent result means the first training block should establish a fresh baseline before locking onto a precise pace target.";
      }
      return "A recent " + answers.recent_race_dist + " result gives us a practical performance anchor for judging the target time.";
    }
  },

  /* ── 6. Training days ───────────────────────────────────────────── */
  {
    key: "training_days",
    eyebrow: "Your week",
    title: "How many days can you train?",
    sub: "Be honest — consistency beats ambition.",
    provides: ["training_days"],
    eligible: function (state) {
      return !!state.known.goal && (
        !!state.known.recent_consistency ||
        !!state.known.training_status ||
        !!state.known.weekly_mileage ||
        !!state.known.experience
      );
    },
    fields: [{
      id: "training_days", bare: true, type: "chips",
      label: "Days per week", required: true,
      options: [
        { label: "2", value: 2 },
        { label: "3", value: 3 },
        { label: "4", value: 4 },
        { label: "5", value: 5 },
        { label: "6", value: 6 },
        { label: "7", value: 7 }
      ]
    }],
    autoAdvance: true,
    extract: function (answers) {
      return { training_days: Number(answers.training_days) };
    },
    interpret: function (answers, state) {
      var days = Number(answers.training_days);
      var goal = state.answers.goal_distance;
      if (days <= 3) {
        if (goal === "Marathon" || goal === "Ultra") {
          return days + " days per week for a " + goal.toLowerCase() + " — that's tight, but it can work if every session has a clear purpose. There's zero room for junk miles in that structure.";
        }
        return days + " days per week — quality over quantity. Each session needs to earn its place, which means I need to understand what's currently limiting your progress.";
      }
      if (days >= 6) {
        return days + " days a week is a real commitment. The risk at that frequency is that easy days aren't easy enough, so you're never fully recovered for the sessions that matter.";
      }
      return days + " days gives us enough room to separate easy running from quality work. Now I want to understand what's holding you back.";
    }
  },

  /* ── Current training structure ────────────────────────────────── */
  {
    key: "training_structure",
    eyebrow: "Your week",
    title: "What does a normal week currently look like?",
    sub: "The mix of sessions often reveals more than total mileage alone.",
    provides: ["training_structure"],
    eligible: function (state) {
      return !!(state.known.training_days || state.known.weekly_mileage || state.known.training_status);
    },
    fields: [
      {
        id: "training_structure", bare: true, type: "chips", layout: "cards",
        label: "Normal week", required: true,
        options: [
          { label: "Mostly easy runs", value: "mostly_easy" },
          { label: "Easy runs + long run", value: "easy_long" },
          { label: "Easy + tempo/intervals + long run", value: "balanced_quality" },
          { label: "Random runs depending on availability", value: "random" },
          { label: "I mostly run when I have a race", value: "race_only" },
          { label: "I follow another plan", value: "other_plan" },
          { label: "Other", value: "other" }
        ]
      },
      {
        id: "training_structure_other", type: "text", label: "Describe your week",
        required: true, maxLength: 160, showWhen: { training_structure: ["other"] },
        placeholder: "A short description is enough"
      }
    ],
    extract: function (answers) {
      return {
        training_structure: answers.training_structure,
        training_structure_other: answers.training_structure === "other" ? (answers.training_structure_other || null) : null
      };
    },
    interpret: function (answers) {
      if (answers.training_structure === "random" || answers.training_structure === "race_only") {
        return "Your week is being shaped by availability or race urgency rather than progression. A simpler repeatable structure is likely one of the highest-leverage changes.";
      }
      if (answers.training_structure === "mostly_easy") {
        return "Mostly easy running is a strong aerobic foundation. Whether it is enough depends on the goal and where your performance currently stalls.";
      }
      if (answers.training_structure === "balanced_quality") {
        return "You already have the main session types in place. The diagnostic now needs to separate a structure problem from a capacity or recovery problem.";
      }
      return null;
    }
  },

  /* ── 7. Perceived limiter ───────────────────────────────────────── */
  {
    key: "perceived_limiter",
    eyebrow: "Your challenge",
    title: "When a run falls apart, what usually fails first?",
    sub: "This is often the most telling answer.",
    provides: ["perceived_limiter"],
    eligible: function (state) {
      return !!(state.known.training_structure || state.known.training_status || state.known.weekly_mileage);
    },
    fields: [{
      id: "perceived_limiter", bare: true, type: "chips", layout: "cards",
      label: "Primary limiter", required: true,
      options: [
        { label: "Breathing / cardio gives out", value: "aerobic" },
        { label: "Legs fatigue before lungs", value: "muscular" },
        { label: "Pace drops in the second half", value: "endurance" },
        { label: "Pain or discomfort forces me to stop", value: "injury" },
        { label: "I lose motivation or mental focus", value: "mental" },
        { label: "I'm not sure — it just gets hard", value: "unclear" }
      ]
    }],
    autoAdvance: true,
    extract: function (answers) {
      return { perceived_limiter: answers.perceived_limiter };
    },
    interpret: function (answers, state) {
      var limiter = answers.perceived_limiter;
      var exp = state.answers.experience;
      if (limiter === "aerobic") {
        return "Breathing giving out first usually points to an aerobic-base limitation. The fix isn't more hard running — it's almost always more easy running at a pace that develops your oxidative system.";
      }
      if (limiter === "muscular") {
        if (exp === "new" || exp === "1_2_years") {
          return "If your breathing still feels controlled when your legs force you to stop, that points toward running durability rather than a pure cardiovascular limitation. It usually means your musculoskeletal system needs more time to adapt.";
        }
        return "Legs failing before lungs in an experienced runner suggests either cumulative fatigue from insufficient recovery, or a muscular-endurance gap that specific work can address.";
      }
      if (limiter === "endurance") {
        return "Fading in the second half is usually a pacing, specificity, or fuelling signature more than a simple fitness gap. The next question is whether your current long runs and intensity are actually race-specific.";
      }
      if (limiter === "injury") {
        return "Pain stopping your runs is the most important signal. Before we talk about training structure, I need to understand what's happening — Athlevo never pushes through pain, and I won't build a plan that does.";
      }
      if (limiter === "mental") {
        return "Motivation dropping mid-run often isn't a mental weakness — it can be a sign that training lacks variation, or that you're running at an intensity that's not quite hard enough to be engaging and not easy enough to feel comfortable.";
      }
      return "Not being sure what limits you is more common than you'd think. That's exactly what this diagnostic is designed to identify — the pattern usually becomes clear once I see the full picture.";
    }
  },

  /* ── 8. Injury / pain gate ──────────────────────────────────────── */
  {
    key: "injury_status",
    eyebrow: "Your body",
    title: "Any current pain, injuries, or recurring niggles?",
    sub: "Be specific — Athlevo builds around limitations, never through them. This is not a medical assessment.",
    provides: ["injury_status"],
    eligible: function (state) {
      return !!state.known.goal && (
        !!state.known.training_status ||
        !!state.known.weekly_mileage ||
        !!state.known.experience ||
        !!state.known.training_structure ||
        !!state.known.recent_consistency ||
        !!state.known.recent_race_time ||
        !!state.known.perceived_limiter
      );
    },
    fields: [
      {
        id: "injury_has", bare: true, type: "chips",
        label: "Current issues", required: true,
        options: [
          { label: "No current issues", value: "none" },
          { label: "Minor niggle — I run through it", value: "minor" },
          { label: "It affects my running", value: "moderate" },
          { label: "I'm currently injured / recovering", value: "significant" }
        ]
      },
      {
        id: "injury_area", type: "text", label: "Where is it?", optional: true,
        placeholder: "e.g. left knee, Achilles, shin",
        showWhen: { injury_has: ["minor", "moderate", "significant"] }
      }
    ],
    extract: function (answers) {
      return {
        injury_status: {
          severity: answers.injury_has,
          area: answers.injury_area || null
        }
      };
    },
    interpret: function (answers, state) {
      var severity = answers.injury_has;
      if (severity === "none") {
        return "No current issues — that's a strong starting position. Let me see how the rest of your profile shapes up.";
      }
      if (severity === "significant") {
        return "Currently injured or recovering — that changes the conversation entirely. Athlevo will never suggest training through an injury, and any plan I'd build would start from where your recovery allows, not where your ambition wants to be. If you haven't already, please see a qualified health professional.";
      }
      if (severity === "moderate") {
        return "Something that affects your running needs to shape the training plan from the start — not as an afterthought. Athlevo is not a medical provider, but I can structure training that avoids aggravating known issues.";
      }
      return "A minor niggle you run through — noted. I'll factor that into load management. If it changes, your training should change with it.";
    }
  },

  /* ── 9. Schedule constraints ────────────────────────────────────── */
  {
    key: "schedule",
    eyebrow: "Your reality",
    title: "Anything that shapes when and how you can train?",
    sub: "Shift work, long commute, young kids — real constraints make better plans.",
    provides: ["schedule_constraints", "train_time"],
    eligible: function (state) {
      var a = state.answers;
      if (!state.known.injury_status) return false;
      var constrainedDays = Number(a.training_days || 0) <= 3;
      var longRaceWithLimitedDays = (a.goal_distance === "Half marathon" || a.goal_distance === "Marathon" || a.goal_distance === "Ultra") && Number(a.training_days || 0) <= 4;
      var structureNeedsFlexibility = a.training_structure === "random" || a.training_structure === "race_only";
      return constrainedDays || longRaceWithLimitedDays || structureNeedsFlexibility || a.perceived_limiter === "mental";
    },
    fields: [
      {
        id: "train_time", type: "chips", label: "Preferred training time", required: true,
        options: [
          { label: "Early morning", value: "early_morning" },
          { label: "Midday", value: "midday" },
          { label: "After work", value: "after_work" },
          { label: "Evening", value: "evening" },
          { label: "It varies", value: "varies" }
        ]
      },
      {
        id: "schedule_constraints", type: "text", label: "Constraints",
        optional: true,
        placeholder: "e.g. shift work, travel, childcare", maxLength: 240
      }
    ],
    extract: function (answers) {
      return {
        train_time: answers.train_time,
        schedule_constraints: answers.schedule_constraints || null
      };
    },
    interpret: function (answers, state) {
      var time = answers.train_time;
      var constraints = answers.schedule_constraints;
      if (time === "varies" && constraints) {
        return "With a varying schedule, I'd rather build training around recovery quality than force every hard session onto fixed weekdays. Your constraints are real — a good plan works with them, not against them.";
      }
      if (time === "varies") {
        return "A varying schedule means we need a flexible structure — one where sessions can shift days without losing training effect. I'll factor that in.";
      }
      if (time === "early_morning") {
        return "Early mornings mean you're running on limited fuel and possibly less sleep. That's fine for easy runs but changes how I'd place quality sessions.";
      }
      // Default — enough info gathered, no insight needed
      return null;
    }
  },

  /* ── 10. Other training load ────────────────────────────────────── */
  {
    key: "other_training",
    eyebrow: "The full picture",
    title: "Do you do any training besides running?",
    sub: "Strength work, cycling, swimming — it all affects recovery and adaptation.",
    provides: ["strength_training", "other_training"],
    eligible: function (state) {
      // Only when non-running load could materially affect recovery.
      if (!state.known.injury_status) return false;
      var days = state.answers.training_days || 0;
      var km = state.answers.weekly_mileage || 0;
      return days >= 5 || km >= 40;
    },
    fields: [{
      id: "other_training", type: "multichips",
      label: "Other training", required: true,
      options: [
        { label: "Strength / gym", value: "strength" },
        { label: "Cycling", value: "cycling" },
        { label: "Swimming", value: "swimming" },
        { label: "Yoga / mobility", value: "yoga" },
        { label: "Team sport", value: "team_sport" },
        { label: "None", value: "none", exclusive: true }
      ]
    }],
    extract: function (answers) {
      var other = answers.other_training || [];
      return {
        other_training: other,
        strength_training: other.indexOf("strength") >= 0 ? "yes" : "no"
      };
    },
    interpret: function (answers, state) {
      var other = answers.other_training || [];
      if (other.indexOf("none") >= 0 || other.length === 0) {
        var limiter = state.answers.perceived_limiter;
        if (limiter === "muscular") {
          return "No strength work with a muscular limiter — that's a strong signal. Adding even two targeted sessions per week often produces faster running gains than adding more running volume.";
        }
        return "No cross-training — that's not unusual, but it means your total training load is all running impact. Something to consider as volume grows.";
      }
      if (other.indexOf("strength") >= 0) {
        return "Already doing strength work — that's a real advantage. The question is whether it's complementing your running or competing with it for recovery.";
      }
      if (other.indexOf("cycling") >= 0 || other.indexOf("swimming") >= 0) {
        return "Cross-training gives you aerobic stimulus without running impact — useful. I'll factor that training load into the total picture.";
      }
      return null;
    }
  }
];

/* ═══════════════════════════ LIMITER ENGINE ══════════════════════════
 * Deterministic limiter identification from collected data points.
 * Each rule contributes evidence toward a limiter hypothesis.
 */
var LIMITER_RULES = [
  {
    limiter: "aerobic_base",
    label: "Aerobic base",
    test: function (s) {
      return s.perceived_limiter === "aerobic" ||
        (s.experience === "new" && s.training_status !== "training_block") ||
        (s.weekly_mileage != null && s.weekly_mileage < 20 && s.experience !== "5_plus");
    },
    weight: function (s) {
      var w = 0;
      if (s.perceived_limiter === "aerobic") w += 3;
      if (s.experience === "new") w += 2;
      if (s.weekly_mileage != null && s.weekly_mileage < 15) w += 2;
      else if (s.weekly_mileage != null && s.weekly_mileage < 25) w += 1;
      if (s.training_status === "starting") w += 2;
      return w;
    }
  },
  {
    limiter: "running_durability",
    label: "Running durability",
    test: function (s) {
      return s.perceived_limiter === "muscular" ||
        (s.experience === "new" && s.perceived_limiter !== "aerobic") ||
        (s.strength_training === "no" && s.perceived_limiter === "muscular");
    },
    weight: function (s) {
      var w = 0;
      if (s.perceived_limiter === "muscular") w += 3;
      if (s.strength_training === "no" && s.perceived_limiter === "muscular") w += 2;
      if (s.experience === "new" || s.experience === "1_2_years") w += 1;
      if (s.training_status === "returning") w += 1;
      return w;
    }
  },
  {
    limiter: "endurance_pacing",
    label: "Endurance & pacing",
    test: function (s) {
      var longest = asKm(s.recent_longest_run_km);
      return s.perceived_limiter === "endurance" ||
        (isEnduranceDistance(s.goal_distance) && longRunIsShortForGoal(s.goal_distance, longest));
    },
    weight: function (s) {
      var w = 0;
      var longest = asKm(s.recent_longest_run_km);
      var km = asKm(s.weekly_mileage);
      if (s.perceived_limiter === "endurance") w += 3;
      if (longRunIsShortForGoal(s.goal_distance, longest)) w += 2;
      if (s.perceived_limiter === "endurance" && volumeIsSubstantial(km) &&
          longRunIsAdequateForGoal(s.goal_distance, longest)) w += 1;
      if (s.experience === "5_plus" && s.perceived_limiter === "endurance") w += 1;
      return w;
    }
  },
  {
    limiter: "injury_management",
    label: "Injury management",
    test: function (s) {
      return s.perceived_limiter === "injury" ||
        (s.injury_status && s.injury_status.severity !== "none");
    },
    weight: function (s) {
      var w = 0;
      if (s.perceived_limiter === "injury") w += 3;
      if (s.injury_status) {
        if (s.injury_status.severity === "significant") w += 4;
        else if (s.injury_status.severity === "moderate") w += 2;
        else if (s.injury_status.severity === "minor") w += 1;
      }
      return w;
    }
  },
  {
    limiter: "training_structure",
    label: "Training structure",
    test: function (s) {
      return s.training_structure === "random" || s.training_structure === "race_only" ||
        ((s.experience === "3_5_years" || s.experience === "5_plus") &&
          s.training_status === "maintaining" && s.perceived_limiter !== "injury");
    },
    weight: function (s) {
      var w = 0;
      if (s.training_structure === "random") w += 4;
      if (s.training_structure === "race_only") w += 4;
      if (s.training_structure === "mostly_easy" && s.goal_time) w += 1;
      if (s.training_status === "maintaining" && (s.experience === "3_5_years" || s.experience === "5_plus")) w += 3;
      if (s.perceived_limiter === "unclear") w += 2;
      if (s.perceived_limiter === "mental") w += 1;
      if (s.training_days >= 5 && s.weekly_mileage >= 40) w += 1;
      return w;
    }
  },
  {
    limiter: "consistency",
    label: "Consistency & availability",
    test: function (s) {
      return (s.training_days != null && s.training_days <= 3 &&
        (s.goal_distance === "Marathon" || s.goal_distance === "Half marathon" ||
         s.goal_distance === "Ultra")) || s.training_structure === "random";
    },
    weight: function (s) {
      var w = 0;
      if (s.training_days <= 2) w += 3;
      else if (s.training_days <= 3) w += 1;
      if (s.training_status === "returning") w += 1;
      if (s.schedule_constraints) w += 1;
      if (s.perceived_limiter === "mental") w += 1;
      if (s.training_structure === "random") w += 2;
      if (s.recent_consistency === "none" || s.recent_consistency === "occasional") w += 1;
      return w;
    }
  }
];

/* ═══════════════════════════ STATE MACHINE ═══════════════════════════ */

function DiagnosticEngine() {
  this.answers = {};       // raw answers keyed by field id
  this.questionAnswers = {}; // normalized answers keyed by question key
  this.known = {};         // data points that have been filled (key → true)
  this.history = [];       // ordered list of question keys shown
  this.currentIndex = -1;  // position of the last displayed answered question
  this.begun = false;
  this.completed = false;
  this.startedAt = null;
  this.completedAt = null;
  this.result = null;      // populated after completion
  this.importKeyValue = makeImportKey();

  // Safety flags
  this.safetyFlags = {
    injuryReported: false,
    injurySeverity: null,
    requiresMedicalClearance: false
  };

  // Limiter hypotheses (updated after each answer)
  this.hypotheses = [];

  // Extracted field values that have not yet been recordAnswer()'d.
  // Persisted with the diagnostic so refresh still skips known fields.
  this.pendingFacts = {};

  // Validated model coaching judgment. Deterministic answers still win.
  // Cleared when the relevant fact signature changes.
  this.modelReasoning = null;
}

DiagnosticEngine.prototype._goalDistance = function () {
  return this.answers.goal_distance || null;
};

DiagnosticEngine.prototype._hasFact = function (key) {
  return !!this.known[key] || isKnownValue(this.answers[key]);
};

DiagnosticEngine.prototype._hasRecentResult = function () {
  var dist = this.answers.recent_race_dist;
  return !!dist && dist !== "none" && isKnownValue(this.answers.recent_race_time);
};

DiagnosticEngine.prototype._hasGoalCategory = function () {
  var d = this._goalDistance();
  if (!d) return false;
  if (d === "General fitness") return true;
  return this.answers.goal === "race" || isRaceDistance(d);
};

DiagnosticEngine.prototype._hasTimelineCategory = function () {
  var d = this._goalDistance();
  if (!d || d === "General fitness") return true;
  if (isKnownValue(this.answers.goal_race_date)) return true;
  if (!isEnduranceDistance(d)) return true;
  return this.history.indexOf("race_details") >= 0;
};

DiagnosticEngine.prototype._hasCapacityCategory = function () {
  var d = this._goalDistance();
  var hasRecent = this._hasRecentResult();
  var hasMileage = this.answers.weekly_mileage != null && this.answers.weekly_mileage !== "";
  var hasLongest = this.answers.recent_longest_run_km != null && this.answers.recent_longest_run_km !== "";
  var hasExp = isKnownValue(this.answers.experience);
  var status = this.answers.training_status;
  var hasStatus = isKnownValue(status);

  if (isLongEnduranceDistance(d)) return hasLongest || hasRecent;
  if (hasRecent) return true;
  if (hasMileage && hasLongest) return true;
  if (hasMileage && hasExp && hasStatus) return true;
  if (status === "starting" && hasExp) return true;
  return false;
};

DiagnosticEngine.prototype._hasLoadCategory = function () {
  if (this.answers.weekly_mileage != null && this.answers.weekly_mileage !== "") return true;
  if (this.answers.weekly_hours != null && this.answers.weekly_hours !== "") return true;
  if (this.answers.training_days != null && this.answers.training_days !== "") return true;
  return false;
};

DiagnosticEngine.prototype._hasContextCategory = function () {
  if (isKnownValue(this.answers.training_structure)) return true;
  if (isKnownValue(this.answers.recent_consistency)) return true;
  if (isKnownValue(this.answers.training_status)) return true;
  var limiter = this.answers.perceived_limiter;
  return isKnownValue(limiter) && limiter !== "unclear";
};

DiagnosticEngine.prototype._injurySafetySatisfied = function () {
  return !!this.known.injury_status;
};

/* Enough coaching context to judge a limiter — does not include the
 * injury safety gate. Do not reuse sales hasMinimumContext. */
DiagnosticEngine.prototype.hasDiagnosticSufficiency = function () {
  if (!this.begun || this.completed) return !!this.completed;
  return this._hasGoalCategory() &&
    this._hasTimelineCategory() &&
    this._hasCapacityCategory() &&
    this._hasLoadCategory() &&
    this._hasContextCategory();
};

DiagnosticEngine.prototype._longestRunHighValue = function () {
  return isEnduranceDistance(this._goalDistance()) && !this._hasFact("recent_longest_run_km");
};

/* Block silent auto-fill when it would skip a still-valuable field. */
DiagnosticEngine.prototype.canAutoFillQuestion = function (q, fieldAnswers) {
  if (!q) return false;
  var sim = fieldAnswers || {};
  if (q.key === "race_details") {
    var d = this._goalDistance();
    if (isEnduranceDistance(d) && !isKnownValue(sim.goal_race_date) && !this._hasFact("goal_race_date")) {
      return false;
    }
  }
  if (q.key === "current_capacity") {
    if (this._longestRunHighValue() &&
        sim.recent_longest_run_km == null && !this._hasFact("recent_longest_run_km")) {
      return false;
    }
  }
  return true;
};

DiagnosticEngine.prototype._provideStillNeeded = function (key) {
  if (this._hasFact(key)) return false;
  if (key === "weekly_hours" || key === "goal_race" || key === "train_time" ||
      key === "schedule_constraints" || key === "training_structure_other") {
    return false;
  }
  if (key === "recent_longest_run_km" && !this._longestRunHighValue() && this._hasCapacityCategory()) {
    return false;
  }
  if (key === "goal_time" && this._hasTimelineCategory()) return false;
  if (key === "goal_race_date" && this._hasTimelineCategory()) return false;
  return true;
};

DiagnosticEngine.prototype._questionDiagnosticValue = function (q) {
  if (!q || this.history.indexOf(q.key) >= 0) return 0;
  if (q.eligible && !q.eligible(this._stateView())) return 0;

  var stillNeeded = false;
  for (var p = 0; p < q.provides.length; p++) {
    if (this._provideStillNeeded(q.provides[p])) { stillNeeded = true; break; }
  }
  if (!stillNeeded) return 0;

  var goalGap = !this._hasGoalCategory();
  var timelineGap = !this._hasTimelineCategory();
  var capacityGap = !this._hasCapacityCategory();
  var loadGap = !this._hasLoadCategory();
  var contextGap = !this._hasContextCategory();
  var injuryGap = !this._injurySafetySatisfied();
  var d = this._goalDistance();
  var timeGoal = isKnownValue(this.answers.goal_time);
  var sufficient = this.hasDiagnosticSufficiency();

  if (sufficient) return q.key === "injury_status" && injuryGap ? 100 : 0;

  var value = 0;
  switch (q.key) {
    case "goal":
      value = goalGap ? 100 : 0;
      break;
    case "race_details":
      if (timelineGap) value = 90;
      else if (isLongEnduranceDistance(d) && !this._hasFact("goal_race_date")) value = 40;
      else value = 0;
      break;
    case "experience":
      if (capacityGap && !this._hasFact("experience")) value = 55;
      else if (!this._hasFact("experience")) value = 12;
      break;
    case "training_status":
      if (contextGap || (capacityGap && this._hasFact("weekly_mileage") &&
          !this._hasFact("recent_longest_run_km") && !this._hasRecentResult())) {
        value = 70;
      } else if (!this._hasFact("training_status")) value = 20;
      break;
    case "weekly_volume":
      if (this._hasFact("weekly_mileage") || this._hasFact("weekly_hours")) value = 0;
      else if (loadGap || capacityGap) value = 85;
      else value = 10;
      break;
    case "current_capacity":
      if (isLongEnduranceDistance(d) && !this._hasFact("recent_longest_run_km")) value = 88;
      else if (isEnduranceDistance(d) && !this._hasFact("recent_longest_run_km") && capacityGap) value = 75;
      else if (capacityGap && !this._hasRecentResult()) value = 60;
      else if (contextGap && !this._hasFact("recent_consistency") &&
          !this._hasFact("training_status") && !this._hasFact("training_structure")) value = 50;
      else value = 0;
      break;
    case "recent_performance":
      if (this._hasRecentResult()) value = 0;
      else if (timeGoal && capacityGap) value = 86;
      else if ((d === "5K" || d === "10K") && capacityGap) value = 80;
      else if (timeGoal && !isLongEnduranceDistance(d)) value = 45;
      else value = 0;
      break;
    case "training_days":
      if (!loadGap) value = 0;
      else if (this._hasFact("weekly_mileage")) value = 8;
      else value = 65;
      break;
    case "training_structure":
      if (!contextGap) value = 0;
      else if (this._hasFact("training_status") || this._hasFact("recent_consistency")) value = 25;
      else value = 60;
      break;
    case "perceived_limiter":
      if (!contextGap) value = 0;
      else value = 8;
      break;
    case "injury_status":
      if (!injuryGap) value = 0;
      else value = 15;
      break;
    case "schedule":
      value = 6;
      break;
    case "other_training":
      value = 6;
      break;
    default:
      value = 1;
  }
  return value;
};

/* Find the next best question given current diagnostic value. */
DiagnosticEngine.prototype.nextQuestion = function () {
  if (this.completed) return null;
  if (this.canComplete()) return null;
  var candidates = [];

  for (var i = 0; i < QUESTIONS.length; i++) {
    var q = QUESTIONS[i];
    var infoValue = this._questionDiagnosticValue(q);
    if (infoValue > 0) candidates.push({ question: q, infoValue: infoValue });
  }

  if (candidates.length === 0) {
    for (var j = 0; j < QUESTIONS.length; j++) {
      var fq = QUESTIONS[j];
      if (this.history.indexOf(fq.key) >= 0) continue;
      if (fq.key === "perceived_limiter") continue;
      if (fq.eligible && !fq.eligible(this._stateView())) continue;
      var providesNew = false;
      for (var k = 0; k < fq.provides.length; k++) {
        if (!this.known[fq.provides[k]]) { providesNew = true; break; }
      }
      if (providesNew) candidates.push({ question: fq, infoValue: 1 });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort(function (a, b) { return b.infoValue - a.infoValue; });
  return candidates[0].question;
};

/* Fail-open continuation when nextQuestion() is empty but canComplete()
 * is still false. Does not change sufficiency, scoring, or the normal
 * nextQuestion() path. Injury/safety first, then unanswered eligible
 * questions, then answered questions whose provided facts never stuck. */
DiagnosticEngine.prototype.recoverContinuationQuestion = function () {
  if (this.completed || this.canComplete()) return null;
  var live = this.nextQuestion();
  if (live) return live;

  if (!this._injurySafetySatisfied()) {
    var injury = DiagnosticEngine.getQuestion("injury_status");
    if (injury) return injury;
  }

  var i;
  var q;
  for (i = 0; i < QUESTIONS.length; i++) {
    q = QUESTIONS[i];
    if (q.key === "perceived_limiter") continue;
    if (this.history.indexOf(q.key) >= 0) continue;
    if (q.eligible && !q.eligible(this._stateView())) continue;
    return q;
  }

  for (i = 0; i < QUESTIONS.length; i++) {
    q = QUESTIONS[i];
    if (this.history.indexOf(q.key) < 0) continue;
    var stillNeeded = false;
    for (var p = 0; p < q.provides.length; p++) {
      if (this._provideStillNeeded(q.provides[p])) { stillNeeded = true; break; }
    }
    if (stillNeeded) return q;
  }

  return null;
};

/* Enough information for a useful diagnosis, including the injury gate. */
DiagnosticEngine.prototype.canComplete = function () {
  if (!this.begun || this.completed) return !!this.completed;
  return this.hasDiagnosticSufficiency() && this._injurySafetySatisfied();
};

DiagnosticEngine.prototype._requiredQuestionKeys = function () {
  return this.missingRequiredKeys();
};

DiagnosticEngine.prototype.begin = function () {
  if (!this.begun) {
    this.begun = true;
    this.startedAt = this.startedAt || new Date().toISOString();
    this._save();
  }
};

/* Record an answer and advance state. Returns the coaching interpretation. */
DiagnosticEngine.prototype.recordAnswer = function (questionKey, fieldAnswers) {
  var question = DiagnosticEngine.getQuestion(questionKey);
  if (!question) return null;
  this.begin();

  var normalized = normalizeQuestionAnswers(question, fieldAnswers || {});
  var existingIndex = this.history.indexOf(questionKey);
  if (existingIndex >= 0) {
    var removed = this.history.slice(existingIndex + 1);
    for (var r = 0; r < removed.length; r++) delete this.questionAnswers[removed[r]];
    this.history = this.history.slice(0, existingIndex + 1);
  } else {
    this.history.push(questionKey);
  }
  this.questionAnswers[questionKey] = normalized;
  this.currentIndex = this.history.indexOf(questionKey);
  this.completed = false;
  this.completedAt = null;
  this.result = null;
  this._clearPendingFactsForQuestion(question);
  this._rebuildDerivedState();

  // Generate coaching interpretation
  var interpret = null;
  if (question.interpret) {
    interpret = question.interpret(normalized, this._stateView());
  }

  // Persist
  this._save();

  return interpret;
};

/* Navigate back to a previous question. */
DiagnosticEngine.prototype.goBack = function () {
  if (this.history.length === 0) return null;
  if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
    this.currentIndex = this.history.length - 1;
  } else if (this.currentIndex > 0) {
    this.currentIndex--;
  } else {
    return null;
  }
  var key = this.history[this.currentIndex];
  return DiagnosticEngine.getQuestion(key);
};

DiagnosticEngine.prototype.previousQuestion = function (displayedQuestionKey) {
  if (this.history.length === 0) return null;
  var displayedIndex = this.history.indexOf(displayedQuestionKey);
  var index = displayedIndex >= 0 ? displayedIndex - 1 : this.history.length - 1;
  if (index < 0) return null;
  this.currentIndex = index;
  return DiagnosticEngine.getQuestion(this.history[index]);
};

/* Get the current question (for redraw after back nav). */
DiagnosticEngine.prototype.currentQuestion = function () {
  if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
    return this.nextQuestion();
  }
  var key = this.history[this.currentIndex];
  for (var i = 0; i < QUESTIONS.length; i++) {
    if (QUESTIONS[i].key === key) return QUESTIONS[i];
  }
  return this.nextQuestion();
};

/* Whether we're re-visiting a previously answered question. */
DiagnosticEngine.prototype.isRevisiting = function () {
  return this.currentIndex < this.history.length - 1;
};

/* Complete the diagnostic and generate the result. */
DiagnosticEngine.prototype.complete = function () {
  this.completed = true;
  this.completedAt = new Date().toISOString();
  this.result = this._generateResult();
  this._save();
  return this.result;
};

/* Information completeness as a fraction 0–1 for the progress indicator. */
DiagnosticEngine.prototype.completeness = function () {
  if (this.completed) return 1;
  var parts = [
    this._hasGoalCategory(),
    this._hasTimelineCategory(),
    this._hasCapacityCategory(),
    this._hasLoadCategory(),
    this._hasContextCategory(),
    this._injurySafetySatisfied()
  ];
  var n = 0;
  for (var i = 0; i < parts.length; i++) if (parts[i]) n++;
  if (n >= parts.length) return 0.98;
  return n / parts.length;
};

/* ─── Internal state view (safe for passing to question functions) ─── */

DiagnosticEngine.prototype._stateView = function () {
  return {
    answers: this.answers,
    known: this.known,
    history: this.history,
    hypotheses: this.hypotheses,
    safetyFlags: this.safetyFlags
  };
};

DiagnosticEngine.prototype._clearPendingFactsForQuestion = function (question) {
  if (!question || !this.pendingFacts) return;
  for (var i = 0; i < question.fields.length; i++) {
    delete this.pendingFacts[question.fields[i].id];
  }
};

DiagnosticEngine.prototype.getPendingFacts = function () {
  return sanitizePendingFacts(this.pendingFacts);
};

DiagnosticEngine.prototype.setPendingFacts = function (facts) {
  this.pendingFacts = sanitizePendingFacts(facts);
  this._rebuildDerivedState();
  this._save();
};

function signatureFactValue(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch (e) { return ""; }
  }
  return String(value);
}

function filterStoredKeys(list, allowed) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < 8; i++) {
    var item = list[i];
    if (typeof item !== "string" || allowed.indexOf(item) < 0) continue;
    if (out.indexOf(item) >= 0) continue;
    out.push(item);
  }
  return out;
}

function sanitizeStoredLimiter(raw) {
  if (!raw || typeof raw !== "object") return null;
  var key = typeof raw.key === "string" ? raw.key : "";
  if (MODEL_REASONING_LIMITERS.indexOf(key) < 0) return null;
  var why = typeof raw.why === "string" ? raw.why.trim().slice(0, 400) : "";
  if (!why) return null;
  var label = typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : key;
  return { key: key, label: label, why: why };
}

function sanitizeStoredExpectation(raw) {
  if (!raw || typeof raw !== "object") return null;
  var rating = typeof raw.rating === "string" ? raw.rating : "";
  if (MODEL_REASONING_EXPECTATIONS.indexOf(rating) < 0) return null;
  var text = typeof raw.text === "string" ? raw.text.trim().slice(0, 300) : "";
  if (!text) return null;
  return { rating: rating, text: text };
}

function sanitizeReasoningPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  var primary = sanitizeStoredLimiter(raw.primary_limiter);
  var secondary = primary ? sanitizeStoredLimiter(raw.secondary_limiter) : null;
  if (secondary && primary && secondary.key === primary.key) secondary = null;
  var confidence = raw.diagnostic_confidence;
  if (typeof confidence !== "number" || !isFinite(confidence) || confidence < 0 || confidence > 1) {
    confidence = null;
  }
  var summary = typeof raw.diagnostic_summary === "string" ? raw.diagnostic_summary.trim().slice(0, 500) : "";
  var direction = typeof raw.recommended_direction === "string" ? raw.recommended_direction.trim().slice(0, 400) : "";
  return {
    primary_limiter: primary,
    secondary_limiter: secondary,
    diagnostic_confidence: confidence,
    diagnostic_summary: summary || null,
    recommended_direction: direction || null,
    expectation: sanitizeStoredExpectation(raw.expectation),
    coach_concerns: filterStoredKeys(raw.coach_concerns, MODEL_REASONING_CONCERNS),
    context_flags: filterStoredKeys(raw.context_flags, MODEL_REASONING_FLAGS)
  };
}

function sanitizeStoredModelReasoning(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.signature !== "string" || !raw.signature || raw.signature.length > 800) return null;
  return {
    signature: raw.signature.slice(0, 800),
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt.slice(0, 40) : null,
    reasoning: sanitizeReasoningPayload(raw.reasoning)
  };
}

DiagnosticEngine.prototype.reasoningSignature = function () {
  var parts = [];
  for (var i = 0; i < MODEL_REASONING_SIGNATURE_KEYS.length; i++) {
    var key = MODEL_REASONING_SIGNATURE_KEYS[i];
    parts.push(key + "=" + signatureFactValue(this.answers[key]));
  }
  return parts.join("|");
};

DiagnosticEngine.prototype._pruneStaleModelReasoning = function () {
  if (!this.modelReasoning) return;
  if (this.modelReasoning.signature !== this.reasoningSignature()) {
    this.modelReasoning = null;
  }
};

DiagnosticEngine.prototype.getModelReasoning = function () {
  this._pruneStaleModelReasoning();
  return this.modelReasoning && this.modelReasoning.reasoning
    ? this.modelReasoning.reasoning
    : null;
};

DiagnosticEngine.prototype.setModelReasoning = function (reasoning) {
  var sanitized = sanitizeReasoningPayload(reasoning);
  this.modelReasoning = {
    signature: this.reasoningSignature(),
    generatedAt: new Date().toISOString(),
    reasoning: sanitized
  };
  this._save();
  return sanitized;
};

DiagnosticEngine.prototype.clearModelReasoning = function () {
  this.modelReasoning = null;
  this._save();
};

DiagnosticEngine.prototype._applyPendingFactsToDerivedState = function () {
  var pending = sanitizePendingFacts(this.pendingFacts);
  for (var key in pending) {
    if (!Object.prototype.hasOwnProperty.call(pending, key)) continue;
    if (isKnownValue(this.answers[key])) continue;
    this.answers[key] = pending[key];
  }
  if (!this.known.goal && isKnownValue(this.answers.goal_distance)) {
    this.answers.goal = this.answers.goal_distance === "General fitness" ? "fitness" : "race";
    this.known.goal = true;
    this.known.goal_distance = true;
  }
  if (!this.known.injury_status && isKnownValue(this.answers.injury_has)) {
    this.answers.injury_status = {
      severity: this.answers.injury_has,
      area: this.answers.injury_area || null
    };
    this.known.injury_status = true;
  }
  if (!this.known.strength_training && Array.isArray(this.answers.other_training)) {
    this.answers.strength_training = this.answers.other_training.indexOf("strength") >= 0 ? "yes" : "no";
    this.known.other_training = true;
    this.known.strength_training = true;
  }
  var dpKeys = Object.keys(DATA_POINTS);
  for (var i = 0; i < dpKeys.length; i++) {
    var dp = dpKeys[i];
    if (!this.known[dp] && isKnownValue(this.answers[dp])) this.known[dp] = true;
  }
};

DiagnosticEngine.prototype._rebuildDerivedState = function () {
  this.answers = {};
  this.known = {};
  this.safetyFlags = { injuryReported: false, injurySeverity: null, requiresMedicalClearance: false };
  for (var i = 0; i < this.history.length; i++) {
    var q = DiagnosticEngine.getQuestion(this.history[i]);
    var fieldAnswers = this.questionAnswers[this.history[i]];
    if (!q || !fieldAnswers) continue;
    for (var fieldId in fieldAnswers) {
      if (Object.prototype.hasOwnProperty.call(fieldAnswers, fieldId)) this.answers[fieldId] = fieldAnswers[fieldId];
    }
    var extracted = q.extract ? q.extract(fieldAnswers) : {};
    for (var dp in extracted) {
      if (!Object.prototype.hasOwnProperty.call(extracted, dp)) continue;
      this.answers[dp] = extracted[dp];
      if (isKnownValue(extracted[dp])) this.known[dp] = true;
    }
  }
  this._applyPendingFactsToDerivedState();
  this._updateSafetyFlags();
  this._updateHypotheses();
  this._pruneStaleModelReasoning();
};

/* ─── Safety flag management ─── */

DiagnosticEngine.prototype._updateSafetyFlags = function () {
  var injury = this.answers.injury_status;
  if (injury && typeof injury === "object") {
    this.safetyFlags.injuryReported = injury.severity !== "none";
    this.safetyFlags.injurySeverity = injury.severity;
    this.safetyFlags.requiresMedicalClearance = injury.severity === "significant";
  }
  if (this.answers.perceived_limiter === "injury") {
    this.safetyFlags.injuryReported = true;
  }
};

/* ─── Hypothesis management ─── */

DiagnosticEngine.prototype._updateHypotheses = function () {
  var results = [];
  for (var i = 0; i < LIMITER_RULES.length; i++) {
    var rule = LIMITER_RULES[i];
    if (rule.test(this.answers)) {
      results.push({
        limiter: rule.limiter,
        label: rule.label,
        weight: rule.weight(this.answers)
      });
    }
  }
  results.sort(function (a, b) { return b.weight - a.weight; });
  this.hypotheses = results;
};

/* ═══════════════════════════ RESULT GENERATION ═══════════════════════
 * Pure deterministic function. Maps collected data to a structured
 * diagnosis. Future AI-backed generation slots in via the `interpret`
 * interface — the deterministic result is always the fallback.
 */
DiagnosticEngine.prototype._generateResult = function () {
  var a = this.answers;
  var primary = this.hypotheses.length > 0 ? this.hypotheses[0] : null;
  var secondary = this.hypotheses.length > 1 && this.hypotheses[1].weight >= 3
    ? this.hypotheses[1] : null;

  return {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    questionsAnswered: this.history.length,

    // ── Athlete Profile ──
    profile: this._buildProfile(),

    // ── Strengths ──
    strengths: this._identifyStrengths(),

    // ── Primary Limiter ──
    primaryLimiter: primary ? {
      key: primary.limiter,
      label: primary.label,
      explanation: this._explainLimiter(primary.limiter),
      confidence: Math.min(primary.weight / 6, 1)
    } : null,

    // ── Secondary Limiter (only if genuinely useful) ──
    secondaryLimiter: secondary ? {
      key: secondary.limiter,
      label: secondary.label,
      explanation: this._explainLimiter(secondary.limiter)
    } : null,

    // ── What's Holding You Back ──
    holdingBack: this._explainHoldingBack(primary),

    // ── What We'd Change ──
    whatWedChange: this._explainWhatWedChange(primary),

    // ── Goal Feasibility ──
    feasibility: this._assessFeasibility(),

    // ── Personalized Athlevo approach (one product, no tier selector) ──
    athlevoRecommendation: this._buildAthlevoRecommendation(),

    // ── Safety ──
    safetyFlags: {
      injuryReported: this.safetyFlags.injuryReported,
      requiresMedicalClearance: this.safetyFlags.requiresMedicalClearance,
      injurySeverity: this.safetyFlags.injurySeverity
    },

    // ── Raw data for profile attachment ──
    rawAnswers: JSON.parse(JSON.stringify(a)),

    // Validated model coaching judgment for later slices. Does not replace
    // the deterministic limiter/result card in this slice.
    modelReasoning: this.getModelReasoning()
  };
};

DiagnosticEngine.prototype._buildProfile = function () {
  var a = this.answers;
  var expLabels = {
    "new": "Beginner runner",
    "1_2_years": "Developing runner",
    "3_5_years": "Experienced runner",
    "5_plus": "Seasoned runner"
  };
  var statusLabels = {
    "starting": "Just starting out",
    "building_base": "Building base",
    "training_block": "In a structured block",
    "returning": "Returning from a break",
    "maintaining": "Maintaining fitness"
  };
  return {
    goal: a.goal_distance || "General fitness",
    goalRace: a.goal_race || null,
    goalDate: a.goal_race_date || null,
    goalTime: a.goal_time || null,
    experience: expLabels[a.experience] || a.experience,
    experienceRaw: a.experience,
    trainingStatus: statusLabels[a.training_status] || a.training_status,
    trainingStatusRaw: a.training_status,
    weeklyMileage: a.weekly_mileage || null,
    weeklyHours: a.weekly_hours || null,
    trainingDays: a.training_days || null,
    trainTime: a.train_time || null
  };
};

DiagnosticEngine.prototype._identifyStrengths = function () {
  var a = this.answers;
  var strengths = [];

  if (a.experience === "5_plus") {
    strengths.push({ label: "Deep aerobic foundation", detail: "Years of running have built genuine structural adaptation — your body handles training load better than you might realise." });
  } else if (a.experience === "3_5_years") {
    strengths.push({ label: "Established running base", detail: "Several years of consistent running means your aerobic system has real capacity to build from." });
  }

  if (a.training_days >= 5) {
    strengths.push({ label: "Training commitment", detail: "Training " + a.training_days + " days a week shows genuine commitment — the foundation is there for meaningful progress." });
  }

  if (a.weekly_mileage >= 40) {
    strengths.push({ label: "Strong volume base", detail: Math.round(a.weekly_mileage) + " km per week is a solid platform. The question is whether that volume is doing the right work." });
  }

  if (a.training_status === "training_block") {
    strengths.push({ label: "Structured approach", detail: "Already in a training block shows discipline and intentionality — you're not just running randomly." });
  }

  if (a.strength_training === "yes") {
    strengths.push({ label: "Cross-training", detail: "Strength work alongside running builds resilience and usually improves running economy." });
  }

  if (a.perceived_limiter !== "unclear" && a.perceived_limiter !== "injury") {
    strengths.push({ label: "Self-awareness", detail: "Knowing what limits you is itself a strength — it means training can be directed rather than generic." });
  }

  // Always return at least one
  if (strengths.length === 0) {
    strengths.push({ label: "Starting with intent", detail: "Taking the time to understand where you are before diving into a plan puts you ahead of most runners." });
  }

  return strengths.slice(0, 3);
};

DiagnosticEngine.prototype._explainLimiter = function (limiterKey) {
  var a = this.answers;
  var km = asKm(a.weekly_mileage);
  var longest = asKm(a.recent_longest_run_km);
  var goal = a.goal_distance;
  var explanations = {
    aerobic_base: volumeIsLowForGoal(goal, km)
      ? "Your current weekly volume is still light for this goal. The aerobic engine that supports sustained running needs more consistent easy work before the race distance is realistic."
      : "Your aerobic system — the engine that powers sustained running — isn't yet developed enough to support the paces or distances you're targeting. This is the single most common limiter, and the most responsive to the right training.",
    running_durability: "Your musculoskeletal system — bones, tendons, connective tissue — needs more time and stimulus to handle the running load you're asking of it. This is different from cardiovascular fitness, and it adapts on a longer timescale.",
    injury_management: "A current injury or recurring pain pattern is the primary constraint. No training plan is useful if it aggravates an existing issue — the first priority is understanding what your body can safely do right now.",
    training_structure: "You have the fitness and the commitment, but how your training is organised isn't producing adaptation. Experienced runners often plateau not from lack of effort but from lack of variation and periodisation.",
    consistency: "With limited training days available for your goal distance, the primary challenge is making every session count. The structure and specificity of each run matters more than it would with more available days."
  };
  if (limiterKey === "endurance_pacing") {
    if (volumeIsSubstantial(km) && longRunIsAdequateForGoal(goal, longest)) {
      return "Your speed is ahead of your ability to sustain it. Based on your current training, the biggest opportunity is improving race-specific endurance and pacing—not simply adding more hard sessions.";
    }
    if (longRunIsShortForGoal(goal, longest) || volumeIsLowForGoal(goal, km)) {
      return "Sustaining pace over the full distance is breaking down, and the endurance work behind it is still short of what this goal typically needs. Building that capacity is the priority—not adding more hard sessions.";
    }
    return "Sustaining effort over the full distance is the limiter. That usually comes from pacing, race-specific work, or how intensity is distributed—not from a missing easy run.";
  }
  return explanations[limiterKey] || "This area appears to be the primary constraint on your running progress.";
};

DiagnosticEngine.prototype._explainHoldingBack = function (primary) {
  if (!primary) return "There isn't one dominant limiter — your progress will likely come from a structured, well-balanced approach rather than fixing one thing.";

  var a = this.answers;
  var key = primary.limiter;

  if (key === "aerobic_base") {
    if (a.training_status === "starting" || a.experience === "new") {
      return "You're early enough in your running journey that your aerobic system simply hasn't had enough time and stimulus to develop. The fix is consistent, mostly easy running — but it needs to be genuinely easy. Most new runners train too hard on easy days, which delays the very adaptation they need.";
    }
    return "Your aerobic base is undersized for what you're asking of it. This usually happens when training skews too hard — tempo runs and intervals are satisfying, but the unglamorous easy kilometres are what build the engine. The ratio is probably off.";
  }

  if (key === "running_durability") {
    if (a.strength_training === "no") {
      return "Your cardiovascular system is ready for more, but your legs aren't keeping up. Without any strength work, your muscles and connective tissue are absorbing all the training load without the resilience that targeted strength provides. It's like building a powerful engine on a chassis that flexes under load.";
    }
    return "Even with some strength work, your musculoskeletal system is the limiting factor. This could mean the strength work isn't targeted at running-specific demands, or that your running volume has increased faster than your body's structural adaptation.";
  }

  if (key === "endurance_pacing") {
    var km = asKm(a.weekly_mileage);
    var longest = asKm(a.recent_longest_run_km);
    if (volumeIsSubstantial(km) && longRunIsAdequateForGoal(a.goal_distance, longest)) {
      return "Overall volume is already substantial. The fade is more likely race-specific endurance, pacing, or fueling than a missing long-run distance.";
    }
    if (longRunIsShortForGoal(a.goal_distance, longest) || volumeIsLowForGoal(a.goal_distance, km)) {
      return "Current endurance work is still short of what this goal typically needs. The long run and weekly volume both have to grow before the race distance is supported.";
    }
    return "The second-half fade usually comes from pacing relative to threshold, how the long run is structured, or fueling—not from one missing workout type.";
  }

  if (key === "injury_management") {
    return "The injury or pain pattern is currently the gate. Training through it without understanding the cause risks making it chronic. Athlevo is not a medical provider and cannot diagnose the cause — but I can build training that respects the limitation once you understand what your body can safely do.";
  }

  if (key === "training_structure") {
    return "You're doing the work, but the work isn't structured to drive adaptation. At your experience level, simply running more won't produce the gains — what matters is the type of stimulus, the timing of hard and easy sessions, and whether the plan progresses over weeks in a way your body can absorb.";
  }

  if (key === "consistency") {
    return "With " + (a.training_days || "limited") + " available days, every session has to earn its place. The risk is either spreading effort too thin across too many goals, or skipping the sessions that matter most when life gets in the way. A simpler structure that's always executable beats an ideal plan that falls apart every other week.";
  }

  return "The primary constraint is identifiable, and addressable with the right training structure.";
};

DiagnosticEngine.prototype._explainWhatWedChange = function (primary) {
  if (!primary) {
    return [
      "Give each week a simple hard/easy rhythm",
      "Protect one longer aerobic run",
      "Progress volume only when the current week feels repeatable"
    ];
  }

  var a = this.answers;
  var key = primary.limiter;
  var km = asKm(a.weekly_mileage);
  var longest = asKm(a.recent_longest_run_km);
  var changes = [];

  if (key === "aerobic_base") {
    changes.push("Increase the proportion of genuinely easy running to at least 80% of weekly volume");
    changes.push("Build weekly distance progressively — no more than 10% increase per week");
    if (a.training_days >= 4) {
      changes.push("Add a second easy run on existing training days before adding new days");
    } else {
      changes.push("Protect one weekly long run as the endurance session");
    }
  }

  if (key === "running_durability") {
    changes.push("Add 2 targeted running-specific strength sessions per week");
    changes.push("Reduce running intensity to allow musculoskeletal adaptation");
    changes.push("Build running volume more conservatively than your cardiovascular fitness allows");
  }

  if (key === "endurance_pacing") {
    if (volumeIsSubstantial(km) && longRunIsAdequateForGoal(a.goal_distance, longest)) {
      changes.push("Restructure your long runs around marathon-specific endurance");
      changes.push("Add threshold work appropriate to your current fitness");
      changes.push("Control pacing so you can sustain effort deeper into the race");
    } else if (longRunIsShortForGoal(a.goal_distance, longest) || volumeIsLowForGoal(a.goal_distance, km)) {
      changes.push("Build weekly volume before adding more intensity");
      changes.push("Grow the long run gradually toward race-specific distance");
      changes.push("Keep most running easy while endurance catches up");
    } else {
      changes.push("Add race-pace segments to the weekly long run");
      changes.push("Practice even or negative-split pacing in training");
      changes.push("Add threshold work specific to the goal race");
    }
  }

  if (key === "injury_management") {
    changes.push("Build training around what your body can currently tolerate");
    changes.push("Prioritise activities that maintain fitness without aggravating the issue");
    changes.push("Introduce progressive return-to-running protocol once cleared");
  }

  if (key === "training_structure") {
    changes.push("Introduce genuine periodisation — structured blocks with different emphases");
    changes.push("Differentiate easy and hard days more clearly (most runners train in the middle)");
    changes.push("Add a weekly quality session that targets specific physiological demands");
  }

  if (key === "consistency") {
    changes.push("Design a minimal-effective-dose plan that's always executable");
    changes.push("Prioritise the 2-3 sessions that produce the most adaptation");
    changes.push("Make the key endurance session non-negotiable — everything else flexes around it");
  }

  return changes.slice(0, 3);
};

/* ═══════════════════════════ GOAL FEASIBILITY ════════════════════════ */

DiagnosticEngine.prototype._assessFeasibility = function () {
  var a = this.answers;
  var goal = a.goal_distance;
  var km = asKm(a.weekly_mileage);
  var longest = asKm(a.recent_longest_run_km);
  var exp = a.experience;
  var days = a.training_days;
  var status = a.training_status;
  var injury = a.injury_status;
  var hasTimeGoal = !!(a.goal_time && String(a.goal_time).trim());
  var hasRaceMarker = hasRecentRaceResult(a);

  if (injury && injury.severity === "significant") {
    return {
      rating: "not_advisable",
      label: "Not currently advisable until cleared",
      explanation: "With an active injury or ongoing recovery, setting a race goal right now could make things worse. Get cleared by a health professional first — once you have a clear picture of what your body can do, we can plan from there."
    };
  }

  if (goal === "General fitness") {
    return {
      rating: "realistic",
      label: "Looks realistic",
      explanation: "A general fitness goal with no race deadline gives us complete flexibility. Progress will come from consistency and structure."
    };
  }

  var readiness = 0;
  var concerns = [];
  var volumeLow = volumeIsLowForGoal(goal, km);
  var longRunShort = longRunIsShortForGoal(goal, longest);

  var distanceDifficulty = { "5K": 1, "10K": 2, "Half marathon": 3, "Marathon": 4, "Ultra": 5 };
  var expLevel = { "new": 1, "1_2_years": 2, "3_5_years": 3, "5_plus": 4 };
  var diff = (distanceDifficulty[goal] || 3);
  var eLvl = exp ? (expLevel[exp] || 2) : null;

  if (eLvl != null) {
    if (eLvl >= diff) readiness += 2;
    else if (eLvl >= diff - 1) readiness += 1;
    else concerns.push("the experience gap for this distance");
  }

  var minWeeklyKm = { "5K": 15, "10K": 25, "Half marathon": 30, "Marathon": 40, "Ultra": 50 };
  var minKm = minWeeklyKm[goal] || 25;
  if (km != null) {
    if (km >= minKm) readiness += 2;
    else if (km >= minKm * 0.6) readiness += 1;
    else concerns.push("current weekly volume relative to the distance");
  }

  var minDays = { "5K": 3, "10K": 3, "Half marathon": 3, "Marathon": 4, "Ultra": 4 };
  var md = minDays[goal] || 3;
  if (days != null && days !== "") {
    var dayCount = Number(days) || 0;
    if (dayCount >= md) readiness += 1;
    else concerns.push("limited training days for this distance");
  }

  if (status === "training_block") readiness += 1;
  if (status === "returning") concerns.push("returning from a break");
  if (status === "starting") concerns.push("building from a new starting point");

  if (injury && injury.severity === "moderate") {
    concerns.push("an active issue affecting training");
    readiness -= 1;
  }

  var weeksOut = null;
  var minWeeks = { "5K": 6, "10K": 8, "Half marathon": 10, "Marathon": 16, "Ultra": 20 };
  var mw = minWeeks[goal] || 12;
  if (a.goal_race_date) {
    var raceDate = new Date(a.goal_race_date);
    if (!isNaN(raceDate.getTime())) {
      weeksOut = Math.round((raceDate - new Date()) / (7 * 24 * 60 * 60 * 1000));
      if (weeksOut < mw * 0.5) {
        concerns.push("a very tight timeline");
        readiness -= 2;
      } else if (weeksOut < mw) {
        concerns.push("a compressed timeline");
        readiness -= 1;
      } else {
        readiness += 1;
      }
    }
  }

  var timelineVeryTight = weeksOut != null && weeksOut < mw * 0.5;

  // A missing race result is incomplete evidence — not proof the goal is unrealistic.
  if (hasTimeGoal && !hasRaceMarker) {
    if (timelineVeryTight) {
      return {
        rating: "reassess",
        label: "Needs reassessment",
        explanation: "The current goal may be ahead of present capacity. We’d build toward it progressively rather than forcing the timeline — and without a recent race marker I wouldn’t lock the target in yet."
      };
    }
    return {
      rating: "insufficient_data",
      label: "Not enough data yet",
      explanation: "Without a recent race result, I wouldn’t lock in the target yet. We can still train toward it and recalibrate once there’s a current marker."
    };
  }

  if (readiness >= 5) {
    return {
      rating: "realistic",
      label: "Looks realistic",
      explanation: "Your current fitness, experience, and available training time align well with this goal. With the right structure, this is achievable."
    };
  }
  if (readiness >= 3) {
    return {
      rating: "realistic_structured",
      label: "Looks realistic",
      explanation: "This looks achievable with structured progression" +
        (concerns.length > 0 ? " — keeping " + concerns.join(" and ") + " in view." : ".")
    };
  }
  if (readiness >= 1) {
    return {
      rating: "aggressive",
      label: "Ambitious but possible",
      explanation: "This is a stretch from where you are now" +
        (concerns.length > 0 ? " — particularly " + concerns.join(" and ") : "") +
        ". It’s possible with disciplined, progressive training."
    };
  }
  if (volumeLow || longRunShort || timelineVeryTight) {
    return {
      rating: "reassess",
      label: "Needs reassessment",
      explanation: "The current goal looks ahead of present capacity. We’d build the endurance first rather than forcing the timeline."
    };
  }
  if (readiness >= -1) {
    return {
      rating: "reassess",
      label: "Needs reassessment",
      explanation: "I’d reassess the target or timeline before locking it in. This isn’t a no — it’s not yet in this form."
    };
  }
  return {
    rating: "not_advisable",
    label: "Not currently advisable",
    explanation: "Pursuing this goal right now carries more risk than benefit. A shorter target or a longer timeline would set you up better."
  };
};

/* ═══════════════════════════ PRODUCT RECOMMENDATION ══════════════════
 * One product is offered: Athlevo AI / Athlevo Pro. The diagnostic explains
 * how it would address the runner's limiter without prescribing a schedule.
 */
DiagnosticEngine.prototype._buildAthlevoRecommendation = function () {
  var feasibility = this._assessFeasibility();
  if (this.safetyFlags.requiresMedicalClearance || feasibility.rating === "not_advisable") {
    return {
      safetyOverride: true,
      id: "medical_clearance",
      heading: "Clearance comes first",
      strategy: "Pause structured progression until a qualified health professional confirms what training is appropriate. Athlevo will be here when you are cleared to resume structured training.",
      capabilities: []
    };
  }
  var primary = this.hypotheses.length > 0
    ? this.hypotheses[0].limiter
    : "training_structure";
  var strategies = {
    consistency: "Your biggest opportunity isn't running harder. It's creating enough consistency for one week of training to build on the next. Athlevo would structure your training around the days you can realistically run and adjust your progression when your schedule changes.",
    running_durability: "Your cardiovascular fitness appears ahead of your running durability. Athlevo would initially prioritize sustainable volume, longer aerobic work and running-specific strength before introducing more demanding sessions.",
    aerobic_base: "Your next phase should focus on expanding how much running you can sustain comfortably. Athlevo would build that progressively rather than simply telling you to run harder.",
    training_structure: "You're already putting in enough effort to improve. The missing piece is how that work is organized. Athlevo would give each session a purpose and progress your training based on how you're responding.",
    endurance_pacing: "Your training needs a clearer balance between controlled aerobic work and the sessions that move your goal forward. Athlevo would set purposeful effort targets and adjust them as your endurance develops.",
    schedule: "A rigid Monday–Sunday plan probably isn't the best fit for your situation. Athlevo can structure priority sessions around your actual availability and adjust when work or recovery changes.",
    injury_management: "Your progression needs to respect the physical issue you reported. Once training is appropriate, Athlevo would keep load increases measured and adjust around how your body is responding."
  };
  // Schedule constraints as a limiter takes priority only when the primary
  // limiter isn't more specific (consistency/durability/etc. already address
  // schedule implicitly).
  if ((this.answers.schedule_constraints || this.answers.train_time === "varies") &&
      (primary === "training_structure" || !strategies[primary])) {
    primary = "schedule";
  }
  var strategy = strategies[primary] || strategies.training_structure;
  return {
    safetyOverride: false,
    id: "athlevo_ai",
    heading: "How Athlevo would coach you",
    strategy: strategy,
    capabilities: [
      "Personalized training plan",
      "Daily workout guidance",
      "AI coach you can talk to",
      "Training adjustments",
      "Progress and readiness insights"
    ]
  };
};

/* ═══════════════════════════ PERSISTENCE ═════════════════════════════
 * localStorage with a validated versioned payload. It survives OAuth redirects,
 * tab interruptions, and accidental navigation, but expires after 30 days of
 * inactivity so sensitive diagnostic answers are not retained indefinitely.
 */

DiagnosticEngine.prototype._save = function () {
  try {
    var savedAt = new Date().toISOString();
    var payload = {
      v: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      savedAt: savedAt,
      expiresAt: new Date(Date.now() + STORAGE_TTL_MS).toISOString(),
      importKey: this.importKeyValue,
      begun: this.begun,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      questionAnswers: this.questionAnswers,
      history: this.history,
      currentIndex: this.currentIndex,
      completed: this.completed,
      result: this.result,
      pendingFacts: sanitizePendingFacts(this.pendingFacts),
      modelReasoning: sanitizeStoredModelReasoning(this.modelReasoning)
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Diagnostic: could not save to localStorage:", e);
  }
};

DiagnosticEngine.load = function () {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    var payload = JSON.parse(raw);
    if (!isValidStoredPayload(payload)) {
      DiagnosticEngine.clearPending();
      return null;
    }

    var engine = new DiagnosticEngine();
    engine.importKeyValue = payload.importKey;
    engine.begun = payload.begun === true;
    engine.questionAnswers = payload.questionAnswers;
    engine.history = payload.history;
    engine.currentIndex = Math.max(-1, Math.min(payload.currentIndex, engine.history.length - 1));
    engine.completed = payload.completed === true;
    engine.startedAt = payload.startedAt || null;
    engine.completedAt = payload.completedAt || null;
    engine.result = payload.result || null;
    engine.pendingFacts = sanitizePendingFacts(payload.pendingFacts);
    engine.modelReasoning = sanitizeStoredModelReasoning(payload.modelReasoning);
    engine._rebuildDerivedState();

    return engine;
  } catch (e) {
    console.warn("Diagnostic: could not load from localStorage:", e);
    DiagnosticEngine.clearPending();
    return null;
  }
};

function isValidStoredPayload(payload) {
  if (!isPlainObject(payload) || payload.v !== SCHEMA_VERSION || payload.engineVersion !== ENGINE_VERSION) return false;
  if (typeof payload.savedAt !== "string" || typeof payload.expiresAt !== "string" || typeof payload.importKey !== "string") return false;
  if (!/^diag_1_[a-z0-9]+_[a-z0-9]+$/i.test(payload.importKey) || payload.importKey.length > 120) return false;
  var savedAt = Date.parse(payload.savedAt);
  var expiresAt = Date.parse(payload.expiresAt);
  if (!isFinite(savedAt) || !isFinite(expiresAt) || expiresAt <= Date.now() || savedAt > Date.now() + 5 * 60 * 1000) return false;
  if (expiresAt - savedAt > STORAGE_TTL_MS + 60 * 1000) return false;
  if (typeof payload.begun !== "boolean" || typeof payload.completed !== "boolean") return false;
  if (!Array.isArray(payload.history) || payload.history.length > MAX_HISTORY_LENGTH) return false;
  if (!isPlainObject(payload.questionAnswers) || hasOversizedText(payload.questionAnswers)) return false;
  var seen = {};
  for (var i = 0; i < payload.history.length; i++) {
    var key = payload.history[i];
    if (typeof key !== "string" || seen[key] || !DiagnosticEngine.getQuestion(key) || !isPlainObject(payload.questionAnswers[key])) return false;
    seen[key] = true;
  }
  if (typeof payload.currentIndex !== "number" || !isFinite(payload.currentIndex)) return false;
  if (payload.startedAt != null && !isFinite(Date.parse(payload.startedAt))) return false;
  if (payload.begun && !payload.startedAt) return false;
  if (payload.completed) {
    if (!payload.completedAt || !isFinite(Date.parse(payload.completedAt)) || !isValidResult(payload.result)) return false;
  } else if (payload.result != null || payload.completedAt != null) {
    return false;
  }
  return true;
}

function isValidResult(result) {
  return isPlainObject(result) && result.version === SCHEMA_VERSION &&
    typeof result.generatedAt === "string" && isFinite(Date.parse(result.generatedAt)) &&
    isPlainObject(result.profile) && isPlainObject(result.feasibility) &&
    typeof result.feasibility.rating === "string" && isPlainObject(result.athlevoRecommendation) &&
    typeof result.athlevoRecommendation.id === "string" &&
    typeof result.athlevoRecommendation.strategy === "string";
}

DiagnosticEngine.hasPending = function () {
  return !!DiagnosticEngine.load();
};

DiagnosticEngine.clearPending = function () {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
};

/* Create a fresh diagnostic. */
DiagnosticEngine.create = function () {
  var engine = new DiagnosticEngine();
  engine._save();
  return engine;
};

/* ═══════════════════════════ PROFILE ATTACHMENT ══════════════════════
 * Maps diagnostic answers to Athlevo profile columns. Used after auth
 * to populate the user's profile from pre-signup diagnostic data.
 *
 * Returns an object suitable for Supabase profiles.update().
 * The caller is responsible for merge logic (don't overwrite stronger data).
 */

DiagnosticEngine.prototype.toProfileFields = function () {
  var a = this.answers;
  var fields = {};

  // Goal → composed goal string (same format onboarding uses)
  var goalParts = [];
  if (a.goal_distance && a.goal_distance !== "General fitness") goalParts.push(a.goal_distance);
  if (a.goal_race) goalParts.push(a.goal_race);
  if (a.goal_time) goalParts.push(a.goal_time);
  if (goalParts.length > 0) fields.goal = goalParts.join(" — ");
  else if (a.goal_distance === "General fitness") fields.goal = "General endurance fitness";

  // Race-specific values map to the live onboarding/profile schema.
  if (a.goal_race) fields.target_race = a.goal_race;
  if (a.goal_race_date) fields.race_date = a.goal_race_date;
  if (a.goal_time) fields.target_time = a.goal_time;

  // Experience → numeric (same mapping as onboarding F.experience)
  var expToYears = { "new": 0, "1_2_years": 1, "3_5_years": 4, "5_plus": 8 };
  if (a.experience && expToYears[a.experience] != null) {
    fields.experience_years = expToYears[a.experience];
  }

  // Weekly distance
  if (a.weekly_mileage != null) fields.weekly_distance = Number(a.weekly_mileage);

  // Training hours
  if (a.weekly_hours != null) fields.weekly_hours = Number(a.weekly_hours);

  // Availability is explicit and safe to use for both live day-count fields.
  if (a.training_days != null) {
    fields.available_days = Number(a.training_days);
    fields.training_days = Number(a.training_days);
  }

  // Injury notes (area only, no severity — that goes in diagnostic_result)
  if (a.injury_status && a.injury_status.area) {
    fields.injury_history = a.injury_status.area;
  }

  // Schedule
  if (a.schedule_constraints) {
    fields.work_schedule = a.schedule_constraints;
  }

  var trainTimeLabels = {
    early_morning: "Early morning",
    midday: "Midday",
    after_work: "After work",
    evening: "Evening",
    varies: "Varies"
  };
  if (a.train_time && trainTimeLabels[a.train_time]) {
    fields.preferred_training_time = trainTimeLabels[a.train_time];
  }

  var statusLabels = {
    starting: "Just starting",
    building_base: "Building base",
    training_block: "In a training block",
    returning: "Returning from a break",
    maintaining: "Maintaining fitness"
  };
  if (a.training_status && statusLabels[a.training_status]) {
    fields.coach_notes = "Training status: " + statusLabels[a.training_status] + ".";
  }

  return fields;
};

/* Build the full diagnostic_result JSONB payload for storage. */
DiagnosticEngine.prototype.toStoragePayload = function () {
  return {
    schema_version: SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    import_key: this.importKeyValue,
    started_at: this.startedAt,
    completed_at: this.completedAt,
    completedAt: this.completedAt,
    questionsAnswered: this.history.length,
    result: this.result,
    answers: JSON.parse(JSON.stringify(this.answers))
  };
};

DiagnosticEngine.prototype.toDiagnosticRow = function (userId) {
  var result = this.result || {};
  var recommendation = result.athlevoRecommendation || {};
  return {
    user_id: userId,
    import_key: this.importKeyValue,
    schema_version: SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    started_at: this.startedAt,
    completed_at: this.completedAt,
    answers: JSON.parse(JSON.stringify(this.answers)),
    result: JSON.parse(JSON.stringify(result)),
    primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
    feasibility: result.feasibility ? result.feasibility.rating : null,
    coaching_strategy: recommendation.strategy || null,
    recommendation_reason: result.primaryLimiter ? result.primaryLimiter.key : null,
    acquisition_stage: recommendation.safetyOverride ? "clearance_required" : "awaiting_payment",
    updated_at: new Date().toISOString()
  };
};

/* Idempotency key to prevent double-import after OAuth redirect. */
DiagnosticEngine.prototype.importKey = function () {
  return this.importKeyValue;
};

/*
 * ── Mid-conversation grounding for the diagnostic sales/coaching layer ──
 * Read-only snapshots of the SAME deterministic reasoning _generateResult()
 * uses at the end, exposed publicly so the AI router can ground an
 * in-progress answer ("how would Athlevo help me?" before all questions
 * are answered) in real product logic instead of inventing a value
 * proposition. Safe before at least one answer exists — every field these
 * read from defaults sanely on an empty answers/hypotheses object.
 */
DiagnosticEngine.prototype.currentRecommendation = function () {
  return this._buildAthlevoRecommendation();
};

DiagnosticEngine.prototype.currentFeasibility = function () {
  return this._assessFeasibility();
};

DiagnosticEngine.prototype.currentPrimaryLimiter = function () {
  return this.hypotheses.length > 0 ? this.hypotheses[0] : null;
};

/* Which real QUESTIONS keys are still unanswered right now (for the sales
 * layer to know what's genuinely still missing before it recommends
 * skipping ahead). */
DiagnosticEngine.prototype.missingRequiredKeys = function () {
  if (this.canComplete()) return [];
  var missing = [];
  for (var i = 0; i < QUESTIONS.length; i++) {
    var q = QUESTIONS[i];
    if (this._questionDiagnosticValue(q) > 0) missing.push(q.key);
  }
  return missing;
};

/* ═══════════════════════════ QUESTION HELPERS ════════════════════════ */

/* Get question definition by key. */
DiagnosticEngine.getQuestion = function (key) {
  for (var i = 0; i < QUESTIONS.length; i++) {
    if (QUESTIONS[i].key === key) return QUESTIONS[i];
  }
  return null;
};

/* Get all question definitions (for UI rendering). */
DiagnosticEngine.getQuestions = function () {
  return QUESTIONS;
};

/* ═══════════════════════════ EXPORT ══════════════════════════════════ */

// Expose globally (same pattern as other Athlevo modules)
root.AthlevoDiagnostic = DiagnosticEngine;

// Node.js / test compat
if (typeof module !== "undefined" && module.exports) {
  module.exports = { DiagnosticEngine: DiagnosticEngine, QUESTIONS: QUESTIONS, LIMITER_RULES: LIMITER_RULES };
}

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
