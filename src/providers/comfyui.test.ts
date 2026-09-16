import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComfyUIProviderConfig } from "../config/schema.js";
import {
  clearComfyListCache,
  fetchComfyParamValues,
  toComfySamplerName,
  toComfySchedulerName,
} from "./comfyui.js";

const ksamplerObjectInfo = {
  KSampler: {
    input: {
      required: {
        sampler_name: [["euler", "euler_ancestral", "dpmpp_2m"], { tooltip: "sampler" }],
        scheduler: [["simple", "karras"], { tooltip: "scheduler" }],
      },
    },
  },
};

function makeConfig(mapping?: ComfyUIProviderConfig["mapping"], apiKey = ""): ComfyUIProviderConfig {
  return {
    id: "t",
    name: "t",
    type: "comfyui",
    baseUrl: "http://comfy.test",
    apiKey,
    workflow: {
      "1": { class_type: "KSampler", inputs: { sampler_name: "euler", scheduler: "simple" } },
      "2": { class_type: "CustomSamplerNode", inputs: {} },
    } as never,
    mapping: mapping ?? {},
    defaults: {},
    pollIntervalMs: 500,
    timeoutMs: 60000,
  };
}

function stubFetch(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(responses[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

beforeEach(() => {
  clearComfyListCache();
  vi.unstubAllGlobals();
});

describe("toComfySamplerName", () => {
  it("translates A1111 spellings", () => {
    expect(toComfySamplerName("Euler a")).toBe("euler_ancestral");
    expect(toComfySamplerName("DPM++ 2M")).toBe("dpmpp_2m");
    expect(toComfySamplerName("DPM++ 2M SDE")).toBe("dpmpp_2m_sde");
    expect(toComfySamplerName("UniPC")).toBe("uni_pc");
  });
  it("lowercases plain names (the exact case bug: 'Euler' vs 'euler')", () => {
    expect(toComfySamplerName("Euler")).toBe("euler");
    expect(toComfySamplerName("DDIM")).toBe("ddim");
  });
  it("passes already-valid ids through unchanged", () => {
    expect(toComfySamplerName("euler")).toBe("euler");
    expect(toComfySamplerName("dpmpp_3m_sde")).toBe("dpmpp_3m_sde");
  });
});

describe("toComfySchedulerName", () => {
  it("translates A1111 scheduler vocabulary", () => {
    expect(toComfySchedulerName("Automatic")).toBe("simple");
    expect(toComfySchedulerName("Uniform")).toBe("normal");
    expect(toComfySchedulerName("SGM Uniform")).toBe("sgm_uniform");
    expect(toComfySchedulerName("Karras")).toBe("karras");
    expect(toComfySchedulerName("Simple")).toBe("simple");
  });
});

describe("fetchComfyParamValues", () => {
  it("reads the sampler list from the mapped node's class via object_info", async () => {
    const { calls } = stubFetch({ "/object_info/KSampler": ksamplerObjectInfo });
    const cfg = makeConfig({ sampler: { node: "1", input: "sampler_name" } });
    await expect(fetchComfyParamValues(cfg, "sampler")).resolves.toEqual([
      "euler",
      "euler_ancestral",
      "dpmpp_2m",
    ]);
    expect(calls[0]).toContain("/object_info/KSampler");
  });

  it("uses the mapped node's class and falls back to KSampler", async () => {
    const { calls } = stubFetch({
      "/object_info/CustomSamplerNode": { CustomSamplerNode: { input: { required: {} } } },
      "/object_info/KSampler": ksamplerObjectInfo,
    });
    const cfg = makeConfig({ sampler: { node: "2", input: "sampler_name" } });
    await expect(fetchComfyParamValues(cfg, "sampler")).resolves.toEqual([
      "euler",
      "euler_ancestral",
      "dpmpp_2m",
    ]);
    expect(calls[0]).toContain("/object_info/CustomSamplerNode");
    expect(calls[1]).toContain("/object_info/KSampler");
  });

  it("caches results per endpoint", async () => {
    const { calls } = stubFetch({ "/object_info/KSampler": ksamplerObjectInfo });
    const cfg = makeConfig({ sampler: { node: "1", input: "sampler_name" } });
    await fetchComfyParamValues(cfg, "sampler");
    await fetchComfyParamValues(cfg, "sampler");
    expect(calls.filter((c) => c.includes("object_info"))).toHaveLength(1);
  });

  it("throws when ComfyUI is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const cfg = makeConfig({ sampler: { node: "1", input: "sampler_name" } });
    await expect(fetchComfyParamValues(cfg, "sampler")).rejects.toThrow(/object_info/);
  });

  it("sends the configured bearer token on object_info requests", async () => {
    const seenHeaders: (Record<string, string> | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seenHeaders.push(init?.headers as Record<string, string> | undefined);
        return new Response(JSON.stringify(ksamplerObjectInfo), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const cfg = makeConfig({ sampler: { node: "1", input: "sampler_name" } }, "sekret-token");
    await expect(fetchComfyParamValues(cfg, "sampler")).resolves.toEqual([
      "euler",
      "euler_ancestral",
      "dpmpp_2m",
    ]);
    expect(seenHeaders[0]).toEqual({ authorization: "Bearer sekret-token" });
  });
});
