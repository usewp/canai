// Pure clustering heuristics for the classify stage. No I/O here — classify.mjs
// does the fetching; this module groups URLs and fingerprints DOM structure so
// pages sharing one layout become one "page type".

export function parentPathOf(url) {
  const segs = new URL(url).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length <= 1) return null;
  return "/" + segs.slice(0, -1).join("/");
}

// WordPress-rewrite-tag-style placeholders substituted for a leading date
// run (see dateRunLength below) when computing a GROUPING key. Deliberately
// values that can never appear as real URL segments (a bare percent sign
// isn't legal in a path segment) so they can't collide with genuine site
// content; nameFromPattern (below) recognizes them and names the resulting
// type "post" instead of a synthetic token. Position-indexed, one tag per
// date segment — a /YYYY/slug structure keys as "/%y%" while /YYYY/MM/slug
// keys as "/%y%/%m%": two DIFFERENT keys, so two different permalink depths
// never merge into one bucket just by both being date-ish.
const DATE_SEGMENT_TAGS = ["%y%", "%m%", "%d%"];
const DATE_TAG_RE = /^%[ymd]%$/;

// Is `s` a plausible WordPress %year%/%monthnum%/%day% rewrite-tag value?
// Bounded (month 1-12, day 1-31) so an out-of-range number never falls into
// the run by accident (e.g. a lone "/2020/99/foo" stops at just the year).
const isYearSeg = (s) => /^\d{4}$/.test(s);
const isMonthSeg = (s) => /^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 12;
const isDaySeg = (s) => /^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 31;

// How many of `segs`, starting at index 0, form a WordPress date-permalink
// run: %year% alone, %year%/%monthnum%, or %year%/%monthnum%/%day% (0 when
// there's no run at all). Deliberately anchored at index 0 ONLY — a real WP
// date permalink always puts the year as the very first path segment
// (`/%year%/%monthnum%/%postname%/`), immediately under the domain. That
// anchor is what keeps this conservative: a 4-digit number ANYWHERE deeper
// in the tree (a product's "2024 model" under `/products/2024/model-x`) is
// left alone because it's never at segs[0] for that URL's own parent-path
// array, so it can't accidentally collapse with an unrelated section. A
// version-style segment like `/docs/v2/...` is doubly excluded: "v2" isn't
// a bare number at all (isYearSeg/isMonthSeg both require ALL-digit), so it
// would never match even if it somehow ended up at index 0.
function dateRunLength(segs) {
  if (segs.length === 0 || !isYearSeg(segs[0])) return 0;
  if (segs.length > 1 && isMonthSeg(segs[1])) {
    if (segs.length > 2 && isDaySeg(segs[2])) return 3;
    return 2;
  }
  return 1;
}

// The clustering KEY for `url`: same shape as parentPathOf's literal parent
// path, but with a leading WordPress date run (year[/month[/day]]) replaced
// segment-for-segment by rewrite-tag placeholders, so /2025/05/foo and
// /2024/11/bar (and the 3-segment /2007/10/05/baz form, at ITS own depth)
// land in one shared bucket instead of each getting its own always-below-
// minMembers literal `/YYYY/MM` parent — the exact failure the
// smittenkitchen.com dogfood proved (16 recipe posts scattered across 14
// single-member `/YYYY/MM` buckets → classify found 0 types). Deliberately
// a SEPARATE function from parentPathOf, not a modification of it:
// parentPathOf's contract (the literal parent path) stays available
// verbatim to any caller that wants the real path; only the grouping key
// folds dates together.
export function groupKeyOf(url) {
  const segs = new URL(url).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length <= 1) return null;
  const parentSegs = segs.slice(0, -1);
  const runLen = dateRunLength(parentSegs);
  const keySegs = parentSegs.map((s, i) => (i < runLen ? DATE_SEGMENT_TAGS[i] : s));
  return "/" + keySegs.join("/");
}

