import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	CustomMessageComponent,
	getMarkdownTheme,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Focusable, Input, Key, matchesKey, Spacer, type TUI, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { contentText, formatDuration } from "./format.js";
import type { AgentManager, AgentRun, ChildMessage, LogEntry } from "./manager.js";
import { contextLabel, shortModel, statusGlyph } from "./render.js";

/** Share of the terminal the transcript takes, like Pi's own full-height selectors. */
export const VIEWER_HEIGHT_PCT = 75;
/** Header, three rules, the input and the hint line. */
const CHROME = 6;

type AnyToolDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];

/** Pi's built-in tool definitions carry its renderers: `$ cmd` boxes, read previews, edit diffs. */
function builtinRenderers(cwd: string): Record<string, AnyToolDefinition> {
	const make: Record<string, (dir: string) => unknown> = {
		bash: createBashToolDefinition,
		read: createReadToolDefinition,
		edit: createEditToolDefinition,
		write: createWriteToolDefinition,
		grep: createGrepToolDefinition,
		find: createFindToolDefinition,
		ls: createLsToolDefinition,
	};
	const out: Record<string, AnyToolDefinition> = {};
	for (const [name, factory] of Object.entries(make)) {
		try {
			out[name] = factory(cwd) as AnyToolDefinition;
		} catch {
			// Unknown to this Pi version: Pi's generic tool rendering applies.
		}
	}
	return out;
}

function markdownTheme() {
	try {
		const theme = getMarkdownTheme();
		theme.heading("probe");
		return theme;
	} catch {
		return undefined;
	}
}

/**
 * A subagent's session, shown the way Pi shows any session: user messages,
 * assistant markdown and tool boxes come from Pi's own components. It takes
 * the editor's place like Pi's selectors do; typing steers the agent while it
 * runs, or follows up once it is done.
 */
