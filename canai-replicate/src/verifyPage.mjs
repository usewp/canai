// Page-mode verify: dual full-page hard gate against captures/<slug>/fullpage-*.png.
// Static drafts in output/pages/ are screenshotted Twig-free until handoff.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { decodePng, diffScore } from "./pngdiff.mjs";
import {
  evaluatePageGate,
  nextAttemptState,
  DEFAULT_PAGE_GATE,
  combinedSeverity,
  gatePresetFor,
} from "./pageGate.mjs";
import { readRunConfig } from "./runConfig.mjs";
import { severityScore } from "./verify.mjs";
import { PAGE_WIDTHS, PAGE_WINDOW_HEIGHTS } from "./pageCapture.mjs";
import { onlyToSlug, matchesOnly } from "./slug.mjs";
import { slicePng } from "./pngSlice.mjs";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function roundPct(n) {
  return Number(Number(n).toFixed(1));
}

/**
 * Format a section note for markdown / agent prompts.
 * Accepts legacy strings or structured rank entries.
 */
export function formatSectionNote(note) {
  if (typeof note === "string") return note;
  if (!note || typeof note !== "object") return String(note);
  const sev = Number(note.severity);
  const sevStr = Number.isFinite(sev) ? sev.toFixed(1) : "?";
  return `${note.viewport}/${note.id}: mismatch ${note.mismatchPct}%, height Δ ${note.heightDeltaPct}% (severity ${sevStr})`;
}

/**
 * Scale a CSS-pixel box onto a full-page PNG that may be device-pixel sized.
 */
export function scaleBoxToPng(box, pngWidth, cssWidth) {
  if (!box || !(cssWidth > 0) || !(pngWidth > 0)) return null;
  const scale = pngWidth / cssWidth;
  return {
    left: Math.round(Number(box.left) * scale),
    top: Math.round(Number(box.top) * scale),
    width: Math.round(Number(box.width) * scale),
    height: Math.round(Number(box.height) * scale),
  };
}

/**
 * Chrome-skip crop: the band from the header box bottom to the footer box top,
 * in device pixels. Throws when either chrome box is missing — scoring a
 * <main>-only draft against an uncropped capture would be silently wrong.
 */
export function mainBandCropBox({ sections, pngWidth, pngHeight, cssWidth }) {
  const find = (id) => {
    const s = (sections || []).find((x) => x && x.id === id && x.box);
    if (!s) throw new Error(`chrome skip: capture has no "${id}" box in the section index — re-run with --chrome inline or fix the capture`);
    return scaleBoxToPng(s.box, pngWidth, cssWidth);
  };
  const header = find("header");
  const footer = find("footer");
  const top = header.top + header.height;
  const bottom = Math.min(footer.top, pngHeight);
  if (!(bottom > top)) throw new Error(`chrome skip: footer top (${bottom}) is not below header bottom (${top})`);
  return { left: 0, top, width: pngWidth, height: bottom - top };
}

/**
 * Diff generated full-page slices against capture section PNGs; return worst-first.
 * Pure (sync): pass `sectionPngs` as { [relFile]: Buffer }.
 *
 * @returns {Array<{ viewport, id, role, mismatchPct, heightDeltaPct, severity, file }>}
 */
