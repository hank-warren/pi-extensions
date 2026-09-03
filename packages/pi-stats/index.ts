import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isExternalSessionDirectory, scanStats } from "./cache.ts";
import { buildSnapshot, makeIndex, toolCallsFromEntries, usageFromEntries } from "./stats.ts";
import type { SessionRecord, StatsIndex, StatsRange } from "./types.ts";
import { StatsWidget } from "./widget.ts";

/** Exported for tests: the rebuild must keep sidecar usage, which no session record carries. */
export function includeInMemorySession(index: StatsIndex, ctx: ExtensionCommandContext): StatsIndex {
	const sessionId = ctx.sessionManager.getSessionId();
	if (index.sessions.some((session) => session.sessionId === sessionId)) return index;
	const entries = ctx.sessionManager.getEntries();
	const header = ctx.sessionManager.getHeader();
	const createdAt = header?.timestamp ? Date.parse(header.timestamp) : Date.now();
	const usage = usageFromEntries(
		sessionId,
		entries,
		Number.isFinite(createdAt) ? createdAt : Date.now(),
		ctx.sessionManager.getSessionFile() ?? "current-session.jsonl",
	);
	const session: SessionRecord = {
		path: ctx.sessionManager.getSessionFile() ?? `in-memory:${sessionId}`,
		sessionId,
		cwd: ctx.cwd,
		createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
		lastActivityAt: usage.reduce((latest, record) => Math.max(latest, record.timestamp), Number.isFinite(createdAt) ? createdAt : 0),
		source: "main",
		usage,
		toolCalls: toolCallsFromEntries(sessionId, entries, Number.isFinite(createdAt) ? createdAt : Date.now()),
	};
	return makeIndex([...index.sessions, session], index.diagnostics, index.usage.filter((record) => record.kind === "sidecar"));
}

/**
 * Map tool name to the package that registered it, for the Tools tab source column.
 * Only currently-installed tools are known; historical tools from removed extensions stay unlabelled.
 */
function toolSourceMap(pi: ExtensionAPI): Map<string, string> {
	const sources = new Map<string, string>();
	try {
		for (const tool of pi.getAllTools()) {
			const source = tool.sourceInfo?.source;
			if (typeof tool.name === "string" && typeof source === "string" && source.length > 0) {
				sources.set(tool.name, source);
			}
		}
	} catch {
		// An older host without getAllTools() simply renders no source column values.
	}
	return sources;
}

export default function statsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("stats", {
		description: "Open all-time Pi token statistics",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/stats requires interactive TUI mode", "warning");
				return;
			}

			const agentDir = getAgentDir();
			const sessionDir = ctx.sessionManager.getSessionDir();
			let controller: AbortController | undefined;
			let currentIndex: StatsIndex | undefined;
			let closed = false;

			const toolSources = toolSourceMap(pi);

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const snapshot = (range: StatsRange) =>
					currentIndex
						? buildSnapshot(
								currentIndex,
								ctx.sessionManager.getEntries(),
								ctx.sessionManager.getSessionId(),
								range,
								Date.now(),
								ctx.sessionManager.getSessionFile() ?? "current-session.jsonl",
								toolSources,
							)
						: undefined;

				const widget = new StatsWidget({
					theme,
					requestRender: () => tui.requestRender(),
					onClose: () => {
						closed = true;
						controller?.abort();
						done(undefined);
					},
					onRefresh: () => void refresh(true),
					onDispose: () => {
						closed = true;
						controller?.abort();
					},
					getSnapshot: snapshot,
				});

				const refresh = async (force: boolean): Promise<void> => {
					controller?.abort();
					const refreshController = new AbortController();
					controller = refreshController;
					widget.setLoading();
					let lastReported = 0;
					try {
						const scanned = await scanStats({
							agentDir,
							...(isExternalSessionDirectory(sessionDir, agentDir) ? { activeSessionDir: sessionDir } : {}),
							force,
							signal: refreshController.signal,
							onProgress: (completed, total) => {
								if (completed === total || completed - lastReported >= 8) {
									lastReported = completed;
									widget.setProgress(completed, total);
								}
							},
						});
						if (closed || refreshController.signal.aborted) return;
						currentIndex = includeInMemorySession(scanned, ctx);
						widget.setReady(snapshot(widget.getRange())!);
					} catch (error) {
						if (closed || refreshController.signal.aborted) return;
						widget.setError(error instanceof Error ? error.message : String(error));
					}
				};

				queueMicrotask(() => void refresh(false));
				return widget;
			});
		},
	});
}
