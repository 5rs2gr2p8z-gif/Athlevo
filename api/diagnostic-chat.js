import diagnosticChatHandler from "../lib/server/diagnosticChatEndpoint.js";
import { handleCors } from "../lib/server/cors.js";

/* Thin local/test entrypoint. Production traffic is rewritten to
 * /api/providers?action=diagnostic_chat so this file is not a deployed
 * Vercel function (.vercelignore). */

export default async function handler(request, response) {
  if (handleCors(request, response)) return;
  return diagnosticChatHandler(request, response);
}
