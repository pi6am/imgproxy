// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryDb } from "./db.js";
import { ImageStore } from "./images.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imgproxy-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// 1x1 red PNG
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("HistoryDb", () => {
  it("round-trips requests and images with cascade delete", () => {
    const db = new HistoryDb(":memory:");
    db.createRequest({
      id: "r1",
      source: "openai",
      providerId: "p1",
      providerType: "comfyui",
      requestJson: '{"prompt":"hi"}',
    });
    db.completeRequest("r1", '{"images":[]}');
    db.addImage({
      id: "i1",
      requestId: "r1",
      filename: "i1.png",
      mime: "image/png",
      bytes: 100,
    });

    const list = db.listRequests(10, 0);
    expect(list.total).toBe(1);
    expect(list.items[0]!.id).toBe("r1");
    expect(list.items[0]!.status).toBe("succeeded");
    expect(list.items[0]!.image_count).toBe(1);
    expect(list.items[0]!.thumb_image_id).toBe("i1");

    expect(db.listImages("r1")).toHaveLength(1);
    expect(db.getImage("i1")!.filename).toBe("i1.png");

    const files = db.deleteRequest("r1");
    expect(files).toEqual(["i1.png"]);
    expect(db.listRequests(10, 0).total).toBe(0);
    expect(db.getImage("i1")).toBeUndefined();
  });

  it("records failures and marks stale pending rows on restart", () => {
    const db = new HistoryDb(":memory:");
    db.createRequest({ id: "r2", source: "ui", providerId: "p", providerType: "openai", requestJson: "{}" });
    db.failRequest("r2", "boom");

    db.createRequest({ id: "r3", source: "ui", providerId: "p", providerType: "openai", requestJson: "{}" });

    const reopened = new HistoryDb(":memory:"); // separate DB, so simulate restart on same file instead
    void reopened;

    expect(db.getRequest("r2")!.status).toBe("failed");
    expect(db.getRequest("r2")!.error).toBe("boom");

    // simulate restart behavior on a fresh instance over the same memory DB is not possible;
    // verify via the same statement path using a file-backed DB
    const dir = tmpDir();
    const file = path.join(dir, "h.db");
    const fdb = new HistoryDb(file);
    fdb.createRequest({ id: "r4", source: "ui", providerId: "p", providerType: "openai", requestJson: "{}" });
    fdb.close();
    const fdb2 = new HistoryDb(file);
    expect(fdb2.getRequest("r4")!.status).toBe("failed");
    expect(fdb2.getRequest("r4")!.error).toContain("interrupted");
    fdb2.close();
  });

  it("clears everything and returns filenames", () => {
    const db = new HistoryDb(":memory:");
    db.createRequest({ id: "r5", source: "a1111", providerId: "p", providerType: "a1111", requestJson: "{}" });
    db.addImage({ id: "i5", requestId: "r5", filename: "a.png", mime: "image/png", bytes: 1 });
    const files = db.clear();
    expect(files).toEqual(["a.png"]);
    expect(db.listRequests(10, 0).total).toBe(0);
  });
});

describe("ImageStore", () => {
  it("saves images, sniffs dimensions, and rejects traversal", () => {
    const dir = tmpDir();
    const store = new ImageStore(path.join(dir, "images"));
    const meta = store.save(PNG_1x1, "image/png", "req1");
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.filename.endsWith(".png")).toBe(true);

    const resolved = store.resolve(meta.filename);
    expect(resolved.startsWith(path.join(dir, "images"))).toBe(true);

    expect(store.resolve("../../etc/passwd").split(path.sep).includes("..")).toBe(false);

    store.delete(meta.filename);
  });

  it("keeps non-persisted images in memory only, with oldest-first eviction", () => {
    const dir = tmpDir();
    const store = new ImageStore(path.join(dir, "images"), { maxImages: 2, maxBytes: 1024 * 1024 });

    const a1 = store.save(PNG_1x1, "image/png", "reqA", false);
    const a2 = store.save(PNG_1x1, "image/png", "reqA", false);
    expect(readdirSync(path.join(dir, "images"))).toEqual([]);
    expect(store.fetch(a1.imageId)!.data.length).toBe(PNG_1x1.length);
    expect(store.fetch(a1.imageId)!.mime).toBe("image/png");

    const b1 = store.save(PNG_1x1, "image/png", "reqB", false); // evicts a1
    expect(store.fetch(a1.imageId)).toBeUndefined();
    expect(store.fetch(a2.imageId)).toBeDefined();

    store.save(PNG_1x1, "image/png", "reqB", false); // evicts a2
    expect(store.fetch(a2.imageId)).toBeUndefined();
    expect(store.fetch(b1.imageId)).toBeDefined();
  });

  it("never evicts images of the request currently being saved", () => {
    const dir = tmpDir();
    const store = new ImageStore(path.join(dir, "images"), { maxImages: 1, maxBytes: 1024 * 1024 });

    const a1 = store.save(PNG_1x1, "image/png", "reqA", false);
    const a2 = store.save(PNG_1x1, "image/png", "reqA", false); // over cap, same request: kept
    expect(store.fetch(a1.imageId)).toBeDefined();
    expect(store.fetch(a2.imageId)).toBeDefined();

    store.save(PNG_1x1, "image/png", "reqB", false); // now reqA's images go
    expect(store.fetch(a1.imageId)).toBeUndefined();
    expect(store.fetch(a2.imageId)).toBeUndefined();
  });
});
