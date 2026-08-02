import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  buildPageReport,
  verifyPage,
  defaultPageScreenshotFn,
  formatSectionNote,
  scaleBoxToPng,
  rankSectionDiffs,
} from "./verifyPage.mjs";
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

test("buildPageReport: formats structured sectionNotes in markdown", () => {
  const attemptState = nextAttemptState({ attempts: 1, pass: false });
  const { markdown, json } = buildPageReport({
    site: "s.com",
    slug: "home",
    desktop: { mismatchPct: 20, heightDeltaPct: 5 },
    mobile: { mismatchPct: 10, heightDeltaPct: 2 },
    gate: { pass: false, reasons: ["desktop: mismatchPct 20 >= 15"], desktop: { pass: false, reasons: [] }, mobile: { pass: true, reasons: [] } },
    attemptState,
    sectionNotes: [
      {
        viewport: "desktop",
        id: "hero",
        role: "hero",
        mismatchPct: 42.1,
        heightDeltaPct: 8.3,
        severity: 44.59,
        file: "sections-desktop/04-hero.png",
      },
    ],
  });
  assert.equal(json.sectionNotes[0].id, "hero");
  assert.match(markdown, /Section notes \(worst first/);
  assert.match(markdown, /desktop\/hero: mismatch 42\.1%, height Δ 8\.3%/);
});

// ---------------------------------------------------------------------------
// rankSectionDiffs / scaleBoxToPng / formatSectionNote
// ---------------------------------------------------------------------------

test("formatSectionNote: string passthrough + structured line", () => {
  assert.equal(formatSectionNote("hero looks truncated"), "hero looks truncated");
  assert.match(
    formatSectionNote({
      viewport: "mobile",
      id: "cta",
      mismatchPct: 12.5,
      heightDeltaPct: 3,
      severity: 13.4,
    }),
    /mobile\/cta: mismatch 12\.5%, height Δ 3% \(severity 13\.4\)/,
  );
});

test("scaleBoxToPng: 2× device pixels", () => {
  assert.deepEqual(
    scaleBoxToPng({ left: 10, top: 20, width: 100, height: 50 }, 2880, 1440),
    { left: 20, top: 40, width: 200, height: 100 },
  );
});

test("rankSectionDiffs: worst section first; scales CSS boxes to PNG", () => {
  // Generated: left half blue, right half red (100×50 CSS = 100×50 PNG).
  const generated = encodePng(100, 50, (x) => (x < 50 ? blue() : red()));
  const heroCap = encodePng(50, 50, red); // vs blue → high mismatch
  const footCap = encodePng(50, 50, red); // vs red → low mismatch

  const ranked = rankSectionDiffs({
    generatedPngBuf: generated,
    cssWidth: 100,
    viewport: "desktop",
    topN: 5,
    sections: [
      { id: "footer", role: "footer", box: { left: 50, top: 0, width: 50, height: 50 }, file: "sections-desktop/02-footer.png" },
      { id: "hero", role: "hero", box: { left: 0, top: 0, width: 50, height: 50 }, file: "sections-desktop/01-hero.png" },
    ],
    sectionPngs: {
      "sections-desktop/01-hero.png": heroCap,
      "sections-desktop/02-footer.png": footCap,
    },
  });

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, "hero");
  assert.equal(ranked[0].viewport, "desktop");
  assert.ok(ranked[0].mismatchPct > ranked[1].mismatchPct);
  assert.ok(ranked[0].severity > ranked[1].severity);
  assert.equal(ranked[1].id, "footer");
});

