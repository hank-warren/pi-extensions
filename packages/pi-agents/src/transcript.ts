import { readFileSync } from "node:fs";
import { contentText, summarizeToolCall } from "./format.js";
import type { TranscriptItem } from "./manager.js";

/**
 * Rebuild viewer items from a child's session file, for agents restored after
 * a parent restart (their live event stream is gone). Reads the whole append
 * log, abandoned branches included, which is fine for a read-only view.
 */
export function loadTranscript(sessionFile: string, limit = 600): TranscriptItem[] {
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return [{ kind: "notice", text: `transcript unavailable: ${sessionFile}` }];
	}
	const items: TranscriptItem[] = [];
	const tools = new Map<string, TranscriptItem>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: Record<string, unknown> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user") {
			const text = contentText(message.content).trim();
			if (text) items.push({ kind: "user", text });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as Array<Record<string, unknown>>) {
				if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
					items.push({ kind: "assistant", text: block.text.trim() });
				} else if (block.type === "toolCall") {
					const item: TranscriptItem = { kind: "tool", text: summarizeToolCall(String(block.name ?? "tool"), block.arguments), toolCallId: String(block.id ?? ""), status: "done" };
					tools.set(item.toolCallId!, item);
					items.push(item);
				}
			}
		} else if (message.role === "toolResult") {
			const item = tools.get(String(message.toolCallId ?? ""));
			if (item) {
				item.status = message.isError ? "error" : "done";
				item.output = contentText(message.content).slice(0, 800);
			}
		}
	}
	return items.slice(-limit);
}
