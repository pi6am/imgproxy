// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SdCppProviderConfig } from "../config/schema.js";
import { GenerationError, type ImageGenRequest } from "../core/types.js";
import { SdCppProvider, fromSdCppSamplerName, fromSdCppSchedulerName, toSdCppSamplerName, toSdCppSchedulerName } from "./sdcpp.js";

const PNG_B64 = "iVBORw0KGgo="; // provider only decodes, it never parses the image

function makeConfig(overrides: Partial<SdCppProviderConfig> = {}): SdCppProviderConfig {
  return {
    id: "t",
    name: "t",
    type: "sdcpp",
    baseUrl: "http://sd.test",
    apiKey: "",
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function baseReq(overrides: Partial<ImageGenRequest> = {}): ImageGenRequest {
  return { source: "a1111", prompt: "a cat astronaut", n: 1, ...overrides };
}

/** Stubs fetch with a route handler returning a Response (or undefined = 404). */
function stubFetch(handler: (url: string) => Response | undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url) ?? new Response("not found", { status: 404 });
    }),
  );
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A submit → (queued…) → completed happy path, configurable at completion. */
function stubHappyJob(completed: unknown) {
  let polls = 0;
  const calls = stubFetch((url) => {
    if (url.includes("/sdcpp/v1/img_gen")) {
      return jsonResponse(
        { id: "job_1", kind: "img_gen", status: "queued", poll_url: "/sdcpp/v1/jobs/job_1" },
        202,
      );
    }
    if (url.includes("/sdcpp/v1/jobs/job_1")) {
      polls++;
      return polls === 1 ? jsonResponse({ id: "job_1", status: "queued" }) : jsonResponse(completed);
    }
    return undefined;
  });
  return calls;
}

