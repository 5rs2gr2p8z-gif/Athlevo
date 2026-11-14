/**
 * Everything the /virtual-run page says and sells, in one place: the Athlevo Sub-1 10k Challenge.
 *
 * This file is the single source of truth for BOTH the page and the server:
 *   - scripts/build-virtual-run-page.mjs writes virtual-run.html from it
 *   - lib/server/virtualRun.js prices every registration from it
 * The browser only ever sends a package id. It never sends a price, and the server ignores one if sent.
 *
 * To change a price, a package, a date, a limit or any wording: edit this file, then run
 *   node scripts/build-virtual-run-page.mjs
 * and deploy. Words wrapped in *asterisks* are the emphasised word in a heading.
 *
 * Registration stays CLOSED until every item under "BEFORE REGISTRATION CAN OPEN" is set (see
 * docs/virtual-run.md). Closed is the default; nothing here can open it by accident.
 */

/* ============================  EDIT THE DATES HERE  ============================ */
/*
 * Every date on the page, in the emails, in the search-engine data and in the server's rules comes from this
 * block and nowhere else. To confirm the dates: fill in startDate, endDate and the deadline, set
 * datesConfirmed to true, run `npm run build:virtual-run`, then `npm run test:virtual-run`, and deploy.
 * Until datesConfirmed is true, every place that would show a date says "Dates to Be Announced" instead, and
 * the server refuses registrations.
 */
export const EVENT = {
  /** Stored on every registration. Do not change once registrations exist. */
  id: "athlevo-sub-1-10k-2026",
  name: "Athlevo Sub-1 10k Challenge",
  weeks: 8,
  /**
   * Flip to true only when the dates below are final. While false the page says "Dates to Be Announced".
   * (The plan under discussion is Dec 1, 2026 to Jan 25, 2027, 8 weeks. It is not confirmed, so it is not entered.)
   */
  datesConfirmed: false,
  /** First day of the challenge, as YYYY-MM-DD (Manila calendar day). null until confirmed. */
  startDate: null,
  /** Last day of the challenge, as YYYY-MM-DD. It must make the challenge exactly `weeks` weeks long. */
  endDate: null
};

export const REGISTRATION = {
  /** When registration opens. ISO time with offset, e.g. "2026-11-20T09:00:00+08:00". null = no opening time. */
  opensAt: null,
  /** The registration deadline, e.g. "2026-11-30T23:59:00+08:00". Registration cannot open without one. */
  deadline: null,
  /** Most registrations for the whole event (paid, plus unpaid ones still holding a spot). null = no limit. */
  limit: null,
  /** How long an unpaid registration holds its spot before the spot is released. */
  holdMinutes: 60
};
/* =============================================================================== */

/* ===========================  EDIT PACKAGES AND PRICES HERE  =========================== */
/**
 * priceCents is pesos x 100 (₱399 = 39900). `physical` packages need a shirt size and a delivery
 * address. `available: false` hides a package from sale. `limit` caps that package (null = none).
 * `productId` is sent to PayMongo and must not change after payments exist.
 */
export const PACKAGES = [
  {
    id: "digital",
    productId: "ATHLEVO_VIRTUAL_RUN_DIGITAL",
    name: "Digital Challenge",
    priceCents: 39900,
    physical: false,
    available: true,
    limit: null,
    features: [
      "Official challenge entry",
      "Standard 8-week training guide",
      "Digital race bib",
      "Digital completion certificate",
      "Challenge leaderboard and result submission"
    ]
  },
  {
    id: "finisher-kit",
    productId: "ATHLEVO_VIRTUAL_RUN_FINISHER_KIT",
    name: "Finisher Kit",
    priceCents: 129900,
    physical: true,
    available: true,
    limit: null,
    features: [
      "Everything in Digital Challenge",
      "Exclusive Athlevo performance shirt",
      "Official finisher medal",
      "Shipping included within the stated delivery coverage"
    ]
  },
  {
    id: "performance-bundle",
    productId: "ATHLEVO_VIRTUAL_RUN_PERFORMANCE_BUNDLE",
    name: "Performance Bundle",
    priceCents: 249900,
    physical: true,
    available: true,
    limit: null,
    features: [
      "Everything in Finisher Kit",
      "Personalized 8-week training plan",
      "Training tailored to fitness, goals, and availability",
      "Individualized running and strength recommendations"
    ]
  }
];
/* ======================================================================================= */

