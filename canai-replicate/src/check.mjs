// Validate capture artifacts.
//
// A directory existing on disk does NOT mean its capture succeeded. On
// smittenkitchen.com, 9 of 11 recipe capture directories were crash debris
// with no content.json — indistinguishable from real captures by a plain `ls`,
// and only caught after they had already fed a design review. This turns that
// documented hazard into an enforced gate.
//
// PNG blankness is decoded, never inferred from file size: the failure this
// exists to catch (agent-browser's below-the-fold element screenshot) produced
// a correctly-sized, structurally valid 116x27 PNG that was solid #f8f9fa. Its
// byte length looked plausible. Only decoding reveals it.
//
// decodePng and isBlankFullPagePixels already existed; this module wires them
// together rather than reimplementing PNG handling.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { decodePng } from "./pngdiff.mjs";
import { isBlankFullPagePixels } from "./pageCapture.mjs";

const REQUIRED_NON_EMPTY = ["assets.json", "ux.json", "dom.html"];
const PAGE_MODE_PNGS = ["fullpage-desktop.png", "fullpage-mobile.png"];

async function readJson(file) {
  const raw = await readFile(file, "utf8");
  if (!raw.trim()) throw new Error("empty file");
  return JSON.parse(raw);
}

function describeReadError(e) {
  return e.code === "ENOENT" ? "missing" : e.message;
}

async function checkPng(file, errors, label) {
  let buf;
  try {
    buf = await readFile(file);
  } catch {
    errors.push(`${label}: missing`);
    return;
  }
  if (buf.length === 0) {
    errors.push(`${label}: empty PNG`);
    return;
  }
  let decoded;
  try {
    decoded = decodePng(buf);
  } catch (e) {
    errors.push(`${label}: invalid PNG (${e.message})`);
    return;
  }
  if (!(decoded.width > 0) || !(decoded.height > 0)) {
    errors.push(`${label}: zero-size PNG (${decoded.width}x${decoded.height})`);
    return;
  }
  if (isBlankFullPagePixels(decoded.pixels)) {
    errors.push(`${label}: blank PNG (transparent or near-uniform) — re-slice, do not push`);
  }
}

/** Validate one capture directory. Returns errors (fail) and warnings (note). */
export async function checkCapture(captureDir, { pageMode = false } = {}) {
  const slug = path.basename(captureDir);
  const errors = [];
  const warnings = [];

  let content = null;
  try {
    content = await readJson(path.join(captureDir, "content.json"));
  } catch (e) {
    errors.push(`content.json: ${describeReadError(e)}`);
  }
  if (content) {
    if (!Array.isArray(content.main)) {
      errors.push("content.json: no `main` array");
    } else if (content.main.length === 0) {
      // Legitimate on page-builder themes that emit no landmark tags — seen
      // live on a WooCommerce shop archive. Worth a human's eye, not a failure.
      warnings.push(
        "content.json: `main` is empty — legitimate only on themes with no landmark tags; confirm against dom.html",
      );
    }
  }

  let sections = null;
  try {
    const parsed = await readJson(path.join(captureDir, "sections.json"));
    sections = Array.isArray(parsed) ? parsed : parsed?.sections;
    if (!Array.isArray(sections)) errors.push("sections.json: no `sections` array");
  } catch (e) {
    errors.push(`sections.json: ${describeReadError(e)}`);
  }
  if (Array.isArray(sections)) {
    for (const s of sections) {
      if (!s || !s.file) continue;
      await checkPng(path.join(captureDir, s.file), errors, s.file);
    }
  }

  try {
    const styles = await readJson(path.join(captureDir, "styles.json"));
    for (const viewport of ["desktop", "mobile"]) {
      if (!styles?.[viewport]) {
        errors.push(`styles.json: missing ${viewport}`);
      } else if (!styles[viewport].roles || Object.keys(styles[viewport].roles).length === 0) {
        errors.push(`styles.json: ${viewport}.roles is empty`);
      }
    }
  } catch (e) {
    errors.push(`styles.json: ${describeReadError(e)}`);
  }

  for (const file of REQUIRED_NON_EMPTY) {
    try {
      const st = await stat(path.join(captureDir, file));
      if (st.size === 0) errors.push(`${file}: empty`);
    } catch {
      errors.push(`${file}: missing`);
    }
  }

  if (pageMode) {
    for (const file of PAGE_MODE_PNGS) {
      await checkPng(path.join(captureDir, file), errors, file);
    }
    try {
      await stat(path.join(captureDir, "viewports.json"));
    } catch {
      errors.push("viewports.json: missing");
    }
    for (const dir of ["sections-desktop", "sections-mobile"]) {
      try {
        if ((await readdir(path.join(captureDir, dir))).length === 0) errors.push(`${dir}/: empty`);
      } catch {
        errors.push(`${dir}/: missing`);
      }
    }
  }

  return { slug, errors, warnings };
}

export async function check({ site, runsDir = "runs", only = null }) {
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

  const results = [];
  for (const slug of slugs.sort()) {
    const dir = path.join(capturesDir, slug);
    let pageMode = false;
    try {
      await stat(path.join(dir, "viewports.json"));
      pageMode = true;
    } catch {
      pageMode = false;
    }
    results.push(await checkCapture(dir, { pageMode }));
  }

  const clean = results.filter((r) => r.errors.length === 0);
  return {
    site,
    count: clean.length,
    total: results.length,
    ok: results.length > 0 && clean.length === results.length,
    results,
  };
}
