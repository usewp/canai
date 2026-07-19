---
name: canai-prepare
description: >
  Prepares WPCanAI-friendly static sites as one self-contained HTML file per page: semantic HTML5,
  Tailwind utility classes, vanilla JS or Alpine.js for interactivity, Lucide icon markup.
  Use when the user asks to prepare HTML for WPCanAI, single-html pages, image/mockup to HTML,
  screenshot to HTML, SPA or PWA to static pages, static site export, or "canai-prepare".
  Triggers on: "canai-prepare", "prepare html", "image to html", "mockup to html", "screenshot to html",
  "spa to html", "pwa to html", "static html", "single html", "per-page html", "convert design to html".
metadata:
  author: canai
  version: "1.2.2"
allowed-tools: Bash Read Write Edit Grep Glob
---

# WPCanAI Prepare — single-HTML static pages

Generate **recommended static markup** for later import into **WPCanAI**: one **complete HTML document per page** (no React/Vue/build tools). Styling is **Tailwind CSS** utilities only; behavior is **vanilla JS** or **Alpine.js**; icons are **Lucide** (`data-lucide`).

**Assume the agent runs in the user’s own folder** (not necessarily the WordPress root). This skill focuses on **WPCanAI-compatible, integration-ready** single-HTML output only — no requirement for WP-CLI, `.env.wplocal`, or writing under `wp-content/`.

See [references/BOILERPLATE.md](references/BOILERPLATE.md) for the canonical skeleton, Alpine/Lucide patterns, and `pages.json` format.

## Purpose

- Output goes into the **current working directory** (or a user-specified output path). Files use **relative** asset paths so the project folder is self-contained and portable — it can later be copied into WordPress uploads, served locally, or handed off to `**canai-localwp`** / `**canai-mcp**` for import.
- Files are **WPCanAI-shaped**: section comments, semantic regions, and class names that map cleanly to Twig + `_canai_css` / `_canai_js` later.

## Tech stack (strict)


| Allowed        | Notes                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| Semantic HTML5 | `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<footer>`                |
| Tailwind CSS   | Utility classes only; **no** `<style>` blocks in prepared HTML (WPCanAI stores CSS in `_canai_css`) |
| Vanilla JS     | Small IIFE or `DOMContentLoaded` handlers at end of `<body>`                                  |
| Alpine.js      | Use when stateful UI is simpler than hand-written JS (dropdowns, tabs, accordions)            |
| Lucide         | `<i data-lucide="icon-name" class="h-5 w-5"></i>`                                             |



| Disallowed                                                    |
| ------------------------------------------------------------- |
| React, Vue, Svelte, Angular, bundlers, JSX, `.vue` SFCs       |
| Tailwind CLI/build step in this skill (Play CDN classes only) |
| Heavy CSS frameworks besides Tailwind utilities               |


## Library injection — WPCanAI handles it on the site

WPCanAI outputs the same libraries through WordPress hooks when enabled in **WP Admin → WPCanAI** settings (`TailwindManager`, `IconManager`, `AssetManager`):


