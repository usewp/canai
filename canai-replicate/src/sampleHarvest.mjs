// Pulls REAL content out of a capture's content.json to fill Twig field
// slots for verify's Twig-render-and-score harness (twigRender.mjs) — real
// headings/paragraphs/images/links from the SAME sample, of the field's
// declared TYPE (from contentModelFields.mjs), not fabricated per-field text.
//
// This deliberately does NOT attempt CONTENT-MODEL.md's semantic mapping
// (e.g. "case_study_client_name is the heading with 'About ' stripped") —
// that's exactly the kind of page-by-page reading a human (or the LLM that
// wrote CONTENT-MODEL.md in the first place) does, not something a generic
// script can execute for an arbitrary site. What this guarantees instead:
// every harvested value is REAL text/image/link data pulled from the same
// sample the template is being scored against, of a length and shape
// consistent with its declared field type — enough to exercise the
// template's actual Twig (self-enrichment ordering, loops, `|raw` filters,
// missing-typography-plugin-class bugs, ...) and produce a meaningful pixel
// diff, without inventing content that was never on the page.

// Cycles through a pool, wrapping around; returns null when the pool is
// empty (never fabricates a placeholder string — an empty pool means
// "nothing on this page was that shape," which is itself real information,
// not a gap in this harvester).
function cycler(arr) {
  let i = 0;
  return () => (arr.length === 0 ? null : arr[i++ % arr.length]);
}

// Walks every content.json `main[]` section collecting headings/paragraphs/
// images/links in document order — the same fields content.json always
// carries per section (capture.mjs's own shape), regardless of the section's
// `role`. Deliberately flat/shape-agnostic: this harvester doesn't need to
// know which section is the hero vs. the narrative body, only "what real
// text/image/link material exists on this page, in order."
function collectMainPool(contentJson) {
  const headings = [];
  const paragraphs = [];
  const images = [];
  const links = [];
  for (const section of Array.isArray(contentJson?.main) ? contentJson.main : []) {
    for (const h of section?.headings ?? []) if (h?.text) headings.push(h.text);
    for (const p of section?.paragraphs ?? []) if (p) paragraphs.push(p);
    for (const im of section?.images ?? []) if (im?.src) images.push(im);
    for (const l of section?.links ?? []) if (l?.href) links.push(l);
  }
  return { headings, paragraphs, images, links };
}

// Shape mirrors PostEnricher::get_attachment_data() (wpcanai/src/Query/
// PostEnricher.php): {id, url, title, filename, mime_type, sizes, metadata}
// — this is what a Pods `image`-type CONTENT-MODEL.md field resolves to
// (`.url`, confirmed against the real plugin source), distinct from the
// built-in featured_image enrichment's `.src`/`.thumbnail`/`.medium`/`.large`
// shape (buildFeaturedImage below). Returns null for a missing image (a
// template testing `{% if item.fields.x.url %}` sees a falsy `.url`, same
// as the real plugin would for an unset field).
function toFileField(img) {
  if (!img?.src) return null;
  const filename = String(img.src).split("/").pop()?.split("?")[0] || "";
  return {
    id: 0,
    url: img.src,
    title: img.alt || "",
    filename,
    mime_type: "image/jpeg",
    sizes: {},
    metadata: {},
  };
}

// Shape mirrors the built-in featured_image enrichment
// (`.src`/`.thumbnail`/`.medium`/`.large`/`.wp_attachment_id`) — deliberately
// a DIFFERENT shape than toFileField's `.url`-based one above (verified
// against PostEnricher.php: these are two genuinely different code paths in
// the real plugin, not the same shape twice).
function buildFeaturedImage(img) {
  if (!img?.src) return null;
  return { src: img.src, thumbnail: img.src, medium: img.src, large: img.src, wp_attachment_id: 0 };
}

