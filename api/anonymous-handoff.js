import anonymousHandoffHandler from "../lib/server/anonymousHandoffEndpoint.js";
import { handleCors } from "../lib/server/cors.js";
export default async function handler(request, response) {
  if (handleCors(request, response)) return;
  return anonymousHandoffHandler(request, response);
}
