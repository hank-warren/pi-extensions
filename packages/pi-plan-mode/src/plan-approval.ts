/**
 * What this session knows about the bytes the user agreed to.
 *
 * Approval binds to a digest, not to a flag. "Implement" records the exact bytes
 * that were on disk when the user chose it, and every later gate — the next
 * turn's context line, a revision, and every completion path — compares the file
 * against that digest. Bytes that no longer match conservatively invalidate
 * approval rather than being classified: there is no semantic-diff judge
 * deciding which edits were harmless.
 *
 * "Unknown" is a first-class answer and is deliberately not "approved". A plan
 * restored from a state entry written before managed approval, or carried in from
 * a session that never recorded a digest, is preserved and readable — but nothing
 * may claim it was implemented as agreed until somebody says so.
 */

import type { PlanModeState } from "./state.js";

export type PlanApproval =
	/** No plan in this session. */
	| { kind: "none" }
	/** Plan mode is drafting a first plan; there is nothing to approve yet. */
	| { kind: "drafting" }
	/** A revision transaction is open, so the plan is being changed. */
	| { kind: "revising"; paused?: string }
	/** A plan is proposed and waiting for the user to choose what happens next. */
	| { kind: "proposed" }
	/** Implementation is under way against exactly these bytes. */
	| { kind: "approved"; digest: string }
	/** Implementing, but this session never recorded which bytes were approved. */
	| { kind: "unknown" }
	/** The plan file changed after it was approved. */
	| { kind: "stale"; approvedDigest: string; currentDigest: string }
	/** The pointer names a file that cannot be read. */
	| { kind: "missing" };

/**
 * `liveDigest` is the digest of the plan file as it is right now, or undefined
 * when it could not be read. It is passed in rather than computed here so the
 * callers that already hold the bytes do not read the file twice.
 */
export function evaluatePlanApproval(
	state: PlanModeState,
	liveDigest: string | undefined,
): PlanApproval {
	if (!state.planPath) return { kind: "none" };
	if (liveDigest === undefined) return { kind: "missing" };
	if (state.revision) {
		return state.revision.paused
			? { kind: "revising", paused: state.revision.paused }
			: { kind: "revising" };
	}
	if (state.enabled) return state.awaitingAction ? { kind: "proposed" } : { kind: "drafting" };
	if (!state.approvedDigest) return { kind: "unknown" };
	if (state.approvedDigest === liveDigest) return { kind: "approved", digest: liveDigest };
	return { kind: "stale", approvedDigest: state.approvedDigest, currentDigest: liveDigest };
}

/**
 * The sentence that explains a non-approved implementation state, for the
 * context line, the menu, and every refusal. One wording, so the model and the
 * user are told the same thing.
 */
export function approvalNotice(approval: PlanApproval): string | undefined {
	if (approval.kind === "unknown") {
		return "This session has no record of the exact plan bytes that were approved, so the plan is being implemented with its approval unknown. It may predate managed approval or have been approved in another session.";
	}
	if (approval.kind === "stale") {
		return "The plan file changed after it was approved, so the approval no longer covers what is on disk.";
	}
	if (approval.kind === "missing") {
		return "The plan file could not be read, so nothing can be verified against it and nothing may be implemented from it.";
	}
	return undefined;
}

/**
 * Whether `/plan`'s "Confirm the plan file" can do anything for this state.
 *
 * Confirming records the bytes on disk as approved, so it needs bytes. For a file
 * that cannot be read, `confirmCurrentPlan` fails with "could not be read" — so
 * offering the item is an invitation to an error, and the menu keys on this
 * instead of on "is there a notice at all".
 */
export function canConfirmPlanFile(approval: PlanApproval): boolean {
	return approval.kind === "unknown" || approval.kind === "stale";
}

/**
 * Why `plan_mode_complete` cannot finalize this plan, or undefined when it can.
 *
 * `plan_mode_complete` carries a whole plan and no base: no revision it was
 * computed against, no digest, no diff the user approved. That is exactly right
 * for a first draft and exactly wrong for a plan that already has managed
 * history — publishing through it would replace reviewed scope from model memory,
 * leave the manifest claiming bytes the file no longer holds, and strand the
 * candidate the user was looking at.
 *
 * So the refusal is by *state*, not by tool wrapper, and it names the call that
 * does work: `propose` while a transaction is open, `begin` otherwise. It is a
 * refusal and not a quiet adoption of the live bytes on purpose — adopting them
 * would be this package deciding that a change nobody reviewed is the new agreed
 * scope.
 */
