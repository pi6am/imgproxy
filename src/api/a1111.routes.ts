import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { GenerationPipeline } from "../core/pipeline.js";
import { GenerationError } from "../core/types.js";
import { a1111ToRequest, A1111_SAMPLERS } from "./protocol.js";
import { tokenOk } from "./openai.routes.js";
import type { RouteDeps } from "./deps.js";

export async function registerA1111Routes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const guard = () => {
    const cfg = deps.getConfig();
    return {
      enabled: cfg.apis.a1111.enabled,
      token: cfg.apis.a1111.token,
    };
  };

  app.post("/sdapi/v1/txt2img", async (req, reply) => {
    const { enabled, token } = guard();
    if (!enabled) return reply.status(404).send({ detail: "A1111 API disabled" });
    if (!tokenOk(req, token)) return reply.status(401).send({ detail: "Invalid or missing bearer token" });

    const genReq = a1111ToRequest((req.body ?? {}) as never);
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
    if (!guard().enabled) return reply.status(404).send({ detail: "A1111 API disabled" });
    return { sd_model_checkpoint: "", imgproxy: true };
  });

  app.post("/sdapi/v1/options", async () => ({}));

  app.get("/sdapi/v1/sd-models", async () =>
    deps.getConfig().providers.map((p) => ({ model_name: p.name, title: `${p.name} (${p.type})`, hash: p.id, sha256: p.id, filename: `/imgproxy/${p.id}` })),
  );

  app.get("/sdapi/v1/samplers", async () => A1111_SAMPLERS);

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

  app.get("/sdapi/v1/schedulers", async () => []);

  app.get("/internal/ping", async () => "pong");
}

function readB64(deps: RouteDeps, imageId: string): string {
  const row = deps.db.getImage(imageId);
  if (!row) throw new GenerationError(`Stored image ${imageId} not found`, { statusCode: 500 });
  return fs.readFileSync(deps.images.resolve(row.filename)).toString("base64");
}
