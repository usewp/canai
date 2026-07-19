// Tests for pushprep — the push-ready-artifact converter that closes dogfood
// A2's Defect #1 (CRITICAL): pushing a canai-replicate output file verbatim
// into `_canai_html` doubles WPCanAI's own document shell around it.
//
// Fixtures below are verbatim (or verbatim-excerpted) content from the two
// real dogfood corpora named in the task brief:
//   - smittenkitchen.com (canai-replicate v3.1 dogfood A2 run) — about.html
//     (one-off page), recipe-single.html / recipe-archive.html (typed
//     templates), header.html / footer.html (shared chrome).
//   - humanmade.com — case-study-single.html (a second typed-template shape:
//     self-enrichment preamble BEFORE <!DOCTYPE>, feeding both <title> and
//     body content).
// Excerpts are trimmed for test-file size but every structural marker this
// module parses (DOCTYPE/html/head/body counts, WPCanAI-PREVIEW-LIBS
// markers, the wpcanai-template header comment, Section comments, the
// pre-doctype {% set %} preamble) is reproduced byte-for-byte from the real
// files. Synthetic fixtures (clearly marked) cover shapes no real kit
// exhibits: <style>/non-preview <script> blocks, and malformed input.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { convertKitFile, preparePushArtifacts } from "./pushprep.mjs";

// --- Real-kit fixture: one-off page (smittenkitchen.com about.html) --------
// Verbatim head (DOCTYPE, title, preview-libs, tailwind config) + verbatim
// chrome-include section comments + ONE real content section ("Briefly")
// taken verbatim from the real dogfood file, + verbatim closing preview-libs
// script. No invented copy — every string here occurs in the real file.
const SK_ABOUT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About – smitten kitchen</title>
  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only; WPCanAI loads these via wp_head() on the live site -->
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
  <script src="https://unpkg.com/lucide@0.577.0/dist/umd/lucide.min.js"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            brand: { DEFAULT: '#6B7794', dark: '#50565A' },
          },
        },
      },
    };
  </script>
</head>
<body class="antialiased bg-white font-sans text-brand-dark">
  <!-- Section: Site header — shared site chrome; see transform-chrome.md. Never inline a <header> here. -->
  {{ wpcanai_template('header') }}

  <main id="main-content">
    <!-- Section: Hero (about-page body) -->
    <section class="mx-auto max-w-3xl px-4 py-12">
      <h2 id="about-briefly" class="mt-10 text-post-title text-brand">Briefly</h2>
      <p class="mt-4 text-base">Fearless cooking from a tiny kitchen in New York City.</p>
    </section>
  </main>

  <!-- Section: Site footer — shared site chrome; see transform-chrome.md. Never inline a <footer> here. -->
  {{ wpcanai_template('footer') }}

  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
`;

// --- Real-kit fixture: typed template with leading preamble + header comment
// (smittenkitchen.com recipe-single.html) — verbatim leading {% set %}
// block, verbatim <title> reading `item`, verbatim wpcanai-template comment,
// verbatim ingredient loop (the `|split("\n")` this repo's own dogfood
// Defect #2 was about — kept intact here since pushprep must NOT touch
// backslash sequences, only wp_slash() at write-time does).
const SK_RECIPE_SINGLE_TEMPLATE = `{% set item = wpcanai_get_posts_enriched({
  'p': post.ID,
  'post_type': 'recipe',
  'wpcanai_include': 'featured_image,fields,taxonomy_items',
  'wpcanai_fields': ['recipe_servings', 'recipe_time', 'recipe_source', 'recipe_ingredients'],
  'wpcanai_taxonomy': ['recipe_category']
})|first %}
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{{ item.post_title }} – smitten kitchen</title>
  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only; WPCanAI loads these via wp_head() on the live site -->
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries,typography"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</head>
<body class="antialiased bg-white font-sans text-brand-dark">
  <!-- wpcanai-template: template_type=single-recipe -->
  <!-- Section: Site header — shared site chrome; see transform-chrome.md. Never inline a <header> here. -->
  {{ wpcanai_template('header') }}

  <main id="main-content">
    <article class="mx-auto max-w-3xl px-4 py-12">
      <h1 class="mt-4 text-post-title text-brand">{{ item.post_title }}</h1>
      <h3 class="mt-6 text-nav font-bold uppercase text-brand-dark">Ingredients</h3>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-base">
        {% for line in item.fields.recipe_ingredients|split("\\n") %}
          {% if line|trim %}<li>{{ line|trim }}</li>{% endif %}
        {% endfor %}
      </ul>
    </article>
  </main>

  <!-- Section: Site footer — shared site chrome; see transform-chrome.md. Never inline a <footer> here. -->
  {{ wpcanai_template('footer') }}

  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