export function groupByUrlPattern(urls, minMembers = 4) {
  const groups = new Map();
  const oneOffs = [];
  for (const url of urls) {
    const key = groupKeyOf(url);
    if (!key) {
      oneOffs.push(url);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(url);
  }
  const types = [];
  for (const [key, members] of groups) {
    if (members.length >= minMembers) types.push({ pattern: key + "/*", members });
    else oneOffs.push(...members);
  }
  return { types, oneOffs };
}

// Tag-skeleton fingerprint of <main> (fallback <body>). Text and attributes are
// ignored; runs of the same tag collapse (p,p,p → p+) so a 3-paragraph post and
// a 30-paragraph post fingerprint identically. Inline/decorative tags are
// dropped for the same reason. `iframe` is dropped for a DIFFERENT reason,
// found empirically against real smittenkitchen.com captures while fixing
// the comment-thread issue below: a same-day-fresh recipe capture had 28
// `<iframe>`s (nearly all `google_ads_iframe_*`/`goog_plcm_frame` ad-tech —
// live ad-auction injections, several 0×0 tracking frames with random hex
// ids), while an old recipe had exactly one real embedded VideoPress
// player. Ad-slot count/presence depends on auction timing at the moment of
// capture, not on the page's template — capturing the SAME URL twice can
// plausibly yield a different iframe count, which makes it worse than
// "genuinely different content" (a stable disagreement): left in, it's
// fingerprint NOISE that can flip a comparison between two runs of the
// identical page. That non-determinism, not merely "yet more tag-count
// variance" (which run-collapsing already tolerates), is why it's dropped
// entirely rather than fingerprinted, exactly like <script>/<style>.
const IGNORED_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "path", "g", "use",
  "br", "a", "b", "i", "em", "strong", "span", "small", "sup", "sub",
  "iframe",
]);

// --- comment-thread stripping (see fingerprintHtml) -------------------------
//
// Real dogfood evidence (smittenkitchen.com, a WordPress.com/Jetpack blog):
// 16 recipe posts sharing ONE real template still produced 16 distinct
// fingerprints — zero collisions — because each post's on-page comment
// thread (real captured markup: `<div id="comments" class="comments-area">`
// wrapping a `.comment-list` of `<li class="comment ... depth-N">` entries,
// plus a `#respond` reply form) varies in nesting depth/count per post (a
// 2007 post accumulates decades of nested replies; a same-day 2026 post has
// none yet). That's a genuinely different TAG SHAPE, not just a different
// tag COUNT — fingerprintHtml already collapses RUNS of the same repeated
// tag (p,p,p -> p+), which absorbs "more of the same", but nested reply
// threads interleave DIFFERENT tags at DIFFERENT depths (li > ul > li > ul
// > li ...), which collapsing can't absorb. Stripping the whole comment
// region before fingerprinting — the same principle already applied to
// <script>/<style> above — removes that volatility entirely.
//
// Deliberately NOT extended to a "related posts" widget: the dogfood site's
// own CONTENT-MODEL.md verified that block as "near-identically shaped" per
// sample (an h3 + up to 3 h4 links) — only the LINKED POSTS differ, i.e.
// only tag COUNT (already absorbed by run-collapsing), never nesting shape.
// Stripping something already tag-stable would just be extra surface area
// with no fingerprinting benefit, so it's left alone.
const COMMENT_CONTAINER_SELECTORS = [
  { attr: "id", value: "comments" },
  { attr: "class", value: "comments-area" },
  { attr: "class", value: "comment-list" },
  { attr: "id", value: "respond" },
  { attr: "id", value: "disqus_thread" },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// HTML elements that never have a closing tag — if a selector ever matched
// one of these (never true for a real comments wrapper, which is always a
// <div>/<section>/<aside>, but kept as a defensive fallback), depth-counting
// below would otherwise hang waiting for a `</tag>` that can't exist.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// Find the first OPENING tag whose attributes contain `id="value"` (exact)
// or `class="... value ..."` with `value` as a whole WHITESPACE-DELIMITED
// class token — never a substring hit inside a longer token. Note `\b`
// would be the WRONG tool for the class check: CSS class tokens are
// whitespace-delimited, but `\b` fires at any word/non-word transition
// including a hyphen, so `\bcomment-list\b` happily matches inside
// "comment-list-toggle". The class regex below instead requires the token
// to be bounded by the attribute quote or literal whitespace on both
// sides. Returns the matched tag's own name (read back out of the match,
// not assumed) plus its position, so the caller can find that SAME tag's
// true balanced close — never assumes "div".
function findOpenTag(html, { attr, value }) {
  const attrRe =
    attr === "id"
      ? new RegExp(`\\bid=["']${escapeRegExp(value)}["']`, "i")
      : new RegExp(`\\bclass=["'](?:[^"']*\\s)?${escapeRegExp(value)}(?:\\s[^"']*)?["']`, "i");
  const tagRe = /<([a-z][a-z0-9-]*)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    if (attrRe.test(m[0])) return { tagName: m[1].toLowerCase(), start: m.index, openEnd: tagRe.lastIndex };
  }
  return null;
}

