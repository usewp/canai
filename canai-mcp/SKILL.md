---
name: canai-mcp
description: >
  Strictly use the WPCanAI MCP server as the only way to interact with the user’s WordPress site for WPCanAI content work (templates, pages, settings, setup, diagnostics, i18n, media).
  Do not use WP-CLI, REST/curl, or workspace edits under wp-content for live site data — only MCP tools (e.g. wpcanai-read-meta, wpcanai-write-meta) via the configured server (often canai-mcp).
  Does NOT cover FluentSnippets or wpcanai-eval — those are in the separate opt-in canai-yolo skill.
  Triggers on: "/canai-mcp", "wpcanai mcp", "canai-mcp", "wpcanai remote", "remote wpcanai", "staging", "production", "remote site",
  "mcp", "api key", "deploy template",
  "translate", "translation", "translate the site", "i18n", "multilingual", "string translation", "native translation", "/canai-mcp translate",
  "translate content", "translate cpt", "content translation",
  "optimize production", "compile tailwindcss", "compile tailwind", "build css", "tailwind build",
  "sideload", "upload", "upload image", "upload media", "media library", "attach image", "attachment", "image to media".
metadata:
  author: canai
  version: "1.15.0"
allowed-tools: "Read Grep Glob"
---

# WPCanAI MCP Skill

You are an expert at working with **WPCanAI** through the **WPCanAI MCP server** only (WordPress Abilities API + mcp-adapter). The WordPress site may be remote **or** local; the **only** supported way to read or change that site’s WPCanAI-related data from this skill is `**WP_API_URL` in the user’s MCP config** pointing at the **full** MCP endpoint for that site (`{site}/wp-json/mcp/wpcanai`).

See [references/REFERENCE.md](references/REFERENCE.md) for WPCanAI-registered Twig functions (plus the vendored Twig version for built-ins), WooCommerce context, and comment conventions (same as local WPCanAI).

## Same domain as `canai-localwp`, different transport

`**canai-mcp`** and `**canai-localwp`** cover the same WPCanAI concepts (Twig, meta fields, content resolution). `**canai-localwp**` is the **WP‑CLI / local workspace** skill; `**canai-mcp`** is this one: **only** the **WPCanAI MCP server** and its tools. When this skill applies, **never** substitute terminal `wp`, `curl`, raw REST, or repo edits for interacting with the user’s WordPress.

**Code / eval / FluentSnippets** live in the separate opt-in skill **`canai-yolo`**. This skill stays content-focused (templates, pages, settings, i18n, media, Tailwind). If the user needs snippet authoring or `wpcanai-eval`, install/use `canai-yolo` — do not improvise those workflows from this skill.

---

## CRITICAL — WPCanAI MCP server only (strict)

**Every interaction with the user’s WordPress** for WPCanAI content work (list/read/write templates and pages, settings, bootstrap setup, scan, WooCommerce page IDs, i18n, media, etc.) **MUST** go through the **WPCanAI MCP server** using the tools your host exposes (hyphenated names like `wpcanai-read-meta`, `wpcanai-write-meta`, `wpcanai-setup`, … — see the tool list for the configured server, often `canai-mcp` or `user-canai-mcp`). Do not use WP-CLI, `wp eval`, direct SQL, browser automation against wp-admin, or editing files under `wp-content/` in the workspace to change live site data.

**One documented exception — binary uploads.** MCP isn't a good carrier for files (size + base64 overhead), so media goes via the **WPCanAI sideload REST route** `POST {site}/wp-json/wpcanai/v1/sideload` using the **same** API key the MCP transport uses. See **"Uploading media (binary files)"** below for the exact recipe. This is the **only** sanctioned use of `curl` against the site; everything else still goes through MCP.

**This skill is NOT the `canai-localwp` / WP-CLI workflow.** If the user needs shell-based WP, they must use or install `**canai-localwp`** separately; do not blend that workflow here.

1. **Do not use `Edit`, `Write`, or apply patches** to paths under `wp-content/` (or anywhere in the repo) to change **WPCanAI template HTML/CSS/JS/context** for the site served by MCP. Those files are not the live WPCanAI storage model for MCP-driven work.
2. **All reads and writes of WPCanAI content** (`_canai_html`, `_canai_css`, `_canai_js`, `_canai_context`, `_canai_layout`) MUST go through **WPCanAI MCP tools** only.
3. **Use your host’s MCP integration** to call those tools. Do not substitute shell `wp`, Python, raw HTTP, or local file edits for MCP operations when the user invoked this skill or `/canai-mcp`. (The single `curl` exception is the documented sideload route — see "Uploading media" below.)
4. `**Read` / `Grep` / `Glob`** in the workspace are only for **reading this skill, plugin source, or docs** — not for “fixing” the live my-account / privacy / template output. For live content, use `**wpcanai-read-meta`** then `**wpcanai-write-meta`** after resolving the correct `post_id` with `**wpcanai-resolve-content-id**` or `**wpcanai-list-pages**`.

If MCP tools are unavailable or fail, **tell the user** to check MCP client settings (`canai-mcp` or the configured server name, `JWT_TOKEN`, `WP_API_URL`) — **do not** silently fall back to WP-CLI, REST, or editing local files for site content.

---

## How to invoke MCP tools (any client)

This applies to **any** MCP-capable host (IDEs, CLIs, agents): Cursor, Claude Desktop, Windsurf, Cline, VS Code extensions, etc.

- Call WPCanAI tools through **your host’s MCP tool-calling mechanism** (exact API name varies: e.g. `CallMcpTool`, `use_mcp_tool`, native MCP tool list in the client). The MCP server name the user configured is often `**canai-mcp`**; some hosts **prefix** server names (e.g. `user-canai-mcp`). Use **whatever server identifier your host lists** for the WPCanAI MCP connection.
- The MCP client handles **sessions**, **transport**, and **authentication** — **never** reimplement MCP over Shell, Python, curl, or raw HTTP to `{site}/wp-json/mcp/wpcanai`. A **large payload is not an exception**: passing a full `_canai_html` through `wpcanai-write-meta` works at any size, and hand-rolled HTTP to the MCP endpoint will only 403 (no session/auth). If a write feels too big to be worth resending whole, use **`wpcanai-replace-in-meta`** for the targeted change instead — never drop to raw HTTP.
- **Do not** open tool-descriptor JSON files or probe REST routes to discover parameters — use the **inline tool reference** below.
- If tool calls fail, ask the user to verify **WPCanAI → AI Agent** in WordPress (endpoint URL, API key) and their MCP client config — do not improvise workarounds.

---

## Local scripting glue — use Node, never Python

