import test from "node:test";
import assert from "node:assert/strict";
import {
  findTypeSection,
  parseFieldsAndTaxonomies,
  parsePostTypeSlug,
  parseContentModelForType,
} from "./contentModelFields.mjs";

// Real excerpt from runs/humanmade.com/CONTENT-MODEL.md (verbatim) — H2,
// bare-backtick-name heading style, a CPT type followed by custom fields,
// taxonomies, and a field-mapping table whose rows must NOT be mistaken for
// field/taxonomy rows.
const HUMANMADE_EXCERPT = `# CONTENT-MODEL.md — humanmade.com

Handoff document for the repeating page type detected on **humanmade.com**.

---

## \`case-study\`

### 1. Post type

| Attribute | Value |
|---|---|
| slug | \`case_study\` |
| Label (singular) | Case Study |
| Label (plural) | Case Studies |
| \`supports\` | \`title\`, \`editor\`, \`thumbnail\`, \`excerpt\` |
| \`has_archive\` | \`true\` (archive page exists at \`/work\`) |

### 2. Custom fields

| Field name | Type | Required? | Source |
|---|---|---|---|
| \`case_study_client_name\` | text | yes | \`main[1]\` heading level 2, text with the leading "About " stripped |
| \`case_study_client_bio\` | textarea | yes | \`main[1]\` paragraphs (all of them, joined) |
| \`case_study_client_url\` | url | yes | \`main[1]\` links[0].href |
| \`case_study_client_image\` | image | yes | \`main[1]\` images[0] |
| \`case_study_testimonial_quote\` | textarea | no | A paragraph ending in a closing curly quote |
| \`case_study_testimonial_attribution\` | text | no | The paragraph immediately following the testimonial quote |

### 3. Taxonomies

| Taxonomy | Hierarchical? | Required? | Source |
|---|---|---|---|
| \`case_study_industry\` | no | yes | \`main[0]\` heading level 3 "Industry" + the paragraph immediately after it |
| \`case_study_service\` | no | yes | \`main[0]\` heading level 3 "Services" + the paragraph immediately after it |

### 4. Field-mapping table

| Source (sample content.json) | Maps to |
|---|---|
| \`main[0]\` heading level 2 (case study title) | \`post_title\` |
| \`main[1]\` links[0] | \`case_study_client_url\` |

No \`woo:\` types were detected in this run.

---

## Implementation option A — Pods (free plugin)

All steps are in **wp-admin → Pods Admin → Add New**.
`;

// Real excerpt from runs/barefootbuttons.com/CONTENT-MODEL.md (verbatim) —
// H3, "name (\`kind\`)" heading style, a woo:product section whose "Product
// meta (leftovers)" table has the SAME 4-column shape as a CPT's Custom
// fields table but a different table caption, followed by a DIFFERENT
// type's section (cart) that must not leak into product's parsed fields.
const BAREFOOTBUTTONS_EXCERPT = `# Content model: barefootbuttons.com

Site: a live WooCommerce store.

---

### product (\`woo:product\`)

This is the real content model.

#### Native property mapping

| Source slot | Native WooCommerce property | Verified? |
|---|---|---|
| \`main[0]\` (hero) H1 | name (\`post_title\`) | Yes |

#### Product meta (leftovers)

| Field | Type | Required | Source |
|---|---|---|
| \`product_fit_diameter\` | text | no | \`main[0]\` (hero) heading level 6, first of the pair |
| \`product_dimensions\` | text | no | \`main[0]\` (hero) heading level 6, second of the pair |

#### Taxonomies

None new.

#### Field-mapping table

| Source slot | Maps to |
|---|---|
| \`main[0]\` H1 | \`post_title\` |

---

### cart (\`woo:cart\`)

No fields — WooCommerce owns this page (cart data, not authored content).
`;

// ---------------------------------------------------------------------------
// findTypeSection
// ---------------------------------------------------------------------------

