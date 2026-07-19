import test from "node:test";
import assert from "node:assert/strict";
import { isChromePartial, containsTwigSyntax, classifyTemplateFilename } from "./outputFiles.mjs";

test("isChromePartial is true for exactly the two shared-chrome fragment filenames", () => {
  assert.equal(isChromePartial("header.html"), true);
  assert.equal(isChromePartial("footer.html"), true);
});

test("isChromePartial is false for any other template filename", () => {
  assert.equal(isChromePartial("recipe-single.html"), false);
  assert.equal(isChromePartial("header-hero.html"), false);
  assert.equal(isChromePartial("shop.html"), false);
});

test("containsTwigSyntax detects both Twig delimiter forms", () => {
  assert.equal(containsTwigSyntax("<h1>{{ post.title }}</h1>"), true);
  assert.equal(containsTwigSyntax("{% for post in posts %}<p></p>{% endfor %}"), true);
});

test("containsTwigSyntax is false for plain static HTML", () => {
  assert.equal(containsTwigSyntax("<h1>About us</h1>"), false);
});

test("containsTwigSyntax treats null/undefined as empty rather than throwing", () => {
  assert.equal(containsTwigSyntax(null), false);
  assert.equal(containsTwigSyntax(undefined), false);
});

test("classifyTemplateFilename recovers the type name and variant from a -single file", () => {
  assert.deepEqual(classifyTemplateFilename("case-study-single.html"), {
    typeName: "case-study",
    variant: "single",
  });
});

test("classifyTemplateFilename recovers the type name and variant from an -archive file", () => {
  assert.deepEqual(classifyTemplateFilename("case-study-archive.html"), {
    typeName: "case-study",
    variant: "archive",
  });
});

test("classifyTemplateFilename treats a suffix-less file as a Woo structural page", () => {
  assert.deepEqual(classifyTemplateFilename("checkout.html"), {
    typeName: "checkout",
    variant: "structural",
  });
});

test("classifyTemplateFilename accepts an already-stripped slug as well as a filename", () => {
  assert.deepEqual(classifyTemplateFilename("case-study-single"), {
    typeName: "case-study",
    variant: "single",
  });
});
