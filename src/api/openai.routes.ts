import fs from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { GenerationError } from "../core/types.js";
import { openAIToRequest } from "./protocol.js";
import type { RouteDeps } from "./deps.js";

export function openAIError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type = "invalid_request_error",
): FastifyReply {
  return reply.status(statusCode).send({
    error: { message, type, code: null, param: null },
  });
}

export function tokenOk(req: { headers: { authorization?: string } }, token: string): boolean {
  return !token || req.headers.authorization === `Bearer ${token}`;
}

export async function registerOpenAIRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.post("/v1/images/generations", async (req, reply) => {
    const cfg = deps.getConfig();
    if (!cfg.apis.openai.enabled) {
      return openAIError(reply, 404, "The images API is disabled on this imgproxy instance", "not_found_error");
    }
    if (!tokenOk(req, cfg.apis.openai.token)) {
      return openAIError(reply, 401, "Invalid or missing bearer token", "authentication_error");
    }

    let parsed: ReturnType<typeof openAIToRequest>;
    try {
      parsed = openAIToRequest((req.body ?? {}) as never);
    } catch (err) {
      const e = err as GenerationError;
      return openAIError(reply, e.statusCode ?? 400, e.message);
    }

    try {
      const result = await deps.pipeline.run(parsed.request);
      const origin = `${req.protocol}://${req.headers.host}`;
      const data = result.images.map((img) =>
        parsed.responseFormat === "b64_json"
          ? { b64_json: readFileAsB64(deps, img.imageId) }
          : { url: `${origin}${img.url}` },
      );
      return { created: Math.floor(Date.now() / 1000), data };
    } catch (err) {
      const e = err as GenerationError;
      return openAIError(
        reply,
        e.statusCode ?? 500,
        e.message,
        (e.statusCode ?? 500) === 400 ? "invalid_request_error" : "api_error",
      );
    }
  });

  app.get("/v1/models", async (req, reply) => {
    const cfg = deps.getConfig();
    if (!cfg.apis.openai.enabled) {
      return openAIError(reply, 404, "The models API is disabled on this imgproxy instance", "not_found_error");
    }
    if (!tokenOk(req, cfg.apis.openai.token)) {
      return openAIError(reply, 401, "Invalid or missing bearer token", "authentication_error");
    }
    const provider = cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0];
    return {
      object: "list",
      data: provider ? [{ id: provider.id, object: "model", owned_by: "imgproxy" }] : [],
    };
  });
}

function readFileAsB64(deps: RouteDeps, imageId: string): string {
  const row = deps.db.getImage(imageId);
  if (!row) throw new GenerationError(`Stored image ${imageId} not found`, { statusCode: 500 });
  return fs.readFileSync(deps.images.resolve(row.filename)).toString("base64");
}
