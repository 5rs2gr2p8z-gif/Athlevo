#!/usr/bin/env node
/*
 * Release guard: the Android bundle must contain exactly what the CURRENT
 * source produces.
 *
 * Gradle packages android/app/src/main/assets/public, which is only refreshed
 * by `npm run android:prepare` (build-native-web + cap sync). A previous Play
 * build shipped stale assets because that step was skipped, so
 * `npm run android:bundle` now runs this check between prepare and Gradle.
 *
 * It re-derives the expected payload from source (js/, assets/, legal/,
 * manifest.webmanifest, the local Supabase bundle, and index.html with the CDN
 * script swapped for vendor/supabase.js — the same transform as
 * scripts/build-native-web.mjs) and byte-compares it with the packaged copy.
 * It also refuses a QA build (injected API origin) and checks that the
 * features this release depends on are really present.
 *
 *   node scripts/check-native-assets.mjs            # check the repo
 *   node scripts/check-native-assets.mjs --root DIR # (tests) check another tree
 *   node scripts/check-native-assets.mjs --no-markers
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg >= 0
  ? resolve(args[rootArg + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useMarkers = !args.includes("--no-markers");

const packaged = join(root, "android", "app", "src", "main", "assets", "public");
const CDN_TAG = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>';
const NATIVE_TAG = '<script src="vendor/supabase.js"></script>';
const SYNCED_DIRS = ["js", "assets", "legal"];

// Features this Android release must contain. Update when the release scope changes.
const MARKERS = [
  ["index.html", 'id="screen-fuel"', "Fuel screen"],
  ["index.html", 'id="youFuelEntry"', "You → Fuel entry"],
  ["js/fuel.js", "DEFAULT_ENABLED", "Fuel launch flag state"],
  ["js/fuel.js", "currentUserId", "Fuel auth lifecycle fix"],
  ["js/aiConsent.js", 'CONSENT_VERSION = "2"', "AI consent v2"],
  ["js/runtimeEnvironment.js", 'AUTH_CALLBACK = "athlevo://auth/callback"', "native Google callback"],
  ["js/socialAuth.js", "authRedirectUrl()", "native/web redirect separation"],
  ["index.html", ".coach-side-panel-nav{display:flex", "drawer layout fix"],
  ["index.html", 'id="wAiSignupSub"', "signup value proposition"],
  ["index.html", "function syncSignupCtaOrder", "signup Meta-browser CTA order"],
  ["js/runtimeEnvironment.js", "isMetaInAppBrowser", "Meta in-app browser helper"],
  ["js/analytics.js", "signupContextProps", "signup analytics context"],
  ["index.html", 'id="premiumRedButtons"', "shared premium red CTA styling"],
  ["index.html", "@keyframes prbRing", "premium red CTA glow"],
  ["index.html", "btn-premium-red", "shared premium red CTA class"],
  // Athlevo Coaching rebrand + four-section navigation (Home / Calendar / Coach / You)
  ["index.html", "<title>Athlevo Coaching", "Athlevo Coaching page title"],
  ["manifest.webmanifest", '"name": "Athlevo Coaching"', "Athlevo Coaching PWA name"],
  ["index.html", 'data-screen="screen-today" onclick="go(this)" role="tab"', "Home tab in the athlete nav"],
  ["index.html", 'id="homeNextCard"', "Home dashboard (Next)"],
  ["index.html", 'id="homeFuelEntry"', "Home → Fuel entry"],
  ["index.html", 'class="w-logo" src="assets/brand/athlevo-coaching-logo.png"', "Athlevo Coaching welcome logo and photo hero"]
];

async function exists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

async function walk(dir, base = dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else files.push(relative(base, full).split("\\").join("/"));
  }
  return files.sort();
}

const problems = [];
const note = message => problems.push(message);

if (!(await exists(join(packaged, "index.html")))) {
  console.error(`✗ ${relative(root, packaged)}/index.html is missing. Run: npm run android:prepare`);
  process.exit(1);
}

const compared = [];
async function compareFile(label, expected, actualPath) {
  let actual;
  try { actual = await readFile(actualPath); } catch { note(`missing in native assets: ${label}`); return; }
  compared.push(label);
  if (!actual.equals(expected)) note(`stale in native assets (differs from source): ${label}`);
}

// 1. Directories copied verbatim.
for (const dir of SYNCED_DIRS) {
  const sourceFiles = await walk(join(root, dir));
  const packagedFiles = await walk(join(packaged, dir));
  for (const file of sourceFiles) {
    await compareFile(`${dir}/${file}`, await readFile(join(root, dir, file)), join(packaged, dir, file));
  }
  const sourceSet = new Set(sourceFiles);
  for (const file of packagedFiles) {
    if (!sourceSet.has(file)) note(`removed from source but still packaged: ${dir}/${file}`);
  }
}

// 2. Single files.
await compareFile("manifest.webmanifest", await readFile(join(root, "manifest.webmanifest")), join(packaged, "manifest.webmanifest"));
const supabaseBundle = join(root, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js");
if (await exists(supabaseBundle)) {
  await compareFile("vendor/supabase.js", await readFile(supabaseBundle), join(packaged, "vendor", "supabase.js"));
} else {
  note("node_modules Supabase bundle missing — run npm install");
}

// 3. index.html = source with the CDN tag swapped, and never a QA build.
const sourceHtml = await readFile(join(root, "index.html"), "utf8");
if (!sourceHtml.includes(CDN_TAG)) note("source index.html no longer contains the Supabase CDN tag the native build rewrites");
await compareFile("index.html", Buffer.from(sourceHtml.replace(CDN_TAG, NATIVE_TAG)), join(packaged, "index.html"));
const packagedHtml = await readFile(join(packaged, "index.html"), "utf8");
if (packagedHtml.includes("__ATHLEVO_QA_API_ORIGIN__")) {
  note("packaged index.html contains the QA API origin override — this is a QA build, not a release build");
}
if (packagedHtml.includes(CDN_TAG)) note("packaged index.html still loads Supabase from the CDN");

// 4. Capacitor config must be synced too.
const cap = JSON.parse(await readFile(join(root, "capacitor.config.json"), "utf8"));
try {
  const syncedCap = JSON.parse(await readFile(join(root, "android", "app", "src", "main", "assets", "capacitor.config.json"), "utf8"));
  if (syncedCap.appId !== cap.appId) note(`capacitor.config.json appId not synced (${syncedCap.appId} != ${cap.appId})`);
} catch { note("android/app/src/main/assets/capacitor.config.json missing — run npm run android:prepare"); }

// 5. Required release features are in the packaged copy.
if (useMarkers) {
  for (const [file, needle, label] of MARKERS) {
    let text = "";
    try { text = await readFile(join(packaged, file), "utf8"); } catch { /* reported below */ }
    if (!text.includes(needle)) note(`release feature missing from native assets: ${label} (${file})`);
  }
}

if (problems.length) {
  console.error(`✗ Native assets are not release-ready (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  console.error("\nFix: npm run android:prepare   (then re-run npm run android:bundle)");
  process.exit(1);
}
console.log(`✓ Native assets match source (${compared.length} files compared${useMarkers ? `, ${MARKERS.length} release features present` : ""}).`);
