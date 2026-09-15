import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../config/schema.js";
import {
  a1111ToRequest,
  clampInt,
  mappedModelName,
  modelEntry,
  openAIToRequest,
  parseOpenAISize,
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
