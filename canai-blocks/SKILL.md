---
name: canai-blocks
description: >
  CanAI companion skill for authoring content as native WordPress blocks (Gutenberg) via the
  CanAI MCP server: blog posts (wpcanai-write-post), block-authored pages
  (wpcanai-create-page with format:"blocks" + wpcanai-write-page), and converting a page
  between the Twig and blocks formats. Requires canai-mcp for MCP transport, setup, and every
  non-block CanAI tool (templates, Twig pages, settings, media, i18n, Tailwind) — use canai-mcp
  for those; this skill only adds the block-authoring tools on top.
  Triggers on: "/canai-blocks", "canai-blocks", "write blocks", "block editor", "gutenberg",
  "gutenberg blocks", "native blocks", "wpcanai-write-post", "wpcanai-write-page",
  "block-authored page", "block page", "convert to blocks", "convert to twig",
  "blog post", "write a blog post", "write post", "write a page in blocks".
metadata:
  author: canai
  version: "1.0.0"
allowed-tools: "Read Grep Glob"
---

# CanAI Blocks Skill

**Companion skill to `canai-mcp`.** This skill documents the CanAI MCP abilities that write
**native WordPress block content** instead of Twig: blog posts, and pages the owner wants to
edit themselves in Gutenberg. Same server, same API key, same transport as `canai-mcp`
(`{site}/wp-json/mcp/wpcanai`) — this skill only adds the block-specific tools and the
page-format concept on top of it.

**Install and configure `canai-mcp` first.** It covers MCP client setup, the API key, the
"MCP only — no shell, no `curl`, no file edits" transport rule, and every non-block CanAI tool
(templates, Twig pages and layouts, settings, media sideload, i18n, Tailwind builds). This skill
assumes all of that already applies and does not repeat it. The one documented exception to
"MCP only" — binary media uploads via the sideload REST route — is `canai-mcp`'s; this skill
only tells you to sideload an image *before* referencing it by attachment id (see **Images**
below).

There is no eval escape hatch here either: the `wpcanai/eval` ability was removed in plugin
v1.59.0. Every capability is a real `wpcanai/*` ability.

**`lang` parameter (Polylang).** `wpcanai-write-post` and `wpcanai-write-page` both accept an
optional `"lang": string`, enforced exactly like `canai-mcp`'s post/page tools — required when
Polylang is active (unless `WPCANAI_MCP_LANG_OPTIONAL` is defined), `WP_Error('lang_required')`
without it, `WP_Error('unknown_lang')` for an unrecognized slug, and `lang_mismatch` if the post
is actually in a different language. See `canai-mcp`'s **CRITICAL: Multi-language (Polylang)**
section for the full rule; it isn't repeated here.

---

## Blog posts (not CanAI pages)

A blog post is ordinary WordPress content, not a CanAI-meta page. Write it with
**`wpcanai-write-post`**, passing a structured block list — the body becomes native block markup
the owner can edit in the block editor, and it renders through the blog kit's
`blog-single-post` template with no extra work. Sideload any images first and reference them by
attachment id. Do **not** reach for `wpcanai-create-page` or `wpcanai-write-meta` for posts —
those are `canai-mcp` tools for Twig-authored CanAI content, not blog posts.

## Page format — Twig or blocks (plugin v1.65.0)

A **page** is authored in one of two formats. The format is a mark (`_canai_format`) that only
MCP sets; the admin UI shows the owner a prompt to paste to you instead of a toggle.

| | Twig (default — `canai-mcp`) | Blocks (this skill) |
|---|---|---|
| Body lives in | `_canai_html` / `_canai_css` / `_canai_js` | `post_content` (native block markup) |
| Owner edits in | CanAI editor | Gutenberg |
| Write with | `wpcanai-write-meta` | `wpcanai-write-page` |
| Create with | `wpcanai-create-page` | `wpcanai-create-page` with `format: "blocks"` |
| Renders | Twig + layout | blocks inside the page's `_canai_layout` (`{{ page_content }}`) |
| Tailwind | compiled build or Play CDN | **always the Play CDN** (block classes are not in the layout build) |
| Snapshots / `replace-in-meta` / `grep-content` / `scan` | yes | no — WordPress revisions are the history |
| Export / import (`wpcanai-export` / `-import`) | yes | **no** — the exporter only finds pages with non-empty `_canai_html`, so a block page is never in a bundle |
| Polylang translation | copies CanAI meta | copies the format mark too, so a translation stays blocks-authored |
| Native `t()` / content overrides | yes | no — Polylang translates the page as a normal post |
| Conditionals, loops over non-post data, Alpine | yes | no (an `html` block keeps raw markup but needs `unfiltered_html`) |
| Header/footer/layout wrapping | yes | **yes, too** — `_canai_layout` wraps a blocks page's rendered content the same way it wraps Twig, as long as the layout is set |

