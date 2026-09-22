# Reading mode (Safari Reader, Firefox Reader View, Chrome reading mode)

Use this reference when the user asks for a page or post to "support reading mode", "open in
reader view", "work with Safari Reader", or similar. It is a **gate first, then a checklist**:
decide whether reading mode is the right goal for the targeted content, stop with an explanation
when it is not, and only then author the markup.

## What reading mode actually is

There is **no switch, meta tag, or plugin setting** that turns reading mode on. Each browser runs
a heuristic over the rendered DOM and decides for itself:

- **Firefox Reader View** runs `isProbablyReaderable` from Readability.js. It counts text only
  inside `<p>`, `<pre>` and `<article>` (plus `<div>` blocks that contain `<br>`). Each counted
  block needs at least **140 characters**; the score is the sum of `sqrt(length - 140)` and must
  reach **20**. In practice: roughly five paragraphs of 200+ characters, or three of 400+.
  Elements whose `class` or `id` matches `banner | breadcrumbs | combx | comment | community |
  cover-wrap | disqus | extra | footer | gdpr | header | legends | menu | related | remark |
  replies | rss | shoutbox | sidebar | skyscraper | social | sponsor | supplemental | ad-break |
  agegate | pagination | pager | popup` are skipped unless they also match `and | article | body |
  column | content | main | shadow`. Anything with `aria-hidden="true"` or `display:none` is skipped.
- **Safari Reader** and **Chrome reading mode** (DOM Distiller) are undocumented but behave the
  same way: one dominant block of paragraph text, a heading inside it, low link density, and a
  strong preference for `<article>`.
- **Nothing in `<head>` influences it.** JSON-LD `Article`, `og:type=article`, and meta tags help
  sharing and SEO but do not trigger reading mode. Do not add them for this purpose.

Reading mode is therefore a property of the **content**, not of the CMS record type. The
WordPress "page vs post" distinction is irrelevant; what matters is whether the content is a
single piece of prose meant to be read top to bottom.

## Step 1 — Gate: is reading mode the right goal for this content?

Read the targeted content with `wpcanai-read-meta` (Twig page/template) or inspect the post body,
then classify it. **Stop and explain** when the content falls in the "not recommended" column;
proceed to the checklist otherwise.

| Content shape | Reading mode | Action |
|---|---|---|
| Blog post, article, news item, guide, tutorial, documentation page, case study, policy / terms / privacy page, long About page | **Recommended** | Proceed to Step 2 |
| Service or product description page whose body is mostly prose (several real paragraphs) | **Recommended** | Proceed to Step 2; keep CTA and pricing outside the article |
| Landing page / home page built from hero, features grid, pricing, testimonials, CTA bands | **Not recommended** | Stop. The page has no dominant prose block; browsers will not offer reading mode however it is marked up, and forcing `<article>` around a marketing grid is wrong HTML semantics |
| Archive / listing page (blog index, category, shop, search results) | **Not recommended** | Stop. Card grids are navigation, not a composition. Each card may legitimately be its own `<article>` but the page as a whole is not readable |
| WooCommerce cart / checkout / my-account / order pages | **Not recommended** | Stop. Transactional UI; reading mode would hide the controls the user needs |
| 404, contact, login, form-centric pages | **Not recommended** | Stop |
| Mixed page: mostly marketing sections plus **one** substantial prose section (e.g. a long "Our story") | **Partial** | Proceed to Step 2 for that section only: wrap just that block in `<article>`, leave the surrounding `<section>` elements untouched, and tell the user reading mode will show only that section |

When stopping, say plainly why (no prose block / transactional UI / listing), and offer the
nearest useful alternative: a dedicated long-form page for the content that should be readable,
or leaving the page as-is.

Also stop when the body copy itself is thin. If the prose totals fewer than roughly **1,000
characters across at least three real paragraphs**, no markup change will pass the browser
threshold. Say so and ask whether the user wants to expand the copy first.

## Step 2 — Checklist: markup that passes the heuristics

Apply all of these to the targeted content. They are correct HTML5 regardless of reading mode,
so they never need to be undone.

