/*
 * Privacy-safe server-side product analytics.
 *
 * Only fixed event names and categorical properties are accepted. Athlete
 * identity is the verified Supabase UUID; no profile, email, health, workout,
 * or message data is ever included.
 *
 * Capture is best-effort and fail-open: a PostHog timeout, 5xx, network
 * error, or missing key must never fail subscription activation.
 */

const EVENTS = new Set([
  "free_limit_reached",
  "subscription_activated",
  "whop_pending_purchase_claimed",
  "whop_pending_purchase_claim_failed"
]);

const SAFE_KEYS = new Set([
  "feature",
  "limit_period",
  "source",
  "reason",
  "provider",
  "plan_id",
  "price_php"
]);
const PROHIBITED = /(email|name|token|secret|message|content|workout|health|injury|pain|gps|payload|raw)/i;
const DEFAULT_CAPTURE_TIMEOUT_MS = 1500;

function captureTimeoutMs() {
  const n = Number(process.env.POSTHOG_CAPTURE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAPTURE_TIMEOUT_MS;
}

function safeProperties(properties) {
  const out = {};
  if (!properties || typeof properties !== "object") return out;
  for (const [key, value] of Object.entries(properties)) {
    if (!SAFE_KEYS.has(key) || PROHIBITED.test(key)) continue;
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 40
    ) {
      out[key] = value;
    }
  }
  return out;
}

export function paidActivationProperties(source, provider) {
  const out = {
    plan_id: "performance",
    price_php: "597"
  };
  if (typeof source === "string" && source) out.source = source;
  if (typeof provider === "string" && provider) out.provider = provider;
  return out;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function captureServerEvent(userId, event, properties) {
  if (!userId || !EVENTS.has(event)) return false;
  const key = process.env.POSTHOG_KEY;
  if (!key) return false;

  try {
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    const response = await fetchWithTimeout(host + "/capture/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event,
        properties: {
          distinct_id: userId,
          ...safeProperties(properties)
        }
      })
    }, captureTimeoutMs());
    return response.ok;
  } catch (error) {
    return false;
  }
}

export function captureServerEventBestEffort(userId, event, properties) {
  try {
    const pending = captureServerEvent(userId, event, properties);
    if (pending && typeof pending.then === "function") {
      pending.then(() => {}, () => {});
    }
  } catch (error) {
    /* never throw into product flow */
  }
}

export const PRODUCT_ANALYTICS_VERSION = "server-product-analytics-v2";
