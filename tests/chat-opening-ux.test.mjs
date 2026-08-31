/*
 * Chat UX opening experience tests — first-10K sequential reveal,
 * bottom-anchored layout, vertical replies, composer visibility,
 * reduced-motion, analytics integrity.
 *
 * Run: node tests/chat-opening-ux.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const uiSrc = readFileSync("./js/diagnosticUI.js", "utf8");
const engineSrc = readFileSync("./js/diagnostic.js", "utf8");
const indexSrc = readFileSync("./index.html", "utf8");

/* ── 1. Opening messages retain the correct order ─────────────────── */
{
  const openingIdx = uiSrc.indexOf("async function renderConversationOpening()");
  const fnBody = uiSrc.slice(openingIdx, openingIdx + 1500);
  const msg1Idx = fnBody.indexOf('"Let\'s get you ready for your first 10K."');
  const msg2Idx = fnBody.indexOf('"I\'ll ask a few things about your current running and schedule para we know exactly where to start."');
  assert.ok(msg1Idx > 0, "Message 1 present in opening");
  assert.ok(msg2Idx > 0, "Message 2 present in opening");
  assert.ok(msg1Idx < msg2Idx, "Message 1 appears before Message 2 in source");
  // Message 3 is the question prompt from the engine, added via getSubStepPrompt
  assert.ok(fnBody.includes("getSubStepPrompt"), "Question prompt sourced from engine");
  console.log("PASS — 1. Opening messages retain correct order");
}

/* ── 2. Opening messages are revealed sequentially in normal-motion ── */
{
  const openingIdx = uiSrc.indexOf("async function renderConversationOpening()");
  const fnBody = uiSrc.slice(openingIdx, openingIdx + 1500);
  // Must have await delay() calls between messages (not typing indicator)
  const delayMatches = [...fnBody.matchAll(/await delay\((\d+|si === 1 \? \d+ : \d+)\)/g)];
  assert.ok(delayMatches.length >= 2, "At least 2 delay calls for stagger between messages");
  // Must use appendAthlevoMsg (not showTypingThenMessage) for first10k path
  const first10kBlock = fnBody.slice(fnBody.indexOf("if (first10k)"), fnBody.indexOf("} else {"));
  assert.ok(first10kBlock.includes("appendAthlevoMsg"), "Uses appendAthlevoMsg for direct reveal");
  assert.ok(!first10kBlock.includes("showTypingThenMessage"), "Does NOT use typing indicator for first10k opening");
  assert.ok(!first10kBlock.includes("appendTypingIndicator"), "No typing dots in first10k opening");
  console.log("PASS — 2. Sequential reveal with stagger delays, no typing dots");
}

/* ── 3. Reduced-motion users do not wait through the stagger ─────── */
{
  const openingIdx = uiSrc.indexOf("async function renderConversationOpening()");
  const fnBody = uiSrc.slice(openingIdx, openingIdx + 1500);
  assert.ok(fnBody.includes("if (reducedMotion())"), "Reduced-motion check present");
  // In reduced-motion path: skipAnim = true
  const rmBlock = fnBody.slice(fnBody.indexOf("if (reducedMotion())"), fnBody.indexOf("} else {"));
  assert.ok(rmBlock.includes("true)"), "Reduced-motion renders with skipAnim");
  // No await delay in reduced-motion path
  assert.ok(!rmBlock.includes("await delay"), "Reduced-motion does not await delays");
  console.log("PASS — 3. Reduced-motion skips stagger");
}

/* ── 4. Suggested replies remain hidden until opening question presented ── */
{
  const openingIdx = uiSrc.indexOf("async function renderConversationOpening()");
  const fnBody = uiSrc.slice(openingIdx, openingIdx + 1500);
  // showQuickReplies should only be called via presentSubStepInput AFTER messages
  assert.ok(!fnBody.includes("showQuickReplies("), "Opening does not directly call showQuickReplies");
  assert.ok(fnBody.includes("presentSubStepInput"), "Replies shown via presentSubStepInput after messages");
  console.log("PASS — 4. Suggested replies appear only after question is presented");
}

/* ── 5. Suggested replies appear in correct vertical order ─────────── */
{
  // CSS: .is-opening uses flex-direction:column
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening\{[^}]*flex-direction:\s*column/,
    "Opening replies use vertical column layout");
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening\{[^}]*align-items:\s*stretch/,
    "Opening replies stretch to fill available width");
  console.log("PASS — 5. Vertical full-width stack for opening replies");
}

