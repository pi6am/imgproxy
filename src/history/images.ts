// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "../core/image-size.js";
export interface StoredImageMeta {
  imageId: string;
  requestId: string;
  filename: string;
  mime: string;
  width?: number;
  height?: number;
  bytes: number;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export class ImageStore {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  save(data: Uint8Array, mime: string, requestId: string): StoredImageMeta {
    const imageId = randomUUID();
    const ext = EXT_BY_MIME[mime] ?? "png";
    const filename = `${imageId}.${ext}`;
    fs.writeFileSync(path.join(this.dir, filename), data);
    const dims = imageSize(data);
    return {
      imageId,
      requestId,
      filename,
      mime,
      width: dims?.width,
      height: dims?.height,
      bytes: data.byteLength,
    };
  }

  /** Resolves a stored filename to an absolute path; rejects path traversal. */
  resolve(filename: string): string {
    return path.join(this.dir, path.basename(filename));
  }

  delete(filename: string): void {
    fs.rmSync(this.resolve(filename), { force: true });
  }
}
