import paymongoCheckoutHandler from "../../lib/server/paymongoCheckoutEndpoint.js";
import { handleCors } from "../../lib/server/cors.js";

export default async function handler(request, response) {
  if (handleCors(request, response)) return;
  return paymongoCheckoutHandler(request, response);
}
