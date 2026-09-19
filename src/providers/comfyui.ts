// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { randomInt, randomUUID } from "node:crypto";
import type { ComfyUIProviderConfig } from "../config/schema.js";
import { GenerationError, type ImageGenRequest, type Provider, type ProviderResult } from "../core/types.js";
import { applyMapping, type ComfyWorkflow } from "./workflow.js";
interface ComfyHistoryImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryNodeOutput {
  images?: ComfyHistoryImage[];
}

interface ComfyHistoryEntry {
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: [string, unknown][] | null;
  };
  outputs?: Record<string, ComfyHistoryNodeOutput>;
}

interface ComfyExecutionError {
  node_id?: string;
  node_type?: string;
  exception_message?: string;
}

export class ComfyUIProvider implements Provider {
  readonly type = "comfyui";

  constructor(private cfg: ComfyUIProviderConfig) {}

  get id(): string {
    return this.cfg.id;
  }

  get name(): string {
    return this.cfg.name;
  }

  private get base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  /** Bearer auth for ComfyUI instances that require a token. */
  private authHeaders(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  async generate(req: ImageGenRequest): Promise<ProviderResult> {
    const n = Math.max(1, Math.floor(req.n || 1));
    const d = this.cfg.defaults ?? {};
    const baseSeed =
      req.seed !== undefined && req.seed >= 0 ? req.seed : randomInt(0, 2 ** 48 - 1);

    const sampler = req.sampler ?? d.sampler;
    const scheduler = req.scheduler ?? d.scheduler;

    const values: Record<string, unknown> = {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt ?? d.negativePrompt,
      width: req.width ?? d.width,
      height: req.height ?? d.height,
      steps: req.steps ?? d.steps,
      cfg: req.cfgScale ?? d.cfg,
      seed: baseSeed,
      sampler: sampler !== undefined ? toComfySamplerName(sampler) : undefined,
      scheduler: scheduler !== undefined ? toComfySchedulerName(scheduler) : undefined,
      model: req.model,
    };

    // With a batch_size mapping a single run can produce n images;
    // otherwise we run the workflow n times with incremented seeds.
    const batchMapped = Boolean(this.cfg.mapping?.batch_size);
    const runs = batchMapped ? 1 : n;
    if (batchMapped) values.batch_size = n;

    const images: ProviderResult["images"] = [];
    for (let i = 0; i < runs; i++) {
      const runValues = { ...values };
      if (runs > 1) runValues.seed = baseSeed + i;
      const { workflow } = applyMapping(this.cfg.workflow as ComfyWorkflow, this.cfg.mapping ?? {}, runValues);
      images.push(...(await this.runWorkflow(workflow)));
    }

    return { images, meta: { seed: baseSeed, runs, batchMapped } };
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/system_stats`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, detail: `ComfyUI responded with HTTP ${res.status}` };
      return { ok: true, detail: "ComfyUI reachable" };
    } catch (err) {
      return { ok: false, detail: `Cannot reach ComfyUI: ${(err as Error).message}` };
    }
  }

  private async runWorkflow(workflow: ComfyWorkflow): Promise<ProviderResult["images"]> {
    const clientId = randomUUID();
    let promptId: string;

    try {
      const res = await fetch(`${this.base}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new GenerationError(
          `ComfyUI rejected the workflow (HTTP ${res.status}): ${await safeText(res)}`,
        );
      }
      const json = (await res.json()) as { prompt_id?: string };
      if (!json.prompt_id) throw new GenerationError("ComfyUI did not return a prompt_id");
      promptId = json.prompt_id;
    } catch (err) {
      if (err instanceof GenerationError) throw err;
      throw new GenerationError(`Cannot submit workflow to ComfyUI at ${this.base}: ${(err as Error).message}`, {
        cause: err,
      });
    }

