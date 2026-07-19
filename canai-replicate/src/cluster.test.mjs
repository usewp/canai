import test from "node:test";
import assert from "node:assert/strict";
import {
  parentPathOf,
  groupKeyOf,
  groupByUrlPattern,
  fingerprintHtml,
  stripCommentContainers,
  pickSamples,
  nameFromPattern,
  guessKind,
} from "./cluster.mjs";

test("parentPathOf returns parent for deep paths, null for top-level", () => {
  assert.equal(parentPathOf("https://x.com/blog/my-post"), "/blog");
  assert.equal(parentPathOf("https://x.com/shop/widgets/blue-widget/"), "/shop/widgets");
  assert.equal(parentPathOf("https://x.com/about"), null);
  assert.equal(parentPathOf("https://x.com/"), null);
});

test("groupByUrlPattern groups >= minMembers under one pattern, rest are one-offs", () => {
  const urls = [
    "https://x.com/",
    "https://x.com/about",
    "https://x.com/blog/a",
    "https://x.com/blog/b",
    "https://x.com/blog/c",
    "https://x.com/blog/d",
    "https://x.com/team/jane",
    "https://x.com/team/joe",
  ];
  const { types, oneOffs } = groupByUrlPattern(urls, 4);
  assert.equal(types.length, 1);
  assert.equal(types[0].pattern, "/blog/*");
  assert.equal(types[0].members.length, 4);
  // /team has only 2 members → demoted to one-offs, along with / and /about
  assert.equal(oneOffs.length, 4);
});

test("fingerprintHtml is stable across text changes, differs across structure", () => {
  const a = "<html><body><main><h1>Hello</h1><p>one</p><p>two</p></main></body></html>";
  const b = "<html><body><main><h1>Other title</h1><p>x</p><p>y</p><p>z</p></main></body></html>";
  const c = "<html><body><main><div><ul><li>a</li><li>b</li></ul></div></main></body></html>";
  // b has more <p> but runs collapse: h1,p+ === h1,p+
  assert.equal(fingerprintHtml(a), fingerprintHtml(b));
  assert.notEqual(fingerprintHtml(a), fingerprintHtml(c));
});

test("fingerprintHtml ignores scripts, styles, comments", () => {
  const a = "<body><main><h1>t</h1></main></body>";
  const b = "<body><main><!-- hi --><script>let x=1;</script><style>p{}</style><h1>t</h1></main></body>";
  assert.equal(fingerprintHtml(a), fingerprintHtml(b));
});

test("pickSamples spreads first/middle/last, passthrough when small", () => {
  assert.deepEqual(pickSamples(["a", "b"]), ["a", "b"]);
  assert.deepEqual(pickSamples(["a", "b", "c", "d", "e"]), ["a", "c", "e"]);
});

test("nameFromPattern and guessKind", () => {
  assert.equal(nameFromPattern("/blog/*"), "blog");
  assert.equal(nameFromPattern("/shop/products/*"), "products");
  assert.equal(guessKind("products"), "woo:product");
  assert.equal(guessKind("shop"), "woo:product");
  assert.equal(guessKind("blog"), "single:blog");
  assert.equal(guessKind("stories"), "single:story");
  assert.equal(guessKind("team"), "single:team");
});

// --- Fix 5a: word-boundary matching, not a bare substring test ------------
// Proven live: "bookshop" (and any other compound with no separator before
// "shop"/"store"/"product") mis-matched the old `/product|shop|store/`
// regex, mislabeling a non-Woo type as `woo:product`.

test("guessKind: legitimate shop/store/product tokens still map to woo:product (no regression from the boundary fix)", () => {
  assert.equal(guessKind("products"), "woo:product");
  assert.equal(guessKind("product"), "woo:product");
  assert.equal(guessKind("shop"), "woo:product");
  assert.equal(guessKind("store"), "woo:product");
});

test("guessKind: a hyphen-separated compound still matches — the separator makes it its own token", () => {
  assert.equal(guessKind("book-shop"), "woo:product");
  assert.equal(guessKind("gift-store"), "woo:product");
});