| What the static preview file simulates                                                            | Where WPCanAI loads it                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<title>…</title>`                                                                                | `**wp_head()`** — WordPress outputs the document title (page/post SEO title); do not duplicate a literal `<title>` inside `_canai_html` if the theme/layout already prints it via `wp_head()` |
| `<script>` tags for Tailwind Play CDN, Alpine, Lucide UMD (inside `WPCanAI-PREVIEW-LIBS` in `<head>`) | `**wp_head()**` — enqueue/inject head scripts the theme/WPCanAI pipeline would print before `</head>`                                                                                           |
| `<script>lucide.createIcons();</script>` (inside `WPCanAI-PREVIEW-LIBS` before `</body>`)             | `**wp_footer()**` — footer scripts (icon init and similar)                                                                                                                                  |


**Do not assume** every site has the same toggles: tell the user to enable **Load Tailwind**, **Lucide**, and **Alpine** (if templates use `x-`*) as needed.

Prepared `.html` files still include **preview-only** copies of those scripts so the file can be opened in a browser **outside** WordPress. Wrap them in:

```html
<!-- WPCanAI-PREVIEW-LIBS:START -->
...
<!-- WPCanAI-PREVIEW-LIBS:END -->
```

When importing into WPCanAI, **strip** the preview blocks from markup you paste into templates — WPCanAI will supply Tailwind/Lucide/Alpine via `**wp_head()`** / `**wp_footer()**` instead. Page-specific JS stays **outside** the preview markers (maps to `_canai_js`).

## Layout mapping — header / footer vs main content

In a **full static HTML** file, you may include `<header>` and `<footer>` for preview and for SPA splits. After import into WPCanAI, the usual split is:

- `**<header>...</header>`** → a **header**-type template component (site navigation shell), conventionally the **site header** component used by the main **layout** template.
- `**<footer>...</footer>`** → a **footer**-type template component, conventionally the **site footer** component used by the main layout.
- `**<main>...</main>`** (page body) → the page or type-specific template’s `**_canai_html**` (inside `{{ page_content }}` in the layout).

When generating **linked single-HTML files** (Workflow B), duplicating header/footer across files is fine for static preview; on import, extract shared regions once into `**wpcanai_template('site-header')`** / `**wpcanai_template('site-footer')**` (or the project’s actual header/footer slugs) and keep only `<main>` (and layout-specific sections) in each page template.

## Output paths

Default: write under `**./<project-slug>/**` in the **current working directory** (or a path the user specifies). No WordPress root or uploads folder is required.

```
<project-slug>/
  index.html
  about.html
  ...
  assets/
    hero.webp
    ...
  pages.json          # optional; multi-page / SPA decomposition
```

- `**project-slug`:** kebab-case, short (e.g. `landing-q2`, `shop-redesign`).
- `**assets/`:** binary media copied from designs or exported from SPAs; reference with **relative** paths (`src="assets/photo.jpg"`).
- **Cross-page links:** relative (`href="about.html"`), not absolute domain.

## Workflow A — Image / mockup → HTML

1. Accept screenshot, Figma export, or other reference image(s).
2. Infer layout: header, hero, sections, footer; typography scale; spacing; color **roles** (map to Tailwind palette + optional `tailwind.config` extend in a small inline script **only if needed** — prefer standard utilities).
3. Emit **one `.html` file per distinct full-page design** the user asked for.
4. Label sections with HTML comments: `<!-- Section: Hero -->`, `<!-- Section: Features -->`, … (these become `{# Section: … #}` in Twig).
5. Save extracted raster assets into `assets/`; reference them relatively. Use stable filenames; optionally list them in a short `README.txt` in the project folder.

## Workflow B — SPA / PWA → linked static HTML pages

1. Discover routes: router config (`react-router`, Vue Router, Next.js `app/`, etc.), `sitemap`, nav links, or user-provided list.
2. For **each route**, generate **one self-contained HTML file** (duplicate header/footer/nav per file — no partials in this skill).
3. Replace client-side navigation with normal `**<a href="...">`** links between generated files.
4. Downgrade framework components to semantic HTML + Tailwind + Alpine/vanilla behavior.
5. Write `**pages.json**` — array of `{ "slug", "title", "file" }` for traceability.

## WPCanAI compatibility checklist

- Section comments use a consistent `<!-- Section: Name -->` pattern.
- No `<style>` in body content; no inline `style=""` unless unavoidable (prefer utilities).
- Scripts: preview libs inside `WPCanAI-PREVIEW-LIBS`; page logic below, outside those markers.
- Images: descriptive `alt`, `width`/`height` when known, `loading="lazy"` below the fold.
- Lucide: decorative icons `aria-hidden="true"`; controls have `aria-label`.
- Links: readable link text; avoid `href="#"` for real navigation.

## Handoff to WPCanAI

1. **Settings:** Enable Tailwind, Lucide, and Alpine (if used) in WPCanAI settings so scripts load via `**wp_head()`** / `**wp_footer()**` as above.
2. **Document title:** Set the WordPress page/post title (and SEO plugin fields if used); `**wp_head()`** outputs `<title>` on the live site — omit a duplicate `<title>` from imported template fragments when the layout already includes `{{ wp_head() }}`.
3. **Layout:** Move header markup into the **site header** component template; footer into the **site footer** component; wire them from the main **layout** template (`{{ wpcanai_template('site-header') }}`, `{{ wpcanai_template('site-footer') }}` — use the project’s actual slugs).
4. **Import:** Use `**canai-localwp`** (convert HTML → Twig, write `_canai_html` / `_canai_css` / `_canai_js`) or `**canai-mcp**` for remote sites — follow those skills for storage rules (e.g. no `post_content` for WPCanAI bodies).
5. **Strip** `WPCanAI-PREVIEW-LIBS` blocks when pasting into templates (avoid duplicating what WPCanAI already injects).
6. **Images become ID-based helpers at import, not here.** Prepared `.html` keeps **relative** `src="assets/…"` so the folder previews in a plain browser. On import, `canai-mcp` / `canai-localwp` sideloads each asset and rewrites `<img>` → `{{ image_attrs(id, 'src,alt') }}` (and other surfaces → `{{ media_url(id, size) }}`) by media **id** — so keep the prepared markup clean and swappable: one `<img>` per asset, a descriptive `alt`, `width`/`height` when known, and no inline `style` that would fight the helper output.
7. **Section comments map 1:1 on import:** every `<!-- Section: X -->` you emit is converted to `{# Section: X #}` Twig (HTML nav comments are never carried into `_canai_html`). Keep the `Section:` prefix and one comment per top-level landmark so the editor's structure menu populates cleanly.
8. **Keep copy translation-ready.** On native-i18n target sites, downstream import turns every user-facing string into a `{{ t('…') }}` translation source. Write copy so each string is a clean, self-contained phrase with **no markup inside it** — `<strong>Best seller</strong>` (wrap the text, not the tag), never a string that bakes in HTML. This mirrors the image → `image_attrs()` and section-comment handoffs.
9. **WooCommerce pages** — for shop / cart / checkout pages, emit the cart/checkout region as a single clearly-commented placeholder section (e.g. `<!-- Section: Cart — replaced by wc_cart_block() on import -->`) rather than hand-building line items. Downstream (`canai-localwp` / `canai-mcp`) swaps in the `wc_*` Twig helpers; do not wire helper markup here.

## Related skills

- `**canai-localwp`** — WP-CLI, `.env.wplocal`, template meta fields (use when working inside a WordPress checkout).
- `**canai-mcp**` — MCP tools for `_canai_*` on the configured server.

