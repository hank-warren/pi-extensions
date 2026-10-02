import { type ChildProcess, spawn } from "node:child_process";

/**
 * Split a stream into JSONL records on LF only. Node's readline also splits on
 * U+2028/U+2029, which are legal inside JSON strings, so it must not be used
 * for Pi's RPC stream.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
	let buffer = "";
	return (chunk) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line) onLine(line);
			index = buffer.indexOf("\n");
		}
	};
}

export interface UiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	[key: string]: unknown;
}

export interface RpcProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; command: string };

/** One `pi --mode rpc` child: request/response correlation, events, and extension UI requests. */
export class RpcProcess {
	private child: ChildProcess | undefined;
	private readonly pending = new Map<string, Pending>();
	private nextId = 0;
	private stderrTail = "";
	exited = false;
	/** Set as soon as stop() begins: stdin is closed, so the process can take no more prompts. */
	stopping = false;
	private resolveExited: () => void = () => {};
	private readonly exitedPromise = new Promise<void>((resolve) => {
		this.resolveExited = resolve;
	});
	onEvent: (event: Record<string, unknown>) => void = () => {};
	onUiRequest: (request: UiRequest) => void = () => {};
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};

	constructor(private readonly options: RpcProcessOptions) {}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	stderr(): string {
		return this.stderrTail;
	}

	start(): void {
		const child = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", createLineSplitter((line) => this.handleLine(line)));
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4000);
		});
		child.stdin?.on("error", () => {});
		child.on("error", (error) => {
			this.stderrTail += `\n${error.message}`;
			this.finish(null, null);
		});
		child.on("exit", (code, signal) => this.finish(code, signal));
	}

	private finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.exited = true;
		this.resolveExited();
		const reason = new Error(`agent process exited (${signal ?? code})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
		this.onExit(code, signal);
	}

	private handleLine(line: string): void {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
			const pending = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			if (record.success === false) pending.reject(new Error(String(record.error ?? `${pending.command} failed`)));
			else pending.resolve(record.data);
			return;
		}
		if (record.type === "extension_ui_request") {
			this.onUiRequest(record as UiRequest);
			return;
		}
		if (record.type === "response") return;
		this.onEvent(record);
	}

	send(record: Record<string, unknown>): void {
		if (this.exited || !this.child?.stdin?.writable) return;
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	request<T = unknown>(command: Record<string, unknown> & { type: string }): Promise<T> {
		if (this.exited) return Promise.reject(new Error("agent process is not running"));
		const id = `r${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, command: command.type });
			this.send({ ...command, id });
		});
	}

	respondUi(id: string, payload: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
		this.send({ type: "extension_ui_response", id, ...payload });
	}

	/** Abort any run, close stdin for an orderly exit, then escalate to signals. */
	/** Resolves once the process has exited (immediately if it never started or already exited). */
	whenExited(): Promise<void> {
		return this.child && !this.exited ? this.exitedPromise : Promise.resolve();
	}

	async stop(graceMs = 2000): Promise<void> {
		if (this.exited || !this.child) return;
		this.stopping = true;
		const exited = this.exitedPromise;
		this.send({ type: "abort" });
		this.child.stdin?.end();
		const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
		await Promise.race([exited, timer(graceMs)]);
		if (this.exited) return;
		this.child.kill("SIGTERM");
		await Promise.race([exited, timer(1500)]);
		if (!this.exited) this.child.kill("SIGKILL");
	}
}
