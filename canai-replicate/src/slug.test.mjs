import { test } from "node:test";
import assert from "node:assert/strict";
import { onlyToSlug, matchesOnly } from "./slug.mjs";

test("onlyToSlug: a URL pathname normalizes to the output slug", () => {
  assert.equal(onlyToSlug("/"), "index");
  assert.equal(onlyToSlug("/about"), "about");
  assert.equal(onlyToSlug("/about/"), "about");
  assert.equal(onlyToSlug("/blog/post"), "blog__post");
});

test("onlyToSlug: a bare slug passes through unchanged", () => {
  assert.equal(onlyToSlug("index"), "index");
  assert.equal(onlyToSlug("about"), "about");
  assert.equal(onlyToSlug("blog__post"), "blog__post");
});

// --- matchesOnly: the ONE shared --only matcher (Fix 2) ---------------------
// capture, transform, and verify each used to implement `--only` differently
// (capture threw on a bare slug, verify threw on a type name — see the
// per-file tests in capture.test.mjs / verify.test.mjs for the end-to-end
// proof). This pins the shared matcher's contract in isolation.

test("matchesOnly: no --only (null/undefined/empty) always matches, regardless of context", () => {
  assert.equal(matchesOnly(null, { url: "https://x.com/about" }), true);
  assert.equal(matchesOnly(undefined, {}), true);
  assert.equal(matchesOnly("", { slug: "about" }), true);
  assert.equal(matchesOnly(null, {}), true);
});

test("matchesOnly: URL pathname form matches via url, normalized the same as onlyToSlug", () => {
  assert.equal(matchesOnly("/about", { url: "https://x.com/about" }), true);
  assert.equal(matchesOnly("/about/", { url: "https://x.com/about" }), true, "trailing slash in --only");
  assert.equal(matchesOnly("/", { url: "https://x.com/" }), true, "root path -> index");
  assert.equal(matchesOnly("/blog/post", { url: "https://x.com/blog/post" }), true, "nested path -> __-joined slug");
  assert.equal(matchesOnly("/nope", { url: "https://x.com/about" }), false);
});

test("matchesOnly: URL pathname form also matches via a precomputed slug (no url on hand)", () => {
  assert.equal(matchesOnly("/about", { slug: "about" }), true);
  assert.equal(matchesOnly("/blog/post", { slug: "blog__post" }), true);
  assert.equal(matchesOnly("/about", { slug: "contact" }), false);
});

test("matchesOnly: bare output-slug form matches directly, via url or via slug", () => {
  assert.equal(matchesOnly("about", { url: "https://x.com/about" }), true);
  assert.equal(matchesOnly("about", { slug: "about" }), true);
  assert.equal(matchesOnly("index", { url: "https://x.com/" }), true);
  assert.equal(matchesOnly("about", { slug: "blog__about" }), false, "must not substring-match");
});

test("matchesOnly: page-type name form matches typeName literally, independent of url/slug", () => {
  assert.equal(matchesOnly("product", { typeName: "product", url: "https://x.com/product/a" }), true);
  assert.equal(matchesOnly("product", { typeName: "product" }), true, "types have no single url");
  assert.equal(matchesOnly("product", { typeName: "other-type" }), false);
  assert.equal(matchesOnly("product", { typeName: "product-category" }), false, "must not substring-match");
});

test("matchesOnly: type-name and path/slug forms never cross-match each other", () => {
  assert.equal(matchesOnly("about", { typeName: "about" }), true, "typeName IS compared literally against `only`...");
  assert.equal(matchesOnly("/about", { typeName: "about" }), false, "...but a PATH form is never slug-normalized against typeName");
  assert.equal(matchesOnly("about", { url: "https://x.com/product", typeName: "product" }), false);
});

test("matchesOnly: an exact full-URL string still matches (pre-fix capture.mjs behavior, kept for robustness)", () => {
  assert.equal(matchesOnly("https://x.com/about", { url: "https://x.com/about" }), true);
});
