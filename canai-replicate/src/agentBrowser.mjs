// Resolve how to invoke `agent-browser`. Prefer the binary on PATH; fall back
// to `npx -y agent-browser` so the user doesn't need a global install.
// Detection runs once per process and is shared by capture.mjs and verify.mjs.

import { spawn, spawnSync } from "node:child_process";

let resolved = null; // { command: string, prefixArgs: string[] }

function probe(command, args) {
  const r = spawnSync(command, args, { stdio: "ignore", timeout: 60_000 });
  return !r.error && r.status !== null;
}

const INSTALL_HINT =
  "agent-browser is required but was not found on PATH, and `npx` is also unavailable.\n\n" +
  "Install one of these ways:\n" +
  "  • Global (recommended):  npm i -g agent-browser\n" +
  "  • Project-local:         npm i agent-browser  (then run inside that project)\n" +
  "  • Ensure `npx` is on PATH so it can fetch it on demand.\n";

export function resolveAgentBrowser() {
  if (resolved) return resolved;

  if (probe("agent-browser", ["--help"])) {
    resolved = { command: "agent-browser", prefixArgs: [], via: "binary" };
    return resolved;
  }

  if (probe("npx", ["--version"])) {
    resolved = { command: "npx", prefixArgs: ["-y", "agent-browser"], via: "npx" };
    return resolved;
  }

  throw new Error(INSTALL_HINT);
}

export function spawnAgentBrowser(args, options = {}) {
  const { command, prefixArgs } = resolveAgentBrowser();
  return spawn(command, [...prefixArgs, ...args], options);
}

// --- Resolving the real CDP endpoint behind an agent-browser session -----
//
// `capture.mjs` takes per-section screenshots by talking raw CDP directly
// (src/cdp.mjs), bypassing agent-browser for that one operation because
// agent-browser's own `screenshot <selector>` returns blank images for
// elements below the fold. That raw-CDP path has to connect to the exact
// same browser agent-browser's `--session <name>` is driving — but a named
// session is not guaranteed to be bound to the `--cdp <port>` passed on this
// invocation. agent-browser sessions are long-lived daemons: the *first*
// time a session name is used it attaches to whatever `--cdp` port it was
// given, but every later invocation with that same session name keeps using
// whatever browser it originally attached to, silently ignoring a different
// `--cdp` value. On a machine with more than one Chrome instance running
// (exactly this workspace's setup), a pre-existing session can easily be
// bound to a different port than the one you assume — and raw CDP calls
// against the assumed port then land on some unrelated, never-navigated
// browser. `agent-browser get cdp-url` reports the browser its session is
// *actually* attached to; that's what raw-CDP callers must use instead of
// trusting `--cdp` at face value.
const endpointCache = new Map(); // `${cdp}::${session}` -> { host, port }

// Parse the `ws://host:port/devtools/browser/<id>` line `agent-browser ...
// get cdp-url` prints into `{ host, port }`. Pure and synchronous so it's
// unit-testable without a real agent-browser process.
export function parseCdpUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `expected a WebSocket URL from \`agent-browser get cdp-url\`, got: ${JSON.stringify(trimmed)}`,
    );
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `expected a ws:// or wss:// URL from \`agent-browser get cdp-url\`, got: ${JSON.stringify(trimmed)}`,
    );
  }
  // WHATWG URL never produces an empty hostname for a special scheme like
  // ws:/wss: (an authority-less URL fails to parse at all, caught above), but
  // .port comes back "" whenever the URL omits the port because it matches
  // the scheme's default (80 for ws:, 443 for wss:) — fall back to that
  // default rather than treating it as missing.
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "wss:" ? 443 : 80;
  return { host: parsed.hostname, port };
}

function defaultRunSync(command, args) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
}

// Ask agent-browser which browser its `session` is really attached to, and
// return that browser's CDP `{ host, port }` — which may or may not be the
// `cdp` port the caller assumed. Memoized per (cdp, session) for the life of
// the process: this shells out to agent-browser at most once per run, not
// once per section/page.
//
// `runSync` is an injection seam for tests (default: real spawnSync against
// agent-browser); production callers should never need to pass it.
export function resolveSessionCdpEndpoint({ cdp, session }, runSync = defaultRunSync) {
  const key = `${cdp}::${session}`;
  if (endpointCache.has(key)) return endpointCache.get(key);

  const { command, prefixArgs } = resolveAgentBrowser();
  const args = [...prefixArgs, "--cdp", String(cdp), "--session", session, "get", "cdp-url"];
  const result = runSync(command, args);

  if (result.error) {
    throw new Error(
      `could not run \`agent-browser --cdp ${cdp} --session ${session} get cdp-url\`: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    // A signal-killed spawnSync reports status: null and signal: "SIGTERM"
    // (or similar) — without this, the message below reads "exited null"
    // with no hint that the process was killed, not merely non-zero-exited.
    const signalNote = result.signal ? ` (killed by signal ${result.signal})` : "";
    throw new Error(
      `\`agent-browser --cdp ${cdp} --session ${session} get cdp-url\` exited ${result.status}${signalNote}: ` +
        `${(result.stderr || result.stdout || "").trim()}`,
    );
  }

  let endpoint;
  try {
    endpoint = parseCdpUrl(result.stdout);
  } catch (e) {
    throw new Error(
      `could not resolve the real CDP endpoint for agent-browser session "${session}" (--cdp ${cdp}): ${e.message}`,
    );
  }
  endpointCache.set(key, endpoint);
  return endpoint;
}

// Test-only: forget memoized endpoints so tests don't leak state into each
// other via the shared module-level cache.
export function _clearSessionCdpEndpointCache() {
  endpointCache.clear();
}
