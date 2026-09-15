import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { registerA1111Routes } from "./api/a1111.routes.js";
import { registerAdminRoutes } from "./api/admin.routes.js";
import { registerOpenAIRoutes } from "./api/openai.routes.js";
import type { RouteDeps } from "./api/deps.js";

export function buildApp(deps: RouteDeps): FastifyInstance {
  const pretty = process.stdout.isTTY;
  const app = Fastify({
    logger: pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
      : true,
  });

  // Local tool: allow browser clients on other origins (some A1111/OpenAI client UIs need this).
  app.addHook("onRequest", async (req, reply) => {
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
  void registerOpenAIRoutes(app, deps);
  void registerA1111Routes(app, deps);
  void registerAdminRoutes(app, deps);

  const clientDist = path.resolve(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    "client/dist",
  );
  if (fs.existsSync(path.join(clientDist, "index.html"))) {
    void app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? "/";
      if (url.startsWith("/api/") || url.startsWith("/v1/") || url.startsWith("/sdapi/")) {
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
      hint: "Web UI not built. Endpoints: POST /v1/images/generations, POST /sdapi/v1/txt2img",
    }));
  }

  return app;
}
