/**
 * The task set: what a phased task list *is*, independent of how it is stored,
 * mutated, or displayed.
 *
 * Two rules shape every type here.
 *
 * Identity is allocated, never inferred. `nextPhaseId` and `nextTaskId` are
 * monotonic counters, an id is never reused inside a set, and nothing in this
 * module matches a task by its text. Content-as-identity is what makes a
 * renamed task a *different* task and silently orphans its completion history,
 * and it is the defect this package exists to not have.
 *
 * Closing a task keeps its evidence. A completion is a recorded assertion with
 * a timestamp, and reopening moves it into `completionHistory` rather than
 * dropping it: "this was called done once, and here is what was claimed" is
 * exactly the thing a revised scope needs to re-examine.
 */

export const TASKS_SCHEMA_VERSION = 1;

/** Five execution states. `completed` and `abandoned` are terminal. */
export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "abandoned";

export const TASK_STATUSES: readonly TaskStatus[] = [
	"pending",
	"in_progress",
	"blocked",
	"completed",
	"abandoned",
];

/** Statuses that still represent outstanding work. */
export const OPEN_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "blocked"];

export function isOpenStatus(status: TaskStatus): boolean {
	return OPEN_STATUSES.includes(status);
}

export function isClosedStatus(status: TaskStatus): boolean {
	return !isOpenStatus(status);
}

/**
 * What the agent asserted when it closed a task. It is evidence of a claim,
 * not proof that the claim is true; nothing in this package verifies it.
 */
export interface TaskCompletion {
	summary: string;
	recordedAt: string;
}

export interface Task {
	id: string;
	content: string;
	status: TaskStatus;
	/** Set only while `status === "blocked"`: what the task is waiting for. */
	blocker?: string;
	/** Set only while `status === "completed"` or `"abandoned"`. */
	completion?: TaskCompletion;
	/** Completions superseded by a reopen, oldest first. Never dropped. */
	completionHistory?: TaskCompletion[];
}

export interface Phase {
	id: string;
	name: string;
	tasks: Task[];
}

/**
 * Reserved for the plan/task integration layer: which plan revision this set
 * was reviewed against. Layer 1 stores and reports it and never sets it.
 */
export interface TaskBinding {
	planId: string;
	specRevision: number;
	digest: string;
}

/** A task that left the document. The id is burned; the record is not. */
export interface RemovedTask {
	id: string;
	phaseId: string;
	content: string;
	status: TaskStatus;
	completion?: TaskCompletion;
	removedAt: string;
}

export interface RemovedPhase {
	id: string;
	name: string;
	removedAt: string;
}

export interface TaskSet {
	schemaVersion: typeof TASKS_SCHEMA_VERSION;
	taskSetId: string;
	/** Monotonic; every accepted commit increments it by one. */
	revision: number;
	label?: string;
	createdAt: string;
	updatedAt: string;
	/** Set when the set was archived; an archived set refuses mutation. */
	archivedAt?: string;
	nextPhaseId: number;
	nextTaskId: number;
	phases: Phase[];
	binding?: TaskBinding;
	removedTasks: RemovedTask[];
	removedPhases: RemovedPhase[];
}

export const MAX_TASK_CONTENT_LENGTH = 2_000;
export const MAX_PHASE_NAME_LENGTH = 200;
export const MAX_SUMMARY_LENGTH = 4_000;
export const MAX_BLOCKER_LENGTH = 1_000;
export const MAX_LABEL_LENGTH = 200;
export const MAX_PHASES = 100;
export const MAX_TASKS_PER_PHASE = 200;
/** Bounded so a long-lived set cannot grow its metadata without limit. */
export const MAX_REMOVED_RECORDS = 500;

/**
 * Task and phase text is written into an annotated Markdown document, so a
 * comment delimiter in the text would end the annotation early and corrupt the
 * line. Newlines would split one task across two lines. Both are refused at the
 * edge rather than escaped: an escape scheme is a second format to get wrong,
 * and neither character belongs in a task title.
 */
export function validateText(
	value: unknown,
	field: string,
	maxLength: number,
): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
	const trimmed = value.trim();
	if (!trimmed) return { ok: false, error: `${field} must not be empty` };
	if (trimmed.length > maxLength) {
		return { ok: false, error: `${field} must not exceed ${maxLength} characters` };
	}
	if (/[\r\n]/u.test(trimmed)) return { ok: false, error: `${field} must be a single line` };
	if (trimmed.includes("\0")) return { ok: false, error: `${field} must not contain NUL` };
	if (trimmed.includes("<!--") || trimmed.includes("-->")) {
		return { ok: false, error: `${field} must not contain an HTML comment delimiter` };
	}
	return { ok: true, value: trimmed };
}

