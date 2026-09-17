import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import type { Logger } from "@logtape/logtape";

import type { JsonRpcConnection } from "../protocol/json-rpc-connection.ts";
import { invalidParams } from "../protocol/request-error.ts";
import type { ProcessKillParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProcessKillParams.js";
import type { ProcessSpawnParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProcessSpawnParams.js";
import type { ProcessWriteStdinParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ProcessWriteStdinParams.js";

/** Per-stream capture limit when the client does not ask for one. */
const DEFAULT_OUTPUT_BYTES_CAP = 1024 * 1024;

/** How long a killed process gets to exit before it is killed uncatchably. */
const KILL_GRACE_MS = 2000;

type OutputStream = "stdout" | "stderr";

/** One spawned child, and the capture state its exit notification needs. */
class HostedProcess {
  readonly #child: ChildProcess;
  readonly #handle: string;
  readonly #connection: JsonRpcConnection;
  readonly #streaming: boolean;
  readonly #cap: number | undefined;
  readonly #captured: Record<OutputStream, Buffer[]> = {
    stderr: [],
    stdout: [],
  };
  readonly #capReached: Record<OutputStream, boolean> = {
    stderr: false,
    stdout: false,
  };
  readonly #written: Record<OutputStream, number> = { stderr: 0, stdout: 0 };
  #timeout?: NodeJS.Timeout;
  #killTimer?: NodeJS.Timeout;
  #exited = false;

  constructor(options: {
    readonly child: ChildProcess;
    readonly connection: JsonRpcConnection;
    readonly handle: string;
    readonly cap: number | undefined;
    readonly streaming: boolean;
    readonly timeoutMs: number | undefined;
    readonly onExit: () => void;
  }) {
    this.#child = options.child;
    this.#connection = options.connection;
    this.#handle = options.handle;
    this.#cap = options.cap;
    this.#streaming = options.streaming;

    this.#child.stdout?.on("data", (chunk: Buffer) => {
      this.#output("stdout", chunk);
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#output("stderr", chunk);
    });
    this.#child.on("error", (error: Error) => {
      // Spawn failures (a missing binary, a cwd that vanished) arrive here
      // rather than as a non-zero exit. The client is still waiting on an exit
      // notification, so report one with the message on stderr instead of
      // leaving it to time out.
      this.#captured.stderr.push(Buffer.from(`${error.message}\n`));
      this.#finish(-1, options.onExit);
    });
    this.#child.on("close", (code, signal) => {
      // A signalled process has a null exit code; report the conventional
      // 128 + signal so the client sees a number, as the schema requires.
      this.#finish(code ?? (signal ? 128 + signalNumber(signal) : -1), options.onExit);
    });

    if (options.timeoutMs !== undefined) {
      this.#timeout = setTimeout(() => {
        this.kill();
      }, options.timeoutMs);
    }
  }

  writeStdin(data: Buffer | undefined, closeStdin: boolean): void {
    const { stdin } = this.#child;
    if (!stdin?.writable) {
      return;
    }
    if (data && data.byteLength > 0) {
      stdin.write(data);
    }
    if (closeStdin) {
      // Some commands read to EOF before doing anything; without this they
      // would hang and take the client's twenty-second patience with them.
      stdin.end();
    }
  }

  kill(): void {
    if (this.#exited) {
      return;
    }
    this.#child.kill("SIGTERM");
    this.#killTimer ??= setTimeout(() => {
      this.#child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    // Nothing else is keeping the event loop alive on the daemon's account;
    // this timer must not be what holds a shutdown open.
    this.#killTimer.unref?.();
  }

  #output(stream: OutputStream, chunk: Buffer): void {
    if (this.#capReached[stream]) {
      return;
    }
    let payload = chunk;
    let reachedNow = false;
    if (this.#cap !== undefined) {
      const remaining = this.#cap - this.#written[stream];
      if (chunk.byteLength >= remaining) {
        payload = chunk.subarray(0, Math.max(remaining, 0));
        reachedNow = true;
      }
    }
    this.#written[stream] += payload.byteLength;
    if (this.#streaming) {
      if (payload.byteLength > 0 || reachedNow) {
        this.#connection.notify("process/outputDelta", {
          capReached: reachedNow,
          deltaBase64: payload.toString("base64"),
          processHandle: this.#handle,
          stream,
        });
      }
    } else {
      this.#captured[stream].push(payload);
    }
    if (reachedNow) {
      this.#capReached[stream] = true;
    }
  }

  #finish(exitCode: number, onExit: () => void): void {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    clearTimeout(this.#timeout);
    clearTimeout(this.#killTimer);
    onExit();
    if (this.#connection.isClosed) {
      return;
    }
    this.#connection.notify("process/exited", {
      exitCode,
      // Streamed bytes are never repeated here; the schema is explicit that
      // these are empty when the client asked for notifications.
      stderr: this.#streaming ? "" : this.#text("stderr"),
      stderrCapReached: this.#capReached.stderr,
      stdout: this.#streaming ? "" : this.#text("stdout"),
      stdoutCapReached: this.#capReached.stdout,
      processHandle: this.#handle,
    });
  }

  #text(stream: OutputStream): string {
    return Buffer.concat(this.#captured[stream]).toString("utf8");
  }
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGQUIT: 3,
  SIGTERM: 15,
};

