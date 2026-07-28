/*
 * Athlevo — Legacy Strava user-facing gateway
 *
 * POST /api/strava?action=connect
 * POST /api/strava?action=sync
 *
 * The OAuth callback remains isolated at /api/strava/callback because its
 * browser redirect contract is externally registered with Strava.
 */

import connectHandler from "../lib/server/strava/connect.js";
import syncHandler from "../lib/server/strava/sync.js";

export default async function handler(request, response) {
  const action = String(request.query?.action || "").toLowerCase();

  if (action === "connect") {
    return connectHandler(request, response);
  }

  if (action === "sync") {
    return syncHandler(request, response);
  }

  return response.status(400).json({
    error: "Unknown Strava action."
  });
}
