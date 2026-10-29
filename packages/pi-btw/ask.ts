import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { alignPayload, type Prefix, type TranscriptMessage } from "./prefix.ts";

/** What `ctx.modelRegistry.streamSimple` (pi 0.86+) needs from this extension. */
export type StreamSimple = (model: unknown, context: { messages: unknown[] }, options: Record<string, unknown>) => AssistantStream;

export interface AssistantStream extends AsyncIterable<StreamEvent> {
	result(): Promise<AssistantResult>;
}

export type StreamEvent = { type: string; delta?: string; toolCall?: { name?: string } };

export interface AssistantResult {
	stopReason: string;
	errorMessage?: string;
	content?: unknown[];
	usage?: Usage;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total?: number };
}

export interface AskOptions {
	streamSimple: StreamSimple;
	model: { provider: string; id: string };
	prefix: Prefix;
	question: string;
	sessionId: string;
	thinkingLevel: string;
	thinkingBudgets?: unknown;
	blockImages?: boolean;
	signal: AbortSignal;
	onProgress(progress: Progress): void;
}

export interface Progress {
	answer: string;
	thinking: boolean;
}

export interface Answer {
	answer: string;
	stopReason: string;
	errorMessage?: string;
	toolCalls: string[];
	usage?: Usage;
	durationMs: number;
}

/** The model-facing frame around the question. */
export const BTW_REMINDER = [
	"<system-reminder>",
	"The user is asking a quick side question with /btw. Answer only this question, directly and concisely, from what is already in this conversation.",
	"Do not call tools: this reply cannot run them, and any tool call is discarded.",
	"Do not continue or change the main task here. This exchange is not added to the conversation, and the main task picks up where it left off.",
	"</system-reminder>",
].join("\n");

/** Pi's own placeholder when `images.blockImages` is on; the replay must match it. */
const IMAGE_PLACEHOLDER = "Image reading is disabled.";

export function resolveStreamSimple(modelRegistry: unknown): StreamSimple | undefined {
	const registry = modelRegistry as { streamSimple?: unknown } | null | undefined;
	const streamSimple = registry?.streamSimple;
	return typeof streamSimple === "function" ? (streamSimple.bind(registry) as StreamSimple) : undefined;
}

export function questionMessage(question: string): TranscriptMessage {
	return { role: "user", content: [{ type: "text", text: `${BTW_REMINDER}\n\n${question}` }], timestamp: Date.now() };
}

/**
 * Ask the side question against the replayed prefix.
 *
 * Everything that shapes the cached prompt matches the agent loop's request:
 * the same transcript and conversion, the session id providers key their cache
 * routing on, the same reasoning level and budgets, and the main request's
 * top-level payload fields. The transport is pinned to SSE so a WebSocket
 * provider's connection-scoped continuation stays the main session's.
 */
export async function ask(options: AskOptions): Promise<Answer> {
	const started = Date.now();
	let llmMessages = convertToLlm(options.prefix.messages as never) as unknown as TranscriptMessage[];
	if (options.blockImages) llmMessages = blockImages(llmMessages);
	const messages = [...llmMessages, questionMessage(options.question)];
	const mainPayload = options.prefix.payload;

	const stream = options.streamSimple(options.model, { messages }, {
		sessionId: options.sessionId,
		reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel,
		...(options.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
		transport: "sse",
		signal: options.signal,
		...(mainPayload ? { onPayload: (payload: unknown) => alignPayload(payload, mainPayload) } : {}),
	});

	let answer = "";
	let thinking = false;
	const toolCalls: string[] = [];
	for await (const event of stream) {
		if (event.type === "text_delta" && event.delta) {
			answer += event.delta;
			options.onProgress({ answer, thinking });
		} else if (event.type === "thinking_delta" && !thinking) {
			thinking = true;
			options.onProgress({ answer, thinking });
		} else if (event.type === "toolcall_end" && event.toolCall?.name) {
			toolCalls.push(event.toolCall.name);
		}
	}
	const result = await stream.result();
	return {
		answer: textOf(result) || answer,
		stopReason: result.stopReason,
		...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
		toolCalls,
		...(result.usage ? { usage: result.usage } : {}),
		durationMs: Date.now() - started,
	};
}

function textOf(result: AssistantResult): string {
	return (result.content ?? [])
		.filter((block): block is { type: "text"; text: string } => isText(block))
		.map((block) => block.text)
		.join("");
}

function isText(block: unknown): block is { type: "text"; text: string } {
	return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
		&& typeof (block as { text?: unknown }).text === "string";
}

/** Mirror of Pi's `convertToLlmWithBlockImages`, so a session that blocks images replays the same bytes. */
export function blockImages(messages: TranscriptMessage[]): TranscriptMessage[] {
	return messages.map((message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
		const content = message.content as Array<{ type?: unknown; text?: unknown }>;
		if (!content.some((block) => block?.type === "image")) return message;
		const replaced = content
			.map((block) => (block?.type === "image" ? { type: "text", text: IMAGE_PLACEHOLDER } : block))
			.filter((block, index, all) => !(
				block.type === "text" && block.text === IMAGE_PLACEHOLDER && index > 0
				&& all[index - 1]?.type === "text" && all[index - 1]?.text === IMAGE_PLACEHOLDER
			));
		return { ...message, content: replaced };
	});
}
