// Render each generated HTML in agent-browser, screenshot it, score it
// against the original capture via pngdiff (Task 9), and write a worst-first
// verify/report.md so a human only has to eyeball the failures.
//
// A raw output/templates/*.html file is never pixel-scored: its literal
// {{ post.title }} placeholders render as text in a browser, so a diff
// against the original screenshot would be noise, not signal. The same now
// applies to any one-off page that includes the shared chrome via
// {{ wpcanai_template('header') }}. canai-replicate has no Twig engine — it
// has no PHP dependency at all, by design — and Twig genuinely executes in
// exactly one place: the live WordPress site. So both cases are
// screenshotted raw (still useful for a structural eyeball) and listed
// under "Not scored" pointing at post-deploy verification: canai-prepare
// shapes the pages/layouts, canai-mcp deploys them, and the real render is
// what gets checked.
//
// The two shared-chrome partials (output/templates/header.html/footer.html —
// see prompts/transform-chrome.md) are excluded entirely: they're fragments
// meant to be spliced into another template, not independently scorable
// pages.

import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import path from "node:path";
import { spawnAgentBrowser, resolveSessionCdpEndpoint } from "./agentBrowser.mjs";
import { matchesOnly } from "./slug.mjs";
import { decodePng, diffScore } from "./pngdiff.mjs";
import { isChromePartial, containsTwigSyntax, classifyTemplateFilename } from "./outputFiles.mjs";
import { captureFullPageScreenshot } from "./cdp.mjs";
import { isBrowserDeathError, PAGE_SIZE_JS, parseEvalJson } from "./capture.mjs";

// `input`, when given, is written to the child's stdin then closed — needed
// for `eval --stdin` (see takeVerifyScreenshot's page-size measurement
// below). Existing call sites (none of which pass a second argument) are
// unaffected: stdin stays "ignore", exactly as before.
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

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Collect outputs: v3 subdirs (pages/, templates/) plus legacy flat files.
// Pure filesystem scan (no browser); a missing dir just contributes nothing
// rather than erroring, so a run that hasn't produced output/templates/ yet
// is unremarkable. Each entry keeps the dir it came from (the render loop
// needs it to resolve the real file path) and a `kind` — "page" or
// "template" — which is what gates scoring off for templates below.
export async function collectOutputs(outputDir) {
  const collect = async (dir, kind) => {
    try {
      return (await readdir(dir))
        .filter((f) => f.endsWith(".html"))
        .map((f) => ({ file: f, dir, kind }));
    } catch {
      return [];
    }
  };
  return [
    ...(await collect(path.join(outputDir, "pages"), "page")),
    ...(await collect(path.join(outputDir, "templates"), "template")),
    ...(await collect(outputDir, "page")), // legacy flat output/
  ];
}

// Narrow `entries` to one page/type via --only (URL pathname, slug, or type
// name — matchesOnly, src/slug.mjs, is the ONE shared matcher capture and
// transform also use). Throws when nothing matches, matching every other
// stage's --only.
//
// Fix 2: pre-fix, this only ever compared against onlyToSlug(only) directly
// — so a page-type name ("product") never matched a repeating type's
// "product-single.html"/"product-archive.html" output, even though its own
// doc comment (directly above, before this fix) claimed parity with
// capture/transform. Verify was in fact the ONE stage where --only <type>
// unconditionally threw.
// header.html/footer.html (prompts/transform-chrome.md) are Twig fragments
// meant to be spliced into another template via {{ wpcanai_template(...) }},
// never independently opened or scored — collectOutputs still lists them
// (they're real .html files under output/templates/), so verify() calls
// this BEFORE applyOnlyFilter, so `--only header` (which would otherwise
// match the existing template-type-name convention — see
// classifyTemplateFilename in outputFiles.mjs) can't resurrect an attempt to
// score one.
export function excludeChromePartials(entries) {
  return entries.filter((e) => !(e.kind === "template" && isChromePartial(e.file)));
}

