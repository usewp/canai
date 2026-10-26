# CanAI Twig Reference

## Twig Functions Reference

**Scope:** This section documents CanAI-registered Twig functions. It does not attempt to list all Twig core built-ins. The store functions are in the store files: [WOOCOMMERCE.md](WOOCOMMERCE.md) (`wc_*`) and [FLUENTCART.md](FLUENTCART.md) (`fct_*`).

**Twig version:** CanAI vendors Twig 3.x (`twig/twig`). For the exact patch, check `vendor/twig/twig/src/Environment.php` (`Environment::VERSION`). Consult the Twig 3.x docs for built-in tags/filters/functions.

### WordPress Core
```twig
{{ wp_head() }}                          {# Required in <head> #}
{{ wp_footer() }}                        {# Required before </body> #}
{{ bloginfo('name') }}                   {# Site name #}
{{ bloginfo('description') }}            {# Site tagline #}
{{ language_attributes() }}              {# lang="en-US" — a full attribute #}
{{ body_class() }}                       {# class names only — NOT an attribute #}
{{ current_url() }}                      {# The URL the visitor asked for, without query; /ms/about/ on a translated page (v1.100.0) #}
{{ is_current_url(menu_url) }}           {# The same page in the current language: a raw or localized menu URL; trailing slash and query ignored #}
{{ wp_nonce_field('action','name') }}    {# Security nonce #}
```

**⚠ `body_class()` is not `language_attributes()`.** `language_attributes()` returns a whole
attribute (`lang="en-US"`), so `<html {{ language_attributes() }}>` is right. `body_class()` returns
bare class *names* (`logged-in admin-bar single postid-42`), so it must go **inside** a real
attribute:

```twig
<body class="{{ body_class() }}">                    {# correct #}
<body class="{{ body_class('my-own classes') }}">    {# correct — it takes extra classes #}
<body {{ body_class() }}>                            {# WRONG: each class parses as a valueless
                                                        attribute and is silently dropped #}
```

### Navigation
```twig
{% for item in get_menu('primary')|filter(i => i.depth == 0) %}
  <a href="{{ item.url }}"
     class="{{ item.active ? 'active' : '' }}"
     {% if item.target %}target="{{ item.target }}" rel="noopener"{% endif %}>
    {{ item.title }}
  </a>
  {% for child in item.children %}
    <a href="{{ child.url }}">{{ child.title }}</a>
  {% endfor %}
{% endfor %}
```

