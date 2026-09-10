# Feasibility gate — can this page be blocks?

Run this on the brief **before** any HTML is prepared. Blocks are for static page bodies the
owner will edit in Gutenberg. Everything that makes CanAI more than a page builder — data,
logic, interactivity, Woo markup — lives in Twig (`canai-mcp`). The gate exists so the user
hears "this one needs Twig, because …" up front, not after a lossy mapping.

**Rule of thumb:** if the owner would edit it in Gutenberg and it does not move or load data, it
is a block page. Otherwise it is Twig.

## Checklist

Go through the brief (or the mockup) and tick every signal that applies.

| Signal in the brief | Verdict | Why | Do instead |
|---|---|---|---|
| Lists of posts, products, terms, menu items; anything that reads `context` | **Twig** | No block reads CanAI context; `core/query` / `core/navigation` render WordPress's markup, not the design | `canai-mcp` page with `context` |
| Tabs, accordions, dropdowns, modals, carousels, counters, filters | **Twig** | Block pages have no Alpine and no JS slot | `canai-mcp` with Alpine |
| Icons, inline SVG, icon fonts (Lucide, Phosphor) | **Twig**, or drop the icons | `core/html` needs `unfiltered_html` on the writing user; SVG uploads are off by default | Use text, emoji, or a raster image sideloaded as an attachment |
| Woo cart, checkout, product grid, account pages | **Twig** | Those are Woo templates, `canai-mcp` territory | `wc_*` helpers |
| Forms (contact, newsletter) | **Twig**, or an embed | No form block in v1 | Twig page, or link to a form page |
| Nesting deeper than 4 levels; per-element classes inside a block | **Twig**, or simplify | BlockBuilder caps nesting at 4; `className` is root-only | Flatten, move inner rules to `<slug>.css` |
| Conditional content (logged-in, language, date) | **Twig** | No conditionals in blocks | `canai-mcp` |
| Hero, features grid, testimonials, pricing table, image-and-text, CTA row, FAQ as static text, contact details, about, legal text | **Blocks** | All map to the v1 block types | Continue to `prepare-for-blocks.md` |

## What to tell the user

- **Pass:** "This is a static page; I'll build it as blocks so you can edit the copy in the block
  editor. Layout/header/footer stay CanAI templates."
- **Fail:** name the signal and the reason from the table, then the path: "The pricing page
  pulls products from WooCommerce, so it needs a CanAI Twig page (I'll use canai-mcp). The About
  page has none of that and can be blocks." Offer the simplification when one exists (drop the
  icons, flatten the grid) and let the user choose.
- **Mixed pages:** a page is one format. If one section fails, the whole page is Twig unless the
  user accepts the simplification.

Never fall through to `html` blocks to force a fail into blocks: an `html` block is not editable
in Gutenberg, which defeats the reason for choosing blocks, and needs `unfiltered_html`.
