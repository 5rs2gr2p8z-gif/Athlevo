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
 *  · All state in localStorage (survives OAuth redirects, tab interruptions).
 *  · Coaching interpretations are template-driven with clear interface for
 *    future AI-backed generation.
 *  · Product recommendation is tier-agnostic — supports any number of tiers.
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
var ENGINE_VERSION = "diagnostic-engine-v2";
var STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
var MAX_HISTORY_LENGTH = 20;
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
    title: "What are you working toward?",
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
      if (!state.known.training_status) return false;
      return state.answers.training_status === "starting" || state.known.weekly_mileage;
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
      return !!state.answers.goal_time && !!state.known.recent_consistency;
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
      return !!state.known.recent_consistency;
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
      return !!state.known.training_days;
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
      return !!state.known.training_structure;
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
        return "Fading in the second half is a pacing and fuelling signature more than a fitness one. It tells me your threshold relative to your race pace may be closer than it should be — or your long runs aren't doing the right work.";
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
      // Always required once the diagnostic evidence questions are complete.
      return !!state.known.perceived_limiter;
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
      return s.perceived_limiter === "endurance" ||
        (s.goal_distance === "Marathon" || s.goal_distance === "Half marathon" || s.goal_distance === "Ultra");
    },
    weight: function (s) {
      var w = 0;
      if (s.perceived_limiter === "endurance") w += 3;
      if (s.goal_distance === "Marathon" || s.goal_distance === "Ultra") w += 1;
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
  this.selectedProductId = null;

  // Safety flags
  this.safetyFlags = {
    injuryReported: false,
    injurySeverity: null,
    requiresMedicalClearance: false
  };

  // Limiter hypotheses (updated after each answer)
  this.hypotheses = [];
}

/* Find the next best question given current state. */
DiagnosticEngine.prototype.nextQuestion = function () {
  if (this.completed) return null;
  if (this.canComplete()) return null;
  var candidates = [];

  for (var i = 0; i < QUESTIONS.length; i++) {
    var q = QUESTIONS[i];

    // Already answered?
    if (this.history.indexOf(q.key) >= 0) continue;

    // Eligible?
    if (q.eligible && !q.eligible(this._stateView())) continue;

    // Does it provide any unknown data points?
    var providesNew = false;
    for (var j = 0; j < q.provides.length; j++) {
      if (!this.known[q.provides[j]]) { providesNew = true; break; }
    }
    if (!providesNew) continue;

    // Calculate information value: sum of priorities of unknown data points
    var infoValue = 0;
    for (var k = 0; k < q.provides.length; k++) {
      var dp = DATA_POINTS[q.provides[k]];
      if (dp && !this.known[q.provides[k]]) {
        infoValue += (5 - dp.priority); // Higher priority = higher value
      }
    }

    candidates.push({ question: q, infoValue: infoValue });
  }

  if (candidates.length === 0) return null;

  // Sort by information value (highest first)
  candidates.sort(function (a, b) { return b.infoValue - a.infoValue; });

  return candidates[0].question;
};

/* Check whether we have enough info for a credible diagnostic. */
DiagnosticEngine.prototype.canComplete = function () {
  if (!this.begun || this.completed) return !!this.completed;
  var required = this._requiredQuestionKeys();
  if (required.length < 7) return false;
  for (var i = 0; i < required.length; i++) {
    if (this.history.indexOf(required[i]) < 0) return false;
  }
  return true;
};

