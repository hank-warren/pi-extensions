/**
 * pi-btw — `/btw <question>` asks a side question without touching the conversation.
 *
 * The question is sent as one extra user message on top of the exact transcript of
 * the session's last model request, so the provider serves the whole conversation
 * from its prompt cache. The answer streams in yellow above the editor, then lands
 * in the transcript as a display-only entry the model never sees. The next real
 * prompt continues from where the conversation was, with its cache intact.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ask, resolveStreamSimple, type StreamSimple } from "./ask.ts";
import { type Prefix, PrefixTracker, sessionPrefix, type TranscriptMessage } from "./prefix.ts";
import { type BtwEntry, ENTRY_TYPE, type LiveState, LiveWidget, renderEntry } from "./render.ts";

const WIDGET = "pi-btw";

export default function btw(pi: ExtensionAPI): void {
	const tracker = new PrefixTracker();
	let active: { controller: AbortController } | undefined;
	// Bumped when the session goes away, so an answer that outlives it is dropped.
	let generation = 0;

	const cancel = () => {
		active?.controller.abort();
		active = undefined;
	};

	// `context_with_system` is pi 0.87+, newer than this repo's pinned typings. A host
	// that never fires it leaves /btw replaying the session branch instead.
	const onUntyped = pi.on.bind(pi) as unknown as (event: string, handler: (event: { messages?: unknown }) => void) => void;
	onUntyped("context_with_system", (event) => {
		if (Array.isArray(event.messages)) tracker.onContext(event.messages as TranscriptMessage[]);
	});
	pi.on("before_provider_request", (event) => {
		tracker.onPayload(event.payload);
	});
	pi.on("message_end", (event) => {
		tracker.onMessageEnd(event.message as unknown as TranscriptMessage);
	});
	// The transcript the next request sends no longer extends the captured one.
	pi.on("session_compact", () => tracker.reset());
	pi.on("session_tree", () => tracker.reset());
	pi.on("session_start", () => {
		generation += 1;
		tracker.reset();
		cancel();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		generation += 1;
		cancel();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => renderEntry(entry.data, theme));

	pi.registerCommand("btw", {
		description: "Ask a side question that reuses the prompt cache and stays out of context (/btw alone cancels one)",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				if (active) cancel();
				else ctx.ui.notify("Usage: /btw <question>", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw needs the interactive terminal.", "error");
				return;
			}
			if (active) {
				ctx.ui.notify("A /btw answer is still streaming. Run /btw alone to cancel it.", "warning");
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("/btw: no model selected.", "error");
				return;
			}
			const streamSimple = resolveStreamSimple(ctx.modelRegistry);
			if (!streamSimple) {
				ctx.ui.notify("/btw needs pi 0.87 or newer.", "error");
				return;
			}
			const prefix = tracker.snapshot() ?? sessionPrefix(ctx.sessionManager);
			// Not awaited: the editor stays free and a running turn keeps streaming meanwhile.
			void run(ctx, { model, streamSimple, prefix, question });
		},
	});

	async function run(
		ctx: ExtensionContext,
		request: { model: { provider: string; id: string }; streamSimple: StreamSimple; prefix: Prefix; question: string },
	): Promise<void> {
		const current = { controller: new AbortController() };
		active = current;
		const startedIn = generation;
		const live: LiveState = { question: request.question, answer: "", thinking: false };
		let tui: TUI | undefined;
		let widget: LiveWidget | undefined;
		ctx.ui.setWidget(WIDGET, (host, theme) => {
			tui = host;
			widget = new LiveWidget(theme, live);
			return widget;
		});

		try {
			const settings = readSettings(pi);
			const answer = await ask({
				...request,
				sessionId: ctx.sessionManager.getSessionId(),
				thinkingLevel: pi.getThinkingLevel(),
				thinkingBudgets: settings.thinkingBudgets,
				blockImages: settings.blockImages,
				signal: current.controller.signal,
				onProgress: (progress) => {
					live.answer = progress.answer;
					live.thinking = progress.thinking;
					widget?.invalidate();
					tui?.requestRender();
				},
			});
			if (startedIn !== generation) return;
			if (answer.stopReason === "aborted" || current.controller.signal.aborted) {
				ctx.ui.notify("/btw cancelled.", "info");
				return;
			}
			if (answer.stopReason === "error") {
				ctx.ui.notify(`/btw failed: ${answer.errorMessage ?? "the provider returned an error"}`, "error");
				return;
			}
			const entry: BtwEntry = {
				question: request.question,
				answer: answer.answer.trim(),
				model: `${request.model.provider}/${request.model.id}`,
				...(answer.toolCalls.length ? { toolCalls: answer.toolCalls } : {}),
				...(answer.stopReason === "length" ? { truncated: true } : {}),
				...(answer.usage ? { usage: answer.usage } : {}),
				durationMs: answer.durationMs,
			};
			pi.appendEntry(ENTRY_TYPE, entry);
		} catch (error) {
			if (startedIn !== generation) return;
			if (current.controller.signal.aborted) ctx.ui.notify("/btw cancelled.", "info");
			else ctx.ui.notify(`/btw failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			if (active === current) active = undefined;
			if (startedIn === generation) ctx.ui.setWidget(WIDGET, undefined);
		}
	}
}

/** Settings the agent loop feeds into its requests; `pi.getSettings` is pi 1.x. */
function readSettings(pi: ExtensionAPI): { thinkingBudgets?: unknown; blockImages?: boolean } {
	try {
		const getSettings = (pi as { getSettings?: () => unknown }).getSettings;
		if (typeof getSettings !== "function") return {};
		const settings = getSettings.call(pi) as { thinkingBudgets?: unknown; images?: { blockImages?: unknown } } | undefined;
		return { thinkingBudgets: settings?.thinkingBudgets, blockImages: settings?.images?.blockImages === true };
	} catch {
		return {};
	}
}
