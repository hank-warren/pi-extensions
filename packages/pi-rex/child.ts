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
 * spawn agents. Each settled run is reported to the parent, and messages the
 * parent sends are delivered as user messages.
 */
export function registerChild(pi: ExtensionAPI, dir: string, name: string): void {
	let last: { text: string; error?: string } | undefined;
	let stop: (() => void) | undefined;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// Every extension has loaded; programs this session starts are not rex children.
		delete process.env[CHILD_DIR_ENV];
		delete process.env[CHILD_NAME_ENV];
		ctx.ui.setStatus("pi-rex", `rex child · ${name}`);
		stop?.();
		stop = spoolWatch<Inbound>(join(dir, "inbox"), (message) => {
			if (typeof message?.text !== "string" || !message.text) return;
			if (ctx.isIdle()) pi.sendUserMessage(message.text);
			else pi.sendUserMessage(message.text, { deliverAs: "steer" });
		});
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
