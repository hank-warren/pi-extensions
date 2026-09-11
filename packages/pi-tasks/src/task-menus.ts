/**
 * The menus, as pure screen builders plus one runner each.
 *
 * Screens are exported as functions of their inputs so a test can pin what a
 * menu offers without a terminal — the set of choices *is* the contract, and a
 * missing item is a lost control, not a cosmetic change.
 *
 * The review menu is the important one. It opens from the `update_tasks` tool
 * itself, so the normal path for a proposed revision is: the agent proposes,
 * the user sees the computed diff and decides. No slash command stands between
 * the proposal and the decision.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ActionsScreen, defineMenu, type ReviewScreen, runMenu } from "@narumitw/pi-tui-kit";

interface MenuLifecycle {
	signal?: AbortSignal;
	isCurrent?(): boolean;
}

export type ReviewAction = "accept" | "feedback" | "cancel";
type ReviewScreenId = "review" | "feedback" | "proposed";

export interface ReviewMenuSummary {
	reason: string;
	baseRevision: number;
	diff: readonly string[];
	proposedDocument: string;
}

/** The decision screen: exactly three outcomes, plus a way to read the detail. */
export function taskReviewScreen(
	summary: ReviewMenuSummary,
): ActionsScreen<ReviewScreenId, ReviewAction> {
	const changeCount = summary.diff.length;
	return {
		kind: "actions",
		title: "Proposed task revision",
		lines: [
			`Requested: ${summary.reason}`,
			`${changeCount} change${changeCount === 1 ? "" : "s"} against revision ${summary.baseRevision}.`,
			"Accepting publishes it as the next accepted revision.",
		],
		items: [
			{
				id: "accept",
				label: "Accept revision",
				description: "Publish it now, keeping every unchanged task's status and history.",
				action: "accept",
			},
			{
				id: "feedback",
				label: "Request changes…",
				description: "Send the agent what to change; the proposal stays on file.",
				to: "feedback",
			},
			{ id: "proposed", label: "Show the proposed document", to: "proposed" },
			{
				id: "cancel",
				label: "Cancel revision",
				description: "Keep the accepted task set exactly as it is.",
				action: "cancel",
			},
		],
		hint: "close",
	};
}

export function proposedDocumentScreen(summary: ReviewMenuSummary): ReviewScreen<ReviewAction> {
	return {
		kind: "review",
		title: "Proposed task document",
		content: summary.proposedDocument,
		format: { kind: "code", language: "markdown" },
		viewportSize: "adaptive",
		hint: "back",
	};
}

export type ReviewOutcome =
	| { kind: "accepted" }
	| { kind: "changes_requested"; feedback: string }
	| { kind: "cancelled" }
	| { kind: "dismissed" }
	| { kind: "unavailable" };

export interface ReviewMenuOptions extends MenuLifecycle {
	summary: ReviewMenuSummary;
}

/**
 * Runs the review menu and reports what the human chose.
 *
 * Closing the menu without choosing is `dismissed`, not a decision: the
 * proposal stays pending and `/tasks review` reopens it. A mode that cannot
 * render a menu is `unavailable`, which the caller turns into `pending_review`
 * rather than inventing an approval.
 */
export async function showTaskReviewMenu(
	ctx: ExtensionContext,
	options: ReviewMenuOptions,
): Promise<ReviewOutcome> {
	let outcome: ReviewOutcome = { kind: "dismissed" };
	const menu = defineMenu<undefined, ReviewScreenId, ReviewAction, ExtensionContext>({
		start: "review",
		screens: {
			review: () => taskReviewScreen(options.summary),
			proposed: () => proposedDocumentScreen(options.summary),
			feedback: () => ({
				kind: "input",
				title: "What should change?",
				lines: ["Plain language. The agent gets this with the proposal it is revising."],
				placeholder: "keep the migration work, replace the deployment phase",
				action: "feedback",
				hint: "back",
			}),
		},
		actions: {
			accept: () => {
				outcome = { kind: "accepted" };
				return { kind: "close" };
			},
			feedback: ({ value }) => {
				const feedback = (value ?? "").trim();
				if (!feedback) return { kind: "rejected" };
				outcome = { kind: "changes_requested", feedback };
				return { kind: "close" };
			},
			cancel: () => {
				outcome = { kind: "cancelled" };
				return { kind: "close" };
			},
		},
	});
	const result = await runMenu(ctx, menu, {
		getState: () => undefined,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
	});
	if (result.kind === "unsupported" || result.kind === "error") return { kind: "unavailable" };
	if (result.kind === "stale") return { kind: "dismissed" };
	return outcome;
}

export type TasksAction = "show" | "review" | "new" | "archive" | "export" | "recover";
type TasksScreenId = "main" | "export";

export interface TasksMenuState {
	statusText: string;
	documentPath?: string;
	hasSet: boolean;
	hasPendingReview: boolean;
	needsRecovery: boolean;
	openTasks: number;
}

