/**
 * Everything stateful about a session's task set, in one place.
 *
 * The tools, the command, and the widget are all thin skins over this object,
 * which owns: which set this session is attached to, what the document on disk
 * says, whether the two still agree, which proposals are pending, and the one
 * path through which a change becomes an accepted revision.
 *
 * Two invariants are worth stating, because most of the code below exists to
 * keep them:
 *
 *   1. A change is always computed against a document just read from disk,
 *      under the store's lock, and committed only if the bytes it was computed
 *      from are still there. There is no in-memory "current set" that a write
 *      trusts.
 *   2. Disagreement is never resolved silently. If the document moved in a way
 *      this session cannot explain, mutation stops and a human chooses, because
 *      the alternative is overwriting work nobody agreed to overwrite.
 */

import { resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyTaskChanges,
	type ApplyResult,
	isProgressOnlyBatch,
	type TaskChange,
} from "./changes.js";
import { parseTaskDocument, serializeTaskDocument, type TaskDocument } from "./markdown.js";
import {
	countTasks,
	createTaskSet,
	inProgressTask,
	isOpenStatus,
	MAX_LABEL_LENGTH,
	type TaskSet,
	validateSummary,
} from "./model.js";
import {
	clearTasksUi,
	formatTaskSetMarkdown,
	showTasksCard,
	tasksStatusText,
	type TasksUiState,
	updateTasksUi,
} from "./presentation.js";
import {
	diffTaskSets,
	listPendingProposals,
	newProposalId,
	type ProposalStatus,
	resolveProposal,
	type TaskProposal,
	writeProposal,
} from "./proposals.js";
import { createSessionGuard, type GuardScope } from "./session-guard.js";
import { restoreTasksAttachment, type TasksAttachment } from "./state.js";
import {
	commitTaskDocument,
	isSafeTaskSetId,
	latestSnapshot,
	type LoadedDocument,
	loadTaskDocument,
	matchesOwnSnapshot,
	newTaskSetId,
	taskDocumentPath,
	tasksRootDirectory,
	writeAtomically,
} from "./store.js";
import type { ReviewOutcome } from "./task-menus.js";

export const TASKS_STATE_ENTRY_TYPE = "pi-tasks-state";
/** Enough for a real reorganisation, few enough that a runaway batch is refused. */
export const MAX_CHANGES_PER_BATCH = 100;

type InteractiveUi = typeof import("./interactive-ui.js");

export interface TasksControllerDependencies {
	/** The tasks root. Defaults to `<agentDir>/tasks`. */
	root?: string;
	now?: () => string;
	loadInteractiveUi?: () => Promise<InteractiveUi>;
	newTaskSetId?: () => string;
}

export interface RecoveryState {
	reason: string;
	documentRevision?: number;
	recordedRevision?: number;
	snapshotRevision?: number;
	snapshotPath?: string;
}

export interface UpdateTasksInput {
	taskSetId?: string;
	expectedRevision?: number;
	mode: "apply" | "propose";
	reason?: string;
	changes: TaskChange[];
}

export interface ToolOutcome {
	payload: Record<string, unknown>;
	isError?: boolean;
}

export class TasksController {
	private readonly pi: ExtensionAPI;
	private readonly dependencies: TasksControllerDependencies;
	private readonly guard = createSessionGuard();
	private attachment: TasksAttachment | undefined;
	private loaded: LoadedDocument | undefined;
	private pendingProposals: TaskProposal[] = [];
	private recovery: RecoveryState | undefined;
	private interactiveUiPromise: Promise<InteractiveUi> | undefined;

	constructor(pi: ExtensionAPI, dependencies: TasksControllerDependencies = {}) {
		this.pi = pi;
		this.dependencies = dependencies;
	}

	get root(): string {
		return this.dependencies.root ?? tasksRootDirectory();
	}

	private now(): string {
		return this.dependencies.now?.() ?? new Date().toISOString();
	}

	private allocateTaskSetId(): string {
		return this.dependencies.newTaskSetId?.() ?? newTaskSetId();
	}

	/** The current view of the world, for the widget, the footer, and menus. */
	get uiState(): TasksUiState {
		return {
			...(this.loaded ? { set: this.loaded.document.set } : {}),
			pendingReview: this.pendingProposals.length > 0,
			...(this.recovery ? { blocked: this.recovery.reason } : {}),
		};
	}

	get attachedSet(): TaskSet | undefined {
		return this.loaded?.document.set;
	}

	get attachedPath(): string | undefined {
		return this.loaded?.path;
	}

	get recoveryState(): RecoveryState | undefined {
		return this.recovery;
	}

	get pending(): readonly TaskProposal[] {
		return this.pendingProposals;
	}

	// ---------------------------------------------------------------- lifecycle

	async onSessionStart(ctx: ExtensionContext): Promise<void> {
		const scope = this.guard.nextSession("pi-tasks session replaced");
		this.attachment = restoreTasksAttachment(
			ctx.sessionManager.getBranch(),
			TASKS_STATE_ENTRY_TYPE,
		);
		this.loaded = undefined;
		this.pendingProposals = [];
		this.recovery = undefined;
		if (this.attachment) await this.reconcile(ctx, scope);
		if (!scope.isCurrent()) return;
		this.refreshUi(ctx);
	}

