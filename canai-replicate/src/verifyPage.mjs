// Page-mode verify: dual full-page hard gate against captures/<slug>/fullpage-*.png.
// Static drafts in output/pages/ are screenshotted Twig-free until handoff.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { decodePng, diffScore } from "./pngdiff.mjs";
import {
  evaluatePageGate,
  nextAttemptState,
  DEFAULT_PAGE_GATE,
} from "./pageGate.mjs";
import { severityScore, takeVerifyScreenshot } from "./verify.mjs";
import { PAGE_WIDTHS, PAGE_WINDOW_HEIGHTS, settleWidthPass } from "./pageCapture.mjs";
import { onlyToSlug, matchesOnly } from "./slug.mjs";
import { spawnAgentBrowser, resolveSessionCdpEndpoint } from "./agentBrowser.mjs";
import { captureFullPageScreenshot, setViewport } from "./cdp.mjs";

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
    "",
    "## Hard gate",
    "",
    `- pass: ${gate.pass}`,
    `- thresholds: mismatchPct < ${json.thresholds.maxMismatchPct}, heightDeltaPct < ${json.thresholds.maxHeightDeltaPct}`,
    ...(gate.reasons.length
      ? ["", "### Fail reasons", "", ...gate.reasons.map((r) => `- ${r}`)]
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
    lines.push("## Section notes", "", ...sectionNotes.map((n) => `- ${n}`), "");
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

async function readPriorAttempts(metaPath) {
  try {
    const raw = JSON.parse(await readFile(metaPath, "utf8"));
    const n = Number(raw?.attempts);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
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
  sectionNotes = [],
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
  };

  const runDir = path.join(runsDir, site);
  const verifyDir = path.join(runDir, "verify");
  const htmlPath = path.join(runDir, "output", "pages", `${slug}.html`);
  const metaPath = path.join(runDir, "output", "pages", `${slug}.page-mode.json`);
  const desktopCapture = path.join(runDir, "captures", slug, "fullpage-desktop.png");
  const mobileCapture = path.join(runDir, "captures", slug, "fullpage-mobile.png");
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

  const prior = await readPriorAttempts(metaPath);
  const attempts = prior + 1;
  const attemptState = nextAttemptState({
    attempts,
    pass: gate.pass,
    maxAttempts: gateThresholds.maxAttempts,
  });

  const { markdown, json } = buildPageReport({
    site,
    slug,
    desktop,
    mobile,
    gate,
    attemptState,
    sectionNotes,
    thresholds: gateThresholds,
  });

  await writeFile(path.join(verifyDir, "page-report.md"), markdown);
  await writeFile(path.join(verifyDir, "page-report.json"), JSON.stringify(json, null, 2));

  const pageMode = {
    attempts,
    status: attemptState.status,
    scores: { desktop, mobile },
  };
  await writeFile(metaPath, JSON.stringify(pageMode, null, 2));

  process.stderr.write(
    `  desktop: ${desktop.mismatchPct}% mismatch, ${desktop.heightDeltaPct}% height Δ\n`,
  );
  process.stderr.write(
    `  mobile:  ${mobile.mismatchPct}% mismatch, ${mobile.heightDeltaPct}% height Δ\n`,
  );
  process.stderr.write(`  status:  ${attemptState.status} (attempt ${attempts})\n`);

  if (attemptState.status === "fail") {
    throw new Error(
      `page-verify failed for ${slug} after ${attempts} attempt(s): ${gate.reasons.join("; ") || "hard gate not met"}`,
    );
  }

  return json;
}
