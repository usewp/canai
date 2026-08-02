import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { swapInlineChromeToTwig, handoffPageHtml, runHandoffPage } from "./handoffPage.mjs";

const DRAFT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>About</title>
  <!-- WPCanAI-PREVIEW-LIBS:START — local preview only -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- WPCanAI-PREVIEW-LIBS:END -->
</head>
<body class="antialiased">
<header class="site"><nav>Home</nav></header>
<main id="main-content"><section>Hi</section></main>
<footer>©</footer>
<!-- WPCanAI-PREVIEW-LIBS:START -->
<script>lucide.createIcons();</script>
<!-- WPCanAI-PREVIEW-LIBS:END -->
</body>
</html>`;

const HEADER = `<!-- wpcanai-template: template_type=header -->
<header id="masthead" class="site-header"><a href="/">Home</a></header>
`;

const FOOTER = `<!-- wpcanai-template: template_type=footer -->
<footer id="colophon" class="site-footer"><p>©</p></footer>
`;

async function stageRun(site, { report, html = DRAFT, withChrome = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "handoff-page-"));
  const runsDir = path.join(root, "runs");
  const runDir = path.join(runsDir, site);
  await mkdir(path.join(runDir, "verify"), { recursive: true });
  await mkdir(path.join(runDir, "output", "pages"), { recursive: true });
  await mkdir(path.join(runDir, "output", "templates"), { recursive: true });
  await writeFile(
    path.join(runDir, "verify", "page-report.json"),
    JSON.stringify(report ?? { status: "pass", slug: "about", canHandoff: true }),
  );
  await writeFile(path.join(runDir, "output", "pages", "about.html"), html);
  if (withChrome) {
    await writeFile(path.join(runDir, "output", "templates", "header.html"), HEADER);
    await writeFile(path.join(runDir, "output", "templates", "footer.html"), FOOTER);
  }
  return {
    runsDir,
    runDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("swapInlineChromeToTwig replaces header and footer", () => {
  const out = swapInlineChromeToTwig(DRAFT);
  assert.match(out, /\{\{\s*wpcanai_template\('header'\)\s*\}\}/);
  assert.match(out, /\{\{\s*wpcanai_template\('footer'\)\s*\}\}/);
  assert.doesNotMatch(out, /<header/i);
  assert.doesNotMatch(out, /<footer/i);
  assert.match(out, /<main/i);
});

test("handoffPageHtml refuses non-pass report", () => {
  assert.throws(
    () => handoffPageHtml({ html: DRAFT, report: { status: "in-progress" } }),
    /handoff/i,
  );
});

test("handoffPageHtml swaps when pass", () => {
  const out = handoffPageHtml({ html: DRAFT, report: { status: "pass" } });
  assert.match(out, /wpcanai_template\('header'\)/);
});

test("runHandoffPage: pass report → backup static, swap in place, pushprep page+chrome", async () => {
  const { runsDir, runDir, cleanup } = await stageRun("example.com");
  try {
    const r = await runHandoffPage({ site: "example.com", runsDir, only: "about" });
    assert.equal(r.slug, "about");
    assert.equal(r.ok, 3, "page + header + footer");
    assert.equal(r.count, 3);

    const backup = await readFile(
      path.join(runDir, "output", "pages", "about.page-mode.static.html"),
      "utf8",
    );
    assert.match(backup, /<header/i, "backup keeps inline chrome");
    assert.doesNotMatch(backup, /wpcanai_template\('header'\)/);

    const swapped = await readFile(path.join(runDir, "output", "pages", "about.html"), "utf8");
    assert.match(swapped, /\{\{\s*wpcanai_template\('header'\)\s*\}\}/);
    assert.match(swapped, /\{\{\s*wpcanai_template\('footer'\)\s*\}\}/);
    assert.doesNotMatch(swapped, /<header/i);

    for (const slug of ["about", "header", "footer"]) {
      const artifact = JSON.parse(
        await readFile(path.join(runDir, "output", "push", `${slug}.json`), "utf8"),
      );
      assert.ok(artifact.html, `${slug}.json must have html`);
    }
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: refuses non-pass page-report", async () => {
  const { runsDir, cleanup } = await stageRun("example.com", {
    report: { status: "in-progress", canHandoff: false },
  });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /handoff-page refused|status is in-progress/i,
    );
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: missing chrome throws with transform --only chrome hint", async () => {
  const { runsDir, cleanup } = await stageRun("example.com", { withChrome: false });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /transform .* --only chrome/i,
    );
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: requires --only", async () => {
  await assert.rejects(
    () => runHandoffPage({ site: "example.com", runsDir: "/tmp" }),
    /--only/,
  );
});
