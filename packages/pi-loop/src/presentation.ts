/**
 * The approval card, as a display-only session entry.
 *
 * It used to go out twice and neither copy was a card: `loop_propose`
 * returned it as tool-result text, and `/loop` re-printed it through
 * `ctx.ui.notify`. Tool text is rendered as a wall of markdown inside a tool
 * result, and a toast is a transient line that scrolls away — so the one
 * artifact the whole planning flow exists to produce was the least legible
 * thing on the screen, and duplicated.
 *
 * It is now a custom *entry* with a registered renderer, not a message. That
 * is what buys the property a message could not: Pi maps a `custom` entry to
 * no context messages at all and skips it during compaction, so the card stays
 * visible and restorable in the transcript while never entering model context
 * and never costing a compaction budget. The model is told a proposal exists
 * by the tool result; it never re-reads the rendered card.
 *
 * pi-plan-mode's completed-plan card is the same mechanism for the same
 * reason (`packages/pi-plan-mode/src/presentation.ts`), and `plan_mode_complete`
 * likewise returns a one-line `Plan saved to <path>.` pointer instead of the
 * plan body.
 */

import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { type LoopProposal, renderProposalCard } from "./planning.js";

/**
 * The card is a custom *entry*, not a custom message, and it carries a new
 * type name to say so. The old `LOOP_PROPOSAL_MESSAGE_TYPE` export is gone
 * rather than aliased: an alias would keep consumers compiling while silently
 * pointing them at a channel proposals no longer travel on, which is worse
 * than the compile error that tells them to look.
 */
export const LOOP_PROPOSAL_ENTRY_TYPE = "loop-proposal-card";

type LoopProposalCardData = { markdown: string; criteria: number; proposedAt: number };

/**
 * Persisted entry data is input, not a guarantee.
 *
 * The renderer runs against whatever is on disk, which may predate a field, be
 * truncated by a partial write, or have been hand-edited. Pi contains a
 * renderer throw as an inline `[loop-proposal-card] renderer failed: …` box —
 * survivable, but a needlessly ugly way to say "this card is old".
 */
function loopProposalCardData(value: unknown): LoopProposalCardData | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { markdown } = value as { markdown?: unknown };
	return typeof markdown === "string" ? (value as LoopProposalCardData) : undefined;
}

export function registerLoopProposalRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(LOOP_PROPOSAL_ENTRY_TYPE, (entry) => {
		const data = loopProposalCardData(entry.data);
		if (!data) return new Text("Loop proposal card unavailable.", 0, 0);
		return new Markdown(data.markdown, 0, 0, getMarkdownTheme());
	});
}

/**
 * Emit the card. Returns false when Pi refused it, in which case the caller
 * still has a working flow — the menu carries the actions, and the criteria
 * are on disk the moment the loop starts.
 */
export function showLoopProposalCard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	proposal: LoopProposal,
): boolean {
	try {
		pi.appendEntry<LoopProposalCardData>(LOOP_PROPOSAL_ENTRY_TYPE, {
			markdown: renderProposalCard(proposal).join("\n"),
			criteria: proposal.criteria.length,
			proposedAt: proposal.proposedAt,
		});
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Unable to show the loop proposal: ${detail}`, "error");
		return false;
	}
}
