// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import fs from "node:fs";
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

/**
 * Loads a generated image for a response: from history (disk), or — for
 * images made while history recording is disabled — from the in-memory store.
 */
export function loadImage(deps: RouteDeps, imageId: string): { data: Buffer; mime: string } | undefined {
  const row = deps.db.getImage(imageId);
  if (row) {
    try {
      return { data: fs.readFileSync(deps.images.resolve(row.filename)), mime: row.mime };
    } catch {
      return undefined;
    }
  }
  return deps.images.fetch(imageId);
}
