/**
 * Display-only compaction of loop-injected pokes.
 *
 * Pokes are already token-lean, but they still render as multi-line prompt
 * text plus a provenance marker comment. This transformer collapses each into
 * a one-line themed chip in the transcript. Display-only by Pi contract: the
 * stored message and model context are untouched, and pokes keep being
 * delivered through sendUserMessage so the loop's own before_agent_start hook
 * (which appends the objective) still fires for every poke turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseLoopOkAck } from "./ack.js";
import { extractContinuationMarker, extractPokeMarker } from "./markers.js";

const POKE_HEAD_PATTERN = /^Scheduled loop wakeup (\S+) \(every ([^)]+)\)\./u;
const POKE_FOCUS_PATTERN = /^Loop focus: (.+)$/mu;

export function registerLoopMessageRendering(pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType === "assistant") return compactAckMessage(markdown) ?? markdown;
		if (messageType !== "user") return markdown;
		return compactPokeMessage(markdown) ?? compactContinuationMessage(markdown) ?? markdown;
	});
}

/** Exported for tests: the poke chip, or undefined when not ours. */
export function compactPokeMessage(markdown: string) {
	if (!extractPokeMarker(markdown)) return undefined;
	const head = POKE_HEAD_PATTERN.exec(markdown);
	if (!head) return undefined;
	const reason = markdown.includes("wait you asked for has elapsed") ? "wait elapsed" : "stalled";
	const focus = POKE_FOCUS_PATTERN.exec(markdown)?.[1];
	return `*⏰ loop wake ${head[1]} · ${reason}${focus ? ` · ${focus}` : ""}*`;
}

/**
 * Exported for tests: the acknowledgement chip, or undefined when the reply
 * is an ordinary answer. Display only — the stored message keeps its bytes,
 * because rewriting them would break the prompt cache the whole design is
 * built around.
 */
export function compactAckMessage(markdown: string) {
	const ack = parseLoopOkAck(markdown);
	if (!ack) return undefined;
	return `*✓ loop ok${ack.remainder ? ` · ${ack.remainder}` : ""}*`;
}

/** Exported for tests: the continuation chip, or undefined when not ours. */
export function compactContinuationMessage(markdown: string) {
	const marker = extractContinuationMarker(markdown);
	if (!marker) return undefined;
	const kind = markdown.startsWith("Loop started.") ? "kickoff" : "continue";
	const focus = POKE_FOCUS_PATTERN.exec(markdown)?.[1];
	return `*⟳ loop ${kind} #${marker.turn}${focus ? ` · ${focus}` : ""}*`;
}
