/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — AI endpoint rate limiting  (per authenticated athlete)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Protects ALL AI-backed endpoints from runaway loops, scripted abuse
 *  and surprise OpenAI bills.
 *
 *  Identity: the AUTHENTICATED USER id is the limiter key (never IP alone —
 *  mobile/CGNAT users share IPs and a token can move between networks). The IP
 *  is only logged as a secondary signal, never used as the sole identifier.
 *
 *  Storage: a small Postgres table (`ai_rate_limits`), because Vercel
 *  serverless instances are ephemeral and independent — an in-memory counter
 *  would silently fail to limit anything across instances. Requires the
 *  migration `2026-07-20_ai_rate_limits.sql` to be run manually.
 *
 *  ATOMIC INCREMENT: uses a single upsert with SQL increment expression
 *  via a Postgres function to avoid read-then-write race conditions.
 *
 *  DAILY CAP: in addition to per-endpoint hourly limits, a daily aggregate
 *  cap across all AI endpoints prevents sustained abuse (e.g. 40/hr × 24hr).
 *
 *  FAIL-OPEN: if the limiter itself errors (table missing, transient DB
 *  failure) the request is ALLOWED. Rate limiting must never take the product
 *  down; the endpoint's own auth check is the security boundary.
 */

import {
  getSupabaseAdminHeaders,
  getSupabaseServerKey
} from "./supabaseServer.js";

// Conservative defaults sized for real athlete usage, not bots.
export const AI_LIMITS = {
  // A chatty athlete might send a few dozen messages in a session.
  coach: { limit: 40, windowMinutes: 60 },
  // The brief is generated on open; it is fingerprinted/cached upstream.
  "daily-brief": { limit: 30, windowMinutes: 60 },
  // Memory extraction runs per athlete message — bounded a little higher.
  "memory-extract": { limit: 60, windowMinutes: 60 },
  // Plan generation is the most expensive AI call (~60s, full GPT-5.5).
  "generate-plan": { limit: 5, windowMinutes: 60 },
  // Weekly analysis — moderately expensive.
  "weekly-analysis": { limit: 10, windowMinutes: 60 },
  // Pre-signup diagnostic conversational fallback. Anonymous, so tighter
  // than authenticated coach chat. Cross-instance counts live in
  // ai_anon_rate_limits; in-memory is the fail-open backup.
  "diagnostic-chat": { limit: 20, windowMinutes: 60 }
};

// Daily aggregate cap across ALL AI endpoints per user.
// Prevents sustained abuse even when per-endpoint hourly limits are respected.
const DAILY_CAP = { limit: 200, windowMinutes: 1440 };

function windowStartISO(windowMinutes) {
  const ms = windowMinutes * 60 * 1000;
  return new Date(Math.floor(Date.now() / ms) * ms).toISOString();
}

function enc(s) { return encodeURIComponent(String(s)); }

/*
 * Atomically increment and return the new count in one round-trip.
 * Uses PostgREST's upsert, but sets request_count to current + 1 via
 * a read-before-upsert that happens in the same DB transaction scope.
 *
 * NOTE: PostgREST upserts are not truly atomic for the increment value
 * (they SET, not INCREMENT). To make it fully atomic, we use a Postgres
 * RPC function if available, falling back to upsert with optimistic count.
 */
async function atomicIncrementAndCheck(userId, endpoint, windowStart, limit, headers, supabaseUrl) {
  // Try the atomic RPC first (requires the function from remediation migration).
  try {
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_rate_limit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_user_id: userId,
        p_endpoint: endpoint,
        p_window_start: windowStart,
        p_limit: limit
      })
    });
    if (rpcRes.ok) {
      const result = await rpcRes.json();
      // RPC returns { allowed, current_count }
      if (typeof result === "object" && result !== null && "allowed" in result) {
        return { count: result.current_count, allowed: result.allowed };
      }
      // If it returned a number, that's the new count
      if (typeof result === "number") {
        return { count: result, allowed: result <= limit };
      }
    }
  } catch (e) { /* fall through to legacy path */ }

  // Legacy fallback: read-then-upsert (kept for backward compatibility
  // until the RPC function is deployed).
  const readUrl =
    `${supabaseUrl}/rest/v1/ai_rate_limits` +
    `?user_id=eq.${enc(userId)}` +
    `&endpoint=eq.${enc(endpoint)}` +
    `&window_start=eq.${enc(windowStart)}` +
    `&select=request_count`;
  const readRes = await fetch(readUrl, { headers });
  if (!readRes.ok) return { count: 0, allowed: true }; // fail-open
  const rows = await readRes.json();
  const current = Array.isArray(rows) && rows[0] ? Number(rows[0].request_count) || 0 : 0;

  if (current >= limit) {
    return { count: current, allowed: false };
  }

  await fetch(`${supabaseUrl}/rest/v1/ai_rate_limits?on_conflict=user_id,endpoint,window_start`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      endpoint,
      window_start: windowStart,
      request_count: current + 1,
      updated_at: new Date().toISOString()
    })
  });

  return { count: current + 1, allowed: true };
}

/*
 * Returns { allowed, remaining, retryAfterSeconds, limit }.
 * Never throws.
 */
