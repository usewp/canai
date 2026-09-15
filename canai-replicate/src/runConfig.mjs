// One objective per run. `runs/<site>/run.json` records what the user asked
// for (structure / wireframe / styled / pixel) so every later stage —
// transform, verify-structure, verify-page-score, handoff-page — selects its
// prompt and gate from one place instead of a per-command flag that a `--only`
// resume can forget. The CLI refuses to run those four without this file
// (`requireRunConfig` in bin/replica); library functions keep a default so
// tests and programmatic callers still work.

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const OBJECTIVES = ["structure", "wireframe", "styled", "pixel"];
export const SCOPES = ["site", "page"];
export const DEFAULT_OBJECTIVE_BY_SCOPE = { site: "styled", page: "pixel" };
export const CHROME_MODES = ["inline", "skip"];

export function runConfigPath(runDir) {
  return path.join(runDir, "run.json");
}

export function assertObjective(value) {
  if (!OBJECTIVES.includes(value)) {
    throw new Error(`invalid objective "${value}" — expected one of: ${OBJECTIVES.join(", ")}`);
  }
  return value;
}

function assertScope(value) {
  if (!SCOPES.includes(value)) {
    throw new Error(`invalid scope "${value}" — expected one of: ${SCOPES.join(", ")}`);
  }
  return value;
}

// "skip" only ever makes sense for the pixel objective — verify-page's crop
// gate and handoff's <main>-only wrap both depend on the draft having no
// inline chrome, which is a pixel-only authoring mode (see transform.mjs's
// INLINE_CHROME_OBJECTIVES).
function assertChrome(value, objective) {
  if (!CHROME_MODES.includes(value)) {
    throw new Error(`invalid chrome "${value}" — expected one of: ${CHROME_MODES.join(", ")}`);
  }
  if (value === "skip" && objective !== "pixel") {
    throw new Error(`chrome "skip" is only valid for the pixel objective (run.json objective is "${objective}")`);
  }
  return value;
}

/** null ONLY when the file is absent; malformed content or a bad objective throws. */
export async function readRunConfig(runDir) {
  let raw;
  try {
    raw = await readFile(runConfigPath(runDir), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${runConfigPath(runDir)}: invalid JSON — ${e.message}`);
  }
  assertObjective(config.objective);
  config.chrome = assertChrome(config.chrome ?? "inline", config.objective);
  return config;
}

export async function writeRunConfig(runDir, { objective, scope = "site", chrome = "inline", setBy = "user" } = {}) {
  assertObjective(objective);
  assertScope(scope);
  assertChrome(chrome, objective);
  const previous = await readRunConfig(runDir);
  await mkdir(runDir, { recursive: true });
  const config = { objective, scope, chrome, setAt: new Date().toISOString(), setBy };
  await writeFile(runConfigPath(runDir), JSON.stringify(config, null, 2) + "\n");
  return { config, previous };
}

/**
 * Drop verify-page's attempt history for a run: every
 * output/pages/*.page-mode.json plus verify/page-report.{md,json}. The
 * history belongs to one objective+chrome — a wireframe's two height-only
 * attempts must not count against the pixel run that follows, and a stale
 * wireframe/styled page-report must not be what handoff-page reads. Drafts,
 * the .page-mode.static.html backup and every other report stay put.
 * @returns {Promise<string[]>} run-relative paths removed (sorted), [] when none
 */
export async function resetPageAttempts(runDir) {
  const removed = [];
  const pagesDir = path.join(runDir, "output", "pages");
  let pageFiles = [];
  try {
    pageFiles = await readdir(pagesDir);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
  const targets = [
    ...pageFiles.filter((f) => f.endsWith(".page-mode.json")).map((f) => path.join("output", "pages", f)),
    path.join("verify", "page-report.json"),
    path.join("verify", "page-report.md"),
  ];
  for (const rel of targets) {
    const abs = path.join(runDir, rel);
    try {
      await rm(abs);
      removed.push(rel);
    } catch (e) {
      if (!(e && e.code === "ENOENT")) throw e;
    }
  }
  return removed.sort();
}

export async function requireRunConfig(runDir, { site } = {}) {
  const config = await readRunConfig(runDir);
  if (config) return config;
  throw new Error(
    `${runConfigPath(runDir)} not found — record the objective first: ` +
      `replica objective ${site ?? "<site>"} --set <${OBJECTIVES.join("|")}> [--scope site|page]`,
  );
}

/**
 * `--page-mode` is a back-compat alias for objective "pixel". run.json wins
 * when present; the flag may only agree with it. With neither, `fallback`.
 */
export function resolveObjective({ runConfig = null, pageModeFlag = false, fallback = null } = {}) {
  if (runConfig && pageModeFlag && runConfig.objective !== "pixel") {
    throw new Error(
      `--page-mode contradicts run.json objective "${runConfig.objective}" — drop the flag, ` +
        `or re-run: replica objective <site> --set pixel`,
    );
  }
  if (runConfig) return runConfig.objective;
  if (pageModeFlag) return "pixel";
  return fallback;
}
