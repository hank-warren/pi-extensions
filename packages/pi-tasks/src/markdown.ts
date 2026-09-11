/**
 * The task document: human-readable Markdown that is also exactly parseable.
 *
 * One datum, one home. The body lines own content, order, and status; the
 * per-task annotation owns the task's id and the fields that have no Markdown
 * spelling (blocker, completion, superseded completions); the single metadata
 * comment owns set-level facts (id, revision, id counters, binding, removal
 * records). Nothing is written twice, so nothing can disagree with itself.
 *
 * Lines the parser does not recognise are not errors and are not dropped: they
 * are kept verbatim, anchored to the element they followed, and written back in
 * place. That is what makes a status-only update leave the rest of a document
 * — notes under a phase, a paragraph of context — exactly as it was.
 *
 * The annotations are the package's business, not the user's. `/tasks` and the
 * tools are the supported way to change a task set; the file is readable, and
 * an edit to it is detected as a conflict rather than silently absorbed.
 */

import {
	MAX_LABEL_LENGTH,
	type Phase,
	type RemovedPhase,
	type RemovedTask,
	type Task,
	type TaskBinding,
	type TaskCompletion,
	type TaskSet,
	type TaskStatus,
	TASK_STATUSES,
	TASKS_SCHEMA_VERSION,
} from "./model.js";

const METADATA_RE = /^<!--\s*pi-tasks:v(\d+)\s+(\{[\s\S]*\})\s*-->$/u;
const PHASE_RE = /^##\s+(.*?)\s*<!--\s*(p[1-9]\d*)\s*-->$/u;
const TASK_RE = /^-\s+\[(.)\]\s+(.*?)\s*<!--\s*(t[1-9]\d*)(?:\s+(\{[\s\S]*\}))?\s*-->$/u;
const TITLE_RE = /^#\s+/u;
const TASK_SET_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{0,63}$/u;

const STATUS_MARKERS: Record<TaskStatus, string> = {
	pending: " ",
	in_progress: "/",
	blocked: "!",
	completed: "x",
	abandoned: "-",
};

const MARKER_STATUSES = new Map<string, TaskStatus>(
	Object.entries(STATUS_MARKERS).map(([status, marker]) => [marker, status as TaskStatus]),
);

/** Where a preserved raw line sits, so it can be written back in place. */
export type ExtraAnchor = { kind: "start" } | { kind: "phase"; id: string } | { kind: "task"; id: string };

export interface DocumentExtra {
	anchor: ExtraAnchor;
	text: string;
}

export interface TaskDocument {
	set: TaskSet;
	extras: DocumentExtra[];
}

export type ParseResult = { ok: true; document: TaskDocument } | { ok: false; error: string };

interface TaskAnnotation {
	blocker?: string;
	completion?: TaskCompletion;
	completionHistory?: TaskCompletion[];
}

interface SetMetadata {
	schemaVersion: number;
	taskSetId: string;
	revision: number;
	label?: string;
	createdAt: string;
	updatedAt: string;
	archivedAt?: string;
	nextPhaseId: number;
	nextTaskId: number;
	binding?: TaskBinding;
	removedTasks: RemovedTask[];
	removedPhases: RemovedPhase[];
}

/**
 * Heading for the lines whose anchor has gone. Emitted only when there are
 * such lines, so an ordinary document never grows a section it did not have.
 */
export const ORPHANED_EXTRAS_HEADING = "<!-- pi-tasks: lines whose task or phase was removed -->";

