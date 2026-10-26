/*
 * Athlevo — shared premium red CTA system (replaces the one-off signup Email polish).
 *
 * One <style id="premiumRedButtons"> block, placed after every other stylesheet, styles the
 * app's primary affirmative red buttons: depth by default (touch-safe), conic ring + bloom on
 * fine-pointer hover / keyboard focus / press, a static fallback for reduced motion, and no
 * layout impact. Destructive actions, chips, icon buttons and neutral/Google buttons are out.
 *
 * Run: node tests/premium-red-button.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

const open = html.indexOf('<style id="premiumRedButtons">');
assert.ok(open > 0, "shared style block present");
const close = html.indexOf("</style>", open);
const rawBlock = html.slice(open, close);
const block = rawBlock.replace(/\/\*[\s\S]*?\*\//g, "");

// The :is() group, as written once at the top of the base rule.
const baseStart = block.indexOf("\n:is(") + 1;
const group = block.slice(baseStart + 4, block.indexOf("){", baseStart));
// Must mirror the exclusions of the app-wide "tactile press contract" (specificity 0,6,0) so the
// premium pressed state out-ranks its opacity:.92 / scale(.985).
const PRESS = ':active:not(:disabled):not([disabled]):not([aria-disabled="true"]):not(.is-disabled):not(.is-loading)';
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const members = group.split(",").map(s => s.trim()).filter(Boolean);

const INCLUDED = [
  ".btn-premium-red",                 // signup/welcome "Continue with Email" carries the class
  ".auth-box > div > button",         // login modal: Log In, Create Account, Send reset link, Update password
  ".ob2-continue.ready", ".ob2-continue.done",
  ".diag-cta-primary", ".chat-cta-btn",
  ".diagnostic-paywall-start", ".pricing-tier-cta-primary",
  ".think-cta button", ".checkin-btn", ".trends-preview-cta button", ".ag-cta-btn",
  ".trial-info-cta", ".performance-payment-continue", ".performance-upgrade-primary", ".today-pro-btn"
];
const EXCLUDED = [
  ".btn--danger", ".fuel-btn--danger", ".fuel-btn--danger-ghost",       // destructive
  ".chat-qr-done", ".chat-qr-pay-primary", ".chat-qr-chip",             // suggested-reply chips (own glow)
  ".chat-composer-send", ".am-human-coach-avatar",                       // icon / avatar
  ".coach-new-chat-action--confirm",                                     // confirm dialog action
  ".w-btn.google", ".w-btn.apple", ".diagnostic-paywall-primary", ".diagnostic-paywall-local",
  ".btn--primary", ".fuel-btn--primary", ".auth-close"                  // neutral / dark / close
];

test("the shared group lists exactly the audited primary CTAs", () => {
  assert.deepEqual(members, INCLUDED);
});

test("destructive, chip, icon, neutral and Google buttons are NOT in the system", () => {
  for (const sel of EXCLUDED) {
    assert.ok(!block.includes(sel + ",") && !block.includes(sel + "{") && !block.includes(sel + ":") && !block.includes(sel + ")"),
      `${sel} must not be styled by the premium block`);
  }
});

test("block comes after every other stylesheet so it wins ties with per-button rules", () => {
  const lastOther = Math.max(...[...html.matchAll(/<\/style>/g)].map(m => m.index).filter(i => i < open));
  assert.ok(lastOther > 0 && lastOther < open);
  const after = html.slice(close).match(/<style[\s>]/g);
  assert.equal(after, null, "no stylesheet follows the shared block");
});

test("no one-off Email button CSS remains; the button uses the shared class", () => {
  assert.ok(!/#authBtnEmail\s*[{,:]/.test(html), "no #authBtnEmail rules");
  assert.match(html, /<button class="w-btn primary btn-premium-red" id="authBtnEmail" onclick="openLogin\(true\)">[\s\S]{0,400}Continue with Email\s*<\/button>/);
});

test("default state: red, white label, raised gradient + inner highlight + soft shadow (touch-safe)", () => {
  const base = block.slice(block.indexOf("){\n  position:relative"), block.indexOf(":is(" + group + ")::before,"));
  assert.match(base, /background-color:var\(--red\)/);
  assert.match(base, /linear-gradient\(180deg,color-mix\(in srgb,var\(--red\) calc\(100% - var\(--prb-lift\)\),#fff\) 0%/);
  assert.match(base, /color:#fff/);
  assert.match(base, /inset 0 1px 0 rgba\(255,255,255,\.26\)/);
  assert.match(base, /inset 0 -1px 0 rgba\(0,0,0,\.16\)/);
  assert.match(base, /0 8px 18px -8px/);
});

test("dark mode lowers the highlight so white-on-red stays readable", () => {
  assert.match(block, /:root\{--prb-lift:8%\}/);
  assert.match(block, /html\[data-theme="dark"\]\{--prb-lift:2%\}/);
  assert.match(block, /prefers-color-scheme:dark\)\{html:not\(\[data-theme="light"\]\)\{--prb-lift:2%\}\}/);
});

test("ring + bloom are absolutely positioned pseudo-elements; ring reuses --qr-angle", () => {
  assert.match(block, /::before,:is\([^)]*\)::after\{content:"";position:absolute;border-radius:inherit;pointer-events:none;opacity:0/);
  assert.match(block, /::before\{inset:-2px;padding:2px;\s*background:conic-gradient\(from var\(--qr-angle\)/);
  assert.match(block, /mask-composite:exclude/);
  assert.match(block, /::after\{inset:-3px;z-index:-1;filter:blur\(9px\)/);
  assert.match(block, /@keyframes prbRing\{0%\{--qr-angle:0deg\}100%\{--qr-angle:360deg\}\}/);
  assert.match(block, /animation:prbRing 7s linear infinite;animation-play-state:paused/);
  assert.match(html, /@property --qr-angle\{syntax:"<angle>"/);
  assert.match(block, /isolation:isolate/);
});

test("hover glow only on fine hover pointers; focus-visible and press cover keyboard/touch", () => {
  assert.match(block, /@media \(hover:hover\) and \(pointer:fine\)\{[\s\S]*:hover:not\(:disabled\)::before\{opacity:\.95/);
  assert.match(block, /:focus-visible\{outline:2px solid var\(--focus-ring\);outline-offset:3px\}/);
  assert.match(block, /:focus-visible::before\{opacity:\.95/);
  assert.ok(block.includes(PRESS + "::before{opacity:.95"));
  assert.ok(block.lastIndexOf(PRESS + "{opacity:1;transform:scale(.97)") > block.indexOf("@media (hover:hover)"),
    "pressed rule comes after the hover block");
});

test("pressed state is full opacity (beats the app-wide pressed fade) and sinks", () => {
  assert.ok(block.includes(PRESS + "{opacity:1;transform:scale(.97);box-shadow:inset 0 2px 5px"));
});

test("pressed rule out-ranks the global press contract (>= its 5 :not() exclusions)", () => {
  const global = html.match(/\):active((?::not\([^)]*\)){5})\{\s*opacity:\.92;transform:scale\(\.985\)/);
  assert.ok(global, "global press contract still present");
  assert.ok(PRESS.includes(global[1]), "premium press repeats every exclusion of the global rule");
});

test("glow never clips: visible reach (inset + 2×blur) fits inside the side padding of the CTA containers", () => {
  const m = block.match(/::after\{inset:-(\d+)px;z-index:-1;filter:blur\((\d+)px\)/);
  const reach = Number(m[1]) + 2 * Number(m[2]);          // ≈2σ: the glow is <5% beyond this
  const sidePad = (re) => { const x = html.match(re); assert.ok(x, `container rule found: ${re}`); return Number(x[1]); };
  const containers = {
    "welcome (.w-btns)":        sidePad(/\.w-btns\{padding:0 (\d+)px \d+px;/),
    "login modal (.auth-box)":  sidePad(/\.auth-box \{ position:relative;[^}]*?padding:\d+px (\d+)px;/),
    "onboarding (.ob2-foot)":   sidePad(/\.ob2-foot\{flex-shrink:0;padding:\d+px (\d+)px /)
  };
  for (const [name, pad] of Object.entries(containers)) {
    assert.ok(pad > reach, `${name}: side padding ${pad}px must exceed glow reach ${reach}px`);
  }
});

test("reduced motion: no lift, no animation or transition, static ring angle", () => {
  const r = block.slice(block.indexOf("@media (prefers-reduced-motion:reduce)"));
  assert.match(r, /transform:none/);
  assert.match(r, /animation:none;transition:none;--qr-angle:210deg/);
});

test("disabled buttons get no lift/glow (every hover/press rule excludes :disabled)", () => {
  const stateRules = (block.match(/\)(?:::?[a-z-]+)*:(?:hover|active)[^{]*\{/g) || []).filter(r => !r.includes(":not(:disabled)"));
  assert.deepEqual(stateRules, []);
});

test("block never changes size, spacing, display or position of the buttons (no layout jump)", () => {
  // The ring's padding:2px sits on an absolutely positioned ::before (mask technique) — it cannot
  // affect the button box, so it is the single allowed occurrence.
  assert.equal((block.match(/padding:2px/g) || []).length, 1);
  const decls = [...block.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]).join(";").replace("padding:2px;", "");
  assert.doesNotMatch(decls, /(?:^|;)\s*(?:width|height|min-height|max-height|margin|padding|display|top|left|right|bottom|border-width|font-size|line-height|letter-spacing)\s*:/);
  assert.equal((block.match(/position:relative/g) || []).length, 1);
});

test("per-button base rules are untouched (copy, size, spacing still defined by their own CSS)", () => {
  assert.match(html, /\.chat-cta-btn\{width:100%;font-family:var\(--sans\);font-size:var\(--fs-h3\);font-weight:700;letter-spacing:\.01em;padding:var\(--s-4\);border-radius:12px;border:none;background:var\(--red\)/);
  assert.match(html, /\.today-pro-btn\{width:100%;min-height:48px;border:1px solid var\(--red\)/);
  assert.match(html, /\.btn--danger\{background:var\(--red\);color:#fff\}/);
  assert.match(html, /\.fuel-btn--danger\{background:var\(--red\);border-color:var\(--red\);color:var\(--paper\)\}/);
  assert.match(html, /\.w-btn\.google\{background:var\(--paper\);border:1px solid var\(--line\)\}/);
});

test("login modal handlers and copy are unchanged", () => {
  assert.match(html, /<button id="liBtn" onclick="doLogin\(\)">Log In<\/button>/);
  assert.match(html, /<button id="suBtn" onclick="doSignup\(\)" disabled>Create Account<\/button>/);
  assert.match(html, /<button id="fpBtn" onclick="doForgotPassword\(\)">Send reset link<\/button>/);
  assert.match(html, /<button id="rpBtn" onclick="doResetPassword\(\)" disabled>Update password<\/button>/);
});

test("signup CTA order logic, Meta handling and analytics hooks still present", () => {
  assert.match(html, /function syncSignupCtaOrder\(signupMode\)/);
  assert.match(html, /wrap\.insertBefore\(email, google\)/);
  assert.match(html, /AthlevoRuntime\.isMetaInAppBrowser/);
  assert.match(html, /email_signup_clicked/);
});

console.log(`\n${passed} passed, 0 failed`);
