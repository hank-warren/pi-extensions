import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens } from "./format.js";
import type { AgentRun, RunStatus } from "./manager.js";
import type { WorktreeInfo } from "./worktree.js";

/** Plain data describing a run, carried in tool-result and message details. */
export interface AgentDetails {
	id: string;
	name: string;
	type: string;
	description: string;
	status: RunStatus;
	background: boolean;
	model: string;
	toolUses: number;
	recentTools: string[];
	contextTokens: number;
	contextBudget?: number;
	contextWindow?: number;
	outputTokens: number;
	cost: number;
	durationMs: number;
	budgetExhausted: boolean;
	result?: string;
	error?: string;
	sessionFile?: string;
	worktree?: WorktreeInfo;
}

export function detailsOf(run: AgentRun, background = run.spec.background): AgentDetails {
	return {
		id: run.id,
		name: run.name,
		type: run.type,
		description: run.description,
		status: run.status,
		background,
		model: run.spec.model,
		toolUses: run.toolUses,
		recentTools: [...run.recentTools],
		contextTokens: run.contextTokens,
		contextBudget: run.spec.contextBudget,
		contextWindow: run.spec.contextWindow,
		outputTokens: run.outputTokens,
		cost: run.cost,
		durationMs: (run.endedAt ?? Date.now()) - run.runStartedAt,
		budgetExhausted: run.budgetExhausted,
		result: run.result,
		error: run.error,
		sessionFile: run.sessionFile,
		worktree: run.spec.worktree,
	};
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(now = Date.now()): string {
	return SPINNER[Math.floor(now / 100) % SPINNER.length]!;
}

export function statusIcon(status: RunStatus, theme: Theme, now = Date.now()): string {
	switch (status) {
		case "queued":
			return theme.fg("dim", "◌");
		case "running":
			return theme.fg("accent", spinnerFrame(now));
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("warning", "■");
	}
}

/** `12 tool uses · 41k tokens · 1m03s`, the Claude Code summary tail. */
export function statsLine(details: Pick<AgentDetails, "toolUses" | "contextTokens" | "durationMs" | "budgetExhausted">): string {
	const uses = `${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`;
	const parts = [uses, `${formatTokens(details.contextTokens)} tokens`, formatDuration(details.durationMs)];
	if (details.budgetExhausted) parts.push("budget exhausted");
	return parts.join(" · ");
}

export function statusWord(status: RunStatus): string {
	return { queued: "Queued", running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" }[status];
}

/**
 * `78k/150k budget` when the agent has a context budget, else `78k/272k` against
 * the model's window, else just `78k`.
 */
export function contextLabel(used: number, budget: number | undefined, window: number | undefined): string {
	if (budget) return `${formatTokens(used)}/${formatTokens(budget)} budget`;
	if (window) return `${formatTokens(used)}/${formatTokens(window)}`;
	return formatTokens(used);
}

/** Share of the effective limit (budget, else window) in use, or undefined when neither is known. */
export function contextShare(used: number, budget: number | undefined, window: number | undefined): number | undefined {
	const limit = budget ?? window;
	return limit ? used / limit : undefined;
}

/** Short model label: drop the provider. */
export function shortModel(model: string): string {
	const slash = model.indexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}
