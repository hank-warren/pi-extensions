/**
 * Everything stateful about revising a plan that already exists.
 *
 * `update_plan` is two thin skins over this object, and `/plan` is a third. It
 * owns: which revision the plan file holds, which bytes the user approved, the
 * open revision transaction if there is one, the candidate awaiting review, and
 * the one path through which a proposed revision becomes the current plan.
 *
 * Three rules shape the code below.
 *
 *   1. Nothing is computed against remembered bytes. Every decision re-reads the
 *      plan file and the manifest, and a publication only lands if the bytes it
 *      was computed from are still there.
 *   2. Nothing waits on this session's own idle state. The review card opens from
 *      inside the tool call, so waiting for the agent to settle would deadlock the
 *      very turn that has to deliver the answer. Waiting on a *person* is fine.
 *   3. Every await is followed by asking whether this work still owns the state.
 *      A human can take minutes; in that time Pi may replace the session and the
 *      user may start a different plan. A late "Accept" must not publish into it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LifecycleScope } from "./lifecycle.js";
import { approvalNotice, evaluatePlanApproval, type PlanApproval } from "./plan-approval.js";
import { describePlanDiff, diffPlanText, type PlanDiff } from "./plan-diff.js";
import { readPlanFile } from "./plan-file.js";
import type { PlanRevisionOutcome, PlanRevisionSummary } from "./plan-revision-menu.js";
import {
	adoptLiveDocument,
	digestOf,
	initializePlanManifest,
	isSafeManagedId,
	listPendingPlanProposals,
	newManagedId,
	normalizePlanText,
	type PlanManifest,
	type PlanProposal,
	planRevisionsRoot,
	publishPlanRevision,
	readPlanManifest,
	readPlanProposal,
	recoverPlanRevisions,
	resolvePlanProposal,
	writePlanProposal,
} from "./revision-store.js";
import type { PlanModeState, PlanRevisionTransaction } from "./state.js";
import {
	type UpdatePlanInput,
	type UpdatePlanOutcome,
	updatePlanFailure,
} from "./update-plan-tool.js";

type InteractiveUi = typeof import("./interactive-ui.js");

import type { createTaskIntegration } from "./task-integration.js";

export interface PlanRevisionControllerOptions {
	tasks?: Pick<ReturnType<typeof createTaskIntegration>, "preview" | "bind">;
	loadInteractiveUi(): Promise<InteractiveUi>;
	getState(): PlanModeState;
	/** Applies a patch, persists it, and refreshes the UI: one state move. */
	setState(ctx: ExtensionContext, patch: Partial<PlanModeState>): void;
	/** The scope for work that spans an await: stale once the plan state moves. */
	capture(): LifecycleScope;
	/** Supersedes menus and prompts opened against the previous plan state. */
	nextWorkflow(): void;
	/** Arms the post-settle "what next?" menu, exactly as a completed plan does. */
	markReady(ctx: ExtensionContext, title: string, plan: string): void;
	showCard(ctx: ExtensionContext, title: string, body: string): void;
	/** Delivers feedback the agent did not ask for, from a `/plan` review. */
	sendToAgent(ctx: ExtensionContext, message: string): void;
	/** The revisions root. Defaults to `<agentDir>/plans/.revisions`. */
	root?(): string;
	now?(): string;
	newId?(): string;
}

/** The window one operation is allowed to act in. */
interface OperationScope {
	readonly signal: AbortSignal;
	isCurrent(): boolean;
	isStale(): boolean;
}

/** What the plan file and its history say right now. */
export interface LivePlanReading {
	plan?: string;
	digest?: string;
	manifest?: PlanManifest;
	approval: PlanApproval;
	/** The authoritative spec revision: 0 when the plan has no managed history. */
	revision: number;
	/** Set when the live bytes are not the revision the manifest names. */
	unaccounted?: string;
}

const PAUSED_AWAITING_REVIEW =
	"a proposed plan revision is waiting for the user's review; implementation stays paused until it is resolved";

