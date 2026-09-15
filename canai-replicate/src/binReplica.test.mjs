// Unit tests for bin/replica's pure exit-code/summary decision logic
// (Fix 1b: a stage that produced nothing must never report success — see
// .superpowers/sdd/dogfood-a1-report.md for the live "✓ 0/10 pages
// captured", exit code 0 bug this closes).
//
// bin/replica is a CLI entry point that calls main() unconditionally at
// import time UNLESS guarded — importing it here (rather than spawning it
// as a subprocess) is safe specifically because bin/replica now checks
// `import.meta.url` against the invoking script path before calling
// main()/process.exit(). The fact that this file's own tests run at all
// (instead of the whole `node --test` process dying the moment this file
// is loaded, mid-suite) is itself live proof that guard works — see
// bin/replica's own comment on that check for why an unguarded import would
// be catastrophic here.
//
// main() itself (argv parsing, wiring the five pipeline stages, spawning
// agent-browser) is deliberately NOT unit tested from this file — it needs
// a real site/browser and is proven live instead (this task's before/after
// capture repro against smittenkitchen.com). This file only pins the
// PURE decision logic: given a stage's result counts, what marker and
// pass/fail verdict does bin/replica report?

import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeCountOutcome,
  classifyProducedNothing,
  transformProducedNothing,
  resolveCapturePageUrl,
} from "../bin/replica";

// --- summarizeCountOutcome (capture, verify, discover) ---------------------

test("summarizeCountOutcome: full success — every entry succeeded", () => {
  const r = summarizeCountOutcome(10, 10);
  assert.equal(r.mark, "✓");
  assert.equal(r.failed, 0);
  assert.equal(r.failedSuffix, "");
  assert.equal(r.isTotalFailure, false);
});

test("summarizeCountOutcome: partial success stays a success (exit 0) but plainly shows the failure count", () => {
  const r = summarizeCountOutcome(8, 10);
  assert.equal(r.mark, "✓");
  assert.equal(r.failed, 2);
  assert.equal(r.failedSuffix, " (2 failed)");
  assert.equal(r.isTotalFailure, false);
});

test("summarizeCountOutcome: total failure — the exact dogfood shape (0/10) must report ✗, not ✓", () => {
  const r = summarizeCountOutcome(0, 10);
  assert.equal(r.mark, "✗", "a total failure must never print the ✓ the pre-fix CLI printed for 0/10");
  assert.equal(r.failed, 10);
  assert.equal(r.isTotalFailure, true);
});

test("summarizeCountOutcome: 0/0 (nothing attempted at all) is ALSO a total failure, not a vacuous success", () => {
  const r = summarizeCountOutcome(0, 0);
  assert.equal(r.mark, "✗");
  assert.equal(r.isTotalFailure, true);
});

test("summarizeCountOutcome: a full success never appends a '(0 failed)' suffix", () => {
  assert.equal(summarizeCountOutcome(5, 5).failedSuffix, "");
});

test("summarizeCountOutcome: a total failure never appends a redundant failedSuffix either (isTotalFailure already says it plainly)", () => {
  // failedSuffix is only meaningful for the PARTIAL case (✓ but some
  // failed) — a total failure's own ✗ mark and the caller's thrown error
  // already say "everything failed"; a "(10 failed)" suffix stapled onto a
  // ✗ line would be redundant, not clearer.
  assert.equal(summarizeCountOutcome(0, 10).failedSuffix, "");
});

// --- classifyProducedNothing ------------------------------------------------

test("classifyProducedNothing: 0 types but real one-off pages is a NORMAL, expected result — not a failure", () => {
  // Proven live in the dogfood run: smittenkitchen.com's mechanical classify
  // pass found 0 types, 23 one-off pages — a legitimate (if less powerful)
  // outcome, not something bin/replica should ever flag as broken.
  assert.equal(classifyProducedNothing(0, 23), false);
});

test("classifyProducedNothing: real types found, 0 one-off pages — also normal", () => {
  assert.equal(classifyProducedNothing(3, 0), false);
});

test("classifyProducedNothing: both zero — nothing to work with at all — IS a failure", () => {
  assert.equal(classifyProducedNothing(0, 0), true);
});

test("classifyProducedNothing: anything nonzero anywhere is never a failure", () => {
  assert.equal(classifyProducedNothing(1, 1), false);
});

