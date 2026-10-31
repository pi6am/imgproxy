// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import type { SdCppProviderConfig } from "../config/schema.js";
import { GenerationError, type ImageGenRequest, type Provider, type ProviderResult } from "../core/types.js";

/** Response of POST /sdcpp/v1/img_gen (202 Accepted). */
interface SdCppJobSubmission {
  id?: string;
  poll_url?: string;
}

interface SdCppJobError {
  code?: string;
  message?: string;
}

/** Per-image completion item; carries the actual generation parameters used. */
interface SdCppResultImage {
  index?: number;
  b64_json?: string;
  generation_info?: Record<string, unknown>;
}

/** Response of GET /sdcpp/v1/jobs/{id}. */
interface SdCppJob {
  id?: string;
  status?: string;
  started?: number | null;
  completed?: number | null;
  result?: {
    output_format?: string;
    images?: SdCppResultImage[];
  } | null;
  error?: SdCppJobError | null;
}

const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Talks to the native asynchronous job API of stable-diffusion.cpp's server
 * (sd-server): POST /sdcpp/v1/img_gen creates a job, GET /sdcpp/v1/jobs/{id}
 * is polled until the job completes, fails or is cancelled. The model itself
 * is loaded on the sd-cpp server (via its web UI or /sdcpp/v1/models/load);
 * request parameters omitted here fall back to the server's recipe defaults.
 */
export class SdCppProvider implements Provider {
  readonly type = "sdcpp";

  constructor(private cfg: SdCppProviderConfig) {}

  get id(): string {
    return this.cfg.id;
  }

  get name(): string {
    return this.cfg.name;
  }

