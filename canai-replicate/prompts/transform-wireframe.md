# Task: page → low-fidelity wireframe (wireframe objective / canai-prepare format)

You are converting one captured web page into a **single self-contained static HTML wireframe**. Real copy, real geometry, real interaction — **no brand styling**. The result opens under `file://` with header and footer inlined and is gated by `verify-structure` (every section/heading/image/video present) plus a full-page **height** check at 1440 and 390. Pixel mismatch is never scored for a wireframe.

Your job is **structure and composition**, not look. Do not read DESIGN.md. Do not invent a palette.

## What you must do

1. Read the **full-page screenshots** first — `fullpage-desktop.png` (width 1440) and `fullpage-mobile.png` (width 390) — for overall rhythm and section heights. Then read each block in **`sections-desktop/`** and **`sections-mobile/`** (indexes: `sections-desktop.json`, `sections-mobile.json`).
2. Read **content.json** — the **content ground truth**: `{ header, main: [section, …], footer }`. Each main entry carries `id`/`role`/`tag` plus `headings`, `paragraphs`, `lists`, `links`, `images`, `videos`, `forms`, `buttons`, `tables`, `definitionLists`, `labelValuePairs`. Every visible string comes from here, verbatim. Never invent copy.
3. Read **ux.json** and reproduce each listed pattern with the **verbatim** recipe from `alpine-recipes.md` (nav toggle, dropdown, tabs, accordion, modal, sticky header). A **carousel** degrades to a stacked list of its slides — no slider in a wireframe.
4. Write **one HTML file** (skeleton below) to the output path at the end of this prompt. One `<section>` per `content.json:main` entry, same order. Inline a real `<header>` and `<footer>` from `content.json:header` / `footer` (no Twig).

## Section-by-section authoring (required)

For **each** `content.json:main` entry (and header/footer):

1. Open its desktop and mobile slice PNG. Classify the composition with `layout-recipes.md` and emit `<!-- layout: <recipe-name> -->` before the landmark. Geometry (stacked vs split, grid columns, CTA placement, approximate vertical padding) must match the slice.
2. Fill the recipe's slots with **this entry's fields only** — a subset of its `content.json` text, never a superset.
3. Keep the section's rendered height in the same ballpark as its slice: a wireframe that collapses a 900px hero into 200px fails the height gate.

## Wireframe palette (fixed — do not vary)

| element | classes |
| --- | --- |
| page | `bg-white text-neutral-900 antialiased` |
| section separators | `border-t border-neutral-300` |
| headings | Tailwind default scale only: `text-4xl font-semibold` (h1), `text-2xl font-semibold` (h2), `text-xl font-medium` (h3+) |
| body copy | `text-base text-neutral-700` |
| primary button | `inline-block rounded bg-neutral-800 px-5 py-3 text-white` |
| secondary button / link | `inline-block rounded border border-neutral-400 px-5 py-3 text-neutral-800` |
| image | grey box — see below |
| video / embed | grey box with `aspect-video` — see below |
| cards / panels | `rounded border border-neutral-300 p-6` |
| nav links | `text-neutral-800 underline-offset-4 hover:underline` |

No other colours, no fonts, no shadows, no gradients, no icons except Lucide `menu`/`x`/`chevron-down` where a recipe needs one.

## Media placeholders (required shape)

Every `images[]` entry becomes a labelled grey box that keeps its **real `src` and `alt`** for `verify-structure`:

```html
<figure class="relative w-full overflow-hidden rounded bg-neutral-200 aspect-[4/3]">
  <img src="https://cdn.example.com/hero.png" alt="Hero" class="absolute inset-0 h-full w-full object-cover opacity-0" loading="lazy">
  <figcaption class="absolute inset-0 flex items-center justify-center text-sm text-neutral-600">image · Hero</figcaption>
</figure>
```

Use `aspect-[w/h]` from the entry's `width`/`height` when both are present, `aspect-video` for `videos[]`, `aspect-square` for avatars/logos. The `<img>` stays in the DOM (opacity 0) so the src is present; the box is what renders.

Every `videos[]` entry keeps its real source the same way:

```html
<div class="relative w-full overflow-hidden rounded bg-neutral-200 aspect-video">
  <iframe src="https://www.youtube.com/embed/abc" title="Demo" class="absolute inset-0 h-full w-full opacity-0" loading="lazy"></iframe>
  <p class="absolute inset-0 flex items-center justify-center text-sm text-neutral-600">video · youtube · Demo</p>
</div>
```

(`kind: "video"` → `<video src="…" poster="…" class="… opacity-0"></video>` inside the same box.)

## Strict rules

- **Inline `<header>` / `<footer>` from `content.json` (no Twig).**
- **Tailwind utilities only; no `<style>` block; no DESIGN.md tokens; no `tailwind.config` extension.**
- **Alpine recipes only** for interaction; instant-state, no transitions, no autoplay.
- **Content from `content.json` verbatim.** If the screenshot shows copy that isn't in `content.json`, omit it.
- **Semantic HTML5 only**: `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<footer>`.
- **Section comments**: `<!-- Section: Hero -->` etc. before every landmark (they become `{# Section: … #}` downstream).
- **Cross-page links**: relative filenames (`href="about.html"`) unless genuinely external.
- **Mobile-first** against the 390 slices, then `lg:` utilities to match 1440.
- **Never quote literal Twig delimiters in a comment.** Describe includes in prose.

## Forbidden inventions

- No invented headings, eyebrows, slogans, CTAs, stats bands, testimonial cards, slides or sections.
- No dropped or merged `content.json:main` entries.
- No brand colours "to make it look nicer" — that is the `styled` objective's job.

## Canonical skeleton (wireframe)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page Title — wireframe</title>
  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only; CanAI loads these via wp_head() on the live site -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.5/dist/cdn.min.js"></script>
  <script src="https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</head>
<body class="bg-white text-neutral-900 antialiased">
  <!-- Section: Site header — inlined from content.json for wireframe local verify -->
  <header class="border-b border-neutral-300"> ... </header>

  <!-- Section: Main page body -->
  <main id="main-content">
    <!-- Section: Hero -->
    <!-- layout: hero-stacked-center -->
    <section class="px-6 py-24"> ... </section>
    <!-- Section: Next -->
    <!-- layout: band-cards -->
    <section class="border-t border-neutral-300 px-6 py-20"> ... </section>
  </main>

  <!-- Section: Site footer — inlined from content.json for wireframe local verify -->
  <footer class="border-t border-neutral-300"> ... </footer>

  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
```

## Quality bar

- `verify-structure` passes: one `<section>` per main entry in order, every heading text, every image `src`, every video `src`, every form and table present.
- Full-page height at 1440 and 390 within 20% of `fullpage-desktop.png` / `fullpage-mobile.png`.
- Every landmark carries a `<!-- layout: … -->` recipe name that matches its slice.
- No colour class outside the palette table above.
- Opens cleanly via `file://` and reads as the same page's skeleton at both widths.
