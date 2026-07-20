/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Intervals.icu OAuth configuration
 * ══════════════════════════════════════════════════════════════════════
 *
 *  One canonical redirect URI for the whole flow. The authorize step and the
 *  token-exchange step MUST send byte-identical redirect_uri values or the
 *  exchange fails, so both read it from here and nowhere else.
 *
 *  Secrets are read lazily inside functions — never at import — so the app
 *  boots fine on a deployment with no Intervals credentials configured.
 *  No secret is ever returned to the browser.
 */

// Documented Intervals.icu OAuth + API endpoints.
export const INTERVALS_AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
export const INTERVALS_TOKEN_URL = "https://intervals.icu/api/oauth/token";
export const INTERVALS_API_BASE = "https://intervals.icu/api/v1";

// Read access to completed activities is all Athlevo needs. We deliberately
// do NOT request WRITE, CALENDAR, CHATS, LIBRARY or SETTINGS scopes — Athlevo
// never writes to the athlete's Intervals.icu account.
export const INTERVALS_SCOPE = "ACTIVITY:READ";

// Signed-state lifetime. Intervals.icu expires the authorization code after
// 2 minutes, so 10 minutes here is generous for the human step while still
// bounding the window in which a stolen state value is usable.
export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/*
 * The callback URL registered with the Intervals.icu app. Explicit config
 * wins; otherwise it is derived from APP_URL so preview deployments don't
 * silently send an unregistered URI that Intervals.icu will reject.
 */
export function getIntervalsRedirectUri() {
  const explicit = process.env.INTERVALS_REDIRECT_URI;
  if (explicit) return { uri: explicit, source: "INTERVALS_REDIRECT_URI" };

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    return {
      uri: `${appUrl.replace(/\/+$/, "")}/api/providers?provider=intervals&action=callback`,
      source: "APP_URL"
    };
  }
  return { uri: null, source: "unconfigured" };
}

// Where to bounce the athlete back to after the callback finishes.
export function getAppReturnOrigin() {
  const appUrl = process.env.APP_URL;
  return appUrl ? appUrl.replace(/\/+$/, "") : "";
}

export function isIntervalsConfigured() {
  return Boolean(
    process.env.INTERVALS_CLIENT_ID &&
    process.env.INTERVALS_CLIENT_SECRET &&
    process.env.OAUTH_STATE_SECRET &&
    getIntervalsRedirectUri().uri
  );
}
