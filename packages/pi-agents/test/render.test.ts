import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS } from "../src/agents.js";
import { AgentManager, AgentRun } from "../src/manager.js";
import { AgentPanel } from "../src/panel.js";
import { type AgentDetails, renderAgentCall, renderAgentMessage, renderAgentResult } from "../src/render.js";
import { AgentViewer, type ViewerKeys } from "../src/viewer.js";

// Pi's components read its global theme, as they do in a real session.
initTheme("dark", false);
const strip = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "").trimEnd());
const plain: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
} as unknown as Theme;
const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").length;
const keys: ViewerKeys = {
	matches: (data, id) => (id === "app.tools.expand" ? data === "\x0f" : id === "tui.select.cancel" ? data === "\x1b" : false),
	getKeys: (id) => (id === "app.tools.expand" ? ["ctrl+o"] : []),
};

function details(overrides: Partial<AgentDetails> = {}): AgentDetails {
	return {
		id: "ab12",
		name: "scout",
		type: "scout",
		description: "map payment flow",
		status: "done",
		background: false,
		model: "cpa/claude-sonnet-5",
		toolUses: 5,
		toolLog: [
			{ head: "$", rest: "rg -n charge" },
			{ head: "read", rest: "src/pay.ts:1-40" },
			{ head: "grep", rest: "/refund/ in src" },
			{ head: "read", rest: "src/refund.ts" },
			{ head: "ls", rest: "src" },
		],
		contextTokens: 41_000,
		contextWindow: 272_000,
		outputTokens: 900,
		cost: 0.02,
		durationMs: 63_000,
		budgetExhausted: false,
		...overrides,
	};
}

test("the Agent row reads like Pi's own tool rows", () => {
	assert.deepEqual(strip(renderAgentCall({ subagent_type: "scout", description: "map payment flow" }, plain).render(80)), ["agent scout map payment flow"]);

	const running = strip(renderAgentResult(details({ status: "running" }), "", false, plain).render(80));
	assert.match(running[0]!, /^\.\.\. \(2 earlier tool calls, /);
	assert.deepEqual(running.slice(1, 4), ["grep /refund/ in src", "read src/refund.ts", "ls src"]);
	assert.equal(running.at(-1), "claude-sonnet-5 · 41k/272k · 1m03s");

	const background = strip(renderAgentResult(details({ status: "running", background: true }), "", false, plain).render(80));
	assert.deepEqual(background, ["running in background as scout · ↓ to manage"]);

	const result = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
	const done = strip(renderAgentResult(details({ result, budgetExhausted: true }), "", false, plain).render(80));
	assert.equal(done[0], "line 1");
	assert.match(done[10]!, /^\.\.\. \(4 more lines, /);
	assert.ok(done.includes("[budget exhausted]"));
	assert.equal(done.at(-1), "claude-sonnet-5 · 5 tool calls · 41k context · took 1m03s");
});

test("a background report lands in a Pi custom-message box labeled [agent]", () => {
	const lines = strip(renderAgentMessage(details({ result: "found it" }), false, plain).render(80));
	assert.ok(lines.includes(" [agent] scout · done · 5 tool calls · 41k context · 1m03s"));
	const named = strip(renderAgentMessage(details({ name: "auth-review", type: "reviewer" }), false, plain).render(80));
	assert.ok(named.includes(" [agent] auth-review reviewer · done · 5 tool calls · 41k context · 1m03s"));
	assert.ok(lines.includes(" found it"));
});

function viewerRun(overrides: Partial<ConstructorParameters<typeof AgentRun>[0]> = {}): AgentRun {
	return new AgentRun({
		name: "scout",
		definition: BUILTIN_AGENTS[1]!,
		description: "map payment flow",
		model: "cpa/claude-sonnet-5",
		cwd: process.cwd(),
		background: true,
		contextWindow: 272_000,
		maxTurns: 80,
		appendPrompt: "",
		...overrides,
	});
}

function idleManager(): AgentManager {
	return new AgentManager({
		config: () => ({ maxConcurrent: 1, maxTurns: 80, idleTtlSeconds: 1, excludeTools: [] }),
		ctx: () => undefined,
		spawnCommand: () => ["true"],
		sessionDir: () => undefined,
		onFinished: () => {},
	});
}

const fakeTui = () => ({ terminal: { rows: 60, columns: 100 }, requestRender: () => {} });

test("the viewer renders a child's session with Pi's own components and takes typed steering", async () => {
	const manager = idleManager();
	const run = viewerRun();
	run.status = "running";
	run.log.push(
		{ kind: "message", message: { role: "user", content: "Find where refunds are issued." } },
		{ kind: "message", message: { role: "assistant", content: [{ type: "text", text: "Searching." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "rg -n refund" } }], stopReason: "toolUse", timestamp: 1_000_000 } },
		{ kind: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "src/refund.ts:12: export function refund()" }], timestamp: 1_042_000 } },
		{ kind: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/refund.ts" } }], stopReason: "toolUse" } },
		{ kind: "notice", text: "compacting context" },
	);
	run.partials.set("c2", { content: [{ type: "text", text: "partial file" }] });
	const sent: string[] = [];
	const viewer = new AgentViewer(fakeTui() as never, plain, keys, run, manager, () => {}, async (text) => {
		sent.push(text);
		return "steered";
	});
	const screen = strip(viewer.render(100)).join("\n");
	assert.match(screen, / scout map payment flow/);
	assert.doesNotMatch(screen, /scout scout/, "the type is not repeated when it is the name");
	assert.match(screen, /claude-sonnet-5 · 0\/272k · 0 tool calls/);
	assert.match(screen, /Find where refunds are issued\./, "Pi's user message component");
	assert.match(screen, /\$ rg -n refund/, "Pi's bash renderer");
	assert.match(screen, /src\/refund\.ts:12: export function refund\(\)/, "the tool's output");
	assert.match(screen, /Took 42/, "when the call really ran, not when the viewer opened");
	assert.match(screen, /read src\/refund\.ts/, "Pi's read renderer");
	assert.match(screen, /compacting context/);
	assert.match(screen, /enter steer · ↑↓ scroll · ctrl\+o expand · esc back/);
	assert.doesNotMatch(screen, /ctrl\+x/, "ctrl+x is Pi's copy key; stopping lives in the list");

	for (const key of "go".split("")) viewer.handleInput(key);
	viewer.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, ["go"]);
	assert.match(strip(viewer.render(100)).join("\n"), /steering after its current tool calls/);
	viewer.dispose();
	await manager.dispose();
});

