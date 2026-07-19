import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  collectOutputs,
  applyOnlyFilter,
  excludeChromePartials,
  scorePageAgainstOriginal,
  buildReportLines,
  severityScore,
  takeVerifyScreenshot,
  recoverBrowserTab,
  verifyOne,
  verify,
} from "./verify.mjs";
import { MAX_FULL_PAGE_HEIGHT_PX } from "./cdp.mjs";
import { PAGE_SIZE_JS } from "./capture.mjs";

// Writes `files` (relative path -> string|Buffer content) under a fresh temp
// root, creating whatever subdirectories each path needs. Mirrors the
// mkRun() helper capture.test.mjs / transform.test.mjs use, generalized to
// nested paths and binary content since verify's fixtures are HTML across
// output/pages/, output/templates/, legacy flat output/, plus PNGs under
// captures/<slug>/. Returns the root dir plus a cleanup().
async function mkTree(files) {
  const root = await mkdtemp(path.join(tmpdir(), "verify-test-"));
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// --- tiny PNG encoder for fixtures (mirrors pngdiff.test.mjs's local one) --
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

function encodePng(width, height, px) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const red = () => [255, 0, 0, 255];
const blue = () => [0, 0, 255, 255];

// Raw PNG builder for the malformed/unsupported fixtures Fix 2 pins:
// lets a test pick an arbitrary IHDR (colorType/bitDepth) and control
// whether an IDAT chunk is present at all, without needing pixel data
// that actually decodes — decodePng rejects all of these BEFORE it ever
// inflates the IDAT bytes (see pngdiff.mjs's decodePng: the truncated-PNG
// check runs on chunk *count*, and the unsupported-format check runs on
// IHDR fields, both ahead of the inflateSync call), so a 1-byte stub is
// enough to exercise the real rejection path.
function encodeRawPng({ width = 4, height = 4, bitDepth = 8, colorType = 6, interlace = 0, includeIdat = true }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const chunks = [SIG, chunk("IHDR", ihdr)];
  if (includeIdat) chunks.push(chunk("IDAT", Buffer.alloc(1)));
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// collectOutputs — scanning across output/pages/, output/templates/, and
// legacy flat output/*.html.
// ---------------------------------------------------------------------------

test("collectOutputs finds output/pages/*.html tagged kind=page", async () => {
  const { root, cleanup } = await mkTree({
    "output/pages/index.html": "<html>a</html>",
    "output/pages/about.html": "<html>b</html>",
  });
  try {
    const entries = await collectOutputs(path.join(root, "output"));
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.kind), ["page", "page"]);
    assert.deepEqual(entries.map((e) => e.file).sort(), ["about.html", "index.html"]);
    assert.equal(entries[0].dir, path.join(root, "output", "pages"));
  } finally {
    await cleanup();
  }
});

test("collectOutputs finds output/templates/*.html tagged kind=template", async () => {
  const { root, cleanup } = await mkTree({
    "output/templates/case-study-single.html": "{{ item.post_title }}",
    "output/templates/case-study-archive.html": "{{ items }}",
  });
  try {
    const entries = await collectOutputs(path.join(root, "output"));
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.kind), ["template", "template"]);
    assert.equal(entries[0].dir, path.join(root, "output", "templates"));
  } finally {
    await cleanup();
  }
});

test("collectOutputs still finds legacy flat output/*.html, tagged kind=page", async () => {
  const { root, cleanup } = await mkTree({
    "output/index.html": "<html>legacy</html>",
    "output/about.html": "<html>legacy 2</html>",
  });
  try {
    const entries = await collectOutputs(path.join(root, "output"));
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.kind), ["page", "page"]);
    assert.equal(entries[0].dir, path.join(root, "output"));
  } finally {
    await cleanup();
  }
});

test("collectOutputs merges pages/ + templates/ + legacy flat in one call", async () => {
  const { root, cleanup } = await mkTree({
    "output/pages/index.html": "<html>a</html>",
    "output/templates/product-single.html": "{{ item }}",
    "output/legacy-orphan.html": "<html>c</html>",
  });
  try {
    const entries = await collectOutputs(path.join(root, "output"));
    const byFile = Object.fromEntries(entries.map((e) => [e.file, e.kind]));
    assert.deepEqual(byFile, {
      "index.html": "page",
      "product-single.html": "template",
      "legacy-orphan.html": "page",
    });
  } finally {
    await cleanup();
  }
});

test("collectOutputs tolerates missing pages/ and templates/ subdirs (no error, just fewer entries)", async () => {
  const { root, cleanup } = await mkTree({
    "output/only-legacy.html": "<html>only this</html>",
  });
  try {
    const entries = await collectOutputs(path.join(root, "output"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].file, "only-legacy.html");
  } finally {
    await cleanup();
  }
});

test("collectOutputs on a wholly-missing output/ dir returns an empty list, not a throw", async () => {
  const { root, cleanup } = await mkTree({});
  try {
    const entries = await collectOutputs(path.join(root, "output"));
    assert.deepEqual(entries, []);
  } finally {
    await cleanup();
  }
});

