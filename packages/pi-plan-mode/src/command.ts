interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "start", label: "start", description: "Start Plan mode without sending a prompt" },
	{ value: "show", label: "show", description: "Show the stored plan" },
	{ value: "finalize", label: "finalize", description: "Request a completed plan" },
	{ value: "implement", label: "implement", description: "Implement the completed plan" },
	{ value: "export", label: "export", description: "Export the stored plan to a Markdown file" },
	{ value: "exit", label: "exit", description: "Leave Plan mode and clear the plan" },
	{ value: "off", label: "off", description: "Leave Plan mode and clear the plan" },
];

export function completePlanArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;

	const matches = PLAN_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}
