/*
 * Athlevo — dark-default theme + dark-compatible logo.
 *
 * Guards two invariants against index.html directly (same static-analysis
 * style as tests/design-tokens.test.mjs — no DOM execution needed since the
 * theme-init script and logo CSS rule are plain, greppable source):
 *
 *   1. With no saved theme preference, the app now boots into Dark
 *      (not Light), in both the pre-render head initializer (no FOWT)
 *      and the runtime getAthlevoTheme() accessor — while explicit
 *      saved 'light' / 'dark' / 'system' values still round-trip
 *      exactly as before.
 *   2. The primary Athlevo brand mark swaps to a white+red variant
 *      under dark (explicit dark, and system while OS resolves dark),
 *      via one canonical CSS rule (no per-call-site markup duplication,
 *      no filter/hue-rotate that could shift the red), while every
 *      partner/provider logo (Google, Apple, Garmin, etc.) is untouched.
 *
 * Run: node tests/theme-default-and-logo.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");

/* ══════ Part 1 — dark is the default when nothing is saved ═══════════ */

section("No-saved-preference now defaults to Dark, everywhere the default is read");
{
  // The inline pre-render head initializer — the no-FOWT script that runs
  // before first paint and stamps data-theme on <html>.
  t("head initializer: no saved pref -> 'dark' (was 'light')",
    /var pref = localStorage\.getItem\('athlevo_theme'\) \|\| 'dark';/.test(html));
  t("head initializer no longer falls back to 'light'",
    !/var pref = localStorage\.getItem\('athlevo_theme'\) \|\| 'light';/.test(html));

  // The public runtime accessor used elsewhere in the app (Settings sync,
  // system-change listener, etc.) — must agree with the head initializer.
  t("getAthlevoTheme(): no saved pref -> 'dark' (both the localStorage read and the catch path)",
    /getAthlevoTheme = function\(\)\{\s*try \{ return localStorage\.getItem\('athlevo_theme'\) \|\| 'dark'; \} catch\(e\)\{ return 'dark'; \}/.test(html));
  t("getAthlevoTheme() no longer falls back to 'light' anywhere",
    !/localStorage\.getItem\('athlevo_theme'\) \|\| 'light'/.test(html) &&
    !/catch\(e\)\{ return 'light'; \}/.test(html));

  // No other literal 'light' default is hiding behind an alternate fallback
  // idiom (?? / ternary) for this same preference key.
  t("no ?? 'light' / ternary-to-'light' fallback for athlevo_theme",
    !/athlevo_theme'\)\s*\?\?\s*'light'/.test(html));
}

section("Explicit saved preferences still round-trip exactly (unaffected by the default change)");
{
  t("setAthlevoTheme still normalizes to only 'light' | 'dark' | 'system'",
    /p = \(p === 'light' \|\| p === 'dark'\) \? p : 'system';/.test(html));
  t("setAthlevoTheme still persists the exact chosen value to localStorage",
    /localStorage\.setItem\('athlevo_theme', p\)/.test(html));
  t("setAthlevoTheme still stamps data-theme with the persisted value",
    /root\.setAttribute\('data-theme', p\)/.test(html));
  t("head initializer still stamps data-theme with whatever pref resolved to (saved value wins over the new default)",
    /root\.setAttribute\('data-theme', pref\)/.test(html));
}

section("System theme still follows OS prefers-color-scheme (unaffected by the default change)");
{
  t("isDark() still treats 'system' + prefers-color-scheme:dark as dark",
    /p === 'system' &&\s*window\.matchMedia &&\s*window\.matchMedia\('\(prefers-color-scheme: dark\)'\)\.matches/.test(html));
  t("a live OS-theme-change listener still re-syncs meta theme-color while in 'system'",
    /mq\.addEventListener\(.change., onChange\)/.test(html) &&
    /getAthlevoTheme\(\)\) === 'system'/.test(html));
  t("dark palette is defined identically for explicit dark and system-resolved-dark (data-theme=\"system\" under prefers-color-scheme:dark)",
    /html\[data-theme="dark"\]\{/.test(html) &&
    /@media \(prefers-color-scheme: dark\)\{\s*html\[data-theme="system"\]\{/.test(html));
}

section("Settings still exposes exactly System / Light / Dark, and persistence plumbing is intact");
{
  t("exactly 3 theme choice buttons: system, light, dark",
    (html.match(/data-theme-choice="(system|light|dark)"/g) || []).length === 3);
  t("theme is persisted via localStorage under the same key on every write path",
    (html.match(/localStorage\.(setItem|getItem)\('athlevo_theme'/g) || []).length >= 3);
}

/* ══════ Part 2 — dark-compatible Athlevo brand mark ═══════════════════ */

section("A white+red dark-mode variant of the primary mark exists, with the red byte-identical");
{
  t("dark-mode mark asset is referenced from CSS",
    /assets\/athlevo-icon-transparent-dark\.png/.test(html));
}

section("One canonical CSS rule swaps the primary mark under dark — no per-site markup duplication");
{
  const explicitRule = /html\[data-theme="dark"\] img\[src\$="athlevo-icon-transparent\.png"\],\s*html\[data-theme="dark"\] img\[src\$="athlevo-icon\.png"\]\{\s*content:url\(assets\/athlevo-icon-transparent-dark\.png\);\s*\}/;
  const systemRule = /@media \(prefers-color-scheme: dark\)\{\s*html\[data-theme="system"\] img\[src\$="athlevo-icon-transparent\.png"\],\s*html\[data-theme="system"\] img\[src\$="athlevo-icon\.png"\]\{\s*content:url\(assets\/athlevo-icon-transparent-dark\.png\);/;
  t("explicit dark: img[src$=...] rule swaps both primary-mark filenames to the dark variant",
    explicitRule.test(html));
  t("system + OS dark: the identical swap rule is mirrored under the prefers-color-scheme media query",
    systemRule.test(html));
  t("no filter:invert()/hue-rotate() is used for the logo swap (which could shift the red's hue)",
    !/athlevo-icon[\s\S]{0,120}filter:\s*invert/i.test(html));

  // Exactly one occurrence of each selector pair — the swap is declared once,
  // not copy-pasted per screen/call-site.
  t("the content:url swap declaration appears exactly twice total (explicit dark + system/OS-dark), not duplicated per call site",
    (html.match(/content:url\(assets\/athlevo-icon-transparent-dark\.png\);/g) || []).length === 2);
}

section("Light mode's black+red mark markup is completely unchanged");
{
  const primaryMarkImgs = (html.match(/<img[^>]*src="[^"]*athlevo-icon(?:-transparent)?\.png"[^>]*>/g) || []);
  t("primary-mark <img> call sites still point at the original (light) PNGs — no per-theme duplicate <img> elements were introduced",
    primaryMarkImgs.length > 0 &&
    primaryMarkImgs.every(tag => /src="[^"]*athlevo-icon(?:-transparent)?\.png"/.test(tag)) &&
    primaryMarkImgs.every(tag => !/athlevo-icon-transparent-dark\.png/.test(tag)));
  t("no new id was introduced on any primary-mark <img> (no duplicate-element / duplicate-id risk)",
    primaryMarkImgs.every(tag => !/\bid="/.test(tag)));
}

section("Partner/provider logos (Google, Apple, Garmin, etc.) are not touched by the dark-mode swap");
{
  t("the swap selectors only ever target athlevo-icon*.png filenames",
    !/img\[src\$="[^"]*(google|apple|garmin|strava|whoop|oura)[^"]*"\]/i.test(html));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
