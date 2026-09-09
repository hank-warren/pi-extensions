/**
 * Chat write: a best-effort prototype, deliberately not a safe acceptance API.
 *
 * Pi 0.85.1 has no target-bound acceptance boundary. `sendUserMessage` is
 * declared `void` ($PI/dist/core/extensions/types.d.ts:980-983), the extension
 * loader discards whatever it returns, and the internal path folds failures
 * into a generic runtime error. So there is no call that atomically compares
 * the caller's expected target, accepts or rejects the input, and returns the
 * identity of what it accepted.
 *
 * This module does the best that the supported hooks allow, and is explicit
 * about the hole that remains:
 *
 *   preflight (compare leaf + generation) -> sendUserMessage -> observe
 *
 * **The compare and the send are not atomic.** Between the preflight and the
 * moment Pi actually accepts the message, the desktop user can type, a queued
 * follow-up can land, or a branch can change. Nothing available to an
 * extension can close that window. When the outcome cannot be confirmed the
 * result is `unknown` — a real state the client must surface to the user, not
 * an error to be swallowed and never a reason to retry.
 *
 * **Nothing here ever retries.** A retry after an `unknown` is how one prompt
 * becomes two.
 *
 * See `UPSTREAM-PROPOSAL.md` for the upstream API that would remove all of
 * this in favour of a single atomic call.
 */

import { CHAT_WRITE_SHAPE, assertShape } from "./contracts.ts";
import type { SessionEntryLike, SessionManagerLike } from "./projection.ts";
import { extractText } from "./projection.ts";

/**
 * How long to wait for evidence that the send landed before reporting
 * `unknown`. A turn can legitimately take longer than this to *finish*, but
 * the user message is persisted at its start, so this bounds observation of
 * the message, not of the model's reply.
 */
export const OBSERVATION_WINDOW_MS = 10_000;

export interface ChatWriteRequest {
	requestId: string;
	expectedLeafId: string;
	expectedRuntimeGeneration: number;
	text: string;
}

export interface ChatWriteResult {
	requestId: string;
	state: "accepted" | "rejected" | "unknown";
	entryId?: string;
	reason?: string;
}

export interface ChatWriteContextLike {
	isIdle(): boolean;
	sessionManager: SessionManagerLike & { getLeafId?(): string | null | undefined };
}

export interface ChatWriteControllerOptions {
	/** Sends the message. Wraps `pi.sendUserMessage`, which returns nothing. */
	send(text: string): void;
	/** Reports an outcome exactly once per request. */
	emit(result: ChatWriteResult): void;
	/** Current runtime generation, as advertised in the binding. */
	getRuntimeGeneration(): number;
	/** Consent gates, re-evaluated per request so revocation is immediate. */
	checkConsent(): { enabled: boolean; reason?: string };
	observationWindowMs?: number;
	/** Injectable for tests; must produce an unref'd timer in production. */
	setTimer?(callback: () => void, ms: number): { cancel(): void };
}

/** Parse and validate an inbound `chat_write` envelope. */
export function parseChatWriteEnvelope(envelope: unknown): ChatWriteRequest {
	const validated = assertShape(envelope, CHAT_WRITE_SHAPE, "chat_write");
	return {
		requestId: validated.requestId as string,
		expectedLeafId: validated.expectedLeafId as string,
		expectedRuntimeGeneration: validated.expectedRuntimeGeneration as number,
		text: validated.text as string,
	};
}

/**
 * Find the persisted user entry produced by a send.
 *
 * Matched on parent **and** text, scanning from the newest end: the parent is
 * the identity check (this message must hang off the leaf the caller expected)
 * and the text distinguishes it from an unrelated user message that arrived at
 * the same parent. Text alone would be an identity mechanism, which is
 * rejected; parent alone cannot separate two sends from the same leaf.
 *
 * Ids already claimed by a resolved request are skipped so two identical sends
 * can never resolve to one entry.
 */
export function findUserEntry(
	entries: SessionEntryLike[],
	{
		parentId,
		text,
		claimed,
	}: { parentId: string; text: string; claimed?: ReadonlySet<string> },
): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "message") continue;
		const id = entry.id;
		if (typeof id !== "string") continue;
		if (claimed?.has(id)) continue;
		if (entry.parentId !== parentId) continue;
		const message = entry.message as { role?: unknown; content?: unknown } | undefined;
		if (!message || message.role !== "user") continue;
		if (extractText(message.content) !== text) continue;
		return id;
	}
	return null;
}

/**
 * One in-flight chat write at a time.
 *
 * Concurrency is refused rather than tracked: two sends racing into one
 * session cannot be told apart by any evidence available here, and a wrong
 * correlation is worse than a refusal the caller can retry deliberately.
 */