test("findTypeSection finds an H2 backtick-only heading (humanmade.com style) and stops at the next H2", () => {
  const section = findTypeSection(HUMANMADE_EXCERPT, "case-study");
  assert.ok(section.startsWith("## `case-study`"));
  assert.ok(section.includes("### 4. Field-mapping table"));
  assert.ok(!section.includes("Pods Admin"), "must stop before the next H2 (Implementation option A)");
});

test("findTypeSection finds an H3 'name (`kind`)' heading (barefootbuttons.com style) and stops at the next H3, not at its own H4 sub-tables", () => {
  const section = findTypeSection(BAREFOOTBUTTONS_EXCERPT, "product");
  assert.ok(section.startsWith("### product (`woo:product`)"));
  assert.ok(section.includes("#### Product meta (leftovers)"), "H4 sub-tables must stay inside the H3 section");
  assert.ok(!section.includes("cart"), "must stop before the next H3 (### cart)");
});

test("findTypeSection returns null when the type isn't in the document at all", () => {
  assert.equal(findTypeSection(HUMANMADE_EXCERPT, "product"), null);
});

test("findTypeSection requires a whole-token match — 'case-study' must not match a heading about something else that merely contains the substring", () => {
  const md = "## `case-study-archive-notes`\n\nsome unrelated notes\n";
  // "case-study" is a substring of "case-study-archive-notes" but not a
  // standalone token (immediately followed by '-', not a boundary char).
  assert.equal(findTypeSection(md, "case-study"), null);
});

// ---------------------------------------------------------------------------
// parseFieldsAndTaxonomies
// ---------------------------------------------------------------------------

test("parseFieldsAndTaxonomies extracts every custom-field row from the real humanmade.com Custom fields table", () => {
  const section = findTypeSection(HUMANMADE_EXCERPT, "case-study");
  const { fields } = parseFieldsAndTaxonomies(section);
  assert.deepEqual(
    fields.map((f) => f.name),
    [
      "case_study_client_name",
      "case_study_client_bio",
      "case_study_client_url",
      "case_study_client_image",
      "case_study_testimonial_quote",
      "case_study_testimonial_attribution",
    ],
  );
  assert.deepEqual(fields.map((f) => f.type), ["text", "textarea", "url", "image", "textarea", "text"]);
  assert.deepEqual(fields.map((f) => f.required), [true, true, true, true, false, false]);
});

test("parseFieldsAndTaxonomies extracts both taxonomy rows, distinct from fields", () => {
  const section = findTypeSection(HUMANMADE_EXCERPT, "case-study");
  const { taxonomies } = parseFieldsAndTaxonomies(section);
  assert.deepEqual(taxonomies.map((t) => t.name), ["case_study_industry", "case_study_service"]);
  assert.deepEqual(taxonomies.map((t) => t.required), [true, true]);
});

test("parseFieldsAndTaxonomies never mistakes a Field-mapping-table row for a field or taxonomy (prose first cell, not a clean identifier)", () => {
  const section = findTypeSection(HUMANMADE_EXCERPT, "case-study");
  const { fields, taxonomies } = parseFieldsAndTaxonomies(section);
  const allNames = [...fields.map((f) => f.name), ...taxonomies.map((t) => t.name)];
  assert.ok(!allNames.includes("main[0]"), "the mapping table's prose 'source' cells must never be parsed as field names");
  assert.equal(fields.length, 6, "exactly the 6 real custom fields, nothing extra from the mapping table");
});

test("parseFieldsAndTaxonomies handles the woo:product 'Product meta (leftovers)' table (same 4-column shape, different caption) as fields, and stops before the sibling cart section", () => {
  const section = findTypeSection(BAREFOOTBUTTONS_EXCERPT, "product");
  const { fields, taxonomies } = parseFieldsAndTaxonomies(section);
  assert.deepEqual(fields.map((f) => f.name), ["product_fit_diameter", "product_dimensions"]);
  assert.deepEqual(fields.map((f) => f.type), ["text", "text"]);
  assert.deepEqual(fields.map((f) => f.required), [false, false]);
  assert.deepEqual(taxonomies, [], "barefootbuttons.com's product section declares no new taxonomies");
});

