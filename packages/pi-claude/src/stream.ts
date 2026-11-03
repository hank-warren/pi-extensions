import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describeUsageCreditsRejection, usageCreditsChargeError } from "./billing.ts";
import type { McpTool } from "./bridge.ts";
import { claudeEnvironment, readyClaude, type Env } from "./claude-cli.ts";
import { ANCHOR_DIAGNOSTIC, ClaudeSessionManager, type TurnOutcome, type TurnRequest } from "./manager.ts";
import { modelTraits } from "./model-catalog.ts";
import type { AnthropicStreamEvent, NativeContentBlock, NativeMessage, NativeUsage } from "./native-types.ts";
import { digest, normalizeMessages, prefixHashes, TOOL_PREFIX } from "./transcript.ts";

interface IndexedText {
  type: "text";
  text: string;
  nativeIndex: number;
}
interface IndexedThinking extends ThinkingContent {
  nativeIndex: number;
}
interface IndexedToolCall extends ToolCall {
  nativeIndex: number;
  partialJson: string;
}
type IndexedBlock = IndexedText | IndexedThinking | IndexedToolCall;

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapStopReason(reason: string | null | undefined): { stopReason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return { stopReason: "stop" };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return { stopReason: "error", errorMessage: "The model refused to complete the request" };
    default:
      return { stopReason: "error", errorMessage: `Unhandled Claude stop reason: ${reason ?? "missing"}` };
  }
}

function parseArguments(raw: string, fallback: ToolCall["arguments"]): ToolCall["arguments"] {
  if (!raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ToolCall["arguments"]) : fallback;
  } catch {
    return fallback;
  }
}

/** Anthropic reports full-conversation token counts even when a thread request carries only new messages. */
export function applyUsage(output: AssistantMessage, model: Model<any>, usage: Partial<NativeUsage> | undefined): void {
  if (!usage) return;
  if (typeof usage.input_tokens === "number") output.usage.input = usage.input_tokens;
  if (typeof usage.output_tokens === "number") output.usage.output = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") output.usage.cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") output.usage.cacheWrite = usage.cache_creation_input_tokens;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens;
  if (typeof oneHour === "number") output.usage.cacheWrite1h = oneHour;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  if (typeof thinking === "number") output.usage.reasoning = thinking;
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  output.usage.cost = calculateCost(model, output.usage);
}

function piToolName(nativeName: string, toolNames: Set<string>): string {
  if (!nativeName.startsWith(TOOL_PREFIX)) throw new Error(`Claude called a tool Pi does not provide: ${nativeName}`);
  const name = nativeName.slice(TOOL_PREFIX.length);
  if (!toolNames.has(name)) throw new Error(`Claude called a tool that is not available: ${name}`);
  return name;
}

/** Translates Claude Code's Anthropic stream events into Pi assistant-message events. */
export class EventTranslator {
  private readonly nativeToContent = new Map<number, number>();
  messageStarted = false;
  stopReason?: string | null;

  constructor(
    private readonly model: Model<any>,
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
    private readonly toolNames: Set<string>,
  ) {}

  event(event: AnthropicStreamEvent): void {
    switch (event.type) {
      case "message_start":
        if (this.messageStarted) throw new Error("Claude Code started a second upstream message within one turn");
        this.messageStarted = true;
        if (event.message.id) this.output.responseId = event.message.id;
        if (event.message.model) this.output.responseModel = event.message.model;
        applyUsage(this.output, this.model, event.message.usage);
        break;
      case "content_block_start":
        this.startBlock(event.index, event.content_block);
        break;
      case "content_block_delta":
        this.delta(event.index, event.delta as { type: string; [key: string]: unknown });
        break;
      case "content_block_stop":
        this.stopBlock(event.index);
        break;
      case "message_delta":
        if (event.delta.stop_reason) this.stopReason = event.delta.stop_reason;
        applyUsage(this.output, this.model, event.usage);
        break;
      case "error":
        throw new Error(event.error?.message ?? "Claude stream error");
    }
  }

  /** Claude Code's per-block assistant events carry the final tool inputs. */
  assistant(message: NativeMessage): void {
    for (const block of message.content ?? []) {
      if (block.type !== "tool_use") continue;
      const call = this.output.content.find(
        (candidate): candidate is ToolCall => candidate.type === "toolCall" && candidate.id === block.id,
      );
      if (call && block.input && typeof block.input === "object") call.arguments = block.input as ToolCall["arguments"];
    }
  }

  finish(): void {
    for (const nativeIndex of [...this.nativeToContent.keys()]) this.stopBlock(nativeIndex);
    this.output.rawStopReason = this.stopReason ?? undefined;
    const mapped = mapStopReason(this.stopReason);
    this.output.stopReason = mapped.stopReason;
    this.output.errorMessage = mapped.errorMessage;
  }

