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
export const EVENT = {
  /** Stored on every registration. Do not change once registrations exist. */
  id: "athlevo-sub-1-10k-2026",
  name: "Athlevo Sub-1 10k Challenge",
  weeks: 8,
  /**
   * Flip to true only when the dates below are final. While false the page says "To be announced"
   * and the server refuses registrations.
   * startDate and endDate are the Dec 1 to Jan 25 plan (8 weeks) and are NOT confirmed.
   */
  datesConfirmed: false,
  startDate: "2026-12-01",
  endDate: "2027-01-25"
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

/** The challenge dates as the page shows them. "To be announced" until the dates are confirmed. */
export function eventDatesText(event = EVENT) {
  if (!event.datesConfirmed || !event.startDate || !event.endDate) return "To be announced";
  return formatDay(event.startDate) + " to " + formatDay(event.endDate);
}

/** The registration deadline as the page shows it. "To be announced" until one is set. */
export function deadlineText(registration = REGISTRATION) {
  return registration.deadline ? formatMoment(registration.deadline) : "To be announced";
}

export const PAGE = {
  title: "Athlevo Sub-1 10k Challenge | 8-Week Virtual 10k Run",
  description: "An 8-week virtual running challenge from Athlevo, designed to help you chase a sub-60-minute 10k. Choose your package and register online.",
  ogTitle: "Athlevo Sub-1 10k Challenge",
  ogDescription: "8 weeks. One goal. Your fastest 10k. A structured virtual running challenge from Athlevo."
};

export const HERO = {
  eyebrow: "Athlevo Sub-1 10k Challenge",
  headline: "8 weeks. One goal. Your fastest 10k.",
  supporting: "A structured virtual running challenge designed to help you chase a sub-60-minute 10k.",
  primary: "Register now",
  secondary: "How it works",
  factLabels: { dates: "Challenge dates", deadline: "Registration closes", format: "Format" },
  format: "Virtual. Run your own 10k.",
  note: "Finish a 10k and you are a finisher. Run it in under 60 minutes, with a result we can verify, and you have earned Sub-1. The challenge gives you the structure to chase that time. It does not promise it."
};

/** What the registration status line says before a runner can register. */
export const STATES = {
  checking: "Checking registration.",
  open: "",
  not_open: "Registration is not open yet. Check back soon.",
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

export const FAQ = {
  eyebrow: "Questions",
  heading: "Before you *register*.",
  items: [
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
