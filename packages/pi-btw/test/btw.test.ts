import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";
import { BTW_REMINDER, blockImages } from "../ask.ts";
import btw from "../index.ts";
import { alignPayload, dropOpenToolTurn, PrefixTracker, type TranscriptMessage } from "../prefix.ts";
import { ENTRY_TYPE, formatStats, LiveWidget, renderEntry } from "../render.ts";

initTheme("dark", false);

const MODEL = { provider: "cpa", id: "claude", api: "anthropic-messages" };
const ZERO_WIDTH = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (lines: string[]) => lines.map((line) => line.replace(ZERO_WIDTH, "").trimEnd());
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const system: TranscriptMessage = { role: "system", content: "", sections: { preamble: "You are pi." }, toolsAdded: [], timestamp: 1 };
const user = (text: string): TranscriptMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 2 });
const reply = (text: string, toolCalls: string[] = []): TranscriptMessage => ({
	role: "assistant",
	content: [{ type: "text", text }, ...toolCalls.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} }))],
	api: "anthropic-messages",
	provider: "cpa",
	model: "claude",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: toolCalls.length ? "toolUse" : "stop",
	timestamp: 3,
});
const toolResult = (id: string): TranscriptMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 4,
});

const USAGE = { input: 120, output: 40, cacheRead: 41_000, cacheWrite: 80, totalTokens: 41_240, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };

type Call = { model: unknown; context: { messages: TranscriptMessage[] }; options: Record<string, any> };

function fakeStream(events: unknown[], result: Record<string, unknown>, gate?: Promise<void>) {
	return {
		async *[Symbol.asyncIterator]() {
			if (gate) await gate;
			for (const event of events) yield event;
		},
		result: async () => result,
	};
}

function answering(text: string, extra: Record<string, unknown> = {}) {
	return {
		events: [{ type: "thinking_delta", delta: "hm" }, { type: "text_delta", delta: text }],
		result: { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE, ...extra },
	};
}

function setup(options: { entries?: unknown[]; leafId?: string | null; thinkingLevel?: string; mode?: string; settings?: unknown; noSettings?: boolean } = {}) {
	const mock = createMockPi();
	if (options.thinkingLevel) mock.rawPi.setThinkingLevel(options.thinkingLevel);
	if (!options.noSettings) Object.assign(mock.rawPi, { getSettings: () => options.settings ?? {} });
	btw(mock.pi);
	const calls: Call[] = [];
	let next: { events: unknown[]; result: Record<string, unknown>; gate?: Promise<void> } = answering("forty-two");
	const streamSimple = (model: unknown, context: Call["context"], requestOptions: Call["options"]) => {
		calls.push({ model, context, options: requestOptions });
		return fakeStream(next.events, next.result, next.gate);
	};
	const { ctx, notifications, widgets } = createMockContext({
		mode: options.mode ?? "tui",
		model: MODEL,
		modelRegistry: { streamSimple },
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => options.entries ?? [],
			getLeafId: () => options.leafId ?? null,
		},
	});
	const fire = async (event: string, payload: unknown = {}) => {
		for (const handler of mock.events.get(event) ?? []) await handler(payload, ctx);
	};
	const command = (args: string) => mock.commands.get("btw")!.handler(args, ctx);
	return { mock, ctx, calls, notifications, widgets, fire, command, answer: (value: typeof next) => (next = value) };
}

