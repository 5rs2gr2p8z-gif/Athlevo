#!/usr/bin/env node
/*
 * Records, for every js/*.js file index.html loads with a ?v= number, the
 * file's content hash and that number. tests/js-version-lock.test.mjs fails if
 * a file changes without its ?v= being raised, which is how browsers and the
 * service worker end up running an old script against new HTML.
 *
 * After raising a ?v=, run:  node scripts/update-js-lock.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const html = readFileSync("index.html", "utf8");
const lock = {};
for (const match of html.matchAll(/src="(js\/[A-Za-z0-9_.-]+\.js)\?v=(\d+)"/g)) {
  const [, file, version] = match;
  lock[file] = { v: Number(version), sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}
writeFileSync("scripts/js-version-lock.json", JSON.stringify(lock, null, 2) + "\n");
console.log(`Locked ${Object.keys(lock).length} scripts.`);
