// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "../config/schema.js";
import { GenerationError } from "../core/types.js";
import { A1111_SAMPLERS, A1111_SCHEDULERS, mappedModelName, sdcppToRequest } from "./protocol.js";
import { jobView, SdCppJobStore } from "./sdcpp.jobs.js";
import {
  listModelFiles,
  listRecipes,
  loadModels,
  modelsStatus,
  refreshModels,
  unloadModels,
  UpstreamError,
} from "./sdcpp.models.js";
import type { RouteDeps } from "./deps.js";

const OUTPUT_FORMATS = ["png", "jpeg", "webp"];

const IMG_GEN_DEFAULTS = {
  prompt: "",
  negative_prompt: "",
  clip_skip: -1,
  width: 1024,
  height: 1024,
  strength: 0.75,
  seed: -1,
  batch_count: 1,
  ref_image_args: "",
  increase_ref_index: false,
  control_strength: 0.9,
  ip_adapter_strength: 1.0,
  embed_image_metadata: false,
  sample_params: {
    scheduler: "Automatic",
    sample_method: "Euler a",
    sample_steps: 20,
    eta: null,
    shifted_timestep: 0,
    custom_sigmas: [],
    flow_shift: null,
    guidance: {
      txt_cfg: 7,
      img_cfg: null,
      distilled_guidance: 3.5,
      slg: { layers: [], layer_start: 0.01, layer_end: 0.2, scale: 0 },
    },
  },
  lora: [],
  vae_tiling_params: {
    enabled: false,
    temporal_tiling: false,
    tile_size_w: 0,
    tile_size_h: 0,
    target_overlap: 0.5,
    rel_size_w: 0.0,
    rel_size_h: 0.0,
    extra_tiling_args: "",
  },
  cache_mode: "disabled",
  cache_option: "",
  scm_mask: "",
  scm_policy_dynamic: true,
  output_format: "png",
  output_compression: 100,
};

function activeProvider(cfg: AppConfig) {
  return cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0];
}

/** Purely local (no upstream calls): the launcher polls this until imgproxy
 *  answers, so it must never hang or depend on backend reachability. */
function capabilitiesPayload(cfg: AppConfig): Record<string, unknown> {
  const provider = activeProvider(cfg);
  const model = mappedModelName(provider);
  const defaults = IMG_GEN_DEFAULTS;
  const features = {
    init_image: false,
    mask_image: false,
    control_image: false,
    ip_adapter_image: false,
    ref_images: false,
    lora: provider?.type === "sdcpp",
    vae_tiling: false,
    hires: false,
    cache: false,
    cancel_queued: false,
    cancel_generating: false,
    preview: false,
  };
  return {
    model: model ? { name: model, stem: model } : null,
    current_mode: "img_gen",
    supported_modes: ["img_gen"],
    defaults,
    output_formats: OUTPUT_FORMATS,
    features,
    defaults_by_mode: { img_gen: defaults },
    output_formats_by_mode: { img_gen: OUTPUT_FORMATS },
    features_by_mode: { img_gen: features },
    samplers: A1111_SAMPLERS.map((s) => s.name),
    schedulers: A1111_SCHEDULERS.map((s) => s.name),
    loras: [],
    upscalers: [],
    upscale: false,
    preview_modes: ["none"],
    limits: {
      min_width: 64,
      max_width: 4096,
      min_height: 64,
      max_height: 4096,
      max_batch_count: 16,
      max_queue_size: 100,
      max_upscale_width: 8192,
      max_upscale_height: 8192,
    },
  };
}

