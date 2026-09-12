/**
 * The plan lives on disk, so session state carries only a pointer to it, the
 * ready-for-action flag, and — since schema version 2 — the identity of the
 * revision it is, the digest of the bytes the user approved, and any revision
 * transaction still open.
 *
 * Plan mode holds no session-global state of its own: thinking level and model
 * are session settings it never touches.
 *
 * ## Compatibility
 *
 * Version 2 is additive, and every new field is optional. A state entry written
 * by an earlier version restores with `planId`, `specRevision`, `currentDigest`
 * and `approvedDigest` all absent, which is exactly the "approval unknown" case:
 * the plan is preserved and still readable, but this session cannot claim to know
 * which bytes were approved, so it asks before completing or revising rather than
 * assuming. Nothing is migrated in bulk — identity is assigned the first time
 * something managed happens to the plan.
 */

/**
 * A revision the user has asked for and the agent has not finished proposing.
 *
 * Its existence is what puts the session back under planning's non-mutation
 * rules, and what makes `plan_mode_complete` refuse in favour of
 * `update_plan(action:"propose")`.
 */
export interface PlanRevisionTransaction {
	revisionId: string;
	/** The spec revision the revision is computed against. */
	baseRevision: number;
	/** The exact plan bytes it is computed against. */
	baseDigest: string;
	/** What the user asked for, in their own terms. */
	instructions: string;
	startedAt: string;
	/** The candidate awaiting review, once one has been proposed. */
	proposalId?: string;
	/**
	 * Why implementation is paused. Set when a proposal's review ended without a
	 * decision or was cancelled, so nothing silently resumes executing a plan the
	 * user was in the middle of changing.
	 */
	paused?: string;
}

export interface PlanModeState {
	/** Absent means a state entry from before managed revisions. */
	schemaVersion?: number;
	enabled: boolean;
	/** Absolute path to the durable plan file, once a plan has been written. */
	planPath?: string;
	/** A completed plan is waiting for the user to choose how to proceed. */
	awaitingAction: boolean;
	/**
	 * Where the last finished plan went. A fresh implementation session shares
	 * its parent's live slot, so when it finishes, the parent's `planPath` names
	 * a file that has moved; this is where `/plan show` can still find it.
	 */
	archivePath?: string;
	/** The managed identity of the plan, once it has revision history. */
	planId?: string;
	/** The spec revision the plan file holds, as last recorded by this session. */
	specRevision?: number;
	/** The digest of the plan bytes at that revision. */
	currentDigest?: string;
	/**
	 * The digest of the exact bytes the user approved for implementation.
	 *
	 * Absent while a plan is only proposed, and absent for a plan that predates
	 * managed approval — which is deliberately not the same as approved, and is
	 * why completion asks rather than assumes.
	 */
	approvedDigest?: string;
	/** The open revision transaction, if any. */
	revision?: PlanRevisionTransaction;
}

export const PLAN_STATE_SCHEMA_VERSION = 2;

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

export function restorePlanModeState(entries: unknown[], stateEntryType: string): PlanModeState {
	const entry = newestStateEntry(entries, stateEntryType);
	if (!isRecord(entry?.data)) return { enabled: false, awaitingAction: false };

	const enabled = entry.data.enabled === true;
	const planPath = absolutePath(entry.data.planPath);
	const archivePath = absolutePath(entry.data.archivePath);
	// Every managed field is dropped when the plan pointer is gone: an identity
	// without a document would otherwise let a later write believe it knows which
	// revision some other file is.
	const managed = planPath !== undefined;
	const planId = managed ? managedId(entry.data.planId) : undefined;
	return {
		...(typeof entry.data.schemaVersion === "number" ? { schemaVersion: entry.data.schemaVersion } : {}),
		enabled,
		planPath,
		awaitingAction: enabled && entry.data.awaitingAction === true && planPath !== undefined,
		...(archivePath ? { archivePath } : {}),
		...(planId ? { planId } : {}),
		...(managed && positiveInteger(entry.data.specRevision) !== undefined
			? { specRevision: positiveInteger(entry.data.specRevision) }
			: {}),
		...(managed && digest(entry.data.currentDigest) ? { currentDigest: digest(entry.data.currentDigest) } : {}),
		...(managed && digest(entry.data.approvedDigest)
			? { approvedDigest: digest(entry.data.approvedDigest) }
			: {}),
		...(managed && planId ? revisionPatch(entry.data.revision) : {}),
	};
}

/**
 * A restored transaction is only trusted when it is completely well formed and
 * belongs to a plan with an identity: half a transaction would pause
 * implementation with no way to finish or cancel it.
 */
function revisionPatch(value: unknown): { revision?: PlanRevisionTransaction } {
	if (!isRecord(value)) return {};
	const revisionId = managedId(value.revisionId);
	const baseDigest = digest(value.baseDigest);
	const baseRevision = positiveInteger(value.baseRevision);
	if (!revisionId || !baseDigest || baseRevision === undefined) return {};
	const instructions = typeof value.instructions === "string" ? value.instructions : "";
	const proposalId = managedId(value.proposalId);
	return {
		revision: {
			revisionId,
			baseRevision,
			baseDigest,
			instructions,
			startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
			...(proposalId ? { proposalId } : {}),
			...(typeof value.paused === "string" && value.paused ? { paused: value.paused } : {}),
		},
	};
}

function newestStateEntry(entries: unknown[], stateEntryType: string): SessionEntry | undefined {
	const branch = entries as SessionEntry[];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const candidate = branch[index];
		if (candidate?.type === "custom" && candidate.customType === stateEntryType) return candidate;
	}
	return undefined;
}

/**
 * Persisted paths are only trusted when they are absolute and free of NUL, so
 * malformed state can never redirect a read or a delete to a relative target.
 */
function absolutePath(value: unknown) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized || normalized.includes("\0") || !normalized.startsWith("/")) return undefined;
	return normalized;
}

/** Managed ids are generated as uuids, so anything else is not one of ours. */
function managedId(value: unknown) {
	return typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value) ? value : undefined;
}

function digest(value: unknown) {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function positiveInteger(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
