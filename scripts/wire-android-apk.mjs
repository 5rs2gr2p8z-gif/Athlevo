#!/usr/bin/env node
/**
 * Athlevo — direct-download APK wiring + pre-deploy gate.
 *
 *   node scripts/wire-android-apk.mjs <apk> --expected-cert-sha256 <hex>
 *   node scripts/wire-android-apk.mjs --check
 *
 * WIRE mode takes the Play-signed universal APK downloaded from Google Play
 * Console (never one built locally with the upload key), verifies it with
 * the Android SDK's apksigner + aapt2, and only then records its size,
 * SHA-256 and signing-certificate fingerprint in
 * distribution/android-release.json and fills the size/SHA-256 spans in
 * landing-preview.html. It never copies, uploads or commits the APK and
 * never reads signing secrets.
 *
 * CHECK mode is the gate to run before any deploy: it exits non-zero while
 * the release is still a placeholder.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "distribution", "android-release.json");
const landingPath = join(root, "landing-preview.html");
const vercelPath = join(root, "vercel.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const args = process.argv.slice(2);

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const norm = (hex) => String(hex || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();

function check() {
  const problems = [];
  const landing = readFileSync(landingPath, "utf8");
  const vercel = JSON.parse(readFileSync(vercelPath, "utf8"));
  if (manifest.status !== "ready") problems.push(`manifest status is "${manifest.status}", not "ready"`);
  if (!manifest.versionCodeVerifiedAgainstPlayConsole) problems.push("versionCode not verified against Play Console");
  if (!manifest.artifact.sha256) problems.push("artifact.sha256 missing");
  if (!manifest.artifact.sizeBytes) problems.push("artifact.sizeBytes missing");
  if (!manifest.signing.certSha256) problems.push("signing.certSha256 missing");
  if (/\{\{APK_[A-Z0-9_]+\}\}/.test(landing)) problems.push("landing-preview.html still has {{APK_*}} placeholders");
  const r = (vercel.redirects || []).find((x) => x.source === "/download/android");
  if (!r) problems.push("vercel.json has no /download/android redirect");
  else if (r.destination !== manifest.hosting.publicUrl) problems.push("vercel.json redirect differs from manifest hosting.publicUrl");
  if (problems.length) {
    console.error("Android release NOT ready to deploy:\n - " + problems.join("\n - "));
    process.exit(1);
  }
  console.log("Android release manifest is ready.");
}

function findSdkTool(name) {
  const dirs = [];
  for (const base of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.env.HOME && join(process.env.HOME, "Library/Android/sdk")]) {
    if (!base) continue;
    const bt = join(base, "build-tools");
    if (existsSync(bt)) {
      for (const v of readdirSync(bt).sort().reverse()) dirs.push(join(bt, v));
    }
  }
  for (const d of dirs) if (existsSync(join(d, name))) return join(d, name);
  try { execFileSync(name, ["version"], { stdio: "ignore" }); return name; } catch { return null; }
}

function wire() {
  const apk = args.find((a) => !a.startsWith("--"));
  const i = args.indexOf("--expected-cert-sha256");
  const expected = i >= 0 ? norm(args[i + 1]) : "";
  if (!apk) fail("usage: wire-android-apk.mjs <apk> --expected-cert-sha256 <hex>");
  if (expected.length !== 64) fail("--expected-cert-sha256 (the Play Console app signing key SHA-256) is required");
  if (!existsSync(apk) || !statSync(apk).isFile()) fail(`APK not found: ${apk}`);
  if (!/\.apk$/i.test(apk)) fail("file is not an .apk");

  const bytes = readFileSync(apk);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sizeBytes = bytes.length;

  const apksigner = findSdkTool("apksigner");
  const aapt2 = findSdkTool("aapt2");
  if (!apksigner || !aapt2) {
    fail("apksigner/aapt2 not found (Android SDK build-tools). Run this on the machine with the Android SDK; " +
      "nothing was written.");
  }
  let signerOut;
  try {
    signerOut = execFileSync(apksigner, ["verify", "--print-certs", "--verbose", apk], { encoding: "utf8" });
  } catch (e) { fail(`apksigner verify failed: ${e.message.split("\n")[0]}`); }
  const cert = /Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]+)/.exec(signerOut);
  if (!cert) fail("could not read signer certificate from apksigner output");
  const certSha = norm(cert[1]);
  if (certSha !== expected) fail("signing certificate does NOT match the expected Play app signing key; nothing written");
  if (/Number of signers:\s*(?!1\b)\d+/.test(signerOut)) fail("APK has multiple signers");

  const badging = execFileSync(aapt2, ["dump", "badging", apk], { encoding: "utf8" });
  const m = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/.exec(badging);
  if (!m) fail("could not read package metadata from aapt2");
  if (m[1] !== manifest.packageId) fail(`package ID ${m[1]} != ${manifest.packageId}`);
  if (Number(m[2]) !== manifest.versionCode) fail(`versionCode ${m[2]} != expected ${manifest.versionCode}`);
  if (m[3] !== manifest.versionName) fail(`versionName ${m[3]} != expected ${manifest.versionName}`);
  if (/application-debuggable/.test(badging)) fail("APK is debuggable; refusing");

  manifest.artifact.sizeBytes = sizeBytes;
  manifest.artifact.sha256 = sha256;
  manifest.artifact.fileName = manifest.artifact.fileName || basename(apk);
  manifest.signing.certSha256 = certSha;
  manifest.versionCodeVerifiedAgainstPlayConsole = true;
  manifest.status = "ready";
  manifest.note = "Verified by scripts/wire-android-apk.mjs. Upload the APK to the hosting object path BEFORE deploying.";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const sizeLabel = `${(sizeBytes / 1048576).toFixed(1)} MB`;
  let landing = readFileSync(landingPath, "utf8");
  landing = landing
    .replace(/(<span data-apk-size>)[^<]*(<\/span>)/, `$1${sizeLabel}$2`)
    .replace(/(<code data-apk-sha256>)[^<]*(<\/code>)/, `$1${sha256}$2`);
  writeFileSync(landingPath, landing);
  console.log(JSON.stringify({ package: m[1], versionCode: Number(m[2]), versionName: m[3],
    sizeBytes, sizeLabel, sha256, certSha256: certSha }, null, 2));
}

if (args.includes("--check")) check(); else wire();
