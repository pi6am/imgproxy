export type ApiSource = "openai" | "a1111" | "ui";

/** Protocol-independent image generation request, normalized across public APIs. */
export interface ImageGenRequest {
  source: ApiSource;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  /** Omit (or negative) for a random seed. */
  seed?: number;
  sampler?: string;
  scheduler?: string;
  /** Total number of images requested. */
  n: number;
  model?: string;
}

export interface GeneratedImage {
  data: Uint8Array;
  mime: string;
}

export interface ProviderResult {
  images: GeneratedImage[];
  /** Free-form metadata recorded in history (e.g. the seed actually used). */
  meta?: Record<string, unknown>;
}

export interface Provider {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  generate(req: ImageGenRequest): Promise<ProviderResult>;
  /** Lightweight connectivity/configuration check for the UI. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

export class GenerationError extends Error {
  readonly statusCode: number;

  constructor(message: string, options?: { statusCode?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.statusCode = options?.statusCode ?? 502;
  }
}