	onSessionShutdown(ctx: ExtensionContext): void {
		this.guard.endSession("pi-tasks session shut down");
		clearTasksUi(ctx);
	}

	/**
	 * Tree navigation moves the branch without starting a session, so the
	 * attachment has to be re-read from the branch the user landed on. A branch
	 * that never had a task set has none — the previous one is not carried across.
	 *
	 * What is deliberately *not* done here is rewinding the document. Moving the
	 * conversation back does not un-write the work the later turns did, so a
	 * document ahead of this branch is followed and reported, and a document that
	 * matches no accepted revision becomes a conflict for a human to resolve.
	 */
	async onSessionTree(ctx: ExtensionContext): Promise<void> {
		const previous = this.attachment?.taskSetId;
		this.guard.nextAttachment();
		const scope = this.guard.capture();
		this.attachment = restoreTasksAttachment(
			ctx.sessionManager.getBranch(),
			TASKS_STATE_ENTRY_TYPE,
		);
		this.loaded = undefined;
		this.pendingProposals = [];
		this.recovery = undefined;
		if (this.attachment) await this.reconcile(ctx, scope);
		if (!scope.isCurrent()) return;
		this.refreshUi(ctx);
		const current = this.attachment?.taskSetId;
		if (previous === current) return;
		ctx.ui.notify(
			current
				? `This branch tracks task set ${current}.`
				: "This branch tracks no task set. Nothing on disk was changed.",
			"info",
		);
	}

	/**
	 * The session-start and tree-navigation path: read the document the recorded
	 * attachment names, classify it with `adopt`, and say out loud what happened.
	 * A document that is gone or unreadable never gets as far as classification —
	 * there is nothing to compare, so it goes straight to recovery.
	 */
	private async reconcile(ctx: ExtensionContext, scope: GuardScope): Promise<void> {
		const attachment = this.attachment;
		if (!attachment) return;
		if (!isSafeTaskSetId(attachment.taskSetId)) {
			this.attachment = undefined;
			return;
		}
		const path = taskDocumentPath(this.root, attachment.taskSetId);
		const result = await loadTaskDocument(path);
		if (!scope.isCurrent()) return;
		if (result.kind === "missing") {
			const snapshot = await latestSnapshot(this.root, attachment.taskSetId);
			if (!scope.isCurrent()) return;
			this.recovery = {
				reason: "the task document is gone",
				recordedRevision: attachment.revision,
				...(snapshot ? { snapshotRevision: snapshot.revision, snapshotPath: snapshot.path } : {}),
			};
			ctx.ui.notify(
				snapshot
					? `The task document for this session is missing. A snapshot of revision ${snapshot.revision} is on disk; run /tasks recover to choose what to do.`
					: "The task document for this session is missing and no snapshot was found. Run /tasks recover.",
				"warning",
			);
			return;
		}
		if (result.kind === "invalid") {
			const snapshot = await latestSnapshot(this.root, attachment.taskSetId);
			if (!scope.isCurrent()) return;
			this.recovery = {
				reason: `the task document is unreadable (${result.reason})`,
				recordedRevision: attachment.revision,
				...(snapshot ? { snapshotRevision: snapshot.revision, snapshotPath: snapshot.path } : {}),
			};
			ctx.ui.notify(
				`The task document is unreadable: ${result.reason}. Run /tasks recover.`,
				"warning",
			);
			return;
		}

		await this.refreshProposals(attachment.taskSetId);
		if (!scope.isCurrent()) return;
		const outcome = await this.adopt(result.loaded, attachment);
		if (!scope.isCurrent()) return;
		if (outcome === "advanced") {
			ctx.ui.notify(
				`The task set advanced to revision ${result.loaded.document.set.revision} elsewhere; this session is now following it.`,
				"info",
			);
			return;
		}
		if (outcome === "diverged") {
			ctx.ui.notify(
				`The task document no longer matches what this session accepted (${this.recovery?.reason}). Task changes are paused until /tasks recover.`,
				"warning",
			);
		}
	}

	/**
	 * Decide what a freshly read document means for the recorded attachment, and
	 * take it on when it is explicable.
	 *
	 * The one non-obvious case is `advanced`. A revision this session has never
	 * seen is *not* a conflict when the document is byte-identical to the
	 * immutable snapshot of its own revision — that is exactly what a cooperating
	 * session's commit leaves behind, and refusing it would make two Pi sessions
	 * on one task set unusable. Anything else is `diverged`: the document matches
	 * no accepted revision, or it is behind the one this branch recorded, and
	 * either way a human decides rather than the next write silently building on
	 * top of it.
	 */
	private async adopt(
		loaded: LoadedDocument,
		attachment: TasksAttachment,
	): Promise<"same" | "advanced" | "diverged"> {
		this.loaded = loaded;
		if (loaded.digest === attachment.digest) {
			this.recovery = undefined;
			return "same";
		}
		const revision = loaded.document.set.revision;
		if (
			revision > attachment.revision &&
			(await matchesOwnSnapshot(this.root, attachment.taskSetId, revision, loaded.digest))
		) {
			this.recovery = undefined;
			this.recordAttachment(loaded);
			return "advanced";
		}
		this.recovery = {
			reason:
				revision < attachment.revision
					? `the document is at revision ${revision}, behind the revision ${attachment.revision} this branch recorded`
					: "the document was modified outside this package",
			documentRevision: revision,
			recordedRevision: attachment.revision,
			...(await this.snapshotHint(attachment.taskSetId)),
		};
		return "diverged";
	}