export function rankSectionDiffs({
  generatedPngBuf,
  sections,
  cssWidth,
  viewport,
  topN = 5,
  sectionPngs = {},
  // Chrome-skip: the generated PNG starts at <main>, not at the top of the
  // capture, so every capture-relative box top must be shifted back by the
  // crop's own top (in the same scaled/device-pixel units) before slicing.
  boxOffsetTop = 0,
} = {}) {
  if (!generatedPngBuf || !Array.isArray(sections) || !(cssWidth > 0)) return [];
  let genDecoded;
  try {
    genDecoded = decodePng(generatedPngBuf);
  } catch {
    return [];
  }
  const ranked = [];
  for (const sec of sections) {
    const file = sec?.file;
    const id = sec?.id;
    if (!file || !id) continue;
    const captureBuf = sectionPngs[file];
    if (!captureBuf) continue;
    const box = sec.box || {
      left: sec.left,
      top: sec.top,
      width: sec.width,
      height: sec.height,
    };
    const scaledFull = scaleBoxToPng(box, genDecoded.width, cssWidth);
    if (!scaledFull) continue;
    const scaled = boxOffsetTop ? { ...scaledFull, top: scaledFull.top - boxOffsetTop } : scaledFull;
    if (scaled.width <= 0 || scaled.height <= 0) continue;
    let genSlice;
    try {
      genSlice = slicePng(generatedPngBuf, scaled);
    } catch {
      continue;
    }
    let score;
    try {
      score = diffScore(decodePng(captureBuf), decodePng(genSlice));
    } catch {
      continue;
    }
    const entry = {
      viewport,
      id,
      role: sec.role ?? null,
      mismatchPct: roundPct(score.mismatchPct),
      heightDeltaPct: roundPct(score.heightDeltaPct),
      severity: severityScore({
        mismatchPct: score.mismatchPct,
        heightDeltaPct: score.heightDeltaPct,
      }),
      file,
    };
    ranked.push(entry);
  }
  ranked.sort((a, b) => b.severity - a.severity || b.mismatchPct - a.mismatchPct);
  return ranked.slice(0, Math.max(0, topN));
}

/**
 * Load sections-*.json + PNGs from a capture dir and rank against a generated full-page.
 */
export async function collectSectionNotesForViewport({
  captureDir,
  generatedPngBuf,
  viewport, // "desktop" | "mobile"
  cssWidth,
  topN = 5,
  readFileFn = readFile,
  // Chrome-skip: drop header/footer notes (they're outside the cropped
  // capture) and shift every remaining box by the crop's own top.
  excludeIds = [],
  boxOffsetTop = 0,
} = {}) {
  const jsonName = viewport === "mobile" ? "sections-mobile.json" : "sections-desktop.json";
  const jsonPath = path.join(captureDir, jsonName);
  let parsed;
  try {
    parsed = JSON.parse(await readFileFn(jsonPath, "utf8"));
  } catch {
    return [];
  }
  const sections = (Array.isArray(parsed?.sections) ? parsed.sections : []).filter((s) => !excludeIds.includes(s?.id));
  const sectionPngs = {};
  for (const sec of sections) {
    if (!sec?.file) continue;
    try {
      sectionPngs[sec.file] = await readFileFn(path.join(captureDir, sec.file));
    } catch {
      // Missing slice — skip that section.
    }
  }
  return rankSectionDiffs({
    generatedPngBuf,
    sections,
    cssWidth,
    viewport,
    boxOffsetTop,
    topN,
    sectionPngs,
  });
}

/**
 * Build human + machine page-mode verify reports.
 * @returns {{ markdown: string, json: object }}
 */
