/**
 * The loop engine: timer lifecycle, tick evaluation, poke delivery, and
 * loop-aware compaction, wired to Pi's extension events.
 *
 * Design invariants (approved plan):
 * - The settled idle boundary is the pacemaker: an agent_end records a
 *   continuation *intent*, and the next fully settled boundary dispatches it.
 *   The interval is a fallback heartbeat, re-armed from the last settle, that
 *   fires only when the session has been idle a whole interval with the
 *   objective unfinished (a lost continuation, or an external wait).
 * - Timers are armed in session_start, a settle, or a command handler, never
 *   the factory, and cleared in an idempotent session_shutdown.
 * - Pokes deliver only at a fully idle boundary; a tick that lands while the
 *   agent is busy coalesces into a single pending wake delivered at the next
 *   agent_settled. Missed ticks never stack, and a continuation supersedes a
 *   coalesced wake rather than delivering both.
 * - A loop owns "whether the work is done" itself: it ends through
 *   `loop_complete`, a cap, its expiry, or the user, and reads no other
 *   extension's state to decide that.
 * - Terminal decisions (expiry, caps) also land at a settled boundary, so the
 *   loop settles as soon as the work does; only the timer ever pokes.
 * - The loop's proactive compaction is the normal compaction path; Pi's
 *   reserve-token auto-compaction is the fault handler. The loop owns the
 *   post-compaction re-anchor.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoopStartArguments } from "./command.js";
import {
	type ContinuationDecision,
	decideContinuation,
	decideTick,
	type TickDecision,
	type TickEnvironment,
} from "./decide.js";
import {
	formatClock,
	formatDuration,
	formatElapsed,
	MAX_INTERVAL_MS,
	parseDuration,
} from "./interval.js";
import {
	createLedger,
	criteriaFromDescriptions,
	deriveCriteria,
	type LedgerPaths,
	ledgerPaths,
	type LoopCriterion,
	readCriteria,
} from "./ledger.js";
import {
	buildCompactionInstructions,
	buildContinuation,
	buildExpiryWake,
	buildKickoffAnchor,
	buildObjectivePoke,
	type ContinuationKind,
	extractNextActions,
} from "./messages.js";
import {
	DEFAULT_LOOP_SETTINGS,
	type LoopSettings,
	loopSettingsPath,
	readLoopSettings,
} from "./settings.js";
import {
	LOOP_STATE_ENTRY_TYPE,
	type LoopState,
	readPlanModeEnabled,
	restoreLoopState,
} from "./state.js";
import { publishLoopEnv } from "./loop-env.js";
import { showLoopProposalCard } from "./presentation.js";
import { isLoopOkAck } from "./ack.js";
import { calledTool, hasAssistantToolCall, nextNoProgressState } from "./safety.js";
import { classifyInterruption } from "./errors.js";
import { LOOP_WAIT_TOOL } from "./wait-tool.js";
import {
	createLoopWait,
	type LoopWait,
	LoopWaitTimer,
	resolveWaitDelay,
	type ResolvedWaitDelay,
} from "./wait.js";
import { LOOP_COMPLETE_TOOL } from "./complete-tool.js";
import {
	buildProposal,
	type LoopPlanningState,
	type LoopProposal,
	type LoopProposalOverrides,
	normalizeGroundRules,
} from "./planning.js";
import {
	clearLoopWidget,
	loopWidgetLine,
	type LoopWidgetView,
	updateLoopWidget,
} from "./widget.js";

const LOOP_STATUS_KEY = "loop";

/** Custom message type of the kickoff anchor. */
export const LOOP_ANCHOR_MESSAGE_TYPE = "loop-objective";

/**
 * A fallback wake that produces a no-op turn doubles the next fallback delay,
 * capped here. Deterministic and small: the point is to stop re-waking a loop
 * that has nothing to do, not to invent an adaptive scheduler.
 */
const MAX_FALLBACK_BACKOFF = 4;

/**
 * How long a single run may stay open before the widget calls it blocked.
 *
 * Deliberately generous: a long build, a big test suite, or a deep subagent
 * fan-out are all legitimately busy for a while, and crying blocked on honest
 * work would train the signal to be ignored. Fifteen minutes with no completed
 * turn is well past ordinary work and well short of the seven-day expiry that
 * would otherwise be the first sign anything was wrong.
 */
export const STALL_ATTENTION_MS = 900_000;
/**
 * How long the expiry wake has to become a turn before the loop stops anyway.
 *
 * `sendUserMessage` is fire-and-forget: Pi swallows an asynchronous delivery
 * failure (an expired credential, a torn-down runner), so a successful return
 * is not proof a turn will start. The ordinary dead-delivery counter cannot
 * catch this one, because after expiry there is no next delivery to count.
 */
const EXPIRY_TURN_GRACE_MS = 60_000;

/** Consecutive loop deliveries that produce no run before the loop pauses. */
const MAX_DEAD_DELIVERIES = 3;

/** Why the loop caused the run that is currently in flight. */
type RunOrigin = "continuation" | "fallback";

/**
 * The outcome of a start attempt.
 *
 * `startLoop` used to report its refusals by calling `ctx.ui.notify` itself,
 * which tied the only start path to a UI. The approval card's two start
 * actions share that path — one installs the loop here, the other hands it to
 * a fresh session — so the decision is returned and each caller renders it.
 */
type LoopStartResult = { ok: true; loop: LoopState } | { ok: false; message: string };

/**
 * A loop that exists but is not running anywhere: everything `installLoop`
 * needs, and nothing that presumes which session will install it.
 */
export interface BuiltLoop {
	loop: LoopState;
	/** The criteria to write at install: proposed, or the deterministic split. */
	criteria: LoopCriterion[];
	expiryMs: number;
	clamped: boolean;
	requestedMs: number;
}

type LoopBuildResult = { ok: true; built: BuiltLoop } | { ok: false; message: string };

interface ContinuationIntent {
	loopId: string;
	kind: ContinuationKind;
	/** Next actions carried out of a compaction summary, for a re-anchor. */
	nextActions?: string;
}

export interface LoopControllerOptions {
	settingsPath?: string;
	now?: () => number;
	/** Root for the loop ledger; defaults to Pi's agent dir. Tests override it. */
	agentDir?: string;
	/** How long the final expiry turn has to start before the loop gives up. */
	expiryTurnGraceMs?: number;
}

export class LoopController {
	settings: LoopSettings = structuredClone(DEFAULT_LOOP_SETTINGS);
	state: LoopState | undefined;
	compacting = false;
	lastDecision: (TickDecision & { at: number }) | undefined;