	/**
	 * Re-read the document and re-classify it. Called at every read, at every
	 * write, and at the turn boundary, which is the whole conflict-detection
	 * strategy: no watcher, no cached document trusted across an await, and an
	 * outside modification noticed before it can be built on rather than after.
	 */
	async refreshFromDisk(ctx: ExtensionContext): Promise<void> {
		const attachment = this.attachment;
		if (!attachment) return;
		const hadRecovery = this.recovery !== undefined;
		const result = await loadTaskDocument(taskDocumentPath(this.root, attachment.taskSetId));
		if (this.attachment !== attachment) return;
		if (result.kind !== "loaded") {
			this.recovery = {
				reason:
					result.kind === "missing"
						? "the task document is gone"
						: `the task document is unreadable (${result.reason})`,
				recordedRevision: attachment.revision,
				...(await this.snapshotHint(attachment.taskSetId)),
			};
		} else {
			const outcome = await this.adopt(result.loaded, attachment);
			await this.refreshProposals(attachment.taskSetId);
			if (outcome === "advanced") {
				ctx.ui.notify(
					`The task set advanced to revision ${result.loaded.document.set.revision} elsewhere; this session is now following it.`,
					"info",
				);
			}
		}
		if (this.recovery && !hadRecovery) {
			ctx.ui.notify(
				`The task document changed outside this package (${this.recovery.reason}). Task changes are paused until /tasks recover.`,
				"warning",
			);
		}
		this.refreshUi(ctx);
	}

	private async snapshotHint(
		taskSetId: string,
	): Promise<{ snapshotRevision?: number; snapshotPath?: string }> {
		const snapshot = await latestSnapshot(this.root, taskSetId);
		return snapshot ? { snapshotRevision: snapshot.revision, snapshotPath: snapshot.path } : {};
	}

	private async refreshProposals(taskSetId: string): Promise<void> {
		this.pendingProposals = await listPendingProposals(this.root, taskSetId);
	}

	private recordAttachment(loaded: LoadedDocument): void {
		this.attachment = {
			taskSetId: loaded.document.set.taskSetId,
			revision: loaded.document.set.revision,
			digest: loaded.digest,
			recordedAt: this.now(),
		};
		this.pi.appendEntry<TasksAttachment>(TASKS_STATE_ENTRY_TYPE, this.attachment);
	}

	private recordDetached(): void {
		this.attachment = undefined;
		this.loaded = undefined;
		this.pendingProposals = [];
		this.recovery = undefined;
		this.guard.nextAttachment();
		this.pi.appendEntry(TASKS_STATE_ENTRY_TYPE, { detached: true, recordedAt: this.now() });
	}

	refreshUi(ctx: ExtensionContext): void {
		updateTasksUi(ctx, this.uiState);
	}

	// -------------------------------------------------------------------- reads

	async readTasks(ctx: ExtensionContext, taskSetId?: string): Promise<ToolOutcome> {
		await this.refreshFromDisk(ctx);
		if (taskSetId !== undefined) {
			if (!isSafeTaskSetId(taskSetId)) {
				return { payload: { status: "invalid_input", message: `unsafe task set id: ${taskSetId}` }, isError: true };
			}
			if (this.attachment && taskSetId === this.attachment.taskSetId) {
				return this.describeAttached();
			}
			const result = await loadTaskDocument(taskDocumentPath(this.root, taskSetId));
			if (result.kind !== "loaded") {
				return {
					payload: {
						status: "not_found",
						taskSetId,
						message:
							result.kind === "missing"
								? "no managed task set with that id"
								: `the task document is unreadable: ${result.reason}`,
					},
					isError: true,
				};
			}
			const pending = await listPendingProposals(this.root, taskSetId);
			return {
				payload: {
					status: "ok",
					attached: false,
					note: "read-only: requesting another task set does not attach this session to it",
					...describeSet(result.loaded, pending),
				},
			};
		}
		return this.describeAttached();
	}

	private async describeAttached(): Promise<ToolOutcome> {
		if (!this.attachment || !this.loaded) {
			return {
				payload: {
					status: "no_task_set",
					attached: false,
					message:
						"no task set is attached to this session. Create one with update_tasks using a single init change once the user has agreed what the work is.",
				},
			};
		}
		return {
			payload: {
				status: "ok",
				attached: true,
				...describeSet(this.loaded, this.pendingProposals),
				...(this.recovery
					? {
							mutationsBlocked: true,
							recovery: this.recovery.reason,
							recoveryInstruction:
								"task changes are refused until the user runs /tasks recover and chooses how to resolve the conflict",
						}
					: {}),
			},
		};
	}

