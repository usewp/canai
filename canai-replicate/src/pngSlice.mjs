import { deflateSync } from "node:zlib";
import { decodePng } from "./pngdiff.mjs";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

export function encodePngRgba(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter 0 (None)
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = rowStart + 1 + x * 4;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colorType RGBA
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function clampBox(box, imgW, imgH) {
  let { left, top, width, height } = box;
  if (width <= 0 || height <= 0) return null;
  // Negative origins read off-buffer in slicePng — shift the box into the
  // image and shrink width/height by the overhang.
  if (left < 0) {
    width += left;
    left = 0;
  }
  if (top < 0) {
    height += top;
    top = 0;
  }
  if (width <= 0 || height <= 0) return null;
  if (left >= imgW || top >= imgH) return null;
  const right = Math.min(left + width, imgW);
  const bottom = Math.min(top + height, imgH);
  const clampedW = right - left;
  const clampedH = bottom - top;
  if (clampedW <= 0 || clampedH <= 0) return null;
  return { left, top, width: clampedW, height: clampedH };
}

export function slicePng(pngBuf, box) {
  const { width: imgW, height: imgH, pixels } = decodePng(pngBuf);
  const clamped = clampBox(box, imgW, imgH);
  if (!clamped) throw new Error("invalid or empty crop box");
  const { left, top, width, height } = clamped;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((top + y) * imgW + (left + x)) * 4;
      const dst = (y * width + x) * 4;
      out[dst] = pixels[src];
      out[dst + 1] = pixels[src + 1];
      out[dst + 2] = pixels[src + 2];
      out[dst + 3] = pixels[src + 3];
    }
  }
  return encodePngRgba(width, height, out);
}

function sanitizeId(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

export function sliceSections(pngBuf, sections) {
  const { width: imgW, height: imgH } = decodePng(pngBuf);
  return sections.map((section, index) => {
    const { id, left, top, width, height } = section;
    const fileName = `${String(index + 1).padStart(2, "0")}-${sanitizeId(id)}.png`;
    const box = clampBox({ left, top, width, height }, imgW, imgH);
    if (!box) {
      return { id, fileName, buffer: null, box: { left, top, width, height }, error: "invalid or empty crop box after clamp" };
    }
    const buffer = slicePng(pngBuf, box);
    return { id, fileName, buffer, box };
  });
}
