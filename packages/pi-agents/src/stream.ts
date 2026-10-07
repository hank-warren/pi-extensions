import { parseStreamingJson } from "@earendil-works/pi-ai";

type Block = Record<string, unknown> & { type: string };

/** An assistant message as it streams in, rebuilt from RPC deltas (RPC sends no snapshots). */
export interface PartialAssistant {
	role: "assistant";
	content: Block[];
	/** Raw JSON of tool-call arguments still streaming, by content index. */
	pendingArgs: Map<number, string>;
	/** Length of each pending raw JSON when it was last parsed. */
	parsedAt: Map<number, number>;
}

export function startAssistant(): PartialAssistant {
	return { role: "assistant", content: [], pendingArgs: new Map(), parsedAt: new Map() };
}

/**
 * Apply one `assistantMessageEvent` from an RPC `message_update`: text and
 * thinking grow by deltas, tool-call arguments accumulate as raw JSON. Cheap
 * and constant per delta, because the parent applies every agent's stream
 * whether or not anyone watches it; `snapshot` parses the arguments.
 */
export function applyAssistantEvent(message: PartialAssistant, event: Record<string, unknown>): void {
	const index = typeof event.contentIndex === "number" ? event.contentIndex : -1;
	const at = (fallback: Block): Block => {
		message.content[index] ??= fallback;
		return message.content[index]!;
	};
	const delta = typeof event.delta === "string" ? event.delta : "";
	switch (event.type) {
		case "text_start":
			message.content[index] = { type: "text", text: "" };
			return;
		case "text_delta": {
			const block = at({ type: "text", text: "" });
			block.text = `${String(block.text ?? "")}${delta}`;
			return;
		}
		case "text_end":
			if (typeof event.content === "string") at({ type: "text", text: "" }).text = event.content;
			return;
		case "thinking_start":
			message.content[index] = { type: "thinking", thinking: "" };
			return;
		case "thinking_delta": {
			const block = at({ type: "thinking", thinking: "" });
			block.thinking = `${String(block.thinking ?? "")}${delta}`;
			return;
		}
		case "thinking_end":
			if (typeof event.content === "string") at({ type: "thinking", thinking: "" }).thinking = event.content;
			return;
		case "toolcall_start":
			message.content[index] = { type: "toolCall", id: String(event.id ?? `pending-${index}`), name: String(event.toolName ?? "tool"), arguments: {} };
			message.pendingArgs.set(index, "");
			message.parsedAt.set(index, 0);
			return;
		case "toolcall_delta":
			at({ type: "toolCall", id: `pending-${index}`, name: "tool", arguments: {} });
			message.pendingArgs.set(index, `${message.pendingArgs.get(index) ?? ""}${delta}`);
			return;
		case "toolcall_end":
			if (event.toolCall && typeof event.toolCall === "object") message.content[index] = { type: "toolCall", ...(event.toolCall as Record<string, unknown>) };
			message.pendingArgs.delete(index);
			message.parsedAt.delete(index);
			return;
	}
}

/**
 * The message as Pi's components take it: no gaps from content still to
 * arrive, and streaming tool arguments parsed for preview. Each argument
 * string is parsed only when it grew since the last call, so a viewer that
 * snapshots once per frame pays once per frame, not once per delta.
 */
export function snapshot(message: PartialAssistant): { role: "assistant"; content: Block[] } {
	for (const [index, raw] of message.pendingArgs) {
		if (message.parsedAt.get(index) === raw.length) continue;
		message.parsedAt.set(index, raw.length);
		const block = message.content[index];
		if (!block) continue;
		try {
			block.arguments = parseStreamingJson(raw);
		} catch {
			// Not parseable yet: keep the last good arguments.
		}
	}
	return { role: "assistant", content: message.content.filter(Boolean) };
}
