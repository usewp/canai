// Prepare transform bundles. Like designmd.mjs, this module does NOT call an
// LLM — it assembles the inputs (screenshot path + content.json + DESIGN.md
// + the transform prompt) so a coding agent can produce the final output.
// Type-aware: one-off pages get the existing per-page prompt (one bundle per
// page, output under output/pages/); repeating page types get a new
// per-type prompt that asks for a reusable Twig template instead of N
// static pages (one bundle per type, output under output/templates/).

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { urlToSlug, matchesOnly } from "./slug.mjs";
import { pickRepresentativeCaptureUrl } from "./siteChrome.mjs";

const PROMPT_TEMPLATE = path.resolve(
  new URL("..", import.meta.url).pathname,
  "prompts/transform.md",
);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const TEMPLATE_PROMPT_TEMPLATE = path.resolve(
  new URL("..", import.meta.url).pathname,
  "prompts/transform-template.md",
);
const ALPINE_RECIPES = path.resolve(
  new URL("..", import.meta.url).pathname,
  "prompts/alpine-recipes.md",
);
// Fix (Important, review round 2): site-wide chrome (header/footer), one
// bundle per site — see prompts/transform-chrome.md and siteChrome.mjs for
// why this exists (every page/type used to inline its own header/footer,
// and the copies disagreed).
const CHROME_PROMPT_TEMPLATE = path.resolve(
  new URL("..", import.meta.url).pathname,
  "prompts/transform-chrome.md",
);
// Canonical, plugin-verified Twig/WooCommerce variable reference — lives in
// the sibling canai-mcp skill (kept in sync with canai-localwp's mirror; see
// that file's own "parity" comment). Cited by name from transform-template.md
// rather than duplicated there, so the two can't drift out of sync.
const WC_TWIG_REFERENCE = path.resolve(
  new URL("..", import.meta.url).pathname,
  "../canai-mcp/references/REFERENCE.md",
);

// Woo `kind`s that are a single structural page WooCommerce itself owns
// (cart contents, account forms, the shop grid, one shared template for
// every product category/tag) — not a repeating content type. Mirrors
// contentmodel.md's own item-5 split 1:1: `product` and `product-loop` are
// the only two `woo:*` kinds documented as "the real content model" /
// "reuses product's fields"; every other woo:* kind is documented there as
// "No fields — WooCommerce owns this page". Also mirrors
// TemplateResolver::resolve_current_template_type()'s WC branch (see
// transform-template.md's mapping table) — every term below is a page
// WPCanAI resolves exactly once sitewide, never per-post-of-a-CPT.
export const WOO_STRUCTURAL_KINDS = new Set([
  "woo:shop",
  "woo:cart",
  "woo:checkout",
  "woo:my-account",
  "woo:order-received",
  "woo:product-category",
]);
function isWooStructural(kind) {
  return WOO_STRUCTURAL_KINDS.has(kind);
}

function buildPrompt({ site, slug, url, captureDir, designMdPath, outputPath, promptTemplate }) {
  // Inline the static prompt template, then append the per-page input pointers.
  return `${promptTemplate}

---

## This page

- **Site**: ${site}
- **URL**: ${url}
- **Slug**: ${slug}

## Inputs (read these)

- Full-page screenshot: \`${path.join(captureDir, "screenshot.png")}\`
- Per-section screenshots (use these to read each block in detail — header, hero, content sections in order, then footer): \`${path.join(captureDir, "sections")}/\`
- Section index (role + tag + dimensions per file): \`${path.join(captureDir, "sections.json")}\`
- Structured content (USE THIS COPY VERBATIM): \`${path.join(captureDir, "content.json")}\`
- Asset URLs: \`${path.join(captureDir, "assets.json")}\`
- Site-wide design system: \`${designMdPath}\`
- UX pattern inventory: \`${path.join(captureDir, "ux.json")}\` — reproduce each pattern with its recipe from \`${ALPINE_RECIPES}\`

## Output

Write the single self-contained HTML file to:

\`${outputPath}\`

After writing, confirm the file exists. Do not write anything else.
`;
}

