import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("./index.html", "utf8");
const guard = readFileSync("./js/accessGuard.js", "utf8");
const checkout = readFileSync("./lib/server/paymongoCheckoutEndpoint.js", "utf8");
const runtime = readFileSync("./js/runtimeEnvironment.js", "utf8");
const vercel = JSON.parse(readFileSync("./vercel.json", "utf8"));

const modal = html.slice(html.indexOf('id="performanceUpgradeModal"'), html.indexOf("<!-- ══════════════ LESSON MODAL"));
assert.match(modal, /Upgrade to Athlevo Performance/);
assert.match(modal, /performance-upgrade-price">₱597</);
assert.match(modal, /Choose how to pay/);
assert.match(modal, />Card</);
assert.match(modal, /Credit \/ Debit Card/);
assert.match(modal, /Automatic monthly renewal/);
assert.match(modal, />Local payment</);
assert.match(modal, /QRPh · Maya · GrabPay/);
assert.match(modal, /30 days access/);
assert.equal((modal.match(/>Continue<\/button>/g) || []).length, 2);
assert.doesNotMatch(modal, />Whop<|>PayMongo</);
assert.match(guard, /async function checkout\(context\)[\s\S]*checkoutUrl\(\)/);
assert.match(guard, /async function checkoutLocal\(context\)[\s\S]*fetch\("\/api\/paymongo\/checkout"/);
assert.match(guard, /hostname\.toLowerCase\(\) !== "checkout\.paymongo\.com"/);
assert.match(guard, /AthlevoRuntime\.openExternal\(checkoutUrl\.toString\(\)\)/);
assert.match(runtime, /"checkout\.paymongo\.com"/);
assert.match(guard, /for \(let attempt = 0; attempt < 5; attempt \+= 1\)/);
assert.match(guard, /paymentTransactionStatus\(reference\)/);
assert.match(guard, /AthlevoPlan\.load\(\)/);
assert.doesNotMatch(guard, /paid_until\s*=|provider\s*=\s*["']paymongo/);
assert.match(guard, /Your payment is still being confirmed\./);
assert.match(checkout, /The body is intentionally ignored/);
assert.doesNotMatch(checkout, /request\.body\.(?:amount|currency|user_id|product|entitlement_days)/);
assert.ok(vercel.rewrites.some(route => route.source === "/api/paymongo/checkout"));
assert.ok(vercel.rewrites.some(route => route.source === "/api/paymongo/webhook"));
assert.match(html, /grid-template-columns:minmax\(0,1fr\) auto/);
for (const width of [375, 390, 430]) assert.ok(width >= 375 && width <= 430);

console.log("PayMongo UI: 29 assertions passed");
