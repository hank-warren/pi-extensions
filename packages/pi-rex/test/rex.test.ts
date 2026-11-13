import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";
import { CHILD_SLOT, lastAssistant, toolAllowed } from "../child.ts";
import piRex from "../index.ts";
import { allowlist, childMessage, forwardedExtensions, registerTools, RexParent, slug, templateTools } from "../parent.ts";
import { parseEvent, type Rex, type RexEvent } from "../rex.ts";
import { spoolDrain, spoolWrite } from "../spool.ts";
import { loadTemplate, parseTemplate, splitCommand } from "../templates.ts";

const SESSION = "session:s1";
const SELF = "block:self";

const sessionEvent = (event: unknown) => JSON.stringify({ type: "session_event", payload: { session_id: SESSION, event } });
const blockEvent = (name: string, payload: unknown, block = "block:c1") =>
	sessionEvent({ type: "block_event", payload: { block_id: block, creator_name: "com.superlogical.terminal", name, payload } });

test("parseEvent reduces rex events to status, exit and close", () => {
	assert.deepEqual(parseEvent(blockEvent("program_status_changed", { record: { state: "blocked", kind: "question", msg: "Pick one" }, reason: "report" })), {
		type: "status", block: "block:c1", state: "blocked", kind: "question", msg: "Pick one",
	});
	assert.deepEqual(parseEvent(blockEvent("child_exited", { exit_code: 2, error: "exit status 2" })), { type: "exited", block: "block:c1", code: 2 });
	assert.deepEqual(parseEvent(sessionEvent({ type: "block_closed", payload: { block_id: "block:c1" } })), { type: "closed", block: "block:c1" });
	// A sub-task record, another event, another kind of block, and noise.
	assert.equal(parseEvent(blockEvent("program_status_changed", { id: "build/test", record: { state: "working" } })), undefined);
	assert.equal(parseEvent(blockEvent("bell", {})), undefined);
	assert.equal(parseEvent(sessionEvent({ type: "block_event", payload: { block_id: "b", creator_name: "other", name: "child_exited", payload: {} } })), undefined);
	assert.equal(parseEvent("not json"), undefined);
	assert.equal(parseEvent(JSON.stringify({ type: "session_created", payload: {} })), undefined);
});

test("spool delivers each message once, in send order", () => {
	const dir = mkdtempSync(join(tmpdir(), "spool-"));
	spoolWrite(dir, { n: 1 });
	spoolWrite(dir, { n: 2 });
	writeFileSync(join(dir, ".partial.json.tmp"), "{");
	const seen: number[] = [];
	spoolDrain<{ n: number }>(dir, (value) => seen.push(value.n));
	spoolDrain<{ n: number }>(dir, (value) => seen.push(value.n));
	assert.deepEqual(seen, [1, 2]);
	assert.deepEqual(readdirSync(dir), [".partial.json.tmp"]);
	spoolDrain(join(dir, "missing"), () => assert.fail("nothing to deliver"));

	// A delivery that throws keeps its message, and the ones behind it, for the next drain.
	spoolWrite(dir, { n: 3 });
	spoolWrite(dir, { n: 4 });
	spoolDrain<{ n: number }>(dir, () => {
		throw new Error("busy");
	});
	spoolDrain<{ n: number }>(dir, (value) => seen.push(value.n));
	assert.deepEqual(seen, [1, 2, 3, 4]);
});

test("templates: herdr-core format, pi commands only", () => {
	assert.deepEqual(splitCommand(`pi --model a/b:high --tools "read,bash" --append-system-prompt 'be brief'`), ["pi", "--model", "a/b:high", "--tools", "read,bash", "--append-system-prompt", "be brief"]);
	assert.deepEqual(parseTemplate("---\nname: reviewer\ncommand: pi --model a/b --tools read,bash\n---\n\nReview the diff.\n"), { args: ["--model", "a/b", "--tools", "read,bash"], body: "Review the diff." });
	assert.deepEqual(parseTemplate("Just instructions."), { args: [], body: "Just instructions." });
	assert.throws(() => parseTemplate("---\ncommand: claude --model x\n---\nbody"), /must start with "pi"/);
	const dir = mkdtempSync(join(tmpdir(), "templates-"));
	writeFileSync(join(dir, "reviewer.md"), "---\ncommand: pi --thinking high\n---\nReview.");
	assert.deepEqual(loadTemplate("reviewer", [join(dir, "none"), dir]), { args: ["--thinking", "high"], body: "Review." });
	assert.throws(() => loadTemplate("absent", [dir]), /No template "absent"/);
	assert.throws(() => loadTemplate("../etc", [dir]), /Invalid template name/);
});

