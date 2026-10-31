// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/schema.js";
import type { GenerationPipeline } from "../core/pipeline.js";
import { GenerationError } from "../core/types.js";
import {
  COMFY_FALLBACK_SAMPLERS,
  COMFY_FALLBACK_SCHEDULERS,
  fetchComfyParamValues,
} from "../providers/comfyui.js";
import type { ComfyWorkflow } from "../providers/workflow.js";
import {
  a1111ToRequest,
  A1111_SAMPLERS,
  A1111_SCHEDULERS,
  mappedModelName,
  MAX_PROXY_HOPS,
  modelEntry,
  proxyHops,
} from "./protocol.js";
import { listLoras } from "./sdcpp.models.js";
import { loadImage, type RouteDeps } from "./deps.js";

function activeProvider(cfg: AppConfig) {
  return cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0];
}

export async function registerA1111Routes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  // Note: the A1111 ecosystem has no bearer-token auth, so this surface only
  // has an enable toggle (see config schema).
  const enabled = () => deps.getConfig().apis.a1111.enabled;

  app.post("/sdapi/v1/txt2img", async (req, reply) => {
    if (!enabled()) return reply.status(404).send({ detail: "A1111 API disabled" });

    const hops = proxyHops(req.headers);
    if (hops > MAX_PROXY_HOPS) {
      return reply.status(400).send({
        detail: `Refusing to generate: this request has already been forwarded through ${hops} imgproxy instances. An imgproxy provider is probably pointing at itself or at another imgproxy in a loop.`,
      });
    }

    const genReq = a1111ToRequest((req.body ?? {}) as never);
    genReq.hops = hops;
    try {
      const result = await deps.pipeline.run(genReq);
      return {
        images: result.images.map((img) => readB64(deps, img.imageId)),
        parameters: {
          prompt: genReq.prompt,
          negative_prompt: genReq.negativePrompt ?? "",
          width: genReq.width,
          height: genReq.height,
          steps: genReq.steps,
          cfg_scale: genReq.cfgScale,
          seed: genReq.seed ?? -1,
          sampler_name: genReq.sampler ?? "",
          batch_size: genReq.n,
          n_iter: 1,
          sd_model_checkpoint: genReq.model ?? "",
        },
        info: JSON.stringify({ imgproxy: { requestId: result.requestId } }),
      };
    } catch (err) {
      const e = err as GenerationError;
      return reply.status(e.statusCode ?? 500).send({ detail: e.message });
    }
  });

  // --- Compatibility stubs so common A1111 clients can connect and render their UIs ---

  app.get("/sdapi/v1/options", async (req, reply) => {
    if (!enabled()) return reply.status(404).send({ detail: "A1111 API disabled" });
    // samples_format must be non-null: clients like KoboldAI Lite treat its
    // absence as "invalid data" and refuse to connect.
    return {
      sd_model_checkpoint: mappedModelName(activeProvider(deps.getConfig())) ?? "",
      samples_format: "png",
      imgproxy: true,
    };
  });

  // Honoring model selection: when ComfyUI 'model' is mapped, a client picking
  // a checkpoint is written into the mapped workflow node and persisted.
  app.post("/sdapi/v1/options", async (req) => {
    const checkpoint = (req.body as { sd_model_checkpoint?: unknown } | undefined)?.sd_model_checkpoint;
    if (typeof checkpoint === "string" && checkpoint.trim()) {
      const cfg = deps.getConfig();
      const active = activeProvider(cfg);
      if (active?.type === "comfyui") {
        const target = active.mapping?.model;
        const workflow = structuredClone(active.workflow) as ComfyWorkflow;
        const node = target ? workflow[target.node] : undefined;
        if (target && node?.inputs && typeof node.inputs === "object") {
          node.inputs[target.input] = checkpoint.trim();
          const providers = cfg.providers.map((p) => (p.id === active.id ? { ...p, workflow } : p));
          try {
            deps.saveConfig({ ...cfg, providers });
            app.log.info(`sd_model_checkpoint set to '${checkpoint.trim()}' (mapped node ${target.node}.${target.input})`);
          } catch (err) {
            app.log.warn(`Could not persist sd_model_checkpoint: ${(err as Error).message}`);
          }
        }
      }
    }
    return {};
  });

  app.get("/sdapi/v1/sd-models", async () => {
    const cfg = deps.getConfig();
    const active = activeProvider(cfg);
    if (active?.type === "a1111") {
      // External A1111 backend: forward its real model list.
      try {
        const res = await fetch(`${active.baseUrl.replace(/\/+$/, "")}/sdapi/v1/sd-models`, {
          headers: active.apiKey ? { authorization: `Bearer ${active.apiKey}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return ((await res.json()) as unknown[]) ?? [];
      } catch {
        /* fall through to empty */
      }
      return [];
    }
    // Advertise only the model the active workflow/endpoint actually uses.
    const name = mappedModelName(active);
    return name ? [modelEntry(name)] : [];
  });

  app.get("/sdapi/v1/samplers", async () => listItems("sampler", A1111_SAMPLERS));

  // LoRA discovery for clients that map LoRA paths (e.g. sd-cpp launchers):
  // the real list when the active backend has one, empty otherwise — clients
  // then send paths unchanged. Reachable when either the A1111 or the sd-cpp
  // API is enabled, since both client families call it.
  app.get("/sdapi/v1/loras", async (_req, reply) => {
    const cfg = deps.getConfig();
    if (!cfg.apis.a1111.enabled && !cfg.apis.sdcpp.enabled) {
      return reply.status(404).send({ detail: "LoRA API disabled" });
    }
    return listLoras(deps);
  });

  app.get("/sdapi/v1/upscalers", async () => [{ name: "Lanczos" }]);

  app.get("/sdapi/v1/latent-upscale-modes", async () => []);

  app.get("/sdapi/v1/progress", async () => ({
    progress: 0,
    eta_relative: 0,
    state: { skipped: false, interrupted: false, job: "", job_count: 0, job_timestamp: "", current_image: null, sampling_step: 0, sampling_steps: 0 },
    current_image: null,
    textinfo: null,
  }));

  app.post("/sdapi/v1/interrupt", async () => ({}));

  app.get("/sdapi/v1/cmd-flags", async () => ({ api: true, listen: true }));

  app.get("/sdapi/v1/schedulers", async () => listItems("scheduler", A1111_SCHEDULERS));

  app.get("/internal/ping", async () => "pong");

  /**
   * Advertises real ComfyUI values when the given parameter is mapped onto a
   * ComfyUI workflow input (so clients send names ComfyUI accepts); otherwise
   * the static A1111 vocabulary is fine since the value is not forwarded.
   */
  async function listItems(
    param: "sampler" | "scheduler",
    fallback: { name: string; aliases: never[]; options: {}; description: string }[],
  ) {
    const active = activeProvider(deps.getConfig());
    if (active?.type !== "comfyui" || !active.mapping?.[param]) return fallback;

    let names: string[];
    try {
      names = await fetchComfyParamValues(active, param);
    } catch (err) {
      app.log.warn(`sdapi ${param} list: ${(err as Error).message}; using built-in ComfyUI fallback`);
      names = param === "sampler" ? COMFY_FALLBACK_SAMPLERS : COMFY_FALLBACK_SCHEDULERS;
    }
    return names.map((name) => ({
      name,
      aliases: [],
      options: {},
      description: `ComfyUI ${param} (forwarded by imgproxy): ${name}`,
    }));
  }
}

function readB64(deps: RouteDeps, imageId: string): string {
  const image = loadImage(deps, imageId);
  if (!image) throw new GenerationError(`Stored image ${imageId} not found`, { statusCode: 500 });
  return image.data.toString("base64");
}
