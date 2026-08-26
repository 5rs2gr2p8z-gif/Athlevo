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
    data_connection_started:     { kind: "behavioural", props: ["provider", "source_surface", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    provider_skipped:             { kind: "milestone",   props: ["source_surface"] },
    free_account_created:          { kind: "milestone",   props: ["auth_method", "source"] },
    onboarding_completed:         { kind: "milestone",   props: ["experience_level"] },
    data_connection_completed:    { kind: "milestone",   props: ["provider"] },
    first_value_viewed:           { kind: "milestone",   props: ["value_type", "source_surface", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    activation_completed:         { kind: "milestone",   props: ["value_type", "source_surface", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] },
    signup_failed:                { kind: "behavioural", props: ["stage", "failure_category", "provider", "source_surface"] },
    onboarding_failed:            { kind: "behavioural", props: ["stage", "failure_category", "source_surface"] },
    data_connection_failed:       { kind: "behavioural", props: ["stage", "failure_category", "provider", "source_surface"] },
    activation_failed:            { kind: "behavioural", props: ["stage", "failure_category", "source_surface"] },
    free_limit_reached:           { kind: "behavioural", props: ["feature", "limit_period", "source"] },
    premium_feature_viewed:       { kind: "behavioural", props: ["feature", "surface"] },
    upgrade_clicked:              { kind: "behavioural", props: ["feature", "surface"] },
    upgrade_sheet_viewed:         { kind: "behavioural", props: ["feature", "surface", "access_tier"] },
    checkout_started:             { kind: "behavioural", props: ["feature", "surface"] },
    checkout_failed:              { kind: "behavioural", props: ["stage", "failure_category", "source_surface"] },
    subscription_activated:       { kind: "milestone",   props: ["source"] },
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
    // Multi-sport classification taxonomy. Categorical only — never distance,
    // power, HR, titles, athlete ids, or raw payloads.
    activity_classified:           { kind: "behavioural", props: ["canonical_sport", "provider", "classification_source", "mapping_status"] },
    activity_type_unmapped:        { kind: "behavioural", props: ["provider", "classification_source", "mapping_status"] },
    sport_filter_viewed:           { kind: "behavioural", props: ["canonical_sport"] },
    // Coach dashboard taxonomy. Categorical only — never athlete name, email,
    // UUID, workout titles, pain notes, readiness values, distance, or power.
    coach_dashboard_viewed:        { kind: "behavioural", props: ["dashboard_surface", "roster_size_band"] },
    coach_roster_athlete_opened:   { kind: "behavioural", props: ["dashboard_surface", "athlete_sport"] },
    coach_attention_item_viewed:   { kind: "behavioural", props: ["attention_reason", "attention_severity", "athlete_sport"] },
    coach_attention_item_reviewed: { kind: "behavioural", props: ["attention_reason", "attention_severity", "athlete_sport"] },
    // Coach Mode events (Phase 15 — categorical only, never name/email/UUID)
    coach_mode_resolved:           { kind: "behavioural", props: ["coach_mode"] },
    coach_today_viewed:            { kind: "behavioural", props: ["coach_mode", "source_surface", "roster_size_band"] },
    coach_today_attention_opened:  { kind: "behavioural", props: ["coach_mode", "source_surface", "attention_reason", "attention_severity"] },
    coach_today_athlete_opened:    { kind: "behavioural", props: ["coach_mode", "source_surface"] },
    coach_tab_viewed:              { kind: "behavioural", props: ["coach_mode", "source_surface", "tab_name"] },
    coach_train_viewed:            { kind: "behavioural", props: ["coach_mode", "source_surface", "tab_name"] },
    coach_trends_viewed:           { kind: "behavioural", props: ["coach_mode", "source_surface", "tab_name"] },
    coach_you_viewed:              { kind: "behavioural", props: ["coach_mode", "source_surface", "tab_name"] },
    // Onboarding role choice & coach application events (categorical only —
    // never name, email, UUID, coaching brand, sports arrays, or free text)
    onboarding_role_choice_viewed: { kind: "behavioural", props: ["source_surface"] },
    onboarding_role_selected:      { kind: "behavioural", props: ["selected_role", "source_surface"] },
    coach_application_started:     { kind: "milestone",   props: ["source_surface"] },
    coach_application_submitted:   { kind: "milestone",   props: ["application_status", "source_surface"] },
    // Workspace switcher events (categorical only — never name/email/UUID)
    workspace_switcher_viewed:     { kind: "behavioural", props: ["source_surface"] },
    workspace_switched:            { kind: "behavioural", props: ["from_workspace", "to_workspace", "source_surface"] },
    // Managed athlete mode taxonomy. Categorical only — never coach email,
    // athlete UUID, workout content, pain/injury notes, or provider payloads.
    athlete_coaching_mode_resolved: { kind: "behavioural", props: ["coaching_mode"] },
    assigned_coach_viewed:          { kind: "behavioural", props: [] },
    coach_managed_plan_viewed:      { kind: "behavioural", props: [] },
    coach_adjustment_requested:     { kind: "behavioural", props: ["request_type"] },
    managed_coach_tab_viewed:       { kind: "behavioural", props: [] },
    first_workout_analysis_viewed: { kind: "milestone",   props: ["workout_type"] },
    plan_generation_started:       { kind: "behavioural", props: ["plan_goal_type"] },
    first_plan_generated:          { kind: "milestone",   props: ["plan_goal_type", "user_id", "goal_distance", "plan_start_date"] },
    plan_generation_failed:        { kind: "behavioural", props: ["stage", "failure_category", "source_surface"] },
    coach_opened:                  { kind: "behavioural", props: ["screen_name"] },
    first_coach_message_sent:      { kind: "milestone",   props: [] },
    coach_message_submitted:       { kind: "behavioural", props: ["access_tier", "source_surface"] },
    coach_message_completed:       { kind: "behavioural", props: ["access_tier", "source_surface"] },
    coach_weekly_limit_reached:    { kind: "behavioural", props: ["access_tier", "source_surface"] },
    coach_request_failed:          { kind: "behavioural", props: ["access_tier", "failure_category", "source_surface"] },
    adaptive_plan_reviewed:        { kind: "behavioural", props: [] },
    adaptive_plan_applied:         { kind: "behavioural", props: ["change_count_bucket"] },
    readiness_prompt_shown:        { kind: "behavioural", props: ["source"] },
    readiness_prompt_dismissed:    { kind: "behavioural", props: ["source"] },
    readiness_check_completed:     { kind: "behavioural", props: ["source", "completion_status"] },
    app_returned:                   { kind: "behavioural", props: [] },
    app_session_started:           { kind: "behavioural", props: ["source"] },
    primary_tab_viewed:            { kind: "behavioural", props: ["screen_name"] },
    // Pre-signup diagnostic events (categorical only — never injury
    // free text, pain descriptions, or medical details)
    diagnostic_viewed:             { kind: "behavioural", props: [] },
    diagnostic_started:            { kind: "milestone",   props: [] },
    diagnostic_resumed:            { kind: "behavioural", props: ["state"] },
    diagnostic_question_answered:  { kind: "behavioural", props: ["question_key", "questions_completed"] },
    diagnostic_insight_shown:      { kind: "behavioural", props: ["question_key"] },
    diagnostic_completed:          { kind: "milestone",   props: ["questions_answered", "primary_limiter", "recommended_product", "feasibility_rating", "injury_reported"] },
    diagnostic_result_viewed:      { kind: "behavioural", props: ["primary_limiter", "recommended_product", "feasibility_rating", "injury_reported"] },
    product_recommended:           { kind: "behavioural", props: ["recommended_product", "feasibility_rating"] },
    alternative_products_viewed:  { kind: "behavioural", props: ["recommended_product"] },
    product_selected:              { kind: "behavioural", props: ["recommended_product", "selected_product"] },
    diagnostic_signup_tapped:      { kind: "behavioural", props: ["recommended_product", "feasibility_rating"] },
    diagnostic_import_started:     { kind: "behavioural", props: [] },
    diagnostic_import_completed:   { kind: "milestone",   props: ["questions_answered", "primary_limiter", "recommended_product", "feasibility_rating", "injury_reported"] },
    diagnostic_import_failed:      { kind: "behavioural", props: ["stage", "failure_category"] }
  };

  // Legacy names still emitted by older call sites → the canonical event they
  // mean. track() records the canonical name so there is only ever ONE name
  // per action, while old instrumentation keeps working unchanged.
  var ALIASES = {
    signup_completed:     "free_account_created",
    profile_completed:    "onboarding_completed",
    connect_step_viewed:  "wearable_setup_started",
    intervals_connected:  "data_connection_completed",
    checkout_opened:      "checkout_started",
    paid_subscription_activated: "subscription_activated",
    coach_upgrade_sheet_viewed: "upgrade_sheet_viewed",
    initial_sync_started: "first_sync_started",
    initial_sync_completed:"first_activity_imported",
    activities_detected:  "first_sync_started",
    dashboard_opened:     "app_session_started",
    sync_failed:          "wearable_connection_failed"
  };

  // Keys that must NEVER be recorded, even if allow-listed by mistake elsewhere.
  var PROHIBITED_KEYS = /(email|name|token|secret|message|content|text|note|gps|lat|lng|lon|coord|address|phone|payload|raw|workout|injury|pain|dob|birth|password)/i;
  var APPROVED_NAMED_KEYS = { cta_text: true, utm_content: true, injury_reported: true };
  var APPROVED_CTA_TEXT = { "Build My Training Plan": true };
  var APPROVED_HANDOFF_VALUES = {
    browser: { facebook: true, instagram: true },
    intent: { signup: true, login: true },
    source_surface: {
      landing: true, auth: true, coach: true, onboarding: true,
      provider_connection: true, plan_generation: true, train: true,
      today: true, trends: true, upgrade_sheet: true
    },
    access_tier: {
      free: true,
      paid_active: true,
      paid_inactive: true,
      unknown: true
    },
    provider: {
      google: true, email: true, strava: true, intervals: true, whop: true,
      garmin: true, coros: true, polar: true, apple: true, suunto: true,
      other: true
    },
    stage: {
      auth_start: true, registration: true, session_restore: true,
      profile_load: true, profile_save: true, provider_authorization: true,
      provider_callback: true, provider_sync: true, plan_generation: true,
      first_value: true, checkout_open: true, webhook: true
    },
    failure_category: {
      auth: true, browser: true, cancelled: true, configuration: true,
      conflict: true, existing_account: true, invalid_state: true,
      network: true, not_connected: true, permission: true,
      popup_blocked: true, provider: true, rate_limit: true, server: true,
      session: true, timeout: true, unavailable: true, validation: true,
      unknown: true
    },
    value_type: { training_plan: true },
    coaching_mode: { self_guided: true, human_coached: true },
    request_type: { adjustment: true, unable_to_complete: true, move: true, feedback: true, availability: true },
    selected_role: { athlete: true, coach: true },
    application_status: { pending: true }
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