	// ------------------------------------------------------------------ updates

	async updateTasks(input: UpdateTasksInput, ctx: ExtensionContext): Promise<ToolOutcome> {
		if (!Array.isArray(input.changes) || input.changes.length === 0) {
			return fail("invalid_input", "changes must contain at least one change");
		}
		if (input.changes.length > MAX_CHANGES_PER_BATCH) {
			return fail(
				"invalid_input",
				`changes must not exceed ${MAX_CHANGES_PER_BATCH} entries in one batch`,
			);
		}
		if (input.mode !== "apply" && input.mode !== "propose") {
			return fail("invalid_input", 'mode must be "apply" or "propose"');
		}
		const isInit = input.changes.some((change) => change.op === "init");
		if (isInit) return this.initialize(input, ctx);
		// Re-read before deciding anything: the document this batch will be built on
		// is the one on disk right now, not the one this session last saw.
		await this.refreshFromDisk(ctx);
		if (this.recovery) {
			return fail(
				"recovery_required",
				`the task document needs recovery before it can change: ${this.recovery.reason}. Ask the user to run /tasks recover; do not edit the file directly.`,
			);
		}
		if (!this.attachment) {
			return fail(
				"no_task_set",
				"no task set is attached to this session. Create one with a single init change first.",
			);
		}
		if (input.taskSetId !== undefined && input.taskSetId !== this.attachment.taskSetId) {
			return fail(
				"wrong_task_set",
				`this session is attached to ${this.attachment.taskSetId}; update_tasks never changes a task set it is not attached to`,
			);
		}

		const current = this.loaded;
		if (!current) {
			return fail(
				"recovery_required",
				"the task document could not be read. Ask the user to run /tasks recover.",
			);
		}
		const set = current.document.set;
		if (set.archivedAt) {
			return fail(
				"archived",
				`task set ${set.taskSetId} was archived on ${set.archivedAt} and no longer accepts changes. The user can start a new one with /tasks new.`,
			);
		}
		if (input.expectedRevision !== undefined && input.expectedRevision !== set.revision) {
			return fail(
				"stale_revision",
				`expectedRevision ${input.expectedRevision} does not match the accepted revision ${set.revision}. Call get_tasks and rebuild the batch against the current ids.`,
				{ currentRevision: set.revision },
			);
		}

		const applied = applyTaskChanges(set, input.changes, {
			now: this.now(),
			hasExistingSet: true,
		});
		if (!applied.ok) return fail("invalid_change", applied.error, { currentRevision: set.revision });

		const nextDocument: TaskDocument = {
			set: applied.result.set,
			extras: current.document.extras,
		};
		if (input.mode === "propose") {
			return this.proposeRevision(input, current, nextDocument, applied.result.applied, ctx);
		}
		return this.applyRevision(current, nextDocument, applied.result, input.changes, ctx);
	}

	private async initialize(input: UpdateTasksInput, ctx: ExtensionContext): Promise<ToolOutcome> {
		if (input.changes.length > 1) {
			return fail("invalid_change", "init must be the only change in a batch");
		}
		if (this.attachment) {
			return fail(
				"already_attached",
				`task set ${this.attachment.taskSetId} is already attached to this session; init never replaces one. The user can detach it with /tasks new or file it with /tasks archive.`,
			);
		}
		if (input.mode === "propose") {
			return fail(
				"invalid_input",
				'init is always applied, never proposed: there is no accepted task set to revise yet. Call update_tasks again with mode "apply".',
			);
		}
		const taskSetId = this.allocateTaskSetId();
		const now = this.now();
		const seed = createTaskSet(taskSetId, now);
		const applied = applyTaskChanges(seed, input.changes, {
			now,
			hasExistingSet: false,
		});
		if (!applied.ok) return fail("invalid_change", applied.error);

		const result = await commitTaskDocument({
			root: this.root,
			document: { set: applied.result.set, extras: [] },
			expectedDigest: undefined,
			now,
		});
		if (result.kind !== "committed") {
			return fail(
				result.kind === "conflict" ? "conflict" : "write_failed",
				`the new task set could not be written: ${result.reason}`,
			);
		}
		const parsed = parseTaskDocument(result.raw);
		if (!parsed.ok) return fail("write_failed", `the new task set did not round-trip: ${parsed.error}`);
		this.guard.nextAttachment();
		this.loaded = {
			document: parsed.document,
			raw: result.raw,
			digest: result.digest,
			path: result.path,
		};
		this.pendingProposals = [];
		this.recovery = undefined;
		this.recordAttachment(this.loaded);
		this.refreshUi(ctx);
		showTasksCard(
			this.pi,
			ctx,
			"Task set created",
			formatTaskSetMarkdown(parsed.document.set),
		);
		return {
			payload: {
				status: "applied",
				taskSetId,
				revision: result.revision,
				path: result.path,
				phases: applied.result.allocatedPhases,
				tasks: applied.result.allocatedTasks,
				applied: applied.result.applied,
			},
		};
	}

