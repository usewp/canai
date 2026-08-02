# Task: page → static fidelity draft (page-mode / canai-prepare format)

You are converting one captured web page into a **single self-contained HTML file** for **page-mode** fidelity verify. The result is a static draft that opens under `file://` without WordPress — header and footer are inlined. After verify passes, handoff swaps chrome to Twig includes.

Your job is **replication**, not redesign. Pixel gate scoring fails when you invent layout, CTAs, headings, or sections that are not in the capture.

## What you must do

1. Read the **full-page screenshots** first — `fullpage-desktop.png` (width 1440) and `fullpage-mobile.png` (width 390). These are the primary visual truth. Then study per-block detail in **`sections-desktop/`** and **`sections-mobile/`** (compat alias **`sections/`** = desktop). Section indexes: `sections-desktop.json`, `sections-mobile.json`, and compat `sections.json`.
2. Read **content.json** — this is the **content ground truth**. It mirrors the section structure: `{ header, main: [section, …], footer }`. Each main entry has `id`/`role`/`tag`/`className` plus its own headings, paragraphs, lists, links, images, forms, buttons, tables, definitionLists, and labelValuePairs. The `id` field matches the screenshot filename in the section dirs (e.g. `id: "hero"` ↔ `NN-hero.png`). All text, links, image src/alt, headings, and button labels MUST come from here, verbatim. Do **not** invent copy.
   - **`tables`** — one entry per `<table>`: `{ caption, headers, rows, pairs }`. `headers` is the column-header row's cell text (`[]` if the table has none); `rows` is every other row as an array of cell text, in column order. `pairs` is only present (non-`null`) when every data row has exactly 2 cells — the common "attribute / value" shape — as `{ label, value }`. Render a `pairs` table as a simple two-column list/table; render a `headers`+`rows` table (3+ columns) as a real `<table>` with `<thead>`/`<tbody>`, preserving column order.
   - **`definitionLists`** — one entry per `<dl>`: `{ pairs: [{ label, value }, …] }`, from `<dt>`/`<dd>` pairs.
   - **`labelValuePairs`** — standalone `{ label, value }` pairs found in plain wrapper markup outside any table/dl. Treat each as a labeled fact — render it, don't drop it.
3. Read **DESIGN.md** — the site-wide style system. All typography, colors, spacing, radii, motion treatments must conform to its tokens. Encode the relevant tokens in a `tailwind.config = { ... }` inline script. If DESIGN.md is missing, stop and create it first via a one-page design pass — do not invent a page-local token system ad hoc.
4. Read **assets.json** — keep image URLs external; use them as `<img src="https://...">` directly. Do not embed.
5. Read **ux.json** — the interactive-pattern inventory for this page (nav toggle, dropdown menu, tabs, accordion, carousel, modal, sticky header). For each entry, reproduce it with the **exact, verbatim** recipe from the Alpine recipe library (path given under Inputs below) — copy its HTML structure and Alpine attributes as given, substituting only real content; instant-state only, no transitions, no autoplay. Don't invent interactivity that isn't listed, and don't invent an alternative to a recipe that already covers the pattern.
6. Read **libs.json** — third-party library hints from capture. Use it only to choose the right Alpine recipe when UX patterns are ambiguous. **Never CDN-include or script-tag any library listed in libs.json.** Stack is Tailwind + Alpine recipes + Lucide only.
7. Write **one HTML file** matching the page-mode skeleton (below) to the output path specified at the end of this prompt. One `<section>` per entry in `content.json:main` — preserving order. **Inline** real `<header>` and `<footer>` markup from `content.json:header` / `content.json:footer` (no Twig).

## Section-by-section authoring (required)

Author **one section at a time**. Do not draft the whole page from memory of a “typical landing page.”

For **each** entry in `content.json:main` (and for header/footer):