test("guessKind: a bare substring inside an unrelated compound word must NOT match (the live bug)", () => {
  assert.equal(guessKind("bookshop"), "single:bookshop", "‘shop’ with no separator is not its own token");
  assert.equal(guessKind("workshop"), "single:workshop");
  assert.equal(guessKind("workshops"), "single:workshop", "still singularizes once it's correctly NOT woo:product");
});

test("guessKind leaves invariant nouns alone", () => {
  assert.equal(guessKind("news"), "single:news");
  assert.equal(guessKind("series"), "single:series");
  assert.equal(guessKind("media"), "single:media");
  // regular plurals still singularize
  assert.equal(guessKind("stories"), "single:story");
  assert.equal(guessKind("events"), "single:event");
});

test("fingerprintHtml is stable when body copy contains inline links", () => {
  const plain = "<body><main><h1>t</h1><p>text</p><p>more</p></main></body>";
  const linked = '<body><main><h1>t</h1><p>text <a href="/x">link</a></p><p>more <a href="/y">two</a></p></main></body>';
  assert.equal(fingerprintHtml(plain), fingerprintHtml(linked));
});

test("fingerprintHtml scopes to <body> when there is no <main>", () => {
  // A page with no <main>: the fingerprint must come from <body> content only.
  // If the <body>-scoping fallback were removed, <head>'s tags (title, meta,
  // link) would leak into the skeleton and change the hash — so a document
  // with a fat <head> must fingerprint identically to a bare <body>.
  const bare = "<body><h1>t</h1><p>x</p></body>";
  const withHead =
    '<html><head><title>Title</title><meta charset="utf-8"><link rel="canonical" href="/x"></head>' +
    "<body><h1>t</h1><p>x</p></body></html>";
  assert.equal(fingerprintHtml(withHead), fingerprintHtml(bare));

  // And the body-derived print must be real, not the empty-document print.
  assert.notEqual(fingerprintHtml(bare), fingerprintHtml("<html><body></body></html>"));
});

// ---------------------------------------------------------------------------
// Fix (smittenkitchen.com dogfood, defect #3a): WordPress date permalinks.
// /YYYY/MM/slug posts each parented to their own /YYYY/MM bucket, so a
// 16-post type scattered across 14 single-member buckets and classify found
// 0 types. groupKeyOf folds a LEADING date run into rewrite-tag placeholders
// so all date-permalink posts share one bucket, at their own depth.
// ---------------------------------------------------------------------------

test("groupKeyOf folds a leading WordPress date run into rewrite-tag placeholders, per depth", () => {
  assert.equal(groupKeyOf("https://x.com/2025/05/some-post/"), "/%y%/%m%");
  assert.equal(groupKeyOf("https://x.com/2024/11/other-post"), "/%y%/%m%");
  assert.equal(groupKeyOf("https://x.com/2007/10/05/day-permalink-post/"), "/%y%/%m%/%d%");
  assert.equal(groupKeyOf("https://x.com/2024/year-only-post/"), "/%y%");
  // Different permalink depths must NOT merge just by both being date-ish.
  assert.notEqual(
    groupKeyOf("https://x.com/2024/year-only-post/"),
    groupKeyOf("https://x.com/2024/11/other-post"),
  );
});

test("groupKeyOf boundaries: only in-range month/day values continue a date run", () => {
  assert.equal(groupKeyOf("https://x.com/2020/12/post/"), "/%y%/%m%", "12 is a month");
  assert.equal(groupKeyOf("https://x.com/2020/1/post/"), "/%y%/%m%", "unpadded 1 is a month");
  assert.equal(groupKeyOf("https://x.com/2020/13/post/"), "/%y%/13", "13 is not a month");
  assert.equal(groupKeyOf("https://x.com/2020/00/post/"), "/%y%/00", "0 is not a month");
  assert.equal(groupKeyOf("https://x.com/2020/01/31/post/"), "/%y%/%m%/%d%", "31 is a day");
  assert.equal(groupKeyOf("https://x.com/2020/01/32/post/"), "/%y%/%m%/32", "32 is not a day");
});

