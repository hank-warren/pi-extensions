import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextEvent["messages"][number];
type MediaMessage = Extract<AgentMessage, { role: "user" | "toolResult" | "custom" }>;
type Block = Exclude<MediaMessage["content"], string>[number];
type TextContent = Extract<Block, { type: "text" }>;

// A bare "media removed" led Opus to retract correct earlier answers about the image as made up, so say it was seen.
export const PLACEHOLDER_TEXT =
	"[image no longer included, to keep the request under the size limit. You saw it when this result first came back, so what you said about it then was based on the actual image.]";
export const UNSEEN_PLACEHOLDER_TEXT = "[image left out to keep the request under the size limit; you have not seen it]";
// Upper bound on the wire cost of a placeholder block, counted when a dropped image leaves one behind.
export const PLACEHOLDER_BYTES = 224;
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

/** `sent` marks an assistant reply: every image kept at that point was in the request that produced it. */
export type Item = { kind: "image"; bytes: number } | { kind: "fixed"; bytes: number } | { kind: "sent" };

export interface Selection {
	/** Ordinals (among images only) of images to leave out. */
	dropped: Set<number>;
	/** The dropped images that never reached the model, because they went out in their first request. */
	unseen: Set<number>;
}

/**
 * Chooses the images to leave out. The walk is oldest-first and depends only on
 * what came before each point, so an unchanged conversation prefix always gets
 * the same decisions.
 */
export function selectImages(items: readonly Item[], policy: TrimPolicy, baseBytes = 0): Selection {
	const dropped = new Set<number>();
	const unseen = new Set<number>();
	const seen = new Set<number>();
	const kept: Array<{ ordinal: number; bytes: number }> = [];
	const keepAfterCountTrim = Math.max(0, policy.maxImages - policy.dropBatch);
	const leftBehind = policy.countText ? PLACEHOLDER_BYTES : 0;
	let bytes = policy.countText ? baseBytes : 0;
	let ordinal = 0;

	const drop = (image: { ordinal: number; bytes: number }) => {
		dropped.add(image.ordinal);
		if (!seen.has(image.ordinal)) unseen.add(image.ordinal);
		bytes -= image.bytes - leftBehind;
	};

	for (const item of items) {
		if (item.kind === "sent") {
			for (const image of kept) seen.add(image.ordinal);
			continue;
		}
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

	return { dropped, unseen };
}

export function selectDroppedImages(items: readonly Item[], policy: TrimPolicy, baseBytes = 0): Set<number> {
	return selectImages(items, policy, baseBytes).dropped;
}

function contentBlocks(message: AgentMessage): Block[] | undefined {
	if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return undefined;
	return Array.isArray(message.content) ? message.content : undefined;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** Wire-size estimate of everything in a message except its images. Pi clones messages per request, so this is not cached. */
function fixedBytes(message: AgentMessage): number {
	const blocks = contentBlocks(message);
	return (
		MESSAGE_OVERHEAD_BYTES +
		(blocks
			? blocks.reduce((sum, block) => sum + (block.type === "image" ? 0 : byteLength(block)), 0)
			: byteLength(message))
	);
}

/** Flattens messages into the oldest-first sequence the selector walks. */
export function toItems(messages: readonly AgentMessage[]): Item[] {
	const items: Item[] = [];
	for (const message of messages) {
		if (message.role === "assistant") items.push({ kind: "sent" });
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
		else if (item.kind === "image") total += dropped.has(ordinal++) ? PLACEHOLDER_BYTES : item.bytes;
	}
	return total;
}

const placeholder = (seen: boolean): TextContent => ({
	type: "text",
	text: seen ? PLACEHOLDER_TEXT : UNSEEN_PLACEHOLDER_TEXT,
});

/**
 * Replaces each dropped image with a placeholder, in tool results and user
 * messages alike. Returns the same array when nothing is dropped and never
 * mutates the input messages.
 */
export function applyDrops(
	messages: AgentMessage[],
	dropped: ReadonlySet<number>,
	unseen: ReadonlySet<number> = new Set(),
): AgentMessage[] {
	if (dropped.size === 0) return messages;
	let imageIndex = 0;
	return messages.map((message) => {
		const blocks = contentBlocks(message);
		if (!blocks) return message;

		let changed = false;
		const content: Block[] = [];
		for (const block of blocks) {
			if (block.type !== "image") {
				content.push(block);
				continue;
			}
			const ordinal = imageIndex++;
			if (!dropped.has(ordinal)) {
				content.push(block);
				continue;
			}
			changed = true;
			// Unlike Claude Code, user images get a placeholder too: a silently vanished image invites the same doubt.
			content.push(placeholder(!unseen.has(ordinal)));
		}

		if (!changed) return message;
		return { ...message, content } as AgentMessage;
	});
}

/** Base64 data of each dropped image, mapped to whether the model had seen it. */
export function droppedImageData(
	messages: readonly AgentMessage[],
	dropped: ReadonlySet<number>,
	unseen: ReadonlySet<number>,
): Map<string, boolean> {
	const data = new Map<string, boolean>();
	if (dropped.size === 0) return data;
	let ordinal = 0;
	for (const message of messages) {
		for (const block of contentBlocks(message) ?? []) {
			if (block.type !== "image") continue;
			if (dropped.has(ordinal)) data.set(block.data, !unseen.has(ordinal));
			ordinal++;
		}
	}
	return data;
}

type Json = unknown;

function base64Of(part: Record<string, Json>): string | undefined {
	// Anthropic Messages: { type: "image", source: { data } }
	const source = part.source as Record<string, Json> | undefined;
	if (part.type === "image" && typeof source?.data === "string") return source.data;
	// OpenAI Responses: { type: "input_image", image_url: "data:...;base64,X" }
	if (part.type === "input_image" && typeof part.image_url === "string") return part.image_url.split(";base64,")[1];
	// OpenAI Chat Completions: { type: "image_url", image_url: { url } }
	const imageUrl = part.image_url as Record<string, Json> | undefined;
	if (part.type === "image_url" && typeof imageUrl?.url === "string") return imageUrl.url.split(";base64,")[1];
	return undefined;
}

function textPart(original: Record<string, Json>, text: string): Record<string, Json> {
	return { type: original.type === "input_image" ? "input_text" : "text", text };
}

/**
 * Re-applies drops to a finished provider payload. Needed when another
 * extension rebuilds the request from the session after the `context` hook ran
 * (pi-codex-compaction does, after a native checkpoint), which would otherwise
 * restore every pruned image. Returns the input unchanged when nothing matches.
 */
export function prunePayload(payload: Json, dropped: ReadonlyMap<string, boolean>): Json {
	if (dropped.size === 0) return payload;
	const walk = (node: Json): Json => {
		if (Array.isArray(node)) {
			let changed = false;
			const next = node.map((child) => {
				const replaced = walk(child);
				if (replaced !== child) changed = true;
				return replaced;
			});
			return changed ? next : node;
		}
		if (!node || typeof node !== "object") return node;
		const record = node as Record<string, Json>;
		const data = base64Of(record);
		if (data !== undefined && dropped.has(data)) {
			return textPart(record, dropped.get(data) ? PLACEHOLDER_TEXT : UNSEEN_PLACEHOLDER_TEXT);
		}
		let changed = false;
		const next: Record<string, Json> = {};
		for (const [key, value] of Object.entries(record)) {
			const replaced = walk(value);
			if (replaced !== value) changed = true;
			next[key] = replaced;
		}
		return changed ? next : node;
	};
	return walk(payload);
}
