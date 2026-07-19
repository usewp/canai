// Prepare the content-model handoff bundle. Reads pagetypes.json + each
// type's sample content.json files and writes .contentmodel/PROMPT.md; the
// agent runs the prompt to produce runs/<site>/CONTENT-MODEL.md. Frontend-
// first by design: this stage documents the model, it never creates CPTs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { urlToSlug } from "./slug.mjs";

const PROMPT_TEMPLATE = path.resolve(
  new URL("..", import.meta.url).pathname,
  "prompts/contentmodel.md",
);

export async function prepareContentModelBundle({ site, runsDir = "runs" }) {
  const runDir = path.join(runsDir, site);
  let pt;
  try {
    pt = JSON.parse(await readFile(path.join(runDir, "pagetypes.json"), "utf8"));
  } catch {
    throw new Error(`pagetypes.json not found for ${site}. Run classify first.`);
  }
  const modelTypes = pt.types.filter((t) => t.kind !== "page");
  if (modelTypes.length === 0) {
    throw new Error(`no repeating page types in ${site} — nothing to model; skip contentmodel.`);
  }

  const bundleDir = path.resolve(runDir, ".contentmodel");
  await mkdir(bundleDir, { recursive: true });

  // Collect per-type sample content (only captures that exist). A type's
  // `samples` entry can name a URL whose capture failed (all fallbacks
  // exhausted in capture.mjs) — content.json then never landed on disk. That
  // must never fail silently: each miss is logged, and a type left with ZERO
  // usable captures is dropped from the bundle entirely (with a louder
  // warning) rather than handed to the writing agent as a heading with
  // nothing under it — an empty type is exactly the gap that invites the
  // "speculative field" the prompt tells the agent never to write.
  const samples = [];
  for (const t of modelTypes) {
    const captured = [];
    const missing = [];
    for (const url of t.samples) {
      const slug = urlToSlug(url);
      const contentPath = path.resolve(runDir, "captures", slug, "content.json");
      try {
        await readFile(contentPath, "utf8");
        captured.push({ url, slug, contentPath });
      } catch {
        missing.push(url);
        process.stderr.write(`  ! ${t.name}: no capture for ${url} (capture failed or not run) — skipped\n`);
      }
    }
    if (captured.length === 0) {
      const reason = t.samples.length === 0 ? "no sample URLs recorded by classify" : `0/${t.samples.length} sample(s) captured`;
      process.stderr.write(`  ✗ ${t.name}: ${reason} — excluded from content model (run capture first)\n`);
      continue;
    }
    samples.push({
      name: t.name,
      kind: t.kind,
      pattern: t.pattern,
      memberCount: t.members.length,
      archiveUrl: t.archiveUrl,
      samples: captured,
      missing,
    });
  }
  if (samples.length === 0) {
    throw new Error(
      `no captured content for any repeating page type in ${site} (all sample captures are missing) — run capture first; skip contentmodel.`,
    );
  }
  const samplesPath = path.join(bundleDir, "samples.json");
  await writeFile(samplesPath, JSON.stringify({ site, types: samples }, null, 2));

  const template = await readFile(PROMPT_TEMPLATE, "utf8");
  const typeLines = samples
    .map((t) => {
      const files = t.samples.map((s) => `  - \`${s.contentPath}\` (${s.url})`).join("\n");
      const missingNote = t.missing.length
        ? `\n  - (${t.missing.length} sample capture(s) failed and are skipped: ${t.missing.join(", ")})`
        : "";
      return `- **${t.name}** (kind: \`${t.kind}\`, ${t.memberCount} pages${t.archiveUrl ? `, archive: ${t.archiveUrl}` : ""})\n${files}${missingNote}`;
    })
    .join("\n");

  const contentModelPath = path.resolve(runDir, "CONTENT-MODEL.md");
  const prompt = `${template}

---

## This site

- **Site**: ${site}
- **Type index**: \`${samplesPath}\`

## Types and their sample content.json files (read all of them)

${typeLines}

## Output

Write the handoff document to:

\`${contentModelPath}\`

After writing, confirm the file exists. Do not write anything else.
`;
  const promptPath = path.join(bundleDir, "PROMPT.md");
  await writeFile(promptPath, prompt);

  return { site, typeCount: samples.length, promptPath, contentModelPath };
}
