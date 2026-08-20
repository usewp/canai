import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "./pngSlice.mjs";
import { slice } from "./slice.mjs";

function solidPng(w, h, [r, g, b]) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return encodePngRgba(w, h, px);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "slice-"));
  const cap = path.join(root, "acme.test", "captures", "home");
  await mkdir(cap, { recursive: true });
  await writeFile(path.join(cap, "fullpage-desktop.png"), solidPng(1440, 400, [10, 20, 30]));
  await writeFile(path.join(cap, "fullpage-mobile.png"), solidPng(390, 300, [10, 20, 30]));
  await writeFile(
    path.join(cap, "sections-desktop.json"),
    JSON.stringify({ sections: [
      { id: "header", tag: "header", left: 0, top: 0, width: 1440, height: 100 },
      { id: "hero", tag: "section", left: 0, top: 100, width: 1440, height: 300 },
    ] }),
  );
  await writeFile(
    path.join(cap, "sections-mobile.json"),
    JSON.stringify({ sections: [{ id: "header", tag: "header", left: 0, top: 0, width: 390, height: 300 }] }),
  );
  return root;
}

test("slices both viewports and mirrors desktop into sections/", async () => {
  const root = await fixture();
  const r = await slice({ site: "acme.test", runsDir: root });
  assert.equal(r.ok, true);
  const base = path.join(root, "acme.test", "captures", "home");
  assert.deepEqual((await readdir(path.join(base, "sections-desktop"))).sort(), [
    "01-header.png",
    "02-hero.png",
  ]);
  assert.deepEqual(await readdir(path.join(base, "sections-mobile")), ["01-header.png"]);
  assert.deepEqual((await readdir(path.join(base, "sections"))).sort(), [
    "01-header.png",
    "02-hero.png",
  ]);
});

test("reports a capture with no full-page PNG instead of silently skipping", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slice-empty-"));
  await mkdir(path.join(root, "acme.test", "captures", "bare"), { recursive: true });
  const r = await slice({ site: "acme.test", runsDir: root });
  assert.equal(r.ok, false);
  assert.equal(r.count, 0);
});

test("--only restricts to one capture", async () => {
  const root = await fixture();
  const other = path.join(root, "acme.test", "captures", "about");
  await mkdir(other, { recursive: true });
  await writeFile(path.join(other, "fullpage-desktop.png"), solidPng(1440, 100, [1, 2, 3]));
  await writeFile(
    path.join(other, "sections-desktop.json"),
    JSON.stringify({ sections: [{ id: "header", tag: "header", left: 0, top: 0, width: 1440, height: 100 }] }),
  );
  const r = await slice({ site: "acme.test", runsDir: root, only: "home" });
  assert.ok(r.slices.every((s) => s.slug === "home"));
});

test("a stale sections dir is cleared, not merged into", async () => {
  const root = await fixture();
  const stale = path.join(root, "acme.test", "captures", "home", "sections-desktop");
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, "99-ghost.png"), solidPng(4, 4, [0, 0, 0]));
  await slice({ site: "acme.test", runsDir: root });
  const files = await readdir(stale);
  assert.ok(!files.includes("99-ghost.png"), "stale slice survived a re-slice");
});
