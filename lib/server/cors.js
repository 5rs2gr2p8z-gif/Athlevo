const ALLOWED_ORIGIN_VALUES = Object.freeze([
  "https://athlevo.org",
  "https://www.athlevo.org",
  "https://localhost",
  "capacitor://localhost"
]);

const ALLOWED_ORIGINS = new Set(ALLOWED_ORIGIN_VALUES);
const ALLOWED_HEADERS = "Authorization, Content-Type";
const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

function requestOrigin(request) {
  const headers = request && request.headers ? request.headers : {};
  const value = headers.origin ?? headers.Origin;
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function appendVaryOrigin(response) {
  if (!response || typeof response.setHeader !== "function") return false;
  const current = typeof response.getHeader === "function"
    ? response.getHeader("Vary")
    : undefined;
  const values = (Array.isArray(current) ? current.join(",") : String(current || ""))
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (!values.some(value => value.toLowerCase() === "origin")) values.push("Origin");
  response.setHeader("Vary", values.join(", "));
  return true;
}

export function applyCors(request, response) {
  if (!appendVaryOrigin(response)) return false;
  const origin = requestOrigin(request);
  if (!ALLOWED_ORIGINS.has(origin)) return false;

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  response.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  return true;
}

export function handleCors(request, response) {
  applyCors(request, response);
  if (String(request && request.method || "").toUpperCase() !== "OPTIONS") return false;

  response.status(204).end();
  return true;
}

export const CORS_POLICY = Object.freeze({
  origins: ALLOWED_ORIGIN_VALUES,
  headers: ALLOWED_HEADERS,
  methods: ALLOWED_METHODS
});
