import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { assertCanHandoff } from "./pageGate.mjs";
import { onlyToSlug } from "./slug.mjs";
import { preparePushArtifacts } from "./pushprep.mjs";
import { readRunConfig } from "./runConfig.mjs";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a balanced open/close pair for `tag` (e.g. "header").
 * @param {string} html
 * @param {string} tag
 * @param {"first" | "last"} which
 * @returns {{ start: number, end: number } | null}
 */
function findBalancedTag(html, tag, which) {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  const opens = [];
  let m;
  while ((m = openRe.exec(html)) !== null) {
    opens.push({ index: m.index, length: m[0].length });
  }
  if (opens.length === 0) return null;

  const candidates = which === "first" ? [opens[0]] : [opens[opens.length - 1]];

  for (const open of candidates) {
    let depth = 1;
    closeRe.lastIndex = open.index + open.length;
    openRe.lastIndex = open.index + open.length;
    let pos = open.index + open.length;
    while (depth > 0 && pos < html.length) {
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;
      const nextOpen = openRe.exec(html);
      const nextClose = closeRe.exec(html);
      if (!nextClose) return null;
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1;
        pos = nextOpen.index + nextOpen[0].length;
      } else {
        depth -= 1;
        pos = nextClose.index + nextClose[0].length;
        if (depth === 0) {
          return { start: open.index, end: pos };
        }
      }
    }
  }
  return null;
}

/**
 * Replace first <header>…</header> and last <footer>…</footer> with Twig includes.
 * @param {string} html
 * @returns {string}
 */
export function swapInlineChromeToTwig(html) {
  const header = findBalancedTag(html, "header", "first");
  if (!header) {
    throw new Error("handoff-page: missing <header> landmark — cannot swap chrome");
  }
  const footer = findBalancedTag(html, "footer", "last");
  if (!footer) {
    throw new Error("handoff-page: missing <footer> landmark — cannot swap chrome");
  }
  if (footer.start < header.end) {
    throw new Error("handoff-page: overlapping header/footer landmarks");
  }

  const HEADER_TWIG = "{{ wpcanai_template('header') }}";
  const FOOTER_TWIG = "{{ wpcanai_template('footer') }}";

  // Replace footer first so header indices stay valid.
  return (
    html.slice(0, header.start) +
    HEADER_TWIG +
    html.slice(header.end, footer.start) +
    FOOTER_TWIG +
    html.slice(footer.end)
  );
}

/**
 * Chrome-skip handoff: the draft is <main>-only, so insert the two Twig
 * includes around it instead of swapping inline chrome.
 */
export function wrapMainWithTwigChrome(html) {
  if (findBalancedTag(html, "header", "first")) {
    throw new Error("chrome skip: draft still contains a <header> landmark — re-transform with --chrome skip, or hand off with --chrome inline");
  }
  if (findBalancedTag(html, "footer", "last")) {
    throw new Error("chrome skip: draft still contains a <footer> landmark — re-transform with --chrome skip, or hand off with --chrome inline");
  }
  const bodyOpen = html.match(/<body\b[^>]*>/i);
  const bodyClose = html.lastIndexOf("</body>");
  if (!bodyOpen || bodyClose < 0) throw new Error("chrome skip: draft has no <body>…</body> to wrap");
  const openEnd = bodyOpen.index + bodyOpen[0].length;
  return (
    html.slice(0, openEnd) + "\n{{ wpcanai_template('header') }}\n" +
    // Trim both ends: the leading side drops the original whitespace right
    // after <body> (or it would double up with the \n just inserted above),
    // the trailing side does the same before the footer include.
    html.slice(openEnd, bodyClose).trim() + "\n{{ wpcanai_template('footer') }}\n" +
    html.slice(bodyClose)
  );
}

/**
 * Gate on page-report pass, then swap inline chrome to Twig includes (or, for
 * a chrome-skip <main>-only draft, wrap it with the Twig includes instead).
 * @param {{ html: string, report: { status?: string }, chrome?: "inline"|"skip" }} opts
 * @returns {string}
 */
export function handoffPageHtml({ html, report, chrome = "inline" }) {
  assertCanHandoff(report);
  return chrome === "skip" ? wrapMainWithTwigChrome(html) : swapInlineChromeToTwig(html);
}

/**
 * Full handoff-page stage: assert verify pass, require chrome partials,
 * backup static draft, swap chrome to Twig in place, then pushprep.
 *
 * Chrome policy (v1): if header.html/footer.html are missing, throw and tell
 * the agent to run `replica transform <site> --only chrome` first — do not
 * mechanically wrap captured header/footer here.
 *
 * @param {{ site: string, runsDir?: string, only: string }} opts
 */