	private async applyRevision(
		current: LoadedDocument,
		next: TaskDocument,
		applied: ApplyResult,
		changes: readonly TaskChange[],
		ctx: ExtensionContext,
	): Promise<ToolOutcome> {
		const result = await commitTaskDocument({
			root: this.root,
			document: next,
			expectedDigest: current.digest,
			now: this.now(),
		});
		if (result.kind !== "committed") {
			return fail(
				result.kind === "conflict" ? "conflict" : "write_failed",
				`the change was not applied: ${result.reason}. Call get_tasks and rebuild the batch.`,
			);
		}
		const parsed = parseTaskDocument(result.raw);
		if (!parsed.ok) return fail("write_failed", `the committed document did not round-trip: ${parsed.error}`);
		this.loaded = {
			document: parsed.document,
			raw: result.raw,
			digest: result.digest,
			path: result.path,
		};
		this.recordAttachment(this.loaded);
		this.refreshUi(ctx);
		const counts = countTasks(parsed.document.set);
		return {
			payload: {
				status: "applied",
				taskSetId: parsed.document.set.taskSetId,
				revision: result.revision,
				progressOnly: isProgressOnlyBatch(changes),
				phases: applied.allocatedPhases,
				tasks: applied.allocatedTasks,
				applied: applied.applied,
				counts: { total: counts.total, open: counts.open, completed: counts.completed },
			},
		};
	}

	/**
	 * Save a candidate revision and put it in front of the user.
	 *
	 * The review runs inside the tool call, which is the point: the model asks,
	 * the user decides, and the answer comes back as the tool result in the same
	 * turn. Waiting on a person is allowed; waiting on this session's own idle
	 * state would deadlock, so nothing here does it.
	 */
	private async proposeRevision(
		input: UpdateTasksInput,
		current: LoadedDocument,
		next: TaskDocument,
		appliedLines: string[],
		ctx: ExtensionContext,
	): Promise<ToolOutcome> {
		const reason = validateSummary(input.reason, "reason");
		if (!reason.ok) {
			return fail(
				"invalid_input",
				`${reason.error}. A proposal needs the requested change in the user's own terms.`,
			);
		}
		const now = this.now();
		const proposedDocument = serializeTaskDocument(next);
		const proposal: TaskProposal = {
			schemaVersion: 1,
			proposalId: newProposalId(),
			taskSetId: current.document.set.taskSetId,
			status: "pending",
			reason: reason.value,
			baseRevision: current.document.set.revision,
			baseDigest: current.digest,
			createdAt: now,
			proposedDocument,
			diff: diffTaskSets(current.document.set, next.set),
			applied: appliedLines,
		};
		await writeProposal(this.root, proposal);
		this.pendingProposals = [...this.pendingProposals, proposal];
		this.refreshUi(ctx);
		showTasksCard(this.pi, ctx, "Proposed task revision", formatProposalCard(proposal));

		const outcome = await this.presentReview(proposal, ctx);
		return this.reportReviewOutcome(proposal, outcome, ctx);
	}

	/** Opens the review menu for a pending proposal. Safe to call again later. */
	async presentReview(proposal: TaskProposal, ctx: ExtensionContext): Promise<ReviewOutcome> {
		if (!ctx.hasUI) return { kind: "unavailable" };
		const scope = this.guard.capture();
		if (!scope.isCurrent() || scope.signal.aborted) return { kind: "dismissed" };
		const ui = await this.interactiveUi();
		if (!scope.isCurrent() || scope.signal.aborted) return { kind: "dismissed" };
		return ui.showTaskReviewMenu(ctx, {
			summary: {
				reason: proposal.reason,
				baseRevision: proposal.baseRevision,
				diff: proposal.diff,
				proposedDocument: proposal.proposedDocument,
			},
			signal: scope.signal,
			isCurrent: scope.isCurrent,
		});
	}

	private async reportReviewOutcome(
		proposal: TaskProposal,
		outcome: ReviewOutcome,
		ctx: ExtensionContext,
	): Promise<ToolOutcome> {
		if (outcome.kind === "accepted") return this.acceptProposal(proposal, ctx);
		if (outcome.kind === "changes_requested") {
			this.refreshUi(ctx);
			return {
				payload: {
					status: "changes_requested",
					proposalId: proposal.proposalId,
					baseRevision: proposal.baseRevision,
					feedback: outcome.feedback,
					instruction:
						'Revise the proposal: call update_tasks again with mode "propose" and the complete corrected set of changes against this base revision.',
				},
			};
		}
		if (outcome.kind === "cancelled") {
			await this.resolve(proposal, "cancelled");
			this.refreshUi(ctx);
			return {
				payload: {
					status: "cancelled",
					proposalId: proposal.proposalId,
					acceptedRevision: proposal.baseRevision,
					message:
						"The user cancelled the proposed revision. The accepted task set is unchanged; the proposal is kept on file.",
				},
			};
		}
		this.refreshUi(ctx);
		return {
			payload: {
				status: "pending_review",
				proposalId: proposal.proposalId,
				baseRevision: proposal.baseRevision,
				message:
					outcome.kind === "unavailable"
						? "This session cannot show a review, so the proposal is saved and waiting. It is not approved."
						: "The review was closed without a decision. The proposal is saved and waiting; /tasks review reopens it.",
			},
		};
	}

