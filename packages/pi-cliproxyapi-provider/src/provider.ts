import type { CpaModel, CpaModelSpec } from "./cpa.ts";
import { findRouteMetadataMatch, type MetadataMatchMethod } from "./matching.ts";
import { resolveModelWire, type ModelWire } from "./model-api.ts";
import {
  getModelCapabilityOverrides,
  thinkingLevelMapFromEfforts,
  thinkingLevelMapFromMetadata,
} from "./model-capabilities.ts";
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

/** Which of pi's native Anthropic transcript features are published for Claude models. */
export interface ClaudeWireFeatures {
  /** Per-turn effort (`supportsMidConvoEffort`); needs CLIProxyAPI v8.0.3 or later. */
  perTurnEffort: boolean;
  /** Mid-conversation system messages and tool changes; needs CLIProxyAPI v8.0.4 or later. */
  midConversationUpdates: boolean;
}

export const DEFAULT_CLAUDE_WIRE_FEATURES: ClaudeWireFeatures = {
  perTurnEffort: true,
  midConversationUpdates: true,
};

export interface BuildProviderModelsStats {
  total: number;
  enriched: number;
  unmatched: number;
  matchMethods: Record<MetadataMatchMethod, number>;
  unmatchedModelIds: string[];
  /** Models whose limits came from CLIProxyAPI's own registry. */
  cpaSpecs: number;
}

export interface BuildProviderModelsResult {
  models: ProviderModelConfigLike[];
  stats: BuildProviderModelsStats;
}

function inputFromModalities(input: readonly string[]): InputModality[] {
  return input.includes("image") ? ["text", "image"] : ["text"];
}

