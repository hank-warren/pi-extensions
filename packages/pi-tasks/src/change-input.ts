/**
 * The wire shape of a change, and the translation into the internal one.
 *
 * The tool schema is deliberately one flat object per change rather than a
 * discriminated union: providers vary in how well they handle `oneOf`, and a
 * model that cannot express the schema cannot use the tool at all. The cost is
 * that "which fields does this op need" cannot live in the schema, so it lives
 * here — checked per op, with an error that names the missing field.
 *
 * Whitespace is trimmed before anything is compared. Models emit `"init\n"`,
 * and Pi does not trim enum values for you, so a schema rejection on a trailing
 * newline is a real failure mode rather than a hypothetical one.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TASK_CHANGE_OPS, type TaskChange } from "./changes.js";

export const TASK_CHANGE_SCHEMA = Type.Object(
	{
		op: StringEnum([...TASK_CHANGE_OPS], {
			description:
				"The change to make. init seeds a brand new set; add_phase/add_task/edit_task/move_task/rename_phase/remove_task/remove_phase change what the work is; start/done/block/unblock/abandon/reopen move a task through its lifecycle.",
		}),
		label: Type.Optional(
			Type.String({ description: "init only: a short name for the whole task set." }),
		),
		phases: Type.Optional(
			Type.Array(
				Type.Object({
					name: Type.String({ description: "Phase name." }),
					tasks: Type.Array(Type.String({ description: "Task content, one line each." }), {
						description: "The tasks of this phase, in order.",
					}),
				}),
				{
					description:
						"init only: the phases and their tasks. Ids are allocated here, so never invent them.",
				},
			),
		),
		name: Type.Optional(
			Type.String({ description: "add_phase and rename_phase: the phase name." }),
		),
		content: Type.Optional(
			Type.String({ description: "add_task and edit_task: the task content, one line." }),
		),
		summary: Type.Optional(
			Type.String({
				description:
					"done and abandon: what was actually done or why the task is being dropped. Required.",
			}),
		),
		blocker: Type.Optional(
			Type.String({ description: "block: what the task is waiting for. Required." }),
		),
		taskId: Type.Optional(
			Type.String({ description: "The exact id of the task this change targets, e.g. t7." }),
		),
		phaseId: Type.Optional(
			Type.String({ description: "The exact id of the phase this change targets, e.g. p2." }),
		),
		beforeTaskId: Type.Optional(
			Type.String({
				description: "add_task and move_task: insert before this task id instead of at the end.",
			}),
		),
		beforePhaseId: Type.Optional(
			Type.String({
				description: "add_phase: insert before this phase id instead of at the end.",
			}),
		),
		labelOnly: Type.Optional(
			Type.Boolean({
				description:
					"edit_task: true only when the wording changes and the work does not. An edit that changes scope is not labelOnly, and a closed task needs an explicit reopen in the same batch.",
			}),
		),
	},
	{ description: "One change to the task set." },
);

export type NormalizeResult = { ok: true; changes: TaskChange[] } | { ok: false; error: string };

export function normalizeChanges(raw: unknown): NormalizeResult {
	if (!Array.isArray(raw)) return { ok: false, error: "changes must be an array" };
	const changes: TaskChange[] = [];
	for (const [index, entry] of raw.entries()) {
		const normalized = normalizeChange(entry, index + 1);
		if (!normalized.ok) return normalized;
		changes.push(normalized.change);
	}
	return { ok: true, changes };
}

type SingleResult = { ok: true; change: TaskChange } | { ok: false; error: string };

function normalizeChange(raw: unknown, position: number): SingleResult {
	if (!isRecord(raw)) return { ok: false, error: `change ${position} must be an object` };
	const op = trimmed(raw.op);
	if (!op || !(TASK_CHANGE_OPS as readonly string[]).includes(op)) {
		return {
			ok: false,
			error: `change ${position}: op must be one of ${TASK_CHANGE_OPS.join(", ")}`,
		};
	}
	const need = (field: string): { ok: true; value: string } | { ok: false; error: string } => {
		const value = trimmed(raw[field]);
		if (!value) {
			return { ok: false, error: `change ${position} (${op}): ${field} is required` };
		}
		return { ok: true, value };
	};
	const optional = (field: string): string | undefined => trimmed(raw[field]) || undefined;

	switch (op) {
		case "init": {
			if (!Array.isArray(raw.phases)) {
				return { ok: false, error: `change ${position} (init): phases is required` };
			}
			const phases = [];
			for (const [phaseIndex, entry] of raw.phases.entries()) {
				if (!isRecord(entry)) {
					return { ok: false, error: `change ${position} (init): phases[${phaseIndex}] must be an object` };
				}
				const name = trimmed(entry.name);
				if (!name) {
					return { ok: false, error: `change ${position} (init): phases[${phaseIndex}].name is required` };
				}
				if (!Array.isArray(entry.tasks)) {
					return {
						ok: false,
						error: `change ${position} (init): phases[${phaseIndex}].tasks must be an array`,
					};
				}
				phases.push({ name, tasks: entry.tasks.map((task) => trimmed(task)) });
			}
			const label = optional("label");
			return { ok: true, change: { op: "init", ...(label ? { label } : {}), phases } };
		}
		case "add_phase": {
			const name = need("name");
			if (!name.ok) return name;
			const before = optional("beforePhaseId");
			return {
				ok: true,
				change: { op, name: name.value, ...(before ? { beforePhaseId: before } : {}) },
			};
		}
		case "rename_phase": {
			const phaseId = need("phaseId");
			if (!phaseId.ok) return phaseId;
			const name = need("name");
			if (!name.ok) return name;
			return { ok: true, change: { op, phaseId: phaseId.value, name: name.value } };
		}
		case "add_task": {
			const phaseId = need("phaseId");
			if (!phaseId.ok) return phaseId;
			const content = need("content");
			if (!content.ok) return content;
			const before = optional("beforeTaskId");
			return {
				ok: true,
				change: {
					op,
					phaseId: phaseId.value,
					content: content.value,
					...(before ? { beforeTaskId: before } : {}),
				},
			};
		}
		case "edit_task": {
			const taskId = need("taskId");
			if (!taskId.ok) return taskId;
			const content = need("content");
			if (!content.ok) return content;
			return {
				ok: true,
				change: {
					op,
					taskId: taskId.value,
					content: content.value,
					...(raw.labelOnly === true ? { labelOnly: true } : {}),
				},
			};
		}
		case "move_task": {
			const taskId = need("taskId");
			if (!taskId.ok) return taskId;
			const phaseId = need("phaseId");
			if (!phaseId.ok) return phaseId;
			const before = optional("beforeTaskId");
			return {
				ok: true,
				change: {
					op,
					taskId: taskId.value,
					phaseId: phaseId.value,
					...(before ? { beforeTaskId: before } : {}),
				},
			};
		}
		case "done":
		case "abandon": {
			const taskId = need("taskId");
			if (!taskId.ok) return taskId;
			const summary = need("summary");
			if (!summary.ok) {
				return {
					ok: false,
					error: `change ${position} (${op}): summary is required — say what was actually done, or why the task is being dropped`,
				};
			}
			return { ok: true, change: { op, taskId: taskId.value, summary: summary.value } };
		}
		case "block": {
			const taskId = need("taskId");
			if (!taskId.ok) return taskId;
			const blocker = need("blocker");
			if (!blocker.ok) return blocker;
			return { ok: true, change: { op, taskId: taskId.value, blocker: blocker.value } };
		}
		case "start":
		case "unblock":
		case "reopen":
		case "remove_task": {
			const taskId = need("taskId");
			if (!taskId.ok) return taskId;
			return { ok: true, change: { op, taskId: taskId.value } };
		}
		case "remove_phase": {
			const phaseId = need("phaseId");
			if (!phaseId.ok) return phaseId;
			return { ok: true, change: { op, phaseId: phaseId.value } };
		}
		default:
			return { ok: false, error: `change ${position}: unsupported op ${op}` };
	}
}

function trimmed(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
