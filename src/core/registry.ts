import type { ConfigStore } from "../config/loader.js";
import type { ProviderConfig } from "../config/schema.js";
import { GenerationError } from "../core/types.js";
import type { Provider } from "../core/types.js";
import { ComfyUIProvider } from "../providers/comfyui.js";
import { OpenAIProvider } from "../providers/openai.js";
import { A1111Provider } from "../providers/a1111.js";

export function createProvider(cfg: ProviderConfig): Provider {
  switch (cfg.type) {
    case "comfyui":
      return new ComfyUIProvider(cfg);
    case "openai":
      return new OpenAIProvider(cfg);
    case "a1111":
      return new A1111Provider(cfg);
  }
}

/**
 * Creates providers on demand from the current config.
 * Provider objects are cheap; no caching avoids stale-config bugs.
 */
export class ProviderRegistry {
  constructor(private store: ConfigStore) {}

  get active(): Provider {
    const config = this.store.get();
    const providerConfig =
      config.providers.find((p) => p.id === config.activeProviderId) ?? config.providers[0];
    if (!providerConfig) {
      throw new GenerationError(
        "No generation provider is configured. Open the imgproxy web UI to add one.",
        { statusCode: 503 },
      );
    }
    return createProvider(providerConfig);
  }

  get(id: string): Provider {
    const providerConfig = this.store.get().providers.find((p) => p.id === id);
    if (!providerConfig) {
      throw new GenerationError(`Unknown provider '${id}'`, { statusCode: 404 });
    }
    return createProvider(providerConfig);
  }
}