test("groupKeyOf is conservative: date folding is anchored at the FIRST path segment only", () => {
  // Version segments aren't bare numbers — never folded, /docs/v2 stays
  // distinct from /docs/v3.
  assert.equal(groupKeyOf("https://x.com/docs/v2/getting-started"), "/docs/v2");
  assert.notEqual(
    groupKeyOf("https://x.com/docs/v2/getting-started"),
    groupKeyOf("https://x.com/docs/v3/getting-started"),
  );
  // A year DEEPER in the tree is not a date permalink — left alone.
  assert.equal(groupKeyOf("https://x.com/products/2024/model-x"), "/products/2024");
  assert.notEqual(
    groupKeyOf("https://x.com/products/2024/model-x"),
    groupKeyOf("https://x.com/products/2023/model-x"),
  );
  // Non-date URLs keep the literal parent path (identical to parentPathOf).
  assert.equal(groupKeyOf("https://x.com/blog/my-post"), "/blog");
  assert.equal(groupKeyOf("https://x.com/about"), null);
  assert.equal(groupKeyOf("https://x.com/"), null);
});

test("groupByUrlPattern clusters date permalinks spread across years/months into ONE type (the smittenkitchen 0-types failure)", () => {
  const urls = [
    "https://x.com/2007/01/a/",
    "https://x.com/2009/04/b/",
    "https://x.com/2017/12/c/",
    "https://x.com/2026/07/d/",
    "https://x.com/about/",
    "https://x.com/recipes/",
  ];
  const { types, oneOffs } = groupByUrlPattern(urls, 4);
  assert.equal(types.length, 1);
  assert.equal(types[0].pattern, "/%y%/%m%/*");
  assert.deepEqual(types[0].members, [
    "https://x.com/2007/01/a/",
    "https://x.com/2009/04/b/",
    "https://x.com/2017/12/c/",
    "https://x.com/2026/07/d/",
  ]);
  assert.deepEqual(oneOffs, ["https://x.com/about/", "https://x.com/recipes/"]);
});

test("nameFromPattern names a date-normalized bucket 'post' (and guessKind keeps it non-Woo)", () => {
  assert.equal(nameFromPattern("/%y%/%m%/*"), "post");
  assert.equal(nameFromPattern("/%y%/*"), "post");
  assert.equal(nameFromPattern("/%y%/%m%/%d%/*"), "post");
  assert.equal(guessKind(nameFromPattern("/%y%/%m%/*")), "single:post");
  // Non-date patterns are untouched by the special-casing.
  assert.equal(nameFromPattern("/blog/*"), "blog");
});

// ---------------------------------------------------------------------------
// Fix (smittenkitchen.com dogfood, defect #3b): comment-thread stripping.
// 16 recipe posts sharing ONE template produced 16 distinct fingerprints —
// per-post comment threads differ in nesting shape (li > ol > li ...), which
// run-collapsing cannot absorb. Comment containers are now stripped before
// fingerprinting, like <script>/<style>.
// ---------------------------------------------------------------------------

test("fingerprintHtml: same template, different nested comment threads → identical fingerprints (the smittenkitchen failure)", () => {
  const article = "<h1>title</h1><p>body</p><ul><li>x</li></ul>";
  const noComments =
    `<body><main><article>${article}</article>` +
    `<div id="comments" class="comments-area"><h2>No comments yet</h2>` +
    `<div id="respond" class="comment-respond"><form><p><textarea></textarea></p></form></div>` +
    `</div></main></body>`;
  // Deeply nested reply thread — a genuinely different tag SHAPE, modeled on
  // the real captured markup (ol.comment-list > li.comment > article >
  // footer > time, nested ol children replies).
  const deepThread =
    `<body><main><article>${article}</article>` +
    `<div id="comments" class="comments-area"><h2>733 comments</h2>` +
    `<ol class="comment-list">` +
    `<li class="comment even thread-even depth-1"><article><footer><time>2007</time></footer><p>first</p></article>` +
    `<ol><li class="comment odd alt depth-2"><article><p>reply</p></article>` +
    `<ol><li class="comment even depth-3"><article><blockquote><p>quoted</p></blockquote></article></li></ol>` +
    `</li></ol></li></ol>` +
    `<div id="respond" class="comment-respond"><form><p><input></p></form></div>` +
    `</div></main></body>`;
  assert.equal(fingerprintHtml(noComments), fingerprintHtml(deepThread));
});

