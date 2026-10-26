# WooCommerce store

Use this reference when the site sells with **WooCommerce** and the user wants its shop, product
category archives, product pages, cart, checkout, order-received or account pages designed in
CanAI. The workflow is in SKILL.md under **Store sites**; the tool specs (`wpcanai-get-wc-page-ids`,
`wpcanai-get-wc-css-reference`, `wpcanai-resolve-content-id`) and the scan findings are in SKILL.md's
tool reference. This file holds the template types, the Twig functions, the context and the styling
workflow.

**CanAI renders pages, WooCommerce owns commerce.** The support is on only while WooCommerce is
active: `wpcanai-get-wc-page-ids` is in your tool list then. Without it, no `wc_*` function or
WooCommerce tool exists. On a site that also sells with FluentCart, its pages keep their own `fct-*`
types: read [FLUENTCART.md](FLUENTCART.md) for those.

## Template types

### Endpoints

- **(v1.50.1) Endpoint types inherit their parent's template.** A WooCommerce endpoint claims a request only when a published template of that type exists; otherwise the request renders through the parent type (`checkout` for `order-received`/`order-pay`, `my-account` for the other eight). `resolve-content-id` mirrors that, so an endpoint with no template of its own reports the **parent's** template under template-body rather than a delegate page that can never render. Before v1.50.1 it reported that page, contradicting `wpcanai-scan`'s own `unreachable_content` warning about the same post.

## Twig functions

FluentCart's `fct_*` functions, `post.fct` and its shop context are in [FLUENTCART.md](FLUENTCART.md); none of the `wc_*` helpers or `cart.*` context below apply to a FluentCart page.
```twig
{{ wc_get_cart_url() }}                  {# Cart page URL #}
{{ wc_get_checkout_url() }}              {# Checkout page URL #}
{{ wc_shop_url() }}                      {# Shop page URL #}
{{ wc_price(amount) }}                   {# Format as currency #}
{{ wc_get_product(post_id) }}            {# Get WC_Product object #}
{{ wc_add_to_cart_form(wc_obj)|raw }}    {# Native add-to-cart form #}
{{ wc_print_notices()|raw }}             {# Validation messages #}
{{ wc_cart_totals()|raw }}               {# Cart totals table #}
{{ wc_checkout_form()|raw }}             {# Checkout shortcode #}
{{ wc_form_field(key, args, val)|raw }}  {# Form field (country/state) #}
{{ wc_update_cart_nonce() }}             {# Cart update nonce #}
{{ wc_pagination()|raw }}                {# Shop / product taxonomy catalog pagination #}
{{ wc_cart_block()|raw }}                {# Block Cart (opt-in; place ABOVE wp_footer) #}
{{ wc_checkout_block()|raw }}            {# Block Checkout (opt-in; place ABOVE wp_footer) #}
{{ wc_hook('woocommerce_after_single_product_summary') }}  {# Fire an allowlisted Woo display hook — renders third-party extensions #}

{# Common product pattern in templates #}
{% set wc = wc_get_product(post.ID) %}
{{ wc_price(wc.price) }}
```

**IMPORTANT**: Always use `|raw` filter for WooCommerce HTML outputs.

**Block Cart/Checkout (opt-in):** `wc_cart_block()` / `wc_checkout_block()` embed WooCommerce's modern block Cart/Checkout via `do_blocks`. The classic `wc_cart_totals()` / `wc_checkout_form()` remain the default. **Layout contract:** the helper output MUST appear **above** `wp_footer()` in the layout Twig — hydration data and JIT script enqueues print on `wp_print_footer_scripts`, so a block placed after `wp_footer()` will not hydrate. They render only on a real cart-bearing frontend request (not admin, REST, or `?wpcanai_preview=1`); on inert paths visitors get nothing and editors get a `wpcanai-notice`. Use these only on `cart` / `checkout` template types (styles are pre-enqueued and emoji scripts stripped for those types).

