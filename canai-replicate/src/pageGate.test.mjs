import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreViewport,
  evaluatePageGate,
  nextAttemptState,
  assertCanHandoff,
  DEFAULT_PAGE_GATE,
  severityScore,
  combinedSeverity,
  HEIGHT_WEIGHT,
  GATE_PRESETS,
  gatePresetFor,
  ADVISORY_MISMATCH_PCT,
} from "./pageGate.mjs";
import { severityScore as verifySeverityScore } from "./verify.mjs";

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
    stagnant: false,
    failReason: null,
  });
  assert.deepEqual(nextAttemptState({ attempts: 3, pass: false }), {
    attempts: 3,
    status: "fail",
    canRetry: false,
    canHandoff: false,
    stagnant: false,
    failReason: "max-attempts",
  });
  assert.deepEqual(nextAttemptState({ attempts: 2, pass: false }), {
    attempts: 2,
    status: "in-progress",
    canRetry: true,
    canHandoff: false,
    stagnant: false,
    failReason: null,
  });
});

test("nextAttemptState: stagnant severity → early fail (no retry)", () => {
  const r = nextAttemptState({
    attempts: 2,
    pass: false,
    previousSeverity: 80,
    currentSeverity: 79.5, // improved only 0.5 < default 1.0
  });
  assert.equal(r.status, "fail");
  assert.equal(r.stagnant, true);
  assert.equal(r.failReason, "stagnant");
  assert.equal(r.canRetry, false);
  assert.equal(r.canHandoff, false);
});

test("nextAttemptState: enough improvement → still in-progress", () => {
  const r = nextAttemptState({
    attempts: 2,
    pass: false,
    previousSeverity: 80,
    currentSeverity: 78.5, // improved 1.5 >= 1.0
  });
  assert.equal(r.status, "in-progress");
  assert.equal(r.canRetry, true);
  assert.equal(r.stagnant, false);
});

test("nextAttemptState: attempt 1 never stagnant (no previous)", () => {
  const r = nextAttemptState({
    attempts: 1,
    pass: false,
    previousSeverity: null,
    currentSeverity: 90,
  });
  assert.equal(r.status, "in-progress");
  assert.equal(r.stagnant, false);
});

test("assertCanHandoff throws unless status is pass", () => {
  assert.throws(() => assertCanHandoff({ status: "fail" }), /handoff/i);
  assert.doesNotThrow(() => assertCanHandoff({ status: "pass" }));
});

test("DEFAULT_PAGE_GATE matches policy (hard gate unchanged; stagnation added)", () => {
  assert.deepEqual(DEFAULT_PAGE_GATE, {
    maxMismatchPct: 15,
    maxHeightDeltaPct: 10,
    maxAttempts: 3,
    minSeverityImprovement: 1.0,
  });
});

test("combinedSeverity matches verify.mjs severityScore sum", () => {
  const desktop = { mismatchPct: 20, heightDeltaPct: 10 };
  const mobile = { mismatchPct: 30, heightDeltaPct: 5 };
  assert.equal(HEIGHT_WEIGHT, 0.3);
  assert.equal(severityScore(desktop), verifySeverityScore(desktop));
  assert.equal(
    combinedSeverity({ desktop, mobile }),
    verifySeverityScore(desktop) + verifySeverityScore(mobile),
  );
});

// --- objective presets --------------------------------------------------------

test("GATE_PRESETS.pixel is DEFAULT_PAGE_GATE and hard", () => {
  assert.equal(GATE_PRESETS.pixel.maxMismatchPct, DEFAULT_PAGE_GATE.maxMismatchPct);
  assert.equal(GATE_PRESETS.pixel.maxHeightDeltaPct, DEFAULT_PAGE_GATE.maxHeightDeltaPct);
  assert.equal(GATE_PRESETS.pixel.maxAttempts, DEFAULT_PAGE_GATE.maxAttempts);
  assert.equal(GATE_PRESETS.pixel.mode, "hard");
});

test("GATE_PRESETS.styled is advisory at 50/15, single attempt", () => {
  assert.equal(GATE_PRESETS.styled.maxMismatchPct, ADVISORY_MISMATCH_PCT);
  assert.equal(ADVISORY_MISMATCH_PCT, 50);
  assert.equal(GATE_PRESETS.styled.maxHeightDeltaPct, 15);
  assert.equal(GATE_PRESETS.styled.maxAttempts, 1);
  assert.equal(GATE_PRESETS.styled.mode, "advisory");
});

test("GATE_PRESETS.wireframe ignores mismatch entirely and gates height at 20", () => {
  const p = GATE_PRESETS.wireframe;
  assert.equal(p.mode, "height-only");
  assert.equal(p.maxHeightDeltaPct, 20);
  assert.equal(p.maxAttempts, 2);
  assert.equal(scoreViewport({ mismatchPct: 99, heightDeltaPct: 5 }, p).pass, true);
  assert.equal(scoreViewport({ mismatchPct: 1, heightDeltaPct: 20 }, p).pass, false);
});

test("gatePresetFor: structure has no pixel gate; unknown throws", () => {
  assert.equal(gatePresetFor("pixel"), GATE_PRESETS.pixel);
  assert.throws(() => gatePresetFor("structure"), /no verify-page gate preset for objective "structure"/);
  assert.throws(() => gatePresetFor("hifi"), /no verify-page gate preset/);
});
