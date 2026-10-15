// Composition: pi-codex-compaction rebuilds the request from the session after a
// native checkpoint, which would restore images pi-image-prune left out.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { registerCodexCompactionExtension } from "../packages/pi-codex-compaction/index.ts";
import { modelKey, NATIVE_COMPACTION_KIND } from "../packages/pi-codex-compaction/native-compaction.ts";
import imagePrune from "../packages/pi-image-prune/index.ts";
import { PLACEHOLDER_TEXT, UNSEEN_PLACEHOLDER_TEXT } from "../packages/pi-image-prune/trim.ts";
import { createMockContext, createMockPi } from "./support/mock-pi.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-6-astra", name: "GPT 6 Astra", api: "openai-responses", provider: "cpa",
	baseUrl: "https://proxy.example/v1", reasoning: true, input: ["text", "image"],
	contextWindow: 400_000, maxTokens: 16_384, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
};

let id = 0;
const at = () => new Date().toISOString();
function entry(message: Record<string, unknown>, parentId: string | null): SessionEntry {
	return { type: "message", id: `e${++id}`, parentId, timestamp: at(), message: { timestamp: Date.now(), ...message } } as SessionEntry;
}

async function scenario(replacementHistory: unknown[], tailTurns: number, rule: Record<string, unknown> = {}) {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(join(getAgentDir(), "pi-image-prune.json"), JSON.stringify({
		rules: [{ models: ["cpa/gpt-6-*"], maxRequestBytes: 100_000, trimToBytes: 60_000, ...rule }],
	}));
	const first = entry({ role: "user", content: [{ type: "text", text: "start" }] }, null);
	const checkpoint: SessionEntry = {
		type: "compaction", id: "checkpoint", parentId: first.id, timestamp: at(), summary: "marker",
		firstKeptEntryId: first.id, tokensBefore: 50_000,
		details: { kind: NATIVE_COMPACTION_KIND, version: 1, modelKey: modelKey(model), replacementHistory },
	} as SessionEntry;
	const branch: SessionEntry[] = [first, checkpoint];
	// Screenshot turns after the checkpoint, each followed by a reply, 30 kB each.
	for (let turn = 0; turn < tailTurns; turn++) {
		const data = String.fromCharCode(65 + turn).repeat(30_000);
		branch.push(entry({ role: "user", content: [{ type: "text", text: `shot ${turn}` }, { type: "image", data, mimeType: "image/png" }] }, branch.at(-1)!.id));
		branch.push(entry({ role: "assistant", content: [{ type: "text", text: `seen ${turn}` }], api: model.api,
			provider: model.provider, model: model.id, stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, branch.at(-1)!.id));
	}

	// Manifest order: pi-codex-compaction registers before pi-image-prune.
	const mock = createMockPi();
	registerCodexCompactionExtension(mock.pi, "0.84.4");
	imagePrune(mock.pi);
	const { ctx } = createMockContext({
		model, mode: "tui", hasUI: false, getSystemPrompt: () => "system",
		sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
	});
	const run = async (name: string, event: Record<string, unknown>, key: "messages" | "payload") => {
		let value = event[key];
		for (const handler of mock.events.get(name) ?? []) {
			const result = await handler({ ...event, [key]: value }, ctx);
			if (result !== undefined) value = key === "messages" ? (result as { messages: unknown }).messages ?? value : result;
		}
		return value;
	};
	for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);

	const tail = branch.slice(2).map((e) => (e as { message: unknown }).message);
	const messages = (await run("context", { messages: tail }, "messages")) as Array<{ content: Array<{ type: string }> }>;
	const keptInContext = messages.flatMap((m) => m.content).filter((b) => b.type === "image").length;
	const payload = (await run("before_provider_request", { payload: { model: model.id, input: [{ role: "developer", content: "system" }] } }, "payload")) as { input: unknown[] };
	return { keptInContext, serialized: JSON.stringify(payload.input) };
}

const compactionItem = { type: "compaction", encrypted_content: "opaque" };

test("a payload rebuilt after a native checkpoint stays under the limit", async () => {
	const { keptInContext, serialized } = await scenario([compactionItem], 4);
	assert.ok(keptInContext < 4, "the context hook pruned something");
	assert.ok(serialized.includes("opaque"), "codex-compaction rebuilt the request from its checkpoint");
	assert.ok(serialized.length <= 100_000, `payload ${serialized.length} bytes`);
	assert.ok(serialized.includes(PLACEHOLDER_TEXT));
});

test("decisions on a rebuilt payload's prefix hold as the conversation grows", async () => {
	const retained = (c: string) => ({ type: "message", role: "user", content: [{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${c.repeat(30_000)}` }] });
	const history = [retained("X"), retained("Y"), compactionItem];
	const imagesKept = (serialized: string) => [..."XYAB CD"].filter((c) => c !== " " && serialized.includes(c.repeat(30_000)));
	const before = imagesKept((await scenario(history, 2)).serialized);
	const after = imagesKept((await scenario(history, 4)).serialized);
	for (const gone of ["X", "Y", "A", "B"].filter((c) => !before.includes(c))) {
		assert.ok(!after.includes(gone), `${gone} came back after the conversation grew (before ${before}, after ${after})`);
	}
});

test("a new image pruned only by the payload pass is marked unseen", async () => {
	const { serialized } = await scenario([{ type: "compaction", encrypted_content: "E".repeat(75_000) }], 1);
	assert.ok(!serialized.includes("A".repeat(30_000)));
	assert.ok(serialized.includes(UNSEEN_PLACEHOLDER_TEXT));
});

test("the limit covers images and encrypted state carried in the checkpoint", async () => {
	// The context hook sees only 2 tail images (60 kB): under the limit. The checkpoint adds 2 more images and 20 kB of state.
	const retained = (c: string) => ({ type: "message", role: "user", content: [{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${c.repeat(30_000)}` }] });
	const { keptInContext, serialized } = await scenario(
		[retained("X"), retained("Y"), { type: "compaction", encrypted_content: "E".repeat(20_000) }],
		2,
	);
	assert.equal(keptInContext, 2, "the context pass alone saw nothing to prune");
	assert.ok(serialized.length <= 100_000, `payload ${serialized.length} bytes`);
	assert.ok(!serialized.includes("X".repeat(30_000)), "the oldest checkpoint image went first");
	assert.ok(serialized.includes(PLACEHOLDER_TEXT));
});

test("the image count limit covers images carried in the checkpoint", async () => {
	const retained = (c: string) => ({ type: "message", role: "user", content: [{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${c.repeat(100)}` }] });
	const { keptInContext, serialized } = await scenario(
		[...["P", "Q", "R", "S", "T"].map(retained), compactionItem],
		1,
		{ maxImages: 4, maxRequestBytes: 10_000_000, trimToBytes: 5_000_000 },
	);
	assert.equal(keptInContext, 1, "the context pass alone saw 1 image");
	assert.ok((serialized.match(/"input_image"/g) ?? []).length <= 4);
});
