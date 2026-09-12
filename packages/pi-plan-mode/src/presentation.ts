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

/**
 * What the state alone cannot say.
 *
 * Approval is a comparison against the file on disk, so it is read
 * asynchronously and handed in rather than derived here; the widget has to stay
 * a pure function of what it is given.
 */
export interface PlanModeViewDetail {
	/** Set while implementing a plan whose approval is unknown or stale. */
	approvalNotice?: string;
	/**
	 * How a person gets back to a known-approved plan, from
	 * `approvalRecoveryInstruction`. Only routes that exist in this session's mode
	 * are in it, which is why it is passed in rather than written here.
	 */
	recoveryInstruction?: string;
}

export function planModeView(
	state: PlanModeState,
	detail: PlanModeViewDetail = {},
): PlanModeView | undefined {
	if (state.enabled) {
		// A revision transaction outranks the ready plan: the plan on disk is what
		// the user approved, and the thing being decided is whether to change it.
		if (state.revision) {
			const proposed = state.revision.proposalId !== undefined;
			return {
				phase: "revising",
				footer: proposed ? "◆ plan · revision ready → /plan" : "◆ plan · revising",
				headline: proposed
					? "◆ plan · proposed revision ready"
					: "◆ plan · revising the approved plan",
				hint: proposed
					? "/plan to accept it, ask for changes, or cancel the revision."
					: "The approved plan is unchanged until a revision is accepted.",
				tone: "accent",
			};
		}
		// An agreed plan and a first draft occupy the same two states once a revision
		// resolves, and they mean opposite things: the draft is superseded by the next
		// plan_mode_complete, the agreed plan is current and that call is refused. The
		// discriminator is managed identity, because accepting a revision clears the
		// approval but never the identity.
		const managed = state.planId !== undefined && state.planPath !== undefined;
		if (managed) {
			const revision = state.specRevision ?? 0;
			const approved = state.approvedDigest !== undefined;
			return {
				phase: state.awaitingAction ? "ready" : "revising",
				footer: `◆ plan · agreed r${revision} → /plan`,
				headline: `◆ plan · agreed plan, spec revision ${revision}`,
				hint: approved
					? "/plan to resume implementing, export, or leave it paused — or ask for a change."
					: "Not yet approved for implementation. /plan to implement or export it — or ask for a change.",
				tone: "accent",
			};
		}
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
		// Implementing bytes nobody in this session agreed to is not the same as
		// implementing, and the footer is the only place a user would notice.
		if (detail.approvalNotice) {
			return {
				phase: "implementing",
				footer: "▶ plan · unverified → /plan",
				headline: "▶ plan · implementing an unverified plan",
				hint: "/plan to confirm the plan file, or ask for a revision.",
				tone: "accent",
			};
		}
		return {
			phase: "implementing",
			footer: "▶ plan · implementing",
			headline: "▶ plan · implementing",
			hint: "Ends with plan_implemented, or /plan to mark done, replace, or clear.",
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

export function updatePlanModeUi(
	ctx: ExtensionContext,
	state: PlanModeState,
	detail: PlanModeViewDetail = {},
) {
	const view = planModeView(state, detail);
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
		// No live plan, but the last finished one is still on disk: show it as
		// history rather than pretending there is nothing.
		const archived = state.archivePath ? await readPlanFile(state.archivePath) : undefined;
		if (archived && state.archivePath) {
			showPlanModePlan(pi, ctx, `Archived Plan (${state.archivePath})`, archived);
			return;
		}
		ctx.ui.notify(
			"No completed plan is available. Use /plan finalize when planning is complete.",
			"info",
		);
		return;
	}
	// A managed revision shows the plan that is still current, because that is
	// what the file holds: the candidate lives on the review card, not here.
	// enabled without awaitingAction and without a transaction means revision
	// feedback superseded the completed plan: show it, but never as current.
	const title = state.revision
		? `Current Plan (revision in progress against revision ${state.revision.baseRevision})`
		: state.enabled
			? state.planId !== undefined
				? `Agreed Plan (spec revision ${state.specRevision ?? 0})`
				: state.awaitingAction
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
export function planModeStatusText(state: PlanModeState, detail: PlanModeViewDetail = {}) {
	if (state.enabled) {
		if (state.revision) {
			return state.revision.proposalId !== undefined
				? `A revision of the approved plan is proposed and waiting for your decision (base revision ${state.revision.baseRevision}).`
				: `A revision of the approved plan is in progress (base revision ${state.revision.baseRevision}). The approved plan is unchanged until a revision is accepted.`;
		}
		if (state.planId !== undefined && state.planPath !== undefined) {
			const revision = state.specRevision ?? 0;
			return state.approvedDigest !== undefined
				? `The agreed plan at spec revision ${revision} is current and paused; it is approved for implementation. Ask for a change and it becomes a reviewed revision.`
				: `The agreed plan at spec revision ${revision} is current and not yet approved for implementation. Choose how to implement it, or ask for a change and it becomes a reviewed revision.`;
		}
		if (state.awaitingAction) return "Plan mode is active and a proposed plan is ready.";
		if (state.planPath) {
			return "Plan mode is active; revision in progress. The stored plan is superseded until the next plan_mode_complete.";
		}
		return "Plan mode is active. Explore, ask, and finish with plan_mode_complete when decision-ready.";
	}
	if (state.planPath) {
		if (!detail.approvalNotice) return "An implementation plan is active.";
		return detail.recoveryInstruction
			? `An implementation plan is active, but its approval cannot be verified. ${detail.approvalNotice} To ${detail.recoveryInstruction}`
			: `An implementation plan is active, but its approval cannot be verified. ${detail.approvalNotice}`;
	}
	return "Plan mode is off.";
}
