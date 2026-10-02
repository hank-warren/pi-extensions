import { readFileSync } from "node:fs";
import type { ChildMessage, LogEntry } from "./manager.js";

/**
 * Rebuild a child's log from its session file, for agents restored after a
 * parent restart or resumed into a fresh process. Messages are read in append
 * order, which for a subagent (no branching) is the conversation order.
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
		let entry: { type?: string; message?: ChildMessage };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message && typeof entry.message.role === "string") {
			log.push({ kind: "message", message: entry.message });
		}
	}
	return log.slice(-limit);
}
