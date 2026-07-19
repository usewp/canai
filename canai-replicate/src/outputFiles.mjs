// Facts about a canai-replicate output file, derived purely from its name or
// its raw text. No fs access, no subprocess — every predicate here is a pure
// function of its argument, which is what makes them exhaustively
// unit-testable and safe to call from anywhere in the pipeline.
//
// These used to live in twigRender.mjs, deleted when canai-replicate dropped
// its PHP dependency. classifyTemplateFilename additionally replaces a
// near-duplicate that had drifted into verify.mjs as
// `templateTypeNameCandidate` — same convention, half the return value.

// A generated chrome partial (output/templates/header.html / footer.html —
// see prompts/transform-chrome.md) is a Twig FRAGMENT, not a standalone
// document: no <!DOCTYPE>/<head>/<body>, never meant to be opened or scored
// on its own. It only ever renders spliced into a page/template via
// {{ wpcanai_template('header'|'footer') }}, so there is no "original
// screenshot" of a bare header fragment to diff against. collectOutputs
// still lists it (it IS a real .html file under output/templates/), so
// verify.mjs filters it out with this.
export function isChromePartial(file) {
  return file === "header.html" || file === "footer.html";
}

// Does this HTML contain literal Twig delimiters? canai-replicate has no
// Twig engine — by design; Twig executes on the live WordPress site — so
// anything this returns true for cannot be scored locally and is flagged
// for post-deploy verification instead (see verify.mjs).
export function containsTwigSyntax(html) {
  return /\{\{|\{%/.test(String(html ?? ""));
}

// A template output file's slug follows transform.mjs's own naming
// convention: `${type.name}-single.html` / `${type.name}-archive.html` for a
// repeating type, or bare `${type.name}.html` (no suffix) for a Woo
// structural page. Recovering (typeName, variant) from that convention is
// what lets verify's --only accept a page-type name, matching capture and
// transform. Accepts either a filename or an already-stripped slug — the
// .html strip is a no-op on the latter.
export function classifyTemplateFilename(file) {
  const slug = file.replace(/\.html$/, "");
  if (slug.endsWith("-single")) return { typeName: slug.slice(0, -"-single".length), variant: "single" };
  if (slug.endsWith("-archive")) return { typeName: slug.slice(0, -"-archive".length), variant: "archive" };
  return { typeName: slug, variant: "structural" };
}
