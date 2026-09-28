import type { CpaModel } from "./cpa.ts";
import { findMetadataMatch, type MetadataMatchMethod } from "./matching.ts";
import { resolveModelWire, type ModelWire } from "./model-api.ts";
import { getModelCapabilityOverrides, thinkingLevelMapFromMetadata } from "./model-capabilities.ts";
import { NO_PI_PROFILES, type PiModelProfiles } from "./pi-profiles.ts";
import type { Gpt56ContextWindowMode } from "./settings.ts";
import type {
  InputModality,
  ModelsDevCatalog,
  ModelsDevMetadata,
  ProviderModelConfigLike,
  ProviderModelOverrides,
} from "./types.ts";

/**
 * Pi's conservative context window for the Codex Responses family (GPT-5.6
 * and GPT-6). models.dev advertises up to 1050000 for these models, but a
 * CLIProxyAPI route only allows that when its `max-context-length` override is
 * set, so the `gpt56ContextWindow` setting must opt in explicitly.
 */
export const GPT_5_6_CANONICAL_CONTEXT_WINDOW = 272000;

export const PI_MODEL_DEFAULTS = {
  reasoning: false,
  input: ["text"] as InputModality[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
};

export interface BuildProviderModelsStats {
  total: number;
  enriched: number;
  unmatched: number;
  matchMethods: Record<MetadataMatchMethod, number>;
  unmatchedModelIds: string[];
}

export interface BuildProviderModelsResult {
  models: ProviderModelConfigLike[];
  stats: BuildProviderModelsStats;
}

function inputFromMetadata(metadata: ModelsDevMetadata): InputModality[] {
  const input = metadata.modalities?.input ?? [];
  return input.includes("image") ? ["text", "image"] : ["text"];
}

function costFromMetadata(metadata: ModelsDevMetadata): ProviderModelConfigLike["cost"] {
  const tiers = metadata.cost?.tiers?.flatMap((tier) => {
    const threshold = tier.tier?.size;
    if (tier.tier?.type !== "context" || typeof threshold !== "number") return [];
    return [{
      inputTokensAbove: threshold,
      input: tier.input ?? 0,
      output: tier.output ?? 0,
      cacheRead: tier.cache_read ?? 0,
      cacheWrite: tier.cache_write ?? 0,
    }];
  });

  return {
    input: metadata.cost?.input ?? 0,
    output: metadata.cost?.output ?? 0,
    cacheRead: metadata.cost?.cache_read ?? 0,
    cacheWrite: metadata.cost?.cache_write ?? 0,
    ...(tiers && tiers.length > 0 ? { tiers } : {}),
  };
}

function contextWindowForModel(
  wire: ModelWire,
  metadataContextWindow: number | undefined,
  mode: Gpt56ContextWindowMode,
): number {
  if (!wire.codexResponses) return metadataContextWindow ?? PI_MODEL_DEFAULTS.contextWindow;
  // Pi's native window wins in canonical mode: it is smaller for some models
  // (Codex Spark is 128000), and overstating it makes pi compact too late.
  const canonical = wire.profile?.contextWindow ?? GPT_5_6_CANONICAL_CONTEXT_WINDOW;
  if (mode === "full") return metadataContextWindow ?? canonical;
  return canonical;
}

/**
 * Compat flags taken from pi's native profile. Only per-turn effort is carried:
 * it is the one native Anthropic capability verified end to end through
 * CLIProxyAPI (v8.0.3 forwards the mid-conversation-output-config beta, and
 * Opus 5/5.5 accept an effort switch across a tool loop). Mid-conversation
 * system messages and tool changes stay off: CLIProxyAPI's OAuth tool-name
 * aliasing misses `tool_addition`/`tool_removal` blocks (router-for-me/CLIProxyAPI#6174).
 *
 * Older CLIProxyAPI releases reject the per-turn directive
 * (`messages.N.output_config: Extra inputs are not permitted`), hence the
 * `perTurnEffort` setting. A model CPA reports under a non-Anthropic owner
 * (Antigravity, an OpenAI-compatible upstream) is translated away from the
 * Messages shape, where a system-role message cannot carry the directive.
 */
function compatFromWire(
  wire: ModelWire,
  cpaModel: CpaModel,
  perTurnEffort: boolean,
): ProviderModelConfigLike["compat"] | undefined {
  if (!perTurnEffort) return undefined;
  if (wire.api !== "anthropic-messages" || wire.profile?.supportsMidConvoEffort !== true) return undefined;
  if (cpaModel.owned_by !== undefined && cpaModel.owned_by !== "anthropic") return undefined;
  // Typed loosely: older pi-ai releases do not declare the flag and ignore it.
  return { supportsMidConvoEffort: true } as ProviderModelConfigLike["compat"];
}

function modelFromMetadata(
  cpaModel: CpaModel,
  metadata: ModelsDevMetadata,
  gpt56ContextWindow: Gpt56ContextWindowMode,
  profiles: PiModelProfiles,
  perTurnEffort: boolean,
): ProviderModelConfigLike {
  const capabilityContext = {
    availableModelId: cpaModel.id,
    metadataModelId: metadata.id,
  };
  const wire = resolveModelWire(capabilityContext, profiles);
  const capabilityOverrides = getModelCapabilityOverrides(capabilityContext);
  const reasoning = wire.profile?.reasoning
    ?? capabilityOverrides.reasoning
    ?? metadata.reasoning
    ?? PI_MODEL_DEFAULTS.reasoning;
  // Pi's native map for the upstream CPA fronts is authoritative. Family rules
  // cover models newer than the running pi; otherwise the metadata decides.
  const profileMap = wire.profile?.thinkingLevelMap;
  const thinkingLevelMap = (profileMap ? { ...profileMap } : undefined)
    ?? capabilityOverrides.thinkingLevelMap
    ?? (reasoning ? thinkingLevelMapFromMetadata(metadata) : undefined);
  const compat = compatFromWire(wire, cpaModel, perTurnEffort);

  return {
    id: cpaModel.id,
    name: metadata.name ?? cpaModel.id,
    reasoning,
    ...(wire.api ? { api: wire.api } : {}),
    ...(compat ? { compat } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: inputFromMetadata(metadata),
    cost: costFromMetadata(metadata),
    contextWindow: contextWindowForModel(wire, metadata.limit?.context, gpt56ContextWindow),
    maxTokens: metadata.limit?.output ?? PI_MODEL_DEFAULTS.maxTokens,
  };
}

function cloneModelDefaults(): typeof PI_MODEL_DEFAULTS {
  return {
    ...PI_MODEL_DEFAULTS,
    input: [...PI_MODEL_DEFAULTS.input],
    cost: { ...PI_MODEL_DEFAULTS.cost },
  };
}

function defaultModel(
  cpaModel: CpaModel,
  gpt56ContextWindow: Gpt56ContextWindowMode,
  profiles: PiModelProfiles,
  perTurnEffort: boolean,
): ProviderModelConfigLike {
  const modelContext = { availableModelId: cpaModel.id };
  const wire = resolveModelWire(modelContext, profiles);
  const capabilityOverrides = getModelCapabilityOverrides(modelContext);
  const compat = compatFromWire(wire, cpaModel, perTurnEffort);

  return {
    id: cpaModel.id,
    name: cpaModel.id,
    ...cloneModelDefaults(),
    ...capabilityOverrides,
    ...(wire.profile ? { reasoning: wire.profile.reasoning } : {}),
    ...(wire.profile?.thinkingLevelMap ? { thinkingLevelMap: { ...wire.profile.thinkingLevelMap } } : {}),
    ...(wire.api ? { api: wire.api } : {}),
    ...(compat ? { compat } : {}),
    contextWindow: contextWindowForModel(wire, undefined, gpt56ContextWindow),
  };
}

function emptyMatchMethods(): Record<MetadataMatchMethod, number> {
  return {
    alias: 0,
    exact: 0,
    "owner-prefix": 0,
    "owner-hint": 0,
    suffix: 0,
    "normalized-suffix": 0,
    "provider-fallback": 0,
  };
}

function applyModelOverride(
  model: ProviderModelConfigLike,
  overrides: ProviderModelOverrides,
): ProviderModelConfigLike {
  const override = overrides[model.id];
  if (!override) return model;
  return {
    ...model,
    ...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
    ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
    ...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
  };
}

export function buildUnavailableProviderModels(id = "login-required"): ProviderModelConfigLike[] {
  return [{ id, name: id, ...cloneModelDefaults() }];
}

export function buildProviderModels(
  cpaModels: CpaModel[],
  catalog: ModelsDevCatalog,
  aliases: Record<string, string>,
  gpt56ContextWindow: Gpt56ContextWindowMode = "canonical",
  overrides: ProviderModelOverrides = {},
  metadataFallbackProvider: string | null = "openrouter",
  profiles: PiModelProfiles = NO_PI_PROFILES,
  perTurnEffort = true,
): BuildProviderModelsResult {
  const matchMethods = emptyMatchMethods();
  const unmatchedModelIds: string[] = [];
  let enriched = 0;

  const models = cpaModels.map((cpaModel) => {
    const match = findMetadataMatch(cpaModel, catalog, aliases, metadataFallbackProvider);
    if (!match) {
      unmatchedModelIds.push(cpaModel.id);
      return applyModelOverride(defaultModel(cpaModel, gpt56ContextWindow, profiles, perTurnEffort), overrides);
    }

    enriched += 1;
    matchMethods[match.method] += 1;
    return applyModelOverride(
      modelFromMetadata(cpaModel, match.metadata, gpt56ContextWindow, profiles, perTurnEffort),
      overrides,
    );
  });

  return {
    models,
    stats: {
      total: cpaModels.length,
      enriched,
      unmatched: unmatchedModelIds.length,
      matchMethods,
      unmatchedModelIds,
    },
  };
}
