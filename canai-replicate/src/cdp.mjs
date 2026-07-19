// Minimal Chrome DevTools Protocol client for taking node-clipped screenshots.
//
// Why this file exists: agent-browser's `screenshot <selector>` returns blank
// images for elements below the fold. DevTools' "Capture node screenshot"
// works because it calls `Page.captureScreenshot` with an explicit clip
// rectangle and `captureBeyondViewport: true` — the renderer composites a
// fresh frame for that region regardless of current scroll. We do the same
// thing by talking CDP directly over the page's WebSocket.
//
// This module is deliberately agent-browser-agnostic: it just speaks raw CDP
// to whatever `host:port` it's given. It is the caller's job to pass the
// `host`/`port` of the browser agent-browser's session is *actually* driving
// — see agentBrowser.mjs's `resolveSessionCdpEndpoint`, which asks
// agent-browser itself (`get cdp-url`) rather than assuming the `--cdp` port
// is correct. Get that wrong and `findPageTarget` below now throws instead of
// silently screenshotting an unrelated tab.
//
// Every CDP command sent through `CDPSession.send` races against a timeout
// (see DEFAULT_CDP_TIMEOUT_MS/CAPTURE_SCREENSHOT_TIMEOUT_MS below) and
// `captureNodeScreenshot` refuses an oversized clip before it ever opens a
// connection (see MAX_CLIP_*/clipSizeError). Both exist because
// `Page.captureScreenshot { captureBeyondViewport: true }` on a large enough
// clip does not just get slow, it hangs indefinitely — observed live on
// tailwindcss.com's homepage (a single-wrapper layout tagged the whole page,
// ~1722x11605 CSS px, as one "hero"); see
// reports/2026-07-13-canai-replicate-giant-hero-clip-hangs.md.
//
// Requires Node 22+ (global WebSocket).

import { writeFile } from "node:fs/promises";

// A CDP command that never gets a reply would otherwise hang its caller
// forever. Every `CDPSession.send` call races against one of these; a stuck
// renderer fails the one call loudly instead of wedging the whole capture
// run. captureScreenshot gets a longer budget since a large-but-legitimate
// (allowed) clip can genuinely take longer than a metadata call like
// `Emulation.setDeviceMetricsOverride`.
const DEFAULT_CDP_TIMEOUT_MS = 15_000;
const CAPTURE_SCREENSHOT_TIMEOUT_MS = 30_000;
// A full-page shot is bigger than any single section by definition, so it
// gets a longer budget than CAPTURE_SCREENSHOT_TIMEOUT_MS above — see
// captureFullPageScreenshot's doc comment.
const FULL_PAGE_SCREENSHOT_TIMEOUT_MS = 45_000;
// Health-probe budget for isBrowserReachable — deliberately much shorter
// than DEFAULT_CDP_TIMEOUT_MS: a probe meant to be cheap and repeatable (see
// its own doc comment) should fail fast, not wait as long as a real command.
const REACHABILITY_PROBE_TIMEOUT_MS = 3_000;

// Chrome must rasterize an entire `captureBeyondViewport` clip in one pass —
// no tiling. A real page section — even an unusually large hero, carousel,
// or pricing table — is at most a few viewport-heights tall; only a "whole
// page mis-tagged as one section" shape (single-wrapper DOM, common in
// Next.js/React app shells) blows past these numbers, so they're generous
// for anything legitimate while still catching the pathological case that
// hung indefinitely in testing. Checked independently since a pathological
// clip can blow up just one dimension (e.g. full page height, viewport-width).
export const MAX_CLIP_WIDTH_PX = 4000;
export const MAX_CLIP_HEIGHT_PX = 6000;
export const MAX_CLIP_AREA_PX2 = 12_000_000;

// Pure guard, no I/O: the reason `clip` must be refused, or null if it's
// within limits. Exported so callers (and tests) can reason about a clip
// without needing a live CDP connection. `captureNodeScreenshot` also
// enforces this itself (belt-and-suspenders — any caller is protected, not
// just one that remembered to check first).
export function clipSizeError(clip) {
  if (!clip) return "no clip geometry given";
  const { width, height } = clip;
  if (!(width > 0) || !(height > 0)) {
    return `invalid clip dimensions ${width}x${height}`;
  }
  if (width > MAX_CLIP_WIDTH_PX) {
    return `clip width ${width}px exceeds the ${MAX_CLIP_WIDTH_PX}px safety limit (likely a mis-tagged whole-page section)`;
  }
  if (height > MAX_CLIP_HEIGHT_PX) {
    return `clip height ${height}px exceeds the ${MAX_CLIP_HEIGHT_PX}px safety limit (likely a mis-tagged whole-page section)`;
  }
  const area = width * height;
  if (area > MAX_CLIP_AREA_PX2) {
    return `clip area ${area}px^2 (${width}x${height}) exceeds the ${MAX_CLIP_AREA_PX2}px^2 safety limit (likely a mis-tagged whole-page section)`;
  }
  return null;
}

