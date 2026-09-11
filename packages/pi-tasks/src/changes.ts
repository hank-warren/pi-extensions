/**
 * The batch: every mutation a task set can undergo, validated as one unit.
 *
 * `applyTaskChanges` is pure. It takes a set, returns a new set or an error,
 * and never touches the filesystem — which is what lets the store validate the
 * whole batch against a freshly read document *under the lock* and commit only
 * if every change in it is legal. A batch that fails half way through would
 * leave a task list nobody authored, so there is no partial commit: the caller
 * gets `{ ok: false }` and the accepted document is untouched.
 *
 * Three refusals are deliberate and are not conveniences waiting to be added:
 *
 *   - Starting a second task refuses instead of demoting the first. "What am I
 *     working on" has one answer, and silently moving it is how a task list
 *     starts lying.
 *   - Closing or re-scoping a closed task refuses instead of reopening it for
 *     you. Reopen is a decision about whether the recorded completion still
 *     counts, and it belongs to whoever is making it, in the same batch.
 *   - `init` refuses to replace an attached set. Losing a task list to a
 *     re-initialization is the single most expensive accident available here.
 */

import {
	allocatePhaseId,
	allocateTaskId,
	cloneTaskSet,
	findPhase,
	findTask,
	inProgressTask,
	isClosedStatus,
	MAX_BLOCKER_LENGTH,
	MAX_PHASE_NAME_LENGTH,
	MAX_PHASES,
	MAX_TASK_CONTENT_LENGTH,
	MAX_TASKS_PER_PHASE,
	type Phase,
	type Task,
	type TaskSet,
	trimRemovedRecords,
	validateSummary,
	validateText,
} from "./model.js";

export interface InitPhaseInput {
	name: string;
	tasks: string[];
}

export type TaskChange =
	| { op: "init"; label?: string; phases: InitPhaseInput[] }
	| { op: "add_phase"; name: string; beforePhaseId?: string }
	| { op: "rename_phase"; phaseId: string; name: string }
	| { op: "add_task"; phaseId: string; content: string; beforeTaskId?: string }
	| { op: "edit_task"; taskId: string; content: string; labelOnly?: boolean }
	| { op: "move_task"; taskId: string; phaseId: string; beforeTaskId?: string }
	| { op: "start"; taskId: string }
	| { op: "done"; taskId: string; summary: string }
	| { op: "block"; taskId: string; blocker: string }
	| { op: "unblock"; taskId: string }
	| { op: "abandon"; taskId: string; summary: string }
	| { op: "reopen"; taskId: string }
	| { op: "remove_task"; taskId: string }
	| { op: "remove_phase"; phaseId: string };

export const TASK_CHANGE_OPS = [
	"init",
	"add_phase",
	"rename_phase",
	"add_task",
	"edit_task",
	"move_task",
	"start",
	"done",
	"block",
	"unblock",
	"abandon",
	"reopen",
	"remove_task",
	"remove_phase",
] as const;

/** Ops that only move a task through its lifecycle: safe to apply directly. */
const PROGRESS_OPS = new Set(["start", "done", "block", "unblock", "abandon"]);

/** Whether a batch only reports progress, rather than changing what the work is. */
export function isProgressOnlyBatch(changes: readonly TaskChange[]): boolean {
	return changes.every(
		(change) =>
			PROGRESS_OPS.has(change.op) || (change.op === "edit_task" && change.labelOnly === true),
	);
}

export interface AllocatedPhase {
	id: string;
	name: string;
}

export interface AllocatedTask {
	id: string;
	phaseId: string;
	content: string;
}

export interface ApplyResult {
	set: TaskSet;
	allocatedPhases: AllocatedPhase[];
	allocatedTasks: AllocatedTask[];
	/** One line per applied change, for the tool result and the review card. */
	applied: string[];
}

export type ApplyOutcome = { ok: true; result: ApplyResult } | { ok: false; error: string };

export interface ApplyOptions {
	now: string;
	/**
	 * True when the caller already owns a task set. `init` refuses in that case
	 * rather than replacing it.
	 */
	hasExistingSet: boolean;
	/** Allocates ids for a brand new set created by `init`. */
	newTaskSetId?: () => string;
}

