/**
 * Direct Android download — prepared (not deployed / not activated).
 * Run: node tests/android-direct-download.test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}${extra ? `  [${extra}]` : ""}`); }
};
const section = (s) => console.log(`\n──── ${s} ────`);

const gradle = readFileSync("./android/app/build.gradle", "utf8");
const cap = JSON.parse(readFileSync("./capacitor.config.json", "utf8"));
const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));
const manifest = JSON.parse(readFileSync("./distribution/android-release.json", "utf8"));
const landing = readFileSync("./landing-preview.html", "utf8");
const indexHtml = readFileSync("./index.html", "utf8");
const gitignore = readFileSync("./.gitignore", "utf8");
const body = landing.replace(/<!--[\s\S]*?-->/g, "");
const script = /<script>([\s\S]*?)<\/script>/.exec(landing)?.[1] ?? "";

section("1. Release APK configuration");
{
  t("release build type uses the release signing config from keystore.properties",
    /signingConfigs\s*\{\s*release\s*\{[\s\S]*?keystore\.properties|rootProject\.file\('keystore\.properties'\)/.test(gradle) &&
    /signingConfig signingConfigs\.release/.test(gradle));
  t("release never falls back to the debug signing config", !/signingConfigs\.debug/.test(gradle));
  t("assembleRelease is guarded: fails without local release signing (no unsigned APK)",
    /':app:assembleRelease'/.test(gradle) && /Release signing requires/.test(gradle));
  t("no secrets in gradle (passwords are read from the ignored properties file)",
    !/(storePassword|keyPassword)\s*[= ]\s*["'][^"']+["']/.test(gradle));
  t("keystore.properties is gitignored", /android\/keystore\.properties/.test(gitignore));
  t("*.jks/*.keystore/*.apk/*.aab are gitignored for android",
    /\*\.jks/.test(readFileSync("./android/.gitignore", "utf8")) &&
    /\*\.apk/.test(readFileSync("./android/.gitignore", "utf8")));
  t("no npm script builds a local release APK with the upload key",
    !Object.values(pkg.scripts).some(s => /assembleRelease/.test(s)));
  t("wire + gate scripts are registered",
    /wire-android-apk/.test(pkg.scripts["android:apk:wire"]) && /--check/.test(pkg.scripts["android:release-check"]));
}

section("2. Package ID and version metadata");
{
  t('applicationId is unchanged: "org.athlevo.app"', /applicationId "org\.athlevo\.app"/.test(gradle));
  t('namespace is unchanged', /namespace = "org\.athlevo\.app"/.test(gradle));
  t("capacitor appId matches", cap.appId === "org.athlevo.app");
  t("manifest packageId matches gradle", manifest.packageId === "org.athlevo.app");
  const vc = Number(/versionCode (\d+)/.exec(gradle)?.[1]);
  const vn = /versionName "([^"]+)"/.exec(gradle)?.[1];
  t("manifest versionCode equals gradle versionCode", manifest.versionCode === vc, `gradle=${vc}`);
  t("manifest versionName equals gradle versionName", manifest.versionName === vn, `gradle=${vn}`);
  t("landing shows the manifest versionName", landing.includes(`Version ${manifest.versionName}`));
  t("artifact is the Play-signed universal APK (not the upload key)",
    /Signed, universal APK/.test(manifest.artifact.source) && /NOT the upload key/.test(manifest.signing.scheme));
  t("manifest is honest about being pending until verified",
    manifest.status === "pending-play-signed-apk" ? manifest.artifact.sha256 === null && manifest.versionCodeVerifiedAgainstPlayConsole === false
      : manifest.status === "ready" && !!manifest.artifact.sha256);
}

section("3. Stable download route");
{
  const r = (vercel.redirects || []).filter(x => x.source === "/download/android");
  t("exactly one /download/android redirect", r.length === 1);
  t("redirect is temporary (302) so versions can change", r[0] && r[0].permanent === false);
  t("redirect destination equals the manifest hosting URL", r[0]?.destination === manifest.hosting.publicUrl);
  t("destination is HTTPS on the project's existing Supabase host",
    /^https:\/\/hqwdehqsllyvrcnlcytj\.supabase\.co\/storage\/v1\/object\/public\/releases\/android\/[\w.-]+\.apk\?download=[\w.-]+\.apk$/.test(manifest.hosting.publicUrl));
  t("no APK/binary is tracked or shipped in the repo", !existsSync("./athlevo-android-v1.0.0.apk") && !existsSync("./downloads"));
  t("gate script refuses while the release is a placeholder",
    manifest.status !== "pending-play-signed-apk" ||
    spawnSync("node", ["scripts/wire-android-apk.mjs", "--check"]).status === 1);
}

section("4. Landing CTA");
{
  const hrefs = [...body.matchAll(/data-android-download[^>]*>|<a[^>]*data-android-download/g)].length;
  const links = [...body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*data-android-download[^>]*>/g)].map(m => m[1]);
  t("hero and download-section both have a download CTA", links.length === 2, `found ${links.length}`);
  t("every download CTA points ONLY at /download/android", links.every(h => h === "/download/android"));
  t("no landing markup links to an .apk file or the storage host directly",
    !/\.apk|supabase\.co|\/storage\/v1/i.test(body));
  t("Android CTA is a plain link (no onclick/JS handler, no new-window trick)",
    !/<a[^>]*data-android-download[^>]*(onclick|target=)/.test(body));
  t('CTA label is "Download for Android" (desktop is told it is the Android app)',
    (body.match(/>Download for Android</g) || []).length === 2 && /downloads the Android app/i.test(body));
  t('download section copy present', /Download the latest version directly\./.test(body) &&
    /Android may ask you to allow app installation from your browser\./.test(body) && /Version 1\.0\.0/.test(body));
  t("SHA-256 / size live in an expandable technical-details block",
    /<details class="dl-tech">[\s\S]*data-apk-sha256[\s\S]*<\/details>/.test(body) && /data-apk-size/.test(body));
  t("does not tell users to disable Play Protect or global security",
    !/play protect|disable|turn off|security settings|bypass/i.test(body));
  t('"iPhone version coming soon" shown', /iPhone version coming soon/.test(body));
  t("landing stays unpublished (noindex, not linked from live app)",
    /noindex,nofollow/.test(landing) && !indexHtml.includes("landing-preview"));
}

section("5. Platform behaviour (run the real inline script against a fake DOM)");
{
  function run(ua, platform = "Linux armv8l", touch = 5) {
    const mk = (attrs) => ({ hidden: attrs.hidden ?? false, attrs: { ...attrs },
      removeAttribute(n) { delete this.attrs[n]; }, setAttribute(n, v) { this.attrs[n] = v; }, tabIndex: 0 });
    const dl = [mk({ href: "/download/android" }), mk({ href: "/download/android" })];
    const state = [mk({}), mk({})];
    const ios = [mk({ hidden: true })];
    const desk = [mk({ hidden: true })];
    const sets = { "[data-android-state]": state, "[data-android-download]": dl, "[data-ios-state]": ios, "[data-desktop-note]": desk };
    const document = { querySelectorAll: (s) => sets[s] || [] };
    const navigator = { userAgent: ua, platform, maxTouchPoints: touch };
    vm.runInNewContext(script, { document, navigator });
    return { dl, state, ios, desk };
  }
  const android = run("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36");
  t("Android: APK link kept", android.dl.every(a => a.attrs.href === "/download/android") &&
    android.ios[0].hidden === true && android.state.every(s => !s.hidden));
  const desktop = run("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126", "MacIntel", 0);
  t("Desktop: still downloads the Android APK, with an 'Android app' note",
    desktop.dl.every(a => a.attrs.href === "/download/android") && desktop.desk[0].hidden === false && desktop.ios[0].hidden === true);
  const iphone = run("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1", "iPhone", 5);
  t("iPhone: APK link removed, coming-soon state shown",
    iphone.dl.every(a => !("href" in a.attrs)) && iphone.ios[0].hidden === false && iphone.state.every(s => s.hidden));
  const ipad = run("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", "MacIntel", 5);
  t("iPadOS (desktop-class UA): treated as iOS", ipad.dl.every(a => !("href" in a.attrs)) && ipad.ios[0].hidden === false);
  t("iOS never references APK/IPA install schemes or store URLs",
    !/itms-services|\.ipa|apps\.apple\.com|testflight/i.test(landing));
  t("iOS state offers only the web app link (/ai), inside the iOS block",
    /<div class="ios-state" data-ios-state hidden>[\s\S]*?href="\/ai"[\s\S]*?<\/div>/.test(body));
  t("script makes no network calls or storage writes",
    !/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|cookie/.test(script));
}

section("6. Routes unchanged");
{
  const rw = (s) => vercel.rewrites.find(r => r.source === s);
  for (const p of ["/ai", "/privacy", "/terms", "/support"])
    t(`${p} still rewrites to /index.html`, rw(p)?.destination === "/index.html");
  t("/landing-preview still rewrites to landing-preview.html", rw("/landing-preview")?.destination === "/landing-preview.html");
  t('"/" is NOT rewritten (landing not activated)', !rw("/") && !(vercel.redirects || []).some(r => r.source === "/"));
  t("index.html byte-for-byte unchanged (/ai and app untouched)",
    createHash("sha256").update(indexHtml).digest("hex") === "70e390e9d7bae93383bf69b65e12208564131dfabd3fdbb9e5ed92864af17e11");
  t("activation proposal is documented, not applied",
    existsSync("./docs/landing-activation-proposal.md") && /NOT applied/.test(readFileSync("./docs/landing-activation-proposal.md", "utf8")));
  t("/api and function count untouched (no new function files)", !existsSync("./api/download") && !existsSync("./api/download.js"));
}

section("7. Landing does not gain signup / payment / wearable / store behaviour");
{
  const minusBanner = body.replace(/<div class="preview-bar">[\s\S]*?<\/div>/, "");
  t("no forms or inputs", !/<form[\s>]|<input[\s>]/i.test(body));
  t("no signup/login CTA text", !/sign\s*up|log\s*in|sign\s*in|create\s+your\s+free\s+account|start\s+free\s+trial/i.test(minusBanner));
  t("no payment references", !/whop|paymongo|checkout|storekit|subscribe/i.test(body));
  t("no wearable connect actions", !/connectGarmin|connectStrava|connectIntervals|oauth|onboardingConnect/i.test(body));
  t("no App Store / Google Play names, approval claims or badges",
    !/app store|google play|play store|apple app store|approved by|now on (the )?(app|play)|badge/i.test(body));
  t("no fake store badge assets", !/<img[^>]*(badge|get-it-on|download-on)/i.test(body));
  t("no href to signup/pricing routes", !/href="\/(signup|ai-signup|pricing)"/.test(body));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