test("parseFieldsAndTaxonomies on an empty/whitespace-only section returns empty arrays (and no warnings), not a throw", () => {
  assert.deepEqual(parseFieldsAndTaxonomies(""), { fields: [], taxonomies: [], warnings: [] });
  assert.deepEqual(parseFieldsAndTaxonomies("   \n\n  "), { fields: [], taxonomies: [], warnings: [] });
});

test("parseFieldsAndTaxonomies de-duplicates a field name cited more than once (keeps the first)", () => {
  const section = [
    "## `x`",
    "### Custom fields",
    "| Field name | Type | Required? | Source |",
    "|---|---|---|---|",
    "| `foo` | text | yes | first citation |",
    "| `foo` | textarea | no | accidental re-citation |",
  ].join("\n");
  const { fields } = parseFieldsAndTaxonomies(section);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, "text");
});

// ---------------------------------------------------------------------------
// parsePostTypeSlug
// ---------------------------------------------------------------------------

test("parsePostTypeSlug reads the 'slug' row from the real humanmade.com Post type table", () => {
  const section = findTypeSection(HUMANMADE_EXCERPT, "case-study");
  assert.equal(parsePostTypeSlug(section), "case_study");
});

test("parsePostTypeSlug returns null for a woo:product section (no Post type table — items 1-4 are replaced by item 5)", () => {
  const section = findTypeSection(BAREFOOTBUTTONS_EXCERPT, "product");
  assert.equal(parsePostTypeSlug(section), null);
});

// ---------------------------------------------------------------------------
// parseContentModelForType — the one-call convenience wrapper
// ---------------------------------------------------------------------------

test("parseContentModelForType returns postTypeSlug + fields + taxonomies together for a real CPT section", () => {
  const parsed = parseContentModelForType(HUMANMADE_EXCERPT, "case-study");
  assert.equal(parsed.postTypeSlug, "case_study");
  assert.equal(parsed.fields.length, 6);
  assert.equal(parsed.taxonomies.length, 2);
});

test("parseContentModelForType returns null (not a throw, not an empty-but-truthy object) when the type has no section at all", () => {
  assert.equal(parseContentModelForType(HUMANMADE_EXCERPT, "nonexistent-type"), null);
});

test("parseContentModelForType works on the woo:product section too, with postTypeSlug null", () => {
  const parsed = parseContentModelForType(BAREFOOTBUTTONS_EXCERPT, "product");
  assert.equal(parsed.postTypeSlug, null);
  assert.deepEqual(parsed.fields.map((f) => f.name), ["product_fit_diameter", "product_dimensions"]);
});

// ---------------------------------------------------------------------------
// Tolerant parsing + loud failure (smittenkitchen.com dogfood, defect #2).
//
// The strict parser silently dropped EVERY field of a real run's
// CONTENT-MODEL.md because the authoring agent wrote natural annotations in
// the Required? column ("Yes (present, non-empty, in both samples)") and a
// 3-column taxonomy table — with zero warning anywhere. The fixture below
// reproduces that run's exact table shapes (verbatim rows, per the dogfood
// report and the run's own CONTENT-MODEL.md).
// ---------------------------------------------------------------------------

const SMITTENKITCHEN_NATURAL_EXCERPT = `# CONTENT-MODEL.md — smittenkitchen.com

## recipe

### 1. Post type

| Field | Value |
|---|---|
| slug | \`recipe\` |
| supports | \`title\`, \`editor\`, \`thumbnail\`, \`excerpt\` |
| rewrite | \`recipe/%postname%\` — **note**: the source site actually uses date permalinks. |

### 2. Custom fields

| Field name | Type | Required? | Source |
|---|---|---|---|
| \`recipe_servings\` | text | Yes (present, non-empty, in both samples) | \`main[0].lists[0]\` item 1 — e.g. "SERVINGS: 6" |
| \`recipe_time\` | text | Yes (present, non-empty, in both samples) | \`main[0].lists[0]\` item 2 |
| \`recipe_source\` | text | Yes (present, non-empty, in both samples) | \`main[0].lists[0]\` item 3 |
| \`recipe_ingredients\` | textarea (one ingredient per line) | Yes | \`main[0].lists[1]\` — a flat list of ingredient-line strings |

### 3. Taxonomies

| Taxonomy | Hierarchical? | Source |
|---|---|---|
| \`recipe_category\` | Yes | \`rel="category tag"\` links in \`dom.html\` on both samples, verified 2–3 levels deep |

### 4. Field-mapping table

| Source slot | Maps to |
|---|---|
| \`main[0].headings\` level-1 (lowercase title) | \`post_title\` |
| \`main[0].lists[0]\` items 1–3 | \`recipe_servings\`, \`recipe_time\`, \`recipe_source\` |
`;

