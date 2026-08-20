import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureBundle } from "./captureBundle.mjs";

async function siteWithPages(pages) {
  const root = await mkdtemp(path.join(tmpdir(), "capbundle-"));
  await mkdir(path.join(root, "acme.test"), { recursive: true });
  await writeFile(
    path.join(root, "acme.test", "pages.json"),
    JSON.stringify({ site: "acme.test", pages }),
  );
  return root;
}

test("writes ONE PROMPT.md covering every page, not one per page", async () => {
  const root = await siteWithPages([
    { url: "https://acme.test/" },
    { url: "https://acme.test/about/" },
  ]);
  const r = await captureBundle({ site: "acme.test", runsDir: root });
  assert.equal(r.count, 2);
  assert.equal(r.promptPath, path.join(root, "acme.test", ".capture", "PROMPT.md"));
  const prompt = await readFile(r.promptPath, "utf8");
  assert.match(prompt, /https:\/\/acme\.test\//);
  assert.match(prompt, /https:\/\/acme\.test\/about\//);
});

test("carries the dedicated profile and session on every agent-browser command", async () => {
  const root = await siteWithPages([{ url: "https://acme.test/" }]);
  const r = await captureBundle({
    site: "acme.test",
    runsDir: root,
    profile: "$HOME/.canai-browser",
    session: "canai",
  });
  const prompt = await readFile(r.promptPath, "utf8");
  const commands = prompt.split("\n").filter((l) => l.trim().startsWith("agent-browser "));
  assert.ok(commands.length > 5, "expected several agent-browser commands");
  for (const line of commands) {
    assert.match(line, /--profile "\$HOME\/\.canai-browser"/, line);
    assert.match(line, /--session canai/, line);
  }
});

test("injects payloads in reveal-then-scroll-then-extract order", async () => {
  const root = await siteWithPages([{ url: "https://acme.test/" }]);
  const r = await captureBundle({ site: "acme.test", runsDir: root });
  const prompt = await readFile(r.promptPath, "utf8");
  const order = [
    "reveal.js",
    "scroll-pass.js",
    "content.js",
    "styles.js",
    "sections.js",
    "ux.js",
    "assets.js",
    "dom.js",
  ];
  let cursor = -1;
  for (const name of order) {
    const at = prompt.indexOf(name);
    assert.ok(at > cursor, `${name} out of order in PROMPT.md`);
    cursor = at;
  }
});

// The whole reason this refactor exists: agent-browser returns blank images
// for below-the-fold elements. The prompt must never ask for one.
test("never tells the agent to screenshot an element", async () => {
  const root = await siteWithPages([{ url: "https://acme.test/" }]);
  const r = await captureBundle({ site: "acme.test", runsDir: root });
  const prompt = await readFile(r.promptPath, "utf8");
  assert.doesNotMatch(prompt, /screenshot\s+["']?[#.][\w-]/, "prompt asks for an element screenshot");
  assert.match(prompt, /screenshot --full/);
  assert.match(prompt, /replica slice/);
  assert.match(prompt, /replica check/);
});

test("asks for both viewport widths", async () => {
  const root = await siteWithPages([{ url: "https://acme.test/" }]);
  const r = await captureBundle({ site: "acme.test", runsDir: root });
  const prompt = await readFile(r.promptPath, "utf8");
  assert.match(prompt, /1440/);
  assert.match(prompt, /390/);
});

test("creates a capture directory per page so output paths exist", async () => {
  const root = await siteWithPages([{ url: "https://acme.test/about/" }]);
  const r = await captureBundle({ site: "acme.test", runsDir: root });
  assert.ok(r.pages.some((p) => p.slug === "about"), JSON.stringify(r.pages));
  const dir = path.join(root, "acme.test", "captures", "about");
  const st = await (await import("node:fs/promises")).stat(dir);
  assert.ok(st.isDirectory());
});

test("an empty worklist fails rather than writing an empty prompt", async () => {
  const root = await siteWithPages([]);
  await assert.rejects(() => captureBundle({ site: "acme.test", runsDir: root }), /no pages/i);
});
