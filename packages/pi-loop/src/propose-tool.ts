/**
 * `loop_propose`: put a drafted loop up for the user's approval.
 *
 * It starts nothing. That separation is the point — the model drafts, the user
 * approves, and the approval is what starts the loop. A loop is
 * self-continuing and must never begin on model initiative, so this is the
 * only way a model can put one in front of a user: a card showing the
 * objective, the criteria, the ground rules, the cadence and the caps, with
 * the start reserved to the human reading it.
 *
 * Registered unconditionally, like the other loop tools: the tool set is part
 * of the cached request prefix, so it never changes with loop state.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDuration, MAX_INTERVAL_MS, parseDuration } from "./interval.js";
import type { LoopController } from "./loop.js";
import { MAX_GROUND_RULE_LENGTH, MAX_GROUND_RULES } from "./planning.js";

const LOOP_PROPOSE_TOOL = "loop_propose";

export function registerLoopProposeTool(
	pi: ExtensionAPI,
	controller: LoopController,
	onProposed?: () => void,
) {
	pi.registerTool(
		defineTool({
			name: LOOP_PROPOSE_TOOL,
			label: "Loop Propose",
			description:
				"Put a drafted loop objective up for the user's approval during loop planning. Renders an approval card showing the exact completion criteria the objective will produce, plus any ground rules. Starts nothing: the user approves, edits, or cancels.",
			promptSnippet: "Propose a drafted loop objective for approval",
			promptGuidelines: [
				"Call loop_propose only while loop planning is open, and only once the objective reads as an acceptance test: one requirement per bullet, each naming the check that proves it.",
				"Pass the objective you and the user agreed on, not a tidier version of it. The criteria are derived from this text and frozen when the loop starts.",
				"Pass ground_rules for the hard constraints the loop must never violate while unattended. They bound how the work may be done and never gate completion, so they belong there rather than in the objective.",
				"loop_propose starts nothing, so no rule against starting loops on your own applies to it. While planning is open, a conversational request for a loop is the signal to draft one and propose it — never to refuse and ask the user to run a command instead.",
			],
			parameters: Type.Object({
				objective: Type.String({
					minLength: 1,
					maxLength: 100_000,
					description:
						"The drafted objective, one requirement per bullet, each naming how it is verified.",
				}),
				interval: Type.Optional(
					Type.String({
						description:
							"Fallback heartbeat as <number><unit> (s, m, h, d), e.g. 30m. Omit to use the configured default.",
					}),
				),
				max_turns: Type.Optional(
					Type.Number({
						description:
							"Cap on loop-caused turns. Omit for the configured default; the user can change it on the card.",
					}),
				),
				expires: Type.Optional(
					Type.String({
						description: "Loop lifetime as <number><unit>, e.g. 3d. Omit for the default.",
					}),
				),
				ground_rules: Type.Optional(
					Type.Array(Type.String({ minLength: 1, maxLength: MAX_GROUND_RULE_LENGTH }), {
						maxItems: MAX_GROUND_RULES,
						description:
							"Hard constraints the loop must never violate, one per entry (e.g. 'never touch production', 'never force-push', 'never edit a test to make it pass'). Constraints, not criteria: they never gate completion.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!controller.planning.active) {
					return failure(
						"Loop planning is not open, so there is nothing to propose. The user opens it by running /loop with no loop running.",
					);
				}
				if (controller.state && controller.state.status !== "stopped") {
					return failure(
						"A loop is already running in this session. Stop it from the /loop menu before planning another.",
					);
				}
				const objective = params.objective.trim();
				if (!objective) return failure("A proposal needs an objective.");

				const overrides: {
					intervalMs?: number;
					maxTurns?: number | null;
					expiresInMs?: number;
					groundRules?: string[];
				} = {};
				// Bounded and trimmed in buildProposal, so an over-long or empty entry
				// is normalized rather than refused: a rejected proposal costs the whole
				// draft, and the card is where the user reviews them anyway.
				if (params.ground_rules !== undefined) overrides.groundRules = params.ground_rules;
				if (params.interval !== undefined) {
					const parsed = parseDuration(params.interval);
					if (parsed === undefined) {
						return failure(
							`Invalid interval: ${params.interval}. Use <number><unit> with unit s, m, h, or d, e.g. 30m.`,
						);
					}
					overrides.intervalMs = Math.min(parsed, MAX_INTERVAL_MS);
				}
				if (params.expires !== undefined) {
					const parsed = parseDuration(params.expires);
					if (parsed === undefined) {
						return failure(
							`Invalid expires: ${params.expires}. Use <number><unit> with unit s, m, h, or d, e.g. 3d.`,
						);
					}
					overrides.expiresInMs = parsed;
				}
				if (params.max_turns !== undefined) {
					if (!Number.isSafeInteger(params.max_turns) || params.max_turns <= 0) {
						return failure("max_turns must be a positive whole number.");
					}
					overrides.maxTurns = params.max_turns;
				}

				const proposal = controller.propose(objective, overrides);
				onProposed?.();
				// The card goes to the transcript as a framed block, not back through
				// this tool result. Returning it here too would render the same
				// artifact twice, once framed and once as a wall of markdown, and
				// spend the objective's tokens a second time in the model's own
				// context for no reader that does not already have it.
				controller.showProposalCard(ctx);
				return {
					content: [
						{
							type: "text" as const,
							text: `Approval card rendered: ${proposal.criteria.length} ${proposal.criteria.length === 1 ? "criterion" : "criteria"}${proposal.groundRules ? `, ${proposal.groundRules.length} ground rule${proposal.groundRules.length === 1 ? "" : "s"}` : ""}, waking every ${formatDuration(proposal.intervalMs)}, cap ${proposal.maxTurns === null ? "unlimited" : proposal.maxTurns}, expires in ${formatDuration(proposal.expiresInMs)}. The user starts it from /loop; nothing is running yet.`,
						},
					],
					details: {
						criteria: proposal.criteria.length,
						intervalMs: proposal.intervalMs,
						maxTurns: proposal.maxTurns,
						groundRules: proposal.groundRules?.length ?? 0,
					},
				};
			},
		}),
	);
}

function failure(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}
