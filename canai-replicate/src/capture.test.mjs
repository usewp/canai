import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, mkdir, writeFile, readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import {
  buildWorklist,
  takeSpare,
  nextFallbackUrl,
  MAX_FALLBACK_ATTEMPTS,
  viewportRestored,
  accentScore,
  looksMobileEmulated,
  fillStyleWasAccepted,
  ab,
  resetSectionsDir,
  UX_JS,
  SECTIONS_JS,
  isRenderedGivenComputedStyle,
  looksLikeSamePage,
  buildTableModel,
  buildDefinitionListPairs,
  matchLabelValuePair,
  checkUrlStatus,
  capture,
  isThirdPartyWidgetContainer,
  exceedsClipLimits,
  planSectionAssignment,
  isBrowserDeathError,
} from "./capture.mjs";
import { urlToSlug } from "./slug.mjs";
import { MAX_CLIP_WIDTH_PX, MAX_CLIP_HEIGHT_PX, MAX_CLIP_AREA_PX2 } from "./cdp.mjs";

// Writes `files` (JSON-stringified) into <tmp>/runs/<site>/ and returns that
// run dir — exactly what buildWorklist expects as its first arg — plus a
// cleanup() that removes the whole temp root. No network, no browser: every
// test in this file is file-in / array-out.
async function mkRun(site, files) {
  const root = await mkdtemp(path.join(tmpdir(), "capture-test-"));
  const runDir = path.join(root, "runs", site);
  await mkdir(runDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await writeFile(path.join(runDir, name), JSON.stringify(data, null, 2));
  }
  return { runDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function pagetypes(types, pages = []) {
  return { site: "test-site", types, pages: pages.map((url) => ({ url })) };
}

// Mirrors transform.test.mjs's helper of the same name — the only tests in
// THIS file that produce console noise are the new capture()-orchestration
// ones below (capture() itself writes progress/failure lines to stderr;
// buildWorklist/takeSpare/nextFallbackUrl are pure and never did).
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

test("takeSpare dequeues in FIFO order and mutates the pool in place", () => {
  const spares = new Map([["t", ["https://x.com/1", "https://x.com/2"]]]);
  assert.equal(takeSpare(spares, "t"), "https://x.com/1");
  assert.equal(takeSpare(spares, "t"), "https://x.com/2");
  assert.equal(takeSpare(spares, "t"), undefined, "pool is empty, must not throw or wrap around");
  assert.equal(takeSpare(spares, "unknown-type"), undefined, "no pool for this type at all");
  assert.equal(takeSpare(spares, null), undefined, "untyped entries never have a pool");
});

test("buildWorklist dedupes by output slug, not raw URL string (Fix A: archive vs trailing-slash page)", async () => {
  // classify.mjs reconstructs archiveUrl slash-stripped ("https://x.com/shop")
  // but a crawled `pages` URL keeps its trailing slash ("https://x.com/shop/")
  // — the real shape seen live on wpdev (`/category/uncategorized/`). Exact-
  // string dedup treats these as two different entries (4 total, `shop`
  // captured twice, second write clobbering the first in `captures/shop/`
  // since urlToSlug strips the slash for both). Fixed: 3 entries.
  const { runDir, cleanup } = await mkRun("slash-site", {
    "pagetypes.json": pagetypes(
      [
        {
          name: "shop-type",
          kind: "woo:shop",
          pattern: null,
          confidence: "fingerprint-cluster",
          members: ["https://x.com/product-a", "https://x.com/product-b"],
          samples: ["https://x.com/product-a", "https://x.com/product-b"],
          archiveUrl: "https://x.com/shop",
        },
      ],
      ["https://x.com/shop/"],
    ),
  });
  try {
    const { entries } = await buildWorklist(runDir, null);
    assert.equal(entries.length, 3, "pre-fix (exact-string dedup) would keep both /shop and /shop/ → 4");
    const shopEntries = entries.filter((e) => urlToSlug(e.url) === "shop");
    assert.equal(shopEntries.length, 1, "archive and the trailing-slash page must collapse to one entry");
    assert.equal(shopEntries[0].type, "shop-type", "the surviving entry must be the typed one");
  } finally {
    await cleanup();
  }
});

test("buildWorklist: typed entry wins when a type's URL exactly duplicates a one-off page", async () => {
  // Same dedup pass, but an exact-string duplicate (no slash difference) —
  // isolates "typed beats untyped" from the slug-normalization behavior
  // covered by the slash test above.
  const { runDir, cleanup } = await mkRun("dup-site", {
    "pagetypes.json": pagetypes(
      [
        {
          name: "blog-post",
          kind: "single:post",
          pattern: null,
          confidence: "fingerprint-cluster",
          members: ["https://x.com/post-a", "https://x.com/post-b", "https://x.com/post-c", "https://x.com/post-d"],
          samples: ["https://x.com/post-a", "https://x.com/post-b"],
          archiveUrl: "https://x.com/my-account",
        },
      ],
      ["https://x.com/my-account"],
    ),
  });
  try {
    const { entries } = await buildWorklist(runDir, null);
    assert.equal(entries.length, 3);
    const dup = entries.filter((e) => e.url === "https://x.com/my-account");
    assert.equal(dup.length, 1, "duplicate URL must collapse to exactly one entry");
    assert.equal(dup[0].type, "blog-post", "the typed occurrence must survive, not null");
  } finally {
    await cleanup();
  }
});

test("buildWorklist: a spare must never slug-collide with a URL already in the worklist (Fix C)", async () => {
  // The reviewer proved this live: a non-sample member ".../hello-world/"
  // sits in a type's members alongside an unrelated one-off `pages` entry
  // ".../hello-world" (no trailing slash — same slug). Fix A dedupes
  // `entries` up front, but the spares pool is built straight from raw
  // `members` and was never cross-checked against that deduped worklist —
  // so `nextFallbackUrl` could still hand out the colliding member, and
  // capturing it would silently overwrite the one-off page's
  // `captures/hello-world/` directory. A second member,
  // "https://x.com/spare-ok/" (trailing slash — the exact Fix A bug shape),
  // is a slug-for-slug duplicate of "https://x.com/spare-ok" within the
  // *same* pool, pinning the "against themselves" half of the fix too.
  const { runDir, cleanup } = await mkRun("collide-site", {
    "pagetypes.json": pagetypes(
      [
        {
          name: "t",
          kind: "single:t",
          pattern: null,
          confidence: "fingerprint-cluster",
          members: [
            "https://x.com/a",
            "https://x.com/hello-world/",
            "https://x.com/spare-ok",
            "https://x.com/spare-ok/",
          ],
          samples: ["https://x.com/a"],
          archiveUrl: null,
        },
      ],
      ["https://x.com/hello-world"],
    ),
  });
  try {
    const { entries, spares } = await buildWorklist(runDir, null);

    const pageEntry = entries.find((e) => urlToSlug(e.url) === "hello-world");
    assert.ok(pageEntry, "the one-off page entry must be in the worklist");
    assert.equal(pageEntry.type, null);

    const pool = spares.get("t");
    assert.ok(
      !pool.some((u) => urlToSlug(u) === "hello-world"),
      "a member slug-colliding with a worklist entry must be filtered out of the spare pool",
    );
    assert.deepEqual(
      pool,
      ["https://x.com/spare-ok"],
      "the non-colliding spare survives; its same-slug duplicate within the pool does not",
    );

    const entry = entries.find((e) => e.type === "t");
    const fallback = nextFallbackUrl(entry, spares, 0);
    assert.equal(fallback, "https://x.com/spare-ok", "the only fallback ever handed out must be the non-colliding spare");
    assert.equal(
      nextFallbackUrl(entry, spares, 1),
      undefined,
      "the colliding member and the in-pool duplicate must never surface as a second fallback",
    );
  } finally {
    await cleanup();
  }
});

test("nextFallbackUrl gives distinct spares to different failing samples in the same type", async () => {
  const { runDir, cleanup } = await mkRun("distinct-site", {
    "pagetypes.json": pagetypes([
      {
        name: "t",
        kind: "single:t",
        pattern: null,
        confidence: "fingerprint-cluster",
        members: [
          "https://x.com/a",
          "https://x.com/b",
          "https://x.com/c",
          "https://x.com/spare-1",
          "https://x.com/spare-2",
        ],
        samples: ["https://x.com/a", "https://x.com/b", "https://x.com/c"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    const { entries, spares } = await buildWorklist(runDir, null);
    const samples = entries.filter((e) => e.type === "t");
    assert.equal(samples.length, 3);
    const fallbackA = nextFallbackUrl(samples[0], spares, 0);
    const fallbackB = nextFallbackUrl(samples[1], spares, 0);
    assert.notEqual(fallbackA, undefined);
    assert.notEqual(fallbackB, undefined);
    assert.notEqual(fallbackA, fallbackB, "two independently-failing samples must not be offered the same spare");
  } finally {
    await cleanup();
  }
});

test("scarcity: spares < samples must not strand the spare on a sample that never needed it (Fix B)", async () => {
  // The exact shape proved live: 3 samples (1 healthy, 2 dead) + 1 spare.
  // A static round-robin-by-index partition can bind the one spare to the
  // *healthy* sample's index, leaving both dead samples with nothing —
  // 1/3 captured when 2/3 was achievable. A shared pool has no index at
  // all: whichever sample asks first gets it.
  const { runDir, cleanup } = await mkRun("scarcity-site", {
    "pagetypes.json": pagetypes([
      {
        name: "t",
        kind: "single:t",
        pattern: null,
        confidence: "fingerprint-cluster",
        members: ["https://x.com/live", "https://x.com/dead-1", "https://x.com/dead-2", "https://x.com/spare"],
        samples: ["https://x.com/live", "https://x.com/dead-1", "https://x.com/dead-2"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    const { entries, spares } = await buildWorklist(runDir, null);
    const samples = entries.filter((e) => e.type === "t");
    const dead1 = samples.find((e) => e.url.endsWith("/dead-1"));
    const dead2 = samples.find((e) => e.url.endsWith("/dead-2"));
    const live = samples.find((e) => e.url.endsWith("/live"));

    // Only the two dead samples ever fail in real life; `live` never even
    // asks. dead-1 happens to fail (and so ask) first in this simulation.
    assert.equal(
      nextFallbackUrl(dead1, spares, 0),
      "https://x.com/spare",
      "the one spare must be available to whichever dead sample asks first, not reserved for a fixed index",
    );
    assert.equal(
      nextFallbackUrl(dead2, spares, 0),
      undefined,
      "pool only ever had one spare; the second failing sample correctly gets none instead of crashing or duplicating",
    );
    // Bonus sanity check: the pool is now empty for every entry of this
    // type, including one that would never realistically ask.
    assert.equal(nextFallbackUrl(live, spares, 0), undefined);
  } finally {
    await cleanup();
  }
});

test("zero spares when samples cover all members: nothing crashes, pool is empty", async () => {
  const { runDir, cleanup } = await mkRun("zero-spare-site", {
    "pagetypes.json": pagetypes([
      {
        name: "t",
        kind: "single:t",
        pattern: null,
        confidence: "fingerprint-cluster",
        members: ["https://x.com/a", "https://x.com/b"],
        samples: ["https://x.com/a", "https://x.com/b"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    const { entries, spares } = await buildWorklist(runDir, null);
    assert.deepEqual(spares.get("t"), []);
    const samples = entries.filter((e) => e.type === "t");
    assert.equal(samples.length, 2);
    for (const s of samples) {
      assert.equal(nextFallbackUrl(s, spares, 0), undefined);
    }
  } finally {
    await cleanup();
  }
});

test("bounded retry: a failing entry never drains more than MAX_FALLBACK_ATTEMPTS spares, however large the pool", async () => {
  // A 300-member type with hundreds of dead spares must not make one
  // failing entry march through all of them.
  const manySpares = Array.from({ length: 20 }, (_, i) => `https://x.com/spare-${i}`);
  const { runDir, cleanup } = await mkRun("bounded-site", {
    "pagetypes.json": pagetypes([
      {
        name: "t",
        kind: "single:t",
        pattern: null,
        confidence: "fingerprint-cluster",
        members: ["https://x.com/a", ...manySpares],
        samples: ["https://x.com/a"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    const { entries, spares } = await buildWorklist(runDir, null);
    const entry = entries.find((e) => e.type === "t");
    let fallbacksUsed = 0;
    let consumed = 0;
    for (;;) {
      const next = nextFallbackUrl(entry, spares, fallbacksUsed);
      if (next === undefined) break;
      fallbacksUsed += 1;
      consumed += 1;
    }
    assert.equal(consumed, MAX_FALLBACK_ATTEMPTS);
    assert.equal(spares.get("t").length, 20 - MAX_FALLBACK_ATTEMPTS, "unused spares must stay in the pool, not be drained");
  } finally {
    await cleanup();
  }
});

test("buildWorklist falls back to pages.json when pagetypes.json is absent (v2 behavior)", async () => {
  const { runDir, cleanup } = await mkRun("v2-site", {
    "pages.json": { site: "v2-site", pages: [{ url: "https://x.com/" }, { url: "https://x.com/about" }] },
  });
  try {
    const { entries, spares } = await buildWorklist(runDir, null);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e) => e.type),
      [null, null],
    );
    assert.equal(spares.size, 0, "no types, so no spare pools at all");
  } finally {
    await cleanup();
  }
});

test("buildWorklist: types: [] with everything in pages (documented small-site result)", async () => {
  const { runDir, cleanup } = await mkRun("small-site", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about", "https://x.com/contact"]),
  });
  try {
    const { entries } = await buildWorklist(runDir, null);
    assert.equal(entries.length, 3);
    assert.ok(entries.every((e) => e.type === null));
  } finally {
    await cleanup();
  }
});

test("buildWorklist --only filters by URL pathname and by type name", async () => {
  const { runDir, cleanup } = await mkRun("only-site", {
    "pagetypes.json": pagetypes(
      [
        {
          name: "posts",
          kind: "single:post",
          pattern: "/blog/*",
          confidence: "fingerprint",
          members: ["https://x.com/blog/a", "https://x.com/blog/b", "https://x.com/blog/c", "https://x.com/blog/d"],
          samples: ["https://x.com/blog/a", "https://x.com/blog/b"],
          archiveUrl: "https://x.com/blog",
        },
      ],
      ["https://x.com/", "https://x.com/about"],
    ),
  });
  try {
    const byPath = await buildWorklist(runDir, "/about");
    assert.equal(byPath.entries.length, 1);
    assert.equal(byPath.entries[0].url, "https://x.com/about");

    const byType = await buildWorklist(runDir, "posts");
    assert.equal(byType.entries.length, 3, "2 samples + 1 archive, all typed 'posts'");
    assert.ok(byType.entries.every((e) => e.type === "posts"));

    await assert.rejects(() => buildWorklist(runDir, "/nope"), /no pages match/);
  } finally {
    await cleanup();
  }
});

test("buildWorklist --only ALSO accepts a bare output slug (Fix 2: pre-fix, only capture threw on this form)", async () => {
  // Same fixture shape as the URL-pathname/type-name test above — this pins
  // specifically the form that was broken: transform and verify already
  // accepted a bare slug; capture did not (its old inline filter only ever
  // checked `e.type === only` or a pathname match).
  const { runDir, cleanup } = await mkRun("only-slug-site", {
    "pagetypes.json": pagetypes(
      [
        {
          name: "posts",
          kind: "single:post",
          pattern: "/blog/*",
          confidence: "fingerprint",
          members: ["https://x.com/blog/a", "https://x.com/blog/b", "https://x.com/blog/c", "https://x.com/blog/d"],
          samples: ["https://x.com/blog/a", "https://x.com/blog/b"],
          archiveUrl: "https://x.com/blog",
        },
      ],
      ["https://x.com/", "https://x.com/about"],
    ),
  });
  try {
    const byBareSlug = await buildWorklist(runDir, "about");
    assert.equal(byBareSlug.entries.length, 1);
    assert.equal(byBareSlug.entries[0].url, "https://x.com/about");

    const byIndexSlug = await buildWorklist(runDir, "index");
    assert.equal(byIndexSlug.entries.length, 1);
    assert.equal(byIndexSlug.entries[0].url, "https://x.com/");
  } finally {
    await cleanup();
  }
});

// --- Fix 1: a `kind: "page"` type is not a repeating content type ---------

test("buildWorklist: a kind:'page' type enumerates ALL its members as untyped page entries, not just its samples", async () => {
  // Exact shape proven live: one type, kind='page', 5 members, 2 samples —
  // pre-fix, capture only captured the 2 samples while transform.mjs (which
  // already expanded ALL members for a page-kind type) wanted bundles for
  // all 5, silently skipping 3 as "no capture".
  const { runDir, cleanup } = await mkRun("page-kind-site", {
    "pagetypes.json": pagetypes([
      {
        name: "misc",
        kind: "page",
        pattern: null,
        confidence: "fingerprint-cluster",
        members: ["https://x.com/a", "https://x.com/b", "https://x.com/c", "https://x.com/d", "https://x.com/e"],
        samples: ["https://x.com/a", "https://x.com/c"], // classify only sampled 2 of 5
        archiveUrl: null,
      },
    ]),
  });
  try {
    const { entries, spares } = await buildWorklist(runDir, null);
    assert.equal(entries.length, 5, "all 5 members must be captured, not just the 2 samples");
    assert.ok(entries.every((e) => e.type === null), "a page-kind type's members are untyped entries, same as pt.pages");
    assert.ok(entries.every((e) => e.canFallback === false), "no sample/spare distinction left once every member is its own entry");
    assert.deepEqual(
      entries.map((e) => e.url).sort(),
      ["https://x.com/a", "https://x.com/b", "https://x.com/c", "https://x.com/d", "https://x.com/e"],
    );
    assert.equal(spares.get("misc"), undefined, "a page-kind type must never get a spare pool");
  } finally {
    await cleanup();
  }
});

test("buildWorklist: a kind:'page' type mixed with a real repeating type and one-off pages — dedup (Fix A) still applies across all three", async () => {
  const { runDir, cleanup } = await mkRun("page-kind-mixed-site", {
    "pagetypes.json": pagetypes(
      [
        {
          name: "misc",
          kind: "page",
          pattern: null,
          confidence: "fingerprint-cluster",
          members: ["https://x.com/misc-a", "https://x.com/misc-b"],
          samples: ["https://x.com/misc-a"],
          archiveUrl: null,
        },
        {
          name: "posts",
          kind: "single:post",
          pattern: "/blog/*",
          confidence: "fingerprint",
          members: ["https://x.com/blog/a", "https://x.com/blog/b", "https://x.com/blog/c", "https://x.com/blog/d"],
          samples: ["https://x.com/blog/a", "https://x.com/blog/b"],
          archiveUrl: null,
        },
      ],
      ["https://x.com/misc-a"], // exact duplicate of the page-kind type's own member
    ),
  });
  try {
    const { entries } = await buildWorklist(runDir, null);
    // 2 (misc members) + 2 (posts samples) — the duplicate "misc-a" pages.json
    // entry must collapse into the one already produced by the page-kind type.
    assert.equal(entries.length, 4);
    const miscA = entries.filter((e) => e.url === "https://x.com/misc-a");
    assert.equal(miscA.length, 1, "the page-kind type's member and the duplicate pages.json entry must collapse to one");
  } finally {
    await cleanup();
  }
});

// --- Fix 5: cross-type slug collisions resolve by the SAME tier order as
// transform.mjs's resolveSlugClaims (own-sample beats a cross-type archive)

test("buildWorklist: cross-type slug collision — a type's OWN sample beats a DIFFERENT type's archiveUrl, regardless of array order (Fix 5)", async () => {
  // Real shape proven on barefootbuttons.com
  // (2026-07-14-canai-replicate-v3-followups.md, item 1): "product"'s
  // archiveUrl and the standalone "shop" type's own sample both resolve to
  // https://x.com/shop. transform.mjs's resolveSlugClaims already tiers
  // this correctly (any sample beats any cross-type archive); buildWorklist
  // previously just kept whichever entry it saw FIRST by pt.types array
  // order. The archive-owning type ("product") is deliberately listed FIRST
  // in this fixture, so this test would have failed under the pre-fix
  // array-order behavior (product's archive entry would have been seen —
  // and kept — before shop's own sample).
  const { runDir, cleanup } = await mkRun("cross-type-site", {
    "pagetypes.json": pagetypes([
      {
        name: "product",
        kind: "single:product",
        pattern: "/product/*",
        confidence: "fingerprint",
        members: ["https://x.com/product/a", "https://x.com/product/b"],
        samples: ["https://x.com/product/a", "https://x.com/product/b"],
        archiveUrl: "https://x.com/shop", // collides with shop-type's own sample below
      },
      {
        name: "shop",
        kind: "woo:shop",
        pattern: null,
        confidence: "url-only",
        members: ["https://x.com/shop"],
        samples: ["https://x.com/shop"], // the type this slug SHOULD end up labeled as
        archiveUrl: null,
      },
    ]),
  });
  try {
    const { entries } = await buildWorklist(runDir, null);
    const shopEntries = entries.filter((e) => urlToSlug(e.url) === "shop");
    assert.equal(shopEntries.length, 1, "must collapse to one entry");
    assert.equal(
      shopEntries[0].type,
      "shop",
      "shop's OWN SAMPLE must win the slug over product's cross-type archiveUrl, matching resolveSlugClaims' tiering",
    );
    assert.equal(
      shopEntries[0].canFallback,
      true,
      "the surviving entry is a real sample (fallback-eligible), not the dropped archive",
    );
  } finally {
    await cleanup();
  }
});

test("buildWorklist: within ONE type, its own sample still beats its own archiveUrl when they collide (tier order doesn't regress the single-type case)", async () => {
  const { runDir, cleanup } = await mkRun("self-collide-site", {
    "pagetypes.json": pagetypes([
      {
        name: "shop",
        kind: "woo:shop",
        pattern: null,
        confidence: "url-only",
        members: ["https://x.com/shop", "https://x.com/other"],
        samples: ["https://x.com/shop", "https://x.com/other"],
        archiveUrl: "https://x.com/shop",
      },
    ]),
  });
  try {
    const { entries } = await buildWorklist(runDir, null);
    const shopEntries = entries.filter((e) => urlToSlug(e.url) === "shop");
    assert.equal(shopEntries.length, 1);
    assert.equal(shopEntries[0].canFallback, true, "the sample survives, not the same type's own archive duplicate");
  } finally {
    await cleanup();
  }
});

// --- Fix 1: viewport restore verification (pure decision logic) -----------

test("viewportRestored: exact match, and within the 2px tolerance, both count as restored", () => {
  assert.equal(viewportRestored(1722, 1722), true);
  assert.equal(viewportRestored(1721, 1722), true);
  assert.equal(viewportRestored(1724, 1722), true);
});

test("viewportRestored: a mobile-width leftover (375) must never pass as 'close enough' to a real desktop width", () => {
  assert.equal(viewportRestored(375, 1722), false);
  assert.equal(viewportRestored(375, 375), true, "same value trivially matches — this is not a magic-number check");
});

test("viewportRestored: non-finite/missing measurements never count as restored", () => {
  assert.equal(viewportRestored(null, 1722), false);
  assert.equal(viewportRestored(undefined, 1722), false);
  assert.equal(viewportRestored(NaN, 1722), false);
  assert.equal(viewportRestored(1722, NaN), false);
});

// --- Fix 4: role-based style tokens (color-math helper) -------------------
// STYLES_JS runs inside the captured page via `eval` with zero dependencies,
// so it can't literally import accentScore — this pins the identical
// scoring formula's correctness on the Node side (see STYLES_JS's
// `accentScoreOf`, which must be kept in sync by hand). Color-string-to-RGB
// normalization itself (STYLES_JS does this via an in-browser canvas, so it
// transparently handles rgb()/hsl()/lab()/oklab()/etc.) needs a DOM and
// isn't exercised here — these tests pass raw bytes directly.

test("accentScore: a fully opaque vivid color scores at (or near) the maximum", () => {
  assert.equal(accentScore(255, 0, 0, 255), 1);
  assert.equal(accentScore(255, 255, 0, 255), 1);
});

test("accentScore: grayscale (including black/white) scores zero regardless of alpha", () => {
  assert.equal(accentScore(128, 128, 128, 255), 0);
  assert.equal(accentScore(0, 0, 0, 255), 0);
  assert.equal(accentScore(255, 255, 255, 255), 0);
  assert.equal(accentScore(0, 0, 0, 13), 0, "gray at low alpha is still gray, not an accent");
});

test("accentScore: a brand-accent blue scores clearly above a muted gray-blue (both opaque)", () => {
  const accent = accentScore(59, 130, 246, 255); // Tailwind blue-500
  const mutedGray = accentScore(100, 105, 110, 255);
  assert.ok(accent > 0.6, `expected a vivid accent color to score highly, got ${accent}`);
  assert.ok(mutedGray < 0.1, `expected a near-gray to score near zero, got ${mutedGray}`);
  assert.ok(accent > mutedGray);
});

test("accentScore: alpha weighting — the same hue at low opacity scores far below full opacity", () => {
  const opaque = accentScore(255, 59, 157, 255);
  const faint = accentScore(255, 59, 157, 14); // ~5% alpha, as seen live (see below)
  assert.ok(opaque > 0.7);
  assert.ok(faint < 0.1, `a ~5%-opacity tint must not score anywhere near as strongly as the opaque color`);
});

test("accentScore: regression — a near-black pixel with a sub-pixel color tint must NOT outscore a genuinely vivid opaque color", () => {
  // The exact live bug found capturing tailwindcss.com: a button background
  // of oklab(0.13 -0.004 -0.028 / 0.05) canvas-normalizes to rgb(0, 0, 20)
  // at alpha 13/255 — full HSL saturation scores this a perfect 1.0 (HSL
  // saturation is numerically unstable near lightness 0), which would have
  // beaten the page's actual vivid, fully-opaque CTA background
  // (lab(56.9303 76.8162 -8.07021) -> rgb(246, 51, 154), alpha 255) in the
  // accent-guess. Chroma-times-alpha does not have that blowup.
  const nearBlackNoise = accentScore(0, 0, 20, 13);
  const realVividCta = accentScore(246, 51, 154, 255);
  assert.ok(
    nearBlackNoise < realVividCta,
    `near-black noise (${nearBlackNoise}) must score below the real vivid CTA (${realVividCta})`,
  );
  assert.ok(nearBlackNoise < 0.15, "must fall below MIN_ACCENT_SCORE so it's never picked at all");
});

// --- Task 4d, Finding 1: start-of-page viewport-contamination detection ---
// (pure decision logic). The full guarantee (ensureUnemulatedViewport) also
// shells out to agent-browser and can only be proven live — see
// task-4d-report.md for the both-fail and already-pinned-tab proofs. This
// pins the part that's actually load-bearing for "can't self-certify": the
// comparison target is a fixed constant, not an argument, so there's no way
// to hand this function a corrupted baseline the way restoreDesktopViewport
// could be (Fix 1, Task 4c).

test("looksMobileEmulated: exact 375x812 and within-tolerance neighbors are detected as mobile-emulated", () => {
  assert.equal(looksMobileEmulated(375, 812), true);
  assert.equal(looksMobileEmulated(374, 813), true);
  assert.equal(looksMobileEmulated(376, 811), true);
});

test("looksMobileEmulated: real desktop sizes are never mistaken for mobile", () => {
  assert.equal(looksMobileEmulated(1722, 955), false);
  assert.equal(looksMobileEmulated(1280, 800), false);
  assert.equal(looksMobileEmulated(1920, 1080), false);
});

test("looksMobileEmulated: BOTH dimensions must match — width alone (or height alone) must not read as mobile-emulated", () => {
  // A real, non-emulated window could plausibly be exactly 375 CSS px wide
  // (a narrow snapped browser) or exactly 812 tall, but requiring both
  // together is what keeps this from firing on that coincidence — mobile
  // emulation always sets both dimensions as a pair.
  assert.equal(looksMobileEmulated(375, 955), false, "375 wide but not 812 tall");
  assert.equal(looksMobileEmulated(1722, 812), false, "812 tall but not 375 wide");
});

test("looksMobileEmulated: non-finite/missing measurements never count as mobile-emulated", () => {
  assert.equal(looksMobileEmulated(null, 812), false);
  assert.equal(looksMobileEmulated(375, null), false);
  assert.equal(looksMobileEmulated(NaN, NaN), false);
  assert.equal(looksMobileEmulated(undefined, undefined), false);
});

// --- Task 4d, Finding 3: toRgbBytes' sentinel-echo detection (pure part) --

function makeFakeCanvasCtx(isValid) {
  // Mimics real Canvas2D's exact, spec-accurate quirk: an unparseable
  // fillStyle assignment is SILENTLY IGNORED (the setter is a no-op) — it
  // never throws, so a naive try/catch around the assignment can't detect
  // it either. This is the crux of the Task 4d Finding 3 bug: reusing one
  // ctx across calls means a rejected assignment reads back as whatever
  // color a PREVIOUS call left there, not as "rejected".
  let _fillStyle = "#000000";
  return {
    get fillStyle() {
      return _fillStyle;
    },
    set fillStyle(v) {
      if (isValid(v)) _fillStyle = v;
    },
  };
}

test("fillStyleWasAccepted: a color the context accepts reads back as accepted", () => {
  const ctx = makeFakeCanvasCtx((v) => v === "rgb(1, 2, 3)" || v === "rgb(10, 20, 30)");
  assert.equal(fillStyleWasAccepted(ctx, "rgb(10, 20, 30)"), true);
});

test("fillStyleWasAccepted: a color the context silently rejects reads back as rejected, not as a coincidental sentinel match", () => {
  // Only the sentinel itself is ever "valid" here — simulates a colorStr
  // Canvas2D can't parse at all.
  const ctx = makeFakeCanvasCtx((v) => v === "rgb(1, 2, 3)");
  assert.equal(fillStyleWasAccepted(ctx, "this-is-not-a-css-color"), false);
});

test("fillStyleWasAccepted: reusing the same ctx across calls, a rejected color never reads back as the PREVIOUS call's accepted color (the actual bug shape)", () => {
  const ctx = makeFakeCanvasCtx((v) => v === "rgb(1, 2, 3)" || v === "rgb(99, 99, 99)");
  assert.equal(fillStyleWasAccepted(ctx, "rgb(99, 99, 99)"), true, "first call: a real color is accepted");
  assert.equal(
    fillStyleWasAccepted(ctx, "garbage"),
    false,
    "second call, same ctx, an invalid color — must not read back as accepted just because rgb(99,99,99) is still sitting there from the previous call",
  );
});

test("fillStyleWasAccepted: a custom sentinel is honored", () => {
  const ctx = makeFakeCanvasCtx((v) => v === "sentinel-value" || v === "rgb(5, 6, 7)");
  assert.equal(fillStyleWasAccepted(ctx, "rgb(5, 6, 7)", "sentinel-value"), true);
  assert.equal(fillStyleWasAccepted(ctx, "nope", "sentinel-value"), false);
});

// --- Task 4d, Finding 2: ab() subprocess timeout ---------------------------
// A fake ChildProcess (EventEmitter-based, same shape node:child_process
// gives back) injected via ab()'s `spawnFn` seam — proves the timeout logic
// deterministically and fast, without a real agent-browser process. The
// live, real-OS-process proof (timeout fires AND no zombie survives) is in
// task-4d-report.md.

function makeFakeProc({ neverClose = false, exitCode = 0, exitSignal = null, stdoutData = "", stderrData = "" } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write() {},
    end() {},
  };
  proc.killed = false;
  proc.killSignals = [];
  proc.kill = (sig) => {
    proc.killed = true;
    proc.killSignals.push(sig);
    return true;
  };
  if (!neverClose) {
    queueMicrotask(() => {
      if (stdoutData) proc.stdout.emit("data", Buffer.from(stdoutData));
      if (stderrData) proc.stderr.emit("data", Buffer.from(stderrData));
      proc.emit("close", exitCode, exitSignal);
    });
  }
  return proc;
}

test("ab(): resolves normally on a prompt zero-exit — the timeout wrapper doesn't change the happy path", async () => {
  const proc = makeFakeProc({ stdoutData: "hello" });
  const res = await ab(["eval"], { spawnFn: () => proc, timeoutMs: 5000 });
  assert.equal(res.stdout, "hello");
});

test("ab(): a non-zero exit still rejects with the pre-existing error shape, unaffected by the timeout wrapper", async () => {
  const proc = makeFakeProc({ exitCode: 2, stderrData: "boom" });
  await assert.rejects(
    () => ab(["eval"], { spawnFn: () => proc, timeoutMs: 5000 }),
    (err) => {
      assert.match(err.message, /agent-browser exited 2: boom/);
      assert.equal(err.code, 2);
      assert.equal(err.timedOut, undefined);
      return true;
    },
  );
});

test("ab(): a signal-killed exit (not a timeout) still names the signal, unaffected by the timeout wrapper", async () => {
  const proc = makeFakeProc({ exitCode: null, exitSignal: "SIGTERM" });
  await assert.rejects(
    () => ab(["eval"], { spawnFn: () => proc, timeoutMs: 5000 }),
    (err) => {
      assert.match(err.message, /agent-browser exited null \(killed by signal SIGTERM\)/);
      return true;
    },
  );
});

test("ab(): a spawn 'error' event still rejects immediately, unaffected by the timeout wrapper", async () => {
  const proc = makeFakeProc({ neverClose: true });
  const p = ab(["eval"], { spawnFn: () => proc, timeoutMs: 5000 });
  queueMicrotask(() => proc.emit("error", new Error("spawn agent-browser ENOENT")));
  await assert.rejects(() => p, /ENOENT/);
});

test("ab(): a subprocess that never closes times out promptly instead of hanging forever, and the child is killed (no zombie)", async () => {
  const proc = makeFakeProc({ neverClose: true });
  const started = Date.now();
  await assert.rejects(
    () => ab(["eval"], { spawnFn: () => proc, timeoutMs: 30 }),
    (err) => {
      assert.match(err.message, /timed out after 30ms and was killed/);
      assert.equal(err.timedOut, true);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, "must reject promptly, not hang for the test run's own timeout");
  assert.equal(proc.killed, true, "the stalled child must be killed, not left running");
  assert.deepEqual(proc.killSignals, ["SIGTERM"], "SIGTERM is attempted first");
});

test("ab(): escalates to SIGKILL if the child is still alive after killGraceMs", async () => {
  const proc = makeFakeProc({ neverClose: true }); // ignores kill() entirely — never actually exits
  await assert.rejects(() => ab(["eval"], { spawnFn: () => proc, timeoutMs: 20, killGraceMs: 20 }));
  // The rejection fires at timeoutMs; give the killGraceMs escalation timer
  // a little longer than its own delay to fire before asserting on it.
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(
    proc.killSignals,
    ["SIGTERM", "SIGKILL"],
    "a child that ignores SIGTERM past killGraceMs must be escalated to SIGKILL",
  );
});

test("ab(): a close event that arrives after the timeout already rejected is ignored, not a second settle", async () => {
  const proc = makeFakeProc({ neverClose: true });
  await assert.rejects(() => ab(["eval"], { spawnFn: () => proc, timeoutMs: 20 }));
  // A "late" close arriving after timeout must not throw (e.g. an
  // unhandled "resolve after reject" crash) or otherwise misbehave.
  assert.doesNotThrow(() => proc.emit("close", 0, null));
});

// --- Task 4d, Finding 4: stale sections/ files must not survive a re-run --

test("resetSectionsDir: wipes a stale file left by a previous run before the directory is repopulated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sections-reset-test-"));
  const sectionsDir = path.join(root, "captures", "checkout", "sections");
  await mkdir(sectionsDir, { recursive: true });
  const staleFile = path.join(sectionsDir, "01-section-1.png");
  await writeFile(staleFile, "stale-bytes-from-an-earlier-run");
  try {
    await resetSectionsDir(sectionsDir);
    const entries = await readdir(sectionsDir);
    assert.deepEqual(entries, [], "the stale file from a previous run must be gone");
    const st = await stat(sectionsDir);
    assert.ok(st.isDirectory(), "the directory itself must still exist, ready for this run's fresh writes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resetSectionsDir: creating it fresh (first-ever run, directory doesn't exist yet) still works", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sections-reset-fresh-test-"));
  const sectionsDir = path.join(root, "captures", "index", "sections");
  try {
    await resetSectionsDir(sectionsDir);
    const st = await stat(sectionsDir);
    assert.ok(st.isDirectory());
    assert.deepEqual(await readdir(sectionsDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Task 5: ux.json / alpine-recipes.md join-key consistency -------------
// UX_JS runs inside the captured page via `eval` (no DOM in Node, so it can't
// be executed here — same eval-boundary constraint as STYLES_JS above), but
// its `recipe` names are plain string literals in the source text, so the
// join key against prompts/alpine-recipes.md's `##` headings CAN be checked
// statically, mechanically, without a browser. This is exactly what pins the
// two files together forever: a renamed/typo'd recipe on either side (UX_JS
// emitting a recipe with no matching heading, or a heading no detector ever
// emits) would otherwise only surface as silently-missing guidance in
// whatever a later stage (Task 8) builds from ux.json — never as a test
// failure — until this test existed.

// Pulls every `add(pattern, "recipe-name", …)` call's recipe-name literal out
// of UX_JS's actual source text (not a hand-copied duplicate of the list) —
// so this test breaks the moment UX_JS's real recipe names drift from
// whatever list follows, not just when this test's own idea of the list does.
function recipeNamesInUxJs() {
  return [...UX_JS.matchAll(/\badd\(\s*"[^"]*",\s*"([^"]+)"/g)].map((m) => m[1]);
}

async function alpineRecipeHeadings() {
  const mdPath = path.join(import.meta.dirname, "..", "prompts", "alpine-recipes.md");
  const md = await readFile(mdPath, "utf8");
  return [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
}

test("UX_JS's recipe-name set is exactly the 7 names the Task 5 interface spec pins", () => {
  const names = recipeNamesInUxJs();
  assert.deepEqual(
    [...names].sort(),
    ["accordion", "carousel", "dropdown-menu", "modal", "nav-toggle", "sticky-header", "tabs"],
    "adding/removing/renaming a UX_JS recipe must be a deliberate, visible change to this pinned list",
  );
});

test("every recipe name UX_JS can emit has a matching '## <name>' heading in prompts/alpine-recipes.md", async () => {
  const names = recipeNamesInUxJs();
  assert.ok(names.length > 0, "sanity: UX_JS must call add(...) with a recipe name at least once");
  const headings = await alpineRecipeHeadings();
  for (const name of names) {
    assert.ok(
      headings.includes(name),
      `UX_JS emits recipe "${name}" but prompts/alpine-recipes.md has no "## ${name}" heading — ` +
        `Task 8's transform prompt would silently drop this recipe's guidance`,
    );
  }
});

test("every recipe heading in prompts/alpine-recipes.md is actually emitted by some UX_JS detector (no orphaned recipe docs)", async () => {
  const names = recipeNamesInUxJs();
  const headings = await alpineRecipeHeadings();
  for (const heading of headings) {
    assert.ok(
      names.includes(heading),
      `prompts/alpine-recipes.md documents "## ${heading}" but no UX_JS detector emits recipe "${heading}" — ` +
        `likely a rename on one side that didn't propagate to the other`,
    );
  }
});

// --- Fix 3/Fix 4: SECTIONS_JS's third-party denylist, oversized-hero drill,
// and last-resort body fallback (pure parity copies — see SECTIONS_JS's own
// doc comments for the eval-boundary rationale and live evidence).

test("isThirdPartyWidgetContainer: matches the real HubSpot classes/ids observed live on humanmade.com/work/", () => {
  assert.equal(isThirdPartyWidgetContainer(null, "hs-web-interactives-a1b2c3"), true);
  assert.equal(isThirdPartyWidgetContainer(null, "cookie-consent-banner"), true);
  assert.equal(isThirdPartyWidgetContainer("hubspot-messages-iframe-container", null), true);
  assert.equal(isThirdPartyWidgetContainer(null, "hubspot-messages-iframe-container"), true);
});

test("isThirdPartyWidgetContainer: matches intercom/drift/crisp/tawk/grecaptcha containers", () => {
  assert.equal(isThirdPartyWidgetContainer(null, "intercom-lightweight-app"), true);
  assert.equal(isThirdPartyWidgetContainer("intercom-container", null), true);
  assert.equal(isThirdPartyWidgetContainer(null, "drift-frame-controller"), true);
  assert.equal(isThirdPartyWidgetContainer(null, "crisp-client"), true);
  assert.equal(isThirdPartyWidgetContainer(null, "tawk-min-container"), true);
  assert.equal(isThirdPartyWidgetContainer(null, "grecaptcha-badge"), true);
});

test("isThirdPartyWidgetContainer: never excludes real content that merely mentions cookie/chat/consent in its class name", () => {
  assert.equal(isThirdPartyWidgetContainer(null, "chocolate-chip-cookies-section"), false);
  assert.equal(isThirdPartyWidgetContainer(null, "chat-with-us"), false);
  assert.equal(isThirdPartyWidgetContainer(null, "cookies-policy-link"), false);
  assert.equal(isThirdPartyWidgetContainer(null, "consent-form"), false, "a real consent FORM (not a banner) must not be excluded");
});

test("isThirdPartyWidgetContainer: checks additional class tokens, not just the first", () => {
  assert.equal(isThirdPartyWidgetContainer(null, "hero-wrapper cookie-consent-banner"), true);
});

test("isThirdPartyWidgetContainer: null/empty id and className never crash and never match", () => {
  assert.equal(isThirdPartyWidgetContainer(null, null), false);
  assert.equal(isThirdPartyWidgetContainer(undefined, ""), false);
});

test("exceedsClipLimits: within all limits is false", () => {
  assert.equal(exceedsClipLimits(1722, 955), false);
});

test("exceedsClipLimits: matches the exact pathological tailwindcss.com whole-page clip already known to hang", () => {
  assert.equal(exceedsClipLimits(1722, 11605), true);
});

test("exceedsClipLimits: width, height, and area are each independently checked", () => {
  assert.equal(exceedsClipLimits(MAX_CLIP_WIDTH_PX + 1, 100), true);
  assert.equal(exceedsClipLimits(100, MAX_CLIP_HEIGHT_PX + 1), true);
  const w = MAX_CLIP_WIDTH_PX - 1;
  const h = Math.ceil(MAX_CLIP_AREA_PX2 / w) + 1;
  assert.ok(h <= MAX_CLIP_HEIGHT_PX, "test fixture must exercise the area check, not the height check");
  assert.equal(exceedsClipLimits(w, h), true);
});

test("exceedsClipLimits: exactly at the width or height limit (with the other dimension small, so area stays within budget) is NOT exceeding — matches cdp.mjs clipSizeError's own > not >=", () => {
  assert.equal(exceedsClipLimits(MAX_CLIP_WIDTH_PX, 100), false);
  assert.equal(exceedsClipLimits(100, MAX_CLIP_HEIGHT_PX), false);
});

test("planSectionAssignment: a normal page — first sizeable kid becomes hero, later sizeable kids become sections, in order", () => {
  const r = planSectionAssignment([300, 40, 150, 90]); // hero(300), too-small(40, skipped), section(150), section(90)
  assert.equal(r.heroIndex, 0);
  assert.deepEqual(r.sectionIndexes, [2, 3]);
  assert.equal(r.needsBodyFallback, false);
});

test("planSectionAssignment: everything too small for even a section — Fix 3's body fallback must fire", () => {
  const r = planSectionAssignment([10, 20, 5]);
  assert.equal(r.heroIndex, null);
  assert.deepEqual(r.sectionIndexes, []);
  assert.equal(r.needsBodyFallback, true);
});

test("planSectionAssignment: an empty kids array (no <main>/<body> children at all) — Fix 3's body fallback must fire", () => {
  const r = planSectionAssignment([]);
  assert.equal(r.needsBodyFallback, true);
});

test("planSectionAssignment: a single kid tall enough for hero — no fallback (hero counts as 'something tagged')", () => {
  const r = planSectionAssignment([250]);
  assert.equal(r.heroIndex, 0);
  assert.deepEqual(r.sectionIndexes, []);
  assert.equal(r.needsBodyFallback, false);
});

test("planSectionAssignment: boundary heights — exactly minHeightHero/minHeightSection both count (>=, not >)", () => {
  const r = planSectionAssignment([200, 80], { minHeightHero: 200, minHeightSection: 80 });
  assert.equal(r.heroIndex, 0);
  assert.deepEqual(r.sectionIndexes, [1]);
});

test("planSectionAssignment: only ONE hero is ever assigned, even if multiple kids clear the hero threshold", () => {
  const r = planSectionAssignment([300, 400, 90]);
  assert.equal(r.heroIndex, 0);
  assert.deepEqual(r.sectionIndexes, [1, 2], "the second 'hero-sized' kid still becomes a section, not a second hero");
});

test("SECTIONS_JS: contains the Fix 3 last-resort body fallback, gated so it can't fire alongside real tagging", () => {
  assert.match(SECTIONS_JS, /document\.body, 'section-1', 'section'/);
  assert.match(SECTIONS_JS, /!heroAssigned && sectionIdx === 0/);
});

test("SECTIONS_JS: contains the Fix 4 third-party widget denylist and applies it inside collectChildren", () => {
  assert.match(SECTIONS_JS, /isThirdPartyWidget/);
  assert.match(SECTIONS_JS, /hs-web-interactives/);
  assert.match(SECTIONS_JS, /cookie-\?consent-\?banner/);
  assert.match(SECTIONS_JS, /if \(isThirdPartyWidget\(el\)\) return false;/);
});

test("SECTIONS_JS: the oversized-hero drill uses cdp.mjs's ACTUAL MAX_CLIP_* values (interpolated, not a stale hand-copied number)", () => {
  assert.match(SECTIONS_JS, new RegExp(`w > ${MAX_CLIP_WIDTH_PX} `));
  assert.match(SECTIONS_JS, new RegExp(`h > ${MAX_CLIP_HEIGHT_PX} `));
  assert.match(SECTIONS_JS, new RegExp(`\\(w \\* h\\) > ${MAX_CLIP_AREA_PX2}`));
});

// --- Fix pass, Fix 1: nav-toggle vs dropdown-menu desktop-visibility split
// (pure decision logic). isRenderedGivenComputedStyle is a hand-synced
// parity copy of UX_JS's in-browser `isRenderedAtViewport` — the DOM
// observation itself (getComputedStyle/getBoundingClientRect) needs a real
// page and can only be proven live (see task-5-report.md's "Fix pass"
// section for the stripe.com/wpdev/elementor before/after proof); this pins
// the boolean logic those observations feed into.

test("isRenderedGivenComputedStyle: display:none means not rendered, regardless of size", () => {
  assert.equal(isRenderedGivenComputedStyle("none", "visible", "1", 40, 40), false);
});

test("isRenderedGivenComputedStyle: visibility:hidden means not rendered, regardless of size", () => {
  assert.equal(isRenderedGivenComputedStyle("block", "hidden", "1", 40, 40), false);
});

test("isRenderedGivenComputedStyle: opacity 0 means not rendered, regardless of size", () => {
  assert.equal(isRenderedGivenComputedStyle("block", "visible", "0", 40, 40), false);
});

test("isRenderedGivenComputedStyle: zero width or height means not rendered — this is what catches a HIDDEN ANCESTOR (a wrapper nav toggled by the same breakpoint), since a descendant's own computed display doesn't change when an ancestor is display:none", () => {
  assert.equal(isRenderedGivenComputedStyle("block", "visible", "1", 0, 40), false);
  assert.equal(isRenderedGivenComputedStyle("block", "visible", "1", 40, 0), false);
  assert.equal(isRenderedGivenComputedStyle("block", "visible", "1", 0, 0), false);
});

test("isRenderedGivenComputedStyle: a normal, visible, sized element (a real desktop mega-menu trigger) IS rendered", () => {
  assert.equal(isRenderedGivenComputedStyle("inline-block", "visible", "1", 64, 20), true);
});

// --- Fix pass, Fix 2: ux.json page-identity guard (pure decision logic) ---
// looksLikeSamePage's exact live-data proof (feeding it a real agent-browser
// `get url` reading against a genuinely blank tab vs the real captured page)
// is in task-5-report.md's "Fix pass" section; this pins the comparison
// rules themselves. Hostname-only (not hostname+pathname) is itself a live
// finding, not a design guess: an earlier pathname-checking version was
// proven live to false-positive on stripe.com's own "/" → "/en-my" locale
// redirect (see the regression test below) before being loosened.

test("looksLikeSamePage: identical URLs match", () => {
  assert.equal(looksLikeSamePage("https://stripe.com/", "https://stripe.com/"), true);
});

test("looksLikeSamePage: scheme, trailing slash, query string, and hash are all ignored", () => {
  assert.equal(looksLikeSamePage("http://stripe.com/pricing", "https://stripe.com/pricing/"), true);
  assert.equal(looksLikeSamePage("https://stripe.com/pricing/", "https://stripe.com/pricing"), true);
  assert.equal(looksLikeSamePage("https://stripe.com/pricing?utm_source=x", "https://stripe.com/pricing"), true);
  assert.equal(looksLikeSamePage("https://stripe.com/pricing#fees", "https://stripe.com/pricing"), true);
});

test("looksLikeSamePage: regression — a legitimate same-site locale redirect (stripe.com/ -> stripe.com/en-my, proven live) must NOT be flagged as a wrong page", () => {
  assert.equal(looksLikeSamePage("https://stripe.com/en-my", "https://stripe.com/"), true);
});

test("looksLikeSamePage: a different pathname on the same hostname is tolerated (redirects/canonicalization are not page mismatches)", () => {
  assert.equal(looksLikeSamePage("https://stripe.com/checkout", "https://stripe.com/pricing"), true);
});

test("looksLikeSamePage: a leading 'www.' is normalized away", () => {
  assert.equal(looksLikeSamePage("https://www.stripe.com/", "https://stripe.com/"), true);
  assert.equal(looksLikeSamePage("https://stripe.com/", "https://www.stripe.com/"), true);
});

test("looksLikeSamePage: the exact bug shape — a fresh 'about:blank' tab (empty hostname) never matches a real http(s) page", () => {
  assert.equal(looksLikeSamePage("about:blank", "https://stripe.com/"), false);
});

test("looksLikeSamePage: a genuinely different hostname never matches, even with an identical path", () => {
  assert.equal(looksLikeSamePage("https://evil.example/pricing", "https://stripe.com/pricing"), false);
});

test("looksLikeSamePage: unparseable input is treated as a mismatch (conservative default), not thrown", () => {
  assert.equal(looksLikeSamePage("not a url", "https://stripe.com/"), false);
  assert.equal(looksLikeSamePage("https://stripe.com/", "not a url"), false);
});

test("looksLikeSamePage: null/undefined/empty inputs never match", () => {
  assert.equal(looksLikeSamePage(null, "https://stripe.com/"), false);
  assert.equal(looksLikeSamePage("https://stripe.com/", undefined), false);
  assert.equal(looksLikeSamePage("", "https://stripe.com/"), false);
  assert.equal(looksLikeSamePage("https://stripe.com/", ""), false);
});

// --- Task 7b: content.json gains tables/definitionLists/labelValuePairs ---
// buildTableModel, buildDefinitionListPairs, and matchLabelValuePair are
// hand-synced parity copies of the corresponding in-browser builders inside
// CONTENT_JS (same "can't literally import into an eval'd string"
// constraint as accentScore/isRenderedGivenComputedStyle above) — these
// tests pin the DECISION logic (row/pair classification, anti-noise gating)
// on plain data; the DOM traversal that feeds them (querySelectorAll,
// childNodes, closest) can only be proven live against a real page (see
// task-7b-report.md for the barefootbuttons.com/Wikipedia proof).
const th = (t) => ({ tag: "TH", text: t });
const td = (t) => ({ tag: "TD", text: t });

test("buildTableModel: WooCommerce shape — one <th> label + <td> value per row, no dedicated header row — still yields pairs", () => {
  const model = buildTableModel([
    [th("Color"), td("Black")],
    [th("Size"), td("Large")],
  ]);
  assert.deepEqual(model, {
    headers: [],
    rows: [
      ["Color", "Black"],
      ["Size", "Large"],
    ],
    pairs: [
      { label: "Color", value: "Black" },
      { label: "Size", value: "Large" },
    ],
  });
});

test("buildTableModel: a real column-header row (every cell <th>) is excluded from rows, and 2-col data rows still become pairs", () => {
  const model = buildTableModel([
    [th("Spec"), th("Value")],
    [td("Weight"), td("1.2kg")],
  ]);
  assert.deepEqual(model, {
    headers: ["Spec", "Value"],
    rows: [["Weight", "1.2kg"]],
    pairs: [{ label: "Weight", value: "1.2kg" }],
  });
});

test("buildTableModel: a 3+ column comparison/pricing table keeps headers+rows but does NOT collapse to pairs", () => {
  const model = buildTableModel([
    [th("Plan"), th("Storage"), th("Price")],
    [td("Basic"), td("10GB"), td("$5")],
    [td("Pro"), td("100GB"), td("$15")],
  ]);
  assert.deepEqual(model.headers, ["Plan", "Storage", "Price"]);
  assert.deepEqual(model.rows, [
    ["Basic", "10GB", "$5"],
    ["Pro", "100GB", "$15"],
  ]);
  assert.equal(model.pairs, null, "column 0 isn't reliably 'the label' once there are 3+ columns");
});

test("buildTableModel: irregular row lengths (not every row has exactly 2 cells) must not produce pairs", () => {
  const model = buildTableModel([
    [td("A"), td("B")],
    [td("C"), td("D"), td("E")],
  ]);
  assert.deepEqual(model.rows, [
    ["A", "B"],
    ["C", "D", "E"],
  ]);
  assert.equal(model.pairs, null);
});

test("buildTableModel: an empty rowsCells (no <tr> at all) returns null, not a crash", () => {
  assert.equal(buildTableModel([]), null);
});

test("buildTableModel: every cell text empty (a layout/spacer table) returns null rather than a hollow entry", () => {
  assert.equal(buildTableModel([[td(""), td("")]]), null);
});

test("buildTableModel: a row with zero cells (empty <tr>) is skipped, not treated as a header row or a data row", () => {
  const model = buildTableModel([[], [td("A"), td("B")]]);
  assert.deepEqual(model.rows, [["A", "B"]]);
  assert.deepEqual(model.pairs, [{ label: "A", value: "B" }]);
});

test("buildTableModel: only the FIRST all-<th> row becomes headers; a later all-<th> row is left as an ordinary data row", () => {
  const model = buildTableModel([
    [th("A"), th("B")],
    [th("C"), th("D")],
    [td("E"), td("F")],
  ]);
  assert.deepEqual(model.headers, ["A", "B"]);
  assert.deepEqual(model.rows, [
    ["C", "D"],
    ["E", "F"],
  ]);
});

test("buildTableModel: a header-only table (no data rows) has empty rows and null pairs, not []", () => {
  const model = buildTableModel([[th("A"), th("B")]]);
  assert.deepEqual(model.headers, ["A", "B"]);
  assert.deepEqual(model.rows, []);
  assert.equal(model.pairs, null, "zero data rows must not report pairs: []  (vacuous .every() true would otherwise fake a 'pairs' of nothing)");
});

test("buildTableModel: a 1-column table (single cell per row) is preserved as rows but never becomes pairs", () => {
  const model = buildTableModel([[td("Only cell")], [td("Another")]]);
  assert.deepEqual(model.rows, [["Only cell"], ["Another"]]);
  assert.equal(model.pairs, null);
});

const dt = (t) => ({ tag: "DT", text: t });
const dd = (t) => ({ tag: "DD", text: t });

test("buildDefinitionListPairs: simple one-dt-one-dd pairs, in order", () => {
  assert.deepEqual(buildDefinitionListPairs([dt("SKU"), dd("BB-123"), dt("Weight"), dd("1.2kg")]), {
    pairs: [
      { label: "SKU", value: "BB-123" },
      { label: "Weight", value: "1.2kg" },
    ],
  });
});

test("buildDefinitionListPairs: a <dt> followed by multiple <dd> joins them into one comma-separated value", () => {
  assert.deepEqual(buildDefinitionListPairs([dt("Color"), dd("Red"), dd("Blue"), dd("Green")]), {
    pairs: [{ label: "Color", value: "Red, Blue, Green" }],
  });
});

test("buildDefinitionListPairs: a stray <dd> with no preceding <dt> (malformed markup) is dropped, not crashed on or attached to nothing", () => {
  assert.deepEqual(buildDefinitionListPairs([dd("orphan"), dt("SKU"), dd("BB-123")]), {
    pairs: [{ label: "SKU", value: "BB-123" }],
  });
});

test("buildDefinitionListPairs: a <dt> with no following <dd> at all contributes nothing (no value to pair it with)", () => {
  assert.deepEqual(buildDefinitionListPairs([dt("Orphaned label"), dt("SKU"), dd("BB-123")]), {
    pairs: [{ label: "SKU", value: "BB-123" }],
  });
});

test("buildDefinitionListPairs: an empty <dl> (no dt/dd at all) returns null, not a crash or {pairs: []}", () => {
  assert.equal(buildDefinitionListPairs([]), null);
});

test("matchLabelValuePair: flat shape — label and value in the same text node ('Model Number: ABC-123')", () => {
  assert.deepEqual(matchLabelValuePair("Model Number: ABC-123", "Model Number: ABC-123", 0, ""), {
    label: "Model Number",
    value: "ABC-123",
  });
});

test("matchLabelValuePair: WooCommerce nested-child shape — 'SKU: ' as own text (trailing space trimmed away upstream), value in the single child span", () => {
  assert.deepEqual(matchLabelValuePair("SKU:", "SKU: BB-123", 1, "BB-123"), {
    label: "SKU",
    value: "BB-123",
  });
});

test("matchLabelValuePair: nested-child shape also matches when the trailing space survives ('SKU: ' verbatim)", () => {
  assert.deepEqual(matchLabelValuePair("SKU: ", "SKU: BB-123", 1, "BB-123"), {
    label: "SKU",
    value: "BB-123",
  });
});

test("matchLabelValuePair: the colon-with-no-space full-text variant is also accepted ('SKU:BB-123')", () => {
  assert.deepEqual(matchLabelValuePair("SKU:BB-123", "SKU:BB-123", 0, ""), {
    label: "SKU",
    value: "BB-123",
  });
});

test("matchLabelValuePair: a colon INSIDE the value doesn't break matching — only the first colon separates label from value ('Ratio: 16:9')", () => {
  assert.deepEqual(matchLabelValuePair("Ratio: 16:9", "Ratio: 16:9", 0, ""), {
    label: "Ratio",
    value: "16:9",
  });
});

test("matchLabelValuePair: no colon at all is never a match", () => {
  assert.equal(matchLabelValuePair("Just some text", "Just some text", 0, ""), null);
});

test("matchLabelValuePair: a label starting with a digit is rejected (conservative — real labels are words)", () => {
  assert.equal(matchLabelValuePair("3D Model: Yes", "3D Model: Yes", 0, ""), null);
});

test("matchLabelValuePair: label length boundary — 30 chars (1 + 29) is accepted, 31 is rejected", () => {
  const label30 = "A" + "b".repeat(29);
  assert.equal(label30.length, 30);
  assert.deepEqual(matchLabelValuePair(`${label30}: x`, `${label30}: x`, 0, ""), { label: label30, value: "x" });

  const label31 = "A" + "b".repeat(30);
  assert.equal(matchLabelValuePair(`${label31}: x`, `${label31}: x`, 0, ""), null);
});

test("matchLabelValuePair: value length boundary — 200 chars is accepted, 201 is rejected (guards against matching a run of body copy)", () => {
  const value200 = "x".repeat(200);
  assert.deepEqual(matchLabelValuePair(`Note: ${value200}`, `Note: ${value200}`, 0, ""), {
    label: "Note",
    value: value200,
  });

  const value201 = "x".repeat(201);
  assert.equal(matchLabelValuePair(`Note: ${value201}`, `Note: ${value201}`, 0, ""), null);
});

test("matchLabelValuePair: no inline value and zero children (a bare 'Status:' with nothing after it) is rejected, not a phantom empty value", () => {
  assert.equal(matchLabelValuePair("Status:", "Status:", 0, ""), null);
});

test("matchLabelValuePair: no inline value and MORE than one child (ambiguous which child is 'the' value) is rejected", () => {
  assert.equal(matchLabelValuePair("Tags:", "Tags:ABC", 2, "ignored"), null);
});

test("matchLabelValuePair: extra content beyond label+value in the full text is rejected — the anti-noise gate for a component whose leading text merely contains a colon", () => {
  assert.equal(
    matchLabelValuePair("Note: short", "Note: short — but there is a lot more prose in this wrapper too", 0, ""),
    null,
  );
});

test("matchLabelValuePair: empty ownText never matches", () => {
  assert.equal(matchLabelValuePair("", "", 0, ""), null);
  assert.equal(matchLabelValuePair(null, "", 0, ""), null);
});

// ---------------------------------------------------------------------------
// Fix 4: checkUrlStatus — pre-flight HTTP status check, no browser needed.
// agent-browser's `open` exits 0 on a themed 404 (the tab loads fine, it's
// just wrong content), so nothing else in this file ever notices a dead URL
// before it's captured as if real. `fetchImpl` is an injection seam
// (default: the real global fetch) — same DI pattern as ab()'s `spawnFn`
// above, so the decision logic is pinned fast/deterministically here, and a
// real local node:http server (below) proves the default wiring for real.
// ---------------------------------------------------------------------------

function makeFetchStub(statusFor) {
  // statusFor(url, opts) -> status code (number) | throws
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, redirect: opts.redirect });
    const status = await statusFor(url, opts);
    return { status, ok: status >= 200 && status < 300 };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("checkUrlStatus: a 200 HEAD response is ok, and no second request is ever made", async () => {
  const fetchImpl = makeFetchStub(() => 200);
  const result = await checkUrlStatus("https://x.com/about", { fetchImpl });
  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, "HEAD");
  assert.equal(fetchImpl.calls[0].redirect, "follow", "a redirecting URL must still resolve to its final status");
});

test("checkUrlStatus: a 404 HEAD response is NOT ok — and, unlike 405, never falls back to GET (it's a real dead link, not a HEAD-support issue)", async () => {
  const fetchImpl = makeFetchStub(() => 404);
  const result = await checkUrlStatus("https://x.com/gone", { fetchImpl });
  assert.deepEqual(result, { ok: false, status: 404 });
  assert.equal(fetchImpl.calls.length, 1);
});

test("checkUrlStatus: a 500 HEAD response is NOT ok", async () => {
  const fetchImpl = makeFetchStub(() => 500);
  assert.deepEqual(await checkUrlStatus("https://x.com/broken", { fetchImpl }), { ok: false, status: 500 });
});

test("checkUrlStatus: a server that rejects HEAD (405) falls back to a ranged GET — a live page correctly reports ok", async () => {
  const fetchImpl = makeFetchStub((url, opts) => (opts.method === "HEAD" ? 405 : 200));
  const result = await checkUrlStatus("https://x.com/head-unsupported", { fetchImpl });
  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(fetchImpl.calls.length, 2, "HEAD, then the GET fallback");
  assert.equal(fetchImpl.calls[1].method, "GET");
  assert.equal(fetchImpl.calls[1].headers.Range, "bytes=0-0", "the GET fallback must still avoid pulling the full body");
});

test("checkUrlStatus: a server that rejects HEAD (405) AND is genuinely dead on the GET fallback correctly reports NOT ok", async () => {
  const fetchImpl = makeFetchStub((url, opts) => (opts.method === "HEAD" ? 405 : 404));
  assert.deepEqual(await checkUrlStatus("https://x.com/really-gone", { fetchImpl }), { ok: false, status: 404 });
});

test("checkUrlStatus: a network error/timeout (fetch throws) is NOT ok, with the error surfaced, not swallowed into a bare false", async () => {
  const fetchImpl = async () => {
    throw new Error("fetch failed: ECONNREFUSED");
  };
  const result = await checkUrlStatus("https://x.com/unreachable", { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.error, /ECONNREFUSED/);
});

test("checkUrlStatus: real HTTP round-trip via a local node:http server — 200, 404, and the HEAD->405->ranged-GET fallback, using the REAL default fetch (no DI)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fine");
    } else if (req.url === "/head-blocked") {
      if (req.method === "HEAD") {
        res.writeHead(405);
        res.end();
      } else {
        res.writeHead(206, { "content-range": "bytes 0-0/4" });
        res.end("f");
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await checkUrlStatus(`${base}/ok`), { ok: true, status: 200 });
    assert.deepEqual(await checkUrlStatus(`${base}/missing`), { ok: false, status: 404 });
    const headBlocked = await checkUrlStatus(`${base}/head-blocked`);
    assert.equal(headBlocked.ok, true, "the ranged-GET fallback must succeed against a real server that 405s HEAD");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Fix 4: capture() wiring — a non-2xx pre-flight status check must trigger
// the SAME fallback machinery a captureOne browser failure does, not a
// separate, reinvented path. `checkStatus`/`captureOneImpl` are injection
// seams (default: the real checkUrlStatus / the real agent-browser-driving
// captureOne), so this proves the ORCHESTRATION — not just the standalone
// status-check helper above — without a real browser.
// ---------------------------------------------------------------------------

test("capture(): a non-2xx pre-flight status check on a sample fails over to its spare via the existing fallback pool, and replaceSample still fires", withSilencedStderr(async () => {
  const { runDir, cleanup } = await mkRun("status-check-site", {
    "pagetypes.json": pagetypes([
      {
        name: "posts",
        kind: "single:post",
        pattern: "/blog/*",
        confidence: "fingerprint",
        members: ["https://x.com/blog/dead", "https://x.com/blog/spare"],
        samples: ["https://x.com/blog/dead"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    const checkStatus = async (url) =>
      url === "https://x.com/blog/dead" ? { ok: false, status: 404 } : { ok: true, status: 200 };
    const captureOneImpl = async ({ url, slug }) => ({ slug, url, sectionCount: 3 });

    const r = await capture({
      site: "status-check-site",
      runsDir: path.join(runDir, ".."),
      checkStatus,
      captureOneImpl,
    });
    assert.equal(r.count, 1);
    assert.equal(r.ok, 1, "the dead sample must fail OVER to its spare, not be recorded as a hard failure");
    assert.equal(r.results[0].url, "https://x.com/blog/spare");

    const pt = JSON.parse(await readFile(path.join(runDir, "pagetypes.json"), "utf8"));
    assert.deepEqual(
      pt.types[0].samples,
      ["https://x.com/blog/spare"],
      "replaceSample must still fire on a status-check-triggered fallback, exactly as it does for a captureOne failure",
    );
  } finally {
    await cleanup();
  }
}));

test("capture(): every candidate failing its status check (sample + spares exhausted) records ok:false with the status error — captureOneImpl never runs at all", withSilencedStderr(async () => {
  const { runDir, cleanup } = await mkRun("status-check-all-dead-site", {
    "pagetypes.json": pagetypes([
      {
        name: "posts",
        kind: "single:post",
        pattern: "/blog/*",
        confidence: "fingerprint",
        members: ["https://x.com/blog/dead-1", "https://x.com/blog/dead-2"],
        samples: ["https://x.com/blog/dead-1"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    let captureOneCalls = 0;
    const checkStatus = async () => ({ ok: false, status: 404 });
    const captureOneImpl = async (args) => {
      captureOneCalls += 1;
      return { ...args, sectionCount: 1 };
    };
    const r = await capture({
      site: "status-check-all-dead-site",
      runsDir: path.join(runDir, ".."),
      checkStatus,
      captureOneImpl,
    });
    assert.equal(r.ok, 0);
    assert.equal(r.count, 1);
    assert.match(r.results[0].error, /pre-flight status check failed/);
    assert.match(r.results[0].error, /404/);
    assert.equal(captureOneCalls, 0, "a page that never passes its status check must never reach the browser at all");
  } finally {
    await cleanup();
  }
}));

test("capture(): a healthy status check lets captureOneImpl run normally for every untyped page (v2 fallback shape)", withSilencedStderr(async () => {
  const { runDir, cleanup } = await mkRun("status-check-healthy-site", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about"]),
  });
  try {
    const checkStatus = async () => ({ ok: true, status: 200 });
    const captureOneImpl = async ({ url, slug }) => ({ slug, url, sectionCount: 2 });
    const r = await capture({
      site: "status-check-healthy-site",
      runsDir: path.join(runDir, ".."),
      checkStatus,
      captureOneImpl,
    });
    assert.equal(r.ok, 2);
    assert.equal(r.count, 2);
  } finally {
    await cleanup();
  }
}));

// --- Fix 1a: isBrowserDeathError — the crash/hang detector --------------
// Every string below is a REAL error observed live in this task's before-
// fix repro (and the earlier dogfood run) against smittenkitchen.com — see
// .superpowers/sdd/dogfood-a1-report.md and this task's own report.

test("isBrowserDeathError: matches the exact 'CDP response channel closed' crash-moment error observed live", () => {
  assert.equal(isBrowserDeathError(new Error("agent-browser exited 1: ✗ CDP response channel closed")), true);
});

test("isBrowserDeathError: matches the exact 'Auto-launch failed ... Connection refused' error observed for every page after a crash", () => {
  const msg =
    "agent-browser exited 1: ✗ Auto-launch failed: All CDP discovery methods failed for 127.0.0.1:9223: " +
    "/json/version: Failed to connect to CDP at 127.0.0.1:9223: error sending request for url (http://127.0.0.1:9223/json/version); " +
    "/json/list: Failed to connect to /json/list at 127.0.0.1:9223: error sending request for url (http://127.0.0.1:9223/json/list); " +
    "WebSocket: WebSocket connect failed at ws://127.0.0.1:9223/devtools/browser: IO error: Connection refused (os error 61)";
  assert.equal(isBrowserDeathError(new Error(msg)), true);
});

test("isBrowserDeathError: does NOT match agent-browser's ordinary 'Operation timed out' message (a healthy browser, a slow/missing selector)", () => {
  assert.equal(
    isBrowserDeathError(
      new Error("agent-browser exited 1: ✗ Operation timed out. The page may still be loading or the element may not exist."),
    ),
    false,
  );
});

test("isBrowserDeathError: does NOT match an ordinary dead-link/status error", () => {
  assert.equal(isBrowserDeathError(new Error("pre-flight status check failed for https://x.com/: HTTP 404")), false);
});

test("isBrowserDeathError: our OWN ab() timeout marker (err.timedOut) counts, independent of message text", () => {
  const err = Object.assign(new Error("agent-browser open https://x.com/ timed out after 60000ms and was killed"), {
    timedOut: true,
  });
  assert.equal(isBrowserDeathError(err), true);
});

test("isBrowserDeathError: an ECONNREFUSED nested in err.cause (our OWN raw-CDP fetch failure shape) is still detected", () => {
  const cause = new Error("connect ECONNREFUSED 127.0.0.1:9223");
  cause.code = "ECONNREFUSED";
  const err = new Error("fetch failed");
  err.cause = cause;
  assert.equal(isBrowserDeathError(err), true);
});

test("isBrowserDeathError: null/undefined never throws or matches", () => {
  assert.equal(isBrowserDeathError(null), false);
  assert.equal(isBrowserDeathError(undefined), false);
});

// --- Fix 1a: capture() browser-death detection, recovery, and fail-fast ---
// orchestration. Mirrors the existing checkStatus/captureOneImpl injection
// pattern above (mkRun fixtures, withSilencedStderr, no real browser).

test("capture(): a browser-death error triggers ONE recovery attempt and retries the SAME url (not a spare) when recovery succeeds", withSilencedStderr(async () => {
  const { runDir, cleanup } = await mkRun("recover-site", {
    "pagetypes.json": pagetypes([
      {
        name: "posts",
        kind: "single:post",
        pattern: "/blog/*",
        confidence: "fingerprint",
        members: ["https://x.com/blog/a", "https://x.com/blog/spare"],
        samples: ["https://x.com/blog/a"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    let calls = 0;
    const seenUrls = [];
    const captureOneImpl = async ({ url, slug }) => {
      calls += 1;
      seenUrls.push(url);
      if (calls === 1) throw new Error("agent-browser exited 1: ✗ CDP response channel closed");
      return { slug, url, sectionCount: 1 };
    };
    let recoverCalls = 0;
    const recoverBrowser = async () => {
      recoverCalls += 1;
      return true;
    };
    const probeBrowser = async () => {
      throw new Error("must not be called — browser was never confirmed down");
    };

    const r = await capture({
      site: "recover-site",
      runsDir: path.join(runDir, ".."),
      checkStatus: async () => ({ ok: true, status: 200 }),
      captureOneImpl,
      recoverBrowser,
      probeBrowser,
    });
    assert.equal(r.ok, 1);
    assert.equal(calls, 2, "captureOneImpl must be retried after a successful recovery");
    assert.equal(recoverCalls, 1);
    assert.deepEqual(seenUrls, ["https://x.com/blog/a", "https://x.com/blog/a"], "recovery retries the ORIGINAL url, never consumes the spare");
    assert.equal(r.results[0].url, "https://x.com/blog/a");
  } finally {
    await cleanup();
  }
}));

test("capture(): when browser recovery fails, the entry falls through to its existing spare-fallback pool instead of retrying forever", withSilencedStderr(async () => {
  const { runDir, cleanup } = await mkRun("recover-fail-site", {
    "pagetypes.json": pagetypes([
      {
        name: "posts",
        kind: "single:post",
        pattern: "/blog/*",
        confidence: "fingerprint",
        members: ["https://x.com/blog/a", "https://x.com/blog/spare"],
        samples: ["https://x.com/blog/a"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    const captureOneImpl = async ({ url, slug }) => {
      if (url === "https://x.com/blog/a") {
        throw new Error("agent-browser exited 1: ✗ CDP response channel closed");
      }
      return { slug, url, sectionCount: 1 };
    };
    let recoverCalls = 0;
    const recoverBrowser = async () => {
      recoverCalls += 1;
      return false;
    };
    const probeBrowser = async () => true;

    const r = await capture({
      site: "recover-fail-site",
      runsDir: path.join(runDir, ".."),
      checkStatus: async () => ({ ok: true, status: 200 }),
      captureOneImpl,
      recoverBrowser,
      probeBrowser,
    });
    assert.equal(r.ok, 1, "must still succeed via the spare, even though recovery for the primary sample failed");
    assert.equal(recoverCalls, 1, "recovery is attempted exactly once per entry, not once per spare retry");
    assert.equal(r.results[0].url, "https://x.com/blog/spare");
  } finally {
    await cleanup();
  }
}));

test("capture(): once the browser is confirmed down, later entries are cheaply probed (not fully retried) until it comes back", withSilencedStderr(async () => {
  // Directly models the dogfood's actual observed cascade: capture crashes
  // on the FIRST page, then every remaining page in a 10-page run failed
  // identically with "Connection refused" — 0/10, exit 0. This proves the
  // fix's fail-fast-then-eventually-resume behavior against a 4-page
  // worklist: page-1 crashes and can't recover, page-2/page-3 are skipped
  // via a cheap probe (captureOneImpl never even called for them), page-4's
  // probe reports the browser back up and it captures normally.
  const { runDir, cleanup } = await mkRun("cascade-site", {
    "pagetypes.json": pagetypes([], [
      "https://x.com/page-1",
      "https://x.com/page-2",
      "https://x.com/page-3",
      "https://x.com/page-4",
    ]),
  });
  try {
    let captureOneCalls = 0;
    const captureOneImpl = async ({ url, slug }) => {
      captureOneCalls += 1;
      if (url === "https://x.com/page-1") {
        throw new Error("agent-browser exited 1: ✗ CDP response channel closed");
      }
      return { slug, url, sectionCount: 1 };
    };
    const recoverBrowser = async () => false; // recovery never works this run
    let probeCalls = 0;
    const probeReturns = [false, false, true]; // page-2: still down, page-3: still down, page-4: back up
    const probeBrowser = async () => probeReturns[probeCalls++] ?? true;

    const r = await capture({
      site: "cascade-site",
      runsDir: path.join(runDir, ".."),
      checkStatus: async () => ({ ok: true, status: 200 }),
      captureOneImpl,
      recoverBrowser,
      probeBrowser,
    });

    assert.equal(r.count, 4);
    assert.equal(r.ok, 1, "only page-4 (once the probe reports the browser back up) succeeds");
    assert.deepEqual(r.results.map((x) => x.ok), [false, false, false, true]);
    assert.equal(probeCalls, 3, "page-2 and page-3 are cheaply probed while down; page-4's probe reports it back up");
    assert.equal(
      captureOneCalls,
      2,
      "captureOneImpl runs for page-1 (discovers the crash) and page-4 (browser confirmed back up) only — " +
        "page-2/page-3 must be skipped without ever reaching captureOneImpl",
    );
    assert.match(r.results[1].error, /unreachable/);
    assert.match(r.results[2].error, /unreachable/);
    // Never a false success and never a bare, uninformative message.
    assert.equal(r.results[0].error, "agent-browser exited 1: ✗ CDP response channel closed");
  } finally {
    await cleanup();
  }
}));

test("capture(): an ordinary captureOneImpl failure (not browser-death-shaped) never triggers recovery — falls straight to the existing spare-fallback path", withSilencedStderr(async () => {
  const { runDir, cleanup } = await mkRun("ordinary-fail-site", {
    "pagetypes.json": pagetypes([
      {
        name: "posts",
        kind: "single:post",
        pattern: "/blog/*",
        confidence: "fingerprint",
        members: ["https://x.com/blog/a", "https://x.com/blog/spare"],
        samples: ["https://x.com/blog/a"],
        archiveUrl: null,
      },
    ]),
  });
  try {
    const captureOneImpl = async ({ url, slug }) => {
      if (url === "https://x.com/blog/a") {
        throw new Error(
          "agent-browser exited 1: ✗ Operation timed out. The page may still be loading or the element may not exist.",
        );
      }
      return { slug, url, sectionCount: 1 };
    };
    // Counters, NOT throwing stubs: capture() wraps the recoverBrowser call
    // in its own try/catch (a throw from recovery must never crash the
    // run — see capture()'s doc comment), which would silently swallow a
    // "must not be called" throw and let a wrongly-invoked mock hide behind
    // an otherwise-correct-looking result. Counting catches that a throwing
    // stub cannot (proven directly below via mutation: dropping capture()'s
    // `phase === "capture"` gate makes THIS assertion fail while the
    // outcome-shape assertions below keep passing).
    let recoverCalls = 0;
    let probeCalls = 0;
    const recoverBrowser = async () => {
      recoverCalls += 1;
      return false;
    };
    const probeBrowser = async () => {
      probeCalls += 1;
      return false;
    };

    const r = await capture({
      site: "ordinary-fail-site",
      runsDir: path.join(runDir, ".."),
      checkStatus: async () => ({ ok: true, status: 200 }),
      captureOneImpl,
      recoverBrowser,
      probeBrowser,
    });
    assert.equal(r.ok, 1);
    assert.equal(r.results[0].url, "https://x.com/blog/spare");
    assert.equal(recoverCalls, 0, "an ordinary (non-browser-death) failure must never attempt recovery");
    assert.equal(probeCalls, 0, "the browser must never be marked down for an ordinary failure, so nothing gets probed");
  } finally {
    await cleanup();
  }
}));

test("capture(): a pre-flight status-check failure is NEVER treated as browser death, even when its error text mentions connection refused (a dead TARGET SITE, not our own browser)", withSilencedStderr(async () => {
  const { runDir, cleanup } = await mkRun("dead-site-site", {
    "pagetypes.json": pagetypes([], ["https://x.com/dead"]),
  });
  try {
    const checkStatus = async () => ({ ok: false, status: null, error: "connect ECONNREFUSED 203.0.113.5:443" });
    // Counters, not throwing stubs — see the sibling "ordinary failure" test
    // above for why a throw here can be silently swallowed by capture()'s
    // own defensive try/catch around recoverBrowser, hiding a wrongly
    // phase-scoped call behind an otherwise-correct-looking failed result.
    let recoverCalls = 0;
    let probeCalls = 0;
    const recoverBrowser = async () => {
      recoverCalls += 1;
      return false;
    };
    const probeBrowser = async () => {
      probeCalls += 1;
      return false;
    };
    const captureOneImpl = async () => {
      throw new Error("must never be reached — status check failed first");
    };

    const r = await capture({
      site: "dead-site-site",
      runsDir: path.join(runDir, ".."),
      checkStatus,
      captureOneImpl,
      recoverBrowser,
      probeBrowser,
    });
    assert.equal(r.ok, 0);
    assert.match(r.results[0].error, /pre-flight status check failed/);
    assert.equal(recoverCalls, 0, "a status-check failure (even one that SAYS 'connection refused') must never attempt browser recovery");
    assert.equal(probeCalls, 0, "the browser must never be marked down from a status-check failure alone");
  } finally {
    await cleanup();
  }
}));
