import paymongoWebhookHandler from "../../lib/server/paymongoWebhookEndpoint.js";
import { handleCors } from "../../lib/server/cors.js";

export const config = { api: { bodyParser: false } };
export default async function handler(request, response) {
  if (handleCors(request, response)) return;
  return paymongoWebhookHandler(request, response);
}
