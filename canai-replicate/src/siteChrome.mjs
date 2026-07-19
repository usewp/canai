// Site-wide chrome (header/footer) is generated ONCE per site from one
// "representative" capture and shared via {{ wpcanai_template('header') }} /
// {{ wpcanai_template('footer') }} — see prompts/transform-chrome.md — rather
// than re-authored (and drifting) per page/type. transform.mjs is the sole
// consumer of pickRepresentativeCaptureUrl/pickRepresentativeCaptureSlug: it
// picks the capture to hand the authoring agent when it builds the chrome
// bundle, and that choice is exactly what header.html/footer.html — the
// generated chrome partials — end up authored from (their real nav links,
// their real header/footer markup). verify.mjs used to be a second consumer,
// needing the same answer to stub get_menu() inside a local Twig-render
// harness for scoring; that harness is gone — verify no longer renders Twig
// at all, so it no longer imports this module.
//
// Kept in its own module (rather than inlined into transform.mjs) so a
// future second consumer can't independently pick a different capture and
// silently disagree with what the chrome was actually authored from.

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
