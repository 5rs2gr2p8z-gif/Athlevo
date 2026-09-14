/*
 * Athlevo — authenticated diagnostic onboarding orchestrator.
 * FLAGGED (diagnostic_onboarding_v2, see js/featureFlags.js). Default OFF.
 *
 * Applies ONLY to the normal organic/free signup path. Does not touch,
 * call into, or unify with AthlevoDiagnosticAcquisition's paid-first
 * diagnostic -> payment -> onboarding funnel, which continues completely
 * unchanged. Isolation is structural: routeAfterAuth() in index.html only
 * reaches the branch that calls this module's start() after the paid-first
 * acquisition resolver has already routed its own users away (see the
 * comments around AthlevoDiagnosticAcquisition.resolveAfterAuth in
 * routeAfterAuth).
 *
 * DOES NOT expand the DiagnosticEngine's own question schema. Quick facts
 * (name/age/sex/height/weight/device) are canonical `profiles` columns —
 * the same ones js/onboarding.js already writes — collected through the
 * diagnostic chat shell but persisted through the same table/columns.
 */
(function (root) {
"use strict";

var FLAG_NAME = "diagnostic_onboarding_v2";

/* Mirrors the REQUIRED fields in js/onboarding.js's F.name/age/sex/height/
   weight/devices. Everything the legacy form treats as optional (location,
   injuries, schedule, diet, notes) is intentionally NOT asked here — it
   isn't required for first-plan generation, pace calculation, or
   personalization, and forcing it in would just be a form with extra
   steps wearing a chat costume. */
var QUICK_FACT_KEYS = ["full_name", "age", "sex", "height", "weight", "device"];

var GOAL_DISTANCE_TOKENS = ["5K", "10K", "Half marathon", "Marathon", "Ultra"];
var EXPERIENCE_YEARS_TO_KEY = { 0: "new", 1: "1_2_years", 4: "3_5_years", 8: "5_plus" };

function isEmpty(v) {
  return v == null || (typeof v === "string" && v.trim() === "");
}

function missingQuickFacts(profile) {
  var p = profile || {};
  return QUICK_FACT_KEYS.filter(function (key) { return isEmpty(p[key]); });
}

/*
 * profiles.goal is a composed string built by DiagnosticEngine.toProfileFields
 * / onboarding.js starting with the canonical distance token (see
 * diagnostic.js toProfileFields). Detecting it back out lets the
 * authenticated diagnostic skip the "goal" question when it's already known
 * from the athlete's pre-signup anonymous diagnostic, without inventing a
 * second goal representation.
 */
function detectGoalDistance(goalText) {
  if (!goalText) return null;
  var text = String(goalText);
  for (var i = 0; i < GOAL_DISTANCE_TOKENS.length; i++) {
    if (text.indexOf(GOAL_DISTANCE_TOKENS[i]) === 0) return GOAL_DISTANCE_TOKENS[i];
  }
  if (/^general endurance fitness/i.test(text)) return "General fitness";
  return null;
}

/*
 * Build a seed history for AthlevoDiagnostic.createAuthOnboarding from
 * profile fields diagnosticHandoff already merged in. Each entry answers
 * an EXISTING diagnostic question through its normal recordAnswer() path
 * (see diagnostic.js) — this does not add new fields to the schema, it
 * just avoids re-asking what's already known.
 */
function seedHistoryFromProfile(profile) {
  var seed = [];
  if (!profile) return seed;

  var goalDistance = detectGoalDistance(profile.goal);
  if (goalDistance) {
    seed.push({ key: "goal", fieldAnswers: { goal_distance: goalDistance } });
  }

  var expKey = profile.experience_years != null ? EXPERIENCE_YEARS_TO_KEY[profile.experience_years] : null;
  if (expKey) {
    seed.push({ key: "experience", fieldAnswers: { experience: expKey } });
  }

  if (profile.weekly_distance != null) {
    seed.push({
      key: "weekly_volume",
      fieldAnswers: {
        weekly_mileage: profile.weekly_distance,
        weekly_hours: profile.weekly_hours != null ? profile.weekly_hours : null
      }
    });
  }

  var days = profile.training_days != null ? profile.training_days : profile.available_days;
  if (days != null) {
    seed.push({ key: "training_days", fieldAnswers: { training_days: days } });
  }

  return seed;
}

function hasCapability() {
  return !!(root.AthlevoFeatureFlags && typeof root.AthlevoFeatureFlags.isEnabled === "function" &&
    root.AthlevoDiagnostic && root.AthlevoDiagnosticUI &&
    typeof root.AthlevoDiagnosticUI.startAuthenticated === "function");
}

/* Flag check only — does not require a profile. Use start() for the full
   eligibility decision (also excludes coach/admin accounts). */
function isEligible(userId) {
  if (!userId || !hasCapability()) return false;
  return root.AthlevoFeatureFlags.isEnabled(FLAG_NAME, false);
}

async function loadProfile(userId, supabase) {
  if (!userId || !supabase) return null;
  try {
    var res = await supabase
      .from("profiles")
      .select([
        "full_name", "age", "sex", "height", "weight", "device",
        "goal", "target_race", "race_date", "target_time",
        "experience_years", "weekly_distance", "weekly_hours",
        "available_days", "training_days", "role", "onboarding_complete"
      ].join(","))
      .eq("id", userId)
      .maybeSingle();
    if (res.error) return null;
    return res.data || null;
  } catch (e) {
    return null;
  }
}

function track(name, props) {
  try {
    if (root.AthlevoAnalytics && root.AthlevoAnalytics.track) root.AthlevoAnalytics.track(name, props || {});
    if (root.AthlevoProductAnalytics && root.AthlevoProductAnalytics.trackAthlevoEvent) {
      root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
    }
  } catch (e) {}
}

/*
 * Entry point called from routeAfterAuth's organic/free "!completed"
 * branch only. Returns true if it took over rendering (caller must not
 * also call legacy startOnboarding()); false means "not eligible / failed
 * safely — fall back to the legacy form", which is the correct behavior
 * for the flag being off, a coach/admin account, or any unexpected error.
 */
async function start(userId, supabase) {
  if (!isEligible(userId)) return false;

  var profile = await loadProfile(userId, supabase || root.supabaseClient);
  if (!profile) return false; // fail safe: unknown state -> legacy form
  if (profile.role === "coach" || profile.role === "admin") return false; // legacy handles these

  try {
    var known = missingQuickFacts(profile);
    track("diagnostic_onboarding_started", {
      source: "diagnostic_onboarding_v2",
      known_fields_count: QUICK_FACT_KEYS.length - known.length,
      missing_fields_count: known.length,
      authenticated: true
    });
    var seedHistory = seedHistoryFromProfile(profile);
    var started = root.AthlevoDiagnosticUI.startAuthenticated(userId, profile, seedHistory);
    return !!started;
  } catch (e) {
    console.warn("Authenticated diagnostic onboarding failed to start; falling back to legacy onboarding:", e);
    return false;
  }
}

/*
 * Persist quick facts + onboarding_complete through the SAME `profiles`
 * columns js/onboarding.js writes (full_name/age/sex/height/weight/device)
 * — no second persistence path — plus the diagnostic result row, mirroring
 * diagnosticHandoff's shape for the paid-first funnel's own diagnostic row.
 */
async function completeAndPersist(userId, engine, quickFacts) {
  if (!userId) return;
  var supabase = root.supabaseClient;
  if (!supabase) return;

  var updates = {};
  var qf = quickFacts || {};
  if (qf.full_name) updates.full_name = qf.full_name;
  if (qf.age != null) updates.age = qf.age;
  if (qf.sex) updates.sex = qf.sex;
  if (qf.height != null) updates.height = qf.height;
  if (qf.weight != null) updates.weight = qf.weight;
  if (qf.device) updates.device = qf.device;
  updates.onboarding_complete = true;
  updates.updated_at = new Date().toISOString();

  try {
    await supabase.from("profiles").update(updates).eq("id", userId);
  } catch (e) {
    console.warn("Quick-facts profile persistence failed (non-fatal; routing still proceeds):", e);
  }

  try {
    if (engine && typeof engine.toDiagnosticRow === "function") {
      var row = engine.toDiagnosticRow(userId);
      row.acquisition_stage = "completed";
      await supabase.from("athlete_diagnostics").upsert(row, { onConflict: "user_id,import_key" });
    }
  } catch (e) {
    console.warn("Authenticated diagnostic row persistence failed (non-fatal):", e);
  }

  track("diagnostic_onboarding_completed", {
    source: "diagnostic_onboarding_v2",
    completion_state: "completed",
    authenticated: true
  });
}

root.AthlevoAuthDiagnosticOnboarding = {
  FLAG_NAME: FLAG_NAME,
  QUICK_FACT_KEYS: QUICK_FACT_KEYS,
  isEligible: isEligible,
  missingQuickFacts: missingQuickFacts,
  detectGoalDistance: detectGoalDistance,
  seedHistoryFromProfile: seedHistoryFromProfile,
  start: start,
  completeAndPersist: completeAndPersist
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FLAG_NAME: FLAG_NAME,
    QUICK_FACT_KEYS: QUICK_FACT_KEYS,
    isEligible: isEligible,
    missingQuickFacts: missingQuickFacts,
    detectGoalDistance: detectGoalDistance,
    seedHistoryFromProfile: seedHistoryFromProfile
  };
}
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