function submittedBody(calls: { url: string; init?: RequestInit }[]): Record<string, unknown> {
  const call = calls.find((c) => c.url.includes("/sdcpp/v1/img_gen"));
  return JSON.parse(String(call?.init?.body));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("toSdCppSamplerName", () => {
  it("translates A1111 spellings", () => {
    expect(toSdCppSamplerName("Euler a")).toBe("euler_a");
    expect(toSdCppSamplerName("DPM++ 2M")).toBe("dpm++2m");
    expect(toSdCppSamplerName("DPM++ 2S a")).toBe("dpm++2s_a");
    expect(toSdCppSamplerName("DPM++ 2M V2")).toBe("dpm++2mv2");
    expect(toSdCppSamplerName("DDIM")).toBe("ddim");
    expect(toSdCppSamplerName("LCM")).toBe("lcm");
  });
  it("passes already-valid ids through unchanged", () => {
    expect(toSdCppSamplerName("euler_a")).toBe("euler_a");
    expect(toSdCppSamplerName("dpm++2m")).toBe("dpm++2m");
  });
});

describe("toSdCppSchedulerName", () => {
  it("translates A1111 scheduler vocabulary", () => {
    expect(toSdCppSchedulerName("Automatic")).toBe("discrete");
    expect(toSdCppSchedulerName("Uniform")).toBe("discrete");
    expect(toSdCppSchedulerName("Karras")).toBe("karras");
    expect(toSdCppSchedulerName("Exponential")).toBe("exponential");
  });
});

describe("fromSdCppSamplerName / fromSdCppSchedulerName (inbound)", () => {
  it("map sd-cpp ids back to the internal A1111 vocabulary", () => {
    expect(fromSdCppSamplerName("euler_a")).toBe("Euler a");
    expect(fromSdCppSamplerName("dpm++2m")).toBe("DPM++ 2M");
    expect(fromSdCppSamplerName("dpm++2s_a")).toBe("DPM++ 2S a");
    expect(fromSdCppSchedulerName("discrete")).toBe("Automatic");
    expect(fromSdCppSchedulerName("karras")).toBe("Karras");
  });
  it("pass unknown ids through unchanged", () => {
    expect(fromSdCppSamplerName("ipndm_v")).toBe("ipndm_v");
    expect(fromSdCppSchedulerName("ays")).toBe("ays");
  });
  it("round-trip through the outbound translation", () => {
    for (const id of ["euler_a", "dpm++2m", "dpm++2s_a"]) {
      expect(toSdCppSamplerName(fromSdCppSamplerName(id))).toBe(id);
    }
    expect(toSdCppSchedulerName(fromSdCppSchedulerName("discrete"))).toBe("discrete");
  });
});

describe("SdCppProvider.generate", () => {
  it("submits an async job, polls it and decodes the result images", async () => {
    const { calls } = stubHappyJob({
      id: "job_1",
      status: "completed",
      started: 1000,
      completed: 2500,
      result: {
        output_format: "png",
        images: [
          { index: 0, b64_json: PNG_B64, generation_info: { seed: 42 } },
          { index: 1, b64_json: PNG_B64, generation_info: { seed: 43 } },
        ],
      },
    });

    const result = await new SdCppProvider(makeConfig()).generate(
      baseReq({
        negativePrompt: "blurry",
        width: 1024,
        height: 768,
        steps: 28,
        cfgScale: 4.5,
        seed: 123,
        sampler: "Euler a",
        scheduler: "Automatic",
        n: 2,
      }),
    );

    expect(submittedBody(calls)).toEqual({
      prompt: "a cat astronaut",
      negative_prompt: "blurry",
      seed: 123,
      batch_count: 2,
      width: 1024,
      height: 768,
      sample_params: {
        sample_steps: 28,
        sample_method: "euler_a",
        scheduler: "discrete",
        guidance: { txt_cfg: 4.5 },
      },
    });
    // polls the advertised poll_url, resolved against the base URL
    expect(calls.some((c) => c.url === "http://sd.test/sdcpp/v1/jobs/job_1")).toBe(true);

    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toEqual({
      data: new Uint8Array(Buffer.from(PNG_B64, "base64")),
      mime: "image/png",
    });
    expect(result.meta).toMatchObject({
      outputFormat: "png",
      elapsedMs: 1500,
      generationInfo: [{ seed: 42 }, { seed: 43 }],
    });
  });

  it("omits unset parameters so the server's recipe defaults apply", async () => {
    const { calls } = stubHappyJob({
      id: "job_1",
      status: "completed",
      result: { output_format: "png", images: [{ index: 0, b64_json: PNG_B64 }] },
    });

    await new SdCppProvider(makeConfig()).generate(baseReq());

    expect(submittedBody(calls)).toEqual({
      prompt: "a cat astronaut",
      negative_prompt: "",
      seed: -1,
      batch_count: 1,
    });
  });

  it("maps the upstream output format to a mime type", async () => {
    stubHappyJob({
      id: "job_1",
      status: "completed",
      result: { output_format: "jpeg", images: [{ index: 0, b64_json: PNG_B64 }] },
    });

    const result = await new SdCppProvider(makeConfig()).generate(baseReq());

    expect(result.images[0]?.mime).toBe("image/jpeg");
  });

  it("falls back to the documented job path when no poll_url is advertised", async () => {
    let polls = 0;
    const { calls } = stubFetch((url) => {
      if (url.includes("/sdcpp/v1/img_gen")) {
        return jsonResponse({ id: "job_2", status: "queued" }, 202);
      }
      if (url.includes("/sdcpp/v1/jobs/job_2")) {
        polls++;
        return jsonResponse({
          id: "job_2",
          status: polls >= 1 ? "completed" : "queued",
          result: { output_format: "png", images: [{ index: 0, b64_json: PNG_B64 }] },
        });
      }
      return undefined;
    });

    await new SdCppProvider(makeConfig()).generate(baseReq());

    expect(calls.some((c) => c.url === "http://sd.test/sdcpp/v1/jobs/job_2")).toBe(true);
  });

  it("sends the configured bearer token on every request", async () => {
    const { calls } = stubHappyJob({
      id: "job_1",
      status: "completed",
      result: { output_format: "png", images: [{ index: 0, b64_json: PNG_B64 }] },
    });

    await new SdCppProvider(makeConfig({ apiKey: "sekret-token" })).generate(baseReq());

    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer sekret-token");
    }
  });

  it("forwards structured LoRA overrides natively", async () => {
    const { calls } = stubHappyJob({
      id: "job_1",
      status: "completed",
      result: { output_format: "png", images: [{ index: 0, b64_json: PNG_B64 }] },
    });

    await new SdCppProvider(makeConfig()).generate(
      baseReq({ lora: [{ path: "stylize.safetensors", multiplier: 0.8 }, { path: "", multiplier: 2 }] }),
    );

    expect(submittedBody(calls).lora).toEqual([{ path: "stylize.safetensors", multiplier: 0.8 }]);
  });

  it("sends the proxy-hop header so chained imgproxies can detect loops", async () => {
    const { calls } = stubHappyJob({
      id: "job_1",
      status: "completed",
      result: { output_format: "png", images: [{ index: 0, b64_json: PNG_B64 }] },
    });

    await new SdCppProvider(makeConfig()).generate(baseReq({ hops: 2 }));

    const submit = calls.find((c) => c.url.includes("/sdcpp/v1/img_gen"));
    expect((submit?.init?.headers as Record<string, string>)["x-imgproxy-depth"]).toBe("3");
  });

  it("throws when the job fails upstream", async () => {
    stubHappyJob({
      id: "job_1",
      status: "failed",
      result: null,
      error: { code: "generation_failed", message: "generate_image returned empty results" },
    });

    await expect(new SdCppProvider(makeConfig()).generate(baseReq())).rejects.toThrow(
      /failed \(generation_failed\): generate_image returned empty results/,
    );
  });

  it("throws when the job was cancelled by another client", async () => {
    stubHappyJob({
      id: "job_1",
      status: "cancelled",
      result: null,
      error: { code: "cancelled", message: "job cancelled by client" },
    });

    await expect(new SdCppProvider(makeConfig()).generate(baseReq())).rejects.toThrow(/cancelled/);
  });

  it("throws when the job completes without images", async () => {
    stubHappyJob({ id: "job_1", status: "completed", result: { output_format: "png", images: [] } });

    await expect(new SdCppProvider(makeConfig()).generate(baseReq())).rejects.toThrow(/no images/);
  });

  it("throws when submission is rejected", async () => {
    stubFetch((url) => {
      if (url.includes("/sdcpp/v1/img_gen")) {
        return jsonResponse({ error: "Invalid generation parameters", code: 400 }, 400);
      }
      return undefined;
    });

    await expect(new SdCppProvider(makeConfig()).generate(baseReq())).rejects.toThrow(/HTTP 400/);
  });

  it("throws when the sd-cpp server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    await expect(new SdCppProvider(makeConfig()).generate(baseReq())).rejects.toThrow(
      /Cannot reach sd-cpp server at http:\/\/sd.test/,
    );
  });

  it("throws when the job disappears from the server (HTTP 410)", async () => {
    stubFetch((url) => {
      if (url.includes("/sdcpp/v1/img_gen")) {
        return jsonResponse({ id: "job_1", poll_url: "/sdcpp/v1/jobs/job_1" }, 202);
      }
      if (url.includes("/sdcpp/v1/jobs/job_1")) {
        return new Response("gone", { status: 410 });
      }
      return undefined;
    });

    await expect(new SdCppProvider(makeConfig()).generate(baseReq())).rejects.toThrow(/HTTP 410/);
  });

  it("times out with a 504 while the job keeps generating", async () => {
    stubFetch((url) => {
      if (url.includes("/sdcpp/v1/img_gen")) {
        return jsonResponse({ id: "job_slow", poll_url: "/sdcpp/v1/jobs/job_slow" }, 202);
      }
      if (url.includes("/sdcpp/v1/jobs/job_slow")) {
        return jsonResponse({ id: "job_slow", status: "generating" });
      }
      return undefined;
    });

    const err: GenerationError = await new SdCppProvider(
      makeConfig({ timeoutMs: 60, pollIntervalMs: 5 }),
    )
      .generate(baseReq())
      .catch((e) => e);

    expect(err).toBeInstanceOf(GenerationError);
    expect(err.statusCode).toBe(504);
    expect(err.message).toMatch(/timed out.*job_slow/);
  });
});

