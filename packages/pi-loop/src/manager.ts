/**
 * The `/loop` surfaces, wired to the controller: the manager for a live loop,
 * the approval card's actions, and the settings editor.
 *
 * The top-level menus are tui-kit screens (see `loop-manager-menu.ts` and
 * `loop-launch-menu.ts`), so the family renders the same way pi-plan-mode
 * does. The settings editor keeps its `ui.select`/`ui.input` internals: it is
 * a value editor, not a navigation surface, and rewriting it would change
 * nothing a user can see. Non-TUI modes get status notifications instead of
 * menus, exactly as before.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, parseInterval } from "./interval.js";
import type { LoopController } from "./loop.js";
import {
	DEFAULT_LOOP_SETTINGS,
	type LoopSettings,
	normalizeLoopSettings,
	saveLoopSettings,
} from "./settings.js";
import { parseDuration } from "./interval.js";
import type { LoopStartArguments } from "./command.js";
import { startLoopInFreshSession } from "./fresh-launch.js";
import { showLoopApprovalMenu } from "./loop-action-menus.js";
import { type LoopManagerView, showLoopManagerMenu } from "./loop-manager-menu.js";
import { showLoopLaunchMenu, showLoopPlanningMenu } from "./loop-launch-menu.js";
import type { LoopProposal } from "./planning.js";
import { loopWidgetLine } from "./widget.js";

/** The launch menu: no loop, no draft, nothing planning. */
export async function showLoopLaunch(
	controller: LoopController,
	ctx: ExtensionCommandContext,
	startPlanning: () => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"No loop in this session. The interactive /loop menu is unavailable in print and JSON modes.",
			"info",
		);
		return;
	}
	await showLoopLaunchMenu(ctx, {
		startPlanning,
		settings: async () => {
			await showLoopSettings(controller, ctx);
		},
	});
}

/** The planning menu: a drafting conversation is open with no draft yet. */
export async function showLoopPlanning(
	controller: LoopController,
	ctx: ExtensionCommandContext,
	options: { requestProposal: () => void },
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"Loop planning is open: describe the objective, and the agent will put a loop up for approval.",
			"info",
		);
		return;
	}
	await showLoopPlanningMenu(ctx, {
		requestProposal: options.requestProposal,
		cancelPlanning: () => {
			controller.endPlanning();
			ctx.ui.notify("Loop planning cancelled. Nothing was started.", "info");
		},
		settings: async () => {
			await showLoopSettings(controller, ctx);
		},
	});
}

export async function showLoopManager(
	controller: LoopController,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		notifyStatus(controller, ctx);
		return;
	}
	await showLoopManagerMenu(ctx, {
		getView: () => managerView(controller, ctx),
		pause: () => controller.pauseLoop(ctx),
		resume: () => controller.resumeLoop(ctx),
		stop: () => controller.stopLoop(ctx),
		settings: async () => {
			await showLoopSettings(controller, ctx);
		},
		setFocus: (value) => setFocus(controller, ctx, value),
		setCadence: (value) => setCadence(controller, ctx, value),
	});
}

/** The live loop as the manager needs it, or undefined once it has stopped. */
function managerView(
	controller: LoopController,
	ctx: ExtensionContext,
): LoopManagerView | undefined {
	const loop = controller.state;
	if (!loop || loop.status === "stopped") return undefined;
	const view = controller.widgetView();
	return {
		status: loop.status,
		headline: view ? loopWidgetLine(view) : `loop ${loop.status}`,
		statusLines: controller.statusLines(ctx),
		...(loop.prompt ? { focus: loop.prompt } : {}),
		interval: formatDuration(loop.intervalMs),
	};
}

function notifyStatus(controller: LoopController, ctx: ExtensionCommandContext): void {
	ctx.ui.notify(controller.statusLines(ctx).join("\n"), "info");
}

/** An empty value clears the focus; anything else replaces it. */
function setFocus(
	controller: LoopController,
	ctx: ExtensionCommandContext,
	value: string,
): boolean {
	const loop = controller.state;
	if (!loop || loop.status === "stopped") return false;
	const prompt = value.trim();
	if (prompt) controller.state = { ...loop, prompt };
	else {
		const { prompt: _dropped, ...rest } = loop;
		controller.state = rest;
	}
	controller.persist();
	controller.updateWidget();
	ctx.ui.notify(prompt ? "Loop focus updated." : "Loop focus cleared.", "info");
	return true;
}

