/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Wearable Provider Abstraction  (Strava active; Terra dormant)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A WearableProvider is a pluggable adapter with a single, consistent
 *  contract so the coaching engine never needs to know which provider a
 *  workout came from — it only ever consumes normalized activities:
 *
 *    {
 *      key, label,
 *      available,             // shown/usable in production right now
 *      active,                // has a live integration wired
 *      enabled(),             // runtime gate (feature flag / config)
 *      connectionStyle,       // "oauth" | "widget" | "none"
 *      endpoints,             // connect / sync / callback / disconnect
 *      capabilities,          // hr / power / cadence / gps / calories / …
 *      normalize(raw),        // provider payload → Athlevo Workout
 *      errorMap(error),       // provider error → neutral { code, message }
 *      status(ctx)            // connection status descriptor for the UI
 *    }
 *
 *  Today STRAVA is the only active production provider and implements this
 *  interface. Terra is retained as a DORMANT adapter behind a disabled
 *  feature flag (WEARABLE_TERRA_ENABLED, default false) so it never runs or
 *  reads credentials in production. Future providers (Garmin, WHOOP, Apple
 *  Health, COROS, Polar, Fitbit, Suunto, Oura) are declared as
 *  not-yet-available metadata so a roadmap can exist without claiming they
 *  are usable. Adding a real integration later = one entry here; nothing
 *  downstream (normalization, storage, coaching) changes.
 *
 *  Pure and side-effect free at import: no env var is read until a method is
 *  called, so the app boots with no wearable credentials of any kind.
 */

import { mapStrava, mapTerra, mapIntervals } from "./normalizer.js";

// Runtime feature flag for Terra. Default OFF. Reading env lazily means an
// absent flag/credentials can never throw at import or boot.
export function isTerraEnabled() {
  return process.env.WEARABLE_TERRA_ENABLED === "true";
}

const FULL_CAPS = { hr: true, power: true, cadence: true, gps: true, calories: true, elevation: true, trainingLoad: true };

/*
 * Provider-neutral error contract. Every adapter maps its raw errors into
 * this shape so failure handling is identical across providers.
 */
export function mapProviderError(providerKey, error) {
  const msg = String((error && error.message) || error || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("429")) {
    return { code: "PROVIDER_RATE_LIMIT", message: "The provider is rate-limiting requests. Try again shortly.", retryable: true };
  }
  if (msg.includes("token") || msg.includes("unauthorized") || msg.includes("401")) {
    return { code: "PROVIDER_AUTH", message: "The connection needs to be re-authorised.", retryable: false };
  }
  if (msg.includes("network") || msg.includes("failed to fetch") || msg.includes("timeout")) {
    return { code: "PROVIDER_NETWORK", message: "Couldn't reach the provider. Check your connection and try again.", retryable: true };
  }
  return { code: "PROVIDER_SYNC_FAILED", message: "Sync didn't finish. Your existing data is unaffected — try again.", retryable: true };
}

const REGISTRY = new Map();
function registerProvider(p) { REGISTRY.set(p.key, p); return p; }

export function getProvider(key) { return REGISTRY.get(key) || null; }
export function listProviders() { return Array.from(REGISTRY.values()); }
export function availableProviders() { return listProviders().filter(p => p.available); }
export function activeProviders() { return listProviders().filter(p => p.active && p.enabled()); }

/* ─────────────────────── Strava (active provider) ───────────────────── */

registerProvider({
  key: "strava",
  label: "Strava",
  available: true,
  active: true,
  enabled: () => true,
  connectionStyle: "oauth",
  // The existing, working endpoints — NOT rewritten by the abstraction.
  endpoints: { connect: "/api/strava/connect", callback: "/api/strava/callback", sync: "/api/strava/sync", disconnect: null },
  capabilities: FULL_CAPS,
  normalize: mapStrava,
  errorMap: error => mapProviderError("strava", error),
  // Connection status descriptor for the connected-apps UI.
  status: (ctx) => ({
    provider: "strava",
    label: "Strava",
    connected: !!(ctx && ctx.connected),
    lastSync: (ctx && ctx.lastSync) || null,
    actions: (ctx && ctx.connected) ? ["sync", "disconnect"] : ["connect"]
  })
});

/* ─────────────────────── Terra (dormant, flagged) ───────────────────── */

registerProvider({
  key: "terra",
  label: "Terra",
  available: false,             // never surfaced to athletes
  active: false,                // no live integration in production
  enabled: isTerraEnabled,      // flag-gated; default false
  connectionStyle: "widget",
  isGateway: true,
  // Absorbed into the generic provider gateway; behaviour unchanged (404
  // unless WEARABLE_TERRA_ENABLED=true).
  endpoints: { connect: "/api/providers?provider=terra", webhook: "/api/providers?provider=terra" },
  capabilities: FULL_CAPS,
  normalize: mapTerra,          // the normalization work is preserved
  errorMap: error => mapProviderError("terra", error),
  // Devices Terra could gateway later — declared, not integrated now.
  devices: ["garmin", "whoop", "apple_health", "polar", "fitbit", "suunto", "coros", "oura"],
  status: () => ({ provider: "terra", connected: false, available: false })
});

