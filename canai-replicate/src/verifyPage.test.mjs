import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { buildPageReport, verifyPage, defaultPageScreenshotFn } from "./verifyPage.mjs";
import { nextAttemptState, DEFAULT_PAGE_GATE } from "./pageGate.mjs";
import { severityScore } from "./verify.mjs";
import { REVEAL_JS, SCROLL_PASS_JS } from "./capture.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors verify.test.mjs / pngdiff.test.mjs)
// ---------------------------------------------------------------------------

async function mkTree(files) {
  const root = await mkdtemp(path.join(tmpdir(), "verify-page-test-"));
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

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
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const red = () => [255, 0, 0, 255];
const blue = () => [0, 0, 255, 255];

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

// ---------------------------------------------------------------------------
// buildPageReport
// ---------------------------------------------------------------------------

test("buildPageReport: json carries status/attempts/canHandoff from attemptState + scores", () => {
  const desktop = { mismatchPct: 2.5, heightDeltaPct: 1.0 };
  const mobile = { mismatchPct: 3.0, heightDeltaPct: 2.0 };
  const gate = {
    pass: true,
    reasons: [],
    desktop: { pass: true, reasons: [] },
    mobile: { pass: true, reasons: [] },
  };
  const attemptState = nextAttemptState({ attempts: 1, pass: true });

  const { markdown, json } = buildPageReport({
    site: "example.com",
    slug: "about",
    desktop,
    mobile,
    gate,
    attemptState,
  });

  assert.equal(json.site, "example.com");
  assert.equal(json.slug, "about");
  assert.equal(json.status, "pass");
  assert.equal(json.attempts, 1);
  assert.equal(json.canHandoff, true);
  assert.equal(json.canRetry, false);
  assert.deepEqual(json.desktop, {
    ...desktop,
    severity: severityScore(desktop),
  });
  assert.deepEqual(json.mobile, {
    ...mobile,
    severity: severityScore(mobile),
  });
  assert.equal(json.gate.pass, true);
  assert.match(markdown, /# Page verify — example.com \/ about/);
  assert.match(markdown, /status:\s*pass/i);
  assert.match(markdown, /canHandoff:\s*true/i);
  assert.match(markdown, /2\.5/);
  assert.match(markdown, /3\.0/);
});

test("buildPageReport: fail attemptState → canHandoff false and reasons listed", () => {
  const desktop = { mismatchPct: 20, heightDeltaPct: 1 };
  const mobile = { mismatchPct: 1, heightDeltaPct: 1 };
  const gate = {
    pass: false,
    reasons: ["desktop: mismatchPct 20 >= 15"],
    desktop: { pass: false, reasons: ["mismatchPct 20 >= 15"] },
    mobile: { pass: true, reasons: [] },
  };
  const attemptState = nextAttemptState({ attempts: 3, pass: false });

  const { markdown, json } = buildPageReport({
    site: "example.com",
    slug: "about",
    desktop,
    mobile,
    gate,
    attemptState,
    sectionNotes: ["hero looks truncated"],
  });

  assert.equal(json.status, "fail");
  assert.equal(json.canHandoff, false);
  assert.equal(json.canRetry, false);
  assert.deepEqual(json.sectionNotes, ["hero looks truncated"]);
  assert.match(markdown, /desktop: mismatchPct 20 >= 15/);
  assert.match(markdown, /hero looks truncated/);
});

test("buildPageReport: in-progress keeps canRetry and blocks handoff", () => {
  const attemptState = nextAttemptState({ attempts: 2, pass: false });
  const { json } = buildPageReport({
    site: "s.com",
    slug: "x",
    desktop: { mismatchPct: 16, heightDeltaPct: 0 },
    mobile: { mismatchPct: 0, heightDeltaPct: 0 },
    gate: { pass: false, reasons: ["desktop: mismatchPct 16 >= 15"], desktop: { pass: false, reasons: [] }, mobile: { pass: true, reasons: [] } },
    attemptState,
  });
  assert.equal(json.status, "in-progress");
  assert.equal(json.canHandoff, false);
  assert.equal(json.canRetry, true);
});

// ---------------------------------------------------------------------------
// verifyPage — stub screenshotFn, staged captures
// ---------------------------------------------------------------------------

test(
  "verifyPage: identical fixtures → pass, writes reports + generated PNGs + page-mode.json, canHandoff true",
  withSilencedStderr(async () => {
    const desktopPng = encodePng(8, 8, red);
    const mobilePng = encodePng(4, 6, red);
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/about.html": "<html><body><header>h</header><main>m</main><footer>f</footer></body></html>",
      "mysite/captures/about/fullpage-desktop.png": desktopPng,
      "mysite/captures/about/fullpage-mobile.png": mobilePng,
    });
    try {
      const screenshotFn = async ({ width }) => {
        if (width === 1440) return desktopPng;
        if (width === 390) return mobilePng;
        throw new Error(`unexpected width ${width}`);
      };

      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "about",
        screenshotFn,
      });

      assert.equal(report.status, "pass");
      assert.equal(report.canHandoff, true);
      assert.equal(report.attempts, 1);
      assert.deepEqual(report.canHandoff, nextAttemptState({ attempts: 1, pass: true }).canHandoff);

      const verifyDir = path.join(root, "mysite", "verify");
      await access(path.join(verifyDir, "page-report.md"));
      await access(path.join(verifyDir, "page-report.json"));
      await access(path.join(verifyDir, "about-desktop-generated.png"));
      await access(path.join(verifyDir, "about-mobile-generated.png"));

      const json = JSON.parse(await readFile(path.join(verifyDir, "page-report.json"), "utf8"));
      assert.equal(json.status, "pass");
      assert.equal(json.canHandoff, true);
      assert.ok(json.desktop.mismatchPct < DEFAULT_PAGE_GATE.maxMismatchPct);
      assert.ok(json.mobile.mismatchPct < DEFAULT_PAGE_GATE.maxMismatchPct);

      const meta = JSON.parse(
        await readFile(path.join(root, "mysite", "output", "pages", "about.page-mode.json"), "utf8"),
      );
      assert.equal(meta.status, "pass");
      assert.equal(meta.attempts, 1);
      assert.ok(meta.scores.desktop);
      assert.ok(meta.scores.mobile);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: mismatch above gate → in-progress on attempt 1 (no throw), canHandoff false",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const generated = encodePng(8, 8, blue); // 100% mismatch
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
    });
    try {
      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "about",
        screenshotFn: async () => generated,
      });

      assert.equal(report.status, "in-progress");
      assert.equal(report.canHandoff, false);
      assert.equal(report.canRetry, true);
      assert.equal(report.attempts, 1);
      assert.deepEqual(
        { canHandoff: report.canHandoff, canRetry: report.canRetry, status: report.status },
        (() => {
          const s = nextAttemptState({ attempts: 1, pass: false });
          return { canHandoff: s.canHandoff, canRetry: s.canRetry, status: s.status };
        })(),
      );
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: third failed attempt → status fail and throws",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const generated = encodePng(8, 8, blue);
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
      "mysite/output/pages/about.page-mode.json": JSON.stringify({
        attempts: 2,
        status: "in-progress",
        scores: {},
      }),
    });
    try {
      await assert.rejects(
        () =>
          verifyPage({
            site: "mysite",
            runsDir: root,
            only: "about",
            screenshotFn: async () => generated,
          }),
        /fail|page.?verify|gate/i,
      );

      const meta = JSON.parse(
        await readFile(path.join(root, "mysite", "output", "pages", "about.page-mode.json"), "utf8"),
      );
      assert.equal(meta.status, "fail");
      assert.equal(meta.attempts, 3);

      const json = JSON.parse(
        await readFile(path.join(root, "mysite", "verify", "page-report.json"), "utf8"),
      );
      assert.equal(json.status, "fail");
      assert.equal(json.canHandoff, false);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: missing fullpage capture throws before screenshot",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/about.html": "<html></html>",
      "mysite/captures/about/fullpage-desktop.png": encodePng(4, 4, red),
      // mobile missing
    });
    try {
      let called = false;
      await assert.rejects(
        () =>
          verifyPage({
            site: "mysite",
            runsDir: root,
            only: "about",
            screenshotFn: async () => {
              called = true;
              return encodePng(4, 4, red);
            },
          }),
        /fullpage-mobile/,
      );
      assert.equal(called, false);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: missing output HTML throws",
  withSilencedStderr(async () => {
    const { root, cleanup } = await mkTree({
      "mysite/captures/about/fullpage-desktop.png": encodePng(4, 4, red),
      "mysite/captures/about/fullpage-mobile.png": encodePng(4, 4, red),
    });
    try {
      await assert.rejects(
        () =>
          verifyPage({
            site: "mysite",
            runsDir: root,
            only: "about",
            screenshotFn: async () => encodePng(4, 4, red),
          }),
        /output\/pages\/about\.html|no output/i,
      );
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: thresholds override DEFAULT_PAGE_GATE",
  withSilencedStderr(async () => {
    // Half blue → 50% mismatch; default gate fails, overridden maxMismatchPct: 60 passes.
    const original = encodePng(8, 8, red);
    const generated = encodePng(8, 8, (x) => (x < 4 ? red() : blue()));
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
    });
    try {
      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "about",
        thresholds: { maxMismatchPct: 60, maxHeightDeltaPct: 50, maxAttempts: 3 },
        screenshotFn: async () => generated,
      });
      assert.equal(report.status, "pass");
      assert.equal(report.canHandoff, true);
    } finally {
      await cleanup();
    }
  }),
);