/* =====================  DELIVERY, LEGAL AND ELIGIBILITY (set before launch)  ===================== */
export const DELIVERY = {
  /**
   * Flip to true when the delivery coverage and timing below are final. While false the Finisher Kit
   * and Performance Bundle cannot be bought (the Digital Challenge can). Nobody pays for a shirt and
   * medal that has no confirmed way to reach them.
   */
  confirmed: false,
  /** The stated coverage shown next to "shipping included". */
  coverage: "To be confirmed",
  /** null = every province in the list below. Or an array of province names to limit delivery. */
  provinces: null,
  timing: "Delivery timing is confirmed with the event dates."
};

export const LEGAL = {
  /** Recorded with each registration, so you can tell which wording a runner agreed to. Change it when the documents change. */
  version: "unpublished",
  /** Links to the official event rules and the waiver (an https link or a path on this site). null = not published yet. */
  rulesUrl: null,
  waiverUrl: null,
  privacyUrl: "/privacy",
  termsUrl: "/terms"
};

export const ELIGIBILITY = {
  /** The youngest age that may register on this page. */
  minAge: 18
};

/** Approved merchandise pictures. Put the image path here (e.g. "/assets/virtual-run/shirt.webp") once the designs are approved. */
export const MERCH_ASSETS = {
  shirt: null,
  medal: null
};
/* ============================================================================================= */

export const SITE = {
  canonical: "https://athlevo.org/virtual-run",
  path: "/virtual-run",
  registerApi: "/api/virtual-run/register",
  statusApi: "/api/virtual-run/status",
  availabilityApi: "/api/virtual-run/availability",
  waitlistApi: "/api/virtual-run/waitlist",
  supportEmail: "support@athlevo.org"
};

export const GENDERS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "non-binary", label: "Non-binary" },
  { value: "prefer-not-to-say", label: "Prefer not to say" }
];

export const FREQUENCIES = [
  { value: "0-1", label: "Less than twice a week" },
  { value: "2", label: "2 days" },
  { value: "3", label: "3 days" },
  { value: "4", label: "4 days" },
  { value: "5-plus", label: "5 days or more" }
];

export const GOALS = [
  { value: "finish", label: "Finish my first 10k" },
  { value: "faster", label: "Run my fastest 10k" },
  { value: "sub-60", label: "Run under 60 minutes" },
  { value: "habit", label: "Build a steady running habit" }
];

export const SHIRT_SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL"];

export const PROVINCES = [
  "Abra", "Agusan del Norte", "Agusan del Sur", "Aklan", "Albay", "Antique", "Apayao", "Aurora",
  "Basilan", "Bataan", "Batanes", "Batangas", "Benguet", "Biliran", "Bohol", "Bukidnon", "Bulacan",
  "Cagayan", "Camarines Norte", "Camarines Sur", "Camiguin", "Capiz", "Catanduanes", "Cavite", "Cebu",
  "Cotabato", "Davao de Oro", "Davao del Norte", "Davao del Sur", "Davao Occidental", "Davao Oriental",
  "Dinagat Islands", "Eastern Samar", "Guimaras", "Ifugao", "Ilocos Norte", "Ilocos Sur", "Iloilo",
  "Isabela", "Kalinga", "La Union", "Laguna", "Lanao del Norte", "Lanao del Sur", "Leyte",
  "Maguindanao del Norte", "Maguindanao del Sur", "Marinduque", "Masbate", "Metro Manila",
  "Misamis Occidental", "Misamis Oriental", "Mountain Province", "Negros Occidental", "Negros Oriental",
  "Northern Samar", "Nueva Ecija", "Nueva Vizcaya", "Occidental Mindoro", "Oriental Mindoro", "Palawan",
  "Pampanga", "Pangasinan", "Quezon", "Quirino", "Rizal", "Romblon", "Samar", "Sarangani", "Siquijor",
  "Sorsogon", "South Cotabato", "Southern Leyte", "Sultan Kudarat", "Sulu", "Surigao del Norte",
  "Surigao del Sur", "Tarlac", "Tawi-Tawi", "Zambales", "Zamboanga del Norte", "Zamboanga del Sur",
  "Zamboanga Sibugay"
];

