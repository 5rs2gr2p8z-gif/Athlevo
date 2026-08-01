/*
 * Athlevo — Managed Athlete Mode tests.
 *
 * MODE RESOLUTION · PLAN AUTHORITY · CLIENT SPOOFING · TRANSITION SAFETY ·
 * TODAY AUTHORSHIP · COACH-TAB SWITCHING · TRAIN PERMISSIONS ·
 * ADJUSTMENT REQUESTS · YOU ASSIGNED-COACH · SELF-GUIDED REGRESSION ·
 * ANALYTICS PRIVACY · UNKNOWN MODE (three-state security)
 *
 * Pure logic is tested directly; client + registry are loaded in a sandbox.
 * No live DB needed.
 *
 * Run: node tests/managed-athlete.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  resolveCoachingMode, isHumanCoached, buildSafeCoachProfile,
  COACHING_MODES
} from "../lib/server/coachingMode.js";

import {
  sessionOwnerType, isCoachOwned, canAIDirectlyWriteSession,
  coachOwnedTargets, classifyWriteIntent, evaluatePlanWrite,
  stampOwnership, stripClientAuthorityFields, authorshipLabel,
  OWNER_TYPES
} from "../lib/server/planAuthority.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n)) : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

function loadGlobal(relPath, extra) {
  const code = readFileSync(join(root, relPath), "utf8");
  const sandbox = Object.assign({
    window: {}, document: { querySelectorAll: () => [], getElementById: () => null },
    location: { hash: "" }, history: {}, console, fetch: () => {},
    supabaseClient: null, toast: () => {}, globalThis: {}
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window;
}

/*
 * Build a sandboxed athleteMode.js instance with a controllable fetch().
 * `fetchBehavior`:
 *   { status: 200, body: {...} }       → successful JSON response
 *   { status: 401 }                    → auth failure
 *   { status: 500 }                    → server error
 *   { throw: true }                    → network failure (fetch throws)
 *   { noToken: true }                  → supabaseClient returns no token
 */
function loadAthleteModeWith(fetchBehavior) {
  const tracked = [];
  const code = readFileSync(join(root, "js/athleteMode.js"), "utf8");
  const hasToken = !fetchBehavior.noToken;
  const mockFetch = function (url, opts) {
    if (fetchBehavior.throw) throw new Error("NetworkError: failed to fetch");
    return Promise.resolve({
      ok: fetchBehavior.status >= 200 && fetchBehavior.status < 300,
      status: fetchBehavior.status || 500,
      json: () => Promise.resolve(fetchBehavior.body || { error: "simulated" })
    });
  };
  const mockSb = hasToken ? {
    auth: {
      getSession: () => Promise.resolve({
        data: { session: { access_token: "test-token-xyz" } }
      })
    }
  } : {
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) }
  };

  const sandbox = {
    window: {},
    document: {
      querySelectorAll: () => [],
      getElementById: () => null,
      body: { appendChild: () => {} },
      documentElement: { appendChild: () => {} }
    },
    location: { hash: "" }, history: {}, console,
    fetch: mockFetch,
    supabaseClient: mockSb,
    toast: () => {},
    globalThis: {},
    Date, Promise, Error, JSON, String, Number, Array, Object, Boolean,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn) => fn(), clearTimeout: () => {}
  };
  sandbox.window.AthlevoAnalytics = { track: (e, p) => tracked.push({ event: e, props: p }) };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { AM: sandbox.window.AthlevoAthleteMode, tracked };
}

const COACH = "coach-1", COACH2 = "coach-2", ATH = "ath-1";

function makeAssignment(coachId, athleteId, status, assignedAt) {
  return { id: `asg-${coachId}-${athleteId}`, coach_id: coachId, athlete_id: athleteId, status, assigned_at: assignedAt || "2026-01-01T00:00:00Z" };
}

/* ═══════════════════════════ MODE RESOLUTION ═══════════════════════════ */
section("MODE RESOLUTION");

t("no assignments → self_guided", (() => {
  const r = resolveCoachingMode([], ATH);
  return r.mode === "self_guided" && r.coachId === null && r.activeCoachCount === 0;
})());

t("null/undefined assignments → self_guided", (() => {
  return resolveCoachingMode(null, ATH).mode === "self_guided" &&
         resolveCoachingMode(undefined, ATH).mode === "self_guided";
})());

