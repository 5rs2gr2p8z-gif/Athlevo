/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Analytics Event Registry  (the single canonical taxonomy)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  ONE source of truth for every measurable moment in the beta funnel. Stable
 *  snake_case names, each with: whether it fires once (milestone) or may repeat
 *  (behavioural), and the ONLY categorical properties it may carry.
 *
 *  Privacy by construction: sanitizeProps() keeps ONLY an event's allowed keys
 *  and only short scalar values — so raw workout data, GPS, tokens, message
 *  text, emails, names, provider payloads, and free-form input can never reach
 *  analytics even if a caller passes them by mistake.
 *
 *  Dual-consumable: window.AthlevoAnalyticsRegistry in the browser, and
 *  module.exports for Node (server aggregation + tests).
 */
(function (root) {
  "use strict";

  var VERSION = "analytics-registry-v1";

  // event → { kind, props }.  kind: "milestone" (once/athlete) | "behavioural".
  var EVENTS = {
    landing_viewed:               { kind: "behavioural", props: ["page_url", "page_path", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    signup_cta_clicked:           { kind: "behavioural", props: ["cta_text", "cta_location", "destination", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    auth_screen_viewed:           { kind: "behavioural", props: ["entry_source", "previous_page", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    google_signup_clicked:        { kind: "behavioural", props: ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    email_signup_clicked:         { kind: "behavioural", props: ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    login_clicked:                { kind: "behavioural", props: ["entry_source", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    in_app_browser_signup_blocked:{ kind: "behavioural", props: ["browser", "intent", "source_surface"] },
    external_signup_link_copied:  { kind: "behavioural", props: ["browser", "intent", "source_surface"] },
    external_signup_continuation_viewed:{ kind: "behavioural", props: ["browser", "intent", "source_surface"] },
    registration_completed:      { kind: "milestone",   props: ["signup_method", "user_id", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    onboarding_started:          { kind: "milestone",   props: ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    data_connection_started:     { kind: "behavioural", props: ["provider", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    free_account_created:          { kind: "milestone",   props: ["auth_method", "source"] },
    onboarding_completed:         { kind: "milestone",   props: ["experience_level"] },
    data_connection_completed:    { kind: "milestone",   props: ["provider"] },
    free_limit_reached:           { kind: "behavioural", props: ["feature", "limit_period", "source"] },
    premium_feature_viewed:       { kind: "behavioural", props: ["feature", "surface"] },
    upgrade_clicked:              { kind: "behavioural", props: ["feature", "surface"] },
    checkout_opened:              { kind: "behavioural", props: ["feature", "surface"] },
    paid_subscription_activated:  { kind: "milestone",   props: ["source"] },
    account_created:               { kind: "milestone",   props: ["method", "source"] },
    email_verified:                { kind: "milestone",   props: [] },
    athlete_onboarding_started:    { kind: "milestone",   props: [] },
    athlete_onboarding_completed:  { kind: "milestone",   props: ["experience_level"] },
    wearable_setup_started:        { kind: "milestone",   props: ["provider_type"] },
    sync_account_step_viewed:      { kind: "behavioural", props: [] },
    wearable_provider_step_viewed: { kind: "behavioural", props: ["provider_type"] },
    wearable_connection_succeeded: { kind: "milestone",   props: ["provider_type"] },
    wearable_connection_failed:    { kind: "behavioural", props: ["provider_type", "failure_category"] },
    first_sync_started:            { kind: "milestone",   props: ["provider_type"] },
    first_activity_imported:       { kind: "milestone",   props: ["activity_type", "activity_count_bucket"] },
    activity_imported:             { kind: "behavioural", props: ["activity_type"] },
    first_workout_analysis_viewed: { kind: "milestone",   props: ["workout_type"] },
    plan_generation_started:       { kind: "behavioural", props: ["plan_goal_type"] },
    first_plan_generated:          { kind: "milestone",   props: ["plan_goal_type", "user_id", "goal_distance", "plan_start_date"] },
    plan_generation_failed:        { kind: "behavioural", props: ["failure_category"] },
    coach_opened:                  { kind: "behavioural", props: ["screen_name"] },
    first_coach_message_sent:      { kind: "milestone",   props: [] },
    adaptive_plan_reviewed:        { kind: "behavioural", props: [] },
    adaptive_plan_applied:         { kind: "behavioural", props: ["change_count_bucket"] },
    readiness_prompt_shown:        { kind: "behavioural", props: ["source"] },
    readiness_prompt_dismissed:    { kind: "behavioural", props: ["source"] },
    readiness_check_completed:     { kind: "behavioural", props: ["source", "completion_status"] },
    app_session_started:           { kind: "behavioural", props: ["source"] },
    primary_tab_viewed:            { kind: "behavioural", props: ["screen_name"] }
  };

  // Legacy names still emitted by older call sites → the canonical event they
  // mean. track() records the canonical name so there is only ever ONE name
  // per action, while old instrumentation keeps working unchanged.
  var ALIASES = {
    signup_completed:     "free_account_created",
    profile_completed:    "onboarding_completed",
    connect_step_viewed:  "wearable_setup_started",
    intervals_connected:  "data_connection_completed",
    initial_sync_started: "first_sync_started",
    initial_sync_completed:"first_activity_imported",
    activities_detected:  "first_sync_started",
    dashboard_opened:     "app_session_started",
    sync_failed:          "wearable_connection_failed"
  };

  // Keys that must NEVER be recorded, even if allow-listed by mistake elsewhere.
  var PROHIBITED_KEYS = /(email|name|token|secret|message|content|text|note|gps|lat|lng|lon|coord|address|phone|payload|raw|workout|injury|pain|dob|birth|password)/i;
  var APPROVED_NAMED_KEYS = { cta_text: true, utm_content: true };
  var APPROVED_CTA_TEXT = { "Build My Training Plan": true };
  var APPROVED_HANDOFF_VALUES = {
    browser: { facebook: true, instagram: true },
    intent: { signup: true, login: true },
    source_surface: { landing: true, auth: true }
  };

  function canonicalName(name) {
    if (ALIASES[name]) return ALIASES[name];
    return name;
  }
  function isKnown(name) { return Object.prototype.hasOwnProperty.call(EVENTS, canonicalName(name)); }
  function def(name) { return EVENTS[canonicalName(name)] || null; }
  function isMilestone(name) { var d = def(name); return !!d && d.kind === "milestone"; }
  function kindOf(name) { var d = def(name); return d ? d.kind : "behavioural"; }

  // Keep ONLY the event's allowed keys, and only short scalar values. Anything
  // else — objects, long strings (free text), prohibited keys — is dropped.
  function sanitizeProps(name, props) {
    var d = def(name);
    if (!d || !props || typeof props !== "object") return null;
    var out = {}, kept = 0;
    d.props.forEach(function (key) {
      if (PROHIBITED_KEYS.test(key) && !APPROVED_NAMED_KEYS[key]) return;
      var v = props[key];
      if (v == null) return;
      var tv = typeof v;
      if (tv === "number" || tv === "boolean") { out[key] = v; kept++; return; }
      if (key === "cta_text" && !APPROVED_CTA_TEXT[String(v).trim()]) return;
      if (APPROVED_HANDOFF_VALUES[key] &&
          !APPROVED_HANDOFF_VALUES[key][String(v).trim()]) return;
      var max = /^(page_url|referrer|fbclid)$/.test(key) ? 500 :
        (/^(page_path|previous_page|destination)$/.test(key) ? 200 : 80);
      if (tv === "string" && v.length > 0 && v.length <= max && !/\s{2,}/.test(v)) { out[key] = v; kept++; }
    });
    return kept ? out : null;
  }

  var api = {
    VERSION: VERSION, EVENTS: EVENTS, ALIASES: ALIASES,
    names: function () { return Object.keys(EVENTS); },
    canonicalName: canonicalName, isKnown: isKnown, isMilestone: isMilestone,
    kindOf: kindOf, sanitizeProps: sanitizeProps, PROHIBITED_KEYS: PROHIBITED_KEYS
  };
  if (root) root.AthlevoAnalyticsRegistry = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
