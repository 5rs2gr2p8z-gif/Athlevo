/*
 * Athlevo — unmatched Whop purchase persistence helpers.
 *
 * Pure mapping + PostgREST writes used by the signed webhook and the
 * authenticated claim endpoint. Never trusts the browser.
 */

export function normalizeWhopEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  return value || null;
}

export function isGrantableWhopStatus(status) {
  return String(status || "").toLowerCase() === "active";
}

export function pendingRowFromMapped(mapped, providerEventId, nowIso) {
  const patch = (mapped && mapped.patch) || {};
  const email = normalizeWhopEmail(mapped && mapped.email);
  const membershipId = mapped && mapped.membershipId ? String(mapped.membershipId) : null;
  if (!email || !membershipId) return null;
  const stamp = nowIso || new Date().toISOString();
  return {
    email,
    whop_membership_id: membershipId,
    whop_customer_id: mapped.customerId || patch.provider_customer_id || null,
    whop_plan_id: patch.provider_price_id || null,
    plan_id: mapped.planId || patch.plan_id || "performance",
    effect: mapped.effect || "activate",
    event_type: mapped.event_type || null,
    status: patch.status || "expired",
    current_period_start: patch.current_period_start || null,
    current_period_end: patch.current_period_end || null,
    cancel_at_period_end: patch.cancel_at_period_end === true,
    cancelled_at: patch.cancelled_at || null,
    billing_interval: patch.billing_interval || "none",
    subscription_patch: patch,
    metadata: patch.metadata || {},
    last_provider_event_id: providerEventId || null,
    updated_at: stamp
  };
}

export function logWhopPending(event, fields) {
  const payload = {
    event,
    provider: "whop",
    occurred_at: new Date().toISOString()
  };
  if (fields && typeof fields === "object") {
    const keys = [
      "reason", "provider_event_id", "provider_subscription_id",
      "checkout_email", "webhook_action", "claimed"
    ];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (fields[key] != null && fields[key] !== "") payload[key] = fields[key];
    }
  }
  console.warn("[whop] " + JSON.stringify(payload));
}

export async function upsertPendingWhopEntitlement(sbRest, row) {
  if (!row || !row.whop_membership_id) return null;
  const rows = await sbRest("pending_whop_entitlements?on_conflict=whop_membership_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: row
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function markPendingWhopClaimed(sbRest, membershipId, userId) {
  if (!membershipId || !userId) return false;
  const stamp = new Date().toISOString();
  await sbRest(
    "pending_whop_entitlements?whop_membership_id=eq." + encodeURIComponent(String(membershipId)) +
      "&claimed_at=is.null",
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        claimed_user_id: userId,
        claimed_at: stamp,
        updated_at: stamp
      }
    }
  );
  return true;
}
