import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareContentModelBundle } from "./contentmodel.mjs";

// Writes `files` into <tmp>/runs/<site>/ and returns that run dir, plus a
// cleanup() that removes the whole temp root. Mirrors designmd.test.mjs's
// helper so both stages' tests read the same way.
async function mkRun(site, files) {
  const root = await mkdtemp(path.join(tmpdir(), "contentmodel-test-"));
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

function type(overrides) {
  return {
    name: "post",
    kind: "single:post",
    pattern: "/blog/*",
    confidence: "fingerprint",
    members: [],
    samples: [],
    archiveUrl: null,
    ...overrides,
  };
}

// Stages a captures/<slug>/content.json (all this stage reads).
async function stageCapture(runDir, slug, content = {}) {
  const dir = path.join(runDir, "captures", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "content.json"), JSON.stringify(content, null, 2));
}

// Silence the stderr warnings this stage writes on purpose (missing-capture
// notices, exclusion notices) so test output stays readable; tests assert on
// the returned/written data instead of on console noise.
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

// --- Guard rails: missing/empty input --------------------------------------

test("prepareContentModelBundle: throws when pagetypes.json is missing", async () => {
  const { runDir, cleanup } = await mkRun("no-pagetypes", {});
  try {
    await assert.rejects(
      prepareContentModelBundle({ site: "no-pagetypes", runsDir: path.join(runDir, "..") }),
      /pagetypes\.json not found for no-pagetypes\. Run classify first\./,
    );
  } finally {
    await cleanup();
  }
});

test("prepareContentModelBundle: throws when pagetypes.json is malformed", async () => {
  const { runDir, cleanup } = await mkRun("bad-json", { "pagetypes.json": "{ not valid json" });
  try {
    await assert.rejects(
      prepareContentModelBundle({ site: "bad-json", runsDir: path.join(runDir, "..") }),
      /pagetypes\.json not found for bad-json\. Run classify first\./,
    );
  } finally {
    await cleanup();
  }
});

test("prepareContentModelBundle: zero types at all — nothing to model", async () => {
  const { runDir, cleanup } = await mkRun("zero-types", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about"]),
  });
  try {
    await assert.rejects(
      prepareContentModelBundle({ site: "zero-types", runsDir: path.join(runDir, "..") }),
      /no repeating page types in zero-types — nothing to model; skip contentmodel\./,
    );
  } finally {
    await cleanup();
  }
});

test("prepareContentModelBundle: every type is kind `page` — nothing to model (page-kind types are one-offs, never modeled)", async () => {
  const { runDir, cleanup } = await mkRun("only-pages", {
    "pagetypes.json": pagetypes([
      type({ name: "misc", kind: "page", members: ["https://x.com/a", "https://x.com/b", "https://x.com/c", "https://x.com/d"], samples: ["https://x.com/a"] }),
    ]),
  });
  try {
    await assert.rejects(
      prepareContentModelBundle({ site: "only-pages", runsDir: path.join(runDir, "..") }),
      /no repeating page types in only-pages — nothing to model; skip contentmodel\./,
    );
  } finally {
    await cleanup();
  }
});

// --- Type filtering (only non-`page` kinds are modeled) --------------------

test(
  "prepareContentModelBundle: a `page`-kind type is excluded from the model even when a real type is present",
  withSilencedStderr(async () => {
    const { runDir, cleanup } = await mkRun("mixed-kinds", {
      "pagetypes.json": pagetypes([
        type({
          name: "team-member",
          kind: "single:team-member",
          members: ["https://x.com/team/a", "https://x.com/team/b", "https://x.com/team/c", "https://x.com/team/d"],
          samples: ["https://x.com/team/a", "https://x.com/team/b"],
        }),
        type({ name: "legal", kind: "page", members: ["https://x.com/l1", "https://x.com/l2", "https://x.com/l3", "https://x.com/l4"], samples: ["https://x.com/l1"] }),
      ]),
    });
    try {
      await stageCapture(runDir, "team__a", { title: "A" });
      await stageCapture(runDir, "team__b", { title: "B" });
      await stageCapture(runDir, "l1", { title: "Legal" });

      const r = await prepareContentModelBundle({ site: "mixed-kinds", runsDir: path.join(runDir, "..") });
      assert.equal(r.typeCount, 1);

      const samples = JSON.parse(await readFile(path.join(runDir, ".contentmodel", "samples.json"), "utf8"));
      assert.deepEqual(samples.types.map((t) => t.name), ["team-member"]);

      const prompt = await readFile(r.promptPath, "utf8");
      assert.match(prompt, /team-member/);
      assert.ok(!prompt.includes("legal"), "a page-kind type must never appear in the prompt's type list");
    } finally {
      await cleanup();
    }
  }),
);

