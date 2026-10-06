import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * How an agent is set up. A saved one comes from a markdown file in the
 * config dir; an inline one is composed by the parent for a single task.
 */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Role instructions, appended to the child's system prompt. */
	prompt: string;
	/** Allowlist of tool names. Omitted: every tool the child loads, minus exclusions. */
	tools?: string[];
	disallowedTools?: string[];
	/** `provider/id`, or omitted to inherit the parent's model. */
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	/** Compact at this percentage of the model's context window. Omitted: Pi's own threshold, near the full window. */
	autocompact?: number;
	/** Run in the background unless the caller asks otherwise. */
	background?: boolean;
	/** Load AGENTS.md/CLAUDE.md context files (default true). */
	contextFiles: boolean;
	source: "user" | "inline";
	path?: string;
}

/** The type name an inline agent reports; the UI omits it. */
export const INLINE_TYPE = "agent";

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

/** `10`, `10%` or `"10"` as a percentage in (0, 100), else undefined. */
export function parsePercent(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim().replace(/%$/, "")) : Number.NaN;
	return Number.isFinite(number) && number > 0 && number < 100 ? number : undefined;
}

/**
 * Parse one agent file. Returns no agent and no error for markdown without a
 * `name`, which is documentation kept beside the agents, as in Claude Code.
 * A retired field still loads the agent, with an error saying what replaced it.
 */
export function parseAgentFile(content: string, path: string): { agent?: AgentDefinition; error?: string } {
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
	const autocompact = parsePercent(fm.autocompact);
	if (fm.autocompact !== undefined && autocompact === undefined) {
		return { error: `${path}: autocompact must be a percentage of the context window between 0 and 100, e.g. 10` };
	}
	const model = typeof fm.model === "string" && fm.model.trim() && fm.model.trim() !== "inherit" ? fm.model.trim() : undefined;
	const agent: AgentDefinition = {
		name: fm.name,
		description: fm.description.trim().replace(/\s+/g, " "),
		prompt: parsed.body.trim(),
		tools: toList(fm.tools),
		disallowedTools: toList(fm.disallowedTools),
		model,
		thinking,
		maxTurns: positiveInt(fm.maxTurns),
		...(autocompact !== undefined ? { autocompact } : {}),
		background: typeof fm.background === "boolean" ? fm.background : undefined,
		contextFiles: fm.contextFiles !== false,
		source: "user",
		path,
	};
	if (fm.contextBudget !== undefined) {
		return { agent, error: `${path}: contextBudget is no longer supported and was ignored; use autocompact (a percentage of the context window)` };
	}
	return { agent };
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

export interface DiscoveryResult {
	agents: Map<string, AgentDefinition>;
	errors: string[];
}

/** Saved agents: every `*.md` with a `name` under `<agentDir>/agents`. There are no built-ins. */
export function discoverAgents(userDir: string): DiscoveryResult {
	const agents = new Map<string, AgentDefinition>();
	const errors: string[] = [];
	const seen = new Map<string, string>();
	for (const file of markdownFiles(userDir)) {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch (error) {
			errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const { agent, error } = parseAgentFile(content, file);
		if (error) errors.push(error);
		if (!agent) continue;
		const duplicate = seen.get(agent.name);
		if (duplicate) {
			errors.push(`${file}: duplicate agent name "${agent.name}" (also ${relative(userDir, duplicate)}); keeping the first`);
			continue;
		}
		seen.set(agent.name, file);
		agents.set(agent.name, agent);
	}
	return { agents, errors };
}

/**
 * An agent composed for one task. Fields the parent did not pass come from
 * the saved agent it builds on, if any.
 */
export function composeAgent(
	base: AgentDefinition | undefined,
	inline: { instructions?: string; tools?: string[]; autocompact?: number; maxTurns?: number },
): AgentDefinition {
	const prompt = [base?.prompt, inline.instructions?.trim()].filter(Boolean).join("\n\n");
	const autocompact = inline.autocompact ?? base?.autocompact;
	return {
		name: base?.name ?? INLINE_TYPE,
		description: base?.description ?? "",
		prompt,
		tools: inline.tools?.length ? inline.tools : base?.tools,
		disallowedTools: base?.disallowedTools,
		model: base?.model,
		thinking: base?.thinking,
		maxTurns: inline.maxTurns ?? base?.maxTurns,
		...(autocompact !== undefined ? { autocompact } : {}),
		background: base?.background,
		contextFiles: base?.contextFiles ?? true,
		source: base ? base.source : "inline",
		...(base?.path ? { path: base.path } : {}),
	};
}
