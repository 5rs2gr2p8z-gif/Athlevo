import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("./index.html", "utf8");
const diagnosticSrc = readFileSync("./js/diagnostic.js", "utf8");
const diagnosticUiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const orchestratorSrc = readFileSync("./js/authenticatedOnboarding.js", "utf8");
const featureFlagsSrc = readFileSync("./js/featureFlags.js", "utf8");

let passed = 0, failed = 0;
function t(name, ok) {
  if (ok) { passed += 1; console.log("PASS —", name); }
  else { failed += 1; console.log("FAIL —", name); }
}

/* ═══════════ 1. Static wiring / isolation checks against index.html ═══ */

t("script tags load featureFlags.js and authenticatedOnboarding.js",
  /src="js\/featureFlags\.js/.test(html) && /src="js\/authenticatedOnboarding\.js/.test(html));

t("routeAfterAuth's !completed branch references the flagged orchestrator",
  (() => {
    const idx = html.indexOf("if (!completed) {");
    const block = html.slice(idx, idx + 1200);
    return /AthlevoAuthDiagnosticOnboarding\.start/.test(block) &&
      /startOnboarding\(\);/.test(block);
  })());

t("flagged branch falls back to legacy startOnboarding() when start() returns false",
  (() => {
    const idx = html.indexOf("if (!completed) {");
    const block = html.slice(idx, idx + 1200);
    return /if \(!tookOverOnboarding\) \{\s*startOnboarding\(\);/.test(block);
  })());

t("paid-first AthlevoDiagnosticAcquisition.resolveAfterAuth still runs and can return before the flagged branch",
  (() => {
    const routeSrc = html.slice(
      html.indexOf("async function routeAfterAuth"),
      html.indexOf("if (!completed) {")
    );
    return /AthlevoDiagnosticAcquisition\.resolveAfterAuth/.test(routeSrc) &&
      /acquisitionRoute\.route === "onboarding"/.test(routeSrc) &&
      /startOnboarding\(\);\s*return;/.test(routeSrc);
  })());

t("routeAfterAuth's flagged branch does not appear before the paid-first acquisition resolution (paid-first is untouched/unreordered)",
  html.indexOf("AthlevoDiagnosticAcquisition.resolveAfterAuth") < html.indexOf("AthlevoAuthDiagnosticOnboarding.start"));

t("js/diagnosticAcquisition.js is not modified by this feature (still present, untouched call sites)",
  /AthlevoDiagnosticAcquisition/.test(html) && !/AthlevoAuthDiagnosticOnboarding/.test(readFileSync("./js/diagnosticAcquisition.js", "utf8")));

/* ═══════════ 2. DiagnosticEngine schema is NOT expanded ═══════════════ */

t("diagnostic.js QUESTIONS array is not given name/age/sex/height/weight/device dimensions",
  !/key:\s*"(name|age|sex|height|weight|device)"/.test(diagnosticSrc));

t("quick facts are defined in diagnosticUI.js (UI layer), not diagnostic.js (engine schema)",
  /QUICK_FACT_DEFS/.test(diagnosticUiSrc) && !/QUICK_FACT_DEFS/.test(diagnosticSrc));

t("authenticatedOnboarding.js quick-fact keys are canonical profile columns, not new diagnostic fields",
  /QUICK_FACT_KEYS = \["full_name", "age", "sex", "height", "weight", "device"\]/.test(orchestratorSrc));

/* ═══════════ 3. Feature flag behavior (flag OFF vs ON) ════════════════ */

function loadFlags(overrides, posthogFlags) {
  const store = new Map(Object.entries(overrides || {}));
  const context = {
    console: { warn() {} },
    URL,
    location: { href: "https://app.athlevo.test/" },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: k => store.delete(k)
    },
    posthog: posthogFlags
      ? { isFeatureEnabled: name => (name in posthogFlags ? posthogFlags[name] : undefined) }
      : undefined
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(featureFlagsSrc, context);
  return context.AthlevoFeatureFlags;
}

t("flag OFF by default (no override, no PostHog) → isEnabled is false",
  loadFlags({}).isEnabled("diagnostic_onboarding_v2") === false);

t("flag ON via localStorage override → isEnabled is true",
  loadFlags({ athlevo_ff_diagnostic_onboarding_v2: "1" }).isEnabled("diagnostic_onboarding_v2") === true);

t("flag explicitly OFF via localStorage override wins over PostHog true",
  loadFlags({ athlevo_ff_diagnostic_onboarding_v2: "0" }, { diagnostic_onboarding_v2: true })
    .isEnabled("diagnostic_onboarding_v2") === false);

t("PostHog flag is consulted when there is no local override",
  loadFlags({}, { diagnostic_onboarding_v2: true }).isEnabled("diagnostic_onboarding_v2") === true);

t("setOverride/clearOverride round-trip",
  (() => {
    const flags = loadFlags({});
    flags.setOverride("diagnostic_onboarding_v2", true);
    const onAfterSet = flags.isEnabled("diagnostic_onboarding_v2");
    flags.clearOverride("diagnostic_onboarding_v2");
    const offAfterClear = flags.isEnabled("diagnostic_onboarding_v2");
    return onAfterSet === true && offAfterClear === false;
  })());

/* ═══════════ 4. Orchestrator: eligibility, seeding, missing-fields ═══ */

function loadOrchestrator({ flagEnabled = false } = {}) {
  const context = {
    console: { warn() {} },
    AthlevoFeatureFlags: { isEnabled: () => flagEnabled },
    AthlevoDiagnostic: {},
    AthlevoDiagnosticUI: { startAuthenticated: () => true },
    AthlevoAnalytics: null,
    AthlevoProductAnalytics: null,
    supabaseClient: null
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(orchestratorSrc, context);
  return context.AthlevoAuthDiagnosticOnboarding;
}

t("isEligible is false when the flag is off",
  loadOrchestrator({ flagEnabled: false }).isEligible("user-1") === false);

t("isEligible is true when the flag is on and capability is present",
  loadOrchestrator({ flagEnabled: true }).isEligible("user-1") === true);

t("isEligible is false without a userId even if flag is on",
  loadOrchestrator({ flagEnabled: true }).isEligible(null) === false);

t("missingQuickFacts reports only the empty required fields",
  (() => {
    const orch = loadOrchestrator({ flagEnabled: true });
    const missing = orch.missingQuickFacts({
      full_name: "Dean", age: 20, sex: "", height: null, weight: 70, device: ""
    });
    return missing.length === 3 &&
      missing.includes("sex") && missing.includes("height") && missing.includes("device") &&
      !missing.includes("full_name") && !missing.includes("age") && !missing.includes("weight");
  })());

t("missingQuickFacts is empty when profile already has every required field",
  loadOrchestrator({ flagEnabled: true }).missingQuickFacts({
    full_name: "Dean", age: 20, sex: "Male", height: 175, weight: 70, device: "Garmin"
  }).length === 0);

t("detectGoalDistance recovers the canonical distance token from a composed profile.goal string",
  (() => {
    const orch = loadOrchestrator({ flagEnabled: true });
    return orch.detectGoalDistance("10K — Timex 10K — sub-50:00") === "10K" &&
      orch.detectGoalDistance("General endurance fitness") === "General fitness" &&
      orch.detectGoalDistance(null) === null &&
      orch.detectGoalDistance("Some unrelated free text") === null;
  })());

t("seedHistoryFromProfile reuses EXISTING diagnostic question keys only (goal/experience/weekly_volume/training_days)",
  (() => {
    const orch = loadOrchestrator({ flagEnabled: true });
    const seed = orch.seedHistoryFromProfile({
      goal: "Half marathon — sub-2:00", experience_years: 4,
      weekly_distance: 35, weekly_hours: 5, training_days: 4
    });
    const keys = seed.map(s => s.key);
    const allowed = new Set(["goal", "experience", "weekly_volume", "training_days"]);
    return keys.length > 0 && keys.every(k => allowed.has(k)) &&
      keys.includes("goal") && keys.includes("experience") &&
      keys.includes("weekly_volume") && keys.includes("training_days");
  })());

t("seedHistoryFromProfile skips fields it cannot confidently invert (no goal token detected)",
  (() => {
    const orch = loadOrchestrator({ flagEnabled: true });
    const seed = orch.seedHistoryFromProfile({ goal: "Get fit for my wedding" });
    return !seed.some(s => s.key === "goal");
  })());

/* ═══════════ 5. Authenticated engine storage isolation ═══════════════ */

function loadDiagnosticEngine() {
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
  vm.runInContext(diagnosticSrc, context);
  return { Engine: context.AthlevoDiagnostic, values };
}

t("createAuthOnboarding persists to a per-user key, never the shared anonymous STORAGE_KEY",
  (() => {
    const { Engine, values } = loadDiagnosticEngine();
    Engine.createAuthOnboarding("user-42", []);
    const keys = [...values.keys()];
    return keys.some(k => k.includes("user-42")) &&
      !keys.includes("athlevo_pending_diagnostic_v1");
  })());

t("an authenticated-onboarding engine never creates/overwrites the anonymous pending diagnostic",
  (() => {
    const { Engine, values } = loadDiagnosticEngine();
    // Simulate a real anonymous pending diagnostic already present.
    const anon = new Engine();
    anon.recordAnswer("goal", { goal_distance: "10K" });
    assert.ok(values.get("athlevo_pending_diagnostic_v1"));
    const before = values.get("athlevo_pending_diagnostic_v1");

    const auth = Engine.createAuthOnboarding("user-99", []);
    auth.recordAnswer("experience", { experience: "new" });

    return values.get("athlevo_pending_diagnostic_v1") === before;
  })());

t("loadAuthOnboarding resumes the same per-user engine across a simulated refresh",
  (() => {
    const { Engine, values } = loadDiagnosticEngine();
    const engine = Engine.createAuthOnboarding("user-7", []);
    engine.recordAnswer("goal", { goal_distance: "5K" });

    // Simulate refresh: fresh context sharing the same localStorage values.
    const context2 = {
      console: { log() {}, warn() {} }, Date, Math, Uint8Array,
      crypto: globalThis.crypto,
      localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
      }
    };
    context2.globalThis = context2;
    vm.createContext(context2);
    vm.runInContext(diagnosticSrc, context2);
    const resumed = context2.AthlevoDiagnostic.loadAuthOnboarding("user-7");
    return !!resumed && resumed.history.includes("goal") &&
      resumed.questionAnswers.goal.goal_distance === "5K";
  })());

t("clearAuthOnboarding removes only that user's key",
  (() => {
    const { Engine, values } = loadDiagnosticEngine();
    Engine.createAuthOnboarding("user-1", []);
    Engine.createAuthOnboarding("user-2", []);
    Engine.clearAuthOnboarding("user-1");
    const keys = [...values.keys()];
    return !keys.some(k => k.includes("user-1")) && keys.some(k => k.includes("user-2"));
  })());

t("seeding via createAuthOnboarding answers EXISTING questions through recordAnswer (history reflects real answers, not synthetic state)",
  (() => {
    const { Engine } = loadDiagnosticEngine();
    const engine = Engine.createAuthOnboarding("user-5", [
      { key: "goal", fieldAnswers: { goal_distance: "Marathon" } },
      { key: "experience", fieldAnswers: { experience: "5_plus" } }
    ]);
    return engine.history.includes("goal") && engine.history.includes("experience") &&
      engine.known.goal === true && engine.known.experience === true;
  })());

/* ═══════════ 6. DiagnosticUI: authenticated mode never re-enters routeAfterAuth recursively at diagnostic-completion time ═══ */

t("startAuthenticated does not contain the anonymous early-return-to-routeAfterAuth guard",
  (() => {
    const startAuthSrc = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("function startAuthenticated("),
      diagnosticUiSrc.indexOf("function buildFutureIdentityNarrative")
    );
    return startAuthSrc.length > 0 && !/routeAfterAuth/.test(startAuthSrc);
  })());

