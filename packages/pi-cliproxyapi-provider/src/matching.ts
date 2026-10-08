import type { CpaModel } from "./cpa.ts";
import { modelName } from "./model-api.ts";
import type { ModelsDevCatalog, ModelsDevMetadata } from "./types.ts";

const CANONICAL_OWNER_PREFIXES: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  mistral: "mistral",
  xai: "xai",
  zhipuai: "zhipuai",
  // CLIProxyAPI's spelling of the two labs models.dev keys with an `ai` suffix.
  zhipu: "zhipuai",
  alibaba: "alibaba",
  moonshotai: "moonshotai",
  moonshot: "moonshotai",
  minimax: "minimax",
  nvidia: "nvidia",
  cohere: "cohere",
};

export type MetadataMatchMethod =
  | "alias"
  | "exact"
  | "owner-prefix"
  | "owner-hint"
  | "suffix"
  | "normalized-suffix"
  | "provider-fallback"
  | "route-base";

export interface MetadataMatch {
  metadataId: string;
  metadata: ModelsDevMetadata;
  method: MetadataMatchMethod;
}

export function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function metadataModelName(metadataId: string, metadata: ModelsDevMetadata): string {
  return metadata.id.split("/").at(-1) ?? metadataId.split("/").at(-1) ?? metadataId;
}

function oneMatch(candidates: string[]): string | undefined {
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

function identifierTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function containsContiguousTokens(container: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || sequence.length > container.length) return false;
  return container.some((_, start) =>
    start + sequence.length <= container.length &&
    sequence.every((token, offset) => container[start + offset] === token)
  );
}

/**
 * Candidate lookups for one catalog, keyed by the three properties
 * `findMetadataMatch` filters on. Built once per catalog object and cached
 * on it: a live models.dev snapshot holds ~7 500 entries, and scanning them
 * three times per CPA model (with a regex normalisation each) cost ~750 ms
 * per `buildProviderModels` — paid at every startup and every `/model` open.
 * Insertion order is preserved so candidate lists match the scan they replace.
 */
interface CatalogIndex {
  byMetadataId: Map<string, string[]>;
  bySuffix: Map<string, string[]>;
  byNormalizedSuffix: Map<string, string[]>;
}

const catalogIndexes = new WeakMap<ModelsDevCatalog, CatalogIndex>();

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function catalogIndex(catalog: ModelsDevCatalog): CatalogIndex {
  const cached = catalogIndexes.get(catalog);
  if (cached) return cached;
  const index: CatalogIndex = { byMetadataId: new Map(), bySuffix: new Map(), byNormalizedSuffix: new Map() };
  for (const key of Object.keys(catalog)) {
    const metadata = catalog[key];
    if (!metadata) continue;
    push(index.byMetadataId, metadata.id, key);
    const name = metadataModelName(key, metadata);
    push(index.bySuffix, name, key);
    push(index.byNormalizedSuffix, normalizeModelName(name), key);
  }
  catalogIndexes.set(catalog, index);
  return index;
}

function sourceProvider(metadataId: string, metadata: ModelsDevMetadata): string {
  // sourceProvider is retained by current catalog snapshots. The prefix fallback
  // keeps older bundled/cache snapshots useful until they are refreshed.
  return metadata.sourceProvider ?? metadataId.split("/")[0] ?? metadataId;
}

function ownerHintMatch(
  owner: string | undefined,
  candidates: string[],
  catalog: ModelsDevCatalog,
): string | undefined {
  if (!owner) return undefined;
  const ownerTokens = identifierTokens(owner);
  const matches = candidates.flatMap((metadataId) => {
    const metadata = catalog[metadataId];
    if (!metadata) return [];
    const provider = sourceProvider(metadataId, metadata);
    const providerTokens = identifierTokens(provider);
    if (!containsContiguousTokens(ownerTokens, providerTokens)) return [];
    return [{ metadataId, tokenCount: providerTokens.length, characterCount: provider.length }];
  });
  if (matches.length === 0) return undefined;

  const bestTokenCount = Math.max(...matches.map((match) => match.tokenCount));
  const mostTokens = matches.filter((match) => match.tokenCount === bestTokenCount);
  const bestCharacterCount = Math.max(...mostTokens.map((match) => match.characterCount));
  return oneMatch(
    mostTokens
      .filter((match) => match.characterCount === bestCharacterCount)
      .map((match) => match.metadataId),
  );
}

