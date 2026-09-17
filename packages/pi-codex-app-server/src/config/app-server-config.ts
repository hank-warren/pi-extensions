import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const DEFAULT_LISTEN_URL = "ws://127.0.0.1:0";
// Codex clients show one flat model picker with no provider grouping, so an
// unfiltered Pi catalogue puts every provider's models in front of a phone. The
// defaults here scope it to CLIProxyAPI, which is the point of this host: CPA
// owns account round-robin and quota failover, so the picker must not offer
// account-pinned slugs that would take that decision away from it.
const DEFAULT_MODEL_PATTERNS = "cpa/*";
const DEFAULT_MODEL = "cpa/claude-opus-5";
const appServerEnvironmentSchema = z.object({
  PI_CODEX_APP_SERVER_AUTOSTART: z.enum(["0", "1"]).optional(),
  PI_CODEX_APP_SERVER_DEFAULT_MODEL: z.string().trim().min(1).optional(),
  PI_CODEX_APP_SERVER_HOME: z.string().trim().min(1).optional(),
  PI_CODEX_APP_SERVER_MODELS: z.string().trim().min(1).optional(),
  PI_CODEX_APP_SERVER_HOST_NAME: z.string().trim().min(1).optional(),
  PI_CODEX_APP_SERVER_LISTEN: z.string().trim().min(1).optional(),
  PI_CODEX_REMOTE_BASE_URL: z.url().optional(),
  PI_CODEX_REMOTE_CONTROL: z.enum(["0", "1"]).optional(),
});
const webSocketListenUrlSchema = z
  .url()
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === "ws:" || url.protocol === "wss:", {
    message: "must use the ws or wss protocol",
  });

export interface AppServerPaths {
  readonly database: string;
  readonly endpoint: string;
  readonly home: string;
  readonly logs: string;
}

export interface ModelSelection {
  /** Model key of the model a client gets when it names none, or names one that does not exist. */
  readonly defaultModel: string;
  /** Glob patterns over `provider/model` keys; a model must match one to be offered. */
  readonly patterns: readonly string[];
}

export interface AppServerConfig {
  readonly autoStart: boolean;
  readonly hostName: string;
  readonly listenUrl: URL;
  readonly models: ModelSelection;
  readonly paths: AppServerPaths;
  readonly piAgentDir: string;
  readonly remoteControl: {
    readonly baseUrl: URL;
    readonly enabled: boolean;
  };
}

const resolveAppServerHome = (configured?: string): string =>
  configured
    ? path.resolve(configured)
    : path.join(getAgentDir(), "codex-app-server");

export const loadConfig = (): AppServerConfig => {
  const environment = appServerEnvironmentSchema.parse(process.env);
  const home = resolveAppServerHome(environment.PI_CODEX_APP_SERVER_HOME);
  return {
    // Off unless asked for, unlike upstream. A daemon is a long-lived, relay-
    // connected process that owns pairing state and holds a lease on the session
    // store; deciding to run one belongs to the host (a systemd unit here), not
    // to whichever pi session happens to start first. `/codex-server` and
    // PI_CODEX_APP_SERVER_AUTOSTART=1 both still start one on request.
    autoStart: environment.PI_CODEX_APP_SERVER_AUTOSTART === "1",
    hostName: environment.PI_CODEX_APP_SERVER_HOST_NAME ?? hostname(),
    listenUrl: webSocketListenUrlSchema.parse(
      environment.PI_CODEX_APP_SERVER_LISTEN ?? DEFAULT_LISTEN_URL
    ),
    models: {
      defaultModel:
        environment.PI_CODEX_APP_SERVER_DEFAULT_MODEL ?? DEFAULT_MODEL,
      patterns: (
        environment.PI_CODEX_APP_SERVER_MODELS ?? DEFAULT_MODEL_PATTERNS
      )
        .split(",")
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0),
    },
    paths: {
      database: path.join(home, "state.sqlite"),
      endpoint: path.join(home, "endpoint.json"),
      home,
      logs: path.join(home, "logs"),
    },
    piAgentDir: getAgentDir(),
    remoteControl: {
      baseUrl: new URL(
        environment.PI_CODEX_REMOTE_BASE_URL ??
          "https://chatgpt.com/backend-api/"
      ),
      enabled: environment.PI_CODEX_REMOTE_CONTROL !== "0",
    },
  };
};

export const ensureAppServerDirectories = async (
  config: AppServerConfig
): Promise<void> => {
  await Promise.all([
    mkdir(config.paths.home, { recursive: true }),
    mkdir(config.paths.logs, { recursive: true }),
  ]);
};
