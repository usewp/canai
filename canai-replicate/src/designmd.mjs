// Prepare a bundle for the design-md skill to consume.
// This module does NOT call an LLM. It assembles the inputs (representative
// screenshots + aggregated computed styles + a prompt) and prints next-step
// instructions. The actual DESIGN.md is produced by a coding agent invoking
// one of the user-level design skills against the bundle.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

// Pages chosen for design extraction. Homepage alone often misses elements —
// long-form text on About and form patterns on Contact round out what the
// design-md skill needs to see. We prefer those three by URL pattern (with a
// few common multilingual variants) and fall back to URL-diversity bucketing
// only when one of the anchors is missing.
const ABOUT_PATTERNS = /^\/?(about|aboutus|tentang|profil|company|who-we-are)(\/|$|-)/i;
const CONTACT_PATTERNS = /^\/?(contact|contactus|hubungi|reach-us|get-in-touch)(\/|$|-)/i;

// Platform/seed routes that are near-universally UNSTYLED — WooCommerce's
// checkout/cart/account/shop templates and WordPress's own default seed
// content (hello-world, sample-page) and utility routes (login, legal
// boilerplate, search, feed) are routinely left in the theme's bare defaults
// even on fully custom-designed sites, because nobody bothers to skin them.
// The diversity fill below must still fall back to these when nothing else
// is available (a shop-only site has no other choice), but must never
// PREFER them over a real, potentially-styled page — see pickRepresentative.
const UTILITY_PATTERNS =
  /^\/?(checkout|cart|my-account|shop|hello-world|sample-page|wp-login|privacy-policy|terms|search|feed)(\/|$|-)/i;

function pathOf(p) {
  try {
    return new URL(p.url).pathname;
  } catch {
    return "";
  }
}

function pickRepresentative(pages, max = 3) {
  const home =
    pages.find((p) => pathOf(p).replace(/\/+$/, "") === "") || pages[0];

  const matchFirst = (re, exclude) =>
    pages.find((p) => !exclude.has(p) && re.test(pathOf(p)));

  const used = new Set();
  const picked = [];

  if (home) {
    picked.push(home);
    used.add(home);
  }

  const about = matchFirst(ABOUT_PATTERNS, used);
  if (about) {
    picked.push(about);
    used.add(about);
  }

  const contact = matchFirst(CONTACT_PATTERNS, used);
  if (contact) {
    picked.push(contact);
    used.add(contact);
  }

  // Fill any remaining slots with URL-diversity picks (one page per top-level
  // path segment), so unusual sites without conventional /about or /contact
  // routes still get a useful sample.
  if (picked.length < max) {
    const buckets = new Map();
    for (const p of pages) {
      if (used.has(p)) continue;
      const key = pathOf(p).split("/").filter(Boolean)[0] || "_";
      if (!buckets.has(key)) buckets.set(key, p);
    }
    // Prefer non-utility candidates; only reach for a platform utility route
    // (see UTILITY_PATTERNS) once every other bucket is exhausted. This is a
    // deprioritization, not an exclusion — a site with nothing but utility
    // routes (e.g. shop-only) must still get a bundle, so utility candidates
    // are kept, just pushed to the back of the fill order.
    const nonUtility = [];
    const utility = [];
    for (const p of buckets.values()) {
      (UTILITY_PATTERNS.test(pathOf(p)) ? utility : nonUtility).push(p);
    }
    for (const p of [...nonUtility, ...utility]) {
      if (picked.length >= max) break;
      picked.push(p);
      used.add(p);
    }
  }

  return picked.slice(0, max);
}

// Candidate pages for design extraction. With pagetypes.json (classify has
// run), capture only ever visits the one-off `pages` plus each type's
// `samples` — never a type's full `members` list (see capture.mjs's
// buildWorklist doc comment) — so picking a candidate from anywhere else
// risks choosing a page whose capture directory doesn't exist. Falls back to
// pages.json (v2 behavior: every discovered URL) when classify hasn't been
// run yet. Exported so candidate selection is unit-testable without staging
// a full run dir (captures/, screenshots, etc.) — see designmd.test.mjs.
export async function loadCandidatePages(runDir) {
  try {
    const pt = JSON.parse(await readFile(path.join(runDir, "pagetypes.json"), "utf8"));
    return [
      ...pt.pages.map((p) => ({ url: p.url })),
      ...pt.types.flatMap((t) => t.samples.map((url) => ({ url }))),
    ];
  } catch {
    const pagesJson = JSON.parse(await readFile(path.join(runDir, "pages.json"), "utf8"));
    return pagesJson.pages;
  }
}

