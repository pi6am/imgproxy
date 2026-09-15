import { randomUUID } from "node:crypto";
import type { HistoryDb } from "../history/db.js";
import type { ImageStore, StoredImageMeta } from "../history/images.js";
import { GenerationError } from "./types.js";
import type { ImageGenRequest } from "./types.js";
import type { ProviderRegistry } from "./registry.js";

export interface PipelineImage extends StoredImageMeta {
  url: string;
}

export interface PipelineResult {
  requestId: string;
  status: "succeeded";
  images: PipelineImage[];
}

/** Runs a normalized request through the active provider and records it in history. */
export class GenerationPipeline {
  constructor(
    private registry: ProviderRegistry,
    private db: HistoryDb,
    private images: ImageStore,
  ) {}

  async run(req: ImageGenRequest, opts?: { providerId?: string }): Promise<PipelineResult> {
    const provider = opts?.providerId ? this.registry.get(opts.providerId) : this.registry.active;

    const id = randomUUID();
    this.db.createRequest({
      id,
      source: req.source,
      providerId: provider.id,
      providerType: provider.type,
      requestJson: JSON.stringify(req),
    });

    try {
      const result = await provider.generate(req);
      const stored = result.images.map((img) => this.images.save(img.data, img.mime, id));
      for (const meta of stored) {
        this.db.addImage({
          id: meta.imageId,
          requestId: id,
          filename: meta.filename,
          mime: meta.mime,
          width: meta.width,
          height: meta.height,
          bytes: meta.bytes,
        });
      }
      this.db.completeRequest(
        id,
        JSON.stringify({ providerName: provider.name, meta: result.meta ?? {}, images: stored }),
      );
      return {
        requestId: id,
        status: "succeeded",
        images: stored.map((meta) => ({ ...meta, url: `/api/images/${meta.imageId}/file` })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.failRequest(id, message);
      if (err instanceof GenerationError) throw err;
      throw new GenerationError(`Provider '${provider.name}' failed: ${message}`, { cause: err });
    }
  }
}
