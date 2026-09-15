import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { swapInlineChromeToTwig, handoffPageHtml, runHandoffPage, wrapMainWithTwigChrome } from "./handoffPage.mjs";
import { writeRunConfig } from "./runConfig.mjs";

const execFileP = promisify(execFile);
const BIN = path.resolve(new URL("..", import.meta.url).pathname, "bin/replica");

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

// A page-report as verifyPage writes it for a pixel run: status/slug plus the
// gate mode and chrome it was scored under (handoff-page checks both).
const PASS_REPORT = { status: "pass", slug: "about", canHandoff: true, thresholds: { mode: "hard" }, chrome: "inline" };

async function stageRun(site, { report, html = DRAFT, withChrome = true, runConfig = { objective: "pixel", scope: "page" } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "handoff-page-"));
  const runsDir = path.join(root, "runs");
  const runDir = path.join(runsDir, site);
  await mkdir(path.join(runDir, "verify"), { recursive: true });
  await mkdir(path.join(runDir, "output", "pages"), { recursive: true });
  await mkdir(path.join(runDir, "output", "templates"), { recursive: true });
  if (runConfig) await writeRunConfig(runDir, runConfig);
  await writeFile(
    path.join(runDir, "verify", "page-report.json"),
    JSON.stringify(report ?? PASS_REPORT),
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

test("wrapMainWithTwigChrome: inserts header include after <body> and footer include before </body>", () => {
  const html = `<!DOCTYPE html><html><body class="antialiased">\n<main id="main-content"><section>Hi</section></main>\n</body></html>`;
  const out = wrapMainWithTwigChrome(html);
  assert.match(out, /<body class="antialiased">\n\{\{ wpcanai_template\('header'\) \}\}\n<main/);
  assert.match(out, /<\/main>\n\{\{ wpcanai_template\('footer'\) \}\}\n<\/body>/);
  assert.equal((out.match(/wpcanai_template\('header'\)/g) || []).length, 1);
});

test("wrapMainWithTwigChrome: refuses a draft that still has a <header> (that is inline mode's job)", () => {
  assert.throws(
    () => wrapMainWithTwigChrome(`<body><header>x</header><main></main></body>`),
    /chrome skip: draft still contains a <header> landmark/,
  );
});

test("wrapMainWithTwigChrome: refuses a draft that still has a <footer> (symmetric with the <header> check)", () => {
  assert.throws(
    () => wrapMainWithTwigChrome(`<body><main></main><footer>x</footer></body>`),
    /chrome skip: draft still contains a <footer> landmark/,
  );
});

test("handoffPageHtml: chrome skip wraps, inline swaps", () => {
  const report = { status: "pass" };
  const skipped = handoffPageHtml({ html: `<body><main>m</main></body>`, report, chrome: "skip" });
  assert.match(skipped, /header'\) \}\}\n<main>m<\/main>\n\{\{ wpcanai_template\('footer/);
  const inline = handoffPageHtml({ html: `<body><header>h</header><main>m</main><footer>f</footer></body>`, report, chrome: "inline" });
  assert.match(inline, /\{\{ wpcanai_template\('header'\) \}\}<main>m<\/main>\{\{ wpcanai_template\('footer'\) \}\}/);
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
    report: { status: "in-progress", slug: "about", canHandoff: false },
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

test("runHandoffPage: page-report slug must match --only (after onlyToSlug)", async () => {
  const { runsDir, cleanup } = await stageRun("example.com", {
    report: { ...PASS_REPORT, slug: "contact" },
  });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /page-report\.json slug "contact".*does not match --only "about"/i,
    );
    // Pathname form of --only also normalizes before compare.
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "/about" }),
      /normalized: "about"/i,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Objective gate (final-review Important 1): handoff-page is the pixel
// objective's exit. A wireframe run's height-only verify-page-score also
// returns status: pass / canHandoff: true, so without this gate the grey-box
// draft would be chrome-swapped and pushprepped as if it were a real page.
// ---------------------------------------------------------------------------

test("runHandoffPage: refuses a wireframe run.json even when page-report says pass", async () => {
  const { runsDir, runDir, cleanup } = await stageRun("example.com", {
    runConfig: { objective: "wireframe", scope: "page" },
    report: { ...PASS_REPORT, thresholds: { mode: "height-only" } },
  });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /handoff-page is for the pixel objective only — run\.json objective is "wireframe"; a wireframe has nothing to push/,
    );
    // Nothing touched: no backup, draft untouched, no push artifacts.
    await assert.rejects(readFile(path.join(runDir, "output", "pages", "about.page-mode.static.html")));
    assert.equal(await readFile(path.join(runDir, "output", "pages", "about.html"), "utf8"), DRAFT);
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: refuses a styled run.json (styled goes through pushprep, not handoff-page)", async () => {
  const { runsDir, cleanup } = await stageRun("example.com", {
    runConfig: { objective: "styled", scope: "site" },
    report: { ...PASS_REPORT, thresholds: { mode: "advisory" } },
  });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /handoff-page is for the pixel objective only — run\.json objective is "styled"/,
    );
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: refuses a page-report that was not scored under the hard (pixel) gate", async () => {
  // run.json was re-set to pixel but verify/page-report.json is the stale
  // advisory report from the earlier styled pass — it must not gate a pixel draft.
  const { runsDir, cleanup } = await stageRun("example.com", {
    report: { ...PASS_REPORT, thresholds: { mode: "advisory" } },
  });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /page-report\.json was scored in "advisory" mode, not the pixel hard gate — re-run verify-page-score/,
    );
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: refuses a page-report whose chrome does not match run.json chrome", async () => {
  const { runsDir, cleanup } = await stageRun("example.com", {
    runConfig: { objective: "pixel", scope: "page", chrome: "skip" },
    report: { ...PASS_REPORT, chrome: "inline" },
  });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /page-report\.json chrome "inline" does not match run\.json chrome "skip" — re-run verify-page-score/,
    );
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: refuses a page-report with no chrome field (stale, pre-chrome report)", async () => {
  const { chrome: _chrome, ...noChrome } = PASS_REPORT;
  void _chrome;
  const { runsDir, cleanup } = await stageRun("example.com", { report: noChrome });
  try {
    await assert.rejects(
      () => runHandoffPage({ site: "example.com", runsDir, only: "about" }),
      /page-report\.json chrome "\(missing\)" does not match run\.json chrome "inline"/,
    );
  } finally {
    await cleanup();
  }
});

