import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens } from "./format.js";
import type { AgentManager, AgentRun, TranscriptItem } from "./manager.js";
import { statusIcon, statusWord } from "./render.js";

export const VIEWER_HEIGHT_PCT = 80;
/** Lines of chrome: top border, 2 header lines, separator, separator, input, footer, bottom border. */
const CHROME = 8;

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) out.push(...(line ? wrapTextWithAnsi(line, width) : [""]));
	return out;
}

/** Transcript lines for one item, already styled and wrapped to `width`. */
export function itemLines(item: TranscriptItem, width: number, theme: Theme): string[] {
	const inner = Math.max(10, width - 4);
	switch (item.kind) {
		case "user":
			return wrap(item.text, inner).map((line, index) => `${index === 0 ? theme.fg("accent", "› ") : "  "}${theme.fg("userMessageText", line)}`);
		case "assistant":
			return wrap(item.text, inner).map((line) => `  ${line}`);
		case "notice":
			return wrap(item.text, inner).map((line) => `  ${theme.fg("warning", line)}`);
		case "tool": {
			const color = item.status === "error" ? "error" : item.status === "done" ? "success" : "dim";
			const indent = item.nested ? "    " : "";
			const head = truncateToWidth(`${indent}${theme.fg(color, "●")} ${theme.fg("toolTitle", item.text)}`, width);
			if (!item.output) return [head];
			const preview = item.output.split("\n").filter((line) => line.trim()).slice(0, 2);
			return [head, ...preview.map((line, index) => truncateToWidth(`${indent}${theme.fg("dim", index === 0 ? "  ⎿ " : "    ")}${theme.fg("dim", line)}`, width))];
		}
	}
}

/**
 * Live transcript of one agent in an overlay. Typing goes to the agent: Enter
 * steers it while running, or resumes it with a follow-up once finished.
 */
export class AgentViewer implements Component, Focusable {
	private readonly input = new Input();
	private scroll = 0;
	private unsubscribe: () => void;
	private cache: { key: string; lines: string[] } | undefined;
	private status = "";
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly run: AgentRun,
		private readonly manager: AgentManager,
		private readonly done: () => void,
	) {
		this.unsubscribe = manager.subscribe(() => {
			this.cache = undefined;
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

	private submit(value: string): void {
		const text = value.trim();
		if (!text) return;
		this.input.setValue("");
		this.scroll = 0;
		this.manager.message(this.run, text).then(
			(outcome) => {
				this.status = outcome === "steered" ? "steered" : outcome === "queued" ? "added to queued task" : "resumed";
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
			void this.manager.stop(this.run);
			this.status = "stopping";
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
		this.cache = undefined;
		this.input.invalidate();
	}

	private viewportHeight(): number {
		const rows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
		return Math.max(4, Math.floor((rows * VIEWER_HEIGHT_PCT) / 100) - CHROME);
	}

	private bodyLines(width: number): string[] {
		const key = `${width}:${this.run.items.length}:${this.run.items.at(-1)?.status ?? ""}:${this.run.items.at(-1)?.output?.length ?? 0}`;
		if (!this.cache || this.cache.key !== key) {
			const lines: string[] = [];
			for (const item of this.run.items) lines.push(...itemLines(item, width, this.theme));
			this.cache = { key, lines };
		}
		const streaming = this.run.streaming ? wrap(this.run.streaming, Math.max(10, width - 4)).map((line) => `  ${this.theme.fg("muted", line)}`) : [];
		const thinking = this.run.status === "running" && !this.run.streaming
			? [`  ${this.theme.fg("dim", this.run.approval ? `waiting for approval: ${this.run.approval.split("\n")[0]}` : "working…")}`]
			: [];
		return [...this.cache.lines, ...streaming, ...thinking];
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(20, width - 2);
		const border = (text: string) => th.fg("border", text);
		const row = (content: string) => {
			const clipped = truncateToWidth(content, inner);
			return `${border("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border("│")}`;
		};
		const run = this.run;
		const now = Date.now();
		const elapsed = formatDuration((run.endedAt ?? now) - run.runStartedAt);
		const header1 = ` ${statusIcon(run.status, th, now)} ${th.bold(run.name)} ${th.fg("muted", `(${run.type})`)} ${th.fg("text", run.description)}`;
		const header2 = th.fg("dim", ` ${statusWord(run.status)} · ${run.spec.model}${run.spec.thinking ? `:${run.spec.thinking}` : ""} · ctx ${formatTokens(run.contextTokens)}/${formatTokens(run.spec.contextBudget)} · ${formatTokens(run.outputTokens)} out · $${run.cost.toFixed(2)} · ${run.toolUses} tools · ${elapsed}${run.spec.worktree ? ` · ${run.spec.worktree.path}` : run.spec.cwd ? ` · ${run.spec.cwd}` : ""}`);
		const height = this.viewportHeight();
		const body = this.bodyLines(inner - 1);
		const maxScroll = Math.max(0, body.length - height);
		this.scroll = Math.min(this.scroll, maxScroll);
		const end = body.length - this.scroll;
		const visible = body.slice(Math.max(0, end - height), end);
		while (visible.length < height) visible.push("");
		const action = run.status === "running" ? "enter steer" : run.status === "queued" ? "enter add to task" : "enter follow up";
		const footer = th.fg("dim", ` ${action} · ↑↓ pgup/pgdn scroll${this.scroll ? ` (${this.scroll} up)` : ""} · ctrl+x stop · esc close${this.status ? ` · ${this.status}` : ""}`);
		const inputLine = this.input.render(inner)[0] ?? "";
		return [
			border(`╭${"─".repeat(inner)}╮`),
			row(header1),
			row(header2),
			border(`├${"─".repeat(inner)}┤`),
			...visible.map((line) => row(line)),
			border(`├${"─".repeat(inner)}┤`),
			row(inputLine),
			row(footer),
			border(`╰${"─".repeat(inner)}╯`),
		];
	}
}