**`wc_hook($hook)`** lets allowlisted WooCommerce display hooks fire inside a custom page (CanAI renders outside the loop, so they otherwise never run). It is already safe HTML — do **not** add `|raw`. Default allowlist (all `woocommerce_`-prefixed): `before/after_single_product`, `before/after_single_product_summary`, `single_product_summary`, `product_meta_start/end`, `share`, `before/after_shop_loop`, `shop_loop`, `before/after_cart`, `checkout_before_customer_details`, `review_order_before_payment`. Product/loop globals are primed automatically; the hook name is the only argument. Mutation/lifecycle hooks (e.g. `woocommerce_checkout_order_processed`) are denied by default; extend with the `wpcanai_wc_hook_allowlist` PHP filter.

## Context

### Cart (available globally)
```twig
cart.item_count          {# Number of items #}
cart.is_empty            {# Boolean #}
cart.subtotal_html       {# Formatted subtotal — use |raw #}
cart.total_html          {# Formatted total — use |raw #}
cart.shipping_total_html {# Formatted shipping — use |raw, nullable #}
cart.needs_shipping      {# Boolean #}
cart.items               {# Array of cart items #}

{# Each cart item: #}
item.product.name
item.product.image
item.product.url
item.quantity
item.key                 {# Cart item key for forms #}
item.line_total_html     {# use |raw #}
item.remove_url
item.variation_label
```

### Component templates
```twig
{# Component templates often receive variables via wpcanai_template('slug', {...}) #}
{% set p = product %}

<a href="{{ post_url(p.ID) }}">
  {{ p.post_title|raw }}
  {{ p.wc.price_html|raw }}
</a>
```

### Product Enrichment (via wpcanai_get_posts_enriched with wpcanai_include=featured_image)
```twig
product.wc.price                {# Raw price #}
product.wc.regular_price
product.wc.sale_price
product.wc.price_html           {# use |raw #}
product.wc.sku
product.wc.is_on_sale           {# Boolean #}
product.wc.is_in_stock          {# Boolean #}
product.wc.stock_status
product.wc.product_url
product.wc.add_to_cart_url
product.wc.short_description
product.wc.featured_image       {# Product image URL #}
product.wc.gallery_images       {# Array of gallery image objects #}
product.wc.categories           {# Array with name, url #}
product.wc.currency_symbol      {# Currency symbol, e.g. "$" #}
product.wc.stock_quantity       {# Managed stock count, int or null #}
product.wc.add_to_cart_text     {# Add-to-cart button label #}
product.wc.gallery_ids          {# Array of gallery attachment IDs #}
product.featured_image.src      {# Featured image URL #}
product.featured_image.thumbnail
product.featured_image.medium
product.featured_image.large

{# Product attributes: taxonomy-backed “global attributes” (pa_*) are exposed two ways #}
product.wc.attributes.pa_allergen {# array of terms: [{name, slug}, ...] #}
product.wc.allergen               {# shorthand for pa_allergen (pa_ prefix stripped); check is defined #}

{# Rule of thumb: pa_color → product.wc.attributes.pa_color and product.wc.color #}
```

### Single-product `post.wc` (since 1.35.0)

On a single-product page taken over by CanAI (`wpcanai_render_full_page_frontend()`), the queried
`post` gets the **same** structured `wc` surface as loop-context `product.wc` above (built by the same
`PostEnricher::enrich_post()`), plus single-context-only fields. The bare `product` variable
(`WooCommerceContext`) is unchanged — `post.wc` is an additional, structured view of the same product,
useful when a single-product template only has `post` in scope (e.g. inside `wpcanai_template()` includes).