export function applyOnlyFilter(entries, only) {
  if (!only) return entries;
  const filtered = entries.filter((e) => {
    const slug = e.file.replace(/\.html$/, "");
    const typeName = e.kind === "template" ? classifyTemplateFilename(e.file).typeName : null;
    return matchesOnly(only, { slug, typeName });
  });
  if (filtered.length === 0) throw new Error(`no output matches --only ${only}`);
  return filtered;
}

// Score a rendered entry against its original capture screenshot, if one
// applies. Two things are never scored, for the same underlying reason —
// unresolved Twig renders as literal text in a browser, so a pixel diff
// against the original would be noise, not signal: templates
// (kind !== "page"), and any page whose HTML still contains Twig
// delimiters (hasTwig — a page that includes the shared header/footer
// chrome). canai-replicate has no Twig engine to resolve either one; that
// happens on the live site after deploy. A
// missing original (page never captured), or a decodePng/diffScore failure
// (unsupported PNG format, truncated file, ...), both degrade to "no score"
// rather than throwing — one bad pair must never abort the whole verify run.
export async function scorePageAgainstOriginal({ kind, originalPng, generatedPng, hasTwig = false }) {
  const hasOriginal = kind === "page" && !hasTwig && (await exists(originalPng));
  let score = null;
  let error = null;
  if (hasOriginal) {
    try {
      score = diffScore(
        decodePng(await readFile(originalPng)),
        decodePng(await readFile(generatedPng)),
      );
    } catch (e) {
      error = e.message;
    }
  }
  return { hasOriginal, score, error };
}

