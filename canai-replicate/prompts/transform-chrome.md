# Task: site chrome (header + footer) → two reusable Twig partials

You are converting the site's **header** and **footer** — captured once, from
one representative page — into **two small, reusable Twig partial files**.
Every other output this migration produces (one-off pages AND page-type
templates alike) includes these two files instead of writing its own
`<header>`/`<footer>` markup. This is the single most important rule in this
prompt: **if you inline a `<header>` or `<footer>` element anywhere else in
this migration, you have done it wrong** — that is exactly the bug this
prompt exists to prevent (see "Why this file exists" below).

## Why this file exists

Without a shared chrome partial, every page/template writes its own copy of
the header and footer. On a real migration this was caught two ways at
once: the copies **disagreed** (a case-study single template's header had 5
dropdown submenus and 17 links; the archive template's header — same
site, same nav — had 1 dropdown and 8 links), and **none of them** used
WordPress's own menu system (every link was a hardcoded
`home_url('/some/path/')`), so the client's **Appearance → Menus** screen
edited nothing — the "menu" was baked into N different HTML files instead of
being data. One header, generated once, included everywhere, driven by a
real WordPress menu, fixes both problems at the source.

## What you must do

1. Read the **representative capture** named under "Inputs" below — its
   `content.json.header` and `content.json.footer` (link/heading/image/
   button/form inventory), its `screenshot.png` (visual reference), and its
   `sections.json` (role/tag/dimensions) for whichever section(s) correspond
   to the header/footer chrome.
2. Read **DESIGN.md** for the site-wide design tokens (this is the SAME
   design system every other output in this migration uses — the chrome must
   look native to the rest of the site, not like a separate skin).
3. Read that capture's **ux.json** for the header's interactive patterns
   (typically `nav-toggle` and, if the nav has flyouts, `dropdown-menu`) and
   reproduce them via the **exact, verbatim** recipe in `alpine-recipes.md`
   (path under Inputs below) — copy the recipe's HTML structure and Alpine
   attributes as given, substituting only real content. Do **not** invent an
   alternative reactivity pattern. In particular:
   - The recipe's responsive "always visible at `lg` and up" behavior is
     `class="lg:!block"` on the `<nav>` element (Tailwind's `!important`
     variant overriding the `x-show`-driven inline `display:none`) — never
     `x-show="open || window.innerWidth >= 1024"` or any other
     `window.innerWidth` check. Alpine's reactivity is driven by its own
     data properties (`open`, here) re-evaluated on events; it has **no**
     built-in reactivity to `window.innerWidth` at all — a `window.innerWidth`
     read inside `x-show` is evaluated once, at whatever moment Alpine
     happens to re-run that expression, and then goes stale until something
     *else* changes `open`. It will not update when the viewport crosses the
     breakpoint on its own (resize, rotate, dev-tools docking), which is
     exactly the bug this literal-recipe rule exists to prevent. `lg:!block`
     needs no resize listener at all — the breakpoint is CSS media-query
     driven, which the browser already recomputes continuously for free.
   - `@click.outside` lives on the shared ancestor (`<header x-data>`) that
     contains *both* the toggle button and the `<nav>` — never on `<nav>`
     alone. This is the recipe as written; do not "simplify" it back.

## Navigation MUST come from a real WordPress menu, not hardcoded links

This is the second thing this prompt exists to fix. CanAI registers two
theme-independent nav menu locations, `primary` and `footer` (confirmed in
`src/Menus/MenuLocations.php` and documented in
`ai/canai-mcp/references/REFERENCE.md`: *"CanAI registers exactly these two
nav locations itself, whatever the theme, and they are the only names
`get_menu()` should be called with: a header loops `get_menu('primary')`, a
footer `get_menu('footer')`."*).
The Twig function is registered in `src/Templating/TwigFactory.php` and
returns a plain array of `{title, raw_title, url, target, classes, active,
children, id, parent, depth, description, raw_description, attr_title, icon,
image}` objects. `children` is the same item shape, recursive, built from
WordPress' real `menu_item_parent` relationships (i.e. whatever nesting the
client actually set up in **Appearance → Menus**) — a nested dropdown/mega-menu
submenu is real, editable menu data, not something `get_menu()` is unable to
express. The array is **flat**: every item appears in it, sub-items included
(`depth` is `0` for a top-level item), and each item also carries its
`children`. So a loop that renders `item.children` must iterate the top level
only — `get_menu('primary')|filter(i => i.depth == 0)` — or every sub-item
renders twice (the scan reports that loop as `menu_children_twice`).
Since plugin v1.89.0 an item also carries `description` (a one-line blurb),
`icon` (a Lucide icon name, `''` when none), `image` (an attachment id, `0`
when none) and `attr_title`, and an item with children may have no link at
all (`url` is `''`): a dropdown trigger or a mega-menu column heading.

- **Header primary nav** — loop the top level of `get_menu('primary')`; for
  a dropdown/flyout item, loop its `children` too:
  ```twig
  <nav id="primary-nav" aria-label="Primary" x-show="open" class="lg:!block …">
    {% for item in get_menu('primary')|filter(i => i.depth == 0) %}
      {% if item.children is empty %}
        <a href="{{ item.url }}" class="{{ item.active ? 'text-brand' : '' }} hover:text-brand">{{ item.title }}</a>
      {% else %}
        <div class="relative" x-data="{ sub: false }">
          <button @click="sub = !sub" class="{{ item.active ? 'text-brand' : '' }} hover:text-brand">{{ item.title }}</button>
          <div x-show="sub" @click.outside="sub = false" class="absolute …">
            {% for child in item.children %}
              <a href="{{ child.url }}" class="{{ child.active ? 'text-brand' : '' }} block hover:text-brand">{{ child.title }}</a>
            {% endfor %}
          </div>
        </div>
      {% endif %}
    {% endfor %}
  </nav>
  ```
  (the dropdown markup/Alpine pattern above is illustrative — follow
  `alpine-recipes.md`'s actual `dropdown-menu` recipe verbatim per the rule
  above; only the `item.children`/`child` data-source part is new.)
