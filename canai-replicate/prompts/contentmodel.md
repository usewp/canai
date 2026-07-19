# Task: extract CONTENT-MODEL.md (WordPress content-model handoff)

You are designing the WordPress content model for a site being migrated into
WPCanAI. The replica pipeline detected repeating page types; your job is to
define, for each type, the custom post type, custom fields, and taxonomies
that hold its content — as a **handoff document a human implements**. This
skill does NOT create CPTs or import content.

## Deliverable structure (write exactly these sections)

For **each type** in the input:

### `<type-name>`

1. **Post type** — table: slug (singular, `a-z_`), labels
   (singular/plural), `supports` (title/editor/thumbnail/excerpt as the
   content demands), `has_archive` (true when the type has an archiveUrl),
   `rewrite` slug matching the source URL pattern, `show_in_rest: true`
   (always — the templates and any future import need it).
2. **Custom fields** — table with columns: field name (snake_case, prefixed
   with the post-type slug, e.g. `team_member_role`), field type — one of
   `text`/`textarea`/`url`/`image`/`number`/`date`/`boolean`/`repeater`
   (`repeater` = a repeating GROUP of sub-fields, one row per repeating
   item, e.g. a staff credit's name + profile link + avatar together; use
   it only for a genuinely structured, multi-field repeating group shown in
   the samples — a plain list of strings is a `textarea` or belongs in
   `post_content`, not a repeater; document a repeater by its row shape,
   i.e. its own sub-fields and their types, not a single scalar type) —
   required?, and **source** — which part of the sample `content.json` it
   comes from (e.g. "main[0] heading level 2", "main[1] images[0]").
3. **Taxonomies** — only when the source clearly has them (category chips,
   filter bars). Same table treatment.
4. **Field-mapping table** — one row per visible content slot in the sample
   pages: source section id → field or core property (post_title,
   post_content, featured image, field name).
5. **`woo:<template_type>` types — ignore items 1–4 above; use this
   instead.** WooCommerce already ships the `product` post type plus
   `product_cat`/`product_tag`/`pa_*` (global attribute) taxonomies.
   **Never define a new CPT, and never re-register one of these — every
   product belongs to the ONE `product` post type WooCommerce already
   registers.** What you write depends on `<template_type>`:
   - **`product`** — the real content model, as two tables:
     - **Native property mapping**: one row per visible source slot, mapped
       onto an EXISTING WooCommerce product property, never a new field —
       name (`post_title`), description (`post_content`), short
       description (`post_excerpt`), regular price, sale price, SKU, stock
       status (in stock/out of stock/on backorder), gallery images, product
       categories (`product_cat` terms), product tags (`product_tag`
       terms). Map any distinguishing option (color, size, model, …) onto a
       WooCommerce **global product attribute** (a `pa_<name>` taxonomy) —
       name which existing `pa_*` term each sample value corresponds to;
       don't invent a custom taxonomy for something WooCommerce already
       models as an attribute. Check whether the option is actually global
       (a shared `pa_*` taxonomy, reused across products for filtering) or
       **local/custom** (defined on this product alone, stored as product
       meta, not a taxonomy) — the two look similar on the rendered page
       but are different WooCommerce features; say which one the samples
       show, don't assume. If price/SKU/stock clearly change per option
       (a size or color selector that changes the price, or a
       `data-product_variations` payload in the page), say the product is
       **variable** and note that each combination is a **product
       variation** — a child data row of the one product, created on its
       Variations tab — never a separate post or CPT.
     - **Product meta (leftovers)**: anything on the page that does NOT map
       onto a native property above becomes **post meta on the existing
       `product` post type** (same field name/type/required/source columns
       as item 2, including `repeater` when it fits). This is the only
       place a `product` type gets genuinely new fields.
     - Taxonomies: only for a taxonomy that's genuinely NEW (not
       `product_cat`/`product_tag`/an existing `pa_*`), attached to
       `product` — never a new post type.
     - Field-mapping table: same shape as item 4, but the right-hand column
       cites native properties/product-meta/taxonomy terms.
   - **`product-category`** — no new fields in the ordinary case:
     WooCommerce's own `product_cat` term already carries name, slug,
     description, and thumbnail. If the sample shows exactly those, say so
     and stop; only add term meta if the source clearly shows something
     term-level and extra (e.g. a banner image that isn't the term
     thumbnail).
   - **`product-loop`** — not a separate content type: it's the
     product-card partial the shop/category archives repeat per product,
     and every field it shows is already covered by `product` above. Say so
     in one line; do not re-document the same fields.
   - **`shop`** — the product archive/listing. No fields: the grid is
     WooCommerce's own product query rendering the `product-loop` partial.
     If the source shows hand-authored intro copy above the grid, that's
     `post_content` on WooCommerce's existing "Shop" page (a normal page,
     not a CPT) — note it as such, don't invent a field.
   - **`cart` / `checkout` / `my-account` / `order-received`** — **no
     content model.** These render session/order/account state that
     WooCommerce owns outright; there is nothing here for a human author to
     fill in. Write exactly one line for the type: "No fields — WooCommerce
     owns this page (cart/checkout/account/order data, not authored
     content)." Skip the custom-fields, taxonomies, and field-mapping
     tables entirely for these — an empty table only invites the
     speculative-field problem the rules below warn about.

