# WPCanAI Twig & WooCommerce Reference

## Twig Functions Reference

**Scope:** This section documents WPCanAI-registered Twig functions (WordPress/WooCommerce helpers added by WPCanAI). It does not attempt to list all Twig core built-ins.

**Twig version:** WPCanAI vendors Twig 3.x (`twig/twig`). For the exact patch, check `vendor/twig/twig/src/Environment.php` (`Environment::VERSION`). Consult the Twig 3.x docs for built-in tags/filters/functions.

### WordPress Core
```twig
{{ wp_head() }}                          {# Required in <head> #}
{{ wp_footer() }}                        {# Required before </body> #}
{{ bloginfo('name') }}                   {# Site name #}
{{ bloginfo('description') }}            {# Site tagline #}
{{ language_attributes() }}              {# lang="en-US" #}
{{ body_class() }}                       {# Body CSS classes #}
{{ current_url() }}                      {# Current page URL #}
{{ is_current_url(menu_url) }}           {# Check if URL matches current page #}
{{ wp_nonce_field('action','name') }}    {# Security nonce #}
```

### Navigation
```twig
{% for item in get_menu('primary') %}
  <a href="{{ item.url }}"
     class="{{ item.active ? 'active' : '' }}"
     target="{{ item.target }}">
    {{ item.title }}
  </a>
{% endfor %}
```

- **Theme-independent locations (v1.25+).** WPCanAI registers `wpcanai_primary` and `wpcanai_footer` nav locations itself; render them with `get_menu('wpcanai_primary')` rather than the theme's `get_menu('primary')`. Presets create/tear these down via `settings.menus`.

### Archive pagination (WordPress + WooCommerce)

Use these for **main-query** archives so URLs respect **pretty permalinks**, CPT rewrites, and `/page/N/` (avoid hand-built `?paged=2` unless you know the site uses plain permalinks).

```twig
{# Unified: WC shop / product-category → woocommerce_pagination(); else → the_posts_pagination() #}
{{ wpcanai_pagination()|raw }}

{# WordPress core archive markup (category, tag, author, search, date, CPT archive) #}
{{ the_posts_pagination({ mid_size: 2, prev_text: 'Older', next_text: 'Newer' })|raw }}

{# Custom markup: paginate_links() with permalink-safe base (merges optional args) #}
{{ wpcanai_paginate_links({ type: 'list' })|raw }}

{# WooCommerce catalog only (same output as inside wpcanai_pagination on shop/category) #}
{{ wc_pagination()|raw }}
```

**WooCommerce URL shapes:** The main shop and product taxonomies use **permalink-style** pagination (same idea as `the_posts_pagination`). Product **shortcodes** such as `[products]` use the `product-page` query argument instead — do not assume shop Twig behaves like a shortcode loop.

**Context variables:** Prefer injected `posts` / `products` plus the `pagination` object (see below) instead of `wpcanai_get_posts_enriched` for the primary archive loop, unless you also pass `paged` and mirror core query rules. WPCanAI resolves the current index from both `paged` and `page` (the WooCommerce **shop Page** often receives `/shop/page/2/` via the `page` query var).

**Template variables:** If you mark `products` or `posts` as *required* in template settings, an **empty list** is still valid. Required means the variable is **present**, not that the array is non-empty.

### Data Queries
```twig
{# Query posts with enrichment #}
{% set posts = wpcanai_get_posts_enriched({
  'post_type': 'post',
  'posts_per_page': 6,
  'wpcanai_include': 'featured_image'
}) %}

{# Query taxonomy terms #}
{% set categories = wpcanai_get_terms_enriched('taxonomy=category&hide_empty=1') %}

{# Apply WordPress content filters (shortcodes, embeds, etc.) #}
{{ the_content(post.post_content)|raw }}

{# Execute a shortcode string #}
{{ shortcode('[woocommerce_cart]')|raw }}

{# Include another WPCanAI template (no args) #}
{{ wpcanai_template('template-slug') }}

{# Include another WPCanAI template and pass variables (component-style) #}
{{ wpcanai_template('product-card', {'product': product}) }}
```

