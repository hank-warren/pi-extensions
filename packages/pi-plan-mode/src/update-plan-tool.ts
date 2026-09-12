/**
 * `update_plan`: the only way an existing plan changes.
 *
 * Two actions, in order. `begin` says "the user asked for this change to the
 * approved plan" and opens a revision transaction: the approved baseline is
 * retained, planning's non-mutation rules come back, and any menu opened against
 * the previous state goes stale. `propose` submits the rewritten plan, which is
 * diffed against the base and put in front of the user to accept, send back, or
 * cancel.
 *
 * What the tool is *not* is a second way to finalize a first draft. That stays
 * `plan_mode_complete`, which is what the prompt names while a plan is being
 * drafted; `update_plan` is what it names once a plan exists. Keeping the two
 * separate is what lets a revision carry a base revision and a digest, which is
 * what makes approval mean anything.
 *
 * Results are JSON. A revision is structured data — transaction id, base
 * revision, digest, plan path — and the model has to quote those back verbatim
 * on the next call, so it should not have to re-derive them from prose.
 */

export const UPDATE_PLAN_TOOL_NAME = "update_plan";
/** The same ceiling `plan_mode_complete` enforces; a revision is a whole plan. */
export const UPDATE_PLAN_MAX_PLAN_CHARS = 50_000;
const MAX_TEXT_CHARS = 4_000;

export const UPDATE_PLAN_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["action"],
	properties: {
		action: {
			type: "string",
			enum: ["begin", "propose"],
			description:
				'"begin" opens a revision of the existing plan and returns its transaction id and base. "propose" submits the rewritten plan for the user to review.',
		},
		expectedRevision: {
			type: "integer",
			minimum: 0,
			description:
				"The plan's current spec revision, exactly as the active-plan context line or a previous update_plan result reported it. 0 means the plan has no managed revision history yet. Required for both actions; a stale value is refused rather than rebased.",
		},
		instructions: {
			type: "string",
			maxLength: MAX_TEXT_CHARS,
			description:
				'Required with action "begin": what the user asked to change, in their own terms. It is recorded with the revision and shown on the review card.',
		},
		revisionId: {
			type: "string",
			description:
				'Required with action "propose": the revisionId that action "begin" returned.',
		},
		plan: {
			type: "string",
			minLength: 1,
			maxLength: UPDATE_PLAN_MAX_PLAN_CHARS,
			description:
				'Required with action "propose": the complete rewritten plan in Markdown. A complete replacement, never a delta or a patch.',
		},
		changeSummary: {
			type: "string",
			maxLength: MAX_TEXT_CHARS,
			description:
				'Required with action "propose": what you changed and what you deliberately kept. The user reviews the computed diff; this is the explanation beside it.',
		},
	},
} as const;

export const UPDATE_PLAN_DESCRIPTION = [
	"Revise the implementation plan that already exists in this session, whether it is waiting to be implemented or already being implemented.",
	'Call it with action "begin" as soon as the user asks for a change to the plan, before doing any of the work: it returns a revisionId, the base spec revision and digest, and the plan file path.',
	'Then read the plan file, settle only the questions the change actually raises, and call it again with action "propose" and the complete rewritten plan.',
	"Proposing shows the user the computed diff and their decision comes back as this tool's result: accepted, changes requested, or cancelled.",
	"It never edits files itself and it is not how a first draft is finalized — that is plan_mode_complete.",
].join(" ");

export const UPDATE_PLAN_SNIPPET = "Revise the existing implementation plan";

export const UPDATE_PLAN_GUIDELINES = [
	`When the user asks to change, extend, reduce, or re-sequence a plan that already exists, call ${UPDATE_PLAN_TOOL_NAME} with action "begin" and then action "propose". It is the plan-editing interface: never tell the user to edit the plan file themselves, never use edit or write on it, and never answer with a command for them to type.`,
	`In ${UPDATE_PLAN_TOOL_NAME}, pass expectedRevision exactly as the active-plan context line or the previous result reported it, and pass action "propose" the complete rewritten plan rather than a description of the change.`,
	`${UPDATE_PLAN_TOOL_NAME} action "begin" is an opening move: call it early, then keep exploring in the same turn. Action "propose" is the closing one: call it alone as the final action of its turn, like plan_mode_complete.`,
];

