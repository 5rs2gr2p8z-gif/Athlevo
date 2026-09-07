/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — anonymous cross-browser continuation handoff endpoint
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Lets an anonymous visitor who talked to the pre-signup Coach in a Meta
 *  in-app browser (Facebook/Messenger/Instagram) carry that context into
 *  Safari/Chrome for an action that genuinely needs an external browser
 *  (Google OAuth, wearable connection, or an explicit "Continue in Safari
 *  or Chrome"). See migrations/2026-09-07_anonymous_handoffs.sql.
 *
 *  POST  create a handoff: body { payload, sourceBrowser?, sourceSurface? }
 *        -> { token }                      (opaque, single-use, ~25min TTL)
 *  GET   consume a handoff: ?token=<token>
 *        -> { payload } | { payload: null } (never throws — see below)
 *
 *  Security:
 *  - The raw token is generated here and returned to the client once; only
 *    its sha256 hash is ever stored or looked up.
 *  - Consuming a token is an atomic claim (UPDATE ... WHERE consumed_at IS
 *    NULL) so it cannot be replayed even if it leaks (e.g. via a shared
 *    link, referrer, or browser history) after first use.
 *  - `payload` is expected to be the existing DiagnosticEngine stored
 *    payload shape (js/diagnostic.js toStoredPayload/isValidStoredPayload).
 *    This endpoint does light shape/size checks only — the client
 *    re-validates strictly with the SAME validator used for its own
 *    localStorage before ever trusting it (DiagnosticEngine.restoreFromServer).
 *  - No email, password, auth/access tokens, or free-text conversation
 *    content is accepted into `payload` beyond what that shape allows.
 *
 *  Fails open/quiet by design (section 8 of the spec this implements):
 *  a missing table, expired/consumed/malformed token, or network hiccup
 *  must never surface a scary error — callers get { payload: null } (GET)
 *  or a plain failure (POST), and the client just proceeds with normal
 *  signup/onboarding.
 */

import crypto from "node:crypto";
import { getSupabaseAdminHeaders, getSupabaseServerKey } from "./supabaseServer.js";
import { checkAnonymousAiRateLimit, rateLimitResponse } from "./rateLimit.js";

const TABLE = "anonymous_handoffs";
const TTL_MINUTES = 25;
const MAX_PAYLOAD_BYTES = 20000; // the DiagnosticEngine payload is small (categorical only)
const ALLOWED_BROWSERS = { facebook: true, instagram: true };

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function anonClientKey(req) {
  const salt = process.env.OAUTH_STATE_SECRET || "athlevo-anon-handoff";
  const ip = clientIp(req);
  const ua = (req.headers && req.headers["user-agent"]) || "";
  return crypto.createHash("sha256").update(`${salt}:${ip}:${ua}`).digest("hex").slice(0, 40);
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Light shape/size sanity check only — NOT the source of truth. The client
// re-validates strictly with DiagnosticEngine's own isValidStoredPayload
// before trusting any of this. This just keeps obviously-wrong or
// oversized blobs out of the table.
function looksLikeDiagnosticPayload(payload) {
  if (!isPlainObject(payload)) return false;
  if (typeof payload.importKey !== "string" || !payload.importKey) return false;
  if (typeof payload.engineVersion !== "string") return false;
  if (typeof payload.v !== "number") return false;
  // Reject anything that carries fields this payload shape has no business having.
  const forbidden = ["email", "password", "accessToken", "access_token", "refreshToken",
    "refresh_token", "authToken", "auth_token", "workoutData", "workout_data"];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) return false;
  }
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(payload), "utf8"); } catch (e) { return false; }
  return size > 0 && size <= MAX_PAYLOAD_BYTES;
}

function sanitizeBrowser(v) {
  const s = String(v || "").trim().toLowerCase();
  return ALLOWED_BROWSERS[s] ? s : null;
}

function sanitizeSurface(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 40 || !/^[a-z0-9_]+$/i.test(s)) return null;
  return s;
}

async function createHandoff(request, response) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = getSupabaseServerKey();
  if (!supabaseUrl || !serviceRoleKey) {
    return response.status(503).json({ ok: false, error: "unavailable" });
  }

  const clientKey = anonClientKey(request);
  try {
    const limit = await checkAnonymousAiRateLimit(clientKey, "handoff-create");
    if (!limit.allowed) return rateLimitResponse(response, limit);
  } catch (e) { /* fail open */ }

  const body = isPlainObject(request.body) ? request.body : {};
  const payload = body.payload;
  if (!looksLikeDiagnosticPayload(payload)) {
    return response.status(400).json({ ok: false, error: "invalid_payload" });
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const expiresAt = new Date(now + TTL_MINUTES * 60 * 1000).toISOString();

  try {
    const headers = getSupabaseAdminHeaders({ "Content-Type": "application/json" });
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        token_hash: tokenHash,
        payload,
        source_browser: sanitizeBrowser(body.sourceBrowser),
        source_surface: sanitizeSurface(body.sourceSurface),
        expires_at: expiresAt
      })
    });
    if (!insertRes.ok) {
      return response.status(503).json({ ok: false, error: "unavailable" });
    }
  } catch (e) {
    return response.status(503).json({ ok: false, error: "unavailable" });
  }

  return response.status(200).json({ ok: true, token, expiresAt });
}

async function consumeHandoff(request, response) {
  // Always resolves with { payload } (possibly null) — never a hard error —
  // so the caller can unconditionally fall back to normal onboarding.
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = getSupabaseServerKey();
  const token = String((request.query && request.query.token) || "").trim();

  if (!supabaseUrl || !serviceRoleKey || !token || token.length > 200) {
    return response.status(200).json({ ok: true, payload: null });
  }

  try {
    const clientKey = anonClientKey(request);
    const limit = await checkAnonymousAiRateLimit(clientKey, "handoff-create");
    if (!limit.allowed) return response.status(200).json({ ok: true, payload: null });
  } catch (e) { /* fail open */ }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const headers = getSupabaseAdminHeaders({ "Content-Type": "application/json" });
    const nowIso = new Date().toISOString();

    // Atomic single-use claim: only succeeds while unconsumed and unexpired.
    const claimUrl =
      `${supabaseUrl}/rest/v1/${TABLE}` +
      `?token_hash=eq.${encodeURIComponent(tokenHash)}` +
      `&consumed_at=is.null` +
      `&expires_at=gt.${encodeURIComponent(nowIso)}`;
    const claimRes = await fetch(claimUrl, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ consumed_at: nowIso })
    });
    if (!claimRes.ok) return response.status(200).json({ ok: true, payload: null });

    const rows = await claimRes.json();
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row || !isPlainObject(row.payload)) {
      return response.status(200).json({ ok: true, payload: null });
    }
    return response.status(200).json({ ok: true, payload: row.payload });
  } catch (e) {
    return response.status(200).json({ ok: true, payload: null });
  }
}

export default async function anonymousHandoffHandler(request, response) {
  const method = String(request.method || "GET").toUpperCase();
  if (method === "POST") return createHandoff(request, response);
  if (method === "GET") return consumeHandoff(request, response);
  return response.status(405).json({ ok: false, error: "method_not_allowed" });
}
