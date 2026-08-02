import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "./pngSlice.mjs";
import {
  PAGE_WIDTHS,
  buildViewportsJson,
  writePageModeArtifacts,
  assertFullPagePng,
  capturePageMode,
} from "./pageCapture.mjs";
import { capture } from "./capture.mjs";

function solid(w, h, [r, g, b, a = 255]) {
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return encodePngRgba(w, h, pixels);
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

test("PAGE_WIDTHS matches page-mode spec", () => {
  assert.deepEqual(PAGE_WIDTHS, { desktop: 1440, mobile: 390 });
});

test("buildViewportsJson shapes viewports.json fields", () => {
  const out = buildViewportsJson({
    desktop: { width: 1440, windowHeight: 900, scrollHeight: 3200 },
    mobile: { width: 390, windowHeight: 844, scrollHeight: 5100 },
  });
  assert.deepEqual(out, {
    desktop: { width: 1440, windowHeight: 900 },
    mobile: { width: 390, windowHeight: 844 },
    scrollHeightDesktop: 3200,
    scrollHeightMobile: 5100,
    sliceMethod: "fullpage-png",
  });
});

test("writePageModeArtifacts writes dual-width tree; sections.json uses sections/ paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "page-capture-"));
  const captureDir = path.join(root, "captures", "about");
  try {
    const desktopPng = solid(8, 8, [200, 10, 10, 255]);
    const mobilePng = solid(4, 6, [10, 10, 200, 255]);
    const desktopSections = [
      {
        id: "hero",
        role: "hero",
        tag: "section",
        className: "hero",
        fileName: "01-hero.png",
        buffer: solid(8, 4, [200, 10, 10, 255]),
        box: { left: 0, top: 0, width: 8, height: 4 },
      },
      {
        id: "footer",
        role: "footer",
        tag: "footer",
        className: null,
        fileName: "02-footer.png",
        buffer: solid(8, 4, [100, 100, 100, 255]),
        box: { left: 0, top: 4, width: 8, height: 4 },
      },
    ];
    const mobileSections = [
      {
        id: "hero",
        role: "hero",
        tag: "section",
        className: "hero",
        fileName: "01-hero.png",
        buffer: solid(4, 3, [10, 10, 200, 255]),
        box: { left: 0, top: 0, width: 4, height: 3 },
      },
    ];
    const viewports = buildViewportsJson({
      desktop: { width: 1440, windowHeight: 900, scrollHeight: 8 },
      mobile: { width: 390, windowHeight: 844, scrollHeight: 6 },
    });
    const libs = { libraries: [], advisory: "test" };

    await writePageModeArtifacts(captureDir, {
      fullpageDesktopPng: desktopPng,
      fullpageMobilePng: mobilePng,
      desktopSections,
      mobileSections,
      viewports,
      libs,
    });

    await access(path.join(captureDir, "fullpage-desktop.png"));
    await access(path.join(captureDir, "fullpage-mobile.png"));
    await access(path.join(captureDir, "screenshot.png"));
    await access(path.join(captureDir, "viewports.json"));
    await access(path.join(captureDir, "libs.json"));
    await access(path.join(captureDir, "sections-desktop", "01-hero.png"));
    await access(path.join(captureDir, "sections-mobile", "01-hero.png"));
    await access(path.join(captureDir, "sections", "01-hero.png"));

    const shot = await readFile(path.join(captureDir, "screenshot.png"));
    assert.deepEqual(shot, desktopPng);

    const desktopJson = JSON.parse(await readFile(path.join(captureDir, "sections-desktop.json"), "utf8"));
    const compatJson = JSON.parse(await readFile(path.join(captureDir, "sections.json"), "utf8"));
    assert.equal(desktopJson.sections.length, 2);
    assert.equal(desktopJson.sections[0].file, "sections-desktop/01-hero.png");
    assert.deepEqual(desktopJson.sections[0].box, { left: 0, top: 0, width: 8, height: 4 });
    // Compat JSON keeps desktop metadata but rewrites file paths to sections/.
    assert.equal(compatJson.sections.length, 2);
    assert.equal(compatJson.sections[0].file, "sections/01-hero.png");
    assert.equal(compatJson.sections[1].file, "sections/02-footer.png");
    assert.deepEqual(compatJson.sections[0].box, desktopJson.sections[0].box);
    assert.notEqual(compatJson.sections[0].file, desktopJson.sections[0].file);

    const mobileJson = JSON.parse(await readFile(path.join(captureDir, "sections-mobile.json"), "utf8"));
    assert.equal(mobileJson.sections[0].file, "sections-mobile/01-hero.png");

    const vp = JSON.parse(await readFile(path.join(captureDir, "viewports.json"), "utf8"));
    assert.equal(vp.sliceMethod, "fullpage-png");
    assert.equal(vp.desktop.width, 1440);

    const sectionFiles = await readdir(path.join(captureDir, "sections"));
    assert.ok(sectionFiles.includes("01-hero.png"));
    assert.ok(sectionFiles.includes("02-footer.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writePageModeArtifacts fails loud when all slices fail", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "page-capture-fail-"));
  const captureDir = path.join(root, "captures", "bad");
  try {
    await assert.rejects(
      () =>
        writePageModeArtifacts(captureDir, {
          fullpageDesktopPng: solid(4, 4, [1, 2, 3, 255]),
          fullpageMobilePng: solid(4, 4, [1, 2, 3, 255]),
          desktopSections: [
            {
              id: "bad",
              fileName: "01-bad.png",
              buffer: null,
              box: { left: 0, top: 0, width: 0, height: 0 },
              error: "invalid or empty crop box after clamp",
            },
          ],
          mobileSections: [
            {
              id: "bad",
              fileName: "01-bad.png",
              buffer: null,
              box: { left: 0, top: 0, width: 0, height: 0 },
              error: "invalid or empty crop box after clamp",
            },
          ],
          viewports: buildViewportsJson({
            desktop: { width: 1440, windowHeight: 900, scrollHeight: 4 },
            mobile: { width: 390, windowHeight: 844, scrollHeight: 4 },
          }),
          libs: { libraries: [] },
        }),
      /all slices failed|all section slices failed/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertFullPagePng rejects zero-height / blank buffers", () => {
  assert.throws(() => assertFullPagePng(Buffer.alloc(0), "desktop"), /blank|empty|zero/i);
  const transparent = encodePngRgba(2, 2, new Uint8Array(2 * 2 * 4));
  assert.throws(() => assertFullPagePng(transparent, "mobile"), /blank/i);
  assert.doesNotThrow(() => assertFullPagePng(solid(2, 2, [10, 20, 30, 255]), "desktop"));
});

test(
  "capturePageMode uses injectable seams (no live browser) and writes page-mode layout",
  withSilencedStderr(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "page-capture-orch-"));
    try {
      const desktopPng = solid(8, 10, [220, 30, 30, 255]);
      const mobilePng = solid(4, 8, [30, 30, 220, 255]);
      const desktopSectionsMeta = [
        {
          id: "hero",
          role: "hero",
          tag: "section",
          className: "hero",
          left: 0,
          top: 0,
          width: 8,
          height: 5,
        },
        {
          id: "footer",
          role: "footer",
          tag: "footer",
          className: null,
          left: 0,
          top: 5,
          width: 8,
          height: 5,
        },
      ];
      const mobileSectionsMeta = [
        {
          id: "hero",
          role: "hero",
          tag: "section",
          className: "hero",
          left: 0,
          top: 0,
          width: 4,
          height: 4,
        },
      ];

      let widthCalls = [];
      const result = await capturePageMode({
        url: "https://example.com/about/",
        runsDir: path.join(root, "runs"),
        site: "example.com",
        cdp: 9223,
        session: "personal",
        deps: {
          ab: async () => ({ stdout: "{}" }),
          ensureWorkingTab: async () => {},
          ensureUnemulatedViewport: async () => {},
          setViewport: async ({ width, height }) => {
            widthCalls.push({ width, height });
          },
          resolveSessionCdpEndpoint: () => ({ host: "127.0.0.1", port: 9223 }),
          captureFullPageScreenshot: async ({ width, outPath }) => {
            const buf = width === 1440 ? desktopPng : mobilePng;
            const { writeFile } = await import("node:fs/promises");
            await writeFile(outPath, buf);
            return { width, height: width === 1440 ? 10 : 8, requestedHeight: width === 1440 ? 10 : 8, capped: false };
          },
          measurePageSize: async ({ width }) => ({
            width,
            height: width === 1440 ? 10 : 8,
          }),
          evalSections: async ({ width }) => ({
            sections: width === 1440 ? desktopSectionsMeta : mobileSectionsMeta,
          }),
          collectPageExtras: async ({ captureDir }) => {
            const { writeFile, mkdir } = await import("node:fs/promises");
            await mkdir(captureDir, { recursive: true });
            await writeFile(path.join(captureDir, "content.json"), "{}");
            await writeFile(path.join(captureDir, "styles.json"), JSON.stringify({ desktop: {}, mobile: {} }));
            await writeFile(path.join(captureDir, "ux.json"), JSON.stringify({ patterns: [] }));
            await writeFile(path.join(captureDir, "dom.html"), "<html></html>");
            await writeFile(
              path.join(captureDir, "assets.json"),
              JSON.stringify({ scripts: ["https://cdn.example/swiper.min.js"], stylesheets: [], images: [] }),
            );
            return {
              scriptUrls: ["https://cdn.example/swiper.min.js"],
              stylesheetUrls: [],
              classNames: ["swiper"],
              html: "<div class='swiper'></div>",
            };
          },
        },
      });

      assert.equal(result.slug, "about");
      assert.equal(result.ok, true);
      assert.deepEqual(
        widthCalls.map((c) => c.width),
        [1440, 390],
      );

      const captureDir = path.join(root, "runs", "example.com", "captures", "about");
      await access(path.join(captureDir, "fullpage-desktop.png"));
      await access(path.join(captureDir, "fullpage-mobile.png"));
      await access(path.join(captureDir, "sections-desktop.json"));
      await access(path.join(captureDir, "libs.json"));
      const libs = JSON.parse(await readFile(path.join(captureDir, "libs.json"), "utf8"));
      assert.ok(libs.libraries.some((l) => l.name === "swiper"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }),
);

test(
  "capture({ pageUrl }) skips worklist and runs page mode once",
  withSilencedStderr(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "page-capture-wire-"));
    let called = null;
    try {
      const r = await capture({
        site: "example.com",
        runsDir: path.join(root, "runs"),
        pageUrl: "https://example.com/pricing/",
        capturePageModeImpl: async (args) => {
          called = args;
          return { slug: "pricing", url: args.url, captureDir: "/tmp/x", ok: true };
        },
      });
      assert.ok(called);
      assert.equal(called.url, "https://example.com/pricing/");
      assert.equal(r.count, 1);
      assert.equal(r.ok, 1);
      assert.equal(r.results[0].slug, "pricing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }),
);