export type UpdatePlanInput =
	| { action: "begin"; expectedRevision: number; instructions: string }
	| {
			action: "propose";
			revisionId: string;
			expectedRevision: number;
			plan: string;
			changeSummary: string;
	  };

export type NormalizeUpdatePlanResult =
	| { ok: true; input: UpdatePlanInput }
	| { ok: false; error: string };

/**
 * Validate the discriminated shape by hand, because the schema cannot.
 *
 * A JSON Schema `oneOf` over two required sets is the textbook encoding and is
 * also the one providers mangle most: the fields land flat, the branch is
 * dropped, or the whole tool is rejected. A flat object plus this function keeps
 * the wire shape boring and the refusals specific enough to act on — "begin
 * needs instructions" is a correctable mistake, where a schema rejection is not.
 *
 * Enum values arrive with trailing whitespace often enough to matter, so every
 * string is trimmed before it is judged.
 */
export function normalizeUpdatePlan(input: unknown): NormalizeUpdatePlanResult {
	if (!isRecord(input)) return { ok: false, error: "update_plan takes an object" };
	const action = typeof input.action === "string" ? input.action.trim() : undefined;
	if (action !== "begin" && action !== "propose") {
		return { ok: false, error: 'action must be "begin" or "propose"' };
	}
	const expectedRevision = input.expectedRevision;
	if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
		return {
			ok: false,
			error:
				"expectedRevision must be the plan's current spec revision as a non-negative integer (0 when the plan has no managed revision history yet)",
		};
	}
	if (action === "begin") {
		const instructions = trimmed(input.instructions);
		if (!instructions) {
			return {
				ok: false,
				error: 'action "begin" requires instructions: what the user asked to change, in their own terms',
			};
		}
		if (instructions.length > MAX_TEXT_CHARS) {
			return { ok: false, error: `instructions must not exceed ${MAX_TEXT_CHARS} characters` };
		}
		return { ok: true, input: { action: "begin", expectedRevision, instructions } };
	}
	const revisionId = trimmed(input.revisionId);
	if (!revisionId) {
		return {
			ok: false,
			error: 'action "propose" requires the revisionId that action "begin" returned',
		};
	}
	const plan = trimmed(input.plan);
	if (!plan) {
		return { ok: false, error: 'action "propose" requires plan: the complete rewritten plan' };
	}
	if (plan.length > UPDATE_PLAN_MAX_PLAN_CHARS) {
		return { ok: false, error: `plan must not exceed ${UPDATE_PLAN_MAX_PLAN_CHARS} characters` };
	}
	const changeSummary = trimmed(input.changeSummary);
	if (!changeSummary) {
		return {
			ok: false,
			error:
				'action "propose" requires changeSummary: what you changed and what you deliberately kept',
		};
	}
	if (changeSummary.length > MAX_TEXT_CHARS) {
		return { ok: false, error: `changeSummary must not exceed ${MAX_TEXT_CHARS} characters` };
	}
	return {
		ok: true,
		input: { action: "propose", revisionId, expectedRevision, plan, changeSummary },
	};
}

export interface UpdatePlanOutcome {
	payload: Record<string, unknown>;
	isError?: boolean;
}

export function updatePlanFailure(
	status: string,
	message: string,
	extra: Record<string, unknown> = {},
): UpdatePlanOutcome {
	return { payload: { status, message, ...extra }, isError: true };
}

export function updatePlanToolResult(outcome: UpdatePlanOutcome) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(outcome.payload, null, 2) }],
		details: outcome.payload,
		...(outcome.isError ? { isError: true } : {}),
	};
}

function trimmed(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
