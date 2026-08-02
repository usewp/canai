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
} from "./pageGate.mjs";
import { severityScore, takeVerifyScreenshot } from "./verify.mjs";
import { PAGE_WIDTHS, PAGE_WINDOW_HEIGHTS, settleWidthPass } from "./pageCapture.mjs";
import { onlyToSlug, matchesOnly } from "./slug.mjs";
import { spawnAgentBrowser, resolveSessionCdpEndpoint } from "./agentBrowser.mjs";
import { captureFullPageScreenshot, setViewport } from "./cdp.mjs";
import { slicePng } from "./pngSlice.mjs";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function ab(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnAgentBrowser(args, { stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`agent-browser exited ${code}: ${stderr.trim()}`));
      resolve({ stdout, stderr });
    });
    if (input != null) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
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
    const scaled = scaleBoxToPng(box, genDecoded.width, cssWidth);
    if (!scaled || scaled.width <= 0 || scaled.height <= 0) continue;
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
} = {}) {
  const jsonName = viewport === "mobile" ? "sections-mobile.json" : "sections-desktop.json";
  const jsonPath = path.join(captureDir, jsonName);
  let parsed;
  try {
    parsed = JSON.parse(await readFileFn(jsonPath, "utf8"));
  } catch {
    return [];
  }
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
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
    },
    thresholds: {
      maxMismatchPct: thresholds.maxMismatchPct ?? DEFAULT_PAGE_GATE.maxMismatchPct,
      maxHeightDeltaPct: thresholds.maxHeightDeltaPct ?? DEFAULT_PAGE_GATE.maxHeightDeltaPct,
      maxAttempts: thresholds.maxAttempts ?? DEFAULT_PAGE_GATE.maxAttempts,
      minSeverityImprovement:
        thresholds.minSeverityImprovement ?? DEFAULT_PAGE_GATE.minSeverityImprovement,
    },
    sectionNotes,
  };

  const lines = [
    `# Page verify — ${site} / ${slug}`,
    "",
    `- status: ${json.status}`,
    `- attempts: ${json.attempts}`,
    `- canHandoff: ${json.canHandoff}`,
    `- canRetry: ${json.canRetry}`,
    `- combinedSeverity: ${json.combinedSeverity}`,
    ...(json.stagnant ? [`- stagnant: true (severity did not improve enough vs prior attempt)`] : []),
    ...(json.failReason ? [`- failReason: ${json.failReason}`] : []),
    "",
    "## Hard gate",
    "",
    `- pass: ${gate.pass}`,
    `- thresholds: mismatchPct < ${json.thresholds.maxMismatchPct}, heightDeltaPct < ${json.thresholds.maxHeightDeltaPct}, maxAttempts ${json.thresholds.maxAttempts}, minSeverityImprovement ${json.thresholds.minSeverityImprovement}`,
    ...(gate.reasons.length
      ? ["", "### Fail reasons", "", ...gate.reasons.map((r) => `- ${r}`)]
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

async function scoreAgainstCapture(originalPath, generatedBuf) {
  const score = diffScore(decodePng(await readFile(originalPath)), decodePng(generatedBuf));
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
 * Default dual-width screenshot — mirrors pageCapture captureWidthPass:
 * open draft URL first, setViewport with that url, reveal/scroll settle, then
 * CDP full-page. Tests inject `screenshotFn` and never hit this path.
 */
export async function defaultPageScreenshotFn({
  width,
  windowHeight,
  fileUrl,
  outPath,
  flags,
  cdp,
  session,
  slug = "page",
  abImpl = ab,
  setViewportFn = setViewport,
  resolveEndpoint = resolveSessionCdpEndpoint,
  captureFullPage = captureFullPageScreenshot,
  takeScreenshot = takeVerifyScreenshot,
  settleFn = settleWidthPass,
}) {
  // Ensure tab is on the draft before viewport/settle/screenshot (open first).
  let activeUrl = "";
  try {
    activeUrl = (await abImpl([...flags, "get", "url"])).stdout.trim();
  } catch {}
  if (!/^(https?|file):/.test(activeUrl) || /gemini\.google\.com\/glic/.test(activeUrl)) {
    await abImpl([...flags, "tab", "new", "about:blank"]);
  }
  await abImpl([...flags, "open", fileUrl]);
  try {
    await abImpl([...flags, "wait", "--load", "networkidle"]);
  } catch {}
  try {
    await abImpl([...flags, "wait", "1200"]);
  } catch {}

  await settleFn({
    url: fileUrl,
    slug,
    flags,
    width,
    windowHeight,
    abFn: abImpl,
    setViewportFn,
    resolveCdpFn: resolveEndpoint,
    cdp,
    session,
    label: "page-verify",
  });

  await takeScreenshot({
    flags,
    fileUrl,
    generatedPng: outPath,
    cdp,
    session,
    abImpl,
    resolveEndpoint,
    captureFullPage,
  });
  return readFile(outPath);
}

/**
 * Verify one page-mode static draft against dual full-page captures.
 * Throws when status is `fail` after max attempts; returns report json otherwise.
 */
export async function verifyPage({
  site,
  runsDir = "runs",
  cdp = 9223,
  session = "personal",
  only = null,
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

  const gateThresholds = {
    maxMismatchPct: thresholds.maxMismatchPct ?? DEFAULT_PAGE_GATE.maxMismatchPct,
    maxHeightDeltaPct: thresholds.maxHeightDeltaPct ?? DEFAULT_PAGE_GATE.maxHeightDeltaPct,
    maxAttempts: thresholds.maxAttempts ?? DEFAULT_PAGE_GATE.maxAttempts,
    minSeverityImprovement:
      thresholds.minSeverityImprovement ?? DEFAULT_PAGE_GATE.minSeverityImprovement,
  };

  const runDir = path.join(runsDir, site);
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

  const flags = ["--cdp", String(cdp), "--session", session];
  const fileUrl = `file://${path.resolve(htmlPath)}`;
  const shot =
    screenshotFn ||
    ((opts) =>
      defaultPageScreenshotFn({
        ...opts,
        flags,
        cdp,
        session,
        slug,
      }));

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

  const desktop = await scoreAgainstCapture(desktopCapture, desktopBuf);
  const mobile = await scoreAgainstCapture(mobileCapture, mobileBuf);
  const gate = evaluatePageGate({ desktop, mobile }, gateThresholds);

  let notes = sectionNotes;
  if (notes == null) {
    const desktopNotes = await collectSectionNotesForViewport({
      captureDir,
      generatedPngBuf: desktopBuf,
      viewport: "desktop",
      cssWidth: PAGE_WIDTHS.desktop,
      topN: sectionTopN,
    });
    const mobileNotes = await collectSectionNotesForViewport({
      captureDir,
      generatedPngBuf: mobileBuf,
      viewport: "mobile",
      cssWidth: PAGE_WIDTHS.mobile,
      topN: sectionTopN,
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