async function settle() {
	for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The roles the replay sent before the question. System messages are left out:
 * pi 0.87+ keeps them through `convertToLlm`, the pinned 0.84 drops them.
 */
function sentPrefix(call: Call) {
	return call.context.messages.slice(0, -1).map((message) => message.role).filter((role) => role !== "system");
}

test("replays the last request's transcript, its reply, and one framed question", async () => {
	const s = setup({ thinkingLevel: "high" });
	await s.fire("context_with_system", { messages: [system, user("fix the bug")] });
	await s.fire("before_provider_request", { payload: { model: "claude" } });
	await s.fire("message_end", { message: reply("Fixed.") });
	await s.command("what did you change?");
	await settle();

	assert.equal(s.calls.length, 1);
	const [call] = s.calls;
	assert.deepEqual(sentPrefix(call!), ["user", "assistant"]);
	const question = call!.context.messages.at(-1)!;
	assert.equal(question.role, "user");
	assert.equal((question.content as Array<{ text: string }>)[0]!.text, `${BTW_REMINDER}\n\nwhat did you change?`);
	assert.equal(call!.options.sessionId, "session-1");
	assert.equal(call!.options.reasoning, "high");
	assert.equal(call!.options.transport, "sse");
	assert.equal(typeof call!.options.onPayload, "function");
});

test("off thinking sends no reasoning, and settings budgets ride along", async () => {
	const s = setup({ settings: { thinkingBudgets: { low: 1024 } } });
	await s.fire("context_with_system", { messages: [system, user("hi")] });
	await s.command("q");
	await settle();
	assert.equal(s.calls[0]!.options.reasoning, undefined);
	assert.deepEqual(s.calls[0]!.options.thinkingBudgets, { low: 1024 });
});

test("a question asked mid-turn leaves out tool calls that are still running", async () => {
	const s = setup();
	await s.fire("context_with_system", { messages: [system, user("run it")] });
	await s.fire("message_end", { message: reply("running", ["call-1", "call-2"]) });
	await s.fire("message_end", { message: toolResult("call-1") });
	await s.command("q");
	await settle();
	assert.deepEqual(sentPrefix(s.calls[0]!), ["user"]);
});

test("the next request's context replaces the old capture and its tail", async () => {
	const s = setup();
	await s.fire("context_with_system", { messages: [system, user("one")] });
	await s.fire("message_end", { message: reply("first") });
	await s.fire("message_end", { message: user("two") });
	await s.fire("context_with_system", { messages: [system, user("one"), reply("first"), user("two")] });
	await s.command("q");
	await settle();
	assert.deepEqual(sentPrefix(s.calls[0]!), ["user", "assistant", "user"]);
});

test("replays the session branch before any request was seen, and again after compaction", async () => {
	const entries = [
		{ type: "message", id: "a", parentId: null, timestamp: "2026-10-29T00:00:00.000Z", message: system },
		{ type: "message", id: "b", parentId: "a", timestamp: "2026-10-29T00:00:01.000Z", message: user("from disk") },
		{ type: "message", id: "c", parentId: "b", timestamp: "2026-10-29T00:00:02.000Z", message: reply("answer") },
	];
	const s = setup({ entries, leafId: "c" });
	await s.command("q");
	await settle();
	assert.deepEqual(sentPrefix(s.calls[0]!), ["user", "assistant"]);
	assert.equal(s.calls[0]!.options.onPayload, undefined, "no main payload to align with");

	await s.fire("context_with_system", { messages: [system, user("live")] });
	await s.fire("session_compact", {});
	await s.command("q2");
	await settle();
	assert.deepEqual(sentPrefix(s.calls[1]!), ["user", "assistant"]);
});

test("stores the answer as a display-only entry and clears the widget", async () => {
	const s = setup();
	await s.fire("context_with_system", { messages: [system, user("hi")] });
	await s.command("why?");
	assert.equal(typeof s.widgets.get("pi-btw"), "function", "the live widget shows while it streams");
	await settle();

	assert.equal(s.widgets.get("pi-btw"), undefined);
	assert.equal(s.mock.sentMessages.length + s.mock.sentUserMessages.length, 0, "nothing enters the conversation");
	assert.deepEqual(s.mock.entries, [{
		customType: ENTRY_TYPE,
		data: { question: "why?", answer: "forty-two", model: "cpa/claude", usage: USAGE, durationMs: (s.mock.entries[0]!.data as { durationMs: number }).durationMs },
	}]);
});

test("records tool calls the model tried and answers cut off at the limit", async () => {
	const s = setup();
	s.answer({
		events: [{ type: "text_delta", delta: "Let me check" }, { type: "toolcall_end", toolCall: { name: "read" } }],
		result: { stopReason: "length", content: [{ type: "text", text: "Let me check" }] },
	});
	await s.command("q");
	await settle();
	const data = s.mock.entries[0]!.data as Record<string, unknown>;
	assert.deepEqual(data.toolCalls, ["read"]);
	assert.equal(data.truncated, true);
});

test("/btw alone cancels a running answer, which stores nothing", async () => {
	const s = setup();
	let release!: () => void;
	s.answer({ ...answering("late"), gate: new Promise<void>((resolve) => (release = resolve)) });
	await s.command("slow question");
	await s.command("");
	assert.equal(s.calls[0]!.options.signal.aborted, true);
	s.answer(answering("late"));
	release();
	await settle();
	assert.deepEqual(s.mock.entries, []);
	assert.deepEqual(s.notifications.at(-1), { message: "/btw cancelled.", level: "info" });
	assert.equal(s.widgets.get("pi-btw"), undefined);
});

test("one answer at a time", async () => {
	const s = setup();
	let release!: () => void;
	s.answer({ ...answering("first"), gate: new Promise<void>((resolve) => (release = resolve)) });
	await s.command("first");
	await s.command("second");
	assert.equal(s.calls.length, 1);
	assert.match(s.notifications.at(-1)!.message, /still streaming/);
	release();
	await settle();
	assert.equal(s.mock.entries.length, 1);
});

test("a provider error is reported and not stored", async () => {
	const s = setup();
	s.answer({ events: [], result: { stopReason: "error", errorMessage: "overloaded" } });
	await s.command("q");
	await settle();
	assert.deepEqual(s.mock.entries, []);
	assert.deepEqual(s.notifications.at(-1), { message: "/btw failed: overloaded", level: "error" });
});

test("an answer that outlives its session is dropped", async () => {
	const s = setup();
	let release!: () => void;
	s.answer({ ...answering("stale"), gate: new Promise<void>((resolve) => (release = resolve)) });
	await s.command("q");
	await s.fire("session_start", {});
	release();
	await settle();
	assert.deepEqual(s.mock.entries, []);
});

test("refuses outside the interactive terminal and without arguments", async () => {
	const rpc = setup({ mode: "rpc" });
	await rpc.command("q");
	assert.equal(rpc.calls.length, 0);
	assert.match(rpc.notifications.at(-1)!.message, /interactive terminal/);

	const bare = setup();
	await bare.command("   ");
	assert.deepEqual(bare.notifications.at(-1), { message: "Usage: /btw <question>", level: "info" });
});

test("explains the pi version floor when the host lacks streamSimple or getSettings", async () => {
	const noStream = setup();
	Object.assign(noStream.ctx as object, { modelRegistry: {} });
	await noStream.command("q");
	assert.match(noStream.notifications.at(-1)!.message, /pi 0\.99/);

	// pi 0.87 has streamSimple but no getSettings, so it could not honor images.blockImages.
	const noSettings = setup({ noSettings: true });
	await noSettings.command("q");
	assert.equal(noSettings.calls.length, 0);
	assert.match(noSettings.notifications.at(-1)!.message, /pi 0\.99/);
});

test("images.blockImages from settings replaces images in the replay, as Pi's own request does", async () => {
	const s = setup({ settings: { images: { blockImages: true } } });
	const picture: TranscriptMessage = { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "this?" }], timestamp: 2 };
	await s.fire("context_with_system", { messages: [system, picture] });
	await s.command("q");
	await settle();
	const sent = s.calls[0]!.context.messages.find((message) => message.role === "user")!;
	assert.deepEqual(sent.content, [{ type: "text", text: "Image reading is disabled." }, { type: "text", text: "this?" }]);
});