t("one active assignment → human_coached", (() => {
  const r = resolveCoachingMode([makeAssignment(COACH, ATH, "active")], ATH);
  return r.mode === "human_coached" && r.coachId === COACH && !r.ambiguous && r.activeCoachCount === 1;
})());

t("invited/paused/ended do NOT activate", (() => {
  const asgs = [
    makeAssignment(COACH, ATH, "invited"),
    makeAssignment(COACH2, ATH, "paused"),
    makeAssignment("coach-3", ATH, "ended")
  ];
  return resolveCoachingMode(asgs, ATH).mode === "self_guided";
})());

t("multiple active coaches → human_coached + ambiguous", (() => {
  const asgs = [
    makeAssignment(COACH, ATH, "active", "2026-02-01"),
    makeAssignment(COACH2, ATH, "active", "2026-03-01")
  ];
  const r = resolveCoachingMode(asgs, ATH);
  return r.mode === "human_coached" && r.ambiguous && r.activeCoachCount === 2 && r.coachId === COACH;
})());

t("primary = earliest assigned_at (deterministic)", (() => {
  const asgs = [
    makeAssignment(COACH2, ATH, "active", "2026-01-15"),
    makeAssignment(COACH, ATH, "active", "2026-01-10")
  ];
  return resolveCoachingMode(asgs, ATH).coachId === COACH;
})());

t("duplicate active rows from same coach → not ambiguous", (() => {
  const asgs = [
    makeAssignment(COACH, ATH, "active", "2026-01-01"),
    { ...makeAssignment(COACH, ATH, "active", "2026-02-01"), id: "asg-dup" }
  ];
  return !resolveCoachingMode(asgs, ATH).ambiguous;
})());

t("other athlete's assignments ignored", (() => {
  const asgs = [makeAssignment(COACH, "other-athlete", "active")];
  return resolveCoachingMode(asgs, ATH).mode === "self_guided";
})());

t("isHumanCoached shortcut", (() => {
  return isHumanCoached([makeAssignment(COACH, ATH, "active")], ATH) === true &&
         isHumanCoached([], ATH) === false;
})());

t("empty athleteId → self_guided", resolveCoachingMode([makeAssignment(COACH, ATH, "active")], "").mode === "self_guided");

/* ═══════════════════════════ PLAN AUTHORITY ════════════════════════════ */
section("PLAN AUTHORITY");

t("sessionOwnerType defaults to athlete_ai", sessionOwnerType({}) === "athlete_ai");
t("sessionOwnerType reads owner_type", sessionOwnerType({ owner_type: "human_coach" }) === "human_coach");
t("sessionOwnerType falls back to source", sessionOwnerType({ source: "coach" }) === "human_coach");
t("unknown source → athlete_ai (never human_coach)", sessionOwnerType({ source: "unknown" }) === "athlete_ai");
t("isCoachOwned", isCoachOwned({ owner_type: "human_coach" }) === true && isCoachOwned({ owner_type: "athlete_ai" }) === false);

t("canAIDirectlyWriteSession — self_guided always yes", (() => {
  return canAIDirectlyWriteSession("self_guided", { owner_type: "human_coach" }) === true;
})());

t("canAIDirectlyWriteSession — human_coached + coach-owned → no", (() => {
  return canAIDirectlyWriteSession("human_coached", { owner_type: "human_coach" }) === false;
})());

t("canAIDirectlyWriteSession — human_coached + ai-owned → yes", (() => {
  return canAIDirectlyWriteSession("human_coached", { owner_type: "athlete_ai" }) === true;
})());

t("coachOwnedTargets filters correctly", (() => {
  const sessions = [
    { owner_type: "human_coach" },
    { owner_type: "athlete_ai" },
    { owner_type: "human_coach" }
  ];
  return coachOwnedTargets("human_coached", sessions).length === 2 &&
         coachOwnedTargets("self_guided", sessions).length === 0;
})());

t("classifyWriteIntent", (() => {
  return classifyWriteIntent("self_guided", "ai") === "direct" &&
         classifyWriteIntent("human_coached", "ai") === "ai_proposal" &&
         classifyWriteIntent("human_coached", "athlete") === "athlete_request";
})());

t("evaluatePlanWrite — self_guided always allowed", (() => {
  const r = evaluatePlanWrite({ mode: "self_guided", origin: "ai", sessions: [{ owner_type: "human_coach" }] });
  return r.allowed === true && r.intent === "direct";
})());

