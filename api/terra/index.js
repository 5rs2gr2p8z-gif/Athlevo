/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Terra wearable gateway  (DORMANT — disabled by default)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Terra is NOT used in production at Athlevo's private-beta stage (its
 *  Quick Start pricing isn't a fit yet). This endpoint is retained ONLY as
 *  a dormant adapter behind a feature flag, so the provider abstraction and
 *  normalization work stay intact and Terra can be switched on later with
 *  zero coaching-logic changes.
 *
 *  Safety guarantees (see section 7 of the task):
 *    · Default disabled — requires WEARABLE_TERRA_ENABLED === "true".
 *    · Reads NO Terra credentials unless explicitly enabled, so it never
 *      throws when TERRA_* env vars are absent.
 *    · No webhook processing, no Terra API calls, no token handling while
 *      disabled — it simply returns 404.
 *    · No background job, no UI, no athlete-facing Terra branding.
 *
 *  The active import path is Strava (api/strava/*), which flows through the
 *  SAME shared normalization layer (lib/server/wearable/normalizer.js).
 */

function isTerraEnabled() {
  return process.env.WEARABLE_TERRA_ENABLED === "true";
}

export default async function handler(request, response) {
  // Disabled by default: no Terra credentials are read, nothing runs.
  if (!isTerraEnabled()) {
    return response.status(404).json({
      error: "Wearable provider not available.",
      code: "TERRA_DISABLED"
    });
  }

  // If a future operator explicitly enables Terra, the full gateway
  // (connect + signed webhook + normalization via the shared layer) is
  // implemented in git history and can be restored here deliberately. It is
  // intentionally NOT active now so no public webhook or Terra dependency
  // exists in production.
  return response.status(503).json({
    error: "Wearable provider is enabled but not configured in this build.",
    code: "TERRA_NOT_CONFIGURED"
  });
}