    const deadline = Date.now() + this.cfg.timeoutMs;
    let lastEntry: ComfyHistoryEntry | undefined;
    while (Date.now() < deadline) {
      await sleep(this.cfg.pollIntervalMs);
      const res = await fetch(`${this.base}/history/${promptId}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new GenerationError(`ComfyUI history request failed (HTTP ${res.status}): ${await safeText(res)}`);
      }
      const history = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = history[promptId];
      if (!entry) continue; // still queued/running

      lastEntry = entry;
      const statusStr = entry.status?.status_str;
      if (statusStr === "error" || statusStr === "interrupted") {
        const messages = entry.status?.messages ?? [];
        const err = messages.find((m) => m[0] === "execution_error")?.[1] as
          | ComfyExecutionError
          | undefined;
        const where = err?.node_type
          ? ` in ${err.node_type}${err.node_id ? ` (node ${err.node_id})` : ""}`
          : "";
        throw new GenerationError(
          `ComfyUI execution error${where}: ${err?.exception_message ?? statusStr ?? "unknown error"}`,
        );
      }
      if (entry.status?.completed) {
        return await this.collectImages(entry);
      }
    }
    throw new GenerationError(
      `ComfyUI generation timed out after ${Math.round(this.cfg.timeoutMs / 1000)}s${
        lastEntry?.status?.status_str ? ` (last status: ${lastEntry.status.status_str})` : ""
      }`,
      { statusCode: 504 },
    );
  }

  private async collectImages(entry: ComfyHistoryEntry): Promise<ProviderResult["images"]> {
    const images: ProviderResult["images"] = [];
    for (const output of Object.values(entry.outputs ?? {})) {
      for (const img of output.images ?? []) {
        const url =
          `${this.base}/view?filename=${encodeURIComponent(img.filename)}` +
          `&subfolder=${encodeURIComponent(img.subfolder ?? "")}` +
          `&type=${encodeURIComponent(img.type ?? "output")}`;
        const res = await fetch(url, {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          throw new GenerationError(
            `Failed to download generated image '${img.filename}' from ComfyUI (HTTP ${res.status})`,
          );
        }
        images.push({
          data: new Uint8Array(await res.arrayBuffer()),
          mime: res.headers.get("content-type")?.split(";")[0] ?? "image/png",
        });
      }
    }
    if (images.length === 0) {
      throw new GenerationError("ComfyUI completed the workflow but produced no images");
    }
    return images;
  }
}

// ---------------------------------------------------------------------------
// Sampler / scheduler vocabulary translation
//
// A1111-style clients use names like "Euler a" or "DPM++ 2M", while ComfyUI
// expects lowercase ids like "euler_ancestral" / "dpmpp_2m". When such a
// parameter is mapped onto a workflow input we translate known spellings and
// fall back to lowercasing (ComfyUI ids are lowercase).

export const COMFY_FALLBACK_SAMPLERS = [
  "euler",
  "euler_ancestral",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_2s_ancestral_gpu",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "ddim",
  "lcm",
  "uni_pc",
  "uni_pc_bh2",
];

export const COMFY_FALLBACK_SCHEDULERS = [
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "beta",
  "beta_heuristic",
];

const SAMPLER_ALIASES: Record<string, string> = {
  "euler a": "euler_ancestral",
  "euler ancestral": "euler_ancestral",
  dpm2: "dpm_2",
  "dpm2 a": "dpm_2_ancestral",
  "dpm++ 2s a": "dpmpp_2s_ancestral",
  "dpm++ 2s ancestral": "dpmpp_2s_ancestral",
  "dpm++ 2m": "dpmpp_2m",
  "dpm++ 2m sde": "dpmpp_2m_sde",
  "dpm++ 3m sde": "dpmpp_3m_sde",
  "dpm++ sde": "dpmpp_sde",
  "uni pc": "uni_pc",
  unipc: "uni_pc",
};

const SCHEDULER_ALIASES: Record<string, string> = {
  automatic: "simple",
  uniform: "normal",
  "sgm uniform": "sgm_uniform",
  ddim: "ddim_uniform",
};

/** Translates A1111-style sampler spellings to ComfyUI sampler ids. */
export function toComfySamplerName(name: string): string {
  const key = name.trim().toLowerCase();
  return SAMPLER_ALIASES[key] ?? key;
}

/** Translates A1111-style scheduler spellings to ComfyUI scheduler ids. */
export function toComfySchedulerName(name: string): string {
  const key = name.trim().toLowerCase();
  return SCHEDULER_ALIASES[key] ?? key;
}

// ---------------------------------------------------------------------------
// Live sampler/scheduler lists from ComfyUI object_info (for the A1111 API)

type MappedParam = "sampler" | "scheduler";

const INPUT_NAME_BY_PARAM: Record<MappedParam, string> = {
  sampler: "sampler_name",
  scheduler: "scheduler",
};

const listCache = new Map<string, { values: string[]; fetchedAt: number }>();
const LIST_CACHE_TTL_MS = 300_000;

export function clearComfyListCache(): void {
  listCache.clear();
}

/**
 * Fetches the list of values ComfyUI will accept for a mapped sampler/scheduler
 * input, by inspecting the object_info of the mapped node's class (falling back
 * to KSampler). Used so the A1111 API can advertise real, valid names.
 */
export async function fetchComfyParamValues(
  cfg: ComfyUIProviderConfig,
  param: MappedParam,
): Promise<string[]> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const inputName = INPUT_NAME_BY_PARAM[param];
  const headers: Record<string, string> = cfg.apiKey
    ? { authorization: `Bearer ${cfg.apiKey}` }
    : {};
  const target = cfg.mapping?.[param];
  const node = target ? (cfg.workflow as ComfyWorkflow)[target.node] : undefined;
  const preferredClass = node?.class_type ?? "KSampler";

  const cacheKey = `${base}::${preferredClass}::${inputName}`;
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LIST_CACHE_TTL_MS) return cached.values;

  const values =
    (await queryInputValues(base, preferredClass, inputName, headers)) ??
    (preferredClass !== "KSampler"
      ? await queryInputValues(base, "KSampler", inputName, headers)
      : undefined);
  if (!values) {
    throw new GenerationError(
      `Could not retrieve the ${inputName} list from ComfyUI at ${base} (object_info)`,
    );
  }
  listCache.set(cacheKey, { values, fetchedAt: Date.now() });
  return values;
}

async function queryInputValues(
  base: string,
  classType: string,
  inputName: string,
  headers: Record<string, string>,
): Promise<string[] | undefined> {
  let res: Response;
  try {
    res = await fetch(`${base}/object_info/${encodeURIComponent(classType)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return undefined; // unreachable/timeout — caller decides how to report
  }
  if (!res.ok) return undefined;
  const json = (await res.json()) as Record<
    string,
    { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
  >;
  const spec = json[classType]?.input;
  const raw = spec?.required?.[inputName] ?? spec?.optional?.[inputName];
  // ComfyUI format: [["a","b",...], {tooltip}] — or a plain string array.
  if (Array.isArray(raw) && Array.isArray(raw[0]) && raw[0].every((v) => typeof v === "string")) {
    return raw[0] as string[];
  }
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) {
    return raw as string[];
  }
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
