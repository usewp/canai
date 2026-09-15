import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractStructure,
  expectedFromContent,
  compareStructure,
  verifyStructure,
} from "./verifyStructure.mjs";

const CONTENT = {
  title: "Pricing",
  header: { headings: [], links: [{ text: "Home", href: "/" }], forms: [] },
  main: [
    {
      id: "hero", role: "hero", headings: [{ level: 1, text: "Simple pricing" }],
      images: [{ src: "https://cdn.example.com/hero.png", alt: "Hero" }], videos: [], forms: [], tables: [],
    },
    {
      id: "section-2", role: "section", headings: [{ level: 2, text: "Compare plans" }],
      images: [], videos: [{ kind: "youtube", src: "https://www.youtube.com/embed/abc" }],
      forms: [{ action: "/signup", method: "post", fields: [] }],
      tables: [{ caption: null, headers: ["Plan", "Price"], rows: [["Free", "$0"]], pairs: null }],
    },
  ],
  footer: { headings: [], links: [], forms: [] },
};

const GOOD_HTML = `<!DOCTYPE html><html><body>
{{ wpcanai_template('header') }}
<main id="main-content">
  <!-- Section: Hero --><section><h1>Simple  pricing</h1><img src="https://cdn.example.com/hero.png" alt="Hero"></section>
  <!-- Section: Compare --><section><h2>Compare plans</h2>
    <iframe src="https://www.youtube.com/embed/abc" title="Demo"></iframe>
    <form action="/signup" method="post"></form>
    <table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Free</td><td>$0</td></tr></tbody></table>
  </section>
</main>
{{ wpcanai_template('footer') }}
</body></html>`;

test("extractStructure counts sections inside <main>, normalises heading whitespace, skips Twig tags", () => {
  const s = extractStructure(GOOD_HTML);
  assert.equal(s.sections, 2);
  assert.deepEqual(s.headings.map((h) => h.text), ["Simple pricing", "Compare plans"]);
  assert.deepEqual(s.imageSrcs, ["https://cdn.example.com/hero.png"]);
  assert.deepEqual(s.videoSrcs, ["https://www.youtube.com/embed/abc"]);
  assert.equal(s.forms, 1);
  assert.equal(s.tables, 1);
  assert.equal(s.header, true, "Twig header include counts as the header landmark");
  assert.equal(s.footer, true);
});

test("extractStructure flags Twig-expression headings and Twig image helpers", () => {
  const s = extractStructure(`<main><section><h1>{{ post.title }}</h1><img src="{{ media_url(post.featured_image) }}"></section></main>`);
  assert.equal(s.headings[0].twig, true);
  assert.equal(s.twigImages, 1);
});

test("expectedFromContent lists main-only slots and chrome landmark presence", () => {
  const e = expectedFromContent(CONTENT);
  assert.deepEqual(e.sectionIds, ["hero", "section-2"]);
  assert.deepEqual(e.sectionFirstHeadings, ["Simple pricing", "Compare plans"]);
  assert.deepEqual(e.headings, ["Simple pricing", "Compare plans"]);
  assert.deepEqual(e.imageSrcs, ["https://cdn.example.com/hero.png"]);
  assert.deepEqual(e.videoSrcs, ["https://www.youtube.com/embed/abc"]);
  assert.equal(e.forms, 1);
  assert.equal(e.tables, 1);
  assert.equal(e.hasHeader, true);
  assert.equal(e.hasFooter, true);
});

test("compareStructure: full pass", () => {
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(GOOD_HTML));
  assert.equal(r.pass, true);
  assert.equal(r.missingCount, 0);
});

test("compareStructure: missing section, heading, video and table are each reported", () => {
  const html = `<main><section><h1>Simple pricing</h1><img src="https://cdn.example.com/hero.png"></section></main><header></header><footer></footer>`;
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(html));
  assert.equal(r.pass, false);
  assert.deepEqual(r.missing.sections, { expected: 2, actual: 1 });
  assert.deepEqual(r.missing.headings, ["Compare plans"]);
  assert.deepEqual(r.missing.videos, ["https://www.youtube.com/embed/abc"]);
  assert.deepEqual(r.missing.forms, { expected: 1, actual: 0 });
  assert.deepEqual(r.missing.tables, { expected: 1, actual: 0 });
});

test("compareStructure: reordered sections fail the order check", () => {
  const html = `<header></header><main>
    <section><h2>Compare plans</h2><iframe src="https://www.youtube.com/embed/abc"></iframe><form></form><table></table></section>
    <section><h1>Simple pricing</h1><img src="https://cdn.example.com/hero.png"></section>
  </main><footer></footer>`;
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(html));
  assert.equal(r.pass, false);
  assert.deepEqual(r.missing.order, ["Simple pricing", "Compare plans"]);
});

test("compareStructure: a missing chrome landmark is reported", () => {
  const html = `<main><section><h1>Simple pricing</h1><img src="https://cdn.example.com/hero.png"></section>
    <section><h2>Compare plans</h2><iframe src="https://www.youtube.com/embed/abc"></iframe><form></form><table></table></section></main>`;
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(html));
  assert.deepEqual(r.missing.chrome, ["header", "footer"]);
});