test("collectOutputs ignores non-.html siblings (e.g. a JSON sidecar)", async () => {
  const { root, cleanup } = await mkTree({
    "output/pages/index.html": "<html>a</html>",
    "output/pages/index.meta.json": "{}",
  });
  try {
    const entries = await collectOutputs(path.join(root, "output"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].file, "index.html");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// excludeChromePartials — Fix B follow-on: header.html/footer.html are Twig
// fragments (prompts/transform-chrome.md), never independently scorable.
// ---------------------------------------------------------------------------

test("excludeChromePartials drops header.html and footer.html (kind: template), keeps every other template and every page", () => {
  const entries = [
    { file: "header.html", dir: "d", kind: "template" },
    { file: "footer.html", dir: "d", kind: "template" },
    { file: "case-study-single.html", dir: "d", kind: "template" },
    { file: "index.html", dir: "d", kind: "page" },
  ];
  const out = excludeChromePartials(entries);
  assert.deepEqual(out.map((e) => e.file).sort(), ["case-study-single.html", "index.html"]);
});

test("excludeChromePartials never drops a PAGE literally named header.html or footer.html — kind gates it, same principle applyOnlyFilter's type-name recovery already follows", () => {
  const entries = [{ file: "header.html", dir: "d", kind: "page" }];
  assert.deepEqual(excludeChromePartials(entries), entries);
});

test("excludeChromePartials composes with applyOnlyFilter so '--only header' can no longer resurrect scoring a chrome partial (correctly throws 'no output matches', same as any other --only that matches nothing)", () => {
  const entries = [
    { file: "header.html", dir: "d", kind: "template" },
    { file: "case-study-single.html", dir: "d", kind: "template" },
  ];
  assert.throws(
    () => applyOnlyFilter(excludeChromePartials(entries), "header"),
    /no output matches --only header/,
    "pre-fix, --only header would have matched the (now-excluded) chrome partial via the template-type-name convention",
  );
});

test("excludeChromePartials on an empty list is a no-op", () => {
  assert.deepEqual(excludeChromePartials([]), []);
});

// ---------------------------------------------------------------------------
// applyOnlyFilter
// ---------------------------------------------------------------------------

test("applyOnlyFilter with no --only returns entries unchanged", () => {
  const entries = [{ file: "index.html", dir: "d", kind: "page" }];
  assert.equal(applyOnlyFilter(entries, null), entries);
});

test("applyOnlyFilter narrows by bare slug", () => {
  const entries = [
    { file: "index.html", dir: "d", kind: "page" },
    { file: "about.html", dir: "d", kind: "page" },
  ];
  const out = applyOnlyFilter(entries, "about");
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "about.html");
});

test("applyOnlyFilter narrows by URL pathname, normalized the same way capture/transform do", () => {
  const entries = [
    { file: "index.html", dir: "d", kind: "page" },
    { file: "about.html", dir: "d", kind: "page" },
  ];
  const out = applyOnlyFilter(entries, "/");
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "index.html");
});

test("applyOnlyFilter throws when nothing matches", () => {
  const entries = [{ file: "index.html", dir: "d", kind: "page" }];
  assert.throws(() => applyOnlyFilter(entries, "nope"), /no output matches --only nope/);
});

// --- Fix 2: --only <type name> — pre-fix, verify was the ONE stage where
// this form unconditionally threw, despite applyOnlyFilter's own (false)
// doc-comment claim of parity with capture/transform. ------------------------

test("applyOnlyFilter narrows by page-type name across BOTH of a repeating type's template files (-single and -archive)", () => {
  const entries = [
    { file: "case-study-single.html", dir: "d", kind: "template" },
    { file: "case-study-archive.html", dir: "d", kind: "template" },
    { file: "about.html", dir: "d", kind: "page" },
  ];
  const out = applyOnlyFilter(entries, "case-study");
  assert.deepEqual(out.map((e) => e.file).sort(), ["case-study-archive.html", "case-study-single.html"]);
});

test("applyOnlyFilter narrows by page-type name for a Woo-structural template file (no -single/-archive suffix)", () => {
  const entries = [
    { file: "shop.html", dir: "d", kind: "template" },
    { file: "about.html", dir: "d", kind: "page" },
  ];
  const out = applyOnlyFilter(entries, "shop");
  assert.deepEqual(out.map((e) => e.file), ["shop.html"]);
});

test("applyOnlyFilter: a page's own filename is never fished out via the template type-name convention (kind gates it)", () => {
  // A page literally named "shop.html" (kind: page, no repeating type) must
  // still match "--only shop" — but via the ordinary bare-slug path, not
  // the template type-name recovery (which must never even be consulted
  // for a page, since pages have no type).
  const entries = [
    { file: "shop.html", dir: "d", kind: "page" },
    { file: "index.html", dir: "d", kind: "page" },
  ];
  const out = applyOnlyFilter(entries, "shop");
  assert.deepEqual(out.map((e) => e.file), ["shop.html"]);
});

test("applyOnlyFilter: --only <type name> still coexists with URL-pathname and bare-slug forms in one call", () => {
  const entries = [
    { file: "index.html", dir: "d", kind: "page" },
    { file: "product-single.html", dir: "d", kind: "template" },
    { file: "product-archive.html", dir: "d", kind: "template" },
  ];
  assert.deepEqual(applyOnlyFilter(entries, "/").map((e) => e.file), ["index.html"]);
  assert.deepEqual(applyOnlyFilter(entries, "index").map((e) => e.file), ["index.html"]);
  assert.deepEqual(
    applyOnlyFilter(entries, "product").map((e) => e.file).sort(),
    ["product-archive.html", "product-single.html"],
  );
  assert.deepEqual(applyOnlyFilter(entries, "product-single").map((e) => e.file), ["product-single.html"]);
});

// ---------------------------------------------------------------------------
// scorePageAgainstOriginal — the templates-are-never-scored rule, and the
// graceful no-score fallback on a bad PNG.
// ---------------------------------------------------------------------------

test("scorePageAgainstOriginal scores a page kind when both PNGs decode", async () => {
  const { root, cleanup } = await mkTree({
    "captures/index/screenshot.png": encodePng(8, 8, red),
    "verify/index-generated.png": encodePng(8, 8, (x) => (x < 4 ? red() : blue())),
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "page",
      originalPng: path.join(root, "captures/index/screenshot.png"),
      generatedPng: path.join(root, "verify/index-generated.png"),
    });
    assert.equal(r.hasOriginal, true);
    assert.equal(r.error, null);
    assert.ok(r.score, "expected a score object");
    assert.equal(r.score.mismatchPct, 50);
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal NEVER scores a template, even when a same-slug original capture exists", async () => {
  const { root, cleanup } = await mkTree({
    "captures/case-study-single/screenshot.png": encodePng(8, 8, red),
    "verify/case-study-single-generated.png": encodePng(8, 8, red),
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "template",
      originalPng: path.join(root, "captures/case-study-single/screenshot.png"),
      generatedPng: path.join(root, "verify/case-study-single-generated.png"),
    });
    assert.equal(r.hasOriginal, false, "templates must never be treated as having a scorable original");
    assert.equal(r.score, null);
    assert.equal(r.error, null);
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal degrades to no-score (not a throw) when no original capture exists", async () => {
  const { root, cleanup } = await mkTree({
    "verify/orphan-generated.png": encodePng(4, 4, red),
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "page",
      originalPng: path.join(root, "captures/orphan/screenshot.png"), // never created
      generatedPng: path.join(root, "verify/orphan-generated.png"),
    });
    assert.equal(r.hasOriginal, false);
    assert.equal(r.score, null);
    assert.equal(r.error, null, "a missing original is not an error condition");
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal degrades to no-score (not a throw) when the original file is not a valid PNG", async () => {
  const { root, cleanup } = await mkTree({
    "captures/broken/screenshot.png": "this is not a png at all",
    "verify/broken-generated.png": encodePng(4, 4, red),
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "page",
      originalPng: path.join(root, "captures/broken/screenshot.png"),
      generatedPng: path.join(root, "verify/broken-generated.png"),
    });
    assert.equal(r.hasOriginal, true, "the file exists on disk, decode just failed");
    assert.equal(r.score, null);
    assert.match(r.error, /not a PNG/);
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal degrades to no-score when the GENERATED screenshot is corrupt", async () => {
  const { root, cleanup } = await mkTree({
    "captures/broken2/screenshot.png": encodePng(4, 4, red),
    "verify/broken2-generated.png": "garbage, not a png",
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "page",
      originalPng: path.join(root, "captures/broken2/screenshot.png"),
      generatedPng: path.join(root, "verify/broken2-generated.png"),
    });
    assert.equal(r.hasOriginal, true);
    assert.equal(r.score, null);
    assert.match(r.error, /not a PNG/);
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal degrades to no-score (not a throw) when the original PNG has an unsupported color type (palette)", async () => {
  const { root, cleanup } = await mkTree({
    // colorType 3 = palette; decodePng only supports 2 (RGB) and 6 (RGBA).
    "captures/palette/screenshot.png": encodeRawPng({ colorType: 3 }),
    "verify/palette-generated.png": encodePng(4, 4, red),
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "page",
      originalPng: path.join(root, "captures/palette/screenshot.png"),
      generatedPng: path.join(root, "verify/palette-generated.png"),
    });
    assert.equal(r.hasOriginal, true, "the file exists on disk, decode just failed");
    assert.equal(r.score, null);
    assert.match(r.error, /unsupported PNG/);
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal degrades to no-score (not a throw) when the original PNG is 16-bit-per-channel", async () => {
  const { root, cleanup } = await mkTree({
    "captures/deep/screenshot.png": encodeRawPng({ bitDepth: 16 }), // decodePng only supports 8-bit
    "verify/deep-generated.png": encodePng(4, 4, red),
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "page",
      originalPng: path.join(root, "captures/deep/screenshot.png"),
      generatedPng: path.join(root, "verify/deep-generated.png"),
    });
    assert.equal(r.hasOriginal, true, "the file exists on disk, decode just failed");
    assert.equal(r.score, null);
    assert.match(r.error, /unsupported PNG/);
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal degrades to no-score (not a throw) when the original PNG has no IDAT chunk at all (truncated)", async () => {
  const { root, cleanup } = await mkTree({
    "captures/noidat/screenshot.png": encodeRawPng({ includeIdat: false }),
    "verify/noidat-generated.png": encodePng(4, 4, red),
  });
  try {
    const r = await scorePageAgainstOriginal({
      kind: "page",
      originalPng: path.join(root, "captures/noidat/screenshot.png"),
      generatedPng: path.join(root, "verify/noidat-generated.png"),
    });
    assert.equal(r.hasOriginal, true, "the file exists on disk, decode just failed");
    assert.equal(r.score, null);
    assert.match(r.error, /truncated PNG/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// buildReportLines — worst-first ordering, template labelling, fallbacks.
// ---------------------------------------------------------------------------

function scoredResult(slug, mismatchPct, overrides = {}) {
  return {
    slug,
    kind: "page",
    ok: true,
    scored: true,
    mismatchPct,
    heightDeltaPct: 0,
    original: `captures/${slug}/screenshot.png`,
    generated: `verify/${slug}-generated.png`,
    ...overrides,
  };
}

test("buildReportLines sorts the scored table worst-first by mismatchPct", () => {
  const results = [scoredResult("low", 5), scoredResult("high", 90), scoredResult("mid", 42)];
  const lines = buildReportLines({ site: "example.com", results });
  const tableStart = lines.indexOf("| page | severity | mismatch % | height Δ % | original | generated |");
  const rows = lines.slice(tableStart + 2, tableStart + 5);
  assert.deepEqual(
    rows.map((r) => r.split("|")[1].trim()),
    ["high", "mid", "low"],
    "highest mismatch % must be first so the worst pages get eyeballed first",
  );
});

test("buildReportLines ranks a low-mismatch/high-height-delta page above a higher-mismatch/low-height-delta one (real calibration finding)", () => {
  // Reproduces the actual numbers found calibrating against wpdev.xcloudzen.com:
  // a page truncated to header+hero only (most content missing) scored LOWER
  // raw mismatchPct than its heightDeltaPct would suggest, because pngdiff
  // only diffs the overlapping (shorter) region. If report.md sorted by raw
  // mismatchPct alone, a page that's actually badly broken (large height
  // delta) could rank BELOW a page that's merely a bit noisy on pixels —
  // exactly backwards for a "worst first, human eyeballs the top" report.
  const results = [
    scoredResult("noisy-but-intact", 15, { heightDeltaPct: 2 }), // fully rendered, just visually busy
    scoredResult("mostly-missing", 11, { heightDeltaPct: 60 }), // truncated — the real failure
  ];
  const lines = buildReportLines({ site: "example.com", results });
  const tableStart = lines.indexOf("| page | severity | mismatch % | height Δ % | original | generated |");
  const rows = lines.slice(tableStart + 2, tableStart + 4);
  assert.deepEqual(
    rows.map((r) => r.split("|")[1].trim()),
    ["mostly-missing", "noisy-but-intact"],
    "the badly-truncated page (60% height delta) must rank above the merely-noisy one (15% mismatch), even though its raw mismatchPct is lower",
  );
});

// ---------------------------------------------------------------------------
// severityScore — Fix 1: content mismatch must dominate a merely-different
// height, while the truncation catch above still works.
// ---------------------------------------------------------------------------

test("severityScore is mismatchPct plus 30% of heightDeltaPct", () => {
  assert.equal(severityScore({ mismatchPct: 15, heightDeltaPct: 0 }), 15);
  assert.equal(severityScore({ mismatchPct: 0, heightDeltaPct: 20 }), 6);
  assert.ok(
    Math.abs(severityScore({ mismatchPct: 3.4, heightDeltaPct: 5.5 }) - 5.05) < 1e-9,
    "faithful-rebuild case from Task 10's calibration",
  );
  assert.ok(
    Math.abs(severityScore({ mismatchPct: 11.0, heightDeltaPct: 59.9 }) - 28.97) < 1e-9,
    "truncated-page case from Task 10's calibration",
  );
});

test("buildReportLines ranks wrong-content-same-height ABOVE faithful-but-20%-taller (adversarial pair max() gets backwards)", () => {
  // These are exactly the two cases a reviewer built through the real
  // functions to beat Task 10's Math.max(mismatchPct, heightDeltaPct):
  // under max(), "faithful-but-taller"'s height delta alone (20) outranks
  // "wrong-content"'s mismatch (15), so a perfectly faithful page would
  // print above a genuinely wrong-content one — exactly backwards for a
  // worst-first report. Mutation check: reverting buildReportLines's sort
  // key to Math.max(r.mismatchPct, r.heightDeltaPct) makes this test fail
  // (max(0,20)=20 > max(15,0)=15 sorts "faithful-but-taller" first);
  // confirmed by hand and reverted — see task-10-report.md.
  const results = [
    scoredResult("faithful-but-taller", 0, { heightDeltaPct: 20 }), // case 3
    scoredResult("wrong-content-same-height", 15, { heightDeltaPct: 0 }), // case 4
  ];
  const lines = buildReportLines({ site: "example.com", results });
  const tableStart = lines.indexOf("| page | severity | mismatch % | height Δ % | original | generated |");
  const rows = lines.slice(tableStart + 2, tableStart + 4);
  assert.deepEqual(
    rows.map((r) => r.split("|")[1].trim()),
    ["wrong-content-same-height", "faithful-but-taller"],
    "wrong content must outrank a page that's merely taller, even though its raw mismatchPct (15) is below the other's raw heightDeltaPct (20)",
  );
});

test("buildReportLines: both broken cases (truncated, wrong-content) rank above both faithful cases (rebuild, taller) — all four calibration numbers together", () => {
  // The full scenario from the brief: Task 10's real calibration (cases 1
  // & 2) plus the reviewer's adversarial pair (cases 3 & 4), scored and
  // sorted through the real buildReportLines. Required outcome is that
  // cases 2 and 4 both rank above cases 1 and 3 — the exact order of
  // 2-vs-4 and of 1-vs-3 is deliberately not asserted, because it isn't
  // load-bearing (see the severityScore comment in verify.mjs: both
  // "broken" pages need to outrank both "fine" pages, but which broken
  // page is worse, or which fine page is fractionally finer, doesn't
  // change what the human does next).
  const results = [
    scoredResult("1-faithful-rebuild", 3.4, { heightDeltaPct: 5.5 }),
    scoredResult("2-truncated-broken", 11.0, { heightDeltaPct: 59.9 }),
    scoredResult("3-faithful-taller", 0.0, { heightDeltaPct: 20.0 }),
    scoredResult("4-wrong-content", 15.0, { heightDeltaPct: 0.0 }),
  ];
  const lines = buildReportLines({ site: "example.com", results });
  const tableStart = lines.indexOf("| page | severity | mismatch % | height Δ % | original | generated |");
  const rows = lines.slice(tableStart + 2, tableStart + 6);
  const order = rows.map((r) => r.split("|")[1].trim());
  const rank = (slug) => order.indexOf(slug);
  assert.ok(rank("2-truncated-broken") >= 0 && rank("4-wrong-content") >= 0, "both broken cases must appear in the scored table");
  assert.ok(rank("2-truncated-broken") < rank("1-faithful-rebuild"), "truncated page must outrank the faithful rebuild");
  assert.ok(rank("2-truncated-broken") < rank("3-faithful-taller"), "truncated page must outrank the faithful-but-taller page");
  assert.ok(rank("4-wrong-content") < rank("1-faithful-rebuild"), "wrong-content page must outrank the faithful rebuild");
  assert.ok(rank("4-wrong-content") < rank("3-faithful-taller"), "wrong-content page must outrank the faithful-but-taller page");
});

test("buildReportLines labels a Twig-free template as never-scored (not a Twig gap), never puts it in the scored table", () => {
  const results = [
    scoredResult("about", 12),
    {
      slug: "case-study-single",
      kind: "template",
      ok: true,
      scored: false,
      mismatchPct: null,
      heightDeltaPct: null,
      original: null,
      generated: "verify/case-study-single-generated.png",
      // no hasTwig: this template happens to contain no Twig delimiters —
      // it must still never be pixel-scored, but not because of Twig.
    },
  ];
  const lines = buildReportLines({ site: "example.com", results });
  const joined = lines.join("\n");
  assert.ok(!joined.includes("case-study-single |"), "a template must never appear as a scored-table row");
  const templateLine = lines.find((l) => l.startsWith("- case-study-single"));
  assert.match(templateLine, /templates are never scored/);
  assert.ok(
    !/verify after deploy/.test(templateLine),
    "a Twig-free template must not falsely claim it contains unresolved Twig",
  );
});

test("buildReportLines labels a Twig-bearing template with the post-deploy Twig wording (verify after deploy against the live site)", () => {
  const results = [
    {
      slug: "recipe-single",
      kind: "template",
      ok: true,
      scored: false,
      mismatchPct: null,
      heightDeltaPct: null,
      original: null,
      generated: "verify/recipe-single-generated.png",
      hasTwig: true,
    },
  ];
  const lines = buildReportLines({ site: "example.com", results });
  const line = lines.find((l) => l.startsWith("- recipe-single"));
  assert.match(line, /verify after deploy against the live site/);
});

test("buildReportLines lists a page with no original capture under Not scored, distinct wording from templates", () => {
  const results = [
    {
      slug: "orphan",
      kind: "page",
      ok: true,
      scored: false,
      mismatchPct: null,
      heightDeltaPct: null,
      original: null,
      generated: "verify/orphan-generated.png",
    },
  ];
  const lines = buildReportLines({ site: "example.com", results });
  const line = lines.find((l) => l.startsWith("- orphan"));
  assert.match(line, /no original capture/);
  assert.ok(!line.includes("template"));
});

test("buildReportLines reports a render failure with its error, not a score row", () => {
  const results = [{ slug: "timeout-page", ok: false, error: "agent-browser exited 1: timeout" }];
  const lines = buildReportLines({ site: "example.com", results });
  const line = lines.find((l) => l.startsWith("- timeout-page"));
  assert.match(line, /render FAILED — agent-browser exited 1: timeout/);
});

test("buildReportLines: an all-scored run still prints an (empty) Not scored section header", () => {
  const results = [scoredResult("index", 3)];
  const lines = buildReportLines({ site: "example.com", results });
  assert.ok(lines.includes("## Not scored (eyeball these)"));
});

test("buildReportLines includes the site name in the title", () => {
  const lines = buildReportLines({ site: "example.com", results: [] });
  assert.equal(lines[0], "# Verify report — example.com");
});

// ---------------------------------------------------------------------------
// Fix 2 (prerelease review): verify's full-page screenshot must route
// through cdp.mjs's capped/timeout-bounded captureFullPageScreenshot, never
// agent-browser's own unguarded `screenshot --full` — the exact call that,
// with no clip-guard or bounded timeout, crashed Chrome during capture and
// produced silently-clamped 26,394px voids before that function fixed
// capture.mjs's captureOne (commit a3c4638). verify imported none of it — a
// tall rendered page/template (this dogfood's own trigger shape) could crash
// Chrome here just as easily. The stubFetch/makeRecordingWebSocket/
// stubWebSocket trio below mirrors cdp.test.mjs's own technique so the core
// test proves the REAL default wiring end-to-end, without a live browser.
// ---------------------------------------------------------------------------

function stubFetch(t, targets) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => targets });
  t.after(() => {
    globalThis.fetch = original;
  });
}

function makeRecordingWebSocket(sent) {
  return class RecordingWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(data) {
      const msg = JSON.parse(data);
      sent.push(msg);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("fake-png-bytes").toString("base64") },
            }),
          }),
        ),
      );
    }
    close() {}
  };
}

