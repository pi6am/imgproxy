// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { configSchema, type AppConfig, type ComfyUIProviderConfig, type ProviderConfig } from "../config/schema.js";
import type { GenerationPipeline } from "../core/pipeline.js";
import { GenerationError } from "../core/types.js";
import type { HistoryDb } from "../history/db.js";
import { ImageStore } from "../history/images.js";
import type { RouteDeps } from "./deps.js";

// 1x1 red PNG
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

function comfyProvider(): ComfyUIProviderConfig {
  return {
    id: "c1",
    name: "Comfy",
    type: "comfyui",
    baseUrl: "http://comfy.test",
    apiKey: "",
    workflow: { "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev.safetensors" } } },
    mapping: { model: { node: "1", input: "ckpt_name" } },
    defaults: {},
    pollIntervalMs: 500,
    timeoutMs: 60_000,
  };
}

function openAIProvider() {
  return {
    id: "o1",
    name: "OpenAI",
    type: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-image-1",
    timeoutMs: 300_000,
  };
}

function a1111Provider() {
  return {
    id: "a1",
    name: "A1111",
    type: "a1111" as const,
    baseUrl: "http://a1111.test",
    apiKey: "",
    timeoutMs: 300_000,
  };
}

function sdcppProvider() {
  return {
    id: "s1",
    name: "sd-cpp",
    type: "sdcpp" as const,
    baseUrl: "http://sd.test",
    apiKey: "",
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  };
}

function makeConfig(providers: ProviderConfig[], overrides: Partial<AppConfig> = {}): AppConfig {
  const config = configSchema.parse({});
  config.providers = providers;
  config.activeProviderId = providers[0]?.id ?? "";
  return { ...config, ...overrides };
}

function makeDeps(config: AppConfig, run: (req: unknown) => Promise<unknown>): { deps: RouteDeps; images: ImageStore } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imgproxy-sdcpp-test-"));
  tmpDirs.push(dir);
  const images = new ImageStore(path.join(dir, "images"));
  const deps: RouteDeps = {
    pipeline: { run } as unknown as GenerationPipeline,
    db: { getImage: () => undefined } as unknown as HistoryDb,
    images,
    getConfig: () => config,
    saveConfig: vi.fn(() => config),
  };
  return { deps, images };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init) ?? new Response("not found", { status: 404 });
    }),
  );
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GET /sdcpp/v1/capabilities", () => {
  it("answers locally as a health check, with CORS headers", async () => {
    const fetchSpy = stubFetch(() => undefined);
    const { deps } = makeDeps(makeConfig([comfyProvider()]), vi.fn());

    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/sdcpp/v1/capabilities" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.supported_modes).toEqual(["img_gen"]);
    expect(body.current_mode).toBe("img_gen");
    expect(body.samplers).toContain("Euler a");
    expect(body.schedulers).toContain("Karras");
    expect(body.limits).toMatchObject({ max_batch_count: 16 });
    // model comes from local config only — never an upstream call
    expect(body.model).toEqual({ name: "flux1-dev.safetensors", stem: "flux1-dev.safetensors" });
    expect(fetchSpy.calls).toHaveLength(0);

    const preflight = await app.inject({ method: "OPTIONS", url: "/sdcpp/v1/capabilities" });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
  });

  it("advertises lora support only for sd-cpp backends", async () => {
    for (const [provider, lora] of [
      [sdcppProvider(), true],
      [comfyProvider(), false],
    ] as const) {
      const { deps } = makeDeps(makeConfig([provider]), vi.fn());
      const res = await buildApp(deps).inject({ method: "GET", url: "/sdcpp/v1/capabilities" });
      expect(res.json().features.lora).toBe(lora);
    }
  });

  it("is 404 when the API is disabled", async () => {
    const config = makeConfig([comfyProvider()]);
    config.apis.sdcpp.enabled = false;
    const { deps } = makeDeps(config, vi.fn());
    const res = await buildApp(deps).inject({ method: "GET", url: "/sdcpp/v1/capabilities" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "api_disabled" });
  });
});

