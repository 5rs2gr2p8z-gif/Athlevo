console.log("Athlevo Legal Loaded");

/*
 * Legal document pages (Privacy Policy, Terms of Service, Private Beta).
 *
 * Each document's single source of truth is a markdown file under
 * /legal. It is fetched on first open, rendered with a small, safe
 * markdown converter, and shown as an in-app screen. Navigation uses the
 * existing SPA showScreen() so opening/closing a legal page never
 * reloads and never affects the Supabase auth session.
 *
 * This file does not touch authentication, coach, readiness, or
 * subscription logic.
 */

const LEGAL_DOCS = {
  privacy: {
    file: "legal/privacy-policy.md",
    screen: "screen-privacy",
    body: "legalBodyPrivacy"
  },
  terms: {
    file: "legal/terms-of-service.md",
    screen: "screen-terms",
    body: "legalBodyTerms"
  },
  beta: {
    file: "legal/private-beta.md",
    screen: "screen-beta",
    body: "legalBodyBeta"
  }
};

const legalRenderedCache = {};
let legalReturnScreen = "screen-welcome";
let legalReturnToSignup = false;

function legalEscapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Inline: bold only (content is escaped first, so this is injection-safe).
function legalInline(text) {
  return legalEscapeHtml(text).replace(
    /\*\*(.+?)\*\*/g,
    "<strong>$1</strong>"
  );
}

/*
 * Minimal, safe markdown → HTML for our own legal files. Supports
 * # / ## / ### headings, single-level "* " or "- " bullet lists,
 * paragraphs (one per line), **bold**, and skips HTML comment blocks.
 */
function renderLegalMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");

  let html = "";
  let inList = false;
  let inComment = false;

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    // Skip HTML comment blocks (the editor markers at the top of a file).
    if (!inComment && line.includes("<!--")) {
      inComment = true;
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html += `<h${level}>${legalInline(heading[2])}</h${level}>`;
      continue;
    }

    const item = line.match(/^\s*[*-]\s+(.*)$/);
    if (item) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${legalInline(item[1])}</li>`;
      continue;
    }

    closeList();
    const isUpdated = /^last updated:/i.test(line.trim());
    html +=
      `<p${isUpdated ? ' class="legal-updated"' : ""}>` +
      `${legalInline(line.trim())}</p>`;
  }

  closeList();
  return html;
}

async function loadLegalDoc(key) {
  const doc = LEGAL_DOCS[key];
  const container = document.getElementById(doc.body);
  if (!container) return;

  if (legalRenderedCache[key]) {
    container.innerHTML = legalRenderedCache[key];
    return;
  }

  container.innerHTML = '<p class="legal-loading">Loading…</p>';

  try {
    const response = await fetch(doc.file, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    const markdown = await response.text();
    const rendered = renderLegalMarkdown(markdown);
    legalRenderedCache[key] = rendered;
    container.innerHTML = rendered;
  } catch (error) {
    console.warn("Could not load legal document:", key, error?.message);
    container.innerHTML =
      '<p class="legal-loading">We couldn’t load this document right ' +
      "now. Please check your connection and try again.</p>";
  }
}

/*
 * Opens a legal page. Remembers where to return so the athlete lands
 * back exactly where they were (and re-opens the signup sheet if they
 * came from it). Never reloads → auth session untouched.
 */
function openLegal(key) {
  const doc = LEGAL_DOCS[key];
  if (!doc) return;

  const authModal = document.getElementById("authModal");
  legalReturnToSignup =
    !!authModal && authModal.style.display !== "none" && authModal.style.display !== "";

  if (legalReturnToSignup && typeof closeAuth === "function") {
    closeAuth();
  }

  const active = document.querySelector(".screen.active");
  if (active && !active.id.startsWith("screen-privacy") &&
      active.id !== "screen-terms" && active.id !== "screen-beta") {
    legalReturnScreen = active.id;
  }

  if (typeof showScreen === "function") {
    showScreen(doc.screen);
  }

  const screenEl = document.getElementById(doc.screen);
  if (screenEl) screenEl.scrollTop = 0;

  loadLegalDoc(key);
}

/* Returns to the previous screen (and the signup sheet if applicable). */
function closeLegal() {
  if (typeof showScreen === "function") {
    showScreen(legalReturnScreen || "screen-welcome");
  }

  if (legalReturnToSignup && typeof openSignup === "function") {
    openSignup();
    legalReturnToSignup = false;
  }
}

window.openLegal = openLegal;
window.closeLegal = closeLegal;