1. **One `<article>` around the readable body, inside `<main>`.** Never nest `<main>` inside
   `<article>`; there is one `<main>` per document and the article sits in it. Do not wrap the
   whole page when only part of it is prose (see the "Partial" row above).
2. **The `<h1>` lives inside the `<article>`**, ideally inside a `<header>` at the top of it,
   together with the byline and date. This is how browsers pick the reader-view title.
3. **Body copy is in real `<p>` elements**, one paragraph each. Text in `<div>`, `<span>`,
   `<li>` or headings does **not** count toward the threshold. Convert "paragraph-like" `<div>`s
   to `<p>`.
4. **Date and author.** Emit `<time datetime="{{ post.post_date_gmt|date('c') }}">` and a byline
   link with `rel="author"`. Reader views use these for the header line under the title.
5. **Images inside the article** carry a meaningful `alt` and, where relevant, a `<figure>` +
   `<figcaption>`. Decorative images stay outside or use `alt=""`.
6. **Keep non-reading UI outside the `<article>`**: primary navigation in `<nav>`, sidebars and
   related posts in `<aside>`, CTA bands, share buttons and comment forms as siblings after the
   article. High link density inside the article lowers the score.
7. **Avoid excluded class / id names on the content wrapper.** Tailwind utilities are fine, but
   custom classes or ids containing `header`, `footer`, `sidebar`, `menu`, `social`, `related`,
   `comment`, `banner` or `popup` on the article or its ancestors cause the block to be skipped.
   Prefer neutral names like `post-body` or `prose`.
8. **Do not put `aria-hidden="true"` or `hidden` on anything that carries the text.** Tailwind's
   responsive `hidden md:block` pattern is safe (Readability checks attributes and computed
   `display`, not class names), but duplicated mobile/desktop copies of the text should be
   avoided anyway.
9. **`{# Type / Label #}` navigation comments still apply.** Use `{# Section / Article #}` (or a
   more specific label) immediately before the `<article>`, and `{# Header / Post Details #}` for
   the article header, per [STRUCTURE-NAVIGATION.md](STRUCTURE-NAVIGATION.md).

### Reference shape (Twig, single-post style)

The blog kit's `blog-single-post` template is the canonical example and already passes:

```twig
{# Section / Article #}
<article class="max-w-3xl mx-auto px-6 py-16">
  {# Header / Post Details #}
  <header>
    <h1 class="text-3xl font-bold tracking-tight">{{ post.post_title|raw }}</h1>
    <time datetime="{{ post.post_date_gmt|date('c') }}" class="block text-sm text-slate-500">{{ post.post_date|date('F j, Y') }}</time>
    {% if post.author is defined %}
    <p class="text-sm"><a rel="author" href="{{ post.author.user_url ?: post.author.posts_url }}">{{ post.author.display_name }}</a></p>
    {% endif %}
  </header>
  {% if post.featured_image.src %}
  <figure><img src="{{ post.featured_image.src }}" alt="{{ post.post_title }}"></figure>
  {% endif %}
  <div class="prose prose-lg max-w-none post-body">
    {{ the_content(post.post_content) }}
  </div>
</article>
{# Sidebar / Related #}
<aside>…related posts, share buttons…</aside>
```

For a Twig **page** (`_canai_html`), the same shape applies with the page's own paragraphs in
place of `{{ the_content(...) }}`. For a **blog post** written via `wpcanai-write-post`, the body
is block markup and already renders through `blog-single-post`; the only thing to check is that
the post has enough real paragraph blocks.

## Step 3 — Verify

1. Run `wpcanai-scan` after the write and clear structure findings as usual.
2. Ask the user to open the live URL in Firefox and confirm the Reader View icon appears in the
   address bar, or in Safari and check for the Reader button. There is no server-side way to
   assert this from MCP today; report that honestly rather than claiming it works.
3. If the icon does not appear, the usual causes in order: text not in `<p>` elements, total
   prose under the threshold, an excluded class/id on a wrapper, or the article competing with a
   larger block of link-heavy content elsewhere on the page.
