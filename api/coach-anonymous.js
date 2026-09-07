import coachAnonymousHandler from "../lib/server/coachAnonymousEndpoint.js";
import { handleCors } from "../lib/server/cors.js";

/* Thin local/test entrypoint. Production traffic is rewritten to
 * /api/providers?action=coach_anonymous so this file is not a deployed
 * Vercel function (.vercelignore) — same pattern as api/diagnostic-chat.js. */

export default async function handler(request, response) {
  if (handleCors(request, response)) return;
  return coachAnonymousHandler(request, response);
}
