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

/** Retention caps for images generated while history recording is disabled. */
export interface EphemeralLimits {
  maxImages: number;
  maxBytes: number;
}

interface EphemeralImage {
  data: Buffer;
  mime: string;
  requestId: string;
  bytes: number;
}

const DEFAULT_EPHEMERAL_LIMITS: EphemeralLimits = {
  maxImages: 32,
  maxBytes: 256 * 1024 * 1024,
};

export class ImageStore {
  /** Insertion-ordered: oldest entries are evicted first. */
  private ephemeral = new Map<string, EphemeralImage>();
  private ephemeralBytes = 0;

  constructor(
    readonly dir: string,
    private limits: EphemeralLimits = DEFAULT_EPHEMERAL_LIMITS,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Stores a generated image. Persisted images are written to disk (tracked
   * in history); non-persisted ones are held in memory only, long enough to
   * serve responses, and evicted under the retention caps.
   */
  save(data: Uint8Array, mime: string, requestId: string, persist = true): StoredImageMeta {
    const imageId = randomUUID();
    const ext = EXT_BY_MIME[mime] ?? "png";
    const filename = `${imageId}.${ext}`;
    const dims = imageSize(data);
    if (persist) {
      fs.writeFileSync(path.join(this.dir, filename), data);
    } else {
      this.ephemeral.set(imageId, { data: Buffer.from(data), mime, requestId, bytes: data.byteLength });
      this.ephemeralBytes += data.byteLength;
      this.evictEphemeral(requestId);
    }
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

  /** Returns an in-memory (non-persisted) image, or undefined once evicted. */
  fetch(imageId: string): { data: Buffer; mime: string } | undefined {
    const entry = this.ephemeral.get(imageId);
    return entry ? { data: entry.data, mime: entry.mime } : undefined;
  }

  /** Resolves a stored filename to an absolute path; rejects path traversal. */
  resolve(filename: string): string {
    return path.join(this.dir, path.basename(filename));
  }

  delete(filename: string): void {
    fs.rmSync(this.resolve(filename), { force: true });
  }

  /**
   * Drops the oldest ephemeral images until both caps hold. Images of the
   * request currently being saved are never evicted, so its response can
   * always be served (a single huge request may exceed the caps).
   */
  private evictEphemeral(currentRequestId: string): void {
    for (const [id, entry] of this.ephemeral) {
      if (this.ephemeral.size <= this.limits.maxImages && this.ephemeralBytes <= this.limits.maxBytes) break;
      if (entry.requestId === currentRequestId) continue;
      this.ephemeral.delete(id);
      this.ephemeralBytes -= entry.bytes;
    }
  }
}