DiagnosticEngine.prototype._requiredQuestionKeys = function () {
  var keys = ["goal"];
  if (this.answers.goal === "race") keys.push("race_details");
  keys.push("experience", "training_status");
  if (this.answers.training_status && this.answers.training_status !== "starting") keys.push("weekly_volume");
  keys.push("current_capacity");
  if (this.answers.goal_time) keys.push("recent_performance");
  keys.push("training_days", "training_structure", "perceived_limiter", "injury_status");

  var state = this._stateView();
  var schedule = DiagnosticEngine.getQuestion("schedule");
  var other = DiagnosticEngine.getQuestion("other_training");
  if (schedule && (!schedule.eligible || schedule.eligible(state))) keys.push("schedule");
  if (other && (!other.eligible || other.eligible(state))) keys.push("other_training");
  return keys;
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
  this.selectedProductId = null;
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
  var required = this._requiredQuestionKeys();
  var answered = 0;
  for (var i = 0; i < required.length; i++) {
    if (this.history.indexOf(required[i]) >= 0) answered++;
  }
  return required.length > 0 ? Math.min(answered / required.length, 0.98) : 0;
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
  this._updateSafetyFlags();
  this._updateHypotheses();
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

    // ── Product Recommendation ──
    recommendation: this._recommendProduct(),

    // ── Safety ──
    safetyFlags: {
      injuryReported: this.safetyFlags.injuryReported,
      requiresMedicalClearance: this.safetyFlags.requiresMedicalClearance,
      injurySeverity: this.safetyFlags.injurySeverity
    },

    // ── Raw data for profile attachment ──
    rawAnswers: JSON.parse(JSON.stringify(a))
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
  var explanations = {
    aerobic_base: "Your aerobic system — the engine that powers sustained running — isn't yet developed enough to support the paces or distances you're targeting. This is the single most common limiter, and the most responsive to the right training.",
    running_durability: "Your musculoskeletal system — bones, tendons, connective tissue — needs more time and stimulus to handle the running load you're asking of it. This is different from cardiovascular fitness, and it adapts on a longer timescale.",
    endurance_pacing: "You can run fast over short distances, but sustaining pace over the full distance is where things break down. This is typically a combination of inadequate long-run development, pacing strategy, and fuelling.",
    injury_management: "A current injury or recurring pain pattern is the primary constraint. No training plan is useful if it aggravates an existing issue — the first priority is understanding what your body can safely do right now.",
    training_structure: "You have the fitness and the commitment, but how your training is organised isn't producing adaptation. Experienced runners often plateau not from lack of effort but from lack of variation and periodisation.",
    consistency: "With limited training days available for your goal distance, the primary challenge is making every session count. The structure and specificity of each run matters more than it would with more available days."
  };
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
    return "The second-half fade you're experiencing usually has two contributors: long runs that aren't long enough or aren't structured to build race-specific endurance, and a pacing strategy that starts too fast relative to your current threshold. Both are fixable — but fixing one without the other won't solve it.";
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
  if (!primary) return "A balanced, periodised approach with clear weekly structure.";

  var a = this.answers;
  var key = primary.limiter;
  var changes = [];

  if (key === "aerobic_base") {
    changes.push("Increase the proportion of genuinely easy running to at least 80% of weekly volume");
    changes.push("Build weekly distance progressively — no more than 10% increase per week");
    if (a.training_days >= 4) {
      changes.push("Add a second easy run on existing training days before adding new days");
    }
    changes.push("Introduce one weekly long run that's 25-30% of total volume");
  }

  if (key === "running_durability") {
    changes.push("Add 2 targeted running-specific strength sessions per week");
    changes.push("Reduce running intensity to allow musculoskeletal adaptation");
    changes.push("Build running volume more conservatively than your cardiovascular fitness allows");
    if (a.training_status === "returning") {
      changes.push("Start at 50-60% of your previous volume and rebuild over 6-8 weeks");
    }
  }

  if (key === "endurance_pacing") {
    changes.push("Restructure the weekly long run to include race-pace segments");
    changes.push("Implement negative-split pacing strategy in training runs");
    changes.push("Add threshold work specific to goal race demands");
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
    if (a.goal_distance === "Marathon" || a.goal_distance === "Ultra") {
      changes.push("Make the long run non-negotiable — everything else flexes around it");
    }
  }

  return changes;
};

/* ═══════════════════════════ GOAL FEASIBILITY ════════════════════════ */