## Table format (STRICT — keep it consistent and unambiguous)

CONTENT-MODEL.md is the handoff document a human (or agent) works from to
create the custom post types and fields on the destination WordPress site,
so every row has to be unambiguous. Nothing in the pipeline parses these
tables automatically any more: canai-replicate no longer renders templates
locally, so a malformed row will NOT be reported back to you. That makes
getting the format right at authoring time more important, not less — a
sloppy row becomes a wrong field on the real site, with nothing in between
to catch it. Write the two tables EXACTLY like this:

**Custom fields** (item 2, and a `woo:product` type's "Product meta
(leftovers)" table) — the header row must contain a "Field name" (or
"Field") column and a "Type" column:

| Field name | Type | Required? | Source |
|---|---|---|---|
| `team_member_role` | text | yes | main[0] heading level 3 |

**Taxonomies** (item 3) — the header row must contain a "Taxonomy" column
and a "Hierarchical?" column, and the SAME four-column shape (Required? is
its own column, never merged into Source):

| Taxonomy | Hierarchical? | Required? | Source |
|---|---|---|---|
| `team_member_department` | no | yes | filter-bar chips on every sample |

Per-cell rules:

- **Field/taxonomy name** — the bare snake_case identifier wrapped in
  backticks, and NOTHING else in the cell.
- **Type** — the cell must START with exactly one of
  `text`/`textarea`/`url`/`image`/`number`/`date`/`boolean`/`repeater`,
  lowercase. A short parenthetical AFTER the keyword is tolerated
  ("textarea (one ingredient per line)"), but a renamed type is not —
  "Plain Text", "string", and "Paragraph Text" are all unparseable.
- **Required? / Hierarchical?** — the cell must START with `yes` or `no`
  (any casing). A short annotation after it is tolerated ("Yes — present in
  both samples"), but the leading word must be yes/no: "present in both
  samples" or "not required" is unparseable. Put real nuance in the Source
  column or in prose under the table.
- Keep all four columns in this order. Extra columns AFTER Source are
  tolerated; a missing Required? column is not.

Then, ONCE at the end of the document:

Open the implementation section with this note (verbatim, or close to it —
substitute the destination site's actual WPCanAI version if it's known):
"Both options below are fully supported: WPCanAI 1.43.1+ resolves
`item.fields.<name>` (including an image/file field resolving to
`item.fields.<name>.url`) whether the field was defined as a Pods field
(option A) or registered via `register_post_meta()` (option B, no Pods
required) — `PostEnricher::get_post_fields()` falls back to raw post meta
per-field whenever Pods doesn't define that field itself. On a destination
site running an older WPCanAI, option B's fields render silently empty (no
error) — confirm the destination's WPCanAI version before relying on option
B, or upgrade first."

### Implementation option A — Pods (free plugin)

Numbered click-path instructions to create every CPT/field/taxonomy above in
**Pods Admin → Add New**, in order. Concrete: real field names, real types as
Pods calls them.

- **A `woo:product` type's product-meta fields** (never its native
  properties, which already exist): **Pods Admin → Add New → Post Type →
  "Extend Existing Content Type" → select Product (`product`)** — not "Add
  New Post Type". Add the leftover fields on that pod's own **Manage
  Fields** tab exactly like any other pod, then save. A genuinely new
  taxonomy for the product is a normal **Add New → Taxonomy** pod whose
  **Advanced Options** tab attaches it to the **`product`** post type (not a
  new one) — never re-create `product_cat`/`product_tag`/`pa_*`.
