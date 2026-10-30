/**
 * Welcome / sign-in screen: Athlevo Coaching logo over a full-bleed photo.
 * Run: node tests/welcome-hero.test.mjs
 */
import { readFileSync, statSync, existsSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
let passed = 0, failed = 0;
function test(name, condition, detail = "") {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.log(`FAIL — ${name}${detail ? `  [${detail}]` : ""}`); }
}
const welcome = html.slice(html.indexOf('<section class="screen welcome" id="screen-welcome">'), html.indexOf('<section class="screen" id="screen-auth-setup"'));
const css = html.slice(html.indexOf("welcome: full-bleed photo hero"), html.indexOf("/* Post-auth transition"));

console.log("\n──── Assets ────");
const photos = [1, 2, 3, 4].flatMap(i => [`assets/welcome/hero-${i}-720.webp`, `assets/welcome/hero-${i}-1080.webp`, `assets/welcome/hero-${i}-720.jpg`]);
const files = ["assets/brand/athlevo-wordmark-white.png", ...photos];
test("wordmark and all four photos (3 files each) exist", files.every(existsSync) && photos.length === 12);
const png = readFileSync(files[0]);
test("the wordmark is a real transparent PNG (RGBA), not a white-background image", png.slice(1, 4).toString() === "PNG" && png[25] === 6);
test("photo files are phone-sized (each under 150 KB)", photos.every(f => statSync(f).size < 150 * 1024),
  photos.map(f => Math.round(statSync(f).size / 1024) + "KB").join(" "));

console.log("\n──── Markup ────");
test("the white Athlevo wordmark sits inside the copy block, directly above the tagline, with an accessible name",
  /<div class="w-top">\s*<img class="w-wordmark" src="assets\/brand\/athlevo-wordmark-white\.png" alt="Athlevo"[^>]*>\s*<p class="w-tag">/.test(welcome));
test("the old top-left logo is gone", !/w-logo|athlevo-coaching-logo/.test(welcome) && !/\.w-logo/.test(css));
test("the old icon + 'Athlevo.' text lockup is gone from the welcome screen", !/w-lockup|w-mark|athlevo-icon-transparent/.test(welcome));
test("four slides, each responsive (webp 720/1080 with jpg fallback), decorative, and lazy so signed-in users never download them",
  (welcome.match(/<picture class="w-slide"/g) || []).length === 4 &&
  [1, 2, 3, 4].every(i => welcome.includes(`style="--i:${i - 1}"><source type="image/webp" srcset="assets/welcome/hero-${i}-720.webp 720w, assets/welcome/hero-${i}-1080.webp 1080w"`) &&
    new RegExp(`<img src="assets/welcome/hero-${i}-720\\.jpg" alt="" [^>]*loading="lazy"`).test(welcome)) &&
  /<div class="w-photo" aria-hidden="true">/.test(welcome));
test("a scrim sits between the photo and the copy", /<div class="w-scrim" aria-hidden="true"><\/div>/.test(welcome));
test("every sign-in control and variant element is still there",
  ["authBtnGoogle", "authBtnEmail", "authBtnApple", "wSignupLink", "wAiSignupTitle", "wAiSignupSub", "wAiSignupTrust", "wAiSignupLegal", "wCheckoutContinue", "wWelcomeBack", "wGoogleNote"]
    .every(id => welcome.includes(`id="${id}"`)));
test("Email stays the premium red primary action", /class="w-btn primary btn-premium-red" id="authBtnEmail"/.test(welcome));
test("copy is plain and names the method, no 'AI coach' marketing", /class="w-tag">Endurance coaching built on the Athlevo Method\.<\/p>/.test(welcome) && !/AI coach|24\/7/.test(welcome));

console.log("\n──── Layout and readability ────");
test("photos fill the screen with a per-slide focal point (object-fit cover)",
  /\.w-slide img\{width:100%;height:100%;object-fit:cover;object-position:var\(--pos,50% 10%\)/.test(css) &&
  /\.w-slide:nth-child\(2\)\{--pos:50% 38%\}/.test(css));
test("the photo is full-bleed on every screen size: no band above it, no pale fade",
  /\.w-photo\{position:absolute;inset:0;/.test(css) && !/--w-band/.test(css) && !/\.w-slide::before/.test(css) && !/--fade/.test(css));
test("the wordmark is centered, modest in size, and shrinks on short screens",
  /\.w-wordmark\{display:block;width:min\(224px,60%\);height:auto;margin:0 auto 16px\}/.test(css) && /@media\(max-height:640px\)\{#screen-welcome \.w-wordmark\{width:min\(172px,50%\)/.test(css));
test("the copy block is centered like the TrainingPeaks sign-in", /\.w-top,#screen-welcome\.is-ai-signup \.w-top\{padding:0 26px 22px;text-align:center\}/.test(css));
test("copy and buttons sit on a dark scrim with white bold text (readability over brand colour)",
  /\.w-scrim\{[^}]*rgba\(14,14,16,\.93\)/.test(css) && /\.w-tag\{[^}]*font-weight:700[^}]*color:#fff/.test(css));
test("buttons respect the bottom safe area", /\.w-btns\{padding:0 26px calc\(30px \+ var\(--athlevo-safe-bottom/.test(css));
test("desktop: a larger wordmark and the sign-in column centered at 520px",
  /@media\(min-width:900px\)\{[\s\S]*?\.w-wordmark\{width:240px;margin-bottom:20px\}[\s\S]*?width:min\(100%,520px\);margin-inline:auto/.test(css));

console.log("\n──── Slideshow ────");
test("4 photos, 3 seconds each: one 12s loop, each slide delayed by 3s",
  /\.w-slide\{[^}]*animation:wSlide 12s linear infinite both;animation-delay:calc\(var\(--i\) \* 3s\)/.test(css) && [0, 1, 2, 3].every(i => welcome.includes(`style="--i:${i}"`)));
test("soft crossfade: fade in 0-7%, hold to 25% (3s), fade out to 32% while the next fades in",
  /@keyframes wSlide\{0%\{opacity:0\}7%\{opacity:1\}25%\{opacity:1\}32%\{opacity:0\}100%\{opacity:0\}\}/.test(css));
test("reduced motion shows only the first photo (global rule stops animations; first slide is visible by default)",
  /\.w-slide:first-child\{opacity:1\}/.test(css) && /@media\(prefers-reduced-motion:reduce\)\{\*\{animation:none!important/.test(html));
test("compositor-friendly: the keyframes animate opacity only",
  (() => { const kf = (css.match(/@keyframes wSlide\{(.*?)\}\}/) || [])[1] || ""; return kf.includes("opacity") && !/transform|left|top|width|height|filter/.test(kf); })());
test("existing welcome rules other screens and tests rely on are untouched",
  /\.welcome\{justify-content:space-between;padding:0!important\}/.test(html) && /#screen-welcome\.is-ai-signup \.w-top\{overflow-wrap:anywhere/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
