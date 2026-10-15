/*
 * Athlevo program storefront catalog.
 *
 * Single editable source for draft programs, storefront copy,
 * and FAQs. Undecided terms (coachSupport) are internal data and must not
 * appear in customer-facing copy. Do not add unapproved prices, promotional markdown, testimonials,
 * results, or outcome promises here.
 *
 * Offer details (summary, description, audience, deliverables, duration) are
 * intentionally absent until approved copy is supplied. The storefront renders
 * those sections only when a product defines them.
 *
 * `coaches` lists the people shown in "Meet the coaches". Add an entry only with a
 * verified name, role, photo, and bio. List certifications only as supplied by the
 * owner, in `certifications`; never add credentials or achievements of your own.
 *
 * Athlevo Plan is the only offer with a built page (`page`). Its price and offer
 * details were confirmed by the owner; the other offers stay bare until theirs
 * are supplied.
 */
(function storeCatalogModule(global) {
  "use strict";

  // `focus` is optional: a CSS object-position that keeps the subject in frame when
  // the photo is cropped into a shorter box (e.g. the square mobile card).
  function storePhoto(id, wide, height, original, alt, focus) {
    var prefix = "/assets/store/" + id + "-";
    var photo = {
      original: original,
      alt: alt,
      width: wide,
      height: height,
      src: prefix + wide + ".webp",
      webp: [
        { src: prefix + "640.webp", w: 640 },
        { src: prefix + wide + ".webp", w: wide }
      ],
      avif: [
        { src: prefix + "640.avif", w: 640 },
        { src: prefix + wide + ".avif", w: wide }
      ]
    };
    if (focus) photo.focus = focus;
    return photo;
  }

  var PHOTO = {
    pack: storePhoto(
      "pack", 1206, 2622,
      "/assets/landing/hero-athlevo.png",
      "Athlevo athletes gathered together after a training session."
    ),
    stretch: storePhoto(
      "stretch", 1080, 1616,
      "/assets/landing/store-hero-stretch.jpg",
      "An Athlevo athlete in a white Athlevo shirt and red shorts holding one knee to the chest in a standing stretch."
    ),
    founder: storePhoto(
      "founder", 1145, 1374,
      "/assets/landing/dean-founder.png",
      "Dean Castro at an endurance race."
    ),
    hybrid: storePhoto(
      "hybrid", 1023, 1279,
      "/assets/landing/hybrid-programming-athlete.png",
      "An athlete in a white Athlevo singlet running on a wet track, one hand raised.",
      "50% 0%"
    ),
    christian: storePhoto(
      "christian", 880, 1100,
      "/assets/landing/christian-francia-coach.jpg",
      "Christian Francia smiling and flexing his arm while running a race."
    ),
    road: storePhoto(
      "road", 1280, 1707,
      "/athlevo-assets/diagnostic%20proof/640393536_17877223146489492_4744442913120713853_n.jpg",
      "A smiling runner in a white singlet and race bib, giving a thumbs up."
    ),
    track: storePhoto(
      "track", 1280, 1707,
      "/athlevo-assets/diagnostic%20proof/641749426_17877177045489492_4823496183798299753_n.jpg",
      "An athlete on the track during a workout."
    )
  };

  // Only answers backed by confirmed information. Intake, coach review, delivery,
  // support, pricing, and per-offer details are not confirmed yet; do not add FAQs
  // about them until they are.
  // Shared coach record: used by the Athlevo Plan page and the catalog's coaches section.
  var DEAN = {
    name: "Dean Vincent Castro",
    role: "Founder & Head Coach, Athlevo",
    photo: PHOTO.founder,
    intro: "Dean founded Athlevo and serves as its Head Coach. His focus is structured running and strength training: clear plans built around the athlete, reviewed and adjusted over time."
  };

  // Role, specialty and certifications supplied by the owner. Do not add to them.
  var CHRISTIAN = {
    name: "Christian Francia",
    role: "Assistant Coach, Athlevo",
    photo: PHOTO.christian,
    intro: "Christian is an assistant coach at Athlevo. He specializes in strength and conditioning.",
    certifications: [
      "Functional training",
      "Fitness body anatomy",
      "Movement analysis and corrective exercise",
      "Basic nutrition",
      "OCR"
    ]
  };

  // Approved athlete feedback about Athlevo coaching in general. It is not specific to
  // any one offer, so the Plan and Coaching pages share it. Quotes are copied verbatim
  // from the cited source file; a test enforces that.
  var ATHLETE_FEEDBACK = {
    label: "From Athlevo athletes.",
    items: [
      {
        name: "Rodel Mark",
        context: "Athlete · Sub-19 5K",
        quote: "“Maraming salamat, Athlevo! Dahil sa coaching, nakuha ko ang sub-19. Sobrang laki ng improvement ko since I started.”",
        source: "js/landingContent.js"
      },
      {
        name: "Miguel Bulado",
        context: "Student Athlete",
        quote: "“Athlevo doesn’t just give me training programs. It also emphasizes the importance of quality training days and prioritizing recovery. I’m deeply thankful for the guidance during my final year as a student athlete at Pampanga State University.”",
        source: "js/landingContent.js"
      },
      {
        name: "JB Luna",
        context: "Recreational Runner",
        quote: "“Athlevo has been an amazing coach. I’ve never felt stronger, faster, and more motivated. The personalized training made a huge impact on my running journey.”",
        source: "js/landingContent.js"
      },
      {
        name: "Carl Zita",
        context: "Recreational Runner",
        quote: "“Effective program, quality sessions, and very informative coaching.”",
        source: "js/landingContent.js"
      }
    ]
  };

  // Checkout copy shown on every offer that opens sign-up. The payment line must match the
  // methods the server offers (lib/server/paymongoClient.js); a test checks that.
  var SIGNUP_COPY = {
    payment: "Pay securely through PayMongo with QRPh, Maya, or GrabPay.",
    renewal: "There is no automatic renewal. We will remind you when your next payment is due.",
    // Wording from Section 6 of the Athlevo Coaching Agreement v2.0.
    terms: "All payments to Athlevo are final and non-refundable, to the fullest extent allowed under Philippine law."
  };

  var sharedFaqs = [
    {
      question: "Can I buy a program today?",
      answer: "Not yet. Purchasing is not open, so this page is for browsing programs."
    },
    {
      question: "Are race times guaranteed?",
      answer: "No. Athlevo does not guarantee race results. A plan organizes training; outcomes still depend on health, consistency, recovery, and race-day conditions."
    }
  ];

  var products = [
    {
      slug: "athlevo-plan",
      name: "Athlevo Plan",
      hero: PHOTO.track,
      page: {
        seoTitle: "Athlevo Plan — Personalized Running and Strength Training",
        headline: "A clear plan for your next goal.",
        description: "Personalized running and strength training built around your fitness, schedule, and goals.",
        price: { amount: "₱1,998", period: "/month" },
        cta: { label: "Sign Up", target: "how-to-get-started" },
        supporting: "Monthly coaching plan. No lock-in.",
        overview: {
          intro: "Athlevo Plan is for runners who can train independently and want a clear, personalized structure to follow.",
          includesTitle: "What is included",
          includes: [
            "A personalized running plan.",
            "Strength training matched to your schedule and equipment.",
            "Planning around your current fitness, goals, race calendar, and other training.",
            "Basic coach support.",
            "A monthly coach review and plan adjustment."
          ],
          note: "Athlevo Plan includes a monthly review. More frequent reviews are part of Athlevo Coaching."
        },
        athleteFeedback: ATHLETE_FEEDBACK,
        pricing: {
          includes: [
            "Personalized running plan",
            "Strength training matched to your schedule and equipment",
            "Basic coach support",
            "Monthly coach review and plan adjustment"
          ],
          terms: "Month-to-month, no lock-in."
        },
        coach: DEAN,
        // Athlevo Plan sign-up. Keep `open` false until the checkout, the sign-ups
        // table and the questionnaire link are set up (docs/plan-signup.md). A test
        // keeps the store notice and FAQ in step with it. The price itself is owned
        // by the server (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: false,
          label: "Sign Up",
          checkoutEndpoint: "/api/plan-signup/checkout",
          statusEndpoint: "/api/plan-signup/status",
          payment: SIGNUP_COPY.payment,
          renewal: SIGNUP_COPY.renewal,
          terms: SIGNUP_COPY.terms
        },
        getStarted: {
          steps: [
            "Sign up and complete payment.",
            "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
            "Schedule a call with the Athlevo team.",
            "Receive your personalized plan and coach contact instructions.",
            "Follow the plan, with a monthly review and adjustment."
          ],
          notice: "Registration opening soon"
        }
      },
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-coaching", "hybrid-programming", "elite-coaching"]
    },
    {
      slug: "athlevo-coaching",
      name: "Athlevo Coaching",
      hero: PHOTO.road,
      page: {
        seoTitle: "Athlevo Coaching — Online Running and Strength Coaching",
        headline: "Your training, reviewed and adjusted regularly.",
        description: "Personalized online running coaching with regular reviews and direct coach communication.",
        price: { amount: "₱4,998", period: "/month" },
        cta: { label: "Sign Up", target: "how-to-get-started" },
        supporting: "Month-to-month coaching. No lock-in.",
        overview: {
          intro: "Athlevo Coaching is for runners who want more than a plan. Your coach reviews and adjusts your training regularly, and you can communicate with your coach directly.",
          includesTitle: "What is included",
          includes: [
            "An onboarding call to understand your training history, current fitness, schedule, equipment, limitations, and goals.",
            "A personalized running plan.",
            "Strength and conditioning guidance where appropriate.",
            "Regular coach reviews and assessments of your progress.",
            "Direct coach communication.",
            "Frequent adjustments based on how training is actually going."
          ],
          note: "Coaching is delivered online. Athlevo Coaching includes more frequent reviews than Athlevo Plan, which includes a monthly review."
        },
        athleteFeedback: ATHLETE_FEEDBACK,
        pricing: {
          includes: [
            "Personalized running plan",
            "Strength and conditioning guidance where appropriate",
            "Regular coach reviews and assessments",
            "Direct coach communication"
          ],
          terms: "Month-to-month, no lock-in."
        },
        // No coach profile on purpose: the page does not name or imply a coach.
        // Athlevo Coaching sign-up works exactly like Athlevo Plan's. Keep `open` false
        // until the checkout, the sign-ups table and the questionnaire link are set up
        // (docs/plan-signup.md). The price is owned by the server
        // (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: false,
          label: "Sign Up",
          checkoutEndpoint: "/api/coaching-signup/checkout",
          statusEndpoint: "/api/coaching-signup/status",
          payment: SIGNUP_COPY.payment,
          renewal: SIGNUP_COPY.renewal,
          terms: SIGNUP_COPY.terms
        },
        getStarted: {
          steps: [
            "Sign up and complete payment.",
            "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
            "Schedule your onboarding call.",
            "Receive your personalized running plan, with strength and conditioning guidance where appropriate.",
            "Train with regular coach reviews, frequent adjustments, and direct coach communication."
          ],
          notice: "Registration opening soon"
        }
      },
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-plan", "hybrid-programming", "elite-coaching"]
    },
    {
      slug: "hybrid-programming",
      name: "Hybrid Programming",
      hero: PHOTO.hybrid,
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-plan", "athlevo-coaching", "elite-coaching"]
    },
    {
      slug: "elite-coaching",
      name: "Elite Coaching",
      hero: PHOTO.pack,
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-plan", "athlevo-coaching", "hybrid-programming"]
    }
  ];

  // Pre-rename URLs. Old links resolve to the renamed offer. First 10K was
  // removed from the storefront and intentionally has no entry.
  var legacySlugs = {
    "first-5k": "athlevo-plan",
    "faster-5k": "athlevo-coaching",
    "half-marathon": "hybrid-programming",
    "marathon": "elite-coaching"
  };

  function getProduct(slug) {
    var key = String(slug || "").replace(/^\/+|\/+$/g, "");
    for (var i = 0; i < products.length; i++) {
      if (products[i].slug === key) return products[i];
    }
    return null;
  }

  function resolveSlug(slug) {
    var key = String(slug || "").replace(/^\/+|\/+$/g, "");
    return Object.prototype.hasOwnProperty.call(legacySlugs, key) ? legacySlugs[key] : key;
  }

  function relatedProducts(product) {
    if (!product) return [];
    var seen = {};
    var out = [];
    var slugs = product.related || [];
    for (var i = 0; i < slugs.length; i++) {
      var next = getProduct(slugs[i]);
      if (next && !seen[next.slug] && next.slug !== product.slug) {
        seen[next.slug] = true;
        out.push(next);
      }
    }
    return out;
  }

  var SITE_URL = "https://athlevo.org";

  // Search and share metadata for each route. The browser (storefront.js) and the
  // build script (scripts/build-store-pages.mjs) both read this, so the static page
  // and the client-updated page always agree. Reuse approved copy only: no new claims.
  function seo(slug) {
    if (!slug) {
      return {
        path: "/store",
        url: SITE_URL + "/store",
        title: "Athlevo Programs: Running and Strength Programming",
        description: "Explore Athlevo Plan, Athlevo Coaching, Hybrid Programming, and Elite Coaching. Find training support that fits your goals."
      };
    }
    var product = getProduct(slug);
    if (!product) return null;
    var path = "/store/" + product.slug;
    var meta = { path: path, url: SITE_URL + path };
    if (product.page) {
      var page = product.page;
      meta.title = page.seoTitle;
      meta.description = page.description + " " + page.price.amount + page.price.period + ". " + page.pricing.terms;
    } else {
      meta.title = product.name + " — Athlevo Programs";
      meta.description = product.name + " from Athlevo. Purchasing is not yet available.";
    }
    return meta;
  }

  // Names of the offers whose sign-up switch is on, in catalog order.
  function openOfferNames() {
    return products.filter(function (product) {
      return !!(product.page && product.page.signUp && product.page.signUp.open === true);
    }).map(function (product) { return product.name; });
  }

  function openOffersPhrase(names) {
    return names.join(" and ") + (names.length === 1 ? " is" : " are") + " open for sign-up";
  }

  // The banner at the top of every store page. scripts/build-store-pages.mjs writes
  // it into the static HTML, so flipping the switch needs one rebuild, not a hand edit.
  function notice() {
    var names = openOfferNames();
    return names.length ? openOffersPhrase(names) : "Purchasing is not yet available";
  }

  // The first FAQ answers "can I buy today?", so it follows the sign-up switches.
  function getFaqs() {
    var names = openOfferNames();
    if (!names.length) return sharedFaqs;
    return [{
      question: sharedFaqs[0].question,
      answer: openOffersPhrase(names) + ". The other programs are not available to buy yet."
    }].concat(sharedFaqs.slice(1));
  }

  var catalog = {
    brand: "Athlevo",
    siteUrl: SITE_URL,
    purchasingAvailable: false,
    hero: {
      image: PHOTO.stretch,
      headline: "Training built around you."
    },
    intro: "Personalized running and strength programming built around your goals, schedule, and current fitness.",
    coaches: [DEAN, CHRISTIAN],
    products: products,
    faqs: sharedFaqs,
    getFaqs: getFaqs,
    notice: notice,
    legacySlugs: legacySlugs,
    getProduct: getProduct,
    resolveSlug: resolveSlug,
    relatedProducts: relatedProducts,
    seo: seo
  };

  global.AthlevoStoreCatalog = catalog;
})(typeof window !== "undefined" ? window : globalThis);