	private readonly pi: ExtensionAPI;
	private readonly now: () => number;
	readonly settingsPath: string;
	private timer: NodeJS.Timeout | undefined;
	private expiryTimer: NodeJS.Timeout | undefined;
	private nextWakeAt: number | undefined;
	private wakePending = false;
	private sessionCtx: ExtensionContext | undefined;
	private continuationIntent: ContinuationIntent | undefined;
	private runOrigin: RunOrigin | undefined;
	/** The active loop's ledger, or undefined when it could not be created. */
	ledger: LedgerPaths | undefined;
	private ledgerWarned = false;
	private readonly agentDir: string | undefined;
	private readonly expiryTurnGraceMs: number;
	/** Consecutive fallback wakes that produced a no-op turn. */
	noOpStreak = 0;
	lastContinuation: (ContinuationDecision & { at: number }) | undefined;
	private readonly waitTimer = new LoopWaitTimer();
	/**
	 * Loop-caused deliveries that never produced an agent run. A provider that
	 * refuses before the first token — no API key, a torn-down runner — never
	 * reaches agent_end, so no classifier ever sees it.
	 */
	private deadDeliveries = 0;
	private awaitingRun = false;
	/** Set when an interrupted turn needs a compaction before the loop continues. */
	private compactionRequested = false;
	/**
	 * When the in-flight run started, or undefined between runs.
	 *
	 * A session blocked on a modal prompt — a permission approval, a question,
	 * anything that waits for a human — is `busy`, and `busy` makes every
	 * continuation and every fallback tick skip. No turn completes, so the cap
	 * never trips and the no-progress breaker (which counts turns) never fires.
	 * Expiry is the only thing left, up to seven days later. The engine cannot
	 * see the prompt, but it can see that a run has been open far longer than
	 * work usually takes, which is enough to put an attention state on the
	 * widget instead of a cheerful next-wake time.
	 */
	private busySince: number | undefined;
	/** How long the current run has been open, once past the stall threshold. */
	private blockedForMs: number | undefined;
	/**
	 * Loop planning: the drafting conversation that precedes a loop.
	 *
	 * In-memory on purpose. A draft is a short interactive flow, and persisting
	 * it would mean a half-written objective could outlive the conversation that
	 * produced it and be approved later out of context. The loop it becomes is
	 * persisted; the draft is not.
	 */
	planning: LoopPlanningState = { active: false };

	constructor(pi: ExtensionAPI, options: LoopControllerOptions = {}) {
		this.pi = pi;
		this.now = options.now ?? Date.now;
		this.settingsPath = options.settingsPath ?? loopSettingsPath();
		this.agentDir = options.agentDir;
		this.expiryTurnGraceMs = options.expiryTurnGraceMs ?? EXPIRY_TURN_GRACE_MS;
	}

	// --- lifecycle ---

	onSessionStart(ctx: ExtensionContext): void {
		this.clearTimer();
		this.clearExpiryWatchdog();
		this.wakePending = false;
		this.compacting = false;
		this.lastDecision = undefined;
		this.lastContinuation = undefined;
		this.continuationIntent = undefined;
		this.runOrigin = undefined;
		this.noOpStreak = 0;
		this.deadDeliveries = 0;
		this.awaitingRun = false;
		this.busySince = undefined;
		this.blockedForMs = undefined;
		this.planning = { active: false };
		this.sessionCtx = ctx;

		const loaded = readLoopSettings(this.settingsPath);
		this.settings = loaded.settings;
		if (loaded.kind === "invalid") {
			ctx.ui.notify(`pi-loop settings ignored: ${loaded.reason}. Using defaults.`, "warning");
		}

		this.ledger = undefined;
		this.ledgerWarned = false;
		this.state = restoreLoopState(ctx.sessionManager.getBranch());
		// A restored loop is running from this moment, so the signal other
		// extensions read has to be true again before the first tool call of the
		// session, not only after the first state change.
		publishLoopEnv(this.state);
		if (this.state && this.state.status === "active") {
			if (this.now() >= this.state.expiresAt) {
				this.transition("stopped", "loop expired while the session was away");
				return;
			}
			if (this.state.objective === undefined && this.adoptLegacyObjective(ctx)) return;
			// A restored loop keeps its ledger: createLedger only ever creates
			// PROGRESS.md, so days of agent-written state survive a restart.
			this.openLedger(this.state);
			// A wait whose deadline passed while the session was away is due now.
			this.restoreWaitTimer();
			this.armFallback();
			this.armExpiryWatchdog();
			// A loop handed over from another session has never had its first turn.
			if (this.state.handoff) this.consumeHandoff(ctx);
		}
		this.updateWidget();
	}

	/**
	 * Take delivery of a loop handed to this session, and start working it.
	 *
	 * The flag is cleared first and persisted immediately: a handoff is
	 * consumed exactly once, and a session that crashed between restoring and
	 * kicking off must not re-anchor the objective on the next start.
	 */
	private consumeHandoff(ctx: ExtensionContext): void {
		const loop = this.state;
		if (!loop) return;
		const { handoff: _handoff, ...rest } = loop;
		this.state = rest;
		this.persist();
		ctx.ui.notify(
			"Loop started in this session: only the objective crossed over, not the planning conversation. It works from now, continuing at every idle boundary until the criteria are met (loop_complete), a cap is reached, or you stop it from the /loop menu.",
			"info",
		);
		this.sendKickoffAnchor(ctx);
		this.requestContinuation(rest, "kickoff");
		this.dispatchContinuationIfSettled(ctx);
	}

	onSessionShutdown(): void {
		// Withdraw the signal: the process may outlive this session.
		publishLoopEnv(undefined);
		this.clearTimer();
		this.clearExpiryWatchdog();
		this.waitTimer.clear();
		this.wakePending = false;
		this.continuationIntent = undefined;
		this.runOrigin = undefined;
		if (this.sessionCtx) clearLoopWidget(this.sessionCtx.ui);
		this.sessionCtx = undefined;
	}

	/**
	 * A finished agent run with an active loop is the signal that paces it:
	 * record the *intent* to continue here and let the settled boundary decide
	 * whether it may be delivered. Recording at agent_end (not at settle) is
	 * what makes the intent survive Pi's own retries and auto-compaction, which
	 * run between the two events.
	 */
	/** A run started, so the delivery that caused it was not a dead one. */
	onAgentStart(ctx: ExtensionContext): void {
		this.sessionCtx = ctx;
		this.awaitingRun = false;
		this.deadDeliveries = 0;
		this.busySince = this.now();
		this.blockedForMs = undefined;
	}

	onAgentEnd(ctx: ExtensionContext, messages: readonly unknown[] = []): void {
		this.sessionCtx = ctx;
		this.awaitingRun = false;
		// A completed turn is proof the session was not blocked on a human.
		this.busySince = undefined;
		this.blockedForMs = undefined;
		const origin = this.runOrigin;
		this.runOrigin = undefined;
		const loop = this.state;
		if (!loop || loop.status !== "active") return;
		if (this.enforceToolAvailability(ctx)) return;
		// The expiry's final turn is the last one: never queue a continuation
		// behind it. The settle that follows stops the loop.
		if (loop.expiring) return;
		// A user turn cancels a wait: whatever they just said outranks it. The
		// reason survives as a hint on the next loop message.
		if (origin === undefined && loop.waiting) this.cancelWait("a user message arrived");
		this.recordProgress(origin, messages);
		if (this.classifyAndHandleInterruption(ctx, messages, origin)) return;
		if (this.enforceNoProgress(ctx, messages, origin)) return;
		// A turn that ended in loop_wait asked not to be continued.
		if (this.state?.waiting) return;
		if (this.state) this.requestContinuation(this.state);
	}