- **A `woo:cart`/`checkout`/`my-account`/`order-received` type**: nothing to
  create — there is no pod for a page with no fields.
- **A `repeater` field**: Pods' own per-field "Repeatable" toggle only
  repeats ONE field's value, not a grouped set of different sub-fields —
  when a row has more than one sub-field (the common case), model the
  repeating group as its own small related pod (e.g. `<type>_credit`)
  connected back to the parent via a bidirectional **Relationship** field;
  one child pod entry per repeating row, with the row's own sub-fields as
  that child pod's fields.

### Implementation option B — Easy Code Manager (PHP snippet)

One complete, paste-ready PHP snippet registering everything:
`register_post_type()`, `register_post_meta()` (with `show_in_rest`),
`register_taxonomy()` — hooked on `init`, prefixed functions, no closing
`?>`. It must be valid PHP that could be pasted into a new Easy Code Manager
snippet (or FluentSnippets) unchanged.

- **Never call `register_post_type('product', …)`** — WooCommerce already
  registers `product`; redeclaring it fatals. For a `woo:product` type the
  snippet contributes only `register_post_meta('product', $key, [...])`
  calls for the leftover (product-meta) fields, plus
  `register_taxonomy($new_tax, ['product'], […])` for a genuinely new
  taxonomy only. **Never re-register `product_cat`, `product_tag`, or an
  existing `pa_*` attribute taxonomy** — WooCommerce already owns those,
  and re-registering them can silently override their real args.
- **A `woo:cart`/`checkout`/`my-account`/`order-received` type contributes
  nothing to the snippet** — no function, no `add_action` call.
- **A `repeater` field** registers as one `register_post_meta()` call with
  `'single' => true`, `'type' => 'array'`, and a `show_in_rest` `schema`
  whose `items` is an `object` listing the row's own sub-field properties —
  the whole repeating group stores as one array-valued meta key, not one
  meta key per row.

## Rules

- Field names come from what the content IS, not what it looks like
  ("member_role", never "gray_subtitle").
- Every field must be traceable to the samples — no speculative fields.
- **Verify every claim about the samples before writing it down — don't
  eyeball once and generalize.** A statement like "the testimonial sits at
  `main[4]` in 2 of 3 samples" or "narrative sections: 2, 2, 3" is a factual
  claim about the actual `content.json` files: open each sample and
  check/count the specific thing before describing it, every time, even
  when it looks obvious. If you haven't verified it, don't assert it —
  state the conclusion instead of an invented statistic (e.g. "the
  testimonial's position varies across samples — do not assume a fixed
  index", not "in 2 of 3 samples, a different index in the third" unless
  you actually confirmed each sample's index). This document is a human's
  implementation instructions; a wrong "verified" fact costs them real
  debugging time.
- Keep it minimal: if a slot is always the post title, it's `post_title`,
  not a custom field.
- **A section that repeats verbatim (same heading, same body copy) across
  every sample of a type is shared template chrome, not content** — a
  "related posts" widget, a sitewide newsletter/contact CTA, a footer-style
  block. Compare the samples' `main[]` entries directly: if the heading text
  and paragraph text are identical across all of them, it renders from the
  template on every page of this type, not from this post's own data. Leave
  it out of the field-mapping table entirely (note it as excluded, don't
  invent a field for it).
- **When the number of content sections differs across samples, don't
  create one field per section index.** A field like
  `case_study_section_2_heading` breaks the moment one sample has a
  different section count than another — and real sites are inconsistent
  this way (an "About the client" or hero block that's genuinely fixed in
  every sample is still fine as scalar fields; a variable-length narrative
  body is not). Map that variable-length span to `post_content` (the block
  editor already exists for exactly this) and reserve custom fields for
  slots that occupy the same fixed position with the same shape in every
  sample. A recognizable repeating sub-pattern (e.g. a pull-quote plus an
  attribution line) can still become its own field even when the section
  *containing* it moves around — describe the source as the pattern itself
  ("the paragraph ending in a closing quote mark, plus the paragraph right
  after it"), not a fixed `main[n]` index, when the index isn't stable.
