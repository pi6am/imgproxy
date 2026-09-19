// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

export interface NodeMapping {
  node: string;
  input: string;
}

export interface GenDefaults {
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
  negativePrompt?: string;
}

export interface ComfyUIProviderCfg {
  id: string;
  name: string;
  type: "comfyui";
  baseUrl: string;
  apiKey: string;
  workflow: Record<string, unknown>;
  mapping: Record<string, NodeMapping | null>;
  defaults: GenDefaults;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface OpenAIProviderCfg {
  id: string;
  name: string;
  type: "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface A1111ProviderCfg {
  id: string;
  name: string;
  type: "a1111";
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export type ProviderCfg = ComfyUIProviderCfg | OpenAIProviderCfg | A1111ProviderCfg;

export interface AppConfig {
  server: { host: string; port: number };
  apis: {
    openai: { enabled: boolean; token: string };
    a1111: { enabled: boolean };
  };
  history: { enabled: boolean };
  activeProviderId: string;
  providers: ProviderCfg[];
}

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

export interface WorkflowNodeInfo {
  id: string;
  classType: string;
  title?: string;
  inputs: { name: string; kind: "scalar" | "link"; valueType: string; value?: string }[];
}

export interface HistoryItem {
  id: string;
  created_at: number;
  source: string;
  provider_id: string;
  provider_type: string;
  status: "pending" | "succeeded" | "failed";
  error: string | null;
  image_count: number;
  thumb_image_id: string | null;
}

export interface HistoryDetail {
  request: HistoryItem & { request_json: string; response_json: string | null };
  images: { id: string; mime: string; width: number | null; height: number | null; bytes: number; url: string }[];
}

export interface GenerateResult {
  requestId: string;
  images: { imageId: string; url: string; mime: string; width?: number; height?: number; bytes: number }[];
}
