import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isChromePartial,
  containsTwigSyntax,
  classifyTemplateFilename,
  resolveScoringPlan,
  buildRenderContext,
  renderViaPhp,
  loadRepresentativeMenus,
  renderTemplateForScoring,
  renderPageChromeForScoring,
  WOO_STRUCTURAL_KINDS,
} from "./twigRender.mjs";
import { WOO_STRUCTURAL_KINDS as TRANSFORM_WOO_STRUCTURAL_KINDS } from "./transform.mjs";

const VENDOR_AUTOLOAD = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../../vendor/autoload.php",
);

const hasPhp = spawnSync("php", ["-v"], { stdio: "ignore" }).status === 0;
const hasVendorTwig = await access(VENDOR_AUTOLOAD).then(() => true).catch(() => false);
const canRunPhp = hasPhp && hasVendorTwig;

// ---------------------------------------------------------------------------
// isChromePartial / containsTwigSyntax / classifyTemplateFilename — pure
// ---------------------------------------------------------------------------

test("isChromePartial is true for exactly header.html and footer.html, false for everything else", () => {
  assert.equal(isChromePartial("header.html"), true);
  assert.equal(isChromePartial("footer.html"), true);
  assert.equal(isChromePartial("case-study-single.html"), false);
  assert.equal(isChromePartial("shop.html"), false);
  assert.equal(isChromePartial("index.html"), false);
});

test("containsTwigSyntax detects {{ and {% delimiters, ignores plain HTML", () => {
  assert.equal(containsTwigSyntax("<p>{{ item.post_title }}</p>"), true);
  assert.equal(containsTwigSyntax("{% for x in y %}{% endfor %}"), true);
  assert.equal(containsTwigSyntax("<p>Plain real content, no templating at all.</p>"), false);
  assert.equal(containsTwigSyntax(""), false);
  assert.equal(containsTwigSyntax(null), false);
});

test("classifyTemplateFilename recognizes -single/-archive suffixes and treats a bare name as structural", () => {
  assert.deepEqual(classifyTemplateFilename("case-study-single.html"), { typeName: "case-study", variant: "single" });
  assert.deepEqual(classifyTemplateFilename("case-study-archive.html"), { typeName: "case-study", variant: "archive" });
  assert.deepEqual(classifyTemplateFilename("shop.html"), { typeName: "shop", variant: "structural" });
  assert.deepEqual(classifyTemplateFilename("product-single.html"), { typeName: "product", variant: "single" });
});

test("WOO_STRUCTURAL_KINDS stays in sync with transform.mjs's own copy (duplicated for module-boundary reasons — see the comment above it)", () => {
  assert.deepEqual([...WOO_STRUCTURAL_KINDS].sort(), [...TRANSFORM_WOO_STRUCTURAL_KINDS].sort());
});

// ---------------------------------------------------------------------------
// resolveScoringPlan — the core decision function, pure
// ---------------------------------------------------------------------------

function pagetypes(types) {
  return { site: "example.com", types, pages: [] };
}

test("resolveScoringPlan: a -single.html file resolves to variant 'single', dataUrl/originalUrl = the type's first sample, siblings = the rest", () => {
  const pt = pagetypes([{ name: "case-study", kind: "single:case-study", samples: ["https://x.com/a", "https://x.com/b", "https://x.com/c"], archiveUrl: "https://x.com/work" }]);
  const plan = resolveScoringPlan({ pagetypes: pt, file: "case-study-single.html" });
  assert.equal(plan.ok, true);
  assert.equal(plan.variant, "single");
  assert.equal(plan.dataUrl, "https://x.com/a");
  assert.equal(plan.originalUrl, "https://x.com/a");
  assert.deepEqual(plan.siblingUrls, ["https://x.com/b", "https://x.com/c"]);
});

