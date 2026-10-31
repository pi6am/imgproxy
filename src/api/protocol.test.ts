// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../config/schema.js";
import { GenerationError } from "../core/types.js";
import {
  a1111ToRequest,
  clampInt,
  mappedModelName,
  modelEntry,
  openAIToRequest,
  parseOpenAISize,
  sdcppToRequest,
} from "./protocol.js";

describe("parseOpenAISize", () => {
  it("parses WxH", () => {
    expect(parseOpenAISize("1024x768")).toEqual({ width: 1024, height: 768 });
  });
  it("returns empty for auto/garbage", () => {
    expect(parseOpenAISize("auto")).toEqual({});
    expect(parseOpenAISize(undefined)).toEqual({});
    expect(parseOpenAISize("big")).toEqual({});
  });
});

describe("openAIToRequest", () => {
  it("normalizes a full body", () => {
    const { request, responseFormat } = openAIToRequest({
      prompt: "a cat",
      model: "gpt-image-1",
      n: 3,
      size: "1024x1024",
      response_format: "b64_json",
    });
    expect(request).toEqual({
      source: "openai",
      prompt: "a cat",
      width: 1024,
      height: 1024,
      n: 3,
      model: "gpt-image-1",
    });
    expect(responseFormat).toBe("b64_json");
  });

  it("defaults n to 1 and format to url", () => {
    const { request, responseFormat } = openAIToRequest({ prompt: "x" });
    expect(request.n).toBe(1);
    expect(responseFormat).toBe("url");
  });

  it("defaults to b64_json for gpt-image models (mirrors OpenAI)", () => {
    expect(openAIToRequest({ prompt: "x", model: "gpt-image-1" }).responseFormat).toBe("b64_json");
    expect(openAIToRequest({ prompt: "x", model: "gpt-image-1-mini" }).responseFormat).toBe("b64_json");
    expect(openAIToRequest({ prompt: "x", model: "dall-e-3" }).responseFormat).toBe("url");
    // explicit response_format wins over the model-based default
    expect(openAIToRequest({ prompt: "x", model: "gpt-image-1", response_format: "url" }).responseFormat).toBe("url");
  });

  it("rejects empty prompts", () => {
    expect(() => openAIToRequest({ prompt: "" })).toThrow(/prompt/);
    expect(() => openAIToRequest({})).toThrow(/prompt/);
  });

  it("clamps absurd n values", () => {
    expect(openAIToRequest({ prompt: "x", n: 9999 }).request.n).toBe(16);
    expect(openAIToRequest({ prompt: "x", n: 0 }).request.n).toBe(1);
  });
});

describe("a1111ToRequest", () => {
  it("normalizes txt2img bodies and multiplies batch into n", () => {
    const req = a1111ToRequest({
      prompt: "a cat",
      negative_prompt: "ugly",
      steps: 25,
      cfg_scale: 6.5,
      width: 832,
      height: 1216,
      seed: 123,
      sampler_name: "DPM++ 2M",
      batch_size: 2,
      n_iter: 3,
    });
    expect(req).toEqual({
      source: "a1111",
      prompt: "a cat",
      negativePrompt: "ugly",
      width: 832,
      height: 1216,
      steps: 25,
      cfgScale: 6.5,
      seed: 123,
      sampler: "DPM++ 2M",
      n: 6,
      model: undefined,
    });
  });

  it("treats negative seeds as random (undefined)", () => {
    expect(a1111ToRequest({ prompt: "x", seed: -1 }).seed).toBeUndefined();
    expect(a1111ToRequest({ prompt: "x" }).seed).toBeUndefined();
  });

  it("passes the scheduler field through", () => {
    expect(a1111ToRequest({ prompt: "x", scheduler: "Karras" }).scheduler).toBe("Karras");
    expect(a1111ToRequest({ prompt: "x" }).scheduler).toBeUndefined();
  });

  it("handles empty bodies", () => {
    const req = a1111ToRequest({});
    expect(req.prompt).toBe("");
    expect(req.n).toBe(1);
  });
});

describe("clampInt", () => {
  it("falls back to default on garbage", () => {
    expect(clampInt("nope", 1, 10, 5)).toBe(5);
    expect(clampInt(Number.NaN, 1, 10, 5)).toBe(5);
    expect(clampInt(undefined, 1, 10, 5)).toBe(5);
  });
  it("clamps to range", () => {
    expect(clampInt(99, 1, 10, 5)).toBe(10);
    expect(clampInt(-3, 1, 10, 5)).toBe(1);
    expect(clampInt(7.9, 1, 10, 5)).toBe(7);
  });
});

