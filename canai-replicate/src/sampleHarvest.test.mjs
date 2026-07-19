import test from "node:test";
import assert from "node:assert/strict";
import {
  harvestPageData,
  harvestArchiveItems,
  harvestMenuItems,
  harvestWooProduct,
} from "./sampleHarvest.mjs";

// Minimal content.json builder — mirrors capture.mjs's real shape (verified
// against a real humanmade.com sample): top-level title/description, `main`
// array of sections each with headings[]/paragraphs[]/images[]/links[]
// (+ tables[]/labelValuePairs[]/definitionLists[] for the Woo tests).
function section(overrides = {}) {
  return {
    headings: [],
    paragraphs: [],
    images: [],
    links: [],
    tables: [],
    labelValuePairs: [],
    definitionLists: [],
    ...overrides,
  };
}

function cj({ title, description, main = [], url } = {}) {
  return { title, description, main, url };
}

const CASE_STUDY_SAMPLE = cj({
  title: "A decoupled, REST API-powered website for ustwo",
  description: "Creating a custom API for content delivery with a React frontend.",
  main: [
    section({
      headings: [{ level: 2, text: "A decoupled, REST API-powered website for ustwo" }, { level: 3, text: "Industry" }],
      paragraphs: ["Case study", "Creating a custom API for content delivery."],
      images: [{ src: "https://example.com/hero.jpg", alt: "hero" }],
    }),
    section({
      headings: [{ level: 2, text: "About ustwo" }],
      paragraphs: ["ustwo is a digital product agency.", "They build great things."],
      images: [{ src: "https://example.com/client.jpg", alt: "ustwo logo" }],
      links: [{ href: "https://www.ustwo.com/", text: "ustwo.com" }],
    }),
    section({
      headings: [{ level: 2, text: "The narrative body" }],
      paragraphs: ["Body paragraph one.", "Body paragraph two, longer, with more real detail in it."],
    }),
  ],
});

// ---------------------------------------------------------------------------
// harvestPageData
// ---------------------------------------------------------------------------

test("harvestPageData pulls post_title/post_excerpt from real headings/description, not fabricated text", () => {
  const data = harvestPageData({ contentJson: CASE_STUDY_SAMPLE, fields: [], taxonomies: [] });
  assert.equal(data.post_title, "A decoupled, REST API-powered website for ustwo");
  assert.equal(data.post_excerpt, "Creating a custom API for content delivery with a React frontend.");
});

test("harvestPageData builds post_content from main[1:] paragraphs (skips the hero) as real <p> tags", () => {
  const data = harvestPageData({ contentJson: CASE_STUDY_SAMPLE, fields: [], taxonomies: [] });
  assert.match(data.post_content, /<p>ustwo is a digital product agency\.<\/p>/);
  assert.match(data.post_content, /<p>Body paragraph one\.<\/p>/);
  assert.doesNotMatch(data.post_content, /Case study<\/p>/, "the hero section (main[0]) must not leak into post_content");
});

test("harvestPageData's featured_image uses the .src/.thumbnail/.medium/.large shape (built-in enrichment), from the first real image", () => {
  const data = harvestPageData({ contentJson: CASE_STUDY_SAMPLE, fields: [], taxonomies: [] });
  assert.equal(data.featured_image.src, "https://example.com/hero.jpg");
  assert.equal(data.featured_image.thumbnail, "https://example.com/hero.jpg");
});

test("harvestPageData: a 'text' field gets a real heading, a 'textarea' field gets a real paragraph, a 'url' field gets a real link href, an 'image' field gets the .url-shaped object", () => {
  const fields = [
    { name: "case_study_client_name", type: "text", required: true },
    { name: "case_study_client_bio", type: "textarea", required: true },
    { name: "case_study_client_url", type: "url", required: true },
    { name: "case_study_client_image", type: "image", required: true },
  ];
  const data = harvestPageData({ contentJson: CASE_STUDY_SAMPLE, fields, taxonomies: [] });
  // Real headings in document order: "A decoupled..." (hero), "Industry" (hero), "About ustwo", "The narrative body".
  assert.equal(data.fields.case_study_client_name, "A decoupled, REST API-powered website for ustwo");
  assert.equal(data.fields.case_study_client_bio, "Case study"); // first real paragraph in document order
  assert.equal(data.fields.case_study_client_url, "https://www.ustwo.com/");
  assert.ok(data.fields.case_study_client_image, "image field must be a real object, not null, when an image exists");
  assert.equal(data.fields.case_study_client_image.url, "https://example.com/hero.jpg");
  assert.equal(typeof data.fields.case_study_client_image.src, "undefined", "a Pods file field is .url-shaped, NOT .src-shaped (different from featured_image)");
});

