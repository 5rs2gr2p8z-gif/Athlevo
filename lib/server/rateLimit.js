/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — AI endpoint rate limiting  (per authenticated athlete)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Protects the AI-backed endpoints (coach, daily-brief, memory/extract) from
 *  runaway loops, scripted abuse and surprise OpenAI bills.
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
 *  FAIL-OPEN: if the limiter itself errors (table missing, transient DB
 *  failure) the request is ALLOWED. Rate limiting must never take the product
 *  down; the endpoint's own auth check is the security boundary.
 */

// Conservative defaults sized for real athlete usage, not bots.
export const AI_LIMITS = {
  // A chatty athlete might send a few dozen messages in a session.
  coach: { limit: 40, windowMinutes: 60 },
  // The brief is generated on open; it is fingerprinted/cached upstream.
  "daily-brief": { limit: 30, windowMinutes: 60 },
  // Memory extraction runs per athlete message — bounded a little higher.
  "memory-extract": { limit: 60, windowMinutes: 60 }
};

function windowStartISO(windowMinutes) {
  const ms = windowMinutes * 60 * 1000;
  return new Date(Math.floor(Date.now() / ms) * ms).toISOString();
}

/*
 * Returns { allowed, remaining, retryAfterSeconds, limit }.
 * Never throws.
 */
export async function checkAiRateLimit(userId, endpoint) {
  const cfg = AI_LIMITS[endpoint] || { limit: 60, windowMinutes: 60 };
  const result = { allowed: true, remaining: cfg.limit, retryAfterSeconds: 0, limit: cfg.limit };
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!userId || !supabaseUrl || !serviceRoleKey) return result; // fail-open

  const windowStart = windowStartISO(cfg.windowMinutes);
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json"
  };

  try {
    // Read the current count for this window.
    const readUrl =
      `${supabaseUrl}/rest/v1/ai_rate_limits` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&endpoint=eq.${encodeURIComponent(endpoint)}` +
      `&window_start=eq.${encodeURIComponent(windowStart)}` +
      `&select=request_count`;
    const readRes = await fetch(readUrl, { headers });
    if (!readRes.ok) return result; // fail-open
    const rows = await readRes.json();
    const current = Array.isArray(rows) && rows[0] ? Number(rows[0].request_count) || 0 : 0;

    if (current >= cfg.limit) {
      const windowMs = cfg.windowMinutes * 60 * 1000;
      const elapsed = Date.now() - Date.parse(windowStart);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
        limit: cfg.limit
      };
    }

    // Increment (upsert on the composite primary key).
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

    return { allowed: true, remaining: Math.max(0, cfg.limit - (current + 1)), retryAfterSeconds: 0, limit: cfg.limit };
  } catch (error) {
    return result; // fail-open
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
    retryAfterSeconds: info?.retryAfterSeconds || 60
  });
}
