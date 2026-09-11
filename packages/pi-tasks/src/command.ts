/**
 * `/tasks` argument completion.
 *
 * The subcommands are inspection, management and recovery only. There is
 * deliberately no `/tasks add`, `/tasks done`, or `/tasks revise`: changing the
 * work is what `update_tasks` is for, and a command grammar for it would be a
 * second, worse editing interface that the model would then recommend.
 */

interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const TASKS_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "show", label: "show", description: "Show the attached task list" },
	{ value: "review", label: "review", description: "Reopen the proposed revision awaiting review" },
	{ value: "new", label: "new", description: "Detach the current set and start a fresh list" },
	{ value: "archive", label: "archive", description: "File the set away once every task is closed" },
	{ value: "export", label: "export", description: "Write the task list to a Markdown file" },
	{ value: "recover", label: "recover", description: "Resolve a task document conflict" },
];

export function completeTasksArguments(
	argumentPrefix: string,
): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...TASKS_COMMAND_COMPLETIONS];
	if (/\s/u.test(prefix)) return null;
	const matches = TASKS_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}

export type TasksCommand =
	| { kind: "menu" }
	| { kind: "show" }
	| { kind: "review" }
	| { kind: "new" }
	| { kind: "archive" }
	| { kind: "recover" }
	| { kind: "export"; path?: string }
	| { kind: "unknown"; input: string };

export function parseTasksCommand(args: string): TasksCommand {
	const input = args.trim();
	if (!input) return { kind: "menu" };
	const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(input);
	if (exportMatch) {
		const path = exportMatch[1]?.trim();
		return { kind: "export", ...(path ? { path } : {}) };
	}
	switch (input.toLowerCase()) {
		case "show":
			return { kind: "show" };
		case "review":
			return { kind: "review" };
		case "new":
			return { kind: "new" };
		case "archive":
			return { kind: "archive" };
		case "recover":
			return { kind: "recover" };
		default:
			return { kind: "unknown", input };
	}
}