test("resolveScoringPlan: an -archive.html file resolves to variant 'archive', dataUrl/originalUrl = the type's archiveUrl, siblings = all samples (for the posts loop)", () => {
  const pt = pagetypes([{ name: "case-study", kind: "single:case-study", samples: ["https://x.com/a", "https://x.com/b"], archiveUrl: "https://x.com/work" }]);
  const plan = resolveScoringPlan({ pagetypes: pt, file: "case-study-archive.html" });
  assert.equal(plan.ok, true);
  assert.equal(plan.variant, "archive");
  assert.equal(plan.dataUrl, "https://x.com/work");
  assert.equal(plan.originalUrl, "https://x.com/work");
  assert.deepEqual(plan.siblingUrls, ["https://x.com/a", "https://x.com/b"]);
});

test("resolveScoringPlan: no matching pagetypes.json type entry degrades to ok:false with a clear reason, never throws", () => {
  const plan = resolveScoringPlan({ pagetypes: pagetypes([]), file: "case-study-single.html" });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /no pagetypes\.json type entry named "case-study"/);
});

test("resolveScoringPlan: a bare-name file (Woo structural convention) is explicitly out of scope, not a crash, reason names the kind", () => {
  const pt = pagetypes([{ name: "shop", kind: "woo:shop", samples: ["https://x.com/shop"], archiveUrl: null }]);
  const plan = resolveScoringPlan({ pagetypes: pt, file: "shop.html" });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /Woo structural page/);
  assert.match(plan.reason, /woo:shop/);
});

test("resolveScoringPlan: every WOO_STRUCTURAL_KINDS member is rejected even if it somehow produced a -single/-archive-suffixed file", () => {
  for (const kind of WOO_STRUCTURAL_KINDS) {
    const pt = pagetypes([{ name: "x", kind, samples: ["https://x.com/a"], archiveUrl: null }]);
    const plan = resolveScoringPlan({ pagetypes: pt, file: "x-single.html" });
    assert.equal(plan.ok, false, `${kind} must be rejected regardless of filename suffix`);
  }
});

test("resolveScoringPlan: a repeating type with zero samples degrades gracefully (single variant)", () => {
  const pt = pagetypes([{ name: "case-study", kind: "single:case-study", samples: [], archiveUrl: null }]);
  const plan = resolveScoringPlan({ pagetypes: pt, file: "case-study-single.html" });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /no sample URLs/);
});

test("resolveScoringPlan: an archive file for a type with no archiveUrl degrades gracefully", () => {
  const pt = pagetypes([{ name: "case-study", kind: "single:case-study", samples: ["https://x.com/a"], archiveUrl: null }]);
  const plan = resolveScoringPlan({ pagetypes: pt, file: "case-study-archive.html" });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /no archiveUrl/);
});

test("resolveScoringPlan: woo:product is NOT structural — a product-single.html resolves normally (single variant), kind carried through for the caller's post.wc.* branch", () => {
  const pt = pagetypes([{ name: "product", kind: "woo:product", samples: ["https://x.com/product/a"], archiveUrl: null }]);
  const plan = resolveScoringPlan({ pagetypes: pt, file: "product-single.html" });
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, "woo:product");
});

// ---------------------------------------------------------------------------
// buildRenderContext — pure shape assembly
// ---------------------------------------------------------------------------

test("buildRenderContext assembles the exact shape render-harness.php reads", () => {
  const ctx = buildRenderContext({
    vendorAutoloadPath: "/vendor/autoload.php",
    siteUrl: "https://x.com",
    mainTemplateSource: "<p>hi</p>",
    headerTemplateSource: "<header></header>",
    footerTemplateSource: null,
    post: { ID: 1 },
    posts: null,
    enrichedPost: { ID: 1, fields: {} },
    relatedPosts: [],
    menus: { wpcanai_primary: [] },
  });
  assert.deepEqual(ctx, {
    vendorAutoloadPath: "/vendor/autoload.php",
    siteUrl: "https://x.com",
    mainTemplateSource: "<p>hi</p>",
    headerTemplateSource: "<header></header>",
    footerTemplateSource: null,
    context: { post: { ID: 1 }, posts: null },
    enrichedPost: { ID: 1, fields: {} },
    relatedPosts: [],
    menus: { wpcanai_primary: [] },
  });
});