The core flow needs **no** local scripting at all: site reads/writes go through **MCP tool calls** (your host's native mechanism) and HTML/CSS/JS edits happen **in the agent** ("build the final string in the agent"). Only two steps ever shell out — the binary **sideload** (below) and the **Tailwind compile** (`npx tailwindcss@^3`, already Node).

When a step genuinely needs local glue — sha256 hashing, assembling a temp file, extracting an inline `tailwind.config`, a multipart upload — **use Node (`node -e` / `npx`), never Python or a `pip`-installed tool.** Node is guaranteed present: you installed this skill via `npx skills add`, so `node` and `npx` are on `PATH`. Reaching for `python`/`python3`/`requests` adds a dependency the environment may not have and that this skill does not assume. (This is separate from — and does not weaken — the rule above that MCP transport itself is **never** reimplemented in any language: hashing a temp file with Node is fine; hand-rolling HTTP to `…/wp-json/mcp/wpcanai` in Node is still forbidden.)

## Prerequisites (short)

- WordPress with WPCanAI, `wordpress/abilities-api`, and `wordpress/mcp-adapter`.
- **MCP endpoint:** `{site}/wp-json/mcp/wpcanai` (copy from **WP Admin → WPCanAI → AI Agent → Connections**).
- **API key** as `JWT_TOKEN` for `@automattic/mcp-wordpress-remote` (or your client’s env).

Add to your **MCP client’s server configuration** (example; keys may differ by client):

```json
{
  "mcpServers": {
    "canai-mcp": {
      "command": "npx",
      "args": ["-y", "@automattic/mcp-wordpress-remote@latest"],
      "env": {
        "WP_API_URL": "https://example.com/wp-json/mcp/wpcanai",
        "JWT_TOKEN": "<paste-wpcanai-api-key>"
      }
    }
  }
}
```

**Important:** `WP_API_URL` must be the **full** path `…/wp-json/mcp/wpcanai`, not only the site home URL — use the value from **AI Agent → Connections**.

Verify with `**wpcanai-list-templates`** (or your client’s tool list for the WPCanAI server).

## WPCanAI Prerequisite Setup (on the site)

Before relying on WPCanAI for full-page output, the site should have:

1. **Minimum templates** — at least **one layout** (`template_type` `layout`), **one header** (`header`), and **one footer** (`footer`). Layouts wrap `{{ page_content }}`; header/footer are included with `{{ wpcanai_template('slug') }}`.
2. **WPCanAi Starter** (theme slug `wpcanai-empty`) — install and activate the minimal WPCanAI theme. It is **bundled** with the plugin at `wpcanai/theme/wpcanai-empty/` and can also be installed from **WP Admin → WPCanAI** (welcome page).
3. **Bundled libraries** — in **WPCanAI → Settings**, set **Load Tailwind CSS Play CDN** to **Yes** and **Resource Source** to **Internal** (bundled script) when you are not using **`wpcanai-setup`** (recommended setup enables this automatically). Enable Lucide and Alpine as needed.
4. **Tailwind config in the layout** — in the layout’s `_canai_html`, output `**tailwind.config = { ... }` in a `<script>` after `{{ wp_head() }}`** so it runs after the Tailwind script WPCanAI injects on `wp_head`.

```twig
<head>
  {# Meta & Viewport #}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  {{ wp_head() }}
  {# Tailwind CSS Config #}
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            brand: { DEFAULT: '#0f766e', dark: '#115e59' },
          },
        },
      },
    }
  </script>
</head>
```

### Recommended setup (one MCP call)

If prerequisites are missing or the user asks to **“proceed all recommended setup”**, call `**wpcanai-setup`** `{ }` first. It installs/activates **WPCanAi Starter** (`wpcanai-empty`), creates the default layout (via the plugin’s default-layout helper), adds basic header/footer templates, creates a Home page, sets the static front page, sets `**wpcanai_default_layout**`, and enables **Tailwind CSS** (`wpcanai_tailwind_settings`: `load_tailwind` = `yes`, `source` = `plugin` / internal bundled Play CDN).

For **WordPress / WooCommerce / WPCanAI options** (e.g. static front page, `users_can_register`, checkout/account registration, Tailwind settings), use `**wpcanai-read-settings`** / `**wpcanai-update-settings`**. For **other plugin options** stored in `wp_options`, use `**wpcanai-get-option`** / `**wpcanai-update-options`** after the site owner configures allowlists under **WPCanAI → AI Agent → Guardrails** (read list, auto-apply list, and optional approval list). For a new **page** with optional WPCanAI meta, use `**wpcanai-create-page`**.

### Implement HTML → WPCanAI (agent workflows)

When converting a static HTML file (e.g. `index.html`) into WPCanAI via MCP tools:

> **Source is a canai-replicate migration kit? Push its `output/push/*.json`
> artifacts, never a raw `output/pages/*.html` / `output/templates/*.html`
> file.** Every canai-replicate output file is a full standalone HTML
> document (`<!DOCTYPE>`/`<html>`/`<head>`/`<body>`, by design — it opens
> via `file://` for local preview). WPCanAI's own render path ALSO wraps
> `_canai_html` in its own document shell, so writing a kit file's raw
> content verbatim into `_canai_html` produces doubled, invalid markup:
> 2×`<!DOCTYPE html>`, 2×`<html>`, 2×`<head>`/`</head>`, 2×`<body>` —
> reproduced live (dogfood A2, Defect #1 — CRITICAL). Run
> `"$HOME/.claude/skills/canai-replicate/bin/replica" pushprep <site>`
> first; it strips the shell + preview-libs blocks deterministically and
> writes one push-ready `{ title, slug, template_type, html, css, js,
> warnings }` JSON per file to `output/push/<slug>.json` — write `html`/
> `css`/`js` from THAT into `_canai_html`/`_canai_css`/`_canai_js`, and read
> `template_type` (when non-null) as the `template_type` term for a new
> `wpcanai-create-template` call. Do not re-strip the shell by hand; do not
> skip `pushprep` "because the file looks simple."
>
> **`header.json`/`footer.json` need their SLUG forced.** `wpcanai_template('header')`
> / `('footer')` resolve by the created template post's exact **slug**, not
> its title or `template_type` term. Create these two with
> `wpcanai-create-template` using a **title that is exactly, or slugs to
> exactly, `header`/`footer`** — a descriptive title like "Header — Acme
> migration" auto-slugs away from the bare string and every
> `{{ wpcanai_template('header') }}` call site-wide then silently resolves
> to nothing, no error anywhere (dogfood A2 Defect #7, reproduced live).
> Verify with `wpcanai-list-templates` that the returned `slug` is the bare
> string before moving on. **Push these two before anything that includes
> them.**

> **Prefer WPCanAI template functions — don't hardcode what a helper provides.** When writing `_canai_html` / `_canai_css` / `_canai_js`, use a registered WPCanAI Twig function wherever one applies instead of hardcoding the value or markup. Hardcoded asset URLs, internal links, and user-facing strings all break on the live site (wrong base path, moved slugs, non-permalink URLs, no translation) the same way a relative `./images/hero.jpg` 404s. Map source values to helpers:
>
> | Hardcoded in source | Use instead |
> |---|---|
> | `<img src="…">`, `srcset`, CSS `url(…)` | `{{ image_attrs(id, 'src,alt') }}` / `{{ media_url(id, size) }}` |
> | internal `<a href="/about">` / `href="about.html">` | `{{ slug_url('about') }}` / `{{ id_url(id) }}` / `{{ post_url() }}` / `{{ term_url(id) }}` |
> | literal user-facing strings | `{{ t('…') }}` on **native-i18n** sites (see **Native string translation**); `{{ __('…') }}` / `{{ _x() }}` / `{{ _n() }}` on Polylang/gettext sites |
> | static post/markup that should be dynamic | `{{ the_content() }}` / `{{ shortcode('[…]') }}` |
> | shared header/footer/partials duplicated per page | `{{ wpcanai_template('slug') }}` |
>
> Keep a value hardcoded **only** when no helper applies or an absolute external URL is genuinely required (e.g. OG/Twitter meta, web-manifest icons, third-party origins). Images (step 5 + the sideload pre-pass) and internal links (step 6) are concrete instances of this rule. See [references/REFERENCE.md](references/REFERENCE.md) → **Media & Links** and **Internationalization (i18n)**.

1. **Do NOT** include a literal `<title>` in layout `_canai_html` — `{{ wp_head() }}` outputs the document title (WordPress / SEO plugins).
2. Put page-level JavaScript (e.g. `lucide.createIcons()`, Alpine init, custom handlers) in **`_canai_js`**, not as inline `<script>` in `_canai_html`. WPCanAI injects `_canai_js` at `wp_footer()`. The only `<script>` allowed inline in layout `_canai_html` is `tailwind.config = { ... }` (after `{{ wp_head() }}`, so it runs after the Tailwind script WPCanAI injects).
3. **Reuse layouts:** call `wpcanai-list-templates` first. If a **layout** already exists, reuse its `id` for `_canai_layout` / references — do not create a duplicate layout template unless the user asks for a second shell.
4. **Page body vs layout:** put `<main>` / primary page markup in a **`page`** created with `wpcanai-create-page` (set `layout` to the layout template ID) — not as a `wpcanai_template` of type `layout`. Layout templates are the document shell (`{{ page_content }}`, header/footer includes); page bodies are not `template_type` `layout`.
5. **Auto-detect and sideload local media BEFORE writing HTML.** Static site folders almost always reference local assets (`./images/hero.jpg`, `assets/logo.svg`, `videos/intro.mp4`, favicons, OG images, CSS `url(...)` backgrounds). If you push the HTML/CSS as-is, every one of those references 404s on the live site. Run the **Static-site asset sideload pre-pass** (next subsection) before any `wpcanai-create-page` / `wpcanai-write-meta` call so the HTML you write resolves media **by ID** through `{{ image_attrs(...) }}` / `{{ media_url(...) }}`, not relative paths or pinned upload URLs.
6. **Rewrite internal links to WPCanAI helpers** (instance of the principle above). Static sources keep `<a href="about.html">` / `href="/about">`; these break on the live site (wrong base path, non-permalink, moved slugs). Rewrite each internal link to the matching helper: cross-page links → `{{ slug_url('<slug>') }}` (or `{{ id_url(<id>) }}` when the target page id is known from `wpcanai-create-page`); term / archive links → `{{ term_url(<term_id>) }}`. **Leave untouched:** external / absolute (`https://other.com`), protocol-relative (`//cdn…`), and anchor-only (`#section`) links. Report the rewrites in the manifest.
7. **Normalize section comments to Twig.** Convert every `<!-- Section: X -->` (and any nav-label HTML comment `canai-prepare` emitted) into a `{# Section: X #}` Twig comment — **never** carry HTML nav comments into `_canai_html` (they pollute rendered output). Then **guarantee** every top-level landmark — `<section>` / `<main>` / `<header>` / `<footer>` / `<nav>` / `<aside>` — carries a `{# Section: … #}` comment even when the source lacked one; these feed the editor's structure/outline menu. See the comment convention in [references/REFERENCE.md](references/REFERENCE.md) (**Twig Comment Convention**). A canai-replicate `pushprep` artifact already has this conversion applied — spot-check it, don't redo it from scratch.

### Static-site asset sideload pre-pass

Triggered when the user runs `/canai-mcp implement <folder>`, asks you to import a static site, **or pushes a canai-replicate migration kit's `output/push/*.json` artifacts** (a `pushprep` artifact's `html` still contains the source site's original absolute/hotlinked image URLs — canai-replicate does not sideload; that's this skill's job, same as any other static-site import). Left un-sideloaded, an image can 404 or render broken the moment the source site's own hotlink protection kicks in (confirmed live: dogfood A2 Defect #6). Runs **once, up front**, before any HTML/CSS is written to WPCanAI meta.

1. **Enumerate referenced assets.** Use `Read` / `Grep` / `Glob` over the folder to extract every reference that resolves to a file **inside the provided folder**. Cover at minimum:
   - HTML attributes: `src`, `srcset` (each candidate), `href` for `<link rel="icon">` / `apple-touch-icon` / `manifest`, `<video poster>`, `<source src>`, `<object data>`, `<embed src>`, OG / Twitter meta (`og:image`, `twitter:image`).
   - CSS: `url(...)` in `<style>` blocks, inline `style="…"`, and any `.css` files in the folder.
   - JS: string literals in inline `<script>` and bundled `.js` files when obviously asset paths (e.g. `"./images/foo.png"`); skip dynamic / templated values.

   **Skip:** absolute `http(s)://` URLs to other origins, protocol-relative `//cdn…`, `data:` URIs, `mailto:` / `tel:`, anchor-only `#…`, and any path that doesn't resolve to a real file under the folder. Deduplicate by resolved absolute path.

2. **Sideload each unique file** via `POST {site}/wp-json/wpcanai/v1/sideload` (see **Uploading media** for the exact `curl`). Run uploads **one at a time** so you can capture each `id` / `source_url`. Pass a sensible `alt` when the source HTML provides one (`<img alt="…">`); otherwise omit it. Re-uploading the same bytes is fine — WordPress dedupes on filename, but the API returns a fresh attachment each call, so cache hits in your map matter.

3. **Build a rewrite map keyed on the media `id`** — `{ <original-reference-string>: <media id> }`, **not** the raw `source_url`. Key on the **exact string as it appears in the source** (e.g. `./images/hero.jpg`, `images/hero.jpg`, `/images/hero.jpg` — all three map to the same upload `id`). WPCanAI resolves the live URL at render time from the id, so the page survives the media being regenerated or the site moving; a pinned `source_url` does not. (Only the OG/manifest exception in step 4 keeps the absolute `source_url`.)

4. **Rewrite HTML / CSS / JS in memory to ID-based helpers** before any `wpcanai-write-meta` call. Apply to the same content surfaces you scanned in step 1, using the right form per surface:
   - **`<img>`** → strip the hardcoded `src` / `alt` and splat `{{ image_attrs(<id>, 'src,alt') }}` (use `'src,alt,width,height'` when dimensions are known). **Preserve** existing `class` / other attributes; keep or append `loading="lazy"` below the fold.
   - **CSS `url(...)`** (in `_canai_css` / inline `style`), **`<source srcset>`**, **`<video poster>`**, **`<link rel="icon">` / `apple-touch-icon`** → `{{ media_url(<id>, 'full') }}` (Twig-rendered surfaces). Rewrite each `srcset` candidate independently, preserving its `1x` / `2x` / `480w` descriptor.
   - **OG / Twitter meta** (`og:image`, `twitter:image`) and **web-manifest icons** → keep the absolute `source_url`. These require absolute URLs and aren't reliably Twig-rendered — the one documented exception to ID-based rewriting.

   Do **not** edit files on disk — the rewrite happens in the agent, and the rewritten string is what you pass to `html` / `css` / `js`.

5. **Report the manifest** to the user when done: a short table of `original path → media id → final Twig form` — where *final Twig form* is the `{{ image_attrs(...) }}` / `{{ media_url(...) }}` it was rewritten to, or the absolute `source_url` for the OG/manifest exception — plus a count of skipped references (with reasons: external, data URI, missing file). The user uses this to spot-check the conversion.

**Idempotence.** If the user re-runs the import, you'll re-upload (the endpoint doesn't dedupe by content hash). That's acceptable for a one-shot import; warn the user if you detect an obvious re-run (e.g. they're pointing at the same folder a template was already built from) and offer to reuse existing attachments via `wpcanai-list-media` / `wpcanai-get-media` instead of re-uploading.

**What this does not cover.** Fonts loaded via `@font-face { src: url(...) }` work the same way and should be included. CSS-in-JS, webpack-style hashed bundles, or assets referenced only at runtime via fetch can't be statically detected — call those out in the manifest's "skipped" section so the user knows to handle them manually.

### Shop and archive pagination (Twig on the site)

When writing `_canai_html` for the **shop** or **product-category** delegate (or global WC templates), use injected `products` and `pagination`, and output `{{ wc_pagination()|raw }}` or `{{ wpcanai_pagination()|raw }}`. For **category / tag / search / author / archive** (including CPT archives), use injected `posts` and `pagination` with `{{ the_posts_pagination()|raw }}` or `{{ wpcanai_paginate_links()|raw }}`. See [references/REFERENCE.md](references/REFERENCE.md) for the full shape and permalink notes.

### Styling WooCommerce blocks (cart / checkout / order-received / my-account)

WPCanAI's `wc_*` Twig helpers (`wc_checkout_form()`, `wc_cart_totals()`, the my-account endpoints) echo raw WooCommerce output whose HTML structure is otherwise invisible until a live page renders — and the order-received/order-pay pages additionally hide their details behind WooCommerce's guest email-verification gate, so you cannot simply view them. **Do not guess selectors.** Before styling any of these blocks:

1. Call `wpcanai-get-wc-css-reference` with the context you are styling (e.g. `{ "context": "order-received" }`).
2. Read `css_reference` — WooCommerce's own default rules for that context's selectors. **It is raw SCSS source, not compiled CSS**: Sass variables, mixins and `&` parent-refs arrive unresolved (e.g. `darken($secondary, 10%)`, `@include …`), so paraphrase the rules into real CSS rather than pasting them into `_canai_css`. Extracted from four stylesheets of the *installed* WooCommerce (`woocommerce.scss`, `woocommerce-layout.scss`, `woocommerce-smallscreen.scss`, `forms.scss`), so it stays correct across WooCommerce updates — re-call the tool rather than relying on remembered class names. Rules arrive wrapped in their true ancestor selector chain (e.g. `.woocommerce { table.shop_table { … } }`), so match the full chain for specificity. A rule wrapped in `@media only screen and (max-width: 768px)` came from `woocommerce-smallscreen.scss` and is mobile-only — WooCommerce applies that breakpoint in the enqueue, not the file, so don't treat it as unconditional.
3. Read the files in `template_files` (via `canai-localwp` shell access or any file read) — they are the authoritative markup, with a theme override winning over WooCommerce's bundled copy, and paths are ABSPATH-relative. They include classes core ships but never styles (e.g. `.woocommerce-order-overview__order`/`__date`/`__total` on the thank-you page). If `templates_missing` is non-empty, the context map has drifted from the installed WooCommerce — its paths are context-relative (e.g. `order/order-details.php`), a deliberately different format from `template_files`, so the two lists cannot be set-compared.
4. Check `third_party_hooks`. Each entry (`{hook, priority, callback, file, is_third_party}`) is a plugin adding its own markup on that context (e.g. a delivery-slot plugin appending a table to the thank-you page) — read its `file` to learn the classes it emits before styling. Pass `"include_core": true` to get *every* callback on those hooks instead, WooCommerce's own included, each still carrying its `is_third_party` flag — useful when you want the full picture of what renders into the region, not just the third-party additions.
5. Write overrides scoped to those selectors into the page/template's `_canai_css` (via `wpcanai-write-meta`), matching the site's design system.

If `css_fallback` is `"full-file"`, selector extraction found nothing (a WooCommerce restructure) — the whole stylesheet was returned instead; grep it for the classes you saw in `template_files`.

This is read-only static analysis: nothing is rendered, and no order, cart, or customer data is read.

---

## MCP tool reference (inline)

Ability IDs use slashes; MCP tool names use **hyphens** (`wpcanai/read-meta` → `wpcanai-read-meta`).

**`lang` parameter (Polylang):** the 10 tools below that target a post or page (`list-templates`, `list-pages`, `read-meta`, `write-meta`, `replace-in-meta`, `create-template`, `resolve-content-id`, `scan`, `get-wc-page-ids`, `create-page`) accept an optional `"lang": string` (Polylang language slug). When Polylang is active, `lang` is **required** unless `WPCANAI_MCP_LANG_OPTIONAL` is defined in `wp-config.php`. Calls without `lang` return `WP_Error('lang_required')`; unknown slugs return `WP_Error('unknown_lang')`. See the **CRITICAL: Multi-language (Polylang)** section for details. Settings/options tools further down are unchanged.

### `wpcanai-list-templates`

- **Args:** `{ "status"?: string, "lang"?: string }` — post status filter (default `"publish"`); `lang` filters to that Polylang language.
- **Returns:** `array` of objects: `id`, `title`, `slug`, `status`, `type` (template_type names), `layout_id` (int or null), `lang` (slug or null).

### `wpcanai-list-pages`

- **Args:** `{ "lang"?: string }` — `lang` filters to that Polylang language.
- **Returns:** `array` of objects: `id`, `title`, `post_type`, `layout_id` (int or null), `lang` (slug or null) for posts/pages that have `_canai_html`.
- **Published only.** Returns posts with status `publish`. A page created via `wpcanai-create-page` with `status: "draft"` will NOT appear here — re-resolve it by id, don't assume it was lost.

### `wpcanai-read-meta`

- **Args:** `{ "post_id": int, "fields"?: ["html"|"css"|"js"|"context"|"layout"|"tailwind_build"|"tailwind_hash"], "lang"?: string }` — `post_id` required; omit `fields` to read the default set (`html`, `css`, `js`, `context`, `layout`). Pass `tailwind_build` / `tailwind_hash` explicitly when you need them — they are excluded from the default set because the build CSS can be large. When `lang` is set and Polylang is active, errors with `lang_mismatch` if `post_id` is in a different language (no auto-translate — pass the language-specific id).
- **Returns:** object with any of `html`, `css`, `js`, `context` (strings), `layout` (int), `tailwind_build` (string), `tailwind_hash` (string).

### `wpcanai-write-meta`

- **Args:** `{ "post_id": int, "html"?: string, "css"?: string, "js"?: string, "context"?: string, "layout"?: int, "tailwind_build"?: string, "tailwind_hash"?: string, "lang"?: string }` — `post_id` required; include only keys you want to update. `tailwind_build` writes the precompiled per-page Tailwind CSS to `_canai_tailwind_build`; `tailwind_hash` writes the input hash to `_canai_tailwind_hash` (paired — see **Compile Tailwind for Production**). Same `lang_mismatch` enforcement as `read-meta` — write is rejected (no DB change) if the post's actual language differs from the declared `lang`.
- **Returns:** `{ "success": bool, "post_id": int }`.
- **Note:** passing the **complete** `html`/`css`/`js` string is fully supported **at any size** — large pages are fine. A big payload is **never** a reason to fall back to raw HTTP/Python/curl against the MCP endpoint (it has no MCP session/auth and will 403). When you only need to change specific substrings (asset URLs, a class name, a string), prefer **`wpcanai-replace-in-meta`** below.
- **Don't bundle `tailwind_build` with source edits.** A `tailwind_build` written in the SAME call as `html`/`css`/`js` is stamped with the pre-write epoch and stays conservatively stale. Write source first, then `tailwind_build`/`tailwind_hash` in a SEPARATE call.
- **Empty-string semantics differ.** `write-meta` uses key-presence (`array_key_exists`): passing `"html": ""` CLEARS the field. `create-template`/`create-page` use `!empty`: an empty string is ignored, not written. To clear a content field, use `write-meta`.

### `wpcanai-replace-in-meta`

- **Args:** `{ "post_id": int, "field"?: "html"|"css"|"js", "replacements": [{ "from": string, "to": string }], "require_all"?: bool, "lang"?: string }` — `post_id` and `replacements` required; `field` defaults to `html`. Applies literal (non-regex) string replacements to one content surface **server-side** — the document never crosses the wire, only the `{from,to}` pairs do. Pairs apply in order; each `from` is replaced everywhere it occurs. `require_all: true` errors (status 422, nothing written) if any `from` matches 0× — use it to catch typo'd `from` strings. Same `lang_mismatch` enforcement as `write-meta`.
- **Returns:** `{ "success": bool, "post_id": int, "field": string, "total": int, "replacements": [{ "from", "to", "count" }] }` — check each `count` to confirm the replacement applied.
- **When to use:** targeted edits to an existing large page (e.g. fixing broken asset URLs) — one small call instead of `read-meta` + a full `write-meta` round-trip. Slash-sensitive content (escaped Tailwind selectors like `.md\:flex`) is preserved; editing `html`/`css`/`js` marks the layout's Tailwind build stale exactly as `write-meta` does.

### `wpcanai-create-template`

- **Args:** `{ "title": string, "type": string, "html"?: string, "css"?: string, "js"?: string, "layout"?: int, "lang"?: string, "translation_of"?: int }` — `title` and `type` (template_type slug) required. `lang` sets the new post's Polylang language. `translation_of` is the source post id; when provided, the new template is merged into the source's translation group via `pll_save_post_translations` (preserves existing translations on the source).
- **Returns:** `{ "post_id": int, "slug": string, "lang": string|null }`.
- **Typed CPT templates (v1.24+).** A published `wpcanai_template` whose `template_type` term is `single-<post_type>` or `archive-<post_type>` claims that CPT's singular / archive rendering on the frontend — e.g. create one with type `single-service` to own the `service` detail page, `archive-service` for its archive. Existence-gated: with no such template, WPCanAI falls through byte-identically to the theme. Pages keep their own meta path; WooCommerce products keep the WC block.

### `wpcanai-resolve-content-id`

- **Args:** `{ "type": string, "lang"?: string }` — `type` required. Accepts the base types (`cart`, `checkout`, `my-account`, `shop`, `product-category`, `product`, `product-loop`, `404`, `search`, `category`, `tag`, `author`, `archive`), the 10 WooCommerce endpoint types (`order-received`, `order-pay`, `add-payment-method`, `orders`, `view-order`, `downloads`, `edit-account`, `edit-address`, `payment-methods`, `lost-password`), and **(v1.50.0)** types registered through the `wpcanai_template_types` filter. When `lang` is set, ids are mapped through `pll_get_post(..., lang)`.
- **Registered-type caveat.** The enum is built when the ability registers, on `wp_abilities_api_init` (fired from `init` priority 1). A `wpcanai_template_types` filter added at **file scope** — the documented way, and what the resolver's own docs show — is live by then and its types are accepted. One added *inside* an `init` callback at the default priority 10 is not yet registered, so the schema rejects the type even though the resolver would resolve it fine. Register at file scope.
- **Returns:** `{ "content_post_id": int, "content_post_type": string, "rendering_mode": string, "template_post_id": int|null, "unreachable_post_id": int, "resolution_reason": string, "lang": string|null }`.
- **(v1.50.0) `content_post_id` is the post that actually renders.** *Delegate-body*: a layout wrapper is in effect, so the WooCommerce page supplies the body — `content_post_id` is that page, `rendering_mode` is `page-rendered`. *Template-body*: the type's template is not a layout wrapper, so it renders the whole page itself — `content_post_id` is the **template**, `rendering_mode` is `template-rendered`, and the delegate page's `_canai_html` (if any) is dead content reported as `unreachable_post_id`. `resolution_reason` states which applied. Edit `content_post_id`; before v1.50.0 this returned the delegate page even when the template rendered, so edits could land on meta that never renders.
- **`rendering_mode` has four values, one per shape** — `page-rendered` (delegate-body), `template-rendered` (template-body), and **(v1.50.1)** `blank` and `none`. *Blank* = the layout pointer names a post that no longer exists, so the page renders **blank**; fix the dangling pointer (`wpcanai-scan` reports it as `broken_layout`, critical). *None* = WPCanAI does not render this type at all. Both carry `content_post_id: 0` and `content_post_type: ""`, and `resolution_reason` says which. Before v1.50.1 both reported `template-rendered` / `wpcanai_template`, naming a renderer that did not exist — do not treat those two fields as meaningful unless `content_post_id` is non-zero.
- **(v1.50.1) Endpoint types inherit their parent's template.** A WooCommerce endpoint claims a request only when a published template of that type exists; otherwise the request renders through the parent type (`checkout` for `order-received`/`order-pay`, `my-account` for the other eight). `resolve-content-id` mirrors that, so an endpoint with no template of its own reports the **parent's** template under template-body rather than a delegate page that can never render. Before v1.50.1 it reported that page, contradicting `wpcanai-scan`'s own `unreachable_content` warning about the same post.

### `wpcanai-scan`

- **Args:** `{ "lang"?: string }` — when set, scopes the scan to that Polylang language; finding `message` strings are prefixed with `[<lang>] `.
- **Returns:** `array` of findings: `severity`, `type`, `message`, optional `post_id`.
- **Finding types (v1.50.0).** The WooCommerce block (the five base structural types `shop`, `product-category`, `cart`, `checkout`, `my-account`) validates each type against the shape the site is actually in — neither shape is an error:

  | Severity | Type | Meaning |
  |---|---|---|
  | critical | `broken_layout` | A layout pointer references a post that no longer exists — the page renders **blank**. The only `critical` finding scan emits. |
  | warning | `unreachable_content` | Authored `_canai_html` that can never render, in either direction. *Template-body*: the WooCommerce page still carries a body while the template renders. *(v1.50.1)* *Delegate-body*: the type template was displaced by the page's own `_canai_layout` and still carries a body. Names both the dead post and the post that wins. |
  | warning | `delegate_mismatch` | The template's **declared** `_canai_delegate_page_id` is itself broken — the post no longer exists, isn't a `page`, or (Polylang) has no translation for the requested language. Checked independently of shape: a broken declared override can itself be why the resolved shape isn't delegate-body. Fix the declared override; do not repoint it at whatever id currently resolves — that id is *derived from* the same declared value and comparing the two never finds a real defect. |
  | warning | `empty_delegate_page` | *Delegate-body*, **and a `wpcanai_template` exists for this type**: the page that should hold the body has no `_canai_html`. Someone deliberately configured this type, so an empty page is a real gap. |
  | warning | `duplicate_type_template` | More than one published template carries the same `template_type` term — only the first renders, the rest are inert. |
  | ok | `template_body_ok` | *Template-body*: the template renders this type directly. Distinct from the generic sweep's own `template_ok` below — same word, different meaning. |
  | ok | `delegate_ok` | *Delegate-body*: the page has content and its resolved layout. |
  | info | `no_template` / `wc_page` | Nothing authored for this type yet — either *delegate-body* with no `wpcanai_template` at all (the WC page renders wrapped in the site layout; common on a fresh install, **not** a misconfiguration), or shape `none` (no WC page resolves either). |

  The **generic sweep** (every post with `_canai_html`, plus every published `wpcanai_template` of type `product`/`404`/`search`/`category`/`tag`/`author`/`archive`) emits its own findings: `no_layout`, `no_content`, `no_layout_tpl`, and `template_ok` (a template has both `_canai_html` and `_canai_layout`). Do not confuse this `template_ok` with the WC block's `template_body_ok` above — both can appear together in one scan response and mean different things. **`no_layout` is downgraded to `info` (from `warning`) and cross-references `unreachable_content`** when the WC block already reported that exact post as `unreachable_content` (v1.50.0 final-review fix): that post's `_canai_html` is already unreachable because a template-body shape is in effect, and assigning it a `_canai_layout` would **flip the shape** to delegate-body, displacing the template that currently renders and changing what the live URL shows. Never advise assigning a layout to a post flagged this way without first confirming the user wants that shape change.
- **Removed in v1.50.0:** `missing_delegate` and `stale_template_html`. Both asserted that a template must be an empty marker delegating to a page — one of two valid shapes, not a rule. They fired against working sites, and their guidance ("should be empty") would have deleted rendering content. Do not reintroduce that check.

### `wpcanai-get-wc-page-ids`

- **Args:** `{ "lang"?: string }` — when set, returns the per-language WC page ids via `pll_get_post`.
- **Returns:** `{ "cart": int, "checkout": int, "myaccount": int, "shop": int, "lang": string|null }` (WooCommerce page IDs; `0` if unset or no translation exists for that lang).

### `wpcanai-get-wc-css-reference`

- **Args:** `{ "context": string, "include_core"?: boolean }` — `context` is one of `cart`, `checkout`, `order-received`, `order-pay`, `myaccount-dashboard`, `myaccount-orders`, `myaccount-view-order`, `myaccount-downloads`, `myaccount-edit-account`, `myaccount-edit-address`, `myaccount-payment-methods`, `myaccount-add-payment-method`, `myaccount-lost-password`. `include_core` (default `false`) widens `third_party_hooks` to every registered callback on the context's hooks (WooCommerce core included), each still carrying its `is_third_party` flag. No `lang` parameter.
- **Returns:** `css_reference` (string — **raw SCSS source, not compiled CSS**; Sass variables/mixins arrive unresolved, so paraphrase rather than paste. WooCommerce's default rules for the context, drawn from `woocommerce.scss`, `woocommerce-layout.scss`, `woocommerce-smallscreen.scss`, and `forms.scss` of the *installed* WooCommerce, emitted with their full ancestor selector chain so you can match specificity; smallscreen rules arrive wrapped in `@media only screen and (max-width: 768px)`), `css_fallback` (`null`, or `"full-file"` when selector extraction found no match and the whole concatenated stylesheet was returned instead), `template_files` (string[], ABSPATH-relative — authoritative markup paths, theme override wins), `templates_missing` (string[], context-relative paths of expected-but-unreadable templates — not set-comparable with `template_files`; non-empty means the context map has drifted from the installed WooCommerce), `hooks_found` (string[] — actions the templates fire), `third_party_hooks` (objects `{hook, priority, callback, file, is_third_party}` — non-core/theme/WPCanAI callbacks only, or all of them when `include_core` is true), `context_echo` (`{context, include_core}`).
- **Read-only; static analysis only.** Nothing is rendered; no order/cart/customer data is read. See the "Styling WooCommerce blocks" workflow section above for how to use the output.

### `wpcanai-create-page`

- **Args:** `{ "title": string, "slug"?: string, "status"?: string, "html"?: string, "css"?: string, "js"?: string, "layout"?: int, "lang"?: string, "translation_of"?: int }` — `title` required; creates a `page` post with optional `_canai_*` meta. `lang` sets the new page's Polylang language. `translation_of` is the source page id; when provided, the new page is merged into the source's translation group.
- **Returns:** `{ "post_id": int, "slug": string, "lang": string|null }`.

### `wpcanai-read-settings`

- **Args:** `{ "keys"?: string[] }` — omit `keys` to read all whitelisted options.
- **Returns:** object of option key → value.
- **Whitelisted keys:** `show_on_front`, `page_on_front`, `page_for_posts`, `blogname`, `blogdescription`, `users_can_register`, `wpcanai_default_layout`, `wpcanai_tailwind_settings` (object: `load_tailwind` `yes`|`no`, `source` `cdn`|`plugin`, `plugins` string[]), `woocommerce_enable_signup_and_login_from_checkout`, `woocommerce_enable_myaccount_registration`, `woocommerce_cart_page_id`, `woocommerce_checkout_page_id`, `woocommerce_myaccount_page_id`, `woocommerce_shop_page_id`.

### `wpcanai-update-settings`

- **Args:** `{ "settings": { "<key>": <value>, ... } }` — only whitelisted keys (same as `wpcanai-read-settings`); setting `page_on_front` also sets `show_on_front` to `"page"` when appropriate.
- **Returns:** `{ "success": bool, "updated": string[] }`.
- **Whitelist is silent.** `read-settings` given only non-whitelisted keys returns the FULL whitelist (no error) — a data-bearing response is not confirmation your key exists. `update-settings` silently skips non-whitelisted keys and still returns `success: true`; verify against the returned `updated` list.

### `wpcanai-setup`

- **Args:** `{ }`.
- **Returns:** `{ "success": bool, "steps": array }` — each step: `action`, `status` (`done` | `skipped` | `error`), `detail` (recommended bootstrap: theme, layout, header, footer, home page, front page options, default layout, tailwind settings).

### `wpcanai-get-option`

- **Args:** `{ "name": string }` — `wp_options.option_name`.
- **Returns:** `{ "name": string, "value": mixed }`.
- **Policy:** The name must be on the **read allowlist** in **WP Admin → WPCanAI → AI Agent → Guardrails**. A denylist blocks dangerous keys (e.g. `active_plugins`, `cron`). Names starting with `wpcanai_mcp_` are always blocked (MCP internals). If **`WPCANAI_MCP_OPTIONS_UNRESTRICTED`** is defined in `wp-config.php`, any other non-denied name may be read.

### `wpcanai-update-options`

- **Args:** `{ "options": { "<option_name>": <value>, ... } }` — JSON-safe scalars and arrays only.
- **Returns (applied):** `{ "success": true, "status": "applied", "updated": string[], "pending_id": null }`.
- **Returns (queued):** `{ "success": true, "status": "pending_approval", "pending_id": string, "option_keys": string[], "message": string }` — no DB write until an administrator clicks **Approve** on **WP Admin → WPCanAI → AI Agent → Guardrails → Pending MCP option updates**.
- **Policy:** Configure **auto-apply** and **requires approval** allowlists on the **Guardrails** tab. If a name appears on both lists, **approval wins**. If **any** key in the request requires approval, the **entire** `options` object is queued as one pending request. Names must be on at least one write list (unless unrestricted mode). Same denylist as `get-option`.

### `wpcanai-get-pending`

- **Args:** `{ "pending_id": string }` — value returned by `wpcanai-update-options` when `status` is `pending_approval`.
- **Returns:** `{ "pending_id", "status": "pending"|"unknown", "created_at"?: int, "option_keys"?: string[], "message"?: string }` — `unknown` after approve/reject, expiry, or invalid id. Use this to poll after asking the user to approve in wp-admin.

### `wpcanai-i18n-get-settings`

- **Args:** `{ }`.
- **Returns:** `{ "default": string, "languages": [{ "slug", "native_name", "hreflang" }], "enabled": bool }` — `enabled` is `true` when at least one non-default language is configured. This is the **router probe**: call it first on any translation request (see **Translation model router**).

### `wpcanai-i18n-set-settings`

- **Args:** `{ "default": string, "languages": [{ "slug": string, "native_name"?: string, "hreflang"?: string }] }` — both required. **Replaces the entire language list** — include every language, not just the new one. `default` must be one of the slugs (else `invalid_input`). `native_name` / `hreflang` default to the slug.
- **Returns:** the resulting settings (same shape as `wpcanai-i18n-get-settings`).

### `wpcanai-i18n-list-strings`

- **Args:** `{ "lang": string, "untranslated"?: bool, "search"?: string }` — `lang` required (fills the translation column). `untranslated: true` keeps only strings whose translation is empty; `search` is a case-insensitive substring filter on the source text.
- **Returns:** `array` of `{ "source": string, "translation": string, "post_ids": int[] }` — `post_ids` are the posts whose `_canai_html` / `_canai_js` contain that `t()` source. Reads the **string index** — run `wpcanai-i18n-rescan` first if content changed.

### `wpcanai-i18n-set-translations`

- **Args:** `{ "lang": string, "translations": { "<source>": "<translated>", ... } }` — bulk upsert for ONE language. `lang` must be a configured **non-default** language (the default language IS the source text). An empty / `null` translation **deletes** the entry. Values are sanitized to **plain text — HTML is stripped**; keep markup outside `t()` sources. Source keys must match the stored source **verbatim** (character-for-character — don't trim or reflow).
- **Returns:** `{ "saved": int, "lang": string }`.

### `wpcanai-i18n-get-media-map`

- **Args:** `{ "lang"?: string }` — omit for all languages.
- **Returns:** object keyed by language slug: `{ "<lang>": { "<original_attachment_id>": <translated_attachment_id>, ... } }` — the per-language attachment swaps used by `{{ tmedia(id) }}`.

### `wpcanai-i18n-set-media-map`

- **Args:** `{ "lang": string, "map": { "<original_id>": <translated_id>, ... } }` — bulk upsert; non-default `lang` only. `0` / `null` deletes a mapping.
- **Returns:** `{ "lang": string, "map": { ... } }` — the language's resulting full map.

### `wpcanai-i18n-rescan`

- **Args:** `{ }` — rebuilds the string index from every post carrying `_canai_html` / `_canai_js`. Run after any content edit and before `wpcanai-i18n-list-strings`.
- **Returns:** `{ "posts_scanned": int }`.

### `wpcanai-i18n-get-post-overrides`

- **Args:** `{ "post_id": int, "lang"?: string }` — `lang` omitted returns every language's blob.
- **Returns:** `{ "post_id", "lang", "overrides": { title?, content?, excerpt?, fields?: {meta_key: value} } }` with `lang`, or `{ "post_id", "overrides_by_lang": { "<lang>": {...} } }` without. Empty object = no overrides (renders default-language values).

### `wpcanai-i18n-set-post-overrides`

- **Args:** `{ "post_id": int, "lang": string, "overrides": { "title"?, "content"?, "excerpt"?, "fields"?: { "<meta_key>": "<value>" }, "seo_title"?, "seo_description"? } }` — **sparse upsert**: only sent keys change; a `null`/`""` value **removes** that override (falls back to default language); an empty resulting blob deletes the row. `content` accepts HTML (`wp_kses_post`); `title`/`excerpt` are plain text; `fields` values plain text. `seo_title`/`seo_description` are plain text and feed the active SEO plugin (see REFERENCE.md → i18n → SEO translation). Rejects the default language (`invalid_lang`) — the post itself IS the default. Unknown top-level keys are silently dropped.
- **Returns:** `{ "post_id", "lang", "overrides": <resulting blob> }`.
- **Field keys are normalized** with `sanitize_key` on write (`"My_Field"` stored/matched as `my_field`); the render read path normalizes identically. `wpcanai-i18n-set-translations`' `saved` counts pairs SUBMITTED (including deletions / skipped non-strings), not pairs written.

### `wpcanai-i18n-get-term-overrides`

- **Args:** `{ "term_id": int, "lang"?: string }`.
- **Returns:** same shape as the post variant with blob keys `name` / `description`.

### `wpcanai-i18n-set-term-overrides`

- **Args:** `{ "term_id": int, "lang": string, "overrides": { "name"?, "description"?, "seo_title"?, "seo_description"? } }` — same sparse/delete/default-lang semantics as the post variant. `description` accepts HTML (`wp_kses_post`, like post `content`); `name` is plain text; `seo_title`/`seo_description` are plain text and feed the active SEO plugin (see REFERENCE.md → i18n → SEO translation).
- **Returns:** `{ "term_id", "lang", "overrides": <resulting blob> }`.

### Global strings — site-level copy not attached to any post

Site name, tagline, and archive/search/404 SEO title+description live in a per-language **global-string** store (option `wpcanai_i18n_global_strings`), separate from post/term overrides because they belong to no single post. On a non-default-language frontend they drive `option_blogname` / `option_blogdescription` + `og:site_name` (site name / tagline) and the `<title>` + meta description of the archive contexts `search`, `404`, and `post_type:<slug>`. Term archives (category / tag / custom taxonomy) are NOT global-string contexts — those use `wpcanai-i18n-set-term-overrides`.

### `wpcanai-i18n-get-global-strings`

- **Args:** `{ "lang"?: string }` — omit `lang` for every language.
- **Returns (scoped, `lang` given):** `{ "lang": string, "strings": { "site_name": string, "tagline": string, "archive": { "<context>": { "title", "description" } } } }`. `site_name` / `tagline` are `""` when unset. **Returns (all langs, `lang` omitted):** `{ "by_lang": { "<lang>": <blob> } }`. Read-only.

### `wpcanai-i18n-set-global-strings`

- **Args:** `{ "lang": string, "values": object }` — both required. `values` keys: `site_name` (plain text), `tagline` (plain text), `archive` (map of context → `{ "title"?, "description"? }`). **Sparse upsert:** only sent keys change; a `null`/`""` value **removes** that key; an empty resulting blob deletes the language row. **Rejects the default language** (`invalid_lang`) — the site's own name/tagline IS the default. Archive contexts are `search`, `404`, and `post_type:<slug>` (e.g. `post_type:product`); **term archives (category / tag / custom taxonomy) are NOT global-string contexts — translate those with `wpcanai-i18n-set-term-overrides`.**
- **Returns:** `{ "lang": string, "values": <resulting blob> }`.

### `wpcanai-i18n-list-content`

- **Args:** `{ "lang": string, "post_type"?: string, "untranslated"?: bool }` — the **content work queue**. `lang` must be a configured **non-default** language (the default is the source content; passing it errors `invalid_input`). Covers published posts of public post types except `attachment` (cap 1000 rows; an unknown `post_type` returns `[]`; narrow with `post_type` on big sites).
- **Returns:** `array` of `{ "id", "title", "post_type", "status" }` — `status`: `untranslated` (no blob), `partial` (blob but no `content` override while the post body is non-empty), `translated`. `untranslated: true` returns untranslated + partial rows.

### `wpcanai-i18n-get-content`

- **Args:** `{ "post_id": int, "fields"?: ["meta_key", ...], "lang"?: string }` — `post_id` required. `fields` names custom-field meta keys to include (normalized with `sanitize_key`, matching how overrides are stored). Optional `lang` (a configured, non-default language) also returns that language's current override blob for side-by-side comparison.
- **Returns:** `{ "post_id": int, "post_type": string, "source": { "title": string, "content": string, "excerpt": string, "fields": { "<meta_key>": value }, "seo": { "title": string, "description": string } }, "overrides"?: { "<lang>": blob } }` — `source` is the RAW default-language content (title/content/excerpt read straight off the post; named custom fields via meta; `seo` is the default-language SEO title/description read from the active SEO plugin). Read-only. This is the eval-free way to fetch the source an agent needs to translate before calling `wpcanai-i18n-set-post-overrides`.

### Presets — `wpcanai-list-presets` / `wpcanai-install-preset` / `wpcanai-uninstall-preset`

- **`wpcanai-list-presets`** → `{ presets: [{ slug, title, description }] }`. The bundled packs (e.g. `cpt-corporate`, `single-freelancer`) build a full template stack (layout/header/footer + typed `single-*`/`archive-*` templates).
- **`wpcanai-install-preset`** — `{ "slug": string, "set_front_page"?: bool, "clean_slate"?: bool, "adopt_woo_pages"?: bool, "trash_woo_pages"?: bool }`. Installs a pack's templates + pages, sideloads its images, and (v1.26+) wraps user-facing copy in `{{ t('…') }}` + adds a `languages()` switcher; the native-i18n StringIndex is warmed so `wpcanai-i18n-list-strings` shows the pack's strings immediately, even if languages are configured after install. Pack templates may reference `{{preset.image_id.<key>}}` to get a sideloaded attachment ID for `tmedia()`.
  - **⚠ `clean_slate: true` is destructive.** It **trashes ALL existing WPCanAI templates and pages** (recoverable from Trash) and clears preset bookkeeping **before** installing — and it runs even if the subsequent install fails. Never pass it without explicit user confirmation. MCP hosts expose this boolean in the tool schema with no built-in guard.
  - **`adopt_woo_pages` (default `true`, v1.47.0).** A pack with `settings.woo_pages` writes its content onto the store's **existing** WooCommerce pages instead of creating duplicates (`checkout-2`, …), preserving their IDs and permalinks so order-received URLs in already-sent emails keep working. Each adopted page's prior WPCanAI meta is snapshotted and restored by `wpcanai-uninstall-preset` — the page itself is never deleted. Pass `false` to force new pages (pre-v1.47.0 behavior; breaks previously issued order links).
  - **`trash_woo_pages` (default `false`).** Trashes the existing shop/cart/checkout/my-account pages (recoverable from Trash) so the pack's own store pages take those slugs. It runs **before** adoption, so it wins: the slots are empty by the time adoption looks, and fresh pages are created.
- **`wpcanai-uninstall-preset`** — `{ "slug": string }`. Removes a pack's templates/pages and tears down any nav menus it created.

### `wpcanai-export` / `wpcanai-import`

- **`wpcanai-export`** → a JSON bundle of WPCanAI templates + pages (meta `_canai_html/css/js/context/layout`), and a per-row `i18n_meta` key round-tripping every `_canai_i18n_{lang}` content-override blob. **(v1.39.0)** rows that have a compiled build also carry the precompiled Tailwind cache (`_canai_tailwind_build` / `_hash` / `_built_at`; only non-empty builds export, and the source-relative `_canai_tailwind_epoch` stamp is excluded) so an imported layout renders inline instead of falling back to the Play CDN. **Media binaries are NOT included** — attachment IDs are flagged for re-sideload, never remapped automatically.
- **`wpcanai-import`** — `{ "data": object | "json": string, "dry_run"?: bool }`. `dry_run: true` reports what would change without writing. Override blobs are re-sanitized on import. **Auth gate:** import performs `unfiltered_html`-level writes and returns a 403 `forbidden` unless the caller has the `unfiltered_html` capability (administrators do on single-site) or the request carries a valid WPCanAI API key (Bearer / `X-WPCanAI-API-Key`).

### `wpcanai-diagnostics`

- **Args:** `{ "include_network"?: bool }` (default `false`). → a health report mirroring the wp-admin **Diagnostics** page (PHP/WP/plugin versions, capability + endpoint checks, Tailwind build status, WooCommerce presence + HPOS-safety note).
- `include_network: true` additionally makes **real outbound HTTP requests** (outbound HTTPS, REST loopback, skills-endpoint reachability, auth-header pass-through) — slower; use it when connectivity or environment issues are suspected instead of guessing.

---

## Uploading media

**Two paths — pick by source:**

| Source | Use | Why |
|---|---|---|
| **Image is already a URL** (`https://…/photo.jpg` — e.g. hotlinked from a source site, a CDN, or a replica capture) | **MCP tool `wpcanai-sideload-url`** | The server fetches the bytes — tiny JSON over MCP, **no API key / base URL / curl needed**. Preferred. |
| **Local binary file** (a file on the user's machine, no public URL) | **sideload REST endpoint** (below) | MCP is a poor carrier for binary payloads (size + base64). |

### URL images → `wpcanai-sideload-url` (preferred, pure MCP)

Call the MCP tool — no credentials to gather, it rides the authenticated MCP transport:

```
wpcanai-sideload-url {
  "url": "https://example.com/images/hero.jpg",
  "alt": "Front of the product",     // optional
  "attach_to": 0                      // optional parent post id
}
```
Optional: `filename`, `title`, `caption`, `description`. Returns `{ id, source_url, mime_type, filename, attached_to }`. When writing `_canai_html`, prefer the returned **`id`** via `{{ image_attrs(id, 'src,alt') }}` / `{{ media_url(id, 'full') }}` (resolved at render time — see the **Prefer WPCanAI template functions** principle); only keep the absolute `source_url` where an absolute URL is required (OG/Twitter meta, web manifest). This is the right tool for replica/import flows where assets are hotlinked URLs.

### Local binary files → sideload REST endpoint

MCP messages aren't a good carrier for binary payloads (size + base64 overhead). Use the **sideload REST endpoint** instead. It accepts the **same** WPCanAI API key the MCP transport uses — no separate credential.

- **Endpoint:** `POST {site}/wp-json/wpcanai/v1/sideload`
- **Auth:** `Authorization: Bearer <wpcanai_…API key>` (or `X-WPCanAI-API-Key:`).
- **Body:** `multipart/form-data` with required field `file=@<local-path>`. Optional: `filename`, `title`, `alt`, `caption`, `description`, `attach_to` (parent post ID).
- **Returns:** `{ id, url, source_url, mime_type, filename, title, alt, attached_to }`.
- **Required cap on the API-key user:** `upload_files` (administrators have this).

### Workflow (one image at a time)

For **static-site imports** (user ran `/canai-mcp implement <folder>` or similar), don't ask — auto-detect referenced assets and sideload them as a pre-pass. See **Static-site asset sideload pre-pass** under "Implement HTML → WPCanAI". The steps below cover ad-hoc single-file uploads outside that flow.

1. Ask the user for the local file paths if they haven't already provided them.
2. For each file, POST it from the user's machine (one at a time so you can capture each `id`). `curl` is the simplest and is the one sanctioned shell exception:
   ```bash
   curl -sS -X POST "{site}/wp-json/wpcanai/v1/sideload" \
     -H "Authorization: Bearer <API key>" \
     -F "file=@/abs/path/to/image.jpg" \
     -F "alt=Front of the product"
   ```
   For a **Node-only** stack (no curl, no Python — Node 18+ has global `fetch`/`FormData`/`Blob`; see **Local scripting glue**), the zero-dependency equivalent is:
   ```bash
   node -e "const fs=require('fs');const f=new FormData();f.append('file',new Blob([fs.readFileSync(process.argv[1])]),require('path').basename(process.argv[1]));f.append('alt',process.argv[2]||'');fetch(process.argv[3]+'/wp-json/wpcanai/v1/sideload',{method:'POST',headers:{Authorization:'Bearer '+process.argv[4]},body:f}).then(r=>r.text()).then(console.log)" /abs/path/to/image.jpg "Front of the product" "{site}" "<API key>"
   ```
3. Capture the returned `id` and feed it into the template via the existing MCP tools — prefer `{{ image_attrs(id, 'src,alt') }}` / `{{ media_url(id, 'full') }}` in `_canai_html` (`wpcanai-write-meta`) over a pinned URL; keep the absolute `url` only where an absolute URL is required (OG/Twitter meta, web manifest).

Do **not** try to base64-encode files into MCP tool args — use this endpoint.

### Media SEO cleanup (`wpcanai-list-media` / `wpcanai-get-media` / `wpcanai-update-media`)

Clean up badly named uploads and missing alt text (plugin 1.45.0+):

1. **Audit** — `wpcanai-list-media { "missing_alt": true }` and/or `{ "generic_filename": true }`
   (camera/screenshot names like `IMG_4521.jpg`). Paginate with `page`/`per_page`.
2. **Context** — `wpcanai-get-media { "id": 123 }` returns full metadata plus `used_in`: the
   pages referencing the file. **Read those pages first** — alt text and filenames must describe
   what the image shows *in its page context*. Never derive alt text from the old filename.
3. **Fix** — `wpcanai-update-media { "id": 123, "alt": "…", "title": "…", "filename": "red-leather-office-chair" }`.
   - `filename` is a slug **without extension**; the file and every size variant are renamed on
     disk and **all internal references are rewritten** (post_content + `_canai_html`/`_canai_css`/`_canai_js` meta).
   - Old URLs 404 afterwards (no redirects) — re-check `used_in` pages render correctly after.
   - An explicit empty string clears a field. Metadata-only updates never touch files.
   - Local files only; offloaded (S3/CDN) media returns `file_missing`.

---

## CRITICAL: WPCanAI storage model

WPCanAI does **not** use `post_content` for template bodies. Use `**wpcanai-read-meta`** / `**wpcanai-write-meta`** for `_canai_html`, `_canai_css`, `_canai_js`, `_canai_context`, `_canai_layout`.

## CRITICAL: Content resolution

WC shop/cart/checkout/my-account/product-category content often lives on **WC pages**; product / 404 / search / archive types often on `**wpcanai_template`**. Use `**wpcanai-resolve-content-id`** before editing the wrong post.

---

## Translation model router

WPCanAI sites can be multilingual in one of **two mutually exclusive models**: **native string translation** (one post per page, site-wide string table, plugin 1.22.0+) or **Polylang** (per-language post copies). On ANY translation request — "translate this site/page", "add a language", "multilingual", "localize" — determine the model FIRST; do not assume Polylang:

1. Call `wpcanai-i18n-get-settings { }`.
   - `enabled: true` → the site uses **native string translation** — follow **Native string translation** below. Do NOT create per-language post copies or pass `translation_of`. (If Polylang is *also* active, that's the unexpected both-active case — see step 3.)
   - `enabled: false` → check Polylang: if post-targeting tools (e.g. `wpcanai-list-templates { }`) error with `lang_required`, or the user says Polylang is installed → follow **CRITICAL: Multi-language (Polylang)** below.
2. **Neither active** → propose **native string translation** (no extra plugin needed). Confirm the language list with the user — slugs, native names, hreflang codes, and which one is the default — then bootstrap with `wpcanai-i18n-set-settings` and continue with the native workflow.
3. **Both active** (unexpected) → stop and ask the user which model governs the site.

---

## Native string translation (single-post i18n)

**When to run:** the router above resolved to the native model — the user asked to translate the site/a page, add a language, fill missing translations, or localize images, and `wpcanai-i18n-get-settings` returns `enabled: true` (or you just bootstrapped it).

**Model (plugin 1.22.0+):** ONE post per page/template — no per-language copies. User-facing strings are wrapped in `{{ t('…') }}` in `_canai_html` / `_canai_js` and resolved at render time from a site-wide string table. Non-default languages are served under a **path prefix** (`/ms/plt/`); the default language is unprefixed. `hreflang` alternates are emitted on `wp_head`, and a `tmedia()` map swaps attachments per language.

### Workflow

1. **Settings** — `wpcanai-i18n-get-settings { }`. If languages are missing or wrong, confirm with the user and write with `wpcanai-i18n-set-settings` (it **replaces the whole list** — include ALL languages plus `default`).

2. **Authoring precondition — every user-facing string must be `{{ t('…') }}`.** Only `t()` sources are indexed and translatable. If pages carry hardcoded strings, wrap them first: `wpcanai-read-meta` → build replacement pairs → `wpcanai-replace-in-meta`, e.g. `{ "from": ">Shop now<", "to": ">{{ t('Shop now') }}<" }` (anchor on surrounding markup so the match is unique). Keep markup OUTSIDE the source: `<strong>{{ t('Best seller') }}</strong>`, never `{{ t("<strong>Best seller</strong>") }}` — translations are stored as plain text and HTML is stripped on save. When authoring NEW pages on a native-i18n site, wrap user-facing strings in `t()` from the start (see the helper table in **Implement HTML → WPCanAI**).

3. **Rebuild the index** — `wpcanai-i18n-rescan { }` after any content edit. `wpcanai-i18n-list-strings` reads the index, not live meta — a stale index lists stale strings.

4. **Translate — per non-default language:**
   - `wpcanai-i18n-list-strings { "lang": "ms", "untranslated": true }`
   - Translate every `source` yourself (agent-authored translations).
   - Write in **one bulk call**: `wpcanai-i18n-set-translations { "lang": "ms", "translations": { "Shop now": "Beli sekarang", "Add to cart": "Tambah ke troli" } }`.
   - Report a source → translation table so the user can spot-check; corrections are just another bulk call.

5. **Content (CPT / long-form) — per non-default language:**
   - `wpcanai-i18n-list-content { "lang": "ms", "untranslated": true }` → the work queue of posts whose title/body/fields still render in the default language.
   - Per post: `wpcanai-i18n-get-content { "post_id": <id>, "fields": ["subtitle", ...] }` returns the raw default-language `source` (`title`, `content`, `excerpt`, named custom `fields`). Translate it, then one `wpcanai-i18n-set-post-overrides { "post_id": <id>, "lang": "ms", "overrides": { "title": "…", "content": "…", "excerpt": "…", "fields": { "subtitle": "…" } } }`. (Pass `"lang": "ms"` to `i18n-get-content` to also see any existing override side-by-side.) Use the dedicated i18n tools — do not reach for PHP eval for content translation.
   - Taxonomy terms shown in loops/archives: `wpcanai-i18n-set-term-overrides` per term.
   - Report a per-post coverage table (id → status before/after). URLs don't change — the same post serves `/ms/…` with overridden fields (no per-language copies, no `translation_of`).
   - SEO metadata (title/description) translates via `seo_title`/`seo_description` override keys — read the source with `i18n-get-content` (see [references/REFERENCE.md](references/REFERENCE.md#internationalization-i18n) for the full SEO-bridge behavior). **You only need these keys when the SEO copy must differ from the visible title/body** — otherwise, on a non-default page, `seo_title`/`seo_description` auto-derive from the translated `title`/`name` and `excerpt`/stripped `content` (description truncated to ≤160 chars on a word boundary).

6. **Site-level strings (site name / tagline / archive SEO) — per non-default language:**
   - `wpcanai-i18n-get-global-strings { "lang": "ms" }` → the current site name, tagline, and archive map.
   - Translate, then write in one call: `wpcanai-i18n-set-global-strings { "lang": "ms", "values": { "site_name": "…", "tagline": "…", "archive": { "search": { "title": "…", "description": "…" }, "404": { "title": "…" } } } }`.
   - Archive contexts are `search`, `404`, `post_type:<slug>`. Category / tag / taxonomy titles are term overrides (step 5), not global strings.

7. **Media (when images must differ per language)** — upload the localized asset with `wpcanai-sideload-url`, then map it: `wpcanai-i18n-set-media-map { "lang": "ms", "map": { "123": 456 } }`. The template must resolve that image via `{{ tmedia(123) }}` / `{{ tmedia(123, 'large') }}` — it falls back to the original when no mapping exists; plain `media_url()` ignores the map.

8. **Verify in the browser** — fetch a prefixed URL (`{site}/ms/<page-slug>/`): translated strings render; `<head>` contains `<link rel="alternate" hreflang="…">` for every language; the canonical + `og:url` carry the `/ms/` prefix; `og:site_name` shows the translated site name and `og:locale` matches the language; `languages()` / `lang_url()` switcher URLs carry the prefix; the default language stays unprefixed.

### Gotchas

- **Plain-text translations.** `wpcanai-i18n-set-translations` strips HTML from values. Markup belongs in the template around `t()`, never inside it.
- **Verbatim keys.** A translation applies only when the `t()` source matches character-for-character. Don't trim, reflow, or re-punctuate source strings when passing them back.
- **The default language is read-only.** `wpcanai-i18n-set-translations` / `wpcanai-i18n-set-media-map` reject the default language — the source text IS the default rendering.
- **Stale index.** After editing `_canai_html` / `_canai_js`, rescan before listing.
- **No-op until configured.** With no non-default language, prefix routing / redirects / hreflang are off and `t()` / `tmedia()` pass through unchanged.
- **Content overrides are frontend-only.** Admin, REST edit contexts, and the default language always see the original values; only `/{lang}/` frontend renders swap.
- **Search matches default-language text only** — WP search doesn't index override blobs.

### Twig helpers

`t()`, `tmedia()`, `current_lang()`, `languages()`, `lang_url()` — see [references/REFERENCE.md](references/REFERENCE.md#internationalization-i18n). (`current_language()` / `language_switcher()` are Polylang-only.)

---

## CRITICAL: Multi-language (Polylang)

**This section applies only when the Translation model router (above) resolved to Polylang.** For the native single-post model, use **Native string translation** instead.

When **Polylang** is active, every `_canai_*` post lives in **per-language copies** linked into a translation group. As of plugin **1.8.6**, the MCP enforces a `lang` parameter on every tool that touches a post — calls without `lang` are **rejected** with `WP_Error('lang_required')`, and calls with a `lang` that doesn't match the post's actual language are **rejected** with `WP_Error('lang_mismatch')`. No silent default-language fallback, no auto-translation.

### Translation model (same as `canai-localwp`)

- **`wpcanai_template` posts are translatable** — each language has its own post.
- **`template_type` taxonomy is NOT translatable** — EN and MS templates share the term `shop` (intentional; type markers are shared).
- **`_canai_html`, `_canai_css`, `_canai_js`, `_canai_context`, `_canai_context_mode` are COPIED** on translation. **`_canai_layout` and `_canai_delegate_page_id` are TRANSLATED.**
- **WC delegate pages are per-language.** Frontend reads the current-language delegate's `_canai_html`.

### The `lang` contract

When `function_exists('pll_current_language')` is true:

- **10 abilities require `lang`:** `list-templates`, `list-pages`, `read-meta`, `write-meta`, `replace-in-meta`, `create-template`, `resolve-content-id`, `scan`, `get-wc-page-ids`, `create-page`. Missing → `lang_required`. Unknown slug (not in `pll_languages_list()`) → `unknown_lang`.
- **Mismatch is a hard error.** `read-meta` and `write-meta` compare `lang` against the post's actual Polylang language and return `lang_mismatch` if they disagree. There is **no auto-translate** — pass the language-specific `post_id`.
- **Returned objects expose language.** `list-templates` and `list-pages` rows now include a `lang` field; `resolve-content-id` and `get-wc-page-ids` echo `lang` in their response so you can confirm what language was resolved.
- **Polylang inactive → `lang` ignored.** The same MCP client code works against monolingual installs without changes.
- **Escape hatch.** `define('WPCANAI_MCP_LANG_OPTIONAL', true)` in `wp-config.php` short-circuits the rejection (legacy blind behavior). Use only for emergencies or single-language Polylang installs.

### Recommended workflow

1. **Confirm the language** with the user before any write ("are we editing the EN or MS shop page?").
2. **Resolve the right post ID** with `lang`:

   ```js
   wpcanai-resolve-content-id { "type": "shop", "lang": "ms" }
   // → { content_post_id: <MS shop page id>, ..., lang: "ms" }

   wpcanai-list-templates { "lang": "ms" }
   // → only MS rows, each row has lang: "ms"
   ```

3. **Read / write with `lang`:**

   ```js
   wpcanai-read-meta { "post_id": <MS id>, "lang": "ms", "fields": ["html"] }
   wpcanai-write-meta { "post_id": <MS id>, "lang": "ms", "html": "..." }
   ```

   Mismatched lang (`{post_id: <EN id>, lang: "ms"}`) → `lang_mismatch` error, no write.

4. **Create a new translation linked into the source group** in one call:

   ```js
   wpcanai-create-template {
     "title": "Shop MS",
     "type": "shop",
     "lang": "ms",
     "translation_of": <EN-shop-template-id>
   }
   ```

   `translation_of` (also on `create-page`) sets the new post's language and merges it into the source post's existing translation group via `pll_save_post_translations`. Without `translation_of`, the new post just gets its language assigned (no translation links).

5. **Audit missing translations** with `wpcanai-scan` per language:

   ```js
   wpcanai-scan { "lang": "ms" }   // findings tagged "[ms] ..."
   wpcanai-scan { "lang": "en" }
   ```

   Compare the two outputs to spot templates / delegates present in EN but absent in MS.

### Twig helpers in templates

WPCanAI exposes `current_language()`, `language_switcher()`, `__()`, `_x()`, `_n()` for language-aware markup — see [references/REFERENCE.md](references/REFERENCE.md#internationalization-i18n).

---

## Common workflows (generic notation)

Use **tool name + JSON arguments**; map to your host's MCP call syntax. Examples below omit `lang` for clarity; **on Polylang sites add `"lang": "<slug>"` to every call** (and `read-meta`/`write-meta` will reject mismatches).

### Edit or remove a section in existing HTML

1. **Resolve ID** — `wpcanai-list-pages` `{ }` or `wpcanai-resolve-content-id` `{ "type": "shop" }` (etc.). Use returned `content_post_id` (or row `id` from list-pages).
2. **Read** — `wpcanai-read-meta` `{ "post_id": <id>, "fields": ["html"] }` (add other fields if needed).
3. **Edit in place** — change the HTML string in your reasoning/response (see **HTML manipulation** below). No Python or shell required.
4. **Write** — `wpcanai-write-meta` `{ "post_id": <id>, "html": "<full updated HTML>" }`. When updating HTML, typically send the **complete** new `_canai_html` string (this is supported at any size). For small, surgical changes — swapping a handful of substrings like asset URLs — prefer `wpcanai-replace-in-meta` instead (next recipe) so you don't resend the whole document.

### Fix broken asset URLs on an existing page

When a live page references the wrong asset URLs (e.g. relative paths left over from an import, or a moved CDN), fix them without rewriting the whole document:

1. **Resolve ID** — `wpcanai-list-pages` / `wpcanai-resolve-content-id` → the page/template `post_id`.
2. **Get live URLs into the media library** — for each missing asset: a hotlinkable URL → `wpcanai-sideload-url`; a **local binary file** → the sideload **REST endpoint** (`POST {site}/wp-json/wpcanai/v1/sideload`, the one sanctioned `curl` — see **Uploading media**). Capture each returned `source_url`.
3. **Build a from→to map** of `{ <old/broken reference exactly as it appears> : <new source_url> }`. Include each variant that appears in the HTML (`./img/x.png`, `img/x.png`, `/img/x.png`).
4. **Apply** — `wpcanai-replace-in-meta` `{ "post_id": <id>, "field": "html", "replacements": [{ "from": "...", "to": "..." }, ...], "require_all": true }`. One call per affected field/page. Check each `count` (and let `require_all` flag any `from` that didn't match). Repeat with `"field": "css"` / `"js"` if assets are referenced there.

### Create a new template

1. `wpcanai-create-template` `{ "title": "...", "type": "component", "html": "...", "css": "..." }`
2. If layout is needed: `wpcanai-write-meta` `{ "post_id": <new_id>, "layout": <layout_post_id> }`
3. **Polylang sites:** to create the MS counterpart linked to the EN source, pass `lang` and `translation_of` in one call: `wpcanai-create-template { ..., "lang": "ms", "translation_of": <EN-id> }`.

### Diagnose configuration

- `wpcanai-scan` `{ }` — delegate, layout, and template issues. On Polylang sites, run once per language (`{ "lang": "en" }`, `{ "lang": "ms" }`) and diff to spot missing translations.

---

## Compile Tailwind for Production

**When to run:** the user says `/canai-mcp optimize production`, `/canai-mcp compile tailwindcss`, `compile tailwind`, `build css`, `tailwind build`, or otherwise asks to precompile Tailwind for the live site. Do **not** run this automatically on every template edit — it is an explicit, opt-in optimization step.

**What it does:** the default Tailwind delivery is the Play CDN (`tailwind.min.js` from the plugin or `cdn.tailwindcss.com`), which JIT-compiles utilities in the visitor's browser on every page load. This workflow precompiles CSS on the agent side and stores it as meta. The server emits the prebuilt CSS inline and skips the Play CDN script when a build is present — visitors get static CSS, the agent does the work.

**Build unit = the layout.** Compile **one** CSS bundle per **layout**, scanning the layout *plus every page/template that renders through it*, and store it **on the layout post**. The server collects the layout's build at render time (the layout post is rendered on every page that uses it) and emits it once. This keeps the compiled CSS findable in one place — the layout's **Compiled Tailwind CSS** panel in the WPCanAI Editor — instead of scattered across every page.

### Storage contract

| Meta key | Lives on | Purpose |
|---|---|---|
| `_canai_tailwind_build` | The **layout** post (`wpcanai_template`, type `layout`) | Compiled CSS for the layout + all its consumers. `AssetManager::output_assets_head` emits it as `<style id="wpcanai-tailwind-css">` and skips Play CDN for pages rendered through that layout. |
| `_canai_tailwind_hash` | Same layout post | *Optional, agent-side only.* sha256 of the inputs that produced the build. Compare before recompiling — skip when unchanged. Not required for staleness detection; the server tracks freshness via `_canai_tailwind_epoch` (see **Server-side freshness** below). |
| `_canai_tailwind_epoch` | Same layout post | Set automatically on write — the source epoch the build was compiled at. The server compares it to the global epoch to decide staleness. You don't set this yourself. |
| `_canai_tailwind_built_at` | Same layout post | Unix timestamp, set automatically by `wpcanai-write-meta` when a non-empty `tailwind_build` is written (drives the panel's "built N ago"). You don't set this yourself. |

Empty / missing → server falls back to Play CDN. **Dedup guard:** if a layout in the render set has a build, the server emits *only* layout builds and **ignores any per-page `_canai_tailwind_build`** — so stale builds left on pages by the old per-page model can't double-emit. Manual wp-admin edits still work; they just use the runtime CDN until the next compile.

**Server-side freshness (automatic).** On every `tailwind_build` write the server stamps the build with the current global *source epoch* (`_canai_tailwind_epoch`), and bumps that epoch whenever any template source (`_canai_html/css/js`) or the Tailwind settings change. At render, a build whose stamp is behind the current epoch is treated as **stale** and the page falls back to the Play CDN (correct, just slower) instead of emitting outdated CSS — so a page is **never left unstyled** after an edit, even before you recompile. This is why the `tailwind_hash` below is now *optional*: correctness no longer depends on it. The Diagnostics page and the layout's **Compiled Tailwind CSS** panel show which builds are stale. After editing templates, recompile the affected layouts to return them to inline delivery.

### Workflow

1. **Read Tailwind settings** to capture the plugin set:

   ```
   wpcanai-read-settings { "keys": ["wpcanai_tailwind_settings"] }
   ```

   Use the returned `plugins` array (e.g. `["forms", "container-queries"]`) when invoking the compiler. If `load_tailwind` is `no`, stop and tell the user to enable it first (there is no Tailwind to compile).

2. **Enumerate layouts** — `wpcanai-list-templates {}`, keep rows where `type` is `layout`. Each layout is one compile target. On Polylang sites, run once per language (layouts are per-language) and treat each language's layout as independent.

3. **Resolve each layout's consumer set** — every post whose effective layout is this one:
   - `wpcanai-list-pages {}` and `wpcanai-list-templates {}` rows whose `layout_id` equals this layout's id.
   - WC delegate bodies: `wpcanai-resolve-content-id { "type": "shop" }` (and `cart`, `checkout`, `my-account`, `product-category`) → the `content_post_id` whose `_canai_layout` resolves to this layout.
   - If this layout is `wpcanai_default_layout`, also include posts with **no** explicit `_canai_layout` (they fall back to it).

4. **Build the union content** — concat, in one string: the layout's own `_canai_html`, plus every consumer's `_canai_html`, plus any partials referenced via `{% include 'slug' %}` / `{{ wpcanai_template('slug') }}` (header / footer — resolve each slug → post id → read its `_canai_html`). Write to a temp `.html` file so the Tailwind scanner picks up every class actually used anywhere on that layout.

5. **Hash the inputs** — sha256 over `union_content + "\n--\n" + plugins.sort().join(",") + "\n--\n" + tailwind_version`. Compare with the **layout's** existing `_canai_tailwind_hash`. Equal → skip this layout, count as "skipped (already current)". Use the actual **v3** version you compile with as `tailwind_version` so the hash is stable across machines (and so an accidental v4 build invalidates it rather than colliding). Hash with **Node, not Python** (see **Local scripting glue**) — e.g. `node -e "const c=require('crypto'),fs=require('fs');console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" hash-input.txt`.

6. **Compile locally** (no server compilation), **with Tailwind v3 — not v4**. The runtime delivery is the Tailwind **v3** Play CDN (`cdn.tailwindcss.com`, plus the prebuilt bundles in `assets/lib/tailwind/`), so the precompiler MUST be v3 to match it. Two runners, both work without `npm run build`:
   - `npx tailwindcss@^3 -i input.css -o /dev/stdout --content "<temp.html>"`. **Do not** use `npx @tailwindcss/cli` — that package is Tailwind **v4** and produces a broken build (see warning below).
   - The Tailwind standalone binary from a **v3** release (e.g. `tailwindcss-macos-arm64` from a `v3.4.x` tag — single executable, no Node). Pin v3 explicitly; the "latest" binary is v4.
   `input.css` is `@tailwind base; @tailwind components; @tailwind utilities;`. Plugins from step 1 enable via a temp `tailwind.config.js` (`plugins: [require('@tailwindcss/forms'), ...]`). Because it's one build per layout, **Preflight/base is compiled once**, not once-per-page.

   > **⚠ Use v3, never `@tailwindcss/cli`.** Under Tailwind **v4** this exact recipe silently produces a **mobile-only build**: v4 ignores both `--content` and `tailwind.config.js`, and the legacy `@tailwind base/components/utilities` directives don't load v4's default theme — so every utility that needs a theme token is dropped (`--breakpoint-*` → **no responsive `md:`/`lg:` variants**, `--spacing` → no `p-2`, font sizes → no `text-sm`); only theme-less statics like `flex`/`hidden` survive. Tailwind v3 honours `@tailwind` directives, `tailwind.config.js`, and `--content` correctly.

7. **Verify the build, then persist to the layout.** Before writing, **sanity-check the compiled CSS**: it must be non-trivially sized and contain at least one `@media (min-width:` rule (i.e. responsive utilities were emitted). If it does not — the classic symptom of having compiled with v4 — the build is broken (mobile-only); **do not persist it**, count the layout as failed, and leave the working Play-CDN fallback in place (an empty/missing `_canai_tailwind_build` means the server keeps serving the CDN). Once it passes, write with `wpcanai-write-meta`:

   ```
   wpcanai-write-meta {
     "post_id": <layout_id>,
     "tailwind_build": "<full compiled CSS>",
     "tailwind_hash": "<sha256>"
   }
   ```

   Then **clear stale per-page builds** on consumers that still carry one (from older per-page compiles): `wpcanai-write-meta { "post_id": <consumer_id>, "tailwind_build": "", "tailwind_hash": "" }`. The dedup guard already ignores them, but clearing keeps the data honest and the panels accurate. On Polylang sites, include `"lang": "<slug>"` and use the language-specific layout id. Only `wpcanai-write-meta` persists these fields — do not use other write paths.

8. **Report** — `X layouts compiled, Y skipped (already current), Z failed`, plus how many consumer per-page builds were cleared. List failures with the layout id and reason.

### Verifying the result

View a frontend page in the browser. The `<head>` should contain `<style id="wpcanai-tailwind-css">…</style>` and **no** `<script src=".../tailwind.min.js">`. If the Play CDN script still appears: the page's layout has an empty `_canai_tailwind_build` (re-check step 7 wrote to the right **layout** id — including the per-language layout on Polylang), the page renders through a *different* layout than the one you compiled, or `load_tailwind` is `no`.

### When to re-run

Whenever any input to a layout's build changes: the layout's own `_canai_html` (**including its inline `tailwind.config = {…}` block** — new tokens there are invisible at runtime once compiled, since the server skips the Play CDN), **any consumer page/template's `_canai_html`**, a shared partial (header/footer), `_canai_layout` assignments, or the plugin set in `wpcanai_tailwind_settings`. Note the per-layout tradeoff: **editing any single consumer re-stales the whole layout build.** The hash check in step 5 makes "always re-run" cheap — it only recompiles layouts whose union actually moved.

### Runtime behavior after compile

When the rendered page's layout has a non-empty `_canai_tailwind_build`, `AssetManager::output_assets_head` emits that build (only — see the dedup guard) **and** a one-line shim: `<script id="wpcanai-tailwind-shim">window.tailwind=window.tailwind||{config:{}};</script>`. The shim makes the layout's inline `tailwind.config = { ... }` (after `{{ wp_head() }}`) a harmless property write instead of `TypeError`. Consequence: that block has **no visual effect** post-compile — every theme token must be present in the temp `tailwind.config.js` passed to the compiler. The layout post is enqueued for build pickup even when it has no `_canai_css`/`_canai_js`, so a layout that only carries a build still emits correctly.

### Limits / gotchas

- **Union size per layout.** A layout's build contains every class used across all its consumers, so each page ships more CSS than a perfectly per-page build would. In exchange you dedup the shell (header/footer/layout) and Preflight, and the CSS is findable in one place. Fine for typical sites; if one layout fans out to a very large, content-diverse set of pages and CSS size becomes a concern, split those pages onto a second layout.
- **Re-stale coupling.** Because the build is per-layout, editing *any* consumer invalidates the whole layout build. The hash skip keeps recompiles cheap, but expect the layout to recompile after most content edits.
- **Migration from per-page builds.** Existing installs have builds on pages. Until the first per-layout recompile, the dedup guard keeps them correct (layout build wins when present; otherwise per-page builds still emit). Step 7's clear pass removes them as you go.
- **Arbitrary values.** `class="text-[#abc123]"` works (Tailwind JIT scans literal strings); just ensure the value is literal in the Twig source, not constructed at render time. `class="text-{{ color }}"` won't be detected — same constraint as any Tailwind build.
- **Custom `tailwind.config = {…}` in the layout.** Mirror it into the temp `tailwind.config.js` or compiled output misses those tokens. Extraction is fragile: the inline block is a JS object literal, not JSON (trailing commas, single quotes, unquoted keys, function values, comments). Evaluate it in **Node** (not Python — see **Local scripting glue**): write `module.exports = { ... }` to the temp `tailwind.config.js` and let the compiler `require()` it, so the object literal is parsed by the same engine that authored it. Fail loudly if extraction can't produce a valid config rather than silently shipping a build missing tokens.

---

## HTML manipulation guidance

- Templates use `**{# Twig comments #}`** for section labels; use them to find boundaries (see [REFERENCE.md](references/REFERENCE.md) for comment rules).
- **Remove a block:** delete from its opening Twig comment (or identifiable start) through the end of that section (next sibling section comment, closing structural tag, or include line).
- **Edit a block:** replace only the markup inside that section; keep the rest of the string unchanged.
- Build the final string **in the agent** and pass it to `**wpcanai-write-meta`** — no external scripts required.

---

## Action router (quick)


| Goal                             | Tools                    |
| -------------------------------- | ------------------------ |
| List templates                   | `wpcanai-list-templates`     |
| List WPCanAI pages                   | `wpcanai-list-pages`         |
| Read fields                      | `wpcanai-read-meta`          |
| Write fields                     | `wpcanai-write-meta`         |
| New template post                | `wpcanai-create-template`    |
| New page (with WPCanAI meta)         | `wpcanai-create-page`        |
| Read WP / WC / WPCanAI options       | `wpcanai-read-settings`      |
| Update WP / WC / WPCanAI options     | `wpcanai-update-settings`    |
| Read arbitrary wp_option (allowlist) | `wpcanai-get-option`         |
| Update arbitrary wp_options (allowlist / approval) | `wpcanai-update-options` |
| Poll pending option update           | `wpcanai-get-pending`        |
| Recommended site bootstrap       | `wpcanai-setup`              |
| Which post ID for a type?        | `wpcanai-resolve-content-id` |
| WC page IDs                      | `wpcanai-get-wc-page-ids`    |
| Diagnose                         | `wpcanai-scan`               |
| Diagnose environment / network    | `wpcanai-diagnostics`        |
| List / install / remove a preset  | `wpcanai-list-presets` / `wpcanai-install-preset` (⚠ `clean_slate`) / `wpcanai-uninstall-preset` |
| Export / import WPCanAI content    | `wpcanai-export` / `wpcanai-import` |
| FluentSnippets / PHP eval (opt-in) | **`canai-yolo`** skill — not documented here |
| Precompile Tailwind for production | `wpcanai-write-meta` with `tailwind_build` + `tailwind_hash` (see **Compile Tailwind for Production**) |
| Translate a site (native i18n)   | see **Native string translation** workflow |
| Read / set native i18n languages | `wpcanai-i18n-get-settings` / `wpcanai-i18n-set-settings` |
| List translatable strings        | `wpcanai-i18n-list-strings`  |
| Write translations (bulk)        | `wpcanai-i18n-set-translations` |
| Per-language images (`tmedia`)   | `wpcanai-i18n-get-media-map` / `wpcanai-i18n-set-media-map` |
| Rebuild the string index         | `wpcanai-i18n-rescan`        |
| Post content overrides (CPT/long-form) | `wpcanai-i18n-get-post-overrides` / `wpcanai-i18n-set-post-overrides` |
| Term name/description overrides  | `wpcanai-i18n-get-term-overrides` / `wpcanai-i18n-set-term-overrides` |
| Content translation work queue   | `wpcanai-i18n-list-content`  |
| Read post source to translate    | `wpcanai-i18n-get-content`   |
| Site name / tagline / archive SEO (global strings) | `wpcanai-i18n-get-global-strings` / `wpcanai-i18n-set-global-strings` |


---

## Security

- Treat API keys like passwords; revoke in **AI Agent → Connections** when unused.
- Prefer HTTPS for non-local sites.

