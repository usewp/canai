import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCandidatePages, prepareDesignBundle } from "./designmd.mjs";

// Writes `files` into <tmp>/runs/<site>/ and returns that run dir — exactly
// what loadCandidatePages/prepareDesignBundle expect — plus a cleanup() that
// removes the whole temp root. A string value is written verbatim (for
// deliberately-malformed JSON fixtures); anything else is JSON-stringified.
async function mkRun(site, files) {
  const root = await mkdtemp(path.join(tmpdir(), "designmd-test-"));
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

// Stages a full captures/<slug>/ dir. `styles` omitted entirely means "no
// styles.json" (the Task 6 hazard: style capture failed for this page even
// though content capture succeeded).
async function stageCapture(runDir, slug, { content = {}, styles } = {}) {
  const dir = path.join(runDir, "captures", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "content.json"), JSON.stringify(content, null, 2));
  await writeFile(path.join(dir, "screenshot.png"), "fake-png-bytes");
  if (styles !== undefined) {
    await writeFile(path.join(dir, "styles.json"), JSON.stringify(styles, null, 2));
  }
}

const SAMPLE_STYLES = {
  desktop: { viewport: { width: 1280, height: 800 }, fonts: [], textColors: [], bgColors: [], borderColors: [], fontSizes: [], radii: [], shadows: [], spacing: [], roles: { headings: {}, links: [], buttons: [], primaryButton: null, body: {} } },
  mobile: null,
};

// --- loadCandidatePages: pure candidate-selection logic --------------------

test("loadCandidatePages: pagetypes.json present — candidates are pages[] + each type's samples[], never members[]", async () => {
  const { runDir, cleanup } = await mkRun("site-a", {
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
    // Present but must be ignored — pagetypes.json takes priority.
    "pages.json": { site: "site-a", pages: [{ url: "https://x.com/some-other-page" }] },
  });
  try {
    const pages = await loadCandidatePages(runDir);
    const urls = pages.map((p) => p.url).sort();
    assert.deepEqual(urls, [
      "https://x.com/",
      "https://x.com/about",
      "https://x.com/blog/a",
      "https://x.com/blog/b",
    ].sort());
    // The bug surface this closes: blog/c and blog/d are real members but
    // were never captured (capture.mjs only visits samples) — picking them
    // would silently lose a page later. archiveUrl is also intentionally
    // excluded (see Step 1 of the task brief: pages[] + samples[] only).
    assert.ok(!urls.includes("https://x.com/blog/c"));
    assert.ok(!urls.includes("https://x.com/blog/d"));
    assert.ok(!urls.includes("https://x.com/blog"), "archiveUrl must not be a candidate");
    assert.ok(!urls.includes("https://x.com/some-other-page"), "pages.json must be ignored when pagetypes.json parses");
  } finally {
    await cleanup();
  }
});

test("loadCandidatePages: falls back to pages.json when pagetypes.json is absent (v2 behavior)", async () => {
  const { runDir, cleanup } = await mkRun("site-b", {
    "pages.json": { site: "site-b", pages: [{ url: "https://x.com/" }, { url: "https://x.com/about" }] },
  });
  try {
    const pages = await loadCandidatePages(runDir);
    assert.deepEqual(pages.map((p) => p.url), ["https://x.com/", "https://x.com/about"]);
  } finally {
    await cleanup();
  }
});

test("loadCandidatePages: falls back to pages.json when pagetypes.json is malformed", async () => {
  const { runDir, cleanup } = await mkRun("site-c", {
    "pagetypes.json": "{ not valid json",
    "pages.json": { site: "site-c", pages: [{ url: "https://x.com/" }] },
  });
  try {
    const pages = await loadCandidatePages(runDir);
    assert.deepEqual(pages.map((p) => p.url), ["https://x.com/"]);
  } finally {
    await cleanup();
  }
});

test("loadCandidatePages: a type with no samples contributes nothing (must not throw)", async () => {
  const { runDir, cleanup } = await mkRun("site-d", {
    "pagetypes.json": pagetypes(
      [
        {
          name: "empty-type",
          kind: "single:post",
          pattern: "/x/*",
          confidence: "url-only",
          members: ["https://x.com/x/a"],
          samples: [],
          archiveUrl: null,
        },
      ],
      ["https://x.com/"],
    ),
  });
  try {
    const pages = await loadCandidatePages(runDir);
    assert.deepEqual(pages.map((p) => p.url), ["https://x.com/"]);
  } finally {
    await cleanup();
  }
});

