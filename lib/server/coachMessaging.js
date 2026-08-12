/*
 * Human coach ↔ athlete messaging helpers.
 *
 * This is deliberately separate from coach_conversations, which stores the
 * athlete's AI Coach chat. The active coach/athlete assignment pair is the
 * thread identity, so entering from Athlete Detail never creates a duplicate
 * conversation record.
 */

export const COACH_MESSAGE_MAX_LENGTH = 4000;
export const COACH_MESSAGE_LIMIT = 200;

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function cleanTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function validateCoachMessage(input) {
  const raw = input && input.body;
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Write a message before sending." };
  }
  if (raw.trim().length > COACH_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Messages can be up to ${COACH_MESSAGE_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: { body: raw.trim() } };
}

export function sanitizeCoachMessage(row) {
  if (!row || !row.id) return null;
  const body = cleanText(row.body, COACH_MESSAGE_MAX_LENGTH);
  const createdAt = cleanTimestamp(row.created_at);
  const senderRole = row.sender_role === "athlete" ? "athlete" : row.sender_role === "coach" ? "coach" : null;
  if (!body || !createdAt || !senderRole) return null;
  return { id: String(row.id), sender_role: senderRole, body, created_at: createdAt };
}

export function buildCoachThread(rows, options = {}) {
  const messages = (Array.isArray(rows) ? rows : [])
    .map(sanitizeCoachMessage)
    .filter(Boolean)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-COACH_MESSAGE_LIMIT);
  return { messages, can_send: options.canSend === true };
}

export const COACH_MESSAGING_VERSION = "coach-messaging-v1";
