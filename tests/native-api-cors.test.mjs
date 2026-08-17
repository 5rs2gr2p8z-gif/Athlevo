import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORS_POLICY, applyCors, handleCors } from "../lib/server/cors.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function responseDouble() {
  const headers = new Map();
  return {
    statusCode: null,
    body: undefined,
    ended: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.ended = true; return this; },
    send(value) { this.body = value; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    header(name) { return headers.get(name.toLowerCase()); }
  };
}

function request(method, origin, extras = {}) {
  return {
    method,
    headers: origin ? { origin, ...extras.headers } : { ...extras.headers },
    query: extras.query || {},
    body: extras.body
  };
}

function apiFiles(directory = new URL("../api/", import.meta.url)) {
  const root = fileURLToPath(directory);
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
    }
  }
  walk(root);
  return files.sort();
}

const expectedOrigins = [
  "https://athlevo.org",
  "https://www.athlevo.org",
  "https://localhost",
  "capacitor://localhost"
];

await test("the CORS policy contains only exact Athlevo web and Capacitor origins", () => {
  assert.deepEqual([...CORS_POLICY.origins], expectedOrigins);
  assert.equal(CORS_POLICY.origins.some(origin => origin.includes("*")), false);
  assert.equal(CORS_POLICY.origins.some(origin => /localhost:\d+/.test(origin)), false);
});

for (const origin of ["https://localhost", "capacitor://localhost", "https://athlevo.org"]) {
  await test(`OPTIONS accepts ${origin} with the native authenticated-request contract`, () => {
    const response = responseDouble();
    const handled = handleCors(request("OPTIONS", origin, {
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type"
      }
    }), response);
    assert.equal(handled, true);
    assert.equal(response.statusCode, 204);
    assert.equal(response.ended, true);
    assert.equal(response.header("access-control-allow-origin"), origin);
    const headers = response.header("access-control-allow-headers").toLowerCase();
    assert.match(headers, /authorization/);
    assert.match(headers, /content-type/);
    const methods = response.header("access-control-allow-methods");
    assert.match(methods, /GET/);
    assert.match(methods, /POST/);
    assert.match(methods, /PATCH/);
    assert.match(methods, /DELETE/);
    assert.match(response.header("vary"), /(?:^|,\s*)Origin(?:,|$)/i);
  });
}

await test("www production origin is reflected exactly", () => {
  const response = responseDouble();
  applyCors(request("GET", "https://www.athlevo.org"), response);
  assert.equal(response.header("access-control-allow-origin"), "https://www.athlevo.org");
});

await test("disallowed and lookalike origins are never reflected or wildcarded", () => {
  const rejected = [
    "https://evil.example",
    "https://athlevo.org.evil.example",
    "http://localhost",
    "https://localhost:3000",
    "capacitor://evil.example"
  ];
  for (const origin of rejected) {
    const response = responseDouble();
    handleCors(request("OPTIONS", origin), response);
    assert.equal(response.statusCode, 204);
    assert.equal(response.header("access-control-allow-origin"), undefined, origin);
    assert.notEqual(response.header("access-control-allow-origin"), "*", origin);
  }
});

await test("allowed CORS headers survive success, auth, validation, and server errors", () => {
  for (const status of [200, 401, 400, 500]) {
    const response = responseDouble();
    const req = request("POST", "https://localhost");
    if (!handleCors(req, response)) response.status(status).json({ status });
    assert.equal(response.statusCode, status);
    assert.equal(response.header("access-control-allow-origin"), "https://localhost");
    assert.match(response.header("vary"), /Origin/i);
  }
});

await test("requests without Origin keep existing server and same-origin behavior", () => {
  const response = responseDouble();
  let businessCalls = 0;
  const req = request("POST", null);
  if (!handleCors(req, response)) {
    businessCalls += 1;
    response.status(200).json({ ok: true });
  }
  assert.equal(businessCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.header("access-control-allow-origin"), undefined);
  assert.match(response.header("vary"), /Origin/i);
});

await test("Vary preserves existing cache keys and adds Origin only once", () => {
  const response = responseDouble();
  response.setHeader("Vary", "Accept-Encoding");
  applyCors(request("GET", "https://athlevo.org"), response);
  applyCors(request("GET", "https://athlevo.org"), response);
  assert.equal(response.header("vary"), "Accept-Encoding, Origin");
});

await test("every public API entrypoint applies the shared helper", async () => {
  const files = apiFiles();
  assert.equal(files.length > 0, true);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /import \{ handleCors \} from ["'][^"']*lib\/server\/cors\.js["'];/i, file);
    assert.match(source, /if \(handleCors\([^)]*\)\) return;/, file);
  }
});

await test("every real API handler short-circuits preflight before auth or work", async () => {
  const modules = await Promise.all(apiFiles().map(file => import(pathToFileURL(file).href)));
  for (const module of modules) {
    const response = responseDouble();
    await module.default(request("OPTIONS", "capacitor://localhost"), response);
    assert.equal(response.statusCode, 204);
    assert.equal(response.header("access-control-allow-origin"), "capacitor://localhost");
  }
});

await test("real auth and validation failures retain allowed-origin headers", async () => {
  const [{ default: connect }, { default: providers }] = await Promise.all([
    import("../api/strava/connect.js"),
    import("../api/providers/index.js")
  ]);

  const authResponse = responseDouble();
  await connect(request("POST", "https://localhost"), authResponse);
  assert.equal(authResponse.statusCode, 401);
  assert.equal(authResponse.header("access-control-allow-origin"), "https://localhost");

  const validationResponse = responseDouble();
  await providers(request("POST", "capacitor://localhost", {
    query: { provider: "invalid", action: "invalid" }
  }), validationResponse);
  assert.equal(validationResponse.statusCode, 404);
  assert.equal(validationResponse.header("access-control-allow-origin"), "capacitor://localhost");
});

console.log(`\n${passed} native API CORS tests passed.`);
