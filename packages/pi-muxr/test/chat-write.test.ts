/**
 * Chat-write prototype tests.
 *
 * These pin the honest behaviour of an inherently unsafe operation. The
 * important assertions are the negative ones:
 *
 * - a refusal always means nothing was sent;
 * - an outcome that cannot be confirmed is reported `unknown`, never guessed;
 * - nothing is ever retried, and one request produces exactly one result.
 *
 * See `UPSTREAM-PROPOSAL.md` for the API that would replace all of it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	createChatWriteController,
	findUserEntry,
	parseChatWriteEnvelope,
} from "../src/chat-write.ts";
import type { ChatWriteResult } from "../src/chat-write.ts";
import { PROTOCOL } from "../src/contracts.ts";

const REQUEST = {
	requestId: "req-1",
	expectedLeafId: "leaf-1",
	expectedRuntimeGeneration: 3,
	text: "hello from the phone",
};

function userEntry(id: string, parentId: string, text: string) {
	return {
		id,
		type: "message",
		parentId,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

/** A controller with controllable consent, clock, and session state. */
function harness(
	options: {
		entries?: unknown[];
		leafId?: string | null;
		idle?: boolean;
		generation?: number;
		consent?: { enabled: boolean; reason?: string };
		send?: (text: string) => void;
	} = {},
) {
	const results: ChatWriteResult[] = [];
	const sent: string[] = [];
	let fire: (() => void) | null = null;
	let entries = options.entries ?? [];
	let leafId = options.leafId === undefined ? "leaf-1" : options.leafId;

	const ctx = {
		isIdle: () => options.idle ?? true,
		sessionManager: {
			buildContextEntries: () => entries as never[],
			getLeafId: () => leafId,
			getSessionId: () => "sess",
		},
	};

	const controller = createChatWriteController({
		send: (text) => {
			sent.push(text);
			options.send?.(text);
		},
		emit: (result) => results.push(result),
		getRuntimeGeneration: () => options.generation ?? 3,
		checkConsent: () => options.consent ?? { enabled: true },
		setTimer: (callback) => {
			fire = callback;
			return {
				cancel: () => {
					fire = null;
				},
			};
		},
	});

	return {
		controller,
		ctx,
		results,
		sent,
		/** Trip the observation window, as an unfired real timer would. */
		expire: () => fire?.(),
		setEntries: (next: unknown[]) => {
			entries = next;
		},
		setLeaf: (next: string | null) => {
			leafId = next;
		},
	};
}

test("a chat_write envelope is parsed only after full shape validation", () => {
	const envelope = {
		kind: "chat_write",
		protocol: PROTOCOL.bridge,
		bridgeEpoch: 1,
		registrationId: "reg-1",
		...REQUEST,
	};
	assert.deepEqual(parseChatWriteEnvelope(envelope), REQUEST);
	assert.throws(() => parseChatWriteEnvelope({ ...envelope, extra: true }), /unexpected key/);
	assert.throws(() => parseChatWriteEnvelope({ ...envelope, text: 42 }), /expected string/);
});

test("consent off refuses without sending anything", () => {
	const h = harness({ consent: { enabled: false, reason: "chat_write_disabled:setting" } });
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "rejected", reason: "chat_write_disabled:setting" },
	]);
});

test("a stale leaf refuses without sending, and says so", () => {
	const h = harness({ leafId: "leaf-moved" });
	h.controller.request(REQUEST, h.ctx);
	// Nothing was sent: this is the whole value of the preflight, even though
	// it cannot make the subsequent send atomic.
	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "rejected", reason: "binding_refused:leaf" },
	]);
});

test("a stale runtime generation refuses before the leaf is even consulted", () => {
	const h = harness({ generation: 4 });
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "rejected", reason: "binding_refused:runtime_generation" },
	]);
});

test("a busy session refuses rather than guessing a delivery mode", () => {
	const h = harness({ idle: false });
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "rejected", reason: "binding_refused:not_idle" },
	]);
});

test("a confirmed send resolves to the persisted entry id exactly once", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.sent, [REQUEST.text]);
	assert.deepEqual(h.results, []);

	h.controller.observeMessageStart({ role: "user", content: [{ type: "text", text: REQUEST.text }] });
	h.setEntries([userEntry("entry-9", "leaf-1", REQUEST.text)]);
	h.controller.resolve(h.ctx);

	assert.deepEqual(h.results, [{ requestId: "req-1", state: "accepted", entryId: "entry-9" }]);
	// Settled: a later resolve must not emit a second result for one request.
	h.controller.resolve(h.ctx);
	assert.equal(h.results.length, 1);
	assert.equal(h.controller.pendingRequestId, null);
});

