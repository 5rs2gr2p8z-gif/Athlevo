/*
 * Structured coach actions — validation, normalization, and the pure
 * building blocks used to apply a confirmed proposal.
 *
 * Lives OUTSIDE /api so both the coach endpoint (which shape-validates
 * model output before showing a proposal) and the training endpoint
 * (which validates against the DB and applies on confirmation) can share
 * it without spending a Vercel function.
 *
 * Nothing here performs network I/O or trusts raw model output. The
 * caller passes in already-loaded data; these functions only validate,
 * normalize, and shape.
 */

import { toNumber } from "./weeklyAnalysis.js";

export const ACTION_TYPES = [
  "modify_workout",
  "move_workout",
  "skip_workout",
  "replace_workout",
  "adjust_remaining_week",
  "update_temporary_availability",
  "update_training_preference",
  "create_activity_override",
  "update_race_details"
];

// Guard rails so a proposal can never push an absurd single session.
export const MAX_SESSION_MINUTES = 300; // 5 hours
export const MAX_SESSION_KM = 80;

/* ─── small coercion helpers ──────────────────────────────────── */

function cleanStr(value, maxLength = 400) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (
    !trimmed ||
    trimmed === "null" ||
    trimmed === "undefined"
  ) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function isValidDateKey(value) {
  if (typeof value !== "string") {
    return false;
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return false;
  }

  const date = new Date(`${value.trim()}T12:00:00Z`);

  return !Number.isNaN(date.getTime());
}

function dateKeyOrNull(value) {
  return isValidDateKey(value) ? value.trim() : null;
}

function intOrNull(value, min, max) {
  const number = toNumber(value);

  if (number === null) {
    return null;
  }

  const rounded = Math.round(number);

  if (typeof min === "number" && rounded < min) {
    return null;
  }

  if (typeof max === "number" && rounded > max) {
    return null;
  }

  return rounded;
}

function numOrNull(value, min, max) {
  const number = toNumber(value);

  if (number === null) {
    return null;
  }

  if (typeof min === "number" && number < min) {
    return null;
  }

  if (typeof max === "number" && number > max) {
    return null;
  }

  return Number(number.toFixed(2));
}

/*
 * Normalizes a warmup / main_set / cooldown / instructions field into a
 * clean array of strings (the exact shape training_sessions stores and
 * the Train page renders), or null when nothing usable is present.
 */
function strArray(value, maxItems = 20, maxLen = 400) {
  let items = [];

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    items = trimmed.split(/\n+/);
  } else {
    return null;
  }

  const clean = items
    .map(item => cleanStr(item, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);

  return clean.length ? clean : null;
}

/* ─── normalization of a single model-proposed action ─────────── */

/*
 * Turns one raw model action into a clean, whitelisted action object, or
 * returns null when it is unusable. Only known fields survive; unknown
 * fields are dropped. This is the SHAPE gate used before a proposal is
 * ever shown to the athlete. Deeper checks (ownership, existence,
 * duplicates, load) happen at apply time against the database.
 */
