import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";
import autoName, { buildDigest, sanitizeTitle } from "../index.ts";

const MODEL = { provider: "test", id: "model", api: "anthropic-messages" };

const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });
const assistant = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

function setup(options: { name?: string; reply?: string | (() => Promise<unknown>); branch?: unknown[]; mode?: string } = {}) {
	const mock = createMockPi();
	let name = options.name;
	const names: string[] = [];
	Object.assign(mock.rawPi, {
		getSessionName: () => name,
		setSessionName: (value: string) => {
			name = value;
			names.push(value);
		},
	});
	autoName(mock.pi);
	const calls: Array<{ context: any; options: any }> = [];
	const branch = options.branch ?? [user("fix the statusline cache bug"), assistant("Fixed it.")];
	const { ctx, notifications, statuses } = createMockContext({
		mode: options.mode ?? "tui",
		model: MODEL,
		cwd: "/home/hank/repos/pi-extensions",
		sessionManager: { getBranch: () => branch },
		completeSimple: async (_model: unknown, context: unknown, requestOptions: unknown) => {
			calls.push({ context, options: requestOptions });
			if (typeof options.reply === "function") return options.reply();
			return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: options.reply ?? "statusline cache fix" }] };
		},
	});
	const fire = async (event: string, payload: unknown = {}) => {
		for (const handler of mock.events.get(event) ?? []) await handler(payload, ctx);
	};
	const runCommand = () => mock.commands.get("rename")!.handler("", ctx);
	const manualName = (value: string) => (mock.rawPi as any).setSessionName(value);
	return { fire, runCommand, manualName, calls, names, notifications, statuses, getName: () => name };
}

test("names an unnamed session once, after the first settled turn", async () => {
	const s = setup();
	await s.fire("session_start");
	await s.fire("agent_settled");
	await s.fire("agent_settled");
	assert.deepEqual(s.names, ["statusline cache fix"]);
	assert.equal(s.calls.length, 1);
});

test("the title request is standalone: no session id, no cache retention, no thinking", async () => {
	const s = setup();
	await s.fire("agent_settled");
	const { context, options } = s.calls[0];
	assert.equal(options.sessionId, undefined);
	assert.equal(options.reasoning, undefined);
	assert.equal(options.cacheRetention, "none");
	assert.equal(context.messages.length, 1);
	assert.match(context.messages[0].content, /First request: fix the statusline cache bug/);
	assert.match(context.messages[0].content, /Project directory: pi-extensions/);
});

test("never replaces an existing name automatically", async () => {
	const s = setup({ name: "my name" });
	await s.fire("agent_settled");
	assert.equal(s.calls.length, 0);
	assert.equal(s.getName(), "my name");
});

test("skips non-interactive modes and sessions with nothing to name", async () => {
	const headless = setup({ mode: "print" });
	await headless.fire("agent_settled");
	assert.equal(headless.calls.length, 0);

	const empty = setup({ branch: [user("<system-reminder>injected</system-reminder>")] });
	await empty.fire("agent_settled");
	assert.equal(empty.calls.length, 0);
});

test("a failed automatic attempt is silent and not retried until /rename", async () => {
	const s = setup({ reply: async () => ({ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] }) });
	await s.fire("agent_settled");
	await s.fire("agent_settled");
	assert.equal(s.calls.length, 1);
	assert.deepEqual(s.notifications, []);
	assert.equal(s.getName(), undefined);
});

test("/rename replaces the current name and reports it", async () => {
	const s = setup({ name: "old name", reply: "ci watcher cleanup" });
	await s.runCommand();
	assert.equal(s.getName(), "ci watcher cleanup");
	assert.deepEqual(s.notifications, [{ message: "Session renamed: ci watcher cleanup", level: "info" }]);
	assert.equal(s.statuses.get("pi-auto-name"), undefined);
});

test("/rename reports failures", async () => {
	const s = setup({ branch: [] });
	await s.runCommand();
	assert.deepEqual(s.notifications, [{ message: "Rename failed: nothing to name yet", level: "error" }]);
});

test("a new session aborts an in-flight title so it never lands on the wrong session", async () => {
	let release!: () => void;
	const s = setup({
		reply: () =>
			new Promise((resolve) => {
				release = () => resolve({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stale" }] });
			}),
	});
	const pending = s.fire("agent_settled");
	await new Promise((resolve) => setImmediate(resolve));
	await s.fire("session_start");
	release();
	await pending;
	assert.deepEqual(s.names, []);
});

test("a manual /name during the request wins over the automatic title", async () => {
	let release!: () => void;
	const s = setup({
		reply: () =>
			new Promise((resolve) => {
				release = () => resolve({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "auto" }] });
			}),
	});
	const pending = s.fire("agent_settled");
	await new Promise((resolve) => setImmediate(resolve));
	s.manualName("manual");
	release();
	await pending;
	assert.deepEqual(s.names, ["manual"]);
	assert.equal(s.getName(), "manual");
});

test("buildDigest keeps the first request, the last few, and the latest reply", () => {
	const branch = [
		user("first ask"),
		assistant("reply one"),
		user([{ type: "text", text: "second" }]),
		user("third"),
		user("fourth"),
		user("fifth"),
		assistant("latest reply"),
		{ type: "session_info", name: "ignored" },
	];
	const digest = buildDigest(branch, "/tmp/project")!;
	assert.deepEqual(digest.split("\n"), [
		"Project directory: project",
		"First request: first ask",
		"Recent request: third",
		"Recent request: fourth",
		"Recent request: fifth",
		"Latest reply: latest reply",
	]);
});

test("sanitizeTitle strips decoration and clamps on a word boundary", () => {
	assert.equal(sanitizeTitle('"Statusline cache fix."\nextra'), "Statusline cache fix");
	assert.equal(sanitizeTitle("Title: **herdr pane naming**"), "herdr pane naming");
	assert.equal(sanitizeTitle("   \n"), undefined);
	const long = sanitizeTitle("a very long title that keeps going well past the limit")!;
	assert.ok(long.length <= 40);
	assert.ok(!long.endsWith(" "));
});
