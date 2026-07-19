---
name: canai-localwp
description: >
  Work with WPCanAI templates and WP Local CLI.
  Use when user asks to create/edit/list WPCanAI templates, apply WooCommerce to pages,
  convert HTML to WPCanAI Twig templates, or interact with the local WordPress instance.
  Triggers on: "canai-localwp", "wpcanai local", "localwp", "local wpcanai", "wpcanai", "template", "twig",
  "woocommerce template", "shop page", "create layout", "edit with wpcanai", "wp cli",
  "scan wpcanai", "check wpcanai", "diagnose wpcanai".
metadata:
  author: canai
  version: "1.10.0"
allowed-tools: Bash Read Write Edit Grep Glob
---

# WPCanAI Skill (local / WP‑CLI)

You are an expert at working with the WPCanAI WordPress plugin. WPCanAI uses **Twig templating** to render **semantic HTML** pages stored as WordPress custom post type `wpcanai_template`.

See [references/REFERENCE.md](references/REFERENCE.md) for WPCanAI-registered Twig functions (plus the vendored Twig version for built-ins), WooCommerce context variables, and the comment convention reference.

## Same domain as `canai-mcp`, different transport

**`canai-localwp`** and **`canai-mcp`** describe the same WPCanAI product behavior (Twig, `_canai_*` meta, WooCommerce resolution, comment conventions). **`canai-localwp`** is for **local shell access** — WP‑CLI, WP Local, SSH — plus workspace edits against that environment. **`canai-mcp`** is for the **MCP server** path (local or remote WordPress): read/write via MCP tools, not `wp` in the terminal. Install both skills if you use both workflows.

## CRITICAL: WPCanAI Storage Model — Read This First

**WPCanAI does NOT use `post_content`.** All template content is stored in **custom meta fields**:

| Meta Key | Purpose |
|----------|---------|
| `_canai_html` | Twig template markup (the actual page content) |
| `_canai_css` | CSS styles |
| `_canai_js` | JavaScript |
| `_canai_context` | JSON context data |
| `_canai_layout` | Layout template post ID |

### NEVER do this:
```bash
# WRONG — This modifies WordPress post_content, which WPCanAI ignores
wp post update <ID> --post_content="<html>..."
wp post update <ID> --post_content="$(cat template.html)"
```

### ALWAYS do this:
```bash
# CORRECT — Write to WPCanAI custom meta fields via temp file, wp_slash()'d (see below)
cat > /tmp/canai_html.twig << 'TWIG'
<main>{{ page_content }}</main>
TWIG
wp eval 'update_post_meta(<ID>, "_canai_html", wp_slash(file_get_contents("/tmp/canai_html.twig")));'
```

**Why:** WPCanAI's renderer reads `_canai_html` meta, not `post_content`. If you write to `post_content`, the page will appear unchanged (WPCanAI ignores it) or show stale content. The same applies to CSS (`_canai_css`), JS (`_canai_js`), and context (`_canai_context`).

**This applies to ALL post types WPCanAI manages:** `wpcanai_template` posts AND regular `page`/`post` types that have WPCanAI enabled (i.e., have `_canai_html` meta set).

### ⚠ The `wp_slash()` footgun — a raw `file_get_contents()` write silently corrupts backslashes

**`update_post_meta()` always calls `wp_unslash()`/`stripslashes()` internally** — that's only safe when the value has ALREADY been through `wp_slash()` first (true for `$_POST` data from a real web request; **not** true for a value read straight off disk with `file_get_contents()`). Skip `wp_slash()` and every literal backslash in the Twig source is silently eaten, **with zero warning anywhere** — confirmed live (dogfood A2, Defect #2): `recipe-single.html`'s ingredient loop was
`item.fields.recipe_ingredients|split("\n")`; pushed via the exact
`update_post_meta($id, "_canai_html", file_get_contents($path))` pattern this
file used to show above (no `wp_slash()`), the stored value ended up
containing `split("n")` — the backslash silently stripped — and every
ingredient line got shredded into a separate `<li>` at every occurrence of
the letter "n" in the rendered output. The page still returned HTTP 200 and
looked plausible at a glance; nothing in WPCanAI's own output, logs, or
this skill pointed at the cause. This isn't specific to that one filter —
**any** Twig source with a literal backslash-letter sequence (`\n`/`\t` in a
filter argument, a regex character class, a CSS content escape, `\"` inside
a JS string in `_canai_js`, …) written this way is vulnerable.

**The fix is exactly one function call**: wrap the value in `wp_slash()`
immediately before `update_post_meta()` — `wp_slash(file_get_contents($path))`
— so its internal unslash exactly cancels back out to the original bytes.
Apply this to **every** `update_post_meta()` / `wp eval` write of
`_canai_html` / `_canai_css` / `_canai_js` / `_canai_context` sourced from a
file, a heredoc, or any string you didn't just receive from `$_POST` —
every example in this skill from here on already does this; don't drop it
when adapting one. (A canai-replicate `pushprep` artifact's `html`/`css`/`js`
strings need the exact same treatment — `pushprep` corrects the document
**shape**, it does not and cannot pre-slash the value for you, since that
depends on how you push it.)

---

## CRITICAL: Content Resolution — Know Where Content Lives

WPCanAI resolves content differently depending on the template type. Editing the wrong post is a silent bug — content saves but nothing changes on the frontend.

### How WPCanAI Resolves Content

WPCanAI resolves content in this order:

1. **Template delegate override** — If a `wpcanai_template` post exists with `_canai_delegate_page_id`, that takes priority over WC auto-resolve for *which page* is the delegate.
2. **WC page types auto-resolve a delegate *page*** — For WooCommerce page types (shop, cart, checkout, my-account, product-category, order-received), WPCanAI automatically resolves a delegate page from WooCommerce settings (`wc_get_page_id()`). **No `wpcanai_template` post is needed** for these types to have a page to resolve to — but that does **not** mean content lives on that page. Whether it does depends on the **shape** currently in effect: in **delegate-body** shape the WC page's own `_canai_html`/`_canai_layout`/`_canai_css`/`_canai_js` are what render; in **template-body** shape the type's `wpcanai_template` (not tagged `layout`) renders the whole page instead and the WC page's own `_canai_html` is dead content. See [The two configuration shapes](#the-two-configuration-shapes) — do not assume delegate-body.
3. **Template-rendered** — For non-WC types (product, 404, search, etc.), WPCanAI reads `_canai_html` from the `wpcanai_template` post directly.

