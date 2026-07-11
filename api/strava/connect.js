import crypto from "node:crypto";

function sendJson(response, statusCode, body) {
  response.status(statusCode).json(body);
}

function createSignedState(payload, secret) {
  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

async function getAuthenticatedUser(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase server configuration is missing.");
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: serviceRoleKey
    }
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");

    return sendJson(response, 405, {
      error: "Method not allowed."
    });
  }

  try {
    const authorizationHeader = request.headers.authorization || "";

    if (!authorizationHeader.startsWith("Bearer ")) {
      return sendJson(response, 401, {
        error: "Authentication is required."
      });
    }

    const accessToken = authorizationHeader.slice("Bearer ".length).trim();

    if (!accessToken) {
      return sendJson(response, 401, {
        error: "Authentication token is missing."
      });
    }

    const user = await getAuthenticatedUser(accessToken);

    if (!user?.id) {
      return sendJson(response, 401, {
        error: "Your session is invalid or expired."
      });
    }

    const clientId = process.env.STRAVA_CLIENT_ID;
    const redirectUri = process.env.STRAVA_REDIRECT_URI;
    const stateSecret = process.env.OAUTH_STATE_SECRET;

    if (!clientId || !redirectUri || !stateSecret) {
      throw new Error("Strava OAuth configuration is incomplete.");
    }

    const state = createSignedState(
      {
        userId: user.id,
        issuedAt: Date.now(),
        nonce: crypto.randomBytes(16).toString("hex")
      },
      stateSecret
    );

    const authorizationUrl = new URL(
      "https://www.strava.com/oauth/authorize"
    );

    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set(
      "redirect_uri",
      redirectUri
    );
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "scope",
      "read,activity:read_all"
    );
    authorizationUrl.searchParams.set("approval_prompt", "auto");
    authorizationUrl.searchParams.set("state", state);

    return sendJson(response, 200, {
      authorizationUrl: authorizationUrl.toString()
    });
  } catch (error) {
    console.error("Could not start Strava OAuth:", error);

    return sendJson(response, 500, {
      error: "Could not start Strava authorization."
    });
  }
}