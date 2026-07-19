---
name: canai-replicate
description: >
  Replicate an existing live website — multi-page, semantically — into the
  canai-prepare single-HTML-per-page format using the replica pipeline.
  Discover pages → classify into page types (with a review gate that
  confirms WooCommerce is real before keeping any woo:* kind) → capture
  samples (full-page + per-section screenshots, structured content, style
  tokens, UX inventory — each URL is 2xx-checked before its capture is
  accepted) → extract a site-wide DESIGN.md → write a CONTENT-MODEL.md
  handoff (CPTs/custom fields via Pods or Easy Code Manager, both fully
  supported) → transform each page type into a reusable Twig template and
  each one-off page into a self-contained HTML file, all sharing one
  site-wide header/footer partial driven by real WordPress menus instead of
  N independently-drifting inlined copies → convert every generated file
  into push-ready JSON artifacts (pushprep, avoiding WPCanAI's
  double-document-shell footgun) → verify with automated diff scoring —
  templates included, rendered through the real Twig engine with real
  sample data, not just raw pages. --only (URL pathname, output slug,
  or page-type name) resumes any stage uniformly. Output is ready for
  canai-mcp / canai-localwp to push into WordPress. Use when the user wants
  to rebuild, migrate, port, or clone a whole site (not just one URL) from a
  live source. Pairs with agent-browser for sourcing and verification.
  Triggers on: "canai-replicate", "replicate this site", "clone this site",
  "rebuild this site in tailwind", "migrate this site to wpcanai",
  "port this site", "copy this site", "replica", "migrate any website",
  "convert this site to wordpress".
metadata:
  author: canai
  version: "3.2.0"
allowed-tools: Bash Read Write Edit Grep Glob
---

# canai-replicate — live site → WordPress/WPCanAI migration kit

Take a **live website** and rebuild it as a **migration kit**: one
self-contained HTML file per one-off page (the
**[canai-prepare](../canai-prepare/SKILL.md)** format) plus a reusable
**Twig template per repeating page type**, a site-wide **DESIGN.md**, and a
**CONTENT-MODEL.md** handoff describing the custom post types/fields a human
implements on the destination site. Output drops directly into
**[canai-mcp](../canai-mcp/SKILL.md)** / **[canai-localwp](../canai-localwp/SKILL.md)**
for the WordPress side.

| | input | output |
| --- | --- | --- |
| **canai-prepare** | mockup, image, brief | new HTML |
| **canai-replicate** | live website (URL) | migration kit: DESIGN.md + Twig template per page type + CONTENT-MODEL.md + one-off pages |

canai-replicate is **multi-page and semantic**, not pixel-cloned. Pages that
repeat (blog posts, team members, products, case studies, …) become **one**
reusable Twig template driven by real WordPress content instead of N
duplicated static files; the transform step rebuilds everything with
Tailwind utilities + DESIGN.md tokens + Alpine recipes for interactivity,
plus **one shared header/footer partial** driven by the real WordPress menu
system instead of N independently-drifting inlined copies — so the output
is a real, maintainable site, not a screenshot-shaped fossil.

If you need:

