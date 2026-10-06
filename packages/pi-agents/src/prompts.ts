import type { AgentDefinition } from "./agents.js";
import { describeAutocompact } from "./child.js";
import { type WorktreeInfo, worktreeOrigin } from "./worktree.js";

/**
 * Appended to the child's normal Pi system prompt (tools, AGENTS.md and skills
 * stay intact). Short on purpose: every line here is paid on every request.
 */
export function buildChildPrompt(input: {
	name: string;
	definition: AgentDefinition;
	cwd: string;
	maxTurns: number;
	autocompact?: number;
	contextWindow?: number;
	worktree?: WorktreeInfo;
	/** Where this user keeps worktrees; undefined means beside each repository. */
	worktreeDir?: string;
}): string {
	const { name, definition, cwd, maxTurns, autocompact, contextWindow, worktree, worktreeDir } = input;
	const role = definition.source === "inline" ? "a subagent" : `a ${definition.name} subagent`;
	const compacts = describeAutocompact(autocompact, contextWindow);
	const lines = [
		"# Subagent",
		`You are "${name}", ${role} working for a supervising Pi session. You cannot start other subagents. Nobody watches you in real time: your final message is returned to the supervising agent as your result.`,
		"- Do exactly the delegated task, the smallest amount of work that fully answers it, then stop. Do not expand scope.",
		`- Budget: ${maxTurns} turns.${compacts ? ` Your context is compacted at ${compacts}, so keep notes of what matters in your messages.` : ""} Keep context lean: batch independent lookups in one codemode script and filter output there; search and read targeted ranges instead of dumping whole files or logs.`,
		"- If you are blocked or the task is ambiguous, stop and say so in your final message instead of guessing.",
		"- Final message: lead with the result. Be concise; use absolute paths with line numbers; list what you changed and anything you could not do. No narrative of your process.",
		"",
		"## Where you work",
		`You start in ${cwd}, and every bash call starts there. Work wherever the task needs: use absolute paths, or \`cd <dir> && …\` and \`git -C <dir>\`. The first time you work in another repository or directory, its AGENTS.md instructions are added to that tool result; follow them there.`,
	];
	if (worktree) {
		lines.push(`You work in the git worktree ${worktree.path} on branch ${worktree.branch}, ${worktreeOrigin(worktree)}. Make all changes there.`);
	} else {
		const where = worktreeDir ? `${worktreeDir}/<branch with "/" replaced by "-">` : "a worktrees/ directory beside the repository, named after the branch";
		lines.push(`If the task needs changes in a repository, make them in a git worktree, never in its main checkout: \`git -C <repo> fetch origin && git -C <repo> worktree add ${worktreeDir ? `${worktreeDir}/<branch-with-dashes>` : "<worktree path>"} -b <branch> origin/<default branch>\`, in ${where}. Reuse a worktree that already exists for the branch, and never remove one.`);
	}
	lines.push("Do not commit, push, or open pull requests unless the task explicitly says to.");
	if (definition.prompt) lines.push("", definition.prompt);
	return lines.join("\n");
}

export function agentToolDescription(saved: AgentDefinition[]): string {
	const list = saved.length
		? `\n\nSaved agents (pass agent: "<name>"; other parameters override theirs):\n${saved.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")}`
		: "";
	return `Launch a subagent: a separate Pi process with its own context window, the user's extensions and AGENTS.md, that works on a task and returns one result. Compose it for the task: model, thinking, tools and role instructions; anything omitted comes from this session.${list}

Agents run in the background by default: the call returns at once, the result arrives later as a message, and the user can watch it from the agent list. Set run_in_background: false when you need the result before continuing. Children do not see this conversation, so the prompt must be self-contained: goal, relevant paths, what is already known, and what to return.`;
}

export const AGENT_GUIDELINES = [
	"Delegate with Agent when a side task would flood this context (broad searches, log digging, fresh-context review) or when independent lanes can run in parallel. Do small, targeted work yourself.",
	"Start agents from a codemode script: one `await tools.Agent({...})` per agent, or `Promise.all` over several with run_in_background: false when you need their results together; return only the synthesis.",
	"Compose each agent for its task: pick model and thinking for the work (a strong model for review, a fast one for lookups), restrict tools for read-only work, and put the role in instructions. Use agent: \"<name>\" for a saved agent.",
	"autocompact compacts an agent at that percentage of its model's context window (10 on a 1M-token model compacts at 100k); omit it to give the agent its full window.",
	"Background agent results arrive as messages. Do not poll for them and do not report results you have not received; if asked, say the agent is still running.",
	"Use SendMessage to steer a running agent or to give a finished one a follow-up; use TaskStop to stop one.",
	"Use cwd to run an agent in another directory, such as one repository of a multi-repo workspace. For changes in a repository, pass worktree: { repo, branch } so the agent works in its own git worktree created from the remote default branch.",
];
