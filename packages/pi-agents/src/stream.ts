import { parseStreamingJson } from "@earendil-works/pi-ai";

type Block = Record<string, unknown> & { type: string };

/** An assistant message as it streams in, rebuilt from RPC deltas (RPC sends no snapshots). */
export interface PartialAssistant {
	role: "assistant";
	content: Block[];
	/** Raw JSON of tool-call arguments still streaming, by content index. */
	pendingArgs: Map<number, string>;
}

export function startAssistant(): PartialAssistant {
	return { role: "assistant", content: [], pendingArgs: new Map() };
}

/**
 * Apply one `assistantMessageEvent` from an RPC `message_update`, as Pi's own
 * streaming does: text and thinking grow by deltas, tool-call arguments are
 * parsed as they stream so renderers can preview them.
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
			return;
		case "toolcall_delta": {
			const raw = `${message.pendingArgs.get(index) ?? ""}${delta}`;
			message.pendingArgs.set(index, raw);
			try {
				at({ type: "toolCall", id: `pending-${index}`, name: "tool", arguments: {} }).arguments = parseStreamingJson(raw);
			} catch {
				// Not parseable yet: keep the last good arguments.
			}
			return;
		}
		case "toolcall_end":
			if (event.toolCall && typeof event.toolCall === "object") message.content[index] = { type: "toolCall", ...(event.toolCall as Record<string, unknown>) };
			message.pendingArgs.delete(index);
			return;
	}
}

/** The message as Pi's components take it: no gaps from content still to arrive. */
export function snapshot(message: PartialAssistant): { role: "assistant"; content: Block[] } {
	return { role: "assistant", content: message.content.filter(Boolean) };
}
