// Write the capture bundle the AGENT executes with agent-browser.
//
// replica does not drive a browser. This module produces one .capture/PROMPT.md
// listing literal agent-browser commands per page — the same shape designmd,
// contentmodel and transform already use, where Node assembles inputs and the
// agent does the work.
//
// ONE prompt covers the whole worklist rather than one prompt per page: a
// 30-page migration would otherwise cost 30 agent round trips.
//
// The worklist rules are unchanged (buildWorklist, reused verbatim): a
// repeating type contributes 3 samples plus its archiveUrl, a kind:"page" type
// contributes EVERY member, and each one-off page contributes itself.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { urlToSlug } from "./slug.mjs";
import { buildWorklist } from "./capture.mjs";
import { PAGE_WIDTHS, PAGE_WINDOW_HEIGHTS } from "./pageCapture.mjs";

function flagsFor({ profile, session }) {
  const parts = [];
  if (profile) parts.push(`--profile "${profile}"`);
  if (session) parts.push(`--session ${session}`);
  return parts.join(" ");
}

function pageBlock({ url, slug, captureDir, flags }) {
  const ab = `agent-browser${flags ? " " + flags : ""}`;
  const d = PAGE_WIDTHS.desktop;
  const m = PAGE_WIDTHS.mobile;
  return `
### \`${slug}\` — ${url}

\`\`\`bash
${ab} open "${url}"
${ab} wait --load networkidle
${ab} set viewport ${d} ${PAGE_WINDOW_HEIGHTS.desktop}
${ab} eval --stdin < payloads/reveal.js
${ab} eval --stdin < payloads/scroll-pass.js
${ab} eval --stdin < payloads/content.js  > "${captureDir}/content.json"
${ab} eval --stdin < payloads/styles.js   > "${captureDir}/styles.json"
${ab} eval --stdin < payloads/sections.js > "${captureDir}/sections-desktop.json"
${ab} eval --stdin < payloads/ux.js       > "${captureDir}/ux.json"
${ab} eval --stdin < payloads/assets.js   > "${captureDir}/assets.json"
${ab} eval --stdin < payloads/dom.js      > "${captureDir}/dom.html"
${ab} screenshot --full "${captureDir}/fullpage-desktop.png"
${ab} set viewport ${m} ${PAGE_WINDOW_HEIGHTS.mobile}
${ab} eval --stdin < payloads/reveal.js
${ab} eval --stdin < payloads/scroll-pass.js
${ab} eval --stdin < payloads/sections.js > "${captureDir}/sections-mobile.json"
${ab} screenshot --full "${captureDir}/fullpage-mobile.png"
\`\`\`
`;
}

function buildPrompt({ site, pages, flags }) {
  const ab = `agent-browser${flags ? " " + flags : ""}`;
  return `# Capture bundle — ${site}

You are driving the browser. \`replica\` does not. Run the commands below with
**agent-browser**, then hand the artifacts back to \`replica slice\` and
\`replica check\`.

## Before you start

\`\`\`bash
${ab} open "${pages[0].url}"
\`\`\`

Confirm the page actually loaded — dump the accessibility tree and check it
contains content belonging to **this** page. \`agent-browser snapshot\` on a
cold session prints \`(empty page)\` and exits 0, so a bare health check proves
nothing. If the page is behind a login wall or a bot interstitial, stop and
tell the user rather than capturing the interstitial as if it were content.

## Rules

1. **Never screenshot an element.** \`agent-browser screenshot <selector>\`
   returns blank images for anything below the fold — verified on 0.32.3,
   where a heading at y=4481 produced a correctly-sized PNG containing exactly
   one colour, and \`scrollintoview\` first produced a byte-identical blank.
   Sections come from slicing the full-page screenshot, never from an element
   capture.
2. Run every command from the skill directory, so \`payloads/*.js\` resolves.
3. Keep the same \`--profile\` and \`--session\` on every command, or stages
   will drive different browsers.
4. A page that fails to load is a real failure — report it, do not substitute
   a blank capture.

## Pages (${pages.length})

${pages.map(pageBlock).join("\n")}

## When every page is done

\`\`\`bash
replica slice ${site}    # cut the full-page PNGs into per-section slices
replica check ${site}    # validate every artifact — this is the gate
\`\`\`

\`check\` decodes each PNG rather than trusting its size, so a blank slice is
caught here rather than surviving into a design review. Fix anything it
reports before moving on to \`designmd\`.
`;
}

export async function captureBundle({
  site,
  runsDir = "runs",
  only = null,
  profile = null,
  session = null,
}) {
  const runDir = path.join(runsDir, site);
  const { entries } = await buildWorklist(runDir, only);
  if (!entries || entries.length === 0) {
    throw new Error(`no pages to capture for ${site} — run discover (and classify) first`);
  }

  const flags = flagsFor({ profile, session });
  const pages = [];
  for (const entry of entries) {
    const slug = urlToSlug(entry.url);
    const captureDir = path.join(runDir, "captures", slug);
    await mkdir(captureDir, { recursive: true });
    pages.push({ url: entry.url, slug, captureDir, type: entry.type ?? null, flags });
  }

  const bundleDir = path.join(runDir, ".capture");
  await mkdir(bundleDir, { recursive: true });
  const promptPath = path.join(bundleDir, "PROMPT.md");
  await writeFile(promptPath, buildPrompt({ site, pages, flags }));

  return { site, count: pages.length, ok: pages.length > 0, promptPath, pages };
}
