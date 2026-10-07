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

export interface ForkHistory {
	entries: Entry[];
	/** Entries of the parent's history the child's model sees, closed calls included. */
	messages: number;
	/** Tool calls closed with {@link FORK_NOTE}. */
	closed: number;
}

/**
 * The parent's model context as a linear session the child resumes. Takes
 * `buildContextEntries()` (the compaction-aware path) and keeps only what
 * reaches the model: messages, custom messages, branch summaries and the
 * newest compaction. Extension state, labels and settings changes are left
 * behind so the child's extensions start clean, context edits are applied,
 * and the tool calls of the parent's in-flight assistant message are closed,
 * since the call that started the child has no result yet.
 */
export function forkHistory(contextEntries: Entry[], now = Date.now()): ForkHistory {
	const edits = new Map<string, { replacement: { content: unknown } | null }>();
	for (const entry of contextEntries) {
		if (entry.type === "context_edit" && typeof entry.targetId === "string") edits.set(entry.targetId, entry as never);
	}
	const kept: Entry[] = [];
	contextEntries.forEach((entry, index) => {
		const edit = edits.get(entry.id);
		if (edit && edit.replacement === null) return;
		const content = edit?.replacement?.content;
		if (entry.type === "message") {
			const message = entry.message as Message;
			const editable = message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "custom";
			const replaced = edit && editable
				? (message.role === "assistant" || message.role === "toolResult") && typeof content === "string" ? [{ type: "text", text: content }] : content
				: undefined;
			kept.push(replaced === undefined ? entry : { ...entry, message: { ...message, content: replaced } });
		} else if (entry.type === "custom_message") {
			kept.push(edit ? { ...entry, content } : entry);
		} else if (entry.type === "branch_summary" && entry.summary) {
			kept.push(entry);
		} else if (entry.type === "compaction" && index === 0) {
			// buildContextEntries() puts the newest compaction first; an older one it keeps contributes nothing.
			kept.push(entry);
		}
	});

	const ids = new Set(kept.map((entry) => entry.id));
	const newId = () => {
		let id: string;
		do id = randomBytes(4).toString("hex");
		while (ids.has(id));
		ids.add(id);
		return id;
	};
	const timestamp = new Date(now).toISOString();
	const closes: Entry[] = [];
	let lastAssistant = kept.length - 1;
	while (lastAssistant >= 0 && !(kept[lastAssistant]!.type === "message" && (kept[lastAssistant]!.message as Message).role === "assistant")) lastAssistant--;
	if (lastAssistant >= 0) {
		const answered = new Set(kept.slice(lastAssistant + 1).map((entry) => (entry.message as Message | undefined)?.toolCallId));
		const content = (kept[lastAssistant]!.message as Message).content;
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

	const history = [...kept, ...closes];
	const first = history[0];
	const entries: Entry[] = history.map((entry, index) => ({ ...entry, parentId: index ? history[index - 1]!.id : null }));
	// The compaction comes first here, so everything after it is kept: point at that, as a compaction placed before its kept entries would.
	if (first?.type === "compaction") entries[0] = { ...entries[0]!, firstKeptEntryId: entries[1]?.id ?? first.id };
	return { entries, messages: entries.length, closed: closes.length };
}

/**
 * Write a forked child's session: a header naming the parent, the copied
 * history, and a {@link FORK_ENTRY} marker. Returns the file to start the child
 * on with `--session`. Without a session directory (a parent run with
 * `--no-session`) the file goes to a private temporary directory.
 */
export function writeForkSession(input: {
	contextEntries: Entry[];
	cwd: string;
	sessionDir?: string;
	parentSession?: string;
	version?: number;
	now?: number;
}): { file: string; messages: number; closed: number } {
	const now = input.now ?? Date.now();
	const { entries, messages, closed } = forkHistory(input.contextEntries, now);
	if (!messages) throw new Error("this session has no conversation to fork yet; start a fresh agent instead");
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
		data: { ...(input.parentSession ? { parentSession: input.parentSession } : {}), messages, closed },
	};
	let dir = input.sessionDir;
	if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
	else dir = mkdtempSync(join(tmpdir(), "pi-agents-fork-"));
	const file = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	writeFileSync(file, [header, ...entries, marker].map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
	return { file, messages, closed };
}