test("small helpers", () => {
	assert.deepEqual(templateTools(["--model", "a/b", "--tools", "read, bash"]), ["read", "bash"]);
	assert.deepEqual(templateTools(["-t", "read", "--no-tools"]), []);
	assert.equal(templateTools(["--model", "a/b"]), undefined);
	assert.deepEqual(allowlist(["read", "bash"]), ["read", "bash"]);
	assert.deepEqual(allowlist([]), []);
	assert.equal(allowlist(["+codemode", "-write"]), undefined, "modifiers adjust the defaults; they are not an allowlist");
	assert.equal(allowlist(undefined), undefined);
	assert.throws(() => allowlist(["read", "+codemode"]), /mixes plain names/);
	assert.ok(toolAllowed("anything", undefined));
	assert.ok(toolAllowed("srv__gh__get", ["read", "srv__gh__*"]));
	assert.ok(!toolAllowed("bash", ["read", "srv__gh__*"]));
	assert.ok(!toolAllowed("read", []));
	assert.equal(slug("Review Auth!"), "review-auth");
	assert.equal(slug(undefined), "child");
	assert.deepEqual(forwardedExtensions(["--model", "x", "-e", "./packages/pi-rex", "--extension", "/abs/ext", "-e", "builtin:codemode"], "/work"), ["-e", "/work/packages/pi-rex", "-e", "/abs/ext", "-e", "builtin:codemode"]);
	assert.equal(childMessage("a", { state: "blocked", kind: undefined, note: 'say "hi" <b>' }, "body"), '<rex-child name="a" state="blocked" note="say &quot;hi&quot; &lt;b>">\nbody\n</rex-child>');
	assert.deepEqual(lastAssistant([{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: " done " }] }, { role: "toolResult" }]), { text: "done", error: undefined });
	assert.deepEqual(lastAssistant([{ role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded\nstack" }]), { text: "", error: "overloaded" });
	assert.equal(lastAssistant([{ role: "user", content: "hi" }]), undefined);
});

function fire(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown) {
	return Promise.all((mock.events.get(name) ?? []).map((handler) => (handler as (event: unknown, ctx: unknown) => unknown)(event, ctx)));
}

test("a child reports each settled run and delivers its inbox", async () => {
	const dir = mkdtempSync(join(tmpdir(), "child-"));
	const mock = createMockPi();
	let idle = true;
	const { ctx } = createMockContext({ isIdle: () => idle });
	writeFileSync(join(dir, "tools.json"), JSON.stringify(["read", "codemode"]));
	process.env.PI_REX_CHILD = dir;
	process.env.PI_REX_NAME = "review";
	piRex(mock.pi);
	const call = (toolName: string) => (mock.events.get("tool_call") ?? []).map((handler) => (handler as (event: unknown) => unknown)({ toolName }))[0];
	assert.equal(call("read"), undefined);
	assert.deepEqual(call("Agent"), { block: true, reason: "Agent is not among this agent's tools (read, codemode). Use one of those instead." });
	assert.equal(mock.tools.length, 0, "a child registers no tools");
	spoolWrite(join(dir, "inbox"), { text: "waiting before start" });
	await fire(mock, "session_start", { reason: "startup" }, ctx);
	assert.equal(process.env.PI_REX_CHILD, undefined);
	assert.deepEqual(mock.sentUserMessages, [], "held until the task Pi was started with has begun");
	idle = false;
	await fire(mock, "agent_start", {}, ctx);
	assert.deepEqual(mock.sentUserMessages, [{ text: "waiting before start", options: { deliverAs: "steer" } }]);
	idle = true;

	await fire(mock, "agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Found two bugs." }] }] }, ctx);
	await fire(mock, "agent_settled", { aborted: false }, ctx);
	await fire(mock, "agent_settled", { aborted: true }, ctx);
	const reports: unknown[] = [];
	spoolDrain(join(dir, "outbox"), (report) => reports.push(report));
	assert.deepEqual(reports, [{ text: "Found two bugs." }, { text: "", aborted: true }]);

	idle = false;
	spoolWrite(join(dir, "inbox"), { text: "focus on the first" });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.deepEqual(mock.sentUserMessages[1], { text: "focus on the first", options: { deliverAs: "steer" } });
	await fire(mock, "session_shutdown", { reason: "reload" }, ctx);

	// A reload runs the extension again in the same process, after the variables are gone: still the same child.
	const reloaded = createMockPi();
	piRex(reloaded.pi);
	assert.equal(reloaded.tools.length, 0);
	assert.ok((reloaded.events.get("tool_call") ?? []).map((handler) => (handler as (event: unknown) => unknown)({ toolName: "bash" }))[0], "the allowlist survives a reload");
	spoolWrite(join(dir, "inbox"), { text: "after reload" });
	await fire(reloaded, "session_start", { reason: "reload" }, ctx);
	assert.deepEqual(reloaded.sentUserMessages, [{ text: "after reload", options: { deliverAs: "steer" } }], "a reloaded child is past its first run");
	await fire(reloaded, "agent_end", { messages: [{ role: "assistant", content: "After reload." }] }, ctx);
	await fire(reloaded, "agent_settled", {}, ctx);
	const after: unknown[] = [];
	spoolDrain(join(dir, "outbox"), (report) => after.push(report));
	assert.deepEqual(after, [{ text: "After reload." }]);
	await fire(reloaded, "session_shutdown", { reason: "quit" }, ctx);
	delete (globalThis as { [CHILD_SLOT]?: unknown })[CHILD_SLOT];
});