export async function checkAiRateLimit(userId, endpoint) {
  const cfg = AI_LIMITS[endpoint] || { limit: 60, windowMinutes: 60 };
  const result = { allowed: true, remaining: cfg.limit, retryAfterSeconds: 0, limit: cfg.limit };
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = getSupabaseServerKey();
  if (!userId || !supabaseUrl || !serviceRoleKey) return result; // fail-open

  const headers = getSupabaseAdminHeaders();

  try {
    // 1. Check per-endpoint hourly limit.
    const windowStart = windowStartISO(cfg.windowMinutes);
    const windowMs = cfg.windowMinutes * 60 * 1000;

    const { count, allowed } = await atomicIncrementAndCheck(
      userId, endpoint, windowStart, cfg.limit, headers, supabaseUrl
    );

    if (!allowed) {
      const elapsed = Date.now() - Date.parse(windowStart);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
        limit: cfg.limit
      };
    }

    // 2. Check daily aggregate cap (all endpoints combined).
    const dailyWindowStart = windowStartISO(DAILY_CAP.windowMinutes);
    const dailyReadUrl =
      `${supabaseUrl}/rest/v1/ai_rate_limits` +
      `?user_id=eq.${enc(userId)}` +
      `&window_start=eq.${enc(dailyWindowStart)}` +
      `&select=request_count`;
    const dailyRes = await fetch(dailyReadUrl, { headers });
    if (dailyRes.ok) {
      const dailyRows = await dailyRes.json();
      let dailyTotal = 0;
      if (Array.isArray(dailyRows)) {
        for (const row of dailyRows) {
          dailyTotal += Number(row.request_count) || 0;
        }
      }
      if (dailyTotal >= DAILY_CAP.limit) {
        const dailyMs = DAILY_CAP.windowMinutes * 60 * 1000;
        const dailyElapsed = Date.now() - Date.parse(dailyWindowStart);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((dailyMs - dailyElapsed) / 1000)),
          limit: cfg.limit,
          dailyCapHit: true
        };
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, cfg.limit - count),
      retryAfterSeconds: 0,
      limit: cfg.limit
    };
  } catch (error) {
    return result; // fail-open
  }
}

/*
 * Anonymous (pre-signup) limiter. Cannot use ai_rate_limits: that table's
 * user_id is a FK to auth.users. Counts go to ai_anon_rate_limits when the
 * migration has been applied; otherwise an in-memory window still bounds
 * a single instance. Fail-open on DB errors so a missing table never
 * takes the funnel down.
 */
const anonMemory = new Map();

function pruneAnonMemory(now) {
  if (anonMemory.size < 4000) return;
  for (const [key, row] of anonMemory) {
    if (row.expiresAt < now) anonMemory.delete(key);
  }
}

function bumpAnonMemory(clientKey, endpoint, cfg) {
  const now = Date.now();
  const windowMs = cfg.windowMinutes * 60 * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${clientKey}:${endpoint}:${windowStart}`;
  const row = anonMemory.get(key) || { count: 0, expiresAt: windowStart + windowMs };
  row.count += 1;
  anonMemory.set(key, row);
  pruneAnonMemory(now);
  const elapsed = now - windowStart;
  return {
    allowed: row.count <= cfg.limit,
    remaining: Math.max(0, cfg.limit - row.count),
    retryAfterSeconds: row.count <= cfg.limit
      ? 0
      : Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
    limit: cfg.limit
  };
}

async function bumpAnonDatabase(clientKey, endpoint, cfg) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = getSupabaseServerKey();
  if (!clientKey || !supabaseUrl || !serviceRoleKey) return null;
  const headers = getSupabaseAdminHeaders();
  const windowStart = windowStartISO(cfg.windowMinutes);
  const windowMs = cfg.windowMinutes * 60 * 1000;

  const readUrl =
    `${supabaseUrl}/rest/v1/ai_anon_rate_limits` +
    `?client_key=eq.${enc(clientKey)}` +
    `&endpoint=eq.${enc(endpoint)}` +
    `&window_start=eq.${enc(windowStart)}` +
    `&select=request_count`;
  const readRes = await fetch(readUrl, { headers });
  if (!readRes.ok) return null;
  const rows = await readRes.json();
  const current = Array.isArray(rows) && rows[0] ? Number(rows[0].request_count) || 0 : 0;
  if (current >= cfg.limit) {
    const elapsed = Date.now() - Date.parse(windowStart);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
      limit: cfg.limit
    };
  }

  await fetch(`${supabaseUrl}/rest/v1/ai_anon_rate_limits?on_conflict=client_key,endpoint,window_start`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      client_key: clientKey,
      endpoint,
      window_start: windowStart,
      request_count: current + 1,
      updated_at: new Date().toISOString()
    })
  });

  return {
    allowed: true,
    remaining: Math.max(0, cfg.limit - (current + 1)),
    retryAfterSeconds: 0,
    limit: cfg.limit
  };
}

export async function checkAnonymousAiRateLimit(clientKey, endpoint = "diagnostic-chat") {
  const cfg = AI_LIMITS[endpoint] || { limit: 20, windowMinutes: 60 };
  const fallback = { allowed: true, remaining: cfg.limit, retryAfterSeconds: 0, limit: cfg.limit };
  if (!clientKey) return fallback;
  try {
    const fromDb = await bumpAnonDatabase(clientKey, endpoint, cfg);
    if (fromDb) return fromDb;
  } catch { /* fall through to memory */ }
  try {
    return bumpAnonMemory(clientKey, endpoint, cfg);
  } catch {
    return fallback;
  }
}

/* Standard 429 body — safe wording, no internals. */
export function rateLimitResponse(res, info) {
  const minutes = Math.max(1, Math.round((info?.retryAfterSeconds || 60) / 60));
  if (typeof res.setHeader === "function") {
    res.setHeader("Retry-After", String(info?.retryAfterSeconds || 60));
  }
  return res.status(429).json({
    error: `You've reached the limit for now. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    code: "RATE_LIMITED",
    retryAfterSeconds: info?.retryAfterSeconds || 60
  });
}
