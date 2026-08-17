/* Shared first-hydration handoff for Train, Trends, and You. */
(function (root) {
  "use strict";

  var ready = Object.create(null);
  var timers = Object.create(null);
  var HANDOFF_MS = 120;

  function screenFor(name) {
    return root.document && root.document.getElementById("screen-" + name);
  }

  function reducedMotion() {
    return Boolean(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function begin(name) {
    var screen = screenFor(name);
    if (!screen || ready[name]) return false;
    if (timers[name]) root.clearTimeout(timers[name]);
    screen.classList.remove("athlevo-surface-revealing");
    screen.classList.add("athlevo-surface-loading");
    screen.setAttribute("aria-busy", "true");
    return true;
  }

  function settle(name, succeeded) {
    var screen = screenFor(name);
    if (!screen) return;
    if (succeeded) ready[name] = true;
    screen.setAttribute("aria-busy", "false");
    screen.classList.remove("athlevo-surface-loading");

    if (reducedMotion()) {
      screen.classList.remove("athlevo-surface-revealing");
      return;
    }

    screen.classList.add("athlevo-surface-revealing");
    timers[name] = root.setTimeout(function () {
      screen.classList.remove("athlevo-surface-revealing");
      timers[name] = null;
    }, HANDOFF_MS);
  }

  function reset(name) {
    ready[name] = false;
    return begin(name);
  }

  root.AthlevoLoadingContinuity = {
    begin: begin,
    success: function (name) { settle(name, true); },
    error: function (name) { settle(name, false); },
    reset: reset,
    isReady: function (name) { return Boolean(ready[name]); },
    handoffMs: HANDOFF_MS
  };
})(window);