### WC Page Types (delegate page auto-resolves — body location depends on shape)

**Types:** cart, checkout, my-account, shop, product-category, order-received

**Endpoint types (v1.47.0):** order-pay, add-payment-method, orders, view-order, downloads, edit-account, edit-address, payment-methods, lost-password — these resolve to their parent WC page (checkout or my-account). See **Endpoint template types** below.

WPCanAI auto-resolves a delegate *page* for these from WooCommerce's "Page setup" settings — no `wpcanai_template` post is required for that resolution to succeed. But a template **can** exist for the same type, and if it does and isn't tagged `layout`, it renders the whole page and the WC page's own `_canai_html` never runs. **Which post to edit depends on the shape** — see [The two configuration shapes](#the-two-configuration-shapes):

- **Delegate-body** (a `layout`-tagged post is in the layout slot) → edit `_canai_html`/`_canai_layout` on the **WC page**
- **Template-body** (the type's `wpcanai_template` occupies the layout slot and isn't tagged `layout`) → edit `_canai_html` on the **template** instead

**Resolve before editing** — don't guess: run `wpcanai-resolve-content-id` (its `content_post_id` is the post that actually renders) or the diagnostic script in [SCAN Check 1](#8-scan--diagnose-wpcanai-configuration-problems).

```bash
wp eval 'echo wc_get_page_id("cart");'        # Cart delegate page (content lives here only in delegate-body shape)
wp eval 'echo wc_get_page_id("checkout");'     # Checkout delegate page (same caveat)
wp eval 'echo wc_get_page_id("myaccount");'    # My Account delegate page (same caveat)
wp eval 'echo wc_get_page_id("shop");'         # Shop delegate page (same caveat; shared with product-category)
```

**WooCommerce note:** Do not call `wc_get_page_id("pay")` or `wc_get_page_id("thanks")`. Those keys are deprecated; payment and order-received use checkout endpoints. Use `wc_get_checkout_url()` and, for a specific order, `WC_Order::get_checkout_payment_url()` / `get_checkout_order_received_url()`.

### Template-Rendered Types (content lives on the wpcanai_template post)

**Types:** product, 404, search, archive, category, tag, author

These have **no delegate page**. WPCanAI reads `_canai_html` from the `wpcanai_template` post directly. Layout is set via `_canai_layout` on the template post.

### Quick Reference