test("rankSectionDiffs: 2× PNG scales CSS box before crop", () => {
  // CSS 50×25 page; PNG is 100×50 (2×). Left half blue at device pixels.
  const generated = encodePng(100, 50, (x) => (x < 50 ? blue() : red()));
  const heroCap = encodePng(50, 50, red); // device-pixel crop of left half

  const ranked = rankSectionDiffs({
    generatedPngBuf: generated,
    cssWidth: 50,
    viewport: "desktop",
    topN: 1,
    sections: [
      { id: "hero", box: { left: 0, top: 0, width: 25, height: 25 }, file: "sections-desktop/hero.png" },
    ],
    sectionPngs: { "sections-desktop/hero.png": heroCap },
  });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "hero");
  assert.ok(ranked[0].mismatchPct > 50);
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
      assert.deepEqual(report.sectionNotes, []);

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
  "verifyPage: auto-ranks sectionNotes from capture slices when present",
  withSilencedStderr(async () => {
    // 8×8: left blue / right red. Capture fullpages match generated (gate pass).
    // PAGE_WIDTHS.desktop is 1440 → scale = 8/1440; CSS boxes map half-width → 4px.
    const desktopPng = encodePng(8, 8, (x) => (x < 4 ? blue() : red()));
    const mobilePng = encodePng(4, 6, red);
    const heroCap = encodePng(4, 8, red); // vs blue left → high mismatch
    const footCap = encodePng(4, 8, red); // vs red right → low mismatch
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/home.html": "<html><body>ok</body></html>",
      "mysite/captures/home/fullpage-desktop.png": desktopPng,
      "mysite/captures/home/fullpage-mobile.png": mobilePng,
      "mysite/captures/home/sections-desktop.json": JSON.stringify({
        sections: [
          {
            id: "footer",
            role: "footer",
            box: { left: 720, top: 0, width: 720, height: 1440 },
            file: "sections-desktop/02-footer.png",
          },
          {
            id: "hero",
            role: "hero",
            box: { left: 0, top: 0, width: 720, height: 1440 },
            file: "sections-desktop/01-hero.png",
          },
        ],
      }),
      "mysite/captures/home/sections-desktop/01-hero.png": heroCap,
      "mysite/captures/home/sections-desktop/02-footer.png": footCap,
    });
    try {
      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "home",
        screenshotFn: async ({ width }) => (width === 1440 ? desktopPng : mobilePng),
      });
      assert.ok(report.sectionNotes.length >= 1);
      assert.equal(report.sectionNotes[0].id, "hero");
      assert.equal(report.sectionNotes[0].viewport, "desktop");
      assert.ok(report.sectionNotes[0].mismatchPct > 50);
      const md = await readFile(path.join(root, "mysite", "verify", "page-report.md"), "utf8");
      assert.match(md, /desktop\/hero/);
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
        // Prior attempt already improved a lot vs attempt 1 — avoid stagnant
        // so this test exercises max-attempts, not stagnation.
        combinedSeverity: 200,
        scores: {
          desktop: { mismatchPct: 100, heightDeltaPct: 0 },
          mobile: { mismatchPct: 100, heightDeltaPct: 0 },
        },
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
        /fail|page.?verify|gate|max-attempts/i,
      );

      const meta = JSON.parse(
        await readFile(path.join(root, "mysite", "output", "pages", "about.page-mode.json"), "utf8"),
      );
      assert.equal(meta.status, "fail");
      assert.equal(meta.attempts, 3);
      assert.equal(meta.failReason, "max-attempts");

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
  "verifyPage: stagnant second attempt → early fail without burning attempt 3",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const generated = encodePng(8, 8, blue); // ~100% mismatch both times
    const { root, cleanup } = await mkTree({
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
      "mysite/output/pages/about.page-mode.json": JSON.stringify({
        attempts: 1,
        status: "in-progress",
        combinedSeverity: 200,
        scores: {
          desktop: { mismatchPct: 100, heightDeltaPct: 0 },
          mobile: { mismatchPct: 100, heightDeltaPct: 0 },
        },
        history: [
          {
            attempt: 1,
            combinedSeverity: 200,
            status: "in-progress",
          },
        ],
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
        /stagnant/i,
      );

      const meta = JSON.parse(
        await readFile(path.join(root, "mysite", "output", "pages", "about.page-mode.json"), "utf8"),
      );
      assert.equal(meta.status, "fail");
      assert.equal(meta.attempts, 2);
      assert.equal(meta.stagnant, true);
      assert.equal(meta.failReason, "stagnant");
      assert.equal(meta.history.length, 2);

      const md = await readFile(path.join(root, "mysite", "verify", "page-report.md"), "utf8");
      assert.match(md, /Stagnation/i);
      assert.match(md, /Do \*\*not\*\* raise/);
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
