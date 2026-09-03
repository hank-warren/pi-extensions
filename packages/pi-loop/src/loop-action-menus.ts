/**
 * The approval card's actions, as a menu.
 *
 * Presentation and choices are separate surfaces on purpose, the way
 * pi-plan-mode splits `presentation.ts` from `plan-action-menus.ts`: the card
 * is a durable artifact in the transcript that the user can scroll back to,
 * and the menu is a transient dialog over it. A plain `ui.select` of label
 * strings could not say what "start in a fresh session" means, and that is
 * exactly the entry that needs explaining.
 *
 * The screen is built by a pure function so a test can assert what the menu
 * offers without a terminal.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import type { ActionsScreen } from "@narumitw/pi-tui-kit";
import { formatDuration } from "./interval.js";
import type { LoopProposal } from "./planning.js";

type LoopApprovalAction =
	| "start-here"
	| "start-fresh"
	| "change-cadence"
	| "keep-editing"
	| "cancel";

type Screen = "approval";

interface LoopApprovalMenuOptions {
	proposal: LoopProposal;
	signal?: AbortSignal;
	isCurrent?(): boolean;
	startHere(): void | Promise<void>;
	startFresh(signal: AbortSignal): void | Promise<void>;
	changeCadence(): void | Promise<void>;
	keepEditing(): void;
	cancel(): void;
}

/**
 * The approval screen. Pure and exported for tests: the set of actions on
 * offer is the contract, and it is cheaper to pin here than through a TUI.
 */
export function loopApprovalScreen(
	proposal: LoopProposal,
): ActionsScreen<Screen, LoopApprovalAction> {
	const criteria = `${proposal.criteria.length} ${proposal.criteria.length === 1 ? "criterion" : "criteria"}`;
	const rules = proposal.groundRules?.length;
	return {
		kind: "actions",
		title: "Start this loop?",
		lines: [
			`${criteria}${rules ? ` · ${rules} ground rule${rules === 1 ? "" : "s"}` : ""} · fallback wake every ${formatDuration(proposal.intervalMs)} · turn cap ${proposal.maxTurns === null ? "unlimited" : proposal.maxTurns} · expires in ${formatDuration(proposal.expiresInMs)}`,
			"The card above shows exactly what loop_complete will be held to.",
		],
		items: [
			{
				id: "start-here",
				label: "Start loop here",
				description: "Run it in this session, keeping the planning conversation.",
				action: "start-here",
			},
			{
				id: "start-fresh",
				label: "Start loop in a fresh session",
				description:
					"Open a new session that runs the loop with only the objective — no planning history.",
				action: "start-fresh",
				busyLabel: "Starting the loop in a fresh session…",
			},
			{
				id: "change-cadence",
				label: "Change cadence…",
				description: "Edit the fallback heartbeat before starting.",
				action: "change-cadence",
			},
			{
				id: "keep-editing",
				label: "Keep editing",
				description: "Go back to drafting; tell the agent what to change.",
				action: "keep-editing",
			},
			{
				id: "cancel",
				label: "Cancel",
				description: "Discard the draft. Nothing is started.",
				action: "cancel",
			},
		],
		hint: "close",
	};
}

export async function showLoopApprovalMenu(
	ctx: ExtensionContext,
	options: LoopApprovalMenuOptions,
) {
	const menu = defineMenu<undefined, Screen, LoopApprovalAction, ExtensionContext>({
		start: "approval",
		screens: { approval: () => loopApprovalScreen(options.proposal) },
		actions: {
			"start-here": async () => {
				await options.startHere();
				return { kind: "close" };
			},
			"start-fresh": async ({ signal }) => {
				await options.startFresh(signal);
				return { kind: "close" };
			},
			"change-cadence": async () => {
				await options.changeCadence();
				return { kind: "close" };
			},
			"keep-editing": async () => {
				options.keepEditing();
				return { kind: "close" };
			},
			cancel: async () => {
				options.cancel();
				return { kind: "close" };
			},
		},
	});
	return runMenu(ctx, menu, {
		getState: () => undefined,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
	});
}
