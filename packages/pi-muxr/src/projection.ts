/**
 * Pi read projection: session state and stream events as bridge envelopes.
 *
 * Ported from `proof/fixture/projection-pi.mjs` in hank-warren/muxr at commit
 * e5281de05f8cebdca1ee3926ef2fd3f47c47ae57.
 *
 * Pure module: no I/O, no Pi import, no socket, so it can be exercised against
 * recorded entries as easily as against a live session.
 *
 * Two rules drive the design:
 *
 * 1. The snapshot is authoritative and events are hints. After a gap or a
 *    reconnect the consumer rebuilds from a snapshot instead of patching.
 * 2. Streaming message identity is provisional. A `message_end` handler can
 *    still replace a finalized message, so only a persisted session entry id
 *    is authoritative.
 *
 * Everything read out of a session is untrusted data: text is copied, never
 * interpreted, and the projection is bounded by `LIMITS`.
 */

import {
	CAPABILITIES,
	CHAT_WRITE_RESULT_PAYLOAD_SHAPE,
	DISABLED,
	LIMITS,
	MESSAGE_RECONCILED_PAYLOAD_SHAPE,
	assertEnvelope,
	assertShape,
} from "./contracts.ts";

/**
 * Message roles the conversation contract can carry.
 *
 * Pi persists more than this on a branch (`model_change`,
 * `thinking_level_change`, `custom`, `custom_message`); those have no role in
 * `CONVERSATION_ENTRY_SHAPE` and are excluded rather than misrepresented.
 */
export const PROJECTED_ROLES = Object.freeze(["user", "assistant", "toolResult"]);

/**
 * Session entry types projected as marker entries rather than messages.
 *
 * These are not conversation turns; they stand for history that
 * `buildContextEntries()` has already omitted. Projecting them keeps the gap
 * visible in the transcript instead of leaving an unexplained jump.
 */
export const MARKER_ENTRY_TYPES = Object.freeze(["compaction", "branch_summary"]);

/** Prefix for provisional (pre-persistence) stream ids. */
const PROVISIONAL_PREFIX = "provisional:";

interface ProvisionalMessage {
	provisionalId: string;
	role: string;
	text: string;
	ended: boolean;
}

/**
 * Newest-first search. `Array.prototype.findLast` is ES2023 and this workspace
 * targets ES2022, so the scan is written out rather than widening `lib` for
 * every package in the repository.
 */
function findLastMatch<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (predicate(items[index])) return items[index];
	}
	return undefined;
}

export interface ConversationEntry {
	entryId: string;
	role: string;
	provisional: boolean;
	text: string;
	toolCallId?: string;
}

/**
 * The parts of a Pi `SessionEntry` this projection reads.
 *
 * Deliberately not an index-signature type: `SessionEntry` is a discriminated
 * union of concrete interfaces, and an index signature would make every one of
 * them structurally incompatible with this one.
 */
export interface SessionEntryLike {
	id?: unknown;
	type?: unknown;
	parentId?: unknown;
	message?: unknown;
	/** Marker entries carry their summary in one of these three fields. */
	summary?: unknown;
	text?: unknown;
	content?: unknown;
}

export interface SessionManagerLike {
	buildContextEntries(): SessionEntryLike[];
	getLeafId?(): string | null | undefined;
	getSessionId?(): string;
}

/**
 * Extract displayable text from an `AgentMessage` content value.
 *
 * Content is either a string or an array of typed blocks. Only `text` blocks
 * contribute: `thinking` is not conversation text, `toolCall` arguments are
 * structured data, and image bytes are never inlined. The result is plain text
 * and is never treated as markup.
 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Collect `toolCall` blocks from an assistant message, so a later `toolResult`
 * can be linked to the call that produced it.
 */
export function extractToolCalls(content: unknown): Array<{ toolCallId: string; toolName: string }> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ toolCallId: string; toolName: string }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: string; id?: unknown; name?: unknown };
		if (typed.type !== "toolCall") continue;
		if (typeof typed.id !== "string" || typeof typed.name !== "string") continue;
		calls.push({ toolCallId: typed.id, toolName: typed.name });
	}
	return calls;
}

/**
 * Summary text of a marker entry.
 *
 * Pi spells the summary differently per entry type, so each source is read
 * explicitly rather than guessed at; an unrecognized shape yields an empty
 * string instead of leaking an object into the transcript.
 */
