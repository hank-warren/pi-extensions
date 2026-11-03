import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { RateLimitInfo } from "./billing.ts";
import { McpBridge, privateDirectory, type McpCallResult, type McpTool, type ParkedCall } from "./bridge.ts";
import { childExit, killProcessTree, spawnCommand } from "./claude-cli.ts";
import type { AnthropicStreamEvent, NativeMessage, NativeOutputEvent, NativeResult } from "./native-types.ts";
import { MCP_SERVER_NAME, TOOL_PREFIX } from "./transcript.ts";

export interface LaunchSpec {
  command: string;
  cwd: string;
  env: Record<string, string>;
  model: string;
  effort?: string;
  systemPrompt: string;
  tools: McpTool[];
  /** Resume (and optionally fork) an existing Claude Code session. */
  resume?: { sessionId: string; at?: string; fork: boolean };
  /** Session id for a fresh conversation. */
  sessionId?: string;
  fingerprint: string;
}

/** Receives one Pi turn's worth of Claude Code output. */
export interface TurnSink {
  onStreamEvent(event: AnthropicStreamEvent): void;
  onAssistant?(message: NativeMessage, error: string | undefined): void;
  onRateLimit?(info: RateLimitInfo): void;
  /** The upstream message ended with tool_use; Claude Code is about to call the parked tools. */
  onToolUseStop(): void;
  onResult(result: NativeResult): void;
  onExit(error: Error): void;
}

export type WorkerPhase = "starting" | "idle" | "turn" | "parked" | "closed";

const MCP_BRIDGE_PATH = fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url));

export function mcpBridgeScriptPath(): string {
  return MCP_BRIDGE_PATH;
}

export function buildArgs(spec: LaunchSpec, systemPromptFile: string, mcpConfigFile: string): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--model",
    spec.model,
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "bypassPermissions",
    "--system-prompt-file",
    systemPromptFile,
    "--system-prompt-snapshot",
    "off",
    "--mcp-config",
    mcpConfigFile,
  ];
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.resume) {
    args.push("--resume", spec.resume.sessionId);
    if (spec.resume.at) args.push("--resume-session-at", spec.resume.at);
    if (spec.resume.fork) args.push("--fork-session");
  } else if (spec.sessionId) {
    args.push("--session-id", spec.sessionId);
  }
  return args;
}

/**
 * One long-lived Claude Code process (`claude -p` stream-json). Pi turns are
 * written to its stdin; tool calls arrive over the MCP bridge and stay parked
 * until Pi supplies the real results.
 */
export class ClaudeWorker {
  phase: WorkerPhase = "starting";
  sessionId?: string;
  projectDir?: string;
  /** Prefix hash of the Pi conversation Claude Code's history currently matches. */
  tipHash?: string;
  /** Set when Claude Code's history may have diverged from Pi's; the worker is then never continued. */
  dirty = false;
  lastUsed = Date.now();
  readonly createdAt = Date.now();
  /** tool_use ids of the last message that stopped for tools, in order. */
  pendingToolUses: { id: string; name: string }[] = [];
  /** Claude Code uuid of the transcript entry holding each tool_result. */
  readonly toolResultUuids = new Map<string, string>();
  lastAssistantUuid?: string;
  lastAssistantMessageId?: string;
  /** Message id of the latest upstream message whose stream started. */
  currentMessageId?: string;
  readonly selfAnswered = new Set<string>();
  /** True once Claude Code produced any stream-json output for this process. */
  sessionHadOutput = false;
  readonly exited: Promise<number>;
  /** Latest plan-limit status and a counter that moves with every rate_limit_event. */
  lastRateLimit?: RateLimitInfo;
  rateLimitSeq = 0;
  /** Counts MCP tool calls received; the first call after a tool_use stop means the message is fully processed. */
  toolCallSeq = 0;