### Media & Links
```twig
{{ media_url(media_id, 'full') }}        {# Media URL for an attachment and size #}
{{ image_attrs(media_id, {}) }}          {# Image with src, alt #}
{{ id_url(post_id) }}                    {# Permalink by ID #}
{{ post_url(post_id) }}                  {# Post permalink #}
{{ term_url(term_id) }}                  {# Term archive URL #}
{{ slug_url('shop') }}                   {# Page URL by slug #}
{{ slug_url('my-post', 'post') }}        {# Any post type URL by slug #}
```

### Internationalization (i18n)

Three families: **Polylang-only** helpers (`current_language()`, `language_switcher()`), the **WordPress gettext** family (`__`, `_x`, `_n`), and **WPCanAI native i18n** helpers (`t()`, `tmedia()`, `current_lang()`, `languages()`, `lang_url()`, plugin 1.22.0+) which need no extra plugin once languages are configured (WPCanAI → Translations, or `wpcanai-i18n-set-settings` over MCP). On native-i18n sites use `t()` for user-facing strings and `current_lang()` / `languages()` for switchers; `current_language()` falls back to `get_locale()` and `language_switcher()` returns `[]` without Polylang. Gettext strings without an explicit domain default to `wpcanai`.

```twig
{# Current language code — Polylang slug ('en','ms','...') or get_locale() fallback #}
{{ current_language() }}

{# Language switcher: array of items with url, slug, name, current, no_translation #}
{% for lang in language_switcher() %}
  <a href="{{ lang.url }}"
     class="{{ lang.current ? 'font-bold' : '' }}"
     hreflang="{{ lang.slug }}">
    {{ lang.name }}
  </a>
{% endfor %}

{# Translatable strings — domain defaults to 'wpcanai'. Pass a domain to use the active theme's. #}
{{ __('Add to cart') }}
{{ _x('Open', 'menu state', 'my-theme') }}
{{ _n('%d item', '%d items', cart.item_count)|format(cart.item_count) }}
```

```twig
{# --- WPCanAI native i18n (single-post string translation, plugin 1.22.0+) --- #}
{{ t('Shop now') }}                 {# translated via the site string table; passes through for the default language or unknown strings #}
{{ tmedia(123) }}                   {# attachment URL with per-language swap via the media map; falls back to the original id #}
{{ tmedia(123, 'large') }}          {# second arg = image size, default 'full' #}
{{ current_lang() }}                {# native current-language slug; the default-language slug (e.g. 'en') when native i18n is not configured #}
{% for lang in languages() %}       {# items: slug, native_name, hreflang, is_default, is_current, url #}
  <a href="{{ lang.url }}" hreflang="{{ lang.hreflang }}"
     class="{{ lang.is_current ? 'font-bold' : '' }}">{{ lang.native_name }}</a>
{% endfor %}
{{ lang_url('ms') }}                {# current URL localized to the given language (prefix added/stripped) #}
```

**Native vs Polylang:** `t()` reads the WPCanAI string table (managed on the Translations admin page / `wpcanai-i18n-*` MCP tools); `__()/_x()/_n()` are gettext. `current_language()` / `language_switcher()` are **Polylang-only** — on native-i18n sites use `current_lang()` / `languages()`. See SKILL.md → **Native string translation** for the full workflow.

**Polylang storage rules** (see SKILL.md → Multi-language section): `wpcanai_template` posts are translatable; `_canai_html/css/js/context/context_mode` are **copied** on translation; `_canai_layout` and `_canai_delegate_page_id` are **translated** (per-language IDs); the `template_type` taxonomy is **not** translatable.

