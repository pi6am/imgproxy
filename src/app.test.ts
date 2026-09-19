// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { RouteDeps } from "./api/deps.js";
import type { GenerationPipeline } from "./core/pipeline.js";
import type { HistoryDb } from "./history/db.js";
import type { ImageStore } from "./history/images.js";
import { configSchema, type AppConfig } from "./config/schema.js";

function stubDeps(config: AppConfig = configSchema.parse({})): RouteDeps {
  return {
    pipeline: undefined as unknown as GenerationPipeline,
    db: undefined as unknown as HistoryDb,
    images: undefined as unknown as ImageStore,
    getConfig: () => config,
    saveConfig: () => config,
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
