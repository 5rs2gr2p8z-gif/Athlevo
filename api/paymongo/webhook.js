import paymongoWebhookHandler from "../../lib/server/paymongoWebhookEndpoint.js";

export const config = { api: { bodyParser: false } };
export default paymongoWebhookHandler;
