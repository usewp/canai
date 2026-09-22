# Markdown for agents (`Accept: text/markdown`)

Use this reference when the user asks whether the site "serves Markdown", wants a page readable by
an AI crawler or agent, asks about `Accept: text/markdown` / `?format=markdown`, or wants the
feature turned off. Shipped in plugin **v1.76.0**.

A CanAI takeover page answers a Markdown request with the page's **content** as Markdown. Nothing
changes for a browser: negotiation is per-request and opt-in, so a normal visit still gets the full
HTML page. There is **no per-page toggle and no way to force Markdown on a page the rules exclude** —
the only switch is the site-wide option below.

## When Markdown is served

Markdown is served when `text/markdown` is present with **q greater than 0** and `text/html` is
either absent or ranked at a **strictly lower q**. A tie goes to HTML. Wildcards never count as
either type — a browser sends `*/*` on every navigation, so honouring it would swap the page out
from under the visitor.

| Request | Served |
|---|---|
| `Accept: text/markdown` | **Markdown** |
| `Accept: text/markdown, text/html;q=0.9` | **Markdown** |
| `Accept: text/markdown;charset=utf-8` (parameters other than `q` are ignored) | **Markdown** |
| any request with `?format=markdown` in the query string | **Markdown** (alias, always wins) |
| `Accept: text/markdown;q=0.9, text/html` | HTML |
| `Accept: text/markdown;q=1, text/html;q=1` (equal q) | HTML |
| `Accept: text/markdown;q=0` | HTML |
| `Accept: */*` or `Accept: text/*` | HTML |
| `Accept: text/html,application/xhtml+xml,…,*/*;q=0.8` (any browser) | HTML |
| no `Accept` header | HTML |

**GET and HEAD only.** Any other method renders HTML as usual. A `HEAD` request gets the headers
(including the token counts) and no body.

## What is converted

**Only the page's content slot — never the layout.** Header, footer, navigation and any other
layout chrome are excluded before conversion. The content root inside the rendered slot is:

1. `<main>` when the slot has one — but if that `<main>` holds exactly one `<article>`, the
   article wins, since a lone article is the readable composition;
2. otherwise a lone `<article>`, when the slot has exactly one;
3. otherwise the whole fragment.

The "exactly one" rule matters. A shop, archive or card grid legitimately wraps **every** card in
its own `<article>`, and there the container is the content — taking the first article would
return one product tile and throw the page away.

This is the same markup discipline that [READING-MODE.md](READING-MODE.md) asks for, and for the
same reason: one `<article>` around the readable body, real `<p>` paragraphs, and navigation /
CTAs / related content kept outside it. A page written to that checklist produces clean Markdown
with no extra work; a page that wraps everything in one `<div>` converts the whole fragment,
sidebars included. When a user complains the Markdown is noisy, fix the markup per READING-MODE.md
rather than looking for a Markdown setting.

## The document shape

A YAML front matter block, then the converted body, then the structured data section when the page
has any JSON-LD.

Front matter keys are emitted **in this order**: `title`, `description`, `canonical`, `updated`,
`image`. Each key is **omitted entirely when its value is empty**, and every value is
**double-quoted**. JSON-LD found on the page is appended as a `## Structured data` section
containing a fenced `json` block.

````markdown
---
title: "About Acme — Acme Co."
description: "Why we build tools for small teams."
canonical: "https://example.com/about/"
updated: "2026-09-22T10:14:07+00:00"
image: "https://example.com/wp-content/uploads/2026/09/team.jpg"
---

# About Acme

Acme has built tools for small teams since 2014…

