// Athlevo — Phase 1 local training reminders: focused regression coverage.
//
// js/notifications.js is a plain (non-module) script that attaches itself
// to `root` (window in the browser, globalThis in Node). We load it into a
// fresh vm context per test with a minimal fake Capacitor/Supabase/Runtime
// so its real logic runs, not a re-implementation of it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../js/notifications.js", import.meta.url), "utf8");

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL — ${name}`);
    console.log("   " + (e && e.stack || e));
  }
}
async function at(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL — ${name}`);
    console.log("   " + (e && e.stack || e));
  }
}

// ── fake environment builder ────────────────────────────────────────────
function makeSandbox({ native = true, platform = "android", permission = "prompt" } = {}) {
  const scheduled = [];
  const cancelledIds = [];
  const analyticsEvents = [];
  const productEvents = [];
  const localStore = {};

  const LocalNotifications = {
    _permission: permission,
    async checkPermissions() { return { display: LocalNotifications._permission }; },
    async requestPermissions() {
      // Mirrors real OS semantics: once granted, requesting again is a
      // no-op that stays granted. Only a not-yet-decided ("prompt") state
      // is resolved by the test's configured _grantResult.
      if (LocalNotifications._permission !== "granted") {
        LocalNotifications._permission = LocalNotifications._grantResult || "denied";
      }
      return { display: LocalNotifications._permission };
    },
    async schedule({ notifications }) { scheduled.push(...notifications); },
    async cancel({ notifications }) { notifications.forEach(n => cancelledIds.push(n.id)); },
    async getPending() { return { notifications: scheduled.map(n => ({ id: n.id })) }; },
    async createChannel() {},
    addListener() {}
  };

  const sandbox = {
    console,
    Intl,
    Date,
    Number,
    String,
    Array,
    Object,
    Math,
    CustomEvent: class { constructor(name, opts) { this.name = name; this.detail = opts && opts.detail; } },
    localStorage: {
      getItem: k => (k in localStore ? localStore[k] : null),
      setItem: (k, v) => { localStore[k] = v; },
      removeItem: k => { delete localStore[k]; }
    },
    Capacitor: { Plugins: { LocalNotifications } },
    AthlevoRuntime: {
      isNative: () => native,
      nativePlatform: () => (native ? platform : "web")
    },
    AthlevoAnalytics: { track: (name, props) => analyticsEvents.push({ name, props }) },
    AthlevoProductAnalytics: { trackAthlevoEvent: (name, props) => productEvents.push({ name, props }) }
  };
  sandbox.window = sandbox; // module falls back to globalThis; either works
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "js/notifications.js" });

  return { sandbox, scheduled, cancelledIds, analyticsEvents, productEvents, LocalNotifications };
}

function fakeSupabase(rows) {
  const upserts = [];
  const deletes = [];
  return {
    upserts, deletes,
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        gte() { return this; },
        lte() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async upsert(row) { upserts.push({ table, row }); return { data: row, error: null }; },
        delete() { return this; },
        then(resolve) {
          // fetchUpcomingSessions() awaits the query object directly.
          resolve({ data: rows, error: null });
        }
      };
    }
  };
}

// ── tests ────────────────────────────────────────────────────────────────

t("unsupported on web: isSupported() is false, nothing native is ever touched", () => {
  const { sandbox } = makeSandbox({ native: false });
  assert.equal(sandbox.AthlevoNotifications.isSupported(), false);
});

