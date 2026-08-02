import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreViewport,
  evaluatePageGate,
  nextAttemptState,
  assertCanHandoff,
  DEFAULT_PAGE_GATE,
} from "./pageGate.mjs";

test("scoreViewport passes just under thresholds", () => {
  const r = scoreViewport({ mismatchPct: 14.9, heightDeltaPct: 9.9 });
  assert.equal(r.pass, true);
  assert.deepEqual(r.reasons, []);
});

test("scoreViewport fails on mismatch and height independently", () => {
  assert.equal(scoreViewport({ mismatchPct: 15, heightDeltaPct: 0 }).pass, false);
  assert.equal(scoreViewport({ mismatchPct: 0, heightDeltaPct: 10 }).pass, false);
});

test("evaluatePageGate requires BOTH widths to pass", () => {
  const ok = { mismatchPct: 1, heightDeltaPct: 1 };
  const bad = { mismatchPct: 20, heightDeltaPct: 1 };
  assert.equal(evaluatePageGate({ desktop: ok, mobile: ok }).pass, true);
  assert.equal(evaluatePageGate({ desktop: ok, mobile: bad }).pass, false);
});

test("nextAttemptState: pass → canHandoff; 3 fails → fail no retry", () => {
  assert.deepEqual(nextAttemptState({ attempts: 1, pass: true }), {
    attempts: 1,
    status: "pass",
    canRetry: false,
    canHandoff: true,
  });
  assert.deepEqual(nextAttemptState({ attempts: 3, pass: false }), {
    attempts: 3,
    status: "fail",
    canRetry: false,
    canHandoff: false,
  });
  assert.deepEqual(nextAttemptState({ attempts: 2, pass: false }), {
    attempts: 2,
    status: "in-progress",
    canRetry: true,
    canHandoff: false,
  });
});

test("assertCanHandoff throws unless status is pass", () => {
  assert.throws(() => assertCanHandoff({ status: "fail" }), /handoff/i);
  assert.doesNotThrow(() => assertCanHandoff({ status: "pass" }));
});

test("DEFAULT_PAGE_GATE matches spec", () => {
  assert.deepEqual(DEFAULT_PAGE_GATE, {
    maxMismatchPct: 15,
    maxHeightDeltaPct: 10,
    maxAttempts: 3,
  });
});
