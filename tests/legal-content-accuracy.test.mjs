/**
 * Athlevo — Privacy Policy / Terms factual-accuracy tests.
 *
 * These assert the legal copy matches what the codebase actually does
 * today (App Store readiness audit, Section E / Phase 0 items 1-2), not
 * what is planned. They are intentionally text-level checks against the
 * markdown source, mirroring how the app renders it (js/legal.js), rather
 * than a full markdown-rendering test.
 *
 * Run: node tests/legal-content-accuracy.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const privacy = readFileSync("./legal/privacy-policy.md", "utf8");
const terms = readFileSync("./legal/terms-of-service.md", "utf8");
const featureRegistry = readFileSync("./js/features.js", "utf8");
const serverFeatureRegistry = readFileSync("./lib/server/features.js", "utf8");
const index = readFileSync("./index.html", "utf8");

let pass = 0, fail = 0;
const t = (n, c, e) => { c ? (pass++, console.log("PASS — " + n))
  : (fail++, console.log("FAIL — " + n + (e ? `  [${e}]` : ""))); };
const section = s => console.log(`\n──── ${s} ────`);

/* ═══════════ 1. Apple Health / HealthKit must not be described as live ═══════════ */

section("Apple Health / HealthKit accuracy");
{
  t("feature registry marks apple_health as unavailable (client)",
    /apple_health:[^}]*available:\s*false/.test(featureRegistry));
  t("feature registry marks apple_health as unavailable (server)",
    /apple_health:[^}]*available:\s*false/.test(serverFeatureRegistry));

  // The policy must list Apple Health only under "future" framing, never
  // as a "Current integration".
  const currentBlock = privacy.match(/Current integration:\n\n([\s\S]*?)\n\nFuture integrations/);
  assert.ok(currentBlock, "Privacy policy must have a 'Current integration' block");
  t("Apple Health is NOT listed as a current integration",
    !/apple health/i.test(currentBlock[1]));

  const futureBlock = privacy.match(/Future integrations may include:\n\n([\s\S]*?)\n\n/);
  assert.ok(futureBlock, "Privacy policy must have a 'Future integrations' block");
  t("Apple Health IS listed only as a future integration",
    /apple health/i.test(futureBlock[1]));

  t("policy explicitly states HealthKit is not currently integrated / no HealthKit data collected today",
    /apple health[\s\S]{0,300}not currently integrated/i.test(privacy) &&
    /does not\s+request, read, or store\s+healthkit data today/i.test(privacy));
}

/* ═══════════ 2. PayMongo must be described as live, not "future" ═══════════ */

section("PayMongo / Whop accuracy");
{
  t("live PayMongo checkout endpoint exists in the codebase",
    (() => { try { readFileSync("./api/paymongo/checkout.js", "utf8"); return true; } catch { return false; } })());
  t("live PayMongo webhook endpoint exists in the codebase",
    (() => { try { readFileSync("./api/paymongo/webhook.js", "utf8"); return true; } catch { return false; } })());

  t("privacy policy no longer calls PayMongo a 'future' payment processor",
    !/future payment processors?\s+such as\s+paymongo/i.test(privacy) &&
    !/future[^\n]*paymongo/i.test(privacy));
  t("privacy policy lists PayMongo as a current payment processor",
    /paymongo \(payment processing\)/i.test(privacy));
  t("privacy policy also names Whop as a current payment processor",
    /\bwhop\b/i.test(privacy));

  t("terms of service no longer calls PayMongo a 'future' payment processor",
    !/future payment processing/i.test(terms));
  t("terms of service reflects that Whop and PayMongo currently process payments",
    /whop and paymongo/i.test(terms));
}

/* ═══════════ 3. AI consent in-product copy must not contradict the policy ═══════════ */

section("AI-processing consent consistency (Section 4 vs. in-product modal)");
{
  const aiSection = privacy.match(/## 4\. AI Services\n\n([\s\S]*?)\n\n## 5\./);
  assert.ok(aiSection, "Privacy policy must have an AI Services section");
  t("policy names OpenAI as the AI provider",
    /openai/i.test(aiSection[1]));

  const modalMatch = index.match(/id="aiConsentModal"[\s\S]{0,1200}/);
  assert.ok(modalMatch, "in-product AI consent modal must exist");
  t("in-product consent modal also names OpenAI (no contradiction with the policy)",
    /openai/i.test(modalMatch[0]));
  t("in-product consent modal frames AI processing the same way as the policy (third-party AI services)",
    /third-party ai services/i.test(modalMatch[0]));

  t("Apple Sign-In is not described as a live authentication provider in the policy",
    !/apple sign.?in/i.test(privacy) && !/sign in with apple/i.test(privacy));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
