/*
 * Athlevo — Static Vercel serverless function count test.
 *
 * Proves the deployable api/ tree (after .vercelignore exclusions) contains
 * no more than 12 Vercel Hobby-plan serverless functions.
 *
 * Run: node tests/vercel-function-count.test.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const HOBBY_LIMIT = 12;

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};

// Parse .vercelignore for api/ exclusions.
function loadVercelIgnore() {
  const p = join(root, ".vercelignore");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

// Recursively find all .js files under api/, respecting .vercelignore.
function findFunctions(dir, rel, ignored) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Check if this directory is ignored (with or without trailing slash).
      const dirPath = `api/${entryRel}`;
      if (ignored.some(ig => dirPath === ig || dirPath === ig.replace(/\/$/, "") || `${dirPath}/` === ig)) continue;
      results.push(...findFunctions(full, entryRel, ignored));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const filePath = `api/${entryRel}`;
      if (ignored.some(ig => filePath === ig)) continue;
      results.push(filePath);
    }
  }
  return results;
}

const ignored = loadVercelIgnore();
const apiDir = join(root, "api");
const functions = findFunctions(apiDir, "", ignored).sort();

console.log(`\nDeployable serverless functions (${functions.length}/${HOBBY_LIMIT}):`);
functions.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
console.log();

t(`function count (${functions.length}) is within Hobby limit (${HOBBY_LIMIT})`, functions.length <= HOBBY_LIMIT, `found ${functions.length}`);
t("api/coach-dashboard.js is NOT in the deployable tree", !functions.includes("api/coach-dashboard.js"));
t("api/athlete-mode.js is NOT in the deployable tree", !functions.includes("api/athlete-mode.js"));
t("api/diagnostic-chat.js is NOT in the deployable tree", !functions.includes("api/diagnostic-chat.js"));
t("api/providers/index.js IS in the deployable tree", functions.includes("api/providers/index.js"));

{
  const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
  t("POST /api/diagnostic-chat rewrites to providers?action=diagnostic_chat",
    (vercel.rewrites || []).some(route =>
      route.source === "/api/diagnostic-chat" &&
      route.destination === "/api/providers?action=diagnostic_chat"
    )
  );
  t("PayMongo checkout rewrite is unchanged",
    (vercel.rewrites || []).some(route =>
      route.source === "/api/paymongo/checkout" &&
      route.destination === "/api/providers?action=paymongo_checkout"
    )
  );
  t("/ai-signup rewrites to the SPA",
    (vercel.rewrites || []).some(route =>
      route.source === "/ai-signup" &&
      route.destination === "/index.html"
    )
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