function fakeRex() {
	const calls: string[][] = [];
	let emit: ((event: RexEvent) => void) | undefined;
	let listening = 0;
	let blocks = ["block:c1"];
	const rex: Rex = {
		async run(args) {
			calls.push(args);
			if (args[0] === "run") return JSON.stringify({ window_id: "window:w1", block_ids: ["block:c1"] });
			if (args[0] === "block" && args[1] === "ls") return JSON.stringify({ blocks: blocks.map((block_id) => ({ block_id })) });
			if (args[0] === "capture") return "line 1   \n\n\n\nline 2\n";
			return "";
		},
		events(_session, onEvent) {
			emit = onEvent;
			listening += 1;
			return () => {
				listening -= 1;
			};
		},
	};
	return { rex, calls, emit: (event: RexEvent) => emit?.(event), listening: () => listening, setBlocks: (next: string[]) => (blocks = next) };
}

function parentHarness(env: NodeJS.ProcessEnv = { REX_SESSION: SESSION, REX_BLOCK: SELF }) {
	const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
	const mock = createMockPi();
	const fake = fakeRex();
	const { ctx, statuses } = createMockContext({ cwd, sessionManager: { getSessionId: () => "sess-1" } });
	const make = () => new RexParent(mock.pi, { rex: fake.rex, agentDir: () => agentDir, env, piCommand: () => ["/usr/bin/node", "/opt/pi/cli.js", "-e", "/ext"] });
	return { agentDir, cwd, mock, fake, ctx, statuses, make };
}

const messages = (mock: ReturnType<typeof createMockPi>) => mock.sentMessages.map(({ message, options }) => ({ content: (message as { content: string }).content, options }));
const WAKE = { triggerTurn: true, deliverAs: "followUp" };