function buildTemplatePrompt({ site, type, sampleDirs, archiveDir, designMdPath, contentModelPath, promptTemplate, singleOut, archiveOut }) {
  const sampleList = sampleDirs
    .map((d, i) => `- Sample ${i + 1}: \`${d}/\` (screenshot.png, sections/, content.json, ux.json)`)
    .join("\n");
  return `${promptTemplate}

---

## This type

- **Site**: ${site}
- **Type**: ${type.name}
- **Kind**: ${type.kind}
- **Pages of this type on the source site**: ${type.members.length}

## Inputs (read these)

- Content model (field contract): \`${contentModelPath}\`
- Site-wide design system: \`${designMdPath}\`
- Alpine recipe library: \`${ALPINE_RECIPES}\`
${sampleList}
${archiveDir ? `- Archive sample: \`${archiveDir}/\`` : ""}

## Output

Write the single template to:

\`${singleOut}\`
${archiveOut ? `\nWrite the archive template to:\n\n\`${archiveOut}\`\n` : ""}
After writing, confirm the file(s) exist. Do not write anything else.
`;
}

function buildStructuralPagePrompt({ site, type, sampleDirs, designMdPath, contentModelPath, promptTemplate, singleOut }) {
  const sampleList = sampleDirs
    .map((d, i) => `- Sample ${i + 1}: \`${d}/\` (screenshot.png, sections/, content.json, ux.json)`)
    .join("\n");
  return `${promptTemplate}

---

## This page

- **Site**: ${site}
- **Type**: ${type.name}
- **Kind**: ${type.kind}
- **This is a single WooCommerce-owned page, not a repeating content type.**
  WooCommerce renders exactly one of these per site (cart contents, account
  forms, the shop grid, one shared template for every product
  category/tag) — there is no post type, no "N items", and CONTENT-MODEL.md
  documents it as having no fields for exactly this reason. Do NOT
  self-enrich a \`post\`/\`item\`, do NOT write a \`{% for post in posts %}\`
  loop keyed on a CONTENT-MODEL.md field contract — follow this prompt's
  "Woo structural page templates" section, not "Repeating templates".

## Inputs (read these)

- Content model (confirms this type has no fields): \`${contentModelPath}\`
- Site-wide design system: \`${designMdPath}\`
- Alpine recipe library: \`${ALPINE_RECIPES}\`
- WooCommerce Twig variables reference: \`${WC_TWIG_REFERENCE}\`
${sampleList}

## Output

Write the single template to:

\`${singleOut}\`

After writing, confirm the file exists. Do not write anything else.
`;
}

function buildChromePrompt({ site, captureDir, designMdPath, headerOut, footerOut, promptTemplate }) {
  return `${promptTemplate}

---

## This site

- **Site**: ${site}

## Inputs (read these)

- Representative capture (site-wide header/footer reference): \`${captureDir}/\` (screenshot.png, sections.json, content.json, ux.json)
- Site-wide design system: \`${designMdPath}\`
- Alpine recipe library: \`${ALPINE_RECIPES}\`

## Output

Write the header partial to:

\`${headerOut}\`

Write the footer partial to:

\`${footerOut}\`

After writing, confirm both files exist. Do not write anything else.
`;
}