test("buildRenderContext defaults header/footer/post/posts/enrichedPost/menus sensibly when omitted", () => {
  const ctx = buildRenderContext({ vendorAutoloadPath: "/a", siteUrl: "https://x.com", mainTemplateSource: "<p>x</p>" });
  assert.equal(ctx.headerTemplateSource, null);
  assert.equal(ctx.footerTemplateSource, null);
  assert.equal(ctx.context.post, null);
  assert.equal(ctx.context.posts, null);
  assert.equal(ctx.enrichedPost, null);
  assert.deepEqual(ctx.relatedPosts, []);
  assert.deepEqual(ctx.menus, {});
});

// ---------------------------------------------------------------------------
// renderViaPhp — real php + real vendored twig/twig (integration, no mocks)
// ---------------------------------------------------------------------------

test("renderViaPhp renders a real template through the real vendored Twig, including a self-enrichment + wpcanai_template() chrome include", { skip: !canRunPhp && "php or vendor/autoload.php not available" }, async () => {
  const ctx = buildRenderContext({
    vendorAutoloadPath: VENDOR_AUTOLOAD,
    siteUrl: "https://example.com",
    mainTemplateSource:
      "{% set item = wpcanai_get_posts_enriched({'p': post.ID})|first %}" +
      "<!DOCTYPE html><html><body>{{ wpcanai_template('header') }}<h1>{{ item.post_title }}</h1>{{ wpcanai_template('footer') }}</body></html>",
    headerTemplateSource: "<header>{% for i in get_menu('wpcanai_primary') %}<a href=\"{{ i.url }}\">{{ i.title }}</a>{% endfor %}</header>",
    footerTemplateSource: "<footer>shared footer</footer>",
    post: { ID: 1 },
    enrichedPost: { ID: 1, post_title: "Real Harvested Title" },
    menus: { wpcanai_primary: [{ title: "Work", url: "https://example.com/work/", target: "", classes: "", active: false }] },
  });
  const result = await renderViaPhp({ contextObj: ctx });
  assert.equal(result.ok, true, result.error);
  assert.match(result.html, /Real Harvested Title/);
  assert.match(result.html, /<a href="https:\/\/example\.com\/work\/">Work<\/a>/);
  assert.match(result.html, /shared footer/);
});

test("renderViaPhp surfaces a real Twig syntax error rather than throwing or returning a blank success", { skip: !canRunPhp && "php or vendor/autoload.php not available" }, async () => {
  const ctx = buildRenderContext({
    vendorAutoloadPath: VENDOR_AUTOLOAD,
    siteUrl: "https://example.com",
    mainTemplateSource: "<p>{{ broken syntax here</p>",
  });
  const result = await renderViaPhp({ contextObj: ctx });
  assert.equal(result.ok, false);
  assert.match(result.error, /Twig\\Error|SyntaxError/);
});

test("renderViaPhp surfaces an unknown-Twig-function error (a template calling something this harness never registered) instead of crashing", { skip: !canRunPhp && "php or vendor/autoload.php not available" }, async () => {
  const ctx = buildRenderContext({
    vendorAutoloadPath: VENDOR_AUTOLOAD,
    siteUrl: "https://example.com",
    mainTemplateSource: "<p>{{ nonexistent_stub_function() }}</p>",
  });
  const result = await renderViaPhp({ contextObj: ctx });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown .*function/);
});

