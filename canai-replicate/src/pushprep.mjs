// Convert canai-replicate's own transform output (output/pages/*.html,
// output/templates/*.html — full standalone HTML documents, or bare
// header/footer chrome fragments) into push-ready artifacts WPCanAI can
// actually store without doubling its own document shell around them.
//
// Why this exists (dogfood A2, Defect #1 — CRITICAL, see
// .superpowers/sdd/dogfood-a2-report.md): WPCanAI's no-layout render path
// unconditionally wraps `_canai_html` in its own
// <!DOCTYPE>/<html>/<head>/<body> shell
// (wpcanai_render_full_page_frontend(), gated on template_type=layout — see
// TemplateResolver::is_layout_template()). canai-replicate's own output is
// ALWAYS a full standalone document (by design — canai-prepare's format
// opens via file:// for local preview), so pushing a kit file verbatim into
// `_canai_html` produces doubled <!DOCTYPE>/<html>/<head>/<body>/<title> —
// reproduced live on wpdev post 547 (`/dogfood-asis-test/`, left as
// evidence). The fix applied there by hand (a throwaway `fragmentize.js`,
// preserved in that dogfood run's scratchpad) is generalized and hardened
// here into a real, tested pipeline stage: deterministic, dependency-free
// string/regex work over OUR OWN known output shape (we control every
// marker canai-replicate itself emits) — no HTML parser, no npm dependency.
//
// A file that doesn't match the expected shape fails LOUDLY, per file — this
// module never emits an artifact it isn't confident is correct; see
// convertKitFile's malformed-input branches. Never silently "best-effort"
// a shape it doesn't recognize.
//
// Scope note: only the content that ends up in `_canai_html` (body-inner for
// a full document, the whole file for an already-bare chrome fragment) is
// scanned for stray <style>/<script>. <head> — including any <style> or
// custom <script> a hand-edited file might put there — is discarded
// wholesale for a full document: canai-prepare's own contract already
// forbids <style> anywhere in generated output ("No <style> blocks in
// prepared HTML"), and the ONE inline <script> that IS allowed in <head>
// (`tailwind.config = {...}`) belongs on the destination's shared LAYOUT
// template, not per-page/per-template content — authoring that layout is a
// separate, human/agent step (see the A2 report's Defect #1 fix and
// canai-mcp SKILL.md's "Tailwind config in the layout" section), not
// something this mechanical converter can safely invent.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { matchesOnly, slugToPath } from "./slug.mjs";

async function listHtmlFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function countMatches(str, re) {
  return (str.match(re) || []).length;
}

// Strip the WPCanAI-PREVIEW-LIBS block(s) — local-preview-only libraries
// WPCanAI already injects itself via wp_head()/wp_footer() (canai-prepare
// SKILL.md's "Library injection" table). There can be more than one in a
// single fragment (this module is deliberately defensive here — real kit
// files only ever leave ONE inside body, the closing lucide bootstrap, since
// the head copy is discarded with the rest of <head>, but nothing stops a
// hand-edited file from having more).
function stripPreviewLibs(html) {
  return html.replace(
    /<!--\s*WPCanAI-PREVIEW-LIBS:START[\s\S]*?WPCanAI-PREVIEW-LIBS:END\s*-->/gi,
    "",
  );
}

// Defense-in-depth mirror of the original hand-rolled fragmentize.js's own
// step 3 — a stray lucide.createIcons() bootstrap that ends up outside the
// preview-libs markers (should not happen per the current transform
// prompts, but this whole module exists to never trust that blindly).
function stripStrayLucideBootstrap(html) {
  return html.replace(/<script>\s*lucide\.createIcons\(\);?\s*<\/script>/gi, "");
}

// canai-prepare SKILL.md Handoff #7 / canai-mcp SKILL.md step 7: every
// `<!-- Section: X -->` HTML comment becomes a `{# Section: X #}` Twig
// comment — HTML nav comments are never carried into `_canai_html` (an
// un-converted one still renders — Twig treats unrecognized text as literal
// output — but silently loses the WPCanAI editor's structure/outline menu,
// which parses `{# Section: ... #}`). Matches both a page's own
// content-section comments and the "Site header/footer — shared site
// chrome" inclusion comments (both use the literal "Section:" prefix in
// every real kit sampled: smittenkitchen.com, humanmade.com,
// barefootbuttons.com).
function sectionCommentsToTwig(html) {
  return html.replace(/<!--\s*Section:\s*([\s\S]*?)-->/gi, (_, text) => `{# Section: ${text.trim()} #}`);
}

