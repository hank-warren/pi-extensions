import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./format.js";

/** Status key the child uses to tell the parent its turn budget ran out. */
export const BUDGET_STATUS_KEY = "pi-agents-budget";
/** Status key a child sets on its first prompt, so the parent knows pi-agents loaded in it and enforces its limits. */
export const CHILD_STATUS_KEY = "pi-agents-child";

/**
 * The variables a parent sets for its child. The child drops them once every
 * extension has loaded, so the commands it runs, a nested `pi` or a test
 * suite, do not start in child mode. `PI_SUBAGENT_*` stay: Auto Permissions
 * reads them on every review.
 */
export const CHILD_ENV_KEYS = [
	"PI_AGENTS_CHILD",
	"PI_AGENTS_NAME",
	"PI_AGENTS_TYPE",
	"PI_AGENTS_MAX_TURNS",
	"PI_AGENTS_AUTOCOMPACT",
	"PI_AGENTS_CONTEXT_FILES",
	"PI_AGENTS_NO_CONTEXT_FILES",
	"PI_AGENTS_TOOLS",
	"PI_AGENTS_DENY_TOOLS",
] as const;

/**
 * Status key for autocompact: `compacting` while the child compacts between
 * runs, then `continue` for the parent to resume the task with an RPC prompt,
 * whose response says whether it was accepted (an extension's own
 * sendUserMessage fails silently).
 */
export const COMPACT_STATUS_KEY = "pi-agents-compact";
/** What the child says to itself to pick the task back up after compacting. */
export const CONTINUE_AFTER_COMPACTION = "Compaction completed. Continue.";

export interface BudgetState {
	turns: number;
	warned: boolean;
	exhausted: boolean;
	/** Tool calls blocked since the budget ran out. */
	blockedCalls: number;
}

export type BudgetAction =
	| { kind: "none" }
	| { kind: "warn"; message: string }
	| { kind: "exhaust"; message: string };

/**
 * Decide what a finished turn means for the turn budget. Pure, so the
 * thresholds are testable: warn once at 80%, cut tools at 100%. Only a turn
 * that will continue (it ran tools) is steered; a final answer is left alone.
 */
export function budgetAfterTurn(state: BudgetState, input: { continuing: boolean; maxTurns: number }): BudgetAction {
	state.turns += 1;
	if (!input.continuing || state.exhausted) return { kind: "none" };
	const usage = `${state.turns}/${input.maxTurns} turns`;
	if (state.turns >= input.maxTurns) {
		state.exhausted = true;
		return {
			kind: "exhaust",
			message: `[pi-agents] Turn budget exhausted (${usage}). Tools are now disabled. Write your final report immediately: what you found or changed, what is unfinished, and where to continue.`,
		};
	}
	if (!state.warned && state.turns >= Math.floor(input.maxTurns * 0.8)) {
		state.warned = true;
		return { kind: "warn", message: `[pi-agents] Turn budget nearly used (${usage}). Stop exploring. Finish only what is essential, then write your final report.` };
	}
	return { kind: "none" };
}

/** A new prompt starts a fresh turn budget. */
export function budgetAtPromptStart(state: BudgetState): void {
	state.turns = 0;
	state.blockedCalls = 0;
	state.warned = false;
	state.exhausted = false;
}

export interface AutocompactState {
	/** Over the threshold: the next model request is stopped so the child can compact. */
	armed: boolean;
	/** A request was stopped for it; compaction runs once the child settles. */
	interrupted: boolean;
	compacting: boolean;
	/** Where the next compaction triggers; raised after one so a context that cannot shrink below the threshold does not compact every turn. */
	nextAt?: number;
	/** Set after compacting: the next measured size becomes the new floor. */
	floorPending: boolean;
	/** Compaction failed: Pi's own threshold takes over for the rest of the session. */
	disabled: boolean;
}

/** Whether a context of `tokens` should compact now. Pure, for tests. */
export function autocompactDue(state: AutocompactState, input: { tokens: number | null | undefined; threshold: number | undefined }): boolean {
	const { tokens, threshold } = input;
	if (state.disabled || state.compacting || state.armed || !threshold || tokens == null) return false;
	if (state.floorPending) {
		state.nextAt = Math.max(threshold, tokens + Math.floor(threshold / 2));
		state.floorPending = false;
	}
	return tokens >= (state.nextAt ?? threshold);
}

