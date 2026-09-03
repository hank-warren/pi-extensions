/**
 * `loop_complete`: the loop's terminal tool.
 *
 * It used to be deliberately thin, on the argument that stopping a pacemaker
 * has a small blast radius: the user just restarts it. That argument does not
 * survive the loop becoming the *only* long-work mechanism. A premature
 * completion now abandons autonomous work outright, and the model doing the
 * abandoning is the same one that decided the work was done.
 *
 * So completion is gated on the loop's own `criteria.json`: every criterion
 * must be answered with cited evidence, and a criterion the file still
 * records as unmet must be addressed by name. The gate is deliberately
 * mechanical — it cannot judge whether the evidence is *good*, only that the
 * model was made to look at every requirement and say something specific
 * about each. The audit rules that make the evidence worth citing live in the
 * tool description and the system append.
 *
 * Registered unconditionally, never added or removed with loop state: tools
 * are part of the cached request prefix, so mutating the tool set mid-session
 * invalidates the whole conversation cache (the same constraint that shapes
 * the objective injection). It refuses instead when no standalone loop is
 * active.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LoopController } from "./loop.js";
import type { LoopCriterion } from "./ledger.js";

export const LOOP_COMPLETE_TOOL = "loop_complete";

const MAX_SUMMARY_LENGTH = 4_000;
const MAX_EVIDENCE_LENGTH = 4_000;
/**
 * Shorter than this cannot be a citation of anything. Deliberately tiny: the
 * floor used to be twelve characters, which refused `404 → 200` and
 * `tests: 0 fail` — terse, specific, and exactly the evidence the gate wants.
 * Length was never the signal; the claim words below are.
 */
const MIN_EVIDENCE_LENGTH = 4;
/**
 * Words that assert rather than cite. A value made of nothing but these is a
 * claim of completion, however many of them are strung together.
 */
const EMPTY_EVIDENCE = new Set([
	"all",
	"complete",
	"completed",
	"confirmed",
	"done",
	"everything",
	"fine",
	"fixed",
	"good",
	"green",
	"it",
	"is",
	"met",
	"n/a",
	"none",
	"nothing",
	"now",
	"okay",
	"ok",
	"passed",
	"passes",
	"passing",
	"success",
	"successful",
	"true",
	"verified",
	"working",
	"works",
	"yes",
]);

