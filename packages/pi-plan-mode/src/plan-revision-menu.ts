/**
 * The revision review card.
 *
 * It opens from inside the `update_plan` tool call, which is the point: the agent
 * proposes, the user decides, and the decision comes back as that tool's result
 * in the same turn. No slash command stands between the proposal and the answer.
 *
 * Screens are exported as functions of their inputs so a test can pin what the
 * card offers without a terminal — the set of choices *is* the contract, and a
 * missing item is a lost control rather than a cosmetic change.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ActionsScreen, defineMenu, type ReviewScreen, runMenu } from "@narumitw/pi-tui-kit";

interface MenuLifecycle {
	signal?: AbortSignal;
	isCurrent?(): boolean;
}

export type PlanRevisionAction = "accept" | "feedback" | "cancel";
type PlanRevisionScreenId = "review" | "feedback" | "diff" | "proposed";

export interface PlanRevisionSummary {
	/** What the user asked for, carried from update_plan(action:"begin"). */
	instructions: string;
	/** What the agent says it changed. Shown beside the diff, never instead of it. */
	changeSummary: string;
	baseRevision: number;
	/** Computed by this package from the two documents. */
	diff: readonly string[];
	added: number;
	removed: number;
	proposedPlan: string;
	/** Set when the plan on disk was not the recorded revision at base time. */
	conflict?: string;
}

export function planRevisionReviewScreen(
	summary: PlanRevisionSummary,
): ActionsScreen<PlanRevisionScreenId, PlanRevisionAction> {
	return {
		kind: "actions",
		title: "Proposed plan revision",
		lines: [
			`Requested: ${summary.instructions}`,
			`Agent summary: ${summary.changeSummary}`,
			`${summary.added} line(s) added, ${summary.removed} line(s) removed against revision ${summary.baseRevision}.`,
			...(summary.conflict ? [`Note: ${summary.conflict}`] : []),
			"Accepting replaces the plan file. Implementation stays paused until you choose what happens next.",
		],
		items: [
			{
				id: "accept",
				label: "Accept revision",
				description: "Make it the current plan, then choose how to implement it.",
				action: "accept",
			},
			{
				id: "feedback",
				label: "Request changes…",
				description: "Send the agent what to change; the candidate stays on file.",
				to: "feedback",
			},
			{ id: "diff", label: "Show the changes", to: "diff" },
			{ id: "proposed", label: "Show the proposed plan", to: "proposed" },
			{
				id: "cancel",
				label: "Cancel revision",
				description: "Keep the approved plan exactly as it is.",
				action: "cancel",
			},
		],
		hint: "close",
	};
}

export function planRevisionDiffScreen(
	summary: PlanRevisionSummary,
): ReviewScreen<PlanRevisionAction> {
	return {
		kind: "review",
		title: `Changes against revision ${summary.baseRevision}`,
		content: summary.diff.length > 0 ? summary.diff.join("\n") : "(no textual change)",
		format: { kind: "diff" },
		viewportSize: "adaptive",
		hint: "back",
	};
}

export function planRevisionProposedScreen(
	summary: PlanRevisionSummary,
): ReviewScreen<PlanRevisionAction> {
	return {
		kind: "review",
		title: "Proposed plan",
		content: summary.proposedPlan,
		format: { kind: "code", language: "markdown" },
		viewportSize: "adaptive",
		hint: "back",
	};
}

export type PlanRevisionOutcome =
	| { kind: "accepted" }
	| { kind: "changes_requested"; feedback: string }
	| { kind: "cancelled" }
	| { kind: "dismissed" }
	| { kind: "unavailable" };

export interface PlanRevisionMenuOptions extends MenuLifecycle {
	summary: PlanRevisionSummary;
}

/**
 * Runs the review card and reports what the human chose.
 *
 * Closing it without choosing is `dismissed`, not a decision: the candidate stays
 * pending, implementation stays paused, and `/plan` reopens it. A mode that
 * cannot render a menu is `unavailable`, which the caller turns into
 * `pending_review` rather than inventing an approval.
 */
export async function showPlanRevisionMenu(
	ctx: ExtensionContext,
	options: PlanRevisionMenuOptions,
): Promise<PlanRevisionOutcome> {
	let outcome: PlanRevisionOutcome = { kind: "dismissed" };
	const menu = defineMenu<undefined, PlanRevisionScreenId, PlanRevisionAction, ExtensionContext>({
		start: "review",
		screens: {
			review: () => planRevisionReviewScreen(options.summary),
			diff: () => planRevisionDiffScreen(options.summary),
			proposed: () => planRevisionProposedScreen(options.summary),
			feedback: () => ({
				kind: "input",
				title: "What should change?",
				lines: ["Plain language. The agent gets this with the revision it is reworking."],
				placeholder: "keep the migration phase, change only the deployment approach",
				action: "feedback",
				hint: "back",
			}),
		},
		actions: {
			accept: () => {
				outcome = { kind: "accepted" };
				return { kind: "close" };
			},
			feedback: ({ value }) => {
				const feedback = (value ?? "").trim();
				if (!feedback) return { kind: "rejected" };
				outcome = { kind: "changes_requested", feedback };
				return { kind: "close" };
			},
			cancel: () => {
				outcome = { kind: "cancelled" };
				return { kind: "close" };
			},
		},
	});
	const result = await runMenu(ctx, menu, {
		getState: () => undefined,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
	});
	if (result.kind === "unsupported" || result.kind === "error") return { kind: "unavailable" };
	if (result.kind === "stale") return { kind: "dismissed" };
	return outcome;
}
