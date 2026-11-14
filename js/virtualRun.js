/*
 * Athlevo Sub-1 10k Challenge registration (/virtual-run).
 *
 * What this does: asks the server whether registration is open, runs the four-step form with quick
 * checks, sends the registration to /api/virtual-run/register, and hands the runner to PayMongo.
 * When the runner comes back it asks the server whether the payment was confirmed and shows the
 * confirmation only from what the server says.
 *
 * What this does not do: decide anything that matters. Prices, availability and "paid" all come from
 * the server (lib/server/virtualRun.js and the PayMongo webhook). The browser never sends a price.
 * All wording is in the page's embedded config (content/virtualRun.mjs), so none lives here.
 */
(function (global) {
  "use strict";

  var STEP_FIELDS = {
    1: ["fullName", "email", "mobile", "dob", "gender"],
    2: ["pb5k", "pb10k", "frequency", "goal"],
    3: ["package", "shirtSize", "recipient", "address", "province", "city", "barangay", "postal"],
    4: ["rules", "privacy"]
  };
  var PB_LIMITS = { pb5k: [12 * 60, 90 * 60], pb10k: [25 * 60, 180 * 60] };
  var REFERENCE = /^ATH-VR-[0-9A-F]{8,16}-[0-9A-F]{24}$/;
  var POLL_MS = 2500;
  var POLL_MAX = 24;
  var TOTAL_STEPS = 4;
  var EMAIL_PATTERN = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
  var LEAVE_TOKEN = /^ATH-WL-[0-9A-F]{32}$/;
  var SOURCE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

  /* ------------------------------------------------------------------ checks (pure, tested in node) */

  function squash(value) {
    return String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim();
  }

  function fill(text, values) {
    return String(text).replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
    });
  }

  /** "24:30" or "1:05:00" -> seconds, or null when it is not a time. */
  function parseRaceTime(value) {
    var match = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/.exec(squash(value));
    if (!match) return null;
    var hours = match[1] === undefined ? 0 : Number(match[1]);
    return hours * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }

  /** Whole years old on `now`, counted on the Manila calendar (UTC+8, no daylight saving). null when not a real date. */
  function ageOn(iso, now) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(squash(iso));
    if (!match) return null;
    var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    var probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    var today = new Date(now.getTime() + 8 * 3600 * 1000);
    var age = today.getUTCFullYear() - year;
    var m = today.getUTCMonth() + 1, d = today.getUTCDate();
    if (m < month || (m === month && d < day)) age -= 1;
    return age;
  }

  function packageIn(config, id) {
    var list = (config && config.packages) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
    return null;
  }

  /**
   * Checks every field and returns { field: code } for the ones that are not acceptable.
   * The code is the field name, or "dobAge" / "delivery" where the message is more specific.
   * The server runs the same checks again and is the one that counts.
   */
  function validate(values, config, now) {
    var v = values || {};
    var cfg = config || {};
    var when = now || new Date();
    var errors = {};

    if (squash(v.fullName).length < 2) errors.fullName = "fullName";

    var email = squash(v.email);
    if (!(email.length <= 254 && EMAIL_PATTERN.test(email))) errors.email = "email";

    if (!/^\+?\d{7,15}$/.test(squash(v.mobile).replace(/[\s().\-]/g, ""))) errors.mobile = "mobile";

    var age = ageOn(v.dob, when);
    if (age === null || age < 0 || age > 110) errors.dob = "dob";
    else if (age < (cfg.minAge || 0)) errors.dob = "dobAge";

    if (v.gender && (cfg.genders || []).indexOf(v.gender) === -1) errors.gender = "gender";

    ["pb5k", "pb10k"].forEach(function (field) {
      var raw = squash(v[field]);
      if (!raw) return;
      var seconds = parseRaceTime(raw);
      if (seconds === null || seconds < PB_LIMITS[field][0] || seconds > PB_LIMITS[field][1]) errors[field] = field;
    });

    if ((cfg.frequencies || []).indexOf(v.frequency) === -1) errors.frequency = "frequency";
    if ((cfg.goals || []).indexOf(v.goal) === -1) errors.goal = "goal";

    var pkg = packageIn(cfg, v.packageId);
    if (!pkg) errors.package = "package";
    else if (pkg.physical) {
      if ((cfg.sizes || []).indexOf(v.shirtSize) === -1) errors.shirtSize = "shirtSize";
      if (squash(v.recipient).length < 2) errors.recipient = "recipient";
      if (squash(v.address).length < 5) errors.address = "address";
      if ((cfg.provinces || []).indexOf(v.province) === -1) errors.province = "province";
      else if (Array.isArray(cfg.deliveryProvinces) && cfg.deliveryProvinces.indexOf(v.province) === -1) errors.province = "delivery";
      if (squash(v.city).length < 2) errors.city = "city";
      if (squash(v.barangay).length < 2) errors.barangay = "barangay";
      if (!/^\d{4}$/.test(squash(v.postal))) errors.postal = "postal";
    }

    if (v.agreeRules !== true) errors.rules = "rules";
    if (v.agreePrivacy !== true) errors.privacy = "privacy";
    return errors;
  }

  /** Keeps only the errors that belong to one step of the form. */
  function errorsForStep(errors, step) {
    var out = {};
    (STEP_FIELDS[step] || []).forEach(function (field) { if (errors[field]) out[field] = errors[field]; });
    return out;
  }

  function stepOfField(field) {
    for (var step = 1; step <= TOTAL_STEPS; step += 1) if (STEP_FIELDS[step].indexOf(field) !== -1) return step;
    return 0;
  }

  /** The priority list's quick checks, { field: code } for each that is not acceptable. The server checks again. */
  function validateWaitlist(values) {
    var v = values || {};
    var errors = {};
    if (squash(v.fullName).length < 2) errors.fullName = "fullName";
    var email = squash(v.email);
    if (!(email.length <= 254 && EMAIL_PATTERN.test(email))) errors.email = "email";
    // Consent is the box being ticked, nothing else.
    if (v.consent !== true) errors.consent = "consent";
    return errors;
  }

  /**
   * The short label of the campaign link a visitor came from (?src=meta-launch), kept with their sign-up so the
   * owner can see which marketing works. Not personal data. "" when the address has none worth keeping.
   */
  function sourceFrom(search) {
    var names = ["src", "utm_campaign", "utm_source"];
    for (var i = 0; i < names.length; i += 1) {
      var match = new RegExp("[?&]" + names[i] + "=([^&#]*)").exec(String(search || ""));
      if (!match) continue;
      var value = "";
      try { value = squash(decodeURIComponent(match[1].replace(/\+/g, " "))).toLowerCase(); } catch (error) { continue; }
      if (SOURCE_PATTERN.test(value)) return value;
    }
    return "";
  }

  global.AthlevoVirtualRun = {
    parseRaceTime: parseRaceTime, ageOn: ageOn, validate: validate, errorsForStep: errorsForStep,
    stepOfField: stepOfField, fill: fill, STEP_FIELDS: STEP_FIELDS, validateWaitlist: validateWaitlist, sourceFrom: sourceFrom
  };

  /* ------------------------------------------------------------------ the page */

  var doc = global.document;
  if (!doc || !doc.getElementById) return;
  var form = doc.getElementById("vr-form");
  var configNode = doc.getElementById("vr-config");
  if (!form || !configNode) return;

  var config;
  try { config = JSON.parse(configNode.textContent); } catch (error) { return; }

  var E = config.form.errors;
  var R = config.form.review;
  var K = config.confirmation;
  var support = config.support;

  var card = doc.getElementById("vr-card");
  var registerSection = doc.getElementById("register");
  var notice = doc.getElementById("vr-notice");
  var registerState = doc.getElementById("vr-register-state");
  var heroState = doc.getElementById("vr-hero-state");
  var heroCta = doc.getElementById("vr-hero-register");
  var navCta = doc.getElementById("vr-nav-cta");
  var formError = doc.getElementById("vr-form-error");
  var stepCount = doc.getElementById("vr-stepcount");
  var progressItems = [].slice.call(doc.querySelectorAll("#vr-progress li"));
  var panels = [].slice.call(form.querySelectorAll(".vr-step"));
  var backButton = doc.getElementById("vr-back");
  var nextButton = doc.getElementById("vr-next");
  var payButton = doc.getElementById("vr-pay");
  var delivery = doc.getElementById("vr-delivery");
  var summary = doc.getElementById("vr-summary");
  var totalNode = doc.getElementById("vr-total");
  var honeypot = doc.getElementById("vr-website");
  var radios = [].slice.call(form.querySelectorAll('input[name="packageId"]'));

  var confirmNode = doc.getElementById("vr-confirm");
  var current = 1;
  var busy = false;
  var confirmMode = false;
  var cancelledText = "";
  var availability = { state: "checking", packages: {}, waitlist: true };
  var mode = "soon";
  var returning = false;
  var pollTimer = null;
  var preselect = "";

  function reducedMotion() {
    return Boolean(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function setText(node, text) { if (node) node.textContent = text; }

  /** Puts text in a node, turning *a word* into <em>a word</em>. textContent only, so nothing from outside becomes markup. */
  function setRich(node, text) {
    node.textContent = "";
    String(text).split("*").forEach(function (part, index) {
      if (index % 2) {
        var em = doc.createElement("em");
        em.textContent = part;
        node.appendChild(em);
      } else if (part) node.appendChild(doc.createTextNode(part));
    });
  }

  function byId(id) { return doc.getElementById(id); }

  function control(field) {
    if (field === "package") return form.querySelector('fieldset[data-field="package"]');
    if (field === "rules" || field === "privacy") return byId("vr-" + field);
    return byId("vr-" + field);
  }

  function focusControl(field) {
    var node = field === "package" ? (radios.filter(function (r) { return !r.disabled; })[0] || radios[0]) : control(field);
    if (node && node.focus) node.focus();
  }

  function errorNode(field) { return byId("vr-" + field + "-error"); }

  function setFieldError(field, code, message) {
    var node = errorNode(field);
    var target = control(field);
    if (node) {
      if (node.getAttribute("data-default") === null) node.setAttribute("data-default", node.textContent);
      var text = message;
      if (!text) text = code === "dobAge" ? fill(E.dobAge, { age: config.minAge }) : code === "delivery" ? E.delivery : node.getAttribute("data-default");
      node.textContent = text;
      node.hidden = false;
    }
    if (target) {
      target.setAttribute("aria-invalid", "true");
      if (node) target.setAttribute("aria-describedby", node.id);
    }
  }

  function clearFieldError(field) {
    var node = errorNode(field);
    var target = control(field);
    if (node) node.hidden = true;
    if (target) {
      target.removeAttribute("aria-invalid");
      target.removeAttribute("aria-describedby");
    }
  }

  function clearStepErrors(step) {
    STEP_FIELDS[step].forEach(clearFieldError);
  }

  function setFormError(message) { setText(formError, message || ""); }

  /* ----- reading the form ----- */

  function fieldValue(id) {
    var node = byId("vr-" + id);
    return node ? node.value : "";
  }

  function selectedPackage() {
    for (var i = 0; i < radios.length; i += 1) if (radios[i].checked) return packageIn(config, radios[i].value);
    return null;
  }

  function readValues() {
    var pkg = selectedPackage();
    return {
      fullName: fieldValue("fullName"), email: fieldValue("email"), mobile: fieldValue("mobile"), dob: fieldValue("dob"),
      gender: fieldValue("gender"), pb5k: fieldValue("pb5k"), pb10k: fieldValue("pb10k"),
      frequency: fieldValue("frequency"), goal: fieldValue("goal"),
      packageId: pkg ? pkg.id : "",
      shirtSize: fieldValue("shirtSize"), recipient: fieldValue("recipient"), address: fieldValue("address"),
      province: fieldValue("province"), city: fieldValue("city"), barangay: fieldValue("barangay"), postal: fieldValue("postal"),
      agreeRules: byId("vr-rules").checked === true, agreePrivacy: byId("vr-privacy").checked === true
    };
  }

  /** What is sent. Never a price: the server works the amount out from the package. */
  function payload(values) {
    var pkg = packageIn(config, values.packageId);
    var body = {
      fullName: squash(values.fullName), email: squash(values.email), mobile: squash(values.mobile), dob: squash(values.dob),
      gender: values.gender, pb5k: squash(values.pb5k), pb10k: squash(values.pb10k),
      frequency: values.frequency, goal: values.goal, packageId: values.packageId,
      agreeRules: values.agreeRules, agreePrivacy: values.agreePrivacy,
      contact_website: honeypot ? honeypot.value : ""
    };
    if (pkg && pkg.physical) {
      body.shirtSize = values.shirtSize;
      body.recipient = squash(values.recipient);
      body.address = squash(values.address);
      body.province = values.province;
      body.city = squash(values.city);
      body.barangay = squash(values.barangay);
      body.postal = squash(values.postal);
    }
    return body;
  }

  /* ----- steps ----- */

  function selectText(id) {
    var node = byId("vr-" + id);
    if (!node || !node.options || node.selectedIndex < 0) return "";
    return node.value ? node.options[node.selectedIndex].text : "";
  }

  function addGroup(title, step, rows) {
    var group = doc.createElement("div");
    group.className = "vr-summary-group";
    var head = doc.createElement("div");
    head.className = "vr-summary-head";
    var h = doc.createElement("h4");
    h.textContent = title;
    var edit = doc.createElement("button");
    edit.type = "button";
    edit.className = "vr-edit";
    edit.setAttribute("data-edit-step", String(step));
    edit.setAttribute("aria-label", R.edit + " " + title);
    edit.textContent = R.edit;
    head.appendChild(h);
    head.appendChild(edit);
    var list = doc.createElement("dl");
    rows.forEach(function (row) {
      if (!row[1]) return;
      var dt = doc.createElement("dt");
      dt.textContent = row[0];
      var dd = doc.createElement("dd");
      dd.textContent = row[1];
      list.appendChild(dt);
      list.appendChild(dd);
    });
    group.appendChild(head);
    group.appendChild(list);
    summary.appendChild(group);
  }

  function renderSummary() {
    var v = readValues();
    var pkg = selectedPackage();
    var L = R.labels;
    var F = config.form.labels;
    summary.textContent = "";
    addGroup(config.form.stepTitles[0], 1, [
      [L.name, squash(v.fullName)], [L.email, squash(v.email)], [L.mobile, squash(v.mobile)]
    ]);
    addGroup(config.form.stepTitles[1], 2, [
      [F.pb5k, squash(v.pb5k)], [F.pb10k, squash(v.pb10k)],
      [F.frequency, selectText("frequency")], [F.goal, selectText("goal")]
    ]);
    var rows = [[L.package, pkg ? pkg.name + " (" + pkg.price + ")" : ""]];
    if (pkg && pkg.physical) {
      rows.push([L.size, v.shirtSize]);
      rows.push([L.ship, [squash(v.recipient), squash(v.address), squash(v.barangay), squash(v.city), squash(v.province) + " " + squash(v.postal)].join(", ")]);
    }
    addGroup(config.form.stepTitles[2], 3, rows);
  }

  function payLabel() {
    var pkg = selectedPackage();
    return pkg ? fill(R.payWith, { total: pkg.price }) : R.pay;
  }

  function updatePackage() {
    var pkg = selectedPackage();
    var physical = Boolean(pkg && pkg.physical);
    delivery.hidden = !physical;
    ["shirtSize", "recipient", "address", "province", "city", "barangay", "postal"].forEach(function (field) {
      var node = byId("vr-" + field);
      if (!node) return;
      if (physical) node.setAttribute("aria-required", "true"); else node.removeAttribute("aria-required");
      if (!physical) clearFieldError(field);
    });
    if (totalNode) totalNode.textContent = pkg ? pkg.price : "";
    if (!busy) setText(payButton, payLabel());
  }

  function prefillRecipient() {
    var recipient = byId("vr-recipient");
    if (recipient && !recipient.value && !recipient.getAttribute("data-touched")) recipient.value = squash(fieldValue("fullName"));
  }

  function revealCard() {
    if (!card || !card.getBoundingClientRect) return;
    var top = card.getBoundingClientRect().top;
    if (top < 0 || top > global.innerHeight * 0.5) {
      card.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  function goTo(step, options) {
    current = step;
    panels.forEach(function (panel) { panel.hidden = Number(panel.getAttribute("data-step")) !== step; });
    progressItems.forEach(function (item, index) {
      var number = index + 1;
      item.classList.toggle("is-done", number < step);
      if (number === step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
    });
    setText(stepCount, config.form.stepLabel + " " + step + " " + config.form.of + " " + TOTAL_STEPS + ": " + config.form.stepTitles[step - 1]);
    backButton.hidden = step === 1;
    nextButton.hidden = step === TOTAL_STEPS;
    payButton.hidden = step !== TOTAL_STEPS;
    if (step === 3) prefillRecipient();
    if (step === TOTAL_STEPS) renderSummary();
    if (!options || options.focus !== false) {
      var panel = byId("vr-step-" + step);
      if (panel) panel.focus({ preventScroll: true });
      revealCard();
    }
  }

  function showErrors(errors, step) {
    clearStepErrors(step);
    var first = "";
    STEP_FIELDS[step].forEach(function (field) {
      if (!errors[field]) return;
      setFieldError(field, errors[field]);
      if (!first) first = field;
    });
    if (first) {
      setFormError(E.summary);
      focusControl(first);
    }
  }

  function goNext() {
    var errors = errorsForStep(validate(readValues(), config, new Date()), current);
    if (Object.keys(errors).length) {
      showErrors(errors, current);
      return;
    }
    clearStepErrors(current);
    setFormError("");
    if (cancelledText) { cancelledText = ""; renderNotice(); }
    goTo(current + 1);
  }

  function setBusy(on) {
    busy = on;
    payButton.disabled = on;
    backButton.disabled = on;
    if (on) payButton.setAttribute("aria-busy", "true"); else payButton.removeAttribute("aria-busy");
    setText(payButton, on ? R.processing : payLabel());
  }

  /* ----- registration ----- */

  function postJson(url, body, timeoutMs) {
    var controller = typeof global.AbortController === "function" ? new global.AbortController() : null;
    var timer = controller ? global.setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    return global.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      global.clearTimeout(timer);
      return response.json().then(function (data) { return { status: response.status, data: data }; },
        function () { return { status: response.status, data: null }; });
    }, function (error) {
      global.clearTimeout(timer);
      throw error;
    });
  }

  function remember(ref) {
    try { global.sessionStorage.setItem("athlevo.vr.ref", ref); } catch (error) { /* private mode: not needed to work */ }
  }

  function applyServerFields(fields) {
    var first = 0;
    Object.keys(fields || {}).forEach(function (field) {
      var step = stepOfField(field);
      if (!step) return;
      if (!first || step < first) first = step;
    });
    if (!first) { setFormError(fill(E.submit, { email: support })); return; }
    STEP_FIELDS[first].forEach(clearFieldError);
    goTo(first, { focus: false });
    var firstField = "";
    Object.keys(fields).forEach(function (field) {
      if (stepOfField(field) !== first) return;
      setFieldError(field, String(fields[field]));
      if (!firstField) firstField = field;
    });
    setFormError(E.summary);
    if (firstField) focusControl(firstField);
    revealCard();
  }

  function handleRegisterResult(result) {
    var data = result.data || {};
    if (result.status === 200 && typeof data.checkout_url === "string" && /^https:\/\//i.test(data.checkout_url)) {
      if (typeof data.ref === "string" && REFERENCE.test(data.ref)) remember(data.ref);
      // Stay in the "opening payment" state while the browser leaves for PayMongo.
      global.location.assign(data.checkout_url);
      return;
    }
    setBusy(false);
    if (result.status === 400 && data.fields) { applyServerFields(data.fields); return; }
    if (result.status === 409 && data.error === "already_registered") {
      goTo(1, { focus: false });
      clearFieldError("email");
      setFieldError("email", "email", fill(E.already, { email: support }));
      setFormError("");
      focusControl("email");
      revealCard();
      return;
    }
    if (result.status === 409) { setFormError(E.full); loadAvailability(0); return; }
    if (result.status === 503 && (data.error === "closed" || data.error === "not_open")) { setFormError(E.closed); loadAvailability(0); return; }
    if (result.status === 429) { setFormError(E.rate); return; }
    setFormError(fill(E.submit, { email: support }));
  }

  function pay() {
    if (busy) return;
    var values = readValues();
    var errors = validate(values, config, new Date());
    for (var step = 1; step <= TOTAL_STEPS; step += 1) {
      var stepErrors = errorsForStep(errors, step);
      if (Object.keys(stepErrors).length) {
        if (step !== current) goTo(step, { focus: false });
        showErrors(stepErrors, step);
        revealCard();
        return;
      }
    }
    clearStepErrors(TOTAL_STEPS);
    setFormError("");
    setBusy(true);
    postJson(config.api.register, payload(values), 25000).then(handleRegisterResult, function () {
      setBusy(false);
      setFormError(fill(E.submit, { email: support }));
    });
  }

  /* ----- availability ----- */

  function packageDisplay(id) {
    var state = availability.state;
    if (state === "open") return availability.packages[id] || "closed";
    if (state === "not_open") return "soon";
    if (state === "closed") return "closed";
    if (state === "sold_out") return "sold_out";
    return "";
  }

  function renderNotice() {
    var message = cancelledText || (availability.state === "open" ? "" : (config.states[availability.state] || ""));
    if (confirmMode) message = "";
    notice.hidden = !message;
    notice.textContent = message;
  }

  /**
   * The page has two states. "soon" (how it is built, and what anyone without JavaScript sees) shows the priority
   * list and keeps the registration form out of sight. "register" shows the form, and is only ever chosen when the
   * server says registration is open (or closed or full, so the status line can say so) or a runner is coming back
   * from payment. The server decides; nothing here opens registration.
   */
  function setMode(next) {
    mode = next;
    doc.body.setAttribute("data-mode", next);
    var copy = config.modes[next];
    [[heroCta, copy.cta], [navCta, copy.nav]].forEach(function (pair) {
      if (!pair[0]) return;
      pair[0].textContent = pair[1];
      pair[0].setAttribute("href", copy.href);
      pair[0].hidden = next === "soon" && !config.waitlist;
    });
  }

  function renderAvailability() {
    var state = availability.state;
    var message = config.states[state] || "";
    var ended = state === "closed" || state === "sold_out";
    setMode(returning || confirmMode || state === "open" || ended ? "register" : "soon");
    // A closed or full challenge has nothing to register for, so the buttons go and the status line says why.
    if (ended) [heroCta, navCta].forEach(function (node) { if (node) node.hidden = true; });
    setText(registerState, message);
    setText(heroState, mode === "register" ? message : "");
    renderWaitlist();
    if (!confirmMode) form.hidden = state !== "open";

    [].slice.call(doc.querySelectorAll("[data-choose]")).forEach(function (button) {
      var id = button.getAttribute("data-choose");
      var display = packageDisplay(id);
      var available = state === "open" && display === "available";
      button.disabled = !available;
      var label = doc.querySelector('[data-state-for="' + id + '"]');
      if (label) label.textContent = state === "checking" || state === "unavailable" ? "" : (config.packageStates[display] || "");
    });

    radios.forEach(function (radio) {
      var display = packageDisplay(radio.value);
      var open = state === "open" && display === "available";
      var option = doc.querySelector('[data-option="' + radio.value + '"]');
      var note = doc.querySelector('[data-option-note="' + radio.value + '"]');
      radio.disabled = !open;
      if (option) option.classList.toggle("is-disabled", !open);
      if (note) {
        if (note.getAttribute("data-default") === null) note.setAttribute("data-default", note.textContent);
        note.textContent = open ? note.getAttribute("data-default") : (config.packageStates[display] || note.getAttribute("data-default"));
      }
      if (!open && radio.checked) { radio.checked = false; updatePackage(); }
    });

    if (state === "open" && preselect) {
      var wanted = byId("vr-package-" + preselect);
      if (wanted && !wanted.disabled && !selectedPackage()) { wanted.checked = true; updatePackage(); }
      preselect = "";
    }
    renderNotice();
  }

  function applyAvailability(data) {
    var packages = {};
    ((data && data.packages) || []).forEach(function (item) { if (item && item.id) packages[item.id] = item.status; });
    availability = {
      state: data && typeof data.state === "string" ? data.state : "unavailable", packages: packages,
      // The priority list can be switched off on the server. Anything but an explicit false means it is on.
      waitlist: !(data && data.waitlist === false)
    };
    renderAvailability();
    // An old link to #register lands on the priority list while registration is not open.
    if (mode === "soon" && global.location.hash === "#register" && wl.section && wl.section.scrollIntoView) {
      wl.section.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  function loadAvailability(attempt) {
    global.fetch(config.api.availability, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("availability " + response.status);
        return response.json();
      })
      .then(applyAvailability)
      .catch(function () {
        availability = { state: "unavailable", packages: {}, waitlist: availability.waitlist };
        renderAvailability();
        if (attempt < 3) global.setTimeout(function () { loadAvailability(attempt + 1); }, 8000 * (attempt + 1));
      });
  }

  /* ----- the priority list ----- */

  var W = config.waitlist;
  var wl = {
    section: byId("waitlist"), intro: byId("vr-wl-intro"), form: byId("vr-wl-form"), off: byId("vr-wl-off"),
    done: byId("vr-wl-done"), leave: byId("vr-wl-leave"), name: byId("vr-wl-fullName"), email: byId("vr-wl-email"),
    consent: byId("vr-wl-consent"), trap: byId("vr-wl-website"), error: byId("vr-wl-form-error"), submit: byId("vr-wl-submit"),
    leaveTitle: byId("vr-wl-leave-title"), leaveText: byId("vr-wl-leave-text"), leaveError: byId("vr-wl-leave-error"),
    leaveActions: byId("vr-wl-leave-actions"), leaveConfirm: byId("vr-wl-leave-confirm"), leaveCancel: byId("vr-wl-leave-cancel")
  };
  var WL_FIELDS = ["fullName", "email", "consent"];
  var wlView = "form";
  var wlBusy = false;
  var leaveToken = "";
  var source = sourceFrom(global.location.search);

  function renderWaitlist() {
    if (!W || !wl.form) return;
    var off = wlView === "form" && !availability.waitlist;
    wl.form.hidden = wlView !== "form" || off;
    wl.off.hidden = !off;
    wl.done.hidden = wlView !== "done";
    wl.leave.hidden = wlView !== "leave";
    wl.intro.hidden = wlView === "leave";
    wl.section.classList.toggle("is-leaving", wlView === "leave");
  }

  function showWaitlistView(view) {
    wlView = view;
    renderWaitlist();
  }

  function wlControl(field) { return byId("vr-wl-" + field); }

  function wlClearError(field) {
    var node = byId("vr-wl-" + field + "-error");
    var target = wlControl(field);
    if (node) node.hidden = true;
    if (target) { target.removeAttribute("aria-invalid"); target.removeAttribute("aria-describedby"); }
  }

  function wlShowError(field) {
    var node = byId("vr-wl-" + field + "-error");
    var target = wlControl(field);
    if (node) node.hidden = false;
    if (target) {
      target.setAttribute("aria-invalid", "true");
      if (node) target.setAttribute("aria-describedby", node.id);
    }
  }

  function setWaitlistBusy(on) {
    wlBusy = on;
    wl.submit.disabled = on;
    if (on) wl.submit.setAttribute("aria-busy", "true"); else wl.submit.removeAttribute("aria-busy");
    setText(wl.submit, on ? W.sending : W.submit);
  }

  /** Tells the ad pixel someone joined. No name, no email, once per tab. Only after the server has said it saved. */
  function trackLead() {
    if (typeof global.fbq !== "function") return;
    try { if (global.sessionStorage.getItem("athlevo.vr.lead")) return; } catch (error) { /* storage blocked: send once */ }
    try { global.fbq("track", "Lead", { content_name: config.event + " priority list" }); } catch (error) { return; }
    try { global.sessionStorage.setItem("athlevo.vr.lead", "1"); } catch (error) { /* ignore */ }
  }

  function waitlistFailed(message) {
    setText(wl.error, message);
  }

  function handleWaitlistResult(result) {
    var data = result.data || {};
    setWaitlistBusy(false);
    if (result.status === 200 && data.ok) {
      wl.name.value = "";
      wl.email.value = "";
      wl.consent.checked = false;
      showWaitlistView("done");
      wl.done.focus({ preventScroll: true });
      trackLead();
      return;
    }
    if (result.status === 400 && data.fields) {
      var first = "";
      WL_FIELDS.forEach(function (field) {
        if (!data.fields[field]) return;
        wlShowError(field);
        if (!first) first = field;
      });
      if (first) { wlControl(first).focus(); return; }
    }
    if (result.status === 429) { waitlistFailed(W.errors.rate); return; }
    waitlistFailed(fill(W.errors.failed, { email: support }));
  }

  function submitWaitlist(event) {
    event.preventDefault();
    if (wlBusy) return;
    var values = { fullName: wl.name.value, email: wl.email.value, consent: wl.consent.checked };
    var errors = validateWaitlist(values);
    WL_FIELDS.forEach(wlClearError);
    waitlistFailed("");
    var bad = WL_FIELDS.filter(function (field) { return errors[field]; });
    if (bad.length) {
      bad.forEach(wlShowError);
      wlControl(bad[0]).focus();
      return;
    }
    setWaitlistBusy(true);
    var body = { fullName: squash(values.fullName), email: squash(values.email), consent: true, contact_website: wl.trap ? wl.trap.value : "" };
    if (source) body.source = source;
    postJson(W.api, body, 20000).then(handleWaitlistResult, function () {
      setWaitlistBusy(false);
      waitlistFailed(fill(W.errors.failed, { email: support }));
    });
  }

  /** The leave link in a priority list e-mail. It only asks: nothing is removed until the person presses the button. */
  function readLeave() {
    if (!/[?&]leave=1(&|#|$)/.test(String(global.location.search || ""))) return null;
    var token = "";
    try { token = String(global.sessionStorage.getItem("athlevo.vr.leave") || "").toUpperCase(); } catch (error) { token = ""; }
    return { token: LEAVE_TOKEN.test(token) ? token : "" };
  }

  function endLeave() {
    leaveToken = "";
    try { global.sessionStorage.removeItem("athlevo.vr.leave"); } catch (error) { /* ignore */ }
    try {
      var rest = String(global.location.search || "").replace(/([?&])leave=1&?/, "$1").replace(/[?&]$/, "");
      global.history.replaceState(null, "", global.location.pathname + rest + global.location.hash);
    } catch (error) { /* ignore */ }
    doc.body.removeAttribute("data-leave");
  }

  function startLeave(token) {
    leaveToken = token;
    var L = W.leave;
    doc.body.setAttribute("data-leave", "");
    setText(wl.leaveTitle, L.heading);
    if (!token) {
      setText(wl.leaveText, fill(L.invalid, { email: support }));
      wl.leaveActions.hidden = true;
    } else {
      setText(wl.leaveText, L.text);
      wl.leaveActions.hidden = false;
    }
    showWaitlistView("leave");
    if (wl.section.scrollIntoView) wl.section.scrollIntoView({ block: "start" });
    wl.leave.focus({ preventScroll: true });
  }

  function confirmLeave() {
    if (wlBusy || !leaveToken) return;
    var L = W.leave;
    wlBusy = true;
    wl.leaveConfirm.disabled = true;
    wl.leaveConfirm.setAttribute("aria-busy", "true");
    setText(wl.leaveError, "");
    setText(wl.leaveConfirm, L.working);
    function reset() {
      wlBusy = false;
      wl.leaveConfirm.disabled = false;
      wl.leaveConfirm.removeAttribute("aria-busy");
      setText(wl.leaveConfirm, L.confirm);
    }
    postJson(W.api, { leave: leaveToken }, 20000).then(function (result) {
      if (result.status === 200 && result.data && result.data.ok) {
        reset();
        endLeave();
        setText(wl.leaveTitle, L.doneHeading);
        setText(wl.leaveText, L.doneText);
        wl.leaveActions.hidden = true;
        wl.leave.focus({ preventScroll: true });
        return;
      }
      reset();
      setText(wl.leaveError, fill(L.failed, { email: support }));
    }, function () {
      reset();
      setText(wl.leaveError, fill(L.failed, { email: support }));
    });
  }

  if (W && wl.form) {
    wl.form.addEventListener("submit", submitWaitlist);
    wl.form.addEventListener("input", function (event) {
      var wrap = event.target && event.target.closest ? event.target.closest("[data-field]") : null;
      if (wrap) wlClearError(wrap.getAttribute("data-field"));
      if (wl.error && wl.error.textContent) waitlistFailed("");
    });
    wl.leaveConfirm.addEventListener("click", confirmLeave);
    wl.leaveCancel.addEventListener("click", function () {
      if (wlBusy) return;
      endLeave();
      showWaitlistView("form");
    });
  }

  /* ----- coming back from PayMongo ----- */

  function safeLink(url) {
    return typeof url === "string" && (/^https:\/\//i.test(url) || /^\/(?!\/)/.test(url)) ? url : "";
  }

  function packageById(id) { return packageIn(config, id); }

  function trackPurchase(data, ref) {
    if (typeof global.fbq !== "function") return;
    var pkg = packageById(data.package && data.package.id);
    if (!pkg) return;
    // The secret reference never goes to an analytics service. The short public registration ID identifies the
    // purchase for de-duplication.
    var purchaseId = typeof data.registration_id === "string" ? data.registration_id : "";
    if (!purchaseId) return;
    var key = "athlevo.vr.pixel." + purchaseId;
    try { if (global.localStorage.getItem(key)) return; } catch (error) { /* storage blocked: send, the event id de-duplicates */ }
    try {
      global.fbq("track", "Purchase",
        { value: pkg.priceCents / 100, currency: "PHP", content_name: pkg.name, content_ids: [pkg.id], content_type: "product" },
        { eventID: purchaseId });
    } catch (error) { return; }
    try { global.localStorage.setItem(key, "1"); } catch (error) { /* ignore */ }
  }

  var confirmParts = {
    eyebrow: byId("vr-confirm-eyebrow"), title: byId("vr-confirm-title"), text: byId("vr-confirm-text"),
    facts: byId("vr-confirm-facts"), email: byId("vr-confirm-email"), stepsBox: byId("vr-confirm-steps"),
    steps: byId("vr-next-steps"), links: byId("vr-confirm-links"), retry: byId("vr-confirm-retry")
  };

  function showConfirmPanel() {
    confirmMode = true;
    form.hidden = true;
    confirmNode.hidden = false;
    renderNotice();
  }

  function resetConfirmParts() {
    confirmParts.facts.hidden = true;
    confirmParts.facts.textContent = "";
    confirmParts.email.hidden = true;
    confirmParts.stepsBox.hidden = true;
    confirmParts.steps.textContent = "";
    confirmParts.links.textContent = "";
    confirmParts.retry.hidden = true;
  }

  function showMessage(kind) {
    var copy = K[kind];
    resetConfirmParts();
    setText(confirmParts.eyebrow, K.paid.eyebrow);
    confirmParts.eyebrow.hidden = kind === "pending" || kind === "failed" || kind === "checking";
    setText(confirmParts.title, copy.heading);
    setText(confirmParts.text, fill(copy.text, { email: support }));
    confirmParts.retry.hidden = kind === "checking";
    if (kind !== "checking") confirmNode.focus({ preventScroll: true });
  }

  function addFact(label, value, className) {
    var wrap = doc.createElement("div");
    var dt = doc.createElement("dt");
    dt.textContent = label;
    var dd = doc.createElement("dd");
    dd.textContent = value;
    if (className) dd.className = className;
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    confirmParts.facts.appendChild(wrap);
  }

  function showPaid(data, ref) {
    resetConfirmParts();
    var P = K.paid;
    confirmParts.eyebrow.hidden = false;
    setText(confirmParts.eyebrow, P.eyebrow);
    setRich(confirmParts.title, P.heading);
    setText(confirmParts.text, P.line);
    addFact(P.labels.name, String(data.name || ""));
    addFact(P.labels.id, String(data.registration_id || ""), "vr-id");
    addFact(P.labels.package, String((data.package && data.package.name) || ""));
    confirmParts.facts.hidden = false;
    if (data.email_sent) {
      setText(confirmParts.email, P.emailSent);
      confirmParts.email.hidden = false;
    }
    var steps = P.steps.slice();
    var personalized = (config.personalizedPackages || []).indexOf(data.package && data.package.id) !== -1;
    if (personalized && P.performanceStep) steps.splice(2, 0, P.performanceStep);
    steps.forEach(function (step) {
      var item = doc.createElement("li");
      item.textContent = step;
      confirmParts.steps.appendChild(item);
    });
    confirmParts.stepsBox.hidden = false;
    [[safeLink(data.assessment_url), P.assessmentLink], [safeLink(data.training_url), P.trainingLink]].forEach(function (pair) {
      if (!pair[0]) return;
      var link = doc.createElement("a");
      link.href = pair[0];
      link.textContent = pair[1];
      if (/^https:/i.test(pair[0])) { link.target = "_blank"; link.rel = "noopener"; }
      confirmParts.links.appendChild(link);
    });
    confirmNode.focus({ preventScroll: true });
    // The reference stays in this tab's storage: the address no longer carries it, so a refresh needs it to
    // show this confirmation again. It is replaced the next time this tab registers.
    trackPurchase(data, ref);
  }

  function poll(ref, tries, failures) {
    function next(failed) {
      var failedSoFar = failures + (failed ? 1 : 0);
      if (tries + 1 >= POLL_MAX) { showMessage(failedSoFar >= POLL_MAX ? "failed" : "pending"); return; }
      pollTimer = global.setTimeout(function () { poll(ref, tries + 1, failedSoFar); }, POLL_MS);
    }
    postJson(config.api.status, { ref: ref }, 10000).then(function (result) {
      var data = result.data || {};
      if (result.status === 200 && data.status === "paid") { showPaid(data, ref); return; }
      if (result.status === 200 && data.status === "refunded") { showMessage("failed"); return; }
      if (result.status === 429) { showMessage("pending"); return; }
      next(result.status !== 200);
    }, function () { next(true); });
  }

  function startConfirmation(ref) {
    global.clearTimeout(pollTimer);
    showConfirmPanel();
    showMessage("checking");
    confirmParts.eyebrow.hidden = true;
    poll(ref, 0, 0);
  }

  function readReturn() {
    var search = String(global.location.search || "");
    function param(name) {
      var match = new RegExp("[?&]" + name + "=([^&#]*)").exec(search);
      if (!match) return "";
      try { return decodeURIComponent(match[1].replace(/\+/g, " ")); } catch (error) { return ""; }
    }
    var payment = param("payment");
    var ref = param("ref").toUpperCase();
    // The page's first script moves the reference out of the address (so nothing that reads the address can see
    // it) and into this tab's session storage. An address that still carries it is read as before.
    if (payment === "success" && !REFERENCE.test(ref)) {
      try { ref = String(global.sessionStorage.getItem("athlevo.vr.ref") || "").toUpperCase(); } catch (error) { ref = ""; }
    }
    preselect = param("package");
    if (payment === "success" && REFERENCE.test(ref)) return { kind: "success", ref: ref };
    if (payment === "cancelled") return { kind: "cancelled" };
    return { kind: "" };
  }

  /* ------------------------------------------------------------------ wiring */

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (current < TOTAL_STEPS) goNext(); else pay();
  });
  nextButton.addEventListener("click", goNext);
  backButton.addEventListener("click", function () {
    if (busy) return;
    setFormError("");
    goTo(Math.max(1, current - 1));
  });

  function onFieldEdit(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var wrap = target.closest("[data-field]");
    if (wrap) clearFieldError(wrap.getAttribute("data-field"));
    if (formError.textContent === E.summary) setFormError("");
    if (target.id === "vr-recipient") target.setAttribute("data-touched", "1");
    if (target.name === "packageId") updatePackage();
    if (target.id === "vr-postal") target.value = target.value.replace(/\D/g, "").slice(0, 4);
  }
  form.addEventListener("input", onFieldEdit);
  form.addEventListener("change", onFieldEdit);

  summary.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-edit-step]") : null;
    if (!button || busy) return;
    goTo(Number(button.getAttribute("data-edit-step")));
  });

  [].slice.call(doc.querySelectorAll("[data-choose]")).forEach(function (button) {
    button.addEventListener("click", function () {
      var radio = byId("vr-package-" + button.getAttribute("data-choose"));
      if (!radio || radio.disabled) return;
      radio.checked = true;
      clearFieldError("package");
      updatePackage();
      if (registerSection && registerSection.scrollIntoView) registerSection.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
      var panel = byId("vr-step-" + current);
      if (panel && !form.hidden) panel.focus({ preventScroll: true });
    });
  });

  confirmParts.retry.addEventListener("click", function () {
    var ref = readReturn().ref;
    if (ref) startConfirmation(ref);
  });

  // Coming back to the page with the back button while "opening payment" was showing.
  global.addEventListener("pageshow", function (event) { if (event.persisted && busy) setBusy(false); });

  var returned = readReturn();
  returning = returned.kind !== "";
  var leaving = W && wl.form ? readLeave() : null;
  if (Array.isArray(config.deliveryProvinces)) {
    [].slice.call(byId("vr-province").options).forEach(function (option) {
      if (option.value && config.deliveryProvinces.indexOf(option.value) === -1) option.disabled = true;
    });
  }

  goTo(1, { focus: false });
  updatePackage();
  renderAvailability(); // "checking": packages stay disabled until the server has said registration is open

  if (returned.kind === "cancelled") {
    cancelledText = K.cancelled.heading + " " + K.cancelled.text;
    try { global.history.replaceState(null, "", global.location.pathname + "#register"); } catch (error) { /* ignore */ }
  }
  if (returned.kind === "success") {
    startConfirmation(returned.ref);
    if (registerSection && registerSection.scrollIntoView) registerSection.scrollIntoView({ block: "start" });
  } else {
    renderNotice();
  }
  if (leaving) startLeave(leaving.token);
  loadAvailability(0);
})(typeof window !== "undefined" ? window : globalThis);
