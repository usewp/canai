import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  access
} from "node:fs/promises";
import {
  tmpdir
} from "node:os";
import path from "node:path";
import {
  deflateSync
} from "node:zlib";
import {
  buildPageReport,
  verifyPage,
  formatSectionNote,
  scaleBoxToPng,
  rankSectionDiffs,
  mainBandCropBox
} from "./verifyPage.mjs";
import {
  nextAttemptState,
  DEFAULT_PAGE_GATE,
  GATE_PRESETS
} from "./pageGate.mjs";
import {
  severityScore
} from "./verify.mjs";
import {
  REVEAL_JS,
  SCROLL_PASS_JS
} from "./capture.mjs";

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

test("buildPageReport: advisory mode prints the mode and lists advisory reasons without failing", () => {
  const gate = { pass: true, advisory: true, advisoryReasons: ["desktop: mismatchPct 60 >= 50"], reasons: [], desktop: { pass: true, reasons: [] }, mobile: { pass: true, reasons: [] } };
  const { markdown, json } = buildPageReport({
    site: "example.com", slug: "about",
    desktop: { mismatchPct: 60, heightDeltaPct: 1 }, mobile: { mismatchPct: 10, heightDeltaPct: 1 },
    gate, attemptState: { status: "pass", attempts: 1, canHandoff: true, canRetry: false },
    thresholds: GATE_PRESETS.styled,
  });
  assert.match(markdown, /- mode: advisory/);
  assert.match(markdown, /### Advisory \(not enforced\)/);
  assert.match(markdown, /desktop: mismatchPct 60 >= 50/);
  assert.equal(json.gate.advisory, true);
  assert.equal(json.thresholds.mode, "advisory");
});

test("buildPageReport: wireframe preset prints mismatch threshold as 'none'", () => {
  const gate = { pass: true, reasons: [], desktop: { pass: true, reasons: [] }, mobile: { pass: true, reasons: [] } };
  const { markdown, json } = buildPageReport({
    site: "example.com", slug: "about",
    desktop: { mismatchPct: 80, heightDeltaPct: 1 }, mobile: { mismatchPct: 80, heightDeltaPct: 1 },
    gate, attemptState: { status: "pass", attempts: 1, canHandoff: true, canRetry: false },
    thresholds: GATE_PRESETS.wireframe,
  });
  assert.match(markdown, /mismatchPct < none/);
  assert.equal(json.thresholds.maxMismatchPct, null);
});

test("buildPageReport: advisory mode with no advisoryReasons omits the Advisory heading", () => {
  const gate = { pass: true, advisory: true, advisoryReasons: [], reasons: [], desktop: { pass: true, reasons: [] }, mobile: { pass: true, reasons: [] } };
  const { markdown, json } = buildPageReport({
    site: "example.com", slug: "about",
    desktop: { mismatchPct: 10, heightDeltaPct: 1 }, mobile: { mismatchPct: 5, heightDeltaPct: 1 },
    gate, attemptState: { status: "pass", attempts: 1, canHandoff: true, canRetry: false },
    thresholds: GATE_PRESETS.styled,
  });
  assert.match(markdown, /- mode: advisory/);
  assert.doesNotMatch(markdown, /### Advisory \(not enforced\)/);
  assert.equal(json.gate.advisory, true);
  assert.deepEqual(json.gate.advisoryReasons, []);
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

test(
  "verifyPage: thresholds override accepted explicitly under objective: pixel",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const generated = encodePng(8, 8, (x) => (x < 4 ? red() : blue())); // 50% mismatch
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
        objective: "pixel",
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

// --- advisory / height-only presets end-to-end (final-review Important 3) ---
// The advisory override lives in verifyPage (not evaluatePageGate), so the
// spec's "styled never fails on mismatch" claim has to be proven through
// verifyPage itself with real PNG fixtures, not just the buildPageReport
// string tests.

test(
  "verifyPage: styled objective at 50% mismatch → pass, gate.advisory, one advisoryReasons entry, attempt 1 of 1",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const halfBlue = encodePng(8, 8, (x) => (x < 4 ? red() : blue())); // exactly 50% mismatch
    const { root, cleanup } = await mkTree({
      "mysite/run.json": JSON.stringify({ objective: "styled", scope: "site", chrome: "inline" }),
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
    });
    try {
      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "about",
        // Desktop trips the advisory line (50 >= 50); mobile is identical.
        screenshotFn: async ({ width }) => (width === 1440 ? halfBlue : original),
      });
      assert.equal(report.status, "pass");
      assert.equal(report.canHandoff, true);
      assert.equal(report.attempts, 1);
      assert.equal(report.desktop.mismatchPct, 50);
      assert.equal(report.gate.pass, true);
      assert.equal(report.gate.advisory, true);
      assert.deepEqual(report.gate.reasons, []);
      assert.deepEqual(report.gate.advisoryReasons, ["desktop: mismatchPct 50 >= 50"]);
      assert.equal(report.thresholds.mode, "advisory");
      assert.equal(report.thresholds.maxAttempts, GATE_PRESETS.styled.maxAttempts);
      // Minor (final review): page-report.json must not contradict itself —
      // gate.pass true with a per-viewport pass:false underneath it.
      assert.equal(report.gate.desktop.pass, true, "per-viewport pass mirrors the advisory override");
      assert.equal(report.gate.mobile.pass, true);
      const md = await readFile(path.join(root, "mysite", "verify", "page-report.md"), "utf8");
      assert.match(md, /- mode: advisory/);
      assert.match(md, /### Advisory \(not enforced\)/);
      assert.doesNotMatch(md, /### Fail reasons/);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: wireframe objective at ~100% mismatch but 12.5% height delta → pass (height-only gate)",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const tallerBlue = encodePng(8, 9, blue); // 100% mismatch on the overlap, |8-9|/9 = 11.1% height Δ
    const { root, cleanup } = await mkTree({
      "mysite/run.json": JSON.stringify({ objective: "wireframe", scope: "page", chrome: "inline" }),
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
    });
    try {
      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "about",
        screenshotFn: async () => tallerBlue,
      });
      assert.equal(report.status, "pass");
      assert.equal(report.canHandoff, true);
      assert.equal(report.desktop.mismatchPct, 100);
      assert.ok(report.desktop.heightDeltaPct > 0 && report.desktop.heightDeltaPct <= 20, String(report.desktop.heightDeltaPct));
      assert.equal(report.gate.pass, true);
      assert.equal(report.gate.advisory, false, "height-only is a real gate, not advisory");
      assert.deepEqual(report.gate.reasons, []);
      assert.equal(report.thresholds.mode, "height-only");
      assert.equal(report.thresholds.maxMismatchPct, null);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: wireframe objective fails on height alone — 25% height delta trips the gate even with 0% mismatch",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const tooTall = encodePng(8, 12, red); // 0% mismatch on overlap, |8-12|/12 = 33% height Δ
    const { root, cleanup } = await mkTree({
      "mysite/run.json": JSON.stringify({ objective: "wireframe", scope: "page", chrome: "inline" }),
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
    });
    try {
      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "about",
        screenshotFn: async () => tooTall,
      });
      assert.equal(report.status, "in-progress", "attempt 1 of 2 — not a hard fail yet");
      assert.equal(report.canHandoff, false);
      assert.equal(report.desktop.mismatchPct, 0);
      assert.equal(report.gate.pass, false);
      assert.match(report.gate.reasons[0], /desktop: heightDeltaPct 33\.3 >= 20/);
    } finally {
      await cleanup();
    }
  }),
);

// --- attempt history already exhausted (dogfood bug 2) ----------------------
// nextAttemptState short-circuits on `pass` before the max-attempts check, so
// a 4th attempt that happened to pass would report canHandoff: true. The
// history must be refused up front — before any screenshot is read — and
// the message must say how to start a fresh one.

test(
  "verifyPage: prior attempts already at maxAttempts → refuses before screenshotting, names the reset paths",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const { root, cleanup } = await mkTree({
      "mysite/run.json": JSON.stringify({ objective: "pixel", scope: "page", chrome: "inline" }),
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
      "mysite/output/pages/about.page-mode.json": JSON.stringify({
        attempts: 3,
        status: "fail",
        failReason: "max-attempts",
        combinedSeverity: 200,
        scores: { desktop: { mismatchPct: 100, heightDeltaPct: 0 }, mobile: { mismatchPct: 100, heightDeltaPct: 0 } },
      }),
    });
    try {
      let shots = 0;
      await assert.rejects(
        () =>
          verifyPage({
            site: "mysite",
            runsDir: root,
            only: "about",
            screenshotFn: async () => {
              shots += 1;
              return original;
            },
          }),
        (e) => {
          assert.match(e.message, /page-verify: about already has 3 attempt\(s\) recorded \(max 3\)/);
          assert.match(e.message, /replica objective mysite --set/);
          assert.match(e.message, /output\/pages\/about\.page-mode\.json/);
          return true;
        },
      );
      assert.equal(shots, 0, "screenshotFn must never run on an exhausted history");
      // Nothing was written: no new report, meta untouched.
      const meta = JSON.parse(await readFile(path.join(root, "mysite", "output", "pages", "about.page-mode.json"), "utf8"));
      assert.equal(meta.attempts, 3);
      await assert.rejects(access(path.join(root, "mysite", "verify", "page-report.json")));
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: advisory (styled) never refuses on attempt count — maxAttempts 1 preset, attempt 2 still scores and passes",
  withSilencedStderr(async () => {
    const original = encodePng(8, 8, red);
    const { root, cleanup } = await mkTree({
      "mysite/run.json": JSON.stringify({ objective: "styled", scope: "site", chrome: "inline" }),
      "mysite/output/pages/about.html": "<html><body>x</body></html>",
      "mysite/captures/about/fullpage-desktop.png": original,
      "mysite/captures/about/fullpage-mobile.png": original,
      "mysite/output/pages/about.page-mode.json": JSON.stringify({ attempts: 1, status: "pass", combinedSeverity: 0 }),
    });
    try {
      const report = await verifyPage({ site: "mysite", runsDir: root, only: "about", screenshotFn: async () => original });
      assert.equal(report.status, "pass");
      assert.equal(report.attempts, 2);
    } finally {
      await cleanup();
    }
  }),
);

// --- --max-* override refusal outside `pixel` -------------------------------
// The refusal check runs before any capture/HTML file is touched, so an
// empty runs dir is enough — these never reach screenshotFn.

test("verifyPage: --max-* overrides are refused for objective styled", async () => {
  await assert.rejects(
    verifyPage({
      site: "mysite",
      runsDir: "runs-does-not-need-to-exist",
      only: "about",
      objective: "styled",
      thresholds: { maxMismatchPct: 60 },
      screenshotFn: async () => {
        throw new Error("screenshotFn must not run — refusal happens first");
      },
    }),
    /--max-\* overrides apply to the pixel objective only \(run\.json objective is "styled"\)/,
  );
});

test("verifyPage: --max-* overrides are refused for objective wireframe", async () => {
  await assert.rejects(
    verifyPage({
      site: "mysite",
      runsDir: "runs-does-not-need-to-exist",
      only: "about",
      objective: "wireframe",
      thresholds: { maxAttempts: 5 },
      screenshotFn: async () => {
        throw new Error("screenshotFn must not run — refusal happens first");
      },
    }),
    /--max-\* overrides apply to the pixel objective only \(run\.json objective is "wireframe"\)/,
  );
});

test("verifyPage: --max-* overrides are accepted (no refusal) for objective pixel, even with no fixtures yet", async () => {
  // Same early-refusal check, opposite branch: pixel + non-empty thresholds
  // must NOT throw the override-refusal error. It still throws — just the
  // later, unrelated "missing output/pages/*.html" error — proving control
  // flow passed the refusal check and moved on.
  await assert.rejects(
    verifyPage({
      site: "mysite",
      runsDir: "runs-does-not-need-to-exist",
      only: "about",
      objective: "pixel",
      thresholds: { maxMismatchPct: 60 },
    }),
    (e) => {
      assert.doesNotMatch(e.message, /--max-\* overrides apply to the pixel objective only/);
      assert.match(e.message, /missing output\/pages\/about\.html/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// defaultPageScreenshotFn — open → viewport(url) → reveal/scroll → shot
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// mainBandCropBox / chrome skip
// ---------------------------------------------------------------------------

test("mainBandCropBox: band between header bottom and footer top, scaled to device pixels", () => {
  const sections = [
    { id: "header", box: { left: 0, top: 0, width: 1440, height: 80 } },
    { id: "hero", box: { left: 0, top: 80, width: 1440, height: 600 } },
    { id: "footer", box: { left: 0, top: 3000, width: 1440, height: 400 } },
  ];
  const box = mainBandCropBox({ sections, pngWidth: 2880, pngHeight: 6800, cssWidth: 1440 });
  assert.deepEqual(box, { left: 0, top: 160, width: 2880, height: 5840 });
});

test("mainBandCropBox: throws loudly when a chrome box is missing", () => {
  const noFooter = [{ id: "header", box: { left: 0, top: 0, width: 390, height: 60 } }];
  assert.throws(
    () => mainBandCropBox({ sections: noFooter, pngWidth: 390, pngHeight: 2000, cssWidth: 390 }),
    /chrome skip: capture has no "footer" box/,
  );
  assert.throws(
    () => mainBandCropBox({ sections: [], pngWidth: 390, pngHeight: 2000, cssWidth: 390 }),
    /chrome skip: capture has no "header" box/,
  );
});

test("buildPageReport: chrome skip prints the crop bands", () => {
  const gate = { pass: true, reasons: [], desktop: { pass: true, reasons: [] }, mobile: { pass: true, reasons: [] } };
  const { markdown, json } = buildPageReport({
    site: "example.com", slug: "about",
    desktop: { mismatchPct: 1, heightDeltaPct: 1 }, mobile: { mismatchPct: 1, heightDeltaPct: 1 },
    gate, attemptState: { status: "pass", attempts: 1, canHandoff: true, canRetry: false },
    chrome: "skip",
    cropBands: { desktop: { top: 160, height: 5840 }, mobile: { top: 120, height: 3900 } },
  });
  assert.match(markdown, /- chrome: skip \(capture cropped to main band — desktop y 160\+5840, mobile y 120\+3900\)/);
  assert.equal(json.chrome, "skip");
  assert.deepEqual(json.cropBands.mobile, { top: 120, height: 3900 });
});

// ---------------------------------------------------------------------------
// verifyPage — chrome skip end-to-end (main-band crop, offset section notes,
// meta/report chrome fields). Reviewer finding on 707957f: the pipeline
// wiring (readSections/mainBandCropBox/cropBands/boxOffsetTop/excludeIds/
// meta.chrome) was only exercised by the pure mainBandCropBox + buildPageReport
// string tests, never through verifyPage itself.
// ---------------------------------------------------------------------------

const CHROME_SKIP_DESKTOP_SECTIONS = {
  sections: [
    { id: "header", box: { left: 0, top: 0, width: 1440, height: 10 } },
    { id: "hero", role: "hero", box: { left: 0, top: 10, width: 1440, height: 20 }, file: "sections-desktop/01-hero.png" },
    { id: "footer", box: { left: 0, top: 30, width: 1440, height: 10 } },
  ],
};
const CHROME_SKIP_MOBILE_SECTIONS = {
  sections: [
    { id: "header", box: { left: 0, top: 0, width: 390, height: 8 } },
    { id: "hero", role: "hero", box: { left: 0, top: 8, width: 390, height: 12 }, file: "sections-mobile/01-hero.png" },
    { id: "footer", box: { left: 0, top: 20, width: 390, height: 8 } },
  ],
};

function chromeSkipRunJson() {
  return JSON.stringify({
    objective: "pixel",
    scope: "page",
    chrome: "skip",
    setAt: new Date().toISOString(),
    setBy: "user",
  });
}

test(
  "verifyPage: chrome skip — crops the capture to the main band, offsets section notes, and records chrome everywhere",
  withSilencedStderr(async () => {
    // 1440-wide desktop capture: header rows 0-9, main (hero) rows 10-29, footer rows 30-39.
    const desktopCapture = encodePng(1440, 40, (x, y) => (y < 10 || y >= 30 ? red() : blue()));
    // 390-wide mobile capture: header rows 0-7, main (hero) rows 8-19, footer rows 20-27.
    const mobileCapture = encodePng(390, 28, (x, y) => (y < 8 || y >= 20 ? red() : blue()));
    // Generated draft screenshots are <main>-only — exactly the main band, all blue.
    const desktopGenerated = encodePng(1440, 20, blue);
    const mobileGenerated = encodePng(390, 12, blue);
    const heroCapDesktop = encodePng(1440, 20, blue);
    const heroCapMobile = encodePng(390, 12, blue);

    const { root, cleanup } = await mkTree({
      "mysite/run.json": chromeSkipRunJson(),
      "mysite/output/pages/pricing.html": "<html><body><main>m</main></body></html>",
      "mysite/captures/pricing/fullpage-desktop.png": desktopCapture,
      "mysite/captures/pricing/fullpage-mobile.png": mobileCapture,
      "mysite/captures/pricing/sections-desktop.json": JSON.stringify(CHROME_SKIP_DESKTOP_SECTIONS),
      "mysite/captures/pricing/sections-mobile.json": JSON.stringify(CHROME_SKIP_MOBILE_SECTIONS),
      "mysite/captures/pricing/sections-desktop/01-hero.png": heroCapDesktop,
      "mysite/captures/pricing/sections-mobile/01-hero.png": heroCapMobile,
    });
    try {
      const report = await verifyPage({
        site: "mysite",
        runsDir: root,
        only: "pricing",
        screenshotFn: async ({ width }) => (width === 1440 ? desktopGenerated : mobileGenerated),
      });

      // Gate: capture is cropped to the main band before scoring, so a
      // main-only draft that matches the band exactly passes cleanly.
      assert.equal(report.status, "pass", JSON.stringify(report.gate));
      assert.equal(report.desktop.mismatchPct, 0);
      assert.equal(report.desktop.heightDeltaPct, 0);
      assert.equal(report.mobile.mismatchPct, 0);
      assert.equal(report.mobile.heightDeltaPct, 0);

      // Report carries chrome + the exact crop bands (mainBandCropBox output).
      assert.equal(report.chrome, "skip");
      assert.deepEqual(report.cropBands, {
        desktop: { top: 10, height: 20 },
        mobile: { top: 8, height: 12 },
      });

      // sectionNotes: header/footer excluded; hero survives and scores clean
      // — only possible if boxOffsetTop correctly re-anchored its box (top 10
      // in the ORIGINAL capture's coordinates) to top 0 in the cropped/
      // generated main-only image. An unshifted (wrong) offset would still
      // slice *something* (clamped short) with mismatchPct 0 against a
      // uniformly-blue capture, so heightDeltaPct is the assertion that
      // actually catches it: the hero box is exactly the generated image's
      // full height (20 desktop / 12 mobile) only when correctly re-anchored
      // to top 0 — an unshifted box clips to a shorter overlap and reports a
      // nonzero heightDeltaPct.
      assert.ok(report.sectionNotes.length >= 1, "hero should survive as a note");
      for (const n of report.sectionNotes) {
        assert.notEqual(n.id, "header");
        assert.notEqual(n.id, "footer");
        assert.equal(n.id, "hero");
        assert.equal(n.mismatchPct, 0);
        assert.equal(n.heightDeltaPct, 0);
      }
      const viewports = report.sectionNotes.map((n) => n.viewport).sort();
      assert.deepEqual(viewports, ["desktop", "mobile"]);

      // page-mode.json meta carries chrome (belt-and-braces for handoff-page).
      const meta = JSON.parse(
        await readFile(path.join(root, "mysite", "output", "pages", "pricing.page-mode.json"), "utf8"),
      );
      assert.equal(meta.chrome, "skip");

      // verify/page-report.json on disk matches the returned report.
      const onDisk = JSON.parse(
        await readFile(path.join(root, "mysite", "verify", "page-report.json"), "utf8"),
      );
      assert.equal(onDisk.chrome, "skip");
      assert.deepEqual(onDisk.cropBands, report.cropBands);
    } finally {
      await cleanup();
    }
  }),
);

test(
  "verifyPage: chrome skip — a viewport's section index missing the footer box throws loudly (not lenient)",
  withSilencedStderr(async () => {
    const desktopCapture = encodePng(1440, 40, (x, y) => (y < 10 || y >= 30 ? red() : blue()));
    const mobileCapture = encodePng(390, 28, (x, y) => (y < 8 || y >= 20 ? red() : blue()));
    const desktopGenerated = encodePng(1440, 20, blue);
    const mobileGenerated = encodePng(390, 12, blue);
    const heroCapDesktop = encodePng(1440, 20, blue);

    const { root, cleanup } = await mkTree({
      "mysite/run.json": chromeSkipRunJson(),
      "mysite/output/pages/pricing.html": "<html><body><main>m</main></body></html>",
      "mysite/captures/pricing/fullpage-desktop.png": desktopCapture,
      "mysite/captures/pricing/fullpage-mobile.png": mobileCapture,
      "mysite/captures/pricing/sections-desktop.json": JSON.stringify(CHROME_SKIP_DESKTOP_SECTIONS),
      // Mobile section index is missing the footer box entirely.
      "mysite/captures/pricing/sections-mobile.json": JSON.stringify({
        sections: [{ id: "header", box: { left: 0, top: 0, width: 390, height: 8 } }],
      }),
      "mysite/captures/pricing/sections-desktop/01-hero.png": heroCapDesktop,
    });
    try {
      await assert.rejects(
        () =>
          verifyPage({
            site: "mysite",
            runsDir: root,
            only: "pricing",
            screenshotFn: async ({ width }) => (width === 1440 ? desktopGenerated : mobileGenerated),
          }),
        /chrome skip: capture has no "footer" box/,
      );
    } finally {
      await cleanup();
    }
  }),
);
