import { handleCors } from "../../lib/server/cors.js";
import { fuelMealsHandler } from "../../lib/server/fuelEndpoint.js";

/* Thin local/test entrypoint. Production traffic is rewritten to
 * /api/providers?action=fuel_meals so this file is not a deployed
 * Vercel function (.vercelignore). */
export default async function handler(request, response) {
  if (handleCors(request, response)) return;
  return fuelMealsHandler(request, response);
}