export function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const type = cleanStr(raw.type, 40);

  if (!type || !ACTION_TYPES.includes(type)) {
    return null;
  }

  const changesInput =
    raw.changes && typeof raw.changes === "object" ? raw.changes : {};

  // The full whitelisted workout shape. A proposal may touch any of
  // these — whatever is provided is written to the ONE workout object so
  // the Train page (which renders straight from it) can never keep a
  // stale field.
  const changes = {
    duration_minutes: intOrNull(changesInput.duration_minutes, 0, MAX_SESSION_MINUTES),
    distance_km: numOrNull(changesInput.distance_km, 0, MAX_SESSION_KM),
    session_type: cleanStr(changesInput.session_type, 60),
    title: cleanStr(changesInput.title, 120),
    description: cleanStr(changesInput.description, 1000),
    purpose: cleanStr(changesInput.purpose, 1000),
    intensity: cleanStr(changesInput.intensity, 60),
    target_rpe: cleanStr(changesInput.target_rpe, 60),
    pace_guidance: cleanStr(changesInput.pace_guidance, 400),
    heart_rate_guidance: cleanStr(changesInput.heart_rate_guidance, 400),
    fueling_guidance: cleanStr(changesInput.fueling_guidance, 600),
    coach_reasoning: cleanStr(changesInput.coach_reasoning, 1000),
    notes: cleanStr(changesInput.notes, 1000),
    warmup: strArray(changesInput.warmup),
    main_set: strArray(changesInput.main_set),
    cooldown: strArray(changesInput.cooldown),
    instructions: strArray(changesInput.instructions),
    adjustment_rules: strArray(changesInput.adjustment_rules)
  };

  const correctedInput =
    raw.corrected_values && typeof raw.corrected_values === "object"
      ? raw.corrected_values
      : {};

  const correctedValues = {
    distance_km: numOrNull(correctedInput.distance_km, 0, 1000),
    duration_minutes: intOrNull(correctedInput.duration_minutes, 0, 6000),
    average_pace: cleanStr(correctedInput.average_pace, 20),
    activity_type: cleanStr(correctedInput.activity_type, 60),
    workout_structure: cleanStr(correctedInput.workout_structure, 1000),
    perceived_effort: intOrNull(correctedInput.perceived_effort, 1, 10),
    notes: cleanStr(correctedInput.notes, 1000)
  };

  const raceInput =
    raw.race_details && typeof raw.race_details === "object"
      ? raw.race_details
      : {};

  const raceDetails = {
    target_race: cleanStr(raceInput.target_race, 120),
    race_date: dateKeyOrNull(raceInput.race_date),
    target_time: cleanStr(raceInput.target_time, 40)
  };

  const dropEmpty = obj => {
    const out = {};
    Object.keys(obj).forEach(key => {
      if (obj[key] !== null && obj[key] !== undefined) {
        out[key] = obj[key];
      }
    });
    return out;
  };

  return {
    type,
    title: cleanStr(raw.title, 140) || defaultTitle(type),
    target_session_id: cleanStr(raw.target_session_id, 64),
    target_activity_id: cleanStr(raw.target_activity_id, 64),
    from_date: dateKeyOrNull(raw.from_date),
    to_date: dateKeyOrNull(raw.to_date),
    reason: cleanStr(raw.reason, 1000),
    original_summary: cleanStr(raw.original_summary, 600),
    proposed_summary: cleanStr(raw.proposed_summary, 600),
    changes: dropEmpty(changes),
    corrected_values: dropEmpty(correctedValues),
    race_details: dropEmpty(raceDetails),
    availability_note: cleanStr(raw.availability_note, 600),
    preference_note: cleanStr(raw.preference_note, 600)
  };
}

function defaultTitle(type) {
  const titles = {
    modify_workout: "Modify workout",
    move_workout: "Move workout",
    skip_workout: "Skip workout",
    replace_workout: "Replace workout",
    adjust_remaining_week: "Adjust the rest of the week",
    update_temporary_availability: "Update this week's availability",
    update_training_preference: "Update training preference",
    create_activity_override: "Correct activity data",
    update_race_details: "Update race details"
  };

  return titles[type] || "Coaching change";
}

/*
 * Validates and cleans an array of raw model actions for display. Drops
 * anything malformed; caps the count. Returns [] for non-arrays.
 */
export function validateProposedActions(rawActions, { maxActions = 3 } = {}) {
  if (!Array.isArray(rawActions)) {
    return [];
  }

  return rawActions
    .map(normalizeAction)
    .filter(Boolean)
    .slice(0, maxActions);
}

/* ─── apply-time validation (per type) ────────────────────────── */

const SESSION_ACTIONS = new Set([
  "modify_workout",
  "move_workout",
  "skip_workout",
  "replace_workout"
]);

/*
 * Deeper validation of a normalized action before applying. Returns
 * { action } or { error }. Ownership and existence of session/activity
 * ids are the caller's responsibility (they require the DB); here we
 * enforce that the required fields for each type are present and sane.
 */
export function validateActionForApply(action) {
  const clean = normalizeAction(action);

  if (!clean) {
    return { error: "The proposed change is not a supported action." };
  }

  if (SESSION_ACTIONS.has(clean.type) && !clean.target_session_id) {
    return { error: "This change needs a specific session to act on." };
  }

  if (clean.type === "move_workout") {
    if (!clean.to_date) {
      return { error: "A valid target date is required to move a session." };
    }
    if (clean.from_date && clean.to_date === clean.from_date) {
      return { error: "The session is already on that date." };
    }
  }

  if (clean.type === "create_activity_override") {
    if (!clean.target_activity_id) {
      return { error: "The activity to correct could not be identified." };
    }
    if (Object.keys(clean.corrected_values).length === 0) {
      return { error: "No corrected values were provided." };
    }
  }

  if (
    clean.type === "update_race_details" &&
    Object.keys(clean.race_details).length === 0
  ) {
    return { error: "No race details were provided to update." };
  }

  if (
    (clean.type === "modify_workout" || clean.type === "replace_workout") &&
    Object.keys(clean.changes).length === 0
  ) {
    return { error: "No changes were provided for the session." };
  }

  return { action: clean };
}

/* ─── building the training_sessions patch ────────────────────── */