// report.md: scored pages sorted worst-first, then everything that couldn't
// be scored — a page whose HTML still contains unresolved Twig (labelled
// "verify after deploy against the live site", since Twig only ever
// executes on the live WordPress site), a template (labelled as
// never-scored/structural-review-only, whether or not it happens to contain
// Twig delimiters — templates are never pixel-scored regardless), pages
// with no original to compare against, and outright render failures.
// Pure/sync: takes the same `results` shape verify() accumulates, returns
// the file's lines.
//
// --- severity: why not raw mismatchPct, and why not max() either ---
//
// Raw mismatchPct alone under-ranks a badly broken page: diffScore only
// compares the top-left OVERLAP of the two images (the shorter image's
// height), so a page that rendered almost nothing looks deceptively close
// on mismatchPct alone when the design is whitespace-heavy — the sliver
// that IS compared is mostly background color in both images. Task 10's
// calibration against wpdev.xcloudzen.com's real index page found: a
// faithful rebuild scored 3.4% mismatch / 5.5% height delta, while a page
// truncated to just its header+hero (missing ~60% of the content) scored
// 11.2% mismatch — only ~3x worse — but 59.9% height delta, ~11x worse.
// That's why Task 10 shipped `Math.max(mismatchPct, heightDeltaPct)`: it
// catches whichever signal actually fired.
//
// But max() has its own blind spot, found by building adversarial cases
// through these real functions: height delta is not on its own a reliable
// severity signal, because it also fires on perfectly FAITHFUL pages —
// extra trailing whitespace, a font fallback that reflows text taller, a
// slow-loading web font. Four cases (percentages are mismatchPct /
// heightDeltaPct; "max" is Task 10's formula):
//
//   1. faithful rebuild                 3.4 /  5.5   max = 5.5
//   2. truncated/broken page           11.0 / 59.9   max = 59.9
//   3. faithful but 20% taller          0.0 / 20.0   max = 20.0
//   4. wrong content, same height      15.0 /  0.0   max = 15.0
//
// max()'s order is 2, 3, 4, 1 — case 3 (a FAITHFUL page) outranks case 4
// (WRONG content). The human's first click would land on a fine page while
// a genuinely broken one sits lower in the report — exactly backwards.
// Root cause: max() lets height delta alone crown the report even when
// mismatchPct says the pixels agree completely.
//
// The fix is a weighted SUM, not a max: count mismatchPct in full — it is
// the direct measure of "are the pixels actually wrong" — and add height
// delta at a fraction of its value: big enough to still surface the
// truncation case (2) over a merely-noisy faithful page (1), too small to
// let a benign height difference (3) outrank real wrong content (4).
//
//   severity = mismatchPct + HEIGHT_WEIGHT * heightDeltaPct
//
// The two inequalities that actually matter (case 2 over case 4, case 4
// over case 3 — see the module-level required outcome) pin the valid range
// for HEIGHT_WEIGHT against the four cases above:
//   case 2 > case 4:  11.0 + 59.9w > 15.0   → w > 0.067
//   case 4 > case 3:  15.0        > 20.0w   → w < 0.75
// (case 2 > case 1 and case 2 > case 3 hold for every w >= 0 — case 2's
// mismatchPct alone already clears both.) HEIGHT_WEIGHT = 0.3 sits well
// inside that (0.067, 0.75) window, not on a knife-edge, biased toward the
// low/mismatch-dominant side as the brief asked. Applied to the four cases:
//
//   1. faithful rebuild               3.4 + 0.3×5.5  =  5.05
//   2. truncated/broken page         11.0 + 0.3×59.9 = 28.97
//   3. faithful but 20% taller        0.0 + 0.3×20.0 =  6.00
//   4. wrong content, same height    15.0 + 0.3×0.0  = 15.00
//
// Resulting order: 2 (28.97), 4 (15.00), 3 (6.00), 1 (5.05) — both broken
// pages (2, 4) now outrank both faithful ones (1, 3). (1 vs 3 isn't
// load-bearing either way — both are "fine, low priority," and which of
// two fine pages prints first doesn't change what the human does next.)
//
// Caveat inherited from pngdiff.mjs (frozen, out of scope here):
// heightDeltaPct is direction-blind (`Math.abs` inside diffScore) — "20%
// taller from a font fallback" and "20% shorter from missing content"
// score identically on that axis alone. Weighting height down (rather than
// to zero) is a mitigation, not a fix, for that: it still contributes
// (case 2 needs it to outrank case 1), but genuine content problems now
// show up via mismatchPct too, which is why they dominate the sum instead
// of being masked by a same-magnitude-either-direction height number.
const HEIGHT_WEIGHT = 0.3;

export function severityScore(r) {
  return r.mismatchPct + HEIGHT_WEIGHT * r.heightDeltaPct;
}