DiagnosticEngine.prototype._assessFeasibility = function () {
  var a = this.answers;
  var goal = a.goal_distance;
  var km = a.weekly_mileage || 0;
  var exp = a.experience;
  var days = a.training_days || 0;
  var status = a.training_status;
  var injury = a.injury_status;

  // Injury override
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
      label: "Realistic",
      explanation: "A general fitness goal with no race deadline gives us complete flexibility. Progress will come from consistency and structure, and there's no timeline pressure."
    };
  }

  // Build a score based on readiness signals
  var readiness = 0;
  var concerns = [];

  // Experience vs goal distance
  var distanceDifficulty = { "5K": 1, "10K": 2, "Half marathon": 3, "Marathon": 4, "Ultra": 5 };
  var expLevel = { "new": 1, "1_2_years": 2, "3_5_years": 3, "5_plus": 4 };
  var diff = (distanceDifficulty[goal] || 3);
  var eLvl = (expLevel[exp] || 2);

  if (eLvl >= diff) readiness += 2;
  else if (eLvl >= diff - 1) readiness += 1;
  else concerns.push("the experience gap for this distance");

  // Volume vs distance
  var minWeeklyKm = { "5K": 15, "10K": 25, "Half marathon": 30, "Marathon": 40, "Ultra": 50 };
  var minKm = minWeeklyKm[goal] || 25;
  if (km >= minKm) readiness += 2;
  else if (km >= minKm * 0.6) readiness += 1;
  else if (km > 0) concerns.push("current weekly volume relative to the distance");
  else concerns.push("starting from zero volume");

  // Training days vs distance
  var minDays = { "5K": 3, "10K": 3, "Half marathon": 3, "Marathon": 4, "Ultra": 4 };
  var md = minDays[goal] || 3;
  if (days >= md) readiness += 1;
  else concerns.push("limited training days for this distance");

  // Status modifiers
  if (status === "training_block") readiness += 1;
  if (status === "returning") concerns.push("returning from a break");
  if (status === "starting") concerns.push("building from a new starting point");

  // Minor injury concern
  if (injury && injury.severity === "moderate") {
    concerns.push("an active issue affecting training");
    readiness -= 1;
  }

  // Timeline pressure (if race date provided)
  if (a.goal_race_date) {
    var raceDate = new Date(a.goal_race_date);
    var now = new Date();
    var weeksOut = Math.round((raceDate - now) / (7 * 24 * 60 * 60 * 1000));
    var minWeeks = { "5K": 6, "10K": 8, "Half marathon": 10, "Marathon": 16, "Ultra": 20 };
    var mw = minWeeks[goal] || 12;
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

  // Map score to rating
  if (readiness >= 5) {
    return {
      rating: "realistic",
      label: "Realistic",
      explanation: "Your current fitness, experience, and available training time align well with this goal. With the right structure, this is achievable."
    };
  }
  if (readiness >= 3) {
    return {
      rating: "realistic_structured",
      label: "Realistic with structured progression",
      explanation: "This is achievable, but it will require deliberate, progressive training. " +
        (concerns.length > 0 ? "Key considerations: " + concerns.join(", ") + "." : "A structured plan is important.")
    };
  }
  if (readiness >= 1) {
    return {
      rating: "aggressive",
      label: "Aggressive but possible",
      explanation: "This is a stretch goal given where you are now" +
        (concerns.length > 0 ? " — particularly " + concerns.join(" and ") : "") +
        ". It's not impossible, but it requires disciplined, progressive training and realistic expectations about timeline."
    };
  }
  if (readiness >= -1) {
    return {
      rating: "reassess",
      label: "Requires reassessment",
      explanation: "Given " + (concerns.length > 0 ? concerns.join(", ") : "the current situation") +
        ", I'd recommend either adjusting the goal distance, extending the timeline, or focusing on building a stronger base first. This isn't a 'no' — it's a 'not yet in this form'."
    };
  }
  return {
    rating: "not_advisable",
    label: "Not currently advisable",
    explanation: "With " + concerns.join(" and ") + ", pursuing this goal right now carries more risk than benefit. A shorter target distance or a longer timeline would set you up for genuine success rather than a forced attempt."
  };
};

/* ═══════════════════════════ PRODUCT RECOMMENDATION ══════════════════
 * Tier-agnostic recommendation engine. Supports any number of products.
 * The recommendation is based on actual support needs, not just complexity.
 *
 * PRODUCT_TIERS is the configuration — editing this array is where future
 * checkout integration and new tiers would go. The diagnostic logic does
 * not hardcode tier names or prices.
 */