`;

// --- Real-kit fixture: shared chrome partial (smittenkitchen.com header.html)
// verbatim in full — already the bare fragment shape (no DOCTYPE/head/body).
const SK_HEADER_CHROME = `<!-- wpcanai-template: template_type=header -->
<!-- The source site's logo is a custom inline SVG "sk" monogram (captured
     data only exposed leaked CSS text from it, not usable vector paths), so
     this reproduces the header's layout/position with a styled text
     wordmark instead of fabricated SVG markup. -->
<header id="masthead" class="site-header border-b border-border bg-white" x-data="{ open: false, more: false }" @click.outside="open = false">
  <div class="mx-auto max-w-5xl px-4 py-6 text-center">
    <a href="{{ home_url() }}" class="site-logo-link inline-flex flex-col items-center gap-1 text-brand" aria-label="smitten kitchen home">
      <span class="text-3xl font-bold leading-none">sk</span>
    </a>
  </div>
</header>
`;

const SK_FOOTER_CHROME = `<!-- wpcanai-template: template_type=footer -->
<footer id="colophon" class="site-footer bg-surface py-12">
  <div class="mx-auto flex max-w-5xl flex-col items-center gap-8 px-4">
    <p class="text-nav font-semibold uppercase text-brand">Smitten Kitchen</p>
  </div>
