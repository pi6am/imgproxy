// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import type { A1111ProviderConfig } from "../config/schema.js";
import { GenerationError, type ImageGenRequest, type Provider, type ProviderResult } from "../core/types.js";

interface A1111Txt2ImgResponse {
  images?: string[];
  info?: string;
}

export class A1111Provider implements Provider {
  readonly type = "a1111";

  constructor(private cfg: A1111ProviderConfig) {}

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
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt ?? "",
      steps: req.steps ?? 20,
      cfg_scale: req.cfgScale ?? 7,
      width: req.width ?? 512,
      height: req.height ?? 512,
      // -1 lets the remote A1111 randomize the seed per iteration.
      seed: req.seed !== undefined && req.seed >= 0 ? req.seed : -1,
      sampler_name: req.sampler ?? "Euler a",
      batch_size: 1,
      n_iter: n,
    };
    if (req.model) body.override_settings = { sd_model_checkpoint: req.model };

    let res: Response;
    try {
      res = await fetch(`${this.base}/sdapi/v1/txt2img`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Loop detection: tell an imgproxy downstream (if that's what this
          // is) how many instances this request has already passed through.
          "x-imgproxy-depth": String((req.hops ?? 0) + 1),
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new GenerationError(`Cannot reach A1111 endpoint at ${this.base}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (!res.ok) {
      throw new GenerationError(`Upstream A1111 error (HTTP ${res.status}): ${await safeText(res)}`);
    }
    const json = (await res.json()) as A1111Txt2ImgResponse;
    const b64s = json.images ?? [];
    if (b64s.length === 0) throw new GenerationError("Upstream A1111 API returned no images");

    return {
      images: b64s.map((b64) => ({
        data: new Uint8Array(Buffer.from(b64, "base64")),
        mime: "image/png",
      })),
      meta: { upstreamInfo: json.info ? safeJsonParse(json.info) : undefined, n },
    };
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/sdapi/v1/options`, {
        headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, detail: `Endpoint responded with HTTP ${res.status}` };
      return { ok: true, detail: "A1111 endpoint reachable" };
    } catch (err) {
      return { ok: false, detail: `Cannot reach endpoint: ${(err as Error).message}` };
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function safeText(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