function firstNumber(text) {
  const m = String(text ?? "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// One field's harvested value, by its CONTENT-MODEL.md-declared type. Pulls
// from `pool` (real sample data); a field type that finds nothing in the
// pool degrades to an honestly-empty value ("", [], or a safe default) —
// never a fabricated string standing in for real content.
function harvestOneField(field, pool) {
  switch (field.type) {
    case "textarea":
      return pool.nextParagraph() ?? pool.nextHeading() ?? "";
    case "text":
      return pool.nextHeading() ?? pool.nextParagraph() ?? "";
    case "url":
      return pool.nextLink()?.href ?? "";
    case "image":
      return toFileField(pool.nextImage());
    case "number":
      return firstNumber(pool.nextParagraph() ?? pool.nextHeading() ?? "");
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "boolean":
      return true;
    case "repeater":
      // A grouped, multi-field repeating structure — safe-empty rather than
      // guessing at sub-field shapes generically; a template's {% for %}
      // over it renders nothing extra, never crashes.
      return [];
    default:
      return pool.nextParagraph() ?? pool.nextHeading() ?? "";
  }
}

// Full per-sample harvest for a CPT single/archive-card template: WordPress
// core slots (post_title/post_excerpt/post_content/featured_image) plus
// every CONTENT-MODEL.md field/taxonomy for this type, mapped onto
// `{ fields, taxonomy_items }` the same shape
// `wpcanai_get_posts_enriched(..., wpcanai_include: 'featured_image,fields,taxonomy_items')`
// would hand a real Twig template (transform-template.md's own documented
// contract).
export function harvestPageData({ contentJson, fields = [], taxonomies = [] }) {
  const raw = collectMainPool(contentJson);
  const pool = {
    nextHeading: cycler(raw.headings),
    nextParagraph: cycler(raw.paragraphs),
    nextImage: cycler(raw.images),
    nextLink: cycler(raw.links),
  };

  const post_title = raw.headings[0] ?? (typeof contentJson?.title === "string" ? contentJson.title : "") ?? "";
  const post_excerpt =
    (typeof contentJson?.description === "string" && contentJson.description) || raw.paragraphs[0] || "";
  // post_content: every paragraph from main[1:] (skip the hero/main[0],
  // already surfaced via title/excerpt) joined as real <p> tags — real
  // sample text, long enough for height-based scoring to mean something,
  // deliberately not de-duplicated against what fields/taxonomies also
  // harvest (harmless redundancy in a scoring render, not a correctness bug).
  const bodyParagraphs = (Array.isArray(contentJson?.main) ? contentJson.main.slice(1) : [])
    .flatMap((s) => s?.paragraphs ?? [])
    .filter(Boolean);
  const post_content = bodyParagraphs.map((p) => `<p>${p}</p>`).join("\n");
  const featured_image = buildFeaturedImage(raw.images[0] ?? null);

  const fieldValues = {};
  for (const f of fields) fieldValues[f.name] = harvestOneField(f, pool);

  const taxonomyItems = {};
  for (const t of taxonomies) {
    const label = pool.nextHeading() ?? t.name;
    taxonomyItems[t.name] = [{ id: 0, name: label, slug: slugify(label) }];
  }

  return {
    post_title,
    post_excerpt,
    post_content,
    featured_image,
    fields: fieldValues,
    taxonomy_items: taxonomyItems,
  };
}

// A handful of "posts" for an archive template's `{% for post in posts %}`
// card loop — one lightweight entry (title/excerpt/featured_image only, the
// documented archive-card contract per transform-template.md) per capture in
// `contentJsons`. Real per-sample data; if the archive type only has 1-2
// captured samples, the grid is just shorter than the live site's — still
// real, not fabricated filler.
export function harvestArchiveItems(contentJsons, max = 6) {
  return (Array.isArray(contentJsons) ? contentJsons : []).slice(0, max).map((cj, i) => {
    const raw = collectMainPool(cj);
    return {
      ID: i + 1,
      post_title: raw.headings[0] ?? (typeof cj?.title === "string" ? cj.title : `Item ${i + 1}`),
      post_excerpt: (typeof cj?.description === "string" && cj.description) || raw.paragraphs[0] || "",
      featured_image: buildFeaturedImage(raw.images[0] ?? null),
    };
  });
}

// get_menu()'s stub data (twigRender.mjs / render-harness.php): real
// {title,url} pairs harvested from a capture's content.json header/footer
// link inventory — a real site's header often captures a full mega-menu
// (60-90 links, including empty-text duplicates for icon-only anchors), so
// this dedupes by (text,href), drops empty-text entries, and caps at `max`
// so the rendered nav is realistic rather than either empty (misleadingly
// bad score) or a 90-link wall (misleadingly large mismatch).
export function harvestMenuItems(links, max = 10) {
  const seen = new Set();
  const items = [];
  for (const l of Array.isArray(links) ? links : []) {
    const title = String(l?.text ?? "").trim();
    const url = l?.href ?? "";
    if (!title || !url) continue;
    const key = title + "|" + url;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title, url, target: "", classes: "", active: false });
    if (items.length >= max) break;
  }
  return items;
}