test("runHandoffPage: pixel run.json + hard report + matching chrome proceeds (chrome skip variant)", async () => {
  // Same document shell as DRAFT (pushprep needs it), minus the chrome landmarks.
  const MAIN_ONLY = DRAFT.replace(/<header[\s\S]*?<\/header>\n/, "").replace(/<footer>©<\/footer>\n/, "");
  const { runsDir, runDir, cleanup } = await stageRun("example.com", {
    runConfig: { objective: "pixel", scope: "page", chrome: "skip" },
    report: { ...PASS_REPORT, chrome: "skip" },
    html: MAIN_ONLY,
  });
  // pushprep prints its chrome-partial slug warnings to stderr; keep the suite output clean.
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    const r = await runHandoffPage({ site: "example.com", runsDir, only: "about" });
    assert.equal(r.chrome, "skip");
    assert.equal(r.ok, 3, JSON.stringify(r.failures));
    const swapped = await readFile(path.join(runDir, "output", "pages", "about.html"), "utf8");
    assert.match(swapped, /wpcanai_template\('header'\) \}\}\n<main/);
  } finally {
    process.stderr.write = originalWrite;
    await cleanup();
  }
});

test("CLI: `replica handoff-page` refuses to run without run.json (requireRunConfig, like transform)", async () => {
  const { runsDir, cleanup } = await stageRun("example.com", { runConfig: null });
  try {
    await assert.rejects(
      execFileP("node", [BIN, "handoff-page", "example.com", "--only", "about", "--runs", runsDir]),
      (e) => {
        assert.equal(e.code, 1);
        assert.match(e.stderr, /run\.json not found — record the objective first: replica objective example\.com --set/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});
