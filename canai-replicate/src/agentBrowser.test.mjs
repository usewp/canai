import test from "node:test";
import assert from "node:assert/strict";
import { parseCdpUrl, resolveSessionCdpEndpoint, _clearSessionCdpEndpointCache } from "./agentBrowser.mjs";

test("parseCdpUrl: valid ws:// URL with a browser path (the real shape agent-browser prints)", () => {
  const { host, port } = parseCdpUrl(
    "ws://127.0.0.1:9225/devtools/browser/172268c1-f282-4136-93ec-2822c59f232f\n",
  );
  assert.equal(host, "127.0.0.1");
  assert.equal(port, 9225);
});

test("parseCdpUrl: accepts wss:// and non-loopback hostnames", () => {
  const { host, port } = parseCdpUrl("wss://example.internal:8443/devtools/browser/abc");
  assert.equal(host, "example.internal");
  assert.equal(port, 8443);
});

test("parseCdpUrl: falls back to the scheme's default port when the URL omits it", () => {
  // 443 is wss:'s default port, so the URL object reports port "" for it —
  // must not be mistaken for a missing/invalid port.
  assert.deepEqual(parseCdpUrl("wss://example.internal/devtools/browser/abc"), {
    host: "example.internal",
    port: 443,
  });
  assert.deepEqual(parseCdpUrl("ws://example.internal/devtools/browser/abc"), {
    host: "example.internal",
    port: 80,
  });
});

test("parseCdpUrl: trims surrounding whitespace/newlines", () => {
  const { host, port } = parseCdpUrl("   ws://localhost:9223/devtools/browser/x  \n");
  assert.equal(host, "localhost");
  assert.equal(port, 9223);
});

test("parseCdpUrl: throws a clear error on garbage input", () => {
  assert.throws(() => parseCdpUrl("not a url at all"), /agent-browser get cdp-url/);
});

test("parseCdpUrl: throws on empty output", () => {
  assert.throws(() => parseCdpUrl(""), /agent-browser get cdp-url/);
});

test("parseCdpUrl: throws on the wrong scheme (http, not ws/wss)", () => {
  assert.throws(() => parseCdpUrl("http://127.0.0.1:9223/json"), /ws:\/\/ or wss:\/\//);
});

test("resolveSessionCdpEndpoint: parses a successful run and memoizes it (shells out once, not per section)", () => {
  _clearSessionCdpEndpointCache();
  let calls = 0;
  const fakeRun = () => {
    calls += 1;
    return { status: 0, stdout: "ws://127.0.0.1:9225/devtools/browser/fake-id\n", stderr: "" };
  };
  const a = resolveSessionCdpEndpoint({ cdp: 9223, session: "personal" }, fakeRun);
  const b = resolveSessionCdpEndpoint({ cdp: 9223, session: "personal" }, fakeRun);
  const c = resolveSessionCdpEndpoint({ cdp: 9223, session: "personal" }, fakeRun);
  assert.deepEqual(a, { host: "127.0.0.1", port: 9225 });
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(calls, 1, "second and third calls for the same (cdp, session) must be cache hits");
});

test("resolveSessionCdpEndpoint: distinct (cdp, session) pairs are resolved and cached independently", () => {
  _clearSessionCdpEndpointCache();
  let calls = 0;
  const fakeRun = () => {
    calls += 1;
    return { status: 0, stdout: "ws://127.0.0.1:9225/devtools/browser/x\n", stderr: "" };
  };
  resolveSessionCdpEndpoint({ cdp: 9223, session: "personal" }, fakeRun);
  resolveSessionCdpEndpoint({ cdp: 9224, session: "personal" }, fakeRun); // different port
  resolveSessionCdpEndpoint({ cdp: 9223, session: "other" }, fakeRun); // different session
  resolveSessionCdpEndpoint({ cdp: 9223, session: "personal" }, fakeRun); // repeat of the first — cache hit
  assert.equal(calls, 3, "each distinct (cdp, session) key shells out exactly once");
});

test("resolveSessionCdpEndpoint: throws with stderr context when agent-browser exits non-zero", () => {
  _clearSessionCdpEndpointCache();
  const fakeRun = () => ({ status: 1, stdout: "", stderr: "no such session\n" });
  assert.throws(
    () => resolveSessionCdpEndpoint({ cdp: 9223, session: "ghost" }, fakeRun),
    /exited 1[\s\S]*no such session/,
  );
});

test("resolveSessionCdpEndpoint: throws when the process itself fails to spawn", () => {
  _clearSessionCdpEndpointCache();
  const fakeRun = () => ({ error: new Error("spawnSync agent-browser ENOENT"), status: null, stdout: "", stderr: "" });
  assert.throws(() => resolveSessionCdpEndpoint({ cdp: 9223, session: "x" }, fakeRun), /ENOENT/);
});

test("resolveSessionCdpEndpoint: wraps an unparseable cdp-url with session/port context", () => {
  _clearSessionCdpEndpointCache();
  const fakeRun = () => ({ status: 0, stdout: "garbage, not a url\n", stderr: "" });
  assert.throws(
    () => resolveSessionCdpEndpoint({ cdp: 9223, session: "personal" }, fakeRun),
    /could not resolve the real CDP endpoint for agent-browser session "personal" \(--cdp 9223\)/,
  );
});

test("resolveSessionCdpEndpoint: a signal-killed spawnSync names the signal, not just 'exited null' (Fix 5)", () => {
  _clearSessionCdpEndpointCache();
  // spawnSync's real shape when a process is killed by a signal: status is
  // null (not a normal exit code) and signal carries the killer's name.
  // Before the fix, the thrown message read "exited null: ..." with no
  // mention of the signal at all.
  const fakeRun = () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "hung, so we killed it" });
  assert.throws(
    () => resolveSessionCdpEndpoint({ cdp: 9223, session: "killed" }, fakeRun),
    /exited null \(killed by signal SIGTERM\): hung, so we killed it/,
  );
});

test("resolveSessionCdpEndpoint: a normal non-zero exit (no signal) still reads exactly as before — no stray '(killed by ...)'", () => {
  _clearSessionCdpEndpointCache();
  const fakeRun = () => ({ status: 1, signal: null, stdout: "", stderr: "no such session" });
  assert.throws(
    () => resolveSessionCdpEndpoint({ cdp: 9223, session: "ghost2" }, fakeRun),
    (err) => {
      assert.match(err.message, /exited 1: no such session/);
      assert.doesNotMatch(err.message, /killed by signal/);
      return true;
    },
  );
});

test("resolveSessionCdpEndpoint: a failed resolution is not cached — a later retry can still succeed", () => {
  _clearSessionCdpEndpointCache();
  let calls = 0;
  const fakeRun = () => {
    calls += 1;
    if (calls === 1) return { status: 1, stdout: "", stderr: "session not ready yet" };
    return { status: 0, stdout: "ws://127.0.0.1:9225/devtools/browser/x\n", stderr: "" };
  };
  assert.throws(() => resolveSessionCdpEndpoint({ cdp: 9223, session: "retry" }, fakeRun));
  const ok = resolveSessionCdpEndpoint({ cdp: 9223, session: "retry" }, fakeRun);
  assert.deepEqual(ok, { host: "127.0.0.1", port: 9225 });
  assert.equal(calls, 2, "the failed first attempt must not be cached");
});