/** The package with this id, or null. */
export function packageById(id) {
  return PACKAGES.find((item) => item.id === id) || null;
}

/** 129900 -> "₱1,299" (cents are whole pesos here; centavos show only when there are some). */
export function formatPeso(cents) {
  const pesos = Number(cents) / 100;
  return "₱" + pesos.toLocaleString("en-US", {
    minimumFractionDigits: Number(cents) % 100 ? 2 : 0,
    maximumFractionDigits: 2
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-12-01" -> "December 1, 2026". Read as a calendar date so no time zone can move it. */
export function formatDay(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ""));
  if (!match) return "";
  return MONTHS[Number(match[2]) - 1] + " " + Number(match[3]) + ", " + match[1];
}

/** A deadline or opening time as a Manila calendar day and time, e.g. "November 30, 2026, 11:59 PM". */
export function formatMoment(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true
  }).formatToParts(new Date(time));
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || "";
  return get("month") + " " + get("day") + ", " + get("year") + ", " + get("hour") + ":" + get("minute") + " " + get("dayPeriod");
}

/** What every unconfirmed date says. */
export const DATES_TBA = "Dates to Be Announced";
const DEADLINE_TBA = "Date to Be Announced";

/** The challenge dates as the page shows them. "Dates to Be Announced" until the dates are confirmed. */
export function eventDatesText(event = EVENT) {
  if (!event.datesConfirmed || !event.startDate || !event.endDate) return DATES_TBA;
  return formatDay(event.startDate) + " to " + formatDay(event.endDate);
}

/** The registration deadline as the page shows it. "Date to Be Announced" until one is set. */
export function deadlineText(registration = REGISTRATION) {
  return registration.deadline ? formatMoment(registration.deadline) : DEADLINE_TBA;
}

/**
 * The second fact in the hero. Once the dates are confirmed and there is a deadline it says when registration
 * closes. Before that it says registration is opening soon, never a date nobody has confirmed.
 */
export function registrationFact(event = EVENT, registration = REGISTRATION, hero = HERO) {
  if (event.datesConfirmed && registration.deadline) return { label: hero.factLabels.deadline, value: deadlineText(registration) };
  return { label: hero.factLabels.registration, value: hero.registrationSoon };
}

/** A YYYY-MM-DD calendar day as a day number, or null when it is not a real day (2026-02-31 is not). */
function dayNumber(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const back = new Date(time);
  if (back.getUTCFullYear() !== Number(match[1]) || back.getUTCMonth() !== Number(match[2]) - 1 || back.getUTCDate() !== Number(match[3])) return null;
  return time / 86400000;
}

/**
 * What is wrong with the dates, as plain sentences. Empty means they can be shown. Nothing is checked while
 * datesConfirmed is false, because nothing is shown then. The page build and the server both refuse
 * confirmed dates that fail this, so a typo cannot reach the public page.
 */
