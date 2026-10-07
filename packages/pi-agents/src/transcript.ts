import { readFileSync } from "node:fs";
import { FORK_ENTRY } from "./fork.js";
import type { ChildMessage, LogEntry } from "./manager.js";

/**
 * Rebuild a child's log from its session file, for agents restored after a
 * parent restart or resumed into a fresh process. Messages and compactions
 * are read in append order, which for a subagent (no branching) is the
 * conversation order. A forked child's log starts at its fork marker: the
 * parent's history before it is the parent's to show.
 */
export function loadLog(sessionFile: string, limit = 600): LogEntry[] {
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return [{ kind: "notice", text: `transcript unavailable: ${sessionFile}` }];
	}
	const log: LogEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; customType?: unknown; data?: { messages?: unknown }; message?: ChildMessage; summary?: unknown; tokensBefore?: unknown; timestamp?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "custom" && entry.customType === FORK_ENTRY) {
			const copied = Number(entry.data?.messages) || 0;
			log.length = 0;
			log.push({ kind: "notice", text: `forked from the supervising session${copied ? ` (${copied} entries of its conversation)` : ""}` });
		} else if (entry.type === "message" && entry.message && typeof entry.message.role === "string") {
			log.push({ kind: "message", message: entry.message });
		} else if (entry.type === "compaction" && typeof entry.summary === "string") {
			log.push({ kind: "compaction", summary: entry.summary, tokensBefore: Number(entry.tokensBefore) || 0, timestamp: Date.parse(String(entry.timestamp)) || 0 });
		}
	}
	return log.slice(-limit);
}
