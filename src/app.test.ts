// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { RouteDeps } from "./api/deps.js";
import type { GenerationPipeline } from "./core/pipeline.js";
import { HistoryDb } from "./history/db.js";
import { ImageStore } from "./history/images.js";
import { configSchema, type AppConfig } from "./config/schema.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// 1x1 red PNG
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function stubDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const config: AppConfig = configSchema.parse({});
  return {
    pipeline: undefined as unknown as GenerationPipeline,
    db: undefined as unknown as HistoryDb,
    images: undefined as unknown as ImageStore,
    getConfig: () => config,
    saveConfig: () => config,
    ...overrides,
  };
}

describe("CORS scoping", () => {
  it("sends CORS headers on public API surfaces", async () => {
    const app = buildApp(stubDeps());
    const res = await app.inject({ method: "OPTIONS", url: "/v1/images/generations" });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const res2 = await app.inject({ method: "OPTIONS", url: "/sdapi/v1/txt2img" });
    expect(res2.headers["access-control-allow-origin"]).toBe("*");
  });

  it("never sends CORS headers on /api admin routes", async () => {
    const app = buildApp(stubDeps());
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not approve cross-origin preflights for /api admin routes", async () => {
    const app = buildApp(stubDeps());
    const res = await app.inject({ method: "OPTIONS", url: "/api/config" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });
});

describe("image serving with history disabled", () => {
  it("serves in-memory images that have no history row", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "imgproxy-test-"));
    tmpDirs.push(dir);
    const images = new ImageStore(path.join(dir, "images"));
    const meta = images.save(PNG_1x1, "image/png", "r1", false);
    expect(readdirSync(path.join(dir, "images"))).toEqual([]);

    const app = buildApp(
      stubDeps({ db: { getImage: () => undefined } as unknown as HistoryDb, images }),
    );
    const res = await app.inject({ method: "GET", url: `/api/images/${meta.imageId}/file` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.length).toBe(PNG_1x1.length);
  });

  it("still serves persisted images via their history row", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "imgproxy-test-"));
    tmpDirs.push(dir);
    const images = new ImageStore(path.join(dir, "images"));
    const meta = images.save(PNG_1x1, "image/png", "r1", true);

    const app = buildApp(
      stubDeps({
        db: { getImage: () => ({ filename: meta.filename, mime: "image/png" }) } as unknown as HistoryDb,
        images,
      }),
    );
    const res = await app.inject({ method: "GET", url: `/api/images/${meta.imageId}/file` });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(PNG_1x1.length);
  });
});

describe("DELETE /api/history/failed", () => {
  it("removes failed requests but keeps everything else (and is not eaten by /:id)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "imgproxy-test-"));
    tmpDirs.push(dir);
    const images = new ImageStore(path.join(dir, "images"));
    const meta = images.save(PNG_1x1, "image/png", "ok1", true);
    const db = new HistoryDb(":memory:");
    db.createRequest({ id: "f1", source: "ui", providerId: "p", providerType: "sdcpp", requestJson: "{}" });
    db.failRequest("f1", "interrupted by server restart");
    db.createRequest({ id: "ok1", source: "ui", providerId: "p", providerType: "comfyui", requestJson: "{}" });
    db.completeRequest("ok1", "{}");
    db.addImage({
      id: meta.imageId,
      requestId: "ok1",
      filename: meta.filename,
      mime: "image/png",
      bytes: PNG_1x1.length,
    });

    const app = buildApp(stubDeps({ db, images }));
    const res = await app.inject({ method: "DELETE", url: "/api/history/failed" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cleared: true });
    expect(db.getRequest("f1")).toBeUndefined();
    expect(db.getRequest("ok1")!.status).toBe("succeeded");
    // the kept image is still on disk and served
    expect(readdirSync(path.join(dir, "images"))).toContain(meta.filename);
    const img = await app.inject({ method: "GET", url: `/api/images/${meta.imageId}/file` });
    expect(img.statusCode).toBe(200);
  });
});