  private sink?: TurnSink;
  private stderr = "";
  private parked: (ParkedCall & { resolvedId: string })[] = [];
  private readonly answers = new Map<string, McpCallResult>();
  private readonly answeredByPi = new Set<string>();
  private readonly called = new Set<string>();
  private currentToolUses: { id: string; name: string }[] = [];
  private currentStop?: string | null;
  private controlWaiters = new Map<string, (response: Record<string, unknown>) => void>();
  private controlSeq = 0;
  private closing = false;

  private constructor(
    readonly spec: LaunchSpec,
    private readonly child: ChildProcess,
    private readonly bridge: McpBridge,
    private readonly workDir: string,
  ) {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-16_384)));
    child.stdin?.on("error", () => undefined);
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    reader.on("line", (line) => {
      if (!line.trim()) return;
      let event: NativeOutputEvent;
      try {
        event = JSON.parse(line) as NativeOutputEvent;
      } catch {
        return;
      }
      try {
        this.handle(event);
      } catch (error) {
        this.dirty = true;
        this.sink?.onExit(error instanceof Error ? error : new Error(String(error)));
        this.sink = undefined;
      }
    });
    this.exited = childExit(child).catch(() => -1);
    void this.exited.then((code) => this.onExit(code));
    if (spec.resume?.sessionId && !spec.resume.fork) this.sessionId = spec.resume.sessionId;
    if (spec.sessionId) this.sessionId = spec.sessionId;
  }

  static async start(spec: LaunchSpec): Promise<ClaudeWorker> {
    const root = await privateDirectory();
    const workDir = join(root, `w-${randomBytes(6).toString("hex")}`);
    await mkdir(workDir, { mode: 0o700 });
    let bridge: McpBridge | undefined;
    try {
      let worker: ClaudeWorker | undefined;
      const early: ParkedCall[] = [];
      bridge = await McpBridge.start(root, spec.tools, (call) => (worker ? worker.onToolCall(call) : early.push(call)));
      const systemPromptFile = join(workDir, "system.md");
      const mcpConfigFile = join(workDir, "mcp.json");
      const mcpConfig = {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "stdio",
            command: process.env.PI_CLAUDE_SUB_NODE || process.execPath,
            args: [MCP_BRIDGE_PATH],
            env: { PI_CLAUDE_BRIDGE_SOCKET: bridge.socketPath, PI_CLAUDE_BRIDGE_TOKEN: bridge.token },
          },
        },
      };
      await Promise.all([
        writeFile(systemPromptFile, spec.systemPrompt, { mode: 0o600 }),
        writeFile(mcpConfigFile, JSON.stringify(mcpConfig), { mode: 0o600 }),
      ]);
      const child = spawnCommand(spec.command, buildArgs(spec, systemPromptFile, mcpConfigFile), {
        cwd: spec.cwd,
        env: spec.env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      worker = new ClaudeWorker(spec, child, bridge, workDir);
      for (const call of early) worker.onToolCall(call);
      return worker;
    } catch (error) {
      await bridge?.close();
      await rm(workDir, { recursive: true, force: true });
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  isAlive(): boolean {
    return this.phase !== "closed" && this.child.exitCode === null && this.child.signalCode === null;
  }

  stderrTail(): string {
    return this.stderr.trim().slice(-600);
  }

  /** Start a turn with one stdin user frame. */
  startTurn(content: unknown[], uuid: string, sink: TurnSink): void {
    if (!this.isAlive()) throw new Error("Claude Code process is no longer running");
    if (this.phase === "turn" || this.phase === "parked") throw new Error("Claude Code process is busy");
    this.sink = sink;
    this.phase = "turn";
    this.lastUsed = Date.now();
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") this.answeredByPi.add(block.tool_use_id);
    }
    this.write({ type: "user", uuid, session_id: "", parent_tool_use_id: null, message: { role: "user", content } });
  }

  /** Answer the parked tool calls with Pi's results and stream the next upstream message. */
  answerToolCalls(results: Map<string, McpCallResult>, sink: TurnSink): void {
    if (!this.isAlive()) throw new Error("Claude Code process is no longer running");
    if (this.phase !== "parked") throw new Error("Claude Code process is not waiting for tool results");
    this.sink = sink;
    this.phase = "turn";
    this.lastUsed = Date.now();
    for (const [id, result] of results) {
      this.answers.set(id, result);
      this.answeredByPi.add(id);
    }
    const parked = this.parked;
    this.parked = [];
    // Parked calls already hold their correlation; re-resolving would skip their own id.
    for (const call of parked) this.deliver(call, call.resolvedId);
  }

  /** Every pending tool_use was either answered by Pi or is still waiting; none was answered by Claude Code itself. */
  toolCallsIntact(): boolean {
    return this.pendingToolUses.every((call) => !this.selfAnswered.has(call.id));
  }

  detachSink(): void {
    this.sink = undefined;
  }

  onToolCall(call: ParkedCall): void {
    this.toolCallSeq += 1;
    const nativeName = `${TOOL_PREFIX}${call.name}`;
    let id = call.toolUseId;
    if (!id) {
      // Older Claude Code: correlate by order and name.
      id = this.pendingToolUses.find((pending) => pending.name === nativeName && !this.called.has(pending.id))?.id;
    }
    if (!id) {
      call.respond({ isError: true, content: [{ type: "text", text: "pi-claude: unexpected tool call" }] });
      this.dirty = true;
      return;
    }
    this.called.add(id);
    this.deliver(call, id);
  }

  private deliver(call: ParkedCall, id: string): void {
    const answer = this.answers.get(id);
    if (answer) {
      this.answers.delete(id);
      call.respond(answer);
      return;
    }
    this.parked.push({ ...call, resolvedId: id });
  }

  private write(message: unknown): void {
    if (!this.child.stdin?.writable) throw new Error("Claude Code stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  control(request: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown> | undefined> {
    if (!this.isAlive()) return Promise.resolve(undefined);
    const id = `pi-claude-${this.controlSeq++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.controlWaiters.set(id, (response) => {
        clearTimeout(timer);
        this.controlWaiters.delete(id);
        resolve(response);
      });
      try {
        this.write({ type: "control_request", request_id: id, request });
      } catch {
        clearTimeout(timer);
        this.controlWaiters.delete(id);
        resolve(undefined);
      }
    });
  }

  /** Interrupt the running turn through stream-json's control channel; resolves when the turn has ended. */
  async interrupt(timeoutMs = 1_500): Promise<boolean> {
    if (this.phase !== "turn" && this.phase !== "parked") return true;
    this.sink = undefined;
    this.dirty = true;
    const ended = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const check = setInterval(() => {
        if (this.phase === "idle" || this.phase === "closed") {
          clearTimeout(timer);
          clearInterval(check);
          resolve(true);
        }
      }, 20);
      timer.unref?.();
    });
    void this.control({ subtype: "interrupt" }, timeoutMs);
    return ended;
  }

  private handle(event: NativeOutputEvent): void {
    if (event.type === "stream_event" || event.type === "assistant") this.sessionHadOutput = true;
    const sessionId = (event as { session_id?: unknown }).session_id;
    if (typeof sessionId === "string" && sessionId) this.sessionId = sessionId;
    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          const memory = (event.memory_paths as { auto?: unknown } | undefined)?.auto;
          if (typeof memory === "string") this.projectDir = dirname(memory.replace(/\/+$/u, ""));
        }
        return;
      }
      case "stream_event": {
        const streamEvent = event as Extract<NativeOutputEvent, { type: "stream_event" }>;
        if (streamEvent.parent_tool_use_id) return;
        this.trackStream(streamEvent.event);
        return;
      }
      case "assistant": {
        const assistant = event as Extract<NativeOutputEvent, { type: "assistant" }>;
        if (assistant.parent_tool_use_id) return;
        if (assistant.uuid) this.lastAssistantUuid = assistant.uuid;
        if (assistant.message?.id) this.lastAssistantMessageId = assistant.message.id;
        const error = assistant.error ?? (assistant.message as Record<string, unknown> | undefined)?.error;
        const text = error
          ? assistant.message.content
              .filter((block) => block.type === "text")
              .map((block) => (block as { text: string }).text)
              .join("\n") || String(error)
          : undefined;
        this.sink?.onAssistant?.(assistant.message, text);
        return;
      }
      case "user": {
        const user = event as Extract<NativeOutputEvent, { type: "user" }>;
        if (user.parent_tool_use_id) return;
        const content = Array.isArray(user.message?.content) ? user.message.content : [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          if (user.uuid) this.toolResultUuids.set(block.tool_use_id, user.uuid);
          if (!this.answeredByPi.has(block.tool_use_id)) {
            this.selfAnswered.add(block.tool_use_id);
            this.dirty = true;
          }
        }
        return;
      }
      case "rate_limit_event": {
        const info = (event as { rate_limit_info?: RateLimitInfo }).rate_limit_info;
        if (info && typeof info === "object") {
          this.lastRateLimit = info;
          this.rateLimitSeq += 1;
          this.sink?.onRateLimit?.(info);
        }
        return;
      }
      case "result": {
        const result = event as NativeResult;
        const sink = this.sink;
        this.sink = undefined;
        if (this.phase === "parked") this.dirty = true;
        this.phase = "idle";
        this.lastUsed = Date.now();
        sink?.onResult(result);
        return;
      }
      case "control_response": {
        const response = (event as { response?: Record<string, unknown> }).response;
        const id = typeof response?.request_id === "string" ? response.request_id : undefined;
        if (id) this.controlWaiters.get(id)?.(response!);
        return;
      }
      case "control_request": {
        const id = (event as { request_id?: unknown }).request_id;
        if (typeof id === "string") {
          this.write({
            type: "control_response",
            response: { subtype: "error", request_id: id, error: "pi-claude does not handle this request" },
          });
        }
        return;
      }
    }
  }

  private trackStream(event: AnthropicStreamEvent): void {
    if (event.type === "message_start") {
      if (!this.sink) this.dirty = true;
      this.currentMessageId = event.message.id;
      this.currentToolUses = [];
      this.currentStop = undefined;
    } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      this.currentToolUses.push({ id: event.content_block.id, name: event.content_block.name });
    } else if (event.type === "message_delta") {
      if (event.delta.stop_reason !== undefined) this.currentStop = event.delta.stop_reason;
    }
    this.sink?.onStreamEvent(event);
    if (event.type === "message_stop" && this.currentStop === "tool_use") {
      this.pendingToolUses = this.currentToolUses;
      this.called.clear();
      this.answers.clear();
      this.phase = "parked";
      const sink = this.sink;
      this.sink = undefined;
      sink?.onToolUseStop();
    }
  }

  private onExit(code: number): void {
    const wasClosing = this.closing;
    this.phase = "closed";
    for (const waiter of this.controlWaiters.values()) waiter({ subtype: "error", error: "exited" });
    this.controlWaiters.clear();
    const sink = this.sink;
    this.sink = undefined;
    if (sink && !wasClosing) {
      const detail = this.stderrTail();
      sink.onExit(new Error(`Claude Code exited unexpectedly (code ${code})${detail ? `: ${detail}` : ""}`));
    }
    void this.bridge.close();
    void rm(this.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closing) return this.exited.then(() => undefined);
    this.closing = true;
    this.sink = undefined;
    for (const call of this.parked) call.respond({ isError: true, content: [{ type: "text", text: "Pi closed the session" }] });
    this.parked = [];
    try {
      this.child.stdin?.end();
    } catch {
      // Already closed.
    }
    killProcessTree(this.child);
    await this.exited;
    await this.bridge.close();
    await rm(this.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Synchronous best-effort kill for process exit. */
  killNow(): void {
    this.closing = true;
    killProcessTree(this.child);
  }
}

export function newUuid(): string {
  return randomUUID();
}
