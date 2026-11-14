#!/usr/bin/env node
/**
 * Writes the Sub-1 10k Challenge page from content/virtualRun.mjs.
 *
 * Output (generated, do not edit by hand):
 *   virtual-run.html         /virtual-run         the landing page with the registration form
 *   virtual-run-admin.html   /virtual-run/admin   the staff page (sign-in, filters, CSV export), not indexed
 *
 * All wording, prices, packages and dates live in content/virtualRun.mjs. This file only holds the markup.
 * The look is store.css (the storefront's tokens, buttons, FAQ and footer) plus virtual-run.css.
 * The page works with the checks in js/virtualRun.js; the server (lib/server/virtualRun.js) decides
 * everything that matters (prices, whether registration is open, whether a payment happened).
 *
 *   node scripts/build-virtual-run-page.mjs          write the file
 *   node scripts/build-virtual-run-page.mjs --check  fail if the file is out of date
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as c from "../content/virtualRun.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "virtual-run.html");
const OUT_ADMIN = join(ROOT, "virtual-run-admin.html");

/**
 * "/file?v=abc123": the address changes whenever the file's contents do. The site's service worker keeps
 * styles and scripts and refreshes them in the background, so without this a returning visitor could
 * run last deploy's script against this deploy's markup for one visit.
 */