- The HTML skeleton + `WPCanAI-PREVIEW-LIBS` markers → [canai-prepare/references/BOILERPLATE.md](../canai-prepare/references/BOILERPLATE.md)
- Stack rules (Tailwind/Alpine/Lucide, semantic HTML5, no-`<style>`) → [canai-prepare/SKILL.md](../canai-prepare/SKILL.md#tech-stack-strict)
- WPCanAI handoff (preview-libs stripping, layout split) → [canai-prepare/SKILL.md](../canai-prepare/SKILL.md#handoff-to-wpcanai)

…follow those. canai-replicate **does not redefine** any of the canai-prepare
rules. It only adds the multi-page extraction, classification, and
per-page/per-type transform workflow on top.

## Tool

The pipeline is bundled inside this skill. Always invoke it via:

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" <command> ...
```

That path is portable — every install of this skill puts the CLI at the same
location relative to the user's home directory. No `npm install`, `npm link`,
or repo clone is required; just having the skill installed is enough.

(Optional convenience: `ln -s "$HOME/.claude/skills/canai-replicate/bin/replica" /usr/local/bin/replica` to expose it on `$PATH`. Not required.)

## Requirements

- **Node 22+** (the raw-CDP node-screenshot helper relies on the global
  `WebSocket`).
- **A Chrome instance `agent-browser` can drive**, reachable via
  `--remote-debugging-port=<cdp>` (see Pre-flight below; default port 9223).
  That port is only where a `--session <name>` **first** attaches, though —
  agent-browser sessions are long-lived daemons, so every later invocation
  with the same session name keeps using whatever browser it originally
  attached to, silently ignoring a different `--cdp` from then on.
  `capture`/`verify` never assume `--cdp` is where the session's browser
  actually lives: their raw-CDP calls (per-section node screenshots, and the
  mobile-viewport emulation `styles.json` needs — agent-browser's own
  `screenshot <selector>` returns blank images for elements below the fold,
  which is why these bypass it) resolve the session's real endpoint via
  `agent-browser --cdp <cdp> --session <name> get cdp-url` first, and fail
  loudly on a mismatch instead of silently screenshotting the wrong tab.
- **`agent-browser`** — the CLI shells out to it for navigation, scrolling,
  full-page screenshots, and resolving each session's real CDP endpoint. A
  global install on `$PATH` is optional; if it isn't found, the CLI
  auto-runs it via `npx -y agent-browser` (needs network on first fetch).
- **No npm dependencies** to install — `package.json` declares no
  `dependencies` block; everything runs against the Node standard library.

## Where outputs land

Every command writes into `./runs/<site>/...` **relative to the current working
directory** (override with `--runs <dir>`). `cd` into the workspace where you
want the artifacts to live before running the pipeline — typically the user's
project root, not the skill directory.

```
USAGE
  replica <command> <args> [flags]

COMMANDS
  discover     <url>   Find pages (sitemap.xml, fallback BFS crawl)
                       → runs/<site>/pages.json
  classify     <site>  Cluster pages into page types (URL pattern + DOM fingerprint)
                       → runs/<site>/pagetypes.json + .classify/PROMPT.md (review it —
                          also gates any woo:* kind on confirming WooCommerce is real)
  capture      <site>  Drive agent-browser per sample page + one-offs (each URL's
                       HEAD/ranged-GET must 2xx before its capture is accepted, else
                       it fails over to a spare)
                       → runs/<site>/captures/<slug>/{screenshot.png, sections/, sections.json,
                          content.json, assets.json, dom.html, styles.json, ux.json}
  designmd     <site>  Prepare design-extraction bundle (cites styles.json as ground truth)
                       → runs/<site>/.designmd/PROMPT.md → you write runs/<site>/DESIGN.md
  contentmodel <site>  Prepare CPT/custom-field handoff bundle
                       → runs/<site>/.contentmodel/PROMPT.md → you write runs/<site>/CONTENT-MODEL.md
  transform    <site>  Prepare bundles: one shared site-chrome bundle (header/footer,
                       once per site), one per one-off page, one per page type
                       → output/templates/header.html + footer.html (shared chrome,
                          template_type header/footer); output/pages/<slug>.html;
                          output/templates/<type>-single.html (+ <type>-archive.html
                          when the type has one); output/templates/<type>.html for a
                          WooCommerce structural page (shop/cart/checkout/my-account/
                          order-received/product-category — one page, not a repeating type)
  pushprep     <site>  Convert every output/pages/*.html + output/templates/*.html into
                       a push-ready artifact: strips the DOCTYPE/head/body document
                       shell + WPCanAI-PREVIEW-LIBS blocks, routes any stray
                       <style>/<script> to css/js, reads template_type off the leading
                       wpcanai-template comment. A file that doesn't match the
                       expected shape fails loudly (per file), never a silently-wrong
                       fragment.
                       → runs/<site>/output/push/<slug>.json ({ title, slug,
                          template_type, html, css, js, warnings }) — **this is what
                          gets pushed to WordPress**, never a raw output/pages/ or
                          output/templates/ file (see Handoff below)
  verify       <site>  Render outputs — templates too, via the real Twig engine +
                       real sample data — score pages AND templates vs originals
                       → runs/<site>/verify/report.md (worst-first; only Woo structural
                          pages and the shared header/footer partials aren't scored)

FLAGS
  --cdp <port>            Chrome DevTools port (default: 9223)
  --session <name>        agent-browser session name (default: personal)
  --only <path|slug|type> Restrict to one page or one page type — one shared matcher,
                          identical across capture/transform/verify
  --runs <dir>            Output root (default: runs)
```

## Pre-flight

Chrome must be running with CDP open on the port you'll use. For the default
`personal` session on port 9223:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9223 \
  --user-data-dir="$HOME/.agent-browser-personal" \
  about:blank
```

Confirm:

```bash
curl -fsS http://127.0.0.1:9223/json/version | jq .Browser
```

Note: `--session <name>` is a long-lived agent-browser daemon, not something
this CLI spins up fresh each run. If a session name was already used against
a *different* `--cdp` port earlier, it keeps driving that original browser —
`--cdp` is silently ignored for it from then on. The per-section screenshots
(raw CDP, see below) account for this: `capture` resolves the session's real
CDP endpoint via `agent-browser ... get cdp-url` rather than trusting `--cdp`
at face value, so a mismatched port/session pair still works as long as the
session's actual browser has the page open. If it *doesn't* (e.g. the session
is bound to a browser that never navigated anywhere), capture now fails
loudly with a clear error naming the mismatch, instead of silently
screenshotting an unrelated tab.

## Pipeline (run in order)

**1. discover** — extract pages from the source site.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" discover https://example.com/
```

Writes `runs/example.com/pages.json`. Inspect it; if there are URLs you don't
want to migrate (paginated archives, tag pages, login routes), edit the file
before continuing.

**2. classify** — cluster the discovered URLs into page types.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" classify example.com
```

Writes `pagetypes.json` (types with kind `page` / `single:<cpt>` /
`archive:<cpt>` / `woo:<template_type>`, member URLs, 3 samples each) plus
`.classify/PROMPT.md`. **Run that prompt** — review names/kinds, prune junk
URLs — before capturing; `pagetypes.json` is a mechanical first draft (URL
prefix grouping confirmed/refined by a DOM-fingerprint check), not a final
answer. On sites with no repetition every URL becomes a one-off page and the
rest of the pipeline behaves like v2.

`guessKind`'s heuristic for `woo:product` is word-boundary matched — "shop",
"store", "product"/"products" only count as their own token ("book-shop"
still matches; "bookshop"/"workshop" no longer do) — but no regex can know
whether WooCommerce is actually installed on the source site.
`.classify/PROMPT.md` explicitly tells the reviewer to confirm that before
keeping **any** `woo:*` kind: a plain CPT literally named `product` on a
non-WooCommerce site is `single:product`, not `woo:product`. This is more
than a cosmetic label — `TemplateResolver` gates its entire WooCommerce
branch on WooCommerce actually being active, so a wrongly-kept `woo:*` kind
means the `template_type` term is never emitted and the page silently falls
through to the theme with no WPCanAI template bound at all.

**3. capture** — for each page in the worklist, drive agent-browser to take:

- `screenshot.png` — full-page (used by designmd + verify)
- `sections/01-header.png … 99-footer.png` — per-section node screenshots
  (DevTools "Capture node screenshot" via direct CDP `Page.captureScreenshot`)
- `sections.json` — role + tag + class + dimensions per section file
- `content.json` — `{ header, main: [section…], footer }`. Each section has
  its own headings, paragraphs, lists, links, images, forms, buttons, and
  (Task 7b) **tables, definitionLists, and labelValuePairs** — this is what
  lets a WooCommerce product's SKU/attributes table, or any site's spec
  sheet, survive capture instead of silently vanishing. The `id` field
  matches the screenshot filename. It also records the page `title` and meta
  `description`, which can seed the WordPress SEO title/description at
  import.
- `assets.json` — image / font / stylesheet / script URLs
- `dom.html` — post-hydration outerHTML, with `data-capture-id` markers
- `styles.json` — computed-style token tables at desktop (real viewport) and
  mobile (375px) widths. Each carries frequency tables (dominant
  colors/sizes/spacing across the whole page) plus a `roles` block —
  heading/link/button/body styles keyed by semantic role, so a
  rare-but-defining token (the brand CTA color used on a handful of buttons)
  isn't crowded out by high-volume body text the way it would be in a raw
  frequency count. designmd cites this as ground truth instead of guessing
  hex codes from screenshot pixels.
- `ux.json` — interactive-pattern inventory (nav toggle, dropdown menu, tabs,
  accordion, carousel, modal, sticky header). Each entry names the Alpine
  recipe in `prompts/alpine-recipes.md` that reproduces it. Animations are
  deliberately out of scope by design — recipes are instant-state only.

Once `classify` has run, capture visits only each **repeating** type's 3
`samples` plus its `archiveUrl` (not every member) plus every one-off
`pages` entry — capturing every post of a 500-post blog would be wasteful
when one template renders all of them. The one exception: a type marked
`kind: "page"` (one-off pages that happened to share a URL prefix or DOM
fingerprint, not a real repeating template) has **all** of its members
captured, not just 3 samples — there's no template to render the rest, so
every member needs its own capture or `transform` would silently have
nothing to build some of them from. A sample that fails to capture is
retried against a spare member from the same type's pool (up to 2 spares)
before being counted a loss.

Before any capture is accepted, its target URL must return 2xx — a HEAD
request, falling back to a ranged `GET` (`Range: bytes=0-0`) only when the
server rejects HEAD with 405; any other non-2xx status, or a network
error/timeout, counts as a real failure. This runs through the exact same
fallback-to-spare machinery a browser-side capture failure already uses, so
a themed 404/500 page is never silently captured and rebuilt as if it were
real content.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" capture example.com
# or one page or one type:
"$HOME/.claude/skills/canai-replicate/bin/replica" capture example.com --only /
"$HOME/.claude/skills/canai-replicate/bin/replica" capture example.com --only product
```

If a page errors (`✗`) it's skipped; rerun `--only <path>` to retry.

**4. designmd** — prepare a design-extraction bundle (`.designmd/`) that a
design-analysis pass turns into `DESIGN.md`. The resulting single-HTML pages
and Twig templates hand off to
**[canai-prepare](../canai-prepare/SKILL.md)** conventions for WordPress
authoring.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" designmd example.com
```

The CLI picks ~3 representative pages (home + about + contact when present,
falling back to URL-diversity bucketing — drawn from `pagetypes.json`'s
one-off `pages` plus each type's `samples` once classify has run, or raw
`pages.json` otherwise) and writes `runs/example.com/.designmd/PROMPT.md`.
That prompt cites each picked page's `styles.json` as the **primary,
measured ground truth** for tokens (frequency tables for the dominant
palette/scale, the `roles` block for heading/link/button/body styles) —
screenshots are for confirming layout only, never for guessing a hex code or
font size from a pixel. Run the prompt — via the `design-md` skill — to
produce `runs/example.com/DESIGN.md`.

DESIGN.md is the **source of style truth** for every page and template. It
is written once per site.

**5. contentmodel** — prepare the WordPress content-model handoff.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" contentmodel example.com
```

Run the generated `.contentmodel/PROMPT.md` to produce `CONTENT-MODEL.md`:
CPT/custom-field/taxonomy definitions per type, a field-mapping table, plus
two ready-to-use materializations — **Pods** setup steps and an
**Easy Code Manager** PHP snippet. WooCommerce types (`woo:product`, etc.)
get the equivalent treatment for native properties/attributes/meta on the
*existing* `product` post type — this skill never registers a new `product`
CPT. This skill never creates CPTs or imports content either way: the
document is handed to the user to implement. Skip this stage when classify
found no repeating types (`contentmodel` errors out if `pagetypes.json` has
none).

**6. transform** — generate the shared site chrome once, then prepare a
bundle per one-off page and per page type, and run the canai-prepare/Twig
conversion.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" transform example.com           # everything, incl. chrome
"$HOME/.claude/skills/canai-replicate/bin/replica" transform example.com --only /  # one page
"$HOME/.claude/skills/canai-replicate/bin/replica" transform example.com --only product  # one type
"$HOME/.claude/skills/canai-replicate/bin/replica" transform example.com --only chrome   # just the chrome bundle
```

Three different bundle shapes, from three different prompts:

- **Site chrome** — `.transform/chrome/PROMPT.md`, generated automatically
  on a plain run (`--only <anything else>` skips it; `--only chrome` targets
  only it). Points at ONE representative capture — the homepage if
  captured, else the first one-off page, else the first page-shaped type,
  else the first sample of the first repeating type
  (`siteChrome.mjs`'s `pickRepresentativeCaptureUrl`, shared with `verify`
  so both stages agree on which capture the chrome came from) — plus
  `DESIGN.md` and `alpine-recipes.md`. Follow it to write **two** small Twig
  partials, `output/templates/header.html` and `footer.html`: no
  `<!DOCTYPE>`, no preview-libs markers, just the bare `<header>…</header>` /
  `<footer>…</footer>` element, each opening with its own
  `<!-- wpcanai-template: template_type=header|footer -->` comment.
  Navigation loops the real WordPress menu functions
  `get_menu('wpcanai_primary')` / `get_menu('wpcanai_footer')` — never
  hardcoded `home_url()` links as the default — so the client's
  Appearance → Menus screen actually controls the nav; a hardcoded link is
  only an acceptable, disclosed (`<!-- FIELD GAP -->`) fallback for what
  `get_menu()`'s flat `{title,url,target,classes,active}` shape genuinely
  can't express, e.g. a mega-menu's nested flyout sub-items. Generated
  **once per site** — every other output includes it rather than
  re-authoring it (see below).
- **One-off pages** — `.transform/<slug>/PROMPT.md`, pointing at the page's
  `screenshot.png`, `sections/` + `sections.json`, `content.json`,
  `assets.json`, `ux.json`, and the site-wide `DESIGN.md`. Follow it to write
  a single self-contained HTML file to `output/pages/<slug>.html`, the
  standard canai-prepare skeleton.
- **Page types** — `.transform/type-<name>/PROMPT.md`, pointing at 2–3
  sample capture directories, `CONTENT-MODEL.md` (the field contract —
  fields come from there, never invented), `DESIGN.md`, and
  `prompts/alpine-recipes.md` (UX patterns from each sample's `ux.json` map
  to a named recipe there). Follow it to write **one** reusable Twig
  template that renders any item of the type, opening with a
  `<!-- wpcanai-template: template_type=... -->` header comment naming the
  `template_type` taxonomy term the finished `wpcanai_template` post must be
  tagged with in wp-admin. Output goes to `output/templates/<type>-single.html`
  (+ `<type>-archive.html` when the type has an `archiveUrl`) for a
  repeating CPT or `woo:product` type, or `output/templates/<type>.html` for
  a WooCommerce **structural** page (shop, cart, checkout, my-account,
  order-received, product-category) — WooCommerce itself owns exactly one of
  those per site, so it's a single template with no per-item field contract,
  never "N items of a CPT".

**Site chrome is shared, never inlined.** Every one-off page and every
page-type template emits `{{ wpcanai_template('header') }}` immediately
inside `<body>` and `{{ wpcanai_template('footer') }}` immediately before
`</body>` instead of writing its own `<header>`/`<footer>` markup — on a
real migration, independently-inlined copies **disagreed** with each other
(different nav-link counts, different dropdown menus) before this fix, not
a hypothetical risk. If you're hand-editing `header.html`/`footer.html`,
never quote `wpcanai_template`'s literal `{{ }}` invocation syntax inside an
HTML comment in those files themselves — Twig parses its own delimiters
wherever they appear in the source, comment or not, so a "helpful" comment
documenting the include mechanism that way makes the file call itself while
rendering itself (real, reproduced infinite recursion, not a hypothetical
risk — see Failure modes below). Describe the mechanism in prose instead.

**7. pushprep** — convert every `transform` output file into a push-ready
artifact WordPress can actually store without doubling its own document
shell around it.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" pushprep example.com
```

**Why this stage exists (CRITICAL — dogfood A2, Defect #1).** Every file
under `output/pages/` and `output/templates/` is a **full standalone HTML
document** (`<!DOCTYPE>`/`<html>`/`<head>`/`<body>` and all — deliberate, so
it opens via `file://` for local preview). But WPCanAI's no-layout render
path (`wpcanai_render_full_page_frontend()`) unconditionally wraps whatever
is stored in `_canai_html` in **its own** `<!DOCTYPE>`/`<html>`/`<head>`/
`<body>` shell. Pushing a `transform` output file **verbatim** into
`_canai_html` — which the pipeline used to describe as the normal thing to
do — produces doubled, invalid markup: 2×`<!DOCTYPE html>`, 2×`<html>`,
2×`<head>`/`</head>`, 2×`<body>`. This was reproduced live and is preserved
as evidence on the dogfood site (do not "fix" that page — it's intentional
proof of the failure mode this stage exists to close).

`pushprep` does the conversion mechanically, deterministically, with no
dependencies (stdlib string/regex work over canai-replicate's own known
output shape — every marker it looks for is one this same pipeline emits):

- Strips the `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` wrapper, keeping only
  body-inner content — except a `wpcanai_template`/`wpcanai_get_posts_enriched`
  `{% set %}` block that a typed template sometimes puts **before**
  `<!DOCTYPE>` (its `<title>` needs it too — see recipe-single.html /
  case-study-single.html in real kits); that preamble is preserved and
  prepended, never dropped.
- A file with **no** `<!DOCTYPE>`/`<html>` at all — `header.html`/
  `footer.html`, already the bare `<header>…</header>`/`<footer>…</footer>`
  fragment shape `transform-chrome.md` produces — passes through as-is.
- Strips `WPCanAI-PREVIEW-LIBS` blocks (WPCanAI injects the equivalent
  itself via `wp_head()`/`wp_footer()`).
- Converts every `<!-- Section: X -->` HTML comment to `{# Section: X #}`
  Twig (canai-prepare Handoff #7) so the WPCanAI editor's structure menu
  populates correctly.
- Reads `template_type` off the leading
  `<!-- wpcanai-template: template_type=X -->` comment (present on every
  typed single/archive template, every Woo structural template, and both
  chrome partials — absent on a plain one-off page) and removes that
  comment from the pushed HTML (its information now lives in the artifact's
  own `template_type` field).
- Routes a stray `<style>`/non-preview `<script>` block to `css`/`js`
  respectively (should not occur per the current prompts — canai-prepare's
  own contract forbids `<style>` in generated output — but this stage never
  trusts that blindly).
- **A file that doesn't match the expected shape fails LOUDLY, per file** —
  ambiguous double-wrapped input (e.g. more than one `<!DOCTYPE>`/`<html>`),
  a missing `<body>`/`</body>` pair, an empty file, or a fragment that
  extracts to nothing are all reported by filename with a specific reason
  and **never** converted into a silently-wrong artifact. A run that
  converts nothing exits non-zero, same convention as every other stage.

Output:

```
runs/<site>/output/push/<slug>.json
```

Each file: `{ "source", "kind": "page"|"template", "slug", "title",
"template_type", "html", "css", "js", "warnings" }`. `title` is the page's
`<title>` text (`null` for a chrome partial, which has no `<head>`); `html`
is the corrected `_canai_html` value; `css`/`js` are usually empty (real
kit output rarely has stray `<style>`/inline `<script>` to route) but exist
for the rare file that does. `warnings` flags anything worth a human's
attention without failing the conversion — most notably: **`header.html`/
`footer.html` must be pushed with their `wpcanai_template` post's SLUG
forced to the exact bare string `header`/`footer`** (never a
descriptive/prefixed title) — `wpcanai_template('header')` resolves by
slug, not title or `template_type` term, and a "prefix everything" instinct
silently breaks every include site-wide with no error anywhere (dogfood A2
Defect #7).

**8. verify** — render every generated HTML — templates included, with real
sample data — screenshot it, and score it against its original capture.

```bash
"$HOME/.claude/skills/canai-replicate/bin/replica" verify example.com
```

A plain file with no Twig syntax (`{{`/`{%`) opens raw via `file://` and is
screenshotted directly, same as v2. A file that DOES contain Twig — every
page-type template, plus any one-off page that includes the shared
`{{ wpcanai_template('header'|'footer') }}` chrome — is rendered first
through the plugin's own vendored `twig/twig` (`src/php/render-harness.php`;
no WordPress dependency, stubs every Twig function `TwigFactory.php`
registers) with the sample capture's real content mapped onto
`CONTENT-MODEL.md`'s declared field names (`src/contentModelFields.mjs`
parses the field/taxonomy tables; `src/sampleHarvest.mjs` pulls real
headings/paragraphs/images/links/tables out of that sample's `content.json`
to fill them, plus `get_menu()`'s stub nav harvested from the same
representative capture `transform`'s chrome bundle used). The rendered HTML
is saved to `verify/<slug>-rendered.html`, then screenshotted and diffed
like any other page. **A template that fails to render degrades to "not
scored" with the concrete error surfaced** (e.g. a missing
`CONTENT-MODEL.md`) — never a crash, never a silent 0.

Two things are deliberately excluded from scoring, for different reasons:

- **The shared `header.html`/`footer.html` chrome partials** are dropped
  entirely — not even listed under "Not scored" — because they're partials,
  not independently-renderable pages (stderr notes each one skipped:
  `(skipping shared-chrome partial, not an independently scorable page:
  header.html)`).
- **WooCommerce structural pages** (shop/cart/checkout/my-account/
  order-received/product-category) are listed under "Not scored" with the
  reason given — WooCommerce itself owns their session/cart/catalog state,
  which a static capture can't stand in for, so rendering isn't attempted.

Writes `runs/example.com/verify/<slug>-generated.png` for every rendered
file under `output/pages/` and `output/templates/` (minus the excluded
chrome partials), `verify/<slug>-rendered.html` for anything that went
through the Twig harness, plus `runs/example.com/verify/report.md` — scored
entries (pages **and** templates alike now) sorted worst-first by a
content-weighted severity (`mismatchPct + 0.3 × heightDeltaPct`: mismatch
counts in full since it's the direct signal that pixels are wrong; height
delta contributes only a fraction because it alone can't tell "faithful but
taller from a font fallback" apart from "missing a section" — see the
comment above `buildReportLines` in `src/verify.mjs` for the full derivation
and the calibration cases that pin the 0.3 weight). A rendered archive
template's height delta is structurally inflated by design — it can only
loop over however many samples were captured (2–3), never the live site's
full catalog, so read that number as a layout/structure check, not a
literal defect count. Fix the worst page, re-run `transform --only <path>`,
re-verify.

## Output layout

```
runs/<site>/
├── pages.json                        # discovered pages
├── pagetypes.json                    # page types (post-classify) + top-level one-off `pages`
├── .classify/PROMPT.md               # classify review prompt — rename/prune before capturing
├── captures/<slug>/
│   ├── screenshot.png                # full-page
│   ├── sections/                     # per-section PNGs (header → footer)
│   ├── sections.json                 # role + tag + class + dimensions per file
│   ├── dom.html                      # post-hydration outerHTML (data-capture-id tagged)
│   ├── content.json                  # { header, main:[sections], footer } incl. tables/
│   │                                  #   definitionLists/labelValuePairs
│   ├── assets.json                   # asset URLs
│   ├── styles.json                   # { desktop, mobile } computed-style tokens + roles
│   └── ux.json                       # interactive-pattern inventory → Alpine recipe names
├── DESIGN.md                         # site-wide style system
├── .designmd/PROMPT.md               # bundle prompt for the design-analysis pass
├── CONTENT-MODEL.md                  # CPT/field/taxonomy handoff (skipped if no repeating types)
├── .contentmodel/{PROMPT.md,samples.json}  # bundle prompt + per-type sample index
├── .transform/chrome/PROMPT.md       # bundle prompt for shared site chrome (once per site)
├── .transform/<slug>/PROMPT.md       # bundle prompt per one-off page
├── .transform/type-<name>/PROMPT.md  # bundle prompt per page type
├── output/
│   ├── pages/<slug>.html             # generated one-off pages (canai-prepare format)
│   └── templates/
│       ├── header.html               # shared site chrome (template_type=header), once per site
│       ├── footer.html               # shared site chrome (template_type=footer), once per site
│       ├── <type>-single.html        # reusable Twig template (single:<cpt>, woo:product)
│       ├── <type>-archive.html       # reusable Twig archive template (when the type has one)
│       └── <type>.html               # WooCommerce structural page (shop/cart/checkout/
│                                      #   my-account/order-received/product-category)
├── output/push/<slug>.json           # pushprep output — THIS is what gets pushed to
│                                      #   WordPress (see Handoff below), never a raw
│                                      #   output/pages/ or output/templates/ file
└── verify/
    ├── <slug>-generated.png          # rendered output for review (page OR template)
    ├── <slug>-rendered.html          # Twig-rendered HTML w/ real sample data (only for
    │                                 #   outputs containing Twig syntax — templates, or
    │                                 #   pages that include the shared header/footer)
    ├── report.md                     # worst-first diff-score table (pages + templates)
    │                                 #   + Not-scored list (Woo structural, render failures)
    └── index.json                    # every rendered pair, machine-readable
```

## Handoff

1. **Materialize CONTENT-MODEL.md** on the destination site (user step):
   via the Pods plugin, or by installing the generated PHP snippet with
   Easy Code Manager / FluentSnippets — both are fully supported. WPCanAI
   1.43.1+ resolves `item.fields.<name>` (including `.url` on an image/file
   field) whether the field came from Pods or from a plain
   `register_post_meta()` snippet: `PostEnricher::get_post_fields()` falls
   back to raw post meta per-field whenever Pods doesn't define that field
   itself. On a destination site running an older WPCanAI, the
   `register_post_meta()` path renders every field silently empty (no
   error) — confirm the destination's WPCanAI version, or upgrade it first,
   if you're not sure.
2. **Run `pushprep` first, then push its output** via canai-mcp /
   canai-localwp — **never** write a raw `output/pages/*.html` or
   `output/templates/*.html` file into `_canai_html` (see step 7/pushprep
   above: it's a full standalone document, and WPCanAI's own render path
   wraps it in a second document shell — this is dogfood A2's CRITICAL
   Defect #1, reproduced live). Push the `runs/<site>/output/push/<slug>.json`
   artifacts instead: an entry with `template_type: null` is a canai-prepare
   page (its `html`/`css`/`js` go straight into `_canai_html`/`_canai_css`/
   `_canai_js` on a new `page` post); an entry with a `template_type` is a
   `wpcanai_template` post — assign that exact value as the `template_type`
   taxonomy term. **Push `header.json` and `footer.json` first**
   (`template_type` `header`/`footer` — WPCanAI's own pre-seeded terms):
   every other page/template calls `{{ wpcanai_template('header') }}` /
   `{{ wpcanai_template('footer') }}`, which resolves by the template
   post's exact **slug** — NOT by title, and NOT by the `template_type`
   term — so those two posts need to exist, with their slug forced to the
   **literal bare string** `header`/`footer`, before anything that includes
   them is rendered. **This is not a minor detail**: titling either post
   descriptively (e.g. "Header — Acme migration") auto-slugs it away from
   the bare string, and every `{{ wpcanai_template('header') }}` call
   site-wide then silently resolves to nothing — no error, just an empty
   include (dogfood A2 Defect #7; `pushprep` itself surfaces this as a
   `warnings` entry on `header.json`/`footer.json`, but the actual WordPress
   post creation step — outside this skill — is where the slug must
   actually be forced).
3. **Sideload images referenced by absolute/hotlinked URL, not just local
   paths.** A `pushprep` artifact's `html` still contains the source
   site's original absolute image URLs (e.g.
   `https://original-site.com/wp-content/uploads/...`) — canai-mcp's own
   "Static-site asset sideload pre-pass" is written for a local static-site
   folder, but the SAME sideload-then-rewrite-to-`image_attrs()`/
   `media_url()` treatment applies here: an image left as a hotlinked
   absolute URL can 404 or render broken once the source site's own hotlink
   protection kicks in — confirmed live (dogfood A2 Defect #6, a broken
   cookbook-cover image on a pushed one-off page). Run the sideload pre-pass
   over each `pushprep` artifact's `html` before writing it, the same as any
   other static-site import.
4. **A repeating type's archive template may not be a live, paginated
   post loop.** `classify`'s mechanical grouping sometimes picks an
   `archiveUrl` that turns out to be a curated taxonomy/facet hub on the
   source site, not a "latest N posts" listing — `transform-template.md`
   correctly disclosed this with a `<!-- FIELD GAP -->` comment at the top
   of the generated `<type>-archive.html` rather than forcing a fake
   `{% for post in posts %}` loop (confirmed live twice: dogfood A1 Defect
   #6, dogfood A2 Defect #4 on smittenkitchen.com's `/recipes/` hub). **Read
   that comment before pushing an archive template** — if present, a real
   "latest posts" listing needs separate authoring on the destination (its
   own one-off page, or a dedicated taxonomy-landing template), not the
   pushed file as-is.
5. **Content entry/import** is out of scope for this skill; once content
   exists, the templates render it.

- **[canai-mcp](../canai-mcp/SKILL.md)** — remote site (live / staging)
- **[canai-localwp](../canai-localwp/SKILL.md)** — local WP via WP-CLI

- **Native-i18n targets.** If the destination site uses WPCanAI native
  translation, the receiving skill (canai-mcp / canai-localwp) first routes
  on the site's translation model, then the import wraps user-facing strings
  in `{{ t('…') }}` and uses `tmedia()` for per-language media. Produce copy
  that stays cleanly wrappable (no markup inside translatable strings), same
  as canai-prepare.

## Failure modes

- **A `ls` of `captures/<slug>/` overstates how much real data you have** —
  a directory existing on disk does NOT mean its capture succeeded; a crash
  partway through leaves an empty-ish directory with no `content.json` (or
  one with stub/placeholder fields). Confirmed live twice (dogfood A1 Defect
  #1, dogfood A2 Defect #5 on smittenkitchen.com: 9 of 11 recipe capture
  directories were crash debris with no `content.json`, indistinguishable
  from real captures by a plain `ls`). Before picking sample captures for
  anything downstream (content entry, a demo, a design review), check
  **file size / `content.json` presence**, not directory existence —
  `find runs/<site>/captures -maxdepth 1 -type d ! -exec test -s {}/content.json \; -print`
  lists every capture missing real content. (`capture`'s own crash
  resilience — bounded recovery, per-page failure reporting — is handled in
  `src/capture.mjs`; this note is about not being fooled by a run captured
  before that resilience existed, or by any capture that still fails after
  its recovery attempt.)
- **`ERR_BLOCKED_BY_CLIENT` on capture** — Chrome's active tab is a restricted
  webview (Gemini Glic sidebar, devtools, chrome://). The capture script
  forces a fresh tab automatically; if it persists, close those tabs and
  retry.
- **Below-the-fold sections look blank** — the capture script scrolls the
  whole page first to fire IntersectionObservers and force `loading="lazy"`
  images to eager. If you still see blanks, the site likely uses an unusual
  reveal mechanism; inspect `dom.html` and add a CSS hook to the `REVEAL_JS`
  block in `src/capture.mjs`.
- **Section detection picks wrong blocks, or zero blocks** — `SECTIONS_JS`
  (in `src/capture.mjs`) drills through single-child wrapper chains under
  `<main>` until it finds sibling `<section>`/`<div>` blocks. Themes with
  unusual nesting may need the drill cap raised, or a site-specific selector
  hint added. Two known gaps: a page with genuinely no
  `<header>`/`<footer>`/`<main>` landmark tags **zero** sections at all
  (`content.json.main` comes back empty — seen on a WooCommerce shop archive
  built with a page-builder theme that skips those tags entirely); a page
  cluttered with third-party chat-widget/cookie-banner containers can get
  those tagged as "sections" instead of the real content. Inspect
  `sections.json` and `dom.html` and add a selector hint when either bites.
- **A section's clip is too large and gets skipped, not hung** — a
  single-wrapper layout (common in some React/Vue app shells) can get its
  entire page tagged as one giant "hero". `src/cdp.mjs` refuses any clip over
  4000×6000px / 12M px² *before* opening a connection (`clipSizeError`), and
  every CDP call has its own timeout — this now fails fast with a clear
  message recorded in `sections.json` (`file: null, error: "refusing to
  capture node screenshot: ..."`) instead of hanging the whole capture run.
- **`<footer>` looks empty in the screenshot** — the site's actual `<footer>`
  may be a thin near-invisible bar (white-on-white text, etc.). The capture
  is correct; the visible "footer-looking" CTA bar above it is captured as
  the last `section-N`. Both are in `output` for the agent to use.
- **Classify groups unrelated pages** — the DOM fingerprint collapses
  repeated tag runs; visually different pages built from one generic wrapper
  can collide. Fix `pagetypes.json` by hand during the `.classify/PROMPT.md`
  review — that file is the contract, the heuristics are only a draft.
- **A chrome partial that quotes its own include syntax recurses
  infinitely** — `header.html`/`footer.html` are plain Twig files, and Twig
  parses `{{ }}`/`{% %}` wherever they appear in the source, including
  inside an HTML comment — it has no concept of "this text is inert
  documentation" the way a browser does. A comment in `header.html` that
  spelled out its own `{{ wpcanai_template('header') }}` invocation
  literally made the file call itself while rendering itself: real infinite
  recursion (a PHP memory-exhaustion fatal), reproduced once in practice,
  not hypothetical. `render-harness.php`'s `wpcanai_template()` now also
  carries a 10-level recursion guard that throws a clean, fast error
  instead of exhausting memory. If you're hand-editing a chrome partial,
  describe the include mechanism in prose, never its literal invocation
  syntax, in that file's own comments.
- **Verify scores look terrible everywhere** — check `heightDeltaPct` first: a
  large height delta usually means a missing section, not bad styling. Diff
  is top-left-anchored, so one early missing block cascades. Fix the worst
  page, re-run `transform --only`, re-verify.

## Authoritative reference

The canai-prepare format spec — preview markers, layout/header/footer split,
Alpine patterns, Lucide conventions, asset paths — lives in the
**[canai-prepare](../canai-prepare/SKILL.md)** skill (and its
`references/BOILERPLATE.md`). If anything in this skill conflicts with
canai-prepare, canai-prepare wins.
