import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.js";
import { BUDGET_STATUS_KEY } from "./child.js";
import type { AgentsConfig } from "./config.js";
import { contentText, summarizeToolCall } from "./format.js";
import { RpcProcess, type UiRequest } from "./rpc.js";
import type { WorktreeInfo } from "./worktree.js";

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface TranscriptItem {
	kind: "user" | "assistant" | "tool" | "notice";
	text: string;
	toolCallId?: string;
	status?: "running" | "done" | "error";
	output?: string;
	nested?: boolean;
}

/** What survives a parent restart: enough to list the agent and resume it from its session file. */
export interface RunSnapshot {
	id: string;
	name: string;
	type: string;
	description: string;
	model: string;
	thinking?: string;
	cwd: string;
	sessionFile?: string;
	worktree?: WorktreeInfo;
	contextWindow?: number;
	/** The child's system-prompt addition; a resumed child is started with it again. */
	appendPrompt?: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	toolUses: number;
	contextTokens: number;
	result?: string;
	error?: string;
}

export interface RunSpec {
	name: string;
	definition: AgentDefinition;
	description: string;
	model: string;
	thinking?: string;
	cwd: string;
	background: boolean;
	/** Self-imposed context cap; undefined means none. */
	contextBudget?: number;
	/** The model's context window, for display. */
	contextWindow?: number;
	maxTurns: number;
	appendPrompt: string;
	worktree?: WorktreeInfo;
}

const MAX_ITEMS = 600;
const RECENT_TOOLS = 3;

export class AgentRun {
	readonly id: string;
	status: RunStatus = "queued";
	startedAt = Date.now();
	/** Start of the current prompt; elapsed time is measured from here. */
	runStartedAt = Date.now();
	endedAt: number | undefined;
	toolUses = 0;
	recentTools: string[] = [];
	contextTokens = 0;
	outputTokens = 0;
	cost = 0;
	turns = 0;
	result: string | undefined;
	error: string | undefined;
	budgetExhausted = false;
	sessionFile: string | undefined;
	items: TranscriptItem[] = [];
	streaming = "";
	/** Title of a permission/dialog request waiting on the user, if any. */
	approval: string | undefined;
	proc: RpcProcess | undefined;
	idleTimer: NodeJS.Timeout | undefined;
	stopRequested = false;
	lastAssistant = "";
	lastStopReason: string | undefined;
	lastErrorMessage: string | undefined;
	waiters: Array<() => void> = [];
	dialogAborts = new Set<AbortController>();

	constructor(readonly spec: RunSpec, id?: string) {
		this.id = id ?? randomBytes(4).toString("hex");
	}

	get name(): string { return this.spec.name; }
	get type(): string { return this.spec.definition.name; }
	get description(): string { return this.spec.description; }
	get busy(): boolean { return this.status === "queued" || this.status === "running"; }
	/** A process that can take a prompt: started, not exited, and not being shut down. */
	get alive(): boolean { return Boolean(this.proc && !this.proc.exited && !this.proc.stopping); }

	push(item: TranscriptItem): void {
		this.items.push(item);
		if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
	}

	snapshot(): RunSnapshot {
		return {
			id: this.id,
			name: this.name,
			type: this.type,
			description: this.description,
			model: this.spec.model,
			thinking: this.spec.thinking,
			cwd: this.spec.cwd,
			sessionFile: this.sessionFile,
			worktree: this.spec.worktree,
			contextWindow: this.spec.contextWindow,
			appendPrompt: this.spec.appendPrompt,
			status: this.status,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			toolUses: this.toolUses,
			contextTokens: this.contextTokens,
			result: this.result,
			error: this.error,
		};
	}
}

