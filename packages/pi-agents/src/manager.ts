import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.js";
import { BUDGET_STATUS_KEY, CHILD_ENV_KEYS, CHILD_STATUS_KEY, COMPACT_STATUS_KEY, CONTINUE_AFTER_COMPACTION } from "./child.js";
import type { AgentsConfig } from "./config.js";
import { contentText, summarizeToolCall, type ToolCallSummary } from "./format.js";
import { applyAssistantEvent, type PartialAssistant, startAssistant } from "./stream.js";
import { RpcProcess, type UiRequest } from "./rpc.js";
import { loadLog } from "./transcript.js";
import type { WorktreeInfo } from "./worktree.js";

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

/**
 * One entry of a child's transcript: a message exactly as the child's session
 * holds it (user, assistant, toolResult, custom), or a notice from pi-agents.
 * The viewer renders messages with Pi's own components.
 */
export type LogEntry =
	| { kind: "message"; message: ChildMessage }
	| { kind: "notice"; text: string }
	| { kind: "compaction"; summary: string; tokensBefore: number; timestamp: number };

/** What a viewer hears from a run: the child's own RPC events, plus pi-agents notices. */
export type RunEvent = Record<string, unknown> & { type?: unknown };

/** A child message as it arrives over RPC; typed loosely because it is foreign data. */
export type ChildMessage = Record<string, unknown> & { role?: string };

/** Latest partial output of a running tool call, as Pi's tool renderers take it. */
export interface ToolPartial {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
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
	autocompact?: number;
	maxTurns?: number;
	/** The parent's instruction files the child also follows. */
	contextFiles?: string[];
	/** The setup it ran with, overrides included, so a resume cannot widen its tools. */
	definition?: AgentDefinition;
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
	/** Compact at this percentage of the model's context window; undefined leaves it to Pi. */
	autocompact?: number;
	/** The parent's instruction files, added to the child's own. */
	contextFiles?: string[];
	/** The model's context window, for display. */
	contextWindow?: number;
	maxTurns: number;
	appendPrompt: string;
	worktree?: WorktreeInfo;
}

const MAX_LOG = 600;
/** Tool-call summaries kept for the inline row; the full calls are in the log. */
const TOOL_LOG = 30;

export class AgentRun {
	readonly id: string;
	status: RunStatus = "queued";
	startedAt = Date.now();
	/** Start of the current prompt; elapsed time is measured from here. */
	runStartedAt = Date.now();
	endedAt: number | undefined;
	toolUses = 0;
	/** Pi-style summaries of the latest tool calls, oldest first. */
	toolLog: ToolCallSummary[] = [];
	contextTokens = 0;
	outputTokens = 0;
	cost = 0;
	turns = 0;
	result: string | undefined;
	error: string | undefined;
	budgetExhausted = false;
	/** The current process announced that pi-agents loaded in it. */
	childReady = false;

	/**
	 * What a row, a tool box or the summary line draws of this run, besides the
	 * clock. Views compare it to redraw only when it changed: deltas stream from
	 * every agent, and Pi redraws the whole screen for each render request.
	 */
	get look(): string {
		return `${this.status}|${this.toolUses}|${this.toolLog.length}|${this.contextTokens}|${this.approval ?? ""}|${this.compacting}|${this.compactingNow}|${this.budgetExhausted}|${this.runningTools.size}|${this.streaming ? 1 : 0}`;
	}
	/** The child is compacting between runs of the same task (autocompact). */
	compacting = false;
	sessionFile: string | undefined;
	log: LogEntry[] = [];
	/** Partial output of tool calls still running, by call id. */
	partials = new Map<string, ToolPartial>();
	/** Assistant text streaming right now, before its message ends. */
	streaming = "";
	/** The whole assistant message streaming right now: thinking, text and tool calls. */
	partial: PartialAssistant | undefined;
	/** Pi is compacting the child's context right now. */
	compactingNow = false;
	private readonly listeners = new Set<(event: RunEvent) => void>();
	/** Title of a permission/dialog request waiting on the user, if any. */
	approval: string | undefined;
	proc: RpcProcess | undefined;
	idleTimer: NodeJS.Timeout | undefined;
	stopRequested = false;
	lastAssistant = "";
	lastStopReason: string | undefined;
	lastErrorMessage: string | undefined;
	waiters: Array<() => void> = [];
	/** Open or queued forwarded dialogs, each with the tool calls that were running when it was asked. */
	dialogs = new Map<AbortController, Set<string>>();
	/** Messages sent while its previous process was still exiting, delivered with the next prompt. */
	pendingMessages: string[] = [];
	/** Tool calls the child is executing right now. */
	runningTools = new Set<string>();
	/** When each recent tool call started and ended, so a viewer opened later shows real durations. */
	toolTimes = new Map<string, { start: number; end?: number }>();
	/** Bumped by every launch, stop and dispose; a launch that sees a newer value gives up. */
	launchSeq = 0;

