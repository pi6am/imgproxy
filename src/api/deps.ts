import type { AppConfig } from "../config/schema.js";
import type { GenerationPipeline } from "../core/pipeline.js";
import type { HistoryDb } from "../history/db.js";
import type { ImageStore } from "../history/images.js";

export interface RouteDeps {
  pipeline: GenerationPipeline;
  db: HistoryDb;
  images: ImageStore;
  getConfig: () => AppConfig;
  saveConfig: (input: unknown) => AppConfig;
}