export function buildReportLines({ site, results }) {
  const scored = results.filter((r) => r.scored).sort((a, b) => severityScore(b) - severityScore(a));
  const unscored = results.filter((r) => !r.scored);
  // Only print the Twig-explanation paragraph when something in the Not
  // scored list is actually there because of Twig (a hasTwig page) or is a
  // template (which is never scored regardless of Twig content) — an empty
  // or all-scored run has nothing for that paragraph to explain.
  const needsTwigExplanation = unscored.some((r) => r.kind === "template" || r.hasTwig);
  return [
    `# Verify report — ${site}`,
    "",
    "Scored pages are sorted worst-first by severity — mismatch % counted in " +
      `full plus ${HEIGHT_WEIGHT * 100}% of height Δ % (see the comment above ` +
      "buildReportLines in verify.mjs for the full derivation). That keeps a " +
      "genuinely wrong-content page ranked above one that's merely a " +
      "different height (trailing whitespace, a font-fallback reflow) while " +
      "still surfacing a truncated/broken page ahead of a faithful one. " +
      "Review from the top down; severity is derived from the two raw " +
      "columns, both still verbatim pngdiff.mjs output.",
    "",
    "## Scored pages (worst first)",
    "",
    "| page | severity | mismatch % | height Δ % | original | generated |",
    "| --- | --- | --- | --- | --- | --- |",
    ...scored.map(
      (r) =>
        `| ${r.slug} | ${severityScore(r).toFixed(1)} | ${r.mismatchPct} | ${r.heightDeltaPct} | ${r.original} | ${r.generated} |`,
    ),
    "",
    "## Not scored (eyeball these)",
    "",
    ...(needsTwigExplanation
      ? [
          "Outputs containing unresolved Twig (`{{` / `{%`) can't be scored here — " +
            "canai-replicate has no Twig engine, by design. Twig executes on the live " +
            "WordPress site, so verify these after canai-mcp deploys them; what you " +
            "can usefully check locally is structure, not pixels. A template is never " +
            "pixel-scored either way, even on the rare one with no Twig in it — its job " +
            "is per-item substitution, not standing alone as a static page.",
          "",
        ]
      : []),
    ...unscored.map((r) => {
      if (!r.ok) return `- ${r.slug}: render FAILED — ${r.error}`;
      // A page that includes the shared {{ wpcanai_template }} chrome (or
      // otherwise still carries Twig) can't be resolved locally — nothing
      // here has a Twig engine. Say where it DOES get verified rather than
      // implying the gap is permanent.
      if (r.hasTwig) {
        return `- ${r.slug} (contains unresolved Twig — verify after deploy against the live site): ${r.generated}`;
      }
      // A template is never pixel-scored, independent of whether it happens
      // to contain Twig delimiters — it renders one item's worth of
      // `{{ post.title }}`-style substitution, not a standalone static page.
      // Saying "contains unresolved Twig" here would be false for the rare
      // template with none.
      if (r.kind === "template") {
        return `- ${r.slug} (template — templates are never scored here; review structurally): ${r.generated}`;
      }
      return `- ${r.slug} (no original capture): ${r.generated}`;
    }),
    "",
  ];
}

// Fix 2 (prerelease review): verify used to take its full-page screenshot via
// agent-browser's own unguarded `screenshot --full` — the exact call that,
// with no clip-guard or bounded timeout, crashed Chrome during capture and
// produced silently-clamped 26,394px voids before cdp.mjs's
// captureFullPageScreenshot fixed capture.mjs's captureOne (commit a3c4638;
// see that function's doc comment in cdp.mjs for the full live evidence).
// verify imported none of that fix. A tall rendered page or template — a
// long recipe-single template is exactly this dogfood's own trigger shape —
// can crash Chrome here just as easily.
//
// takeVerifyScreenshot measures the page itself (PAGE_SIZE_JS, imported from
// capture.mjs so the formula stays in lockstep with captureOne's own measurement)
// and takes the shot through cdp.mjs's captureFullPageScreenshot — the same
// height cap (MAX_FULL_PAGE_HEIGHT_PX) and the same longer, bounded timeout
// every caller of that function gets, instead of a re-implementation.
//
// Injection seams (abImpl/resolveEndpoint/captureFullPage) default to the
// real implementations; tests override them to prove the capped/timeout
// wiring without a live browser or WebSocket (mirrors cdp.test.mjs's own
// fetch/WebSocket stubbing style).
export async function takeVerifyScreenshot({
  flags,
  fileUrl,
  generatedPng,
  cdp,
  session,
  abImpl = ab,
  resolveEndpoint = resolveSessionCdpEndpoint,
  captureFullPage = captureFullPageScreenshot,
}) {
  const sizeRes = await abImpl([...flags, "eval", "--stdin"], { input: PAGE_SIZE_JS });
  const size = parseEvalJson(sizeRes.stdout);
  const width = Number(size && size.width);
  const height = Number(size && size.height);
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`could not measure page size for full-page screenshot (got ${JSON.stringify(size)})`);
  }
  const { host, port } = resolveEndpoint({ cdp, session });
  return captureFullPage({ host, port, url: fileUrl, width, height, outPath: generatedPng });
}