export function eventDateProblems(event = EVENT, registration = REGISTRATION) {
  if (!event.datesConfirmed) return [];
  const problems = [];
  const start = dayNumber(event.startDate);
  const end = dayNumber(event.endDate);
  if (start === null) problems.push("EVENT.startDate must be a real day written YYYY-MM-DD");
  if (end === null) problems.push("EVENT.endDate must be a real day written YYYY-MM-DD");
  if (start !== null && end !== null) {
    if (end <= start) problems.push("EVENT.endDate must be after EVENT.startDate");
    else if (end - start + 1 !== Number(event.weeks) * 7) {
      problems.push("the dates cover " + (end - start + 1) + " days, but the page says " + event.weeks + " weeks (" + Number(event.weeks) * 7 + " days)");
    }
  }
  const opens = registration.opensAt ? Date.parse(registration.opensAt) : null;
  const deadline = registration.deadline ? Date.parse(registration.deadline) : null;
  if (registration.opensAt && !Number.isFinite(opens)) problems.push("REGISTRATION.opensAt is not a date and time with a time zone");
  if (registration.deadline && !Number.isFinite(deadline)) problems.push("REGISTRATION.deadline is not a date and time with a time zone");
  if (Number.isFinite(opens) && Number.isFinite(deadline) && opens >= deadline) problems.push("REGISTRATION.opensAt must be before REGISTRATION.deadline");
  if (Number.isFinite(deadline) && end !== null && deadline >= Date.parse(event.endDate + "T23:59:59+08:00")) {
    problems.push("REGISTRATION.deadline must be before the challenge ends");
  }
  return problems;
}

export const PAGE = {
  title: "Athlevo Sub-1 10k Challenge | 8-Week Virtual 10k Run",
  description: "An 8-week virtual running challenge from Athlevo, designed to help you chase a sub-60-minute 10k. Run your own 10k, wherever you are.",
  ogTitle: "Athlevo Sub-1 10k Challenge",
  ogDescription: "8 weeks. One goal. Your fastest 10k. A structured virtual running challenge from Athlevo."
};

export const HERO = {
  eyebrow: "Athlevo Sub-1 10k Challenge",
  headline: "8 weeks. One goal. Your fastest 10k.",
  supporting: "A structured virtual running challenge designed to help you chase a sub-60-minute 10k.",
  primary: "Register now",
  secondary: "How it works",
  factLabels: { dates: "Challenge dates", deadline: "Registration closes", registration: "Registration", format: "Format" },
  /** The registration fact until the dates are confirmed and a deadline is set. */
  registrationSoon: "Opening soon",
  /** Shown instead of "Register now" while registration is not open. */
  soon: { badge: "Registration opening soon", primary: "Join the priority list", nav: "Join the list" },
  format: "Virtual. Run your own 10k.",
  note: "Finish a 10k and you are a finisher. Run it in under 60 minutes, with a result we can verify, and you have earned Sub-1. The challenge gives you the structure to chase that time. It does not promise it."
};

/** What the registration status line says before a runner can register. */
export const STATES = {
  checking: "Checking registration.",
  open: "",
  not_open: "Registration opens soon. Join the priority list to hear first.",
  closed: "Registration is closed.",
  sold_out: "This challenge is full.",
  unavailable: "We could not check registration right now. Please try again in a moment."
};

export const HOW = {
  eyebrow: "How it works",
  heading: "Five steps. *Eight* weeks.",
  steps: [
    "Register and select your package.",
    "Complete your running assessment.",
    "Follow your 8-week training program.",
    "Run and record your 10k.",
    "Submit your result and claim your earned rewards."
  ]
};

export const RESULTS = {
  eyebrow: "Two results",
  heading: "Finishing is one result. *Sub-1* is another.",
  cards: [
    {
      label: "Finisher",
      rule: "Run a 10k and submit your result.",
      text: "Any finishing time counts. You earn your certificate of completion, plus the finisher shirt and medal if your package includes them."
    },
    {
      label: "Sub-1",
      rule: "Run a 10k in under 60:00.",
      text: "Your result is verified against the official event rules before it is recognised as Sub-1. Verified Sub-1 finishers also earn a Sub-1 certificate."
    }
  ],
  line: "We cannot promise a sub-60 time. Your result depends on your fitness, your consistency and the day you run."
};