test("no viewer line is wider than the terminal, whatever the child sends", async () => {
	const manager = idleManager();
	const run = viewerRun({ description: "two\nlines" });
	run.status = "running";
	run.approval = `Allow ${"x".repeat(300)}?`;
	const viewer = new AgentViewer(fakeTui() as never, plain, keys, run, manager, () => {}, async () => "steered");
	for (const width of [100, 40]) {
		for (const line of viewer.render(width)) {
			assert.ok(visible(line) <= width, `${visible(line)} > ${width}: ${line.slice(0, 60)}`);
			assert.ok(!line.includes("\n"), "a line break inside a line corrupts Pi's diff renderer");
		}
	}
	viewer.dispose();
	await manager.dispose();
});

test("the viewer follows the log as it is trimmed or replaced, and keeps results whose call is gone", async () => {
	const manager = idleManager();
	const run = viewerRun();
	const say = (text: string) => ({ kind: "message" as const, message: { role: "user", content: text } });
	run.log.push(say("first task"), say("second task"));
	const viewer = new AgentViewer(fakeTui() as never, plain, keys, run, manager, () => {}, async () => "steered");
	assert.match(strip(viewer.render(100)).join("\n"), /first task/);

	run.log.splice(0, 1);
	run.log.push(say("third task"));
	(viewer as unknown as { sync(): void }).sync();
	const trimmed = strip(viewer.render(100)).join("\n");
	assert.doesNotMatch(trimmed, /first task/, "entries trimmed from the log leave the screen");
	assert.match(trimmed, /second task[\s\S]*third task/);

	run.log = [{ kind: "message", message: { role: "toolResult", toolCallId: "gone", toolName: "bash", content: [{ type: "text", text: "orphan output" }] } }];
	(viewer as unknown as { sync(): void }).sync();
	const replaced = strip(viewer.render(100)).join("\n");
	assert.doesNotMatch(replaced, /second task/);
	assert.match(replaced, /bash result: orphan output/);
	viewer.dispose();
	await manager.dispose();
});

function panelWith(runs: AgentRun[], opened: AgentRun[] = []) {
	let close: () => void = () => {};
	const panel = new AgentPanel({ subscribe: () => () => {}, list: () => runs, stop: async () => {} }, (run) => {
		opened.push(run);
		return new Promise<void>((resolve) => (close = resolve));
	});
	type Factory = (tui: unknown, theme: Theme) => { render(width: number): string[] };
	const widgets = new Map<string, { factory: Factory; placement?: string }>();
	panel.attach({
		onTerminalInput: () => () => {},
		setWidget: (key: string, factory: Factory | undefined, options?: { placement?: string }) => {
			if (factory) widgets.set(key, { factory, placement: options?.placement });
			else widgets.delete(key);
		},
		getEditorText: () => "",
	} as never);
	const draw = (placement: string, width: number) => {
		const widget = [...widgets.values()].find((item) => item.placement === placement);
		return widget ? widget.factory({ requestRender() {} }, plain).render(width) : [];
	};
	return {
		panel,
		above: (width = 120) => strip(draw("aboveEditor", width)),
		below: (width = 120) => strip(draw("belowEditor", width)),
		raw: (width = 120) => [...draw("aboveEditor", width), ...draw("belowEditor", width)],
		close: () => close(),
	};
}