**Choose blocks** when the owner wants to edit copy and layout themselves in Gutenberg
(marketing pages, landing pages, about/contact). **Keep Twig** for anything with logic, loops
over Woo/term/menu data, or Alpine — use `canai-mcp` for those. Layouts, headers, footers, shop,
product, cart, checkout and archive templates are always Twig (`canai-mcp`'s territory, not this
skill's).

`wpcanai-read-meta` returns `format` by default; `wpcanai-list-pages` rows carry `format`.
Reading `blocks` on a Twig page, writing `html` on a blocks page, or `write-page` on a Twig page
with html all fail with `format_mismatch` and change nothing. Both of those tools are
`canai-mcp`'s — see that skill for their full argument/return reference; this skill only adds
the block-authoring side.

**Convert to blocks** (owner pastes `Convert post id 123 to blocks. /canai-blocks`):
1. `wpcanai-read-meta` `{ post_id: 123 }` — read `html`, `css`, `js`, `layout`.
2. Rewrite the body as a block list. Static markup maps to
   `group`/`columns`/`heading`/`paragraph`/`image`/`buttons`/`cover`/`media_text`. Anything with
   `{% %}` logic, loops over non-post data, or Alpine **cannot** be carried over: tell the user
   what you left out, or keep it verbatim in an `html` block if the owner accepts raw HTML
   there.
3. `wpcanai-write-page` `{ post_id: 123, blocks: [...], convert: true }`. The Twig meta is
   snapshotted, then cleared; the response says `converted: true`.
4. Tell the owner to open the page in the block editor and check it.

**Convert to Twig** (owner pastes `Convert post id 123 to twig. /canai-blocks`):
1. `wpcanai-read-meta` `{ post_id: 123, fields: ["blocks", "layout"] }`.
2. Rewrite the block markup as Twig HTML (drop the `<!-- wp:… -->` delimiters, keep the elements
   and classes).
3. `wpcanai-write-meta` `{ post_id: 123, html: "...", convert: true }` — this call is
   `canai-mcp`'s tool, but the `convert` flow on a blocks page is documented here since it's the
   reverse of the workflow above. The mark is removed; `post_content` is left in place but no
   longer rendered.

---

## MCP tool reference (inline)

Ability IDs use slashes; MCP tool names use **hyphens** (`wpcanai/write-page` →
`wpcanai-write-page`). See `canai-mcp` for how to invoke MCP tools from any client — that isn't
repeated here.

### `wpcanai-create-page` (the `format: "blocks"` path)

This is the same `wpcanai-create-page` tool `canai-mcp` documents for Twig pages
(`{ "title", "slug"?, "status"?, "html"?, "css"?, "js"?, "layout"?, "lang"?, "translation_of"? }`)
— this section only covers its block-authoring arguments.

- **Additional args:** `"format"?: "twig"|"blocks"`, `"blocks"?: object[]`.
- **(v1.65.0) `format: "blocks"`.** `blocks` is then required and `html`/`css`/`js` are
  rejected; the page is created with a block body and marked blocks. `warnings` is empty on the
  Twig path. The reverse is also refused: sending `blocks` without `format: "blocks"` errors
  `invalid_input` rather than silently publishing an empty page.
- **Returns:** `{ "post_id": int, "slug": string, "lang": string|null, "format": string,
  "warnings": string[] }`.

### `wpcanai-write-post`

- **Args:** `{ "post_id"?: int, "title"?: string, "blocks"?: object[], "slug"?: string,
  "status"?: string, "excerpt"?: string, "date"?: string, "featured_image"?: int,
  "categories"?: string[], "tags"?: string[], "lang"?: string, "translation_of"?: int }`.
  - **Create** (no `post_id`): `title` and `blocks` are required. **Update** (`post_id` given):
    only the fields you send change; the id must be a `post`, not a page — a page id returns
    `WP_Error('not_a_post')`.
  - **Default status is `draft`**, not `publish` — unlike `wpcanai-create-page`. The owner is
    expected to read the prose in the editor first. Valid: `draft`, `publish`, `pending`,
    `private`, `future`.
  - `blocks` **replaces the entire body**. There is no partial edit; re-send the whole list.
    WordPress revisions are the undo path.
  - `categories` / `tags` take names or slugs, create anything missing, and replace the whole
    set on update.
- **Returns:** `{ "post_id": int, "slug": string, "status": string, "url": string,
  "edit_url": string, "lang": string|null, "block_count": int, "warnings": string[] }`.
  `warnings` is non-fatal (unresolvable embed provider, image with no alt text, a
  classic-editor body that was converted). Fatal problems return `WP_Error` and write nothing.
- **This is for blog posts only.** Twig pages stay on `canai-mcp`'s `wpcanai-create-page` +
  `wpcanai-write-meta`; block-authored pages use `wpcanai-create-page` with `format: "blocks"`
  plus `wpcanai-write-page`. `write-post` writes native block markup into a post's
  `post_content` and does not touch CanAI meta.

### `wpcanai-write-page`

- **Args:** `{ "post_id": int, "blocks": object[], "title"?: string, "status"?: string,
  "layout"?: int, "convert"?: bool, "lang"?: string }` — `post_id` must be a `page`. `blocks`
  replaces the whole body. Same block types as `write-post`; the `html` block is additionally
  available here (and in `create-page` with `format: "blocks"`), and nowhere else.
- **Returns:** `{ "post_id", "slug", "status", "url", "edit_url", "lang", "format": "blocks",
  "converted": bool, "block_count", "warnings": string[] }`.
- **Format guard.** On a Twig page whose `_canai_html` is non-empty the call fails with
  `format_mismatch` (the error carries the prompt to show the owner) unless `convert: true`:
  then the body is written first, and only once that lands is the CanAI meta snapshotted and
  `_canai_html`/`_canai_css`/`_canai_js` deleted and the page marked blocks — in that order, so a
  failed body write destroys nothing. A Twig page with empty html is simply written and marked.
- **Layout still applies.** Set `layout` to a `canai-mcp` layout template's id the same way you
  would on a Twig page. `_canai_layout` wraps a blocks page's rendered content in that layout's
  Twig shell (header/footer included) exactly as it wraps Twig content — the plugin checks
  `_canai_layout` independently of the format mark, so the same layout mechanism serves both.
- **Errors:** `invalid_input`, `invalid_status`, `lang_mismatch`, `not_a_page`, `invalid_blocks`
  (with `path` like `"2.blocks.0"` for nested blocks), `invalid_attachment`, `format_mismatch`.
  Fatal problems write nothing.

## Block types (v1)

Each item in `blocks` is `{ "type": …, …fields }` — shared by `write-post` and `write-page`:

| `type` | Fields |
|---|---|
| `paragraph` | `text` (required), `align` (`left`/`center`/`right`) |
| `heading` | `text` (required), `level` 2–6 (default 2; **level 1 is rejected** — the post title is the h1) |
| `list` | `items` string[] (required), `ordered` bool. Flat lists only |
| `quote` | `text` **or** `paragraphs` string[] (one required), `cite` |
| `image` | `id` int (required — an attachment id), `alt`, `caption`, `size` (default `large`), `link` (`none`/`media`/`attachment`) |
| `code` | `code` (required). Escaped as literal text; no inline HTML |
| `separator` | — |
| `embed` | `url` (required, http/https) |
| `table` | `rows` string[][] (required, rectangular), `header` string[] |
| `group` | `blocks` (required, child blocks), `tag` (`div`/`section`/`header`/`footer`/`aside`/`main`), `className` |
| `columns` | `columns` (required, 1–6 of `{ width?, className?, blocks }`), `className` |
| `buttons` | `buttons` (required, `{ text, url, style?: fill/outline, target?: _blank, rel?, className? }`), `className` |
| `cover` | `image` (required, attachment id), `overlay_opacity` (10–100 step 10, default 50), `blocks` (required), `className` |
| `media_text` | `image` (required, attachment id), `side` (`left`/`right`), `blocks` (required), `className` |
| `spacer` | `height` px (1–1000, default 100), `className` |
| `html` | `html` (required, raw markup kept verbatim). **`write-page` and `create-page` with `format: "blocks"` only**, and it requires `unfiltered_html` on the user the write runs as; refused otherwise. `write-post` never accepts it |

Every type except `embed` and `html` accepts `className` (Tailwind classes on the block's root
element). `core/html` declares `supports.className: false`, so a class set there is dropped and
reported as a warning — put it on your own markup instead; `embed` rewrites its own class list
on first save. Nesting is capped at 4 levels. Nested errors report a dotted `path`.

**Images: sideload first, then pass the id.** `write-post` and `write-page` accept attachment
ids only — no URLs, no binaries (`write-page`'s `cover` and `media_text` blocks take the same id
and return `invalid_attachment` if it doesn't resolve). Call `wpcanai-sideload-url` (`canai-mcp`
tool — or find an existing one with `wpcanai-list-media`) and pass the returned `id`.

**Inline HTML inside text fields** is limited to `<a href|title|rel|target>`, `<strong>`,
`<em>`, `<b>`, `<i>`, `<code>`, `<br>`, `<s>`, `<sub>`, `<sup>`, `<kbd>`, `<mark>`. Anything else
is stripped silently, not rejected — a `<script>` or `<iframe>` in a paragraph would be invalid
block content anyway. Markdown is **not** accepted; there is no raw-HTML escape hatch inside
text fields — raw markup goes in an `html` block, which `write-page` and blocks-format
`create-page` accept and `write-post` does not.

---

## Undo (snapshots)

Block-page writes go through the same CanAI snapshot system `canai-mcp` documents in its
**History / undo (snapshots)** section — `wpcanai-write-page`'s convert-to-blocks path
snapshots the CanAI meta before clearing it (operation `mcp-write-page-convert`), and the whole
`wpcanai-list-snapshots` / `wpcanai-get-snapshot` / `wpcanai-restore-snapshot` /
`wpcanai-restore-operation` toolset applies. This skill doesn't repeat that reference — see
`canai-mcp` for it. One caveat worth restating here: a snapshot taken while a page was marked
`blocks` but still carried a non-empty `_canai_html` (a stale Twig body left behind by an
interrupted conversion) restores both values together — the page still opens in the block
editor, but the stale Twig renders instead of the blocks, because the frontend only falls back
to `post_content` when `_canai_html` is empty. `post_content` itself has **no** snapshot/undo
path of its own — WordPress's own post revisions are the only history for block content.
