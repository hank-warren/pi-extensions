import {
	AssistantMessageComponent,
	CompactionSummaryMessageComponent,
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
import { contentText, formatDuration, oneLine } from "./format.js";
import type { AgentManager, AgentRun, ChildMessage, LogEntry, RunEvent } from "./manager.js";
import { contextLabel, shortModel, spinnerFrame, statusGlyph } from "./render.js";
import { snapshot } from "./stream.js";

/** Share of the terminal the transcript takes, like Pi's own full-height selectors. */
export const VIEWER_HEIGHT_PCT = 75;
/** Header, three rules, the input and the hint line. */
const CHROME = 6;
/** Pi's label for a collapsed thinking block. */
const HIDDEN_THINKING_LABEL = "Thinking...";

export type AnyToolDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];

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

function markdownTheme(codeBlockIndent: string | undefined) {
	try {
		const theme = getMarkdownTheme();
		theme.heading("probe");
		return codeBlockIndent === undefined ? theme : { ...theme, codeBlockIndent };
	} catch {
		return undefined;
	}
}

/** The slice of Pi's keybindings manager the viewer uses. */
export interface ViewerKeys {
	matches(data: string, id: string): boolean;
	getKeys(id: string): string[];
}

/** The display settings of the user's Pi, which the main session renders with too. */
export interface ViewerSettings {
	hideThinkingBlock?: boolean;
	outputPad?: number;
	showImages?: boolean;
	imageWidthCells?: number;
	codeBlockIndent?: string;
}

export interface ViewerOptions {
	keys: ViewerKeys;
	/** A tool's renderers as the parent session resolves them, when it has drawn that tool. */
	renderers?(toolName: string): AnyToolDefinition | undefined;
	settings?: ViewerSettings;
}

/** A muted line, colored at render time so a theme switch repaints it. */
class Notice implements Component {
	private text: Text | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly content: string,
	) {}

	render(width: number): string[] {
		this.text ??= new Text(this.theme.fg("muted", this.content), 1, 0);
		return this.text.render(width);
	}

	invalidate(): void {
		this.text = undefined;
	}
}

type Expandable = Component & { setExpanded(expanded: boolean): void };

/**
 * A subagent's session, shown exactly as Pi shows one: the same components,
 * the same tool renderers the main session uses, thinking shown or hidden by
 * the same setting and key, and live updates applied the way Pi's own
 * interactive mode applies them. It takes the editor's place like Pi's
 * selectors do; typing steers the agent while it runs, or follows up once it
 * is done.
 */