export function managedCompletionRefusal(state: PlanModeState): string | undefined {
	if (state.revision) {
		return `plan_mode_complete cannot finalize a revision of an existing plan. Call update_plan with action "propose", revisionId "${state.revision.revisionId}", expectedRevision ${state.revision.baseRevision}, the complete rewritten plan, and a changeSummary.`;
	}
	if (state.planId !== undefined && state.planPath !== undefined) {
		return `plan_mode_complete cannot replace a plan that already exists: this one is at spec revision ${state.specRevision ?? 0} with recorded history, and a change to it has to be reviewed against that base. Call update_plan with action "begin" and expectedRevision ${state.specRevision ?? 0}, then action "propose" with the complete rewritten plan.`;
	}
	return undefined;
}

/**
 * Whether the session the guidance is for can render the `/plan` menu.
 *
 * It changes which routes exist, not how strict the rule is. Print and JSON
 * modes refuse the interactive `/plan` menu outright, so naming "run /plan and
 * choose …" there sends a user at a throw — and because the command handler
 * treats an unrecognised argument as a planning prompt, typing the name of the
 * menu item turns Plan mode *on* over an implementing plan and forwards the word
 * to the model. Only routes that work in the mode being addressed are offered.
 */
export interface ApprovalGuidanceMode {
	interactive: boolean;
}

/**
 * How to get back to a known-approved plan, naming only routes that exist.
 *
 * Three rules hold across every variant:
 *
 *   1. Every named route is an **existing** one. No `/plan confirm`, no
 *      `/plan review`, no model-callable approval: the only things offered are
 *      `update_plan(begin)`, the `/plan` menu's own items, and `/plan implement`,
 *      all of which are already here.
 *   2. Re-approval is always something a **person** does. The model is told what
 *      to tell the user, never how to manufacture an approval of its own.
 *   3. A plan whose bytes cannot be read is a different problem and gets a
 *      different answer. `begin` refuses (`plan_missing`) and Confirm fails for
 *      it, so offering either would be advice that cannot work.
 */
export function approvalRecoveryInstruction(
	approval: PlanApproval,
	mode: ApprovalGuidanceMode,
): string | undefined {
	if (approval.kind === "missing") {
		return "restore the plan file at that path, or clear the active plan with /plan exit. Revising and confirming both need the file's bytes, so neither can run until it is readable.";
	}
	if (approval.kind !== "unknown" && approval.kind !== "stale") return undefined;
	if (mode.interactive) {
		return 'resolve it first: call update_plan with action "begin" to revise the plan with the user, or ask them to run /plan and choose "Confirm the plan file" to record the current file as approved.';
	}
	// No menu in this mode. `/plan implement` is the one existing command that
	// re-approves the bytes on disk, and it is the user's to type: it records the
	// approval and re-sends the implementation handoff.
	return 'resolve it first: call update_plan with action "begin" to revise the plan with the user, or tell them this session has no interactive review, so they can re-approve the file exactly as it is by running /plan implement — which records the approval and restarts implementation from it. Do not treat either as done until they have acted.';
}

export function completionRefusal(
	approval: PlanApproval,
	mode: ApprovalGuidanceMode = { interactive: true },
): string | undefined {
	if (approval.kind === "revising") return REVISION_IN_PROGRESS_REFUSAL;
	const notice = approvalNotice(approval);
	if (!notice) return undefined;
	const instruction = approvalRecoveryInstruction(approval, mode);
	return instruction ? `${notice} Do not mark it implemented — ${instruction}` : notice;
}

/**
 * The completion refusal for an open revision, reachable on its own.
 *
 * Both completion entry points return early on `state.enabled`, and an open
 * revision always implies `enabled`, so without naming this case first the user
 * hears "No plan is being implemented" about a plan that very much is.
 */
export const REVISION_IN_PROGRESS_REFUSAL =
	'A plan revision is in progress, so the plan cannot be marked implemented yet. Finish it with update_plan action "propose", or cancel the revision from /plan.';

/**
 * What a mutating tool is told when the plan it is implementing is not the plan
 * that was approved.
 *
 * The approved plan requires the accepted digest to be validated at mutation
 * calls as well as at turn boundaries, because an edit that lands mid-turn is
 * otherwise invisible until the next one. This is that refusal: it blocks the
 * write and says how a person resolves it, rather than letting implementation
 * continue against bytes nobody agreed to.
 *
 * Only the states an *implementing* session can be in are answered here —
 * `none`, `approved`, `unknown`, `stale`, `missing`. `drafting`, `proposed` and
 * `revising` all require Plan mode to be on, where the same hook already refuses
 * every mutating tool outright and says why; routing those through this function
 * would give one situation two wordings.
 */
export function mutationRefusal(
	toolName: string,
	approval: PlanApproval,
	mode: ApprovalGuidanceMode = { interactive: true },
): string | undefined {
	const notice = approvalNotice(approval);
	if (!notice) return undefined;
	const instruction = approvalRecoveryInstruction(approval, mode);
	return `Plan mode blocks '${toolName}' because the plan being implemented is not the plan that was approved. ${notice}${
		instruction ? ` Stop implementing and ${instruction}` : ""
	}`;
}
