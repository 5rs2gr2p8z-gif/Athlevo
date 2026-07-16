import crypto from "node:crypto";
import {
  getStravaRedirectUri,
  getAppReturnOrigin
} from "../../lib/server/stravaConfig.js";

function verifySignedState(state, secret) {
  if (!state || !secret) {
    return null;
  }

  const parts = state.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, receivedSignature] = parts;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  const signaturesMatch = crypto.timingSafeEqual(
    receivedBuffer,
    expectedBuffer
  );

  if (!signaturesMatch) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

    const maximumStateAge = 10 * 60 * 1000;

    if (
      !payload.userId ||
      !payload.issuedAt ||
      Date.now() - payload.issuedAt > maximumStateAge
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

async function exchangeAuthorizationCode(code) {
  // Send the EXACT same canonical redirect_uri used in the authorization
  // request so the two steps always agree.
  const { uri: redirectUri } = getStravaRedirectUri();

  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    })
  });

  const data = await response.json();

  if (!response.ok) {
    // Log only the HTTP status — never the raw provider response, which is
    // adjacent to token material.
    console.error("Strava token exchange failed:", { status: response.status });
    throw new Error("Could not exchange the Strava authorization code.");
  }

  return data;
}

function sbHeaders() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json"
  };
}

// Reads the owner (user_id) of any existing connection for a Strava athlete.
// Returns { ok, userId|null }. Uses the service role (server-side; RLS bypass).
async function findAccountUserByAthlete(athleteId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/strava_accounts?strava_athlete_id=eq.${encodeURIComponent(
        String(athleteId)
      )}&select=user_id&limit=1`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return { ok: false, userId: null };
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return { ok: true, userId: row ? String(row.user_id) : null };
  } catch (error) {
    return { ok: false, userId: null };
  }
}

// True when this Athlevo user already has a saved connection (used to make
// callback refresh / reused-code idempotent).
async function userHasConnection(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/strava_accounts?user_id=eq.${encodeURIComponent(
        String(userId)
      )}&select=user_id&limit=1`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (error) {
    return false;
  }
}

/*
 * Idempotent, ownership-safe save. Upserts on user_id (one connection per
 * Athlevo user; reconnecting the SAME user updates in place with the newest
 * tokens). Returns { ok, pgCode } — never throws, never logs token values or
 * the raw response body. pgCode is the (safe) Postgres SQLSTATE for
 * diagnostics, so a unique conflict can be categorised precisely.
 */
async function upsertStravaAccount(userId, tokenData, scope) {
  const supabaseUrl = process.env.SUPABASE_URL;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/strava_accounts?on_conflict=user_id`,
    {
      method: "POST",
      headers: {
        ...sbHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: userId,
        strava_athlete_id: tokenData.athlete.id,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
        scope: scope || null,
        athlete_data: tokenData.athlete,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    }
  );

  if (response.ok) return { ok: true, pgCode: null };

  // Extract only the SQLSTATE (safe) — never log the body itself.
  let pgCode = null;
  try {
    const body = await response.json();
    pgCode = body && body.code ? String(body.code) : null;
  } catch (error) { /* ignore */ }

  return { ok: false, status: response.status, pgCode };
}

async function markProfileConnected(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        strava_connected: true,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!response.ok) {
    // Status only — never the response body.
    console.error("Profile connection flag failed:", { status: response.status });
    throw new Error("Could not update the athlete profile.");
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/*
 * A visible, self-contained Athlevo error page for hard OAuth failures
 * (config errors, token-exchange failures, unexpected errors) so the
 * athlete never sees raw JSON or a blank screen. It exposes no secrets or
 * server internals — only a friendly message, an optional safe error code,
 * and Try again / Return to Athlevo actions.
 */
function renderErrorPage(response, { appUrl, reason, code, status = 502 }) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strava connection failed — Athlevo</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#eeeeec;color:#141416;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;max-width:420px;width:calc(100% - 40px);margin:20px;border-radius:22px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.10)}
  h1{font-size:20px;margin:0 0 8px}
  p{font-size:14px;line-height:1.55;color:#6d7075;margin:0 0 16px}
  .code{font-size:12px;color:#9a9da3;margin-bottom:18px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  a{flex:1;text-align:center;text-decoration:none;font-size:14px;font-weight:600;padding:13px 16px;border-radius:100px}
  .primary{background:#141416;color:#fff}
  .ghost{background:#f6f6f4;color:#141416}
</style></head>
<body><div class="card">
  <h1>Strava connection failed</h1>
  <p>${escapeHtml(reason || "We couldn't complete the connection with Strava. Your Athlevo account is unaffected.")}</p>
  ${code ? `<div class="code">Reference: ${escapeHtml(code)}</div>` : ""}
  <div class="row">
    <a class="primary" href="${escapeHtml(appUrl)}/?strava=retry">Try again</a>
    <a class="ghost" href="${escapeHtml(appUrl)}/">Return to Athlevo</a>
  </div>
</div></body></html>`;

  response.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  return response.send(html);
}

/* Short, non-reversible id for correlating logs without exposing the uuid. */
function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

/*
 * Privacy-safe stage diagnostic. Emits a correlation id, the stage, a safe
 * internal code, and only non-sensitive identifiers. NEVER tokens, secret,
 * authorization code, full OAuth state, or private user details.
 */
