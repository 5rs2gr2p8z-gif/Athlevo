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
 * Athlevo Plan is the only offer with a built page (`page`). Its price and offer
 * details were confirmed by the owner; the other offers stay bare until theirs
 * are supplied.
 */
(function storeCatalogModule(global) {
  "use strict";

  function storePhoto(id, wide, height, original, alt) {
    var prefix = "/assets/store/" + id + "-";
    return {
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
  }

  var PHOTO = {
    pack: storePhoto(
      "pack", 1206, 2622,
      "/assets/landing/hero-athlevo.png",
      "Athlevo athletes gathered together after a training session."
    ),
    training: storePhoto(
      "training", 1206, 2622,
      "/assets/landing/athlete-philosophy-training.png",
      "A runner training on the road during an Athlevo session."
    ),
    founder: storePhoto(
      "founder", 1145, 1374,
      "/assets/landing/dean-founder.png",
      "Dean Castro at an endurance race."
    ),
    road: storePhoto(
      "road", 1280, 1707,
      "/athlevo-assets/diagnostic%20proof/640393536_17877223146489492_4744442913120713853_n.jpg",
      "Runners moving together on an open road."
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
          note: "Athlevo Plan includes a monthly review. Weekly reviews are part of Athlevo Coaching."
        },
        // Approved athlete feedback about Athlevo coaching in general, not Plan-specific.
        // Quotes are copied verbatim from the cited source file; a test enforces that.
        athleteFeedback: {
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
        },
        pricing: {
          includes: [
            "Personalized running plan",
            "Strength training matched to your schedule and equipment",
            "Basic coach support",
            "Monthly coach review and plan adjustment"
          ],
          terms: "Month-to-month, no lock-in."
        },
        coach: {
          name: "Dean Vincent Castro",
          role: "Founder & Head Coach, Athlevo",
          photo: PHOTO.founder,
          intro: "Dean founded Athlevo and serves as its Head Coach. His focus is structured running and strength training: clear plans built around the athlete, reviewed and adjusted over time."
        },
        getStarted: {
          steps: [
            "Sign up and complete payment.",
            "Fill out the intake form with your fitness, goals, schedule, and equipment.",
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
      hero: PHOTO.founder,
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

  var catalog = {
    brand: "Athlevo",
    purchasingAvailable: false,
    hero: {
      image: PHOTO.training,
      headline: "Training built around you."
    },
    intro: "Personalized running and strength programming built around your goals, schedule, and current fitness.",
    products: products,
    faqs: sharedFaqs,
    getProduct: getProduct,
    resolveSlug: resolveSlug,
    relatedProducts: relatedProducts
  };

  global.AthlevoStoreCatalog = catalog;
})(typeof window !== "undefined" ? window : globalThis);