// Full-page screenshots are legitimately much taller than any single section
// clip (MAX_CLIP_*/clipSizeError above exist specifically to catch a
// mis-tagged whole-page SECTION and must stay exactly as strict as they
// always were for that use case — a real single-element clip taller than
// ~6000px remains exactly as suspicious as before) — so a full page needs
// its OWN, much more generous ceiling instead of reusing or loosening the
// per-section one.
//
// The exact number is evidence-grounded (this workspace, live capture
// against smittenkitchen.com — see reports/2026-07-14-canai-replicate-v3-followups.md's
// sibling reports and .superpowers/sdd/dogfood-a1-report.md, Defects 1 and
// 4): full-page screenshots of ordinary pages on that site's shared theme
// routinely ran 22,000-25,000 CSS px tall without an outright crash, but
// with visible stress right at that ceiling (a 30s CDP timeout capturing
// just one section on an otherwise-successful page, immediately followed
// by the browser dying outright on the very next command) — while pages
// north of that (62,816px / 107,352px) correlate directly with the browser
// crashing ("CDP response channel closed") on that page or the next. This
// cap sits comfortably below the observed stressed-but-not-yet-crashing
// zone, while still being generous enough for the vast majority of real
// long-form pages — "degraded is acceptable" (a capped screenshot, loudly
// noted) is the point; an uncapped attempt at 60,000+ px is not.
export const MAX_FULL_PAGE_HEIGHT_PX = 15_000;

// Pure: given the page's actually-measured width/height, decide the clip
// geometry a full-page screenshot should request — capped at maxHeightPx,
// never above it, regardless of how tall the real page is. Exported so the
// CAPPING DECISION is unit-testable without a live browser or WebSocket;
// captureFullPageScreenshot below is what actually issues the CDP call with
// this geometry.
export function capFullPageHeight(width, height, maxHeightPx = MAX_FULL_PAGE_HEIGHT_PX) {
  const cappedHeight = Math.min(height, maxHeightPx);
  return {
    width,
    height: cappedHeight,
    requestedHeight: height,
    capped: cappedHeight < height,
  };
}