/** Pure: the CLI arguments for one child. */
export function buildChildArgs(input: {
	model: string;
	thinking?: string;
	appendPrompt: string;
	tools?: string[];
	excludeTools: string[];
	contextFiles: boolean;
	name: string;
	sessionFile?: string;
	sessionDir?: string;
}): string[] {
	const args = ["--mode", "rpc"];
	if (input.sessionFile) args.push("--session", input.sessionFile);
	else if (input.sessionDir) args.push("--session-dir", input.sessionDir);
	else args.push("--no-session");
	args.push("--model", input.model);
	if (input.thinking) args.push("--thinking", input.thinking);
	args.push("--append-system-prompt", input.appendPrompt);
	if (input.tools?.length) args.push("--tools", input.tools.join(","));
	if (input.excludeTools.length) args.push("--exclude-tools", input.excludeTools.join(","));
	if (!input.contextFiles) args.push("--no-context-files");
	args.push("--name", input.name);
	return args;
}

/** Pure: the child's environment. HERDR_PANE_ID is dropped so a child never drives the parent's pane state. */
export function buildChildEnv(base: NodeJS.ProcessEnv, run: { id: string; name: string; type: string; contextBudget?: number; maxTurns: number }): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	delete env.HERDR_PANE_ID;
	delete env.PI_AGENTS_CONTEXT_BUDGET;
	return {
		...env,
		PI_AGENTS_CHILD: "1",
		PI_AGENTS_NAME: run.name,
		PI_AGENTS_TYPE: run.type,
		...(run.contextBudget ? { PI_AGENTS_CONTEXT_BUDGET: String(run.contextBudget) } : {}),
		PI_AGENTS_MAX_TURNS: String(run.maxTurns),
		// The env contract pi-auto-permissions already reads for subagent children.
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_RUN_ID: run.id,
		PI_SUBAGENT_DEPTH: "1",
	};
}

export interface ManagerDeps {
	config(): AgentsConfig;
	ctx(): ExtensionContext | undefined;
	spawnCommand(): string[];
	sessionDir(): string | undefined;
	onFinished(run: AgentRun): void;
}

