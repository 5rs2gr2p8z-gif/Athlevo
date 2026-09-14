/*
 * Athlevo — minimal client feature-flag helper.
 *
 * Not a new experimentation platform: this is a thin wrapper around the
 * PostHog client already loaded on the page (js/analytics.js / index.html),
 * plus a local override so a specific browser/session can be flipped on or
 * off without touching source or redeploying. Default is always OFF unless
 * explicitly enabled for that browser or by PostHog.
 *
 * Enable for THIS browser only (no code changes, no redeploy):
 *   localStorage.setItem("athlevo_ff_diagnostic_onboarding_v2", "1")
 * Disable again:
 *   localStorage.setItem("athlevo_ff_diagnostic_onboarding_v2", "0")
 * or
 *   localStorage.removeItem("athlevo_ff_diagnostic_onboarding_v2")
 *
 * Or via URL, once, and it "sticks" for that browser:
 *   https://app.example.com/?ff_diagnostic_onboarding_v2=1
 *   https://app.example.com/?ff_diagnostic_onboarding_v2=0
 *
 * If PostHog has a feature flag with the same key defined server-side,
 * that is consulted when there is no local override.
 */
(function (root) {
  "use strict";

  var OVERRIDE_PREFIX = "athlevo_ff_";

  function storageKey(flagName) {
    return OVERRIDE_PREFIX + String(flagName || "");
  }

  function readQueryOverride(flagName) {
    try {
      var params = new URL(root.location.href).searchParams;
      var key = "ff_" + flagName;
      if (!params.has(key)) return null;
      var raw = params.get(key);
      return raw === "1" || raw === "true" ? "1" : raw === "0" || raw === "false" ? "0" : null;
    } catch (e) {
      return null;
    }
  }

  /* A query-string override is applied once, persisted to localStorage for
   * that browser, then left alone — it does not need to be re-passed on
   * every page load and never touches the shared URL history entry. */
  function applyQueryOverrideIfPresent(flagName) {
    var fromQuery = readQueryOverride(flagName);
    if (fromQuery === null) return;
    try { root.localStorage.setItem(storageKey(flagName), fromQuery); } catch (e) {}
  }

  function localOverride(flagName) {
    applyQueryOverrideIfPresent(flagName);
    try {
      var raw = root.localStorage.getItem(storageKey(flagName));
      if (raw === "1") return true;
      if (raw === "0") return false;
      return null;
    } catch (e) {
      return null;
    }
  }

  function posthogFlag(flagName) {
    try {
      if (root.posthog && typeof root.posthog.isFeatureEnabled === "function") {
        var value = root.posthog.isFeatureEnabled(flagName);
        if (typeof value === "boolean") return value;
      }
    } catch (e) {}
    return null;
  }

  /*
   * isEnabled resolution order:
   *   1. explicit per-browser override (localStorage, settable via URL)
   *   2. PostHog server-side flag, if PostHog has an opinion
   *   3. default (false unless explicitly passed)
   */
  function isEnabled(flagName, defaultValue) {
    var override = localOverride(flagName);
    if (override !== null) return override;
    var remote = posthogFlag(flagName);
    if (remote !== null) return remote;
    return defaultValue === true;
  }

  function setOverride(flagName, enabled) {
    try { root.localStorage.setItem(storageKey(flagName), enabled ? "1" : "0"); } catch (e) {}
  }

  function clearOverride(flagName) {
    try { root.localStorage.removeItem(storageKey(flagName)); } catch (e) {}
  }

  root.AthlevoFeatureFlags = {
    isEnabled: isEnabled,
    setOverride: setOverride,
    clearOverride: clearOverride
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { isEnabled: isEnabled, setOverride: setOverride, clearOverride: clearOverride };
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
