import path from "node:path";

import {
  ModelRegistry,
  ModelRuntime,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Logger } from "@logtape/logtape";

import type { AppServerConfig } from "../config/app-server-config.ts";

export const OPENAI_CODEX_PROVIDER = "openai-codex";

export class PiModelRuntime {
  readonly modelRegistry: ModelRegistry;
  readonly modelRuntime: ModelRuntime;
  readonly #piAgentDir: string;
  readonly #servicesByCwd = new Map<string, Promise<AgentSessionServices>>();
  #extensionsLoaded?: Promise<void>;

  private constructor(modelRuntime: ModelRuntime, piAgentDir: string) {
    this.modelRuntime = modelRuntime;
    this.modelRegistry = new ModelRegistry(modelRuntime);
    this.#piAgentDir = piAgentDir;
  }

  static async create(config: AppServerConfig): Promise<PiModelRuntime> {
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: path.join(config.piAgentDir, "auth.json"),
      modelsPath: path.join(config.piAgentDir, "models.json"),
      // The create-time catalog refresh stays on (pi's default) so the daemon
      // sees provider extensions' models; `allowModelNetwork: false` already
      // keeps it off the network. Upstream passed `refreshOnCreate: true`
      // explicitly, which does not typecheck against pi 0.84.
    });
    return new PiModelRuntime(modelRuntime, config.piAgentDir);
  }

  /**
   * Load Pi's extensions once, against this shared runtime.
   *
   * A bare `ModelRuntime` knows only Pi's built-in providers. Providers that
   * arrive through an extension — a CLIProxyAPI catalog, for instance — are
   * registered while extensions load, which otherwise first happens when a
   * client starts a thread. Without this, the first `model/list` a phone sees is
   * missing every extension-provided model, and picking one of them fails until
   * some session has warmed the runtime by accident.
   *
   * `createAgentSessionServices` is that load: it reloads the resource tree,
   * replays each extension's pending provider registration onto the runtime we
   * pass in, and refreshes the catalog. It creates no session and starts no
   * turn. Memoised, so concurrent callers share one load and later calls are
   * free.
   */
  loadExtensions(options?: {
    readonly cwd?: string;
    readonly logger?: Logger;
  }): Promise<void> {
    this.#extensionsLoaded ??= this.#loadExtensions(
      options?.cwd ?? process.cwd(),
      options?.logger
    );
    return this.#extensionsLoaded;
  }

  /**
   * Cwd-bound Pi services, built once per directory and reused.
   *
   * Building them loads every extension for that directory, which takes seconds.
   * `createAgentSession` does it on each call, so every `thread/start` paid it
   * again: 3.6 s to open a thread, against a ChatGPT app that gives up after
   * about four and retries — which is why one prompt from a phone arrived
   * twice, in two threads. Sessions sharing a cwd now share the services, and
   * the daemon's own warm-up populates the entry for its working directory, so
   * the common case is already built before the first client connects.
   */
  services(cwd: string): Promise<AgentSessionServices> {
    const resolved = path.resolve(cwd);
    const existing = this.#servicesByCwd.get(resolved);
    if (existing) {
      return existing;
    }
    const created = createAgentSessionServices({
      // The same agent directory the credentials and model catalogue come
      // from, so extensions cannot be loaded from a different Pi install than
      // the one this runtime is configured against.
      agentDir: this.#piAgentDir,
      cwd: resolved,
      modelRuntime: this.modelRuntime,
    }).catch((error: unknown) => {
      // A failed build must not be cached, or every later thread in this
      // directory inherits the failure.
      this.#servicesByCwd.delete(resolved);
      throw error;
    });
    this.#servicesByCwd.set(resolved, created);
    return created;
  }

  async #loadExtensions(cwd: string, logger?: Logger): Promise<void> {
    const startedAt = Date.now();
    try {
      const services = await this.services(cwd);
      for (const diagnostic of services.diagnostics) {
        if (diagnostic.type === "error") {
          logger?.warn("Pi extension diagnostic: {message}", {
            message: diagnostic.message,
          });
        }
      }
      logger?.info("Loaded Pi extensions in {durationMs} ms: {modelCount} models", {
        cwd,
        durationMs: Date.now() - startedAt,
        modelCount: this.modelRegistry.getAvailable().length,
      });
    } catch (error) {
      // A failed warm-up must not take the daemon down: Pi's built-in models
      // still work, and the next call retries.
      this.#extensionsLoaded = undefined;
      const failure =
        error instanceof Error ? error : new Error("Pi extension load failed");
      logger?.error(failure, { cwd });
    }
  }

  hasOpenAiAuthentication(): boolean {
    return this.modelRuntime.getProviderAuthStatus(OPENAI_CODEX_PROVIDER)
      .configured;
  }

  async refreshModels(signal?: AbortSignal): Promise<void> {
    await this.modelRuntime.refresh({ allowNetwork: false, signal });
  }

  async logoutOpenAi(signal?: AbortSignal): Promise<void> {
    await this.modelRuntime.logout(OPENAI_CODEX_PROVIDER, { signal });
  }
}
