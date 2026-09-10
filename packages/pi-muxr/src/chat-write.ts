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
 * This module does the best the supported hooks allow, and is explicit about
 * the hole that remains:
 *
 *   preflight (compare leaf + generation) -> sendUserMessage -> claim by leaf
 *
 * **The compare and the send are not atomic.** Between the preflight and the
 * moment Pi accepts the message, the desktop user can type, a queued follow-up
 * can land, or a branch can change. Nothing available to an extension closes
 * that window. When the outcome cannot be confirmed the result is `unknown` —
 * a real state the client must surface to the user, not an error to swallow and
 * never a reason to retry.
 *
 * ## Correlation never compares text
 *
 * An earlier version matched a persisted entry by parent **and text equality**.
 * That is the mechanism muxr's own register rejects (`docs/decisions.md:51`,
 * `docs/architecture.md:91`), and it had a concrete failure: the desktop user
 * typing the same text at the same parent inside the observation window was
 * claimed as `accepted` with their entry id, while our own send landed
 * elsewhere and was never reported — one prompt silently becoming two.
 *
 * The rule here uses no text at all. A send is `accepted` only when the leaf
 * never moved between the preflight and the observation, and exactly one
 * user-role entry hangs off that leaf. A second child of the same parent means
 * two messages raced into one fork, which is unresolvable from the outside, so
 * it is reported `ambiguous_parent`. Any leaf movement before the observation
 * is `leaf_moved`.
 *
 * **Nothing here ever retries**, and a re-sent `requestId` replays the stored
 * outcome instead of sending again.
 *
 * See `UPSTREAM-PROPOSAL.md` for the upstream API that would remove all of it.
 */

import { CHAT_WRITE_SHAPE, PROTOCOL, assertShape } from "./contracts.ts";
import type { SessionEntryLike, SessionManagerLike } from "./projection.ts";

/**
 * How long to wait for evidence that the send landed before reporting
 * `unknown`. A turn can legitimately take longer than this to *finish*, but
 * the user message is persisted at its start, so this bounds observation of
 * the message, not of the model's reply.
 */
export const OBSERVATION_WINDOW_MS = 10_000;

/**
 * How many settled outcomes to remember for `requestId` replay.
 *
 * Bounded because a long-lived session must not grow a map per request. The
 * oldest entry is evicted first; a request older than this that is re-sent is
 * treated as new, which is why the bridge keeps the durable ledger.
 */
export const SETTLED_HISTORY_LIMIT = 64;

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

export interface ChatWriteSessionManager extends SessionManagerLike {
	getLeafId?(): string | null | undefined;
	getBranch?(fromId?: string): SessionEntryLike[];
	getEntries?(): SessionEntryLike[];
}

export interface ChatWriteContextLike {
	isIdle(): boolean;
	sessionManager: ChatWriteSessionManager;
}

export interface ChatWriteControllerOptions {
	/** Sends the message. Wraps `pi.sendUserMessage`, which returns nothing. */
	send(text: string): void;
	/** Reports an outcome exactly once per settled request. */
	emit(result: ChatWriteResult): void;
	/** Current runtime generation, as advertised in the binding. */
	getRuntimeGeneration(): number;
	/** Consent gates, re-evaluated per request so revocation is immediate. */
	checkConsent(): { enabled: boolean; reason?: string };
	observationWindowMs?: number;
	/** Injectable for tests; must produce an unref'd timer in production. */
	setTimer?(callback: () => void, ms: number): { cancel(): void };
}

/** Raised when a request does not belong to the live registration. */
export class ChatWriteBindingError extends Error {
	readonly requestId: string;
	readonly reason: string;

	constructor(requestId: string, reason: string) {
		super(`chat_write: ${reason}`);
		this.name = "ChatWriteBindingError";
		this.requestId = requestId;
		this.reason = reason;
	}
}

/**
 * Parse, validate, and **bind** an inbound `chat_write` envelope.
 *
 * `CHAT_WRITE_SHAPE` carries `registrationId` and `bridgeEpoch` precisely so a
 * request can be tied to one target; validating and then discarding them, as an
 * earlier version did, honoured a request naming a different registration.
 */
