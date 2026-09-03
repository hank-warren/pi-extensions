import {
	CACHE_CELEBRATION_FRAME_INTERVAL_MS,
	type CacheCelebrationSnapshot,
} from "./cache-celebration.ts";
import type { SettingsListTheme } from "@earendil-works/pi-tui";

/** Percentage shown by the settings-menu preview badge. */
export const PREVIEW_PERCENT = 96;

interface CelebrationPreviewOptions {
	frameIntervalMs?: number;
	schedule?: (callback: () => void, intervalMs: number) => unknown;
	cancel?: (handle: unknown) => void;
}

function defaultSchedule(callback: () => void, intervalMs: number): unknown {
	const timer = setInterval(callback, intervalMs);
	// A settings preview must never keep Pi alive.
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

/**
 * Loops a fake celebration snapshot for the statusline footer while the
 * celebration row is selected in `/statusline`.
 *
 * Unlike CacheCelebrationController this never ends on its own: it runs until
 * the row loses focus or the menu closes.
 */
export class CelebrationPreview {
	private frame = 0;
	private running = false;
	private timerHandle: unknown;
	private readonly frameIntervalMs: number;
	private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
	private readonly cancel: (handle: unknown) => void;

	constructor(
		private readonly requestRender: () => void,
		options: CelebrationPreviewOptions = {},
	) {
		this.frameIntervalMs = options.frameIntervalMs ?? CACHE_CELEBRATION_FRAME_INTERVAL_MS;
		this.schedule = options.schedule ?? defaultSchedule;
		this.cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
	}

	/** Start looping, or keep looping if already started. Idempotent. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.frame = 0;
		this.timerHandle = this.schedule(() => this.tick(), this.frameIntervalMs);
		this.requestRender();
	}

	/** Stop looping and clear the preview. Idempotent; only repaints if it was running. */
	stop(): void {
		if (!this.running) return;
		this.running = false;
		this.clearTimer();
		this.requestRender();
	}

	/** Start or stop to match `active`, repainting only on a real transition. */
	setActive(active: boolean): void {
		if (active) this.start();
		else this.stop();
	}

	isRunning(): boolean {
		return this.running;
	}

	snapshot(): CacheCelebrationSnapshot | undefined {
		return this.running ? { percent: PREVIEW_PERCENT, frame: this.frame } : undefined;
	}

	dispose(): void {
		this.running = false;
		this.clearTimer();
	}

	private tick(): void {
		if (!this.running) return;
		this.frame += 1;
		this.requestRender();
	}

	private clearTimer(): void {
		if (this.timerHandle !== undefined) this.cancel(this.timerHandle);
		this.timerHandle = undefined;
	}
}

/**
 * Wrap a SettingsList theme so rendering reports which row is highlighted.
 *
 * SettingsList keeps `selectedIndex` private, but it calls `theme.label(text,
 * selected)` for every visible row, so the render pass itself tells us. That
 * keeps working through search filtering and submenus, where index arithmetic
 * on our side would silently drift.
 */
export function trackSelectedLabel(theme: SettingsListTheme): {
	theme: SettingsListTheme;
	/** Reset before a render pass; read the captured label after it. */
	begin(): void;
	selected(): string | undefined;
} {
	let captured: string | undefined;
	return {
		theme: {
			...theme,
			label(text: string, selected: boolean): string {
				if (selected) captured = text.trim();
				return theme.label(text, selected);
			},
		},
		begin(): void {
			captured = undefined;
		},
		selected(): string | undefined {
			return captured;
		},
	};
}