  private startBlock(nativeIndex: number, native: NativeContentBlock): void {
    const contentIndex = this.output.content.length;
    if (native.type === "text") {
      this.nativeToContent.set(nativeIndex, contentIndex);
      this.output.content.push({ type: "text", text: native.text ?? "", nativeIndex } as IndexedText);
      this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    } else if (native.type === "thinking") {
      this.nativeToContent.set(nativeIndex, contentIndex);
      this.output.content.push({
        type: "thinking",
        thinking: native.thinking ?? "",
        thinkingSignature: native.signature ?? "",
        nativeIndex,
      } as IndexedThinking);
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (native.type === "redacted_thinking") {
      this.nativeToContent.set(nativeIndex, contentIndex);
      this.output.content.push({
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: native.data,
        redacted: true,
        nativeIndex,
      } as IndexedThinking);
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (native.type === "tool_use") {
      this.nativeToContent.set(nativeIndex, contentIndex);
      this.output.content.push({
        type: "toolCall",
        id: native.id,
        name: piToolName(native.name, this.toolNames),
        arguments: (native.input ?? {}) as ToolCall["arguments"],
        nativeIndex,
        partialJson: "",
      } as IndexedToolCall);
      this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
    }
  }

  private delta(nativeIndex: number, delta: { type: string; [key: string]: unknown }): void {
    const contentIndex = this.nativeToContent.get(nativeIndex);
    if (contentIndex === undefined) return;
    const block = this.output.content[contentIndex] as IndexedBlock | undefined;
    if (!block) return;
    if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") {
      block.text += delta.text;
      this.stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: this.output });
    } else if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") {
      block.thinking += delta.thinking;
      this.stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: this.output });
    } else if (delta.type === "signature_delta" && block.type === "thinking" && typeof delta.signature === "string") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
    } else if (delta.type === "input_json_delta" && block.type === "toolCall" && typeof delta.partial_json === "string") {
      block.partialJson += delta.partial_json;
      block.arguments = parseArguments(block.partialJson, block.arguments);
      this.stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: this.output });
    }
  }

  private stopBlock(nativeIndex: number): void {
    const contentIndex = this.nativeToContent.get(nativeIndex);
    if (contentIndex === undefined) return;
    this.nativeToContent.delete(nativeIndex);
    const block = this.output.content[contentIndex] as IndexedBlock | undefined;
    if (!block) return;
    delete (block as Partial<IndexedBlock>).nativeIndex;
    if (block.type === "text") {
      this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
    } else if (block.type === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
    } else {
      block.arguments = parseArguments(block.partialJson, block.arguments);
      delete (block as Partial<IndexedToolCall>).partialJson;
      this.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.output });
    }
  }
}

export function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const usageCredits = describeUsageCreditsRejection(message);
  if (usageCredits) return usageCredits;
  if (/prompt is too long|context(?:_| )length|context window exceeded|too many input tokens/iu.test(message)) {
    return `context_length_exceeded: ${message}`;
  }
  return message;
}

/**
 * Tool schemas go to Claude Code as MCP tool definitions. They are kept intact
 * except at the top level, where the Messages API requires a plain object
 * schema without composition keywords.
 */
export function mcpInputSchema(schema: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(schema ?? {})) as Record<string, unknown>;
  for (const key of ["oneOf", "anyOf", "allOf"]) delete copy[key];
  if (copy.type !== "object") copy.type = "object";
  if (!copy.properties || typeof copy.properties !== "object") copy.properties = {};
  return copy;
}

export function mcpTools(tools: Tool[]): McpTool[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (!/^[A-Za-z0-9_-]{1,55}$/u.test(tool.name) || names.has(tool.name)) {
      throw new Error(`Tool name ${JSON.stringify(tool.name)} cannot be offered to Claude Code (unique, ASCII, at most 55 characters)`);
    }
    names.add(tool.name);
    return { name: tool.name, description: tool.description, inputSchema: mcpInputSchema(tool.parameters) };
  });
}

/** Map Pi's thinking level to Claude Code's `--effort` and thinking switch. */
export function effortFor(model: Model<any>, reasoning: SimpleStreamOptions["reasoning"]): { effort?: string; thinkingOff: boolean } {
  const traits = modelTraits(model.id);
  if (!reasoning) return { thinkingOff: traits.supportsThinkingOff };
  const mapped = model.thinkingLevelMap?.[reasoning];
  const level = typeof mapped === "string" ? mapped : reasoning === "minimal" ? "low" : reasoning;
  if (!traits.effortLevels.length) return { thinkingOff: false };
  return { effort: traits.effortLevels.includes(level) ? level : traits.effortLevels.at(-1), thinkingOff: false };
}

export const manager = new ClaudeSessionManager();

export interface PreparedRequest {
  request: TurnRequest;
  toolNames: Set<string>;
}

