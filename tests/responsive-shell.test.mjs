/**
 * Responsive desktop/tablet app-shell checks.
 * Verifies the CSS/markup/JS added to replace the "phone card centered on
 * desktop" presentation with a real sidebar + workspace shell, without
 * touching mobile (<768px) presentation, auth/thread state, or Coach logic.
 * Run: node tests/responsive-shell.test.mjs
 */

import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL — ${name}`);
  }
}

/* ---------- layout-state controller ---------- */
test("a single layout-state script classifies mobile/tablet/desktop at the documented breakpoints",
  /w >= 1100 \? "layout-desktop" : \(w >= 768 \? "layout-tablet" : "layout-mobile"\)/.test(html));
test("layout state is applied on load and re-applied on resize (no separate desktop DOM tree built)",
  /window\.addEventListener\("resize", apply/.test(html) &&
  /document\.addEventListener\("DOMContentLoaded", apply\)/.test(html));

/* ---------- mobile must not regress ---------- */
test(".device phone-card rule (max-width/rounded corners) is untouched for mobile (<768px, no media query)",
  /\.device\{\s*max-width:430px;margin:0 auto;background:var\(--paper\);/.test(html));
test("mobile keeps the floating capsule tabbar markup",
  /<nav class="tabbar tabbar--capsule" id="tabbar"/.test(html));
test("tabbar is only force-hidden inside tablet/desktop layout classes, never unconditionally",
  /body\.layout-tablet #tabbar,\s*body\.layout-desktop #tabbar\{display:none!important\}/.test(html) &&
  !/^#tabbar\{display:none!important\}/m.test(html));
test("mobile hamburger side panel markup (slide-in overlay) still exists",
  /id="coachSidePanelOverlay"/.test(html) && /id="coachSidePanel"/.test(html));

/* ---------- tablet/desktop shell ---------- */
test("tablet (>=768px) and desktop (>=1100px) breakpoints both drop the fixed phone-card max-width",
  /@media\(min-width:768px\)\{[\s\S]*?body\.layout-tablet \.device,\s*body\.layout-desktop \.device\{\s*max-width:none;width:100%/.test(html) &&
  /@media\(min-width:1100px\)\{/.test(html));
test("the existing Coach side panel is promoted to a fixed nav rail on tablet/desktop, reusing the same DOM node (no clone)",
  /body\.layout-tablet \.coach-side-panel,\s*body\.layout-desktop \.coach-side-panel\{\s*position:fixed!important/.test(html));
test("desktop/tablet rail nav (Calendar/Coach/You/Settings) reuses the canonical go(btn) and openSettings() functions",
  /coach-rail-nav"[\s\S]*?data-screen="screen-train" onclick="go\(this\)"/.test(html) &&
  /data-screen="screen-coachai" onclick="go\(this\)"/.test(html) &&
  /data-screen="screen-trends" onclick="go\(this\)"/.test(html) &&
  /coach-rail-nav"[\s\S]*?onclick="openSettings\(\)"/.test(html));
test("rail nav is hidden by default and only shown at >=768px (tablet/desktop), not on mobile",
  /\.coach-rail-nav\{display:none;/.test(html) &&
  /body\.layout-tablet \.coach-rail-nav,\s*body\.layout-desktop \.coach-rail-nav\{display:grid\}/.test(html));
test("selectAppTab (the one canonical tab-selection function used by go()) also syncs the rail nav's active state",
  /function selectAppTab\(tab, animate\)\{[\s\S]*?coach-rail-nav \.coach-menu-action\[data-screen\]/.test(html));

/* ---------- Coach conversation column ---------- */
test("Coach thread (#chatlog), composer, and empty state get a readable centered max-width column on tablet/desktop",
  /body\.layout-tablet #screen-coachai #chatlog,\s*body\.layout-desktop #screen-coachai #chatlog,[\s\S]*?max-width:760px;margin-left:auto!important;margin-right:auto!important/.test(html));
test("desktop (>=1100px) widens the readable column further without a hardcoded device-specific pixel width",
  /@media\(min-width:1100px\)\{[\s\S]*?max-width:860px/.test(html));
test("no logo/icon markup was added next to the Coach thinking/loading indicator",
  !/coach-rail-nav[\s\S]{0,400}coach-thinking/i.test(html));

/* ---------- thread history reuse (no second model) ---------- */
test("renderCoachHeaderAuthState (the canonical auth-state renderer) triggers the real thread loader on tablet/desktop only",
  /function renderCoachHeaderAuthState[\s\S]*?document\.body && !document\.body\.classList\.contains\("layout-mobile"\)[\s\S]*?window\.renderCoachHistoryList\(\)/.test(html));
test("no second/duplicate thread-list renderer was introduced (renderCoachHistoryList still defined exactly once, in js/coach.js)",
  (readFileSync("./js/coach.js", "utf8").match(/function renderCoachHistoryList/g) || []).length === 1 &&
  !/function renderCoachHistoryList/.test(html));
test("closeCoachMenu keeps the rail visually open (aria-hidden=false) on tablet/desktop instead of hiding it",
  /var isFixedRail = !document\.body\.classList\.contains\("layout-mobile"\);/.test(html) &&
  /root\.setAttribute\("aria-hidden", isFixedRail \? "false" : "true"\);/.test(html));

/* ---------- anonymous desktop ---------- */
test("the signed-in-only side-panel sections (New chat, Chats list, gated Settings) still gate on data-coach-auth, so anonymous desktop never renders private thread history",
  /data-coach-auth="signed-in" hidden>\s*<p class="coach-side-panel-label">Coach<\/p>/.test(html) &&
  /class="coach-side-panel-section coach-side-panel-chats" data-coach-auth="signed-in" hidden/.test(html));
test("the always-visible rail nav itself carries no data-coach-auth gate (Calendar/Coach/You/Settings entries are auth-agnostic, matching spec)",
  /<div class="coach-side-panel-section coach-rail-nav" aria-label="Primary navigation">/.test(html));

/* ---------- Calendar / You / Settings responsive polish ---------- */
test("Calendar (screen-train), You (screen-trends), and Settings (screen-settings) get wider centered padding on tablet/desktop, without touching their internal markup/logic",
  /body\.layout-tablet #screen-train,\s*body\.layout-desktop #screen-train,\s*body\.layout-tablet #screen-trends,\s*body\.layout-desktop #screen-trends,\s*body\.layout-tablet #screen-settings,\s*body\.layout-desktop #screen-settings\{/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
