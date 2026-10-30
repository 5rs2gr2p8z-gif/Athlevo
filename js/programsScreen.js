/*
 * Athlevo Programs (in-app).
 *
 * The coaching offer, rebuilt inside the app from the same catalog that powers
 * programs.athlevo.org (js/storeCatalog.js): programs and prices, what is
 * included, athlete feedback, the coaches, and the FAQs. It is shown once
 * right after sign-up and stays reachable from the Coach tab and Settings.
 *
 * Nothing here opens a browser except the Sign Up button, which starts the
 * same PayMongo hosted checkout the website uses. That is the only hand-off:
 * payment cannot happen inside the app shell.
 *
 * Text is always written with textContent; the catalog is data, never markup.
 */
(function (root) {
  "use strict";

  var SCREEN_ID = "screen-programs";
  var SEEN_KEY = "athlevo_programs_seen:";
  var discount = { typed: "", code: "", message: "", tone: "", busy: false };
  var codeViews = [];
  var codeSeq = 0;
  var mode = "browse"; // "browse" (opened from the app) | "welcome" (after sign-up)
  var returnScreen = "screen-today";
  var afterWelcome = null;
  var prevTabbarDisplay = "";

  function catalog() { return root.AthlevoStoreCatalog || null; }

  // The catalog is the same data module the programs site uses. It is only
  // needed here, so it is loaded the first time Programs opens.
  var catalogLoading = null;
  function withCatalog(done) {
    if (catalog() || !root.document || !root.document.head) { done(); return; }
    if (!catalogLoading) {
      catalogLoading = new Promise(function (resolve) {
        var tag = root.document.createElement("script");
        tag.src = "js/storeCatalog.js?v=1";
        tag.onload = resolve;
        tag.onerror = resolve;
        root.document.head.appendChild(tag);
      });
    }
    catalogLoading.then(done);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function photoSrc(photo) {
    if (!photo || !photo.src) return "";
    return String(photo.src).replace(/^\//, "");
  }

  function photoEl(photo, cls) {
    var src = photoSrc(photo);
    if (!src) return null;
    var img = el("img", cls);
    img.src = src;
    img.alt = photo.alt || "";
    img.loading = "lazy";
    img.decoding = "async";
    if (photo.focus) img.style.objectPosition = photo.focus;
    return img;
  }

  function formatPeso(cents) {
    var pesos = Number(cents) / 100;
    return "₱" + pesos.toLocaleString("en-US", {
      minimumFractionDigits: Number(cents) % 100 ? 2 : 0, maximumFractionDigits: 2
    });
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        return { ok: response.ok, status: response.status, body: body || {} };
      });
    });
  }

  /* ───────────── seen-once bookkeeping ───────────── */

  function seenKey(userId) { return SEEN_KEY + String(userId || ""); }

  function hasSeen(userId) {
    if (!userId) return true;
    try { return localStorage.getItem(seenKey(userId)) === "1"; } catch (e) { return false; }
  }

  function markSeen(userId) {
    if (!userId) return;
    try { localStorage.setItem(seenKey(userId), "1"); } catch (e) {}
  }

  /* ───────────── discount code (same contract as the website) ───────────── */

  function renderDiscount() {
    codeViews.forEach(function (view) {
      view.note.textContent = discount.message;
      view.note.className = "prg-code-status" + (discount.tone ? " is-" + discount.tone : "");
      if (view.input.value !== discount.typed) view.input.value = discount.typed;
      view.apply.disabled = discount.busy;
    });
  }

  function checkCode(cfg, text) {
    var code = String(text || "").trim();
    if (!code) {
      discount.code = "";
      discount.message = "Enter your code.";
      discount.tone = "error";
      renderDiscount();
      return Promise.resolve({ ok: false, message: discount.message });
    }
    discount.busy = true;
    discount.message = "Checking your code…";
    discount.tone = "";
    renderDiscount();
    function done(ok, message, tone) {
      discount.busy = false;
      discount.message = message;
      discount.tone = tone;
      if (!ok) discount.code = "";
      renderDiscount();
      return { ok: ok, message: message };
    }
    return postJson(cfg.checkoutEndpoint, { code: code, check: true }).then(function (res) {
      var body = res.body || {};
      if (res.ok && body.valid === true && Number(body.price_cents) > 0) {
        discount.code = code;
        return done(true, "Code applied: " + Number(body.percent_off) + "% off. You’ll pay " +
          formatPeso(body.price_cents) + ".", "ok");
      }
      if (res.status === 400) return done(false, "That code isn’t valid.", "error");
      if (res.status === 429) return done(false, "Too many tries. Please wait a few minutes and try again.", "error");
      if (res.status === 503) return done(false, "Discount codes aren’t available right now. You can still sign up at the full price.", "error");
      return done(false, "We couldn’t check that code. Please try again.", "error");
    }).catch(function () {
      return done(false, "We couldn’t check that code. Check your connection and try again.", "error");
    });
  }

  function codeForCheckout(cfg) {
    var typed = discount.typed.trim();
    if (!typed) return Promise.resolve({ ok: true, code: "" });
    if (discount.code && discount.code === typed) return Promise.resolve({ ok: true, code: discount.code });
    return checkCode(cfg, typed).then(function (result) {
      return result.ok
        ? { ok: true, code: discount.code }
        : { ok: false, message: result.message + " Clear the box to sign up at the full price." };
    });
  }

  function codeControl(cfg) {
    var box = el("div", "prg-code");
    var toggle = el("button", "prg-code-toggle", "Have a discount code?");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    var form = el("div", "prg-code-form");
    form.hidden = true;
    codeSeq += 1;
    var id = "prg-code-" + codeSeq;
    var label = el("label", "prg-code-label", "Discount code");
    label.setAttribute("for", id);
    var input = el("input", "prg-code-input");
    input.type = "text";
    input.id = id;
    input.name = "discount-code";
    input.placeholder = "Enter your code";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "characters");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("maxlength", "24");
    var apply = el("button", "prg-btn prg-btn-ink prg-code-apply", "Apply");
    apply.type = "button";
    var note = el("p", "prg-code-status");
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    var row = el("div", "prg-code-row");
    row.appendChild(input);
    row.appendChild(apply);
    form.appendChild(label);
    form.appendChild(row);
    box.appendChild(toggle);
    box.appendChild(form);
    box.appendChild(note);
    codeViews.push({ input: input, apply: apply, note: note, form: form, toggle: toggle });
    toggle.addEventListener("click", function () {
      codeViews.forEach(function (v) { v.form.hidden = false; v.toggle.setAttribute("aria-expanded", "true"); });
      input.focus();
    });
    input.addEventListener("input", function () {
      discount.typed = input.value;
      if (discount.code && discount.code !== input.value.trim()) discount.code = "";
      discount.message = "";
      discount.tone = "";
      renderDiscount();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        if (!discount.busy) checkCode(cfg, discount.typed);
      }
    });
    apply.addEventListener("click", function () {
      if (!discount.busy) checkCode(cfg, discount.typed);
    });
    return box;
  }

  /* ───────────── checkout hand-off (the only external step) ───────────── */

  function openCheckout(url) {
    if (root.AthlevoRuntime && typeof root.AthlevoRuntime.openExternal === "function") {
      return root.AthlevoRuntime.openExternal(url);
    }
    root.open(url, "_blank", "noopener");
    return Promise.resolve({ ok: true });
  }

  function startCheckout(button, status, cfg) {
    if (button.disabled) return;
    var label = button.textContent;
    function reset(message) {
      button.disabled = false;
      button.textContent = label;
      button.removeAttribute("aria-busy");
      status.textContent = message || "";
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Starting checkout…";
    status.textContent = "";
    codeForCheckout(cfg).then(function (chosen) {
      if (!chosen.ok) { reset(chosen.message); return null; }
      return postJson(cfg.checkoutEndpoint, chosen.code ? { code: chosen.code } : {}).then(function (res) {
        var target = res.body && res.body.checkout_url;
        if (res.ok && typeof target === "string" && /^https:\/\//i.test(target)) {
          return openCheckout(target).then(function (opened) {
            if (opened && opened.ok === false) { reset("We could not open checkout. Please try again."); return; }
            reset("Secure checkout opened. Come back to Athlevo when you are done.");
          });
        }
        if (res.status === 400 && res.body && res.body.error === "invalid_code") {
          discount.code = "";
          discount.message = "That code isn’t valid.";
          discount.tone = "error";
          renderDiscount();
          reset("That code isn’t valid. Clear the box to sign up at the full price.");
        } else if (res.status === 429) reset("Too many attempts. Please wait a few minutes and try again.");
        else if (res.status === 503) reset("Sign-up is not open yet. Please check back soon.");
        else reset("We could not start checkout. Please try again.");
      });
    }).catch(function () {
      reset("We could not start checkout. Check your connection and try again.");
    });
  }

  /* ───────────── sections ───────────── */

  function list(items, cls) {
    var ul = el("ul", cls || "prg-list");
    (items || []).forEach(function (text) { ul.appendChild(el("li", null, text)); });
    return ul;
  }

  function offerCard(product) {
    var page = product.page;
    var card = el("article", "prg-card");
    card.setAttribute("data-offer", product.slug);
    var hero = photoEl(product.hero, "prg-card-photo");
    if (hero) card.appendChild(hero);
    var body = el("div", "prg-card-body");
    body.appendChild(el("h3", "prg-card-name", product.name));
    var price = el("p", "prg-price");
    price.appendChild(el("span", "prg-price-amount", page.price.amount));
    price.appendChild(el("span", "prg-price-period", page.price.period));
    body.appendChild(price);
    body.appendChild(el("p", "prg-card-desc", page.description));
    if (page.overview && page.overview.includes) {
      body.appendChild(el("p", "prg-sub", page.overview.includesTitle || "What is included"));
      body.appendChild(list(page.overview.includes));
      if (page.overview.note) body.appendChild(el("p", "prg-note", page.overview.note));
    }
    if (page.getStarted && page.getStarted.steps) {
      body.appendChild(el("p", "prg-sub", "How it works"));
      var ol = el("ol", "prg-list prg-how");
      page.getStarted.steps.forEach(function (text) { ol.appendChild(el("li", null, text)); });
      body.appendChild(ol);
    }
    var cfg = page.signUp;
    if (cfg && cfg.open === true) {
      var wrap = el("div", "prg-signup");
      var button = el("button", "prg-btn prg-btn-red prg-btn-lg", cfg.label || "Sign Up");
      button.type = "button";
      var status = el("p", "prg-signup-status");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      button.addEventListener("click", function () { startCheckout(button, status, cfg); });
      wrap.appendChild(button);
      if (cfg.takesCodes !== false) wrap.appendChild(codeControl(cfg));
      wrap.appendChild(status);
      var fine = el("div", "prg-fine");
      if (cfg.payment) fine.appendChild(el("p", null, cfg.payment));
      if (cfg.renewal) fine.appendChild(el("p", null, cfg.renewal));
      if (cfg.terms) fine.appendChild(el("p", null, cfg.terms));
      wrap.appendChild(fine);
      body.appendChild(wrap);
    } else {
      body.appendChild(el("p", "prg-soon", "Not open for sign-up yet."));
    }
    card.appendChild(body);
    return card;
  }

  function comingSoonRow(product) {
    var row = el("div", "prg-soon-row");
    row.appendChild(el("b", null, product.name));
    row.appendChild(el("span", null, "Not available yet"));
    return row;
  }

  function feedbackSection(cat) {
    var source = null;
    for (var i = 0; i < cat.products.length; i += 1) {
      var page = cat.products[i].page;
      if (page && page.athleteFeedback) { source = page.athleteFeedback; break; }
    }
    if (!source || !source.items || !source.items.length) return null;
    var section = el("section", "prg-section");
    section.appendChild(el("h2", "prg-h2", "From Athlevo athletes"));
    source.items.forEach(function (item) {
      var q = el("figure", "prg-quote");
      q.appendChild(el("blockquote", null, item.quote));
      q.appendChild(el("figcaption", null, item.name + " · " + item.context));
      section.appendChild(q);
    });
    return section;
  }

  function coachesSection(cat) {
    if (!cat.coaches || !cat.coaches.length) return null;
    var section = el("section", "prg-section");
    section.appendChild(el("h2", "prg-h2", "Meet the coaches"));
    cat.coaches.forEach(function (coach) {
      var card = el("article", "prg-coach");
      var img = photoEl(coach.photo, "prg-coach-photo");
      if (img) card.appendChild(img);
      var body = el("div", "prg-coach-body");
      body.appendChild(el("h3", "prg-coach-name", coach.name));
      body.appendChild(el("p", "prg-coach-role", coach.role));
      if (coach.intro) body.appendChild(el("p", "prg-coach-intro", coach.intro));
      if (coach.certifications && coach.certifications.length) {
        body.appendChild(el("p", "prg-sub", coach.credentialsLabel || "Certified in"));
        body.appendChild(list(coach.certifications));
      }
      card.appendChild(body);
      section.appendChild(card);
    });
    return section;
  }

  function faqSection(cat) {
    var faqs = typeof cat.getHubFaqs === "function" ? cat.getHubFaqs() : (cat.faqs || []);
    if (!faqs.length) return null;
    var section = el("section", "prg-section");
    section.appendChild(el("h2", "prg-h2", "Questions"));
    faqs.forEach(function (item) {
      var d = el("details", "prg-faq");
      d.appendChild(el("summary", null, item.question));
      d.appendChild(el("p", null, item.answer));
      section.appendChild(d);
    });
    return section;
  }

  /* ───────────── render + navigation ───────────── */

  function render() {
    var host = document.getElementById("programsRoot");
    if (!host) return;
    var cat = catalog();
    host.textContent = "";
    codeViews = [];
    discount = { typed: "", code: "", message: "", tone: "", busy: false };
    if (!cat) {
      host.appendChild(el("p", "prg-note", "Programs are unavailable right now. Please try again."));
      return;
    }
    var head = el("header", "prg-head");
    head.appendChild(el("p", "prg-eyebrow", "Athlevo Coaching"));
    head.appendChild(el("h1", "prg-h1", mode === "welcome" ? "Welcome. Pick how you want to train." : "Athlevo programs"));
    head.appendChild(el("p", "prg-lede", cat.intro || ""));
    host.appendChild(head);

    var offers = el("section", "prg-section");
    var unavailable = [];
    cat.products.forEach(function (product) {
      if (product.page) offers.appendChild(offerCard(product));
      else unavailable.push(product);
    });
    unavailable.forEach(function (product) { offers.appendChild(comingSoonRow(product)); });
    host.appendChild(offers);

    [feedbackSection(cat), coachesSection(cat), faqSection(cat)].forEach(function (section) {
      if (section) host.appendChild(section);
    });

    if (mode === "welcome") {
      var foot = el("div", "prg-foot");
      var go = el("button", "prg-btn prg-btn-ink prg-btn-lg", "Continue to set up my account");
      go.type = "button";
      go.setAttribute("data-programs-continue", "");
      go.addEventListener("click", finishWelcome);
      foot.appendChild(go);
      foot.appendChild(el("p", "prg-note", "You can see these programs again any time from the Coach tab or Settings."));
      host.appendChild(foot);
    }
  }

  function applyChrome() {
    var back = document.getElementById("programsBack");
    var skip = document.getElementById("programsSkip");
    if (back) back.hidden = mode === "welcome";
    if (skip) skip.hidden = mode !== "welcome";
  }

  function showScreenSafe() {
    if (typeof root.showScreen === "function") root.showScreen(SCREEN_ID);
    var tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "none";
    var screen = document.getElementById(SCREEN_ID);
    if (screen) screen.scrollTop = 0;
    try { root.scrollTo(0, 0); } catch (e) {}
  }

  /** Right after sign-up: show once, before onboarding. */
  function openWelcome(userId, onDone) {
    mode = "welcome";
    afterWelcome = { userId: userId, onDone: onDone };
    applyChrome();
    showScreenSafe();
    withCatalog(render);
  }

  function finishWelcome() {
    var pending = afterWelcome;
    afterWelcome = null;
    mode = "browse";
    if (pending && pending.userId) markSeen(pending.userId);
    var tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = "";
    if (pending && typeof pending.onDone === "function") pending.onDone();
  }

  /** From Coach tab / Settings: browse, then Back returns to where it came from. */
  function open(fromScreenId) {
    if (mode === "welcome") return;
    var active = document.querySelector(".screen.active");
    returnScreen = fromScreenId || (active && active.id !== SCREEN_ID ? active.id : "screen-today");
    var bar = document.getElementById("tabbar");
    prevTabbarDisplay = bar ? bar.style.display : "";
    mode = "browse";
    applyChrome();
    showScreenSafe();
    withCatalog(render);
  }

  function close() {
    if (mode === "welcome") return finishWelcome();
    var tabbar = document.getElementById("tabbar");
    if (tabbar) tabbar.style.display = prevTabbarDisplay;
    if (typeof root.showScreen === "function") root.showScreen(returnScreen || "screen-today");
  }

  /** Should this athlete see the post-signup Programs screen now? */
  function shouldShowAfterSignup(userId, profile) {
    if (!userId) return false;
    if (profile && (profile.role === "coach" || profile.role === "admin")) return false;
    if (profile && profile.onboarding_complete === true) return false;
    return !hasSeen(userId);
  }

  root.AthlevoPrograms = {
    SCREEN_ID: SCREEN_ID,
    open: open,
    close: close,
    openWelcome: openWelcome,
    shouldShowAfterSignup: shouldShowAfterSignup,
    hasSeen: hasSeen,
    markSeen: markSeen,
    _render: render
  };
})(typeof window !== "undefined" ? window : globalThis);
