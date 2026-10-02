import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./format.js";
import type { AgentRun } from "./manager.js";

/** The slice of the manager the panel reads; the manager is replaced per session. */
export interface PanelSource {
	subscribe(listener: () => void): () => void;
	list(): AgentRun[];
	stop(run: AgentRun): Promise<void>;
}
import { contextLabel, contextShare, shortModel, statusIcon } from "./render.js";

const WIDGET_KEY = "pi-agents";
const MAX_ROWS = 6;
/** Finished rows stay this long so the result can still be opened from the list. */
const LINGER_MS = 60_000;
const TICK_MS = 120;

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const leftClamped = truncateToWidth(left, Math.max(0, width - rightWidth - 2));
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

/**
 * The Claude Code-style agent list below the editor. Render-only widget; all
 * keys arrive through onTerminalInput, which fires before the focused
 * component, and are only taken while the prompt editor itself has focus.
 */
export class AgentPanel {
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private unsubscribeInput: (() => void) | undefined;
	private unsubscribeManager: (() => void) | undefined;
	private timer: NodeJS.Timeout | undefined;
	private timerInterval = 0;
	private active = false;
	private selected = 0;
	private viewing: string | undefined;
	private dismissed = new Set<string>();

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
		if (this.ui && this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.ui = undefined;
		this.active = false;
	}

	rows(now = Date.now()): AgentRun[] {
		return this.manager.list().filter((run) =>
			!this.dismissed.has(run.id) && (
				run.busy
				|| run.id === this.viewing
				|| (run.endedAt !== undefined && now - run.endedAt < LINGER_MS && run.items.length > 0)
			));
	}

	update(): void {
		if (!this.ui) return;
		const rows = this.rows();
		if (!rows.length) {
			if (this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
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
		if (!this.registered) {
			this.ui.setWidget(WIDGET_KEY, (tui: TUI, theme: Theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					invalidate: () => {},
					dispose: () => {
						this.registered = false;
						this.tui = undefined;
					},
				};
			}, { placement: "belowEditor" });
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
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
				this.selected = 0;
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
		if (matchesKey(data, Key.enter)) {
			const run = rows[this.selected];
			if (run) this.openRun(run);
			return { consume: true };
		}
		if (data === "x") {
			const run = rows[this.selected];
			if (run?.busy) void this.manager.stop(run);
			else if (run) {
				this.dismissed.add(run.id);
				this.update();
			}
			return { consume: true };
		}
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
			const index = this.rows().findIndex((item) => item.id === run.id);
			if (index >= 0) this.selected = index;
			this.update();
		});
	}

	private render(width: number, theme: Theme): string[] {
		const now = Date.now();
		const rows = this.rows(now);
		if (!rows.length) return [];
		const lines: string[] = [];
		const running = rows.filter((run) => run.busy).length;
		const hint = this.active
			? "↑↓ select · enter open · x stop/dismiss · esc back"
			: `${running ? `${running} agent${running === 1 ? "" : "s"} running · ` : ""}↓ to manage`;
		lines.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width));
		const visible = Math.min(MAX_ROWS, rows.length);
		const start = Math.min(Math.max(0, this.selected - visible + 1), rows.length - visible);
		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let index = start; index < start + visible; index++) {
			lines.push(this.renderRow(rows[index]!, index === this.selected && this.active, width, theme, now));
		}
		const below = rows.length - start - visible;
		if (below > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${below} more`), width));
		return lines;
	}

	private renderRow(run: AgentRun, selected: boolean, width: number, theme: Theme, now: number): string {
		const marker = selected ? theme.fg("accent", "›") : " ";
		const name = selected ? theme.bold(run.name) : theme.fg("text", run.name);
		const description = theme.fg(selected ? "text" : "muted", run.description);
		const left = `  ${marker} ${statusIcon(run.status, theme, now)} ${name}  ${description}`;
		const parts: string[] = [];
		if (run.approval) parts.push(theme.fg("warning", "needs approval"));
		else if (run.status === "queued") parts.push("queued");
		parts.push(shortModel(run.spec.model));
		const context = `ctx ${contextLabel(run.contextTokens, run.spec.contextBudget, run.spec.contextWindow)}`;
		parts.push((contextShare(run.contextTokens, run.spec.contextBudget, run.spec.contextWindow) ?? 0) >= 0.75 ? theme.fg("warning", context) : context);
		parts.push(`${run.toolUses} tools`);
		parts.push(formatDuration((run.endedAt ?? now) - run.runStartedAt));
		const right = parts.map((part) => (part.includes("\x1b") ? part : theme.fg(selected ? "text" : "dim", part))).join(theme.fg("dim", " · "));
		return rightAlign(left, right, width);
	}
}
