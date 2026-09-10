import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";

interface ActiveImplementationMenuOptions {
	statusText: string;
	planPathLine?: string;
	getExportDestination: PlanExportDestinationProvider;
	signal: AbortSignal;
	isCurrent(): boolean;
	show(): void | Promise<void>;
	exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
	settings(signal: AbortSignal): Promise<boolean>;
	done(): void;
	startNew(): void;
	clear(): void;
}

export async function showActiveImplementationMenu(
	ctx: ExtensionContext,
	options: ActiveImplementationMenuOptions,
) {
	type Screen = "active" | "export";
	type Action = "show" | "export" | "settings" | "done" | "start-new" | "clear";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "active",
		screens: {
			active: () => ({
				kind: "actions",
				title: "Active implementation plan",
				lines: [options.statusText, ...(options.planPathLine ? [options.planPathLine] : [])],
				items: [
					{ id: "show", label: "Show active implementation plan", action: "show" },
					{
						id: "done",
						label: "Mark as implemented",
						description: "Archive the plan file and clear the active plan.",
						action: "done",
					},
					{ id: "export", label: "Export plan…", to: "export" },
					{ id: "settings", label: "Settings", action: "settings" },
					{
						id: "start-new",
						label: "Start a new plan",
						description: "Archive the active plan and enter Plan mode.",
						action: "start-new",
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
			done: async () => {
				options.done();
				return { kind: "close" };
			},
			"start-new": async () => {
				options.startNew();
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