test(
  "renderViaPhp catches a chrome partial that includes itself (e.g. via a comment quoting its own wpcanai_template(...) call — a real, reproduced bug) with a clean, fast error, not a memory-exhaustion crash",
  { skip: !canRunPhp && "php or vendor/autoload.php not available" },
  async () => {
    const ctx = buildRenderContext({
      vendorAutoloadPath: VENDOR_AUTOLOAD,
      siteUrl: "https://example.com",
      mainTemplateSource: "{{ wpcanai_template('header') }}",
      headerTemplateSource: "<header>{{ wpcanai_template('header') }}</header>",
    });
    const start = Date.now();
    const result = await renderViaPhp({ contextObj: ctx });
    const elapsedMs = Date.now() - start;
    assert.equal(result.ok, false);
    assert.match(result.error, /recursed more than 10 levels deep/);
    assert.ok(elapsedMs < 10_000, `expected a fast, clean failure (recursion guard), took ${elapsedMs}ms — looks like it fell through to memory exhaustion instead`);
  },
);

test("renderViaPhp degrades gracefully (ok:false, not a throw) when the php binary itself doesn't exist", async () => {
  const ctx = buildRenderContext({ vendorAutoloadPath: VENDOR_AUTOLOAD, siteUrl: "https://x.com", mainTemplateSource: "<p>x</p>" });
  const result = await renderViaPhp({ contextObj: ctx, phpBin: "php-binary-that-does-not-exist-xyz" });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not run/);
});

// ---------------------------------------------------------------------------
// loadRepresentativeMenus / renderTemplateForScoring / renderPageChromeForScoring
// — full fixture-run integration
// ---------------------------------------------------------------------------

async function mkRun(files) {
  const root = await mkdtemp(path.join(tmpdir(), "twigrender-test-"));
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof data === "string" ? data : JSON.stringify(data));
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("loadRepresentativeMenus reads the homepage capture's real header/footer links into wpcanai_primary/wpcanai_footer", async () => {
  const { root, cleanup } = await mkRun({
    "pagetypes.json": { site: "x.com", pages: [{ url: "https://x.com/" }], types: [] },
    "captures/index/content.json": {
      header: { links: [{ href: "https://x.com/about", text: "About" }] },
      footer: { links: [{ href: "https://x.com/privacy", text: "Privacy" }] },
    },
  });
  try {
    const pagetypes = JSON.parse(await readFile(path.join(root, "pagetypes.json"), "utf8"));
    const menus = await loadRepresentativeMenus({ runDir: root, pagetypes });
    assert.deepEqual(menus.wpcanai_primary, [{ title: "About", url: "https://x.com/about", target: "", classes: "", active: false }]);
    assert.deepEqual(menus.wpcanai_footer, [{ title: "Privacy", url: "https://x.com/privacy", target: "", classes: "", active: false }]);
  } finally {
    await cleanup();
  }
});

test("loadRepresentativeMenus degrades to {} when there's no representative capture or its content.json is unreadable", async () => {
  const { root, cleanup } = await mkRun({ "pagetypes.json": { site: "x.com", pages: [], types: [] } });
  try {
    const pagetypes = JSON.parse(await readFile(path.join(root, "pagetypes.json"), "utf8"));
    assert.deepEqual(await loadRepresentativeMenus({ runDir: root, pagetypes }), {});
  } finally {
    await cleanup();
  }
});

