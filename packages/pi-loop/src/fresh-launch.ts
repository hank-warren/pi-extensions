/**
 * Starting an approved loop in a fresh session.
 *
 * A loop started interactively owns the session it was planned in, and the
 * planning conversation is the worst possible context for it: every turn of
 * drafting is carried, re-read and re-billed for the whole run, and none of it
 * is the objective. The card is where that gets fixed, because the card is
 * where the user is already deciding how the loop should run.
 *
 * Modelled on `packages/pi-plan-mode/src/fresh-implementation.ts`, which
 * solves the same problem for a plan. The difference is what crosses: a plan
 * hands over a file path, while a loop hands over its state, appended to the
 * new session in `setup` exactly as `persist` would have appended it here.
 * Only the objective and the caps cross; the drafting conversation does not.
 *
 * The ledger is written before the handoff, from this session. It is a
 * filesystem artifact keyed by loop id, not session state, and writing it here
 * is what makes the approved criteria authoritative: the restoring session
 * treats whatever is already on disk as the truth, so criteria written after
 * it restores would arrive too late to be the ones it is held to.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BuiltLoop } from "./loop.js";
import { LOOP_STATE_ENTRY_TYPE } from "./state.js";

type NewSessionOptions = Exclude<Parameters<ExtensionCommandContext["newSession"]>[0], undefined>;
type SessionManagerLike = Parameters<NonNullable<NewSessionOptions["setup"]>>[0];

type FreshLoopResult =
	| { kind: "started" }
	| { kind: "cancelled" }
	/** The session exists and holds the loop, but it could not be kicked off. */
	| { kind: "partial"; detail: string }
	| { kind: "rejected"; detail: string };

interface FreshLoopRequest {
	built: BuiltLoop;
	/** Write the ledger for `built` before the handoff; returns a failure detail. */
	prepareLedger(): string | undefined;
}

export async function startLoopInFreshSession(
	ctx: ExtensionContext,
	request: FreshLoopRequest,
): Promise<FreshLoopResult> {
	if (!isCommandContext(ctx)) {
		return {
			kind: "rejected",
			detail:
				"Starting a loop in a fresh session needs the interactive /loop command. Run /loop again and choose it from the menu.",
		};
	}
	if (ctx.mode === "print" || ctx.mode === "json") {
		return {
			kind: "rejected",
			detail: "A fresh session is unavailable in print/JSON mode. Start the loop in this session.",
		};
	}

	const ledgerFailure = request.prepareLedger();
	if (ledgerFailure) {
		// Not fatal to the loop — a loop runs without a ledger — but it is fatal
		// to *this* path: the new session would derive its own criteria from the
		// objective and could be held to a different gate than the one approved.
		return {
			kind: "rejected",
			detail: `The loop's ledger could not be written (${ledgerFailure}), so the approved criteria could not be handed to a new session. Start the loop in this session instead.`,
		};
	}

	await ctx.waitForIdle();

	const parentSession = ctx.sessionManager.getSessionFile();
	let setupError: string | undefined;

	let result: Awaited<ReturnType<ExtensionCommandContext["newSession"]>>;
	try {
		result = await ctx.newSession({
			...(parentSession ? { parentSession } : {}),
			setup: async (sessionManager: SessionManagerLike) => {
				try {
					// The same entry `persist` writes, so the new session's ordinary
					// restore path picks it up with no special case — plus the handoff
					// flag, which is what tells that session it owns the first turn.
					// The kickoff cannot be driven from here: Pi builds a new extension
					// instance for the new session, so this session's controller is not
					// the one that ends up holding the loop.
					sessionManager.appendCustomEntry(LOOP_STATE_ENTRY_TYPE, {
						loop: { ...request.built.loop, handoff: true },
					});
				} catch (error: unknown) {
					setupError = errorDetail(error);
				}
			},
			withSession: async (replacementCtx: ExtensionContext) => {
				if (setupError) {
					replacementCtx.ui.notify(
						`Fresh session created, but the loop could not be handed to it: ${setupError}. Nothing is running; start the loop from /loop in either session.`,
						"error",
					);
				}
			},
		});
	} catch (error: unknown) {
		return {
			kind: "rejected",
			detail: `Unable to start a fresh session: ${errorDetail(error)}. The draft is unchanged; start the loop in this session instead.`,
		};
	}

	if (result.cancelled) return { kind: "cancelled" };
	return setupError ? { kind: "partial", detail: setupError } : { kind: "started" };
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function";
}

function errorDetail(error: unknown) {
	const detail = error instanceof Error ? error.message : String(error);
	const normalized =
		detail
			.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
			.replace(/\s+/gu, " ")
			.trim() || "unknown error";
	return normalized.length > 500 ? `${normalized.slice(0, 499)}…` : normalized;
}
