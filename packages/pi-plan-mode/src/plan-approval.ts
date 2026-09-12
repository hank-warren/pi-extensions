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
		return "The plan file could not be read, so nothing can be verified against it.";
	}
	return undefined;
}

/** How to get back to a known-approved plan, in the words both surfaces use. */
export const APPROVAL_RECOVERY_INSTRUCTION =
	'resolve it first: call update_plan with action "begin" to revise the plan with the user, or ask them to run /plan and choose "Confirm the plan file" to record the current file as approved.';

export function completionRefusal(approval: PlanApproval): string | undefined {
	if (approval.kind === "revising") {
		return `A plan revision is in progress, so the plan cannot be marked implemented yet. Finish it with update_plan action "propose", or ask the user to cancel the revision from /plan.`;
	}
	const notice = approvalNotice(approval);
	return notice ? `${notice} Do not mark it implemented — ${APPROVAL_RECOVERY_INSTRUCTION}` : undefined;
}