// A page path's place in the WordPress page tree: `page_slug` is its last
// segment (the WordPress post slug), `parent_path` everything before it —
// `null` for a top-level page and for the home page (path "", page_slug "").
// The one decoder of a path's shape: page artifacts, placeholders, ancestors
// and depth all go through it.
function hierarchyOfPath(p) {
  const cut = p.lastIndexOf("/");
  return { path: p, page_slug: p.slice(cut + 1), parent_path: cut === -1 ? null : p.slice(0, cut) };
}

// A page artifact's place in the page tree, read off its file slug (see
// slug.mjs's slugToPath(), the inverse of the urlToSlug() that named the kit
// file) — so `gallery__auditorium` is `/gallery/auditorium/`: `path`
// "gallery/auditorium", `page_slug` "auditorium", `parent_path` "gallery".
// `index` is the home page: `path` and `page_slug` "", no parent.
export function pageHierarchy(slug) {
  return hierarchyOfPath(slugToPath(slug));
}

const NO_HIERARCHY = { path: null, page_slug: null, parent_path: null };

// Every ancestor of a page path, nearest first: its parent_path chain.
function ancestorsOf(p) {
  const out = [];
  for (let a = hierarchyOfPath(p).parent_path; a !== null; a = hierarchyOfPath(a).parent_path) out.push(a);
  return out;
}

// The home page "" is depth 0, a top-level page 1.
function pathDepth(p) {
  return p === "" ? 0 : ancestorsOf(p).length + 1;
}