⚠ **The WC page types below do not have a fixed content source.** Which post renders depends on the [shape](#the-two-configuration-shapes) currently in effect — delegate-body (WC page) or template-body (the type's `wpcanai_template`). Resolve first; don't assume.

| Type | Content Source | How to Find Content ID |
|---|---|---|
| cart | Depends on shape — page **or** template | `wpcanai-resolve-content-id` (`wc_get_page_id("cart")` finds the delegate page only, not necessarily the content source) |
| checkout | Depends on shape — page **or** template | `wpcanai-resolve-content-id` (`wc_get_page_id("checkout")` finds the delegate page only) |
| my-account | Depends on shape — page **or** template | `wpcanai-resolve-content-id` (`wc_get_page_id("myaccount")` finds the delegate page only) |
| shop | Depends on shape — page **or** template | `wpcanai-resolve-content-id` (`wc_get_page_id("shop")` finds the delegate page only) |
| product-category | Depends on shape — page **or** template (shares shop's delegate page in delegate-body shape) | `wpcanai-resolve-content-id` (`wc_get_page_id("shop")` finds the delegate page only) |
| product | `wpcanai_template` post | Template with type "product" |
| 404 | `wpcanai_template` post | Template with type "404" |
| search | `wpcanai_template` post | Template with type "search" |

### WC Auto-Resolve Map

| WPCanAI Type | WC Setting | Shares Page With |
|----------|-----------|-----------------|
| `shop` | `wc_get_page_id("shop")` | product-category |
| `product-category` | `wc_get_page_id("shop")` | shop |
| `cart` | `wc_get_page_id("cart")` | — |
| `checkout` | `wc_get_page_id("checkout")` | order-received, order-pay |
| `order-received` | `wc_get_page_id("checkout")` | checkout |
| `order-pay` | `wc_get_page_id("checkout")` | checkout |
| `my-account` | `wc_get_page_id("myaccount")` | the 8 account endpoints below |
| `add-payment-method` | `wc_get_page_id("myaccount")` | my-account |
| `orders` | `wc_get_page_id("myaccount")` | my-account |
| `view-order` | `wc_get_page_id("myaccount")` | my-account |
| `downloads` | `wc_get_page_id("myaccount")` | my-account |
| `edit-account` | `wc_get_page_id("myaccount")` | my-account |
| `edit-address` | `wc_get_page_id("myaccount")` | my-account |
| `payment-methods` | `wc_get_page_id("myaccount")` | my-account |
| `lost-password` | `wc_get_page_id("myaccount")` | my-account |

### Endpoint template types (v1.47.0) — inheritance is opt-in

The 10 endpoint types above (`order-received`, `order-pay`, and the 8 account
endpoints) are **existence-gated**: an endpoint claims its request only when a
**published `wpcanai_template` of that exact type exists**. With no such
template — the normal state for most sites — the request falls through to its
parent type and renders through the **checkout** or **my-account** page's own
content. So:

- Creating an endpoint template is **optional**, not required. "No `orders`
  template" is the default, not a misconfiguration.
- A site that styles only `checkout` automatically gets a styled thank-you
  (`order-received`) page for free.
- Create an endpoint template only when that endpoint needs markup that differs
  from its parent page.

The three redirect-only WooCommerce endpoints (`customer-logout`,
`delete-payment-method`, `set-default-payment-method`) never render a page and
have no template type.

### Content Resolution Priority

WPCanAI resolves content in this order (first match wins) — but **which post that resolves to depends on the shape currently in effect**, not just on whether a template or a delegate exists. See [The two configuration shapes](#the-two-configuration-shapes) for the full mechanics; the summary:

1. **Broken layout** — the layout slot points at a template post that no longer exists → the page renders **blank**, regardless of what's on the delegate page.
2. **Template-body** — the type's `wpcanai_template` occupies the layout slot (the default, unless the delegate page's own `_canai_layout` displaces it) and is **not** tagged `layout` → that template's own `_canai_html` renders the whole page. This wins even when a `_canai_delegate_page_id` or a WC delegate page also resolves — an explicit delegate or an auto-resolved WC page is **not** a guarantee that the delegate page's content is what renders.
3. **Delegate-body** — the layout slot resolves to a genuine `layout`-tagged post (via the delegate page's own `_canai_layout`, an explicit `_canai_delegate_page_id`, or WC auto-resolve) → the delegate page's `_canai_html` supplies the body, wrapped by that layout.
4. **None** — no template, no delegate content, and no site default layout → WPCanAI does not take over the request.

Don't assume which rule applies — run `wpcanai-resolve-content-id` or the diagnostic script in [SCAN Check 1](#8-scan--diagnose-wpcanai-configuration-problems) to get the actual `content_post_id` before editing.

### The two configuration shapes

A WooCommerce structural type is in exactly one of two shapes, and which one
decides where the body must be edited:

| Shape | Setup | Where the body lives | Where to edit |
|---|---|---|---|
| **Delegate-body** | The WC page carries `_canai_layout` naming a layout template | The WC page's `_canai_html`, wrapped by that layout | The **WC page** |
| **Template-body** | The type's `wpcanai_template` is not a layout and the WC page has no `_canai_layout` | The **template's** `_canai_html` — it renders the whole page | The **template** |

The dispatcher decides: `_canai_layout` starts as the type's template, the WC
page's own `_canai_layout` displaces it, and whichever post ends up in that slot
is checked for the `layout` term. A layout wrapper means the page supplies the
body; a non-layout post means that post renders everything.

**Consequence:** in template-body shape, `_canai_html` on the WC page never
renders. `wpcanai-scan` reports it as `unreachable_content`; editing it has no
effect. Ask `wpcanai-resolve-content-id` (or check both posts) before editing —
its `content_post_id` is the post that actually renders.

**Both shapes are valid — neither is "correct."** A `wpcanai_template` for a
structural type (cart, checkout, my-account, shop, product-category) is
**not** required to be an empty marker. If it carries `_canai_html` and is not
itself tagged `layout`, that content is exactly what renders (template-body) —
there is nothing to "clean up." The marker-only convention described elsewhere
in this file is one *option* (delegate-body), not a rule.

This means WC page types can be **overridden** by creating a `wpcanai_template` post:

- **Separate product-category design**: Create a `wpcanai_template` with type `product-category` and put `_canai_html` directly on it. This overrides the shared shop page content for category pages only.
- **Separate product-category via delegate**: Create a `wpcanai_template` with type `product-category`, create a dedicated WP page for it, set `_canai_delegate_page_id` to that page, **and set that dedicated page's own `_canai_layout` to a real `layout`-tagged post** (see [The two configuration shapes](#the-two-configuration-shapes)). The last part is not optional: without it, the non-layout template still occupies the layout slot itself (template-body shape), so the dedicated page's content is unreachable and the request renders **blank**. Content lives on the dedicated page only once its own layout is set.
- **No template**: Product category falls back to the shop page via WC auto-resolve (default behavior).

### Shop, archives, and pagination

- **WooCommerce shop / product-category:** WPCanAI injects `products` and a `pagination` object (`current_page`, `total_pages`, `per_page`, `total_products`, and `total_posts` as an alias). Prefer looping `products` and output `{{ wc_pagination()|raw }}` or `{{ wpcanai_pagination()|raw }}` so URLs follow the main catalog query (including `/page/N/` under pretty permalinks). Avoid replacing the loop with `wpcanai_get_posts_enriched` unless you pass `paged` and match catalog visibility.
- **WordPress archives** (`category`, `tag`, `author`, `search`, `archive` including CPT archives): WPCanAI injects `posts` and the same `pagination` shape (`total_posts` is the post count). Use `{{ the_posts_pagination()|raw }}`, `{{ wpcanai_paginate_links()|raw }}`, or `{{ wpcanai_pagination()|raw }}` (dispatches to WC on shop/category only).
- **Permalinks:** Use the Twig helpers above instead of hard-coding query strings. WC **`[products]`** shortcodes use the `product-page` argument; the **main shop** does not.

---

## Multi-language — determine the model FIRST

WPCanAI sites are multilingual in one of **two mutually exclusive models**. Detect which before doing any translation work; do NOT assume Polylang.

- **Native string translation (single-post i18n, plugin 1.22+)** — ONE post per page. A site-wide string table translates `{{ t('…') }}` sources, and per-language **content overrides** translate a post's title/content/excerpt/custom-fields and term name/description. Detect: `wp option get wpcanai_i18n_settings` returns configured `languages`. **Never clone posts per language in this model.**
  - Strings: the **WPCanAI → Translations** admin page, or `wp eval` against the `WPCanAI\I18n\StringStore` service; per-post content via override meta `_canai_i18n_{lang}` (a sparse `{title,content,excerpt,fields,seo_title,seo_description}` blob). The MCP twins are `wpcanai/i18n-*`; locally, edit via `wp eval` against the `WPCanAI\I18n\ContentOverrides` service or the **WPCanAI → Translations** admin page.
  - Twig helpers: `t()`, `tmedia()`, `current_lang()`, `languages()`, `lang_url()` (see REFERENCE → Internationalization).
  - Site-level strings (site name, tagline, archive/search/404 SEO title+description) live in a per-language **global-string** store (option `wpcanai_i18n_global_strings`), separate from post/term overrides. Edit via `wp eval` against `WPCanAI\I18n\GlobalStrings`; the MCP twins are `wpcanai/i18n-get-global-strings` / `wpcanai/i18n-set-global-strings`, and the admin UI is the **Global** tab in WPCanAI → Translations. Example:

    ```bash
    wp eval '(new WPCanAI\I18n\GlobalStrings())->set("ms", ["site_name" => "…", "tagline" => "…", "archive" => ["search" => ["title" => "…", "description" => "…"], "404" => ["title" => "…"]]);'
    wp eval 'var_export((new WPCanAI\I18n\GlobalStrings())->all());'
    ```

    Archive contexts are `search`, `404`, `post_type:<slug>`. Category / tag titles are term overrides, not global strings. `set()` is a sparse upsert (a `null`/empty value removes a key) and rejects the default language.
  - **Automatic SEO on non-default pages (plugin 1.30+):** missing `seo_title`/`seo_description` auto-derive from the translated title / excerpt / content (description ≤160 chars on a word boundary); canonical + `og:url` are `/<lang>/`-prefixed and WPCanAI's own canonical is suppressed when a SEO plugin is active; plugin redirects keep the `/<lang>/` prefix except WordPress system paths (`/wp-login.php`, `/wp-admin`, `/wp-json`, `/xmlrpc.php`, `/wp-cron.php`, `/wp-content`, `/wp-includes`); `Article.headline` JSON-LD translates and RankMath's sitemap declares `xmlns:xhtml`.
- **Polylang** — one post PER language, linked as translations. Detect: Polylang active (`pll_languages_list()` non-empty). Only in this model do you use the `pll_*` workflows below.

If neither is active and the user wants multilingual, prefer **native string translation** (no extra plugin).

## Multi-language — Polylang model

**Applies only when Polylang is active** (see the model router above). For the native model, use content overrides, not per-language post copies.

WPCanAI integrates with **Polylang** automatically (no-op when Polylang is inactive — see the plugin's `src/I18n/PolylangIntegration.php`). When Polylang is active, every storage rule above gains a **per-language axis**: editing the wrong-language post is a new silent-bug class.

### Translation model

| Object | Behavior under Polylang |
|---|---|
| `wpcanai_template` post | **Translatable** — each language has its own post in a linked translation group |
| `template_type` taxonomy | **NOT translatable** (intentional) — EN and MS shop templates share the same term `shop`. Type markers are not translated strings. |
| `_canai_html`, `_canai_css`, `_canai_js`, `_canai_context`, `_canai_context_mode` | **Copied** on translation — Polylang seeds the new-language post with the source's values; you then edit them per language |
| `_canai_layout`, `_canai_delegate_page_id` | **Translated** — each language stores its own layout / delegate IDs (Polylang remaps via `pll_get_post`) |
| WC delegate pages (cart, checkout, my-account, shop) | Per-language. `wc_get_page_id()` resolves to the **current-language** page when Polylang is on; the same default-language `_canai_html` will not render on the MS frontend. |

### Resolution behavior

- `TemplateResolver` runs the resolved page ID through `pll_get_post()` for the current language before reading `_canai_html`. Editing must target the **right-language** delegate page.
- For a non-default-language URL with **no** template/delegate in that language, WPCanAI forces a **404** rather than falling back to the default language.

### Workflows

**Find the right post per language** before reading/writing:

```bash
# Templates with their language and type
source .env.wplocal && wp --path="$WP_PATH" eval '
foreach (get_posts(["post_type" => "wpcanai_template", "posts_per_page" => -1, "post_status" => "any"]) as $t) {
  $lang = function_exists("pll_get_post_language") ? (pll_get_post_language($t->ID) ?: "—") : "n/a";
  $terms = wp_get_post_terms($t->ID, "template_type", ["fields" => "slugs"]);
  echo "ID=$t->ID lang=$lang type=" . implode(",", $terms) . " title=\"$t->post_title\"\n";
}
'

# WC delegate page IDs across languages
source .env.wplocal && wp --path="$WP_PATH" eval '
foreach (["cart","checkout","myaccount","shop"] as $key) {
  $default_id = wc_get_page_id($key);
  echo "$key default=$default_id";
  if (function_exists("pll_get_post")) {
    foreach (pll_languages_list() as $lang) {
      $tid = pll_get_post($default_id, $lang);
      echo " $lang=" . ($tid ?: "—");
    }
  }
  echo "\n";
}
'
```

**Write per-language content:** resolve the language-specific ID first, then `update_post_meta` against that ID. Never assume the default-language ID applies to every language.

**Link a manually-created translation** to its source group:

```bash
wp eval 'pll_set_post_language($new_id, "ms"); pll_save_post_translations(["en" => $en_id, "ms" => $new_id]);'
```

**Audit missing translations** (templates that exist in the default language but not others):

```bash
source .env.wplocal && wp --path="$WP_PATH" eval '
if (!function_exists("pll_default_language")) { echo "Polylang inactive\n"; return; }
$default = pll_default_language();
$other = array_diff(pll_languages_list(), [$default]);
foreach (get_posts(["post_type" => "wpcanai_template", "posts_per_page" => -1, "post_status" => "publish", "lang" => $default]) as $t) {
  foreach ($other as $lang) {
    if (!pll_get_post($t->ID, $lang)) echo "🟡 \"$t->post_title\" (ID $t->ID) — no $lang translation\n";
  }
}
'
```

**Twig helpers** for language-aware markup — three families: native WPCanAI i18n (`t()`, `tmedia()`, `current_lang()`, `languages()`, `lang_url()`, plugin 1.22+), Polylang-only (`current_language()`, `language_switcher()`), and the WordPress gettext family (`__()`, `_x()`, `_n()`) — see [references/REFERENCE.md](references/REFERENCE.md#internationalization-i18n).

---

## Init: `init wplocal`

1. **Ask the user** for their WP Local SSH entry script path. Example:
   ```
   ~/Library/Application\ Support/Local/ssh-entry/HeqF7OcVY.sh
   ```
   Tip: In WP Local app, right-click the site → "Open Site Shell" to find the script path.

2. **Validate** the script exists and contains WordPress-related env vars.

3. **Generate `.env.wplocal`** from the script:
   ```bash
   grep -E '^export (MYSQL_HOME|PHPRC|WP_CLI_CONFIG_PATH|WP_CLI_DISABLE_AUTO_CHECK_UPDATE|PATH|MAGICK_CODER_MODULE_PATH)' "<script-path>" > .env.wplocal
   echo "export WP_PATH=\"$(sed -n 's/^cd "\(.*\)"/\1/p' "<script-path>")\"" >> .env.wplocal
   echo "# Generated from: <script-path>" >> .env.wplocal
   echo "# Generated at: $(date)" >> .env.wplocal
   ```

4. **Verify** the connection works:
   ```bash
   source .env.wplocal && wp --path="$WP_PATH" --info
   ```

5. **Confirm** to the user that WPCanAI CLI is ready.

---

## Running WPCanAI Commands

Before any `wp` command:
1. Check that `.env.wplocal` exists. If not, tell the user to run init first and stop.
2. **Always prepend** `source .env.wplocal &&` to every `wp` command internally:

```bash
source .env.wplocal && wp --path="$WP_PATH" <command>
```

The user only sees high-level actions — never the sourcing mechanics.

**IMPORTANT**: `wp db query` may not work on WP Local (MySQL socket issue). Use `wp eval` with `$wpdb` for raw SQL queries instead.

---

## Action Router

### 1. LIST — Show existing WPCanAI templates and pages

```bash
# List all WPCanAI templates with their types
wp post list --post_type=wpcanai_template --fields=ID,post_title,post_name,post_status --format=table

# Get template_type for each
wp post term list <ID> template_type --fields=name --format=csv

# List all WPCanAI-enabled pages (pages with _canai_html meta)
wp eval 'global $wpdb; $r = $wpdb->get_results("SELECT p.ID, p.post_title, p.post_type, COALESCE((SELECT meta_value FROM wp_postmeta WHERE post_id = p.ID AND meta_key=\"_canai_layout\" LIMIT 1),\"none\") as layout_id FROM wp_posts p INNER JOIN wp_postmeta pm ON p.ID = pm.post_id WHERE pm.meta_key=\"_canai_html\" AND p.post_status=\"publish\" GROUP BY p.ID ORDER BY p.post_type, p.ID"); foreach($r as $row) echo "$row->ID\t$row->post_title\t$row->post_type\tlayout=$row->layout_id\n";'
```

### 2. READ — Pull template content from a WPCanAI template or page

**First: determine the correct ID** (see [Content Resolution](#critical-content-resolution--know-where-content-lives)):
- For WC page types (cart/checkout/my-account/shop/product-category) → **do not assume the delegate page.** The correct ID is the delegate page only in **delegate-body** shape; in **template-body** shape it's the `wpcanai_template` post instead (see [The two configuration shapes](#the-two-configuration-shapes)). Run `wpcanai-resolve-content-id` (its `content_post_id` is the post that actually renders) or the SCAN Check 1 script before reading.
- For template-rendered types (product/404/search/etc.) → use the **wpcanai_template post ID**

```bash
wp post meta get <ID> _canai_html      # Twig HTML (use correct ID per rendering mode)
wp post meta get <ID> _canai_css       # CSS
wp post meta get <ID> _canai_js        # JS
wp post meta get <ID> _canai_context   # Context JSON
wp post meta get <ID> _canai_layout    # Assigned layout
wp post term list <ID> template_type --fields=name --format=csv  # Template type (wpcanai_template only)
```

### 3. CREATE — Create a new WPCanAI template

```bash
# Step 1: Create the wpcanai_template post
wp post create --post_type=wpcanai_template --post_title="My Template" --post_status=publish --porcelain

# Step 2: Set the template type
wp post term set <ID> template_type <type>
# Types: layout, header, footer, component, shop, product, product-category, cart,
#        checkout, my-account, order-received, product-loop,
#        order-pay, add-payment-method, orders, view-order, downloads,
#        edit-account, edit-address, payment-methods, lost-password,
#        category, tag, author,
#        search, 404, archive

# Step 3: Write template content via temp files (wp_slash() — see the
# footgun note above; a raw file_get_contents() here silently eats backslashes)
wp eval 'update_post_meta(<ID>, "_canai_html", wp_slash(file_get_contents("/tmp/canai_html.twig")));'
wp eval 'update_post_meta(<ID>, "_canai_css", wp_slash(file_get_contents("/tmp/canai_css.css")));'
wp eval 'update_post_meta(<ID>, "_canai_js", wp_slash(file_get_contents("/tmp/canai_js.js")));'

# Step 4: Assign a layout (if not a layout itself)
wp post meta update <ID> _canai_layout <layout_post_id>

# Step 5: Set delegate page (for structural/WC page types — see below)
wp post meta update <ID> _canai_delegate_page_id <page_id>
```

**For writing multiline template content**: Write the Twig/CSS/JS to a temp file first, then use `wp eval` with `wp_slash(file_get_contents(...))` to save it to post meta. Do NOT try to pass multiline content directly via `wp post meta update`, and do NOT drop the `wp_slash()` wrapper — see the footgun note above.

#### Delegate Page Setup (Step 5)

To get the **delegate-body** shape (see [The two configuration shapes](#the-two-configuration-shapes)), the template post must not itself occupy the layout slot as a non-layout post — leave its own `_canai_html` empty and make sure the resolved layout for this type is a genuine `layout`-tagged post (via the WC page's own `_canai_layout`, or the site default layout). `_canai_delegate_page_id` then points at the page where content lives. **If you instead put `_canai_html` on this template**, that is the valid **template-body** shape: the template renders the whole page itself, and the delegate page's own `_canai_html` (if any) becomes dead content (`unreachable_content` in `wpcanai-scan`). Decide which shape you want before writing content — don't write to both.

**Example — creating a cart template with delegate:**
```bash
TEMPLATE_ID=$(wp post create --post_type=wpcanai_template --post_title="Cart Template" --post_status=publish --porcelain)
wp post term set $TEMPLATE_ID template_type cart
CART_PAGE=$(wp eval 'echo wc_get_page_id("cart");')
wp post meta update $TEMPLATE_ID _canai_delegate_page_id $CART_PAGE
# Content goes on the DELEGATE PAGE, not the template:
wp post meta update $CART_PAGE _canai_layout <layout_id>
wp eval "update_post_meta($CART_PAGE, '_canai_html', wp_slash(file_get_contents('/tmp/canai_html.twig')));"
```

### 4. UPDATE — Edit an existing WPCanAI template or page

**First: determine the correct ID** (see [Content Resolution](#critical-content-resolution--know-where-content-lives)):
- For WC page types (cart/checkout/my-account/shop/product-category) → **do not assume the delegate page.** Update the delegate page only in **delegate-body** shape; in **template-body** shape update the `wpcanai_template` post instead (see [The two configuration shapes](#the-two-configuration-shapes)). Run `wpcanai-resolve-content-id` (its `content_post_id` is the post that actually renders) or the SCAN Check 1 script before writing — writing to the wrong post saves successfully but changes nothing on the frontend.
- For template-rendered types (product/404/search/etc.) → update the **wpcanai_template post**

```bash
# Read current content first (use correct ID per content resolution)
wp post meta get <ID> _canai_html

# Write updated content via temp file, then (wp_slash() — see the footgun note above):
wp eval 'update_post_meta(<ID>, "_canai_html", wp_slash(file_get_contents("/tmp/canai_html.twig")));'
```

### 5. APPLY WOOCOMMERCE — Add WooCommerce functionality to a template

1. **Identify the page** and its current template/layout
2. **Determine the WooCommerce template type** needed (shop, product, cart, checkout, etc.)
3. **Determine where content lives** (see [Content Resolution](#critical-content-resolution--know-where-content-lives)):
   - **Delegate-based types** (cart, checkout, my-account, shop, product-category): if the site is in **delegate-body** shape, write `_canai_html` and `_canai_layout` to the **delegate page** and leave the type template's own `_canai_html` empty. If instead you want the type template itself to render the page (**template-body** shape), write `_canai_html` there — see [The two configuration shapes](#the-two-configuration-shapes). Confirm which shape applies with `wpcanai-resolve-content-id` / `wpcanai-scan` before writing.
   - **Template-rendered types** (product, 404, search, etc.): Write `_canai_html` to the **wpcanai_template** post
4. **Check if a template of that type already exists** — update it or create new
5. **Generate Twig HTML** using the correct WooCommerce context variables (see [references/REFERENCE.md](references/REFERENCE.md))
6. **Save via WP CLI** to the correct post (delegate page or template)

### 6. CONVERT COMMENTS — Replace HTML comments with Twig comments

1. **Read the template** via `wp post meta get <ID> _canai_html`
2. **Replace all `<!-- ... -->` section/navigation comments with `{# ... #}`**
3. **Preserve HTML comments that are NOT section labels** (e.g., conditional IE tags)
4. **Write back** via temp file + `wp eval`

Quick detection: if a `<!-- -->` comment is a short label on its own line (not wrapping disabled code), it's a section comment and should be converted.

### 7. CONVERT HTML — Transform semantic HTML into WPCanAI templates

**Source is a canai-replicate migration kit? Don't hand-convert it — run
`pushprep` first.** `"$HOME/.claude/skills/canai-replicate/bin/replica"
pushprep <site>` already does steps 1–2 below deterministically for every
`output/pages/*.html` / `output/templates/*.html` file, writing one
`runs/<site>/output/push/<slug>.json` (`{ title, slug, template_type, html,
css, js, warnings }`) per file. Writing a kit file's raw content verbatim
into `_canai_html` instead doubles WPCanAI's own document shell around it
(dogfood A2, Defect #1 — CRITICAL, reproduced live: 2×`<!DOCTYPE html>`,
2×`<html>`, 2×`<head>`, 2×`<body>`) — a kit file is always a full standalone
document (canai-prepare's format, deliberate — it opens via `file://` for
preview), and WPCanAI's own no-layout render path wraps `_canai_html` in
**its own** shell too. Take `html`/`css`/`js` from the `pushprep` JSON
(already `wp_slash()`-safe to write per the footgun note above — that's a
separate concern from the document-shape fix, still your responsibility at
write time), and `template_type` (when non-null) as the `template_type` term.
**`header.json`/`footer.json` need their post's SLUG forced to the exact
bare string `header`/`footer`** — `wpcanai_template('header')`/`('footer')`
resolve by slug, not title or `template_type` term, and a descriptive title
silently auto-slugs away from it, breaking every include site-wide with no
error (dogfood A2 Defect #7, reproduced live: `wp post create --post_title="dogfood-header
(SK migration)"` auto-slugged to `dogfood-header-sk-migration`, and
`{{ wpcanai_template('header') }}` rendered empty everywhere until the slug
was forced back with `wp post update <ID> --post_name=header`). Everything
below still applies when converting hand-authored HTML that did **not** come
from canai-replicate.

1. **Parse the HTML** structure — identify header, nav, main, footer, sidebar sections
2. **Decompose into templates**:
   - `<html>` + `<head>` + shell around `{{ page_content }}` → **layout** template (one site shell; see reuse rule below)
   - Reusable header → **header** component (include via `{{ wpcanai_template('header-name') }}`)
   - Main content → **page** `_canai_html` or **type-specific template** (product, shop, etc.) — **not** `template_type` `layout`
   - **Before creating a new layout**, list existing `wpcanai_template` posts with type `layout` (e.g. `wp post list --post_type=wpcanai_template`) and **reuse** an existing layout when present; do not duplicate a second full-document layout unless requested
   - The **`<main>`** / primary page body belongs on a **page** (or WC delegate / type template), with `_canai_layout` pointing at the layout — do not publish the main body as a new `layout` template
3. **Replace static content with Twig**:
   - Static nav → `{% for item in get_menu('primary') %}`
   - Static post/product grids → `{% for post in wpcanai_get_posts_enriched({...}) %}`
   - Static images → `{{ image_attrs(id) }}`
   - Hardcoded site name → `{{ bloginfo('name') }}`
4. **Preserve semantic HTML** structure
5. **Use Tailwind CSS** for styling
6. **Head / scripts / JS storage**:
   - **Do NOT** put a literal `<title>` in layout `_canai_html` — `{{ wp_head() }}` outputs the document title
   - Put page-level JavaScript (`lucide.createIcons()`, Alpine init, custom handlers) in **`_canai_js`**, not inline `<script>` in `_canai_html`. WPCanAI outputs `_canai_js` at `wp_footer()`. The only inline `<script>` in layout `_canai_html` should be `tailwind.config = { ... }` after `{{ wp_head() }}`
7. **Save each template** via WP CLI

### 8. SCAN — Diagnose WPCanAI configuration problems

When user asks to scan, check, or diagnose WPCanAI issues, run these checks and report findings.

#### Check 1: WooCommerce structural types — which shape, and is it healthy

For each base structural type (`shop`, `product-category`, `cart`, `checkout`,
`my-account`), ask the resolver which shape the site is actually in — see
[The two configuration shapes](#the-two-configuration-shapes). Do **not**
assume delegate-body, and do **not** treat `_canai_html` on the template as an
error: in template-body shape it is exactly what renders.

```bash
wp eval '
$resolver = $GLOBALS["wpcanai_template_resolver"];
$base_types = ["shop", "product-category", "cart", "checkout", "my-account"];
foreach ($base_types as $label) {
  $d = $resolver->describe_content_resolution($label, null);

  // delegate_mismatch: the template DECLARED _canai_delegate_page_id is
  // itself broken. Checked regardless of shape — a broken declared override
  // can itself be why the shape is not delegate-body.
  if ($d["template_post_id"]) {
    $declared = (int) get_post_meta($d["template_post_id"], "_canai_delegate_page_id", true);
    if ($declared > 0) {
      $declared_post = get_post($declared);
      if (!$declared_post || $declared_post->post_type !== "page") {
        echo "🟡 DELEGATE MISMATCH [$label]: template {$d['template_post_id']} declares delegate $declared, but that post no longer exists (or is not a page)\n";
      } elseif ($d["delegate_page_id"] <= 0) {
        echo "🟡 DELEGATE MISMATCH [$label]: template {$d['template_post_id']} declares delegate $declared, but it has no translation for the requested language\n";
      }
    }
  }

  switch ($d["shape"]) {
    case "none":
      echo $d["delegate_page_id"] > 0
        ? "ℹ [$label]: No WPCanAI content; page {$d['delegate_page_id']} has none either\n"
        : "ℹ [$label]: No WC page\n";
      break;
    case "broken-layout":
      // critical: a stored layout id whose post no longer exists — the page renders BLANK
      echo "🔴 BROKEN LAYOUT [$label]: layout template {$d['layout_post_id']} no longer exists; page renders BLANK";
      echo $d["unreachable_post_id"] > 0 ? "; page {$d['unreachable_post_id']} has _canai_html stranded behind it\n" : "\n";
      break;
    case "template-body":
      // Valid shape: the type template is not a layout wrapper, so its own
      // _canai_html renders the whole page. This is NOT an error.
      echo "✅ OK [$label]: template {$d['content_post_id']} renders this type directly\n";
      if ($d["unreachable_post_id"] > 0) {
        echo "🟡 UNREACHABLE [$label]: page {$d['unreachable_post_id']} has _canai_html that can never render — template {$d['content_post_id']} renders this type; editing the page has no effect\n";
      }
      break;
    default: // delegate-body
      $page_html = get_post_meta($d["content_post_id"], "_canai_html", true);
      if (empty($page_html) && $d["template_post_id"]) {
        // A wpcanai_template deliberately exists for this type — a real gap.
        echo "🟡 EMPTY [$label]: delegate page {$d['content_post_id']} has no _canai_html\n";
      } elseif (empty($page_html)) {
        // No template exists at all — the normal fresh-install state (the WC
        // page renders its own content wrapped in the site layout).
        echo "ℹ [$label]: no wpcanai_template exists yet; page {$d['content_post_id']} renders its own WooCommerce content\n";
      } else {
        echo "✅ OK [$label]: delegate page {$d['content_post_id']} has content, layout=" . ($d["layout_post_id"] ?: "none") . "\n";
      }
  }
}
'
```

This mirrors `wpcanai-scan`'s WooCommerce-block classification (see
`canai-mcp/SKILL.md`'s finding-types table) — same shapes, same severities, so
findings from either transport agree.

#### Check 2: Missing layout assignment

Posts with `_canai_html` but no `_canai_layout` render without a layout wrapper (no header/footer).

```bash
wp eval '
global $wpdb;
$rows = $wpdb->get_results("
  SELECT p.ID, p.post_title, p.post_type FROM wp_posts p
  INNER JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = \"_canai_html\"
  LEFT JOIN wp_postmeta lm ON p.ID = lm.post_id AND lm.meta_key = \"_canai_layout\"
  WHERE p.post_status = \"publish\" AND (lm.meta_value IS NULL OR lm.meta_value = \"\")
");
foreach ($rows as $r) {
  if ($r->post_type === "wpcanai_template") {
    $terms = wp_get_post_terms($r->ID, "template_type", ["fields" => "slugs"]);
    if (array_intersect(["layout","header","footer","component"], $terms)) continue;
  }
  echo "🟡 NO LAYOUT: $r->post_type \"$r->post_title\" (ID $r->ID)\n";
}
'
```

**Cross-check against Check 1 before recommending a fix.** If Check 1 already
reported a post here as `UNREACHABLE` (template-body shape: some other
template renders this type, so that post's `_canai_html` never runs), do
**not** tell the user to "assign a layout" to it — doing so **flips the
shape** to delegate-body, displacing the type template and changing what
actually renders on the live URL. Report it as informational (its
`_canai_html` is dead regardless of `_canai_layout`), not as a fix to apply.

#### Check 3: Template-rendered types health

Check template-rendered types (no delegate) have `_canai_html` and layout.

```bash
wp eval '
$types = ["product","404","search","category","tag","author","archive"];
$templates = get_posts(["post_type" => "wpcanai_template", "posts_per_page" => -1, "post_status" => "publish"]);
foreach ($templates as $t) {
  $terms = wp_get_post_terms($t->ID, "template_type", ["fields" => "slugs"]);
  foreach ($terms as $type) {
    if (!in_array($type, $types)) continue;
    $html = get_post_meta($t->ID, "_canai_html", true);
    $layout = get_post_meta($t->ID, "_canai_layout", true);
    if (empty($html)) echo "🟡 NO CONTENT: \"$t->post_title\" (ID $t->ID, type $type) — no _canai_html\n";
    if (empty($layout)) echo "🟡 NO LAYOUT: \"$t->post_title\" (ID $t->ID, type $type)\n";
    if ($html && $layout) echo "✅ OK: \"$t->post_title\" (ID $t->ID, type $type) layout=$layout\n";
  }
}
'
```

#### Reporting

After running all checks:
1. **Summarize findings** — group by severity (🔴 critical, 🟡 warning, ⚠ info)
2. **Explain** what each problem means and what happens if left unfixed
3. **Ask user for confirmation** before applying any fixes — never auto-fix
4. **Proposed fixes** — confirm which shape the user actually wants before changing or deleting any content:
   - `UNREACHABLE` / `unreachable_content` (a post has `_canai_html` that can't render) → read the finding's `post_id` before acting: under **template-body** it is the WC *page* whose body is dead; under **delegate-body** (v1.50.1) it is the *template*, displaced by the page's own `_canai_layout`. Either way, ask whether they want the current shape (leave it; the content is simply unused) or the other one (move the content onto whichever post actually renders, or change what occupies the layout slot) — never clear it without asking
   - `BROKEN LAYOUT` / `broken_layout` → the referenced layout post no longer exists; ask which layout should replace it, or clear the dangling `_canai_layout` pointer
   - `DELEGATE MISMATCH` / `delegate_mismatch` → the template's **declared** `_canai_delegate_page_id` is itself broken (post gone, wrong post type, or — under Polylang — no translation for the language in question); confirm the correct page and fix the declared meta. This is not a "which one wins" question — the id it names simply doesn't resolve.
   - `EMPTY` / `empty_delegate_page` → only fires when a `wpcanai_template` deliberately exists for this type; offer to add content directly, or confirm the site actually intends template-body instead. (No template at all for the type is reported as `no_template`/`info`, not this — that's the normal fresh-install state, not a gap to fill.)
   - Missing layout (`no_layout` / `no_layout_tpl`) → offer to assign the site's default layout — **except** when the same scan also reported `unreachable_content` for that exact post (surfaced as `info`, not `warning`, precisely to flag this): that post's `_canai_html` is already unreachable because a template-body shape is in effect, and assigning `_canai_layout` to it **flips the shape** to delegate-body — displacing the type template and changing what actually renders on the live URL. Confirm the user actually wants that shape change (and understands the consequence) before touching it.

### 9. PRESETS, EXPORT & TRANSLATE — Bootstrap, back up, or translate content

| Goal | Command / where |
|---|---|
| Install a preset pack | `wp wpcanai preset install <slug>` |
| Export / import content | `wp wpcanai export` / `wp wpcanai import` |
| Translate content (native) | override meta / Translations page |

See [Presets & bundles (WP-CLI)](#presets--bundles-wp-cli) below for full command syntax, and [Multi-language — determine the model FIRST](#multi-language--determine-the-model-first) for the native translation workflow.

---

## Presets & bundles (WP-CLI)

- `wp wpcanai preset list` — available packs.
- `wp wpcanai preset install <slug> [--no-front-page] [--clean-slate]` — installs a pack (templates/pages, sideloaded images, translation-ready `t()`-wrapped copy + `languages()` switcher, real nav menus in Appearance → Menus, and any Forminator forms). The pack's front page is set as the site front page by default; pass `--no-front-page` to skip that. **`--clean-slate` is destructive: it trashes ALL existing WPCanAI templates/pages before installing — confirm with the user first.**
- `wp wpcanai preset uninstall <slug>` — removes the pack's content and its menus.
- `wp wpcanai export bundle.json` / `wp wpcanai import bundle.json [--dry-run]` — round-trips templates + pages, including `_canai_i18n_{lang}` content-override blobs (`i18n_meta`) and (v1.39.0) any precompiled Tailwind build cache (`_canai_tailwind_build` / `_hash` / `_built_at`; only non-empty builds), so an imported layout renders with its inline CSS instead of the Play CDN. Both take a file path argument (not stdin/stdout redirection). Media binaries are not included (attachment IDs re-sideload).

---

## WPCanAI Template Architecture

### Template Storage

Each template is a `wpcanai_template` post with meta:
- `_canai_html` — Twig template (the main content)
- `_canai_css` — CSS styles
- `_canai_js` — JavaScript
- `_canai_context` — JSON context data
- `_canai_layout` — Layout template post ID (wraps this template)

### Rendering Hierarchy

```
Layout Template (_canai_html contains full <html>)
  ├── {{ wpcanai_template('header-name') }}     ← Header component
  ├── {{ page_content }}                     ← Content template renders here
  └── Footer (inline or component)
```

### Template Types (taxonomy: `template_type`)

| Type | Trigger | Auto-injected Context |
|------|---------|----------------------|
| `layout` | Wraps other templates | `page_content` |
| `header` | Included via `wpcanai_template()` | `cart`, menus |
| `footer` | Included via `wpcanai_template()` | menus |
| `component` | Reusable partial | varies |
| `shop` | `is_shop()` | `products`, `attribute_filters` |
| `product` | `is_product()` | `post`, `post.wc`, `product` (WC_Product) |
| `product-category` | `is_product_category()` | `products`, `current_category`, `attribute_filters` |
| `cart` | `is_cart()` | `cart.*` |
| `checkout` | `is_checkout()` | `cart.*`, `customer.*`, `payment_gateways`, `shipping_methods` |
| `my-account` | `is_account_page()` | WooCommerce account |
| `order-received` | `is_order_received_page()` | `order` (WC_Order) |
| `order-pay` | `is_checkout_pay_page()` | `order` (WC_Order) |
| `add-payment-method` | `is_account_page()` + `is_wc_endpoint_url('add-payment-method')` | WooCommerce account |
| `orders` | `is_account_page()` + `is_wc_endpoint_url('orders')` | WooCommerce account |
| `view-order` | `is_account_page()` + `is_wc_endpoint_url('view-order')` | WooCommerce account |
| `downloads` | `is_account_page()` + `is_wc_endpoint_url('downloads')` | WooCommerce account |
| `edit-account` | `is_account_page()` + `is_wc_endpoint_url('edit-account')` | WooCommerce account |
| `edit-address` | `is_account_page()` + `is_wc_endpoint_url('edit-address')` | WooCommerce account |
| `payment-methods` | `is_account_page()` + `is_wc_endpoint_url('payment-methods')` | WooCommerce account |
| `lost-password` | `is_account_page()` + `is_wc_endpoint_url('lost-password')` | WooCommerce account |
| `category` | `is_category()` | `posts`, `current_category` |
| `tag` | `is_tag()` | `posts`, `term` |
| `search` | `is_search()` | `posts`, `search_query` |
| `404` | `is_404()` | — |

The 10 endpoint types (`order-received` through `lost-password`) are
**existence-gated**: each claims its request only when a published template of
that type exists, otherwise the request falls through to `checkout` /
`my-account`. Endpoint bodies render through the parent page's WooCommerce
shortcode, which routes endpoint content internally.

---

## Conventions & Best Practices

1. **Always `|raw`** for WooCommerce HTML (price_html, totals, forms, notices)
2. **AJAX container IDs**: Use `wpcanai-shipping-methods-container` and `wpcanai-order-totals-container` for checkout refresh
3. **Empty states**: Always handle `{% if cart.is_empty %}` and `{% for ... %}{% else %}` patterns
4. **Nonces**: Include `wc_update_cart_nonce()` in cart forms, `wp_nonce_field()` in checkout
5. **Tailwind CSS**: Preferred styling — include CDN in layout or use TailwindManager
6. **Semantic HTML**: Use proper elements (`<main>`, `<article>`, `<nav>`, `<section>`, `<aside>`)
7. **Layout wrapping**: Non-layout templates set `_canai_layout` to a layout post ID
8. **Component inclusion**: Use `{{ wpcanai_template('slug') }}` to include reusable parts
9. **Section comments**: Always use `{# #}` Twig comments — never `<!-- -->` for section labels. See [references/REFERENCE.md](references/REFERENCE.md) for the full comment convention.
10. **NEVER put `<style>` or `<script>` in `_canai_html`** — CSS goes in `_canai_css`, JS goes in `_canai_js`. Both fields support Twig expressions. The only exception is the **layout** template which may include `<script>` tags in `<head>` for CDN libraries (Tailwind, Lucide) and config.
11. **Use `image_attrs()`** for all media images instead of hardcoding URLs — e.g., `<img {{ image_attrs(249, "src,alt") }} class="...">`. This makes templates portable across environments.
12. **Use brand color tokens** instead of hardcoded hex colors — e.g., `text-brand-red` not `text-[#A73A33]`. Brand tokens are defined in the layout's Tailwind config.
13. **Use `|raw` for `post_title`** to decode HTML entities like `&amp;` — use CSS `uppercase` class instead of Twig `|upper` filter to avoid encoding issues.