function stubWebSocket(t, WsClass) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WsClass;
  t.after(() => {
    globalThis.WebSocket = original;
  });
}

// Mirrors capture.test.mjs's helper of the same name — the verify()
// orchestration tests further below make verify() itself run (previously
// untested; only its pure helpers were), which writes progress/failure
// lines to stderr.
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

test("takeVerifyScreenshot: MUTATION-SENSITIVE — routes through cdp.mjs's REAL captureFullPageScreenshot by default, capping an oversized measured page instead of requesting the real crash-prone height", async (t) => {
  stubFetch(t, [{ type: "page", url: "file:///tmp/x.html", webSocketDebuggerUrl: "ws://127.0.0.1:1/fake" }]);
  const sent = [];
  stubWebSocket(t, makeRecordingWebSocket(sent));

  const fakeAb = async (args, opts) => {
    assert.deepEqual(
      args.slice(-2),
      ["eval", "--stdin"],
      "must measure the page itself (eval --stdin), not go straight to a screenshot command",
    );
    assert.equal(opts && opts.input, PAGE_SIZE_JS, "must reuse capture.mjs's own page-size formula, not a divergent copy");
    // 107,352px is the real height captured live for smittenkitchen.com's
    // crispy-spiced-lamb recipe post (see cdp.mjs's MAX_FULL_PAGE_HEIGHT_PX
    // doc comment) — the exact shape a long rendered template can reach.
    return { stdout: JSON.stringify({ width: 1440, height: 107352 }) };
  };

  const result = await takeVerifyScreenshot({
    flags: ["--cdp", "9223", "--session", "personal"],
    fileUrl: "file:///tmp/x.html",
    generatedPng: "/dev/null",
    cdp: 9223,
    session: "personal",
    abImpl: fakeAb,
    resolveEndpoint: () => ({ host: "127.0.0.1", port: 9223 }),
    // captureFullPage intentionally left at its REAL default (cdp.mjs's
    // captureFullPageScreenshot) — this is what proves the production
    // default wiring, not a re-implementation that merely looks similar.
  });

  assert.equal(result.capped, true);
  assert.equal(result.height, MAX_FULL_PAGE_HEIGHT_PX);
  assert.equal(result.requestedHeight, 107352);
  assert.equal(
    sent.length,
    1,
    "must have gone through captureFullPageScreenshot's single Page.captureScreenshot call, not agent-browser's own screenshot command",
  );
  assert.equal(sent[0].method, "Page.captureScreenshot");
  assert.equal(
    sent[0].params.clip.height,
    MAX_FULL_PAGE_HEIGHT_PX,
    "the CDP call itself must request the CAPPED height, never the real 107352px",
  );
  assert.equal(sent[0].params.captureBeyondViewport, true);
});