// --- Missing-capture hazard: individual sample capture failed --------------

test(
  "prepareContentModelBundle: a sample whose capture failed is skipped, not fatal, and recorded so the failure is visible",
  withSilencedStderr(async () => {
    const { runDir, cleanup } = await mkRun("partial-miss", {
      "pagetypes.json": pagetypes([
        type({
          name: "case-study",
          kind: "single:case-study",
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
          archiveUrl: "https://x.com/work",
        }),
      ]),
    });
    try {
      // Only "a" was captured; "b"'s capture failed (all fallbacks exhausted
      // in capture.mjs — content.json never landed on disk).
      await stageCapture(runDir, "work__a", { title: "A" });

      const r = await prepareContentModelBundle({ site: "partial-miss", runsDir: path.join(runDir, "..") });
      assert.equal(r.typeCount, 1);

      const samples = JSON.parse(await readFile(path.join(runDir, ".contentmodel", "samples.json"), "utf8"));
      const t = samples.types[0];
      assert.equal(t.samples.length, 1);
      assert.equal(t.samples[0].slug, "work__a");
      assert.deepEqual(t.missing, ["https://x.com/work/b"]);

      // The gap must be visible in the prompt too, not just in samples.json.
      const prompt = await readFile(r.promptPath, "utf8");
      assert.match(prompt, /work__a/);
      assert.match(prompt, /sample capture\(s\) failed/);
      assert.match(prompt, /https:\/\/x\.com\/work\/b/);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "prepareContentModelBundle: a type with ALL sample captures missing is excluded (not modeled with zero grounding)",
  withSilencedStderr(async () => {
    const { runDir, cleanup } = await mkRun("all-miss-one-good", {
      "pagetypes.json": pagetypes([
        type({
          name: "case-study",
          kind: "single:case-study",
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
        }),
        type({
          name: "press-release",
          kind: "single:press-release",
          members: ["https://x.com/press/a", "https://x.com/press/b", "https://x.com/press/c", "https://x.com/press/d"],
          samples: ["https://x.com/press/a", "https://x.com/press/b"],
        }),
      ]),
    });
    try {
      // case-study captures exist; press-release's do not (both fallbacks exhausted).
      await stageCapture(runDir, "work__a", { title: "A" });
      await stageCapture(runDir, "work__b", { title: "B" });

      const r = await prepareContentModelBundle({ site: "all-miss-one-good", runsDir: path.join(runDir, "..") });
      assert.equal(r.typeCount, 1);

      const samples = JSON.parse(await readFile(path.join(runDir, ".contentmodel", "samples.json"), "utf8"));
      assert.deepEqual(samples.types.map((t) => t.name), ["case-study"]);

      const prompt = await readFile(r.promptPath, "utf8");
      assert.ok(!prompt.includes("press-release"), "a fully-uncaptured type must never reach the writing agent");
    } finally {
      await cleanup();
    }
  }),
);

test(
  "prepareContentModelBundle: every type has zero captured samples — nothing to model (distinct from the zero-types case)",
  withSilencedStderr(async () => {
    const { runDir, cleanup } = await mkRun("all-miss", {
      "pagetypes.json": pagetypes([
        type({
          name: "case-study",
          kind: "single:case-study",
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
        }),
      ]),
    });
    try {
      await assert.rejects(
        prepareContentModelBundle({ site: "all-miss", runsDir: path.join(runDir, "..") }),
        /no captured content for any repeating page type in all-miss.*run capture first/,
      );
    } finally {
      await cleanup();
    }
  }),
);

test(
  "prepareContentModelBundle: a type with no sample URLs at all (classify recorded none) is excluded, not a crash",
  withSilencedStderr(async () => {
    const { runDir, cleanup } = await mkRun("empty-samples", {
      "pagetypes.json": pagetypes([
        type({ name: "orphan-type", kind: "single:orphan", samples: [] }),
        type({
          name: "case-study",
          kind: "single:case-study",
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a"],
        }),
      ]),
    });
    try {
      await stageCapture(runDir, "work__a", { title: "A" });
      const r = await prepareContentModelBundle({ site: "empty-samples", runsDir: path.join(runDir, "..") });
      assert.equal(r.typeCount, 1);
      const samples = JSON.parse(await readFile(path.join(runDir, ".contentmodel", "samples.json"), "utf8"));
      assert.deepEqual(samples.types.map((t) => t.name), ["case-study"]);
    } finally {
      await cleanup();
    }
  }),
);

// --- Happy path: bundle shape + prompt content ------------------------------

test("prepareContentModelBundle: writes samples.json + PROMPT.md and returns the right paths", async () => {
  const { runDir, cleanup } = await mkRun("happy-path", {
    "pagetypes.json": pagetypes(
      [
        type({
          name: "case-study",
          kind: "single:case-study",
          pattern: "/work/*",
          members: ["https://x.com/work/a", "https://x.com/work/b", "https://x.com/work/c", "https://x.com/work/d"],
          samples: ["https://x.com/work/a", "https://x.com/work/b"],
          archiveUrl: "https://x.com/work",
        }),
      ],
      ["https://x.com/", "https://x.com/about"],
    ),
  });
  try {
    await stageCapture(runDir, "work__a", { title: "Case A" });
    await stageCapture(runDir, "work__b", { title: "Case B" });

    const r = await prepareContentModelBundle({ site: "happy-path", runsDir: path.join(runDir, "..") });

    assert.equal(r.site, "happy-path");
    assert.equal(r.typeCount, 1);
    assert.equal(r.promptPath, path.join(runDir, ".contentmodel", "PROMPT.md"));
    assert.equal(r.contentModelPath, path.resolve(runDir, "CONTENT-MODEL.md"));

    const samples = JSON.parse(await readFile(path.join(runDir, ".contentmodel", "samples.json"), "utf8"));
    assert.equal(samples.site, "happy-path");
    assert.equal(samples.types.length, 1);
    const t = samples.types[0];
    assert.equal(t.name, "case-study");
    assert.equal(t.kind, "single:case-study");
    assert.equal(t.pattern, "/work/*");
    assert.equal(t.memberCount, 4);
    assert.equal(t.archiveUrl, "https://x.com/work");
    assert.deepEqual(t.missing, []);
    assert.deepEqual(
      t.samples.map((s) => s.slug),
      ["work__a", "work__b"],
    );
    for (const s of t.samples) {
      assert.equal(s.contentPath, path.resolve(runDir, "captures", s.slug, "content.json"));
    }

    const prompt = await readFile(r.promptPath, "utf8");
    // The static template's own heading must be inlined verbatim.
    assert.match(prompt, /# Task: extract CONTENT-MODEL\.md \(WordPress content-model handoff\)/);
    assert.match(prompt, /Implementation option A — Pods/);
    assert.match(prompt, /Implementation option B — Easy Code Manager/);
    // Per-type listing: name, kind, member count, archive URL, sample paths.
    assert.match(prompt, /\*\*case-study\*\* \(kind: `single:case-study`, 4 pages, archive: https:\/\/x\.com\/work\)/);
    assert.ok(prompt.includes(path.resolve(runDir, "captures", "work__a", "content.json")));
    assert.ok(prompt.includes(path.resolve(runDir, "captures", "work__b", "content.json")));
    // Output path instruction.
    assert.ok(prompt.includes(r.contentModelPath));
    assert.match(prompt, /Type index.*samples\.json/s);
  } finally {
    await cleanup();
  }
});

test("prepareContentModelBundle: a `woo:` type is listed like any other (this stage only gathers samples; mapping onto product fields is the writing agent's job)", async () => {
  const { runDir, cleanup } = await mkRun("woo-site", {
    "pagetypes.json": pagetypes([
      type({
        name: "product",
        kind: "woo:product",
        pattern: "/shop/*",
        members: ["https://x.com/shop/a", "https://x.com/shop/b", "https://x.com/shop/c", "https://x.com/shop/d"],
        samples: ["https://x.com/shop/a"],
        archiveUrl: null,
      }),
    ]),
  });
  try {
    await stageCapture(runDir, "shop__a", { title: "Widget" });
    const r = await prepareContentModelBundle({ site: "woo-site", runsDir: path.join(runDir, "..") });
    assert.equal(r.typeCount, 1);
    const prompt = await readFile(r.promptPath, "utf8");
    assert.match(prompt, /\*\*product\*\* \(kind: `woo:product`, 4 pages\)/);
  } finally {
    await cleanup();
  }
});