// Parents before children: by depth, then path (plain code-unit order, so the
// file is byte-identical across machines/locales).
function byDepthThenPath(a, b) {
  return pathDepth(a) - pathDepth(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// The push manifest (pure — the caller writes it). `pages` is ONE list in
// creation order: every page artifact (`placeholder: false`, `file` relative
// to output/) plus a `placeholder: true` entry (`file: null`) for each
// ancestor path no artifact covers — a kit with only `venues__hall` needs a
// `venues` page first. Sorted by depth, then path, so every non-null
// `parent_path` is the `path` of an earlier entry by construction; `index`
// comes first. `missing_parents` summarises the placeholder paths.
//
// `failedPages` ([{ path, source }]) are page files that did not convert. A
// failed page is never turned into a placeholder: its descendants are held
// back out of `pages` and reported under `blocked_parents`
// ([{ path, source, held_back }]) until the file is fixed and pushprep re-run.
// Templates have no place in the page tree and are left out.
export function buildPushOrder(artifacts, failedPages = []) {
  const pageArtifacts = artifacts.filter((a) => a.kind === "page");
  const have = new Set(pageArtifacts.map((a) => a.path));
  const failed = new Map(failedPages.filter((f) => !have.has(f.path)).map((f) => [f.path, f.source]));

  const kept = [];
  const missing = new Set();
  const blocked = new Map(); // failed path -> held-back descendant paths
  for (const a of pageArtifacts) {
    const ancestors = ancestorsOf(a.path);
    const failedAncestors = ancestors.filter((p) => failed.has(p));
    if (failedAncestors.length > 0) {
      for (const p of failedAncestors) {
        if (!blocked.has(p)) blocked.set(p, []);
        blocked.get(p).push(a.path);
      }
      continue;
    }
    kept.push({
      file: `push/${a.slug}.json`,
      placeholder: false,
      path: a.path,
      page_slug: a.page_slug,
      parent_path: a.parent_path,
    });
    for (const p of ancestors) if (!have.has(p)) missing.add(p);
  }
  const placeholders = [...missing].map((p) => ({ file: null, placeholder: true, ...hierarchyOfPath(p) }));

  return {
    pages: [...kept, ...placeholders].sort((a, b) => byDepthThenPath(a.path, b.path)),
    missing_parents: [...missing].sort(byDepthThenPath),
    blocked_parents: [...blocked.keys()].sort(byDepthThenPath).map((p) => ({
      path: p,
      source: failed.get(p),
      held_back: blocked.get(p).sort(byDepthThenPath),
    })),
  };
}

// Pure extraction core — no I/O. Exported directly so tests can feed it real
// kit file contents without touching the filesystem.
//
// `kind` is "page" (output/pages/*.html — becomes a WordPress `page` post)
// or "template" (output/templates/*.html — becomes a `wpcanai_template`
// post, including the shared header/footer chrome and any Woo structural
// page).
//
// Returns `{ ok: true, artifact }` or `{ ok: false, errors: [...] }` —
// never a partial/best-guess artifact on failure.
export function convertKitFile(html, { filename, kind }) {
  const warnings = [];

  if (typeof html !== "string" || html.trim() === "") {
    return { ok: false, errors: [`${filename}: file is empty`] };
  }

  // Every structural-tag check below is anchored to the START OF A LINE
  // (the `m` flag makes `^` match after every `\n`, not just string start).
  // This is deliberate, not incidental: a real kit file can carry prose
  // documentation — a Twig `{# ... #}` comment or an HTML `<!-- ... -->`
  // one — that MENTIONS "<body>", "<title>", etc. as plain text mid-sentence
  // (verbatim, real example: humanmade.com's case-study-single.html opens
  // with `{# Self-enrichment happens BEFORE <head> — <title> below also
  // needs \`item\`, ... so this cannot live down in <body> ... #}`, which
  // contains THREE tag-name mentions before the real document even starts).
  // An unanchored count would treat those prose mentions as real structural
  // tags and misfire the double-wrap guard below on a perfectly well-formed
  // file. Every real structural tag in every sampled kit (smittenkitchen.com,
  // humanmade.com, barefootbuttons.com) opens its own line, so anchoring to
  // line-start (ignoring leading whitespace) reliably tells the two apart
  // without a full HTML/Twig parser. This is a pragmatic heuristic over our
  // own known output shape, not a general-purpose guarantee — a prose
  // comment line that happens to itself START with a tag mention (after
  // whitespace) would still be miscounted; none of the sampled real kits do
  // this.
  const looksLikeFullDocument = /^\s*(?:<!DOCTYPE|<html[\s>])/im.test(html);
  const slug = filename.replace(/\.html?$/i, "");
  let title = null;
  let fragment;

  if (looksLikeFullDocument) {
    // Guard against exactly Defect #1's own shape recurring INTO this tool:
    // a file that is already double-wrapped (e.g. accidentally fed back
    // through pushprep, or hand-assembled by concatenation) must never be
    // guessed at — refuse outright rather than pick one <body> arbitrarily
    // and risk silently shipping the wrong one.
    const doctypeCount = countMatches(html, /^\s*<!DOCTYPE\s/gim);
    const htmlTagCount = countMatches(html, /^\s*<html[\s>]/gim);
    if (doctypeCount > 1 || htmlTagCount > 1) {
      return {
        ok: false,
        errors: [
          `${filename}: found ${doctypeCount} <!DOCTYPE> / ${htmlTagCount} <html> tag(s) — looks already ` +
            `double-wrapped (exactly Defect #1's shape: a nested document). Refusing to guess which layer ` +
            `is real; re-run transform to regenerate a clean single-document source file.`,
        ],
      };
    }
    const bodyOpenCount = countMatches(html, /^\s*<body[\s>]/gim);
    const bodyCloseCount = countMatches(html, /^\s*<\/body>/gim);
    if (bodyOpenCount !== 1 || bodyCloseCount !== 1) {
      return {
        ok: false,
        errors: [
          `${filename}: expected exactly one <body>...</body> pair, found ${bodyOpenCount} open tag(s) / ` +
            `${bodyCloseCount} close tag(s) — cannot reliably extract body-inner content.`,
        ],
      };
    }

    const titleMatch = html.match(/^\s*<title[^>]*>([\s\S]*?)<\/title>/im);
    title = titleMatch ? titleMatch[1].trim() : null;

    // Preserve Twig logic living BEFORE <!DOCTYPE>/<html> (e.g. a leading
    // `{% set item = wpcanai_get_posts_enriched(...) %}` a typed CPT
    // template's own <title> also depends on — see recipe-single.html /
    // case-study-single.html in the real smittenkitchen.com / humanmade.com
    // kits). A naive <body>…</body> extraction silently drops this, which
    // breaks the template the moment it references `item`/`extra` in body
    // content too (not just <title>).
    // Deliberately using each match's own `.index` (never a secondary
    // `html.indexOf(trimmedTagText)` re-search) to locate boundaries: a
    // re-search for the bare tag text risks rediscovering an EARLIER,
    // non-line-anchored prose mention of the same substring (the exact
    // humanmade.com hazard documented above) instead of the real,
    // line-anchored tag this regex actually matched.
    const shellMatch = html.match(/^(\s*)(?:<!DOCTYPE|<html[\s>])/im);
    const shellIdx = shellMatch.index + shellMatch[1].length;
    const preamble = shellIdx > 0 ? html.slice(0, shellIdx).trim() : "";

    const bodyOpenMatch = html.match(/^\s*<body[^>]*>/im);
    const bodyStart = bodyOpenMatch.index + bodyOpenMatch[0].length;
    const bodyCloseMatch = html.match(/^(\s*)<\/body>/im);
    const bodyCloseIdx = bodyCloseMatch.index + bodyCloseMatch[1].length;
    const inner = html.slice(bodyStart, bodyCloseIdx);
    fragment = preamble ? `${preamble}\n${inner}` : inner;
  } else {
    // Bare fragment shape — header.html/footer.html chrome partials are
    // already exactly this per transform-chrome.md: "no <!DOCTYPE>, no
    // preview-libs markers, just the bare <header>…</header> element".
    fragment = html;
  }

  fragment = stripPreviewLibs(fragment);
  fragment = stripStrayLucideBootstrap(fragment);

  // Machine-readable header comment (transform-template.md /
  // transform-chrome.md): `<!-- wpcanai-template: template_type=X -->`.
  // Present on every typed single/archive template, every Woo structural
  // template, and both chrome partials; absent on plain one-off pages.
  const typeMatch = fragment.match(/<!--\s*wpcanai-template:\s*template_type=(\S+?)\s*-->/i);
  const templateType = typeMatch ? typeMatch[1] : null;
  if (typeMatch) {
    // The comment is documentation for the human doing the wp-admin setup
    // (canai-prepare's own words: "not something WPCanAI parses") — its
    // information now lives structurally in this artifact's own
    // `template_type` field, so drop the one leading occurrence rather than
    // ship a redundant comment into the live rendered page.
    fragment = fragment.replace(typeMatch[0], "");
  }
  if (kind === "template" && !templateType) {
    warnings.push(
      `no leading "<!-- wpcanai-template: template_type=... -->" comment found — set template_type by hand before creating the wpcanai_template post`,
    );
  }
  // Defect #7 (dogfood A2): wpcanai_template('header')/('footer') resolve by
  // the template post's exact SLUG, not title or template_type term — a
  // descriptive/prefixed title on these two posts silently auto-slugs away
  // from the bare string every {{ wpcanai_template('header'|'footer') }}
  // call hardcodes, and the include then resolves to nothing (no error).
  if (templateType === "header" || templateType === "footer") {
    warnings.push(
      `this is the shared "${templateType}" chrome partial — force the wpcanai_template post's SLUG to the exact bare string "${templateType}" (never a descriptive/prefixed title) or every {{ wpcanai_template('${templateType}') }} call site-wide silently resolves to nothing (dogfood A2 Defect #7)`,
    );
  }

  fragment = sectionCommentsToTwig(fragment);

  const cssBlocks = [];
  fragment = fragment.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, inner) => {
    const trimmed = inner.trim();
    if (trimmed) cssBlocks.push(trimmed);
    return "";
  });

  const jsBlocks = [];
  fragment = fragment.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, inner) => {
    const trimmedInner = inner.trim();
    // \b so an attribute like `nonsrc="x"` (contains "src" as a substring,
    // not as its own attribute) is never mistaken for a real `src=` — that
    // false positive would drop legitimate inline JS instead of routing it
    // to _canai_js.
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    if (hasSrc) {
      warnings.push(
        `dropped an external <script${attrs}> tag found in page content — cannot be expressed as inline _canai_js; enqueue it separately if it's genuinely needed`,
      );
      return "";
    }
    if (trimmedInner) jsBlocks.push(trimmedInner);
    return "";
  });

  fragment = fragment.replace(/\n{3,}/g, "\n\n").trim();

  // Fail only when html/css/js all come up empty together — that's the
  // real "this file had no usable content at all" signal (e.g. a file that
  // was ONLY a preview-libs block, or ONLY an external <script src> this
  // module can't express and had to drop). A file that turns out to be
  // entirely a <style>/<script> block with no surrounding markup still has
  // something real to push (into css/js) even though `html` itself is
  // empty — that's a legitimate, if unusual, artifact, not a malformed one.
  if (!fragment && !cssBlocks.length && !jsBlocks.length) {
    return {
      ok: false,
      errors: [
        `${filename}: extracted content is empty after stripping preview-libs/style/script/type-comment — nothing usable to push`,
        ...warnings,
      ],
    };
  }

  return {
    ok: true,
    artifact: {
      source: filename,
      kind,
      slug,
      ...(kind === "page" ? pageHierarchy(slug) : NO_HIERARCHY),
      title,
      template_type: templateType,
      html: fragment,
      css: cssBlocks.join("\n\n"),
      js: jsBlocks.join("\n\n"),
      warnings,
    },
  };
}