	/**
	 * Act on how the turn ended. A loop that answers every provider failure
	 * with "continue" retries into exhausted quotas and re-sends requests that
	 * are too large to succeed; each class needs its own answer. Returns true
	 * when the interruption was handled and no continuation should be recorded.
	 */
	private classifyAndHandleInterruption(
		ctx: ExtensionContext,
		messages: readonly unknown[],
		origin: RunOrigin | undefined,
	): boolean {
		const loop = this.state;
		if (!loop) return true;
		switch (classifyInterruption(messages)) {
			case "usage-limited":
				this.transition(
					"paused",
					"the provider reports the usage limit is reached; resume it from the /loop menu once it resets",
					"usage limit reached",
				);
				return true;
			case "fatal":
				this.transition(
					"paused",
					"the turn failed with an error a retry cannot fix; resolve it, then resume it from the /loop menu",
					"unrecoverable provider error",
				);
				return true;
			case "aborted":
				// Esc, or another extension stopping the turn. A loop-caused run
				// that the user interrupted must not be immediately re-sent.
				if (origin === undefined) return false;
				this.transition("paused", "the turn was interrupted; resume it from the /loop menu", "interrupted");
				return true;
			case "context-overflow":
				// The request no longer fits: compact first, then continue. The
				// re-anchor that follows the compaction is the continuation.
				this.compactionRequested = true;
				ctx.ui.notify(
					"pi-loop: the turn overflowed the context window; compacting before continuing.",
					"warning",
				);
				return true;
			default:
				// "none" and "retryable" both continue: a transient provider error
				// is exactly what the next continuation retries.
				return false;
		}
	}

	/**
	 * The no-progress breaker: consecutive tool-free loop turns with identical
	 * visible output pause the loop instead of waking it again forever. It
	 * pauses rather than stops, so the loop stays configured and one
	 * Resuming from the /loop menu (or the next user prompt) puts it back to work.
	 */
	private enforceNoProgress(
		ctx: ExtensionContext,
		messages: readonly unknown[],
		origin: RunOrigin | undefined,
	): boolean {
		const loop = this.state;
		if (!loop) return true;
		const limit = this.settings.noProgressTurns;
		if (origin === undefined) {
			// Any user input resets the safety epoch: the user has seen the
			// output and chosen to keep going.
			if (loop.toolFreeRepeatCount !== undefined || loop.lastFingerprint !== undefined) {
				this.state = { ...loop, toolFreeRepeatCount: 0, lastFingerprint: undefined };
				this.persist();
			}
			return false;
		}
		if (limit === null) return false;
		// A turn that called loop_wait declared a wait; that is a decision, not a
		// stall, and counting it is the classic false positive.
		const toolAttempted = hasAssistantToolCall(messages) || calledTool(messages, LOOP_WAIT_TOOL);
		const next = nextNoProgressState(
			{
				toolFreeRepeatCount: loop.toolFreeRepeatCount ?? 0,
				...(loop.lastFingerprint === undefined ? {} : { lastFingerprint: loop.lastFingerprint }),
			},
			messages,
			toolAttempted,
		);
		this.state = {
			...loop,
			toolFreeRepeatCount: next.toolFreeRepeatCount,
			...(next.lastFingerprint === undefined ? {} : { lastFingerprint: next.lastFingerprint }),
		};
		if (next.toolFreeRepeatCount < limit) {
			this.persist();
			return false;
		}
		void ctx;
		this.transition(
			"paused",
			`${next.toolFreeRepeatCount} loop turns in a row produced the same answer and called no tools; the loop is still configured, so resuming from the /loop menu (or your next message) continues it`,
			"no progress",
		);
		return true;
	}

	/**
	 * Fallback backoff bookkeeping. A user-driven turn, or any loop-caused turn
	 * that actually did something, resets the streak; only a fallback wake that
	 * produced a no-op turn grows the next fallback delay.
	 */
	private recordProgress(origin: RunOrigin | undefined, messages: readonly unknown[]): void {
		if (origin === undefined) {
			// A turn the user drove: the loop is not the thing spinning.
			this.noOpStreak = 0;
			return;
		}
		// An explicit LOOP_OK is the deterministic version of the same signal:
		// the model looked and there was nothing to do. It counts even when the
		// turn used a tool to look.
		if (!isNoOpRun(messages) && !isLoopOkAck(messages)) {
			this.noOpStreak = 0;
			return;
		}
		if (origin === "fallback") this.noOpStreak += 1;
	}

	onAgentSettled(ctx: ExtensionContext): void {
		this.sessionCtx = ctx;
		if (!this.state || this.state.status !== "active") return;
		if (this.maybeStartCompaction(ctx)) return;
		if (this.settleTerminalState(ctx)) return;
		if (this.dispatchContinuationIfSettled(ctx)) return;
		if (this.wakePending) {
			this.wakePending = false;
			this.runTick(ctx);
			return;
		}
		// Re-arm the heartbeat from this settle, so it can only fire after a full
		// interval of genuine idleness.
		this.armFallback();
	}

	/**
	 * A settled boundary with no wake pending still evaluates the terminal
	 * decisions — expiry and the caps — so the loop settles the moment the work
	 * does instead of up to one interval later. Poke and skip decisions are
	 * deliberately ignored here: only the timer pokes, and settling is not a
	 * schedule.
	 */
	private settleTerminalState(ctx: ExtensionContext): boolean {
		const loop = this.state;
		if (!loop) return false;
		const env = this.gatherEnvironment(ctx);
		const decision = decideTick(loop, env);
		if (decision.action !== "expire" && decision.action !== "stop") return false;
		this.lastDecision = { ...decision, at: env.now };
		this.applyTerminalDecision(loop, decision);
		return true;
	}

	/**
	 * The restore shim for a loop persisted before 0.6.0.
	 *
	 * Such a loop may carry no objective of its own: it delegated "is the work
	 * done" to a goal in another extension that no longer exists here. The only
	 * case that can still reach this code is a session persisted before 0.6.0
	 * and resumed after it, having never been restored under 0.5.0 — where it
	 * would already have been converted.
	 *
	 * Its focus text, when it has one, is the closest thing to an objective it
	 * has, so adopt that. With nothing to adopt there is no honest way to run
	 * it, so it pauses and says so.
	 *
	 * Returns true when the loop was paused and needs no timer.
	 */
	private adoptLegacyObjective(ctx: ExtensionContext): boolean {
		const loop = this.state;
		if (!loop) return true;
		const objective = loop.prompt;
		if (!objective) {
			this.transition(
				"paused",
				"it was bound to a goal that is gone and has no objective of its own; run /loop to plan and approve a new one",
				"loop with no objective",
			);
			return true;
		}
		const { prompt: _prompt, ...rest } = loop;
		this.state = { ...rest, objective };
		this.persist();
		ctx.ui.notify(
			`This loop predates pi-loop owning its own objective; it now works its focus text directly: ${objective}`,
			"info",
		);
		return false;
	}

	/**
	 * A loop that cannot call `loop_complete` cannot end itself: it will work,
	 * finish, and then be told to keep working until it hits a cap.
	 * That happens whenever the tool set is restricted (`--tools`, `--no-tools`,
	 * a policy that drops extension tools), and it is invisible from inside the
	 * loop — so check the live tool set and pause instead of spinning.
	 *
	 * Returns true when the loop was paused.
	 */
	private enforceToolAvailability(ctx: ExtensionContext): boolean {
		const loop = this.state;
		if (!loop || loop.status !== "active") return false;
		if (this.completeToolAvailable()) return false;
		this.transition(
			"paused",
			`the ${LOOP_COMPLETE_TOOL} tool is not available in this session, so the loop could never end itself; re-enable it, then resume the loop from the /loop menu`,
			"loop_complete unavailable",
		);
		void ctx;
		return true;
	}