export function serializeTaskDocument(document: TaskDocument): string {
	const { set, extras } = document;
	const byAnchor = groupExtras(extras);
	const emitted = new Set<string>(["start"]);
	const lines: string[] = [];
	lines.push(`# ${set.label ? `Tasks — ${set.label}` : "Tasks"}`);
	lines.push("");
	lines.push(`<!-- pi-tasks:v${TASKS_SCHEMA_VERSION} ${JSON.stringify(setMetadata(set))} -->`);
	lines.push(...(byAnchor.get("start") ?? []));

	for (const phase of set.phases) {
		lines.push("");
		lines.push(`## ${phase.name} <!-- ${phase.id} -->`);
		const phaseKey = `phase:${phase.id}`;
		emitted.add(phaseKey);
		lines.push(...(byAnchor.get(phaseKey) ?? []));
		if (phase.tasks.length > 0) lines.push("");
		for (const task of phase.tasks) {
			lines.push(serializeTaskLine(task));
			const taskKey = `task:${task.id}`;
			emitted.add(taskKey);
			lines.push(...(byAnchor.get(taskKey) ?? []));
		}
	}

	// A line the user wrote under a task that has since been removed has no
	// anchor left to sit beside. Dropping it would be a silent deletion of
	// something this package never owned, so it is retained at the end instead,
	// in the order it was read. Re-parsing re-anchors it to the last task, which
	// makes the placement stable rather than drifting on every write.
	const orphaned = extras.filter((extra) => !emitted.has(anchorKey(extra.anchor)));
	if (orphaned.length > 0) {
		lines.push("");
		lines.push(ORPHANED_EXTRAS_HEADING);
		lines.push(...orphaned.map((extra) => extra.text));
	}
	return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function serializeTaskLine(task: Task): string {
	const annotation: TaskAnnotation = {};
	if (task.blocker !== undefined) annotation.blocker = task.blocker;
	if (task.completion) annotation.completion = task.completion;
	if (task.completionHistory && task.completionHistory.length > 0) {
		annotation.completionHistory = task.completionHistory;
	}
	const payload = Object.keys(annotation).length > 0 ? ` ${JSON.stringify(annotation)}` : "";
	return `- [${STATUS_MARKERS[task.status]}] ${task.content} <!-- ${task.id}${payload} -->`;
}

function setMetadata(set: TaskSet): SetMetadata {
	return {
		schemaVersion: TASKS_SCHEMA_VERSION,
		taskSetId: set.taskSetId,
		revision: set.revision,
		...(set.label ? { label: set.label } : {}),
		createdAt: set.createdAt,
		updatedAt: set.updatedAt,
		...(set.archivedAt ? { archivedAt: set.archivedAt } : {}),
		nextPhaseId: set.nextPhaseId,
		nextTaskId: set.nextTaskId,
		...(set.binding ? { binding: set.binding } : {}),
		removedTasks: set.removedTasks,
		removedPhases: set.removedPhases,
	};
}

function anchorKey(anchor: ExtraAnchor): string {
	return anchor.kind === "start" ? "start" : `${anchor.kind}:${anchor.id}`;
}

function groupExtras(extras: readonly DocumentExtra[]): Map<string, string[]> {
	const grouped = new Map<string, string[]>();
	for (const extra of extras) {
		const key = anchorKey(extra.anchor);
		grouped.set(key, [...(grouped.get(key) ?? []), extra.text]);
	}
	return grouped;
}

export function parseTaskDocument(text: string): ParseResult {
	const lines = text.split("\n");
	let metadata: SetMetadata | undefined;
	let sawTitle = false;
	const phases: Phase[] = [];
	const extras: DocumentExtra[] = [];
	const seenPhaseIds = new Set<string>();
	const seenTaskIds = new Set<string>();
	let anchor: ExtraAnchor = { kind: "start" };
	let currentPhase: Phase | undefined;
	/**
	 * Blank lines are held until the next line says what they were.
	 *
	 * A blank between two lines of someone's note is part of the note — dropping
	 * it collapses their paragraphs into one. A blank before a heading or a task
	 * is a separator this serializer emitted itself, and keeping it would grow the
	 * document by one line on every write. Only the first kind is flushed.
	 */
	let pendingBlanks: string[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		// Our own marker for retained orphans: structural, so it is regenerated on
		// each write rather than kept as an extra that would re-emit a second copy.
		if (line.trim() === ORPHANED_EXTRAS_HEADING) {
			pendingBlanks = [];
			continue;
		}
		const metadataMatch = METADATA_RE.exec(line.trim());
		if (metadataMatch) {
			if (metadata) return { ok: false, error: "document has more than one metadata comment" };
			const parsed = parseMetadata(metadataMatch[1], metadataMatch[2]);
			if (!parsed.ok) return parsed;
			metadata = parsed.metadata;
			pendingBlanks = [];
			continue;
		}
		if (!sawTitle && TITLE_RE.test(line)) {
			// The title is derived from the label on every write, so the original
			// line is not kept as an extra; keeping it would duplicate the heading.
			sawTitle = true;
			pendingBlanks = [];
			continue;
		}
		const phaseMatch = PHASE_RE.exec(line);
		if (phaseMatch) {
			pendingBlanks = [];
			const name = phaseMatch[1]?.trim() ?? "";
			const id = phaseMatch[2] ?? "";
			if (!name) return { ok: false, error: `phase ${id} has no name` };
			if (seenPhaseIds.has(id)) return { ok: false, error: `duplicate phase id: ${id}` };
			seenPhaseIds.add(id);
			currentPhase = { id, name, tasks: [] };
			phases.push(currentPhase);
			anchor = { kind: "phase", id };
			continue;
		}
		const taskMatch = TASK_RE.exec(line);
		if (taskMatch) {
			pendingBlanks = [];
			if (!currentPhase) return { ok: false, error: `task ${taskMatch[3]} appears before any phase` };
			const marker = taskMatch[1] ?? "";
			const content = taskMatch[2]?.trim() ?? "";
			const id = taskMatch[3] ?? "";
			const status = MARKER_STATUSES.get(marker);
			if (!status) return { ok: false, error: `task ${id} has an unknown status marker: [${marker}]` };
			if (!content) return { ok: false, error: `task ${id} has no content` };
			if (seenTaskIds.has(id)) return { ok: false, error: `duplicate task id: ${id}` };
			seenTaskIds.add(id);
			const annotation = parseAnnotation(taskMatch[4], id);
			if (!annotation.ok) return annotation;
			const task: Task = { id, content, status };
			if (annotation.value.blocker !== undefined) task.blocker = annotation.value.blocker;
			if (annotation.value.completion) task.completion = annotation.value.completion;
			if (annotation.value.completionHistory) {
				task.completionHistory = annotation.value.completionHistory;
			}
			if (status === "blocked" && task.blocker === undefined) {
				return { ok: false, error: `task ${id} is blocked but records no blocker` };
			}
			currentPhase.tasks.push(task);
			anchor = { kind: "task", id };
			continue;
		}
		if (line.trim() === "") {
			pendingBlanks.push("");
			continue;
		}
		for (const blank of pendingBlanks) extras.push({ anchor, text: blank });
		pendingBlanks = [];
		extras.push({ anchor, text: rawLine });
	}

	if (!metadata) return { ok: false, error: "document has no pi-tasks metadata comment" };
	const idCheck = checkIdCounters(metadata, seenPhaseIds, seenTaskIds);
	if (!idCheck.ok) return idCheck;

	const set: TaskSet = {
		schemaVersion: TASKS_SCHEMA_VERSION,
		taskSetId: metadata.taskSetId,
		revision: metadata.revision,
		...(metadata.label ? { label: metadata.label } : {}),
		createdAt: metadata.createdAt,
		updatedAt: metadata.updatedAt,
		...(metadata.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
		nextPhaseId: metadata.nextPhaseId,
		nextTaskId: metadata.nextTaskId,
		phases,
		...(metadata.binding ? { binding: metadata.binding } : {}),
		removedTasks: metadata.removedTasks,
		removedPhases: metadata.removedPhases,
	};
	const inProgress = phases.flatMap((phase) => phase.tasks).filter((task) => task.status === "in_progress");
	if (inProgress.length > 1) {
		return {
			ok: false,
			error: `document marks ${inProgress.length} tasks in progress; at most one is allowed`,
		};
	}
	return { ok: true, document: { set, extras } };
}

function checkIdCounters(
	metadata: SetMetadata,
	phaseIds: ReadonlySet<string>,
	taskIds: ReadonlySet<string>,
): { ok: true } | { ok: false; error: string } {
	for (const id of phaseIds) {
		const n = Number(id.slice(1));
		if (n >= metadata.nextPhaseId) {
			return { ok: false, error: `phase id ${id} is ahead of nextPhaseId ${metadata.nextPhaseId}` };
		}
	}
	for (const id of taskIds) {
		const n = Number(id.slice(1));
		if (n >= metadata.nextTaskId) {
			return { ok: false, error: `task id ${id} is ahead of nextTaskId ${metadata.nextTaskId}` };
		}
	}
	return { ok: true };
}

function parseAnnotation(
	raw: string | undefined,
	taskId: string,
): { ok: true; value: TaskAnnotation } | { ok: false; error: string } {
	if (raw === undefined) return { ok: true, value: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: `task ${taskId} has an unparseable annotation` };
	}
	if (!isRecord(parsed)) return { ok: false, error: `task ${taskId} annotation must be an object` };
	const value: TaskAnnotation = {};
	if (parsed.blocker !== undefined) {
		if (typeof parsed.blocker !== "string") {
			return { ok: false, error: `task ${taskId} blocker must be a string` };
		}
		value.blocker = parsed.blocker;
	}
	if (parsed.completion !== undefined) {
		const completion = parseCompletion(parsed.completion);
		if (!completion) return { ok: false, error: `task ${taskId} completion is malformed` };
		value.completion = completion;
	}
	if (parsed.completionHistory !== undefined) {
		if (!Array.isArray(parsed.completionHistory)) {
			return { ok: false, error: `task ${taskId} completionHistory must be an array` };
		}
		const history: TaskCompletion[] = [];
		for (const entry of parsed.completionHistory) {
			const completion = parseCompletion(entry);
			if (!completion) return { ok: false, error: `task ${taskId} completionHistory is malformed` };
			history.push(completion);
		}
		if (history.length > 0) value.completionHistory = history;
	}
	return { ok: true, value };
}

function parseCompletion(value: unknown): TaskCompletion | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.summary !== "string" || !value.summary) return undefined;
	if (typeof value.recordedAt !== "string" || !value.recordedAt) return undefined;
	return { summary: value.summary, recordedAt: value.recordedAt };
}