test("stripCommentContainers removes the whole balanced container (nested divs inside), and content AFTER it survives", () => {
  const page = (commentsInner, after) =>
    `<body><main><h1>t</h1>` +
    `<div id="comments" class="comments-area">${commentsInner}</div>` +
    `${after}</main></body>`;
  // Nested <div>s inside the container: a naive first-</div> match would cut
  // early and leave comment guts in the fingerprint.
  const a = page("<div><div><p>c</p></div></div>", "<section><table><tr><td>after</td></tr></table></section>");
  const b = page("<ul><li>completely different comment shape</li></ul>", "<section><table><tr><td>after</td></tr></table></section>");
  assert.equal(fingerprintHtml(a), fingerprintHtml(b), "differences INSIDE the container must not matter");
  const c = page("<div><p>c</p></div>", ""); // no after-content
  assert.notEqual(fingerprintHtml(a), fingerprintHtml(c), "content AFTER the container must still count — strip must not eat to end-of-document");
  // Content that sits after an INNER element's close but still INSIDE the
  // container must be stripped too — this is what distinguishes a true
  // balanced close from a naive cut-at-first-closing-tag: the naive cut
  // would leave the <table> below visible to the fingerprint.
  const d = page(
    "<div><p>c</p></div><table><tr><td>still inside comments</td></tr></table>",
    "<section><table><tr><td>after</td></tr></table></section>",
  );
  assert.equal(fingerprintHtml(a), fingerprintHtml(d), "everything up to the container's TRUE close must be stripped, not just up to the first inner close");
});

test("stripCommentContainers strips each known container kind by id or whitespace-delimited class token", () => {
  assert.equal(stripCommentContainers('<div id="respond"><form><input></form></div><p>x</p>'), "<p>x</p>");
  assert.equal(stripCommentContainers('<div id="disqus_thread"><a>load</a></div><p>x</p>'), "<p>x</p>");
  assert.equal(
    stripCommentContainers('<section class="widget comments-area extra"><ul><li>c</li></ul></section><p>x</p>'),
    "<p>x</p>",
    "class token inside a multi-class attribute, on a non-div element",
  );
  assert.equal(
    stripCommentContainers('<ol class="comment-list"><li>c</li></ol><p>x</p>'),
    "<p>x</p>",
  );
});

test("stripCommentContainers: a class token must be whitespace-delimited — 'comment-list-toggle' is NOT 'comment-list'", () => {
  const html = '<div class="comment-list-toggle"><p>keep me</p></div>';
  assert.equal(stripCommentContainers(html), html);
});

test("stripCommentContainers: an id must match exactly — 'comments-header' is NOT 'comments'", () => {
  const html = '<div id="comments-header"><p>keep me</p></div>';
  assert.equal(stripCommentContainers(html), html);
});

test("stripCommentContainers degrades to leaving the html untouched when the container never closes (truncated/malformed capture)", () => {
  const html = '<div id="comments"><p>never closed';
  assert.equal(stripCommentContainers(html), html);
});

test("fingerprintHtml ignores iframes — ad-auction frames vary per capture on live ad-tech sites (seen: 28 ad iframes on one smittenkitchen capture, 1 real embed on another)", () => {
  const clean = "<body><main><h1>t</h1><p>x</p><div><p>y</p></div></main></body>";
  const adLaden =
    '<body><main><h1>t</h1><iframe id="google_ads_iframe_/145131060/medrec_0"></iframe><p>x</p>' +
    '<div><iframe style="display:none"></iframe><p>y</p><iframe></iframe></div></main></body>';
  assert.equal(fingerprintHtml(clean), fingerprintHtml(adLaden));
});
