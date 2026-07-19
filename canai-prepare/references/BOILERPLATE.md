# canai-prepare — Single-HTML boilerplate

Use this as the canonical structure for every generated page. Adjust `lang`, `title`, and body content per page.

## Full document skeleton

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Local preview only: <title> is also emitted by WordPress via wp_head() on the live site -->
  <title>Page Title</title>
  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only; in WordPress these load via wp_head() when enabled in WPCanAI settings -->
  <!-- Live default enables the Tailwind forms + container-queries plugins; mirror them in preview -->
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
  <script src="https://unpkg.com/lucide@0.577.0/dist/umd/lucide.min.js"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</head>
<body class="antialiased bg-white text-gray-900">
  <!-- Section: Site header — maps to header component template "site header" in the main layout ({{ wpcanai_template('site-header') }}) -->
  <header class="border-b border-gray-200">
    <div class="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
      <a href="index.html" class="font-semibold">Site</a>
      <nav class="flex gap-4" aria-label="Primary">
        <a href="index.html" class="text-gray-600 hover:text-gray-900">Home</a>
        <a href="about.html" class="text-gray-600 hover:text-gray-900">About</a>
      </nav>
    </div>
  </header>

  <!-- Section: Main page body — maps to this page’s _canai_html inside {{ page_content }} -->
  <main id="main-content">
    <!-- Section: Hero -->
    <section class="mx-auto max-w-6xl px-4 py-16">
      <h1 class="text-4xl font-bold tracking-tight">Headline</h1>
      <p class="mt-4 text-lg text-gray-600">Supporting copy.</p>
    </section>
  </main>

  <!-- Section: Site footer — maps to footer component template "site footer" in the main layout ({{ wpcanai_template('site-footer') }}) -->
  <footer class="border-t border-gray-200 py-8">
    <div class="mx-auto max-w-6xl px-4 text-center text-sm text-gray-500">
      <p>&copy; Year Site Name</p>
    </div>
  </footer>

  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only; in WordPress icon init runs via wp_footer() when WPCanAI handles Lucide -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
```

## Preview libs vs WPCanAI runtime

- `**<title>`:** Keep a real `<title>` in static files for local preview and tab labels. On the WordPress site, the document title is output through `**wp_head()`** (along with meta the theme adds); avoid duplicating `<title>` inside imported `_canai_html` when the layout/theme already prints it.
- `**<head>` preview block:** Tailwind, Alpine, Lucide script tags mirror what WPCanAI enqueues through `**wp_head()`** (enable libraries in **WPCanAI** settings). Strip `WPCanAI-PREVIEW-LIBS` when importing so hooks do not duplicate them.
- **Before `</body>` preview block:** `lucide.createIcons()` mirrors footer-side init from `**wp_footer()`**. Strip on import for the same reason.
- **Opening the `.html` file locally** still needs `<title>`, charset/viewport, and both preview blocks so the page is usable outside WordPress.

## Header / footer vs layout

For static multi-page exports, keep `<header>` and `<footer>` in every file for linked previews. After WPCanAI import, extract each once into reusable templates:


| Static region        | WPCanAI role                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `<header>…</header>` | **Site header** header-type component (included from main layout) |
| `<main>…</main>`     | Page body `_canai_html`                                             |
| `<footer>…</footer>` | **Site footer** footer-type component (included from main layout) |


Use your project’s actual template slugs; `site-header` / `site-footer` are conventional kebab-case names for the components above.

## Tailwind Play CDN — optional theme extension

Inside a `<script>` **outside** the preview block (or in a separate inline script after Tailwind in preview), you can extend the design tokens:

```html
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          brand: { DEFAULT: '#0f766e', dark: '#115e59' },
        },
        fontFamily: {
          sans: ['system-ui', 'sans-serif'],
        },
      },
    },
  };
</script>
```

In WPCanAI, equivalent tokens often live in the **layout** template’s Tailwind config comment block — align class names with site brand tokens when known.

## Alpine.js — common patterns

Use Alpine only when interactivity needs state (menus, tabs, accordions). Prefer vanilla JS for one-off toggles if simpler.

**Dropdown / mobile nav:**

```html
<div x-data="{ open: false }" class="relative">
  <button type="button" @click="open = !open" :aria-expanded="open" class="flex items-center gap-1">
    Menu
    <i data-lucide="chevron-down" class="h-4 w-4"></i>
  </button>
  <div x-show="open" @click.outside="open = false" x-transition x-cloak class="absolute right-0 mt-2 w-48 rounded border bg-white py-1 shadow-lg">
    <a href="about.html" class="block px-4 py-2 hover:bg-gray-50">About</a>
  </div>
</div>
```

For `x-cloak`, **do not** add a `<style>` block in prepared HTML (WPCanAI convention: no stray styles in markup). After import, add to `**_canai_css`** on the layout:

```css
[x-cloak] { display: none !important; }
```

Or avoid `x-cloak` and use Alpine `class` / `x-show` with Tailwind utilities only.

**Tabs:**

```html
<div x-data="{ tab: 'a' }">
  <div class="flex gap-2 border-b">
    <button type="button" @click="tab = 'a'" :class="tab === 'a' ? 'border-b-2 border-teal-600' : ''">Tab A</button>
    <button type="button" @click="tab = 'b'" :class="tab === 'b' ? 'border-b-2 border-teal-600' : ''">Tab B</button>
  </div>
  <div x-show="tab === 'a'" x-transition>Content A</div>
  <div x-show="tab === 'b'" x-transition>Content B</div>
</div>
```

## Lucide Icons

Markup (icons render after `lucide.createIcons()` in preview, or after WPCanAI’s `**wp_footer()**` / frontend pipeline initializes Lucide):

```html
<i data-lucide="menu" class="h-5 w-5" aria-hidden="true"></i>
<button type="button" aria-label="Close">
  <i data-lucide="x" class="h-5 w-5"></i>
</button>
```

- Use **kebab-case** icon names matching [Lucide](https://lucide.dev/icons/).
- Add meaningful `aria-label` on interactive controls; use `aria-hidden="true"` on decorative icons.

## Media paths

Place user-supplied images, video, and audio under `assets/` next to the HTML files:

```html
<img src="assets/hero.webp" alt="Descriptive alt text" class="h-auto w-full rounded-lg object-cover" width="1200" height="630" loading="lazy">
```

Use **relative URLs** so pages keep working when moved. After upload to the Media Library, replace with `image_attrs()` in Twig during WPCanAI conversion.

## pages.json manifest (multi-page / SPA split)

```json
[
  { "slug": "index", "title": "Home", "file": "index.html" },
  { "slug": "about", "title": "About", "file": "about.html" }
]
```

