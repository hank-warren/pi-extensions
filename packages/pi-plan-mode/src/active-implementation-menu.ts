import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface ActiveImplementationMenuOptions {
	statusText: string;
	planPathLine?: string;
	/**
	 * Set when this session cannot verify that the plan on disk is the plan the
	 * user approved. It says on the completion items why they will refuse.
	 */
	approvalNotice?: string;
	/**
	 * Whether "Confirm the plan file" can do anything here.
	 *
	 * Separate from `approvalNotice` because one unverified state cannot be
	 * confirmed: a file that cannot be read has no bytes to record, so confirming it
	 * fails with "could not be read". Offering the item there is an invitation to an
	 * error, and the route that does work — restoring the file, or clearing the plan
	 * — is named in `statusText` instead.
	 */
	canConfirm?: boolean;
	getExportDestination: PlanExportDestinationProvider;
	signal: AbortSignal;
	isCurrent(): boolean;
	show(): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	settings(signal: AbortSignal): Promise<boolean>;
	confirmPlan(): void | Promise<unknown>;
	done(): void | Promise<unknown>;
	startNew(): void | Promise<unknown>;
	clear(): void;
}

export async function showActiveImplementationMenu(
	ctx: ExtensionContext,
	options: ActiveImplementationMenuOptions,
) {
	type Screen = "active" | "export";
	type Action = "show" | "export" | "settings" | "confirm" | "done" | "start-new" | "clear";
	const unverified = options.approvalNotice !== undefined;
	const offerConfirm = unverified && options.canConfirm === true;
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "active",
		screens: {
			active: () => ({
				kind: "actions",
				title: "Active implementation plan",
				lines: [options.statusText, ...(options.planPathLine ? [options.planPathLine] : [])],
				items: [
					{ id: "show", label: "Show active implementation plan", action: "show" },
					...(offerConfirm
						? [
								{
									id: "confirm",
									label: "Confirm the plan file",
									description:
										"Record the plan exactly as it is on disk as the approved plan, and record it in its history.",
									action: "confirm" as const,
								},
							]
						: []),
					{
						id: "done",
						label: "Mark as implemented",
						description: unverified
							? "Unavailable until the plan file is confirmed."
							: "Archive the plan file and clear the active plan.",
						action: "done",
						disabled: unverified,
					},
					{ id: "export", label: "Export plan…", to: "export" },
					{ id: "settings", label: "Settings", action: "settings" },
					{
						id: "start-new",
						label: "Start a new plan",
						description: unverified
							? "Unavailable until the plan file is confirmed; “Clear active implementation plan” discards it instead."
							: "Archive the active plan and enter Plan mode.",
						action: "start-new",
						disabled: unverified,
					},
					{
						id: "clear",
						label: "Clear active implementation plan",
						description: "Delete the plan file and clear the active plan.",
						action: "clear",
					},
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
			export: async ({ value, signal }) =>
				(await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
			settings: async ({ signal }) => {
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				return close ? { kind: "close" } : { kind: "stay" };
			},
			confirm: async () => {
				await options.confirmPlan();
				return { kind: "close" };
			},
			// Both await their work: an archive can fail, and a failure has to
			// reach the user as a notification rather than an unhandled rejection
			// behind a menu that already closed.
			done: async () => {
				await options.done();
				return { kind: "close" };
			},
			"start-new": async () => {
				await options.startNew();
				return { kind: "close" };
			},
			clear: async () => {
				options.clear();
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
