import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { ConfigStore } from "./config/loader.js";
import { GenerationPipeline } from "./core/pipeline.js";
import { ProviderRegistry } from "./core/registry.js";
import { HistoryDb } from "./history/db.js";
import { ImageStore } from "./history/images.js";

const projectRoot = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dataDir = process.env.IMGPROXY_DATA
  ? path.resolve(process.env.IMGPROXY_DATA)
  : path.join(projectRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

const configStore = new ConfigStore(path.join(dataDir, "config.json"));
const db = new HistoryDb(path.join(dataDir, "imgproxy.db"));
const images = new ImageStore(path.join(dataDir, "images"));
const registry = new ProviderRegistry(configStore);
const pipeline = new GenerationPipeline(registry, db, images);

const app = buildApp({
  pipeline,
  db,
  images,
  getConfig: () => configStore.get(),
  saveConfig: (input) => configStore.update(input),
});

const { host, port } = configStore.get().server;

if (configStore.get().providers.length === 0) {
  app.log.warn("No providers configured yet — open the web UI to add one");
}

await app.listen({ host, port });
app.log.info(`imgproxy ready: UI on http://${host}:${port}`);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
