import { handleCors } from "../../lib/server/cors.js";
import { fuelAnalyzeMealHandler } from "../../lib/server/fuelEndpoint.js";

/* Thin local/test entrypoint. Production traffic is rewritten to
 * /api/providers?action=fuel_analyze_meal so this file is not a deployed
 * Vercel function (.vercelignore). */
export default async function handler(request, response) {
  if (handleCors(request, response)) return;
  return fuelAnalyzeMealHandler(request, response);
}
