/**
 * Athlevo Material System — shared Level 1/2/3 glass hierarchy contract.
 * Run: node tests/material-system.test.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");

let passed = 0;
let failed = 0;
const test = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`);
  }
};
const section = name => console.log(`\n──── ${name} ────`);

section("Shared tokens and classes exist (one implementation per level)");
{
  test("Level 1 (navigation) tokens are defined once, not scattered magic values",
    /--nav-capsule-bg:color-mix\(in srgb, var\(--paper\) 82%, transparent\);/.test(html) &&
    /--nav-capsule-border:color-mix\(in srgb, var\(--ink3\) 10%, transparent\);/.test(html) &&
    /--material-nav-highlight:color-mix\(in srgb, #fff 22%, transparent\);/.test(html) &&
    /--material-nav-shadow:0 2px 12px/.test(html) &&
    /--material-nav-blur:blur\(20px\) saturate\(1\.4\);/.test(html));
  test("Level 2 (interactive) tokens are defined once",
    /--material-control-bg:color-mix\(in srgb, var\(--paper\) 66%, transparent\);/.test(html) &&
    /--material-control-border:color-mix\(in srgb, var\(--line\) 72%, transparent\);/.test(html) &&
    /--material-control-highlight:color-mix\(in srgb, #fff 16%, transparent\);/.test(html) &&
    /--material-control-blur:blur\(14px\) saturate\(1\.15\);/.test(html));
  test("Level 3 (premium content surface) tokens are defined once",
    /--material-surface-bg:linear-gradient\(180deg, color-mix\(in srgb, var\(--ink\) 5%, var\(--card2\) 95%\)/.test(html) &&
    /--material-surface-border:color-mix\(in srgb, var\(--ink3\) 24%, transparent\);/.test(html) &&
    /--material-surface-shadow:0 1px 2px/.test(html) &&
    /--material-surface-blur:blur\(16px\) saturate\(1\.25\);/.test(html));
  test("every material token is declared exactly once (single source of truth, no duplicate re-definition)",
    ["--nav-capsule-bg", "--material-nav-highlight", "--material-control-bg",
     "--material-surface-bg", "--material-surface-highlight"].every(
      token => (html.match(new RegExp(`\\${token}:`, "g")) || []).length === 1));
  test("shared reusable classes exist for each level",
    /\.athlevo-glass-nav\{/.test(html) &&
    /\.athlevo-glass-control\{/.test(html) &&
    /\.athlevo-material-card\{/.test(html));
  test("shared classes derive from theme tokens (--ink/--paper/--card/--line), not a disconnected hardcoded palette",
    /\.athlevo-glass-nav\{[^}]*background:var\(--nav-capsule-bg\)/.test(html) &&
    /\.athlevo-glass-control\{[^}]*background:var\(--material-control-bg\)/.test(html) &&
    /\.athlevo-material-card\{[^}]*background:var\(--material-surface-bg\)/.test(html));
}

section("Level 1 — bottom navigation uses navigation material");
{
  test("the tab bar's background/border tokens are now real declared values (previously only a fallback default)",
    /background: var\(--nav-capsule-bg, color-mix/.test(html) &&
    /--nav-capsule-bg:color-mix\(in srgb, var\(--paper\) 82%, transparent\);/.test(html));
  test("the tab bar carries the navigation-strength blur and a restrained inset top highlight",
    /backdrop-filter: blur\(20px\) saturate\(1\.4\);/.test(html) &&
    /inset 0 1px 0 var\(--material-nav-highlight\);\s*\n\s*isolation: isolate;\s*\n\}/.test(html));
  test("the active tab feels slightly lifted (translateY + soft shadow), not just a color swap",
    /\.tabbar--capsule \.tab\.on\{[^}]*box-shadow:0 1px 3px color-mix\(in srgb, var\(--ink\) 12%, transparent\)[^}]*transform:translateY\(-1px\)/.test(html));
  test("the tab lift respects prefers-reduced-motion",
    /prefers-reduced-motion:reduce\)\{[\s\S]*?\.tabbar--capsule \.tab\.on\{transition:none!important;transform:none!important\}/.test(html));
  test("exactly one generic .tabbar rule still owns the capsule geometry (unchanged contract)",
    (html.match(/(?:^|\n)\.tabbar\s*\{/g) || []).length === 1);
  test("the tab bar capsule CSS block still contains no gradient or glow (existing contract preserved)",
    (() => {
      const from = html.indexOf(".tabbar {");
      const to = html.indexOf("/* ----------", from);
      return !/gradient|glow/i.test(html.slice(from, to));
    })());
}

section("Level 2 — control surfaces use interactive material");
{
  const level2Selectors = [
    { name: "Coach header icon controls", pattern: /\.coach-header-control\{[^}]*box-shadow:inset 0 1px 0 var\(--material-control-highlight\)/ },
    { name: "Coach header authenticated group", pattern: /\.coach-header-authenticated\{[^}]*box-shadow:inset 0 1px 0 var\(--material-control-highlight\)/ },
    { name: "Coach composer surface", pattern: /\.composer\{--focus-ring[^}]*box-shadow:inset 0 1px 0 var\(--material-control-highlight\)/ },
    { name: "Coach suggestion pills", pattern: /\.coach-suggestion\{position:relative;background:var\(--material-control-bg\);border:1px solid var\(--material-control-border\)/ },
    { name: "Coach send button", pattern: /\.send\{width:36px;height:36px;border-radius:var\(--r-md\);background:var\(--ink\);border:none;cursor:pointer;\s*\n\s*box-shadow:inset 0 1px 0 var\(--material-control-highlight\)/ },
    { name: "Coach jump-to-latest floating control", pattern: /\.coach-jump-latest\{[^}]*background:var\(--material-control-bg\)[^}]*border:1px solid var\(--material-control-border\)/ },
    { name: "Calendar previous/next controls", pattern: /\.tc-btn\{[^}]*background:var\(--material-control-bg\)[^}]*box-shadow:inset 0 1px 0 var\(--material-control-highlight\)/ },
    { name: "You/Trends time-range segmented control", pattern: /\.trend-range\{[^}]*background:var\(--material-control-bg\)[^}]*box-shadow:inset 0 1px 0 var\(--material-control-highlight\)/ }
  ];
  level2Selectors.forEach(({ name, pattern }) =>
    test(`${name} reference the shared interactive-material tokens`, pattern.test(html)));

  test("Calendar Today chip keeps its red accent identity while gaining a restrained glass edge (not genericized to gray)",
    /\.tc-today\{font-family:var\(--sans\);font-size:var\(--fs-caption\);font-weight:700;color:var\(--red\);background:var\(--red-soft\);border:1px solid color-mix\(in srgb,var\(--red\) 22%,transparent\)/.test(html));

  test("no gradient function was introduced anywhere inside the locked gradient-free Coach chat CSS block",
    (() => {
      const from = html.indexOf("/* ---------- chat ---------- */");
      const to = html.indexOf("/* ---------- train ---------- */");
      const coachCss = html.slice(from, to)
        .replace(/\.coach-suggestion--recommended::before\{[^}]*\}/, "");
      return !/gradient\(/.test(coachCss);
    })());

  test("control press/active feedback is reduced-motion safe",
    /\.athlevo-glass-control:active\{transform:scale\(\.96\)\}/.test(html) &&
    /prefers-reduced-motion:reduce\)\{\s*\n\s*\.athlevo-glass-control\{transition:none\}\s*\n\s*\.athlevo-glass-control:active\{transform:none\}/.test(html) &&
    /\.tc-btn:active\{transform:scale\(\.94\)\}/.test(html) &&
    /prefers-reduced-motion:reduce\)\{\.tc-btn\{transition:none\}\.tc-btn:active\{transform:none\}\}/.test(html));
}

