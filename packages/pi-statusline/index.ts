import { homedir } from "node:os";
import { basename } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import {
	CacheCelebrationController,
	type CacheCelebrationSnapshot,
	triggerCacheCelebrationForMessage,
} from "./cache-celebration.ts";
import { CelebrationPreview, trackSelectedLabel } from "./celebration-preview.ts";
import { DEFAULT_CELEBRATION_STYLE, renderCacheBadge } from "./celebration-styles.ts";
import { FullRedrawScheduler } from "./redraw.ts";
import {
	applySettingChange,
	buildSettingItems,
	CACHE_CELEBRATION_LABEL,
	createAliasSubmenu,
	createWorktreeRootSubmenu,
} from "./settings-menu.ts";
import {
	changedSettingKeys,
	defaultSettings,
	repoAlias,
	SettingsStore,
	type StatuslineSettings,
} from "./settings.ts";
import { resolvePalette, type StatuslinePalette, STATUSLINE_THEMES } from "./themes.ts";
import { type UsageSnapshot, usageBand, UsageTracker } from "./usage.ts";
import {
	type GitRepositoryStatus,
	readGitStatus,
	type SessionWorktree,
	SessionWorktreeTracker,
} from "./worktrees.ts";

export interface StatuslineData {
	model: string;
	/** Provider id of the active model; absent when there is no model. */
	provider?: string;
	cwd: string;
	cwdGit: GitRepositoryStatus | null;
	contextTokens: number | null;
	contextWindow: number;
	worktrees: SessionWorktree[];
	sessionId: string;
	cacheCelebration?: CacheCelebrationSnapshot;
	usage?: UsageSnapshot;
}

const RESET = "\x1b[0m";
const DEFAULT_PALETTE = STATUSLINE_THEMES.default;

function styled(style: string, text: string): string {
	return `${style}${text}${RESET}`;
}

const CLAUDE_ICON = "\uec82";
const OPENAI_ICON = "\uec81";

function bandColor(remaining: number, palette: StatuslinePalette): string {
	return { green: palette.ok, yellow: palette.warn, orange: palette.caution, red: palette.danger }[
		usageBand(remaining)
	];
}

