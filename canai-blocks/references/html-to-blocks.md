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
| `<img>` | `image` `{ "id", "alt", "size": "large", "className" }` | `id` from `wpcanai-sideload-url` |
| `<pre><code>` | `code` `{ "code" }` | |
| `<hr>` | `separator` | |
| `<table>` | `table` `{ "header": [...], "rows": [[…]], "className" }` | rectangular |
| grid container (`grid`, `flex` with N direct children) | `columns` `{ "className", "columns": [ { "width"?, "className", "blocks" } × N ] }` | widths from `md:w-1/2`-style classes when present, else equal |
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

## Deploy

1. **Images:** for each `assets/…` file referenced by the JSON, `wpcanai-sideload-url` (or find it
   with `wpcanai-list-media`) and put the returned `id` into the block. `cover` and `media_text`
   take the same id.
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