function parseMetadata(
	rawVersion: string | undefined,
	rawJson: string | undefined,
): { ok: true; metadata: SetMetadata } | { ok: false; error: string } {
	const version = Number(rawVersion);
	if (!Number.isSafeInteger(version) || version < 1) {
		return { ok: false, error: `unrecognised pi-tasks schema version: ${rawVersion}` };
	}
	if (version > TASKS_SCHEMA_VERSION) {
		return {
			ok: false,
			error: `document uses pi-tasks schema v${version}; this build understands v${TASKS_SCHEMA_VERSION}. Upgrade @hank-warren/pi-tasks rather than letting an older build rewrite it`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson ?? "");
	} catch {
		return { ok: false, error: "pi-tasks metadata is not valid JSON" };
	}
	if (!isRecord(parsed)) return { ok: false, error: "pi-tasks metadata must be an object" };
	if (parsed.schemaVersion !== version) {
		return { ok: false, error: "pi-tasks metadata schemaVersion does not match the comment" };
	}
	const taskSetId = typeof parsed.taskSetId === "string" ? parsed.taskSetId : "";
	if (!TASK_SET_ID_RE.test(taskSetId)) {
		return { ok: false, error: "pi-tasks metadata taskSetId is missing or unsafe" };
	}
	const revision = parsed.revision;
	if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
		return { ok: false, error: "pi-tasks metadata revision must be a non-negative integer" };
	}
	const nextPhaseId = parsed.nextPhaseId;
	const nextTaskId = parsed.nextTaskId;
	if (!Number.isSafeInteger(nextPhaseId) || (nextPhaseId as number) < 1) {
		return { ok: false, error: "pi-tasks metadata nextPhaseId must be a positive integer" };
	}
	if (!Number.isSafeInteger(nextTaskId) || (nextTaskId as number) < 1) {
		return { ok: false, error: "pi-tasks metadata nextTaskId must be a positive integer" };
	}
	const label = typeof parsed.label === "string" ? parsed.label.slice(0, MAX_LABEL_LENGTH) : undefined;
	const binding = parseBinding(parsed.binding);
	if (binding === null) return { ok: false, error: "pi-tasks metadata binding is malformed" };
	return {
		ok: true,
		metadata: {
			schemaVersion: version,
			taskSetId,
			revision: revision as number,
			...(label ? { label } : {}),
			createdAt: stringOr(parsed.createdAt, ""),
			updatedAt: stringOr(parsed.updatedAt, ""),
			...(typeof parsed.archivedAt === "string" && parsed.archivedAt
				? { archivedAt: parsed.archivedAt }
				: {}),
			nextPhaseId: nextPhaseId as number,
			nextTaskId: nextTaskId as number,
			...(binding ? { binding } : {}),
			removedTasks: parseRemovedTasks(parsed.removedTasks),
			removedPhases: parseRemovedPhases(parsed.removedPhases),
		},
	};
}