/** `AGENTS.md`, else `CLAUDE.md`, in one directory, as Pi picks them. */
function instructionFile(dir: string): string | undefined {
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const path = join(dir, name);
		try {
			if (statSync(path).isFile()) return path;
		} catch {
			// absent
		}
	}
	return undefined;
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

/**
 * Directories a tool call works in: the `path` of file tools, and for bash the
 * targets of `cd`, `pushd` and `git -C` plus absolute paths it names. Only
 * paths that exist count, except the directory of a file about to be written.
 */
export function workedPaths(toolName: string, input: unknown, cwd: string): string[] {
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const raw: string[] = [];
	if (PATH_TOOLS.has(toolName) && typeof args.path === "string") raw.push(args.path);
	if (toolName === "bash" && typeof args.command === "string") {
		const command = args.command;
		const unquote = (token: string) => token.replace(/^(["'])(.*)\1$/, "$2");
		for (const match of command.matchAll(/(?:^|[;&|(\n]\s*)(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) raw.push(unquote(match[1]!));
		for (const match of command.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) raw.push(unquote(match[1]!));
		for (const match of command.matchAll(/(?:^|[\s="'])((?:~|\/)[^\s'";|&<>()`$]*)/g)) raw.push(match[1]!);
	}
	const out: string[] = [];
	for (const item of raw.slice(0, 24)) {
		if (!item || item === "/" || item.startsWith("/dev") || item.startsWith("/proc")) continue;
		const path = resolve(cwd, expandHome(item));
		try {
			out.push(statSync(path).isDirectory() ? path : dirname(path));
		} catch {
			if (toolName === "write" || toolName === "edit") {
				const parent = dirname(path);
				if (existsSync(parent)) out.push(parent);
			}
		}
	}
	return [...new Set(out)];
}

/** `*` matches any characters, as in Pi's `--tools`. */
function toolPattern(entry: string): RegExp {
	return new RegExp(`^${entry.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/**
 * Whether a tool may run under an agent's allowlist and denylist. Enforced on
 * every call, codemode's nested ones included, because Pi's `--tools` only
 * chooses what is declared: MCP and codemode-exposed tools stay callable from
 * scripts. Pure, for tests.
 */
export function toolAllowed(name: string, allow: string[] | undefined, deny: string[]): boolean {
	if (deny.some((entry) => toolPattern(entry).test(name))) return false;
	return !allow || allow.some((entry) => toolPattern(entry).test(name));
}

function envInt(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

function envList(name: string): string[] {
	try {
		const parsed = JSON.parse(process.env[name] ?? "[]") as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

type ContextFile = { path: string; content: string };

/** A child's setup and what it has tracked so far. One per process. */
export interface ChildState {
	maxTurns: number;
	autocompact: number | undefined;
	instructions: boolean;
	inherited: string[];
	allowTools: string[] | undefined;
	denyTools: string[];
	announced: boolean;
	budget: BudgetState;
	compaction: AutocompactState;
	/** Instruction files in the system prompt of the current run, by real path. */
	inPrompt: Set<string>;
	/** Instruction files the model has in front of it: the system prompt plus what tool results carried. */
	seen: Set<string>;
	/** Files loaded on entry, kept in the system prompt from the next prompt on. */
	entered: Map<string, ContextFile>;
	checkedDirs: Set<string>;
	pending: ContextFile[];
}

/** Where a child keeps its state for the life of its process; exported so tests can reset it. */
export const CHILD_STATE_SLOT = Symbol.for("pi-agents.child");

/**
 * The child's state, or undefined in a parent. Read from the environment once
 * and kept on globalThis: the child drops its variables at session start, and
 * a reload (`ctx.reload()`, from any extension's command) runs this extension
 * again in the same process, which must come back as the same child.
 */
export function childState(): ChildState | undefined {
	const slot = globalThis as { [CHILD_STATE_SLOT]?: ChildState };
	if (slot[CHILD_STATE_SLOT]) return slot[CHILD_STATE_SLOT];
	if (process.env.PI_AGENTS_CHILD !== "1") return undefined;
	const percent = Number(process.env.PI_AGENTS_AUTOCOMPACT);
	const state: ChildState = {
		maxTurns: envInt("PI_AGENTS_MAX_TURNS") ?? 80,
		autocompact: Number.isFinite(percent) && percent > 0 && percent < 100 ? percent : undefined,
		instructions: process.env.PI_AGENTS_NO_CONTEXT_FILES !== "1",
		inherited: envList("PI_AGENTS_CONTEXT_FILES"),
		allowTools: process.env.PI_AGENTS_TOOLS !== undefined ? envList("PI_AGENTS_TOOLS") : undefined,
		denyTools: envList("PI_AGENTS_DENY_TOOLS"),
		announced: false,
		budget: { turns: 0, warned: false, exhausted: false, blockedCalls: 0 },
		compaction: { armed: false, interrupted: false, compacting: false, floorPending: false, disabled: false },
		inPrompt: new Set(),
		seen: new Set(),
		entered: new Map(),
		checkedDirs: new Set(),
		pending: [],
	};
	slot[CHILD_STATE_SLOT] = state;
	return state;
}

/**
 * Runs inside a child process (`PI_AGENTS_CHILD=1`). Registers no tools, so a
 * child can never spawn agents. It enforces the turn budget, compacts at the
 * agent's autocompact threshold, adds the parent's instruction files to its
 * own, and loads a directory's AGENTS.md the first time it works there.
 */
export function registerChild(pi: ExtensionAPI, state: ChildState): void {
	const { maxTurns, autocompact, instructions, inherited, allowTools, denyTools, budget, compaction } = state;
	const { inPrompt, seen, entered, checkedDirs, pending } = state;

	// Every extension has loaded by now, so none still needs them.
	pi.on("session_start", () => {
		for (const key of CHILD_ENV_KEYS) delete process.env[key];
	});

	const threshold = (ctx: ExtensionContext): number | undefined => {
		const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
		return autocompact && window ? Math.floor((window * autocompact) / 100) : undefined;
	};
	const arm = (ctx: ExtensionContext) => {
		if (autocompact && autocompactDue(compaction, { tokens: ctx.getContextUsage()?.tokens, threshold: threshold(ctx) })) compaction.armed = true;
	};

	pi.on("before_agent_start", (event, ctx) => {
		// A continuation after compacting is the same task: its turns keep counting.
		if (event.prompt !== CONTINUE_AFTER_COMPACTION) budgetAtPromptStart(budget);
		if (!state.announced) {
			state.announced = true;
			ctx.ui.setStatus(CHILD_STATUS_KEY, "ready");
		}
		ctx.ui.setStatus(BUDGET_STATUS_KEY, undefined);
		arm(ctx);
		if (!instructions) return;
		const options = (event as { systemPromptOptions?: { contextFiles?: ContextFile[] } }).systemPromptOptions;
		const fallback = (ctx as { getSystemPromptOptions?: () => { contextFiles?: ContextFile[] } }).getSystemPromptOptions?.().contextFiles;
		const own: ContextFile[] = options?.contextFiles ?? fallback ?? [];
		const ownReal = new Set(own.map((file) => real(file.path)));
		const extra: ContextFile[] = [];
		const add = (file: ContextFile) => {
			const key = real(file.path);
			if (!ownReal.has(key) && !extra.some((item) => real(item.path) === key)) extra.push(file);
		};
		for (const path of inherited) {
			try {
				add({ path, content: readFileSync(path, "utf8") });
			} catch {
				// Gone since the parent loaded it.
			}
		}
		for (const file of entered.values()) add(file);
		inPrompt.clear();
		for (const key of ownReal) inPrompt.add(key);
		for (const file of extra) inPrompt.add(real(file.path));
		for (const key of inPrompt) seen.add(key);
		if (!extra.length) return;
		if (options?.contextFiles) {
			// After the files the parent shares, before the child's own directory chain.
			const parentReal = new Set(inherited.map(real));
			let at = 0;
			own.forEach((file, index) => {
				if (parentReal.has(real(file.path))) at = index + 1;
			});
			options.contextFiles.splice(at, 0, ...extra);
			return;
		}
		const section = extra.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
		return { systemPrompt: `${event.systemPrompt}\n\n# Project Context (from the supervising session)\n\n${section}` };
	});

	pi.on("turn_end", (event, ctx) => {
		arm(ctx);
		const action = budgetAfterTurn(budget, { continuing: event.toolResults.length > 0, maxTurns });
		if (action.kind === "none") return;
		if (action.kind === "exhaust") ctx.ui.setStatus(BUDGET_STATUS_KEY, "exhausted");
		pi.sendUserMessage(action.message, { deliverAs: "steer" });
	});

	// Tools stay declared (some providers reject a transcript with tool calls
	// but no tools), but every call is refused once the budget is gone. A model
	// that keeps calling anyway is aborted, so the run always ends.
	pi.on("tool_call", (event, ctx) => {
		const name = (event as { toolName: string }).toolName;
		if (!toolAllowed(name, allowTools, denyTools)) {
			const reason = allowTools?.length === 0
				? `${name} is unavailable: this agent has no tools. Answer from what you were given.`
				: `${name} is not among this agent's tools (${allowTools?.join(", ") ?? "all but excluded"}). Use one of those instead.`;
			return { block: true, reason };
		}
		if (!budget.exhausted) return;
		budget.blockedCalls += 1;
		if (budget.blockedCalls > 3) ctx.abort();
		return { block: true, reason: "Turn budget exhausted: tools are disabled. Write your final report now, without tool calls." };
	});

	// Pi has no per-session compaction threshold, so autocompact stops before
	// the next model request, compacts once the run settles (through Pi's own
	// compaction, so compaction extensions apply), and continues the task.
	pi.on("before_provider_request", (_event, ctx) => {
		if (!compaction.armed || compaction.interrupted || compaction.compacting) return;
		compaction.interrupted = true;
		// Before the abort, so the parent never reads the stopped run as finished.
		ctx.ui.setStatus(COMPACT_STATUS_KEY, "compacting");
		ctx.abort();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!compaction.armed || !compaction.interrupted || compaction.compacting) return;
		compaction.compacting = true;
		const resume = (error?: Error) => {
			compaction.armed = false;
			compaction.interrupted = false;
			compaction.compacting = false;
			if (error && /nothing to compact|already compacted/i.test(error.message)) {
				// Too little history to summarize yet (Pi keeps its recent tokens): try again once the context has grown.
				const tokens = ctx.getContextUsage()?.tokens ?? threshold(ctx) ?? 0;
				compaction.nextAt = tokens + Math.floor((threshold(ctx) ?? 0) / 2);
			} else if (error) {
				compaction.disabled = true;
				ctx.ui.notify(`autocompact failed (${error.message}); continuing with Pi's own compaction threshold`, "warning");
			} else {
				compaction.floorPending = true;
			}
			ctx.ui.setStatus(COMPACT_STATUS_KEY, "continue");
		};
		ctx.compact({ onComplete: () => resume(), onError: (error) => resume(error) });
	});

	pi.on("session_compact", () => {
		// What tool results carried may be summarized away: load it again on the next visit.
		seen.clear();
		for (const key of inPrompt) seen.add(key);
		checkedDirs.clear();
	});

	/** Queue the instruction files from `dir` up to the root that the model has not seen. */
	const visit = (dir: string) => {
		const found: ContextFile[] = [];
		for (let current = dir; !checkedDirs.has(current); current = dirname(current)) {
			checkedDirs.add(current);
			const file = instructionFile(current);
			const key = file ? real(file) : undefined;
			if (file && key && !seen.has(key)) {
				try {
					const loaded = { path: file, content: readFileSync(file, "utf8") };
					found.unshift(loaded);
					seen.add(key);
					entered.set(key, loaded);
				} catch {
					// Unreadable: skip it.
				}
			}
			if (dirname(current) === current) break;
		}
		pending.push(...found);
	};

	pi.on("tool_result", (event, ctx) => {
		if (!instructions) return;
		const call = event as { toolName: string; input?: unknown; parentToolCallId?: string; content: Array<{ type: string; text?: string }> };
		for (const dir of workedPaths(call.toolName, call.input, ctx.cwd)) visit(dir);
		// A codemode script's own calls report through the script: attach to its result instead.
		if (call.parentToolCallId || !pending.length) return;
		const files = pending.splice(0);
		const text = [
			"[pi-agents] Instructions for the directories you just worked in. Follow them for work there:",
			...files.map((file) => `## ${file.path}\n\n${file.content.trim()}`),
		].join("\n\n");
		return { content: [...call.content, { type: "text", text }] } as never;
	});
}

/** For prompts and the UI: an autocompact percentage in tokens when the window is known. */
export function describeAutocompact(percent: number | undefined, window: number | undefined): string | undefined {
	if (!percent) return undefined;
	return window ? `${percent}% of ${formatTokens(window)} (${formatTokens(Math.floor((window * percent) / 100))})` : `${percent}% of the context window`;
}