	/**
	 * Publish a proposal, but only against the exact bytes it was computed from.
	 *
	 * A stale base is not a reason to lose the work: the proposal stays pending
	 * and the agent is told to refresh it, which is cheap. Publishing it anyway
	 * would silently discard whatever landed in between — often the progress the
	 * user made while reading the proposal.
	 */
	async acceptProposal(proposal: TaskProposal, ctx: ExtensionContext): Promise<ToolOutcome> {
		const current = await loadTaskDocument(taskDocumentPath(this.root, proposal.taskSetId));
		if (current.kind !== "loaded") {
			return fail(
				"recovery_required",
				"the task document is no longer readable, so the proposal was not published. The proposal is still on file.",
			);
		}
		if (current.loaded.digest !== proposal.baseDigest) {
			this.loaded = current.loaded;
			this.refreshUi(ctx);
			return fail(
				"stale_proposal",
				`the task set moved to revision ${current.loaded.document.set.revision} while the proposal was under review, so it was not published. The proposal is still on file: call get_tasks and propose again against the current revision.`,
				{
					proposalId: proposal.proposalId,
					baseRevision: proposal.baseRevision,
					currentRevision: current.loaded.document.set.revision,
				},
			);
		}
		const parsed = parseTaskDocument(proposal.proposedDocument);
		if (!parsed.ok) {
			return fail("invalid_proposal", `the stored proposal is unreadable: ${parsed.error}`);
		}
		const result = await commitTaskDocument({
			root: this.root,
			document: parsed.document,
			expectedDigest: proposal.baseDigest,
			now: this.now(),
		});
		if (result.kind !== "committed") {
			return fail(
				result.kind === "conflict" ? "stale_proposal" : "write_failed",
				`the proposal was not published: ${result.reason}. It is still on file.`,
				{ proposalId: proposal.proposalId },
			);
		}
		const committed = parseTaskDocument(result.raw);
		if (!committed.ok) {
			return fail("write_failed", `the committed document did not round-trip: ${committed.error}`);
		}
		this.loaded = {
			document: committed.document,
			raw: result.raw,
			digest: result.digest,
			path: result.path,
		};
		await this.resolve(proposal, "accepted");
		this.recordAttachment(this.loaded);
		this.refreshUi(ctx);
		showTasksCard(
			this.pi,
			ctx,
			`Task revision ${result.revision} accepted`,
			formatTaskSetMarkdown(committed.document.set),
		);
		return {
			payload: {
				status: "accepted",
				proposalId: proposal.proposalId,
				taskSetId: proposal.taskSetId,
				revision: result.revision,
				applied: proposal.applied,
			},
		};
	}

	private async resolve(proposal: TaskProposal, status: Exclude<ProposalStatus, "pending">) {
		await resolveProposal(this.root, proposal, status, this.now());
		this.pendingProposals = this.pendingProposals.filter(
			(candidate) => candidate.proposalId !== proposal.proposalId,
		);
	}

	// ----------------------------------------------------------------- commands

	async showTasks(ctx: ExtensionContext): Promise<void> {
		if (!this.loaded) {
			ctx.ui.notify(tasksStatusText(this.uiState), "info");
			return;
		}
		showTasksCard(
			this.pi,
			ctx,
			this.loaded.document.set.label
				? `Tasks — ${this.loaded.document.set.label}`
				: "Tasks",
			formatTaskSetMarkdown(this.loaded.document.set),
		);
	}

	async reviewPending(ctx: ExtensionContext): Promise<void> {
		const proposal = this.pendingProposals[0];
		if (!proposal) {
			ctx.ui.notify("No proposed task revision is waiting for review.", "info");
			return;
		}
		const outcome = await this.presentReview(proposal, ctx);
		const result = await this.reportReviewOutcome(proposal, outcome, ctx);
		const status = result.payload.status;
		if (status === "accepted") {
			ctx.ui.notify(`Task revision ${result.payload.revision} accepted.`, "info");
			return;
		}
		if (status === "cancelled") {
			ctx.ui.notify("Proposed task revision cancelled. The task set is unchanged.", "info");
			return;
		}
		if (status === "changes_requested") {
			// The agent asked nothing here, so the feedback has to reach it as a
			// message rather than as a tool result nobody is waiting for.
			this.sendToAgent(
				ctx,
				`The user reviewed the proposed task revision ${proposal.proposalId} and asked for changes: ${String(result.payload.feedback)}\n\nCall update_tasks again with mode "propose" and the complete corrected set of changes.`,
			);
			ctx.ui.notify("Feedback sent to the agent.", "info");
			return;
		}
		ctx.ui.notify(String(result.payload.message ?? "The proposal is still waiting."), "info");
	}

