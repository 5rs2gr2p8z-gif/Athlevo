/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Cardless trial creation endpoint
 * ══════════════════════════════════════════════════════════════════════
 *
 *  POST /api/trial/start
 *
 *  Called once after onboarding completion. Creates a 3-day trial with
 *  no payment method required. Idempotent — calling again returns the
 *  existing trial without extending it.
 *
 *  Security:
 *    - Authenticated user derived from verified session token
 *    - User id comes from the token, never from the request body
 *    - Trial creation is a service-role RPC (not a direct table write)
 *    - Frontend cannot set trial dates or status
 *    - One trial per user, enforced by the database function
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

function send(res, code, body) { return res.status(code).json(body); }

function getBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

async function getAuthenticatedUser(accessToken) {
  if (!SUPABASE_URL || !SERVICE_KEY || !accessToken) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` }
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed." });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return send(res, 500, { error: "Server not configured." });
  }

  // 1. Authenticate — user id comes from the verified token, never the body.
  const token = getBearerToken(req);
  if (!token) return send(res, 401, { error: "Not authenticated." });

  const user = await getAuthenticatedUser(token);
  if (!user || !user.id) return send(res, 401, { error: "Invalid session." });

  try {
    // 2. Call the database RPC to create the trial (service role).
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/start_cardless_trial`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_user_id: user.id })
    });

    if (!rpcRes.ok) {
      const text = await rpcRes.text();
      console.error("[trial/start] RPC failed:", rpcRes.status, text);
      return send(res, 500, { error: "Could not start trial." });
    }

    const result = await rpcRes.json();

    // 3. Fire PostHog event (best-effort, never blocks the response).
    if (result && result.created === true) {
      try {
        const phKey  = process.env.POSTHOG_KEY;
        const phHost = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
        if (phKey) {
          fetch(phHost + "/capture/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: phKey,
              distinct_id: user.id,
              event: "trial_started",
              properties: {
                source: "cardless_trial",
                trial_days: 3,
                access_state: "trial_active"
              }
            })
          }).catch(() => {});
        }
      } catch (e) { /* analytics never blocks */ }
    }

    // 4. Return safe information to the client.
    return send(res, 200, {
      ok: true,
      created: result.created === true,
      reason: result.reason || null,
      access_state: result.created ? "trial_active" : (result.status === "trialing" ? "trial_active" : "existing"),
      trial_ends_at: result.trial_end || null,
      plan_id: result.plan_id || null
    });
  } catch (err) {
    console.error("[trial/start] Unexpected error:", err && err.message);
    return send(res, 500, { error: "Could not start trial." });
  }
}
