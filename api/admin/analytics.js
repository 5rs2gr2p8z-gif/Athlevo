/*
 * SUPERSEDED — do not deploy.
 *
 * The beta-analytics aggregate endpoint now lives in the generic gateway at
 * api/providers/index.js (GET ?action=admin_analytics). It was moved there so
 * that adding the Whop webhook (api/whop/webhook.js) keeps the deployed
 * serverless-function count at 12 (the Vercel Hobby cap). This directory is
 * excluded from deployment via .vercelignore. Kept as a stub for a reversible
 * history; the real logic + tests target the gateway route.
 */
export default async function handler(req, res) {
  return res.status(410).json({ error: "Moved to /api/providers?action=admin_analytics" });
}