export async function registerSdCppRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  // Note: like the A1111 surface, the sd-cpp ecosystem has no bearer-token
  // auth, so this API only has an enable toggle (see config schema).
  const enabled = () => deps.getConfig().apis.sdcpp.enabled;
  const jobs = new SdCppJobStore();

  const disabled = (reply: FastifyReply) =>
    reply.status(404).send({ error: "sd-cpp API disabled on this imgproxy instance", code: "api_disabled" });

  const sendError = (reply: FastifyReply, err: unknown) => {
    const e = err as GenerationError;
    // Forward upstream sd-cpp errors verbatim (status + body, incl. codes
    // like model_busy / model_not_loaded) so chained launchers see them.
    if (err instanceof UpstreamError) return reply.code(e.statusCode ?? 502).send(err.body);
    return reply.status(e.statusCode ?? 502).send({ error: e.message, code: "upstream_error" });
  };

  // --- Discovery / health check ---

  app.get("/sdcpp/v1/capabilities", async (_req, reply) => {
    if (!enabled()) return disabled(reply);
    return capabilitiesPayload(deps.getConfig());
  });

  app.get("/sdcpp/v1/recipes", async (_req, reply) => {
    if (!enabled()) return disabled(reply);
    try {
      return await listRecipes(deps);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- Model management ---

  app.get("/sdcpp/v1/model-files", async (_req, reply) => {
    if (!enabled()) return disabled(reply);
    try {
      return await listModelFiles(deps);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/sdcpp/v1/models/status", async (_req, reply) => {
    if (!enabled()) return disabled(reply);
    try {
      return await modelsStatus(deps);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/sdcpp/v1/models/load", async (req, reply) => {
    if (!enabled()) return disabled(reply);
    try {
      return await loadModels(deps, req.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/sdcpp/v1/models/unload", async (_req, reply) => {
    if (!enabled()) return disabled(reply);
    try {
      return await unloadModels(deps);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/sdcpp/v1/models/refresh", async (_req, reply) => {
    if (!enabled()) return disabled(reply);
    try {
      return await refreshModels(deps);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- Generation ---

  app.post("/sdcpp/v1/vid_gen", async (_req, reply) => {
    if (!enabled()) return disabled(reply);
    return reply
      .status(400)
      .send({ error: "Video generation is not supported by imgproxy", code: "unsupported_mode" });
  });

  app.post("/sdcpp/v1/img_gen", async (req, reply) => {
    if (!enabled()) return disabled(reply);

    let parsed: ReturnType<typeof sdcppToRequest>;
    try {
      parsed = sdcppToRequest((req.body ?? {}) as never);
    } catch (err) {
      const e = err as GenerationError;
      return reply
        .status(e.statusCode ?? 400)
        .send({ error: e.message, code: "invalid_generation_parameters" });
    }
    if (!activeProvider(deps.getConfig())) {
      return reply
        .status(503)
        .send({ error: "No model is loaded: imgproxy has no configured provider", code: "model_not_loaded" });
    }

    const job = jobs.create();
    // The pipeline runs in the background; the job record tracks its progress.
    void (async () => {
      jobs.start(job.id);
      try {
        const result = await deps.pipeline.run(parsed);
        jobs.complete(job.id, result.images.map((img) => ({ imageId: img.imageId, mime: img.mime })));
      } catch (err) {
        app.log.warn(`sd-cpp job '${job.id}' failed: ${(err as Error).message}`);
        jobs.fail(job.id, "generation_failed", (err as Error).message);
      }
    })();

    return reply.code(202).send({
      id: job.id,
      kind: "img_gen",
      status: "queued",
      created: job.created,
      poll_url: `/sdcpp/v1/jobs/${job.id}`,
    });
  });

  app.get("/sdcpp/v1/jobs/:id", async (req, reply) => {
    if (!enabled()) return disabled(reply);
    const job = jobs.get((req.params as { id: string }).id);
    if (!job) return reply.status(404).send({ error: "Job not found", code: "job_not_found" });
    const view = jobView(deps, job);
    return reply.code(view.httpStatus).send(view.body);
  });

  app.post("/sdcpp/v1/jobs/:id/cancel", async (req, reply) => {
    if (!enabled()) return disabled(reply);
    const job = jobs.get((req.params as { id: string }).id);
    if (!job) return reply.status(404).send({ error: "Job not found", code: "job_not_found" });
    // imgproxy starts jobs immediately and cannot interrupt a provider
    // mid-generation, so cancellation is honestly reported as not requested.
    const view = jobView(deps, job);
    return reply.code(view.httpStatus).send({ ...view.body, cancel_requested: false });
  });
}
