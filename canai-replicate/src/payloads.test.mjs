import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { PAYLOAD_NAMES, payloadPath, readPayload } from "./payloads.mjs";

test("every payload name maps to a readable, non-empty file", async () => {
  assert.equal(PAYLOAD_NAMES.length, 10);
  for (const name of PAYLOAD_NAMES) {
    const src = await readPayload(name);
    assert.ok(src.trim().length > 0, `${name} is empty`);
  }
});

test("every payload is syntactically valid JavaScript", async () => {
  for (const name of PAYLOAD_NAMES) {
    const src = await readPayload(name);
    assert.doesNotThrow(
      () => new vm.Script(src, { filename: `${name}.js` }),
      `${name} does not parse`,
    );
  }
});

test("payloadPath points inside payloads/ and ends in .js", () => {
  for (const name of PAYLOAD_NAMES) {
    assert.match(payloadPath(name), /[/\\]payloads[/\\][a-z-]+\.js$/);
  }
});

test("an unknown payload name fails loudly rather than returning a bad path", () => {
  assert.throws(() => payloadPath("nope"), /unknown payload/);
});

// Regression guard for the extraction bug this refactor had to avoid: the
// payloads were template literals, and SECTIONS_JS interpolated the clip
// limits. Copying source text verbatim would have shipped literal "${...}"
// to the browser. The values must be baked in.
test("sections.js has no unresolved template interpolation", async () => {
  const src = await readPayload("sections");
  assert.doesNotMatch(src, /\$\{/, "sections.js still contains ${...} interpolation");
  for (const literal of ["4000", "6000", "12000000"]) {
    assert.ok(src.includes(literal), `sections.js lost the baked-in clip limit ${literal}`);
  }
});

// CONTENT_JS/STYLES_JS/REVEAL_JS carried escaped backticks inside comments.
// Evaluated extraction resolves those to real backticks; source-text copying
// would have left the backslash behind.
test("payloads carry no leftover backslash-escaped backticks", async () => {
  for (const name of ["content", "styles", "reveal"]) {
    const src = await readPayload(name);
    assert.doesNotMatch(src, /\\`/, `${name}.js still has escaped backticks from the literal`);
  }
});
