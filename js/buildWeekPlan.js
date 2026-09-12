/*
 * Athlevo — canonical "Build this week's plan" action.
 *
 * ONE trigger for the whole product: Coach's contextual action chip and
 * Calendar's empty-state CTA both call AthlevoBuildWeekPlan.trigger(source).
 * Neither surface invents its own plan — both go through the SAME existing
 * training-plan architecture: a best-effort refresh of last week's analysis
 * followed by POST /api/training/generate-plan (see js/train.js
 * generateWeek(), which this reuses rather than duplicates), gated by the
 * SAME entitlement check (canUseTrainingFeature) the Train screen already
 * uses. No second plan engine, no invented training science.
 *
 * Anonymous visitors never reach generate-plan here: they are routed to
 * the existing signup CTA (openAiSignup), preserving the existing
 * anonymous Coach security boundary untouched.
 */
(function (root) {
  "use strict";

  function track(name, props) {
    try {
      if (root.AthlevoProductAnalytics &&
          typeof root.AthlevoProductAnalytics.trackAthlevoEvent === "function") {
        root.AthlevoProductAnalytics.trackAthlevoEvent(name, props || {});
      }
    } catch (e) { /* analytics must never break the flow */ }
  }

  function currentTier() {
    try {
      if (root.AthlevoAccessGuard && typeof root.AthlevoAccessGuard.cachedAccessState === "function") {
        return root.AthlevoAccessGuard.cachedAccessState();
      }
    } catch (e) {}
    return "unknown";
  }

  /*
   * Reads the SAME /api/training/get-week payload the rest of the app
   * already loads (js/train.js loadWeeklyPlan, js/coach.js
   * loadWeekExecutionForCoach) to describe the athlete's current week
   * without a second source of truth. "Meaningful" plan = has a plan AND
   * at least one future (not-yet-executed) planned session — so a fully
   * completed week still reads as needing a fresh build, but never
   * pretends there's no plan when future sessions already exist.
   */
  async function getCurrentWeekPlanState() {
    try {
      var session = (await root.supabaseClient.auth.getSession()).data.session;
      if (!session) return { hasPlan: false, hasMeaningfulPlan: false, authenticated: false };

      var res = await fetch("/api/training/get-week", {
        headers: { Authorization: "Bearer " + session.access_token }
      });
      if (!res.ok) return { hasPlan: false, hasMeaningfulPlan: false, authenticated: true };

      var data = await res.json();
      var sessions = Array.isArray(data.sessions) ? data.sessions : [];
      var todayKey = new Date().toISOString().slice(0, 10);
      var hasFuturePlanned = sessions.some(function (s) {
        return s && s.session_date && s.session_date >= todayKey &&
          !(s.execution && s.execution.status && s.execution.status !== "planned");
      });

      return {
        hasPlan: !!data.hasPlan,
        hasMeaningfulPlan: !!data.hasPlan && hasFuturePlanned,
        authenticated: true
      };
    } catch (e) {
      return { hasPlan: false, hasMeaningfulPlan: false, authenticated: true };
    }
  }

  function buildStructuralSummary(sessions) {
    var counts = { easy: 0, quality: 0, long: 0, rest: 0, other: 0 };
    (sessions || []).forEach(function (s) {
      var type = String((s && s.session_type) || "").toLowerCase();
      if (/rest/.test(type)) counts.rest += 1;
      else if (/long/.test(type)) counts.long += 1;
      else if (/threshold|interval|tempo|speed|quality|vo2/.test(type)) counts.quality += 1;
      else if (/easy|recovery/.test(type)) counts.easy += 1;
      else counts.other += 1;
    });
    var parts = [];
    if (counts.easy) parts.push(counts.easy + (counts.easy === 1 ? " easy run" : " easy runs"));
    if (counts.quality) parts.push(counts.quality + (counts.quality === 1 ? " quality session" : " quality sessions"));
    if (counts.long) parts.push(counts.long + " long run" + (counts.long === 1 ? "" : "s"));
    if (counts.rest) parts.push(counts.rest + " rest day" + (counts.rest === 1 ? "" : "s"));
    return parts.length ? parts.join(", ") : "your updated week";
  }

  /*
   * source: "coach" | "calendar". Returns true on success so the caller
   * (Coach chip / Calendar button) can decide what to render next.
   */
  async function trigger(source) {
    var src = source === "calendar" ? "calendar" : "coach";
    var tier = currentTier();

    var authed = !!root.athlevoSessionUserId;
    if (!authed) {
      // Anonymous: never persist a real plan. Coach can still have given
      // advice — the action becomes the existing acquisition CTA.
      track("plan_action_clicked", { source: src, authenticated: false, tier: "anonymous" });
      if (typeof root.openAiSignup === "function") {
        root.openAiSignup();
      } else if (typeof root.openSignup === "function") {
        root.openSignup(true);
      }
      return { ok: false, reason: "anonymous" };
    }

    var weekState = await getCurrentWeekPlanState();
    track("plan_action_clicked", {
      source: src, authenticated: true, tier: tier,
      had_existing_plan: !!weekState.hasMeaningfulPlan
    });

    if (!await (typeof root.canUseTrainingFeature === "function"
      ? root.canUseTrainingFeature("additional_plan_generation")
      : Promise.resolve(true))) {
      // Mirrors the existing Train-screen gate (js/train.js generateWeek).
      // A FIRST plan (no existing plan yet) is a Free-tier entitlement —
      // canUseTrainingFeature/generate-plan already resolve that
      // distinction server-side; this client check only short-circuits
      // the common "regenerate beyond allowance" case.
      if (weekState.hasMeaningfulPlan) {
        if (root.AthlevoAccessGuard && typeof root.AthlevoAccessGuard.openPaywall === "function") {
          root.AthlevoAccessGuard.openPaywall("training-plan");
        } else if (typeof root.toast === "function") {
          root.toast("Additional plans are available with Athlevo Pro.");
        }
        return { ok: false, reason: "entitlement" };
      }
    }

    // Existing future plan this week: confirm before touching it rather
    // than silently overwriting (completed/past days are protected
    // server-side regardless — see api/training/generate-plan.js).
    if (weekState.hasMeaningfulPlan) {
      var proceed = true;
      try {
        if (typeof root.confirm === "function") {
          proceed = root.confirm("Update the rest of this week?");
        }
      } catch (e) { proceed = true; }
      if (!proceed) return { ok: false, reason: "cancelled" };
    }

    if (typeof root.toast === "function") root.toast("Building your week…");
    track("plan_generation_started", { source: src });

    try {
      var session = (await root.supabaseClient.auth.getSession()).data.session;
      if (!session) throw new Error("no_session");

      // Best-effort freshness refresh — same as js/train.js generateWeek().
      try {
        await fetch("/api/training/weekly-analysis", {
          headers: { Authorization: "Bearer " + session.access_token }
        });
      } catch (e) { /* best effort */ }

      var genRes = await fetch("/api/training/generate-plan", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + session.access_token,
          "Content-Type": "application/json"
        },
        // Explicit rebuild request re-runs generation even when a full
        // week already exists (the endpoint's idempotency guard would
        // otherwise return the untouched existing plan). Completed and
        // past days are protected server-side regardless.
        body: JSON.stringify({ regenerate: !!weekState.hasMeaningfulPlan })
      });

      if (!genRes.ok) {
        var body = null;
        try { body = await genRes.json(); } catch (e) {}
        var missingInput = body && (body.code === "GOAL_REQUIRED" || body.code === "RACE_REQUIRED" ||
          body.code === "AVAILABILITY_REQUIRED" || body.error_field);
        track("plan_generation_failed", {
          source_surface: src, stage: "generate",
          failure_category: body && body.code ? String(body.code).toLowerCase() : "http_" + genRes.status
        });

        if (body && body.feature === "additional_plan_generation") {
          if (root.AthlevoAccessGuard && typeof root.AthlevoAccessGuard.openPaywall === "function") {
            root.AthlevoAccessGuard.openPaywall("training-plan");
          } else if (typeof root.toast === "function") {
            root.toast("Additional plans are available with Athlevo Pro.");
          }
          return { ok: false, reason: "entitlement" };
        }

        if (missingInput && src === "coach" && typeof root.addChatMessage === "function") {
          root.addChatMessage("ai", "Before I build the week, which days can you run?");
        } else if (typeof root.toast === "function") {
          root.toast("Couldn't build your week — please try again.");
        }
        return { ok: false, reason: "generation_failed" };
      }

      if (typeof root.loadWeeklyPlan === "function") {
        await root.loadWeeklyPlan();
      }
      if (root.AthlevoTrainCalendar && typeof root.AthlevoTrainCalendar.refresh === "function") {
        try { root.AthlevoTrainCalendar.refresh(); } catch (e) {}
      }

      var freshWeek = null;
      try {
        var weekRes = await fetch("/api/training/get-week", {
          headers: { Authorization: "Bearer " + session.access_token }
        });
        if (weekRes.ok) freshWeek = await weekRes.json();
      } catch (e) {}

      track("plan_generation_completed", {
        source: src, authenticated: true, tier: tier,
        had_existing_plan: !!weekState.hasMeaningfulPlan, week_offset: 0
      });

      if (typeof root.toast === "function") root.toast("Your training week is ready.");

      if (src === "coach" && typeof root.addChatMessage === "function") {
        var summary = buildStructuralSummary(freshWeek && freshWeek.sessions);
        root.addChatMessage("ai", "Your week is updated — " + summary + ".");
      }

      return { ok: true };
    } catch (error) {
      track("plan_generation_failed", {
        source_surface: src, stage: "network",
        failure_category: "network_error"
      });
      if (typeof root.toast === "function") root.toast("Couldn't build your week — please try again.");
      return { ok: false, reason: "network" };
    }
  }

  root.AthlevoBuildWeekPlan = {
    trigger: trigger,
    getCurrentWeekPlanState: getCurrentWeekPlanState
  };
})(window);
