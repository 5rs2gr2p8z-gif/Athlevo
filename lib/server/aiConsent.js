/*
 * Athlevo — canonical AI-processing consent gate (server-side).
 *
 * Every AI-backed endpoint (Coach, anonymous Coach, diagnostic chat, plan
 * generation, daily brief, memory extraction) must call requireAiConsent()
 * (authenticated) before spending any provider budget. This is the ONE
 * place that decides whether AI processing may run for a given request —
 * do not re-implement this check inline in an endpoint.
 *
 * Authenticated athletes: consent is read from public.ai_consent with the
 * service-role key. A client-supplied boolean is NEVER trusted for an
 * authenticated request — only the row this endpoint reads itself, so a
 * forged/omitted client flag cannot bypass the gate.
 *
 * Anonymous requests: there is no durable identity to attach consent to,
 * so acknowledgment is necessarily session/browser scoped (see
 * anonymousAiConsentGranted below). This is a deliberate, proportionate
 * limitation — do not attempt to build server-verifiable anonymous
 * identity for this.
 */

import { getSupabaseAdminHeaders } from "./supabaseServer.js";
import { captureServerEventBestEffort } from "./productAnalytics.js";

export const AI_CONSENT_VERSION = "1";
export const AI_CONSENT_REQUIRED_CODE = "AI_CONSENT_REQUIRED";

function headers() {
  return getSupabaseAdminHeaders();
}

/*
 * Reads the athlete's current AI consent row. Returns:
 *   { exists: false }                                  — no row (never consented)
 *   { exists: true, status, version, grantedAt, withdrawnAt }
 *   { exists: false, unavailable: true }                — Supabase unreachable
 * `unavailable` lets callers fail closed (deny AI processing) rather than
 * silently treating an outage as consent.
 */
export async function getAiConsentStatus(userId) {
  const url = process.env.SUPABASE_URL;
  const authHeaders = headers();
  if (!userId || !url || !authHeaders) {
    return { exists: false, unavailable: true };
  }
  try {
    const response = await fetch(
      `${url}/rest/v1/ai_consent?user_id=eq.${encodeURIComponent(userId)}` +
        "&select=status,consent_version,granted_at,withdrawn_at&limit=1",
      { headers: authHeaders }
    );
    if (!response.ok) return { exists: false, unavailable: true };
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { exists: false };
    return {
      exists: true,
      status: row.status,
      version: row.consent_version,
      grantedAt: row.granted_at,
      withdrawnAt: row.withdrawn_at
    };
  } catch (error) {
    return { exists: false, unavailable: true };
  }
}

/*
 * Authoritative gate for an authenticated AI-backed request.
 * Returns { allowed: true, status } or { allowed: false, reason, status }.
 * reason is "no_consent" | "denied" | "withdrawn" | "unavailable".
 *
 * `source` is one of the fixed analytics source values (anonymous_coach,
 * coach, plan_generation, daily_brief, memory, diagnostic) and is used only
 * to label the ai_request_blocked_no_consent analytics event — never to
 * change gating behavior.
 */
export async function requireAiConsent(userId, source) {
  const record = await getAiConsentStatus(userId);
  if (record.unavailable) {
    return { allowed: false, reason: "unavailable", status: null };
  }
  if (!record.exists || record.status !== "granted") {
    const reason = !record.exists
      ? "no_consent"
      : (record.status === "denied" ? "denied" : "withdrawn");
    captureServerEventBestEffort(userId, "ai_request_blocked_no_consent", {
      source: source || "unknown",
      consent_version: AI_CONSENT_VERSION
    });
    return { allowed: false, reason, status: record.exists ? record.status : null };
  }
  return { allowed: true, status: record.status };
}

/*
 * Sends the stable, machine-readable rejection for a gated authenticated
 * endpoint. Never exposes internal details (which table, why Supabase was
 * unavailable, etc.) — just the code the client already knows how to act
 * on (show the consent prompt again).
 */
export function sendAiConsentRequired(res, gate) {
  const status = gate && gate.reason === "unavailable" ? 503 : 403;
  return res.status(status).json({
    error: gate && gate.reason === "unavailable"
      ? "We couldn't verify AI processing consent right now. Please try again."
      : "AI-powered features are turned off. Enable them to continue.",
    code: AI_CONSENT_REQUIRED_CODE
  });
}

/*
 * Anonymous trust boundary: there is no authenticated profile, so we accept
 * a client-sent acknowledgment flag as proportionate for a stateless,
 * no-history, no-persistence anonymous request. This is NOT a substitute
 * for the authenticated gate above and must never be used to decide
 * anything for a signed-in user.
 */
export function anonymousAiConsentGranted(body) {
  return !!(body && (body.ai_consent === true || body.aiConsent === true));
}
