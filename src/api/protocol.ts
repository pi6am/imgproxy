// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { createHash } from "node:crypto";
import type { ProviderConfig } from "../config/schema.js";
import { GenerationError, type ImageGenRequest } from "../core/types.js";
import { fromSdCppSamplerName, fromSdCppSchedulerName } from "../providers/sdcpp.js";
import type { ComfyWorkflow } from "../providers/workflow.js";

export function clampInt(value: unknown, min: number, max: number, dflt: number): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function optNum(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parses OpenAI-style size strings like "1024x1024"; "auto"/undefined yields no dims. */
export function parseOpenAISize(size: unknown): { width?: number; height?: number } {
  if (typeof size !== "string") return {};
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim());
  if (!m) return {};
  return { width: Number(m[1]), height: Number(m[2]) };
}

export interface OpenAIGenerationBody {
  prompt?: unknown;
  model?: unknown;
  n?: unknown;
  size?: unknown;
  response_format?: unknown;
}

export function openAIToRequest(
  body: OpenAIGenerationBody,
): { request: ImageGenRequest; responseFormat: "url" | "b64_json" } {
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    throw new GenerationError("A non-empty 'prompt' string is required", { statusCode: 400 });
  }
  const { width, height } = parseOpenAISize(body.size);
  let responseFormat: "url" | "b64_json";
  if (body.response_format === "b64_json") responseFormat = "b64_json";
  else if (body.response_format === "url") responseFormat = "url";
  // Mirrors OpenAI behavior: gpt-image-* models don't support response_format
  // and always return base64 (clients like KoboldAI Lite rely on this).
  else if (typeof body.model === "string" && body.model.startsWith("gpt-image"))
    responseFormat = "b64_json";
  else responseFormat = "url";
  return {
    request: {
      source: "openai",
      prompt: body.prompt,
      width,
      height,
      n: clampInt(body.n, 1, 16, 1),
      model: optStr(body.model),
    },
    responseFormat,
  };
}

export interface A1111Txt2ImgBody {
  prompt?: unknown;
  negative_prompt?: unknown;
  steps?: unknown;
  cfg_scale?: unknown;
  width?: unknown;
  height?: unknown;
  seed?: unknown;
  sampler_name?: unknown;
  scheduler?: unknown;
  batch_size?: unknown;
  n_iter?: unknown;
  override_settings?: { sd_model_checkpoint?: unknown };
}

export function a1111ToRequest(body: A1111Txt2ImgBody): ImageGenRequest {
  const batchSize = clampInt(body.batch_size, 1, 16, 1);
  const nIter = clampInt(body.n_iter, 1, 16, 1);
  const seed = optNum(body.seed);
  return {
    source: "a1111",
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    negativePrompt: optStr(body.negative_prompt),
    width: optNum(body.width),
    height: optNum(body.height),
    steps: optNum(body.steps),
    cfgScale: optNum(body.cfg_scale),
    seed: seed !== undefined && seed >= 0 ? Math.floor(seed) : undefined,
    sampler: optStr(body.sampler_name),
    scheduler: optStr(body.scheduler),
    n: Math.min(32, batchSize * nIter),
    model: optStr(body.override_settings?.sd_model_checkpoint),
  };
}

export interface SdCppImgGenBody {
  prompt?: unknown;
  negative_prompt?: unknown;
  width?: unknown;
  height?: unknown;
  seed?: unknown;
  batch_count?: unknown;
  init_image?: unknown;
  mask_image?: unknown;
  control_image?: unknown;
  ip_adapter_image?: unknown;
  ref_images?: unknown;
  sample_params?: {
    sample_steps?: unknown;
    sample_method?: unknown;
    scheduler?: unknown;
    guidance?: { txt_cfg?: unknown } | undefined;
  };
  lora?: Array<{ path?: unknown; multiplier?: unknown }> | undefined;
}

/** Image inputs that change the operation itself (img2img / inpainting /
 *  control), which imgproxy cannot forward through its txt2img pipeline. */
const UNSUPPORTED_IMAGE_FIELDS = ["init_image", "mask_image", "control_image", "ip_adapter_image"] as const;