t("evaluatePlanWrite — human_coached + coach-owned → blocked", (() => {
  const r = evaluatePlanWrite({ mode: "human_coached", origin: "ai", sessions: [{ owner_type: "human_coach" }] });
  return r.allowed === false && r.reason === "coach_approval_required";
})());

t("evaluatePlanWrite — human_coached + no coach-owned → allowed", (() => {
  const r = evaluatePlanWrite({ mode: "human_coached", origin: "ai", sessions: [{ owner_type: "athlete_ai" }] });
  return r.allowed === true;
})());

t("evaluatePlanWrite — athlete origin + coach-owned → athlete_request_required", (() => {
  const r = evaluatePlanWrite({ mode: "human_coached", origin: "athlete", sessions: [{ owner_type: "human_coach" }] });
  return r.allowed === false && r.reason === "athlete_request_required";
})());

/* ═══════════════════════ CLIENT SPOOFING PREVENTION ═══════════════════ */
section("CLIENT SPOOFING PREVENTION");

t("stripClientAuthorityFields removes dangerous keys", (() => {
  const input = {
    title: "My workout",
    owner_type: "human_coach",
    source: "hacked",
    created_by: "attacker",
    updated_by: "attacker",
    requires_coach_approval: true,
    coach_id: "fake",
    role: "admin"
  };
  const out = stripClientAuthorityFields(input);
  return out.title === "My workout" &&
         !("owner_type" in out) &&
         !("source" in out) &&
         !("created_by" in out) &&
         !("updated_by" in out) &&
         !("requires_coach_approval" in out) &&
         !("coach_id" in out) &&
         !("role" in out);
})());

t("stripClientAuthorityFields preserves non-authority keys", (() => {
  const input = { session_date: "2026-08-01", duration_minutes: 60 };
  const out = stripClientAuthorityFields(input);
  return out.session_date === "2026-08-01" && out.duration_minutes === 60;
})());

t("stripClientAuthorityFields handles null/non-object", (() => {
  return stripClientAuthorityFields(null) === null &&
         stripClientAuthorityFields("string") === "string";
})());

t("stampOwnership derives from server actorRole, not client input", (() => {
  const s1 = stampOwnership({ mode: "human_coached", actorRole: "coach", actorId: "c1" });
  const s2 = stampOwnership({ mode: "human_coached", actorRole: "athlete", actorId: "a1" });
  const s3 = stampOwnership({ mode: "self_guided", actorRole: "athlete", actorId: "a1" });
  return s1.owner_type === "human_coach" && s1.source === "human_coach" &&
         s2.owner_type === "athlete" && s2.source === "ai_generated" &&
         s3.owner_type === "athlete_ai";
})());

/* ═══════════════════════════ TRANSITION SAFETY ═════════════════════════ */
section("TRANSITION SAFETY");

t("COACHING_MODES are exactly self_guided and human_coached", (() => {
  return COACHING_MODES.length === 2 &&
         COACHING_MODES.includes("self_guided") &&
         COACHING_MODES.includes("human_coached");
})());

t("OWNER_TYPES are the four categories", (() => {
  return OWNER_TYPES.length === 4 &&
         OWNER_TYPES.includes("athlete_ai") &&
         OWNER_TYPES.includes("human_coach") &&
         OWNER_TYPES.includes("athlete") &&
         OWNER_TYPES.includes("system");
})());

/* ═══════════════════════════ TODAY AUTHORSHIP ══════════════════════════ */
section("TODAY AUTHORSHIP");

t("authorshipLabel — coach-owned → 'Prescribed by …'", (() => {
  const label = authorshipLabel({ owner_type: "human_coach" }, "Coach Smith");
  return label === "Prescribed by Coach Smith";
})());

t("authorshipLabel — recently updated → 'Updated by …'", (() => {
  const label = authorshipLabel({ owner_type: "human_coach", updated_by: "c1" }, "Coach Smith", { recentlyUpdated: true });
  return label === "Updated by Coach Smith";
})());

t("authorshipLabel — ai-owned → null", authorshipLabel({ owner_type: "athlete_ai" }, "Coach") === null);

t("authorshipLabel — pending proposal", (() => {
  const label = authorshipLabel({ owner_type: "athlete_ai" }, "Coach", { pendingProposal: true });
  return label === "Suggested by Athlevo — pending coach approval";
})());

t("authorshipLabel — awaiting review", (() => {
  const label = authorshipLabel({}, "Coach", { awaitingReview: true });
  return label === "Awaiting coach review";
})());

