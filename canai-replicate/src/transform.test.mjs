import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareTransformBundles } from "./transform.mjs";

// Writes `files` into <tmp>/runs/<site>/ and returns that run dir, plus a
// cleanup() that removes the whole temp root. Mirrors designmd.test.mjs /
// contentmodel.test.mjs's helper so all three stages' tests read the same way.
async function mkRun(site, files) {
  const root = await mkdtemp(path.join(tmpdir(), "transform-test-"));
  const runDir = path.join(root, "runs", site);
  await mkdir(runDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await writeFile(path.join(runDir, name), body);
  }
  return { runDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function pagetypes(types, pages = []) {
  return { site: "test-site", types, pages: pages.map((url) => ({ url })) };
}

function pagesJson(urls) {
  return { site: "test-site", pages: urls.map((url) => ({ url, source: "sitemap" })) };
}

function type(overrides) {
  return {
    name: "case-study",
    kind: "single:case-study",
    pattern: "/work/*",
    confidence: "fingerprint",
    members: [],
    samples: [],
    archiveUrl: null,
    ...overrides,
  };
}

// Stages a captures/<slug>/content.json — all this stage checks for to
// decide a capture "exists" (same shallow check contentmodel.mjs uses).
async function stageCapture(runDir, slug, content = {}) {
  const dir = path.join(runDir, "captures", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "content.json"), JSON.stringify(content, null, 2));
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

// Like withSilencedStderr, but records every write so a test can assert a
// specific warning was actually emitted (used for the "skip visibly" hazard).
function withCapturedStderr(fn) {
  return async () => {
    const original = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await fn(lines);
    } finally {
      process.stderr.write = original;
    }
  };
}

// --- Guard rail: DESIGN.md is required for ANY bundle (pages or types) -----

test("prepareTransformBundles: throws when DESIGN.md is missing, even for a plain page-only site", async () => {
  const { runDir, cleanup } = await mkRun("no-design", {
    "pages.json": pagesJson(["https://x.com/"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await assert.rejects(
      prepareTransformBundles({ site: "no-design", runsDir: path.join(runDir, "..") }),
      /DESIGN\.md not found at .*no-design.*DESIGN\.md\. Run designmd first\./,
    );
  } finally {
    await cleanup();
  }
});

// --- v2 fallback: no pagetypes.json — every pages.json URL is a one-off ----

test("prepareTransformBundles: falls back to pages.json when pagetypes.json is absent (v2 behavior, all pages, no types)", async () => {
  const { runDir, cleanup } = await mkRun("v2-site", {
    "DESIGN.md": "# DESIGN.md",
    "pages.json": pagesJson(["https://x.com/", "https://x.com/about"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "about", { title: "About" });

    const r = await prepareTransformBundles({ site: "v2-site", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, 2);
    assert.deepEqual(
      r.bundles.map((b) => b.slug).sort(),
      ["about", "index"],
    );
    for (const b of r.bundles) {
      assert.equal(b.kind, "page");
      assert.equal(b.outputPath, path.resolve(runDir, "output", "pages", b.slug + ".html"));
    }
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: falls back to pages.json when pagetypes.json is malformed", async () => {
  const { runDir, cleanup } = await mkRun("bad-json", {
    "DESIGN.md": "# DESIGN.md",
    "pagetypes.json": "{ not valid json",
    "pages.json": pagesJson(["https://x.com/"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    const r = await prepareTransformBundles({ site: "bad-json", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, 1);
    assert.equal(r.bundles[0].kind, "page");
  } finally {
    await cleanup();
  }
});

// --- Worklist split: one-off pages vs repeating types -----------------------

test("prepareTransformBundles: pagetypes.json present — pages[] become page bundles, non-page types become template bundles", async () => {
  const { runDir, cleanup } = await mkRun("split-site", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes(
      [
        type({
          name: "case-study",
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
          archiveUrl: "https://x.com/work",
        }),
      ],
      ["https://x.com/", "https://x.com/about"],
    ),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "about", { title: "About" });
    await stageCapture(runDir, "work__a", { title: "Case A" });
    await stageCapture(runDir, "work__b", { title: "Case B" });
    await stageCapture(runDir, "work", { title: "Work archive" });

    const r = await prepareTransformBundles({ site: "split-site", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, 3); // 2 pages + 1 type

    const pageBundles = r.bundles.filter((b) => b.kind === "page");
    const templateBundles = r.bundles.filter((b) => b.kind === "template");
    assert.deepEqual(pageBundles.map((b) => b.slug).sort(), ["about", "index"]);
    assert.equal(templateBundles.length, 1);

    const t = templateBundles[0];
    assert.equal(t.slug, "type-case-study");
    assert.equal(t.outputPath, path.resolve(runDir, "output", "templates", "case-study-single.html"));
    assert.equal(t.archiveOutputPath, path.resolve(runDir, "output", "templates", "case-study-archive.html"));
    assert.equal(t.url, undefined, "a template bundle has no single `url` — it covers many pages");
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: a `kind: page` type unrolls ALL its members as one-off pages, not just its samples", async () => {
  const { runDir, cleanup } = await mkRun("page-kind-type", {
    "DESIGN.md": "# DESIGN.md",
    "pagetypes.json": pagetypes([
      type({
        name: "misc",
        kind: "page",
        members: ["https://x.com/a", "https://x.com/b", "https://x.com/c"],
        samples: ["https://x.com/a"], // classify only sampled one; all 3 must still become pages
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "a", { title: "A" });
    await stageCapture(runDir, "b", { title: "B" });
    await stageCapture(runDir, "c", { title: "C" });

    const r = await prepareTransformBundles({ site: "page-kind-type", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, 3);
    assert.ok(r.bundles.every((b) => b.kind === "page"));
    assert.deepEqual(r.bundles.map((b) => b.slug).sort(), ["a", "b", "c"]);
  } finally {
    await cleanup();
  }
});

// --- Missing-capture hazards -------------------------------------------------

test(
  "prepareTransformBundles: a one-off page with no capture is skipped visibly, other pages still bundle",
  withCapturedStderr(async (lines) => {
    const { runDir, cleanup } = await mkRun("missing-page-capture", {
      "DESIGN.md": "# DESIGN.md",
      "pages.json": pagesJson(["https://x.com/", "https://x.com/uncaptured"]),
    });
    try {
      await stageCapture(runDir, "index", { title: "Home" });
      // "uncaptured" has no captures/ dir at all.

      const r = await prepareTransformBundles({ site: "missing-page-capture", runsDir: path.join(runDir, "..") });
      assert.equal(r.count, 1);
      assert.equal(r.bundles[0].slug, "index");
      assert.ok(
        lines.some((l) => l.includes("skipping uncaptured: no capture")),
        "the skip must be visible on stderr, not silent",
      );
    } finally {
      await cleanup();
    }
  }),
);

test(
  "prepareTransformBundles: a type sample whose capture failed is skipped visibly; the type still bundles from the remaining samples",
  withCapturedStderr(async (lines) => {
    const { runDir, cleanup } = await mkRun("partial-type-miss", {
      "DESIGN.md": "# DESIGN.md",
      "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
      "pagetypes.json": pagetypes([
        type({
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
        }),
      ]),
    });
    try {
      // Only "a" was captured; "b"'s capture failed (fallbacks exhausted).
      await stageCapture(runDir, "work__a", { title: "A" });

      const r = await prepareTransformBundles({ site: "partial-type-miss", runsDir: path.join(runDir, "..") });
      assert.equal(r.count, 1);
      assert.equal(r.bundles[0].kind, "template");

      const prompt = await readFile(r.bundles[0].promptPath, "utf8");
      assert.match(prompt, /work__a/);
      assert.ok(!prompt.includes("work__b"), "the missing sample must not be cited as an input to the writing agent");

      assert.ok(
        lines.some((l) => l.includes("case-study: no capture for https://x.com/work/b")),
        "the per-sample miss must be visible on stderr, not silently dropped",
      );
    } finally {
      await cleanup();
    }
  }),
);

test(
  "prepareTransformBundles: a type with NO usable sample captures is skipped entirely (no bundle pointing at nothing)",
  withCapturedStderr(async (lines) => {
    const { runDir, cleanup } = await mkRun("all-samples-missing", {
      "DESIGN.md": "# DESIGN.md",
      "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
      "pagetypes.json": pagetypes(
        [
          type({
            members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
            samples: ["https://x.com/work/a", "https://x.com/work/b"],
          }),
        ],
        ["https://x.com/"],
      ),
    });
    try {
      await stageCapture(runDir, "index", { title: "Home" });
      // No captures for either case-study sample.

      const r = await prepareTransformBundles({ site: "all-samples-missing", runsDir: path.join(runDir, "..") });
      assert.equal(r.count, 1);
      assert.equal(r.bundles[0].kind, "page");
      assert.ok(
        lines.some((l) => l.includes("skipping type case-study: no sample captures")),
        "the whole-type skip must be visible on stderr",
      );
    } finally {
      await cleanup();
    }
  }),
);

// --- CONTENT-MODEL.md requirement (type bundles only) ------------------------

test("prepareTransformBundles: throws 'Run contentmodel first' when a non-page type exists but CONTENT-MODEL.md is absent", async () => {
  const { runDir, cleanup } = await mkRun("no-content-model", {
    "DESIGN.md": "# DESIGN.md",
    "pagetypes.json": pagetypes([
      type({
        members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
        samples: ["https://x.com/work/a"],
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "work__a", { title: "A" });
    await assert.rejects(
      prepareTransformBundles({ site: "no-content-model", runsDir: path.join(runDir, "..") }),
      /CONTENT-MODEL\.md not found at .*no-content-model.*CONTENT-MODEL\.md\. Run contentmodel first\./,
    );
  } finally {
    await cleanup();
  }
});

test(
  "prepareTransformBundles: CONTENT-MODEL.md absent does NOT block a --only run scoped to a one-off page (the type is never reached)",
  withSilencedStderr(async () => {
    const { runDir, cleanup } = await mkRun("scoped-away-from-type", {
      "DESIGN.md": "# DESIGN.md",
      "pagetypes.json": pagetypes(
        [
          type({
            members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
            samples: ["https://x.com/work/a"],
          }),
        ],
        ["https://x.com/about"],
      ),
    });
    try {
      await stageCapture(runDir, "about", { title: "About" });
      await stageCapture(runDir, "work__a", { title: "A" });
      // No CONTENT-MODEL.md anywhere — but --only /about never looks at the type.
      const r = await prepareTransformBundles({
        site: "scoped-away-from-type",
        runsDir: path.join(runDir, ".."),
        only: "/about",
      });
      assert.equal(r.count, 1);
      assert.equal(r.bundles[0].slug, "about");
    } finally {
      await cleanup();
    }
  }),
);

// --- --only: page pathname, page slug, and (new) type name -------------------

test("prepareTransformBundles: --only accepts a URL pathname for a page", async () => {
  const { runDir, cleanup } = await mkRun("only-pathname", {
    "DESIGN.md": "# DESIGN.md",
    "pages.json": pagesJson(["https://x.com/", "https://x.com/about"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "about", { title: "About" });
    const r = await prepareTransformBundles({ site: "only-pathname", runsDir: path.join(runDir, ".."), only: "/" });
    assert.equal(r.count, 1);
    assert.equal(r.bundles[0].slug, "index");
    assert.equal(r.bundles[0].outputPath, path.resolve(runDir, "output", "pages", "index.html"));
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: --only accepts a bare slug for a page", async () => {
  const { runDir, cleanup } = await mkRun("only-slug", {
    "DESIGN.md": "# DESIGN.md",
    "pages.json": pagesJson(["https://x.com/", "https://x.com/about"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "about", { title: "About" });
    const r = await prepareTransformBundles({ site: "only-slug", runsDir: path.join(runDir, ".."), only: "about" });
    assert.equal(r.count, 1);
    assert.equal(r.bundles[0].slug, "about");
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: --only accepts a type name and restricts to just that type's template bundle", async () => {
  const { runDir, cleanup } = await mkRun("only-type", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes(
      [
        type({
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a"],
        }),
      ],
      ["https://x.com/about"],
    ),
  });
  try {
    await stageCapture(runDir, "about", { title: "About" });
    await stageCapture(runDir, "work__a", { title: "A" });
    const r = await prepareTransformBundles({
      site: "only-type",
      runsDir: path.join(runDir, ".."),
      only: "case-study",
    });
    assert.equal(r.count, 1);
    assert.equal(r.bundles[0].kind, "template");
    assert.equal(r.bundles[0].slug, "type-case-study");
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: --only matching nothing throws", async () => {
  const { runDir, cleanup } = await mkRun("only-nothing", {
    "DESIGN.md": "# DESIGN.md",
    "pages.json": pagesJson(["https://x.com/"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await assert.rejects(
      prepareTransformBundles({ site: "only-nothing", runsDir: path.join(runDir, ".."), only: "/nope" }),
      /no pages or types match --only \/nope/,
    );
  } finally {
    await cleanup();
  }
});

// --- Prompt content: page bundle ---------------------------------------------

test("prepareTransformBundles: page prompt cites ux.json + the Alpine recipe library path, plus all the pre-existing inputs", async () => {
  const { runDir, cleanup } = await mkRun("page-prompt-content", {
    "DESIGN.md": "# DESIGN.md",
    "pages.json": pagesJson(["https://x.com/"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    const r = await prepareTransformBundles({ site: "page-prompt-content", runsDir: path.join(runDir, "..") });
    const prompt = await readFile(r.bundles[0].promptPath, "utf8");

    assert.match(prompt, /# Task: page → semantic single-HTML file \(canai-prepare format\)/);
    const captureDir = path.resolve(runDir, "captures", "index");
    assert.ok(prompt.includes(path.join(captureDir, "screenshot.png")));
    assert.ok(prompt.includes(path.join(captureDir, "content.json")));
    assert.ok(prompt.includes(path.join(captureDir, "assets.json")));
    assert.ok(prompt.includes(path.join(captureDir, "ux.json")), "ux.json must be listed as an input");
    assert.match(prompt, /alpine-recipes\.md/);
    assert.ok(prompt.includes(path.resolve(runDir, "DESIGN.md")));
    assert.ok(prompt.includes(r.bundles[0].outputPath));
  } finally {
    await cleanup();
  }
});

// --- Prompt content: template bundle -----------------------------------------

test("prepareTransformBundles: template prompt cites CONTENT-MODEL.md, DESIGN.md, Alpine recipes, every sample dir, and the archive sample when present", async () => {
  const { runDir, cleanup } = await mkRun("template-prompt-content", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes([
      type({
        members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
        samples: ["https://x.com/work/a", "https://x.com/work/b"],
        archiveUrl: "https://x.com/work",
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "work__a", { title: "A" });
    await stageCapture(runDir, "work__b", { title: "B" });
    await stageCapture(runDir, "work", { title: "Archive" });

    const r = await prepareTransformBundles({ site: "template-prompt-content", runsDir: path.join(runDir, "..") });
    const prompt = await readFile(r.bundles[0].promptPath, "utf8");

    assert.match(prompt, /# Task: page type → reusable Twig template\(s\) \(canai-prepare format\)/);
    assert.ok(prompt.includes(path.resolve(runDir, "CONTENT-MODEL.md")));
    assert.ok(prompt.includes(path.resolve(runDir, "DESIGN.md")));
    assert.match(prompt, /alpine-recipes\.md/);
    assert.ok(prompt.includes(path.resolve(runDir, "captures", "work__a")));
    assert.ok(prompt.includes(path.resolve(runDir, "captures", "work__b")));
    assert.ok(prompt.includes(path.resolve(runDir, "captures", "work")), "archive sample dir must be cited");
    assert.match(prompt, /\*\*Type\*\*: case-study/);
    assert.match(prompt, /\*\*Kind\*\*: single:case-study/);
    assert.match(prompt, /Pages of this type on the source site\*\*: 4/);
    assert.ok(prompt.includes("Write the archive template to"));
    assert.ok(prompt.includes(path.resolve(runDir, "output", "templates", "case-study-archive.html")));
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: template prompt omits the archive section when there is no archive capture", async () => {
  const { runDir, cleanup } = await mkRun("no-archive-capture", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes([
      type({
        members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
        samples: ["https://x.com/work/a"],
        archiveUrl: "https://x.com/work", // recorded by classify, but never captured
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "work__a", { title: "A" });
    // Deliberately no captures/work/ dir — archive capture never ran/failed.

    const r = await prepareTransformBundles({ site: "no-archive-capture", runsDir: path.join(runDir, "..") });
    assert.equal(r.bundles[0].archiveOutputPath, null);
    const prompt = await readFile(r.bundles[0].promptPath, "utf8");
    assert.ok(!prompt.includes("Write the archive template to"));
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: archiveUrl: null (no archive on the source site) never produces an archive bundle", async () => {
  const { runDir, cleanup } = await mkRun("no-archive-url", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes([
      type({
        members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
        samples: ["https://x.com/work/a"],
        archiveUrl: null,
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "work__a", { title: "A" });
    const r = await prepareTransformBundles({ site: "no-archive-url", runsDir: path.join(runDir, "..") });
    assert.equal(r.bundles[0].archiveOutputPath, null);
  } finally {
    await cleanup();
  }
});

// --- Return shape sanity (bin/replica only reads slug/promptPath/outputPath) -

test("prepareTransformBundles: every bundle always has slug, kind, promptPath, outputPath (bin/replica's print loop depends on this)", async () => {
  const { runDir, cleanup } = await mkRun("shape-check", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes(
      [
        type({
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a"],
        }),
      ],
      ["https://x.com/"],
    ),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "work__a", { title: "A" });
    const r = await prepareTransformBundles({ site: "shape-check", runsDir: path.join(runDir, "..") });
    assert.equal(r.site, "shape-check");
    assert.equal(r.count, r.bundles.length);
    for (const b of r.bundles) {
      assert.equal(typeof b.slug, "string");
      assert.ok(b.kind === "page" || b.kind === "template");
      assert.equal(typeof b.promptPath, "string");
      assert.equal(typeof b.outputPath, "string");
    }
  } finally {
    await cleanup();
  }
});

// --- Fix 3: Woo structural pages are ONE page, not "N items of a CPT" ------

test("prepareTransformBundles: a woo:shop type gets a structural bundle — one output (no -single suffix), no archive, structural framing in the prompt", async () => {
  const { runDir, cleanup } = await mkRun("woo-shop-structural", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes([
      type({
        name: "shop",
        kind: "woo:shop",
        pattern: null,
        confidence: "url-only",
        members: ["https://x.com/shop/"],
        samples: ["https://x.com/shop/"],
        archiveUrl: null,
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "shop", { title: "Shop" });
    const r = await prepareTransformBundles({ site: "woo-shop-structural", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, 1);
    const b = r.bundles[0];
    assert.equal(b.kind, "template");
    assert.equal(b.structural, true);
    assert.equal(b.archiveOutputPath, null);
    assert.equal(
      b.outputPath,
      path.resolve(runDir, "output", "templates", "shop.html"),
      "structural output must not carry a -single suffix — there is no paired archive bundle",
    );

    const prompt = await readFile(b.promptPath, "utf8");
    assert.match(prompt, /This is a single WooCommerce-owned page, not a repeating content type/);
    assert.match(prompt, /Do NOT\s+self-enrich/);
    assert.ok(!prompt.includes("Pages of this type on the source site"), "must not frame a single WC page as 'N pages of this type'");
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: woo:cart / woo:checkout / woo:my-account / woo:order-received / woo:product-category all route through the structural bundle, never the repeating-CPT one", async () => {
  const names = ["cart", "checkout", "my-account", "order-received", "product-category"];
  const kinds = names.map((n) => `woo:${n}`);
  const { runDir, cleanup } = await mkRun("woo-structural-sweep", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes(
      names.map((n) =>
        type({
          name: n,
          kind: `woo:${n}`,
          pattern: null,
          confidence: "url-only",
          members: [`https://x.com/${n}/`],
          samples: [`https://x.com/${n}/`],
          archiveUrl: null,
        }),
      ),
    ),
  });
  try {
    for (const n of names) await stageCapture(runDir, n, { title: n });
    const r = await prepareTransformBundles({ site: "woo-structural-sweep", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, kinds.length);
    for (const b of r.bundles) {
      assert.equal(b.structural, true, `${b.slug} must be structural`);
      assert.equal(b.archiveOutputPath, null);
      assert.ok(!b.outputPath.endsWith("-single.html"), `${b.slug} must not use the repeating-CPT -single.html naming`);
    }
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: woo:product is a repeating type, not structural — keeps -single.html naming and can still get an archive", async () => {
  const { runDir, cleanup } = await mkRun("woo-product-repeating", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes([
      type({
        name: "product",
        kind: "woo:product",
        pattern: "/product/*",
        members: ["https://x.com/product/a/", "https://x.com/product/b/", "https://x.com/product/c/", "https://x.com/product/d/"],
        samples: ["https://x.com/product/a/", "https://x.com/product/b/"],
        archiveUrl: null,
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "product__a", { title: "A" });
    await stageCapture(runDir, "product__b", { title: "B" });
    const r = await prepareTransformBundles({ site: "woo-product-repeating", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, 1);
    const b = r.bundles[0];
    assert.ok(!b.structural, "woo:product is a repeating type, not structural");
    assert.equal(b.outputPath, path.resolve(runDir, "output", "templates", "product-single.html"));
  } finally {
    await cleanup();
  }
});

// --- Fix 4: dedupe by output slug — one capture cannot produce two bundles -

test(
  "prepareTransformBundles: a type's archiveUrl colliding with another type's own capture drops the archive, keeps the owning type's bundle (barefootbuttons.com shape: product.archiveUrl === shop's own member)",
  withCapturedStderr(async (lines) => {
    const { runDir, cleanup } = await mkRun("woo-double-bundle", {
      "DESIGN.md": "# DESIGN.md",
      "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
      "pagetypes.json": pagetypes([
        type({
          name: "product",
          kind: "woo:product",
          pattern: "/product/*",
          members: ["https://x.com/product/a/", "https://x.com/product/b/", "https://x.com/product/c/", "https://x.com/product/d/"],
          samples: ["https://x.com/product/a/", "https://x.com/product/b/"],
          archiveUrl: "https://x.com/shop",
        }),
        type({
          name: "shop",
          kind: "woo:shop",
          pattern: null,
          members: ["https://x.com/shop/"],
          samples: ["https://x.com/shop/"],
          archiveUrl: null,
        }),
      ]),
    });
    try {
      await stageCapture(runDir, "product__a", { title: "A" });
      await stageCapture(runDir, "product__b", { title: "B" });
      await stageCapture(runDir, "shop", { title: "Shop" });

      const r = await prepareTransformBundles({ site: "woo-double-bundle", runsDir: path.join(runDir, "..") });

      const shopBundle = r.bundles.find((b) => b.slug === "type-shop");
      const productBundle = r.bundles.find((b) => b.slug === "type-product");
      assert.ok(shopBundle, "the shop type's own bundle must survive");
      assert.ok(productBundle, "the product type's single bundle must still exist");
      assert.equal(productBundle.archiveOutputPath, null, "product's archive must be dropped — the shop type already owns that capture");
      assert.ok(
        !r.bundles.some((b) => (b.outputPath + (b.archiveOutputPath || "")).includes("product-archive.html")),
        "no bundle may point at product-archive.html — that capture belongs to the shop type",
      );
      assert.ok(
        lines.some((l) => l.includes("type-product") && l.includes("shop") && l.toLowerCase().includes("dedup")),
        "the dropped archive must be visible on stderr, not silent",
      );
    } finally {
      await cleanup();
    }
  }),
);

test(
  "prepareTransformBundles: a type's archiveUrl colliding with a one-off page drops the page bundle, keeps the archive (humanmade.com shape: case-study archiveUrl === /work/ one-off page)",
  withCapturedStderr(async (lines) => {
    const { runDir, cleanup } = await mkRun("archive-vs-page", {
      "DESIGN.md": "# DESIGN.md",
      "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
      "pagetypes.json": pagetypes(
        [
          type({
            members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
            samples: ["https://x.com/work/a", "https://x.com/work/b"],
            archiveUrl: "https://x.com/work",
          }),
        ],
        ["https://x.com/work/"],
      ),
    });
    try {
      await stageCapture(runDir, "work__a", { title: "A" });
      await stageCapture(runDir, "work__b", { title: "B" });
      await stageCapture(runDir, "work", { title: "Work archive" });

      const r = await prepareTransformBundles({ site: "archive-vs-page", runsDir: path.join(runDir, "..") });

      assert.ok(!r.bundles.some((b) => b.kind === "page" && b.slug === "work"), "the one-off /work/ page bundle must be dropped");
      const t = r.bundles.find((b) => b.kind === "template");
      assert.ok(t.archiveOutputPath, "the type's archive bundle must survive");
      assert.ok(
        lines.some((l) => l.includes("work") && l.toLowerCase().includes("dedup")),
        "the dropped page must be visible on stderr",
      );
    } finally {
      await cleanup();
    }
  }),
);

// --- Fix 6: a type's own archiveUrl colliding with its OWN sample ----------

test(
  "prepareTransformBundles: a type's archiveUrl slugging to its OWN sample drops the archive bundle (one capture can't be both the sample AND the archive)",
  withCapturedStderr(async (lines) => {
    // Only reachable from a hand-edited pagetypes.json (classify.mjs never
    // derives an archiveUrl equal to one of its own samples), but nothing
    // guarded against it either — pre-fix, resolveSlugClaims' shadowedBy
    // check required `shadowedBy !== t.name`, so a type's OWN sample never
    // counted as shadowing its OWN archive. Both "type-solo-single.html" and
    // "type-solo-archive.html" would be emitted from the exact same capture.
    const { runDir, cleanup } = await mkRun("self-collision", {
      "DESIGN.md": "# DESIGN.md",
      "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
      "pagetypes.json": pagetypes([
        type({
          name: "solo",
          kind: "single:solo",
          pattern: null,
          members: ["https://x.com/solo-page"],
          samples: ["https://x.com/solo-page"],
          archiveUrl: "https://x.com/solo-page", // same URL as its own sample
        }),
      ]),
    });
    try {
      await stageCapture(runDir, "solo-page", { title: "Solo" });

      const r = await prepareTransformBundles({ site: "self-collision", runsDir: path.join(runDir, "..") });
      assert.equal(r.count, 1, "only the single bundle — no separate archive bundle");
      const b = r.bundles[0];
      assert.equal(b.kind, "template");
      assert.equal(b.archiveOutputPath, null, "the self-colliding archive must be dropped");
      assert.ok(
        !r.bundles.some((x) => (x.outputPath + (x.archiveOutputPath || "")).includes("solo-archive.html")),
        "no bundle may point at solo-archive.html — it would duplicate the single bundle's own capture",
      );
      assert.ok(
        lines.some((l) => l.includes("type-solo") && l.toLowerCase().includes("dedup")),
        "the dropped self-colliding archive must be visible on stderr, not silent",
      );
    } finally {
      await cleanup();
    }
  }),
);

test("prepareTransformBundles: no false-positive dedup — distinct slugs across a type's archive and unrelated one-off pages all still bundle", async () => {
  const { runDir, cleanup } = await mkRun("no-false-dedup", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes(
      [
        type({
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
          archiveUrl: "https://x.com/work-listing",
        }),
      ],
      ["https://x.com/about", "https://x.com/contact"],
    ),
  });
  try {
    await stageCapture(runDir, "work__a", { title: "A" });
    await stageCapture(runDir, "work__b", { title: "B" });
    await stageCapture(runDir, "work-listing", { title: "Listing" });
    await stageCapture(runDir, "about", { title: "About" });
    await stageCapture(runDir, "contact", { title: "Contact" });

    const r = await prepareTransformBundles({ site: "no-false-dedup", runsDir: path.join(runDir, "..") });
    assert.equal(r.count, 3); // about + contact (pages) + 1 type bundle
    const t = r.bundles.find((b) => b.kind === "template");
    assert.ok(t.archiveOutputPath, "unrelated slugs must not be dropped by the dedup pass");
    assert.deepEqual(
      r.bundles.filter((b) => b.kind === "page").map((b) => b.slug).sort(),
      ["about", "contact"],
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Site chrome (header/footer) — Fix (Important, review round 2): every
// page/template used to inline its own <header>/<footer>, and the copies
// disagreed. `chrome` is a separate field on the return value (NOT folded
// into `bundles`/`count`) precisely so it doesn't silently inflate the counts
// every test above already asserts — see the comment above its computation
// in transform.mjs.
// ---------------------------------------------------------------------------

test("prepareTransformBundles: a plain run produces a `chrome` bundle from the homepage capture, alongside the normal page/type bundles", async () => {
  const { runDir, cleanup } = await mkRun("chrome-basic", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes(
      [type({ members: ["https://x.com/work/a"], samples: ["https://x.com/work/a"] })],
      ["https://x.com/", "https://x.com/about"],
    ),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home", header: { links: [] }, footer: { links: [] } });
    await stageCapture(runDir, "about", { title: "About" });
    await stageCapture(runDir, "work__a", { title: "A" });

    const r = await prepareTransformBundles({ site: "chrome-basic", runsDir: path.join(runDir, "..") });

    // Existing contract untouched: count/bundles only ever describe page/type bundles.
    assert.equal(r.count, 3); // index + about (pages) + 1 type bundle
    assert.equal(r.bundles.length, 3);

    assert.ok(r.chrome, "expected a chrome bundle when a representative capture exists");
    assert.equal(typeof r.chrome.promptPath, "string");
    assert.equal(r.chrome.sourceCapture, "index", "homepage capture must be preferred as the chrome source");
    assert.equal(r.chrome.outputPath, path.resolve(runDir, "output", "templates", "header.html"));
    assert.equal(r.chrome.footerOutputPath, path.resolve(runDir, "output", "templates", "footer.html"));

    const prompt = await readFile(r.chrome.promptPath, "utf8");
    assert.match(prompt, /chrome-basic/); // site name
    assert.match(prompt, /captures[\\/]index/); // representative capture dir
    assert.match(prompt, /DESIGN\.md/);
    assert.match(prompt, /alpine-recipes\.md/);
    assert.match(prompt, /header\.html/);
    assert.match(prompt, /footer\.html/);
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: chrome prefers the homepage even when other pages/types are listed first", async () => {
  const { runDir, cleanup } = await mkRun("chrome-prefers-home", {
    "DESIGN.md": "# DESIGN.md",
    "pagetypes.json": pagetypes([], ["https://x.com/about", "https://x.com/", "https://x.com/contact"]),
  });
  try {
    await stageCapture(runDir, "about", { title: "About" });
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "contact", { title: "Contact" });
    const r = await prepareTransformBundles({ site: "chrome-prefers-home", runsDir: path.join(runDir, "..") });
    assert.equal(r.chrome.sourceCapture, "index");
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: --only chrome produces ONLY the chrome bundle (zero page/type bundles)", async () => {
  const { runDir, cleanup } = await mkRun("chrome-only", {
    "DESIGN.md": "# DESIGN.md",
    "CONTENT-MODEL.md": "# CONTENT-MODEL.md",
    "pagetypes.json": pagetypes(
      [type({ members: ["https://x.com/work/a"], samples: ["https://x.com/work/a"] })],
      ["https://x.com/", "https://x.com/about"],
    ),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "about", { title: "About" });
    await stageCapture(runDir, "work__a", { title: "A" });
    const r = await prepareTransformBundles({ site: "chrome-only", runsDir: path.join(runDir, ".."), only: "chrome" });
    assert.equal(r.count, 0);
    assert.deepEqual(r.bundles, []);
    assert.ok(r.chrome);
    assert.equal(r.chrome.sourceCapture, "index");
  } finally {
    await cleanup();
  }
});

test("prepareTransformBundles: --only <something else> skips the chrome bundle (chrome: null), unaffected by whatever else --only matched", async () => {
  const { runDir, cleanup } = await mkRun("chrome-scoped-away", {
    "DESIGN.md": "# DESIGN.md",
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about"]),
  });
  try {
    await stageCapture(runDir, "index", { title: "Home" });
    await stageCapture(runDir, "about", { title: "About" });
    const r = await prepareTransformBundles({ site: "chrome-scoped-away", runsDir: path.join(runDir, ".."), only: "about" });
    assert.equal(r.count, 1);
    assert.equal(r.chrome, null, "an unrelated --only must not also produce a chrome bundle");
  } finally {
    await cleanup();
  }
});

test(
  "prepareTransformBundles: no representative capture at all (empty pages + types) degrades chrome to null with a visible warning, never throws",
  withCapturedStderr(async (lines) => {
    const { runDir, cleanup } = await mkRun("chrome-nothing-to-pick", {
      "DESIGN.md": "# DESIGN.md",
      "pagetypes.json": pagetypes([], []),
    });
    try {
      const r = await prepareTransformBundles({ site: "chrome-nothing-to-pick", runsDir: path.join(runDir, "..") });
      assert.equal(r.chrome, null);
      assert.ok(lines.some((l) => /skipping site chrome/.test(l) && /no page or type/.test(l)));
    } finally {
      await cleanup();
    }
  }),
);

test(
  "prepareTransformBundles: representative page resolved but its capture failed (no content.json) degrades chrome to null with a visible warning, never throws, and other bundles still proceed",
  withCapturedStderr(async (lines) => {
    const { runDir, cleanup } = await mkRun("chrome-capture-missing", {
      "DESIGN.md": "# DESIGN.md",
      "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about"]),
    });
    try {
      // "index" (the homepage) never got captured; "about" did.
      await stageCapture(runDir, "about", { title: "About" });
      const r = await prepareTransformBundles({ site: "chrome-capture-missing", runsDir: path.join(runDir, "..") });
      assert.equal(r.chrome, null);
      assert.equal(r.count, 1, "the 'about' page bundle must still be produced even though chrome failed");
      assert.ok(lines.some((l) => /skipping site chrome/.test(l) && /no capture for representative page/.test(l)));
    } finally {
      await cleanup();
    }
  }),
);

test("prepareTransformBundles: --only chrome with no representative capture available throws (same 'nothing matched' contract as any other --only)", async () => {
  const { runDir, cleanup } = await mkRun("chrome-only-nothing", {
    "DESIGN.md": "# DESIGN.md",
    "pagetypes.json": pagetypes([], []),
  });
  try {
    await assert.rejects(
      prepareTransformBundles({ site: "chrome-only-nothing", runsDir: path.join(runDir, ".."), only: "chrome" }),
      /no pages or types match --only chrome/,
    );
  } finally {
    await cleanup();
  }
});