// ---------------------------------------------------------------------------
// defaultPageScreenshotFn — open → viewport(url) → reveal/scroll → shot
// ---------------------------------------------------------------------------

test(
  "defaultPageScreenshotFn: opens draft before setViewport(url), then reveal/scroll settle",
  withSilencedStderr(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verify-page-shot-"));
    const outPath = path.join(root, "out.png");
    const fileUrl = "file:///tmp/draft-about.html";
    const png = encodePng(4, 4, red);
    const calls = [];

    try {
      const abImpl = async (args, opts = {}) => {
        const action = args.filter((a) => !String(a).startsWith("--") && a !== "9223" && a !== "personal");
        calls.push({ kind: "ab", action, input: opts.input ?? null });
        if (action[0] === "get" && action[1] === "url") {
          return { stdout: "about:blank\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };

      const setViewportFn = async (opts) => {
        calls.push({ kind: "setViewport", opts });
      };

      const takeScreenshot = async () => {
        calls.push({ kind: "screenshot" });
        await writeFile(outPath, png);
      };

      const buf = await defaultPageScreenshotFn({
        width: 1440,
        windowHeight: 900,
        fileUrl,
        outPath,
        flags: ["--cdp", "9223", "--session", "personal"],
        cdp: 9223,
        session: "personal",
        slug: "about",
        abImpl,
        setViewportFn,
        resolveEndpoint: () => ({ host: "127.0.0.1", port: 9223 }),
        takeScreenshot,
      });

      assert.deepEqual(buf, png);

      const openIdx = calls.findIndex((c) => c.kind === "ab" && c.action[0] === "open" && c.action[1] === fileUrl);
      const viewportIdx = calls.findIndex((c) => c.kind === "setViewport");
      const revealIdx = calls.findIndex((c) => c.kind === "ab" && c.input === REVEAL_JS);
      const scrollIdx = calls.findIndex((c) => c.kind === "ab" && c.input === SCROLL_PASS_JS);
      const shotIdx = calls.findIndex((c) => c.kind === "screenshot");

      assert.ok(openIdx >= 0, "must open draft URL");
      assert.ok(viewportIdx > openIdx, "setViewport must run after open");
      assert.equal(calls[viewportIdx].opts.url, fileUrl);
      assert.equal(calls[viewportIdx].opts.width, 1440);
      assert.ok(revealIdx > viewportIdx, "REVEAL_JS after setViewport");
      assert.ok(scrollIdx > revealIdx, "SCROLL_PASS_JS after REVEAL_JS");
      assert.ok(shotIdx > scrollIdx, "screenshot after settle");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }),
);