export const PACKAGES_COPY = {
  eyebrow: "Packages",
  heading: "Choose your *package*.",
  intro: "Every package includes official entry and the standard 8-week training guide. Pick how much more you want.",
  choose: "Choose",
  coverageLabel: "Delivery coverage",
  states: {
    available: "",
    soon: "Opens with registration",
    sold_out: "Sold out",
    closed: "Not available"
  }
};

export const MERCH = {
  shirt: {
    eyebrow: "Official finisher shirt",
    heading: "The Athlevo *performance* shirt.",
    text: "Made exclusively for this challenge. Included with the Finisher Kit and the Performance Bundle.",
    included: "Finisher Kit, Performance Bundle",
    part: "Official finisher rewards",
    placeholder: "Official design to be revealed",
    alt: "The official Athlevo Sub-1 10k Challenge finisher shirt."
  },
  medal: {
    eyebrow: "Official finisher medal",
    heading: "The medal you *earn*.",
    text: "Awarded for completing your 10k. Included with the Finisher Kit and the Performance Bundle.",
    included: "Finisher Kit, Performance Bundle",
    part: "Official finisher rewards",
    placeholder: "Official design to be revealed",
    alt: "The official Athlevo Sub-1 10k Challenge finisher medal."
  },
  labels: { included: "Included with", sizes: "Sizes", part: "Part of" }
};

/** The answer to "when is it?": the confirmed dates, or an honest "not yet". */
export function startAnswer(event = EVENT) {
  if (event.datesConfirmed && event.startDate && event.endDate) {
    return "The challenge runs for " + event.weeks + " weeks, from " + formatDay(event.startDate) + " to " + formatDay(event.endDate) + ".";
  }
  return DATES_TBA + ". The challenge is " + event.weeks + " weeks long. Join the priority list and we will email you as soon as the dates are confirmed.";
}

export const FAQ = {
  eyebrow: "Questions",
  heading: "Before you *register*.",
  items: [
    {
      q: "When is the challenge?",
      a: startAnswer()
    },
    {
      q: "Is this a live race?",
      a: "No. It is a virtual challenge. You train for eight weeks, then run your 10k yourself and submit your result."
    },
    {
      q: "What if I have never run a 10k?",
      a: "You can still register. The challenge is built to take you from where you are. Share your current 5k and 10k times if you have them, and leave them blank if you do not."
    },
    {
      q: "Is a sub-60 10k guaranteed?",
      a: "No. The plan gives you structure to chase it. Your result depends on your fitness, your consistency and the day you run."
    },
    {
      q: "What is the difference between finishing and Sub-1?",
      a: "Finishing means you ran a 10k and submitted your result, at any time. Sub-1 means a 10k under 60:00 that has been verified against the official event rules."
    },
    {
      q: "What is the difference between the packages?",
      a: "The Digital Challenge is your entry, the standard training guide, a digital bib, a certificate and the leaderboard. The Finisher Kit adds the performance shirt and finisher medal. The Performance Bundle adds a personalized 8-week plan built around your fitness, goals and availability."
    },
    {
      q: "How does delivery work?",
      a: "Shipping is included within the stated delivery coverage. We collect your size and address when you register. Delivery coverage and timing are shown with the packages."
    },
    {
      q: "What about refunds and changes?",
      a: "They are covered in the official event rules, which you agree to when you register."
    },
    {
      q: "What if I have pain or an injury?",
      a: "See a doctor or physiotherapist before you start. We share general guidance for healthy runners and cannot diagnose anything."
    }
  ]
};