**MCP `lang` contract** (plugin 1.8.6+): when Polylang is active, every MCP tool that targets a post or page (`list-templates`, `list-pages`, `read-meta`, `write-meta`, `replace-in-meta`, `create-template`, `resolve-content-id`, `scan`, `get-wc-page-ids`, `create-page`) requires a `lang` arg — calls without it return `WP_Error('lang_required')`. `read-meta` / `write-meta` additionally reject mismatched lang/post_id combinations with `WP_Error('lang_mismatch')` (no auto-translate). `create-template` / `create-page` accept `translation_of: <source_id>` to merge the new post into the source's translation group. Define `WPCANAI_MCP_LANG_OPTIONAL` in `wp-config.php` to bypass these checks. Media tools (`list-media`, `get-media`, `update-media`, `sideload-url`) are lang-exempt — attachments are language-neutral.

**SEO translation (native i18n, plugin 1.28.0+):** the same per-language content-override blob (`wpcanai-i18n-set-post-overrides` / `-set-term-overrides`) also accepts `seo_title` and `seo_description` (plain text) alongside `title`/`content`/`excerpt`/`name`/`description`. On a non-default-language frontend page these swap into whichever SEO plugin is active (Slim SEO or RankMath) — `<title>`, meta description, OG title/description, and `og:locale` all render in the current language; no-op with no override or on the default language. The SEO plugin's XML sitemap also gains `<xhtml:link rel="alternate" hreflang="…">` alternates per URL automatically (the Google-recommended multilingual sitemap form), driven by the same language list as the `<head>` hreflang tags. `wpcanai-i18n-get-content` returns `source.seo = { title, description }` — the default-language SEO copy read from the active SEO plugin, ready to translate before writing it back via `seo_title`/`seo_description`.

**Automatic SEO behaviors (native i18n, plugin 1.30.0+):** on non-default-language pages the bridge handles several things with no override:
- **Auto-derive** — when a post/term has no `seo_title`/`seo_description` override, `<title>` falls back to the translated `title` (post) / `name` (term) and the meta description to the translated `excerpt` (or, if empty, stripped `content`; term `description`), truncated to ≤160 chars on a word boundary. So set `seo_title`/`seo_description` only when the SEO copy must differ from the visible title/body.
- **Canonical + `og:url`** are rewritten to the current language's `/<lang>/`-prefixed URL, and WPCanAI suppresses emitting its own canonical when Slim SEO / RankMath is active (no duplicate canonical tags).
- **Redirects** keep the `/<lang>/` prefix, except WordPress system paths — `/wp-login.php`, `/wp-admin`, `/wp-json`, `/xmlrpc.php`, `/wp-cron.php`, `/wp-content`, `/wp-includes` — which are never prefixed.
- **`Article.headline`** in JSON-LD (Slim SEO `schema_graph`, RankMath `json_ld`) translates automatically, and on RankMath the plugin patches the sitemap `<urlset>` to declare `xmlns:xhtml` so the injected `<xhtml:link rel="alternate" hreflang="…">` alternates are valid XML (a RankMath-specific fix; Slim SEO needs no such patch).

**Global strings (native i18n, plugin 1.31.0+):** per-language site name, tagline, and archive/search/404 SEO title+description live in a separate store (option `wpcanai_i18n_global_strings`) because they aren't attached to any post. On a non-default frontend they drive `option_blogname` / `option_blogdescription` + `og:site_name`, plus the `<title>` and meta description of search, 404, and post-type-archive pages (archive contexts `search`, `404`, `post_type:<slug>`). Read/write them with `wpcanai-i18n-get-global-strings` / `wpcanai-i18n-set-global-strings` (see SKILL.md → Global strings). Term archives (category / tag) stay in per-term overrides.

### WooCommerce Functions
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

