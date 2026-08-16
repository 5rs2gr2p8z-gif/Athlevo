/*
 * Athlevo — service-worker shell freshness and trial-UI regression tests.
 * Run: node tests/service-worker-cache.test.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
const test = (name, condition) => {
  if (condition) { passed += 1; console.log("PASS — " + name); }
  else { failed += 1; console.log("FAIL — " + name); }
};
const section = name => console.log(`\n──── ${name} ────`);

const workerSource = readFileSync("./service-worker.js", "utf8");
const indexSource = readFileSync("./index.html", "utf8");
const accessGuardSource = readFileSync("./js/accessGuard.js", "utf8");
const currentCacheName =
  (workerSource.match(/CACHE_VERSION = "(athlevo-shell-v\d+)"/) || [])[1];

class FakeResponse {
  constructor(body, { ok = true, status = 200, type = "basic" } = {}) {
    this.body = body;
    this.ok = ok;
    this.status = status;
    this.type = type;
  }
  clone() {
    return new FakeResponse(this.body, {
      ok: this.ok, status: this.status, type: this.type
    });
  }
  async text() { return this.body; }
}

const keyOf = request => typeof request === "string" ? request : request.url;
const stores = new Map();
const deletedCaches = [];
const cacheApi = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async add(key) {
        store.set(keyOf(key), new FakeResponse("precache:" + keyOf(key)));
      },
      async put(key, response) {
        store.set(keyOf(key), response.clone ? response.clone() : response);
      },
      async match(key) {
        return store.get(keyOf(key));
      }
    };
  },
  async keys() { return [...stores.keys()]; },
  async delete(name) {
    deletedCaches.push(name);
    return stores.delete(name);
  },
  async match() {
    throw new Error("The worker must not search across cache versions");
  }
};

const listeners = {};
let claimed = false;
let skippedWaiting = false;
let fetchImpl = async () => new FakeResponse("network");
const selfMock = {
  location: { origin: "https://app.test" },
  clients: { claim: async () => { claimed = true; } },
  skipWaiting: async () => { skippedWaiting = true; },
  addEventListener(type, handler) { listeners[type] = handler; }
};
const fetchMock = (...args) => fetchImpl(...args);
new Function("self", "caches", "fetch", workerSource)(
  selfMock, cacheApi, fetchMock
);

async function dispatchLifecycle(type) {
  let work = Promise.resolve();
  listeners[type]({ waitUntil(promise) { work = Promise.resolve(promise); } });
  await work;
}

async function dispatchFetch(request) {
  let responsePromise;
  const background = [];
  listeners.fetch({
    request,
    respondWith(value) { responsePromise = Promise.resolve(value); },
    waitUntil(value) { background.push(Promise.resolve(value)); }
  });
  const response = await responsePromise;
  await Promise.all(background);
  return response;
}

section("Cache activation");
{
  stores.set(currentCacheName, new Map());
  stores.set("athlevo-shell-v12", new Map());
  stores.set("athlevo-runtime-v4", new Map());
  stores.set("unrelated-library-cache", new Map());
  await dispatchLifecycle("activate");

  test("cache version was bumped to v79", currentCacheName === "athlevo-shell-v79");
  test("every old Athlevo cache is deleted",
    deletedCaches.includes("athlevo-shell-v12") &&
    deletedCaches.includes("athlevo-runtime-v4"));
  test("current Athlevo cache is retained", stores.has(currentCacheName));
  test("unrelated origin caches are retained", stores.has("unrelated-library-cache"));
  test("new worker claims existing clients", claimed);
}

section("Navigation is network-first");
{
  const current = stores.get(currentCacheName);
  current.set("/index.html", new FakeResponse("OLD CACHED HTML"));
  let fetchOptions = null;
  fetchImpl = async (_request, options) => {
    fetchOptions = options;
    return new FakeResponse("CURRENT NETWORK HTML");
  };

  const response = await dispatchFetch({
    method: "GET",
    mode: "navigate",
    url: "https://app.test/"
  });
  test("online navigation returns network HTML",
    await response.text() === "CURRENT NETWORK HTML");
  test("navigation bypasses the browser HTTP cache",
    fetchOptions && fetchOptions.cache === "no-store");
  test("successful navigation refreshes the offline shell",
    await current.get("/index.html").text() === "CURRENT NETWORK HTML");
}

section("Offline fallback cannot cross into an old cache");
{
  const current = stores.get(currentCacheName);
  current.set("/index.html", new FakeResponse("CURRENT OFFLINE HTML"));
  stores.set("athlevo-shell-v1", new Map([
    ["/index.html", new FakeResponse("OBSOLETE TRIAL HTML")]
  ]));
  fetchImpl = async () => { throw new Error("offline"); };

  const cached = await dispatchFetch({
    method: "GET",
    mode: "navigate",
    url: "https://app.test/"
  });
  test("offline navigation uses only the current shell",
    await cached.text() === "CURRENT OFFLINE HTML");

  current.delete("/index.html");
  current.delete("/");
  const noCurrentShell = await dispatchFetch({
    method: "GET",
    mode: "navigate",
    url: "https://app.test/"
  });
  test("an old cache is never used when the current shell is absent",
    noCurrentShell === undefined);
}

section("Static assets retain offline support");
{
  const current = stores.get(currentCacheName);
  const request = {
    method: "GET",
    mode: "same-origin",
    url: "https://app.test/js/app.js"
  };
  current.set(request.url, new FakeResponse("CURRENT CACHED JS"));
  fetchImpl = async () => { throw new Error("offline"); };
  const response = await dispatchFetch(request);
  test("current static assets remain available offline",
    await response.text() === "CURRENT CACHED JS");
}

section("Worker activation and product UI contracts");
{
  await dispatchLifecycle("install");
  test("new worker skips waiting", skippedWaiting);
  test("registration bypasses cached worker scripts",
    /updateViaCache:\s*['"]none['"]/.test(indexSource));
  test("controlled clients reload once after controller change",
    /controllerchange/.test(indexSource) &&
    /reloadingForWorker/.test(indexSource) &&
    /window\.location\.reload\(\)/.test(indexSource));

  const sourceFiles = ["index.html", "service-worker.js", "manifest.webmanifest"];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:html|js|css|json|webmanifest)$/.test(name)) sourceFiles.push(path);
    }
  };
  walk("js");
  const productSource = sourceFiles.map(path => readFileSync(path, "utf8")).join("\n");
  const forbidden = [
    ["Start my", "3-day free trial"].join(" "),
    ["Start", "Free Trial"].join(" "),
    ["3 days", "free"].join(" "),
    ["₱0 due", "today"].join(" "),
    ["₱597/month", "after trial"].join(" "),
    ["Start your", "3-day free trial"].join(" ")
  ];
  test("old timed-trial strings do not exist in current product source",
    forbidden.every(value => !productSource.includes(value)));
  test("obsolete trial screen and handler do not exist",
    !/screen-paywall|AthlevoPaywall|paywallBody/.test(productSource));
  test("paid action uses the explicit approved label",
    /Upgrade to Athlevo Performance/.test(accessGuardSource));
  test("Whop opener remains isolated to the explicit checkout handler",
    /function checkout\(context\)[\s\S]*AthlevoRuntime\.openExternal\(checkoutUrl\(\)\)[\s\S]*window\.open\(checkoutUrl\(\)/.test(accessGuardSource));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