/** Normalizes an sd-cpp /sdcpp/v1/img_gen body into a protocol-independent
 *  request. Sampler/scheduler ids are mapped back to the internal A1111
 *  vocabulary so they survive forwarding to any backend. */
export function sdcppToRequest(body: SdCppImgGenBody): ImageGenRequest {
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    throw new GenerationError("A non-empty 'prompt' string is required", { statusCode: 400 });
  }
  for (const field of UNSUPPORTED_IMAGE_FIELDS) {
    if (typeof body[field] === "string" && (body[field] as string).length > 0) {
      throw new GenerationError(
        `'${field}' is not supported: imgproxy forwards text-to-image requests only`,
        { statusCode: 400 },
      );
    }
  }
  if (Array.isArray(body.ref_images) && body.ref_images.length > 0) {
    throw new GenerationError("'ref_images' is not supported: imgproxy forwards text-to-image requests only", {
      statusCode: 400,
    });
  }

  const seed = optNum(body.seed);
  const sampler = optStr(body.sample_params?.sample_method);
  const scheduler = optStr(body.sample_params?.scheduler);
  const lora = Array.isArray(body.lora)
    ? body.lora.flatMap((entry) =>
        typeof entry?.path === "string" && entry.path.length > 0
          ? [{ path: entry.path, multiplier: optNum(entry.multiplier) }]
          : [],
      )
    : undefined;

  return {
    source: "sdcpp",
    prompt: body.prompt,
    negativePrompt: optStr(body.negative_prompt),
    width: positiveIntOrOmit(body.width),
    height: positiveIntOrOmit(body.height),
    steps: positiveIntOrOmit(body.sample_params?.sample_steps),
    cfgScale: optNum(body.sample_params?.guidance?.txt_cfg),
    seed: seed !== undefined && seed >= 0 ? Math.floor(seed) : undefined,
    sampler: sampler !== undefined ? fromSdCppSamplerName(sampler) : undefined,
    scheduler: scheduler !== undefined ? fromSdCppSchedulerName(scheduler) : undefined,
    n: clampInt(body.batch_count, 1, 16, 1),
    lora: lora !== undefined && lora.length > 0 ? lora : undefined,
  };
}

/** Keeps positive integers, treats anything else as "not specified". */
function positiveIntOrOmit(value: unknown): number | undefined {
  const n = optNum(value);
  return n !== undefined && n > 0 ? Math.floor(n) : undefined;
}

/** Minimal sampler list so A1111 clients can populate their UIs. */
export const A1111_SAMPLERS = [
  "Euler",
  "Euler a",
  "Heun",
  "DPM2",
  "DPM2 a",
  "LMS",
  "DPM++ 2M",
  "DPM++ SDE",
  "DPM++ 2M SDE",
  "DPM++ 3M SDE",
  "DDIM",
  "UniPC",
].map((name) => ({ name, aliases: [], options: {}, description: `imgproxy passthrough: ${name}` }));

/** Minimal scheduler list in A1111 vocabulary. */
export const A1111_SCHEDULERS = [
  "Automatic",
  "Uniform",
  "Karras",
  "Exponential",
  "SGM Uniform",
  "Simple",
  "DDIM",
].map((name) => ({ name, aliases: [], options: {}, description: `imgproxy passthrough: ${name}` }));

/**
 * The single model name advertised to A1111 clients: for ComfyUI providers the
 * current value of the mapped model node input (if mapped), for OpenAI
 * providers the configured model. Null when nothing should be advertised.
 */
export function mappedModelName(provider: ProviderConfig | undefined): string | null {
  if (!provider) return null;
  if (provider.type === "comfyui") {
    const target = provider.mapping?.model;
    if (!target) return null;
    const node = (provider.workflow as ComfyWorkflow)[target.node];
    const value = node?.inputs?.[target.input];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }
  if (provider.type === "openai") return provider.model || null;
  return null;
}

/** Builds an A1111 sd-models entry with a stable, A1111-style short hash. */
export function modelEntry(name: string): {
  model_name: string;
  title: string;
  hash: string;
  sha256: string;
  filename: string;
} {
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return { model_name: name, title: name, hash, sha256: hash, filename: name };
}
