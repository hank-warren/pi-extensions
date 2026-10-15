import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILENAME } from "../config.ts";
import imagePrune, { IMAGE_BYTE_CAP, resolvePolicy } from "../index.ts";
import { type AgentMessage, UNSEEN_PLACEHOLDER_TEXT } from "../trim.ts";

type Handler = (event: { messages: AgentMessage[] }, ctx: unknown) => { messages: AgentMessage[] } | undefined;

const model = (provider: string, id: string, api: string, contextWindow = 200_000) =>
	({ provider, id, api, contextWindow }) as never;
const image = (bytes: number) => ({ type: "image" as const, data: "x".repeat(bytes), mimeType: "image/png" });

function setup() {
	const handlers = new Map<string, Handler>();
	const notes: string[] = [];
	const pi = {
		on: (event: string, fn: Handler) => handlers.set(event, fn),
		getActiveTools: () => ["read"],
		getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
	};
	imagePrune(pi as never);
	const ctx = (m: unknown) => ({
		model: m,
		hasUI: true,
		ui: { notify: (message: string) => notes.push(message) },
		getSystemPrompt: () => "system",
	});
	return {
		notes,
		context: (messages: AgentMessage[], m: unknown) => handlers.get("context")!({ messages }, ctx(m)),
		start: (m: unknown) => handlers.get("session_start")!({ messages: [] }, ctx(m)),
	};
}

function writeConfig(value: unknown) {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(join(getAgentDir(), CONFIG_FILENAME), JSON.stringify(value));
}

test("no rule: Claude Code defaults on anthropic-messages, nothing elsewhere", () => {
	const anthropic = resolvePolicy({ rules: [] }, model("anthropic", "claude-opus-5-5", "anthropic-messages", 1_000_000));
	assert.deepEqual(anthropic, {
		maxImages: 600,
		dropBatch: 20,
		maxBytes: IMAGE_BYTE_CAP,
		targetBytes: IMAGE_BYTE_CAP - 10 * 1024 * 1024,
		countText: false,
	});
	assert.equal(resolvePolicy({ rules: [] }, model("openai", "gpt-6", "openai-responses")), undefined);
	assert.equal(resolvePolicy({ rules: [] }, undefined), undefined);
});

test("a matching rule applies on any api and counts the whole request", () => {
	const config = { rules: [{ models: ["cpa/devin/*"], maxRequestBytes: 9_500_000, trimToBytes: 6_500_000 }] };
	const policy = resolvePolicy(config, model("cpa", "devin/gpt-6-luna", "openai-responses"));
	assert.equal(policy?.countText, true);
	assert.equal(policy?.maxBytes, 9_500_000);
	assert.equal(policy?.maxImages, Number.POSITIVE_INFINITY);
	assert.equal(resolvePolicy(config, model("cpa", "devin/claude-opus-5-5", "anthropic-messages"))?.maxImages, 100);
});

test("context hook prunes for a configured model and notifies once per new batch", () => {
	writeConfig({ rules: [{ models: ["cpa/devin/*"], maxRequestBytes: 100_000, trimToBytes: 60_000 }] });
	const devin = model("cpa", "devin/claude-opus-5-5", "anthropic-messages");
	const { context, start, notes } = setup();
	start(devin);

	const messages: AgentMessage[] = [];
	for (let i = 0; i < 5; i++) messages.push({ role: "user", content: [image(30_000)], timestamp: i });

	// No assistant reply yet, so the pruned images were never seen.
	const first = context(messages, devin);
	assert.ok(first);
	assert.deepEqual((first.messages[0] as { content: unknown }).content, [{ type: "text", text: UNSEEN_PLACEHOLDER_TEXT }]);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /limit 0\.1 MB/);

	context(messages, devin);
	assert.equal(notes.length, 1, "unchanged drops do not notify again");

	assert.equal(context(messages, model("cpa", "claude-sonnet-5", "openai-responses")), undefined);
});

test("a malformed config warns and falls back to defaults", () => {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(join(getAgentDir(), CONFIG_FILENAME), "{");
	const { start, notes } = setup();
	start(model("anthropic", "claude-opus-5-5", "anthropic-messages"));
	assert.match(notes[0] ?? "", /ignoring config/);
});
