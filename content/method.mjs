/**
 * The Athlevo Method lessons: the single source for method.athlevo.org.
 *
 * Every page on the site is written from this file by scripts/build-method-pages.mjs
 * (node scripts/build-method-pages.mjs, or --check to fail when a page is out of date).
 * To change a lesson, edit it here and rebuild. Do not edit method-pages/ by hand.
 *
 * Where the words come from
 *   - The method itself (zone names, session names, weekly structure, rules) is from the
 *     Athlevo Method course, version 1.0, by Dean Castro. It is written here as Athlevo's own design.
 *   - Anything that is research is linked in that lesson's `sources`, and only what was read
 *     and checked is stated. Claims in the course that could not be confirmed were left out or
 *     softened; docs/method-site.md lists them.
 *
 * Writing rules (Brand DNA, enforced by tests/method-site.test.mjs): short direct sentences,
 * no em or en dashes, ranges written "5 to 10", lowercase k and km, no hype and no guarantees.
 *
 * Inline text: **bold**, [label](lesson:slug) for another lesson, [label](https://...) for outside links.
 * Block types in `body`: { h2 }, { h3 }, { p }, { ul: [] }, { ol: [] }, { table: { caption, head, rows } }, { note }.
 */

export const SITE = {
  host: "method.athlevo.org",
  origin: "https://method.athlevo.org",
  appOrigin: "https://athlevo.org",
  programsUrl: "https://programs.athlevo.org/programs",
  name: "The Athlevo Method",
  brand: "Athlevo",
  // One place for the dates shown on the pages and in the structured data.
  published: "2026-11-14",
  updated: "2026-11-14",
  version: "1.0",
  author: { name: "Dean Castro", title: "Founder and Head Coach" },
  // Same ids as the program pages use, so search engines can tie the entities together.
  orgId: "https://athlevo.org/#organization",
  authorId: "https://programs.athlevo.org/programs#dean-castro",
  support: "support@athlevo.org"
};

export const HUB = {
  path: "/lessons",
  seoTitle: "The Athlevo Method: Running Coaching Lessons",
  h1Before: "The Athlevo",
  h1Key: "Method",
  tagline: "Running coaching lessons for working adults who train in the heat.",
  description: "Lessons from the Athlevo Method, a running coaching system for working adults who train in heat: the zones, the weekly structure and the reasoning.",
  intro: [
    "The Athlevo Method is a way of training runners who have a job, a family, poor sleep some weeks and hot, humid mornings. It does not invent new physiology. It applies established endurance science to that group of runners, and it counts the full cost of training: the runs, the weather, your work, your sleep and the state of your legs.",
    "These lessons explain how it works, and why each decision in an Athlevo plan is made. They are written for runners who want to understand their training, and for coaches who want to see how a system like this fits together."
  ],
  groups: [
    { heading: "Start here", slugs: ["training-zones", "training-week", "training-block-phases"] },
    { heading: "Load, heat and recovery", slugs: ["total-cost-training-load", "running-in-the-heat", "conversion-run"] },
    { heading: "Where the ideas come from", slugs: ["threshold-training", "pace-ladder", "hill-sprints-speed-reserve"] },
    { heading: "How coaching works", slugs: ["athlete-assessment", "coaching-rules"] }
  ],
  ideas: {
    heading: "Three bodies of work behind the method",
    intro: "The method is built on three published frameworks. Each solves a different part of the problem.",
    items: [
      { name: "The Norwegian threshold model", does: "Builds the aerobic engine with a lot of easy running and controlled work just below threshold.", slug: "threshold-training" },
      { name: "Funnel periodization", does: "Builds the full ladder of paces above and below race pace, then narrows toward race pace.", slug: "pace-ladder" },
      { name: "Anaerobic speed reserve", does: "Raises your speed ceiling so every pace below it costs less.", slug: "hill-sprints-speed-reserve" }
    ]
  },
  designNote: {
    heading: "What is research and what is our own design",
    text: "The zone names, session names, weekly structure and decision rules in these lessons are Athlevo's own design. The ideas they draw on come from published work, and each lesson links the sources it relies on. Where a lesson states a research finding, it says so. Nothing here is medical advice."
  },
  faq: [
    { q: "What is the Athlevo Method?", a: "It is a total-load endurance training framework. It uses four training zones, a weekly structure built around one main goal, and a set of decision rules that account for heat, work stress and sleep as well as running." },
    { q: "Who is it for?", a: "It is built for working adults who run in hot, humid, real-world conditions, starting with runners in the Philippines and places with similar demands. Beginners, returning runners and experienced racers all start from where they are." },
    { q: "Who wrote it?", a: "Dean Castro, founder and head coach at Athlevo. The lessons come from the Athlevo Method course, version 1.0." },
    { q: "Do I need a lactate meter?", a: "No. Zones are set from effort, pace and heart rate. The lactate numbers in the lessons are reference points for coaches. The [training zones lesson](lesson:training-zones) explains how they line up." },
    { q: "Where can I get a plan built on this method?", a: "Athlevo coaching programs are built on it. You can see them on the [Athlevo programs page](https://programs.athlevo.org/programs)." }
  ],
  cta: {
    heading: "Want this applied to your own training?",
    text: "Athlevo coaching programs are built on the method in these lessons.",
    label: "See Athlevo programs",
    href: "https://programs.athlevo.org/programs"
  }
};

/** The closing call to action on every lesson. Plain, one button. */
export const LESSON_CTA = {
  heading: "Want this applied to your own training?",
  text: "Athlevo coaching programs are built on this method. A coach sets your zones and your weekly plan around your life.",
  label: "See Athlevo programs",
  href: "https://programs.athlevo.org/programs"
};

export const SAFETY_NOTE = "This lesson is general training education. It is not medical advice. If you are unwell, injured or unsure, talk to a doctor before you train.";