1. Open the matching slice PNG (`sections-desktop/NN-<id>.png` and `sections-mobile/NN-<id>.png`). If the file is missing, still render from `content.json` only — do not invent a replacement block.
2. Read that entry’s fields only: `headings`, `paragraphs`, `links`, `buttons`, `images`, lists, tables, etc.
3. **Classify layout** against the **layout composition recipes** file listed under Inputs (`layout-recipes.md`). Pick one recipe name (e.g. `hero-stacked-center`, `hero-split-media-end`). Emit `<!-- layout: <recipe-name> -->` immediately before the landmark. Match **layout geometry** to the section PNG before picking Tailwind classes:
   - stacked / centered vs 2-column vs multi-column grid
   - image left/right/full-bleed vs text-only
   - CTA placement (under headline, beside form, in a bar, etc.)
   - Approximate vertical rhythm (padding / gap) so the section is not crushed or oversized vs the slice
4. Start from that recipe’s HTML skeleton; substitute only this entry’s content.json fields. Emit exactly one `<section>` (or the header/footer landmark) whose visible copy is a subset of that entry’s content.json fields — never a superset.

**Hero rule:** The first `role: "hero"` (or first main band if none) must use a `hero-*` recipe. Re-check the desktop slice before choosing split vs stacked — defaulting to `lg:grid-cols-2` without a clear two-column PNG is a common failure.

**Forbidden inventions (common failure modes):**

- Do **not** invent section titles, eyebrow labels, slogans, or headings that are not in that entry’s `headings` (and related text fields). If `headings` is empty, do not invent an `<h1>`/`<h2>` — use the paragraph/link content that exists.
- Do **not** invent or swap CTA / button labels. Use `buttons` and `links` text **verbatim** and in the order they appear for that section. If the PNG shows one primary CTA, it must be the same label as in `content.json` for that band — never substitute a nav item or another section’s button (e.g. do not put a neighbor section’s “Testimonials” link into the hero when the hero entry’s only link is something else).
- Do **not** add sections, stats bands, testimonial cards, or media blocks that have no matching `content.json:main` entry.
- Do **not** drop or merge `content.json:main` entries to “simplify” the page — missing blocks shrink full-page height and fail the height gate.
- Do **not** invent carousel/slider slide people, quotes, or labels. Every slide’s text and images must come from that section’s content.json fields (or the Alpine recipe’s content slots filled from those fields only).
- Do **not** prefer a fashionable layout (e.g. hero 2-col `grid lg:grid-cols-2`) when the section PNG is clearly stacked/centered (or vice versa). Screenshot geometry wins over landing-page priors — see `layout-recipes.md` anti-priors.
- Do **not** paraphrase, translate, or “improve” marketing copy.

## Strict rules

- **Inline `<header>` / `<footer>` from `content.json` (no Twig).** Page-mode drafts must open under `file://` for local verify. Write a real `<header>…</header>` and `<footer>…</footer>` from the captured chrome content. Do **not** emit Twig `wpcanai_template` includes — handoff will swap them later.
- **Tailwind + Alpine recipes + Lucide only; never CDN-include `libs.json` libraries.** No Swiper, jQuery, GSAP, Bootstrap, or any other third-party script/CSS from the source page's library inventory. Interactive patterns come exclusively from `alpine-recipes.md`. Icons via Lucide (`data-lucide` + `lucide.createIcons()`).
- **Custom CSS only in a single `<style data-wpcanai-css-escape>` block.** Prefer Tailwind utilities. When an effect cannot be expressed in utilities (keyframes, sticky edge cases, rare selectors), put minimal CSS in one `<style data-wpcanai-css-escape>` block — pushprep already routes `<style>` → `css` / `_canai_css`. No layout rewrite in CSS. No third-party CDN CSS. Parallel rule: tiny Alpine-adjacent helpers may go in a single `<script>` that pushprep routes to `_canai_js` when unavoidable.
- **Mobile-first against 390 full-page + `sections-mobile/`.** Author responsive classes against `fullpage-mobile.png` and `sections-mobile/` first, then layer desktop (`lg:` / `xl:`) to match `fullpage-desktop.png` / `sections-desktop/`. Do not design desktop-only and hope mobile works.
- **Content from `content.json` verbatim.** If the screenshot shows copy that isn't in content.json, omit it — never paraphrase, never invent. If content.json has copy the screenshot also shows, you must include it.
- **Semantic HTML5 only**: `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<footer>`. No nav links inside `<header>` without `<nav>`.
- **Tailwind via Play CDN** wrapped in WPCanAI preview markers (see skeleton).
- **Alpine.js** only if real state is needed (dropdowns, tabs, accordions, modals, carousels listed in ux.json). Otherwise omit. When it is needed, match the closest recipe in `alpine-recipes.md` — instant-state only, no `x-transition`, no autoplay.
- **Lucide icons** via `<i data-lucide="kebab-case-name" class="h-5 w-5"></i>` plus the `lucide.createIcons()` init.
- **Section comments**: `<!-- Section: Hero -->`, `<!-- Section: Features -->`, etc. — these map to `{# Section: … #}` in Twig downstream. Comment titles may describe role; **visible** headings still must match `content.json`.
- **Cross-page links**: emit relative filenames (`href="about.html"`, not `/about` or absolute URLs), unless the link is genuinely external.
- **DESIGN.md tokens for look; section PNGs for structure.** Tokens govern color/type/radius; section screenshots govern composition and CTA placement. Do not let DESIGN.md “taste” override geometry.
- **No frameworks** beyond Tailwind utilities + optional Alpine. No React, Vue, Svelte, bundlers, JSX.
- **No `<title>` duplication concerns** — keep a real `<title>` for local preview; WPCanAI handles this on the live site.
- **Never write a Twig call's real curly-brace syntax inside an HTML comment.** Twig parses delimiters wherever they appear — including comments. Describe includes in prose if needed; do not quote literal Twig call syntax in comments.

