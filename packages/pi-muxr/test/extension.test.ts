/**
 * Extension-surface tests.
 *
 * These assert what the extension *asks Pi to do*, using the shared mock, and
 * in particular the two invariants that make it safe to load in a session it
 * is only supposed to observe:
 *
 * - with no flags set it is completely inert: no socket, no send, no state;
 * - no event handler ever returns a value, because a `message_end` handler
 *   that returns `{ message }` replaces what Pi persists.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";
import muxrExtension, { FLAGS } from "../src/extension.ts";

/** Load the extension against a fresh mock and return the harness. */
function load() {
	const harness = createMockPi();
	muxrExtension(harness.pi);
	return harness;
}

/** Invoke every registered handler for `name`, returning what they returned. */
async function fire(
	harness: ReturnType<typeof createMockPi>,
	name: string,
	event: unknown,
	ctx: unknown,
): Promise<unknown[]> {
	const handlers = harness.events.get(name) ?? [];
	return Promise.all(handlers.map((handler) => handler(event, ctx)));
}

test("it registers its flags and nothing else", () => {
	const harness = load();
	assert.deepEqual([...harness.flags.keys()].sort(), [
		"muxr-binding-file",
		"muxr-bridge-socket",
		"muxr-capability-file",
		"muxr-experimental-chat-write",
		"muxr-registration-id",
	]);
	// No tool and no command: the model never invokes this, and a tool would
	// put a write path in the model's hands.
	assert.deepEqual(harness.tools, []);
	assert.deepEqual([...harness.commands.keys()], []);
});

test("the chat-write flag is a boolean defaulting to false", () => {
	const harness = load();
	const flag = harness.flags.get(FLAGS.experimentalChatWrite) as Record<string, unknown>;
	assert.equal(flag.type, "boolean");
	assert.equal(flag.default, false);
	// The transport flags carry paths, so they are strings with no default: an
	// absent one must leave the extension inert rather than resolve somewhere.
	for (const name of [FLAGS.bridgeSocket, FLAGS.capabilityFile, FLAGS.registrationId, FLAGS.bindingFile]) {
		const transport = harness.flags.get(name) as Record<string, unknown>;
		assert.equal(transport.type, "string");
		assert.equal(transport.default, undefined);
	}
});

test("it subscribes to exactly the observation events it projects", () => {
	const harness = load();
	assert.deepEqual([...harness.events.keys()].sort(), [
		"agent_settled",
		"message_end",
		"message_start",
		"message_update",
		"session_shutdown",
		"session_start",
		"tool_execution_end",
		"tool_execution_start",
		"turn_end",
	]);
});

test("with no flags set it is inert: nothing is sent and no handler throws", async () => {
	const harness = load();
	const ctx = createMockContext();

	// session_start with no transport flags must not open a socket or throw.
	await fire(harness, "session_start", {}, ctx);

	const events: Array<[string, unknown]> = [
		["message_start", { message: { role: "assistant", content: [] } }],
		["message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } }],
		["message_end", { message: { role: "assistant", content: [] } }],
		["tool_execution_start", { toolCallId: "c1", toolName: "bash" }],
		["tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: false }],
		["turn_end", {}],
		["agent_settled", {}],
		["session_shutdown", {}],
	];
	for (const [name, event] of events) {
		await fire(harness, name, event, ctx);
	}

	// The strongest statement available through the mock: it never asked Pi to
	// send anything, and never persisted an entry.
	assert.deepEqual(harness.sentUserMessages, []);
	assert.deepEqual(harness.sentMessages, []);
	assert.deepEqual(harness.entries, []);
});

test("no handler returns a value, so Pi's persisted state is never rewritten", async () => {
	const harness = load();
	const ctx = createMockContext();
	// A message_end handler returning { message } would replace the finalized
	// message before Pi persists it ($PI/docs/extensions.md). This extension
	// observes; it must never be the thing that rewrote a transcript.
	const returned = [
		...(await fire(harness, "session_start", {}, ctx)),
		...(await fire(harness, "message_start", { message: { role: "assistant", content: [] } }, ctx)),
		...(await fire(
			harness,
			"message_end",
			{ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
			ctx,
		)),
		...(await fire(harness, "turn_end", {}, ctx)),
		...(await fire(harness, "agent_settled", {}, ctx)),
		...(await fire(harness, "session_shutdown", {}, ctx)),
	];
	assert.equal(
		returned.every((value) => value === undefined),
		true,
	);
});

test("a user message is never projected as a provisional assistant stream", async () => {
	const harness = load();
	const ctx = createMockContext();
	await fire(harness, "session_start", {}, ctx);
	// Unregistered, so nothing is emitted either way; what matters is that the
	// user branch does not throw on a missing projection and does not ask Pi
	// for anything.
	await fire(
		harness,
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "typed by the human" }] } },
		ctx,
	);
	assert.deepEqual(harness.sentUserMessages, []);
});

test("the only send path refuses prompt-template expansion explicitly", async () => {
	// Remote text is the least trusted input in the system. Pi's own default is
	// already false, so this pins that a future upstream flip cannot start
	// dispatching a "/"-prefixed remote message as an extension command.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
	assert.match(source, /expandPromptTemplates:\s*false/);
	// And there is exactly one sendUserMessage call site to reason about.
	assert.equal(source.match(/sendUserMessage\(/g)?.length, 1);
});
