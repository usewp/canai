# Layout recipes — section composition library (page-mode)

Use these when authoring a **page-mode** fidelity draft. Alpine recipes cover
*behavior*; this file covers *geometry* — how a section is composed in the
slice PNGs.

## How to use (required)

For **every** `content.json:main` entry (especially `role: "hero"`):

1. Open `sections-desktop/NN-<id>.png` and `sections-mobile/NN-<id>.png`.
2. Classify the desktop (and mobile) composition using the checklist below.
3. Pick the **one** closest recipe. Do not invent a hybrid that matches neither.
4. Emit a comment before the landmark: `<!-- layout: <recipe-name> -->`.
5. Fill the recipe’s slots with that entry’s `content.json` fields **only**.
6. If mobile and desktop disagree (e.g. stacked @390, split @1440), author
   mobile-first with the stacked recipe, then add `lg:` / `xl:` utilities from
   the split recipe — never the reverse.

**Classification checklist (desktop slice first):**

| Look for | Prefer recipe |
| --- | --- |
| Text block centered, CTAs under copy, no side-by-side media column | `hero-stacked-center` |
| Text left-aligned in one column; media absent or full-width below | `hero-stacked-start` |
| Two clear columns: copy \| media (media on the right) | `hero-split-media-end` |
| Two clear columns: media \| copy (media on the left) | `hero-split-media-start` |
| Full-bleed photo/video with text overlaid on top | `hero-overlay` |
| Row of equal metric cells (big number + label) | `band-stats` |
| Grid of equal cards (3–4 across on desktop) | `band-cards` |
| Wide media / dark video band with little or no copy | `band-media` |
| Generic two-column content (not a hero) | `band-split` |
| Single column of copy + one CTA (not hero-tall) | `band-stack` |

**Anti-priors:** Do **not** default to `lg:grid-cols-2` because “heroes are
often split.” If the desktop slice is one centered column, use
`hero-stacked-center` even when the entry has an `images[]` array (image may
sit above/below text, not beside it).

**CTAs:** Use only `buttons` / `links` text from **this** entry, in order.
The visually primary control in the slice must keep that same label — never
borrow a CTA from a neighbor section because it “looks better in a hero.”

---

## hero-stacked-center

Centered stack. Typical marketing hero when the PNG shows a single text
column in the middle.

```html
<!-- layout: hero-stacked-center -->
<section class="px-4 py-16 text-center lg:py-24">
  <div class="mx-auto max-w-3xl">
    <!-- optional eyebrow / h1 from content.json headings only -->
    <h1 class="font-display text-4xl font-bold tracking-tight text-ink lg:text-5xl">…</h1>
    <p class="mt-4 text-lg text-ink/80">…</p>
    <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
      <a class="inline-flex bg-brand px-6 py-3 font-semibold text-white">PRIMARY CTA</a>
      <!-- secondary only if present in this entry -->
    </div>
    <!-- image below copy when the slice shows media under the text column -->
    <img class="mx-auto mt-10 w-full max-w-xl" src="…" alt="…" />
  </div>
</section>
```

## hero-stacked-start

Same single-column idea, left-aligned (common when the brand is not centered).

```html
<!-- layout: hero-stacked-start -->
<section class="px-4 py-16 lg:px-8 lg:py-24">
  <div class="mx-auto max-w-3xl lg:mx-0 lg:max-w-2xl">
    <h1 class="font-display text-4xl font-bold text-ink lg:text-5xl">…</h1>
    <p class="mt-4 text-lg text-ink/80">…</p>
    <div class="mt-8 flex flex-wrap gap-3">
      <a class="inline-flex bg-brand px-6 py-3 font-semibold text-white">PRIMARY CTA</a>
    </div>
  </div>
</section>
```

## hero-split-media-end

Two columns on desktop; media on the **end** (right in LTR). Stack on mobile
(`flex-col` → `lg:grid`).