test("the payload hook gives the question the main request's top-level shape", async () => {
	const s = setup();
	const main = { model: "claude", tools: [{ name: "bash", strict: null }], messages: [1], max_tokens: 1, stream: true };
	await s.fire("context_with_system", { messages: [system, user("hi")] });
	await s.fire("before_provider_request", { payload: main });
	await s.command("q");
	await settle();
	const own = { model: "claude", messages: [1, 2], tools: [{ name: "bash" }], max_tokens: 32_000, stream: true };
	assert.deepEqual(s.calls[0]!.options.onPayload(own), {
		model: "claude",
		tools: [{ name: "bash", strict: null }],
		messages: [1, 2],
		max_tokens: 32_000,
		stream: true,
	});
});

test("alignPayload keeps the main key order and drops fields a hook removed", () => {
	const main = { model: "m", instructions: "x", tools: ["main"], input: ["a"], stream: true };
	const own = { model: "m", input: ["a", "b"], tools: ["own"], stream: true, previous_response_id: "r", extra: 1 };
	const aligned = alignPayload(own, main)!;
	assert.deepEqual(Object.keys(aligned), ["model", "instructions", "tools", "input", "stream", "previous_response_id"]);
	assert.deepEqual(aligned.tools, ["main"]);
	assert.deepEqual(aligned.input, ["a", "b"]);
	assert.equal(alignPayload({ ...own, model: "other" }, main), undefined);
	assert.equal(alignPayload("text", main), undefined);
});