export function findMetadataMatch(
  cpaModel: Pick<CpaModel, "id" | "owned_by">,
  catalog: ModelsDevCatalog,
  aliases: Record<string, string>,
  fallbackProvider?: string | null,
): MetadataMatch | undefined {
  const alias = aliases[cpaModel.id];
  if (alias && catalog[alias]) {
    return { metadataId: alias, metadata: catalog[alias], method: "alias" };
  }

  if (catalog[cpaModel.id]) {
    return { metadataId: cpaModel.id, metadata: catalog[cpaModel.id], method: "exact" };
  }

  const index = catalogIndex(catalog);
  const exactMetadataKey = oneMatch(index.byMetadataId.get(cpaModel.id) ?? []);
  if (exactMetadataKey) {
    return { metadataId: exactMetadataKey, metadata: catalog[exactMetadataKey], method: "exact" };
  }

  const suffixCandidates = index.bySuffix.get(cpaModel.id) ?? [];
  const normalizedSuffixCandidates = index.byNormalizedSuffix.get(normalizeModelName(cpaModel.id)) ?? [];
  const owner = cpaModel.owned_by?.trim().toLowerCase();
  const canonicalOwner = owner ? CANONICAL_OWNER_PREFIXES[owner] : undefined;
  if (canonicalOwner) {
    const ownerKey = `${canonicalOwner}/${cpaModel.id}`;
    if (catalog[ownerKey]) {
      return { metadataId: ownerKey, metadata: catalog[ownerKey], method: "owner-prefix" };
    }
    // Same owner, punctuation-insensitive: Devin spells versions with dashes
    // (`gpt-5-6-sol`, `glm-5-3`) where models.dev uses dots.
    const ownerNormalizedKey = oneMatch(normalizedSuffixCandidates.filter((metadataId) => {
      const metadata = catalog[metadataId];
      return metadata && sourceProvider(metadataId, metadata).toLowerCase() === canonicalOwner;
    }));
    if (ownerNormalizedKey) {
      return { metadataId: ownerNormalizedKey, metadata: catalog[ownerNormalizedKey], method: "owner-prefix" };
    }
  }

  const hintedKey = ownerHintMatch(owner, normalizedSuffixCandidates, catalog);
  if (hintedKey) {
    return { metadataId: hintedKey, metadata: catalog[hintedKey], method: "owner-hint" };
  }

  const suffixKey = oneMatch(suffixCandidates);
  if (suffixKey) {
    return { metadataId: suffixKey, metadata: catalog[suffixKey], method: "suffix" };
  }

  const normalizedSuffixKey = oneMatch(normalizedSuffixCandidates);
  if (normalizedSuffixKey) {
    return { metadataId: normalizedSuffixKey, metadata: catalog[normalizedSuffixKey], method: "normalized-suffix" };
  }

  if (fallbackProvider) {
    const normalizedFallbackProvider = fallbackProvider.trim().toLowerCase();
    const fallbackKey = oneMatch(normalizedSuffixCandidates.filter((metadataId) => {
      const metadata = catalog[metadataId];
      return metadata && sourceProvider(metadataId, metadata).toLowerCase() === normalizedFallbackProvider;
    }));
    if (fallbackKey) {
      return { metadataId: fallbackKey, metadata: catalog[fallbackKey], method: "provider-fallback" };
    }
  }

  return undefined;
}

/**
 * {@link findMetadataMatch}, falling back to the model's base id when its CPA
 * id carries a routing prefix.
 *
 * CLIProxyAPI namespaces a model by the route serving it: a configured prefix
 * that pins one OAuth account (`team/gpt-6-sol`, `plus/gpt-6-sol`) or a
 * provider namespace (`devin/claude-opus-5-5`). models.dev lists only the
 * model, so the prefixed id matches nothing and would render with pi's bare
 * defaults. The prefixed id is tried first, so an alias or a catalog entry
 * written for it still wins; only the metadata lookup drops the prefix, and the
 * registered model keeps its full id so requests still reach that route.
 */
export function findRouteMetadataMatch(
  cpaModel: Pick<CpaModel, "id" | "owned_by">,
  catalog: ModelsDevCatalog,
  aliases: Record<string, string>,
  fallbackProvider?: string | null,
): MetadataMatch | undefined {
  const direct = findMetadataMatch(cpaModel, catalog, aliases, fallbackProvider);
  if (direct) return direct;
  const base = modelName(cpaModel.id);
  if (base === cpaModel.id || base === "") return undefined;
  const routed = findMetadataMatch({ ...cpaModel, id: base }, catalog, aliases, fallbackProvider);
  return routed ? { ...routed, method: "route-base" } : undefined;
}
