// Exercises cdp.mjs's target-selection failure modes by stubbing the global
// `fetch` that listTargets() calls (CDP's /json endpoint) — no real Chrome
// needed. We drive it through the public captureNodeScreenshot/setViewport
// functions (findPageTarget itself isn't exported) and assert on what throws
// *before* a WebSocket is ever opened. The end-to-end "does a matched target
// actually screenshot the right pixels" behavior is proven live against real
// Chrome instances (see task-4b-report.md), not re-derived here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  captureNodeScreenshot,
  setViewport,
  clipSizeError,
  MAX_CLIP_WIDTH_PX,
  MAX_CLIP_HEIGHT_PX,
  MAX_CLIP_AREA_PX2,
  capFullPageHeight,
  captureFullPageScreenshot,
  MAX_FULL_PAGE_HEIGHT_PX,
  isBrowserReachable,
} from "./cdp.mjs";

function stubFetch(t, targets) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => targets });
  t.after(() => {
    globalThis.fetch = original;
  });
}

// Minimal fake WebSocket: dispatches "open" on the next microtask (so
// `cdp.ready` resolves) but NEVER dispatches "message" — the shape needed to
// prove CDPSession.send's timeout actually fires instead of hanging forever,
// without a real Chrome. Built on Node's global EventTarget/Event so
// addEventListener/removeEventListener/dispatchEvent behave like the real
// WebSocket API CDPSession relies on.
class FakeSilentWebSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send() {
    /* swallow — the whole point is that no reply ever arrives */
  }
  close() {}
}

function stubWebSocket(t, WsClass) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WsClass;
  t.after(() => {
    globalThis.WebSocket = original;
  });
}

test("findPageTarget (via captureNodeScreenshot): throws loudly when urlMatch matches nothing", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/example" },
  ]);
  await assert.rejects(
    () =>
      captureNodeScreenshot({
        host: "127.0.0.1",
        port: 9223,
        url: "https://wpdev.xcloudzen.com/",
        clip: { x: 0, y: 0, width: 10, height: 10 },
        outPath: "/dev/null",
      }),
    (err) => {
      assert.match(err.message, /CDP target mismatch/);
      assert.match(err.message, /wpdev\.xcloudzen\.com/);
      assert.match(err.message, /example\.com/, "must list the targets it actually saw");
      assert.match(
        err.message,
        /agent-browser session and the --cdp port point at different/,
        "must hint at the session/--cdp mismatch, since that's the real-world cause",
      );
      return true;
    },
  );
});

test("findPageTarget: throws loudly (not 'no usable target') when urlMatch is given but there are zero page targets", async (t) => {
  stubFetch(t, []);
  await assert.rejects(
    () =>
      setViewport({
        host: "127.0.0.1",
        port: 9223,
        url: "https://wpdev.xcloudzen.com/",
        width: 375,
        height: 812,
      }),
    (err) => {
      assert.match(err.message, /CDP target mismatch/);
      assert.match(err.message, /no page targets at all/);
      return true;
    },
  );
});

test("findPageTarget: with no urlMatch, throws a distinct 'no usable page target' error when only devtools/glic targets exist", async (t) => {
  stubFetch(t, [
    { type: "page", url: "devtools://devtools/bundled/inspector.html" },
    { type: "page", url: "https://gemini.google.com/glic/abc" },
  ]);
  await assert.rejects(
    () =>
      // setViewport is always called with a url in this codebase, but the
      // function itself supports the no-urlMatch case — exercise it directly.
      setViewport({ host: "127.0.0.1", port: 9223, url: undefined, width: 375, height: 812 }),
    /no usable page target found/,
  );
});

test("findPageTarget: an exact URL match proceeds past target selection (fails later, on the WebSocket, not on target mismatch)", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://wpdev.xcloudzen.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/nope" },
  ]);
  await assert.rejects(
    () =>
      captureNodeScreenshot({
        host: "127.0.0.1",
        port: 9223,
        url: "https://wpdev.xcloudzen.com/",
        clip: { x: 0, y: 0, width: 10, height: 10 },
        outPath: "/dev/null",
      }),
    (err) => {
      // Port 1 is a reserved port nothing listens on, so the WebSocket
      // connection itself fails — proving we got past findPageTarget with a
      // match instead of hitting "CDP target mismatch".
      assert.doesNotMatch(err.message, /CDP target mismatch/);
      return true;
    },
  );
});

// --- Fix 3: clip-size guard -------------------------------------------------

test("clipSizeError: a normal section/viewport-sized clip is within limits", () => {
  assert.equal(clipSizeError({ x: 0, y: 0, width: 1722, height: 955 }), null);
  assert.equal(clipSizeError({ x: 93, y: 500, width: 1536, height: 2000 }), null);
});

test("clipSizeError: rejects the exact pathological tailwindcss.com whole-page 'hero' clip", () => {
  // The real numbers observed live (see
  // reports/2026-07-13-canai-replicate-giant-hero-clip-hangs.md): a
  // single-wrapper page layout caused SECTIONS_JS to tag the whole page as
  // one "hero", 1722x11605 CSS px — the clip that hung Page.captureScreenshot
  // indefinitely. This pins that this exact shape is now refused.
  const err = clipSizeError({ x: 0, y: 0, width: 1722, height: 11605 });
  assert.match(err, /clip height 11605px exceeds/);
});

