/**
 * Wire-level contract tests: the handshake MAC, the framing rules, and the
 * shape validators.
 *
 * The MAC vectors are golden strings. They are not "whatever the code
 * produces": the muxr bridge computes the same MAC from its own copy of the
 * transcript rule, so a change here that both sides do not make together is a
 * silent authentication break. Pinning the literal digest is what makes that
 * change fail a test instead of failing in production.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CHAT_WRITE_SHAPE,
	CONVERSATION_ENTRY_SHAPE,
	DISABLED,
	ENVELOPE_SHAPES,
	EVENT_TYPES,
	LIMITS,
	MESSAGE_KINDS,
	MUXR_EVENT_TYPES,
	PI_EVENT_TYPES,
	PROTOCOL,
	ShapeError,
	assertEnvelope,
	assertShape,
} from "../src/contracts.ts";
import { TRANSCRIPT_PREFIX, computeMac, macEquals, readCapability } from "../src/wire.ts";

/** A fixed, obviously-fake capability so the vectors below are reproducible. */
const CAPABILITY = "a".repeat(64);
const TRANSCRIPT = {
	role: "bridge",
	protocol: 1,
	bridgeEpoch: 7,
	registrationId: "reg-1",
	helloNonce: "b".repeat(64),
	challengeNonce: "c".repeat(64),
};

test("the MAC transcript is the documented pipe-joined string", () => {
	const expected = [
		TRANSCRIPT_PREFIX,
		"bridge",
		"1",
		"7",
		"reg-1",
		"b".repeat(64),
		"c".repeat(64),
	].join("|");
	assert.equal(
		expected,
		"muxr-bridge-v1|bridge|1|7|reg-1|" + "b".repeat(64) + "|" + "c".repeat(64),
	);
	// Keyed by the raw bytes of the hex capability, not the hex text. Getting
	// this wrong still produces a stable MAC on both sides of a single
	// implementation, so only an independent recomputation catches it.
	const independent = createHmac("sha256", Buffer.from(CAPABILITY, "hex"))
		.update(expected, "utf8")
		.digest("hex");
	assert.equal(computeMac(CAPABILITY, TRANSCRIPT), independent);
});

/**
 * Golden MAC vectors, computed by the **muxr bridge's** own `handshakeMac`.
 *
 * Not self-generated: an earlier version pinned whatever this package produced,
 * which proves only that it is self-consistent. These came from the other side
 * of the handshake, so a one-sided change to the transcript, the delimiter, or
 * the key derivation fails here.
 *
 * Source: `proof/fixture/bridge.mjs` in hank-warren/muxr (`handshakeTranscript`
 * / `handshakeMac`). Regenerate with:
 *
 *   node --input-type=module -e '
 *     import { handshakeMac } from "<muxr>/proof/fixture/bridge.mjs";
 *     const parts = { protocol: 1, bridgeEpoch: 7, registrationId: "reg-1",
 *       helloNonce: "b".repeat(64), challengeNonce: "c".repeat(64) };
 *     console.log(handshakeMac("a".repeat(64), { ...parts, role: "bridge" }));
 *     console.log(handshakeMac("a".repeat(64), { ...parts, role: "extension" }));'
 */
const GOLDEN = Object.freeze({
	bridge: "b4c1489f8e082dce1c90513ba9d6e11edf0d8b2bc3a5765d3a1deacc2ac788de",
	extension: "a9b6b2ff9b9df838d5b3b0571b71553bbeb44ebf79d9364db3af6c614aa83ede",
});

test("the bridge and extension MACs match muxr's own vectors, and differ by role", () => {
	const bridgeMac = computeMac(CAPABILITY, TRANSCRIPT);
	const extensionMac = computeMac(CAPABILITY, { ...TRANSCRIPT, role: "extension" });
	assert.notEqual(bridgeMac, extensionMac);
	assert.equal(bridgeMac, GOLDEN.bridge);
	assert.equal(extensionMac, GOLDEN.extension);
});

