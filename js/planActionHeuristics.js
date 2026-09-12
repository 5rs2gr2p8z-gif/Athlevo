/*
 * Athlevo — canonical "Build this week's plan" trigger heuristic.
 *
 * Coach already returns a structured response (response_type, direct_answer,
 * sections, suggested_replies — see api/coach.js). This module decides,
 * from that structured output plus the athlete's message and whether they
 * already have a meaningful plan for the current week, whether Coach should
 * offer the single canonical "Build this week's plan" action.
 *
 * Deliberately conservative: false negatives (no button) are cheap, false
 * positives (button on every reply, or on generic education) are not — the
 * spec is explicit that this must stay contextual, not omnipresent.
 *
 * No network calls, no plan generation logic lives here — this only decides
 * whether to SHOW the action. The action itself always goes through the
 * existing canonical /api/training/generate-plan path (js/train.js).
 */
(function (root) {
  "use strict";

  // Explicit ask for a plan — always offer, regardless of week state.
  var EXPLICIT_PATTERNS = [
    /\bbuild (my |this week'?s? )?week\b/i,
    /\bbuild (me |my |this week'?s? )?(a |the )?(training )?plan\b/i,
    /\bmake (me |my )?(a |the )?(training )?plan\b/i,
    /\bcreate (me |my )?(a |the )?(training )?plan\b/i,
    /\b(plan|schedule) (my|this) week\b/i,
    /\brebuild (my |the )?(week|plan)\b/i,
    /\bregenerate (my |the )?(week|plan)\b/i,
    /\bupdate (my |the )?(week|plan)\b/i,
    /\b(no|nothing|not) (training |anything )?scheduled\b/i,
    /\bmissed my .* (run|workout|session)\b.*\bwhat should i do\b/i
  ];

  // Actionable weekly-guidance signals — advice that implies the week's
  // structure should change, not just an explanation of a concept.
  var ACTIONABLE_PATTERNS = [
    /\btaper\b/i,
    /\b(this|next) week (should|needs to|has to) be (lighter|easier|harder)\b/i,
    /\bkeep (tomorrow|today|this week) easy\b/i,
    /\byour next (move|step) should be\b/i,
    /\bfocus on (threshold|speed|tempo|intervals|endurance|base|recovery)\b.*\bweek\b/i,
    /\b(lighten|dial back|scale back|ease off|back off) (this week|the week|training)\b/i,
    /\b(rebuild|rework|restructure|adjust) (this|the) week\b/i,
    /\bswap (out )?(this|the|your) week\b/i,
    /\brecovery week\b/i,
    /\bcut back (this week|on volume|on training)\b/i
  ];

  // Generic/educational questions — never offer the action, even if a
  // training keyword appears (e.g. "What is threshold running?").
  var EDUCATIONAL_PATTERNS = [
    /^\s*what (is|are|does)\b/i,
    /^\s*how (many|much)\b/i,
    /^\s*explain\b/i,
    /^\s*why (does|do|is|are)\b/i,
    /\bdefinition of\b/i,
    /\bmean(s|ing)?\?\s*$/i
  ];

  function textOf(answer) {
    if (!answer) return "";
    var parts = [answer.direct_answer, answer.headline, answer.closing];
    if (Array.isArray(answer.sections)) {
      answer.sections.forEach(function (section) {
        if (!section) return;
        parts.push(section.title, section.body);
        if (Array.isArray(section.bullets)) parts = parts.concat(section.bullets);
      });
    }
    return parts.filter(Boolean).join(" \n ");
  }

  function matchesAny(patterns, text) {
    return patterns.some(function (re) { return re.test(text); });
  }

  /*
   * weekState: { hasPlan: boolean, hasMeaningfulPlan: boolean } describing
   * the athlete's CURRENT week, sourced from the same get-week payload
   * Coach already loads for context (loadWeekExecutionForCoach /
   * get-week's `hasPlan`). Never invented here.
   */
  function shouldOfferBuildPlan(userMessage, answer, weekState) {
    var question = String(userMessage || "");
    var replyText = textOf(answer);
    var responseType = (answer && answer.response_type) || "standard";

    // Explicit ask always wins, even for a generic-sounding question.
    if (matchesAny(EXPLICIT_PATTERNS, question)) {
      return { offer: true, reason: "explicit_request" };
    }

    // Never offer on a plainly educational exchange.
    if (matchesAny(EDUCATIONAL_PATTERNS, question) && responseType !== "decision") {
      return { offer: false, reason: "educational" };
    }

    var actionableReply = matchesAny(ACTIONABLE_PATTERNS, replyText) ||
      matchesAny(ACTIONABLE_PATTERNS, question);

    var decisionGuidance = responseType === "decision" && actionableReply;

    if (!actionableReply && !decisionGuidance) {
      return { offer: false, reason: "not_actionable" };
    }

    var hasMeaningfulPlan = !!(weekState && weekState.hasMeaningfulPlan);

    if (!hasMeaningfulPlan) {
      return { offer: true, reason: "no_current_plan" };
    }

    // Athlete has a plan already, but the guidance implies changing it
    // (taper, lighten, rebuild, recovery week, etc).
    var recommendsChange = /\btaper\b|\brecovery week\b|\brebuild|\brework|\brestructure|\blighten|\bdial back|\bscale back|\bease off|\bback off|\bswap/i.test(replyText);
    if (recommendsChange) {
      return { offer: true, reason: "recommends_change" };
    }

    return { offer: false, reason: "has_plan_no_change_recommended" };
  }

  root.AthlevoPlanIntent = {
    shouldOfferBuildPlan: shouldOfferBuildPlan
  };
})(typeof window !== "undefined" ? window : globalThis);
