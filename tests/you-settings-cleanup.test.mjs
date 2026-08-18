/*
 * Athlevo — You / Settings cleanup.
 *
 * Verifies the simplified You screen and the new dedicated Settings surface
 * against the REAL shipped files.
 *
 * Run: node tests/you-settings-cleanup.test.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const runtimeEnv = readFileSync("./js/runtimeEnvironment.js", "utf8");

/* ── helpers ── */

// Extract the screen-you section HTML.
const youStart = html.indexOf('id="screen-you"');
const youEnd   = html.indexOf('id="screen-settings"');
const youHTML  = html.slice(youStart, youEnd);

// Extract the screen-settings section HTML.
const settingsStart = html.indexOf('id="screen-settings"');
const settingsEnd   = html.indexOf("</section>", settingsStart) + "</section>".length;
const settingsHTML  = html.slice(settingsStart, settingsEnd);

/* ══════════════ MAIN YOU SCREEN ══════════════════════════════════════ */

section("You screen — removed items");
{
  t("no 'Open today's check-in' row",
    !youHTML.includes("Open today's check-in") && !youHTML.includes("open today's check-in"));
  t("no Notification Settings row",
    !youHTML.includes(">Notification Settings<"));
  t("no Support row",
    !youHTML.includes(">Support<"));
  t("no Privacy Policy row",
    !youHTML.includes(">Privacy Policy<"));
  t("no Terms of Service row",
    !youHTML.includes(">Terms of Service<"));
  t("no Account Settings row",
    !youHTML.includes(">Account Settings<"));
  t("no Log Out row",
    !youHTML.includes(">Log Out<"));
  t("no Delete Account row",
    !youHTML.includes(">Delete Account<"));
}

section("You screen — kept items");
{
  t("Training Data card remains (syncStatusCard)",
    youHTML.includes('id="syncStatusCard"'));
  t("Appearance control remains",
    youHTML.includes('id="themeSeg"'));
  t("Appearance has System/Light/Dark",
    youHTML.includes("System") && youHTML.includes("Light") && youHTML.includes("Dark"));
  t("Profile header remains (profileName)",
    youHTML.includes('id="profileName"'));
  t("Profile initial remains (profileInitial)",
    youHTML.includes('id="profileInitial"'));
  t("App version footer remains",
    youHTML.includes('id="appVersionDisplay"'));
}

section("You screen — compact Appearance");
{
  // The seg control should have reduced padding/height
  const segCSS = html.match(/\.seg\{[^}]+\}/);
  t("seg control has compact padding (3px)",
    segCSS && segCSS[0].includes("padding:3px"));
  const segBtnCSS = html.match(/\.seg-btn\{[^}]+\}/);
  t("seg-btn has reduced min-height (36px)",
    segBtnCSS && segBtnCSS[0].includes("min-height:36px"));
  t("seg-btn uses smaller font size (body-sm)",
    segBtnCSS && segBtnCSS[0].includes("fs-body-sm"));
  const appearanceRowCSS = html.match(/\.appearance-row\{[^}]+\}/);
  t("appearance-row has reduced padding (10px 16px)",
    appearanceRowCSS && appearanceRowCSS[0].includes("padding:10px 16px"));
}

section("You screen — gear icon");
{
  t("gear button exists with aria-label='Settings'",
    youHTML.includes('aria-label="Settings"'));
  t("gear uses .you-gear class",
    youHTML.includes('class="you-gear"'));
  t("gear calls openSettings()",
    youHTML.includes('onclick="openSettings()"'));
  // CSS: 44x44 tap target
  const gearCSS = html.match(/\.you-gear\{[^}]+\}/);
  t("gear has 44px width tap target",
    gearCSS && gearCSS[0].includes("width:44px"));
  t("gear has 44px height tap target",
    gearCSS && gearCSS[0].includes("height:44px"));
  // SVG size ~20px
  const gearSvgCSS = html.match(/\.you-gear svg\{[^}]+\}/);
  t("gear SVG is 20px",
    gearSvgCSS && gearSvgCSS[0].includes("width:20px"));
}

section("You screen — Install Athlevo on native");
{
  t("youInstallRow still exists in markup for web/PWA",
    youHTML.includes('id="youInstallRow"'));
  t("runtimeEnvironment.js hides youInstallRow on native",
    runtimeEnv.includes("youInstallRow") && runtimeEnv.includes("display:none"));
}