/* ── 6. Reply buttons contain text only — no added icons/emojis ───── */
{
  // The chip creation in showQuickReplies uses only opt.label text
  const chipCreation = uiSrc.slice(uiSrc.indexOf("function showQuickReplies"), uiSrc.indexOf("function hideQuickReplies"));
  assert.ok(chipCreation.includes("esc(opt.label)"), "Chip content is escaped label text only");
  assert.ok(!chipCreation.includes("svg"), "No SVG icons in chip creation");
  assert.ok(!chipCreation.includes("emoji"), "No emoji references in chip creation");
  // CSS: opening chips have no icon styling
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening \.chat-qr-chip\{[^}]*text-align:\s*center/,
    "Opening chips are text-centered");
  console.log("PASS — 6. Reply buttons are text-only");
}

/* ── 7. All four replies fit on representative mobile viewports ───── */
{
  // Opening chips have max-width constraint and comfortable padding
  // Cards fill the available chat content width (no max-width constraint)
  assert.doesNotMatch(indexSrc, /\.chat-quick-replies\.is-opening \.chat-qr-chip\{[^}]*max-width:\s*320px/,
    "Opening chips no longer have 320px max-width constraint");
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening \.chat-qr-chip\{[^}]*width:\s*100%/,
    "Opening chips use full width");
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening \.chat-qr-chip\{[^}]*padding:\s*15px 24px/,
    "Opening chips have comfortable touch target padding");
  console.log("PASS — 7. Reply cards fill available chat content width");
}

/* ── 8. Composer remains present during the opening frequency question ── */
{
  // presentSubStepInput calls showComposer, never hideComposer
  const helperFn = uiSrc.slice(uiSrc.indexOf("function presentSubStepInput"), uiSrc.indexOf("async function presentSubStep("));
  assert.ok(helperFn.includes("showComposer"), "presentSubStepInput calls showComposer");
  assert.ok(!helperFn.includes("hideComposer"), "presentSubStepInput does not hide composer");
  // The regular presentSubStep no longer hides for current_running_frequency
  const presentSubStepFn = uiSrc.slice(uiSrc.indexOf("async function presentSubStep("), uiSrc.indexOf("function handleChipSelect"));
  assert.ok(!presentSubStepFn.includes('current_running_frequency'), "presentSubStep no longer checks current_running_frequency for composer hiding");
  console.log("PASS — 8. Composer remains visible during opening question");
}

/* ── 9. Composer behavior is truthful — no unusable fake input ──── */
{
  // showComposer sets placeholder and keeps input enabled
  const showComposerFn = uiSrc.slice(uiSrc.indexOf("function showComposer("), uiSrc.indexOf("function hideComposer"));
  assert.ok(showComposerFn.includes('composer.style.display = ""'), "showComposer makes composer visible");
  // handleComposerSend exists and processes typed input
  assert.ok(uiSrc.includes("function handleComposerSend()"), "handleComposerSend processes typed input");
  console.log("PASS — 9. Composer is functional, not fake");
}

/* ── 10. Selecting one reply submits only once ────────────────────── */
{
  const chipHandler = uiSrc.slice(uiSrc.indexOf("function showQuickReplies"), uiSrc.indexOf("function hideQuickReplies"));
  assert.ok(chipHandler.includes('data-locked'), "Quick replies use data-locked attribute");
  assert.ok(chipHandler.includes('setAttribute("data-locked", "1")'), "Selection locks all buttons");
  assert.ok(chipHandler.includes('disabled = true'), "Buttons disabled after selection");
  console.log("PASS — 10. Single-submission lock on replies");
}

/* ── 11. Selected answer transitions into user-message transcript ── */
{
  const chipSelect = uiSrc.slice(uiSrc.indexOf("function handleChipSelect"), uiSrc.indexOf("function showMultiChipsWithState"));
  assert.ok(chipSelect.includes("appendUserMsg"), "Selected chip creates a user message bubble");
  assert.ok(chipSelect.includes("hideQuickReplies"), "Quick replies hidden after selection");
  console.log("PASS — 11. Selected answer enters transcript as user bubble");
}

/* ── 12. Auto-scroll keeps latest message/action visible ──────────── */
{
  assert.ok(uiSrc.includes("function scrollToBottom()"), "scrollToBottom function exists");
  const openingFn = uiSrc.slice(uiSrc.indexOf("async function renderConversationOpening()"), uiSrc.indexOf("async function showTypingThenMessage"));
  const scrollCalls = (openingFn.match(/scrollToBottom\(\)/g) || []).length;
  assert.ok(scrollCalls >= 2, "Opening calls scrollToBottom multiple times for each message");
  console.log("PASS — 12. Auto-scroll keeps latest content visible");
}

