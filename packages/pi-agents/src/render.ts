import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, oneLine, type ToolCallSummary } from "./format.js";
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
	/** Compacts at this percentage of the context window. */
	autocompact?: number;
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
		autocompact: run.spec.autocompact,
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
	if (options.approval) return theme.fg("warning", "?");
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

/** Where the context compacts: the autocompact share of the window, else the window. */
export function contextLimit(window: number | undefined, autocompact: number | undefined): number | undefined {
	return window && autocompact ? Math.floor((window * autocompact) / 100) : window;
}

/**
 * `78k/100k autocompact` when the agent compacts early, else `78k/272k`
 * against the model's window, else just `78k`.
 */
export function contextLabel(used: number, window: number | undefined, autocompact?: number): string {
	const limit = contextLimit(window, autocompact);
	if (!limit) return formatTokens(used);
	return `${formatTokens(used)}/${formatTokens(limit)}${limit !== window ? " autocompact" : ""}`;
}

/** Share of the context limit in use, or undefined when the window is unknown. */
export function contextShare(used: number, window: number | undefined, autocompact?: number): number | undefined {
	const limit = contextLimit(window, autocompact);
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

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;
const blank = (line: string) => line.replace(ANSI, "").trim() === "";

/**
 * Rendered lines cut to at most `maxLines`, at the last blank line between
 * blocks so a paragraph or table is never sliced; inside the first block only
 * when it alone is taller. Pure, for tests.
 */
export function clampAtBlock(lines: string[], maxLines: number): { shown: string[]; hidden: number } {
	let end = lines.length;
	while (end > 0 && blank(lines[end - 1]!)) end--;
	if (end <= maxLines) return { shown: lines.slice(0, end), hidden: 0 };
	let cut = maxLines;
	for (let i = maxLines; i > 0; i--) {
		if (blank(lines[i]!)) {
			cut = i;
			break;
		}
	}
	while (cut > 0 && blank(lines[cut - 1]!)) cut--;
	return { shown: lines.slice(0, cut), hidden: end - cut };
}

/** A component cut with `clampAtBlock`, then Pi's "... (N more lines, ctrl+o to expand)". */
class Clamped implements Component {
	constructor(
		private readonly inner: Component,
		private readonly maxLines: number,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const { shown, hidden } = clampAtBlock(this.inner.render(width), this.maxLines);
		if (hidden === 0) return shown;
		const trailer = `${this.theme.fg("muted", `... (${hidden} more line${hidden === 1 ? "" : "s"}, `)}${expandHint(this.theme)}${this.theme.fg("muted", ")")}`;
		return [...shown, "", truncateToWidth(trailer, width)];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/**
 * A report rendered with Pi's Markdown, cut between blocks to `maxLines`
 * until expanded.
 */
export function collapsibleText(text: string, options: { expanded: boolean; maxLines: number; color: (line: string) => string; theme: Theme }): Container {
	const { expanded, maxLines, color, theme } = options;
	const container = new Container();
	const markdown = markdownTheme();
	const body: Component = markdown ? new Markdown(text, 0, 0, markdown, { color }) : new Text(text.split("\n").map(color).join("\n"), 0, 0);
	container.addChild(expanded ? body : new Clamped(body, maxLines, theme));
	return container;
}

/** `agent reviewer review auth changes · claude-opus-5-5`, in the shape of Pi's own `grep /x/ in src`. */
export function renderAgentCall(args: { agent?: string; description?: string; model?: string }, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold("agent"));
	if (args.agent) text += ` ${theme.fg("accent", args.agent)}`;
	if (args.description) text += ` ${theme.fg("toolOutput", oneLine(args.description, 100))}`;
	if (args.model) text += theme.fg("muted", ` · ${shortModel(args.model)}`);
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
			container.addChild(new Text(theme.fg("muted", `running in background as ${details.name} · ↓ to manage`), 0, 0));
			return container;
		}
		const shown = expanded ? details.toolLog : details.toolLog.slice(-3);
		const earlier = details.toolUses - shown.length;
		const lines: string[] = [];
		if (earlier > 0) lines.push(`${theme.fg("muted", `... (${earlier} earlier tool call${earlier === 1 ? "" : "s"}, `)}${expandHint(theme)}${theme.fg("muted", ")")}`);
		for (const call of shown) lines.push(styleToolCall(call, theme));
		if (details.status === "queued") lines.push(theme.fg("muted", "queued"));
		lines.push("", meta(`${contextLabel(details.contextTokens, details.contextWindow, details.autocompact)} · ${formatDuration(details.durationMs)}`));
		container.addChild(new Text(lines.join("\n"), 0, 0));
		return container;
	}
	if (details.result) {
		container.addChild(collapsibleText(details.result, { expanded, maxLines: REPORT_LINES, color: (line) => theme.fg("toolOutput", line), theme }));
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

/** Rendered report lines shown before ctrl+o. */
const REPORT_LINES = 8;

/**
 * A background agent's report as it lands in the session, in the frame Pi
 * gives injected messages: `agent ✓ name · stats`, then the report.
 */
export function renderAgentMessage(details: AgentDetails, expanded: boolean, theme: Theme): Box {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const label = theme.fg("customMessageLabel", theme.bold("agent"));
	const type = !details.type || details.name === details.type || details.name.startsWith(`${details.type}-`) ? "" : ` ${details.type}`;
	const status = details.status === "done" ? "" : ` · ${details.status}`;
	const head = `${label} ${statusGlyph(details.status, theme)} ${theme.fg("customMessageText", details.name)}${theme.fg("muted", `${type}${status} · ${statsLine(details)}`)}`;
	box.addChild(new Text(head, 0, 0));
	if (details.error) box.addChild(new Text(theme.fg("error", details.error), 0, 0));
	if (details.result) {
		box.addChild(new Spacer(1));
		box.addChild(collapsibleText(details.result, { expanded, maxLines: REPORT_LINES, color: (line) => theme.fg("customMessageText", line), theme }));
	}
	return box;
}
