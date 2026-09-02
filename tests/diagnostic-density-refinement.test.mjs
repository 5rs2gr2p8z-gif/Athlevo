import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/* ═══════════════════════════════════════════════════════════════════
 *  Diagnostic Density Refinement — Tests
 *  Covers: commentary classification, rhythm control, social proof,
 *  recommendation formatting, high-capacity depth trigger edge cases,
 *  normal-beginner safety, and conversational rhythm.
 * ═══════════════════════════════════════════════════════════════════ */

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
  for (let guard = 0; guard < 25 && !engine.canComplete(); guard++) {
    const question = engine.nextQuestion();
    if (!question) break;
    asked.push(question.key);
    assert.ok(answers[question.key], `missing fixture for ${question.key}`);
    engine.recordAnswer(question.key, answers[question.key]);
  }
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


/* ═══════════════════════════════════════════════════════════════════
 *  1. classifyCommentary: "show" for meaningful insights
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  assert.equal(Engine.classifyCommentary("perceived_limiter", { perceived_limiter: "endurance" }, { answers: {} }), "show");
  assert.equal(Engine.classifyCommentary("injury_status", { injury_has: "moderate", injury_area: "knee" }, { answers: {} }), "show");
  assert.equal(Engine.classifyCommentary("weekly_volume", { weekly_mileage: "20" }, { answers: { goal_distance: "Marathon" } }), "show");
  assert.equal(Engine.classifyCommentary("training_structure", { training_structure: "random" }, { answers: {} }), "show");
  assert.equal(Engine.classifyCommentary("current_capacity", { recent_longest_run_km: "6" }, { answers: { goal_distance: "Marathon" } }), "show");
  assert.equal(Engine.classifyCommentary("training_days", { training_days: 2 }, { answers: { goal_distance: "Marathon" } }), "show");
}

/* ═══════════════════════════════════════════════════════════════════
 *  2. classifyCommentary: "ack" for notable-but-routine
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  assert.equal(Engine.classifyCommentary("goal", { goal_distance: "Marathon" }, { answers: {} }), "ack");
  assert.equal(Engine.classifyCommentary("experience", { experience: "new" }, { answers: {} }), "ack");
  assert.equal(Engine.classifyCommentary("training_status", { training_status: "returning" }, { answers: {} }), "ack");
  assert.equal(Engine.classifyCommentary("injury_status", { injury_has: "none", injury_area: "" }, { answers: {} }), "ack");
  assert.equal(Engine.classifyCommentary("training_days", { training_days: 6 }, { answers: { goal_distance: "10K" } }), "ack");
  assert.equal(Engine.classifyCommentary("recent_performance", { recent_race_dist: "5K" }, { answers: {} }), "ack");
}

/* ═══════════════════════════════════════════════════════════════════
 *  3. classifyCommentary: "skip" for routine facts
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  assert.equal(Engine.classifyCommentary("schedule", { train_time: "morning" }, { answers: {} }), "skip");
  assert.equal(Engine.classifyCommentary("experience", { experience: "3_5_years" }, { answers: {} }), "skip");
  assert.equal(Engine.classifyCommentary("training_status", { training_status: "building_base" }, { answers: {} }), "skip");
  assert.equal(Engine.classifyCommentary("current_running_frequency", { current_running_frequency: "freq_2_3" }, { answers: {} }), "skip");
  assert.equal(Engine.classifyCommentary("training_structure", { training_structure: "balanced_quality" }, { answers: {} }), "skip");
  assert.equal(Engine.classifyCommentary("weekly_volume", { weekly_mileage: "15" }, { answers: { goal_distance: "10K" } }), "skip");
  assert.equal(Engine.classifyCommentary("current_capacity", { recent_longest_run_km: "18" }, { answers: { goal_distance: "Half marathon" } }), "skip");
  // Unknown keys default to skip
  assert.equal(Engine.classifyCommentary("unknown_question", {}, { answers: {} }), "skip");
}

/* ═══════════════════════════════════════════════════════════════════
 *  4. Conversational rhythm: normal first10k flow has fewer commentaries
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();

  // Simulate a normal 10K flow and classify each answer
  const flow = [
    { key: "goal", fields: { goal_distance: "10K" } },
    { key: "race_details", fields: { goal_race: "", goal_race_date: "", goal_time: "" } },
    { key: "experience", fields: { experience: "1_2_years" } },
    { key: "training_status", fields: { training_status: "building_base" } },
    { key: "weekly_volume", fields: { weekly_mileage: "25", weekly_hours: "3" } },
    { key: "current_capacity", fields: { recent_consistency: "mostly_consistent", recent_longest_run_km: "8" } },
    { key: "training_days", fields: { training_days: 4 } },
    { key: "training_structure", fields: { training_structure: "easy_long" } },
    { key: "injury_status", fields: { injury_has: "none", injury_area: "" } }
  ];

  let showCount = 0, ackCount = 0, skipCount = 0;
  let consecutiveShown = 0;
  let wouldDisplay = 0;

  for (const step of flow) {
    engine.recordAnswer(step.key, step.fields);
    const state = engine._stateView();
    const cat = Engine.classifyCommentary(step.key, step.fields, state);
    if (cat === "show") {
      showCount++;
      consecutiveShown = 0; // resets
      wouldDisplay++;
    } else if (cat === "ack") {
      ackCount++;
      if (consecutiveShown < 2) {
        consecutiveShown++;
        wouldDisplay++;
      } else {
        consecutiveShown = 0; // suppressed
      }
    } else {
      skipCount++;
    }
  }

  // With 9 questions, we expect materially fewer displayed commentaries
  assert.ok(skipCount >= 3, `expected >=3 skips in normal flow, got ${skipCount}`);
  assert.ok(wouldDisplay <= 6, `expected <=6 displayed commentaries (rhythm-gated), got ${wouldDisplay}`);
  assert.ok(wouldDisplay < flow.length, "commentary count must be less than question count");
}

/* ═══════════════════════════════════════════════════════════════════
 *  5. Edge case A: 5K, 50km/week, 6 days, 12km long run, consistent
 *     → high capacity (trained 5K runner needs performance context)
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "5K" });
  engine.recordAnswer("weekly_volume", { weekly_mileage: "50", weekly_hours: "6" });
  engine.recordAnswer("current_capacity", { recent_consistency: "mostly_consistent", recent_longest_run_km: "12" });
  engine.recordAnswer("training_days", { training_days: 6 });
  assert.equal(engine._isHighCapacityProfile(), true,
    "A: 5K at 50km/week, 12km long, 6 days, consistent → high capacity");
}

/* ═══════════════════════════════════════════════════════════════════
 *  6. Edge case B: 10K, 40km/week, 6 days, 24km long run, consistent
 *     → high capacity (unusual long run despite moderate mileage)
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "10K" });
  engine.recordAnswer("weekly_volume", { weekly_mileage: "40", weekly_hours: "5" });
  engine.recordAnswer("current_capacity", { recent_consistency: "mostly_consistent", recent_longest_run_km: "24" });
  engine.recordAnswer("training_days", { training_days: 6 });
  assert.equal(engine._isHighCapacityProfile(), true,
    "B: 10K at 40km/week but 24km long run + 6 days + consistent → high capacity");
}

/* ═══════════════════════════════════════════════════════════════════
 *  7. Edge case C: 10K, 70km/week, 4 days, 14km long run, consistent
 *     → high capacity (high volume concentrated in fewer days)
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "10K" });
  engine.recordAnswer("weekly_volume", { weekly_mileage: "70", weekly_hours: "8" });
  engine.recordAnswer("current_capacity", { recent_consistency: "mostly_consistent", recent_longest_run_km: "14" });
  engine.recordAnswer("training_days", { training_days: 4 });
  assert.equal(engine._isHighCapacityProfile(), true,
    "C: 10K at 70km/week, 4 days, consistent → high capacity (volume + freq)");
}

/* ═══════════════════════════════════════════════════════════════════
 *  8. Edge case D: 10K, 90km/week, 26km long run, inconsistent
 *     → high capacity (3 signals override missing consistency)
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "10K" });
  engine.recordAnswer("weekly_volume", { weekly_mileage: "90", weekly_hours: "10" });
  engine.recordAnswer("current_capacity", { recent_consistency: "occasional", recent_longest_run_km: "26" });
  engine.recordAnswer("training_days", { training_days: 5 });
  assert.equal(engine._isHighCapacityProfile(), true,
    "D: 10K at 90km/week, 26km long, 5 days but inconsistent → high capacity (3 signals override)");
}

/* ═══════════════════════════════════════════════════════════════════
 *  9. Edge case E: marathon/half at high volume → NOT high capacity
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const e1 = Engine.create();
  e1.begin();
  e1.recordAnswer("goal", { goal_distance: "Marathon" });
  e1.recordAnswer("weekly_volume", { weekly_mileage: "100", weekly_hours: "12" });
  e1.recordAnswer("current_capacity", { recent_consistency: "mostly_consistent", recent_longest_run_km: "32" });
  e1.recordAnswer("training_days", { training_days: 6 });
  assert.equal(e1._isHighCapacityProfile(), false,
    "E: marathon at 100km/week → NOT high capacity (normal for distance)");

  const e2 = Engine.create();
  e2.begin();
  e2.recordAnswer("goal", { goal_distance: "Half marathon" });
  e2.recordAnswer("weekly_volume", { weekly_mileage: "80", weekly_hours: "9" });
  e2.recordAnswer("current_capacity", { recent_consistency: "mostly_consistent", recent_longest_run_km: "25" });
  e2.recordAnswer("training_days", { training_days: 5 });
  assert.equal(e2._isHighCapacityProfile(), false,
    "E: half marathon at 80km/week → NOT high capacity");
}

/* ═══════════════════════════════════════════════════════════════════
 *  10. Normal beginner does NOT trigger, completes without extra Q
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const normalAnswers = {
    ...common,
    goal: { goal_distance: "10K" },
    race_details: { goal_race: "", goal_race_date: "", goal_time: "" },
    weekly_volume: { weekly_mileage: "20", weekly_hours: "3" },
    current_capacity: { recent_consistency: "occasional", recent_longest_run_km: "5" },
    training_days: { training_days: 3 },
    training_structure: { training_structure: "easy_long" },
    training_status: { training_status: "building_base" }
  };
  const asked = answerUntilComplete(engine, normalAnswers);
  assert.equal(engine._isHighCapacityProfile(), false,
    "normal beginner is NOT high-capacity");
  assert.equal(engine.canComplete(), true);
}

/* ═══════════════════════════════════════════════════════════════════
 *  11. High-capacity flow: performance question required, then completes
 * ═══════════════════════════════════════════════════════════════════ */
{
  const { Engine } = loadEngine();
  const engine = Engine.create();
  engine.begin();
  const highCapAnswers = {
    ...common,
    goal: { goal_distance: "10K" },
    race_details: { goal_race: "", goal_race_date: "", goal_time: "" },
    weekly_volume: { weekly_mileage: "90", weekly_hours: "10" },
    current_capacity: { recent_consistency: "mostly_consistent", recent_longest_run_km: "26" },
    training_days: { training_days: 6 },
    training_structure: { training_structure: "balanced_quality" },
    training_status: { training_status: "training_block" },
    recent_performance: { recent_race_dist: "10K", recent_race_time: "38:00" }
  };
  const asked = answerUntilComplete(engine, highCapAnswers);
  assert.ok(asked.includes("recent_performance"),
    "high-capacity profile must be asked recent_performance");
  assert.equal(engine.canComplete(), true);
}

/* ═══════════════════════════════════════════════════════════════════
 *  12. Social proof copy contains expected strings
 * ═══════════════════════════════════════════════════════════════════ */
{
  // Load the UI file and check the social proof copy is present
  const uiSource = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(uiSource.includes("153+ runners"), "social proof mentions 153+ runners");
  assert.ok(uiSource.includes("54+ personal bests"), "stat caption mentions 54+ personal bests");
  // Stat should NOT be in a separate chat bubble — should be inside carousel structure
  assert.ok(!uiSource.includes('chat-msg-social-proof-stat'), "stat is not a separate chat message class");
  assert.ok(uiSource.includes('chat-social-proof-stat'), "stat is a carousel caption class");
}

/* ═══════════════════════════════════════════════════════════════════
 *  13. Recommendation text is HTML-escaped via esc()
 * ═══════════════════════════════════════════════════════════════════ */
{
  const uiSource = readFileSync("./js/diagnosticUI.js", "utf8");
  assert.ok(uiSource.includes("esc(changes[c])"), "recommendation text is escaped before HTML insertion");
}

console.log("PASS — diagnostic density refinement: classifier, rhythm, high-capacity edge cases A-E, social proof, escaping");
