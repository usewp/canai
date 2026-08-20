// Page-mode capture: dual-width full-page PNGs + section slices.
// Pure/fs helpers are unit-testable without a browser; capturePageMode accepts
// injectable deps so orchestration tests never need Chrome.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { decodePng } from "./pngdiff.mjs";
import { sliceSections } from "./pngSlice.mjs";
import { detectLibs } from "./libsDetect.mjs";
import { siteFromUrl, urlToSlug } from "./slug.mjs";
import { resetSectionsDir } from "./capture.mjs";

export const PAGE_WIDTHS = { desktop: 1440, mobile: 390 };

export const PAGE_WINDOW_HEIGHTS = { desktop: 900, mobile: 844 };

// Desktop SECTIONS_JS stamps data-capture-id on landmarks. Mobile (and any
// later width pass) must clear those before re-tagging — otherwise tag()
// skips every element and writePageModeArtifacts fails with
// "all section slices failed for mobile" (or silently under-slices).
export const CLEAR_CAPTURE_IDS_JS = `(() => {
  document.querySelectorAll('[data-capture-id]').forEach((el) => el.removeAttribute('data-capture-id'));
  return { cleared: true };
})();`;

export function buildViewportsJson({ desktop, mobile }) {
  return {
    desktop: { width: desktop.width, windowHeight: desktop.windowHeight },
    mobile: { width: mobile.width, windowHeight: mobile.windowHeight },
    scrollHeightDesktop: desktop.scrollHeight,
    scrollHeightMobile: mobile.scrollHeight,
    sliceMethod: "fullpage-png",
  };
}

/** Max RGB channel range (0–255) still treated as a near-uniform blank frame. */
export const BLANK_NEAR_UNIFORM_RANGE = 12;

/**
 * True when opaque pixels are all nearly the same color (solid white, solid
 * gray, failed screenshot fill, etc.). Transparent-only frames are blank too.
 * Exported for unit tests.
 */
export function isBlankFullPagePixels(pixels) {
  let opaque = 0;
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    opaque++;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (r < minR) minR = r;
    if (g < minG) minG = g;
    if (b < minB) minB = b;
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
  }
  if (opaque === 0) return true;
  return (
    maxR - minR <= BLANK_NEAR_UNIFORM_RANGE &&
    maxG - minG <= BLANK_NEAR_UNIFORM_RANGE &&
    maxB - minB <= BLANK_NEAR_UNIFORM_RANGE
  );
}

/** Fail loud on empty / zero-size / transparent / near-uniform full-page PNGs. */
export function assertFullPagePng(pngBuf, label = "full-page") {
  if (!pngBuf || pngBuf.length === 0) {
    throw new Error(`${label}: empty full-page PNG buffer`);
  }
  let width;
  let height;
  let pixels;
  try {
    ({ width, height, pixels } = decodePng(pngBuf));
  } catch (e) {
    throw new Error(`${label}: invalid PNG (${e.message})`);
  }
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`${label}: zero-size full-page (${width}x${height})`);
  }
  if (!isBlankFullPagePixels(pixels)) return;
  throw new Error(`${label}: blank full-page (transparent or near-uniform)`);
}

/**
 * Ensure runs/<site>/pages.json lists this URL so designmd/transform can run
 * without a prior discover. Merges into an existing worklist when present.
 */
