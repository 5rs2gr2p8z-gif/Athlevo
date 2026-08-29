import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ui = readFileSync("./js/diagnosticUI.js", "utf8");
const index = readFileSync("./index.html", "utf8");
const analytics = readFileSync("./js/analytics.js", "utf8");
const registrySource = readFileSync("./js/analyticsRegistry.js", "utf8");

assert.match(ui, /var currentQuestion = null/);
assert.match(ui, /var q = currentQuestion;/, "submission must use the displayed question");
assert.doesNotMatch(ui, /var key = engine\.history\[engine\.history\.length - 1\]/);
assert.match(ui, /engine\.previousQuestion\(currentQuestion \? currentQuestion\.key/);
assert.match(ui, /your endurance coach/, "conversation opens with Athlevo greeting");
assert.match(ui, /diagnostic_viewed/);
assert.match(ui, /diagnostic_started/);
assert.match(ui, /ai_landing_viewed/);
assert.match(ui, /function markDiagnosticStarted/);
assert.match(ui, /function hasRecordedDiagnosticAnswers/);
assert.match(ui, /primeDiagnosticStartedFromEngine\(engine\)/);
assert.match(ui, /function trackDiagnosticAiFallback/);
assert.match(ui, /result\.usedFallback !== true/);
assert.doesNotMatch(ui, /engine\.begin\(\);[\s\S]{0,160}diagnostic_started/);
assert.match(ui, /aria-label/, "interactive elements have accessible labels");
assert.match(ui, /type=\"button\"/, "fields use native button elements");
assert.match(ui, /handleChipSelect/, "question fields are wired for interaction");
assert.match(ui, /chat-qr-chip/, "quick-reply chips rendered for field options");
assert.match(index, /AthlevoDiagnostic\.hasPending\(\)[\s\S]{0,300}AthlevoDiagnosticUI\.start/);
assert.match(ui, /if \(root\.athlevoSessionUserId\) \{[\s\S]{0,220}routeAfterAuth/,
  "authenticated visitors must not paint the /ai acquisition chat");
assert.match(ui, /if \(root\.athlevoSessionUserId\) \{[\s\S]{0,180}QRPh · Maya · GrabPay/);
assert.match(index, /sessionRestoreTimedOut/);
assert.match(index, /__athlevoSessionRestoreSettled/);

const expectedEvents = [
  "diagnostic_viewed", "diagnostic_started", "diagnostic_resumed",
  "diagnostic_question_answered", "diagnostic_insight_shown",
  "diagnostic_completed", "diagnostic_result_viewed", "product_recommended",
  "alternative_products_viewed", "product_selected", "diagnostic_signup_tapped",
  "diagnostic_import_started", "diagnostic_import_completed", "diagnostic_import_failed",
  "diagnostic_ai_fallback_used", "diagnostic_buyer_intent_detected",
  "diagnostic_pricing_asked", "diagnostic_start_recommended", "diagnostic_value_demonstrated",
  "diagnostic_payment_options_shown", "diagnostic_checkout_method_selected"
];
for (const event of expectedEvents) assert.match(registrySource, new RegExp(`${event}:`));

const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(registrySource, context);
const sanitized = context.AthlevoAnalyticsRegistry.sanitizeProps("diagnostic_completed", {
  questions_answered: 9,
  primary_limiter: "aerobic_base",
  recommended_product: "ai",
  feasibility_rating: "realistic",
  injury_reported: true,
  injury_area: "left knee",
  raw_answers: "private",
  message: "private"
});
assert.equal(sanitized.injury_reported, true);
assert.equal(sanitized.injury_area, undefined);
assert.equal(sanitized.raw_answers, undefined);
assert.equal(sanitized.message, undefined);
assert.match(analytics, /"injury_reported"/);
assert.match(analytics, /APPROVED_NAMED_KEYS = \{[^}]*injury_reported: true/);
assert.doesNotMatch(ui, /posthog\.capture/);

console.log("PASS — diagnostic UI source-of-truth, restoration, accessibility, and analytics privacy contracts");
