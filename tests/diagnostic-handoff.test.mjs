import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const migration = readFileSync("./migrations/2026-08-26_athlete_diagnostics.sql", "utf8");
assert.match(migration, /create table if not exists public\.athlete_diagnostics/i);
assert.match(migration, /unique \(user_id, import_key\)/i);
assert.match(migration, /references auth\.users \(id\) on delete cascade/i);
assert.match(migration, /enable row level security/i);
assert.match(migration, /to authenticated[\s\S]*auth\.uid\(\)[\s\S]*user_id/i);
assert.match(migration, /revoke all on table public\.athlete_diagnostics from public, anon/i);
assert.doesNotMatch(migration, /for delete|grant delete|truncate|drop table/i);

function createContext(engine) {
  const session = new Map();
  let cleared = false;
  const context = {
    console: { warn() {} },
    sessionStorage: {
      getItem: key => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, value)
    },
    AthlevoDiagnostic: {
      hasPending: () => true,
      load: () => engine,
      clearPending: () => { cleared = true; }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("./js/diagnosticHandoff.js", "utf8"), context);
  return { context, wasCleared: () => cleared };
}

function engineFixture() {
  return {
    completed: true,
    result: {
      primaryLimiter: { key: "aerobic_base" },
      recommendation: { recommended: { id: "ai" } },
      feasibility: { rating: "realistic" },
      safetyFlags: { injuryReported: false }
    },
    history: ["goal", "experience"],
    importKey: () => "diag_1_stable_key_1234",
    toDiagnosticRow: userId => ({
      user_id: userId,
      import_key: "diag_1_stable_key_1234",
      answers: { goal_distance: "10K" },
      result: { feasibility: { rating: "realistic" } }
    }),
    toProfileFields: () => ({
      goal: "10K",
      experience_years: 1,
      available_days: 4,
      training_days: 4,
      target_race: "10K"
    })
  };
}

function supabaseMock({ diagnosticError = null, profileError = null } = {}) {
  const captured = { row: null, conflict: null, profileSelect: null, updates: null };
  return {
    captured,
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from(table) {
      if (table === "athlete_diagnostics") {
        return {
          upsert(row, options) {
            captured.row = row;
            captured.conflict = options.onConflict;
            return {
              select() {
                return { single: async () => diagnosticError
                  ? { data: null, error: { message: diagnosticError } }
                  : { data: { id: "diag-row", import_key: row.import_key }, error: null } };
              }
            };
          }
        };
      }
      if (table === "profiles") {
        return {
          select(columns) {
            captured.profileSelect = columns;
            return {
              eq() {
                return { maybeSingle: async () => ({
                  data: { goal: "Existing marathon goal", experience_years: null, available_days: null, training_days: null, target_race: null },
                  error: null
                }) };
              }
            };
          },
          update(updates) {
            captured.updates = updates;
            return {
              eq() {
                return {
                  select() {
                    return { single: async () => profileError
                      ? { data: null, error: { message: profileError } }
                      : { data: { id: "user-1" }, error: null } };
                  }
                };
              }
            };
          }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
}

{
  const engine = engineFixture();
  const { context, wasCleared } = createContext(engine);
  const supabase = supabaseMock();
  const outcome = await context.AthlevoDiagnosticHandoff.attach("user-1", supabase);
  assert.equal(outcome.attached, true);
  assert.equal(wasCleared(), true);
  assert.equal(supabase.captured.conflict, "user_id,import_key");
  assert.equal(supabase.captured.row.user_id, "user-1");
  assert.deepEqual(supabase.captured.row.answers, { goal_distance: "10K" });
  assert.match(supabase.captured.profileSelect, /experience_years/);
  assert.doesNotMatch(supabase.captured.profileSelect, /diagnostic_result|run_days|goal_race_date/);
  assert.equal(supabase.captured.updates.goal, undefined, "existing account goal must be preserved");
  assert.equal(supabase.captured.updates.experience_years, 1);
  assert.ok(context.AthlevoDiagnosticHandoff.knownOnboardingFields().includes("training_days"));
}

{
  const engine = engineFixture();
  const { context, wasCleared } = createContext(engine);
  const outcome = await context.AthlevoDiagnosticHandoff.attach("user-1", supabaseMock({ diagnosticError: "relation does not exist" }));
  assert.equal(outcome.attached, false);
  assert.equal(wasCleared(), false, "missing migration must retain local diagnostic");
}

{
  const engine = engineFixture();
  const { context, wasCleared } = createContext(engine);
  const outcome = await context.AthlevoDiagnosticHandoff.attach("user-1", supabaseMock({ profileError: "write failed" }));
  assert.equal(outcome.attached, false);
  assert.equal(wasCleared(), false, "failed profile hydration must retain local diagnostic");
}

console.log("PASS — diagnostic handoff authentication, idempotent row, safe profile merge, and failure retention");
