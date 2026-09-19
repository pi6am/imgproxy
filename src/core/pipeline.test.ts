// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryDb } from "../history/db.js";
import { ImageStore } from "../history/images.js";
import { GenerationPipeline } from "./pipeline.js";
import type { ProviderRegistry } from "./registry.js";
import type { Provider } from "./types.js";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imgproxy-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// 1x1 red PNG
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function stubRegistry(override?: Partial<Provider>): ProviderRegistry {
  const provider: Provider = {
    id: "p1",
    name: "stub",
    type: "stub",
    generate: async () => ({ images: [{ data: PNG_1x1, mime: "image/png" }], meta: { seed: 42 } }),
    check: async () => ({ ok: true, detail: "ok" }),
    ...override,
  };
  return { active: provider, get: () => provider } as unknown as ProviderRegistry;
}

describe("GenerationPipeline history recording", () => {
  it("records requests and images when enabled", async () => {
    const db = new HistoryDb(":memory:");
    const images = new ImageStore(tmpDir() + "/images");
    const pipeline = new GenerationPipeline(stubRegistry(), db, images);

    const result = await pipeline.run({ source: "ui", prompt: "a cat", n: 1 });

    expect(db.listRequests(10, 0).total).toBe(1);
    expect(db.listImages(result.requestId)).toHaveLength(1);
    expect(db.getRequest(result.requestId)!.status).toBe("succeeded");
  });

  it("keeps images in memory only when history is disabled", async () => {
    const db = new HistoryDb(":memory:");
    const dir = tmpDir();
    const images = new ImageStore(path.join(dir, "images"));
    const pipeline = new GenerationPipeline(stubRegistry(), db, images, () => false);

    const result = await pipeline.run({ source: "ui", prompt: "a cat", n: 1 });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.url).toBe(`/api/images/${result.images[0]!.imageId}/file`);
    expect(db.listRequests(10, 0).total).toBe(0);
    expect(readdirSync(path.join(dir, "images"))).toEqual([]);
    expect(images.fetch(result.images[0]!.imageId)).toEqual({ data: Buffer.from(PNG_1x1), mime: "image/png" });
  });

  it("records provider failures when enabled and skips them when disabled", async () => {
    const db = new HistoryDb(":memory:");
    const db2 = new HistoryDb(":memory:");
    const images = new ImageStore(tmpDir() + "/images");
    const failing = stubRegistry({
      generate: async () => {
        throw new Error("boom");
      },
    });

    await expect(new GenerationPipeline(failing, db, images).run({ source: "ui", prompt: "x", n: 1 })).rejects.toThrow(
      "boom",
    );
    expect(db.listRequests(10, 0).items[0]!.status).toBe("failed");

    await expect(
      new GenerationPipeline(failing, db2, images, () => false).run({ source: "ui", prompt: "x", n: 1 }),
    ).rejects.toThrow("boom");
    expect(db2.listRequests(10, 0).total).toBe(0);
  });
});
