// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import type { A1111ProviderConfig, AppConfig, ProviderConfig, SdCppProviderConfig } from "../config/schema.js";
import { GenerationError } from "../core/types.js";
import { sdCppFetchJson } from "../providers/sdcpp.js";
import { mappedModelName } from "./protocol.js";
import type { RouteDeps } from "./deps.js";

/**
 * Model management for the exposed sd-cpp API (/sdcpp/v1/model-files,
 * models/status, models/load, …), translated per active provider:
 *
 * - sd-cpp backends: forwarded verbatim (they natively speak this API).
 * - A1111 backends: real checkpoint switching via /sdapi/v1 options.
 * - ComfyUI/OpenAI backends: no model-loading concept, so the flow is faked
 *   around the single model the provider is set up with — model-files lists
 *   it, status reports it loaded, and load succeeds for it and fails for
 *   anything else.
 */

/** An upstream sd-cpp error, forwarded verbatim (status + body). */
export class UpstreamError extends GenerationError {
  constructor(statusCode: number, readonly body: unknown) {
    super(`sd-cpp upstream error (HTTP ${statusCode})`, { statusCode });
  }
}

export interface SdCppModelFile {
  id: string;
  name: string;
  category: string;
  root: string;
  relative_path: string;
}

const CHECKPOINT_CATEGORY = "checkpoints";

/** The single synthetic recipe advertised for backends without sd-cpp's
 *  component-slot model system: one required "model" slot. */
const CHECKPOINT_RECIPE = {
  schema_version: 1,
  id: "checkpoint",
  name: "Checkpoint",
  description: "Single model selection on the active imgproxy provider",
  slots: [
    {
      id: "model",
      required: true,
      label: "Model",
      category: CHECKPOINT_CATEGORY,
      categories: [CHECKPOINT_CATEGORY],
    },
  ],
  defaults: { width: 1024, height: 1024, cfg_scale: 7, sampling_method: "Euler a", steps: 20 },
  source: "builtin",
};

/** Bumped whenever a faked backend's reported model changes. */
let revision = 0;

function activeProvider(cfg: AppConfig): ProviderConfig | undefined {
  return cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0];
}

function fakeFile(name: string, root: string): SdCppModelFile {
  return { id: name, name, category: CHECKPOINT_CATEGORY, root, relative_path: name };
}

function fakeStatus(model: string | null): Record<string, unknown> {
  return model
    ? { state: "ready", recipe: CHECKPOINT_RECIPE.id, models: { model }, error: null, revision }
    : { state: "empty", recipe: null, models: {}, error: null, revision };
}

/** The model file id an sd-cpp load request selected ('model' slot preferred). */
function requestedModel(body: unknown): string | undefined {
  const models = (body as { models?: Record<string, unknown> } | undefined)?.models;
  if (!models || typeof models !== "object") return undefined;
  const preferred = models.model ?? models.diffusion_model;
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
  const first = Object.values(models).find((v) => typeof v === "string" && v.trim().length > 0);
  return typeof first === "string" ? first.trim() : undefined;
}