	constructor(readonly spec: RunSpec, id?: string) {
		this.id = id ?? randomBytes(4).toString("hex");
	}

	get name(): string { return this.spec.name; }
	/** The saved agent it runs as; empty for an agent composed inline. */
	get type(): string { return this.spec.definition.source === "inline" ? "" : this.spec.definition.name; }
	get description(): string { return this.spec.description; }
	get busy(): boolean { return this.status === "queued" || this.status === "running"; }
	/** A process that can take a prompt: started, not exited, and not being shut down. */
	get alive(): boolean { return Boolean(this.proc && !this.proc.exited && !this.proc.stopping); }

	push(entry: LogEntry): void {
		this.log.push(entry);
		if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
	}

	notice(text: string): void {
		this.push({ kind: "notice", text });
		this.emit({ type: "pi-agents-notice", text });
	}

	/** Follow this run's events as they arrive, after the manager has applied them. */
	onEvent(listener: (event: RunEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: RunEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A broken view must not break the run.
			}
		}
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
			autocompact: this.spec.autocompact,
			maxTurns: this.spec.maxTurns,
			contextFiles: this.spec.contextFiles,
			definition: this.spec.definition,
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
	// An empty allowlist is no tools at all; Pi's --tools takes no empty list.
	if (input.tools) args.push(...(input.tools.length ? ["--tools", input.tools.join(",")] : ["--no-tools"]));
	if (input.excludeTools.length) args.push("--exclude-tools", input.excludeTools.join(","));
	if (!input.contextFiles) args.push("--no-context-files");
	args.push("--name", input.name);
	return args;
}

/** This process's subagent depth: 0 for a top-level session. */
export function subagentDepth(value: string | undefined): number {
	const depth = Number(value);
	return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/** Pure: the child's environment. HERDR_PANE_ID is dropped so a child never drives the parent's pane state. */
export function buildChildEnv(
	base: NodeJS.ProcessEnv,
	run: {
		id: string;
		name: string;
		type: string;
		maxTurns: number;
		autocompact?: number;
		contextFiles?: string[];
		loadContextFiles: boolean;
		/** Allowlist, enforced on every call in the child, codemode's included. */
		tools?: string[];
		denyTools?: string[];
	},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of ["HERDR_PANE_ID", ...CHILD_ENV_KEYS]) delete env[key];
	return {
		...env,
		PI_AGENTS_CHILD: "1",
		PI_AGENTS_NAME: run.name,
		PI_AGENTS_TYPE: run.type,
		PI_AGENTS_MAX_TURNS: String(run.maxTurns),
		...(run.autocompact ? { PI_AGENTS_AUTOCOMPACT: String(run.autocompact) } : {}),
		...(run.contextFiles?.length ? { PI_AGENTS_CONTEXT_FILES: JSON.stringify(run.contextFiles) } : {}),
		...(run.loadContextFiles ? {} : { PI_AGENTS_NO_CONTEXT_FILES: "1" }),
		...(run.tools ? { PI_AGENTS_TOOLS: JSON.stringify(run.tools) } : {}),
		...(run.denyTools?.length ? { PI_AGENTS_DENY_TOOLS: JSON.stringify(run.denyTools) } : {}),
		// The env contract pi-auto-permissions already reads for subagent children.
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_RUN_ID: run.id,
		// One deeper than this process: a pi started from a child's commands is a parent at depth 1, so its agents are at 2.
		PI_SUBAGENT_DEPTH: String(subagentDepth(base.PI_SUBAGENT_DEPTH) + 1),
	};
}