/* ────────────────── Intervals.icu (active gateway provider) ─────────── */

/*
 * Intervals.icu is a GATEWAY: the athlete links Garmin / COROS / Polar /
 * Wahoo (or Strava) to Intervals.icu, and Athlevo reads one unified activity
 * schema back. This is the supported route for athletes who cannot connect
 * Strava directly. It is a peer of Strava, not a replacement — both can be
 * connected at once, and cross-provider deduplication keeps the workout
 * counted exactly once.
 *
 * Enabled only when OAuth credentials are configured, so an unconfigured
 * deployment simply doesn't offer it rather than failing at connect time.
 */
export function isIntervalsEnabled() {
  return Boolean(process.env.INTERVALS_CLIENT_ID && process.env.INTERVALS_CLIENT_SECRET);
}

registerProvider({
  key: "intervals",
  label: "Intervals.icu",
  // Athlete-facing copy — deliberately about outcome, not architecture.
  blurb: "Import training from supported platforms such as Garmin and COROS.",
  available: true,
  active: true,
  enabled: isIntervalsEnabled,
  connectionStyle: "oauth",
  isGateway: true,
  endpoints: {
    connect: "/api/providers?provider=intervals&action=connect",
    callback: "/api/providers?provider=intervals&action=callback",
    sync: "/api/providers?provider=intervals&action=sync",
    disconnect: "/api/providers?provider=intervals&action=disconnect"
  },
  capabilities: FULL_CAPS,
  normalize: mapIntervals,
  // Devices reachable THROUGH Intervals.icu. Declared for the UI copy only.
  devices: ["garmin", "coros", "polar", "wahoo", "suunto", "strava"],
  errorMap: error => mapProviderError("intervals", error),
  status: (ctx) => ({
    provider: "intervals",
    label: "Intervals.icu",
    connected: !!(ctx && ctx.connected),
    lastSync: (ctx && ctx.lastSync) || null,
    actions: (ctx && ctx.connected) ? ["sync", "disconnect"] : ["connect"]
  })
});

/* ─────── future providers (declared, not available / not active) ─────── */

["garmin", "whoop", "apple_health", "coros", "polar", "fitbit", "suunto", "oura"].forEach(key => {
  if (REGISTRY.has(key)) return;
  registerProvider({
    key,
    label: key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
    available: false,
    active: false,
    enabled: () => false,
    connectionStyle: "none",
    endpoints: {},
    capabilities: FULL_CAPS,
    normalize: null,            // no adapter yet; would arrive via a gateway
    errorMap: error => mapProviderError(key, error),
    status: () => ({ provider: key, connected: false, available: false })
  });
});

/*
 * Normalize a raw activity from a provider that HAS an adapter. Providers
 * without an adapter (declared-only) throw a clear error, so nothing is ever
 * silently mis-stored.
 */
export function normalizeFromProvider(key, raw) {
  const p = getProvider(key);
  if (!p) throw new Error(`Unknown wearable provider "${key}".`);
  if (typeof p.normalize !== "function") throw new Error(`Provider "${key}" has no active adapter.`);
  return p.normalize(raw);
}

/* ─────────────────────── conservative deduplication ─────────────────────
 *
 * Primary identity is (provider + external_id) — enforced at storage by the
 * activities upsert (on_conflict=source,external_activity_id). This helper
 * PREPARES a cross-source strategy for when the same activity might arrive
 * from two providers: it only flags a duplicate at HIGH confidence and never
 * merges aggressively. Not wired into the current single-provider flow.
 */
export function activityIdentity(row) {
  return { source: row.source, external_activity_id: row.external_activity_id };
}

export function isLikelyDuplicate(a, b) {
  if (!a || !b) return false;
  // Same provider + external id → definitively the same activity.
  if (a.source && b.source && a.source === b.source &&
      a.external_activity_id && a.external_activity_id === b.external_activity_id) {
    return true;
  }
  // Cross-source: only HIGH-confidence matches (same sport, start within
  // 5 min, duration within 5%, distance within 5%). Otherwise keep both.
  const sportA = String(a.sport_type || "").toLowerCase();
  const sportB = String(b.sport_type || "").toLowerCase();
  if (!sportA || sportA !== sportB) return false;
  const ta = Date.parse(a.start_date), tb = Date.parse(b.start_date);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > 5 * 60000) return false;
  const near = (x, y, tol) => {
    x = Number(x); y = Number(y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return false;
    return Math.abs(x - y) / Math.max(x, y) <= tol;
  };
  const durOk = near(a.moving_time_seconds, b.moving_time_seconds, 0.05);
  const distOk = near(a.distance_meters, b.distance_meters, 0.05);
  return durOk && distOk;
}