test("takeVerifyScreenshot: an ordinary (not oversized) measured page is requested as-is, not silently shrunk", async (t) => {
  stubFetch(t, [{ type: "page", url: "file:///tmp/x.html", webSocketDebuggerUrl: "ws://127.0.0.1:1/fake" }]);
  const sent = [];
  stubWebSocket(t, makeRecordingWebSocket(sent));
  const fakeAb = async () => ({ stdout: JSON.stringify({ width: 1440, height: 4200 }) });

  const result = await takeVerifyScreenshot({
    flags: [],
    fileUrl: "file:///tmp/x.html",
    generatedPng: "/dev/null",
    cdp: 9223,
    session: "personal",
    abImpl: fakeAb,
    resolveEndpoint: () => ({ host: "127.0.0.1", port: 9223 }),
  });

  assert.equal(result.capped, false);
  assert.equal(sent[0].params.clip.height, 4200);
});

test("takeVerifyScreenshot: an unmeasurable page size throws a clear error and never calls captureFullPage", async () => {
  const fakeAb = async () => ({ stdout: "not json" });
  let captureFullPageCalled = false;
  await assert.rejects(
    () =>
      takeVerifyScreenshot({
        flags: [],
        fileUrl: "file:///x.html",
        generatedPng: "/dev/null",
        cdp: 9223,
        session: "personal",
        abImpl: fakeAb,
        resolveEndpoint: () => ({ host: "127.0.0.1", port: 9223 }),
        captureFullPage: async () => {
          captureFullPageCalled = true;
          return {};
        },
      }),
    /could not measure page size for full-page screenshot/,
  );
  assert.equal(captureFullPageCalled, false, "must fail before ever attempting a capture with bogus dimensions");
});

