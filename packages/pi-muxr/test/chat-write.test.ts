/**
 * Chat-write prototype tests.
 *
 * These pin the honest behaviour of an inherently unsafe operation. The
 * important assertions are the negative ones:
 *
 * - a refusal always means nothing was sent;
 * - an outcome that cannot be confirmed is reported `unknown`, never guessed;
 * - **no code path compares message text** — the mechanism muxr's register
 *   rejects, and the one that previously let a desktop user's identical message
 *   be claimed as ours;
 * - nothing is ever retried, and one request produces exactly one result.
 *
 * See `UPSTREAM-PROPOSAL.md` for the API that would replace all of it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	ChatWriteBindingError,
	SETTLED_HISTORY_LIMIT,
	createChatWriteController,
	leafOf,
	parseChatWriteEnvelope,
	userChildrenOf,
} from "../src/chat-write.ts";
import type { ChatWriteResult } from "../src/chat-write.ts";
import { PROTOCOL } from "../src/contracts.ts";

const REGISTRATION = { registrationId: "reg-1", bridgeEpoch: 5 };

const REQUEST = {
	requestId: "req-1",
	expectedLeafId: "leaf-1",
	expectedRuntimeGeneration: 3,
	text: "hello from the phone",
};

function envelope(overrides: Record<string, unknown> = {}) {
	return {
		kind: "chat_write",
		protocol: PROTOCOL.bridge,
		bridgeEpoch: REGISTRATION.bridgeEpoch,
		registrationId: REGISTRATION.registrationId,
		...REQUEST,
		...overrides,
	};
}

function userEntry(id: string, parentId: string, text = "anything") {
	return {
		id,
		type: "message",
		parentId,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistantEntry(id: string, parentId: string) {
	return {
		id,
		type: "message",
		parentId,
		message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
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
			getEntries: () => entries as never[],
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
		/** The normal success path: our message_start, then its persisted entry. */
		land: (entryId: string) => {
			controller.observeMessageStart({ role: "user" }, ctx);
			entries = [...(entries as unknown[]), userEntry(entryId, "leaf-1")];
			controller.resolve(ctx);
		},
	};
}

test("an envelope is bound to the live registration, not just shape-checked", () => {
	assert.deepEqual(parseChatWriteEnvelope(envelope(), REGISTRATION), REQUEST);

	// These two fields exist precisely to tie a request to one target; an
	// earlier version validated and then discarded them.
	assert.throws(
		() => parseChatWriteEnvelope(envelope({ registrationId: "other" }), REGISTRATION),
		(error: unknown) =>
			error instanceof ChatWriteBindingError &&
			error.reason === "binding_refused:registration" &&
			error.requestId === "req-1",
	);
	assert.throws(
		() => parseChatWriteEnvelope(envelope({ bridgeEpoch: 6 }), REGISTRATION),
		(error: unknown) =>
			error instanceof ChatWriteBindingError && error.reason === "binding_refused:epoch",
	);
	assert.throws(
		() => parseChatWriteEnvelope(envelope({ protocol: 2 }), REGISTRATION),
		(error: unknown) =>
			error instanceof ChatWriteBindingError && error.reason === "binding_refused:protocol",
	);
	assert.throws(() => parseChatWriteEnvelope(envelope({ extra: true }), REGISTRATION), /unexpected key/);
	assert.throws(() => parseChatWriteEnvelope(envelope({ text: 42 }), REGISTRATION), /expected string/);
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

test("a leaf that already has a user child refuses, because a claim could not be told apart", () => {
	const h = harness({ entries: [userEntry("someone-else", "leaf-1")] });
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.results, [
		{
			requestId: "req-1",
			state: "rejected",
			reason: "binding_refused:leaf_already_has_user_child",
		},
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

	h.land("entry-9");
	assert.deepEqual(h.results, [{ requestId: "req-1", state: "accepted", entryId: "entry-9" }]);

	// Settled: a later resolve must not emit a second result for one request.
	h.controller.resolve(h.ctx);
	assert.equal(h.results.length, 1);
	assert.equal(h.controller.pendingRequestId, null);
});

test("identical text at the expected parent is NOT enough to be accepted", () => {
	// The regression this rule exists for. The desktop user types the same text
	// at the same parent inside the window; correlation must not claim it.
	const h = harness();
	h.controller.request(REQUEST, h.ctx);

	// Their entry lands first, with byte-identical text, and the leaf moves on.
	h.setEntries([userEntry("theirs", "leaf-1", REQUEST.text)]);
	h.setLeaf("theirs");
	h.controller.resolve(h.ctx);

	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "unknown", reason: "leaf_moved" },
	]);
	assert.notEqual(h.results[0].state, "accepted");
	assert.equal(h.results[0].entryId, undefined);
});

test("two user entries at one parent are ambiguous, never accepted", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.controller.observeMessageStart({ role: "user" }, h.ctx);
	// A fork: ours and theirs both hang off the expected leaf. Which is which
	// cannot be decided without comparing text.
	h.setEntries([userEntry("ours", "leaf-1", REQUEST.text), userEntry("theirs", "leaf-1", "different")]);
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, [
		{ requestId: "req-1", state: "unknown", reason: "ambiguous_parent" },
	]);
});