// Fix 2 recovery: mirrors capture.mjs's own (unexported) defaultRecoverBrowser
// exactly — ask agent-browser for a fresh tab after a browser-death error;
// success is landing on about:blank. If the whole browser process is gone,
// agent-browser's own auto-launch attempt-and-fail is what makes this fail
// fast; the caller reacts to a false return, never to this throwing.
export async function recoverBrowserTab({ flags, abImpl = ab }) {
  try {
    await abImpl([...flags, "tab", "new", "about:blank"]);
    const res = await abImpl([...flags, "get", "url"]);
    return /^about:blank/.test(res.stdout.trim());
  } catch {
    return false;
  }
}

// The browser-touching part of verifying one entry: ensure a working tab,
// navigate to it, let it settle, take the full-page screenshot. Extracted
// (mirrors capture.mjs's captureOne/captureOneImpl split) so verify()'s
// browser-death retry below can re-run exactly this sequence — never the
// scoring step (scorePageAgainstOriginal), which is pure file I/O against
// already-written PNGs and never needs a retry.
export async function verifyOne({
  flags,
  fileUrl,
  generatedPng,
  cdp,
  session,
  abImpl = ab,
  takeScreenshot = takeVerifyScreenshot,
}) {
  // Ensure a regular tab; see capture.mjs ensureWorkingTab note.
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
    await abImpl([...flags, "wait", "1500"]);
  } catch {}
  return takeScreenshot({ flags, fileUrl, generatedPng, cdp, session, abImpl });
}

