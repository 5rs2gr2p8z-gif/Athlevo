/* Server-only PayMongo Hosted Checkout client. */

export const ATHLEVO_PERFORMANCE_PRODUCT = Object.freeze({
  id: "ATHLEVO_PRO_MONTHLY",
  planId: "performance",
  priceCents: 59700,
  currency: "PHP",
  entitlementDays: 30,
  description: "Athlevo Performance — 30 days"
});

export const DEFAULT_PAYMONGO_PAYMENT_METHODS = Object.freeze([
  "qrph", "grab_pay", "maya"
]);

const PAYMONGO_API_BASE = process.env.PAYMONGO_API_BASE || "https://api.paymongo.com";

export function configuredPaymentMethods(value = process.env.PAYMONGO_PAYMENT_METHODS) {
  const raw = String(value || DEFAULT_PAYMONGO_PAYMENT_METHODS.join(","));
  const methods = Array.from(new Set(raw.split(",")
    .map(method => method.trim().toLowerCase())
    // Product copy and env configuration use the current Maya brand name;
    // PayMongo's Checkout API still names this payment type `paymaya`.
    .map(method => method === "maya" ? "paymaya" : method)
    .filter(method => /^[a-z][a-z0-9_]{1,31}$/.test(method))));
  return methods.length ? methods : [...DEFAULT_PAYMONGO_PAYMENT_METHODS];
}

export function buildCheckoutAttributes({
  userId,
  referenceNumber,
  successUrl,
  cancelUrl,
  paymentMethods,
  product = ATHLEVO_PERFORMANCE_PRODUCT
}) {
  return {
    line_items: [{
      name: "Athlevo Performance",
      description: product.description,
      amount: product.priceCents,
      currency: product.currency,
      quantity: 1
    }],
    payment_method_types: paymentMethods || configuredPaymentMethods(),
    success_url: successUrl,
    cancel_url: cancelUrl,
    reference_number: referenceNumber,
    send_email_receipt: true,
    show_description: true,
    show_line_items: true,
    description: product.description,
    metadata: {
      athlevo_user_id: userId,
      athlevo_product: product.id
    }
  };
}

export function makePaymongoClient(secretKey = process.env.PAYMONGO_SECRET_KEY) {
  const key = String(secretKey || "");

  async function request(path, { method = "GET", body } = {}) {
    if (!key) throw new Error("PAYMONGO_SECRET_KEY not configured");
    const response = await fetch(`${PAYMONGO_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
    if (!response.ok) {
      const error = new Error(`PayMongo API ${response.status}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return data;
  }

  async function createCheckoutSession(attributes) {
    const response = await request("/v2/checkout_sessions", {
      method: "POST",
      body: { data: { attributes } }
    });
    const session = response && response.data;
    const checkoutUrl = session && session.attributes && session.attributes.checkout_url;
    if (!session || !session.id || !checkoutUrl) {
      throw new Error("PayMongo checkout response was incomplete");
    }
    return { id: session.id, checkoutUrl, attributes: session.attributes };
  }

  async function getPayment(paymentId) {
    if (!paymentId) return null;
    const response = await request(`/v1/payments/${encodeURIComponent(paymentId)}`);
    return response && response.data || null;
  }

  return {
    createCheckoutSession,
    getPayment,
    isConfigured: () => Boolean(key)
  };
}

export const PAYMONGO_CLIENT_VERSION = "paymongo-client-v1";