test("harvestPageData: an 'image' field with no images anywhere in the sample is null (never a fabricated URL)", () => {
  const noImages = cj({ main: [section({ paragraphs: ["just text"] })] });
  const data = harvestPageData({ contentJson: noImages, fields: [{ name: "logo", type: "image", required: false }], taxonomies: [] });
  assert.equal(data.fields.logo, null);
});

test("harvestPageData: a 'repeater' field is an empty array (safe no-op in a Twig for-loop, not a guess)", () => {
  const data = harvestPageData({
    contentJson: CASE_STUDY_SAMPLE,
    fields: [{ name: "credits", type: "repeater", required: false }],
    taxonomies: [],
  });
  assert.deepEqual(data.fields.credits, []);
});

test("harvestPageData cycles the pool when there are more fields than real values of that type, rather than crashing or returning undefined", () => {
  const onePara = cj({ main: [section({ paragraphs: ["only paragraph"] })] });
  const fields = [
    { name: "a", type: "textarea", required: false },
    { name: "b", type: "textarea", required: false },
    { name: "c", type: "textarea", required: false },
  ];
  const data = harvestPageData({ contentJson: onePara, fields, taxonomies: [] });
  assert.equal(data.fields.a, "only paragraph");
  assert.equal(data.fields.b, "only paragraph"); // wraps around — still real text, not undefined
  assert.equal(data.fields.c, "only paragraph");
});

test("harvestPageData populates taxonomy_items as [{name, slug}] arrays, one real label per taxonomy", () => {
  const data = harvestPageData({
    contentJson: CASE_STUDY_SAMPLE,
    fields: [],
    taxonomies: [{ name: "case_study_industry", required: true }, { name: "case_study_service", required: true }],
  });
  assert.ok(Array.isArray(data.taxonomy_items.case_study_industry));
  assert.equal(data.taxonomy_items.case_study_industry.length, 1);
  assert.equal(typeof data.taxonomy_items.case_study_industry[0].name, "string");
  assert.ok(data.taxonomy_items.case_study_industry[0].name.length > 0);
});

test("harvestPageData never throws on a totally empty content.json", () => {
  const data = harvestPageData({ contentJson: {}, fields: [{ name: "x", type: "text", required: false }], taxonomies: [{ name: "y", required: false }] });
  assert.equal(data.post_title, "");
  assert.equal(data.featured_image, null);
  assert.equal(data.fields.x, "");
});

// ---------------------------------------------------------------------------
// harvestArchiveItems
// ---------------------------------------------------------------------------

test("harvestArchiveItems builds one lightweight post entry per sample, real title/excerpt/image, capped at max", () => {
  const items = harvestArchiveItems([CASE_STUDY_SAMPLE, CASE_STUDY_SAMPLE, CASE_STUDY_SAMPLE], 2);
  assert.equal(items.length, 2, "must respect the cap even when more samples are given");
  assert.equal(items[0].post_title, "A decoupled, REST API-powered website for ustwo");
  assert.equal(items[0].featured_image.src, "https://example.com/hero.jpg");
  assert.equal(items[0].ID, 1);
  assert.equal(items[1].ID, 2);
});

test("harvestArchiveItems on an empty list returns an empty array, not a throw", () => {
  assert.deepEqual(harvestArchiveItems([]), []);
  assert.deepEqual(harvestArchiveItems(undefined), []);
});

// ---------------------------------------------------------------------------
// harvestMenuItems
// ---------------------------------------------------------------------------