function markerText(entry: SessionEntryLike): string {
	for (const key of ["summary", "text", "content"]) {
		const value = (entry as Record<string, unknown>)[key];
		if (typeof value === "string") return value;
		if (value !== undefined) return extractText(value);
	}
	return "";
}

/**
 * Project one session entry into a conversation entry, or null when the entry
 * is not representable in the conversation contract.
 */
export function projectEntry(entry: SessionEntryLike | null | undefined): ConversationEntry | null {
	if (!entry || typeof entry !== "object") return null;
	const id = entry.id;
	if (typeof id !== "string") return null;

	// Markers carry the compaction/branch-summary role and the summary text.
	// They are not messages and have no tool association.
	if (typeof entry.type === "string" && MARKER_ENTRY_TYPES.includes(entry.type)) {
		return {
			entryId: id,
			role: entry.type,
			provisional: false,
			text: markerText(entry),
		};
	}

	if (entry.type !== "message") return null;
	const message = entry.message as
		| { role?: unknown; content?: unknown; toolCallId?: unknown }
		| undefined;
	if (!message || typeof message !== "object") return null;
	const role = message.role;
	if (typeof role !== "string" || !PROJECTED_ROLES.includes(role)) return null;

	// A toolResult names the call it answers. An assistant entry carries one
	// only when it made exactly one call: with several, a single id would pick
	// an arbitrary winner, and the association is already carried per call on
	// the tool events.
	let toolCallId: string | undefined;
	if (role === "toolResult" && typeof message.toolCallId === "string") {
		toolCallId = message.toolCallId;
	} else if (role === "assistant") {
		const calls = extractToolCalls(message.content);
		if (calls.length === 1) toolCallId = calls[0].toolCallId;
	}

	return {
		entryId: id,
		role,
		// A persisted session entry is by definition no longer provisional.
		provisional: false,
		text: extractText(message.content),
		...(toolCallId ? { toolCallId } : {}),
	};
}

