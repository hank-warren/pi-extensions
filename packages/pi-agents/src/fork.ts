import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ends a forked child's copied history; the transcript viewer starts after it. */
export const FORK_ENTRY = "pi-agents-fork";

/** The result a forked child sees for the parent's tool call that started it. */
export const FORK_NOTE = "Forked here: a subagent was started from this point with a copy of this conversation. The supervising session carries on with this call; you are the subagent, and your task is in the next message.";

/** A session entry as Pi stores it; typed loosely because only a few fields matter here. */
export type Entry = Record<string, unknown> & { type: string; id: string; parentId: string | null; timestamp: string };
type Message = Record<string, unknown> & { role?: string; content?: unknown };

/**
 * Entries that never reach the model: extension state, labels, the session
 * name, usage notes, and model or thinking changes (the child has its own).
 * Everything else is copied, including types this version does not know.
 */
const LEFT_BEHIND = new Set(["custom", "label", "session_info", "usage", "model_change", "thinking_level_change"]);

export interface ForkHistory {
	entries: Entry[];
	/** Tool calls closed with {@link FORK_NOTE}. */
	closed: number;
}

function latestCompaction(branch: Entry[]): { entry: Entry; index: number } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index]!.type === "compaction") return { entry: branch[index]!, index };
	}
	return undefined;
}

/**
 * The parent's branch as a linear session the child resumes to the same model
 * context. Entries keep their order and ids, so Pi and compaction extensions
 * read the copy as they read the parent: a compaction stays after the entries
 * it keeps, and one whose `details` an extension reads at its position (native
 * Codex checkpoints rebuild the request from the entries after it) still has
 * the same entries after it. History before the latest compaction's kept range
 * is not copied, since nothing reads it. Entries that never reach the model
 * are left behind, so the child's extensions start clean. The tool calls of
 * the parent's in-flight assistant message are closed, since the call that
 * started the child has no result yet.
 */
export function forkHistory(branch: Entry[], now = Date.now()): ForkHistory {
	const compaction = latestCompaction(branch);
	let start = 0;
	if (compaction) {
		const kept = branch.findIndex((entry) => entry.id === compaction.entry.firstKeptEntryId);
		start = kept >= 0 && kept < compaction.index ? kept : compaction.index;
	}
	const copied = branch.slice(start).filter((entry) => !LEFT_BEHIND.has(entry.type));

	// The kept range must still start at an entry the copy has.
	const copiedCompaction = compaction && copied.indexOf(compaction.entry);
	if (compaction && copiedCompaction !== undefined && copiedCompaction > 0 && !copied.some((entry) => entry.id === compaction.entry.firstKeptEntryId)) {
		copied[copiedCompaction] = { ...compaction.entry, firstKeptEntryId: copied[0]!.id };
	}

	const ids = new Set(copied.map((entry) => entry.id));
	const newId = () => {
		let id: string;
		do id = randomBytes(4).toString("hex");
		while (ids.has(id));
		ids.add(id);
		return id;
	};
	const timestamp = new Date(now).toISOString();
	const closes: Entry[] = [];
	let lastAssistant = copied.length - 1;
	while (lastAssistant >= 0 && !(copied[lastAssistant]!.type === "message" && (copied[lastAssistant]!.message as Message).role === "assistant")) lastAssistant--;
	if (lastAssistant >= 0) {
		const answered = new Set(copied.slice(lastAssistant + 1).map((entry) => (entry.message as Message | undefined)?.toolCallId));
		const content = (copied[lastAssistant]!.message as Message).content;
		for (const part of Array.isArray(content) ? content : []) {
			if (part?.type !== "toolCall" || typeof part.id !== "string" || answered.has(part.id)) continue;
			closes.push({
				type: "message",
				id: newId(),
				parentId: null,
				timestamp,
				message: { role: "toolResult", toolCallId: part.id, toolName: part.name, content: [{ type: "text", text: FORK_NOTE }], isError: false, timestamp: now },
			});
		}
	}

	const history = [...copied, ...closes];
	const entries: Entry[] = history.map((entry, index) => ({ ...entry, parentId: index ? history[index - 1]!.id : null }));
	return { entries, closed: closes.length };
}

/**
 * Why this branch cannot be forked onto `childModel`, if it cannot. A
 * compaction an extension made may carry state bound to the model it was made
 * with (a native Codex checkpoint is opaque to every other model), so a fork
 * past one stays on this session's model. Pi's own compactions are plain-text
 * summaries any model reads.
 */
export function forkModelProblem(branch: Entry[], parentModel: string | undefined, childModel: string): string | undefined {
	const compaction = latestCompaction(branch);
	if (!compaction?.entry.fromHook || childModel === parentModel) return undefined;
	return `This conversation was compacted by an extension, whose compaction may only be readable by the model it was made for; fork it on this session's model (${parentModel ?? "unknown"}) or start a fresh agent.`;
}

/**
 * Write a forked child's session: a header naming the parent, the copied
 * history, and a {@link FORK_ENTRY} marker. Returns the file to start the child
 * on with `--session`. Without a session directory (a parent run with
 * `--no-session`) the file goes to a private temporary directory, returned as
 * `tempDir` for the caller to remove when the child is done with it.
 */
export function writeForkSession(input: {
	branch: Entry[];
	cwd: string;
	sessionDir?: string;
	parentSession?: string;
	version?: number;
	now?: number;
}): { file: string; entries: number; closed: number; tempDir?: string } {
	const now = input.now ?? Date.now();
	const { entries, closed } = forkHistory(input.branch, now);
	if (!entries.some((entry) => entry.type === "message" && (entry.message as Message).role !== "system")) {
		throw new Error("this session has no conversation to fork yet; start a fresh agent instead");
	}
	const id = randomUUID();
	const timestamp = new Date(now).toISOString();
	const header = {
		type: "session",
		version: input.version ?? 3,
		id,
		timestamp,
		cwd: input.cwd,
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
	};
	const marker = {
		type: "custom",
		customType: FORK_ENTRY,
		id: randomBytes(4).toString("hex"),
		parentId: entries.at(-1)?.id ?? null,
		timestamp,
		data: { ...(input.parentSession ? { parentSession: input.parentSession } : {}), entries: entries.length, closed },
	};
	let dir = input.sessionDir;
	let tempDir: string | undefined;
	if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
	else dir = tempDir = mkdtempSync(join(tmpdir(), "pi-agents-fork-"));
	const file = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	writeFileSync(file, [header, ...entries, marker].map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
	return { file, entries: entries.length, closed, ...(tempDir ? { tempDir } : {}) };
}
