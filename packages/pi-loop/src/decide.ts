/**
 * Pure decisions for the two things that can move a loop forward, so the full
 * matrix is unit-testable without timers or a Pi runtime:
 *
 * - `decideContinuation` runs at every settled idle boundary and is the
 *   primary driver of a standalone loop. The session going idle with the
 *   objective unfinished *is* the signal to continue; no clock is involved.
 * - `decideTick` runs when the fallback heartbeat fires. It is the fault
 *   handler for a lost continuation or an external wait, not the pacemaker.
 *
 * Both share one precedence prefix: loop liveness → expiry → plan mode →
 * compaction → busy → wait → the turn cap → act.
 *
 * A loop owns its own objective and reads no other extension's state: it ends
 * only through `loop_complete`, a cap, an expiry, or the user.
 */

import type { LoopState } from "./state.js";

export interface TickEnvironment {
	now: number;
	/** Agent is running, retrying, compacting, or has queued messages. */
	busy: boolean;
	/** A loop-owned proactive compaction is in flight; hold pokes. */
	compacting: boolean;
	planModeEnabled: boolean;
}

/** A `loop_wait` whose deadline has passed is due, not waiting. */
function isWaiting(loop: LoopState, now: number): boolean {
	const waiting = loop.waiting;
	if (!waiting) return false;
	return waiting.resumeAt === undefined || now < waiting.resumeAt;
}

/**
 * An expiring loop gets one last turn to write its state into the ledger
 * before it stops; a loop already spending that turn stops immediately.
 */
type ExpiryReason = "loop-expired" | "expiry-final-wake";

type SkipReason =
	| "plan-mode-active"
	| "agent-busy"
	| "compaction-in-flight"
	| "loop-waiting";

export type TickDecision =
	| { action: "none"; reason: "loop-not-active" }
	| { action: "expire"; reason: ExpiryReason }
	| { action: "skip"; reason: SkipReason }
	| { action: "stop"; reason: "max-turns" }
	| { action: "poke"; reason: "objective-stalled" | "wait-elapsed" };

export type ContinuationDecision =
	| { action: "none"; reason: "loop-not-active" }
	| { action: "expire"; reason: ExpiryReason }
	| { action: "skip"; reason: SkipReason }
	| { action: "stop"; reason: "max-turns" }
	| { action: "continue"; reason: "settled-idle" };

/** Shared prefix: everything that holds or ends a loop before caps matter. */
function decideCommonPrefix(
	loop: LoopState,
	env: TickEnvironment,
): Extract<TickDecision, { action: "none" | "expire" | "skip" }> | undefined {
	if (loop.status !== "active") return { action: "none", reason: "loop-not-active" };
	if (env.now >= loop.expiresAt) {
		// The final wake is the loop's own summarise-and-stop turn; a loop already
		// spending it has nothing left to buy.
		return { action: "expire", reason: loop.expiring ? "loop-expired" : "expiry-final-wake" };
	}
	if (env.planModeEnabled) return { action: "skip", reason: "plan-mode-active" };
	if (env.compacting) return { action: "skip", reason: "compaction-in-flight" };
	if (env.busy) return { action: "skip", reason: "agent-busy" };
	// A declared external wait holds both drivers: the loop is not stalled, it
	// is waiting on the world, and its own deadline is the next thing to speak.
	if (isWaiting(loop, env.now)) return { action: "skip", reason: "loop-waiting" };
	return undefined;
}

/**
 * The one cap, counting every turn the loop caused: continuations and pokes
 * alike. A delivered-wake cap sat next to it until it was collapsed into
 * this one — in a settle-paced loop the wake counter can stay at zero for the
 * loop's whole life, so it was never the ceiling that held.
 */
function decideCap(loop: LoopState): { action: "stop"; reason: "max-turns" } | undefined {
	if (loop.maxTurns !== null && loop.automaticTurns >= loop.maxTurns) {
		return { action: "stop", reason: "max-turns" };
	}
	return undefined;
}

/**
 * The settled-idle boundary: the session finished a turn with the objective
 * unfinished, so the loop continues immediately instead of waiting out an
 * interval of idle wall time.
 */
export function decideContinuation(loop: LoopState, env: TickEnvironment): ContinuationDecision {
	const prefix = decideCommonPrefix(loop, env);
	if (prefix) return prefix;
	const capped = decideCap(loop);
	if (capped) return capped;
	return { action: "continue", reason: "settled-idle" };
}

export function decideTick(loop: LoopState, env: TickEnvironment): TickDecision {
	const prefix = decideCommonPrefix(loop, env);
	if (prefix) return prefix;
	const capped = decideCap(loop);
	if (capped) return capped;
	// The prefix already let a still-waiting loop skip, so a wait surviving to
	// here is one whose deadline has come due: this wake is the wake it asked
	// for, and the turn it starts counts against the cap like any other.
	return { action: "poke", reason: loop.waiting ? "wait-elapsed" : "objective-stalled" };
}
