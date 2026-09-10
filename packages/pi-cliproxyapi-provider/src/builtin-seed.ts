import type { Api, Model } from "@earendil-works/pi-ai";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
// Type-only, so it is erased: the runtime import below is the deliberate one.
import type { BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import type { ModelsDevCatalog, ModelsDevMetadata } from "./types.ts";

/**
 * models.dev providers worth seeding from pi's own catalog. These are the
 * upstreams CLIProxyAPI actually fronts; every other models.dev provider is
 * reachable once the first live fetch lands, and seeding all of them would
 * copy hundreds of entries nothing ever consults.
 */
export const SEED_PROVIDERS = ["anthropic", "openai", "openai-codex", "xai", "google", "openrouter"] as const;

/**
 * The slice of `@earendil-works/pi-ai/providers/all` this module reads.
 * Injectable so tests can drive the aliasing rules from a small fixture
 * instead of whichever catalog the installed pi-ai happens to ship.
 */
export interface BuiltinCatalogSource {
  getBuiltinProviders(): string[];
  getBuiltinModels(provider: string): Model<Api>[];
  getBuiltinModelDataGeneratedAt(): number | undefined;
}

export interface BuiltinSeed {
  catalog: ModelsDevCatalog;
  /** When pi generated its catalog from models.dev; undefined when the catalog is unavailable. */
  generatedAt?: number;
}

/**
 * Pi's built-in model catalog, loaded lazily.
 *
 * The subpath is only exported by recent pi-ai versions and pi aliases it to
 * the bundled copy at runtime, so it is imported dynamically: a missing or
 * renamed subpath then degrades to an empty seed instead of failing the whole
 * extension load the way a static import would.
 */
async function piBuiltinCatalog(): Promise<BuiltinCatalogSource> {
  const all = await import("@earendil-works/pi-ai/providers/all");
  return {
    getBuiltinProviders: () => all.getBuiltinProviders() as string[],
    getBuiltinModels: (provider) => all.getBuiltinModels(provider as BuiltinProvider) as Model<Api>[],
    getBuiltinModelDataGeneratedAt: () => all.getBuiltinModelDataGeneratedAt(),
  };
}

/** models.dev's context-pricing tier shape, rebuilt from pi's `inputTokensAbove` tiers. */
function tiersFromModel(model: Model<Api>): NonNullable<NonNullable<ModelsDevMetadata["cost"]>["tiers"]> {
  return (model.cost.tiers ?? []).map((tier) => ({
    input: tier.input,
    output: tier.output,
    cache_read: tier.cacheRead,
    cache_write: tier.cacheWrite,
    tier: { type: "context", size: tier.inputTokensAbove },
  }));
}

function metadataFromModel(provider: string, model: Model<Api>): ModelsDevMetadata {
  const tiers = tiersFromModel(model);
  return {
    id: `${provider}/${model.id}`,
    sourceProvider: provider,
    name: model.name,
    reasoning: model.reasoning,
    // Pi publishes a finished map per model, which is the whole reason this
    // seed beats a models.dev snapshot on a cold start: models.dev only
    // describes the accepted effort names, and lags on new families.
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    modalities: { input: [...model.input] },
    limit: { context: model.contextWindow, output: model.maxTokens },
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache_read: model.cost.cacheRead,
      cache_write: model.cost.cacheWrite,
      ...(tiers.length > 0 ? { tiers } : {}),
    },
  };
}

/**
 * Pi's built-in model catalog, shaped like the models.dev catalog the rest of
 * this package consumes, for use as the first-run metadata seed.
 *
 * Pi regenerates it from models.dev on every release, so it can never be older
 * than the pi you are running, and it costs no file and no network. A failure
 * to read it is not fatal: the seed is then empty and every model renders with
 * pi's bare defaults until the first live models.dev fetch, exactly as it would
 * with no seed at all.
 */
export async function builtinSeedCatalog(source?: BuiltinCatalogSource): Promise<BuiltinSeed> {
  try {
    const catalogSource = source ?? await piBuiltinCatalog();
    const available = new Set(catalogSource.getBuiltinProviders());
    const catalog: ModelsDevCatalog = {};

    for (const provider of SEED_PROVIDERS) {
      if (!available.has(provider)) continue;
      for (const model of catalogSource.getBuiltinModels(provider)) {
        catalog[`${provider}/${model.id}`] = metadataFromModel(provider, model);
      }
    }

    // CLIProxyAPI reports Codex models with `owned_by: openai`, which matches
    // metadata keyed `openai/<id>` only. Codex ids that OpenAI also publishes
    // directly keep the `openai/` entry they already have; the rest are
    // registered as if OpenAI published them, so they match too. The alias
    // shares its name with the `openai-codex/` entry, so a CPA row without a
    // canonical `owned_by` sees two suffix candidates for that id and falls
    // through to the provider fallback rather than guessing between them.
    if (available.has("openai-codex")) {
      for (const model of catalogSource.getBuiltinModels("openai-codex")) {
        const openaiKey = `openai/${model.id}`;
        if (catalog[openaiKey]) continue;
        catalog[openaiKey] = metadataFromModel("openai", model);
      }
    }

    return { catalog, generatedAt: catalogSource.getBuiltinModelDataGeneratedAt() };
  } catch (error) {
    console.warn(
      `[pi-cliproxyapi-provider] pi ${PI_VERSION}'s built-in model catalog (@earendil-works/pi-ai/providers/all) is unavailable, starting with no metadata seed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { catalog: {}, generatedAt: undefined };
  }
}
