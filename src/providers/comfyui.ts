import { randomInt, randomUUID } from "node:crypto";
import type { ComfyUIProviderConfig } from "../config/schema.js";
import { GenerationError, type ImageGenRequest, type Provider, type ProviderResult } from "../core/types.js";
import { applyMapping, type ComfyWorkflow } from "./workflow.js";

interface ComfyHistoryImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryNodeOutput {
  images?: ComfyHistoryImage[];
}

interface ComfyHistoryEntry {
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: [string, unknown][] | null;
  };
  outputs?: Record<string, ComfyHistoryNodeOutput>;
}

interface ComfyExecutionError {
  node_id?: string;
  node_type?: string;
  exception_message?: string;
}

export class ComfyUIProvider implements Provider {
  readonly type = "comfyui";

  constructor(private cfg: ComfyUIProviderConfig) {}

  get id(): string {
    return this.cfg.id;
  }

  get name(): string {
    return this.cfg.name;
  }

  private get base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  async generate(req: ImageGenRequest): Promise<ProviderResult> {
    const n = Math.max(1, Math.floor(req.n || 1));
    const d = this.cfg.defaults ?? {};
    const baseSeed =
      req.seed !== undefined && req.seed >= 0 ? req.seed : randomInt(0, 2 ** 48 - 1);

    const values: Record<string, unknown> = {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt ?? d.negativePrompt,
      width: req.width ?? d.width,
      height: req.height ?? d.height,
      steps: req.steps ?? d.steps,
      cfg: req.cfgScale ?? d.cfg,
      seed: baseSeed,
      sampler: req.sampler ?? d.sampler,
      scheduler: req.scheduler ?? d.scheduler,
      model: req.model,
    };

    // With a batch_size mapping a single run can produce n images;
    // otherwise we run the workflow n times with incremented seeds.
    const batchMapped = Boolean(this.cfg.mapping?.batch_size);
    const runs = batchMapped ? 1 : n;
    if (batchMapped) values.batch_size = n;

    const images: ProviderResult["images"] = [];
    for (let i = 0; i < runs; i++) {
      const runValues = { ...values };
      if (runs > 1) runValues.seed = baseSeed + i;
      const { workflow } = applyMapping(this.cfg.workflow as ComfyWorkflow, this.cfg.mapping ?? {}, runValues);
      images.push(...(await this.runWorkflow(workflow)));
    }

    return { images, meta: { seed: baseSeed, runs, batchMapped } };
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/system_stats`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { ok: false, detail: `ComfyUI responded with HTTP ${res.status}` };
      return { ok: true, detail: "ComfyUI reachable" };
    } catch (err) {
      return { ok: false, detail: `Cannot reach ComfyUI: ${(err as Error).message}` };
    }
  }

  private async runWorkflow(workflow: ComfyWorkflow): Promise<ProviderResult["images"]> {
    const clientId = randomUUID();
    let promptId: string;

    try {
      const res = await fetch(`${this.base}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new GenerationError(
          `ComfyUI rejected the workflow (HTTP ${res.status}): ${await safeText(res)}`,
        );
      }
      const json = (await res.json()) as { prompt_id?: string };
      if (!json.prompt_id) throw new GenerationError("ComfyUI did not return a prompt_id");
      promptId = json.prompt_id;
    } catch (err) {
      if (err instanceof GenerationError) throw err;
      throw new GenerationError(`Cannot submit workflow to ComfyUI at ${this.base}: ${(err as Error).message}`, {
        cause: err,
      });
    }

    const deadline = Date.now() + this.cfg.timeoutMs;
    let lastEntry: ComfyHistoryEntry | undefined;
    while (Date.now() < deadline) {
      await sleep(this.cfg.pollIntervalMs);
      const res = await fetch(`${this.base}/history/${promptId}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new GenerationError(`ComfyUI history request failed (HTTP ${res.status}): ${await safeText(res)}`);
      }
      const history = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = history[promptId];
      if (!entry) continue; // still queued/running

      lastEntry = entry;
      const statusStr = entry.status?.status_str;
      if (statusStr === "error" || statusStr === "interrupted") {
        const messages = entry.status?.messages ?? [];
        const err = messages.find((m) => m[0] === "execution_error")?.[1] as
          | ComfyExecutionError
          | undefined;
        const where = err?.node_type
          ? ` in ${err.node_type}${err.node_id ? ` (node ${err.node_id})` : ""}`
          : "";
        throw new GenerationError(
          `ComfyUI execution error${where}: ${err?.exception_message ?? statusStr ?? "unknown error"}`,
        );
      }
      if (entry.status?.completed) {
        return await this.collectImages(entry);
      }
    }
    throw new GenerationError(
      `ComfyUI generation timed out after ${Math.round(this.cfg.timeoutMs / 1000)}s${
        lastEntry?.status?.status_str ? ` (last status: ${lastEntry.status.status_str})` : ""
      }`,
      { statusCode: 504 },
    );
  }

  private async collectImages(entry: ComfyHistoryEntry): Promise<ProviderResult["images"]> {
    const images: ProviderResult["images"] = [];
    for (const output of Object.values(entry.outputs ?? {})) {
      for (const img of output.images ?? []) {
        const url =
          `${this.base}/view?filename=${encodeURIComponent(img.filename)}` +
          `&subfolder=${encodeURIComponent(img.subfolder ?? "")}` +
          `&type=${encodeURIComponent(img.type ?? "output")}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) {
          throw new GenerationError(
            `Failed to download generated image '${img.filename}' from ComfyUI (HTTP ${res.status})`,
          );
        }
        images.push({
          data: new Uint8Array(await res.arrayBuffer()),
          mime: res.headers.get("content-type")?.split(";")[0] ?? "image/png",
        });
      }
    }
    if (images.length === 0) {
      throw new GenerationError("ComfyUI completed the workflow but produced no images");
    }
    return images;
  }
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