function summarizeStyles(samples) {
  // Aggregate computed styles across the chosen pages into a compact
  // summary. This is the LEGACY aggregate (content.json's own small
  // first-match-per-tag sample) — the per-page captures/<slug>/styles.json
  // copies (desktop+mobile frequency tables + role-based tokens, Task 4) are
  // now the PRIMARY source cited in the prompt; see buildPrompt below.
  const out = {
    fontFamilies: new Set(),
    colors: new Set(),
    backgrounds: new Set(),
    fontSizes: new Set(),
    radii: new Set(),
    perPage: [],
  };
  for (const { slug, content } of samples) {
    const cs = content.computedStyles || {};
    out.perPage.push({ slug, computedStyles: cs });
    for (const v of Object.values(cs)) {
      if (!v) continue;
      if (v.fontFamily) out.fontFamilies.add(v.fontFamily);
      if (v.color) out.colors.add(v.color);
      if (v.backgroundColor && v.backgroundColor !== "rgba(0, 0, 0, 0)") out.backgrounds.add(v.backgroundColor);
      if (v.fontSize) out.fontSizes.add(v.fontSize);
      if (v.borderRadius && v.borderRadius !== "0px") out.radii.add(v.borderRadius);
    }
  }
  return {
    fontFamilies: [...out.fontFamilies],
    colors: [...out.colors],
    backgrounds: [...out.backgrounds],
    fontSizes: [...out.fontSizes],
    radii: [...out.radii],
    perPage: out.perPage,
  };
}