test("spawn starts pi in a new unfocused tab with the task in a file", async () => {
	const h = parentHarness({ REX_SESSION: SESSION, REX_BLOCK: SELF, PI_CODING_AGENT_DIR: "/scratch/agent" });
	mkdirSync(join(h.agentDir, "pi-rex", "templates"), { recursive: true });
	writeFileSync(join(h.agentDir, "pi-rex", "templates", "reviewer.md"), "---\ncommand: pi --tools read,bash\n---\nYou review diffs.");
	const parent = h.make();
	await parent.start(h.ctx);
	const child = await parent.spawn({ task: "Review src/x.ts", name: "Review", template: "reviewer", model: "cpa/m", thinking: "high" }, h.ctx);
	const dir = join(h.agentDir, "pi-rex", "sess-1", "review");
	assert.deepEqual(h.fake.calls[0], [
		"run", "-s", SESSION, "--focus=false", "--label", "review", "--cwd", h.cwd, "--json", "--",
		"env", `PI_REX_CHILD=${dir}`, "PI_REX_NAME=review", "PI_CODING_AGENT_DIR=/scratch/agent",
		"/usr/bin/node", "/opt/pi/cli.js", "-e", "/ext", "--tools", "read,bash", "--model", "cpa/m", "--thinking", "high", "--name", "review", `@${join(dir, "task.md")}`,
	]);
	assert.deepEqual(h.fake.calls[1], ["window", "rename", "-s", SESSION, "window:w1", "review"]);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")), ["read", "bash"], "the template's allowlist is enforced in the child");
	const task = readFileSync(join(dir, "task.md"), "utf8");
	assert.match(task, /^You review diffs\.\n\nReview src\/x\.ts\n\n---\nYou are "review"/);
	assert.equal(child.state, "starting");
	assert.equal(h.fake.listening(), 1);
	assert.equal(h.statuses.get("pi-rex"), "rex · 1 starting");

	// A second child with the same name gets its own; a split anchors on this pane.
	// Modifiers pass through to Pi and enforce nothing; a mixed list is refused before anything is started.
	const modified = await parent.spawn({ task: "m", name: "mod", tools: ["+codemode"] }, h.ctx);
	assert.ok(!existsSync(join(modified.dir, "tools.json")));
	assert.deepEqual((h.fake.calls.at(-2) as string[]).slice(-5, -3), ["--tools", "+codemode"]);
	await assert.rejects(parent.spawn({ task: "m", tools: ["read", "+codemode"] }, h.ctx), /mixes plain names/);

	const second = await parent.spawn({ task: "again", name: "review", placement: "split", tools: [] }, h.ctx);
	assert.equal(second.name, "review-2");
	const args = h.fake.calls.at(-1) as string[];
	assert.deepEqual(args.slice(9, 13), ["--split", "right", "-b", SELF]);
	assert.ok(args.includes("--no-tools"));
	assert.equal(readFileSync(join(second.dir, "tools.json"), "utf8"), "[]");
	assert.equal(second.window, undefined);
	parent.stop();
	assert.equal(h.fake.listening(), 0);
});

test("concurrent spawns never share a name or a directory", async () => {
	const h = parentHarness();
	const parent = h.make();
	await parent.start(h.ctx);
	const [a, b, c] = await Promise.all([parent.spawn({ task: "one" }, h.ctx), parent.spawn({ task: "two" }, h.ctx), parent.spawn({ task: "three", name: "child" }, h.ctx)]);
	assert.deepEqual([a.name, b.name, c.name], ["child", "child-2", "child-3"]);
	assert.deepEqual([a, b, c].map((child) => readFileSync(join(child.dir, "task.md"), "utf8").split("\n")[0]), ["one", "two", "three"]);
	assert.equal(parent.list().length, 3);

	// A failed spawn releases its name.
	const run = h.fake.rex.run;
	h.fake.rex.run = async () => {
		throw new Error("rex run: no server");
	};
	await assert.rejects(parent.spawn({ task: "x", name: "retry" }, h.ctx), /no server/);
	h.fake.rex.run = run;
	assert.equal((await parent.spawn({ task: "x", name: "retry" }, h.ctx)).name, "retry");
	parent.stop();
});