export function registerLoopCompleteTool(pi: ExtensionAPI, controller: LoopController) {
	pi.registerTool(
		defineTool({
			name: LOOP_COMPLETE_TOOL,
			label: "Loop Complete",
			description:
				"Stop the active /loop when every completion criterion in the loop's criteria.json is proven by authoritative evidence. Requires one cited piece of evidence per criterion id. It stops the scheduled wakeups and does not assert that unrelated work is finished.",
			promptSnippet: "Stop the active standalone /loop once every criterion is proven",
			promptGuidelines: [
				"Call loop_complete only when every criterion in the loop's criteria.json is demonstrably met, verified against authoritative current state.",
				"Before calling it, treat completion as unproven and audit requirement by requirement: for every criterion, inspect authoritative evidence and match the verification scope to the requirement scope.",
				"Authoritative means the current worktree, command output, test results, runtime behaviour, PR state, or external state. Previous conversation, plans, and summaries are context, not proof.",
				"Weak, indirect, missing, or merely consistent evidence is not enough; gather stronger evidence and keep working.",
				"Effort exhaustion is not completion. Running long, running out of ideas, or reaching a cap is never a reason to call loop_complete.",
				"Pass evidence as a map of criterion id to a specific citation (the command you ran and what it printed, the file and what it now contains, the URL and its state). Every criterion id must appear.",
				"Pass the exact loop_id from the active /loop objective in the system prompt. A mismatched id means the loop changed and the call is refused.",
				"loop_complete stops scheduled wakeups only. It does not mean an unrelated goal or task is complete.",
				"If the criteria are not met, do not call it: keep working and expect another continuation.",
				"Before your first loop_complete this session, read the pi-loop skill: it describes what the evidence gate accepts as a citation and what it refuses.",
			],
			parameters: Type.Object({
				loop_id: Type.String({
					minLength: 1,
					maxLength: 200,
					description: "The exact loop_id from the active /loop objective in the system prompt.",
				}),
				evidence: Type.Record(
					Type.String(),
					Type.String({ maxLength: MAX_EVIDENCE_LENGTH }),
					{
						description:
							"Map of criterion id (c1, c2, …, from the loop's criteria.json) to the authoritative evidence proving it: the command run and its output, the file and its current contents, the external state and how it was checked.",
					},
				),
				summary: Type.Optional(
					Type.String({
						maxLength: MAX_SUMMARY_LENGTH,
						description: "Brief note on how the completion criteria were met.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const loop = controller.state;
				if (!loop || loop.objective === undefined) {
					return {
						content: toolContent(
							"No /loop with an objective is active, so there is nothing to complete. Run /loop to plan and approve one.",
						),
						details: { loopId: params.loop_id },
						isError: true,
					};
				}
				if (loop.status !== "active") {
					return {
						content: toolContent(`The /loop is already ${loop.status}; nothing to complete.`),
						details: { loopId: loop.id, status: loop.status },
						isError: true,
					};
				}
				if (params.loop_id !== loop.id) {
					return {
						content: toolContent(
							"loop_id does not match the active /loop. Use the exact loop_id from the active /loop objective in the system prompt.",
						),
						details: { loopId: loop.id },
						isError: true,
					};
				}
				const evidence = normalizeEvidence(params.evidence);
				const refusal = auditEvidence(controller.criteria(), evidence);
				if (refusal) {
					return {
						content: toolContent(refusal),
						details: { loopId: loop.id, criteria: controller.criteria() ?? [] },
						isError: true,
					};
				}
				const summary = params.summary?.trim();
				controller.completeLoop(summary);
				return {
					content: toolContent(
						`Loop stopped: every criterion answered with evidence.${summary ? ` ${summary}` : ""}`,
					),
					details: { loopId: loop.id, evidence, ...(summary ? { summary } : {}) },
				};
			},
		}),
	);
}

function normalizeEvidence(evidence: Record<string, string>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [id, value] of Object.entries(evidence)) {
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (!trimmed) continue;
		normalized[id.trim()] = trimmed;
	}
	return normalized;
}

/**
 * The mechanical half of the completion gate. Returns the refusal text, or
 * undefined when the call may proceed.
 *
 * With no readable criteria the loop cannot say what completion means, so the
 * gate degrades to "cite something specific" rather than blocking a loop
 * whose ledger is missing — the ledger is fail-open everywhere else too.
 */
export function auditEvidence(
	criteria: LoopCriterion[] | undefined,
	evidence: Record<string, string>,
): string | undefined {
	const answeredIds = new Set(Object.keys(evidence));
	if (!criteria) {
		return Object.values(evidence).some(isSubstantive)
			? undefined
			: "This loop has no readable criteria.json, so loop_complete still needs at least one specific citation: the command you ran and what it printed, or the state you inspected and what it showed.";
	}
	const missing = criteria.filter((criterion) => !answeredIds.has(criterion.id));
	if (missing.length > 0) {
		return [
			`loop_complete refused: ${missing.length} of ${criteria.length} criteria have no cited evidence.`,
			...missing.map(
				(criterion) =>
					`- ${criterion.id}${criterion.passes ? "" : " (still recorded as unmet)"}: ${criterion.description}`,
			),
			"Audit each one against authoritative current state — command output, file contents, external state — and pass the evidence keyed by criterion id. Weak or merely consistent evidence is not enough, and effort exhaustion is not completion.",
		].join("\n");
	}
	const unknown = [...answeredIds].filter(
		(id) => !criteria.some((criterion) => criterion.id === id),
	);
	if (unknown.length > 0) {
		return `loop_complete refused: evidence cites unknown criterion id(s) ${unknown.join(", ")}. Use the ids from the loop's criteria.json (${criteria.map((criterion) => criterion.id).join(", ")}).`;
	}
	const weak = Object.entries(evidence)
		.filter(([id]) => criteria.some((criterion) => criterion.id === id))
		.filter(([, value]) => !isSubstantive(value));
	if (weak.length > 0) {
		return `loop_complete refused: the evidence for ${weak.map(([id]) => id).join(", ")} asserts completion instead of citing it. Give the command and its output, the file and its contents, or the external state and how it was checked.`;
	}
	return undefined;
}

/**
 * Does this evidence value cite something, or merely assert it?
 *
 * Mechanical and predictable on purpose — the per-criterion-id enumeration is
 * the real gate, and a heuristic that guesses at quality would refuse real
 * citations. So exactly two things are refused: a value too short to say
 * anything, and a value in which *every* word is one of the claim words, with
 * punctuation and case ignored ("Done.", "verified, passed"). One word the
 * blocklist does not know — a command, a number, a filename — is enough to
 * make the value specific, which is what the gate is asking for.
 */
function isSubstantive(value: string): boolean {
	const words = value
		.trim()
		.split(/\s+/u)
		.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean);
	if (words.length === 0 || value.trim().length < MIN_EVIDENCE_LENGTH) return false;
	return !words.every((word) => EMPTY_EVIDENCE.has(word.toLowerCase()));
}

function toolContent(text: string) {
	return [{ type: "text" as const, text }];
}
