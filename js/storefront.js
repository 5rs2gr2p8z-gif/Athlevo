/*
 * Athlevo program storefront.
 * Renders /programs and /programs/:slug from AthlevoStoreCatalog.
 * The only purchase flow is the sign-up on the Athlevo Plan and Athlevo Coaching
 * pages (page.signUp), which stays closed per offer until signUp.open is true. It
 * starts a hosted PayMongo checkout through
 * Athlevo's own API. This file never handles payment details, prices or payment
 * state: "paid" is whatever the server reports from PayMongo's signed webhook.
 */
(function storefrontModule(global) {
  "use strict";

  var catalog = global.AthlevoStoreCatalog;
  var root = document.getElementById("main");
  if (!catalog || !root) return;

  function $(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  var SIZES = {
    hero: "100vw",
    card: "(min-width: 981px) 400px, (min-width: 641px) 50vw, 100vw",
    pdp: "(min-width: 981px) min(720px, 58vw), 92vw",
    coach: "(min-width: 981px) 360px, 92vw",
    coachCard: "(min-width: 641px) 200px, 92vw"
  };

  function picture(photo, opts) {
    opts = opts || {};
    var pic = document.createElement("picture");
    var sizes = opts.sizes || "100vw";
    function addSource(type, variants) {
      if (!variants || !variants.length) return;
      var source = document.createElement("source");
      source.type = type;
      source.sizes = sizes;
      source.srcset = variants.map(function (item) {
        return item.src + " " + item.w + "w";
      }).join(", ");
      pic.appendChild(source);
    }
    addSource("image/avif", photo.avif);
    addSource("image/webp", photo.webp);
    var node = document.createElement("img");
    node.src = photo.src;
    node.alt = photo.alt || "";
    if (photo.focus) node.style.objectPosition = photo.focus;
    if (photo.width) node.width = photo.width;
    if (photo.height) node.height = photo.height;
    node.decoding = "async";
    if (opts.eager) {
      node.loading = "eager";
      node.fetchPriority = "high";
    } else {
      node.loading = "lazy";
    }
    pic.appendChild(node);
    return pic;
  }

  // PL = Athlevo Plan, CO = Athlevo Coaching (lib/server/planSignup.js builds these).
  var SIGNUP_REF = /^ATH-(PL|CO)-[0-9A-F]{8,16}-[0-9A-F]{24}$/i;

  // The public path is /programs. /store was the first path, and Vercel redirects it
  // permanently (vercel.json); the client also accepts it, and rewrites the address bar
  // to /programs, for a page that was cached or opened before the redirect applied.
  var BASE = "/programs";

  function parseRoute() {
    var url = new URL(global.location.href);
    var path = String(url.pathname || "/").replace(/\/+$/, "") || "/";
    var params = url.searchParams;
    if (path === "/store.html") {
      var product = params.get("product");
      if (product) return { view: "product", slug: product };
      return { view: "catalog", hash: url.hash };
    }
    if (path === BASE || path === "/store" || path === "") {
      return { view: "catalog", hash: url.hash };
    }
    var match = path.match(/^\/(?:programs|store)\/([^/]+)$/);
    if (match) {
      var slug = decodeURIComponent(match[1]);
      var ref = params.get("ref");
      if (params.get("payment") === "success" && ref && SIGNUP_REF.test(ref)) {
        return { view: "confirmation", slug: slug, ref: ref.toUpperCase() };
      }
      return { view: "product", slug: slug };
    }
    return { view: "missing" };
  }

  function productHref(slug) {
    return BASE + "/" + encodeURIComponent(slug);
  }

  function setTitle(title) {
    document.title = title;
  }

  function setMeta(selector, attr, value) {
    var el = document.querySelector(selector);
    if (el) el.setAttribute(attr, value);
  }

  function setRobots(value) {
    var el = document.querySelector('meta[name="robots"]');
    if (!value) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute("name", "robots");
      document.head.appendChild(el);
    }
    el.setAttribute("content", value);
  }

  // Mirrors the static <head> that scripts/build-store-pages.mjs writes for each route.
  function applySeo(meta) {
    if (!meta) return;
    setTitle(meta.title);
    setMeta('meta[name="description"]', "content", meta.description);
    setMeta('link[rel="canonical"]', "href", meta.url);
    setMeta('meta[property="og:title"]', "content", meta.title);
    setMeta('meta[property="og:description"]', "content", meta.description);
    setMeta('meta[property="og:url"]', "content", meta.url);
    setRobots(meta.noindex ? "noindex, nofollow" : "");
  }

  function closeMenu() {
    var links = document.getElementById("storeNavLinks");
    var toggle = document.getElementById("storeNavToggle");
    if (links) links.classList.remove("is-open");
    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Menu");
    }
  }

  function markNav(view) {
    var links = document.querySelectorAll(".nav-links a");
    links.forEach(function (link) {
      var href = link.getAttribute("href") || "";
      var current = view === "catalog" && (href === BASE + "#programs" || href === BASE);
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function listItems(items) {
    var ul = document.createElement("ul");
    items.forEach(function (item) {
      ul.appendChild($("li", "", item));
    });
    return ul;
  }

  function bindNav(a, href) {
    a.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate(href);
    });
  }

  function renderProgramCard(product) {
    var a = $("a", "program-card");
    a.href = productHref(product.slug);
    a.appendChild(picture(product.hero, { sizes: SIZES.card }));
    var copy = $("div", "program-card-copy");
    copy.appendChild($("h3", "", product.name));
    a.appendChild(copy);
    bindNav(a, productHref(product.slug));
    return a;
  }

  function renderProductCard(product, className) {
    var a = $("a", className || "related-card");
    a.href = productHref(product.slug);
    var figure = $("figure");
    figure.appendChild(picture(product.hero, { sizes: SIZES.card }));
    a.appendChild(figure);
    a.appendChild($("h3", "", product.name));
    a.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate(productHref(product.slug));
    });
    return a;
  }

  function renderFaqs(target, items) {
    var wrap = $("div", "faq");
    items.forEach(function (item, index) {
      var details = $("details");
      if (index === 0) details.open = true;
      var summary = $("summary", "", item.question);
      details.appendChild(summary);
      details.appendChild($("p", "", item.answer));
      wrap.appendChild(details);
    });
    target.appendChild(wrap);
  }

  // Credentials, when the coach record has them. Shared by the
  // catalog's coach cards and the Plan page's "Meet the Coach" block.
  function appendCoachCredentials(body, coach) {
    if (coach.certifications && coach.certifications.length) {
      var creds = $("div", "coach-card-creds");
      creds.appendChild($("p", "coach-card-creds-label", coach.credentialsLabel || "Certified in"));
      creds.appendChild(listItems(coach.certifications));
      body.appendChild(creds);
    }
  }

  function renderCoachCard(coach) {
    var card = $("article", "coach-card");
    var figure = $("figure", "coach-card-photo");
    figure.appendChild(picture(coach.photo, { sizes: SIZES.coachCard }));
    var body = $("div", "coach-card-body");
    body.appendChild($("h3", "coach-card-name", coach.name));
    body.appendChild($("p", "coach-card-role", coach.role));
    body.appendChild($("p", "", coach.intro));
    appendCoachCredentials(body, coach);
    card.appendChild(figure);
    card.appendChild(body);
    return card;
  }

  function renderCatalog(route) {
    applySeo(catalog.seo());
    markNav("catalog");
    root.replaceChildren();

    var hero = $("section", "hero");
    hero.appendChild(picture(catalog.hero.image, { eager: true, sizes: SIZES.hero }));
    root.appendChild(hero);

    var intro = $("section", "intro");
    var iWrap = $("div", "wrap");
    iWrap.appendChild($("h1", "", catalog.hero.headline));
    iWrap.appendChild($("p", "intro-text", catalog.intro));
    intro.appendChild(iWrap);
    root.appendChild(intro);

    var programs = $("section", "programs");
    programs.id = "programs";
    programs.setAttribute("aria-labelledby", "programs-heading");
    var pWrap = $("div", "wrap");
    pWrap.appendChild($("h2", "section-title", "Programs")).id = "programs-heading";
    var cards = $("div", "program-grid");
    catalog.products.forEach(function (product) {
      cards.appendChild(renderProgramCard(product));
    });
    pWrap.appendChild(cards);
    programs.appendChild(pWrap);
    root.appendChild(programs);

    if (catalog.coaches && catalog.coaches.length) {
      var coaches = $("section", "coaches");
      coaches.id = "coaches";
      coaches.setAttribute("aria-labelledby", "coaches-heading");
      var cWrap = $("div", "wrap");
      cWrap.appendChild($("h2", "section-title", "Meet the coaches")).id = "coaches-heading";
      var coachList = $("div", "coach-list");
      catalog.coaches.forEach(function (coach) {
        coachList.appendChild(renderCoachCard(coach));
      });
      cWrap.appendChild(coachList);
      coaches.appendChild(cWrap);
      root.appendChild(coaches);
    }

    var faq = $("section", "section");
    faq.id = "faq";
    faq.setAttribute("aria-labelledby", "faq-heading");
    var fWrap = $("div", "wrap");
    fWrap.appendChild($("h2", "section-title", "FAQ")).id = "faq-heading";
    renderFaqs(fWrap, catalog.getFaqs());
    faq.appendChild(fWrap);
    root.appendChild(faq);
  }

  function renderProduct(slug) {
    var canonical = catalog.resolveSlug(slug);
    var product = catalog.getProduct(canonical);
    if (!product) {
      renderMissing();
      return;
    }
    if (canonical !== slug) {
      history.replaceState({ athlevoStore: true }, "", productHref(canonical) + (global.location.hash || ""));
    }
    applySeo(catalog.seo(product.slug));
    markNav("product");
    root.replaceChildren();

    if (product.page) {
      root.appendChild(renderOfferPage(product));
      return;
    }

    var page = $("article", "pdp wrap");
    var hero = $("div", "pdp-hero");
    var figure = $("figure");
    figure.appendChild(picture(product.hero, { eager: true, sizes: SIZES.pdp }));
    var copy = document.createElement("div");
    var crumb = $("p", "crumb");
    var back = $("a", "", "Programs");
    back.href = BASE + "#programs";
    back.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate(BASE + "#programs");
    });
    crumb.appendChild(back);
    copy.appendChild(crumb);
    copy.appendChild($("h1", "", product.name));
    if (product.summary) copy.appendChild($("p", "pdp-lede", product.summary));
    if (product.description) copy.appendChild($("p", "", product.description));

    var facts = $("dl", "pdp-facts");
    function fact(label, value) {
      if (!value) return;
      var row = $("div");
      row.appendChild($("dt", "", label));
      row.appendChild($("dd", "", value));
      facts.appendChild(row);
    }
    fact("Duration", product.durationLabel);
    fact("Intended runner", product.intendedRunner);
    if (facts.children.length) copy.appendChild(facts);

    var buy = $("div", "pdp-buy");
    var btn = $("a", "btn btn-ink", "Purchasing not available");
    btn.setAttribute("aria-disabled", "true");
    btn.href = "#";
    btn.addEventListener("click", function (event) { event.preventDefault(); });
    buy.appendChild(btn);
    copy.appendChild(buy);

    hero.appendChild(figure);
    hero.appendChild(copy);
    page.appendChild(hero);

    var grid = $("div", "pdp-grid");
    function block(title, items) {
      if (!items || !items.length) return;
      var section = document.createElement("section");
      section.appendChild($("h2", "", title));
      section.appendChild(listItems(items));
      grid.appendChild(section);
    }
    block("Who it is for", product.whoFor);
    block("Starting fitness", product.startingFitness);
    block("What you receive", product.receives);
    block("Intake and delivery", product.intakeAndDelivery);
    if (grid.children.length) page.appendChild(grid);

    appendFaqAndRelated(page, product);

    root.appendChild(page);
  }

  function appendFaqAndRelated(page, product) {
    var faq = $("section");
    faq.style.marginTop = "64px";
    faq.appendChild($("h2", "", "FAQ"));
    renderFaqs(faq, catalog.getFaqs());
    page.appendChild(faq);

    var related = catalog.relatedProducts(product);
    if (related.length) {
      var rel = $("section");
      rel.style.marginTop = "64px";
      rel.appendChild($("h2", "", "Related programs"));
      var relGrid = $("div", "related-grid");
      related.forEach(function (item) {
        relGrid.appendChild(renderProductCard(item, "related-card"));
      });
      rel.appendChild(relGrid);
      page.appendChild(rel);
    }
  }

  // ---- Built offer page (a product with `page` data: Athlevo Plan and Athlevo Coaching) ----

  function bindAnchor(a, id) {
    a.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      var target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "auto", block: "start" });
      target.focus({ preventScroll: true });
      history.replaceState({ athlevoStore: true }, "", global.location.pathname + global.location.search + "#" + id);
    });
  }

  function offerSection(id, title, className) {
    var section = $("section", "offer-section" + (className ? " " + className : ""));
    section.id = id;
    section.tabIndex = -1;
    section.setAttribute("aria-labelledby", id + "-heading");
    var h2 = $("h2", "", title);
    h2.id = id + "-heading";
    section.appendChild(h2);
    return section;
  }

  function offerList(items, className, tag) {
    var ul = $(tag || "ul", className || "offer-list");
    items.forEach(function (item) {
      ul.appendChild($("li", "", item));
    });
    return ul;
  }

  function signUpOpen(data) {
    return !!(data && data.signUp && data.signUp.open === true);
  }

  function offerSignUp(data) {
    if (signUpOpen(data)) return signUpControl(data);
    var a = $("a", "btn btn-red btn-lg", data.cta.label);
    a.href = "#" + data.cta.target;
    bindAnchor(a, data.cta.target);
    return a;
  }

  function renderOfferPage(product) {
    var data = product.page;
    var page = $("article", "pdp pdp-offer wrap");
    if (signUpOpen(data) && new URL(global.location.href).searchParams.get("payment") === "cancelled") {
      var cancelled = $("p", "signup-notice", "Checkout was cancelled and no payment was made.");
      cancelled.setAttribute("role", "status");
      page.appendChild(cancelled);
    }

    // 1. First screen
    var hero = $("div", "pdp-hero pdp-hero--offer");
    var figure = $("figure");
    figure.appendChild(picture(product.hero, { eager: true, sizes: SIZES.pdp }));
    var copy = document.createElement("div");
    copy.className = "offer-first";
    var crumb = $("p", "crumb");
    var back = $("a", "", "Programs");
    back.href = BASE + "#programs";
    bindNav(back, BASE + "#programs");
    crumb.appendChild(back);
    copy.appendChild(crumb);
    copy.appendChild($("h1", "", product.name));
    copy.appendChild($("p", "offer-headline", data.headline));
    copy.appendChild($("p", "offer-description", data.description));
    var price = $("p", "offer-price");
    price.appendChild($("span", "offer-price-amount", data.price.amount));
    price.appendChild($("span", "offer-price-period", data.price.period));
    copy.appendChild(price);
    copy.appendChild(offerSignUp(data));
    copy.appendChild($("p", "offer-supporting", data.supporting));
    hero.appendChild(figure);
    hero.appendChild(copy);
    page.appendChild(hero);

    // 2. Overview
    var overview = offerSection("overview", "Overview");
    overview.appendChild($("p", "", data.overview.intro));
    overview.appendChild($("h3", "offer-subhead", data.overview.includesTitle));
    overview.appendChild(offerList(data.overview.includes));
    overview.appendChild($("p", "offer-note", data.overview.note));
    page.appendChild(overview);

    // 3. Athlete feedback (omitted when there is no approved material)
    var feedback = data.athleteFeedback;
    if (feedback && feedback.items && feedback.items.length) {
      var quotes = offerSection("athlete-feedback", feedback.label);
      var grid = $("div", "offer-quotes");
      feedback.items.forEach(function (item) {
        var fig = $("figure", "offer-quote");
        var bq = document.createElement("blockquote");
        bq.appendChild($("p", "", item.quote));
        fig.appendChild(bq);
        var cap = document.createElement("figcaption");
        cap.appendChild($("strong", "", item.name));
        cap.appendChild($("span", "", item.context));
        fig.appendChild(cap);
        grid.appendChild(fig);
      });
      quotes.appendChild(grid);
      page.appendChild(quotes);
    }

    // 4. Pricing
    var pricing = offerSection("plan-pricing", "Pricing");
    var card = $("div", "offer-pricing-card");
    var cardPrice = $("p", "offer-price");
    cardPrice.appendChild($("span", "offer-price-amount", data.price.amount));
    cardPrice.appendChild($("span", "offer-price-period", data.price.period));
    card.appendChild(cardPrice);
    card.appendChild(offerList(data.pricing.includes));
    card.appendChild($("p", "offer-terms", data.pricing.terms));
    if (signUpOpen(data)) {
      card.appendChild($("p", "signup-note", [data.signUp.payment, data.signUp.renewal, data.signUp.terms].join(" ")));
    }
    card.appendChild(offerSignUp(data));
    pricing.appendChild(card);
    page.appendChild(pricing);

    // 5. Meet the coach (omitted when the offer names no coach)
    if (data.coach) {
      var coach = offerSection("coach", "Meet the Coach", "offer-coach");
      var coachFigure = $("figure", "offer-coach-photo");
      coachFigure.appendChild(picture(data.coach.photo, { sizes: SIZES.coach }));
      var coachCopy = document.createElement("div");
      coachCopy.appendChild($("h3", "offer-coach-name", data.coach.name));
      coachCopy.appendChild($("p", "offer-coach-role", data.coach.role));
      coachCopy.appendChild($("p", "", data.coach.intro));
      appendCoachCredentials(coachCopy, data.coach);
      var coachRow = $("div", "offer-coach-row");
      coachRow.appendChild(coachFigure);
      coachRow.appendChild(coachCopy);
      coach.appendChild(coachRow);
      page.appendChild(coach);
    }

    // 6. How to get started
    var start = offerSection("how-to-get-started", "How to Get Started");
    start.appendChild(offerList(data.getStarted.steps, "offer-steps", "ol"));
    if (!signUpOpen(data)) {
      var soon = $("div", "offer-soon");
      soon.appendChild($("strong", "", data.getStarted.notice));
      start.appendChild(soon);
    }
    page.appendChild(start);

    appendFaqAndRelated(page, product);
    return page;
  }

  // ---- Offer sign-up (only reachable when product.page.signUp.open is true) ----

  var POLL_MS = 2500;
  var POLL_MAX = 24;
  var confirmRun = 0;
  var confirmTimer = null;

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

  function signUpControl(data) {
    var cfg = data.signUp;
    var wrap = $("div", "signup");
    var button = $("button", "btn btn-red btn-lg", cfg.label || data.cta.label);
    button.type = "button";
    var status = $("p", "signup-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    button.addEventListener("click", function () {
      startCheckout(button, status, cfg);
    });
    wrap.appendChild(button);
    wrap.appendChild(status);
    return wrap;
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
    button.textContent = "Starting checkout\u2026";
    status.textContent = "";
    postJson(cfg.checkoutEndpoint).then(function (res) {
      var target = res.body && res.body.checkout_url;
      if (res.ok && typeof target === "string" && /^https:\/\//i.test(target)) {
        status.textContent = "Taking you to secure checkout\u2026";
        global.location.assign(target);
        return;
      }
      if (res.status === 429) reset("Too many attempts. Please wait a few minutes and try again.");
      else if (res.status === 503) reset("Sign-up is not open yet. Please check back soon.");
      else reset("We could not start checkout. Please try again.");
    }).catch(function () {
      reset("We could not start checkout. Check your connection and try again.");
    });
  }

  function stopConfirmation() {
    confirmRun += 1;
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
  }

  function secureUrl(value) {
    return typeof value === "string" && /^https:\/\//i.test(value) ? value : null;
  }

  function externalLink(url, label, className) {
    var a = $("a", className, label);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  // Shown after PayMongo returns the buyer. It asks the server whether the signed
  // webhook has recorded the payment, and shows the next steps only once it has.
  function renderConfirmation(product, ref) {
    stopConfirmation();
    var run = confirmRun;
    var cfg = product.page.signUp;
    applySeo({
      title: "Payment confirmation \u2014 Athlevo",
      description: "Confirmation of your " + product.name + " payment.",
      url: catalog.siteUrl + productHref(product.slug),
      noindex: true
    });
    markNav("product");
    root.replaceChildren();
    var page = $("article", "pdp wrap signup-confirm");
    var crumb = $("p", "crumb");
    var back = $("a", "", product.name);
    back.href = productHref(product.slug);
    bindNav(back, productHref(product.slug));
    crumb.appendChild(back);
    page.appendChild(crumb);
    var panel = $("div", "signup-confirm-panel");
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    page.appendChild(panel);
    root.appendChild(page);

    var attempts = 0;
    function show() {
      panel.replaceChildren.apply(panel, arguments);
    }
    function retryButton() {
      var b = $("button", "btn btn-ink", "Check again");
      b.type = "button";
      b.addEventListener("click", function () {
        attempts = 0;
        showChecking();
        check();
      });
      return b;
    }
    function showChecking() {
      show(
        $("h1", "", "Confirming your payment"),
        $("p", "signup-confirm-lede", "This usually takes a few seconds. Please keep this page open.")
      );
    }
    function showPaid(body) {
      var questionnaire = secureUrl(body.questionnaire_url);
      var schedule = secureUrl(body.schedule_url);
      var agreement = secureUrl(body.agreement_url);
      var steps = $("ol", "offer-steps signup-confirm-steps");
      var one = $("li");
      one.appendChild($("strong", "", "Complete the Athlevo questionnaire."));
      one.appendChild($("p", "", "Tell us about your fitness, goals, schedule, and equipment."));
      if (questionnaire) one.appendChild(externalLink(questionnaire, "Open the questionnaire", "btn btn-red"));
      steps.appendChild(one);
      var two = $("li");
      two.appendChild($("strong", "", "Schedule a call."));
      two.appendChild($("p", "", "After you submit the questionnaire, you will be asked to schedule a call."));
      if (schedule) two.appendChild(externalLink(schedule, "Schedule your call", "btn btn-ink"));
      steps.appendChild(two);
      var parts = [
        $("h1", "", "Payment received."),
        $("p", "signup-confirm-lede", "Thank you for signing up for " + product.name + ". Here is what happens next."),
        steps
      ];
      if (agreement) {
        var agree = $("p", "signup-confirm-agreement", "Your agreement: ");
        agree.appendChild(externalLink(agreement, "Read the Athlevo agreement"));
        parts.push(agree);
      }
      parts.push($("p", "offer-supporting", "Keep this page to come back to these steps. PayMongo emails your receipt."));
      show.apply(null, parts);
    }
    function showSlow() {
      show(
        $("h1", "", "We are still confirming your payment"),
        $("p", "signup-confirm-lede", "If you finished paying, it can take a few minutes to show up here. Keep this page open or check again in a moment. PayMongo emails your receipt once the payment goes through."),
        retryButton()
      );
    }
    function showFailed() {
      show(
        $("h1", "", "We could not check your payment right now"),
        $("p", "signup-confirm-lede", "Your payment is not affected. Check again in a moment."),
        retryButton()
      );
    }
    function showRefunded() {
      show(
        $("h1", "", "This payment was refunded"),
        $("p", "signup-confirm-lede", "If you think this is a mistake, please contact Athlevo.")
      );
    }
    function check() {
      if (run !== confirmRun) return;
      attempts += 1;
      postJson(cfg.statusEndpoint, { ref: ref }).then(function (res) {
        if (run !== confirmRun) return;
        if (!res.ok) { showFailed(); return; }
        var state = res.body && res.body.status;
        if (state === "paid") { showPaid(res.body); return; }
        if (state === "refunded") { showRefunded(); return; }
        if (attempts >= POLL_MAX) { showSlow(); return; }
        confirmTimer = setTimeout(check, POLL_MS);
      }).catch(function () {
        if (run === confirmRun) showFailed();
      });
    }
    showChecking();
    check();
  }

  function renderMissing() {
    setTitle("Program not found — Athlevo");
    root.replaceChildren();
    var box = $("div", "missing");
    box.appendChild($("h1", "", "This program is not in the catalog."));
    var link = $("a", "btn btn-ink", "Back to programs");
    link.href = BASE;
    link.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      navigate(BASE);
    });
    box.appendChild(link);
    root.appendChild(box);
  }

  function hashElement(hash) {
    var id = String(hash || "").replace(/^#/, "");
    return id ? document.getElementById(id) : null;
  }

  function applyHash(hash) {
    if (!hash || hash === "#") return;
    var id = hash.replace(/^#/, "");
    var target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
    else window.scrollTo(0, 0);
  }

  // /store/... -> /programs/... in the address bar (same page, nothing reloads).
  function canonicalizeLegacyPath() {
    var loc = global.location;
    var legacy = String(loc.pathname || "").match(/^\/store(\/.*)?$/);
    if (!legacy) return;
    var rest = (legacy[1] || "").replace(/\/+$/, "");
    history.replaceState({ athlevoStore: true }, "", BASE + rest + (loc.search || "") + (loc.hash || ""));
  }

  function renderView() {
    closeMenu();
    canonicalizeLegacyPath();
    stopConfirmation();
    var route = parseRoute();
    if (route.view === "confirmation") {
      var paidFor = catalog.getProduct(catalog.resolveSlug(route.slug));
      if (paidFor && paidFor.page && paidFor.page.signUp) {
        renderConfirmation(paidFor, route.ref);
        window.scrollTo(0, 0);
        return;
      }
      route = { view: "product", slug: route.slug };
    }
    if (route.view === "product") {
    renderProduct(route.slug);
    requestAnimationFrame(function () {
      var hashTarget = hashElement(global.location.hash);
      if (hashTarget) hashTarget.scrollIntoView({ behavior: "auto", block: "start" });
      else window.scrollTo(0, 0);
    });
      return;
    }
    if (route.view === "missing") {
      renderMissing();
      window.scrollTo(0, 0);
      return;
    }
    renderCatalog(route);
    applyHash(route.hash || global.location.hash);
  }

  // ---- Smooth loading as you scroll -------------------------------------------
  // Blocks below the first screen fade and rise into place as they scroll into view, and
  // lazy photos fade in once they have loaded, so the page never pops in all at once.
  // This is an enhancement only: the first screen (hero, headline, intro) is never held
  // back, nothing is hidden until this runs, and a browser without IntersectionObserver, or
  // set to reduced motion, simply shows everything. The prerendered HTML is never touched.
  var REVEAL_SELECTOR = [
    ".section-title", ".program-card", ".coach-card", ".faq",
    ".offer-section", ".pdp-grid > *", ".related-card"
  ].join(", ");
  var revealObserver = null;
  var revealScrollHandler = null;

  function prefersReducedMotion() {
    return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function setupReveal() {
    if (revealObserver) {
      revealObserver.disconnect();
      revealObserver = null;
    }
    if (revealScrollHandler) {
      global.removeEventListener("scroll", revealScrollHandler);
      revealScrollHandler = null;
    }
    if (typeof global.IntersectionObserver !== "function" || prefersReducedMotion()) return;
    // Wait one frame so a scroll the route just made (a #hash, or back to the top) has landed.
    requestAnimationFrame(function () {
      var fold = global.innerHeight || document.documentElement.clientHeight || 0;
      var waiting = [];
      var observer = new global.IntersectionObserver(function (entries) {
        var step = 0;
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          // Blocks that arrive together (a row of cards) come in one after another.
          el.style.transitionDelay = Math.min(step, 4) * 70 + "ms";
          step += 1;
          el.setAttribute("data-reveal", "in");
          observer.unobserve(el);
          global.setTimeout(function () { el.style.transitionDelay = ""; }, 1000);
        });
      }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
      revealObserver = observer;

      root.querySelectorAll(REVEAL_SELECTOR).forEach(function (el) {
        // Already on the first screen (or scrolled past): leave it as it is.
        if (el.getBoundingClientRect().top < fold) return;
        el.setAttribute("data-reveal", "pending");
        observer.observe(el);
        waiting.push(el);
      });

      // A jump (an anchor, the End key, a fast flick) can carry the reader past a block
      // without it ever being on screen. Show those at once, where they are, so scrolling
      // back up never meets an empty gap.
      var sweeping = false;
      revealScrollHandler = function () {
        if (sweeping) return;
        sweeping = true;
        requestAnimationFrame(function () {
          sweeping = false;
          waiting = waiting.filter(function (el) {
            if (el.getAttribute("data-reveal") !== "pending") return false;
            if (el.getBoundingClientRect().bottom > 0) return true;
            el.style.transition = "none";
            el.setAttribute("data-reveal", "in");
            void el.offsetWidth;
            el.style.transition = "";
            observer.unobserve(el);
            return false;
          });
        });
      };
      global.addEventListener("scroll", revealScrollHandler, { passive: true });

      root.querySelectorAll('img[loading="lazy"]').forEach(function (img) {
        if (img.complete && img.naturalWidth > 0) return;
        img.setAttribute("data-img", "loading");
        function shown() { img.setAttribute("data-img", "ready"); }
        img.addEventListener("load", shown, { once: true });
        img.addEventListener("error", shown, { once: true });
      });
    });
  }

  function navigate(href, opts) {
    var next = new URL(href, global.location.origin);
    if (opts && opts.replace) history.replaceState({ athlevoStore: true }, "", next.pathname + next.search + next.hash);
    else history.pushState({ athlevoStore: true }, "", next.pathname + next.search + next.hash);
    render();
  }

  document.getElementById("storeNavToggle").addEventListener("click", function () {
    var links = document.getElementById("storeNavLinks");
    var open = !links.classList.contains("is-open");
    links.classList.toggle("is-open", open);
    this.setAttribute("aria-expanded", String(open));
    this.setAttribute("aria-label", open ? "Close menu" : "Menu");
  });

  document.querySelectorAll(".nav-links a").forEach(function (link) {
    link.addEventListener("click", function (event) {
      var href = link.getAttribute("href") || "";
      if (!href.startsWith(BASE)) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(href);
    });
  });

  // Draws the current route, then sets up the scroll-in effect for what it drew.
  function render() {
    renderView();
    setupReveal();
  }

  global.addEventListener("popstate", render);
  // Back from checkout can restore this page from the browser cache with a
  // disabled button; redraw it fresh.
  global.addEventListener("pageshow", function (event) {
    if (event && event.persisted) render();
  });
  render();

  global.AthlevoStorefront = {
    parseRoute: parseRoute,
    navigate: navigate,
    render: render
  };
})(window);