export function buildPageReport({
  site,
  slug,
  desktop,
  mobile,
  gate,
  attemptState,
  sectionNotes = [],
  thresholds = DEFAULT_PAGE_GATE,
  chrome = "inline",
  cropBands = null,
}) {
  const desktopScored = {
    mismatchPct: desktop.mismatchPct,
    heightDeltaPct: desktop.heightDeltaPct,
    severity: severityScore(desktop),
  };
  const mobileScored = {
    mismatchPct: mobile.mismatchPct,
    heightDeltaPct: mobile.heightDeltaPct,
    severity: severityScore(mobile),
  };

  const json = {
    site,
    slug,
    status: attemptState.status,
    attempts: attemptState.attempts,
    canHandoff: attemptState.canHandoff,
    canRetry: attemptState.canRetry,
    stagnant: Boolean(attemptState.stagnant),
    failReason: attemptState.failReason ?? null,
    combinedSeverity: Number(
      (desktopScored.severity + mobileScored.severity).toFixed(2),
    ),
    desktop: desktopScored,
    mobile: mobileScored,
    gate: {
      pass: gate.pass,
      reasons: gate.reasons,
      desktop: gate.desktop,
      mobile: gate.mobile,
      advisory: Boolean(gate.advisory),
      advisoryReasons: gate.advisoryReasons ?? [],
    },
    thresholds: {
      maxMismatchPct: Number.isFinite(thresholds.maxMismatchPct ?? DEFAULT_PAGE_GATE.maxMismatchPct)
        ? (thresholds.maxMismatchPct ?? DEFAULT_PAGE_GATE.maxMismatchPct)
        : null,
      maxHeightDeltaPct: thresholds.maxHeightDeltaPct ?? DEFAULT_PAGE_GATE.maxHeightDeltaPct,
      maxAttempts: thresholds.maxAttempts ?? DEFAULT_PAGE_GATE.maxAttempts,
      minSeverityImprovement:
        thresholds.minSeverityImprovement ?? DEFAULT_PAGE_GATE.minSeverityImprovement,
      mode: thresholds.mode ?? "hard",
    },
    sectionNotes,
    chrome,
    cropBands,
  };

  const lines = [
    `# Page verify — ${site} / ${slug}`,
    "",
    `- status: ${json.status}`,
    `- attempts: ${json.attempts}`,
    `- canHandoff: ${json.canHandoff}`,
    `- canRetry: ${json.canRetry}`,
    `- combinedSeverity: ${json.combinedSeverity}`,
    `- mode: ${json.thresholds.mode}`,
    ...(json.stagnant ? [`- stagnant: true (severity did not improve enough vs prior attempt)`] : []),
    ...(json.failReason ? [`- failReason: ${json.failReason}`] : []),
    ...(chrome === "skip"
      ? [`- chrome: skip (capture cropped to main band — desktop y ${cropBands.desktop.top}+${cropBands.desktop.height}, mobile y ${cropBands.mobile.top}+${cropBands.mobile.height})`]
      : []),
    "",
    "## Hard gate",
    "",
    `- pass: ${gate.pass}`,
    `- thresholds: mismatchPct < ${json.thresholds.maxMismatchPct ?? "none"}, heightDeltaPct < ${json.thresholds.maxHeightDeltaPct}, maxAttempts ${json.thresholds.maxAttempts}, minSeverityImprovement ${json.thresholds.minSeverityImprovement}`,
    ...(gate.reasons.length
      ? ["", "### Fail reasons", "", ...gate.reasons.map((r) => `- ${r}`)]
      : []),
    ...(json.gate.advisoryReasons.length
      ? ["", "### Advisory (not enforced)", "", ...json.gate.advisoryReasons.map((r) => `- ${r}`)]
      : []),
    ...(json.stagnant
      ? [
          "",
          "### Stagnation",
          "",
          `- Combined severity improved by less than ${json.thresholds.minSeverityImprovement} vs the previous attempt.`,
          "- Do **not** raise `--max-mismatch` / `--max-height-delta` to force a pass — fix the worst `sectionNotes` instead.",
        ]
      : []),
    "",
    "## Scores",
    "",
    "| viewport | severity | mismatch % | height Δ % |",
    "| --- | --- | --- | --- |",
    `| desktop (1440) | ${desktopScored.severity.toFixed(1)} | ${Number(desktopScored.mismatchPct).toFixed(1)} | ${Number(desktopScored.heightDeltaPct).toFixed(1)} |`,
    `| mobile (390) | ${mobileScored.severity.toFixed(1)} | ${Number(mobileScored.mismatchPct).toFixed(1)} | ${Number(mobileScored.heightDeltaPct).toFixed(1)} |`,
    "",
  ];

  if (sectionNotes.length) {
    lines.push(
      "## Section notes (worst first — fix these)",
      "",
      ...sectionNotes.map((n) => `- ${formatSectionNote(n)}`),
      "",
    );
  }

  return { markdown: lines.join("\n"), json };
}

async function scoreAgainstCapture(originalPath, generatedBuf, { cropBox = null } = {}) {
  let originalBuf = await readFile(originalPath);
  if (cropBox) originalBuf = slicePng(originalBuf, cropBox);
  const score = diffScore(decodePng(originalBuf), decodePng(generatedBuf));
  return {
    mismatchPct: roundPct(score.mismatchPct),
    heightDeltaPct: roundPct(score.heightDeltaPct),
  };
}

async function readPriorMeta(metaPath) {
  try {
    const raw = JSON.parse(await readFile(metaPath, "utf8"));
    const n = Number(raw?.attempts);
    let combined = null;
    if (raw?.combinedSeverity != null && Number.isFinite(Number(raw.combinedSeverity))) {
      combined = Number(raw.combinedSeverity);
    } else if (raw?.scores?.desktop && raw?.scores?.mobile) {
      combined = combinedSeverity(raw.scores);
    }
    return {
      attempts: Number.isFinite(n) && n >= 0 ? n : 0,
      scores: raw?.scores ?? null,
      combinedSeverity: combined,
      history: Array.isArray(raw?.history) ? raw.history : [],
    };
  } catch {
    return { attempts: 0, scores: null, combinedSeverity: null, history: [] };
  }
}

