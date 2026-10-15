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

/** One occurrence of an image's data in the conversation, oldest first. */
export interface Occurrence {
	dropped: boolean;
	seen: boolean;
}

/**
 * Every occurrence of every image, keyed by its base64 data. Occurrences matter
 * because re-reading a file yields identical data: an older copy can be dropped
 * while a newer one is kept.
 */
export function imageOccurrences(
	messages: readonly AgentMessage[],
	dropped: ReadonlySet<number>,
	unseen: ReadonlySet<number>,
): Map<string, Occurrence[]> {
	const all = new Map<string, Occurrence[]>();
	let ordinal = 0;
	for (const message of messages) {
		for (const block of contentBlocks(message) ?? []) {
			if (block.type !== "image") continue;
			const list = all.get(block.data) ?? [];
			list.push({ dropped: dropped.has(ordinal), seen: !unseen.has(ordinal) });
			all.set(block.data, list);
			ordinal++;
		}
	}
	return all;
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

/** Image parts of a payload, in serialization order. */
function payloadImages(payload: Json): string[] {
	const images: string[] = [];
	const visit = (node: Json) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== "object") return;
		const data = base64Of(node as Record<string, Json>);
		if (data !== undefined) return void images.push(data);
		Object.values(node).forEach(visit);
	};
	visit(payload);
	return images;
}

/** Replaces the image parts `replacement` returns text for (by serialization-order index). Copy-on-write. */
function replaceImages(payload: Json, replacement: (index: number) => string | undefined): Json {
	let index = 0;
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
		if (base64Of(record) !== undefined) {
			const text = replacement(index++);
			return text === undefined ? node : textPart(record, text);
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

/**
 * Matches a payload's image copies to conversation occurrences. A payload's
 * copies of one image are the newest of its occurrences (drops take the oldest
 * first, and a rebuilt payload covers a suffix of the conversation), so copies
 * are matched counting from the end. Copies with no occurrence, such as images
 * carried in a compaction checkpoint, are undefined.
 */
function matchOccurrences(images: readonly string[], occurrences: ReadonlyMap<string, readonly Occurrence[]>) {
	const copies = new Map<string, number>();
	for (const data of images) copies.set(data, (copies.get(data) ?? 0) + 1);
	const nth = new Map<string, number>();
	return images.map((data) => {
		const list = occurrences.get(data);
		const copy = nth.get(data) ?? 0;
		nth.set(data, copy + 1);
		return list?.[list.length - copies.get(data)! + copy];
	});
}

/**
 * Re-applies drops to a finished provider payload. Needed when another
 * extension rebuilds the request from the session after the `context` hook ran
 * (pi-codex-compaction does, after a native checkpoint), which would otherwise
 * restore every pruned image. Returns the input unchanged when nothing matches.
 */
export function prunePayload(payload: Json, occurrences: ReadonlyMap<string, readonly Occurrence[]>): Json {
	if (![...occurrences.values()].some((list) => list.some((o) => o.dropped))) return payload;
	const matched = matchOccurrences(payloadImages(payload), occurrences);
	if (!matched.some((o) => o?.dropped)) return payload;
	return replaceImages(payload, (index) => {
		const occurrence = matched[index];
		if (!occurrence?.dropped) return undefined;
		return occurrence.seen ? PLACEHOLDER_TEXT : UNSEEN_PLACEHOLDER_TEXT;
	});
}

const SLOT = "__pi_image_prune_slot__";

/**
 * Enforces a policy's limits on the finished payload, which can hold more than
 * the `context` hook saw (a compaction checkpoint's retained history and
 * encrypted state). Same oldest-first batch walk as the context pass, over the
 * payload itself, so an unchanged payload prefix gets the same drops. Returns
 * the payload and how many more images it left out.
 */
export function enforcePayloadLimit(
	payload: Json,
	policy: TrimPolicy,
	occurrences: ReadonlyMap<string, readonly Occurrence[]>,
): { payload: Json; dropped: number } {
	const unchanged = { payload, dropped: 0 };
	const images = payloadImages(payload);
	if (images.length === 0) return unchanged;
	const overCount = images.length > policy.maxImages;

	const items: Item[] = [];
	if (policy.countText) {
		const sizes: number[] = [];
		const slotted = replaceImages(payload, (index) => {
			sizes.push(Buffer.byteLength(JSON.stringify({ type: "image", data: images[index] }), "utf8"));
			return SLOT;
		});
		const segments = JSON.stringify(slotted).split(new RegExp(`\\{"type":"(?:input_)?text","text":"${SLOT}"\\}`));
		if (segments.length !== images.length + 1) return unchanged;
		segments.forEach((segment, index) => {
			items.push({ kind: "fixed", bytes: Buffer.byteLength(segment, "utf8") });
			if (index < images.length) items.push({ kind: "image", bytes: sizes[index] });
		});
	} else {
		// Image-only policies size images by their data, as the context pass does.
		for (const data of images) items.push({ kind: "image", bytes: data.length });
	}
	if (!overCount && estimateBytes(items, new Set(), 0) <= policy.maxBytes) return unchanged;

	const { dropped } = selectImages(items, policy);
	if (dropped.size === 0) return unchanged;
	const matched = matchOccurrences(images, occurrences);
	const next = replaceImages(payload, (index) => {
		if (!dropped.has(index)) return undefined;
		// Checkpoint images have no occurrence; they were sent before the checkpoint, so seen.
		return matched[index]?.seen === false ? UNSEEN_PLACEHOLDER_TEXT : PLACEHOLDER_TEXT;
	});
	return { payload: next, dropped: dropped.size };
}
