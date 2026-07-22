/*
 * Athlevo — Design System PR 5: final visual consistency pass.
 *
 * Guards the canonical button system, verifies temporary build/debug markers
 * were removed, and confirms compatibility hooks that runtime/tests rely on
 * are preserved.
 *
 * Run: node tests/consistency-pass.test.mjs
 */

import { readFileSync } from "node:fs";

let p = 0, f = 0;
const t = (n, c, e) => { c ? (p++, console.log("PASS — " + n))
  : (f++, console.log("FAIL — " + n + (e ? "  [" + e + "]" : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

const html = readFileSync("./index.html", "utf8");

/* ══════ Part 2 — one canonical button hierarchy ═════════════════════ */

section("Canonical button system exists, composed from tokens");
{
  [".btn{", ".btn--primary{", ".btn--secondary{", ".btn--tertiary{",
   ".btn--danger{", ".btn--compact{", ".btn--icon{", ".btn-group{"]
    .forEach(sel => t(sel + "} defined", html.includes(sel)));
  const base = html.slice(html.indexOf(".btn{"), html.indexOf(".btn{") + 480);
  t("min-height is a comfortable thumb target (≥44px)", /min-height:44px/.test(base));
  t("padding + radius + type use tokens", /padding:0 var\(--s-4\)/.test(base) &&
    /border-radius:var\(--r-pill\)/.test(base) && /font-size:var\(--fs-body-sm\)/.test(base));
  t("transition uses motion tokens", /var\(--dur-fast\) var\(--ease-standard\)/.test(base));
  t("has disabled + loading + active states",
    /\.btn\[disabled\],\.btn:disabled,\.btn\.is-disabled\{/.test(html) &&
    /\.btn\.is-loading\{/.test(html) && /\.btn:active\{/.test(html));
}

/* ══════ Part 6/8 — temporary build/debug markers removed ════════════ */

section("Temporary build/debug markers are gone");
{
  t("no visible 'Workout graph build' marker in the component",
    !/Workout graph build/.test(readFileSync("./js/workoutStructure.js", "utf8")));
  t("no data-wsv-version debug attribute is rendered",
    !/data-wsv-version/.test(readFileSync("./js/workoutStructure.js", "utf8")));
  t("no .wsv__build CSS remains", !/wsv__build/.test(html));
  const buildLogs = ["workoutStructure", "adaptivePlan", "syncStatus", "coachTimeline"]
    .map(fn => readFileSync(`./js/${fn}.js`, "utf8"))
    .filter(s => /console\.log\("\[athlevo\][^"]*build:/.test(s));
  t("no temporary [athlevo] build console logs remain", buildLogs.length === 0);
}

/* ══════ Part 8 — compatibility hooks preserved ══════════════════════ */

section("Runtime/test compatibility hooks are preserved");
{
  t("connect trace-version hook still present (used by tests + prod check)",
    /__ATHLEVO_CONNECT_TRACE_VERSION/.test(readFileSync("./js/onboardingConnect.js", "utf8")));
  t("legacy hidden trainingDataRow hook kept (brain.js writes to it)",
    /id="trainingDataRow"/.test(html));
}

/* ══════ token adoption stays intact (no regression) ═════════════════ */

section("Design-system tokens remain adopted (no regression)");
{
  t("typography tokens still used", (html.match(/font-size:var\(--fs-/g) || []).length > 300);
  t("spacing tokens still used", (html.match(/(padding|gap):var\(--s-/g) || []).length > 60);
  t("elevation tokens still used", (html.match(/box-shadow:var\(--elev-/g) || []).length >= 8);
  t("motion tokens still used", (html.match(/var\(--dur-|var\(--ease-/g) || []).length > 80);
  t("no raw pill/card radius literals remain",
    !/border-radius:\s*100px/.test(html) && !/border-radius:(12|14|16|18|20|22|24)px[;}]/.test(html));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
