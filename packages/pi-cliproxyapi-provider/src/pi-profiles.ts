import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { loadBuiltinCatalogSource, type BuiltinCatalogSource } from "./builtin-seed.ts";
import { modelName, type ModelApiContext } from "./model-api.ts";

/**
 * The pi catalogs that describe the upstream CLIProxyAPI actually fronts for a
 * routed family: Claude models reach Anthropic, and GPT models served from a
 * Codex OAuth credential reach the Codex backend. models.dev describes the
 * public APIs instead (`openai/` is the API-key backend), which disagree on
 * details such as which effort levels exist.
 */
export type PiUpstream = "anthropic" | "openai-codex";

const PI_UPSTREAMS: readonly PiUpstream[] = ["anthropic", "openai-codex"];

/** What pi's native definition of a model says about its wire contract. */
export interface PiModelProfile {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  /** Pi's native context window; some Codex models (GPT-5.3 Codex Spark) are smaller than the family default. */
  contextWindow?: number;
  /** Pi's native per-turn effort support (Anthropic mid-conversation `output_config`). */
  supportsMidConvoEffort?: boolean;
  /** Pi's native mid-conversation `role: "system"` messages (Anthropic). */
  supportsMidConvoSystemMessages?: boolean;
  /** Pi's native `tool_addition`/`tool_removal` blocks (Anthropic); needs mid-conversation system messages too. */
  supportsMidConvoToolChanges?: boolean;
}

export interface PiModelProfiles {
  /** Pi's native profile for a model, by its CPA id or its metadata id; owner prefixes are ignored. */
  find(upstream: PiUpstream, context: ModelApiContext): PiModelProfile | undefined;
}

type ProfileIndex = ReadonlyMap<PiUpstream, ReadonlyMap<string, PiModelProfile>>;

function profilesFromIndex(index: ProfileIndex): PiModelProfiles {
  return {
    find(upstream, context) {
      const models = index.get(upstream);
      if (!models) return undefined;
      for (const id of [context.availableModelId, context.metadataModelId]) {
        if (id === undefined) continue;
        const profile = models.get(modelName(id));
        if (profile) return profile;
      }
      return undefined;
    },
  };
}

/** No native profiles: every model falls back to family rules and metadata. */
export const NO_PI_PROFILES: PiModelProfiles = profilesFromIndex(new Map());

function profileFromModel(model: Model<Api>): PiModelProfile {
  const compat = model.compat as {
    supportsMidConvoEffort?: boolean;
    supportsMidConvoSystemMessages?: boolean;
    supportsMidConvoToolChanges?: boolean;
  } | undefined;
  return {
    reasoning: model.reasoning,
    ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(compat?.supportsMidConvoEffort === true ? { supportsMidConvoEffort: true } : {}),
    ...(compat?.supportsMidConvoSystemMessages === true ? { supportsMidConvoSystemMessages: true } : {}),
    ...(compat?.supportsMidConvoToolChanges === true ? { supportsMidConvoToolChanges: true } : {}),
  };
}

/**
 * Pi's native model profiles for the upstreams CLIProxyAPI fronts, read from
 * the running pi's built-in catalog. It ships with pi, so it tracks new models
 * and capability changes without a release of this package. A catalog that
 * cannot be read degrades to {@link NO_PI_PROFILES} rather than failing load.
 */
export async function loadPiModelProfiles(source?: BuiltinCatalogSource): Promise<PiModelProfiles> {
  try {
    const catalogSource = source ?? await loadBuiltinCatalogSource();
    const available = new Set(catalogSource.getBuiltinProviders());
    const index = new Map<PiUpstream, Map<string, PiModelProfile>>();
    for (const upstream of PI_UPSTREAMS) {
      if (!available.has(upstream)) continue;
      const models = new Map<string, PiModelProfile>();
      for (const model of catalogSource.getBuiltinModels(upstream)) models.set(model.id, profileFromModel(model));
      index.set(upstream, models);
    }
    return profilesFromIndex(index);
  } catch (error) {
    console.warn(
      `[pi-cliproxyapi-provider] pi's built-in model catalog is unavailable, so native model profiles fall back to family rules: ${error instanceof Error ? error.message : String(error)}`,
    );
    return NO_PI_PROFILES;
  }
}