function setCadence(
	controller: LoopController,
	ctx: ExtensionCommandContext,
	value: string,
): boolean {
	const loop = controller.state;
	if (!loop || loop.status === "stopped") return false;
	const interval = parseInterval(value.trim());
	if (!interval) {
		ctx.ui.notify(`Invalid interval: ${value}. Use <number><unit>, e.g. 5m.`, "error");
		return false;
	}
	controller.state = { ...loop, intervalMs: interval.effectiveMs };
	controller.persist();
	// Re-arm on the new cadence from now.
	if (loop.status === "active") controller.resumeAfterEdit();
	else controller.updateWidget();
	ctx.ui.notify(
		`Loop interval set to ${formatDuration(interval.effectiveMs)}${interval.clamped ? " (clamped to the minimum)" : ""}.`,
		"info",
	);
	return true;
}

async function showLoopSettings(
	controller: LoopController,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Edit pi-loop settings manually: ${controller.settingsPath}`, "info");
		return;
	}
	for (;;) {
		const s = controller.settings;
		const items = [
			`Max loop turns: ${s.maxTurns === null ? "Unlimited" : s.maxTurns}`,
			`No-progress breaker: ${s.noProgressTurns === null ? "Off" : `after ${s.noProgressTurns} repeats`}`,
			`Max loop duration: ${s.maxLoopDuration}`,
			`Proactive compaction: ${s.compaction.enabled ? `On at ${Math.round(s.compaction.threshold * 100)}%` : "Off"}`,
		];
		const choice = await ctx.ui.select("Pi Loop Settings", items);
		if (choice === undefined) return;
		const index = items.indexOf(choice);
		const next = structuredClone(s);
		if (index === 0) {
			// Unlimited is a first-class choice, not a magic word typed into a free
			// text box: it is only reachable by discovery otherwise. It is also the
			// default, so this editor is where a user opts *into* a budget.
			const cap = await editCap(ctx, "Max loop turns", "no turn cap", s.maxTurns);
			if (cap === undefined) continue;
			next.maxTurns = cap === "unlimited" ? null : cap;
		} else if (index === 1) {
			const cap = await editCap(
				ctx,
				"No-progress breaker",
				"never pause for repeated answers",
				s.noProgressTurns,
			);
			if (cap === undefined) continue;
			next.noProgressTurns = cap === "unlimited" ? null : cap;
		} else if (index === 2) {
			const value = await ctx.ui.input("Max loop duration (e.g. 7d)", s.maxLoopDuration);
			if (value === undefined) continue;
			if (parseDuration(value.trim()) === undefined) {
				ctx.ui.notify(`Invalid duration: ${value}. Use <number><unit>, e.g. 7d.`, "error");
				continue;
			}
			next.maxLoopDuration = value.trim();
		} else if (index === 3) {
			if (s.compaction.enabled) next.compaction.enabled = false;
			else {
				const value = await ctx.ui.input(
					"Compaction threshold (percent of context window)",
					`${Math.round((s.compaction.threshold || DEFAULT_LOOP_SETTINGS.compaction.threshold) * 100)}%`,
				);
				if (value === undefined) continue;
				const raw = value.trim().replace(/%$/, "");
				const fraction = Number(raw) / 100;
				if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
					ctx.ui.notify(`Invalid threshold: ${value}. Use a percentage between 1 and 99.`, "error");
					continue;
				}
				next.compaction.enabled = true;
				next.compaction.threshold = fraction;
			}
		} else {
			continue;
		}
		if (!applySettings(controller, ctx, next)) continue;
	}
}

/**
 * One cap editor for every cap. Unlimited is a first-class choice, not a
 * magic word typed into a free text box: it is only reachable by discovery
 * otherwise. The typed word still works too.
 */
async function editCap(
	ctx: ExtensionCommandContext,
	label: string,
	unlimitedNote: string,
	current: number | null,
): Promise<number | "unlimited" | undefined> {
	const SET_NUMBER = "Set a number…";
	const UNLIMITED = `Unlimited (${unlimitedNote})`;
	const choice = await ctx.ui.select(
		`${label} · currently ${current === null ? "Unlimited" : current}`,
		[SET_NUMBER, UNLIMITED],
	);
	if (choice === undefined) return undefined;
	if (choice === UNLIMITED) return "unlimited";
	const value = await ctx.ui.input(
		`${label} (positive whole number)`,
		current === null ? "25" : `${current}`,
	);
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed === "unlimited") return "unlimited";
	const parsed = Number(trimmed);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		ctx.ui.notify(`Invalid value: ${value}.`, "error");
		return undefined;
	}
	return parsed;
}

function applySettings(
	controller: LoopController,
	ctx: ExtensionCommandContext,
	next: LoopSettings,
): boolean {
	if (!normalizeLoopSettings(next)) {
		ctx.ui.notify("Refusing to save invalid pi-loop settings.", "error");
		return false;
	}
	try {
		saveLoopSettings(next, controller.settingsPath);
	} catch (error) {
		ctx.ui.notify(
			`Could not save settings (${error instanceof Error ? error.message : String(error)}); the previous values remain active.`,
			"error",
		);
		return false;
	}
	controller.settings = next;
	return true;
}

/**
 * The approval card and its actions.
 *
 * This is where a planned loop starts, and the approval is what authorises it.
 * A loop is self-continuing and must never begin on model initiative; an
 * explicit choice here, on a card showing the objective, the derived criteria,
 * the ground rules, the cadence and the caps, is the strongest evidence of
 * intent there is — stronger than any token the model could also emit — so it
 * starts the loop directly rather than routing back through a tool.
 */
export async function showLoopApproval(
	controller: LoopController,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const proposal = controller.planning.proposal;
	if (!proposal) return;
	// The card is an artifact, emitted once per draft; the menu below is the
	// dialog over it. A draft proposed by loop_propose already has its card, so
	// this only renders one when the user reached the approval some other way.
	controller.showProposalCard(ctx);
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Approve it from a TUI session; a loop cannot be started headless.", "info");
		return;
	}
	await showLoopApprovalMenu(ctx, {
		proposal,
		startHere: () => {
			const result = controller.startLoop(ctx, startArgumentsFor(proposal));
			if (result.ok) controller.endPlanning();
			else ctx.ui.notify(result.message, "error");
		},
		startFresh: async () => {
			await startApprovedLoopFresh(controller, ctx, proposal);
		},
		changeCadence: async () => {
			await changeCadence(controller, ctx, proposal);
		},
		keepEditing: () => {
			ctx.ui.notify("Still planning. Tell the agent what to change.", "info");
		},
		cancel: () => {
			controller.endPlanning();
			ctx.ui.notify("Loop planning cancelled. Nothing was started.", "info");
		},
	});
}

/** The approved draft, as the arguments both start paths take. */
function startArgumentsFor(proposal: LoopProposal): LoopStartArguments {
	return {
		kind: "start",
		requestedMs: proposal.intervalMs,
		intervalMs: proposal.intervalMs,
		clamped: false,
		maxTurns: proposal.maxTurns,
		expiresInMs: proposal.expiresInMs,
		prompt: proposal.objective,
		// The approved constraints cross with the objective; they are part of what
		// the user said yes to.
		...(proposal.groundRules ? { groundRules: proposal.groundRules } : {}),
	};
}

/**
 * Build the loop here, install it over there. The build/install split is what
 * makes this possible at all: the state has to exist before `newSession` so
 * its `setup` can append it, and it must not be installed in this session or
 * the planning session would start working the objective it is handing away.
 */
async function startApprovedLoopFresh(
	controller: LoopController,
	ctx: ExtensionCommandContext,
	proposal: LoopProposal,
): Promise<void> {
	const built = controller.buildLoop(startArgumentsFor(proposal));
	if (!built.ok) {
		ctx.ui.notify(built.message, "error");
		return;
	}
	const result = await startLoopInFreshSession(ctx, {
		built: built.built,
		prepareLedger: () => controller.prepareLedgerFor(built.built),
	});
	switch (result.kind) {
		case "started":
		case "partial":
			// The draft has been handed off either way: the planning session must
			// not keep offering to start it a second time.
			controller.endPlanning();
			return;
		case "cancelled":
			return;
		default:
			ctx.ui.notify(result.detail, "error");
	}
}

async function changeCadence(
	controller: LoopController,
	ctx: ExtensionCommandContext,
	proposal: LoopProposal,
): Promise<void> {
	const text = await ctx.ui.input(
		"Fallback heartbeat (e.g. 30m). The loop advances whenever the session settles.",
		formatDuration(proposal.intervalMs),
	);
	if (text === undefined) return;
	const interval = parseInterval(text.trim());
	if (!interval) {
		ctx.ui.notify(`Invalid interval: ${text}. Use <number><unit>, e.g. 30m.`, "error");
		return;
	}
	// A new draft, so it gets a new card: the cadence on the old one is no
	// longer what would start.
	controller.propose(proposal.objective, {
		intervalMs: interval.effectiveMs,
		maxTurns: proposal.maxTurns,
		expiresInMs: proposal.expiresInMs,
		...(proposal.groundRules ? { groundRules: proposal.groundRules } : {}),
	});
	await showLoopApproval(controller, ctx);
}
