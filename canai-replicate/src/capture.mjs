// Capture each page from pages.json via agent-browser.
// For each URL: full screenshot, post-hydration DOM, structured content, asset list.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { urlToSlug, matchesOnly } from "./slug.mjs";
import {
  captureNodeScreenshot,
  captureFullPageScreenshot,
  setViewport,
  isBrowserReachable,
  MAX_CLIP_WIDTH_PX,
  MAX_CLIP_HEIGHT_PX,
  MAX_CLIP_AREA_PX2,
} from "./cdp.mjs";
import { spawnAgentBrowser, resolveSessionCdpEndpoint } from "./agentBrowser.mjs";

// Every ab() call shells out to the agent-browser CLI and waits for it to
// exit. Without a bound, a stalled renderer — the EXACT condition the
// viewport-contamination path below exists to detect and recover from — can
// wedge that subprocess (and so this promise) forever: `wait --load
// networkidle` never idling, an `eval` against a page whose JS engine is
// stuck, `tab new` itself hanging. Fix 3 (Task 4c) timed out
// `CDPSession.send()` for the raw-CDP path (cdp.mjs) but left THIS,
// the agent-browser CLI path, unbounded — so the very mechanism meant to
// prove a stalled-renderer recovery worked (measureInnerWidth/
// measureViewportSize, the fresh-tab self-heal) could itself hang,
// reintroducing the hang class Fix 3 was supposed to close (Task 4d,
// Finding 2). Applying the timeout to the shared `ab()` helper itself
// (rather than to a few call sites) protects every current and future
// caller uniformly.
//
// `timeoutMs` is generous — comfortably longer than the slowest legitimate
// operation this file asks agent-browser to do (a full-page screenshot of a
// very tall page, a `wait --load networkidle` on a site that's merely slow,
// not stuck) — so a healthy-but-slow call is never mistaken for a hang; it
// exists purely to convert "wedged forever" into "fails after a bounded
// time". On timeout the child is SIGTERM'd immediately and, if it's still
// alive after `killGraceMs`, SIGKILL'd, so a child stubborn enough to ignore
// SIGTERM can't survive as a zombie either — the promise itself rejects the
// moment the timer fires, without waiting to see whether the kill actually
// lands (a wedged-enough renderer might not react to signals promptly
// either, and the point is that the CALLER must never hang).
//
// `spawnFn` is an injection seam for tests (default: the real
// spawnAgentBrowser); production callers never need to pass it.
const DEFAULT_AB_TIMEOUT_MS = 60_000;
const AB_KILL_GRACE_MS = 3_000;

