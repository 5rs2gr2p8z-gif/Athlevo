import crypto from "node:crypto";

export const INVITE_STATUSES = ["pending", "accepted", "expired", "revoked"];
export const INVITE_PERMISSION_LEVELS = ["read", "read_write"];
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeInviteEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function validateInviteEmail(email) {
  const normalized = normalizeInviteEmail(email);
  if (!normalized || normalized.length > 254) return false;
  if (/\s/.test(normalized)) return false;
  return /^[^@]+@[^@]+\.[^@]+$/.test(normalized);
}

export function generateInviteToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashInviteToken(rawToken) {
  const value = typeof rawToken === "string" ? rawToken : "";
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function isInviteExpired(invite, now = Date.now()) {
  const expiry = Date.parse(invite && invite.expires_at);
  return !Number.isFinite(expiry) || expiry <= Number(now);
}

export function canAcceptInvite(invite, authenticatedEmail, now = Date.now()) {
  return Boolean(
    invite &&
    invite.status === "pending" &&
    !isInviteExpired(invite, now) &&
    normalizeInviteEmail(authenticatedEmail) === normalizeInviteEmail(invite.email_normalized)
  );
}

export function validateInviteTransition(currentStatus, action) {
  const status = String(currentStatus || "").toLowerCase();
  const nextAction = String(action || "").toLowerCase();
  if (!INVITE_STATUSES.includes(status)) return { ok: false, reason: "invalid_status" };
  if (!['accept', 'resend', 'revoke'].includes(nextAction)) {
    return { ok: false, reason: "invalid_action" };
  }
  if (status !== "pending") return { ok: false, reason: "invite_not_pending" };
  return { ok: true, reason: null };
}

/*
 * Coach join links: one shareable code per coach (athlevo.org/?coach=<code>).
 * Lowercase letters and digits with the look-alikes (0, 1, i, l, o) removed,
 * so a code survives being read aloud or retyped.
 */
const JOIN_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const JOIN_CODE_LENGTH = 8;

export function generateJoinCode() {
  const bytes = crypto.randomBytes(JOIN_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) {
    code += JOIN_CODE_ALPHABET[bytes[i] % JOIN_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeJoinCode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateJoinCode(value) {
  return /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/.test(normalizeJoinCode(value));
}

export const COACH_INVITES_VERSION = "coach-invites-v2";