/* ══════════════ SETTINGS SCREEN ═════════════════════════════════════ */

section("Settings screen — accessible items");
{
  t("Notification Settings accessible",
    settingsHTML.includes(">Notification Settings<"));
  t("Account Settings accessible",
    settingsHTML.includes(">Account Settings<"));
  t("Support accessible",
    settingsHTML.includes(">Support<"));
  t("Privacy Policy accessible",
    settingsHTML.includes(">Privacy Policy<"));
  t("Terms of Service accessible",
    settingsHTML.includes(">Terms of Service<"));
  t("Log Out accessible",
    settingsHTML.includes(">Log Out<"));
  t("Delete Account accessible",
    settingsHTML.includes(">Delete Account<"));
  t("Delete Account uses danger styling",
    settingsHTML.includes("rowlink-danger-subtle"));
}

section("Settings screen — structure");
{
  t("has back button with aria-label='Back'",
    settingsHTML.includes('aria-label="Back"'));
  t("back calls closeSettings()",
    settingsHTML.includes('onclick="closeSettings()"'));
  t("has 'Settings' title",
    settingsHTML.includes(">Settings<"));
  t("has Preferences section",
    settingsHTML.includes(">Preferences<"));
  t("has Account section",
    settingsHTML.includes(">Account<"));
  t("has Support & Legal section",
    settingsHTML.includes("Support &amp; Legal") || settingsHTML.includes("Support & Legal"));
  t("has version display",
    settingsHTML.includes("settingsVersionDisplay"));
}

/* ══════════════ NAVIGATION ══════════════════════════════════════════ */

section("Navigation");
{
  t("openSettings function exists",
    html.includes("function openSettings()"));
  t("closeSettings function exists",
    html.includes("function closeSettings()"));
  t("openSettings is window-global",
    html.includes("window.openSettings = openSettings"));
  t("closeSettings is window-global",
    html.includes("window.closeSettings = closeSettings"));
  t("Android back button listener for Settings",
    html.includes("backbutton") || html.includes("backButton"));
  t("Capacitor backButton wired for closeSettings",
    html.includes("Capacitor.Plugins.App") && html.includes("closeSettings"));
  t("closeSettings restores You screen",
    html.includes('screen-you') && html.includes("closeSettings"));
  t("You scroll position is preserved",
    html.includes("_youScrollY"));
}

/* ══════════════ LOADING SKELETON ════════════════════════════════════ */

section("Loading skeleton");
{
  const skelStart = html.indexOf('data-loading-surface="you"');
  // Grab ~600 chars which covers the full skeleton block
  const skeleton = html.slice(skelStart, skelStart + 600);
  t("skeleton has profile block",
    skeleton.includes("asl-profile"));
  t("skeleton has training data card",
    skeleton.includes("asl-training-data"));
  t("skeleton does NOT have support rows",
    !skeleton.includes("asl-support-row"));
  t("skeleton does NOT have support label",
    !skeleton.includes("asl-support-label"));
  t("skeleton does NOT have old preferences rows (multiple asl-preference for admin)",
    // Only one compact appearance placeholder, not two+ preference rows
    (skeleton.match(/asl-preference/g) || []).length <= 1);
}

/* ══════════════ COACH / WORKSPACE ══════════════════════════════════ */

section("Coach / workspace integrity");
{
  t("Coach workspace switcher injection still exists",
    html.includes("injectAthleteYouSwitcher"));
  t("Coach memory section still exists",
    html.includes('id="coachMemorySection"'));
  t("Coach workspace logic untouched",
    html.includes("isAthleteWorkspace"));
}

/* ══════════════ SERVICE WORKER ═══════════════════════════════════════ */

section("Service worker cache");
{
  const sw = readFileSync("./service-worker.js", "utf8");
  t("cache version bumped (≥v84)",
    /athlevo-shell-v(8[4-9]|9\d|\d{3,})/.test(sw));
}

/* ══════════════ SUMMARY ════════════════════════════════════════════ */

console.log(`\n${"═".repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed  (${pass + fail} total)`);
console.log("═".repeat(50));
process.exit(fail > 0 ? 1 : 0);
