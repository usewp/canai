import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePng, diffScore } from "./pngdiff.mjs";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Test-only encoder: 8-bit, colorType 2 (RGB) or 6 (RGBA), any of the 5 PNG
// row filters (per row, or mixed across rows). decodePng ignores CRCs, so we
// write zeros there.
//
// The forward `filterRow` below is a *from-spec* reimplementation, written
// independently of pngdiff.mjs's unfilter loop (not copy-pasted from it). If
// it were derived from the decoder's own code, a shared bug would round-trip
// "correctly" and the test would prove nothing. Written from the PNG spec
// instead, a round-trip failure means decodePng disagrees with the spec.
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Encode-direction PNG row filter (PNG spec 9.2/9.3): given the true,
// unfiltered bytes of the current row and previous row (previous row is all
// zeros above row 0), produce the filtered bytes a real encoder would emit.
function filterRow(cur, prev, bpp, filterType) {
  const stride = cur.length;
  const out = Buffer.alloc(stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0; // left
    const b = prev[x]; // up
    const c = x >= bpp ? prev[x - bpp] : 0; // up-left
    let pred;
    switch (filterType) {
      case 0: pred = 0; break;
      case 1: pred = a; break;
      case 2: pred = b; break;
      case 3: pred = (a + b) >> 1; break;
      case 4: pred = paethPredictor(a, b, c); break;
      default: throw new Error(`test encoder: bad filter ${filterType}`);
    }
    out[x] = (cur[x] - pred) & 0xff;
  }
  return out;
}

// encodePng(width, height, px, opts?)
//   px(x, y) -> [r, g, b, a]     source pixel (a is ignored when colorType 2)
//   opts.colorType: 2 (RGB, bpp 3) or 6 (RGBA, bpp 4) — default 6
//   opts.filters: a single filter number applied to every row, OR an array
//     of one filter number per row (mixed filters, like a real encoder emits)
//     — default 0
function encodePng(width, height, px, { colorType = 6, filters = 0 } = {}) {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = px(x, y);
      const o = x * bpp;
      cur[o] = r; cur[o + 1] = g; cur[o + 2] = b;
      if (bpp === 4) cur[o + 3] = a;
    }
    const filterType = Array.isArray(filters) ? filters[y] : filters;
    const filtered = filterRow(cur, prev, bpp, filterType);
    const rowStart = y * (stride + 1);
    raw[rowStart] = filterType;
    filtered.copy(raw, rowStart + 1);
    prev = cur;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = colorType;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const red = () => [255, 0, 0, 255];
const blue = () => [0, 0, 255, 255];

// Deterministic pseudo-random byte, no smooth/linear relationship between
// neighbours (integer hash, not a PRNG stream — same (x,y) always maps to
// the same byte). Used to break the "neighbours are in arithmetic
// progression" property that pure gradients have, which — as derived while
// building this suite — makes the Paeth predictor's a/c tie-break
// unreachable: on a linear ramp the up-left predictor (c) always wins
// outright, so the `<=` vs `<` tie-break mutant is invisible. Noise makes
// left/up/up-left genuinely independent, so exact-tie coincidences (and
// general reconstruction errors) actually occur across a few hundred pixels.
function noiseByte(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h & 0xff;
}

// Horizontal gradient (R), vertical gradient (G), a sharp quadrant edge
// filled with noise (B), and an independent noise channel (A, RGBA only).
// Deliberately not flat: flat/solid color makes every predictor's inputs
// (left/up/up-left) identical, which reconstructs correctly even through a
// broken Average or Paeth formula — that's exactly the coverage gap this
// suite exists to close. Real screenshots are gradients, text edges and
// photos, never flat.
function gradientPx(width, height) {
  const wMax = Math.max(1, width - 1);
  const hMax = Math.max(1, height - 1);
  return (x, y) => {
    const r = Math.round((x / wMax) * 255); // horizontal gradient
    const g = Math.round((y / hMax) * 255); // vertical gradient
    const quadrant = (x < width / 2 ? 0 : 1) ^ (y < height / 2 ? 0 : 1);
    const b = quadrant ? noiseByte(x, y) : 255 - noiseByte(x, y); // sharp edge at the midlines + noisy fill
    const a = noiseByte(x + 1, y + 1);
    return [r, g, b, a];
  };
}