test("a message_start seen after the leaf moved is unknown, not observed", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.setLeaf("leaf-2");
	h.controller.observeMessageStart({ role: "user" }, h.ctx);
	assert.deepEqual(h.results, [{ requestId: "req-1", state: "unknown", reason: "leaf_moved" }]);
});

test("an entry at the expected parent without our observation is not claimed", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	// An entry appears but we never saw a user message_start, so it is not
	// demonstrably ours; stay pending rather than claim it.
	h.setEntries([userEntry("unseen", "leaf-1")]);
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, []);
	assert.equal(h.controller.pendingRequestId, "req-1");
});

test("only assistant/other roles at the parent are ignored by the claim walk", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.controller.observeMessageStart({ role: "user" }, h.ctx);
	h.setEntries([assistantEntry("a1", "leaf-1"), userEntry("ours", "leaf-1")]);
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, [{ requestId: "req-1", state: "accepted", entryId: "ours" }]);
});

test("only the first user message_start counts as our observation", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.controller.observeMessageStart({ role: "user" }, h.ctx);
	// A second user message starting belongs to a different message; it must
	// not re-arm the claim after the leaf has moved.
	h.setLeaf("leaf-2");
	h.controller.observeMessageStart({ role: "user" }, h.ctx);
	assert.deepEqual(h.results, []);
	assert.equal(h.controller.pendingRequestId, "req-1");
});

test("a non-user message_start is never an observation", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.controller.observeMessageStart({ role: "assistant" }, h.ctx);
	h.setEntries([userEntry("unseen", "leaf-1")]);
	h.controller.resolve(h.ctx);
	assert.deepEqual(h.results, []);
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

test("a re-sent requestId replays the stored result and never sends again", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.expire();
	assert.deepEqual(h.sent, [REQUEST.text]);

	// The bridge retries after the unknown. The extension is the only party
	// that can see the duplicate arrive, so it replays rather than re-sending.
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.sent, [REQUEST.text], "a duplicate requestId must not send again");
	assert.equal(h.results.length, 2);
	assert.deepEqual(h.results[1], h.results[0]);
});

test("replay wins even over a refusal, so consent revocation cannot mask a prior send", () => {
	const h = harness();
	h.controller.request(REQUEST, h.ctx);
	h.land("entry-9");
	assert.deepEqual(h.results[0], { requestId: "req-1", state: "accepted", entryId: "entry-9" });

	// Same id again: the honest answer is still "accepted", not a new refusal.
	h.controller.request(REQUEST, h.ctx);
	assert.deepEqual(h.results[1], h.results[0]);
	assert.deepEqual(h.sent, [REQUEST.text]);
});

test("settled history is bounded", () => {
	const h = harness();
	for (let index = 0; index < SETTLED_HISTORY_LIMIT + 5; index += 1) {
		h.controller.request({ ...REQUEST, requestId: `r${index}` }, h.ctx);
		h.expire();
	}
	// The oldest are evicted; the newest are still replayable.
	assert.equal(h.controller.settledResult("r0"), undefined);
	assert.ok(h.controller.settledResult(`r${SETTLED_HISTORY_LIMIT + 4}`));
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

test("leafOf prefers getLeafId and falls back to the last branch entry", () => {
	assert.equal(leafOf({ buildContextEntries: () => [], getLeafId: () => "leaf-7" }), "leaf-7");
	assert.equal(
		leafOf({
			buildContextEntries: () => [],
			getBranch: () => [{ id: "a" }, { id: "b" }],
		}),
		"b",
	);
	assert.equal(leafOf({ buildContextEntries: () => [] }), null);
});

test("userChildrenOf walks all entries, so a sibling on another branch is visible", () => {
	// buildContextEntries() only returns the active branch, so a competing
	// message on the forked sibling branch would be invisible to it — exactly
	// the case the ambiguity check must catch. getEntries() is the source.
	const all = [
		userEntry("ours", "leaf-1"),
		userEntry("theirs", "leaf-1"),
		userEntry("elsewhere", "leaf-9"),
		assistantEntry("a1", "leaf-1"),
	];
	const sm = {
		buildContextEntries: () => [all[0]] as never[],
		getEntries: () => all as never[],
	};
	assert.deepEqual(userChildrenOf(sm, "leaf-1"), ["ours", "theirs"]);
	assert.deepEqual(userChildrenOf(sm, "leaf-9"), ["elsewhere"]);
	assert.deepEqual(userChildrenOf(sm, "nothing"), []);
});

test("no source line in chat-write.ts compares message text", async () => {
	// A structural guard, because this is the rejected mechanism and a future
	// edit could reintroduce it quietly. The module must not read message
	// content at all for correlation purposes.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/chat-write.ts", import.meta.url), "utf8");
	const body = source.slice(source.indexOf("import "));
	assert.equal(body.includes("extractText"), false, "text extraction must not be imported");
	assert.equal(/\.text\s*===/.test(body), false, "no text equality comparison");
	assert.equal(/request\.text\s*===|===\s*request\.text/.test(body), false, "no send-text compare");
});
