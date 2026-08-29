import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadEngine() {
  const values = new Map();
  const context = {
    console: { log() {}, warn() {} }, Date, Math, Uint8Array,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnostic.js", "utf8"), context);
  return { Engine: context.AthlevoDiagnostic, values };
}

function answerUntilComplete(engine, answers) {
  const asked = [];
  for (let guard = 0; guard < 20 && !engine.canComplete(); guard += 1) {
    const question = engine.nextQuestion();
    assert.ok(question, `engine stopped before completion after ${asked.join(", ")}`);
    asked.push(question.key);
    assert.ok(answers[question.key], `missing fixture for ${question.key}`);
    engine.recordAnswer(question.key, answers[question.key]);
  }
  assert.equal(engine.canComplete(), true);
  return asked;
}

const common = {
  experience: { experience: "1_2_years" },
  training_status: { training_status: "building_base" },
  weekly_volume: { weekly_mileage: "30", weekly_hours: "4" },
  current_capacity: { recent_consistency: "mostly_consistent", recent_longest_run_km: "14" },
  recent_performance: { recent_race_dist: "none" },
  training_days: { training_days: 4 },
  training_structure: { training_structure: "easy_long" },
  perceived_limiter: { perceived_limiter: "endurance" },
  injury_status: { injury_has: "none", injury_area: "" },
  schedule: { train_time: "after_work", schedule_constraints: "" },
  other_training: { other_training: ["none"] }
};

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const asked = answerUntilComplete(engine, {
    ...common,
    goal: { goal_distance: "Marathon" },
    race_details: { goal_race: "City Marathon", goal_race_date: "2027-03-01", goal_time: "4:00" },
    recent_performance: { recent_race_dist: "10K", recent_race_time: "52:00" }
  });
  assert.deepEqual(asked.slice(0, 2), ["goal", "race_details"]);
  assert.ok(asked.includes("recent_performance"));
  assert.ok(asked.includes("injury_status"));
  assert.equal(asked.includes("perceived_limiter"), false);
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const asked = answerUntilComplete(engine, {
    ...common,
    goal: { goal_distance: "General fitness" }
  });
  assert.equal(asked[0], "goal");
  assert.equal(asked.includes("race_details"), false);
  assert.equal(asked.includes("schedule"), false);
  assert.equal(asked.includes("other_training"), false);
  assert.equal(asked.includes("perceived_limiter"), false);
  assert.ok(asked.includes("injury_status"));
  assert.ok(asked.length < Engine.getQuestions().length, "adaptive completion should leave irrelevant questions unasked");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const answers = {
    ...common,
    goal: { goal_distance: "Half marathon" },
    race_details: { goal_race: "", goal_race_date: "", goal_time: "" },
    training_status: { training_status: "returning" },
    current_capacity: { recent_consistency: "occasional", recent_longest_run_km: "5" },
    training_days: { training_days: 3 },
    training_structure: { training_structure: "random" },
    perceived_limiter: { perceived_limiter: "mental" },
    injury_status: { injury_has: "moderate", injury_area: "knee" },
    schedule: { train_time: "varies", schedule_constraints: "shift work" }
  };
  const asked = answerUntilComplete(engine, answers);
  assert.equal(asked.includes("perceived_limiter"), false, "perceived limiter is not a completion gate");
  assert.ok(asked.includes("injury_status"), "injury safety gate still runs");
  const result = engine.complete();
  assert.equal(result.safetyFlags.injuryReported, true);
  assert.equal(engine.canComplete(), true);
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const asked = answerUntilComplete(engine, {
    ...common,
    goal: { goal_distance: "10K" },
    race_details: { goal_race: "", goal_race_date: "", goal_time: "" },
    training_days: { training_days: 6 },
    other_training: { other_training: ["strength", "cycling"] }
  });
  assert.equal(asked.includes("other_training"), false, "other training is not required once diagnosis-ready");
  assert.ok(asked.includes("injury_status"));
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  engine.recordAnswer("race_details", { goal_race: "Race", goal_race_date: "2027-01-01", goal_time: "4:00" });
  engine.recordAnswer("experience", { experience: "3_5_years" });
  const previous = engine.previousQuestion("training_status");
  assert.equal(previous.key, "experience");
  engine.recordAnswer("goal", { goal_distance: "General fitness" });
  assert.deepEqual(Array.from(engine.history), ["goal"]);
  assert.equal(engine.answers.goal_race, undefined);
  assert.equal(engine.answers.goal_time, undefined);
  const nextAfterEdit = engine.nextQuestion();
  assert.ok(nextAfterEdit);
  assert.notEqual(nextAfterEdit.key, "race_details");
  assert.notEqual(nextAfterEdit.key, "perceived_limiter");
  assert.ok(
    ["weekly_volume", "experience", "training_status"].indexOf(nextAfterEdit.key) >= 0,
    "edited fitness goal should ask a high-value baseline, got " + nextAfterEdit.key
  );
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const answers = {
    ...common,
    goal: { goal_distance: "Marathon" },
    race_details: { goal_race: "Race", goal_race_date: "2027-02-01", goal_time: "" },
    training_days: { training_days: 3 },
    injury_status: { injury_has: "significant", injury_area: "Achilles" },
    schedule: { train_time: "varies", schedule_constraints: "" }
  };
  answerUntilComplete(engine, answers);
  const result = engine.complete();
  assert.equal(result.feasibility.rating, "not_advisable");
  assert.equal(result.athlevoRecommendation.safetyOverride, true);
  assert.equal(result.athlevoRecommendation.id, "medical_clearance");
  assert.equal(result.recommendation, undefined);
  assert.ok(Array.isArray(result.athlevoRecommendation.capabilities));
  assert.equal(result.athlevoRecommendation.capabilities.length, 0);
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "10K" });
  engine.recordAnswer("race_details", { goal_race: "City 10K", goal_race_date: "2027-01-10", goal_time: "45:00" });
  engine.recordAnswer("experience", { experience: "3_5_years" });
  engine.recordAnswer("training_days", { training_days: 4 });
  engine.recordAnswer("injury_status", { injury_has: "minor", injury_area: "calf" });
  engine.recordAnswer("schedule", { train_time: "varies", schedule_constraints: "rotating shifts" });
  const fields = engine.toProfileFields();
  assert.equal(fields.experience_years, 4);
  assert.equal(fields.available_days, 4);
  assert.equal(fields.training_days, 4);
  assert.equal(fields.race_date, "2027-01-10");
  assert.equal(fields.injury_history, "calf");
  assert.equal(fields.work_schedule, "rotating shifts");
  assert.equal(fields.target_race, "City 10K");
  assert.equal(fields.target_time, "45:00");
  for (const nonexistent of ["experience", "run_days", "goal_race_date", "injuries", "schedule"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(fields, nonexistent), false);
  }
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.setPendingFacts({
    goal_time: "sub-20:00",
    recent_race_dist: "5K",
    recent_race_time: "25:00",
    weekly_mileage: 25,
    training_structure: "balanced_quality"
  });
  assert.equal(engine.hasDiagnosticSufficiency(), true);
  assert.equal(engine.canComplete(), false, "injury safety gate still blocks completion");
  const next = engine.nextQuestion();
  assert.equal(next && next.key, "injury_status");
  assert.notEqual(next && next.key, "perceived_limiter");
  assert.notEqual(next && next.key, "current_capacity");
  engine.recordAnswer("injury_status", { injury_has: "none", injury_area: "" });
  assert.equal(engine.canComplete(), true);
  assert.equal(engine.nextQuestion(), null);
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  engine.setPendingFacts({
    weekly_mileage: 40,
    experience: "3_5_years",
    training_status: "building_base"
  });
  assert.equal(engine.hasDiagnosticSufficiency(), false, "marathon without longest run is not yet sufficient");
  const next = engine.nextQuestion();
  assert.ok(next);
  assert.ok(
    next.key === "current_capacity" || next.key === "race_details",
    "marathon should ask longest-run or timeline before perceived limiter, got " + (next && next.key)
  );
  assert.notEqual(next.key, "perceived_limiter");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.setPendingFacts({
    weekly_mileage: 30,
    recent_race_dist: "5K",
    recent_race_time: "22:00",
    training_status: "training_block",
    injury_has: "none"
  });
  assert.equal(engine.known.injury_status, true);
  assert.equal(engine.canComplete(), true);
  assert.equal(engine.nextQuestion(), null, "known injury is not re-asked");
}

{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "10K" });
  assert.equal(engine.hasDiagnosticSufficiency(), false);
  const next = engine.nextQuestion();
  assert.ok(next);
  assert.notEqual(next.key, "perceived_limiter");
  assert.notEqual(next.key, "schedule");
  assert.notEqual(next.key, "other_training");
}

console.log("PASS — diagnostic engine branching, editing, completion, feasibility, and safety override");

