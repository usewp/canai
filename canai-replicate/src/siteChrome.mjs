// Site-wide chrome (header/footer) is generated ONCE per site from one
// "representative" capture and shared via {{ wpcanai_template('header') }} /
// {{ wpcanai_template('footer') }} — see prompts/transform-chrome.md — rather
// than re-authored (and drifting) per page/type. Two different stages need
// the exact same answer to "which capture represents the site chrome":
//
//   - transform.mjs (Fix B) picks the capture to hand the authoring agent
//     when it builds the chrome bundle.
//   - verify.mjs's Twig-render harness (Fix A) needs the SAME capture's real
//     header/footer nav links to stub get_menu() when it renders any page
//     or template for scoring — using a different capture than the one
//     header.html/footer.html were actually authored from would score
//     against nav data the templates don't agree with.
//
// Kept here once so the two stages can never independently disagree.

import { urlToSlug } from "./slug.mjs";

// Prefer the homepage ("index" slug) if it was captured; else the first
// one-off page; else the first member of a page-shaped type; else the first
// sample of the first repeating type. Returns a source URL string, or null
// when the run has no candidate at all (e.g. zero pages and zero types).
export function pickRepresentativeCaptureUrl(pagetypes) {
  const pages = Array.isArray(pagetypes?.pages) ? pagetypes.pages : [];
  const types = Array.isArray(pagetypes?.types) ? pagetypes.types : [];

  const indexPage = pages.find((p) => p?.url && urlToSlug(p.url) === "index");
  if (indexPage) return indexPage.url;

  const firstPage = pages.find((p) => p?.url);
  if (firstPage) return firstPage.url;

  for (const t of types) {
    if (t?.kind === "page" && Array.isArray(t.members) && t.members.length > 0 && t.members[0]) {
      return t.members[0];
    }
  }
  for (const t of types) {
    if (Array.isArray(t?.samples) && t.samples.length > 0 && t.samples[0]) {
      return t.samples[0];
    }
  }
  return null;
}

// Same answer, already reduced to the capture-dir slug (captures/<slug>/).
export function pickRepresentativeCaptureSlug(pagetypes) {
  const url = pickRepresentativeCaptureUrl(pagetypes);
  return url ? urlToSlug(url) : null;
}
