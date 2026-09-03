/**
 * The two pre-loop menus: the launch menu (nothing running, nothing drafted)
 * and the planning menu (a drafting conversation is open, no proposal yet).
 *
 * They are the front door, and they are deliberately shaped like
 * pi-plan-mode's launch menu — same title/status/items/detail-screen skeleton,
 * same "How it works" affordance. The two extensions are one family: a user
 * who has run `/plan` should recognise `/loop` without reading anything.
 *
 * Screen builders are pure and exported so a test can pin exactly what each
 * menu offers without a terminal. That set is the contract; the wiring is not.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActionsScreen, DetailScreen } from "@narumitw/pi-tui-kit";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

type LoopLaunchScreen = "main" | "how";
type LoopLaunchAction = "start-planning" | "settings";
type LoopPlanningAction = "request-proposal" | "cancel" | "settings";

/**
 * What a loop actually is, for someone who has never run one.
 *
 * It answers the questions the old one-line notification could not: what
 * paces it, what ends it, where its state lives, and what bounds it now that
 * a turn budget no longer does.
 */
export const HOW_LOOPS_WORK_LINES = [
	"A loop works one objective across many turns, continuing itself until the objective is met.",
	"It is paced by the session settling, not by a clock: every time the agent goes idle with the objective unfinished, the loop continues it. The interval is only a fallback heartbeat for a session that has gone quiet.",
	"The objective is drafted with you first and becomes the loop's completion criteria. The approval card shows the exact criteria before anything starts.",
	"Ground rules are hard constraints approved alongside the objective — what the loop must never do while nobody is watching.",
	"loop_complete ends the loop, and it is gated: every criterion needs cited evidence. Effort exhaustion is not completion.",
	"A durable ledger (PROGRESS.md and criteria.json) holds the loop's state, so it survives compaction and hands off between sessions.",
	"Nothing caps the turns by default. A loop is bounded by its expiry and by the no-progress breaker, which pauses it when it repeats itself; set a turn budget in Settings to add one.",
	"You stay in control: /loop opens this menu at any time to pause, resume, or stop it, and Esc interrupts the turn in flight.",
] as const;

function howItWorksScreen(): DetailScreen {
	return {
		kind: "detail",
		title: "How loops work",
		lines: [...HOW_LOOPS_WORK_LINES],
		hint: "back",
	};
}

/** The off-state launch menu. */
export function loopLaunchScreen(): ActionsScreen<LoopLaunchScreen, LoopLaunchAction> {
	return {
		kind: "actions",
		title: "Loop",
		lines: ["Status: Off."],
		items: [
			{
				id: "start-planning",
				label: "Start loop planning",
				description: "Draft an objective with the agent. Nothing starts until you approve it.",
				action: "start-planning",
			},
			{ id: "settings", label: "Settings", action: "settings" },
			{ id: "how", label: "How loops work", to: "how" },
		],
		hint: "close",
	};
}

/** Planning is open and no draft has been proposed yet. */
export function loopPlanningScreen(): ActionsScreen<LoopLaunchScreen, LoopPlanningAction> {
	return {
		kind: "actions",
		title: "Loop planning",
		lines: [
			"Status: drafting an objective. No loop is running.",
			"Describe what the loop should achieve and how you will know it is done.",
		],
		items: [
			{
				id: "request-proposal",
				label: "Request proposal now",
				description: "Ask the agent to put the current draft up for approval.",
				action: "request-proposal",
			},
			{
				id: "cancel",
				label: "Cancel planning",
				description: "Close planning. Nothing is started.",
				action: "cancel",
			},
			{ id: "settings", label: "Settings", action: "settings" },
			{ id: "how", label: "How loops work", to: "how" },
		],
		hint: "close",
	};
}

interface LoopLaunchMenuOptions {
	signal?: AbortSignal;
	isCurrent?(): boolean;
	startPlanning(): void;
	settings(signal: AbortSignal): Promise<void>;
}

export async function showLoopLaunchMenu(ctx: ExtensionContext, options: LoopLaunchMenuOptions) {
	const menu = defineMenu<undefined, LoopLaunchScreen, LoopLaunchAction, ExtensionContext>({
		start: "main",
		screens: { main: () => loopLaunchScreen(), how: () => howItWorksScreen() },
		actions: {
			"start-planning": async () => {
				options.startPlanning();
				return { kind: "close" };
			},
			settings: async ({ signal }) => {
				await options.settings(signal);
				return { kind: "stay" };
			},
		},
	});
	return runMenu(ctx, menu, { getState: () => undefined, ...lifecycle(options) });
}

interface LoopPlanningMenuOptions {
	signal?: AbortSignal;
	isCurrent?(): boolean;
	requestProposal(): void;
	cancelPlanning(): void;
	settings(signal: AbortSignal): Promise<void>;
}

export async function showLoopPlanningMenu(ctx: ExtensionContext, options: LoopPlanningMenuOptions) {
	const menu = defineMenu<undefined, LoopLaunchScreen, LoopPlanningAction, ExtensionContext>({
		start: "main",
		screens: { main: () => loopPlanningScreen(), how: () => howItWorksScreen() },
		actions: {
			"request-proposal": async () => {
				options.requestProposal();
				return { kind: "close" };
			},
			cancel: async () => {
				options.cancelPlanning();
				return { kind: "close" };
			},
			settings: async ({ signal }) => {
				await options.settings(signal);
				return { kind: "stay" };
			},
		},
	});
	return runMenu(ctx, menu, { getState: () => undefined, ...lifecycle(options) });
}

function lifecycle(options: { signal?: AbortSignal; isCurrent?(): boolean }) {
	return {
		...(options.signal ? { signal: options.signal } : {}),
		...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
	};
}
