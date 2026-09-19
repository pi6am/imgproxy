// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { z } from "zod";

/** Parameters that can be mapped onto ComfyUI workflow node inputs. */
export const MAPPABLE_PARAMS = [
  "prompt",
  "negative_prompt",
  "width",
  "height",
  "seed",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "batch_size",
  "model",
] as const;

export type MappableParam = (typeof MAPPABLE_PARAMS)[number];

/** Points a public parameter at a specific node input in a ComfyUI workflow. */
export const nodeMappingSchema = z.object({
  node: z.string().min(1),
  input: z.string().min(1),
});

export type NodeMapping = z.infer<typeof nodeMappingSchema>;

export const genDefaultsSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  steps: z.number().int().positive().optional(),
  cfg: z.number().nonnegative().optional(),
  seed: z.number().int().nonnegative().optional(),
  sampler: z.string().optional(),
  scheduler: z.string().optional(),
  negativePrompt: z.string().optional(),
});

export type GenDefaults = z.infer<typeof genDefaultsSchema>;

export const comfyuiProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("comfyui"),
  baseUrl: z.string().min(1),
  /** Optional bearer token sent to ComfyUI (for instances behind token auth). */
  apiKey: z.string().default(""),
  /** ComfyUI API-format workflow: node id -> node definition. */
  workflow: z.record(z.string(), z.unknown()),
  /** Public parameter name -> node/input target (null = not mapped). */
  mapping: z.record(z.string(), nodeMappingSchema.nullable()).default({}),
  defaults: genDefaultsSchema.default({}),
  pollIntervalMs: z.number().int().positive().max(60_000).default(500),
  timeoutMs: z.number().int().positive().default(600_000),
});

export const openaiProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("openai"),
  /** Base URL of an OpenAI-compatible endpoint, up to and including /v1. */
  baseUrl: z.string().min(1),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-image-1"),
  timeoutMs: z.number().int().positive().default(300_000),
});

export const a1111ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("a1111"),
  /** Base URL of an A1111-compatible endpoint, e.g. http://host:7860 */
  baseUrl: z.string().min(1),
  apiKey: z.string().default(""),
  timeoutMs: z.number().int().positive().default(300_000),
});

export const providerSchema = z.discriminatedUnion("type", [
  comfyuiProviderSchema,
  openaiProviderSchema,
  a1111ProviderSchema,
]);

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ComfyUIProviderConfig = z.infer<typeof comfyuiProviderSchema>;
export type OpenAIProviderConfig = z.infer<typeof openaiProviderSchema>;
export type A1111ProviderConfig = z.infer<typeof a1111ProviderSchema>;

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(7800),
    })
    .default({ host: "127.0.0.1", port: 7800 }),
  apis: z
    .object({
      openai: z
        .object({
          enabled: z.boolean().default(true),
          token: z.string().default(""),
        })
        .default({ enabled: true, token: "" }),
      // Note: the A1111 ecosystem has no bearer-token auth (A1111/Forge use
      // HTTP Basic via --api-auth; most clients send nothing), so the exposed
      // A1111 API only has an enable toggle.
      a1111: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    })
    .default({ openai: { enabled: true, token: "" }, a1111: { enabled: true } }),
  history: z
    .object({
      /** When false, new requests/images are not recorded; existing entries are kept. */
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  activeProviderId: z.string().default(""),
  providers: z.array(providerSchema).default([]),
});

export type AppConfig = z.infer<typeof configSchema>;

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