t("the diagnostic-completion path (renderConversationalResult) branches authenticated users into the corrected completion sequence, not the anonymous sales CTA",
  (() => {
    const block = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("async function renderConversationalResult"),
      diagnosticUiSrc.indexOf("function renderResult(opts)")
    );
    return /if \(authMode\) \{/.test(block) &&
      /proceedToAuthenticatedCompletion/.test(block);
  })());

t("routeAfterAuth is called only once, from the bounded finishAuthenticatedOnboarding handoff — not from the diagnostic question/result loop",
  (() => {
    const authSectionStart = diagnosticUiSrc.indexOf("function startAuthenticated(");
    const authSectionEnd = diagnosticUiSrc.indexOf("/* ═════════════════════════════ DOM INIT");
    const authSection = diagnosticUiSrc.slice(authSectionStart, authSectionEnd);
    const codeOnly = authSection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const finishIdx = codeOnly.indexOf("async function finishAuthenticatedOnboarding");
    const beforeFinish = codeOnly.slice(0, finishIdx);
    const afterFinish = codeOnly.slice(finishIdx);
    return finishIdx > 0 &&
      !/routeAfterAuth/.test(beforeFinish) &&
      /routeAfterAuth/.test(afterFinish);
  })());

t("future identity narrative makes no guaranteed-outcome or race-time promises",
  (() => {
    const fn = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("function buildFutureIdentityNarrative"),
      diagnosticUiSrc.indexOf("async function renderFutureIdentitySection")
    );
    return !/guarantee/i.test(fn) && !/will finish in/i.test(fn) && !/sub-\d/.test(fn);
  })());

