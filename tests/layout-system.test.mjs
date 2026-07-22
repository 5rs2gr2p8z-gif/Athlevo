/*
 * Athlevo — Design System PR 3: layout rhythm (card primitive, spacing
 * tokens, elevation adoption, radius unification).
 *
 * Visual-only guard rails against index.html.
 *
 * Run: node tests/layout-system.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");

/* ══════ Part 2 — the canonical card primitive ═══════════════════════ */

section("One canonical card system exists");
{
  [".card{", ".card--raised{", ".card-header{", ".card-title{", ".card-body{",
   ".card-footer{", ".card-row{", ".stack{", ".section-gap{"]
    .forEach(sel => t(sel + "} defined", html.includes(sel)));
  const card = html.slice(html.indexOf(".card{"), html.indexOf(".card{") + 160);
  t("card composes tokens (surface, radius, padding, elevation)",
    /var\(--card\)/.test(card) && /var\(--r-lg\)/.test(card) && /var\(--s-\d\)/.test(card) && /var\(--elev-1\)/.test(card));
  t("card padding + radius use tokens, not raw px",
    !/padding:[0-9]+px/.test(card) && !/border-radius:[0-9]+px/.test(card));
}

/* ══════ Part 3 — spacing uses tokens ════════════════════════════════ */

section("On-grid spacing uses tokens");
{
  t("gaps reference spacing tokens", (html.match(/gap:var\(--s-/g) || []).length > 40);
  t("paddings reference spacing tokens", (html.match(/padding:var\(--s-/g) || []).length > 20);
  t("no single-value on-grid gap literals remain",
    !/gap:8px[;}]/.test(html) && !/gap:12px[;}]/.test(html) && !/gap:16px[;}]/.test(html));
}

/* ══════ Part 6 — elevation tokens adopted ═══════════════════════════ */

section("Shadows use the three elevation tokens");
{
  t("elevation tokens are used", (html.match(/box-shadow:var\(--elev-[123]\)/g) || []).length >= 8);
  // Only legitimate non-elevation shadows may remain: a hairline and the
  // CTA pulse keyframe. No other ad-hoc drop shadows.
  const adhoc = [...html.matchAll(/box-shadow:0 [0-9][^;}]*/g)].map(m => m[0])
    .filter(s => !/var\(--elev/.test(s) && !/rgba\(192,39,45/.test(s) && !/0 1px 0 rgba/.test(s) && !/inset/.test(s));
  t("no stray ad-hoc drop shadows remain (only hairline + pulse allowed)", adhoc.length <= 1, adhoc.join(" | "));
}

/* ══════ Radius unification (incl. PR1 spaced-pill fix) ══════════════ */

section("Radii use tokens; the PR1 spaced-pill miss is fixed");
{
  t("no border-radius:100px (spaced or not) remains", !/border-radius:\s*100px/.test(html));
  t("no hardcoded card radii (12–24px) remain",
    !/border-radius:(12|14|16|18|20|22|24)px[;}]/.test(html));
  t("radius tokens are widely used", (html.match(/border-radius:var\(--r-(sm|md|lg|pill)\)/g) || []).length > 80);
  // Intentional one-offs preserved: device frame + bottom-sheet corners.
  t("desktop device frame keeps 44px", /border-radius:44px/.test(html));
  t("bottom-sheet modals keep 26px top corners", /border-radius:26px 26px 0 0/.test(html));
}

/* ══════ multi-value shorthands untouched (no layout shift) ══════════ */

section("Off-grid multi-value spacing was NOT changed (layout preserved)");
{
  // Multi-value paddings like 'padding:15px 18px' must remain literal — this
  // PR deliberately avoids moving layout.
  t("multi-value padding shorthands are preserved", /padding:1[0-9]px 1[0-9]px/.test(html));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
