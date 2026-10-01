/*
 * Athlevo program storefront.
 * Renders /store and /store/:slug from AthlevoStoreCatalog.
 * No purchasing, payments, or account collection.
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
    card: "(min-width: 981px) 33vw, (min-width: 641px) 50vw, 100vw",
    pdp: "(min-width: 981px) min(720px, 58vw), 92vw"
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

  function parseRoute() {
    var url = new URL(global.location.href);
    var path = String(url.pathname || "/").replace(/\/+$/, "") || "/";
    var params = url.searchParams;
    if (path === "/store.html") {
      var product = params.get("product");
      if (product) return { view: "product", slug: product };
      return { view: "catalog", hash: url.hash };
    }
    if (path === "/store" || path === "") {
      return { view: "catalog", hash: url.hash };
    }
    var match = path.match(/^\/store\/([^/]+)$/);
    if (match) return { view: "product", slug: decodeURIComponent(match[1]) };
    return { view: "missing" };
  }

  function productHref(slug) {
    return "/store/" + encodeURIComponent(slug);
  }

  function setTitle(title) {
    document.title = title;
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
      var current = view === "catalog" && (href === "/store#programs" || href === "/store");
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
    a.appendChild($("p", "product-meta", product.durationLabel + " · " + product.intendedRunner));
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

  function renderCatalog(route) {
    setTitle("Programs — Athlevo");
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

    var faq = $("section", "section");
    faq.id = "faq";
    faq.setAttribute("aria-labelledby", "faq-heading");
    var fWrap = $("div", "wrap");
    fWrap.appendChild($("h2", "section-title", "FAQ")).id = "faq-heading";
    renderFaqs(fWrap, catalog.faqs);
    faq.appendChild(fWrap);
    root.appendChild(faq);
  }

  function renderProduct(slug) {
    var product = catalog.getProduct(slug);
    if (!product) {
      renderMissing();
      return;
    }
    setTitle(product.name + " — Athlevo");
    markNav("product");
    root.replaceChildren();

    var page = $("article", "pdp wrap");
    var hero = $("div", "pdp-hero");
    var figure = $("figure");
    figure.appendChild(picture(product.hero, { eager: true, sizes: SIZES.pdp }));
    var copy = document.createElement("div");
    var crumb = $("p", "crumb");
    var back = $("a", "", "Programs");
    back.href = "/store#programs";
    back.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate("/store#programs");
    });
    crumb.appendChild(back);
    crumb.appendChild(document.createTextNode(" / " + catalog.getCollection(product.collection).name));
    copy.appendChild(crumb);
    copy.appendChild($("h1", "", product.name));
    copy.appendChild($("p", "pdp-lede", product.summary));
    copy.appendChild($("p", "", product.description));

    var facts = $("dl", "pdp-facts");
    function fact(label, value) {
      var row = $("div");
      row.appendChild($("dt", "", label));
      row.appendChild($("dd", "", value));
      facts.appendChild(row);
    }
    fact("Duration", product.durationLabel);
    fact("Collection", catalog.getCollection(product.collection).name);
    fact("Intended runner", product.intendedRunner);
    copy.appendChild(facts);

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
      var section = document.createElement("section");
      section.appendChild($("h2", "", title));
      section.appendChild(listItems(items));
      return section;
    }
    grid.appendChild(block("Who it is for", product.whoFor));
    grid.appendChild(block("Starting fitness", product.startingFitness));
    grid.appendChild(block("What you receive", product.receives));
    grid.appendChild(block("Intake and delivery", product.intakeAndDelivery));
    page.appendChild(grid);

    var faq = $("section");
    faq.style.marginTop = "64px";
    faq.appendChild($("h2", "", "FAQ"));
    renderFaqs(faq, catalog.faqs);
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

    root.appendChild(page);
  }

  function renderMissing() {
    setTitle("Program not found — Athlevo");
    root.replaceChildren();
    var box = $("div", "missing");
    box.appendChild($("h1", "", "This program is not in the catalog."));
    var link = $("a", "btn btn-ink", "Back to programs");
    link.href = "/store";
    link.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      navigate("/store");
    });
    box.appendChild(link);
    root.appendChild(box);
  }

  function applyHash(hash) {
    if (!hash || hash === "#") return;
    var id = hash.replace(/^#/, "");
    var target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
    else window.scrollTo(0, 0);
  }

  function render() {
    closeMenu();
    var route = parseRoute();
    if (route.view === "product") {
    renderProduct(route.slug);
    requestAnimationFrame(function () { window.scrollTo(0, 0); });
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
      if (!href.startsWith("/store")) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(href);
    });
  });

  global.addEventListener("popstate", render);
  render();

  global.AthlevoStorefront = {
    parseRoute: parseRoute,
    navigate: navigate,
    render: render
  };
})(window);
