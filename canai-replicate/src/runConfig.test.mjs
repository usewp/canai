import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  OBJECTIVES,
  CHROME_MODES,
  assertObjective,
  readRunConfig,
  writeRunConfig,
  requireRunConfig,
  resolveObjective,
  runConfigPath,
  resetPageAttempts,
} from "./runConfig.mjs";

const execFileP = promisify(execFile);
const BIN = path.resolve(new URL("..", import.meta.url).pathname, "bin/replica");

async function tmpRun() {
  const root = await mkdtemp(path.join(tmpdir(), "runconfig-test-"));
  const runDir = path.join(root, "runs", "example.com");
  await mkdir(runDir, { recursive: true });
  return { root, runDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("OBJECTIVES is exactly the four ladder levels", () => {
  assert.deepEqual(OBJECTIVES, ["structure", "wireframe", "styled", "pixel"]);
});

test("assertObjective rejects anything outside the ladder", () => {
  assert.equal(assertObjective("pixel"), "pixel");
  assert.throws(() => assertObjective("hifi"), /invalid objective "hifi"/);
  assert.throws(() => assertObjective(undefined), /invalid objective/);
});

test("readRunConfig returns null when run.json is absent", async () => {
  const { runDir, cleanup } = await tmpRun();
  try {
    assert.equal(await readRunConfig(runDir), null);
  } finally {
    await cleanup();
  }
});

test("readRunConfig throws on malformed JSON or a bad objective (never silently null)", async () => {
  const { runDir, cleanup } = await tmpRun();
  try {
    await writeFile(runConfigPath(runDir), "{ nope");
    await assert.rejects(readRunConfig(runDir));
    await writeFile(runConfigPath(runDir), JSON.stringify({ objective: "hifi", scope: "page" }));
    await assert.rejects(readRunConfig(runDir), /invalid objective "hifi"/);
  } finally {
    await cleanup();
  }
});

test("writeRunConfig writes objective/scope/setAt/setBy and reports the previous value", async () => {
  const { runDir, cleanup } = await tmpRun();
  try {
    const first = await writeRunConfig(runDir, { objective: "wireframe", scope: "page" });
    assert.equal(first.previous, null);
    assert.equal(first.config.objective, "wireframe");
    assert.equal(first.config.scope, "page");
    assert.equal(first.config.setBy, "user");
    assert.match(first.config.setAt, /^\d{4}-\d{2}-\d{2}T/);
    const onDisk = JSON.parse(await readFile(runConfigPath(runDir), "utf8"));
    assert.equal(onDisk.objective, "wireframe");

    const second = await writeRunConfig(runDir, { objective: "pixel" });
    assert.equal(second.previous.objective, "wireframe");
    assert.equal(second.config.scope, "site");
  } finally {
    await cleanup();
  }
});

test("writeRunConfig rejects a bad scope", async () => {
  const { runDir, cleanup } = await tmpRun();
  try {
    await assert.rejects(writeRunConfig(runDir, { objective: "pixel", scope: "world" }), /invalid scope "world"/);
  } finally {
    await cleanup();
  }
});

test("requireRunConfig names the objective command when run.json is missing", async () => {
  const { runDir, cleanup } = await tmpRun();
  try {
    await assert.rejects(
      requireRunConfig(runDir, { site: "example.com" }),
      /replica objective example\.com --set <structure\|wireframe\|styled\|pixel>/,
    );
  } finally {
    await cleanup();
  }
});

test("resolveObjective: run.json wins; --page-mode alone means pixel; contradiction throws", () => {
  assert.equal(resolveObjective({ runConfig: { objective: "styled" } }), "styled");
  assert.equal(resolveObjective({ runConfig: null, pageModeFlag: true }), "pixel");
  assert.equal(resolveObjective({ runConfig: null, fallback: "styled" }), "styled");
  assert.equal(resolveObjective({ runConfig: { objective: "pixel" }, pageModeFlag: true }), "pixel");
  assert.throws(
    () => resolveObjective({ runConfig: { objective: "wireframe" }, pageModeFlag: true }),
    /--page-mode contradicts run\.json objective "wireframe"/,
  );
});

test("CLI: `replica objective <site> --set` writes run.json and prints it back", async () => {
  const { root, runDir, cleanup } = await tmpRun();
  try {
    const runs = path.join(root, "runs");
    const set = await execFileP("node", [BIN, "objective", "example.com", "--set", "wireframe", "--scope", "page", "--runs", runs]);
    assert.match(set.stderr, /objective=wireframe scope=page/);
    const onDisk = JSON.parse(await readFile(runConfigPath(runDir), "utf8"));
    assert.equal(onDisk.objective, "wireframe");

    const show = await execFileP("node", [BIN, "objective", "example.com", "--runs", runs]);
    assert.match(show.stderr, /objective=wireframe scope=page/);
  } finally {
    await cleanup();
  }
});

test("CLI: `replica objective <site>` with no run.json exits non-zero and lists the four values", async () => {
  const { root, cleanup } = await tmpRun();
  try {
    await assert.rejects(
      execFileP("node", [BIN, "objective", "example.com", "--runs", path.join(root, "runs")]),
      (e) => /structure\|wireframe\|styled\|pixel/.test(e.stderr) && e.code === 1,
    );
  } finally {
    await cleanup();
  }
});

test("CLI: `replica capture <site> --page <url>` seeds run.json (objective=pixel, scope=page) when absent", async () => {
  const { root, runDir, cleanup } = await tmpRun();
  try {
    const runs = path.join(root, "runs");
    const r = await execFileP("node", [
      BIN,
      "capture",
      "example.com",
      "--page",
      "https://example.com/pricing",
      "--runs",
      runs,
    ]);
    assert.match(r.stderr, /run\.json seeded: objective=pixel scope=page/);
    const onDisk = JSON.parse(await readFile(runConfigPath(runDir), "utf8"));
    assert.equal(onDisk.objective, "pixel");
    assert.equal(onDisk.scope, "page");
    assert.equal(onDisk.setBy, "capture-page");
  } finally {
    await cleanup();
  }
});

test("run.json chrome: defaults to inline, accepts skip only for pixel", async () => {
  const { runDir, cleanup } = await tmpRun();
  try {
    assert.deepEqual(CHROME_MODES, ["inline", "skip"]);
    const a = await writeRunConfig(runDir, { objective: "pixel", scope: "page" });
    assert.equal(a.config.chrome, "inline");
    const b = await writeRunConfig(runDir, { objective: "pixel", scope: "page", chrome: "skip" });
    assert.equal(b.config.chrome, "skip");
    await assert.rejects(writeRunConfig(runDir, { objective: "styled", chrome: "skip" }), /chrome "skip" is only valid for the pixel objective/);
    await assert.rejects(writeRunConfig(runDir, { objective: "pixel", chrome: "sometimes" }), /invalid chrome "sometimes"/);
    await writeFile(runConfigPath(runDir), JSON.stringify({ objective: "pixel", scope: "page" }));
    assert.equal((await readRunConfig(runDir)).chrome, "inline", "legacy run.json without chrome reads as inline");
  } finally {
    await cleanup();
  }
});

test("CLI: `replica capture <site> --page <url>` leaves an existing run.json untouched", async () => {
  const { root, runDir, cleanup } = await tmpRun();
  try {
    const runs = path.join(root, "runs");
    await writeRunConfig(runDir, { objective: "styled", scope: "site" });
    const r = await execFileP("node", [
      BIN,
      "capture",
      "example.com",
      "--page",
      "https://example.com/pricing",
      "--runs",
      runs,
    ]);
    assert.doesNotMatch(r.stderr, /run\.json seeded/);
    const onDisk = JSON.parse(await readFile(runConfigPath(runDir), "utf8"));
    assert.equal(onDisk.objective, "styled");
    assert.equal(onDisk.scope, "site");
    assert.equal(onDisk.setBy, "user");
  } finally {
    await cleanup();
  }
});

// --- attempt-history reset on objective/chrome change (dogfood bug 2) ------
// verify-page's attempt history (output/pages/*.page-mode.json) and the last
// page-report belong to ONE objective+chrome: a wireframe's two height-only
// attempts must not count against the pixel run that follows it, and a stale
// wireframe page-report must not sit around for handoff-page to trip over.

async function seedAttemptHistory(runDir) {
  await mkdir(path.join(runDir, "output", "pages"), { recursive: true });
  await mkdir(path.join(runDir, "verify"), { recursive: true });
  await writeFile(path.join(runDir, "output", "pages", "about.page-mode.json"), JSON.stringify({ attempts: 2 }));
  await writeFile(path.join(runDir, "output", "pages", "pricing.page-mode.json"), JSON.stringify({ attempts: 1 }));
  await writeFile(path.join(runDir, "output", "pages", "about.html"), "<html></html>");
  await writeFile(path.join(runDir, "output", "pages", "about.page-mode.static.html"), "<html></html>");
  await writeFile(path.join(runDir, "verify", "page-report.json"), "{}");
  await writeFile(path.join(runDir, "verify", "page-report.md"), "# r");
  await writeFile(path.join(runDir, "verify", "structure-report.json"), "{}");
}

async function missing(p) {
  try {
    await access(p);
    return false;
  } catch {
    return true;
  }
}

test("resetPageAttempts removes every *.page-mode.json and verify/page-report.{md,json}, nothing else, and lists what it removed", async () => {
  const { runDir, cleanup } = await tmpRun();
  try {
    await seedAttemptHistory(runDir);
    const removed = await resetPageAttempts(runDir);
    assert.deepEqual(removed.sort(), [
      "output/pages/about.page-mode.json",
      "output/pages/pricing.page-mode.json",
      "verify/page-report.json",
      "verify/page-report.md",
    ]);
    for (const rel of removed) assert.ok(await missing(path.join(runDir, rel)), rel);
    // Drafts, the static backup and other reports are untouched.
    await access(path.join(runDir, "output", "pages", "about.html"));
    await access(path.join(runDir, "output", "pages", "about.page-mode.static.html"));
    await access(path.join(runDir, "verify", "structure-report.json"));
    // Idempotent and quiet on a run with nothing to reset.
    assert.deepEqual(await resetPageAttempts(runDir), []);
  } finally {
    await cleanup();
  }
});

test("CLI: `replica objective --set` with a CHANGED objective resets the attempt history and says so", async () => {
  const { root, runDir, cleanup } = await tmpRun();
  try {
    const runs = path.join(root, "runs");
    await writeRunConfig(runDir, { objective: "wireframe", scope: "page" });
    await seedAttemptHistory(runDir);
    const r = await execFileP("node", [BIN, "objective", "example.com", "--set", "pixel", "--runs", runs]);
    assert.match(r.stderr, /objective=pixel scope=site chrome=inline \(was wireframe\/page\/inline\)/);
    assert.match(r.stderr, /attempt history reset \(objective wireframe → pixel\): output\/pages\/about\.page-mode\.json, output\/pages\/pricing\.page-mode\.json, verify\/page-report\.json, verify\/page-report\.md/);
    assert.ok(await missing(path.join(runDir, "output", "pages", "about.page-mode.json")));
    assert.ok(await missing(path.join(runDir, "verify", "page-report.json")));
    await access(path.join(runDir, "output", "pages", "about.html"));
  } finally {
    await cleanup();
  }
});

test("CLI: `replica objective --set` with a CHANGED chrome (same objective) also resets", async () => {
  const { root, runDir, cleanup } = await tmpRun();
  try {
    const runs = path.join(root, "runs");
    await writeRunConfig(runDir, { objective: "pixel", scope: "page", chrome: "inline" });
    await seedAttemptHistory(runDir);
    const r = await execFileP("node", [BIN, "objective", "example.com", "--set", "pixel", "--scope", "page", "--chrome", "skip", "--runs", runs]);
    assert.match(r.stderr, /attempt history reset \(chrome inline → skip\)/);
    assert.ok(await missing(path.join(runDir, "output", "pages", "about.page-mode.json")));
  } finally {
    await cleanup();
  }
});

test("CLI: `replica objective --set` with the SAME objective and chrome keeps the attempt history", async () => {
  const { root, runDir, cleanup } = await tmpRun();
  try {
    const runs = path.join(root, "runs");
    await writeRunConfig(runDir, { objective: "pixel", scope: "page" });
    await seedAttemptHistory(runDir);
    // Scope changes alone do not touch the history — only objective/chrome do.
    const r = await execFileP("node", [BIN, "objective", "example.com", "--set", "pixel", "--scope", "site", "--runs", runs]);
    assert.doesNotMatch(r.stderr, /attempt history reset/);
    await access(path.join(runDir, "output", "pages", "about.page-mode.json"));
    await access(path.join(runDir, "verify", "page-report.json"));
  } finally {
    await cleanup();
  }
});

test("CLI: first `replica objective --set` (no previous run.json) never prints a reset line", async () => {
  const { root, runDir, cleanup } = await tmpRun();
  try {
    const runs = path.join(root, "runs");
    await seedAttemptHistory(runDir);
    const r = await execFileP("node", [BIN, "objective", "example.com", "--set", "pixel", "--runs", runs]);
    assert.doesNotMatch(r.stderr, /attempt history reset/);
    await access(path.join(runDir, "output", "pages", "about.page-mode.json"));
  } finally {
    await cleanup();
  }
});
