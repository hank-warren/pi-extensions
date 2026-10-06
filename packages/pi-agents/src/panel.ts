import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, oneLine } from "./format.js";
import type { AgentRun } from "./manager.js";
import { contextLabel, contextShare, shortModel, statusGlyph } from "./render.js";

/** The slice of the manager the panel reads; the manager is replaced per session. */
export interface PanelSource {
	subscribe(listener: () => void): () => void;
	list(): AgentRun[];
	stop(run: AgentRun): Promise<void>;
}

/** One-line summary above the prompt, shown while a batch of agents is listed. */
const STATUS_KEY = "pi-agents";
/** The selector below the prompt, shown only while managing agents. */
const SELECT_KEY = "pi-agents-select";
const MAX_ROWS = 6;
/** A finished batch stays listed this long, so its results can still be opened. */
const LINGER_MS = 60_000;
const TICK_MS = 80;

/** Longest description column; longer ones are cut. */
const DESCRIPTION_WIDTH = 48;

function padTo(text: string, width: number): string {
	const cut = truncateToWidth(text, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

type Widget = { render(width: number): string[]; invalidate(): void; dispose(): void };

/**
 * A one-line summary above the prompt (`✓ Agents | 2/3 completed`) while a
 * batch of agents runs and shortly after. ↓ at an empty prompt opens a
 * selector below the prompt with a row per agent (state, name, task, model,
 * context, time); ↑ off its top row or Esc closes it, so the next ↑ is the
 * editor's history again. Both are render-only widgets; keys arrive through
 * onTerminalInput, which fires before the focused component, and are only
 * taken while Pi's prompt editor has focus.
 *
 * A batch is every agent that ran while another was still running: it fills
 * as agents start, and empties LINGER_MS after the last one finished.
 */
export class AgentPanel {
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private status = false;
	private selector = false;
	private unsubscribeInput: (() => void) | undefined;
	private unsubscribeManager: (() => void) | undefined;
	private timer: NodeJS.Timeout | undefined;
	private timerInterval = 0;
	private active = false;
	private selected = 0;
	private viewing: string | undefined;
	private dismissed = new Set<string>();
	private batch = new Set<string>();

	constructor(
		private readonly manager: PanelSource,
		private readonly open: (run: AgentRun) => Promise<void>,
	) {}

	attach(ui: ExtensionUIContext): void {
		if (ui === this.ui) return;
		this.detach();
		this.ui = ui;
		this.unsubscribeInput = ui.onTerminalInput((data) => this.handleKey(data));
		this.unsubscribeManager = this.manager.subscribe(() => this.update());
		this.update();
	}

	detach(): void {
		this.unsubscribeInput?.();
		this.unsubscribeManager?.();
		this.unsubscribeInput = undefined;
		this.unsubscribeManager = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.ui && this.status) this.ui.setWidget(STATUS_KEY, undefined);
		if (this.ui && this.selector) this.ui.setWidget(SELECT_KEY, undefined);
		this.status = false;
		this.selector = false;
		this.tui = undefined;
		this.ui = undefined;
		this.active = false;
		this.batch.clear();
	}

	rows(now = Date.now()): AgentRun[] {
		const runs = this.manager.list();
		for (const run of runs) if (run.busy) this.batch.add(run.id);
		const members = runs.filter((run) => this.batch.has(run.id) && !this.dismissed.has(run.id));
		const lastEnd = Math.max(0, ...members.map((run) => run.endedAt ?? 0));
		if (members.every((run) => !run.busy) && now - lastEnd >= LINGER_MS) {
			this.batch.clear();
			return runs.filter((run) => run.id === this.viewing);
		}
		return runs.filter((run) => run.id === this.viewing || members.includes(run));
	}

	private widget(draw: (width: number, theme: Theme) => string[], onDispose: () => void) {
		return (tui: TUI, theme: Theme): Widget => {
			this.tui = tui;
			return {
				render: (width: number) => draw(width, theme).map((line) => truncateToWidth(line, width)),
				invalidate: () => {},
				dispose: onDispose,
			};
		};
	}

	update(): void {
		const ui = this.ui;
		if (!ui) return;
		const rows = this.rows();
		if (!rows.length) {
			if (this.status) ui.setWidget(STATUS_KEY, undefined);
			if (this.selector) ui.setWidget(SELECT_KEY, undefined);
			this.status = false;
			this.selector = false;
			this.tui = undefined;
			this.active = false;
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			return;
		}
		this.selected = Math.min(this.selected, rows.length - 1);
		// Spinners tick fast while something runs; lingering finished rows only need a slow expiry clock.
		const interval = rows.some((run) => run.busy) ? TICK_MS : 1000;
		if (this.timer && this.timerInterval !== interval) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (!this.timer) {
			this.timerInterval = interval;
			this.timer = setInterval(() => this.update(), interval);
			this.timer.unref();
		}
		let changed = false;
		if (!this.status) {
			ui.setWidget(STATUS_KEY, this.widget((_width, theme) => this.renderStatus(theme), () => {
				this.status = false;
			}), { placement: "aboveEditor" });
			this.status = true;
			changed = true;
		}
		const managing = this.active && !this.viewing;
		if (managing && !this.selector) {
			ui.setWidget(SELECT_KEY, this.widget((width, theme) => this.renderSelector(width, theme), () => {
				this.selector = false;
			}), { placement: "belowEditor" });
			this.selector = true;
			changed = true;
		} else if (!managing && this.selector) {
			ui.setWidget(SELECT_KEY, undefined);
			this.selector = false;
			changed = true;
		}
		if (!changed) this.tui?.requestRender();
	}

	/** True when Pi's prompt editor owns the keyboard (dialogs and overlays are not Editors). */
	private editorHasFocus(): boolean {
		const focused = (this.tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		return focused == null || focused instanceof Editor;
	}

	handleKey(data: string): { consume?: boolean } | undefined {
		if (!this.ui || isKeyRelease(data) || this.viewing) return undefined;
		if (!this.editorHasFocus()) {
			if (this.active) this.setActive(false);
			return undefined;
		}
		const rows = this.rows();
		if (!this.active) {
			if (matchesKey(data, "down") && rows.length && this.ui.getEditorText() === "") {
				// Straight to the agent waiting on you, if one is.
				this.selected = Math.max(0, rows.findIndex((run) => run.approval));
				this.setActive(true);
				return { consume: true };
			}
			return undefined;
		}
		if (!rows.length) {
			this.setActive(false);
			return undefined;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(rows.length - 1, this.selected + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			// Off the top closes the selector and is consumed: only the next ↑ recalls a prompt.
			if (this.selected === 0) this.setActive(false);
			else {
				this.selected -= 1;
				this.update();
			}
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.setActive(false);
			return { consume: true };
		}
		const run = rows[this.selected];
		if (matchesKey(data, Key.enter)) {
			if (run) this.openRun(run);
			return { consume: true };
		}
		if (data === "x" && run) {
			if (run.busy) void this.manager.stop(run);
			else {
				this.dismissed.add(run.id);
				this.update();
			}
			return { consume: true };
		}
		// Anything else is typing: close the selector and let the key reach the editor.
		this.setActive(false);
		return undefined;
	}

	private setActive(active: boolean): void {
		this.active = active;
		this.update();
	}

	openRun(run: AgentRun): void {
		this.viewing = run.id;
		this.update();
		void this.open(run).finally(() => {
			this.viewing = undefined;
			// Back in the selector on the agent just viewed: ↑/↓ move on, x stops it, typing goes to the prompt.
			const index = this.rows().findIndex((item) => item.id === run.id);
			this.active = index >= 0;
			this.selected = Math.max(0, index);
			this.update();
		});
	}

	/** Rows to show around `focus`, at most MAX_ROWS, with `↑ N more` / `↓ N more` around them. */
	private window(rows: AgentRun[], focus: number): { shown: AgentRun[]; start: number; above: string[]; below: string[] } {
		const visible = Math.min(MAX_ROWS, rows.length);
		const start = Math.min(Math.max(0, focus - visible + 1), rows.length - visible);
		const after = rows.length - start - visible;
		return {
			shown: rows.slice(start, start + visible),
			start,
			above: start > 0 ? [`↑ ${start} more`] : [],
			below: after > 0 ? [`↓ ${after} more`] : [],
		};
	}

	/** `⠹ Agents | 1/3 completed | 1 needs you | ↓ to manage`. */
	private renderStatus(theme: Theme): string[] {
		const now = Date.now();
		const rows = this.rows(now);
		if (!rows.length) return [];
		const finished = rows.filter((run) => !run.busy).length;
		const waiting = rows.filter((run) => run.approval).length;
		const failed = rows.filter((run) => run.status === "failed").length;
		const glyph = waiting
			? theme.fg("warning", "?")
			: finished < rows.length
				? statusGlyph("running", theme, { now })
				: failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const parts = [
			theme.fg("text", theme.bold("Agents")),
			theme.fg("muted", `${finished}/${rows.length} completed`),
			...(waiting ? [theme.fg("warning", `${waiting} needs you`)] : []),
			...(failed ? [theme.fg("error", `${failed} failed`)] : []),
			...(this.active || this.viewing ? [] : [theme.fg("dim", "↓ to manage")]),
		];
		return [` ${glyph} ${parts.join(theme.fg("dim", " | "))}`];
	}

	/**
	 * A drawer under the prompt, closed by a rule above the footer: a `→`
	 * cursor over `⠹ reviewer  review auth changes   claude-opus-5-5 · 41k/1M · 2m10s`,
	 * what each running agent is doing right now under its task, then the keys.
	 */
	private renderSelector(width: number, theme: Theme): string[] {
		const now = Date.now();
		const rows = this.rows(now);
		if (!rows.length) return [];
		const { shown, start, above, below } = this.window(rows, this.selected);
		const nameWidth = Math.min(24, Math.max(...shown.map((run) => visibleWidth(run.name))));
		const descriptionWidth = Math.min(DESCRIPTION_WIDTH, Math.max(...shown.map((run) => visibleWidth(oneLine(run.description, 100)))));
		const lines = above.map((text) => theme.fg("dim", `  ${text}`));
		shown.forEach((run, offset) => {
			const current = start + offset === this.selected;
			const glyph = statusGlyph(run.status, theme, { now, approval: Boolean(run.approval) });
			const name = current ? theme.fg("accent", theme.bold(padTo(run.name, nameWidth))) : theme.fg("text", padTo(run.name, nameWidth));
			const share = contextShare(run.contextTokens, run.spec.contextBudget, run.spec.contextWindow) ?? 0;
			const context = contextLabel(run.contextTokens, run.spec.contextBudget, run.spec.contextWindow);
			const stats = [
				...(run.approval ? [theme.fg("warning", "needs you")] : run.status === "queued" ? [theme.fg("muted", "queued")] : []),
				theme.fg("dim", shortModel(run.spec.model)),
				share >= 0.75 ? theme.fg("warning", context) : theme.fg("dim", context),
				theme.fg("dim", formatDuration((run.endedAt ?? now) - run.runStartedAt)),
			].join(theme.fg("dim", " · "));
			const prefix = `${current ? theme.fg("accent", "→") : " "} ${glyph} ${name}  `;
			const room = width - visibleWidth(prefix) - 2 - visibleWidth(stats);
			const description = padTo(oneLine(run.description, 100), Math.max(0, Math.min(descriptionWidth, room)));
			lines.push(`${prefix}${theme.fg(current ? "text" : "muted", description)}  ${stats}`);
			if (run.busy) lines.push(`${" ".repeat(visibleWidth(prefix))}${this.activity(run, theme)}`);
		});
		lines.push(...below.map((text) => theme.fg("dim", `  ${text}`)));
		const key = (k: string, text: string) => `${theme.fg("dim", k)} ${theme.fg("muted", text)}`;
		const run = rows[this.selected];
		lines.push(`  ${[
			key("↑↓", "select"),
			key("enter", "open"),
			...(run ? [key("x", run.busy ? "stop" : "dismiss")] : []),
			key("esc", "back"),
		].join(theme.fg("dim", " · "))}`, theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
		return lines;
	}

	/** The tool call it is running (`$ rg -n foo`), else `writing…`, `thinking…`, or why it waits. */
	private activity(run: AgentRun, theme: Theme): string {
		if (run.approval) return theme.fg("warning", `waiting for your approval: ${oneLine(run.approval, 120)}`);
		if (run.status === "queued") return theme.fg("dim", "waiting for a free slot");
		const last = run.toolLog.at(-1);
		if (run.runningTools.size && last) return theme.fg("dim", oneLine(last.rest ? `${last.head} ${last.rest}` : last.head, 120));
		return theme.fg("dim", run.streaming ? "writing…" : "thinking…");
	}
}