test(
  "renderTemplateForScoring: happy path — a real case-study-single.html renders with harvested sample data + shared chrome, returns an originalPng pointing at that SAME sample's screenshot",
  { skip: !canRunPhp && "php or vendor/autoload.php not available" },
  async () => {
    const { root, cleanup } = await mkRun({
      "pagetypes.json": {
        site: "x.com",
        pages: [],
        types: [{ name: "case-study", kind: "single:case-study", samples: ["https://x.com/work/a"], archiveUrl: null }],
      },
      "CONTENT-MODEL.md": [
        "## `case-study`",
        "### 1. Post type",
        "| Attribute | Value |",
        "|---|---|",
        "| slug | `case_study` |",
        "### 2. Custom fields",
        "| Field name | Type | Required? | Source |",
        "|---|---|---|---|",
        "| `case_study_client_name` | text | yes | main[1] heading |",
      ].join("\n"),
      "captures/work__a/content.json": {
        title: "A Decoupled Site",
        main: [{ headings: [{ level: 2, text: "A Decoupled Site" }], paragraphs: ["Case study"] }],
      },
      "output/templates/case-study-single.html":
        "{% set item = wpcanai_get_posts_enriched({'p': post.ID})|first %}" +
        "<!DOCTYPE html><html><body>{{ wpcanai_template('header') }}<h1>{{ item.post_title }}</h1><p>{{ item.fields.case_study_client_name }}</p>{{ wpcanai_template('footer') }}</body></html>",
      "output/templates/header.html": "<header>real shared header</header>",
      "output/templates/footer.html": "<footer>real shared footer</footer>",
    });
    // Fake screenshot so originalPng's existence is verifiable by path only (verify.mjs handles the actual PNG decode).
    await writeFile(path.join(root, "captures/work__a/screenshot.png"), "not a real png, just a path-existence check");
    try {
      const result = await renderTemplateForScoring({
        runDir: root,
        file: "case-study-single.html",
        siteUrl: "https://x.com",
        vendorAutoloadPath: VENDOR_AUTOLOAD,
      });
      assert.equal(result.rendered, true, result.reason);
      assert.match(result.html, /A Decoupled Site/);
      assert.match(result.html, /real shared header/);
      assert.match(result.html, /real shared footer/);
      assert.equal(result.originalPng, path.join(root, "captures", "work__a", "screenshot.png"));
    } finally {
      await cleanup();
    }
  },
);