// Resolve which capture "owns" each output slug before any bundle is built,
// mirroring capture.mjs's buildWorklist() Fix A (dedupe by urlToSlug, typed
// entry wins) — generalized for transform's extra wrinkle that TWO different
// types can each independently reference the same slug (one as its own
// identity, one only as a derived archiveUrl pointer), which capture.mjs
// never has to arbitrate. Three-tier priority, highest wins:
//   A. a type's own samples (its detail-page identity)
//   B. a type's archiveUrl (a derived cross-reference to some other page)
//   C. a one-off `pages` entry
// Proven live on barefootbuttons.com: `product`'s archiveUrl and the
// standalone `shop` type both resolve to slug "shop" — tier A (shop's own
// sample) must win, or `product-archive.html` would ship instead of the
// correct `shop.html`, and both would exist (double-bundling the same
// capture). Proven live on humanmade.com: the case-study type's archiveUrl
// and a `pages` entry both resolve to slug "work" — tier B beats tier C,
// exactly mirroring capture.mjs's literal "typed beats untyped" rule.
function resolveSlugClaims(oneOffs, types) {
  const sampleSlugOwner = new Map(); // slug -> type.name, first-seen wins
  for (const t of types) {
    for (const url of t.samples) {
      const slug = urlToSlug(url);
      if (!sampleSlugOwner.has(slug)) sampleSlugOwner.set(slug, t.name);
    }
  }

  const archiveSlugOwner = new Map(); // slug -> type.name, first-seen wins
  const droppedArchives = [];
  for (const t of types) {
    if (!t.archiveUrl) continue;
    const slug = urlToSlug(t.archiveUrl);
    const shadowedBy = sampleSlugOwner.get(slug);
    // Fix 6: drop whenever ANY type's sample already claims this slug —
    // including this SAME type's own sample. The pre-fix `shadowedBy !==
    // t.name` guard only ever caught a DIFFERENT type's sample stealing the
    // slug (the barefootbuttons.com shape below); a type whose own
    // archiveUrl happens to slug to one of its own samples (only reachable
    // from a hand-edited pagetypes.json, but not otherwise guarded anywhere)
    // sailed straight through — `prepareTransformBundles` would then treat
    // ONE capture as both a detail-page sample AND the type's archive
    // listing, emitting both `<type>-single.html` and `<type>-archive.html`
    // from the exact same screenshot/content.json. `sampleSlugOwner` is
    // built from every type's samples up front (above), so `shadowedBy`
    // being truthy already means "some sample bundle — this type's own or
    // another's — already covers this capture"; which type it was never
    // changes that the archive must be dropped.
    if (shadowedBy) {
      droppedArchives.push({ type: t.name, url: t.archiveUrl, slug, shadowedByType: shadowedBy });
      continue;
    }
    if (!archiveSlugOwner.has(slug)) {
      archiveSlugOwner.set(slug, t.name);
    } else if (archiveSlugOwner.get(slug) !== t.name) {
      droppedArchives.push({ type: t.name, url: t.archiveUrl, slug, shadowedByType: archiveSlugOwner.get(slug) });
    }
  }

  const droppedPages = [];
  for (const url of oneOffs) {
    const slug = urlToSlug(url);
    const shadowedByType = sampleSlugOwner.get(slug) ?? archiveSlugOwner.get(slug);
    if (shadowedByType) droppedPages.push({ url, slug, shadowedByType });
  }

  return { droppedArchives, droppedPages };
}