test("loadCandidatePages: types:[] with everything in pages", async () => {
  const { runDir, cleanup } = await mkRun("site-e", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about", "https://x.com/contact"]),
  });
  try {
    const pages = await loadCandidatePages(runDir);
    assert.deepEqual(pages.map((p) => p.url), [
      "https://x.com/",
      "https://x.com/about",
      "https://x.com/contact",
    ]);
  } finally {
    await cleanup();
  }
});

// --- prepareDesignBundle: end-to-end grounding behavior --------------------

test("prepareDesignBundle: copies each picked page's captured styles.json into the bundle and cites it as PRIMARY SOURCE", async () => {
  const { runDir, cleanup } = await mkRun("site-f", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about", "https://x.com/contact"]),
  });
  try {
    await stageCapture(runDir, "index", { content: { title: "Home", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });
    await stageCapture(runDir, "about", { content: { title: "About", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });
    await stageCapture(runDir, "contact", { content: { title: "Contact", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });

    const r = await prepareDesignBundle({ site: "site-f", runsDir: path.join(runDir, "..") });
    assert.deepEqual(r.picked.sort(), ["about", "contact", "index"]);

    const prompt = await readFile(r.promptPath, "utf8");
    assert.match(prompt, /PRIMARY SOURCE/);
    for (const slug of ["index", "about", "contact"]) {
      const stylesCopy = path.join(r.bundleDir, `${slug}-styles.json`);
      await assert.doesNotReject(readFile(stylesCopy, "utf8"), `${slug}-styles.json must exist in the bundle`);
      assert.ok(prompt.includes(`${slug}-styles.json`), `prompt must cite ${slug}-styles.json`);
    }
  } finally {
    await cleanup();
  }
});

test("prepareDesignBundle: a picked page missing styles.json (content.json captured, style pass failed) is skipped gracefully, not cited as ground truth", async () => {
  const { runDir, cleanup } = await mkRun("site-g", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about", "https://x.com/contact"]),
  });
  try {
    await stageCapture(runDir, "index", { content: { title: "Home", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });
    // "about" has content but no styles.json — the exact hazard called out in
    // the task: a samples/pages entry whose style-capture pass failed.
    await stageCapture(runDir, "about", { content: { title: "About", header: {}, main: [], footer: {} } });
    await stageCapture(runDir, "contact", { content: { title: "Contact", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });

    const r = await prepareDesignBundle({ site: "site-g", runsDir: path.join(runDir, "..") });
    // Must not throw, and every picked page (content.json existed) still
    // shows up in the return value.
    assert.deepEqual(r.picked.sort(), ["about", "contact", "index"]);

    // The bundle must not contain a dangling styles copy for "about"...
    await assert.rejects(readFile(path.join(r.bundleDir, "about-styles.json"), "utf8"));
    // ...but screenshot + content summary for "about" are unaffected.
    await assert.doesNotReject(readFile(path.join(r.bundleDir, "about.png"), "utf8"));

    const prompt = await readFile(r.promptPath, "utf8");
    // "about" must still appear in the screenshots section...
    assert.match(prompt, /about\.png/);
    // ...but never as a `-styles.json` ground-truth citation (a dead path
    // would mislead the design agent into reading a file that isn't there).
    assert.ok(!prompt.includes("about-styles.json"), "must never cite a styles.json copy that doesn't exist");
    assert.ok(prompt.includes("index-styles.json"));
    assert.ok(prompt.includes("contact-styles.json"));
  } finally {
    await cleanup();
  }
});

test("prepareDesignBundle: no picked page has styles.json — ground-truth section falls back without crashing", async () => {
  const { runDir, cleanup } = await mkRun("site-h", {
    "pagetypes.json": pagetypes([], ["https://x.com/"]),
  });
  try {
    await stageCapture(runDir, "index", { content: { title: "Home", header: {}, main: [], footer: {} } });
    const r = await prepareDesignBundle({ site: "site-h", runsDir: path.join(runDir, "..") });
    assert.deepEqual(r.picked, ["index"]);
    const prompt = await readFile(r.promptPath, "utf8");
    assert.match(prompt, /none of the picked pages have a captured styles\.json/);
  } finally {
    await cleanup();
  }
});

test("prepareDesignBundle: a picked candidate with no capture directory at all is skipped (pre-existing behavior, still intact)", async () => {
  const { runDir, cleanup } = await mkRun("site-i", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about", "https://x.com/contact"]),
  });
  try {
    await stageCapture(runDir, "index", { content: { title: "Home", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });
    await stageCapture(runDir, "about", { content: { title: "About", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });
    // "contact" was picked (matches CONTACT_PATTERNS) but was never captured
    // at all — e.g. all its fallbacks were exhausted during capture.
    const r = await prepareDesignBundle({ site: "site-i", runsDir: path.join(runDir, "..") });
    assert.deepEqual(r.picked.sort(), ["about", "index"]);
  } finally {
    await cleanup();
  }
});

// --- pickRepresentative (via prepareDesignBundle): utility-route deprioritization ---
// (the g100.my/wpdev acid test found the diversity fill landing on unstyled
// WooCommerce/WP-seed pages like /checkout/ and /hello-world/ and citing
// their UA-default styles.json as PRIMARY SOURCE for the brand palette.)

test("prepareDesignBundle: a utility route (checkout) is squeezed out once enough non-utility candidates exist to fill the remaining slots", async () => {
  const { runDir, cleanup } = await mkRun("site-util-1", {
    "pagetypes.json": pagetypes(
      [],
      // "checkout" is listed FIRST — proves this isn't just first-seen-wins
      // bucket ordering; it must lose to portfolio/team on utility-ness
      // alone, even though it would win a plain insertion-order race.
      ["https://x.com/", "https://x.com/checkout", "https://x.com/portfolio", "https://x.com/team"],
    ),
  });
  try {
    await stageCapture(runDir, "index", { content: { title: "Home", header: {}, main: [], footer: {} } });
    await stageCapture(runDir, "checkout", { content: { title: "Checkout", header: {}, main: [], footer: {} } });
    await stageCapture(runDir, "portfolio", { content: { title: "Portfolio", header: {}, main: [], footer: {} } });
    await stageCapture(runDir, "team", { content: { title: "Team", header: {}, main: [], footer: {} } });

    const r = await prepareDesignBundle({ site: "site-util-1", runsDir: path.join(runDir, "..") });
    assert.deepEqual(r.picked.sort(), ["index", "portfolio", "team"].sort());
    assert.ok(!r.picked.includes("checkout"), "checkout must not appear — 2 real non-utility candidates filled both remaining slots");
  } finally {
    await cleanup();
  }
});

test("prepareDesignBundle: a utility route IS picked as a last resort when no non-utility candidate exists", async () => {
  const { runDir, cleanup } = await mkRun("site-util-2", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/checkout", "https://x.com/cart"]),
  });
  try {
    await stageCapture(runDir, "index", { content: { title: "Home", header: {}, main: [], footer: {} } });
    await stageCapture(runDir, "checkout", { content: { title: "Checkout", header: {}, main: [], footer: {} } });
    await stageCapture(runDir, "cart", { content: { title: "Cart", header: {}, main: [], footer: {} } });

    const r = await prepareDesignBundle({ site: "site-util-2", runsDir: path.join(runDir, "..") });
    // A shop-only site has nothing else to offer — utility routes must still
    // fill the bundle (deprioritized, never hard-excluded) rather than
    // leaving the picker (and the whole bundle) short.
    assert.deepEqual(r.picked.sort(), ["cart", "checkout", "index"].sort());
  } finally {
    await cleanup();
  }
});

// --- buildPrompt: DOM-verification guidance for tokens outside `roles` -----
// (the acid test's design agent mis-measured an eyebrow label at 12px/700 by
// triangulating frequency tables alone — outside all 4 `roles` buckets — when
// the real, dom.html-verifiable value was 14px/600.)

test("prepareDesignBundle: prompt warns that outside-`roles` tokens are a hypothesis and cites each picked page's dom.html path", async () => {
  const { runDir, cleanup } = await mkRun("site-dom", {
    "pagetypes.json": pagetypes([], ["https://x.com/", "https://x.com/about"]),
  });
  try {
    await stageCapture(runDir, "index", { content: { title: "Home", header: {}, main: [], footer: {} }, styles: SAMPLE_STYLES });
    // "about" deliberately has no styles.json — DOM-verification guidance
    // must not depend on the style-capture pass having succeeded.
    await stageCapture(runDir, "about", { content: { title: "About", header: {}, main: [], footer: {} } });

    const r = await prepareDesignBundle({ site: "site-dom", runsDir: path.join(runDir, "..") });
    const prompt = await readFile(r.promptPath, "utf8");

    assert.match(prompt, /hypothesis, not a fact/i);
    assert.match(prompt, /roles/i);

    for (const slug of ["index", "about"]) {
      const expectedDomPath = path.resolve(runDir, "captures", slug, "dom.html");
      assert.ok(prompt.includes(expectedDomPath), `prompt must cite ${slug}'s dom.html path so the agent isn't left hunting for it`);
    }
  } finally {
    await cleanup();
  }
});