// Remove ONE element matching `selector`, start tag through its TRUE
// balanced close — a naive non-greedy `<div ...>[\s\S]*?<\/div>` would stop
// at the FIRST `</div>`, which is wrong the moment the container has any
// nested `<div>` of its own (exactly what a real comment thread's markup
// does). Depth-counts opens/closes of the SAME tag name via one alternating
// regex so interleaved unrelated tags never confuse it. No matching close
// found at all (malformed/truncated HTML) degrades to "leave it alone"
// rather than eating the rest of the document.
function stripBalancedElement(html, selector) {
  const found = findOpenTag(html, selector);
  if (!found) return html;
  const { tagName, start, openEnd } = found;
  if (VOID_TAGS.has(tagName)) return html.slice(0, start) + html.slice(openEnd);

  const tokenRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, "gi");
  tokenRe.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[0].startsWith("</")) {
      depth -= 1;
    } else if (!/\/>\s*$/.test(m[0])) {
      // Ignore a self-closed `<div .../>` (XHTML-style, essentially never
      // real but cheap to guard) — it opens and closes itself, so it must
      // not need a separate matching close counted against this depth.
      depth += 1;
    }
    if (depth === 0) return html.slice(0, start) + html.slice(tokenRe.lastIndex);
  }
  return html; // no matching close anywhere — leave untouched
}

export function stripCommentContainers(html) {
  let src = html;
  for (const selector of COMMENT_CONTAINER_SELECTORS) {
    // A theme could repeat the same selector (rare); loop with a sane cap so
    // a pathological match that never shrinks the string can't hang.
    for (let i = 0; i < 20; i++) {
      const next = stripBalancedElement(src, selector);
      if (next === src) break;
      src = next;
    }
  }
  return src;
}

export function fingerprintHtml(html) {
  let src = String(html).replace(/<!--[\s\S]*?-->/g, "");
  const scoped =
    src.match(/<main[\s>][\s\S]*?<\/main>/i) ||
    src.match(/<body[\s>][\s\S]*?<\/body>/i);
  if (scoped) src = scoped[0];
  src = src
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  src = stripCommentContainers(src);
  const tags = [...src.matchAll(/<([a-z][a-z0-9-]*)\b/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((t) => !IGNORED_TAGS.has(t));
  const collapsed = [];
  for (const t of tags) {
    const last = collapsed[collapsed.length - 1];
    if (last === t || last === t + "+") {
      collapsed[collapsed.length - 1] = t + "+";
      continue;
    }
    collapsed.push(t);
  }
  return djb2(collapsed.join(","));
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function pickSamples(members, n = 3) {
  if (members.length <= n) return [...members];
  return [members[0], members[Math.floor(members.length / 2)], members[members.length - 1]];
}

export function nameFromPattern(pattern) {
  const segs = pattern.split("/").filter((s) => s && s !== "*");
  const last = segs[segs.length - 1];
  // A date-normalized bucket (see groupKeyOf) has no real URL segment to
  // name itself after — "%m%" would be a confusing literal type name, so
  // default to "post", matching what a WordPress date permalink actually
  // is (the built-in Posts type) and giving the reviewing agent a sensible
  // starting point instead of a synthetic token to puzzle over.
  if (last && DATE_TAG_RE.test(last)) return "post";
  return last || "pages";
}

// Nouns that are already singular (or invariant) but end in "s"/"ies" and
// would otherwise be mangled: news → "new", series → "sery".
const INVARIANT_NOUNS = new Set(["news", "series", "media", "press"]);

function singularize(word) {
  if (INVARIANT_NOUNS.has(word)) return word;
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/s$/.test(word) && !/ss$/.test(word)) return word.replace(/s$/, "");
  return word;
}

// Word-boundary matched, NOT a bare substring test — proven live (whole-branch
// review): "products", "product", "shop", and "store" all correctly matched
// the old `/product|shop|store/` regex, but so did "bookshop" (and any other
// compound word that merely CONTAINS "shop"/"store"/"product" without it
// being its own token, e.g. "workshop"). `\b` doesn't require a separator
// character — it fires at a word/non-word transition OR a string edge — so
// "book-shop" (hyphen-separated) still matches "shop" as its own token, but
// "bookshop" (no separator at all, one contiguous run of word chars) does
// not: there is no boundary between the "k" and the "s". That's exactly the
// line this needs to draw. A false `woo:*` kind matters beyond a cosmetic
// mis-name: TemplateResolver::resolve_current_template_type() gates its
// entire WooCommerce branch on `function_exists('is_woocommerce')`, so on a
// non-Woo site a wrongly-guessed `woo:product` term is never emitted and the
// page/type silently falls through to the theme with no template binding at
// all (see classify.mjs's buildPrompt, which now also tells the reviewing
// agent to confirm WooCommerce is actually installed before keeping any
// `woo:*` kind — this regex tightening narrows the mechanical false-positive
// rate but can't itself know whether WooCommerce is really there).
const WOO_KIND_RE = /\b(products?|shop|store)\b/;

export function guessKind(name) {
  const n = name.toLowerCase();
  if (WOO_KIND_RE.test(n)) return "woo:product";
  return "single:" + singularize(n);
}
