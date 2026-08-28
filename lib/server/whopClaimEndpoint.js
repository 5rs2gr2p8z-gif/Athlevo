/*
 * Authenticated claim of a server-verified unmatched Whop purchase.
 * Folded into /api/providers?action=claim_pending_purchase (Hobby function cap).
 *
 * The browser may only send a Bearer token. Email and membership ids in the
 * body are ignored. Paid access is written only by claim_pending_whop_entitlement.
 */

import { makeWhopClient } from "./whopClient.js";
import { mapWhopEvent } from "./whopWebhook.js";
import {
  logWhopPending,
  normalizeWhopEmail,
  pendingRowFromMapped,
  upsertPendingWhopEntitlement
} from "./whopPending.js";
import {
  captureServerEventBestEffort,
  paidActivationProperties
} from "./productAnalytics.js";

function send(response, status, payload) {
  return response.status(status).json(payload);
}

function serviceHeaders(url, key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

async function authenticatedUser(request, url, key) {
  const header = String(request.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }
  });
  return response.ok ? response.json() : null;
}

async function sbRest(url, key, path, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      ...serviceHeaders(url, key),
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`supabase ${response.status}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : [];
}

function planOpts() {
  let planMap = {};
  try { planMap = JSON.parse(process.env.WHOP_PLAN_MAP || "{}"); } catch (e) { planMap = {}; }
  return { planMap, fallbackPlan: process.env.WHOP_FALLBACK_PLAN || "performance" };
}

async function refreshPendingFromWhop(url, key, email) {
  const rows = await sbRest(
    url, key,
    "pending_whop_entitlements?email=eq." + encodeURIComponent(email) +
      "&claimed_at=is.null&select=whop_membership_id,last_provider_event_id&limit=5"
  );
  const list = Array.isArray(rows) ? rows : [];
  const whop = makeWhopClient();
  if (!whop.isConfigured() || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const membershipId = list[i] && list[i].whop_membership_id;
    if (!membershipId) continue;
    try {
      const fresh = await whop.getMembership(membershipId);
      if (!fresh) continue;
      const mapped = mapWhopEvent({ action: "membership.refreshed", data: fresh }, planOpts());
      if (!mapped || mapped.effect === "ignore") continue;
      const row = pendingRowFromMapped(mapped, list[i].last_provider_event_id);
      if (row) await upsertPendingWhopEntitlement(
        (path, opts) => sbRest(url, key, path, opts),
        row
      );
    } catch (e) { /* fall back to last signed webhook patch */ }
  }
}

async function callClaimRpc(url, key, userId, email) {
  const response = await fetch(`${url}/rest/v1/rpc/claim_pending_whop_entitlement`, {
    method: "POST",
    headers: serviceHeaders(url, key),
    body: JSON.stringify({ p_user_id: userId, p_email: email })
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  if (!response.ok) {
    const err = new Error("claim_rpc_failed");
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body && typeof body === "object" ? body : { ok: false, claimed: false, reason: "invalid_state" };
}

export default async function whopClaimHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return send(response, 500, { error: "Server not configured." });

  let user;
  try { user = await authenticatedUser(request, url, key); } catch (e) { user = null; }
  if (!user || !user.id) return send(response, 401, { error: "Authentication required." });

  const email = normalizeWhopEmail(user.email);
  if (!email) {
    logWhopPending("whop_pending_purchase_claim_failed", { reason: "no_pending_purchase" });
    return send(response, 200, { ok: true, claimed: false, reason: "no_pending_purchase" });
  }

  try {
    try { await refreshPendingFromWhop(url, key, email); } catch (e) { /* non-fatal */ }
    const result = await callClaimRpc(url, key, user.id, email);
    const reason = result && result.reason ? String(result.reason) : "invalid_state";
    const claimed = !!(result && result.claimed === true);

    if (claimed && (reason === "claimed" || reason === "already_claimed")) {
      if (reason === "claimed") {
        logWhopPending("whop_pending_purchase_claimed", {
          reason: "claimed",
          claimed: true,
          provider_subscription_id: result.membership_id || null
        });
        captureServerEventBestEffort(user.id, "whop_pending_purchase_claimed", {
          source: "whop_claim"
        });
        if (result.membership_id) {
          captureServerEventBestEffort(
            user.id,
            "subscription_activated",
            paidActivationProperties("whop_claim", "whop")
          );
        }
      }
      return send(response, 200, {
        ok: true,
        claimed: true,
        reason,
        membership_id: result.membership_id || null
      });
    }

    logWhopPending("whop_pending_purchase_claim_failed", { reason });
    captureServerEventBestEffort(user.id, "whop_pending_purchase_claim_failed", {
      source: "whop_claim",
      reason: reason.slice(0, 40)
    });
    return send(response, 200, { ok: true, claimed: false, reason });
  } catch (err) {
    logWhopPending("whop_pending_purchase_claim_failed", { reason: "invalid_state" });
    captureServerEventBestEffort(user.id, "whop_pending_purchase_claim_failed", {
      source: "whop_claim",
      reason: "invalid_state"
    });
    return send(response, 500, { error: "Claim failed." });
  }
}