test("spawn refuses outside rex and for a missing cwd", async () => {
	const outside = parentHarness({});
	const parent = outside.make();
	await parent.start(outside.ctx);
	await assert.rejects(parent.spawn({ task: "x" }, outside.ctx), /not running in a Rex terminal/);
	const inside = parentHarness();
	const other = inside.make();
	await other.start(inside.ctx);
	await assert.rejects(other.spawn({ task: "x", cwd: "nope" }, inside.ctx), /is not a directory/);
	assert.equal(inside.fake.calls.length, 0);
});

test("reports, blocks and exits reach the parent as messages", async () => {
	const h = parentHarness();
	const parent = h.make();
	await parent.start(h.ctx);
	const child = await parent.spawn({ task: "t", name: "fix" }, h.ctx);

	h.fake.emit({ type: "status", block: "block:c1", state: "working" });
	h.fake.emit({ type: "status", block: "block:other", state: "blocked", msg: "not ours" });
	assert.equal(h.mock.sentMessages.length, 0);

	h.fake.emit({ type: "status", block: "block:c1", state: "blocked", kind: "permission", msg: "Run rm -rf?" });
	h.fake.emit({ type: "status", block: "block:c1", state: "blocked", kind: "permission", msg: "Run rm -rf?" });
	assert.equal(h.mock.sentMessages.length, 1, "a repeated status is not announced twice");
	assert.match(messages(h.mock)[0].content, /^<rex-child name="fix" state="blocked" kind="permission">\nRun rm -rf\?\nIt is waiting in its Rex tab "fix"\. Only the user can answer there\.\n<\/rex-child>$/);
	assert.deepEqual(messages(h.mock)[0].options, WAKE);
	assert.equal(parent.list()[0].note, "Run rm -rf?");

	h.fake.emit({ type: "status", block: "block:c1", state: "done" });
	assert.equal(h.mock.sentMessages.length, 1, "done is a turn ending; the report carries the result");
	spoolWrite(join(child.dir, "outbox"), { text: "Fixed it." });
	spoolWrite(join(child.dir, "outbox"), { text: "", error: "overloaded" });
	spoolWrite(join(child.dir, "outbox"), { text: "x".repeat(40_010) });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.deepEqual(messages(h.mock)[1], { content: '<rex-child name="fix" state="done">\nFixed it.\n</rex-child>', options: WAKE });
	assert.match(messages(h.mock)[2].content, /state="error" error="overloaded">\nThe run ended without a reply\./);
	assert.match(messages(h.mock)[3].content, /\[Cut at 40000 characters\. The whole report is in .*report-3\.md\.\]/);
	assert.equal(readFileSync(join(child.dir, "report-3.md"), "utf8").length, 40_010);

	// The last report is delivered before the exit notice, and the exit is announced once.
	spoolWrite(join(child.dir, "outbox"), { text: "", aborted: true });
	h.fake.emit({ type: "exited", block: "block:c1", code: 0 });
	h.fake.emit({ type: "closed", block: "block:c1" });
	assert.equal(h.mock.sentMessages.length, 6);
	assert.match(messages(h.mock)[4].content, /state="interrupted">\nThe run was interrupted in its tab/);
	assert.match(messages(h.mock)[5].content, /state="exited" code="0">\nIts tab closed/);
	assert.equal(parent.list()[0].state, "exited");
	assert.equal(h.fake.listening(), 0);
	assert.throws(() => parent.send("fix", "more"), /has exited/);
});

