export const DEFAULT_PAGE_GATE = {
  maxMismatchPct: 15,
  maxHeightDeltaPct: 10,
  maxAttempts: 3,
  /**
   * On a failed attempt after the first, combined severity (desktop+mobile)
   * must drop by at least this much vs the previous attempt — otherwise the
   * run fails early as stagnant. Prevents burning remaining attempts on the
   * same draft. Do not raise mismatch/height thresholds to "pass" a stuck
   * run; fix authoring instead (see reports/2026-08-02-page-mode-gate-policy.md).
   */
  minSeverityImprovement: 1.0,
};

/** Keep in sync with verify.mjs severityScore (HEIGHT_WEIGHT = 0.3). */
export const HEIGHT_WEIGHT = 0.3;

export function severityScore(r) {
  return Number(r.mismatchPct) + HEIGHT_WEIGHT * Number(r.heightDeltaPct);
}

export function combinedSeverity({ desktop, mobile }) {
  return severityScore(desktop) + severityScore(mobile);
}

export function scoreViewport(
  { mismatchPct, heightDeltaPct },
  {
    maxMismatchPct = DEFAULT_PAGE_GATE.maxMismatchPct,
    maxHeightDeltaPct = DEFAULT_PAGE_GATE.maxHeightDeltaPct,
  } = {},
) {
  const reasons = [];
  if (!(mismatchPct < maxMismatchPct)) {
    reasons.push(`mismatchPct ${mismatchPct} >= ${maxMismatchPct}`);
  }
  if (!(heightDeltaPct < maxHeightDeltaPct)) {
    reasons.push(`heightDeltaPct ${heightDeltaPct} >= ${maxHeightDeltaPct}`);
  }
  return { pass: reasons.length === 0, reasons };
}

export function evaluatePageGate({ desktop, mobile }, thresholds) {
  const d = scoreViewport(desktop, thresholds);
  const m = scoreViewport(mobile, thresholds);
  return {
    pass: d.pass && m.pass,
    desktop: d,
    mobile: m,
    reasons: [
      ...d.reasons.map((r) => `desktop: ${r}`),
      ...m.reasons.map((r) => `mobile: ${r}`),
    ],
  };
}

/**
 * Attempt bookkeeping for page-mode verify.
 *
 * @param {object} opts
 * @param {number} opts.attempts — 1-based attempt just completed
 * @param {boolean} opts.pass
 * @param {number} [opts.maxAttempts]
 * @param {number|null} [opts.previousSeverity] — combined severity of prior failed attempt
 * @param {number|null} [opts.currentSeverity] — combined severity of this attempt
 * @param {number} [opts.minSeverityImprovement]
 */
export function nextAttemptState({
  attempts,
  pass,
  maxAttempts = DEFAULT_PAGE_GATE.maxAttempts,
  previousSeverity = null,
  currentSeverity = null,
  minSeverityImprovement = DEFAULT_PAGE_GATE.minSeverityImprovement,
} = {}) {
  if (pass) {
    return {
      attempts,
      status: "pass",
      canRetry: false,
      canHandoff: true,
      stagnant: false,
      failReason: null,
    };
  }

  const stagnant =
    previousSeverity != null &&
    currentSeverity != null &&
    Number(previousSeverity) - Number(currentSeverity) < Number(minSeverityImprovement);

  // Stagnation only ends the run early while attempts remain; the final
  // attempt always records failReason "max-attempts".
  if (stagnant && attempts < maxAttempts) {
    return {
      attempts,
      status: "fail",
      canRetry: false,
      canHandoff: false,
      stagnant: true,
      failReason: "stagnant",
    };
  }

  if (attempts >= maxAttempts) {
    return {
      attempts,
      status: "fail",
      canRetry: false,
      canHandoff: false,
      stagnant: false,
      failReason: "max-attempts",
    };
  }

  return {
    attempts,
    status: "in-progress",
    canRetry: true,
    canHandoff: false,
    stagnant: false,
    failReason: null,
  };
}

export function assertCanHandoff(report) {
  if (!report || report.status !== "pass") {
    throw new Error(
      `handoff-page refused: page-report status is ${report?.status ?? "missing"} (need "pass")`,
    );
  }
}