/*
 * Given a validated session action and the current session row, returns
 * the whitelisted column patch to apply. Never returns unknown columns.
 */
export function buildSessionPatch(action, session) {
  const patch = { updated_at: new Date().toISOString() };

  if (action.type === "move_workout") {
    patch.session_date = action.to_date;
    return patch;
  }

  const changes = action.changes || {};

  // Every column the Train page renders is writable here, so applying a
  // proposal updates the whole workout object — one source of truth.
  const SCALAR_COLUMNS = [
    "duration_minutes",
    "distance_km",
    "session_type",
    "title",
    "description",
    "purpose",
    "intensity",
    "target_rpe",
    "pace_guidance",
    "heart_rate_guidance",
    "fueling_guidance",
    "coach_reasoning",
    "notes"
  ];

  const ARRAY_COLUMNS = [
    "warmup",
    "main_set",
    "cooldown",
    "instructions",
    "adjustment_rules"
  ];

  SCALAR_COLUMNS.forEach(key => {
    if (changes[key] !== undefined) {
      patch[key] = changes[key];
    }
  });

  ARRAY_COLUMNS.forEach(key => {
    if (Array.isArray(changes[key])) {
      patch[key] = changes[key];
    }
  });

  return patch;
}

/* Compact snapshot of a session before it is changed. */
export function snapshotSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  return {
    id: session.id || null,
    session_date: session.session_date || null,
    title: session.title || null,
    session_type: session.session_type || null,
    sport: session.sport || null,
    intensity: session.intensity || null,
    duration_minutes: toNumber(session.duration_minutes),
    distance_km: toNumber(session.distance_km)
  };
}

/* Builds the activity_data_overrides row from a validated action. */
export function buildActivityOverrideRow({ userId, action, activityId, proposalId }) {
  const values = action.corrected_values || {};

  return {
    user_id: userId,
    activity_id: activityId,
    source_proposal_id: proposalId || null,
    corrected_distance_km: values.distance_km ?? null,
    corrected_duration_minutes: values.duration_minutes ?? null,
    corrected_average_pace: values.average_pace ?? null,
    corrected_activity_type: values.activity_type ?? null,
    corrected_workout_structure: values.workout_structure ?? null,
    corrected_perceived_effort: values.perceived_effort ?? null,
    corrected_notes: values.notes ?? null,
    updated_at: new Date().toISOString()
  };
}

/* ─── consuming activity overrides ────────────────────────────── */

export function indexOverridesByActivity(overrides) {
  const map = new Map();

  (overrides || []).forEach(override => {
    if (override?.activity_id) {
      map.set(String(override.activity_id), override);
    }
  });

  return map;
}

/*
 * Returns activities with athlete-confirmed corrections merged on top of
 * the raw imported values. The RAW values are preserved on each object
 * (raw_distance_meters, raw_moving_time_seconds, imported_*) and a
 * `has_correction` flag is set, so callers can both use the effective
 * value and show "imported vs corrected". Nothing here mutates the DB.
 */
export function applyActivityOverrides(activities, overrides) {
  const map = indexOverridesByActivity(overrides);

  if (map.size === 0) {
    return (activities || []).slice();
  }

  return (activities || []).map(activity => {
    const override = activity?.id
      ? map.get(String(activity.id))
      : null;

    if (!override) {
      return activity;
    }

    const merged = { ...activity, has_correction: true };

    // Preserve the raw imported values before overlaying corrections.
    merged.imported = {
      distance_meters: toNumber(activity.distance_meters),
      moving_time_seconds: toNumber(activity.moving_time_seconds),
      sport_type: activity.sport_type || activity.activity_type || null,
      average_heartrate: toNumber(activity.average_heartrate)
    };

    const km = toNumber(override.corrected_distance_km);
    if (km !== null) {
      merged.distance_meters = Math.round(km * 1000);
    }

    const minutes = toNumber(override.corrected_duration_minutes);
    if (minutes !== null) {
      merged.moving_time_seconds = Math.round(minutes * 60);
    }

    if (override.corrected_activity_type) {
      merged.sport_type = override.corrected_activity_type;
      merged.activity_type = override.corrected_activity_type;
    }

    if (override.corrected_average_pace) {
      merged.corrected_average_pace = override.corrected_average_pace;
    }
    if (override.corrected_perceived_effort !== null && override.corrected_perceived_effort !== undefined) {
      merged.corrected_perceived_effort = override.corrected_perceived_effort;
    }
    if (override.corrected_workout_structure) {
      merged.corrected_workout_structure = override.corrected_workout_structure;
    }
    if (override.corrected_notes) {
      merged.corrected_notes = override.corrected_notes;
    }

    return merged;
  });
}
