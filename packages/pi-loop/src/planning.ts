/**
 * Loop planning: authoring an objective with the user before any loop exists.
 *
 * The criteria are frozen the moment a loop starts, and until now the first
 * time anyone saw them was after that point. That is the wrong order. The
 * objective's wording is the single leverage point on a loop's whole life —
 * it becomes the acceptance gate — and the moment it is decided is a
 * conversation, not a typed command.
 *
 * So `/loop` opens a menu whose first item is a drafting conversation, and the
 * loop starts from an approval card that shows the exact criteria the split
 * will produce. The card is the design language: because the cadence, the
 * caps and the ground rules are on it and editable there, no command grammar
 * has to carry them. A concept removed rather than a knob added.
 *
 * Planning is now the only door. The typed start and the inline token are
 * gone: both authored an acceptance gate in one line, unreviewed.
 */

import { LOOP_CRAFT_DOC } from "./docs.js";
import { deriveCriteria, type LoopCriterion } from "./ledger.js";
import { formatDuration } from "./interval.js";

/** Bounds on drafted ground rules: enough for real constraints, not a manifesto. */
export const MAX_GROUND_RULES = 10;
export const MAX_GROUND_RULE_LENGTH = 500;

/** A drafted loop, put up for approval and not yet started. */
export interface LoopProposal {
	objective: string;
	/** Exactly what `deriveCriteria` will produce, computed here so the card cannot lie. */
	criteria: LoopCriterion[];
	/**
	 * Hard constraints the loop must never violate.
	 *
	 * Constraints, not criteria: they never enter `criteria.json` and never
	 * gate completion. A loop is unattended, so the useful thing to fix in
	 * advance is not only what done looks like but what it must not do on the
	 * way there — don't touch prod, don't force-push, don't rewrite the fixture
	 * to make the test pass.
	 */
	groundRules?: string[];
	intervalMs: number;
	maxTurns: number | null;
	expiresInMs: number;
	proposedAt: number;
}

export interface LoopPlanningState {
	/** The user opened planning and no loop has started yet. */
	active: boolean;
	/** The current draft awaiting approval, when one has been proposed. */
	proposal?: LoopProposal;
	/**
	 * `proposedAt` of the draft whose card has already been rendered.
	 *
	 * The card is an artifact in the transcript, not a status line, so re-running
	 * `/loop` to reopen the menu must not emit a second copy of the same card.
	 * A new draft — a reworded objective, a changed cadence — has a new
	 * `proposedAt` and does get its own card, because it is a different thing to
	 * approve.
	 */
	cardShownAt?: number;
}

export interface LoopProposalOverrides {
	intervalMs?: number;
	maxTurns?: number | null;
	expiresInMs?: number;
	groundRules?: string[];
}

export function buildProposal(
	objective: string,
	defaults: { intervalMs: number; maxTurns: number | null; expiresInMs: number },
	now: number,
	overrides: LoopProposalOverrides = {},
): LoopProposal {
	const groundRules = normalizeGroundRules(overrides.groundRules);
	return {
		objective: objective.trim(),
		// Derived, never authored: the card has to show the criteria the engine
		// will actually freeze, or approving it means approving something else.
		criteria: deriveCriteria(objective),
		...(groundRules ? { groundRules } : {}),
		intervalMs: overrides.intervalMs ?? defaults.intervalMs,
		maxTurns: overrides.maxTurns === undefined ? defaults.maxTurns : overrides.maxTurns,
		expiresInMs: overrides.expiresInMs ?? defaults.expiresInMs,
		proposedAt: now,
	};
}

/**
 * Trim, drop the empties, and bound a drafted ground-rule list. Returns
 * undefined when nothing survives, so an empty array never becomes an empty
 * section on the card or an empty block in the system append.
 */
