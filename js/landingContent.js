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
        type: "ADAPTIVE SELF-GUIDED COACHING",
        name: "Athlevo AI",
        headline: "Stop guessing. Start training toward something.",
        price: "₱597/month",
        bestFor: "Athletes who want structure, adaptation, and daily direction without hiring a dedicated coach.",
        description: "Whether you’re chasing your first 5K, a faster time, or your next marathon, Athlevo gives you a training plan built around where you are now — and adjusts the direction as your training, recovery, and life change.",
        features: [
          "Know exactly what to train today",
          "Build toward your race or performance goal",
          "Adjust when training doesn’t go to plan",
          "Know when to push — and when not to",
          "See whether your fitness is actually moving forward",
          "Train with structure without hiring a coach"
        ],
        note: "A coaching system for athletes who want direction, structure, and adaptation while still training independently.",
        cta: "Build My Training Plan",
        href: "#ai"
      },
      {
        type: "PROGRAM + MONTHLY EXPERT REVIEW",
        name: "Athlevo Plan",
        headline: "A plan built for you.",
        price: "₱1,998/month",
        bestFor: "Athletes who can train independently but want personalized structure and monthly expert review.",
        description: "An Athlevo coach learns your goal, current fitness, training history, schedule, and constraints, then builds your personalized running + strength plan. You follow the plan independently, with a monthly review and one plan update to keep the structure aligned with your progress.",
        features: [
          "Detailed athlete onboarding",
          "One onboarding call",
          "Personalized running + strength plan",
          "Monthly progress review",
          "One monthly plan update",
          "Messenger support for plan clarifications",
          "Programming built around your race, schedule, and current fitness"
        ],
        note: "You follow the plan independently. Athlevo Plan gives you expert programming and a monthly check-in without ongoing coach management.",
        cta: "Build My Plan",
        href: "#coaching"
      },
      {
        type: "WEEKLY COACH INVOLVEMENT",
        name: "Athlevo Coaching",
        headline: "A coach guiding the process.",
        price: "₱4,998/month",
        bestFor: "Athletes who want weekly accountability, feedback, and ongoing adjustments.",
        description: "For athletes who want an Athlevo coach actively involved in guiding their training and development. Your coach reviews how training is going, gives feedback, adjusts the plan when needed, and helps keep the build moving toward your race or performance goal.",
        features: [
          "Personalized running + strength programming",
          "Weekly training review",
          "Plan adjustments when needed",
          "Feedback on key sessions",
          "Direct Messenger access",
          "Accountability and progress guidance",
          "Schedule-change support",
          "Race pacing and strategy",
          "Ongoing development across the training block"
        ],
        note: "This is ongoing coaching — not just a plan. Your coach stays involved throughout the training block and helps make the decisions when training changes.",
        cta: "Start My Coaching",
        href: "#coaching"
      },
      {
        type: "FOUNDER-LED PERFORMANCE MANAGEMENT",
        name: "Athlevo Elite",
        headline: "Personally coached by Dean.",
        price: "₱7,998/month",
        bestFor: "Athletes who want close performance management and direct access to the founder and head coach.",
        description: "Athlevo Elite is the highest-touch coaching service. Dean personally manages your training as an evolving performance project — reviewing how you respond, making decisions more frequently, and integrating your running, strength, recovery, and race preparation around the result you are chasing.",
        features: [
          "Personally coached by Dean Castro",
          "More frequent training review",
          "More frequent adjustments when needed",
          "Deeper performance analysis",
          "Direct priority communication",
          "Calls as needed for important decisions",
          "Integrated running + strength development",
          "Recovery and fatigue considered in decision-making",
          "Race-specific preparation and strategy",
          "Closer management across the entire performance build"
        ],
        note: "When useful and available, Dean may account for recent training, session performance, fatigue, sleep, HRV, soreness, recovery, heat and humidity, life stress, race demands, and response to previous training. Capacity is naturally limited because Dean personally manages these athletes.",
        cta: "Apply for Elite",
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
      const bestFor = node("div", "lp-offer-best");
      bestFor.append(node("span", "", "BEST FOR"), node("p", "", offer.bestFor));
      article.append(
        node("span", "lp-offer-type", offer.type),
        node("p", "lp-offer-name", offer.name),
        node("h3", "", offer.headline),
        node("p", "lp-offer-price", offer.price),
        bestFor,
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
    renderMethod();
    renderFaq();
  }

  global.ATHLEVO_LANDING_CONTENT = content;
  global.renderAthlevoLandingContent = render;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})(window);
