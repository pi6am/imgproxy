// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import type { FastifyInstance, FastifyReply } from "fastify";
import { GenerationError } from "../core/types.js";
import { openAIToRequest } from "./protocol.js";
import { loadImage, type RouteDeps } from "./deps.js";

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

/** A bare host[:port] (hostname, IPv4, or bracketed IPv6) — the only Host
 * header forms that are safe to reflect into response URLs. */
const SAFE_HOST = /^(?:[A-Za-z0-9.\-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

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
      const rawHost = req.headers.host ?? "";
      const host = SAFE_HOST.test(rawHost) ? rawHost : `127.0.0.1:${cfg.server.port}`;
      const origin = `${req.protocol}://${host}`;
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
  const image = loadImage(deps, imageId);
  if (!image) throw new GenerationError(`Stored image ${imageId} not found`, { statusCode: 500 });
  return image.data.toString("base64");
}