	async startNew(ctx: ExtensionContext): Promise<void> {
		if (!this.attachment) {
			ctx.ui.notify(
				"No task set is attached. Ask for the task list you want and the agent will create it.",
				"info",
			);
			return;
		}
		const previous = this.attachment.taskSetId;
		this.recordDetached();
		this.refreshUi(ctx);
		ctx.ui.notify(
			`Detached from task set ${previous}, which is preserved on disk. Ask for the new task list and the agent will create it.`,
			"info",
		);
	}

	async archive(ctx: ExtensionContext): Promise<boolean> {
		if (!this.loaded || !this.attachment) {
			ctx.ui.notify("No task set is attached to archive.", "warning");
			return false;
		}
		if (this.recovery) {
			ctx.ui.notify("Recover the task set before archiving it.", "warning");
			return false;
		}
		const open = this.loaded.document.set.phases
			.flatMap((phase) => phase.tasks)
			.filter((task) => isOpenStatus(task.status));
		if (open.length > 0) {
			ctx.ui.notify(
				`${open.length} task(s) are still open. Close or abandon them before archiving; archiving never closes work for you.`,
				"warning",
			);
			return false;
		}
		const now = this.now();
		const result = await commitTaskDocument({
			root: this.root,
			document: {
				set: { ...this.loaded.document.set, archivedAt: now },
				extras: this.loaded.document.extras,
			},
			expectedDigest: this.loaded.digest,
			now,
		});
		if (result.kind !== "committed") {
			ctx.ui.notify(`Unable to archive the task set: ${result.reason}`, "error");
			return false;
		}
		const path = result.path;
		this.recordDetached();
		this.refreshUi(ctx);
		ctx.ui.notify(`Task set archived at revision ${result.revision}. It remains at ${path}.`, "info");
		return true;
	}

	/**
	 * Writes the current list to a file the user names. The accepted task set is
	 * untouched, and an existing file is never overwritten: an export that
	 * clobbers something is a worse outcome than an export that asks again.
	 */
	async exportTasks(destination: string, ctx: ExtensionContext): Promise<boolean> {
		if (!this.loaded) {
			ctx.ui.notify("No task set is attached to export.", "warning");
			return false;
		}
		const resolved = resolveExportPath(destination, ctx.cwd);
		if (!resolved.ok) {
			ctx.ui.notify(resolved.error, "warning");
			return false;
		}
		const existing = await loadTaskDocument(resolved.path);
		if (existing.kind !== "missing") {
			ctx.ui.notify(`${resolved.path} already exists. Choose another path.`, "warning");
			return false;
		}
		try {
			await writeAtomically(
				resolved.path,
				`# Tasks\n\n${formatTaskSetMarkdown(this.loaded.document.set)}\n`,
			);
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to export the task list: ${detail}`, "error");
			return false;
		}
		ctx.ui.notify(`Task list exported to ${resolved.path}.`, "info");
		return true;
	}

	/** Recovery option: take the document on disk as the truth from here on. */
	async recoverAttachCurrent(ctx: ExtensionContext): Promise<void> {
		const taskSetId = this.attachment?.taskSetId ?? this.loaded?.document.set.taskSetId;
		if (!taskSetId) {
			ctx.ui.notify("There is no task set to recover.", "warning");
			return;
		}
		const current = await loadTaskDocument(taskDocumentPath(this.root, taskSetId));
		if (current.kind !== "loaded") {
			ctx.ui.notify(
				current.kind === "missing"
					? "The task document is still missing."
					: `The task document is still unreadable: ${current.reason}`,
				"warning",
			);
			return;
		}
		this.loaded = current.loaded;
		this.recovery = undefined;
		await this.refreshProposals(taskSetId);
		this.recordAttachment(current.loaded);
		this.refreshUi(ctx);
		ctx.ui.notify(
			`Attached to the task document as it stands, at revision ${current.loaded.document.set.revision}.`,
			"info",
		);
	}

	/**
	 * Recovery option: copy the newest recorded snapshot into a brand new set.
	 *
	 * A fork rather than a rollback. Whatever is on disk stays there, and the new
	 * set gets a new id, so nothing that another session is working from is
	 * overwritten by this session's idea of history.
	 */
	async recoverForkSnapshot(ctx: ExtensionContext): Promise<void> {
		const snapshotPath = this.recovery?.snapshotPath;
		if (!snapshotPath) {
			ctx.ui.notify("No snapshot is available to fork.", "warning");
			return;
		}
		const snapshot = await loadTaskDocument(snapshotPath);
		if (snapshot.kind !== "loaded") {
			ctx.ui.notify("The snapshot could not be read.", "warning");
			return;
		}
		const now = this.now();
		const label = snapshot.loaded.document.set.label;
		const forked: TaskSet = {
			...snapshot.loaded.document.set,
			taskSetId: this.allocateTaskSetId(),
			revision: 0,
			createdAt: now,
			updatedAt: now,
			label: `${label ? `${label} ` : ""}(recovered)`.slice(0, MAX_LABEL_LENGTH),
		};
		delete forked.archivedAt;
		const result = await commitTaskDocument({
			root: this.root,
			document: { set: forked, extras: snapshot.loaded.document.extras },
			expectedDigest: undefined,
			now,
		});
		if (result.kind !== "committed") {
			ctx.ui.notify(`Unable to fork the snapshot: ${result.reason}`, "error");
			return;
		}
		const parsed = parseTaskDocument(result.raw);
		if (!parsed.ok) {
			ctx.ui.notify(`The forked task set did not round-trip: ${parsed.error}`, "error");
			return;
		}
		this.guard.nextAttachment();
		this.loaded = {
			document: parsed.document,
			raw: result.raw,
			digest: result.digest,
			path: result.path,
		};
		this.pendingProposals = [];
		this.recovery = undefined;
		this.recordAttachment(this.loaded);
		this.refreshUi(ctx);
		ctx.ui.notify(
			`Forked the recorded snapshot into task set ${forked.taskSetId}. The previous document is untouched.`,
			"info",
		);
	}

	async recoverDetach(ctx: ExtensionContext): Promise<void> {
		this.recordDetached();
		this.refreshUi(ctx);
		ctx.ui.notify("This session no longer tracks a task set. Nothing was deleted.", "info");
	}

	// -------------------------------------------------------------------- prompt

	/** Counts for the one-line prompt pointer, or undefined when unattached. */
	pointerFacts():
		| {
				path: string;
				revision: number;
				open: number;
				total: number;
				inProgress?: string;
				pendingReview: boolean;
		  }
		| undefined {
		if (!this.loaded) return undefined;
		const counts = countTasks(this.loaded.document.set);
		const active = inProgressTask(this.loaded.document.set);
		return {
			path: this.loaded.path,
			revision: this.loaded.document.set.revision,
			open: counts.open,
			total: counts.total,
			...(active ? { inProgress: active.task.content } : {}),
			pendingReview: this.pendingProposals.length > 0,
		};
	}

	// --------------------------------------------------------------------- misc

	private interactiveUi(): Promise<InteractiveUi> {
		if (this.dependencies.loadInteractiveUi) return this.dependencies.loadInteractiveUi();
		if (!this.interactiveUiPromise) {
			this.interactiveUiPromise = import("./interactive-ui.js").catch((error) => {
				this.interactiveUiPromise = undefined;
				throw error;
			});
		}
		return this.interactiveUiPromise;
	}

	private sendToAgent(ctx: ExtensionContext, content: string): void {
		try {
			this.pi.sendMessage(
				{ customType: "pi-tasks-review", content, display: true },
				ctx.isIdle() ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" },
			);
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to send the review feedback: ${detail}`, "error");
		}
	}
}

