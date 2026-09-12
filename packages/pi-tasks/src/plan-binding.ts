import { createHash } from "node:crypto";
import { allocatePhaseId, allocateTaskId, cloneTaskSet, createTaskSet, isClosedStatus, trimRemovedRecords, type TaskSet } from "./model.js";
import { diffTaskSets } from "./proposals.js";
import { parseTaskSeed, sameBinding, type TaskSeed, type PlanBinding } from "./plan-contract.js";
import { commitTaskDocument, loadTaskDocument, taskDocumentPath, isPublishedRevision, historyAheadOf, type LoadedDocument } from "./store.js";

/** Reads only exact published bytes; an unattached caller cannot bless an external edit. */
export async function readBoundTasks(root: string, id: string): Promise<LoadedDocument | undefined> {
	const loaded = await loadTaskDocument(taskDocumentPath(root, id), id);
	if (loaded.kind === "missing") return undefined;
	if (loaded.kind !== "loaded") throw new Error(`task recovery required: ${loaded.reason}`);
	const { set } = loaded.loaded.document;
	if (set.archivedAt || !(await isPublishedRevision(root, id, set.revision, loaded.loaded.digest)) || (await historyAheadOf(root, id, set.revision)) !== undefined) throw new Error("task recovery required: document is archived, not published, or behind retained history");
	return loaded.loaded;
}

/** Full reconciliation by ID. No caller-created identities, no status overwrite. */
export function reconcilePlanTasks(base: TaskSet, input: TaskSeed, now: string): TaskSet {
	const seed = parseTaskSeed(input);
	const next = cloneTaskSet(base);
	const phases = new Map(next.phases.map((p) => [p.id, p]));
	const tasks = new Map(next.phases.flatMap((p) => p.tasks.map((t) => [t.id, t] as const)));
	const retained = new Set<string>();
	next.phases = seed.phases.map((p) => {
		const prior = p.id ? phases.get(p.id) : undefined;
		if (p.id && !prior) throw new Error(`unknown phase id ${p.id}`);
		return { id: prior?.id ?? allocatePhaseId(next), name: p.name, tasks: p.tasks.map((t) => {
			const old = t.id ? tasks.get(t.id) : undefined;
			if (t.id && !old) throw new Error(`unknown task id ${t.id}`);
			if (!old) {
				if (t.reopen) throw new Error("new tasks cannot reopen prior work");
				return { id: allocateTaskId(next), content: t.content, status: "pending" as const };
			}
			retained.add(old.id);
			if (isClosedStatus(old.status) && t.content !== old.content && !t.reopen) throw new Error(`task ${old.id} is closed; explicitly reopen it before changing its scope`);
			if (t.reopen) {
				if (!isClosedStatus(old.status)) throw new Error(`task ${old.id} is not closed`);
				if (old.completion) old.completionHistory = [...(old.completionHistory ?? []), old.completion];
				delete old.completion; delete old.blocker; old.status = "pending";
			}
			old.content = t.content; return old;
		}) };
	});
	for (const p of base.phases) {
		if (!next.phases.some((n) => n.id === p.id)) next.removedPhases.push({ id: p.id, name: p.name, removedAt: now });
		for (const t of p.tasks) if (!retained.has(t.id)) next.removedTasks.push({ id: t.id, phaseId: p.id, content: t.content, status: t.status, ...(t.completion ? { completion: t.completion } : {}), removedAt: now });
	}
	trimRemovedRecords(next);
	return next;
}
export function planTaskDiff(base: TaskSet, next: TaskSet): string {
	const changes = diffTaskSets(base, next);
	const order = (s: TaskSet) => s.phases.map((p) => `${p.id}:${p.tasks.map((t) => t.id).join(",")}`).join(";");
	if (order(base) !== order(next)) changes.push("~ phase/task order updated (IDs and retained progress preserved)");
	return changes.join("\n") || "No task scope changes; existing progress and evidence retained.";
}

export async function bindPlanTasks(input: {
	root: string; taskSetId: string; binding: PlanBinding; tasks: TaskSeed; now: string; signal: AbortSignal;
}): Promise<LoadedDocument> {
	const current = await readBoundTasks(input.root, input.taskSetId);
	if (current && current.document.set.binding?.planId !== input.binding.planId) throw new Error("task set belongs to another plan or is standalone; it will not be overwritten");
	const base = current?.document.set ?? createTaskSet(input.taskSetId, input.now);
	const requestDigest = createHash("sha256").update(JSON.stringify(parseTaskSeed(input.tasks))).digest("hex");
	// Exact retries return current progress, never re-apply a reopen or allocation.
	if (sameBinding(base.binding, input.binding)) {
		if (base.binding?.requestDigest !== requestDigest) throw new Error("conflicting repeated plan binding");
		return current!;
	}
	if (current && input.tasks.expectedTaskRevision !== base.revision) throw new Error(`stale tasks: expectedTaskRevision must be ${base.revision}`);
	if (!current && input.tasks.expectedTaskRevision !== undefined && input.tasks.expectedTaskRevision !== 0) throw new Error("new task binding requires revision 0");
	if (base.binding && input.binding.specRevision <= base.binding.specRevision) throw new Error("plan binding cannot move backwards or change digest at the same revision");
	const next = reconcilePlanTasks(base, input.tasks, input.now);
	next.binding = { ...input.binding, requestDigest };
	const result = await commitTaskDocument({ root: input.root, taskSetId: input.taskSetId, document: { set: next, extras: current?.document.extras ?? [] }, expectedDigest: current?.digest, now: input.now, signal: input.signal });
	if (result.kind === "conflict") {
		const won = await readBoundTasks(input.root, input.taskSetId);
		if (won && sameBinding(won.document.set.binding, input.binding) && won.document.set.binding?.requestDigest === requestDigest) return won;
	}
	if (result.kind !== "committed" || result.historyPending || result.lockCompromised) throw new Error(`task binding not acknowledged: ${result.kind}`);
	const committed = await readBoundTasks(input.root, input.taskSetId);
	if (!committed || !sameBinding(committed.document.set.binding, input.binding)) throw new Error("task binding changed before acknowledgement");
	return committed;
}
