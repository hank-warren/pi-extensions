import assert from "node:assert/strict";
import test from "node:test";
import {
	type AgentMessage,
	applyDrops,
	estimateBytes,
	type Item,
	PLACEHOLDER_BYTES,
	PLACEHOLDER_TEXT,
	selectDroppedImages,
	selectImages,
	toItems,
	type TrimPolicy,
	UNSEEN_PLACEHOLDER_TEXT,
} from "../trim.ts";

const policy = (overrides: Partial<TrimPolicy> = {}): TrimPolicy => ({
	maxImages: 100,
	dropBatch: 20,
	maxBytes: Number.POSITIVE_INFINITY,
	targetBytes: Number.POSITIVE_INFINITY,
	countText: false,
	...overrides,
});
const images = (...sizes: number[]): Item[] => sizes.map((bytes) => ({ kind: "image", bytes }));
const fixed = (bytes: number): Item => ({ kind: "fixed", bytes });
const image = (bytes: number) => ({ type: "image" as const, data: "x".repeat(bytes), mimeType: "image/png" });

test("keeps everything under both limits", () => {
	assert.equal(selectDroppedImages(images(10, 10, 10), policy({ maxBytes: 100, targetBytes: 60 })).size, 0);
});

test("drops a batch of the oldest once the count limit is exceeded", () => {
	const dropped = selectDroppedImages(images(...Array(101).fill(1)), policy());
	assert.deepEqual([...dropped], [...Array(21).keys()]);
});

test("does not drop again until the count limit is exceeded again", () => {
	assert.equal(selectDroppedImages(images(...Array(120).fill(1)), policy()).size, 21);
	assert.equal(selectDroppedImages(images(...Array(121).fill(1)), policy()).size, 21);
	assert.equal(selectDroppedImages(images(...Array(122).fill(1)), policy()).size, 42);
});

test("image-only policy drops oldest images down to the target and ignores text", () => {
	const items = [fixed(1_000), ...images(30, 30, 30, 30)];
	assert.deepEqual([...selectDroppedImages(items, policy({ maxBytes: 100, targetBytes: 60 }), 5_000)], [0, 1]);
});

test("whole-request policy counts text and the prompt toward the limit", () => {
	const items = [fixed(4_000), ...images(3_000, 3_000), fixed(500)];
	const p = policy({ maxBytes: 10_600, targetBytes: 9_500, countText: true });
	// 2 000 base + 4 000 + 3 000 + 3 000 = 12 000 > 10 600: the oldest image goes, leaving a placeholder.
	for (const text of [PLACEHOLDER_TEXT, UNSEEN_PLACEHOLDER_TEXT]) {
		assert.ok(Buffer.byteLength(JSON.stringify({ type: "text", text })) <= PLACEHOLDER_BYTES);
	}
	const dropped = selectDroppedImages(items, p, 2_000);
	assert.deepEqual([...dropped], [0]);
	assert.equal(estimateBytes(items, dropped, 2_000), 2_000 + 4_000 + PLACEHOLDER_BYTES + 3_000 + 500);
	// Without the prompt bytes the same conversation fits.
	assert.equal(selectDroppedImages(items, p, 0).size, 0);
});

test("text growth alone can trigger a prune of older images", () => {
	const items = [...images(3_000, 3_000), fixed(5_000)];
	const dropped = selectDroppedImages(items, policy({ maxBytes: 10_000, targetBytes: 8_500, countText: true }));
	assert.deepEqual([...dropped], [0]);
});

test("decisions for an unchanged prefix never change as the conversation grows", () => {
	const p = policy({ maxBytes: 9_500, targetBytes: 6_500, countText: true });
	const items: Item[] = [];
	let previous = new Set<number>();
	for (let turn = 0; turn < 200; turn++) {
		items.push(fixed(50 + (turn % 7) * 20), ...images(150 + (turn % 5) * 40));
		const dropped = selectDroppedImages(items, p, 300);
		for (const ordinal of previous) assert.ok(dropped.has(ordinal), `turn ${turn} restored image ${ordinal}`);
		previous = dropped;
	}
});

test("prunes in batches, not every turn", () => {
	const p = policy({ maxBytes: 9_500_000, targetBytes: 6_500_000, countText: true });
	const items: Item[] = [];
	let prunes = 0;
	let last = 0;
	for (let turn = 0; turn < 200; turn++) {
		items.push(fixed(5_000), ...images(160_000));
		const size = selectDroppedImages(items, p, 300_000).size;
		if (size > last) prunes++;
		last = size;
	}
	// ~32 MB of images through a 3 MB window: a handful of prunes, never one per turn.
	assert.ok(prunes > 3 && prunes < 20, `pruned ${prunes} times`);
});