export function normalizeGroundRules(rules: readonly string[] | undefined): string[] | undefined {
	if (!rules) return undefined;
	const cleaned = rules
		.map((rule) => rule.trim())
		.filter((rule) => rule.length > 0)
		.slice(0, MAX_GROUND_RULES)
		.map((rule) => (rule.length > MAX_GROUND_RULE_LENGTH ? rule.slice(0, MAX_GROUND_RULE_LENGTH) : rule));
	return cleaned.length > 0 ? cleaned : undefined;
}

/** The approval card, as transcript lines. */
export function renderProposalCard(proposal: LoopProposal): string[] {
	return [
		"**◆ Loop ready to start**",
		"",
		"**Objective**",
		...proposal.objective.split("\n").map((line) => `> ${line}`),
		"",
		`**Criteria the gate will hold you to** (${proposal.criteria.length})`,
		...proposal.criteria.map((criterion) => `- \`${criterion.id}\`  ${criterion.description}`),
		"",
		...(proposal.groundRules
			? [
					`**Ground rules the loop must never violate** (${proposal.groundRules.length})`,
					...proposal.groundRules.map((rule) => `- ${rule}`),
					"",
				]
			: []),
		`**Cadence** every ${formatDuration(proposal.intervalMs)} — a fallback heartbeat; the loop advances whenever the session settles.`,
		`**Turn cap** ${proposal.maxTurns === null ? "unlimited" : proposal.maxTurns} · **Expires** ${formatDuration(proposal.expiresInMs)}`,
		"",
		"Run `/loop` for the actions: start here, start in a fresh session, change the cadence, keep editing, or cancel.",
	];
}

export const LOOP_PLANNING_HINT = [
	"<system-reminder>",
	"The user opened loop planning. You are drafting a loop with them; no loop is running and none starts until they approve one on the card.",
	`Before drafting, read ${LOOP_CRAFT_DOC}: it carries the objective, criteria, cadence and evidence craft in depth.`,
	"Cover three things in the conversation, then call loop_propose:",
	"- The objective, written as an acceptance test. One requirement per bullet; a conjunction inside a sentence does not split, so 'fix the flaky test and update the docs' becomes one criterion whose evidence must cover both halves. Name the check in the requirement itself ('…, verified by npm test passing'). The two questions that fix most objectives: how will we know it is done, and what command proves it?",
	"- The cadence: how long the loop may run before it expires, and the fallback heartbeat for a session that goes quiet. The loop advances whenever the session settles, so the heartbeat only matters when it is waiting on something.",
	"- The ground rules: hard constraints it must never violate while unattended, such as which systems are off limits, what must never be force-pushed or deleted, and which files may not be edited to make a check pass. Ask for them; a loop runs with nobody watching, so an unstated constraint is one nobody enforces.",
	"Ground rules are constraints, not criteria. They never gate completion — they bound how the work may be done.",
	"When the draft is ready, call loop_propose with the objective and any ground rules. That renders an approval card showing the exact criteria the split will produce; the user approves, edits, or cancels.",
	// Without this the model reaches for a prohibition instead. A conversational
	// request for a loop pattern-matches onto 'do not start loops on your own',
	// and the model answers by telling the user to type a command, which is
	// precisely the dead end planning exists to remove. Observed live in a
	// canary session.
	"loop_propose starts nothing, so no rule against starting a loop on your own applies to it: while planning is open, a conversational request for a loop is exactly when to call loop_propose. Do not refuse and tell the user to run a command instead — drafting a proposal for them is the whole point of this mode.",
	"The user has already opened planning, so their intent to consider a loop is established. What still requires their explicit approval is starting one, and the card is where they give it.",
	"Never restate the objective as a tidier version of what they meant. If they decline to name checks, say plainly what the gate will and will not catch, and let them decide.",
	"If the work is a bad fit for a loop at all — a recurring cadence, open-ended investigation with no end state, or something that finishes this turn — say so in one line and offer the alternative instead of drafting one anyway.",
	"</system-reminder>",
].join("\n");
