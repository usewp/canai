// Dependency-free PNG decode + pixel diff for verify. Supports what CDP
// screenshots actually are: 8-bit, color type 6 (RGBA) or 2 (RGB), no
// interlace. Anything else throws — verify treats that as "no score,
// eyeball the pair" rather than failing the run.

import { inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (!ihdr || idat.length === 0) throw new Error("truncated PNG");
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0 || (ihdr.colorType !== 6 && ihdr.colorType !== 2)) {
    throw new Error(
      `unsupported PNG (depth=${ihdr.bitDepth} colorType=${ihdr.colorType} interlace=${ihdr.interlace})`,
    );
  }
  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(ihdr.width * ihdr.height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0; // left
      const b = prev[x]; // up
      const c = x >= bpp ? prev[x - bpp] : 0; // up-left
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      cur[x] = v;
    }
    for (let px = 0; px < ihdr.width; px++) {
      const o = (y * ihdr.width + px) * 4;
      const i = px * bpp;
      out[o] = cur[i];
      out[o + 1] = cur[i + 1];
      out[o + 2] = cur[i + 2];
      out[o + 3] = bpp === 4 ? cur[i + 3] : 255;
    }
    prev = cur;
  }
  return { width: ihdr.width, height: ihdr.height, pixels: out };
}

// Compare the overlapping top-left region pixel-by-pixel. A pixel mismatches
// when any RGB channel differs by more than `threshold` (anti-aliasing and
// font-rendering noise stay under it). Height difference is reported
// separately — a generated page 2× the original's height is itself a signal.
export function diffScore(a, b, { threshold = 32 } = {}) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  if (w === 0 || h === 0) throw new Error("empty image");
  let mismatched = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      if (
        Math.abs(a.pixels[ia] - b.pixels[ib]) > threshold ||
        Math.abs(a.pixels[ia + 1] - b.pixels[ib + 1]) > threshold ||
        Math.abs(a.pixels[ia + 2] - b.pixels[ib + 2]) > threshold
      ) {
        mismatched++;
      }
    }
  }
  return {
    mismatchPct: (mismatched / (w * h)) * 100,
    heightDeltaPct: (Math.abs(a.height - b.height) / Math.max(a.height, b.height)) * 100,
    overlap: { width: w, height: h },
  };
}
