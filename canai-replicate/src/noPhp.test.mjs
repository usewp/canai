import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";

// canai-replicate has zero PHP dependency, deliberately: its three jobs
// (DOM -> single-HTML with Tailwind/Alpine/Lucide, CONTENT-MODEL.md,
// DESIGN.md) never needed one, and Twig executes only on the live WordPress
// site. A stubbed local Twig harness re-implementing the plugin's Twig
// environment by hand drifted from the real thing and silently no-opped for
// every installed user. These guards keep it from creeping back.
const SRC_DIR = path.dirname(new URL(import.meta.url).pathname);

test("no production module shells out to php or references the deleted render harness", async () => {
  const modules = (await readdir(SRC_DIR)).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  const offenders = [];
  for (const file of modules) {
    const source = await readFile(path.join(SRC_DIR, file), "utf8");
    if (/\bphpBin\b|render-harness|spawn\(\s*["'`]php/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `these modules still reference PHP: ${offenders.join(", ")}`);
});

test("src/php/ does not exist", async () => {
  await assert.rejects(
    () => access(path.join(SRC_DIR, "php")),
    "src/php/ came back — canai-replicate must stay PHP-free",
  );
});