export async function prepareRequest(
  model: Model<any>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  cwd = process.cwd(),
): Promise<PreparedRequest> {
  const env: Env = { ...(options?.env as Env | undefined) };
  const { effort, thinkingOff } = effortFor(model, options?.reasoning);
  const maxOutputTokens =
    options?.maxTokens !== undefined && options.maxTokens < model.maxTokens ? options.maxTokens : undefined;
  const claudeEnv = claudeEnvironment(env, { maxOutputTokens, thinkingOff });
  const ready = await readyClaude(env, options?.signal);
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  const tools = mcpTools(getCurrentTools(context.messages));
  const messages = normalizeMessages(context.messages);
  const route = modelTraits(model.id).route;
  const fingerprint = digest({
    command: ready.command,
    cwd,
    route,
    effort,
    thinkingOff,
    maxOutputTokens,
    systemPrompt,
    tools,
    configDir: claudeEnv.CLAUDE_CONFIG_DIR ?? null,
    threads: claudeEnv.CLAUDE_CODE_TETHER_LIVE ?? null,
  });
  return {
    toolNames: new Set(tools.map((tool) => tool.name)),
    request: {
      piSessionId: options?.cacheRetention === "none" ? undefined : options?.sessionId,
      messages,
      hashes: prefixHashes(messages),
      claudeVersion: ready.version,
      signal: options?.signal,
      spec: {
        command: ready.command,
        cwd,
        env: claudeEnv,
        model: route,
        effort,
        systemPrompt,
        tools,
        fingerprint,
      },
    },
  };
}

export function streamClaudeSubscription(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  void (async () => {
    let prepared: PreparedRequest | undefined;
    let outcome: TurnOutcome | undefined;
    try {
      prepared = await prepareRequest(model, context, options);
      await options?.onPayload?.(
        { kind: "claude-code-stdin", model: prepared.request.spec.model, effort: prepared.request.spec.effort },
        model,
      );
      const translator = new EventTranslator(model, output, stream, prepared.toolNames);
      stream.push({ type: "start", partial: output });
      outcome = await manager.run(prepared.request, {
        onStreamEvent: (event) => {
          void options?.onProviderStreamEvent?.(event, model);
          translator.event(event);
        },
        onAssistant: (message) => translator.assistant(message),
      });
      if (!translator.messageStarted) {
        const detail = outcome.assistantError ?? outcome.result?.result ?? outcome.result?.subtype ?? "no response";
        throw new Error(`Claude Code returned no model response: ${detail}`);
      }
      translator.finish();
      if (outcome.end === "result" && (outcome.result?.is_error || outcome.result?.subtype !== "success")) {
        if (output.stopReason !== "error") {
          output.stopReason = "error";
          output.errorMessage = outcome.assistantError ?? outcome.result?.result ?? `Claude Code request failed: ${outcome.result?.subtype}`;
        }
      }
      if (outcome.rateLimit) {
        output.diagnostics = [
          ...(output.diagnostics ?? []),
          { type: "claude-sub.rate-limit", timestamp: Date.now(), details: outcome.rateLimit as never },
        ];
      }
      output.diagnostics = [
        ...(output.diagnostics ?? []),
        {
          type: "claude-sub.turn",
          timestamp: Date.now(),
          details: { path: outcome.path, claudeSessionId: outcome.claudeSessionId ?? null, ttftMs: outcome.ttftMs ?? null },
        },
      ];
      output.providerThinkingLevel = prepared.request.spec.effort;
      if (outcome.rateLimit?.isUsingOverage === true) throw usageCreditsChargeError(outcome.rateLimit);
      if (output.stopReason === "error" || output.stopReason === "pending") {
        throw new Error(output.errorMessage || `Claude ended with ${output.stopReason}`);
      }
      const anchor = manager.commit(prepared.request, outcome, output, true);
      if (anchor) {
        output.diagnostics = [
          ...(output.diagnostics ?? []),
          { type: ANCHOR_DIAGNOSTIC, timestamp: Date.now(), details: anchor as never },
        ];
      }
      manager.recordTurn({
        path: outcome.path,
        model: model.id,
        claudeSessionId: outcome.claudeSessionId,
        ttftMs: outcome.ttftMs,
        at: Date.now(),
        usage: output.usage,
      });
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      if (prepared && outcome) manager.commit(prepared.request, outcome, undefined, false);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = normalizeError(error);
      for (const block of output.content) {
        delete (block as Partial<IndexedBlock>).nativeIndex;
        delete (block as Partial<IndexedToolCall>).partialJson;
      }
      manager.recordTurn({
        path: outcome?.path ?? "fresh",
        model: model.id,
        claudeSessionId: outcome?.claudeSessionId,
        ttftMs: outcome?.ttftMs,
        at: Date.now(),
        error: output.errorMessage,
      });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
