// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

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
