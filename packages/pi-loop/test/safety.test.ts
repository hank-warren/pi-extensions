import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyInterruption } from "../src/errors.js";
import {
	calledTool,
	fingerprintVisibleAssistantOutput,
	hasAssistantToolCall,
	nextNoProgressState,
	normalizeVisibleAssistantOutput,
} from "../src/safety.js";

function text(value: string) {
	return { role: "assistant", content: [{ type: "text", text: value }] };
}

function toolCall(name = "bash") {
	return { role: "assistant", content: [{ type: "toolCall", name }] };
}

function errored(errorMessage: string) {
	return { role: "assistant", content: [], stopReason: "error", errorMessage };
}

test("the fingerprint ignores the ways a model rewrites the same answer", () => {
	const a = fingerprintVisibleAssistantOutput([text("I will now check   the queue.")]);
	const b = fingerprintVisibleAssistantOutput([text("I WILL NOW CHECK THE QUEUE.\n")]);
	assert.equal(a, b, "case and whitespace are not new information");
	assert.notEqual(a, fingerprintVisibleAssistantOutput([text("I will check the log.")]));
	// Empty and punctuation-only output are the same non-answer.
	assert.equal(normalizeVisibleAssistantOutput([text("   ")]), "");
	assert.equal(normalizeVisibleAssistantOutput([text("...")]), "");
	// Tool calls contribute nothing: only visible text is the answer.
	assert.equal(normalizeVisibleAssistantOutput([toolCall()]), "");
});

test("repeats count only while nothing is attempted, and any tool resets", () => {
	let state = nextNoProgressState({ toolFreeRepeatCount: 0 }, [text("same")], false);
	assert.equal(state.toolFreeRepeatCount, 1);
	state = nextNoProgressState(state, [text("same")], false);
	assert.equal(state.toolFreeRepeatCount, 2);
	state = nextNoProgressState(state, [text("different")], false);
	assert.equal(state.toolFreeRepeatCount, 1, "a new answer restarts the count");
	state = nextNoProgressState(state, [text("different")], false);
	assert.equal(state.toolFreeRepeatCount, 2);
	state = nextNoProgressState(state, [text("different")], true);
	assert.deepEqual(state, { toolFreeRepeatCount: 0 }, "doing something is progress");
});

test("tool detection sees calls anywhere in the run", () => {
	assert.equal(hasAssistantToolCall([text("hi"), toolCall()]), true);
	assert.equal(hasAssistantToolCall([text("hi")]), false);
	assert.equal(calledTool([text("hi"), toolCall("loop_wait")], "loop_wait"), true);
	assert.equal(calledTool([toolCall("bash")], "loop_wait"), false);
	assert.equal(
		calledTool([{ role: "assistant", content: [{ type: "toolCall", toolName: "loop_wait" }] }], "loop_wait"),
		true,
		"both shapes of tool-call block are recognised",
	);
});

test("interruptions classify into the four answers a loop actually has", () => {
	assert.equal(classifyInterruption([text("done")]), "none");
	assert.equal(classifyInterruption([]), "none");
	assert.equal(
		classifyInterruption([{ role: "assistant", content: [], stopReason: "aborted" }]),
		"aborted",
	);
	// Usage limits win over the 429 that carries them: retrying an exhausted
	// quota just burns the loop's caps against a window that has not reset.
	assert.equal(
		classifyInterruption([errored("429: You have used all your included usage for this month")]),
		"usage-limited",
	);
	assert.equal(classifyInterruption([errored("insufficient_quota")]), "usage-limited");
	assert.equal(classifyInterruption([errored("429 rate limit, try again later")]), "retryable");
	assert.equal(classifyInterruption([errored("503 service unavailable")]), "retryable");
	assert.equal(classifyInterruption([errored("socket hang up")]), "retryable");
	// Overflow is its own answer: the fix is a compaction, not a retry of the
	// same oversized request.
	assert.equal(
		classifyInterruption([errored("context_length_exceeded: input exceeds the context window")]),
		"context-overflow",
	);
	assert.equal(
		classifyInterruption([errored("This model's maximum context length is 200000 tokens")]),
		"context-overflow",
	);
	assert.equal(classifyInterruption([errored("unauthorized: invalid api key")]), "fatal");
	assert.equal(classifyInterruption([errored("something nobody has seen")]), "fatal");
	// Only the newest assistant message decides.
	assert.equal(classifyInterruption([errored("503 service unavailable"), text("recovered")]), "none");
});
