// Capture worklist + pure extraction helpers.
//
// As of 4.0.0 this module drives nothing. The browser is driven by the AGENT
// via agent-browser, following the bundle captureBundle.mjs writes; what lives
// here is the worklist logic (which pages get captured, and what falls back to
// what), the payload re-exports, and the pure helpers that mirror in-browser
// decisions so they can be unit-tested without a page.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { urlToSlug, matchesOnly, siteFromUrl } from "./slug.mjs";
import { MAX_CLIP_WIDTH_PX, MAX_CLIP_HEIGHT_PX, MAX_CLIP_AREA_PX2 } from "./clipLimits.mjs";
import { readPayload } from "./payloads.mjs";

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
export const CONTENT_JS = await readPayload("content");

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

// Pure parity copy of CONTENT_JS's in-browser video/embed classifier — same
// eval-boundary constraint as buildTableModel above (the payload cannot
// import this, so the two are kept in sync by hand). A <video> is always
// kind "video"; an <iframe> is classified by hostname against the known
// player list, and anything else stays a generic "iframe" (still recorded —
// a map embed is content too; chat widgets never reach here because
// sections.js already excludes their containers).
export const VIDEO_HOST_KINDS = [
  [/(^|\.)youtube(-nocookie)?\.com$/i, "youtube"],
  [/(^|\.)youtu\.be$/i, "youtube"],
  [/(^|\.)vimeo\.com$/i, "vimeo"],
  [/(^|\.)wistia\.(com|net)$/i, "wistia"],
  [/(^|\.)loom\.com$/i, "loom"],
];

export function videoKindForSrc(tag, src) {
  if (String(tag).toUpperCase() === "VIDEO") return "video";
  let host = "";
  try {
    host = new URL(src).hostname;
  } catch {
    return "iframe";
  }
  for (const [re, kind] of VIDEO_HOST_KINDS) if (re.test(host)) return kind;
  return "iframe";
}

export function buildVideoModel({
  tag, src, poster = null, title = null, autoplay = false, width = null, height = null, rendered = true,
} = {}) {
  if (!src || !rendered) return null;
  return {
    kind: videoKindForSrc(tag, src),
    src,
    poster: poster || null,
    title: title || null,
    width: width || null,
    height: height || null,
    autoplay: Boolean(autoplay),
  };
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

export const ASSETS_JS = await readPayload("assets");

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
export const STYLES_JS = await readPayload("styles");

// Interactive-pattern inventory. Each detector maps a source-site behavior to
// a named Alpine recipe (see prompts/alpine-recipes.md). Animations are out of
// scope by design — recipes are instant-state. Exported (unlike the other
// `_JS` constants above) so a unit test can statically pin its recipe names
// against prompts/alpine-recipes.md's headings — the join key between the
// two files (see the consistency test in capture.test.mjs).
//
// Live-verified against a WordPress dev site and two large marketing sites
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
export const UX_JS = await readPayload("ux");

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

export const DOM_JS = await readPayload("dom");

// Cheap page-size probe, run immediately before the full-page screenshot
// (Fix 1a/Fix 2) so captureOne can decide the clip height itself — instead
// of handing an unbounded "just capture the whole thing" request to
// agent-browser's own screenshot mechanism (see cdp.mjs's
// captureFullPageScreenshot doc comment for why that's the actual crash/
// void mechanism this replaces). Same scrollHeight formula SECTIONS_JS's
// own viewport.cssHeight already uses, kept consistent on purpose. Exported
// so verify.mjs's own full-page screenshot (Fix 2, prerelease review) can
// measure a page the exact same way, rather than re-deriving this formula.
export const PAGE_SIZE_JS = await readPayload("page-size");

// Scroll the full page in steps so IntersectionObservers + lazy-load libraries
// (lozad, lazysizes, native loading="lazy", elementor lazyloading, etc.) fire
// for every section. Then return to the top. CDP's captureBeyondViewport
// screenshot does NOT trigger these observers, so element-scoped screenshots
// of below-the-fold blocks come back blank unless we prime the page first.
export const SCROLL_PASS_JS = await readPayload("scroll-pass");

// Tag visible page sections and return their document-absolute geometry so
// we can crop each section out of the full-page screenshot.
// Strategy:
//   - header  → <header>, role=banner, or the first <nav>'s container
//   - footer  → <footer> or role=contentinfo
//   - hero    → first sizeable top-level child under <main> (or <body>)
//   - section-N → remaining top-level children, in document order
// Returns { viewport: {...}, sections: [...] }. Each section includes
// {top,left,width,height} in CSS pixels relative to the document origin.
export const SECTIONS_JS = await readPayload("sections");

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
export const REVEAL_JS = await readPayload("reveal");

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

export { buildWorklist, takeSpare, nextFallbackUrl, MAX_FALLBACK_ATTEMPTS };
