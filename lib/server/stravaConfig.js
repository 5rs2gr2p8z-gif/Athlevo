/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — canonical Strava OAuth configuration (single source of truth)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Every production Strava authorization request, token exchange, and
 *  post-callback return MUST use the SAME redirect URI, and it must live
 *  under the domain registered as the Strava app's "Authorization Callback
 *  Domain" (athlevo.org). Strava rejects any redirect_uri whose host is not
 *  under that domain with:
 *      { errors: [{ field: "redirect_uri", code: "invalid" }] }
 *
 *  This module is the ONLY place the redirect URI / app origin is decided,
 *  so the four steps can never drift apart. It is pure (no I/O) and safe to
 *  import from any serverless function (it adds no Vercel function itself).
 *
 *  Resolution is deliberately defensive so a stale or preview environment
 *  variable can never send Strava an unregistered callback:
 *    1. STRAVA_REDIRECT_URI / APP_URL / SITE_URL / PUBLIC_APP_URL are used
 *       ONLY when they resolve to an allowed athlevo.org host.
 *    2. A localhost callback is used ONLY when STRAVA_ALLOW_LOCALHOST=true
 *       (explicit local development) — never on Vercel prod/preview.
 *    3. Otherwise we fall back to the hardcoded canonical production URL.
 *  Preview deployments therefore use the canonical production callback
 *  rather than generating their own unregistered Vercel preview URI.
 */

// The registered production origin + the EXISTING callback path. Do not
// invent a new callback path — this matches api/strava/callback.js.
const CANONICAL_ORIGIN = "https://athlevo.org";
const CALLBACK_PATH = "/api/strava/callback";

// Hosts Strava will accept because they are under the registered callback
// domain (athlevo.org, incl. the www subdomain).
const ALLOWED_PROD_HOSTS = new Set(["athlevo.org", "www.athlevo.org"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function parseOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch (error) {
    return null;
  }
}

// Explicit local-dev opt-in. Vercel never sets this in prod/preview.
function isLocalDevelopment() {
  return process.env.STRAVA_ALLOW_LOCALHOST === "true";
}

// Forces the canonical callback path onto an origin, ignoring any path or
// trailing slash the operator may have put in the env value.
function withCallbackPath(originUrl) {
  return `${originUrl.origin}${CALLBACK_PATH}`;
}

/*
 * The single canonical redirect URI. Returns { uri, source, host, path }.
 * `source` is safe to log for diagnostics (it names WHERE the value came
 * from, never the value of any secret).
 */
export function getStravaRedirectUri() {
  // 1) An explicit STRAVA_REDIRECT_URI — accepted only if it is under an
  //    allowed production host (or localhost in explicit local dev).
  const explicit = parseOrigin(process.env.STRAVA_REDIRECT_URI);
  if (explicit) {
    if (ALLOWED_PROD_HOSTS.has(explicit.hostname)) {
      return describe(withCallbackPath(explicit), "STRAVA_REDIRECT_URI");
    }
    if (isLocalDevelopment() && LOCAL_HOSTS.has(explicit.hostname)) {
      // Honour the exact localhost callback the developer configured.
      const uri = `${explicit.origin}${CALLBACK_PATH}`;
      return describe(uri, "local-dev:STRAVA_REDIRECT_URI");
    }
    // Otherwise the value is stale/preview/unregistered → ignore it.
  }

  // 2) A generic app-origin env, accepted only if it is athlevo.org.
  for (const key of ["APP_URL", "SITE_URL", "PUBLIC_APP_URL"]) {
    const origin = parseOrigin(process.env[key]);
    if (origin && ALLOWED_PROD_HOSTS.has(origin.hostname)) {
      return describe(withCallbackPath(origin), key);
    }
  }

  // 3) Explicit local development fallback.
  if (isLocalDevelopment()) {
    const local =
      parseOrigin(process.env.APP_URL) ||
      parseOrigin("http://localhost:3000");
    return describe(`${local.origin}${CALLBACK_PATH}`, "local-dev-default");
  }

  // 4) Canonical production default — always a registered callback.
  return describe(`${CANONICAL_ORIGIN}${CALLBACK_PATH}`, "canonical-default");
}

function describe(uri, source) {
  const url = new URL(uri);
  return { uri, source, host: url.host, path: url.pathname };
}

// Where to send the athlete back to after the callback — the origin of the
// canonical redirect URI (so it always matches, and never the stale
// athlevo-ai.vercel.app).
export function getAppReturnOrigin() {
  try {
    return new URL(getStravaRedirectUri().uri).origin;
  } catch (error) {
    return CANONICAL_ORIGIN;
  }
}

// True when the resolved redirect URI is a real, registered production
// callback (used to decide whether it is safe to start OAuth at all).
export function isRedirectUriValid() {
  const { host } = getStravaRedirectUri();
  const hostname = host.split(":")[0];
  return ALLOWED_PROD_HOSTS.has(hostname) ||
    (isLocalDevelopment() && LOCAL_HOSTS.has(hostname));
}

export const STRAVA_CALLBACK_PATH = CALLBACK_PATH;
export const STRAVA_CANONICAL_ORIGIN = CANONICAL_ORIGIN;