function expectedPixels(width, height, px, colorType) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = px(x, y);
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
      out[o + 3] = colorType === 6 ? a : 255; // RGB has no alpha byte on the wire
    }
  }
  return out;
}

const W = 17;
const H = 13;

test("decodePng round-trips a solid image", () => {
  const img = decodePng(encodePng(4, 3, red));
  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  assert.equal(img.pixels.length, 4 * 3 * 4);
  assert.deepEqual([...img.pixels.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...img.pixels.slice(-4)], [255, 0, 0, 255]);
});

test("decodePng rejects non-PNG input", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
});

test("diffScore is 0 for identical images", () => {
  const a = decodePng(encodePng(8, 8, red));
  const b = decodePng(encodePng(8, 8, red));
  assert.equal(diffScore(a, b).mismatchPct, 0);
  assert.equal(diffScore(a, b).heightDeltaPct, 0);
});

test("diffScore ~50 when half the image differs", () => {
  const a = decodePng(encodePng(8, 8, red));
  const b = decodePng(encodePng(8, 8, (x) => (x < 4 ? red() : blue())));
  const s = diffScore(a, b);
  assert.equal(s.mismatchPct, 50);
});

test("diffScore reports height delta and diffs the overlap", () => {
  const a = decodePng(encodePng(8, 10, red));
  const b = decodePng(encodePng(8, 5, red));
  const s = diffScore(a, b);
  assert.equal(s.mismatchPct, 0);
  assert.equal(s.heightDeltaPct, 50);
  assert.deepEqual(s.overlap, { width: 8, height: 5 });
});

// --- Real coverage: every row filter, both color types -------------------
// Real Chrome CDP screenshots are colorType 2 (RGB) and are dominated by
// Paeth (4), with some Sub/Up/Average — filter 0 (None) never appears. Each
// of the 5 filters is exercised, uniformly, against both supported color
// types, on gradient+edge content that actually stresses the predictors.
for (const colorType of [2, 6]) {
  const label = colorType === 6 ? "RGBA" : "RGB";
  for (const filterType of [0, 1, 2, 3, 4]) {
    test(`decodePng reconstructs filter ${filterType} on colorType ${colorType} (${label}) gradient+edge image`, () => {
      const px = gradientPx(W, H);
      const png = encodePng(W, H, px, { colorType, filters: filterType });
      const img = decodePng(png);
      assert.equal(img.width, W);
      assert.equal(img.height, H);
      assert.deepEqual([...img.pixels], [...expectedPixels(W, H, px, colorType)]);
    });
  }
}

// --- Mixed filters in one image (the prev-row cascade) -------------------
// Real encoders pick a filter per row, not one filter for the whole image.
// Cycling through all 5 filters row-by-row exercises the `prev` row cascade:
// each row's reconstruction depends on the previous row having been
// unfiltered correctly, which is exactly where a subtly-wrong predictor
// compounds into a visibly wrong image (per-channel deltas up to 255).
for (const colorType of [2, 6]) {
  const label = colorType === 6 ? "RGBA" : "RGB";
  test(`decodePng reconstructs a mixed-filter image (rows cycle 0..4, colorType ${colorType} ${label})`, () => {
    const px = gradientPx(W, H);
    const filters = Array.from({ length: H }, (_, y) => y % 5);
    const img = decodePng(encodePng(W, H, px, { colorType, filters }));
    assert.deepEqual([...img.pixels], [...expectedPixels(W, H, px, colorType)]);
    const self = diffScore(img, img);
    assert.equal(self.mismatchPct, 0);
    assert.equal(self.heightDeltaPct, 0);
  });
}

test("decodePng forces alpha to 255 for colorType 2 (RGB carries no alpha byte on the wire)", () => {
  const px = gradientPx(W, H);
  const filters = Array.from({ length: H }, (_, y) => y % 5);
  const img = decodePng(encodePng(W, H, px, { colorType: 2, filters }));
  for (let i = 3; i < img.pixels.length; i += 4) {
    assert.equal(img.pixels[i], 255);
  }
});
