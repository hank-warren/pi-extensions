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
	contextBudget: number;
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

/** Short model label: drop the provider. */
export function shortModel(model: string): string {
	const slash = model.indexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}
