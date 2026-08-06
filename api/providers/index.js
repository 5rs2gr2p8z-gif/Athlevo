/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Generic training-data provider gateway
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ONE serverless function serving every non-Strava provider, routed by
 *  ?provider=<key>&action=<connect|callback|sync|disconnect|status>.
 *
 *  Why one function: Vercel Hobby allows 12 serverless functions and Athlevo
 *  uses 11. Three separate Intervals endpoints would break the deploy, so
 *  this file replaces the DORMANT api/terra/index.js (which had no UI, no
 *  webhook and a default-off flag) and keeps the count at 11 with one spare.
 *
 *  Strava is deliberately NOT routed here. Its connect/callback/sync flow is
 *  live, working and athlete-facing; moving it would risk a working feature
 *  for no benefit. Both providers write the same normalized `activities`
 *  rows, so the coaching engine cannot tell them apart — which is the point.
 *
 *  Security posture:
 *    · client secret and access tokens are read/written server-side only and
 *      are never returned to the browser or written to a log
 *    · OAuth state is HMAC-signed, bound to the Athlevo user, and expires
 *    · one external provider account cannot be linked to two Athlevo accounts
 *    · every log line is structured, correlated, and free of tokens/codes
 */

import crypto from "node:crypto";
// Beta analytics aggregation (admin_analytics action). Folded into this
// gateway so the founder dashboard does not consume a separate Vercel
// serverless slot — keeping the Whop webhook within the Hobby 12-fn limit.
import {
  buildFunnel, computeRetention, activeUsers, classifySegments, topline, recentFailures
} from "../../lib/server/analyticsAggregation.js";

/* ──────────────────── Coach Dashboard imports ─────────────────────────
 * Consolidated from the former api/coach-dashboard.js (removed to stay
 * within the Vercel Hobby 12-function limit). Actions are namespaced as
 * coaching_dashboard_roster, coaching_dashboard_athlete, coaching_dashboard_review.
 */
import { canAccessCoachDashboard, resolveRole } from "../../lib/server/coachRoles.js";
import {
  assignedAthleteIds,
  canCoachAccessAthlete
} from "../../lib/server/coachAssignments.js";
import { classifyAttention } from "../../lib/server/attentionClassifier.js";
import {
  buildRosterEntry,
  buildAthleteOverview,
  deriveLastActiveAt
} from "../../lib/server/coachSanitize.js";

/* ──────────────────── Athlete Mode imports ─────────────────────────────
 * Consolidated from the former api/athlete-mode.js (removed to stay
 * within the Vercel Hobby 12-function limit). Actions are namespaced as
 * athlete_coaching_mode, athlete_request_adjustment.
 */
import { resolveCoachingMode, buildSafeCoachProfile } from "../../lib/server/coachingMode.js";
import { stripClientAuthorityFields } from "../../lib/server/planAuthority.js";
import { mapIntervals, normalizeIntervalLaps, toActivityRow, buildRecognitionFromRow, RECOGNITION_VERSION, isCurrentRecognitionVersion } from "../../lib/server/wearable/normalizer.js";
import { resolveDuplicates, mapProviderError, isIntervalsEnabled } from "../../lib/server/wearable/providers.js";
import {
  INTERVALS_AUTHORIZE_URL,
  INTERVALS_TOKEN_URL,
  INTERVALS_API_BASE,
  INTERVALS_SCOPE,
  getIntervalsRedirectUri,
  getAppReturnOrigin,
  isIntervalsConfigured
} from "../../lib/server/wearable/intervalsConfig.js";
import {
  createOAuthState,
  verifyOAuthState
} from "../../lib/server/oauthState.js";
import { makeWhopClient } from "../../lib/server/whopClient.js";
import {
  buildProviderTrendsResponse,
  dateRangeForTrends
} from "../../lib/server/providerTrends.js";
import { requirePaidAccess } from "../../lib/server/freemium.js";

/* ───────────────────────────── logging ──────────────────────────────── */

/*
 * Structured, privacy-safe logs. The allowlist below is the ONLY thing that
 * can ever be logged — tokens, codes, secrets and activity payloads are not
 * on it, so they cannot leak through a careless call site.
 */
const LOG_SAFE = new Set([
  "event", "correlationId", "provider", "status", "code", "httpStatus",
  "imported", "skipped", "failed", "duplicatesMarked", "windows",
  "durationMs", "reason", "hasLaps", "oldest", "newest",
  // Import diagnostics: counts and shape only — never activity values.
  "returnedByApi", "unparseableWindows", "count", "scanned", "analyzed",
  /*
   * Post-consent callback diagnostics. Booleans, statuses and ORIGINS only.
   * The authorization code, tokens, client secret, signed-state contents and
   * completion token are deliberately absent and must stay absent.
   */
  "invoked", "method", "pathname", "action", "hasCode", "hasState", "hasError",
  "stateValid", "tokenExchangeAttempted", "tokenHttpStatus",
  "pendingWriteAttempted", "pendingWriteOk", "pendingHttpStatus",
  "finalRedirectState", "returnOrigin", "redirectUriOrigin",
  "redirectUriSource", "originsMatch",
  // Ownership outcomes only. Raw Athlevo/provider identifiers are forbidden.
  "ownerExistsInAuth",
  "ownershipDecision", "ownershipLookupOk", "pendingRow"
]);

function log(event, fields = {}) {
  const safe = { event };
  for (const [k, v] of Object.entries(fields)) if (LOG_SAFE.has(k)) safe[k] = v;
  console.log(JSON.stringify(safe));
}

function newCorrelationId() {
  return crypto.randomBytes(8).toString("hex");
}

/* ──────────────────────────── supabase ──────────────────────────────── */

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function getAuthenticatedUser(accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing.");
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: key }
  });
  if (!res.ok) return null;
  return res.json();
}

async function requireUser(request) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  return getAuthenticatedUser(token);
}

/* ──────────────────── provider_accounts persistence ─────────────────── */

