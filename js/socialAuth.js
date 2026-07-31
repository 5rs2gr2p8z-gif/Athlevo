/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Social authentication (Google; Apple gated)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Wraps Supabase OAuth. Deliberately thin: Supabase owns the token
 *  exchange, session persistence and refresh. This file owns only the
 *  athlete-facing parts — starting the flow, reading the outcome off the
 *  return URL, and turning any failure into something a person can act on.
 *
 *  Nothing here creates or reads a profile row. Profile creation stays where
 *  it already is (obLoadProfile), which is idempotent and duplicate-safe, so
 *  a Google athlete and an email athlete converge on exactly one code path.
 *
 *  A provider is only ever offered when it is actually configured. A button
 *  that fails the moment it is pressed is worse than no button.
 */

(function (root) {
  "use strict";

  const sb = () => (typeof supabaseClient !== "undefined" ? supabaseClient : null);

  /*
   * Which providers are live.
   *
   * Apple is intentionally FALSE. It requires a paid Apple Developer
   * account, an App ID + Services ID, a private key, and a generated client
   * secret that expires every 6 months — none of which exists yet. Shipping
   * a visible Apple button before that is done guarantees an immediate
   * failure for anyone who taps it.
   */
  const PROVIDERS = {
    google: { enabled: true,  label: "Google" },
    apple:  { enabled: false, label: "Apple" }
  };

  function trackSignupFailure(category) {
    try {
      if (root.AthlevoProductAnalytics) {
        root.AthlevoProductAnalytics.trackAthlevoEvent("signup_failed", {
          stage: "auth_start",
          failure_category: category || "unknown",
          provider: "google",
          source_surface: "auth"
        });
      }
    } catch (e) {}
  }

  /*
   * Where Supabase sends the athlete back to.
   *
   * MUST be on the Supabase redirect allow-list, and MUST match the origin
   * the athlete started from — otherwise the session lands on a domain that
   * cannot read it. We use the CURRENT origin (so localhost and Vercel
   * previews work) but fall back to the canonical production URL, which is
   * the only origin guaranteed to be allow-listed.
   */
  function redirectTarget() {
    if (root.AthlevoRuntime && root.AthlevoRuntime.isNativeIOS()) {
      return root.AthlevoRuntime.authRedirectUrl();
    }
    try {
      const origin = window.location.origin;
      // A file:// or opaque origin cannot receive a redirect — use canonical.
      if (origin && /^https?:/.test(origin)) return origin + "/";
    } catch (e) { /* fall through */ }
    return (root.AthlevoEnv && root.AthlevoEnv.canonicalUrl
      ? root.AthlevoEnv.canonicalUrl() : "https://athlevo.org") + "/";
  }

  /* ═══════════════════════ starting the flow ═══════════════════════ */

  async function signInWithProvider(providerKey) {
    const provider = PROVIDERS[providerKey];
    if (!provider || !provider.enabled) {
      return { ok: false, message: `${provider ? provider.label : "That"} sign-in isn't available yet.` };
    }
    const client = sb();
    let loggedOut = true;
    if (client) {
      try {
        const { data } = await client.auth.getSession();
        loggedOut = !(data && data.session && data.session.user);
      } catch (e) { /* absence of a readable session is logged-out intent */ }
    }

    if (providerKey === "google" && loggedOut && root.AthlevoProductAnalytics) {
      root.AthlevoProductAnalytics.trackAthlevoEvent("google_signup_clicked");
      root.AthlevoProductAnalytics.beginSignupIntent("google");
    }

    if (!client) {
      try { if (root.AthlevoProductAnalytics) root.AthlevoProductAnalytics.clearSignupIntent(); } catch (e) {}
      if (loggedOut) trackSignupFailure("unavailable");
      return { ok: false, message: "Sign-in is unavailable right now. Please try again." };
    }

    /*
     * In-app browsers (Instagram, Facebook, TikTok) block the third-party
     * cookies and popups OAuth needs. The existing environment helper
     * already detects this for Strava; reuse it rather than letting the
     * athlete fail silently inside a webview.
     */
    if (root.AthlevoEnv &&
        typeof root.AthlevoEnv.guardSignupHandoff === "function" &&
        root.AthlevoEnv.guardSignupHandoff("signup", "auth")) {
      try { if (root.AthlevoProductAnalytics) root.AthlevoProductAnalytics.clearSignupIntent(); } catch (e) {}
      return { ok: false, handled: true };
    }
    if (root.AthlevoEnv && root.AthlevoEnv.shouldWarn && root.AthlevoEnv.shouldWarn()) {
      if (root.AthlevoEnv.showNotice) {
        root.AthlevoEnv.showNotice({
          context: "signup",
          intent: "signup",
          sourceSurface: "auth"
        });
      }
      try { if (root.AthlevoProductAnalytics) root.AthlevoProductAnalytics.clearSignupIntent(); } catch (e) {}
      return { ok: false, handled: true };
    }

    try {
      const nativeIOS = Boolean(
        root.AthlevoRuntime && root.AthlevoRuntime.isNativeIOS()
      );
      const { data, error } = await client.auth.signInWithOAuth({
        provider: providerKey,
        options: {
          redirectTo: redirectTarget(),
          skipBrowserRedirect: nativeIOS,
          // Ask Google for a refresh token and always show the account
          // chooser, so an athlete on a shared device is never silently
          // signed into someone else's account.
          queryParams: providerKey === "google"
            ? { access_type: "offline", prompt: "select_account" }
            : undefined
        }
      });

      if (error) {
        try { if (root.AthlevoProductAnalytics) root.AthlevoProductAnalytics.clearSignupIntent(); } catch (e) {}
        if (loggedOut) {
          const detail = String(error && error.message || "").toLowerCase();
          trackSignupFailure(
            detail.includes("redirect") ? "configuration" : "provider"
          );
        }
        console.warn("OAuth start failed:", error.name || "error");
        return { ok: false, message: describeStartFailure(error) };
      }
      if (nativeIOS) {
        if (!data || !data.url || !root.AthlevoRuntime.openOAuth) {
          if (loggedOut) trackSignupFailure("unavailable");
          return { ok: false, message: "We couldn't open Google sign-in. Please try again." };
        }
        const opened = await root.AthlevoRuntime.openOAuth(data.url);
        if (!opened || opened.ok !== true) {
          if (loggedOut) trackSignupFailure("browser");
          return { ok: false, message: "We couldn't open Google sign-in. Please try again." };
        }
      }
      // Success navigates away; nothing after this runs.
      return { ok: true, redirecting: true };
    } catch (error) {
      try { if (root.AthlevoProductAnalytics) root.AthlevoProductAnalytics.clearSignupIntent(); } catch (e) {}
      if (loggedOut) trackSignupFailure("network");
      console.warn("OAuth start threw:", error && error.name);
      return { ok: false, message: "We couldn't reach the sign-in service. Check your connection and try again." };
    }
  }

  function describeStartFailure(error) {
    const msg = String((error && error.message) || "").toLowerCase();
    // The single most likely misconfiguration, phrased for a person.
    if (msg.includes("provider") && (msg.includes("not enabled") || msg.includes("unsupported"))) {
      return "Google sign-in isn't switched on yet. Please use email and password for now.";
    }
    if (msg.includes("redirect")) {
      return "Sign-in isn't configured for this address. Please open athlevo.org and try again.";
    }
    return "We couldn't start Google sign-in. Please try again, or use email and password.";
  }

  /* ═══════════════════ reading the return outcome ══════════════════ */

  /*
   * Supabase (detectSessionInUrl) consumes the auth parameters itself. Our
   * job is only to notice a FAILED return and say something useful, then
   * strip the parameters so a refresh doesn't replay the error.
   *
   * Errors can arrive in the query string OR the hash fragment depending on
   * flow type, so both are checked.
   */
  function readReturnError() {
    let params = null;
    try {
      const search = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
      const err = search.get("error") || hash.get("error");
      if (!err) return null;
      params = {
        error: err,
        code: search.get("error_code") || hash.get("error_code") || "",
        description: search.get("error_description") || hash.get("error_description") || ""
      };
    } catch (e) {
      return null;
    }

    const raw = `${params.error} ${params.code} ${params.description}`.toLowerCase();

    // The athlete changed their mind. Not an error — don't treat it as one.
    if (/access_denied|cancel|user_denied/.test(raw)) {
      return {
        cancelled: true,
        failureCategory: "cancelled",
        message: "Sign-in cancelled."
      };
    }
    if (/server_error|temporarily/.test(raw)) {
      return {
        failureCategory: "provider",
        message: "Google is having trouble right now. Please try again in a moment."
      };
    }
    if (/redirect|invalid_request|bad_oauth/.test(raw)) {
      return {
        failureCategory: "configuration",
        message: "Sign-in isn't configured for this address. Please open athlevo.org and try again."
      };
    }
    if (/expired|invalid_grant|otp_expired/.test(raw)) {
      return {
        failureCategory: "invalid_state",
        message: "That sign-in link expired. Please try signing in again."
      };
    }
    return {
      failureCategory: "unknown",
      message: "We couldn't complete sign-in. Please try again, or use email and password."
    };
  }

  // Remove auth parameters from the address bar without touching app state.
  function clearAuthParams() {
    try {
      const url = new URL(window.location.href);
      ["error", "error_code", "error_description", "code", "state", "provider_token"]
        .forEach(k => url.searchParams.delete(k));
      const hash = String(url.hash || "");
      const cleanHash = /access_token|error|refresh_token|provider_token/.test(hash) ? "" : hash;
      window.history.replaceState({}, "", url.pathname + url.search + cleanHash);
    } catch (e) { /* non-fatal */ }
  }

  // True when this page load looks like a return from an OAuth redirect.
  function isOAuthReturn() {
    try {
      const s = window.location.search || "";
      const h = window.location.hash || "";
      return /[?&](code|error)=/.test(s) || /access_token=|[#&]error=/.test(h);
    } catch (e) { return false; }
  }

  /* ═════════════════════════ UI surface ════════════════════════════ */

  /*
   * Hide any provider button that is not configured. Called on boot so a
   * disabled provider never renders, rather than rendering and failing.
   */
  function applyProviderVisibility() {
    Object.keys(PROVIDERS).forEach(key => {
      const el = document.getElementById(`authBtn${key.charAt(0).toUpperCase()}${key.slice(1)}`);
      if (el) el.style.display = PROVIDERS[key].enabled ? "" : "none";
    });
  }

  root.AthlevoSocialAuth = {
    PROVIDERS,
    signInWithProvider,
    signInWithGoogle: () => signInWithProvider("google"),
    signInWithApple: () => signInWithProvider("apple"),
    readReturnError,
    clearAuthParams,
    isOAuthReturn,
    applyProviderVisibility,
    redirectTarget
  };
})(typeof window !== "undefined" ? window : globalThis);
