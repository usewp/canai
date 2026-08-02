import test from "node:test";
import assert from "node:assert/strict";
import { detectLibs } from "./libsDetect.mjs";

test("detectLibs finds swiper from script URL and class hint", () => {
  const r = detectLibs({
    scriptUrls: ["https://cdn.example.com/swiper-bundle.min.js"],
    classNames: ["hero-slider", "swiper-wrapper"],
  });
  const sw = r.libraries.find((l) => l.name === "swiper");
  assert.ok(sw);
  assert.ok(sw.evidence.length >= 1);
  assert.match(r.advisory, /do not|CDN|third-party/i);
});

test("detectLibs returns empty libraries when nothing matches", () => {
  const r = detectLibs({ scriptUrls: ["/app.js"], classNames: ["container"] });
  assert.equal(r.libraries.length, 0);
});