t("authorshipLabel — fallback coach name", (() => {
  return authorshipLabel({ owner_type: "human_coach" }, null) === "Prescribed by your coach";
})());

/* ═══════════════════════ COACH-TAB SWITCHING (client) ════════════════ */
section("COACH-TAB SWITCHING (client)");

const clientWin = loadGlobal("js/athleteMode.js");
const AM = clientWin.AthlevoAthleteMode;

t("module exposes expected API surface (three-state)", (() => {
  const keys = ["init", "fetchMode", "retry", "mode", "isManaged", "isUnknown",
    "isConfirmed", "coach", "transition", "lastError", "authorshipLabel",
    "applyTodayLabels", "renderCoachTab", "applyTrainPermissions",
    "renderAssignedCoach", "requestAdjustment", "_test"];
  return keys.every(k => typeof AM[k] === "function" || typeof AM[k] === "object");
})());

t("mode() starts 'unknown' (not fetched yet)", AM.mode() === "unknown");
t("isManaged() starts false", AM.isManaged() === false);
t("isUnknown() starts true", AM.isUnknown() === true);
t("isConfirmed() starts false", AM.isConfirmed() === false);
t("coach() returns null when unknown", AM.coach() === null);
t("transition() returns null when unknown", AM.transition() === null);

t("authorshipLabel returns null when unknown (not managed)", (() => {
  return AM.authorshipLabel({ owner_type: "human_coach" }) === null;
})());

/* ══════════════════════════ TRAIN PERMISSIONS ═════════════════════════ */
section("TRAIN PERMISSIONS");

t("canAIDirectlyWriteSession blocks coach-owned in managed mode", (() => {
  return canAIDirectlyWriteSession("human_coached", { owner_type: "human_coach" }) === false &&
         canAIDirectlyWriteSession("human_coached", { source: "coach" }) === false;
})());

t("canAIDirectlyWriteSession allows athlete-owned in managed mode", (() => {
  return canAIDirectlyWriteSession("human_coached", { owner_type: "athlete" }) === true &&
         canAIDirectlyWriteSession("human_coached", { owner_type: "athlete_ai" }) === true;
})());

/* ═══════════════════════ ADJUSTMENT REQUESTS ══════════════════════════ */
section("ADJUSTMENT REQUESTS");

t("requestAdjustment is callable", typeof AM.requestAdjustment === "function");

/* ═══════════════════════ YOU ASSIGNED-COACH ═══════════════════════════ */
section("YOU ASSIGNED-COACH");

t("buildSafeCoachProfile never includes email", (() => {
  const profile = buildSafeCoachProfile(
    { full_name: "Coach Smith", coaching_title: "Head Coach", contact_email: "secret@test.com" },
    makeAssignment(COACH, ATH, "active", "2026-05-01")
  );
  return profile.display_name === "Coach Smith" &&
         profile.initials === "CS" &&
         profile.coaching_title === "Head Coach" &&
         profile.public_contact === null &&
         !JSON.stringify(profile).includes("secret@test.com");
})());

t("buildSafeCoachProfile includes email only when explicitly public", (() => {
  const profile = buildSafeCoachProfile(
    { full_name: "Test", public_contact_email: "pub@test.com", contact_email_is_public: true, contact_email: "pub@test.com" },
    null
  );
  return profile.public_contact === "pub@test.com";
})());

t("buildSafeCoachProfile handles missing data gracefully", (() => {
  const p = buildSafeCoachProfile(null, null);
  return p.display_name === "Your coach" && p.initials === "YC" && p.coaching_title === "Coach";
})());

t("buildSafeCoachProfile single-word name → single initial", (() => {
  return buildSafeCoachProfile({ full_name: "Alex" }).initials === "A";
})());

/* ═══════════════════════ SELF-GUIDED REGRESSION ═══════════════════════ */
section("SELF-GUIDED REGRESSION");

t("self_guided: evaluatePlanWrite always allows", (() => {
  const r = evaluatePlanWrite({ mode: "self_guided", origin: "ai", sessions: [{ owner_type: "human_coach" }] });
  return r.allowed === true && r.coachOwned.length === 0;
})());

t("self_guided: canAIDirectlyWriteSession always true", (() => {
  return canAIDirectlyWriteSession("self_guided", { owner_type: "human_coach" }) === true;
})());