export function createPlanRevisionController(options: PlanRevisionControllerOptions) {
	let pendingProposal: PlanProposal | undefined;
	/**
	 * Serializes publish-then-retire so two proposals in one session cannot
	 * interleave and leave both pending, or retire the wrong one.
	 */
	let proposalTransition: Promise<unknown> = Promise.resolve();

	const root = () => options.root?.() ?? planRevisionsRoot();
	const now = () => options.now?.() ?? new Date().toISOString();
	const newId = () => options.newId?.() ?? newManagedId();

	const operationScope = (toolSignal?: AbortSignal): OperationScope => {
		const scope = options.capture();
		const signal = toolSignal ? AbortSignal.any([scope.signal, toolSignal]) : scope.signal;
		return {
			signal,
			isCurrent: scope.isCurrent,
			isStale: () => signal.aborted || !scope.isCurrent(),
		};
	};

	/**
	 * Read the plan file and its recorded history together, and say what the two
	 * mean for approval.
	 *
	 * The manifest is only read when the live digest is not the one this session
	 * recorded. While they agree, the manifest cannot have moved without the file
	 * moving too, so the common turn pays for one plan read and nothing else.
	 */
	async function read(stateOverride?: PlanModeState): Promise<LivePlanReading> {
		const state = stateOverride ?? options.getState();
		if (!state.planPath) return { approval: { kind: "none" }, revision: 0 };
		const plan = await readPlanFile(state.planPath);
		if (plan === undefined) {
			return { approval: evaluatePlanApproval(state, undefined), revision: state.specRevision ?? 0 };
		}
		const digest = digestOf(plan);
		const approval = evaluatePlanApproval(state, digest);
		if (!state.planId) return { plan, digest, approval, revision: 0 };
		if (state.currentDigest === digest && state.specRevision !== undefined) {
			return { plan, digest, approval, revision: state.specRevision };
		}
		const loaded = await readPlanManifest(root(), state.planId);
		if (loaded.kind !== "loaded") {
			return {
				plan,
				digest,
				approval,
				revision: 0,
				unaccounted:
					loaded.kind === "missing"
						? "this plan's recorded revision history is no longer on disk"
						: loaded.reason,
			};
		}
		return {
			plan,
			digest,
			approval,
			manifest: loaded.manifest,
			revision: loaded.manifest.specRevision,
			...(loaded.manifest.currentDigest === digest
				? {}
				: {
						unaccounted: `the plan file does not match recorded revision ${loaded.manifest.specRevision}, so it was changed outside Plan mode`,
					}),
		};
	}

	/**
	 * Give the plan a managed identity, so it has somewhere to record revisions.
	 *
	 * Called the first time something managed happens — a revision, an approval —
	 * and never at session start: a plan written by an earlier version is left
	 * exactly as it is until then, and its current bytes become revision 1 rather
	 * than being rewritten.
	 */
	async function ensureIdentity(
		ctx: ExtensionContext,
		scope: OperationScope,
		reason: string,
	): Promise<{ ok: true; planId: string; manifest: PlanManifest } | { ok: false; error: string }> {
		const state = options.getState();
		const planPath = state.planPath;
		if (!planPath) return { ok: false, error: "no plan is active in this session" };
		const plan = await readPlanFile(planPath);
		if (plan === undefined) return { ok: false, error: `the plan file at ${planPath} could not be read` };
		if (scope.isStale()) return { ok: false, error: "the session moved on" };
		const planId = state.planId && isSafeManagedId(state.planId) ? state.planId : newId();
		const existing = await readPlanManifest(root(), planId);
		if (existing.kind === "loaded") {
			if (scope.isStale()) return { ok: false, error: "the session moved on" };
			options.setState(ctx, {
				schemaVersion: 2,
				planId,
				specRevision: existing.manifest.specRevision,
				currentDigest: existing.manifest.currentDigest,
			});
			return { ok: true, planId, manifest: existing.manifest };
		}
		if (existing.kind === "invalid") return { ok: false, error: existing.reason };
		const initialized = await initializePlanManifest({
			root: root(),
			planId,
			planPath,
			plan,
			now: now(),
			changeSummary: reason,
		});
		if (initialized.kind === "conflict" || initialized.kind === "failed") {
			return { ok: false, error: initialized.reason };
		}
		if (scope.isStale()) return { ok: false, error: "the session moved on" };
		options.setState(ctx, {
			schemaVersion: 2,
			planId,
			specRevision: initialized.manifest.specRevision,
			currentDigest: initialized.manifest.currentDigest,
		});
		return { ok: true, planId, manifest: initialized.manifest };
	}

	// ------------------------------------------------------------------- begin

	async function begin(
		input: Extract<UpdatePlanInput, { action: "begin" }>,
		ctx: ExtensionContext,
		toolSignal?: AbortSignal,
	): Promise<UpdatePlanOutcome> {
		const scope = operationScope(toolSignal);
		if (scope.signal.aborted) {
			return updatePlanFailure(
				"cancelled",
				"the turn was interrupted before the revision was opened; nothing was changed",
			);
		}
		const state = options.getState();
		if (!state.planPath) {
			return updatePlanFailure(
				"no_plan",
				state.enabled
					? "No plan exists yet in this session, so there is nothing to revise. Finish the first draft and submit it with plan_mode_complete instead."
					: "No plan exists in this session. update_plan only revises a plan that already exists; start one with /plan and submit it with plan_mode_complete.",
			);
		}
		const reading = await read(state);
		if (scope.isStale()) {
			return updatePlanFailure("cancelled", "the turn was interrupted; no revision was opened");
		}
		if (reading.plan === undefined || reading.digest === undefined) {
			return updatePlanFailure(
				"plan_missing",
				`the plan file at ${state.planPath} could not be read, so there is nothing to revise. Ask the user to check it or start a new plan with /plan.`,
			);
		}

		// An open transaction on the same bytes is the same transaction: the user
		// added to their request, or the model called begin twice. Returning the
		// existing one is what stops a second call throwing away the first
		// candidate, which is the work the user is waiting on.
		//
		// Unless it has no identity to propose against. That happens when the history
		// directory went missing under a restored transaction: `propose` would refuse
		// for want of a `planId`, so answering "already open, propose against it" here
		// is the half of a loop this function controls. Such a transaction is
		// superseded instead, and a usable one is opened below.
		const open = state.revision;
		if (open && state.planId !== undefined && open.baseDigest === reading.digest) {
			const merged = mergeInstructions(open.instructions, input.instructions);
			if (merged !== open.instructions) {
				options.setState(ctx, { revision: { ...open, instructions: merged } });
			}
			return {
				payload: {
					status: "revision_in_progress",
					revisionId: open.revisionId,
					planId: state.planId,
					baseRevision: open.baseRevision,
					baseDigest: open.baseDigest,
					planPath: state.planPath,
					recordedInstructions: merged,
					...(open.proposalId ? { pendingProposalId: open.proposalId } : {}),
					message:
						"A revision of this plan is already open; this request was recorded against it rather than starting a second one.",
					instruction: proposeInstruction(open.revisionId, open.baseRevision, state.planPath),
				},
			};
		}

		const currentRevision = reading.manifest?.specRevision ?? (state.planId ? reading.revision : 0);
		if (input.expectedRevision !== currentRevision) {
			return updatePlanFailure(
				"stale_revision",
				`expectedRevision ${input.expectedRevision} does not match the plan's current spec revision ${currentRevision}. Read the active-plan context line again and call update_plan with the revision it reports.`,
				{ currentRevision, planPath: state.planPath },
			);
		}

		const identity = await ensureIdentity(ctx, scope, `revision requested: ${input.instructions}`);
		if (scope.isStale()) {
			return updatePlanFailure("cancelled", "the turn was interrupted; no revision was opened");
		}
		if (!identity.ok) {
			return updatePlanFailure(
				"history_unavailable",
				`the plan's revision history could not be opened (${identity.error}), so no revision was started and the plan is unchanged.`,
			);
		}
		// The base is always the bytes on disk, even when the manifest cannot
		// explain them: reconciling a document somebody edited by hand is exactly
		// what a revision is for, and the conflict travels with the proposal so the
		// user sees it on the card.
		const baseRevision = identity.manifest.specRevision;
		const transaction: PlanRevisionTransaction = {
			revisionId: newId(),
			baseRevision,
			baseDigest: reading.digest,
			instructions: input.instructions,
			startedAt: now(),
		};
		// A superseded transaction's candidate is retired, not deleted: it is the
		// work the user asked for, just against bytes that have moved.
		if (open) await supersedeOpenProposal(state.planId, open, transaction.revisionId);
		if (scope.isStale()) {
			return updatePlanFailure("cancelled", "the turn was interrupted; no revision was opened");
		}
		// Past here the session is back under planning's rules: edit and write are
		// blocked from the next tool call onward, and any menu opened against the
		// previous state is stale. Work already in flight cannot be undone by this.
		options.nextWorkflow();
		options.setState(ctx, {
			schemaVersion: 2,
			enabled: true,
			awaitingAction: false,
			revision: transaction,
		});
		pendingProposal = undefined;
		return {
			payload: {
				status: "revision_started",
				revisionId: transaction.revisionId,
				planId: identity.planId,
				baseRevision,
				baseDigest: reading.digest,
				planPath: state.planPath,
				recordedInstructions: input.instructions,
				...(open
					? { supersededRevisionId: open.revisionId }
					: {}),
				...(reading.unaccounted ? { conflict: reading.unaccounted } : {}),
				note: "Plan mode's non-mutation rules are active again: do not edit files while the revision is open.",
				instruction: proposeInstruction(transaction.revisionId, baseRevision, state.planPath),
			},
		};
	}

	function proposeInstruction(revisionId: string, baseRevision: number, planPath: string) {
		return `Read ${planPath}, settle only the questions this change actually raises, then call update_plan with action "propose", revisionId "${revisionId}", expectedRevision ${baseRevision}, the complete rewritten plan, and a changeSummary saying what you changed and what you kept.`;
	}

	// ----------------------------------------------------------------- propose

	async function propose(
		input: Extract<UpdatePlanInput, { action: "propose" }>,
		ctx: ExtensionContext,
		toolSignal?: AbortSignal,
	): Promise<UpdatePlanOutcome> {
		const scope = operationScope(toolSignal);
		if (scope.signal.aborted) {
			return updatePlanFailure(
				"cancelled",
				"the turn was interrupted before the revision was proposed; nothing was changed",
			);
		}
		const state = options.getState();
		if (!state.planPath || !state.planId) {
			return updatePlanFailure(
				"no_revision",
				'No plan revision is open. Call update_plan with action "begin" first; it returns the revisionId and base this call needs.',
			);
		}
		const open = state.revision;
		if (!open) {
			return updatePlanFailure(
				"no_revision",
				'No plan revision is open. Call update_plan with action "begin" first; it returns the revisionId and base this call needs.',
			);
		}
		if (open.revisionId !== input.revisionId) {
			return updatePlanFailure(
				"wrong_revision",
				`revisionId ${input.revisionId} is not the open revision. The open revision is ${open.revisionId}; propose against that, or call action "begin" again if the plan has moved.`,
				{ revisionId: open.revisionId, baseRevision: open.baseRevision },
			);
		}
		if (input.expectedRevision !== open.baseRevision) {
			return updatePlanFailure(
				"stale_revision",
				`expectedRevision ${input.expectedRevision} does not match this revision's base ${open.baseRevision}. Propose against the base that action "begin" returned.`,
				{ revisionId: open.revisionId, baseRevision: open.baseRevision },
			);
		}
		const reading = await read(state);
		if (scope.isStale()) {
			return updatePlanFailure("cancelled", "the turn was interrupted; nothing was proposed");
		}
		if (reading.plan === undefined || reading.digest === undefined) {
			return updatePlanFailure(
				"plan_missing",
				`the plan file at ${state.planPath} could not be read, so the revision could not be computed against it.`,
			);
		}
		if (reading.digest !== open.baseDigest) {
			return updatePlanFailure(
				"conflict",
				'the plan file changed after this revision was opened, so the proposal was not saved. Call update_plan with action "begin" again to re-open the revision against the current plan.',
				{ revisionId: open.revisionId, baseRevision: open.baseRevision },
			);
		}

		let taskPreview: Awaited<ReturnType<NonNullable<PlanRevisionControllerOptions["tasks"]>["preview"]>>;
		try { taskPreview = await options.tasks?.preview(ctx, input.tasks); }
		catch (error) { return updatePlanFailure("tasks_not_reconciled", describe(error)); }
		if (scope.isStale()) return updatePlanFailure("cancelled", "session changed during combined task preview");
		const proposedPlan = normalizePlanText(input.plan);
		const diff = diffPlanText(reading.plan, proposedPlan);
		if (diff.identical && !taskPreview) {
			// An unchanged proposal is a no-op, not a revision: the approved bytes
			// are untouched, so approval survives and the transaction simply closes.
			await supersedeOpenProposal(state.planId, open, undefined, "the proposal made no change");
			if (scope.isStale()) {
				return updatePlanFailure("cancelled", "the turn was interrupted; nothing was proposed");
			}
			closeTransaction(ctx, state, reading.plan, "Plan unchanged");
			return {
				payload: {
					status: "unchanged",
					revisionId: open.revisionId,
					baseRevision: open.baseRevision,
					message:
						"The proposed plan has no textual change against the plan on disk, so nothing was changed and the revision is closed. The existing approval still stands.",
				},
			};
		}

		const proposal: PlanProposal = {
			...taskPreview,
			schemaVersion: 1,
			proposalId: newId(),
			planId: state.planId,
			revisionId: open.revisionId,
			status: "pending",
			instructions: open.instructions,
			changeSummary: input.changeSummary,
			baseRevision: open.baseRevision,
			baseDigest: open.baseDigest,
			createdAt: now(),
			proposedPlan,
			diff: diff.lines,
		};
		try {
			await publishReplacement(proposal, open);
		} catch (error: unknown) {
			return updatePlanFailure(
				"write_failed",
				`the proposed revision could not be saved (${describe(error)}), so it was not shown to the user and the plan is unchanged.`,
				{ revisionId: open.revisionId },
			);
		}
		if (scope.isStale()) {
			// The candidate is on disk and inspectable; nothing was accepted.
			return {
				payload: {
					status: "pending_review",
					revisionId: open.revisionId,
					proposalId: proposal.proposalId,
					baseRevision: open.baseRevision,
					message:
						"the turn was interrupted before the review could be shown. The proposed revision is saved and waiting; /plan reopens it. It is not approved.",
				},
			};
		}
		options.setState(ctx, {
			revision: { ...open, proposalId: proposal.proposalId, paused: PAUSED_AWAITING_REVIEW },
		});
		const summary = summaryOf(proposal, diff, reading.unaccounted);
		options.showCard(ctx, "Proposed plan revision", formatProposalCard(summary));
		const outcome = await presentReview(summary, ctx, scope);
		return reportReviewOutcome(proposal, outcome, ctx, scope);
	}

	function summaryOf(
		proposal: PlanProposal,
		diff: PlanDiff,
		conflict: string | undefined,
	): PlanRevisionSummary {
		return {
			instructions: proposal.instructions,
			changeSummary: proposal.changeSummary,
			baseRevision: proposal.baseRevision,
			diff: reviewDiff(proposal),
			added: diff.added,
			removed: diff.removed,
			proposedPlan: proposal.proposedPlan,
			...(conflict ? { conflict } : {}),
		};
	}

	function reviewDiff(proposal: PlanProposal): string[] {
		return proposal.tasks ? [...proposal.diff, "", "## Task changes (retained IDs preserve progress)", ...(proposal.taskDiff ?? "").split("\n")] : proposal.diff;
	}

	/** The summary of a proposal read back from disk, where the diff is all we kept. */
	function summaryFromProposal(proposal: PlanProposal, conflict?: string): PlanRevisionSummary {
		const added = proposal.diff.filter((line) => line.startsWith("+")).length;
		const removed = proposal.diff.filter((line) => line.startsWith("-")).length;
		return {
			instructions: proposal.instructions,
			changeSummary: proposal.changeSummary,
			baseRevision: proposal.baseRevision,
			diff: reviewDiff(proposal),
			added,
			removed,
			proposedPlan: proposal.proposedPlan,
			...(conflict ? { conflict } : {}),
		};
	}

	/**
	 * Publish a replacement candidate, then retire whatever it replaces.
	 *
	 * That order is the recoverable one. Interrupted after the write and before the
	 * retirement, the directory holds two pending candidates and the newest wins;
	 * the reverse order could retire the only candidate and then fail to write its
	 * replacement, leaving the user nothing to review and no record of why.
	 */
	async function publishReplacement(
		proposal: PlanProposal,
		open: PlanRevisionTransaction,
	): Promise<void> {
		const transition = proposalTransition.then(async () => {
			await writePlanProposal(root(), proposal);
			for (const prior of await listPendingPlanProposals(root(), proposal.planId)) {
				if (prior.proposalId === proposal.proposalId) continue;
				await resolvePlanProposal(root(), prior, "superseded", now(), {
					supersededBy: proposal.proposalId,
					resolutionReason:
						prior.revisionId === open.revisionId
							? "a corrected proposal replaced it"
							: "a newer revision of the plan replaced it",
				});
			}
			pendingProposal = proposal;
		});
		proposalTransition = transition.then(
			() => undefined,
			() => undefined,
		);
		await transition;
	}

	/**
	 * The candidate that belongs to the open transaction, however it was found.
	 *
	 * `revision.proposalId` is the fast path, and it is not the only one: `propose`
	 * writes the candidate to disk *before* it writes the id into session state, so a
	 * turn interrupted between those two steps leaves a real, reviewable candidate
	 * that the transaction does not name. Falling back to the pending candidate found
	 * on disk is what makes that interruption recoverable instead of a file nothing
	 * can reach.
	 *
	 * Identity is checked on every path, not just the fast one: the candidate must
	 * belong to this plan, to this transaction, and to the same base revision and
	 * digest. Without that, a candidate left pending by an earlier transaction — or by
	 * another session — could be attached to a revision it was never computed for,
	 * and accepted against the wrong base.
	 */
	async function discoverOpenCandidate(
		planId: string | undefined,
		open: PlanRevisionTransaction,
	): Promise<PlanProposal | undefined> {
		if (!planId) return undefined;
		const belongs = (candidate: PlanProposal) =>
			candidate.planId === planId &&
			candidate.revisionId === open.revisionId &&
			candidate.baseRevision === open.baseRevision &&
			candidate.baseDigest === open.baseDigest;
		// Memory first, and that order is load-bearing. The candidate this session
		// wrote is the one the user is being shown, so `acceptProposal`'s comparison
		// against the stored record stays a real check: a proposal file that changed
		// after it was written is refused rather than published. Reading from disk first
		// would compare the record with itself and always agree.
		if (pendingProposal && pendingProposal.status === "pending" && belongs(pendingProposal)) {
			return pendingProposal;
		}
		if (open.proposalId) {
			const named = await readPlanProposal(root(), planId, open.proposalId);
			if (named && belongs(named)) return named;
		}
		// Nothing in memory and no id in state: the interrupted case. Sweep the
		// directory for a pending candidate that belongs to this transaction.
		const pending = await listPendingPlanProposals(root(), planId);
		// Newest wins: after a corrected proposal the older candidate is the one the
		// user asked to change.
		return pending.filter(belongs).at(-1);
	}

	/** Retire the candidate of a transaction that is being replaced or closed. */
	async function supersedeOpenProposal(
		planId: string | undefined,
		open: PlanRevisionTransaction,
		supersededBy?: string,
		reason = "the revision it belonged to was superseded",
	): Promise<void> {
		if (!planId) return;
		const scope = operationScope();
		// Discovered rather than read from `open.proposalId`, so a candidate written by
		// an interrupted turn is actually retired instead of staying pending forever
		// against a transaction the user has just cancelled.
		const proposal = await discoverOpenCandidate(planId, open);
		if (scope.isStale() || !proposal || proposal.status !== "pending") return;
		await resolvePlanProposal(root(), proposal, "superseded", now(), {
			...(supersededBy ? { supersededBy } : {}),
			resolutionReason: reason,
		});
		if (!scope.isStale() && pendingProposal?.proposalId === proposal.proposalId) pendingProposal = undefined;
	}

/**
	 * Retire the open transaction's candidate without touching plan state.
	 *
	 * For a caller that is taking the session somewhere else entirely — `/plan exit`
	 * during a revision — and needs the candidate resolved rather than left pending
	 * forever against a transaction nobody can reach. The record stays on disk; only
	 * its status changes, through the same primitive Cancel uses.
	 */
	async function retireOpenRevision(reason: string): Promise<void> {
		const state = options.getState();
		const open = state.revision;
		if (!open) return;
		await supersedeOpenProposal(state.planId, open, undefined, reason);
	}

	/**
	 * Leave an agreed managed plan attached and paused, whatever it was doing.
	 *
	 * This is what `/plan exit` means once a plan has managed history. It is not an
	 * exit: an agreed plan is not a draft to throw away, and the two states a
	 * resolved revision leaves behind (`enabled` with or without `awaitingAction`)
	 * are exactly where the old code treated it as one and deleted the file.
	 *
	 * So any open transaction is retired through the existing primitive, its baseline
	 * and history are kept, and the session lands back on the managed ready decision
	 * — the same state an accepted revision leaves, where `/plan` offers the
	 * implementation choices. Nothing is deleted and nothing is implemented; the
	 * plan's own `approvedDigest` is deliberately untouched, because pausing is not a
	 * statement about which bytes were approved.
	 */
	async function pauseManagedPlan(ctx: ExtensionContext, reason: string): Promise<boolean> {
		const scope = operationScope();
		const state = options.getState();
		if (state.revision) await retireOpenRevision(reason);
		const current = options.getState();
		// Retirement may outlive a branch switch. Only the initiating attachment
		// may be paused; never clear a replacement transaction or announce success.
		if (
			scope.isStale() || !current.planPath || !current.planId ||
			current.planPath !== state.planPath || current.planId !== state.planId ||
			current.revision !== state.revision
		) return false;
		options.nextWorkflow();
		options.setState(ctx, {
			schemaVersion: 2,
			enabled: true,
			awaitingAction: true,
			revision: undefined,
		});
		pendingProposal = undefined;
		return true;
	}

	/**
	 * Leave the revision transaction and put the plan back in front of the user.
	 *
	 * Used by "unchanged", "cancel", and the `/plan` cancel item. Approval is not
	 * touched — the bytes never moved — but execution does not silently resume
	 * either: the user decides to continue from the same menu a completed plan
	 * opens.
	 */
	function closeTransaction(
		ctx: ExtensionContext,
		state: PlanModeState,
		plan: string,
		title: string,
	): void {
		options.nextWorkflow();
		options.setState(ctx, {
			schemaVersion: 2,
			enabled: true,
			awaitingAction: true,
			revision: undefined,
		});
		pendingProposal = undefined;
		options.markReady(ctx, title, plan);
	}

	// ------------------------------------------------------------------ review

	async function presentReview(
		summary: PlanRevisionSummary,
		ctx: ExtensionContext,
		scope: OperationScope,
	): Promise<PlanRevisionOutcome> {
		if (!ctx.hasUI) return { kind: "unavailable" };
		if (scope.isStale()) return { kind: "dismissed" };
		const ui = await options.loadInteractiveUi();
		if (scope.isStale()) return { kind: "dismissed" };
		const outcome = await ui.showPlanRevisionMenu(ctx, {
			summary,
			signal: scope.signal,
			isCurrent: scope.isCurrent,
		});
		// A decision that arrives after the turn or the plan it belongs to is gone
		// is not a decision. Dropping it here is what stops a late "Accept" from
		// publishing into a session that has moved on.
		if (scope.isStale() && outcome.kind !== "unavailable") return { kind: "dismissed" };
		return outcome;
	}

	async function reportReviewOutcome(
		proposal: PlanProposal,
		outcome: PlanRevisionOutcome,
		ctx: ExtensionContext,
		scope: OperationScope,
	): Promise<UpdatePlanOutcome> {
		if (outcome.kind === "accepted") return acceptProposal(proposal, ctx, scope);
		if (outcome.kind === "changes_requested") {
			return {
				payload: {
					status: "changes_requested",
					revisionId: proposal.revisionId,
					proposalId: proposal.proposalId,
					baseRevision: proposal.baseRevision,
					feedback: outcome.feedback,
					instruction: `Rework the revision: call update_plan again with action "propose", revisionId "${proposal.revisionId}", expectedRevision ${proposal.baseRevision}, and the complete corrected plan. The new candidate replaces this one, which is retired and kept on file.`,
				},
			};
		}
		if (outcome.kind === "cancelled") return cancelProposal(proposal, ctx, scope);
		return {
			payload: {
				status: "pending_review",
				revisionId: proposal.revisionId,
				proposalId: proposal.proposalId,
				baseRevision: proposal.baseRevision,
				message:
					outcome.kind === "unavailable"
						? "This session cannot show a review card, so the proposed revision is saved and waiting. It is not approved and the plan is unchanged."
						: "The review was closed without a decision. The proposed revision is saved and waiting; /plan reopens it. The plan is unchanged.",
			},
		};
	}

	/**
	 * Publish a proposal, but only against the exact bytes it was computed from.
	 *
	 * A stale base is not a reason to lose the work: the candidate stays pending
	 * and the agent is told to refresh it. Publishing anyway would silently discard
	 * whatever landed in between.
	 */
	async function acceptProposal(
		proposal: PlanProposal,
		ctx: ExtensionContext,
		scope: OperationScope,
	): Promise<UpdatePlanOutcome> {
		const interrupted = () =>
			updatePlanFailure(
				"cancelled",
				"the turn was interrupted before the revision could be published; it is still on file and unapproved",
				{ revisionId: proposal.revisionId, proposalId: proposal.proposalId },
			);
		if (scope.isStale()) return interrupted();
		const state = options.getState();
		if (state.planId !== proposal.planId || !state.planPath) {
			return updatePlanFailure(
				"wrong_plan",
				`this revision belongs to plan ${proposal.planId}, which this session is no longer working on; it was not published and is kept on file.`,
				{ proposalId: proposal.proposalId },
			);
		}
		// The card in hand may be older than the directory. Identity and status are
		// re-read before anything is published, so a candidate left over from a
		// superseded round, a cancelled one, or one already accepted cannot publish
		// a second time.
		const persisted = await readPlanProposal(root(), proposal.planId, proposal.proposalId);
		if (scope.isStale()) return interrupted();
		if (!persisted) {
			return updatePlanFailure(
				"invalid_proposal",
				'the proposed revision could not be re-read from disk, so it was not published. Call update_plan with action "begin" and propose again.',
				{ proposalId: proposal.proposalId },
			);
		}
		if (persisted.status !== "pending") {
			return updatePlanFailure(
				"stale_proposal",
				`this proposed revision is ${persisted.status}${persisted.resolutionReason ? ` (${persisted.resolutionReason})` : ""}, so it was not published. Its content is kept on file.`,
				{ proposalId: proposal.proposalId, persistedStatus: persisted.status },
			);
		}
		if (
			persisted.baseDigest !== proposal.baseDigest ||
			persisted.baseRevision !== proposal.baseRevision ||
			persisted.proposedPlan !== proposal.proposedPlan ||
			JSON.stringify(persisted.tasks) !== JSON.stringify(proposal.tasks) || persisted.taskDiff !== proposal.taskDiff
		) {
			return updatePlanFailure(
				"stale_proposal",
				'the stored revision no longer matches the one under review, so it was not published. Call update_plan with action "begin" and propose again.',
				{ proposalId: proposal.proposalId },
			);
		}
		try { await options.tasks?.preview(ctx, persisted.tasks); }
		catch (error) { return updatePlanFailure("stale_tasks", `${describe(error)}. The combined proposal is retained; refresh both artifacts before proposing again.`); }
		if (scope.isStale()) return interrupted();
		const result = await publishPlanRevision({
			allowUnchanged: persisted.tasks !== undefined,
			root: root(),
			planId: proposal.planId,
			planPath: state.planPath,
			baseRevision: proposal.baseRevision,
			baseDigest: proposal.baseDigest,
			plan: persisted.proposedPlan,
			now: now(),
			changeSummary: persisted.changeSummary,
			instructions: persisted.instructions,
			revisionId: persisted.revisionId,
			proposalId: persisted.proposalId,
			signal: scope.signal,
		});
		if (result.kind === "cancelled") {
			return updatePlanFailure(
				"cancelled",
				`${result.reason}; the proposed revision is still on file and unapproved`,
				{ proposalId: proposal.proposalId },
			);
		}
		if (result.kind !== "published") {
			return updatePlanFailure(
				result.kind === "conflict" ? "stale_proposal" : "write_failed",
				`the revision was not published: ${result.reason}. It is still on file.`,
				{ proposalId: proposal.proposalId },
			);
		}
		// A combined revision is only acknowledged after task binding. If either
		// side fails, the proposal stays on disk and implementation stays blocked.
		if (scope.isStale()) {
			return {
				payload: {
					status: "published_but_detached",
					proposalId: persisted.proposalId,
					revision: result.revision,
					message:
						"the revision was published before the turn was interrupted, and cannot be taken back. This session did not record it; /plan can re-confirm the plan file.",
				},
			};
		}
		// Current, and deliberately not approved: the user accepted the text, and
		// approval is the separate decision to implement exactly these bytes.
		options.setState(ctx, {
			schemaVersion: 2, enabled: true, awaitingAction: true,
			specRevision: result.revision, currentDigest: result.digest,
			approvedDigest: undefined, revision: undefined,
		});
		if (persisted.tasks) {
			try { await options.tasks!.bind(ctx, persisted.tasks); }
			catch (error) { return updatePlanFailure("binding_pending", `Plan revision ${result.revision} was published, but tasks were not acknowledged: ${describe(error)}. Proposal retained; implementation is blocked. Retry the explicit implementation choice, or call begin and reconcile against current tasks.`, { proposalId: persisted.proposalId, revision: result.revision }); }
		}
		if (scope.isStale()) return interrupted();
		await resolvePlanProposal(root(), persisted, "accepted", now(), { resolutionReason: `published as revision ${result.revision} with acknowledged tasks` });
		if (scope.isStale()) return interrupted();
		pendingProposal = undefined;
		options.nextWorkflow();
		options.markReady(ctx, `Plan revision ${result.revision}`, persisted.proposedPlan);
		return {
			payload: {
				status: "accepted",
				revisionId: persisted.revisionId,
				proposalId: persisted.proposalId,
				revision: result.revision,
				digest: result.digest,
				planPath: state.planPath,
				...(result.replacedExternalDigest
					? {
							replacedUnaccountedBytes:
								"the plan file had been changed outside Plan mode; those bytes are kept under the plan's external/ directory",
						}
					: {}),
				...(result.historyPending ? { historyPending: result.historyPending } : {}),
				...(result.lockCompromised ? { lockCompromised: result.lockCompromised } : {}),
				message:
					"The user accepted the revision, so it is now the current plan. It is not yet approved for implementation: the user is choosing how to proceed. Stop here and wait rather than implementing.",
			},
		};
	}

	async function cancelProposal(
		proposal: PlanProposal,
		ctx: ExtensionContext,
		scope: OperationScope,
	): Promise<UpdatePlanOutcome> {
		const state = options.getState();
		const persisted = await readPlanProposal(root(), proposal.planId, proposal.proposalId);
		if (persisted?.status === "pending") {
			await resolvePlanProposal(root(), persisted, "cancelled", now(), {
				resolutionReason: "the user cancelled the revision",
			});
		}
		if (pendingProposal?.proposalId === proposal.proposalId) pendingProposal = undefined;
		if (scope.isStale()) {
			return updatePlanFailure(
				"cancelled",
				"the revision was cancelled and the turn was interrupted; the plan is unchanged",
				{ revisionId: proposal.revisionId },
			);
		}
		const plan = state.planPath ? await readPlanFile(state.planPath) : undefined;
		if (!scope.isStale() && plan !== undefined) {
			closeTransaction(ctx, state, plan, "Approved Plan (revision cancelled)");
		} else if (!scope.isStale()) {
			options.setState(ctx, { revision: undefined });
		}
		return {
			payload: {
				status: "cancelled",
				revisionId: proposal.revisionId,
				proposalId: proposal.proposalId,
				baseRevision: proposal.baseRevision,
				message:
					"The user cancelled the revision. The approved plan is unchanged and the candidate is kept on file. Implementation stays paused until the user chooses to continue from /plan; do not resume on your own.",
			},
		};
	}

	// -------------------------------------------------------------- approval

	/**
	 * Record the bytes on disk as the approved plan.
	 *
	 * Two callers: starting implementation, and the user confirming a plan whose
	 * approval this session could not account for. Both are explicit human
	 * decisions, which is the only thing that may set `approvedDigest`.
	 *
	 * The digest is recorded even when the history write fails. Approval is a fact
	 * about bytes the user agreed to; the manifest entry is the audit trail beside
	 * it, and losing the trail must not silently turn a real approval into an
	 * unknown one.
	 */
	async function approveCurrentPlan(
		ctx: ExtensionContext,
		changeSummary: string,
	): Promise<
		| { ok: true; digest: string; revision?: number; warning?: string }
		| { ok: false; error: string }
	> {
		const scope = operationScope();
		const state = options.getState();
		if (!state.planPath) return { ok: false, error: "no plan is active in this session" };
		const plan = await readPlanFile(state.planPath);
		if (plan === undefined) {
			return { ok: false, error: `the plan file at ${state.planPath} could not be read` };
		}
		if (scope.isStale()) return { ok: false, error: "the session moved on" };
		const digest = digestOf(plan);
		const identity = await ensureIdentity(ctx, scope, changeSummary);
		if (scope.isStale()) return { ok: false, error: "the session moved on" };
		if (!identity.ok) {
			options.setState(ctx, { schemaVersion: 2, approvedDigest: digest });
			return {
				ok: true,
				digest,
				warning: `The approval was recorded for this session, but the plan's revision history could not be written: ${identity.error}`,
			};
		}
		let revision = identity.manifest.specRevision;
		let warning: string | undefined;
		if (identity.manifest.currentDigest !== digest) {
			const adopted = await adoptLiveDocument({
				root: root(),
				planId: identity.planId,
				planPath: state.planPath,
				now: now(),
				changeSummary,
			});
			if (scope.isStale()) return { ok: false, error: "the session moved on" };
			if (adopted.kind === "adopted" || adopted.kind === "unchanged") revision = adopted.revision;
			else warning = `The plan's revision history could not record the current file: ${adopted.reason}`;
		}
		if (scope.isStale()) return { ok: false, error: "the session moved on" };
		options.setState(ctx, {
			schemaVersion: 2,
			planId: identity.planId,
			specRevision: revision,
			currentDigest: digest,
			approvedDigest: digest,
		});
		return { ok: true, digest, revision, ...(warning ? { warning } : {}) };
	}

	// ------------------------------------------------------------- recovery

	/**
	 * Reconcile the recorded history with the plan file at session start.
	 *
	 * The one repair it performs is finishing a publication that was interrupted
	 * after the plan file was replaced and before its history was written, and only
	 * on evidence that this is what happened. Everything else is reported, never
	 * resolved: bytes nobody can account for are not approval, and the way out is a
	 * decision the user makes.
	 */
	async function reconcileOnSessionStart(ctx: ExtensionContext, scope: LifecycleScope): Promise<void> {
		const state = options.getState();
		if (!state.planId || !state.planPath) return;
		const result = await recoverPlanRevisions({
			root: root(),
			planId: state.planId,
			planPath: state.planPath,
			now: now(),
		});
		if (!scope.isCurrent()) return;
		if (result.kind === "unmanaged") {
			// The identity and any open transaction go together. A transaction whose
			// history directory is gone cannot be proposed against — `propose` needs the
			// identity it no longer has — while `begin` would still recognise it as open
			// and hand the agent straight back to `propose`. Invalidating it here is what
			// leaves one coherent answer: start a fresh revision. Nothing on disk is
			// removed; the candidate files stay exactly where they are.
			const strandedRevision = state.revision !== undefined;
			options.setState(ctx, {
				planId: undefined,
				specRevision: undefined,
				currentDigest: undefined,
				revision: undefined,
			});
			pendingProposal = undefined;
			ctx.ui.notify(
				strandedRevision
					? "This plan's recorded revision history is no longer on disk, so the revision that was in progress cannot be completed. The plan file and every saved candidate are untouched; ask for the change again and a fresh history is started for it."
					: "This plan's recorded revision history is no longer on disk. The plan file is untouched; the next revision starts a fresh history for it.",
				"warning",
			);
			return;
		}
		if (result.kind === "unreadable") {
			ctx.ui.notify(`The plan's revision history could not be read: ${result.reason}`, "warning");
			return;
		}
		if (result.kind === "conflict") {
			options.setState(ctx, {
				specRevision: result.manifest.specRevision,
				currentDigest: result.manifest.currentDigest,
			});
			ctx.ui.notify(
				`${result.reason}. The file is untouched and its recorded revisions are intact; ask the agent to reconcile it, or run /plan to confirm the file as it is.`,
				"warning",
			);
		} else {
			options.setState(ctx, {
				specRevision: result.manifest.specRevision,
				currentDigest: result.manifest.currentDigest,
			});
			if (result.kind === "recovered") {
				ctx.ui.notify(
					`Plan revision ${result.revision} was published before its history could be recorded; the record has been completed. Re-confirm the plan before implementing it.`,
					"info",
				);
			}
		}
		// Re-read rather than closing over the restored copy: the branches above may
		// have invalidated the transaction this would otherwise re-arm a card for.
		const open = options.getState().revision;
		const discovered = open
			? await discoverOpenCandidate(options.getState().planId, open)
			: undefined;
		if (!scope.isCurrent()) return;
		pendingProposal = discovered;
		if (pendingProposal) {
			ctx.ui.notify(
				"A proposed plan revision is still waiting for review. Run /plan to accept it, ask for changes, or cancel it.",
				"info",
			);
		}
	}

	// ------------------------------------------------------- command surface

	/** Reopen the waiting review card. A recovery door, never the normal one. */
	async function reviewPendingRevision(ctx: ExtensionContext): Promise<void> {
		const state = options.getState();
		const open = state.revision;
		if (!state.planId || !open) {
			ctx.ui.notify("No plan revision is in progress.", "info");
			return;
		}
		const scope = operationScope();
		const candidate = await discoverOpenCandidate(state.planId, open);
		if (scope.isStale()) return;
		if (!candidate || candidate.status !== "pending") {
			ctx.ui.notify(
				"No proposed plan revision is waiting for review. The agent is still working on it.",
				"info",
			);
			return;
		}
		const reading = await read(state);
		if (scope.isStale()) return;
		const summary = summaryFromProposal(candidate, reading.unaccounted);
		const outcome = await presentReview(summary, ctx, scope);
		const result = await reportReviewOutcome(candidate, outcome, ctx, scope);
		const status = result.payload.status;
		// Reached from a menu action rather than from a tool call, so there is no turn
		// about to settle and open the "what next?" menu. The notification has to name
		// the way on instead of implying one will appear.
		if (status === "accepted") {
			ctx.ui.notify(
				`Plan revision ${result.payload.revision} accepted. Run /plan to implement, export, or leave it paused.`,
				"info",
			);
			return;
		}
		if (status === "cancelled") {
			ctx.ui.notify(
				"Plan revision cancelled. The approved plan is unchanged; run /plan to implement, export, or leave it paused.",
				"info",
			);
			return;
		}
		if (status === "changes_requested") {
			// The agent asked nothing here, so the feedback has to reach it as a
			// message rather than as a tool result nobody is waiting for.
			options.sendToAgent(
				ctx,
				`The user reviewed the proposed plan revision and asked for changes: ${String(result.payload.feedback)}\n\nCall update_plan again with action "propose", revisionId "${candidate.revisionId}", expectedRevision ${candidate.baseRevision}, and the complete corrected plan.`,
			);
			ctx.ui.notify("Feedback sent to the agent.", "info");
			return;
		}
		ctx.ui.notify(String(result.payload.message ?? "The revision is still waiting."), "info");
	}

	/** The `/plan` cancel item: leave the revision, keep the approved plan. */
	async function cancelRevision(ctx: ExtensionContext): Promise<void> {
		const state = options.getState();
		const open = state.revision;
		if (!open) {
			ctx.ui.notify("No plan revision is in progress.", "info");
			return;
		}
		const scope = operationScope();
		await supersedeOpenProposal(state.planId, open, undefined, "the user cancelled the revision");
		if (scope.isStale()) return;
		const plan = state.planPath ? await readPlanFile(state.planPath) : undefined;
		if (scope.isStale()) return;
		if (plan === undefined) {
			options.setState(ctx, { revision: undefined });
			ctx.ui.notify("Plan revision cancelled.", "info");
			return;
		}
		closeTransaction(ctx, state, plan, "Approved Plan (revision cancelled)");
		ctx.ui.notify(
			"Plan revision cancelled. The approved plan is unchanged; run /plan to implement, export, or leave it paused.",
			"info",
		);
	}

	/** The `/plan` confirm item: record the plan file as it is as approved. */
	async function confirmCurrentPlan(ctx: ExtensionContext): Promise<void> {
		const state = options.getState();
		if (!state.planPath || state.enabled) {
			ctx.ui.notify("No plan is being implemented.", "warning");
			return;
		}
		const result = await approveCurrentPlan(
			ctx,
			"the user confirmed the plan file as approved",
		);
		if (!result.ok) {
			ctx.ui.notify(`Unable to confirm the plan: ${result.error}`, "error");
			return;
		}
		ctx.ui.notify(
			result.warning
				? `Plan confirmed as approved. ${result.warning}`
				: result.revision !== undefined
					? `Plan confirmed as approved (revision ${result.revision}).`
					: "Plan confirmed as approved.",
			result.warning ? "warning" : "info",
		);
	}

	return {
		begin,
		propose,
		read,
		approveCurrentPlan,
		ensureIdentity,
		reconcileOnSessionStart,
		reviewPendingRevision,
		cancelRevision,
		retireOpenRevision,
		pauseManagedPlan,
		confirmCurrentPlan,
		/** Dropped when a session starts or the plan is cleared. */
		reset() {
			pendingProposal = undefined;
		},
		/**
		 * Whether `/plan` has a candidate it can actually open.
		 *
		 * The menu must not key this off `revision.proposalId` alone. An interrupted
		 * `propose` writes the candidate before that id reaches session state, and the
		 * result of reading state only is a menu that says "Nothing has been proposed
		 * yet" about a candidate both the reconcile notice and the tool result promise is
		 * waiting — with Cancel short-circuiting too. This answers from the same
		 * discovery the review and cancel paths use, so the three cannot disagree.
		 */
		hasPendingProposal(): boolean {
			const state = options.getState();
			const open = state.revision;
			if (!open || !state.planId) return false;
			if (open.proposalId !== undefined) return true;
			return (
				pendingProposal !== undefined &&
				pendingProposal.status === "pending" &&
				pendingProposal.planId === state.planId &&
				pendingProposal.revisionId === open.revisionId &&
				pendingProposal.baseRevision === open.baseRevision &&
				pendingProposal.baseDigest === open.baseDigest
			);
		},
		approvalNotice(approval: PlanApproval): string | undefined {
			return approvalNotice(approval);
		},
		describeDiff: describePlanDiff,
	};
}

