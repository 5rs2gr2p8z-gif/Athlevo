import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const STORAGE_KEY = "athlevo_pending_diagnostic_v1";

function world() {
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

function finish(engine) {
  const fixtures = {
    goal: { goal_distance: "General fitness" },
    experience: { experience: "new" },
    training_status: { training_status: "starting" },
    current_capacity: { recent_consistency: "occasional", recent_longest_run_km: "4" },
    training_days: { training_days: 4 },
    training_structure: { training_structure: "mostly_easy" },
    perceived_limiter: { perceived_limiter: "aerobic" },
    injury_status: { injury_has: "none" }
  };
  engine.begin();
  while (!engine.canComplete()) {
    const q = engine.nextQuestion();
    assert.ok(q);
    engine.recordAnswer(q.key, fixtures[q.key]);
  }
  engine.complete();
}

{
  const { Engine } = world();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "General fitness" });
  const restored = Engine.load();
  assert.equal(restored.history[0], "goal");
  assert.equal(restored.begun, true);
  assert.equal(restored.importKey(), engine.importKey(), "OAuth-style restore keeps a stable import key");
}

{
  const { Engine } = world();
  const engine = Engine.create();
  finish(engine);
  const restored = Engine.load();
  assert.equal(restored.completed, true);
  assert.equal(restored.result.athlevoRecommendation.id, engine.result.athlevoRecommendation.id);
}

for (const mutate of [
  payload => { payload.v = 99; },
  payload => { payload.questionAnswers.goal.goal_distance = "x".repeat(500); },
  payload => { payload.completed = true; payload.completedAt = null; payload.result = null; },
  payload => {
    payload.savedAt = "2020-01-01T00:00:00.000Z";
    payload.expiresAt = "2020-01-31T00:00:00.000Z";
  }
]) {
  const { Engine, values } = world();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "General fitness" });
  const payload = JSON.parse(values.get(STORAGE_KEY));
  mutate(payload);
  values.set(STORAGE_KEY, JSON.stringify(payload));
  assert.equal(Engine.load(), null);
  assert.equal(values.has(STORAGE_KEY), false, "invalid/stale payload should be cleared");
}

{
  const { Engine, values } = world();
  values.set(STORAGE_KEY, "{not-json");
  assert.equal(Engine.load(), null);
  assert.equal(values.has(STORAGE_KEY), false);
}

{
  const { Engine, values } = world();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  const payload = JSON.parse(values.get(STORAGE_KEY));
  assert.equal(payload.pendingFacts === undefined || typeof payload.pendingFacts === "object", true);
  delete payload.pendingFacts;
  values.set(STORAGE_KEY, JSON.stringify(payload));
  const restored = Engine.load();
  assert.ok(restored);
  assert.equal(restored.answers.goal_distance, "Marathon");
  assert.equal(Object.keys(restored.getPendingFacts()).length, 0);
}

{
  const { Engine, values } = world();
  const engine = Engine.create();
  engine.begin();
  engine.recordAnswer("goal", { goal_distance: "Marathon" });
  engine.setPendingFacts({ weekly_mileage: 35, recent_longest_run_km: 15, junk: "nope" });
  const restored = Engine.load();
  assert.equal(restored.getPendingFacts().weekly_mileage, 35);
  assert.equal(restored.getPendingFacts().recent_longest_run_km, 15);
  assert.equal(restored.getPendingFacts().junk, undefined);

  const payload = JSON.parse(values.get(STORAGE_KEY));
  payload.pendingFacts = "not-an-object";
  values.set(STORAGE_KEY, JSON.stringify(payload));
  const stillValid = Engine.load();
  assert.ok(stillValid, "malformed pendingFacts must not invalidate the diagnostic");
  assert.equal(Object.keys(stillValid.getPendingFacts()).length, 0);
}

console.log("PASS — diagnostic persistence validation, TTL, corruption handling, completion, and OAuth restore");
