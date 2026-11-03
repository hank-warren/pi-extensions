import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";

export const COMMAND_ENV = "PI_CLAUDE_SUB_COMMAND";
export const CONFIG_DIR_ENV = "PI_CLAUDE_SUB_CONFIG_DIR";
export const THREADS_ENV = "PI_CLAUDE_SUB_THREADS";

export const INSTALL_HINT =
  "Claude Code is not installed. Install it (https://docs.anthropic.com/en/docs/claude-code) " +
  `or set ${COMMAND_ENV} to the executable.`;
export const LOGIN_HINT = "Claude Code is installed but not logged in. Run `claude auth login` and try again.";

export type Env = Record<string, string | undefined>;

export interface ClaudeStatus {
  available: boolean;
  loggedIn: boolean;
  /** True when Claude Code reports a Claude Pro/Max-style subscription login. */
  subscription: boolean;
  authMethod?: string;
  apiProvider?: string;
  plan?: string;
  detail?: string;
  command?: string;
  version?: string;
}

/** Whether an environment flag is set to something other than an explicit "off" value. */
export function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && !["0", "false", "no", "off"].includes(normalized);
}

function configuredCommand(env: Env): string {
  return env[COMMAND_ENV] || "claude";
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeExecutable(env: Env = process.env): Promise<string | undefined> {
  const command = configuredCommand(env);
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return (await executable(candidate)) ? candidate : undefined;
  }
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").flatMap((suffix) => [suffix, suffix.toLowerCase()])
      : [""];
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of extensions) {
      const candidate = join(directory, process.platform === "win32" && extname(command) ? command : command + suffix);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Inherited variables that would move Claude Code off the user's subscription login. */
export function conflictingEnvironment(env: Env): string[] {
  const conflicts = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
  ].filter((key) => !!env[key]);
  for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (envFlagEnabled(env[key])) conflicts.push(key);
  }
  return conflicts;
}

function definedEnv(env: Env): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) output[key] = value;
  if (output[CONFIG_DIR_ENV]) output.CLAUDE_CONFIG_DIR = output[CONFIG_DIR_ENV];
  return output;
}

export interface ClaudeEnvOptions {
  maxOutputTokens?: number;
  thinkingOff?: boolean;
}

/**
 * Environment for a Claude Code worker. Refuses API-key, base-URL and cloud
 * backend overrides, turns on Claude Code's own message-threads client, and
 * keeps compaction, tool search and MCP backgrounding out of Pi's way.
 */
export function claudeEnvironment(input: Env, options: ClaudeEnvOptions = {}): Record<string, string> {
  const env = definedEnv({ ...process.env, ...input });
  const conflicts = conflictingEnvironment(env);
  if (conflicts.length) {
    throw new Error(
      `Claude subscription billing: refusing to start Claude Code with auth/backend overrides that bypass your ` +
        `subscription login: ${conflicts.join(", ")}. Unset them for Pi.`,
    );
  }
  delete env.CLAUDE_CODE_EXTRA_BODY;
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  Object.assign(env, {
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    MAX_MCP_OUTPUT_TOKENS: "100000000",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  });
  if (env[THREADS_ENV] === undefined || envFlagEnabled(env[THREADS_ENV])) env.CLAUDE_CODE_TETHER_LIVE = "1";
  else delete env.CLAUDE_CODE_TETHER_LIVE;
  if (options.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxOutputTokens);
  if (options.thinkingOff) env.CLAUDE_CODE_DISABLE_THINKING = "1";
  else delete env.CLAUDE_CODE_DISABLE_THINKING;
  return env;
}

export function spawnCommand(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const comspec = options?.env?.COMSPEC || process.env.COMSPEC || "cmd.exe";
    const quote = (value: string) => `"${value.replace(/"/gu, '""')}"`;
    return spawn(comspec, ["/d", "/s", "/c", [quote(command), ...args.map(quote)].join(" ")], options);
  }
  return spawn(command, args, options);
}

export function childExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else reject(new Error(`Claude Code exited from signal ${signal ?? "unknown"}`));
    });
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // It exited between the checks.
    }
  }
}

async function captureProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = spawnCommand(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-1_000_000)));
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));
  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const code = await childExit(child);
    signal?.throwIfAborted();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function getClaudeStatus(envInput: Env = process.env, signal?: AbortSignal): Promise<ClaudeStatus> {
  const env = definedEnv({ ...process.env, ...envInput });
  const command = await resolveClaudeExecutable(env);
  if (!command) return { available: false, loggedIn: false, subscription: false, detail: INSTALL_HINT };
  try {
    const [result, version] = await Promise.all([
      captureProcess(command, ["auth", "status"], env, signal),
      captureProcess(command, ["--version"], env, signal).catch(() => undefined),
    ]);
    const payload = result.stdout.trim().startsWith("{")
      ? (JSON.parse(result.stdout) as Record<string, unknown>)
      : {};
    const loggedIn = payload.loggedIn === true;
    const plan = typeof payload.subscriptionType === "string" ? payload.subscriptionType : undefined;
    return {
      available: true,
      loggedIn,
      subscription: loggedIn && !!plan,
      command,
      authMethod: typeof payload.authMethod === "string" ? payload.authMethod : undefined,
      apiProvider: typeof payload.apiProvider === "string" ? payload.apiProvider : undefined,
      plan,
      version: version?.stdout.trim().split(/\s/u)[0] || undefined,
      detail: loggedIn ? undefined : LOGIN_HINT,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: true, loggedIn: false, subscription: false, command, detail: LOGIN_HINT };
  }
}

