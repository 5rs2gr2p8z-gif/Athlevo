/*
 * Athlevo — premium "Continue with Email" button on the signup/welcome screen.
 * Pure presentation: depth by default, conic ring + bloom on hover/focus/press,
 * reduced-motion fallback, touch-safe, no layout impact, Google button untouched,
 * and none of the signup logic changed.
 *
 * Run: node tests/signup-email-cta-polish.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

// Only the polish block (so unrelated CSS can't satisfy the assertions).
const start = html.indexOf("/* ── Premium Email CTA");
const end = html.indexOf("@media (prefers-reduced-motion:reduce){\n  #authBtnEmail,");
assert.ok(start > 0 && end > start, "polish block present");
const reducedEnd = html.indexOf("\n}\n", end) + 3;
const block = html.slice(start, reducedEnd);
const rule = sel => {
  const i = block.indexOf("\n" + sel + "{") + 1;   // rule that STARTS a line (not the grouped selector)
  assert.ok(i > 0, `rule ${sel}`);
  return block.slice(i, block.indexOf("}", i));
};

test("button is still red with a white label (no readability regression)", () => {
  const base = rule("#authBtnEmail");
  assert.match(base, /var\(--red\)/);
  assert.match(base, /color:#fff/);
  assert.match(base, /text-shadow/);
});

test("default state has depth without needing hover (touch-safe)", () => {
  const base = rule("#authBtnEmail");
  assert.match(base, /linear-gradient\(180deg/);
  assert.match(base, /box-shadow:inset 0 1px 0 rgba\(255,255,255/);
  assert.match(base, /inset 0 -1px 0 rgba\(0,0,0/);
  assert.match(base, /0 8px 18px -8px/);
});

test("ring + bloom are absolutely positioned pseudo-elements (no layout shift)", () => {
  assert.match(block, /#authBtnEmail::before,#authBtnEmail::after\{content:"";position:absolute;border-radius:inherit;pointer-events:none;opacity:0/);
  assert.match(rule("#authBtnEmail::before"), /inset:-2px;padding:2px/);
  assert.match(rule("#authBtnEmail::before"), /conic-gradient\(from var\(--qr-angle\)/);
  assert.match(rule("#authBtnEmail::before"), /mask-composite:exclude/);
  assert.match(rule("#authBtnEmail::after"), /filter:blur\(9px\)/);
  assert.match(rule("#authBtnEmail::after"), /inset:-3px/);
  // no width/height/margin/padding changes on the button itself between states
  const stateRules = block.match(/#authBtnEmail:(hover|focus-visible|active)[^{]*\{[^}]*\}/g) || [];
  for (const r of stateRules) assert.doesNotMatch(r, /(?:^|[;{])\s*(?:width|height|margin|padding|border-width)\s*:/);
});

test("rotation is slow, reuses the registered --qr-angle property, and only runs when shown", () => {
  assert.match(block, /@keyframes authEmailRing\{0%\{--qr-angle:0deg\}100%\{--qr-angle:360deg\}\}/);
  assert.match(block, /animation:authEmailRing 7s linear infinite;animation-play-state:paused/);
  assert.match(html, /@property --qr-angle\{syntax:"<angle>"/);
});

test("hover glow is limited to fine hover pointers; focus and press cover touch/keyboard", () => {
  assert.match(block, /@media \(hover:hover\) and \(pointer:fine\)\{[\s\S]*#authBtnEmail:hover:not\(\[disabled\]\)::before\{opacity:\.95/);
  assert.match(block, /#authBtnEmail:focus-visible::before\{opacity:\.95/);
  assert.match(block, /#authBtnEmail:focus-visible\{outline:2px solid var\(--focus-ring\)/);
  assert.match(block, /#authBtnEmail:active:not\(\[disabled\]\)::before\{opacity:\.95/);
  // the hover block must not contain the :active rules, and :active must come after it (wins on desktop)
  assert.ok(block.indexOf("#authBtnEmail:active:not([disabled]){") > block.indexOf("@media (hover:hover)"));
});

test("pressed state is full-opacity (overrides the app-wide pressed fade) and sinks", () => {
  const r = rule("#authBtnEmail:active:not([disabled])");
  assert.match(r, /opacity:1/);
  assert.match(r, /transform:scale\(\.97\)/);
  assert.match(r, /inset 0 2px 5px rgba\(0,0,0/);
});

test("reduced motion: no animation, no transitions, no lift, static ring angle", () => {
  const reduced = block.slice(block.indexOf("@media (prefers-reduced-motion:reduce)"));
  assert.match(reduced, /transform:none/);
  assert.match(reduced, /animation:none;transition:none;--qr-angle:210deg/);
});

test("disabled button gets no glow or lift", () => {
  assert.doesNotMatch(block, /#authBtnEmail:hover(?!:not\(\[disabled\]\))/);
});

test("bloom paints behind the button but inside the button stack (.w-btns isolates)", () => {
  assert.match(block, /\.w-btns\{isolation:isolate\}/);
  assert.match(rule("#authBtnEmail::after"), /z-index:-1/);
});

test("Google button styling and every other .w-btn rule are untouched", () => {
  assert.match(html, /\.w-btn\.google\{background:var\(--paper\);border:1px solid var\(--line\)\}/);
  assert.doesNotMatch(block, /authBtnGoogle|\.w-btn\.google/);
  assert.match(html, /\.w-btn:active\{transform:scale\(\.97\)\}/);
});

test("button markup, copy, handler and position are unchanged", () => {
  assert.match(html, /<button class="w-btn primary" id="authBtnEmail" onclick="openLogin\(true\)">[\s\S]{0,400}Continue with Email\s*<\/button>/);
  const g = html.indexOf('id="authBtnGoogle"'), n = html.indexOf('id="wGoogleNote"'), e = html.indexOf('id="authBtnEmail"');
  assert.ok(g < n && n < e, "Google, note, Email order in source");
});

test("signup logic is untouched: CTA ordering, analytics and Meta handling still present", () => {
  assert.match(html, /function syncSignupCtaOrder\(signupMode\)/);
  assert.match(html, /wrap\.insertBefore\(email, google\)/);
  assert.match(html, /AthlevoRuntime\.isMetaInAppBrowser/);
  assert.match(html, /email_signup_clicked/);
});

console.log(`\n${passed} passed, 0 failed`);
