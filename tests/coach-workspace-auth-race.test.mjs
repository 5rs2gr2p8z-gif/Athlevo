import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const guardSource = readFileSync("./js/authRouteGuard.js", "utf8");
const coachModeSource = readFileSync("./js/coachMode.js", "utf8");
const dashboardSource = readFileSync("./js/coachDashboard.js", "utf8");
const indexSource = readFileSync("./index.html", "utf8");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeElement(document, id, className = "") {
  const classes = new Set(className.split(/\s+/).filter(Boolean));
  const children = [];
  const element = {
    id,
    className,
    style: {},
    dataset: {},
    children,
    parentNode: null,
    innerHTML: "",
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => force === undefined
        ? (classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true))
        : (force ? classes.add(name) : classes.delete(name), !!force)
    },
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] ?? null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(child) {
      child.parentNode = this;
      children.push(child);
      if (child.id) document.elements.set(child.id, child);
      return child;
    },
    insertBefore(child) { return this.appendChild(child); },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      if (child.id) document.elements.delete(child.id);
      child.parentNode = null;
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  };
  return element;
}

function makeWorld({ userId = "athlete", fetchImpl, legacyWorkspace = "coach_workspace", hash = "" } = {}) {
  const storage = new Map();
  if (legacyWorkspace) storage.set("athlevo_workspace", legacyWorkspace);
  const document = {
    elements: new Map(),
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) { return makeElement(document, "", tag === "section" ? "screen" : ""); },
    getElementById(id) { return this.elements.get(id) || null; },
    querySelector(selector) {
      if (selector === ".device") return this.elements.get("device") || null;
      if (selector === ".screen.active") {
        return [...this.elements.values()].find(el => el.classList && el.classList.contains("active")) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".screen") {
        return [...this.elements.values()].filter(el => el.classList && el.classList.contains("screen"));
      }
      return [];
    }
  };
  document.head = makeElement(document, "head");
  document.body = makeElement(document, "body");
  document.activeElement = null;
  const device = makeElement(document, "device");
  document.elements.set("device", device);
  for (const id of ["screen-today", "screen-coachai", "screen-train", "screen-trends", "screen-you"]) {
    const screen = makeElement(document, id, "screen");
    document.elements.set(id, screen);
    device.appendChild(screen);
  }
  const tabbar = makeElement(document, "tabbar");
  document.elements.set("tabbar", tabbar);
  device.appendChild(tabbar);

  let currentUserId = userId;
  const location = { hash, pathname: "/", search: "" };
  const history = {
    replaced: false,
    replaceState() { this.replaced = true; location.hash = ""; }
  };
  const window = {
    document,
    location,
    history,
    addEventListener() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => callback(),
    AthlevoBrain: { refreshAthleteUI: async () => {} }
  };
  window.window = window;

  const supabaseClient = {
    auth: {
      getSession: async () => ({ data: { session: currentUserId ? {
        access_token: `token-${currentUserId}`,
        user: { id: currentUserId }
      } : null } }),
      getUser: async () => ({ data: { user: currentUserId ? { id: currentUserId } : null } })
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { full_name: "Coach" }, error: null }) })
      })
    })
  };
  const context = vm.createContext({
    window,
    document,
    location,
    history,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    supabaseClient,
    fetch: fetchImpl || (async (_url, init) => {
      const token = init.headers.Authorization.replace("Bearer token-", "");
      return token.startsWith("athlete")
        ? response(403, { role: "athlete" })
        : response(200, { role: "admin", athletes: [] });
    }),
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => callback(),
    encodeURIComponent
  });
  vm.runInContext(guardSource, context);
  vm.runInContext(coachModeSource, context);
  return {
    window,
    document,
    storage,
    location,
    history,
    context,
    setUser(id) { currentUserId = id; }
  };
}

test("athlete with a stale coach preference gets Athlete Workspace and zero coach DOM", async () => {
  const world = makeWorld({ userId: "athlete" });
  const route = world.window.AthlevoAuthRoute.begin("athlete");
  await world.window.AthlevoCoachMode.init(route);

  assert.equal(world.window.AthlevoCoachMode.getWorkspace(), "athlete_workspace");
  assert.equal(world.window.AthlevoCoachMode.canAccessCoachWorkspace(), false);
  assert.equal(world.storage.has("athlevo_workspace"), false);
  assert.equal([...world.document.elements.keys()].some(id => id.startsWith("screen-coach-")), false);
  assert.equal(world.document.getElementById("cmAthleteSwitcher"), null);
});

test("admin cold boot defaults to Athlete Workspace, then explicit entry opens Coach Workspace", async () => {
  const world = makeWorld({ userId: "admin", legacyWorkspace: "coach_workspace" });
  const route = world.window.AthlevoAuthRoute.begin("admin");
  await world.window.AthlevoCoachMode.init(route);

  assert.equal(world.window.AthlevoCoachMode.getWorkspace(), "athlete_workspace");
  assert.equal(world.window.AthlevoCoachMode.canAccessCoachWorkspace(), true);
  assert.equal(world.storage.has("athlevo_workspace"), false);
  assert.equal([...world.document.elements.keys()].some(id => id.startsWith("screen-coach-")), false);

  assert.equal(world.window.AthlevoCoachMode.switchToCoachWorkspace(), true);
  assert.equal(world.window.AthlevoCoachMode.getWorkspace(), "coach_workspace");
  assert.equal(world.document.body.classList.contains("coach-workspace-active"), true);
  assert.ok(world.document.getElementById("screen-coach-you"));
});

