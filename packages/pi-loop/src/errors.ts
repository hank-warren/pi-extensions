/**
 * Classification of an interrupted loop turn.
 *
 * Without this every provider hiccup looks the same to a loop, and the loop
 * answers all of them identically: continue. That is wrong in both
 * directions. Retrying into an exhausted usage quota burns the loop's caps
 * against a window that has not reset, and pausing on a transient 503 strands
 * a multi-day loop on a blip. Context overflow is a third answer again: the
 * turn failed because the conversation is too big, so the fix is a
 * compaction, not a retry of the same oversized request.
 *
 * Ported from pi-goal's classifier, trimmed to what a loop acts on.
 */

import {
	isContextOverflow,
	isRetryableAssistantError,
	type AssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";

type LoopInterruption =
	/** The turn finished normally. */
	| "none"
	/** The user (or another extension) aborted the turn. */
	| "aborted"
	/** Provider quota or billing exhaustion: retrying cannot help. */
	| "usage-limited"
	/** The request no longer fits: compact, then continue. */
	| "context-overflow"
	/** Transient: continue as usual. */
	| "retryable"
	/** Auth or another error a retry cannot fix. */
	| "fatal";

const USAGE_LIMIT_PATTERNS = [
	/usage[_\s-]*(?:limit|cap)|chatgpt.{0,32}usage/i,
	// Exhaustion phrased as spent allowance rather than a named limit. These
	// matter most when the provider reports them as a 429, because the
	// retryable patterns match the status code and the loop would otherwise
	// retry against a quota window that has not reset. Deliberately narrow: a
	// plain "rate limit, try again later" 429 must stay retryable.
	/used all (?:the |your )?(?:included |available |free |remaining )*usage/i,
	/draw from your extra usage/i,
	/quota.{0,32}(?:reached|exceeded|exhausted|depleted)|(?:reached|exceeded|exhausted|depleted).{0,32}quota/i,
	/insufficient[_\s-]*(?:quota|credits?)|out of credits|out of budget|available balance|payment required/i,
	/(?:credit|balance).{0,32}(?:low|exhausted|depleted)|billing/i,
] as const;

const NON_RETRYABLE_PATTERN =
	/multi-auth rotation failed|credentials tried|unauthori[sz]ed|invalid api key/i;

const RETRYABLE_PATTERNS = [
	/overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error/i,
	/provider.?returned.?error|you can retry your request|try your request again|please retry your request/i,
	/network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up/i,
	/timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before message_stop|http2 request did not get a response|retry delay/i,
	/context[_\s-]*length[_\s-]*exceeded|input exceeds the context window/i,
] as const;

interface AssistantLike {
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
	api?: string;
	provider?: string;
	model?: string;
}

export function classifyInterruption(messages: readonly unknown[]): LoopInterruption {
	const assistant = findFinalAssistantMessage(messages);
	if (!assistant) return "none";
	if (assistant.stopReason === "aborted") return "aborted";
	if (assistant.stopReason !== "error") return "none";
	const errorMessage = assistant.errorMessage ?? "";
	// Usage limits are checked first on purpose: providers report them as 429,
	// which the retryable patterns also match.
	if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage))) return "usage-limited";
	if (NON_RETRYABLE_PATTERN.test(errorMessage)) return "fatal";
	if (isContextOverflow(toPiAssistantMessage(assistant))) return "context-overflow";
	if (
		isRetryableAssistantError(toPiAssistantMessage(assistant)) ||
		RETRYABLE_PATTERNS.some((pattern) => pattern.test(errorMessage))
	) {
		return "retryable";
	}
	return "fatal";
}

function findFinalAssistantMessage(messages: readonly unknown[]): AssistantLike | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		return {
			...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {}),
			...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
			...(Array.isArray(record.content) ? { content: record.content } : {}),
			...(typeof record.api === "string" ? { api: record.api } : {}),
			...(typeof record.provider === "string" ? { provider: record.provider } : {}),
			...(typeof record.model === "string" ? { model: record.model } : {}),
		};
	}
	return undefined;
}

function toPiAssistantMessage(assistant: AssistantLike): AssistantMessage {
	return {
		role: "assistant",
		content: (assistant.content ?? []) as AssistantMessage["content"],
		api: (assistant.api ?? "openai-responses") as AssistantMessage["api"],
		provider: assistant.provider ?? "unknown",
		model: assistant.model ?? "unknown",
		usage: zeroUsage(),
		stopReason: "error",
		errorMessage: assistant.errorMessage,
		timestamp: Date.now(),
	};
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
