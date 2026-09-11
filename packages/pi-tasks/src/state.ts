/**
 * What the session remembers about a task set: which one, and which revision it
 * last saw accepted.
 *
 * Not a second copy of the task list. The document on disk is the task list;
 * this is a pointer plus the fingerprint needed to notice that the document
 * moved without this session's knowledge — on a branch, in another session, or
 * in an editor. Custom entries never enter model context, so recording it costs
 * nothing per turn and survives compaction for free.
 *
 * An absent entry means unattached, and unattached must stay unattached: a
 * fresh session that inherited nothing has no task set, and resurrecting the
 * newest one on disk would silently adopt another session's work.
 */

export interface TasksAttachment {
	taskSetId: string;
	revision: number;
	digest: string;
	recordedAt: string;
	/**
	 * The highest revision number this session has been told about and has
	 * explicitly accounted for.
	 *
	 * Set when a human resolves an ambiguity — history on disk running ahead of
	 * the live document, which means the document may have been restored over
	 * work that was already published. Without it, "attach the document as it
	 * stands" would be re-blocked by the same ambiguity on the very next read and
	 * the session could never make progress again.
	 *
	 * Persistent high-water information only. It records what the user was told,
	 * and it deliberately does *not* carry permission to adopt bytes this package
	 * cannot account for — that is `authorizedDocument`, which is narrower and
	 * does not survive the state it was granted for.
	 */
	reconciledThrough?: number;
	/**
	 * Permission to publish on top of one specific document this package cannot
	 * otherwise explain.
	 *
	 * Granted by `/tasks recover → attach`, and pinned to the exact bytes the
	 * user was looking at when they granted it: same set, same revision, same
	 * digest, and the reservation high-water mark at that moment. Anything else —
	 * a different document, a later revision, history that has since been lost —
	 * falls outside it and needs its own decision.
	 *
	 * It is consumed by the next successful publication, because that produces a
	 * document this package *can* account for, and an authorization that outlived
	 * its subject would be a standing bypass rather than a decision.
	 */
	authorizedDocument?: {
		taskSetId: string;
		revision: number;
		digest: string;
		reservedThrough: number;
	};
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

const TASK_SET_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{0,63}$/u;

export function restoreTasksAttachment(
	entries: readonly unknown[],
	stateEntryType: string,
): TasksAttachment | undefined {
	const branch = entries as SessionEntry[];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const candidate = branch[index];
		if (candidate?.type !== "custom" || candidate.customType !== stateEntryType) continue;
		return parseAttachment(candidate.data);
	}
	return undefined;
}

/**
 * A detach is recorded as an entry with no task set, so restoring a branch that
 * ends in one does not walk further back and re-adopt the set before it.
 */
function parseAttachment(value: unknown): TasksAttachment | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	const taskSetId = data.taskSetId;
	if (typeof taskSetId !== "string" || !TASK_SET_ID_RE.test(taskSetId)) return undefined;
	const revision = data.revision;
	const digest = data.digest;
	if (!Number.isSafeInteger(revision) || (revision as number) < 0) return undefined;
	if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) return undefined;
	const reconciledThrough = data.reconciledThrough;
	return {
		taskSetId,
		revision: revision as number,
		digest,
		recordedAt: typeof data.recordedAt === "string" ? data.recordedAt : "",
		...(Number.isSafeInteger(reconciledThrough) && (reconciledThrough as number) >= 0
			? { reconciledThrough: reconciledThrough as number }
			: {}),
		...(parseAuthorizedDocument(data.authorizedDocument, taskSetId) ?? {}),
	};
}

/**
 * A restored authorization is only honoured when every field is present, well
 * formed, and names the set it was restored for. A malformed one is dropped
 * rather than repaired: the cost of losing it is one more recovery decision,
 * and the cost of accepting a bad one is adopting bytes nobody authorised.
 */
function parseAuthorizedDocument(
	value: unknown,
	taskSetId: string,
): { authorizedDocument: NonNullable<TasksAttachment["authorizedDocument"]> } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	if (data.taskSetId !== taskSetId) return undefined;
	if (!Number.isSafeInteger(data.revision) || (data.revision as number) < 0) return undefined;
	if (typeof data.digest !== "string" || !/^[0-9a-f]{64}$/u.test(data.digest)) return undefined;
	if (!Number.isSafeInteger(data.reservedThrough) || (data.reservedThrough as number) < 0) {
		return undefined;
	}
	return {
		authorizedDocument: {
			taskSetId,
			revision: data.revision as number,
			digest: data.digest,
			reservedThrough: data.reservedThrough as number,
		},
	};
}