**`wc_hook($hook)`** lets allowlisted WooCommerce display hooks fire inside a custom page (WPCanAI renders outside the loop, so they otherwise never run). It is already safe HTML — do **not** add `|raw`. Default allowlist (all `woocommerce_`-prefixed): `before/after_single_product`, `before/after_single_product_summary`, `single_product_summary`, `product_meta_start/end`, `share`, `before/after_shop_loop`, `shop_loop`, `before/after_cart`, `checkout_before_customer_details`, `review_order_before_payment`. Product/loop globals are primed automatically; the hook name is the only argument. Mutation/lifecycle hooks (e.g. `woocommerce_checkout_order_processed`) are denied by default; extend with the `wpcanai_wc_hook_allowlist` PHP filter.

---

## WooCommerce Context Variables

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

### Common “component template” pattern
```twig
{# Component templates often receive variables via wpcanai_template('slug', {...}) #}
{% set p = product %}

<a href="{{ post_url(p.ID) }}">
  {{ p.post_title|raw }}
  {{ p.wc.price_html|raw }}
</a>
```

### Notes from real-world WPCanAI usage
- **Tailwind config placement**: if you’re using WPCanAI’s Tailwind injection on `wp_head`, set `tailwind.config = {...}` *after* `{{ wp_head() }}` in the layout `<head>` so Tailwind is present before configuration runs.
- **Design tokens**: a common pattern is defining CSS variables in layout `_canai_css` and mirroring them in `tailwind.config` (`colors.brand.*`, `fontFamily.*`) so template markup can stay purely utility-based.
- **Lucide icons**: calling `lucide.createIcons()` in layout `_canai_js` is a good default; if a component injects new Lucide markup at runtime (e.g. mobile menu), call `lucide.createIcons()` again after DOM changes.

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

On a single-product page taken over by WPCanAI (`wpcanai_render_full_page_frontend()`), the queried
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
- **`post.featured_image.*` does not exist on single-product pages.** That surface is only populated by `wpcanai_get_posts_enriched(..., wpcanai_include: 'featured_image')` — the loop path. `wpcanai_render_full_page_frontend()` enriches the single `post` with `wc_context: 'single'` only, so `post.featured_image` is undefined there; use `post.wc.featured_image` instead (see field list above).
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

### Shop / product category (WooCommerce archives)

Injected on template types **`shop`** and **`product-category`** (content resolves from the WooCommerce shop page; see SKILL).

