import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { RateLimitInfo } from "./billing.ts";
import type { McpCallResult } from "./bridge.ts";
import { registerCreatedSession } from "./cleanup.ts";
import type { AnthropicStreamEvent, NativeMessage, NativeResult } from "./native-types.ts";
import {
  chainEntries,
  mcpToolResult,
  nextPrefixHash,
  retargetEntries,
  stdinContent,
  synthesizeEntries,
  type ConversationMessage,
} from "./transcript.ts";
import { ClaudeWorker, type LaunchSpec, type TurnSink } from "./worker.ts";

/** How a Pi turn reached Claude Code. */
export type TurnPath = "fresh" | "continue" | "tool-results" | "fork" | "synth";

export interface TurnRequest {
  /** Pi session id; requests without one get a one-shot worker. */
  piSessionId?: string;
  messages: ConversationMessage[];
  hashes: string[];
  spec: Omit<LaunchSpec, "resume" | "sessionId">;
  /** Claude Code version written into synthesized transcript entries. */
  claudeVersion: string;
  signal?: AbortSignal;
}

export interface TurnHandlers {
  onStreamEvent(event: AnthropicStreamEvent): void;
  onAssistant?(message: NativeMessage, error: string | undefined): void;
}

export interface TurnOutcome {
  path: TurnPath;
  /** "toolUse": the message stopped for tools and Claude Code is parked on them. */
  end: "toolUse" | "result";
  result?: NativeResult;
  rateLimit?: RateLimitInfo;
  assistantError?: string;
  claudeSessionId?: string;
  /** Milliseconds from the request to Claude Code's first streamed content. */
  ttftMs?: number;
  /** The worker that produced this turn, for commit(). */
  worker: ClaudeWorker;
  retained: boolean;
}

export interface TurnRecord {
  path: TurnPath;
  model: string;
  claudeSessionId?: string;
  ttftMs?: number;
  at: number;
  usage?: AssistantMessage["usage"];
  error?: string;
}

interface Anchor {
  sessionId: string;
  uuid: string;
}

const MAX_ANCHORS = 20_000;
export const IDLE_CLOSE_MS = 15 * 60 * 1_000;
export const PARKED_CLOSE_MS = 2 * 60 * 60 * 1_000;
export const MAX_WORKERS = 4;
const RATE_LIMIT_GRACE_MS = 1_000;

