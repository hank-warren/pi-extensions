import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextEvent["messages"][number];
type MediaMessage = Extract<AgentMessage, { role: "user" | "toolResult" | "custom" }>;
type Block = Exclude<MediaMessage["content"], string>[number];
type TextContent = Extract<Block, { type: "text" }>;

export const PLACEHOLDER_TEXT = "[media removed: request limit]";
// Rough wire cost of a placeholder block, counted when a dropped image leaves one behind.
const PLACEHOLDER_BYTES = 64;
// Per-message wire overhead (role, wrapper keys) that block sizes do not include.
const MESSAGE_OVERHEAD_BYTES = 64;

/**
 * How one request is trimmed. Both limits trim oldest images first, in batches:
 * once a limit is crossed, enough images go to land well below it, so the next
 * several requests share an unchanged prefix and the prompt cache survives.
 */
export interface TrimPolicy {
	/** Most images kept; crossing it drops `dropBatch` more than the excess. */
	maxImages: number;
	dropBatch: number;
	/** Crossing `maxBytes` drops oldest images until the total is at or below `targetBytes`. */
	maxBytes: number;
	targetBytes: number;
	/** Count text and tool bytes (never dropped) toward the byte limit, not just images. */
	countText: boolean;
}

export type Item = { kind: "image"; bytes: number } | { kind: "fixed"; bytes: number };

/**
 * Returns the ordinals (among images only) of images to drop. The walk is
 * oldest-first and depends only on what came before each point, so an
 * unchanged conversation prefix always gets the same decisions.
 */
export function selectDroppedImages(items: readonly Item[], policy: TrimPolicy, baseBytes = 0): Set<number> {
	const dropped = new Set<number>();
	const kept: Array<{ ordinal: number; bytes: number }> = [];
	const keepAfterCountTrim = Math.max(0, policy.maxImages - policy.dropBatch);
	const leftBehind = policy.countText ? PLACEHOLDER_BYTES : 0;
	let bytes = policy.countText ? baseBytes : 0;
	let ordinal = 0;

	const drop = (image: { ordinal: number; bytes: number }) => {
		dropped.add(image.ordinal);
		bytes -= image.bytes - leftBehind;
	};

	for (const item of items) {
		if (item.kind === "fixed") {
			if (policy.countText) bytes += item.bytes;
		} else {
			kept.push({ ordinal: ordinal++, bytes: item.bytes });
			bytes += item.bytes;
			if (kept.length > policy.maxImages) {
				for (const old of kept.splice(0, kept.length - keepAfterCountTrim)) drop(old);
			}
		}

		if (bytes > policy.maxBytes) {
			for (let k = 0; k < kept.length && bytes > policy.targetBytes; ) {
				// Dropping an image no bigger than its placeholder would not shrink the request.
				if (kept[k].bytes <= leftBehind) {
					k++;
					continue;
				}
				drop(kept.splice(k, 1)[0]);
			}
		}
	}

	return dropped;
}

function contentBlocks(message: AgentMessage): Block[] | undefined {
	if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return undefined;
	return Array.isArray(message.content) ? message.content : undefined;
}

const fixedBytesCache = new WeakMap<object, number>();

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** Wire-size estimate of everything in a message except its images. Messages are immutable, so it is cached. */
function fixedBytes(message: AgentMessage): number {
	const cached = fixedBytesCache.get(message);
	if (cached !== undefined) return cached;
	const blocks = contentBlocks(message);
	const size =
		MESSAGE_OVERHEAD_BYTES +
		(blocks
			? blocks.reduce((sum, block) => sum + (block.type === "image" ? 0 : byteLength(block)), 0)
			: byteLength(message));
	fixedBytesCache.set(message, size);
	return size;
}

/** Flattens messages into the oldest-first sequence the selector walks. */
export function toItems(messages: readonly AgentMessage[]): Item[] {
	const items: Item[] = [];
	for (const message of messages) {
		items.push({ kind: "fixed", bytes: fixedBytes(message) });
		for (const block of contentBlocks(message) ?? []) {
			if (block.type === "image") items.push({ kind: "image", bytes: block.data.length });
		}
	}
	return items;
}

/** Estimated request bytes after dropping `dropped`, for reporting. */
export function estimateBytes(items: readonly Item[], dropped: ReadonlySet<number>, baseBytes: number): number {
	let total = baseBytes;
	let ordinal = 0;
	for (const item of items) {
		if (item.kind === "fixed") total += item.bytes;
		else total += dropped.has(ordinal++) ? PLACEHOLDER_BYTES : item.bytes;
	}
	return total;
}

const placeholder = (): TextContent => ({ type: "text", text: PLACEHOLDER_TEXT });

/** Returns the same array when nothing is dropped. Never mutates the input messages. */
export function applyDrops(messages: AgentMessage[], dropped: ReadonlySet<number>): AgentMessage[] {
	if (dropped.size === 0) return messages;
	let imageIndex = 0;
	return messages.map((message) => {
		const blocks = contentBlocks(message);
		if (!blocks) return message;

		let changed = false;
		const content: Block[] = [];
		for (const block of blocks) {
			if (block.type !== "image" || !dropped.has(imageIndex++)) {
				content.push(block);
				continue;
			}
			changed = true;
			// Claude Code removes loose images outright and replaces images inside tool results.
			if (message.role === "toolResult") content.push(placeholder());
		}

		if (!changed) return message;
		return { ...message, content: content.length > 0 ? content : [placeholder()] } as AgentMessage;
	});
}
