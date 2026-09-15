import test from "node:test";
import assert from "node:assert/strict";
import { renderStructureMarkdown, extractStructureFromDoc } from "./structureDoc.mjs";
import { expectedFromContent, compareStructure } from "./verifyStructure.mjs";

const CONTENT = {
  title: "Pricing", description: "Plans and prices", lang: "en",
  header: { headings: [], paragraphs: [], lists: [], links: [{ text: "Home", href: "https://example.com/" }], images: [], videos: [], forms: [], buttons: [], tables: [] },
  main: [
    { id: "hero", role: "hero", tag: "section", headings: [{ level: 1, text: "Simple pricing" }], paragraphs: ["No surprises."], lists: [], links: [], buttons: ["Start free"], images: [{ src: "https://cdn.example.com/hero.png", alt: "Hero" }], videos: [], forms: [], tables: [] },
    { id: "section-2", role: "section", tag: "section", headings: [{ level: 2, text: "Compare plans" }], paragraphs: [], lists: [{ ordered: false, items: ["A", "B"] }], links: [], buttons: [],
      images: [], videos: [{ kind: "youtube", src: "https://www.youtube.com/embed/abc", title: "Demo", poster: null }],
      forms: [{ action: "/signup", method: "post", fields: [{ tag: "input", type: "email", label: "Email" }] }],
      tables: [{ caption: "Plans", headers: ["Plan", "Price"], rows: [["Free", "$0"]], pairs: null }] },
  ],
  footer: { headings: [], paragraphs: ["© Example"], lists: [], links: [], images: [], videos: [], forms: [], buttons: [], tables: [] },
};

test("renderStructureMarkdown: one numbered block per main section, header/footer blocks, media and slices listed", () => {
  const md = renderStructureMarkdown({
    slug: "pricing", url: "https://example.com/pricing/", content: CONTENT,
    sectionFiles: { hero: "sections/01-hero.png", "section-2": "sections/02-section-2.png" },
  });
  assert.match(md, /^# Pricing/m);
  assert.match(md, /^- url: https:\/\/example\.com\/pricing\//m);
  assert.match(md, /^## Header/m);
  assert.match(md, /^## 1\. hero \(hero, section\)/m);
  assert.match(md, /^- slice: sections\/01-hero\.png/m);
  assert.match(md, /^- h1: Simple pricing/m);
  assert.match(md, /^- button: Start free/m);
  assert.match(md, /^- image: https:\/\/cdn\.example\.com\/hero\.png — Hero/m);
  assert.match(md, /^## 2\. section-2 \(section, section\)/m);
  assert.match(md, /^- video: youtube https:\/\/www\.youtube\.com\/embed\/abc \(Demo\)/m);
  assert.match(md, /^- form: post \/signup — Email/m);
  assert.match(md, /^- table: Plans — Plan \| Price \(1 rows\)/m);
  assert.match(md, /^- list: A; B/m);
  assert.match(md, /^## Footer/m);
  assert.match(md, /^- p: © Example/m);
});

test("extractStructureFromDoc round-trips so compareStructure passes on a rendered doc", () => {
  const md = renderStructureMarkdown({ slug: "pricing", url: "https://example.com/pricing/", content: CONTENT, sectionFiles: {} });
  const actual = extractStructureFromDoc(md);
  assert.equal(actual.sections, 2);
  assert.deepEqual(actual.headings.map((h) => h.text), ["Simple pricing", "Compare plans"]);
  const cmp = compareStructure(expectedFromContent(CONTENT), actual);
  assert.equal(cmp.pass, true, JSON.stringify(cmp.missing));
});

test("extractStructureFromDoc detects a hand-deleted video line", () => {
  const md = renderStructureMarkdown({ slug: "pricing", url: "https://example.com/pricing/", content: CONTENT, sectionFiles: {} })
    .replace(/^- video: .*$/m, "");
  const cmp = compareStructure(expectedFromContent(CONTENT), extractStructureFromDoc(md));
  assert.deepEqual(cmp.missing.videos, ["https://www.youtube.com/embed/abc"]);
});