test("compareStructure: template kind — Twig heading/image slots satisfy literal sample text", () => {
  const html = `{{ wpcanai_template('header') }}<main>
    <section><h1>{{ post.title }}</h1><img src="{{ media_url(post.featured_image) }}"></section>
    <section><h2>{{ post.fields.plans_heading }}</h2><iframe src="https://www.youtube.com/embed/abc"></iframe><form></form><table></table></section>
  </main>{{ wpcanai_template('footer') }}`;
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(html), { kind: "template" });
  assert.equal(r.pass, true, JSON.stringify(r.missing));
});

test("compareStructure: a form outside <main> does not satisfy an expected main-content form", () => {
  const html = `<header><form action="/search" method="get"></form></header><main>
    <section><h1>Simple pricing</h1><img src="https://cdn.example.com/hero.png"></section>
    <section><h2>Compare plans</h2><iframe src="https://www.youtube.com/embed/abc"></iframe><table></table></section>
  </main><footer></footer>`;
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(html));
  assert.equal(r.pass, false);
  assert.deepEqual(r.missing.forms, { expected: 1, actual: 0 });
});

test("compareStructure: a form inside <main> satisfies the expected main-content form", () => {
  const html = `<header></header><main>
    <section><h1>Simple pricing</h1><img src="https://cdn.example.com/hero.png"></section>
    <section><h2>Compare plans</h2><iframe src="https://www.youtube.com/embed/abc"></iframe><form action="/signup" method="post"></form><table></table></section>
  </main><footer></footer>`;
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(html));
  assert.equal(r.pass, true, JSON.stringify(r.missing));
});

async function fixtureRun() {
  const root = await mkdtemp(path.join(tmpdir(), "verify-structure-"));
  const runDir = path.join(root, "runs", "example.com");
  await mkdir(path.join(runDir, "captures", "pricing"), { recursive: true });
  await mkdir(path.join(runDir, "captures", "about"), { recursive: true });
  await mkdir(path.join(runDir, "output", "pages"), { recursive: true });
  await mkdir(path.join(runDir, "output", "templates"), { recursive: true });
  await writeFile(path.join(runDir, "captures", "pricing", "content.json"), JSON.stringify(CONTENT));
  await writeFile(path.join(runDir, "captures", "about", "content.json"), JSON.stringify({ ...CONTENT, main: CONTENT.main.slice(0, 1) }));
  await writeFile(path.join(runDir, "output", "pages", "pricing.html"), GOOD_HTML);
  await writeFile(path.join(runDir, "output", "pages", "about.html"), `<main></main>`);
  await writeFile(path.join(runDir, "output", "templates", "header.html"), `<header></header>`);
  await writeFile(path.join(runDir, "output", "pages", "orphan.html"), `<main></main>`);
  return { root, runDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("verifyStructure: writes worst-first report, counts pass/fail/skipped, exit contract", async () => {
  const { root, runDir, cleanup } = await fixtureRun();
  try {
    const r = await verifyStructure({ site: "example.com", runsDir: path.join(root, "runs") });
    assert.equal(r.objective, "styled");
    assert.equal(r.passed, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.skipped, 1, "orphan.html has no capture → skipped, chrome partial excluded entirely");
    const md = await readFile(r.reportPath, "utf8");
    assert.match(md, /^# Structure verify — example\.com/m);
    assert.match(md, /### about \(page\)/);
    assert.match(md, /- orphan: no capture/);
    const json = JSON.parse(await readFile(r.jsonPath, "utf8"));
    assert.equal(json.results.find((x) => x.slug === "about").pass, false);
    assert.equal(json.results[0].slug, "about", "failed entries sort first");
  } finally {
    await cleanup();
  }
});

test("verifyStructure: objective 'structure' checks output/structure/*.md against content.json", async () => {
  const { root, runDir, cleanup } = await fixtureRun();
  try {
    const { renderStructureMarkdown } = await import("./structureDoc.mjs");
    await mkdir(path.join(runDir, "output", "structure"), { recursive: true });
    await writeFile(path.join(runDir, "output", "structure", "pricing.md"),
      renderStructureMarkdown({ slug: "pricing", url: "https://example.com/pricing/", content: CONTENT, sectionFiles: {} }));
    await writeFile(path.join(runDir, "output", "structure", "about.md"), "# About\n");
    const r = await verifyStructure({ site: "example.com", runsDir: path.join(root, "runs"), objective: "structure" });
    assert.equal(r.passed, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.results.find((x) => x.slug === "about").kind, "structure");
  } finally {
    await cleanup();
  }
});

test("verifyStructure: --only narrows and throws when nothing matches", async () => {
  const { root, cleanup } = await fixtureRun();
  try {
    const r = await verifyStructure({ site: "example.com", runsDir: path.join(root, "runs"), only: "pricing" });
    assert.equal(r.count, 1);
    await assert.rejects(
      verifyStructure({ site: "example.com", runsDir: path.join(root, "runs"), only: "nope" }),
      /no output matches --only nope/,
    );
  } finally {
    await cleanup();
  }
});

test("compareStructure: chrome skip ignores missing header/footer landmarks", () => {
  const html = `<main><section><h1>Simple pricing</h1><img src="https://cdn.example.com/hero.png"></section>
    <section><h2>Compare plans</h2><iframe src="https://www.youtube.com/embed/abc"></iframe><form></form><table></table></section></main>`;
  const r = compareStructure(expectedFromContent(CONTENT), extractStructure(html), { chrome: "skip" });
  assert.equal(r.pass, true, JSON.stringify(r.missing));
});
