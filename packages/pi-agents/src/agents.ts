import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentDefinition {
	name: string;
	description: string;
	/** Markdown body, appended to the child's system prompt. */
	prompt: string;
	/** Allowlist of tool names. Omitted: every tool the child loads, minus exclusions. */
	tools?: string[];
	disallowedTools?: string[];
	/** `provider/id`, or omitted to inherit the parent's model. */
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	contextBudget?: number;
	/** Run in the background unless the caller asks otherwise. */
	background?: boolean;
	/** Load AGENTS.md/CLAUDE.md context files (default true). */
	contextFiles: boolean;
	source: "builtin" | "user" | "project";
	path?: string;
}

const SCOUT_PROMPT = `You are a scout: fast, read-only reconnaissance of a codebase or system.

- Never modify anything: no edits, no writes, no state-changing commands, no temporary files.
- Prefer targeted searches (rg, find, git log/grep) and partial reads over reading whole files. Batch independent lookups in one codemode script and filter the output there.
- Match effort to the thoroughness the task asks for; stop as soon as the question is answered.
- Report locations as absolute paths with line numbers, and say what each location does in one line.`;

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
	{
		name: "general-purpose",
		description: "Capable agent for multi-step tasks that need investigation and changes together. Use when no specialized agent fits.",
		prompt: "",
		contextFiles: true,
		source: "builtin",
	},
	{
		name: "scout",
		description: "Fast read-only reconnaissance: find files, symbols, call sites and config, and report where things are with file:line references. Say how thorough to be (quick, medium, very thorough).",
		prompt: SCOUT_PROMPT,
		tools: ["read", "bash", "grep", "find", "ls", "codemode"],
		thinking: "low",
		contextBudget: 120_000,
		contextFiles: true,
		source: "builtin",
	},
];

function toList(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const items = value.split(",").map((item) => item.trim()).filter(Boolean);
		return items.length ? items : undefined;
	}
	if (Array.isArray(value)) {
		const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
		return items.length ? items : undefined;
	}
	return undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Parse one agent file. Returns undefined (no error) for markdown without a
 * `name`, which is documentation kept beside the agents, as in Claude Code.
 */
export function parseAgentFile(
	content: string,
	path: string,
	source: "user" | "project",
): { agent?: AgentDefinition; error?: string } {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (error) {
		return { error: `${path}: invalid frontmatter: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
	}
	const fm = parsed.frontmatter ?? {};
	if (fm.name === undefined) return {};
	if (typeof fm.name !== "string" || !/^[A-Za-z0-9][\w.-]*$/.test(fm.name)) {
		return { error: `${path}: name must be letters, digits, ".", "_" or "-"` };
	}
	if (typeof fm.description !== "string" || !fm.description.trim()) {
		return { error: `${path}: missing description` };
	}
	const thinkingRaw = fm.thinking ?? fm.effort;
	let thinking: ThinkingLevel | undefined;
	if (thinkingRaw !== undefined) {
		if (typeof thinkingRaw !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinkingRaw)) {
			return { error: `${path}: thinking must be one of ${THINKING_LEVELS.join(", ")}` };
		}
		thinking = thinkingRaw as ThinkingLevel;
	}
	const model = typeof fm.model === "string" && fm.model.trim() && fm.model.trim() !== "inherit" ? fm.model.trim() : undefined;
	return {
		agent: {
			name: fm.name,
			description: fm.description.trim().replace(/\s+/g, " "),
			prompt: parsed.body.trim(),
			tools: toList(fm.tools),
			disallowedTools: toList(fm.disallowedTools),
			model,
			thinking,
			maxTurns: positiveInt(fm.maxTurns),
			contextBudget: positiveInt(fm.contextBudget),
			background: typeof fm.background === "boolean" ? fm.background : undefined,
			contextFiles: fm.contextFiles !== false,
			source,
			path,
		},
	};
}

function markdownFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir).sort();
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let stats;
		try {
			stats = statSync(full);
		} catch {
			continue;
		}
		if (stats.isDirectory()) out.push(...markdownFiles(full));
		else if (entry.endsWith(".md")) out.push(full);
	}
	return out;
}

/** `.pi/agents` directories from the filesystem root down to `cwd`, so closer ones are applied last and win. */
export function projectAgentDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = resolve(cwd);
	for (;;) {
		const candidate = join(current, ".pi", "agents");
		if (existsSync(candidate)) dirs.unshift(candidate);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

export interface DiscoveryResult {
	agents: Map<string, AgentDefinition>;
	errors: string[];
}

/** Built-ins, then `<agentDir>/agents`, then project `.pi/agents` (when trusted). Later definitions replace earlier ones by name. */
export function discoverAgents(options: { userDir: string; cwd: string; includeProject: boolean }): DiscoveryResult {
	const agents = new Map<string, AgentDefinition>();
	const errors: string[] = [];
	for (const agent of BUILTIN_AGENTS) agents.set(agent.name, agent);
	const load = (dir: string, source: "user" | "project") => {
		const seen = new Map<string, string>();
		for (const file of markdownFiles(dir)) {
			let content: string;
			try {
				content = readFileSync(file, "utf8");
			} catch (error) {
				errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const { agent, error } = parseAgentFile(content, file, source);
			if (error) errors.push(error);
			if (!agent) continue;
			const duplicate = seen.get(agent.name);
			if (duplicate) {
				errors.push(`${file}: duplicate agent name "${agent.name}" (also ${relative(dir, duplicate)}); keeping the first`);
				continue;
			}
			seen.set(agent.name, file);
			agents.set(agent.name, agent);
		}
	};
	load(options.userDir, "user");
	if (options.includeProject) for (const dir of projectAgentDirs(options.cwd)) {
		if (resolve(dir) !== resolve(options.userDir)) load(dir, "project");
	}
	return { agents, errors };
}
