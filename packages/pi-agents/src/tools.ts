import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type AgentDefinition, THINKING_LEVELS, type ThinkingLevel } from "./agents.js";
import { type AgentsConfig, expandHome } from "./config.js";
import { capText, contentText, formatDuration } from "./format.js";
import type { AgentManager, AgentRun } from "./manager.js";
import { AGENT_GUIDELINES, agentToolDescription, buildChildPrompt } from "./prompts.js";
import { type AgentDetails, detailsOf, statsLine, statusWord } from "./render.js";
import { ensureWorktree, type Exec } from "./worktree.js";

/** Longest result handed to the parent model; the rest stays in the child's session file. */
const RESULT_MAX_CHARS = 40_000;

export interface ToolHost {
	manager: AgentManager;
	agents(): Map<string, AgentDefinition>;
	config(): AgentsConfig;
	setCtx(ctx: ExtensionContext): void;
	/** Runs whose completion should be announced as a message. */
	notify: Set<string>;
}

const thinkingSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));

const agentParams = Type.Object({
	subagent_type: Type.String({ description: "Agent type to run, from the list in this tool's description." }),
	description: Type.String({ description: "3-6 word summary of the task, shown in the UI." }),
	prompt: Type.String({ description: "The complete, self-contained task for the agent." }),
	name: Type.Optional(Type.String({ description: "Short addressable name for SendMessage/TaskStop. Default: the agent type." })),
	model: Type.Optional(Type.String({ description: "Model override as provider/id. Default: the agent's model, else this session's." })),
	thinking: Type.Optional(thinkingSchema),
	run_in_background: Type.Optional(Type.Boolean({ description: "Default true. False blocks until the agent finishes and returns its result." })),
	cwd: Type.Optional(Type.String({ description: "Run in this directory (e.g. one repository of a multi-repo workspace); its AGENTS.md is loaded." })),
	worktree: Type.Optional(Type.Object({
		repo: Type.String({ description: "Repository path, absolute or relative to the session directory." }),
		branch: Type.String({ description: "Branch to create for the work, e.g. feat/foo." }),
		base: Type.Optional(Type.String({ description: "Remote base branch. Default: origin's default branch." })),
	}, { description: "Create (or reuse) a git worktree for the agent from origin/<base> and run it there. Use instead of cwd for changes." })),
});

const resultSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	type: Type.String(),
	status: Type.String(),
	result: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	toolUses: Type.Number(),
	contextTokens: Type.Number(),
	durationMs: Type.Number(),
	budgetExhausted: Type.Boolean(),
	sessionFile: Type.Optional(Type.String()),
	worktreePath: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
});

type AgentParams = Static<typeof agentParams>;
type MessageParams = { to: string; message: string; wait?: boolean };
type ToolResultValue = { content: Array<{ type: "text"; text: string }>; details: AgentDetails; structuredContent?: unknown };

function structured(run: AgentRun) {
	const details = detailsOf(run);
	return {
		id: details.id,
		name: details.name,
		type: details.type,
		status: details.status,
		...(details.result !== undefined ? { result: details.result } : {}),
		...(details.error !== undefined ? { error: details.error } : {}),
		toolUses: details.toolUses,
		contextTokens: details.contextTokens,
		durationMs: details.durationMs,
		budgetExhausted: details.budgetExhausted,
		...(details.sessionFile ? { sessionFile: details.sessionFile } : {}),
		...(details.worktree ? { worktreePath: details.worktree.path, branch: details.worktree.branch } : {}),
	};
}

/** The model-facing text of a finished run. */
export function resultText(run: AgentRun): string {
	const details = detailsOf(run);
	const body = run.result ? capText(run.result, RESULT_MAX_CHARS) : { text: "(no output)", dropped: 0 };
	const notes = [
		`${run.name} (${run.type}, id ${run.id}) · ${statusWord(run.status).toLowerCase()} · ${statsLine(details)}`,
		...(run.error ? [`error: ${run.error}`] : []),
		...(run.spec.worktree ? [`worktree: ${run.spec.worktree.path} (branch ${run.spec.worktree.branch})`] : []),
		...(body.dropped ? [`result truncated by ${body.dropped} characters; full transcript: ${run.sessionFile ?? "unavailable"}`] : []),
	];
	return `${body.text}\n\n[${notes.join("\n ")}]`;
}