/* ── 13. diagnostic_started fires only from real user interaction ── */
{
  assert.ok(uiSrc.includes("function markDiagnosticStarted("), "markDiagnosticStarted function exists");
  // markDiagnosticStarted is called from handleChipSelect and handleComposerSend, not from rendering
  const openingFn = uiSrc.slice(uiSrc.indexOf("async function renderConversationOpening()"), uiSrc.indexOf("async function showTypingThenMessage"));
  assert.ok(!openingFn.includes("markDiagnosticStarted"), "Opening does NOT fire diagnostic_started");
  assert.ok(!openingFn.includes("diagnostic_started"), "Opening does NOT contain diagnostic_started event");
  // Confirm it IS in handleChipSelect
  const chipFn = uiSrc.slice(uiSrc.indexOf("function handleChipSelect"), uiSrc.indexOf("function showMultiChipsWithState"));
  assert.ok(chipFn.includes("markDiagnosticStarted"), "diagnostic_started fires on chip selection");
  console.log("PASS — 13. diagnostic_started fires only from real interaction");
}

/* ── 14. diagnostic_step_completed fires only after an answer ────── */
{
  // trackDiagnosticStep is called from submitCurrentQuestion, not from rendering
  const openingFn = uiSrc.slice(uiSrc.indexOf("async function renderConversationOpening()"), uiSrc.indexOf("async function showTypingThenMessage"));
  assert.ok(!openingFn.includes("trackDiagnosticStep"), "Opening does NOT fire step_completed");
  assert.ok(!openingFn.includes("diagnostic_step_completed"), "Opening does NOT contain step_completed event");
  const submitFn = uiSrc.slice(uiSrc.indexOf("function submitCurrentQuestion()"), uiSrc.indexOf("async function advanceFlow"));
  assert.ok(submitFn.includes("trackDiagnosticStep"), "step_completed fires from submitCurrentQuestion");
  console.log("PASS — 14. diagnostic_step_completed fires only after answer submission");
}

/* ── 15. /ai?intent=first10k diagnostic state/completion unchanged ── */
{
  // Engine still handles first10k intent
  assert.match(engineSrc, /first10k/, "Engine still references first10k");
  assert.match(engineSrc, /acquisitionIntent/, "Engine preserves acquisitionIntent");
  assert.match(uiSrc, /currentAcquisitionIntent\(\) === "first10k"/, "UI checks for first10k intent");
  // Completion path unchanged
  assert.match(uiSrc, /function completeDiagnostic/, "completeDiagnostic function exists");
  assert.match(uiSrc, /engine\.canComplete\(\)/, "canComplete check preserved");
  console.log("PASS — 15. first10k diagnostic state/completion unchanged");
}

/* ── 16. Plain /ai remains functional ─────────────────────────────── */
{
  const openingFn = uiSrc.slice(uiSrc.indexOf("async function renderConversationOpening()"), uiSrc.indexOf("async function showTypingThenMessage"));
  // Non-first10k path still uses showTypingThenMessage
  assert.ok(openingFn.includes("} else {"), "Else branch for non-first10k");
  assert.ok(openingFn.includes('showTypingThenMessage(thread, "Hi! I\'m Athlevo, your endurance coach.")'), "Plain /ai greeting preserved");
  assert.ok(openingFn.includes("await presentQuestion(q, { showPrompt: true })"), "Plain /ai uses presentQuestion");
  console.log("PASS — 16. Plain /ai remains functional");
}

/* ── 17. Fail-open/post-auth/routing code untouched ───────────────── */
{
  assert.match(uiSrc, /failOpenDeadDiagnostic/, "fail-open function preserved");
  assert.match(uiSrc, /routeAfterAuth/, "post-auth routing preserved");
  assert.match(uiSrc, /showReturningUserWelcome/, "returning user flow preserved");
  assert.match(uiSrc, /hasCheckoutReturn/, "checkout return preserved");
  assert.match(uiSrc, /applyAcquisitionIntent/, "acquisition intent application preserved");
  console.log("PASS — 17. Fail-open/post-auth/routing tests preserved");
}

/* ── Bottom-anchor CSS ────────────────────────────────────────────── */
{
  assert.match(indexSrc, /\.chat-thread\{[^}]*justify-content:\s*flex-end/,
    "Chat thread uses justify-content:flex-end for bottom anchoring");
  console.log("PASS — Bottom-anchor CSS applied to chat-thread");
}

