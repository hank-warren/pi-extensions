/**
 * The manager: every lifecycle control a running loop has.
 *
 * Pause, resume, stop, status, focus and cadence used to be typed
 * subcommands (`/loop pause`, `/loop status`, …). They are here instead,
 * because a lifecycle control nobody can discover is a control nobody uses,
 * and because the loop is the kind of thing you reach for when you want to
 * *look* at it — at which point a menu that shows the state and offers the
 * actions beats remembering six words.
 *
 * Pause and Resume are mutually exclusive by construction: the screen is
 * built from the loop's status, so a paused loop never offers Pause and an
 * active one never offers Resume. Pinned in the tests, because an item that
 * silently does nothing is the failure mode a menu invites.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActionsScreen, DetailScreen, InputScreen } from "@narumitw/pi-tui-kit";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

type LoopManagerScreen = "main" | "status" | "focus" | "cadence";
type LoopManagerAction =
	| "pause"
	| "resume"
	| "stop"
	| "settings"
	| "set-focus"
	| "set-cadence";

/** What the manager renders: the loop as the menu needs to see it. */
export interface LoopManagerView {
	/** `stopped` never reaches here; the menu only exists for a live loop. */
	status: "active" | "paused";
	/** The widget line, so the manager and the footer tell the same story. */
	headline: string;
	/** Full status detail, one line each. */
	statusLines: readonly string[];
	/** The loop's recurring focus, when it has one. */
	focus?: string;
	/** The current fallback heartbeat, formatted. */
	interval: string;
}

export function loopManagerScreen(
	view: LoopManagerView,
): ActionsScreen<LoopManagerScreen, LoopManagerAction> {
	return {
		kind: "actions",
		title: `Loop · ${view.status}`,
		lines: [view.headline],
		items: [
			{ id: "status", label: "Status", description: "The loop's full state.", to: "status" },
			...(view.status === "active"
				? ([
						{
							id: "pause",
							label: "Pause",
							description: "Stop continuing and waking. The loop keeps its state.",
							action: "pause" as const,
						},
					] as const)
				: ([
						{
							id: "resume",
							label: "Resume",
							description: "Continue the objective now, and re-arm the heartbeat.",
							action: "resume" as const,
						},
					] as const)),
			{
				id: "focus",
				label: "Edit focus…",
				description: "A recurring note restated on every loop message.",
				to: "focus",
			},
			{
				id: "cadence",
				label: "Edit cadence…",
				description: `Fallback heartbeat, currently every ${view.interval}.`,
				to: "cadence",
			},
			{
				id: "stop",
				label: "Stop",
				description: "End the loop. The ledger stays on disk.",
				action: "stop",
			},
			{ id: "settings", label: "Settings", action: "settings" },
		],
		hint: "close",
	};
}

export function loopStatusScreen(view: LoopManagerView): DetailScreen {
	return {
		kind: "detail",
		title: "Loop status",
		lines: [...view.statusLines],
		hint: "back",
	};
}

export function loopFocusScreen(view: LoopManagerView): InputScreen<LoopManagerAction> {
	return {
		kind: "input",
		title: "Loop focus",
		lines: [
			view.focus ? `Currently: ${view.focus}` : "No focus set.",
			"Restated on every loop message. Leave empty to clear it.",
		],
		placeholder: view.focus ?? "e.g. keep the diff small and reversible",
		action: "set-focus",
		hint: "back",
	};
}

export function loopCadenceScreen(view: LoopManagerView): InputScreen<LoopManagerAction> {
	return {
		kind: "input",
		title: "Fallback heartbeat",
		lines: [
			`Currently every ${view.interval}.`,
			"The loop advances whenever the session settles; this only fires when it has gone quiet.",
		],
		placeholder: view.interval,
		action: "set-cadence",
		hint: "back",
	};
}

interface LoopManagerMenuOptions {
	getView(): LoopManagerView | undefined;
	signal?: AbortSignal;
	isCurrent?(): boolean;
	pause(): void;
	resume(): void;
	stop(): void;
	settings(signal: AbortSignal): Promise<void>;
	/** Returns false when the value was rejected, so the input screen stays open. */
	setFocus(value: string): boolean;
	setCadence(value: string): boolean;
}

export async function showLoopManagerMenu(ctx: ExtensionContext, options: LoopManagerMenuOptions) {
	const first = options.getView();
	if (!first) return;
	// The view is re-read on every render: a pause taken from this menu has to
	// turn the Pause item into Resume without closing and reopening it.
	const view = () => options.getView() ?? first;
	const menu = defineMenu<
		LoopManagerView,
		LoopManagerScreen,
		LoopManagerAction,
		ExtensionContext
	>({
		start: "main",
		screens: {
			main: ({ state }) => loopManagerScreen(state),
			status: ({ state }) => loopStatusScreen(state),
			focus: ({ state }) => loopFocusScreen(state),
			cadence: ({ state }) => loopCadenceScreen(state),
		},
		actions: {
			pause: async () => {
				options.pause();
				return { kind: "stay" };
			},
			resume: async () => {
				options.resume();
				return { kind: "stay" };
			},
			stop: async () => {
				options.stop();
				return { kind: "close" };
			},
			settings: async ({ signal }) => {
				await options.settings(signal);
				return { kind: "stay" };
			},
			"set-focus": async ({ value }) =>
				options.setFocus(value ?? "") ? { kind: "to", screen: "main" } : { kind: "rejected" },
			"set-cadence": async ({ value }) =>
				options.setCadence(value ?? "") ? { kind: "to", screen: "main" } : { kind: "rejected" },
		},
	});
	return runMenu(ctx, menu, {
		getState: view,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
	});
}