```html
<!-- layout: hero-split-media-end -->
<section class="px-4 py-12 lg:px-8 lg:py-20">
  <div class="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:items-center">
    <div>
      <h1 class="font-display text-4xl font-bold text-ink">…</h1>
      <p class="mt-4 text-lg text-ink/80">…</p>
      <div class="mt-8 flex flex-wrap gap-3">
        <a class="inline-flex bg-brand px-6 py-3 font-semibold text-white">PRIMARY CTA</a>
      </div>
    </div>
    <div>
      <img class="h-auto w-full" src="…" alt="…" />
    </div>
  </div>
</section>
```

Use only when the **desktop** slice clearly shows side-by-side columns.
If Elementor (or similar) reverses on tablet, still judge from the 1440 PNG,
then let mobile stack naturally.

## hero-split-media-start

Media on the **start** (left). Same grid; swap column order (`order` or put
the `<img>` first).

```html
<!-- layout: hero-split-media-start -->
<section class="px-4 py-12 lg:px-8 lg:py-20">
  <div class="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:items-center">
    <div class="order-2 lg:order-1">
      <img class="h-auto w-full" src="…" alt="…" />
    </div>
    <div class="order-1 lg:order-2">
      <h1 class="font-display text-4xl font-bold text-ink">…</h1>
      <p class="mt-4 text-lg text-ink/80">…</p>
      <div class="mt-8 flex flex-wrap gap-3">…</div>
    </div>
  </div>
</section>
```

## hero-overlay

Full-bleed background; text sits on top. Prefer a real `<img>` or
`bg-[url(…)]` from `assets.json` / this entry’s images — not a decorative
gradient invented to “look premium.”

```html
<!-- layout: hero-overlay -->
<section class="relative min-h-[28rem] overflow-hidden text-white">
  <img class="absolute inset-0 h-full w-full object-cover" src="…" alt="" />
  <div class="absolute inset-0 bg-ink/50"></div>
  <div class="relative mx-auto flex min-h-[28rem] max-w-4xl flex-col items-center justify-center px-4 py-20 text-center">
    <h1 class="font-display text-4xl font-bold lg:text-5xl">…</h1>
    <p class="mt-4 text-lg text-white/90">…</p>
    <a class="mt-8 inline-flex bg-brand px-6 py-3 font-semibold">PRIMARY CTA</a>
  </div>
</section>
```

---

## band-stats

Equal metric cells in one row on desktop; wrap on mobile.

```html
<!-- layout: band-stats -->
<section class="bg-surface px-4 py-12 lg:py-16">
  <div class="mx-auto grid max-w-5xl grid-cols-2 gap-8 text-center md:grid-cols-4">
    <div>
      <p class="text-3xl font-bold text-brand">1.1M+</p>
      <p class="mt-1 text-sm text-ink/70">label from content.json</p>
    </div>
    <!-- one cell per stat in this entry — do not invent extra metrics -->
  </div>
</section>
```

## band-cards

Card grid. Column count from the desktop slice (usually 3 or 4), not from taste.

```html
<!-- layout: band-cards -->
<section class="px-4 py-16">
  <div class="mx-auto grid max-w-6xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
    <article class="…">…</article>
  </div>
</section>
```

## band-media

Mostly media; minimal copy. Keep height generous — crushing this band is a
common cause of full-page height Δ failures.

```html
<!-- layout: band-media -->
<section class="bg-ink px-0 py-0">
  <img class="h-auto w-full object-cover" src="…" alt="…" />
</section>
```

## band-split

Non-hero two-column content.

```html
<!-- layout: band-split -->
<section class="px-4 py-12 lg:py-16">
  <div class="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:items-center">
    <div>…</div>
    <div>…</div>
  </div>
</section>
```

## band-stack

Single-column band (features intro, CTA strip, simple text block).

```html
<!-- layout: band-stack -->
<section class="px-4 py-12 lg:py-16">
  <div class="mx-auto max-w-3xl">
    <h2 class="text-3xl font-bold text-ink">…</h2>
    <p class="mt-4 text-ink/80">…</p>
  </div>
</section>
```

---

## Token placeholders

Class names like `bg-brand`, `text-ink`, `font-display`, `bg-surface` are
stand-ins — replace with the real tokens from **DESIGN.md** for the site.
Do not introduce a parallel color system inside these recipes.