export function tasksMenuScreen(
	state: TasksMenuState,
): ActionsScreen<TasksScreenId, TasksAction> {
	const items: ActionsScreen<TasksScreenId, TasksAction>["items"] = [
		...(state.hasSet
			? [{ id: "show", label: "Show the task list", action: "show" as const }]
			: []),
		...(state.hasPendingReview
			? [
					{
						id: "review",
						label: "Review the proposed revision",
						// Greyed out during a conflict because accepting it would be
						// refused anyway; the refusal itself lives in the controller, so
						// this is a courtesy rather than the guard.
						description: state.needsRecovery
							? "Unavailable until the task document conflict is recovered."
							: "Accept it, ask for changes, or cancel it.",
						action: "review" as const,
						disabled: state.needsRecovery,
					},
				]
			: []),
		...(state.needsRecovery
			? [
					{
						id: "recover",
						label: "Recover the task set",
						description: "Choose between the document on disk and the recorded snapshot.",
						action: "recover" as const,
					},
				]
			: []),
		...(state.hasSet
			? [
					{ id: "export", label: "Export the task list…", to: "export" as const },
					{
						id: "archive",
						label: "Archive the task set",
						description:
							state.openTasks > 0
								? `Refused while ${state.openTasks} task(s) are still open.`
								: "File it away and detach it from this session.",
						action: "archive" as const,
						disabled: state.openTasks > 0,
					},
				]
			: []),
		{
			id: "new",
			label: "Start a new task set",
			description: "Detach the current one, which stays on disk, and begin a fresh list.",
			action: "new",
		},
		{ id: "close", label: "Close", close: true },
	];
	return {
		kind: "actions",
		title: "Tasks",
		lines: [state.statusText, ...(state.documentPath ? [`File: ${state.documentPath}`] : [])],
		items,
		hint: "close",
	};
}

export interface TasksMenuOptions extends MenuLifecycle {
	state: TasksMenuState;
	exportPlaceholder?: string;
	show(): void | Promise<void>;
	review(): void | Promise<void>;
	recover(): void | Promise<void>;
	archive(): void | Promise<void>;
	startNew(): void | Promise<void>;
	exportTasks(path: string): Promise<boolean>;
}

export async function showTasksMenu(
	ctx: ExtensionContext,
	options: TasksMenuOptions,
): Promise<void> {
	const menu = defineMenu<undefined, TasksScreenId, TasksAction, ExtensionContext>({
		start: "main",
		screens: {
			main: () => tasksMenuScreen(options.state),
			export: () => ({
				kind: "input",
				title: "Export the task list to…",
				lines: ["A Markdown file. The accepted task set is not changed."],
				...(options.exportPlaceholder ? { placeholder: options.exportPlaceholder } : {}),
				action: "export",
				hint: "back",
			}),
		},
		actions: {
			show: async () => {
				await options.show();
				return { kind: "close" };
			},
			review: async () => {
				await options.review();
				return { kind: "close" };
			},
			recover: async () => {
				await options.recover();
				return { kind: "close" };
			},
			archive: async () => {
				await options.archive();
				return { kind: "close" };
			},
			new: async () => {
				await options.startNew();
				return { kind: "close" };
			},
			export: async ({ value }) =>
				(await options.exportTasks((value ?? "").trim())) ? { kind: "close" } : { kind: "rejected" },
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
	});
}

export type RecoveryAction = "attach" | "fork" | "detach";
type RecoveryScreenId = "recover";

export interface RecoveryMenuState {
	reason: string;
	documentRevision?: number;
	recordedRevision?: number;
	snapshotRevision?: number;
}

export function recoveryScreen(
	state: RecoveryMenuState,
): ActionsScreen<RecoveryScreenId, RecoveryAction> {
	const lines = [state.reason];
	if (state.documentRevision !== undefined) {
		lines.push(`The document on disk is at revision ${state.documentRevision}.`);
	}
	if (state.recordedRevision !== undefined) {
		lines.push(`This session last accepted revision ${state.recordedRevision}.`);
	}
	if (state.snapshotRevision !== undefined) {
		lines.push(`The newest recorded snapshot is revision ${state.snapshotRevision}.`);
	}
	return {
		kind: "actions",
		title: "Recover the task set",
		lines,
		items: [
			...(state.documentRevision !== undefined
				? [
						{
							id: "attach",
							label: "Attach the document on disk",
							description: "Accept the current file as the task set and carry on from it.",
							action: "attach" as const,
						},
					]
				: []),
			...(state.snapshotRevision !== undefined
				? [
						{
							id: "fork",
							label: "Fork the recorded snapshot into a new set",
							description: "Copies the snapshot to a new task set; nothing on disk is overwritten.",
							action: "fork" as const,
						},
					]
				: []),
			{
				id: "detach",
				label: "Detach and leave everything alone",
				description: "This session stops tracking a task set. Nothing is deleted.",
				action: "detach",
			},
		],
		hint: "close",
	};
}

export interface RecoveryMenuOptions extends MenuLifecycle {
	state: RecoveryMenuState;
	attach(): void | Promise<void>;
	fork(): void | Promise<void>;
	detach(): void | Promise<void>;
}

export async function showRecoveryMenu(
	ctx: ExtensionContext,
	options: RecoveryMenuOptions,
): Promise<void> {
	const menu = defineMenu<undefined, RecoveryScreenId, RecoveryAction, ExtensionContext>({
		start: "recover",
		screens: { recover: () => recoveryScreen(options.state) },
		actions: {
			attach: async () => {
				await options.attach();
				return { kind: "close" };
			},
			fork: async () => {
				await options.fork();
				return { kind: "close" };
			},
			detach: async () => {
				await options.detach();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
	});
}