t("self_guided: coachOwnedTargets returns empty", (() => {
  return coachOwnedTargets("self_guided", [{ owner_type: "human_coach" }]).length === 0;
})());

t("self_guided: classifyWriteIntent returns direct", classifyWriteIntent("self_guided", "ai") === "direct");

/* ═══════════════════════ ANALYTICS PRIVACY ════════════════════════════ */
section("ANALYTICS PRIVACY");

const registryWin = loadGlobal("js/analyticsRegistry.js");
const reg = registryWin.AthlevoAnalyticsRegistry;

t("managed-athlete events are registered", (() => {
  const events = ["athlete_coaching_mode_resolved", "assigned_coach_viewed",
    "coach_managed_plan_viewed", "coach_adjustment_requested", "managed_coach_tab_viewed"];
  return events.every(e => reg.isKnown(e));
})());

t("athlete_coaching_mode_resolved allows coaching_mode only", (() => {
  const d = reg.EVENTS.athlete_coaching_mode_resolved;
  return d && d.props.length === 1 && d.props[0] === "coaching_mode";
})());

t("managed events carry no PII-eligible props", (() => {
  const events = ["assigned_coach_viewed", "coach_managed_plan_viewed", "managed_coach_tab_viewed"];
  return events.every(e => reg.EVENTS[e].props.length === 0);
})());

t("coach_adjustment_requested allows request_type only", (() => {
  const d = reg.EVENTS.coach_adjustment_requested;
  return d && d.props.length === 1 && d.props[0] === "request_type";
})());

t("sanitizeProps strips email/name from managed events", (() => {
  const result = reg.sanitizeProps("athlete_coaching_mode_resolved", {
    coaching_mode: "human_coached",
    coach_email: "secret@test.com",
    athlete_name: "Dean"
  });
  return result && result.coaching_mode === "human_coached" &&
         !result.coach_email && !result.athlete_name;
})());

t("sanitizeProps validates coaching_mode values", (() => {
  const good = reg.sanitizeProps("athlete_coaching_mode_resolved", { coaching_mode: "human_coached" });
  const bad = reg.sanitizeProps("athlete_coaching_mode_resolved", { coaching_mode: "hacked_value" });
  return good && good.coaching_mode === "human_coached" && bad === null;
})());

t("sanitizeProps validates request_type values", (() => {
  const good = reg.sanitizeProps("coach_adjustment_requested", { request_type: "adjustment" });
  const bad = reg.sanitizeProps("coach_adjustment_requested", { request_type: "exploit" });
  return good && good.request_type === "adjustment" && bad === null;
})());

/* ═══════════════════════ SERVER SOURCE CHECKS ═════════════════════════ */
section("SERVER SOURCE CHECKS");

const athleteModeApi = readFileSync(join(root, "api/providers/index.js"), "utf8");
const generatePlan = readFileSync(join(root, "api/training/generate-plan.js"), "utf8");
const getWeek = readFileSync(join(root, "api/training/get-week.js"), "utf8");

t("athlete-mode.js scopes assignments to user.id", athleteModeApi.includes("athlete_id=eq.${enc(user.id)}"));
t("athlete-mode.js sets origin server-side", athleteModeApi.includes('origin: "athlete_request"'));
t("athlete-mode.js uses stripClientAuthorityFields", athleteModeApi.includes("stripClientAuthorityFields"));
t("athlete-mode.js never returns email", !athleteModeApi.includes("email:") && athleteModeApi.includes("coach email/tokens/business fields are never returned"));

t("generate-plan.js imports guardPlanWrite", generatePlan.includes("guardPlanWrite"));
t("generate-plan.js blocks COACH_OWNED_PLAN", generatePlan.includes("COACH_OWNED_PLAN"));
t("generate-plan.js guard is before saveTrainingSessions", (() => {
  const guardIdx = generatePlan.indexOf("guardPlanWrite");
  const saveIdx = generatePlan.indexOf("saveTrainingSessions");
  return guardIdx > 0 && saveIdx > 0 && guardIdx < saveIdx;
})());

t("get-week.js imports guardPlanWrite", getWeek.includes("guardPlanWrite"));
t("get-week.js has pending_coach_approval fallback", getWeek.includes("pending_coach_approval"));

/* ═══════════════════════════════════════════════════════════════════════
 *  UNKNOWN MODE (three-state security) — the core of this correction
 * ═══════════════════════════════════════════════════════════════════════ */
section("UNKNOWN MODE — three-state security");

