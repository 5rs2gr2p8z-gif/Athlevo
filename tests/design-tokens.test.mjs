/*
 * Athlevo — Design System PR 1: token foundation, colour unification,
 * pill geometry, focus-visible, dark-mode reconciliation.
 *
 * Guards the design-token invariants directly against index.html so the
 * consistency this PR establishes can never silently drift back.
 *
 * Run: node tests/design-tokens.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");
const root = (html.match(/:root\{[\s\S]*?\}/) || [""])[0];

/* ══════ Part 1 — the token foundation exists ═════════════════════════ */

section("Token foundation is defined in :root");
{
  ["--s-1:4px", "--s-2:8px", "--s-3:12px", "--s-4:16px", "--s-5:20px", "--s-6:24px", "--s-7:32px", "--s-8:40px"]
    .forEach(tok => t("spacing " + tok, root.includes(tok)));
  t("--r-pill:999px", root.includes("--r-pill:999px"));
  ["--elev-1", "--elev-2", "--elev-3"].forEach(tok => t("elevation " + tok, new RegExp(tok + ":").test(root)));
  ["--dur-fast", "--dur-base", "--dur-slow"].forEach(tok => t("motion " + tok, new RegExp(tok + ":").test(root)));
  ["--ease-standard", "--ease-emphasized"].forEach(tok => t("easing " + tok, new RegExp(tok + ":").test(root)));
  t("--focus-ring (light)", /--focus-ring:#/.test(root));
}

/* ══════ Part 2 — colour drift is unified ═════════════════════════════ */

section("No mismatched semantic colour fallbacks or duplicate literals remain");
{
  t("no var(--good,#…) mismatched fallback", !/var\(--good,#/.test(html));
  t("no var(--good-soft,#…) fallback", !/var\(--good-soft,#/.test(html));
  t("no var(--bad,#…) fallback", !/var\(--bad,#/.test(html));
  t("no var(--warn,#…) fallback", !/var\(--warn,#/.test(html));
  t("the stray #2f9e5f green literal is gone", !/#2f9e5f/i.test(html));
  t("the stray rgba(47,158,95) green tint is gone", !/rgba\(47,\s*158,\s*95/.test(html));
  // Form-validation message colours now use tokens, not raw literals.
  t("no inline msg colour set to a raw red literal", !/msg\.style\.color = '#C0272D'/.test(html));
  t("no inline msg colour set to the stray green literal", !/msg\.style\.color = '#1a7f37'/.test(html));
  t("validation colours use semantic tokens", /msg\.style\.color = 'var\(--red\)'/.test(html) &&
    /msg\.style\.color = 'var\(--good\)'/.test(html));
}

/* ══════ Part 3 — pill geometry unified ═══════════════════════════════ */

section("Genuine pills use --r-pill; cards/modals keep their own radius");
{
  t("no border-radius:100px literal remains", !/border-radius:100px/.test(html));
  t("no border-radius:999px literal remains", !/border-radius:999px/.test(html));
  t("no border-radius:99px literal remains", !/border-radius:99px/.test(html));
  t("--r-pill is actually used for pills", (html.match(/border-radius:var\(--r-pill\)/g) || []).length > 40);
  // Excluded, on purpose: the desktop device frame and bottom-sheet modals.
  t("the desktop device frame keeps its 44px radius", /border-radius:44px/.test(html));
  t("bottom-sheet modals keep 26px top corners", /border-radius:26px 26px 0 0/.test(html));
}

/* ══════ Part 4 — one focus-visible treatment ═════════════════════════ */

section("Focus-visible uses a single --focus-ring token");
{
  const focusRules = [...html.matchAll(/:focus-visible\{outline:[^}]*\}/g)].map(m => m[0]);
  t("focus-visible rules exist", focusRules.length >= 5);
  t("every focus-visible ring uses --focus-ring",
    focusRules.every(r => /var\(--focus-ring\)/.test(r)),
    focusRules.filter(r => !/var\(--focus-ring\)/.test(r)).join(" | "));
  t("a global interactive focus-visible rule is present",
    /button:focus-visible[\s\S]{0,400}outline:2px solid var\(--focus-ring\)/.test(html));
  t("no focus-visible ring still hard-codes --red or --text",
    !/:focus-visible\{outline:2px solid var\(--(red|text)\)/.test(html));
}

/* ══════ Part 5 — dark-mode reconciliation ════════════════════════════ */

section("The two dark blocks are token-for-token identical");
{
  const explicit = (html.match(/html\[data-theme="dark"\]\{([\s\S]*?)\}/) || [])[1] || "";
  const system = (html.match(/html\[data-theme="system"\]\{([\s\S]*?)\}/) || [])[1] || "";
  const toks = block => {
    const map = {};
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].forEach(m => { map[m[1]] = m[2].trim(); });
    return map;
  };
  const A = toks(explicit), B = toks(system);
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])];
  const mismatched = keys.filter(k => A[k] !== B[k]);
  t("both dark blocks parsed with tokens", Object.keys(A).length > 10 && Object.keys(B).length > 10,
    `${Object.keys(A).length} / ${Object.keys(B).length}`);
  t("explicit-dark and system-dark palettes are identical", mismatched.length === 0,
    "diverging: " + mismatched.join(", "));
  t("both define --good-soft (the previously-missing token)", "--good-soft" in A && "--good-soft" in B);
  t("both define --warn-soft", "--warn-soft" in A && "--warn-soft" in B);
  t("both define a dark --focus-ring", /#/.test(A["--focus-ring"] || "") && /#/.test(B["--focus-ring"] || ""));
  t("both define dark elevation", "--elev-1" in A && "--elev-3" in B);
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