```twig
post.wc.name / post.wc.slug / post.wc.permalink / post.wc.type   {# type === product_type #}
post.wc.is_purchasable             {# Boolean #}
post.wc.rating                     {# Float average rating #}
post.wc.rating_count               {# Int count of ratings #}
post.wc.tags                       {# Array: {id, name, slug, url} #}

{# Float variants of the price strings — handy for math/comparisons without casting #}
post.wc.price_num
post.wc.regular_price_num
post.wc.sale_price_num

{# post.wc.attributes now includes BOTH taxonomy (pa_*) terms AND custom
   (non-taxonomy) text attributes defined on the product edit screen —
   same {name, slug} shape for both kinds #}
post.wc.attributes.pa_color        {# taxonomy attribute: [{name, slug}, ...] #}
post.wc.attributes.material        {# custom text attribute "Material: Cotton | Wool" → [{name: 'Cotton', slug: 'cotton'}, {name: 'Wool', slug: 'wool'}] #}

{# Single-product-only fields (absent on loop/archive product.wc): #}
post.wc.description                {# Full product description, get_description() #}
post.wc.single_add_to_cart_text   {# Single-page add-to-cart button label #}
post.wc.review_count               {# Int total review count #}
post.wc.variations                 {# Variable products only; {} for simple products #}
post.wc.variations.available       {# Array: {id, attributes, price, regular_price, price_html, is_in_stock, is_purchasable, image, sku} #}
post.wc.variations.attributes      {# get_variation_attributes() shape #}
post.wc.variations.default_attributes
```

**`post.wc.price_html` is pre-formatted WooCommerce HTML and is a plain string, not auto-safe Twig Markup — always print it with `|raw`: `{{ post.wc.price_html|raw }}`.** This applies to `product.wc.price_html` too.

**Single-product gotchas:**
- **`post.featured_image.*` does not exist on single-product pages.** That surface is only populated by `wpcanai_get_posts_enriched(..., wpcanai_include: 'featured_image')` — the loop path. `wpcanai_render_full_page_frontend()` enriches the single `post` with `wc_context: 'single'` only, so `post.featured_image` is undefined there; use `post.wc.featured_image` instead (see field list above). On typed `single-*` takeovers for non-product types (e.g. `single-post`, `single-service`) it **is** populated (1.60.0+).
- **`wc_add_to_cart_form()` expects a real `WC_Product`, not `post.wc`.** `post.wc` is a plain enriched data array/object built for Twig display, not the `WC_Product` instance WooCommerce's native add-to-cart template expects — passing it in (`wc_add_to_cart_form(post.wc)`) is wrong even where it doesn't error outright. On a single-product template, prefer calling **`wc_add_to_cart_form()` with no arguments**: when `is_product()` is true it auto-resolves the current product from `get_the_ID()`. Only pass an explicit argument (the result of `wc_get_product(id)`) when rendering add-to-cart for a *different* product than the one being viewed (e.g. inside a cross-sell loop).

**Native-i18n render behavior (v1.27+).** On a non-default-language URL: enriched `featured_image` resolves through the Translations-page MediaMap automatically (the per-language attachment, no `tmedia()` needed); and enriched loop posts have their `post_title`/`post_content`/`post_excerpt` swapped in-place from the current language's override blob, so `{{ p.post_title }}` / `{{ p.post_content }}` render translated inside loops. No-op when i18n is dormant or no override/mapping exists.

### Checkout
```twig
{# Payment gateways #}
{% for gateway in payment_gateways %}
  gateway.id, gateway.title, gateway.description, gateway.chosen
{% endfor %}

{# Shipping methods #}
{% for method in shipping_methods %}
  method.id, method.label, method.cost, method.cost_html, method.chosen
{% endfor %}

{# Customer billing fields #}
customer.billing_first_name, customer.billing_last_name
customer.billing_email, customer.billing_phone
customer.billing_address_1, customer.billing_city
customer.billing_postcode, customer.billing_country, customer.billing_state
```

## Shop and category archives

Injected on template types **`shop`** and **`product-category`** (content resolves from the WooCommerce shop page; see SKILL).

```twig
products              {# Array of enriched product posts (main query or CanAI fallback) #}
current_category      {# Current term object on taxonomy archives; may be null on main shop #}
term                  {# Queried object (term or other) #}
attribute_filters     {# Layered nav attribute metadata #}

{# Pagination (same shape as core archives; total_posts mirrors total_products) #}
pagination.current_page
pagination.total_pages
pagination.per_page
pagination.total_products   {# WC: count of products in the catalog query #}
pagination.total_posts      {# Alias of total_products for shared Twig across WC + core #}

{# Attribute filter structure: #}
attribute_filters.color.label
attribute_filters.color.terms   {# Array: name, url, count, is_active #}
```

