// One objective per run. `runs/<site>/run.json` records what the user asked
// for (structure / wireframe / styled / pixel) so every later stage —
// transform, verify, verify-page, handoff-page — selects its prompt and gate
// from one place instead of a per-command flag that a `--only` resume can
// forget. The CLI will refuse to transform/verify without this file (wired in
// a later task); library functions keep a default so tests and programmatic
// callers still work.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const OBJECTIVES = ["structure", "wireframe", "styled", "pixel"];
export const SCOPES = ["site", "page"];
export const DEFAULT_OBJECTIVE_BY_SCOPE = { site: "styled", page: "pixel" };

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
  return config;
}

export async function writeRunConfig(runDir, { objective, scope = "site", setBy = "user" } = {}) {
  assertObjective(objective);
  assertScope(scope);
  const previous = await readRunConfig(runDir);
  await mkdir(runDir, { recursive: true });
  const config = { objective, scope, setAt: new Date().toISOString(), setBy };
  await writeFile(runConfigPath(runDir), JSON.stringify(config, null, 2) + "\n");
  return { config, previous };
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