export function applyTaskChanges(
	base: TaskSet,
	changes: readonly TaskChange[],
	options: ApplyOptions,
): ApplyOutcome {
	if (changes.length === 0) return { ok: false, error: "changes must contain at least one change" };
	const initCount = changes.filter((change) => change.op === "init").length;
	if (initCount > 0 && changes.length > 1) {
		return { ok: false, error: "init must be the only change in a batch" };
	}

	const set = cloneTaskSet(base);
	const allocatedPhases: AllocatedPhase[] = [];
	const allocatedTasks: AllocatedTask[] = [];
	const applied: string[] = [];
	/** Tasks reopened earlier in this batch, so a later edit in it is allowed. */
	const reopenedInBatch = new Set<string>();

	for (const [index, change] of changes.entries()) {
		const outcome = applyOne(set, change, options, {
			allocatedPhases,
			allocatedTasks,
			applied,
			reopenedInBatch,
		});
		if (!outcome.ok) {
			return { ok: false, error: `change ${index + 1} (${change.op}): ${outcome.error}` };
		}
	}

	set.updatedAt = options.now;
	trimRemovedRecords(set);
	return { ok: true, result: { set, allocatedPhases, allocatedTasks, applied } };
}

interface ApplyAccumulator {
	allocatedPhases: AllocatedPhase[];
	allocatedTasks: AllocatedTask[];
	applied: string[];
	reopenedInBatch: Set<string>;
}

type OneOutcome = { ok: true } | { ok: false; error: string };

function applyOne(
	set: TaskSet,
	change: TaskChange,
	options: ApplyOptions,
	accumulator: ApplyAccumulator,
): OneOutcome {
	switch (change.op) {
		case "init":
			return applyInit(set, change, options, accumulator);
		case "add_phase":
			return applyAddPhase(set, change, accumulator);
		case "rename_phase":
			return applyRenamePhase(set, change, accumulator);
		case "add_task":
			return applyAddTask(set, change, accumulator);
		case "edit_task":
			return applyEditTask(set, change, accumulator);
		case "move_task":
			return applyMoveTask(set, change, accumulator);
		case "start":
			return applyStart(set, change, accumulator);
		case "done":
			return applyDone(set, change, options, accumulator);
		case "block":
			return applyBlock(set, change, accumulator);
		case "unblock":
			return applyUnblock(set, change, accumulator);
		case "abandon":
			return applyAbandon(set, change, options, accumulator);
		case "reopen":
			return applyReopen(set, change, accumulator);
		case "remove_task":
			return applyRemoveTask(set, change, options, accumulator);
		case "remove_phase":
			return applyRemovePhase(set, change, options, accumulator);
	}
}