/**
 * Verify one page-mode static draft against dual full-page captures.
 * Throws when status is `fail` after max attempts; returns report json otherwise.
 */
export async function verifyPage({
  site,
  runsDir = "runs",
  only = null,
  objective = null,
  chrome = null,
  thresholds = {},
  screenshotFn = null,
  /** When null/undefined, auto-rank section diffs. Pass an array to override. */
  sectionNotes = null,
  sectionTopN = 5,
} = {}) {
  if (!site) throw new Error("verifyPage: site is required");
  if (!only) throw new Error("verifyPage: --only <slug> is required for page-mode verify");

  const slug = onlyToSlug(only);
  if (!matchesOnly(only, { slug })) {
    throw new Error(`verifyPage: --only ${only} did not resolve to a slug`);
  }

  const runDir = path.join(runsDir, site);
  const runConfig = await readRunConfig(runDir);
  const resolvedObjective = objective ?? runConfig?.objective ?? "pixel";
  const resolvedChrome = chrome ?? runConfig?.chrome ?? "inline";
  const preset = gatePresetFor(resolvedObjective);
  if (resolvedObjective !== "pixel" && Object.keys(thresholds).length > 0) {
    throw new Error(`--max-* overrides apply to the pixel objective only (run.json objective is "${resolvedObjective}")`);
  }
  const gateThresholds = {
    maxMismatchPct: thresholds.maxMismatchPct ?? preset.maxMismatchPct,
    maxHeightDeltaPct: thresholds.maxHeightDeltaPct ?? preset.maxHeightDeltaPct,
    maxAttempts: thresholds.maxAttempts ?? preset.maxAttempts,
    minSeverityImprovement: thresholds.minSeverityImprovement ?? preset.minSeverityImprovement,
    mode: preset.mode,
  };

  const verifyDir = path.join(runDir, "verify");
  const captureDir = path.join(runDir, "captures", slug);
  const htmlPath = path.join(runDir, "output", "pages", `${slug}.html`);
  const metaPath = path.join(runDir, "output", "pages", `${slug}.page-mode.json`);
  const desktopCapture = path.join(captureDir, "fullpage-desktop.png");
  const mobileCapture = path.join(captureDir, "fullpage-mobile.png");
  const desktopGenerated = path.join(verifyDir, `${slug}-desktop-generated.png`);
  const mobileGenerated = path.join(verifyDir, `${slug}-mobile-generated.png`);

  if (!(await exists(htmlPath))) {
    throw new Error(`verifyPage: missing output/pages/${slug}.html`);
  }
  if (!(await exists(desktopCapture))) {
    throw new Error(`verifyPage: missing captures/${slug}/fullpage-desktop.png`);
  }
  if (!(await exists(mobileCapture))) {
    throw new Error(`verifyPage: missing captures/${slug}/fullpage-mobile.png`);
  }

  await mkdir(verifyDir, { recursive: true });

  const fileUrl = `file://${path.resolve(htmlPath)}`;
  // replica does not drive a browser as of 4.0.0. The agent screenshots the
  // draft with agent-browser (see verifyPageBundle) and this reads what it
  // wrote. Tests still inject screenshotFn and never touch the filesystem.
  const shot = screenshotFn || (async ({ outPath, viewport }) => {
    try {
      return await readFile(outPath);
    } catch {
      throw new Error(
        `verify-page: missing ${viewport} screenshot ${outPath}\n` +
          `Run the bundle at ${path.join(runDir, ".verify", "page-PROMPT.md")} with agent-browser first ` +
          `(open ${fileUrl}, set viewport, screenshot --full).`,
      );
    }
  });

  process.stderr.write(`[page-verify] ${slug}\n`);

  const desktopBuf = await shot({
    width: PAGE_WIDTHS.desktop,
    windowHeight: PAGE_WINDOW_HEIGHTS.desktop,
    fileUrl,
    outPath: desktopGenerated,
    htmlPath,
    viewport: "desktop",
  });
  await writeFile(desktopGenerated, desktopBuf);

  const mobileBuf = await shot({
    width: PAGE_WIDTHS.mobile,
    windowHeight: PAGE_WINDOW_HEIGHTS.mobile,
    fileUrl,
    outPath: mobileGenerated,
    htmlPath,
    viewport: "mobile",
  });
  await writeFile(mobileGenerated, mobileBuf);

  let cropBands = null;
  let desktopCrop = null;
  let mobileCrop = null;
  if (resolvedChrome === "skip") {
    const readSections = async (name) => JSON.parse(await readFile(path.join(captureDir, name), "utf8"))?.sections ?? [];
    const dPng = decodePng(await readFile(desktopCapture));
    const mPng = decodePng(await readFile(mobileCapture));
    desktopCrop = mainBandCropBox({ sections: await readSections("sections-desktop.json"), pngWidth: dPng.width, pngHeight: dPng.height, cssWidth: PAGE_WIDTHS.desktop });
    mobileCrop = mainBandCropBox({ sections: await readSections("sections-mobile.json"), pngWidth: mPng.width, pngHeight: mPng.height, cssWidth: PAGE_WIDTHS.mobile });
    cropBands = { desktop: { top: desktopCrop.top, height: desktopCrop.height }, mobile: { top: mobileCrop.top, height: mobileCrop.height } };
  }
  const desktop = await scoreAgainstCapture(desktopCapture, desktopBuf, { cropBox: desktopCrop });
  const mobile = await scoreAgainstCapture(mobileCapture, mobileBuf, { cropBox: mobileCrop });
  let gate = evaluatePageGate({ desktop, mobile }, gateThresholds);
  if (gateThresholds.mode === "advisory") {
    gate = { ...gate, advisory: true, advisoryReasons: gate.reasons, reasons: [], pass: true };
  }

  const excludeIds = resolvedChrome === "skip" ? ["header", "footer"] : [];
  let notes = sectionNotes;
  if (notes == null) {
    const desktopNotes = await collectSectionNotesForViewport({
      captureDir,
      generatedPngBuf: desktopBuf,
      viewport: "desktop",
      cssWidth: PAGE_WIDTHS.desktop,
      topN: sectionTopN,
      excludeIds,
      boxOffsetTop: desktopCrop?.top ?? 0,
    });
    const mobileNotes = await collectSectionNotesForViewport({
      captureDir,
      generatedPngBuf: mobileBuf,
      viewport: "mobile",
      cssWidth: PAGE_WIDTHS.mobile,
      topN: sectionTopN,
      excludeIds,
      boxOffsetTop: mobileCrop?.top ?? 0,
    });
    // Merge, re-sort by severity, keep topN overall so the agent sees the worst slices.
    notes = [...desktopNotes, ...mobileNotes]
      .sort((a, b) => b.severity - a.severity || b.mismatchPct - a.mismatchPct)
      .slice(0, sectionTopN);
  }

  const prior = await readPriorMeta(metaPath);
  const attempts = prior.attempts + 1;
  const currentSev = combinedSeverity({ desktop, mobile });
  const attemptState = nextAttemptState({
    attempts,
    pass: gate.pass,
    maxAttempts: gateThresholds.maxAttempts,
    previousSeverity: prior.combinedSeverity,
    currentSeverity: currentSev,
    minSeverityImprovement: gateThresholds.minSeverityImprovement,
  });

  const { markdown, json } = buildPageReport({
    site,
    slug,
    desktop,
    mobile,
    gate,
    attemptState,
    sectionNotes: notes,
    thresholds: gateThresholds,
    chrome: resolvedChrome,
    cropBands,
  });

  await writeFile(path.join(verifyDir, "page-report.md"), markdown);
  await writeFile(path.join(verifyDir, "page-report.json"), JSON.stringify(json, null, 2));

  const history = [
    ...prior.history,
    {
      attempt: attempts,
      desktop,
      mobile,
      combinedSeverity: Number(currentSev.toFixed(2)),
      status: attemptState.status,
    },
  ];
  const pageMode = {
    attempts,
    status: attemptState.status,
    scores: { desktop, mobile },
    combinedSeverity: Number(currentSev.toFixed(2)),
    stagnant: Boolean(attemptState.stagnant),
    failReason: attemptState.failReason ?? null,
    // Belt and braces: handoff-page reads this when run.json is unavailable.
    chrome: resolvedChrome,
    history,
  };
  await writeFile(metaPath, JSON.stringify(pageMode, null, 2));

  process.stderr.write(
    `  desktop: ${desktop.mismatchPct}% mismatch, ${desktop.heightDeltaPct}% height Δ\n`,
  );
  process.stderr.write(
    `  mobile:  ${mobile.mismatchPct}% mismatch, ${mobile.heightDeltaPct}% height Δ\n`,
  );
  if (notes.length) {
    process.stderr.write(`  worst sections:\n`);
    for (const n of notes) {
      process.stderr.write(`    - ${formatSectionNote(n)}\n`);
    }
  }
  process.stderr.write(
    `  status:  ${attemptState.status} (attempt ${attempts}` +
      `${attemptState.stagnant ? ", stagnant" : ""})\n`,
  );

  if (attemptState.status === "fail") {
    const why = attemptState.stagnant
      ? `stagnant — combined severity improved by less than ${gateThresholds.minSeverityImprovement} vs prior attempt; fix sectionNotes, do not loosen thresholds`
      : gate.reasons.join("; ") || "hard gate not met";
    throw new Error(`page-verify failed for ${slug} after ${attempts} attempt(s): ${why}`);
  }

  return json;
}


