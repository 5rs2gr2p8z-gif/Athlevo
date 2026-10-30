/**
 * Athlevo Coaching rebrand + four-section shell — focused contract.
 *  - public product name on user-facing surfaces
 *  - package/application id untouched
 *  - AI disclosure / consent language preserved
 *  - Settings stays out of primary navigation but reachable
 *  - Fuel reachable, Google native callback preserved, deep links preserved
 *  - small-screen nav fit
 * Run: node tests/athlevo-coaching-rebrand.test.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const manifest = JSON.parse(readFileSync("./manifest.webmanifest", "utf8"));
const capacitor = JSON.parse(readFileSync("./capacitor.config.json", "utf8"));
const strings = readFileSync("./android/app/src/main/res/values/strings.xml", "utf8");
const androidManifest = readFileSync("./android/app/src/main/AndroidManifest.xml", "utf8");
const gradle = readFileSync("./android/app/build.gradle", "utf8");
const runtimeEnv = readFileSync("./js/runtimeEnvironment.js", "utf8");
const accessGuard = readFileSync("./js/accessGuard.js", "utf8");
const aiConsent = readFileSync("./js/aiConsent.js", "utf8");
const fuel = readFileSync("./js/fuel.js", "utf8");
const privacy = readFileSync("./legal/privacy-policy.md", "utf8");
const nativeCheck = readFileSync("./scripts/check-native-assets.mjs", "utf8");
const release = JSON.parse(readFileSync("./distribution/android-release.json", "utf8"));

let passed = 0;
let failed = 0;
function test(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  return from >= 0 && to >= 0 ? source.slice(from, to) : "";
}

console.log("\n──── Public product name = Athlevo Coaching ────");
test("PWA manifest name and short name", manifest.name === "Athlevo Coaching" && manifest.short_name === "Athlevo Coaching");
test("PWA manifest no longer markets an 'AI endurance coach'", !/\bAI\b/.test(manifest.name + manifest.description));
test("Capacitor appName", capacitor.appName === "Athlevo Coaching");
test("Android installed app label and activity title",
  /<string name="app_name">Athlevo Coaching<\/string>/.test(strings) &&
  /<string name="title_activity_main">Athlevo Coaching<\/string>/.test(strings));
test("page title and social/app metadata",
  /<title>Athlevo Coaching — /.test(html) &&
  /og:site_name" content="Athlevo Coaching"/.test(html) &&
  /apple-mobile-web-app-title" content="Athlevo Coaching"/.test(html) &&
  /name="application-name" content="Athlevo Coaching"/.test(html));
test("sidebar brand reads Athlevo Coaching", /id="coachSidePanelTitle">[\s\S]*?<span>Athlevo Coaching<\/span>/.test(html));
test("Coach logo is labelled Athlevo Coaching", /class="coach-logo-bubble" aria-label="Athlevo Coaching"/.test(html));
test("sign-up (welcome) shows the Athlevo wordmark over the photo, not the old 'Athlevo AI' lockup",
  /id="screen-welcome"[\s\S]*?<img class="w-wordmark" src="assets\/brand\/athlevo-wordmark-white\.png" alt="Athlevo"/.test(html));
test("support surface names the product", /<h1>Athlevo Coaching Support<\/h1>/.test(html));
const appRegion = html.slice(html.indexOf('id="screen-welcome"'));
test("no 'Athlevo AI' label remains in the authenticated app / sign-up shell", !/Athlevo AI/.test(appRegion),
  (appRegion.match(/.{30}Athlevo AI.{20}/) || [""])[0]);
test("onboarding headings no longer say 'Your AI coach is ready'",
  !/Your AI coach is (now )?ready/.test(readFileSync("./js/planSetup.js", "utf8") + readFileSync("./js/onboardingConnect.js", "utf8")));

console.log("\n──── Package / application id untouched ────");
test("Capacitor appId is org.athlevo.app", capacitor.appId === "org.athlevo.app");
test("Gradle applicationId/namespace is org.athlevo.app", /applicationId "org\.athlevo\.app"/.test(gradle) && /namespace = "org\.athlevo\.app"/.test(gradle));
test("strings.xml package_name is org.athlevo.app", /<string name="package_name">org\.athlevo\.app<\/string>/.test(strings));
test("release record package id is org.athlevo.app", release.packageId === "org.athlevo.app");

console.log("\n──── AI disclosure and consent preserved ────");
test("AI consent module is intact (consent v2)", /CONSENT_VERSION = "2"/.test(aiConsent));
test("Settings still shows the AI-powered features consent row and its detail section",
  (html.match(/AI-powered features/g) || []).length >= 2 && /id="aiConsentStatusLabel"/.test(html));
test("Fuel meal-photo analysis is still presented as an AI estimate the athlete confirms",
  /Athlevo suggests an estimate/.test(fuel));
test("privacy policy still discloses AI coaching / AI responses",
  /AI endurance coaching platform/.test(privacy) && /generate AI coaching responses/.test(privacy));
test("delete-account data list still mentions AI coaching conversations", /AI coaching conversations and coach memory/.test(html));
test("paywall copy keeps 'full AI coaching access' as the accurate feature description", /full AI coaching access/.test(accessGuard));
test("locked Coach preview says the responses are AI-generated (never implies a human)", /Coach responses are generated by AI/.test(accessGuard));
test("Coach tab is named Coach, not 'AI Coach'", /<span>Coach<\/span>/.test(between(html, 'id="tabbar"', "</nav>")));

console.log("\n──── Navigation: Settings out of primary nav, still reachable ────");
const tabbar = between(html, 'id="tabbar"', "</nav>");
const rail = between(html, 'class="coach-side-panel-section coach-rail-nav"', '<div class="coach-side-panel-section" data-coach-auth="signed-in"');
test("Settings is not a primary tab", !/screen-settings|openSettings|Settings/.test(tabbar));
const railPrimary = [...rail.matchAll(/data-screen="([^"]+)"/g)].map(m => m[1]);
test("sidebar primary items are the same four sections in the same order",
  railPrimary.join(" / ") === "screen-today / screen-train / screen-coachai / screen-trends", railPrimary.join(" / "));
test("sidebar keeps exactly one Settings action below the primary four", (rail.match(/openSettings\(\)/g) || []).length === 1);
test("Settings screen and opener still exist", /id="screen-settings"/.test(html) && /function openSettings\(/.test(html));
test("duplicate account Settings entry stays hidden on tablet/desktop where the rail already has it",
  /body\.layout-desktop \[data-coach-auth="signed-in"\] \[onclick="runCoachMenuAction\('settings'\)"\]\{display:none\}/.test(html));
test("Settings is reachable from You (profile avatar → You) and the You screen exists",
  /onclick="openProfileScreen\(\)"/.test(html) && /id="screen-you"/.test(html));
test("Fuel is reachable from You and Home", /AthlevoFuel\.open\('you_card'\)/.test(html) && /AthlevoFuel\.open\('home_card'\)/.test(html));

console.log("\n──── Google native callback + deep links preserved ────");
test("native Google callback constant unchanged", /AUTH_CALLBACK = "athlevo:\/\/auth\/callback"/.test(runtimeEnv));
test("Android intent filters for auth and provider callbacks unchanged",
  /android:host="auth"[\s\S]*?android:path="\/callback"[\s\S]*?android:scheme="athlevo"/.test(androidManifest) &&
  /android:host="provider"[\s\S]*?android:path="\/callback"[\s\S]*?android:scheme="athlevo"/.test(androidManifest));
const deepMap = between(html, "var ATHLEVO_DEEP_LINK_SCREENS = {", "};");
test("?screen= deep links resolve to the four canonical screens (legacy today/train still accepted)",
  /home: "screen-today"/.test(deepMap) && /today: "screen-today"/.test(deepMap) &&
  /calendar: "screen-train"/.test(deepMap) && /train: "screen-train"/.test(deepMap) &&
  /coach: "screen-coachai"/.test(deepMap) && /you: "screen-trends"/.test(deepMap));
test("deep link is applied once after the normal authenticated landing, then the param is dropped",
  /await applyAppDeepLink\(\)/.test(html) && /params\.delete\("screen"\)/.test(html));
test("PWA shortcuts point at the new section names",
  manifest.shortcuts.map(s => s.url).join("|") ===
    "/?screen=home&source=shortcut|/?screen=calendar&source=shortcut|/?screen=coach&source=shortcut");
test("legacy #coach fragment is still cleaned by routeAfterAuth", /location\.hash === "#coach"/.test(between(html, "async function routeAfterAuth", "function isStandaloneMode")));

console.log("\n──── Android release scope ────");
test("release record keeps versionCode 7 and is not marked uploaded",
  release.versionCode === 7 && /pending/.test(release.status) && release.versionCodeVerifiedAgainstPlayConsole === false);
test("Gradle versionCode is still 7 (no version bump for this rebrand)", /versionCode 7\b/.test(gradle));
test("native asset check requires the Home tab, Home dashboard and the new name in the bundle",
  /Home tab in the athlete nav/.test(nativeCheck) && /Home dashboard/.test(nativeCheck) && /Athlevo Coaching PWA name/.test(nativeCheck));

console.log("\n──── Small-screen nav fit (4 tabs) ────");
const capsule = between(html, ".tabbar {", "isolation: isolate;");
const m = capsule.match(/width:\s*min\((\d+)px,\s*calc\(100% - (\d+)px\)\)/);
const maxW = m ? Number(m[1]) : 0, sideGap = m ? Number(m[2]) : 0;
const pad = Number((capsule.match(/padding:\s*(\d+)px;/) || [])[1]);
const gap = Number((capsule.match(/gap:\s*(\d+)px;/) || [])[1]);
const tabPadX = Number((html.match(/\.tabbar--capsule \.tab\{padding:\d+px (\d+)px\}/) || [])[1]);
// "Calendar" is the longest label: 8 glyphs at 11px/650 ≈ 0.62em average + .025em tracking.
const labelPx = 8 * (11 * 0.62 + 11 * 0.025);
for (const viewport of [320, 360, 390, 412]) {
  const cap = Math.min(maxW, viewport - sideGap);
  const perTab = (cap - 2 * pad - 3 * gap) / 4;
  test(`${viewport}px: longest label fits inside its tab with margin`, perTab - 2 * tabPadX >= labelPx + 4,
    `tab ${perTab.toFixed(1)}px, content ${(perTab - 2 * tabPadX).toFixed(1)}px, label≈${labelPx.toFixed(1)}px`);
  test(`${viewport}px: capsule stays inside the viewport`, cap <= viewport - sideGap && cap > 0);
}
test("desktop/tablet Home greeting is kept clear of the floating rail toggle",
  /body\.layout-desktop #screen-today \.today-header\{margin-top:72px\}/.test(html));
test("tab labels never wrap", /\.tabbar--capsule \.tab span\{white-space:nowrap/.test(html));
test("capsule respects the bottom safe area", /bottom:\s*calc\(10px \+ var\(--athlevo-safe-bottom/.test(capsule));
test("every tab keeps a ≥48px tap target", /\.tab\{[^}]*min-height:56px/.test(html));
test("active tab state is still the filled pill", /\.tabbar--capsule \.tab\.on\{[^}]*background:var\(--nav-tab-active-bg/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
