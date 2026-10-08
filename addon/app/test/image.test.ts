import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  applyContrast,
  decodePng,
  encodeGrayPng,
  grayPalette,
  processScreenshot,
  quantise,
  rgbaToGray,
  rotate,
  type GrayImage,
} from "../src/image.js";

function gray(width: number, height: number, fill: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return { width, height, data };
}

describe("rgbaToGray", () => {
  it("uses luma and composites alpha over white", () => {
    const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
    const g = rgbaToGray(rgba, 4, 1);
    expect(Array.from(g.data)).toEqual([255, 0, 255, 76]);
  });
  it("rejects wrong buffer sizes", () => {
    expect(() => rgbaToGray(new Uint8Array(3), 1, 1)).toThrow();
  });
});

describe("applyContrast", () => {
  it("leaves the image untouched at 1.0", () => {
    const img = gray(3, 1, (x) => x * 100);
    expect(applyContrast(img, 1)).toBe(img);
  });
  it("pushes values away from mid-gray and clamps", () => {
    const img = gray(3, 1, (x) => [0, 128, 200][x] ?? 0);
    const out = applyContrast(img, 2);
    expect(Array.from(out.data)).toEqual([0, 128, 255]);
  });
});

describe("rotate", () => {
  const img = gray(3, 2, (x, y) => y * 3 + x); // [[0,1,2],[3,4,5]]
  it("90 degrees clockwise", () => {
    const r = rotate(img, 90);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(Array.from(r.data)).toEqual([3, 0, 4, 1, 5, 2]);
  });
  it("180 degrees", () => {
    const r = rotate(img, 180);
    expect([r.width, r.height]).toEqual([3, 2]);
    expect(Array.from(r.data)).toEqual([5, 4, 3, 2, 1, 0]);
  });
  it("270 degrees", () => {
    const r = rotate(img, 270);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(Array.from(r.data)).toEqual([2, 5, 1, 4, 0, 3]);
  });
  it("rotating 90 four times is identity", () => {
    let r = img;
    for (let i = 0; i < 4; i++) r = rotate(r, 90);
    expect(Array.from(r.data)).toEqual(Array.from(img.data));
  });
});

describe("quantise", () => {
  it("builds an evenly spaced palette", () => {
    expect(Array.from(grayPalette(2))).toEqual([0, 255]);
    expect(Array.from(grayPalette(16))[1]).toBe(17);
  });
  it("only emits palette values with and without dithering", () => {
    const img = gray(64, 64, (x, y) => (x * 4 + y) % 256);
    for (const dither of [false, true]) {
      const out = quantise(img, 16, dither);
      const pal = new Set(grayPalette(16));
      for (const v of out.data) expect(pal.has(v)).toBe(true);
    }
  });
  it("dithering preserves the mean brightness roughly", () => {
    const img = gray(128, 128, () => 100);
    const out = quantise(img, 4, true);
    const mean = out.data.reduce((a, b) => a + b, 0) / out.data.length;
    expect(Math.abs(mean - 100)).toBeLessThan(3);
    const unique = new Set(out.data);
    expect(unique.size).toBeGreaterThan(1);
  });
  it("without dithering a flat image stays flat", () => {
    const img = gray(8, 8, () => 100);
    const out = quantise(img, 4, false);
    expect(new Set(out.data).size).toBe(1);
  });
  it("256 levels is a no-op", () => {
    const img = gray(4, 4, (x) => x * 50);
    expect(quantise(img, 256, true)).toBe(img);
  });
});

describe("PNG encoding", () => {
  it("writes an 8-bit grayscale PNG that decodes back", () => {
    const img = gray(5, 3, (x, y) => (x + y) * 20);
    const buf = encodeGrayPng(img);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: width(4) height(4) bitdepth(1) colortype(1)
    expect(buf.readUInt32BE(16)).toBe(5);
    expect(buf.readUInt32BE(20)).toBe(3);
    expect(buf[24]).toBe(8);
    expect(buf[25]).toBe(0);
    const back = decodePng(buf);
    expect(back.width).toBe(5);
    for (let i = 0; i < img.data.length; i++) {
      expect(back.data[i * 4]).toBe(img.data[i]);
      expect(back.data[i * 4 + 3]).toBe(255);
    }
  });
});

describe("processScreenshot", () => {
  it("turns an RGBA screenshot into a rotated gray PNG", () => {
    const png = new PNG({ width: 4, height: 2 });
    for (let i = 0; i < 8; i++) {
      png.data[i * 4] = i * 30;
      png.data[i * 4 + 1] = i * 30;
      png.data[i * 4 + 2] = i * 30;
      png.data[i * 4 + 3] = 255;
    }
    const src = PNG.sync.write(png);
    const out = processScreenshot(src, { rotation: 90, contrast: 1, grayLevels: 16, dither: false });
    expect([out.width, out.height]).toEqual([2, 4]);
    expect(out.png[25]).toBe(0);
  });
});