  private get base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  /** Bearer auth for sd-cpp servers behind a token-auth proxy. */
  private authHeaders(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  async generate(req: ImageGenRequest): Promise<ProviderResult> {
    const submission = await this.submit(req);
    return await this.awaitJob(submission.id ?? "", submission.poll_url);
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/sdcpp/v1/capabilities`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, detail: `sd-cpp server responded with HTTP ${res.status}` };
      const json = (await res.json().catch(() => null)) as
        | { model?: { name?: string; stem?: string } | null }
        | null;
      const model = json?.model?.name ?? json?.model?.stem;
      return {
        ok: true,
        detail: model ? `sd-cpp server reachable (model: ${model})` : "sd-cpp server reachable (no model loaded)",
      };
    } catch (err) {
      return { ok: false, detail: `Cannot reach sd-cpp server: ${(err as Error).message}` };
    }
  }

  private buildBody(req: ImageGenRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt ?? "",
      // -1 lets sd-cpp pick a random seed per batch item.
      seed: req.seed !== undefined && req.seed >= 0 ? req.seed : -1,
      batch_count: Math.max(1, Math.floor(req.n || 1)),
    };
    if (req.width !== undefined) body.width = req.width;
    if (req.height !== undefined) body.height = req.height;

    const sampleParams: Record<string, unknown> = {};
    if (req.steps !== undefined) sampleParams.sample_steps = req.steps;
    if (req.sampler !== undefined) sampleParams.sample_method = toSdCppSamplerName(req.sampler);
    if (req.scheduler !== undefined) sampleParams.scheduler = toSdCppSchedulerName(req.scheduler);
    if (req.cfgScale !== undefined) sampleParams.guidance = { txt_cfg: req.cfgScale };
    if (Object.keys(sampleParams).length > 0) body.sample_params = sampleParams;

    // Structured LoRA overrides: only sd-cpp itself can apply these; other
    // providers ignore them.
    const lora = (req.lora ?? []).filter((l) => l.path.trim().length > 0);
    if (lora.length > 0) {
      body.lora = lora.map((l) => ({ path: l.path, multiplier: l.multiplier ?? 1 }));
    }

    return body;
  }

  private async submit(req: ImageGenRequest): Promise<SdCppJobSubmission> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/sdcpp/v1/img_gen`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(this.buildBody(req)),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new GenerationError(`Cannot reach sd-cpp server at ${this.base}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (!res.ok) {
      // 400 invalid parameters, 429 queue full, 500 server error.
      throw new GenerationError(
        `sd-cpp server rejected the generation request (HTTP ${res.status}): ${await safeText(res)}`,
      );
    }
    const json = (await res.json().catch(() => null)) as SdCppJobSubmission | null;
    if (!json?.id) throw new GenerationError("sd-cpp server did not return a job id");
    return json;
  }

  private async awaitJob(id: string, pollUrl?: string): Promise<ProviderResult> {
    const url = this.jobUrl(id, pollUrl);
    const deadline = Date.now() + this.cfg.timeoutMs;

    while (Date.now() < deadline) {
      await sleep(this.cfg.pollIntervalMs);
      let res: Response;
      try {
        res = await fetch(url, { headers: this.authHeaders(), signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new GenerationError(
          `Lost connection to sd-cpp server at ${this.base} while polling job '${id}': ${(err as Error).message}`,
          { cause: err },
        );
      }
      if (!res.ok) {
        // 404 unknown job, 410 the completed job was reaped on the server.
        throw new GenerationError(
          `sd-cpp job '${id}' could not be polled (HTTP ${res.status}): ${await safeText(res)}`,
        );
      }
      const job = (await res.json().catch(() => null)) as SdCppJob | null;
      if (!job) continue; // transient decode failure — keep polling

      if (job.status === "completed") return this.collectResult(job);
      if (job.status === "failed" || job.status === "cancelled") {
        const code = job.error?.code ? ` (${job.error.code})` : "";
        throw new GenerationError(
          `sd-cpp job '${id}' ${job.status}${code}: ${job.error?.message ?? "unknown error"}`,
        );
      }
      // queued / generating — keep polling
    }
    throw new GenerationError(
      `sd-cpp generation timed out after ${Math.round(this.cfg.timeoutMs / 1000)}s (job '${id}')`,
      { statusCode: 504 },
    );
  }

  private collectResult(job: SdCppJob): ProviderResult {
    const format = job.result?.output_format ?? "png";
    const items = job.result?.images ?? [];
    if (items.length === 0) throw new GenerationError("sd-cpp job completed but produced no images");

    const images = items.map((item) => ({
      data: new Uint8Array(Buffer.from(item.b64_json ?? "", "base64")),
      mime: MIME_BY_FORMAT[format.toLowerCase()] ?? "image/png",
    }));

    const meta: Record<string, unknown> = { outputFormat: format };
    if (typeof job.started === "number" && typeof job.completed === "number") {
      meta.elapsedMs = job.completed - job.started;
    }
    const generationInfo = items
      .map((item) => item.generation_info)
      .filter((info): info is Record<string, unknown> => Boolean(info));
    if (generationInfo.length > 0) meta.generationInfo = generationInfo;

    return { images, meta };
  }

  /** Prefers the advertised poll_url; falls back to the documented job path. */
  private jobUrl(id: string, pollUrl?: string): string {
    if (pollUrl) {
      try {
        return new URL(pollUrl, `${this.base}/`).toString();
      } catch {
        /* fall back to the documented path */
      }
    }
    return `${this.base}/sdcpp/v1/jobs/${encodeURIComponent(id)}`;
  }
}

// ---------------------------------------------------------------------------
// Sampler / scheduler vocabulary translation
//
// A1111-style clients send names like "Euler a" or "DPM++ 2M", while sd-cpp
// expects lowercase ids like "euler_a" / "dpm++2m". Lowercasing plus
// space→underscore already matches sd-cpp's own naming, so only spellings
// that differ beyond that ("++" ids carry no space in sd-cpp) need aliases.

const SAMPLER_ALIASES: Record<string, string> = {
  "dpm++ 2s a": "dpm++2s_a",
  "dpm++ 2s ancestral": "dpm++2s_a",
  "dpm++ 2m": "dpm++2m",
  "dpm++ 2m v2": "dpm++2mv2",
};

const SCHEDULER_ALIASES: Record<string, string> = {
  // A1111's "Automatic"/"Uniform" mean "the sampler's default schedule",
  // which is sd-cpp's "discrete" scheduler.
  automatic: "discrete",
  uniform: "discrete",
};

/** Translates A1111-style sampler spellings to sd-cpp sample_method ids. */
export function toSdCppSamplerName(name: string): string {
  const key = name.trim().toLowerCase();
  return SAMPLER_ALIASES[key] ?? key.replace(/\s+/g, "_");
}

/** Translates A1111-style scheduler spellings to sd-cpp scheduler ids. */
export function toSdCppSchedulerName(name: string): string {
  const key = name.trim().toLowerCase();
  return SCHEDULER_ALIASES[key] ?? key.replace(/\s+/g, "_");
}

// ---------------------------------------------------------------------------
// Inbound vocabulary translation (used when imgproxy exposes an sd-cpp API)
//
// Internally imgproxy speaks the A1111 sampler/scheduler vocabulary (every
// provider translates it at its boundary), so requests received through the
// sd-cpp API are mapped back to it. Unknown ids pass through unchanged, which
// keeps sd-cpp → imgproxy → sd-cpp chains lossless.

const SAMPLER_TO_A1111: Record<string, string> = {
  euler_a: "Euler a",
  euler: "Euler",
  heun: "Heun",
  dpm2: "DPM2",
  "dpm++2s_a": "DPM++ 2S a",
  "dpm++2m": "DPM++ 2M",
  "dpm++2mv2": "DPM++ 2M",
  lcm: "LCM",
  ddim: "DDIM",
  plms: "PLMS",
  unipc: "UniPC",
};

const SCHEDULER_TO_A1111: Record<string, string> = {
  discrete: "Automatic",
  karras: "Karras",
  exponential: "Exponential",
};

/** Translates sd-cpp sample_method ids to the internal A1111 vocabulary. */
export function fromSdCppSamplerName(name: string): string {
  return SAMPLER_TO_A1111[name.trim().toLowerCase()] ?? name.trim();
}

/** Translates sd-cpp scheduler ids to the internal A1111 vocabulary. */
export function fromSdCppSchedulerName(name: string): string {
  return SCHEDULER_TO_A1111[name.trim().toLowerCase()] ?? name.trim();
}

// ---------------------------------------------------------------------------
// Raw endpoint passthrough (used when imgproxy chains to a real sd-cpp server)

/**
 * Fetches a JSON endpoint from the sd-cpp server, returning the upstream
 * status and parsed body so callers can forward errors verbatim.
 */
export async function sdCppFetchJson(
  cfg: SdCppProviderConfig,
  path: string,
  options?: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = cfg.apiKey
    ? { authorization: `Bearer ${cfg.apiKey}` }
    : {};
  if (options?.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options?.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new GenerationError(`Cannot reach sd-cpp server at ${base}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { error: text.length > 500 ? `${text.slice(0, 500)}...` : text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
