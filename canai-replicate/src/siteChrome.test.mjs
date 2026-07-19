import test from "node:test";
import assert from "node:assert/strict";
import { pickRepresentativeCaptureUrl, pickRepresentativeCaptureSlug } from "./siteChrome.mjs";

test("pickRepresentativeCaptureUrl prefers the homepage ('/' -> index slug) over other pages", () => {
  const pagetypes = {
    site: "example.com",
    pages: [{ url: "https://example.com/about/" }, { url: "https://example.com/" }],
    types: [],
  };
  assert.equal(pickRepresentativeCaptureUrl(pagetypes), "https://example.com/");
});

test("pickRepresentativeCaptureUrl falls back to the first one-off page when there's no homepage", () => {
  const pagetypes = {
    pages: [{ url: "https://example.com/about/" }, { url: "https://example.com/contact/" }],
    types: [],
  };
  assert.equal(pickRepresentativeCaptureUrl(pagetypes), "https://example.com/about/");
});

test("pickRepresentativeCaptureUrl falls back to a page-shaped type's first member when there are no one-off pages", () => {
  const pagetypes = {
    pages: [],
    types: [{ kind: "page", members: ["https://example.com/a/", "https://example.com/b/"] }],
  };
  assert.equal(pickRepresentativeCaptureUrl(pagetypes), "https://example.com/a/");
});

test("pickRepresentativeCaptureUrl falls back to a repeating type's first sample as a last resort (e.g. barefootbuttons.com-shaped: product samples only, no plain pages)", () => {
  const pagetypes = {
    pages: [],
    types: [
      { kind: "woo:cart", samples: ["https://example.com/cart/"] },
    ],
  };
  assert.equal(pickRepresentativeCaptureUrl(pagetypes), "https://example.com/cart/");
});

test("pickRepresentativeCaptureUrl returns null when there is nothing to pick from", () => {
  assert.equal(pickRepresentativeCaptureUrl({ pages: [], types: [] }), null);
  assert.equal(pickRepresentativeCaptureUrl({}), null);
});

test("pickRepresentativeCaptureSlug reduces the picked URL the same way capture/transform/verify do (urlToSlug)", () => {
  const pagetypes = { pages: [{ url: "https://example.com/" }], types: [] };
  assert.equal(pickRepresentativeCaptureSlug(pagetypes), "index");
});

test("pickRepresentativeCaptureSlug returns null when pickRepresentativeCaptureUrl would", () => {
  assert.equal(pickRepresentativeCaptureSlug({ pages: [], types: [] }), null);
});