test("takeVerifyScreenshot: a zero/negative measured dimension is rejected the same way as unparseable JSON", async () => {
  const fakeAb = async () => ({ stdout: JSON.stringify({ width: 0, height: 4000 }) });
  await assert.rejects(
    () =>
      takeVerifyScreenshot({
        flags: [],
        fileUrl: "file:///x.html",
        generatedPng: "/dev/null",
        cdp: 9223,
        session: "personal",
        abImpl: fakeAb,
        resolveEndpoint: () => ({ host: "127.0.0.1", port: 9223 }),
        captureFullPage: async () => {
          throw new Error("must not be called");
        },
      }),
    /could not measure page size/,
  );
});

// --- recoverBrowserTab: mirrors capture.mjs's own defaultRecoverBrowser ----

test("recoverBrowserTab: true when a fresh tab lands on about:blank", async () => {
  const calls = [];
  const fakeAb = async (args) => {
    calls.push(args);
    if (args.includes("url")) return { stdout: "about:blank\n" };
    return { stdout: "" };
  };
  const ok = await recoverBrowserTab({ flags: ["--cdp", "9223"], abImpl: fakeAb });
  assert.equal(ok, true);
  assert.ok(calls.some((c) => c.includes("tab") && c.includes("new")), "must ask agent-browser for a fresh tab");
});