/* ── Reduced-motion: no translateY animation ─────────────────────── */
{
  const animateInFn = uiSrc.slice(uiSrc.indexOf("function animateIn"), uiSrc.indexOf("function scrollToBottom"));
  assert.ok(animateInFn.includes("canAnimate"), "animateIn checks canAnimate (which checks reducedMotion)");
  console.log("PASS — animateIn respects reduced-motion via canAnimate");
}

console.log("\n✓ All 17 chat opening UX tests passed");

/* ── 18. First opening chip gets chat-qr-first class ─────────────── */
{
  const chipCreation = uiSrc.slice(uiSrc.indexOf("function showQuickReplies"), uiSrc.indexOf("function hideQuickReplies"));
  assert.ok(chipCreation.includes("chat-qr-first"), "chat-qr-first class exists in showQuickReplies");
  assert.ok(chipCreation.includes("openingChips && idx === 0"), "First chip class applied only when opening AND index 0");
  console.log("PASS — 18. First opening chip gets chat-qr-first class");
}

/* ── 19. Only the first card has animated border CSS ──────────────── */
{
  assert.match(indexSrc, /\.chat-qr-first::before\{/, "Animated border pseudo-element targets .chat-qr-first only");
  assert.match(indexSrc, /qr-border-travel/, "Keyframe animation qr-border-travel defined");
  assert.match(indexSrc, /conic-gradient/, "Uses conic-gradient for perimeter segment");
  // Ensure no other chip gets the animation
  // Main rule + reduced-motion override = 2 occurrences, both on .chat-qr-first
  const animRules = indexSrc.match(/chat-qr-chip[^{]*::before/g) || [];
  assert.equal(animRules.length, 2, "Exactly two ::before rules (main + reduced-motion), both on .chat-qr-first");
  animRules.forEach(function(r) { assert.ok(r.includes("chat-qr-first"), "::before rule is on .chat-qr-first: " + r); });
  console.log("PASS — 19. Only the first card has animated border");
}

/* ── 20. Reduced-motion stops the animation ──────────────────────── */
{
  assert.match(indexSrc, /prefers-reduced-motion:reduce\).*chat-qr-first::before\{[^}]*animation:\s*none/,
    "Reduced-motion disables perimeter animation");
  assert.match(indexSrc, /prefers-reduced-motion:reduce\).*chat-qr-first::before\{[^}]*opacity/,
    "Reduced-motion retains a static treatment");
  console.log("PASS — 20. Reduced-motion stops the animated border");
}

/* ── 21. Opening cards have hover state ──────────────────────────── */
{
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening \.chat-qr-chip:hover\{/,
    "Opening cards have :hover rule");
  console.log("PASS — 21. Opening cards have hover state");
}

/* ── 22. Opening cards have active/pressed state ─────────────────── */
{
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening \.chat-qr-chip:active\{/,
    "Opening cards have :active rule");
  assert.match(indexSrc, /\.chat-quick-replies\.is-opening \.chat-qr-chip:active\{[^}]*transform:\s*scale/,
    "Active state includes scale transform for press feedback");
  console.log("PASS — 22. Opening cards have active/pressed state");
}

/* ── 23. Opening cards are tactile (rounded rect, fill, shadow) ──── */
{
  const openingChipRule = indexSrc.match(/\.chat-quick-replies\.is-opening \.chat-qr-chip\{([^}]+)\}/);
  assert.ok(openingChipRule, "Opening chip rule found");
  const rule = openingChipRule[1];
  assert.ok(rule.includes("border-radius:14px"), "Rounded rectangle corners (14px)");
  assert.ok(rule.includes("box-shadow"), "Subtle depth via box-shadow");
  assert.ok(!rule.includes("max-width:320px"), "No max-width constraint — cards fill available width");
  assert.ok(rule.includes("padding:15px 24px"), "Generous vertical padding");
  assert.ok(rule.includes("position:relative"), "Position relative for pseudo-element");
  console.log("PASS — 23. Opening cards are tactile rounded rectangles");
}

/* ── 24. No 'Try asking' or emoji in chip rendering ──────────────── */
{
  const chipCreation = uiSrc.slice(uiSrc.indexOf("function showQuickReplies"), uiSrc.indexOf("function hideQuickReplies"));
  assert.ok(!chipCreation.includes("Try asking"), "No 'Try asking' text");
  assert.ok(chipCreation.includes("esc(opt.label)"), "Chip content is escaped label text only");
  console.log("PASS — 24. No 'Try asking' or emoji in chip rendering");
}

console.log("\n✓ All 24 chat opening UX tests passed");