test("dogfood repro: the smittenkitchen-style annotated Required? cells and 3-column taxonomy table — every one of which the strict parser silently dropped — now all harvest", () => {
  const parsed = parseContentModelForType(SMITTENKITCHEN_NATURAL_EXCERPT, "recipe");
  assert.equal(parsed.postTypeSlug, "recipe");
  assert.deepEqual(
    parsed.fields.map((f) => f.name),
    ["recipe_servings", "recipe_time", "recipe_source", "recipe_ingredients"],
  );
  assert.deepEqual(parsed.fields.map((f) => f.type), ["text", "text", "text", "textarea"]);
  assert.deepEqual(parsed.fields.map((f) => f.required), [true, true, true, true]);
  assert.deepEqual(parsed.taxonomies.map((t) => t.name), ["recipe_category"]);
  assert.deepEqual(parsed.warnings, [], "every row parses — nothing to warn about");
});

test("tolerant Required?/Hierarchical? cells: leading yes/no in any casing/decoration counts; prefix words like 'not' do NOT", () => {
  const section = [
    "| Field name | Type | Required? | Source |",
    "|---|---|---|---|",
    "| `a` | text | **Yes** | bolded |",
    "| `b` | text | `no` | code-quoted |",
    "| `c` | text | No — optional | dash annotation |",
    "| `d` | text | yes (title) | parenthetical |",
  ].join("\n");
  const { fields, warnings } = parseFieldsAndTaxonomies(section);
  assert.deepEqual(fields.map((f) => [f.name, f.required]), [
    ["a", true],
    ["b", false],
    ["c", false],
    ["d", true],
  ]);
  assert.deepEqual(warnings, []);

  // "not required" must not match /^no\b/ — under a recognized field table
  // the row survives (required defaults false) but WITH a loud warning.
  const notRequired = [
    "| Field name | Type | Required? | Source |",
    "|---|---|---|---|",
    "| `e` | text | not required | prefix word, not yes/no |",
  ].join("\n");
  const r2 = parseFieldsAndTaxonomies(notRequired);
  assert.deepEqual(r2.fields.map((f) => [f.name, f.required]), [["e", false]]);
  assert.equal(r2.warnings.length, 1);
  assert.match(r2.warnings[0], /`e`/);
  assert.match(r2.warnings[0], /must START with yes or no/);
  assert.match(r2.warnings[0], /assuming optional/);
});

test("tolerant Type cell: a parenthetical after the keyword is fine; a renamed type ('Plain Text') is not a keyword", () => {
  const section = [
    "| Field name | Type | Required? | Source |",
    "|---|---|---|---|",
    "| `ok` | textarea (one ingredient per line) | yes | fine |",
    "| `bad` | Plain Text | yes | Pods-speak, not a keyword |",
  ].join("\n");
  const { fields, warnings } = parseFieldsAndTaxonomies(section);
  assert.deepEqual(fields.map((f) => [f.name, f.type]), [["ok", "textarea"]]);
  assert.equal(warnings.length, 1, "the bad row must be skipped LOUDLY, never silently");
  assert.match(warnings[0], /skipped unparseable field-table row/);
  assert.match(warnings[0], /text\/textarea\/url\/image\/number\/date\/boolean\/repeater/);
  assert.match(warnings[0], /`bad`/, "the warning must quote the offending row");
});

