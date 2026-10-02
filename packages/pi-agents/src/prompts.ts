import type { AgentDefinition } from "./agents.js";
import { formatTokens } from "./format.js";
import type { WorktreeInfo } from "./worktree.js";

/**
 * Appended to the child's normal Pi system prompt (tools, AGENTS.md and skills
 * stay intact). Short on purpose: every line here is paid on every request.
 */
export function buildChildPrompt(input: {
	name: string;
	definition: AgentDefinition;
	contextBudget?: number;
	maxTurns: number;
	worktree?: WorktreeInfo;
}): string {
	const { name, definition, contextBudget, maxTurns, worktree } = input;
	const lines = [
		"# Subagent",
		`You are "${name}", a ${definition.name} subagent working for a supervising Pi session. You cannot start other subagents. Nobody watches you in real time: your final message is returned to the supervising agent as your result.`,
		"- Do exactly the delegated task, the smallest amount of work that fully answers it, then stop. Do not expand scope.",
		`- Budget: ${contextBudget ? `about ${formatTokens(contextBudget)} tokens of context and ` : ""}${maxTurns} turns. Keep context lean: batch independent lookups in one codemode script and filter output there; search and read targeted ranges instead of dumping whole files or logs.`,
		"- If you are blocked or the task is ambiguous, stop and say so in your final message instead of guessing.",
		"- Final message: lead with the result. Be concise; use absolute paths with line numbers; list what you changed and anything you could not do. No narrative of your process.",
	];
	if (worktree) {
		lines.push(
			"",
			"## Worktree",
			`You work in the git worktree ${worktree.path} on branch ${worktree.branch}, created from origin/${worktree.base} of ${worktree.repoRoot}. Make all changes there. Do not commit, push, or open pull requests unless the task explicitly says to.`,
		);
	}
	if (definition.prompt) lines.push("", definition.prompt);
	return lines.join("\n");
}

export function agentToolDescription(agents: AgentDefinition[]): string {
	const list = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
	return `Launch a subagent: a separate Pi process with its own context window that works on a task and returns one result.

Available agent types:
${list}

Agents run in the background by default: the call returns at once, the result arrives later as a message, and the user can watch it below the editor. Set run_in_background: false when you need the result before continuing; several foreground calls in one message run in parallel. Children load AGENTS.md but not this conversation, so the prompt must be self-contained: goal, relevant paths, what is already known, and what to return.`;
}

export const AGENT_GUIDELINES = [
	"Delegate with Agent when a side task would flood this context (broad searches, log digging, fresh-context review) or when independent lanes can run in parallel. Do small, targeted work yourself.",
	"Background agent results arrive as messages. Do not poll for them and do not report results you have not received; if asked, say the agent is still running.",
	"To fan out deterministically, call Agent with run_in_background: false from a codemode script (Promise.all over tasks) and return only the synthesized result; Agent returns { id, name, status, result, ... } there.",
	"Use SendMessage to steer a running agent or to give a finished one a follow-up; use TaskStop to stop one.",
	"For changes in a repository, pass worktree: { repo, branch } so the agent works in its own git worktree created from the remote default branch.",
];
