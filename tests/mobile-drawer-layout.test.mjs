/*
 * Athlevo — mobile Coach drawer layout.
 *
 * Regression guard for the Android report "Sign out overlaps the last chat
 * card". Root cause: .coach-side-panel-nav was a grid with min-height:0 inside
 * a fixed-height column, so it shrank below its content and the overflow was
 * painted over the pinned account footer. The drawer is now a three-part
 * column (header / scrolling middle / footer) and only the middle shrinks,
 * clipping and scrolling its own content.
 *
 * (Rendered at 320x568, 360x640, 390x844 and 412x915, light + dark, 0/1/5/12
 * chats, with and without safe-area insets, during release QA.)
 *
 * Run: node tests/mobile-drawer-layout.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

// Base (non-media-query) rule for a selector, first occurrence at line start.
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>:]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(html);
  assert.ok(match, `rule not found: ${selector}`);
  return match[1].replace(/\s+/g, " ");
}

test("panel is a fixed-height column that does not itself scroll", () => {
  const panel = rule(".coach-side-panel");
  assert.match(panel, /display:flex;flex-direction:column/);
  assert.match(panel, /overflow:hidden/);
  assert.doesNotMatch(panel, /overflow-y:auto/);
  assert.match(panel, /max-height:100dvh/);
});

test("panel bottom padding respects the safe-area inset", () => {
  assert.match(rule(".coach-side-panel"), /padding:calc\(12px \+ var\(--athlevo-safe-top\)\) 16px calc\(16px \+ var\(--athlevo-safe-bottom\)\)/);
});

test("header and account footer never shrink; footer is pinned to the bottom", () => {
  assert.match(rule(".coach-side-panel-header"), /flex:none/);
  const footer = rule(".coach-side-panel-footer");
  assert.match(footer, /flex:none/);
  assert.match(footer, /margin-top:auto/);
});

test("the middle region is the only flexible area and scrolls instead of spilling", () => {
  const nav = rule(".coach-side-panel-nav");
  assert.match(nav, /display:flex;flex-direction:column/);
  assert.match(nav, /flex:1 1 auto/);
  assert.match(nav, /min-height:0/);
  assert.match(nav, /overflow-y:auto/);
  assert.match(rule(".coach-side-panel-nav>*"), /flex:0 0 auto/);
});

test("chat list scrolls independently and keeps a readable floor once it has chats", () => {
  const list = rule(".coach-side-panel-chat-list");
  assert.match(list, /overflow-y:auto/);
  assert.match(list, /min-height:0/);
  assert.match(list, /max-height:38vh/);
  assert.match(html, /\.coach-side-panel-chats:has\(\.coach-history-item\)\{flex-shrink:1;min-height:calc\(2rem \+ 4\.5rem\);grid-template-rows:auto minmax\(4\.5rem,1fr\)\}/);
  assert.match(html, /\.coach-side-panel-chats:has\(\.coach-history-item:nth-child\(2\)\)\{min-height:calc\(2rem \+ 7\.5rem\);grid-template-rows:auto minmax\(7\.5rem,1fr\)\}/);
});

test("fix is viewport-driven: no device-specific heights or margins on the drawer", () => {
  const start = html.indexOf(".coach-side-panel-overlay{\n  position:absolute;inset:0;z-index:1300");
  const end = html.indexOf(".coach-history-item{", start);
  assert.ok(start > 0 && end > start, "base drawer rules located");
  const css = html.slice(start, end);
  assert.doesNotMatch(css, /@media\s*\([^)]*max-height/);
  assert.doesNotMatch(css, /\b(?:margin-bottom|padding-bottom|bottom|height):\s*\d{3,}px/);
});

test("markup: Sign out lives in the footer, outside the scrolling nav", () => {
  const aside = html.slice(html.indexOf('<aside class="coach-side-panel"'), html.indexOf("</aside>", html.indexOf('<aside class="coach-side-panel"')));
  const navStart = aside.indexOf('<nav class="coach-side-panel-nav"');
  const navEnd = aside.indexOf("</nav>");
  const footerStart = aside.indexOf('<div class="coach-side-panel-footer"');
  const signOut = aside.indexOf("runCoachMenuAction('sign-out')");
  assert.ok(navStart > 0 && navEnd > navStart && footerStart > navEnd, "footer follows nav");
  assert.ok(signOut > footerStart, "Sign out is inside the footer");
});

console.log(`\n${passed} tests passed`);
