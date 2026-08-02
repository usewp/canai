// Page-mode capture: dual-width full-page PNGs + section slices.
// Pure/fs helpers are unit-testable without a browser; capturePageMode accepts
// injectable deps so orchestration tests never need Chrome.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { decodePng } from "./pngdiff.mjs";
import { sliceSections } from "./pngSlice.mjs";
import { detectLibs } from "./libsDetect.mjs";
import { siteFromUrl, urlToSlug } from "./slug.mjs";
import { captureFullPageScreenshot, setViewport } from "./cdp.mjs";
import { resolveSessionCdpEndpoint } from "./agentBrowser.mjs";
import {
  ab as defaultAb,
  SECTIONS_JS,
  PAGE_SIZE_JS,
  REVEAL_JS,
  SCROLL_PASS_JS,
  CONTENT_JS,
  STYLES_JS,
  DOM_JS,
  ASSETS_JS,
  UX_JS,
  parseEvalJson,
  resetSectionsDir,
  ensureWorkingTab as defaultEnsureWorkingTab,
  ensureUnemulatedViewport as defaultEnsureUnemulatedViewport,
  looksLikeSamePage,
} from "./capture.mjs";

export const PAGE_WIDTHS = { desktop: 1440, mobile: 390 };

export const PAGE_WINDOW_HEIGHTS = { desktop: 900, mobile: 844 };

export function buildViewportsJson({ desktop, mobile }) {
  return {
    desktop: { width: desktop.width, windowHeight: desktop.windowHeight },
    mobile: { width: mobile.width, windowHeight: mobile.windowHeight },
    scrollHeightDesktop: desktop.scrollHeight,
    scrollHeightMobile: mobile.scrollHeight,
    sliceMethod: "fullpage-png",
  };
}

/** Fail loud on empty / zero-size / fully-transparent full-page PNGs. */
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
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 0) return;
  }
  throw new Error(`${label}: blank full-page (fully transparent)`);
}