export interface ManagerDeps {
	config(): AgentsConfig;
	ctx(): ExtensionContext | undefined;
	spawnCommand(): string[];
	sessionDir(): string | undefined;
	/** A run started or resumed, and again once its session file is known: record it, so a parent that exits or crashes mid-run can still list and resume it. */
	onStarted?(run: AgentRun): void;
	onFinished(run: AgentRun): void;
}

export class AgentManager {
	readonly runs = new Map<string, AgentRun>();
	private queue: Array<{ run: AgentRun; prompt: string }> = [];
	private listeners = new Set<() => void>();
	private uiChain: Promise<void> = Promise.resolve();
	private disposed = false;
	private tempDirs = new Set<string>();

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
			autocompact: snapshot.autocompact,
			contextFiles: snapshot.contextFiles,
			contextWindow: snapshot.contextWindow,
			maxTurns: snapshot.maxTurns ?? definition.maxTurns ?? this.deps.config().maxTurns,
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

	/**
	 * A new run. With `sessionFile` (a forked conversation) its first launch
	 * resumes that session instead of starting an empty one.
	 */
	create(spec: RunSpec, sessionFile?: string): AgentRun {
		const run = new AgentRun(spec);
		run.sessionFile = sessionFile;
		this.runs.set(run.id, run);
		return run;
	}

	/** Where children keep their sessions; undefined when this session is not saved. */
	sessionDir(): string | undefined {
		return this.deps.sessionDir();
	}