	private completeToolAvailable(): boolean {
		const getActiveTools = (this.pi as { getActiveTools?: () => string[] }).getActiveTools;
		if (typeof getActiveTools !== "function") return true;
		try {
			// Fail open: a host that cannot report its tools is not evidence that
			// the tool is missing.
			return getActiveTools.call(this.pi).includes(LOOP_COMPLETE_TOOL);
		} catch {
			return true;
		}
	}

	/**
	 * Count a delivery that never became a run, and pause once the loop is
	 * plainly shouting into a void. Without this a session whose provider
	 * refuses every request (no API key, a revoked token) keeps waking on the
	 * heartbeat until it exhausts its wake cap, because a run that fails before
	 * the first token never reaches agent_end and so is never classified.
	 *
	 * Returns true when the loop was paused.
	 */
	private noteDelivery(): boolean {
		if (this.awaitingRun) this.deadDeliveries += 1;
		this.awaitingRun = true;
		if (this.deadDeliveries < MAX_DEAD_DELIVERIES) return false;
		this.transition(
			"paused",
			`${this.deadDeliveries} loop messages in a row produced no turn at all, so something is refusing every request; fix it, then resume the loop from the /loop menu`,
			"deliveries produce no turns",
		);
		return true;
	}

	// --- loop_wait ---

	/**
	 * Enter an external wait. The pacemaker is deliberately left armed: a wait
	 * supersedes the *next* fallback wake, it does not disable the heartbeat,
	 * so a wait whose event never arrives still ends in a wake rather than in
	 * silence.
	 */
	enterWait(reason: string, resumeAfterMs: number | undefined): ResolvedWaitDelay | undefined {
		const loop = this.state;
		if (!loop || loop.status !== "active") return undefined;
		const resolved = resolveWaitDelay(resumeAfterMs);
		const waiting = createLoopWait(reason, resumeAfterMs, this.now());
		// The wait replaces any continuation already recorded for this turn.
		this.continuationIntent = undefined;
		const { cancelledWaitReason: _cancelled, ...rest } = loop;
		this.state = { ...rest, waiting };
		this.persist();
		this.restoreWaitTimer();
		this.updateWidget();
		return resolved;
	}

	/**
	 * Drop a wait that something other than its own deadline ended, keeping its
	 * reason as a one-shot hint for the next loop message. There is no cancel
	 * tool: the events that legitimately cancel a wait are not the model's to
	 * report.
	 */
	private cancelWait(_why: string): void {
		const loop = this.state;
		if (!loop?.waiting) return;
		const { waiting, ...rest } = loop;
		this.waitTimer.clear();
		this.state = { ...rest, cancelledWaitReason: waiting.reason };
		this.persist();
		this.updateWidget();
	}

	/** Re-arm the wait deadline, including after a restore or a compaction. */
	private restoreWaitTimer(): void {
		this.waitTimer.clear();
		const loop = this.state;
		const resumeAt = loop?.status === "active" ? loop.waiting?.resumeAt : undefined;
		if (resumeAt === undefined) return;
		const loopId = loop?.id;
		this.waitTimer.schedule(
			resumeAt,
			() => {
				const ctx = this.sessionCtx;
				if (!ctx || this.state?.id !== loopId) return;
				try {
					this.runTick(ctx);
				} catch (error) {
					ctx.ui.notify(`pi-loop wait deadline failed: ${formatError(error)}`, "warning");
				}
			},
			this.now(),
		);
	}

	/** The wait a delivered wake consumed, cleared as the wake goes out. */
	private consumeWait(loop: LoopState): LoopState {
		const { waiting: _waiting, cancelledWaitReason: _cancelled, ...rest } = loop;
		this.waitTimer.clear();
		return rest;
	}

	// --- ledger ---

	/**
	 * Create (or adopt) the loop's ledger. Best-effort by design: a loop with
	 * no writable ledger still runs, it just loses the durable record, so the
	 * failure is warned once and never repeated.
	 *
	 * `criteria` is passed at start: the criteria approved with the draft, or
	 * the deterministic split of the objective. On restore it is omitted, and
	 * the criteria already on disk are authoritative — they are the ones the
	 * user saw echoed, and re-deriving them would both discard a proposed set
	 * and reset whatever `passes` flips the loop has earned.
	 */
	private openLedger(loop: LoopState, criteria?: LoopCriterion[]): void {
		if (loop.objective === undefined) {
			this.ledger = undefined;
			return;
		}
		const paths = ledgerPaths(loop.id, this.agentDir);
		const contents = criteria ?? readCriteria(paths) ?? deriveCriteria(loop.objective);
		const failure = createLedger(paths, loop.objective, contents);
		if (failure) {
			this.ledger = undefined;
			if (!this.ledgerWarned) {
				this.ledgerWarned = true;
				this.sessionCtx?.ui.notify(
					`pi-loop could not write its ledger (${failure}). The loop runs without one.`,
					"warning",
				);
			}
			return;
		}
		this.ledger = paths;
	}

	/**
	 * Write a built loop's ledger without installing the loop.
	 *
	 * The fresh-session launch needs the approved criteria on disk *before* the
	 * new session restores the state, because the restore path treats an
	 * existing `criteria.json` as authoritative and would otherwise re-derive
	 * its own. Returns a failure detail, or undefined on success.
	 */
	prepareLedgerFor(built: BuiltLoop): string | undefined {
		const objective = built.loop.objective;
		if (objective === undefined) return "the loop has no objective";
		return createLedger(ledgerPaths(built.loop.id, this.agentDir), objective, built.criteria);
	}

	/** The loop's criteria as last written to disk, fail-open. */
	criteria() {
		return this.ledger ? readCriteria(this.ledger) : undefined;
	}

	// --- settle-driven continuation ---

	/** Record the intent to continue; the settled boundary decides delivery. */
	private requestContinuation(
		loop: LoopState,
		kind: ContinuationKind = "continue",
		nextActions?: string,
	): void {
		// A re-anchor outranks an ordinary continuation already queued: after a
		// compaction, "re-read the ledger" is strictly the better instruction.
		if (this.continuationIntent?.loopId === loop.id && kind !== "reanchor") return;
		this.continuationIntent = { loopId: loop.id, kind, ...(nextActions ? { nextActions } : {}) };
	}

