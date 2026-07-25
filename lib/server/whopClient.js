/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Whop API client  (server-side ONLY)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  A thin, secure wrapper over the Whop REST API. The WHOP_API_KEY is read
 *  from the server environment and NEVER shipped to the browser. Its purpose
 *  is defense-in-depth: after a webhook arrives, the endpoint can RE-FETCH the
 *  membership straight from Whop and act on that authoritative state instead
 *  of trusting the webhook body (or the frontend) alone.
 *
 *  Fails soft: if Whop is unreachable, callers fall back to the (already
 *  signature-verified) webhook payload rather than dropping the event.
 */

const WHOP_API_BASE = process.env.WHOP_API_BASE || "https://api.whop.com";

export function makeWhopClient(apiKey) {
  const key = apiKey || process.env.WHOP_API_KEY || "";

  async function request(path, { method = "GET", body } = {}) {
    if (!key) throw new Error("WHOP_API_KEY not configured");
    const res = await fetch(`${WHOP_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,          // server-side secret only
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error(`Whop API ${res.status}`);
      err.status = res.status; err.body = data;
      throw err;
    }
    return data;
  }

  // Retrieve the authoritative membership. Tries the current API shape first,
  // then a legacy path — Whop has moved this endpoint across versions.
  async function getMembership(membershipId) {
    if (!membershipId) return null;
    const id = encodeURIComponent(membershipId);
    try { return await request(`/api/v5/app/memberships/${id}`); }
    catch (e1) {
      try { return await request(`/api/v2/memberships/${id}`); }
      catch (e2) { return null; }
    }
  }

  return { request, getMembership, isConfigured: () => Boolean(key) };
}

export const WHOP_CLIENT_VERSION = "whop-client-v1";
