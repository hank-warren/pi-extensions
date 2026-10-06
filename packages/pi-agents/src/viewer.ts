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
import { contentText, formatDuration, oneLine } from "./format.js";
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

/** The slice of Pi's keybindings manager the viewer uses. */
export interface ViewerKeys {
	matches(data: string, id: string): boolean;
	getKeys(id: string): string[];
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

interface Drawn {
	entry: LogEntry;
	components: Component[];
	toolIds: string[];
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
	/** Log entries on screen, oldest first, with the components each one added. */
	private drawn: Drawn[] = [];
	private streamed = "";
	private scroll = 0;
	private expanded = false;
	private status = "";
	private _focused = false;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keys: ViewerKeys,
		private readonly run: AgentRun,
		manager: AgentManager,
		private readonly done: () => void,
		/** Steer or follow up; the host decides whether the result is reported to the parent. */
		private readonly send: (text: string) => Promise<"steered" | "queued" | "started">,
	) {
		this.renderers = Object.fromEntries(Object.entries(builtinRenderers(run.spec.cwd)).map(([name, definition]) => [name, this.timed(definition)]));
		this.streaming = new AssistantMessageComponent(undefined, true, this.markdown);
		this.sync();
		// Synced on change rather than in render(): building tool components requests renders of its own.
		this.unsubscribe = manager.subscribe(() => {
			this.sync();
			tui.requestRender();
		});
		this.input.onSubmit = (value) => this.submit(value);
	}

	/** When each tool call ran: the manager's clock while live, else its messages' timestamps. */
	private readonly timing = new Map<string, { start?: number; end?: number }>();

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

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private reset(): void {
		this.transcript.clear();
		this.tools.clear();
		this.partialsShown.clear();
		this.timing.clear();
		this.drawn = [];
	}

	/** Bring the transcript up to the run's log: drop entries trimmed from its front, append new ones. */
	private sync(): void {
		const log = this.run.log;
		if (this.drawn.length && this.drawn[0]!.entry !== log[0]) {
			const live = new Set(log);
			let gone = 0;
			while (gone < this.drawn.length && !live.has(this.drawn[gone]!.entry)) gone++;
			if (gone === this.drawn.length) this.reset();
			else {
				for (const old of this.drawn.splice(0, gone)) {
					for (const component of old.components) this.transcript.removeChild(component);
					for (const id of old.toolIds) {
						this.tools.delete(id);
						this.timing.delete(id);
						this.partialsShown.delete(id);
					}
				}
			}
		}
		const last = this.drawn.at(-1)?.entry;
		const start = last ? log.lastIndexOf(last) + 1 : 0;
		for (let index = start; index < log.length; index++) this.append(log[index]!);
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
		const drawn: Drawn = { entry, components: [], toolIds: [] };
		this.drawn.push(drawn);
		const add = (component: Component) => {
			drawn.components.push(component);
			this.transcript.addChild(component);
		};
		if (entry.kind === "notice") {
			add(new Spacer(1));
			add(new Notice(this.theme, entry.text));
			return;
		}
		const message = entry.message;
		try {
			this.appendMessage(message, add, drawn.toolIds);
		} catch {
			// A message Pi's components cannot draw: fall back to its text.
			const text = contentText(message.content);
			if (text) add(new Notice(this.theme, text));
		}
	}

	private appendMessage(message: ChildMessage, add: (component: Component) => void, toolIds: string[]): void {
		switch (message.role) {
			case "user": {
				const text = contentText(message.content).trim();
				if (text) add(new UserMessageComponent(text, this.markdown));
				return;
			}
			case "assistant": {
				add(new AssistantMessageComponent(message as never, true, this.markdown));
				const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
				for (const block of blocks) {
					if (block.type !== "toolCall") continue;
					const id = String(block.id ?? "");
					const name = String(block.name ?? "tool");
					this.noteTiming(id, { start: typeof message.timestamp === "number" ? message.timestamp : undefined });
					const tool = new ToolExecutionComponent(name, id, block.arguments, { showImages: false }, this.renderers[name], this.tui, this.run.spec.cwd);
					tool.setArgsComplete();
					tool.markExecutionStarted();
					tool.setExpanded(this.expanded);
					this.tools.set(id, tool);
					toolIds.push(id);
					add(tool);
				}
				return;
			}
			case "toolResult": {
				const content = Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [];
				const id = String(message.toolCallId ?? "");
				const tool = this.tools.get(id);
				this.noteTiming(id, { end: typeof message.timestamp === "number" ? message.timestamp : undefined });
				if (tool) tool.updateResult({ content, details: message.details, isError: message.isError === true });
				else {
					// Its call was trimmed from the log: keep the output rather than dropping it.
					const text = contentText(message.content).trim();
					if (text) add(new Notice(this.theme, `${String(message.toolName ?? "tool")} result: ${text.split("\n").slice(0, 3).join(" ")}`));
				}
				return;
			}
			case "custom": {
				if (message.display !== true) return;
				add(new CustomMessageComponent(message as never, undefined, this.markdown));
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
		if (matchesKey(data, "escape") || this.keys.matches(data, "tui.select.cancel")) {
			if (this.input.getValue()) this.input.setValue("");
			else this.close();
			this.tui.requestRender();
			return;
		}
		if (this.keys.matches(data, "app.tools.expand")) {
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

	private keyLabel(id: string, fallback: string): string {
		try {
			return this.keys.getKeys(id)[0] ?? fallback;
		} catch {
			return fallback;
		}
	}

	render(width: number): string[] {
		return this.draw(width).map((line) => truncateToWidth(line, width));
	}

	private draw(width: number): string[] {
		const th = this.theme;
		const run = this.run;
		const now = Date.now();
		const rule = th.fg("border", "─".repeat(Math.max(1, width)));

		const type = run.name === run.type || run.name.startsWith(`${run.type}-`) ? "" : ` ${th.fg("muted", run.type)}`;
		const name = `${statusGlyph(run.status, th, { now, approval: Boolean(run.approval) })} ${th.fg("accent", th.bold(run.name))}${type} ${th.fg("text", oneLine(run.description, 100))}`;
		const meta = th.fg("muted", [
			`${shortModel(run.spec.model)}${run.spec.thinking ? `:${run.spec.thinking}` : ""}`,
			contextLabel(run.contextTokens, run.spec.contextBudget, run.spec.contextWindow),
			`${run.toolUses} tool call${run.toolUses === 1 ? "" : "s"}`,
			formatDuration((run.endedAt ?? now) - run.runStartedAt),
		].join(" · "));

		const body = [...this.transcript.render(width)];
		if (run.status === "running") {
			const tail = this.streaming.render(width);
			if (tail.some((line) => line.trim())) body.push(...tail);
			else {
				const waiting = run.approval
					? th.fg("warning", `waiting for your approval: ${oneLine(run.approval, 200)}`)
					: th.fg("muted", "working…");
				body.push("", ` ${statusGlyph("running", th, { now })} ${waiting}`);
			}
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
			hint(this.keyLabel("app.tools.expand", "ctrl+o"), this.expanded ? "collapse" : "expand"),
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
