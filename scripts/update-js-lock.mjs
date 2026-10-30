#!/usr/bin/env node
/*
 * Records, for every js/*.js file index.html loads with a ?v= number, the
 * file's content hash and that number. tests/js-version-lock.test.mjs fails if
 * a file changes without its ?v= being raised, which is how browsers and the
 * service worker end up running an old script against new HTML.
 *
 * Refuses to lock a changed file whose ?v= was not raised, so the lock cannot
 * be refreshed past a forgotten bump.
 *
 * After raising a ?v=, run:  node scripts/update-js-lock.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const html = readFileSync("index.html", "utf8");
const previous = existsSync("scripts/js-version-lock.json")
  ? JSON.parse(readFileSync("scripts/js-version-lock.json", "utf8"))
  : {};
const lock = {};
const unbumped = [];
for (const match of html.matchAll(/src="(js\/[A-Za-z0-9_.-]+\.js)\?v=(\d+)"/g)) {
  const [, file, rawVersion] = match;
  const version = Number(rawVersion);
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const old = previous[file];
  if (old && old.sha256 !== sha256 && version <= old.v) unbumped.push(`${file} (still ?v=${version}, was locked at v${old.v})`);
  lock[file] = { v: version, sha256 };
}
if (unbumped.length) {
  console.error("These scripts changed but their ?v= in index.html was not raised:\n  " + unbumped.join("\n  "));
  process.exit(1);
}
writeFileSync("scripts/js-version-lock.json", JSON.stringify(lock, null, 2) + "\n");
console.log(`Locked ${Object.keys(lock).length} scripts.`);