export class AgentViewer implements Component, Focusable {
	private readonly input = new Input();
	private readonly transcript = new Container();
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly partialsShown = new Map<string, unknown>();
	private readonly renderers: Record<string, AnyToolDefinition>;
	private readonly markdown = markdownTheme();
	private readonly streaming: AssistantMessageComponent;
	private rendered: LogEntry[] = [];
	private streamed = "";
	private scroll = 0;
	private expanded = false;
	private status = "";
	private _focused = false;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly run: AgentRun,
		manager: AgentManager,
		private readonly done: () => void,
		/** Steer or follow up; the host decides whether the result is reported to the parent. */
		private readonly send: (text: string) => Promise<"steered" | "queued" | "started">,
		private readonly stop: () => void,
	) {
		this.renderers = builtinRenderers(run.spec.cwd);
		this.streaming = new AssistantMessageComponent(undefined, true, this.markdown);
		this.unsubscribe = manager.subscribe(() => tui.requestRender());
		this.input.onSubmit = (value) => this.submit(value);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Append components for log entries that arrived since the last render, or rebuild if the log was trimmed. */
	private sync(): void {
		const log = this.run.log;
		const last = this.rendered.at(-1);
		let start = last ? log.lastIndexOf(last) + 1 : 0;
		if (last && start === 0) {
			this.transcript.clear();
			this.tools.clear();
			this.partialsShown.clear();
			start = 0;
		}
		for (const entry of log.slice(start)) this.append(entry);
		this.rendered = log.slice();
		for (const [id, partial] of this.run.partials) {
			const tool = this.tools.get(id);
			if (!tool || this.partialsShown.get(id) === partial) continue;
			this.partialsShown.set(id, partial);
			tool.updateResult({ content: partial.content, details: partial.details, isError: false }, true);
		}
		const text = this.run.streaming;
		if (text !== this.streamed) {
			this.streamed = text;
			this.streaming.updateContent({ role: "assistant", content: text ? [{ type: "text", text }] : [] } as never, true);
		}
	}

	private append(entry: LogEntry): void {
		if (entry.kind === "notice") {
			this.transcript.addChild(new Spacer(1));
			this.transcript.addChild(new Text(this.theme.fg("muted", entry.text), 1, 0));
			return;
		}
		const message = entry.message;
		try {
			this.appendMessage(message);
		} catch {
			// A message Pi's components cannot draw: fall back to its text.
			const text = contentText(message.content);
			if (text) this.transcript.addChild(new Text(this.theme.fg("muted", text), 1, 0));
		}
	}

	private appendMessage(message: ChildMessage): void {
		switch (message.role) {
			case "user": {
				const text = contentText(message.content).trim();
				if (text) this.transcript.addChild(new UserMessageComponent(text, this.markdown));
				return;
			}
			case "assistant": {
				this.transcript.addChild(new AssistantMessageComponent(message as never, true, this.markdown));
				const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
				for (const block of blocks) {
					if (block.type !== "toolCall") continue;
					const id = String(block.id ?? "");
					const name = String(block.name ?? "tool");
					const tool = new ToolExecutionComponent(name, id, block.arguments, { showImages: false }, this.renderers[name], this.tui, this.run.spec.cwd);
					tool.setArgsComplete();
					tool.markExecutionStarted();
					tool.setExpanded(this.expanded);
					this.tools.set(id, tool);
					this.transcript.addChild(tool);
				}
				return;
			}
			case "toolResult": {
				const tool = this.tools.get(String(message.toolCallId ?? ""));
				tool?.updateResult({
					content: Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [],
					details: message.details,
					isError: message.isError === true,
				});
				return;
			}
			case "custom": {
				if (message.display !== true) return;
				this.transcript.addChild(new CustomMessageComponent(message as never, undefined, this.markdown));
				return;
			}
		}
	}

	private submit(value: string): void {
		const text = value.trim();
		if (!text) return;
		this.input.setValue("");
		this.scroll = 0;
		this.send(text).then(
			(outcome) => {
				this.status = outcome === "steered" ? "steering after its current tool calls" : outcome === "queued" ? "added to its queued task" : "resumed";
				this.tui.requestRender();
			},
			(error: unknown) => {
				this.status = error instanceof Error ? error.message : String(error);
				this.tui.requestRender();
			},
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.input.getValue()) this.input.setValue("");
			else this.close();
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			this.stop();
			this.status = "stopping";
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			for (const tool of this.tools.values()) tool.setExpanded(this.expanded);
			this.tui.requestRender();
			return;
		}
		const page = Math.max(1, this.viewportHeight() - 2);
		if (matchesKey(data, "up")) this.scroll += 1;
		else if (matchesKey(data, "down")) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.pageUp)) this.scroll += page;
		else if (matchesKey(data, Key.pageDown)) this.scroll = Math.max(0, this.scroll - page);
		else {
			this.input.handleInput(data);
			return;
		}
		this.tui.requestRender();
	}

	private close(): void {
		this.unsubscribe();
		this.done();
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {
		this.transcript.invalidate();
		this.streaming.invalidate();
		this.input.invalidate();
	}

	private viewportHeight(): number {
		const rows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
		return Math.max(6, Math.floor((rows * VIEWER_HEIGHT_PCT) / 100) - CHROME);
	}

	private rightAligned(left: string, right: string, width: number): string {
		const room = width - visibleWidth(right) - 1;
		if (room < 10) return truncateToWidth(left, width);
		const clipped = truncateToWidth(left, room);
		return `${clipped}${" ".repeat(Math.max(1, width - visibleWidth(clipped) - visibleWidth(right)))}${right}`;
	}

	render(width: number): string[] {
		this.sync();
		const th = this.theme;
		const run = this.run;
		const now = Date.now();
		const rule = th.fg("border", "─".repeat(Math.max(1, width)));

		const type = run.name === run.type || run.name.startsWith(`${run.type}-`) ? "" : ` ${th.fg("muted", run.type)}`;
		const name = `${statusGlyph(run.status, th, { now, approval: Boolean(run.approval) })} ${th.fg("accent", th.bold(run.name))}${type} ${th.fg("text", run.description)}`;
		const meta = th.fg("muted", [
			`${shortModel(run.spec.model)}${run.spec.thinking ? `:${run.spec.thinking}` : ""}`,
			contextLabel(run.contextTokens, run.spec.contextBudget, run.spec.contextWindow),
			`${run.toolUses} tool calls`,
			formatDuration((run.endedAt ?? now) - run.runStartedAt),
		].join(" · "));

		const body = [...this.transcript.render(width)];
		if (run.status === "running") {
			const tail = this.streaming.render(width);
			if (tail.some((line) => line.trim())) body.push(...tail);
			else body.push("", ` ${th.fg("accent", statusGlyph("running", th, { now }))} ${th.fg("muted", run.approval ? `waiting for your approval: ${run.approval.split("\n")[0]}` : "working…")}`);
		}

		const height = this.viewportHeight();
		this.scroll = Math.min(this.scroll, Math.max(0, body.length - height));
		const end = body.length - this.scroll;
		const visible = body.slice(Math.max(0, end - height), end);
		while (visible.length < height) visible.unshift("");

		const action = run.status === "running" ? "steer" : run.status === "queued" ? "add to task" : "follow up";
		const hint = (key: string, text: string) => `${th.fg("dim", key)} ${th.fg("muted", text)}`;
		const hints = [
			hint("enter", action),
			hint("↑↓", this.scroll ? `scroll (${this.scroll} up)` : "scroll"),
			hint("ctrl+o", this.expanded ? "collapse" : "expand"),
			...(run.busy ? [hint("ctrl+x", "stop")] : []),
			hint("esc", "back"),
		].join(th.fg("dim", " · "));

		return [
			rule,
			this.rightAligned(` ${name}`, `${meta} `, width),
			rule,
			...visible,
			rule,
			this.status
				? this.rightAligned(this.input.render(Math.max(10, width - visibleWidth(this.status) - 3))[0] ?? "", `${th.fg("muted", this.status)} `, width)
				: truncateToWidth(this.input.render(width - 1)[0] ?? "", width),
			truncateToWidth(` ${hints}`, width),
		];
	}
}