/**
 * Message an agent the way SendMessage does. A finished agent resumed this way
 * reports back to the parent when it finishes, unless the caller is waiting
 * for the result itself. Used by SendMessage and the transcript viewer.
 */
export function sendToAgent(
	host: Pick<ToolHost, "manager" | "notify">,
	run: AgentRun,
	text: string,
	wait = false,
): Promise<"steered" | "queued" | "started"> {
	if (run.status !== "running") {
		if (wait) host.notify.delete(run.id);
		else host.notify.add(run.id);
	}
	return host.manager.message(run, text);
}

export function resolveModel(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, requested: string | undefined): string {
	if (!requested) {
		if (!ctx.model) throw new Error("No model selected in this session; pass model as provider/id");
		return `${ctx.model.provider}/${ctx.model.id}`;
	}
	const slash = requested.indexOf("/");
	if (slash > 0 && ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1))) return requested;
	const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === requested);
	if (matches.length === 1) return `${matches[0]!.provider}/${matches[0]!.id}`;
	throw new Error(`Unknown model "${requested}". Use provider/id${ctx.model ? `, e.g. ${ctx.model.provider}/${ctx.model.id}` : ""}.`);
}

function resolveCwd(base: string, requested: string): string {
	const path = resolve(base, expandHome(requested));
	if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`cwd is not a directory: ${path}`);
	return path;
}

/** Push live progress to a foreground tool row: coalesced to one update per 250ms, plus a 1s clock tick. */
function streamProgress(manager: AgentManager, emit: () => void): () => void {
	let timer: NodeJS.Timeout | undefined;
	const unsubscribe = manager.subscribe(() => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			emit();
		}, 250);
	});
	const tick = setInterval(emit, 1000);
	return () => {
		unsubscribe();
		clearInterval(tick);
		if (timer) clearTimeout(timer);
	};
}

async function waitStoppingOnAbort(manager: AgentManager, run: AgentRun, signal: AbortSignal | undefined): Promise<void> {
	const stopOnAbort = () => void manager.stop(run);
	if (signal?.aborted) stopOnAbort();
	signal?.addEventListener("abort", stopOnAbort, { once: true });
	try {
		await manager.waitFor(run);
	} finally {
		signal?.removeEventListener("abort", stopOnAbort);
	}
}

