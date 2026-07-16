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
    console.error("Strava token exchange failed:", data);
    throw new Error("Could not exchange the Strava authorization code.");
  }

  return data;
}

async function upsertStravaAccount(userId, tokenData, scope) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/strava_accounts?on_conflict=user_id`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation"
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

  const data = await response.json();

  if (!response.ok) {
    console.error("Supabase Strava account save failed:", data);
    throw new Error("Could not save the connected Strava account.");
  }

  return data;
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
    const data = await response.text();
    console.error("Profile connection update failed:", data);
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

export default async function handler(request, response) {
  // Canonical return origin (athlevo.org) — never the stale vercel.app URL.
  const appUrl = getAppReturnOrigin();

  try {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return response.status(405).send("Method not allowed.");
    }

    const { code, state, scope, error } = request.query;

    if (error) {
      return response.redirect(
        302,
        `${appUrl}?strava=cancelled`
      );
    }

    if (!code || !state) {
      return response.redirect(
        302,
        `${appUrl}?strava=missing_code`
      );
    }

    const statePayload = verifySignedState(
      state,
      process.env.OAUTH_STATE_SECRET
    );

    if (!statePayload) {
      return response.redirect(
        302,
        `${appUrl}?strava=invalid_state`
      );
    }

    const tokenData = await exchangeAuthorizationCode(code);

    if (
      !tokenData?.athlete?.id ||
      !tokenData?.access_token ||
      !tokenData?.refresh_token
    ) {
      throw new Error("Strava returned incomplete token data.");
    }

    await upsertStravaAccount(
      statePayload.userId,
      tokenData,
      scope
    );

    await markProfileConnected(statePayload.userId);

    return response.redirect(
      302,
      `${appUrl}?strava=connected`
    );
  } catch (error) {
    // Log a non-sensitive code only — never the code, tokens, or secrets.
    console.error("Strava callback failed:", {
      code: "STRAVA_CALLBACK_ERROR",
      message: error?.message || "unknown"
    });

    // A hard failure (token exchange / unexpected) renders a visible
    // Athlevo error page instead of a blank screen or raw JSON.
    return renderErrorPage(response, {
      appUrl,
      reason: "We couldn't finish connecting your Strava account. Please try again — your Athlevo account is unaffected.",
      code: "STRAVA_CALLBACK_ERROR",
      status: 502
    });
  }
}