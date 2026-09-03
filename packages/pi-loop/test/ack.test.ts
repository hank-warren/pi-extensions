import assert from "node:assert/strict";
import { test } from "node:test";
import { ACK_REMAINDER_LIMIT, isLoopOkAck, parseLoopOkAck } from "../src/ack.js";
import { compactAckMessage } from "../src/render.js";

test("an acknowledgement is the token, optionally with a short note", () => {
	assert.deepEqual(parseLoopOkAck("LOOP_OK"), { remainder: "" });
	assert.deepEqual(parseLoopOkAck("  LOOP_OK\n"), { remainder: "" });
	assert.deepEqual(parseLoopOkAck("LOOP_OK — queue still empty"), {
		remainder: "queue still empty",
	});
	// Trailing form: models like to explain first.
	assert.deepEqual(parseLoopOkAck("Nothing to do; queue empty. LOOP_OK"), {
		remainder: "Nothing to do; queue empty",
	});
});

test("an essay that mentions the token is not an acknowledgement", () => {
	// The budget is fixed, not configurable: an acknowledgement with a
	// paragraph attached is just a turn, and a knob would let the protocol
	// decay into prose.
	const essay = `LOOP_OK ${"x".repeat(ACK_REMAINDER_LIMIT + 1)}`;
	assert.equal(parseLoopOkAck(essay), undefined);
	assert.equal(parseLoopOkAck("I considered replying LOOP_OK but there is work to do here"), undefined);
	assert.equal(parseLoopOkAck("no news"), undefined);
	assert.equal(parseLoopOkAck(""), undefined);
});

test("the ack chip is display-only and only fires on real acknowledgements", () => {
	assert.equal(compactAckMessage("LOOP_OK"), "*✓ loop ok*");
	assert.equal(compactAckMessage("LOOP_OK · nothing in the queue"), "*✓ loop ok · nothing in the queue*");
	assert.equal(compactAckMessage("Here is a real answer."), undefined);
});

test("isLoopOkAck reads the run's final visible assistant text", () => {
	const ack = { role: "assistant", content: [{ type: "text", text: "LOOP_OK" }] };
	const work = { role: "assistant", content: [{ type: "text", text: "I fixed the failing test." }] };
	const toolOnly = { role: "assistant", content: [{ type: "toolCall", name: "bash" }] };
	assert.equal(isLoopOkAck([ack]), true);
	assert.equal(isLoopOkAck([work]), false);
	assert.equal(isLoopOkAck([]), false);
	// A tool-only message has no visible text; the ack before it still counts,
	// which is the case where the model checked and then acknowledged.
	assert.equal(isLoopOkAck([ack, toolOnly]), true);
	assert.equal(isLoopOkAck([ack, work]), false, "the newest visible answer decides");
});
