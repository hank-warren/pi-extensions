import { withNetworkTimeout } from "./network.ts";

/**
 * What CLIProxyAPI's own model registry says about one model: the limits and
 * effort levels CPA itself enforces for that route. CPA is the source of truth
 * for these, since it is what accepts or rejects the request — a `devin/`
 * route caps output at a different size from the bare Anthropic route.
 */
export interface CpaModelSpec {
  displayName?: string;
  contextWindow?: number;
  /** The largest window the route can be opted into (Codex's `max_context_window`). */
  maxContextWindow?: number;
  maxTokens?: number;
  /** Effort names CPA lists for the model, lowercase, in CPA's order. */
  reasoningLevels?: string[];
  inputModalities?: string[];
}

export interface CpaModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  /** CPA's registry entry, when the instance publishes one (see {@link fetchCpaModelSpecs}). */
  spec?: CpaModelSpec;
}

export interface CpaModelsResponse {
  object?: string;
  data?: unknown[];
}

export function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/**
 * CLIProxyAPI's Codex-client model catalog. Its OpenAI-shaped `/v1/models`
 * strips every entry to `id`, `object`, `created` and `owned_by`; a
 * `client_version` query instead returns the catalog CPA builds for the Codex
 * CLI, which carries the registry's limits and effort levels. An empty value
 * keeps CPA's modern level set (`max` is withheld from Codex clients older
 * than 0.144). Servers other than CPA ignore the query and answer with the
 * plain list, which {@link parseCpaModelSpecs} reads as "no specs".
 */
export function modelSpecsEndpoint(baseUrl: string): string {
  return `${modelsEndpoint(baseUrl)}?client_version=`;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  return strings.length === value.length ? strings : undefined;
}

function parseSpec(value: unknown): CpaModelSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const spec: CpaModelSpec = {
    ...(typeof record.displayName === "string" && record.displayName.trim() !== "" ? { displayName: record.displayName } : {}),
    ...(positiveInteger(record.contextWindow) ? { contextWindow: record.contextWindow as number } : {}),
    ...(positiveInteger(record.maxContextWindow) ? { maxContextWindow: record.maxContextWindow as number } : {}),
    ...(positiveInteger(record.maxTokens) ? { maxTokens: record.maxTokens as number } : {}),
    ...(stringList(record.reasoningLevels) ? { reasoningLevels: stringList(record.reasoningLevels) } : {}),
    ...(stringList(record.inputModalities) ? { inputModalities: stringList(record.inputModalities) } : {}),
  };
  return Object.keys(spec).length > 0 ? spec : undefined;
}

function parseCpaModelEntries(entries: unknown[]): CpaModel[] {
  const models = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim() === "") return [];
    const spec = parseSpec(record.spec);
    return [{
      id: record.id,
      object: typeof record.object === "string" ? record.object : undefined,
      owned_by: typeof record.owned_by === "string" ? record.owned_by : undefined,
      created: typeof record.created === "number" ? record.created : undefined,
      ...(spec ? { spec } : {}),
    }];
  });

  const unique = new Map<string, CpaModel>();
  for (const model of models) unique.set(model.id, model);
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function parseCpaModelsCache(payload: unknown): CpaModel[] {
  if (!Array.isArray(payload)) throw new Error("CPA model snapshot must be an array");
  const models = parseCpaModelEntries(payload);
  if (models.length !== payload.length) throw new Error("CPA model snapshot contains invalid entries");
  return models;
}

export function parseCpaModelsResponse(payload: unknown): CpaModel[] {
  const response = payload as CpaModelsResponse;
  if (!response || typeof response !== "object" || !Array.isArray(response.data)) {
    throw new Error("CPA /v1/models response must contain a data array");
  }
  return parseCpaModelEntries(response.data);
}

/**
 * Read CPA's Codex-client catalog into per-model specs, keyed by CPA model id.
 *
 * CPA builds each entry by cloning a Codex template and overlaying what its
 * registry knows, so fields the registry lacks keep template filler: an image
 * model reports the template's 272000-token window and effort levels. An entry
 * is kept only when it carries `max_tokens`, which CPA copies from the registry
 * alone and never from a template, so a kept entry's limits are CPA's own.
 * Even then its effort levels can be filler when the registry has no thinking
 * data, which is why the provider consults them last.
 */
export function parseCpaModelSpecs(payload: unknown): Map<string, CpaModelSpec> {
  const specs = new Map<string, CpaModelSpec>();
  const models = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return specs;

  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.slug === "string" ? record.slug.trim() : "";
    const maxTokens = positiveInteger(record.max_tokens);
    if (!id || !maxTokens) continue;

    const levels = Array.isArray(record.supported_reasoning_levels)
      ? record.supported_reasoning_levels.flatMap((level) => {
        const effort = (level as { effort?: unknown } | null)?.effort;
        return typeof effort === "string" && effort.trim() !== "" ? [effort.trim().toLowerCase()] : [];
      })
      : [];
    const input = stringList(record.input_modalities);
    const spec = parseSpec({
      displayName: record.display_name,
      contextWindow: record.context_window,
      maxContextWindow: record.max_context_window,
      maxTokens,
      ...(levels.length > 0 ? { reasoningLevels: levels } : {}),
      ...(input && input.length > 0 ? { inputModalities: input } : {}),
    });
    if (spec) specs.set(id, spec);
  }
  return specs;
}

/** Attach specs to discovered models; a model CPA published no spec for keeps none. */
export function withCpaModelSpecs(models: CpaModel[], specs: ReadonlyMap<string, CpaModelSpec>): CpaModel[] {
  return models.map(({ spec: _previous, ...model }) => {
    const spec = specs.get(model.id);
    return spec ? { ...model, spec } : model;
  });
}

export async function fetchCpaModels(
  baseUrl: string,
  headers: Record<string, string> = {},
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<CpaModel[]> {
  return withNetworkTimeout(async (reqSignal) => {
    const response = await fetch(modelsEndpoint(baseUrl), {
      headers: { Accept: "application/json", ...headers },
      signal: reqSignal,
    });
    if (!response.ok) {
      throw new Error(`CPA model discovery failed: HTTP ${response.status} ${response.statusText}`);
    }
    return parseCpaModelsResponse(await response.json());
  }, timeoutMs, "CPA model discovery", signal);
}

export async function fetchCpaModelSpecs(
  baseUrl: string,
  headers: Record<string, string> = {},
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Map<string, CpaModelSpec>> {
  return withNetworkTimeout(async (reqSignal) => {
    const response = await fetch(modelSpecsEndpoint(baseUrl), {
      headers: { Accept: "application/json", ...headers },
      signal: reqSignal,
    });
    if (!response.ok) {
      throw new Error(`CPA model spec discovery failed: HTTP ${response.status} ${response.statusText}`);
    }
    return parseCpaModelSpecs(await response.json());
  }, timeoutMs, "CPA model spec discovery", signal);
}
