import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS } from "../src/agents.js";
import { AgentManager, AgentRun } from "../src/manager.js";
import { AgentPanel } from "../src/panel.js";
import { type AgentDetails, renderAgentCall, renderAgentMessage, renderAgentResult } from "../src/render.js";
import { AgentViewer } from "../src/viewer.js";

// Pi's components read its global theme, as they do in a real session.
initTheme("dark", false);
const strip = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "").trimEnd());
const plain: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

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
	assert.deepEqual(background, ["running in background as scout · ↓ to watch"]);

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

test("the viewer renders a child's session with Pi's own components and takes typed steering", async () => {
	const manager = new AgentManager({
		config: () => ({ maxConcurrent: 1, maxTurns: 80, idleTtlSeconds: 1, excludeTools: [] }),
		ctx: () => undefined,
		spawnCommand: () => ["true"],
		sessionDir: () => undefined,
		onFinished: () => {},
	});
	const run = new AgentRun({
		name: "scout",
		definition: BUILTIN_AGENTS[1]!,
		description: "map payment flow",
		model: "cpa/claude-sonnet-5",
		cwd: process.cwd(),
		background: true,
		contextWindow: 272_000,
		maxTurns: 80,
		appendPrompt: "",
	});
	run.status = "running";
	run.log.push(
		{ kind: "message", message: { role: "user", content: "Find where refunds are issued." } },
		{ kind: "message", message: { role: "assistant", content: [{ type: "text", text: "Searching." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "rg -n refund" } }], stopReason: "toolUse" } },
		{ kind: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "src/refund.ts:12: export function refund()" }] } },
		{ kind: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/refund.ts" } }], stopReason: "toolUse" } },
		{ kind: "notice", text: "compacting context" },
	);
	run.partials.set("c2", { content: [{ type: "text", text: "partial file" }] });
	const sent: string[] = [];
	let renders = 0;
	const tui = { terminal: { rows: 60, columns: 100 }, requestRender: () => void (renders += 1) };
	const viewer = new AgentViewer(tui as never, plain, run, manager, () => {}, async (text) => {
		sent.push(text);
		return "steered";
	}, () => {});
	const screen = strip(viewer.render(100)).join("\n");
	assert.match(screen, / scout map payment flow/);
	assert.doesNotMatch(screen, /scout scout/, "the type is not repeated when it is the name");
	assert.match(screen, /claude-sonnet-5 · 0\/272k · 0 tool calls/);
	assert.match(screen, /Find where refunds are issued\./, "Pi's user message component");
	assert.match(screen, /\$ rg -n refund/, "Pi's bash renderer");
	assert.match(screen, /src\/refund\.ts:12: export function refund\(\)/, "the tool's output");
	assert.match(screen, /read src\/refund\.ts/, "Pi's read renderer");
	assert.match(screen, /compacting context/);
	assert.match(screen, /enter steer · ↑↓ scroll · ctrl\+o expand · ctrl\+x stop · esc back/);

	for (const key of "go".split("")) viewer.handleInput(key);
	viewer.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, ["go"]);
	assert.match(strip(viewer.render(100)).join("\n"), /steering after its current tool calls/);
	viewer.dispose();
	await manager.dispose();
});

test("the panel uses Pi's selector idiom", () => {
	const run = new AgentRun({
		name: "reviewer",
		definition: BUILTIN_AGENTS[0]!,
		description: "review auth changes",
		model: "cpa/claude-opus-5",
		cwd: process.cwd(),
		background: true,
		contextWindow: 1_000_000,
		maxTurns: 80,
		appendPrompt: "",
	});
	run.status = "running";
	run.toolUses = 18;
	run.contextTokens = 41_000;
	run.approval = "Allow git push?";
	const panel = new AgentPanel({ subscribe: () => () => {}, list: () => [run], stop: async () => {} }, async () => {});
	let widget: ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined;
	panel.attach({
		onTerminalInput: () => () => {},
		setWidget: (_key: string, factory: typeof widget) => void (widget = factory),
		getEditorText: () => "",
	} as never);
	const lines = strip(widget!({ requestRender() {} }, plain).render(120));
	assert.match(lines[0]!, /^ agents · 1 running · 1 waiting for you\s+↓ to manage$/);
	assert.match(lines[1]!, /^ {3}\? reviewer review auth changes\s+waiting for your approval · claude-opus-5 · 41k\/1M · 18 tool calls · \d+s$/);
	assert.deepEqual(panel.handleKey("\x1b[B"), { consume: true });
	const active = strip(widget!({ requestRender() {} }, plain).render(120));
	assert.match(active[1]!, /^ → \? reviewer/);
	panel.detach();
});