async function readProviderAccount(userId, provider) {
  const url = process.env.SUPABASE_URL;
  const res = await fetch(
    `${url}/rest/v1/provider_accounts?user_id=eq.${encodeURIComponent(userId)}` +
    `&provider=eq.${encodeURIComponent(provider)}&limit=1`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// Who (if anyone) already owns this external provider account?
//
// AUTHORITATIVE by construction. Only a live connection matches: actionDisconnect
// nulls provider_athlete_id when an athlete disconnects, so a disconnected row can
// never be returned here. A hit therefore means "some Athlevo account still holds a
// real connection to this Intervals identity" — which is exactly the claim the
// ALREADY_LINKED guard is allowed to act on. Selects user_id ONLY; no token leaves
// the database.
async function findOwnerByProviderAthlete(provider, athleteId) {
  const url = process.env.SUPABASE_URL;
  try {
    const res = await fetch(
      `${url}/rest/v1/provider_accounts?provider=eq.${encodeURIComponent(provider)}` +
      `&provider_athlete_id=eq.${encodeURIComponent(String(athleteId))}&select=user_id&limit=1`,
      { headers: sbHeaders() }
    );
    if (!res.ok) return { ok: false, userId: null };
    const rows = await res.json();
    return { ok: true, userId: rows[0] ? String(rows[0].user_id) : null };
  } catch {
    return { ok: false, userId: null };
  }
}

/*
 * Does this Athlevo user still exist in auth.users?
 *
 * This is the line between "another ACTIVE account owns the athlete" (refuse) and
 * "a dead/orphaned account left a claim behind" (reclaimable). Uses the GoTrue
 * admin endpoint with the service role — the user object never leaves the server
 * and is never logged.
 *
 * FAIL CLOSED. Reclaim is permitted ONLY on a definitive 404. Any other outcome
 * (200, 5xx, network error, malformed) is treated as "still exists" so an
 * uncertain lookup can never relink a live account to a second user.
 *
 * `obs` is an OBSERVABILITY SINK ONLY. It records whether the lookup was
 * definitive, because the returned boolean deliberately collapses "exists"
 * and "could not tell" into the same fail-closed `true`. Writing to it
 * changes no branch and no return value.
 */
async function authUserExists(userId, obs) {
  const url = process.env.SUPABASE_URL;
  if (!userId) return false;
  try {
    const res = await fetch(
      `${url}/auth/v1/admin/users/${encodeURIComponent(String(userId))}`,
      { headers: sbHeaders() }
    );
    if (obs) obs.ownerExistsInAuth = res.status === 404 ? false : (res.ok ? true : "unknown");
    if (res.status === 404) return false;   // the ONLY signal that permits reclaim
    return true;                            // exists, or unknown → treat as active
  } catch {
    if (obs) obs.ownerExistsInAuth = "unknown";
    return true;                            // unknown → never reclaim
  }
}

/*
 * Ownership decision for one Intervals identity and one claiming Athlevo user.
 * Pure policy over the two lookups above; performs no writes. Returns:
 *
 *   { ok:false }                    → the ownership lookup itself failed (retry later)
 *   { ok:true, decision:'clear' }   → no authoritative owner → the claimant may take it
 *   { ok:true, decision:'self' }    → the claimant already owns it → reconnect
 *   { ok:true, decision:'blocked' } → another ACTIVE account owns it → ALREADY_LINKED
 *   { ok:true, decision:'reclaim', staleUserId }
 *                                   → the only owner is orphaned (gone from
 *                                     auth.users) → the claimant may reclaim it
 *
 * `obs` is an OBSERVABILITY SINK ONLY — it records the two lookup results and
 * the resulting label so a call site can log WHY a decision came out the way it
 * did. It is never read back here and influences no branch.
 */
async function decideOwnership(provider, athleteId, claimantUserId, obs) {
  const owner = await findOwnerByProviderAthlete(provider, athleteId);
  if (obs) {
    obs.ownershipLookupOk = owner.ok;
    obs.ownerUserId = owner.ok ? (owner.userId || null) : null;
    obs.ownerExistsInAuth = "not_checked";
    obs.ownershipDecision = null;
  }
  if (!owner.ok) return { ok: false };
  if (!owner.userId) {
    if (obs) { obs.ownerExistsInAuth = null; obs.ownershipDecision = "clear"; }
    return { ok: true, decision: "clear" };
  }
  if (owner.userId === String(claimantUserId)) {
    if (obs) obs.ownershipDecision = "self";
    return { ok: true, decision: "self" };
  }
  // A different account holds the authoritative row. It may block ONLY if that
  // account still exists; an orphaned row must never freeze the athlete forever.
  const prevExists = await authUserExists(owner.userId, obs);
  if (obs) obs.ownershipDecision = prevExists ? "blocked" : "reclaim";
  return prevExists
    ? { ok: true, decision: "blocked" }
    : { ok: true, decision: "reclaim", staleUserId: owner.userId };
}

/*
 * Remove an orphaned provider_accounts claim so one Intervals identity is never
 * owned by two rows. Called ONLY after decideOwnership() has proven the owner is
 * gone from auth.users. Scoped to (provider, athlete, the specific stale user),
 * so a live connection can never be touched. return=minimal → no token is read
 * back. (Deleting the auth.users row would normally cascade this away; this is
 * the belt-and-braces path for a claim that outlived its owner.)
 */
async function releaseOrphanedOwnership(provider, athleteId, staleUserId) {
  if (!staleUserId) return false;
  const url = process.env.SUPABASE_URL;
  try {
    const res = await fetch(
      `${url}/rest/v1/provider_accounts?provider=eq.${encodeURIComponent(provider)}` +
      `&provider_athlete_id=eq.${encodeURIComponent(String(athleteId))}` +
      `&user_id=eq.${encodeURIComponent(String(staleUserId))}`,
      { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=minimal" } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/*
 * Sweep abandoned pending handoffs for this Intervals identity that belong to a
 * DIFFERENT account than the one now connecting. A never-finalized attempt from
 * another user (the i652649 / 281d9a23 orphan) has no authority — it is not a
 * connection — so it must never linger as a phantom claim. The claimant's own
 * fresh pending row is left untouched. Best-effort; never blocks the flow.
 */
async function purgeForeignPendingForAthlete(provider, athleteId, keepUserId) {
  const url = process.env.SUPABASE_URL;
  try {
    await fetch(
      `${url}/rest/v1/pending_provider_connections?provider=eq.${encodeURIComponent(provider)}` +
      `&provider_athlete_id=eq.${encodeURIComponent(String(athleteId))}` +
      `&user_id=neq.${encodeURIComponent(String(keepUserId))}`,
      { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=minimal" } }
    );
  } catch (e) { /* housekeeping only */ }
}


async function upsertProviderAccount(row) {
  const url = process.env.SUPABASE_URL;
  const res = await fetch(
    `${url}/rest/v1/provider_accounts?on_conflict=user_id,provider`,
    {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }])
    }
  );
  if (!res.ok) {
    // Previously this returned a bare false, so a schema/constraint rejection
    // was indistinguishable from a network failure.
    let code = "";
    try {
      const body = await res.json();
      code = String(body && body.code || "").slice(0, 12);   // e.g. "42P10", "42703"
    } catch (e) {}
    log("provider_write_failed", { provider: row.provider, httpStatus: res.status, code });
  }
  return res.ok;
}

async function patchProviderAccount(id, patch) {
  const url = process.env.SUPABASE_URL;
  const res = await fetch(`${url}/rest/v1/provider_accounts?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
  return res.ok;
}


/* ═══════════════ pending connections (secure OAuth handoff) ══════════ */

/*
 * The provider callback cannot authenticate the browser — a redirect from
 * Intervals.icu carries no Supabase Bearer token. So credentials are parked
 * here, encrypted, and promoted to provider_accounts only by an authenticated
 * finalize call whose user.id matches the account that started the flow.
 */

const PENDING_TTL_MS = 8 * 60 * 1000;   // 8 minutes: long enough to sign in again

/*
 * Derived from OAUTH_STATE_SECRET with a distinct info string, so encryption
 * and state-signing never share key material and no new env var is required.
 * PROVIDER_ENCRYPTION_KEY overrides it if operators prefer a separate key.
 */
function encryptionKey() {
  const explicit = process.env.PROVIDER_ENCRYPTION_KEY;
  if (explicit) return crypto.createHash("sha256").update(explicit).digest();
  const base = process.env.OAUTH_STATE_SECRET;
  if (!base) throw new Error("Server encryption secret is not configured.");
  return crypto.hkdfSync("sha256", Buffer.from(base, "utf8"),
    Buffer.alloc(0), Buffer.from("athlevo:provider:pending:v1", "utf8"), 32);
}

function encryptPayload(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(encryptionKey()), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"),
          ct.toString("base64url")].join(".");
}

/*
 * Returns null on ANY tampering. GCM's auth tag makes a modified ciphertext
 * throw rather than decrypt to attacker-chosen plaintext.
 */
function decryptPayload(packed) {
  try {
    const [ivB, tagB, ctB] = String(packed).split(".");
    if (!ivB || !tagB || !ctB) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(encryptionKey()),
      Buffer.from(ivB, "base64url"));
    d.setAuthTag(Buffer.from(tagB, "base64url"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8"));
  } catch { return null; }
}

// The DB stores only the hash; the raw token lives in the URL and nowhere else.
const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

async function createPendingConnection({ userId, provider, athleteId, credentials }) {
  const url = process.env.SUPABASE_URL;
  const raw = crypto.randomBytes(32).toString("base64url");
  const res = await fetch(`${url}/rest/v1/pending_provider_connections`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify([{
      token_hash: hashToken(raw),
      user_id: userId,
      provider,
      provider_athlete_id: String(athleteId),
      payload_encrypted: encryptPayload(credentials),
      expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString()
    }])
  });
  if (!res.ok) {
    // A missing table, a schema mismatch and a network fault are all invisible
    // behind a bare null. Machine code and status only — never the payload.
    let code = "";
    try { const b = await res.json(); code = String((b && b.code) || "").slice(0, 12); }
    catch (e) {}
    log("intervals_pending_write_failed", {
      provider, pendingHttpStatus: res.status, code, pendingWriteOk: false
    });
  }
  return res.ok ? raw : null;
}

/*
 * ATOMIC single-use consume.
 *
 * The `consumed_at=is.null` filter is what makes this replay- and race-safe:
 * Postgres serialises the two UPDATEs, so of N concurrent finalize calls
 * exactly one matches an unconsumed row and the rest come back empty. The
 * check is done BY THE DATABASE, not by a read-then-write in JS.
 */
async function consumePendingConnection(rawToken) {
  const url = process.env.SUPABASE_URL;
  const res = await fetch(
    `${url}/rest/v1/pending_provider_connections` +
    `?token_hash=eq.${encodeURIComponent(hashToken(rawToken))}&consumed_at=is.null`,
    {
      method: "PATCH",
      headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ consumed_at: new Date().toISOString() })
    }
  );
  if (!res.ok) return { ok: false, code: "LOOKUP_FAILED" };
  const rows = await res.json();
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  // Absent, already consumed, or never existed — all indistinguishable by
  // design, so a probe cannot tell a used token from a forged one.
  if (!row) return { ok: false, code: "COMPLETION_INVALID" };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, code: "COMPLETION_EXPIRED" };
  }
  const credentials = decryptPayload(row.payload_encrypted);
  if (!credentials) return { ok: false, code: "COMPLETION_INVALID" };
  return { ok: true, row, credentials };
}

// Best-effort housekeeping; never blocks or fails a request.
async function purgeExpiredPending() {
  const url = process.env.SUPABASE_URL;
  try {
    await fetch(
      `${url}/rest/v1/pending_provider_connections?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
      { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=minimal" } });
  } catch (e) { /* housekeeping only */ }
}

/*
 * Delete a specific consumed pending row by its id. Called ONLY after the
 * provider_accounts upsert succeeds — if the upsert fails the consumed row
 * stays so an operator can investigate (it is already burned and cannot be
 * replayed). Best-effort: a failed delete is harmless because purgeExpired
 * will catch it later once it passes its TTL.
 */
async function deletePendingConnection(rowId) {
  if (!rowId) return;
  const url = process.env.SUPABASE_URL;
  try {
    await fetch(
      `${url}/rest/v1/pending_provider_connections?id=eq.${encodeURIComponent(rowId)}`,
      { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=minimal" } });
  } catch (e) { /* best-effort */ }
}

/* ───────────────────────── activity persistence ─────────────────────── */

/*
 * Upsert on (source, external_activity_id) — the SAME identity Strava uses.
 * Re-importing an activity updates it in place, so repeated syncs are
 * idempotent and can never create a second copy of the same activity.
 */
async function saveActivities(rows) {
  if (!rows.length) return [];
  const url = process.env.SUPABASE_URL;
  const res = await fetch(
    `${url}/rest/v1/activities?on_conflict=source,external_activity_id`,
    {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(rows)
    }
  );
  if (!res.ok) throw new Error(`Could not save imported activities (${res.status}).`);
  return res.json();
}

// Existing rows in the same time window, for cross-provider matching.
async function loadNeighbourActivities(userId, oldestIso, newestIso) {
  const url = process.env.SUPABASE_URL;
  const res = await fetch(
    `${url}/rest/v1/activities?user_id=eq.${encodeURIComponent(userId)}` +
    `&start_date=gte.${encodeURIComponent(oldestIso)}` +
    `&start_date=lte.${encodeURIComponent(newestIso)}` +
    `&select=id,source,external_activity_id,sport_type,start_date,distance_meters,` +
    `moving_time_seconds,average_heartrate,max_heartrate,created_at,updated_at,raw_data`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/*
 * Flags a duplicate WITHOUT deleting it. The row keeps all of its data and
 * provenance; it is simply excluded from training totals at load time. One
 * flag cleared restores it, so this decision is always reversible.
 */
async function markSuperseded(rowId, existingRawData, supersededBy, reason) {
  const url = process.env.SUPABASE_URL;
  const raw = { ...(existingRawData || {}), superseded: true, superseded_by: supersededBy, superseded_reason: reason };
  const res = await fetch(`${url}/rest/v1/activities?id=eq.${encodeURIComponent(rowId)}`, {
    method: "PATCH",
    headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({ raw_data: raw, updated_at: new Date().toISOString() })
  });
  return res.ok;
}

/* ─────────────────────── Intervals.icu API calls ────────────────────── */

/*
 * Every Intervals.icu call goes through here. `meta` is an optional sink that
 * records what actually happened on the wire (status, shape, count) so a
 * "returned nothing" outcome can be told apart from a "returned something we
 * failed to parse" outcome. Never records the token or any activity values.
 */
async function intervalsFetch(path, accessToken, meta) {
  const res = await fetch(`${INTERVALS_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
  });
  if (meta) {
    meta.httpStatus = res.status;
    meta.contentType = res.headers.get("content-type") || null;
  }
  /*
   * 401 and 403 mean DIFFERENT things and must not be conflated.
   *
   *   401 Unauthorized → the credential is bad, missing or revoked. The
   *                      athlete must reconnect. This is a token problem.
   *   403 Forbidden    → the credential is VALID but not permitted to touch
   *                      this resource. On Intervals.icu that is normally a
   *                      missing scope: Athlevo requests activity + wellness
   *                      reads, so settings endpoints legitimately return 403.
   *
   * Treating 403 as an expired token is what made a healthy connection look
   * broken. Only 401 may flip an account to reconnect_required.
   */
  if (res.status === 401) {
    const err = new Error("unauthorized");
    err.authExpired = true;
    throw err;
  }
  if (res.status === 403) {
    const err = new Error("forbidden");
    err.forbidden = true;   // insufficient scope — NOT a credential failure
    throw err;
  }
  if (res.status === 429) {
    const err = new Error("rate limit");
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    // Capture a truncated body so a 4xx/5xx reason is visible instead of
    // collapsing to a bare status code.
    if (meta) {
      try { meta.errorBody = (await res.text()).slice(0, 300); } catch (e) {}
    }
    throw new Error(`Intervals.icu request failed (${res.status}).`);
  }

  const body = await res.json();
  if (meta) {
    meta.isArray = Array.isArray(body);
    meta.count = Array.isArray(body) ? body.length : null;
    // Shape only — the KEYS of the response, never the values. Enough to spot
    // a wrapped payload (e.g. {activities:[…]}) without leaking training data.
    if (!Array.isArray(body) && body && typeof body === "object") {
      meta.objectKeys = Object.keys(body).slice(0, 20);
    }
    /*
     * An EMPTY array and an unexpected 200 payload both produced count 0 and
     * were indistinguishable. Record a short raw sample so "Intervals really
     * returned []" can be told apart from "Intervals returned something we
     * did not parse". Truncated; contains no tokens.
     */
    if (Array.isArray(body) && body.length === 0) {
      meta.rawSample = JSON.stringify(body).slice(0, 120);
    }
  }
  return body;
}

/*
 * Intervals.icu documents athlete id "0" as "the athlete this token belongs
 * to". We prefer it, but fall back to the id captured at OAuth time if a
 * probe with "0" comes back empty — cheap insurance against the shorthand
 * behaving differently for third-party OAuth tokens than for personal keys.
 */
function activitiesPath(athleteId, oldest, newest) {
  return `/athlete/${encodeURIComponent(athleteId)}/activities` +
    `?oldest=${oldest}&newest=${newest}`;
}

function wellnessPath(athleteId, oldest, newest) {
  return `/athlete/${encodeURIComponent(athleteId)}/wellness` +
    `?oldest=${oldest}&newest=${newest}`;
}

function accountHasScope(account, requiredScope) {
  const granted = String(account && account.scope || "")
    .split(/[\s,]+/)
    .map(scope => scope.trim().toUpperCase())
    .filter(Boolean);
  return granted.includes(String(requiredScope).toUpperCase());
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/*
 * Interval/lap structure. Intervals.icu computes detected intervals per
 * activity — genuinely richer than a Strava summary, because it segments the
 * workout even when the athlete never pressed the lap button.
 *
 * This is best-effort by design: a missing or changed endpoint must degrade
 * to "no laps for this activity", never fail the whole sync. The activity
 * still imports and still classifies from its summary evidence.
 */
async function fetchIntervalLaps(activityId, accessToken) {
  try {
    const data = await intervalsFetch(`/activity/${encodeURIComponent(activityId)}/intervals`, accessToken);
    const list = Array.isArray(data) ? data
      : (Array.isArray(data && data.icu_intervals) ? data.icu_intervals : null);
    return normalizeIntervalLaps(list);
  } catch (error) {
    if (error && error.authExpired) throw error;   // real auth problem: bubble up
    return null;                                    // anything else: no laps
  }
}

/* ═══════════════════════════ ACTION: connect ═════════════════════════ */

async function actionConnect(request, response, cid) {
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required." });

  if (!isIntervalsConfigured()) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "NOT_CONFIGURED" });
    return response.status(503).json({
      error: "Intervals.icu connection isn't available right now. Please try again later.",
      code: "PROVIDER_NOT_CONFIGURED"
    });
  }

  const { uri: redirectUri } = getIntervalsRedirectUri();
  const requestedReturnTarget = request.body?.return_target;
  if (
    requestedReturnTarget !== undefined &&
    requestedReturnTarget !== "web" &&
    requestedReturnTarget !== "ios"
  ) {
    return response.status(400).json({
      error: "Invalid return target.",
      code: "INVALID_RETURN_TARGET"
    });
  }
  const state = createOAuthState(
    {
      userId: user.id,
      provider: "intervals",
      issuedAt: Date.now(),
      returnTarget: requestedReturnTarget || "web"
    },
    process.env.OAUTH_STATE_SECRET
  );

  const authorizeUrl = new URL(INTERVALS_AUTHORIZE_URL);
  /*
   * REQUIRED by OAuth 2.0 §4.1.1. Without it the authorization server has no
   * declared grant type, rejects the request on its own error page, and never
   * redirects to redirect_uri — so our callback never runs, no connection is
   * ever parked, and the client has nothing to finalize. Its absence looked
   * like a client bug for four investigations. api/strava/connect.js has
   * always set it; this endpoint never did.
   */
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", process.env.INTERVALS_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", INTERVALS_SCOPE);
  authorizeUrl.searchParams.set("state", state);

  log("intervals_oauth_start", { correlationId: cid, provider: "intervals" });
  return response.status(200).json({ authorizationUrl: authorizeUrl.toString() });
}

/* ═══════════════════════════ ACTION: callback ════════════════════════ */

async function actionCallback(request, response, cid) {
  const origin = getAppReturnOrigin();
  let returnTarget = "web";

  /*
   * TEMPORARY POST-CONSENT DIAGNOSTICS.
   *
   * Production reaches the Intervals consent screen, the athlete approves, and
   * the browser comes back to Athlevo on the Today page with no connection and
   * no client-side trail. That is consistent with this function never running
   * AND with it running and bouncing the browser to a different origin — the
   * two cannot be told apart from the client. So the server says which.
   *
   * ORIGIN DIVERGENCE is the specific thing worth watching: the OUTBOUND
   * redirect_uri may come from INTERVALS_REDIRECT_URI, while the RETURN origin
   * is fixed to canonical HTTPS Athlevo (see intervalsConfig.js). Comparing
   * them proves an environment override cannot silently redirect the athlete
   * to a preview or other origin after OAuth.
   *
   * Origins and booleans only. No code, token, secret, state body or
   * completion token is ever recorded.
   */
  const q0 = request.query || {};
  let redirectUriOrigin = null, redirectUriSource = null;
  try {
    const info = getIntervalsRedirectUri();
    redirectUriSource = info.source;
    redirectUriOrigin = info.uri ? new URL(info.uri).origin : null;
  } catch (e) { /* diagnostics must never break the flow */ }

  const returnOrigin = origin ? (() => {
    try { return new URL(origin).origin; } catch (e) { return "unparseable"; }
  })() : "unset";

  log("intervals_callback_invoked", {
    correlationId: cid, provider: "intervals", invoked: true,
    method: request.method || null,
    pathname: "/api/providers",
    action: "callback",
    hasCode: Boolean(q0.code),
    hasState: Boolean(q0.state),
    hasError: Boolean(q0.error),
    returnOrigin,
    redirectUriOrigin,
    redirectUriSource,
    // The decisive comparison.
    originsMatch: Boolean(redirectUriOrigin) && redirectUriOrigin === returnOrigin
  });

  const backToApp = (status, message, reason, completion) => {
    log("intervals_callback_redirect", {
      correlationId: cid, provider: "intervals",
      finalRedirectState: status, returnOrigin
    });
    const native = returnTarget === "ios";
    const target = new URL(native
      ? "athlevo://provider/callback"
      : `${origin}/index.html`);
    if (native) {
      target.searchParams.set("provider", "intervals");
      target.searchParams.set("result", status);
    } else {
      target.searchParams.set("intervals", status);
    }
    if (!native && message) target.searchParams.set("message", message);
    // A machine-readable reason so the app can react correctly rather than
    // inferring the cause from prose. Never contains athlete data.
    if (!native && reason) target.searchParams.set("reason", reason);
    // Opaque, single-use, short-lived. Never a provider credential.
    if (completion) target.searchParams.set("completion", completion);
    response.setHeader("Location", target.toString());
    return response.status(302).end();
  };

  const q = request.query || {};
  const payload = verifyOAuthState(q.state, process.env.OAUTH_STATE_SECRET, {
    provider: "intervals"
  });
  if (payload?.returnTarget === "ios") returnTarget = "ios";

  log("intervals_callback_state", { correlationId: cid, provider: "intervals",
    stateValid: Boolean(payload) });

  if (!payload) {
    // Covers tampered, forged, replayed-after-expiry and missing state.
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "INVALID_STATE" });
    return backToApp("failed", "That connection link expired. Please try connecting again.");
  }
  // The athlete declined on Intervals.icu — not an error, just a choice, but
  // it still requires the valid state that bound the user and return channel.
  if (q.error) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "ACCESS_DENIED" });
    return backToApp("cancelled", "Intervals.icu connection was cancelled.");
  }
  if (!q.code) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "NO_CODE" });
    return backToApp("failed", "Intervals.icu didn't complete the connection — please try again.");
  }

  let token;
  try {
    const { uri: redirectUri } = getIntervalsRedirectUri();
    const res = await fetch(INTERVALS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.INTERVALS_CLIENT_ID,
        client_secret: process.env.INTERVALS_CLIENT_SECRET,
        code: String(q.code),
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    });
    log("intervals_callback_token", { correlationId: cid, provider: "intervals",
      tokenExchangeAttempted: true, tokenHttpStatus: res.status });

    if (!res.ok) {
      // Log the STATUS only — the body sits next to token material.
      log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "TOKEN_EXCHANGE", httpStatus: res.status });
      return backToApp("failed", "We couldn't complete the Intervals.icu connection. Please try again.");
    }
    token = await res.json();
  } catch {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "TOKEN_NETWORK" });
    return backToApp("failed", "We couldn't reach Intervals.icu. Please try again in a moment.");
  }

  const athleteId = token && token.athlete && token.athlete.id ? String(token.athlete.id) : null;
  if (!token.access_token || !athleteId) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "TOKEN_SHAPE" });
    return backToApp("failed", "Intervals.icu returned an unexpected response. Please try again.");
  }

  /*
   * Ownership. If this Intervals.icu athlete is already linked to a DIFFERENT
   * Athlevo account, refuse. The message never reveals which account holds
   * it — that would leak account existence to anyone who can run the flow.
   * Re-connecting the SAME athlete to the SAME Athlevo user is allowed and is
   * exactly how reconnect works (Intervals.icu issues a fresh token, which
   * replaces the old one).
   */
  /*
   * OWNERSHIP OBSERVABILITY (diagnostic only — changes no branch below).
   *
   * `userId` here is the claimant carried in the SIGNED STATE, i.e. the account
   * that was authenticated when the flow started. A callback is a redirect from
   * Intervals.icu and carries no Authorization header, so no session-derived
   * user id exists at this point — which is precisely why the event name says
   * "callback" and finalize has its own event.
   */
  const own = {};
  const ownership = await decideOwnership("intervals", athleteId, payload.userId, own);
  log("intervals_callback_ownership", {
    correlationId: cid, provider: "intervals",
    ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
    ownershipDecision: own.ownershipDecision ?? null,
    ownershipLookupOk: own.ownershipLookupOk ?? false,
    pendingRow: "not_yet"
  });
  if (!ownership.ok) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "OWNERSHIP_LOOKUP",
      ownershipDecision: null });
    return backToApp("failed", "We couldn't save the connection just now. Please try again in a moment.");
  }
  if (ownership.decision === "blocked") {
    // Another account that STILL EXISTS owns this athlete. Refuse — one active
    // Intervals identity can never belong to two active Athlevo users.
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "ALREADY_LINKED",
      ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
      ownershipDecision: "blocked", pendingRow: "not_created" });
    return backToApp(
      "failed",
      "This Intervals.icu account is already connected to another Athlevo account.",
      "already_linked"
    );
  }
  if (ownership.decision === "reclaim") {
    // The only claim is an orphan whose owner is gone from auth.users. Note it
    // and fall through — the AUTHORITATIVE reclaim (row deletion + write) happens
    // in finalize, where the caller's identity is proven.
    log("intervals_ownership_reclaim", { correlationId: cid, provider: "intervals", status: "callback",
      ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
      ownershipDecision: "reclaim" });
  }

  /*
   * DO NOT WRITE provider_accounts HERE.
   *
   * This request is a redirect from Intervals.icu. It has no Authorization
   * header, so we cannot know which Athlevo account is signed into the browser
   * right now — only which one STARTED the flow, minutes ago. Saving here
   * trusted that assumption and silently wrote the row to the wrong user when
   * the session had changed.
   *
   * Instead: park the credentials encrypted, hand the browser an opaque
   * one-time token, and let the AUTHENTICATED finalize call decide.
   */
  log("intervals_callback_pending", { correlationId: cid, provider: "intervals",
    pendingWriteAttempted: true });

  const completion = await createPendingConnection({
    userId: payload.userId,
    provider: "intervals",
    athleteId,
    credentials: {
      access_token: token.access_token,
      refresh_token: null,        // Intervals.icu issues no refresh tokens
      token_expires_at: null,
      scope: token.scope || INTERVALS_SCOPE
    }
  });

  log("intervals_callback_pending_result", { correlationId: cid, provider: "intervals",
    pendingWriteOk: Boolean(completion) });

  // Ties the pending-row outcome to the ownership decision that allowed it.
  log("intervals_callback_outcome", {
    correlationId: cid, provider: "intervals",
    ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
    ownershipDecision: own.ownershipDecision ?? null,
    pendingRow: completion ? "created" : "not_created",
    finalRedirectState: completion ? "pending" : "failed",
    code: completion ? null : "PENDING_PERSIST"
  });

  if (!completion) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "PENDING_PERSIST" });
    return backToApp("failed", "We connected to Intervals.icu but couldn't save it. Please try again.");
  }

  purgeExpiredPending();   // fire-and-forget housekeeping
  // Drop any abandoned handoff for this athlete left by a different account, so
  // a never-finalized orphan attempt cannot masquerade as a claim later.
  purgeForeignPendingForAthlete("intervals", athleteId, payload.userId);

  /*
   * Only the opaque completion token travels in the URL. It is a random
   * 32-byte value; the database holds only its SHA-256. No provider token,
   * athlete id, or user id is exposed to the browser, history, or referrer.
   */
  log("intervals_oauth_pending", { correlationId: cid, provider: "intervals" });
  return backToApp("pending", null, null, completion);
}

/* ═════════════════════════════ ACTION: sync ══════════════════════════ */

// Bounded windows: never an unbounded full-history fetch.
const FIRST_SYNC_DAYS = 180;   // initial import horizon
const OVERLAP_DAYS = 3;        // re-check recent days for late edits
const MAX_WINDOW_DAYS = 90;    // Intervals.icu range chunk
const MAX_WINDOWS = 3;         // hard ceiling per sync call
const MAX_LAP_FETCHES = 30;    // per sync — one extra request per activity
const SYNC_LOCK_MS = 5 * 60 * 1000;

/* ═══════════════════════ ACTION: finalize ════════════════════════════ */

/*
 * The security boundary of the whole OAuth flow.
 *
 * The callback proved that Intervals.icu authorised SOMEONE. This endpoint
 * proves WHO is asking — and refuses to save the connection unless that is
 * the same Athlevo account that started it.
 *
 * Identity comes exclusively from requireUser(). No user id is ever accepted
 * from the client, and no cookie participates.
 */
async function actionFinalize(request, response, cid) {
  const user = await requireUser(request);
  if (!user?.id) {
    return response.status(401).json({ error: "Authentication is required.", code: "UNAUTHENTICATED" });
  }

  const completion = request.body && request.body.completion;
  if (!completion || typeof completion !== "string") {
    return response.status(400).json({ error: "Missing completion token.", code: "COMPLETION_MISSING" });
  }

  /*
   * Consumed FIRST, atomically. Even a request that turns out to belong to the
   * wrong account burns the token — a mismatch must invalidate the pending
   * connection rather than leave it available for another attempt.
   */
  const pending = await consumePendingConnection(completion);
  // Diagnostic only. The completion token and its hash are NOT logged.
  log("intervals_finalize_pending", {
    correlationId: cid, provider: "intervals",
    pendingRow: pending.ok ? "consumed" : "not_consumed",
    code: pending.ok ? null : pending.code
  });
  if (!pending.ok) {
    log("intervals_finalize_failure", { correlationId: cid, provider: "intervals", code: pending.code });
    return response.status(pending.code === "LOOKUP_FAILED" ? 503 : 400).json({
      error: pending.code === "COMPLETION_EXPIRED"
        ? "That connection took too long to complete. Please connect again."
        : "That connection link is no longer valid. Please connect again.",
      code: pending.code
    });
  }

  const row = pending.row;

  /*
   * THE CHECK THIS ENTIRE REFACTOR EXISTS FOR.
   *
   * Never silently move, overwrite or relink an account between Athlevo users.
   * The pending row is already consumed above, so a mismatch cannot be retried.
   */
  if (String(row.user_id) !== String(user.id)) {
    log("intervals_finalize_failure", { correlationId: cid, provider: "intervals", code: "SESSION_CHANGED",
      pendingRow: "consumed" });
    return response.status(409).json({
      error: "Your Athlevo account changed while connecting your training data. " +
             "For security, please restart the connection from the account you want to use.",
      code: "SESSION_CHANGED"
    });
  }

  // Re-checked here, not just in the callback: ownership can change in between.
  const own = {};
  const ownership = await decideOwnership("intervals", row.provider_athlete_id, user.id, own);
  /*
   * OWNERSHIP OBSERVABILITY (diagnostic only — changes no branch below).
   * Here `userId` IS the session-authenticated caller from requireUser().
   */
  log("intervals_finalize_ownership", {
    correlationId: cid, provider: "intervals",
    ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
    ownershipDecision: own.ownershipDecision ?? null,
    ownershipLookupOk: own.ownershipLookupOk ?? false,
    pendingRow: "consumed"
  });
  if (!ownership.ok) {
    log("intervals_finalize_failure", { correlationId: cid, provider: "intervals", code: "OWNERSHIP_LOOKUP",
      ownershipDecision: null, pendingRow: "consumed" });
    return response.status(503).json({
      error: "We couldn't save the connection just now. Please try again in a moment.",
      code: "OWNERSHIP_LOOKUP"
    });
  }
  if (ownership.decision === "blocked") {
    // Another account that still exists owns it. Never relink an active account.
    log("intervals_finalize_failure", { correlationId: cid, provider: "intervals", code: "ALREADY_LINKED",
      ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
      ownershipDecision: "blocked", pendingRow: "consumed" });
    return response.status(409).json({
      error: "This Intervals.icu account is already connected to another Athlevo account.",
      code: "ALREADY_LINKED"
    });
  }
  if (ownership.decision === "reclaim") {
    /*
     * The sole owner is orphaned — gone from auth.users. Release the dead claim
     * BEFORE the upsert so the athlete id is never owned by two rows at once. If
     * the release fails we refuse rather than risk a split-ownership write; the
     * pending row is already consumed, so the athlete simply retries.
     */
    const released = await releaseOrphanedOwnership("intervals", row.provider_athlete_id, ownership.staleUserId);
    if (!released) {
      log("intervals_finalize_failure", { correlationId: cid, provider: "intervals", code: "OWNERSHIP_LOOKUP",
        ownershipDecision: "reclaim", pendingRow: "consumed" });
      return response.status(503).json({
        error: "We couldn't save the connection just now. Please try again in a moment.",
        code: "OWNERSHIP_LOOKUP"
      });
    }
    log("intervals_ownership_reclaim", { correlationId: cid, provider: "intervals", status: "finalize",
      ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
      ownershipDecision: "reclaim" });
  }

  const saved = await upsertProviderAccount({
    user_id: user.id,                       // from requireUser(), never the client
    provider: "intervals",
    provider_athlete_id: row.provider_athlete_id,
    access_token: pending.credentials.access_token,
    refresh_token: pending.credentials.refresh_token,
    token_expires_at: pending.credentials.token_expires_at,
    scope: pending.credentials.scope,
    /*
     * Reconnect path. The upsert targets (user_id, provider), so re-authorising
     * UPDATES the existing row — a second provider_accounts row is structurally
     * impossible, which is also what makes concurrent finalize calls safe.
     *
     * These three must be reset explicitly, not just the token:
     *   status           → clears reconnect_required
     *   last_sync_status → a stale "failed" keeps the UI looking broken
     *   sync_started_at  → a stale lock would reject the first sync with
     *                      SYNC_IN_PROGRESS for up to five minutes
     */
    status: "connected",
    last_sync_status: null,
    sync_started_at: null,
    connected_at: new Date().toISOString()
  });

  if (!saved) {
    log("intervals_finalize_failure", { correlationId: cid, provider: "intervals", code: "PERSIST",
      ownershipDecision: own.ownershipDecision ?? null, pendingRow: "consumed" });
    return response.status(503).json({
      error: "We connected to Intervals.icu but couldn't save it. Please try again.",
      code: "PERSIST"
    });
  }

  // The provider account is safely written — clean up the consumed pending
  // row so it does not linger in the table. Best-effort: failure here is
  // harmless because the row is already consumed (consumed_at is set) and
  // purgeExpiredPending will remove it once its TTL passes.
  deletePendingConnection(row.id);

  log("intervals_finalize_success", { correlationId: cid, provider: "intervals",
    ownerExistsInAuth: own.ownerExistsInAuth ?? "not_checked",
    ownershipDecision: own.ownershipDecision ?? null,
    pendingRow: "consumed", code: null });
  return response.status(200).json({ success: true, connected: true });
}

async function actionSync(request, response, cid) {
  const started = Date.now();
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required." });

  const account = await readProviderAccount(user.id, "intervals");
  if (!account) {
    /*
     * 409, NOT 404. The route exists and the request is valid — the athlete
     * simply has no provider connection yet. Returning 404 made a normal
     * state indistinguishable from a missing endpoint, and sent debugging
     * after a routing bug that did not exist.
     */
    return response.status(409).json({ error: "No Intervals.icu account is connected.", code: "NOT_CONNECTED" });
  }
  if (!account.access_token) {
    return response.status(409).json({ error: "Please reconnect your Intervals.icu account.", code: "RECONNECT_REQUIRED" });
  }

  /*
   * Concurrency guard. Two syncs at once would double the API load and race
   * on duplicate resolution. A short timestamp lock is used rather than a
   * boolean so a crashed sync self-heals after 5 minutes instead of wedging
   * the connection permanently.
   */
  const lockedAt = account.sync_started_at ? Date.parse(account.sync_started_at) : 0;
  if (lockedAt && Date.now() - lockedAt < SYNC_LOCK_MS) {
    return response.status(409).json({ error: "A sync is already running. Give it a moment.", code: "SYNC_IN_PROGRESS" });
  }
  await patchProviderAccount(account.id, { sync_started_at: new Date().toISOString() });

  log("intervals_sync_start", { correlationId: cid, provider: "intervals" });

  let imported = 0, failed = 0, withLaps = 0, duplicatesMarked = 0, windows = 0;
  let newestSeen = null;
  // Diagnostics: what the API actually returned, before any of our parsing.
  let returnedByApi = 0, unparseableWindows = 0;
  const windowReports = [];

  try {
    /*
     * Incremental window. After the first sync we only look back to the last
     * synced date minus a small overlap, so a routine sync is one short
     * request rather than a full-history re-download.
     */
    const now = new Date();
    const lastSync = account.last_sync_at ? new Date(account.last_sync_at) : null;
    const startFrom = lastSync
      ? new Date(lastSync.getTime() - OVERLAP_DAYS * 86400000)
      : new Date(now.getTime() - FIRST_SYNC_DAYS * 86400000);

    // Chunk the range into bounded windows, newest first.
    const ranges = [];
    let cursorEnd = new Date(now);
    while (cursorEnd > startFrom && ranges.length < MAX_WINDOWS) {
      const cursorStart = new Date(Math.max(
        startFrom.getTime(),
        cursorEnd.getTime() - MAX_WINDOW_DAYS * 86400000
      ));
      ranges.push({ oldest: ymd(cursorStart), newest: ymd(cursorEnd) });
      cursorEnd = new Date(cursorStart.getTime() - 86400000);
    }

    let lapBudget = MAX_LAP_FETCHES;
    const allRows = [];

    /*
     * PART 1 idempotency: the recognition already stored for these activities.
     * Keyed by external id, so toActivityRow can preserve an unchanged record
     * (analyzedAt included) rather than re-running recognition on every sync.
     */
    const existingRecognition = new Map();
    try {
      if (ranges.length) {
        const oldestIso = ranges[ranges.length - 1].oldest;
        const newestIso = ranges[0].newest;
        const prior = await loadNeighbourActivities(user.id, oldestIso, newestIso);
        for (const row of prior) {
          if (row && row.source === "intervals" && row.external_activity_id &&
              row.raw_data && row.raw_data.recognition) {
            existingRecognition.set(String(row.external_activity_id), row.raw_data.recognition);
          }
        }
      }
    } catch (e) { /* no prior recognition available — recompute, still correct */ }

    for (const range of ranges) {
      windows += 1;

      const meta = { oldest: range.oldest, newest: range.newest, athleteId: "0" };
      let activities = await intervalsFetch(
        activitiesPath("0", range.oldest, range.newest), account.access_token, meta);

      /*
       * Fallback: if the "0" shorthand yields nothing but we hold the real
       * athlete id from the OAuth exchange, try that once before concluding
       * the window is genuinely empty. Costs one request only in the failing
       * case, and turns an ambiguous zero into a definite answer.
       */
      if ((!Array.isArray(activities) || activities.length === 0) && account.provider_athlete_id) {
        const retry = { oldest: range.oldest, newest: range.newest, athleteId: "explicit" };
        try {
          const alt = await intervalsFetch(
            activitiesPath(account.provider_athlete_id, range.oldest, range.newest),
            account.access_token, retry);
          if (Array.isArray(alt) && alt.length) {
            activities = alt;
            meta.usedExplicitAthleteId = true;
            meta.count = alt.length;
          } else {
            meta.explicitIdAlsoEmpty = true;

            // Last resort: the other athlete-id form (bare ↔ i-prefixed).
            const rawId = String(account.provider_athlete_id);
            const altId = rawId.startsWith("i") ? rawId.slice(1) : `i${rawId}`;
            try {
              const altMeta = { oldest: range.oldest, newest: range.newest, athleteId: "alt" };
              const altRows = await intervalsFetch(
                activitiesPath(altId, range.oldest, range.newest),
                account.access_token, altMeta);
              if (Array.isArray(altRows) && altRows.length) {
                activities = altRows;
                meta.usedAltAthleteIdForm = true;
                meta.count = altRows.length;
              }
            } catch { meta.altIdFailed = true; }
          }
        } catch { meta.explicitIdFailed = true; }
      }

      windowReports.push(meta);

      /*
       * A non-array response is a CONTRACT MISMATCH, not an empty window.
       * Previously this was skipped silently, which made "the API returned
       * nothing" indistinguishable from "we couldn't read what it returned"
       * — the exact ambiguity behind an imported:0/failed:0 result.
       */
      if (!Array.isArray(activities)) {
        unparseableWindows += 1;
        log("intervals_sync_shape_mismatch", {
          correlationId: cid, provider: "intervals",
          httpStatus: meta.httpStatus, oldest: meta.oldest, newest: meta.newest
        });
        continue;
      }
      returnedByApi += activities.length;

      for (const raw of activities) {
        /*
         * Partial-failure tolerance: one malformed activity must never abort
         * the sync or break the connection. It is counted and skipped; every
         * other activity still imports.
         */
        try {
          const workout = mapIntervals(raw);
          if (!workout.externalId || !workout.startDate) { failed += 1; continue; }

          // Lap structure only where it can change classification: runs of
          // real length. Bounded so a big first sync can't fan out.
          const isRun = workout.sport === "run";
          if (isRun && lapBudget > 0 && Number(workout.movingTimeSeconds || 0) >= 15 * 60) {
            lapBudget -= 1;
            const laps = await fetchIntervalLaps(workout.externalId, account.access_token);
            if (laps && laps.length > 1) { workout.laps = laps; withLaps += 1; }
          }

          const row = toActivityRow(user.id, workout, raw, {
            existingRecognition: existingRecognition.get(String(workout.externalId)) || null
          });
          row.activity_type = workout.activityType || row.activity_type;
          allRows.push(row);

          const t = Date.parse(workout.startDate);
          if (Number.isFinite(t) && (!newestSeen || t > newestSeen)) newestSeen = t;
        } catch {
          failed += 1;
        }
      }
    }

    /*
     * Collapse the batch by (source, external_activity_id) BEFORE writing.
     * Adjacent sync windows overlap at their boundaries, so the same activity
     * can legitimately appear twice in one batch — and Postgres rejects an
     * ON CONFLICT upsert whose payload touches the same key twice
     * ("cannot affect row a second time"), which would fail the entire sync.
     * Last write wins, which is the copy from the newest window.
     */
    const byKey = new Map();
    for (const row of allRows) byKey.set(`${row.source}:${row.external_activity_id}`, row);
    const uniqueRows = Array.from(byKey.values());

    const savedRows = uniqueRows.length ? await saveActivities(uniqueRows) : [];
    imported = savedRows.length;

    /*
     * Cross-provider deduplication, AFTER the rows exist so both copies are
     * comparable. Only the window we just touched is examined, so this stays
     * cheap and can never sweep the athlete's whole history.
     */
    if (savedRows.length) {
      const times = savedRows.map(r => Date.parse(r.start_date)).filter(Number.isFinite);
      if (times.length) {
        const pad = 86400000;
        const neighbours = await loadNeighbourActivities(
          user.id,
          new Date(Math.min(...times) - pad).toISOString(),
          new Date(Math.max(...times) + pad).toISOString()
        );
        const marks = resolveDuplicates(savedRows, neighbours);
        for (const mark of marks) {
          const target = neighbours.find(n => n.id === mark.id) ||
            savedRows.find(n => n.id === mark.id);
          const ok = await markSuperseded(mark.id, target && target.raw_data, mark.supersededBy, mark.reason);
          if (ok) duplicatesMarked += 1;
        }
      }
    }

    await patchProviderAccount(account.id, {
      sync_started_at: null,
      status: "connected",
      last_sync_status: failed > 0 ? "partial" : "success",
      // Advance the cursor only to what we actually saw, so a short sync
      // never skips a gap it didn't cover.
      last_sync_at: newestSeen ? new Date(newestSeen).toISOString() : account.last_sync_at
    });

    const event = failed > 0 ? "intervals_sync_partial" : "intervals_sync_success";
    log(event, {
      correlationId: cid, provider: "intervals",
      imported, failed, duplicatesMarked, windows,
      returnedByApi, unparseableWindows,
      durationMs: Date.now() - started
    });

    /*
     * `returnedByApi` is the number Intervals.icu actually gave us, before any
     * Athlevo parsing. Combined with `windows`, it makes imported:0 readable
     * at a glance instead of a mystery:
     *
     *   returnedByApi 0, unparseableWindows 0 → the account has no activities
     *                                           in the requested range
     *   unparseableWindows > 0                → response shape mismatch
     *   returnedByApi > 0 but imported 0      → our normalization dropped them
     */
    return response.status(200).json({
      success: true, provider: "intervals",
      imported, failed, withLaps, duplicatesMarked,
      status: failed > 0 ? "partial" : "success",
      diagnostics: { returnedByApi, unparseableWindows, windows, windowReports }
    });
  } catch (error) {
    /*
     * Always release the lock, then report a neutral, actionable message.
     *
     * ONLY a 401 flips the account to reconnect_required. A 403 means the
     * credential is valid but the resource is out of scope — marking that as
     * "reconnect" would send the athlete round an OAuth loop that cannot fix
     * anything, and would make a working connection look broken.
     */
    const authExpired = Boolean(error && error.authExpired);
    await patchProviderAccount(account.id, {
      sync_started_at: null,
      status: authExpired ? "reconnect_required" : account.status,
      last_sync_status: "failed"
    });
    const mapped = mapProviderError("intervals", error);
    log("intervals_sync_failure", { correlationId: cid, provider: "intervals", code: authExpired ? "AUTH_EXPIRED" : mapped.code, imported, failed });
    return response.status(authExpired ? 409 : 502).json({
      // Existing imported data is untouched by a failed sync — say so.
      error: authExpired
        ? "Your Intervals.icu connection needs to be re-authorised."
        : mapped.message,
      code: authExpired ? "RECONNECT_REQUIRED" : mapped.code,
      imported
    });
  }
}

/* ═══════════════════════════ ACTION: trends ══════════════════════════ */

/*
 * Read-only daily CTL/ATL/load history for Athlevo-owned charts.
 *
 * Identity is derived exclusively from the verified bearer token. The body
 * may choose a bounded range key, but no client-supplied user or athlete id
 * participates in account selection. Provider credentials stay server-side.
 */
async function actionTrends(request, response, cid) {
  const user = await requireUser(request);
  if (!user?.id) {
    return response.status(401).json({
      error: "Authentication is required.",
      code: "UNAUTHENTICATED"
    });
  }

  /*
   * Premium analytics are protected before provider-account lookup and before
   * any Intervals wellness request. The client may select only a bounded time
   * range; entitlement is always resolved from the authenticated user's
   * service-role subscription row.
   */
  const access = await requirePaidAccess(user.id, "trends_analytics");
  if (access.serviceUnavailable) {
    return response.status(503).json({
      error: "We couldn't verify access right now. Please try again.",
      code: "ENTITLEMENT_UNAVAILABLE",
      feature: "trends_analytics"
    });
  }
  if (!access.allowed) {
    return response.status(402).json({
      error: "Athlevo Performance is required to view performance trends.",
      code: "PERFORMANCE_REQUIRED",
      feature: "trends_analytics"
    });
  }

  const account = await readProviderAccount(user.id, "intervals");
  if (!account || !account.access_token) {
    return response.status(409).json({
      error: "Connect training data to see your training trends.",
      code: "NOT_CONNECTED"
    });
  }

  if (!accountHasScope(account, "WELLNESS:READ")) {
    return response.status(403).json({
      error: "Reconnect training data to enable fitness and fatigue trends.",
      code: "TRENDS_SCOPE_REQUIRED"
    });
  }

  const range = request.body && request.body.range;
  const dates = dateRangeForTrends(range, new Date());

  try {
    const records = await intervalsFetch(
      wellnessPath("0", dates.oldest, dates.newest),
      account.access_token
    );

    if (!Array.isArray(records)) {
      return response.status(502).json({
        error: "Training trends are temporarily unavailable.",
        code: "PROVIDER_RESPONSE_INVALID"
      });
    }

    return response.status(200).json(
      buildProviderTrendsResponse(records, dates.range, new Date(`${dates.newest}T00:00:00Z`))
    );
  } catch (error) {
    if (error && error.authExpired) {
      await patchProviderAccount(account.id, {
        status: "reconnect_required",
        last_sync_status: "failed"
      });
      return response.status(409).json({
        error: "Reconnect training data to refresh your trends.",
        code: "RECONNECT_REQUIRED"
      });
    }

    if (error && error.forbidden) {
      return response.status(403).json({
        error: "Reconnect training data to enable fitness and fatigue trends.",
        code: "TRENDS_SCOPE_REQUIRED"
      });
    }

    log("intervals_trends_failure", {
      correlationId: cid,
      provider: "intervals",
      code: error && error.rateLimited ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE"
    });
    return response.status(502).json({
      error: "Your last confirmed trends are still available. Try refreshing shortly.",
      code: error && error.rateLimited ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE"
    });
  }
}

/* ═══════════════════════════ ACTION: diagnose ════════════════════════ */

/*
 * Read-only probe of the live Intervals.icu connection. Writes nothing,
 * imports nothing, and touches no Athlevo data — safe to run repeatedly.
 *
 * It exists to make an `imported: 0` result unambiguous by separating the
 * candidate causes with evidence rather than inference:
 *
 *   profile probe fails            → the token is bad (cause 3 / auth)
 *   "0" empty but explicit id full → the athlete-id shorthand is the problem
 *   narrow empty, wide has data    → the date window is the problem
 *   both windows empty             → the account genuinely has no activities
 *   non-array response             → the response shape is the problem
 *   array full but sampleKeys odd  → our field mapping is the problem
 *
 * Privacy: reports HTTP status, counts, and the KEY NAMES of one sample
 * activity — never the token, never activity values beyond the athlete's own
 * id/type/date, which are shown only to that athlete in their own console.
 */
async function actionDiagnose(request, response, cid) {
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required." });

  const account = await readProviderAccount(user.id, "intervals");
  if (!account || !account.access_token) {
    /*
     * 409, NOT 404. The route exists and the request is valid — the athlete
     * simply has no provider connection yet. Returning 404 made a normal
     * state indistinguishable from a missing endpoint, and sent debugging
     * after a routing bug that did not exist.
     */
    return response.status(409).json({ error: "No Intervals.icu account is connected.", code: "NOT_CONNECTED" });
  }

  const token = account.access_token;
  const day = (offsetDays) => ymd(new Date(Date.now() + offsetDays * 86400000));
  const probes = {};

  const run = async (name, path) => {
    const meta = { path: path.replace(/^\//, "") };
    try {
      const body = await intervalsFetch(path, token, meta);
      if (Array.isArray(body) && body.length) {
        const s = body[0];
        meta.sampleKeys = Object.keys(s).slice(0, 40);
        // The athlete's own identifiers, so field-name guesses can be checked.
        meta.sample = {
          id: s.id ?? null, type: s.type ?? null,
          start_date_local: s.start_date_local ?? null,
          start_date: s.start_date ?? null,
          hasDistance: s.distance != null || s.icu_distance != null,
          hasMovingTime: s.moving_time != null || s.icu_moving_time != null,
          source: s.source ?? null
        };
      }
    } catch (error) {
      meta.error = error && error.authExpired ? "AUTH_EXPIRED"
        : (error && error.forbidden ? "FORBIDDEN_SCOPE"
        : (error && error.rateLimited ? "RATE_LIMITED" : "REQUEST_FAILED"));
    }
    probes[name] = meta;
  };

  /*
   * 1. Liveness probe, INSIDE our scope. A 1-day activities query is the
   *    cheapest call ACTIVITY:READ can definitely make, so a failure here is
   *    a real credential failure rather than a permissions quirk.
   *
   *    The previous liveness probe was /athlete/0 — the athlete SETTINGS
   *    resource, which ACTIVITY:READ cannot read. Its 403 was expected
   *    behaviour, but it was reported as AUTH_EXPIRED and short-circuited the
   *    verdict into "token rejected", condemning a perfectly healthy
   *    connection. That was the bug.
   */
  await run("tokenLiveness", activitiesPath("0", day(-1), day(0)));
  // 2. The exact window the real sync uses (180 days back).
  await run("syncWindow180d", activitiesPath("0", day(-FIRST_SYNC_DAYS), day(0)));
  // 3. Same window, explicit athlete id — isolates the "0" shorthand.
  if (account.provider_athlete_id) {
    await run("explicitAthleteId", activitiesPath(account.provider_athlete_id, day(-FIRST_SYNC_DAYS), day(0)));
  }
  // 4. Very wide window — separates "no recent activities" from "no activities".
  await run("wideWindow3y", activitiesPath("0", day(-1095), day(1)));
  /*
   * 5. Athlete-id FORM probe. Intervals ids appear both bare ("2049151")
   *    and "i"-prefixed ("i2049151") in their API. The OAuth token exchange
   *    returns one form; the activities path may require the other. Probing
   *    both removes the guesswork entirely.
   */
  if (account.provider_athlete_id) {
    const raw = String(account.provider_athlete_id);
    const alt = raw.startsWith("i") ? raw.slice(1) : `i${raw}`;
    await run("athleteIdAltForm", activitiesPath(alt, day(-FIRST_SYNC_DAYS), day(0)));
  }

  // 6. Scope probe, informational only. A 403 here is EXPECTED and healthy —
  //    it confirms Athlevo holds activity-read access and nothing more.
  await run("scopeCheck_athleteSettings", "/athlete/0");

  // A plain-language reading of the evidence, so the answer isn't left to
  // interpretation.
  const n = (k) => (probes[k] && typeof probes[k].count === "number") ? probes[k].count : null;
  // Only an in-scope probe may be read as evidence about the credential.
  const liveness = probes.tokenLiveness || {};
  let verdict;
  if (liveness.error === "AUTH_EXPIRED") {
    verdict = "Token rejected by Intervals.icu (401). Reconnect the account.";
  } else if (liveness.error === "RATE_LIMITED") {
    verdict = "Intervals.icu is rate-limiting requests. Try again in a few minutes.";
  } else if (liveness.error === "FORBIDDEN_SCOPE") {
    verdict = "Activity access was refused (403). The connection may have been " +
      "authorised without ACTIVITY:READ — reconnect and accept activity access.";
  } else if (Object.values(probes).some(p => p.isArray === false && p.count === null && !p.error && p.path.includes("activities"))) {
    verdict = "Activities endpoint returned a non-array — response shape mismatch. See objectKeys.";
  } else if (n("syncWindow180d") === 0 && n("explicitAthleteId") > 0) {
    verdict = "Athlete id '0' returns nothing but the explicit id works — the shorthand is the cause.";
  } else if (n("syncWindow180d") === 0 && n("wideWindow3y") > 0) {
    verdict = "No activities in the last 180 days, but older ones exist — the date window is the cause.";
  } else if (n("syncWindow180d") === 0 && n("wideWindow3y") === 0) {
    verdict = "Intervals.icu genuinely has zero activities for this account in any window. " +
      "Connect Garmin/COROS/Strava inside Intervals.icu and let it backfill, then sync again.";
  } else if (n("syncWindow180d") > 0) {
    verdict = `Intervals.icu returns ${n("syncWindow180d")} activities in the sync window — ` +
      "the API is fine, so a zero import points at normalization or the upsert.";
  } else {
    verdict = "Inconclusive — see the probe details.";
  }

  log("intervals_diagnose", {
    correlationId: cid, provider: "intervals",
    httpStatus: probes.syncWindow180d ? probes.syncWindow180d.httpStatus : null,
    count: n("syncWindow180d")
  });

  return response.status(200).json({
    provider: "intervals",
    connectionStatus: account.status,
    hasAthleteId: Boolean(account.provider_athlete_id),
    athleteIdForm: account.provider_athlete_id
      ? (String(account.provider_athlete_id).startsWith("i") ? "i-prefixed" : "bare-numeric")
      : null,
    scope: account.scope || null,
    lastSyncAt: account.last_sync_at || null,
    lastSyncStatus: account.last_sync_status || null,
    verdict,
    probes
  });
}

/* ═════════════════════ ACTIONS: status / disconnect ══════════════════ */

async function actionStatus(request, response) {
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required." });
  const account = await readProviderAccount(user.id, "intervals");
  // Deliberately returns NO token material — only what the UI needs.
  return response.status(200).json({
    provider: "intervals",
    available: isIntervalsEnabled(),
    connected: Boolean(account && account.access_token),
    status: account ? account.status : "not_connected",
    lastSync: account ? account.last_sync_at : null,
    lastSyncStatus: account ? account.last_sync_status : null
  });
}

async function actionDisconnect(request, response, cid) {
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required." });
  const account = await readProviderAccount(user.id, "intervals");
  if (!account) return response.status(200).json({ success: true, provider: "intervals" });

  /*
   * Clears credentials but KEEPS the row and every imported activity. The
   * athlete's training history is theirs; disconnecting a data source must
   * never delete their training record.
   */
  const ok = await patchProviderAccount(account.id, {
    access_token: null, refresh_token: null, status: "disconnected",
    /*
     * provider_athlete_id MUST be released too.
     *
     * findOwnerByProviderAthlete() matches on this column alone, so leaving it
     * behind meant a disconnected athlete still "owned" the Intervals account
     * forever: reconnecting from any other Athlevo account hit ALREADY_LINKED
     * against a connection that no longer exists. Clearing it releases the
     * claim without weakening the guard — a LIVE connection still blocks a
     * second Athlevo user, which is the rule the guard exists to enforce.
     */
    provider_athlete_id: null
  });
  log("intervals_disconnect", { correlationId: cid, provider: "intervals", status: ok ? "ok" : "failed" });
  return response.status(ok ? 200 : 500).json(
    ok ? { success: true, provider: "intervals" }
       : { error: "Couldn't disconnect just now. Please try again." }
  );
}

/* ═══════════════════════ ACTION: reanalyze ═══════════════════════════ */

const REANALYZE_BATCH = 300;   // bounded: one call recognises at most this many

/*
 * Backfill / re-recognise the authenticated athlete's OWN activities.
 *
 * Regenerates recognition whenever it is MISSING or its version is not the
 * current engine version — so a stored v1 record ("17 × 5:11") is treated as
 * stale and replaced. Preserves a record only when it is already current.
 * User-scoped, bounded, per-activity fault-tolerant. Returns safe diagnostic
 * counts only — never activity data or credentials.
 */
async function actionReanalyze(request, response, cid) {
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required.", code: "UNAUTHENTICATED" });

  const force = Boolean(request.body && request.body.force);
  const url = process.env.SUPABASE_URL;

  let rows = [];
  try {
    const res = await fetch(
      `${url}/rest/v1/activities?user_id=eq.${encodeURIComponent(user.id)}` +
      `&select=id,name,distance_meters,moving_time_seconds,elapsed_time_seconds,` +
      `average_heartrate,max_heartrate,elevation_gain_meters,raw_data` +
      `&order=start_date.desc&limit=${REANALYZE_BATCH}`,
      { headers: sbHeaders() }
    );
    if (res.ok) rows = await res.json();
  } catch (e) { /* reported as a service error below */ }
  if (!Array.isArray(rows)) rows = [];

  let scanned = 0, analyzed = 0, skipped = 0, failed = 0;
  let missingRecognition = 0, staleRecognition = 0;
  let rowsWithIntervals = 0, rowsWithoutIntervals = 0;

  /*
   * PART 3/6: safe per-row diagnostics for the athlete's specific activity
   * (~12.6 km / ~75 min / avg HR ~157 / max HR ~181). No provider-identifying
   * data — counts, version and lap structure only.
   */
  const probe = { readback: null, matched: null };
  const nnum = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
  const matchRow = (r) => near(nnum(r.distance_meters), 12600, 700) &&
    near(nnum(r.moving_time_seconds), 4500, 400) &&
    (near(nnum(r.average_heartrate), 157, 6) || near(nnum(r.max_heartrate), 181, 6));

  for (const row of rows) {
    scanned += 1;
    const raw = row && row.raw_data ? row.raw_data : {};
    const laps = Array.isArray(raw.laps) ? raw.laps : null;
    if (laps && laps.length) rowsWithIntervals += 1; else rowsWithoutIntervals += 1;

    if (!probe.matched && matchRow(row)) {
      const typed = laps ? laps.filter(l => l && l.type).length : 0;
      const lapTypes = laps ? Array.from(new Set(laps.map(l => l && l.type).filter(Boolean))) : [];
      const seg = laps && laps.length ? (() => {
        try { const s2 = buildRecognitionFromRow(row); return s2 ? s2.segments : []; } catch (e) { return []; }
      })() : [];
      probe.matched = {
        found: true,
        recognitionVersion: raw.recognition ? raw.recognition.version : null,
        recognitionIntervalCount: raw.recognition && raw.recognition.segments
          ? raw.recognition.segments.filter(x => x.kind === "work").length : null,
        lapCount: laps ? laps.length : 0,
        typedLapCount: typed,
        lapTypes,
        durationValuesPresent: laps ? laps.every(l => Number(l.moving_time) > 0 || Number(l.moving_time_seconds) > 0) : false,
        paceValuesPresent: laps ? laps.every(l => Number(l.distance) > 0 || Number(l.distance_meters) > 0) : false,
        reconstructedWorkSegments: seg.filter(x => x.kind === "work").length,
        reconstructedWorkDurations: seg.filter(x => x.kind === "work").map(x => x.duration)
      };
    }

    const existing = raw.recognition;
    const current = isCurrentRecognitionVersion(existing);   // canonical, shape-tolerant
    if (!existing) missingRecognition += 1;
    else if (!current) staleRecognition += 1;

    // Preserve ONLY a genuinely current record (unless force). Missing or
    // stale (any version shape that isn't the current number) is regenerated.
    if (!force && current) { skipped += 1; continue; }
    try {
      const recognition = buildRecognitionFromRow(row);
      if (!recognition) { failed += 1; continue; }
      const nextRaw = Object.assign({}, raw, { recognition });   // preserve laps/intervals
      const patch = await fetch(
        `${url}/rest/v1/activities?id=eq.${encodeURIComponent(row.id)}` +
        `&user_id=eq.${encodeURIComponent(user.id)}`,
        { method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=representation" },
          body: JSON.stringify({ raw_data: nextRaw }) }
      );
      if (patch.ok) {
        analyzed += 1;
        // PART 5: read-after-write proof. Confirm the PERSISTED record, from a
        // fresh row, actually carries the new work segments — a 200 alone is
        // not enough evidence the DB updated.
        try {
          const body = await patch.json();
          const persisted = Array.isArray(body) && body[0] && body[0].raw_data
            ? body[0].raw_data.recognition : recognition;
          const gw = (recognition.segments || []).filter(x => x.kind === "work").length;
          const pw = (persisted && persisted.segments || []).filter(x => x.kind === "work").length;
          if (probe) probe.readback = { generatedWorkSegments: gw, persistedWorkSegments: pw,
            persistedRecognitionVersion: persisted && persisted.version };
        } catch (e) {}
      } else failed += 1;
    } catch (e) { failed += 1; }
  }

  if (!probe.matched) probe.matched = { found: false };

  log("intervals_reanalyze", { correlationId: cid, provider: "intervals",
    scanned, analyzed, skipped, failed });
  return response.status(200).json({
    routeReached: true,
    build: "reanalyze-production-debug-v1",
    scanned, analyzed, skipped, failed,
    currentVersion: RECOGNITION_VERSION,
    missingRecognition, staleRecognition,
    rowsWithIntervals, rowsWithoutIntervals,
    readback: probe.readback || null,
    matched: probe.matched || null
  });
}

/* ═══════════════════ COACH DASHBOARD actions ═══════════════════════ */

/*
 * Consolidated from the former api/coach-dashboard.js. All three actions
 * reuse the gateway's existing auth helpers (requireUser, sbHeaders) and
 * Supabase URL/key from env. Security invariants are IDENTICAL to the
 * standalone file: role is read from the caller's own profile (service
 * role), athlete_id is authorized against ACTIVE assignments, provider
 * tokens and payment rows are never selected, the service-role key never
 * leaves the server.
 */

function enc(v) { return encodeURIComponent(String(v)); }

async function sbSelect(path) {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function loadCoachProfile(userId) {
  const rows = await sbSelect(
    `profiles?id=eq.${enc(userId)}&select=id,role,full_name`
  );
  return rows[0] || null;
}

async function loadActiveAssignments(coachId) {
  return sbSelect(
    `coach_athlete_assignments?coach_id=eq.${enc(coachId)}&status=eq.active` +
      `&select=id,coach_id,athlete_id,status,permission_level,assigned_at`
  );
}

async function loadAthleteBundle(athleteId) {
  const idf = enc(athleteId);
  const [profile, metrics, weekly, readiness, today, latestAct, provider] =
    await Promise.all([
      sbSelect(`profiles?id=eq.${idf}&select=id,full_name,primary_sport,goal,target_race`),
      sbSelect(`athlete_metrics?user_id=eq.${idf}&select=weekly_training_load,weekly_distance,fatigue_score,fitness_score,last_updated`),
      sbSelect(`weekly_progress_summaries?user_id=eq.${idf}&select=planned_duration_minutes,completed_duration_minutes,planned_distance_km,completed_distance_km,recovery_status,consistency_status,injury_risk_status,trajectory_status,week_start&order=week_start.desc&limit=1`),
      sbSelect(`daily_readiness?user_id=eq.${idf}&select=readiness_date,sleep_quality,energy,muscle_soreness,mental_stress,pain_present,pain_severity&order=readiness_date.desc&limit=1`),
      sbSelect(`training_sessions?user_id=eq.${idf}&select=title,session_type,session_date,duration_minutes,distance_km,sport,status&order=session_date.asc&limit=50`),
      sbSelect(`activities?user_id=eq.${idf}&select=start_date,sport_type,activity_type,source,distance_meters,moving_time_seconds,average_cadence,trainer,raw_data&order=start_date.desc&limit=8`),
      sbSelect(`provider_accounts?user_id=eq.${idf}&select=provider,last_sync_at,last_sync_status`)
    ]);
  return {
    profile: profile[0] || {},
    metrics: metrics[0] || {},
    weeklySummary: weekly[0] || {},
    readiness: readiness[0] || {},
    trainingSessions: today,
    activities: latestAct,
    providerAccount: provider[0] || {}
  };
}

function readinessScoreFrom(rd) {
  if (!rd) return null;
  const energy = Number(rd.energy);
  const soreness = Number(rd.muscle_soreness);
  const stress = Number(rd.mental_stress);
  const sleep = Number(rd.sleep_quality);
  const parts = [];
  if (Number.isFinite(energy)) parts.push((energy / 10) * 100);
  if (Number.isFinite(soreness)) parts.push(((11 - soreness) / 10) * 100);
  if (Number.isFinite(stress)) parts.push(((11 - stress) / 10) * 100);
  if (Number.isFinite(sleep)) parts.push((sleep / 5) * 100);
  if (!parts.length) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

function todaySession(sessions, nowIso) {
  const today = String(nowIso).slice(0, 10);
  return (sessions || []).find(s => String(s.session_date || "").slice(0, 10) === today) || null;
}

function buildSnapshot(bundle, nowIso) {
  const rd = bundle.readiness || {};
  const w = bundle.weeklySummary || {};
  const prov = bundle.providerAccount || {};
  const acts = bundle.activities || [];
  const lastActivityAt = acts.length ? acts[0].start_date : null;
  const lastReadinessAt = rd.readiness_date ? rd.readiness_date + "T12:00:00Z" : null;
  const lastSyncAt = prov.last_sync_at || null;
  const lastActiveAt = deriveLastActiveAt([lastActivityAt, lastReadinessAt, lastSyncAt]);

  return {
    lastActivityAt,
    lastReadinessAt,
    lastActiveAt,
    lastSyncAt,
    readiness: {
      painPresent: rd.pain_present === true,
      painDate: rd.readiness_date || null,
      readinessScore: readinessScoreFrom(rd),
      checkInDate: rd.readiness_date || null
    },
    recoveryStatus: w.recovery_status || "unknown",
    targetEventDate: null,
    syncFailed: String(prov.last_sync_status || "").toLowerCase() === "failed",
    planMissing: !(bundle.trainingSessions && bundle.trainingSessions.length),
    hasAnyData: Boolean(lastActivityAt || lastReadinessAt || (bundle.metrics && bundle.metrics.last_updated))
  };
}

function sendJson(res, code, body) { return res.status(code).json(body); }

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function getCoachingUser(token) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: key }
  });
  if (!r.ok) return null;
  return r.json();
}

async function actionCoachingDashboardRoster(request, response) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return sendJson(response, 500, { error: "Server is not configured." });

  const tok = bearer(request);
  if (!tok) return sendJson(response, 401, { error: "Authentication is required." });
  const user = await getCoachingUser(tok);
  if (!user || !user.id) return sendJson(response, 401, { error: "Your session is invalid or expired." });

  const profile = await loadCoachProfile(user.id);
  if (!canAccessCoachDashboard(profile)) {
    return sendJson(response, 403, { error: "Coach access is required.", role: resolveRole(profile) });
  }
  const assignments = await loadActiveAssignments(user.id);
  const nowIso = new Date().toISOString();

  try {
    const ids = assignedAthleteIds(assignments, user.id);
    if (!ids.length) {
      return sendJson(response, 200, { role: resolveRole(profile), athletes: [], roster_size: 0 });
    }
    const reviews = await sbSelect(
      `coach_attention_reviews?coach_id=eq.${enc(user.id)}&select=athlete_id,alert_key,reviewed_at`
    );
    const athletes = [];
    for (const athleteId of ids) {
      const bundle = await loadAthleteBundle(athleteId);
      const snapshot = buildSnapshot(bundle, nowIso);
      const attention = classifyAttention(snapshot, { now: nowIso });
      const entry = buildRosterEntry({
        profile: bundle.profile,
        metrics: bundle.metrics,
        weeklySummary: bundle.weeklySummary,
        readiness: { readinessScore: snapshot.readiness.readinessScore, pain_present: snapshot.readiness.painPresent },
        todaySession: todaySession(bundle.trainingSessions, nowIso),
        latestActivity: (bundle.activities || [])[0] || null,
        providerAccount: { last_sync_at: bundle.providerAccount.last_sync_at, last_sync_status: bundle.providerAccount.last_sync_status },
        attention,
        lastActiveAt: snapshot.lastActiveAt
      });
      entry.reviewed_alert_keys = reviews
        .filter(r => String(r.athlete_id) === String(athleteId))
        .map(r => r.alert_key);
      athletes.push(entry);
    }
    return sendJson(response, 200, { role: resolveRole(profile), athletes, roster_size: athletes.length });
  } catch (err) {
    return sendJson(response, 500, { error: "The coach dashboard could not load." });
  }
}

async function actionCoachingDashboardAthlete(request, response) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return sendJson(response, 500, { error: "Server is not configured." });

  const tok = bearer(request);
  if (!tok) return sendJson(response, 401, { error: "Authentication is required." });
  const user = await getCoachingUser(tok);
  if (!user || !user.id) return sendJson(response, 401, { error: "Your session is invalid or expired." });

  const profile = await loadCoachProfile(user.id);
  if (!canAccessCoachDashboard(profile)) {
    return sendJson(response, 403, { error: "Coach access is required.", role: resolveRole(profile) });
  }
  const assignments = await loadActiveAssignments(user.id);
  const nowIso = new Date().toISOString();

  try {
    const athleteId = request.query && (request.query.athlete_id || request.query.athleteId);
    if (!athleteId) return sendJson(response, 400, { error: "athlete_id is required." });
    if (!canCoachAccessAthlete(assignments, user.id, athleteId)) {
      return sendJson(response, 403, { error: "You are not assigned to this athlete." });
    }
    const bundle = await loadAthleteBundle(athleteId);
    const snapshot = buildSnapshot(bundle, nowIso);
    const attention = classifyAttention(snapshot, { now: nowIso });
    const overview = buildAthleteOverview({
      profile: bundle.profile,
      readiness: { readinessScore: snapshot.readiness.readinessScore, pain_present: snapshot.readiness.painPresent, readiness_date: bundle.readiness.readiness_date },
      weeklySummary: bundle.weeklySummary,
      recentActivities: bundle.activities,
      todaySession: todaySession(bundle.trainingSessions, nowIso),
      attention,
      lastSyncAt: snapshot.lastSyncAt,
      lastActiveAt: snapshot.lastActiveAt
    });
    return sendJson(response, 200, { athlete: overview });
  } catch (err) {
    return sendJson(response, 500, { error: "The coach dashboard could not load." });
  }
}

async function actionCoachingDashboardReview(request, response) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return sendJson(response, 500, { error: "Server is not configured." });

  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });

  const tok = bearer(request);
  if (!tok) return sendJson(response, 401, { error: "Authentication is required." });
  const user = await getCoachingUser(tok);
  if (!user || !user.id) return sendJson(response, 401, { error: "Your session is invalid or expired." });

  const profile = await loadCoachProfile(user.id);
  if (!canAccessCoachDashboard(profile)) {
    return sendJson(response, 403, { error: "Coach access is required.", role: resolveRole(profile) });
  }
  const assignments = await loadActiveAssignments(user.id);
  const nowIso = new Date().toISOString();

  try {
    const body = request.body || {};
    const athleteId = body.athlete_id;
    const alertKey = body.alert_key;
    if (!athleteId || !alertKey) return sendJson(response, 400, { error: "athlete_id and alert_key are required." });
    if (!canCoachAccessAthlete(assignments, user.id, athleteId)) {
      return sendJson(response, 403, { error: "You are not assigned to this athlete." });
    }
    const r = await fetch(
      `${url}/rest/v1/coach_attention_reviews?on_conflict=coach_id,athlete_id,alert_key`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify({
          coach_id: user.id,
          athlete_id: athleteId,
          alert_key: String(alertKey),
          reviewed_at: nowIso
        })
      }
    );
    if (!r.ok) return sendJson(response, 500, { error: "Could not record the review." });
    return sendJson(response, 200, { reviewed: true });
  } catch (err) {
    return sendJson(response, 500, { error: "The coach dashboard could not load." });
  }
}

/* ═══════════════════ ATHLETE MODE actions ══════════════════════════ */

/*
 * Consolidated from the former api/athlete-mode.js. Actions are namespaced
 * as athlete_coaching_mode and athlete_request_adjustment. Security
 * invariants are IDENTICAL: the athlete may only see their own assignment,
 * scoped to user.id; coach email/tokens/business fields are never returned.
 */

async function actionAthleteCoachingMode(request, response) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return sendJson(response, 500, { error: "Server is not configured." });

  const tok = bearer(request);
  if (!tok) return sendJson(response, 401, { error: "Authentication is required." });
  const user = await getCoachingUser(tok);
  if (!user || !user.id) return sendJson(response, 401, { error: "Your session is invalid or expired." });

  const assignments = await sbSelect(
    `coach_athlete_assignments?athlete_id=eq.${enc(user.id)}` +
      `&select=id,coach_id,athlete_id,status,assigned_at`
  );
  const resolved = resolveCoachingMode(assignments, user.id);

  try {
    let coach = null;
    let transition = null;
    if (resolved.mode === "human_coached" && resolved.coachId) {
      const rows = await sbSelect(
        `profiles?id=eq.${enc(resolved.coachId)}&select=full_name,coaching_title`
      );
      coach = buildSafeCoachProfile(rows[0] || {}, resolved.assignment);
      const tr = await sbSelect(
        `coaching_transitions?athlete_id=eq.${enc(user.id)}&coach_id=eq.${enc(resolved.coachId)}` +
          `&state=neq.resolved&select=state,effective_date,ai_plan_detected&limit=1`
      );
      transition = tr[0] || null;
    }
    return sendJson(response, 200, {
      coaching_mode: resolved.mode,
      assignment_status: resolved.assignment ? resolved.assignment.status : "none",
      ambiguous: resolved.ambiguous,
      coach,
      transition
    });
  } catch (err) {
    return sendJson(response, 500, { error: "Could not load your coaching status." });
  }
}

async function actionAthleteRequestAdjustment(request, response) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return sendJson(response, 500, { error: "Server is not configured." });

  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });

  const tok = bearer(request);
  if (!tok) return sendJson(response, 401, { error: "Authentication is required." });
  const user = await getCoachingUser(tok);
  if (!user || !user.id) return sendJson(response, 401, { error: "Your session is invalid or expired." });

  const assignments = await sbSelect(
    `coach_athlete_assignments?athlete_id=eq.${enc(user.id)}` +
      `&select=id,coach_id,athlete_id,status,assigned_at`
  );
  const resolved = resolveCoachingMode(assignments, user.id);

  try {
    if (resolved.mode !== "human_coached") {
      return sendJson(response, 400, { error: "Adjustment requests are only available when a coach manages your plan." });
    }
    const body = stripClientAuthorityFields(request.body || {});
    const requestType = String(body.request_type || "adjustment");
    const allowed = ["adjustment", "unable_to_complete", "move", "feedback", "availability"];
    const safeType = allowed.includes(requestType) ? requestType : "adjustment";
    const row = {
      athlete_id: user.id,
      coach_id: resolved.coachId,
      session_date: body.session_date || null,
      origin: "athlete_request",
      request_type: safeType,
      status: "pending",
      payload: body.payload && typeof body.payload === "object" ? body.payload : null,
      created_by: user.id
    };
    const r = await fetch(`${url}/rest/v1/managed_plan_change_requests`, {
      method: "POST",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json", Prefer: "return=minimal"
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) return sendJson(response, 500, { error: "Your request could not be sent. Please try again." });
    return sendJson(response, 200, { requested: true, request_type: safeType });
  } catch (err) {
    return sendJson(response, 500, { error: "Could not load your coaching status." });
  }
}

/* ═══════════════════════════════ router ══════════════════════════════ */

/* ─────────────────── admin: beta analytics (GET) ─────────────────────
 *
 * Founder-only aggregate view, authorized SERVER-SIDE against the
 * ADMIN_USER_IDS allowlist. A normal athlete's token → 403. The service role
 * reads activation_events across users; only counts/rates are returned — no
 * individual workout, chat, token, email or name. Lives here (not a separate
 * function) purely to respect the Vercel Hobby 12-function budget. */
async function actionAdminAnalytics(request, response) {
  const ADMIN_USER_IDS = String(process.env.ADMIN_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const user = await requireUser(request);
  if (!user || !user.id) return response.status(401).json({ error: "Authentication required." });
  if (ADMIN_USER_IDS.length === 0 || !ADMIN_USER_IDS.includes(user.id)) {
    return response.status(403).json({ error: "Not authorized." });
  }
  const url = process.env.SUPABASE_URL;
  const r = await fetch(
    `${url}/rest/v1/activation_events?select=user_id,event_name,occurred_at,metadata&order=occurred_at.desc&limit=100000`,
    { headers: sbHeaders() });
  const rows = r.ok ? await r.json() : [];
  const list = Array.isArray(rows) ? rows : [];
  const now = Date.now();
  const segments = classifySegments(list, now);
  const segmentCounts = {};
  Object.keys(segments).forEach(k => (segmentCounts[k] = segments[k].count));   // counts only
  return response.status(200).json({
    ok: true, generatedAt: new Date(now).toISOString(),
    topline: topline(list), active: activeUsers(list, now),
    funnel: buildFunnel(list), retention: computeRetention(list, now),
    failures: recentFailures(list, now), segments: segmentCounts
  });
}

/* ═══════════════════════ ACTION: delete_account ════════════════════════
 *
 * Permanently deletes the authenticated user's account and ALL associated
 * data. Identity is resolved exclusively from the verified bearer token —
 * any user_id, email, or profile ID in the request body is ignored.
 *
 * Deletion order:
 *   1. Revoke external provider tokens (Strava, Intervals.icu)
 *   2. Remove stored provider credentials
 *   3. Delete relationship rows (coach_athlete_assignments, etc.)
 *   4. Delete user-owned rows from every data table
 *   5. Delete public.profiles
 *   6. Delete auth.users entry (last — only if all above succeeded)
 *
 * Idempotent: missing rows count as already deleted, not failures.
 * If a critical stage fails, the Auth account is NOT deleted so the
 * operation can be retried.
 */

async function actionDeleteAccount(request, response) {
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required." });

  const userId = user.id;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return response.status(500).json({ error: "Server configuration error." });

  const errors = [];

  /* ── Helper: delete rows from a table by a column ────────────────── */
  async function deleteFrom(table, column, value) {
    try {
      const res = await fetch(
        `${url}/rest/v1/${encodeURIComponent(table)}?${encodeURIComponent(column)}=eq.${encodeURIComponent(value)}`,
        { method: "DELETE", headers: { ...sbHeaders(), Prefer: "return=minimal" } }
      );
      if (!res.ok && res.status !== 404) {
        errors.push({ table, column, status: res.status });
      }
    } catch (e) {
      errors.push({ table, column, error: e.message });
    }
  }

  /* ── Helper: SET NULL a column where it matches userId ───────────── */
  async function setNullWhere(table, column, value) {
    try {
      const res = await fetch(
        `${url}/rest/v1/${encodeURIComponent(table)}?${encodeURIComponent(column)}=eq.${encodeURIComponent(value)}`,
        {
          method: "PATCH",
          headers: { ...sbHeaders(), Prefer: "return=minimal" },
          body: JSON.stringify({ [column]: null })
        }
      );
      if (!res.ok && res.status !== 404) {
        errors.push({ table, column, status: res.status, op: "set_null" });
      }
    } catch (e) {
      errors.push({ table, column, error: e.message, op: "set_null" });
    }
  }

  /* ── Stage 1: Revoke external provider tokens ────────────────────── */
  const stage1Errors = [];

  // 1a. Revoke Strava
  try {
    const stravaRes = await fetch(
      `${url}/rest/v1/strava_accounts?user_id=eq.${encodeURIComponent(userId)}&select=access_token,refresh_token&limit=1`,
      { headers: sbHeaders() }
    );
    if (stravaRes.ok) {
      const rows = await stravaRes.json();
      const sa = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (sa && sa.access_token) {
        // Attempt Strava deauthorization
        try {
          await fetch("https://www.strava.com/oauth/deauthorize", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `access_token=${encodeURIComponent(sa.access_token)}`
          });
          // Best-effort: do not block deletion on Strava API failures
        } catch { /* Strava unreachable — continue */ }
      }
    }
  } catch (e) {
    stage1Errors.push({ provider: "strava", error: e.message });
  }

  // 1b. Revoke Intervals.icu (clear stored tokens — no revoke endpoint)
  try {
    const intRes = await fetch(
      `${url}/rest/v1/provider_accounts?user_id=eq.${encodeURIComponent(userId)}&provider=eq.intervals&select=id,access_token&limit=1`,
      { headers: sbHeaders() }
    );
    if (intRes.ok) {
      const rows = await intRes.json();
      const ia = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (ia) {
        await patchProviderAccount(ia.id, {
          access_token: null, refresh_token: null, status: "disconnected",
          provider_athlete_id: null
        });
      }
    }
  } catch (e) {
    stage1Errors.push({ provider: "intervals", error: e.message });
  }

  // Provider revocation is best-effort — failures do not block deletion.
  if (stage1Errors.length) {
    log("delete_account_provider_revoke_warnings", { count: stage1Errors.length });
  }

  /* ── Stage 1c: Cancel active Whop subscription ───────────────────── */
  try {
    const subRes = await fetch(
      `${url}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=provider,provider_subscription_id,status&limit=1`,
      { headers: sbHeaders() }
    );
    if (subRes.ok) {
      const rows = await subRes.json();
      const sub = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (
        sub &&
        sub.provider === "whop" &&
        sub.provider_subscription_id &&
        /^active|past_due$/.test(sub.status || "")
      ) {
        const whop = makeWhopClient();
        if (whop.isConfigured()) {
          const membershipId = sub.provider_subscription_id;
          const cancelRes = await whop.request(
            `/api/v5/app/memberships/${encodeURIComponent(membershipId)}/cancel`,
            { method: "POST" }
          );
          log("delete_account_whop_cancelled", { status: "ok" });
        }
        // If WHOP_API_KEY is not configured, log and continue — manual
        // GCash subscriptions or unconfigured environments skip this.
      }
    }
  } catch (e) {
    log("delete_account_whop_cancel_failed", { reason: e.message });
    return response.status(500).json({
      error: "Account deletion failed while cancelling your subscription. Your account has NOT been deleted. Please try again.",
      stage: "subscription_cancellation",
      retryable: true
    });
  }

  /* ── Stage 2: Delete relationship rows ───────────────────────────── */
  // coach_athlete_assignments: athlete_id, coach_id, created_by
  await deleteFrom("coach_athlete_assignments", "athlete_id", userId);
  await deleteFrom("coach_athlete_assignments", "coach_id", userId);
  await deleteFrom("coach_athlete_assignments", "created_by", userId);

  // coach_attention_reviews: athlete_id, coach_id
  await deleteFrom("coach_attention_reviews", "athlete_id", userId);
  await deleteFrom("coach_attention_reviews", "coach_id", userId);

  // coaching_transitions: athlete_id, coach_id
  await deleteFrom("coaching_transitions", "athlete_id", userId);
  await deleteFrom("coaching_transitions", "coach_id", userId);

  // managed_plan_change_requests: athlete_id, coach_id, created_by, reviewed_by
  await deleteFrom("managed_plan_change_requests", "athlete_id", userId);
  await deleteFrom("managed_plan_change_requests", "coach_id", userId);
  await deleteFrom("managed_plan_change_requests", "created_by", userId);
  await setNullWhere("managed_plan_change_requests", "reviewed_by", userId);

  // training_sessions: created_by, updated_by
  await deleteFrom("training_sessions", "created_by", userId);
  // Rows where updated_by = userId but created_by != userId: null the column
  await setNullWhere("training_sessions", "updated_by", userId);

  // coach_applications: reviewed_by → SET NULL (other accounts' applications)
  await setNullWhere("coach_applications", "reviewed_by", userId);

  if (errors.length) {
    log("delete_account_stage2_errors", { count: errors.length });
    return response.status(500).json({
      error: "Account deletion failed during relationship cleanup. Your account has NOT been deleted. Please try again.",
      stage: "relationships",
      retryable: true
    });
  }

  /* ── Stage 3: Delete user-owned rows from every data table ───────── */
  const userDataTables = [
    "activation_events",
    "activities",
    "activity_data_overrides",
    "activity_sync_logs",
    "athlete_memory",
    "athlevo_score_history",
    "beta_feedback",
    "coach_action_proposals",
    "coach_applications",
    "coach_conversations",
    "daily_coach_briefings",
    "daily_readiness",
    "pending_provider_connections",
    "provider_accounts",
    "race_results",
    "strava_accounts",
    "subscription_events",
    "subscriptions",
    "training_plans",
    "training_sessions",
    "trial_usage",
    "weekly_check_ins",
    "weekly_progress_summaries",
    "workout_execution_records",
  ];

  for (const table of userDataTables) {
    await deleteFrom(table, "user_id", userId);
  }

  if (errors.length) {
    log("delete_account_stage3_errors", { count: errors.length });
    return response.status(500).json({
      error: "Account deletion failed during data cleanup. Your account has NOT been deleted. Please try again.",
      stage: "user_data",
      retryable: true
    });
  }

  /* ── Stage 4: Delete public.profiles ─────────────────────────────── */
  await deleteFrom("profiles", "id", userId);

  if (errors.length) {
    log("delete_account_stage4_profile_error", { count: errors.length });
    return response.status(500).json({
      error: "Account deletion failed during profile cleanup. Your account has NOT been deleted. Please try again.",
      stage: "profile",
      retryable: true
    });
  }

  /* ── Stage 5: Delete auth.users entry (LAST) ─────────────────────── */
  try {
    const authRes = await fetch(
      `${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } }
    );
    if (!authRes.ok && authRes.status !== 404) {
      log("delete_account_auth_delete_failed", { httpStatus: authRes.status });
      return response.status(500).json({
        error: "Account deletion failed at the authentication stage. Your data has been removed but your login still exists. Please contact support.",
        stage: "auth",
        retryable: true
      });
    }
  } catch (e) {
    log("delete_account_auth_delete_error", { reason: e.message });
    return response.status(500).json({
      error: "Account deletion failed at the authentication stage. Please try again.",
      stage: "auth",
      retryable: true
    });
  }

  log("delete_account_complete", { status: "ok" });
  return response.status(200).json({ success: true, deleted: true });
}

export default async function handler(request, response) {
  const cid = newCorrelationId();
  const provider = String((request.query && request.query.provider) || "").toLowerCase();
  const action = String((request.query && request.query.action) || "").toLowerCase();

  try {
    // Provider-independent routes (folded in to save serverless slots).
    if (action === "delete_account") {
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionDeleteAccount(request, response);
    }

    if (action === "admin_analytics") {
      if (request.method !== "GET") { response.setHeader("Allow", "GET"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionAdminAnalytics(request, response);
    }

    // Coach Dashboard actions (consolidated from api/coach-dashboard.js).
    if (action === "coaching_dashboard_roster") {
      if (request.method !== "GET") { response.setHeader("Allow", "GET"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionCoachingDashboardRoster(request, response);
    }
    if (action === "coaching_dashboard_athlete") {
      if (request.method !== "GET") { response.setHeader("Allow", "GET"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionCoachingDashboardAthlete(request, response);
    }
    if (action === "coaching_dashboard_review") {
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionCoachingDashboardReview(request, response);
    }

    // Athlete Mode actions (consolidated from api/athlete-mode.js).
    if (action === "athlete_coaching_mode") {
      if (request.method !== "GET") { response.setHeader("Allow", "GET"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionAthleteCoachingMode(request, response);
    }
    if (action === "athlete_request_adjustment") {
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionAthleteRequestAdjustment(request, response);
    }

    /*
     * Terra remains DORMANT and flag-gated exactly as before — this file
     * absorbs the old api/terra endpoint without changing its behaviour.
     */
    if (provider === "terra") {
      if (process.env.WEARABLE_TERRA_ENABLED !== "true") {
        return response.status(404).json({ error: "Wearable provider not available." });
      }
      return response.status(501).json({ error: "Wearable provider is enabled but not configured in this build." });
    }

    if (provider !== "intervals") {
      return response.status(404).json({ error: "Unknown provider." });
    }
    if (!isIntervalsEnabled() && action !== "status") {
      return response.status(503).json({ error: "Intervals.icu isn't available right now.", code: "PROVIDER_NOT_CONFIGURED" });
    }

    // The callback is a browser redirect (GET); everything else is POST from
    // the app with a Supabase bearer token.
    if (action === "callback") {
      if (request.method !== "GET") { response.setHeader("Allow", "GET"); return response.status(405).json({ error: "Method not allowed." }); }
      return actionCallback(request, response, cid);
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return response.status(405).json({ error: "Method not allowed." });
    }

    if (action === "connect") return actionConnect(request, response, cid);
    if (action === "finalize") return actionFinalize(request, response, cid);
    if (action === "sync") return actionSync(request, response, cid);
    if (action === "trends") return actionTrends(request, response, cid);
    if (action === "diagnose") return actionDiagnose(request, response, cid);
    if (action === "reanalyze") return actionReanalyze(request, response, cid);
    if (action === "status") return actionStatus(request, response);
    if (action === "disconnect") return actionDisconnect(request, response, cid);

    return response.status(400).json({ error: "Unknown action." });
  } catch (error) {
    log("intervals_sync_failure", { correlationId: cid, provider, code: "UNHANDLED" });
    console.error("Provider gateway error:", {
      correlationId: cid,
      provider: provider === "intervals" ? "intervals" : "unsupported",
      action: [
        "connect", "callback", "finalize", "sync", "trends", "diagnose",
        "reanalyze", "status", "disconnect", "admin_analytics",
        "coaching_dashboard_roster", "coaching_dashboard_athlete",
        "coaching_dashboard_review", "athlete_coaching_mode",
        "athlete_request_adjustment", "delete_account"
      ].includes(action) ? action : "unsupported"
    });
    return response.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
