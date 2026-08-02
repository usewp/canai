import test from "node:test";
import assert from "node:assert/strict";
import { swapInlineChromeToTwig, handoffPageHtml } from "./handoffPage.mjs";

const DRAFT = `<!DOCTYPE html><html><body>
<header class="site"><nav>Home</nav></header>
<main><section>Hi</section></main>
<footer>©</footer>
</body></html>`;

test("swapInlineChromeToTwig replaces header and footer", () => {
  const out = swapInlineChromeToTwig(DRAFT);
  assert.match(out, /\{\{\s*wpcanai_template\('header'\)\s*\}\}/);
  assert.match(out, /\{\{\s*wpcanai_template\('footer'\)\s*\}\}/);
  assert.doesNotMatch(out, /<header/i);
  assert.doesNotMatch(out, /<footer/i);
  assert.match(out, /<main>/i);
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
