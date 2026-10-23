/*
 * scripts/check-native-assets.mjs — the guard that stops a Play bundle shipping stale native assets.
 * Builds tiny fixture trees and runs the real script against them.
 *
 * Run: node tests/native-assets-check.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(process.cwd(), "scripts", "check-native-assets.mjs");
const CDN = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>';
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

function put(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-assets-"));
  const html = `<html>${CDN}<body>app</body></html>`;
  put(root, "index.html", html);
  put(root, "manifest.webmanifest", "{}");
  put(root, "capacitor.config.json", JSON.stringify({ appId: "org.athlevo.app" }));
  put(root, "js/a.js", "a();");
  put(root, "assets/logo.txt", "logo");
  put(root, "legal/terms.html", "terms");
  put(root, "node_modules/@supabase/supabase-js/dist/umd/supabase.js", "supabase();");
  const out = "android/app/src/main/assets";
  put(root, `${out}/public/index.html`, html.replace(CDN, '<script src="vendor/supabase.js"></script>'));
  put(root, `${out}/public/manifest.webmanifest`, "{}");
  put(root, `${out}/public/js/a.js`, "a();");
  put(root, `${out}/public/assets/logo.txt`, "logo");
  put(root, `${out}/public/legal/terms.html`, "terms");
  put(root, `${out}/public/vendor/supabase.js`, "supabase();");
  put(root, `${out}/capacitor.config.json`, JSON.stringify({ appId: "org.athlevo.app" }));
  return { root, out };
}

function run(root) {
  try {
    const stdout = execFileSync("node", [script, "--root", root, "--no-markers"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: String(error.stderr || "") };
  }
}

test("passes when native assets match source", () => {
  const f = fixture();
  const r = run(f.root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Native assets match source/);
  rmSync(f.root, { recursive: true, force: true });
});

test("fails when a packaged JS file is stale", () => {
  const f = fixture();
  put(f.root, `${f.out}/public/js/a.js`, "old();");
  const r = run(f.root);
  assert.equal(r.code, 1);
  assert.match(r.out, /stale in native assets.*js\/a\.js/);
  assert.match(r.out, /npm run android:prepare/);
  rmSync(f.root, { recursive: true, force: true });
});

test("fails when a new source file never reached the native assets (e.g. fuel.js)", () => {
  const f = fixture();
  put(f.root, "js/fuel.js", "fuel();");
  const r = run(f.root);
  assert.equal(r.code, 1);
  assert.match(r.out, /missing in native assets: js\/fuel\.js/);
  rmSync(f.root, { recursive: true, force: true });
});

test("fails when a file removed from source is still packaged", () => {
  const f = fixture();
  put(f.root, `${f.out}/public/js/gone.js`, "gone();");
  const r = run(f.root);
  assert.equal(r.code, 1);
  assert.match(r.out, /removed from source but still packaged: js\/gone\.js/);
  rmSync(f.root, { recursive: true, force: true });
});

test("fails on a QA build (injected API origin) and on a CDN Supabase script", () => {
  const f = fixture();
  const qa = readFileSync(join(f.root, f.out, "public/index.html"), "utf8").replace("<body>", '<body><script>window.__ATHLEVO_QA_API_ORIGIN__="https://x.vercel.app";</script>');
  put(f.root, `${f.out}/public/index.html`, qa);
  const r = run(f.root);
  assert.equal(r.code, 1);
  assert.match(r.out, /QA API origin override/);
  rmSync(f.root, { recursive: true, force: true });
});

test("fails when assets were never prepared at all", () => {
  const root = mkdtempSync(join(tmpdir(), "native-assets-empty-"));
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /android:prepare/);
  rmSync(root, { recursive: true, force: true });
});

test("android:bundle runs prepare, then the asset check, then Gradle", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const cmd = pkg.scripts["android:bundle"];
  assert.ok(cmd.indexOf("android:prepare") >= 0 && cmd.indexOf("check-native-assets.mjs") > cmd.indexOf("android:prepare") &&
    cmd.indexOf("bundleRelease") > cmd.indexOf("check-native-assets.mjs"), cmd);
  assert.equal(pkg.scripts["android:assets-check"], "node scripts/check-native-assets.mjs");
  assert.ok(!/--qa/.test(cmd));
});

console.log(`\n${passed} tests passed`);