// --- transformProducedNothing -----------------------------------------------

test("transformProducedNothing: 0 bundles and no chrome — nothing was produced at all", () => {
  assert.equal(transformProducedNothing(0, false), true);
});

test("transformProducedNothing: 0 page/type bundles is fine when chrome (header/footer) WAS produced (e.g. --only chrome)", () => {
  assert.equal(transformProducedNothing(0, true), false);
});

test("transformProducedNothing: any nonzero bundle count is never a failure, chrome or not", () => {
  assert.equal(transformProducedNothing(1, false), false);
  assert.equal(transformProducedNothing(5, true), false);
});

// --- resolveCapturePageUrl --------------------------------------------------

test("resolveCapturePageUrl: absent / null → null (full-site capture)", () => {
  assert.equal(resolveCapturePageUrl(undefined), null);
  assert.equal(resolveCapturePageUrl(null), null);
});

test("resolveCapturePageUrl: URL string → trimmed URL", () => {
  assert.equal(resolveCapturePageUrl("https://example.com/pricing/"), "https://example.com/pricing/");
  assert.equal(resolveCapturePageUrl("  https://example.com/a  "), "https://example.com/a");
});

test("resolveCapturePageUrl: bare --page (boolean true) fails loud", () => {
  assert.throws(() => resolveCapturePageUrl(true), /--page requires a URL|usage: capture/);
});

test("resolveCapturePageUrl: empty string fails loud", () => {
  assert.throws(() => resolveCapturePageUrl(""), /--page requires a URL|usage: capture/);
  assert.throws(() => resolveCapturePageUrl("   "), /--page requires a URL|usage: capture/);
});

// Regression: the CLI's switch cases were never executed by these tests —
// they only import the pure helpers above. That let a dangling
// `resolveAgentBrowser()` survive in verify-page-score after its import was
// removed in 4.0.0, so the command threw ReferenceError on every run while
// the suite stayed green. Dispatch every command with deliberately bad args:
// a usage/domain error is fine and expected, a ReferenceError/TypeError from
// a stale identifier is not.
test("every command dispatches without a dangling reference", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const bin = new URL("../bin/replica", import.meta.url).pathname;

  const COMMANDS = [
    ["discover"], ["classify", "x.test"], ["capture", "x.test"],
    ["slice", "x.test"], ["check", "x.test"], ["designmd", "x.test"],
    ["contentmodel", "x.test"], ["transform", "x.test"], ["pushprep", "x.test"],
    ["verify", "x.test"], ["verify-score", "x.test"], ["verify-structure", "x.test"],
    ["verify-page", "x.test", "--only", "p"],
    ["verify-page-score", "x.test", "--only", "p"],
    ["handoff-page", "x.test", "--only", "p"],
  ];

  for (const argv of COMMANDS) {
    let output = "";
    try {
      const r = await run(process.execPath, [bin, ...argv], { cwd: "/tmp" });
      output = r.stdout + r.stderr;
    } catch (e) {
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.doesNotMatch(
      output,
      /is not defined|is not a function|Cannot find module/,
      `\`replica ${argv.join(" ")}\` hit a stale identifier:\n${output}`,
    );
  }
});

// Task 6 fix-loop finding: verify-page-score's gate preset comes from
// run.json (pixel hard / styled advisory / wireframe height-only), so the
// CLI — like verify-structure — must refuse to run without one, the same way
// `replica objective <site>` does (see runConfig.test.mjs's CLI tests).
test("CLI: verify-page-score without run.json exits non-zero and names the objective command", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const run = promisify(execFile);
  const bin = new URL("../bin/replica", import.meta.url).pathname;

  const root = await mkdtemp(path.join(tmpdir(), "verify-page-score-cli-"));
  const runs = path.join(root, "runs");
  // The run directory exists (e.g. capture already ran) but run.json doesn't.
  await mkdir(path.join(runs, "example.com"), { recursive: true });
  try {
    await assert.rejects(
      run(process.execPath, [bin, "verify-page-score", "example.com", "--only", "p", "--runs", runs]),
      (e) =>
        e.code === 1 &&
        /run\.json not found/.test(e.stderr) &&
        /--set <structure\|wireframe\|styled\|pixel>/.test(e.stderr),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
