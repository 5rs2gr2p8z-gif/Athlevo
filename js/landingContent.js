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
    // PHOTO/COPY REPLACEMENT: replace every ATHLETE_STORY_* placeholder only
    // after the athlete has approved the name, image, result, and quote.
    athleteStories: [
      {
        imageSlot: "ATHLETE_STORY_01",
        image: null,
        imageAlt: "",
        name: "Athlete name to be supplied",
        goal: "Event / goal to be supplied",
        startingPoint: "Starting point to be supplied",
        focus: "Coaching focus to be supplied",
        result: "Verified result to be supplied",
        quote: "Approved athlete quote to be supplied",
        resultImage: null
      },
      {
        imageSlot: "ATHLETE_STORY_02",
        image: null,
        imageAlt: "",
        name: "Athlete name to be supplied",
        goal: "Event / goal to be supplied",
        startingPoint: "Starting point to be supplied",
        focus: "Coaching focus to be supplied",
        result: "Verified result to be supplied",
        quote: "Approved athlete quote to be supplied",
        resultImage: null
      },
      {
        imageSlot: "ATHLETE_STORY_03",
        image: null,
        imageAlt: "",
        name: "Athlete name to be supplied",
        goal: "Event / goal to be supplied",
        startingPoint: "Starting point to be supplied",
        focus: "Coaching focus to be supplied",
        result: "Verified result to be supplied",
        quote: "Approved athlete quote to be supplied",
        resultImage: null
      }
    ],
    coachingTiers: [
      {
        name: "Athlevo Plan",
        price: "₱1,998/month",
        description: "Personalized running and strength structure with monthly human review.",
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

  function appendDefinition(list, term, description) {
    const group = node("div", "lp-story-detail");
    group.append(node("dt", "", term), node("dd", "", description));
    list.append(group);
  }

  function renderStories() {
    const root = document.getElementById("landingAthleteStories");
    if (!root || root.dataset.rendered === "true") return;
    content.athleteStories.forEach(story => {
      const article = node("article", "lp-story");
      let image;
      if (story.image) {
        image = node("img", "lp-story-image");
        image.src = story.image;
        image.alt = story.imageAlt;
        image.loading = "lazy";
        image.decoding = "async";
      } else {
        image = node("div", "lp-editorial-media lp-story-image");
        image.dataset.imageSlot = story.imageSlot;
        image.setAttribute("aria-hidden", "true");
      }

      const copy = node("div", "lp-story-copy");
      copy.append(node("h3", "", story.name), node("p", "lp-story-goal", story.goal));
      const details = node("dl");
      appendDefinition(details, "Starting point", story.startingPoint);
      appendDefinition(details, "What Athlevo worked on", story.focus);
      appendDefinition(details, "Result", story.result);
      copy.append(details, node("blockquote", "", story.quote));

      if (story.resultImage) {
        const resultImage = node("img", "lp-story-result-image");
        resultImage.src = story.resultImage.src;
        resultImage.alt = story.resultImage.alt;
        resultImage.loading = "lazy";
        resultImage.decoding = "async";
        copy.append(resultImage);
      }
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