/* ──────────────── cross-provider duplicate resolution ────────────────
 *
 * An athlete may connect BOTH Strava and Intervals.icu, and the same real
 * Garmin/COROS workout can arrive through both. Athlevo must count it once.
 *
 * Two-tier evidence, strongest first:
 *
 *   1. PROVENANCE (certain). Intervals.icu tells us when an activity was
 *      pulled from Strava, and gives the Strava id. If that id matches an
 *      already-imported Strava row, the two are the same workout — no
 *      heuristics needed. This is the common case and it is exact.
 *
 *   2. FINGERPRINT (high confidence only). Same sport, start within 5 min,
 *      duration within 5%, distance within 5% — the existing isLikelyDuplicate
 *      test. Deliberately strict: two genuine same-day workouts (a morning
 *      easy run and an evening session) differ on start time by hours, so they
 *      are never collapsed. Anything short of high confidence keeps BOTH rows,
 *      because under-counting an athlete's training is worse than showing an
 *      extra activity they can see and judge for themselves.
 *
 * Nothing is ever deleted. The non-canonical row is flagged in raw_data and
 * filtered out at load, so provenance is fully preserved and the decision is
 * reversible by clearing one flag.
 */

// Exact-provenance match: does this Intervals row describe that Strava row?
export function isSameUpstreamActivity(a, b) {
  const idOf = (row) => {
    const rd = row && row.raw_data;
    const src = String((rd && rd.upstream_source) || "").toLowerCase();
    const uid = rd && rd.upstream_id;
    return (src === "strava" && uid) ? String(uid) : null;
  };
  const aStrava = String(a.source) === "strava" ? String(a.external_activity_id) : idOf(a);
  const bStrava = String(b.source) === "strava" ? String(b.external_activity_id) : idOf(b);
  return Boolean(aStrava && bStrava && aStrava === bStrava);
}

export function isCrossProviderDuplicate(a, b) {
  if (!a || !b) return false;
  // Never compare a row with itself, and never dedupe within one provider —
  // that is already guaranteed by the (source, external_activity_id) unique.
  if (a.source === b.source) return false;
  if (isSameUpstreamActivity(a, b)) return true;
  return isLikelyDuplicate(a, b);
}

/*
 * Canonical selection: RICHEST DATA WINS.
 *
 * Lap/interval structure is what unlocks Threshold and Speed recognition in
 * the canonical classifier, so the copy that has it is worth more to the
 * athlete than the copy that doesn't — regardless of which provider it came
 * from. Heart rate is the next tiebreak, then earliest import so the result
 * is deterministic and stable across re-syncs (a repeated sync can never
 * flip the winner back and forth).
 *
 * Returns { canonical, superseded }.
 */
export function chooseCanonical(a, b) {
  const score = (row) => {
    const rd = (row && row.raw_data) || {};
    let s = 0;
    if (Array.isArray(rd.laps) && rd.laps.length > 1) s += 100;  // structure
    if (row.average_heartrate != null) s += 10;                  // HR
    if (row.max_heartrate != null) s += 2;
    if (row.distance_meters != null) s += 1;
    return s;
  };
  const sa = score(a), sb = score(b);
  if (sa !== sb) return sa > sb ? { canonical: a, superseded: b } : { canonical: b, superseded: a };

  // Equal richness → deterministic tiebreak on import time, then on the
  // composite id, so the outcome never depends on row ordering.
  const ta = Date.parse(a.created_at || a.updated_at || "") || Infinity;
  const tb = Date.parse(b.created_at || b.updated_at || "") || Infinity;
  if (ta !== tb) return ta < tb ? { canonical: a, superseded: b } : { canonical: b, superseded: a };

  const ka = `${a.source}:${a.external_activity_id}`;
  const kb = `${b.source}:${b.external_activity_id}`;
  return ka <= kb ? { canonical: a, superseded: b } : { canonical: b, superseded: a };
}

/*
 * Given newly imported rows and the athlete's existing rows, decide which (if
 * any) should be marked superseded. Pure — returns instructions, performs no
 * I/O, so it is fully unit-testable and the caller controls every write.
 *
 * Returns [{ id, supersededBy, reason }].
 */
export function resolveDuplicates(incoming, existing) {
  const marks = [];
  const seen = new Set();
  for (const inc of incoming || []) {
    for (const ex of existing || []) {
      if (!ex.id || !inc.id || ex.id === inc.id) continue;
      if (seen.has(`${inc.id}:${ex.id}`)) continue;
      if (!isCrossProviderDuplicate(inc, ex)) continue;
      seen.add(`${inc.id}:${ex.id}`);
      seen.add(`${ex.id}:${inc.id}`);
      const { canonical, superseded } = chooseCanonical(inc, ex);
      marks.push({
        id: superseded.id,
        supersededBy: `${canonical.source}:${canonical.external_activity_id}`,
        reason: isSameUpstreamActivity(inc, ex) ? "upstream_id_match" : "fingerprint_match"
      });
    }
  }
  return marks;
}

export const PROVIDER_REGISTRY_VERSION = "wearable-providers-v3";