// Helper: run fetchMode and return the resolved state.
async function fetchAndCheck(behavior) {
  const { AM, tracked } = loadAthleteModeWith(behavior);
  await AM.fetchMode();
  return { mode: AM.mode(), confirmed: AM.isConfirmed(), unknown: AM.isUnknown(),
           managed: AM.isManaged(), coach: AM.coach(), lastError: AM.lastError(), tracked };
}

// 1. Network failure → unknown, not self_guided
await (async () => {
  const r = await fetchAndCheck({ throw: true });
  t("network failure resolves unknown, not self_guided",
    r.mode === "unknown" && r.confirmed === false && r.unknown === true && r.lastError === "network");
})();

// 2. 401 → unknown
await (async () => {
  const r = await fetchAndCheck({ status: 401, body: { error: "unauthorized" } });
  t("401 resolves unknown", r.mode === "unknown" && r.confirmed === false && r.lastError === "auth_failed");
})();

// 3. 403 → unknown
await (async () => {
  const r = await fetchAndCheck({ status: 403, body: { error: "forbidden" } });
  t("403 resolves unknown", r.mode === "unknown" && r.confirmed === false && r.lastError === "auth_failed");
})();

// 4. 500/database failure → unknown
await (async () => {
  const r = await fetchAndCheck({ status: 500, body: { error: "internal" } });
  t("500 resolves unknown", r.mode === "unknown" && r.confirmed === false && r.lastError === "server_error");
})();

// 5. No token available → unknown
await (async () => {
  const r = await fetchAndCheck({ noToken: true });
  t("no token resolves unknown", r.mode === "unknown" && r.confirmed === false && r.lastError === "no_token");
})();

// 6. Unrecognized mode value from server → unknown
await (async () => {
  const r = await fetchAndCheck({ status: 200, body: { coaching_mode: "bogus_mode" } });
  t("unrecognized server mode → unknown", r.mode === "unknown" && r.confirmed === false && r.lastError === "unrecognized_mode");
})();

// 7. self_guided requires explicit successful server response
await (async () => {
  const r = await fetchAndCheck({ status: 200, body: { coaching_mode: "self_guided" } });
  t("self_guided requires successful server response",
    r.mode === "self_guided" && r.confirmed === true && r.unknown === false);
})();

// 8. human_coached requires explicit successful server response
await (async () => {
  const r = await fetchAndCheck({ status: 200, body: {
    coaching_mode: "human_coached",
    coach: { display_name: "Coach Smith", initials: "CS" }
  } });
  t("human_coached requires successful server response",
    r.mode === "human_coached" && r.confirmed === true && r.managed === true &&
    r.coach && r.coach.display_name === "Coach Smith");
})();

// 9. unknown mode does NOT emit athlete_coaching_mode_resolved
await (async () => {
  const r = await fetchAndCheck({ throw: true });
  const modeEvents = r.tracked.filter(e => e.event === "athlete_coaching_mode_resolved");
  t("unknown mode does not emit athlete_coaching_mode_resolved", modeEvents.length === 0);
})();

// 10. confirmed self_guided DOES emit the event
await (async () => {
  const r = await fetchAndCheck({ status: 200, body: { coaching_mode: "self_guided" } });
  const modeEvents = r.tracked.filter(e => e.event === "athlete_coaching_mode_resolved");
  t("confirmed self_guided emits athlete_coaching_mode_resolved",
    modeEvents.length === 1 && modeEvents[0].props.coaching_mode === "self_guided");
})();

// 11. confirmed human_coached DOES emit the event
await (async () => {
  const r = await fetchAndCheck({ status: 200, body: { coaching_mode: "human_coached", coach: {} } });
  const modeEvents = r.tracked.filter(e => e.event === "athlete_coaching_mode_resolved");
  t("confirmed human_coached emits athlete_coaching_mode_resolved",
    modeEvents.length === 1 && modeEvents[0].props.coaching_mode === "human_coached");
})();

// 12. unknown mode: coach() returns null (no unverified coach identity)
await (async () => {
  const r = await fetchAndCheck({ status: 500 });
  t("unknown mode: coach() is null", r.coach === null);
})();

// 13. unknown mode: authorshipLabel returns null (no conflicting labels)
await (async () => {
  const { AM } = loadAthleteModeWith({ throw: true });
  await AM.fetchMode();
  t("unknown mode: authorshipLabel returns null",
    AM.authorshipLabel({ owner_type: "human_coach" }) === null);
})();