const READY_STATUS_TTL_MS = 60_000;
const readyStatusCache = new Map<string, { command: string; version: string; expires: number }>();

export interface ReadyClaude {
  command: string;
  version: string;
}

/** Resolve a logged-in Claude Code executable, caching success briefly. */
export async function readyClaude(envInput: Env, signal?: AbortSignal): Promise<ReadyClaude> {
  const env = definedEnv({ ...process.env, ...envInput });
  const key = JSON.stringify([configuredCommand(env), env.PATH, env.HOME, env.CLAUDE_CONFIG_DIR]);
  const cached = readyStatusCache.get(key);
  if (cached && cached.expires > Date.now()) return { command: cached.command, version: cached.version };
  const status = await getClaudeStatus(env, signal);
  if (!status.available || !status.command) throw new Error(INSTALL_HINT);
  if (!status.loggedIn) {
    readyStatusCache.delete(key);
    throw new Error(LOGIN_HINT);
  }
  if (!status.subscription) {
    throw new Error(
      "Claude subscription billing: Claude Code is not signed in with a Claude subscription. " +
        "Run `claude auth login` with your Claude Pro/Max account.",
    );
  }
  const ready = { command: status.command, version: status.version ?? "unknown" };
  readyStatusCache.set(key, { ...ready, expires: Date.now() + READY_STATUS_TTL_MS });
  return ready;
}

export function clearReadyStatusCache(): void {
  readyStatusCache.clear();
}

export interface DiscoveredClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsThinkingOff?: boolean;
  /** Context window Claude Code applies to this model (`get_context_usage.rawMaxTokens`). */
  contextWindow?: number;
}

function isDiscoveredModel(value: unknown): value is DiscoveredClaudeModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<DiscoveredClaudeModel>;
  return typeof model.value === "string" && typeof model.displayName === "string" && typeof model.description === "string";
}

const PROBE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--mcp-config",
  JSON.stringify({ mcpServers: {} }),
];

/** A Claude Code process used only for control requests; it never sends a model request. */
class ControlProbe {
  private readonly waiters = new Map<string, (response: Record<string, unknown>) => void>();
  private next = 0;
  readonly exited: Promise<number>;

  constructor(private readonly child: ChildProcess) {
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    reader.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type !== "control_response") return;
      const response = event.response as Record<string, unknown> | undefined;
      const id = typeof response?.request_id === "string" ? response.request_id : undefined;
      if (id) this.waiters.get(id)?.(response!);
    });
    this.exited = childExit(child).catch(() => -1);
    void this.exited.then(() => {
      for (const waiter of this.waiters.values()) waiter({ subtype: "error", error: "Claude Code exited" });
      this.waiters.clear();
    });
  }

  request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `pi-claude-${this.next++}`;
    return new Promise((resolve) => {
      this.waiters.set(id, (response) => {
        this.waiters.delete(id);
        resolve(response);
      });
      this.child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
    });
  }

  close(): void {
    this.child.stdin?.end();
    killProcessTree(this.child);
  }
}

function startProbe(command: string, env: Record<string, string>, model: string): ControlProbe {
  const child = spawnCommand(command, [...PROBE_ARGS, "--model", model], {
    cwd: process.cwd(),
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin?.on("error", () => undefined);
  return new ControlProbe(child);
}

/**
 * Ask the installed Claude Code for the account's selectable models and the
 * context window it applies to each. Uses control requests only: no model
 * request is sent, so this costs no plan quota.
 */
export async function discoverClaudeModels(
  envInput: Env = process.env,
  signal?: AbortSignal,
  timeoutMs = 45_000,
): Promise<DiscoveredClaudeModel[]> {
  signal?.throwIfAborted();
  const env = claudeEnvironment(envInput);
  const { command } = await readyClaude(envInput, signal);
  const probes: ControlProbe[] = [];
  let timer: NodeJS.Timeout | undefined;
  const abort = () => probes.forEach((probe) => probe.close());
  signal?.addEventListener("abort", abort, { once: true });
  const work = (async () => {
    const first = startProbe(command, env, "default");
    probes.push(first);
    const init = await first.request({ subtype: "initialize" });
    const payload = init.response as Record<string, unknown> | undefined;
    const models = Array.isArray(payload?.models) ? payload.models.filter(isDiscoveredModel) : [];
    if (!models.length) throw new Error(`Claude Code returned no selectable models${init.error ? `: ${init.error}` : ""}`);
    const unique = new Map<string, DiscoveredClaudeModel>();
    for (const model of models) {
      if (model.value === "default") continue;
      const id = model.resolvedModel || model.value;
      if (!unique.has(id)) unique.set(id, { ...model });
    }
    const queue = [...unique.entries()];
    const lanes = Math.min(4, queue.length);
    for (let lane = 1; lane < lanes; lane++) probes.push(startProbe(command, env, "default"));
    await Promise.all(
      probes.slice(0, lanes).map(async (probe) => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          const [id, model] = item;
          const set = await probe.request({ subtype: "set_model", model: id });
          if (set.subtype !== "success") continue;
          const usage = await probe.request({ subtype: "get_context_usage" });
          const raw = (usage.response as Record<string, unknown> | undefined)?.rawMaxTokens;
          if (typeof raw === "number" && raw > 0) model.contextWindow = raw;
        }
      }),
    );
    return [...unique.values()];
  })();
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Code model discovery timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    for (const probe of probes) probe.close();
  }
}