function describeSet(loaded: LoadedDocument, pending: readonly TaskProposal[]) {
	const set = loaded.document.set;
	const counts = countTasks(set);
	return {
		taskSetId: set.taskSetId,
		revision: set.revision,
		digest: loaded.digest,
		path: loaded.path,
		...(set.label ? { label: set.label } : {}),
		...(set.archivedAt ? { archivedAt: set.archivedAt } : {}),
		...(set.binding ? { binding: set.binding } : {}),
		counts: {
			total: counts.total,
			pending: counts.pending,
			inProgress: counts.inProgress,
			blocked: counts.blocked,
			completed: counts.completed,
			abandoned: counts.abandoned,
			open: counts.open,
		},
		phases: set.phases.map((phase) => ({
			id: phase.id,
			name: phase.name,
			tasks: phase.tasks.map((task) => ({
				id: task.id,
				content: task.content,
				status: task.status,
				...(task.blocker !== undefined ? { blocker: task.blocker } : {}),
				...(task.completion ? { completion: task.completion } : {}),
				...(task.completionHistory
					? { supersededCompletions: task.completionHistory }
					: {}),
			})),
		})),
		pendingProposals: pending.map((proposal) => ({
			proposalId: proposal.proposalId,
			reason: proposal.reason,
			baseRevision: proposal.baseRevision,
			baseDigest: proposal.baseDigest,
			createdAt: proposal.createdAt,
		})),
	};
}

function formatProposalCard(proposal: TaskProposal): string {
	const lines = [
		`Requested: ${proposal.reason}`,
		"",
		`Against revision ${proposal.baseRevision}. Accepting publishes revision ${proposal.baseRevision + 1}.`,
		"",
		"**Changes**",
		...(proposal.diff.length > 0
			? proposal.diff.map((line) => `- ${line}`)
			: ["- _(no structural change; the proposal matches the accepted set)_"]),
	];
	return lines.join("\n");
}

function fail(status: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome {
	return { payload: { status, message, ...extra }, isError: true };
}

function resolveExportPath(
	destination: string,
	cwd: string,
): { ok: true; path: string } | { ok: false; error: string } {
	const trimmed = destination.trim();
	if (!trimmed) return { ok: false, error: "Give a path to export to, for example ./tasks.md" };
	if (trimmed.includes("\0")) return { ok: false, error: "The export path must not contain NUL." };
	if (!trimmed.endsWith(".md")) {
		return { ok: false, error: "The export path must end in .md" };
	}
	const home = process.env.HOME;
	const expanded = trimmed.startsWith("~/") && home ? resolvePath(home, trimmed.slice(2)) : trimmed;
	return { ok: true, path: resolvePath(cwd, expanded) };
}
