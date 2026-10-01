/*
 * Athlevo program storefront catalog.
 *
 * Single editable source for collections, draft programs, storefront copy,
 * and FAQs. Undecided terms (coachSupport) are internal data and must not
 * appear in customer-facing copy. Do not add unapproved prices, promotional markdown, testimonials,
 * results, or outcome promises here.
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

  var collections = [
    {
      id: "5k",
      name: "5K",
      headline: "Learn the distance, then race it with purpose.",
      image: PHOTO.track
    },
    {
      id: "10k",
      name: "10K",
      headline: "Build the engine between a first 5K and longer races.",
      image: PHOTO.road
    },
    {
      id: "half-marathon",
      name: "Half Marathon",
      headline: "Sixteen weeks of structure toward 21.1 kilometers.",
      image: PHOTO.training
    },
    {
      id: "marathon",
      name: "Marathon",
      headline: "A long, honest build toward 42.2 kilometers.",
      image: PHOTO.pack
    }
  ];

  var sharedFaqs = [
    {
      question: "Can I buy a program today?",
      answer: "Not yet. Purchasing is not open, so this page is for browsing programs."
    },
    {
      question: "What happens after I choose a program?",
      answer: "You complete a short intake, a coach reviews it and personalizes the plan, and you receive it to follow for the full block. Each program page lists the details."
    },
    {
      question: "Are these generic templates?",
      answer: "No. Each program is a distance-specific starting structure. After intake, a coach reviews your goal, schedule, and current training and personalizes the plan before you receive it."
    },
    {
      question: "What does the intake cover?",
      answer: "Your goal and race date, recent training, the days you can run each week, and anything else you are balancing, such as strength work, other sports, or a busy schedule."
    },
    {
      question: "Which program is right for me?",
      answer: "Every program page lists who it is for and the starting fitness it assumes. If you are between two distances, the shorter one is usually the better place to begin."
    },
    {
      question: "Are race times guaranteed?",
      answer: "No. Athlevo does not guarantee race results. A plan organizes training; outcomes still depend on health, consistency, recovery, and race-day conditions."
    }
  ];

  var products = [
    {
      slug: "first-5k",
      name: "First 5K",
      collection: "5k",
      durationWeeks: 8,
      durationLabel: "8 weeks",
      intendedRunner: "New runners building toward a first 5K.",
      hero: PHOTO.track,
      summary: "A patient eight-week introduction to consistent running, with enough structure to arrive at 5 kilometers prepared rather than guessing.",
      description: "First 5K is for people who want a real race on the calendar without being dropped into a high-volume plan. The block develops the habit of showing up, the aerobic base a 5K needs, and the small amount of faster work that makes race day feel familiar.",
      whoFor: [
        "Runners preparing for their first 5K, or returning after a long time away.",
        "People who can currently walk-run or jog for about 20–30 minutes.",
        "Anyone who wants a coach-reviewed plan instead of an unsigned PDF."
      ],
      startingFitness: [
        "Able to complete 20–30 minutes of easy movement most weeks, even if some of that is walking.",
        "No current injury that prevents run/walk sessions three times per week.",
        "Willing to train about three days per week for eight weeks."
      ],
      receives: [
        "A personalized 8-week 5K plan after intake.",
        "Coach review of that plan before you start the block.",
        "Clear session intent for easy days, walks, and any introductory faster work."
      ],
      intakeAndDelivery: [
        "After purchase is available, you complete an intake covering goal date, recent training, schedule, and constraints.",
        "A coach reviews the intake and personalizes the First 5K structure to you.",
        "You receive the plan to follow for the 8-week block."
      ],
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "How questions are answered during the block, and whether mid-block adjustments are included, is not decided yet. Those terms will be published before purchasing opens."
      },
      related: ["faster-5k", "first-10k"]
    },
    {
      slug: "faster-5k",
      name: "Faster 5K",
      collection: "5k",
      durationWeeks: 12,
      durationLabel: "12 weeks",
      intendedRunner: "Runners who already finish 5K and want a sharper race.",
      hero: PHOTO.road,
      summary: "Twelve weeks aimed at a faster 5K: more specific work, still built around the athlete who shows up in the intake, not a generic peak week.",
      description: "Faster 5K assumes you can already complete the distance and want the race to feel more deliberate. The block keeps easy running honest, introduces work that belongs at 5K pace, and leaves room for a coach to set volume from your current week rather than from a poster plan.",
      whoFor: [
        "Runners who have finished a 5K and want a more specific next race.",
        "Athletes who already run about three or four days per week.",
        "People who prefer a coached block over stacking random intervals."
      ],
      startingFitness: [
        "Can complete 5 kilometers continuously at an easy-to-steady effort.",
        "Recent running of at least three days per week.",
        "Able to add one quality session most weeks without dropping all easy running."
      ],
      receives: [
        "A personalized 12-week 5K plan after intake.",
        "Coach review of that plan before the block starts.",
        "Session structure for easy running, 5K-specific work, and a taper into the race."
      ],
      intakeAndDelivery: [
        "Intake covers recent 5K or time-trial context, weekly availability, and the target race.",
        "A coach personalizes volume and session difficulty from that picture.",
        "You receive the 12-week plan to run through race week."
      ],
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "In-block messaging, workout feedback, and plan-change rules are pending. They will be stated before purchasing opens."
      },
      related: ["first-5k", "first-10k", "half-marathon"]
    },
    {
      slug: "first-10k",
      name: "First 10K",
      collection: "10k",
      durationWeeks: 12,
      durationLabel: "12 weeks",
      intendedRunner: "Runners moving from 5K toward a first 10K.",
      hero: PHOTO.training,
      summary: "Twelve weeks that grow durable easy running and introduce the endurance a 10K actually asks for.",
      description: "First 10K is the step after you can already handle a 5K. The work is still approachable: longer easy days, a weekly rhythm you can keep, and enough specific running that 10 kilometers on race day is a continuation of training, not a surprise.",
      whoFor: [
        "Runners who have raced or trained through a 5K and want 10K next.",
        "People who can already run 30–40 minutes continuously.",
        "Athletes who want the next distance without jumping straight to a half marathon."
      ],
      startingFitness: [
        "Comfortable running 5 kilometers, or about 30–40 minutes, on easy days.",
        "Training at least three days per week in the month before the block.",
        "Able to progress toward a weekly long run in the 60–75 minute range by the later weeks."
      ],
      receives: [
        "A personalized 12-week 10K plan after intake.",
        "Coach review of that plan before you begin.",
        "Progression for easy running, a developing long run, and 10K-specific sessions."
      ],
      intakeAndDelivery: [
        "Intake records your recent 5K training, available days, and 10K date if you have one.",
        "A coach sets starting volume from that week, not from a default peak.",
        "You receive the plan for the full 12 weeks."
      ],
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Support during the 12 weeks is pending. Frequency, channels, and what counts as an in-block change will be published before purchasing opens."
      },
      related: ["faster-5k", "half-marathon"]
    },
    {
      slug: "half-marathon",
      name: "Half Marathon",
      collection: "half-marathon",
      durationWeeks: 16,
      durationLabel: "16 weeks",
      intendedRunner: "Runners preparing for 21.1 kilometers with a full training block.",
      hero: PHOTO.founder,
      summary: "Sixteen weeks toward a half marathon, with volume and specific work set after a coach reads your intake.",
      description: "The half marathon rewards patience more than hero sessions. This program is a sixteen-week arc: durable easy running, a long run that grows with you, and work that belongs at half-marathon effort — scheduled around the life you actually describe in intake.",
      whoFor: [
        "Runners targeting a first or returning half marathon.",
        "People who already run several days per week and can protect a long-run day.",
        "Athletes who want a coach-reviewed block rather than a public 16-week spreadsheet."
      ],
      startingFitness: [
        "Able to run about 45–60 minutes continuously, or complete a recent 10K.",
        "Training at least three to four days per week.",
        "Willing to keep one longer session each week for most of the 16 weeks."
      ],
      receives: [
        "A personalized 16-week half marathon plan after intake.",
        "Coach review of that plan before the block starts.",
        "Structure for easy volume, long runs, half-specific sessions, and a race-week taper."
      ],
      intakeAndDelivery: [
        "Intake covers race date, recent long runs, weekly days, and other training load (strength, other sports).",
        "A coach personalizes starting mileage and how quickly the long run grows.",
        "You receive the 16-week plan to follow through race week."
      ],
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Whether the block includes scheduled check-ins, message limits, or one mid-block rewrite is still pending."
      },
      related: ["first-10k", "marathon", "faster-5k"]
    },
    {
      slug: "marathon",
      name: "Marathon",
      collection: "marathon",
      durationWeeks: 20,
      durationLabel: "20 weeks",
      intendedRunner: "Runners building toward 42.2 kilometers with time to do it honestly.",
      hero: PHOTO.pack,
      summary: "A twenty-week marathon block: long enough to grow the work, short enough to stay pointed at one race.",
      description: "Marathon training is mostly the unglamorous accumulation of easy running and a long run that teaches the day. This program is twenty weeks so the plan can start from your current week instead of pretending every athlete arrives ready for peak mileage. Specific work is included; it never outruns the aerobic base the distance requires.",
      whoFor: [
        "Runners with a marathon on the calendar and twenty weeks to prepare.",
        "Athletes who have completed a half marathon or equivalent long training.",
        "People who want a coach-reviewed plan before they start a long block."
      ],
      startingFitness: [
        "Recent half marathon, or long runs already in the 90-minute range.",
        "Consistent running of four days per week, or a clear path to that early in the block.",
        "No unresolved injury that makes two-hour easy running unreasonable to progress toward."
      ],
      receives: [
        "A personalized 20-week marathon plan after intake.",
        "Coach review of that plan before you begin the block.",
        "Progression for easy volume, long runs, marathon-specific sessions, and race week."
      ],
      intakeAndDelivery: [
        "Intake includes race date, longest recent run, weekly availability, and other load you will keep (work, strength, family schedule).",
        "A coach sets the opening weeks from that picture and how the long run is allowed to grow.",
        "You receive the 20-week plan to carry through race week."
      ],
      // INTERNAL ONLY: undecided terms. Never render these on the storefront.
      coachSupport: {
        status: "pending",
        detail: "Marathon-block support terms — check-in cadence, late-block adjustments, and race-week guidance — are pending and will be published before purchasing opens."
      },
      related: ["half-marathon"]
    }
  ];

  function getProduct(slug) {
    var key = String(slug || "").replace(/^\/+|\/+$/g, "");
    for (var i = 0; i < products.length; i++) {
      if (products[i].slug === key) return products[i];
    }
    return null;
  }

  function getCollection(id) {
    for (var i = 0; i < collections.length; i++) {
      if (collections[i].id === id) return collections[i];
    }
    return null;
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

  function filterProducts(collectionId) {
    if (!collectionId || collectionId === "all") return products.slice();
    return products.filter(function (product) {
      return product.collection === collectionId;
    });
  }

  var catalog = {
    brand: "Athlevo",
    purchasingAvailable: false,
    hero: {
      image: PHOTO.training,
      headline: "A stronger race starts here.",
      lede: "Personalized running programs, reviewed by a coach."
    },
    intro: "Personalized running programs, from a first 5K to the marathon. Choose your distance and a coach shapes the plan around you.",
    collections: collections,
    products: products,
    faqs: sharedFaqs,
    getProduct: getProduct,
    getCollection: getCollection,
    relatedProducts: relatedProducts,
    filterProducts: filterProducts
  };

  global.AthlevoStoreCatalog = catalog;
})(typeof window !== "undefined" ? window : globalThis);
