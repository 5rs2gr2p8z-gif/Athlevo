/* Athlevo — authenticated, idempotent pre-signup diagnostic handoff. */
(function (root) {
"use strict";

var KNOWN_FIELDS_KEY = "athlevo_diagnostic_known_onboarding_fields";
var PROFILE_COLUMNS = [
  "goal", "experience_years", "weekly_distance", "weekly_hours",
  "available_days", "training_days", "race_date", "injury_history",
  "work_schedule", "target_race", "target_time", "preferred_training_time",
  "coach_notes"
];

function isEmptyProfileValue(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function mergeMissingProfileFields(existing, diagnosticFields) {
  var updates = {};
  var current = existing || {};
  for (var key in diagnosticFields) {
    if (!Object.prototype.hasOwnProperty.call(diagnosticFields, key)) continue;
    if (PROFILE_COLUMNS.indexOf(key) < 0) continue;
    if (isEmptyProfileValue(current[key])) updates[key] = diagnosticFields[key];
  }
  return updates;
}

function rememberKnownOnboardingFields(fields) {
  try {
    var keys = Object.keys(fields || {}).filter(function (key) {
      return PROFILE_COLUMNS.indexOf(key) >= 0;
    });
    sessionStorage.setItem(KNOWN_FIELDS_KEY, JSON.stringify(keys));
  } catch (e) {}
}

function knownOnboardingFields() {
  try {
    var parsed = JSON.parse(sessionStorage.getItem(KNOWN_FIELDS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(function (key) { return PROFILE_COLUMNS.indexOf(key) >= 0; }) : [];
  } catch (e) {
    return [];
  }
}

function track(name, props) {
  try {
    if (root.AthlevoAnalytics && root.AthlevoAnalytics.track) {
      root.AthlevoAnalytics.track(name, props || {});
    }
    if (root.AthlevoProductAnalytics && root.AthlevoProductAnalytics.trackAthlevoEvent) {
      root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
    }
  } catch (e) {}
}

function failure(stage, category, message) {
  track("diagnostic_import_failed", { stage: stage, failure_category: category });
  return { attached: false, skipped: false, error: message || "Diagnostic import failed" };
}

async function attachPendingDiagnostic(requestedUserId, supabase) {
  if (!root.AthlevoDiagnostic || !root.AthlevoDiagnostic.hasPending()) {
    return { attached: false, skipped: false, error: null };
  }
  var engine = root.AthlevoDiagnostic.load();
  if (!engine) return { attached: false, skipped: false, error: null };
  if (!engine.completed || !engine.result) {
    return { attached: false, skipped: true, error: null };
  }
  if (!supabase || !supabase.auth || typeof supabase.auth.getUser !== "function") {
    return failure("auth_start", "configuration", "Supabase auth client unavailable");
  }

  track("diagnostic_import_started", {});
  try {
    var authResult = await supabase.auth.getUser();
    if (authResult.error || !authResult.data || !authResult.data.user) {
      return failure("session_restore", "auth", authResult.error ? authResult.error.message : "Authenticated user unavailable");
    }
    var authenticatedUserId = authResult.data.user.id;
    if (requestedUserId && requestedUserId !== authenticatedUserId) {
      return failure("session_restore", "invalid_state", "Authenticated user does not match handoff target");
    }

    var diagnosticRow = engine.toDiagnosticRow(authenticatedUserId);
    var persisted = await supabase
      .from("athlete_diagnostics")
      .upsert(diagnosticRow, { onConflict: "user_id,import_key" })
      .select("id, import_key")
      .single();
    if (persisted.error || !persisted.data) {
      return failure("profile_save", "unavailable", persisted.error ? persisted.error.message : "Diagnostic persistence was not confirmed");
    }

    var current = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS.join(","))
      .eq("id", authenticatedUserId)
      .maybeSingle();
    if (current.error) return failure("profile_load", "server", current.error.message);

    var profileFields = engine.toProfileFields();
    var updates = mergeMissingProfileFields(current.data || {}, profileFields);
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      var updated = await supabase
        .from("profiles")
        .update(updates)
        .eq("id", authenticatedUserId)
        .select("id")
        .single();
      if (updated.error || !updated.data) {
        return failure("profile_save", "server", updated.error ? updated.error.message : "Profile hydration was not confirmed");
      }
    }

    rememberKnownOnboardingFields(profileFields);
    root.AthlevoDiagnostic.clearPending();
    var result = engine.result || {};
    track("diagnostic_import_completed", {
      questions_answered: engine.history.length,
      primary_limiter: result.primaryLimiter ? result.primaryLimiter.key : null,
      feasibility_rating: result.feasibility ? result.feasibility.rating : null,
      injury_reported: !!(result.safetyFlags && result.safetyFlags.injuryReported)
    });
    return {
      attached: true,
      skipped: false,
      error: null,
      importKey: engine.importKey(),
      acquisitionStage: diagnosticRow.acquisition_stage,
      primaryLimiter: diagnosticRow.primary_limiter
    };
  } catch (error) {
    console.warn("Diagnostic handoff error:", error);
    return failure("profile_save", "unknown", error && error.message ? error.message : "Unknown diagnostic import error");
  }
}

async function loadAcquisition(userId, supabase) {
  if (!userId || !supabase) return { data: null, error: "invalid_state" };
  var response = await supabase
    .from("athlete_diagnostics")
    .select("import_key, primary_limiter, acquisition_stage, completed_at")
    .eq("user_id", userId)
    .in("acquisition_stage", ["awaiting_payment", "checkout_started", "payment_confirmed", "onboarding"])
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { data: response.data || null, error: response.error || null };
}

async function setAcquisitionStage(userId, importKey, stage, supabase) {
  var allowed = ["awaiting_payment", "checkout_started", "payment_confirmed", "onboarding", "completed"];
  if (!userId || !importKey || allowed.indexOf(stage) < 0 || !supabase) {
    return { updated: false, error: "invalid_state" };
  }
  var response = await supabase
    .from("athlete_diagnostics")
    .update({ acquisition_stage: stage, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("import_key", importKey)
    .select("import_key, acquisition_stage")
    .maybeSingle();
  return { updated: !!response.data && !response.error, data: response.data || null, error: response.error || null };
}

root.AthlevoDiagnosticHandoff = {
  attach: attachPendingDiagnostic,
  knownOnboardingFields: knownOnboardingFields,
  mergeMissingProfileFields: mergeMissingProfileFields,
  loadAcquisition: loadAcquisition,
  setAcquisitionStage: setAcquisitionStage
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    attachPendingDiagnostic: attachPendingDiagnostic,
    knownOnboardingFields: knownOnboardingFields,
    mergeMissingProfileFields: mergeMissingProfileFields,
    loadAcquisition: loadAcquisition,
    setAcquisitionStage: setAcquisitionStage,
    PROFILE_COLUMNS: PROFILE_COLUMNS
  };
}
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
