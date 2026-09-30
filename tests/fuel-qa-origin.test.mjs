import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const runtimeSource = readFileSync("js/runtimeEnvironment.js", "utf8");
const buildSource = readFileSync("scripts/build-native-web.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`✓ ${name}`); }

function load({ native = true, qa } = {}) {
  const calls = [];
  const root = {
    Capacitor: { Plugins: {}, isNativePlatform: () => native, getPlatform: () => (native ? "android" : "web") },
    navigator: { userAgent: "Android", vendor: "", onLine: true },
    document: { documentElement: { classList: { add() {}, remove() {}, contains() { return false; } } }, referrer: "", readyState: "loading", head: { appendChild() {} }, createElement: () => ({ classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {} }), getElementById: () => null, addEventListener() {} },
    location: { href: "https://localhost/", origin: "https://localhost", pathname: "/" },
    fetch: async v => { calls.push(String(v)); return { ok: true, status: 200 }; },
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, dispatchEvent() {}, setTimeout() { return 1; }
  };
  if (qa !== undefined) root.__ATHLEVO_QA_API_ORIGIN__ = qa;
  root.window = root;
  const ctx = vm.createContext({ window: root, globalThis: root, URL, URLSearchParams, CustomEvent: class {}, Request, console });
  vm.runInContext(runtimeSource, ctx, { filename: "runtimeEnvironment.js" });
  return { runtime: root.AthlevoRuntime, calls, root };
}

await test("defaults to production with no QA config", () => {
  assert.equal(load().runtime.API_ORIGIN, "https://athlevo.org");
});
await test("honours a vercel.app QA origin on native only", () => {
  assert.equal(load({ qa: "https://athlevo-git-qa-fuel-v1-x.vercel.app" }).runtime.API_ORIGIN, "https://athlevo-git-qa-fuel-v1-x.vercel.app");
  assert.equal(load({ native: false, qa: "https://a.vercel.app" }).runtime.API_ORIGIN, "https://athlevo.org");
});
await test("rejects non-preview / malformed QA origins", () => {
  for (const bad of ["https://evil.com", "http://a.vercel.app", "https://a.vercel.app/x", "https://a.vercel.app.evil.com", "https://athlevo.org", 5, "javascript:1"]) {
    assert.equal(load({ qa: bad }).runtime.API_ORIGIN, "https://athlevo.org", String(bad));
  }
});
await test("source never hard-codes a preview URL and build script gates QA behind --qa", () => {
  assert.ok(!/[a-z0-9-]+\.vercel\.app/.test(runtimeSource.replace(/\\\.vercel\\\.app/g, "")));
  assert.match(buildSource, /process\.argv\.includes\("--qa"\)/);
  assert.match(pkg.scripts["android:qa"], /--qa/);
  assert.ok(!/--qa/.test(pkg.scripts["android:debug"] + pkg.scripts["android:prepare"] + pkg.scripts["build:native"] + pkg.scripts["android:bundle"]));
  assert.ok(!/__ATHLEVO_QA_API_ORIGIN__/.test(readFileSync("index.html", "utf8")));
});
await test("qa build without a valid origin fails; qa build injects it; default build does not", () => {
  if (!existsSync("node_modules/@supabase/supabase-js/dist/umd/supabase.js")) return;
  const dir = mkdtempSync(join(tmpdir(), "qa-origin-"));
  for (const e of ["js", "assets", "legal", "scripts", "index.html", "manifest.webmanifest", "node_modules"]) {
    if (e === "node_modules") {
      cpSync("node_modules/@supabase/supabase-js/dist/umd/supabase.js", join(dir, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"), { recursive: true });
    } else cpSync(e, join(dir, e), { recursive: true });
  }
  const run = (args, env) => execFileSync("node", ["scripts/build-native-web.mjs", ...args], { cwd: dir, env: { ...process.env, ...env }, stdio: "pipe" });
  assert.throws(() => run(["--qa"], { ATHLEVO_QA_API_ORIGIN: "" }));
  assert.throws(() => run(["--qa"], { ATHLEVO_QA_API_ORIGIN: "https://evil.com" }));
  run([], { ATHLEVO_QA_API_ORIGIN: "https://x-y.vercel.app" });
  assert.ok(!readFileSync(join(dir, "dist/index.html"), "utf8").includes("__ATHLEVO_QA_API_ORIGIN__"));
  run(["--qa"], { ATHLEVO_QA_API_ORIGIN: "https://x-y.vercel.app/" });
  const html = readFileSync(join(dir, "dist/index.html"), "utf8");
  assert.match(html, /window\.__ATHLEVO_QA_API_ORIGIN__="https:\/\/x-y\.vercel\.app";/);
  assert.ok(html.indexOf("__ATHLEVO_QA_API_ORIGIN__") < html.indexOf("js/runtimeEnvironment.js"));
  assert.match(readFileSync(join(dir, "dist/js/aiConsent.js"), "utf8"), /CONSENT_VERSION = "2"/);
  assert.ok(existsSync(join(dir, "dist/js/fuel.js")));
});
const { runSmoke } = await import("../scripts/fuel-qa-smoke.mjs");
await test("smoke script refuses production and passes against a mocked preview", async () => {
  await assert.rejects(() => runSmoke({ base: "https://athlevo.org", log() {} }));
  let deleted = false;
  const mock = async (url, o = {}) => {
    const j = (status, body) => ({ status, ok: status < 400, json: async () => body });
    if (url.includes("/auth/v1/token")) return j(200, { access_token: "t" });
    if (url.includes("/rest/v1/fuel_meals")) return j(200, []);
    if (url.includes("analyze-meal")) return j(401, {});
    const authed = o.headers && o.headers.Authorization;
    if (!authed) return j(401, {});
    if (o.method === "POST") return j(201, { meal: { id: "11111111-1111-4111-8111-111111111111" } });
    if (o.method === "DELETE") { const was = deleted; deleted = true; return was ? j(404, {}) : j(200, { deleted: true }); }
    return j(500, {});
  };
  const res = await runSmoke({ base: "https://p.vercel.app", email: "a@b.c", password: "x", fetchImpl: mock, log() {} });
  assert.equal(res.length, 7);
  assert.ok(res.every(r => r.ok));
});
console.log(`fuel-qa-origin: ${passed} passed`);