const versioned = (urlPath) => {
  const file = join(ROOT, urlPath.replace(/^\//, ""));
  if (!existsSync(file)) return urlPath;
  return urlPath + "?v=" + createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 8);
};

const text = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** Escaped text where *a word* becomes <em>a word</em>. */
const rich = (s) => String(s).split("*").map((part, i) => (i % 2 ? "<em>" + text(part) + "</em>" : text(part))).join("");
const fill = (s, values) => String(s).replace(/\{(\w+)\}/g, (m, key) => (key in values ? values[key] : m));

// ---- Meta Pixel spot (same mechanism as the webinar pages: whatever is pasted survives a rebuild) ----

const PIXEL_INSTRUCTIONS =
  "  <!-- ======================= META PIXEL =======================\n" +
  "       Paste your Meta Pixel base code here: the whole <script> block and the <noscript>\n" +
  "       line from Events Manager. Keep the PageView line in. The page itself sends a Purchase\n" +
  "       event, with the package price, once a payment has been CONFIRMED by the server, so\n" +
  "       leave any Purchase or Lead line out of the snippet.\n" +
  "       Whatever sits between this comment and the closing marker below is kept when the\n" +
  "       page is rebuilt.\n" +
  "       ========================================================== -->\n";
const PIXEL_END = "  <!-- /META PIXEL -->";

function pastedPixel(existingHtml) {
  if (!existingHtml) return "";
  const start = existingHtml.indexOf("<!-- ======================= META PIXEL");
  const end = existingHtml.indexOf(PIXEL_END);
  if (start < 0 || end < start) return "";
  const afterComment = existingHtml.indexOf("-->", start);
  return afterComment < 0 || afterComment > end ? "" : existingHtml.slice(afterComment + 3, end).replace(/^\n/, "");
}

// ---- Pieces ----

const price = (pkg) => c.formatPeso(pkg.priceCents);
const physicalNames = c.PACKAGES.filter((p) => p.physical).map((p) => p.name).join(", ");

function legalLink(url, label) {
  if (!url) return text(label);
  const external = /^https?:/i.test(url);
  return '<a href="' + attr(url) + '"' + (external ? ' target="_blank" rel="noopener"' : ' target="_blank"') + ">" + text(label) + "</a>";
}

const HEADER =
  '  <a class="skip" href="#main">Skip to main content</a>\n' +
  '  <header class="site-header">\n' +
  '    <div class="nav vr-nav">\n' +
  '      <a class="wordmark" href="/" aria-label="Athlevo home">Athlevo<i aria-hidden="true">.</i></a>\n' +
  '      <ul class="nav-links vr-nav-links">\n' +
  '        <li><a href="#how-it-works">' + text(c.HOW.eyebrow) + "</a></li>\n" +
  '        <li><a href="#packages">' + text(c.PACKAGES_COPY.eyebrow) + "</a></li>\n" +
  '        <li><a href="#rewards">Rewards</a></li>\n' +
  '        <li><a href="#faq">' + text(c.FAQ.eyebrow) + "</a></li>\n" +
  "      </ul>\n" +
  '      <a class="btn btn-red vr-nav-cta" href="#register">' + text(c.HERO.primary) + "</a>\n" +
  "    </div>\n" +
  "  </header>";

function hero() {
  const f = c.HERO.factLabels;
  return (
    '    <section class="vr-hero" aria-labelledby="vr-hero-title">\n' +
    '      <div class="wrap vr-hero-inner">\n' +
    '        <p class="vr-eyebrow">' + text(c.HERO.eyebrow) + "</p>\n" +
    '        <h1 id="vr-hero-title">' + rich(c.HERO.headline.replace("10k", "*10k*")) + "</h1>\n" +
    '        <p class="vr-hero-sub">' + text(c.HERO.supporting) + "</p>\n" +
    '        <div class="vr-hero-actions">\n' +
    '          <a class="btn btn-red btn-lg" href="#register" id="vr-hero-register">' + text(c.HERO.primary) + "</a>\n" +
    '          <a class="btn btn-lg vr-btn-ghost" href="#how-it-works">' + text(c.HERO.secondary) + "</a>\n" +
    "        </div>\n" +
    '        <p class="vr-hero-state" id="vr-hero-state" role="status" aria-live="polite"></p>\n' +
    '        <dl class="vr-facts">\n' +
    "          <div><dt>" + text(f.dates) + "</dt><dd>" + text(c.eventDatesText()) + "</dd></div>\n" +
    "          <div><dt>" + text(f.deadline) + "</dt><dd>" + text(c.deadlineText()) + "</dd></div>\n" +
    "          <div><dt>" + text(f.format) + "</dt><dd>" + text(c.HERO.format) + "</dd></div>\n" +
    "        </dl>\n" +
    '        <p class="vr-hero-note">' + text(c.HERO.note) + "</p>\n" +
    "      </div>\n" +
    '      <p class="vr-hero-mark" aria-hidden="true">60:00</p>\n' +
    "    </section>"
  );
}

function how() {
  return (
    '    <section class="vr-section" id="how-it-works" aria-labelledby="how-title">\n' +
    '      <div class="wrap">\n' +
    '        <p class="vr-label">' + text(c.HOW.eyebrow) + "</p>\n" +
    '        <h2 class="vr-title" id="how-title">' + rich(c.HOW.heading) + "</h2>\n" +
    '        <ol class="vr-steps">\n' +
    c.HOW.steps.map((step, i) =>
      '          <li><span class="vr-step-num" aria-hidden="true">' + String(i + 1).padStart(2, "0") + "</span><p>" + text(step) + "</p></li>\n").join("") +
    "        </ol>\n" +
    "      </div>\n" +
    "    </section>"
  );
}

function results() {
  const r = c.RESULTS;
  return (
    '    <section class="vr-section vr-section--tint" id="results" aria-labelledby="results-title">\n' +
    '      <div class="wrap">\n' +
    '        <p class="vr-label">' + text(r.eyebrow) + "</p>\n" +
    '        <h2 class="vr-title" id="results-title">' + rich(r.heading) + "</h2>\n" +
    '        <div class="vr-results">\n' +
    r.cards.map((card, i) =>
      '          <article class="vr-result' + (i === 1 ? " vr-result--sub1" : "") + '">\n' +
      '            <p class="vr-result-label">' + text(card.label) + "</p>\n" +
      '            <h3>' + text(card.rule) + "</h3>\n" +
      "            <p>" + text(card.text) + "</p>\n" +
      "          </article>\n").join("") +
    "        </div>\n" +
    '        <p class="vr-honest">' + text(r.line) + "</p>\n" +
    "      </div>\n" +
    "    </section>"
  );
}

function packages() {
  const p = c.PACKAGES_COPY;
  const cards = c.PACKAGES.map((pkg, i) => {
    const dark = i === 1;
    return (
      '          <article class="vr-pkg' + (dark ? " vr-pkg--dark" : "") + '" data-package="' + attr(pkg.id) + '">\n' +
      '            <h3 class="vr-pkg-name">' + text(pkg.name) + "</h3>\n" +
      '            <p class="vr-price"><span class="vr-price-amount">' + text(price(pkg)) + "</span></p>\n" +
      '            <ul class="vr-features">\n' +
      pkg.features.map((feature) => "              <li>" + text(feature) + "</li>\n").join("") +
      "            </ul>\n" +
      '            <div class="vr-pkg-foot">\n' +
      (pkg.physical
        ? '              <p class="vr-pkg-note">' + text(p.coverageLabel) + ": <strong>" + text(c.DELIVERY.coverage) + "</strong>. " + text(c.DELIVERY.timing) + "</p>\n"
        : "") +
      '              <button class="btn btn-red vr-choose" type="button" disabled data-choose="' + attr(pkg.id) + '">' + text(p.choose + " " + pkg.name) + "</button>\n" +
      '              <p class="vr-pkg-state" data-state-for="' + attr(pkg.id) + '" role="status"></p>\n' +
      "            </div>\n" +
      "          </article>\n"
    );
  }).join("");
  return (
    '    <section class="vr-section" id="packages" aria-labelledby="packages-title">\n' +
    '      <div class="wrap">\n' +
    '        <p class="vr-label">' + text(p.eyebrow) + "</p>\n" +
    '        <h2 class="vr-title" id="packages-title">' + rich(p.heading) + "</h2>\n" +
    '        <p class="vr-lede">' + text(p.intro) + "</p>\n" +
    '        <div class="vr-pkgs">\n' + cards + "        </div>\n" +
    "      </div>\n" +
    "    </section>"
  );
}

function visual(kind) {
  const m = c.MERCH[kind];
  const src = c.MERCH_ASSETS[kind];
  if (src) {
    return '<figure class="vr-visual"><img src="' + attr(src) + '" alt="' + attr(m.alt) + '" loading="lazy" decoding="async"></figure>';
  }
  return (
    '<figure class="vr-visual vr-visual--placeholder" role="img" aria-label="' + attr(m.placeholder + ": " + m.eyebrow) + '">' +
    '<span class="vr-visual-kind">' + text(m.eyebrow) + "</span>" +
    '<span class="vr-visual-tag">' + text(m.placeholder) + "</span></figure>"
  );
}

function merch(kind, flip) {
  const m = c.MERCH[kind];
  const labels = c.MERCH.labels;
  const facts = [[labels.included, m.included]];
  if (kind === "shirt") facts.push([labels.sizes, c.SHIRT_SIZES[0] + " to " + c.SHIRT_SIZES[c.SHIRT_SIZES.length - 1]]);
  facts.push([labels.part, m.part]);
  return (
    '        <div class="vr-product' + (flip ? " vr-product--flip" : "") + '" id="' + (kind === "shirt" ? "shirt" : "medal") + '">\n' +
    "          " + visual(kind) + "\n" +
    '          <div class="vr-product-copy">\n' +
    '            <p class="vr-label">' + text(m.eyebrow) + "</p>\n" +
    '            <h3 class="vr-title vr-title--sm">' + rich(m.heading) + "</h3>\n" +
    "            <p>" + text(m.text) + "</p>\n" +
    '            <dl class="vr-product-facts">' +
    facts.map(([k, v]) => "<div><dt>" + text(k) + "</dt><dd>" + text(v) + "</dd></div>").join("") + "</dl>\n" +
    "          </div>\n" +
    "        </div>\n"
  );
}

function rewards() {
  return (
    '    <section class="vr-section vr-section--dark" id="rewards" aria-label="Official finisher shirt and medal">\n' +
    '      <div class="wrap vr-products">\n' +
    merch("shirt", false) + merch("medal", true) +
    "      </div>\n" +
    "    </section>"
  );
}

// ---- The form ----

function field(id, label, control, { hint = "", optional = false } = {}) {
  const error = c.FORM.errors[id] || "";
  return (
    '<div class="field" data-field="' + attr(id) + '">' +
    '<label for="vr-' + id + '">' + text(label) + "</label>" +
    control +
    (hint ? '<p class="field-hint" id="vr-' + id + '-hint">' + text(hint) + "</p>" : "") +
    '<p class="field-error" id="vr-' + id + '-error" hidden>' + text(error) + "</p>" +
    "</div>"
  );
}

const input = (id, type, extra = "") =>
  '<input id="vr-' + id + '" name="' + id + '" type="' + type + '" ' + extra + ">";

function select(id, options, extra = "") {
  return '<select id="vr-' + id + '" name="' + id + '" ' + extra + '><option value="">' + text(c.FORM.choose) + "</option>" +
    options.map((o) => {
      const value = typeof o === "string" ? o : o.value;
      const label = typeof o === "string" ? o : o.label;
      return '<option value="' + attr(value) + '">' + text(label) + "</option>";
    }).join("") + "</select>";
}

function formHtml() {
  const L = c.FORM.labels;
  const E = c.FORM.errors;
  const steps = c.FORM.stepTitles;
  const progress =
    '<ol class="vr-progress" id="vr-progress" aria-label="Registration steps">' +
    steps.map((title, i) =>
      '<li data-step-index="' + (i + 1) + '"' + (i === 0 ? ' aria-current="step"' : "") + '><span class="vr-progress-num">' + (i + 1) + '</span><span class="vr-progress-title">' + text(title) + "</span></li>").join("") +
    "</ol>";

  const step1 =
    '<div class="vr-step" data-step="1" id="vr-step-1" tabindex="-1" aria-labelledby="vr-step-1-title">' +
    '<h3 id="vr-step-1-title" class="vr-step-title">' + text(steps[0]) + "</h3>" +
    field("fullName", L.fullName, input("fullName", "text", 'autocomplete="name" maxlength="120" required')) +
    field("email", L.email, input("email", "email", 'inputmode="email" autocomplete="email" maxlength="254" required')) +
    field("mobile", L.mobile, input("mobile", "tel", 'inputmode="tel" autocomplete="tel" maxlength="30" required')) +
    field("dob", L.dob, input("dob", "date", 'autocomplete="bday" required')) +
    field("gender", L.gender, select("gender", c.GENDERS)) +
    "</div>";

  const step2 =
    '<div class="vr-step" data-step="2" id="vr-step-2" tabindex="-1" aria-labelledby="vr-step-2-title" hidden>' +
    '<h3 id="vr-step-2-title" class="vr-step-title">' + text(steps[1]) + "</h3>" +
    '<p class="vr-hint">' + text(L.pbHint) + "</p>" +
    field("pb5k", L.pb5k, input("pb5k", "text", 'inputmode="text" autocomplete="off" maxlength="9" placeholder="24:30"')) +
    field("pb10k", L.pb10k, input("pb10k", "text", 'inputmode="text" autocomplete="off" maxlength="9" placeholder="52:10"')) +
    field("frequency", L.frequency, select("frequency", c.FREQUENCIES, "required")) +
    field("goal", L.goal, select("goal", c.GOALS, "required")) +
    "</div>";

  const packageCards = c.PACKAGES.map((pkg) =>
    '<label class="vr-option" data-option="' + attr(pkg.id) + '" for="vr-package-' + attr(pkg.id) + '">' +
    '<input type="radio" id="vr-package-' + attr(pkg.id) + '" name="packageId" value="' + attr(pkg.id) + '" data-physical="' + (pkg.physical ? "true" : "false") + '" required>' +
    '<span class="vr-option-body"><span class="vr-option-name">' + text(pkg.name) + "</span>" +
    '<span class="vr-option-price">' + text(price(pkg)) + "</span>" +
    '<span class="vr-option-note" data-option-note="' + attr(pkg.id) + '">' + text(pkg.physical ? "Includes shirt and medal" : "Digital entry") + "</span></span></label>").join("");

  const step3 =
    '<div class="vr-step" data-step="3" id="vr-step-3" tabindex="-1" aria-labelledby="vr-step-3-title" hidden>' +
    '<h3 id="vr-step-3-title" class="vr-step-title">' + text(steps[2]) + "</h3>" +
    '<fieldset class="vr-fieldset" data-field="package"><legend>' + text(L.package) + "</legend>" +
    '<div class="vr-options">' + packageCards + "</div>" +
    '<p class="field-error" id="vr-package-error" hidden>' + text(E.package) + "</p></fieldset>" +
    '<fieldset class="vr-fieldset vr-delivery" id="vr-delivery" hidden><legend>' + text(c.FORM.delivery) + "</legend>" +
    '<p class="vr-hint">' + text(c.FORM.deliveryNote) + " " + text(c.PACKAGES_COPY.coverageLabel) + ": " + text(c.DELIVERY.coverage) + ".</p>" +
    field("shirtSize", L.shirtSize, select("shirtSize", c.SHIRT_SIZES)) +
    field("recipient", L.recipient, input("recipient", "text", 'autocomplete="shipping name" maxlength="120"')) +
    field("address", L.address, input("address", "text", 'autocomplete="shipping address-line1" maxlength="200"')) +
    field("province", L.province, select("province", c.PROVINCES, 'autocomplete="shipping address-level1"')) +
    field("city", L.city, input("city", "text", 'autocomplete="shipping address-level2" maxlength="100"')) +
    field("barangay", L.barangay, input("barangay", "text", 'autocomplete="shipping address-level3" maxlength="100"')) +
    field("postal", L.postal, input("postal", "text", 'inputmode="numeric" autocomplete="shipping postal-code" maxlength="4" pattern="[0-9]{4}"')) +
    "</fieldset></div>";

  const R = c.FORM.review;
  const rulesLabel = fill(R.rules, {
    rules: legalLink(c.LEGAL.rulesUrl, R.rulesLink), waiver: legalLink(c.LEGAL.waiverUrl, R.waiverLink)
  });
  const privacyLabel = fill(R.privacy, { privacy: legalLink(c.LEGAL.privacyUrl, R.privacyLink) });
  const step4 =
    '<div class="vr-step" data-step="4" id="vr-step-4" tabindex="-1" aria-labelledby="vr-step-4-title" hidden>' +
    '<h3 id="vr-step-4-title" class="vr-step-title">' + text(R.heading) + "</h3>" +
    '<div class="vr-summary" id="vr-summary" aria-live="polite"></div>' +
    '<div class="vr-total"><span>' + text(R.labels.total) + '</span><strong id="vr-total">' + text(price(c.PACKAGES[0])) + "</strong></div>" +
    '<div class="vr-consent field" data-field="rules"><label class="vr-check"><input type="checkbox" id="vr-rules" name="agreeRules"><span>' + rulesLabel + "</span></label>" +
    '<p class="field-error" id="vr-rules-error" hidden>' + text(E.rules) + "</p></div>" +
    '<div class="vr-consent field" data-field="privacy"><label class="vr-check"><input type="checkbox" id="vr-privacy" name="agreePrivacy"><span>' + privacyLabel + "</span></label>" +
    '<p class="field-error" id="vr-privacy-error" hidden>' + text(E.privacy) + "</p></div>" +
    '<p class="vr-hint">' + text(R.paymentNote) + "</p>" +
    "</div>";

  return (
    '<form class="vr-form" id="vr-form" method="post" action="' + attr(c.SITE.registerApi) + '" novalidate hidden aria-labelledby="register-title">' +
    '<p class="vr-stepcount" id="vr-stepcount" aria-live="polite"></p>' + progress +
    step1 + step2 + step3 + step4 +
    '<div class="hp" aria-hidden="true"><label for="vr-website">Leave this field empty</label><input id="vr-website" name="contact_website" type="text" tabindex="-1" autocomplete="off"></div>' +
    '<p class="form-error" id="vr-form-error" role="alert"></p>' +
    '<div class="vr-actions"><button class="btn vr-btn-back" type="button" id="vr-back" hidden>' + text(c.FORM.back) + "</button>" +
    '<button class="btn btn-red btn-lg" type="button" id="vr-next">' + text(c.FORM.next) + "</button>" +
    '<button class="btn btn-red btn-lg" type="submit" id="vr-pay" hidden>' + text(R.pay) + "</button></div>" +
    "</form>"
  );
}

function register() {
  const F = c.FORM;
  const K = c.CONFIRMATION;
  return (
    '    <section class="vr-register" id="register" aria-labelledby="register-title">\n' +
    '      <div class="wrap vr-register-grid">\n' +
    '        <div class="vr-register-intro">\n' +
    '          <p class="vr-label vr-label--dark">' + text(F.eyebrow) + "</p>\n" +
    '          <h2 class="vr-title vr-title--light" id="register-title">' + rich(F.heading) + "</h2>\n" +
    "          <p>" + text(F.subtext) + "</p>\n" +
    '          <p class="vr-register-state" id="vr-register-state" role="status" aria-live="polite">' + text(c.STATES.checking) + "</p>\n" +
    "        </div>\n" +
    '        <div class="vr-card" id="vr-card">\n' +
    '          <noscript><p class="form-error" style="display:block">Registration needs JavaScript. Turn it on, or email ' + text(c.SITE.supportEmail) + ".</p></noscript>\n" +
    '          <div class="vr-notice" id="vr-notice" role="status" hidden></div>\n' +
    '          <div class="vr-confirm" id="vr-confirm" tabindex="-1" hidden>\n' +
    '            <p class="vr-label" id="vr-confirm-eyebrow">' + text(K.paid.eyebrow) + "</p>\n" +
    '            <h3 class="vr-confirm-title" id="vr-confirm-title">' + text(K.checking.heading) + "</h3>\n" +
    '            <p id="vr-confirm-text">' + text(K.checking.text) + "</p>\n" +
    '            <dl class="vr-confirm-facts" id="vr-confirm-facts" hidden></dl>\n' +
    '            <p class="vr-confirm-email" id="vr-confirm-email" hidden></p>\n' +
    '            <div id="vr-confirm-steps" hidden><p class="vr-step-title">' + text(K.paid.stepsHeading) + '</p><ol class="vr-next-steps" id="vr-next-steps"></ol></div>\n' +
    '            <p class="vr-confirm-links" id="vr-confirm-links"></p>\n' +
    '            <button class="btn btn-red" type="button" id="vr-confirm-retry" hidden>' + text(K.pending.retry) + "</button>\n" +
    "          </div>\n" +
    "          " + formHtml() + "\n" +
    "        </div>\n" +
    "      </div>\n" +
    "    </section>"
  );
}

function faq() {
  return (
    '    <section class="vr-section" id="faq" aria-labelledby="faq-title">\n' +
    '      <div class="wrap">\n' +
    '        <p class="vr-label vr-center">' + text(c.FAQ.eyebrow) + "</p>\n" +
    '        <h2 class="vr-title vr-center" id="faq-title">' + rich(c.FAQ.heading) + "</h2>\n" +
    '        <div class="faq">\n' +
    c.FAQ.items.map((item) =>
      "          <details><summary>" + text(item.q) + "</summary><p>" + text(item.a) + "</p></details>\n").join("") +
    "        </div>\n" +
    "      </div>\n" +
    "    </section>"
  );
}

const footer =
  '  <footer class="site-footer">\n' +
  '    <div class="wrap footer-row">\n' +
  '      <p class="footer-line">' + text(c.FOOTER[0]) + "</p>\n" +
  '      <p class="footer-links"><a href="' + attr(c.LEGAL.privacyUrl) + '">Privacy</a><a href="' + attr(c.LEGAL.termsUrl) + '">Terms</a><a href="mailto:' + attr(c.SITE.supportEmail) + '">' + text(c.SITE.supportEmail) + "</a></p>\n" +
  '      <p class="copyright">' + text(c.FOOTER[1]) + "</p>\n" +
  "    </div>\n" +
  "  </footer>";

/** The data js/virtualRun.js needs. Wording comes from the content file, so the script holds none. */
function clientConfig() {
  const config = {
    api: { register: c.SITE.registerApi, status: c.SITE.statusApi, availability: c.SITE.availabilityApi },
    event: c.EVENT.name,
    minAge: c.ELIGIBILITY.minAge,
    support: c.SITE.supportEmail,
    packages: c.PACKAGES.map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents, price: price(p), physical: p.physical })),
    sizes: c.SHIRT_SIZES,
    provinces: c.PROVINCES,
    deliveryProvinces: c.DELIVERY.provinces,
    genders: c.GENDERS.map((g) => g.value),
    frequencies: c.FREQUENCIES.map((f) => f.value),
    goals: c.GOALS.map((g) => g.value),
    states: c.STATES,
    packageStates: c.PACKAGES_COPY.states,
    form: {
      stepTitles: c.FORM.stepTitles, stepLabel: c.FORM.stepLabel, of: c.FORM.of, labels: c.FORM.labels, errors: c.FORM.errors,
      next: c.FORM.next, review: c.FORM.review, delivery: c.FORM.delivery
    },
    // Packages whose features promise a personalised plan, so the confirmation can say what happens next for them.
    personalizedPackages: c.PACKAGES.filter((p) => p.features.some((f) => /personali[sz]ed/i.test(f))).map((p) => p.id),
    confirmation: c.CONFIRMATION
  };
  return JSON.stringify(config).replace(/</g, "\\u003c");
}