/* Corrected sequencing: quick facts BEFORE future identity BEFORE finish */

t("proceedToAuthenticatedCompletion collects quick facts BEFORE rendering future identity (not after)",
  (() => {
    const fn = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("async function proceedToAuthenticatedCompletion"),
      diagnosticUiSrc.indexOf("async function finishAuthenticatedOnboarding")
    );
    const quickFactsIdx = fn.indexOf("runQuickFactsStage");
    const futureIdentityIdx = fn.indexOf("renderFutureIdentitySection");
    return quickFactsIdx > 0 && futureIdentityIdx > 0 && quickFactsIdx < futureIdentityIdx;
  })());

t("future identity cannot render until the quick-facts promise resolves (awaited, not parallel)",
  (() => {
    const fn = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("async function proceedToAuthenticatedCompletion"),
      diagnosticUiSrc.indexOf("async function finishAuthenticatedOnboarding")
    );
    return /await new Promise\(function \(resolve\) \{\s*runQuickFactsStage/.test(fn) &&
      /await renderFutureIdentitySection/.test(fn) &&
      fn.indexOf("await renderFutureIdentitySection") > fn.indexOf("await new Promise");
  })());

t("finishAuthenticatedOnboarding (pricing/wearable/app handoff) runs only after renderFutureIdentitySection, not before",
  (() => {
    const fn = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("async function proceedToAuthenticatedCompletion"),
      diagnosticUiSrc.indexOf("async function finishAuthenticatedOnboarding")
    );
    return fn.indexOf("renderFutureIdentitySection") < fn.indexOf("finishAuthenticatedOnboarding");
  })());

