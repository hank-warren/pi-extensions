/**
 * The loop widget: one themed line above the editor, with the loop's focus
 * dimmed below it when set.
 *
 * Two rules shape what goes on that line.
 *
 * **Show progress, not consumption.** The line used to lead with the interval
 * and then report turns against the turn cap. The interval is a fallback
 * heartbeat — a settle-paced loop can run its whole life without delivering
 * one — and turns-against-cap is budget burn, which says nothing about how
 * much of the objective is done. Criteria met over criteria total is the
 * progress number, and it leads.
 *
 * **One surface, one story.** The widget and the footer status render the same
 * state, so they render it from the same function. They disagreed before:
 * `setStatus` handled `loop.waiting` and the widget did not, so a loop blocked
 * on CI showed an ordinary "next 17:53" above the editor while the footer said
 * it was waiting.
 *
 * States are ordered by how much they want a human, because the top of that
 * order is the whole reason to glance at the line: paused and blocked and
 * expiring come before the ordinary running line.
 *
 * The glyph vocabulary is shared with pi-plan-mode by convention, not by
 * import — `◆` planning or ready, `▶` implementing, `⟳` running, `⏸` paused,
 * `⏳` waiting, `⚠` attention. Six characters are not worth a package; a user
 * reading a footer is worth the consistency.
 *
 * Presentation only: every entry point tolerates a host without setWidget
 * (test fixtures, print mode) and swallows render-side failures, because a
 * widget must never interrupt loop state transitions.
 */

import { Text } from "@earendil-works/pi-tui";
import { formatClock, formatElapsed } from "./interval.js";
import type { LoopState } from "./state.js";

export const LOOP_WIDGET_KEY = "loop";

interface WidgetTheme {
	bold?: (text: string) => string;
	fg?: (color: string, text: string) => string;
}

type WidgetHost = { setWidget?: unknown };

/** Criteria progress, absent when the loop has no readable ledger. */
interface CriteriaProgress {
	met: number;
	total: number;
}

/** The loop is being drafted with the user and has not started. */
interface LoopPlanningView {
	kind: "planning";
	/** Criteria in the proposed draft, once one has been put up for approval. */
	proposedCriteria?: number;
}

export interface LoopRunningView {
	kind: "loop";
	loop: LoopState;
	/** A wake is held for the next idle boundary. */
	wakePending: boolean;
	/** Epoch ms of the next scheduled tick, when armed. */
	nextWakeAt: number | undefined;
	criteria?: CriteriaProgress;
	/**
	 * How long the session has been busy with no completed turn. Set only past
	 * the stall threshold, where a blocking prompt is the likely explanation.
	 */
	blockedForMs?: number;
	/** Injected so the elapsed span is deterministic in tests. */
	now?: number;
}

export type LoopWidgetView = LoopPlanningView | LoopRunningView;

/** How urgently a line wants a human; picks the colour. */
type Tone = "normal" | "attention" | "planning";

export function updateLoopWidget(ui: WidgetHost, view: LoopWidgetView | undefined) {
	const setWidget = resolveSetWidget(ui);
	if (!setWidget) return;
	try {
		if (!view || (view.kind === "loop" && view.loop.status === "stopped")) {
			setWidget(LOOP_WIDGET_KEY, undefined);
			return;
		}
		setWidget(LOOP_WIDGET_KEY, (_tui: unknown, theme: WidgetTheme) => {
			const bold = theme.bold ?? identity;
			const paint = (tone: Tone, text: string) => {
				if (tone === "normal") return text;
				return theme.fg?.(tone === "attention" ? "warning" : "accent", text) ?? text;
			};
			const dim = (text: string) => theme.fg?.("dim", text) ?? text;
			const focus =
				view.kind === "loop" && view.loop.prompt
					? `\n${dim(`  focus: ${view.loop.prompt}`)}`
					: "";
			return new Text(`${paint(widgetTone(view), bold(loopWidgetLine(view)))}${focus}`);
		});
	} catch {
		// Presentation only; a widget failure must never break a loop transition.
	}
}

export function clearLoopWidget(ui: WidgetHost) {
	const setWidget = resolveSetWidget(ui);
	if (!setWidget) return;
	try {
		setWidget(LOOP_WIDGET_KEY, undefined);
	} catch {
		// Presentation only.
	}
}

/** Exported for tests: the tone the line renders in. */
export function widgetTone(view: LoopWidgetView): Tone {
	if (view.kind === "planning") return "planning";
	const loop = view.loop;
	if (loop.status === "paused" || loop.expiring || view.blockedForMs !== undefined) {
		return "attention";
	}
	return "normal";
}

export function loopWidgetLine(view: LoopWidgetView): string {
	if (view.kind === "planning") {
		if (view.proposedCriteria === undefined) return "◆ loop · drafting objective";
		return `◆ loop · ${view.proposedCriteria} ${view.proposedCriteria === 1 ? "criterion" : "criteria"} proposed · approve to start`;
	}
	const loop = view.loop;

	// Ordered by how much the state wants a human. A paused or blocked loop is
	// not making progress, so reporting progress numbers first would bury the
	// only fact that matters.
	if (loop.status === "paused") {
		return `⏸ loop paused${loop.pauseCause ? ` · ${loop.pauseCause}` : ""}`;
	}
	if (loop.expiring) return "⚠ loop expiring · write your state into the ledger";
	if (view.blockedForMs !== undefined) {
		// The engine cannot see the prompt itself: it only knows the session has
		// been busy without completing a turn, which a blocking prompt explains
		// and ordinary long work also explains. Say which one is being reported.
		return `⚠ loop blocked · no turn for ${formatElapsed(view.blockedForMs)} · a prompt may be waiting`;
	}
	if (loop.waiting) {
		const until =
			loop.waiting.resumeAt === undefined
				? "no deadline"
				: `until ${formatClock(loop.waiting.resumeAt)}`;
		return `⏳ loop waiting · ${loop.waiting.reason} · ${until}`;
	}

	const cap = loop.maxTurns === null ? "∞" : `${loop.maxTurns}`;
	const next = view.wakePending
		? "next on idle"
		: view.nextWakeAt !== undefined
			? `next ${formatClock(view.nextWakeAt)}`
			: "next unscheduled";
	const elapsed = formatElapsed((view.now ?? Date.now()) - loop.startedAt);
	// Progress leads when there is progress to report. Turns are still shown,
	// but as the budget they are, not as the headline.
	const progress = view.criteria ? `${view.criteria.met}/${view.criteria.total} done · ` : "";
	return `⟳ loop ${progress}turn ${loop.automaticTurns}/${cap} · ${elapsed} · ${next}`;
}

function identity(text: string) {
	return text;
}

function resolveSetWidget(ui: WidgetHost) {
	return typeof ui.setWidget === "function"
		? (ui.setWidget as (key: string, content: unknown) => void).bind(ui)
		: undefined;
}