function structuredData() {
  if (!c.EVENT.datesConfirmed) return "";
  const data = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: c.EVENT.name,
    description: c.PAGE.description,
    startDate: c.EVENT.startDate,
    endDate: c.EVENT.endDate,
    eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    location: { "@type": "VirtualLocation", url: c.SITE.canonical },
    organizer: { "@type": "Organization", name: "Athlevo", url: "https://athlevo.org/" },
    url: c.SITE.canonical
  };
  return '  <script type="application/ld+json">' + JSON.stringify(data).replace(/</g, "\\u003c") + "</script>\n";
}

export function buildPage(existingHtml = "") {
  const head =
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <title>" + text(c.PAGE.title) + "</title>\n" +
    '  <meta name="description" content="' + attr(c.PAGE.description) + '">\n' +
    '  <meta name="robots" content="index, follow">\n' +
    '  <meta name="theme-color" content="#0a0a0b">\n' +
    '  <link rel="canonical" href="' + attr(c.SITE.canonical) + '">\n' +
    '  <meta property="og:type" content="website">\n' +
    '  <meta property="og:site_name" content="Athlevo">\n' +
    '  <meta property="og:title" content="' + attr(c.PAGE.ogTitle) + '">\n' +
    '  <meta property="og:description" content="' + attr(c.PAGE.ogDescription) + '">\n' +
    '  <meta property="og:url" content="' + attr(c.SITE.canonical) + '">\n' +
    '  <meta name="twitter:card" content="summary">\n' +
    '  <meta name="twitter:title" content="' + attr(c.PAGE.ogTitle) + '">\n' +
    '  <meta name="twitter:description" content="' + attr(c.PAGE.ogDescription) + '">\n' +
    '  <link rel="icon" type="image/png" href="/assets/athlevo-ae-icon.png">\n' +
    '  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&family=Inter:wght@400..700&display=swap" rel="stylesheet">\n' +
    '  <link rel="stylesheet" href="/store.css">\n' +
    '  <link rel="stylesheet" href="' + versioned("/virtual-run.css") + '">\n' +
    PIXEL_INSTRUCTIONS + pastedPixel(existingHtml) + PIXEL_END + "\n" +
    structuredData() +
    "</head>\n";
  const body =
    '<body class="vr">\n' +
    HEADER + "\n" +
    '  <main id="main" tabindex="-1">\n' +
    hero() + "\n" + how() + "\n" + results() + "\n" + packages() + "\n" + rewards() + "\n" + register() + "\n" + faq() + "\n" +
    "  </main>\n" +
    footer + "\n" +
    '  <script type="application/json" id="vr-config">' + clientConfig() + "</script>\n" +
    '  <script src="' + versioned("/js/virtualRun.js") + '" defer></script>\n' +
    "</body>\n</html>\n";
  return head + body;
}


