/**
 * Read-projection tests.
 *
 * The reconciliation cases are the ones that matter: they pin that identity is
 * resolved by *position and role*, never by comparing text. A `message_end`
 * handler in another extension may legitimately rewrite a finalized message
 * before Pi persists it, so text matching would silently mis-identify the
 * entry exactly when it matters most.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS } from "../src/contracts.ts";
import {
	CLIP_MARKER,
	boundEntries,
	createPiProjection,
	extractText,
	extractToolCalls,
	projectConversation,
	projectEntry,
} from "../src/projection.ts";

const BINDING = {
	hostId: "h",
	herdrServerInstance: "s",
	namedSession: "n",
	workspaceId: "w",
	tabId: "t",
	paneId: "p",
	terminalId: "term",
	herdrPaneRevision: 0,
	piRuntimeGeneration: 1,
	piSessionId: "sess",
	piLeafId: "leaf-0",
};

/** A session double whose entries the test controls exactly. */
function sessionManager(entries: unknown[], leafId: string | null = "leaf-0") {
	return {
		buildContextEntries: () => entries as never[],
		getLeafId: () => leafId,
		getSessionId: () => "sess",
	};
}

function message(id: string, role: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		type: "message",
		parentId: null,
		message: { role, content: [{ type: "text", text }], ...extra },
	};
}

function projection(overrides: Record<string, unknown> = {}) {
	return createPiProjection({
		binding: BINDING,
		bridgeEpoch: 1,
		registrationId: "reg-1",
		...overrides,
	});
}

test("only text blocks contribute to projected text", () => {
	assert.equal(extractText("plain"), "plain");
	assert.equal(
		extractText([
			{ type: "text", text: "a" },
			{ type: "thinking", text: "hidden" },
			{ type: "toolCall", id: "c1", name: "bash" },
			{ type: "text", text: "b" },
		]),
		"ab",
	);
	// Never inlined, never interpreted.
	assert.equal(extractText([{ type: "image", source: { data: "AAAA" } }]), "");
	assert.equal(extractText(undefined), "");
});

test("an entry Pi persists but the contract cannot carry is excluded, not faked", () => {
	assert.equal(projectEntry({ id: "e1", type: "model_change" }), null);
	assert.equal(projectEntry({ id: "e2", type: "message", message: { role: "system" } }), null);
	assert.equal(projectEntry({ type: "message", message: { role: "user" } }), null);
	assert.equal(projectEntry(null), null);
});

test("compaction and branch_summary project as marker entries carrying the summary", () => {
	assert.deepEqual(projectEntry({ id: "c1", type: "compaction", summary: "gone" }), {
		entryId: "c1",
		role: "compaction",
		provisional: false,
		text: "gone",
	});
	assert.deepEqual(projectEntry({ id: "b1", type: "branch_summary", summary: "branch" }), {
		entryId: "b1",
		role: "branch_summary",
		provisional: false,
		text: "branch",
	});
	// An unrecognised summary shape yields empty text rather than leaking an
	// object into the transcript.
	assert.equal(projectEntry({ id: "c2", type: "compaction", summary: { a: 1 } })?.text, "");
});

test("a compaction marker forces truncated, because the summarized entries are gone", () => {
	const { entries, truncated } = projectConversation(
		sessionManager([
			{ id: "c1", type: "compaction", summary: "earlier history" },
			message("m1", "user", "after"),
		]),
	);
	assert.deepEqual(
		entries.map((entry) => entry.role),
		["compaction", "user"],
	);
	// The marker says history was summarized; truncated says this view is not
	// the complete transcript. Both are needed: the marker alone would let a
	// consumer believe it holds everything after the summary point.
	assert.equal(truncated, true);
});

test("tool association rides on toolResult and on a single-call assistant entry", () => {
	assert.equal(
		projectEntry(message("t1", "toolResult", "out", { toolCallId: "call-1" }))?.toolCallId,
		"call-1",
	);
	const single = projectEntry({
		id: "a1",
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
	});
	assert.equal(single?.toolCallId, "call-1");
	// With several calls a single id would pick an arbitrary winner, so none is
	// carried; the association rides on the per-call tool events instead.
	const manyContent = [
		{ type: "toolCall", id: "call-1", name: "bash" },
		{ type: "toolCall", id: "call-2", name: "read" },
	];
	const many = projectEntry({
		id: "a2",
		type: "message",
		message: { role: "assistant", content: manyContent },
	});
	assert.equal(many?.toolCallId, undefined);
	// Both calls are still recoverable, just not through the entry: they ride on
	// the per-call tool events instead.
	assert.deepEqual(extractToolCalls(manyContent), [
		{ toolCallId: "call-1", toolName: "bash" },
		{ toolCallId: "call-2", toolName: "read" },
	]);
});