function applyInit(
	set: TaskSet,
	change: Extract<TaskChange, { op: "init" }>,
	options: ApplyOptions,
	accumulator: ApplyAccumulator,
): OneOutcome {
	if (options.hasExistingSet) {
		return {
			ok: false,
			error:
				"a task set is already attached to this session; init never replaces one. Archive it with /tasks archive, or start a new one with /tasks new, then init again",
		};
	}
	if (!Array.isArray(change.phases) || change.phases.length === 0) {
		return { ok: false, error: "phases must contain at least one phase" };
	}
	if (change.phases.length > MAX_PHASES) {
		return { ok: false, error: `phases must not exceed ${MAX_PHASES} entries` };
	}
	if (change.label !== undefined) {
		const label = validateText(change.label, "label", MAX_PHASE_NAME_LENGTH);
		if (!label.ok) return label;
		set.label = label.value;
	}
	if (options.newTaskSetId) set.taskSetId = options.newTaskSetId();

	for (const [phaseIndex, rawPhase] of change.phases.entries()) {
		const name = validateText(rawPhase?.name, `phases[${phaseIndex}].name`, MAX_PHASE_NAME_LENGTH);
		if (!name.ok) return name;
		if (!Array.isArray(rawPhase.tasks) || rawPhase.tasks.length === 0) {
			return { ok: false, error: `phases[${phaseIndex}].tasks must contain at least one task` };
		}
		if (rawPhase.tasks.length > MAX_TASKS_PER_PHASE) {
			return {
				ok: false,
				error: `phases[${phaseIndex}].tasks must not exceed ${MAX_TASKS_PER_PHASE} entries`,
			};
		}
		const phase: Phase = { id: allocatePhaseId(set), name: name.value, tasks: [] };
		accumulator.allocatedPhases.push({ id: phase.id, name: phase.name });
		for (const [taskIndex, rawTask] of rawPhase.tasks.entries()) {
			const content = validateText(
				rawTask,
				`phases[${phaseIndex}].tasks[${taskIndex}]`,
				MAX_TASK_CONTENT_LENGTH,
			);
			if (!content.ok) return content;
			const task: Task = { id: allocateTaskId(set), content: content.value, status: "pending" };
			phase.tasks.push(task);
			accumulator.allocatedTasks.push({
				id: task.id,
				phaseId: phase.id,
				content: task.content,
			});
		}
		set.phases.push(phase);
	}
	accumulator.applied.push(
		`init: ${set.phases.length} phase(s), ${accumulator.allocatedTasks.length} task(s)`,
	);
	return { ok: true };
}