// --- WooCommerce (woo:product) -------------------------------------------

function findLabelValue(contentJson, labelPattern) {
  for (const section of Array.isArray(contentJson?.main) ? contentJson.main : []) {
    for (const t of section?.tables ?? []) {
      for (const pair of t?.pairs ?? []) {
        if (pair?.label && labelPattern.test(pair.label)) return pair.value;
      }
    }
    for (const pair of section?.labelValuePairs ?? []) {
      if (pair?.label && labelPattern.test(pair.label)) return pair.value;
    }
    for (const dl of section?.definitionLists ?? []) {
      for (const pair of dl?.pairs ?? []) {
        if (pair?.label && labelPattern.test(pair.label)) return pair.value;
      }
    }
  }
  return null;
}

function findPriceText(contentJson) {
  for (const section of Array.isArray(contentJson?.main) ? contentJson.main : []) {
    for (const p of section?.paragraphs ?? []) {
      const m = String(p).match(/\$\s?\d+(\.\d{2})?/);
      if (m) return m[0];
    }
  }
  return null;
}

// post.wc.* for a woo:product single template (see transform-template.md's
// "WooCommerce template variables" — native properties are already free via
// the plugin's automatic single-product takeover, never self-enriched) plus
// any "Product meta (leftovers)" fields (the one case a woo:product type
// DOES get real CONTENT-MODEL.md fields — parsed the same way a CPT's
// custom fields are, via contentModelFields.mjs).
export function harvestWooProduct({ contentJson, leftoverFields = [] }) {
  const raw = collectMainPool(contentJson);
  const name = raw.headings[0] ?? (typeof contentJson?.title === "string" ? contentJson.title : "Product");
  const priceText = findPriceText(contentJson) ?? "$0.00";
  const sku = findLabelValue(contentJson, /sku/i) ?? "";

  const attributes = {};
  for (const section of Array.isArray(contentJson?.main) ? contentJson.main : []) {
    for (const t of section?.tables ?? []) {
      for (const pair of t?.pairs ?? []) {
        if (pair?.label) attributes[slugify(pair.label)] = pair.value;
      }
    }
  }

  const pool = {
    nextHeading: cycler(raw.headings),
    nextParagraph: cycler(raw.paragraphs),
    nextImage: cycler(raw.images),
    nextLink: cycler(raw.links),
  };
  const fieldValues = {};
  for (const f of leftoverFields) fieldValues[f.name] = harvestOneField(f, pool);

  const galleryImages = raw.images.map((im) => im.src);
  return {
    name,
    price_html: `<span class="woocommerce-Price-amount"><bdi>${priceText}</bdi></span>`,
    sku,
    stock_status: "instock",
    is_in_stock: true,
    is_purchasable: true,
    gallery_images: galleryImages,
    featured_image: galleryImages[0] ?? null,
    attributes,
    permalink: typeof contentJson?.url === "string" ? contentJson.url : "",
    fields: fieldValues,
  };
}