/* =====================  PRIORITY LIST (people who want to hear first)  ===================== */
export const WAITLIST = {
  /** false hides the priority list. The registration form is not affected. */
  enabled: true,
  /**
   * Recorded with every sign-up, with the time, so you can show which consent wording a person agreed to.
   * Change it whenever the consent sentence below (or the privacy policy it points to) changes.
   */
  consentVersion: "2026-11-a",
  eyebrow: "Registration opening soon",
  heading: "Join the *priority* list.",
  text: "Registration opens soon. Runners on the priority list get the registration link first. Add your name and email and we will write to you when it opens.",
  points: ["Nothing to pay now.", "We ask only for your name and email.", "Leave the list whenever you like."],
  labels: { fullName: "Full name", email: "Email address" },
  consent: "Email me about the Athlevo Sub-1 10k Challenge, including when registration opens. I can unsubscribe at any time. I have read the {privacy}.",
  privacyLink: "privacy policy",
  submit: "Join the priority list",
  sending: "Joining the list",
  unavailable: "The priority list is not taking sign-ups right now. Check back soon or email {email}.",
  noscript: "The priority list needs JavaScript. Turn it on, or email {email}.",
  errors: {
    fullName: "Enter your full name.",
    email: "Enter a valid email address.",
    consent: "Tick the box so we know we may email you.",
    rate: "You have tried a few times. Please wait a few minutes and try again.",
    failed: "We could not save that. Please try again in a moment, or email {email}."
  },
  done: {
    heading: "You are on the *list*.",
    text: "We will email you when registration opens. Nothing has been charged.",
    note: "If you do not see our email, check your spam folder."
  },
  leave: {
    heading: "Leave the priority list?",
    text: "You will stop getting emails about the Athlevo Sub-1 10k Challenge.",
    confirm: "Yes, remove me",
    cancel: "Keep me on the list",
    working: "Removing you",
    doneHeading: "You have left the list.",
    doneText: "You will not get more emails about the challenge. You can join again whenever you like.",
    invalid: "That link is not complete or has already been used. Use the link in the latest email we sent you, or write to {email} and we will remove you.",
    failed: "We could not do that just now. Please try again in a moment, or email {email}."
  }
};

/** The e-mail a person gets after joining the priority list (lib/server/virtualRunWaitlist.js sends it). */
export const WAITLIST_EMAIL = {
  subject: "You are on the Athlevo Sub-1 10k Challenge priority list",
  intro: "You are on the priority list for the Athlevo Sub-1 10k Challenge.",
  next: "When registration opens we will email you the registration link first. Nothing has been charged.",
  datesPending: "The challenge dates are still to be announced.",
  leaveLine: "Changed your mind? You can leave the list here:",
  why: "You are getting this because you joined the priority list at athlevo.org/virtual-run."
};

