import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { assertCanHandoff } from "./pageGate.mjs";
import { onlyToSlug } from "./slug.mjs";
import { preparePushArtifacts } from "./pushprep.mjs";

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
 * Gate on page-report pass, then swap inline chrome to Twig includes.
 * @param {{ html: string, report: { status?: string } }} opts
 * @returns {string}
 */
export function handoffPageHtml({ html, report }) {
  assertCanHandoff(report);
  return swapInlineChromeToTwig(html);
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
  const swapped = handoffPageHtml({ html, report });
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
    backupPath,
    htmlPath,
    count,
    ok,
    failures,
    outDir: pagePush.outDir,
    push: { page: pagePush, header: headerPush, footer: footerPush },
  };
}