/** Byte size of a projected entry, used for the total-bytes bound. */
function entryBytes(entry: ConversationEntry): number {
	return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/**
 * Apply the bounded-projection limits, keeping the newest entries.
 *
 * Dropping the oldest entries is the only bounded view that keeps a
 * conversation readable, and `truncated` makes the loss explicit so a consumer
 * never mistakes a bounded view for a complete transcript.
 */
export function boundEntries(
	entries: ConversationEntry[],
	limits: { events?: number; totalBytes?: number } = {},
): { entries: ConversationEntry[]; truncated: boolean } {
	const maxEntries = limits.events ?? LIMITS.events;
	const maxBytes = limits.totalBytes ?? LIMITS.totalBytes;

	let truncated = false;
	let kept = entries;
	if (kept.length > maxEntries) {
		kept = kept.slice(kept.length - maxEntries);
		truncated = true;
	}

	let total = 0;
	let firstKept = kept.length;
	for (let index = kept.length - 1; index >= 0; index -= 1) {
		const size = entryBytes(kept[index]);
		if (total + size > maxBytes) break;
		total += size;
		firstKept = index;
	}
	if (firstKept > 0) {
		kept = kept.slice(firstKept);
		truncated = true;
	}

	return { entries: kept, truncated };
}

/**
 * Project the active branch of a session.
 *
 * `buildContextEntries()` is the compaction-aware presentation projection,
 * which is why it is the source here rather than `getEntries()` (every entry,
 * including other branches) or `getBranch()` (ancestry without compaction
 * applied).
 */
export function projectConversation(
	sessionManager: SessionManagerLike,
	limits?: { events?: number; totalBytes?: number },
): { entries: ConversationEntry[]; truncated: boolean } {
	const projected: ConversationEntry[] = [];
	let historySummarized = false;
	for (const entry of sessionManager.buildContextEntries()) {
		// The marker is projected, but it does not restore what it stands for:
		// after a compaction `buildContextEntries()` omits the summarized entries
		// entirely. So `truncated` stays true — the marker says history was
		// summarized, and `truncated` says this view is not the whole transcript.
		if (typeof entry?.type === "string" && MARKER_ENTRY_TYPES.includes(entry.type)) {
			historySummarized = true;
		}
		const conversationEntry = projectEntry(entry);
		if (conversationEntry) projected.push(conversationEntry);
	}
	const bounded = boundEntries(projected, limits);
	return { entries: bounded.entries, truncated: bounded.truncated || historySummarized };
}

export interface ProjectionOptions {
	binding: Record<string, unknown>;
	bridgeEpoch: number;
	registrationId: string;
	protocol?: number;
	bindingRevision?: number;
	limits?: { events?: number; totalBytes?: number };
}

export interface ReconciledMapping {
	provisionalId: string;
	entryId: string;
	role: string;
	text: string;
	rewritten: boolean;
}

/** Create a projection bound to one registration. */
export function createPiProjection({
	binding,
	bridgeEpoch,
	registrationId,
	protocol = 1,
	bindingRevision = 0,
	limits,
}: ProjectionOptions) {
	let eventSequence = 0;
	/** Streamed messages that have no persisted id yet, in stream order. */
	let provisional: ProvisionalMessage[] = [];
	let provisionalCounter = 0;

	function event(type: string, payload: Record<string, unknown>): Record<string, unknown> {
		eventSequence += 1;
		const envelope = {
			kind: "event",
			protocol,
			bridgeEpoch,
			registrationId,
			bindingRevision,
			eventSequence,
			type,
			payload,
		};
		assertEnvelope(envelope);
		return envelope;
	}

	return {
		/** Current event cursor. */
		get eventSequence(): number {
			return eventSequence;
		},
		/** Provisional stream entries not yet reconciled to persisted ids. */
		get provisionalEntries() {
			return provisional.map((item) => ({ ...item }));
		},

		/** Build the authoritative snapshot. */
		snapshot({
			sessionManager,
			lifecycle,
			terminalControlGeneration = 0,
		}: {
			sessionManager: SessionManagerLike;
			lifecycle: string;
			terminalControlGeneration?: number;
		}): Record<string, unknown> {
			const { entries, truncated } = projectConversation(sessionManager, limits);
			// The leaf is sampled per snapshot, not frozen at registration. A
			// snapshot is the authoritative state a client rebuilds from after a
			// gap or reconnect, so a stale leaf would misidentify the branch
			// position. Advancing along a branch is not a binding replacement:
			// `bindingRevision` still changes only when the binding is replaced.
			const liveLeafId =
				typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() : undefined;
			const envelope = {
				kind: "snapshot",
				protocol,
				bridgeEpoch,
				registrationId,
				bindingRevision,
				eventSequence,
				terminalControlGeneration,
				binding: { ...binding, piLeafId: liveLeafId ?? binding.piLeafId },
				capabilities: [...CAPABILITIES],
				disabled: { ...DISABLED },
				lifecycle,
				entries,
				truncated,
			};
			assertEnvelope(envelope);
			return envelope;
		},

		/** Begin a provisional streamed message. */
		messageStart(message: { role: string }): Record<string, unknown> {
			provisionalCounter += 1;
			const provisionalId = `${PROVISIONAL_PREFIX}${provisionalCounter}`;
			provisional.push({ provisionalId, role: message.role, text: "", ended: false });
			return event("message_start", { provisionalId, role: message.role });
		},

		/** Append a streamed delta to the newest open provisional message. */
		messageUpdate({ delta = "" }: { delta?: string }): Record<string, unknown> {
			const current = findLastMatch(provisional, (item) => !item.ended);
			if (!current) {
				throw new Error("muxr projection: message_update without an open provisional message");
			}
			current.text += delta;
			return event("message_update", { provisionalId: current.provisionalId, delta });
		},

		/**
		 * Close a provisional message. Still provisional: a later `message_end`
		 * handler can replace the finalized message before it is persisted.
		 */
		messageEnd(message: { role: string; text: string }): Record<string, unknown> {
			const current = findLastMatch(
				provisional,
				(item) => !item.ended && item.role === message.role,
			);
			if (!current) {
				throw new Error("muxr projection: message_end without an open provisional message");
			}
			current.ended = true;
			current.text = message.text;
			return event("message_end", {
				provisionalId: current.provisionalId,
				role: message.role,
				provisional: true,
			});
		},

		/**
		 * Emit a tool lifecycle hint carrying the association a conversation
		 * entry cannot hold for a multi-call assistant message.
		 */
		toolEvent(
			type: "tool_execution_start" | "tool_execution_end",
			{
				toolCallId,
				toolName,
				isError,
			}: { toolCallId: string; toolName: string; isError?: boolean },
		): Record<string, unknown> {
			return event(type, {
				toolCallId,
				toolName,
				...(typeof isError === "boolean" ? { isError } : {}),
			});
		},

		/**
		 * Reconcile provisional stream ids against persisted entry ids.
		 *
		 * Called after `turn_end`/`agent_settled`, when the session has the
		 * authoritative entries. Both lists are walked from the newest end, and
		 * the persisted cursor advances past entries whose role does not match —
		 * a turn ends only after its assistant message *and every tool result*
		 * have been appended, so the persisted tail is not index-aligned with the
		 * streamed messages.
		 *
		 * Matching never compares text: a `message_end` handler may have
		 * rewritten it, and text matching is rejected as an identity mechanism.
		 * Text is only used to report whether a rewrite happened.
		 */
		reconcile(sessionManager: SessionManagerLike): ReconciledMapping[] {
			const persisted: ConversationEntry[] = [];
			for (const entry of sessionManager.buildContextEntries()) {
				const projected = projectEntry(entry);
				if (projected) persisted.push(projected);
			}

			const pending = provisional.filter((item) => item.ended);
			if (pending.length === 0) return [];

			const resolved: ReconciledMapping[] = [];
			let persistedIndex = persisted.length - 1;
			for (let pendingIndex = pending.length - 1; pendingIndex >= 0; pendingIndex -= 1) {
				const streamed = pending[pendingIndex];
				while (persistedIndex >= 0 && persisted[persistedIndex].role !== streamed.role) {
					persistedIndex -= 1;
				}
				if (persistedIndex < 0) break;
				const entry = persisted[persistedIndex];
				resolved.push({
					provisionalId: streamed.provisionalId,
					entryId: entry.entryId,
					role: entry.role,
					text: entry.text,
					rewritten: entry.text !== streamed.text,
				});
				persistedIndex -= 1;
			}
			resolved.reverse();

			const consumed = new Set(resolved.map((item) => item.provisionalId));
			provisional = provisional.filter((item) => !consumed.has(item.provisionalId));
			return resolved;
		},

		/**
		 * Announce a provisional -> persisted id mapping.
		 *
		 * Emitted after settle as its own `message_reconciled` event, so identity
		 * changes are not hidden inside the payload of an unrelated event type.
		 * Fabricating `tool_execution_end` for a `provisional:N` id remains
		 * excluded: it is not a tool call and would make consumers render
		 * phantom tool cards.
		 */
		reconciledEvent(
			resolved: Array<{ provisionalId: string; entryId: string }>,
		): Record<string, unknown> | null {
			if (!Array.isArray(resolved) || resolved.length === 0) return null;
			const payload = {
				reconciled: resolved.map(({ provisionalId, entryId }) => ({ provisionalId, entryId })),
			};
			// Validated here because `event.payload` is opaque to
			// `assertEnvelope`: without this the shape would only be checked by
			// whoever consumes it.
			assertShape(payload, MESSAGE_RECONCILED_PAYLOAD_SHAPE, "message_reconciled payload");
			return event("message_reconciled", payload);
		},

		/**
		 * Report the outcome of a prototype chat write.
		 *
		 * A separate event type rather than a field on a settle event: a consumer
		 * must be able to react to `unknown` — the state the missing upstream
		 * acceptance API makes unavoidable — without inferring it from anything
		 * else.
		 */
		chatWriteResult(result: {
			requestId: string;
			state: string;
			entryId?: string;
			reason?: string;
		}): Record<string, unknown> {
			const payload = {
				requestId: result.requestId,
				state: result.state,
				...(result.entryId ? { entryId: result.entryId } : {}),
				...(result.reason ? { reason: result.reason } : {}),
			};
			assertShape(payload, CHAT_WRITE_RESULT_PAYLOAD_SHAPE, "chat_write_result payload");
			return event("chat_write_result", payload);
		},

		/**
		 * Drop provisional state without resolving it.
		 *
		 * Used on reconnect: the snapshot rebuilt afterwards is authoritative, so
		 * carrying stale provisional ids across a connection would invent
		 * identity that no longer exists.
		 */
		resetProvisional(): void {
			provisional = [];
		},
	};
}

export type PiProjection = ReturnType<typeof createPiProjection>;
