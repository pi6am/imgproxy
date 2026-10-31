// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { registerA1111Routes } from "./api/a1111.routes.js";
import { registerAdminRoutes } from "./api/admin.routes.js";
import { registerOpenAIRoutes } from "./api/openai.routes.js";
import { registerSdCppRoutes } from "./api/sdcpp.routes.js";
import type { RouteDeps } from "./api/deps.js";

export function buildApp(deps: RouteDeps): FastifyInstance {
  const pretty = process.stdout.isTTY;
  const app = Fastify({
    // Clients like KoboldAI Lite concatenate URL parts and can produce paths
    // such as //v1/images/generations; tolerate those instead of falling
    // through to the SPA fallback.
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    logger: pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
      : true,
  });

  // Local tool: allow browser clients on other origins (some A1111/OpenAI
  // client UIs need this) — but only on the public API surfaces. The web
  // UI's /api/* admin routes must stay same-origin only: with CORS granted
  // there, any website open in the user's browser could read provider API
  // keys from GET /api/config or rewrite the config via PUT /api/config.
  const PUBLIC_API_PREFIXES = ["/sdapi", "/v1", "/sdcpp", "/internal"];
  const isPublicApi = (url: string) => PUBLIC_API_PREFIXES.some((p) => url.split("?")[0]!.startsWith(p));
  app.addHook("onRequest", async (req, reply) => {
    if (!isPublicApi(req.url)) return;
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "content-type, authorization");
    reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      reply.status(204).send();
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    else req.log.warn(err.message);
    reply.status(status).send({ error: err.message });
  });

  // Concise request/response body logging for the public API surfaces, to make
  // client-compatibility debugging easy. Bodies are truncated; the web UI's own
  // /api traffic is excluded.
  const preview = (value: unknown): string => {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    return text.length > 500 ? `${text.slice(0, 500)}…(+${text.length - 500} chars)` : text;
  };
  app.addHook("preHandler", async (req) => {
    if (req.body !== undefined && req.body !== null && isPublicApi(req.url)) {
      req.log.info(`req body  ${req.method} ${req.url}: ${preview(req.body)}`);
    }
  });
  app.addHook("preSerialization", async (req, _reply, payload) => {
    if (payload !== undefined && payload !== null && isPublicApi(req.url)) {
      req.log.info(`res body  ${req.method} ${req.url}: ${preview(payload)}`);
    }
    return payload;
  });

  void registerOpenAIRoutes(app, deps);
  void registerA1111Routes(app, deps);
  void registerSdCppRoutes(app, deps);
  void registerAdminRoutes(app, deps);

  // Favicon files are served from the client/favicon directory at the
  // site root (browsers don't accept them from a subdirectory).
  const projectRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const FAVICON_FILES: Record<string, string> = {
    "favicon.ico": "image/x-icon",
    "favicon-16x16.png": "image/png",
    "favicon-32x32.png": "image/png",
    "apple-touch-icon.png": "image/png",
    "android-chrome-192x192.png": "image/png",
    "android-chrome-512x512.png": "image/png",
    "site.webmanifest": "application/manifest+json",
  };
  for (const [file, mime] of Object.entries(FAVICON_FILES)) {
    app.get(`/${file}`, (_req, reply) => {
      const filePath = path.join(projectRoot, "client", "favicon", file);
      if (!fs.existsSync(filePath)) return reply.status(404).send({ error: "Not found" });
      reply.header("content-type", mime);
      reply.header("cache-control", "public, max-age=604800");
      return reply.send(fs.createReadStream(filePath));
    });
  }

  const clientDist = path.resolve(projectRoot, "client/dist");
  if (fs.existsSync(path.join(clientDist, "index.html"))) {
    void app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? "/";
      if (url.startsWith("/api/") || url.startsWith("/v1/") || url.startsWith("/sdapi/") || url.startsWith("/sdcpp/")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.log.warn(
      `client/dist not found at ${clientDist} — web UI unavailable (run "npm run build" or use "npm run dev")`,
    );
    app.get("/", async () => ({
      service: "imgproxy",
      hint: "Web UI not built. Endpoints: POST /v1/images/generations, POST /sdapi/v1/txt2img, POST /sdcpp/v1/img_gen",
    }));
  }

  return app;
}
