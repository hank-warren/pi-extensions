import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, type ToolCallSummary } from "./format.js";
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
	/** Latest tool calls in Pi notation, oldest first. */
	toolLog: ToolCallSummary[];
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
		toolLog: [...run.toolLog],
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

/** Pi's own spinner frames, as its working indicator uses them. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(now = Date.now()): string {
	return SPINNER[Math.floor(now / 80) % SPINNER.length]!;
}

/**
 * One glyph per state, in the vocabulary Pi's status lines already use here:
 * a spinner while working, `⋯` waiting its turn, `?` waiting for you.
 */
export function statusGlyph(status: RunStatus, theme: Theme, options: { now?: number; approval?: boolean } = {}): string {
	if (options.approval) return theme.fg("accent", "?");
	switch (status) {
		case "queued":
			return theme.fg("muted", "⋯");
		case "running":
			return theme.fg("accent", spinnerFrame(options.now));
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("muted", "■");
	}
}

/** `12 tool calls · 41k context · 1m03s`. */
export function statsLine(details: Pick<AgentDetails, "toolUses" | "contextTokens" | "durationMs">): string {
	const calls = `${details.toolUses} tool call${details.toolUses === 1 ? "" : "s"}`;
	return [calls, `${formatTokens(details.contextTokens)} context`, formatDuration(details.durationMs)].join(" · ");
}

/** Short model label: drop the provider. */
export function shortModel(model: string): string {
	const slash = model.indexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
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

/** A tool call styled the way Pi's built-in renderers style their call line. */
export function styleToolCall(summary: ToolCallSummary, theme: Theme): string {
	const head = theme.fg("toolTitle", theme.bold(summary.head));
	return summary.rest ? `${head} ${theme.fg("toolOutput", summary.rest)}` : head;
}

/** `ctrl+o to expand`, from the user's keybindings when Pi's theme is available. */
function expandHint(theme: Theme): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return theme.fg("muted", "ctrl+o to expand");
	}
}

function markdownTheme() {
	try {
		const markdown = getMarkdownTheme();
		markdown.heading("probe");
		return markdown;
	} catch {
		return undefined;
	}
}

/**
 * Text cut to `max` lines with Pi's own "(N more lines, ctrl+o to expand)"
 * trailer, or the whole text as Markdown when expanded.
 */
export function collapsibleText(text: string, options: { expanded: boolean; maxLines: number; color: (line: string) => string; theme: Theme }): Container {
	const { expanded, maxLines, color, theme } = options;
	const container = new Container();
	const markdown = expanded ? markdownTheme() : undefined;
	if (expanded && markdown) {
		container.addChild(new Markdown(text, 0, 0, markdown, { color }));
		return container;
	}
	const lines = text.split("\n");
	const shown = expanded ? lines : lines.slice(0, maxLines);
	let body = shown.map(color).join("\n");
	const hidden = lines.length - shown.length;
	if (hidden > 0) body += `\n${theme.fg("muted", `... (${hidden} more line${hidden === 1 ? "" : "s"}, `)}${expandHint(theme)}${theme.fg("muted", ")")}`;
	container.addChild(new Text(body, 0, 0));
	return container;
}

/** `agent scout map payment flow`, in the shape of Pi's own `grep /x/ in src`. */
export function renderAgentCall(args: { subagent_type?: string; description?: string; name?: string }, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold("agent"));
	if (args.subagent_type) text += ` ${theme.fg("accent", args.subagent_type)}`;
	if (args.description) text += ` ${theme.fg("toolOutput", args.description)}`;
	return new Text(text, 0, 0);
}

/**
 * The Agent tool's result inside Pi's standard tool box: live tool calls while
 * it runs, then the report itself, collapsed like any other tool output.
 */
export function renderAgentResult(details: AgentDetails | undefined, fallback: string, expanded: boolean, theme: Theme): Container {
	const container = new Container();
	if (!details) {
		container.addChild(new Text(theme.fg("toolOutput", fallback), 0, 0));
		return container;
	}
	const meta = (extra: string) => theme.fg("muted", `${shortModel(details.model)} · ${extra}`);
	if (details.status === "running" || details.status === "queued") {
		if (details.background) {
			container.addChild(new Text(theme.fg("muted", `running in background as ${details.name} · ↓ to watch`), 0, 0));
			return container;
		}
		const shown = expanded ? details.toolLog : details.toolLog.slice(-3);
		const earlier = details.toolUses - shown.length;
		const lines: string[] = [];
		if (earlier > 0) lines.push(`${theme.fg("muted", `... (${earlier} earlier tool call${earlier === 1 ? "" : "s"}, `)}${expandHint(theme)}${theme.fg("muted", ")")}`);
		for (const call of shown) lines.push(styleToolCall(call, theme));
		if (details.status === "queued") lines.push(theme.fg("muted", "queued"));
		lines.push("", meta(`${contextLabel(details.contextTokens, details.contextBudget, details.contextWindow)} · ${formatDuration(details.durationMs)}`));
		container.addChild(new Text(lines.join("\n"), 0, 0));
		return container;
	}
	if (details.result) {
		container.addChild(collapsibleText(details.result, { expanded, maxLines: 10, color: (line) => theme.fg("toolOutput", line), theme }));
	}
	const notes: string[] = [];
	if (details.error) notes.push(theme.fg("error", details.error));
	if (details.status === "stopped") notes.push(theme.fg("warning", "[stopped]"));
	if (details.budgetExhausted) notes.push(theme.fg("warning", "[budget exhausted]"));
	if (details.worktree) notes.push(theme.fg("muted", `worktree ${details.worktree.path} (${details.worktree.branch})`));
	notes.push(meta(`${details.toolUses} tool call${details.toolUses === 1 ? "" : "s"} · ${formatTokens(details.contextTokens)} context · took ${formatDuration(details.durationMs)}`));
	container.addChild(new Text(`${details.result ? "\n" : ""}${notes.join("\n")}`, 0, 0));
	return container;
}

/**
 * A background agent's report as it lands in the session: a custom-message box
 * labeled `[agent]`, the same frame Pi gives `[skill]` and other injected text.
 */
export function renderAgentMessage(details: AgentDetails, expanded: boolean, theme: Theme): Box {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const label = theme.fg("customMessageLabel", theme.bold("[agent]"));
	const type = details.name === details.type || details.name.startsWith(`${details.type}-`) ? "" : `${details.type} `;
	const head = `${label} ${theme.fg("customMessageText", details.name)} ${theme.fg("muted", `${type}· ${details.status} · ${statsLine(details)}`)}`;
	box.addChild(new Text(head, 0, 0));
	if (details.error) box.addChild(new Text(theme.fg("error", details.error), 0, 0));
	if (details.result) {
		box.addChild(new Text("", 0, 0));
		box.addChild(collapsibleText(details.result, { expanded, maxLines: 6, color: (line) => theme.fg("customMessageText", line), theme }));
	}
	return box;
}