describe("POST /sdcpp/v1/img_gen", () => {
  it("submits an async job that completes with the generated image", async () => {
    const gate = deferred<void>();
    let produce: () => { requestId: string; status: string; images: Array<{ imageId: string; url: string; mime: string }> };
    const run = vi.fn(async () => {
      await gate.promise;
      return produce();
    });
    const { deps, images } = makeDeps(makeConfig([comfyProvider()]), run as never);
    produce = () => {
      const meta = images.save(PNG_1x1, "image/png", "r1", false);
      return {
        requestId: "r1",
        status: "succeeded",
        images: [{ imageId: meta.imageId, url: `/api/images/${meta.imageId}/file`, mime: "image/png" }],
      };
    };

    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/img_gen",
      payload: {
        prompt: "a cat astronaut",
        negative_prompt: "blurry",
        width: 1024,
        height: 768,
        seed: 123,
        sample_params: { sample_method: "euler_a", scheduler: "discrete", sample_steps: 12, guidance: { txt_cfg: 3.5 } },
        lora: [{ path: "stylize.safetensors", multiplier: 0.5 }],
      },
    });

    expect(res.statusCode).toBe(202);
    const submitted = res.json();
    expect(submitted).toMatchObject({ kind: "img_gen", status: "queued" });
    expect(submitted.poll_url).toBe(`/sdcpp/v1/jobs/${submitted.id}`);

    // vocabulary is normalized to the internal A1111 names
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "sdcpp",
        prompt: "a cat astronaut",
        negativePrompt: "blurry",
        width: 1024,
        height: 768,
        steps: 12,
        cfgScale: 3.5,
        seed: 123,
        sampler: "Euler a",
        scheduler: "Automatic",
        n: 1,
        lora: [{ path: "stylize.safetensors", multiplier: 0.5 }],
      }),
    );

    // while the pipeline runs, the job reports generating
    const pending = await app.inject({ method: "GET", url: submitted.poll_url });
    expect(pending.json()).toMatchObject({ id: submitted.id, status: "generating", result: null });

    gate.resolve();
    await tick();

    const done = await app.inject({ method: "GET", url: submitted.poll_url });
    const body = done.json();
    expect(body.status).toBe("completed");
    expect(body.result.output_format).toBe("png");
    expect(body.result.images[0].b64_json).toBe(PNG_1x1.toString("base64"));
  });

  it("fails the job when the pipeline errors", async () => {
    const run = vi.fn(async () => {
      throw new GenerationError("Provider 'Comfy' failed: boom");
    });
    const { deps } = makeDeps(makeConfig([comfyProvider()]), run as never);

    const app = buildApp(deps);
    const res = await app.inject({ method: "POST", url: "/sdcpp/v1/img_gen", payload: { prompt: "x" } });
    await tick();

    const job = await app.inject({ method: "GET", url: res.json().poll_url });
    expect(job.json()).toMatchObject({
      status: "failed",
      error: { code: "generation_failed", message: "Provider 'Comfy' failed: boom" },
    });
  });

  it("reports 410 when a completed job's images were evicted", async () => {
    const { deps, images } = makeDeps(
      makeConfig([comfyProvider()]),
      vi.fn(async () => ({
        requestId: "r1",
        status: "succeeded",
        images: [],
      })) as never,
    );
    const meta = images.save(PNG_1x1, "image/png", "r1", false);
    const run = vi.fn(async () => ({
      requestId: "r1",
      status: "succeeded",
      images: [{ imageId: meta.imageId, url: "", mime: "image/png" }],
    }));
    (deps.pipeline as { run: unknown }).run = run;

    const app = buildApp(deps);
    const res = await app.inject({ method: "POST", url: "/sdcpp/v1/img_gen", payload: { prompt: "x" } });
    await tick();
    expect((await app.inject({ method: "GET", url: res.json().poll_url })).json().status).toBe("completed");

    // overflow the ephemeral store (32-image cap) so the job's image is evicted
    for (let i = 0; i < 40; i++) images.save(PNG_1x1, "image/png", `other-${i}`, false);

    const gone = await app.inject({ method: "GET", url: res.json().poll_url });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ code: "job_result_expired" });
  });

  it("rejects invalid or unsupported requests", async () => {
    const { deps } = makeDeps(makeConfig([comfyProvider()]), vi.fn() as never);
    const app = buildApp(deps);

    const noPrompt = await app.inject({ method: "POST", url: "/sdcpp/v1/img_gen", payload: {} });
    expect(noPrompt.statusCode).toBe(400);
    expect(noPrompt.json()).toMatchObject({ code: "invalid_generation_parameters" });

    const img2img = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/img_gen",
      payload: { prompt: "x", init_image: "data:image/png;base,..." },
    });
    expect(img2img.statusCode).toBe(400);
    expect(img2img.json().error).toMatch(/init_image/);

    const refs = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/img_gen",
      payload: { prompt: "x", ref_images: ["data:image/png;base64,..."] },
    });
    expect(refs.statusCode).toBe(400);
  });

  it("returns 503 model_not_loaded when no provider is configured", async () => {
    const { deps } = makeDeps(makeConfig([]), vi.fn() as never);
    const res = await buildApp(deps).inject({ method: "POST", url: "/sdcpp/v1/img_gen", payload: { prompt: "x" } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "model_not_loaded" });
  });

  it("rejects video generation clearly", async () => {
    const { deps } = makeDeps(makeConfig([comfyProvider()]), vi.fn() as never);
    const res = await buildApp(deps).inject({ method: "POST", url: "/sdcpp/v1/vid_gen", payload: { prompt: "x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "unsupported_mode" });
  });
});

describe("GET /sdcpp/v1/jobs/:id + cancel", () => {
  it("answers 404 for unknown jobs", async () => {
    const { deps } = makeDeps(makeConfig([comfyProvider()]), vi.fn() as never);
    const app = buildApp(deps);
    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/jobs/job_nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/sdcpp/v1/jobs/job_nope/cancel" })).statusCode).toBe(404);
  });

  it("reports cancellation honestly (providers cannot be interrupted)", async () => {
    const gate = deferred<void>();
    let produce: () => { requestId: string; status: string; images: Array<{ imageId: string; url: string; mime: string }> };
    const run = vi.fn(async () => {
      await gate.promise;
      return produce();
    });
    const { deps, images } = makeDeps(makeConfig([comfyProvider()]), run as never);
    produce = () => {
      const meta = images.save(PNG_1x1, "image/png", "r1", false);
      return {
        requestId: "r1",
        status: "succeeded",
        images: [{ imageId: meta.imageId, url: `/api/images/${meta.imageId}/file`, mime: "image/png" }],
      };
    };
    const app = buildApp(deps);

    const res = await app.inject({ method: "POST", url: "/sdcpp/v1/img_gen", payload: { prompt: "x" } });
    const cancel = await app.inject({ method: "POST", url: `${res.json().poll_url}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ cancel_requested: false, status: "generating" });

    gate.resolve();
    await tick();
    const done = await app.inject({ method: "POST", url: `${res.json().poll_url}/cancel` });
    expect(done.json()).toMatchObject({ cancel_requested: false, status: "completed" });
  });
});

describe("model management with a ComfyUI backend (faked around the workflow's model)", () => {
  function comfyApp(mapping = true) {
    const provider = comfyProvider();
    if (!mapping) provider.mapping = {};
    const built = makeDeps(makeConfig([provider]), vi.fn() as never);
    return { app: buildApp(built.deps), provider };
  }

  it("lists only the workflow's model as model-files", async () => {
    const { app } = comfyApp();
    const res = await app.inject({ method: "GET", url: "/sdcpp/v1/model-files" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      files: [
        {
          id: "flux1-dev.safetensors",
          name: "flux1-dev.safetensors",
          category: "checkpoints",
          root: "comfyui",
          relative_path: "flux1-dev.safetensors",
        },
      ],
      errors: [],
    });
  });

  it("reports the workflow's model as loaded", async () => {
    const { app } = comfyApp();
    const res = await app.inject({ method: "GET", url: "/sdcpp/v1/models/status" });
    expect(res.json()).toMatchObject({ state: "ready", models: { model: "flux1-dev.safetensors" } });
  });

  it("loads the workflow's model and rejects any other", async () => {
    const { app } = comfyApp();
    const ok = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/models/load",
      payload: { recipe: "checkpoint", models: { model: "flux1-dev.safetensors" } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: "ready", models: { model: "flux1-dev.safetensors" } });

    const other = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/models/load",
      payload: { recipe: "checkpoint", models: { model: "sd3-medium.gguf" } },
    });
    expect(other.statusCode).toBe(400);
    expect(other.json().error).toMatch(/not available/);
  });

  it("errors clearly when the workflow maps no model", async () => {
    const { app } = comfyApp(false);
    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/model-files" })).json().files).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/models/status" })).json()).toMatchObject({
      state: "empty",
    });
    const res = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/models/load",
      payload: { models: { model: "anything" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves a synthetic checkpoint recipe and no-op unload/refresh", async () => {
    const { app } = comfyApp();
    const recipes = await app.inject({ method: "GET", url: "/sdcpp/v1/recipes" });
    expect(recipes.json().recipes[0]).toMatchObject({ id: "checkpoint" });
    expect(recipes.json().recipes[0].slots[0]).toMatchObject({ id: "model", categories: ["checkpoints"] });

    expect((await app.inject({ method: "POST", url: "/sdcpp/v1/models/unload" })).json()).toMatchObject({
      state: "empty",
    });
    expect((await app.inject({ method: "POST", url: "/sdcpp/v1/models/refresh" })).json()).toEqual({ errors: [] });
  });
});

describe("model management with an OpenAI backend (faked around the configured model)", () => {
  it("lists, reports and only 'loads' the configured model", async () => {
    const { deps } = makeDeps(makeConfig([openAIProvider()]), vi.fn() as never);
    const app = buildApp(deps);

    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/model-files" })).json().files[0].id).toBe(
      "gpt-image-1",
    );
    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/models/status" })).json()).toMatchObject({
      state: "ready",
      models: { model: "gpt-image-1" },
    });
    const ok = await app.inject({ method: "POST", url: "/sdcpp/v1/models/load", payload: { models: { model: "gpt-image-1" } } });
    expect(ok.statusCode).toBe(200);
    const other = await app.inject({ method: "POST", url: "/sdcpp/v1/models/load", payload: { models: { model: "dall-e-3" } } });
    expect(other.statusCode).toBe(400);
  });
});

describe("model management with an A1111 backend (real checkpoint switching)", () => {
  it("maps sd-models to files and switches checkpoints via options", async () => {
    stubFetch((url, init) => {
      if (url.includes("/sdapi/v1/sd-models")) {
        return jsonResponse([{ title: "v1-5-pruned", model_name: "v1-5-pruned", filename: "v1-5-pruned.safetensors" }]);
      }
      if (url.includes("/sdapi/v1/options")) {
        if (init?.method === "POST") return jsonResponse({});
        return jsonResponse({ sd_model_checkpoint: "v1-5-pruned", samples_format: "png" });
      }
      return undefined;
    });
    const { deps } = makeDeps(makeConfig([a1111Provider()]), vi.fn() as never);
    const app = buildApp(deps);

    const files = await app.inject({ method: "GET", url: "/sdcpp/v1/model-files" });
    expect(files.json().files[0]).toMatchObject({ id: "v1-5-pruned", category: "checkpoints" });

    const load = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/models/load",
      payload: { models: { model: "v1-5-pruned" } },
    });
    expect(load.statusCode).toBe(200);
    expect(load.json()).toMatchObject({ state: "ready", models: { model: "v1-5-pruned" } });
    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/models/status" })).json()).toMatchObject({
      state: "ready",
    });
  });

  it("forwards the real LoRA list", async () => {
    const spy = stubFetch((url) =>
      url.includes("/sdapi/v1/loras")
        ? jsonResponse([{ name: "stylize", path: "loras/stylize.safetensors" }])
        : undefined,
    );
    const { deps } = makeDeps(makeConfig([a1111Provider()]), vi.fn() as never);
    const res = await buildApp(deps).inject({ method: "GET", url: "/sdapi/v1/loras" });
    expect(res.json()).toEqual([{ name: "stylize", path: "loras/stylize.safetensors" }]);
    expect(spy.calls[0]!.url).toBe("http://a1111.test/sdapi/v1/loras");
  });

  it("returns an empty LoRA list when the backend has none or is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const { deps } = makeDeps(makeConfig([a1111Provider()]), vi.fn() as never);
    const res = await buildApp(deps).inject({ method: "GET", url: "/sdapi/v1/loras" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("model management with an sd-cpp backend (passthrough)", () => {
  it("forwards model endpoints verbatim, including @-qualified file ids", async () => {
    const spy = stubFetch((url, init) => {
      if (url.includes("/sdcpp/v1/model-files")) {
        return jsonResponse({
          files: [{ id: "@r2/diffusion_models/flux.gguf", name: "flux.gguf", category: "diffusion_models", root: "r2", relative_path: "diffusion_models/flux.gguf" }],
          errors: [],
        });
      }
      if (url.includes("/sdcpp/v1/models/status")) {
        return jsonResponse({ state: "ready", recipe: "flux1-dev", models: { diffusion_model: "@r2/diffusion_models/flux.gguf" }, error: null, revision: 3 });
      }
      if (url.includes("/sdcpp/v1/models/load") && init?.method === "POST") {
        return jsonResponse({ state: "ready", recipe: "flux1-dev", models: {}, error: null, revision: 4 });
      }
      if (url.includes("/sdcpp/v1/recipes")) {
        return jsonResponse({ recipes: [{ id: "flux1-dev", slots: [{ id: "diffusion_model" }] }], errors: [] });
      }
      return undefined;
    });
    const { deps } = makeDeps(makeConfig([sdcppProvider()]), vi.fn() as never);
    const app = buildApp(deps);

    const files = await app.inject({ method: "GET", url: "/sdcpp/v1/model-files" });
    expect(files.json().files[0].id).toBe("@r2/diffusion_models/flux.gguf");
    expect(spy.calls[0]!.url).toBe("http://sd.test/sdcpp/v1/model-files");

    const status = await app.inject({ method: "GET", url: "/sdcpp/v1/models/status" });
    expect(status.json()).toMatchObject({ state: "ready", recipe: "flux1-dev" });

    const load = await app.inject({
      method: "POST",
      url: "/sdcpp/v1/models/load",
      payload: { recipe: "flux1-dev", models: { diffusion_model: "@r2/diffusion_models/flux.gguf" } },
    });
    expect(load.json()).toMatchObject({ revision: 4 });

    const recipes = await app.inject({ method: "GET", url: "/sdcpp/v1/recipes" });
    expect(recipes.json().recipes[0]).toMatchObject({ id: "flux1-dev" });
  });

  it("forwards upstream load errors with their status and body", async () => {
    stubFetch((url) => {
      if (url.includes("/sdcpp/v1/models/load")) {
        return jsonResponse({ error: "The server is busy", code: "model_busy" }, 409);
      }
      return undefined;
    });
    const { deps } = makeDeps(makeConfig([sdcppProvider()]), vi.fn() as never);
    const res = await buildApp(deps).inject({ method: "POST", url: "/sdcpp/v1/models/load", payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "The server is busy", code: "model_busy" });
  });

  it("surfaces an unreachable upstream as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const { deps } = makeDeps(makeConfig([sdcppProvider()]), vi.fn() as never);
    const res = await buildApp(deps).inject({ method: "GET", url: "/sdcpp/v1/model-files" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "upstream_error" });
  });
});

describe("model management with no provider configured", () => {
  it("reports an empty server without erroring", async () => {
    const { deps } = makeDeps(makeConfig([]), vi.fn() as never);
    const app = buildApp(deps);
    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/model-files" })).json()).toEqual({
      files: [],
      errors: [],
    });
    expect((await app.inject({ method: "GET", url: "/sdcpp/v1/models/status" })).json()).toMatchObject({
      state: "empty",
    });
  });
});

describe("GET /sdapi/v1/loras gating", () => {
  it("requires either the A1111 or the sd-cpp API to be enabled", async () => {
    const config = makeConfig([comfyProvider()]);
    config.apis.sdcpp.enabled = false;
    config.apis.a1111.enabled = false;
    const { deps } = makeDeps(config, vi.fn() as never);
    const res = await buildApp(deps).inject({ method: "GET", url: "/sdapi/v1/loras" });
    expect(res.statusCode).toBe(404);
  });
});