function buildPrompt({ site, bundleDir, picked, groundTruth, domPaths, styleSummary }) {
  const screenshots = picked
    .map((p) => `- ${p.slug}: \`${path.join(bundleDir, p.slug + ".png")}\` (source: ${p.url})`)
    .join("\n");

  const groundTruthList = groundTruth.length
    ? groundTruth.map((p) => `- \`${path.join(bundleDir, p.slug + "-styles.json")}\``).join("\n")
    : "(none of the picked pages have a captured styles.json — fall back to the legacy aggregate and the screenshots below.)";

  const domList = domPaths.map((p) => `- ${p.slug}: \`${p.path}\``).join("\n");

  return `# Task: extract DESIGN.md for ${site}

You are extracting a site-wide design system from real captures of **${site}**. The output is a single \`DESIGN.md\` file that downstream per-page transforms will treat as the source of style truth.

**Use the \`design-md\` skill** to generate the document. Do not reinvent the format.

## Inputs

### Representative screenshots
${screenshots}

(All paths are absolute. Each PNG is the full-page capture of that route. Pages were chosen to cover the homepage plus distinct URL sections.)

### Computed-style ground truth (PRIMARY SOURCE)
Per-page token tables measured from the live DOM at desktop (real viewport) and mobile (375px) widths:
${groundTruthList}

Each \`<slug>-styles.json\` has the shape \`{ desktop: {...}, mobile: {...} }\` — \`mobile\` is best-effort and can be \`null\` if the mobile pass failed for that page (read \`desktop\` only in that case). Both \`desktop\` and \`mobile\` carry two kinds of data:

- **Frequency tables** — \`fonts\`, \`textColors\`, \`bgColors\`, \`borderColors\`, \`fontSizes\` (\`"16px/400"\` = size/weight), \`radii\`, \`shadows\`, \`spacing\`. Each is a list of \`{ value, uses }\` sorted by raw occurrence count across every visible element on the page. **Use these for the dominant palette/scale** — the top entries in \`textColors\`/\`bgColors\` are the neutrals and surfaces; the top \`fontSizes\`/\`radii\`/\`spacing\` entries are the base scale steps.
- **\`roles\`** — computed styles keyed by semantic role, so a rare-but-defining token (the one H1, the brand-accent color used on only a handful of CTAs) is never crowded out by high-volume body text/list items the way it would be in the frequency tables above. **This is the PRIMARY SOURCE for role-specific tokens** — heading scale, CTA/button colors, link color, body type:
  - \`roles.headings.h1\` … \`h6\` — array of distinct style combos actually observed at that level (\`[]\` = none present on this page). Use the largest present level for the top of the type scale; each entry carries \`fontSize\`/\`fontWeight\`/\`lineHeight\`/\`letterSpacing\`/\`color\`.
  - \`roles.links\` — distinct anchor styles observed (color and weight for text links; padding/radius/background too for button-styled links).
  - \`roles.buttons\` — distinct button-like element styles observed.
  - \`roles.primaryButton\` — best guess at the primary CTA style, or \`null\` when nothing scored as a confident brand accent. When non-null, its \`backgroundColor\`/\`color\` ARE the CTA colors — use them verbatim. **When it is \`null\`, do not invent a CTA color**: look through \`roles.buttons\` and \`roles.links\` yourself for the pill/rounded entry with a saturated, non-neutral \`backgroundColor\`, and cross-check that color against the non-neutral entries in the same page's \`bgColors\`/\`textColors\` tables — that agreement IS the brand accent.
  - \`roles.body\` — the base text color/font/size for the page.

**Tokens outside these four \`roles\` buckets — eyebrow labels, badges, captions, nav links, stat callouts, anything that isn't a heading/link/button/body — have no \`roles\` entry.** You can only triangulate them from the frequency tables above, and that triangulation is a **hypothesis, not a fact**: it's exactly where a rare-but-real token (small text, an unusual weight) gets crowded out by high-volume body copy in the counts, the same problem \`roles\` exists to solve for the four buckets it does cover. **Before writing such a value into DESIGN.md, verify it against the literal DOM**: find the actual element in the capture's \`dom.html\` (or locate its text via \`content.json\`) and read its real class names / computed style off that — do not commit a frequency-table guess unverified.

Per-page DOM captures, for this verification step:
${domList}

**Never guess a hex code, font stack, or size from a screenshot pixel — every one of those already has an exact, measured value in these files.** Screenshots are for confirming layout and composition (spacing rhythm, image treatment, overall hierarchy) only. Compare a page's \`desktop\` and \`mobile\` blocks to see which tokens actually change across the breakpoint (e.g. a smaller H1, tighter spacing).

There is also a legacy aggregate at \`${path.join(bundleDir, "styles.json")}\` (coarser: one first-match sample per tag, from content.json) — only lean on it for a picked page that has no \`<slug>-styles.json\` above.

### Captured content (for context, not styling)
See \`${path.join(bundleDir, "content-summary.json")}\` — headings/text from each page, useful for understanding tone and hierarchy.

## Deliverable

Write the DESIGN.md to:

\`runs/${site}/DESIGN.md\`

Requirements:
- **Concrete tokens**, not generic placeholders. Real hex codes, real font stacks, real spacing values — extracted from the \`<slug>-styles.json\` ground truth above (fall back to the screenshots/legacy aggregate only where ground truth is missing).
- Cover at minimum: typography scale, color palette (primary/secondary/neutral/semantic), spacing scale, radius scale, shadow/elevation, motion treatments, component patterns observed (buttons, cards, forms, nav, hero).
- Encodable as a Tailwind \`tailwind.config\` extension — the per-page transform will read this file and translate tokens into Tailwind utilities.
- Note any anti-generic moves the site uses (asymmetric layouts, distinctive type, calibrated color, micro-motion) so per-page outputs preserve them.

After writing, confirm DESIGN.md exists at the path above.
`;
}

