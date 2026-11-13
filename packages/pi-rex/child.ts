import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spoolWatch, spoolWrite } from "./spool.ts";

export const CHILD_DIR_ENV = "PI_REX_CHILD";
export const CHILD_NAME_ENV = "PI_REX_NAME";

/** What a child writes when a run settles; the parent delivers it to its model. */
export interface Report {
	text: string;
	aborted?: boolean;
	error?: string;
}

export interface Inbound {
	text: string;
}

/** The child's tool allowlist, written by the parent beside the task. */
export const TOOLS_FILE = "tools.json";

export interface ChildIdentity {
	dir: string;
	name: string;
	/** Allowlist of tool names and `*` patterns; undefined allows every tool. */
	tools?: string[];
	/** Whether the first run, the task Pi was started with, has begun. */
	started?: boolean;
}

/** Where a child keeps its identity for the life of its process; exported so tests can reset it. */
export const CHILD_SLOT = Symbol.for("pi-rex.child");

/**
 * This process's child identity, or undefined in a parent. Read from the
 * environment once and kept on globalThis: the child drops its variables at
 * session start, and a reload runs this extension again in the same process,
 * which must come back as the same child.
 */
export function childIdentity(): ChildIdentity | undefined {
	const slot = globalThis as { [CHILD_SLOT]?: ChildIdentity };
	if (slot[CHILD_SLOT]) return slot[CHILD_SLOT];
	const dir = process.env[CHILD_DIR_ENV];
	if (!dir) return undefined;
	let tools: string[] | undefined;
	try {
		const parsed = JSON.parse(readFileSync(join(dir, TOOLS_FILE), "utf8")) as unknown;
		if (Array.isArray(parsed)) tools = parsed.filter((item): item is string => typeof item === "string");
	} catch {
		// No allowlist: every tool.
	}
	slot[CHILD_SLOT] = { dir, name: process.env[CHILD_NAME_ENV] ?? "child", tools };
	return slot[CHILD_SLOT];
}

/** `*` matches any characters, as in Pi's `--tools`. */
function toolPattern(entry: string): RegExp {
	return new RegExp(`^${entry.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** Whether a tool may run under a child's allowlist; no allowlist allows everything. */
export function toolAllowed(name: string, allow: string[] | undefined): boolean {
	return !allow || allow.some((entry) => toolPattern(entry).test(name));
}

type Message = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };

/** The text of the last assistant message in a run, and its error if it failed. */
export function lastAssistant(messages: unknown): { text: string; error?: string } | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message?.role !== "assistant") continue;
		const content = message.content;
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
				: "";
		return { text: text.trim(), error: message.stopReason === "error" ? (message.errorMessage ?? "error").split("\n")[0] : undefined };
	}
	return undefined;
}

/**
 * Runs inside a Pi started by RexSpawn. Registers no tools, so a child cannot
 * spawn agents. Each settled run is reported to the parent, messages the
 * parent sends are delivered as user messages, and the tool allowlist is
 * enforced on every call.
 */
export function registerChild(pi: ExtensionAPI, identity: ChildIdentity): void {
	const { dir, name, tools } = identity;
	let last: { text: string; error?: string } | undefined;
	let stop: (() => void) | undefined;

	const watchInbox = (ctx: ExtensionContext) => {
		stop?.();
		stop = spoolWatch<Inbound>(join(dir, "inbox"), (message) => {
			if (typeof message?.text !== "string" || !message.text) return;
			if (ctx.isIdle()) pi.sendUserMessage(message.text);
			else pi.sendUserMessage(message.text, { deliverAs: "steer" });
		});
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// Every extension has loaded; programs this session starts are not rex children.
		delete process.env[CHILD_DIR_ENV];
		delete process.env[CHILD_NAME_ENV];
		ctx.ui.setStatus("pi-rex", `rex child · ${name}`);
		// Pi submits the task it was started with after session_start. A message delivered
		// before that would start a run of its own and make the task fail as "already
		// processing", so the inbox waits for the first run. A reload is past that point.
		if (identity.started) watchInbox(ctx);
	});

	pi.on("agent_start", (_event, ctx: ExtensionContext) => {
		if (identity.started) return;
		identity.started = true;
		watchInbox(ctx);
	});

	// Pi's `--tools` only chooses what is declared: MCP and codemode-exposed tools
	// stay callable from scripts. So every call, nested ones included, is checked here.
	pi.on("tool_call", (event) => {
		const tool = (event as { toolName: string }).toolName;
		if (toolAllowed(tool, tools)) return;
		return { block: true, reason: tools?.length ? `${tool} is not among this agent's tools (${tools.join(", ")}). Use one of those instead.` : `${tool} is unavailable: this agent has no tools.` };
	});

	pi.on("agent_end", (event) => {
		last = lastAssistant((event as { messages?: unknown }).messages) ?? last;
	});

	pi.on("agent_settled", (event) => {
		const report: Report = { text: last?.text ?? "", error: last?.error, aborted: (event as { aborted?: boolean }).aborted || undefined };
		last = undefined;
		spoolWrite(join(dir, "outbox"), report);
	});

	pi.on("session_shutdown", () => {
		stop?.();
		stop = undefined;
	});
}