```twig
products              {# Array of enriched product posts (main query or WPCanAI fallback) #}
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

### WordPress archives (category, tag, author, search, date, CPT)

Injected on template types **`category`**, **`tag`**, **`author`**, **`search`**, **`archive`** (includes custom post type archives). **Not** merged on `shop` / `product-category` (WooCommerce owns those).

```twig
posts                   {# Enriched posts for the current archive page #}
pagination.current_page
pagination.total_pages
pagination.total_posts
pagination.per_page

{# Same term helpers as before where applicable #}
current_category
current_tag
current_author
search_query
term
```

---

## Twig Comment Convention

**CRITICAL**: Always use Twig comments `{# #}` for section navigation in WPCanAI templates. Twig comments are stripped during rendering (zero output bloat) and serve purely as developer navigation aids in lengthy template code.

`_canai_html`, `_canai_css`, and `_canai_js` are all rendered through the same Twig engine before output. `{# #}` is equally valid in page-level JavaScript (`_canai_js`) and is stripped before the script reaches `wp_footer()`. Prefer `{# #}` over `/* */` for any comment naming internal services, snippet names, hook names, or architecture details.

**Do NOT use HTML comments `<!-- -->` for section labels** — those pollute the rendered HTML. The only acceptable HTML comment is one that must appear in the final output for a specific reason (e.g., conditional IE tags).

> **Security note.** Leftover HTML comments and unconverted JS `/* */` comments are visible to anyone who views page source. That is real reconnaissance surface — internal plugin/snippet names, backend topology, webhook chains, endpoint paths. Secret-shaped literals (API keys, tokens, private keys) in `_canai_*` meta are worse: they ship credentials to every visitor. Convert nav comments to `{# #}`; never put secrets in template meta. `wpcanai-scan` reports `leaky_comment` / `leaky_secret`; use the skill's **Comment / secret security sweep** recipe to clear them.

### When to Apply Comments

- **Always** comment every top-level `<section>`, `<main>`, `<aside>`, `<header>`, `<footer>`, `<nav>`
- **Always** comment major layout divisions (columns, grid areas, sidebar vs content)
- **Always** comment data query blocks (`{% set products = ... %}`)
- Comment nested sub-sections when the template is long (50+ lines)
- Comment non-obvious conditional blocks and loops

### Comment Patterns by Template Type

**Layout templates** — comment the document skeleton:
```twig
<!DOCTYPE html>
<html>
<head>
  {# Meta & Viewport #}
  {# Fonts #}
  {# Tailwind CSS Config #}
</head>
<body>
  {# Header Component #}
  {{ wpcanai_template('header-slug') }}

  {# Page Content #}
  {{ page_content }}

  {# Footer #}
  <footer>...</footer>
</body>
</html>
```

**Page templates** — comment each section of the page:
```twig
{# Main Content #}
<main>
  {# Section: Hero #}
  <section>...</section>

  {# Section: Features #}
  <section>
    {# Section Heading #}
    {# Two Column Layout #}
    <div>
      {# Left Column - Content #}
      {# Right Column - Image #}
    </div>
  </section>

  {# Section: Contact Form #}
  <section>
    {# Form Header #}
    {# Form #}
  </section>
</main>
```

**WooCommerce product templates** — comment UI regions:
```twig
{# Query product data #}
{% set products = wpcanai_get_posts_enriched(...) %}

{# Main Content: Product Detail #}
<main>
  {# Left Column: Gallery #}
  <section>
    {# Primary Image #}
    {# Gallery Images #}
  </section>

  {# Right Column: Product Info (Sticky) #}
  <aside>
    {# Breadcrumbs #}
    {# Product Header #}
    {# Description #}
    {# Tech Specs #}
    {# Add to Cart Form #}
  </aside>
</main>
```

**WooCommerce cart/checkout** — comment functional blocks:
```twig
{# Main Content #}
<main>
  {# Cart Items #}
  <div>
    {# Table Header #}
    {% for item in cart.items %}
      {# Item Row #}
    {% endfor %}
  </div>

  {# Sidebar Summary #}
  <aside>
    {# Order Totals (AJAX refreshable) #}
    {# Payment Methods #}
  </aside>
</main>
```

**Shop/archive templates** — comment filters and grid:
```twig
{# Query products and categories #}
{% set products = wpcanai_get_posts_enriched({...}) %}
{% set categories = wpcanai_get_terms_enriched('...') %}

{# Main Content Area #}
<main>
  {# Sidebar Filters (Sticky) #}
  <aside>
    {# Collection Info #}
    {# Filter: Category #}
    {# Filter: Color #}
    {# Filter: Size #}
  </aside>

  {# Product Grid #}
  <section>
    {# Item Count & Sort Bar #}
    {# Grid Layout #}
    <div>
      {# Sale badge #}
      {# Out of stock overlay #}
      {# Product image + gallery hover #}
    </div>
  </section>
</main>
```

### Comment Rules

1. **Use `{# #}` for ALL section comments** — never `<!-- -->` for navigation labels
2. **Indent comments** to match the HTML nesting level they describe
3. **Use `Section:` prefix** for top-level page sections: `{# Section: Hero #}`, `{# Section: Services #}`
4. **Use column labels** for multi-column layouts: `{# Left Column - Content #}`, `{# Right Column - Image #}`
5. **Label data queries** before the `{% set %}` block: `{# Query product data #}`
6. **Note AJAX-sensitive containers**: `{# Order Totals (AJAX refreshable) #}`
7. **Do NOT over-comment** — skip comments for self-evident single elements like a lone `<h1>` or `<p>`