/** Claude Code could not resume the session a fork pointed at. */
class ForkUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    cause: unknown,
  ) {
    super(`Claude Code could not resume session ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/** Anchor persisted on an assistant message so a later Pi process can fork at it. */
export interface PersistedAnchor {
  v: 1;
  hash: string;
  sessionId: string;
  uuid: string;
}

export const ANCHOR_DIAGNOSTIC = "claude-sub.anchor";

class PiSession {
  /** Conversation prefix hash -> the Claude Code transcript entry that ends that prefix. */
  readonly anchors = new Map<string, Anchor>();
  worker?: ClaudeWorker;
  idleTimer?: NodeJS.Timeout;

  constructor(readonly id: string) {}

  anchor(hash: string, anchor: Anchor): void {
    this.anchors.delete(hash);
    this.anchors.set(hash, anchor);
    if (this.anchors.size > MAX_ANCHORS) this.anchors.delete(this.anchors.keys().next().value!);
  }
}

/** Default Claude Code projects directory for a cwd when no worker has reported it yet. */
export function defaultProjectDir(cwd: string, env: Record<string, string | undefined>): string {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(base, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
}

/**
 * Keeps one long-lived Claude Code worker per Pi session and decides, for each
 * Pi request, whether to continue it, answer its parked tool calls, fork its
 * transcript at the last shared entry, or synthesize history it never saw.
 */
export class ClaudeSessionManager {
  private readonly sessions = new Map<string, PiSession>();
  private readonly projectDirs = new Map<string, string>();
  readonly history: TurnRecord[] = [];
  private shuttingDown = false;
  private readonly startWorker: (spec: LaunchSpec) => Promise<ClaudeWorker>;

  constructor(options: { startWorker?: (spec: LaunchSpec) => Promise<ClaudeWorker> } = {}) {
    this.startWorker = options.startWorker ?? ((spec) => ClaudeWorker.start(spec));
  }

  workers(): ClaudeWorker[] {
    return [...this.sessions.values()].flatMap((session) => (session.worker ? [session.worker] : []));
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private session(id: string): PiSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = new PiSession(id);
      this.sessions.set(id, session);
    }
    return session;
  }

  /** Run one Pi turn. Resolves when the upstream message has ended (stop for tools, or Claude Code's result). */
  async run(request: TurnRequest, handlers: TurnHandlers): Promise<TurnOutcome> {
    if (this.shuttingDown) throw new Error("Pi is shutting down");
    request.signal?.throwIfAborted();
    const started = Date.now();
    const { messages, hashes } = request;
    const n = messages.length;
    if (!n || messages[n - 1]!.role === "assistant") {
      throw new Error("Claude conversation must end with a user message or tool results");
    }
    const session = request.piSessionId ? this.session(request.piSessionId) : undefined;
    if (session) this.importAnchors(session, request);
    const live = session?.worker;
    const liveBusy = !!live && live.phase === "turn";
    if (session) this.clearIdle(session);

    // a/b: continue the live worker when Pi's context extends exactly what it has seen.
    if (session && live && !liveBusy && live.isAlive() && !live.dirty && live.spec.fingerprint === request.spec.fingerprint) {
      const k = live.tipHash ? hashes.lastIndexOf(live.tipHash, n - 2) : -1;
      if (k >= 0) {
        const rest = messages.slice(k + 1);
        if (live.phase === "parked") {
          const results = this.parkedAnswers(live, rest);
          if (results && live.toolCallsIntact()) {
            return this.drive(request, session, live, "tool-results", started, handlers, (sink) => {
              live.answerToolCalls(results, sink);
            }, (worker) => {
              rest.forEach((message, offset) => {
                const uuid = worker.toolResultUuids.get((message as ToolResultMessage).toolCallId);
                if (uuid && worker.sessionId) session.anchor(hashes[k + 1 + offset]!, { sessionId: worker.sessionId, uuid });
              });
            });
          }
        } else if (live.phase === "idle" && rest.every((message) => message.role === "user")) {
          return this.sendFrame(request, session, live, "continue", rest, started, handlers);
        }
      }
    }

    // c/d: a new worker for this request, forked or synthesized from what Claude Code has stored.
    if (session && live && !liveBusy) {
      session.worker = undefined;
      await live.close();
    }
    const retained = !!session && !liveBusy;
    try {
      return await this.launch(request, session, retained, started, handlers);
    } catch (error) {
      // A fork whose Claude Code session file is gone (cleaned up, other machine) fails before
      // streaming anything: forget anchors into that session and plan again.
      if (!(error instanceof ForkUnavailableError) || !session) throw error;
      for (const [hash, anchor] of session.anchors) {
        if (anchor.sessionId === error.sessionId) session.anchors.delete(hash);
      }
      return this.launch(request, session, retained, started, handlers);
    }
  }

  private async launch(
    request: TurnRequest,
    session: PiSession | undefined,
    retained: boolean,
    started: number,
    handlers: TurnHandlers,
  ): Promise<TurnOutcome> {
    const plan = await this.planLaunch(request, session);
    if (retained) await this.makeRoom(session!);
    request.signal?.throwIfAborted();
    const worker = await this.startWorker({ ...request.spec, ...plan.launch });
    if (retained) session!.worker = worker;
    if (plan.createdSessionId && plan.projectDir) {
      void registerCreatedSession(plan.projectDir, plan.createdSessionId).catch(() => undefined);
    }
    let streamed = false;
    try {
      const outcome = await this.sendFrame(
        request,
        session,
        worker,
        plan.path,
        request.messages.slice(plan.sendFrom),
        started,
        {
          ...handlers,
          onStreamEvent: (event) => {
            streamed = true;
            handlers.onStreamEvent(event);
          },
        },
        plan.synthesized,
      );
      if (plan.path === "fork" && !streamed && outcome.result?.is_error && !worker.sessionHadOutput) {
        throw new Error(outcome.result.result ?? outcome.result.subtype ?? "resume failed");
      }
      if (plan.path === "fork" && worker.sessionId && worker.projectDir) {
        void registerCreatedSession(worker.projectDir, worker.sessionId).catch(() => undefined);
      }
      return { ...outcome, retained };
    } catch (error) {
      const resumeFailed = !worker.isAlive() || worker.phase === "idle";
      if (plan.path === "fork" && !streamed && !request.signal?.aborted && !worker.sessionHadOutput && resumeFailed) {
        if (session?.worker === worker) session.worker = undefined;
        await worker.close();
        throw new ForkUnavailableError(plan.launch.resume!.sessionId, error);
      }
      throw error;
    }
  }

  /** Adopt anchors stored on assistant messages by an earlier Pi process, when their prefix still matches. */
  private importAnchors(session: PiSession, request: TurnRequest): void {
    request.messages.forEach((message, index) => {
      if (message.role !== "assistant") return;
      const hash = request.hashes[index]!;
      if (session.anchors.has(hash)) return;
      const details = message.diagnostics?.find((item) => item.type === ANCHOR_DIAGNOSTIC)?.details as
        | Partial<PersistedAnchor>
        | undefined;
      if (details?.v !== 1 || details.hash !== hash) return;
      if (typeof details.sessionId !== "string" || typeof details.uuid !== "string") return;
      session.anchor(hash, { sessionId: details.sessionId, uuid: details.uuid });
    });
  }

  /** Tool results for exactly the calls the live worker is parked on, keyed by tool_use id. */
  private parkedAnswers(worker: ClaudeWorker, rest: ConversationMessage[]): Map<string, McpCallResult> | undefined {
    if (!rest.length || rest.some((message) => message.role !== "toolResult")) return undefined;
    const ids = worker.pendingToolUses.map((call) => call.id);
    if (rest.length !== ids.length) return undefined;
    const results = new Map<string, McpCallResult>();
    for (const message of rest as ToolResultMessage[]) {
      if (!ids.includes(message.toolCallId) || results.has(message.toolCallId)) return undefined;
      results.set(message.toolCallId, mcpToolResult(message) as unknown as McpCallResult);
    }
    return results;
  }

  private async planLaunch(
    request: TurnRequest,
    session: PiSession | undefined,
  ): Promise<{
    path: TurnPath;
    launch: Pick<LaunchSpec, "resume" | "sessionId">;
    sendFrom: number;
    projectDir?: string;
    createdSessionId?: string;
    synthesized?: Map<number, string>;
  }> {
    const { messages, hashes } = request;
    const n = messages.length;
    let lastAssistant = -1;
    for (let index = n - 1; index >= 0; index--) {
      if (messages[index]!.role === "assistant") {
        lastAssistant = index;
        break;
      }
    }
    let j = -1;
    if (session) {
      for (let index = n - 2; index >= 0; index--) {
        if (session.anchors.has(hashes[index]!)) {
          j = index;
          break;
        }
      }
    }
    if (j >= 0 && j >= lastAssistant) {
      const anchor = session!.anchors.get(hashes[j]!)!;
      return {
        path: "fork",
        launch: { resume: { sessionId: anchor.sessionId, at: anchor.uuid, fork: true } },
        sendFrom: j + 1,
      };
    }
    if (lastAssistant < 0) {
      const sessionId = randomUUID();
      return {
        path: "fresh",
        launch: { sessionId },
        sendFrom: 0,
        createdSessionId: sessionId,
        projectDir: this.projectDir(request),
      };
    }
    // Claude Code never saw some of this history: write it as a transcript and resume that.
    const projectDir = this.projectDir(request);
    const sessionId = randomUUID();
    let lines: Record<string, unknown>[] = [];
    let start = 0;
    let parent: string | null = null;
    if (j >= 0) {
      const anchor = session!.anchors.get(hashes[j]!)!;
      try {
        const text = await readFile(join(projectDir, `${anchor.sessionId}.jsonl`), "utf8");
        const chain = chainEntries(text, anchor.uuid);
        if (chain?.length) {
          lines = retargetEntries(chain, sessionId);
          start = j + 1;
          parent = anchor.uuid;
        }
      } catch {
        // Fall back to synthesizing everything.
      }
    }
    const synthesized = synthesizeEntries(messages.slice(start, lastAssistant + 1), start, parent, {
      sessionId,
      cwd: request.spec.cwd,
      version: request.claudeVersion,
      model: request.spec.model,
    });
    lines.push(...synthesized.lines);
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
      mode: 0o600,
    });
    return {
      path: "synth",
      launch: { resume: { sessionId, fork: false } },
      sendFrom: lastAssistant + 1,
      projectDir,
      createdSessionId: sessionId,
      synthesized: synthesized.uuids,
    };
  }

  private projectDir(request: TurnRequest): string {
    return this.projectDirs.get(request.spec.cwd) ?? defaultProjectDir(request.spec.cwd, request.spec.env);
  }

  private sendFrame(
    request: TurnRequest,
    session: PiSession | undefined,
    worker: ClaudeWorker,
    path: TurnPath,
    frame: ConversationMessage[],
    started: number,
    handlers: TurnHandlers,
    synthesized?: Map<number, string>,
  ): Promise<TurnOutcome> {
    const uuid = randomUUID();
    const content = stdinContent(frame);
    if (!content.length) throw new Error("Nothing to send to Claude: the new message is empty");
    const lastIndex = request.messages.length - 1;
    return this.drive(
      request,
      session,
      worker,
      path,
      started,
      handlers,
      (sink) => worker.startTurn(content, uuid, sink),
      (live) => {
        if (!session || !live.sessionId) return;
        for (const [index, entryUuid] of synthesized ?? []) {
          session.anchor(request.hashes[index]!, { sessionId: live.sessionId, uuid: entryUuid });
        }
        session.anchor(request.hashes[lastIndex]!, { sessionId: live.sessionId, uuid });
      },
    );
  }

  private drive(
    request: TurnRequest,
    session: PiSession | undefined,
    worker: ClaudeWorker,
    path: TurnPath,
    started: number,
    handlers: TurnHandlers,
    begin: (sink: TurnSink) => void,
    onFirstMessage: (worker: ClaudeWorker) => void,
  ): Promise<TurnOutcome> {
    const rateLimitSeq = worker.rateLimitSeq;
    return new Promise<TurnOutcome>((resolve, reject) => {
      let settled = false;
      let ttftMs: number | undefined;
      let anchored = false;
      let assistantError: string | undefined;
      const anchorOnce = () => {
        if (anchored) return;
        anchored = true;
        onFirstMessage(worker);
        if (worker.projectDir) this.projectDirs.set(request.spec.cwd, worker.projectDir);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const outcome = (end: TurnOutcome["end"], result?: NativeResult): TurnOutcome => ({
        path,
        end,
        result,
        rateLimit: worker.rateLimitSeq !== rateLimitSeq ? worker.lastRateLimit : undefined,
        assistantError,
        claudeSessionId: worker.sessionId,
        ttftMs,
        worker,
        retained: !!session && session.worker === worker,
      });
      const onAbort = () => {
        finish(() => {
          if (session?.worker === worker) session.worker = undefined;
          void (async () => {
            await worker.interrupt();
            await worker.close();
          })();
          reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("Request was aborted"));
        });
      };
      const sink: TurnSink = {
        onStreamEvent: (event) => {
          if (event.type === "message_start") anchorOnce();
          if (ttftMs === undefined && event.type === "content_block_delta") ttftMs = Date.now() - started;
          handlers.onStreamEvent(event);
        },
        onAssistant: (message, error) => {
          if (error !== undefined) assistantError = error;
          handlers.onAssistant?.(message, error);
        },
        onToolUseStop: () => {
          // Claude Code reports the plan-limit status just after message_stop; give it a moment.
          const deadline = Date.now() + RATE_LIMIT_GRACE_MS;
          const toolCallSeq = worker.toolCallSeq;
          const wait = () => {
            if (
              worker.rateLimitSeq !== rateLimitSeq ||
              worker.toolCallSeq !== toolCallSeq ||
              Date.now() >= deadline ||
              !worker.isAlive()
            ) {
              finish(() => resolve(outcome("toolUse")));
            } else setTimeout(wait, 10);
          };
          wait();
        },
        onResult: (result) => {
          if (result.is_error !== true && result.subtype === "success") anchorOnce();
          finish(() => resolve(outcome("result", result)));
        },
        onExit: (error) => finish(() => reject(error)),
      };
      if (request.signal?.aborted) return onAbort();
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        begin(sink);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  /**
   * Record the assistant message Pi will store for this turn, so the next
   * request can continue, fork at it, or answer its parked tool calls.
   */
  commit(
    request: TurnRequest,
    outcome: TurnOutcome,
    message: AssistantMessage | undefined,
    ok: boolean,
  ): PersistedAnchor | undefined {
    const worker = outcome.worker;
    const session = request.piSessionId ? this.sessions.get(request.piSessionId) : undefined;
    const retainedHere = !!session && session.worker === worker;
    if (!ok || !message) {
      if (retainedHere) {
        session!.worker = undefined;
        void worker.close();
      } else if (!outcome.retained) void worker.close();
      return undefined;
    }
    const hash = nextPrefixHash(request.hashes.at(-1), message);
    let anchor: PersistedAnchor | undefined;
    if (worker.sessionId && worker.lastAssistantUuid) {
      anchor = { v: 1, hash, sessionId: worker.sessionId, uuid: worker.lastAssistantUuid };
      session?.anchor(hash, { sessionId: anchor.sessionId, uuid: anchor.uuid });
    }
    worker.tipHash = hash;
    if (!retainedHere) void worker.close();
    else this.armIdle(session!);
    return anchor;
  }

  private clearIdle(session: PiSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  private armIdle(session: PiSession): void {
    this.clearIdle(session);
    const worker = session.worker;
    if (!worker) return;
    const delay = worker.phase === "parked" ? PARKED_CLOSE_MS : IDLE_CLOSE_MS;
    session.idleTimer = setTimeout(() => {
      if (session.worker !== worker || worker.phase === "turn") return;
      session.worker = undefined;
      void worker.close();
    }, delay);
    session.idleTimer.unref?.();
  }

  /** Bound live workers: close the least recently used idle ones belonging to other sessions. */
  private async makeRoom(current: PiSession): Promise<void> {
    const others = [...this.sessions.values()].filter((session) => session !== current && session.worker);
    let live = others.length + (current.worker ? 1 : 0);
    const victims = others
      .filter((session) => session.worker!.phase !== "turn")
      .sort((a, b) => {
        const parkedA = a.worker!.phase === "parked" ? 1 : 0;
        const parkedB = b.worker!.phase === "parked" ? 1 : 0;
        return parkedA - parkedB || a.worker!.lastUsed - b.worker!.lastUsed;
      });
    while (live >= MAX_WORKERS && victims.length) {
      const victim = victims.shift()!;
      const worker = victim.worker!;
      victim.worker = undefined;
      this.clearIdle(victim);
      await worker.close();
      live -= 1;
    }
  }

  recordTurn(record: TurnRecord): void {
    this.history.push(record);
    if (this.history.length > 50) this.history.shift();
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.clearIdle(session);
    await session.worker?.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      sessions.map(async (session) => {
        this.clearIdle(session);
        await session.worker?.close();
      }),
    );
  }

  /** Synchronous kill used from process exit handlers. */
  killAll(): void {
    this.shuttingDown = true;
    for (const session of this.sessions.values()) session.worker?.killNow();
  }
}
