/**
 * Everything the /webinar and /webinar/thank-you pages say, in one place.
 *
 * To change the date or time, edit the two lines under SESSION below, then run:
 *   node scripts/build-webinar-pages.mjs
 * That rewrites webinar.html and webinar-thank-you.html (the date and time appear on both).
 *
 * Any other copy can be edited here too and rebuilt the same way. Words wrapped in
 * *asterisks* are the emphasised word in a heading. This file holds text only; the
 * markup is in scripts/build-webinar-pages.mjs and the look is in store.css + webinar.css.
 * Do not add copy to the HTML files by hand: the next build overwrites them.
 */

/* ======================  EDIT THE DATE AND TIME HERE  ====================== */
export const SESSION = {
  date: "To be announced",
  time: "To be announced"
};
/* ========================================================================== */

export const SITE = {
  canonical: "https://programs.athlevo.org/webinar/",
  thankYouPath: "/webinar/thank-you",
  registerApi: "/api/webinar/register"
};

/**
 * The details block, shared by both pages. Date and time come from SESSION above.
 */
export function sessionDetails(session = SESSION) {
  return [
    ["Date", session.date],
    ["Time", session.time],
    ["Format", "Live online, with Q&A"],
    ["Cost", "Free"]
  ];
}

/**
 * The form's choices. `value` is what is sent and stored; `label` is what the runner reads.
 * lib/server/webinarRegistration.js accepts exactly these values.
 */
export const DISTANCES = [
  { value: "5k", label: "5k" },
  { value: "10k", label: "10k" },
  { value: "16k", label: "16k" },
  { value: "not-registered", label: "Not registered yet" }
];

export const TRAINING = [
  { value: "no-plan", label: "No set plan. I run when I can" },
  { value: "loose-routine", label: "A loose weekly routine" },
  { value: "structured-plan", label: "I follow a structured plan" }
];

export const LANDING = {
  title: "Free Online Session for Ignite the Grit Run Runners | Athlevo Coaching",
  description: "Athlevo Coaching is online endurance coaching for Filipino runners. Join our free online session with Q&A for runners at Ignite the Grit Run on November 22, 2026.",
  ogTitle: "Athlevo Coaching: free online session for Ignite the Grit Run runners",
  ogDescription: "Online endurance coaching for Filipino runners. Join our free live session with Q&A, in partnership with JCIR Events Management.",

  hero: {
    eyebrow: "Athlevo Coaching",
    headline: "Stop *guessing* your training.",
    supporting: "Online endurance coaching for Filipino runners who are committed to the personal pursuit of excellence.",
    button: "Join the free session",
    small: "Free online session for runners at Ignite the Grit Run, in partnership with JCIR Events Management."
  },

  how: {
    eyebrow: "How Athlevo works",
    heading: "Coaching built around *you*.",
    cards: [
      { number: "01", title: "Personal", text: "Training built around your fitness, your schedule and your race goal." },
      { number: "02", title: "Running and strength", text: "Running coaches and a strength and conditioning coach, working on one team." },
      { number: "03", title: "Coached, not just planned", text: "Coach support with regular reviews, assessments and adjustments as you train." }
    ],
    line: "Plans start at ₱1,998/month."
  },

  coach: {
    eyebrow: "Your coach",
    heading: "Dean *Castro*",
    text: "Dean is a competitive runner and the founder of Athlevo Coaching. He has coached more than 300 runners online, with training built around each runner's fitness, schedule and race goal.",
    credentials: ["USATF Level 1 coach", "STRYD Certified Running Coach"]
  },

  session: {
    eyebrow: "Free online session",
    heading: "A free session for *Ignite* the Grit Run runners.",
    intro: "We are teaching a live online session with Q&A for runners at Ignite the Grit Run on November 22, 2026, in partnership with JCIR Events Management. Everyone is welcome.",
    whoLabel: "Who it's for",
    who: "Made for runners who train without a structured plan. If you already follow a periodized plan, this one may be too basic, but you are welcome to join the Q&A."
  },

  form: {
    heading: "Save your seat",
    subtext: "Free. We will send the link and reminders by message.",
    labels: {
      name: "Full name",
      mobile: "Mobile number (for the link and reminders)",
      email: "Email (optional)",
      distance: "Your race distance",
      training: "How do you train right now?",
      question: "A question for the session (optional)"
    },
    choose: "Choose one",
    submit: "Register free",
    help: "We use your details to send the session link and reminders, and to follow up about Athlevo Coaching. Reply STOP to any message to opt out.",
    errors: {
      name: "Enter your full name.",
      mobile: "Enter a mobile number we can message.",
      email: "Enter a valid email address.",
      distance: "Choose your race distance.",
      training: "Choose how you train right now.",
      submit: "Something went wrong. Please try again, or message Athlevo Coaching on Instagram or Facebook."
    }
  },

  faq: {
    heading: "Before you *register*.",
    items: [
      {
        q: "Is it really free?",
        a: "Yes. There is nothing to buy. At the end we will explain how Athlevo Coaching works, and runners registered for JCIR races get 10% off if they want to continue. There is no pressure."
      },
      {
        q: "Do I need to be registered for Ignite the Grit Run?",
        a: "The session is made for runners at this race, but you can register either way. Choose \"Not registered yet\" for your distance."
      },
      {
        q: "Who is the session for?",
        a: "Runners who train without a structured plan. If you already follow a periodized plan, this one may be too basic, but you are welcome to join the Q&A."
      },
      {
        q: "Will there be a replay?",
        a: "Yes. We record the session and send the replay to everyone who registers."
      },
      {
        q: "What if I have pain or an injury?",
        a: "See a doctor or physiotherapist. We share general guidance for healthy runners and cannot diagnose anything."
      }
    ]
  },

  closing: {
    heading: "Join the free session with *Athlevo*.",
    button: "Register free"
  },

  footer: [
    "Athlevo Coaching · athlevo.org · In partnership with JCIR Events Management.",
    "General guidance for healthy runners. If something hurts or feels wrong, stop and see a doctor. We do not promise finish times or placings."
  ]
};

export const THANKS = {
  title: "You're registered | Athlevo Coaching",
  eyebrow: "Registration received",
  heading: "You're *in*.",
  line: "Thank you. Here is what happens next.",
  steps: [
    { title: "Watch your messages", text: "We will send the session link and reminders to the mobile number you gave." },
    { title: "Send us your questions", text: "Reply to any message with what you want covered. We will answer as many as we can live." }
  ],
  event: "Ignite the Grit Run · November 22, 2026 · In partnership with JCIR Events Management.",
  footer: [
    "Athlevo Coaching · athlevo.org",
    "General guidance for healthy runners. If something hurts or feels wrong, stop and see a doctor."
  ]
};
