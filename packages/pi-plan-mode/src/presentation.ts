import { Markdown, Text } from "@earendil-works/pi-tui";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readPlanFile } from "./plan-file.js";
import type { PlanModeState } from "./state.js";

const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
export const PLAN_CARD_ENTRY_TYPE = "plan-mode-card";

type PlanCardData = { title: string; plan: string };

/**
 * Persisted entry data is input, not a guarantee.
 *
 * The renderer runs against whatever is on disk, which may predate a field, be
 * truncated by a partial write, or have been hand-edited. Pi contains a
 * renderer throw as an inline `[plan-mode-card] renderer failed: …` box —
 * survivable, but a needlessly ugly way to say "this card is old".
 */
function planCardData(value: unknown): PlanCardData | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { title, plan } = value as { title?: unknown; plan?: unknown };
	return typeof title === "string" && typeof plan === "string"
		? (value as PlanCardData)
		: undefined;
}

/**
 * The completed-plan card, as a display-only session entry.
 *
 * A custom *entry* rather than a message, which is what buys the property a
 * message could not: Pi maps a `custom` entry to no context messages at all
 * and skips it during compaction, so the plan stays visible and restorable in
 * the transcript while never entering model context and never costing a
 * compaction budget. The model gets a one-line `Plan saved to <path>.` from
 * `plan_mode_complete` instead, and reads the durable file when it implements.
 *
 * pi-loop's approval card is the same mechanism for the same reason
 * (`packages/pi-loop/src/presentation.ts`).
 */
export function registerPlanModeCardRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(PLAN_CARD_ENTRY_TYPE, (entry) => {
		const data = planCardData(entry.data);
		if (!data) return new Text("Plan card unavailable.", 0, 0);
		return new Markdown(
			`**${data.title}**\n\n${data.plan}`,
			0,
			0,
			getMarkdownTheme(),
		);
	});
}

/**
 * The one thing both surfaces render.
 *
 * The footer and the widget say the same thing in two sizes, so they are
 * formatted once. When each formatted its own they drifted — the sibling
 * pi-loop shipped a loop that read as "waiting" in the footer and "running"
 * above the editor for exactly that reason, and this is the same shape of
 * bug waiting to happen with "ready" and "implementing".
 *
 * The glyphs are the family vocabulary shared with pi-loop by convention
 * rather than by import: `◆` planning or ready, `▶` implementing. Six
 * characters do not justify a shared package; a user reading a footer
 * justifies the consistency.
 */
type PlanModePhase = "drafting" | "revising" | "ready" | "implementing";

interface PlanModeView {
	phase: PlanModePhase;
	/** The footer line: plain text with a glyph, no colour. */
	footer: string;
	/** The widget's headline, rendered bold and themed. */
	headline: string;
	/** The dim second line: what to do next. */
	hint: string;
	/** Accent while the plan wants a decision; normal once it is being built. */
	tone: "accent" | "normal";
}

export function planModeView(state: PlanModeState): PlanModeView | undefined {
	if (state.enabled) {
		if (state.awaitingAction) {
			return {
				phase: "ready",
				footer: "◆ plan · ready → /plan",
				headline: "◆ plan · proposed plan ready",
				hint: "/plan to implement, export, or exit — or type feedback to revise.",
				tone: "accent",
			};
		}
		// A stored plan with no pending action means feedback superseded it: the
		// plan on disk is no longer what is being offered, and saying "drafting"
		// would hide that a completed plan is being replaced.
		if (state.planPath) {
			return {
				phase: "revising",
				footer: "◆ plan · revising",
				headline: "◆ plan · revising the proposed plan",
				hint: "The stored plan is superseded until the next plan_mode_complete.",
				tone: "accent",
			};
		}
		return {
			phase: "drafting",
			footer: "◆ plan · drafting",
			headline: "◆ plan · drafting",
			hint: "Explore and ask; finish with plan_mode_complete when decision-ready.",
			tone: "accent",
		};
	}
	if (state.planPath) {
		return {
			phase: "implementing",
			footer: "▶ plan · implementing",
			headline: "▶ plan · implementing",
			hint: "/plan to show, replace, or clear the active plan.",
			tone: "normal",
		};
	}
	return undefined;
}

/**
 * The slice of Pi's theme this widget uses. Structural rather than imported so
 * the renderer keeps working against a host whose theme carries neither
 * helper: both are optional, and an absent one degrades to plain text.
 */
interface WidgetTheme {
	bold?: (text: string) => string;
	fg?: (color: string, text: string) => string;
}

type WidgetFactory = Parameters<ExtensionContext["ui"]["setWidget"]>[1];

export function updatePlanModeUi(ctx: ExtensionContext, state: PlanModeState) {
	const view = planModeView(state);
	ctx.ui.setStatus(STATUS_KEY, view?.footer);
	if (!view) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		return;
	}
	try {
		const render = (_tui: unknown, rawTheme: unknown) => {
			const theme = (rawTheme ?? {}) as WidgetTheme;
			const bold = theme.bold ?? ((text: string) => text);
			const headline =
				view.tone === "accent"
					? (theme.fg?.("accent", bold(view.headline)) ?? bold(view.headline))
					: bold(view.headline);
			const hint = theme.fg?.("dim", `  ${view.hint}`) ?? `  ${view.hint}`;
			return new Text(`${headline}\n${hint}`);
		};
		ctx.ui.setWidget(PLAN_WIDGET_KEY, render as WidgetFactory);
	} catch {
		// Presentation only: a host without the component form of setWidget (or a
		// render failure) must never take Plan mode's state transitions with it.
	}
}

export function clearPlanModeUi(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

/**
 * Always reads the file so a hand-edited plan is what the user sees.
 */
export async function showStoredPlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: PlanModeState,
) {
	const plan = state.planPath ? await readPlanFile(state.planPath) : undefined;
	if (!plan) {
		ctx.ui.notify(
			"No completed plan is available. Use /plan finalize when planning is complete.",
			"info",
		);
		return;
	}
	// enabled without awaitingAction but with a stored plan means revision
	// feedback superseded the completed plan: show it, but never as current.
	const title = state.enabled
		? state.awaitingAction
			? "Proposed Plan"
			: "Superseded Proposed Plan (revision in progress — awaiting a new plan_mode_complete)"
		: "Active Implementation Plan";
	showPlanModePlan(pi, ctx, title, plan);
}

export function showPlanModePlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	plan: string,
) {
	try {
		pi.appendEntry<PlanCardData>(PLAN_CARD_ENTRY_TYPE, { title, plan });
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Unable to show completed plan: ${detail}`, "error");
	}
}

/** The sentence form, for menus, notifications, and non-TUI modes. */
export function planModeStatusText(state: PlanModeState) {
	if (state.enabled) {
		if (state.awaitingAction) return "Plan mode is active and a proposed plan is ready.";
		if (state.planPath) {
			return "Plan mode is active; revision in progress. The stored plan is superseded until the next plan_mode_complete.";
		}
		return "Plan mode is active. Explore, ask, and finish with plan_mode_complete when decision-ready.";
	}
	if (state.planPath) return "An implementation plan is active.";
	return "Plan mode is off.";
}
