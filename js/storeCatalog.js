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
 * owner, in `certifications` (heading `credentialsLabel`, default "Certified in");
 * never add credentials or achievements of your own. Coach cards show credentials
 * only, not personal bests.
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
    // Photos no wider than 640 have a single variant; wider ones add the 640 variant.
    var widths = wide > 640 ? [640, wide] : [wide];
    var photo = {
      original: original,
      alt: alt,
      width: wide,
      height: height,
      src: prefix + wide + ".webp",
      webp: widths.map(function (w) { return { src: prefix + w + ".webp", w: w }; }),
      avif: widths.map(function (w) { return { src: prefix + w + ".avif", w: w }; })
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
      "founder", 920, 1150,
      "/assets/landing/dean-castro-coach.jpg",
      "Dean Castro running a race in a white Athlevo singlet and race bib."
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
    louie: storePhoto(
      "louie", 640, 800,
      "/assets/landing/louie-agawa-coach.jpg",
      "Louie Agawa in a black running singlet and sport sunglasses, standing with his hands on his hips."
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
  // Role and certifications supplied by the owner. Do not add to them.
  var DEAN = {
    name: "Dean Vincent Castro",
    role: "Founder & Head Coach, Athlevo",
    photo: PHOTO.founder,
    intro: "Dean founded Athlevo and serves as its Head Coach. His focus is structured running and strength training: clear plans built around the athlete, reviewed and adjusted over time.",
    credentialsLabel: "Credentials",
    certifications: [
      "USATF Level 1 Certified Coach",
      "STRYD Certified Running Coach"
    ]
  };

  // Role, specialty and certifications supplied by the owner. Do not add to them.
  var CHRISTIAN = {
    name: "Christian Francia",
    role: "Strength & Conditioning Coach, Assistant Running Coach, Athlevo",
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

  // Role label and credentials supplied by the owner. Do not add to them.
  var LOUIE = {
    name: "Louie Agawa",
    role: "Running Coach, Athlevo",
    photo: PHOTO.louie,
    intro: "Louie is a running coach at Athlevo and a competitive middle to long distance runner.",
    credentialsLabel: "Credentials",
    certifications: [
      "World Athletics Certified Coach — CECS Level 1",
      "ISSA Certified Running Coach"
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

  // Extra questions shown on /programs only, supplied by the owner on 2026-10-22 for the
  // search "online running coach in the Philippines". They follow the shared FAQs and are
  // also what the FAQPage markup in the page head says (see structuredData below).
  var hubFaqs = [
    {
      question: "Do you coach runners outside Pampanga?",
      answer: "Yes. Coaching is fully online, so you can train from anywhere in the Philippines."
    },
    {
      question: "Can beginners join?",
      answer: "Yes. Our athletes range from first-time 5K runners to marathoners, and every plan starts from where you are now."
    },
    {
      question: "What distances do you coach?",
      answer: "5K, 10K, half marathon and marathon."
    },
    {
      question: "Are your coaches certified?",
      answer: "Head Coach Dean Castro is USATF Level 1 and STRYD certified."
    },
    {
      question: "How fast will I improve?",
      answer: "It depends on your starting point, your consistency and your recovery. We don't promise a number or a race time."
    },
    {
      question: "How do I start?",
      answer: "Pick a program on this page and tap Sign Up. If you would rather talk first, message \"PR\" on our Facebook or Instagram page."
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
        // Athlevo Plan sign-up. `open` shows the Sign Up button; it needs the checkout, the
        // sign-ups table and the questionnaire link set up (docs/plan-signup.md), and
        // PLAN_SIGNUP_ENABLED on the server. Set it back to false to hide the button. A test
        // keeps the store notice and FAQ in step with it. The price itself is owned
        // by the server (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: true,
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
        // Athlevo Coaching sign-up works exactly like Athlevo Plan's, with its own switch
        // (COACHING_SIGNUP_ENABLED on the server; see docs/plan-signup.md). Set `open` back to
        // false to hide the button. The price is owned by the server
        // (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: true,
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
      page: {
        seoTitle: "Elite Coaching — Online Running Coaching with Dean Castro",
        headline: "Your training, coached directly by Dean.",
        description: "Personalized online running coaching with Head Coach Dean Castro, with regular reviews and direct coach communication.",
        price: { amount: "₱7,998", period: "/month" },
        cta: { label: "Sign Up", target: "how-to-get-started" },
        supporting: "Month-to-month coaching. No lock-in.",
        overview: {
          intro: "Elite Coaching is Athlevo Coaching with Dean Castro as your coach. Dean reviews and adjusts your training regularly, and you communicate with him directly.",
          includesTitle: "What is included",
          includes: [
            "Dean Castro, Head Coach of Athlevo, as your coach.",
            "An onboarding call to understand your training history, current fitness, schedule, equipment, limitations, and goals.",
            "A personalized running plan.",
            "Strength and conditioning guidance where appropriate.",
            "Regular coach reviews and assessments of your progress.",
            "Direct coach communication.",
            "Frequent adjustments based on how training is actually going."
          ],
          note: "Coaching is delivered online. Elite Coaching has the same reviews and coach communication as Athlevo Coaching, with Dean as your coach."
        },
        athleteFeedback: ATHLETE_FEEDBACK,
        pricing: {
          includes: [
            "Dean Castro as your coach",
            "Personalized running plan",
            "Strength and conditioning guidance where appropriate",
            "Regular coach reviews and assessments",
            "Direct coach communication"
          ],
          terms: "Month-to-month, no lock-in."
        },
        coach: DEAN,
        // Elite Coaching sign-up works exactly like Athlevo Coaching's, with its own switch
        // (ELITE_SIGNUP_ENABLED on the server; see docs/plan-signup.md). Set `open` back to false
        // to hide the button. `takesCodes: false` keeps the code box off this page: codes cover
        // Plan and Coaching only. The price is owned by the server
        // (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: true,
          label: "Sign Up",
          checkoutEndpoint: "/api/elite-signup/checkout",
          statusEndpoint: "/api/elite-signup/status",
          takesCodes: false,
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
            "Train with Dean: regular coach reviews, frequent adjustments, and direct coach communication."
          ],
          notice: "Registration opening soon"
        }
      },
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
  // The Facebook page already linked from the Athlevo landing page.
  var FACEBOOK_URL = "https://www.facebook.com/profile.php?id=61574957235305";

  // Search and share metadata for each route. The browser (storefront.js) and the
  // build script (scripts/build-store-pages.mjs) both read this, so the static page
  // and the client-updated page always agree. Reuse approved copy only: no new claims.
  function seo(slug) {
    if (!slug) {
      return {
        path: "/programs",
        url: SITE_URL + "/programs",
        title: "Online Running Coach in the Philippines | Athlevo Coaching",
        description: "Train with an online running coach in the Philippines. USATF Level 1 and STRYD certified. Structured 5K to marathon plans, built around your schedule."
      };
    }
    var product = getProduct(slug);
    if (!product) return null;
    var path = "/programs/" + product.slug;
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
    var list = names.length > 2 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names.join(" and ");
    return list + (names.length === 1 ? " is" : " are") + " open for sign-up";
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
      answer: openOffersPhrase(names) + (names.length === products.length - 1
        ? ". The other program is not available to buy yet."
        : ". The other programs are not available to buy yet.")
    }].concat(sharedFaqs.slice(1));
  }

  // What the /programs page shows: the shared FAQs (with the live "can I buy" answer) plus the hub-only ones.
  function getHubFaqs() {
    return getFaqs().concat(hubFaqs);
  }

  // JSON-LD for the /programs page only. The build script writes it into the static
  // <head>. Everything here is read from data the page already shows (the FAQs, Dean's
  // record, the Facebook page), so the markup cannot say anything the page does not.
  function structuredData(slug) {
    if (slug) return null;
    var orgId = SITE_URL + "/#organization";
    var deanId = SITE_URL + "/programs#dean-castro";
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": orgId,
          name: "Athlevo",
          url: SITE_URL + "/",
          address: { "@type": "PostalAddress", addressRegion: "Pampanga", addressCountry: "PH" },
          areaServed: { "@type": "Country", name: "Philippines" },
          sameAs: [FACEBOOK_URL],
          founder: { "@id": deanId }
        },
        {
          "@type": "Person",
          "@id": deanId,
          name: DEAN.name,
          jobTitle: "Founder and Head Coach",
          worksFor: { "@id": orgId },
          hasCredential: DEAN.certifications.map(function (name) {
            return { "@type": "EducationalOccupationalCredential", name: name };
          })
        },
        {
          "@type": "FAQPage",
          mainEntity: getHubFaqs().map(function (item) {
            return { "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } };
          })
        }
      ]
    };
  }

  var catalog = {
    brand: "Athlevo",
    siteUrl: SITE_URL,
    purchasingAvailable: false,
    hero: {
      image: PHOTO.stretch,
      headline: "Online Running Coach in the Philippines"
    },
    intro: "Athlevo Coaching is an online running coach service based in Pampanga and open to runners anywhere in the Philippines. Coach Dean Castro is a USATF Level 1 and STRYD certified coach. Your plan follows your schedule, your recovery and your race goal, from first 5K to marathon. You also learn why each workout is there, so you can train smarter on your own.",
    hub: {
      primaryLabel: "See the programs",
      messageLabel: "Message PR to start",
      messageUrl: FACEBOOK_URL
    },
    coaches: [DEAN, CHRISTIAN, LOUIE],
    products: products,
    faqs: sharedFaqs,
    getFaqs: getFaqs,
    getHubFaqs: getHubFaqs,
    structuredData: structuredData,
    notice: notice,
    legacySlugs: legacySlugs,
    getProduct: getProduct,
    resolveSlug: resolveSlug,
    relatedProducts: relatedProducts,
    seo: seo
  };

  global.AthlevoStoreCatalog = catalog;
})(typeof window !== "undefined" ? window : globalThis);
