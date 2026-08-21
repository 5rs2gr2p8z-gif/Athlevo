/*
 * Athlevo — You / Settings cleanup.
 *
 * Verifies the redesigned You screen with inline settings sections and the
 * Profile Settings screen against the REAL shipped files.
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
  t("no settings gear button",
    !youHTML.includes('class="you-gear"'));
}

section("You screen — Settings section (inline)");
{
  t("Settings section title present",
    youHTML.includes(">Settings<"));
  t("Profile Settings row present",
    youHTML.includes(">Profile Settings<"));
  t("Appearance control remains",
    youHTML.includes('id="themeSeg"'));
  t("Appearance has System/Light/Dark",
    youHTML.includes("System") && youHTML.includes("Light") && youHTML.includes("Dark"));
  t("Notification Settings present",
    youHTML.includes(">Notification Settings<"));
  t("Install Athlevo row present",
    youHTML.includes('id="youInstallRow"'));
}

section("You screen — Support & Legal section (inline)");
{
  t("Support & Legal section title present",
    youHTML.includes("Support &amp; Legal") || youHTML.includes("Support & Legal"));
  t("Support row present",
    youHTML.includes(">Support<"));
  t("Privacy Policy row present",
    youHTML.includes(">Privacy Policy<"));
  t("Terms of Service row present",
    youHTML.includes(">Terms of Service<"));
}

section("You screen — Delete Account (quiet)");
{
  t("Delete Account present",
    youHTML.includes("Delete Account"));
  t("Delete Account uses you-delete-row (quiet style)",
    youHTML.includes("you-delete-row"));
  t("Delete Account NOT in a rowlink-danger card",
    !youHTML.includes('rowlink-danger-subtle'));
  t("Delete Account calls openDeleteAccount",
    youHTML.includes("openDeleteAccount()"));
}

section("You screen — Log Out (bottom, neutral)");
{
  t("Log Out present",
    youHTML.includes("Log Out"));
  t("Log Out uses you-logout-row (neutral style)",
    youHTML.includes("you-logout-row"));
  t("Log Out calls doLogout",
    youHTML.includes("doLogout()"));
  t("Log Out appears after Delete Account",
    youHTML.indexOf("you-logout-row") > youHTML.indexOf("you-delete-row"));
}

section("You screen — kept items");
{
  t("Training Data card remains (syncStatusCard)",
    youHTML.includes('id="syncStatusCard"'));
  t("Profile header remains (profileName)",
    youHTML.includes('id="profileName"'));
  t("Profile initial remains (profileInitial)",
    youHTML.includes('id="profileInitial"'));
  t("App version footer remains",
    youHTML.includes('id="appVersionDisplay"'));
  t("Coach memory section still exists",
    youHTML.includes('id="coachMemorySection"'));
}

section("You screen — profile photo CSS");
{
  t("pfp img style for photo display",
    html.includes(".pfp img{"));
  t("pfp has overflow:hidden",
    html.includes(".pfp{") && html.match(/\.pfp\{[^}]*overflow:hidden/));
}

section("You screen — compact Appearance");
{
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

section("You screen — Install Athlevo on native");
{
  t("youInstallRow still exists in markup for web/PWA",
    youHTML.includes('id="youInstallRow"'));
  t("runtimeEnvironment.js hides youInstallRow on native",
    runtimeEnv.includes("youInstallRow") && runtimeEnv.includes("display:none"));
}

/* ══════════════ SETTINGS (Profile Settings) SCREEN ═════════════════ */

section("Settings screen — Profile Settings");
{
  t("has 'Profile Settings' title",
    settingsHTML.includes(">Profile Settings<"));
  t("has back button with aria-label='Back'",
    settingsHTML.includes('aria-label="Back"'));
  t("back calls closeSettings()",
    settingsHTML.includes('onclick="closeSettings()"'));
  t("has profile photo area",
    settingsHTML.includes("settingsProfilePhoto"));
  t("has Change photo button",
    settingsHTML.includes("changePhotoBtn") || settingsHTML.includes("Change photo"));
  t("has Remove photo button",
    settingsHTML.includes("removePhotoBtn") || settingsHTML.includes("Remove"));
  t("has file input for photo selection",
    settingsHTML.includes('id="profilePhotoInput"'));
  t("has account name display",
    settingsHTML.includes("settingsAccountName"));
  t("has account email display",
    settingsHTML.includes("settingsAccountEmail"));
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

/* ══════════════ PROFILE PHOTO LOGIC ════════════════════════════════ */

section("Profile photo");
{
  t("updateAllProfilePhotos function exists",
    html.includes("function updateAllProfilePhotos"));
  t("renderProfilePhotoElement function exists",
    html.includes("function renderProfilePhotoElement"));
  t("changeProfilePhoto function exists",
    html.includes("function changeProfilePhoto"));
  t("handleProfilePhotoSelect function exists",
    html.includes("function handleProfilePhotoSelect"));
  t("removeProfilePhoto function exists",
    html.includes("function removeProfilePhoto"));
  t("Google avatar fallback cached (_athlevoGoogleAvatarUrl)",
    html.includes("_athlevoGoogleAvatarUrl"));
  t("Custom photo takes priority (_athlevoProfilePhotoUrl)",
    html.includes("_athlevoProfilePhotoUrl"));
  t("Profile photo cleared on logout",
    html.includes("_athlevoProfilePhotoUrl = null") &&
    html.includes("_athlevoGoogleAvatarUrl = null"));
}

/* ══════════════ LOADING SKELETON ════════════════════════════════════ */

section("Loading skeleton");
{
  const skelStart = html.indexOf('data-loading-surface="you"');
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
  t("cache version bumped (≥v86)",
    /athlevo-shell-v(8[6-9]|9\d|\d{3,})/.test(sw));
}

/* ══════════════ SUMMARY ════════════════════════════════════════════ */

console.log(`\n${"═".repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed  (${pass + fail} total)`);
console.log("═".repeat(50));
process.exit(fail > 0 ? 1 : 0);
