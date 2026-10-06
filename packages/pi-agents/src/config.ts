import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parsePercent } from "./agents.js";

/**
 * Tools a child never gets, whatever its definition says: interactive tools
 * (no human is watching a child), session-goal tools, and every known
 * subagent-spawning tool, so a child cannot recurse.
 */
export const DEFAULT_EXCLUDED_TOOLS = [
	"ask_user_question",
	"create_goal",
	"get_goal",
	"Agent",
	"SendMessage",
	"TaskStop",
	"SubagentWorkflow",
	"get_subagent_result",
	"steer_subagent",
	"subagent",
];

export interface AgentsConfig {
	/** Children running at once; further spawns queue. */
	maxConcurrent: number;
	/**
	 * Compact every child that does not set its own at this percentage of its
	 * model's context window. Unset by default: agents get their full window.
	 */
	autocompact?: number;
	/** Default turn budget per prompt. */
	maxTurns: number;
	/** Keep a finished child's process this long so follow-ups skip the cold start. */
	idleTtlSeconds: number;
	/** Where worktrees go, for `worktree` requests and for agents that make their own. Default: a `worktrees/` directory beside the repository. */
	worktreeDir?: string;
	/** Tools removed from every child, in addition to a definition's `disallowedTools`. */
	excludeTools: string[];
	/** Override the command that starts a child, e.g. `["pi"]`. Default: this process's own pi. */
	piCommand?: string[];
}

export const DEFAULT_CONFIG: AgentsConfig = {
	maxConcurrent: 6,
	maxTurns: 80,
	idleTtlSeconds: 600,
	excludeTools: DEFAULT_EXCLUDED_TOOLS,
};

export function configPath(): string {
	return process.env.PI_AGENTS_CONFIG ?? join(getAgentDir(), "pi-agents", "config.json");
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/** Read the config file. A missing file is the defaults; a broken one is the defaults plus an error to show. */
export function loadConfig(path = configPath()): { config: AgentsConfig; error?: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { config: { ...DEFAULT_CONFIG } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { config: { ...DEFAULT_CONFIG }, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: { ...DEFAULT_CONFIG }, error: `${path}: expected a JSON object` };
	}
	const input = parsed as Record<string, unknown>;
	const extraExcludes = stringList(input.excludeTools) ?? [];
	const retired = input.contextBudget !== undefined ? `${path}: contextBudget is no longer supported and was ignored; use autocompact (a percentage of the context window)` : undefined;
	return {
		config: {
			maxConcurrent: positiveInt(input.maxConcurrent) ?? DEFAULT_CONFIG.maxConcurrent,
			autocompact: parsePercent(input.autocompact),
			maxTurns: positiveInt(input.maxTurns) ?? DEFAULT_CONFIG.maxTurns,
			idleTtlSeconds: typeof input.idleTtlSeconds === "number" && input.idleTtlSeconds >= 0
				? input.idleTtlSeconds
				: DEFAULT_CONFIG.idleTtlSeconds,
			worktreeDir: typeof input.worktreeDir === "string" && input.worktreeDir.trim()
				? expandHome(input.worktreeDir.trim())
				: undefined,
			excludeTools: [...new Set([...DEFAULT_EXCLUDED_TOOLS, ...extraExcludes])],
			piCommand: stringList(input.piCommand)?.length ? stringList(input.piCommand) : undefined,
		},
		...(retired ? { error: retired } : {}),
	};
}
