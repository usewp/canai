# Task: page → semantic single-HTML file (canai-prepare format)

You are converting one captured web page into a **single self-contained HTML file** that conforms to the **canai-prepare** format. The result will be ingested by WPCanAI on the WordPress side.

## What you must do

1. Read the **screenshot** (full-page PNG) — this is the layout reference. Then read each file in **`sections/`** to study individual blocks (header, hero, content sections in document order, footer); the index in **`sections.json`** lists each PNG with its role, tag, class, and dimensions.
2. Read **content.json** — this is the **content ground truth**. It mirrors the section structure: `{ header, main: [section, …], footer }`. Each main entry has `id`/`role`/`tag`/`className` plus its own headings, paragraphs, lists, links, images, forms, buttons, tables, definitionLists, and labelValuePairs. The `id` field matches the screenshot filename in `sections/` (e.g. `id: "hero"` ↔ `sections/NN-hero.png`). All text, links, image src/alt, headings, and button labels MUST come from here, verbatim. Do **not** invent copy.
   - **`tables`** — one entry per `<table>`: `{ caption, headers, rows, pairs }`. `headers` is the column-header row's cell text (`[]` if the table has none); `rows` is every other row as an array of cell text, in column order. `pairs` is only present (non-`null`) when every data row has exactly 2 cells — the common "attribute / value" shape (a WooCommerce product's Color/Size attributes table, a spec sheet) — as `{ label, value }`. Render a `pairs` table as a simple two-column list/table; render a `headers`+`rows` table (3+ columns, e.g. a comparison or pricing table) as a real `<table>` with `<thead>`/`<tbody>`, preserving column order.
   - **`definitionLists`** — one entry per `<dl>`: `{ pairs: [{ label, value }, …] }`, from `<dt>`/`<dd>` pairs.
   - **`labelValuePairs`** — standalone `{ label, value }` pairs found in plain wrapper markup outside any table/dl (e.g. a product SKU rendered as `<span class="sku_wrapper">SKU: <span class="sku">BB-123</span></span>`). Treat each as a labeled fact about the page/product — render it, don't drop it just because it isn't a `<table>`/`<dl>` in the source.
3. Read **DESIGN.md** — the site-wide style system. All typography, colors, spacing, radii, motion treatments must conform to its tokens. Encode the relevant tokens in a `tailwind.config = { ... }` inline script.
4. Read **assets.json** — keep image URLs external; use them as `<img src="https://...">` directly. Do not embed.
5. Read **ux.json** — the interactive-pattern inventory for this page (nav toggle, dropdown menu, tabs, accordion, carousel, modal, sticky header). For each entry, reproduce it with the **exact, verbatim** recipe from the Alpine recipe library (path given under Inputs below) — copy its HTML structure and Alpine attributes as given, substituting only real content; instant-state only, no transitions, no autoplay. Don't invent interactivity that isn't listed, and don't invent an alternative to a recipe that already covers the pattern (e.g. a `window.innerWidth` check instead of `nav-toggle`'s `lg:!block` — Alpine has no built-in reactivity to `window.innerWidth` at all, so that substitution silently stops updating across the breakpoint; this is a real bug this literal-recipe rule exists to prevent, not a hypothetical one).
6. Write **one HTML file** matching the canai-prepare boilerplate (below) to the output path specified at the end of this prompt. One `<section>` per entry in `content.json:main` — preserving order. Do **not** write your own `<header>`/`<footer>` markup from `content.json:header`/`content.json:footer` — see the next rule.

## Strict rules

