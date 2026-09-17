import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { PI_ROOT_ENV, piRootFromPath } from "../../bin/pi-root.ts";

import { z } from "zod";

import type { AppServerConfig } from "../config/app-server-config.ts";
import { startRemoteControlPairing } from "../remote/pairing.ts";
import type { PairingResult } from "../remote/pairing.ts";
import type { DaemonEndpoint } from "./daemon-readiness.ts";
import { waitForDaemonEndpoint } from "./daemon-readiness.ts";

const DAEMON_START_TIMEOUT_MS = 60_000;
const DAEMON_STOP_TIMEOUT_MS = 5000;
const STOP_POLL_DELAY_MS = 50;
const endpointSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime().optional(),
  transport: z.literal("websocket"),
  url: z.url(),
});

export type DaemonStatus =
  | { readonly state: "stopped" }
  | { readonly endpoint: DaemonEndpoint; readonly state: "running" };

interface DaemonLaunch {
  readonly failure: Promise<Error>;
  readonly pid: number;
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const waitForChildFailure = async (
  child: ReturnType<typeof spawn>
): Promise<Error> => {
  try {
    await once(child, "exit");
    return new Error("Codex App Server exited before readiness");
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("Codex App Server failed before readiness");
  }
};

/**
 * The daemon runs from source in its own node process. Pi's packages resolve
 * there through bin/pi-resolve-hooks.ts, which needs the host pi install: this
 * extension is loaded by pi, so pi's own entry script locates it.
 */
const piRootForDaemon = (): string | undefined =>
  process.env[PI_ROOT_ENV] ?? piRootFromPath(process.argv[1] ?? "");

const nodeExecutable = (): string =>
  path.basename(process.execPath).startsWith("node") ? process.execPath : "node";

const startDaemonProcess = (): DaemonLaunch => {
  const cliPath = fileURLToPath(
    new URL("../../bin/pi-codex-app-server.ts", import.meta.url)
  );
  const piRoot = piRootForDaemon();
  const child = spawn(nodeExecutable(), [cliPath, "daemon"], {
    detached: true,
    env: piRoot ? { ...process.env, [PI_ROOT_ENV]: piRoot } : process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  if (!child.pid) {
    throw new Error("Codex App Server process did not receive a PID");
  }
  const failure = waitForChildFailure(child);
  child.unref();
  return { failure, pid: child.pid };
};

const waitForProcessExit = async (
  pid: number,
  deadline: number
): Promise<void> => {
  if (!processExists(pid)) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error("Codex App Server did not stop within 5000 ms");
  }
  await delay(STOP_POLL_DELAY_MS);
  await waitForProcessExit(pid, deadline);
};

type StartOutcome =
  | { readonly endpoint: DaemonEndpoint; readonly type: "ready" }
  | { readonly error: Error; readonly type: "failed" };

export class AppDaemonController {
  readonly #config: AppServerConfig;

  constructor(config: AppServerConfig) {
    this.#config = config;
  }

  async pair(): Promise<PairingResult> {
    return await startRemoteControlPairing(this.#config);
  }

  async start(): Promise<DaemonStatus> {
    const currentStatus = await this.status();
    if (currentStatus.state === "running") {
      return currentStatus;
    }
    const launch = startDaemonProcess();
    const readiness = waitForDaemonEndpoint({
      expectedPid: launch.pid,
      readEndpoint: async () => {
        const status = await this.status();
        return status.state === "running" ? status.endpoint : undefined;
      },
      timeoutMs: DAEMON_START_TIMEOUT_MS,
    });
    const outcome = await Promise.race<StartOutcome>([
      readiness.then((endpoint) => ({ endpoint, type: "ready" })),
      launch.failure.then((error) => ({ error, type: "failed" })),
    ]);
    if (outcome.type === "failed") {
      throw outcome.error;
    }
    return { endpoint: outcome.endpoint, state: "running" };
  }

  async status(): Promise<DaemonStatus> {
    try {
      const contents = await readFile(this.#config.paths.endpoint, "utf-8");
      const endpoint = endpointSchema.parse(JSON.parse(contents));
      return processExists(endpoint.pid)
        ? { endpoint, state: "running" }
        : { state: "stopped" };
    } catch {
      return { state: "stopped" };
    }
  }

  async stop(): Promise<DaemonStatus> {
    const currentStatus = await this.status();
    if (currentStatus.state === "stopped") {
      return currentStatus;
    }
    process.kill(currentStatus.endpoint.pid, "SIGTERM");
    await waitForProcessExit(
      currentStatus.endpoint.pid,
      Date.now() + DAEMON_STOP_TIMEOUT_MS
    );
    await rm(this.#config.paths.endpoint, { force: true });
    return { state: "stopped" };
  }
}