</footer>
`;

// --- Real-kit fixture: humanmade.com case-study-single.html — a SECOND
// typed-template shape, self-enrichment preamble feeding <title> (verbatim
// leading comment + {% set %} block from the real file).
const HM_CASE_STUDY_SINGLE = `{# Self-enrichment happens BEFORE <head> — <title> below also needs \`item\`,
   and Twig's {% set %} only takes effect for what comes after it in render
   order, so this cannot live down in <body> (that shipped broken once:
   <title> rendered empty until this block moved up here). #}
{% set item = wpcanai_get_posts_enriched({
  'p': post.ID,
  'post_type': 'case_study',
  'wpcanai_include': 'featured_image,fields,taxonomy_items',
  'wpcanai_fields': ['case_study_client_name'],
  'wpcanai_taxonomy': ['case_study_industry']
})|first %}
<!DOCTYPE html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <title>{{ item.post_title }} – Human Made</title>
  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only; WPCanAI loads these via wp_head() on the live site -->
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries,typography"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</head>
<body class="antialiased">
  <!-- wpcanai-template: template_type=single-case_study -->
  {{ wpcanai_template('header') }}
  <main><h1>{{ item.post_title }}</h1></main>
  {{ wpcanai_template('footer') }}
  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
`;

// =============================================================================
// Coverage: page file (one-off page, no template_type comment)
// =============================================================================

test("convertKitFile: real smittenkitchen.com about.html — extracts body-inner only, no doubled shell markers", () => {
  const r = convertKitFile(SK_ABOUT_PAGE, { filename: "about.html", kind: "page" });
  assert.equal(r.ok, true);
  const { artifact } = r;
  assert.equal(artifact.kind, "page");
  assert.equal(artifact.slug, "about");
  assert.equal(artifact.template_type, null, "a one-off page carries no wpcanai-template comment");
  assert.equal(artifact.title, "About – smitten kitchen");

  // The defect this whole module exists to prevent: NONE of the
  // document-shell tags may survive into the extracted html.
  assert.doesNotMatch(artifact.html, /<!DOCTYPE/i);
  assert.doesNotMatch(artifact.html, /<html[\s>]/i);
  assert.doesNotMatch(artifact.html, /<head[\s>]/i);
  assert.doesNotMatch(artifact.html, /<\/?body[\s>]?/i);
  assert.doesNotMatch(artifact.html, /<title[\s>]/i);

  // Preview-libs must be gone — WPCanAI injects the equivalent itself.
  assert.doesNotMatch(artifact.html, /WPCanAI-PREVIEW-LIBS/);
  assert.doesNotMatch(artifact.html, /cdn\.tailwindcss\.com/);
  assert.doesNotMatch(artifact.html, /lucide\.createIcons/);

  // The real content and the shared-chrome includes must survive.
  assert.match(artifact.html, /wpcanai_template\('header'\)/);
  assert.match(artifact.html, /wpcanai_template\('footer'\)/);
  assert.match(artifact.html, /Fearless cooking from a tiny kitchen in New York City\./);

  // Section comments become Twig comments (canai-prepare Handoff #7).
  assert.match(artifact.html, /\{# Section: Hero \(about-page body\) #\}/);
  assert.doesNotMatch(artifact.html, /<!--\s*Section:/i);
});

test("convertKitFile: a page's <head>-only tailwind.config script never leaks into the extracted html (belongs on the destination layout, not per-page)", () => {
  const r = convertKitFile(SK_ABOUT_PAGE, { filename: "about.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.artifact.html, /tailwind\.config/);
});

// =============================================================================
// Coverage: typed template file with header comment + preamble
// =============================================================================

test("convertKitFile: real smittenkitchen.com recipe-single.html — preserves the pre-DOCTYPE {% set %} preamble and reads template_type from the header comment", () => {
  const r = convertKitFile(SK_RECIPE_SINGLE_TEMPLATE, { filename: "recipe-single.html", kind: "template" });
  assert.equal(r.ok, true);
  const { artifact } = r;
  assert.equal(artifact.kind, "template");
  assert.equal(artifact.template_type, "single-recipe");
  assert.equal(artifact.title, "{{ item.post_title }} – smitten kitchen");

  // The leading preamble (needed by both <title> and body content) must
  // survive even though it lives BEFORE <!DOCTYPE> in the source file.
  assert.match(artifact.html, /\{% set item = wpcanai_get_posts_enriched/);
  assert.match(artifact.html, /'post_type': 'recipe'/);

  // The machine-readable header comment is consumed into `template_type`,
  // not duplicated into the live page.
  assert.doesNotMatch(artifact.html, /wpcanai-template:\s*template_type/);

  // The literal backslash-n split (dogfood Defect #2's exact vulnerable
  // string) must survive completely untouched — pushprep only extracts
  // structure, it never touches Twig filter syntax.
  assert.match(artifact.html, /item\.fields\.recipe_ingredients\|split\("\\n"\)/);

  assert.doesNotMatch(artifact.html, /<!DOCTYPE/i);
  assert.doesNotMatch(artifact.html, /<\/?body[\s>]?/i);
});

test("convertKitFile: humanmade.com case-study-single.html — a second real kit's self-enrichment preamble shape also survives", () => {
  const r = convertKitFile(HM_CASE_STUDY_SINGLE, { filename: "case-study-single.html", kind: "template" });
  assert.equal(r.ok, true);
  assert.equal(r.artifact.template_type, "single-case_study");
  assert.match(r.artifact.html, /\{% set item = wpcanai_get_posts_enriched/);
  assert.match(r.artifact.html, /'post_type': 'case_study'/);
  assert.doesNotMatch(r.artifact.html, /<!DOCTYPE/i);
});

test("convertKitFile: a templates/-kind file with NO header comment warns (not fails) — extraction still succeeds", () => {
  const noComment = SK_ABOUT_PAGE; // a page-shaped file, but pretend it's under output/templates/
  const r = convertKitFile(noComment, { filename: "weird.html", kind: "template" });
  assert.equal(r.ok, true);
  assert.equal(r.artifact.template_type, null);
  assert.ok(
    r.artifact.warnings.some((w) => w.includes("no leading")),
    "must warn when a templates/ file has no wpcanai-template comment",
  );
});

// =============================================================================
// Coverage: chrome header/footer (bare fragment shape, no document wrapper)
// =============================================================================

test("convertKitFile: real smittenkitchen.com header.html — already a bare fragment, passes through with template_type=header", () => {
  const r = convertKitFile(SK_HEADER_CHROME, { filename: "header.html", kind: "template" });
  assert.equal(r.ok, true);
  assert.equal(r.artifact.template_type, "header");
  assert.equal(r.artifact.title, null, "chrome partials have no <title> to derive one from");
  assert.match(r.artifact.html, /<header id="masthead"/);
  assert.doesNotMatch(r.artifact.html, /wpcanai-template:\s*template_type/);
});

test("convertKitFile: real smittenkitchen.com footer.html — same bare-fragment handling", () => {
  const r = convertKitFile(SK_FOOTER_CHROME, { filename: "footer.html", kind: "template" });
  assert.equal(r.ok, true);
  assert.equal(r.artifact.template_type, "footer");
  assert.match(r.artifact.html, /<footer id="colophon"/);
});

test("convertKitFile: header/footer chrome files carry the Defect #7 slug-forcing warning", () => {
  const rHeader = convertKitFile(SK_HEADER_CHROME, { filename: "header.html", kind: "template" });
  const rFooter = convertKitFile(SK_FOOTER_CHROME, { filename: "footer.html", kind: "template" });
  assert.ok(rHeader.artifact.warnings.some((w) => w.includes("force the wpcanai_template post's SLUG")));
  assert.ok(rFooter.artifact.warnings.some((w) => w.includes("force the wpcanai_template post's SLUG")));
});

test("convertKitFile: a non-chrome typed template does NOT get the slug-forcing warning", () => {
  const r = convertKitFile(SK_RECIPE_SINGLE_TEMPLATE, { filename: "recipe-single.html", kind: "template" });
  assert.ok(!r.artifact.warnings.some((w) => w.includes("force the wpcanai_template post's SLUG")));
});

// =============================================================================
// Coverage: a file with <style>/<script> blocks (synthetic — no real kit
// exhibits this; canai-prepare's own contract forbids <style> in generated
// output, so this is defensive/adversarial coverage, not an expected shape)
// =============================================================================

const PAGE_WITH_STYLE_AND_SCRIPT = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Widget Page</title>
  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</head>
<body>
  <main>
    <style>
      .widget-glow { box-shadow: 0 0 8px rgba(0,0,0,0.2); }
    </style>
    <div class="widget-glow" id="my-widget">Widget</div>
    <script>
      console.log('custom widget init');
      document.getElementById('my-widget').dataset.ready = "1";
    </script>
  </main>
  <!-- WPCanAI-PREVIEW-LIBS:START -->
  <script>lucide.createIcons();</script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>
`;

test("convertKitFile: routes a body <style> block into css and strips it from html", () => {
  const r = convertKitFile(PAGE_WITH_STYLE_AND_SCRIPT, { filename: "widget.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.css, /\.widget-glow \{ box-shadow: 0 0 8px rgba\(0,0,0,0\.2\); \}/);
  assert.doesNotMatch(r.artifact.html, /<style/i);
  assert.doesNotMatch(r.artifact.html, /box-shadow/);
});

test("convertKitFile: routes a genuine inline body <script> (not lucide bootstrap, not external) into js and strips it from html", () => {
  const r = convertKitFile(PAGE_WITH_STYLE_AND_SCRIPT, { filename: "widget.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.js, /console\.log\('custom widget init'\)/);
  assert.match(r.artifact.js, /dataset\.ready = "1"/);
  assert.doesNotMatch(r.artifact.html, /<script/i);
  assert.doesNotMatch(r.artifact.html, /custom widget init/);
});

test("convertKitFile: real markup (the widget div) survives style/script extraction untouched", () => {
  const r = convertKitFile(PAGE_WITH_STYLE_AND_SCRIPT, { filename: "widget.html", kind: "page" });
  assert.match(r.artifact.html, /<div class="widget-glow" id="my-widget">Widget<\/div>/);
});

test("convertKitFile: an external <script src=...> surviving into body content (should never happen, but defensively) is dropped with a warning, not silently kept", () => {
  const withExternal = PAGE_WITH_STYLE_AND_SCRIPT.replace(
    "</main>",
    `<script src="https://example.com/evil-or-just-misplaced.js"></script></main>`,
  );
  const r = convertKitFile(withExternal, { filename: "widget.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.artifact.html, /evil-or-just-misplaced/);
  assert.ok(r.artifact.warnings.some((w) => w.includes("dropped an external")));
});

// =============================================================================
// Coverage: malformed file → loud failure (never a silently-wrong fragment)
// =============================================================================

test("convertKitFile: empty file fails loudly", () => {
  const r = convertKitFile("", { filename: "empty.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("file is empty"));
});

test("convertKitFile: whitespace-only file fails loudly (same bucket as empty)", () => {
  const r = convertKitFile("   \n\n  \t", { filename: "whitespace.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("file is empty"));
});

test("convertKitFile: missing </body> fails loudly instead of guessing where content ends", () => {
  const broken = SK_ABOUT_PAGE.replace("</body>\n</html>\n", "");
  const r = convertKitFile(broken, { filename: "about.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /expected exactly one <body>\.\.\.<\/body> pair/);
});

test("convertKitFile: a double-wrapped file (Defect #1's own shape, e.g. accidentally re-run) is refused rather than silently compounding the nesting", () => {
  const doubleWrapped = SK_ABOUT_PAGE + SK_ABOUT_PAGE; // two full documents concatenated
  const r = convertKitFile(doubleWrapped, { filename: "about.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /already double-wrapped/);
});

test("convertKitFile: two <html> tags but only one <!DOCTYPE> is still caught (either signal alone is enough)", () => {
  const weird = SK_ABOUT_PAGE.replace("<title>About", "<html lang=\"en\"><title>About");
  const r = convertKitFile(weird, { filename: "about.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /already double-wrapped/);
});

test("convertKitFile: body content that is ONLY a preview-libs block extracts to nothing and fails loudly rather than pushing an empty page", () => {
  const onlyPreviewLibs = `<!DOCTYPE html>
<html><head><title>Empty</title></head>
<body>
<!-- WPCanAI-PREVIEW-LIBS:START -->
<script>lucide.createIcons();</script>
<!-- WPCanAI-PREVIEW-LIBS:END -->
</body></html>
`;
  const r = convertKitFile(onlyPreviewLibs, { filename: "empty-body.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /extracted content is empty/);
});

// =============================================================================
// Mutation-catching regression tests — each pins a load-bearing regex
// against a specific, plausible weakening. See the report's mutation matrix
// for the full mapping of test -> mutation caught.
// =============================================================================

test("mutation guard: preview-libs stripping is non-greedy — real content BETWEEN two blocks in the same fragment must survive", () => {
  // A greedy `[\s\S]*` (instead of the correct `[\s\S]*?`) would span from
  // the FIRST START to the LAST END, destroying "REAL MIDDLE CONTENT" below.
  const fragment = `<!-- WPCanAI-PREVIEW-LIBS:START -->
<script src="https://cdn.tailwindcss.com"></script>
<!-- WPCanAI-PREVIEW-LIBS:END -->
<p>REAL MIDDLE CONTENT</p>
<!-- WPCanAI-PREVIEW-LIBS:START -->
<script>lucide.createIcons();</script>
<!-- WPCanAI-PREVIEW-LIBS:END -->
`;
  // Not a full document, so this exercises the bare-fragment branch directly.
  const r = convertKitFile(fragment, { filename: "chrome-ish.html", kind: "template" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.html, /REAL MIDDLE CONTENT/);
  assert.doesNotMatch(r.artifact.html, /cdn\.tailwindcss\.com/);
  assert.doesNotMatch(r.artifact.html, /lucide\.createIcons/);
});

test("mutation guard: preview-libs stripping is global — BOTH blocks in one fragment are removed, not just the first", () => {
  const fragment = `<!-- WPCanAI-PREVIEW-LIBS:START -->AAA<!-- WPCanAI-PREVIEW-LIBS:END -->
<p>keep me</p>
<!-- WPCanAI-PREVIEW-LIBS:START -->BBB<!-- WPCanAI-PREVIEW-LIBS:END -->
`;
  const r = convertKitFile(fragment, { filename: "two-blocks.html", kind: "template" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.artifact.html, /AAA/);
  assert.doesNotMatch(r.artifact.html, /BBB/);
  assert.match(r.artifact.html, /keep me/);
});

test("mutation guard: Section-comment conversion is global — every Section comment converts, not just the first", () => {
  const fragment = `<!-- Section: One -->
<p>first</p>
<!-- Section: Two -->
<p>second</p>
`;
  const r = convertKitFile(fragment, { filename: "sections.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.html, /\{# Section: One #\}/);
  assert.match(r.artifact.html, /\{# Section: Two #\}/);
  assert.doesNotMatch(r.artifact.html, /<!--\s*Section:/);
});

test("mutation guard: Section-comment conversion is non-greedy — content between two Section comments is not swallowed", () => {
  // A greedy capture group would span from the first "Section:" through the
  // LAST "-->" in the string, eating "<p>survives</p>" and the second
  // comment's own text into one giant match.
  const fragment = `<!-- Section: One -->
<p>survives</p>
<!-- Section: Two -->
`;
  const r = convertKitFile(fragment, { filename: "sections2.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.html, /<p>survives<\/p>/);
  assert.match(r.artifact.html, /\{# Section: One #\}/);
  assert.match(r.artifact.html, /\{# Section: Two #\}/);
});

test("mutation guard: style-block extraction is global — multiple <style> blocks all get captured and removed", () => {
  const fragment = `<div><style>.a { color: red; }</style></div>
<div><style>.b { color: blue; }</style></div>
`;
  const r = convertKitFile(fragment, { filename: "two-styles.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.css, /\.a \{ color: red; \}/);
  assert.match(r.artifact.css, /\.b \{ color: blue; \}/);
  assert.doesNotMatch(r.artifact.html, /<style/);
});

test("mutation guard: the src= detector uses a word boundary — an attribute merely CONTAINING \"src\" (e.g. nonsrc=) is not mistaken for a real src attribute", () => {
  // Without \\b, /src\\s*=/i would false-positive on "nonsrc=" and wrongly
  // drop this legitimate inline script as if it were an external reference.
  const fragment = `<script nonsrc="1">realCode();</script>`;
  const r = convertKitFile(fragment, { filename: "attr-boundary.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.js, /realCode\(\);/);
  assert.ok(!r.artifact.warnings.some((w) => w.includes("dropped an external")));
});

test("mutation guard: a genuinely external <script src=...> (real src attribute) IS detected and dropped, while sibling real content survives", () => {
  const fragment = `<p>keep me</p>\n<script src="https://example.com/x.js"></script>`;
  const r = convertKitFile(fragment, { filename: "real-src.html", kind: "page" });
  assert.equal(r.ok, true);
  assert.equal(r.artifact.js, "");
  assert.match(r.artifact.html, /<p>keep me<\/p>/);
  assert.doesNotMatch(r.artifact.html, /example\.com/);
  assert.ok(r.artifact.warnings.some((w) => w.includes("dropped an external")));
});

test("mutation guard: a file that is ENTIRELY an undroppable external <script src> with nothing else fails loudly instead of silently emitting an all-empty artifact", () => {
  const fragment = `<script src="https://example.com/x.js"></script>`;
  const r = convertKitFile(fragment, { filename: "only-external.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /extracted content is empty/);
  assert.ok(r.errors.some((e) => e.includes("dropped an external")), "the dropped-script warning must surface inside the error, not vanish");
});

test("mutation guard: doctype/html-tag over-count threshold is exactly '> 1', not '>= 1' — a normal single document must still pass", () => {
  const r = convertKitFile(SK_ABOUT_PAGE, { filename: "about.html", kind: "page" });
  assert.equal(r.ok, true, "a single, well-formed document must never be rejected as 'double-wrapped'");
});

test("mutation guard: body open/close count check requires exactly one of EACH — an extra stray </body> alone (odd, but a real signal) is caught", () => {
  // On its own line, matching how a real extra closing tag would actually
  // appear (every real structural tag in the sampled kits opens its own
  // line — see the line-anchoring comment in pushprep.mjs).
  const weird = SK_ABOUT_PAGE.replace("</main>", "</main>\n  </body>");
  const r = convertKitFile(weird, { filename: "about.html", kind: "page" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /found 1 open tag\(s\) \/ 2 close tag\(s\)/);
});

test("mutation guard: the preamble is captured verbatim (not off-by-one truncated at the DOCTYPE boundary)", () => {
  const r = convertKitFile(SK_RECIPE_SINGLE_TEMPLATE, { filename: "recipe-single.html", kind: "template" });
  assert.equal(r.ok, true);
  // The full {% set %} block, including its closing `})|first %}` line,
  // must be present and unbroken.
  assert.match(r.artifact.html, /\}\)\|first %\}/);
});

test("mutation guard: a bare fragment with NO <html>/<!DOCTYPE> anywhere is never routed through the full-document branch (chrome partials would wrongly demand a <body> pair)", () => {
  // If /<!DOCTYPE|<html[\\s>]/i lost its <html> alternative, or gained a
  // false match against plain text, header.html would either wrongly demand
  // a <body>...</body> pair (and fail) or wrongly slice a "preamble".
  const r = convertKitFile(SK_HEADER_CHROME, { filename: "header.html", kind: "template" });
  assert.equal(r.ok, true);
  assert.match(r.artifact.html, /^<!-- The source site's logo/);
});

// =============================================================================
// Stage-level tests (I/O): preparePushArtifacts
// =============================================================================

async function mkRun(site, files) {
  const root = await mkdtemp(path.join(tmpdir(), "pushprep-test-"));
  const runDir = path.join(root, "runs", site);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(runDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return { root, runDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function withSilencedStderr(fn) {
  return async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await fn();
    } finally {
      process.stderr.write = original;
    }
  };
}

test(
  "preparePushArtifacts: converts every output/pages + output/templates file, writes flat output/push/<slug>.json",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkRun("example.com", {
      "output/pages/about.html": SK_ABOUT_PAGE,
      "output/templates/recipe-single.html": SK_RECIPE_SINGLE_TEMPLATE,
      "output/templates/header.html": SK_HEADER_CHROME,
      "output/templates/footer.html": SK_FOOTER_CHROME,
    });
    try {
      const r = await preparePushArtifacts({ site: "example.com", runsDir: path.join(root, "runs") });
      assert.equal(r.count, 4);
      assert.equal(r.ok, 4);
      assert.equal(r.failures.length, 0);

      const pushDir = path.join(root, "runs", "example.com", "output", "push");
      const about = JSON.parse(await readFile(path.join(pushDir, "about.json"), "utf8"));
      assert.equal(about.kind, "page");
      assert.doesNotMatch(about.html, /<!DOCTYPE/i);

      const recipe = JSON.parse(await readFile(path.join(pushDir, "recipe-single.json"), "utf8"));
      assert.equal(recipe.template_type, "single-recipe");

      const header = JSON.parse(await readFile(path.join(pushDir, "header.json"), "utf8"));
      assert.equal(header.template_type, "header");
    } finally {
      await cleanup();
    }
  }),
);

test(
  "preparePushArtifacts: a malformed file among valid ones is listed in failures and does NOT stop the others from converting",
  withSilencedStderr(async () => {
    const broken = SK_ABOUT_PAGE.replace("</body>\n</html>\n", "");
    const { root, cleanup } = await mkRun("example.com", {
      "output/pages/about.html": SK_ABOUT_PAGE,
      "output/pages/broken.html": broken,
    });
    try {
      const r = await preparePushArtifacts({ site: "example.com", runsDir: path.join(root, "runs") });
      assert.equal(r.count, 2);
      assert.equal(r.ok, 1);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0].file, /broken\.html$/);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "preparePushArtifacts: exit-code contract — when EVERY file fails to convert, ok is 0 even though count > 0 (bin/replica must treat this as a total failure, same shape as capture/verify)",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkRun("example.com", {
      "output/pages/broken.html": "",
    });
    try {
      const r = await preparePushArtifacts({ site: "example.com", runsDir: path.join(root, "runs") });
      assert.equal(r.count, 1);
      assert.equal(r.ok, 0, "0 successes out of 1+ attempted must be reported, mirroring summarizeCountOutcome's isTotalFailure contract");
    } finally {
      await cleanup();
    }
  }),
);

test(
  "preparePushArtifacts: no output/pages or output/templates directories at all — count 0, no crash",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkRun("example.com", {});
    try {
      const r = await preparePushArtifacts({ site: "example.com", runsDir: path.join(root, "runs") });
      assert.equal(r.count, 0);
      assert.equal(r.ok, 0);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "preparePushArtifacts: --only filters to a single slug",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkRun("example.com", {
      "output/pages/about.html": SK_ABOUT_PAGE,
      "output/pages/contact.html": SK_ABOUT_PAGE.replace("About – smitten kitchen", "Contact – smitten kitchen"),
    });
    try {
      const r = await preparePushArtifacts({ site: "example.com", runsDir: path.join(root, "runs"), only: "about" });
      assert.equal(r.count, 1);
      assert.equal(r.artifacts[0].slug, "about");
    } finally {
      await cleanup();
    }
  }),
);

test(
  "preparePushArtifacts: --only matching nothing throws (same convention as transform's 'no pages or types match --only')",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkRun("example.com", {
      "output/pages/about.html": SK_ABOUT_PAGE,
    });
    try {
      await assert.rejects(
        preparePushArtifacts({ site: "example.com", runsDir: path.join(root, "runs"), only: "nope" }),
        /no output\/pages or output\/templates file matches --only nope/,
      );
    } finally {
      await cleanup();
    }
  }),
);

test(
  "preparePushArtifacts: a slug collision between output/pages and output/templates is refused, not silently overwritten",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkRun("example.com", {
      "output/pages/shop.html": SK_ABOUT_PAGE,
      "output/templates/shop.html": SK_RECIPE_SINGLE_TEMPLATE,
    });
    try {
      const r = await preparePushArtifacts({ site: "example.com", runsDir: path.join(root, "runs") });
      assert.equal(r.count, 2);
      assert.equal(r.ok, 1, "only the first-processed file for a colliding slug should succeed");
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0].errors[0], /collides with/);
    } finally {
      await cleanup();
    }
  }),
);