const signalNumber = (signal: NodeJS.Signals): number =>
  SIGNAL_NUMBERS[signal] ?? 0;

/**
 * Run processes on behalf of a connected client.
 *
 * The ChatGPT app spawns helpers on the host to answer questions it will not
 * ask over the protocol \u2014 whether a directory is a git repository, what branch
 * it is on \u2014 and blocks its own UI until they report back. Answering
 * `process/spawn` with the schema's empty success object is not enough: the
 * output and exit arrive as `process/outputDelta` and `process/exited`
 * notifications, and a client that never receives them waits about twenty
 * seconds, gives up, and retries forever. That retry loop is what made every
 * directory except an empty non-repository unusable from a phone.
 *
 * Processes are connection-scoped, as their handles are: when a client goes
 * away, everything it started is terminated rather than left behind on the
 * host.
 */
export const registerProcessHost = (
  connection: JsonRpcConnection,
  logger: Logger
): void => {
  const processes = new Map<string, HostedProcess>();

  connection.onClose(() => {
    for (const hosted of processes.values()) {
      hosted.kill();
    }
    processes.clear();
  });

  connection.registerRequest("process/spawn", (params: ProcessSpawnParams) => {
    const [command, ...args] = params.command;
    if (command === undefined) {
      throw invalidParams("command must not be empty");
    }
    if (!isAbsolute(params.cwd)) {
      throw invalidParams("cwd must be an absolute path");
    }
    if (processes.has(params.processHandle)) {
      throw invalidParams(
        `process handle already active: ${params.processHandle}`
      );
    }

    // A PTY would need a native module, which this package cannot have: it
    // ships as TypeScript sources with no build step. Everything the app spawns
    // in practice is a short non-interactive command, so a tty request runs on
    // pipes instead of failing outright.
    if (params.tty === true) {
      logger.warn("process/spawn asked for a tty; running on pipes", {
        command,
      });
    }

    const streaming = params.streamStdoutStderr === true || params.tty === true;
    const child = spawn(command, args, {
      cwd: params.cwd,
      env: mergedEnvironment(params.env),
      stdio: "pipe",
    });

    logger.debug("Spawned process", {
      command,
      cwd: params.cwd,
      handle: params.processHandle,
      pid: child.pid,
    });

    processes.set(
      params.processHandle,
      new HostedProcess({
        cap:
          params.outputBytesCap === null
            ? undefined
            : (params.outputBytesCap ?? DEFAULT_OUTPUT_BYTES_CAP),
        child,
        connection,
        handle: params.processHandle,
        onExit: () => {
          processes.delete(params.processHandle);
        },
        streaming,
        timeoutMs: params.timeoutMs ?? undefined,
      })
    );
    return {};
  });

  connection.registerRequest(
    "process/writeStdin",
    (params: ProcessWriteStdinParams) => {
      const hosted = processes.get(params.processHandle);
      if (!hosted) {
        throw invalidParams(`unknown process handle: ${params.processHandle}`);
      }
      hosted.writeStdin(
        params.deltaBase64 == null
          ? undefined
          : Buffer.from(params.deltaBase64, "base64"),
        params.closeStdin === true
      );
      return {};
    }
  );

  connection.registerRequest("process/kill", (params: ProcessKillParams) => {
    // Killing something already gone is not an error: the client may simply be
    // racing the exit notification.
    processes.get(params.processHandle)?.kill();
    return {};
  });
};

/**
 * The daemon's environment with the client's overrides applied, where a null
 * value means "unset this", per the protocol.
 */
const mergedEnvironment = (
  overrides: ProcessSpawnParams["env"]
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null || value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
};