export type PlanRevisionController = ReturnType<typeof createPlanRevisionController>;

/**
 * The card body. The computed diff leads, because that is what is being
 * approved; the agent's summary sits above it as context, clearly labelled as
 * the agent's account rather than as the change itself.
 */
export function formatProposalCard(summary: PlanRevisionSummary): string {
	const lines = [
		`**Requested:** ${summary.instructions}`,
		"",
		`**Agent summary:** ${summary.changeSummary}`,
		"",
		`**Computed change against revision ${summary.baseRevision}:** ${summary.added} line(s) added, ${summary.removed} line(s) removed.`,
	];
	if (summary.conflict) lines.push("", `**Note:** ${summary.conflict}`);
	if (summary.diff.length > 0) {
		lines.push("", "```diff", ...summary.diff, "```");
	}
	return lines.join("\n");
}

/**
 * Two requests for one revision, kept in order and deduplicated.
 *
 * The user adding to what they asked for is normal; the second ask replacing the
 * first silently is how a revision ends up missing half its intent.
 */
function mergeInstructions(existing: string, addition: string): string {
	const trimmed = addition.trim();
	if (!trimmed) return existing;
	if (!existing) return trimmed;
	return existing.includes(trimmed) ? existing : `${existing}\n\nAlso: ${trimmed}`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