function strField(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// --- sd-cpp passthrough -----------------------------------------------------

async function sdCppPassthrough(
  provider: SdCppProviderConfig,
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<unknown> {
  const res = await sdCppFetchJson(provider, path, init);
  if (!res.ok) throw new UpstreamError(res.status, res.json ?? { error: `HTTP ${res.status}` });
  return res.json;
}

// --- A1111 model endpoints --------------------------------------------------

async function a1111Json(
  provider: A1111ProviderConfig,
  path: string,
  init?: { method?: "POST"; body?: unknown },
): Promise<unknown> {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = provider.apiKey
    ? { authorization: `Bearer ${provider.apiKey}` }
    : {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init ? 60_000 : 10_000),
    });
  } catch (err) {
    throw new GenerationError(`Cannot reach A1111 endpoint at ${base}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new GenerationError(`Upstream A1111 error (HTTP ${res.status}): ${await res.text()}`, {
      statusCode: 502,
    });
  }
  return res.json();
}

// --- Facade -------------------------------------------------------------------

export async function listModelFiles(deps: RouteDeps): Promise<{ files: SdCppModelFile[]; errors: unknown[] }> {
  const provider = activeProvider(deps.getConfig());
  if (!provider) return { files: [], errors: [] };

  if (provider.type === "sdcpp") {
    return (await sdCppPassthrough(provider, "/sdcpp/v1/model-files")) as {
      files: SdCppModelFile[];
      errors: unknown[];
    };
  }
  if (provider.type === "a1111") {
    const models = (await a1111Json(provider, "/sdapi/v1/sd-models")) as unknown[];
    const files = (Array.isArray(models) ? models : []).flatMap((m) => {
      const title = strField(m, ["title", "model_name", "filename"]);
      return title
        ? [{ ...fakeFile(title, "a1111"), relative_path: strField(m, ["filename"]) ?? title }]
        : [];
    });
    return { files, errors: [] };
  }
  if (provider.type === "comfyui") {
    const model = mappedModelName(provider);
    return { files: model ? [fakeFile(model, "comfyui")] : [], errors: [] };
  }
  // OpenAI: the single configured model.
  return { files: provider.model ? [fakeFile(provider.model, "openai")] : [], errors: [] };
}

export async function modelsStatus(deps: RouteDeps): Promise<Record<string, unknown>> {
  const provider = activeProvider(deps.getConfig());
  if (!provider) return fakeStatus(null);

  if (provider.type === "sdcpp") {
    return (await sdCppPassthrough(provider, "/sdcpp/v1/models/status")) as Record<string, unknown>;
  }
  if (provider.type === "a1111") {
    const options = await a1111Json(provider, "/sdapi/v1/options");
    return fakeStatus(strField(options, ["sd_model_checkpoint"]) ?? null);
  }
  if (provider.type === "comfyui") return fakeStatus(mappedModelName(provider));
  return fakeStatus(provider.model || null);
}

/** Loads the submitted recipe/selection; blocks until loaded (imgproxy-side
 *  loads are immediate; sd-cpp passthrough waits for the upstream load). */
export async function loadModels(deps: RouteDeps, body: unknown): Promise<Record<string, unknown>> {
  const provider = activeProvider(deps.getConfig());
  if (!provider) {
    throw new GenerationError("No generation provider is configured", { statusCode: 400 });
  }

  if (provider.type === "sdcpp") {
    return (await sdCppPassthrough(provider, "/sdcpp/v1/models/load", {
      method: "POST",
      body,
      timeoutMs: 600_000,
    })) as Record<string, unknown>;
  }
  if (provider.type === "a1111") {
    const name = requestedModel(body);
    if (!name) throw new GenerationError("The load request selects no model", { statusCode: 400 });
    await a1111Json(provider, "/sdapi/v1/options", { method: "POST", body: { sd_model_checkpoint: name } });
    revision++;
    const options = await a1111Json(provider, "/sdapi/v1/options");
    return fakeStatus(strField(options, ["sd_model_checkpoint"]) ?? null);
  }

  // ComfyUI / OpenAI: the model is fixed by the provider configuration, so the
  // load flow is faked — the configured model "loads", anything else fails.
  const current = provider.type === "comfyui" ? mappedModelName(provider) : provider.model || null;
  const requested = requestedModel(body);
  if (!current) {
    throw new GenerationError(
      provider.type === "comfyui"
        ? "The active ComfyUI provider maps no 'model' parameter in its workflow"
        : "The active OpenAI provider has no model configured",
      { statusCode: 400 },
    );
  }
  if (requested !== current) {
    throw new GenerationError(
      `Model '${requested ?? "(none)"}' is not available: this ${provider.type} provider is set up with '${current}', which cannot be changed through imgproxy`,
      { statusCode: 400 },
    );
  }
  revision++;
  return fakeStatus(current);
}

export async function unloadModels(deps: RouteDeps): Promise<Record<string, unknown>> {
  const provider = activeProvider(deps.getConfig());
  if (provider?.type === "sdcpp") {
    return (await sdCppPassthrough(provider, "/sdcpp/v1/models/unload", { method: "POST" })) as Record<
      string,
      unknown
    >;
  }
  // Faked backends keep their configured model; unload reports the empty state.
  return fakeStatus(null);
}

export async function refreshModels(deps: RouteDeps): Promise<Record<string, unknown>> {
  const provider = activeProvider(deps.getConfig());
  if (provider?.type === "sdcpp") {
    return (await sdCppPassthrough(provider, "/sdcpp/v1/models/refresh", { method: "POST" })) as Record<
      string,
      unknown
    >;
  }
  return { errors: [] };
}

export async function listRecipes(deps: RouteDeps): Promise<Record<string, unknown>> {
  const provider = activeProvider(deps.getConfig());
  if (provider?.type === "sdcpp") {
    return (await sdCppPassthrough(provider, "/sdcpp/v1/recipes")) as Record<string, unknown>;
  }
  return { recipes: [CHECKPOINT_RECIPE], errors: [] };
}

/** LoRA list for clients that map LoRA paths (sd-cpp launchers). Empty when
 *  the backend has no LoRA concept or is unreachable — clients then send
 *  paths unchanged, which is harmless. */
export async function listLoras(deps: RouteDeps): Promise<unknown[]> {
  const provider = activeProvider(deps.getConfig());
  try {
    if (provider?.type === "sdcpp") {
      const res = await sdCppFetchJson(provider, "/sdapi/v1/loras");
      return res.ok && Array.isArray(res.json) ? res.json : [];
    }
    if (provider?.type === "a1111") {
      const loras = await a1111Json(provider, "/sdapi/v1/loras");
      return Array.isArray(loras) ? loras : [];
    }
  } catch {
    /* fall through to empty list */
  }
  return [];
}