function inputFromMetadata(metadata: ModelsDevMetadata): InputModality[] {
  return inputFromModalities(metadata.modalities?.input ?? []);
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

/**
 * The context window pi compacts against.
 *
 * CLIProxyAPI's registry wins when it publishes one: it is the proxy that
 * accepts or rejects the request, and a route can be narrower than the model
 * (`devin/` and Antigravity routes, an account-pinned prefix).
 *
 * Codex Responses models keep the conservative window unless
 * `gpt56ContextWindow` opts into the full one. The smallest of CPA's window
 * and pi's native window wins there, because overstating it makes pi compact
 * too late (pi knows Codex Spark at 128000). In full mode CPA's
 * `max_context_window` is the ceiling, with models.dev behind it.
 */
function contextWindowForModel(
  wire: ModelWire,
  metadataContextWindow: number | undefined,
  mode: Gpt56ContextWindowMode,
  spec: CpaModelSpec | undefined,
): number {
  if (!wire.codexResponses) return spec?.contextWindow ?? metadataContextWindow ?? PI_MODEL_DEFAULTS.contextWindow;
  const known = [spec?.contextWindow, wire.profile?.contextWindow].filter((value): value is number => value !== undefined);
  const canonical = known.length > 0 ? Math.min(...known) : GPT_5_6_CANONICAL_CONTEXT_WINDOW;
  if (mode === "full") return spec?.maxContextWindow ?? metadataContextWindow ?? canonical;
  return canonical;
}

/**
 * The effort list CLIProxyAPI copies from its `gpt-5.5` Codex template onto
 * every model its registry has no thinking data for (Claude 3.5 Haiku, Devin's
 * SWE-1.6). A real list that happens to be identical cannot be told apart from
 * that filler, so this exact list is ignored; such a model falls back to pi's
 * reasoning default, which `/cliproxyapi models` can override.
 */
const CPA_TEMPLATE_FILLER_EFFORTS = ["low", "medium", "high", "xhigh"];

/** Thinking levels from CLIProxyAPI's effort list, consulted only when no better source describes the model. */
function specThinkingLevelMap(spec: CpaModelSpec | undefined): ProviderModelConfigLike["thinkingLevelMap"] {
  const levels = spec?.reasoningLevels;
  if (!levels) return undefined;
  if (levels.length === CPA_TEMPLATE_FILLER_EFFORTS.length && levels.every((level, index) => level === CPA_TEMPLATE_FILLER_EFFORTS[index])) {
    return undefined;
  }
  return thinkingLevelMapFromEfforts(levels);
}

/** models.dev lists non-chat models (image generation) with a 0 limit, which means "not applicable". */
function positiveLimit(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

/**
 * Anthropic transcript flags taken from pi's native profile, each behind its
 * own setting because each needs a newer CLIProxyAPI:
 *
 * - Per-turn effort (`supportsMidConvoEffort`) needs v8.0.3, which forwards the
 *   mid-conversation-output-config beta. Older releases reject the directive
 *   (`messages.N.output_config: Extra inputs are not permitted`).
 * - Mid-conversation system messages and tool changes need v8.0.4, whose OAuth
 *   tool-name aliasing also rewrites `tool_addition`/`tool_removal` blocks
 *   (router-for-me/CLIProxyAPI#6174). Older releases fail the first request
 *   after a tool change with "references unknown tool".
 *
 * A model CPA reports under a non-Anthropic owner (Antigravity, an
 * OpenAI-compatible upstream) is translated away from the Messages shape,
 * where a system-role message cannot survive, so it gets none of them.
 */
function compatFromWire(
  wire: ModelWire,
  cpaModel: CpaModel,
  features: ClaudeWireFeatures,
): ProviderModelConfigLike["compat"] | undefined {
  if (wire.api !== "anthropic-messages" || !wire.profile) return undefined;
  if (cpaModel.owned_by !== undefined && cpaModel.owned_by !== "anthropic") return undefined;
  const profile = wire.profile;
  const compat = {
    ...(features.perTurnEffort && profile.supportsMidConvoEffort ? { supportsMidConvoEffort: true } : {}),
    ...(features.midConversationUpdates && profile.supportsMidConvoSystemMessages
      ? {
        supportsMidConvoSystemMessages: true,
        ...(profile.supportsMidConvoToolChanges ? { supportsMidConvoToolChanges: true } : {}),
      }
      : {}),
  };
  // Typed loosely: older pi-ai releases do not declare these flags and ignore them.
  return Object.keys(compat).length > 0 ? compat as ProviderModelConfigLike["compat"] : undefined;
}

function modelFromMetadata(
  cpaModel: CpaModel,
  metadata: ModelsDevMetadata,
  gpt56ContextWindow: Gpt56ContextWindowMode,
  profiles: PiModelProfiles,
  features: ClaudeWireFeatures,
): ProviderModelConfigLike {
  const capabilityContext = {
    availableModelId: cpaModel.id,
    metadataModelId: metadata.id,
  };
  const wire = resolveModelWire(capabilityContext, profiles);
  const capabilityOverrides = getModelCapabilityOverrides(capabilityContext);
  const spec = cpaModel.spec;
  const reasoning = wire.profile?.reasoning
    ?? capabilityOverrides.reasoning
    ?? metadata.reasoning
    ?? (specThinkingLevelMap(spec) ? true : undefined)
    ?? PI_MODEL_DEFAULTS.reasoning;
  // Pi's native map for the upstream CPA fronts is authoritative. Family rules
  // cover models newer than the running pi; otherwise the metadata decides,
  // and CPA's own effort list only fills a gap.
  const profileMap = wire.profile?.thinkingLevelMap;
  const thinkingLevelMap = (profileMap ? { ...profileMap } : undefined)
    ?? capabilityOverrides.thinkingLevelMap
    ?? (reasoning ? thinkingLevelMapFromMetadata(metadata) ?? specThinkingLevelMap(spec) : undefined);
  const compat = compatFromWire(wire, cpaModel, features);

  return {
    id: cpaModel.id,
    name: spec?.displayName ?? metadata.name ?? cpaModel.id,
    reasoning,
    ...(wire.api ? { api: wire.api } : {}),
    ...(compat ? { compat } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: metadata.modalities?.input ? inputFromMetadata(metadata) : inputFromModalities(spec?.inputModalities ?? []),
    cost: costFromMetadata(metadata),
    contextWindow: contextWindowForModel(wire, positiveLimit(metadata.limit?.context), gpt56ContextWindow, spec),
    maxTokens: spec?.maxTokens ?? positiveLimit(metadata.limit?.output) ?? PI_MODEL_DEFAULTS.maxTokens,
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
  features: ClaudeWireFeatures,
): ProviderModelConfigLike {
  const modelContext = { availableModelId: cpaModel.id };
  const wire = resolveModelWire(modelContext, profiles);
  const capabilityOverrides = getModelCapabilityOverrides(modelContext);
  const compat = compatFromWire(wire, cpaModel, features);
  const spec = cpaModel.spec;
  // With no catalog entry, CPA's effort list is the only description left;
  // pi's native profile and the family rules still win over it.
  const specMap = wire.profile || capabilityOverrides.thinkingLevelMap ? undefined : specThinkingLevelMap(spec);

  return {
    id: cpaModel.id,
    name: spec?.displayName ?? cpaModel.id,
    ...cloneModelDefaults(),
    ...(specMap ? { reasoning: true, thinkingLevelMap: specMap } : {}),
    ...capabilityOverrides,
    ...(wire.profile ? { reasoning: wire.profile.reasoning } : {}),
    ...(wire.profile?.thinkingLevelMap ? { thinkingLevelMap: { ...wire.profile.thinkingLevelMap } } : {}),
    ...(wire.api ? { api: wire.api } : {}),
    ...(compat ? { compat } : {}),
    ...(spec?.inputModalities ? { input: inputFromModalities(spec.inputModalities) } : {}),
    contextWindow: contextWindowForModel(wire, undefined, gpt56ContextWindow, spec),
    ...(spec?.maxTokens ? { maxTokens: spec.maxTokens } : {}),
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
    "route-base": 0,
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
  features: ClaudeWireFeatures = DEFAULT_CLAUDE_WIRE_FEATURES,
): BuildProviderModelsResult {
  const matchMethods = emptyMatchMethods();
  const unmatchedModelIds: string[] = [];
  let enriched = 0;

  const models = cpaModels.map((cpaModel) => {
    const match = findRouteMetadataMatch(cpaModel, catalog, aliases, metadataFallbackProvider);
    if (!match) {
      unmatchedModelIds.push(cpaModel.id);
      return applyModelOverride(defaultModel(cpaModel, gpt56ContextWindow, profiles, features), overrides);
    }

    enriched += 1;
    matchMethods[match.method] += 1;
    return applyModelOverride(
      modelFromMetadata(cpaModel, match.metadata, gpt56ContextWindow, profiles, features),
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
      cpaSpecs: cpaModels.filter((model) => model.spec?.contextWindow !== undefined || model.spec?.maxTokens !== undefined).length,
    },
  };
}