export function renderAgentResult(details: AgentDetails | undefined, fallback: string, expanded: boolean, theme: Theme): Text {
	if (!details) return new Text(fallback, 0, 0);
	const branch = theme.fg("dim", "  ⎿  ");
	const pad = "     ";
	const lines: string[] = [];
	if (details.status === "running" || details.status === "queued") {
		if (details.background) {
			lines.push(`${branch}${theme.fg("muted", `Running in background as ${details.name} · ↓ to view`)}`);
		} else {
			const recent = details.recentTools;
			if (details.status === "queued") lines.push(`${branch}${theme.fg("dim", "Queued…")}`);
			else if (!recent.length) lines.push(`${branch}${theme.fg("dim", "Starting…")}`);
			recent.forEach((tool, index) => lines.push(`${index === 0 && details.status === "running" ? branch : pad}${theme.fg("muted", tool)}`));
			const more = details.toolUses - recent.length;
			const tail = statsLine(details).split(" · ").slice(1).join(" · ");
			lines.push(theme.fg("dim", `${pad}${more > 0 ? `+${more} more tool use${more === 1 ? "" : "s"} · ` : ""}${tail}`));
		}
	} else {
		const color = details.status === "done" ? "muted" : details.status === "failed" ? "error" : "warning";
		lines.push(`${branch}${theme.fg(color, `${statusWord(details.status)} (${statsLine(details)})`)}`);
		if (details.error) lines.push(`${pad}${theme.fg("error", details.error)}`);
		if (details.worktree) lines.push(`${pad}${theme.fg("dim", `worktree ${details.worktree.path}`)}`);
		if (expanded && details.result) lines.push("", details.result);
		else if (details.result) lines.push(theme.fg("dim", `${pad}(ctrl+o to expand)`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

function noticeIn(run: AgentRun, ctxCwd: string): string {
	const worktree = run.spec.worktree;
	if (worktree) return ` in worktree ${worktree.path} (branch ${worktree.branch}${worktree.created ? ", new" : ", reused"})`;
	return run.spec.cwd !== ctxCwd ? ` in ${run.spec.cwd}` : "";
}

export function registerTools(pi: ExtensionAPI, host: ToolHost): void {
	const exec: Exec = (command, args, options) => pi.exec(command, args, options);

	const agentTool = {
		name: "Agent",
		label: "Agent",
		description: agentToolDescription([...host.agents().values()]),
		promptSnippet: "Launch a subagent in its own Pi process for a self-contained task",
		promptGuidelines: AGENT_GUIDELINES,
		parameters: agentParams,
		outputSchema: resultSchema,
		renderShell: "self",
		async execute(
			_toolCallId: string,
			params: AgentParams,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: ToolResultValue) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<ToolResultValue> {
			host.setCtx(ctx);
			const config = host.config();
			const definition = host.agents().get(params.subagent_type);
			if (!definition) {
				throw new Error(`Unknown subagent_type "${params.subagent_type}". Available: ${[...host.agents().keys()].join(", ")}`);
			}
			if (params.cwd && params.worktree) throw new Error("Pass cwd or worktree, not both");
			const model = resolveModel(ctx, params.model ?? definition.model);
			const thinking = params.thinking ?? definition.thinking ?? (pi.getThinkingLevel() as ThinkingLevel);
			let cwd = params.cwd ? resolveCwd(ctx.cwd, params.cwd) : ctx.cwd;
			const worktree = params.worktree
				? await ensureWorktree(exec, params.worktree, { cwd: ctx.cwd, worktreeDir: config.worktreeDir, signal })
				: undefined;
			if (worktree) cwd = worktree.path;
			const name = host.manager.uniqueName((params.name?.trim() || definition.name).replace(/\s+/g, "-"));
			const contextBudget = definition.contextBudget ?? config.contextBudget;
			const slash = model.indexOf("/");
			const contextWindow = ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))?.contextWindow;
			const maxTurns = definition.maxTurns ?? config.maxTurns;
			const background = params.run_in_background ?? definition.background ?? true;
			const run = host.manager.create({
				name,
				definition,
				description: params.description.trim() || params.subagent_type,
				model,
				thinking,
				cwd,
				background,
				contextBudget,
				contextWindow,
				maxTurns,
				appendPrompt: buildChildPrompt({ name, definition, contextBudget, maxTurns, worktree }),
				worktree,
			});
			if (background) host.notify.add(run.id);
			host.manager.start(run, params.prompt);

			if (background) {
				return {
					content: [{ type: "text", text: `Started ${name} (id ${run.id}, ${definition.name}, ${model})${noticeIn(run, ctx.cwd)} in the background. Its result arrives as a message when it finishes; do not poll. Steer it with SendMessage({ to: "${name}" }).` }],
					details: detailsOf(run),
					structuredContent: structured(run),
				};
			}
			const stopStreaming = streamProgress(host.manager, () => onUpdate?.({ content: [{ type: "text", text: "" }], details: detailsOf(run) }));
			try {
				await waitStoppingOnAbort(host.manager, run, signal);
			} finally {
				stopStreaming();
			}
			if (run.status === "failed") throw new Error(resultText(run));
			return { content: [{ type: "text", text: resultText(run) }], details: detailsOf(run), structuredContent: structured(run) };
		},
		renderCall(args: Partial<AgentParams>, theme: Theme) {
			const type = args.subagent_type ?? "Agent";
			const description = args.description ? theme.fg("muted", `(${args.description})`) : "";
			return new Text(`${theme.fg("accent", "●")} ${theme.bold(type)}${description}`, 0, 0);
		},
		renderResult(result: { content: unknown; details?: unknown }, options: { expanded: boolean }, theme: Theme) {
			return renderAgentResult(result.details as AgentDetails | undefined, contentText(result.content), options.expanded, theme);
		},
	};

	const messageParams = Type.Object({
		to: Type.String({ description: "Agent name or id." }),
		message: Type.String({ description: "Steering for a running agent, or a follow-up task for a finished one." }),
		wait: Type.Optional(Type.Boolean({ description: "Block until the agent finishes and return its result. Default false." })),
	});

	const sendMessageTool = {
		name: "SendMessage",
		label: "Send message",
		description: "Send a message to a subagent. A running agent reads it after its current tool calls (steering); a finished agent resumes with it as a follow-up and keeps its full history.",
		promptSnippet: "Steer a running subagent or follow up on a finished one",
		parameters: messageParams,
		outputSchema: resultSchema,
		async execute(
			_toolCallId: string,
			params: MessageParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ToolResultValue> {
			host.setCtx(ctx);
			const run = host.manager.find(params.to.trim());
			if (!run) {
				const known = host.manager.list().map((item) => `${item.name} (${item.id})`).join(", ");
				throw new Error(`No agent "${params.to}".${known ? ` Agents: ${known}` : ""}`);
			}
			const outcome = await sendToAgent(host, run, params.message, params.wait);
			if (params.wait) {
				await waitStoppingOnAbort(host.manager, run, signal);
				if (run.status === "failed") throw new Error(resultText(run));
				return { content: [{ type: "text", text: resultText(run) }], details: detailsOf(run, false), structuredContent: structured(run) };
			}
			const text = outcome === "steered"
				? `Steered ${run.name}; it reads the message after its current tool calls.`
				: outcome === "queued"
					? `${run.name} is queued; the message was added to its task.`
					: `${run.name} resumed in the background with your message; its result arrives as a message.`;
			return { content: [{ type: "text", text }], details: detailsOf(run, true), structuredContent: structured(run) };
		},
		renderCall(args: Partial<MessageParams>, theme: Theme) {
			return new Text(`${theme.fg("accent", "●")} ${theme.bold("SendMessage")} ${theme.fg("muted", `→ ${args.to ?? ""}`)}`, 0, 0);
		},
	};

	const stopParams = Type.Object({ id: Type.String({ description: "Agent name or id." }) });
	const taskStopTool = {
		name: "TaskStop",
		label: "Stop agent",
		description: "Stop a running subagent. Its partial output is kept and SendMessage can resume it later.",
		promptSnippet: "Stop a running subagent",
		parameters: stopParams,
		async execute(_toolCallId: string, params: { id: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			host.setCtx(ctx);
			const run = host.manager.find(params.id.trim());
			if (!run) throw new Error(`No agent "${params.id}"`);
			const wasBusy = run.busy;
			host.notify.delete(run.id);
			await host.manager.stop(run);
			return {
				content: [{ type: "text" as const, text: wasBusy ? `Stopped ${run.name} after ${formatDuration(detailsOf(run).durationMs)}.` : `${run.name} was not running (${run.status}).` }],
				details: detailsOf(run),
			};
		},
	};

	// outputSchema, structuredContent and renderShell are newer than the
	// oldest Pi this package typechecks against; hosts without them ignore them.
	type AnyTool = Parameters<ExtensionAPI["registerTool"]>[0];
	pi.registerTool(agentTool as unknown as AnyTool);
	pi.registerTool(sendMessageTool as unknown as AnyTool);
	pi.registerTool(taskStopTool as unknown as AnyTool);
}
