import { describe, expect, it } from "vitest";
import { imageSize } from "./image-size.js";

// Minimal crafted buffers for the dimension sniffer.
const PNG_2x2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAACZgbYnAAAAFUlEQVR42mNk+M+ACzDhVQ4CAAvwATkP0aAAAAAAAElFTkSuQmCC",
  "base64",
);

function jpegHeader(w: number, h: number): Buffer {
  // SOI + standard JFIF APP0 + SOF0 carrying the dimensions
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x01, 0x11, 0x00,
  ]);
}

describe("imageSize", () => {
  it("reads PNG dimensions", () => {
    expect(imageSize(PNG_2x2)).toEqual({ width: 2, height: 2 });
  });

  it("reads JPEG dimensions", () => {
    expect(imageSize(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("returns undefined for unknown data", () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});