test("harvestMenuItems drops empty-text links (icon-only anchors) and dedupes identical (text,href) pairs", () => {
  const links = [
    { href: "https://x.com/", text: "" },
    { href: "https://x.com/about", text: "About" },
    { href: "https://x.com/about", text: "About" }, // duplicate
    { href: "https://x.com/work", text: "Work" },
  ];
  const items = harvestMenuItems(links);
  assert.deepEqual(items.map((i) => i.title), ["About", "Work"]);
  assert.equal(items[0].url, "https://x.com/about");
});

test("harvestMenuItems caps at `max` even when the real capture has a huge mega-menu (real-world humanmade.com header had ~90 raw link entries)", () => {
  const links = Array.from({ length: 90 }, (_, i) => ({ href: `https://x.com/${i}`, text: `Item ${i}` }));
  const items = harvestMenuItems(links, 10);
  assert.equal(items.length, 10);
});

test("harvestMenuItems returns the real {title,url,target,classes,active} shape get_menu() itself returns (TwigFactory.php)", () => {
  const items = harvestMenuItems([{ href: "https://x.com/about", text: "About" }]);
  assert.deepEqual(items[0], { title: "About", url: "https://x.com/about", target: "", classes: "", active: false });
});

test("harvestMenuItems on no links (or non-array input) is an empty array, not a throw", () => {
  assert.deepEqual(harvestMenuItems([]), []);
  assert.deepEqual(harvestMenuItems(null), []);
  assert.deepEqual(harvestMenuItems(undefined), []);
});

// ---------------------------------------------------------------------------
// harvestWooProduct
// ---------------------------------------------------------------------------

const PRODUCT_SAMPLE = cj({
  title: "Barefoot Buttons V2 Standard",
  main: [
    section({
      headings: [{ level: 1, text: "Barefoot Buttons V2 Standard" }],
      paragraphs: ["$9.95", "1 in stock"],
      images: [{ src: "https://example.com/product-1.jpg" }, { src: "https://example.com/product-2.jpg" }],
      labelValuePairs: [{ label: "SKU", value: "17-V2-ST-CR" }],
      tables: [{ pairs: [{ label: "Color", value: "Clear Acrylic" }, { label: "Size", value: "Standard" }] }],
    }),
  ],
  url: "https://barefootbuttons.com/product/v2-standard/",
});

test("harvestWooProduct pulls real name/price/sku/gallery/attributes from tables and labelValuePairs, not fabricated", () => {
  const wc = harvestWooProduct({ contentJson: PRODUCT_SAMPLE, leftoverFields: [] });
  assert.equal(wc.name, "Barefoot Buttons V2 Standard");
  assert.match(wc.price_html, /\$9\.95/);
  assert.equal(wc.sku, "17-V2-ST-CR");
  assert.deepEqual(wc.gallery_images, ["https://example.com/product-1.jpg", "https://example.com/product-2.jpg"]);
  assert.equal(wc.featured_image, "https://example.com/product-1.jpg");
  assert.equal(wc.attributes.color, "Clear Acrylic");
  assert.equal(wc.attributes.size, "Standard");
  assert.equal(wc.permalink, "https://barefootbuttons.com/product/v2-standard/");
});

test("harvestWooProduct: leftover 'Product meta' fields are harvested the same way a CPT's custom fields are", () => {
  const wc = harvestWooProduct({
    contentJson: PRODUCT_SAMPLE,
    leftoverFields: [{ name: "product_fit_diameter", type: "text", required: false }],
  });
  assert.equal(wc.fields.product_fit_diameter, "Barefoot Buttons V2 Standard"); // real heading, cycled from the pool
});

test("harvestWooProduct with no price found anywhere degrades to a clearly-synthetic $0.00, never crashes", () => {
  const noPrice = cj({ main: [section({ paragraphs: ["no price mentioned here"] })] });
  const wc = harvestWooProduct({ contentJson: noPrice, leftoverFields: [] });
  assert.match(wc.price_html, /\$0\.00/);
  assert.equal(wc.sku, "");
  assert.deepEqual(wc.gallery_images, []);
  assert.equal(wc.featured_image, null);
});
