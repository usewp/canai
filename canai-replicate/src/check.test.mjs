import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePngRgba } from "./pngSlice.mjs";
import { checkCapture, check } from "./check.mjs";

function png(w, h, fill) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = fill(i / 4);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return encodePngRgba(w, h, px);
}
// The exact blank this refactor was built to catch: agent-browser's
// below-the-fold element screenshot came back as solid #f8f9fa.
const uniform = (w, h) => png(w, h, () => [248, 249, 250]);
const varied = (w, h) => png(w, h, (i) => [i % 256, (i * 7) % 256, (i * 13) % 256]);

async function goodCapture() {
  const dir = await mkdtemp(path.join(tmpdir(), "check-"));
  await writeFile(
    path.join(dir, "content.json"),
    JSON.stringify({ main: [{ id: "hero", headings: ["Hi"] }] }),
  );
  await writeFile(
    path.join(dir, "sections.json"),
    JSON.stringify({ sections: [{ id: "hero", file: "sections/01-hero.png" }] }),
  );
  await mkdir(path.join(dir, "sections"), { recursive: true });
  await writeFile(path.join(dir, "sections", "01-hero.png"), varied(40, 20));
  await writeFile(
    path.join(dir, "styles.json"),
    JSON.stringify({ desktop: { roles: { body: {} } }, mobile: { roles: { body: {} } } }),
  );
  await writeFile(path.join(dir, "assets.json"), JSON.stringify({ images: [] }));
  await writeFile(path.join(dir, "ux.json"), JSON.stringify([]));
  await writeFile(path.join(dir, "dom.html"), "<html></html>");
  return dir;
}

test("a complete capture passes clean", async () => {
  const r = await checkCapture(await goodCapture(), {});
  assert.deepEqual(r.errors, []);
});

test("crash debris fails on missing content.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "check-debris-"));
  const r = await checkCapture(dir, {});
  assert.ok(
    r.errors.some((e) => /content\.json/.test(e)),
    r.errors.join("; "),
  );
});

test("a uniform-colour PNG is reported blank, not accepted", async () => {
  const dir = await goodCapture();
  await writeFile(path.join(dir, "sections", "01-hero.png"), uniform(116, 27));
  const r = await checkCapture(dir, {});
  assert.ok(
    r.errors.some((e) => /blank/.test(e)),
    r.errors.join("; "),
  );
});

test("empty main warns but does not fail", async () => {
  const dir = await goodCapture();
  await writeFile(path.join(dir, "content.json"), JSON.stringify({ main: [] }));
  const r = await checkCapture(dir, {});
  assert.deepEqual(r.errors, []);
  assert.ok(
    r.warnings.some((w) => /main/.test(w)),
    r.warnings.join("; "),
  );
});

test("styles.json missing a viewport fails", async () => {
  const dir = await goodCapture();
  await writeFile(
    path.join(dir, "styles.json"),
    JSON.stringify({ desktop: { roles: { body: {} } } }),
  );
  const r = await checkCapture(dir, {});
  assert.ok(
    r.errors.some((e) => /mobile/.test(e)),
    r.errors.join("; "),
  );
});

test("an empty required file fails as loudly as a missing one", async () => {
  const dir = await goodCapture();
  await writeFile(path.join(dir, "dom.html"), "");
  const r = await checkCapture(dir, {});
  assert.ok(
    r.errors.some((e) => /dom\.html/.test(e)),
    r.errors.join("; "),
  );
});

test("a referenced section PNG that is missing from disk fails", async () => {
  const dir = await goodCapture();
  await rm(path.join(dir, "sections", "01-hero.png"));
  const r = await checkCapture(dir, {});
  assert.ok(
    r.errors.some((e) => /01-hero\.png/.test(e)),
    r.errors.join("; "),
  );
});

test("check() rolls up per-capture results and is not ok when any fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "check-site-"));
  const caps = path.join(root, "acme.test", "captures");
  await mkdir(path.join(caps, "broken"), { recursive: true });
  const good = await goodCapture();
  await mkdir(path.join(caps, "home"), { recursive: true });
  for (const f of ["content.json", "sections.json", "styles.json", "assets.json", "ux.json", "dom.html"]) {
    await writeFile(
      path.join(caps, "home", f),
      await (await import("node:fs/promises")).readFile(path.join(good, f), "utf8"),
    );
  }
  await mkdir(path.join(caps, "home", "sections"), { recursive: true });
  await writeFile(path.join(caps, "home", "sections", "01-hero.png"), varied(40, 20));

  const r = await check({ site: "acme.test", runsDir: root });
  assert.equal(r.ok, false);
  assert.equal(r.count, 1, "one clean capture");
  assert.equal(r.results.length, 2);
});
