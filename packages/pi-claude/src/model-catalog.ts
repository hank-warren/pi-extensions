import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { DiscoveredClaudeModel } from "./claude-cli.ts";

export const PROVIDER_ID = "claude-sub";
export const PROVIDER_NAME = "Claude (subscription)";
export const API_ID = "claude-sub-stream-json";
export const BASE_URL = "process://claude-code";

export type ClaudeSubModel = Model<typeof API_ID>;

const BUILTIN: Record<string, Model<"anthropic-messages">> = Object.fromEntries(
  getBuiltinModels("anthropic").map((model) => [model.id, model]),
);

/**
 * Snapshot of Claude Code 2.1.316's catalog for a subscription login, with the
 * context window it applies to each model. Live discovery replaces it.
 */
export const FALLBACK_DISCOVERY: DiscoveredClaudeModel[] = [
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsThinkingOff: false, contextWindow: 1_000_000 },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsThinkingOff: false, contextWindow: 1_000_000 },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsThinkingOff: false, contextWindow: 1_000_000 },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsThinkingOff: false, contextWindow: 1_000_000 },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "", supportsThinkingOff: true, contextWindow: 200_000 },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"], supportsAdaptiveThinking: true, supportsThinkingOff: true, contextWindow: 200_000 },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"], supportsAdaptiveThinking: true, supportsThinkingOff: true, contextWindow: 200_000 },
];

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Per-model facts the stream layer needs at request time. */
export interface ModelTraits {
  route: string;
  effortLevels: string[];
  supportsThinkingOff: boolean;
}

const TRAITS = new Map<string, ModelTraits>();

function thinkingLevelMap(info: DiscoveredClaudeModel): ThinkingLevelMap {
  const map: ThinkingLevelMap = { minimal: null };
  if (!info.supportsThinkingOff) map.off = null;
  if (info.supportsEffort && info.supportedEffortLevels?.length) {
    for (const level of EFFORT_LEVELS) map[level] = info.supportedEffortLevels.includes(level) ? level : null;
  } else {
    // Thinking on/off only: expose a single "high" level for "on".
    Object.assign(map, { low: null, medium: null, high: "high", xhigh: null, max: null });
  }
  return map;
}

function withoutContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/u, "");
}

/** Convert a Claude Code catalog row into a Pi model, using Pi's built-in metadata where it exists. */
export function modelFromDiscovery(info: DiscoveredClaudeModel): ClaudeSubModel {
  const id = info.resolvedModel || info.value;
  const builtin = BUILTIN[withoutContextSuffix(id)];
  TRAITS.set(id, {
    route: id,
    effortLevels: info.supportsEffort ? (info.supportedEffortLevels ?? []) : [],
    supportsThinkingOff: info.supportsThinkingOff === true,
  });
  const contextWindow = info.contextWindow ?? (/\[1m\]$/u.test(id) ? 1_000_000 : 200_000);
  const maxTokens = Math.min(builtin?.maxTokens ?? (contextWindow >= 1_000_000 ? 128_000 : 64_000), contextWindow);
  return {
    id,
    name: builtin?.name ?? `Claude ${info.displayName}`,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: info.supportsEffort === true || info.supportsAdaptiveThinking === true || info.supportsThinkingOff === true,
    thinkingLevelMap: thinkingLevelMap(info),
    input: builtin?.input ?? ["text", "image"],
    cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

export function modelTraits(id: string): ModelTraits {
  return TRAITS.get(id) ?? { route: id, effortLevels: [...EFFORT_LEVELS], supportsThinkingOff: false };
}

export const FALLBACK_MODELS: ClaudeSubModel[] = FALLBACK_DISCOVERY.map(modelFromDiscovery);
