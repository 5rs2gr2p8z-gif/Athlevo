/*
 * Historical founding-beta rows must not bypass the freemium model.
 * Run: node tests/founding-beta.test.mjs
 */

import { readFileSync } from "node:fs";
import {
  ACCESS_STATES,
  canUse,
  resolveEntitlement
} from "../lib/server/features.js";

let passed = 0, failed = 0;
const test = (name, condition) => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name); }
};

const legacy = {
  plan_id: "founding_beta",
  provider: "founding_beta",
  status: "active",
  is_founder: true,
  current_period_end: "2099-01-01T00:00:00.000Z"
};
const entitlement = resolveEntitlement(legacy);

test("legacy founding-beta row resolves to free",
  entitlement.accessState === ACCESS_STATES.FREE && entitlement.tier === 0);
test("legacy row keeps free Today access", canUse("today", legacy));
test("legacy row keeps limited free Coach access", canUse("coach_chat", legacy));
test("legacy row cannot use adaptive AI", !canUse("adaptive_ai", legacy));
test("legacy row cannot modify plans", !canUse("workout_modifications", legacy));
test("legacy row cannot use Daily Brief", !canUse("daily_brief", legacy));

const whop = {
  provider: "whop",
  plan_id: "performance",
  status: "active",
  current_period_end: "2099-01-01T00:00:00.000Z"
};
test("verified Whop row remains paid_active",
  resolveEntitlement(whop).accessState === ACCESS_STATES.PAID_ACTIVE);
test("verified Whop row unlocks Performance features",
  canUse("adaptive_ai", whop) && canUse("daily_brief", whop));

const client = readFileSync("./js/features.js", "utf8");
const index = readFileSync("./index.html", "utf8");
test("client also requires provider whop", /provider === "whop"/.test(client));
test("timed founding access banner is removed",
  !/foundingBetaBanner|Full access until/.test(index + client));

// Historical migrations are deliberately untouched. Runtime code ignores
// non-Whop grants, so no production SQL is needed for the freemium rollout.
test("historical migration remains unchanged and present",
  readFileSync("./migrations/2026-07-26_founding_beta.sql", "utf8").length > 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
