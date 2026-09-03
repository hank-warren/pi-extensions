/**
 * The no-op acknowledgement protocol.
 *
 * A woken loop with nothing to do still costs a full turn: the model re-reads
 * the ledger, confirms there is nothing to act on, and writes a paragraph
 * explaining that. The paragraph is pure cost — nobody reads it, and it is
 * indistinguishable, to the loop, from a turn that did work.
 *
 * So the pokes ask for a fixed token instead: reply `LOOP_OK` when nothing
 * needs attention. That gives two things a prose answer cannot. The
 * transcript collapses it to a one-line chip (display only — the stored bytes
 * are untouched, because rewriting them would break the prompt cache), and
 * the engine gets a *deterministic* signal that the wake was wasted, which is
 * what feeds the fallback backoff.
 *
 * The remainder budget is fixed at 300 characters rather than configurable:
 * an acknowledgement with a paragraph attached is not an acknowledgement, and
 * a knob here would only let the protocol decay into ordinary prose.
 */

export const LOOP_OK_TOKEN = "LOOP_OK";
export const ACK_REMAINDER_LIMIT = 300;

/**
 * The acknowledgement's remainder (a short note the model may attach), or
 * undefined when the text is not an acknowledgement.
 */
export function parseLoopOkAck(text: string): { remainder: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith(LOOP_OK_TOKEN) && !trimmed.endsWith(LOOP_OK_TOKEN)) return undefined;
	const remainder = (
		trimmed.startsWith(LOOP_OK_TOKEN)
			? trimmed.slice(LOOP_OK_TOKEN.length)
			: trimmed.slice(0, -LOOP_OK_TOKEN.length)
	)
		.replace(/^[\s.:;,\-—·|]+|[\s.:;,\-—·|]+$/gu, "")
		.trim();
	// A "LOOP_OK" with an essay attached is a normal turn that happens to
	// mention the token, not an acknowledgement.
	return remainder.length <= ACK_REMAINDER_LIMIT ? { remainder } : undefined;
}

/** Whether the run's visible assistant text is a no-op acknowledgement. */
export function isLoopOkAck(messages: readonly unknown[]): boolean {
	const text = finalAssistantText(messages);
	return text === undefined ? false : parseLoopOkAck(text) !== undefined;
}

function finalAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		const text = message.content
			.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
			.map((block) => (typeof block.text === "string" ? block.text : ""))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