test("bounding keeps the newest entries and reports the loss", () => {
	const entries = Array.from({ length: 5 }, (_, index) => ({
		entryId: `e${index}`,
		role: "user",
		provisional: false,
		text: `t${index}`,
	}));
	const byCount = boundEntries(entries, { events: 2 });
	assert.deepEqual(
		byCount.entries.map((entry) => entry.entryId),
		["e3", "e4"],
	);
	assert.equal(byCount.truncated, true);
	const byBytes = boundEntries(entries, { totalBytes: 80 });
	assert.equal(byBytes.truncated, true);
	assert.ok(byBytes.entries.length < entries.length);
	assert.equal(byBytes.entries.at(-1)?.entryId, "e4");
	// Within bounds nothing is dropped and nothing is claimed to be.
	assert.deepEqual(boundEntries(entries), { entries, truncated: false });
});

test("a snapshot samples the live leaf rather than the one frozen at registration", () => {
	const snapshot = projection().snapshot({
		sessionManager: sessionManager([], "leaf-moved"),
		lifecycle: "live",
	});
	assert.equal((snapshot.binding as Record<string, unknown>).piLeafId, "leaf-moved");
	assert.equal(snapshot.truncated, false);
	assert.deepEqual(snapshot.capabilities, ["history", "streaming"]);
	// Default is the baseline: chat write absent.
	assert.deepEqual(snapshot.disabled, {
		chatWrite: true,
		promptIdle: true,
		abortExactTarget: true,
	});
});

test("disabled.chatWrite flips with the consent decision, and nothing else does", () => {
	// The regression: this was hardcoded to the frozen baseline, so a fully
	// consented session still advertised chatWrite as absent. A bridge that
	// fail-closes on the authoritative snapshot would then never send a
	// chat_write, making the approved feature unreachable end to end.
	const consented = projection().snapshot({
		sessionManager: sessionManager([]),
		lifecycle: "live",
		chatWriteEnabled: true,
	});
	assert.deepEqual(consented.disabled, {
		chatWrite: false,
		promptIdle: true,
		abortExactTarget: true,
	});

	const refused = projection().snapshot({
		sessionManager: sessionManager([]),
		lifecycle: "live",
		chatWriteEnabled: false,
	});
	assert.equal((refused.disabled as Record<string, boolean>).chatWrite, true);

	// capabilities[] stays the read-only baseline either way: chat write is
	// advertised through `disabled`, not by growing the capability list.
	assert.deepEqual(consented.capabilities, ["history", "streaming"]);
	assert.deepEqual(refused.capabilities, ["history", "streaming"]);
});

test("reconciliation matches by role and position, never by text", () => {
	const view = projection();
	view.messageStart({ role: "assistant" });
	view.messageUpdate({ delta: "streamed" });
	view.messageEnd({ role: "assistant", text: "streamed" });

	// The persisted text deliberately differs from what was streamed: another
	// extension's message_end handler rewrote it before Pi persisted it.
	const resolved = view.reconcile(sessionManager([message("persisted-1", "assistant", "rewritten")]));
	assert.deepEqual(resolved, [
		{
			provisionalId: "provisional:1",
			entryId: "persisted-1",
			role: "assistant",
			text: "rewritten",
			rewritten: true,
		},
	]);
	// Consumed, so a later settle cannot resolve it twice.
	assert.deepEqual(view.provisionalEntries, []);
});

test("reconciliation skips trailing tool results to find the assistant entry", () => {
	const view = projection();
	view.messageStart({ role: "assistant" });
	view.messageEnd({ role: "assistant", text: "called a tool" });

	// A turn ends only after its assistant message *and* every tool result have
	// been appended, so the persisted tail is not index-aligned with the stream.
	const resolved = view.reconcile(
		sessionManager([
			message("a1", "assistant", "called a tool", {
				content: [{ type: "text", text: "called a tool" }],
			}),
			message("t1", "toolResult", "tool output", { toolCallId: "call-1" }),
		]),
	);
	assert.equal(resolved.length, 1);
	assert.equal(resolved[0].entryId, "a1");
	assert.equal(resolved[0].rewritten, false);
});

test("an unresolvable provisional id is left pending rather than mis-matched", () => {
	const view = projection();
	view.messageStart({ role: "assistant" });
	view.messageEnd({ role: "assistant", text: "streamed" });
	// Nothing of that role is persisted yet.
	assert.deepEqual(view.reconcile(sessionManager([message("u1", "user", "hi")])), []);
	assert.equal(view.provisionalEntries.length, 1);
});