// Stage entry point: scan output/pages/ and output/templates/, convert every
// .html file, write one push-ready JSON per file to output/push/<slug>.json
// (flat — a slug can only be claimed by one bundle at a time upstream,
// transform.mjs's own resolveSlugClaims dedup already guarantees pages/ and
// templates/ never legitimately collide; this stage still guards against a
// collision loudly rather than silently overwriting, in case it's ever fed a
// hand-edited or pre-dedup run dir).
//
// It also writes output/push-order.json (see buildPushOrder) — beside push/,
// never inside it, so a push/*.json glob can't mistake it for an artifact —
// covering the page artifacts THIS run converted: a --only run writes the
// order for its own subset. A run with no page file at all (`--only header`,
// handoff-page's chrome runs, a templates-only kit) leaves the file as it was
// and returns `pushOrder: null`. Two page files that map to the same page path
// (`__.html` and `index.html`, `a____b.html` and `a__b.html`) fail loudly,
// like a slug collision.
export async function preparePushArtifacts({ site, runsDir = "runs", only = null }) {
  const runDir = path.join(runsDir, site);
  const outDir = path.resolve(runDir, "output", "push");

  const jobs = [];
  for (const [kind, sub] of [
    ["page", "pages"],
    ["template", "templates"],
  ]) {
    const dir = path.resolve(runDir, "output", sub);
    const files = await listHtmlFiles(dir);
    for (const filename of files) {
      const slug = filename.replace(/\.html?$/i, "");
      if (!matchesOnly(only, { slug })) continue;
      jobs.push({ kind, sub, dir, filename, slug });
    }
  }

  if (only && jobs.length === 0) {
    throw new Error(`no output/pages or output/templates file matches --only ${only}`);
  }

  const failures = [];
  const artifacts = [];
  const claimedSlugs = new Map(); // slug -> source file that already wrote output/push/<slug>.json
  const claimedPaths = new Map(); // page path -> source file whose artifact creates that page
  const failedPages = []; // page files that did not convert: [{ path, source }]
  // Every refusal is recorded AND printed — never silently skipped.
  const fail = (relSource, ...errors) => {
    failures.push({ file: relSource, errors });
    process.stderr.write(`  ✗ ${relSource}: ${errors.join("; ")}\n`);
  };

  await mkdir(outDir, { recursive: true });

  for (const job of jobs) {
    const relSource = path.join("output", job.sub, job.filename);
    const html = await readFile(path.join(job.dir, job.filename), "utf8");
    const result = convertKitFile(html, { filename: job.filename, kind: job.kind });
    if (!result.ok) {
      fail(relSource, ...result.errors);
      if (job.kind === "page") {
        failedPages.push({ path: slugToPath(job.slug), source: `${job.sub}/${job.filename}` });
      }
      continue;
    }

    const existingOwner = claimedSlugs.get(job.slug);
    if (existingOwner) {
      fail(
        relSource,
        `slug "${job.slug}" collides with ${existingOwner} — both would write output/push/${job.slug}.json; refusing to overwrite`,
      );
      continue;
    }
    if (job.kind === "page") {
      const pagePath = result.artifact.path;
      const pathOwner = claimedPaths.get(pagePath);
      if (pathOwner) {
        fail(
          relSource,
          `page path "/${pagePath}${pagePath ? "/" : ""}" collides with ${pathOwner} — both would create the same page; refusing to write output/push/${job.slug}.json`,
        );
        continue;
      }
      claimedPaths.set(pagePath, relSource);
    }
    claimedSlugs.set(job.slug, relSource);

    const destPath = path.join(outDir, `${job.slug}.json`);
    await writeFile(destPath, JSON.stringify(result.artifact, null, 2) + "\n");
    for (const w of result.artifact.warnings) {
      process.stderr.write(`  ! ${relSource}: ${w}\n`);
    }
    artifacts.push({ ...result.artifact, sourcePath: relSource, outputPath: destPath });
  }

  // With no page job, the order is empty (no pages, missing or blocked parents)
  // and the file on disk is left alone.
  const order = buildPushOrder(artifacts, failedPages);
  const pushOrder = jobs.some((j) => j.kind === "page") ? path.resolve(runDir, "output", "push-order.json") : null;
  if (pushOrder) await writeFile(pushOrder, JSON.stringify(order, null, 2) + "\n");

  return {
    site,
    count: jobs.length,
    ok: artifacts.length,
    artifacts,
    failures,
    outDir,
    pushOrder,
    missingParents: order.missing_parents,
    blockedParents: order.blocked_parents,
  };
}