test("the golden vectors still agree with the live muxr bridge, when one is present", async (t) => {
	// Opportunistic: the pinned vectors above keep this suite hermetic, and this
	// re-derives them from the real bridge whenever a muxr checkout is on the
	// machine, so the pin cannot quietly drift from its source.
	const bridgePath = "/home/hank/repos/muxr/proof/fixture/bridge.mjs";
	const { existsSync } = await import("node:fs");
	if (!existsSync(bridgePath)) {
		t.skip(`no muxr checkout at ${bridgePath}`);
		return;
	}
	const bridge = (await import(bridgePath)) as {
		handshakeMac(capability: string, parts: Record<string, unknown>): string;
	};
	const parts = {
		protocol: TRANSCRIPT.protocol,
		bridgeEpoch: TRANSCRIPT.bridgeEpoch,
		registrationId: TRANSCRIPT.registrationId,
		helloNonce: TRANSCRIPT.helloNonce,
		challengeNonce: TRANSCRIPT.challengeNonce,
	};
	assert.equal(bridge.handshakeMac(CAPABILITY, { ...parts, role: "bridge" }), GOLDEN.bridge);
	assert.equal(bridge.handshakeMac(CAPABILITY, { ...parts, role: "extension" }), GOLDEN.extension);
});

test("every transcript field changes the MAC", () => {
	const base = computeMac(CAPABILITY, TRANSCRIPT);
	const variants = [
		{ ...TRANSCRIPT, protocol: 2 },
		{ ...TRANSCRIPT, bridgeEpoch: 8 },
		{ ...TRANSCRIPT, registrationId: "reg-2" },
		{ ...TRANSCRIPT, helloNonce: "d".repeat(64) },
		{ ...TRANSCRIPT, challengeNonce: "e".repeat(64) },
	];
	for (const variant of variants) {
		assert.notEqual(computeMac(CAPABILITY, variant), base);
	}
});

test("a malformed capability is refused before it is decoded", () => {
	// Buffer.from(value, "hex") truncates silently at the first non-hex
	// character, so an unvalidated short value would key the MAC with fewer
	// bytes than the caller believes.
	for (const bad of ["", "ab", "A".repeat(64), `${"a".repeat(63)}z`, "a".repeat(65)]) {
		assert.throws(() => computeMac(bad, TRANSCRIPT), /64 lowercase hex/);
	}
});

test("macEquals is total: a malformed peer value is false, never a throw", () => {
	const mac = computeMac(CAPABILITY, TRANSCRIPT);
	assert.equal(macEquals(mac, mac), true);
	for (const bad of [undefined, null, 42, {}, [], "", "zz", `${mac}0`, mac.slice(0, -1)]) {
		assert.equal(macEquals(mac, bad), false);
	}
});

test("readCapability accepts only a 256-bit lowercase hex file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-muxr-cap-"));
	test.after(() => rmSync(dir, { recursive: true, force: true }));
	const write = (body: string): string => {
		const path = join(dir, "cap");
		writeFileSync(path, body);
		return path;
	};
	// Trailing whitespace is tolerated: a shell heredoc writes one.
	assert.equal(readCapability(write(`${CAPABILITY}\n`)), CAPABILITY);
	assert.throws(() => readCapability(write("nope")), /256-bit hex/);
	assert.throws(() => readCapability(write("A".repeat(64))), /256-bit hex/);
});

test("assertShape rejects missing keys, extra keys, and wrong types", () => {
	const shape = { a: { type: "string" as const }, b: { type: "integer" as const, min: 0 } };
	assert.deepEqual(assertShape({ a: "x", b: 1 }, shape), { a: "x", b: 1 });
	assert.throws(() => assertShape({ b: 1 }, shape), ShapeError);
	// Extra keys are rejected so a peer cannot smuggle fields past a reader
	// that only looks at the ones it knows about.
	assert.throws(() => assertShape({ a: "x", b: 1, c: true }, shape), /unexpected key/);
	assert.throws(() => assertShape({ a: 1, b: 1 }, shape), /expected string/);
	assert.throws(() => assertShape({ a: "x", b: -1 }, shape), /below minimum/);
	assert.throws(() => assertShape({ a: "x", b: 1.5 }, shape), /safe integer/);
	assert.throws(() => assertShape(null, shape), /plain object/);
	assert.throws(() => assertShape([], shape), /plain object/);
});

