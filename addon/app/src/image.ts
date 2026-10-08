import { PNG } from "pngjs";
import type { Rotation } from "./config.js";

export interface GrayImage {
  width: number;
  height: number;
  /** One byte per pixel, 0 = black, 255 = white. */
  data: Uint8Array;
}

/** Converts RGBA (as produced by pngjs) into an 8-bit luminance image. */
export function rgbaToGray(rgba: Uint8Array, width: number, height: number): GrayImage {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgbaToGray: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    const a = (rgba[p + 3] ?? 255) / 255;
    // Rec. 601 luma, alpha composited over white.
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = Math.round(y * a + 255 * (1 - a));
  }
  return { width, height, data };
}

/** Applies a contrast multiplier around mid-gray. 1.0 leaves the image unchanged. */
export function applyContrast(img: GrayImage, contrast: number): GrayImage {
  if (contrast === 1) return img;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const c = (v - 128) * contrast + 128;
    lut[v] = c < 0 ? 0 : c > 255 ? 255 : Math.round(c);
  }
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i++) data[i] = lut[img.data[i] ?? 0] ?? 0;
  return { width: img.width, height: img.height, data };
}

/** Rotates clockwise by 0/90/180/270 degrees. */
export function rotate(img: GrayImage, rotation: Rotation): GrayImage {
  const { width: w, height: h, data } = img;
  if (rotation === 0) return img;
  if (rotation === 180) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[data.length - 1 - i] = data[i] ?? 0;
    return { width: w, height: h, data: out };
  }
  const out = new Uint8Array(data.length);
  // Output has swapped dimensions.
  const ow = h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x] ?? 0;
      if (rotation === 90) {
        // (x, y) -> (ow - 1 - y, x)
        out[x * ow + (ow - 1 - y)] = v;
      } else {
        // 270: (x, y) -> (y, w - 1 - x)
        out[(w - 1 - x) * ow + y] = v;
      }
    }
  }
  return { width: h, height: w, data: out };
}

/** Returns the palette of `levels` evenly spaced gray values from 0 to 255. */
export function grayPalette(levels: number): Uint8Array {
  const n = Math.max(2, Math.min(256, Math.round(levels)));
  const pal = new Uint8Array(n);
  for (let i = 0; i < n; i++) pal[i] = Math.round((i * 255) / (n - 1));
  return pal;
}

/**
 * Quantises to `levels` gray values, optionally with serpentine Floyd-Steinberg dithering.
 * The result still uses 8-bit samples (0..255) so any PNG viewer and fbink can read it.
 */
export function quantise(img: GrayImage, levels: number, dither: boolean): GrayImage {
  const { width: w, height: h } = img;
  const n = Math.max(2, Math.min(256, Math.round(levels)));
  if (n === 256) return img;
  const step = 255 / (n - 1);
  const out = new Uint8Array(w * h);

  if (!dither) {
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.round(Math.round((img.data[i] ?? 0) / step) * step);
    }
    return { width: w, height: h, data: out };
  }

  // Error buffers for the current and next row (with 1px padding on each side).
  let cur = new Float32Array(w + 2);
  let next = new Float32Array(w + 2);
  for (let y = 0; y < h; y++) {
    next.fill(0);
    const ltr = y % 2 === 0;
    for (let k = 0; k < w; k++) {
      const x = ltr ? k : w - 1 - k;
      const idx = y * w + x;
      const old = (img.data[idx] ?? 0) + (cur[x + 1] ?? 0);
      const q = Math.round(old / step) * step;
      const v = q < 0 ? 0 : q > 255 ? 255 : q;
      out[idx] = Math.round(v);
      const err = old - v;
      const dx = ltr ? 1 : -1;
      cur[x + 1 + dx] = (cur[x + 1 + dx] ?? 0) + err * (7 / 16);
      next[x + 1 - dx] = (next[x + 1 - dx] ?? 0) + err * (3 / 16);
      next[x + 1] = (next[x + 1] ?? 0) + err * (5 / 16);
      next[x + 1 + dx] = (next[x + 1 + dx] ?? 0) + err * (1 / 16);
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  return { width: w, height: h, data: out };
}

/** Encodes an 8-bit grayscale PNG (colour type 0, no alpha). */
export function encodeGrayPng(img: GrayImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height, colorType: 0, inputColorType: 0, bitDepth: 8 });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: 0, inputColorType: 0, bitDepth: 8 });
}

/** Decodes any PNG into RGBA using pngjs. */
export function decodePng(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

export interface ProcessOptions {
  rotation: Rotation;
  contrast: number;
  grayLevels: number;
  dither: boolean;
}

/** Full pipeline: RGBA screenshot PNG -> e-ink friendly 8-bit grayscale PNG. */
export function processScreenshot(screenshotPng: Buffer, opts: ProcessOptions): { png: Buffer; width: number; height: number } {
  const decoded = decodePng(screenshotPng);
  let img = rgbaToGray(decoded.data, decoded.width, decoded.height);
  img = applyContrast(img, opts.contrast);
  img = quantise(img, opts.grayLevels, opts.dither);
  img = rotate(img, opts.rotation);
  return { png: encodeGrayPng(img), width: img.width, height: img.height };
}