/** A completion summary may wrap, so only the comment delimiters are refused. */
export function validateSummary(
	value: unknown,
	field: string,
): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
	const trimmed = value.trim();
	if (!trimmed) return { ok: false, error: `${field} must not be empty` };
	if (trimmed.length > MAX_SUMMARY_LENGTH) {
		return { ok: false, error: `${field} must not exceed ${MAX_SUMMARY_LENGTH} characters` };
	}
	if (trimmed.includes("\0")) return { ok: false, error: `${field} must not contain NUL` };
	if (trimmed.includes("<!--") || trimmed.includes("-->")) {
		return { ok: false, error: `${field} must not contain an HTML comment delimiter` };
	}
	return { ok: true, value: trimmed };
}

export function createTaskSet(taskSetId: string, now: string, label?: string): TaskSet {
	return {
		schemaVersion: TASKS_SCHEMA_VERSION,
		taskSetId,
		revision: 0,
		...(label ? { label } : {}),
		createdAt: now,
		updatedAt: now,
		nextPhaseId: 1,
		nextTaskId: 1,
		phases: [],
		removedTasks: [],
		removedPhases: [],
	};
}

export function cloneTask(task: Task): Task {
	return {
		id: task.id,
		content: task.content,
		status: task.status,
		...(task.blocker !== undefined ? { blocker: task.blocker } : {}),
		...(task.completion ? { completion: { ...task.completion } } : {}),
		...(task.completionHistory
			? { completionHistory: task.completionHistory.map((entry) => ({ ...entry })) }
			: {}),
	};
}

export function cloneTaskSet(set: TaskSet): TaskSet {
	return {
		...set,
		...(set.binding ? { binding: { ...set.binding } } : {}),
		phases: set.phases.map((phase) => ({
			id: phase.id,
			name: phase.name,
			tasks: phase.tasks.map(cloneTask),
		})),
		removedTasks: set.removedTasks.map((entry) => ({ ...entry })),
		removedPhases: set.removedPhases.map((entry) => ({ ...entry })),
	};
}

export interface TaskLocation {
	phase: Phase;
	task: Task;
	taskIndex: number;
}

export function findTask(set: TaskSet, taskId: string): TaskLocation | undefined {
	for (const phase of set.phases) {
		const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
		if (taskIndex >= 0) {
			const task = phase.tasks[taskIndex];
			if (task) return { phase, task, taskIndex };
		}
	}
	return undefined;
}

export function findPhase(set: TaskSet, phaseId: string): Phase | undefined {
	return set.phases.find((phase) => phase.id === phaseId);
}

export function allTasks(set: TaskSet): Task[] {
	return set.phases.flatMap((phase) => phase.tasks);
}

export function inProgressTask(set: TaskSet): TaskLocation | undefined {
	for (const phase of set.phases) {
		const taskIndex = phase.tasks.findIndex((task) => task.status === "in_progress");
		if (taskIndex >= 0) {
			const task = phase.tasks[taskIndex];
			if (task) return { phase, task, taskIndex };
		}
	}
	return undefined;
}

export interface TaskCounts {
	total: number;
	pending: number;
	inProgress: number;
	blocked: number;
	completed: number;
	abandoned: number;
	open: number;
}

export function countTasks(set: TaskSet): TaskCounts {
	const counts: TaskCounts = {
		total: 0,
		pending: 0,
		inProgress: 0,
		blocked: 0,
		completed: 0,
		abandoned: 0,
		open: 0,
	};
	for (const task of allTasks(set)) {
		counts.total += 1;
		if (task.status === "pending") counts.pending += 1;
		if (task.status === "in_progress") counts.inProgress += 1;
		if (task.status === "blocked") counts.blocked += 1;
		if (task.status === "completed") counts.completed += 1;
		if (task.status === "abandoned") counts.abandoned += 1;
		if (isOpenStatus(task.status)) counts.open += 1;
	}
	return counts;
}

export function allocatePhaseId(set: TaskSet): string {
	const id = `p${set.nextPhaseId}`;
	set.nextPhaseId += 1;
	return id;
}

export function allocateTaskId(set: TaskSet): string {
	const id = `t${set.nextTaskId}`;
	set.nextTaskId += 1;
	return id;
}

/** Keeps the removed-record lists bounded, oldest first out. */
export function trimRemovedRecords(set: TaskSet): void {
	if (set.removedTasks.length > MAX_REMOVED_RECORDS) {
		set.removedTasks = set.removedTasks.slice(-MAX_REMOVED_RECORDS);
	}
	if (set.removedPhases.length > MAX_REMOVED_RECORDS) {
		set.removedPhases = set.removedPhases.slice(-MAX_REMOVED_RECORDS);
	}
}