export async function prepareTransformBundles({ site, runsDir = "runs", only = null }) {
  const runDir = path.join(runsDir, site);
  const designMdPath = path.resolve(runDir, "DESIGN.md");
  if (!(await exists(designMdPath))) {
    throw new Error(`DESIGN.md not found at ${designMdPath}. Run designmd first.`);
  }

  // Worklist: pagetypes.json when present, else v2 fallback (all pages.json
  // URLs as one-off pages). `chromeSource` keeps the {pages, types} shape
  // pickRepresentativeCaptureUrl() expects (siteChrome.mjs) available past
  // this block either way, so the chrome bundle below can run under both
  // the v3 (pagetypes.json) and v2-fallback (pages.json-only) shapes.
  let oneOffs, types, chromeSource;
  try {
    const pt = JSON.parse(await readFile(path.join(runDir, "pagetypes.json"), "utf8"));
    oneOffs = pt.pages.map((p) => p.url);
    types = pt.types.filter((t) => t.kind !== "page");
    oneOffs.push(...pt.types.filter((t) => t.kind === "page").flatMap((t) => t.members));
    chromeSource = pt;
  } catch {
    const pagesJson = JSON.parse(await readFile(path.join(runDir, "pages.json"), "utf8"));
    oneOffs = pagesJson.pages.map((p) => p.url);
    types = [];
    chromeSource = { pages: pagesJson.pages, types: [] };
  }

  const pagePrompt = await readFile(PROMPT_TEMPLATE, "utf8");
  const pagesOutDir = path.resolve(runDir, "output", "pages");
  const templatesOutDir = path.resolve(runDir, "output", "templates");
  await mkdir(pagesOutDir, { recursive: true });

  // Fix 4: resolve slug collisions across the WHOLE worklist (independent of
  // --only) before either loop below builds anything, so one capture can
  // never end up in two conflicting bundles.
  const claims = resolveSlugClaims(oneOffs, types);

  const bundles = [];

  // Site chrome (header/footer) — generated ONCE per site, shared by every
  // page/template bundle below instead of each one inlining (and drifting
  // from) its own copy of the header/footer. Deliberately kept OUT of
  // `bundles`/`count` (a separate `chrome` field on the return value
  // instead): those two have a long-standing contract (bin/replica's print
  // loop, and every existing test asserting an exact page/template count)
  // that a fixture producing N page/type bundles keeps producing exactly N
  // — folding one more, qualitatively different (site-wide, singleton, not
  // page-or-type) bundle into that array would silently inflate counts
  // everywhere a representative capture happens to resolve, which is nearly
  // every existing fixture. Same --only treatment as everything else
  // (`--only chrome` produces just this; `--only <anything else>` skips it;
  // a plain run always attempts it), it just lives in its own slot.
  let chrome = null;
  if (matchesOnly(only, { typeName: "chrome" })) {
    const repUrl = pickRepresentativeCaptureUrl(chromeSource);
    if (!repUrl) {
      process.stderr.write(`  ! skipping site chrome: no page or type to pick a representative capture from\n`);
    } else {
      const repSlug = urlToSlug(repUrl);
      const captureDir = path.resolve(runDir, "captures", repSlug);
      if (!(await exists(path.join(captureDir, "content.json")))) {
        process.stderr.write(`  ! skipping site chrome: no capture for representative page ${repUrl} (${repSlug})\n`);
      } else {
        await mkdir(templatesOutDir, { recursive: true });
        const bundleDir = path.resolve(runDir, ".transform", "chrome");
        await mkdir(bundleDir, { recursive: true });
        const chromePromptTemplate = await readFile(CHROME_PROMPT_TEMPLATE, "utf8");
        const headerOut = path.resolve(templatesOutDir, "header.html");
        const footerOut = path.resolve(templatesOutDir, "footer.html");
        const prompt = buildChromePrompt({
          site, captureDir, designMdPath, headerOut, footerOut, promptTemplate: chromePromptTemplate,
        });
        const promptPath = path.join(bundleDir, "PROMPT.md");
        await writeFile(promptPath, prompt);
        chrome = { promptPath, outputPath: headerOut, footerOutputPath: footerOut, sourceCapture: repSlug };
      }
    }
  }

  // One-off pages — same flow as v2, but under output/pages/.
  for (const url of oneOffs) {
    const slug = urlToSlug(url);
    // Fix 2: matchesOnly (src/slug.mjs) is the ONE shared --only matcher —
    // URL pathname, output slug, or page-type name — now used identically
    // by capture, transform, and verify. A one-off page has no type name,
    // so only url/slug are ever passed here.
    if (!matchesOnly(only, { url, slug })) continue;
    const dropped = claims.droppedPages.find((d) => d.url === url);
    if (dropped) {
      process.stderr.write(
        `  ! skipping ${slug} as a one-off page: it's already covered by type "${dropped.shadowedByType}"'s bundle (dedup — one capture can't produce two conflicting bundles)\n`,
      );
      continue;
    }
    const captureDir = path.resolve(runDir, "captures", slug);
    if (!(await exists(path.join(captureDir, "content.json")))) {
      process.stderr.write(`  ! skipping ${slug}: no capture\n`);
      continue;
    }
    const bundleDir = path.resolve(runDir, ".transform", slug);
    await mkdir(bundleDir, { recursive: true });
    const outputPath = path.resolve(pagesOutDir, slug + ".html");
    const prompt = buildPrompt({ site, slug, url, captureDir, designMdPath, outputPath, promptTemplate: pagePrompt });
    const promptPath = path.join(bundleDir, "PROMPT.md");
    await writeFile(promptPath, prompt);
    bundles.push({ slug, kind: "page", url, promptPath, outputPath });
  }

  // Repeating types — one bundle per type.
  if (types.length > 0) {
    const contentModelPath = path.resolve(runDir, "CONTENT-MODEL.md");
    const templatePrompt = await readFile(TEMPLATE_PROMPT_TEMPLATE, "utf8");
    for (const t of types) {
      // A type is matched by name only (never by path — it covers many
      // pages, not one URL), same as pre-fix.
      if (!matchesOnly(only, { typeName: t.name })) continue;
      if (!(await exists(contentModelPath))) {
        throw new Error(`CONTENT-MODEL.md not found at ${contentModelPath}. Run contentmodel first.`);
      }
      // A type's `samples` entry can name a URL whose capture failed (all
      // fallbacks exhausted in capture.mjs) — content.json then never landed
      // on disk. Log each miss so it's visible, same as contentmodel.mjs;
      // never fail silently.
      const sampleDirs = [];
      for (const url of t.samples) {
        const d = path.resolve(runDir, "captures", urlToSlug(url));
        if (await exists(path.join(d, "content.json"))) {
          sampleDirs.push(d);
        } else {
          process.stderr.write(`  ! ${t.name}: no capture for ${url} (capture failed or not run) — skipped\n`);
        }
      }
      if (sampleDirs.length === 0) {
        process.stderr.write(`  ! skipping type ${t.name}: no sample captures\n`);
        continue;
      }
      await mkdir(templatesOutDir, { recursive: true });
      const bundleDir = path.resolve(runDir, ".transform", "type-" + t.name);
      await mkdir(bundleDir, { recursive: true });

      // Fix 3: a Woo structural page (shop/cart/checkout/my-account/
      // order-received/product-category) is one page, not "N items of a
      // CPT" — different prompt, single output, never an archive bundle.
      if (isWooStructural(t.kind)) {
        const singleOut = path.resolve(templatesOutDir, `${t.name}.html`);
        const prompt = buildStructuralPagePrompt({
          site, type: t, sampleDirs, designMdPath, contentModelPath,
          promptTemplate: templatePrompt, singleOut,
        });
        const promptPath = path.join(bundleDir, "PROMPT.md");
        await writeFile(promptPath, prompt);
        bundles.push({
          slug: "type-" + t.name, kind: "template", structural: true,
          promptPath, outputPath: singleOut, archiveOutputPath: null,
        });
        continue;
      }

      let archiveDir = null;
      const droppedArchive = claims.droppedArchives.find((d) => d.type === t.name);
      if (t.archiveUrl && droppedArchive) {
        process.stderr.write(
          `  ! type-${t.name}: dropping its archive bundle (${t.archiveUrl}) — capture "${droppedArchive.slug}" is already covered by type "${droppedArchive.shadowedByType}"'s bundle (dedup — one capture can't produce two conflicting bundles)\n`,
        );
      } else if (t.archiveUrl) {
        const d = path.resolve(runDir, "captures", urlToSlug(t.archiveUrl));
        if (await exists(path.join(d, "content.json"))) archiveDir = d;
      }
      const singleOut = path.resolve(templatesOutDir, `${t.name}-single.html`);
      const archiveOut = archiveDir ? path.resolve(templatesOutDir, `${t.name}-archive.html`) : null;
      const prompt = buildTemplatePrompt({
        site, type: t, sampleDirs, archiveDir, designMdPath, contentModelPath,
        promptTemplate: templatePrompt, singleOut, archiveOut,
      });
      const promptPath = path.join(bundleDir, "PROMPT.md");
      await writeFile(promptPath, prompt);
      bundles.push({ slug: "type-" + t.name, kind: "template", promptPath, outputPath: singleOut, archiveOutputPath: archiveOut });
    }
  }

  // `chrome` deliberately doesn't count toward "matched something" UNLESS it
  // was the only thing --only could have meant (--only chrome): a plain run
  // (only === null) never reaches this guard at all (falsy), and any other
  // --only value that legitimately matched zero page/type bundles is still
  // a real error even if chrome happened to resolve (chrome always attempts
  // to resolve regardless of --only, as long as --only isn't scoping it out).
  if (only && bundles.length === 0 && !(only === "chrome" && chrome)) {
    throw new Error(`no pages or types match --only ${only}`);
  }
  return { site, count: bundles.length, bundles, chrome };
}
