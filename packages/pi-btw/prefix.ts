import { buildSessionContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** An agent transcript message: `convertToLlm` input, including Pi's system messages. */
export type TranscriptMessage = { role: string; [key: string]: unknown };

export interface Prefix {
	/** The transcript to replay ahead of the side question. */
	messages: TranscriptMessage[];
	/** The provider payload of the request `messages` came from, as this extension saw it. */
	payload?: unknown;
	source: "request" | "session";
}

/**
 * Tracks the exact transcript of the session's last model request.
 *
 * The provider caches that request's prompt, so replaying it byte for byte plus
 * one user message is what lets a side question read the cache instead of paying
 * for the whole conversation again. `context_with_system` hands over the final
 * transcript, after every `context` hook and with Pi's prompt and tool system
 * messages, and the `before_provider_request` that follows it carries the payload
 * built from it. Messages that finish after the request (the reply, tool results)
 * are kept as the tail, so an idle session replays exactly what its next request
 * would start with.
 */
export class PrefixTracker {
	private request: TranscriptMessage[] | undefined;
	private payload: unknown;
	private awaitingPayload = false;
	private tail: TranscriptMessage[] = [];

	onContext(messages: readonly TranscriptMessage[]): void {
		this.request = [...messages];
		this.payload = undefined;
		this.awaitingPayload = true;
		this.tail = [];
	}

	/** Only the request that follows a captured context counts: cache-warming replays send no context. */
	onPayload(payload: unknown): void {
		if (!this.awaitingPayload) return;
		this.payload = payload;
		this.awaitingPayload = false;
	}

	onMessageEnd(message: TranscriptMessage): void {
		if (this.request) this.tail.push(message);
	}

	reset(): void {
		this.request = undefined;
		this.payload = undefined;
		this.awaitingPayload = false;
		this.tail = [];
	}

	snapshot(): Prefix | undefined {
		if (!this.request) return undefined;
		return { messages: dropOpenToolTurn([...this.request, ...this.tail]), payload: this.payload, source: "request" };
	}
}

/** The current branch as Pi would send it, minus `context` hooks: used before any request has been seen. */
export function sessionPrefix(sessionManager: ExtensionContext["sessionManager"]): Prefix {
	const context = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId());
	return { messages: dropOpenToolTurn(context.messages as unknown as TranscriptMessage[]), source: "session" };
}

/**
 * Drop a trailing assistant turn whose tool calls are still running.
 *
 * Providers reject a tool call with no result, so a question asked mid-turn
 * replays the transcript up to the request that produced those calls.
 */
export function dropOpenToolTurn(messages: TranscriptMessage[]): TranscriptMessage[] {
	let last = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "assistant") {
			last = index;
			break;
		}
	}
	if (last < 0) return messages;
	const calls = toolCallIds(messages[last]!);
	if (calls.length === 0) return messages;
	const answered = new Set<unknown>();
	for (const message of messages.slice(last + 1)) {
		if (message.role === "toolResult") answered.add(message.toolCallId);
	}
	return calls.every((id) => answered.has(id)) ? messages : messages.slice(0, last);
}

function toolCallIds(message: TranscriptMessage): unknown[] {
	if (!Array.isArray(message.content)) return [];
	return message.content
		.filter((block): block is { type: string; id?: unknown } => isRecord(block) && block.type === "toolCall")
		.map((block) => block.id);
}

/** Keys holding the conversation itself, per API: Anthropic and Chat Completions, Responses, Gemini. */
const CONVERSATION_KEYS = ["messages", "input", "contents"];
/** Keys a side question owns: they never shift the cached prompt. */
const PER_REQUEST_KEYS = ["previous_response_id", "max_tokens", "max_output_tokens", "max_completion_tokens"];
const OWN_KEYS = new Set([...CONVERSATION_KEYS, ...PER_REQUEST_KEYS]);

/**
 * Give the side question's payload the main request's top-level shape.
 *
 * Pi runs `before_provider_request` hooks only on its own agent loop, so a direct
 * model call skips whatever other extensions rewrote: tool schemas, instructions,
 * reasoning settings. Any such difference outside the conversation moves the
 * cached prefix. Taking every other top-level field from the main request (key
 * order included) and only the conversation from this one restores parity
 * without knowing what the hooks did. Payloads for different models are left
 * alone.
 */
export function alignPayload(own: unknown, main: unknown): Record<string, unknown> | undefined {
	if (!isRecord(own) || !isRecord(main) || own.model !== main.model) return undefined;
	const aligned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(main)) {
		const next = OWN_KEYS.has(key) ? own[key] : fromMain(value, own[key]);
		if (next !== undefined) aligned[key] = next;
	}
	for (const key of OWN_KEYS) {
		if (key in own && !(key in aligned)) aligned[key] = own[key];
	}
	return aligned;
}

/**
 * A copy of the main request's value that keeps this request's live handles.
 *
 * Payloads are JSON data apart from the odd live object, such as the AbortSignal
 * Gemini carries in `config.abortSignal`. Taking the main request's would tie the
 * side question to a finished request's signal, so a live value always comes
 * from this request, and is kept even where the main request had none.
 */
function fromMain(main: unknown, own: unknown): unknown {
	if (isLive(main)) return own;
	if (Array.isArray(main)) return main.map((item, index) => fromMain(item, Array.isArray(own) ? own[index] : undefined));
	if (!isRecord(main)) return main;
	const ownRecord = isPlainObject(own) ? own : {};
	const copy: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(main)) {
		const next = fromMain(value, ownRecord[key]);
		if (next !== undefined) copy[key] = next;
	}
	for (const [key, value] of Object.entries(ownRecord)) {
		if (!(key in copy) && isLive(value)) copy[key] = value;
	}
	return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Functions and class instances: handles, not data. */
function isLive(value: unknown): boolean {
	return typeof value === "function" || (isRecord(value) && !isPlainObject(value));
}
