// Structural gate — browser-free, stdlib only. Diffs what a generated file
// SAYS is on the page (landmarks, headings, images, videos, forms, tables)
// against the capture's content.json. Works on files that still contain
// Twig because it never renders anything: a {{ wpcanai_template('header') }}
// include satisfies the header landmark, and on a typed template a Twig
// expression in a heading/img satisfies the corresponding sample slot.
// This is the whole gate for the `structure` and `wireframe` objectives and
// the local check `verify` could never do for `styled` output.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { collectOutputs, excludeChromePartials, applyOnlyFilter } from "./verify.mjs";
import { classifyTemplateFilename } from "./outputFiles.mjs";
import { readRunConfig } from "./runConfig.mjs";
import { urlToSlug } from "./slug.mjs";

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
const stripTwig = (s) => s.replace(/\{%[\s\S]*?%\}/g, " ").replace(/\{#[\s\S]*?#\}/g, " ");
const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, " "));
const attrValues = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

export function extractStructure(html) {
  const src = String(html ?? "");
  const mainMatch = src.match(/<main\b[\s\S]*?<\/main>/i);
  const main = mainMatch ? mainMatch[0] : src;
  const headings = [...src.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    text: norm(stripTags(stripTwig(m[2]).replace(/\{\{[\s\S]*?\}\}/g, " "))),
    twig: /\{\{/.test(m[2]),
  }));
  const imgSrcMatches = [...src.matchAll(/<img\b[^>]*\ssrc=["']([^"']+)["']/gi)];
  const imageSrcs = imgSrcMatches.map((m) => m[1]);
  // Two independent twig-image signals, counted once each: an <img> whose
  // src is itself a Twig expression (media_url()/tmedia()/a bare {{ }}), and
  // a helper call like image_attrs() that replaces the whole attribute list
  // rather than living inside src="". The helper regex runs over the HTML
  // with every already-counted <img ...src="..."> match stripped out, so a
  // media_url() call inside an img's src isn't double-counted as both an
  // image-src match and a helper-call match.
  const srcTwigCount = imageSrcs.filter((s) => /\{\{/.test(s)).length;
  let rest = src;
  for (const m of imgSrcMatches) rest = rest.replace(m[0], "");
  const helperCount = (rest.match(/\b(image_attrs|media_url|tmedia)\s*\(/g) || []).length;
  const twigImages = srcTwigCount + helperCount;
  return {
    sections: (main.match(/<section\b/gi) || []).length,
    headings,
    imageSrcs,
    twigImages,
    videoSrcs: [
      ...attrValues(src, /<video\b[^>]*\ssrc=["']([^"']+)["']/gi),
      ...attrValues(src, /<source\b[^>]*\ssrc=["']([^"']+)["']/gi),
      ...attrValues(src, /<iframe\b[^>]*\ssrc=["']([^"']+)["']/gi),
    ],
    forms: (src.match(/<form\b/gi) || []).length,
    tables: (src.match(/<table\b/gi) || []).length,
    header: /<header\b/i.test(src) || /wpcanai_template\(\s*['"]header['"]\s*\)/.test(src),
    footer: /<footer\b/i.test(src) || /wpcanai_template\(\s*['"]footer['"]\s*\)/.test(src),
  };
}

export function expectedFromContent(content) {
  const main = Array.isArray(content?.main) ? content.main : [];
  const pick = (key) => main.flatMap((s) => (Array.isArray(s?.[key]) ? s[key] : []));
  return {
    sectionIds: main.map((s) => s.id),
    sectionFirstHeadings: main.map((s) => norm(s?.headings?.[0]?.text)).filter(Boolean),
    headings: pick("headings").map((h) => norm(h.text)).filter(Boolean),
    imageSrcs: pick("images").map((i) => i.src).filter(Boolean),
    videoSrcs: pick("videos").map((v) => v.src).filter(Boolean),
    forms: pick("forms").length,
    tables: pick("tables").length,
    hasHeader: Boolean(content?.header),
    hasFooter: Boolean(content?.footer),
  };
}

function isSubsequence(needle, hay) {
  let i = 0;
  for (const h of hay) if (i < needle.length && h === needle[i]) i++;
  return i === needle.length;
}

export function compareStructure(expected, actual, { kind = "page" } = {}) {
  const template = kind === "template";
  const missing = { sections: null, order: null, headings: [], images: [], videos: [], forms: null, tables: null, chrome: [] };
  if (actual.sections !== expected.sectionIds.length) {
    missing.sections = { expected: expected.sectionIds.length, actual: actual.sections };
  }
  const actualHeadings = actual.headings.map((h) => h.text);
  const twigHeadings = actual.headings.filter((h) => h.twig).length;
  for (const h of expected.headings) {
    if (actualHeadings.includes(h)) continue;
    if (template && twigHeadings > 0) continue;
    missing.headings.push(h);
  }
  const present = expected.sectionFirstHeadings.filter((h) => actualHeadings.includes(h));
  if (!isSubsequence(present, actualHeadings)) missing.order = expected.sectionFirstHeadings;
  for (const s of expected.imageSrcs) {
    if (actual.imageSrcs.includes(s)) continue;
    if (template && actual.twigImages > 0) continue;
    missing.images.push(s);
  }
  for (const s of expected.videoSrcs) if (!actual.videoSrcs.includes(s)) missing.videos.push(s);
  if (actual.forms < expected.forms) missing.forms = { expected: expected.forms, actual: actual.forms };
  if (actual.tables < expected.tables) missing.tables = { expected: expected.tables, actual: actual.tables };
  if (expected.hasHeader && !actual.header) missing.chrome.push("header");
  if (expected.hasFooter && !actual.footer) missing.chrome.push("footer");
  const missingCount =
    (missing.sections ? 1 : 0) + (missing.order ? 1 : 0) + missing.headings.length + missing.images.length +
    missing.videos.length + (missing.forms ? 1 : 0) + (missing.tables ? 1 : 0) + missing.chrome.length;
  return { pass: missingCount === 0, missingCount, missing };
}

function describeMissing(m) {
  const lines = [];
  if (m.sections) lines.push(`- sections: expected ${m.sections.expected}, got ${m.sections.actual}`);
  if (m.order) lines.push(`- order: sections out of order — expected first-headings ${m.order.map((h) => `"${h}"`).join(" → ")}`);
  for (const h of m.headings) lines.push(`- heading missing: "${h}"`);
  for (const s of m.images) lines.push(`- image missing: ${s}`);
  for (const s of m.videos) lines.push(`- video missing: ${s}`);
  if (m.forms) lines.push(`- forms: expected ${m.forms.expected}, got ${m.forms.actual}`);
  if (m.tables) lines.push(`- tables: expected ${m.tables.expected}, got ${m.tables.actual}`);
  for (const c of m.chrome) lines.push(`- chrome missing: ${c} landmark (or its wpcanai_template include)`);
  return lines;
}

export function buildStructureReport({ site, objective, results }) {
  const failed = results.filter((r) => !r.skipped && !r.pass).sort((a, b) => b.missingCount - a.missingCount);
  const passed = results.filter((r) => !r.skipped && r.pass);
  const skipped = results.filter((r) => r.skipped);
  const markdown = [
    `# Structure verify — ${site}`,
    "",
    `- objective: ${objective}`,
    `- files: ${results.length}, pass: ${passed.length}, fail: ${failed.length}, skipped: ${skipped.length}`,
    "",
    "## Failed (worst first)",
    "",
    ...(failed.length ? failed.flatMap((r) => [`### ${r.slug} (${r.kind}) — ${r.missingCount} missing`, "", ...describeMissing(r.missing), ""]) : ["(none)", ""]),
    "## Passed",
    "",
    ...(passed.length ? passed.map((r) => `- ${r.slug} (${r.kind})`) : ["(none)"]),
    "",
    "## Skipped",
    "",
    ...(skipped.length ? skipped.map((r) => `- ${r.slug}: ${r.skipped}`) : ["(none)"]),
    "",
  ].join("\n");
  const json = { site, objective, passed: passed.length, failed: failed.length, skipped: skipped.length, results: [...failed, ...passed, ...skipped] };
  return { markdown, json };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

/** For `<type>-single.html`, the first sample capture of that type is the expected structure. */
async function sampleCaptureDirForTemplate(runDir, file) {
  const { typeName, variant } = classifyTemplateFilename(file);
  if (variant !== "single") return { skipped: `${variant} template — no single-sample contract to check` };
  let pt;
  try { pt = await readJson(path.join(runDir, "pagetypes.json")); } catch { return { skipped: "no pagetypes.json" }; }
  const type = (pt.types || []).find((t) => t.name === typeName);
  const sampleUrl = type?.samples?.[0];
  if (!sampleUrl) return { skipped: `type "${typeName}" has no samples in pagetypes.json` };
  return { captureDir: path.join(runDir, "captures", urlToSlug(sampleUrl)) };
}

export async function verifyStructure({ site, runsDir = "runs", only = null, objective = null } = {}) {
  if (!site) throw new Error("verifyStructure: site is required");
  const runDir = path.join(runsDir, site);
  const resolved = objective ?? (await readRunConfig(runDir))?.objective ?? "styled";
  const verifyDir = path.join(runDir, "verify");
  await mkdir(verifyDir, { recursive: true });

  const entries = applyOnlyFilter(excludeChromePartials(await collectOutputs(path.join(runDir, "output"))), only);
  const results = [];
  for (const { file, dir, kind } of entries) {
    const slug = file.replace(/\.html$/, "");
    let captureDir = path.join(runDir, "captures", slug);
    if (kind === "template") {
      const r = await sampleCaptureDirForTemplate(runDir, file);
      if (r.skipped) { results.push({ slug, kind, skipped: r.skipped }); continue; }
      captureDir = r.captureDir;
    }
    const contentPath = path.join(captureDir, "content.json");
    if (!(await exists(contentPath))) { results.push({ slug, kind, skipped: "no capture" }); continue; }
    const expected = expectedFromContent(await readJson(contentPath));
    const actual = extractStructure(await readFile(path.join(dir, file), "utf8"));
    const cmp = compareStructure(expected, actual, { kind });
    results.push({ slug, kind, ...cmp });
  }

  const { markdown, json } = buildStructureReport({ site, objective: resolved, results });
  const reportPath = path.join(verifyDir, "structure-report.md");
  const jsonPath = path.join(verifyDir, "structure-report.json");
  await writeFile(reportPath, markdown);
  await writeFile(jsonPath, JSON.stringify(json, null, 2));
  return { site, objective: resolved, count: results.length, passed: json.passed, failed: json.failed, skipped: json.skipped, reportPath, jsonPath, results };
}