var PRODUCT_TIERS = [
  {
    id: "ai",
    name: "Athlevo AI",
    shortName: "AI",
    description: "AI-powered adaptive training — plans that adjust to how you respond.",
    bestFor: "Self-motivated runners with clear goals who want intelligent structure without human coaching.",
    capabilities: ["Adaptive training plans", "Daily adjustments", "Performance tracking", "Race-day strategy"],
    fits: function (s) {
      // Good for: self-sufficient runners, clear goals, no major injury, moderate complexity
      var score = 3; // Base — this is the primary product
      if (s.experience === "3_5_years" || s.experience === "5_plus") score += 1;
      if (s.training_status === "training_block" || s.training_status === "maintaining") score += 1;
      if (s.injury_status && s.injury_status.severity === "none") score += 1;
      if (s.training_days >= 4) score += 1;
      return score;
    }
  },
  {
    id: "plan",
    name: "Athlevo Plan",
    shortName: "Plan",
    description: "A periodised training plan built by a human coach, powered by Athlevo's engine.",
    bestFor: "Runners who want expert-designed structure with the flexibility to execute independently.",
    capabilities: ["Custom-built plan", "Periodised structure", "AI-powered adjustments", "Plan revisions"],
    fits: function (s) {
      var score = 0;
      // Good for: specific race goals, time-constrained, moderate experience
      if (s.goal_race_date) score += 2;
      if (s.goal_time) score += 1;
      if (s.experience === "1_2_years" || s.experience === "3_5_years") score += 1;
      if (s.training_days >= 4 && s.training_days <= 6) score += 1;
      if (s.schedule_constraints) score += 1;
      return score;
    }
  },
  {
    id: "coaching",
    name: "Athlevo Coaching",
    shortName: "Coaching",
    description: "Ongoing coaching relationship — a dedicated coach who knows your running and adapts week to week.",
    bestFor: "Runners who benefit from accountability, regular check-ins, and adaptive human guidance.",
    capabilities: ["Dedicated human coach", "Weekly plan adjustments", "Direct messaging", "Race strategy sessions"],
    fits: function (s) {
      var score = 0;
      // Good for: complex situations, returning/injured, ambitious goals with gaps
      if (s.injury_status && s.injury_status.severity !== "none") score += 2;
      if (s.training_status === "returning") score += 2;
      if (s.perceived_limiter === "mental") score += 1;
      if (s.schedule_constraints) score += 1;
      if (s.experience === "new" && (s.goal_distance === "Marathon" || s.goal_distance === "Half marathon")) score += 2;
      var feasibility = s._feasibilityRating;
      if (feasibility === "aggressive" || feasibility === "reassess") score += 2;
      return score;
    }
  },
  {
    id: "elite",
    name: "Athlevo Elite",
    shortName: "Elite",
    description: "Comprehensive coaching with full performance monitoring, biomechanical guidance, and priority support.",
    bestFor: "Committed athletes pursuing significant goals who want every advantage.",
    capabilities: ["Senior dedicated coach", "Daily monitoring", "Biomechanical analysis", "Nutrition guidance", "Priority support"],
    fits: function (s) {
      var score = 0;
      // Good for: high volume, complex multi-sport, injury + ambitious goal, very demanding
      if (s.weekly_mileage >= 60) score += 1;
      if (s.training_days >= 6) score += 1;
      if (s.other_training && s.other_training.length >= 2 && s.other_training.indexOf("none") < 0) score += 1;
      if (s.injury_status && s.injury_status.severity !== "none" && s.goal_time) score += 2;
      if (s.experience === "5_plus" && s.goal_time) score += 1;
      return score;
    }
  }
];

DiagnosticEngine.prototype._recommendProduct = function () {
  var a = this.answers;
  // Pass feasibility rating into the scoring context
  var feasibility = this._assessFeasibility();
  if (this.safetyFlags.requiresMedicalClearance || feasibility.rating === "not_advisable") {
    return {
      safetyOverride: true,
      recommended: {
        id: "medical_clearance",
        name: "Get cleared before structured training",
        shortName: "Clearance first",
        description: "Pause structured progression until a qualified health professional confirms what training is appropriate.",
        bestFor: "Runners whose current symptoms or readiness make structured training inadvisable right now.",
        capabilities: [],
        rationale: "Your safety status takes priority over a commercial recommendation. Athlevo will be here when you are cleared to resume structured training."
      },
      alternatives: [],
      factors: this._recommendationFactors()
    };
  }
  var scoringContext = Object.assign({}, a, { _feasibilityRating: feasibility.rating });

  var scored = [];
  for (var i = 0; i < PRODUCT_TIERS.length; i++) {
    var tier = PRODUCT_TIERS[i];
    scored.push({
      id: tier.id,
      name: tier.name,
      shortName: tier.shortName,
      description: tier.description,
      bestFor: tier.bestFor,
      capabilities: tier.capabilities,
      score: tier.fits(scoringContext)
    });
  }

  scored.sort(function (a, b) { return b.score - a.score; });

  var primary = scored[0];
  var alternatives = scored.slice(1).filter(function (s) { return s.score > 0; });

  return {
    recommended: {
      id: primary.id,
      name: primary.name,
      shortName: primary.shortName,
      description: primary.description,
      bestFor: primary.bestFor,
      capabilities: primary.capabilities,
      rationale: this._recommendationRationale(primary.id)
    },
    alternatives: alternatives.map(function (alt) {
      return {
        id: alt.id,
        name: alt.name,
        shortName: alt.shortName,
        description: alt.description,
        bestFor: alt.bestFor
      };
    }),
    factors: this._recommendationFactors()
  };
};