- **Two locations: `primary` and `footer` (plugin v1.88.0).** CanAI registers exactly these two nav locations itself, whatever the theme, and they are the only names `get_menu()` should be called with: a header loops `get_menu('primary')`, a footer `get_menu('footer')`. Their links are written with `wpcanai-write-menu`, never as hardcoded `<a href>` lists. Presets create/tear these down via `settings.menus`.
- **Items come out localised.** Each item is `{ title, raw_title, url, target, classes, active, children, id, parent, depth, description, raw_description, attr_title, icon, image }` (the last eight since v1.89.0). On a non-default language `title` and `description` are the string-store translations (the source when there is none) and an internal `url` carries the language prefix; `raw_title` / `raw_description` are always the source. On the default language they are exactly what WordPress stores. A language with its own menu (v1.89.0) renders that menu's text as written, URLs still prefixed.
- **The list is flat — filter the top level.** `get_menu()` returns every item, sub-items included, and each item also carries its `children`. Loop `get_menu('primary')|filter(i => i.depth == 0)` whenever the loop also renders `item.children`, or every sub-item appears twice (`wpcanai-scan`: `menu_children_twice`). `parent` is the parent item's `id` (`0` at the top level).
- **Rich items (v1.89.0).** `description` (a one-line blurb), `icon` (a Lucide name, `''` when none: `<i data-lucide="{{ item.icon }}"></i>`), `image` (an attachment id, `0` when none: `{{ image_attrs(item.image, 'src:thumbnail,alt') }}` / `{{ media_url(item.image, 'medium') }}`), `attr_title` (the link's title attribute). A **heading** — a dropdown trigger or mega-menu column title that is not a link — has `url: ''`: render `{% if item.url %}<a …>{% else %}<span …>{% endif %}`.
- **Upgrade note:** before v1.88.0 the locations were named `wpcanai_primary` / `wpcanai_footer`. `get_menu()` still resolves both names, and `wpcanai-scan` reports each call as `legacy_menu_location`; rename them to `primary` / `footer`.
- Read menus with `get_menu()`. A Template Variables menu query (`location=primary`) returns WordPress item objects; since v1.89.0, on a non-default language, they are copies whose `title` / `description` are translated and internal `url`s localised like `get_menu()`'s (`raw_title` / `raw_description` keep the source), and `location=` follows a language's own menu; on the default language they are WordPress's own objects, unchanged. It carries none of `get_menu()`'s `children` / `depth` / `icon` / `image` keys, so prefer `get_menu()` in templates.

### Archive pagination

Use these for **main-query** archives so URLs respect **pretty permalinks**, CPT rewrites, and `/page/N/` (avoid hand-built `?paged=2` unless you know the site uses plain permalinks).

```twig
{# Unified: WC shop / product-category → woocommerce_pagination(); else → the_posts_pagination() #}
{{ wpcanai_pagination()|raw }}

{# WordPress core archive markup (category, tag, author, search, date, CPT archive) #}
{{ the_posts_pagination({ mid_size: 2, prev_text: 'Older', next_text: 'Newer' })|raw }}

{# Custom markup: paginate_links() with permalink-safe base (merges optional args) #}
{{ wpcanai_paginate_links({ type: 'list' })|raw }}
```

`wpcanai_pagination()` also covers the stores' shop and category archives: see the store files, [WOOCOMMERCE.md](WOOCOMMERCE.md) and [FLUENTCART.md](FLUENTCART.md).

**Context variables:** Prefer injected `posts` / `products` plus the `pagination` object (see below) instead of `wpcanai_get_posts_enriched` for the primary archive loop, unless you also pass `paged` and mirror core query rules. CanAI resolves the current index from both `paged` and `page` (the WooCommerce **shop Page** often receives `/shop/page/2/` via the `page` query var).

**Template variables:** If you mark `products` or `posts` as *required* in template settings, an **empty list** is still valid. Required means the variable is **present**, not that the array is non-empty.

### Data Queries
```twig
{# Query posts with enrichment #}
{% set posts = wpcanai_get_posts_enriched({
  'post_type': 'post',
  'posts_per_page': 6,
  'wpcanai_include': 'featured_image,author'
}) %}

{# Query taxonomy terms #}
{% set categories = wpcanai_get_terms_enriched('taxonomy=category&hide_empty=1') %}

{# Apply WordPress content filters (shortcodes, embeds, etc.) #}
{{ the_content(post.post_content)|raw }}

{# Execute a shortcode string #}
{{ shortcode('[woocommerce_cart]')|raw }}

{# Include another CanAI template (no args) #}
{{ wpcanai_template('template-slug') }}

{# Include another CanAI template and pass variables (component-style) #}
{{ wpcanai_template('product-card', {'product': product}) }}
```

### Media & Links
```twig
{{ media_url(media_id, 'full') }}        {# Media URL for an attachment and size #}
{{ image_attrs(media_id, {}) }}          {# Image with src, alt #}
{{ id_url(post_id) }}                    {# Permalink by ID #}
{{ author_url(author_id) }}              {# Author's profile Website URL, or '' #}
{{ author_posts_url(author_id) }}        {# WordPress author archive URL #}
{{ post_url(post_id) }}                  {# Post permalink #}
{{ term_url(term_id) }}                  {# Term archive URL #}
{{ slug_url('shop') }}                   {# Page URL by slug; a child page too while only one page has the slug #}
{{ slug_url('gallery/auditorium') }}     {# Child page by path when the slug is shared; does not follow a move — prefer turl(id_url(id)) #}
{{ slug_url('my-post', 'post') }}        {# Any post type URL by slug #}
{{ turl('/') }}                          {# Home for the current language: https://site/ (default), https://site/ms/ (ms) #}
{{ turl('/contact/') }}                  {# Any site path, same rule #}
{{ turl(id_url(post_id)) }}              {# Any URL on this site; other hosts, mailto:, tel:, #anchor pass through #}
{{ turl('/', 'en') }}                    {# Explicit language — the switcher form #}
```

**`turl()` — internal links for the current language (plugin v1.88.0).** `turl(path_or_url)` is `home_url()` with the current language applied. On the default language it returns exactly the `home_url()` URL (any language prefix stripped, no query string), so a template written with it renders the same links a monolingual site does. On a non-default language it adds the prefix (`/ms/contact/`), never twice. `turl(path, lang)` targets one language and follows `lang_url()`'s switcher rule: on the default language it carries `?lang=<default>`, so the click also resets the visitor's language cookie. Use it only for a switcher. `slug_url()` localises the same way; `id_url()`, `post_url()` and `term_url()` return the plain permalink, so wrap them in `turl()`. Never build a prefix by hand (`home_url()` plus `current_lang()`, a `base` variable): `wpcanai-scan` reports it as `hardcoded_lang_prefix`.

### Charts (plugin v1.77.0)
```twig
{# Native chart — the Twig mirror of the write-post `chart` block type, same keys (snake_case) #}
{{ wpcanai_chart({
  chart: 'line',                                   {# bar | horizontal-bar | line | area | pie | doughnut | scatter | radar #}
  title: 'p95 latency',
  labels: ['Cold start', 'Warm', 'Cached'],
  datasets: [
    { label: 'v1.76', data: [120, 45, 12] },
    { label: 'v1.77', data: [98, null, 9] }        {# null = a gap; 1–8 datasets, pie/doughnut exactly 1 #}
  ],
  unit: 'ms',                                      {# suffix on ticks, tooltips and the table #}
  stacked: false,
  y_min: 0,                                        {# camelCase yMin / yMax are accepted too #}
  height: 320,                                     {# 160–800 px #}
  caption: 'Median of five runs',
  source: { text: 'Internal benchmark', url: 'https://example.com/bench' },
  table: 'collapsed'                               {# collapsed | open | hidden (screen readers + Markdown only) #}
}) }}

{# Scatter: points carry their own x, labels are ignored #}
{{ wpcanai_chart({ chart: 'scatter', datasets: [{ label: 'Sample', data: [{ x: 1, y: 2 }, { x: 3, y: 5 }] }] }) }}
```

- **Returns the figure HTML** — the same `<figure class="canai-chart" data-canai-chart="…">` the `canai/chart` block renders: title, `<canvas role="img">`, the data `<table>` inside `<details>`, and a `<figcaption>` with the source link. It is already safe HTML: no `|raw`.
- **Requests the runtime.** The call enqueues the vendored Chart.js 4.5.1 UMD build plus the `wpcanai-charts.js` mount script for the footer and prints the chart CSS once per request with the first figure, so under the default loader `auto` (Settings → Libraries → Chart.js) a page loads Chart.js only when it renders a chart. The layout must call `{{ wp_footer() }}`. With the loader on `no` the figure renders its table only, with an HTML comment `<!-- CanAI: Chart.js loader is off -->` in place of the canvas.
- **Validation is BlockBuilder's**, the same rules as `wpcanai-write-post`: kind allowlist, 1–8 datasets, pie/doughnut = 1, exactly one finite number (or `null`) per label, scatter `[{x, y}]`, `height` 160–800, `table` enum, `source.url` protocol, 64 KB cap on labels + datasets. **Invalid input returns an HTML comment** `<!-- CanAI wpcanai_chart(): <error> -->` instead of a figure (also logged under `WP_DEBUG`) — check view-source when a chart is missing.
- **Styling** is the plugin's, not the theme's: text and grid follow the figure's `currentColor`; the categorical palette is `--canai-chart-1` … `--canai-chart-8` on `.canai-chart` (dark values under `prefers-color-scheme: dark` and `.dark` / `[data-theme="dark"]` on `<html>`); plot height is `--canai-chart-h`. One `.canai-chart { … }` rule in `_canai_css` restyles every chart.
- **Dynamic markup.** After Alpine or fetch inserts a figure, dispatch `wpcanai:charts:mount` on the container so it mounts; `wpcanai:chart:config` (`detail: { el, attrs, config }`) fires on each figure before `new Chart()` for config tweaks.

**Raw Chart.js instead.** When a template needs something the block schema does not expose (dual axes, mixed types, plugins), set `wpcanai_chart_settings.load_chart` to `yes` (Settings → Libraries → Chart.js, or `wpcanai-update-settings { "settings": { "wpcanai_chart_settings": { "load_chart": "yes" } } }`) so the runtime loads on every CanAI page, put `<canvas id="bench"></canvas>` in `_canai_html`, and call `new Chart(document.getElementById('bench'), { type: 'bar', data: {…}, options: {…} })` in `_canai_js` — it prints on `wp_footer` after the enqueued footer scripts, so `window.Chart` is already defined. Under `auto` a page with no `wpcanai_chart()` call or chart block has no `window.Chart`. This path gives you no data table and no house styling — add both yourself, and keep the numbers in a real `<table>` so reader mode and Markdown consumers still get them.

### Internationalization (i18n)

Two families: the **WordPress gettext** family (`__`, `_x`, `_n`) and **CanAI native i18n** (`t()`, `tmedia()`, `current_lang()`, `languages()`, `lang_url()`, plugin 1.22.0+; `turl()`, plugin 1.88.0+ — see **Media & Links**), which needs no extra plugin once languages are configured (CanAI → Translations, or `wpcanai-i18n-set-settings` over MCP). Use `t()` for user-facing page strings and `current_lang()` / `languages()` for switchers. Gettext is for strings a theme or plugin already ships in its catalogue; strings without an explicit domain default to `wpcanai`.

```twig
{# Translatable strings — domain defaults to 'wpcanai'. Pass a domain to use the active theme's. #}
{{ __('Add to cart') }}
{{ _x('Open', 'menu state', 'my-theme') }}
{{ _n('%d item', '%d items', cart.item_count)|format(cart.item_count) }}
```

```twig
{# --- CanAI native i18n (single-post string translation, plugin 1.22.0+) --- #}
{{ t('Shop now') }}                 {# translated via the site string table; passes through for the default language or unknown strings #}
{{ t('Get <strong class="font-semibold">free shipping</strong> over {amount}.', {amount: threshold}) }}  {# v1.94.0: a whole sentence with inline tags; {placeholders} filled from the vars (escaped; href/src URL-escaped) #}
{{ tmedia(123) }}                   {# attachment URL with per-language swap via the media map; falls back to the original id #}
{{ tmedia(123, 'large') }}          {# second arg = image size, default 'full' #}
{{ current_lang() }}                {# native current-language slug; the default-language slug (e.g. 'en') when native i18n is not configured #}
{% for lang in languages() %}       {# items: slug, locale (WordPress locale or "", v1.92.0), native_name, hreflang, is_default, is_current, url #}
  <a href="{{ lang.url }}" hreflang="{{ lang.hreflang }}"
     class="{{ lang.is_current ? 'font-bold' : '' }}">{{ lang.native_name }}</a>
{% endfor %}
{{ lang_url('ms') }}                {# current URL localized to the given language (prefix added/stripped) #}
```

**Aliases (kept for existing templates):** `current_language()` returns the native current-language slug — `get_locale()` when native i18n is disabled. `language_switcher()` returns the configured languages as rows `{ slug, name, url, current, hreflang }` (`url` is the `lang_url()` of the current page) — `[]` when native i18n is disabled. Both read CanAI's own languages; write new templates with `current_lang()` / `languages()`.

```twig
{# Alias form — equivalent to the languages() loop above #}
{% for lang in language_switcher() %}
  <a href="{{ lang.url }}" hreflang="{{ lang.hreflang }}"
     class="{{ lang.current ? 'font-bold' : '' }}">{{ lang.name }}</a>
{% endfor %}
```

`t()` reads the CanAI string table (managed on the Translations admin page / `wpcanai-i18n-*` MCP tools); `__()/_x()/_n()` are gettext. Templates and pages are not scoped by language — one post per page serves every language, and the post-targeting MCP tools take no `lang` argument. See SKILL.md → **Native string translation** for the full workflow.

**From PHP (plugin 1.99.0+):** code outside Twig (snippets, form and SEO plugins) uses `wpcanai_current_language()`, `wpcanai_language_from_url( $url )` and `wpcanai_translate( $source, $vars = [], $lang = null )`, the PHP counterparts of `current_lang()` and `t()`. Unlike `current_lang()`, `wpcanai_current_language()` returns `null` where the language isn't known (admin, AJAX, REST however it is reached, cron, WP-CLI, WordPress system paths, before `setup_theme`) instead of the default. `wpcanai_translate()` returns plain text for a plain source (escape it) and HTML for one with inline tags. The filter `wpcanai_redirect_to_cookie_language` (`$redirect, $lang, $target`) turns off the cookie-language redirect. **(1.100.0)** `REQUEST_URI` carries the `/ms` prefix from `parse_request` on, `get_locale()` follows a language only where its `switch_locale` is on, and the action `wpcanai_language_detected` (`$lang`, `$request_uri`) fires once per front-end request at `setup_theme` when the language is known. Writing that PHP: the `canai-yolo` skill.

**Where a page's CSS/JS lives (plugin 1.78.0+):** to find where a page's CSS/JS actually lives (an empty `css` on a component is normal — styles are usually on its layout), call `read-meta` with `fields: ["asset_sources"]`. It returns the posts whose CSS/JS reach pages rendered through that post, in output order, one row per non-empty source: `{post_id, title, role, kind, lines, delivery}` — `role` is `self` / `layout` / `default_layout` / `parent_layout`, `kind` is `css` / `js`, `delivery` is `head` / `footer` / `inline`. It is not in the default field set and carries no `hashes`. `list-templates` / `list-pages` rows carry `css_lines` / `js_lines` for a quick scan (0 = none).

**SEO translation (native i18n, plugin 1.28.0+):** the same per-language content-override blob (`wpcanai-i18n-set-post-overrides` / `-set-term-overrides`) also accepts `seo_title` and `seo_description` (plain text) alongside `title`/`content`/`excerpt`/`name`/`description`. On a non-default-language frontend page these swap into whichever SEO plugin is active (Slim SEO or RankMath) — `<title>`, meta description, OG title/description, and `og:locale` all render in the current language; no-op with no override or on the default language. The SEO plugin's XML sitemap also gains `<xhtml:link rel="alternate" hreflang="…">` alternates per URL automatically (the Google-recommended multilingual sitemap form), driven by the same language list as the `<head>` hreflang tags. `wpcanai-i18n-get-content` returns `source.seo = { title, description }` — the default-language SEO copy read from the active SEO plugin, ready to translate before writing it back via `seo_title`/`seo_description`.

**Automatic SEO behaviors (native i18n, plugin 1.30.0+):** on non-default-language pages the bridge handles several things with no override:
- **Auto-derive** — when a post/term has no `seo_title`/`seo_description` override, `<title>` falls back to the translated `title` (post) / `name` (term) and the meta description to the translated `excerpt` (or, if empty, stripped `content`; term `description`), truncated to ≤160 chars on a word boundary. So set `seo_title`/`seo_description` only when the SEO copy must differ from the visible title/body.
- **Canonical + `og:url`** are rewritten to the current language's `/<lang>/`-prefixed URL, and CanAI suppresses emitting its own canonical when Slim SEO / RankMath is active (no duplicate canonical tags).
- **Redirects** keep the `/<lang>/` prefix, except WordPress system paths — `/wp-login.php`, `/wp-admin`, `/wp-json`, `/xmlrpc.php`, `/wp-cron.php`, `/wp-content`, `/wp-includes` — which are never prefixed.
- **`Article.headline`** in JSON-LD (Slim SEO `schema_graph`, RankMath `json_ld`) translates automatically, and on RankMath the plugin patches the sitemap `<urlset>` to declare `xmlns:xhtml` so the injected `<xhtml:link rel="alternate" hreflang="…">` alternates are valid XML (a RankMath-specific fix; Slim SEO needs no such patch).

**Global strings (native i18n, plugin 1.31.0+):** per-language site name, tagline, and archive/search/404 SEO title+description live in a separate store (option `wpcanai_i18n_global_strings`) because they aren't attached to any post. On a non-default frontend they drive `option_blogname` / `option_blogdescription` + `og:site_name`, plus the `<title>` and meta description of search, 404, and post-type-archive pages (archive contexts `search`, `404`, `post_type:<slug>`). Read/write them with `wpcanai-i18n-get-global-strings` / `wpcanai-i18n-set-global-strings` (see SKILL.md → Global strings). Term archives (category / tag) stay in per-term overrides.

---

## Context variables

### Notes from real-world CanAI usage
- **Tailwind config placement**: if you’re using CanAI’s Tailwind injection on `wp_head`, set `tailwind.config = {...}` *after* `{{ wp_head() }}` in the layout `<head>` so Tailwind is present before configuration runs.
- **Design tokens**: a common pattern is defining CSS variables in layout `_canai_css` and mirroring them in `tailwind.config` (`colors.brand.*`, `fontFamily.*`) so template markup can stay purely utility-based.
- **Lucide icons**: calling `lucide.createIcons()` in layout `_canai_js` is a good default; if a component injects new Lucide markup at runtime (e.g. mobile menu), call `lucide.createIcons()` again after DOM changes.

### Post author enrichment

Typed `single-*` takeovers automatically expose the queried post's author as `post.author`.
Queries can opt into the same surface with `wpcanai_include: 'author'` (or a comma-separated
combination such as `'featured_image,author'`). The value is a curated array, not a live
`WP_User` object:

```twig
post.author.id
post.author.display_name
post.author.user_url       {# Website field from the WordPress user profile #}
post.author.posts_url      {# WordPress author archive #}
post.author.description
post.author.avatar
```

Guard the surface for posts whose author account no longer exists. Profile text is escaped by
Twig unless the template explicitly applies `|raw`.

```twig
{% if post.author is defined %}
  <span>{{ t('By <a href="{url}">{name}</a>', {url: post.author.posts_url, name: post.author.display_name}) }}</span>
{% endif %}
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

### Blog index (Reading → "Posts page")

Injected on the page selected as **Posts page** (`is_home()`), which is an ordinary CanAI page — no template type, no `term`:

```twig
posts                   {# Enriched (featured_image) posts of the main query, paged #}
pagination.current_page
pagination.total_pages
pagination.total_posts
pagination.per_page
{{ the_posts_pagination()|raw }}   {# /blog/page/2/ works: the main query is already paged #}
```

---

## Twig Comment Convention

The authoritative, shared contract is [STRUCTURE-NAVIGATION.md](STRUCTURE-NAVIGATION.md). The examples below apply that contract to common CanAI template shapes.

**CRITICAL**: Structure navigation uses the exact single-line form `{# Type / Short Label #}`, for example `{# Section / Hero #}`. Twig comments are stripped during rendering (zero output bloat), while the editor's Structure metabox displays only comments that follow this convention.

The controlled structure vocabulary is: `Layout`, `Container`, `Header`, `Footer`, `Navigation`, `Section`, `Sidebar`, `Card`, `Form`, `Menu`, `Search`, `Button`, `Input`, `Icon`, `Badge`, `Accordion`, `Alert`, `Carousel`, `Dialog`, `Drawer`, `Steps`, `Tabs`, and `Toast`. Keep the label at 60 characters or fewer. The type communicates the reusable UI role; the label identifies this instance. Use a reusable UI pattern type only for the complete component, not for its internal controls or panels.

Landmark types are fixed: `<main>` → `Container`, `<section>` → `Section`, `<header>` → `Header`, `<footer>` → `Footer`, `<nav>` → `Navigation`, and `<aside>` → `Sidebar`. Put the navigation comment immediately before the opening tag. `wpcanai-scan` reports `missing_structure_comment` or `invalid_structure_comment` when this contract is not met.

`_canai_html`, `_canai_css`, and `_canai_js` are all rendered through the same Twig engine before output. Ordinary programming notes use `{# @dev Explain the implementation #}`; they remain in code but do not clutter the Structure metabox. `{# #}` is equally valid in page-level JavaScript (`_canai_js`) and is stripped before the script reaches `wp_footer()`. Prefer it over `/* */` for any comment naming internal services, snippet names, hook names, or architecture details.

**Do NOT use HTML comments `<!-- -->` for section labels** — those pollute the rendered HTML. The only acceptable HTML comment is one that must appear in the final output for a specific reason (e.g., conditional IE tags).

> **Security note.** Leftover HTML comments and unconverted JS `/* */` comments are visible to anyone who views page source. That is real reconnaissance surface — internal plugin/snippet names, backend topology, webhook chains, endpoint paths. Secret-shaped literals (API keys, tokens, private keys) in `_canai_*` meta are worse: they ship credentials to every visitor. Convert nav comments to `{# #}`; never put secrets in template meta. `wpcanai-scan` reports `leaky_comment` / `leaky_secret`; use the skill's **Comment / secret security sweep** recipe to clear them.

### When to Apply Comments

- **Always** put the matching `{# Type / Short Label #}` immediately before every `<section>`, `<main>`, `<aside>`, `<header>`, `<footer>`, and `<nav>`
- **Always** comment major layout divisions (columns, grid areas, sidebar vs content)
- **Always** add an `@dev` note for non-obvious data query blocks (`{% set products = ... %}`)
- Comment nested sub-sections when the template is long (50+ lines)
- Comment non-obvious conditional blocks and loops

### Comment Patterns by Template Type

**Layout templates** — comment the document skeleton:
```twig
<!DOCTYPE html>
<html>
<head>
  {# Container / Document Head #}
  {# @dev Configure metadata, fonts, and Tailwind here #}
</head>
<body>
  {# Header / Site #}
  {{ wpcanai_template('header-slug') }}

  {# Container / Page Content #}
  {{ page_content }}

  {# Footer / Site #}
  <footer>...</footer>
</body>
</html>
```

**Page templates** — comment each section of the page:
```twig
{# Container / Main Content #}
<main>
  {# Section / Hero #}
  <section>...</section>

  {# Section / Features #}
  <section>
    {# Container / Section Heading #}
    {# Container / Two Columns #}
    <div>
      {# Container / Content #}
      {# Container / Image #}
    </div>
  </section>

  {# Section / Contact Form #}
  <section>
    {# Header / Form #}
    {# Form / Contact #}
  </section>
</main>
```

**WooCommerce product templates** — comment UI regions:
```twig
{# @dev Query product data #}
{% set products = wpcanai_get_posts_enriched(...) %}

{# Container / Product Detail #}
<main>
  {# Section / Product Gallery #}
  <section>
    {# Container / Primary Image #}
    {# Container / Gallery Images #}
  </section>

  {# Sidebar / Product Information #}
  <aside>
    {# Navigation / Breadcrumbs #}
    {# Header / Product #}
    {# Section / Description #}
    {# Section / Specifications #}
    {# Form / Add to Cart #}
  </aside>
</main>
```

**WooCommerce cart/checkout** — comment functional blocks:
```twig
{# Container / Cart #}
<main>
  {# Section / Cart Items #}
  <div>
    {# Header / Cart Table #}
    {% for item in cart.items %}
      {# Card / Cart Item #}
    {% endfor %}
  </div>

  {# Sidebar / Order Summary #}
  <aside>
    {# Section / Order Totals #}
    {# Form / Payment Methods #}
  </aside>
</main>
```

**Shop/archive templates** — comment filters and grid:
```twig
{# @dev Query products and categories #}
{% set products = wpcanai_get_posts_enriched({...}) %}
{% set categories = wpcanai_get_terms_enriched('...') %}

{# Container / Shop #}
<main>
  {# Sidebar / Filters #}
  <aside>
    {# Section / Collection #}
    {# Menu / Category Filter #}
    {# Menu / Color Filter #}
    {# Menu / Size Filter #}
  </aside>

  {# Section / Product Grid #}
  <section>
    {# Container / Sort Bar #}
    {# Container / Product Cards #}
    <div>
      {# Badge / Sale #}
      {# Badge / Out of Stock #}
      {# Card / Product #}
    </div>
  </section>
</main>
```

### Comment Rules

1. **Use the exact navigation grammar** `{# Type / Short Label #}` with one space around `/`
2. **Use only the controlled type vocabulary** above; choose the component's structure or reusable UI role
3. **Match semantic landmarks to their fixed type** and place the comment immediately before the tag
4. **Keep labels human-readable and at most 60 characters**: `{# Section / Hero #}`, `{# Button / Add to Cart #}`
5. **Indent comments** to match the element nesting level they describe
6. **Prefix implementation notes with `@dev`**: `{# @dev Query products once before the loop #}`
7. **Do not use HTML comments for navigation labels** and do not over-comment self-evident text elements
