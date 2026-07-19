# Task: page type → reusable Twig template(s) (canai-prepare format)

You are converting a captured **page type** into **one reusable Twig
template** — not a static page. Check **Kind** under "This type"/"This page"
below before you start; it puts you on one of two different tracks:

- **Repeating types** — `single:<cpt>`, `archive:<cpt>`, `woo:product`,
  `woo:product-loop`. N near-identical pages that all belong to one post
  type (or, for `woo:product`, WooCommerce's own `product` post type). You
  write ONE reusable Twig template that renders ANY item of that type,
  registered as a `wpcanai_template` post and bound to real pages purely by
  its `template_type` taxonomy term. Fields come from CONTENT-MODEL.md (for
  `woo:product`, "fields" means WooCommerce's own native properties plus any
  leftover post meta — see CONTENT-MODEL.md's Woo section). Follow
  **"Repeating templates"** below.
- **Woo structural pages** — `woo:shop`, `woo:cart`, `woo:checkout`,
  `woo:my-account`, `woo:order-received`, `woo:product-category`. ONE page
  that WooCommerce itself owns (cart contents, account forms, the shop
  grid). There is no post type, no "N items", no CONTENT-MODEL.md field
  contract — CONTENT-MODEL.md says so explicitly for these ("No fields —
  WooCommerce owns this page"). Follow **"Woo structural page templates"**
  below instead — do NOT apply the repeating-template instructions to these.

## What you must do

1. Read **CONTENT-MODEL.md** — find this type's section. For a repeating
   type, the post type slug, field names, and taxonomies there are the
   contract; never invent a field. For a Woo structural page, confirm it
   really is documented as "No fields" — if CONTENT-MODEL.md's section for
   this type instead lists real fields, STOP and treat it as a repeating
   type instead (the content model is the source of truth, not the `Kind`
   string).
2. Read each sample capture (screenshot + `sections/` + `content.json`) to
   learn the layout. The samples differ only in content; the template must
   render ANY of them correctly given its fields.
   - **`content.json`'s `tables` / `definitionLists` / `labelValuePairs`**
     carry content that never shows up as a plain paragraph or list — read
     them for every sample, not just headings/paragraphs/images/links. This
     is exactly how a WooCommerce product's **SKU** and **attributes**
     survive capture: a real sample's `hero.labelValuePairs` is
     `[{"label":"SKU","value":"17-V2-ST-CR"}, {"label":"Category","value":"V2"}]`,
     and its `tables[0]` is
     `{"pairs":[{"label":"Color","value":"Clear Acrylic"},{"label":"Size","value":"Standard"}]}`
     (a Color/Size attributes table). `pairs` (present when every row has
     exactly 2 cells) is a label/value fact — usually map it onto a native
     property or attribute per CONTENT-MODEL.md rather than render it as
     prose. `headers`+`rows` (3+ columns) is a real comparison/spec table —
     render it as `<table><thead>…`. `definitionLists` is `<dt>`/`<dd>`
     pairs — same "labeled fact" treatment as `labelValuePairs`. Don't drop
     any of these just because they aren't a heading or a `<p>`.
3. Read **DESIGN.md** and encode its tokens in the `tailwind.config` inline
   script, exactly as in the standard canai-prepare skeleton. If the
   template renders WordPress/WooCommerce-supplied HTML you don't control
   (`the_content()`, a Woo shortcode, `wc_cart_totals()`, `wc_checkout_form()`,
   …), load the Tailwind Typography plugin too
   (`?plugins=forms,container-queries,typography` on the CDN script) and
   wrap that output in a `prose` container — without it, that HTML renders
   with zero typographic styling.
4. Read each sample's **ux.json** and reproduce the listed patterns using the
   **exact, verbatim** recipes in the Alpine recipe library (path below) —
   copy the recipe's HTML structure and Alpine attributes as given,
   substituting only real content. Instant-state only — no transitions, no
   autoplay, and no invented alternative to a pattern a recipe already
   covers (e.g. a `window.innerWidth` check standing in for `nav-toggle`'s
   `lg:!block` — Alpine has no built-in reactivity to `window.innerWidth`,
   so that substitution silently stops updating across the breakpoint; a
   real bug this literal-recipe rule exists to prevent).
5. Write the **single template** and, if an archive capture is listed, the
   **archive template** — repeating types only. A Woo structural page never
   gets an archive template (it IS the one page); see "Woo structural page
   templates" below.

## Never write a Twig call's real syntax inside an HTML comment

Twig parses `{{ }}`/`{% %}`/`{# #}` delimiters wherever they appear in the
source text, HTML comment or not. A "helpful" comment explaining what
`{{ wpcanai_template('header') }}` does, written that way, is itself a
second real call Twig will execute — this is exactly how
`header.html`/`footer.html` (`transform-chrome.md`) triggered genuine
infinite self-recursion (a PHP memory-limit fatal error) the first time
either was rendered, not a hypothetical risk. Describe the include
mechanism in prose ("the wpcanai_template Twig helper") if you need to
document it at all — never quote its literal invocation syntax in a
comment inside the file you are writing.

## Site chrome (header/footer) is shared, never inlined

This applies to every track below — repeating single, repeating archive,
and Woo structural alike. Do **not** write your own `<header>`/`<footer>`
element. Immediately after this file's leading
`<!-- wpcanai-template: … -->` comment, emit `{{ wpcanai_template('header') }}`;
immediately before `</body>`, emit `{{ wpcanai_template('footer') }}`. These
two Twig partials are generated **once per site**
(`output/templates/header.html` / `footer.html` — see `transform-chrome.md`)
and shared by every one-off page and every page-type template — including
every template this prompt produces. Writing your own copy here is exactly
the drift bug this rule exists to prevent: on a real migration, a
`case-study-single` template and its own `case-study-archive` template —
same site, same nav — independently inlined the header and **disagreed**
with each other (different dropdown-menu counts, different link counts).
Navigation itself is WordPress-menu-driven (`get_menu('wpcanai_primary')` /
`get_menu('wpcanai_footer')`, inside the shared partials) rather than
hardcoded per-template links — that's `transform-chrome.md`'s job, not
yours; every template in this prompt only ever *includes* the two partials.

## template_type mapping — get this right or the template renders blank

WPCanAI binds a `wpcanai_template` post to real pages **purely by its
`template_type` taxonomy term** — there is no separate "which CPT"/"which
Woo page" field anywhere. The term you tag the template with in wp-admin
must be **exactly** what `TemplateResolver::resolve_current_template_type()`
returns for that request, or the template silently never binds (the page
falls through to the theme, or 404s under strict multilingual mode) — this
is a **silent production failure**, not a build error.

Here is that method's WooCommerce branch, verbatim
(`src/Templating/TemplateResolver.php`):

```php
if (function_exists('is_woocommerce')) {
    if (is_shop() || is_post_type_archive('product')) return 'shop';
    if (is_product_category() || is_product_tag() || is_tax('product_cat') || is_tax('product_tag')) return 'product-category';
    if (is_product()) return 'product';
    if (is_cart()) return 'cart';
    if (function_exists('is_order_received_page') && is_order_received_page()) return 'order-received';
    if (is_checkout()) return 'checkout';
    if (is_account_page()) return 'my-account';
}
```

This runs **before** the generic `single-{post_type}`/`archive-{post_type}`
branches, so it always wins on a WooCommerce URL. Read the term straight off
the table below — do not infer a pattern from the `single-<cpt>` convention
used elsewhere in this prompt, Woo is special-cased and most of its terms do
**not** follow that convention:

| `Kind` (pagetypes.json) | `template_type` term to tag the `wpcanai_template` with | Why |
|---|---|---|
| `single:<cpt>` | `single-<post_type_slug>` | Generic CPT single, existence-gated (only claims the URL once a published template with this term exists). `<post_type_slug>` comes from CONTENT-MODEL.md's "Post type" table — may differ from the classify-stage type name (`case_study` vs `case-study`). |
| `archive:<cpt>` | `archive-<post_type_slug>` | Generic CPT archive, same existence-gating. |
| `woo:product` | **`product`** | **NOT `single-product`.** `is_product()` is checked inside the WC block above, which returns *before* the generic `single-{post_type}` branch is ever reached — a template tagged `single-product` is unreachable dead weight; the resolver never emits that string on a WooCommerce build. Also confirmed by `ai/canai-mcp/SKILL.md`'s `get-wc-page-ids` tool doc, which lists `product` (not `single-product`) as a valid `type`. |
| `woo:shop` | `shop` | Covers BOTH the dedicated WooCommerce "Shop" page (`is_shop()`) AND the generic product post-type archive (`is_post_type_archive('product')`) — WPCanAI treats them as the exact same page/term. There is no `archive-product` term; **never** build a separate archive bundle for `woo:product` — if this site also has a `woo:shop` type, that capture already covers the product archive (you should never even be handed both — see "Fix 4" dedup in `src/transform.mjs` if you are). |
| `woo:product-category` | `product-category` | Covers BOTH product-category AND product-tag taxonomy archives (`is_product_category() \|\| is_product_tag() \|\| is_tax('product_cat') \|\| is_tax('product_tag')`) — ONE template serves every category and tag on the site, not one per term. |
| `woo:product-loop` | `product-loop` | Not resolved by the router directly — it's the per-product card partial a `shop`/`product-category` template includes once per product (`{{ wpcanai_template('product-loop', {'product': p}) }}` — no leading context argument, Twig injects that itself). |
| `woo:cart` | `cart` | |
| `woo:checkout` | `checkout` | |
| `woo:my-account` | `my-account` | |
| `woo:order-received` | `order-received` | |

Put the resolved term on the file's leading comment (see below) — e.g.
`template_type=product` for `woo:product`, `template_type=shop` for
`woo:shop`. **Never** write `template_type=single-product`,
`template_type=single-shop`, or any `single-`/`archive-`-prefixed term for a
`woo:*` kind other than the two rows above that actually use one.

## Repeating templates (`single:<cpt>`, `archive:<cpt>`, `woo:product`, `woo:product-loop`)

### Twig rules (single template)

- Start the `<body>` content with a machine-readable header comment:
  `<!-- wpcanai-template: template_type=<term from the mapping table above> -->`.
  This comment is documentation for the human/agent doing the WordPress-side
  setup, not something WPCanAI parses — the value that actually matters is
  the `template_type` **taxonomy term** you put on the `wpcanai_template`
  post once it's created in wp-admin.
- Immediately after that comment, `{{ wpcanai_template('header') }}`; last
  thing before `</body>`, `{{ wpcanai_template('footer') }}`. No inlined
  `<header>`/`<footer>` anywhere in this file — see "Site chrome is shared,
  never inlined" above.
- **`single:<cpt>`**: the `post` variable WPCanAI hands the template is a
  **bare `WP_Post`** — only native columns resolve (`post.ID`,
  `post.post_title`, `post.post_content`, `post.post_excerpt`,
  `post.post_name`). Custom fields, the featured image, and taxonomy terms
  are **not** attached automatically. Self-enrich once, near the top of the
  file — **above `<!DOCTYPE html>`** if anything in `<head>` (e.g.
  `<title>{{ item.post_title }}</title>`) also reads it, since `<head>`
  renders before `<body>`:
  ```twig
  {% set item = wpcanai_get_posts_enriched({
    'p': post.ID,
    'post_type': '<post_type_slug>',
    'wpcanai_include': 'featured_image,fields,taxonomy_items',
    'wpcanai_fields': ['<field_1>', '<field_2>'],
    'wpcanai_taxonomy': ['<taxonomy_1>']
  })|first %}
  ```
  List every CONTENT-MODEL.md field/taxonomy for this type in
  `wpcanai_fields` / `wpcanai_taxonomy` — anything left out never reaches
  the template. Then read every content slot off `item`, not the bare
  `post`:
  - `{{ item.post_title }}`, `{{ item.post_excerpt }}`,
    `{{ the_content(item.post_content)|raw }}` for the block-editor body
    (never bare `item.post_content` — `the_content()` applies WordPress's
    own content filters, e.g. shortcodes).
  - `{{ item.fields.<field_name> }}` — must match a CONTENT-MODEL.md field
    name exactly. Resolves whether the human implements CONTENT-MODEL.md's
    "Implementation option A" (Pods) or "option B" (Easy Code Manager /
    plain `register_post_meta()`, no Pods active) — WPCanAI 1.43.1+ falls
    back to raw post meta per-field whenever Pods doesn't define the field
    itself. Only on a destination site confirmed to run an older WPCanAI
    does option B's `fields.*` fail to populate — call that out as a
    `<!-- FIELD GAP -->` in that case, right next to the CONTENT-MODEL.md
    gaps, so it doesn't fail silently.
  - `{{ item.featured_image.src }}` (also `.thumbnail` / `.medium` /
    `.large` / `.wp_attachment_id`) — it's an object, never bare
    `item.featured_image` as if it were a URL string.
  - An `image`-type field from CONTENT-MODEL.md (e.g. a client-logo field,
    NOT the featured image) resolves differently:
    `{{ item.fields.<field_name>.url }}` — `.url`, not `.src` (a Pods file
    field returns `{id, url, title, filename, mime_type, sizes, metadata}`).
    Don't assume every image-shaped value uses the same key.
  - `{{ item.taxonomy_items.<taxonomy_name> }}` — a list of term objects;
    loop it: `{% for t in item.taxonomy_items.<taxonomy_name> %}{{ t.name }}{% endfor %}`.
- **`woo:product`**: the opposite of the CPT case above for every WooCommerce
  **native** property (price, SKU, stock, gallery, attributes, categories,
  …) — do **NOT** self-enrich `post` to get those. WPCanAI's single-product
  takeover already calls `enrich_post($post, ['wc_context' => 'single'])`
  before your template ever renders (`wpcanai.php`, the single-product
  takeover block), so `post` arrives with a `post.wc.*` surface already
  attached — see "WooCommerce template variables" below for the exact
  fields. A `wpcanai_get_posts_enriched({'p': post.ID, ...})` call here just
  re-fetches the same post and throws that free enrichment away.
  **Exception**: that automatic takeover call passes no `wpcanai_include`,
  so it stops before populating `post.fields` — if CONTENT-MODEL.md's
  "Product meta (leftovers)" table lists any custom fields (properties that
  don't map onto a native WooCommerce property, e.g. `product_fit_diameter`
  — Pods-extended onto the `product` post type, not a new CPT), those DO
  need one scoped self-enrich call, `wpcanai_include: 'fields'` only:
  ```twig
  {% set extra = wpcanai_get_posts_enriched({
    'p': post.ID,
    'post_type': 'product',
    'wpcanai_include': 'fields',
    'wpcanai_fields': ['<leftover_field_1>', '<leftover_field_2>']
  })|first %}
  ```
  then read `extra.fields.<leftover_field_name>` — never re-read price/SKU/
  etc. off `extra`, only the leftover field(s) that aren't already on
  `post.wc`. Skip this entirely when CONTENT-MODEL.md's product section has
  no leftovers table (barefootbuttons.com-style sites without one still
  read everything off the free `post.wc.*`).
- Repeating sub-blocks within a page (e.g. gallery images) use Twig `for`
  loops over the mapped field (`item.fields.<repeater_field>` for a CPT,
  `post.wc.gallery_images` / `post.wc.attributes.<key>` for a product).
- Everything else (semantic HTML5, Tailwind utilities inline, no `<style>`,
  Lucide icons, section comments, preview-libs markers) follows the standard
  canai-prepare boilerplate — same skeleton as the per-page transform prompt.

### WooCommerce template variables

The canonical, plugin-verified reference for every WooCommerce Twig function
and context variable WPCanAI exposes is listed under "Inputs" below
(`WooCommerce Twig variables reference`) — read it for the complete field
list, exact shapes, and the `|raw` rules for pre-formatted HTML. It is
already correct and kept in sync with the plugin source; don't re-derive
field names from scratch. The essentials, so you don't have to open it just
to get started:

- `post.wc.*` is present on `post` for a `woo:product` single template
  (always — see the self-enrichment note above) and on every item of
  `products` in a `shop`/`product-category` template (same fields, minus
  `description` / `single_add_to_cart_text` / `review_count` / `variations`,
  which are single-context only). Covers `.name`, `.price` / `.price_html`
  (use `|raw`) / `.price_num`, `.sku`, `.stock_status`, `.is_in_stock`,
  `.is_purchasable`, `.add_to_cart_url`, `.rating`, `.gallery_images`,
  `.categories`, `.tags`, and `.attributes` (both taxonomy `pa_*` attributes
  and custom per-product attributes, plus a `pa_`-stripped shorthand:
  `post.wc.attributes.pa_color` and `post.wc.color` are the same data).
- `wpcanai_pagination()` (`|raw`) auto-detects `shop`/`product-category` and
  calls WooCommerce's own `woocommerce_pagination()` — never hand-build
  page-N links for a Woo archive.
- `wc_add_to_cart_form()` (`|raw`) renders WooCommerce's own add-to-cart
  control, including variation selectors for a variable product — prefer it
  over hand-building the form.
- `wc_price(amount)`, `wc_get_cart_url()`, `wc_get_checkout_url()`,
  `wc_shop_url()` are always available when WooCommerce is active.

## Archive template (repeating types only, when requested)

- Header comment: `<!-- wpcanai-template: template_type=<archive term from the mapping table> -->`
  — `archive-<post_type_slug>` for `single:<cpt>`/`archive:<cpt>`, or `shop`
  for `woo:product` (see the mapping table — there is no `archive-product`).
- Same as the single template: `{{ wpcanai_template('header') }}` right
  after that comment, `{{ wpcanai_template('footer') }}` right before
  `</body>`, no inlined `<header>`/`<footer>` — this is the SAME site chrome
  the single template includes; an archive template that writes its own copy
  is exactly how a single/archive pair ends up disagreeing on nav (see "Site
  chrome is shared, never inlined" above).
- **CPT archive** (`archive:<cpt>`): the item loop is
  `{% for post in posts %} … {% endfor %}` around ONE item card; WPCanAI
  injects `posts` pre-enriched with `.featured_image` only, so
  `{{ post.post_title }}`, `{{ post.post_excerpt }}`, and
  `{{ post.featured_image.src }}` work directly inside the loop. A card
  showing a custom field or taxonomy chip needs the same self-enrichment
  pattern as the single template (per item, in the loop) — flag it as a
  `<!-- FIELD GAP -->` rather than guessing at a bulk-query shortcut.
- **`woo:product` archive**: this IS the `shop` page, not a separate archive
  concept — follow "Woo structural page templates" below for the
  `products`/`pagination` loop shape (the exact same shape a
  `product-category` template uses). Do not write a second,
  differently-shaped archive prompt for it, and do not expect to be handed
  both a `woo:product` archive sample and a `woo:shop` sample for the same
  capture — only one of them reaches you (see "Fix 4" dedup note above).
- Pagination: `{{ wpcanai_pagination()|raw }}` — this resolves WordPress-core
  vs. WooCommerce pagination markup itself (it checks the current
  `template_type` and calls `woocommerce_pagination()` for `shop`/
  `product-category`); don't hand-build page-N links or emit a bare
  `{{ pagination }}` placeholder.

## Woo structural page templates (`woo:shop`, `woo:cart`, `woo:checkout`, `woo:my-account`, `woo:order-received`, `woo:product-category`)

This is **one page**, not a repeating content type — WooCommerce renders
exactly one of these per site (the shop grid, the cart, the checkout flow,
the logged-in account area, the order thank-you page, one shared template
for every product category/tag). There is no post type, "N pages of this
type" does not apply, there is no CONTENT-MODEL.md field contract, no
`wpcanai_get_posts_enriched` self-enrichment, and no `{% for post in posts %}`
item loop keyed on a field contract. Write **one** Twig file —
`<!-- wpcanai-template: template_type=<term from the mapping table> -->` as
the first line of `<body>`, then `{{ wpcanai_template('header') }}` — then
build the page from the context variables below, reproducing the sample's
layout/copy the same way any other template does (DESIGN.md tokens,
Tailwind utilities, section comments), just without a per-item content
model, and close with `{{ wpcanai_template('footer') }}` right before
`</body>`. Same rule as every other track in this prompt: no inlined
`<header>`/`<footer>` — see "Site chrome is shared, never inlined" above. A
Woo structural page is still part of the same site as every CPT template and
one-off page; it must not carry a third, independently-drifting copy of the
nav.

The context vars below are populated by `WooCommerceContext`
(`src/Context/WooCommerceContext.php`) whenever the current request's
`template_type` matches — you don't fetch or query anything yourself. Full
field list: the "WooCommerce Twig variables reference" under Inputs below.

- **`shop` / `product-category`** — the product grid. `products` (array,
  each item has the same `post.wc.*` surface documented above, minus the
  4 single-only fields, plus `post.featured_image.{src,thumbnail,medium,large}`),
  `pagination` (`{current_page, total_pages, total_posts, per_page}`),
  `current_category` / `term` (the queried `WP_Term`; null on the plain shop
  page), `attribute_filters` (for a filter sidebar, if the sample has one):
  ```twig
  {% for p in products %}
    <a href="{{ p.wc.permalink }}">
      <img src="{{ p.featured_image.src }}" alt="{{ p.post_title }}">
      <h3>{{ p.post_title }}</h3>
      {{ p.wc.price_html|raw }}
    </a>
  {% endfor %}
  {{ wpcanai_pagination()|raw }}
  ```
  If the sample shows hand-authored intro copy above the grid (common on
  `shop` — CONTENT-MODEL.md will say so explicitly if present), that copy is
  `post_content` on WooCommerce's own "Shop" page, not a new field — render
  it as static copy transcribed from the sample (it's page chrome, not
  per-item content, so hardcoding it here is correct, not a gap).
- **`cart`** — `cart.item_count`, `.is_empty`, `.subtotal_html`, `.total_html`,
  `.shipping_total_html`, `.discount_total_html`, `.coupons` (`[{code,
  discount_html, remove_url}]`), `.items` (`[{key, product_id, quantity,
  product: {id, name, image, url}, variation_label, item_data_html,
  line_total_html, remove_url}]`). Loop `cart.items` for a hand-built table
  matching the sample's design. Helper functions: `wc_cart_totals()|raw`
  (WC's own totals/shipping-calculator/coupon-field box — usually the right
  call rather than hand-building it), `wc_print_notices()|raw` ("coupon
  applied"/error messages — put near the top of `<main>`),
  `wc_get_checkout_url()` for the "Proceed to checkout" link.
- **`checkout`** — `{{ wc_checkout_form()|raw }}` renders WooCommerce's own
  classic checkout (billing/shipping fields, payment gateways, place-order —
  fully wired). For a block-based checkout instead: `{{ wc_checkout_block()|raw }}`
  — this one MUST sit above `wp_footer()` in the layout template, or its
  assets won't hydrate. `customer.*` / `payment_gateways` / `shipping_methods`
  context vars exist if the sample's design genuinely can't be reproduced by
  the shortcode/block (rare — checkout has real validation/gateway logic
  behind it; prefer the helper).
- **`my-account`** — `{{ shortcode('[woocommerce_my_account]')|raw }}`,
  WooCommerce's own account shortcode; it internally handles the
  login/register/orders/downloads/addresses/edit-account/logout endpoints.
  There's no dedicated `wc_*` Twig helper for this one, use the generic
  `shortcode()` function.
- **`order-received`** — `order`, a `WC_Order` object, only set when
  `is_order_received_page()` AND the request has a valid `?key=` (**guard
  for null**: `{% if order %}`). Call its own methods, e.g.
  `order.get_order_number()`, `order.get_formatted_order_total()`,
  `order.get_items()`.

## Sample-fidelity check

Before finishing: mentally substitute sample #1's real content into your
template — the result must reproduce that sample's screenshot (layout and
copy placement, not pixels). If a visible content slot has no field (or, for
a Woo structural page, no matching context var above), STOP and flag the gap
at the top of the template file in an HTML comment `<!-- FIELD GAP: … -->`
instead of hard-coding sample text.
