/**
 * A script's ?v= number must go up whenever its contents change, otherwise
 * browsers and the service worker keep serving the old file against new HTML.
 * Run: node tests/js-version-lock.test.mjs
 * Fix a failure: raise the ?v= in index.html, then node scripts/update-js-lock.mjs
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const html = readFileSync("./index.html", "utf8");
const lock = JSON.parse(readFileSync("./scripts/js-version-lock.json", "utf8"));
let passed = 0, failed = 0;
const test = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name + (detail ? `  [${detail}]` : "")); }
};
const current = {};
for (const m of html.matchAll(/src="(js\/[A-Za-z0-9_.-]+\.js)\?v=(\d+)"/g)) current[m[1]] = Number(m[2]);

test("every versioned script is in the lock file", Object.keys(current).every(f => lock[f]),
  Object.keys(current).filter(f => !lock[f]).join(", "));
for (const [file, version] of Object.entries(current)) {
  const entry = lock[file];
  if (!entry) continue;
  const sha = createHash("sha256").update(readFileSync("./" + file)).digest("hex");
  const changed = sha !== entry.sha256;
  test(`${file}: ${changed ? "changed, so ?v= must be above " + entry.v : "unchanged since the lock"}`,
    changed ? version > entry.v : version === entry.v, `?v=${version}, locked v${entry.v}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
