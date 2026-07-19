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

This is the second thing this prompt exists to fix. WPCanAI registers two
theme-independent nav menu locations, `wpcanai_primary` and `wpcanai_footer`
(confirmed in `wpcanai.php`'s `register_nav_menus()` call and documented in
`ai/canai-mcp/references/REFERENCE.md`: *"WPCanAI registers `wpcanai_primary`
and `wpcanai_footer` nav locations itself; render them with
`get_menu('wpcanai_primary')` rather than the theme's `get_menu('primary')`"*).
The Twig function is registered in `src/Templating/TwigFactory.php` and
returns a plain array of `{title, url, target, classes, active, children}`
objects. `children` is the same item shape, recursive, built from WordPress'
real `menu_item_parent` relationships (i.e. whatever nesting the client
actually set up in **Appearance → Menus**) — a nested dropdown/mega-menu
submenu is real, editable menu data now, not something `get_menu()` is
unable to express (verified against the function's own real implementation).
Every item still appears in the same flat top-level array too (so a
single-level loop over `get_menu(...)` alone is still correct for a site
with no sub-items) — `children` is purely additive.

- **Header primary nav** — loop `get_menu('wpcanai_primary')`; for a
  dropdown/flyout item, loop its `children` too:
  ```twig
  <nav id="primary-nav" aria-label="Primary" x-show="open" class="lg:!block …">
    {% for item in get_menu('wpcanai_primary') %}
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
- **Footer link columns** — loop `get_menu('wpcanai_footer')` the same way.
- **Never** write `<a href="{{ home_url('/about/') }}">About</a>` (or any
  other hardcoded sitewide-nav link) as the *default* — that is precisely
  the 26-hardcoded-links bug this prompt exists to fix, and it is invisible
  to WordPress's own Menus screen. A hardcoded `home_url()` link is only an
  acceptable **fallback**, and only for structure `get_menu()` genuinely
  cannot express:
  - A **nested dropdown/mega-menu submenu whose sub-items need more than a
    title + link** — `get_menu()`'s item shape (including `children`) only
    carries `{title, url, target, classes, active}` per item; a mega-menu
    with per-sub-item icons, descriptions, thumbnails, or a multi-column
    layout grouped under non-clickable headings is real content `get_menu()`
    cannot carry, so THOSE richer sub-items may stay as hardcoded links
    reproducing the sample, with a `<!-- FIELD GAP: get_menu()'s item shape
    has no icon/description/thumbnail field; this submenu's rich content is
    hardcoded -->` comment so it's a disclosed, deliberate simplification,
    not an invisible one. A plain nested link list (the common case — most
    dropdown/flyout submenus) is NOT this case: use `item.children` for it,
    per the loop above, exactly like a top-level item.
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
  `<!-- wpcanai-template: template_type=footer -->` — WPCanAI pre-seeds
  `header`/`footer` (alongside `layout`/`component`) as `template_type`
  taxonomy terms for exactly this purpose; tag the two
  `wpcanai_template` posts with these terms when creating them in wp-admin.
- Tailwind utility classes inline, DESIGN.md tokens, Lucide icons
  (`<i data-lucide="…">` + the shared `lucide.createIcons()` call the parent
  page already makes — do not add another one here), semantic HTML5 — same
  conventions as every other output in this migration.
- `home_url()` (bare, for the logo link target) and `custom_logo()` or a
  literal `<img>` for the wordmark are fine — those are not nav links.

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