export async function runHandoffPage({ site, runsDir = "runs", only } = {}) {
  if (!site) throw new Error("handoff-page: site is required");
  if (!only) throw new Error("handoff-page: --only <slug> is required");

  const slug = onlyToSlug(only);
  const runDir = path.join(runsDir, site);
  const reportPath = path.join(runDir, "verify", "page-report.json");
  const htmlPath = path.join(runDir, "output", "pages", `${slug}.html`);
  const backupPath = path.join(runDir, "output", "pages", `${slug}.page-mode.static.html`);
  const headerPath = path.join(runDir, "output", "templates", "header.html");
  const footerPath = path.join(runDir, "output", "templates", "footer.html");
  const metaPath = path.join(runDir, "output", "pages", `${slug}.page-mode.json`);

  // run.json wins; when it's missing (e.g. a hand-copied run dir) fall back to
  // the page-mode.json meta verify-page writes (belt and braces — see
  // verifyPage.mjs), then "inline" as the last resort. (The CLI itself
  // requires run.json — see bin/replica — this fallback is for library callers.)
  const runConfig = await readRunConfig(runDir);
  // handoff-page is the pixel objective's exit and nothing else's: a
  // wireframe's height-only verify-page-score also says pass/canHandoff, but
  // a grey-box draft must never be chrome-swapped and pushprepped; styled
  // output uses Twig chrome includes already and goes through pushprep.
  if (runConfig && runConfig.objective !== "pixel") {
    throw new Error(
      `handoff-page is for the pixel objective only — run.json objective is "${runConfig.objective}"; ` +
        (runConfig.objective === "wireframe" ? "a wireframe has nothing to push" : "use pushprep instead"),
    );
  }
  let chrome = runConfig?.chrome ?? null;
  if (chrome == null) {
    try {
      chrome = JSON.parse(await readFile(metaPath, "utf8"))?.chrome ?? null;
    } catch {
      chrome = null;
    }
  }
  chrome = chrome ?? "inline";

  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error(`handoff-page: missing verify/page-report.json at ${reportPath}`);
  }

  const reportSlug = report?.slug != null ? String(report.slug) : "";
  if (reportSlug !== slug) {
    throw new Error(
      `handoff-page: page-report.json slug "${reportSlug || "(missing)"}" does not match --only "${only}" ` +
        `(normalized: "${slug}") — re-run verify-page for this page before handoff`,
    );
  }

  assertCanHandoff(report);

  // A stale page-report from an earlier wireframe/styled pass (or a different
  // chrome mode) must never gate a fresh pixel draft: the report has to have
  // been scored under the hard gate, with the same chrome this run is in.
  const reportMode = report?.thresholds?.mode ?? "(missing)";
  if (reportMode !== "hard") {
    throw new Error(
      `handoff-page: page-report.json was scored in "${reportMode}" mode, not the pixel hard gate — ` +
        `re-run verify-page-score ${site} --only ${slug} under the pixel objective before handoff`,
    );
  }
  const reportChrome = report?.chrome ?? "(missing)";
  if (reportChrome !== chrome) {
    throw new Error(
      `handoff-page: page-report.json chrome "${reportChrome}" does not match run.json chrome "${chrome}" — ` +
        `re-run verify-page-score ${site} --only ${slug} before handoff`,
    );
  }

  if (!(await exists(htmlPath))) {
    throw new Error(`handoff-page: missing output/pages/${slug}.html`);
  }

  // Prefer: require agent-authored chrome via transform --only chrome.
  if (!(await exists(headerPath)) || !(await exists(footerPath))) {
    throw new Error(
      `handoff-page: output/templates/header.html or footer.html missing — ` +
        `run \`replica transform ${site} --only chrome\` first ` +
        `(use a representative page capture), then re-run handoff-page`,
    );
  }

  const html = await readFile(htmlPath, "utf8");
  await writeFile(backupPath, html);
  const swapped = handoffPageHtml({ html, report, chrome });
  await writeFile(htmlPath, swapped);

  const pagePush = await preparePushArtifacts({ site, runsDir, only: slug });
  const headerPush = await preparePushArtifacts({ site, runsDir, only: "header" });
  const footerPush = await preparePushArtifacts({ site, runsDir, only: "footer" });

  const ok =
    (pagePush.ok ?? 0) + (headerPush.ok ?? 0) + (footerPush.ok ?? 0);
  const count =
    (pagePush.count ?? 0) + (headerPush.count ?? 0) + (footerPush.count ?? 0);
  const failures = [
    ...(pagePush.failures || []),
    ...(headerPush.failures || []),
    ...(footerPush.failures || []),
  ];

  return {
    site,
    slug,
    chrome,
    backupPath,
    htmlPath,
    count,
    ok,
    failures,
    outDir: pagePush.outDir,
    push: { page: pagePush, header: headerPush, footer: footerPush },
  };
}