test("recoverBrowserTab: false when agent-browser itself fails (the browser process is truly gone)", async () => {
  const fakeAb = async () => {
    throw new Error("agent-browser exited 1: ✗ Auto-launch failed: connect ECONNREFUSED");
  };
  assert.equal(await recoverBrowserTab({ flags: [], abImpl: fakeAb }), false);
});

test("recoverBrowserTab: false when the fresh tab doesn't actually land on about:blank", async () => {
  const fakeAb = async (args) => ({ stdout: args.includes("url") ? "https://example.com/\n" : "" });
  assert.equal(await recoverBrowserTab({ flags: [], abImpl: fakeAb }), false);
});

// --- verifyOne: the browser-touching per-entry sequence, extracted --------

test("verifyOne: opens the file URL and delegates to takeScreenshot after the tab/wait sequence", async () => {
  const calls = [];
  const fakeAb = async (args) => {
    calls.push(args.join(" "));
    if (args.includes("url")) return { stdout: "about:blank\n" }; // already a workable tab
    return { stdout: "" };
  };
  let screenshotArgs = null;
  const fakeTakeScreenshot = async (args) => {
    screenshotArgs = args;
    return { capped: false };
  };

  const result = await verifyOne({
    flags: ["--cdp", "9223", "--session", "personal"],
    fileUrl: "file:///tmp/x.html",
    generatedPng: "/tmp/x-generated.png",
    cdp: 9223,
    session: "personal",
    abImpl: fakeAb,
    takeScreenshot: fakeTakeScreenshot,
  });

  assert.deepEqual(result, { capped: false });
  assert.ok(calls.some((c) => c.includes("open") && c.includes("file:///tmp/x.html")));
  assert.equal(screenshotArgs.fileUrl, "file:///tmp/x.html");
  assert.equal(screenshotArgs.generatedPng, "/tmp/x-generated.png");
});