export function renderUsageSegment(
	usage: UsageSnapshot,
	palette: StatuslinePalette = DEFAULT_PALETTE,
): string | undefined {
	const percent = (remaining: number) => styled(bandColor(remaining, palette), `${remaining}`);
	const dot = styled(palette.dim, "\u00b7");
	const parts: string[] = [];
	if (usage.claude) {
		let claude = `${percent(usage.claude.fiveHour)}${dot}${percent(usage.claude.sevenDay)}`;
		if (usage.claude.scopedWeekly !== undefined) claude += `${dot}${percent(usage.claude.scopedWeekly)}`;
		parts.push(`${styled(palette.text, CLAUDE_ICON)} ${claude}`);
	}
	if (usage.codex) {
		// Shortest window first, mirroring Claude. Plans without a 5-hour limit
		// leave that slot empty and keep rendering the single long-window number.
		const codex = [usage.codex.fiveHour, usage.codex.weekly]
			.filter((remaining): remaining is number => remaining !== undefined)
			.map(percent)
			.join(dot);
		if (codex.length > 0) parts.push(`${styled(palette.text, OPENAI_ICON)} ${codex}`);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function contextColor(contextTokens: number, contextWindow: number, palette: StatuslinePalette): string {
	const percent = contextWindow > 0 ? Math.floor((contextTokens * 100) / contextWindow) : 0;
	if (percent >= 90) return palette.danger;
	if (percent >= 70) return palette.warn;
	if (percent >= 50) return palette.caution;
	return palette.ok;
}

export function formatTokenCount(tokens: number): string {
	const safeTokens = Math.max(0, Math.round(tokens));
	if (safeTokens >= 1_000_000) return `${(safeTokens / 1_000_000).toFixed(1)}m`;
	if (safeTokens >= 1_000) {
		const thousands = safeTokens / 1_000;
		return `${thousands < 10 && !Number.isInteger(thousands) ? thousands.toFixed(1) : Math.round(thousands)}k`;
	}
	return `${safeTokens}`;
}

function renderRepository(
	name: string,
	status: GitRepositoryStatus,
	palette: StatuslinePalette,
	nameColor = palette.path,
): string {
	let part = styled(nameColor, name);
	part += styled(palette.dim, ":");
	part += styled(palette.branch, status.branch);
	if (status.dirty) part += styled(palette.warn, "*");
	if (status.behind > 0) part += ` ${styled(palette.caution, `⇣${status.behind}`)}`;
	return part;
}

function renderCacheCelebrationLine(
	summary: string,
	celebration: CacheCelebrationSnapshot,
	palette: StatuslinePalette = DEFAULT_PALETTE,
	style: string = DEFAULT_CELEBRATION_STYLE,
): string {
	const badge = renderCacheBadge(celebration.percent, celebration.frame, style, palette);
	return `${summary}${styled(palette.dim, " | ")}${badge}`;
}

function renderWorktreeLine(
	worktrees: SessionWorktree[],
	settings: StatuslineSettings,
	palette: StatuslinePalette,
): string {
	const separator = styled(palette.dim, " | ");
	const parts = worktrees.map((worktree) => {
		let part = renderRepository(repoAlias(worktree.repo, settings.repoAliases), worktree, palette);
		if (worktree.pr !== undefined) {
			const state = worktree.prState?.toUpperCase();
			const color =
				state === "OPEN"
					? palette.ok
					: state === "MERGED"
						? palette.accent
						: state === "CLOSED"
							? palette.danger
							: palette.dim;
			part += ` ${styled(color, `#${worktree.pr}`)}`;
		}
		return part;
	});
	return `${styled(palette.dim, "⑂")} ${parts.join(separator)}`;
}

/** Home-independent defaults; only `worktreeRoot` varies by host and rendering never reads it. */
const RENDER_DEFAULTS = defaultSettings("");

export function renderStatusline(
	data: StatuslineData,
	width: number,
	settings: StatuslineSettings = RENDER_DEFAULTS,
): string[] {
	const palette = resolvePalette(settings.theme);
	const separator = styled(palette.dim, " | ");
	const used =
		data.contextTokens === null
			? styled(palette.dim, "?")
			: styled(
					contextColor(data.contextTokens, data.contextWindow, palette),
					formatTokenCount(data.contextTokens),
				);
	const usageSegment = settings.showUsage && data.usage ? renderUsageSegment(data.usage, palette) : undefined;
	const segments = [
		settings.showModel ? styled(palette.model, data.model) : undefined,
		// No provider is a missing segment, not a placeholder: the model id already
		// says "no-model" in that state, and a second one would only add noise.
		settings.showProvider && data.provider ? styled(palette.provider, data.provider) : undefined,
		settings.showDirectory
			? data.cwdGit
				? renderRepository(data.cwd, data.cwdGit, palette)
				: styled(palette.branch, data.cwd)
			: undefined,
		settings.showContext
			? `${used}${styled(palette.dim, "/")}${styled(palette.text, formatTokenCount(data.contextWindow))}`
			: undefined,
		usageSegment,
	].filter((segment): segment is string => segment !== undefined);

	const showWorktreeLine = settings.showWorktrees && data.worktrees.length > 0;
	const lineCount = (segments.length > 0 ? 1 : 0) + (showWorktreeLine ? 1 : 0) + (settings.showSessionId ? 1 : 0);
	// A footer that renders nothing would collapse the block; keep one stable row.
	if (lineCount === 0) return [""];
	if (width <= 0) return Array.from({ length: lineCount }, () => "");

	const lines: string[] = [];
	if (segments.length > 0) {
		const summary = segments.join(separator);
		// A badge-only first line is separator soup, so the celebration needs a summary.
		const celebration = settings.showCacheCelebration ? data.cacheCelebration : undefined;
		lines.push(
			truncateToWidth(
				celebration
					? renderCacheCelebrationLine(summary, celebration, palette, settings.cacheCelebrationStyle)
					: summary,
				width,
			),
		);
	}
	if (showWorktreeLine) {
		lines.push(truncateToWidth(renderWorktreeLine(data.worktrees, settings, palette), width, "…"));
	}
	if (settings.showSessionId) lines.push(truncateToWidth(styled(palette.dim, data.sessionId), width));
	return lines;
}

export default function statuslineExtension(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;
	const celebrationPreview = new CelebrationPreview(() => requestRender?.());
	const fullRedraw = new FullRedrawScheduler();
	const cacheCelebration = new CacheCelebrationController(() => requestRender?.());
	let tracker: SessionWorktreeTracker | undefined;
	const usageTracker = new UsageTracker({ onChange: () => requestRender?.() });
	let cwdGit: GitRepositoryStatus | null = null;
	let cwdStatusAbort: AbortController | undefined;
	let cwdStatusInFlight: Promise<void> | undefined;
	const home = homedir();
	const settingsStore = new SettingsStore({ home });
	let settings = settingsStore.get();

	const runInBackground = (operation: Promise<void>): void => {
		operation.catch(() => {
			// Statusline enrichment is best-effort and must never interrupt the agent.
		});
	};

	const refreshCwdStatus = (ctx: ExtensionContext): Promise<void> => {
		if (!cwdStatusAbort) return Promise.resolve();
		if (cwdStatusInFlight) return cwdStatusInFlight.then(() => refreshCwdStatus(ctx));
		const controller = cwdStatusAbort;
		const refresh = (async () => {
			const next = (await readGitStatus(
				(command, args, options) => pi.exec(command, args, options),
				ctx.cwd,
				controller.signal,
			)) ?? null;
			if (controller.signal.aborted || cwdStatusAbort !== controller) return;
			if (
				cwdGit?.branch === next?.branch &&
				cwdGit?.dirty === next?.dirty &&
				cwdGit?.behind === next?.behind
			) {
				return;
			}
			cwdGit = next;
			requestRender?.();
		})().finally(() => {
			if (cwdStatusInFlight === refresh) cwdStatusInFlight = undefined;
		});
		cwdStatusInFlight = refresh;
		return refresh;
	};

	const resetTracker = (ctx: ExtensionContext): void => {
		tracker?.dispose();
		tracker = undefined;
		cwdStatusAbort?.abort();
		cwdGit = null;
		cwdStatusAbort = new AbortController();
		cwdStatusInFlight = undefined;
		runInBackground(refreshCwdStatus(ctx));
		if (settings.showUsage) {
			usageTracker.setActiveProvider(ctx.model?.provider);
			runInBackground(usageTracker.refresh());
		}
		// A hidden worktree line must not pay for git/gh polling.
		if (!settings.showWorktrees) return;
		const next = new SessionWorktreeTracker({
			exec: (command, args, options) => pi.exec(command, args, options),
			worktreeRoot: settings.worktreeRoot,
			home,
			onChange: () => requestRender?.(),
		});
		tracker = next;
		runInBackground(next.seedFromEntries(ctx.sessionManager.getBranch()));
		runInBackground(next.includeCurrentWorktree(ctx.cwd));
	};

	/** Adopt a new settings snapshot: apply it live, then persist in the background. */
	const applySettings = (ctx: ExtensionContext, next: StatuslineSettings, persist = true): void => {
		const previous = settings;
		settings = next;
		settingsStore.set(next);

		if (!next.showWorktrees) {
			tracker?.dispose();
			tracker = undefined;
		} else if (!previous.showWorktrees || !tracker || previous.worktreeRoot !== next.worktreeRoot) {
			resetTracker(ctx);
		}
		if (next.showUsage && !previous.showUsage) {
			runInBackground(usageTracker.refresh());
			usageTracker.start();
		} else if (!next.showUsage && previous.showUsage) {
			// A hidden meter must not keep polling, matching the worktree line above.
			usageTracker.stop();
		}
		if (!next.showCacheCelebration) cacheCelebration.dispose();
		// Dropping a row leaves a stale one behind in fullscreen mode.
		if (previous.showSessionId !== next.showSessionId || previous.showWorktrees !== next.showWorktrees) {
			fullRedraw.request();
		}
		requestRender?.();

		if (!persist) return;
		const changed = changedSettingKeys(previous, next);
		if (changed.length === 0) return;
		settingsStore.save(next, changed).catch((error: unknown) => {
			ctx.ui.notify(
				`Could not save statusline settings: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	};

	pi.registerCommand("statusline", {
		description: "Configure the statusline",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/statusline requires interactive TUI mode", "warning");
				return;
			}

			// Settings load once per session; refresh before editing so the menu
			// starts from what is on disk rather than a snapshot that may be hours
			// old and missing another session's changes.
			applySettings(ctx, await settingsStore.load(), false);

			await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
				const tracked = trackSelectedLabel(getSettingsListTheme());
				const settingsTheme = tracked.theme;
				const submenuHost = {
					getSettings: () => settings,
					commit: (next: StatuslineSettings) => applySettings(ctx, next),
					notify: (message: string) => ctx.ui.notify(message, "warning"),
					requestRender: () => tui.requestRender(),
					settingsTheme,
					selectTheme: getSelectListTheme(),
					home,
				};
				const list = new SettingsList(
					buildSettingItems(
						settings,
						{
							worktreeRoot: createWorktreeRootSubmenu(submenuHost),
							repoAliases: createAliasSubmenu(submenuHost),
						},
						home,
					),
					10,
					settingsTheme,
					(id, value) => {
						const change = applySettingChange(settings, id, value, home);
						if (change.kind === "error") ctx.ui.notify(change.message, "warning");
						else if (change.kind === "settings") applySettings(ctx, change.settings);
						tui.requestRender();
					},
					() => done(undefined),
					{ enableSearch: true },
				);

				// The preview animates the real footer, so it only needs to wrap the
				// list's render to learn which row currently has focus.
				return {
					dispose(): void {
						// Clear the fake badge from the footer the menu was drawn over.
						celebrationPreview.dispose();
						requestRender?.();
					},
					invalidate(): void {
						list.invalidate();
					},
					handleInput(data: string): void {
						list.handleInput(data);
					},
					render(width: number): string[] {
						tracked.begin();
						const lines = list.render(width);
						celebrationPreview.setActive(tracked.selected() === CACHE_CELEBRATION_LABEL);
						return lines;
					},
				};
			});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		cacheCelebration.dispose();
		if (ctx.mode !== "tui") return;

		// setFooter is synchronous, so the first frames render with defaults.
		runInBackground(settingsStore.load().then((loaded) => applySettings(ctx, loaded, false)));

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			// Fullscreen mode never repaints unchanged rows; the session id line is
			// static, so it needs periodic forced redraws to shed stale cells.
			fullRedraw.attach(tui);
			// The meters are wall-clock quantities, not per-turn ones: an idle session
			// still needs them to move, and a sibling process's poll is worth adopting
			// before the next turn ends.
			if (settings.showUsage) usageTracker.start();
			const stopBranchUpdates = footerData.onBranchChange(() => {
				runInBackground(refreshCwdStatus(ctx));
				tui.requestRender();
			});

			return {
				dispose(): void {
					stopBranchUpdates();
					cacheCelebration.dispose();
					celebrationPreview.dispose();
					fullRedraw.detach();
					usageTracker.stop();
					requestRender = undefined;
				},
				invalidate(): void {},
				render(width: number): string[] {
					const usage = ctx.getContextUsage();
					const cwd = basename(ctx.cwd) || ctx.cwd;
					const model = ctx.model?.id.split("/").pop() || "no-model";

					return fullRedraw.decorate(
						renderStatusline(
							{
								model,
								provider: ctx.model?.provider,
								cwd,
								cwdGit,
								contextTokens: usage?.tokens ?? null,
								contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
								worktrees: tracker?.getWorktrees() ?? [],
								sessionId: ctx.sessionManager.getSessionId(),
								cacheCelebration: celebrationPreview.snapshot() ?? cacheCelebration.snapshot(),
								usage: usageTracker.snapshot(),
							},
							width,
							settings,
						),
					);
				},
			};
		});

		resetTracker(ctx);
	});

	pi.on("tool_call", (event) => {
		if (tracker) runInBackground(tracker.observeToolInput(event.toolName, event.input));
	});
	pi.on("turn_end", (event, ctx) => {
		if (requestRender && settings.showCacheCelebration) {
			triggerCacheCelebrationForMessage(event.message, cacheCelebration);
		}
		fullRedraw.request();
		requestRender?.();
		runInBackground(refreshCwdStatus(ctx));
		if (tracker) runInBackground(tracker.refresh());
		if (settings.showUsage) {
			usageTracker.setActiveProvider(ctx.model?.provider);
			runInBackground(usageTracker.refresh());
		}
	});
	// The meters follow the main model's account, so a switch between two logins
	// of the same provider family has to re-point the tracker before it repaints.
	pi.on("model_select", (event) => {
		if (settings.showUsage) {
			usageTracker.setActiveProvider(event.model.provider);
			runInBackground(usageTracker.refresh());
		}
		requestRender?.();
	});
	pi.on("session_tree", (_event, ctx) => resetTracker(ctx));
	pi.on("session_shutdown", () => {
		cacheCelebration.dispose();
		fullRedraw.detach();
		usageTracker.stop();
		tracker?.dispose();
		tracker = undefined;
		cwdStatusAbort?.abort();
		cwdStatusAbort = undefined;
		cwdStatusInFlight = undefined;
		cwdGit = null;
	});
}
