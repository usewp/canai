import { assertCanHandoff } from "./pageGate.mjs";

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
