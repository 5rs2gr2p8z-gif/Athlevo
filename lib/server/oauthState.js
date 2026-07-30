import crypto from "node:crypto";

export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const OAUTH_STATE_FUTURE_SKEW_MS = 60 * 1000;
export const OAUTH_STATE_MAX_LENGTH = 2048;
// Transitional support for states issued before returnTarget was introduced.
// After this UTC cutoff, only the exact current schema is accepted.
export const OAUTH_LEGACY_STATE_ACCEPT_UNTIL_MS = Date.UTC(2026, 7, 15);

const PROVIDERS = new Set(["strava", "intervals"]);
const RETURN_TARGETS = new Set(["web", "ios"]);
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE = /^[a-f0-9]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_LENGTH = 43;
const NEW_FIELDS = ["issuedAt", "nonce", "provider", "returnTarget", "userId"];
const LEGACY_FIELDS = {
  // Pre-returnTarget Strava states did not carry a provider field.
  strava: ["issuedAt", "nonce", "userId"],
  // Intervals already carried its fixed provider discriminator.
  intervals: ["issuedAt", "nonce", "provider", "userId"]
};

function hasExactFields(payload, fields) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const actual = Object.keys(payload).sort();
  return actual.length === fields.length &&
    actual.every((key, index) => key === fields[index]);
}

function hasValidCommonFields(payload, expectedProvider, now) {
  return (
    typeof payload.userId === "string" &&
    USER_ID.test(payload.userId) &&
    payload.provider === expectedProvider &&
    Number.isInteger(payload.issuedAt) &&
    payload.issuedAt > 0 &&
    payload.issuedAt <= now + OAUTH_STATE_FUTURE_SKEW_MS &&
    now - payload.issuedAt <= OAUTH_STATE_MAX_AGE_MS &&
    typeof payload.nonce === "string" &&
    NONCE.test(payload.nonce)
  );
}

function normalizeLegacyPayload(payload, expectedProvider, now) {
  const legacyFields = LEGACY_FIELDS[expectedProvider];
  if (
    now > OAUTH_LEGACY_STATE_ACCEPT_UNTIL_MS ||
    !legacyFields ||
    !hasExactFields(payload, legacyFields)
  ) {
    return null;
  }

  const candidate = {
    ...payload,
    provider: expectedProvider
  };
  if (!hasValidCommonFields(candidate, expectedProvider, now)) return null;

  // Compatibility is deliberately limited to the ordinary ten-minute state
  // lifetime. A legacy state can never select the native callback.
  return { ...candidate, returnTarget: "web", legacy: true };
}

export function createOAuthState({
  userId,
  provider,
  issuedAt = Date.now(),
  nonce = crypto.randomBytes(16).toString("hex"),
  returnTarget = "web"
}, secret) {
  if (typeof secret !== "string" || secret.length < 1) {
    throw new TypeError("OAuth state secret is required.");
  }
  const payload = { userId, provider, issuedAt, nonce, returnTarget };
  const now = Date.now();
  if (
    !PROVIDERS.has(provider) ||
    !RETURN_TARGETS.has(returnTarget) ||
    !hasExactFields(payload, NEW_FIELDS) ||
    !hasValidCommonFields(payload, provider, now)
  ) {
    throw new TypeError("OAuth state payload is invalid.");
  }

  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  const state = `${body}.${signature}`;
  if (state.length > OAUTH_STATE_MAX_LENGTH) {
    throw new TypeError("OAuth state is too large.");
  }
  return state;
}

export function verifyOAuthState(state, secret, {
  provider,
  now = Date.now(),
  allowLegacyWithoutReturnTarget = true
} = {}) {
  if (
    typeof state !== "string" ||
    typeof secret !== "string" ||
    secret.length < 1 ||
    !PROVIDERS.has(provider) ||
    !Number.isInteger(now) ||
    state.length < 3 ||
    state.length > OAUTH_STATE_MAX_LENGTH
  ) {
    return null;
  }

  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (
    !BASE64URL.test(body) ||
    !BASE64URL.test(signature) ||
    signature.length !== SIGNATURE_LENGTH
  ) {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest();
  let received;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.toString("base64url") !== signature) return null;
  if (received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)) {
    return null;
  }

  let payload;
  try {
    const decodedBuffer = Buffer.from(body, "base64url");
    if (decodedBuffer.toString("base64url") !== body) return null;
    const decoded = decodedBuffer.toString("utf8");
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (hasExactFields(payload, NEW_FIELDS)) {
    if (
      !hasValidCommonFields(payload, provider, now) ||
      !RETURN_TARGETS.has(payload.returnTarget)
    ) {
      return null;
    }
    return { ...payload, legacy: false };
  }

  return allowLegacyWithoutReturnTarget
    ? normalizeLegacyPayload(payload, provider, now)
    : null;
}