export function parseChatWriteEnvelope(
	envelope: unknown,
	expected: { registrationId: string; bridgeEpoch: number },
): ChatWriteRequest {
	const validated = assertShape(envelope, CHAT_WRITE_SHAPE, "chat_write");
	const requestId = validated.requestId as string;
	if (validated.protocol !== PROTOCOL.bridge) {
		throw new ChatWriteBindingError(requestId, "binding_refused:protocol");
	}
	if (validated.registrationId !== expected.registrationId) {
		throw new ChatWriteBindingError(requestId, "binding_refused:registration");
	}
	if (validated.bridgeEpoch !== expected.bridgeEpoch) {
		throw new ChatWriteBindingError(requestId, "binding_refused:epoch");
	}
	return {
		requestId,
		expectedLeafId: validated.expectedLeafId as string,
		expectedRuntimeGeneration: validated.expectedRuntimeGeneration as number,
		text: validated.text as string,
	};
}

/**
 * The session's current leaf.
 *
 * `getLeafId()` when available, otherwise the last entry of `getBranch()` —
 * the same value by definition, so a session double need only provide one.
 */
export function leafOf(sessionManager: ChatWriteSessionManager): string | null {
	if (typeof sessionManager.getLeafId === "function") {
		return sessionManager.getLeafId() ?? null;
	}
	if (typeof sessionManager.getBranch === "function") {
		const branch = sessionManager.getBranch();
		const last = branch.at(-1);
		return typeof last?.id === "string" ? last.id : null;
	}
	return null;
}

/**
 * Every user-role entry whose parent is `parentId`, walked once.
 *
 * `getEntries()` is the source rather than `buildContextEntries()` because a
 * competing message at the same parent creates a *fork*, and the sibling on the
 * other branch is invisible to the active-branch projection — exactly the case
 * this check exists to catch.
 */
export function userChildrenOf(
	sessionManager: ChatWriteSessionManager,
	parentId: string,
): string[] {
	const entries =
		typeof sessionManager.getEntries === "function"
			? sessionManager.getEntries()
			: sessionManager.buildContextEntries();
	const ids: string[] = [];
	for (const entry of entries) {
		if (!entry || entry.type !== "message") continue;
		if (entry.parentId !== parentId) continue;
		const id = entry.id;
		if (typeof id !== "string") continue;
		const message = entry.message as { role?: unknown } | undefined;
		if (!message || message.role !== "user") continue;
		ids.push(id);
	}
	return ids;
}

