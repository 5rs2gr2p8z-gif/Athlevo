/* Focused regression coverage for the shared Athlevo application UI foundation. */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const coach = readFileSync("./js/coachMode.js", "utf8");
const athlete = readFileSync("./js/athleteMode.js", "utf8");
const auth = readFileSync("./js/authSupport.js", "utf8");

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}`); }
}

console.log("\n──── Semantic tokens and component geometry ────");
[
  "--athlevo-red", "--athlevo-red-dark", "--athlevo-red-soft",
  "--text-primary", "--text-secondary", "--text-muted",
  "--surface-base", "--surface-raised", "--surface-soft",
  "--border-default", "--border-strong",
  "--success", "--success-soft", "--warning", "--warning-soft",
  "--danger", "--danger-soft", "--info", "--info-soft"
].forEach(token => test(`${token} is defined`, html.includes(`${token}:`)));
test("legacy palette names map into the semantic foundation", /--success:var\(--good\)/.test(html) &&
  /--warning:var\(--warn\)/.test(html) && /--danger:var\(--bad\)/.test(html));
test("control, card, sheet, tap, and page tokens are centralized",
  /--ui-radius-card:var\(--r-md\)/.test(html) && /--ui-radius-control:var\(--r-sm\)/.test(html) &&
  /--ui-radius-sheet:26px/.test(html) && /--tap-target:44px/.test(html) && /--page-gutter:22px/.test(html));
test("one canonical card rule owns border, radius, padding, and elevation",
  (html.match(/\.card\{/g) || []).length === 1 &&
  /\.card\{[^}]*var\(--surface-soft\)[^}]*var\(--border-default\)[^}]*var\(--r-lg\)[^}]*var\(--s-5\)[^}]*var\(--elev-1\)/.test(html));

console.log("\n──── App-only interaction and accessibility contract ────");
test("shared refinements are explicitly excluded from the landing page",
  (html.match(/body:not\(\.landing-active\) \.device/g) || []).length >= 7);
test("interactive rows and app actions receive subtle tokenized press feedback",
  /:active:not\(:disabled\):not\(\[disabled\]\):not\(\[aria-disabled="true"\]\):not\(\.is-disabled\):not\(\.is-loading\)\{\s*opacity:\.92;transform:scale\(\.985\)/.test(html) &&
  /var\(--motion-press\) var\(--ease-standard\)/.test(html));
test("app controls use the shared focus ring and 44px target",
  /outline:2px solid var\(--focus-ring\)/.test(html) && /min-height:var\(--tap-target\)/.test(html));
test("inputs share control height, font, caret, placeholder, and disabled behavior",
  /min-height:var\(--control-height\);font-family:var\(--font-ui\)/.test(html) &&
  /caret-color:var\(--athlevo-red\)/.test(html) && /::placeholder\{color:var\(--text-muted\)/.test(html));
test("profile action rows are native buttons rather than clickable divs",
  !/<div class="rowlink(?: |")/.test(html) && (html.match(/<button class="rowlink/g) || []).length >= 7);
test("global reduced-motion coverage remains authoritative",
  /prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\.001ms!important[\s\S]*?transition-duration:\.001ms!important/.test(html));

console.log("\n──── Status, loading, sheets, and coach consistency ────");
test("completed, modified, and skipped states use semantic aliases",
  /\.sc-status\.done,.tcp-status\.done\)\{background:var\(--success-soft\);color:var\(--success\)/.test(html) &&
  /\.sc-status\.mod,.tcp-status\.mod\)\{background:var\(--warning-soft\);color:var\(--warning\)/.test(html) &&
  /\.sc-status\.skip,.tcp-status\.skip\)\{background:var\(--danger-soft\);color:var\(--danger\)/.test(html));
test("all app skeletons reuse one quiet shimmer token set",
  (html.match(/@keyframes skelShimmer/g) || []).length === 1 && !/@keyframes ssShimmer/.test(html) &&
  /animation:skelShimmer var\(--skeleton-duration\)/.test(html));
test("core sheets reuse backdrop, radius, depth, and motion tokens",
  (html.match(/background:var\(--backdrop\)/g) || []).length >= 4 &&
  (html.match(/var\(--ui-radius-sheet\) var\(--ui-radius-sheet\) 0 0/g) || []).length >= 5 &&
  (html.match(/animation:[^;}]+var\(--motion-sheet\)/g) || []).length >= 5);
test("coach status colors and fields consume the shared foundation",
  /\.cm-status-attention[^}]*var\(--danger\)/.test(coach) &&
  /\.cm-status-monitor[^}]*var\(--warning\)/.test(coach) &&
  /\.cm-workout-status\.completed[^}]*var\(--success\)/.test(coach) &&
  /\.cm-field input[^}]*var\(--control-height\)/.test(coach));
test("managed-athlete states no longer introduce a separate blue/amber palette",
  !/#3B82F6|#FEF3C7|#F59E0B|#92400E|#6B7280|#F3F4F6/.test(athlete) &&
  /var\(--warning-soft\)/.test(athlete) && /var\(--athlevo-red\)/.test(athlete));
test("auth handoff sheet shares the same sheet and interaction tokens",
  /var\(--ui-radius-sheet,26px\)/.test(auth) && /var\(--motion-sheet,260ms\)/.test(auth) &&
  /var\(--focus-ring,#3a6df0\)/.test(auth));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