## Canonical skeleton (page-mode)

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
  <!-- Optional: only when Tailwind utilities cannot express a needed effect -->
  <style data-wpcanai-css-escape>
    /* keyframes / sticky / rare selectors only — no layout rewrite */
  </style>
</head>
<body class="antialiased">
  <!-- Section: Site header — inlined from content.json for page-mode local verify -->
  <header> ... </header>

  <!-- Section: Main page body -->
  <main id="main-content">
    <!-- Section: Hero -->
    <section> ... </section>
    <!-- Section: Next -->
    <section> ... </section>
  </main>

  <!-- Section: Site footer — inlined from content.json for page-mode local verify -->
  <footer> ... </footer>

  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
```

## Authoritative reference

The full canai-prepare format spec — preview markers, Alpine patterns, Lucide conventions, asset paths — is documented in the **canai-prepare skill** (and its `references/BOILERPLATE.md`). If anything in this prompt conflicts with the skill on stack conventions, the skill wins; page-mode chrome inlining (this prompt) overrides the full-site Twig-include rule until handoff.

## Quality bar

- Real inlined `<header>` / `<footer>` from `content.json` are present — no Twig chrome includes.
- Hero (and every other section) matches its section PNG composition via a named `<!-- layout: … -->` recipe from `layout-recipes.md`, and uses only that entry’s `content.json` headings / CTAs / images — no invented titles or swapped buttons.
- One `<section>` per `content.json:main` entry, same order; no dropped or invented blocks (full-page height should be in the same ballpark as `fullpage-*.png`).
- Every image has a meaningful `alt` from `content.json` (or `alt=""` if decorative).
- Tailwind classes use DESIGN.md tokens (e.g. `bg-brand` not `bg-teal-600`) where DESIGN.md defines them.
- Mobile layout matches `fullpage-mobile.png` / `sections-mobile/` at 390; desktop matches 1440 refs.
- No CDN scripts for libraries listed in `libs.json`.
- At most one `<style data-wpcanai-css-escape>` block; empty or omitted when unused.
- Output is well-formed and validates as HTML5.
- The file opens cleanly in a browser via `file://` and is recognizable as the same page at both viewports.

## On verify retry (`page-report` status `in-progress`)

When re-transforming after a failed hard gate, open
`runs/<site>/verify/page-report.md` (and `.json`) first. Prioritize the
**Section notes (worst first)** list — each entry is `viewport/id` with
mismatch % and height Δ against the capture slice. Fix those sections
against the matching `sections-desktop/` or `sections-mobile/` PNG and
`content.json` entry before touching unrelated blocks. Re-check CTA labels
and layout geometry for the worst `id`s (use `layout-recipes.md`). Do not
invent new copy or CTAs while patching.

**Stagnation:** if the next `verify-page` does not improve combined severity
by at least `--min-severity-improvement` (default 1.0), the run fails early
as stagnant — do **not** loosen `--max-mismatch` / `--max-height-delta` to
force a pass.