test("above the prompt, one summary line; ↓ opens the agents below it and ↑ off the top closes them", async () => {
	const run = viewerRun({
		name: "auth-review",
		definition: { ...BUILTIN_AGENTS[0]!, name: "reviewer" },
		description: "review auth changes",
		model: "cpa/claude-opus-5-5",
		contextWindow: 1_000_000,
	});
	run.status = "running";
	run.contextTokens = 41_000;
	run.approval = "Allow git push?";
	const other = viewerRun({ description: "map payment flow" });
	other.status = "running";
	other.toolLog = [{ head: "$", rest: "rg -n charge" }];
	other.runningTools.add("c1");
	const opened: AgentRun[] = [];
	const { panel, above, below, close } = panelWith([run, other], opened);
	assert.deepEqual(above(), [" ? Agents | 0/2 completed | 1 needs you | ↓ to manage"]);
	panel.handleKey("\x1b[B");
	assert.match(below()[3]!, /^ {17}\$ rg -n charge$/, "a running agent's current tool call sits under its task");
	panel.handleKey("\x1b");
	[run.approval, other.approval] = [undefined, "Allow rm?"];
	panel.handleKey("\x1b[B");
	assert.match(below()[1]!, /^ {17}thinking…$/);
	assert.match(below()[2]!, /^→ \? scout/, "the cursor starts on the agent waiting for you");
	panel.handleKey("\x1b");
	[run.approval, other.approval] = ["Allow git push?", undefined];
	other.status = "done";
	other.endedAt = Date.now();
	other.runningTools.clear();
	assert.deepEqual(above(), [" ? Agents | 1/2 completed | 1 needs you | ↓ to manage"], "an agent that finished mid-batch still counts");
	assert.deepEqual(below(), [], "nothing below the prompt until you ask to manage");

	assert.equal(panel.handleKey("\x1b[A"), undefined, "↑ at the prompt is the editor's history");
	assert.deepEqual(panel.handleKey("\x1b[B"), { consume: true });
	assert.deepEqual(above(), [" ? Agents | 1/2 completed | 1 needs you"]);
	const selector = below();
	assert.match(selector[0]!, /^→ \? auth-review {2}review auth changes {2}needs you · claude-opus-5-5 · 41k\/1M · \d+s$/, "the first ↓ lands on the first agent");
	assert.match(selector[1]!, /^ {17}waiting for your approval: Allow git push\?$/);
	assert.match(selector[2]!, /^ {2}✓ scout {8}map payment flow {5}claude-sonnet-5 · 0\/272k · \d+s$/, "columns line up");
	assert.match(selector[3]!, /^ {2}↑↓ select · enter open · x stop · esc back$/);
	assert.match(selector[4]!, /^─+$/, "a rule closes the drawer above the footer");
	assert.deepEqual(panel.handleKey("\x1b[B"), { consume: true });
	assert.match(below().at(-2)!, /x dismiss/);

	assert.deepEqual(panel.handleKey("\r"), { consume: true });
	assert.deepEqual(opened, [other]);
	assert.deepEqual(below(), [], "while viewing, the viewer is the manager");
	close();
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(below()[2]!, /^→ ✓ scout/, "esc from the viewer lands back on that agent");
	assert.deepEqual(panel.handleKey("\x1b[A"), { consume: true });
	assert.deepEqual(panel.handleKey("\x1b[A"), { consume: true }, "↑ off the top row closes the selector");
	assert.deepEqual(below(), []);
	assert.equal(panel.handleKey("\x1b[A"), undefined, "and only the next ↑ reaches the editor");

	panel.handleKey("\x1b[B");
	assert.equal(panel.handleKey("a"), undefined, "typing closes the selector and reaches the editor");
	assert.deepEqual(below(), []);

	run.status = "done";
	run.approval = undefined;
	run.endedAt = Date.now();
	assert.deepEqual(above(), [" ✓ Agents | 2/2 completed | ↓ to manage"]);
	run.endedAt = other.endedAt = Date.now() - 61_000;
	assert.deepEqual(above(), [], "a finished batch clears after a minute");
	panel.detach();
});

test("no summary or selector line is wider than the terminal", () => {
	const runs = Array.from({ length: 9 }, (_, i) => {
		const run = viewerRun({ name: `agent-${i}${"x".repeat(i)}`, description: `task ${i}\nsecond line` });
		run.status = "running";
		return run;
	});
	const { panel, raw, below } = panelWith(runs);
	for (let i = 0; i < 8; i++) panel.handleKey("\x1b[B");
	for (const width of [120, 30, 8]) {
		for (const line of raw(width)) {
			assert.ok(visible(line) <= width, `${visible(line)} > ${width}: ${line}`);
			assert.ok(!line.includes("\n"));
		}
	}
	const lines = below();
	const columns = lines.filter((line) => /agent-\d/.test(line)).map((line) => [line.indexOf("task"), line.indexOf("claude")]);
	assert.equal(new Set(columns.map(String)).size, 1, "descriptions and stats line up whatever the name lengths");
	assert.ok(lines.some((line) => /↑ \d+ more/.test(line)));
	assert.ok(lines.some((line) => /↓ \d+ more/.test(line)));
	panel.detach();
});
