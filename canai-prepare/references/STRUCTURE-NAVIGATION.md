# CanAI Structure Navigation Contract

This contract is identical in `canai-prepare` and `canai-mcp` so either skill can be installed and used on its own.

## Grammar

The navigation label is:

```text
Type / Short Label
```

Use the delimiter for the current authoring stage:

| Stage | Syntax | Example |
|---|---|---|
| Static HTML from `canai-prepare` | `<!-- Type / Short Label -->` | `<!-- Section / Featured Products -->` |
| Twig stored by `canai-mcp` | `{# Type / Short Label #}` | `{# Section / Featured Products #}` |
| CanAI Structure metabox | `Type / Short Label` | `Section / Featured Products` |

Conversion changes only the comment delimiters. Preserve the type and label exactly.

## Controlled vocabulary

| Atomic Design role | Allowed types |
|---|---|
| Atom | `Button`, `Input`, `Icon`, `Badge` |
| Molecule | `Card`, `Form`, `Menu`, `Search` |
| Organism | `Header`, `Footer`, `Navigation`, `Section`, `Sidebar` |
| Template/page structure | `Layout`, `Container` |
| Reusable UI pattern | `Accordion`, `Alert`, `Carousel`, `Dialog`, `Drawer`, `Steps`, `Tabs`, `Toast` |

## Required landmark mappings

Every semantic landmark needs its matching navigation label immediately before its opening tag:

| Landmark | Required type |
|---|---|
| `<main>` | `Container` |
| `<section>` | `Section` |
| `<header>` | `Header` |
| `<footer>` | `Footer` |
| `<nav>` | `Navigation` |
| `<aside>` | `Sidebar` |

Examples:

```html
<!-- Header / Site -->
<header>
  <!-- Navigation / Primary -->
  <nav>...</nav>
</header>

<!-- Container / Main Content -->
<main>
  <!-- Section / Featured Products -->
  <section>
    <!-- Card / Product -->
    <article>...</article>
  </section>
</main>

<!-- Footer / Site -->
<footer>...</footer>
```

The Twig form is a direct conversion:

```twig
{# Header / Site #}
<header>
  {# Navigation / Primary #}
  <nav>...</nav>
</header>

{# Container / Main Content #}
<main>
  {# Section / Featured Products #}
  <section>
    {# Card / Product #}
    <article>...</article>
  </section>
</main>

{# Footer / Site #}
<footer>...</footer>
```

## Rules

1. Use one space on both sides of `/`.
2. Use the exact title-case type from the controlled vocabulary.
3. Keep the label human-readable and no longer than 60 characters.
4. Describe the element's role on the page, not its implementation.
5. Add navigation labels to useful components such as cards, forms, and buttons when they help a user jump through the template.
6. Use a reusable UI pattern type only for the complete component, not for its internal controls or panels.
7. Use `<!-- @dev Implementation note -->` in prepared HTML and `{# @dev Implementation note #}` in Twig for programming notes. Developer notes do not belong in the Structure metabox.
8. Do not use `Section:`, decorative banners, internal service names, selectors, query details, or backend terminology as navigation labels.