describe("mappedModelName", () => {
  const workflow = {
    "30:10": { class_type: "UNETLoader", inputs: { unet_name: "krea2_turbo_int8_convrot.safetensors" } },
    "7": { class_type: "KSampler", inputs: { seed: ["55", 0] } },
  } as never;

  const comfy = (mapping: Record<string, { node: string; input: string } | null>): ProviderConfig =>
    ({
      id: "t",
      name: "t",
      type: "comfyui",
      baseUrl: "http://x",
      apiKey: "",
      workflow,
      mapping,
      defaults: {},
      pollIntervalMs: 500,
      timeoutMs: 60000,
    }) as ProviderConfig;

  it("returns the mapped node's current string value", () => {
    expect(mappedModelName(comfy({ model: { node: "30:10", input: "unet_name" } }))).toBe(
      "krea2_turbo_int8_convrot.safetensors",
    );
  });

  it("returns null for link-valued inputs, missing nodes, or no mapping", () => {
    expect(mappedModelName(comfy({ model: { node: "7", input: "seed" } }))).toBeNull();
    expect(mappedModelName(comfy({ model: { node: "nope", input: "x" } }))).toBeNull();
    expect(mappedModelName(comfy({}))).toBeNull();
  });

  it("returns the configured model for OpenAI providers and null for A1111/unset", () => {
    expect(mappedModelName({ id: "o", name: "o", type: "openai", baseUrl: "http://x", apiKey: "", model: "gpt-image-1", timeoutMs: 1000 })).toBe("gpt-image-1");
    expect(mappedModelName({ id: "a", name: "a", type: "a1111", baseUrl: "http://x", apiKey: "", timeoutMs: 1000 })).toBeNull();
    expect(mappedModelName(undefined)).toBeNull();
  });
});

describe("modelEntry", () => {
  it("builds a consistent A1111-style entry with a hex short hash", () => {
    const entry = modelEntry("model.safetensors");
    expect(entry.model_name).toBe("model.safetensors");
    expect(entry.title).toBe("model.safetensors");
    expect(entry.filename).toBe("model.safetensors");
    expect(entry.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.sha256).toBe(entry.hash);
    expect(modelEntry("model.safetensors").hash).toBe(entry.hash); // stable
  });
});

describe("sdcppToRequest", () => {
  it("normalizes a full body, translating sampler/scheduler ids to the internal vocabulary", () => {
    const request = sdcppToRequest({
      prompt: "a cat",
      negative_prompt: "blurry",
      width: 832,
      height: 480,
      seed: 42,
      batch_count: 4,
      sample_params: {
        sample_method: "euler_a",
        scheduler: "discrete",
        sample_steps: 28,
        guidance: { txt_cfg: 3.5 },
      },
      lora: [{ path: "stylize.safetensors", multiplier: 0.8 }, { path: "", multiplier: 2 }],
    });
    expect(request).toEqual({
      source: "sdcpp",
      prompt: "a cat",
      negativePrompt: "blurry",
      width: 832,
      height: 480,
      steps: 28,
      cfgScale: 3.5,
      seed: 42,
      sampler: "Euler a",
      scheduler: "Automatic",
      n: 4,
      lora: [{ path: "stylize.safetensors", multiplier: 0.8 }],
    });
  });

  it("keeps unknown sampler ids unchanged (lossless sd-cpp chaining)", () => {
    expect(sdcppToRequest({ prompt: "x", sample_params: { sample_method: "ipndm_v" } }).sampler).toBe("ipndm_v");
  });

  it("defaults a sparse body like the sd-cpp server would", () => {
    expect(sdcppToRequest({ prompt: "x" })).toEqual({ source: "sdcpp", prompt: "x", n: 1 });
    expect(sdcppToRequest({ prompt: "x", seed: -1, width: 0 }).seed).toBeUndefined();
    expect(sdcppToRequest({ prompt: "x", width: 0 }).width).toBeUndefined();
    expect(sdcppToRequest({ prompt: "x", batch_count: 99 }).n).toBe(16);
  });

  it("rejects a missing prompt with a 400", () => {
    expect(() => sdcppToRequest({})).toThrow(GenerationError);
    try {
      sdcppToRequest({ prompt: "  " });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as GenerationError).statusCode).toBe(400);
    }
  });

  it("rejects image inputs imgproxy cannot forward", () => {
    for (const body of [
      { prompt: "x", init_image: "data:image/png;base64,..." },
      { prompt: "x", mask_image: "iVBOR..." },
      { prompt: "x", control_image: "iVBOR..." },
      { prompt: "x", ip_adapter_image: "iVBOR..." },
      { prompt: "x", ref_images: ["iVBOR..."] },
    ]) {
      expect(() => sdcppToRequest(body as never)).toThrow(/not supported/);
    }
    // null / empty image fields are what well-behaved clients send
    expect(sdcppToRequest({ prompt: "x", init_image: null, ref_images: [] }).prompt).toBe("x");
  });
});