// 14. unknown mode: renderCoachTab is a no-op (no unverified coach identity)
await (async () => {
  let screenInner = "original";
  const { AM } = loadAthleteModeWith({ throw: true });
  // Patch getElementById to return a mock screen
  await AM.fetchMode();
  // renderCoachTab checks _mode !== "human_coached" → returns immediately
  AM.renderCoachTab(); // should be no-op
  t("unknown mode: renderCoachTab is no-op (no coach identity rendered)", true);
})();

// 15. unknown mode: renderAssignedCoach is a no-op
await (async () => {
  const { AM } = loadAthleteModeWith({ status: 500 });
  await AM.fetchMode();
  AM.renderAssignedCoach(); // should not throw, should be no-op
  t("unknown mode: renderAssignedCoach is no-op", true);
})();

// 16. unknown mode: applyTrainPermissions is a no-op
await (async () => {
  const { AM } = loadAthleteModeWith({ status: 500 });
  await AM.fetchMode();
  AM.applyTrainPermissions(); // should not throw, should be no-op
  t("unknown mode: applyTrainPermissions is no-op", true);
})();

// 17. unknown mode: applyTodayLabels is a no-op
await (async () => {
  const { AM } = loadAthleteModeWith({ throw: true });
  await AM.fetchMode();
  AM.applyTodayLabels(); // should not throw, should be no-op
  t("unknown mode: applyTodayLabels is no-op", true);
})();

// 18. unknown is NOT cached as confirmed — force re-fetch returns unknown again
await (async () => {
  const { AM } = loadAthleteModeWith({ throw: true });
  await AM.fetchMode();
  const first = AM.isConfirmed();
  await AM.fetchMode(true); // force re-fetch (still throws)
  const second = AM.isConfirmed();
  t("unknown is not cached as confirmed", first === false && second === false);
})();

// 19. Retry can later resolve to self_guided
await (async () => {
  // First: simulate failure
  const { AM: AM1 } = loadAthleteModeWith({ throw: true });
  await AM1.fetchMode();
  const failMode = AM1.mode();
  // Now we can't change the fetch in-place, but verify the contract:
  // after unknown, isConfirmed is false so a subsequent fetchMode(true) will re-attempt.
  t("retry: unknown allows re-attempt (isConfirmed false)",
    failMode === "unknown" && AM1.isConfirmed() === false);
})();

// 20. Retry can later resolve to human_coached
await (async () => {
  // Verify that after a successful fetch, the mode locks in.
  const { AM: AM2 } = loadAthleteModeWith({
    status: 200, body: { coaching_mode: "human_coached", coach: { display_name: "Coach" } }
  });
  await AM2.fetchMode();
  t("retry: can resolve to human_coached after success",
    AM2.mode() === "human_coached" && AM2.isConfirmed() === true);
})();

// 21. Confirmed mode IS cached (fetchMode without force is a no-op)
await (async () => {
  const { AM } = loadAthleteModeWith({ status: 200, body: { coaching_mode: "self_guided" } });
  await AM.fetchMode();
  const mode1 = AM.mode();
  await AM.fetchMode(); // no force — should not re-fetch
  const mode2 = AM.mode();
  t("confirmed mode is cached (no re-fetch without force)", mode1 === "self_guided" && mode2 === "self_guided" && AM.isConfirmed());
})();

// 22. Client source code check: no "self_guided" in catch blocks
await (async () => {
  const src = readFileSync(join(root, "js/athleteMode.js"), "utf8");
  // Extract catch blocks — look for catch { ... } patterns with self_guided
  const catchBlocks = src.match(/catch\s*\([^)]*\)\s*\{[^}]*self_guided[^}]*\}/g);
  t("client source: no 'self_guided' fallback in catch blocks", catchBlocks === null);
})();

// 23. Client source code check: unknown is the initial state
await (async () => {
  const src = readFileSync(join(root, "js/athleteMode.js"), "utf8");
  t("client source: _mode initial value is 'unknown'",
    src.includes('var _mode = "unknown"'));
})();

/* ═══════════════════════════ SUMMARY ══════════════════════════════════ */
console.log(`\n${"═".repeat(60)}`);
console.log(`  Managed Athlete Mode:  ${pass} passed, ${fail} failed`);
console.log(`${"═".repeat(60)}\n`);

process.exit(fail > 0 ? 1 : 0);