test("keeps a Devin-sized session under its limit", () => {
	// The 2026-10-15 413: 59 images (9.47 MB) inside a 10.8 MB request.
	const items: Item[] = [];
	for (let i = 0; i < 59; i++) items.push(fixed(22_000), ...images(160_500));
	const p = policy({ maxBytes: 9_500_000, targetBytes: 6_500_000, countText: true });
	const dropped = selectDroppedImages(items, p, 30_000);
	assert.ok(dropped.size > 0);
	assert.ok(estimateBytes(items, dropped, 30_000) <= 9_500_000);
});

test("toItems sizes text blocks and images separately", () => {
	const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "look" }, image(500)], timestamp: 1 }];
	const items = toItems(messages);
	assert.equal(items.length, 2);
	assert.equal(items[0].kind, "fixed");
	assert.ok(items[0].bytes > 0 && items[0].bytes < 500);
	assert.deepEqual(items[1], { kind: "image", bytes: 500 });
});

test("applyDrops returns the same array when nothing is dropped", () => {
	const messages: AgentMessage[] = [{ role: "user", content: [image(5)], timestamp: 1 }];
	assert.equal(applyDrops(messages, new Set()), messages);
});

test("an image dropped after a reply was seen; one dropped in its first request was not", () => {
	const p = policy({ maxBytes: 10_000, targetBytes: 6_000, countText: true });
	// Image 0 goes out alone and gets a reply; images 1 and 2 arrive together and overflow the first request they are in.
	const items: Item[] = [...images(4_000), { kind: "sent" }, fixed(100), ...images(4_000, 4_000)];
	const { dropped, unseen } = selectImages(items, p);
	assert.deepEqual([...dropped], [0, 1]);
	assert.deepEqual([...unseen], [1]);
});

test("toItems marks each assistant reply", () => {
	const messages = [
		{ role: "user", content: [image(10)], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "red" }], timestamp: 2 },
	] as AgentMessage[];
	assert.deepEqual(
		toItems(messages).map((item) => item.kind),
		["fixed", "image", "sent", "fixed"],
	);
});

test("applyDrops replaces dropped images with placeholders and leaves the input untouched", () => {
	const user: AgentMessage = { role: "user", content: [{ type: "text", text: "look" }, image(60)], timestamp: 1 };
	const imageOnlyUser: AgentMessage = { role: "user", content: [image(60)], timestamp: 2 };
	const toolResult: AgentMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "screenshot",
		content: [image(60)],
		isError: false,
		timestamp: 3,
	};
	const latest: AgentMessage = { role: "user", content: [image(60)], timestamp: 4 };

	const result = applyDrops([user, imageOnlyUser, toolResult, latest], new Set([0, 1, 2]), new Set([1]));

	assert.deepEqual(result[0], { ...user, content: [{ type: "text", text: "look" }, { type: "text", text: PLACEHOLDER_TEXT }] });
	assert.deepEqual(result[1], { ...imageOnlyUser, content: [{ type: "text", text: UNSEEN_PLACEHOLDER_TEXT }] });
	assert.deepEqual(result[2], { ...toolResult, content: [{ type: "text", text: PLACEHOLDER_TEXT }] });
	assert.equal(result[3], latest);
	assert.equal((user.content as unknown[]).length, 2);
});

test("prunePayload replaces dropped images in every provider shape and keeps the rest", async () => {
	const { prunePayload } = await import("../trim.ts");
	const dropped = new Map([["AAAA", true], ["BBBB", false]]);
	const payload = {
		messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "image", source: { data: "KEEP" } }] }],
		input: [{ role: "user", content: [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,BBBB" }] }],
		chat: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
	};
	const result = prunePayload(payload, dropped) as typeof payload;
	assert.deepEqual(result.messages[0].content, [{ type: "text", text: PLACEHOLDER_TEXT }, { type: "image", source: { data: "KEEP" } }]);
	assert.deepEqual(result.input[0].content, [{ type: "input_text", text: UNSEEN_PLACEHOLDER_TEXT }]);
	assert.deepEqual(result.chat, [{ type: "text", text: PLACEHOLDER_TEXT }]);
	assert.equal(prunePayload(payload, new Map([["NONE", true]])), payload);
	assert.equal(payload.messages[0].content[0].type, "image", "input untouched");
});
