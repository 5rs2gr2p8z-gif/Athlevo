/**
 * Phase 1 contract for Athlevo tactile feedback. This intentionally covers
 * press/hover CSS only; screen, sheet, routing, and feature behavior stay in
 * their dedicated suites.
 * Run: node tests/fluid-interactions-phase1.test.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const coach = readFileSync("./js/coachMode.js", "utf8");
const readiness = readFileSync("./js/readiness.js", "utf8");

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

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function hoverOutsideFinePointer(css) {
  let unguarded = css;
  const media = /@media\s*\(hover:hover\)\s*and\s*\(pointer:fine\)\s*\{/g;
  const ranges = [];
  for (const match of css.matchAll(media)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBrace(css, open);
    if (close >= 0) ranges.push([match.index, close + 1]);
  }
  for (const [start, end] of ranges.reverse()) {
    unguarded = unguarded.slice(0, start) + unguarded.slice(end);
  }
  return /:hover/.test(unguarded);
}

const styleCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
  .map(match => match[1])
  .join("\n");
const pressStart = html.indexOf("Canonical tactile press contract");
const pressContract = html.slice(pressStart, html.indexOf("</style>", pressStart));

console.log("\n──── Tokens and canonical press rule ────");
test("semantic press, fast, and base durations extend the existing token set",
  /--motion-press:var\(--dur-fast\)/.test(html) &&
  /--motion-fast:180ms/.test(html) &&
  /--motion-base:var\(--dur-base\)/.test(html));
test("one canonical enabled-state rule owns opacity and control scale",
  (html.match(/opacity:\.92;transform:scale\(\.985\)/g) || []).length === 1 &&
  /:active:not\(:disabled\):not\(\[disabled\]\):not\(\[aria-disabled="true"\]\):not\(\.is-disabled\):not\(\.is-loading\)/.test(pressContract));
test("press transitions animate compositor-safe properties",
  /transition:opacity var\(--motion-press\)[\s\S]*?transform var\(--motion-press\)/.test(pressContract) &&
  !/transition:[^}]*\b(?:width|height|margin|padding|top|left|right|bottom)\b/.test(pressContract));
test("large rows and icon controls use restrained scale variants",
  /\.rowlink,[\s\S]*?transform:scale\(\.99\)/.test(pressContract) &&
  /\.btn--icon,[\s\S]*?transform:scale\(\.97\)/.test(pressContract));

console.log("\n──── Coverage and state safety ────");
[
  "button", "[role=\"tab\"]", ".rowlink", ".edu-card", ".workout",
  ".tcp-card.clickable", ".tcp-actrow", ".cm-open-row", ".cm-global-athlete",
  ".cm-msg-item", ".cm-workout-row", ".cm-day-row[data-workout-id]"
].forEach(target => test(`canonical selector covers ${target}`, pressContract.includes(target)));
test("readiness, Build Plan, payment, Invite, Send Invite, and Send Message remain native buttons",
  /<button class="readiness-btn/.test(readiness) &&
  /<button type="button" class="today-primary-btn"[^>]*[\s\S]*?>Build My Plan<\/button>/.test(html) &&
  /<button class="performance-payment-continue"/.test(html) &&
  /<button type="button" class="cm-invite-trigger"[^>]*>Invite Athlete<\/button>/.test(coach) &&
  /<button class="primary" id="cmInviteSend" type="submit">Send Invite<\/button>/.test(coach) &&
  /class="cm-athlete-message"/.test(coach));
test("disabled/loading controls cannot enter the press transform",
  pressContract.includes(":not(:disabled):not([disabled]):not([aria-disabled=\"true\"]):not(.is-disabled):not(.is-loading)") &&
  /\.btn\.is-loading\{opacity:\.7;pointer-events:none\}/.test(html) &&
  /\.send\.is-sending\{opacity:\.55;pointer-events:none\}/.test(html));
test("focus-visible and the 44px target tokens remain intact",
  /outline:2px solid var\(--focus-ring\)/.test(html) &&
  /--tap-target:44px/.test(html) && /--control-height:44px/.test(html) &&
  /\.tab\{[^}]*min-height:var\(--tap-target\)/.test(html) &&
  /\.btn\{[^}]*min-height:var\(--control-height\)/.test(html));

console.log("\n──── Pointer capability and reduced motion ────");
test("every static hover rule is guarded for a fine hover pointer",
  !hoverOutsideFinePointer(styleCss));
test("coach hover rules use the same fine-pointer guard",
  !/:hover/.test(coach.replace(/@media\(hover:hover\) and \(pointer:fine\)\{[^\"]*:hover[^\"]*\}/g, "")));
test("reduced motion removes press transforms but keeps acknowledgement",
  /@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?:active:not\(:disabled\)[\s\S]*?opacity:\.94;transform:none/.test(pressContract));

console.log("\n──── Phase boundary ────");
test("top-level screen transition contract remains present and unchanged in shape",
  /function transitionTopLevelScreen\(screenId\)\{/.test(html) &&
  /athlevoScreenTransitionToken/.test(html) &&
  /tab-leaving/.test(html) && /tab-entering-active/.test(html));
test("Phase 1 adds no pointer event loop or drag machinery",
  !/pointer(?:down|move|up)|setPointerCapture|releasePointerCapture/.test(pressContract));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