// ---- Staff page ----

/** Public values the SPA already ships in index.html. The anon key only lets a staff member sign in; the API checks the allowlist. */
const SUPABASE_PUBLIC = {
  url: "https://hqwdehqsllyvrcnlcytj.supabase.co",
  anonKey: "sb_publishable_KxbACTdnsHG_uFNAV01bfA_NGkW-PCt",
  storageKey: "sb-hqwdehqsllyvrcnlcytj-auth-token"
};

export function buildAdminPage() {
  const packageOptions = c.PACKAGES.map((p) => '<option value="' + attr(p.id) + '">' + text(p.name) + "</option>").join("");
  const statusOptions = ["pending", "paid", "failed", "expired", "cancelled", "refunded"]
    .map((s) => '<option value="' + s + '">' + s.charAt(0).toUpperCase() + s.slice(1) + "</option>").join("");
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <title>Sub-1 10k registrations | Athlevo staff</title>\n" +
    '  <meta name="robots" content="noindex, nofollow, noarchive">\n' +
    '  <meta name="referrer" content="no-referrer">\n' +
    '  <meta name="theme-color" content="#0a0a0b">\n' +
    '  <link rel="icon" type="image/png" href="/assets/athlevo-ae-icon.png">\n' +
    '  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&family=Inter:wght@400..700&display=swap" rel="stylesheet">\n' +
    '  <link rel="stylesheet" href="/store.css">\n' +
    '  <link rel="stylesheet" href="' + versioned("/virtual-run.css") + '">\n' +
    "</head>\n" +
    '<body class="vr vra"' +
    ' data-supabase-url="' + attr(SUPABASE_PUBLIC.url) + '"' +
    ' data-supabase-key="' + attr(SUPABASE_PUBLIC.anonKey) + '"' +
    ' data-storage-key="' + attr(SUPABASE_PUBLIC.storageKey) + '"' +
    ' data-api="/api/virtual-run/admin">\n' +
    '  <a class="skip" href="#main">Skip to main content</a>\n' +
    '  <header class="site-header">\n' +
    '    <div class="nav vr-nav">\n' +
    '      <a class="wordmark" href="/" aria-label="Athlevo home">Athlevo<i aria-hidden="true">.</i></a>\n' +
    '      <button class="btn vra-signout" type="button" id="vra-signout" hidden>Sign out</button>\n' +
    "    </div>\n" +
    "  </header>\n" +
    '  <main id="main" class="vra-main" tabindex="-1">\n' +
    '    <div class="wrap">\n' +
    '      <p class="vra-note" id="vra-status" role="status" aria-live="polite">Checking your sign-in.</p>\n' +
    '      <section class="vra-signin" id="vra-signin" aria-labelledby="vra-signin-title" hidden>\n' +
    '        <h1 id="vra-signin-title">Staff sign in</h1>\n' +
    "        <p>Use the Athlevo account that is on the staff list. Registrations contain personal details, so this page shows them to staff only.</p>\n" +
    '        <form id="vra-signin-form" novalidate>\n' +
    '          <div class="field"><label for="vra-email">Email address</label><input id="vra-email" name="email" type="email" autocomplete="username" required></div>\n' +
    '          <div class="field"><label for="vra-password">Password</label><input id="vra-password" name="password" type="password" autocomplete="current-password" required></div>\n' +
    '          <p class="form-error" id="vra-signin-error" role="alert"></p>\n' +
    '          <button class="btn btn-red btn-lg" type="submit" id="vra-signin-button">Sign in</button>\n' +
    "        </form>\n" +
    "      </section>\n" +
    '      <section id="vra-app" aria-labelledby="vra-title" hidden>\n' +
    '        <div class="vra-bar">\n' +
    '          <h1 class="vra-title" id="vra-title">Sub-1 10k registrations</h1>\n' +
    '          <div class="vra-buttons"><button class="btn" type="button" id="vra-refresh">Refresh</button><button class="btn btn-red" type="button" id="vra-export">Export CSV</button></div>\n' +
    "        </div>\n" +
    '        <div class="vra-stats" id="vra-stats" aria-label="Summary"></div>\n' +
    '        <form class="vra-filters" id="vra-filters" novalidate>\n' +
    '          <div class="field"><label for="vra-package">Package</label><select id="vra-package" name="package"><option value="all">All packages</option>' + packageOptions + "</select></div>\n" +
    '          <div class="field"><label for="vra-state">Payment status</label><select id="vra-state" name="status"><option value="all">All statuses</option>' + statusOptions + "</select></div>\n" +
    '          <div class="field"><label for="vra-search">Search name, email or registration ID</label><input id="vra-search" name="q" type="search" autocomplete="off" maxlength="80"></div>\n' +
    '          <label class="vra-check-row"><input type="checkbox" id="vra-fulfillment" name="fulfillment"> To ship (paid, with shirt and medal)</label>\n' +
    '          <button class="btn btn-red" type="submit">Apply</button>\n' +
    "        </form>\n" +
    '        <p class="vra-note" id="vra-count" aria-live="polite"></p>\n' +
    '        <div class="vra-tablewrap"><table class="vra-table" id="vra-table"><caption class="sr-only">Registrations</caption>\n' +
    "          <thead><tr><th scope=\"col\">Registration ID</th><th scope=\"col\">Name</th><th scope=\"col\">Package</th><th scope=\"col\">Payment</th><th scope=\"col\">Paid</th><th scope=\"col\">Registered</th><th scope=\"col\"><span class=\"sr-only\">Details</span></th></tr></thead>\n" +
    '          <tbody id="vra-rows"></tbody></table>\n' +
    '          <p class="vra-empty" id="vra-empty" hidden>No registrations match.</p></div>\n' +
    "      </section>\n" +
    "    </div>\n" +
    "  </main>\n" +
    '  <script src="' + versioned("/js/virtualRunAdmin.js") + '" defer></script>\n' +
    "</body>\n</html>\n"
  );
}

// ---- CLI ----
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const existing = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const existingAdmin = existsSync(OUT_ADMIN) ? readFileSync(OUT_ADMIN, "utf8") : "";
  const html = buildPage(existing);
  const adminHtml = buildAdminPage();
  if (process.argv.includes("--check")) {
    const stale = [];
    if (existing !== html) stale.push("virtual-run.html");
    if (existingAdmin !== adminHtml) stale.push("virtual-run-admin.html");
    if (stale.length) {
      console.error(stale.join(" and ") + " out of date. Run: node scripts/build-virtual-run-page.mjs");
      process.exit(1);
    }
    console.log("virtual-run.html and virtual-run-admin.html are up to date.");
  } else {
    writeFileSync(OUT, html);
    writeFileSync(OUT_ADMIN, adminHtml);
    console.log("Wrote virtual-run.html (" + html.length + " bytes) and virtual-run-admin.html (" + adminHtml.length + " bytes).");
  }
}
