import { createHash, randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { API_ID, PROVIDER_ID } from "./model-catalog.ts";

export const MCP_SERVER_NAME = "pi";
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

/**
 * Pi's conversation as the model sees it: system messages removed (they go into
 * the fingerprint), failed/aborted assistant turns skipped, orphaned tool calls
 * answered with Pi's standard synthetic error, stray tool results dropped.
 * Mirrors pi-ai's own message transform so replay matches built-in providers.
 */
export function normalizeMessages(messages: readonly Message[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  let pending: { id: string; name: string }[] = [];
  let answered = new Set<string>();
  const close = () => {
    for (const call of pending) {
      if (answered.has(call.id)) continue;
      result.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: 0,
      } as ToolResultMessage);
    }
    pending = [];
    answered = new Set();
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      close();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      pending = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => ({ id: block.id, name: block.name }));
      result.push(message);
    } else if (message.role === "toolResult") {
      if (!pending.some((call) => call.id === message.toolCallId) || answered.has(message.toolCallId)) continue;
      answered.add(message.toolCallId);
      result.push(message);
    } else {
      close();
      result.push(message);
    }
  }
  close();
  return result;
}

function imageKey(block: ImageContent) {
  return { type: "image", mimeType: block.mimeType, sha: digest(block.data) };
}

function userBlocks(content: UserMessage["content"]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : imageKey(block)));
}

/** Content-only projection used for prefix hashing; ignores timestamps, usage and diagnostics. */
export function messageProjection(message: ConversationMessage): unknown {
  if (message.role === "user") return { r: "u", c: userBlocks(message.content) };
  if (message.role === "toolResult") {
    return {
      r: "t",
      id: message.toolCallId,
      err: message.isError === true,
      c: message.content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : imageKey(block))),
    };
  }
  return {
    r: "a",
    c: message.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "thinking") {
        return { type: "thinking", thinking: block.thinking, sig: block.thinkingSignature ?? "", red: block.redacted === true };
      }
      return { type: "toolCall", id: block.id, name: block.name, args: block.arguments };
    }),
  };
}

/** Rolling hash of each conversation prefix: `hashes[i]` identifies messages[0..i]. */
export function prefixHashes(messages: readonly ConversationMessage[], seed = ""): string[] {
  const hashes: string[] = [];
  let previous = digest(`pi-claude:v1:${seed}`);
  for (const message of messages) {
    previous = digest(`${previous}\n${canonicalJson(messageProjection(message))}`);
    hashes.push(previous);
  }
  return hashes;
}

export function nextPrefixHash(previous: string | undefined, message: ConversationMessage, seed = ""): string {
  const base = previous ?? digest(`pi-claude:v1:${seed}`);
  return digest(`${base}\n${canonicalJson(messageProjection(message))}`);
}

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "\uFFFD");
}

/** Anthropic tool_use ids must match ^[a-zA-Z0-9_-]+$; ids from other providers may not. */
export function nativeToolUseId(id: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/u.test(id)) return id;
  const cleaned = id.replace(/[^A-Za-z0-9_-]/gu, "_");
  return cleaned.length <= 64 && cleaned.length > 0 ? cleaned : `toolu_${digest(id).slice(0, 40)}`;
}

function nativeImage(block: ImageContent): Record<string, unknown> {
  return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
}

function nativeUserContent(content: UserMessage["content"]): unknown[] {
  if (typeof content === "string") return content ? [{ type: "text", text: sanitizeSurrogates(content) }] : [];
  return content.flatMap((block) => {
    if (block.type === "image") return [nativeImage(block)];
    return block.text ? [{ type: "text", text: sanitizeSurrogates(block.text) }] : [];
  });
}

function nativeToolResultContent(message: ToolResultMessage): unknown[] {
  return message.content.flatMap((block: TextContent | ImageContent) => {
    if (block.type === "image") return [nativeImage(block)];
    return block.text ? [{ type: "text", text: sanitizeSurrogates(block.text) }] : [];
  });
}

export function nativeToolResult(message: ToolResultMessage): Record<string, unknown> {
  const content = nativeToolResultContent(message);
  return {
    type: "tool_result",
    tool_use_id: nativeToolUseId(message.toolCallId),
    content: content.length ? content : "",
    ...(message.isError ? { is_error: true } : {}),
  };
}

/** One stdin user frame carrying a run of Pi user and tool-result messages. */
export function stdinContent(messages: readonly ConversationMessage[]): unknown[] {
  const toolResults: unknown[] = [];
  const rest: unknown[] = [];
  for (const message of messages) {
    if (message.role === "assistant") throw new Error("Internal error: assistant message in a stdin frame");
    if (message.role === "toolResult") toolResults.push(nativeToolResult(message));
    else rest.push(...nativeUserContent(message.content));
  }
  return [...toolResults, ...rest];
}

