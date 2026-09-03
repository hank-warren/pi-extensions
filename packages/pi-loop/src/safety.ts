/**
 * The no-progress breaker.
 *
 * An autonomous loop's characteristic failure is not crashing, it is
 * *restating*: the model produces the same paragraph of "here is what I would
 * do next" turn after turn, calling no tools, while the loop dutifully wakes
 * it again. Nothing in the caps catches that quickly enough — 25 identical
 * turns is 25 turns of wasted tokens.
 *
 * So fingerprint the visible assistant text of every tool-free loop-caused
 * turn and count consecutive repeats. Normalisation (NFKC, case, whitespace,
 * control and format characters) exists because "the same answer" from a
 * model is rarely byte-identical.
 *
 * A turn that called *any* tool is progress by definition and resets the
 * counter. That includes a turn that called `loop_wait`: waiting for the
 * world is a decision, not a stall, and counting it was the false positive
 * that made this class of breaker infamous.
 */

import { createHash } from "node:crypto";

interface NoProgressState {
	toolFreeRepeatCount: number;
	lastFingerprint?: string;
}

export function nextNoProgressState(
	current: NoProgressState,
	messages: readonly unknown[],
	toolAttempted: boolean,
): NoProgressState {
	if (toolAttempted) return { toolFreeRepeatCount: 0 };
	const fingerprint = fingerprintVisibleAssistantOutput(messages);
	return {
		toolFreeRepeatCount:
			fingerprint === current.lastFingerprint
				? Math.min(Number.MAX_SAFE_INTEGER, current.toolFreeRepeatCount + 1)
				: 1,
		lastFingerprint: fingerprint,
	};
}

export function hasAssistantToolCall(messages: readonly unknown[]): boolean {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		if (message.content.some((block) => isRecord(block) && block.type === "toolCall")) return true;
	}
	return false;
}

/** Whether the run called a specific tool, e.g. the loop's own `loop_wait`. */
export function calledTool(messages: readonly unknown[], toolName: string): boolean {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "toolCall") continue;
			if (block.name === toolName || block.toolName === toolName) return true;
		}
	}
	return false;
}

export function fingerprintVisibleAssistantOutput(messages: readonly unknown[]): string {
	return createHash("sha256")
		.update(normalizeVisibleAssistantOutput(messages), "utf8")
		.digest("hex");
}

export function normalizeVisibleAssistantOutput(messages: readonly unknown[]): string {
	const text: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
			text.push(block.text);
		}
	}
	const normalized = text
		.join("\n")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	// Empty or punctuation-only output is not a distinguishable answer.
	return normalized === "" || /^[\p{P}\s]+$/u.test(normalized) ? "" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
