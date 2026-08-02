import test from "node:test";
import assert from "node:assert/strict";
import { encodePngRgba, clampBox, slicePng, sliceSections } from "./pngSlice.mjs";
import { decodePng } from "./pngdiff.mjs";

function solid(w, h, [r, g, b, a = 255]) {
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return encodePngRgba(w, h, pixels);
}

test("clampBox rejects empty / out-of-bounds", () => {
  assert.equal(clampBox({ left: 0, top: 0, width: 0, height: 10 }, 100, 100), null);
  assert.equal(clampBox({ left: 200, top: 0, width: 10, height: 10 }, 100, 100), null);
});

test("clampBox clips overflowing box to image", () => {
  assert.deepEqual(clampBox({ left: 90, top: 90, width: 20, height: 20 }, 100, 100), {
    left: 90,
    top: 90,
    width: 10,
    height: 10,
  });
});

test("slicePng crops the requested rectangle", () => {
  // 4x4: left half red, right half blue
  const pixels = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      if (x < 2) {
        pixels[i] = 255;
        pixels[i + 3] = 255;
      } else {
        pixels[i + 2] = 255;
        pixels[i + 3] = 255;
      }
    }
  }
  const png = encodePngRgba(4, 4, pixels);
  const crop = decodePng(slicePng(png, { left: 2, top: 0, width: 2, height: 4 }));
  assert.equal(crop.width, 2);
  assert.equal(crop.height, 4);
  assert.deepEqual([...crop.pixels.slice(0, 4)], [0, 0, 255, 255]);
});

test("sliceSections names files from section id and records errors", () => {
  const png = solid(8, 8, [10, 20, 30, 255]);
  const out = sliceSections(png, [
    { id: "hero", left: 0, top: 0, width: 8, height: 4 },
    { id: "bad", left: 0, top: 0, width: 0, height: 0 },
  ]);
  assert.equal(out[0].fileName, "01-hero.png");
  assert.ok(out[0].buffer);
  assert.equal(out[1].buffer, null);
  assert.match(out[1].error, /invalid|empty|clamp/i);
});
