import crypto from "node:crypto";

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
  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code"
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

export default async function handler(request, response) {
  const appUrl = "https://athlevo-ai.vercel.app";

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
        `${appUrl}?strava=missing_parameters`
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
    console.error("Strava callback failed:", error);

    return response.redirect(
      302,
      `${appUrl}?strava=error`
    );
  }
}