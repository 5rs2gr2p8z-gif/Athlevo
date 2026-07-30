import {
  getStravaRedirectUri,
  isRedirectUriValid
} from "../../lib/server/stravaConfig.js";
import { createOAuthState } from "../../lib/server/oauthState.js";

function sendJson(response, statusCode, body) {
  response.status(statusCode).json(body);
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
    const stateSecret = process.env.OAUTH_STATE_SECRET;

    // One canonical redirect URI for the whole flow. Guaranteed to be a
    // registered athlevo.org callback (stale/preview env values are ignored
    // by the helper), so Strava can never reject it as invalid.
    const { uri: redirectUri, source, host, path } = getStravaRedirectUri();

    if (!clientId || !stateSecret) {
      throw new Error("Strava OAuth configuration is incomplete.");
    }

    // Refuse to start OAuth with an unregistered callback rather than
    // bouncing the athlete to Strava's raw "Bad Request" page.
    if (!isRedirectUriValid()) {
      console.error("Strava OAuth blocked: redirect URI not registered.", {
        code: "STRAVA_REDIRECT_CONFIG",
        host,
        path
      });
      return sendJson(response, 500, {
        error: "Strava connection is temporarily unavailable. Please try again later.",
        code: "STRAVA_REDIRECT_CONFIG"
      });
    }

    // Safe diagnostic: host + path + source only. Never the full URL,
    // state, code, tokens, or secrets.
    console.log("Strava OAuth start:", { host, path, redirectSource: source });

    const requestedReturnTarget = request.body?.return_target;
    if (
      requestedReturnTarget !== undefined &&
      requestedReturnTarget !== "web" &&
      requestedReturnTarget !== "ios"
    ) {
      return sendJson(response, 400, {
        error: "Invalid return target.",
        code: "INVALID_RETURN_TARGET"
      });
    }

    const state = createOAuthState(
      {
        userId: user.id,
        provider: "strava",
        issuedAt: Date.now(),
        returnTarget: requestedReturnTarget || "web"
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
  } catch {
    console.error("Could not start Strava OAuth:", {
      code: "STRAVA_CONNECT_FAILED"
    });

    return sendJson(response, 500, {
      error: "Could not start Strava authorization."
    });
  }
}
