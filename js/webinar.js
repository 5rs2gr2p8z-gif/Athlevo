/*
 * Athlevo webinar registration form (/webinar).
 *
 * Checks the fields, shows the page's own error messages (they are in the HTML, hidden until
 * needed, so no wording lives here), posts to /api/webinar/register, and sends the runner to
 * /webinar/thank-you. The server checks everything again; this is only the quick feedback.
 * Without JavaScript the form still posts normally and the server sends the runner on.
 */
(function (global) {
  "use strict";

  var THANK_YOU = "/webinar/thank-you";
  var FIELDS = ["name", "mobile", "email", "distance", "training"];
  var DISTANCES = ["5k", "10k", "16k", "not-registered"];
  var TRAINING = ["no-plan", "loose-routine", "structured-plan"];

  /** Returns { name?, mobile?, email?, distance?, training? } for every field that is not acceptable. */
  function validate(values) {
    var errors = {};
    var name = String(values.name || "").replace(/\s+/g, " ").trim();
    if (name.length < 2) errors.name = true;
    var digits = String(values.mobile || "").replace(/[\s().\-]/g, "");
    if (!/^\+?\d{7,15}$/.test(digits)) errors.mobile = true;
    var email = String(values.email || "").trim();
    if (email && !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(email)) errors.email = true;
    if (DISTANCES.indexOf(values.distance) === -1) errors.distance = true;
    if (TRAINING.indexOf(values.training) === -1) errors.training = true;
    return errors;
  }

  global.AthlevoWebinar = { validate: validate };

  var doc = global.document;
  if (!doc || !doc.getElementById) return;
  var form = doc.getElementById("register");
  if (!form) return;

  var statusEl = doc.getElementById("webinar-form-error");
  var button = form.querySelector("button[type=submit]");
  var busy = false;

  function control(field) { return doc.getElementById("webinar-" + field); }
  function errorEl(field) { return doc.getElementById("webinar-" + field + "-error"); }

  function showError(field) {
    var input = control(field);
    var message = errorEl(field);
    if (!input || !message) return;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", message.id);
    message.hidden = false;
  }

  function clearError(field) {
    var input = control(field);
    var message = errorEl(field);
    if (!input || !message) return;
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    message.hidden = true;
  }

  function setStatus(on) {
    if (!statusEl) return;
    statusEl.textContent = on ? statusEl.getAttribute("data-message") || "" : "";
  }

  function readValues() {
    var values = {};
    FIELDS.concat(["question"]).forEach(function (field) {
      var input = control(field);
      values[field] = input ? input.value : "";
    });
    return values;
  }

  FIELDS.forEach(function (field) {
    var input = control(field);
    if (!input) return;
    var clear = function () { clearError(field); };
    input.addEventListener("input", clear);
    input.addEventListener("change", clear);
  });

  function setBusy(on) {
    busy = on;
    if (!button) return;
    button.disabled = on;
    if (on) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (busy) return;
    setStatus(false);
    var values = readValues();
    var errors = validate(values);
    var invalid = FIELDS.filter(function (field) { return errors[field]; });
    FIELDS.forEach(function (field) { if (errors[field]) showError(field); else clearError(field); });
    if (invalid.length) {
      control(invalid[0]).focus();
      return;
    }

    var trap = form.elements.contact_website;
    var body = {
      name: values.name,
      mobile: values.mobile,
      email: values.email,
      distance: values.distance,
      training: values.training,
      question: values.question,
      contact_website: trap ? trap.value : ""
    };
    setBusy(true);
    global.fetch(form.getAttribute("action") || "/api/webinar/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (response.ok) {
        global.location.assign(THANK_YOU);
        return null;
      }
      return response.json().catch(function () { return null; }).then(function (data) {
        var fields = data && data.fields;
        var shown = false;
        if (response.status === 400 && fields && typeof fields === "object") {
          FIELDS.forEach(function (field) {
            if (fields[field]) { showError(field); if (!shown) { control(field).focus(); shown = true; } }
          });
        }
        if (!shown) setStatus(true);
        setBusy(false);
      });
    }).catch(function () {
      setStatus(true);
      setBusy(false);
    });
  });
})(typeof window !== "undefined" ? window : globalThis);