test("verifyOne: forces a fresh tab when the active tab is not a usable http(s)/file URL (e.g. a restricted webview)", async () => {
  const calls = [];
  const fakeAb = async (args) => {
    calls.push(args.join(" "));
    if (args.includes("url")) return { stdout: "chrome://settings\n" };
    return { stdout: "" };
  };
  const fakeTakeScreenshot = async () => ({ capped: false });

  await verifyOne({
    flags: [],
    fileUrl: "file:///tmp/x.html",
    generatedPng: "/tmp/x.png",
    cdp: 9223,
    session: "personal",
    abImpl: fakeAb,
    takeScreenshot: fakeTakeScreenshot,
  });

  assert.ok(calls.some((c) => c.startsWith("tab new about:blank")), "an unusable active tab must trigger a fresh tab");
});

// --- verify(): browser-death detection/recovery/continue orchestration ----
// Mirrors capture.test.mjs's own capture()-orchestration tests (mkTree
// fixtures, withSilencedStderr, verifyOneImpl/recoverBrowser injection — no
// real browser, no real agent-browser process).

test(
  "verify(): a browser-death error during the screenshot step triggers ONE recovery attempt and retries the SAME entry",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkTree({ "mysite/output/pages/index.html": "<html>ok</html>" });
    try {
      let calls = 0;
      const verifyOneImpl = async () => {
        calls += 1;
        if (calls === 1) throw new Error("agent-browser exited 1: ✗ CDP response channel closed");
        return { width: 1440, height: 4000, requestedHeight: 4000, capped: false };
      };
      let recoverCalls = 0;
      const recoverBrowser = async () => {
        recoverCalls += 1;
        return true;
      };

      const r = await verify({ site: "mysite", runsDir: root, verifyOneImpl, recoverBrowser });

      assert.equal(calls, 2, "verifyOneImpl must be retried after a successful recovery");
      assert.equal(recoverCalls, 1);
      assert.equal(r.ok, 1);
      assert.equal(r.count, 1);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verify(): when browser recovery fails, the entry is recorded as failed and the run continues to the NEXT entry",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/index.html": "<html>a</html>",
      "mysite/output/pages/zzz.html": "<html>b</html>",
    });
    try {
      const verifyOneImpl = async ({ fileUrl }) => {
        if (fileUrl.includes("index.html")) {
          throw new Error("agent-browser exited 1: ✗ CDP response channel closed");
        }
        return { width: 1440, height: 2000, requestedHeight: 2000, capped: false };
      };
      let recoverCalls = 0;
      const recoverBrowser = async () => {
        recoverCalls += 1;
        return false;
      };

      const r = await verify({ site: "mysite", runsDir: root, verifyOneImpl, recoverBrowser });

      assert.equal(r.count, 2);
      assert.equal(r.ok, 1, "the OTHER entry must still succeed even though index.html failed and recovery failed");
      assert.equal(recoverCalls, 1, "recovery is attempted exactly once for the failing entry, not once per remaining entry");
      const manifest = JSON.parse(await readFile(path.join(root, "mysite", "verify", "index.json"), "utf8"));
      const failed = manifest.pairs.find((p) => p.slug === "index");
      assert.equal(failed.ok, false);
      assert.match(failed.error, /CDP response channel closed/);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verify(): an ordinary (non-browser-death) failure never triggers a recovery attempt",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkTree({ "mysite/output/pages/index.html": "<html>a</html>" });
    try {
      const verifyOneImpl = async () => {
        throw new Error("some ordinary rendering problem, not browser death");
      };
      let recoverCalls = 0;
      const recoverBrowser = async () => {
        recoverCalls += 1;
        return true;
      };

      const r = await verify({ site: "mysite", runsDir: root, verifyOneImpl, recoverBrowser });

      assert.equal(recoverCalls, 0, "a non-browser-death error must never trigger recovery");
      assert.equal(r.ok, 0);
    } finally {
      await cleanup();
    }
  }),
);