function sectionJsonEntry(section, dirPrefix) {
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

async function writeSectionPngs(dir, sections) {
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

async function defaultCollectPageExtras({
  captureDir,
  flags,
  url,
  slug,
  abFn,
  setViewportFn,
  resolveCdpFn,
  cdp,
  session,
}) {
  const dom = await abFn([...flags, "eval", "--stdin"], { input: DOM_JS });
  await writeFile(path.join(captureDir, "dom.html"), parseEvalJson(dom.stdout));

  const content = await abFn([...flags, "eval", "--stdin"], { input: CONTENT_JS });
  await writeFile(path.join(captureDir, "content.json"), JSON.stringify(parseEvalJson(content.stdout), null, 2));

  const assets = await abFn([...flags, "eval", "--stdin"], { input: ASSETS_JS });
  const assetsData = parseEvalJson(assets.stdout);
  await writeFile(path.join(captureDir, "assets.json"), JSON.stringify(assetsData, null, 2));

  // styles.json forced at page-mode widths 1440 / 390.
  let desktopStyles = null;
  let mobileStyles = null;
  try {
    const { host, port } = resolveCdpFn({ cdp, session });
    await setViewportFn({
      host,
      port,
      url,
      width: PAGE_WIDTHS.desktop,
      height: PAGE_WINDOW_HEIGHTS.desktop,
    });
    await abFn([...flags, "wait", "400"]);
    desktopStyles = parseEvalJson((await abFn([...flags, "eval", "--stdin"], { input: STYLES_JS })).stdout);

    await setViewportFn({
      host,
      port,
      url,
      width: PAGE_WIDTHS.mobile,
      height: PAGE_WINDOW_HEIGHTS.mobile,
    });
    await abFn([...flags, "wait", "400"]);
    mobileStyles = parseEvalJson((await abFn([...flags, "eval", "--stdin"], { input: STYLES_JS })).stdout);

    // Restore desktop width for any follow-up evals.
    await setViewportFn({
      host,
      port,
      url,
      width: PAGE_WIDTHS.desktop,
      height: PAGE_WINDOW_HEIGHTS.desktop,
    });
  } catch (e) {
    process.stderr.write(`  ! page-mode style capture failed for ${slug}: ${e.message}\n`);
  }
  await writeFile(
    path.join(captureDir, "styles.json"),
    JSON.stringify({ desktop: desktopStyles, mobile: mobileStyles }, null, 2),
  );

  try {
    const activeUrl = (await abFn([...flags, "get", "url"])).stdout.trim();
    if (!looksLikeSamePage(activeUrl, url)) {
      const msg =
        `ux capture skipped for ${slug}: active tab is at "${activeUrl}", expected "${url}"`;
      process.stderr.write(`  ! ${msg}\n`);
      await writeFile(path.join(captureDir, "ux.json"), JSON.stringify({ patterns: [], error: msg }, null, 2));
    } else {
      const ux = await abFn([...flags, "eval", "--stdin"], { input: UX_JS });
      await writeFile(path.join(captureDir, "ux.json"), JSON.stringify(parseEvalJson(ux.stdout), null, 2));
    }
  } catch (e) {
    process.stderr.write(`  ! page-mode ux capture failed for ${slug}: ${e.message}\n`);
    await writeFile(path.join(captureDir, "ux.json"), JSON.stringify({ patterns: [], error: e.message }, null, 2));
  }

  const html = await readFile(path.join(captureDir, "dom.html"), "utf8").catch(() => "");
  const classNames = [];
  for (const m of html.matchAll(/\bclass=["']([^"']+)["']/gi)) {
    classNames.push(...m[1].split(/\s+/).filter(Boolean));
  }
  return {
    scriptUrls: assetsData?.scripts || [],
    stylesheetUrls: assetsData?.stylesheets || [],
    classNames,
    html,
  };
}

/**
 * After the draft/live URL is open: set viewport (with url), then reveal + scroll settle.
 * Shared by page-mode capture and verify-page screenshots so both paths match.
 */
export async function settleWidthPass({
  url,
  slug = "page",
  flags,
  width,
  windowHeight,
  abFn,
  setViewportFn,
  resolveCdpFn,
  cdp,
  session,
  label = "page-mode",
}) {
  const { host, port } = resolveCdpFn({ cdp, session });
  await setViewportFn({ host, port, url, width, height: windowHeight });
  await abFn([...flags, "wait", "400"]);

  try {
    await abFn([...flags, "eval", "--stdin"], { input: REVEAL_JS });
  } catch (e) {
    process.stderr.write(`  ! ${label} reveal failed @${width} for ${slug}: ${e.message}\n`);
  }
  try {
    await abFn([...flags, "eval", "--stdin"], { input: SCROLL_PASS_JS });
  } catch (e) {
    process.stderr.write(`  ! ${label} scroll failed @${width} for ${slug}: ${e.message}\n`);
  }
  try {
    await abFn([...flags, "wait", "600"]);
  } catch (e) {
    process.stderr.write(`  ! ${label} settle failed @${width} for ${slug}: ${e.message}\n`);
  }

  return { host, port };
}

async function captureWidthPass({
  url,
  slug,
  flags,
  width,
  windowHeight,
  captureDir,
  fileBase,
  deps,
  cdp,
  session,
}) {
  const {
    ab: abFn,
    setViewport: setViewportFn,
    resolveSessionCdpEndpoint: resolveCdpFn,
    captureFullPageScreenshot: shotFn,
    measurePageSize,
    evalSections,
  } = deps;

  const { host, port } = await settleWidthPass({
    url,
    slug,
    flags,
    width,
    windowHeight,
    abFn,
    setViewportFn,
    resolveCdpFn,
    cdp,
    session,
  });

  const size = measurePageSize
    ? await measurePageSize({ width, flags, abFn })
    : parseEvalJson((await abFn([...flags, "eval", "--stdin"], { input: PAGE_SIZE_JS })).stdout);

  const pageWidth = Number(size && size.width);
  const pageHeight = Number(size && size.height);
  if (!(pageWidth > 0) || !(pageHeight > 0)) {
    throw new Error(`page-mode @${width}: could not measure page size (got ${JSON.stringify(size)})`);
  }

  const outPath = path.join(captureDir, `${fileBase}.png`);
  await shotFn({
    host,
    port,
    url,
    width: pageWidth,
    height: pageHeight,
    outPath,
  });
  const pngBuf = await readFile(outPath);
  assertFullPagePng(pngBuf, fileBase);

  const tagged = evalSections
    ? await evalSections({ width, flags, abFn })
    : parseEvalJson((await abFn([...flags, "eval", "--stdin"], { input: SECTIONS_JS })).stdout);
  const metaSections = (tagged && tagged.sections) || [];
  const slices = sliceSections(pngBuf, metaSections);
  const sections = mergeSliceMeta(metaSections, slices);

  return { pngBuf, sections, scrollHeight: pageHeight, windowHeight, width };
}

/**
 * Orchestrate page-mode capture for a single URL at widths 1440 and 390.
 * `deps` injects browser/CDP seams for unit tests.
 */
export async function capturePageMode({
  url,
  runsDir = "runs",
  cdp = 9223,
  session = "personal",
  site,
  deps: depsIn = {},
} = {}) {
  const resolvedSite = site || siteFromUrl(url);
  const slug = urlToSlug(url);
  const runDir = path.join(runsDir, resolvedSite);
  const captureDir = path.join(runDir, "captures", slug);
  await mkdir(captureDir, { recursive: true });

  const deps = {
    ab: defaultAb,
    ensureWorkingTab: defaultEnsureWorkingTab,
    ensureUnemulatedViewport: defaultEnsureUnemulatedViewport,
    setViewport,
    resolveSessionCdpEndpoint,
    captureFullPageScreenshot,
    measurePageSize: null,
    evalSections: null,
    collectPageExtras: null,
    ...depsIn,
  };

  const flags = ["--cdp", String(cdp), "--session", session];

  await deps.ensureWorkingTab(flags);
  await deps.ensureUnemulatedViewport({ flags, slug });
  await deps.ab([...flags, "open", url]);
  try {
    await deps.ab([...flags, "wait", "--load", "networkidle"]);
  } catch (e) {
    process.stderr.write(`  ! page-mode networkidle wait failed for ${slug}: ${e.message}\n`);
  }
  try {
    await deps.ab([...flags, "wait", "1200"]);
  } catch (e) {
    process.stderr.write(`  ! page-mode settle wait failed for ${slug}: ${e.message}\n`);
  }

  const desktop = await captureWidthPass({
    url,
    slug,
    flags,
    width: PAGE_WIDTHS.desktop,
    windowHeight: PAGE_WINDOW_HEIGHTS.desktop,
    captureDir,
    fileBase: "fullpage-desktop",
    deps,
    cdp,
    session,
  });

  const mobile = await captureWidthPass({
    url,
    slug,
    flags,
    width: PAGE_WIDTHS.mobile,
    windowHeight: PAGE_WINDOW_HEIGHTS.mobile,
    captureDir,
    fileBase: "fullpage-mobile",
    deps,
    cdp,
    session,
  });

  // Content/styles/ux/dom — prefer injectable seam in tests.
  const extras = deps.collectPageExtras
    ? await deps.collectPageExtras({ captureDir, flags, url, slug, abFn: deps.ab })
    : await defaultCollectPageExtras({
        captureDir,
        flags,
        url,
        slug,
        abFn: deps.ab,
        setViewportFn: deps.setViewport,
        resolveCdpFn: deps.resolveSessionCdpEndpoint,
        cdp,
        session,
      });

  const libs = detectLibs({
    scriptUrls: extras.scriptUrls || [],
    stylesheetUrls: extras.stylesheetUrls || [],
    classNames: extras.classNames || [],
    html: extras.html || "",
  });

  const viewports = buildViewportsJson({
    desktop: {
      width: PAGE_WIDTHS.desktop,
      windowHeight: PAGE_WINDOW_HEIGHTS.desktop,
      scrollHeight: desktop.scrollHeight,
    },
    mobile: {
      width: PAGE_WIDTHS.mobile,
      windowHeight: PAGE_WINDOW_HEIGHTS.mobile,
      scrollHeight: mobile.scrollHeight,
    },
  });

  await writePageModeArtifacts(captureDir, {
    fullpageDesktopPng: desktop.pngBuf,
    fullpageMobilePng: mobile.pngBuf,
    desktopSections: desktop.sections,
    mobileSections: mobile.sections,
    viewports,
    libs,
  });

  return {
    ok: true,
    slug,
    url,
    site: resolvedSite,
    captureDir,
    sectionCount: desktop.sections.length,
  };
}
