# Preparing HTML for a block page

`canai-prepare` emits browser-previewable HTML. When the target is blocks, the HTML must also map
one-to-one onto the v1 block types (see `html-to-blocks.md`). Apply these constraints on top of
`canai-prepare`'s own rules; the preview stays a plain HTML file that opens in a browser.

## Structure

- **One `<section>` per top-level landmark**, each preceded by `<!-- Section: Name -->`. The
  section becomes a `group` (tag `section`) and its class list becomes that group's `className`.
- **Header and footer are not prepared.** The site layout (`_canai_layout`) provides them; emit
  only what goes inside `{{ page_content }}`. For a browser preview you may wrap the sections in
  a bare `<main>`; it is dropped on mapping.
- **Nesting:** at most 4 levels of blocks. A section → columns → column → heading is already
  4. Flatten anything deeper.
- **Only shapes with a block equivalent:** headings `h2`–`h6` (never `h1`; the page title is the
  h1), paragraphs, flat `ul`/`ol`, `blockquote`, `img`, `pre><code`, `hr`, `table`, embeds by
  URL, one-level column grids, button rows, a cover (background image + content), image beside
  text, spacers.

## Classes

- Put the class list that matters on the element that **becomes the block root**: the
  `<section>`, the grid container, each column, the heading, the paragraph, the image, the
  buttons container. Those become `className`.
- Utilities on inner elements the mapping cannot reach are **written as CSS**, not classes:
  the `<a>` of a button, `<li>` items, `<td>`/`<th>`, the cover overlay. Target the block's own
  class in `<slug>.css`:

  ```css
  .probe-cta .wp-block-button__link { border-radius: 9999px; padding: 0.75rem 1.5rem; }
  .feature-list li { margin-bottom: 0.5rem; }
  ```

  where `probe-cta` / `feature-list` are custom classes you also put in the block's `className`.
- Keep the preview honest: in the prepared HTML, give the inner element the same rule through a
  `<link rel="stylesheet" href="pages/<slug>.css">` so the browser preview and the deployed page
  match.

## Not allowed

- Page-logic `<script>` (anything that runs in the page — Alpine or otherwise), Alpine attributes
  (`x-data`, `@click`, …), `<svg>`, `<i data-lucide>`, icon fonts.
- Inline `style=""`.
- Nested lists, definition lists, `<details>`, `<form>`, `<iframe>` other than an embed URL.
- Text that mixes markup and copy beyond `<a>`, `<strong>`, `<em>`, `<br>`, `<code>`, `<s>`,
  `<sub>`, `<sup>`, `<kbd>`, `<mark>`; anything else is stripped silently at write time.

**Exception: `WPCanAI-PREVIEW-LIBS`.** The `canai-prepare`-mandated preview-library `<script>`
block inside the `WPCanAI-PREVIEW-LIBS` markers is exempt from the `<script>` ban above — it is
what makes the file open correctly (styled, Tailwind-rendered) in a plain browser. It is
preview-only: it is never mapped into any block and is discarded entirely at mapping time.

## Images

- Relative `assets/…` paths as usual; descriptive `alt`. The mapping step sideloads each one and
  swaps in the attachment id. One `<img>` per asset; no CSS background images except on the one
  element that becomes a `cover`.