/**
 * Write the page-mode verify bundle. The agent screenshots the static draft at
 * both widths with agent-browser; verifyPage (the scorer) reads those PNGs and
 * runs the hard gate. Thresholds are unchanged: mismatch < 15%, height delta
 * < 10%, both viewports must pass, max 3 attempts.
 */
export async function verifyPageBundle({
  site,
  runsDir = "runs",
  only = null,
  profile = null,
  session = "canai",
} = {}) {
  if (!site) throw new Error("verifyPageBundle: site is required");
  if (!only) throw new Error("verifyPageBundle: --only <slug> is required for page-mode verify");

  const slug = onlyToSlug(only);
  const runDir = path.join(runsDir, site);
  const htmlPath = path.join(runDir, "output", "pages", `${slug}.html`);
  try {
    await access(htmlPath);
  } catch {
    throw new Error(`verify-page: no draft at ${htmlPath} — run transform --page-mode --only ${slug} first`);
  }

  const verifyDir = path.join(runDir, "verify");
  const bundleDir = path.join(runDir, ".verify");
  await mkdir(verifyDir, { recursive: true });
  await mkdir(bundleDir, { recursive: true });

  const flagStr = [profile ? `--profile "${profile}"` : "", session ? `--session ${session}` : ""]
    .filter(Boolean)
    .join(" ");
  const ab = `agent-browser${flagStr ? " " + flagStr : ""}`;
  const fileUrl = `file://${path.resolve(htmlPath)}`;

  const pass = (viewport, width, windowHeight) =>
    `${ab} open "${fileUrl}"\n` +
    `${ab} set viewport ${width} ${windowHeight}\n` +
    `${ab} wait --load networkidle\n` +
    `${ab} screenshot --full "${path.join(verifyDir, `${slug}-${viewport}-generated.png`)}"`;

  const promptPath = path.join(bundleDir, "page-PROMPT.md");
  await writeFile(
    promptPath,
    `# Page-mode verify bundle — ${site} / ${slug}\n\n` +
      `Screenshot the static draft at BOTH widths, then run\n` +
      `\`replica verify-page-score ${site} --only ${slug}\`.\n\n` +
      `\`\`\`bash\n${pass("desktop", PAGE_WIDTHS.desktop, PAGE_WINDOW_HEIGHTS.desktop)}\n\n` +
      `${pass("mobile", PAGE_WIDTHS.mobile, PAGE_WINDOW_HEIGHTS.mobile)}\n\`\`\`\n\n` +
      `The draft is Twig-free by design in page mode, so it renders correctly from file://.\n` +
      `Never screenshot an element — agent-browser returns blank images below the fold.\n`,
  );

  return { site, slug, count: 1, ok: true, promptPath };
}