	/**
	 * Deliver a recorded continuation, but only at a boundary where Pi will
	 * actually accept it. A skip leaves the intent in place for the next
	 * settle; a terminal decision consumes it.
	 */
	dispatchContinuationIfSettled(ctx: ExtensionContext): boolean {
		const intent = this.continuationIntent;
		if (!intent) return false;
		const loop = this.state;
		if (!loop || loop.id !== intent.loopId) {
			this.continuationIntent = undefined;
			return false;
		}
		const env = this.gatherEnvironment(ctx);
		const decision = decideContinuation(loop, env);
		this.lastContinuation = { ...decision, at: env.now };
		if (decision.action === "none") {
			this.continuationIntent = undefined;
			return false;
		}
		if (decision.action === "skip") return false;
		if (decision.action !== "continue") {
			this.continuationIntent = undefined;
			this.lastDecision = { ...decision, at: env.now };
			this.applyTerminalDecision(loop, decision);
			return true;
		}
		try {
			this.pi.sendUserMessage(buildContinuation(loop, intent.kind, intent.nextActions));
		} catch (error) {
			// Keep the intent: the next settle retries it, and the fallback
			// heartbeat covers the case where no further settle arrives.
			this.sessionCtx?.ui.notify(
				`pi-loop could not continue the loop: ${formatError(error)}. Retrying at the next idle boundary.`,
				"warning",
			);
			this.armFallback();
			this.updateWidget();
			return false;
		}
		this.continuationIntent = undefined;
		this.runOrigin = "continuation";
		if (this.noteDelivery()) return true;
		// A continuation is the work the coalesced wake would have asked for.
		this.wakePending = false;
		this.state = { ...loop, automaticTurns: loop.automaticTurns + 1 };
		this.persist();
		this.armFallback();
		this.updateWidget();
		return true;
	}

	// --- tick machinery ---

	/**
	 * Arm the fallback heartbeat, backing off while consecutive fallback wakes
	 * keep producing no-op turns.
	 */
	private armFallback(): void {
		const loop = this.state;
		if (!loop || loop.status !== "active") return;
		this.scheduleTick(this.fallbackDelayMs(loop));
	}

	fallbackDelayMs(loop: LoopState): number {
		const multiplier = Math.min(MAX_FALLBACK_BACKOFF, 2 ** this.noOpStreak);
		return Math.min(MAX_INTERVAL_MS, loop.intervalMs * multiplier);
	}

