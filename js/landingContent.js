/*
 * Editable institutional-homepage collections.
 *
 * Keep verified athlete claims and approved photography in this file so the
 * editorial layouts in index.html do not need to be rewritten when content
 * is supplied. Rendering uses DOM text nodes; no content is interpreted as
 * HTML.
 */
(function landingContentModule(global) {
  "use strict";

  const content = {
    trainingOffers: [
      {
        type: "INDEPENDENT COACHING",
        name: "Athlevo AI",
        headline: "Coaching that moves with you.",
        price: "₱597/month",
        description: "For athletes who want personalized structure, adaptive training, and ongoing guidance without hiring a dedicated human coach.",
        features: [
          "Personalized training",
          "Adaptive planning",
          "Readiness and recovery guidance",
          "Progress tracking",
          "Training adjustments based on your data",
          "Built for independent athletes"
        ],
        note: "Athlevo AI is the Athlevo app: your plan, readiness, progress, and coaching guidance in one place.",
        cta: "Explore Athlevo AI",
        href: "#ai"
      },
      {
        type: "COACH-BUILT PLAN",
        name: "Athlevo Plan",
        headline: "A plan built for you.",
        price: "₱1,998/month",
        description: "For athletes who want a real Athlevo coach to assess their goals, training history, schedule, and current fitness, then build a personalized plan for them to follow.",
        features: [
          "Complete onboarding and detailed training questions",
          "Speak with an Athlevo coach through a call and Messenger",
          "Coach reviews goals, experience, schedule, recent training, strengths, weaknesses, and constraints",
          "Personalized running + strength plan",
          "Built around your actual goal and available training time",
          "Follow the plan independently"
        ],
        note: "A personalized coach-built plan — not ongoing daily coaching — for athletes who want expert programming and can execute independently.",
        cta: "Get My Training Plan",
        href: "#coaching"
      },
      {
        type: "HUMAN COACHING",
        name: "Athlevo Coaching",
        headline: "A coach in your corner.",
        price: "₱4,998/month",
        description: "For athletes who want an Athlevo coach actively responsible for their training and development.",
        features: [
          "Individual athlete assessment",
          "Personalized running + strength programming",
          "Ongoing progress review",
          "Human feedback",
          "Training adjustments",
          "Race preparation",
          "Accountability",
          "Coach-athlete communication",
          "Development over time, not just a one-time plan"
        ],
        note: "An Athlevo coach manages your training process, reviews progress, and changes the plan when needed.",
        cta: "Start Coaching",
        href: "#coaching"
      },
      {
        type: "FOUNDER COACHING",
        name: "Athlevo Elite",
        headline: "Coached personally by Dean.",
        price: "₱7,998/month",
        description: "Athlevo’s highest-touch coaching service. You become one of Dean Castro’s personally coached athletes.",
        features: [
          "Personally coached by Dean Castro, Founder & Head Coach",
          "Full individualized running + strength programming",
          "Frequent review of every relevant training signal",
          "Plan adjusted whenever necessary",
          "Direct coach-athlete communication",
          "Race strategy and performance development",
          "Higher-touch accountability and decision-making"
        ],
        note: "When available, Dean considers recent training, session performance, fatigue, sleep, HRV, recovery, soreness, heat and humidity, schedule and life stress, race demands, and training response over time. Personally handled by Dean; availability is limited by coaching capacity.",
        cta: "Apply for Elite Coaching",
        href: "#coaching"
      }
    ],
    // Approved athlete feedback and photography recovered from the original
    // Athlevo coaching-testimonial implementation (b6ba8d2 / a525584).
    // Keep quotes verbatim and add no result unless it is present in this data.
    athleteStories: [
      {
        image: "assets/testimonials/christian-francia.jpg",
        imageAlt: "Christian Francia running in a race",
        imagePosition: "center 35%",
        name: "Christian Francia",
        context: "Marathon Runner",
        quote: "“100% mai-improve ang fitness level mo at mas maaabot mo ang goals mo with the help of Athlevo Coaching.”"
      },
      {
        image: "assets/testimonials/rodel-mark.jpg",
        imageAlt: "Rodel Mark standing on a running track",
        imagePosition: "center 45%",
        name: "Rodel Mark",
        context: "Athlete · Sub-19 5K",
        quote: "“Maraming salamat, Athlevo! Dahil sa coaching, nakuha ko ang sub-19. Sobrang laki ng improvement ko since I started.”"
      },
      {
        image: "assets/testimonials/carl-zita.jpg",
        imageAlt: "Carl Zita seated outdoors",
        imagePosition: "center 30%",
        name: "Carl Zita",
        context: "Recreational Runner",
        quote: "“Effective program, quality sessions, and very informative coaching.”"
      },
      {
        image: "assets/testimonials/amir-paule.jpg",
        imageAlt: "Amir Paule holding a race bib on a running track",
        imagePosition: "center 38%",
        name: "Amir Paule",
        context: "Athlete",
        quote: "“Solid Athlevo! Mag-i-improve ka talaga.”"
      },
      {
        image: "assets/testimonials/jb-luna.jpg",
        imageAlt: "JB Luna holding a race medal outdoors",
        imagePosition: "center 40%",
        name: "JB Luna",
        context: "Recreational Runner",
        quote: "“Athlevo has been an amazing coach. I’ve never felt stronger, faster, and more motivated. The personalized training made a huge impact on my running journey.”"
      },
      {
        image: "assets/testimonials/miguel-bulado.jpg",
        imageAlt: "Miguel Bulado holding his second-place award",
        imagePosition: "center 44%",
        name: "Miguel Bulado",
        context: "Student Athlete",
        quote: "“Athlevo doesn’t just give me training programs. It also emphasizes the importance of quality training days and prioritizing recovery. I’m deeply thankful for the guidance during my final year as a student athlete at Pampanga State University.”"
      }
    ],
    coachingTiers: [
      {
        name: "Athlevo Plan",
        price: "₱1,998/month",
        description: "Personalized running + strength plan built by an Athlevo coach after reviewing your goals, training history, schedule, and current fitness.",
        bestFor: "Athletes who mainly need a clear plan and can execute independently.",
        core: false
      },
      {
        name: "Athlevo Coaching",
        price: "₱4,998/month",
        description: "Weekly human coaching, review, feedback, and adjustments.",
        bestFor: "Athletes who want someone actively guiding the training process.",
        core: true
      },
      {
        name: "Athlevo Elite",
        price: "₱7,998/month",
        description: "Closer monitoring, more frequent adjustments, priority communication, and deeper performance management.",
        bestFor: "Athletes who want high-touch coaching.",
        core: false
      }
    ],
    methodPrinciples: [
      { name: "Individualization", description: "Training based on the athlete, not the template." },
      { name: "Specificity", description: "Training evolves toward what the goal actually requires." },
      { name: "Total load", description: "Running, strength, other sports, work, and recovery all count." },
      { name: "Progression", description: "Enough stress to create adaptation without blindly adding more." },
      { name: "Feedback → Adjustment", description: "Training changes based on what actually happens." }
    ],
    faq: [
      { question: "Do I need to be fast already?", answer: "No. Athlevo starts with your current training, experience, availability, and goal—not an entry standard." },
      { question: "Can beginners join?", answer: "Yes. Beginners can use Athlevo to build consistency and endurance with an appropriate starting structure." },
      { question: "Can I train only three days per week?", answer: "Yes. Training can be structured around the days you can realistically sustain." },
      { question: "Can I keep strength training?", answer: "Yes. Strength work can remain part of the plan and should be considered alongside your total endurance load." },
      { question: "Can Athlevo account for tennis, cycling, hybrid training, or another sport?", answer: "Yes, when that activity and schedule context are available. Athlevo considers the work around your running instead of treating every session in isolation." },
      { question: "What is the difference between Athlevo AI and Human Coaching?", answer: "Athlevo AI is an adaptive system for independent athletes. Human Coaching adds a dedicated person reviewing progress, making adjustments, and guiding the process." },
      { question: "Can I move from AI to Human Coaching later?", answer: "Yes. You can start independently and speak with Athlevo when you want closer human support." },
      { question: "Is Human Coaching online?", answer: "Yes. Athlevo Human Coaching is delivered remotely, so review and guidance can continue wherever you train." },
      { question: "Is strength training included?", answer: "Human Coaching can include personalized running and strength structure. Athlevo AI can also account for strength activity when that context is available." },
      { question: "Do you guarantee race results?", answer: "No responsible coaching can guarantee a result. Athlevo provides individualized structure, feedback, and decision-making support; outcomes still depend on training, health, recovery, and race-day conditions." }
    ]
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function renderTrainingOffers() {
    const root = document.getElementById("landingTrainingOffers");
    if (!root || root.dataset.rendered === "true") return;
    content.trainingOffers.forEach(offer => {
      const article = node("article", "lp-offer");
      const features = node("ul", "lp-offer-features");
      offer.features.forEach(feature => features.append(node("li", "", feature)));
      const cta = node("a", "lp-btn lp-offer-cta", offer.cta);
      cta.href = offer.href;
      article.append(
        node("span", "lp-offer-type", offer.type),
        node("p", "lp-offer-name", offer.name),
        node("h3", "", offer.headline),
        node("p", "lp-offer-price", offer.price),
        node("p", "lp-offer-description", offer.description),
        cta,
        features,
        node("p", "lp-offer-note", offer.note)
      );
      root.append(article);
    });
    root.dataset.rendered = "true";
  }

  function renderStories() {
    const root = document.getElementById("landingAthleteStories");
    if (!root || root.dataset.rendered === "true") return;
    content.athleteStories.forEach(story => {
      const article = node("article", "lp-story");
      const image = node("img", "lp-story-image");
      image.src = story.image;
      image.alt = story.imageAlt;
      image.loading = "lazy";
      image.decoding = "async";
      image.style.objectPosition = story.imagePosition;

      const copy = node("div", "lp-story-copy");
      copy.append(
        node("h3", "", story.name),
        node("p", "lp-story-goal", story.context),
        node("blockquote", "", story.quote)
      );
      article.append(image, copy);
      root.append(article);
    });
    root.dataset.rendered = "true";
  }

  function renderTiers() {
    const root = document.getElementById("landingCoachingTiers");
    if (!root || root.dataset.rendered === "true") return;
    content.coachingTiers.forEach(tier => {
      const article = node("article", `lp-tier${tier.core ? " is-core" : ""}`);
      article.append(
        node("div", "lp-tier-name", tier.name),
        node("div", "lp-tier-price", tier.price),
        node("p", "lp-tier-copy", tier.description)
      );
      const best = node("p", "lp-tier-best");
      best.append(node("strong", "", "Best for"), document.createTextNode(tier.bestFor));
      article.append(best);
      root.append(article);
    });
    root.dataset.rendered = "true";
  }

  function renderMethod() {
    const root = document.getElementById("landingMethodPrinciples");
    if (!root || root.dataset.rendered === "true") return;
    content.methodPrinciples.forEach((principle, index) => {
      const row = node("div", "lp-principle");
      row.append(
        node("span", "lp-principle-index", String(index + 1).padStart(2, "0")),
        node("strong", "lp-principle-name", principle.name),
        node("p", "", principle.description)
      );
      root.append(row);
    });
    root.dataset.rendered = "true";
  }

  function renderFaq() {
    const root = document.getElementById("landingFaq");
    if (!root || root.dataset.rendered === "true") return;
    content.faq.forEach(item => {
      const details = node("details");
      details.append(node("summary", "", item.question), node("div", "lp-faq-body", item.answer));
      root.append(details);
    });
    root.dataset.rendered = "true";
  }

  function render() {
    renderTrainingOffers();
    renderStories();
    renderTiers();
    renderMethod();
    renderFaq();
  }

  global.ATHLEVO_LANDING_CONTENT = content;
  global.renderAthlevoLandingContent = render;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})(window);