export const FORM = {
  eyebrow: "Register",
  heading: "Register for the *challenge*.",
  subtext: "Four short steps. You pay at the end, and your spot is confirmed when your payment is.",
  stepTitles: ["About you", "Your running", "Your package", "Review and pay"],
  stepLabel: "Step",
  of: "of",
  next: "Continue",
  back: "Back",
  choose: "Choose one",
  labels: {
    fullName: "Full name",
    email: "Email address",
    mobile: "Mobile number",
    dob: "Date of birth",
    gender: "Gender (optional)",
    pb5k: "Current 5k personal best",
    pb10k: "Current 10k personal best",
    pbHint: "For example 24:30 or 1:05:00. Leave blank if you do not have one yet.",
    frequency: "How many days a week do you run?",
    goal: "Your main goal for the challenge",
    package: "Your package",
    shirtSize: "Shirt size",
    recipient: "Recipient name",
    address: "Street address, building or unit",
    province: "Province",
    city: "City or municipality",
    barangay: "Barangay",
    postal: "Postal code"
  },
  delivery: "Delivery details",
  deliveryNote: "Used only to send your shirt and medal.",
  review: {
    heading: "Check your details",
    edit: "Edit",
    labels: {
      name: "Name", email: "Email", mobile: "Mobile", package: "Package", size: "Shirt size", ship: "Deliver to", total: "Total"
    },
    rules: "I have read and agree to the {rules} and the {waiver}.",
    rulesLink: "official event rules",
    waiverLink: "waiver",
    privacy: "I have read the {privacy} and agree that Athlevo may use my details to run this challenge and deliver my rewards.",
    privacyLink: "privacy policy",
    pay: "Pay and register",
    payWith: "Pay {total} and register",
    paymentNote: "Payment is handled by PayMongo. You choose how to pay on the next screen. Your spot is confirmed only when your payment is.",
    processing: "Opening secure payment"
  },
  errors: {
    fullName: "Enter your full name.",
    email: "Enter a valid email address.",
    mobile: "Enter a mobile number we can reach.",
    dob: "Enter your date of birth.",
    dobAge: "You must be {age} or older to register here.",
    gender: "Choose one of the options, or leave it blank.",
    pb5k: "Enter a time like 24:30, or leave it blank.",
    pb10k: "Enter a time like 52:10 or 1:05:00, or leave it blank.",
    frequency: "Choose how many days a week you run.",
    goal: "Choose your main goal.",
    package: "Choose a package.",
    shirtSize: "Choose a shirt size.",
    recipient: "Enter the name of the person receiving the delivery.",
    address: "Enter your street address.",
    province: "Choose your province.",
    city: "Enter your city or municipality.",
    barangay: "Enter your barangay.",
    postal: "Enter a 4-digit postal code.",
    rules: "Agree to the event rules and waiver to continue.",
    privacy: "Agree to the privacy policy to continue.",
    summary: "Check the highlighted fields.",
    submit: "We could not start your payment. Please try again. If it keeps happening, email {email}.",
    closed: "Registration is not open right now.",
    full: "This package is full.",
    already: "This email is already registered for the challenge. Check your inbox for your confirmation, or email {email}.",
    rate: "You have tried a few times. Please wait a few minutes and try again.",
    delivery: "We cannot deliver to that province yet."
  }
};

export const CONFIRMATION = {
  checking: {
    heading: "Confirming your payment.",
    text: "This usually takes a few seconds. Please keep this page open."
  },
  paid: {
    eyebrow: "Registration confirmed",
    heading: "You are *in*.",
    line: "Your payment is confirmed. Here is your registration.",
    labels: { name: "Name", id: "Registration ID", package: "Package" },
    emailSent: "We have emailed your confirmation.",
    stepsHeading: "What happens next",
    steps: [
      "Keep your registration ID. It is your race bib number and how we find you.",
      "Complete your running assessment. We will send you the link by email.",
      "Your 8-week training program opens when the challenge starts. We will email you how to access it.",
      "Run and record your 10k, then submit your result to claim your rewards."
    ],
    performanceStep: "Your personalized training plan is built from your assessment.",
    assessmentLink: "Open your running assessment",
    trainingLink: "Open your training guide"
  },
  pending: {
    heading: "We have not seen your payment yet.",
    text: "Your registration is saved. If you paid, it can take a few minutes to show. You will get an email when it is confirmed. If nothing arrives within an hour, email {email} with the name you registered under.",
    retry: "Check again"
  },
  cancelled: {
    heading: "Payment was not completed.",
    text: "Nothing was charged. Your spot is held for a short time. Choose your package again to pay."
  },
  failed: {
    heading: "We could not check your registration.",
    text: "Please try again in a moment, or email {email}."
  }
};

export const FOOTER = [
  "Athlevo Coaching · athlevo.org",
  "General guidance for healthy runners. If something hurts or feels wrong, stop and see a doctor. We do not promise finish times or placings."
];

/** The e-mail subject and wording for the participant's confirmation (lib/server/virtualRun.js sends it). */
export const EMAIL = {
  subject: "You are registered: Athlevo Sub-1 10k Challenge",
  intro: "Your payment is confirmed and your registration is complete.",
  steps: CONFIRMATION.paid.steps
};
