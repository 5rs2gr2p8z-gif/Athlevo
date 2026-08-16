/*
 * Athlevo shared sheet engine.
 *
 * Owns the interaction layer for migrated, non-destructive sheets: one active
 * sheet, interruptible open/close motion, scrim dismissal, scroll locking,
 * background inertness, focus trapping, Escape, and focus restoration.
 * Drag dismissal is opt-in so transactional and destructive dialogs can never
 * acquire the gesture accidentally.
 */
(function (root) {
  "use strict";

  var active = null;
  var motionSequence = 0;
  var FOCUSABLE = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");

  function reducedMotion() {
    return Boolean(root.matchMedia &&
      root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function phaseFor(sheetRoot) {
    return active && active.root === sheetRoot ? active.phase : "closed";
  }

  function resolveElement(value, scope) {
    if (typeof value === "function") value = value(scope);
    if (typeof value === "string") return scope.querySelector(value);
    return value || null;
  }

  function focusableElements(sheet) {
    if (!sheet || !sheet.querySelectorAll) return [];
    return Array.from(sheet.querySelectorAll(FOCUSABLE)).filter(function (element) {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
      if (typeof element.closest === "function" && element.closest("[hidden]")) return false;
      return element.offsetParent !== null || typeof element.offsetParent === "undefined";
    });
  }

  function rememberAndInertBackground(state) {
    state.background = [];
    var branch = state.root;
    while (branch && branch.parentElement) {
      var parent = branch.parentElement;
      Array.from(parent.children || []).forEach(function (element) {
        if (element === branch || element.nodeType !== 1) return;
        if (/^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(String(element.tagName || "").toUpperCase())) return;
        state.background.push({
          element: element,
          inert: element.inert === true,
          ariaHidden: element.getAttribute("aria-hidden")
        });
        element.inert = true;
        element.setAttribute("aria-hidden", "true");
      });
      if (parent === document.body) break;
      branch = parent;
    }
  }

  function restoreBackground(state) {
    (state.background || []).forEach(function (saved) {
      if (!saved.element || !saved.element.isConnected) return;
      saved.element.inert = saved.inert;
      if (saved.ariaHidden === null) saved.element.removeAttribute("aria-hidden");
      else saved.element.setAttribute("aria-hidden", saved.ariaHidden);
    });
    state.background = [];
  }

  function lockScroll(state) {
    var body = document.body;
    var html = document.documentElement;
    var scrollX = Number(root.scrollX || root.pageXOffset || 0);
    var scrollY = Number(root.scrollY || root.pageYOffset || 0);
    state.scroll = {
      x: scrollX,
      y: scrollY,
      body: body ? {
        position: body.style.position,
        top: body.style.top,
        left: body.style.left,
        right: body.style.right,
        width: body.style.width,
        overflow: body.style.overflow
      } : null,
      htmlOverflow: html ? html.style.overflow : "",
      screens: []
    };

    if (document.querySelectorAll) {
      document.querySelectorAll(".screen.active").forEach(function (screen) {
        state.scroll.screens.push({ element: screen, overflow: screen.style.overflow });
        screen.style.overflow = "hidden";
      });
    }
    if (html) html.style.overflow = "hidden";
    if (body) {
      body.classList.add("athlevo-sheet-locked");
      body.style.position = "fixed";
      body.style.top = (-scrollY) + "px";
      body.style.left = (-scrollX) + "px";
      body.style.right = "0";
      body.style.width = "100%";
      body.style.overflow = "hidden";
    }
  }

  function unlockScroll(state) {
    var saved = state.scroll;
    if (!saved) return;
    var body = document.body;
    var html = document.documentElement;
    saved.screens.forEach(function (entry) {
      if (entry.element && entry.element.isConnected) entry.element.style.overflow = entry.overflow;
    });
    if (html) html.style.overflow = saved.htmlOverflow;
    if (body && saved.body) {
      body.classList.remove("athlevo-sheet-locked");
      body.style.position = saved.body.position;
      body.style.top = saved.body.top;
      body.style.left = saved.body.left;
      body.style.right = saved.body.right;
      body.style.width = saved.body.width;
      body.style.overflow = saved.body.overflow;
    }
    if (typeof root.scrollTo === "function") root.scrollTo(saved.x, saved.y);
    state.scroll = null;
  }

  function restoreFocus(state) {
    var target = state.returnFocus;
    if (!target || target.isConnected === false || typeof target.focus !== "function") {
      target = resolveElement(state.options.fallbackFocus, document) ||
        document.querySelector("#tabbar .tab.on, .screen.active button, .screen.active [tabindex]");
    }
    if (target && typeof target.focus === "function") {
      try { target.focus({ preventScroll: true }); } catch (error) { target.focus(); }
    }
  }

  function cancelAnimations(state) {
    (state.animations || []).forEach(function (animation) {
      try { animation.cancel(); } catch (error) {}
    });
    state.animations = [];
  }

  function removeDragListeners(state) {
    var drag = state.drag;
    if (!drag) return;
    if (drag.pointerId !== null && drag.handle && typeof drag.handle.releasePointerCapture === "function") {
      try { drag.handle.releasePointerCapture(drag.pointerId); } catch (error) {}
    }
    state.sheet.removeEventListener("pointermove", drag.move);
    state.sheet.removeEventListener("pointerup", drag.end);
    state.sheet.removeEventListener("pointercancel", drag.cancel);
    drag.pointerId = null;
    drag.tracking = false;
  }

  function resetDragPresentation(state) {
    if (!state.drag) return;
    state.drag.offset = 0;
    state.dragOffset = 0;
    state.sheet.style.transform = "";
    state.sheet.style.opacity = "";
    state.root.style.opacity = "";
  }

  function cleanUpDrag(state) {
    if (!state.drag) return;
    removeDragListeners(state);
    if (state.drag.handle) state.drag.handle.removeEventListener("pointerdown", state.drag.start);
    if (state.drag.createdHandle && state.drag.handle && state.drag.handle.parentNode) {
      state.drag.handle.parentNode.removeChild(state.drag.handle);
    }
    resetDragPresentation(state);
    state.drag = null;
  }

  function finishOpen(state) {
    if (active !== state || state.phase !== "opening") return;
    cancelAnimations(state);
    if (state.timer !== null) root.clearTimeout(state.timer);
    state.timer = null;
    state.root.classList.add("athlevo-sheet-open");
    state.phase = "open";
    state.sheet.style.willChange = "";
    state.root.style.willChange = "";
    resetDragPresentation(state);
    if (typeof state.options.onAfterOpen === "function") state.options.onAfterOpen();
  }

  function finishClose(state) {
    if (active !== state || state.phase !== "closing") return;
    cancelAnimations(state);
    if (state.timer !== null) root.clearTimeout(state.timer);
    state.timer = null;
    document.removeEventListener("keydown", state.keydown, true);
    state.root.removeEventListener("click", state.backdrop);
    cleanUpDrag(state);
    state.root.classList.remove(
      "athlevo-sheet-open",
      "athlevo-sheet-mounted",
      "athlevo-sheet-fallback"
    );
    state.sheet.classList.remove("athlevo-sheet-material");
    state.sheet.style.willChange = "";
    state.root.style.willChange = "";
    state.root.setAttribute("aria-hidden", "true");
    restoreBackground(state);
    unlockScroll(state);
    state.phase = "closed";
    active = null;
    var afterClose = state.closeOptions && state.closeOptions.onAfterClose ||
      state.options.onAfterClose;
    if (typeof afterClose === "function") afterClose();
    if (!state.closeOptions || state.closeOptions.restoreFocus !== false) restoreFocus(state);
  }

  function finishMotion(state) {
    if (state.phase === "opening") finishOpen(state);
    else if (state.phase === "closing") finishClose(state);
  }

  function runAnimation(state, opening) {
    var duration = Number(state.options.duration) || 280;
    var easing = state.options.easing || "cubic-bezier(.2,.9,.15,1)";
    var canAnimate = !reducedMotion() &&
      typeof state.root.animate === "function" &&
      typeof state.sheet.animate === "function";
    var sequence = ++motionSequence;
    state.motionSequence = sequence;

    if (reducedMotion()) {
      if (opening) finishOpen(state);
      else finishClose(state);
      return;
    }

    state.root.style.willChange = "opacity";
    state.sheet.style.willChange = "transform, opacity";
    if (canAnimate) {
      var scrimFrames = opening
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 1 }, { opacity: 0 }];
      var sheetFrames = opening
        ? [
            { transform: "translate3d(0, 32px, 0)", opacity: .985 },
            { transform: "translate3d(0, 0, 0)", opacity: 1 }
          ]
        : [
            { transform: "translate3d(0, 0, 0)", opacity: 1 },
            { transform: "translate3d(0, 32px, 0)", opacity: .985 }
          ];
      var scrim = state.root.animate(scrimFrames, {
        duration: Math.min(duration, 200),
        easing: "cubic-bezier(.2,.7,.2,1)",
        fill: "both"
      });
      var material = state.sheet.animate(sheetFrames, {
        duration: duration,
        easing: easing,
        fill: "both"
      });
      state.animations = [scrim, material];
      material.onfinish = function () {
        if (active === state && state.motionSequence === sequence) finishMotion(state);
      };
      return;
    }

    state.root.classList.add("athlevo-sheet-fallback");
    var applyTarget = function () {
      if (active !== state || state.motionSequence !== sequence) return;
      state.root.classList.toggle("athlevo-sheet-open", opening);
      state.timer = root.setTimeout(function () {
        if (active === state && state.motionSequence === sequence) finishMotion(state);
      }, duration);
    };
    if (root.requestAnimationFrame) root.requestAnimationFrame(applyTarget);
    else applyTarget();
  }

  function runDragClose(state) {
    var start = Math.max(0, Number(state.dragOffset) || 0);
    var end = Math.max(state.drag && state.drag.sheetHeight || 0,
      Number(root.innerHeight) || 640);
    var sequence = ++motionSequence;
    state.motionSequence = sequence;
    state.phase = "closing";
    removeDragListeners(state);
    cancelAnimations(state);
    if (reducedMotion() || typeof state.sheet.animate !== "function") {
      finishClose(state);
      return;
    }
    state.sheet.style.transform = "";
    state.sheet.style.opacity = "";
    state.root.style.opacity = "";
    state.sheet.style.willChange = "transform, opacity";
    state.root.style.willChange = "opacity";
    var remaining = Math.max(.25, 1 - Math.min(1, start / end));
    var duration = Math.max(140, Math.round((Number(state.options.duration) || 280) * remaining));
    var material = state.sheet.animate([
      { transform: "translate3d(0," + start + "px,0)", opacity: 1 },
      { transform: "translate3d(0," + end + "px,0)", opacity: .985 }
    ], { duration: duration, easing: "cubic-bezier(.32,.72,0,1)", fill: "both" });
    var scrim = state.root.animate([
      { opacity: Math.max(0, 1 - start / end) }, { opacity: 0 }
    ], { duration: Math.min(duration, 180), easing: "linear", fill: "both" });
    state.animations = [scrim, material];
    material.onfinish = function () {
      if (active === state && state.motionSequence === sequence) finishClose(state);
    };
  }

  function settleDrag(state) {
    if (active !== state) return;
    var start = Number(state.dragOffset) || 0;
    state.dragOffset = 0;
    if (reducedMotion() || typeof state.sheet.animate !== "function") {
      resetDragPresentation(state);
      return;
    }
    state.sheet.style.transform = "";
    state.root.style.opacity = "";
    cancelAnimations(state);
    var material = state.sheet.animate([
      { transform: "translate3d(0," + start + "px,0)" },
      { transform: "translate3d(0,0,0)" }
    ], { duration: 300, easing: "cubic-bezier(.2,.9,.2,1.08)", fill: "both" });
    var scrim = state.root.animate([
      { opacity: Math.max(.45, 1 - Math.max(0, start) / Math.max(1, state.drag.sheetHeight)) },
      { opacity: 1 }
    ], { duration: 180, easing: "ease-out", fill: "both" });
    state.animations = [scrim, material];
    material.onfinish = function () {
      if (active !== state || state.phase !== "open") return;
      cancelAnimations(state);
      resetDragPresentation(state);
    };
  }

  function installDrag(state) {
    if (state.options.draggable !== true || !root.PointerEvent || reducedMotion()) return;
    var handle = resolveElement(state.options.dragHandle, state.sheet);
    var createdHandle = false;
    if (!handle) {
      handle = document.createElement("div");
      handle.className = "athlevo-sheet-drag-handle";
      handle.setAttribute("aria-hidden", "true");
      state.sheet.insertBefore(handle, state.sheet.firstChild);
      createdHandle = true;
    } else {
      handle.classList.add("athlevo-sheet-drag-handle");
    }
    var drag = state.drag = {
      handle: handle,
      createdHandle: createdHandle,
      pointerId: null,
      tracking: false,
      intent: null,
      startX: 0,
      startY: 0,
      startTime: 0,
      lastY: 0,
      lastTime: 0,
      velocity: 0,
      offset: 0,
      baseOffset: 0,
      sheetHeight: 0
    };
    function presentationY(transform) {
      if (!transform || transform === "none") return 0;
      if (root.DOMMatrixReadOnly) {
        try { return new root.DOMMatrixReadOnly(transform).m42 || 0; } catch (error) {}
      }
      var matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
      if (matrix3d) return Number(matrix3d[1].split(",")[13]) || 0;
      var matrix = transform.match(/^matrix\(([^)]+)\)$/);
      if (matrix) return Number(matrix[1].split(",")[5]) || 0;
      var translated = transform.match(/translate3d\([^,]+,\s*([-\d.]+)px/i);
      return translated ? Number(translated[1]) || 0 : 0;
    }
    drag.start = function (event) {
      if (active !== state || state.phase === "closing" || event.button !== 0 || !event.isPrimary) return;
      var materialStyle = root.getComputedStyle ? root.getComputedStyle(state.sheet) : null;
      var scrimStyle = root.getComputedStyle ? root.getComputedStyle(state.root) : null;
      var currentTransform = materialStyle && materialStyle.transform !== "none"
        ? materialStyle.transform : "translate3d(0,0,0)";
      var currentOpacity = scrimStyle ? scrimStyle.opacity : "1";
      cancelAnimations(state);
      if (state.timer !== null) root.clearTimeout(state.timer);
      state.timer = null;
      state.phase = "open";
      state.root.classList.add("athlevo-sheet-open");
      drag.baseOffset = presentationY(currentTransform);
      drag.offset = drag.baseOffset;
      state.dragOffset = drag.offset;
      state.sheet.style.transform = currentTransform;
      state.sheet.style.opacity = "1";
      state.root.style.opacity = currentOpacity;
      drag.pointerId = event.pointerId;
      drag.tracking = true;
      drag.intent = null;
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      drag.startTime = event.timeStamp || Date.now();
      drag.lastY = event.clientY;
      drag.lastTime = drag.startTime;
      drag.velocity = 0;
      drag.sheetHeight = state.sheet.getBoundingClientRect().height || root.innerHeight || 640;
      try { handle.setPointerCapture(event.pointerId); } catch (error) {}
      state.sheet.addEventListener("pointermove", drag.move, { passive: false });
      state.sheet.addEventListener("pointerup", drag.end);
      state.sheet.addEventListener("pointercancel", drag.cancel);
    };
    drag.move = function (event) {
      if (!drag.tracking || event.pointerId !== drag.pointerId) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.intent && Math.max(Math.abs(dx), Math.abs(dy)) >= 6) {
        drag.intent = Math.abs(dy) >= Math.abs(dx) ? "vertical" : "horizontal";
      }
      if (drag.intent === "horizontal") {
        removeDragListeners(state);
        return;
      }
      if (drag.intent !== "vertical") return;
      event.preventDefault();
      var now = event.timeStamp || Date.now();
      var elapsed = Math.max(1, now - drag.lastTime);
      drag.velocity = (event.clientY - drag.lastY) / elapsed;
      drag.lastY = event.clientY;
      drag.lastTime = now;
      drag.offset = drag.baseOffset + (dy < 0 ? dy * .18 : dy);
      state.dragOffset = drag.offset;
      state.sheet.style.transform = "translate3d(0," + drag.offset + "px,0)";
      state.root.style.opacity = String(Math.max(.32, 1 - Math.max(0, drag.offset) / drag.sheetHeight));
    };
    drag.end = function (event) {
      if (!drag.tracking || event.pointerId !== drag.pointerId) return;
      var projected = drag.offset + drag.velocity * 180;
      var dismiss = drag.intent === "vertical" && drag.offset > 0 &&
        (projected > Math.max(88, drag.sheetHeight * .24) || drag.velocity > .65);
      removeDragListeners(state);
      if (dismiss) {
        if (!requestClose(state, "drag", event)) settleDrag(state);
      }
      else settleDrag(state);
    };
    drag.cancel = function () {
      if (!drag.tracking) return;
      removeDragListeners(state);
      settleDrag(state);
    };
    handle.addEventListener("pointerdown", drag.start);
  }

  function reverseAnimation(state, nextPhase) {
    state.phase = nextPhase;
    state.motionSequence = ++motionSequence;
    if (state.timer !== null) {
      root.clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.animations && state.animations.length) {
      var sequence = state.motionSequence;
      state.animations.forEach(function (animation) {
        try { animation.reverse(); } catch (error) {}
      });
      var material = state.animations[state.animations.length - 1];
      material.onfinish = function () {
        if (active === state && state.motionSequence === sequence) finishMotion(state);
      };
      return;
    }
    state.root.classList.toggle("athlevo-sheet-open", nextPhase === "opening");
    var duration = Number(state.options.duration) || 280;
    var sequence = state.motionSequence;
    state.timer = root.setTimeout(function () {
      if (active === state && state.motionSequence === sequence) finishMotion(state);
    }, reducedMotion() ? 0 : duration);
  }

  function requestClose(state, reason, event) {
    if (active !== state || state.phase === "closing") return false;
    var allowed = true;
    if (typeof state.options.onRequestClose === "function") {
      allowed = state.options.onRequestClose(reason, event) !== false;
    }
    if (active === state && state.phase === "closing") return true;
    if (allowed && active === state && state.phase !== "closing") {
      close(state.root);
      return true;
    }
    return false;
  }

  function handleKeydown(state, event) {
    if (active !== state) return;
    if (event.key === "Escape" && state.options.closeOnEscape !== false) {
      event.preventDefault();
      requestClose(state, "escape", event);
      return;
    }
    if (event.key !== "Tab") return;
    var focusable = focusableElements(state.sheet);
    if (!focusable.length) {
      event.preventDefault();
      state.sheet.focus({ preventScroll: true });
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !state.sheet.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !state.sheet.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  function forceClose(state, restore) {
    if (!state) return;
    state.phase = "closing";
    state.closeOptions = { restoreFocus: restore !== false };
    finishClose(state);
  }

  function open(options) {
    options = options || {};
    var sheetRoot = resolveElement(options.root, document);
    if (!sheetRoot) return null;

    if (active && active.root === sheetRoot) {
      if (active.phase === "closing") {
        active.options = Object.assign({}, active.options, options);
        active.closeOptions = null;
        reverseAnimation(active, "opening");
      }
      return active;
    }
    if (active) forceClose(active, false);

    var sheet = resolveElement(options.sheet, sheetRoot) || sheetRoot.firstElementChild;
    if (!sheet) return null;
    var state = {
      root: sheetRoot,
      sheet: sheet,
      options: options,
      phase: "opening",
      returnFocus: resolveElement(options.returnFocus, document) || document.activeElement,
      animations: [],
      timer: null,
      closeOptions: null,
      background: [],
      scroll: null,
      motionSequence: 0
    };
    state.keydown = function (event) { handleKeydown(state, event); };
    state.backdrop = function (event) {
      if (event.target === state.root && state.options.closeOnBackdrop !== false) {
        requestClose(state, "backdrop", event);
      }
    };
    active = state;

    sheetRoot.classList.add("athlevo-sheet-overlay", "athlevo-sheet-mounted");
    sheet.classList.add("athlevo-sheet-material");
    sheetRoot.setAttribute("aria-hidden", "false");
    if (!sheet.hasAttribute("tabindex")) sheet.setAttribute("tabindex", "-1");
    rememberAndInertBackground(state);
    lockScroll(state);
    sheetRoot.addEventListener("click", state.backdrop);
    document.addEventListener("keydown", state.keydown, true);
    installDrag(state);
    runAnimation(state, true);

    var focusSequence = state.motionSequence;
    root.setTimeout(function () {
      if (active !== state || state.phase === "closing" || state.motionSequence !== focusSequence) return;
      var target = resolveElement(state.options.initialFocus, state.sheet) ||
        focusableElements(state.sheet)[0] || state.sheet;
      if (target && typeof target.focus === "function") {
        try { target.focus({ preventScroll: true }); } catch (error) { target.focus(); }
      }
    }, 0);
    return state;
  }

  function close(sheetRoot, options) {
    sheetRoot = resolveElement(sheetRoot, document);
    if (!active || active.root !== sheetRoot || active.phase === "closing") return false;
    options = options || {};
    active.closeOptions = options;
    if (options.immediate === true || reducedMotion()) {
      active.phase = "closing";
      finishClose(active);
      return true;
    }
    if (active.dragOffset > 0) {
      runDragClose(active);
      return true;
    }
    if (active.phase === "opening") reverseAnimation(active, "closing");
    else {
      active.phase = "closing";
      active.root.classList.remove("athlevo-sheet-open");
      runAnimation(active, false);
    }
    return true;
  }

  root.AthlevoSheet = {
    open: open,
    close: close,
    phase: phaseFor,
    isOpen: function (sheetRoot) {
      var phase = phaseFor(resolveElement(sheetRoot, document));
      return phase === "opening" || phase === "open" || phase === "closing";
    },
    activeRoot: function () { return active ? active.root : null; }
  };
})(window);