test("late admin authorization cannot affect a later athlete account", async () => {
  const adminResponse = deferred();
  const world = makeWorld({
    userId: "admin-a",
    fetchImpl: async (_url, init) => {
      const token = init.headers.Authorization;
      if (token === "Bearer token-admin-a") return adminResponse.promise;
      return response(403, { role: "athlete" });
    }
  });

  const routeA = world.window.AthlevoAuthRoute.begin("admin-a");
  const initA = world.window.AthlevoCoachMode.init(routeA);
  await Promise.resolve();
  await Promise.resolve();

  world.setUser("athlete-b");
  const routeB = world.window.AthlevoAuthRoute.begin("athlete-b");
  await world.window.AthlevoCoachMode.init(routeB);
  adminResponse.resolve(response(200, { role: "admin", athletes: [{ id: "private" }] }));
  await initA;

  const state = world.window.AthlevoCoachMode._state();
  assert.equal(state.authUserId, "athlete-b");
  assert.equal(state.mode, "athlete_mode");
  assert.equal(state.role, "athlete");
  assert.equal(state.workspace, "athlete_workspace");
  assert.equal(state.rosterSize, 0);
  assert.equal([...world.document.elements.keys()].some(id => id.startsWith("screen-coach-")), false);
});

test("admin logout followed by athlete login removes all coach state and DOM", async () => {
  const world = makeWorld({ userId: "admin-a" });
  const adminRoute = world.window.AthlevoAuthRoute.begin("admin-a");
  await world.window.AthlevoCoachMode.init(adminRoute);
  world.window.AthlevoCoachMode.switchToCoachWorkspace();
  assert.ok(world.document.getElementById("screen-coach-you"));

  world.window.AthlevoAuthRoute.invalidate();
  world.window.AthlevoCoachMode.clearWorkspaceOnLogout();
  world.setUser("athlete-b");
  const athleteRoute = world.window.AthlevoAuthRoute.begin("athlete-b");
  await world.window.AthlevoCoachMode.init(athleteRoute);

  const state = world.window.AthlevoCoachMode._state();
  assert.equal(state.authUserId, "athlete-b");
  assert.equal(state.mode, "athlete_mode");
  assert.equal(state.workspace, "athlete_workspace");
  assert.equal(state.rosterSize, 0);
  assert.equal(world.document.getElementById("cmAthleteSwitcher"), null);
  assert.equal([...world.document.elements.keys()].some(id => id.startsWith("screen-coach-")), false);
});

test("route generations allow only the latest concurrent route to render", async () => {
  const world = makeWorld({ userId: "user-a" });
  const firstGate = deferred();
  const secondGate = deferred();
  const rendered = [];

  async function route(userId, gate) {
    const context = world.window.AthlevoAuthRoute.begin(userId);
    await gate.promise;
    if (world.window.AthlevoAuthRoute.isCurrent(context)) rendered.push(userId);
  }

  const first = route("user-a", firstGate);
  const second = route("user-b", secondGate);
  secondGate.resolve();
  await second;
  firstGate.resolve();
  await first;

  assert.deepEqual(rendered, ["user-b"]);
  assert.match(indexSource, /AthlevoAuthRoute\.begin\(userId\)/);
  assert.match(indexSource, /AthlevoCoachMode\.init\(routeContext\)/);
});

test("logout invalidates the active generation and clears coach authorization", async () => {
  const world = makeWorld({ userId: "admin" });
  const route = world.window.AthlevoAuthRoute.begin("admin");
  await world.window.AthlevoCoachMode.init(route);
  world.window.AthlevoCoachMode.switchToCoachWorkspace();

  world.window.AthlevoAuthRoute.invalidate();
  world.window.AthlevoCoachMode.clearWorkspaceOnLogout();

  assert.equal(world.window.AthlevoAuthRoute.isCurrent(route), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(world.window.AthlevoCoachMode._state())),
    { mode: "unknown", role: null, coachName: null, rosterSize: 0, workspace: null, authUserId: null, authGeneration: 0 }
  );
  assert.equal([...world.document.elements.keys()].some(id => id.startsWith("screen-coach-")), false);
});

test("a passive #coach fragment is sanitized for athlete and admin boots", async () => {
  for (const userId of ["athlete", "admin"]) {
    const world = makeWorld({ userId, hash: "#coach" });
    const route = world.window.AthlevoAuthRoute.begin(userId);
    await world.window.AthlevoCoachMode.init(route);
    vm.runInContext(dashboardSource, world.context);
    await world.window.AthlevoCoachDashboard.init();

    assert.equal(world.history.replaced, true);
    assert.equal(world.location.hash, "");
    assert.equal(world.window.AthlevoCoachMode.getWorkspace(), "athlete_workspace");
  }
});

test("shipped router does not call the Coach Dashboard prepaint hook", () => {
  const routeStart = indexSource.indexOf("async function routeAfterAuth");
  const routeEnd = indexSource.indexOf("function isStandaloneMode", routeStart);
  const routeSource = indexSource.slice(routeStart, routeEnd);
  assert.doesNotMatch(routeSource, /prepareDashboardLoading/);
  assert.match(coachModeSource, /function prepareDashboardLoading\(\)\s*\{\s*return false;/);
});
