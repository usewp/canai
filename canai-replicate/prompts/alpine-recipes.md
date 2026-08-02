# Alpine recipes — UX reproduction library

Each entry maps a `ux.json` recipe name to the Alpine.js pattern to use in
generated output. Rules for ALL recipes:

- **Instant state only.** No `x-transition`, no CSS transitions/animations,
  no duration classes. Animations are out of scope by design. **Page mode
  uses the same rule** — fidelity verify still scores instant-state Alpine,
  never animated transitions.
- Keep ARIA attributes (`aria-expanded`, `aria-controls`, `role`) — they are
  part of the semantic contract, not decoration.
- Prefer the smallest recipe that reproduces the behavior. If the source only
  needs CSS (sticky-header), don't add Alpine at all.
- **`libs.json` is advisory only.** Capture may list Swiper/jQuery/GSAP/etc.
  as detected libraries; that never authorizes a CDN `<script>` or stylesheet.
  Pick the matching Alpine recipe here instead.

## nav-toggle

Mobile hamburger opening the primary nav.

```html
<header x-data="{ open: false }" @click.outside="open = false">
  <button class="lg:hidden" @click="open = !open" :aria-expanded="open" aria-controls="primary-nav">
    <i data-lucide="menu" class="h-6 w-6" x-show="!open"></i>
    <i data-lucide="x" class="h-6 w-6" x-show="open"></i>
  </button>
  <nav id="primary-nav" aria-label="Primary" x-show="open" class="lg:!block">
    …
  </nav>
</header>
```

**`@click.outside` lives on `<header>` (the `x-data` root), not on `<nav>`.**
The toggle `<button>` is a **sibling** of `<nav>`, not a descendant of it —
if `@click.outside="open = false"` sits on `<nav>` instead, the button's own
click also counts as "outside `<nav>`", so the very click that sets
`open = true` is immediately followed by the outside handler setting it back
to `false`: the menu never stays open (verified interactively — a real
Alpine.js footgun, not a hypothetical). Putting `@click.outside` on the
shared ancestor that contains *both* the button and the nav fixes it: a
click on the button is now "inside" the watched element, so it no longer
self-triggers, while a genuine click elsewhere on the page still closes the
menu. Do not "simplify" this back onto `<nav>` — every template built from
this recipe inherits whichever form is here.

## dropdown-menu

Nav item with a nested submenu.

```html
<li x-data="{ open: false }" @mouseenter="open = true" @mouseleave="open = false">
  <button @click="open = !open" :aria-expanded="open">Services
    <i data-lucide="chevron-down" class="h-4 w-4"></i>
  </button>
  <ul x-show="open" class="absolute …">…</ul>
</li>
```

## tabs

```html
<div x-data="{ tab: 'one' }">
  <div role="tablist" class="flex gap-2">
    <button role="tab" :aria-selected="tab === 'one'" @click="tab = 'one'">One</button>
    <button role="tab" :aria-selected="tab === 'two'" @click="tab = 'two'">Two</button>
  </div>
  <div role="tabpanel" x-show="tab === 'one'">…</div>
  <div role="tabpanel" x-show="tab === 'two'">…</div>
</div>
```

## accordion

Prefer native `<details>` when the source is simple disclosure:

```html
<details class="group border-b">
  <summary class="flex cursor-pointer items-center justify-between py-4">
    Question text
    <i data-lucide="chevron-down" class="h-5 w-5 group-open:rotate-180"></i>
  </summary>
  <div class="pb-4">Answer text</div>
</details>
```

Use Alpine only when one-open-at-a-time is required:

```html
<div x-data="{ open: null }">
  <div>
    <button @click="open = open === 1 ? null : 1" :aria-expanded="open === 1">Q1</button>
    <div x-show="open === 1">A1</div>
  </div>
  <div>
    <button @click="open = open === 2 ? null : 2" :aria-expanded="open === 2">Q2</button>
    <div x-show="open === 2">A2</div>
  </div>
</div>
```

## carousel

**Default: degrade to a static grid** (`grid gap-6 md:grid-cols-3`) showing all
slides — this is usually better UX and always better for SEO. Only build the
Alpine prev/next variant when slides genuinely can't coexist (full-bleed hero
sliders):

```html
<section x-data="{ i: 0, n: 3 }" class="relative">
  <div x-show="i === 0">Slide 1</div>
  <div x-show="i === 1">Slide 2</div>
  <div x-show="i === 2">Slide 3</div>
  <button @click="i = (i - 1 + n) % n" aria-label="Previous"><i data-lucide="chevron-left" class="h-6 w-6"></i></button>
  <button @click="i = (i + 1) % n" aria-label="Next"><i data-lucide="chevron-right" class="h-6 w-6"></i></button>
</section>
```

No autoplay. Ever.

## modal

```html
<div x-data="{ open: false }">
  <button @click.stop="open = true">Open</button>
  <div x-show="open" role="dialog" aria-modal="true"
       @keydown.escape.window="open = false"
       class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div @click.outside="open = false" class="max-w-lg rounded-xl bg-white p-6">
      <button @click="open = false" aria-label="Close"><i data-lucide="x" class="h-5 w-5"></i></button>
      …
    </div>
  </div>
</div>
```

**The trigger button needs `.stop` — same footgun class as nav-toggle.**
`@click.outside` sits on the inner panel (so clicking the dark backdrop
still dismisses, which is correct), but the "Open" trigger is a sibling of
that panel too, several levels up. Without `.stop`, opening the modal fires
the button's own handler *and* lets the click keep propagating to the
outside-click listener, which immediately closes what was just opened —
`.stop` keeps that click from ever reaching it. Unlike nav-toggle, do NOT
relocate `@click.outside` up to the outer `x-data` div here: that div also
contains the backdrop, so widening the boundary would make backdrop clicks
stop closing the modal too. Fix the trigger, not the boundary.

## sticky-header

No Alpine. Tailwind only:

```html
<header class="sticky top-0 z-50 bg-white/95 backdrop-blur">…</header>
```