function diag(fields) {
  try {
    console.log("strava_callback", JSON.stringify(fields));
  } catch (error) { /* ignore */ }
}

export default async function handler(request, response) {
  // Canonical return origin (athlevo.org) — never the stale vercel.app URL.
  const appUrl = getAppReturnOrigin();
  const correlationId = crypto.randomUUID().slice(0, 8);

  // Benign outcomes return to the app with a param the client toasts.
  const backToApp = param =>
    response.redirect(302, `${appUrl}?strava=${param}`);

  // Hard outcomes render a visible error page with a safe stage code.
  const failPage = (code, reason, status, extra) => {
    diag({ cid: correlationId, ...(extra || {}), code });
    return renderErrorPage(response, { appUrl, reason, code, status: status || 502 });
  };

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).send("Method not allowed.");
  }

  const { code, state, scope, error } = request.query;

  // Stage 1–2: request received + OAuth state present.
  if (error) {
    diag({ cid: correlationId, stage: "authorize", code: "STRAVA_AUTH_DENIED" });
    return backToApp("cancelled");
  }
  if (!state) {
    diag({ cid: correlationId, stage: "state", code: "STRAVA_STATE_MISSING" });
    return backToApp("invalid_state");
  }
  if (!code) {
    diag({ cid: correlationId, stage: "code", code: "STRAVA_CODE_MISSING" });
    return backToApp("missing_code");
  }

  // Stage 3–4: validate state → this yields the authenticated Athlevo user
  // (the callback needs no browser session; the signed state carries userId).
  const statePayload = verifySignedState(state, process.env.OAUTH_STATE_SECRET);
  if (!statePayload || !statePayload.userId) {
    // verifySignedState already rejects tampered signatures AND anything
    // older than the 10-minute expiry, so this covers stale/expired state.
    diag({ cid: correlationId, stage: "state", code: "STRAVA_STATE_INVALID" });
    return backToApp("invalid_state");
  }
  const userId = statePayload.userId;
  const userHash = shortHash(userId);

  // Stage 6: exchange the authorization code (single-use by Strava). If it
  // fails, a callback refresh / reused code on an ALREADY-connected user is
  // treated as success (idempotent) rather than a hard error.
  let tokenData;
  try {
    tokenData = await exchangeAuthorizationCode(code);
  } catch (exchangeError) {
    if (await userHasConnection(userId)) {
      diag({ cid: correlationId, stage: "exchange", userHash, code: "STRAVA_ALREADY_CONNECTED_ON_REFRESH" });
      return backToApp("connected");
    }
    return failPage(
      "STRAVA_TOKEN_EXCHANGE_FAILED",
      "Strava couldn't verify this connection (the link may have expired). Please try connecting again.",
      502,
      { stage: "exchange", userHash }
    );
  }

  // Stage 7: Strava athlete returned.
  if (!tokenData?.athlete?.id || !tokenData?.access_token || !tokenData?.refresh_token) {
    return failPage(
      "STRAVA_ATHLETE_MISSING",
      "Strava didn't return your athlete details. Please try connecting again.",
      502,
      { stage: "athlete", userHash }
    );
  }
  const athleteId = String(tokenData.athlete.id);

  // Stage 8: ownership check — one Strava athlete must not silently attach to
  // two different Athlevo users. (Enforced in code so it is correct even if
  // the DB lacks a unique constraint on strava_athlete_id.)
  const owner = await findAccountUserByAthlete(athleteId);
  if (owner.ok && owner.userId && owner.userId !== String(userId)) {
    return failPage(
      "STRAVA_ALREADY_LINKED",
      "This Strava account is already connected to another Athlevo account.",
      409,
      { stage: "ownership", userHash, athleteId }
    );
  }

  // Stage 9: save the connection (idempotent upsert on user_id).
  const saved = await upsertStravaAccount(userId, tokenData, scope);
  if (!saved.ok) {
    // A unique conflict here almost always means the athlete is linked
    // elsewhere (athlete-level unique) → surface it as ALREADY_LINKED;
    // anything else is a generic save failure.
    if (saved.pgCode === "23505") {
      return failPage(
        "STRAVA_ALREADY_LINKED",
        "This Strava account is already connected to another Athlevo account.",
        409,
        { stage: "save", userHash, athleteId, dbCode: saved.pgCode }
      );
    }
    return failPage(
      "STRAVA_CONNECTION_SAVE_FAILED",
      "We connected to Strava but couldn't save it just now. Please try again in a moment.",
      502,
      { stage: "save", userHash, athleteId, dbCode: saved.pgCode }
    );
  }

  // Stage 10 (best-effort, NON-fatal): flag the profile connected. If this
  // patch fails, the connection is still saved and considered successful.
  try {
    await markProfileConnected(userId);
  } catch (flagError) {
    diag({ cid: correlationId, stage: "profile_flag", userHash, athleteId, code: "STRAVA_PROFILE_FLAG_DEFERRED" });
  }

  // Stage 11: success. Initial activity sync happens client-side after this
  // redirect and is DECOUPLED — a sync failure never undoes the connection.
  diag({ cid: correlationId, stage: "success", userHash, athleteId, code: "STRAVA_CONNECTED" });
  return backToApp("connected");
}