// URL → filesystem-safe slug.
// "/" → "index". Strips query string and trailing slashes. Collapses anything
// non-[a-z0-9-_/] to "-". Path separators become "__" so each page is one file.

export function urlToSlug(url) {
  const u = new URL(url);
  let path = u.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") return "index";
  path = path.replace(/^\//, "");
  return path
    .toLowerCase()
    .replace(/\//g, "__")
    .replace(/[^a-z0-9_\-.]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function siteFromUrl(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

// Normalize a `--only` filter value to an output slug. A URL pathname
// ("/", "/about") is converted the same way page URLs are, so `--only /`
// matches output/index.html; a bare slug ("index", "about") passes through.
export function onlyToSlug(only) {
  return only.startsWith("/") ? urlToSlug(`http://x${only}`) : only;
}

// The ONE shared `--only <path|slug|type>` matcher for capture, transform,
// and verify (bin/replica documents all three forms for all three stages).
// Before this existed, each stage hand-rolled its own filter and they
// silently diverged: capture never accepted a bare output slug ("about"),
// verify never accepted a page-type name ("product") — despite verify's own
// `applyOnlyFilter` doc comment claiming "onlyToSlug is the same
// normalization capture/transform use" (false — neither imported it). That
// breaks the pipeline's documented error-recovery contract ("any stage
// partially fails → resume via --only") for two of its three forms,
// depending which stage you're resuming.
//
// `only` is matched against whichever of `url`/`slug`/`typeName` the caller
// has on hand for this entry — a caller passes only the fields it actually
// has (a capture worklist entry has a url + optional type name; a verify
// output entry has only a filename-derived slug + optionally a type name
// recovered from that filename's `-single`/`-archive` convention; see
// verify.mjs's `templateTypeNameCandidate`).
//
//   - page-type name: compared literally against `typeName` — never
//     slug-normalized, so a type named e.g. "about" can't be accidentally
//     selected by `--only /about` (a path) or vice versa.
//   - URL pathname / output slug: unified into ONE comparison by reusing
//     `onlyToSlug` on `only` and comparing it against `slug` (or, when the
//     caller only has a raw `url`, `urlToSlug(url)` computed here) — exactly
//     how onlyToSlug already normalizes both forms to the same shape.
//
// Returns true (matches everything) when `only` is falsy, so every call site
// can call this unconditionally instead of guarding with `if (only)` first.
export function matchesOnly(only, { url = null, slug = null, typeName = null } = {}) {
  if (!only) return true;
  if (typeName != null && typeName === only) return true;
  // Kept for robustness beyond the three documented forms: the pre-fix
  // capture.mjs also matched a literal full-URL string, and dropping that
  // silently would narrow existing (if undocumented) behavior.
  if (url != null && url === only) return true;
  const targetSlug = slug != null ? slug : url != null ? urlToSlug(url) : null;
  return targetSlug != null && targetSlug === onlyToSlug(only);
}
