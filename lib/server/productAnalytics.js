/*
 * Privacy-safe server-side product analytics.
 *
 * Only fixed event names and categorical properties are accepted. Athlete
 * identity is the verified Supabase UUID; no profile, email, health, workout,
 * or message data is ever included.
 */

const EVENTS = new Set([
  "free_limit_reached",
  "subscription_activated",
  "whop_pending_purchase_claimed",
  "whop_pending_purchase_claim_failed"
]);

const SAFE_KEYS = new Set(["feature", "limit_period", "source", "reason"]);
const PROHIBITED = /(email|name|token|secret|message|content|workout|health|injury|pain|gps|payload|raw)/i;

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

export async function captureServerEvent(userId, event, properties) {
  if (!userId || !EVENTS.has(event)) return false;
  const key = process.env.POSTHOG_KEY;
  if (!key) return false;

  try {
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    const response = await fetch(host + "/capture/", {
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
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

export const PRODUCT_ANALYTICS_VERSION = "server-product-analytics-v1";