export class AgentViewer implements Component, Focusable {
	private readonly input = new Input();
	private readonly chat = new Container();
	/** Every top-level tool row, by call id. */
	private readonly tools = new Map<string, ToolExecutionComponent>();
	/** Rows still waiting for their result. */
	private readonly pending = new Map<string, ToolExecutionComponent>();
	private readonly assistants = new Set<AssistantMessageComponent>();
	private readonly expandable = new Set<Expandable>();
	/** When each tool call ran: the manager's clock while live, else its messages' timestamps. */
	private readonly timing = new Map<string, { start?: number; end?: number }>();
	private readonly renderers = new Map<string, AnyToolDefinition>();
	private readonly builtins: Record<string, AnyToolDefinition>;
	private readonly markdown: ReturnType<typeof markdownTheme>;
	private readonly settings: ViewerSettings;
	private streaming: AssistantMessageComponent | undefined;
	/** Deltas arrived since the streaming message was last drawn; applied once per frame. */
	private streamDirty = false;
	private hideThinking: boolean;
	private scroll = 0;
	private expanded = false;
	private status = "";
	private _focused = false;
	private readonly unsubscribeEvents: () => void;
	private readonly unsubscribeChanges: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly run: AgentRun,
		manager: AgentManager,
		private readonly done: () => void,
		/** Steer or follow up; the host decides whether the result is reported to the parent. */
		private readonly send: (text: string) => Promise<"steered" | "queued" | "started">,
		private readonly options: ViewerOptions,
	) {
		this.settings = options.settings ?? {};
		this.hideThinking = this.settings.hideThinkingBlock ?? false;
		this.markdown = markdownTheme(this.settings.codeBlockIndent);
		this.builtins = builtinRenderers(run.spec.cwd);
		for (const entry of run.log) this.addEntry(entry);
		this.resumeLive();
		this.unsubscribeEvents = run.onEvent((event) => {
			this.handle(event);
			tui.requestRender();
		});
		// Other agents' changes do not show here; this one's do (its header, its working line).
		let look = run.look;
		this.unsubscribeChanges = manager.subscribe(() => {
			if (run.look === look) return;
			look = run.look;
			tui.requestRender();
		});
		this.input.onSubmit = (value) => this.submit(value);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private get pad(): number {
		return this.settings.outputPad ?? 1;
	}

	/** The renderers the main session would use for this tool, timed by when the call really ran. */
	private rendererFor(name: string): AnyToolDefinition {
		let definition = this.renderers.get(name);
		if (!definition) {
			definition = this.timed(this.options.renderers?.(name) ?? this.builtins[name]);
			if (definition) this.renderers.set(name, definition);
		}
		return definition;
	}

	/**
	 * Pi's renderers time a call from when its component starts (`Took 0.0s`
	 * for a call that ran before the viewer opened); seed their state with
	 * when it really ran.
	 */
	private timed(definition: AnyToolDefinition): AnyToolDefinition {
		const render = (definition as { renderResult?: (...args: unknown[]) => unknown } | undefined)?.renderResult;
		if (!definition || typeof render !== "function") return definition;
		return {
			...definition,
			renderResult: (result: unknown, options: unknown, theme: unknown, context: { toolCallId?: string; state?: Record<string, unknown> } | undefined) => {
				const known = context?.toolCallId ? this.timing.get(context.toolCallId) : undefined;
				const state = context?.state;
				if (known && state) {
					// Unconditionally: the call renderer has already stamped its own start by now.
					if (known.start !== undefined) state.startedAt = known.start;
					if (known.end !== undefined) state.endedAt = known.end;
				}
				return render.call(definition, result, options, theme, context);
			},
		} as AnyToolDefinition;
	}

	private noteTiming(id: string, fallback: { start?: number; end?: number }): void {
		const live = this.run.toolTimes.get(id);
		const entry = this.timing.get(id) ?? {};
		entry.start ??= live?.start ?? fallback.start;
		entry.end ??= live?.end ?? fallback.end;
		this.timing.set(id, entry);
	}

	private add(component: Component): void {
		this.chat.addChild(component);
		const expandable = component as Partial<Expandable>;
		if (typeof expandable.setExpanded === "function") {
			expandable.setExpanded(this.expanded);
			this.expandable.add(component as Expandable);
		}
	}

	private assistant(message?: ChildMessage): AssistantMessageComponent {
		const component = new AssistantMessageComponent(message as never, this.hideThinking, this.markdown, HIDDEN_THINKING_LABEL, this.pad);
		this.assistants.add(component);
		this.add(component);
		return component;
	}

	private toolRow(name: string, id: string, args: unknown): ToolExecutionComponent {
		const row = new ToolExecutionComponent(
			name,
			id,
			args,
			{ showImages: this.settings.showImages ?? true, imageWidthCells: this.settings.imageWidthCells } as never,
			this.rendererFor(name),
			this.tui,
			this.run.spec.cwd,
		);
		this.tools.set(id, row);
		this.add(row);
		return row;
	}

	private notice(text: string): void {
		this.add(new Spacer(1));
		this.add(new Notice(this.theme, text));
	}

	/** A message from the child's history, the way Pi renders a resumed session. */
	private addEntry(entry: LogEntry): void {
		if (entry.kind === "notice") return this.notice(entry.text);
		if (entry.kind === "compaction") return this.compaction(entry.summary, entry.tokensBefore, entry.timestamp);
		try {
			this.addHistoric(entry.message);
		} catch {
			// A message Pi's components cannot draw: fall back to its text.
			const text = contentText(entry.message.content);
			if (text) this.notice(text);
		}
	}

	private compaction(summary: string, tokensBefore: number, timestamp: number): void {
		this.add(new CompactionSummaryMessageComponent({ role: "compactionSummary", summary, tokensBefore, timestamp } as never, this.markdown));
	}

	private addHistoric(message: ChildMessage): void {
		switch (message.role) {
			case "assistant": {
				this.assistant(message);
				const failed = message.stopReason === "aborted" || message.stopReason === "error";
				for (const block of toolCalls(message)) {
					const row = this.toolRow(block.name, block.id, block.arguments);
					row.setArgsComplete();
					this.noteTiming(block.id, { start: timestampOf(message) });
					if (failed) {
						const text = message.stopReason === "aborted" ? "Operation aborted" : String(message.errorMessage ?? "Error");
						row.updateResult({ content: [{ type: "text", text }], isError: true });
					} else {
						this.pending.set(block.id, row);
					}
				}
				return;
			}
			case "toolResult": {
				const id = String(message.toolCallId ?? "");
				const content = Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [];
				const row = this.pending.get(id) ?? this.tools.get(id);
				if (!row) {
					// Its call was trimmed from the log: keep the output rather than dropping it.
					const text = contentText(message.content).trim();
					if (text) this.notice(`${String(message.toolName ?? "tool")} result: ${text.split("\n").slice(0, 3).join(" ")}`);
					return;
				}
				this.noteTiming(id, { end: timestampOf(message) });
				row.markExecutionStarted();
				row.updateResult({ content, details: message.details, isError: message.isError === true });
				this.pending.delete(id);
				return;
			}
			default:
				this.addMessage(message);
		}
	}

	/** User and custom messages, as Pi's chat adds them. */
	private addMessage(message: ChildMessage): void {
		if (message.role === "user") {
			const text = contentText(message.content).trim();
			if (text) this.add(new UserMessageComponent(text, this.markdown, this.pad));
		} else if (message.role === "custom" && message.display === true) {
			this.add(new CustomMessageComponent(message as never, undefined, this.markdown, this.pad));
		}
	}

	/** Opened mid-run: pick up the message streaming and the tools running right now. */
	private resumeLive(): void {
		for (const id of this.run.runningTools) {
			const row = this.tools.get(id);
			if (!row) continue;
			this.pending.set(id, row);
			row.markExecutionStarted();
			const partial = this.run.partials.get(id);
			if (partial) row.updateResult({ content: partial.content, details: partial.details, isError: false }, true);
		}
		if (this.run.partial) {
			this.streaming = this.assistant();
			this.updateStreaming();
		}
	}

	private updateStreaming(): void {
		this.streamDirty = false;
		if (!this.streaming || !this.run.partial) return;
		const message = snapshot(this.run.partial);
		this.streaming.updateContent(message as never, true);
		for (const block of toolCalls(message)) {
			const row = this.pending.get(block.id) ?? this.tools.get(block.id);
			if (row) row.updateArgs(block.arguments);
			else this.pending.set(block.id, this.toolRow(block.name, block.id, block.arguments));
		}
	}

	private finishStreaming(message: ChildMessage): void {
		this.streamDirty = false;
		if (!this.streaming) {
			this.addHistoric(message);
			return;
		}
		const aborted = message.stopReason === "aborted";
		const final = aborted ? { ...message, errorMessage: "Operation aborted" } : message;
		this.streaming.updateContent(final as never, false);
		for (const block of toolCalls(message)) {
			this.noteTiming(block.id, { start: timestampOf(message) });
			const row = this.pending.get(block.id) ?? this.tools.get(block.id);
			if (row) row.updateArgs(block.arguments);
			else this.pending.set(block.id, this.toolRow(block.name, block.id, block.arguments));
		}
		if (aborted || message.stopReason === "error") {
			const text = aborted ? "Operation aborted" : String(message.errorMessage ?? "Error");
			for (const row of this.pending.values()) row.updateResult({ content: [{ type: "text", text }], isError: true });
			this.pending.clear();
		} else {
			for (const row of this.pending.values()) row.setArgsComplete();
		}
		this.streaming = undefined;
	}

	/** A live event from the child, handled as Pi's interactive mode handles its own. */
	private handle(event: RunEvent): void {
		const message = event.message as ChildMessage | undefined;
		switch (event.type) {
			case "pi-agents-notice":
				this.notice(String(event.text ?? ""));
				return;
			case "message_start":
				if (message?.role === "assistant") {
					this.streaming = this.assistant();
					this.updateStreaming();
				} else if (message) {
					this.addMessage(message);
				}
				return;
			case "message_update":
				// Pi renders at most once per frame; a delta only marks the message for it.
				this.streamDirty = true;
				return;
			case "message_end":
				if (message?.role === "assistant") this.finishStreaming(message);
				return;
			case "tool_execution_start": {
				// Calls a codemode script makes are drawn inside the script's own row.
				if (event.parentToolCallId) return;
				const id = String(event.toolCallId ?? "");
				let row = this.pending.get(id);
				if (!row) {
					row = this.toolRow(String(event.toolName ?? "tool"), id, event.args);
					this.pending.set(id, row);
				}
				this.noteTiming(id, { start: Date.now() });
				row.markExecutionStarted();
				return;
			}
			case "tool_execution_update": {
				const partial = event.partialResult as { content?: unknown[]; details?: unknown } | undefined;
				const row = this.pending.get(String(event.toolCallId ?? ""));
				if (row && partial) row.updateResult({ ...partial, content: (partial.content ?? []) as never, isError: false }, true);
				return;
			}
			case "tool_execution_end": {
				const id = String(event.toolCallId ?? "");
				const row = this.pending.get(id);
				if (!row) return;
				this.noteTiming(id, { end: Date.now() });
				const result = (event.result ?? {}) as { content?: unknown[]; details?: unknown };
				row.updateResult({ ...result, content: (result.content ?? []) as never, isError: event.isError === true });
				this.pending.delete(id);
				return;
			}
			case "agent_end":
				if (this.streaming) {
					this.chat.removeChild(this.streaming);
					this.assistants.delete(this.streaming);
					this.streaming = undefined;
				}
				this.pending.clear();
				return;
			case "compaction_end": {
				const result = event.result as { summary?: unknown; tokensBefore?: unknown } | undefined;
				if (result && typeof result.summary === "string") this.compaction(result.summary, Number(result.tokensBefore) || 0, Date.now());
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
				this.status = oneLine(error instanceof Error ? error.message : String(error), 200);
				this.tui.requestRender();
			},
		);
	}

	handleInput(data: string): void {
		const keys = this.options.keys;
		if (matchesKey(data, "escape") || keys.matches(data, "tui.select.cancel")) {
			if (this.input.getValue()) this.input.setValue("");
			else this.close();
			this.tui.requestRender();
			return;
		}
		if (keys.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			for (const component of this.expandable) component.setExpanded(this.expanded);
			this.tui.requestRender();
			return;
		}
		if (keys.matches(data, "app.thinking.toggle")) {
			this.hideThinking = !this.hideThinking;
			for (const component of this.assistants) component.setHideThinkingBlock(this.hideThinking);
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
		this.dispose();
		this.done();
	}

	dispose(): void {
		this.unsubscribeEvents();
		this.unsubscribeChanges();
	}

	invalidate(): void {
		this.chat.invalidate();
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

	private keyLabel(id: string, fallback: string): string {
		try {
			return this.options.keys.getKeys(id)[0] ?? fallback;
		} catch {
			return fallback;
		}
	}

	render(width: number): string[] {
		if (this.streamDirty) this.updateStreaming();
		return this.draw(width).map((line) => truncateToWidth(line, width));
	}

	/** Pi's working line under the transcript: `⠋ Working...`, or what the agent is waiting on. */
	private indicator(now: number): string[] {
		const run = this.run;
		if (run.status !== "running") return [];
		const th = this.theme;
		const spinner = spinnerFrame(now);
		if (run.approval) return ["", ` ${th.fg("warning", "?")} ${th.fg("warning", `Waiting for your approval: ${oneLine(run.approval, 200)}`)}`];
		const label = run.compactingNow ? "Compacting context..." : run.compacting ? "Compacting context, then continuing..." : "Working...";
		return ["", ` ${th.fg("accent", spinner)} ${th.fg("muted", label)}`];
	}

	private draw(width: number): string[] {
		const th = this.theme;
		const run = this.run;
		const now = Date.now();
		const rule = th.fg("border", "─".repeat(Math.max(1, width)));

		const type = !run.type || run.name === run.type || run.name.startsWith(`${run.type}-`) ? "" : ` ${th.fg("muted", run.type)}`;
		const name = `${statusGlyph(run.status, th, { now, approval: Boolean(run.approval) })} ${th.fg("accent", th.bold(run.name))}${type} ${th.fg("text", oneLine(run.description, 100))}`;
		const meta = th.fg("muted", [
			`${shortModel(run.spec.model)}${run.spec.thinking ? `:${run.spec.thinking}` : ""}`,
			contextLabel(run.contextTokens, run.spec.contextWindow, run.spec.autocompact),
			`${run.toolUses} tool call${run.toolUses === 1 ? "" : "s"}`,
			formatDuration((run.endedAt ?? now) - run.runStartedAt),
		].join(" · "));

		const body = [...this.chat.render(width), ...this.indicator(now)];
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
			hint(this.keyLabel("app.tools.expand", "ctrl+o"), this.expanded ? "collapse" : "expand"),
			hint(this.keyLabel("app.thinking.toggle", "ctrl+t"), this.hideThinking ? "show thinking" : "hide thinking"),
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
				: this.input.render(width - 1)[0] ?? "",
			` ${hints}`,
		];
	}
}

type ToolCallBlock = { id: string; name: string; arguments: unknown };

function toolCalls(message: ChildMessage | { content: unknown }): ToolCallBlock[] {
	const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
	return blocks
		.filter((block) => block?.type === "toolCall")
		.map((block) => ({ id: String(block.id ?? ""), name: String(block.name ?? "tool"), arguments: block.arguments }));
}

function timestampOf(message: ChildMessage): number | undefined {
	return typeof message.timestamp === "number" ? message.timestamp : undefined;
}