async function listTargets(host, port) {
  const res = await fetch(`http://${host}:${port}/json`, { signal: AbortSignal.timeout(DEFAULT_CDP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDP /json: HTTP ${res.status}`);
  return res.json();
}

// Pick the page target whose URL matches `urlMatch` exactly, falling back to
// startsWith, falling back to includes. Skips DevTools windows, iframes,
// service workers, etc.
async function findPageTarget(host, port, urlMatch) {
  const list = await listTargets(host, port);
  const pages = list.filter((t) => t.type === "page");
  if (urlMatch) {
    const exact = pages.find((t) => t.url === urlMatch);
    if (exact) return exact;
    const prefix = pages.find((t) => t.url && t.url.startsWith(urlMatch));
    if (prefix) return prefix;
    const contains = pages.find((t) => t.url && t.url.includes(urlMatch));
    if (contains) return contains;
    // No target at host:port matches. This used to fall through to the
    // "most recently activated tab" heuristic below — which is exactly how
    // this bug shipped: agent-browser's session can be driving a *different*
    // browser than the one listening at host:port (see agentBrowser.mjs's
    // resolveSessionCdpEndpoint), so host:port's tabs have nothing to do
    // with the page we think we're screenshotting. The fallback would
    // silently hand back some unrelated tab, and a clip rect from the real
    // page would then screenshot blank/wrong content from that tab — no
    // error, no signal, just a wrong PNG. Fail loudly instead.
    const seen = pages.length
      ? pages.map((t) => `  - ${JSON.stringify(t.url || "(no url)")}`).join("\n")
      : "  (no page targets at all)";
    throw new Error(
      `CDP target mismatch at ${host}:${port}: no page target matches URL ${JSON.stringify(urlMatch)}.\n` +
        `Targets seen at ${host}:${port}:\n${seen}\n` +
        `This usually means the agent-browser session and the --cdp port point at different ` +
        `browsers. Resolve the session's real CDP endpoint (agentBrowser.mjs's ` +
        `resolveSessionCdpEndpoint, via \`agent-browser get cdp-url\`) instead of assuming the ` +
        `--cdp port is where the session's browser lives.`,
    );
  }
  // No urlMatch requested: caller just wants *some* usable page target.
  // Fall back to the most recently activated page that isn't devtools/glic.
  const usable = pages.filter(
    (t) => !/^devtools:/.test(t.url) && !/gemini\.google\.com\/glic/.test(t.url),
  );
  if (usable.length === 0) throw new Error(`no usable page target found at ${host}:${port}`);
  return usable[0];
}

class CDPSession {
  constructor(wsUrl, { connectTimeoutMs = DEFAULT_CDP_TIMEOUT_MS } = {}) {
    if (typeof WebSocket === "undefined") {
      throw new Error(
        "WebSocket is not available. Use Node 22+ (or run with --experimental-websocket on Node 20/21).",
      );
    }
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onErr);
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`CDP WebSocket did not open within ${connectTimeoutMs}ms: ${wsUrl}`)),
        connectTimeoutMs,
      );
      const onOpen = () => finish(resolve);
      const onErr = (ev) => finish(reject, new Error(`CDP WebSocket error: ${ev.message || "unknown"}`));
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onErr);
    });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id == null) return; // event, not a reply
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }

  // Every call races against `timeoutMs` (default DEFAULT_CDP_TIMEOUT_MS).
  // A command that never gets a reply — the giant-clip hang this exists to
  // prevent — rejects instead of leaving its caller stuck forever; the
  // `pending` entry is removed either way so a very late reply is just
  // ignored (see the message handler's `if (!p) return`), not mis-delivered
  // to a new call that reused the id space.
  send(method, params, { timeoutMs = DEFAULT_CDP_TIMEOUT_MS } = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms waiting for a reply`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// Capture a clip of the current page. clip is in CSS pixels at scale 1.
// captureBeyondViewport renders content outside the current viewport — which
// is what makes this work for off-screen sections.
export async function captureNodeScreenshot({
  host = "127.0.0.1",
  port = 9223,
  url,
  clip,
  outPath,
  format = "png",
  timeoutMs = CAPTURE_SCREENSHOT_TIMEOUT_MS,
}) {
  // Fail fast on an oversized clip — before resolving a target or opening a
  // WebSocket at all. See MAX_CLIP_*/clipSizeError's doc comment.
  const sizeError = clipSizeError(clip);
  if (sizeError) {
    throw new Error(`refusing to capture node screenshot: ${sizeError}`);
  }
  const target = await findPageTarget(host, port, url);
  const cdp = new CDPSession(target.webSocketDebuggerUrl);
  try {
    await cdp.ready;
    const result = await cdp.send(
      "Page.captureScreenshot",
      {
        format,
        clip: {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: 1,
        },
        captureBeyondViewport: true,
        fromSurface: true,
      },
      { timeoutMs },
    );
    await writeFile(outPath, Buffer.from(result.data, "base64"));
  } finally {
    cdp.close();
  }
}

// Full page (not a single section) screenshot, taken the same way
// captureNodeScreenshot takes a section clip — direct CDP
// Page.captureScreenshot with captureBeyondViewport: true — but through its
// OWN size ceiling (capFullPageHeight/MAX_FULL_PAGE_HEIGHT_PX above)
// instead of the per-section MAX_CLIP_*/clipSizeError guard, and its OWN
// (longer) timeout budget, since a legitimately full-page capture is bigger
// than any single section by definition.
//
// Exists to replace agent-browser's own `screenshot --full` at this exact
// call site (capture.mjs's captureOne) — that command has no comparable
// size guard or bounded timeout of its own, and live evidence (this
// workspace, smittenkitchen.com — see MAX_FULL_PAGE_HEIGHT_PX's doc comment
// above) ties it to BOTH a crash (the browser dying mid-capture on a very
// tall page) and a silent artifact (three structurally unrelated pages —
// privacy-policy, contact, books — each coming back exactly 26,394px tall
// with a blank void below their real, much shorter content: measured
// directly off the actual PNGs this workspace's dogfood run produced, not
// inferred — a clamp inside that opaque, closed-source command, not real
// page content). Routing the full-page shot through this project's own
// already-proven CDP plumbing instead gives it the same guarantees every
// section clip already has: an explicit, bounded timeout (never hangs
// indefinitely) and an explicit, caller-visible height ceiling (never
// silently truncates without saying so — the caller gets `capped`/
// `requestedHeight` back and decides what to log/record).
export async function captureFullPageScreenshot({
  host = "127.0.0.1",
  port = 9223,
  url,
  width,
  height,
  outPath,
  format = "png",
  timeoutMs = FULL_PAGE_SCREENSHOT_TIMEOUT_MS,
  maxHeightPx = MAX_FULL_PAGE_HEIGHT_PX,
}) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`refusing to capture full-page screenshot: invalid page size ${width}x${height}`);
  }
  const plan = capFullPageHeight(width, height, maxHeightPx);
  const target = await findPageTarget(host, port, url);
  const cdp = new CDPSession(target.webSocketDebuggerUrl);
  try {
    await cdp.ready;
    const result = await cdp.send(
      "Page.captureScreenshot",
      {
        format,
        clip: { x: 0, y: 0, width: plan.width, height: plan.height, scale: 1 },
        captureBeyondViewport: true,
        fromSurface: true,
      },
      { timeoutMs },
    );
    await writeFile(outPath, Buffer.from(result.data, "base64"));
  } finally {
    cdp.close();
  }
  return plan;
}

// Emulate a viewport on the page target (used by capture to re-measure
// computed styles at a mobile width).
//
// To restore the real size afterward, call this again with the desktop
// width/height (capture.mjs already has them from its desktop STYLES_JS
// pass) rather than reaching for a "clear the override" call. This module
// used to also export `clearViewport` (`Emulation.clearDeviceMetricsOverride`)
// for that, but it proved unreliable live in this workspace's headless/
// virtual-display Chrome: verified by cycling set(375,812) → clear() →
// read-back, three times in a row — `window.innerWidth` (read back through
// agent-browser's own `eval`, on the correctly-resolved target) stayed at
// 375 every time instead of reverting, while an explicit second
// `setDeviceMetricsOverride(1722, 955)` restored it immediately and
// reliably. There may be no well-defined "natural" size for `clear` to
// revert *to* in this kind of environment. Explicit set-to-known-size has no
// such ambiguity, so that's the one mechanism this module offers.
export async function setViewport({
  host = "127.0.0.1",
  port = 9223,
  url,
  width,
  height,
  timeoutMs = DEFAULT_CDP_TIMEOUT_MS,
}) {
  const target = await findPageTarget(host, port, url);
  const cdp = new CDPSession(target.webSocketDebuggerUrl);
  try {
    await cdp.ready;
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 600,
      },
      { timeoutMs },
    );
  } finally {
    cdp.close();
  }
}

// Cheap, fast reachability check for a CDP endpoint — does ANY browser
// answer at host:port at all? Exists for capture()'s browser-death recovery
// (Fix 1a, capture.mjs): once a captureOneImpl failure looks like the
// browser/tab died (see capture.mjs's isBrowserDeathError), re-attempting
// the full, multi-step capture sequence for every remaining worklist entry
// (each paying the full ab() timeout budget) wastes minutes proving the
// same thing over and over when the browser is still down — this exact
// workspace's dogfood run against smittenkitchen.com needed ~10 full
// capture-sequence timeouts to discover what one ~second-scale probe would
// have shown immediately (capture.log/capture2.log/capture3.log in
// .superpowers/sdd/dogfood-a1-report.md's evidence trail: every entry after
// the crash failed identically with "Auto-launch failed: ... Connection
// refused"). Hits `/json/version` (the same endpoint listTargets() above
// already trusts) with its own short, independent timeout — deliberately
// NOT reusing DEFAULT_CDP_TIMEOUT_MS (15s): a probe meant to be cheap and
// repeated often should fail fast, not wait as long as a real command
// would.
//
// `fetchImpl` is an injection seam for tests (default: the real global
// fetch), matching this codebase's existing DI pattern (capture.mjs's
// checkUrlStatus).
export async function isBrowserReachable(
  { host = "127.0.0.1", port = 9223 } = {},
  { timeoutMs = REACHABILITY_PROBE_TIMEOUT_MS, fetchImpl = fetch } = {},
) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}
