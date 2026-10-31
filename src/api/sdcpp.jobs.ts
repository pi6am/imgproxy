// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { randomUUID } from "node:crypto";
import { loadImage, type RouteDeps } from "./deps.js";

/**
 * In-memory backing for the sd-cpp API's async job model. imgproxy's pipeline
 * is synchronous, so POST /sdcpp/v1/img_gen runs it in the background and this
 * store tracks the outcome. Jobs live for the process lifetime (bounded by
 * MAX_RETAINED_JOBS); a restart forgets them, which clients observe as 404 —
 * the same "job gone" signal an sd-cpp server produces after a restart.
 */
export type SdCppJobStatus = "queued" | "generating" | "completed" | "failed" | "cancelled";

export interface SdCppJobRecord {
  readonly id: string;
  readonly kind: "img_gen";
  status: SdCppJobStatus;
  /** Integer Unix timestamps in milliseconds. */
  readonly created: number;
  started: number | null;
  completed: number | null;
  /** Stored image references, resolved lazily on each poll. */
  images: Array<{ imageId: string; mime: string }>;
  error: { code: string; message: string } | null;
}

const MAX_RETAINED_JOBS = 100;

const FORMAT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

export class SdCppJobStore {
  private jobs = new Map<string, SdCppJobRecord>();

  create(): SdCppJobRecord {
    const job: SdCppJobRecord = {
      id: `job_${randomUUID()}`,
      kind: "img_gen",
      status: "queued",
      created: Date.now(),
      started: null,
      completed: null,
      images: [],
      error: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): SdCppJobRecord | undefined {
    return this.jobs.get(id);
  }

  start(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "generating";
    job.started = Date.now();
  }

  complete(id: string, images: Array<{ imageId: string; mime: string }>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "completed";
    job.completed = Date.now();
    job.images = images;
    this.prune();
  }

  fail(id: string, code: string, message: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "failed";
    job.completed = Date.now();
    job.error = { code, message };
    this.prune();
  }

  /** Evicts the oldest finished jobs once the cap is exceeded; running jobs
   *  are never dropped. Evicted jobs answer 404 ("job gone"). */
  private prune(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_RETAINED_JOBS) break;
      if (job.status === "queued" || job.status === "generating") continue;
      this.jobs.delete(id);
    }
  }
}

/** Builds the sd-cpp wire shape for a job; image bytes are loaded lazily so
 *  polls don't copy image data into the store. */
export function jobView(
  deps: RouteDeps,
  job: SdCppJobRecord,
): { httpStatus: number; body: Record<string, unknown> } {
  if (job.status === "completed") {
    const images = job.images.flatMap((ref, index) => {
      const stored = loadImage(deps, ref.imageId);
      return stored ? [{ index, b64_json: stored.data.toString("base64") }] : [];
    });
    if (images.length === 0) {
      // All result images were evicted (history off + memory caps, or files
      // deleted) — report the job as gone, like a reaped sd-cpp job.
      return {
        httpStatus: 410,
        body: {
          error: `Job '${job.id}' result is no longer available`,
          code: "job_result_expired",
        },
      };
    }
    return {
      httpStatus: 200,
      body: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        created: job.created,
        started: job.started,
        completed: job.completed,
        queue_position: 0,
        result: {
          output_format: FORMAT_BY_MIME[job.images[0]!.mime] ?? "png",
          images,
        },
        error: null,
        preview: null,
      },
    };
  }
  return {
    httpStatus: 200,
    body: {
      id: job.id,
      kind: job.kind,
      status: job.status,
      created: job.created,
      started: job.started,
      completed: job.completed,
      queue_position: 0,
      result: null,
      error: job.error,
      preview: null,
    },
  };
}