/** `null` means present but malformed; `undefined` means absent. */
function parseBinding(value: unknown): TaskBinding | null | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return null;
	if (typeof value.planId !== "string" || !value.planId) return null;
	if (!Number.isSafeInteger(value.specRevision)) return null;
	if (typeof value.digest !== "string" || !value.digest) return null;
	return {
		planId: value.planId,
		specRevision: value.specRevision as number,
		digest: value.digest,
	};
}

function parseRemovedTasks(value: unknown): RemovedTask[] {
	if (!Array.isArray(value)) return [];
	const records: RemovedTask[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || typeof entry.content !== "string") continue;
		const status = TASK_STATUSES.find((candidate) => candidate === entry.status);
		if (!status) continue;
		const completion = parseCompletion(entry.completion);
		records.push({
			id: entry.id,
			phaseId: stringOr(entry.phaseId, ""),
			content: entry.content,
			status,
			...(completion ? { completion } : {}),
			removedAt: stringOr(entry.removedAt, ""),
		});
	}
	return records;
}

function parseRemovedPhases(value: unknown): RemovedPhase[] {
	if (!Array.isArray(value)) return [];
	const records: RemovedPhase[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
		records.push({ id: entry.id, name: entry.name, removedAt: stringOr(entry.removedAt, "") });
	}
	return records;
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