export async function seedPageModeWorklist(runDir, { site, url }) {
  await mkdir(runDir, { recursive: true });
  const outPath = path.join(runDir, "pages.json");
  let existing = null;
  try {
    existing = JSON.parse(await readFile(outPath, "utf8"));
  } catch {
    // First page-mode capture — no discover yet.
  }
  const pages = Array.isArray(existing?.pages) ? [...existing.pages] : [];
  if (!pages.some((p) => p && p.url === url)) {
    pages.push({ url, source: "page-mode" });
  }
  const payload = {
    site: existing?.site || site,
    source: existing?.source || "page-mode",
    sitemap: existing?.sitemap ?? null,
    pages,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

export function sectionJsonEntry(section, dirPrefix) {
  const box = section.box || {
    left: section.left,
    top: section.top,
    width: section.width,
    height: section.height,
  };
  const fileName = section.fileName;
  const ok = Boolean(section.buffer);
  return {
    id: section.id,
    role: section.role ?? null,
    tag: section.tag ?? null,
    className: section.className ?? null,
    elementId: section.elementId ?? null,
    box,
    file: ok && fileName ? path.join(dirPrefix, fileName) : null,
    error: section.error ?? (ok ? null : "slice failed"),
  };
}

export async function writeSectionPngs(dir, sections) {
  await resetSectionsDir(dir);
  for (const section of sections) {
    if (section.buffer && section.fileName) {
      await writeFile(path.join(dir, section.fileName), section.buffer);
    }
  }
}

function allSlicesFailed(sections) {
  return !sections?.length || sections.every((s) => !s.buffer);
}

/**
 * Write page-mode capture artifacts (full-pages, section dirs/json, viewports, libs).
 * Compatibility: `sections/` PNGs mirror desktop files; `sections.json` mirrors
 * desktop section metadata with `file` paths rewritten to `sections/…` for older
 * readers that expect that prefix (not a byte-copy of sections-desktop.json).
 */
export async function writePageModeArtifacts(
  captureDir,
  { fullpageDesktopPng, fullpageMobilePng, desktopSections, mobileSections, viewports, libs },
) {
  assertFullPagePng(fullpageDesktopPng, "fullpage-desktop");
  assertFullPagePng(fullpageMobilePng, "fullpage-mobile");

  if (allSlicesFailed(desktopSections) && allSlicesFailed(mobileSections)) {
    throw new Error("all section slices failed for both desktop and mobile");
  }
  if (allSlicesFailed(desktopSections)) {
    throw new Error("all section slices failed for desktop");
  }
  if (allSlicesFailed(mobileSections)) {
    throw new Error("all section slices failed for mobile");
  }

  await mkdir(captureDir, { recursive: true });
  await writeFile(path.join(captureDir, "fullpage-desktop.png"), fullpageDesktopPng);
  await writeFile(path.join(captureDir, "fullpage-mobile.png"), fullpageMobilePng);
  await writeFile(path.join(captureDir, "screenshot.png"), fullpageDesktopPng);

  await writeSectionPngs(path.join(captureDir, "sections-desktop"), desktopSections);
  await writeSectionPngs(path.join(captureDir, "sections-mobile"), mobileSections);
  await writeSectionPngs(path.join(captureDir, "sections"), desktopSections);

  const desktopJson = {
    sections: desktopSections.map((s) => sectionJsonEntry(s, "sections-desktop")),
  };
  const mobileJson = {
    sections: mobileSections.map((s) => sectionJsonEntry(s, "sections-mobile")),
  };
  const compatJson = {
    sections: desktopSections.map((s) => sectionJsonEntry(s, "sections")),
  };
  await writeFile(path.join(captureDir, "sections-desktop.json"), JSON.stringify(desktopJson, null, 2));
  await writeFile(path.join(captureDir, "sections-mobile.json"), JSON.stringify(mobileJson, null, 2));
  await writeFile(path.join(captureDir, "sections.json"), JSON.stringify(compatJson, null, 2));

  await writeFile(path.join(captureDir, "viewports.json"), JSON.stringify(viewports, null, 2));
  await writeFile(path.join(captureDir, "libs.json"), JSON.stringify(libs, null, 2));
}

function mergeSliceMeta(metaSections, slices) {
  return slices.map((slice, i) => {
    const meta = metaSections[i] || {};
    return {
      ...meta,
      ...slice,
      role: meta.role ?? slice.role ?? null,
      tag: meta.tag ?? null,
      className: meta.className ?? null,
      elementId: meta.elementId ?? null,
    };
  });
}

