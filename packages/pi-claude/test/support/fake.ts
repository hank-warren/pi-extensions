import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeContext,
  type AssistantMessage,
  type Message,
  type SimpleStreamOptions,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { clearReadyStatusCache } from "../../src/claude-cli.ts";
import { modelFromDiscovery } from "../../src/model-catalog.ts";
import { streamClaudeSubscription } from "../../src/stream.ts";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

/** Point the provider at the fake Claude Code and return its request log path. */
export function useFakeClaude(): { log: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const log = join(dir, "requests.jsonl");
  process.env.PI_CLAUDE_SUB_COMMAND = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_LOG = log;
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"]) delete process.env[key];
  clearReadyStatusCache();
  return { log, dir };
}

export interface FakeLogEntry {
  pid: number;
  event: string;
  args?: string[];
  thread?: string;
  historyLength?: number;
  effort?: string | null;
  tools?: Array<{ name: string; inputSchema: unknown }>;
}

export function readLog(path: string): FakeLogEntry[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLogEntry);
  } catch {
    return [];
  }
}

export const model = modelFromDiscovery({
  value: "fake",
  resolvedModel: "claude-fake-1",
  displayName: "Fake 1",
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high"],
  supportsAdaptiveThinking: true,
  supportsThinkingOff: false,
  contextWindow: 1_000_000,
});

export const tools = [
  {
    name: "lookup",
    description: "Look up a codeword.",
    parameters: {
      type: "object",
      properties: { word: { type: "string" }, note: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["word"],
    },
  },
];

export function user(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() } as Message;
}

export function toolResult(call: { id: string; name: string }, text: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: Date.now() } as ToolResultMessage;
}

export function foreignAssistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-x",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...extra,
  } as AssistantMessage;
}

export interface TurnResult {
  message: AssistantMessage;
  path?: string;
  events: string[];
}

export async function runTurn(
  messages: Message[],
  options: Partial<SimpleStreamOptions> & { abortAfterFirstDelta?: boolean } = {},
  systemPrompt = "You are a test.",
): Promise<TurnResult> {
  const controller = new AbortController();
  const stream = streamClaudeSubscription(model, normalizeContext({ systemPrompt, messages, tools: tools as never }), {
    sessionId: "pi-session-1",
    reasoning: "low",
    signal: controller.signal,
    ...options,
  });
  const events: string[] = [];
  let message: AssistantMessage | undefined;
  for await (const event of stream) {
    events.push(event.type);
    if (options.abortAfterFirstDelta && event.type === "text_delta") controller.abort();
    if (event.type === "done") message = event.message;
    if (event.type === "error") message = event.error;
  }
  const path = (message?.diagnostics?.find((item) => item.type === "claude-sub.turn")?.details as { path?: string } | undefined)?.path;
  return { message: message!, path, events };
}

export function text(message: AssistantMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
