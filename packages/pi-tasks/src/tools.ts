/**
 * `get_tasks` and `update_tasks`: the whole model-facing surface.
 *
 * There is no third tool and no command the model is told to suggest. A request
 * to change the work is a call to `update_tasks`; a request to see it is a call
 * to `get_tasks`. `/tasks` exists for the human, for inspection and recovery.
 *
 * Results are JSON. A task set is structured data — ids, statuses, revisions —
 * and prose would force the model to re-derive from a rendering what it needs
 * verbatim to make the next call.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { normalizeChanges, TASK_CHANGE_SCHEMA } from "./change-input.js";
import type { TasksController, ToolOutcome } from "./controller.js";
import {
	GET_TASKS_GUIDELINES,
	GET_TASKS_SNIPPET,
	GET_TASKS_TOOL_NAME,
	UPDATE_TASKS_GUIDELINES,
	UPDATE_TASKS_SNIPPET,
	UPDATE_TASKS_TOOL_NAME,
} from "./prompt.js";

export function registerGetTasksTool(pi: ExtensionAPI, controller: TasksController): void {
	pi.registerTool(
		defineTool({
			name: GET_TASKS_TOOL_NAME,
			label: "Get tasks",
			description:
				"Read the phased task set attached to this session: its id, accepted revision, phases and tasks with their exact ids and statuses, recorded completions, and any proposed revision waiting for the user. Pass taskSetId to read a different managed set read-only; that never changes which set this session tracks.",
			promptSnippet: GET_TASKS_SNIPPET,
			promptGuidelines: [...GET_TASKS_GUIDELINES],
			parameters: Type.Object({
				taskSetId: Type.Optional(
					Type.String({
						description:
							"Read a specific managed task set instead of the attached one. Omit for the attached set.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const outcome = await controller.readTasks(ctx, params.taskSetId?.trim() || undefined);
				return toolResult(outcome);
			},
		}),
	);
}

const UPDATE_TASKS_PARAMS = Type.Object({
	mode: StringEnum(["apply", "propose"] as const, {
		description:
			'"apply" for progress and incremental maintenance; "propose" for a user-requested change to what the work is.',
	}),
	changes: Type.Array(TASK_CHANGE_SCHEMA, {
		minItems: 1,
		description: "The changes to apply as one batch, in order.",
	}),
	// Optional in the schema because `init` creates the identity it would name,
	// and required at runtime for every other batch: see the tool description.
	taskSetId: Type.Optional(
		Type.String({
			description:
				"Required for every change to an existing task set: the id get_tasks reported. Omit only for init, which allocates it.",
		}),
	),
	expectedRevision: Type.Optional(
		Type.Integer({
			description:
				"Required for every change to an existing task set: the accepted revision get_tasks reported. A batch built against an older revision is refused rather than rebased onto the newer one. Omit only for init.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description:
				'Required with mode "propose": what the user asked for, in their own terms. Shown on the review card.',
		}),
	),
});

type UpdateTasksParams = Static<typeof UPDATE_TASKS_PARAMS>;

export function registerUpdateTasksTool(pi: ExtensionAPI, controller: TasksController): void {
	pi.registerTool(
		defineTool({
			name: UPDATE_TASKS_TOOL_NAME,
			label: "Update tasks",
			description: [
				"Change the phased task set in one atomic batch. Either every change in the batch applies or none does.",
				'mode "apply" commits ordinary maintenance and progress immediately: starting a task, closing it with a summary, blocking it, adding a task the work turned out to need.',
				'mode "propose" saves the batch as a candidate revision and shows the user a review card with the computed diff; it changes nothing until the user accepts. Use it when the user asks to change what the work is.',
				"Every targeted change names an exact id from get_tasks.",
				"Changing an existing set requires both taskSetId and expectedRevision exactly as get_tasks reported them; a batch built against an older revision is refused, not rebased.",
				"A new task set is created with a single init change, which needs neither.",
			].join(" "),
			promptSnippet: UPDATE_TASKS_SNIPPET,
			promptGuidelines: [...UPDATE_TASKS_GUIDELINES],
			parameters: UPDATE_TASKS_PARAMS,
			/**
			 * Models emit enum values with trailing whitespace often enough that a
			 * schema rejection on `"apply\n"` is a real failure, and Pi does not trim
			 * for you. Normalising here keeps the public schema strict.
			 */
			prepareArguments(args): UpdateTasksParams {
				if (!args || typeof args !== "object" || Array.isArray(args)) {
					return args as UpdateTasksParams;
				}
				const input = args as Record<string, unknown>;
				const mode = typeof input.mode === "string" ? input.mode.trim() : input.mode;
				const changes = Array.isArray(input.changes)
					? input.changes.map((change) =>
							change && typeof change === "object" && !Array.isArray(change)
								? {
										...(change as Record<string, unknown>),
										...(typeof (change as Record<string, unknown>).op === "string"
											? { op: ((change as Record<string, unknown>).op as string).trim() }
											: {}),
									}
								: change,
						)
					: input.changes;
				return { ...input, mode, changes } as UpdateTasksParams;
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const changes = normalizeChanges(params.changes);
				if (!changes.ok) {
					return toolResult({
						payload: { status: "invalid_input", message: changes.error },
						isError: true,
					});
				}
				const outcome = await controller.updateTasks(
					{
						mode: params.mode,
						changes: changes.changes,
						...(params.taskSetId?.trim() ? { taskSetId: params.taskSetId.trim() } : {}),
						...(params.expectedRevision !== undefined
							? { expectedRevision: params.expectedRevision }
							: {}),
						...(params.reason !== undefined ? { reason: params.reason } : {}),
						// Esc must close the review card, so the tool's own abort travels
						// with the call rather than being dropped at this boundary.
						...(signal ? { signal } : {}),
					},
					ctx,
				);
				return toolResult(outcome);
			},
		}),
	);
}

function toolResult(outcome: ToolOutcome) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(outcome.payload, null, 2) }],
		details: outcome.payload,
		...(outcome.isError ? { isError: true } : {}),
	};
}