test(
  "renderTemplateForScoring: an archive's `posts` grid is built ONLY from the type's own samples, never from the archive listing page's own capture (real bug: including it produced a garbage card from the listing page's chrome/intro content, not an item)",
  { skip: !canRunPhp && "php or vendor/autoload.php not available" },
  async () => {
    const { root, cleanup } = await mkRun({
      "pagetypes.json": {
        site: "x.com",
        pages: [],
        types: [{
          name: "case-study",
          kind: "single:case-study",
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
          archiveUrl: "https://x.com/work",
        }],
      },
      "CONTENT-MODEL.md": "## `case-study`\n### 2. Custom fields\n| Field name | Type | Required? | Source |\n|---|---|---|---|\n",
      // The archive LISTING page's own capture — deliberately has a
      // distinctive heading that must NEVER show up in the rendered posts
      // grid (it describes the listing page itself, not an item).
      "captures/work/content.json": { title: "Our Work", main: [{ headings: [{ level: 1, text: "GARBAGE LISTING CHROME" }] }] },
      "captures/work__a/content.json": { title: "A", main: [{ headings: [{ level: 2, text: "Case Study A" }] }] },
      "captures/work__b/content.json": { title: "B", main: [{ headings: [{ level: 2, text: "Case Study B" }] }] },
      "output/templates/case-study-archive.html": "<!DOCTYPE html><html><body>{% for post in posts %}<p>{{ post.post_title }}</p>{% endfor %}</body></html>",
    });
    await writeFile(path.join(root, "captures/work/screenshot.png"), "fake");
    try {
      const result = await renderTemplateForScoring({ runDir: root, file: "case-study-archive.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD });
      assert.equal(result.rendered, true, result.reason);
      assert.match(result.html, /Case Study A/);
      assert.match(result.html, /Case Study B/);
      assert.doesNotMatch(result.html, /GARBAGE LISTING CHROME/, "the archive page's own capture must never appear as a fake post card");
    } finally {
      await cleanup();
    }
  },
);

test("renderTemplateForScoring degrades to rendered:false with the plan's reason when pagetypes.json has no matching type — never throws", async () => {
  const { root, cleanup } = await mkRun({ "pagetypes.json": { site: "x.com", pages: [], types: [] } });
  try {
    const result = await renderTemplateForScoring({ runDir: root, file: "case-study-single.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD });
    assert.equal(result.rendered, false);
    assert.match(result.reason, /no pagetypes\.json type entry/);
  } finally {
    await cleanup();
  }
});

test("renderTemplateForScoring degrades to rendered:false when pagetypes.json itself is missing", async () => {
  const { root, cleanup } = await mkRun({});
  try {
    const result = await renderTemplateForScoring({ runDir: root, file: "case-study-single.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD });
    assert.equal(result.rendered, false);
    assert.match(result.reason, /pagetypes\.json missing/);
  } finally {
    await cleanup();
  }
});

test("renderTemplateForScoring degrades to rendered:false when CONTENT-MODEL.md is missing (type resolves fine, but there's no field contract to harvest against)", async () => {
  const { root, cleanup } = await mkRun({
    "pagetypes.json": { site: "x.com", pages: [], types: [{ name: "case-study", kind: "single:case-study", samples: ["https://x.com/work/a"], archiveUrl: null }] },
  });
  try {
    const result = await renderTemplateForScoring({ runDir: root, file: "case-study-single.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD });
    assert.equal(result.rendered, false);
    assert.match(result.reason, /CONTENT-MODEL\.md not found/);
  } finally {
    await cleanup();
  }
});

test("renderTemplateForScoring degrades to rendered:false when the sample's capture content.json is missing", async () => {
  const { root, cleanup } = await mkRun({
    "pagetypes.json": { site: "x.com", pages: [], types: [{ name: "case-study", kind: "single:case-study", samples: ["https://x.com/work/a"], archiveUrl: null }] },
    "CONTENT-MODEL.md": "## `case-study`\n### 2. Custom fields\n| Field name | Type | Required? | Source |\n|---|---|---|---|\n",
  });
  try {
    const result = await renderTemplateForScoring({ runDir: root, file: "case-study-single.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD });
    assert.equal(result.rendered, false);
    assert.match(result.reason, /no capture content\.json/);
  } finally {
    await cleanup();
  }
});

test(
  "renderTemplateForScoring surfaces a real Twig error from a genuinely broken template, rather than crashing verify's whole run",
  { skip: !canRunPhp && "php or vendor/autoload.php not available" },
  async () => {
    const { root, cleanup } = await mkRun({
      "pagetypes.json": { site: "x.com", pages: [], types: [{ name: "case-study", kind: "single:case-study", samples: ["https://x.com/work/a"], archiveUrl: null }] },
      "CONTENT-MODEL.md": "## `case-study`\n### 2. Custom fields\n| Field name | Type | Required? | Source |\n|---|---|---|---|\n",
      "captures/work__a/content.json": { title: "A", main: [] },
      "output/templates/case-study-single.html": "<p>{{ this is not valid twig </p>",
    });
    try {
      const result = await renderTemplateForScoring({ runDir: root, file: "case-study-single.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD });
      assert.equal(result.rendered, false);
      assert.match(result.reason, /Twig render failed/);
    } finally {
      await cleanup();
    }
  },
);

test(
  "renderPageChromeForScoring resolves {{ wpcanai_template(...) }} chrome includes in an otherwise-static one-off page",
  { skip: !canRunPhp && "php or vendor/autoload.php not available" },
  async () => {
    const { root, cleanup } = await mkRun({
      "pagetypes.json": { site: "x.com", pages: [{ url: "https://x.com/" }], types: [] },
      "captures/index/content.json": { header: { links: [{ href: "https://x.com/about", text: "About" }] }, footer: { links: [] } },
      "output/templates/header.html": "<header>{% for i in get_menu('wpcanai_primary') %}<a>{{ i.title }}</a>{% endfor %}</header>",
      "output/templates/footer.html": "<footer>f</footer>",
    });
    try {
      const mainTemplateSource = "<!DOCTYPE html><html><body>{{ wpcanai_template('header') }}<main>Real static page content, authored by hand.</main>{{ wpcanai_template('footer') }}</body></html>";
      const result = await renderPageChromeForScoring({ runDir: root, mainTemplateSource, siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD });
      assert.equal(result.rendered, true, result.reason);
      assert.match(result.html, /<a>About<\/a>/);
      assert.match(result.html, /Real static page content/);
    } finally {
      await cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Harvest visibility (smittenkitchen.com dogfood, defect #2): harvesting
// used to be COMPLETELY silent — templates rendered with zero fields and
// nothing anywhere said why. renderTemplateForScoring now prints what it
// harvested per type and surfaces every parser warning. These tests stop
// before the php render (no captures on disk), so they run everywhere.
// ---------------------------------------------------------------------------

async function captureStderr(fn) {
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr: writes.join("") };
  } finally {
    process.stderr.write = original;
  }
}

test("renderTemplateForScoring prints the harvested field/taxonomy names per type and surfaces CONTENT-MODEL.md parser warnings loudly", async () => {
  const { root, cleanup } = await mkRun({
    "pagetypes.json": {
      site: "x.com",
      pages: [],
      types: [{ name: "recipe", kind: "single:recipe", samples: ["https://x.com/2025/05/a"], archiveUrl: null }],
    },
    "CONTENT-MODEL.md": [
      "## recipe",
      "### 2. Custom fields",
      "| Field name | Type | Required? | Source |",
      "|---|---|---|---|",
      "| `recipe_servings` | text | Yes (present in both samples) | main[0].lists[0] item 1 |",
      "| `recipe_time` | text | yes | main[0].lists[0] item 2 |",
      "| `recipe_broken` | Plain Text | yes | not a parseable type keyword |",
      "",
      "### 3. Taxonomies",
      "| Taxonomy | Hierarchical? | Source |",
      "|---|---|---|",
      "| `recipe_category` | Yes | category links |",
    ].join("\n"),
    // Deliberately NO captures/ — the render degrades right AFTER the parse
    // + visibility prints, so no php/vendor Twig is needed here.
  });
  try {
    const { result, stderr } = await captureStderr(() =>
      renderTemplateForScoring({ runDir: root, file: "recipe-single.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD }),
    );
    assert.equal(result.rendered, false);
    assert.match(result.reason, /no capture content\.json/);
    assert.match(
      stderr,
      /harvested 2 field\(s\) for recipe: recipe_servings, recipe_time; 1 taxonomy\(ies\): recipe_category/,
      "must say exactly what was harvested, by name",
    );
    assert.match(stderr, /CONTENT-MODEL\.md \(recipe\): skipped unparseable field-table row/, "the broken row must be surfaced loudly");
    assert.match(stderr, /recipe_broken/, "the warning must quote the offending row");
  } finally {
    await cleanup();
  }
});

test("renderTemplateForScoring loudly warns when a present field table yields ZERO fields (the always-wrong silent-drop case)", async () => {
  const { root, cleanup } = await mkRun({
    "pagetypes.json": {
      site: "x.com",
      pages: [],
      types: [{ name: "recipe", kind: "single:recipe", samples: ["https://x.com/2025/05/a"], archiveUrl: null }],
    },
    "CONTENT-MODEL.md": [
      "## recipe",
      "### 2. Custom fields",
      "| Field name | Type | Required? | Source |",
      "|---|---|---|---|",
      "| `recipe_servings` | Plain Text | Yes (present, non-empty, in both samples) | broken type keyword |",
    ].join("\n"),
  });
  try {
    const { result, stderr } = await captureStderr(() =>
      renderTemplateForScoring({ runDir: root, file: "recipe-single.html", siteUrl: "https://x.com", vendorAutoloadPath: VENDOR_AUTOLOAD }),
    );
    assert.equal(result.rendered, false);
    assert.match(stderr, /ZERO parseable field rows/, "a field table yielding nothing must be loudly wrong, never silent");
    assert.match(stderr, /harvested 0 field\(s\) for recipe/);
  } finally {
    await cleanup();
  }
});