export class AgentManager {
	readonly runs = new Map<string, AgentRun>();
	private queue: Array<{ run: AgentRun; prompt: string }> = [];
	private listeners = new Set<() => void>();
	private uiChain: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(private readonly deps: ManagerDeps) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A broken view must not break the run.
			}
		}
	}

	list(): AgentRun[] {
		return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	/** By id, or by name (the most recent agent with that name). */
	find(ref: string): AgentRun | undefined {
		const byId = this.runs.get(ref);
		if (byId) return byId;
		return this.list().reverse().find((run) => run.name === ref);
	}

	uniqueName(base: string): string {
		const taken = new Set([...this.runs.values()].map((run) => run.name));
		if (!taken.has(base)) return base;
		for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
	}

	restore(snapshot: RunSnapshot, definition: AgentDefinition): AgentRun {
		const run = new AgentRun({
			name: snapshot.name,
			definition,
			description: snapshot.description,
			model: snapshot.model,
			thinking: snapshot.thinking,
			cwd: snapshot.cwd,
			background: true,
			contextBudget: definition.contextBudget ?? this.deps.config().contextBudget,
			contextWindow: snapshot.contextWindow,
			maxTurns: definition.maxTurns ?? this.deps.config().maxTurns,
			appendPrompt: snapshot.appendPrompt ?? "",
			worktree: snapshot.worktree,
		}, snapshot.id);
		run.status = snapshot.status === "queued" || snapshot.status === "running" ? "stopped" : snapshot.status;
		run.startedAt = snapshot.startedAt;
		run.runStartedAt = snapshot.startedAt;
		run.endedAt = snapshot.endedAt ?? snapshot.startedAt;
		run.toolUses = snapshot.toolUses;
		run.contextTokens = snapshot.contextTokens;
		run.result = snapshot.result;
		run.error = snapshot.error;
		run.sessionFile = snapshot.sessionFile;
		this.runs.set(run.id, run);
		return run;
	}

	create(spec: RunSpec): AgentRun {
		const run = new AgentRun(spec);
		this.runs.set(run.id, run);
		return run;
	}

	private runningCount(): number {
		let count = 0;
		for (const run of this.runs.values()) if (run.status === "running") count++;
		return count;
	}

	/** Start a prompt on a run: first launch, or a follow-up to a finished one. Queues past `maxConcurrent`. */
	start(run: AgentRun, prompt: string): void {
		if (this.disposed) throw new Error("pi-agents is shutting down");
		if (run.status === "running") throw new Error(`${run.name} is already running; use steer`);
		run.stopRequested = false;
		run.error = undefined;
		run.endedAt = undefined;
		run.budgetExhausted = false;
		if (run.idleTimer) clearTimeout(run.idleTimer);
		run.idleTimer = undefined;
		if (this.runningCount() >= this.deps.config().maxConcurrent) {
			run.status = "queued";
			this.queue.push({ run, prompt });
			this.changed();
			return;
		}
		void this.launch(run, prompt);
	}

	private spawn(run: AgentRun): RpcProcess {
		const config = this.deps.config();
		const [command, ...prefix] = this.deps.spawnCommand();
		const definition = run.spec.definition;
		const resume = Boolean(run.sessionFile);
		const args = buildChildArgs({
			model: run.spec.model,
			thinking: run.spec.thinking,
			appendPrompt: run.spec.appendPrompt,
			tools: definition.tools,
			excludeTools: [...new Set([...config.excludeTools, ...(definition.disallowedTools ?? [])])],
			contextFiles: definition.contextFiles,
			name: `${run.name}: ${run.description}`,
			sessionFile: resume ? run.sessionFile : undefined,
			sessionDir: resume ? undefined : this.deps.sessionDir(),
		});
		// Snapshots from before appendPrompt was recorded have none to pass.
		if (!run.spec.appendPrompt) {
			const index = args.indexOf("--append-system-prompt");
			if (index >= 0) args.splice(index, 2);
		}
		const proc = new RpcProcess({
			command,
			args: [...prefix, ...args],
			cwd: run.spec.cwd,
			env: buildChildEnv(process.env, {
				id: run.id,
				name: run.name,
				type: run.type,
				contextBudget: run.spec.contextBudget,
				maxTurns: run.spec.maxTurns,
			}),
		});
		proc.onEvent = (event) => this.handleEvent(run, proc, event);
		proc.onUiRequest = (request) => this.handleUi(run, proc, request);
		proc.onExit = () => this.handleExit(run, proc);
		proc.start();
		run.proc = proc;
		return proc;
	}

	private async launch(run: AgentRun, prompt: string): Promise<void> {
		run.status = "running";
		run.runStartedAt = Date.now();
		run.lastAssistant = "";
		run.lastStopReason = undefined;
		run.lastErrorMessage = undefined;
		this.changed();
		try {
			const previous = run.proc;
			if (previous && !run.alive) {
				// A process still shutting down (stopped, or idle TTL) has closed
				// stdin: detach it so its exit no longer belongs to this run, and let
				// it finish writing the session file before a new one resumes it.
				run.proc = undefined;
				await previous.whenExited();
			}
			const proc = run.alive ? run.proc! : this.spawn(run);
			if (!run.sessionFile) {
				proc.request<{ sessionFile?: string }>({ type: "get_state" })
					.then((state) => {
						if (state?.sessionFile) run.sessionFile = state.sessionFile;
					})
					.catch(() => {});
			}
			const accepted = await proc.request<{ disposition?: string }>({ type: "prompt", message: prompt });
			if (accepted?.disposition === "handled") this.finish(run, "done");
		} catch (error) {
			if (run.status === "running") {
				run.error = error instanceof Error ? error.message : String(error);
				this.finish(run, run.stopRequested ? "stopped" : "failed");
			}
		}
	}

	/** Steer a running agent (delivered after its current tool calls), or follow up on a finished one. */
	async message(run: AgentRun, text: string): Promise<"steered" | "queued" | "started"> {
		if (run.status === "running" && run.alive) {
			run.push({ kind: "user", text });
			this.changed();
			await run.proc!.request({ type: "steer", message: text });
			return "steered";
		}
		if (run.status === "queued") {
			const entry = this.queue.find((item) => item.run === run);
			if (entry) entry.prompt = `${entry.prompt}\n\n${text}`;
			return "queued";
		}
		if (!run.alive && !run.sessionFile) throw new Error(`${run.name} has no session file to resume from`);
		this.start(run, text);
		return (run.status as RunStatus) === "queued" ? "queued" : "started";
	}

	async stop(run: AgentRun): Promise<void> {
		if (run.status === "queued") {
			this.queue = this.queue.filter((item) => item.run !== run);
			this.finish(run, "stopped");
			return;
		}
		if (run.status !== "running") {
			await run.proc?.stop();
			return;
		}
		run.stopRequested = true;
		for (const controller of run.dialogAborts) controller.abort();
		this.finish(run, "stopped");
		await run.proc?.stop();
	}

	waitFor(run: AgentRun): Promise<void> {
		if (!run.busy) return Promise.resolve();
		return new Promise((resolve) => run.waiters.push(resolve));
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.queue = [];
		await Promise.all([...this.runs.values()].map(async (run) => {
			if (run.idleTimer) clearTimeout(run.idleTimer);
			for (const controller of run.dialogAborts) controller.abort();
			if (run.busy) {
				run.stopRequested = true;
				run.status = "stopped";
				run.endedAt = Date.now();
				for (const waiter of run.waiters.splice(0)) waiter();
			}
			await run.proc?.stop(500);
		}));
		this.listeners.clear();
	}

	private finish(run: AgentRun, status: Exclude<RunStatus, "queued" | "running">): void {
		if (!run.busy) return;
		run.status = status;
		run.endedAt = Date.now();
		run.streaming = "";
		run.approval = undefined;
		run.result = run.lastAssistant || run.result;
		for (const waiter of run.waiters.splice(0)) waiter();
		if (run.alive && !this.disposed) {
			const ttl = this.deps.config().idleTtlSeconds * 1000;
			run.idleTimer = setTimeout(() => void run.proc?.stop(), ttl);
			run.idleTimer.unref();
		}
		this.changed();
		if (!this.disposed) {
			try {
				this.deps.onFinished(run);
			} catch {
				// Notification failures must not wedge the queue.
			}
		}
		this.drain();
	}

	private drain(): void {
		while (!this.disposed && this.queue.length && this.runningCount() < this.deps.config().maxConcurrent) {
			const next = this.queue.shift()!;
			void this.launch(next.run, next.prompt);
		}
	}

	private handleExit(run: AgentRun, proc: RpcProcess): void {
		if (run.proc !== proc) return;
		if (run.idleTimer) clearTimeout(run.idleTimer);
		run.idleTimer = undefined;
		for (const controller of run.dialogAborts) controller.abort();
		if (run.status === "running") {
			run.error = run.stopRequested ? undefined : `agent process exited unexpectedly${proc.stderr() ? `: ${proc.stderr().trim().split("\n").slice(-3).join(" | ")}` : ""}`;
			this.finish(run, run.stopRequested ? "stopped" : "failed");
		}
		this.changed();
	}

	private handleEvent(run: AgentRun, proc: RpcProcess, event: Record<string, unknown>): void {
		if (run.proc !== proc) return;
		switch (event.type) {
			case "message_update": {
				const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (update?.type === "text_delta" && typeof update.delta === "string") {
					run.streaming = (run.streaming + update.delta).slice(-4000);
					this.changed();
				}
				return;
			}
			case "message_end": {
				const message = event.message as Record<string, unknown> | undefined;
				if (!message) return;
				if (message.role === "assistant") {
					const usage = message.usage as Record<string, number> | undefined;
					if (usage) {
						const context = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
						// An aborted or failed response reports zero usage; keep the last real size.
						if (context > 0) run.contextTokens = context;
						run.outputTokens += usage.output ?? 0;
						run.cost += (usage as unknown as { cost?: { total?: number } }).cost?.total ?? 0;
					}
					const text = contentText(message.content).trim();
					run.lastStopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
					run.lastErrorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
					if (text) {
						run.lastAssistant = text;
						run.push({ kind: "assistant", text });
					}
					run.streaming = "";
				} else if (message.role === "user") {
					const text = contentText(message.content).trim();
					const last = run.items[run.items.length - 1];
					// Steers are echoed when sent; skip the duplicate.
					if (text && !(last?.kind === "user" && last.text === text)) run.push({ kind: "user", text });
				}
				this.changed();
				return;
			}
			case "tool_execution_start": {
				const name = String(event.toolName ?? "tool");
				const summary = summarizeToolCall(name, event.args);
				run.toolUses += 1;
				run.recentTools = [...run.recentTools, summary].slice(-RECENT_TOOLS);
				run.push({ kind: "tool", text: summary, toolCallId: String(event.toolCallId ?? ""), status: "running", nested: Boolean(event.parentToolCallId) });
				this.changed();
				return;
			}
			case "tool_execution_end": {
				const id = String(event.toolCallId ?? "");
				const item = [...run.items].reverse().find((entry) => entry.kind === "tool" && entry.toolCallId === id);
				if (item) {
					item.status = event.isError ? "error" : "done";
					const result = event.result as { content?: unknown } | undefined;
					item.output = contentText(result?.content).slice(0, 800);
				}
				this.changed();
				return;
			}
			case "turn_end":
				run.turns += 1;
				return;
			case "compaction_start":
				run.push({ kind: "notice", text: "compacting context…" });
				this.changed();
				return;
			case "auto_retry_start":
				run.push({ kind: "notice", text: `retrying: ${String(event.errorMessage ?? "provider error")}` });
				this.changed();
				return;
			case "agent_settled": {
				if (!run.busy) return;
				if (run.lastStopReason === "error") {
					run.error = run.lastErrorMessage ?? "provider error";
					this.finish(run, "failed");
				} else if (run.lastStopReason === "aborted") {
					this.finish(run, "stopped");
				} else {
					this.finish(run, "done");
				}
				return;
			}
		}
	}

	private handleUi(run: AgentRun, proc: RpcProcess, request: UiRequest): void {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
				this.forwardDialog(run, proc, request);
				return;
			case "editor":
				// ctx.ui.editor() cannot be cancelled, so a forwarded one would outlive
				// a stopped child and block every other agent's dialogs. Decline it.
				proc.respondUi(request.id, { cancelled: true });
				run.push({ kind: "notice", text: `declined an editor dialog (${request.title ?? "untitled"}): subagents cannot open editors in the parent` });
				this.changed();
				return;
			case "setStatus":
				if (request.statusKey === BUDGET_STATUS_KEY) {
					run.budgetExhausted = request.statusText === "exhausted";
					if (run.budgetExhausted) run.push({ kind: "notice", text: "budget exhausted: tools disabled, final report requested" });
					this.changed();
				}
				return;
			case "notify":
				if (request.notifyType === "error" || request.notifyType === "warning") {
					run.push({ kind: "notice", text: String(request.message ?? "") });
					this.changed();
				}
				return;
		}
	}

	/** Child dialogs (permission prompts, mostly) surface in the parent, one at a time, labeled with the agent. */
	private forwardDialog(run: AgentRun, proc: RpcProcess, request: UiRequest): void {
		const ctx = this.deps.ctx();
		if (!ctx?.hasUI) {
			proc.respondUi(request.id, { cancelled: true });
			return;
		}
		const controller = new AbortController();
		run.dialogAborts.add(controller);
		this.uiChain = this.uiChain.then(async () => {
			if (proc.exited || controller.signal.aborted) return;
			run.approval = request.title ?? request.method;
			this.changed();
			const title = `[${run.name}] ${request.title ?? ""}`;
			const options = { signal: controller.signal, ...(request.timeout ? { timeout: request.timeout } : {}) };
			try {
				if (request.method === "select") {
					const value = await ctx.ui.select(title, request.options ?? [], options);
					proc.respondUi(request.id, value === undefined ? { cancelled: true } : { value });
				} else if (request.method === "confirm") {
					proc.respondUi(request.id, { confirmed: await ctx.ui.confirm(title, request.message ?? "", options) });
				} else {
					const value = await ctx.ui.input(title, request.placeholder, options);
					proc.respondUi(request.id, value === undefined ? { cancelled: true } : { value });
				}
			} catch {
				proc.respondUi(request.id, { cancelled: true });
			} finally {
				run.dialogAborts.delete(controller);
				run.approval = undefined;
				this.changed();
			}
		});
	}
}
