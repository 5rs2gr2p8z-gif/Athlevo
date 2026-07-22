/*
 * Athlevo — Design System PR 2: typography system.
 *
 * Guards the type-scale invariants against index.html: tokens exist, the
 * near-identical size clusters are gone (collapsed to tokens), utilities are
 * defined, and only a small number of intentional hero one-offs remain.
 *
 * Run: node tests/typography.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const root = (html.match(/:root\{[\s\S]*?color-scheme:light;\s*\}/) || [""])[0];

/* ══════ Part 2 — the type tokens exist ═══════════════════════════════ */

section("Typography tokens are defined in :root");
{
  ["--fs-display:32px", "--fs-h1:24px", "--fs-h2:20px", "--fs-h3:17px",
   "--fs-body:14.5px", "--fs-body-sm:13px", "--fs-caption:12px", "--fs-micro:11px"]
    .forEach(tok => t("size " + tok, root.includes(tok)));
  ["--lh-display", "--lh-heading", "--lh-body", "--lh-compact", "--lh-caption"]
    .forEach(tok => t("line-height " + tok, new RegExp(tok + ":").test(root)));
  ["--fw-regular:400", "--fw-medium:550", "--fw-semibold:650", "--fw-bold:750"]
    .forEach(tok => t("weight " + tok, root.includes(tok)));
  ["--ls-tight", "--ls-normal", "--ls-wide"].forEach(tok => t("letter-spacing " + tok, new RegExp(tok + ":").test(root)));
  t("display family maps to Fraunces (serif)", /--font-display:var\(--serif\)/.test(root));
  t("ui family maps to the sans", /--font-ui:var\(--sans\)/.test(root));
  t("exactly 8 core size roles", (root.match(/--fs-[a-z0-9-]+:/g) || []).length === 8,
    String((root.match(/--fs-[a-z0-9-]+:/g) || []).length));
}

/* ══════ Part 3 — utility roles compose the tokens ════════════════════ */

section("Typography utilities exist and compose tokens (no duplicate values)");
{
  [".type-display", ".type-h1", ".type-h2", ".type-h3", ".type-body",
   ".type-body-sm", ".type-caption", ".type-micro", ".type-metric", ".type-button"]
    .forEach(cls => t(cls + " defined", new RegExp("\\" + cls + "\\{").test(html)));
  const util = html.slice(html.indexOf(".type-display{"), html.indexOf(".type-button{") + 200);
  t("utilities use var(--fs-*), not raw px", !/\.type-[a-z0-9-]+\{[^}]*font-size:[0-9]/.test(util));
  t("display + h1 use the display font", /\.type-display\{[^}]*var\(--font-display\)/.test(html) &&
    /\.type-h1\{[^}]*var\(--font-display\)/.test(html));
  t("metric utility uses tabular-nums", /\.type-metric\{[^}]*tabular-nums/.test(html));
}

/* ══════ Part 9 — the 33-size sprawl is collapsed ═════════════════════ */

section("Font-size sprawl collapsed to tokens + a few hero one-offs");
{
  const literals = [...html.matchAll(/font-size:([0-9.]+)px/g)].map(m => m[1]);
  const distinct = [...new Set(literals)];
  t("near-identical clusters are gone (no 12.5/13.5/14/14.5 literals)",
    !distinct.includes("12.5") && !distinct.includes("13.5") && !distinct.includes("14") && !distinct.includes("14.5"),
    distinct.join(","));
  t("no 10/10.5/11.5 micro-cluster literals remain",
    !distinct.includes("10") && !distinct.includes("10.5") && !distinct.includes("11.5"));
  t("remaining raw font-size literals are few (≤4 hero one-offs)", distinct.length <= 4, distinct.join(","));
  t("the eight tokens are actually used", (html.match(/font-size:var\(--fs-/g) || []).length > 300,
    String((html.match(/font-size:var\(--fs-/g) || []).length));
  // Body stays at a comfortable mobile baseline (Part 8).
  t("body token is a readable mobile size (≥13px)", /--fs-body:14\.5px/.test(root));
}

/* ══════ line-height cleanup ══════════════════════════════════════════ */

section("Body/heading line-heights use tokens");
{
  t("no 1.45 / 1.55 near-duplicate line-heights remain",
    !/line-height:1\.45/.test(html) && !/line-height:1\.55/.test(html));
  t("line-height tokens are used", (html.match(/line-height:var\(--lh-/g) || []).length > 40);
  t("the near-duplicate 640 weight is gone", !/font-weight:640/.test(html));
}

/* ══════ Part 8 — accessibility guards ════════════════════════════════ */

section("Accessibility: no ultra-light weights, uppercase keeps tracking");
{
  t("no ultra-light font-weight (<400) anywhere", !/font-weight:[123]00\b/.test(html));
  t("micro utility is uppercase WITH wide tracking", /\.type-micro\{[^}]*text-transform:uppercase[^}]*var\(--ls-wide\)|\.type-micro\{[^}]*var\(--ls-wide\)[^}]*text-transform:uppercase/.test(html));
  t("focus states untouched (still --focus-ring)", /:focus-visible\{outline:2px solid var\(--focus-ring\)/.test(html));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