describe("SdCppProvider.check", () => {
  it("reports reachability and the loaded model", async () => {
    stubFetch((url) =>
      url.includes("/sdcpp/v1/capabilities")
        ? jsonResponse({ model: { name: "flux1-dev", stem: "flux1-dev", path: "/models/…" } })
        : undefined,
    );

    await expect(new SdCppProvider(makeConfig()).check()).resolves.toEqual({
      ok: true,
      detail: "sd-cpp server reachable (model: flux1-dev)",
    });
  });

  it("notes when no model is loaded", async () => {
    stubFetch((url) =>
      url.includes("/sdcpp/v1/capabilities") ? jsonResponse({ model: null }) : undefined,
    );

    await expect(new SdCppProvider(makeConfig()).check()).resolves.toEqual({
      ok: true,
      detail: "sd-cpp server reachable (no model loaded)",
    });
  });

  it("fails on HTTP errors and connection failures", async () => {
    stubFetch((url) =>
      url.includes("/sdcpp/v1/capabilities") ? jsonResponse({ error: "boom" }, 500) : undefined,
    );
    await expect(new SdCppProvider(makeConfig()).check()).resolves.toMatchObject({
      ok: false,
      detail: /HTTP 500/,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(new SdCppProvider(makeConfig()).check()).resolves.toMatchObject({
      ok: false,
      detail: /Cannot reach sd-cpp server/,
    });
  });
});