// verify()-level (not just the pure scorePageAgainstOriginal/buildReportLines
// helpers) proof that hasTwig actually gets threaded through the real code
// path: read file -> containsTwigSyntax -> scorePageAgainstOriginal ->
// result object -> report.md. A page whose output HTML includes the shared
// {{ wpcanai_template('header') }} chrome must never be pixel-scored, even
// when a same-slug original capture genuinely exists on disk — deleting the
// `hasTwig` argument from verify.mjs's own scorePageAgainstOriginal call
// would silently start scoring it again, and nothing except this test would
// notice (scorePageAgainstOriginal's own unit tests pass `hasTwig` by hand,
// so they can't catch a call-site regression). Pre-seeding BOTH the
// original AND the generated PNG (identical pixels) makes the mutation
// maximally visible: if hasTwig stops reaching scorePageAgainstOriginal,
// this entry would actually score as a 0%-mismatch match and move into the
// scored table instead of staying in Not scored.
test(
  "verify(): a page whose HTML still contains the shared-chrome Twig include is never pixel-scored, even though its original capture exists — MUTATION-SENSITIVE on the hasTwig wiring into scorePageAgainstOriginal",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/about.html": "<html><body>{{ wpcanai_template('header') }}</body></html>",
      "mysite/captures/about/screenshot.png": encodePng(4, 4, red),
      "mysite/verify/about-generated.png": encodePng(4, 4, red),
    });
    try {
      const verifyOneImpl = async () => ({ width: 100, height: 100, requestedHeight: 100, capped: false });
      const r = await verify({ site: "mysite", runsDir: root, verifyOneImpl });

      assert.equal(r.count, 1);
      assert.equal(r.ok, 1);
      assert.equal(r.scored, 0, "a Twig-bearing page must contribute 0 to verify()'s scored count");

      const manifest = JSON.parse(await readFile(path.join(root, "mysite", "verify", "index.json"), "utf8"));
      const pair = manifest.pairs.find((p) => p.slug === "about");
      assert.equal(pair.hasTwig, true);
      assert.equal(pair.scored, false);
      assert.equal(
        pair.original,
        null,
        "must not report an original to compare against once Twig makes the page unscoreable",
      );

      const report = await readFile(path.join(root, "mysite", "verify", "report.md"), "utf8");
      assert.match(report, /verify after deploy against the live site/);
      assert.ok(!report.includes("about |"), "must never appear as a scored-table row");
    } finally {
      await cleanup();
    }
  }),
);

// ---------------------------------------------------------------------------
// hasTwig — verify has no Twig engine; a page/template still containing
// unresolved Twig delimiters is screenshotted raw, never pixel-scored, and
// pointed at post-deploy verification instead.
// ---------------------------------------------------------------------------

test("scorePageAgainstOriginal refuses to score a PAGE whose HTML still contains Twig (nothing resolved it locally)", async () => {
  const { root, cleanup } = await mkTree({
    "captures/about/screenshot.png": encodePng(8, 8, red),
    "verify/about-generated.png": encodePng(8, 8, red),
  });
  try {
    const res = await scorePageAgainstOriginal({
      kind: "page",
      hasTwig: true,
      originalPng: path.join(root, "captures/about/screenshot.png"),
      generatedPng: path.join(root, "verify/about-generated.png"),
    });
    assert.equal(res.hasOriginal, false, "a Twig-containing page must not be scored");
    assert.equal(res.score, null);
  } finally {
    await cleanup();
  }
});

test("scorePageAgainstOriginal still scores a plain static page when hasTwig is false", async () => {
  const { root, cleanup } = await mkTree({
    "captures/about/screenshot.png": encodePng(8, 8, red),
    "verify/about-generated.png": encodePng(8, 8, red),
  });
  try {
    const res = await scorePageAgainstOriginal({
      kind: "page",
      hasTwig: false,
      originalPng: path.join(root, "captures/about/screenshot.png"),
      generatedPng: path.join(root, "verify/about-generated.png"),
    });
    assert.equal(res.hasOriginal, true);
    assert.ok(res.score, "a static page with an original must still score");
  } finally {
    await cleanup();
  }
});

test("buildReportLines points a Twig-containing PAGE at post-deploy verification, not at 'no original capture'", () => {
  const results = [
    {
      slug: "contact",
      kind: "page",
      ok: true,
      scored: false,
      hasTwig: true,
      mismatchPct: null,
      heightDeltaPct: null,
      original: null,
      generated: "verify/contact-generated.png",
    },
  ];
  const line = buildReportLines({ site: "example.com", results }).find((l) => l.startsWith("- contact"));
  assert.match(line, /verify after deploy against the live site/);
  assert.ok(!line.includes("no original capture"));
});

test("buildReportLines omits the Twig-explanation paragraph entirely when nothing in the run is a template or has Twig", () => {
  const joined = buildReportLines({ site: "example.com", results: [] }).join("\n");
  assert.ok(
    !joined.includes("canai-replicate has no Twig engine"),
    "an empty (or all-scored) run has nothing for the Twig explanation to explain",
  );
});

test("buildReportLines explains in the Not-scored section why Twig outputs can't be scored locally, when a hasTwig entry is present", () => {
  const results = [
    {
      slug: "contact",
      kind: "page",
      ok: true,
      scored: false,
      hasTwig: true,
      mismatchPct: null,
      heightDeltaPct: null,
      original: null,
      generated: "verify/contact-generated.png",
    },
  ];
  const joined = buildReportLines({ site: "example.com", results }).join("\n");
  assert.match(joined, /canai-replicate has no Twig engine/);
});
