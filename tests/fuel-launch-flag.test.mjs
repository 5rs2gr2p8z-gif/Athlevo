/*
 * Athlevo Fuel V1 — launch flag behaviour.
 *
 * Fuel ships ON by default (js/fuel.js DEFAULT_ENABLED) but stays behind the
 * existing `fuel_tracking_v1` flag so it can still be switched off per browser
 * or remotely via PostHog, with no Android-only bypass.
 *
 * Run: node tests/fuel-launch-flag.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const fuelSrc = readFileSync("js/fuel.js", "utf8");
const flagsSrc = readFileSync("js/featureFlags.js", "utf8");
const indexSrc = readFileSync("index.html", "utf8");

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

function world({ override = null, posthogValue = undefined } = {}) {
  const store = new Map();
  if (override !== null) store.set("athlevo_ff_fuel_tracking_v1", override);
  const els = {};
  const el = id => (els[id] = { id, hidden: true, innerHTML: "", classList: { contains: () => false, add() {}, remove() {} }, addEventListener() {}, scrollTop: 0 });
  for (const id of ["fuelRoot", "screen-fuel", "fuelSheet", "fuelSheetBody", "homeFuelEntry", "fuelCameraInput", "fuelLibraryInput"]) el(id);
  const ph = { value: posthogValue, callbacks: [], isFeatureEnabled() { return this.value; }, onFeatureFlags(cb) { this.callbacks.push(cb); } };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Date, URL });
  ctx.window = ctx; ctx.self = ctx;
  ctx.location = { href: "https://localhost/index.html" };
  ctx.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  ctx.posthog = ph;
  ctx.document = { readyState: "complete", activeElement: null, getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, contains: () => true };
  ctx.navigator = { onLine: true };
  ctx.addEventListener = () => {};
  vm.runInContext(flagsSrc, ctx);
  vm.runInContext(fuelSrc, ctx);
  return { ctx, els, ph, fuel: ctx.AthlevoFuel };
}

test("default launch state: Fuel is enabled and the You entry is shown", () => {
  const w = world();
  assert.equal(w.fuel.DEFAULT_ENABLED, true);
  assert.equal(w.fuel.isEnabled(), true);
  assert.equal(w.els.homeFuelEntry.hidden, false);
});

test("a PostHog flag that is undefined (not defined / not loaded yet) keeps the default", () => {
  assert.equal(world({ posthogValue: undefined }).fuel.isEnabled(), true);
});

test("PostHog can turn Fuel off remotely, and on", () => {
  assert.equal(world({ posthogValue: false }).fuel.isEnabled(), false);
  assert.equal(world({ posthogValue: true }).fuel.isEnabled(), true);
});

test("the per-browser override still wins over PostHog and the default", () => {
  assert.equal(world({ override: "0" }).fuel.isEnabled(), false);
  assert.equal(world({ override: "0", posthogValue: true }).fuel.isEnabled(), false);
  assert.equal(world({ override: "1", posthogValue: false }).fuel.isEnabled(), true);
});

test("disabled: entry hidden and Fuel cannot be opened", () => {
  const w = world({ override: "0" });
  assert.equal(w.els.homeFuelEntry.hidden, true);
  assert.equal(w.fuel.open("you_card"), false);
});

test("flags arriving late from PostHog re-sync the entry (no visible-but-dead button)", () => {
  const w = world({ posthogValue: undefined });
  assert.equal(w.els.homeFuelEntry.hidden, false);
  assert.equal(w.ph.callbacks.length, 1, "subscribed to PostHog flag updates");
  w.ph.value = false;
  w.ph.callbacks.forEach(cb => cb());
  assert.equal(w.els.homeFuelEntry.hidden, true);
  w.ph.value = true;
  w.ph.callbacks.forEach(cb => cb());
  assert.equal(w.els.homeFuelEntry.hidden, false);
});

test("no Android-only bypass: Fuel does not branch on platform", () => {
  assert.doesNotMatch(fuelSrc, /isNativeAndroid|nativePlatform|getPlatform|AthlevoRuntime/);
});

test("the flag key and script order are unchanged", () => {
  assert.equal(world().fuel.FLAG, "fuel_tracking_v1");
  assert.ok(indexSrc.indexOf('<script src="js/featureFlags.js') > -1 &&
    indexSrc.indexOf('<script src="js/featureFlags.js') < indexSrc.indexOf('<script src="js/fuel.js'));
  assert.match(indexSrc, /id="homeFuelEntry" hidden>/, "entry still ships hidden until the flag resolves");
});

console.log(`\n${passed} tests passed`);