### Pagination

When writing `_canai_html` for the **shop** or **product-category** delegate (or global WC templates), use injected `products` and `pagination`, and output `{{ wc_pagination()|raw }}` or `{{ wpcanai_pagination()|raw }}`.

```twig
{# WooCommerce catalog only (same output as inside wpcanai_pagination on shop/category) #}
{{ wc_pagination()|raw }}
```

**WooCommerce URL shapes:** The main shop and product taxonomies use **permalink-style** pagination (same idea as `the_posts_pagination`). Product **shortcodes** such as `[products]` use the `product-page` query argument instead — do not assume shop Twig behaves like a shortcode loop.

For `wpcanai_pagination()`, `the_posts_pagination()` and the shared `pagination` shape, see [REFERENCE.md](REFERENCE.md) → **Archive pagination**.

## Styling cart, checkout and account

CanAI's `wc_*` Twig helpers (`wc_checkout_form()`, `wc_cart_totals()`, the my-account endpoints) echo raw WooCommerce output whose HTML structure is otherwise invisible until a live page renders — and the order-received/order-pay pages additionally hide their details behind WooCommerce's guest email-verification gate, so you cannot simply view them. **Do not guess selectors.** Before styling any of these blocks:

1. Call `wpcanai-get-wc-css-reference` with the context you are styling (e.g. `{ "context": "order-received" }`).
2. Read `css_reference` — WooCommerce's own default rules for that context's selectors. **It is raw SCSS source, not compiled CSS**: Sass variables, mixins and `&` parent-refs arrive unresolved (e.g. `darken($secondary, 10%)`, `@include …`), so paraphrase the rules into real CSS rather than pasting them into `_canai_css`. Extracted from four stylesheets of the *installed* WooCommerce (`woocommerce.scss`, `woocommerce-layout.scss`, `woocommerce-smallscreen.scss`, `forms.scss`), so it stays correct across WooCommerce updates — re-call the tool rather than relying on remembered class names. Rules arrive wrapped in their true ancestor selector chain (e.g. `.woocommerce { table.shop_table { … } }`), so match the full chain for specificity. A rule wrapped in `@media only screen and (max-width: 768px)` came from `woocommerce-smallscreen.scss` and is mobile-only — WooCommerce applies that breakpoint in the enqueue, not the file, so don't treat it as unconditional.
3. Read the files in `template_files` (any file read, if you have filesystem access to the install) — they are the authoritative markup, with a theme override winning over WooCommerce's bundled copy, and paths are ABSPATH-relative. They include classes core ships but never styles (e.g. `.woocommerce-order-overview__order`/`__date`/`__total` on the thank-you page). If `templates_missing` is non-empty, the context map has drifted from the installed WooCommerce — its paths are context-relative (e.g. `order/order-details.php`), a deliberately different format from `template_files`, so the two lists cannot be set-compared.
4. Check `third_party_hooks`. Each entry (`{hook, priority, callback, file, is_third_party}`) is a plugin adding its own markup on that context (e.g. a delivery-slot plugin appending a table to the thank-you page) — read its `file` to learn the classes it emits before styling. Pass `"include_core": true` to get *every* callback on those hooks instead, WooCommerce's own included, each still carrying its `is_third_party` flag — useful when you want the full picture of what renders into the region, not just the third-party additions.
5. Write overrides scoped to those selectors into the page/template's `_canai_css` (via `wpcanai-write-meta`), matching the site's design system.

If `css_fallback` is `"full-file"`, selector extraction found nothing (a WooCommerce restructure) — the whole stylesheet was returned instead; grep it for the classes you saw in `template_files`.

This is read-only static analysis: nothing is rendered, and no order, cart, or customer data is read.
