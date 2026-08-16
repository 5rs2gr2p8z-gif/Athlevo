/* Shared handler behind /api/paymongo/checkout and the consolidated gateway. */

import crypto from "node:crypto";
import {
  ATHLEVO_PERFORMANCE_PRODUCT,
  buildCheckoutAttributes,
  configuredPaymentMethods,
  makePaymongoClient
} from "./paymongoClient.js";

function send(response, status, payload) { return response.status(status).json(payload); }

function serviceHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" };
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

async function loadProduct(url, key) {
  const response = await fetch(
    `${url}/rest/v1/subscription_plans?id=eq.performance` +
      "&select=id,currency,monthly_price_cents,is_active&limit=1",
    { headers: serviceHeaders(key) }
  );
  if (!response.ok) throw new Error("Product catalog unavailable");
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || row.is_active !== true ||
      row.monthly_price_cents !== ATHLEVO_PERFORMANCE_PRODUCT.priceCents ||
      String(row.currency || "").toUpperCase() !== ATHLEVO_PERFORMANCE_PRODUCT.currency) {
    throw new Error("Performance product is not configured");
  }
  return ATHLEVO_PERFORMANCE_PRODUCT;
}

async function storePendingTransaction(url, key, transaction) {
  const response = await fetch(`${url}/rest/v1/payment_transactions`, {
    method: "POST",
    headers: { ...serviceHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(transaction)
  });
  if (!response.ok) throw new Error("Pending payment could not be stored");
}

function referenceNumber() {
  return `ATH-PM-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`.toUpperCase();
}

export default async function paymongoCheckoutHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !process.env.PAYMONGO_SECRET_KEY) {
    return send(response, 503, { error: "Local payment is unavailable." });
  }

  let user;
  try { user = await authenticatedUser(request, url, key); } catch (error) { user = null; }
  if (!user || !user.id) return send(response, 401, { error: "Authentication required." });

  try {
    // The body is intentionally ignored: every payment property is server-owned.
    const product = await loadProduct(url, key);
    const paymentMethods = configuredPaymentMethods();
    const reference = referenceNumber();
    const encodedReference = encodeURIComponent(reference);
    const attributes = buildCheckoutAttributes({
      userId: user.id,
      referenceNumber: reference,
      successUrl: `https://athlevo.org/?paymongo_return=success&paymongo_reference=${encodedReference}`,
      cancelUrl: "https://athlevo.org/?paymongo_return=cancelled",
      paymentMethods,
      product
    });
    const session = await makePaymongoClient().createCheckoutSession(attributes);
    await storePendingTransaction(url, key, {
      user_id: user.id,
      provider: "paymongo",
      provider_checkout_id: session.id,
      reference_number: reference,
      amount_cents: product.priceCents,
      currency: product.currency,
      status: "pending",
      entitlement_days: product.entitlementDays,
      product_id: product.id,
      metadata: {
        payment_methods: paymentMethods,
        livemode: session.attributes && session.attributes.livemode === true
      }
    });
    return send(response, 200, { checkout_url: session.checkoutUrl });
  } catch (error) {
    console.error("[paymongo] checkout creation failed:", error && error.message);
    return send(response, 502, { error: "Local payment could not be started." });
  }
}
