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
import { mapIntervals, normalizeIntervalLaps, toActivityRow } from "../../lib/server/wearable/normalizer.js";
import { resolveDuplicates, mapProviderError, isIntervalsEnabled } from "../../lib/server/wearable/providers.js";
import {
  INTERVALS_AUTHORIZE_URL,
  INTERVALS_TOKEN_URL,
  INTERVALS_API_BASE,
  INTERVALS_SCOPE,
  STATE_MAX_AGE_MS,
  getIntervalsRedirectUri,
  getAppReturnOrigin,
  isIntervalsConfigured
} from "../../lib/server/wearable/intervalsConfig.js";

/* ───────────────────────────── logging ──────────────────────────────── */

/*
 * Structured, privacy-safe logs. The allowlist below is the ONLY thing that
 * can ever be logged — tokens, codes, secrets and activity payloads are not
 * on it, so they cannot leak through a careless call site.
 */
const LOG_SAFE = new Set([
  "event", "correlationId", "provider", "status", "code", "httpStatus",
  "imported", "skipped", "failed", "duplicatesMarked", "windows",
  "durationMs", "reason", "hasLaps", "oldest", "newest"
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

/* ────────────────────────── signed OAuth state ──────────────────────── */

function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/*
 * Verifies signature FIRST (constant-time), then expiry, then shape. An
 * unsigned or tampered state can never reach the JSON parse, and a valid
 * signature on an expired payload is still rejected.
 */
function verifyState(state, secret) {
  if (!state || !secret) return null;
  const parts = String(state).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.userId || !payload.issuedAt) return null;
    if (Date.now() - payload.issuedAt > STATE_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
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

async function intervalsFetch(path, accessToken) {
  const res = await fetch(`${INTERVALS_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error("unauthorized");
    err.authExpired = true;
    throw err;
  }
  if (res.status === 429) {
    const err = new Error("rate limit");
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Intervals.icu request failed (${res.status}).`);
  return res.json();
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
  const state = signState(
    { userId: user.id, provider: "intervals", issuedAt: Date.now(), nonce: crypto.randomBytes(16).toString("hex") },
    process.env.OAUTH_STATE_SECRET
  );

  const authorizeUrl = new URL(INTERVALS_AUTHORIZE_URL);
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
  const backToApp = (status, message) => {
    const target = new URL(`${origin}/index.html`);
    target.searchParams.set("intervals", status);
    if (message) target.searchParams.set("message", message);
    response.setHeader("Location", target.toString());
    return response.status(302).end();
  };

  const q = request.query || {};

  // The athlete declined on Intervals.icu — not an error, just a choice.
  if (q.error) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "ACCESS_DENIED" });
    return backToApp("cancelled", "Intervals.icu connection was cancelled.");
  }

  const payload = verifyState(q.state, process.env.OAUTH_STATE_SECRET);
  if (!payload) {
    // Covers tampered, forged, replayed-after-expiry and missing state.
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "INVALID_STATE" });
    return backToApp("failed", "That connection link expired. Please try connecting again.");
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
  const owner = await findOwnerByProviderAthlete("intervals", athleteId);
  if (!owner.ok) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "OWNERSHIP_LOOKUP" });
    return backToApp("failed", "We couldn't save the connection just now. Please try again in a moment.");
  }
  if (owner.userId && owner.userId !== String(payload.userId)) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "ALREADY_LINKED" });
    return backToApp("failed", "This Intervals.icu account is already connected to another Athlevo account.");
  }

  const saved = await upsertProviderAccount({
    user_id: payload.userId,
    provider: "intervals",
    provider_athlete_id: athleteId,
    access_token: token.access_token,
    // Documented: Intervals.icu issues long-lived access tokens and does NOT
    // use refresh tokens. Storing nulls is honest rather than inventing a
    // refresh cycle that the provider has no endpoint for.
    refresh_token: null,
    token_expires_at: null,
    scope: token.scope || INTERVALS_SCOPE,
    status: "connected",
    connected_at: new Date().toISOString()
  });

  if (!saved) {
    log("intervals_oauth_failure", { correlationId: cid, provider: "intervals", code: "PERSIST" });
    return backToApp("failed", "We connected to Intervals.icu but couldn't save it. Please try again.");
  }

  log("intervals_oauth_success", { correlationId: cid, provider: "intervals" });
  return backToApp("connected");
}

/* ═════════════════════════════ ACTION: sync ══════════════════════════ */

// Bounded windows: never an unbounded full-history fetch.
const FIRST_SYNC_DAYS = 180;   // initial import horizon
const OVERLAP_DAYS = 3;        // re-check recent days for late edits
const MAX_WINDOW_DAYS = 90;    // Intervals.icu range chunk
const MAX_WINDOWS = 3;         // hard ceiling per sync call
const MAX_LAP_FETCHES = 30;    // per sync — one extra request per activity
const SYNC_LOCK_MS = 5 * 60 * 1000;

async function actionSync(request, response, cid) {
  const started = Date.now();
  const user = await requireUser(request);
  if (!user?.id) return response.status(401).json({ error: "Authentication is required." });

  const account = await readProviderAccount(user.id, "intervals");
  if (!account) {
    return response.status(404).json({ error: "No Intervals.icu account is connected.", code: "NOT_CONNECTED" });
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

    for (const range of ranges) {
      windows += 1;
      const activities = await intervalsFetch(
        `/athlete/0/activities?oldest=${range.oldest}&newest=${range.newest}`,
        account.access_token
      );
      if (!Array.isArray(activities)) continue;

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

          const row = toActivityRow(user.id, workout, raw);
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
    log(event, { correlationId: cid, provider: "intervals", imported, failed, duplicatesMarked, windows, durationMs: Date.now() - started });

    return response.status(200).json({
      success: true, provider: "intervals",
      imported, failed, withLaps, duplicatesMarked,
      status: failed > 0 ? "partial" : "success"
    });
  } catch (error) {
    // Always release the lock, then report a neutral, actionable message.
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
    access_token: null, refresh_token: null, status: "disconnected"
  });
  log("intervals_disconnect", { correlationId: cid, provider: "intervals", status: ok ? "ok" : "failed" });
  return response.status(ok ? 200 : 500).json(
    ok ? { success: true, provider: "intervals" }
       : { error: "Couldn't disconnect just now. Please try again." }
  );
}

/* ═══════════════════════════════ router ══════════════════════════════ */

export default async function handler(request, response) {
  const cid = newCorrelationId();
  const provider = String((request.query && request.query.provider) || "").toLowerCase();
  const action = String((request.query && request.query.action) || "").toLowerCase();

  try {
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
    if (action === "sync") return actionSync(request, response, cid);
    if (action === "status") return actionStatus(request, response);
    if (action === "disconnect") return actionDisconnect(request, response, cid);

    return response.status(400).json({ error: "Unknown action." });
  } catch (error) {
    log("intervals_sync_failure", { correlationId: cid, provider, code: "UNHANDLED" });
    console.error("Provider gateway error:", { correlationId: cid, provider, action });
    return response.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
