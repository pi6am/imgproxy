// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { configSchema, type AppConfig } from "../config/schema.js";
import type { GenerationPipeline } from "../core/pipeline.js";
import type { HistoryDb } from "../history/db.js";
import type { ImageStore } from "../history/images.js";
import type { RouteDeps } from "./deps.js";

function stubDeps(config: AppConfig = configSchema.parse({})): RouteDeps {
  const pipeline = {
    run: async () => ({
      requestId: "r1",
      status: "succeeded",
      images: [{ imageId: "img1", url: "/api/images/img1/file" }],
    }),
  } as unknown as GenerationPipeline;
  return {
    pipeline,
    db: undefined as unknown as HistoryDb,
    images: undefined as unknown as ImageStore,
    getConfig: () => config,
    saveConfig: () => config,
  };
}

async function generateUrl(host?: string): Promise<string> {
  const app = buildApp(stubDeps());
  const res = await app.inject({
    method: "POST",
    url: "/v1/images/generations",
    headers: host === undefined ? {} : { host },
    payload: { prompt: "a cat", response_format: "url" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data[0].url as string;
}

describe("response URL origin", () => {
  it("reflects a well-formed Host header", async () => {
    expect(await generateUrl("192.168.1.50:7800")).toBe("http://192.168.1.50:7800/api/images/img1/file");
    expect(await generateUrl("[::1]:7800")).toBe("http://[::1]:7800/api/images/img1/file");
  });

  it("falls back to the configured address for malformed Host headers", async () => {
    for (const host of ["evil.com/path", "user@evil.com", "http://evil.com", "evil.com:999999"]) {
      expect(await generateUrl(host)).toBe("http://127.0.0.1:7800/api/images/img1/file");
    }
  });

  it("refuses requests that hopped through too many imgproxy instances", async () => {
    const app = buildApp(stubDeps());
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { "x-imgproxy-depth": "99" },
      payload: { prompt: "a cat" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/forwarded through 99 imgproxy instances/);
  });
});