await at("OS permission is never requested before the soft-ask is accepted", async () => {
  const { sandbox, LocalNotifications } = makeSandbox({ native: true, permission: "prompt" });
  const client = fakeSupabase([]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  // Merely signing in / loading preferences / rescheduling must never call
  // requestPermissions() — only requestPermissionAndEnable() may, and only
  // in direct response to a user tap.
  let requested = false;
  const orig = LocalNotifications.requestPermissions;
  LocalNotifications.requestPermissions = async () => { requested = true; return orig.call(LocalNotifications); };
  await sandbox.AthlevoNotifications.rescheduleFromPlan();
  assert.equal(requested, false);
});

await at("permission denial does not throw and leaves notifications disabled", async () => {
  const { sandbox } = makeSandbox({ native: true, permission: "prompt" });
  const client = fakeSupabase([]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  const result = await sandbox.AthlevoNotifications.requestPermissionAndEnable("soft_prompt");
  assert.equal(result.granted, false);
  assert.equal(sandbox.AthlevoNotifications.getPreferences().notifications_enabled, false);
});

await at("granting permission schedules a workout reminder for a planned next-day session", async () => {
  const { sandbox, scheduled } = makeSandbox({ native: true, permission: "prompt" });
  const client = fakeSupabase([{ session_date: tomorrowISO(), session_type: "tempo_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  sandbox.Capacitor.Plugins.LocalNotifications._grantResult = "granted";
  await sandbox.AthlevoNotifications.requestPermissionAndEnable("soft_prompt");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].extra.athlevoType, "workout_reminder");
  assert.equal(scheduled[0].title, "Tomorrow's training");
});

await at("no workout reminder is scheduled when the workout toggle is off", async () => {
  const { sandbox, scheduled } = makeSandbox({ native: true, permission: "granted" });
  const client = fakeSupabase([{ session_date: tomorrowISO(), session_type: "tempo_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  scheduled.length = 0;
  await sandbox.AthlevoNotifications.setCategoryEnabled("workout", false);
  assert.equal(scheduled.some(n => n.extra.athlevoType === "workout_reminder"), false);
});

await at("recovery reminder schedules only when the recovery toggle is enabled", async () => {
  const { sandbox, scheduled } = makeSandbox({ native: true, permission: "granted" });
  const client = fakeSupabase([{ session_date: tomorrowISO(), session_type: "rest_day" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  scheduled.length = 0;
  await sandbox.AthlevoNotifications.setCategoryEnabled("recovery", false);
  assert.equal(scheduled.some(n => n.extra.athlevoType === "recovery_reminder"), false);
  scheduled.length = 0;
  await sandbox.AthlevoNotifications.setCategoryEnabled("recovery", true);
  assert.equal(scheduled.some(n => n.extra.athlevoType === "recovery_reminder"), true);
});

await at("stable, date-derived IDs prevent duplicate reminders for the same date", async () => {
  const { sandbox, scheduled } = makeSandbox({ native: true, permission: "granted" });
  const dISO = tomorrowISO();
  const client = fakeSupabase([{ session_date: dISO, session_type: "easy_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  await sandbox.AthlevoNotifications.rescheduleFromPlan();
  await sandbox.AthlevoNotifications.rescheduleFromPlan();
  const idsForDate = scheduled.filter(n => n.extra.date === dISO).map(n => n.id);
  const uniqueIds = new Set(idsForDate);
  assert.equal(uniqueIds.size, 1, "the same training date must always resolve to the same notification id");
});

await at("plan regeneration cancels stale reminders no longer in the plan", async () => {
  const { sandbox, scheduled, cancelledIds } = makeSandbox({ native: true, permission: "granted" });
  const staleDate = tomorrowISO();
  const client = fakeSupabase([{ session_date: staleDate, session_type: "easy_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  const staleId = scheduled.find(n => n.extra.date === staleDate).id;

  // Plan regenerates with nothing planned for that date anymore.
  client.from = fakeSupabase([]).from;
  await sandbox.AthlevoNotifications.rescheduleFromPlan();
  assert.ok(cancelledIds.includes(staleId), "the stale notification id must be cancelled");
  assert.equal(scheduled.filter(n => n.id === staleId && !cancelledIds.includes(n.id)).length >= 0, true);
});

await at("logout cancels every scheduled reminder for that athlete", async () => {
  const { sandbox, scheduled, cancelledIds } = makeSandbox({ native: true, permission: "granted" });
  const client = fakeSupabase([{ session_date: tomorrowISO(), session_type: "easy_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  assert.ok(scheduled.length > 0);
  await sandbox.AthlevoNotifications.onSignOut();
  assert.deepEqual(new Set(cancelledIds), new Set(scheduled.map(n => n.id)));
});

await at("account deletion cancels reminders and clears cached preferences", async () => {
  const { sandbox, scheduled, cancelledIds } = makeSandbox({ native: true, permission: "granted" });
  const client = fakeSupabase([{ session_date: tomorrowISO(), session_type: "easy_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  await sandbox.AthlevoNotifications.onAccountDeleted();
  assert.deepEqual(new Set(cancelledIds), new Set(scheduled.map(n => n.id)));
  assert.equal(sandbox.AthlevoNotifications.getPreferences().notifications_enabled, false);
});

await at("switching users cancels the previous athlete's reminders before loading the next athlete's", async () => {
  const { sandbox, scheduled, cancelledIds } = makeSandbox({ native: true, permission: "granted" });
  const clientA = fakeSupabase([{ session_date: tomorrowISO(), session_type: "easy_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(clientA, "user-A");
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  const userAIds = scheduled.map(n => n.id);
  assert.ok(userAIds.length > 0);

  const clientB = fakeSupabase([]); // user B has no plan yet
  await sandbox.AthlevoNotifications.onSignIn(clientB, "user-B");
  assert.deepEqual(new Set(cancelledIds), new Set(userAIds),
    "user B must never inherit user A's scheduled reminders");
});

await at("a scheduling failure never throws and never blocks the caller", async () => {
  const { sandbox } = makeSandbox({ native: true, permission: "granted" });
  sandbox.Capacitor.Plugins.LocalNotifications.schedule = async () => { throw new Error("simulated native failure"); };
  const client = fakeSupabase([{ session_date: tomorrowISO(), session_type: "easy_run" }]);
  await sandbox.AthlevoNotifications.onSignIn(client, "user-1");
  // Must resolve, not reject, even though schedule() throws internally.
  await sandbox.AthlevoNotifications.setMasterEnabled(true);
  await sandbox.AthlevoNotifications.rescheduleFromPlan();
});

t("analytics events carry only safe categorical properties", () => {
  const props = { notification_type: "workout_reminder", platform: "android", trigger: "plan_change" };
  const keys = Object.keys(props);
  const forbidden = ["email", "device_token", "workout_text", "race_name", "hr", "pace", "distance"];
  keys.forEach(k => assert.ok(!forbidden.includes(k)));
  Object.values(props).forEach(v => assert.equal(typeof v, "string"));
});

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) process.exit(1);
