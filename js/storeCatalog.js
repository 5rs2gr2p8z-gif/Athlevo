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
      "An athlete in a white Athlevo singlet running on a wet track during a marathon, one hand raised.",
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
        coach: DEAN,
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

  var catalog = {
    brand: "Athlevo",
    purchasingAvailable: false,
    hero: {
      image: PHOTO.stretch,
      headline: "Training built around you."
    },
    intro: "Personalized running and strength programming built around your goals, schedule, and current fitness.",
    coaches: [DEAN, CHRISTIAN],
    products: products,
    faqs: sharedFaqs,
    getProduct: getProduct,
    resolveSlug: resolveSlug,
    relatedProducts: relatedProducts
  };

  global.AthlevoStoreCatalog = catalog;
})(typeof window !== "undefined" ? window : globalThis);
