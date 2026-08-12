/*
 * Private Coach Workspace notes — pure validation and response sanitization.
 *
 * The API supplies rows only after JWT, role, active-assignment, permission,
 * and author checks. Athlete and author UUIDs never leave the server; the
 * opaque note id is returned because it is required for edit/pin/delete.
 */

export const COACH_NOTE_MAX_LENGTH = 4000;
export const COACH_NOTE_LIMIT = 100;

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function cleanTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function validateCoachNoteCreate(input) {
  const raw = input && input.body;
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Write a note before saving." };
  }
  if (raw.trim().length > COACH_NOTE_MAX_LENGTH) {
    return { ok: false, error: `Notes can be up to ${COACH_NOTE_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: { body: raw.trim(), pinned: input && input.pinned === true } };
}

export function validateCoachNotePatch(input) {
  const value = {};
  if (Object.prototype.hasOwnProperty.call(input || {}, "body")) {
    const result = validateCoachNoteCreate({ body: input.body });
    if (!result.ok) return result;
    value.body = result.value.body;
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, "pinned")) {
    if (typeof input.pinned !== "boolean") {
      return { ok: false, error: "Pinned must be true or false." };
    }
    value.pinned = input.pinned;
  }
  if (!Object.keys(value).length) {
    return { ok: false, error: "No note changes were provided." };
  }
  return { ok: true, value };
}

export function canMutateCoachNote(note, viewerId, hasWritePermission) {
  return Boolean(
    hasWritePermission && note && viewerId &&
    String(note.author_user_id || "") === String(viewerId)
  );
}

export function sanitizeCoachNote(row, options = {}) {
  if (!row || !row.id) return null;
  const body = cleanText(row.body, COACH_NOTE_MAX_LENGTH);
  const createdAt = cleanTimestamp(row.created_at);
  if (!body || !createdAt) return null;
  const canMutate = canMutateCoachNote(row, options.viewerId, options.canWrite);
  const authorNames = options.authorNames || {};
  return {
    id: String(row.id),
    body,
    pinned: row.pinned === true,
    created_at: createdAt,
    updated_at: cleanTimestamp(row.updated_at) || createdAt,
    author_name: cleanText(authorNames[String(row.author_user_id || "")], 120) || "Coach",
    is_author: String(row.author_user_id || "") === String(options.viewerId || ""),
    can_edit: canMutate,
    can_delete: canMutate
  };
}

export function buildCoachNotes(rows, options = {}) {
  const notes = (Array.isArray(rows) ? rows : [])
    .map(row => sanitizeCoachNote(row, options))
    .filter(Boolean)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at))
    .slice(0, COACH_NOTE_LIMIT);
  return { notes, can_create: options.canWrite === true };
}

export const COACH_NOTES_VERSION = "coach-notes-v1";