export async function prepareDesignBundle({ site, runsDir = "runs" }) {
  const runDir = path.join(runsDir, site);
  const pages = await loadCandidatePages(runDir);

  const picked = pickRepresentative(pages, 3);

  // Load each picked page's content.json. Skip if not captured yet — a
  // type's `samples` entry can name a URL whose capture failed even after
  // exhausting its fallbacks (see capture.mjs), so a picked candidate is not
  // guaranteed to have a capture directory at all.
  const samples = [];
  for (const p of picked) {
    const slug = await import("./slug.mjs").then((m) => m.urlToSlug(p.url));
    const contentPath = path.join(runDir, "captures", slug, "content.json");
    try {
      const content = JSON.parse(await readFile(contentPath, "utf8"));
      samples.push({ slug, url: p.url, content });
    } catch {
      process.stderr.write(`  ! skipping ${slug}: no capture (run capture first)\n`);
    }
  }

  if (samples.length === 0) {
    throw new Error(`No captures found for ${site}. Run capture first.`);
  }

  const bundleDir = path.resolve(runDir, ".designmd");
  await mkdir(bundleDir, { recursive: true });

  // Symlink (well, copy) screenshots + per-page styles.json into the bundle
  // dir under predictable names. A sample's styles.json can be legitimately
  // absent even though its content.json succeeded — the style-capture pass
  // is itself best-effort and can fail independently (see capture.mjs) — so
  // record which ones actually copied (`hasStyles`) and only cite those in
  // the prompt's ground-truth list; never point the design agent at a bundle
  // path that doesn't exist.
  const fs = await import("node:fs/promises");
  for (const s of samples) {
    const srcPng = path.resolve(runDir, "captures", s.slug, "screenshot.png");
    const dstPng = path.join(bundleDir, s.slug + ".png");
    try {
      await fs.copyFile(srcPng, dstPng);
    } catch (e) {
      process.stderr.write(`  ! could not copy screenshot for ${s.slug}: ${e.message}\n`);
    }

    const srcStyles = path.resolve(runDir, "captures", s.slug, "styles.json");
    try {
      await fs.copyFile(srcStyles, path.join(bundleDir, s.slug + "-styles.json"));
      s.hasStyles = true;
    } catch {
      s.hasStyles = false;
      process.stderr.write(`  ! no styles.json for ${s.slug} (style capture likely failed) — omitted from ground-truth list\n`);
    }
  }

  const styleSummary = summarizeStyles(samples);
  await writeFile(path.join(bundleDir, "styles.json"), JSON.stringify(styleSummary, null, 2));

  // content.json is shaped as { header, main: [section…], footer }. Flatten
  // the structured tree back into the running summaries the design-md skill
  // expects (headings, paragraphs, buttons across the whole page).
  const flatten = (content) => {
    const buckets = [content.header, ...(content.main || []), content.footer].filter(Boolean);
    const headings = [];
    const paragraphs = [];
    const buttons = [];
    for (const b of buckets) {
      if (Array.isArray(b.headings)) headings.push(...b.headings);
      if (Array.isArray(b.paragraphs)) paragraphs.push(...b.paragraphs);
      if (Array.isArray(b.buttons)) buttons.push(...b.buttons);
    }
    return { headings, paragraphs, buttons: Array.from(new Set(buttons)) };
  };

  const contentSummary = samples.map((s) => {
    const flat = flatten(s.content);
    return {
      slug: s.slug,
      url: s.url,
      title: s.content.title,
      description: s.content.description,
      headings: flat.headings.slice(0, 20),
      paragraphSample: flat.paragraphs.slice(0, 5),
      buttons: flat.buttons.slice(0, 12),
    };
  });
  await writeFile(path.join(bundleDir, "content-summary.json"), JSON.stringify(contentSummary, null, 2));

  const prompt = buildPrompt({
    site,
    bundleDir,
    picked: samples.map((s) => ({ slug: s.slug, url: s.url })),
    groundTruth: samples.filter((s) => s.hasStyles).map((s) => ({ slug: s.slug, url: s.url })),
    // dom.html is captured unconditionally alongside content.json (see
    // capture.mjs's captureOne — it's written before content.json with no
    // try/catch of its own), so every sample here is guaranteed to have one
    // on disk even when its styles.json capture failed. Not copied into the
    // bundle dir (unlike screenshots/styles.json) — cited at its original
    // capture path so the DOM-verification guidance above can point at it.
    domPaths: samples.map((s) => ({ slug: s.slug, path: path.resolve(runDir, "captures", s.slug, "dom.html") })),
    styleSummary,
  });
  const promptPath = path.join(bundleDir, "PROMPT.md");
  await writeFile(promptPath, prompt);

  return {
    site,
    bundleDir,
    picked: samples.map((s) => s.slug),
    promptPath,
    designMdPath: path.join(runDir, "DESIGN.md"),
  };
}