test("clipSizeError: rejects on width, height, and area independently", () => {
  assert.match(
    clipSizeError({ x: 0, y: 0, width: MAX_CLIP_WIDTH_PX + 1, height: 100 }),
    /clip width \d+px exceeds/,
  );
  assert.match(
    clipSizeError({ x: 0, y: 0, width: 100, height: MAX_CLIP_HEIGHT_PX + 1 }),
    /clip height \d+px exceeds/,
  );
  // Individually within width/height limits, but the product exceeds the
  // area cap — e.g. a wide-but-not-absurdly-tall clip.
  const w = MAX_CLIP_WIDTH_PX - 1;
  const h = Math.ceil(MAX_CLIP_AREA_PX2 / w) + 1;
  assert.ok(h <= MAX_CLIP_HEIGHT_PX, "test fixture must exercise the area check, not the height check");
  assert.match(clipSizeError({ x: 0, y: 0, width: w, height: h }), /clip area \d+px\^2/);
});

test("clipSizeError: rejects invalid/missing geometry without crashing", () => {
  assert.match(clipSizeError(null), /no clip geometry/);
  assert.match(clipSizeError({ x: 0, y: 0, width: 0, height: 100 }), /invalid clip dimensions/);
  assert.match(clipSizeError({ x: 0, y: 0, width: 100, height: -5 }), /invalid clip dimensions/);
});

test("captureNodeScreenshot: refuses an oversized clip before any network call (no fetch stub needed)", async () => {
  // Deliberately do NOT stub fetch — if the guard didn't run first, this
  // would instead fail with a real network error (ECONNREFUSED or similar),
  // proving the size check short-circuits before findPageTarget/listTargets.
  await assert.rejects(
    () =>
      captureNodeScreenshot({
        host: "127.0.0.1",
        port: 1, // reserved port, nothing listens here
        url: "https://tailwindcss.com/",
        clip: { x: 0, y: 0, width: 1722, height: 11605 },
        outPath: "/dev/null",
      }),
    /refusing to capture node screenshot: clip height 11605px exceeds/,
  );
});

// --- Fix 3: CDP command timeout --------------------------------------------

test("captureNodeScreenshot: a CDP command that never replies times out instead of hanging forever", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/fake" },
  ]);
  stubWebSocket(t, FakeSilentWebSocket);
  const started = Date.now();
  await assert.rejects(
    () =>
      captureNodeScreenshot({
        host: "127.0.0.1",
        port: 9223,
        url: "https://example.com/",
        clip: { x: 0, y: 0, width: 100, height: 100 },
        outPath: "/dev/null",
        timeoutMs: 40,
      }),
    /Page\.captureScreenshot timed out after 40ms waiting for a reply/,
  );
  assert.ok(Date.now() - started < 2000, "must reject promptly, not hang for the test run's own timeout");
});

test("setViewport: also honors the timeout (the whole CDPSession.send path, not just captureScreenshot)", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/fake" },
  ]);
  stubWebSocket(t, FakeSilentWebSocket);
  await assert.rejects(
    () =>
      setViewport({
        host: "127.0.0.1",
        port: 9223,
        url: "https://example.com/",
        width: 375,
        height: 812,
        timeoutMs: 40,
      }),
    /Emulation\.setDeviceMetricsOverride timed out after 40ms waiting for a reply/,
  );
});

// --- Fix 1a/Fix 2: full-page screenshot has its own size ceiling ----------
// (replaces agent-browser's own `screenshot --full`, which has neither a
// comparable guard nor a bounded timeout — see captureFullPageScreenshot's
// doc comment for the live crash/void evidence this exists to close.)

test("capFullPageHeight: within the cap, height passes through unchanged", () => {
  assert.deepEqual(capFullPageHeight(1440, 5000, 15000), {
    width: 1440,
    height: 5000,
    requestedHeight: 5000,
    capped: false,
  });
});

test("capFullPageHeight: above the cap, height is clamped and capped:true is reported", () => {
  // 62,816px is the real height captured live for smittenkitchen.com's
  // hot-dogs recipe post — see MAX_FULL_PAGE_HEIGHT_PX's doc comment.
  assert.deepEqual(capFullPageHeight(4800, 62816, 15000), {
    width: 4800,
    height: 15000,
    requestedHeight: 62816,
    capped: true,
  });
});

test("capFullPageHeight: exactly at the cap is NOT reported as capped", () => {
  const r = capFullPageHeight(1440, 15000, 15000);
  assert.equal(r.capped, false);
  assert.equal(r.height, 15000);
});

test("capFullPageHeight: uses MAX_FULL_PAGE_HEIGHT_PX by default when no override is given", () => {
  const r = capFullPageHeight(1440, MAX_FULL_PAGE_HEIGHT_PX + 1);
  assert.equal(r.capped, true);
  assert.equal(r.height, MAX_FULL_PAGE_HEIGHT_PX);
});

