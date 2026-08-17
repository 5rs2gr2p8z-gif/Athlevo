/*
 * Athlevo authenticated-route generation guard.
 *
 * Every post-auth route receives an immutable user/generation context. Async
 * work may update application state only while that context is still current.
 */
(function (root) {
  "use strict";

  var generation = 0;
  var currentUserId = null;

  function normalizeUserId(userId) {
    return typeof userId === "string" && userId ? userId : null;
  }

  function begin(userId) {
    generation += 1;
    currentUserId = normalizeUserId(userId);
    return Object.freeze({ userId: currentUserId, generation: generation });
  }

  function invalidate() {
    generation += 1;
    currentUserId = null;
    return generation;
  }

  function isCurrent(context) {
    return !!context &&
      context.userId !== null &&
      context.userId === currentUserId &&
      context.generation === generation;
  }

  function current() {
    return { userId: currentUserId, generation: generation };
  }

  root.AthlevoAuthRoute = {
    begin: begin,
    invalidate: invalidate,
    isCurrent: isCurrent,
    current: current
  };
})(typeof window !== "undefined" ? window : globalThis);