t("when no quick facts are missing, the flow still renders future identity before finishing (does not skip straight from diagnostic to pricing)",
  (() => {
    const fn = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("async function proceedToAuthenticatedCompletion"),
      diagnosticUiSrc.indexOf("async function finishAuthenticatedOnboarding")
    );
    const ifBlockEnd = fn.indexOf("}", fn.indexOf("if (missing.length)"));
    const afterIfBlock = fn.slice(ifBlockEnd);
    return /renderFutureIdentitySection/.test(afterIfBlock) && /finishAuthenticatedOnboarding/.test(afterIfBlock);
  })());

t("future identity is rendered exactly once per completion sequence (single call site, not looped)",
  (() => {
    const fn = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("async function proceedToAuthenticatedCompletion"),
      diagnosticUiSrc.indexOf("async function finishAuthenticatedOnboarding")
    );
    const matches = fn.match(/renderFutureIdentitySection/g) || [];
    return matches.length === 1;
  })());

t("a quick fact answered mid-stage updates authProfile so a resumed/re-entrant call does not re-ask it before future identity",
  /authProfile = Object\.assign\(\{\}, authProfile, quickFacts\);/.test(diagnosticUiSrc));

t("quick facts stage does not appear between result and pricing when nothing is missing (still finishes through the same handoff)",
  /if \(missing\.length\) \{/.test(diagnosticUiSrc) && /await finishAuthenticatedOnboarding\(quickFacts\);/.test(diagnosticUiSrc));

t("wearable connection is not invoked inside the quick-facts/future-identity completion sequence (still owned by the canonical post-pricing step)",
  (() => {
    const block = diagnosticUiSrc.slice(
      diagnosticUiSrc.indexOf("async function proceedToAuthenticatedCompletion"),
      diagnosticUiSrc.indexOf("async function finishAuthenticatedOnboarding") +
        diagnosticUiSrc.slice(diagnosticUiSrc.indexOf("async function finishAuthenticatedOnboarding")).indexOf("\n}\n")
    );
    return !/AthlevoConnect/.test(block);
  })());

t("existing AthlevoConnect wearable module is not modified by this feature",
  !/AthlevoAuthDiagnosticOnboarding|diagnostic_onboarding_v2/.test(readFileSync("./js/onboardingConnect.js", "utf8")));

t("legacy js/onboarding.js is unmodified by this feature (still the fallback, not deleted or rewritten)",
  !/AthlevoAuthDiagnosticOnboarding|diagnostic_onboarding_v2/.test(readFileSync("./js/onboarding.js", "utf8")));

/* ═══════════ 7. Completion persists through the canonical profiles path ═ */

t("completeAndPersist writes through supabaseClient.from(\"profiles\").update(...) — the same table/columns onboarding.js uses, not a second persistence path",
  (() => {
    const fn = orchestratorSrc.slice(
      orchestratorSrc.indexOf("async function completeAndPersist"),
      orchestratorSrc.indexOf("root.AthlevoAuthDiagnosticOnboarding")
    );
    return /supabase\.from\("profiles"\)\.update/.test(fn) &&
      /onboarding_complete = true/.test(fn) &&
      /full_name|age|sex|height|weight|device/.test(fn);
  })());

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
