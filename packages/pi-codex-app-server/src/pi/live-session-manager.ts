import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
  SessionManager,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { Thread } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Thread.js";
import type { ThreadItem } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadItem.js";
import type { ThreadLoadedListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadLoadedListParams.js";
import type { ThreadLoadedListResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadLoadedListResponse.js";
import type { ThreadStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadStartResponse.js";
import type { Turn } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Turn.js";
import type { TurnStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnStartParams.js";
import type { TurnSteerParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnSteerParams.js";
import type { TurnSteerResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnSteerResponse.js";
import type { UserInput } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/UserInput.js";
import type { JsonRpcConnection } from "../protocol/json-rpc-connection.ts";
import type { ThreadConnections } from "./thread-connections.ts";
import { PiModelCatalog } from "./model-catalog.ts";
import type { PiModelRuntime } from "./pi-model-runtime.ts";
import type { PiSessionRepository } from "./session-repository.ts";
import type { PiThreadCatalog } from "./thread-catalog.ts";

const dataUrlSchema = z
  .string()
  .regex(/^data:[^;,]+;base64,/u)
  .transform((url) => {
    const separator = url.indexOf(",");
    return {
      data: url.slice(separator + 1),
      mimeType: url.slice(5, url.indexOf(";")),
      type: "image" as const,
    };
  });
const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const loadedCursorSchema = z
  .string()
  .regex(/^pi-loaded:\d+$/u)
  .transform((cursor) => Number(cursor.slice("pi-loaded:".length)));
const toolResultTextSchema = z.union([
  z.string(),
  z.json().transform((value) => JSON.stringify(value)),
]);

const MIME_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const NO_MODELS_AVAILABLE =
  "No Pi models are available to this server. Check Pi's provider credentials and PI_CODEX_APP_SERVER_MODELS.";

interface LoadedSession {
  active?: ActiveTurn;
  completion?: Promise<void>;
  readonly session: AgentSession;
}

interface ActiveTurn {
  readonly agentItems: Map<
    number,
    Extract<ThreadItem, { type: "agentMessage" }>
  >;
  /**
   * Resolves the connection currently attached to this thread, or undefined
   * when the client has dropped its stream. Not a stored connection: the
   * ChatGPT app rotates streams mid-turn (see ThreadConnections).
   */
  readonly connection: () => JsonRpcConnection | undefined;
  readonly reasoningItems: Map<
    number,
    Extract<ThreadItem, { type: "reasoning" }>
  >;
  readonly startedAtMs: number;
  readonly threadId: string;
  readonly toolItems: Map<
    string,
    Extract<ThreadItem, { type: "dynamicToolCall" }>
  >;
  readonly turn: Turn;
  unsubscribe?: () => void;
}

const emptyTurn = (): Turn => {
  const startedAt = Date.now();
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id: randomUUID(),
    items: [],
    itemsView: "full",
    startedAt: Math.floor(startedAt / 1000),
    status: "inProgress",
  };
};

const textPrompt = (input: readonly UserInput[]): string =>
  input
    .map((part) => {
      switch (part.type) {
        case "text": {
          return part.text;
        }
        case "skill": {
          return `Use skill ${part.name} at ${part.path}`;
        }
        case "mention": {
          return `Mention ${part.name} at ${part.path}`;
        }
        case "audio":
        case "localAudio": {
          return `[Audio input: ${"url" in part ? part.url : part.path}]`;
        }
        case "image":
        case "localImage": {
          return "";
        }
        default: {
          const exhaustive: never = part;
          return exhaustive;
        }
      }
    })
    .filter(Boolean)
    .join("\n\n");

const remoteImage = async (url: string): Promise<ImageContent> => {
  const dataResult = dataUrlSchema.safeParse(url);
  if (dataResult.success) {
    return dataResult.data;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch image: HTTP ${response.status}`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0];
  if (!mimeType?.startsWith("image/")) {
    throw new Error("Image URL did not return an image content type");
  }
  return {
    data: Buffer.from(await response.arrayBuffer()).toString("base64"),
    mimeType,
    type: "image",
  };
};

const localImage = async (filePath: string): Promise<ImageContent> => {
  const mimeType = MIME_TYPES.get(path.extname(filePath).toLocaleLowerCase());
  if (!mimeType) {
    throw new Error(`Unsupported local image type: ${filePath}`);
  }
  const data = await readFile(filePath);
  return {
    data: data.toString("base64"),
    mimeType,
    type: "image",
  };
};

const images = async (input: readonly UserInput[]): Promise<ImageContent[]> => {
  const imageInputs = input.filter(
    (part): part is Extract<UserInput, { type: "image" | "localImage" }> =>
      part.type === "image" || part.type === "localImage"
  );
  return await Promise.all(
    imageInputs.map((part) =>
      part.type === "image" ? remoteImage(part.url) : localImage(part.path)
    )
  );
};

const notifyItemStarted = (active: ActiveTurn, item: ThreadItem): void => {
  active.turn.items.push(item);
  active.connection()?.notify("item/started", {
    item,
    startedAtMs: Date.now(),
    threadId: active.threadId,
    turnId: active.turn.id,
  });
};

const notifyItemCompleted = (active: ActiveTurn, item: ThreadItem): void => {
  active.connection()?.notify("item/completed", {
    completedAtMs: Date.now(),
    item,
    threadId: active.threadId,
    turnId: active.turn.id,
  });
};

const handleMessageUpdate = (
  active: ActiveTurn,
  event: Extract<AgentSessionEvent, { type: "message_update" }>
): void => {
  const update = event.assistantMessageEvent;
  if (update.type === "text_start") {
    const item = {
      delivery: null,
      id: randomUUID(),
      memoryCitation: null,
      phase: null,
      text: "",
      type: "agentMessage" as const,
    };
    active.agentItems.set(update.contentIndex, item);
    notifyItemStarted(active, item);
  } else if (update.type === "text_delta") {
    const item = active.agentItems.get(update.contentIndex);
    if (item) {
      item.text += update.delta;
      active.connection()?.notify("item/agentMessage/delta", {
        delta: update.delta,
        itemId: item.id,
        threadId: active.threadId,
        turnId: active.turn.id,
      });
    }
  } else if (update.type === "text_end") {
    const item = active.agentItems.get(update.contentIndex);
    if (item) {
      item.text = update.content;
      notifyItemCompleted(active, item);
    }
  } else if (update.type === "thinking_start") {
    const item = {
      content: [""],
      id: randomUUID(),
      summary: [],
      type: "reasoning" as const,
    };
    active.reasoningItems.set(update.contentIndex, item);
    notifyItemStarted(active, item);
  } else if (update.type === "thinking_delta") {
    const item = active.reasoningItems.get(update.contentIndex);
    if (item) {
      item.content[0] += update.delta;
      active.connection()?.notify("item/reasoning/textDelta", {
        contentIndex: 0,
        delta: update.delta,
        itemId: item.id,
        threadId: active.threadId,
        turnId: active.turn.id,
      });
    }
  } else if (update.type === "thinking_end") {
    const item = active.reasoningItems.get(update.contentIndex);
    if (item) {
      item.content[0] = update.content;
      notifyItemCompleted(active, item);
    }
  }
};

const handleToolEvent = (
  active: ActiveTurn,
  event: AgentSessionEvent
): void => {
  if (event.type === "tool_execution_start") {
    const item: Extract<ThreadItem, { type: "dynamicToolCall" }> = {
      arguments: z.json().parse(event.args),
      contentItems: null,
      durationMs: null,
      id: event.toolCallId,
      namespace: null,
      status: "inProgress",
      success: null,
      tool: event.toolName,
      type: "dynamicToolCall",
    };
    active.toolItems.set(event.toolCallId, item);
    notifyItemStarted(active, item);
  } else if (event.type === "tool_execution_end") {
    const item = active.toolItems.get(event.toolCallId);
    if (item) {
      const parsedResult = toolResultTextSchema.safeParse(event.result);
      item.status = event.isError ? "failed" : "completed";
      item.success = !event.isError;
      item.contentItems = [
        {
          text: parsedResult.success
            ? parsedResult.data
            : "[Unserializable tool result]",
          type: "inputText",
        },
      ];
      notifyItemCompleted(active, item);
    }
  }
};

const handleEvent = (active: ActiveTurn, event: AgentSessionEvent): void => {
  if (event.type === "message_update") {
    handleMessageUpdate(active, event);
  } else {
    handleToolEvent(active, event);
  }
};

export class PiLiveSessionManager {
  readonly #loaded = new Map<string, LoadedSession>();
  readonly #modelCatalog: PiModelCatalog;
  readonly #threadConnections: ThreadConnections;
  readonly #modelRuntime: PiModelRuntime;
  readonly #sessionRepository: PiSessionRepository;
  readonly #threadCatalog: PiThreadCatalog;

  constructor(options: {
    readonly modelCatalog: PiModelCatalog;
    readonly modelRuntime: PiModelRuntime;
    readonly sessionRepository: PiSessionRepository;
    readonly threadCatalog: PiThreadCatalog;
    readonly threadConnections: ThreadConnections;
  }) {
    this.#threadConnections = options.threadConnections;
    this.#modelCatalog = options.modelCatalog;
    this.#modelRuntime = options.modelRuntime;
    this.#sessionRepository = options.sessionRepository;
    this.#threadCatalog = options.threadCatalog;
  }

  close(): void {
    for (const loaded of this.#loaded.values()) {
      loaded.session.dispose();
    }
    this.#loaded.clear();
  }

  async start(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const cwd = path.resolve(params.cwd ?? process.cwd());
    // resolveReady, not resolve: a client can start a thread before the daemon
    // has finished loading extensions, and an extension-provided model would
    // otherwise look unknown.
    const model = await this.#modelCatalog.resolveReady(params.model);
    if (!model) {
      // resolveReady falls back to the default model, so reaching here means the
      // catalogue itself is empty, not that the client asked for something odd.
      throw new Error(NO_MODELS_AVAILABLE);
    }
    const sessionManager = params.ephemeral
      ? SessionManager.inMemory(cwd)
      : SessionManager.create(cwd);
    // Reuses the cwd's already-built services instead of rebuilding them (and
    // reloading every extension) per thread; see PiModelRuntime.services.
    const { session } = await createAgentSessionFromServices({
      model,
      services: await this.#modelRuntime.services(cwd),
      sessionManager,
    });
    this.#loaded.set(session.sessionId, { session });
    // The listing cache predates this thread; drop it so the client's next
    // thread/list shows what it just created.
    this.#sessionRepository.invalidate();
    const thread = await this.#threadFor(session, params.threadSource, true);
    return PiLiveSessionManager.#startResponse(session, thread);
  }

  async resume(threadId: string): Promise<LoadedSession | undefined> {
    const existing = this.#loaded.get(threadId);
    if (existing) {
      return existing;
    }
    const sessionManager = await this.#sessionRepository.load(threadId);
    if (!sessionManager) {
      return undefined;
    }
    const { session } = await createAgentSessionFromServices({
      services: await this.#modelRuntime.services(sessionManager.getCwd()),
      sessionManager,
    });
    const loaded = { session };
    this.#loaded.set(threadId, loaded);
    return loaded;
  }

  async startTurn(
    params: TurnStartParams,
    connection: JsonRpcConnection
  ): Promise<Turn> {
    const loaded = await this.resume(params.threadId);
    if (!loaded) {
      throw new Error(`Thread not found: ${params.threadId}`);
    }
    if (loaded.active || loaded.session.isStreaming) {
      throw new Error(`Thread is already running: ${params.threadId}`);
    }
    const model = params.model
      ? await this.#modelCatalog.resolveReady(params.model)
      : undefined;
    if (params.model && !model) {
      throw new Error(NO_MODELS_AVAILABLE);
    }
    if (model) {
      await loaded.session.setModel(model);
    }
    if (params.effort) {
      loaded.session.setThinkingLevel(thinkingLevelSchema.parse(params.effort));
    }
    const turn = emptyTurn();
    this.#threadConnections.attach(params.threadId, connection);
    const active: ActiveTurn = {
      agentItems: new Map(),
      connection: () => this.#threadConnections.get(params.threadId),
      reasoningItems: new Map(),
      startedAtMs: Date.now(),
      threadId: params.threadId,
      toolItems: new Map(),
      turn,
    };
    loaded.active = active;
    active.unsubscribe = loaded.session.subscribe((event) =>
      handleEvent(active, event)
    );
    const userItem: ThreadItem = {
      clientId: params.clientUserMessageId ?? null,
      content: params.input,
      id: randomUUID(),
      type: "userMessage",
    };
    active.connection()?.notify("turn/started", { threadId: params.threadId, turn });
    notifyItemStarted(active, userItem);
    notifyItemCompleted(active, userItem);
    loaded.completion = PiLiveSessionManager.#runPrompt(
      loaded,
      active,
      params.input
    );
    return turn;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const loaded = this.#loaded.get(threadId);
    if (!(loaded?.active && loaded.active.turn.id === turnId)) {
      // Nothing to stop. An interrupt that lands just after the turn finished
      // is the common case on a phone — the user taps stop while the last
      // delta is still rendering — and the caller's intent ("make sure it is
      // not running") is already satisfied. Failing it put an ERROR in the log
      // and an error on the phone for a turn that had answered correctly.
      return;
    }
    await loaded.session.abort();
  }

  loadedList(params: ThreadLoadedListParams): ThreadLoadedListResponse {
    const threadIds = [...this.#loaded.keys()];
    const offset = params.cursor ? loadedCursorSchema.parse(params.cursor) : 0;
    const limit = Math.max(params.limit ?? threadIds.length, 1);
    const data = threadIds.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor:
        nextOffset < threadIds.length ? `pi-loaded:${nextOffset}` : null,
    };
  }

  async compact(threadId: string): Promise<void> {
    const loaded = await this.resume(threadId);
    if (!loaded) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (loaded.active || loaded.session.isStreaming) {
      throw new Error(`Thread is already running: ${threadId}`);
    }
    await loaded.session.compact();
  }

  async steer(params: TurnSteerParams): Promise<TurnSteerResponse> {
    const loaded = this.#loaded.get(params.threadId);
    const active = loaded?.active;
    if (!(loaded && active && active.turn.id === params.expectedTurnId)) {
      throw new Error(`Active turn not found: ${params.expectedTurnId}`);
    }
    const userItem: ThreadItem = {
      clientId: params.clientUserMessageId ?? null,
      content: params.input,
      id: randomUUID(),
      type: "userMessage",
    };
    notifyItemStarted(active, userItem);
    await loaded.session.steer(
      textPrompt(params.input),
      await images(params.input)
    );
    notifyItemCompleted(active, userItem);
    return { turnId: active.turn.id };
  }

  static async #runPrompt(
    loaded: LoadedSession,
    active: ActiveTurn,
    input: readonly UserInput[]
  ): Promise<void> {
    try {
      await loaded.session.prompt(textPrompt(input), {
        images: await images(input),
        source: "rpc",
      });
      active.turn.status = "completed";
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Pi turn failed");
      active.turn.error = {
        additionalDetails: null,
        codexErrorInfo: null,
        message: failure.message,
      };
      active.turn.status = loaded.session.isStreaming
        ? "failed"
        : "interrupted";
    } finally {
      active.unsubscribe?.();
      active.turn.completedAt = Math.floor(Date.now() / 1000);
      active.turn.durationMs = Date.now() - active.startedAtMs;
      loaded.active = undefined;
      active.connection()?.notify("turn/completed", {
        threadId: active.threadId,
        turn: active.turn,
      });
    }
  }

  static #startResponse(
    session: AgentSession,
    thread: Thread
  ): ThreadStartResponse {
    const { model } = session;
    if (!model) {
      throw new Error("Pi did not select a model for the new thread");
    }
    return {
      activePermissionProfile: null,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: session.sessionManager.getCwd(),
      instructionSources: [],
      model: PiModelCatalog.key(model),
      modelProvider: model.provider,
      multiAgentMode: "explicitRequestOnly",
      reasoningEffort: session.thinkingLevel,
      runtimeWorkspaceRoots: [session.sessionManager.getCwd()],
      sandbox: { type: "dangerFullAccess" },
      serviceTier: null,
      thread,
    };
  }

  async #threadFor(
    session: AgentSession,
    source: ThreadStartParams["threadSource"],
    isNew = false
  ): Promise<Thread> {
    // A thread created a moment ago has no stored history worth reading, and
    // looking for it costs a scan of every session on the host: it is not in the
    // database yet, so the lookup always falls through to the full list. That
    // scan was most of the 2.3 s `thread/start` took, and the ChatGPT app gives
    // up after about four seconds and sends the prompt again in a new thread.
    const stored = isNew
      ? undefined
      : await this.#threadCatalog.read(session.sessionId, true);
    if (stored) {
      return stored;
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: "pi-0.84",
      createdAt: now,
      cwd: session.sessionManager.getCwd(),
      ephemeral: !session.sessionFile,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: session.sessionId,
      modelProvider: session.model?.provider ?? "pi",
      name: null,
      parentThreadId: null,
      path: session.sessionFile ?? null,
      preview: "",
      projectId: null,
      recencyAt: now,
      section: null,
      sectionEnteredAt: null,
      sessionId: session.sessionId,
      source: { custom: "pi" },
      status: { type: "idle" },
      threadSource: source ?? "pi",
      turns: [],
      updatedAt: now,
    };
  }
}
