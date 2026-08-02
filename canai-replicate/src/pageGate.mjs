export const DEFAULT_PAGE_GATE = {
  maxMismatchPct: 15,
  maxHeightDeltaPct: 10,
  maxAttempts: 3,
};

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

export function nextAttemptState({ attempts, pass, maxAttempts = DEFAULT_PAGE_GATE.maxAttempts }) {
  if (pass) {
    return { attempts, status: "pass", canRetry: false, canHandoff: true };
  }
  if (attempts >= maxAttempts) {
    return { attempts, status: "fail", canRetry: false, canHandoff: false };
  }
  return { attempts, status: "in-progress", canRetry: true, canHandoff: false };
}

export function assertCanHandoff(report) {
  if (!report || report.status !== "pass") {
    throw new Error(
      `handoff-page refused: page-report status is ${report?.status ?? "missing"} (need "pass")`,
    );
  }
}