- **Never write a Twig call's real curly-brace syntax inside an HTML
  comment.** Twig parses `{{ }}`/`{% %}`/`{# #}` delimiters wherever they
  appear in the source, comment or not — a "helpful" comment explaining
  what `{{ wpcanai_template('header') }}` does, written that way, is itself
  a second real call Twig will execute. If a file needs to document the
  include mechanism, describe it in prose ("the wpcanai_template Twig
  helper") instead of quoting the literal syntax — this is exactly how
  `header.html`/`footer.html` (see `transform-chrome.md`) triggered real
  infinite self-recursion (a PHP memory-limit fatal) the first time either
  was rendered, not a hypothetical risk.
- **Site chrome (header/footer) is shared, never inlined.** Do not write your own `<header>`/`<footer>` element. Emit `{{ wpcanai_template('header') }}` immediately inside `<body>` and `{{ wpcanai_template('footer') }}` immediately before `</body>` instead — see the skeleton below. These two Twig partials are generated **once per site** (`output/templates/header.html` / `footer.html`, a separate pass — see `transform-chrome.md`) and shared by every one-off page and every page-type template. Writing your own copy here is exactly the drift bug this rule exists to prevent: on a real migration, two outputs for the same site independently inlined the header and **disagreed** with each other (different nav-link counts, different dropdown menus) — not a hypothetical, something that actually shipped. Navigation itself is WordPress-menu-driven (`get_menu('wpcanai_primary')` / `get_menu('wpcanai_footer')`, inside the shared partials) rather than hardcoded links — that is `transform-chrome.md`'s job, not yours; you only ever *include* the partials, never author nav links directly in a page.
- **Semantic HTML5 only**: `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<footer>`. No nav links inside `<header>` without `<nav>`.
- **Tailwind utility classes inline**. **No `<style>` blocks** in prepared HTML (WPCanAI stores CSS in `_canai_css` separately).
- **Tailwind via Play CDN** wrapped in WPCanAI preview markers (see skeleton).
- **Alpine.js** only if real state is needed (dropdowns, tabs, accordions, modals). Otherwise omit. When it is needed, match the closest recipe in `alpine-recipes.md` rather than inventing new interaction code — instant-state only, no `x-transition`, no autoplay.
- **Lucide icons** via `<i data-lucide="kebab-case-name" class="h-5 w-5"></i>` plus the `lucide.createIcons()` init.
- **Section comments**: `<!-- Section: Hero -->`, `<!-- Section: Features -->`, etc. — these map to `{# Section: … #}` in Twig downstream.
- **Cross-page links**: emit relative filenames (`href="about.html"`, not `/about` or absolute URLs), unless the link is genuinely external.
- **DESIGN.md tokens > screenshot pixels**. The screenshot is for layout/structure; DESIGN.md governs the look.
- **Content from content.json verbatim**. If the screenshot shows copy that isn't in content.json, omit it — never paraphrase, never invent.
- **No frameworks** beyond Tailwind utilities + optional Alpine. No React, Vue, Svelte, bundlers, JSX.
- **No `<title>` duplication concerns** — keep a real `<title>` for local preview; WPCanAI handles this on the live site.

## Canonical skeleton

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page Title</title>
  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only; WPCanAI loads these via wp_head() on the live site -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.5/dist/cdn.min.js"></script>
  <script src="https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
  <script>
    // Tokens from DESIGN.md. Replace with real values for this site.
    tailwind.config = {
      theme: {
        extend: {
          colors: { /* extracted from DESIGN.md */ },
          fontFamily: { /* extracted from DESIGN.md */ },
        },
      },
    };
  </script>
</head>
<body class="antialiased">
  <!-- Section: Site header — shared site chrome, generated once per site; see transform-chrome.md. Never inline your own <header> here. -->
  {{ wpcanai_template('header') }}

  <!-- Section: Main page body — maps to this page's _canai_html -->
  <main id="main-content">
    <!-- Section: Hero -->
    <section> ... </section>
    <!-- Section: Next -->
    <section> ... </section>
  </main>

  <!-- Section: Site footer — shared site chrome, generated once per site; see transform-chrome.md. Never inline your own <footer> here. -->
  {{ wpcanai_template('footer') }}

  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
```

## Authoritative reference

The full canai-prepare format spec — preview markers, layout/header/footer split, Alpine patterns, Lucide conventions, asset paths, `pages.json` — is documented in the **canai-prepare skill** (and its `references/BOILERPLATE.md`). If anything in this prompt conflicts with the skill, the skill wins.

## Quality bar

- `{{ wpcanai_template('header') }}` / `{{ wpcanai_template('footer') }}` are present in the right place, and are the ONLY header/footer markup in the file — no inlined `<header>`/`<footer>` alongside them.
- Hero section reproduces the headline, subheadline, primary CTA from `content.json`.
- All sections in the screenshot have a corresponding `<section>` with a section comment.
- Every image has a meaningful `alt` from `content.json` (or `alt=""` if decorative).
- Tailwind classes use DESIGN.md tokens (e.g. `bg-brand` not `bg-teal-600`) where DESIGN.md defines them.
- Output is well-formed and validates as HTML5.
- The file's own content (everything between the two `wpcanai_template()` calls) opens cleanly in a browser via `file://` and is recognizable as the same page. The two `wpcanai_template()` calls themselves render as literal Twig text under a raw `file://` open — that's expected, not a defect: nothing local resolves Twig (`replica verify` has no Twig engine, by design), so the include is verified after deploy on the live WordPress site, where `wpcanai_template()` actually runs.