	/**
	 * A temporary directory holding a child's session (a fork from an unsaved
	 * session): kept while follow-ups can resume the child, removed on dispose
	 * once every child has exited.
	 */
	ownTempDir(dir: string): void {
		this.tempDirs.add(dir);
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
		run.compacting = false;
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
		if (resume && !run.log.length) run.log = loadLog(run.sessionFile!);
		// --tools only chooses what is declared (MCP tools stay callable from scripts), so the child also enforces both lists per call.
		const excludeTools = [...new Set([...config.excludeTools, ...(definition.disallowedTools ?? [])])];
		const args = buildChildArgs({
			model: run.spec.model,
			thinking: run.spec.thinking,
			appendPrompt: run.spec.appendPrompt,
			tools: definition.tools,
			excludeTools,
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
				maxTurns: run.spec.maxTurns,
				autocompact: run.spec.autocompact,
				contextFiles: run.spec.contextFiles,
				loadContextFiles: definition.contextFiles,
				tools: definition.tools,
				denyTools: excludeTools,
			}),
		});
		proc.onEvent = (event) => this.handleEvent(run, proc, event);
		proc.onUiRequest = (request) => this.handleUi(run, proc, request);
		proc.onExit = () => this.handleExit(run, proc);
		proc.start();
		run.proc = proc;
		run.childReady = false;
		return proc;
	}

	private async launch(run: AgentRun, prompt: string): Promise<void> {
		const seq = ++run.launchSeq;
		const current = () => seq === run.launchSeq && run.status === "running";
		run.status = "running";
		run.runStartedAt = Date.now();
		// Counters cover this prompt, like its elapsed time, so a follow-up reports its own work.
		run.toolUses = 0;
		run.toolLog = [];
		run.result = undefined;
		run.lastAssistant = "";
		run.lastStopReason = undefined;
		run.lastErrorMessage = undefined;
		this.changed();
		const record = () => {
			try {
				this.deps.onStarted?.(run);
			} catch {
				// Recording is best effort; the run goes ahead.
			}
		};
		record();
		try {
			const previous = run.proc;
			if (previous && !run.alive) {
				// A process still shutting down (stopped, or idle TTL) has closed
				// stdin: detach it so its exit no longer belongs to this run, and let
				// it finish writing the session file before a new one resumes it.
				run.proc = undefined;
				await previous.whenExited();
				// Stopped or disposed while waiting: do not resurrect it.
				if (!current() || this.disposed) return;
			}
			const proc = run.alive ? run.proc! : this.spawn(run);
			if (!run.sessionFile) {
				proc.request<{ sessionFile?: string }>({ type: "get_state" })
					.then((state) => {
						if (!state?.sessionFile) return;
						run.sessionFile = state.sessionFile;
						// The record taken at start had no session file to resume from after a crash.
						if (run.status === "running") record();
					})
					.catch(() => {});
			}
			// Messages that arrived while the old process was still exiting.
			const message = [prompt, ...run.pendingMessages.splice(0)].join("\n\n");
			const accepted = await proc.request<{ disposition?: string }>({ type: "prompt", message });
			if (accepted?.disposition === "handled" && current()) this.finish(run, "done");
		} catch (error) {
			if (current()) {
				run.error = error instanceof Error ? error.message : String(error);
				this.finish(run, run.stopRequested ? "stopped" : "failed");
			}
		}
	}

	/** Steer a running agent (delivered after its current tool calls), or follow up on a finished one. */
	async message(run: AgentRun, text: string): Promise<"steered" | "queued" | "started"> {
		if (run.status === "running" && run.alive) {
			await run.proc!.request({ type: "steer", message: text });
			return "steered";
		}
		if (run.status === "running") {
			// Its previous process is still exiting: the new one takes this with its prompt.
			run.pendingMessages.push(text);
			return "queued";
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
			run.stopRequested = true;
			this.queue = this.queue.filter((item) => item.run !== run);
			this.finish(run, "stopped");
			return;
		}
		if (run.status !== "running") {
			await run.proc?.stop();
			return;
		}
		run.stopRequested = true;
		run.launchSeq += 1;
		run.pendingMessages = [];
		this.finish(run, "stopped");
		await run.proc?.stop();
	}

	waitFor(run: AgentRun): Promise<void> {
		if (!run.busy) return Promise.resolve();
		return new Promise((resolve) => run.waiters.push(resolve));
	}

	/** Stop everything. Returns the runs it stopped mid-task, for the caller to record. */
	async dispose(): Promise<AgentRun[]> {
		this.disposed = true;
		this.queue = [];
		const interrupted: AgentRun[] = [];
		await Promise.all([...this.runs.values()].map(async (run) => {
			if (run.idleTimer) clearTimeout(run.idleTimer);
			run.launchSeq += 1;
			this.abortDialogs(run);
			if (run.busy) {
				run.stopRequested = true;
				run.status = "stopped";
				run.endedAt = Date.now();
				run.result = run.lastAssistant || run.result;
				interrupted.push(run);
				for (const waiter of run.waiters.splice(0)) waiter();
			}
			await run.proc?.stop(500);
		}));
		for (const dir of this.tempDirs) rmSync(dir, { recursive: true, force: true });
		this.tempDirs.clear();
		this.listeners.clear();
		return interrupted;
	}

	private finish(run: AgentRun, status: Exclude<RunStatus, "queued" | "running">): void {
		if (!run.busy) return;
		run.status = status;
		run.endedAt = Date.now();
		run.streaming = "";
		run.partial = undefined;
		run.compactingNow = false;
		run.approval = undefined;
		run.compacting = false;
		run.runningTools.clear();
		run.partials.clear();
		this.abortDialogs(run);
		run.result = run.lastAssistant || undefined;
		for (const waiter of run.waiters.splice(0)) waiter();
		if (run.alive && !this.disposed) {
			const ttl = this.deps.config().idleTtlSeconds * 1000;
			run.idleTimer = setTimeout(() => void run.proc?.stop(), ttl);
			run.idleTimer.unref();
			this.trimIdle();
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

	/**
	 * Keep at most `maxConcurrent` finished agents' processes for follow-ups,
	 * the most recent ones; older ones stop now and resume from their session
	 * file if messaged. Many agents would otherwise hold a process each for the
	 * whole idle TTL.
	 */
	private trimIdle(): void {
		const idle = [...this.runs.values()]
			.filter((run) => !run.busy && run.alive && run.sessionFile)
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
		for (const run of idle.slice(this.deps.config().maxConcurrent)) {
			if (run.idleTimer) clearTimeout(run.idleTimer);
			run.idleTimer = undefined;
			void run.proc?.stop();
		}
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
		this.abortDialogs(run);
		if (run.status === "running") {
			run.error = run.stopRequested ? undefined : `agent process exited unexpectedly${proc.stderr() ? `: ${proc.stderr().trim().split("\n").slice(-3).join(" | ")}` : ""}`;
			this.finish(run, run.stopRequested ? "stopped" : "failed");
		}
		this.changed();
	}

	private handleEvent(run: AgentRun, proc: RpcProcess, event: Record<string, unknown>): void {
		if (run.proc !== proc) return;
		this.applyEvent(run, event);
		run.emit(event);
	}

	private applyEvent(run: AgentRun, event: Record<string, unknown>): void {
		switch (event.type) {
			case "agent_start":
				// The child announces itself before its first run starts. Without
				// it, pi-agents is not loaded there (a piCommand without it) and
				// the allowlist, turn budget and autocompact are not enforced.
				if (!run.childReady && run.busy) {
					run.error = "pi-agents did not load in the agent's process, so its tool allowlist, turn budget and autocompact cannot be enforced. If piCommand is set, make it load pi-agents.";
					const proc = run.proc;
					this.finish(run, "failed");
					void proc?.stop();
				}
				return;
			case "message_start": {
				const message = event.message as ChildMessage | undefined;
				if (message?.role === "assistant") run.partial = startAssistant();
				return;
			}
			case "message_update": {
				const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
				if (!update) return;
				run.partial ??= startAssistant();
				applyAssistantEvent(run.partial, update);
				// A delta changes nothing a row or the summary draws, except the moment the agent starts writing;
				// the viewer follows deltas through run events. Notifying per delta redrew everything per delta.
				if (update.type === "text_delta" && typeof update.delta === "string") {
					const started = run.streaming === "";
					run.streaming = (run.streaming + update.delta).slice(-4000);
					if (started) this.changed();
				}
				return;
			}
			case "message_end": {
				const message = event.message as ChildMessage | undefined;
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
					if (text) run.lastAssistant = text;
					run.streaming = "";
					run.partial = undefined;
				}
				if (message.role === "toolResult") run.partials.delete(String(message.toolCallId ?? ""));
				run.push({ kind: "message", message });
				this.changed();
				return;
			}
			case "tool_execution_start": {
				const id = String(event.toolCallId ?? "");
				run.toolUses += 1;
				run.toolTimes.set(id, { start: Date.now() });
				if (run.toolTimes.size > MAX_LOG) run.toolTimes.delete(run.toolTimes.keys().next().value!);
				run.toolLog = [...run.toolLog, summarizeToolCall(String(event.toolName ?? "tool"), event.args)].slice(-TOOL_LOG);
				run.runningTools.add(id);
				this.changed();
				return;
			}
			case "tool_execution_update": {
				const partial = event.partialResult as ToolPartial | undefined;
				if (partial && Array.isArray(partial.content)) {
					run.partials.set(String(event.toolCallId ?? ""), partial);
					this.changed();
				}
				return;
			}
			case "tool_execution_end": {
				const id = String(event.toolCallId ?? "");
				run.runningTools.delete(id);
				const times = run.toolTimes.get(id);
				if (times) times.end = Date.now();
				this.releaseDialogs(run, id);
				this.changed();
				return;
			}
			case "turn_end":
				run.turns += 1;
				// Every tool call of the turn is done, so no dialog asked during it is still awaited.
				run.runningTools.clear();
				this.abortDialogs(run);
				return;
			case "agent_end":
				run.partial = undefined;
				run.streaming = "";
				return;
			case "compaction_start":
				run.compactingNow = true;
				this.changed();
				return;
			case "compaction_end": {
				run.compactingNow = false;
				const result = event.result as { summary?: unknown; tokensBefore?: unknown } | undefined;
				if (result && typeof result.summary === "string") {
					run.push({ kind: "compaction", summary: result.summary, tokensBefore: Number(result.tokensBefore) || 0, timestamp: Date.now() });
				} else if (!event.aborted && typeof event.errorMessage === "string") {
					run.notice(`compaction failed: ${event.errorMessage}`);
				}
				this.changed();
				return;
			}
			case "auto_retry_start":
				run.notice(`retrying after ${String(event.errorMessage ?? "a provider error")}`);
				this.changed();
				return;
			case "agent_settled": {
				// Autocompact stopped this run on purpose and continues it after compacting.
				if (!run.busy || run.compacting) return;
				if (run.lastStopReason === "error") {
					run.error = run.lastErrorMessage ?? "provider error";
					this.finish(run, "failed");
				} else if (run.lastStopReason === "aborted") {
					// Only a stop someone asked for is "stopped"; the child aborting itself is a failure the caller must hear about.
					if (run.stopRequested) {
						this.finish(run, "stopped");
					} else {
						run.error = run.budgetExhausted
							? "turn budget exhausted: it kept calling tools after it was asked for its final report, so its run was aborted"
							: "its run was aborted";
						this.finish(run, "failed");
					}
				} else {
					this.finish(run, "done");
				}
				return;
			}
		}
	}

	/**
	 * Resume a task the child stopped to compact. The parent sends the prompt
	 * so that a refusal comes back as a response and fails the run, where an
	 * extension's own sendUserMessage would fail silently and leave it hanging.
	 */
	private continueAfterCompaction(run: AgentRun, proc: RpcProcess): void {
		run.compacting = false;
		const seq = run.launchSeq;
		const current = () => seq === run.launchSeq && run.status === "running" && run.proc === proc;
		proc.request<{ disposition?: string }>({ type: "prompt", message: CONTINUE_AFTER_COMPACTION }).then(
			(accepted) => {
				if (accepted?.disposition === "handled" && current()) this.finish(run, "done");
			},
			(error: unknown) => {
				if (!current()) return;
				run.error = `autocompact could not resume the task: ${error instanceof Error ? error.message : String(error)}`;
				this.finish(run, "failed");
			},
		);
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
				run.notice(`declined an editor dialog (${request.title ?? "untitled"}): subagents cannot open editors in the parent`);
				this.changed();
				return;
			case "setStatus":
				if (request.statusKey === COMPACT_STATUS_KEY) {
					if (request.statusText === "compacting") {
						run.compacting = true;
						run.notice("autocompact: compacting context, then continuing");
					} else if (request.statusText === "continue" && run.compacting) {
						this.continueAfterCompaction(run, proc);
					}
					this.changed();
					return;
				}
				if (request.statusKey === CHILD_STATUS_KEY) {
					run.childReady = request.statusText === "ready";
					return;
				}
				if (request.statusKey === BUDGET_STATUS_KEY) {
					run.budgetExhausted = request.statusText === "exhausted";
					if (run.budgetExhausted) run.notice("turn budget exhausted: tools disabled, final report requested");
					this.changed();
				}
				return;
			case "notify":
				if (request.notifyType === "error" || request.notifyType === "warning") {
					run.notice(String(request.message ?? ""));
					this.changed();
				}
				return;
		}
	}

	private abortDialogs(run: AgentRun): void {
		for (const controller of run.dialogs.keys()) controller.abort();
		run.dialogs.clear();
	}

	/**
	 * RPC has no message for "the child stopped waiting" (a codemode script
	 * ended, a review went stale): the child just drops the request. Close a
	 * dialog once every tool call that was running when it was asked has
	 * finished, since the one waiting on it must be among them.
	 */
	private releaseDialogs(run: AgentRun, toolCallId: string): void {
		for (const [controller, owners] of run.dialogs) {
			if (!owners.delete(toolCallId) || owners.size > 0) continue;
			controller.abort();
			run.dialogs.delete(controller);
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
		// Pi's tool_execution_start precedes the tool_call hook, so the call
		// waiting on this dialog is among these.
		run.dialogs.set(controller, new Set(run.runningTools));
		this.uiChain = this.uiChain.then(async () => {
			if (proc.exited) return;
			if (controller.signal.aborted) {
				// Its call finished while it waited its turn: answer it, so nothing in the child waits on it.
				proc.respondUi(request.id, { cancelled: true });
				return;
			}
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
				run.dialogs.delete(controller);
				run.approval = undefined;
				this.changed();
			}
		});
	}
}
