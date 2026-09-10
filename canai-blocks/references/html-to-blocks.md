# HTML → block list, and the deploy

Input: HTML prepared under `prepare-for-blocks.md`. Output: the `wpcanai-write-page` payload and
its CSS, as files, then the deploy.

## Files

Alongside `canai-prepare`'s output:

```
<project-slug>/
  about.html              # canai-prepare preview (links pages/about.css)
  pages/
    about.blocks.json     # { "title", "slug", "layout"?, "status"?, "blocks": [ … ] }
    about.css             # the write-page css field, verbatim
  assets/                 # images; sideloaded at deploy
```

`about.blocks.json` is the exact `write-page` argument object minus `post_id` (added at deploy)
plus `title`/`slug` for `create-page`. Image blocks carry `"id": null` until sideload fills them.

## Mapping table

| Prepared HTML | Block | Notes |
|---|---|---|
| `<section class="…">` | `group` `{ "tag": "section", "className": "…", "blocks": […] }` | children map recursively |
| `<div class="…">` wrapping several blocks | `group` `{ "tag": "div", … }` | only when it carries classes that matter; otherwise unwrap |
| `<h2>`–`<h6>` | `heading` `{ "level": n, "text", "className" }` | `h1` never; the page title is the h1 |
| `<p>` | `paragraph` `{ "text", "align"?, "className" }` | inline `<a>`, `<strong>`, `<em>`, `<br>` survive |
| `<ul>` / `<ol>` | `list` `{ "items": [...], "ordered", "className" }` | flat only; a nested list is flattened and reported |
| `<blockquote>` | `quote` `{ "text" or "paragraphs", "cite"?, "className" }` | |
| `<img>` | `image` `{ "id", "alt", "size": "large", "className" }` | `id` from the sideload step — see Deploy §1 |
| `<pre><code>` | `code` `{ "code" }` | |
| `<hr>` | `separator` | |
| `<table>` | `table` `{ "header": [...], "rows": [[…]], "className" }` | rectangular |
| grid container (`grid`, `flex` with N direct children, N ≤ 6) | `columns` `{ "className", "columns": [ { "width"?, "className", "blocks" } × N ] }` | widths from `md:w-1/2`-style classes when present, else equal |
| grid container that wraps (N direct children, N > its Tailwind column count) | **one `columns` block per row**, chunked by the column count (e.g. `grid-cols-3` with 9 cards → three `columns` blocks of 3) | `columns` caps at 6 and never wraps on its own — see "Wrapping grids" below |
| `<a>` CTAs grouped together | `buttons` `{ "className", "buttons": [ { "text", "url", "style": "fill" or "outline", "className"? } ] }` | `outline` when the class list has `border` and no `bg-` |
| section with a background image and content on top | `cover` `{ "image", "overlay_opacity", "className", "blocks" }` | |
| image beside a text column | `media_text` `{ "image", "side": "left" or "right", "className", "blocks" }` | |
| empty spacing element (`h-16`, `py-12` with no content) | `spacer` `{ "height" }` | height in px |
| `<iframe>` or a bare embed URL | `embed` `{ "url" }` | |
| anything else | **stop and report** | never fall through to `html` silently; use `html` only when the owner has `unfiltered_html` and explicitly accepts a block they cannot edit |

Rules while mapping:

- Every class on a mapped element goes to that block's `className` **unchanged**, so the Tailwind
  scan sees the same strings the preview used.
- Text goes through the inline allowlist (`<a href|title|rel|target>`, `<strong>`, `<em>`, `<b>`,
  `<i>`, `<code>`, `<br>`, `<s>`, `<sub>`, `<sup>`, `<kbd>`, `<mark>`); anything else in a text
  field is stripped at write time, so move it out before mapping.
- `pages/<slug>.css` is the prepared CSS file verbatim (inner-element rules only).

**Wrapping grids.** `columns` accepts 1–6 columns and always renders as one non-wrapping row, so a
grid whose child count exceeds its column count cannot be one `columns` block. The column count is
the container's `grid-cols-N` (or the largest breakpoint variant that applies, e.g. `md:grid-cols-3`);
for a wrapping `flex` row with no `grid-cols-N`, use the per-item width class instead (`w-1/3` /
`md:w-1/3` → 3 per row). Chunk the children into groups of that count, in source order, and emit
one `columns` block per chunk — `grid-cols-3` with nine cards becomes three `columns` blocks of
three, wrapped together (in the containing `group`, or back-to-back at the same nesting level if
the grid has no other wrapper). A final short chunk (fewer children than the column count) is fine
as-is — that row just has fewer columns than the others.

## Deploy

1. **Images:** pick the tool by source, same as `canai-mcp`'s "Uploading media" section:
   - **`assets/…` file** — this is a local binary, not a public URL. Sideload it through the
     **sideload REST route** (`canai-mcp`'s "Uploading media" → "Local binary files → sideload
     REST endpoint" has the exact request); `wpcanai-sideload-url` cannot fetch a local path.
   - **Image already at a public URL** — `wpcanai-sideload-url`.
   - **Image already in the media library** — find it with `wpcanai-list-media`.

   Put the returned `id` into the block. `cover` and `media_text` take the same id.
2. **Page:** new page → `wpcanai-create-page { "title", "slug", "format": "blocks", "blocks",
   "layout"?, "status"? }`; existing page → `wpcanai-resolve-content-id` / `wpcanai-list-pages`
   for the id, then `wpcanai-write-page { "post_id", "blocks", "css", "layout"? }` (add
   `convert: true` only when the page is Twig with a body, and say so to the user first).
3. **CSS:** `create-page` has no `css` on the blocks path — after creating, call
   `wpcanai-write-page { "post_id", "blocks", "css" }` once with the same blocks, or
   `wpcanai-write-meta { "post_id", "css" }`.
4. **Layout:** set `layout` to the site's layout template id (from `wpcanai-list-templates`) so the
   header and footer wrap the page.
5. **Tailwind:** if the site uses compiled builds, run `compile tailwind` (`canai-mcp`) — the
   scan includes block pages since plugin v1.67.0. Until then the page is correct on the Play CDN.
6. **Verify** the frontend, then tell the owner: edit copy in the block editor; after a save the
   page falls back to the Play CDN until the next compile, and stays correct either way.