test("loud skip: a field-table row whose first cell isn't a clean identifier is reported, not silently dropped", () => {
  const section = [
    "| Field name | Type | Required? | Source |",
    "|---|---|---|---|",
    "| the servings count (text) | text | yes | prose name cell |",
  ].join("\n");
  const { fields, warnings } = parseFieldsAndTaxonomies(section);
  assert.equal(fields.length, 0);
  assert.ok(warnings.some((w) => /first cell must be the backticked snake_case name/.test(w)));
});

test("loud zero-fields warning: a custom-fields table that yields no parseable rows always warns (rows all broken, or no rows at all)", () => {
  const allBroken = [
    "| Field name | Type | Required? | Source |",
    "|---|---|---|---|",
    "| `a` | string | yes | not a keyword |",
  ].join("\n");
  const r1 = parseFieldsAndTaxonomies(allBroken);
  assert.equal(r1.fields.length, 0);
  assert.ok(r1.warnings.some((w) => /ZERO parseable field rows/.test(w)));

  const emptyTable = ["| Field name | Type | Required? | Source |", "|---|---|---|---|"].join("\n");
  const r2 = parseFieldsAndTaxonomies(emptyTable);
  assert.ok(r2.warnings.some((w) => /ZERO parseable field rows/.test(w)));

  const emptyTaxTable = ["| Taxonomy | Hierarchical? | Required? | Source |", "|---|---|---|---|"].join("\n");
  const r3 = parseFieldsAndTaxonomies(emptyTaxTable);
  assert.ok(r3.warnings.some((w) => /ZERO parseable taxonomy rows/.test(w)));

  // No field/taxonomy table at all (e.g. a woo:cart section) — no warning:
  // there is nothing to have parsed.
  const noTables = "No fields — WooCommerce owns this page (cart data, not authored content).";
  assert.deepEqual(parseFieldsAndTaxonomies(noTables).warnings, []);
});

test("bare (unbackticked) names are accepted ONLY under a recognized field/taxonomy table header", () => {
  const underHeader = [
    "| Field name | Type | Required? | Source |",
    "|---|---|---|---|",
    "| recipe_servings | text | yes | author forgot the backticks |",
  ].join("\n");
  const r1 = parseFieldsAndTaxonomies(underHeader);
  assert.deepEqual(r1.fields.map((f) => f.name), ["recipe_servings"]);

  // The same row NOT under a recognized header must not parse (it could be
  // any other table's row — e.g. the Post type table's `| slug | ... |`).
  const noHeader = "| recipe_servings | text | yes | same row, no recognized table |";
  const r2 = parseFieldsAndTaxonomies(noHeader);
  assert.deepEqual(r2.fields, []);
  assert.deepEqual(r2.warnings, [], "rows outside recognized tables are not field rows — no noise about them");
});

test("outside a recognized table, the strict-equivalent guards still hold: a 3-cell yes/no row never fabricates a taxonomy from a post-type attribute", () => {
  // `| \`hierarchical\` | yes | <prose> |` in some other table must NOT
  // become a taxonomy named "hierarchical" — only a recognized taxonomy
  // table may use the 3-column (source-in-cell-3) form.
  const section = [
    "### Some other table (no recognized header)",
    "",
    "| `hierarchical` | yes | this CPT is hierarchical like pages |",
  ].join("\n");
  const { taxonomies, warnings } = parseFieldsAndTaxonomies(section);
  assert.deepEqual(taxonomies, []);
  assert.deepEqual(warnings, []);
});

test("the current on-disk dogfood taxonomy shape (3-column, recognized header) parses; required defaults to false", () => {
  const section = [
    "| Taxonomy | Hierarchical? | Source |",
    "|---|---|---|",
    "| `recipe_category` | Yes | rel=category-tag links |",
  ].join("\n");
  const { taxonomies, warnings } = parseFieldsAndTaxonomies(section);
  assert.deepEqual(taxonomies, [{ name: "recipe_category", required: false }]);
  assert.deepEqual(warnings, []);
});