function applyAddPhase(
	set: TaskSet,
	change: Extract<TaskChange, { op: "add_phase" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	if (set.phases.length >= MAX_PHASES) {
		return { ok: false, error: `a task set may not exceed ${MAX_PHASES} phases` };
	}
	const name = validateText(change.name, "name", MAX_PHASE_NAME_LENGTH);
	if (!name.ok) return name;
	const phase: Phase = { id: allocatePhaseId(set), name: name.value, tasks: [] };
	if (change.beforePhaseId !== undefined) {
		const index = set.phases.findIndex((candidate) => candidate.id === change.beforePhaseId);
		if (index < 0) return { ok: false, error: `unknown phase id: ${change.beforePhaseId}` };
		set.phases.splice(index, 0, phase);
	} else {
		set.phases.push(phase);
	}
	accumulator.allocatedPhases.push({ id: phase.id, name: phase.name });
	accumulator.applied.push(`add_phase ${phase.id}: ${phase.name}`);
	return { ok: true };
}

function applyRenamePhase(
	set: TaskSet,
	change: Extract<TaskChange, { op: "rename_phase" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const phase = findPhase(set, change.phaseId);
	if (!phase) return { ok: false, error: `unknown phase id: ${change.phaseId}` };
	const name = validateText(change.name, "name", MAX_PHASE_NAME_LENGTH);
	if (!name.ok) return name;
	accumulator.applied.push(`rename_phase ${phase.id}: ${phase.name} -> ${name.value}`);
	phase.name = name.value;
	return { ok: true };
}

function applyAddTask(
	set: TaskSet,
	change: Extract<TaskChange, { op: "add_task" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const phase = findPhase(set, change.phaseId);
	if (!phase) return { ok: false, error: `unknown phase id: ${change.phaseId}` };
	if (phase.tasks.length >= MAX_TASKS_PER_PHASE) {
		return { ok: false, error: `a phase may not exceed ${MAX_TASKS_PER_PHASE} tasks` };
	}
	const content = validateText(change.content, "content", MAX_TASK_CONTENT_LENGTH);
	if (!content.ok) return content;
	const task: Task = { id: allocateTaskId(set), content: content.value, status: "pending" };
	if (change.beforeTaskId !== undefined) {
		const index = phase.tasks.findIndex((candidate) => candidate.id === change.beforeTaskId);
		if (index < 0) {
			return {
				ok: false,
				error: `unknown task id in phase ${phase.id}: ${change.beforeTaskId}`,
			};
		}
		phase.tasks.splice(index, 0, task);
	} else {
		phase.tasks.push(task);
	}
	accumulator.allocatedTasks.push({ id: task.id, phaseId: phase.id, content: task.content });
	accumulator.applied.push(`add_task ${task.id} in ${phase.id}: ${task.content}`);
	return { ok: true };
}

function applyEditTask(
	set: TaskSet,
	change: Extract<TaskChange, { op: "edit_task" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	const content = validateText(change.content, "content", MAX_TASK_CONTENT_LENGTH);
	if (!content.ok) return content;
	const labelOnly = change.labelOnly === true;
	if (isClosedStatus(location.task.status) && !labelOnly) {
		return {
			ok: false,
			error: `task ${location.task.id} is ${location.task.status}; a scope-changing edit needs an explicit reopen in the same batch, or labelOnly: true for a wording fix that keeps the recorded completion`,
		};
	}
	if (labelOnly && accumulator.reopenedInBatch.has(location.task.id)) {
		return {
			ok: false,
			error: `task ${location.task.id} was reopened in this batch, so the edit is scope-changing: drop labelOnly`,
		};
	}
	accumulator.applied.push(
		`edit_task ${location.task.id}${labelOnly ? " (label only)" : ""}: ${location.task.content} -> ${content.value}`,
	);
	location.task.content = content.value;
	return { ok: true };
}

function applyMoveTask(
	set: TaskSet,
	change: Extract<TaskChange, { op: "move_task" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	const target = findPhase(set, change.phaseId);
	if (!target) return { ok: false, error: `unknown phase id: ${change.phaseId}` };
	if (target.id !== location.phase.id && target.tasks.length >= MAX_TASKS_PER_PHASE) {
		return { ok: false, error: `a phase may not exceed ${MAX_TASKS_PER_PHASE} tasks` };
	}
	if (change.beforeTaskId !== undefined && change.beforeTaskId === change.taskId) {
		return { ok: false, error: "beforeTaskId must not be the task being moved" };
	}
	location.phase.tasks.splice(location.taskIndex, 1);
	if (change.beforeTaskId !== undefined) {
		const index = target.tasks.findIndex((candidate) => candidate.id === change.beforeTaskId);
		if (index < 0) {
			// Put it back: a failed change must leave the clone untouched, because
			// the caller reports the error and keeps the batch's earlier work only
			// when every change succeeds.
			location.phase.tasks.splice(location.taskIndex, 0, location.task);
			return { ok: false, error: `unknown task id in phase ${target.id}: ${change.beforeTaskId}` };
		}
		target.tasks.splice(index, 0, location.task);
	} else {
		target.tasks.push(location.task);
	}
	accumulator.applied.push(
		`move_task ${location.task.id}: ${location.phase.id} -> ${target.id}`,
	);
	return { ok: true };
}

function applyStart(
	set: TaskSet,
	change: Extract<TaskChange, { op: "start" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	if (location.task.status === "in_progress") return { ok: true };
	if (isClosedStatus(location.task.status)) {
		return {
			ok: false,
			error: `task ${location.task.id} is ${location.task.status}; reopen it in the same batch before starting it`,
		};
	}
	const active = inProgressTask(set);
	if (active && active.task.id !== location.task.id) {
		return {
			ok: false,
			error: `task ${active.task.id} is already in progress ("${active.task.content}"); close, block, or abandon it before starting another`,
		};
	}
	location.task.status = "in_progress";
	delete location.task.blocker;
	accumulator.applied.push(`start ${location.task.id}: ${location.task.content}`);
	return { ok: true };
}

function applyDone(
	set: TaskSet,
	change: Extract<TaskChange, { op: "done" }>,
	options: ApplyOptions,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	if (isClosedStatus(location.task.status)) {
		return {
			ok: false,
			error: `task ${location.task.id} is already ${location.task.status}; reopen it in the same batch to record a new completion`,
		};
	}
	const summary = validateSummary(change.summary, "summary");
	if (!summary.ok) return summary;
	location.task.status = "completed";
	delete location.task.blocker;
	location.task.completion = { summary: summary.value, recordedAt: options.now };
	accumulator.applied.push(`done ${location.task.id}: ${location.task.content}`);
	return { ok: true };
}

function applyBlock(
	set: TaskSet,
	change: Extract<TaskChange, { op: "block" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	if (isClosedStatus(location.task.status)) {
		return {
			ok: false,
			error: `task ${location.task.id} is ${location.task.status}; reopen it in the same batch before blocking it`,
		};
	}
	const blocker = validateText(change.blocker, "blocker", MAX_BLOCKER_LENGTH);
	if (!blocker.ok) return blocker;
	location.task.status = "blocked";
	location.task.blocker = blocker.value;
	accumulator.applied.push(`block ${location.task.id}: ${blocker.value}`);
	return { ok: true };
}

function applyUnblock(
	set: TaskSet,
	change: Extract<TaskChange, { op: "unblock" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	if (location.task.status !== "blocked") {
		return { ok: false, error: `task ${location.task.id} is ${location.task.status}, not blocked` };
	}
	// Back to pending, never straight to in progress: resuming work is a
	// decision, and `start` is where it is recorded.
	location.task.status = "pending";
	delete location.task.blocker;
	accumulator.applied.push(`unblock ${location.task.id}`);
	return { ok: true };
}

function applyAbandon(
	set: TaskSet,
	change: Extract<TaskChange, { op: "abandon" }>,
	options: ApplyOptions,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	if (isClosedStatus(location.task.status)) {
		return {
			ok: false,
			error: `task ${location.task.id} is already ${location.task.status}; reopen it in the same batch to change that`,
		};
	}
	const summary = validateSummary(change.summary, "summary");
	if (!summary.ok) return summary;
	location.task.status = "abandoned";
	delete location.task.blocker;
	location.task.completion = { summary: summary.value, recordedAt: options.now };
	accumulator.applied.push(`abandon ${location.task.id}: ${location.task.content}`);
	return { ok: true };
}

function applyReopen(
	set: TaskSet,
	change: Extract<TaskChange, { op: "reopen" }>,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	if (!isClosedStatus(location.task.status)) {
		return {
			ok: false,
			error: `task ${location.task.id} is ${location.task.status}, so there is nothing to reopen`,
		};
	}
	const previous = location.task.completion;
	if (previous) {
		location.task.completionHistory = [...(location.task.completionHistory ?? []), previous];
		delete location.task.completion;
	}
	location.task.status = "pending";
	accumulator.reopenedInBatch.add(location.task.id);
	accumulator.applied.push(`reopen ${location.task.id}: ${location.task.content}`);
	return { ok: true };
}

function applyRemoveTask(
	set: TaskSet,
	change: Extract<TaskChange, { op: "remove_task" }>,
	options: ApplyOptions,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const location = findTask(set, change.taskId);
	if (!location) return { ok: false, error: `unknown task id: ${change.taskId}` };
	location.phase.tasks.splice(location.taskIndex, 1);
	set.removedTasks.push({
		id: location.task.id,
		phaseId: location.phase.id,
		content: location.task.content,
		status: location.task.status,
		...(location.task.completion ? { completion: { ...location.task.completion } } : {}),
		removedAt: options.now,
	});
	accumulator.applied.push(`remove_task ${location.task.id}: ${location.task.content}`);
	return { ok: true };
}

function applyRemovePhase(
	set: TaskSet,
	change: Extract<TaskChange, { op: "remove_phase" }>,
	options: ApplyOptions,
	accumulator: ApplyAccumulator,
): OneOutcome {
	const index = set.phases.findIndex((phase) => phase.id === change.phaseId);
	if (index < 0) return { ok: false, error: `unknown phase id: ${change.phaseId}` };
	const phase = set.phases[index];
	if (!phase) return { ok: false, error: `unknown phase id: ${change.phaseId}` };
	if (phase.tasks.length > 0) {
		return {
			ok: false,
			error: `phase ${phase.id} still holds ${phase.tasks.length} task(s); remove or move each one first — remove_phase never deletes work in bulk`,
		};
	}
	set.phases.splice(index, 1);
	set.removedPhases.push({ id: phase.id, name: phase.name, removedAt: options.now });
	accumulator.applied.push(`remove_phase ${phase.id}: ${phase.name}`);
	return { ok: true };
}
