/**
 * What the model is told, and how little it costs.
 *
 * Pointer, not payload: an attached task set adds one line to the system prompt
 * no matter how long the list is, and the model calls `get_tasks` when it needs
 * the detail. That keeps compaction survival free and keeps the task list out
 * of the context budget it is supposed to be helping with.
 *
 * The guidelines exist to make one choice unambiguous: a conversational request
 * to change the work is a tool call, never an instruction for the user to edit a
 * file or type a command. Each bullet names its tool, because Pi appends them
 * flat into one Guidelines section where "this tool" means nothing.
 */

export const GET_TASKS_TOOL_NAME = "get_tasks";
export const UPDATE_TASKS_TOOL_NAME = "update_tasks";

export const GET_TASKS_SNIPPET = "Read the attached phased task set, its ids and revision";

export const GET_TASKS_GUIDELINES = [
	`Call ${GET_TASKS_TOOL_NAME} before ${UPDATE_TASKS_TOOL_NAME} whenever you do not already hold the current task ids and revision: every targeted change needs exact ids, and a stale revision is refused.`,
];

export const UPDATE_TASKS_SNIPPET =
	"Create, revise, or report progress on the phased task set";

export const UPDATE_TASKS_GUIDELINES = [
	`Use ${UPDATE_TASKS_TOOL_NAME} to change the task set. It is the task-editing interface: never tell the user to edit the task file, and never use edit or write on it.`,
	`Report progress with ${UPDATE_TASKS_TOOL_NAME} mode "apply" as you work — start a task before you begin it, and close it with done and a summary of what you actually did.`,
	`When the user asks to change what the work is — adding, dropping, resequencing, rewording, or reopening tasks — call ${UPDATE_TASKS_TOOL_NAME} once with mode "propose", a reason in the user's own terms, and the complete set of changes. That renders the review card the user decides on; do not apply scope changes as a series of separate calls.`,
	`In ${UPDATE_TASKS_TOOL_NAME}, identify every task and phase by its exact id. Never infer a task from its wording, and never reuse an id you were not given.`,
];

/**
 * The one line an attached task set costs per turn. Counts, not content: enough
 * for the model to know whether reading the set is worth a tool call.
 */
export function buildTasksPointer(options: {
	path: string;
	revision: number;
	open: number;
	total: number;
	inProgress?: string;
	pendingReview: boolean;
}): string {
	const active = options.inProgress ? ` In progress: ${options.inProgress}.` : "";
	const review = options.pendingReview
		? " A proposed revision is waiting for the user's review; do not apply scope changes until it is resolved."
		: "";
	return `[TASKS] A phased task set is attached to this session at ${options.path} (revision ${options.revision}, ${options.open} of ${options.total} task(s) open).${active}${review} Read it with ${GET_TASKS_TOOL_NAME} and change it with ${UPDATE_TASKS_TOOL_NAME}; the file is managed, so do not edit it directly.`;
}

/** Shown when recovery is pending, so the model stops trying to write. */
export function buildTasksRecoveryPointer(reason: string): string {
	return `[TASKS] The attached task set needs recovery before it can change: ${reason}. ${UPDATE_TASKS_TOOL_NAME} will refuse until the user runs /tasks recover and chooses how to resolve it. Say so rather than editing the file.`;
}
