import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model as PiModel } from "@earendil-works/pi-ai";
import { z } from "zod";

import type { Model as CodexModel } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Model.js";
import type { ModelListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ModelListParams.js";
import type { ModelListResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ModelListResponse.js";
import type { ReasoningEffortOption } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ReasoningEffortOption.js";
import type { ModelSelection } from "../config/app-server-config.ts";
import type { PiModelRuntime } from "./pi-model-runtime.ts";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const CURSOR_PREFIX = "pi-models:";
const cursorSchema = z
  .string()
  .regex(/^pi-models:\d+$/u)
  .transform((cursor) =>
    Math.trunc(Number(cursor.slice(CURSOR_PREFIX.length)))
  );

const modelKey = (model: PiModel<string>): string =>
  `${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id)}`;

const decodeModelKey = (
  key: string
): { readonly modelId: string; readonly provider: string } | undefined => {
  const separator = key.indexOf("/");
  if (separator < 1 || separator === key.length - 1) {
    return undefined;
  }
  try {
    return {
      modelId: decodeURIComponent(key.slice(separator + 1)),
      provider: decodeURIComponent(key.slice(0, separator)),
    };
  } catch {
    return undefined;
  }
};

/**
 * Pi's `Model` type declares `contextWindow` as a number, but a provider a Pi
 * extension registers with a bare `models: [{ id }]` produces models without
 * one. `model/list` returns the whole catalogue in a single response, so one
 * under-specified model used to fail the request and leave a client with no
 * models at all rather than with one vague description.
 */
const describeContextWindow = (model: PiModel<string>): string =>
  typeof model.contextWindow === "number"
    ? `${model.contextWindow.toLocaleString()} token context`
    : "context window unknown";

const reasoningDescription = (effort: string): string =>
  effort === "off" ? "Disable model reasoning" : `Use ${effort} reasoning`;

const reasoningOptions = (
  model: PiModel<string>
): readonly ReasoningEffortOption[] =>
  getSupportedThinkingLevels(model).map((reasoningEffort) => ({
    description: reasoningDescription(reasoningEffort),
    reasoningEffort,
  }));

const defaultReasoningEffort = (
  options: readonly ReasoningEffortOption[]
): string => {
  const medium = options.find(
    ({ reasoningEffort }) => reasoningEffort === "medium"
  );
  if (medium) {
    return medium.reasoningEffort;
  }
  const disabled = options.find(
    ({ reasoningEffort }) => reasoningEffort === "off"
  );
  return disabled?.reasoningEffort ?? options.at(0)?.reasoningEffort ?? "off";
};

const toCodexModel = (
  model: PiModel<string>,
  providerDisplayName: string,
  defaultKey?: string
): CodexModel => {
  const key = modelKey(model);
  const efforts = reasoningOptions(model);
  return {
    additionalSpeedTiers: [],
    availabilityNux: null,
    defaultReasoningEffort: defaultReasoningEffort(efforts),
    defaultServiceTier: null,
    description: `${model.provider} · ${model.api} · ${describeContextWindow(model)}`,
    displayName: `[${providerDisplayName}] ${model.name ?? model.id}`,
    hidden: false,
    id: key,
    inputModalities: model.input ?? ["text"],
    isDefault: key === defaultKey,
    model: key,
    modelSpecialty: null,
    multiAgentVersion: null,
    serviceTiers: [],
    supportedReasoningEfforts: [...efforts],
    supportsPersonality: false,
    upgrade: null,
    upgradeInfo: null,
  };
};

/**
 * The form a pattern is matched against: `provider/id`, undecoded.
 *
 * Not `modelKey`, which percent-encodes for the wire. CLIProxyAPI names its
 * account-pinned aliases `plus/gpt-5.5` and `team/gpt-5.6-luna`, so the wire key
 * is `cpa/plus%2Fgpt-5.5` — unreadable as a pattern, and indistinguishable from
 * an ordinary model to a glob that only knows `*`.
 */
const modelMatchKey = (model: PiModel<string>): string =>
  `${model.provider}/${model.id}`;

/**
 * Ordinary glob semantics: `*` matches within one slash-separated segment, `**`
 * matches across them.
 *
 * That distinction is what makes `cpa/*` mean "CLIProxyAPI's own models" and not
 * "everything CLIProxyAPI can reach": `cpa/claude-opus-5` matches, while the
 * account-pinned `cpa/plus/gpt-5.5` does not, because CPA's round-robin and
 * quota failover are supposed to choose the account, not the client. Ask for
 * those deliberately with `cpa/plus/*`, or take everything with `cpa/**`.
 */
const globToRegExp = (pattern: string): RegExp => {
  const source = pattern
    .split(/(\*\*|\*)/u)
    .map((part) => {
      if (part === "**") {
        return ".*";
      }
      if (part === "*") {
        return "[^/]*";
      }
      return part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
};

export class PiModelCatalog {
  readonly #modelRuntime: PiModelRuntime;
  readonly #selection: ModelSelection;
  readonly #patterns: readonly RegExp[];

  constructor(modelRuntime: PiModelRuntime, selection: ModelSelection) {
    this.#modelRuntime = modelRuntime;
    this.#selection = selection;
    this.#patterns = selection.patterns.map(globToRegExp);
  }

  /** The models this server offers: Pi's available models, minus anything the patterns exclude. */
  #offered(): readonly PiModel<string>[] {
    const available = this.#modelRuntime.modelRegistry.getAvailable();
    if (this.#patterns.length === 0) {
      return available;
    }
    const offered = available.filter((model) =>
      this.#patterns.some((pattern) => pattern.test(modelMatchKey(model)))
    );
    // A filter that matches nothing would leave a client with an empty picker
    // and no way to start a turn. A visibly wrong catalogue beats no catalogue.
    return offered.length > 0 ? offered : available;
  }

  /**
   * The model a client gets when it names none, or names one this server does
   * not offer. The configured default wins; otherwise the first offered model,
   * so there is always something to fall back to.
   */
  #default(): PiModel<string> | undefined {
    const offered = this.#offered();
    // Either spelling of the default: what a human writes (`cpa/claude-opus-5`)
    // and what `model/list` reports back on the wire, which may be encoded.
    const configured = offered.find(
      (model) =>
        modelMatchKey(model) === this.#selection.defaultModel ||
        modelKey(model) === this.#selection.defaultModel
    );
    return configured ?? offered.at(0);
  }

  async list(
    params: ModelListParams,
    signal?: AbortSignal
  ): Promise<ModelListResponse> {
    // Extension-provided models only exist once extensions have loaded. The
    // daemon starts that at boot; this awaits it so even a client that connects
    // mid-warm-up gets the complete catalogue rather than the built-ins.
    await this.#modelRuntime.loadExtensions();
    await this.#modelRuntime.refreshModels(signal);
    const offset = params.cursor ? cursorSchema.parse(params.cursor) : 0;
    const pageSize = Math.min(
      Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE
    );
    const models = this.#offered();
    const defaultModel = this.#default();
    const defaultKey = defaultModel ? modelKey(defaultModel) : undefined;
    const page = models.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      data: page.map((model) =>
        toCodexModel(
          model,
          this.#modelRuntime.modelRegistry.getProviderDisplayName(
            model.provider
          ),
          defaultKey
        )
      ),
      nextCursor:
        nextOffset < models.length ? `${CURSOR_PREFIX}${nextOffset}` : null,
    };
  }

  /** Await the extension load before resolving, so extension models are visible. */
  async resolveReady(key?: string | null): Promise<PiModel<string> | undefined> {
    await this.#modelRuntime.loadExtensions();
    return this.resolve(key);
  }

  /**
   * Resolve a Codex model slug, falling back to the default.
   *
   * Codex clients do not only send keys from our own `model/list`: the ChatGPT
   * app's background helper starts threads with bare Codex slugs such as
   * `gpt-5.4-mini`, which name no Pi provider at all. Failing those requests
   * surfaced on the phone as a thread that would not start, so anything this
   * server does not offer resolves to the default model instead.
   */
  resolve(key?: string | null): PiModel<string> | undefined {
    if (!key) {
      return this.#default();
    }
    const identity = decodeModelKey(key);
    const requested = identity
      ? this.#modelRuntime.modelRuntime.getModel(
          identity.provider,
          identity.modelId
        )
      : undefined;
    if (
      requested &&
      this.#offered().some(
        (model) => modelMatchKey(model) === modelMatchKey(requested)
      )
    ) {
      return requested;
    }
    return this.#default();
  }

  static key(model: PiModel<string>): string {
    return modelKey(model);
  }
}