export async function verify({
  site,
  runsDir = "runs",
  cdp = 9223,
  session = "personal",
  only = null,
  // Injection seams (Fix 2) — production callers never pass these; they
  // default to the real browser-touching sequence (verifyOne) and the real
  // fresh-tab recovery (recoverBrowserTab). Tests override them to drive the
  // browser-death/recovery/continue orchestration deterministically,
  // mirroring capture()'s captureOneImpl/recoverBrowser seams (capture.mjs)
  // without a live browser or WebSocket.
  verifyOneImpl = verifyOne,
  recoverBrowser = recoverBrowserTab,
} = {}) {
  const runDir = path.join(runsDir, site);
  const outputDir = path.join(runDir, "output");
  const verifyDir = path.join(runDir, "verify");
  await mkdir(verifyDir, { recursive: true });
  const flags = ["--cdp", String(cdp), "--session", session];

  const rawEntries = await collectOutputs(outputDir);
  for (const e of rawEntries) {
    if (e.kind === "template" && isChromePartial(e.file)) {
      process.stderr.write(`  (skipping shared-chrome partial, not an independently scorable page: ${e.file})\n`);
    }
  }
  const entries = applyOnlyFilter(excludeChromePartials(rawEntries), only);

  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const { file, dir, kind } = entries[i];
    const slug = file.replace(/\.html$/, "");
    const htmlPath = path.resolve(dir, file);
    const generatedPng = path.resolve(verifyDir, `${slug}-generated.png`);

    process.stderr.write(`[${i + 1}/${entries.length}] ${slug}\n`);

    // canai-replicate has no Twig engine (no PHP, by design — see SKILL.md).
    // An output that still contains Twig delimiters therefore cannot be
    // resolved locally: it's screenshotted raw, which is still worth
    // eyeballing for structure, but never pixel-scored, and the report tells
    // the human it gets verified after deploy instead. Twig executes on the
    // live WordPress site; that is the only place it ever really runs.
    const rawHtml = await readFile(htmlPath, "utf8").catch(() => null);
    const hasTwig = containsTwigSyntax(rawHtml);
    if (hasTwig) {
      process.stderr.write(`  contains unresolved Twig — not scored locally; verify after deploy\n`);
    }

    const originalPng = path.resolve(runDir, "captures", slug, "screenshot.png");
    const fileUrl = `file://${htmlPath}`;
    // Fix 2: bounded to ONE recovery attempt per entry, exactly like
    // capture()'s per-entry recoveryAttempted bound (capture.mjs) — a
    // browser-death error here retries the SAME entry once after a fresh
    // tab; any other failure (or a still-failing retry) falls through to
    // the existing "fail loudly, record ok:false, move on" behavior below,
    // unchanged. Unlike capture(), there's no cross-entry sticky "browser
    // confirmed down" memory — verify's worklist is a fixed list of local
    // files, not a remote worklist with its own fallback pool, so each
    // entry simply gets its own fair one-shot recovery attempt; kept this
    // much simpler on purpose (verify's loop doesn't need capture's
    // fallback-URL machinery to begin with).
    let recoveryAttempted = false;
    for (;;) {
      try {
        const shot = await verifyOneImpl({ flags, fileUrl, generatedPng, cdp, session });
        if (shot && shot.capped) {
          process.stderr.write(
            `  ! full-page screenshot capped at ${shot.height}px for ${slug} (page is actually ${shot.requestedHeight}px tall)\n`,
          );
        }

        const { hasOriginal, score, error } = await scorePageAgainstOriginal({ kind, originalPng, generatedPng, hasTwig });
        if (error) process.stderr.write(`  ! diff skipped: ${error}\n`);
        results.push({
          slug,
          kind,
          ok: true,
          scored: score != null,
          mismatchPct: score ? Number(score.mismatchPct.toFixed(1)) : null,
          heightDeltaPct: score ? Number(score.heightDeltaPct.toFixed(1)) : null,
          generated: generatedPng,
          original: hasOriginal ? originalPng : null,
          ...(hasTwig ? { hasTwig } : {}),
        });
        if (hasOriginal) {
          process.stderr.write(`  original:  ${originalPng}\n`);
        }
        process.stderr.write(`  generated: ${generatedPng}\n`);
        if (score) process.stderr.write(`  diff: ${score.mismatchPct.toFixed(1)}% mismatch, ${score.heightDeltaPct.toFixed(1)}% height delta\n`);
        break;
      } catch (e) {
        process.stderr.write(`  ✗ ${e.message}\n`);
        if (isBrowserDeathError(e) && !recoveryAttempted) {
          recoveryAttempted = true;
          process.stderr.write(`  ! ${slug}: looks like the browser/tab died (${e.message}) — attempting recovery\n`);
          let recovered = false;
          try {
            recovered = await recoverBrowser({ flags });
          } catch {
            recovered = false;
          }
          if (recovered) {
            process.stderr.write(`  ↻ browser recovered for ${slug} — retrying\n`);
            continue; // retry the SAME entry once
          }
          process.stderr.write(`  ✗ ${slug}: browser recovery failed\n`);
        }
        results.push({ slug, kind, ok: false, error: e.message, ...(hasTwig ? { hasTwig } : {}) });
        break;
      }
    }
  }

  // Worst-first review report.
  const lines = buildReportLines({ site, results });
  const reportPath = path.join(verifyDir, "report.md");
  await writeFile(reportPath, lines.join("\n"));

  // Write a small manifest so the user has a single index of pairs to review.
  const manifestPath = path.join(verifyDir, "index.json");
  await writeFile(manifestPath, JSON.stringify({ site, pairs: results }, null, 2));

  return {
    count: results.length,
    ok: results.filter((r) => r.ok).length,
    // Fix (final review): a run can render/screenshot every page and still
    // pixel-score NONE of them — current-generation output always includes
    // the shared {{ wpcanai_template('header') }}/footer chrome (see
    // prompts/transform.md), so hasTwig is true for practically everything.
    // `scored`/`twig` let bin/replica report that honestly instead of
    // printing an unqualified "N/N rendered" success line over a run that
    // scored nothing.
    scored: results.filter((r) => r.scored).length,
    twig: results.filter((r) => r.hasTwig).length,
    manifestPath,
    reportPath,
  };
}