test("an entry at the wrong parent is not accepted, even with identical text", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	// Same text, different parent: this is somebody else's message, and text
	// alone must never be the identity mechanism.
	h.setEntries([userEntry("entry-other", "leaf-somewhere-else", REQUEST.text)]);
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, []);
	assert.equal(h.controller.pendingRequestId, "req-1");
});

test("a moved leaf with no matching entry is unknown, never rejected", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	// The desktop user typed first: the leaf moved and our message is nowhere
	// to be found. It may still have landed, so the caller is told unknown and
	// must reconcile against the next snapshot.
	h.setLeaf("leaf-2");
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "unknown", reason: "leaf_moved_before_observation" },
	]);
});

test("an observed send whose entry never appears is unknown, and says it was observed", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.controller.observeMessageStart({ role: "user", content: [{ type: "text", text: REQUEST.text }] });
	h.setLeaf("leaf-2");
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, [
		{
			requestId: "req-1",
			state: "unknown",
			reason: "observed_but_leaf_moved_without_matching_entry",
		},
	]);
});

test("the observation window expiring reports unknown, and never retries", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.expire();
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "unknown", reason: "no_persisted_entry_within_window" },
	]);
	// Exactly one send. A retry after an unknown is how one prompt becomes two.
	assert.deepEqual(h.sent, [REQUEST.text]);
	assert.equal(h.controller.pendingRequestId, null);
});

test("a second request while one is in flight is refused, not queued", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.controller.request({ ...REQUEST, requestId: "req-2" }, h.ctx);
	assert.deepEqual(h.sent, [REQUEST.text]);
	assert.deepEqual(h.results, [
		{ requestId: "req-2", state: "rejected", reason: "request_in_flight" },
	]);
});

test("a send that throws is rejected, because nothing was delivered", () => {
	const h = harness({
		send: () => {
			throw new TypeError("no");
		},
	});
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "rejected", reason: "send_threw:TypeError" },
	]);
});

test("abandoning a pending request reports unknown, because it may have landed", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.controller.abandon("connection_closed");
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "unknown", reason: "connection_closed" },
	]);
	// Nothing pending, so a later abandon is silent rather than a second result.
	h.controller.abandon("session_shutdown");
	assert.equal(h.results.length, 1);
});

test("two identical sends can never resolve to the same entry", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.setEntries([userEntry("entry-9", "leaf-1", REQUEST.text)]);
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, [{ requestId: "req-1", state: "accepted", entryId: "entry-9" }]);

	// The same text, same parent, and only the already-claimed entry present.
	h.controller.request({ ...REQUEST, requestId: "req-2" }, h.ctx);
	h.controller.resolve(h.ctx);
	assert.equal(h.results.length, 1, "the claimed entry must not resolve a second request");

	// A genuinely new entry does resolve it.
	h.setEntries([
		userEntry("entry-9", "leaf-1", REQUEST.text),
		userEntry("entry-10", "leaf-1", REQUEST.text),
	]);
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results[1], { requestId: "req-2", state: "accepted", entryId: "entry-10" });
});

test("findUserEntry matches the newest unclaimed user entry at the parent", () => {
	const entries = [
		userEntry("e1", "leaf-1", "text"),
		userEntry("e2", "leaf-1", "text"),
		{ id: "e3", type: "compaction", parentId: "leaf-1", summary: "text" },
		{
			id: "e4",
			type: "message",
			parentId: "leaf-1",
			message: { role: "assistant", content: [{ type: "text", text: "text" }] },
		},
	];
	assert.equal(findUserEntry(entries, { parentId: "leaf-1", text: "text" }), "e2");
	assert.equal(
		findUserEntry(entries, { parentId: "leaf-1", text: "text", claimed: new Set(["e2"]) }),
		"e1",
	);
	assert.equal(findUserEntry(entries, { parentId: "leaf-1", text: "other" }), null);
	assert.equal(findUserEntry(entries, { parentId: "other-leaf", text: "text" }), null);
});