/** The MCP `tools/call` result for a parked call, carrying Pi's real tool output. */
export function mcpToolResult(message: ToolResultMessage): Record<string, unknown> {
  const content: unknown[] = message.content.map((block: TextContent | ImageContent) =>
    block.type === "image"
      ? { type: "image", data: block.data, mimeType: block.mimeType }
      : { type: "text", text: sanitizeSurrogates(block.text) },
  );
  return { content, ...(message.isError ? { isError: true } : {}) };
}

/** Thinking signatures are bound to the account and model that produced them. */
export function producedByThisProvider(message: AssistantMessage): boolean {
  return message.provider === PROVIDER_ID && message.api === API_ID;
}

export function nativeAssistantContent(message: AssistantMessage): unknown[] {
  const keepThinking = producedByThisProvider(message);
  const blocks: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim()) blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
    } else if (block.type === "thinking") {
      if (!keepThinking || !block.thinkingSignature) continue;
      if (block.redacted) blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
      else blocks.push({ type: "thinking", thinking: sanitizeSurrogates(block.thinking), signature: block.thinkingSignature });
    } else {
      blocks.push({
        type: "tool_use",
        id: nativeToolUseId(block.id),
        name: `${TOOL_PREFIX}${block.name}`,
        input: structuredClone(block.arguments),
      });
    }
  }
  return blocks;
}

export interface TranscriptEntryContext {
  sessionId: string;
  cwd: string;
  version: string;
  model: string;
}

export interface SynthesizedEntries {
  lines: Record<string, unknown>[];
  /** Claude Code uuid of the last entry written for each conversation index. */
  uuids: Map<number, string>;
  leafUuid?: string;
}

/**
 * Claude Code session entries for conversation messages it never produced
 * (another provider, a previous Pi run, an edited or compacted history).
 */
export function synthesizeEntries(
  messages: readonly ConversationMessage[],
  startIndex: number,
  parentUuid: string | null,
  context: TranscriptEntryContext,
  now = Date.now(),
): SynthesizedEntries {
  const lines: Record<string, unknown>[] = [];
  const uuids = new Map<number, string>();
  let parent = parentUuid;
  let lastAssistantUuid: string | undefined;
  const base = (uuid: string, offset: number) => ({
    parentUuid: parent,
    isSidechain: false,
    uuid,
    timestamp: new Date(now + offset).toISOString(),
    userType: "external",
    entrypoint: "sdk-cli",
    cwd: context.cwd,
    sessionId: context.sessionId,
    version: context.version,
  });
  messages.forEach((message, offset) => {
    const index = startIndex + offset;
    const uuid = randomUUID();
    if (message.role === "assistant") {
      const content = nativeAssistantContent(message);
      if (!content.length) return;
      const toolUse = content.some((block) => (block as { type: string }).type === "tool_use");
      lines.push({
        ...base(uuid, offset),
        type: "assistant",
        message: {
          model: producedByThisProvider(message) ? message.responseModel ?? message.model : context.model,
          id: producedByThisProvider(message) && message.responseId ? message.responseId : `msg_pi_${uuid.replace(/-/gu, "")}`,
          type: "message",
          role: "assistant",
          content,
          stop_reason: toolUse ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      lastAssistantUuid = uuid;
    } else if (message.role === "toolResult") {
      const result = nativeToolResult(message);
      lines.push({
        ...base(uuid, offset),
        type: "user",
        message: { role: "user", content: [result] },
        toolUseResult: result.content,
        ...(lastAssistantUuid ? { sourceToolAssistantUUID: lastAssistantUuid } : {}),
      });
    } else {
      const content = nativeUserContent(message.content);
      if (!content.length) return;
      lines.push({ ...base(uuid, offset), type: "user", message: { role: "user", content } });
    }
    parent = uuid;
    uuids.set(index, uuid);
  });
  return { lines, uuids, leafUuid: parent ?? undefined };
}

/** Walk a Claude Code session file from `leafUuid` back to its root. */
export function chainEntries(fileText: string, leafUuid: string): Record<string, unknown>[] | undefined {
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const line of fileText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry);
    } catch {
      // A torn final line is possible while Claude Code is writing.
    }
  }
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafUuid;
  while (cursor) {
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    const entry = byUuid.get(cursor);
    if (!entry) return undefined;
    chain.push(entry);
    cursor = typeof entry.parentUuid === "string" ? entry.parentUuid : null;
  }
  return chain.reverse();
}

export function retargetEntries(entries: Record<string, unknown>[], sessionId: string): Record<string, unknown>[] {
  return entries.map((entry) => ({ ...entry, sessionId }));
}