	private scheduleTick(delayMs: number): void {
		this.clearTimer();
		this.nextWakeAt = this.now() + delayMs;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			// Nothing is scheduled once the timer has fired. `runTick` re-arms it
			// through `scheduleTick` when it pokes, but a busy or compacting
			// session coalesces into `wakePending` instead — and leaving the old
			// deadline here made the /loop status screen report a clock time that had
			// already passed.
			this.nextWakeAt = undefined;
			const ctx = this.sessionCtx;
			if (!ctx) return;
			this.runTick(ctx);
		}, delayMs);
		// Never hold the process open for a wakeup.
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.nextWakeAt = undefined;
	}

	private armExpiryWatchdog(): void {
		this.clearExpiryWatchdog();
		const loop = this.state;
		if (!loop || loop.status !== "active") return;
		const loopId = loop.id;
		const delay = Math.min(MAX_INTERVAL_MS, Math.max(0, loop.expiresAt - this.now()));
		this.expiryTimer = setTimeout(() => {
			this.expiryTimer = undefined;
			const current = this.state;
			if (!current || current.id !== loopId || current.status !== "active") return;
			if (this.now() < current.expiresAt) {
				this.armExpiryWatchdog();
				return;
			}
			const ctx = this.sessionCtx;
			if (!ctx) {
				this.transition("stopped", "loop expired without an active session context");
				return;
			}
			const planActive = readPlanModeEnabled(ctx.sessionManager.getBranch());
			const busy = !ctx.isIdle() || ctx.hasPendingMessages();
			if (planActive || busy) {
				this.transition(
					"stopped",
					planActive
						? "loop expired while Plan mode was active"
						: "loop expired while the agent was busy",
				);
				return;
			}
			this.runTick(ctx);
		}, delay);
		this.expiryTimer.unref?.();
	}

	private clearExpiryWatchdog(): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = undefined;
	}

	/**
	 * The other half of expiry: the wake was handed to Pi, and this stops the
	 * loop if it never becomes a run. A run that *did* start leaves
	 * `awaitingRun` false, and the settle after it stops the loop normally.
	 */
	private armExpiryTurnGuard(loopId: string): void {
		this.clearExpiryWatchdog();
		this.expiryTimer = setTimeout(() => {
			this.expiryTimer = undefined;
			const current = this.state;
			if (!current || current.id !== loopId || current.status !== "active") return;
			if (!this.awaitingRun) return;
			this.transition("stopped", "the final expiry turn never started");
		}, this.expiryTurnGraceMs);
		this.expiryTimer.unref?.();
	}

	private gatherEnvironment(ctx: ExtensionContext): TickEnvironment {
		const branch = ctx.sessionManager.getBranch();
		return {
			now: this.now(),
			busy: !ctx.isIdle() || ctx.hasPendingMessages(),
			compacting: this.compacting,
			planModeEnabled: readPlanModeEnabled(branch),
		};
	}

	runTick(ctx: ExtensionContext): void {
		const loop = this.state;
		if (!loop) return;
		const env = this.gatherEnvironment(ctx);
		const decision = decideTick(loop, env);
		this.lastDecision = { ...decision, at: env.now };
		switch (decision.action) {
			case "none":
				return;
			case "skip":
				if (decision.reason === "plan-mode-active" || decision.reason === "loop-waiting") {
					// Plan mode may end without an agent_settled we can use, and a
					// wait supersedes only this one fallback wake — in both cases
					// keep the heartbeat armed rather than coalescing a wake that
					// would fire the moment the hold ends.
					this.armFallback();
				} else {
					// Busy or compacting: coalesce into one pending wake that
					// the next agent_settled (or compaction onComplete) delivers.
					this.wakePending = true;
					if (decision.reason === "agent-busy") this.noteBusyTick(env.now);
					// Keep the heartbeat armed while busy. Coalescing is about
					// deliveries, not about the timer: wakePending is a boolean, so a
					// further tick cannot produce a second wake. Without re-arming,
					// the first busy tick would be the last one ever taken, and a
					// session blocked on a prompt would never be noticed at all.
					this.armFallback();
				}
				this.updateWidget();
				return;
			case "poke":
				this.deliverPoke(env.now, decision.reason);
				return;
			default:
				this.applyTerminalDecision(loop, decision);
				return;
		}
	}

	private applyTerminalDecision(
		loop: LoopState,
		decision: Extract<TickDecision, { action: "expire" | "stop" }>,
	): void {
		switch (decision.action) {
			case "expire":
				if (decision.reason === "expiry-final-wake" && this.deliverExpiryWake(loop)) return;
				this.transition("stopped", "loop expired (the expiry was reached)");
				return;
			case "stop":
				this.transition("stopped", `the ${loop.maxTurns}-turn cap was reached`);
				return;
		}
	}

	/**
	 * One last turn at expiry, so the loop's most recent state lands in the
	 * ledger instead of only in a conversation that is about to be closed. The
	 * loop stays active for exactly that turn — the objective append has to be
	 * present while it writes — and `expiring` makes the next settle stop it.
	 *
	 * Returns false when the wake could not be delivered, in which case the
	 * caller stops the loop immediately rather than leaving it alive past its
	 * expiry waiting for a turn that will not happen.
	 */
	private deliverExpiryWake(loop: LoopState): boolean {
		if (loop.expiring) return false;
		try {
			this.pi.sendUserMessage(buildExpiryWake(loop, this.ledger));
		} catch (error) {
			this.sessionCtx?.ui.notify(
				`pi-loop could not deliver the expiry wake: ${formatError(error)}. Stopping the loop.`,
				"warning",
			);
			return false;
		}
		this.runOrigin = "fallback";
		this.continuationIntent = undefined;
		// Marked directly rather than through noteDelivery(): the dead-delivery
		// counter pauses a loop that should keep trying, and this one is already
		// ending. The guard below is what acts on it.
		this.awaitingRun = true;
		this.state = {
			...this.consumeWait(loop),
			iteration: loop.iteration + 1,
			automaticTurns: loop.automaticTurns + 1,
			lastWakeAt: this.now(),
			expiring: true,
		};
		this.clearTimer();
		// The wake was accepted, not delivered. Hold one bounded guard so a final
		// turn that never starts still ends the loop instead of leaving it active
		// past its deadline with every timer cleared.
		this.armExpiryTurnGuard(loop.id);
		this.persist();
		this.updateWidget();
		this.sessionCtx?.ui.notify(
			"Loop expired: one final turn to write the current state down, then it stops.",
			"info",
		);
		return true;
	}

	/**
	 * Send first, then account. Pi can refuse the delivery (a busy or compacting
	 * session), and a turn persisted before the send would burn the cap on a
	 * poke that never arrived; on a throw the loop re-arms on the same cadence
	 * and retries at the next wake.
	 */
	private deliverPoke(now: number, reason: "objective-stalled" | "wait-elapsed"): void {
		const loop = this.state;
		if (!loop) return;
		try {
			this.pi.sendUserMessage(buildObjectivePoke(loop, reason));
		} catch (error) {
			this.sessionCtx?.ui.notify(
				`pi-loop could not deliver a wake: ${formatError(error)}. Retrying at the next interval.`,
				"warning",
			);
			this.armFallback();
			this.updateWidget();
			return;
		}
		this.runOrigin = "fallback";
		if (this.noteDelivery()) return;
		// The wake consumed the wait it was arranged for, and any one-shot
		// cancelled-wait hint it just carried.
		this.state = {
			...this.consumeWait(loop),
			iteration: loop.iteration + 1,
			automaticTurns: loop.automaticTurns + 1,
			lastWakeAt: now,
		};
		this.persist();
		this.armFallback();
		this.updateWidget();
	}

	private maybeStartCompaction(ctx: ExtensionContext): boolean {
		const loop = this.state;
		if (!loop || loop.status !== "active" || loop.compactAt === null) return false;
		if (!this.settings.compaction.enabled || this.compacting) return false;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return false;
		// A turn that overflowed the context window compacts regardless of the
		// threshold: the usage reading that would gate it is exactly the reading
		// the failed request just disproved.
		const requested = this.compactionRequested;
		this.compactionRequested = false;
		if (!requested) {
			const usage = ctx.getContextUsage();
			if (!usage || typeof usage.tokens !== "number" || !usage.contextWindow) return false;
			if (usage.tokens / usage.contextWindow < loop.compactAt) return false;
		}
		this.compacting = true;
		try {
			ctx.compact({
				customInstructions: buildCompactionInstructions(
					loop,
					this.settings.compaction.instructions,
					this.ledger,
				),
				onComplete: (result) => {
					this.compacting = false;
					this.requestReAnchor(result);
					this.nudgeHeldWake();
				},
				onError: (error) => {
					this.compacting = false;
					this.sessionCtx?.ui.notify(`pi-loop compaction failed: ${formatError(error)}`, "warning");
					this.nudgeHeldWake();
				},
			});
		} catch (error) {
			// A synchronous refusal (a torn-down runner) must not leave the loop
			// skipping every tick as compaction-in-flight for the rest of the
			// session.
			this.compacting = false;
			ctx.ui.notify(`pi-loop compaction could not start: ${formatError(error)}`, "warning");
			return false;
		}
		return true;
	}

	/**
	 * Own the post-compaction re-anchor instead of leaving the loop silent
	 * until the next fallback wake. One pointer-sized continuation at the next
	 * settle: the objective is in the system append, the record is in the
	 * ledger, and the next actions ride out of the summary that just replaced
	 * the conversation.
	 */
	private requestReAnchor(result: unknown): void {
		const loop = this.state;
		if (!loop || loop.status !== "active") return;
		const summary =
			isRecord(result) && typeof result.summary === "string" ? result.summary : undefined;
		this.requestContinuation(loop, "reanchor", summary ? extractNextActions(summary) : undefined);
	}

	/**
	 * A wake or continuation held during compaction delivers at the next
	 * settled boundary; nudge in case that boundary already passed while
	 * compaction ran.
	 */
	private nudgeHeldWake(): void {
		const ctx = this.sessionCtx;
		if (ctx && (this.wakePending || this.continuationIntent)) this.onAgentSettled(ctx);
	}

	// --- state transitions & presentation ---

	private transition(status: "paused" | "stopped", why: string, cause?: string): void {
		if (!this.state) return;
		const {
			waiting: _waiting,
			pauseCause: _pauseCause,
			terminalReason: _terminalReason,
			...rest
		} = this.state;
		this.state = {
			...rest,
			status,
			...(cause ? { pauseCause: cause } : {}),
			...(status === "stopped" ? { terminalReason: why } : {}),
		};
		this.clearTimer();
		this.clearExpiryWatchdog();
		this.waitTimer.clear();
		this.wakePending = false;
		this.continuationIntent = undefined;
		this.runOrigin = undefined;
		this.persist();
		this.sessionCtx?.ui.notify(`Loop ${status}: ${why}.`, "info");
		this.updateWidget();
	}

	persist(): void {
		if (!this.state) return;
		// Every state change funnels through here, which makes it the one place
		// the loop-active signal can be published without a caller remembering to.
		publishLoopEnv(this.state);
		this.pi.appendEntry(LOOP_STATE_ENTRY_TYPE, { loop: this.state });
	}

	/**
	 * A run has been open past the stall threshold, so the most likely
	 * explanation is a prompt waiting for a human. Reported, never acted on:
	 * approving on the user's behalf is exactly the boundary pi-auto-permissions
	 * exists to hold.
	 */
	private noteBusyTick(now: number): void {
		const since = this.busySince;
		if (since === undefined) return;
		const openFor = now - since;
		this.blockedForMs = openFor >= STALL_ATTENTION_MS ? openFor : undefined;
	}

	/**
	 * The view both surfaces render, or undefined when there is nothing to show.
	 *
	 * One function feeds the widget and the footer because two hand-rolled
	 * formatters drifted: the footer handled `loop.waiting` and the widget did
	 * not, so a loop blocked on CI read as an ordinary scheduled loop above the
	 * editor while the footer said it was waiting.
	 */
	widgetView(): LoopWidgetView | undefined {
		const loop = this.state;
		if (!loop || loop.status === "stopped") {
			if (!this.planning.active) return undefined;
			const proposed = this.planning.proposal?.criteria.length;
			return { kind: "planning", ...(proposed === undefined ? {} : { proposedCriteria: proposed }) };
		}
		const criteria = this.criteriaProgress();
		return {
			kind: "loop",
			loop,
			wakePending: this.wakePending,
			nextWakeAt: this.nextWakeAt,
			...(criteria ? { criteria } : {}),
			...(this.blockedForMs === undefined ? {} : { blockedForMs: this.blockedForMs }),
			now: this.now(),
		};
	}

	/**
	 * Criteria progress for the widget. Re-read rather than cached: this runs on
	 * discrete state transitions, not per frame, and a stale count right after a
	 * criterion is marked would undercut the one number the line exists to show.
	 */
	private criteriaProgress(): { met: number; total: number } | undefined {
		const criteria = this.criteria();
		if (!criteria || criteria.length === 0) return undefined;
		return { met: criteria.filter((criterion) => criterion.passes).length, total: criteria.length };
	}

	updateWidget(): void {
		const ui = this.sessionCtx?.ui;
		if (!ui) return;
		const view = this.widgetView();
		updateLoopWidget(ui, view);
		ui.setStatus(LOOP_STATUS_KEY, view ? loopWidgetLine(view) : undefined);
	}

	statusLines(ctx: ExtensionContext): string[] {
		const loop = this.state;
		if (!loop) return ["No loop in this session. Run /loop to plan one."];
		const lines = [
			`Status: ${loop.status}${loop.pauseCause ? ` (${loop.pauseCause})` : loop.terminalReason ? ` (${loop.terminalReason})` : ""}`,
			...(loop.waiting
				? [
						`Waiting: ${loop.waiting.reason}${
							loop.waiting.resumeAt
								? ` (wakes ${formatClock(loop.waiting.resumeAt)})`
								: " (no deadline)"
						}`,
				  ]
				: []),
			...(loop.cancelledWaitReason
				? [`Cancelled wait (reported on the next wake): ${loop.cancelledWaitReason}`]
				: []),
			`Interval: every ${formatDuration(loop.intervalMs)}`,
			`Loop turns: ${loop.automaticTurns}${loop.maxTurns === null ? " (unlimited)" : ` of ${loop.maxTurns}`}`,
			`Fallback wakes delivered: ${loop.iteration}`,
			`Started: ${new Date(loop.startedAt).toLocaleString()}`,
			`Expires: ${new Date(loop.expiresAt).toLocaleString()}`,
			`Proactive compaction: ${loop.compactAt === null ? "off" : `at ${Math.round(loop.compactAt * 100)}% of context`}`,
		];
		if (loop.objective) {
			lines.push(`Objective: ${loop.objective}`);
			if (this.ledger) {
				const criteria = this.criteria();
				lines.push(`Ledger: ${this.ledger.dir}`);
				if (criteria) {
					const met = criteria.filter((criterion) => criterion.passes).length;
					lines.push(`Criteria: ${met}/${criteria.length} marked passing`);
					lines.push(
						...criteria.map(
							(criterion) =>
								`  [${criterion.passes ? "x" : " "}] ${criterion.id}. ${criterion.description}`,
						),
					);
				} else {
					lines.push("Criteria: unreadable (the loop runs without them)");
				}
			} else {
				lines.push("Ledger: unavailable (the loop runs without one)");
			}
		}
		if (loop.prompt) lines.push(`Focus: ${loop.prompt}`);
		// A pending wake is delivered at the next settle, whatever the timer says.
		// The heartbeat stays armed while the agent is busy so a stalled session is
		// still noticed, which means nextWakeAt can be set here even though no wake
		// will fire at that time — claiming it would be a stale clock time.
		if (this.nextWakeAt && !this.wakePending && loop.status === "active") {
			lines.push(
				`Next fallback wake: ${formatClock(this.nextWakeAt)}${
					this.noOpStreak > 0
						? ` (backed off ×${Math.min(MAX_FALLBACK_BACKOFF, 2 ** this.noOpStreak)} after ${this.noOpStreak} no-op wake${this.noOpStreak === 1 ? "" : "s"})`
						: ""
				}`,
			);
		}
		if (this.continuationIntent) {
			lines.push("A continuation is queued for the next idle boundary.");
		}
		if (this.wakePending) lines.push("A wake is pending delivery at the next idle boundary.");
		if (this.lastDecision) {
			const { action, reason, at } = this.lastDecision;
			lines.push(`Last tick: ${action} (${reason}) at ${formatClock(at)}`);
		}
		return lines;
	}

	// --- planning ---

	/**
	 * Open the drafting conversation. Idempotent: running /loop again while
	 * planning shows the current draft rather than restarting the flow.
	 */
	beginPlanning(): void {
		this.planning = { active: true };
		this.updateWidget();
	}

	/** Record a drafted loop for approval, replacing any previous draft. */
	propose(objective: string, overrides: LoopProposalOverrides = {}): LoopProposal {
		const proposal = buildProposal(
			objective,
			{
				intervalMs: parseDuration(this.settings.defaultInterval) ?? 600_000,
				maxTurns: this.settings.maxTurns,
				expiresInMs: parseDuration(this.settings.maxLoopDuration) ?? 604_800_000,
			},
			this.now(),
			overrides,
		);
		// A new draft supersedes the last one, so the card that was shown for the
		// old draft no longer describes what would start.
		this.planning = { active: true, proposal };
		this.updateWidget();
		return proposal;
	}

	/**
	 * Render the current draft's approval card, at most once per draft.
	 *
	 * Called by `loop_propose` when the draft is created and by `/loop` when the
	 * user reopens the actions, so the card is present whichever way they got
	 * here without a second copy appearing when they got here both ways.
	 */
	showProposalCard(ctx: ExtensionContext): boolean {
		const proposal = this.planning.proposal;
		if (!proposal) return false;
		if (this.planning.cardShownAt === proposal.proposedAt) return false;
		if (!showLoopProposalCard(this.pi, ctx, proposal)) return false;
		this.planning = { ...this.planning, cardShownAt: proposal.proposedAt };
		return true;
	}

	endPlanning(): void {
		this.planning = { active: false };
		this.updateWidget();
	}

	// --- command actions ---

	/**
	 * Start a loop on its own objective, the only mode there is: the trailing
	 * text *is* what the loop works on and what `loop_complete` answers for.
	 * With no text there is nothing to work on, and the caller is told so.
	 *
	 * Build and install are separate below, and this is the two of them in the
	 * order they have always run. The split exists because "construct a loop"
	 * and "make this session the one running it" were one indivisible pass, and
	 * a fresh-session launch needs the first without the second: the state has
	 * to exist before `ctx.newSession` so its `setup` can append it to the new
	 * session, and it must not be installed here or the launching session would
	 * start working the objective it is handing away.
	 */
	startLoop(ctx: ExtensionContext, start: LoopStartArguments): LoopStartResult {
		this.sessionCtx = ctx;
		const built = this.buildLoop(start);
		if (!built.ok) return built;
		return this.installLoop(ctx, built.built);
	}

	/**
	 * Construct a loop's state and criteria without installing anything.
	 *
	 * Pure with respect to the session: no `this.state`, no ledger on disk, no
	 * timer, no widget, no message. Everything it reads (settings, the clock,
	 * the tool set) is read-only, so a caller may build a loop it intends to
	 * install somewhere else — or discard.
	 */
	buildLoop(start: LoopStartArguments): LoopBuildResult {
		const now = this.now();
		const objective = start.prompt?.trim();
		if (!objective) {
			return {
				ok: false,
				message:
					"A loop needs something to work on. Run /loop and draft an objective with completion criteria first.",
			};
		}
		// A loop with no way to call loop_complete would work, finish, and then be
		// told to keep working until it hit a cap. Refuse at the door rather than
		// after the first turn.
		if (!this.completeToolAvailable()) {
			return {
				ok: false,
				message: `This session has no ${LOOP_COMPLETE_TOOL} tool, so a loop could never end itself. Re-enable it (it is excluded by --tools/--no-tools or a tool policy) and start the loop again.`,
			};
		}
		const expiryMs =
			start.expiresInMs ?? parseDuration(this.settings.maxLoopDuration) ?? 604_800_000;
		const compactAt =
			start.compactAt !== undefined
				? start.compactAt
				: this.settings.compaction.enabled
					? this.settings.compaction.threshold
					: null;
		const groundRules = normalizeGroundRules(start.groundRules);
		const loop: LoopState = {
			id: randomUUID().slice(0, 8),
			status: "active",
			objective,
			...(groundRules ? { groundRules } : {}),
			intervalMs: start.intervalMs,
			maxTurns: start.maxTurns !== undefined ? start.maxTurns : this.settings.maxTurns,
			compactAt,
			iteration: 0,
			automaticTurns: 0,
			startedAt: now,
			expiresAt: now + expiryMs,
		};
		return {
			ok: true,
			built: {
				loop,
				criteria: start.criteria
					? criteriaFromDescriptions(start.criteria)
					: deriveCriteria(objective),
				expiryMs,
				clamped: start.clamped,
				requestedMs: start.requestedMs,
			},
		};
	}

	/**
	 * Install a built loop into `ctx`'s session: adopt it as the live state,
	 * open its ledger, persist, arm the fallback, anchor the objective and kick
	 * off the first turn. This is the half that makes a session *the* session
	 * running the loop, and it is the half a fresh-session launch runs over
	 * there rather than here.
	 */
	installLoop(ctx: ExtensionContext, built: BuiltLoop): LoopStartResult {
		this.sessionCtx = ctx;
		const started = built.loop;
		this.state = started;
		this.wakePending = false;
		this.continuationIntent = undefined;
		this.noOpStreak = 0;
		this.ledgerWarned = false;
		this.openLedger(started, built.criteria);
		this.persist();
		this.scheduleTick(started.intervalMs);
		this.armExpiryWatchdog();
		this.updateWidget();
		const clampNote = built.clamped
			? ` (requested ${formatDuration(built.requestedMs)}, clamped to the ${formatDuration(started.intervalMs)} minimum)`
			: "";
		ctx.ui.notify(
			`Loop started: working its objective from now, continuing at every idle boundary until the criteria are met (loop_complete), a cap is reached, or you stop it from the /loop menu. Fallback wake every ${formatDuration(started.intervalMs)}${clampNote} if the session goes quiet. Expires in ${formatDuration(built.expiryMs)} (one final turn to write its state down, then it stops).`,
			"info",
		);
		if (this.ledger) {
			const criteria = this.criteria() ?? [];
			ctx.ui.notify(
				[
					`Loop ledger: ${this.ledger.dir}`,
					`Completion criteria (${criteria.length}) — loop_complete answers for these:`,
					...criteria.map((criterion) => `  ${criterion.id}. ${criterion.description}`),
				].join("\n"),
				"info",
			);
		}
		// The kickoff anchor: one stored message per loop holding the objective
		// data, because the system append exists only while the loop is active.
		this.sendKickoffAnchor(ctx);
		// Immediate kickoff: the loop starts working now instead of burning its
		// first interval idle. A busy session keeps the intent and delivers it at
		// the settle.
		this.requestContinuation(started, "kickoff");
		this.dispatchContinuationIfSettled(ctx);
		return { ok: true, loop: started };
	}



	/**
	 * Store the objective as an ordinary message so it outlives the loop.
	 *
	 * At an idle boundary `sendMessage` appends the message with no turn, which
	 * is exactly an anchor. While the agent streams the same call would *steer*
	 * the running turn, so a busy session gets `nextTurn` instead: queued as
	 * context alongside the next prompt, interrupting nothing.
	 */
	private sendKickoffAnchor(ctx: ExtensionContext): void {
		const loop = this.state;
		if (!loop || loop.objective === undefined || !this.ledger) return;
		const idle = ctx.isIdle() && !ctx.hasPendingMessages();
		try {
			this.pi.sendMessage(
				{
					customType: LOOP_ANCHOR_MESSAGE_TYPE,
					content: buildKickoffAnchor(loop, this.ledger),
					display: true,
					details: { loopId: loop.id },
				},
				idle ? {} : { deliverAs: "nextTurn" },
			);
		} catch (error) {
			// The anchor is a durability nicety; the loop runs without it.
			ctx.ui.notify(`pi-loop could not anchor the objective: ${formatError(error)}.`, "warning");
		}
	}

	pauseLoop(ctx: ExtensionContext): void {
		this.sessionCtx = ctx;
		if (!this.state || this.state.status !== "active") {
			ctx.ui.notify("No active loop to pause.", "warning");
			return;
		}
		this.transition("paused", "paused by user");
	}

	resumeLoop(ctx: ExtensionContext): void {
		this.sessionCtx = ctx;
		const loop = this.state;
		if (!loop || loop.status !== "paused") {
			ctx.ui.notify("No paused loop to resume.", "warning");
			return;
		}
		if (this.now() >= loop.expiresAt) {
			this.state = { ...loop, status: "active" };
			this.transition("stopped", "loop expired (maxLoopDuration reached)");
			return;
		}
		// Resuming starts a fresh safety epoch: the user has seen why it paused
		// and chosen to continue, so the breaker must not trip on stale counters.
		const { pauseCause: _cause, lastFingerprint: _fingerprint, ...rest } = loop;
		this.state = { ...rest, status: "active", toolFreeRepeatCount: 0 };
		this.noOpStreak = 0;
		this.persist();
		this.scheduleTick(loop.intervalMs);
		this.armExpiryWatchdog();
		this.updateWidget();
		ctx.ui.notify(
			`Loop resumed: continuing now, with a fallback wake every ${formatDuration(loop.intervalMs)}.`,
			"info",
		);
		// Resuming resumes the work, not just the heartbeat.
		if (this.state) {
			this.requestContinuation(this.state);
			this.dispatchContinuationIfSettled(ctx);
		}
	}

	/** Re-arm the timer after an interval edit while active. */
	resumeAfterEdit(): void {
		const loop = this.state;
		if (!loop || loop.status !== "active") return;
		this.scheduleTick(loop.intervalMs);
		this.updateWidget();
	}

	/** Terminal transition owned by the loop_complete tool. */
	completeLoop(summary?: string): void {
		if (!this.state || this.state.status === "stopped") return;
		this.transition("stopped", `completion criteria met${summary ? ` — ${summary}` : ""}`);
	}

	stopLoop(ctx: ExtensionContext, why = "stopped by user"): void {
		this.sessionCtx = ctx;
		if (!this.state || this.state.status === "stopped") {
			ctx.ui.notify("No loop to stop.", "warning");
			return;
		}
		this.transition("stopped", why);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A run that called no tool did nothing to the world. It is the signal the
 * fallback backoff needs today; Stage 6's `LOOP_OK` acknowledgement refines
 * the same counter rather than replacing it.
 */
function isNoOpRun(messages: readonly unknown[]): boolean {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		if (message.content.some((block) => isRecord(block) && block.type === "toolCall")) return false;
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
