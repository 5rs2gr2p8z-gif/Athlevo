import { createClient } from "@supabase/supabase-js";

const AUTH_VERIFY_TIMEOUT_MS = 6000;

export function getSupabaseServerKey() {
  return process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    null;
}

/*
 * PostgREST accepts legacy service_role JWTs as both apikey and Bearer
 * credentials. Supabase's current sb_secret_ keys are intentionally opaque:
 * they belong in apikey only and must never be presented as a JWT.
 */
export function getSupabaseAdminHeaders(extra = {}) {
  const key = getSupabaseServerKey();
  if (!key) return null;
  const result = {
    apikey: key,
    "Content-Type": "application/json",
    ...extra
  };
  if (key.startsWith("sb_secret_")) {
    delete result.Authorization;
    delete result.authorization;
  } else {
    result.Authorization = `Bearer ${key}`;
  }
  return result;
}

function isDefinitiveAuthRejection(error) {
  const status = Number(error?.status);
  const code = String(error?.code || "").toLowerCase();
  return status === 401 || status === 403 ||
    code === "bad_jwt" ||
    code === "session_not_found" ||
    code === "refresh_token_not_found" ||
    code === "refresh_token_already_used";
}

/*
 * Verify the bearer token with Supabase Auth itself. JWT claims are never
 * trusted from a local decode, and no long-lived server client/session is
 * shared between serverless requests.
 */
export async function verifySupabaseAccessToken(accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = getSupabaseServerKey();
  if (!accessToken) return { ok: false, reason: "invalid" };
  if (!url || !key) return { ok: false, reason: "unavailable" };

  try {
    const client = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    });
    const verification = await Promise.race([
      client.auth.getUser(accessToken),
      new Promise(resolve => setTimeout(() => resolve({
        data: { user: null },
        error: { message: "auth_verification_timeout", status: 0 }
      }), AUTH_VERIFY_TIMEOUT_MS))
    ]);
    if (!verification?.error && verification?.data?.user?.id) {
      return { ok: true, user: verification.data.user };
    }
    return {
      ok: false,
      reason: isDefinitiveAuthRejection(verification?.error)
        ? "invalid"
        : "unavailable"
    };
  } catch (error) {
    return { ok: false, reason: "unavailable" };
  }
}