export const LESSONS = [
  // 1 ------------------------------------------------------------------------------------------
  {
    slug: "training-zones",
    seoTitle: "Running Training Zones Explained | Athlevo Method",
    h1: "Running training zones: Ground, Control, Threshold and Edge",
    description: "The four Athlevo training zones, what each one feels like, what it is for and how to use it. A simple system for runners who train in heat.",
    lead: "Athlevo uses four training zones: Ground, Control, Threshold and Edge. They are named for what they do, because function is what a runner and a coach need on the road.",
    short: [
      "Ground is easy running. Most of your running lives here.",
      "Control is steady work just above easy. It builds fatigue resistance.",
      "Threshold is hard but controlled. It is used in small, planned doses.",
      "Edge is short, fast and relaxed. It sharpens you. It does not add volume."
    ],
    summary: "The four zones, what each feels like and what it is for.",
    body: [
      { h2: "The four zones at a glance" },
      { table: {
        caption: "The four Athlevo training zones",
        head: ["Zone", "What it is for", "How it feels", "Heart rate"],
        rows: [
          ["Ground", "Aerobic base, heart efficiency, fat use and heat adaptation", "Full conversation. Breathing open and relaxed.", "60 to 75% of max"],
          ["Control", "Fatigue resistance, pacing and a higher aerobic ceiling. It bridges Ground and Threshold.", "Comfortably pressured. Short phrases, not full sentences.", "75 to 83% of max"],
          ["Threshold", "Raises the pace you can hold near your lactate threshold, over time", "Hard but controlled. You can hold it for minutes, not hours.", "83 to 90% of max"],
          ["Edge", "Running economy, neuromuscular efficiency and top-end speed", "Fast and relaxed, not desperate. Clean mechanics.", "Lags too far behind. Go by feel, mechanics and duration."]
        ]
      } },
      { p: "Treat the heart rate ranges as a starting reference, not a verdict. How a coach sets your own zones is covered in [what a running coach assesses first](lesson:athlete-assessment)." },
      { h2: "Ground: genuinely easy" },
      { p: "Ground running is the base of your week. It builds the aerobic system, supports recovery and, for runners in a hot climate, builds heat tolerance. The test is simple: you can hold a full conversation and nothing feels like pressing." },
      { p: "The most common mistake is letting the top of Ground drift into the bottom of Control on easy days. That creates a grey zone that gives you neither the adaptation of harder work nor the recovery of easy running. If an easy run does not feel easy, the pace is too fast." },
      { p: "The Ground sessions in the Athlevo workout library are the **Foundation Run**, easy continuous running of 40 to 75 minutes, and the **Foundation Long**, extended easy running of 75 to 150 minutes or more depending on your level. On a long run the pace should feel easier at 70 minutes than at 20. If it gets harder as it goes, the start was too fast." },
      { p: "When it is above 30°C, pace becomes secondary and effort and breathing set the zone. See [running in the heat](lesson:running-in-the-heat)." },
      { h2: "Control: not a junk-mile zone" },
      { p: "A Control session has a set duration and a purpose. It is not an easy run that got a bit fast. Two examples from the Athlevo workout library:" },
      { ul: [
        "**Stability Cruise:** 30 minutes continuous at Control after a Ground warm-up.",
        "**Stability Blocks:** 5 × 8 minutes at Control with 2 minutes of Ground between efforts."
      ] },
      { p: "The interval version allows more time in the zone while managing fatigue within the session. It also suits hot weather, because the easy minutes let your body cool between efforts." },
      { h2: "Threshold: rationed" },
      { p: "Threshold sits near your lactate threshold, where effort is hard but controlled. It is dosed. Athlevo allows at most one or two Threshold sessions a week, never on consecutive days and never when you are depleted. A typical session is 5 × 5 minutes at Threshold with 90 seconds of easy jogging between efforts. More in [threshold training](lesson:threshold-training)." },
      { h2: "Edge: the sharpener" },
      { p: "Edge work is short, fast and relaxed, above your threshold pace. It develops running economy and top speed, and its volume is always low. A typical session is 8 × 20 seconds at Edge effort with 90 seconds of easy walking or jogging between, or short hill sprints. More in [hill sprints and the speed ceiling](lesson:hill-sprints-speed-reserve)." },
      { h2: "The same zones in lab terms" },
      { p: "Coaches and researchers often describe intensity by blood lactate. Athlevo's zones line up with it like this." },
      { table: {
        caption: "Athlevo zones and approximate blood lactate",
        head: ["Zone", "Where it sits", "Approximate blood lactate"],
        rows: [
          ["Ground", "Below the first lactate threshold", "Below 2 mmol/L"],
          ["Control", "Around the first lactate threshold", "About 2 to 2.5 mmol/L"],
          ["Threshold", "Near the second lactate threshold", "About 3.5 to 5 mmol/L"],
          ["Edge", "Above the second lactate threshold", "Short efforts, set by feel"]
        ]
      } },
      { p: "Most runners do not have a lactate meter, so zones are set from effort, pace and heart rate." }
    ],
    related: ["training-week", "threshold-training", "running-in-the-heat"],
    designNote: "The zone names, session names and ranges in this lesson are Athlevo's own design.",
    sources: []
  },

  // 2 ------------------------------------------------------------------------------------------
  {
    slug: "training-week",
    seoTitle: "How to Plan a Running Training Week | Athlevo Method",
    h1: "How to build a running training week",
    description: "How Athlevo builds a week of running around one main goal, where the hard session goes, how volume is split across zones and what progresses first.",
    lead: "An Athlevo week is built around one primary intent, not around filling a calendar with sessions. Pick the goal for the week first. The sessions follow from it.",
    short: [
      "Each week has one main target, such as a volume week, Threshold accumulation, recovery or maintenance.",
      "The main quality session goes on the day with the most available capacity.",
      "Most of the week is Ground. Threshold and Edge are small shares.",
      "When training is stable for 3 to 4 weeks, something progresses, and intensity is the last thing to change."
    ],
    summary: "How a week is planned, how volume is split and what progresses first.",
    body: [
      { h2: "Start with one intent" },
      { p: "Before choosing sessions, choose what the week is for. Athlevo uses four: a volume week, Threshold accumulation, recovery or maintenance. Every session in the week should support that target or protect it." },
      { h2: "The five planning steps" },
      { ol: [
        "Name the week's main physiological target.",
        "Check where you are in the block and what your life load is likely to be that week. See [total cost](lesson:total-cost-training-load).",
        "Put the main quality session on the day with the highest expected available capacity. By default that is not Monday, when fatigue from the weekend is still around, and not Friday, when the week's life load has piled up.",
        "Fill the other days with Ground running that supports recovery and keeps your rhythm without getting in the way of the quality session.",
        "Place Edge work on a day next to a quality session, but not straight before it."
      ] },
      { h2: "How the week's volume is split" },
      { table: {
        caption: "Share of weekly volume by zone",
        head: ["Zone", "Share of weekly volume", "Role"],
        rows: [
          ["Ground", "65 to 75%", "The foundation. Not reduced below 60% except during a taper."],
          ["Control", "15 to 20%", "The bridge. Builds fatigue resistance without emptying you."],
          ["Threshold", "5 to 10%", "The stimulus, carefully dosed. Peak weeks may briefly reach 12 to 13%."],
          ["Edge", "Under 5%", "The sharpener. It never adds volume. It adds quality and precision over time."]
        ]
      } },
      { h2: "Daily execution adapts, weekly intent stays fixed" },
      { p: "If a session has to change, the purpose of the week does not. You are still building the same quality, by a different route. A hard session that becomes an easy run does not turn a Threshold week into a recovery week. See [the Conversion Run](lesson:conversion-run)." },
      { h2: "What progresses first" },
      { p: "If your training has been stable for 3 to 4 weeks, it means you have capacity, and the system uses it. The order of progression is:" },
      { ol: [
        "Frequency, running on more days.",
        "Volume, running more in total.",
        "Density, packing the same work closer together.",
        "Precision, executing the same sessions better.",
        "Intensity, only as a last option."
      ] },
      { p: "Most runners reach for intensity first. Athlevo reaches for it last." }
    ],
    related: ["training-block-phases", "training-zones", "conversion-run"],
    designNote: "The weekly structure and the zone shares in this lesson are Athlevo's own design.",
    sources: []
  },

  // 3 ------------------------------------------------------------------------------------------
  {
    slug: "training-block-phases",
    seoTitle: "Running Training Phases and Taper | Athlevo Method",
    h1: "Training phases for runners: foundation to race preparation and taper",
    description: "How an Athlevo training block moves from foundation to development to race preparation, what each phase is for, and how a taper keeps intensity.",
    lead: "An Athlevo block has three phases and a taper. Each phase has one job, and each one builds on the last. The order does not change because a race is close or a runner is impatient.",
    short: [
      "Phase 1, Foundation, builds the aerobic base and heat adaptation.",
      "Phase 2, Development, adds fatigue resistance and Threshold tolerance.",
      "Phase 3, Race preparation, brings race pace in last.",
      "A taper lowers volume and keeps intensity and frequency."
    ],
    summary: "The three phases of a block, what each is for and how the taper works.",
    body: [
      { h2: "Phase 1: Foundation (4 to 6 weeks)" },
      { p: "**Target:** aerobic durability, heat adaptation and tissue conditioning. **Volume:** high, and mostly Ground. Control comes in carefully. Threshold is absent, or one session a week at most for a runner with a prior base." },
      { p: "Edge work is present from week 1 as hill sprints, once a week with full recovery. It is a small start on a slow process, the speed ceiling. See [hill sprints](lesson:hill-sprints-speed-reserve)." },
      { p: "In this phase you will often feel like you are not doing enough, and your instinct will be to add intensity. A coach's job is to hold the structure and explain why. Foundation done well makes every later phase more productive." },
      { p: "**Phase 1 ends when** you can run 5 days a week at Ground for 4 weeks in a row, with no tissue irritation building up, a stable resting heart rate and good energy on easy days." },
      { h2: "Phase 2: Development (4 to 6 weeks)" },
      { p: "**Target:** fatigue resistance and Threshold tolerance. **Volume:** kept from Phase 1. Control increases, Threshold rises to one or two sessions a week and Ground stays the majority." },
      { p: "This is where the [pace ladder](lesson:pace-ladder) starts. Work faster than goal pace (Edge) and slower than goal pace (Control) are both present, on purpose, so every rung is built at the same time." },
      { p: "Quality sessions are protected. If your available capacity drops to level 2 or lower on a planned quality day, the session converts to an easy run. No exceptions. A forced quality session when you are depleted can set the whole phase back." },
      { h2: "Phase 3: Race preparation (3 to 5 weeks)" },
      { p: "**Target:** race-specific work and the meeting of the pace ladder. **Volume:** a slight reduction, so quality sessions land on fresher legs. Quality is the priority." },
      { p: "By now you have spent 8 to 12 weeks building the rungs above and below goal pace. Goal pace becomes the training target, and it should feel more controlled than if you had started there." },
      { h2: "Taper: the final 2 to 3 weeks" },
      { p: "In a taper, volume comes down while intensity and frequency stay. The aim is to let the adaptation show up while the fatigue clears. A common taper mistake is cutting both volume and intensity, which takes away the sharp work that keeps race-specific movement patterns tuned." },
      { p: "Research points the same way. A 2023 systematic review and meta-analysis of tapering in endurance athletes concluded that a taper of 21 days or less works, with training volume cut progressively by 41 to 60% and intensity and frequency left unchanged." },
      { h2: "Deload weeks" },
      { p: "Inside a block, deload weeks cut volume so structural load can clear and your adaptation can settle. A deload is part of the plan, not a step back." },
      { h2: "The order fitness is built in" },
      { p: "Across all phases, Athlevo builds four qualities in a fixed priority order. Each one gives the next one something to stand on." },
      { ol: [
        "**Aerobic durability.** The ability to repeat submaximal training week after week without carrying unresolved fatigue. Built with months of consistent Ground running. For runners in hot climates this includes heat adaptation.",
        "**Fatigue resistance.** Holding form, rhythm and controlled output as fatigue builds. Built with Control work and the later part of long runs. Athlevo treats half marathons and marathons as mainly fatigue management problems.",
        "**Threshold tolerance.** Holding controlled pressure near your threshold without destabilizing your aerobic system. Introduced only after the first two are stable, and always rationed.",
        "**Neuromuscular speed.** Economy, leg speed and sharpness. It starts small from week 1 as hill sprints. As a race-sharpening tool, it comes last."
      ] },
      { p: "If you feel flat late in a block, the likely answer is recovery, not more Edge work." }
    ],
    related: ["training-week", "pace-ladder", "conversion-run"],
    designNote: "The phases, their lengths and the order of qualities are Athlevo's own design.",
    sources: [
      { label: "Effects of tapering on performance in endurance athletes: a systematic review and meta-analysis. PLoS One, 2023;18(5):e0282838.", url: "https://pubmed.ncbi.nlm.nih.gov/37163550/" }
    ]
  },

  // 4 ------------------------------------------------------------------------------------------
  {
    slug: "total-cost-training-load",
    seoTitle: "Training Load, Heat and Work Stress | Athlevo Method",
    h1: "Total cost: why training feels harder than the plan says",
    description: "Why a plan can look right and still wear you down. Athlevo counts four loads: training, environment, life and structural. Here is how each is read.",
    lead: "Most plans assume you sleep seven to nine hours, keep a steady work schedule, run in mild weather and recover fully between sessions. Most working adults do not live like that. The Athlevo total cost framework counts everything that draws on your recovery, not just the running.",
    short: [
      "Adapting to training has a cost, and the cost is paid across your whole life.",
      "Athlevo reads four loads: training, environmental, life and structural.",
      "Tiredness that never clears is usually a load accounting problem, not a motivation problem."
    ],
    summary: "The four loads Athlevo counts before it makes any training decision.",
    body: [
      { h2: "A cost on every system" },
      { p: "In stress research, allostatic load is the cumulative wear and tear on the body from repeated or chronic stress. Athlevo borrows the idea for training. Adapting to a block of work has a cost, and that cost builds up across all the stress in your life, not only in your legs." },
      { p: "Runners often arrive describing the same pattern:" },
      { ul: [
        "Low-grade tiredness that never fully clears.",
        "Stop-start training: hard weeks, a breakdown, a restart.",
        "High effort with little to show for it.",
        "Aches that build up without a single clear cause."
      ] },
      { p: "Athlevo's diagnosis is that this is not a motivation problem. It is a load accounting problem. The fix is to count the full cost, not only the training." },
      { h2: "The four load inputs" },
      { h3: "1. Training load" },
      { p: "Three things are read:" },
      { ul: [
        "**Acute load:** the last 3 to 7 days. Total volume, intensity mix and how closely sessions are packed.",
        "**Chronic load:** the last 4 to 6 weeks. Someone coming off a consistent high-volume block carries a different base than someone who has been sporadic.",
        "**Load balance:** how the recent week compares with the recent weeks before it. A week well above your recent norm is treated as breakdown risk, even if it does not look extreme on paper."
      ] },
      { h3: "2. Environmental load" },
      { p: "Heat and humidity are a physiological cost, not scenery. See [running in the heat](lesson:running-in-the-heat)." },
      { h3: "3. Life load" },
      { p: "Work stress, sleep quality, emotional strain, relationship demands, commute and food quality all draw on the same pool of recovery. Athlevo treats them as inputs, not as soft factors to note and ignore. A coach uses four quick questions:" },
      { ul: [
        "Sleep over the last 3 nights: normal, disrupted or very poor.",
        "Work stress this week: normal, elevated or high.",
        "Energy on waking: good, flat or very low.",
        "Anything unusual, such as travel, illness or emotional stress: yes or no."
      ] },
      { h3: "4. Structural load" },
      { p: "Where you are in a block decides how much tissue fatigue you carry." },
      { ul: [
        "**Early block (weeks 1 to 3):** structural load is low. Tissue is fresh.",
        "**Mid-block (weeks 4 to 7):** it builds. This is where many runners feel the grind, not because sessions got harder but because the load is cumulative.",
        "**Peak weeks:** structural load is highest and the most adaptation happens, but only if recovery weeks follow.",
        "**Deload weeks:** structural load clears and the adaptation settles."
      ] },
      { h2: "From four inputs to one decision" },
      { p: "Once the four inputs are read, the question is how much training you can absorb today without hurting next week. That is your available capacity, and it decides whether a planned session goes ahead. See [the Conversion Run](lesson:conversion-run)." }
    ],
    related: ["conversion-run", "running-in-the-heat", "training-block-phases"],
    designNote: "The four-input framework, the check-in questions and the way they are read are Athlevo's own design.",
    sources: [
      { label: "Allostatic load, overview of the concept and how it is measured (Wikipedia).", url: "https://en.wikipedia.org/wiki/Allostatic_load" }
    ]
  },

  // 5 ------------------------------------------------------------------------------------------
  {
    slug: "running-in-the-heat",
    seoTitle: "Running in the Heat: Adjust Pace, Not Effort | Athlevo Method",
    h1: "How to run in the heat: hold the effort, let the pace drop",
    description: "Why hot, humid weather changes what a pace costs, how Athlevo adjusts training above 30°C, how heat adaptation works and which warning signs mean stop.",
    lead: "Heat is a cost, not background. At the same pace, a runner in hot, humid weather works harder than a runner in cool weather. The Athlevo rule is simple: hold the effort and let the pace come down.",
    short: [
      "The same pace costs more in heat, so the same effort gives a slower pace.",
      "Athlevo adjusts every session when it is above 30°C with humidity above 65%.",
      "Heat adaptation builds over about 1 to 2 weeks of regular heat exposure and fades in about 3 weeks without it.",
      "Know the warning signs of heat illness, and stop if you see them."
    ],
    summary: "How heat changes training, how Athlevo adjusts for it and the warning signs to know.",
    body: [
      { h2: "Heat changes what a pace costs" },
      { p: "Take a runner in Manila at 33°C and 80% humidity, and another at 18°C, both doing the same session at the same pace. The first is working substantially harder: on the heart and circulation, on temperature control and on metabolism." },
      { p: "Race results show the same pattern. A study of marathon results by Ely and colleagues found that performance slowed steadily as the wet bulb globe temperature (WBGT, a heat measure that takes humidity into account) rose from 5 to 25°C. The effect was larger for slower runners than for the fastest." },
      { h2: "The Athlevo heat rule" },
      { p: "On hot, humid days, the same effort at a lower pace gives the same useful training effect. A pace target written for cool weather turns an easy day into a hard one." },
      { p: "Athlevo adjusts every session when it is above 30°C with humidity above 65%. A plan written for mild conditions does not apply as written." },
      { table: {
        caption: "How Athlevo adjusts targets above 30°C",
        head: ["Zone", "Adjustment"],
        rows: [
          ["Ground", "Lower the target pace by 5 to 10%. Let effort and heart rate govern the run."],
          ["Control", "Lower the target pace by 5% and shorten the session."],
          ["Threshold", "Lower the target pace by 3 to 5% and watch your heart rate ceiling."],
          ["Edge", "Hill sprints are run by effort. No pace target is needed."]
        ]
      } },
      { h2: "Adapting to heat" },
      { p: "A review from the Gatorade Sports Science Institute says heat acclimatization usually takes about 7 to 14 days of regular heat exposure. Most of the fall in heart rate comes in the first 4 to 5 days and is essentially complete after 7. Core temperature during exercise is lower, sweating starts earlier and sweat rate rises. Fit athletes can adapt in about half the time. The gains fade: they last about a week after exposure ends, and about 75% are lost by about 3 weeks." },
      { p: "That is why Ground running does double duty for runners who train outdoors in a hot climate. It builds the aerobic base and it keeps heat adaptation going." },
      { p: "You may read that heat training raises VO2max even when you race in cool weather. One 2010 trial of trained cyclists found a gain of about 5% in VO2max, measured in cool conditions, after 10 days of heat training. The review above notes that such findings are not universal. Athlevo treats heat adaptation as how you cope with heat, not as a promise of a higher VO2max." },
      { h2: "Know the warning signs" },
      { p: "**Heat exhaustion** can bring headache, nausea, dizziness, weakness, irritability, thirst, heavy sweating and a raised body temperature. Stop, get out of the heat, take off extra clothing, cool down with cold water or compresses, sip cool water and get medical care." },
      { p: "**Heat stroke** can bring confusion, slurred speech, seizures, loss of consciousness, a very high body temperature, and either hot dry skin or heavy sweating. It can be fatal if treatment is delayed. Call your local emergency number straight away and cool the person quickly while you wait." },
      { note: "This is general information, not medical advice. If you are unsure, stop and get help." }
    ],
    related: ["training-zones", "total-cost-training-load", "athlete-assessment"],
    designNote: "The 30°C and 65% humidity trigger and the percentage adjustments are Athlevo's own rules.",
    sources: [
      { label: "Ely MR, Cheuvront SN, Roberts WO, Montain SJ. Impact of weather on marathon-running performance. Medicine and Science in Sports and Exercise, 2007;39(3):487-493.", url: "https://experts.umn.edu/en/publications/impact-of-weather-on-marathon-running-performance/" },
      { label: "Sawka MN, Périard JD, Racinais S. Heat acclimatization to improve athletic performance in warm-hot environments. Sports Science Exchange 153, Gatorade Sports Science Institute, 2016.", url: "https://www.gssiweb.org/en/sports-science-exchange/article/sse-153-heat-acclimatization-to-improve-athletic-performance-in-warm-hot-environments" },
      { label: "Heat acclimation improves exercise performance. Randomized trial in trained cyclists, 2010 (PubMed).", url: "https://pubmed.ncbi.nlm.nih.gov/20724560/" },
      { label: "CDC NIOSH. Heat-related illnesses.", url: "https://www.cdc.gov/niosh/heat-stress/about/illnesses.html" }
    ]
  },

  // 6 ------------------------------------------------------------------------------------------
  {
    slug: "conversion-run",
    seoTitle: "When to Swap a Hard Run for an Easy One | Athlevo Method",
    h1: "The Conversion Run: when to swap a hard session for an easy one",
    description: "How Athlevo decides when a planned hard session should become an easy run, using a five-level capacity check, and why missed intensity is not made up.",
    lead: "A Conversion Run is a planned quality session that becomes an easy Ground run because of how much capacity you actually have that day. It keeps your rhythm and your aerobic work without adding fatigue.",
    short: [
      "Available capacity is how much training you can absorb today without hurting next week.",
      "A coach rates it on five levels. Level 2 or lower means the hard session converts.",
      "A Conversion Run is a coaching decision based on load, not a mood.",
      "A converted session is not made up later."
    ],
    summary: "The five capacity levels and the test for converting a hard session.",
    body: [
      { h2: "Available capacity" },
      { p: "After reading the four inputs from [total cost](lesson:total-cost-training-load), a coach decides your available capacity: the amount of productive training stress you can take today without damaging next week's training. The question behind every decision is:" },
      { p: "**Will this decision make good training next week more likely or less likely?**" },
      { table: {
        caption: "The five capacity levels",
        head: ["Level", "Name", "What it means"],
        rows: [
          ["5", "Full capacity", "All four inputs are favorable. You can run the planned quality session fully. This is less common than most runners assume."],
          ["4", "High capacity", "One input is slightly elevated. The session goes ahead with a small change, such as slightly shorter or less dense."],
          ["3", "Moderate capacity", "Two inputs are elevated, or one is high. The quality session may become Control work. You can keep volume, but not intensity. This is the most common state."],
          ["2", "Low capacity", "Several inputs are elevated. Training continues, because consistency matters, but at Ground only. This is a Conversion Run day."],
          ["1", "Very low, rest", "Illness, serious sleep loss, an acute life crisis or signs of accumulated breakdown. Rest is load management, not failure."]
        ]
      } },
      { h2: "Plan for level 5, live at level 3" },
      { p: "Most runners and coaches plan as if every day is level 5. Real life runs at level 3 more than any other level. In Athlevo's view, planning for 5 and executing at 3 week after week is the main driver of chronic fatigue and stop-start training." },
      { h2: "What a Conversion Run is, and is not" },
      { ul: [
        "**What it is:** Ground running for a suitable duration. It can include 4 to 6 Surge Strides at the end if you finish feeling good, never at the start.",
        "**What it is not:** an easy run you picked because you did not feel like working hard.",
        "**The test:** if I do the planned session today, will training next week be better or worse? If the honest answer is worse, it is a Conversion Run day."
      ] },
      { p: "The decision is the coach's, from a structured load check, not the runner's mood. A runner who converts every hard session because it did not feel right has not assessed their load. They have avoided discomfort." },
      { h2: "What counts as evidence" },
      { p: "Changes to training should come from things that can be seen or measured:" },
      { ul: [
        "A poor sleep trend.",
        "A raised resting heart rate.",
        "Soreness that has not settled within 48 hours.",
        "A steady pattern of mental fatigue."
      ] },
      { p: "A feeling that always ends in an easier day is not an assessment. Stress alone never justifies harder training either: a bad day at work is a reason to read your load more carefully, not to run harder." },
      { h2: "Missed intensity is not made up" },
      { p: "If a Threshold session is missed or converted, it is gone. Athlevo does not squeeze two quality sessions into one week to catch up. The plan moves forward from where you actually are." },
      { h2: "What a coach says" },
      { p: "Athlevo coaches explain the decision rather than just granting a day off. For example: \"Based on your load this week and your sleep, today becomes a Conversion Run, 45 minutes at Foundation pace. This is the right decision for the method, not a step backward. The goal is next week's quality session landing on a recovered system.\"" }
    ],
    related: ["total-cost-training-load", "coaching-rules", "training-week"],
    designNote: "The five capacity levels and the Conversion Run are Athlevo's own design.",
    sources: []
  },

  // 7 ------------------------------------------------------------------------------------------
  {
    slug: "hill-sprints-speed-reserve",
    seoTitle: "Hill Sprints for Distance Runners | Athlevo Method",
    h1: "Hill sprints for distance runners and the speed ceiling",
    description: "Why distance runners need a speed ceiling, what anaerobic speed reserve means, and how Athlevo uses short hill sprints from week one of a training block.",
    lead: "Distance runners have a speed ceiling as well as an aerobic one. A higher ceiling makes the paces below it cheaper. Athlevo raises it with short hill sprints that start in the first week of a block.",
    short: [
      "Anaerobic speed reserve (ASR) is your top sprint speed minus your maximal aerobic speed.",
      "When you run faster than your aerobic ceiling, the share of that reserve you use matters more than the percentage of your aerobic speed.",
      "Athlevo starts low-volume hill sprints in week 1 and keeps them through the block.",
      "Edge work is ceiling work. It is not race-specific work."
    ],
    summary: "What ASR means and how hill sprints raise your speed ceiling.",
    body: [
      { h2: "Your aerobic ceiling and your speed ceiling" },
      { p: "Three terms from the research are worth knowing:" },
      { ul: [
        "**Maximal aerobic speed (MAS):** the speed linked to your maximal aerobic capacity.",
        "**Maximal sprinting speed (MSS):** your top speed, measured in a flying sprint.",
        "**Anaerobic speed reserve (ASR):** MSS minus MAS. It is the speed buffer above your aerobic ceiling."
      ] },
      { p: "These ideas were set out by Gareth Sandford, Paul Laursen and Martin Buchheit in a 2021 paper in Sports Medicine. They argue that when you work above MAS, the proportion of your reserve you are using is more useful than the percentage of MAS." },
      { h2: "Same pace, different cost" },
      { p: "Here is an example with illustrative numbers. Two runners both have a MAS of 18 km/h. Both aim to run at 20 km/h." },
      { table: {
        caption: "Two runners with the same aerobic speed",
        head: ["Runner", "MAS", "MSS", "ASR", "Share of ASR used at 20 km/h"],
        rows: [
          ["Runner A", "18 km/h", "24 km/h", "6 km/h", "33%"],
          ["Runner B", "18 km/h", "30 km/h", "12 km/h", "17%"]
        ]
      } },
      { p: "Runner A is using a third of the reserve above MAS and is working near the ceiling. Runner B is using about a sixth, so the same pace is much cheaper. That is the case for raising MSS: a higher ceiling makes a given pace cost less relative to what you have in reserve, even if your aerobic capacity does not change." },
      { h2: "What Athlevo does with it" },
      { ul: [
        "**Speed ceiling work starts early.** Hill sprints begin in Phase 1 and continue through the whole block. Athlevo treats the speed ceiling as slow work that has to start early.",
        "**Profile before programming.** Before building a plan, a coach checks whether your limiting factor is your aerobic base, your tolerance for threshold work or your speed ceiling.",
        "**Edge is ceiling work.** The Edge zone develops neuromuscular efficiency and adds to MSS over time. It is not race-specific work."
      ] },
      { h2: "The two Edge sessions" },
      { ul: [
        "**Surge Hills:** short maximal hill sprints. A typical session is 8 to 12 reps of 8 to 10 seconds on a 6 to 10% grade, with a full walk back between reps. Each rep is fully recovered before the next, because this is a speed session, not conditioning. Hills need no track or timing gates.",
        "**Surge Strides:** short, relaxed, fast efforts on flat ground, such as 8 × 20 seconds at Edge effort with 90 seconds of easy walking or jogging between. Done with full mechanical relaxation. Fast, never strained."
      ] },
      { p: "Edge stays under 5% of weekly volume. It is the sharpener, not the engine. If you are returning from injury or have never sprinted, talk to a coach or doctor before adding maximal efforts." },
      { h2: "How a coach measures it" },
      { ul: [
        "**MAS:** estimated from a 1500 to 2000 m time trial at maximal effort.",
        "**MSS:** estimated from a flying 20 to 30 m sprint on flat ground or a slight downhill. You accelerate fully before the timed section. A GPS watch with sprint tracking gives a usable estimate.",
        "**ASR:** MSS minus MAS, both in km/h."
      ] }
    ],
    related: ["threshold-training", "training-zones", "athlete-assessment"],
    designNote: "The Surge Hills and Surge Strides sessions and how they are scheduled are Athlevo's own design.",
    sources: [
      { label: "Sandford GN, Laursen PB, Buchheit M. Anaerobic speed/power reserve and sport performance: scientific basis, current applications and future directions. Sports Medicine, 2021;51(10):2017-2028.", url: "https://doi.org/10.1007/s40279-021-01523-9" }
    ]
  },

  // 8 ------------------------------------------------------------------------------------------
  {
    slug: "threshold-training",
    seoTitle: "Lactate Threshold Training for Runners | Athlevo Method",
    h1: "Threshold training for runners: the Norwegian model and Athlevo",
    description: "What threshold running is, the Norwegian threshold idea, what Athlevo keeps and leaves out, and the Threshold sessions in the workout library.",
    lead: "Threshold training means running near your lactate threshold, hard but controlled. Athlevo takes one idea from the Norwegian approach: build up a lot of quality work near threshold over time, instead of chasing one maximal session.",
    short: [
      "Threshold work sits near the pace you can hold at your lactate threshold, in controlled intervals.",
      "The Norwegian model pairs a lot of easy running with controlled work just below threshold.",
      "Athlevo keeps the principle and leaves out the elite-only practices, such as double threshold days and lactate meters.",
      "Threshold is introduced after the aerobic base is in place, and it is always rationed."
    ],
    summary: "The Norwegian threshold idea, what Athlevo keeps and the four Threshold sessions.",
    body: [
      { h2: "What threshold running is" },
      { p: "Threshold running is work near your lactate threshold, the point where your body starts to make lactate faster than it clears it. It feels hard but controlled, and demands attention. You can hold it for minutes, not hours. In Athlevo it is Zone 3. See [the four zones](lesson:training-zones)." },
      { h2: "The Norwegian idea" },
      { p: "The Norwegian threshold model is credited to the Norwegian runner Marius Bakken and is linked with the training of the Ingebrigtsen brothers." },
      { p: "Athlevo reads the model's central argument this way: the best way to raise your threshold is not to train above it, which is costly, slow to recover from and hard to repeat. Instead you build up a high volume of quality work just below it, where the stimulus is there but the stress is low enough to repeat often." },
      { p: "Bakken's principles, as summarised by one running site, keep blood lactate at around 3 mmol/L or below, use intervals rather than continuous running, and split threshold work into shorter sessions so total volume can be higher. Most of the running stays easy. Stephen Seiler's 2010 review of studies of nationally and internationally competitive endurance athletes found training converged on roughly 80% of sessions at low intensity and roughly 20% dominated by high-intensity work." },
      { h2: "What Athlevo keeps" },
      { ul: [
        "**A weekly Threshold anchor.** Once the base is in place, a controlled Threshold session is the anchor of a structured block.",
        "**Easy days that are truly easy.** The Norwegian approach works only because the easy days are easy. Athlevo enforces this through the Ground zone.",
        "**Clearing lactate when you are tired as a training target.** Athlevo does not use double threshold days for most runners. It programs Control work after accumulated load to train this adaptation at a lower dose.",
        "**Accumulation, not maximization.** The goal is a growing volume of work near threshold over time, not the hardest possible single session."
      ] },
      { h2: "What Athlevo leaves out" },
      { p: "The Norwegian model was built for athletes with elite recovery support: controlled environments, twice-daily training, lactate meters for precision and schedules built around training. Athlevo runners are working adults, running at 6am in the heat before a 10-hour workday. They do not have that setup. Athlevo takes the principle and leaves the elite-specific practices." },
      { h2: "Threshold sessions in the Athlevo library" },
      { ul: [
        "**Pressure Waves:** classic threshold intervals. Example: 5 × 5 minutes at Threshold with 90 seconds of easy jogging between. The recoveries are jogged, not walked.",
        "**Pressure Ladder:** a descending sequence that spreads fatigue across the session. Example: 6, 5, 4, 3 and 2 minutes at Threshold with 90 seconds of jogging between. Useful for runners who start flat interval sessions too fast.",
        "**Pressure Cruise:** continuous Threshold running with no recovery break. Example: 20 to 25 minutes. Only for advanced runners with high available capacity."
      ] },
      { h2: "When Threshold comes in" },
      { p: "Athlevo builds [aerobic durability and fatigue resistance first](lesson:training-block-phases). Threshold work comes after both are stable, and it is always rationed. In Athlevo's view, bringing it in too early is a common coaching error: runners feel fit for a short time before they break down." }
    ],
    related: ["training-zones", "pace-ladder", "training-block-phases"],
    designNote: "The Pressure sessions and how Athlevo schedules Threshold work are Athlevo's own design. The Norwegian model is described as it is usually reported.",
    sources: [
      { label: "Seiler S. What is best practice for training intensity and duration distribution in endurance athletes? International Journal of Sports Physiology and Performance, 2010.", url: "https://pubmed.ncbi.nlm.nih.gov/20861519/" },
      { label: "Shuichi Running. Jakob Ingebrigtsen training: the Norwegian double threshold method.", url: "https://shuichi-running.com/en/ingebrigtsen-training/" }
    ]
  },

  // 9 ------------------------------------------------------------------------------------------
  {
    slug: "pace-ladder",
    seoTitle: "Race Pace Training: The Pace Ladder | Athlevo Method",
    h1: "Why race pace comes last: the pace ladder",
    description: "How funnel periodization builds the paces above and below race pace first, so goal pace feels controlled when it finally becomes the target of training.",
    lead: "Race pace is a destination, not a starting point. The pace ladder is the idea that you build the paces above and below race pace first, so goal pace feels sustainable when you reach it.",
    short: [
      "Many runners build an easy base and then jump straight to race-pace intervals.",
      "Funnel periodization starts general and narrows toward race pace.",
      "Earlier qualities are kept, with small doses added, not dropped.",
      "Athlevo keeps both faster and slower paces in the plan for the whole block."
    ],
    summary: "The pace ladder, funnel periodization and what Athlevo takes from it.",
    body: [
      { h2: "The gap in the middle of the ladder" },
      { p: "A common pattern is to build an easy aerobic base and then jump to race-pace intervals. What gets skipped is the middle of the pace ladder: the rungs above and below goal pace that make goal pace feel sustainable." },
      { h2: "Funnel periodization" },
      { p: "Funnel periodization, popularised by the Italian coach Renato Canova, approaches a goal race from two sides at once: the aerobic and endurance side, and the anaerobic and speed side. Training starts general and gets more specific as the paces converge on the goal race pace." },
      { p: "One practical write-up describes it as moving from paces far above and below the target toward paces closer and closer to it, until the last phase is fully race-specific. Earlier work is not dropped. A little of each earlier pace is added back every couple of weeks, because keeping a fitness is easier than rebuilding it." },
      { p: "The half marathon and marathon work differently, because there are not several longer race distances to build above. The write-up above puts the emphasis mainly on threshold work for them." },
      { h2: "Why the easy-only base is a problem" },
      { p: "Runners who only ever run easy meet a shock when quality arrives. Athlevo's Control zone exists to prevent that: it keeps you regularly exposed to moderate intensity, so Threshold does not feel like a cliff." },
      { h2: "What Athlevo takes from it" },
      { ul: [
        "**Build the whole pace spectrum.** Athlevo programs faster-than-target work (Edge) and slower-than-target purposeful work (Control) alongside Threshold through a block.",
        "**Race pace is a destination.** Do not run goal-pace intervals until the rungs above and below are stable.",
        "**Training adds, it does not replace.** New qualities are layered on, not swapped in.",
        "**Embedded quality in long runs, carefully.** For advanced runners in Phase 3, controlled work in the last part of a long run, when you are already tired, is the most race-specific work available. It is used conservatively. Long runs are not turned into workouts by default."
      ] },
      { p: "See how this fits into phases in [training phases and taper](lesson:training-block-phases)." }
    ],
    related: ["training-block-phases", "threshold-training", "hill-sprints-speed-reserve"],
    designNote: "How Athlevo uses the pace ladder across a block is Athlevo's own design. The description of funnel periodization follows the source below.",
    sources: [
      { label: "All Things Running. Funnel periodization: a high-success modern training approach.", url: "https://allthingsrunning.substack.com/p/funnel-periodization-a-high-success" }
    ]
  },

  // 10 -----------------------------------------------------------------------------------------
  {
    slug: "athlete-assessment",
    seoTitle: "What a Running Coach Assesses First | Athlevo Method",
    h1: "What a running coach assesses before writing your plan",
    description: "The five things an Athlevo coach checks before building a plan: training age, aerobic level, speed ceiling, lifestyle load and heat adaptation.",
    lead: "Before an Athlevo plan is written, the coach profiles you across five dimensions. The plan comes from the profile, not from a template.",
    short: [
      "Training age and base quality decide how fast a block can load you.",
      "A maximal aerobic speed test sets the pace reference for your zones.",
      "A speed test shows whether your ceiling or your aerobic base is the limit.",
      "Lifestyle load and heat adaptation set how much you can absorb."
    ],
    summary: "The five dimensions of athlete profiling and how zones are set from a MAS test.",
    body: [
      { h2: "1. Training age and base quality" },
      { p: "How many years have you run consistently? What is the longest period you have trained without a break longer than 2 weeks? A runner with 3 years of steady training and a runner with 6 months can have the same 5k time and still need different loading. Training age decides how hard a phase can be loaded." },
      { h2: "2. Current aerobic level: the MAS test" },
      { p: "Maximal aerobic speed is estimated from a 1500 to 2000 m time trial at maximal effort. That gives a pace reference for setting every zone." },
      { table: {
        caption: "Zone pace as a share of MAS pace, and the adjustment in heat",
        head: ["Zone", "Share of MAS pace", "Adjustment above 30°C"],
        rows: [
          ["Ground", "65 to 75%", "Lower by 5 to 10%. Use effort and heart rate as the main guide."],
          ["Control", "75 to 83%", "Lower by 5% and shorten the session."],
          ["Threshold", "83 to 92%", "Lower by 3 to 5% and watch your heart rate ceiling."],
          ["Edge", "Above 95%", "Hill sprints are run by effort, with no pace target."]
        ]
      } },
      { h2: "3. Speed ceiling: ASR profiling" },
      { p: "Maximal sprinting speed is estimated from a flying 20 to 30 m sprint on flat ground or a slight downhill. Anaerobic speed reserve is MSS minus MAS, both in km/h. The profile helps decide whether the speed ceiling needs work before Threshold becomes the priority. See [hill sprints and the speed ceiling](lesson:hill-sprints-speed-reserve)." },
      { h2: "4. Lifestyle load profile" },
      { p: "A structured intake conversation covers average sleep duration and quality, work schedule and intensity, commute, family and social obligations, eating habits and meal consistency, and any history of burnout, overtraining or chronic injury. This sets the base assumption for how much capacity you have to plan with. See [total cost](lesson:total-cost-training-load)." },
      { h2: "5. Heat adaptation status" },
      { p: "How long have you been training consistently in your current climate? Heat adaptation fades within a few weeks without heat exposure, so a runner who has just come back from a cooler place, or who trains mostly indoors, carries a higher environmental cost per session. See [running in the heat](lesson:running-in-the-heat)." },
      { h2: "From profile to plan" },
      { p: "The profile sets your zones, your starting phase, how aggressively the block can load you and how much heat adjustment each session needs. Then the weekly structure takes over. See [how a training week is built](lesson:training-week)." }
    ],
    related: ["training-zones", "total-cost-training-load", "coaching-rules"],
    designNote: "The five profiling dimensions and the zone percentages are Athlevo's own design.",
    sources: []
  },

  // 11 -----------------------------------------------------------------------------------------
  {
    slug: "coaching-rules",
    seoTitle: "Running Coach Decision Rules | Athlevo Method",
    h1: "How Athlevo coaches make decisions: eight rules behind every plan",
    description: "The eight rules Athlevo coaches follow when they change, convert or progress your training, and how a coach explains each decision to you.",
    lead: "These are the rules Athlevo coaches follow. They stop the method from sliding into generic coaching when things get busy. If you are choosing a coach, they also tell you what to expect.",
    short: [
      "The week's purpose stays fixed even when a session changes.",
      "Stress never justifies harder training, and missed intensity is not made up.",
      "Only things that can be seen or measured change a plan.",
      "Heat is a cost, so every hot-weather session is adjusted."
    ],
    summary: "Eight decision rules and what clear coaching sounds like.",
    body: [
      { h2: "The eight rules" },
      { ol: [
        "**Daily execution adapts. Weekly intent stays fixed.** If a session has to change, the purpose of the week does not. You are building the same quality by another route.",
        "**Stress never justifies harder training.** A bad day at work, a conflict or a frustrating situation is a reason to read your load more carefully, not to run harder.",
        "**No missed intensity is made up.** If a Threshold session is missed or converted, it is gone. The plan moves forward from where you are.",
        "**Only assessable stress changes training.** Changes come from things that can be seen or measured, such as a poor sleep trend, a raised resting heart rate, soreness that lasts beyond 48 hours or a steady pattern of mental fatigue.",
        "**If training is stable for 3 to 4 weeks, something progresses.** Athlevo is not a recovery management program. When capacity is consistently there, the system uses it. The order is frequency, volume, density, precision and, last, intensity.",
        "**Long runs are controlled, not disguised workouts.** Adding Threshold intervals to every long run turns it into a second quality session. Long runs with embedded quality are a Phase 3 tool for advanced runners, not a default.",
        "**The Conversion Run is a coaching decision, not a preference.** The coach makes a structured load assessment. See [the Conversion Run](lesson:conversion-run).",
        "**Heat is cost, not context.** Every prescription above 30°C with humidity above 65% is adjusted. A pace target written for mild weather does not apply without adjustment."
      ] },
      { h2: "What clear coaching sounds like" },
      { p: "How a plan is communicated matters as much as how it is designed. The aim is to give the reason, not just the instruction. Three examples:" },
      { ul: [
        "**A Ground run.** Not \"just run easy today\". Instead: \"Today is a Foundation Run, 50 minutes at full conversation pace. If you are breathing harder than that, you are going too fast. Heat means a slower pace at the same effort.\"",
        "**A heat adjustment.** Not \"just slow down because it is hot\". Instead: \"Today's environmental load is high. Your pace target adjusts because the effort cost at your planned pace is higher than what we are aiming for. The adaptation comes from the right effort, not the number on your watch.\"",
        "**A runner who wants to do more.** Not \"trust yourself\". Instead: \"What would you do more of, and what is your available capacity telling you? The method progresses when capacity is there, not when motivation is high. Those are different inputs.\""
      ] },
      { p: "For the full picture of what a coach checks first, see [what a running coach assesses before writing your plan](lesson:athlete-assessment)." }
    ],
    related: ["conversion-run", "athlete-assessment", "training-week"],
    designNote: "The rules and the coaching examples in this lesson are Athlevo's own.",
    sources: []
  }
];