## Structured data

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Acme Co."
}
```
````

## Response headers

On the **Markdown** response:

| Header | Value |
|---|---|
| `Content-Type` | `text/markdown; charset=utf-8` |
| `Vary` | `Accept` |
| `X-Markdown-Tokens` | estimated token count of the Markdown document |
| `X-Original-Tokens` | estimated token count of the HTML the Markdown replaced |

On the **HTML** response for a page that has a Markdown representation: `Vary: Accept`, a
`Link: <url>; rel="alternate"; type="text/markdown"` header, and a matching
`<link rel="alternate" type="text/markdown" href="…">` in the document head. That is how an agent
discovers the representation exists without guessing.

## Which plugin answered

A sibling plugin, **ToSAI** (plugin name "ToSAI - Web ChatFlow"), also serves Markdown site-wide,
including for pages CanAI does not render. The two cooperate through ToSAI's
`wptosai_serve_markdown` filter — CanAI declines the pages it will not answer and claims the ones
it will — so exactly one of them answers any given request. Read the response headers to tell which:

| Headers on the response | Served by |
|---|---|
| `X-WPToSAI-Markdown-Cache` present | **ToSAI** |
| `X-Markdown-Tokens` present, no `X-WPToSAI-Markdown-Cache` | **CanAI** |

This matters when the output does not look like a CanAI page: if ToSAI served it, the fix is in
ToSAI's settings, not in CanAI's meta or this reference.

## What CanAI never serves as Markdown

These stay HTML because they are transactional UI — Markdown would hide the controls the visitor
needs:

- WooCommerce **cart**, **checkout**, **my-account** and **order-received** pages.
- The **account / checkout endpoint** pages: `order-pay`, `add-payment-method`, `orders`,
  `view-order`, `downloads`, `edit-account`, `edit-address`, `payment-methods`, `lost-password`.

Also skipped: 404s, password-protected posts, editor preview requests, and any page CanAI does not
render (no `_canai_html` and not marked as a blocks page). ToSAI may still answer some of these —
check the headers above before reporting that a URL "does not support Markdown".

## The toggle

One site-wide option, `**wpcanai_markdown_negotiation**`, **default on (`'1'`)**. It is a
first-class CanAI settings key on the settings whitelist, so read and write it with the settings
tools — **not** with `wpcanai-get-option` / `wpcanai-update-options`, and never tell the user to
add it to the generic option allowlist under Guardrails.

- Read: `**wpcanai-read-settings**` — the value comes back as `"1"` (on) or `"0"` (off).
- Turn off: `**wpcanai-update-settings**` with `{ "settings": { "wpcanai_markdown_negotiation": "0" } }`.
- Turn back on: the same call with `"1"`.

Reasons a site owner turns it off: a caching layer that does not vary on `Accept`, a host that
rewrites the header, or simply not wanting agents to read the site. There is no middle setting and
no per-page override — do not describe one.

## Filters (for site developers)

Only relevant when the user is writing PHP on the site (a theme, an mu-plugin, or a snippet via the
`canai-yolo` skill) — not something this skill configures over MCP.

| Filter | Changes |
|---|---|
| `wpcanai_markdown_enabled` | Whether CanAI may answer this request with Markdown at all |
| `wpcanai_markdown_source_html` | The HTML fragment before it is converted |
| `wpcanai_markdown_front_matter` | The front matter field map (extra keys render after the known five) |
| `wpcanai_markdown_output` | The final Markdown body, after conversion and before front matter |

## Verifying

There is no MCP tool that asserts this — check it over HTTP. Headers first:

```sh
curl -sI -H 'Accept: text/markdown' https://example.com/about/
```

Expect `content-type: text/markdown; charset=utf-8`, `vary: Accept`, `x-markdown-tokens` and
`x-original-tokens`. Then the body:

```sh
curl -s -H 'Accept: text/markdown' https://example.com/about/
```

The query alias needs no header, which makes it the quickest thing to paste to a user:

```sh
curl -s 'https://example.com/about/?format=markdown'
```

And confirm the HTML response advertises the alternate:

```sh
curl -sI https://example.com/about/ | grep -iE '^(vary|link):'
```

If HTML comes back for a Markdown request, work down the list in order: the option is off, the page
is one of the excluded WooCommerce pages, the page is not a CanAI page at all, the `Accept` header
ranked `text/html` at the same q or higher, or a proxy/CDN in front of the site is serving a cached
HTML response that did not vary on `Accept`. A browser will never see Markdown, so "it still looks
normal in Chrome" is not a symptom of anything.
