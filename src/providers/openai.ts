// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import type { OpenAIProviderConfig } from "../config/schema.js";
import { GenerationError, type ImageGenRequest, type Provider, type ProviderResult } from "../core/types.js";

interface OpenAIImageData {
  b64_json?: string;
  url?: string;
}

export class OpenAIProvider implements Provider {
  readonly type = "openai";

  constructor(private cfg: OpenAIProviderConfig) {}

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
      model: req.model || this.cfg.model,
      prompt: req.prompt,
      n,
    };
    if (req.width && req.height) body.size = `${req.width}x${req.height}`;
    // Loop detection: tell an imgproxy downstream (if that's what this is)
    // how many instances this request has already passed through.
    const extraHeaders = { "x-imgproxy-depth": String((req.hops ?? 0) + 1) };

    let res = await this.post({ ...body, response_format: "b64_json" }, extraHeaders);
    // Some newer endpoints (e.g. gpt-image-1) reject the response_format param entirely.
    if (res.status === 400) {
      const text = await res.text();
      if (/response_format/i.test(text)) {
        res = await this.post(body, extraHeaders);
      } else {
        throw new GenerationError(`Upstream API error (400): ${trim(text)}`);
      }
    }
    if (!res.ok) throw new GenerationError(`Upstream API error (${res.status}): ${await safeText(res)}`);

    const json = (await res.json()) as { data?: OpenAIImageData[] };
    const items = json.data ?? [];
    if (items.length === 0) throw new GenerationError("Upstream API returned no images");

    const images: ProviderResult["images"] = [];
    for (const item of items) {
      if (item.b64_json) {
        images.push({ data: new Uint8Array(Buffer.from(item.b64_json, "base64")), mime: "image/png" });
      } else if (item.url) {
        images.push(await fetchImage(item.url));
      } else {
        throw new GenerationError("Upstream API returned an image with neither b64_json nor url");
      }
    }
    return { images, meta: { model: body.model, n } };
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `Endpoint reachable but rejected the API key (HTTP ${res.status})` };
      }
      // Some compatible endpoints don't implement /models; any HTTP response still proves reachability.
      return { ok: true, detail: `Endpoint reachable (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, detail: `Cannot reach endpoint: ${(err as Error).message}` };
    }
  }

  private authHeaders(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  private post(body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return fetch(`${this.base}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders(), ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
  }
}

async function fetchImage(url: string): Promise<ProviderResult["images"][number]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new GenerationError(`Failed to download generated image (HTTP ${res.status})`);
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    mime: res.headers.get("content-type")?.split(";")[0] ?? "image/png",
  };
}

async function safeText(res: Response): Promise<string> {
  return trim(await res.text());
}

function trim(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