test("alignPayload keeps this request's live handles, like Gemini's config.abortSignal", () => {
	const mainSignal = new AbortController().signal;
	const ownSignal = new AbortController().signal;
	const onChunk = () => undefined;
	const main = { model: "gemini", contents: ["a"], config: { systemInstruction: "s", tools: [{ name: "bash", strict: null }], abortSignal: mainSignal } };
	const own = { model: "gemini", contents: ["a", "b"], config: { systemInstruction: "s", tools: [{ name: "bash" }], abortSignal: ownSignal, onChunk } };
	const aligned = alignPayload(own, main)! as { contents: unknown; config: Record<string, unknown> };
	assert.equal(aligned.config.abortSignal, ownSignal);
	assert.equal(aligned.config.onChunk, onChunk, "a live value only this request has is kept");
	assert.deepEqual(aligned.config.tools, [{ name: "bash", strict: null }]);
	assert.deepEqual(aligned.contents, ["a", "b"]);
	assert.notEqual(aligned.config.tools, main.config.tools, "data is copied, not shared with the main payload");
});

test("only the payload right after a captured context counts", () => {
	const tracker = new PrefixTracker();
	tracker.onPayload({ model: "warmer" });
	assert.equal(tracker.snapshot(), undefined);
	tracker.onContext([system]);
	tracker.onPayload({ model: "main" });
	tracker.onPayload({ model: "warmer", max_tokens: 1 });
	assert.deepEqual(tracker.snapshot()!.payload, { model: "main" });
});

test("dropOpenToolTurn keeps answered tool calls", () => {
	const messages = [user("go"), reply("", ["a"]), toolResult("a")];
	assert.equal(dropOpenToolTurn(messages), messages);
	assert.deepEqual(dropOpenToolTurn([user("go"), reply("", ["a", "b"]), toolResult("b")]), [user("go")]);
});

test("blockImages mirrors Pi's placeholder and dedupes neighbours", () => {
	const image = { type: "image", data: "x", mimeType: "image/png" };
	const [blocked] = blockImages([{ role: "user", content: [image, image, { type: "text", text: "see" }] }]);
	assert.deepEqual(blocked!.content, [{ type: "text", text: "Image reading is disabled." }, { type: "text", text: "see" }]);
});

test("the transcript card shows the question, the answer, and the cache share", () => {
	const lines = plain(renderEntry({ question: "why?", answer: "Because **cache**.", model: "cpa/claude", usage: USAGE, durationMs: 3400 }, theme).render(80));
	assert.equal(lines[0], " btw why?");
	assert.ok(lines.some((line) => line.includes("Because cache.")));
	assert.equal(lines.at(-1), " cpa/claude · 99% cached of 41.2k · 40 out · 3.4s");
	assert.deepEqual(plain(renderEntry({ nope: true }, theme).render(80)), [" btw (unreadable entry)"]);
});

test("formatStats leaves out what it does not know", () => {
	assert.equal(formatStats({ model: "m" }), "m");
	assert.equal(formatStats({ model: "m", usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0 } }), "m · 5 out");
});

test("the live widget keeps the tail of a long answer", () => {
	const state = { question: "q", answer: "", thinking: true };
	const widget = new LiveWidget(theme, state);
	assert.deepEqual(plain(widget.render(40)), [" btw q", " thinking… · /btw alone cancels"]);
	state.answer = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n\n");
	const lines = plain(widget.render(40));
	assert.equal(lines[1], " …");
	assert.equal(lines.at(-2), " line 29");
	assert.equal(lines.at(-1), " answering… · /btw alone cancels");
});
