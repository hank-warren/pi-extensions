import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { isClaudeModel } from "./model-api.ts";
import type { CpaProviderConfig } from "./types.ts";
import type { ProviderModelConfigLike } from "./types.ts";

// Narrowed to the chat-model shape this package builds; still assignable to ProviderConfig.
export type CpaProviderConfigInput = Omit<ProviderConfig, "models" | "refreshModels"> & {
  models: ProviderModelConfigLike[];
  refreshModels?: (context: RefreshModelsContext) => Promise<ProviderModelConfigLike[]>;
};

export interface ProviderRegistration {
  providerName: string;
  config: CpaProviderConfigInput;
}

/**
 * The base URL an `anthropic-messages` model must carry.
 *
 * Pi's Anthropic driver builds its endpoint as `<baseUrl>/v1/messages`, while
 * the provider base URL points at CLIProxyAPI's OpenAI-compatible root, which
 * conventionally ends in `/v1` (model discovery is `<baseUrl>/models`). Reusing
 * it verbatim would request `/v1/v1/messages` and get a 404, so Claude models
 * publish a model-level base URL with that one trailing `/v1` removed.
 */
export function anthropicBaseUrl(providerBaseUrl: string): string {
  return providerBaseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

export function normalizeProviderModels(
  models: ProviderModelConfigLike[],
  providerBaseUrl?: string,
): ProviderModelConfigLike[] {
  return models.map((model) => ({
    ...model,
    // CLIProxyAPI accepts OpenAI-compatible function tools for both Chat
    // Completions and Responses models, but Pi's strict all-properties-required
    // rewrite destroys optional argument semantics for multi-mode extension
    // tools. Keep each model's API selection and disable only that rewrite.
    compat: {
      ...model.compat,
      supportsStrictMode: false,
      // Claude models run on the Anthropic Messages API (see model-api.ts) and
      // use the same adaptive thinking path pi uses for anthropic/* models.
      // Per-turn effort and mid-conversation updates arrive in model.compat only
      // for models pi's native catalog marks as supporting them (see provider.ts);
      // the rest keep top-level effort and a collapsed system prompt.
      ...(isClaudeModel({ availableModelId: model.id })
        ? { forceAdaptiveThinking: true }
        : {}),
    },
    ...(providerBaseUrl && isClaudeModel({ availableModelId: model.id })
      ? { baseUrl: anthropicBaseUrl(providerBaseUrl) }
      : {}),
  })) as ProviderModelConfigLike[];
}

export function buildProviderRegistration(
  config: CpaProviderConfig,
  models: ProviderModelConfigLike[],
  refreshModels?: (context: RefreshModelsContext) => Promise<ProviderModelConfigLike[]>,
): ProviderRegistration {
  return {
    providerName: config.providerName,
    config: {
      name: `CLIProxyAPI (${config.providerName})`,
      baseUrl: config.baseUrl,
      api: "openai-completions",
      apiKey: config.authRequired ? "$CLIPROXYAPI_API_KEY" : "cliproxyapi-no-auth",
      authHeader: config.authRequired && config.authHeader,
      headers: Object.keys(config.headers).length > 0 ? config.headers : undefined,
      models: normalizeProviderModels(models, config.baseUrl),
      refreshModels,
    },
  };
}