DiagnosticEngine.prototype.selectProduct = function (productId) {
  if (!this.result || !this.result.recommendation || this.result.recommendation.safetyOverride) return false;
  var allowed = PRODUCT_TIERS.some(function (tier) { return tier.id === productId; });
  if (!allowed) return false;
  this.selectedProductId = productId;
  this._save();
  return true;
};

DiagnosticEngine.prototype._recommendationRationale = function (tierId) {
  var a = this.answers;
  var primary = this.hypotheses.length > 0 ? this.hypotheses[0] : null;

  if (tierId === "ai") {
    if (primary && primary.limiter === "training_structure") {
      return "Your fitness base is there — what you need is intelligent structure that adapts as you progress. Athlevo AI builds and adjusts your plan daily based on how your body is responding.";
    }
    if (a.experience === "3_5_years" || a.experience === "5_plus") {
      return "With your experience, you know how to execute. What Athlevo AI adds is the adaptive intelligence — adjusting your plan based on how you're responding, not just following a static template.";
    }
    return "Athlevo AI gives you a structured, adaptive training plan that responds to your progress. It handles the planning so you can focus on the running.";
  }

  if (tierId === "plan") {
    return "With a specific race goal and a deadline to work toward, a coach-designed plan gives you the structure and periodisation that generic plans can't match — built around your actual constraints and fitness level.";
  }

  if (tierId === "coaching") {
    if (a.injury_status && a.injury_status.severity !== "none") {
      return "With an active physical issue, ongoing coaching gives you the adaptive guidance that a static plan can't — your coach adjusts week to week based on how your body responds, not just what the plan says.";
    }
    if (a.training_status === "returning") {
      return "Coming back from a break is one of the situations where coaching pays off most — the return-to-running curve is unpredictable, and having someone adjust the plan as your body readapts keeps you progressing without setbacks.";
    }
    return "Your situation has enough complexity that you'd benefit from a coach who knows your running, adapts your plan week to week, and is available when things change.";
  }

  if (tierId === "elite") {
    return "With your training volume, goals, and complexity, you'd benefit from comprehensive coaching — not just a plan, but ongoing biomechanical guidance, nutrition support, and priority access to a senior coach.";
  }

  return "Based on your diagnostic, this level of support matches your current needs and goals.";
};

DiagnosticEngine.prototype._recommendationFactors = function () {
  var a = this.answers;
  var factors = [];

  if (a.goal_distance) factors.push("goal_distance");
  if (a.experience) factors.push("experience");
  if (this.hypotheses.length > 0) factors.push("primary_limiter");
  if (a.injury_status && a.injury_status.severity !== "none") factors.push("injury_status");
  if (a.training_status === "returning") factors.push("return_from_break");
  if (a.training_days) factors.push("training_availability");
  if (a.schedule_constraints) factors.push("schedule_complexity");
  if (a.goal_time) factors.push("time_goal");

  return factors;
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
      selectedProductId: this.selectedProductId,
      result: this.result
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
    engine.selectedProductId = payload.selectedProductId || null;
    engine.result = payload.result || null;
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
    typeof result.feasibility.rating === "string" && isPlainObject(result.recommendation) &&
    isPlainObject(result.recommendation.recommended) && typeof result.recommendation.recommended.id === "string";
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
    answers: JSON.parse(JSON.stringify(this.answers)),
    selected_product: this.selectedProductId
  };
};

DiagnosticEngine.prototype.toDiagnosticRow = function (userId) {
  var result = this.result || {};
  var recommendation = result.recommendation || {};
  var recommended = recommendation.recommended || {};
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
    recommended_product: recommended.id || null,
    selected_product: this.selectedProductId,
    updated_at: new Date().toISOString()
  };
};

/* Idempotency key to prevent double-import after OAuth redirect. */
DiagnosticEngine.prototype.importKey = function () {
  return this.importKeyValue;
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
  module.exports = { DiagnosticEngine: DiagnosticEngine, QUESTIONS: QUESTIONS, PRODUCT_TIERS: PRODUCT_TIERS, LIMITER_RULES: LIMITER_RULES };
}

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
