// Browser-side JS payloads, stored as standalone files so ANY tool can inject
// them (`agent-browser eval --stdin < payloads/content.js`, Playwright's
// page.evaluate, a DevTools console paste). They run in the page, not in Node:
// this is extraction logic, not driver code, which is why it survives the
// removal of everything that used to drive a browser from here.
//
// They were template literals inside capture.mjs until 4.0.0. Extraction wrote
// the EVALUATED values, not the source text — three of them carried escaped
// backticks and sections.js interpolated the clip limits, so a verbatim source
// copy would have shipped literal "${MAX_CLIP_WIDTH_PX}" to the browser. The
// limits are baked in as 4000/6000/12000000; src/payloads.test.mjs guards that.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PAYLOAD_NAMES = [
  "reveal",
  "scroll-pass",
  "content",
  "styles",
  "sections",
  "ux",
  "assets",
  "dom",
  "page-size",
  "viewport-size",
];

export function payloadsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "payloads");
}

export function payloadPath(name) {
  if (!PAYLOAD_NAMES.includes(name)) {
    throw new Error(
      `unknown payload ${JSON.stringify(name)}; expected one of ${PAYLOAD_NAMES.join(", ")}`,
    );
  }
  return path.join(payloadsDir(), `${name}.js`);
}

export async function readPayload(name) {
  return readFile(payloadPath(name), "utf8");
}