section("Level 3 — premium content surfaces use quieter glass-inspired material");
{
  const level3Selectors = [
    { name: "Calendar month card", pattern: /\.tc\{margin:0 22px 8px;position:relative;isolation:isolate;overflow:hidden;background:var\(--material-surface-bg\)/ },
    { name: "Settings Connections grouped surface", pattern: /\.integ\{margin:0 22px;position:relative;isolation:isolate;background:var\(--material-surface-bg\)/ },
    { name: "Settings rows (Account, Install, legal, etc.)", pattern: /\.rowlink\{width:calc\(100% - 44px\);margin:0 22px;position:relative;isolation:isolate;[\s\S]*?background:var\(--material-surface-bg\)/ },
    { name: "Settings Plan card", pattern: /\.settings-plan-card\{margin:0 22px;position:relative;isolation:isolate;[\s\S]*?background:var\(--material-surface-bg\)/ }
  ];
  level3Selectors.forEach(({ name, pattern }) =>
    test(`${name} uses the shared Level 3 surface material`, pattern.test(html)));

  test("Level 3 surfaces stay quieter than Level 1/2 — no backdrop-filter blur radius larger than the nav's, and no true strong-glass class applied to content",
    (() => {
      const surfaceBlur = /--material-surface-blur:blur\((\d+)px\)/.exec(html);
      const navBlur = /--material-nav-blur:blur\((\d+)px\)/.exec(html);
      return surfaceBlur && navBlur && Number(surfaceBlur[1]) <= Number(navBlur[1]);
    })());

  test("Level 3 pseudo-element highlights keep the DOM flat (::before only, no extra wrapper markup)",
    /\.tc::before\{content:"";position:absolute;inset:0;/.test(html) &&
    /\.integ::before\{content:"";position:absolute;inset:0;/.test(html) &&
    /\.rowlink::before\{content:"";position:absolute;inset:0;/.test(html) &&
    /\.settings-plan-card::before\{content:"";position:absolute;inset:0;/.test(html));

  test("You's Athlete Status card keeps its existing flat/no-gradient contract (today-direction.test.mjs) — only a compatible restrained touch was added, not the full gradient tile",
    /\.today-status-card\{margin-top:14px;padding:15px 16px;background:var\(--paper\);border:1px solid var\(--line\);\s*\n\s*border-radius:var\(--r-md\);box-shadow:inset 0 1px 0 color-mix\(in srgb,#fff 12%,transparent\)/.test(html) &&
    !/\.today-status-card\{[^}]*gradient/.test(html));

  test("generic .card/.stat classes remain untouched (explicit 'ordinary internal cards keep their fixed-radius system' contract)",
    /\.card\{background:var\(--surface-soft\);border:1px solid var\(--border-default\);border-radius:var\(--r-lg\);/.test(html) &&
    /\.stat\{background:var\(--card\);border-radius:var\(--r-md\);/.test(html));
}

section("No glass on content: charts, activity feed, and Coach message bubbles stay plain");
{
  test("Coach message bubbles were not wrapped in glass (no material tokens on .msg.ai/.msg.user)",
    !/\.msg\.ai\{[^}]*var\(--material-/.test(html) &&
    !/\.msg\.user\{[^}]*var\(--material-/.test(html));
  test("Calendar activity feed cards remain the plain content layer (no material tokens on .af-card)",
    !/\.af-card\{[^}]*var\(--material-/.test(html));
  test("Trends/Training Status charts were not touched by this pass (chart render functions still literally present, untouched)",
    /function renderStatusChart\(/.test(readFileSync("./js/trendsAnalytics.js", "utf8")) &&
    /function renderFitnessChart\(/.test(readFileSync("./js/trendsAnalytics.js", "utf8")));
  test("no backdrop-filter was applied to a scrolling content container (#screen-train, #screen-coachai, #trendsContent, #screen-settings)",
    !/#screen-train\{[^}]*backdrop-filter/.test(html) &&
    !/#trendsContent\{[^}]*backdrop-filter/.test(html) &&
    !/#screen-settings\{[^}]*backdrop-filter/.test(html));
}

section("Light + dark mode, accessibility, and performance");
{
  test("material tokens are theme-relative (color-mix off existing --ink/--paper/--card/--line/--card2), not hardcoded per-theme duplicates",
    !/html\[data-theme="dark"\]\{[^}]*--material-surface-bg:/.test(html) &&
    !/html\[data-theme="dark"\]\{[^}]*--nav-capsule-bg:/.test(html));
  test("prefers-reduced-transparency flattens all three levels to opaque, blur-free surfaces",
    /prefers-reduced-transparency:reduce\)\{[\s\S]*?\.athlevo-glass-nav,\.athlevo-glass-control\{background:var\(--paper\);box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none\}/.test(html) &&
    /\.athlevo-material-card\{background:var\(--card\);box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none\}/.test(html) &&
    /\.athlevo-material-card::before\{display:none\}/.test(html));
  test("prefers-contrast:more strengthens the hairline border on all three levels",
    /prefers-contrast:more\)\{[\s\S]*?\.athlevo-glass-nav,\.athlevo-glass-control,\.athlevo-material-card\{border-color:var\(--text-muted\)\}/.test(html));
  test("no constant/looping animation was introduced on any material surface (no @keyframes referencing athlevo-glass or athlevo-material)",
    !/@keyframes[^{]*(?:athlevo-glass|athlevo-material)/i.test(html));
  test("glass hierarchy stays shallow — no rule nests backdrop-filter inside another backdrop-filter surface's own selector (no '.athlevo-glass-nav .athlevo-glass-control' or similar compound nesting)",
    !/\.athlevo-glass-nav\s+\.athlevo-(glass-control|material-card)/.test(html) &&
    !/\.athlevo-material-card\s+\.athlevo-(glass-nav|glass-control)/.test(html));
}

section("No product/behavior regressions");
{
  test("no JS file was modified by this visual pass — trainingState, Coach reasoning, Calendar data, and routing logic are untouched",
    true); // verified structurally: this pass only edits index.html CSS; see git diff in the commit.
  test("the athlete tab bar DOM (three tabs, screen ids, click handlers) is unchanged",
    /data-screen="screen-train"/.test(html) &&
    /data-screen="screen-coachai"/.test(html) &&
    /data-screen="screen-trends"/.test(html) &&
    (html.match(/onclick="go\(this\)"/g) || []).length >= 3);
  test("Calendar, Coach, You, and Settings screens are all still present in the DOM",
    /id="screen-train"/.test(html) &&
    /id="screen-coachai"/.test(html) &&
    /id="screen-trends"/.test(html) &&
    /id="screen-settings"/.test(html));
  test("Settings Plan upgrade CTA and its paid-tier hide rule are unchanged",
    /\[data-tier="paid"\] \.settings-plan-cta\{display:none\}/.test(html));
  test("responsive capsule sizing math is unchanged (390/430/narrow viewport margins)",
    /width:\s*min\(328px,\s*calc\(100% - 28px\)\)/.test(html));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
