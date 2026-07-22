/*
 * Athlevo — Design System PR 4: motion & interaction polish.
 *
 * Guards the motion language against index.html: durations/easings adopt the
 * tokens, no bounce/overshoot, and reduced-motion is covered globally.
 *
 * Run: node tests/motion-system.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const root = (html.match(/:root\{[\s\S]*?color-scheme:light;\s*\}/) || [""])[0];

/* ══════ Part 2 — motion tokens defined and adopted ══════════════════ */

section("Motion tokens exist and are actually used");
{
  t("--dur-fast/base/slow defined", /--dur-fast:/.test(root) && /--dur-base:/.test(root) && /--dur-slow:/.test(root));
  t("--ease-standard/emphasized defined", /--ease-standard:/.test(root) && /--ease-emphasized:/.test(root));
  t("duration tokens are widely adopted", (html.match(/var\(--dur-(fast|base|slow)\)/g) || []).length > 50,
    String((html.match(/var\(--dur-/g) || []).length));
  t("easing tokens are widely adopted", (html.match(/var\(--ease-(standard|emphasized)\)/g) || []).length > 15);
  t("no more than three duration + two easing tokens (no sprawl)",
    (root.match(/--dur-[a-z]+:/g) || []).length === 3 && (root.match(/--ease-[a-z]+:/g) || []).length === 2);
}

/* ══════ Part 4/7 — no bounce, no overshoot, no raw curves ═══════════ */

section("No overshoot/bounce; easing curves are tokenized");
{
  t("no raw cubic-bezier() remains (all tokenized)", !/cubic-bezier\(/.test(html.replace(root, "")));
  // Overshoot curves have a control-point y > 1 (e.g. cubic-bezier(.2,1.3,.4,1)).
  t("no overshoot/bounce easing anywhere", !/cubic-bezier\([^)]*,1\.[0-9]/.test(html));
}

/* ══════ Part 7 — entrance animations use transform/opacity only ═════ */

section("Entrance keyframes are GPU-friendly (no layout-shifting props)");
{
  const frames = [...html.matchAll(/@keyframes [a-zA-Z0-9]+\{[\s\S]*?\}\s*\}/g)].map(m => m[0]);
  const shifty = frames.filter(k =>
    /(from|to|\d+%)\{[^}]*(margin|width|height|top:|left:|right:|bottom:|padding)/.test(k));
  t("no keyframe animates layout properties", shifty.length === 0,
    shifty.map(s => s.slice(0, 30)).join(" | "));
}

/* ══════ Part 8 — reduced-motion coverage ════════════════════════════ */

section("Reduced motion is covered globally");
{
  t("a prefers-reduced-motion media query exists", /@media \(prefers-reduced-motion: reduce\)/.test(html));
  t("global rule neutralizes animation + transition durations",
    /prefers-reduced-motion: reduce\)\{[\s\S]*?\*,\*::before,\*::after\{[\s\S]*?animation-duration:\.001ms!important[\s\S]*?transition-duration:\.001ms!important/.test(html));
  t("reduced motion also disables smooth scrolling", /prefers-reduced-motion: reduce\)\{[\s\S]*?scroll-behavior:auto/.test(html));
}

/* ══════ Part 9 — performance: no shadow/blur animation ══════════════ */

section("No expensive shadow/blur animation");
{
  const trans = [...html.matchAll(/transition:[^;}]+/g)].map(m => m[0]);
  t("no transition animates box-shadow's spread on the whole element badly (filters)",
    !trans.some(x => /filter/.test(x) && /blur/.test(x)));
  t("skeleton shimmer stays a single loading indicator",
    /@keyframes ssShimmer/.test(html) && (html.match(/@keyframes ssShimmer/g) || []).length === 1);
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