export function ab(
  args,
  {
    input,
    capture = true,
    timeoutMs = DEFAULT_AB_TIMEOUT_MS,
    killGraceMs = AB_KILL_GRACE_MS,
    spawnFn = spawnAgentBrowser,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(args, {
      stdio: ["pipe", capture ? "pipe" : "inherit", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      settle(
        reject,
        Object.assign(new Error(`agent-browser ${args.join(" ")} timed out after ${timeoutMs}ms and was killed`), {
          timedOut: true,
        }),
      );
      try {
        proc.kill("SIGTERM");
      } catch {}
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    if (capture) proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => settle(reject, e));
    proc.on("close", (code, signal) => {
      if (settled) return; // already timed out and rejected; this is just the (now moot) actual exit
      if (code !== 0) {
        // A signal-killed child reports code: null, signal: "SIGTERM" (or
        // similar) — without this note the message reads "exited null" with
        // no hint the process was killed rather than merely non-zero-exited.
        const signalNote = signal ? ` (killed by signal ${signal})` : "";
        const err = new Error(`agent-browser exited ${code}${signalNote}: ${stderr.trim() || stdout.trim()}`);
        err.code = code;
        err.signal = signal;
        err.stderr = stderr;
        return settle(reject, err);
      }
      settle(resolve, { stdout, stderr });
    });
    if (input != null) {
      proc.stdin.write(input);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

// Content extraction is structured to match the page's section shape:
//   { header, main: [section, ...], footer }
// Each entry is scoped to one tagged element (set by SECTIONS_JS) and lists
// only the headings/paragraphs/lists/links/images/forms/buttons/tables/
// definitionLists/labelValuePairs that live inside that element. The last
// three are additive (Task 7b): <table>/<dl>/SKU-style "Label: value"
// markup were previously invisible to content.json entirely — a `<td>` or
// bare `<span>`'s text was never read by ANY extractor above, silently
// dropping a WooCommerce product's SKU/attributes table, and any site's
// spec sheets or comparison/pricing tables, from anything downstream that
// treats content.json as the verbatim ground truth (see transform.md).
// This makes content.json line up 1:1 with the per-section screenshots in
// `sections/` and `sections.json`. SECTIONS_JS MUST be evaluated before
// this script so that `[data-capture-id]` markers are present.
const CONTENT_JS = `
(() => {
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const text = (el) => (el && (el.innerText || el.textContent) || "").trim().replace(/\\s+/g, " ");

  const meta = (name) => {
    const el = document.querySelector('meta[name="' + name + '"]') ||
               document.querySelector('meta[property="' + name + '"]');
    return el ? el.getAttribute("content") : null;
  };

  const samp = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      margin: cs.margin,
      borderRadius: cs.borderRadius,
      letterSpacing: cs.letterSpacing,
    };
  };

  // --- Tables: structured rows with header vs data cells kept distinct,
  // plus a caption if present. buildTableModel (capture.mjs, exported) is a
  // pure parity copy of this row-classification/pairs logic — kept in sync
  // by hand (this string runs inside the captured page via eval, with zero
  // dependencies, so it can't literally import that; same constraint as
  // accentScore/isRenderedGivenComputedStyle elsewhere in this file) — see
  // its doc comment for the full rationale. In short: a row is only ever
  // excluded from \`rows\` into \`headers\` when EVERY cell in it is a <th>
  // (a true column-header row); a WooCommerce-style attributes row (one
  // <th> label + one <td> value, no dedicated header row at all) stays in
  // \`rows\`, which is what lets \`pairs\` fall out of a plain
  // 2-cells-per-row check afterward. Defensive per-table so one malformed
  // table can't throw and take the rest of content extraction down with it.
  const buildTableModel = (rowsCells) => {
    const rows = [];
    let headers = [];
    let headerTaken = false;
    for (const cells of rowsCells) {
      if (!cells.length) continue;
      const values = cells.map((c) => c.text);
      if (!headerTaken && cells.every((c) => c.tag === "TH")) {
        headers = values;
        headerTaken = true;
      } else {
        rows.push(values);
      }
    }
    const hasText = headers.some(Boolean) || rows.some((r) => r.some(Boolean));
    if (!hasText) return null;
    let pairs = null;
    if (rows.length && rows.every((r) => r.length === 2)) {
      pairs = rows.map(([label, value]) => ({ label, value }));
    }
    return { headers, rows, pairs };
  };
  const extractTable = (t) => {
    try {
      const rowsCells = $$("tr", t).map((tr) => $$("th,td", tr).map((c) => ({ tag: c.tagName, text: text(c) })));
      const model = buildTableModel(rowsCells);
      if (!model) return null;
      const captionEl = t.querySelector("caption");
      return { caption: captionEl ? text(captionEl) : null, ...model };
    } catch {
      return null;
    }
  };

  // --- Definition lists: <dt>/<dd> pairs. buildDefinitionListPairs
  // (capture.mjs, exported) is this function's pure parity copy — same
  // eval-boundary constraint as buildTableModel above. \`$$("dt,dd", dl)\`
  // walks through the HTML5 "<dl><div><dt>…<dd>…</div></dl>" wrapper
  // pattern (e.g. MDN-style markup) the same as the flat
  // <dl><dt>…<dd>…</dl> shape, since querySelectorAll matches descendants
  // regardless of an intervening <div>.
  const buildDefinitionListPairs = (items) => {
    const pairs = [];
    let label = null;
    let values = [];
    const flush = () => {
      if (label && values.length) pairs.push({ label, value: values.join(", ") });
      values = [];
    };
    for (const it of items) {
      if (it.tag === "DT") {
        flush();
        label = it.text;
      } else if (label && it.text) {
        values.push(it.text);
      }
    }
    flush();
    return pairs.length ? { pairs } : null;
  };
  const extractDl = (dl) => {
    try {
      return buildDefinitionListPairs($$("dt,dd", dl).map((el) => ({ tag: el.tagName, text: text(el) })));
    } catch {
      return null;
    }
  };

  // --- Narrow label/value pairs from plain <span>/<div> wrappers — the
  // WooCommerce SKU shape (\`<span class="sku_wrapper">SKU: <span
  // class="sku">BB-123</span></span>\`) and equivalents on other themes/
  // sites never go through <table> or <dl>, so without this they're
  // invisible to every extractor above (and always were — this is not a
  // regression; \`paragraphs\`/\`lists\` never scanned bare <span>/<div> text
  // either). Deliberately narrow: a bare "scan every span" heuristic would
  // hoover up nav/UI chrome text and flood content.json with noise, which
  // is worse than the gap it closes. matchLabelValuePair (capture.mjs,
  // exported) is this matcher's pure parity copy (same eval-boundary
  // constraint) and is where the actual shape rules are documented/tested:
  // a short "Label:" prefix as the element's OWN text, a distinct value
  // (inline after the colon, or in exactly one child element), and the
  // element's FULL text must be exactly "label: value" — nothing else
  // going on in that wrapper. Skips anything already inside a
  // <table>/<dl>/<form> (covered above/elsewhere; must not double-report).
  // A capped output size (MAX_LABEL_VALUE_PAIRS, per section) is a cheap
  // extra backstop against a pathological page, on top of those shape
  // constraints.
  const LABEL_VALUE_RE = /^([A-Za-z][A-Za-z0-9 &'/-]{1,29}):\\s*(.*)$/;
  const matchLabelValuePair = (ownText, fullText, childCount, childText) => {
    const m = LABEL_VALUE_RE.exec(ownText || "");
    if (!m) return null;
    const label = m[1].trim();
    let value = m[2].trim();
    if (!value) {
      if (childCount !== 1) return null;
      value = (childText || "").trim();
    }
    if (!value || value.length > 200) return null;
    if (fullText !== (label + ": " + value) && fullText !== (label + ":" + value)) return null;
    return { label, value };
  };
  const MAX_LABEL_VALUE_PAIRS = 30;
  const extractLabelValuePairs = (root) => {
    const out = [];
    for (const el of $$("span,div", root)) {
      if (out.length >= MAX_LABEL_VALUE_PAIRS) break;
      try {
        if (el.closest("table,dl,form")) continue;
        let ownText = "";
        for (const n of el.childNodes) {
          if (n.nodeType === 3) ownText += n.textContent; // 3 === Text node
        }
        ownText = ownText.trim().replace(/\\s+/g, " ");
        if (!ownText) continue;
        const kids = el.children;
        const childText = kids.length === 1 ? text(kids[0]) : "";
        const m = matchLabelValuePair(ownText, text(el), kids.length, childText);
        if (m) out.push(m);
      } catch {
        // One malformed element must not stop the scan of the rest.
      }
    }
    return out;
  };

  const extract = (root) => {
    if (!root) return null;
    const headings = $$("h1,h2,h3,h4,h5,h6", root).map(h => ({
      level: parseInt(h.tagName[1], 10),
      text: text(h),
    })).filter(h => h.text);

    const paragraphs = $$("p", root).map(text).filter(Boolean);

    const lists = $$("ul,ol", root).map(l => ({
      ordered: l.tagName === "OL",
      items: $$("li", l).map(text).filter(Boolean),
    })).filter(l => l.items.length);

    const links = $$("a[href]", root).map(a => ({
      text: text(a),
      href: a.href,
    })).filter(l => l.text || l.href);

    const images = $$("img", root).map(i => ({
      src: i.currentSrc || i.src,
      alt: i.alt || "",
      width: i.naturalWidth || null,
      height: i.naturalHeight || null,
    })).filter(i => i.src);

    const forms = $$("form", root).map(f => ({
      action: f.getAttribute("action") || null,
      method: (f.getAttribute("method") || "get").toLowerCase(),
      fields: $$("input,select,textarea,button", f).map(e => ({
        tag: e.tagName.toLowerCase(),
        type: e.type || null,
        name: e.name || null,
        placeholder: e.placeholder || null,
        label: ((e.labels && e.labels[0] && e.labels[0].innerText) || "").trim() || null,
        value: (e.tagName === "BUTTON" ? text(e) : null),
      })),
    }));

    const buttons = Array.from(new Set(
      $$("button,[role=button]", root).map(text).filter(Boolean)
    ));

    const tables = $$("table", root).map(extractTable).filter(Boolean);
    const definitionLists = $$("dl", root).map(extractDl).filter(Boolean);
    const labelValuePairs = extractLabelValuePairs(root);

    return {
      headings, paragraphs, lists, links, images, forms, buttons,
      tables, definitionLists, labelValuePairs,
    };
  };

  const findById = (id) => document.querySelector('[data-capture-id="' + id + '"]');

  const headerEl = findById("header");
  const footerEl = findById("footer");

  // All other tagged elements are body sections, in document order.
  const sectionEls = $$("[data-capture-id]").filter(el => {
    const id = el.getAttribute("data-capture-id");
    return id !== "header" && id !== "footer";
  });

  const main = sectionEls.map(el => {
    const id = el.getAttribute("data-capture-id");
    const cls = (typeof el.className === "string" ? el.className : "").trim().slice(0, 120);
    return {
      id,
      role: id === "hero" ? "hero" : "section",
      tag: el.tagName.toLowerCase(),
      className: cls || null,
      elementId: el.id || null,
      ...extract(el),
    };
  });

  return {
    title: document.title,
    url: location.href,
    description: meta("description") || meta("og:description"),
    ogImage: meta("og:image"),
    lang: document.documentElement.lang || null,
    computedStyles: {
      html: samp("html"),
      body: samp("body"),
      h1: samp("h1"),
      h2: samp("h2"),
      h3: samp("h3"),
      a: samp("a"),
      button: samp("button, [type=submit], [role=button]"),
      primaryBtn: samp(".btn-primary, .button-primary, button.primary, .primary-button"),
    },
    header: extract(headerEl),
    main,
    footer: extract(footerEl),
  };
})();
`;

// Pure parity copy of CONTENT_JS's in-browser table-model builder (Task
// 7b) — same "can't literally import into an eval'd string" constraint as
// accentScore/isRenderedGivenComputedStyle/etc. below (kept in sync by
// hand). Takes each row as already-extracted plain data (one
// `{ tag: "TH"|"TD", text }` per cell, in column order) rather than DOM
// elements, so this pins the DECISION logic — which row (if any) is a
// column-header row, and whether the remaining data rows are confidently a
// 2-column "label / value" table — without needing a real DOM to exercise
// it. A row counts as the (single) column-header row only when EVERY cell
// in it is a <th> — a WooCommerce-style attributes row (one <th> label +
// one <td> value per row, no dedicated header row at all) never matches
// that, so it stays in `rows`, which is what lets `pairs` fall out of a
// plain "does every remaining row have exactly 2 cells?" check afterward.
// Only the FIRST all-<th> row is treated as the header; multi-level header
// tables are rare enough (and irrelevant to the SKU/spec-table shapes this
// exists for) that later ones are simply left as ordinary data rows.
export function buildTableModel(rowsCells) {
  const rows = [];
  let headers = [];
  let headerTaken = false;
  for (const cells of rowsCells) {
    if (!cells || !cells.length) continue;
    const values = cells.map((c) => c.text);
    if (!headerTaken && cells.every((c) => c.tag === "TH")) {
      headers = values;
      headerTaken = true;
    } else {
      rows.push(values);
    }
  }
  const hasText = headers.some(Boolean) || rows.some((r) => r.some(Boolean));
  if (!hasText) return null;
  let pairs = null;
  if (rows.length && rows.every((r) => r.length === 2)) {
    pairs = rows.map(([label, value]) => ({ label, value }));
  }
  return { headers, rows, pairs };
}

// Pure parity copy of CONTENT_JS's in-browser <dl> grouping (Task 7b) —
// same eval-boundary constraint as buildTableModel above. Takes the flat
// `$$("dt,dd", dl)` sequence as plain `{ tag: "DT"|"DD", text }` items —
// querySelectorAll already flattens through the HTML5
// "<dl><div><dt>…<dd>…</div></dl>" wrapper pattern the same as a flat
// <dl><dt>…<dd>…</dl>, so this doesn't need to know which shape produced
// the sequence. A <dt> followed by more than one <dd> before the next <dt>
// joins their text into one comma-separated value rather than keeping only
// the first or last; a stray <dd> with no preceding <dt> (malformed markup)
// is dropped rather than crashing or attaching to nothing.
export function buildDefinitionListPairs(items) {
  const pairs = [];
  let label = null;
  let values = [];
  const flush = () => {
    if (label && values.length) pairs.push({ label, value: values.join(", ") });
    values = [];
  };
  for (const it of items) {
    if (it.tag === "DT") {
      flush();
      label = it.text;
    } else if (label && it.text) {
      values.push(it.text);
    }
  }
  flush();
  return pairs.length ? { pairs } : null;
}

// Pure parity copy of CONTENT_JS's in-browser label/value span/div matcher
// (Task 7b; same eval-boundary constraint as the two above) — this is the
// actual anti-noise gate, so it's the piece most worth pinning with tests.
// Takes already-computed strings/counts, not an element: `ownText` is the
// candidate element's OWN direct text (child text nodes only, NOT
// descendant text — see CONTENT_JS's extractLabelValuePairs for how that's
// assembled from childNodes), `fullText` is the element's complete
// rendered text (all descendants), and `childCount`/`childText` describe
// its single element child, if it has exactly one (used only when the
// label has no inline value of its own — the WooCommerce
// `<span class="sku_wrapper">SKU: <span class="sku">BB-123</span></span>`
// shape). Returns `{ label, value }` or null. Deliberately narrow — see
// CONTENT_JS's extractLabelValuePairs doc comment for the full
// anti-noise rationale (why this exists, and why it's this narrow):
//   - short "Label:" prefix (2-30 chars, starts with a letter) as the
//     element's OWN text, ending in exactly one colon;
//   - a distinct, non-empty value follows — either inline after the colon,
//     or (when nothing follows the colon inline) in exactly one child
//     element;
//   - the element's FULL text must equal exactly "label: value" — nothing
//     else going on in that wrapper (rules out a card/component whose
//     leading text merely happens to contain a colon);
//   - the value is capped at 200 chars (rejects an accidental match against
//     a long run of body copy).
const LABEL_VALUE_RE = /^([A-Za-z][A-Za-z0-9 &'/-]{1,29}):\s*(.*)$/;
export function matchLabelValuePair(ownText, fullText, childCount, childText) {
  const m = LABEL_VALUE_RE.exec(ownText || "");
  if (!m) return null;
  const label = m[1].trim();
  let value = m[2].trim();
  if (!value) {
    if (childCount !== 1) return null;
    value = (childText || "").trim();
  }
  if (!value || value.length > 200) return null;
  if (fullText !== `${label}: ${value}` && fullText !== `${label}:${value}`) return null;
  return { label, value };
}

const ASSETS_JS = `
(() => {
  const imgs = Array.from(document.images).map(i => i.currentSrc || i.src).filter(Boolean);
  const stylesheets = Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(l => l.href);
  const scripts = Array.from(document.scripts).map(s => s.src).filter(Boolean);
  let fonts = [];
  try {
    fonts = Array.from(document.fonts).map(f => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }));
  } catch {}
  return {
    images: Array.from(new Set(imgs)),
    stylesheets,
    scripts,
    fonts,
  };
})();
`;

// Computed-style ground truth: walk visible elements and count distinct
// values per style role. designmd cites the result as the source of truth so
// it stops guessing hex codes from screenshot pixels.
//
// The frequency tables (fonts/textColors/.../spacing) rank by raw occurrence
// across every visible element, so a rare-but-defining token — the single
// H1's size, the brand-accent color used on a handful of CTAs — can lose to
// volume: 500 identical list items or product cards will always outrank a
// heading that appears once. `roles` (below, alongside the tables — the
// tables are kept as-is) ranks WITHIN a semantic role instead ("top
// background colors among button-like elements", not "among all elements"),
// so a token only ever competes against a denominator small enough that it
// can't be crowded out. Task 6 should treat `roles` as ground truth for "the"
// heading/link/button styles and the tables above as ground truth for "the
// dominant palette" — content.json's own small `computedStyles` sample
// (h1/h2/h3/a/button, first-match only) is a quick preview of this same idea;
// `roles` supersedes it (h1-h6, distinct style combos not just first-match,
// and an accent-guess fallback when no primary-button class matches).
const STYLES_JS = `
(() => {
  const maps = {
    fonts: new Map(), textColors: new Map(), bgColors: new Map(),
    borderColors: new Map(), fontSizes: new Map(), radii: new Map(),
    shadows: new Map(), spacing: new Map(),
  };
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  let count = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (count > 4000) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    count++;
    bump(maps.fonts, cs.fontFamily);
    bump(maps.textColors, cs.color);
    if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") bump(maps.bgColors, cs.backgroundColor);
    if (cs.borderTopWidth !== "0px") bump(maps.borderColors, cs.borderTopColor);
    bump(maps.fontSizes, cs.fontSize + "/" + cs.fontWeight);
    if (cs.borderRadius !== "0px") bump(maps.radii, cs.borderRadius);
    if (cs.boxShadow !== "none") bump(maps.shadows, cs.boxShadow);
    for (const k of ["marginTop", "marginBottom", "paddingTop", "paddingBottom"]) {
      if (cs[k] !== "0px") bump(maps.spacing, cs[k]);
    }
  }
  const top = (map, n) => [...map.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([value, uses]) => ({ value, uses }));

  // --- Role-based tokens (Fix 4) -----------------------------------------
  const roleStyle = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    return {
      tag: el.tagName.toLowerCase(),
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      letterSpacing: cs.letterSpacing,
      textDecorationLine: cs.textDecorationLine,
    };
  };

  // Distinct style combos observed among \`els\` (capped so a pathological
  // page can't blow up runtime), sorted most-used first. A role with
  // essentially one real element (h1, body) naturally comes back as a
  // single-entry list; a role with many (a, button) surfaces every distinct
  // look those elements take instead of just whichever one is first in the
  // DOM.
  const distinctByStyle = (els, limit) => {
    const seen = new Map();
    let n = 0;
    for (const el of els) {
      if (n++ > 3000) break;
      const s = roleStyle(el);
      if (!s) continue;
      const key = JSON.stringify(s);
      const existing = seen.get(key);
      if (existing) existing.uses++;
      else seen.set(key, { ...s, uses: 1 });
    }
    return [...seen.values()].sort((a, b) => b.uses - a.uses).slice(0, limit);
  };

  const headings = {};
  for (const lvl of [1, 2, 3, 4, 5, 6]) {
    headings["h" + lvl] = distinctByStyle(document.querySelectorAll("h" + lvl), 4);
  }

  const links = distinctByStyle(document.querySelectorAll("a"), 8);

  const buttonSelector =
    "button, [role=button], input[type=submit], input[type=button], " +
    "a.button, a.btn, [class*='btn'], [class*='button']";
  const buttons = distinctByStyle(document.querySelectorAll(buttonSelector), 10);

  // Normalize ANY valid CSS color string to sRGB 0-255 bytes via a 1x1
  // canvas — Canvas2D's fillStyle accepts everything getComputedStyle can
  // return (rgb(), hsl(), named colors, hex, and modern wide-gamut
  // lab()/oklab()/oklch()/color() notations), so this works regardless of
  // which one the page (and this Chrome version) happens to serialize in.
  // Needed live: on tailwindcss.com getComputedStyle returns colors as
  // "lab(...)"/"oklab(...)", not "rgb(...)" — a regex expecting "rgb(...)"
  // found zero matches among its buttons, silently returning no accent-guess
  // candidate at all on exactly the kind of modern site this block exists
  // for. Returns null for fully-transparent OR unparseable input — see the
  // sentinel check below for how "unparseable" is actually detected (Task
  // 4d, Finding 3): Canvas2D SILENTLY IGNORES an unparseable fillStyle
  // assignment (the property just keeps its previous value rather than
  // throwing, per spec), and this context is reused across calls, so
  // without that check an invalid colorStr would make this function return
  // the PREVIOUS call's color instead of null, contradicting this comment.
  let __satCanvas = null;
  const toRgbBytes = (colorStr) => {
    if (!colorStr) return null;
    try {
      if (!__satCanvas) {
        __satCanvas = document.createElement("canvas");
        __satCanvas.width = 1;
        __satCanvas.height = 1;
      }
      const ctx = __satCanvas.getContext("2d");
      // Force a known sentinel immediately before the real assignment, then
      // read fillStyle back after attempting it: if the getter still echoes
      // the sentinel, colorStr was rejected outright (a no-op assignment),
      // not merely resolved to some color that happens to look like the
      // sentinel. Parity copy of the Node-side \`fillStyleWasAccepted\`
      // (capture.mjs) — kept in sync by hand, same "can't import across the
      // eval boundary" constraint as accentScore/accentScoreOf below.
      const SENTINEL = "rgb(1, 2, 3)";
      ctx.fillStyle = SENTINEL;
      const sentinelEcho = ctx.fillStyle;
      ctx.fillStyle = colorStr;
      if (ctx.fillStyle === sentinelEcho) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? null : { r, g, b, a };
    } catch {
      return null;
    }
  };

  // "Accent score" (0..1) of an sRGB+alpha pixel — a pure parity copy of
  // capture.mjs's exported \`accentScore\` (kept in sync by hand; this string
  // runs inside the captured page via eval with zero dependencies, so it
  // can't literally import that). Used only to guess which button is the
  // brand-accent CTA when no class name gives it away: a colorful, opaque
  // fill among mostly neutral (gray/white/black) buttons is a good proxy for
  // "the primary action". Deliberately raw channel spread (chroma) scaled by
  // opacity, NOT full HSL saturation — verified live on tailwindcss.com: a
  // near-black button background with only a sub-pixel-scale color tint
  // (oklab lightness 0.13, canvas-normalizes to rgb(0,0,20)) scores HSL
  // saturation a full 1.0 (HSL saturation is numerically unstable at extreme
  // lightness), indistinguishable by that formula from the page's actual
  // vivid, fully-opaque CTA — and would have won the accent guess by
  // accident. Weighting by alpha additionally keeps a barely-visible
  // 5%-opacity tinted hover overlay from outranking a fully opaque,
  // moderately colorful real button background.
  const accentScoreOf = (rgb) => {
    if (!rgb) return 0;
    const chroma = (Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b)) / 255;
    return chroma * (rgb.a / 255);
  };
  // Below this, treat it as "no real accent found" rather than confidently
  // reporting a barely-tinted near-neutral button as the primary CTA.
  const MIN_ACCENT_SCORE = 0.15;

  const primarySelector =
    ".btn-primary, .button-primary, button.primary, .primary-button, .btn--primary, " +
    "[class*='btnPrimary'], [class*='ButtonPrimary'], [class*='cta-primary'], [class*='CtaPrimary'], .cta";
  const primaryClassStyle = roleStyle(document.querySelector(primarySelector));
  let primaryButton = primaryClassStyle ? { ...primaryClassStyle, source: "class-match" } : null;
  if (!primaryButton) {
    let best = null, bestScore = 0;
    for (const b of buttons) {
      const score = accentScoreOf(toRgbBytes(b.backgroundColor));
      if (score > bestScore) { bestScore = score; best = b; }
    }
    primaryButton = best && bestScore >= MIN_ACCENT_SCORE ? { ...best, source: "accent-guess" } : null;
  }

  const body = roleStyle(document.querySelector("body"));

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    fonts: top(maps.fonts, 6),
    textColors: top(maps.textColors, 12),
    bgColors: top(maps.bgColors, 12),
    borderColors: top(maps.borderColors, 8),
    fontSizes: top(maps.fontSizes, 16),
    radii: top(maps.radii, 8),
    shadows: top(maps.shadows, 6),
    spacing: top(maps.spacing, 16),
    roles: { headings, links, buttons, primaryButton, body },
  };
})();
`;

// Interactive-pattern inventory. Each detector maps a source-site behavior to
// a named Alpine recipe (see prompts/alpine-recipes.md). Animations are out of
// scope by design — recipes are instant-state. Exported (unlike the other
// `_JS` constants above) so a unit test can statically pin its recipe names
// against prompts/alpine-recipes.md's headings — the join key between the
// two files (see the consistency test in capture.test.mjs).
//
// Live-verified against wpdev.xcloudzen.com, stripe.com, and elementor.com
// (Task 5 report, then a fix pass — see task-5-report.md's "Fix pass"
// section) before landing three precision fixes on top of the base
// detectors:
//  - `add()` now drops native form controls (input/select/textarea) and
//    collapses nested matches to their outermost ancestor before recording
//    `count`/the sample element. Without this, a decorative child that
//    independently matches the same OR'd selector as its own already-matched
//    ancestor gets counted as a separate instance — proven live: Stripe's
//    hamburger button's 4 decorative SVG <rect> lines (classes like
//    `navigation-hamburger__line`) each matched `[class*=burger]` too,
//    inflating nav-toggle from 1 real button to 5; its homepage logo/
//    testimonial/events carousels' own slide/pagination children matched
//    `[class*=carousel]` right along with their container, inflating
//    carousel from 5 real containers to 157. Both collapse back to the true
//    count once only outermost matches are kept. The form-control exclusion
//    guards the same class of bug the task brief itself flagged as a risk
//    (an `<input type=range class="…slider…">` is a form control, never a
//    carousel) — not reproduced live on these 3 sites, but cheap and
//    unambiguously correct to guard against regardless.
//  - accordion also matches a bare `[aria-expanded]` outside <header>/<nav>
//    (where nav-toggle/dropdown-menu already own that signal) — the WAI-ARIA
//    disclosure pattern real accordions use, on ANY element, not just
//    <button>. Proven live: elementor.com's own FAQ widget (8 real, working
//    disclosure items) uses the class `dsm-faq` — no "accordion"/
//    "collapsible" substring anywhere — so the class-based selectors alone
//    missed it completely; its toggle element is a plain aria-expanded
//    `<div>`, not a <button>, which is why this checks the attribute
//    unqualified by tag.
//  - nav-toggle and dropdown-menu are now split by DESKTOP VISIBILITY, not
//    just by selector. The outermost-collapsed candidate set for the broad
//    header-disclosure selector (button[aria-expanded]/[aria-controls]/
//    hamburger-ish classes) still matches BOTH the real mobile hamburger AND
//    desktop mega-menu triggers on sites like stripe.com — proven live: all
//    5 (1 hamburger + 4 "Products"/"Solutions"/"Developers"/"Resources" mega-
//    menu buttons) previously landed as a single nav-toggle match, and the
//    recorded representative element was a mega-menu trigger, not the
//    hamburger — backwards for what Task 8 needs to build. UX_JS always runs
//    at a verified, un-emulated desktop viewport (captureOne places this
//    pass after restoreDesktopViewport — see that function and the call site
//    below), which is exactly the discriminator available: the mobile
//    hamburger is hidden at desktop (that hiddenness is what makes it
//    "mobile-only"), while a mega-menu trigger is visible and clickable at
//    desktop by definition. Partitioning the SAME candidate set by
//    `isRenderedAtViewport` — own computed display/visibility/opacity, PLUS
//    a bounding-rect check so a hidden ANCESTOR (which does not change this
//    element's own computed `display`) is caught too — turns "hidden at
//    desktop" into nav-toggle and "visible at desktop" into dropdown-menu,
//    alongside the pre-existing structural `nav li > ul`/`.sub-menu` selector
//    (a different markup shape for the same pattern, e.g. classic WordPress
//    menus) which still also feeds dropdown-menu unchanged. See
//    task-5-report.md's "Fix pass" section for the live stripe.com/wpdev/
//    elementor before/after proof.
export const UX_JS = `
(() => {
  const found = [];
  const FORM_CONTROL_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
  const add = (pattern, recipe, els) => {
    if (!els || els.length === 0) return;
    // Never count a native form control as a UI pattern instance (e.g. an
    // <input type=range> whose class happens to contain "slider").
    const eligible = els.filter((el) => !FORM_CONTROL_TAGS.has(el.tagName));
    // Collapse to outermost matches only: a decorative descendant (an SVG
    // icon part inside a hamburger button, a single slide inside a
    // carousel) can independently satisfy the same OR'd selector as its own
    // already-matched ancestor — count the component once, not component +
    // every matching descendant.
    const outer = eligible.filter((el) => !eligible.some((other) => other !== el && other.contains(el)));
    if (outer.length === 0) return;
    const el = outer[0];
    found.push({
      pattern, recipe,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: (typeof el.className === "string" ? el.className : "").trim().slice(0, 120) || null,
      count: outer.length,
    });
  };
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

  const header = document.querySelector("header, [role=banner]") || document.body;
  const CAROUSEL_SEL = ".slick-slider, .swiper, .splide, .owl-carousel, [class*=carousel], [data-flickity], [class*=slider]";
  // Regions another, more specific detector already owns — a bare
  // [aria-expanded] inside any of these is that detector's internal
  // bookkeeping, not a standalone accordion. Proven live on elementor.com:
  // Swiper marks its OWN current-slide state with aria-expanded
  // (class "swiper-slide step swiper-slide-active" inside a ".swiper"
  // carousel already caught by the carousel detector below) — without this
  // exclusion that reads as a second, false "accordion" match.
  const inChrome = (el) =>
    (header !== document.body && header.contains(el)) || !!el.closest("nav") || !!el.closest(CAROUSEL_SEL);

  // Rendered at THIS viewport right now: own computed display/visibility/
  // opacity, PLUS a bounding-rect check — a hidden ANCESTOR does not change
  // this element's own computed 'display' at all (per spec), so the rect
  // check (zero size whenever the element or an ancestor isn't laid out) is
  // load-bearing, not redundant. Threshold is near-zero (> 0) because this
  // classifies small buttons, not page sections.
  const isRenderedAtViewport = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // nav-toggle vs dropdown-menu: one candidate set, split by desktop
  // visibility (see the fix-list comment above this constant for the full
  // rationale and live proof).
  const headerDisclosureEls = $$(
    "button[aria-expanded], button[aria-controls], .hamburger, .menu-toggle, [class*=burger], [class*=menu-toggle]",
    header,
  );
  const hiddenAtDesktop = headerDisclosureEls.filter((el) => !isRenderedAtViewport(el));
  const visibleAtDesktop = headerDisclosureEls.filter((el) => isRenderedAtViewport(el));

  add("nav toggle (hamburger)", "nav-toggle", hiddenAtDesktop);

  const structuralDropdownEls = $$("nav li > ul, nav li > .sub-menu, nav [class*=dropdown]").map(
    (el) => el.parentElement || el,
  );
  add("dropdown menu", "dropdown-menu", [...visibleAtDesktop, ...structuralDropdownEls]);

  add("tabs", "tabs",
    $$("[role=tablist], .tabs, [class*=tab-list]"));

  add("accordion", "accordion",
    $$("details, [class*=accordion], [class*=collapsible], [aria-expanded]").filter(el => !inChrome(el)));

  add("carousel/slider", "carousel", $$(CAROUSEL_SEL));

  add("modal/dialog", "modal",
    $$("[role=dialog], dialog, .modal, [data-modal], [class*=lightbox]"));

  const hcs = header !== document.body ? getComputedStyle(header) : null;
  if (hcs && (hcs.position === "fixed" || hcs.position === "sticky")) {
    add("sticky header", "sticky-header", [header]);
  }

  return { patterns: found };
})();
`;

// Pure parity copy of UX_JS's in-browser `isRenderedAtViewport` decision —
// same "can't literally import into an eval'd string" constraint as
// accentScore/fillStyleWasAccepted below; this pins the BOOLEAN LOGIC (given
// already-observed display/visibility/opacity/rect values, what do they
// decide?), not the DOM observation itself (getComputedStyle/
// getBoundingClientRect need a real page — the live proof that this
// actually separates stripe.com's hamburger from its mega-menu triggers is
// in task-5-report.md's "Fix pass" section). Takes primitive values, not an
// element, so a test can hand it exactly the display/visibility/opacity/
// width/height combination it wants to check without a DOM.
export function isRenderedGivenComputedStyle(display, visibility, opacity, width, height) {
  if (display === "none" || visibility === "hidden" || parseFloat(opacity) === 0) return false;
  return width > 0 && height > 0;
}

// Pure: does `actualUrl` (the tab's real, current URL, read back through
// agent-browser's own `get url` — a channel independent of whatever last
// touched the tab) look like the SAME page as `expectedUrl` (the page this
// capture pass believes it is looking at)? Exists for Fix 2 (ux.json
// page-identity guard, captureOne's UX wiring below UX_JS's own eval call) —
// see that call site's doc comment for the exact failure mode this closes
// (restoreDesktopViewport's own doc comment already flags it: its
// last-resort fresh-tab self-heal opens "about:blank" and does not
// renavigate back to the page — nothing previously ran after it to notice).
//
// Deliberately HOSTNAME-ONLY (www.-normalized), not hostname+pathname: an
// earlier version of this function also required the pathname to match
// (slash-normalized) and was proven live, against stripe.com, to be too
// strict — stripe.com/ legitimately redirects to stripe.com/en-my (a
// locale subpath) as a normal, correct navigation, which a pathname
// comparison flags as a false "wrong page" mismatch and skips a perfectly
// good UX capture over. The ACTUAL failure this guards against
// (restoreDesktopViewport's fresh-tab self-heal) only ever lands on
// "about:blank", which has an EMPTY hostname — no real site's legitimate
// redirect chain produces an empty hostname — so hostname-only is both
// sufficient to catch the real bug and permissive enough to tolerate
// locale/language redirects, protocol upgrades, trailing slashes, query
// strings, and hash fragments, none of which indicate a wrong page.
// Anything unparseable as a URL, or with no hostname at all (including
// "about:blank" itself — a valid URL, but hostname ""), is treated as a
// mismatch: the conservative default when in doubt is "not the same page",
// never a false "yes".
export function looksLikeSamePage(actualUrl, expectedUrl) {
  if (!actualUrl || !expectedUrl) return false;
  let a, e;
  try {
    a = new URL(actualUrl);
    e = new URL(expectedUrl);
  } catch {
    return false;
  }
  if (!a.hostname || !e.hostname) return false;
  const normHost = (h) => h.toLowerCase().replace(/^www\./, "");
  return normHost(a.hostname) === normHost(e.hostname);
}

// Pure parity copy of STYLES_JS's in-browser \`accentScoreOf\` (chroma scaled
// by opacity, 0..1, of an sRGB+alpha pixel) — kept here only so the color
// math itself is unit-tested; STYLES_JS can't literally import it (it runs
// inside the captured page via eval, no dependencies). Keep the two in sync
// if you change one. Takes raw 0-255 bytes, not a CSS color string:
// STYLES_JS normalizes whatever notation getComputedStyle returns
// (rgb()/lab()/oklab()/etc.) to bytes via an in-browser canvas before
// calling its copy of this — that normalization step needs a DOM, so it
// isn't exercised here; this only pins the scoring formula itself.
//
// Deliberately NOT full HSL saturation: verified live on tailwindcss.com
// that HSL saturation is numerically unstable at extreme lightness — a
// near-black button background with only a sub-pixel-scale color tint
// (rgb(0, 0, 20)) scores a full 1.0, indistinguishable from a genuinely
// vivid button. Raw channel spread (chroma) doesn't have that blowup, and
// scaling by alpha keeps a barely-visible tinted overlay from outscoring a
// fully opaque, moderately colorful real background.
export function accentScore(r, g, b, a = 255) {
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  return chroma * (a / 255);
}

// Pure parity copy of STYLES_JS's in-browser toRgbBytes sentinel check (Task
// 4d, Finding 3) — kept here only so the DETECTION TECHNIQUE itself is
// unit-tested; STYLES_JS can't literally import it (same eval-boundary
// constraint as accentScore/accentScoreOf above), and Node has no Canvas to
// exercise the real thing directly. `ctx` only needs a settable/gettable
// `fillStyle`, so a test can pass a plain object that mimics Canvas2D's
// exact "silently ignore an unparseable value, keep the previous one"
// quirk — the real bug this exists to catch: reusing one context across
// calls means a rejected assignment would otherwise read back as whatever
// color a PREVIOUS, unrelated call left behind, not as "rejected".
export function fillStyleWasAccepted(ctx, colorStr, sentinel = "rgb(1, 2, 3)") {
  ctx.fillStyle = sentinel;
  const sentinelEcho = ctx.fillStyle;
  ctx.fillStyle = colorStr;
  return ctx.fillStyle !== sentinelEcho;
}

const DOM_JS = `document.documentElement.outerHTML`;

// Cheap page-size probe, run immediately before the full-page screenshot
// (Fix 1a/Fix 2) so captureOne can decide the clip height itself — instead
// of handing an unbounded "just capture the whole thing" request to
// agent-browser's own screenshot mechanism (see cdp.mjs's
// captureFullPageScreenshot doc comment for why that's the actual crash/
// void mechanism this replaces). Same scrollHeight formula SECTIONS_JS's
// own viewport.cssHeight already uses, kept consistent on purpose. Exported
// so verify.mjs's own full-page screenshot (Fix 2, prerelease review) can
// measure a page the exact same way, rather than re-deriving this formula.
export const PAGE_SIZE_JS = `
(() => ({
  width: document.documentElement.clientWidth,
  height: Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  ),
}))();
`;

// Scroll the full page in steps so IntersectionObservers + lazy-load libraries
// (lozad, lazysizes, native loading="lazy", elementor lazyloading, etc.) fire
// for every section. Then return to the top. CDP's captureBeyondViewport
// screenshot does NOT trigger these observers, so element-scoped screenshots
// of below-the-fold blocks come back blank unless we prime the page first.
const SCROLL_PASS_JS = `
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const total = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  );
  const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
  for (let y = 0; y < total; y += step) {
    window.scrollTo(0, y);
    await sleep(120);
  }
  window.scrollTo(0, total);
  await sleep(200);
  // Force any native lazy <img> still pending into eager so the bytes arrive
  // before we screenshot per-section.
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    img.loading = 'eager';
    if (img.dataset && img.dataset.src && !img.src) img.src = img.dataset.src;
    if (img.dataset && img.dataset.srcset && !img.srcset) img.srcset = img.dataset.srcset;
  });
  await sleep(300);
  window.scrollTo(0, 0);
  await sleep(200);
  return true;
})();
`;

// Tag visible page sections and return their document-absolute geometry so
// we can crop each section out of the full-page screenshot.
// Strategy:
//   - header  → <header>, role=banner, or the first <nav>'s container
//   - footer  → <footer> or role=contentinfo
//   - hero    → first sizeable top-level child under <main> (or <body>)
//   - section-N → remaining top-level children, in document order
// Returns { viewport: {...}, sections: [...] }. Each section includes
// {top,left,width,height} in CSS pixels relative to the document origin.
export const SECTIONS_JS = `
(() => {
  // Make sure measurements are taken from the document origin, not whatever
  // scroll position the prior commands left us at.
  window.scrollTo(0, 0);

  const MIN_HEIGHT_HERO = 200;
  const MIN_HEIGHT_SECTION = 80;
  const tagged = [];
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;

  const tag = (el, id, role) => {
    if (!el) return false;
    if (el.getAttribute('data-capture-id')) return false; // don't double-tag
    el.setAttribute('data-capture-id', id);
    const rect = el.getBoundingClientRect();
    const cls = (typeof el.className === 'string' ? el.className : '').trim().slice(0, 120);
    tagged.push({
      id,
      role,
      tag: el.tagName.toLowerCase(),
      className: cls || null,
      elementId: el.id || null,
      top: Math.round(rect.top + scrollY),
      left: Math.round(rect.left + scrollX),
      width: Math.round(rect.width),
      height: Math.round(Math.max(rect.height, el.scrollHeight)),
    });
    return true;
  };

  const isVisible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 100 && (r.height >= 40 || el.scrollHeight >= 40);
  };

  // Fix 4 (denylist): known third-party overlay/widget container patterns
  // that must never be tagged as a real page section — reproduced live on
  // humanmade.com's /work/ (HubSpot chat widget + cookie-consent banner
  // tagged as "sections" right alongside the real content, per
  // 2026-07-13-canai-replicate-transform-task8-followups.md). Checked
  // against BOTH id and each class token (these libraries are inconsistent
  // about which one they set), anchored PER TOKEN — never a raw substring-
  // anywhere search — so a real class that merely CONTAINS one of these
  // words (a recipe site's "chocolate-chip-cookies-section", a
  // "chat-with-us" contact block) is never excluded. Node-side pure parity
  // copy: isThirdPartyWidgetContainer (capture.mjs, exported) — same
  // "can't literally import into an eval'd string" constraint as
  // buildTableModel/etc. above; kept in sync by hand.
  const THIRD_PARTY_WIDGET_TOKEN_RES = [
    /^hs-web-interactives/i,
    /^hubspot-messages-iframe-container$/i,
    /-messages-iframe-container$/i,
    /^cookie-?consent-?banner$/i,
    /^cookie-?banner$/i,
    /^consent-?banner$/i,
    /^intercom-(lightweight-app|container)$/i,
    /^drift-frame-controller$/i,
    /^crisp-client$/i,
    /^tawk-min-container$/i,
    /^grecaptcha-badge$/i,
  ];
  const isThirdPartyWidget = (el) => {
    const tokens = [el.id, ...(typeof el.className === 'string' ? el.className.split(/\\s+/) : [])].filter(Boolean);
    return tokens.some(t => THIRD_PARTY_WIDGET_TOKEN_RES.some(re => re.test(t)));
  };

  // --- header
  const headerEl =
    document.querySelector('body > header') ||
    document.querySelector('header[role=banner]') ||
    document.querySelector('[role=banner]') ||
    document.querySelector('header') ||
    (document.querySelector('nav') && document.querySelector('nav').closest('header, .header, #header, [class*="header"]')) ||
    document.querySelector('nav');
  tag(headerEl, 'header', 'header');

  // --- footer
  const footerEl =
    document.querySelector('body > footer') ||
    document.querySelector('footer[role=contentinfo]') ||
    document.querySelector('[role=contentinfo]') ||
    document.querySelector('footer');
  tag(footerEl, 'footer', 'footer');

  // --- main content children
  let main = document.querySelector('main') || document.querySelector('[role=main]');
  if (!main) {
    // No <main> — use body, but skip header/footer when iterating.
    main = document.body;
  }

  const collectChildren = (parent) => Array.from(parent.children).filter(el => {
    if (el === headerEl || el === footerEl) return false;
    if (headerEl && headerEl.contains(el)) return false;
    if (footerEl && footerEl.contains(el)) return false;
    const t = el.tagName;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE') return false;
    if (isThirdPartyWidget(el)) return false;
    return isVisible(el);
  });

  let kids = collectChildren(main);

  // If everything is wrapped in a single container (common in WP themes:
  // body > #wrapper > .content-wrap > .site-content > #primary > main…),
  // keep drilling through single-child chains until we find a level with
  // multiple visible siblings. Cap depth to avoid descending into a single
  // section's internal structure.
  let depth = 0;
  while (kids.length === 1 && depth < 8) {
    const child = kids[0];
    if (!child.children || child.children.length === 0) break;
    const drilled = collectChildren(child);
    if (drilled.length === 0) break;
    kids = drilled;
    depth += 1;
    if (drilled.length > 1) break;
  }

  // Fix 4 (drill into an oversized hero candidate): the FIRST sizeable kid
  // is about to become 'hero' below — if its own box is already too big to
  // ever actually be screenshotted (exceedsClipLimits — the SAME limits
  // captureNodeScreenshot itself enforces; MAX_CLIP_WIDTH_PX/
  // MAX_CLIP_HEIGHT_PX/MAX_CLIP_AREA_PX2 are interpolated from cdp.mjs at
  // build time below, so this can never drift out of sync with the real
  // guard), drilling into ITS children is more useful than tagging a region
  // we already know will be rejected wholesale — reproduced live on
  // humanmade.com's /work/, where the page's real content sat entirely
  // inside one oversized wrapper the old code tagged whole as 'hero'
  // (rejected wholesale by the clip guard later, instead of finding the
  // real sections inside it). Bounded to a handful of passes (unlike the
  // depth-8 single-child drill above, this only ever replaces the specific
  // oversized candidate with its own children — every OTHER kid in the
  // array is untouched) and re-checked each pass in case the drilled-into
  // children are STILL one oversized wrapper. Node-side pure parity copy:
  // exceedsClipLimits (capture.mjs, exported).
  const exceedsClipLimits = (w, h) =>
    w > ${MAX_CLIP_WIDTH_PX} || h > ${MAX_CLIP_HEIGHT_PX} || (w * h) > ${MAX_CLIP_AREA_PX2};
  let heroDrillDepth = 0;
  while (kids.length > 0 && heroDrillDepth < 4) {
    const first = kids[0];
    const r = first.getBoundingClientRect();
    const h = Math.max(r.height, first.scrollHeight);
    if (!exceedsClipLimits(r.width, h)) break;
    if (!first.children || first.children.length === 0) break;
    const drilledChildren = collectChildren(first);
    if (drilledChildren.length === 0) break;
    kids = [...drilledChildren, ...kids.slice(1)];
    heroDrillDepth += 1;
  }

  // First sizeable kid → hero. Skip skinny breadcrumb/announcement bars.
  // Decision logic here is a hand-kept-in-sync copy of the exported pure
  // planSectionAssignment (capture.mjs) — see that function's doc comment
  // for the "can't import across the eval boundary" rationale shared by
  // every other _JS constant in this file.
  let heroAssigned = false;
  let sectionIdx = 0;
  for (const el of kids) {
    const r = el.getBoundingClientRect();
    const h = Math.max(r.height, el.scrollHeight);
    if (!heroAssigned && h >= MIN_HEIGHT_HERO) {
      tag(el, 'hero', 'hero');
      heroAssigned = true;
      continue;
    }
    if (h >= MIN_HEIGHT_SECTION) {
      sectionIdx += 1;
      tag(el, 'section-' + sectionIdx, 'section');
    }
  }

  // Fix 3 (last-resort fallback): a theme with no <header>/<footer>/<main>
  // landmarks at all — reproduced live on wpdev.xcloudzen.com's WooCommerce
  // /shop/ (hello-elementor theme; header/footer/main all resolve to null,
  // per 2026-07-13-canai-replicate-capture-followups.md) — can walk away
  // from the loop above having tagged NOTHING: kids came back empty (or
  // every candidate was too small to clear MIN_HEIGHT_HERO/
  // MIN_HEIGHT_SECTION), leaving content.json.main === [] with no signal
  // anywhere that anything went wrong. Tag document.body itself as a single
  // section-1 ONLY when heroAssigned is still false AND not one section got
  // tagged either, so this can never fire on (or duplicate tagging for) a
  // normal page that already found real sections — a true last resort, not
  // a second pass that could ever compete with real tagging.
  if (!heroAssigned && sectionIdx === 0) {
    tag(document.body, 'section-1', 'section');
  }

  return {
    viewport: {
      cssWidth: document.documentElement.clientWidth,
      cssHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      dpr: window.devicePixelRatio || 1,
    },
    sections: tagged,
  };
})();
`;

// Fix 4 denylist — pure parity copy of SECTIONS_JS's in-browser
// isThirdPartyWidget check (same eval-boundary constraint as
// buildTableModel/etc. above). See SECTIONS_JS's own comment for the full
// anti-noise rationale and the live humanmade.com evidence. Checks id AND
// every class token, anchored per-token — never a raw substring-anywhere
// search — so real content that merely mentions "cookie"/"chat"/etc. in a
// class name is never excluded.
const THIRD_PARTY_WIDGET_TOKEN_PATTERNS = [
  /^hs-web-interactives/i,
  /^hubspot-messages-iframe-container$/i,
  /-messages-iframe-container$/i,
  /^cookie-?consent-?banner$/i,
  /^cookie-?banner$/i,
  /^consent-?banner$/i,
  /^intercom-(lightweight-app|container)$/i,
  /^drift-frame-controller$/i,
  /^crisp-client$/i,
  /^tawk-min-container$/i,
  /^grecaptcha-badge$/i,
];
export function isThirdPartyWidgetContainer(elementId, className) {
  const tokens = [
    ...(elementId ? [String(elementId)] : []),
    ...String(className || "").split(/\s+/).filter(Boolean),
  ];
  return tokens.some((token) => THIRD_PARTY_WIDGET_TOKEN_PATTERNS.some((re) => re.test(token)));
}

// Fix 4 (second half) — pure parity copy of SECTIONS_JS's in-browser
// exceedsClipLimits check. Reuses cdp.mjs's own MAX_CLIP_* limits (the SAME
// values interpolated directly into SECTIONS_JS's template string at build
// time — see this file's import of them — so the two can never drift the
// way a hand-copied numeric literal could): "too big to ever actually
// screenshot" means exactly the same thing here as it does when
// captureNodeScreenshot itself later refuses the clip.
export function exceedsClipLimits(width, height) {
  return width > MAX_CLIP_WIDTH_PX || height > MAX_CLIP_HEIGHT_PX || width * height > MAX_CLIP_AREA_PX2;
}

// Fix 3 — pure parity copy of SECTIONS_JS's in-browser hero/section
// assignment decision (given each candidate's already-resolved height —
// max(rect.height, scrollHeight), which needs a real page to measure).
// Returns which index (if any) becomes 'hero', which become 'section-N',
// and whether NOTHING was tagged at all (needsBodyFallback) — pinning this
// as pure data-in/data-out is what makes the last-resort body-fallback's
// "must not fire on normal pages" guarantee testable without a browser.
export function planSectionAssignment(kidHeights, { minHeightHero = 200, minHeightSection = 80 } = {}) {
  let heroIndex = null;
  const sectionIndexes = [];
  for (let i = 0; i < kidHeights.length; i++) {
    const h = kidHeights[i];
    if (heroIndex === null && h >= minHeightHero) {
      heroIndex = i;
      continue;
    }
    if (h >= minHeightSection) sectionIndexes.push(i);
  }
  return {
    heroIndex,
    sectionIndexes,
    needsBodyFallback: heroIndex === null && sectionIndexes.length === 0,
  };
}

// Force scroll-reveal animations into their "shown" state before screenshot/DOM
// capture. Many sites (AOS, WOW, GSAP ScrollTrigger, custom IntersectionObserver)
// start elements at opacity:0 and only reveal them on scroll. A full-page
// screenshot doesn't reliably fire those observers, so we:
//   1. inject a stylesheet that disables transitions/animations and forces
//      common reveal classes to visible,
//   2. clear inline opacity/transform/visibility the libraries set on elements,
//   3. mark library-specific "animated" classes (aos-animate, wow→visible).
const REVEAL_JS = `
(() => {
  const css = \`
    *, *::before, *::after {
      transition: none !important;
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      animation-fill-mode: forwards !important;
    }
    [data-aos], .aos-init, .wow, .reveal, .revealed, .fade-in, .fade-up,
    .fade-down, .fade-left, .fade-right, .animate-on-scroll, .scroll-animate,
    .sr-only-reveal, [class*="fade-"], [class*="slide-"], [class*="zoom-"],
    [class*="reveal-"], [data-scroll], [data-animate] {
      opacity: 1 !important;
      transform: none !important;
      visibility: visible !important;
      filter: none !important;
    }
  \`;
  const style = document.createElement('style');
  style.setAttribute('data-reveal-override', '1');
  style.textContent = css;
  document.head.appendChild(style);

  // Mark AOS / WOW elements as already-animated so their own classes apply
  // the "shown" state.
  document.querySelectorAll('[data-aos]').forEach(el => el.classList.add('aos-animate'));
  document.querySelectorAll('.wow').forEach(el => {
    el.classList.add('animated', 'visible');
    el.style.visibility = 'visible';
  });

  // Strip inline hidden styles that JS observers commonly set.
  document.querySelectorAll('[style]').forEach(el => {
    const s = el.style;
    if (s.opacity && parseFloat(s.opacity) < 1) s.opacity = '';
    if (s.transform && s.transform !== 'none') s.transform = '';
    if (s.visibility === 'hidden') s.visibility = '';
  });

  return true;
})();
`;

// Exported (Fix 2, verify.mjs) so callers that measure a page's own size the
// same way capture.mjs does (PAGE_SIZE_JS) can parse the eval result the
// same way too, instead of re-deriving this.
export function parseEvalJson(stdout) {
  // agent-browser eval prints the value. Try to parse JSON; fall back to string.
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function ensureWorkingTab(flags) {
  // agent-browser's `open` reuses the active tab. If the active tab is a
  // restricted webview (Chrome's Gemini Glic sidebar, chrome://, devtools,
  // etc.) it will reject http(s) navigations with ERR_BLOCKED_BY_CLIENT.
  // Force a regular working tab when needed.
  let activeUrl = "";
  try {
    activeUrl = (await ab([...flags, "get", "url"])).stdout.trim();
  } catch {}
  const isRegular = /^https?:/.test(activeUrl) && !/gemini\.google\.com\/glic/.test(activeUrl);
  if (!isRegular) {
    await ab([...flags, "tab", "new", "about:blank"]);
  }
}

// Pure: has the viewport actually come back to the expected desktop size?
// A couple of px of slack absorbs any rounding some Chrome builds introduce
// between an exact deviceMetricsOverride width and what window.innerWidth
// reports back — it must NOT be loose enough to let a 375 mobile leftover
// pass as "close enough" to a real desktop width (every desktop width this
// codebase deals with is comfortably >600px, so a 2px tolerance can never
// blur that line).
export function viewportRestored(measuredWidth, expectedWidth, tolerancePx = 2) {
  return (
    Number.isFinite(measuredWidth) &&
    Number.isFinite(expectedWidth) &&
    Math.abs(measuredWidth - expectedWidth) <= tolerancePx
  );
}

// The exact width/height captureOne emulates for the mobile STYLES_JS pass
// below. Named so Finding 1's start-of-page contamination check
// (looksMobileEmulated) can compare against the SAME values the mobile pass
// itself sets — the two must never drift apart, or the check stops meaning
// what its name says.
const MOBILE_VIEWPORT_WIDTH = 375;
const MOBILE_VIEWPORT_HEIGHT = 812;

// Pure: does (width, height) match this file's OWN known mobile-emulation
// constants — independent of anything any page has measured. This is what
// makes the start-of-page guarantee (ensureUnemulatedViewport, Task 4d
// Finding 1) non-circular: `restoreDesktopViewport`'s own check
// (viewportRestored, above) compares a measurement against `desktopWidth`,
// which is derived from THIS page's own desktop STYLES_JS pass — if the tab
// was already contaminated before that pass ran, `desktopWidth` itself
// measures ~375, and a later restore-to-375 verifies "restored" against a
// baseline that was corrupted from the start (a contaminated tab
// self-certifying as clean). `looksMobileEmulated` instead compares against
// a fixed module constant that has no dependency on any per-page
// measurement, so a contaminated tab can't pass this check just because its
// own "desktop" reading also happens to be 375 — the constant never moves.
//
// Both width AND height must match (within tolerance): device-metrics
// overrides always set both dimensions together, so requiring both all but
// eliminates the already-remote chance of a real, non-emulated window
// organically sitting at exactly 375x812.
export function looksMobileEmulated(width, height, tolerancePx = 2) {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    Math.abs(width - MOBILE_VIEWPORT_WIDTH) <= tolerancePx &&
    Math.abs(height - MOBILE_VIEWPORT_HEIGHT) <= tolerancePx
  );
}

// Read window.innerWidth back through agent-browser's own `eval` — a channel
// independent of whatever CDP call last touched the viewport, so this is a
// real verification, not just trusting that call's own resolve/reject.
async function measureInnerWidth(flags) {
  try {
    const res = await ab([...flags, "eval", "--stdin"], { input: "window.innerWidth" });
    const n = Number(parseEvalJson(res.stdout));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Same idea as measureInnerWidth, but both dimensions in one round trip —
// looksMobileEmulated needs height too (width alone reopens a sliver of the
// "could a real desktop window coincidentally match" risk that checking
// both closes).
const VIEWPORT_SIZE_JS = "(() => ({ width: window.innerWidth, height: window.innerHeight }))();";

async function measureViewportSize(flags) {
  try {
    const res = await ab([...flags, "eval", "--stdin"], { input: VIEWPORT_SIZE_JS });
    const parsed = parseEvalJson(res.stdout);
    const width = Number(parsed && parsed.width);
    const height = Number(parsed && parsed.height);
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

// Guarantee the tab about to be used is NOT already mobile-emulated BEFORE
// captureOne does anything else with it — this is what makes a contaminated
// tab impossible to inherit (Task 4d, Finding 1). Runs right after
// ensureWorkingTab and before this page's own `ab open url`, so the one
// `open` call already in captureOne is the only navigation needed whether or
// not healing happened here.
//
// Why this can't self-certify the way restoreDesktopViewport's tail-end
// check can: there IS no "real desktop width" available yet at this point
// (this page hasn't taken its desktop STYLES_JS pass), and even if there
// were, deriving the check's baseline from this page's own measurement is
// exactly the self-certification hole this closes — a contaminated tab's
// "desktop" reading is itself wrong, so comparing it to itself always
// passes. looksMobileEmulated instead compares against this file's fixed
// 375x812 constants, a value with no dependency on any per-page
// measurement, so it can't be fooled the same way. restoreDesktopViewport's
// own end-of-page verification is left exactly as-is (still real defense in
// depth for the page that just ran); this function is what makes the
// NEXT page's starting condition a guarantee rather than a hope, regardless
// of how the previous page's own restore/self-heal went.
//
// Healing mechanism: Emulation.clearDeviceMetricsOverride was re-tested
// live for this fix, specifically against the correctly-resolved CDP
// endpoint (the endpoint-mismatch bug Task 4b fixed) — 3 full
// set(375,812)→clear→read-back cycles against the real "personal" session,
// window.innerWidth read back through agent-browser's own eval every time.
// It stayed at 375 all three times: clearing the override does not restore
// a usable size in this workspace's headless/virtual-display Chrome,
// endpoint-mismatch bug or not. So this uses the mechanism already proven
// reliable elsewhere in this file (restoreDesktopViewport's own self-heal):
// open a brand new tab, which has no device-metrics override at all because
// overrides don't carry over to a new CDP target. Verified live: a fresh
// about:blank tab measures the browser's real, un-emulated size even while
// an OLDER tab in the very same browser is still pinned at 375x812 —
// confirming the override is scoped per-target, not global, so a fresh tab
// is a legitimate, verified escape from it.
async function ensureUnemulatedViewport({ flags, slug }) {
  const size = await measureViewportSize(flags);
  if (!looksMobileEmulated(size.width, size.height)) return;

  process.stderr.write(
    `  ! tab for ${slug} started mobile-emulated (${size.width}x${size.height}) — likely inherited ` +
      `contamination from an earlier page; self-healing with a fresh tab\n`,
  );
  try {
    await ab([...flags, "tab", "new", "about:blank"]);
  } catch (e) {
    const err = new Error(
      `tab for ${slug} started mobile-emulated (${size.width}x${size.height}) and the fresh-tab self-heal ` +
        `itself failed: ${e.message} — refusing to proceed and risk silently capturing this page (and every ` +
        `later one) at the wrong width`,
    );
    err.viewportContamination = true;
    throw err;
  }

  const healed = await measureViewportSize(flags);
  if (looksMobileEmulated(healed.width, healed.height)) {
    const err = new Error(
      `tab for ${slug} is STILL mobile-emulated (${healed.width}x${healed.height}) even after a fresh-tab ` +
        `self-heal — refusing to proceed and risk silently capturing this page (and every later one) at the ` +
        `wrong width`,
    );
    err.viewportContamination = true;
    throw err;
  }
  process.stderr.write(
    `  ↻ viewport un-emulated via a fresh tab for ${slug} (now ${healed.width}x${healed.height})\n`,
  );
}

// Restore the desktop viewport after the mobile STYLES_JS pass, and PROVE it
// worked before returning. `Emulation.setDeviceMetricsOverride` is scoped to
// the CDP target (tab) and persists across navigations, and `capture()`
// reuses one tab for the whole worklist (see `ensureWorkingTab` — it only
// opens a fresh tab when the current one isn't a normal http(s) page, which
// is false right after a successful capture). A restore that fails silently
// would therefore leave every later page in the run captured at mobile
// width with `ok: true` reported — the exact silent-corruption class Task 4b
// eliminated for the CDP-endpoint bug, reintroduced here if this were
// allowed to fail quietly. So:
//   1. Set the desktop size, then read window.innerWidth back (see
//      measureInnerWidth) instead of trusting the CDP call's own success.
//   2. If it didn't take, self-heal: a fresh tab has no emulation override
//      at all (overrides don't carry over to a new CDP target), so opening
//      one and re-measuring is a legitimate, verified recovery.
//   3. If it STILL isn't right, throw a marked (`.viewportContamination`)
//      error. A run that can't guarantee its own viewport is broken in a way
//      retrying the same tab can't fix, and continuing would silently write
//      wrong-width captures for every remaining page — the caller
//      (captureOne's outer try/catch) must let this one specific error
//      through instead of swallowing it like other best-effort style-capture
//      failures.
// By the time this returns without throwing, the tab is verified to be at
// `desktopWidth`. That said, the actual guarantee that the NEXT page in the
// worklist starts from a known-good viewport no longer rests on this
// function alone (Task 4d, Finding 1): if BOTH the restore and the
// fresh-tab self-heal below fail, this throws and capture()'s per-entry
// catch just moves on, leaving the tab in whatever state it was last in —
// this function has no way to act again once it has thrown. The real,
// non-circular guarantee for the next page now lives at the START of
// captureOne (see ensureUnemulatedViewport), which checks the tab against
// this file's fixed mobile-emulation constants instead of a per-page
// baseline. This function's own verify/self-heal/throw sequence is kept
// unchanged — it is still real defense in depth for the page that just ran,
// catching the failure as early and specifically as possible — it's simply
// no longer the ONLY thing standing between a failed restore and the next
// page silently inheriting it.
async function restoreDesktopViewport({ flags, cdp, session, url, desktopWidth, desktopHeight, slug }) {
  try {
    const { host: cdpHost, port: cdpPort } = resolveSessionCdpEndpoint({ cdp, session });
    await setViewport({ host: cdpHost, port: cdpPort, url, width: desktopWidth, height: desktopHeight });
  } catch (e) {
    process.stderr.write(`  ! viewport restore call failed for ${slug}: ${e.message}\n`);
  }

  let measured = await measureInnerWidth(flags);
  if (viewportRestored(measured, desktopWidth)) return;

  process.stderr.write(
    `  ! viewport restore did NOT take for ${slug}: measured ${measured}px, expected ${desktopWidth}px — ` +
      `self-healing with a fresh tab\n`,
  );
  try {
    await ab([...flags, "tab", "new", "about:blank"]);
  } catch (e) {
    const err = new Error(
      `viewport restore failed for ${slug} (measured ${measured}px, expected ${desktopWidth}px) and the ` +
        `fresh-tab self-heal itself failed: ${e.message} — aborting rather than risk silently capturing ` +
        `the rest of the run at the wrong width`,
    );
    err.viewportContamination = true;
    throw err;
  }

  measured = await measureInnerWidth(flags);
  if (viewportRestored(measured, desktopWidth)) {
    process.stderr.write(`  ↻ viewport self-healed via a fresh tab for ${slug} (now ${measured}px)\n`);
    return;
  }

  const err = new Error(
    `viewport restore failed for ${slug} even after a fresh-tab self-heal (measured ${measured}px, expected ` +
      `${desktopWidth}px) — aborting rather than risk silently capturing the rest of the run at the wrong width`,
  );
  err.viewportContamination = true;
  throw err;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function sectionFileName(idx, role, id) {
  // 01-header.png, 02-hero.png, 03-section-1.png, ..., 99-footer.png
  if (role === "footer") return `99-footer.png`;
  return `${pad2(idx)}-${id}.png`;
}

// A section that fails to capture on THIS run must not leave a PREVIOUS
// run's PNG sitting at the same filename (Task 4d, Finding 4) —
// sections.json is fully rewritten every run and correctly records
// {file: null, error} for a failed section, but a stale numbered file left
// over from an earlier, healthier run is silently indistinguishable from a
// fresh one to anything that reads the directory itself (Task 8's transform
// does). Wiping the directory before repopulating it guarantees every file
// present when the caller is done belongs to this run — exactly the
// `--only <path>` recovery-run scenario this matters for. Extracted to its
// own function (rather than inlined in captureOne) purely so this
// filesystem-only step is unit-testable without a live browser.
export async function resetSectionsDir(sectionsDir) {
  await rm(sectionsDir, { recursive: true, force: true });
  await mkdir(sectionsDir, { recursive: true });
}

async function captureOne({ url, slug, runDir, cdp, session }) {
  const captureDir = path.join(runDir, "captures", slug);
  const sectionsDir = path.join(captureDir, "sections");
  await resetSectionsDir(sectionsDir);
  const flags = ["--cdp", String(cdp), "--session", session];

  const screenshotPath = path.resolve(captureDir, "screenshot.png");
  const domPath = path.join(captureDir, "dom.html");
  const contentPath = path.join(captureDir, "content.json");
  const assetsPath = path.join(captureDir, "assets.json");
  const sectionsJsonPath = path.join(captureDir, "sections.json");
  const stylesPath = path.join(captureDir, "styles.json");
  const uxPath = path.join(captureDir, "ux.json");

  await ensureWorkingTab(flags);
  // Guarantee this tab is not already mobile-emulated before navigating —
  // see ensureUnemulatedViewport's doc comment (Task 4d, Finding 1). Must
  // run before `open` so healing (a fresh tab) only ever needs the one
  // `open` call immediately below, whether or not it fired.
  await ensureUnemulatedViewport({ flags, slug });
  await ab([...flags, "open", url]);
  // Best-effort wait. Some sites never go fully idle; cap with timeout via try/catch.
  // Fix 1a: every catch below now logs — previously these five were the
  // ONLY best-effort blocks in this whole function that swallowed a failure
  // with zero trace anywhere, which made a mid-page browser death (see
  // isBrowserDeathError) impossible to pin to a specific step: it could
  // silently propagate through wait/reveal/scroll/wait(800) and only ever
  // surface later, at whichever call happened to not be wrapped.
  try {
    await ab([...flags, "wait", "--load", "networkidle"]);
  } catch (e) {
    process.stderr.write(`  ! networkidle wait failed for ${slug}: ${e.message}\n`);
  }
  // Tiny settle so late-firing scripts (carousels, hero animations) settle.
  try {
    await ab([...flags, "wait", "1500"]);
  } catch (e) {
    process.stderr.write(`  ! settle wait failed for ${slug}: ${e.message}\n`);
  }

  // Force scroll-reveal elements into their visible state before snapshotting.
  try {
    await ab([...flags, "eval", "--stdin"], { input: REVEAL_JS });
  } catch (e) {
    process.stderr.write(`  ! reveal pass failed for ${slug}: ${e.message}\n`);
  }

  // Scroll through the page to fire lazy-load observers. Without this, below-
  // the-fold per-section screenshots come back blank.
  try {
    await ab([...flags, "eval", "--stdin"], { input: SCROLL_PASS_JS });
  } catch (e) {
    process.stderr.write(`  ! scroll pass failed for ${slug}: ${e.message}\n`);
  }
  // Let any newly-requested images settle before we start shooting.
  try {
    await ab([...flags, "wait", "800"]);
  } catch (e) {
    process.stderr.write(`  ! post-scroll settle wait failed for ${slug}: ${e.message}\n`);
  }

  // Full-page screenshot (Fix 1a/Fix 2): measure the page ourselves and take
  // it via cdp.mjs's own bounded, size-capped captureFullPageScreenshot
  // instead of agent-browser's opaque `screenshot --full` — see that
  // function's doc comment (cdp.mjs) for the live crash/void evidence this
  // replaces. Best-effort, UNLIKE the call it replaces (which threw
  // straight out of captureOne on any failure, failing this page's ENTIRE
  // capture over one image): a page whose full-page shot can't be gotten at
  // all still has independently useful sections/content/styles/ux data
  // below — matching how every OTHER best-effort block in this function
  // already treats a single failed capability as non-fatal to the whole
  // page. Always recorded (never silently missing) via sections.json's
  // `screenshot` field, capped or not, so a downstream reader can tell "no
  // full-page shot for this page" from "here's one, and here's whether it
  // was capped".
  let screenshotMeta;
  try {
    const sizeRes = await ab([...flags, "eval", "--stdin"], { input: PAGE_SIZE_JS });
    const size = parseEvalJson(sizeRes.stdout);
    const pageWidth = Number(size && size.width);
    const pageHeight = Number(size && size.height);
    if (!(pageWidth > 0) || !(pageHeight > 0)) {
      throw new Error(`could not measure page size (got ${JSON.stringify(size)})`);
    }
    const { host: cdpHost, port: cdpPort } = resolveSessionCdpEndpoint({ cdp, session });
    const shot = await captureFullPageScreenshot({
      host: cdpHost,
      port: cdpPort,
      url,
      width: pageWidth,
      height: pageHeight,
      outPath: screenshotPath,
    });
    screenshotMeta = { ...shot, error: null };
    if (shot.capped) {
      process.stderr.write(
        `  ! full-page screenshot capped at ${shot.height}px for ${slug} (page is actually ` +
          `${shot.requestedHeight}px tall) — see sections.json's "screenshot" field\n`,
      );
    }
  } catch (e) {
    screenshotMeta = { width: null, height: null, requestedHeight: null, capped: false, error: e.message };
    process.stderr.write(`  ✗ full-page screenshot failed for ${slug}: ${e.message}\n`);
  }

  // Per-section screenshots: tag visible blocks, then ask the renderer for a
  // node-clipped screenshot via CDP `Page.captureScreenshot { clip,
  // captureBeyondViewport: true }`. This is what DevTools' "Capture node
  // screenshot" does — reliable for elements at any scroll position and
  // immune to the layout/scroll drift the crop-from-fullpage path suffered.
  const sections = [];
  try {
    const tagRes = await ab([...flags, "eval", "--stdin"], { input: SECTIONS_JS });
    const tagged = parseEvalJson(tagRes.stdout);
    const list = (tagged && tagged.sections) || [];
    let idx = 0;
    for (const s of list) {
      if (s.role !== "footer") idx += 1;
      const file = sectionFileName(idx, s.role, s.id);
      const outPath = path.resolve(sectionsDir, file);
      try {
        // Resolve the browser agent-browser's `session` is actually driving
        // — NOT necessarily 127.0.0.1:{cdp} (see agentBrowser.mjs). Memoized,
        // so this is a real shell-out at most once per run, a cache hit for
        // every other section/page after that.
        const { host: cdpHost, port: cdpPort } = resolveSessionCdpEndpoint({ cdp, session });
        await captureNodeScreenshot({
          host: cdpHost,
          port: cdpPort,
          url,
          clip: { x: s.left, y: s.top, width: s.width, height: s.height },
          outPath,
        });
        sections.push({ ...s, file: path.join("sections", file) });
      } catch (e) {
        // Previously recorded in sections.json and nothing else — a
        // "successful" capture (ok: true) could have every section silently
        // missing, discoverable only by opening sections.json. Print it as
        // it happens, matching the ✗ style used for hard failures elsewhere.
        sections.push({ ...s, file: null, error: e.message });
        process.stderr.write(`  ✗ section ${s.id} (${s.role}) failed for ${slug}: ${e.message}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`  ! section capture failed for ${slug}: ${e.message}\n`);
  }
  if (sections.length > 0) {
    const failed = sections.filter((s) => !s.file).length;
    if (failed > 0) {
      const allFailed = failed === sections.length;
      const flag = allFailed ? "ALL" : failed / sections.length >= 0.5 ? "MOST" : `${failed}/${sections.length}`;
      process.stderr.write(
        `  ! ${flag} sections failed to capture for ${slug} (${failed}/${sections.length}) — ` +
          `see sections.json for per-section errors\n`,
      );
    }
  }
  await writeFile(sectionsJsonPath, JSON.stringify({ sections, screenshot: screenshotMeta }, null, 2));

  const dom = await ab([...flags, "eval", "--stdin"], { input: DOM_JS });
  await writeFile(domPath, parseEvalJson(dom.stdout));

  const content = await ab([...flags, "eval", "--stdin"], { input: CONTENT_JS });
  await writeFile(contentPath, JSON.stringify(parseEvalJson(content.stdout), null, 2));

  const assets = await ab([...flags, "eval", "--stdin"], { input: ASSETS_JS });
  await writeFile(assetsPath, JSON.stringify(parseEvalJson(assets.stdout), null, 2));

  // styles.json — desktop pass at the real viewport, mobile pass at 375×812.
  // Best-effort: a failed mobile pass leaves mobile: null rather than failing
  // the whole capture.
  try {
    const desktop = parseEvalJson(
      (await ab([...flags, "eval", "--stdin"], { input: STYLES_JS })).stdout,
    );
    let mobile = null;
    // The real viewport to restore to afterward. Read from the desktop pass
    // itself (not hard-coded) so restore is correct regardless of the
    // window's actual size.
    const desktopWidth = Number(desktop && desktop.viewport && desktop.viewport.width);
    const desktopHeight = Number(desktop && desktop.viewport && desktop.viewport.height);
    const canRestore = Number.isFinite(desktopWidth) && desktopWidth > 0 &&
      Number.isFinite(desktopHeight) && desktopHeight > 0;
    if (!canRestore) {
      process.stderr.write(
        `  ! mobile style pass skipped for ${slug}: desktop viewport size unknown, can't guarantee restore\n`,
      );
    } else {
      try {
        // Raw CDP device-metrics override on the browser agent-browser's
        // `session` is actually driving (resolved below — NOT necessarily
        // 127.0.0.1:{cdp}; see agentBrowser.mjs). Earlier this call landed
        // on an unrelated, never-navigated tab whenever the session's
        // browser and the --cdp port didn't match, so it had no effect on
        // what `eval` below measures; a workaround called agent-browser's
        // own `set viewport` instead. With the endpoint resolved correctly,
        // this CDP call reaches the real page — verified live: reading
        // window.innerWidth back through agent-browser's own `eval`
        // afterward returns 375, so agent-browser's `set viewport` is
        // redundant. One mechanism only.
        const { host: cdpHost, port: cdpPort } = resolveSessionCdpEndpoint({ cdp, session });
        await setViewport({
          host: cdpHost,
          port: cdpPort,
          url,
          width: MOBILE_VIEWPORT_WIDTH,
          height: MOBILE_VIEWPORT_HEIGHT,
        });
        await ab([...flags, "wait", "500"]);
        mobile = parseEvalJson(
          (await ab([...flags, "eval", "--stdin"], { input: STYLES_JS })).stdout,
        );
      } catch (e) {
        process.stderr.write(`  ! mobile style pass failed: ${e.message}\n`);
      } finally {
        // Restore by setting the known desktop size explicitly, not by
        // asking CDP to "clear" the override — verified live that
        // Emulation.clearDeviceMetricsOverride does not reliably revert in
        // this workspace's headless/virtual-display Chrome (innerWidth
        // stayed at 375 across three set→clear→read-back cycles), while
        // setting the explicit desktop width/height restores immediately
        // every time. See cdp.mjs's setViewport doc comment. Unlike the
        // mobile pass above, a restore that can't be verified is NOT
        // swallowed here — see restoreDesktopViewport's doc comment (Fix 1).
        await restoreDesktopViewport({ flags, cdp, session, url, desktopWidth, desktopHeight, slug });
      }
    }
    await writeFile(stylesPath, JSON.stringify({ desktop, mobile }, null, 2));
  } catch (e) {
    // Style capture as a whole is best-effort (a page with no <h1>, weird
    // CSSOM, etc. must not fail the page) — EXCEPT a viewport restore this
    // codebase couldn't verify or self-heal (restoreDesktopViewport, Fix 1).
    // That one must never be swallowed: doing so is exactly the silent-
    // corruption class Task 4b eliminated for the CDP-endpoint bug, and
    // letting it through here is what makes captureOne (and so capture()'s
    // per-entry result) actually report ok: false instead of a falsely
    // successful capture at the wrong width.
    if (e && e.viewportContamination) throw e;
    process.stderr.write(`  ! style capture failed for ${slug}: ${e.message}\n`);
  }

  // ux.json — interactive-pattern inventory (Task 5). Runs here, after the
  // styles block's mobile pass has already restored the desktop viewport
  // (restoreDesktopViewport, above) — never during/right after the 375px
  // emulated pass — so the detectors see the page in the same normal,
  // un-emulated desktop state the full-page screenshot did. If the styles
  // block above threw a viewportContamination error, that throw already
  // propagated out of captureOne and this line is never reached — this pass
  // never runs against a tab whose desktop state couldn't be verified.
  // Best-effort like styles: a detection failure must not fail the whole
  // page's capture, but (matching every other best-effort block in this
  // function) it must never fail silently — hence the `  ! …` stderr line.
  //
  // Fix 2 (page-identity guard): the above guarantees the tab's VIEWPORT is
  // right, but restoreDesktopViewport's own doc comment already flags a
  // narrower residual gap — its last-resort fresh-tab self-heal opens
  // "about:blank" and has no reason to renavigate back to `url` (that was
  // never its job). Nothing previously ran after it to notice, so the UX
  // pass would silently eval UX_JS against a blank tab and write a
  // perfectly-shaped `{ patterns: [] }` — indistinguishable from "this page
  // genuinely has no interactive patterns", exactly the silent-wrong-but-
  // plausible failure class this codebase keeps getting burned by (Task 4b's
  // CDP-endpoint mismatch, Task 4d's viewport contamination). So: read the
  // active tab's URL back through agent-browser's own `get url` (independent
  // of whatever last touched the tab) and compare it against the page this
  // pass is actually supposed to be looking at via looksLikeSamePage
  // (hostname-only, not full-URL — see its doc comment for the live
  // stripe.com locale-redirect false positive that a stricter comparison
  // produced). A mismatch is recorded IN ux.json, not just stderr, so the
  // failure survives even if stderr is never read — `{ patterns: [], error }`
  // rather than a bare `{ patterns: [] }` — the same "keep the shape, add an
  // explicit error field" precedent sections.json already established
  // (see the per-section catch above).
  try {
    const activeUrl = (await ab([...flags, "get", "url"])).stdout.trim();
    if (!looksLikeSamePage(activeUrl, url)) {
      const msg =
        `ux capture skipped for ${slug}: active tab is at "${activeUrl}", expected the page being captured ` +
        `"${url}" — likely a viewport self-heal fresh tab that was never renavigated back; refusing to write ` +
        `a plausible-looking empty ux.json`;
      process.stderr.write(`  ! ${msg}\n`);
      await writeFile(uxPath, JSON.stringify({ patterns: [], error: msg }, null, 2));
    } else {
      const ux = await ab([...flags, "eval", "--stdin"], { input: UX_JS });
      await writeFile(uxPath, JSON.stringify(parseEvalJson(ux.stdout), null, 2));
    }
  } catch (e) {
    process.stderr.write(`  ! ux capture failed for ${slug}: ${e.message}\n`);
  }

  return { slug, url, captureDir, sectionCount: sections.length };
}

// Build the capture worklist. Prefer pagetypes.json: per type, its sample
// URLs, plus the archive page; then all one-off pages. Fall back to
// pages.json when classify hasn't been run.
//
// Alongside `entries`, returns `spares`: a Map<typeName, string[]> of each
// type's non-sample members, queued in member order. This is a *shared*
// pool per type, handed out lazily (see `takeSpare`/`nextFallbackUrl` below)
// only once one of that type's samples actually fails — never precomputed
// or pre-assigned to a particular sample index. `pickSamples` caps samples
// at 3 and `minMembers` defaults to 4, so a 4-5 member type commonly has
// just 1-2 spares against 3 samples. Statically pre-partitioning those
// spares (e.g. round-robin by index, dealt before any capture is even
// attempted) can strand a live spare on a sample that never needed it while
// a different sample that actually failed gets nothing — proven live: 1
// spare pre-assigned to the one sample that turned out to be healthy left
// both dead samples with empty fallback lists, 1/3 captured instead of the
// 2/3 that was achievable. A shared pool has no such blind spot: whichever
// sample fails first gets first claim, and a spare is only ever consumed by
// the entry that actually needed it.
//
// Three invariants the raw pagetypes.json data does not give us for free:
//  - Fix A: the worklist must contain each URL at most once. classify.mjs
//    computes a type's archiveUrl by slash-stripping a reconstructed parent
//    path (`(origin + parent).replace(/\/+$/, "")`), but crawled URLs in
//    `pages` keep whatever trailing slash the live site actually used — so
//    the same page can appear as `.../shop` (archiveUrl) and `.../shop/` (a
//    `pages` one-off). Deduping on the raw URL string misses this exact
//    case (proven live: 4 worklist entries instead of 3, `shop` captured
//    twice, second write silently overwriting the first in `captures/shop/`
//    since that's the directory both URLs slug to). The output-directory
//    slug (`urlToSlug`) is what actually determines identity, so that's the
//    dedup key, not the raw string. When a URL is duplicated, the typed
//    entry wins — it's the one designmd/transform and `--only <type>` key
//    off of.
//  - Fix B: a spare must never be handed to more than one entry. Only
//    entries built from a type's `samples` may draw from that type's pool
//    (`canFallback: true`) — the archive URL and one-off pages have no
//    substitute that means the same thing (a member page is not the
//    listing page it belongs to), and `replaceSample` only ever rewrites
//    `samples` anyway, so there'd be nowhere to record an archive/page
//    substitution even if we tried.
//  - Fix C: a spare must never be handed out if its slug collides with a
//    URL already in the worklist, or with another spare already queued in
//    the same type's pool. `members` is raw crawl data with no slug-
//    uniqueness guarantee of its own — a non-sample member can slug-collide
//    with an unrelated one-off page (the same trailing-slash shape Fix A
//    closes for `entries`, reopened here through the fallback path) or with
//    a sibling member in its own pool. Either way, handing it out makes
//    `captureOne` write into a `captures/<slug>/` directory some other
//    entry — or an earlier spare from the same pool — already owns (proven
//    live: member `.../hello-world/` offered as a fallback silently
//    overwrote the one-off page `.../hello-world`). So each pool is
//    filtered against the final `entries` slugs and against its own earlier
//    members before it is ever handed to `takeSpare`.
async function buildWorklist(runDir, only) {
  let entries;
  const rawSpares = new Map();
  try {
    const pt = JSON.parse(await readFile(path.join(runDir, "pagetypes.json"), "utf8"));

    // Fix 5: build entries in the SAME tier order transform.mjs's
    // resolveSlugClaims uses when two different types (or a type and a
    // one-off/page-kind page) claim the same output slug — tier 1: any real
    // type's OWN SAMPLE; tier 2: any real type's archiveUrl; tier 3: one-off
    // pages AND kind:"page" members alike (resolveSlugClaims treats both
    // identically — transform.mjs flattens a kind:"page" type's members
    // into its `oneOffs` list before ever calling resolveSlugClaims, so from
    // that function's point of view they're indistinguishable from a
    // pt.pages entry). Previously this pushed samples+archive PER TYPE,
    // interleaved with kind:"page" entries in whatever order pt.types
    // happened to list them — so when TWO DIFFERENT types collided on one
    // slug (proven live on barefootbuttons.com: product's archiveUrl and
    // the standalone shop type's own sample both being
    // https://barefootbuttons.com/shop/), array order decided the winner,
    // not resolveSlugClaims' own tiering (own-sample beats a cross-type
    // archive). The dedup step below keeps the FIRST-seen entry per slug —
    // building `entries` in strict tier order up front is what makes that
    // dedup implement the correct tiering instead of an accidental one.
    //
    // A `kind:"page"` type still gets no spare pool and no fallback: every
    // member is already its own full entry (canFallback: false, type:
    // null), same as a `pt.pages` entry — there is no "sample" vs "spare"
    // distinction left to have once every member is individually captured
    // (Fix 1 — proven live: one type, kind='page', 5 members, 2 samples →
    // capture only took 2, transform wanted 5, 3 silently dropped).
    const realTypes = pt.types.filter((t) => t.kind !== "page");
    const pageKindTypes = pt.types.filter((t) => t.kind === "page");

    for (const t of realTypes) {
      rawSpares.set(t.name, [...new Set(t.members.filter((m) => !t.samples.includes(m)))]);
    }

    entries = [];
    // Tier 1: every real type's own samples.
    for (const t of realTypes) {
      for (const url of t.samples) entries.push({ url, type: t.name, canFallback: true });
    }
    // Tier 2: every real type's archive URL.
    for (const t of realTypes) {
      if (t.archiveUrl) entries.push({ url: t.archiveUrl, type: t.name, canFallback: false });
    }
    // Tier 3: kind:"page" members, then plain one-off pages — same relative
    // order as before the reorder (both were always enumerated ahead of
    // nothing else, so this preserves every existing dedup outcome between
    // the two).
    for (const t of pageKindTypes) {
      for (const url of t.members) entries.push({ url, type: null, canFallback: false });
    }
    for (const p of pt.pages) entries.push({ url: p.url, type: null, canFallback: false });
  } catch {
    const pagesJson = JSON.parse(await readFile(path.join(runDir, "pages.json"), "utf8"));
    entries = pagesJson.pages.map((p) => ({ url: p.url, type: null, canFallback: false }));
  }

  // Collapse to one entry per URL, keyed by output slug — not the raw URL
  // string (Fix A). Type entries are always enumerated before one-off pages
  // (the loop above pushes every `t.samples`/`t.archiveUrl` entry ahead of
  // any `pt.pages` entry), so whenever a slug is shared between a typed
  // entry and an untyped page duplicate, the typed occurrence is always the
  // one seen first here — keeping just the first entry per slug is enough
  // to guarantee the typed entry always wins.
  const seenSlugs = new Set();
  const deduped = [];
  for (const e of entries) {
    const key = urlToSlug(e.url);
    if (seenSlugs.has(key)) continue;
    seenSlugs.add(key);
    deduped.push(e);
  }
  entries = deduped;

  // Fix C: dedupe each type's spare pool against the final worklist slugs
  // (a member must not shadow a URL that's already going to be captured as
  // its own entry) and against itself (if two members slug to the same
  // output directory, only the first is ever kept/offered).
  const spares = new Map();
  for (const [typeName, candidates] of rawSpares) {
    const claimed = new Set();
    const kept = [];
    for (const url of candidates) {
      const key = urlToSlug(url);
      if (seenSlugs.has(key) || claimed.has(key)) continue;
      claimed.add(key);
      kept.push(url);
    }
    spares.set(typeName, kept);
  }

  if (only) {
    // Fix 2: matchesOnly (src/slug.mjs) is the ONE shared --only matcher —
    // URL pathname, output slug, or page-type name, all three forms, same
    // normalization transform.mjs and verify.mjs now use too. Before this,
    // capture hand-rolled its own filter here that never accepted a bare
    // output slug ("about") — only a path ("/about") or a type name —
    // breaking `--only about` as a resume mechanism for exactly the stage
    // most likely to need resuming (a failed capture run).
    entries = entries.filter((e) => matchesOnly(only, { url: e.url, typeName: e.type }));
    if (entries.length === 0) throw new Error(`no pages match --only ${only}`);
  }
  return { entries, spares };
}

// Remove and return the next unconsumed spare URL from `typeName`'s shared
// pool, or undefined if there's no pool for that type (untyped entry) or
// it's already empty. Mutates the pool in place — once taken, a spare is
// gone for every other entry, which is what makes the pool "shared" instead
// of statically pre-partitioned (Fix B).
function takeSpare(spares, typeName) {
  const pool = typeName != null ? spares.get(typeName) : undefined;
  if (!pool || pool.length === 0) return undefined;
  return pool.shift();
}

// Total attempts per entry are capped at 1 (the original URL) + this many
// spares, regardless of how large the type's spare pool is — a 300-member
// type with hundreds of dead spares must not make one failing entry march
// through all of them.
const MAX_FALLBACK_ATTEMPTS = 2;

// Decide what URL, if any, `entry` should retry with after its most recent
// attempt just failed. Returns undefined when the entry has exhausted its
// own retry budget or its type's pool has nothing left — the only two ways
// an entry gives up. This is the exact decision `capture()` makes below;
// tests call it directly to pin which spare a failing sample gets without
// needing a real browser.
function nextFallbackUrl(entry, spares, fallbacksUsed) {
  if (!entry.canFallback || fallbacksUsed >= MAX_FALLBACK_ATTEMPTS) return undefined;
  return takeSpare(spares, entry.type);
}

// When a sample URL fails and a fallback member succeeds, record it in
// pagetypes.json so designmd/transform read captures that actually exist.
async function replaceSample(runDir, typeName, fromUrl, toUrl) {
  const ptPath = path.join(runDir, "pagetypes.json");
  try {
    const pt = JSON.parse(await readFile(ptPath, "utf8"));
    const t = pt.types.find((x) => x.name === typeName);
    if (!t) return;
    const i = t.samples.indexOf(fromUrl);
    if (i !== -1) t.samples[i] = toUrl;
    await writeFile(ptPath, JSON.stringify(pt, null, 2));
  } catch {}
}

// Fix 4: `agent-browser open` exits 0 on a themed 404 — the page LOADS fine
// as far as the browser is concerned, it's just the wrong content — so
// nothing in captureOne (or anywhere else in this file) ever notices. A
// stale sitemap URL then gets captured as if it were real, and transform
// rebuilds the 404 into a published `output/pages/<slug>.html`. Worse via
// the spare pool: a type's non-sample `members` are never status-checked by
// classify.mjs either (it only fingerprints `samples`), so a dead spare
// `nextFallbackUrl` hands out can get PROMOTED to the type's sample
// (replaceSample, below) — the CPT's content model + Twig template then get
// derived from a 404 page, silently.
//
// A plain `fetch(url, { method: "HEAD" })` needs no browser at all and is
// far cheaper than opening a tab, so this runs BEFORE captureOneImpl ever
// does. Some servers (or WAFs in front of them) reject HEAD outright with
// 405 — that's "HEAD isn't supported here", not "the page is dead", so it
// falls back to a ranged GET (`Range: bytes=0-0`) which still avoids pulling
// the full body just to read a status code. Any other non-2xx (404, 500,
// ...), or a network error/timeout, is a real failure.
//
// `fetchImpl` is an injection seam for tests (default: the real global
// `fetch`), matching this file's existing `spawnFn` pattern on `ab()`.
const STATUS_CHECK_TIMEOUT_MS = 10_000;
const STATUS_CHECK_UA = "replica/0.1";

export async function checkUrlStatus(url, { timeoutMs = STATUS_CHECK_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const attempt = (method, extraHeaders) =>
    fetchImpl(url, {
      method,
      redirect: "follow",
      headers: { "user-agent": STATUS_CHECK_UA, ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
  try {
    let res = await attempt("HEAD");
    if (res.status === 405) {
      res = await attempt("GET", { Range: "bytes=0-0" });
    }
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: null, error: e.message };
  }
}

// Fix 1a: is `err` a sign that the BROWSER/TAB ITSELF died, as opposed to an
// ordinary single-page failure (a timeout waiting for one selector, a 404, a
// bad selector)? This distinction matters because the two need completely
// different responses: an ordinary failure is exactly what the existing
// spare-fallback pool exists for (try a DIFFERENT page), while a dead
// browser can't be fixed by trying a different URL — every subsequent
// ab()/CDP call will fail identically until the browser itself recovers.
//
// Deliberately narrow and evidence-grounded: every pattern below is either
// (a) an exact error string observed live, reproducibly, when this exact
// workspace's scratch Chrome crashed mid-capture against
// smittenkitchen.com (see .superpowers/sdd/dogfood-a1-report.md and this
// task's own before-fix repro logs) — "CDP response channel closed" (the
// moment the browser dies mid-command) and "Auto-launch failed: ...
// Connection refused" (every subsequent command, once the whole process is
// gone) are both agent-browser's own verbatim wording — or (b) a
// Node-level ECONNREFUSED-shaped failure, which is what OUR OWN raw-CDP
// calls (cdp.mjs, not agent-browser) throw for the identical underlying
// condition. It must NOT match agent-browser's ordinary, mundane
// "Operation timed out. The page may still be loading or the element may
// not exist." — that fires constantly for perfectly healthy browsers (a
// selector that never appears, a slow-but-alive page) and must keep going
// through the normal fallback path, not the browser-recovery one.
//
// `err.timedOut === true` (our OWN ab() wrapper's structural timeout marker
// — see ab()'s doc comment) is checked directly rather than by message
// text: a command WE gave up on after DEFAULT_AB_TIMEOUT_MS is exactly the
// "browser/tab looks wedged" signal this function exists to catch,
// independent of whatever text happens to be in the message.
const BROWSER_DEATH_PATTERNS = [
  /cdp response channel closed/i,
  /connection refused/i,
  /econnrefused/i,
  /auto-launch failed/i,
  /failed to connect to cdp/i,
  /websocket connect failed/i,
];

// Node error `.cause` chains (e.g. a raw `fetch()` ECONNREFUSED from our own
// cdp.mjs isBrowserReachable/CDP-connect path, not agent-browser) often
// carry the actually-diagnostic text on a NESTED cause, not the top-level
// `.message` — collect a bounded chain of message/code text so a pattern
// like /econnrefused/i matches regardless of which level it's reported at.
function errorSignatureText(err) {
  const parts = [];
  let e = err;
  for (let depth = 0; e && depth < 4; depth += 1) {
    if (e.message) parts.push(String(e.message));
    if (e.code) parts.push(String(e.code));
    e = e.cause;
  }
  return parts.join(" | ");
}

export function isBrowserDeathError(err) {
  if (!err) return false;
  if (err.timedOut === true) return true;
  const text = errorSignatureText(err);
  return BROWSER_DEATH_PATTERNS.some((re) => re.test(text));
}

// Fix 1a default recovery: ask agent-browser for a fresh tab. If the whole
// browser process is gone (not just this one tab/renderer), this itself
// fails fast — agent-browser's own auto-launch attempt-and-fail was
// consistently quick in the before-fix repro logs — and THAT failure is the
// signal recovery didn't work; capture() below reacts to a false return,
// never to this throwing.
const BROWSER_RECOVERY_TIMEOUT_MS = 20_000;

async function defaultRecoverBrowser({ cdp, session }) {
  const flags = ["--cdp", String(cdp), "--session", session];
  try {
    await ab([...flags, "tab", "new", "about:blank"], { timeoutMs: BROWSER_RECOVERY_TIMEOUT_MS });
    const res = await ab([...flags, "get", "url"], { timeoutMs: BROWSER_RECOVERY_TIMEOUT_MS });
    return /^about:blank/.test(res.stdout.trim());
  } catch {
    return false;
  }
}

// Fix 1a default reachability probe: a quick, independent HTTP check (NOT
// another agent-browser subprocess round trip) so capture() can tell "still
// down" from "back up" for the rest of the worklist without paying the full
// per-page ab() timeout budget on every remaining entry — see
// isBrowserReachable's own doc comment (cdp.mjs) for the exact before-fix
// cost this avoids.
async function defaultProbeBrowser({ cdp, session }) {
  try {
    const { host, port } = resolveSessionCdpEndpoint({ cdp, session });
    return await isBrowserReachable({ host, port });
  } catch {
    return false;
  }
}

export async function capture({
  site,
  runsDir = "runs",
  cdp = 9223,
  session = "personal",
  only = null,
  // Injection seams (Fix 4 wiring test) — production callers never pass
  // these; they default to the real status check and the real
  // (agent-browser-driving) captureOne.
  checkStatus = checkUrlStatus,
  captureOneImpl = captureOne,
  // Fix 1a injection seams — production callers never pass these either;
  // they default to the real fresh-tab recovery attempt and the real HTTP
  // reachability probe. Tests override both to drive the browser-death/
  // recovery/fail-fast-then-resume orchestration deterministically, without
  // a real agent-browser process or CDP connection.
  recoverBrowser = defaultRecoverBrowser,
  probeBrowser = defaultProbeBrowser,
} = {}) {
  const runDir = path.join(runsDir, site);
  const { entries, spares } = await buildWorklist(runDir, only);

  const results = [];
  // Fix 1a: sticky ACROSS entries, not per-entry — once a recovery attempt
  // itself fails, the browser is presumed down for every LATER entry too
  // (not just the one that just failed), until a cheap probe says
  // otherwise. This is what turns "burn a full timeout proving the same
  // dead browser N times over" (the exact 0/10 dogfood shape) into "confirm
  // it once, then just ask".
  let browserConfirmedDown = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let captured = null;
    let lastErr = null;
    let url = entry.url;
    let fallbacksUsed = 0;
    // Bounded to ONE recovery attempt per WORKLIST ENTRY (however many URL
    // variants — the original sample plus any spares — get tried for it),
    // the same "per-entry, not per-attempt" bound MAX_FALLBACK_ATTEMPTS
    // already uses for spares.
    let recoveryAttempted = false;

    if (browserConfirmedDown) {
      const reachable = await probeBrowser({ cdp, session });
      if (reachable) {
        browserConfirmedDown = false;
        process.stderr.write(`  ↻ browser at cdp ${cdp} is reachable again — resuming normal capture\n`);
      } else {
        const slug = urlToSlug(url);
        process.stderr.write(
          `[${i + 1}/${entries.length}] ${slug} ← ${url}\n` +
            `  ✗ skipped: browser at cdp ${cdp} is still unreachable (confirmed down earlier this run)\n`,
        );
        results.push({
          ok: false,
          type: entry.type,
          slug,
          url: entry.url,
          error: `browser at cdp ${cdp} unreachable — skipped without attempting capture`,
        });
        continue;
      }
    }

    for (;;) {
      const slug = urlToSlug(url);
      process.stderr.write(`[${i + 1}/${entries.length}] ${slug} ← ${url}\n`);
      let phase = "status-check";
      try {
        // Fix 4: reject a non-2xx BEFORE opening a browser tab. Thrown here
        // (rather than silently skipped), so it lands in the exact same
        // catch block as any captureOneImpl failure below — reusing the
        // already-proven nextFallbackUrl/spare-pool machinery rather than
        // reinventing a second failure path.
        const status = await checkStatus(url);
        if (!status.ok) {
          throw new Error(
            `pre-flight status check failed for ${url}: ${
              status.status != null ? `HTTP ${status.status}` : status.error || "unknown error"
            }`,
          );
        }
        // Fix 1a: `phase` flips to "capture" only once the target URL is
        // CONFIRMED healthy — isBrowserDeathError/recovery below must never
        // fire for a status-check failure. A dead target SITE can
        // legitimately say "connection refused" too (its own server is
        // down), which has nothing to do with OUR browser and must not be
        // misread as "the browser died" — captureOneImpl has no network
        // egress of its own beyond agent-browser/CDP talking to our OWN
        // scratch browser, so anything IT throws really is about our
        // tooling, never the target site (already confirmed reachable by
        // checkStatus moments earlier).
        phase = "capture";
        captured = await captureOneImpl({ url, slug, runDir, cdp, session });
        if (url !== entry.url && entry.type) {
          await replaceSample(runDir, entry.type, entry.url, url);
          process.stderr.write(`  ↻ sample replaced: ${entry.url} → ${url}\n`);
        }
        break;
      } catch (e) {
        lastErr = e;
        process.stderr.write(`  ✗ ${e.message}\n`);

        if (phase === "capture" && isBrowserDeathError(e) && !recoveryAttempted) {
          recoveryAttempted = true;
          process.stderr.write(`  ! ${slug}: looks like the browser/tab died (${e.message}) — attempting recovery\n`);
          let recovered = false;
          try {
            recovered = await recoverBrowser({ cdp, session, slug });
          } catch {
            recovered = false;
          }
          if (recovered) {
            process.stderr.write(`  ↻ browser recovered for ${slug} — retrying the same URL\n`);
            continue; // retry the SAME url; does not touch fallbacksUsed
          }
          browserConfirmedDown = true;
          process.stderr.write(
            `  ✗ ${slug}: browser recovery failed — marking the browser at cdp ${cdp} as down; ` +
              `remaining pages will be probed (not fully retried) until it comes back\n`,
          );
        }

        const spare = nextFallbackUrl(entry, spares, fallbacksUsed);
        if (spare === undefined) break;
        fallbacksUsed += 1;
        url = spare;
      }
    }
    if (captured) results.push({ ok: true, type: entry.type, ...captured });
    else results.push({ ok: false, type: entry.type, slug: urlToSlug(entry.url), url: entry.url, error: lastErr?.message });
  }
  return { count: results.length, ok: results.filter((r) => r.ok).length, results };
}

export { buildWorklist, takeSpare, nextFallbackUrl, MAX_FALLBACK_ATTEMPTS };
