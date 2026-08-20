// Cut full-page screenshots into per-section PNGs.
//
// This is what replaces the CDP node screenshots cdp.mjs used to take.
// agent-browser returns BLANK images for below-the-fold elements — verified on
// 0.32.3, where a heading at y=4481 produced a correctly-sized 116x27 PNG
// containing exactly one colour, and `scrollintoview` first produced a
// byte-identical blank. So we never screenshot an element. We screenshot the
// whole page once per width and slice it, which is what page mode has always
// done (see pageCapture.mjs) — this generalises that to every capture.
//
// Input per capture dir, produced by the agent running payloads/sections.js:
//   sections-desktop.json / sections-mobile.json  ->  { sections: [ {id,left,top,width,height,...} ] }
// Output: sections-desktop/, sections-mobile/, a sections/ mirror of desktop,
// and those same JSON files rewritten with each entry's `file` path filled in.

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sliceSections } from "./pngSlice.mjs";
import { writeSectionPngs, sectionJsonEntry } from "./pageCapture.mjs";

const VIEWPORTS = [
  {
    name: "desktop",
    png: "fullpage-desktop.png",
    meta: "sections-desktop.json",
    dir: "sections-desktop",
  },
  {
    name: "mobile",
    png: "fullpage-mobile.png",
    meta: "sections-mobile.json",
    dir: "sections-mobile",
  },
];

async function readSectionsMeta(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  // Accept the raw payload shape ({ sections: [...] }) and a bare array, so a
  // hand-edited or re-saved file still slices.
  const sections = Array.isArray(parsed) ? parsed : parsed?.sections;
  return Array.isArray(sections) && sections.length > 0 ? sections : null;
}

async function sliceViewport(captureDir, viewport) {
  let png;
  try {
    png = await readFile(path.join(captureDir, viewport.png));
  } catch {
    return null;
  }
  const meta = await readSectionsMeta(path.join(captureDir, viewport.meta));
  if (!meta) return null;

  const slices = sliceSections(png, meta);
  const merged = slices.map((slice, i) => ({ ...meta[i], ...slice }));

  await writeSectionPngs(path.join(captureDir, viewport.dir), merged);
  await writeFile(
    path.join(captureDir, viewport.meta),
    JSON.stringify({ sections: merged.map((s) => sectionJsonEntry(s, viewport.dir)) }, null, 2),
  );

  // Desktop doubles as the compat `sections/` + `sections.json` pair every
  // downstream stage (transform bundles, verify-page section notes) reads.
  if (viewport.name === "desktop") {
    await writeSectionPngs(path.join(captureDir, "sections"), merged);
    await writeFile(
      path.join(captureDir, "sections.json"),
      JSON.stringify({ sections: merged.map((s) => sectionJsonEntry(s, "sections")) }, null, 2),
    );
  }

  return merged.filter((s) => s.buffer).length;
}

export async function slice({ site, runsDir = "runs", only = null }) {
  const capturesDir = path.join(runsDir, site, "captures");
  let slugs = [];
  try {
    slugs = (await readdir(capturesDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    slugs = [];
  }
  if (only) slugs = slugs.filter((s) => s === only);

  const slices = [];
  for (const slug of slugs.sort()) {
    for (const viewport of VIEWPORTS) {
      const written = await sliceViewport(path.join(capturesDir, slug), viewport);
      if (written == null) continue;
      slices.push({ slug, viewport: viewport.name, written });
    }
  }

  return { site, count: slices.length, ok: slices.length > 0, slices };
}
