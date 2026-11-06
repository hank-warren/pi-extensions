import { createProvider, type AuthContext, type ProviderEnv } from "@earendil-works/pi-ai";
import { COMMAND_ENV, CONFIG_DIR_ENV, discoverClaudeModels, getClaudeStatus, LOGIN_HINT, THREADS_ENV } from "./claude-cli.ts";
import { API_ID, BASE_URL, FALLBACK_MODELS, modelFromDiscovery, PROVIDER_ID, PROVIDER_NAME } from "./model-catalog.ts";
import { streamClaudeSubscription } from "./stream.ts";

const PROVIDER_ENV_NAMES = [COMMAND_ENV, CONFIG_DIR_ENV, THREADS_ENV, "CLAUDE_CONFIG_DIR"] as const;

async function providerEnvironment(ctx: AuthContext): Promise<ProviderEnv | undefined> {
  const env: ProviderEnv = {};
  await Promise.all(
    PROVIDER_ENV_NAMES.map(async (name) => {
      const value = await ctx.env(name);
      if (value !== undefined) env[name] = value;
    }),
  );
  return Object.keys(env).length ? env : undefined;
}

// Provider-scoped settings resolve only through auth hooks. Remember the latest
// values so model discovery and the status command see the same installation.
let lastProviderEnv: ProviderEnv | undefined;

/** The environment used to locate and configure Claude Code. */
export function claudeSubEnv(): Record<string, string | undefined> {
  return { ...process.env, ...lastProviderEnv };
}

export function createClaudeSubscriptionProvider() {
  let discoveredIds: Set<string> | undefined;
  const externalOAuthMarker = () => ({
    type: "oauth" as const,
    access: "claude-code-external",
    refresh: "claude-code-external",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  });
  return createProvider({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Claude Code login",
        // Report the external subscription login as OAuth-shaped auth so Pi labels
        // list-price accounting as a subscription. Credentials stay with Claude Code.
        async check({ ctx, signal }) {
          lastProviderEnv = await providerEnvironment(ctx);
          const status = await getClaudeStatus(claudeSubEnv(), signal);
          if (!status.available || !status.loggedIn || !status.subscription) return undefined;
          return { type: "oauth", source: `Claude Code ${status.plan ?? "subscription"}` };
        },
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const env = await providerEnvironment(ctx);
          lastProviderEnv = env;
          return { auth: { apiKey: "external-process" }, env, source: "Claude Code CLI" };
        },
      },
      // Metadata marker for Pi's subscription-aware UI; never imports credentials.
      oauth: {
        name: "Claude subscription (managed by Claude Code)",
        isSubscription: true,
        async login() {
          throw new Error(
            "Claude Code manages its own login. Run `claude auth login` in a terminal; this provider uses it automatically.",
          );
        },
        async refresh(_credential, signal) {
          const status = await getClaudeStatus(claudeSubEnv(), signal);
          if (!status.subscription) throw new Error(LOGIN_HINT);
          return externalOAuthMarker();
        },
        async toAuth() {
          return { apiKey: "external-process" };
        },
      },
    },
    models: FALLBACK_MODELS,
    async fetchModels({ signal }) {
      const models = (await discoverClaudeModels(claudeSubEnv(), signal)).map(modelFromDiscovery);
      discoveredIds = new Set(models.map((model) => model.id));
      return models;
    },
    filterModels(models) {
      const ids = discoveredIds;
      return ids ? models.filter((model) => ids.has(model.id)) : models;
    },
    api: {
      stream: streamClaudeSubscription,
      streamSimple: streamClaudeSubscription,
    },
  });
}

export { API_ID, PROVIDER_ID };
