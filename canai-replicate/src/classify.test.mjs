// classify.mjs had ZERO direct tests before this file (Fix 3, whole-branch
// review) — its pure helpers live in cluster.mjs (well covered elsewhere),
// but classify() itself (archiveUrl derivation, the four `confidence`
// values, the off-origin redirect guard, the final-URL dedup, and the
// order-preserving `mapPool`) had none. The reviewer proved live that
// mutating `mapPool` to return COMPLETION order instead of INPUT order —
// exactly the regression its own doc comment exists to prevent — passed all
// 213 pre-existing tests: `fetched[i]` then corresponds to a different URL
// than `oneOffs[i]`, so pages get clustered by OTHER pages' DOM
// fingerprints, producing a well-formed but silently WRONG pagetypes.json.
//
// No network, no npm deps: every fetch-dependent test here drives a real
// `node:http` server on 127.0.0.1 (ephemeral port), per this task's
// requirement — deterministic fixtures, zero external dependencies.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify, mapPool, fetchHtml, buildPrompt } from "./classify.mjs";

// --- fixtures ---------------------------------------------------------------

async function mkRun(site, files) {
  const root = await mkdtemp(path.join(tmpdir(), "classify-test-"));
  const runDir = path.join(root, "runs", site);
  await mkdir(runDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await writeFile(path.join(runDir, name), JSON.stringify(data, null, 2));
  }
  return { runDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function pagesJson(urls) {
  return { site: "test-site", pages: urls.map((url) => ({ url, source: "sitemap" })) };
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

// Minimal routes-table HTTP server. `routes`: Map<pathname, entry> where
// entry is one of:
//   { body, status?, delayMs? }      — a normal (optionally delayed) response
//   { redirectTo, status? }          — a 302 (or given status) redirect;
//                                       redirectTo may be relative (same-
//                                       origin) or absolute (cross-origin)
// Anything not in the table 404s.
function startServer(routes) {
  const server = http.createServer((req, res) => {
    const entry = routes.get(req.url);
    if (!entry) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const respond = () => {
      if (entry.redirectTo) {
        res.writeHead(entry.status || 302, { Location: entry.redirectTo });
        res.end();
        return;
      }
      res.writeHead(entry.status || 200, { "content-type": "text/html" });
      res.end(entry.body || "");
    };
    if (entry.delayMs) setTimeout(respond, entry.delayMs);
    else respond();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({ port, origin, url: (p) => origin + p, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---------------------------------------------------------------------------
// mapPool — pure, no server needed. This is the direct, fast, deterministic
// mutation target: the reviewer's exact regression (completion order instead
// of input order) must fail THIS test.
// ---------------------------------------------------------------------------

test("mapPool: results settle in INPUT order regardless of completion order (adversarial timing) — MUST fail if results are returned in completion order", async () => {
  const items = [50, 30, 10, 0]; // ms delay; item 0 is slowest, item 3 fastest
  const completionOrder = [];
  const results = await mapPool(items, items.length, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    completionOrder.push(i);
    return `item-${i}`;
  });
  assert.deepEqual(results, ["item-0", "item-1", "item-2", "item-3"], "must be INPUT order, not completion order");
  assert.deepEqual(completionOrder, [3, 2, 1, 0], "sanity check: completion really did happen out of order here");
});

test("mapPool: order preservation holds when concurrency < item count (a single worker recycles across multiple indices)", async () => {
  const items = [30, 0, 20, 0, 10]; // limit=2 forces at least one worker to pick up a second (and third) item
  const results = await mapPool(items, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `item-${i}`;
  });
  assert.deepEqual(results, ["item-0", "item-1", "item-2", "item-3", "item-4"]);
});

test("mapPool: an empty items array resolves to an empty array immediately, fn is never called", async () => {
  const results = await mapPool([], 6, async () => {
    throw new Error("must never be called for an empty input");
  });
  assert.deepEqual(results, []);
});

test("mapPool: limit larger than the item count is fine — never spawns more workers than items", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const items = [1, 2, 3];
  await mapPool(items, 50, async (n) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent--;
    return n;
  });
  assert.equal(maxConcurrent, 3, "only 3 workers for 3 items, even though limit=50");
});

// ---------------------------------------------------------------------------
// fetchHtml — pure-ish network helper (real local server, no mocking).
// ---------------------------------------------------------------------------

test("fetchHtml: a 200 response returns { html, finalUrl }", async () => {
  const server = await startServer(new Map([["/ok", { body: "<html><body>hi</body></html>" }]]));
  try {
    const result = await fetchHtml(server.url("/ok"));
    assert.equal(result.html, "<html><body>hi</body></html>");
    assert.equal(result.finalUrl, server.url("/ok"));
  } finally {
    await server.close();
  }
});

test("fetchHtml: a non-2xx status is unfetchable (null), not a throw", async () => {
  const server = await startServer(new Map([["/missing", { status: 404, body: "not found" }]]));
  try {
    assert.equal(await fetchHtml(server.url("/missing")), null);
  } finally {
    await server.close();
  }
});

test("fetchHtml: a network error (nothing listening on the port) is unfetchable (null), not a throw", async () => {
  const server = await startServer(new Map());
  const { port } = server;
  await server.close();
  assert.equal(await fetchHtml(`http://127.0.0.1:${port}/anything`), null);
});

test("fetchHtml: off-origin redirect guard — a fetch that redirects OFF the given origin is unfetchable (null)", async () => {
  const evil = await startServer(new Map([["/landing", { body: "evil" }]]));
  const main = await startServer(new Map([["/redirect", { redirectTo: evil.url("/landing") }]]));
  try {
    const result = await fetchHtml(main.url("/redirect"), { origin: main.origin });
    assert.equal(result, null, "landing off the given origin must be treated as unfetchable");
  } finally {
    await main.close();
    await evil.close();
  }
});

test("fetchHtml: a same-origin redirect is fine — {origin} only rejects a DIFFERENT origin", async () => {
  const server = await startServer(
    new Map([
      ["/old", { redirectTo: "/new" }],
      ["/new", { body: "<html>new</html>" }],
    ]),
  );
  try {
    const result = await fetchHtml(server.url("/old"), { origin: server.origin });
    assert.ok(result);
    assert.equal(result.html, "<html>new</html>");
    assert.equal(result.finalUrl, server.url("/new"));
  } finally {
    await server.close();
  }
});

test("fetchHtml: with NO {origin} option at all, an off-origin redirect is not rejected (the guard is opt-in)", async () => {
  const evil = await startServer(new Map([["/landing", { body: "evil" }]]));
  const main = await startServer(new Map([["/redirect", { redirectTo: evil.url("/landing") }]]));
  try {
    const result = await fetchHtml(main.url("/redirect"));
    assert.ok(result, "without an origin to compare against, an off-site redirect is not rejected");
    assert.equal(result.html, "evil");
  } finally {
    await main.close();
    await evil.close();
  }
});

// ---------------------------------------------------------------------------
// classify() end-to-end — the four `confidence` values.
// ---------------------------------------------------------------------------

test(
  "classify(): confidence 'fingerprint' — a URL-pattern group whose fetched samples share the same DOM skeleton",
  withSilencedStderr(async () => {
    const server = await startServer(
      new Map([
        ["/blog/a", { body: "<html><body><main><h1>A</h1><p>one</p></main></body></html>" }],
        ["/blog/b", { body: "<html><body><main><h1>B</h1><p>two</p></main></body></html>" }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("fp-site", {
      "pages.json": pagesJson([server.url("/blog/a"), server.url("/blog/b")]),
    });
    try {
      const r = await classify({ site: "fp-site", runsDir: path.join(runDir, ".."), minMembers: 2 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 1);
      assert.equal(pt.types[0].confidence, "fingerprint");
      assert.equal(pt.types[0].pattern, "/blog/*");
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

test(
  "classify(): confidence 'url-only' — fewer than 2 samples could be fetched to confirm the grouping either way",
  withSilencedStderr(async () => {
    const server = await startServer(
      new Map([
        ["/blog/a", { body: "<html><body><main><h1>A</h1></main></body></html>" }],
        ["/blog/b", { status: 500, body: "error" }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("url-only-site", {
      "pages.json": pagesJson([server.url("/blog/a"), server.url("/blog/b")]),
    });
    try {
      const r = await classify({ site: "url-only-site", runsDir: path.join(runDir, ".."), minMembers: 2 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 1);
      assert.equal(pt.types[0].confidence, "url-only");
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

test(
  "classify(): confidence 'fingerprint-conflict' — samples fetched fine but disagree on DOM structure (positive evidence the URL grouping is wrong)",
  withSilencedStderr(async () => {
    const server = await startServer(
      new Map([
        ["/blog/a", { body: "<html><body><main><h1>A</h1><p>text</p></main></body></html>" }],
        ["/blog/b", { body: "<html><body><main><div><ul><li>x</li><li>y</li></ul></div></main></body></html>" }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("conflict-site", {
      "pages.json": pagesJson([server.url("/blog/a"), server.url("/blog/b")]),
    });
    try {
      const r = await classify({ site: "conflict-site", runsDir: path.join(runDir, ".."), minMembers: 2 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 1);
      assert.equal(pt.types[0].confidence, "fingerprint-conflict");
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

test(
  "classify(): confidence 'fingerprint-cluster' — one-off URLs with no shared URL pattern but an identical DOM skeleton",
  withSilencedStderr(async () => {
    const body = "<html><body><main><h1>T</h1><p>x</p></main></body></html>";
    const server = await startServer(
      new Map([
        ["/p1", { body }],
        ["/p2", { body: body.replace("T", "Other") }], // text differs, structure identical
        ["/p3", { body }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("cluster-site", {
      "pages.json": pagesJson([server.url("/p1"), server.url("/p2"), server.url("/p3")]),
    });
    try {
      const r = await classify({ site: "cluster-site", runsDir: path.join(runDir, ".."), minMembers: 3 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 1);
      assert.equal(pt.types[0].confidence, "fingerprint-cluster");
      assert.equal(pt.types[0].name, "cluster-1");
      assert.equal(pt.types[0].pattern, null);
      assert.deepEqual(
        pt.types[0].members.slice().sort(),
        [server.url("/p1"), server.url("/p2"), server.url("/p3")].sort(),
      );
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

// ---------------------------------------------------------------------------
// classify() end-to-end — archiveUrl derivation.
// ---------------------------------------------------------------------------

test(
  "classify(): archiveUrl is set when the type's listing page is present in pages.json",
  withSilencedStderr(async () => {
    const server = await startServer(
      new Map([
        ["/blog", { body: "<html><body><main><nav><a>a</a></nav></main></body></html>" }],
        ["/blog/a", { body: "<html><body><main><h1>A</h1></main></body></html>" }],
        ["/blog/b", { body: "<html><body><main><h1>B</h1></main></body></html>" }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("archive-yes-site", {
      "pages.json": pagesJson([server.url("/blog"), server.url("/blog/a"), server.url("/blog/b")]),
    });
    try {
      const r = await classify({ site: "archive-yes-site", runsDir: path.join(runDir, ".."), minMembers: 2 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 1);
      assert.equal(pt.types[0].archiveUrl, server.url("/blog"));
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

test(
  "classify(): archiveUrl is null when no listing page is present in pages.json",
  withSilencedStderr(async () => {
    const server = await startServer(
      new Map([
        ["/blog/a", { body: "<html><body><main><h1>A</h1></main></body></html>" }],
        ["/blog/b", { body: "<html><body><main><h1>B</h1></main></body></html>" }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("archive-no-site", {
      "pages.json": pagesJson([server.url("/blog/a"), server.url("/blog/b")]),
    });
    try {
      const r = await classify({ site: "archive-no-site", runsDir: path.join(runDir, ".."), minMembers: 2 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types[0].archiveUrl, null);
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

// ---------------------------------------------------------------------------
// classify() end-to-end — the off-origin redirect guard, proven through the
// real pipeline (not just fetchHtml in isolation above).
// ---------------------------------------------------------------------------

test(
  "classify(): off-origin redirect guard — three same-origin URLs that all redirect OFF-ORIGIN never form a bogus cluster, however identical their landing DOM structure is",
  withSilencedStderr(async () => {
    const body = "<html><body><main><h1>Evil</h1><p>x</p></main></body></html>";
    const evil = await startServer(
      new Map([
        ["/e1", { body }],
        ["/e2", { body }],
        ["/e3", { body }],
      ]),
    );
    const main = await startServer(
      new Map([
        ["/x1", { redirectTo: evil.url("/e1") }],
        ["/x2", { redirectTo: evil.url("/e2") }],
        ["/x3", { redirectTo: evil.url("/e3") }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("off-origin-site", {
      "pages.json": pagesJson([main.url("/x1"), main.url("/x2"), main.url("/x3")]),
    });
    try {
      const r = await classify({ site: "off-origin-site", runsDir: path.join(runDir, ".."), minMembers: 3 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 0, "an off-origin landing must never count toward a cluster");
      assert.deepEqual(
        pt.pages.map((p) => p.url).sort(),
        [main.url("/x1"), main.url("/x2"), main.url("/x3")].sort(),
      );
    } finally {
      await cleanup();
      await main.close();
      await evil.close();
    }
  }),
);

// ---------------------------------------------------------------------------
// classify() end-to-end — final-URL dedup.
// ---------------------------------------------------------------------------

test(
  "classify(): final-URL dedup — three URLs that all redirect to the SAME final URL count as ONE page, not a 3-member cluster",
  withSilencedStderr(async () => {
    const body = "<html><body><main><h1>Canonical</h1><p>x</p></main></body></html>";
    const server = await startServer(
      new Map([
        ["/dup-a", { redirectTo: "/canonical" }],
        ["/dup-b", { redirectTo: "/canonical" }],
        ["/dup-c", { redirectTo: "/canonical" }],
        ["/canonical", { body }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("dedup-site", {
      "pages.json": pagesJson([server.url("/dup-a"), server.url("/dup-b"), server.url("/dup-c")]),
    });
    try {
      const r = await classify({ site: "dedup-site", runsDir: path.join(runDir, ".."), minMembers: 3 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 0, "one real page reached 3 ways must never inflate a cluster past minMembers");
      assert.deepEqual(
        pt.pages.map((p) => p.url).sort(),
        [server.url("/dup-a"), server.url("/dup-b"), server.url("/dup-c")].sort(),
      );
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

// ---------------------------------------------------------------------------
// classify() end-to-end — mapPool's order-preservation proven through the
// REAL pipeline (not just the standalone mapPool tests above): staggered
// response times must not scramble which fingerprint pairs with which URL.
// This is the exact live regression shape from the whole-branch review.
// ---------------------------------------------------------------------------

test(
  "classify(): staggered response times must not scramble which fingerprint pairs with which URL (mapPool order-preservation, end-to-end)",
  withSilencedStderr(async () => {
    const fpA = "<html><body><main><div><ul><li>x</li></ul></div></main></body></html>"; // main,div,ul,li
    const fpB = "<html><body><main><table><tr><td>B</td></tr></table></main></body></html>"; // main,table,tr,td
    const server = await startServer(
      new Map([
        ["/w", { body: fpA, delayMs: 120 }], // slowest, index 0
        ["/x", { body: fpB, delayMs: 0 }], // fast, index 1
        ["/y", { body: fpA, delayMs: 40 }], // medium, index 2
        ["/z", { body: fpB, delayMs: 0 }], // fast, index 3
      ]),
    );
    const { runDir, cleanup } = await mkRun("mappool-wiring-site", {
      "pages.json": pagesJson(["/w", "/x", "/y", "/z"].map((p) => server.url(p))),
    });
    try {
      const r = await classify({ site: "mappool-wiring-site", runsDir: path.join(runDir, ".."), minMembers: 2 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 2, "two distinct fingerprints -> two clusters, however the network raced");

      const typeWithW = pt.types.find((t) => t.members.includes(server.url("/w")));
      assert.ok(typeWithW, "w's fingerprint-A cluster must exist");
      assert.deepEqual(
        typeWithW.members.slice().sort(),
        [server.url("/w"), server.url("/y")].sort(),
        "w and y share fingerprint A — must land in the SAME cluster despite w resolving LAST",
      );

      const typeWithX = pt.types.find((t) => t.members.includes(server.url("/x")));
      assert.ok(typeWithX, "x's fingerprint-B cluster must exist");
      assert.deepEqual(
        typeWithX.members.slice().sort(),
        [server.url("/x"), server.url("/z")].sort(),
        "x and z share fingerprint B",
      );
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

// ---------------------------------------------------------------------------
// classify() sanity — small end-to-end shape/IO check (no prior test file
// ever exercised classify() itself calling classify() at all).
// ---------------------------------------------------------------------------

test(
  "classify(): writes pagetypes.json and .classify/PROMPT.md, and returns the documented shape",
  withSilencedStderr(async () => {
    const server = await startServer(
      new Map([
        ["/", { body: "<html><body><main><h1>Home</h1></main></body></html>" }],
        ["/about", { body: "<html><body><main><h1>About</h1></main></body></html>" }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("sanity-site", {
      "pages.json": pagesJson([server.url("/"), server.url("/about")]),
    });
    try {
      const r = await classify({ site: "sanity-site", runsDir: path.join(runDir, ".."), minMembers: 4 });
      assert.equal(r.site, "sanity-site");
      assert.equal(r.typeCount, 0, "2 unrelated top-level pages, below minMembers=4 — no cluster");
      assert.equal(r.pageCount, 2);
      assert.equal(r.outPath, path.resolve(runDir, "pagetypes.json"));
      assert.equal(r.promptPath, path.resolve(runDir, ".classify", "PROMPT.md"));

      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.deepEqual(Object.keys(pt).sort(), ["pages", "site", "types"]);

      const prompt = await readFile(r.promptPath, "utf8");
      assert.ok(prompt.includes(r.outPath), "the prompt must point the reviewing agent at pagetypes.json");
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

// ---------------------------------------------------------------------------
// buildPrompt — Fix 5b: the review prompt must tell the reviewing agent to
// confirm WooCommerce is actually installed before keeping a woo:* kind.
// ---------------------------------------------------------------------------

test("buildPrompt: instructs the reviewing agent to confirm WooCommerce is actually installed/active before keeping any woo:* kind (Fix 5b)", () => {
  const prompt = buildPrompt({ site: "example.com", outPath: "/tmp/x/pagetypes.json" });
  assert.match(
    prompt,
    /confirm WooCommerce is actually\s+installed\/active on the SOURCE site/,
    "must explicitly tell the reviewer to verify WooCommerce, not trust the mechanical guess",
  );
  assert.match(
    prompt,
    /is `single:product`, NOT\s+`woo:product`/,
    "must explicitly call out that a plain non-Woo 'product' CPT is single:product",
  );
  assert.match(
    prompt,
    /TemplateResolver gates its entire WooCommerce branch/,
    "must explain WHY this matters (silent fall-through to the theme), not just assert a rule",
  );
});

// ---------------------------------------------------------------------------
// Fix (smittenkitchen.com dogfood, defect #3): classify() end-to-end on
// WordPress date permalinks + comment-heavy pages — the two mechanisms that
// failed SIMULTANEOUSLY on the real site (16 recipe posts → 0 types).
// ---------------------------------------------------------------------------

test(
  "classify(): WordPress date permalinks group into ONE type via URL normalization — even when the members' DOM genuinely disagrees, the type survives as fingerprint-conflict instead of dissolving into one-offs",
  withSilencedStderr(async () => {
    const server = await startServer(
      new Map([
        // Deliberately DIFFERENT skeletons (like real posts spanning 2007-2026
        // eras do), so only the URL grouping can save the type.
        ["/2007/01/a", { body: "<html><body><main><h1>A</h1><p>x</p></main></body></html>" }],
        ["/2009/04/b", { body: "<html><body><main><h1>B</h1><ul><li>x</li></ul></main></body></html>" }],
        ["/2017/12/c", { body: "<html><body><main><h1>C</h1><table><tr><td>x</td></tr></table></main></body></html>" }],
        ["/2026/07/d", { body: "<html><body><main><h1>D</h1><blockquote><p>x</p></blockquote></main></body></html>" }],
        ["/about", { body: "<html><body><main><h1>About</h1></main></body></html>" }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("dateperma-site", {
      "pages.json": pagesJson([
        server.url("/2007/01/a"),
        server.url("/2009/04/b"),
        server.url("/2017/12/c"),
        server.url("/2026/07/d"),
        server.url("/about"),
      ]),
    });
    try {
      const r = await classify({ site: "dateperma-site", runsDir: path.join(runDir, ".."), minMembers: 4 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 1, "pre-fix this was 0: every post sat alone in its own /YYYY/MM bucket");
      assert.equal(pt.types[0].pattern, "/%y%/%m%/*");
      assert.equal(pt.types[0].name, "post");
      assert.equal(pt.types[0].kind, "single:post");
      assert.equal(pt.types[0].members.length, 4);
      assert.equal(pt.types[0].confidence, "fingerprint-conflict", "samples fetched fine but disagree — surfaced honestly, type kept");
      assert.deepEqual(pt.pages.map((p) => p.url), [server.url("/about")]);
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

test(
  "classify(): comment-thread variance no longer breaks fingerprint confirmation — same template + wildly different comment threads → confidence 'fingerprint'",
  withSilencedStderr(async () => {
    const tpl = (comments) =>
      `<html><body><main><article><h1>t</h1><p>x</p></article>` +
      `<div id="comments" class="comments-area">${comments}</div></main></body></html>`;
    const none = tpl("<h2>No comments</h2><div id=\"respond\"><form><p><textarea></textarea></p></form></div>");
    const deep = tpl(
      "<h2>500 comments</h2><ol class=\"comment-list\">" +
        "<li class=\"comment\"><article><footer><time>x</time></footer><p>c</p></article>" +
        "<ol><li class=\"comment\"><article><p>r</p></article></li></ol></li></ol>" +
        "<div id=\"respond\"><form><p><input></p></form></div>",
    );
    const server = await startServer(
      new Map([
        ["/2024/01/a", { body: none }],
        ["/2025/06/b", { body: deep }],
      ]),
    );
    const { runDir, cleanup } = await mkRun("commentvar-site", {
      "pages.json": pagesJson([server.url("/2024/01/a"), server.url("/2025/06/b")]),
    });
    try {
      const r = await classify({ site: "commentvar-site", runsDir: path.join(runDir, ".."), minMembers: 2 });
      const pt = JSON.parse(await readFile(r.outPath, "utf8"));
      assert.equal(pt.types.length, 1);
      assert.equal(
        pt.types[0].confidence,
        "fingerprint",
        "comment threads stripped before fingerprinting — the shared template now confirms",
      );
    } finally {
      await cleanup();
      await server.close();
    }
  }),
);

// ---------------------------------------------------------------------------
// Fix (smittenkitchen.com dogfood, housekeeping): the review prompt must
// tell the agent that 0 types on a site with an obvious repeating type is a
// classify FAILURE they should repair by hand-authoring a type entry.
// ---------------------------------------------------------------------------

test("buildPrompt: tells the reviewing agent that 0 types on a site with an obvious repeating type is a classify failure, with a minimal hand-authored type example", () => {
  const prompt = buildPrompt({ site: "example.com", outPath: "/tmp/x/pagetypes.json" });
  assert.match(prompt, /## When mechanical clustering fails/);
  assert.match(
    prompt,
    /is a classify failure, not a fact about the site/,
    "must frame 0-types-on-an-obvious-type as the tool's failure, not the site's",
  );
  assert.match(prompt, /hand-authoring/, "must say hand-authoring the entry is the repair");
  assert.match(prompt, /"confidence": "manual"/, "must include the minimal JSON example");
  assert.match(prompt, /"members"/, "example must show the members list");
  assert.match(
    prompt,
    /Move the member URLs OUT of the top-level `pages` list/,
    "must warn about the URL-in-both-places mistake",
  );
});