test("send, read and stop", async () => {
	const h = parentHarness();
	const parent = h.make();
	await parent.start(h.ctx);
	const child = await parent.spawn({ task: "t", name: "fix" }, h.ctx);
	parent.send("fix", "also check y.ts");
	const inbox: unknown[] = [];
	spoolDrain(join(child.dir, "inbox"), (message) => inbox.push(message));
	assert.deepEqual(inbox, [{ text: "also check y.ts" }]);
	assert.throws(() => parent.send("nope", "x"), /No child "nope"\. Children: fix\./);

	assert.equal((await parent.read("fix", 5)).screen, "line 1\n\nline 2");
	assert.deepEqual(h.fake.calls.at(-1), ["capture", "-s", SESSION, "-b", "block:c1", "--trim"]);

	// A close that fails leaves the child running and still able to wake the parent.
	const run = h.fake.rex.run;
	h.fake.rex.run = async () => {
		throw new Error("rex block: timeout");
	};
	await assert.rejects(parent.stopChild("fix"), /timeout/);
	h.fake.rex.run = run;
	assert.equal(parent.list()[0].stopRequested, undefined);
	assert.equal(parent.list()[0].state, "starting");

	// A report that arrives while the close is in flight wakes the parent, whether or not the close then succeeds.
	let release: (() => void) | undefined;
	h.fake.rex.run = () => new Promise((resolve, reject) => {
		release = () => reject(new Error("rex block: timeout"));
	});
	const failing = parent.stopChild("fix");
	spoolWrite(join(child.dir, "outbox"), { text: "Finished just now." });
	await new Promise((resolve) => setTimeout(resolve, 150));
	release?.();
	await assert.rejects(failing, /timeout/);
	h.fake.rex.run = run;
	assert.deepEqual(messages(h.mock), [{ content: '<rex-child name="fix" state="done">\nFinished just now.\n</rex-child>', options: WAKE }]);
	h.mock.sentMessages.length = 0;

	await parent.stopChild("fix");
	assert.deepEqual(h.fake.calls.at(-1), ["block", "close", "-s", SESSION, "block:c1"]);
	assert.equal(parent.list()[0].state, "exited");
	assert.equal(h.mock.sentMessages.length, 0, "a requested stop is not announced");
});

test("a restarted session finds its children and what they reported meanwhile", async () => {
	const h = parentHarness();
	const first = h.make();
	await first.start(h.ctx);
	const child = await first.spawn({ task: "t", name: "fix" }, h.ctx);
	first.stop();
	spoolWrite(join(child.dir, "outbox"), { text: "Done while you were away." });

	const second = h.make();
	await second.start(h.ctx);
	assert.equal(second.list()[0].name, "fix");
	assert.equal(second.list()[0].state, "done", "the report settles a state recorded as starting");
	assert.equal(h.fake.listening(), 1);
	assert.deepEqual(messages(h.mock), [{ content: '<rex-child name="fix" state="done">\nDone while you were away.\n</rex-child>', options: { triggerTurn: false } }]);
	second.stop();

	// Its tab closed while no session was watching.
	h.fake.setBlocks([]);
	const third = h.make();
	await third.start(h.ctx);
	assert.equal(third.list()[0].state, "exited");
	assert.match(messages(h.mock)[1].content, /state="exited"/);
	assert.deepEqual(messages(h.mock)[1].options, { triggerTurn: false });
	assert.equal(h.fake.listening(), 0);
	assert.ok(existsSync(join(h.agentDir, "pi-rex", "sess-1", "children.json")));
});

test("the parent registers its tools hidden outside rex and for codemode inside", async () => {
	const outside = createMockPi({ activeTools: ["codemode"] });
	piRex(outside.pi);
	assert.deepEqual(outside.tools.map((tool) => (tool as unknown as { exposure: string }).exposure), Array(5).fill("hidden"));
	assert.deepEqual([...outside.events.keys()].sort(), ["session_shutdown", "session_start"]);

	const h = parentHarness();
	registerTools(h.mock.pi, h.make(), "direct");
	const byName = new Map(h.mock.tools.map((tool) => [(tool as unknown as { name: string }).name, tool as unknown as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; structuredContent: unknown }> }]));
	assert.deepEqual([...byName.keys()], ["RexSpawn", "RexSend", "RexRead", "RexStop", "RexList"]);
	const list = await byName.get("RexList")?.execute("id", {});
	assert.deepEqual(list?.structuredContent, { children: [] });
	assert.equal(list?.content[0].text, "No children.");
});