- **Footer link columns** — loop `get_menu('footer')` the same way (filter
  the top level whenever a column renders its `children`).
- **Mega menus are menu data too.** A multi-column panel grouped under
  non-clickable headings, with an icon, a one-line description or a
  thumbnail per link, maps onto the item shape: each column heading is an
  item with `children` and no link (`url` is `''`), each link carries
  `icon` / `description` / `image`. Render it from the data:
  ```twig
  {% for column in item.children %}
    {% if column.url %}<a href="{{ column.url }}">{{ column.title }}</a>{% else %}<span>{{ column.title }}</span>{% endif %}
    {% for link in column.children %}
      <a href="{{ link.url }}">
        {% if link.image %}<img {{ image_attrs(link.image, 'src:thumbnail,alt') }}>{% elseif link.icon %}<i data-lucide="{{ link.icon }}"></i>{% endif %}
        {{ link.title }}{% if link.description %}<small>{{ link.description }}</small>{% endif %}
      </a>
    {% endfor %}
  {% endfor %}
  ```
  Record each link's icon name, description and image in the migration's
  menu data so they are written with the menu (the MCP `write-menu` item
  takes `description`, `icon`, `image` — an attachment id — and headings as
  items with `children` and neither `page` nor `url`).
- **Never** write `<a href="{{ home_url('/about/') }}">About</a>` (or any
  other hardcoded sitewide-nav link) as the *default* — that is precisely
  the 26-hardcoded-links bug this prompt exists to fix, and it is invisible
  to WordPress's own Menus screen. A hardcoded `turl('/path/')` link is only an
  acceptable **fallback**, and only for structure a menu item genuinely
  cannot hold:
  - **Content inside a mega-menu panel that is not a link list** — a promo
    card with its own heading, price and button, a search box, a video.
    That block may stay hardcoded inside the panel, with a
    `<!-- FIELD GAP: this mega-menu promo block is not menu data -->`
    comment so it is a disclosed, deliberate simplification, not an
    invisible one. The panel's links, headings, icons, descriptions and
    thumbnails are NOT this case: they come from `get_menu()`.
  - **Logo / home link, legal/social links unique to the footer** (privacy
    policy, social icons) that were never part of a captured nav menu to
    begin with — these were never editable via Menus on the source site
    either, so hardcoding them is not a regression.
  If the representative capture's nav has a simple, single-level structure
  (the common case), the ENTIRE visible link list should come from
  `get_menu()` and there should be **no** fallback links at all.

## Twig rules

- **Never quote a Twig call's real curly-brace syntax inside an HTML
  comment in the file you are writing.** Twig parses its own delimiters
  (double-open-brace / double-percent-brace / double-hash-brace and their
  closing counterparts) wherever they appear in the source text — it has no
  concept of "this is inside an HTML comment, skip it" the way a browser
  does. A "helpful" comment at the top of `header.html` explaining *"this
  file is included via [the real wpcanai_template call written out
  literally]"* makes Twig invoke that call again while it is still
  rendering this very file — real, reproduced infinite self-recursion (a
  PHP memory-limit fatal error), not a hypothetical risk. If you need to
  document the include mechanism, name it in prose ("the wpcanai_template
  Twig helper") instead of writing its actual invocation syntax anywhere in
  this file's own comments.
- **These are partials, not documents.** Do **not** wrap either file in
  `<!DOCTYPE html>`/`<html>`/`<head>`/`<body>`, and do **not** repeat the
  Tailwind/Alpine/Lucide `<script>` tags or the
  `<!-- WPCanAI-PREVIEW-LIBS -->` markers — those belong exactly once, in
  the page/template that includes this partial (which already loads them in
  its own `<head>`). Write only the `<header>…</header>` element itself (for
  `header.html`) or the `<footer>…</footer>` element itself (for
  `footer.html`).
- Start `header.html`'s content with
  `<!-- wpcanai-template: template_type=header -->` and `footer.html`'s with
  `<!-- wpcanai-template: template_type=footer -->` — CanAI pre-seeds
  `header`/`footer` (alongside `layout`/`component`) as `template_type`
  taxonomy terms for exactly this purpose; tag the two
  `wpcanai_template` posts with these terms when creating them in wp-admin.
- Tailwind utility classes inline, DESIGN.md tokens, Lucide icons
  (`<i data-lucide="…">` + the shared `lucide.createIcons()` call the parent
  page already makes — do not add another one here), semantic HTML5 — same
  conventions as every other output in this migration.
- `turl('/')` for the logo link target (it follows the current language;
  never `home_url()` + a prefix) and `custom_logo()` or a literal `<img>`
  for the wordmark are fine — those are not nav links.

## Sample-fidelity check

Before finishing: mentally substitute the representative capture's real nav
items into your header/footer — the result must reproduce that capture's
screenshot header/footer band (layout and link text, not pixels). If the
capture's chrome shows a distinct visible element with nothing above to
carry it (e.g. a promo bar, a language switcher), flag it with
`<!-- FIELD GAP: … -->` rather than silently dropping it.

## Inputs (read these)

This section is completed by `transform.mjs` with the real paths for this
run — the representative capture's directory, `DESIGN.md`, and the Alpine
recipe library — followed by the two output paths
(`output/templates/header.html`, `output/templates/footer.html`).
