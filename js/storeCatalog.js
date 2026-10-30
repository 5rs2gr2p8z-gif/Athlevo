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
 * All four offers have a built page (`page`): Athlevo Plan, Athlevo Guided, Athlevo Coaching and
 * Athlevo VIP Coaching. Their prices and what each includes were confirmed by the owner on
 * 2026-10-31. Each tier builds on the one before it, and the copy says no more than that.
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
      "Dean Castro in a white Athlevo jersey, arms crossed, looking off to the side.",
      "50% 20%"
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
  // Shared coach record: used by the Athlevo VIP Coaching page and the catalog's coaches section.
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
  // any one offer, so every offer page shares it. Quotes are copied verbatim
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
    // For an offer that is paid once (Athlevo Plan): there is no next payment to remind about.
    oneTimeRenewal: "This is a one-time payment. Nothing renews automatically.",
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

  // The four offers, in the order they are sold. Prices are owned by the server
  // (lib/server/planSignup.js) and a test checks the two agree. Each `signUp.refCode` is the
  // code the server puts in that offer's payment reference (ATH-<code>-...); the browser uses it to
  // open a returning buyer's confirmation under the right offer.
  //   Athlevo Plan          one-time payment, no call step
  //   Athlevo Guided        the plan plus a coach to answer questions (was "Athlevo Plan")
  //   Athlevo Coaching      everything in Guided, with a hands-on coach
  //   Athlevo VIP Coaching  everything in Coaching, with Dean as your coach (was "Elite Coaching")
  var products = [
    {
      slug: "athlevo-plan",
      name: "Athlevo Plan",
      hero: PHOTO.track,
      page: {
        seoTitle: "Athlevo Plan — A Training Plan Built by a Coach",
        headline: "A training plan built for you.",
        description: "A personalized training plan, built by an Athlevo coach around your schedule, fitness level, and goals.",
        // Paid once, so there is no period. The page and the search description leave it out.
        price: { amount: "₱999", period: "" },
        cta: { label: "Sign Up", target: "how-to-get-started" },
        supporting: "One-time payment.",
        overview: {
          intro: "Athlevo Plan is a personalized training plan, built by an Athlevo coach. It is built for your own schedule, fitness level, and goals.",
          includesTitle: "What is included",
          includes: [
            "A personalized training plan, built by an Athlevo coach.",
            "Built around your schedule, your fitness level, and your goals."
          ],
          note: "Athlevo Plan is the plan only. If you want a coach to answer your questions, see Athlevo Guided."
        },
        athleteFeedback: ATHLETE_FEEDBACK,
        pricing: {
          includes: [
            "Personalized training plan",
            "Built by an Athlevo coach",
            "Built around your schedule, fitness level, and goals"
          ],
          terms: "One-time payment."
        },
        // No coach profile on purpose: the page says "an Athlevo coach" and names no one.
        // Athlevo Plan sign-up. `open` shows the Sign Up button; it needs the checkout, the
        // sign-ups table and the questionnaire link set up (docs/plan-signup.md), and
        // PLAN_SIGNUP_ENABLED on the server. Set it back to false to hide the button. A test
        // keeps the store notice and FAQ in step with it. The price itself is owned
        // by the server (lib/server/planSignup.js); a test checks the two agree.
        // `call: false`: after the questionnaire there is no call to schedule. `takesCodes: false`
        // keeps the code box off this page: codes cover Guided and Coaching only.
        signUp: {
          open: true,
          label: "Sign Up",
          refCode: "TP",
          call: false,
          checkoutEndpoint: "/api/plan-signup/checkout",
          statusEndpoint: "/api/plan-signup/status",
          takesCodes: false,
          payment: SIGNUP_COPY.payment,
          renewal: SIGNUP_COPY.oneTimeRenewal,
          terms: SIGNUP_COPY.terms
        },
        getStarted: {
          steps: [
            "Sign up and complete payment.",
            "Complete the Athlevo questionnaire about your fitness, goals, schedule, and equipment.",
            "An Athlevo coach builds your personalized training plan from your answers.",
            "Receive your plan."
          ],
          notice: "Registration opening soon"
        }
      },
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-guided", "athlevo-coaching", "athlevo-vip-coaching"]
    },
    {
      slug: "athlevo-guided",
      name: "Athlevo Guided",
      hero: PHOTO.hybrid,
      page: {
        seoTitle: "Athlevo Guided — Training Plan and a Coach to Ask",
        headline: "Your plan, and a coach to answer your questions.",
        description: "A personalized running and strength training plan, built by an Athlevo coach, plus a coach to answer your questions.",
        price: { amount: "₱2,997", period: "/month" },
        cta: { label: "Sign Up", target: "how-to-get-started" },
        supporting: "Month-to-month. No lock-in.",
        overview: {
          intro: "Athlevo Guided is the Athlevo Plan with a coach to answer your questions. It is for runners who can train independently and want a coach to ask along the way.",
          includesTitle: "What is included",
          includes: [
            "A personalized training plan, built by an Athlevo coach.",
            "Running and strength training.",
            "Built around your schedule, your fitness level, and your goals.",
            "A coach to answer your questions."
          ],
          note: "Athlevo Guided is the plan plus a coach to answer your questions. Frequent training adjustments, nutrition, recovery protocols, and a hands-on coach are part of Athlevo Coaching."
        },
        athleteFeedback: ATHLETE_FEEDBACK,
        pricing: {
          includes: [
            "Personalized training plan, built by an Athlevo coach",
            "Running and strength training",
            "A coach to answer your questions"
          ],
          terms: "Month-to-month, no lock-in."
        },
        // No coach profile on purpose: the page says "a coach" and names no one.
        // Athlevo Guided is the offer that used to be called Athlevo Plan. Its sign-up works the
        // same way, with its own switch (GUIDED_SIGNUP_ENABLED on the server; see
        // docs/plan-signup.md). Set `open` back to false to hide the button. The price is owned by
        // the server (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: true,
          label: "Sign Up",
          refCode: "PL",
          call: true,
          checkoutEndpoint: "/api/guided-signup/checkout",
          statusEndpoint: "/api/guided-signup/status",
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
            "Follow your plan and ask your coach when you have questions."
          ],
          notice: "Registration opening soon"
        }
      },
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-plan", "athlevo-coaching", "athlevo-vip-coaching"]
    },
    {
      slug: "athlevo-coaching",
      name: "Athlevo Coaching",
      hero: PHOTO.road,
      page: {
        seoTitle: "Athlevo Coaching — Online Running and Strength Coaching",
        headline: "A hands-on coach for your training, nutrition, and recovery.",
        description: "Everything in Athlevo Guided, plus frequent training adjustments, nutrition, recovery protocols, and a hands-on coach.",
        price: { amount: "₱4,998", period: "/month" },
        cta: { label: "Sign Up", target: "how-to-get-started" },
        supporting: "Month-to-month. No lock-in.",
        overview: {
          intro: "Athlevo Coaching is Athlevo Guided with a hands-on coach. Your training is adjusted frequently, based on how it is actually going.",
          includesTitle: "What is included",
          includes: [
            "Everything in Athlevo Guided.",
            "Frequent training adjustments, based on how your training is going.",
            "Running and strength training.",
            "Nutrition.",
            "Recovery protocols.",
            "A hands-on coach."
          ],
          note: "Coaching is delivered online. Athlevo Coaching includes everything in Athlevo Guided."
        },
        athleteFeedback: ATHLETE_FEEDBACK,
        pricing: {
          includes: [
            "Everything in Athlevo Guided",
            "Frequent training adjustments",
            "Running, strength, nutrition, and recovery protocols",
            "A hands-on coach"
          ],
          terms: "Month-to-month, no lock-in."
        },
        // No coach profile on purpose: the page does not name or imply a coach.
        // Athlevo Coaching sign-up works exactly like Athlevo Guided's, with its own switch
        // (COACHING_SIGNUP_ENABLED on the server; see docs/plan-signup.md). Set `open` back to
        // false to hide the button. The price is owned by the server
        // (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: true,
          label: "Sign Up",
          refCode: "CO",
          call: true,
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
            "Receive your personalized training plan.",
            "Train with frequent adjustments from your hands-on coach."
          ],
          notice: "Registration opening soon"
        }
      },
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-plan", "athlevo-guided", "athlevo-vip-coaching"]
    },
    {
      slug: "athlevo-vip-coaching",
      name: "Athlevo VIP Coaching",
      hero: PHOTO.pack,
      page: {
        seoTitle: "Athlevo VIP Coaching — Online Coaching with Dean Castro",
        headline: "Coached directly by Dean, with priority responses.",
        description: "Everything in Athlevo Coaching, with Head Coach Dean Castro as your coach and priority responses.",
        price: { amount: "₱7,998", period: "/month" },
        cta: { label: "Sign Up", target: "how-to-get-started" },
        supporting: "Month-to-month. No lock-in.",
        overview: {
          intro: "Athlevo VIP Coaching is the top tier. It includes everything in Athlevo Coaching, with Dean Castro as your coach and priority responses.",
          includesTitle: "What is included",
          includes: [
            "Everything in Athlevo Coaching.",
            "Dean Castro, Head Coach of Athlevo, as your coach.",
            "Priority responses."
          ],
          note: "Coaching is delivered online. Athlevo VIP Coaching is Athlevo Coaching with Dean as your coach and priority responses."
        },
        athleteFeedback: ATHLETE_FEEDBACK,
        pricing: {
          includes: [
            "Everything in Athlevo Coaching",
            "Dean Castro as your coach",
            "Priority responses"
          ],
          terms: "Month-to-month, no lock-in."
        },
        coach: DEAN,
        // Athlevo VIP Coaching is the offer that used to be called Elite Coaching. Its sign-up works
        // exactly like Athlevo Coaching's, with its own switch (VIP_SIGNUP_ENABLED on the server;
        // see docs/plan-signup.md). Set `open` back to false to hide the button. `takesCodes: false`
        // keeps the code box off this page: codes cover Guided and Coaching only. The price is
        // owned by the server (lib/server/planSignup.js); a test checks the two agree.
        signUp: {
          open: true,
          label: "Sign Up",
          refCode: "EL",
          call: true,
          checkoutEndpoint: "/api/vip-signup/checkout",
          statusEndpoint: "/api/vip-signup/status",
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
            "Receive your personalized training plan.",
            "Train with Dean as your coach, with priority responses."
          ],
          notice: "Registration opening soon"
        }
      },
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support terms for this offer are not decided yet. They will be published before purchasing opens."
      },
      related: ["athlevo-plan", "athlevo-guided", "athlevo-coaching"]
    }
  ];

  // Pre-rename URLs. Old links resolve to the renamed offer. First 10K was removed from the
  // storefront and intentionally has no entry. Hybrid Programming (and /store/half-marathon, which
  // pointed at it) was dropped from the lineup and has no entry either; Vercel sends those
  // addresses to /programs (vercel.json).
  var legacySlugs = {
    "first-5k": "athlevo-plan",
    "faster-5k": "athlevo-coaching",
    "marathon": "athlevo-vip-coaching",
    "elite-coaching": "athlevo-vip-coaching"
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

  // The program pages live on their own host: the hub is programs.athlevo.org/programs and an
  // offer is programs.athlevo.org/<slug>. Canonical tags, share tags, JSON-LD and the sitemap
  // are written from SITE_URL. The app, its sign-in and the legal pages stay on APP_URL, and
  // athlevo.org redirects every old program address here (see vercel.json). On any other host
  // (a preview deployment, local) an offer is still /programs/<slug>; only the host decides:
  // see productPath().
  var SITE_URL = "https://programs.athlevo.org";
  var APP_URL = "https://athlevo.org";
  var PROGRAMS_HOST = "programs.athlevo.org";
  var SITE_HOST = SITE_URL.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  // Where an offer's page lives on a given host.
  function productPath(slug, host) {
    return (host === PROGRAMS_HOST ? "/" : "/programs/") + slug;
  }

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
    var path = productPath(product.slug, SITE_HOST);
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
    if (names.length > 2 && names.length === products.length) return "All programs are open for sign-up";
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
    var rest = products.length - names.length;
    return [{
      question: sharedFaqs[0].question,
      answer: openOffersPhrase(names) + (rest === 0 ? "."
        : rest === 1 ? ". The other program is not available to buy yet."
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
    // The organization is Athlevo itself, whose home page is on the app host.
    var orgId = APP_URL + "/#organization";
    var deanId = SITE_URL + "/programs#dean-castro";
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": orgId,
          name: "Athlevo",
          url: APP_URL + "/",
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
    appUrl: APP_URL,
    programsHost: PROGRAMS_HOST,
    productPath: productPath,
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
