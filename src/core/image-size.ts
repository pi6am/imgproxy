// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

/** Best-effort dimension sniffing for PNG, JPEG and WebP; returns undefined when unknown. */
export function imageSize(buf: Uint8Array): ImageDimensions | undefined {
  if (buf.length > 24 && PNG_SIG.every((b, i) => buf[i] === b)) {
    return { width: readU32BE(buf, 16), height: readU32BE(buf, 20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
  if (
    buf.length > 30 &&
    ascii(buf, 0) === "RIFF" &&
    ascii(buf, 8) === "WEBP"
  ) {
    return webpSize(buf);
  }
  return undefined;
}

function jpegSize(b: Uint8Array): ImageDimensions | undefined {
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1]!;
    // SOF0..SOF15 excluding JPEG markers that are not frame headers
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[off + 5]! << 8) | b[off + 6]!;
      const width = (b[off + 7]! << 8) | b[off + 8]!;
      return { width, height };
    }
    const len = (b[off + 2]! << 8) | b[off + 3]!;
    off += 2 + len;
  }
  return undefined;
}

function webpSize(b: Uint8Array): ImageDimensions | undefined {
  const format = ascii(b, 12);
  if (format === "VP8X") {
    return {
      width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
      height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
    };
  }
  if (format === "VP8 ") {
    return {
      width: b[26]! | (b[27]! << 8),
      height: b[28]! | (b[29]! << 8),
    };
  }
  if (format === "VP8L") {
    const bits = readU32LE(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function ascii(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(...buf.subarray(offset, offset + 4));
}

function readU32BE(buf: Uint8Array, offset: number): number {
  const v =
    (buf[offset]! * 2 ** 24) + ((buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!);
  return v >>> 0;
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16) | buf[offset + 3]!) >>> 0;
}