export function createChatWriteController(options: ChatWriteControllerOptions) {
	const windowMs = options.observationWindowMs ?? OBSERVATION_WINDOW_MS;
	const setTimer =
		options.setTimer ??
		((callback: () => void, ms: number) => {
			const timer = setTimeout(callback, ms);
			// Never keep the observed Pi process alive for a pending observation.
			timer.unref?.();
			return { cancel: () => clearTimeout(timer) };
		});

	interface Pending {
		request: ChatWriteRequest;
		observed: boolean;
		timer: { cancel(): void };
	}

	let pending: Pending | null = null;
	const claimed = new Set<string>();

	/** Settle a request exactly once. */
	function settle(result: ChatWriteResult): void {
		if (!pending || pending.request.requestId !== result.requestId) return;
		pending.timer.cancel();
		pending = null;
		if (result.entryId) claimed.add(result.entryId);
		options.emit(result);
	}

	function refuse(requestId: string, reason: string): void {
		options.emit({ requestId, state: "rejected", reason });
	}

	return {
		get pendingRequestId(): string | null {
			return pending?.request.requestId ?? null;
		},

		/**
		 * Preflight, then send.
		 *
		 * Every refusal path here returns before `send` is called, so a
		 * `rejected` result always means nothing was sent.
		 */
		request(request: ChatWriteRequest, ctx: ChatWriteContextLike): void {
			const consent = options.checkConsent();
			if (!consent.enabled) {
				refuse(request.requestId, consent.reason ?? "chat_write_disabled");
				return;
			}
			if (pending) {
				refuse(request.requestId, "request_in_flight");
				return;
			}
			if (options.getRuntimeGeneration() !== request.expectedRuntimeGeneration) {
				refuse(request.requestId, "binding_refused:runtime_generation");
				return;
			}
			const leafId = ctx.sessionManager.getLeafId?.() ?? null;
			if (leafId !== request.expectedLeafId) {
				refuse(request.requestId, "binding_refused:leaf");
				return;
			}
			// `promptIdle` is a disabled capability: delivering into a running
			// turn needs a `deliverAs` mode whose landing point cannot be
			// confirmed, so a busy session is refused rather than guessed at.
			if (!ctx.isIdle()) {
				refuse(request.requestId, "binding_refused:not_idle");
				return;
			}

			const timer = setTimer(() => {
				settle({
					requestId: request.requestId,
					state: "unknown",
					reason: "no_persisted_entry_within_window",
				});
			}, windowMs);
			pending = { request, observed: false, timer };

			try {
				options.send(request.text);
			} catch (error) {
				// The call threw before delivering, so nothing was sent. This is
				// the one throw path; a `void` return tells us nothing either way,
				// which is exactly why the observation below exists.
				settle({
					requestId: request.requestId,
					state: "rejected",
					reason: `send_threw:${error instanceof Error ? error.name : "unknown"}`,
				});
			}
		},

		/**
		 * Observe a `message_start`. Evidence that Pi accepted the text, but not
		 * yet identity: `message_start` carries only the message, with no entry
		 * id and no parent, so the id is resolved from persisted entries.
		 */
		observeMessageStart(message: { role?: unknown; content?: unknown }): void {
			if (!pending || message.role !== "user") return;
			if (extractText(message.content) !== pending.request.text) return;
			pending.observed = true;
		},

		/**
		 * Resolve identity against persisted entries.
		 *
		 * Called at `turn_end`/`agent_settled` and after an observation. A
		 * matching entry is `accepted`; a moved leaf with no match is `unknown`,
		 * never `rejected`, because a send that cannot be located may still have
		 * landed somewhere the caller did not expect.
		 */
		resolve(ctx: ChatWriteContextLike): void {
			if (!pending) return;
			const request = pending.request;
			const entries = ctx.sessionManager.buildContextEntries();
			const entryId = findUserEntry(entries, {
				parentId: request.expectedLeafId,
				text: request.text,
				claimed,
			});
			if (entryId) {
				settle({ requestId: request.requestId, state: "accepted", entryId });
				return;
			}
			const leafId = ctx.sessionManager.getLeafId?.() ?? null;
			if (leafId !== request.expectedLeafId) {
				settle({
					requestId: request.requestId,
					state: "unknown",
					reason: pending.observed
						? "observed_but_leaf_moved_without_matching_entry"
						: "leaf_moved_before_observation",
				});
			}
		},

		/**
		 * Abandon a pending request because the connection or session went away.
		 *
		 * Reported as `unknown`: the send may already have landed, so the client
		 * must reconcile against the next snapshot rather than assume either way.
		 */
		abandon(reason: string): void {
			if (!pending) return;
			settle({ requestId: pending.request.requestId, state: "unknown", reason });
		},
	};
}

export type ChatWriteController = ReturnType<typeof createChatWriteController>;
