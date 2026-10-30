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
const files = ["assets/brand/athlevo-coaching-logo.png", "assets/welcome/hero-720.webp", "assets/welcome/hero-1080.webp", "assets/welcome/hero-720.jpg"];
test("logo and photo files exist", files.every(existsSync));
const png = readFileSync(files[0]);
test("the logo is a real transparent PNG (RGBA), not the white-background JPG", png.slice(1, 4).toString() === "PNG" && png[25] === 6);
test("photo files are phone-sized (each under 150 KB)", files.slice(1).every(f => statSync(f).size < 150 * 1024),
  files.slice(1).map(f => Math.round(statSync(f).size / 1024) + "KB").join(" "));

console.log("\n──── Markup ────");
test("welcome uses the Athlevo Coaching logo with an accessible name",
  /<img class="w-logo" src="assets\/brand\/athlevo-coaching-logo\.png" alt="Athlevo Coaching"/.test(welcome));
test("the old icon + 'Athlevo.' text lockup is gone from the welcome screen", !/w-lockup|w-mark|athlevo-icon-transparent/.test(welcome));
test("photo is responsive (webp 720/1080 with jpg fallback), decorative, and lazy so signed-in users never download it",
  /<picture class="w-photo" aria-hidden="true">[\s\S]*?type="image\/webp" srcset="assets\/welcome\/hero-720\.webp 720w, assets\/welcome\/hero-1080\.webp 1080w"[\s\S]*?<img src="assets\/welcome\/hero-720\.jpg" alt="" [^>]*loading="lazy"/.test(welcome));
test("a scrim sits between the photo and the copy", /<div class="w-scrim" aria-hidden="true"><\/div>/.test(welcome));
test("every sign-in control and variant element is still there",
  ["authBtnGoogle", "authBtnEmail", "authBtnApple", "wSignupLink", "wAiSignupTitle", "wAiSignupSub", "wAiSignupTrust", "wAiSignupLegal", "wCheckoutContinue", "wWelcomeBack", "wGoogleNote"]
    .every(id => welcome.includes(`id="${id}"`)));
test("Email stays the premium red primary action", /class="w-btn primary btn-premium-red" id="authBtnEmail"/.test(welcome));
test("copy is plain and names the method, no 'AI coach' marketing", /class="w-tag">Endurance coaching built on the Athlevo Method\.<\/p>/.test(welcome) && !/AI coach|24\/7/.test(welcome));

console.log("\n──── Layout and readability ────");
test("photo fills the screen, cropped to keep the runner's face (object-fit cover, top-weighted)",
  /\.w-photo img\{width:100%;height:100%;object-fit:cover;object-position:50% 10%/.test(css));
test("on phones the photo starts below a band of sky so the logo never sits on the face",
  /--w-band:min\(128px,16vh\)/.test(css) && /\.w-photo\{position:absolute;inset:var\(--w-band\) 0 0 0/.test(css) && /\.w-photo::after\{[^}]*mask-image/.test(css));
test("logo is small and top-left (not attention-grabbing), clear of the status bar and shrinks on short screens",
  /\.w-logo\{[^}]*left:22px;width:128px/.test(css) && /safe-area-inset-top/.test(css) && /@media\(max-height:640px\)\{#screen-welcome \.w-logo\{width:104px\}/.test(css));
test("copy and buttons sit on a dark scrim with white bold text (readability over brand colour)",
  /\.w-scrim\{[^}]*rgba\(14,14,16,\.93\)/.test(css) && /\.w-tag\{[^}]*font-weight:700[^}]*color:#fff/.test(css));
test("buttons respect the bottom safe area", /\.w-btns\{padding:0 26px calc\(30px \+ var\(--athlevo-safe-bottom/.test(css));
test("desktop: logo clears the floating rail toggle and the sign-in column is centered at 520px",
  /@media\(min-width:900px\)\{[\s\S]*?\.w-logo\{top:28px;left:96px;width:188px\}[\s\S]*?width:min\(100%,520px\);margin-inline:auto/.test(css));
test("existing welcome rules other screens and tests rely on are untouched",
  /\.welcome\{justify-content:space-between;padding:0!important\}/.test(html) && /#screen-welcome\.is-ai-signup \.w-top\{overflow-wrap:anywhere/.test(html));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
