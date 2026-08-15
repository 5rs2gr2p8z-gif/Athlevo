/*
 * Athlevo coach-invite acceptance UI. The raw token lives only in
 * sessionStorage and request bodies; it is never copied to persistent browser
 * storage, analytics, DOM attributes, or application logs.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "athlevo_pending_invite";
  var activeResume = null;
  var activeResolve = null;
  var previousFocus = null;

  function pendingToken() {
    try { return String(sessionStorage.getItem(STORAGE_KEY) || "").trim(); }
    catch (e) { return ""; }
  }

  function clearPendingToken() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  async function accessToken() {
    if (typeof supabaseClient === "undefined" || !supabaseClient) return null;
    try {
      var result = await supabaseClient.auth.getSession();
      return result && result.data && result.data.session && result.data.session.access_token || null;
    } catch (e) { return null; }
  }

  async function inviteRequest(token, intent) {
    var bearer = await accessToken();
    if (!bearer) return { ok: false, status: 401, body: { error: "Authentication is required." } };
    try {
      var response = await fetch("/api/providers?action=coaching_invite_accept", {
        method: "POST",
        headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ token: token, intent: intent })
      });
      var body = {};
      try { body = await response.json(); } catch (e) {}
      return { ok: response.ok, status: response.status, body: body || {} };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "The invitation could not be verified." } };
    }
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function ensureStyles() {
    if (document.getElementById("coachInviteAcceptStyles")) return;
    var style = document.createElement("style");
    style.id = "coachInviteAcceptStyles";
    style.textContent =
      ".ci-accept-overlay{position:fixed;inset:0;z-index:240;background:var(--backdrop,rgba(20,20,22,.48));display:flex;align-items:flex-end;justify-content:center}" +
      ".ci-accept-sheet{width:100%;max-width:480px;max-height:90vh;overflow:auto;box-sizing:border-box;background:var(--surface-base,#fff);color:var(--text,#141416);border-radius:26px 26px 0 0;padding:22px 20px calc(22px + env(safe-area-inset-bottom));box-shadow:var(--elev-3)}" +
      ".ci-accept-sheet h2{margin:0;font-family:var(--serif,serif);font-size:24px;font-weight:520;line-height:1.15}" +
      ".ci-accept-sheet p{margin:10px 0 0;color:var(--ink2,#6d7075);font-size:14px;line-height:1.55;overflow-wrap:anywhere}" +
      ".ci-account-lines{margin-top:18px;padding:12px 0;border-block:1px solid var(--line,#ebebe8)}" +
      ".ci-account-lines span{display:block;color:var(--ink3,#9a9da3);font-size:11px;margin-bottom:3px}" +
      ".ci-account-lines strong{display:block;font-size:13px;overflow-wrap:anywhere}" +
      ".ci-account-lines strong+span{margin-top:12px}" +
      ".ci-accept-actions{display:grid;gap:9px;margin-top:22px}" +
      ".ci-accept-actions button{min-height:46px;border:1px solid var(--line,#ebebe8);border-radius:999px;background:transparent;color:inherit;font:700 13px/1 var(--sans,sans-serif);padding:12px 16px;cursor:pointer}" +
      ".ci-accept-actions .primary{border-color:var(--red,#c0272d);background:var(--red,#c0272d);color:#fff}" +
      ".ci-accept-actions button:disabled{opacity:.55;cursor:default}" +
      ".ci-accept-error{color:var(--bad,#c0272d)!important;font-size:12px!important}" +
      "@media(min-width:600px){.ci-accept-overlay{align-items:center;padding:20px}.ci-accept-sheet{border-radius:22px}}";
    document.head.appendChild(style);
  }

  function closeSheet(result) {
    var overlay = document.getElementById("coachInviteAcceptOverlay");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener("keydown", onKeyDown);
    if (previousFocus && typeof previousFocus.focus === "function") {
      try { previousFocus.focus(); } catch (e) {}
    }
    previousFocus = null;
    var resolve = activeResolve;
    activeResolve = null;
    if (resolve) resolve(result || { outcome: "closed" });
  }

  function onKeyDown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeSheet({ outcome: "not_now" });
  }

  function showSheet(content, bind) {
    ensureStyles();
    var existing = document.getElementById("coachInviteAcceptOverlay");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    previousFocus = document.activeElement;
    var overlay = document.createElement("div");
    overlay.id = "coachInviteAcceptOverlay";
    overlay.className = "ci-accept-overlay";
    overlay.innerHTML = '<section class="ci-accept-sheet" role="dialog" aria-modal="true" aria-labelledby="ciAcceptTitle">' + content + "</section>";
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown);
    if (typeof bind === "function") bind(overlay);
    var first = overlay.querySelector("button,input,[tabindex]");
    if (first) setTimeout(function () { first.focus(); }, 0);
  }

  function waitForDecision(preview, token) {
    return new Promise(function (resolve) {
      activeResolve = resolve;
      var state = preview.state;
      if (state === "wrong_email") {
        showSheet(
          '<h2 id="ciAcceptTitle">Switch account to accept</h2>' +
          '<p>This invitation can only be accepted by the athlete it was sent to.</p>' +
          '<div class="ci-account-lines"><span>This invitation was sent to:</span><strong>' + esc(preview.invitation_email) + '</strong>' +
          '<span>You are currently signed in as:</span><strong>' + esc(preview.current_email) + '</strong></div>' +
          '<div class="ci-accept-actions"><button class="primary" id="ciSwitchAccount">Sign out and switch account</button><button id="ciInviteCancel">Cancel</button></div>',
          function (root) {
            root.querySelector("#ciSwitchAccount").addEventListener("click", async function () {
              closeSheet({ outcome: "switch_account", stopRouting: true });
              if (typeof window.doLogout === "function") await window.doLogout();
            });
            root.querySelector("#ciInviteCancel").addEventListener("click", function () {
              clearPendingToken();
              closeSheet({ outcome: "cancelled" });
            });
          }
        );
        return;
      }

      if (state === "expired") {
        clearPendingToken();
        showSheet(
          '<h2 id="ciAcceptTitle">This invitation has expired</h2><p>Ask your coach to send a new invitation.</p>' +
          '<div class="ci-accept-actions"><button class="primary" id="ciInviteOpen">Open Athlevo</button></div>',
          function (root) { root.querySelector("#ciInviteOpen").addEventListener("click", function () { closeSheet({ outcome: "expired" }); }); }
        );
        return;
      }

      if (state === "accepted") {
        clearPendingToken();
        showSheet(
          '<h2 id="ciAcceptTitle">This invitation has already been accepted</h2>' +
          '<div class="ci-accept-actions"><button class="primary" id="ciInviteOpen">Open Athlevo</button></div>',
          function (root) { root.querySelector("#ciInviteOpen").addEventListener("click", function () { closeSheet({ outcome: "already_accepted" }); }); }
        );
        return;
      }

      if (state !== "pending") {
        clearPendingToken();
        showSheet(
          '<h2 id="ciAcceptTitle">Invitation unavailable</h2><p>This invitation link is no longer valid.</p>' +
          '<div class="ci-accept-actions"><button id="ciInviteOpen">Open Athlevo</button></div>',
          function (root) { root.querySelector("#ciInviteOpen").addEventListener("click", function () { closeSheet({ outcome: "invalid" }); }); }
        );
        return;
      }

      showSheet(
        '<h2 id="ciAcceptTitle">Join your coach</h2><p><strong>' + esc(preview.coach_name) + '</strong> invited you to join their coaching roster.</p>' +
        '<p class="ci-accept-error" id="ciAcceptError" aria-live="polite"></p>' +
        '<div class="ci-accept-actions"><button class="primary" id="ciAcceptInvite">Accept Invitation</button><button id="ciNotNow">Not now</button></div>',
        function (root) {
          root.querySelector("#ciNotNow").addEventListener("click", function () {
            closeSheet({ outcome: "not_now" });
          });
          root.querySelector("#ciAcceptInvite").addEventListener("click", async function () {
            var button = root.querySelector("#ciAcceptInvite");
            var error = root.querySelector("#ciAcceptError");
            button.disabled = true;
            button.textContent = "Accepting…";
            error.textContent = "";
            var result = await inviteRequest(token, "accept");
            if (result.ok && (result.body.accepted || result.body.already_accepted)) {
              clearPendingToken();
              if (window.AthlevoAthleteMode && typeof window.AthlevoAthleteMode.retry === "function") {
                try { await window.AthlevoAthleteMode.retry(); } catch (e) {}
              }
              if (window.AthlevoBrain && typeof window.AthlevoBrain.refreshAthleteUI === "function") {
                try { await window.AthlevoBrain.refreshAthleteUI(); } catch (e) {}
              }
              if (typeof window.toast === "function") window.toast("Invitation accepted");
              closeSheet({ outcome: "accepted" });
              return;
            }
            if (result.body && result.body.state === "expired") {
              clearPendingToken();
              error.textContent = "This invitation has expired. Ask your coach to send a new one.";
            } else if (result.body && result.body.state === "wrong_email") {
              error.textContent = "Sign in with the email address that received this invitation.";
            } else {
              error.textContent = result.body && result.body.error || "The invitation could not be accepted. Please try again.";
            }
            button.disabled = false;
            button.textContent = "Accept Invitation";
          });
        }
      );
    });
  }

  function resumeAfterAuth() {
    if (activeResume) return activeResume;
    var token = pendingToken();
    if (!token) return Promise.resolve({ outcome: "none" });
    activeResume = (async function () {
      var previewResult = await inviteRequest(token, "preview");
      var preview = previewResult.body || {};
      if (!previewResult.ok && !preview.state) preview.state = "invalid";
      return waitForDecision(preview, token);
    })();
    return activeResume.finally(function () { activeResume = null; });
  }

  window.AthlevoCoachInvites = {
    resumeAfterAuth: resumeAfterAuth,
    hasPendingInvite: function () { return Boolean(pendingToken()); },
    clearPendingInvite: clearPendingToken,
    _pendingToken: pendingToken
  };
})();
