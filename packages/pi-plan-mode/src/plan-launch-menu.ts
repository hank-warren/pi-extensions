import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

interface PlanLaunchMenuOptions {
	statusText: string;
	signal: AbortSignal;
	isCurrent(): boolean;
	start(signal: AbortSignal): void;
	settings(signal: AbortSignal): Promise<boolean>;
}

const HOW_IT_WORKS_LINES = [
	"Plan mode is for research and design, not implementation.",
	"Explore the codebase, ask decision questions, then finish with plan_mode_complete.",
	"The plan is written to a durable file that survives compaction and can be hand-edited.",
	"Built-in edit and write are blocked while planning.",
	"All other tools stay exactly as configured; command safety is left to your permission extension.",
	"When the plan is ready: implement here, or start a fresh session that reads the same file.",
] as const;

export async function showPlanLaunchMenu(ctx: ExtensionContext, options: PlanLaunchMenuOptions) {
	type Screen = "main" | "how";
	type Action = "start" | "settings";
	const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "Plan mode",
				lines: [options.statusText],
				items: [
					{ id: "start", label: "Start Plan mode", action: "start" },
					{ id: "settings", label: "Settings", action: "settings" },
					{ id: "how", label: "How Plan mode works", to: "how" },
				],
				hint: "close",
			}),
			how: () => ({
				kind: "detail",
				title: "How Plan mode works",
				lines: [...HOW_IT_WORKS_LINES],
				hint: "back",
			}),
		},
		actions: {
			start: async ({ signal }) => {
				options.start(signal);
				return { kind: "close" };
			},
			settings: async ({ signal }) => {
				const close = await options.settings(signal);
				if (signal.aborted || !options.isCurrent()) return { kind: "rejected" };
				return close ? { kind: "close" } : { kind: "stay" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