/**
 * One in-flight chat write at a time.
 *
 * Concurrency is refused rather than tracked: two sends racing into one session
 * cannot be told apart by any evidence available here, and a wrong correlation
 * is worse than a refusal the caller can retry deliberately.
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
		/** The leaf at preflight. The send is claimed only against this id. */
		leafBefore: string;
		/** Set by the first user-role `message_start` after the send. */
		observed: boolean;
		timer: { cancel(): void };
	}

	let pending: Pending | null = null;
	/** Settled outcomes, newest last, for `requestId` replay. */
	const settled = new Map<string, ChatWriteResult>();

	function remember(result: ChatWriteResult): void {
		settled.set(result.requestId, result);
		while (settled.size > SETTLED_HISTORY_LIMIT) {
			const oldest = settled.keys().next();
			if (oldest.done) break;
			settled.delete(oldest.value);
		}
	}

	/** Settle the pending request exactly once. */
	function settle(result: ChatWriteResult): void {
		if (!pending || pending.request.requestId !== result.requestId) return;
		pending.timer.cancel();
		pending = null;
		remember(result);
		options.emit(result);
	}

	/** Refuse before anything is sent; nothing is pending in this path. */
	function refuse(requestId: string, reason: string): void {
		const result: ChatWriteResult = { requestId, state: "rejected", reason };
		remember(result);
		options.emit(result);
	}

	/**
	 * Resolve identity from the session, or classify why it cannot be.
	 *
	 * Called at the observation and at every settle point. Never compares text.
	 */
	function claim(ctx: ChatWriteContextLike): void {
		if (!pending) return;
		const { request, leafBefore } = pending;
		const children = userChildrenOf(ctx.sessionManager, leafBefore);

		if (children.length > 1) {
			// Two user messages at one parent: a fork. Which one is ours cannot
			// be determined without comparing text, which is precisely the
			// mechanism this design rejects.
			settle({ requestId: request.requestId, state: "unknown", reason: "ambiguous_parent" });
			return;
		}

		const leafNow = leafOf(ctx.sessionManager);

		if (children.length === 1) {
			// Only claimable once our own message_start was seen while the leaf
			// was still leafBefore. Without that, this entry may be someone
			// else's message that happens to sit at the expected parent.
			if (pending.observed) {
				settle({ requestId: request.requestId, state: "accepted", entryId: children[0] });
				return;
			}
			if (leafNow !== leafBefore) {
				settle({ requestId: request.requestId, state: "unknown", reason: "leaf_moved" });
			}
			return;
		}

		// No child yet. A moved leaf means something else landed first, so our
		// send can no longer parent to leafBefore.
		if (leafNow !== leafBefore) {
			settle({ requestId: request.requestId, state: "unknown", reason: "leaf_moved" });
		}
	}

	return {
		get pendingRequestId(): string | null {
			return pending?.request.requestId ?? null;
		},

		/** Outcome remembered for a settled request, if still in history. */
		settledResult(requestId: string): ChatWriteResult | undefined {
			return settled.get(requestId);
		},

		/**
		 * Preflight, then send.
		 *
		 * Every refusal path returns before `send` is called, so a `rejected`
		 * result always means nothing was sent.
		 */
		request(request: ChatWriteRequest, ctx: ChatWriteContextLike): void {
			// Replay before anything else: a re-sent requestId must never produce
			// a second send, even if consent was revoked in between.
			const previous = settled.get(request.requestId);
			if (previous) {
				options.emit(previous);
				return;
			}
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
			const leafBefore = leafOf(ctx.sessionManager);
			if (leafBefore === null || leafBefore !== request.expectedLeafId) {
				refuse(request.requestId, "binding_refused:leaf");
				return;
			}
			// A user entry already hanging off the expected leaf means the branch
			// position is not the clean tip the caller believes; claiming against
			// it later could not distinguish that entry from ours.
			if (userChildrenOf(ctx.sessionManager, leafBefore).length > 0) {
				refuse(request.requestId, "binding_refused:leaf_already_has_user_child");
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
			pending = { request, leafBefore, observed: false, timer };

			try {
				options.send(request.text);
			} catch (error) {
				// The call threw before delivering, so nothing was sent. This is
				// the one throw path; a `void` return tells us nothing either way,
				// which is exactly why the claim below exists.
				settle({
					requestId: request.requestId,
					state: "rejected",
					reason: `send_threw:${error instanceof Error ? error.name : "unknown"}`,
				});
			}
		},

		/**
		 * Observe the first user-role `message_start` after the send.
		 *
		 * `message_start` carries only the message — no entry id and no parent
		 * ($PI/dist/core/extensions/types.d.ts `MessageStartEvent`) — so identity
		 * comes from the session, not from the event. What this establishes is
		 * *timing*: if the leaf has not moved at this instant, the message now
		 * starting will parent to `leafBefore`.
		 *
		 * Only the first such event counts. A later one belongs to a different
		 * message.
		 */
		observeMessageStart(message: { role?: unknown }, ctx: ChatWriteContextLike): void {
			if (!pending || pending.observed) return;
			if (message.role !== "user") return;
			if (leafOf(ctx.sessionManager) !== pending.leafBefore) {
				settle({
					requestId: pending.request.requestId,
					state: "unknown",
					reason: "leaf_moved",
				});
				return;
			}
			pending.observed = true;
			claim(ctx);
		},

		/** Resolve or classify at a settle point (`turn_end` / `agent_settled`). */
		resolve(ctx: ChatWriteContextLike): void {
			claim(ctx);
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