test("message_reconciled carries identity only, and is absent when nothing resolved", () => {
	const view = projection();
	assert.equal(view.reconciledEvent([]), null);
	const event = view.reconciledEvent([{ provisionalId: "provisional:1", entryId: "e1" }]);
	assert.equal(event?.type, "message_reconciled");
	// No text: the persisted text is authoritative and arrives in the snapshot.
	assert.deepEqual(event?.payload, {
		reconciled: [{ provisionalId: "provisional:1", entryId: "e1" }],
	});
});

test("resetProvisional drops stream identity that belonged to a dead connection", () => {
	const view = projection();
	view.messageStart({ role: "assistant" });
	view.resetProvisional();
	assert.deepEqual(view.provisionalEntries, []);
	// A delta with no open message is a bug in the caller, not something to
	// paper over with an invented provisional id.
	assert.throws(() => view.messageUpdate({ delta: "x" }), /without an open provisional/);
});

test("every emitted event advances one shared sequence", () => {
	const view = projection();
	assert.equal(view.eventSequence, 0);
	view.messageStart({ role: "assistant" });
	view.messageUpdate({ delta: "a" });
	const end = view.messageEnd({ role: "assistant", text: "a" });
	assert.equal(view.eventSequence, 3);
	assert.equal(end.eventSequence, 3);
	const tool = view.toolEvent("tool_execution_end", {
		toolCallId: "c1",
		toolName: "bash",
		isError: true,
	});
	assert.equal(tool.eventSequence, 4);
	assert.deepEqual(tool.payload, { toolCallId: "c1", toolName: "bash", isError: true });
});

test("the default bounds come from the shared LIMITS table", () => {
	const many = Array.from({ length: LIMITS.events + 5 }, (_, index) =>
		message(`m${index}`, "user", "x"),
	);
	const { entries, truncated } = projectConversation(sessionManager(many));
	assert.equal(entries.length, LIMITS.events);
	assert.equal(truncated, true);
});

test("a snapshot line always fits the frame bound, so the bridge never refuses it", () => {
	// The regression: entries are bounded by totalBytes (4 MiB) but a snapshot
	// travels as one line bounded by frameBytes (1 MiB). One large tool result
	// made every snapshot unsendable, the bridge closed with frame_too_large,
	// and the reconnect loop spent a capability per attempt republishing it.
	const big = "x".repeat(2 * 1024 * 1024);
	const snapshot = projection().snapshot({
		sessionManager: sessionManager([
			message("m1", "user", "first"),
			message("m2", "toolResult", big, { toolCallId: "call-1" }),
		]),
		lifecycle: "live",
	});
	const line = `${JSON.stringify(snapshot)}\n`;
	assert.ok(
		Buffer.byteLength(line, "utf8") <= LIMITS.frameBytes,
		`snapshot line is ${Buffer.byteLength(line, "utf8")} bytes, over the ${LIMITS.frameBytes} bound`,
	);
	assert.equal(snapshot.truncated, true);
});

test("a single oversize entry is clipped with a visible marker rather than dropped silently", () => {
	const snapshot = projection().snapshot({
		sessionManager: sessionManager([message("only", "assistant", "y".repeat(3 * 1024 * 1024))]),
		lifecycle: "live",
	});
	const entries = snapshot.entries as Array<{ entryId: string; text: string }>;
	assert.equal(entries.length, 1);
	assert.equal(entries[0].entryId, "only");
	assert.ok(entries[0].text.endsWith(CLIP_MARKER), "clipped text must say so");
	assert.equal(snapshot.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= LIMITS.frameBytes);
});

test("fitting keeps the newest entries, matching boundEntries", () => {
	const snapshot = projection().snapshot({
		sessionManager: sessionManager([
			message("old", "user", "z".repeat(600 * 1024)),
			message("new", "user", "kept"),
		]),
		lifecycle: "live",
	});
	const entries = snapshot.entries as Array<{ entryId: string }>;
	assert.equal(entries.at(-1)?.entryId, "new");
	assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= LIMITS.frameBytes);
});

test("a snapshot that already fits is left completely alone", () => {
	const snapshot = projection().snapshot({
		sessionManager: sessionManager([message("m1", "user", "small")]),
		lifecycle: "live",
	});
	assert.equal(snapshot.truncated, false);
	assert.deepEqual((snapshot.entries as Array<{ text: string }>)[0].text, "small");
});

test("multi-byte text is clipped by measured bytes, not by character count", () => {
	// Each emoji is four UTF-8 bytes and JSON-escapes to twelve, so a
	// character-count subtraction would under-cut and still overflow.
	const snapshot = projection().snapshot({
		sessionManager: sessionManager([message("only", "assistant", "\u{1f600}".repeat(400_000))]),
		lifecycle: "live",
	});
	assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= LIMITS.frameBytes);
	assert.equal(snapshot.truncated, true);
});
