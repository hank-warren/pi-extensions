import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ActionsScreen, defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface MenuLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
}

const IMPLEMENTATION_CONTEXT_LINES = [
	"Implement here keeps this planning conversation.",
	"Start fresh opens a new session that reads the same plan file.",
	"Or just type feedback to revise — the next completed plan supersedes this one.",
] as const;

interface PlanMenuOptions extends MenuLifecycle {
	statusText: string;
	hasReadyPlan: boolean;
	/** A revision transaction is open, so the approved plan is being changed. */
	hasOpenRevision: boolean;
	/** A proposed revision is waiting for a decision. */
	hasPendingRevision: boolean;
	planPathLine?: string;
	getExportDestination: PlanExportDestinationProvider;
	show(): void | Promise<void>;
	finalize(): void;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	reviewRevision(): void | Promise<void>;
	cancelRevision(): void | Promise<void>;
	stay(): void;
	exit(): void;
}

export async function showPlanModeMenu(ctx: ExtensionContext, options: PlanMenuOptions) {
	type Screen = "main" | "export";
	type Action =
		| "show"
		| "finalize"
		| "implement-here"
		| "implement-fresh"
		| "export"
		| "review-revision"
		| "cancel-revision"
		| "stay"
		| "exit";
	/**
	 * A revision replaces the drafting items rather than joining them. "Request
	 * final plan" during a revision would ask for a `plan_mode_complete` that is
	 * refused while the transaction is open, and "Exit Plan mode" would discard the
	 * approved plan the revision exists to change.
	 */
	const revisionItems: ActionsScreen<Screen, Action>["items"] = [
		{ id: "show", label: "Show the current plan", action: "show" },
		{
			id: "review-revision",
			label: "Review the proposed revision",
			description: options.hasPendingRevision
				? "Accept it, ask for changes, or cancel it."
				: "Nothing has been proposed yet.",
			action: "review-revision",
			disabled: !options.hasPendingRevision,
		},
		{
			id: "cancel-revision",
			label: "Cancel the revision",
			description: "Keep the approved plan exactly as it is.",
			action: "cancel-revision",
		},
		{ id: "stay", label: "Keep revising", action: "stay" },
	];
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: options.hasOpenRevision ? "Plan revision" : "Plan mode",
				lines: [
					options.statusText,
					...(options.hasReadyPlan && !options.hasOpenRevision
						? [...IMPLEMENTATION_CONTEXT_LINES]
						: []),
					...(options.planPathLine && (options.hasReadyPlan || options.hasOpenRevision)
						? [options.planPathLine]
						: []),
				],
				items: options.hasOpenRevision
					? revisionItems
					: options.hasReadyPlan
					? [
							{ id: "show", label: "Show latest proposed plan", action: "show" },
							{
								id: "implement-here",
								label: "Implement here",
								description: "Continue in this session with the planning conversation.",
								action: "implement-here",
							},
							{
								id: "implement-fresh",
								label: "Start fresh and implement",
								description: "Open a new linked session that reads the same plan file.",
								action: "implement-fresh",
								busyLabel: "Starting fresh implementation session…",
							},
							{ id: "export", label: "Export plan…", to: "export" },
							{ id: "stay", label: "Stay in Plan mode", action: "stay" },
							{ id: "exit", label: "Discard plan and exit", action: "exit" },
						]
					: [
							{ id: "finalize", label: "Request final plan", action: "finalize" },
							{ id: "stay", label: "Stay in Plan mode", action: "stay" },
							{ id: "exit", label: "Exit Plan mode", action: "exit" },
						],
				hint: "close",
			}),
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			show: async () => {
				await options.show();
				return { kind: "close" };
			},
			finalize: async () => {
				options.finalize();
				return { kind: "close" };
			},
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			"review-revision": async () => {
				await options.reviewRevision();
				return { kind: "close" };
			},
			"cancel-revision": async () => {
				await options.cancelRevision();
				return { kind: "close" };
			},
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}

interface ReadyPlanMenuOptions extends MenuLifecycle {
	planPathLine?: string;
	getExportDestination: PlanExportDestinationProvider;
	implementHere(): void | Promise<void>;
	implementFresh(signal: AbortSignal): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	stay(): void;
	exit(): void;
}

export async function showReadyPlanMenu(ctx: ExtensionContext, options: ReadyPlanMenuOptions) {
	type Screen = "ready" | "export";
	type Action = "implement-here" | "implement-fresh" | "export" | "stay" | "exit";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "ready",
		screens: {
			ready: () => ({
				kind: "actions",
				title: "Proposed plan ready. What next?",
				lines: [
					...IMPLEMENTATION_CONTEXT_LINES,
					...(options.planPathLine ? [options.planPathLine] : []),
				],
				items: [
					{
						id: "implement-here",
						label: "Implement here",
						description: "Continue in this session with the planning conversation.",
						action: "implement-here",
					},
					{
						id: "implement-fresh",
						label: "Start fresh and implement",
						description: "Open a new linked session that reads the same plan file.",
						action: "implement-fresh",
						busyLabel: "Starting fresh implementation session…",
					},
					{ id: "export", label: "Export plan…", to: "export" },
					{ id: "stay", label: "Stay in Plan mode", action: "stay" },
					{ id: "exit", label: "Discard plan and exit", action: "exit" },
				],
				hint: "close",
			}),
			export: () => planExportInputScreen(options.getExportDestination),
		},
		actions: {
			"implement-here": async () => {
				await options.implementHere();
				return { kind: "close" };
			},
			"implement-fresh": async ({ signal }) => {
				await options.implementFresh(signal);
				return { kind: "close" };
			},
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			stay: async () => {
				options.stay();
				return { kind: "close" };
			},
			exit: async () => {
				options.exit();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
