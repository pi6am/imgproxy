import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConfigError } from "../config/loader.js";
import { createProvider } from "../core/registry.js";
import { listWorkflowNodes, type ComfyWorkflow } from "../providers/workflow.js";
import { clampInt, optNum, optStr } from "./protocol.js";
import type { RouteDeps } from "./deps.js";

export async function registerAdminRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { pipeline, db, images } = deps;

  app.get("/api/config", async () => deps.getConfig());

  app.put("/api/config", async (req, reply) => {
    try {
      return deps.saveConfig(req.body);
    } catch (err) {
      if (err instanceof ConfigError || err instanceof z.ZodError) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      throw err;
    }
  });

  app.post("/api/workflow/analyze", async (req, reply) => {
    const workflow = (req.body as { workflow?: unknown })?.workflow;
    const parsed = z.record(z.string(), z.unknown()).safeParse(workflow);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Body must contain a ComfyUI API-format workflow object" });
    }
    const nodes = listWorkflowNodes(parsed.data as ComfyWorkflow);
    if (nodes.length === 0) {
      return reply.status(400).send({ error: "Workflow contains no recognizable nodes" });
    }
    return { nodes };
  });

  app.post("/api/providers/:id/check", async (req, reply) => {
    const { id } = req.params as { id: string };
    const providerConfig = deps.getConfig().providers.find((p) => p.id === id);
    if (!providerConfig) return reply.status(404).send({ error: `Unknown provider '${id}'` });
    return createProvider(providerConfig).check();
  });

  app.post("/api/generate", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return reply.status(400).send({ error: "'prompt' is required" });
    try {
      return await pipeline.run(
        {
          source: "ui",
          prompt,
          negativePrompt: optStr(body.negativePrompt),
          width: optNum(body.width),
          height: optNum(body.height),
          steps: optNum(body.steps),
          cfgScale: optNum(body.cfgScale),
          seed: optNum(body.seed),
          sampler: optStr(body.sampler),
          scheduler: optStr(body.scheduler),
          n: clampInt(body.n, 1, 16, 1),
        },
        { providerId: optStr(body.providerId) },
      );
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get("/api/history", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = clampInt(Number(q.limit), 1, 100, 24);
    const offset = clampInt(Number(q.offset), 0, Number.MAX_SAFE_INTEGER, 0);
    return db.listRequests(limit, offset);
  });

  app.get("/api/history/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = db.getRequest(id);
    if (!request) return reply.status(404).send({ error: "Request not found" });
    return {
      request,
      images: db.listImages(id).map((img) => ({
        id: img.id,
        mime: img.mime,
        width: img.width,
        height: img.height,
        bytes: img.bytes,
        url: `/api/images/${img.id}/file`,
      })),
    };
  });

  app.delete("/api/history/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const files = db.deleteRequest(id);
    for (const file of files) images.delete(file);
    return { deleted: id };
  });

  app.delete("/api/history", async () => {
    const files = db.clear();
    for (const file of files) images.delete(file);
    return { cleared: true };
  });

  app.get("/api/images/:id/file", async (req, reply) => {
    const { id } = req.params as { id: string };
    const img = db.getImage(id);
    if (!img) return reply.status(404).send({ error: "Image not found" });
    const filePath = images.resolve(img.filename);
    if (!fs.existsSync(filePath)) return reply.status(404).send({ error: "Image file missing" });
    reply.header("content-type", img.mime);
    reply.header("cache-control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(filePath));
  });

  app.get("/api/images/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const img = db.getImage(id);
    if (!img) return reply.status(404).send({ error: "Image not found" });
    return { ...img, url: `/api/images/${img.id}/file` };
  });
}