test("captureFullPageScreenshot: refuses an invalid page size before any network call", async () => {
  await assert.rejects(
    () =>
      captureFullPageScreenshot({
        host: "127.0.0.1",
        port: 1, // reserved port, nothing listens here
        url: "https://example.com/",
        width: 0,
        height: 5000,
        outPath: "/dev/null",
      }),
    /refusing to capture full-page screenshot: invalid page size 0x5000/,
  );
});

// Minimal fake WebSocket that records every command it's sent and replies
// with a trivial fake PNG payload — enough to prove WHAT clip geometry
// captureFullPageScreenshot actually asks CDP for, without a real browser.
function makeRecordingWebSocket(sent) {
  return class RecordingWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(data) {
      const msg = JSON.parse(data);
      sent.push(msg);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: msg.id,
              result: { data: Buffer.from("fake-png-bytes").toString("base64") },
            }),
          }),
        ),
      );
    }
    close() {}
  };
}

test("captureFullPageScreenshot: caps an oversized page's clip height instead of requesting the real (crash-prone) height", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/fake" },
  ]);
  const sent = [];
  stubWebSocket(t, makeRecordingWebSocket(sent));

  // 107,352px is the real height captured live for smittenkitchen.com's
  // crispy-spiced-lamb recipe post — the tallest of the pages this task's
  // repro evidence recorded.
  const result = await captureFullPageScreenshot({
    host: "127.0.0.1",
    port: 9223,
    url: "https://example.com/",
    width: 1440,
    height: 107352,
    outPath: "/dev/null",
    maxHeightPx: 15000,
  });

  assert.equal(result.capped, true);
  assert.equal(result.height, 15000);
  assert.equal(result.requestedHeight, 107352);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "Page.captureScreenshot");
  assert.equal(
    sent[0].params.clip.height,
    15000,
    "the CDP call itself must request the CAPPED height, never the real 107352px",
  );
  assert.equal(sent[0].params.captureBeyondViewport, true);
});

test("captureFullPageScreenshot: an ordinary page's height is requested as-is, not silently shrunk", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/fake" },
  ]);
  const sent = [];
  stubWebSocket(t, makeRecordingWebSocket(sent));

  const result = await captureFullPageScreenshot({
    host: "127.0.0.1",
    port: 9223,
    url: "https://example.com/",
    width: 1440,
    height: 4200,
    outPath: "/dev/null",
  });

  assert.equal(result.capped, false);
  assert.equal(sent[0].params.clip.height, 4200);
});

test("captureFullPageScreenshot: honors its own (longer) timeout — a CDP command that never replies rejects instead of hanging forever", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/fake" },
  ]);
  stubWebSocket(t, FakeSilentWebSocket);
  await assert.rejects(
    () =>
      captureFullPageScreenshot({
        host: "127.0.0.1",
        port: 9223,
        url: "https://example.com/",
        width: 1440,
        height: 20000,
        outPath: "/dev/null",
        timeoutMs: 40,
      }),
    /Page\.captureScreenshot timed out after 40ms waiting for a reply/,
  );
});

test("captureFullPageScreenshot: reuses the same target-mismatch guard as captureNodeScreenshot (shared findPageTarget)", async (t) => {
  stubFetch(t, [
    { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/example" },
  ]);
  await assert.rejects(
    () =>
      captureFullPageScreenshot({
        host: "127.0.0.1",
        port: 9223,
        url: "https://wpdev.xcloudzen.com/",
        width: 1440,
        height: 5000,
        outPath: "/dev/null",
      }),
    /CDP target mismatch/,
  );
});

// --- Fix 1a: cheap browser-reachability probe ------------------------------

test("isBrowserReachable: true when /json/version responds ok", async () => {
  const fetchImpl = async () => ({ ok: true });
  assert.equal(await isBrowserReachable({ host: "127.0.0.1", port: 9223 }, { fetchImpl }), true);
});

test("isBrowserReachable: false when fetch throws (the real 'browser is gone' shape — connection refused)", async () => {
  const fetchImpl = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:9223");
  };
  assert.equal(await isBrowserReachable({ host: "127.0.0.1", port: 9223 }, { fetchImpl }), false);
});

test("isBrowserReachable: false when the response itself is not ok", async () => {
  const fetchImpl = async () => ({ ok: false });
  assert.equal(await isBrowserReachable({}, { fetchImpl }), false);
});

test("isBrowserReachable: hits the expected /json/version URL with its own independent timeout signal", async () => {
  let seenUrl;
  let seenSignal;
  const fetchImpl = async (url, opts) => {
    seenUrl = url;
    seenSignal = opts.signal;
    return { ok: true };
  };
  await isBrowserReachable({ host: "127.0.0.1", port: 9224 }, { fetchImpl });
  assert.equal(seenUrl, "http://127.0.0.1:9224/json/version");
  assert.ok(seenSignal instanceof AbortSignal);
});

test("isBrowserReachable: defaults to 127.0.0.1:9223 when called with no args", async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return { ok: true };
  };
  await isBrowserReachable(undefined, { fetchImpl });
  assert.equal(seenUrl, "http://127.0.0.1:9223/json/version");
});