test("assertEnvelope validates nested shapes, so a binding cannot be smuggled", () => {
	const snapshot = {
		kind: "snapshot",
		protocol: PROTOCOL.bridge,
		bridgeEpoch: 1,
		registrationId: "reg-1",
		bindingRevision: 0,
		eventSequence: 0,
		terminalControlGeneration: 0,
		binding: {
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
			piLeafId: "leaf",
		},
		capabilities: ["history", "streaming"],
		disabled: { ...DISABLED },
		lifecycle: "live",
		entries: [],
		truncated: false,
	};
	assert.doesNotThrow(() => assertEnvelope(snapshot));
	assert.throws(
		() => assertEnvelope({ ...snapshot, binding: { smuggled: "x" } }),
		/binding\.hostId: missing required key/,
	);
	assert.throws(() => assertEnvelope({ ...snapshot, kind: "nope" }), /unknown envelope kind/);
	assert.throws(() => assertEnvelope({ ...snapshot, lifecycle: "wat" }), /value not permitted/);
});

test("a conversation entry may carry a marker role and an optional toolCallId", () => {
	assert.doesNotThrow(() =>
		assertShape(
			{ entryId: "e1", role: "compaction", provisional: false, text: "summary" },
			CONVERSATION_ENTRY_SHAPE,
		),
	);
	assert.doesNotThrow(() =>
		assertShape(
			{ entryId: "e2", role: "toolResult", provisional: false, text: "", toolCallId: "call-1" },
			CONVERSATION_ENTRY_SHAPE,
		),
	);
	assert.throws(
		() => assertShape({ entryId: "e3", role: "system", provisional: false, text: "" }, CONVERSATION_ENTRY_SHAPE),
		/value not permitted/,
	);
});

test("a chat_write envelope must carry both expectation fields", () => {
	const request = {
		kind: "chat_write",
		protocol: PROTOCOL.bridge,
		bridgeEpoch: 1,
		registrationId: "reg-1",
		requestId: "req-1",
		expectedLeafId: "leaf-1",
		expectedRuntimeGeneration: 1,
		text: "hello",
	};
	assert.doesNotThrow(() => assertShape(request, CHAT_WRITE_SHAPE, "chat_write"));
	for (const key of ["expectedLeafId", "expectedRuntimeGeneration", "requestId"]) {
		const { [key]: _dropped, ...rest } = request as Record<string, unknown>;
		assert.throws(() => assertShape(rest, CHAT_WRITE_SHAPE, "chat_write"), /missing required key/);
	}
});

test("every declared message kind has an envelope shape, and vice versa", () => {
	// The muxr integration lane found exactly this class of bug: a kind that was
	// declared but had no shape could never be dispatched, and the connection
	// died on the first envelope carrying it. An exact-set comparison is what
	// turns that into a test failure instead of a production hang.
	assert.deepEqual([...MESSAGE_KINDS].sort(), Object.keys(ENVELOPE_SHAPES).sort());
});

test("muxr-originated events are not claimed to be Pi events", () => {
	// `message_reconciled` and `chat_write_result` are ours. Listing them in
	// PI_EVENT_TYPES would make the stream lie about where a fact came from.
	for (const type of MUXR_EVENT_TYPES) {
		assert.equal(PI_EVENT_TYPES.includes(type as never), false, type);
		assert.equal(EVENT_TYPES.includes(type), true, type);
	}
});

test("the frame bound is 1 MiB and the buffer bound is 4 MiB", () => {
	// Pinned because the bridge enforces the same two numbers from its own
	// copy; drifting one side turns a valid frame into a dropped connection.
	assert.equal(LIMITS.frameBytes, 1024 * 1024);
	assert.equal(LIMITS.totalBytes, 4 * 1024 * 1024);
	assert.equal(LIMITS.events, 2048);
});

test("a delimiter inside a transcript field is refused, as the bridge refuses it", () => {
	// Without this, two different field tuples could join to one transcript and
	// a MAC could be replayed across them. Unreachable without the capability,
	// but the bridge enforces it and a faithful port does too.
	assert.throws(
		() => computeMac(CAPABILITY, { ...TRANSCRIPT, registrationId: "reg|1" }),
		/transcript field contains \|/,
	);
	assert.throws(
		() => computeMac(CAPABILITY, { ...TRANSCRIPT, role: "bridge|extension" }),
		/transcript field contains \|/,
	);
});
