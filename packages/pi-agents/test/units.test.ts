import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeAgent, discoverAgents, parseAgentFile } from "../src/agents.js";
import { autocompactDue, type AutocompactState, budgetAfterTurn, budgetAtPromptStart, type BudgetState, toolAllowed, workedPaths } from "../src/child.js";
import { DEFAULT_EXCLUDED_TOOLS, loadConfig } from "../src/config.js";
import { formatDuration, formatTokens, summarizeToolCall, summaryText } from "../src/format.js";
import { contextLabel } from "../src/render.js";
import { forwardedExtensionArgs } from "../src/index.js";
import { buildChildArgs, buildChildEnv } from "../src/manager.js";
import { buildChildPrompt } from "../src/prompts.js";
import { createLineSplitter } from "../src/rpc.js";
import { applyAssistantEvent, snapshot, startAssistant } from "../src/stream.js";
import { loadLog } from "../src/transcript.js";
import { worktreeDirName } from "../src/worktree.js";

test("formatters match the panel's compact style", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(41_234), "41k");
	assert.equal(formatTokens(1_200_000), "1.2M");
	assert.equal(contextLabel(78_000, 1_000_000, 10), "78k/100k autocompact");
	assert.equal(contextLabel(78_000, 272_000), "78k/272k");
	assert.equal(contextLabel(78_000, undefined, 10), "78k");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(125_000), "2m05s");
	assert.equal(formatDuration(3_780_000), "1h03m");
	const text = (name: string, args: unknown) => summaryText(summarizeToolCall(name, args));
	assert.equal(text("bash", { command: "rg -n   foo\n src" }), "$ rg -n foo src", "Pi's own notation");
	assert.equal(text("read", { path: "/a/b.ts", offset: 10, limit: 31 }), "read /a/b.ts:10-40");
	assert.equal(text("grep", { pattern: "foo", path: "src" }), "grep /foo/ in src");
	assert.equal(text("codemode", { code: '// @options: {"x":1}\nconst r = await tools.bash({})' }), "codemode const r = await tools.bash({})");
	assert.equal(text("web_search", { query: "pi rpc" }), "web_search pi rpc");
});

test("an agent file parses Claude Code-style frontmatter and keeps the body as the prompt", () => {
	const { agent, error } = parseAgentFile(
		"---\nname: reviewer\ndescription: >\n  Reviews a diff\n  with fresh context.\ntools: read, bash\ndisallowedTools: [edit]\nmodel: cpa/claude-opus-5\neffort: high\nmaxTurns: 40\nautocompact: 10%\nbackground: false\ncontextFiles: false\n---\nYou review diffs.\n",
		"/x/reviewer.md",
	);
	assert.equal(error, undefined);
	assert.deepEqual(
		{ ...agent, path: undefined },
		{
			name: "reviewer",
			description: "Reviews a diff with fresh context.",
			prompt: "You review diffs.",
			tools: ["read", "bash"],
			disallowedTools: ["edit"],
			model: "cpa/claude-opus-5",
			thinking: "high",
			maxTurns: 40,
			autocompact: 10,
			background: false,
			contextFiles: false,
			source: "user",
			path: undefined,
		},
	);
});

test("agent files fail loudly on bad fields, skip name-less markdown, and name what replaced a retired field", () => {
	assert.deepEqual(parseAgentFile("# notes\n", "/x/README.md"), {});
	assert.match(parseAgentFile("---\nname: a\n---\n", "/x/a.md").error!, /missing description/);
	assert.match(parseAgentFile("---\nname: a:b\ndescription: d\n---\n", "/x/a.md").error!, /name must be/);
	assert.match(parseAgentFile("---\nname: a\ndescription: d\nthinking: huge\n---\n", "/x/a.md").error!, /thinking must be/);
	assert.match(parseAgentFile("---\nname: a\ndescription: d\nautocompact: 120\n---\n", "/x/a.md").error!, /autocompact must be a percentage/);
	assert.match(parseAgentFile("---\nname: [\n---\n", "/x/a.md").error!, /invalid frontmatter/);
	assert.equal(parseAgentFile("---\nname: a\ndescription: d\nmodel: inherit\n---\n", "/x/a.md").agent?.model, undefined);
	const retired = parseAgentFile("---\nname: a\ndescription: d\ncontextBudget: 120000\n---\n", "/x/a.md");
	assert.equal(retired.agent?.name, "a", "the agent still loads");
	assert.match(retired.error!, /contextBudget is no longer supported and was ignored; use autocompact/);
});

test("saved agents come only from the config dir; there are no built-ins", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-discovery-"));
	const userDir = join(root, "agent", "agents");
	mkdirSync(join(userDir, "review"), { recursive: true });
	writeFileSync(join(userDir, "review", "reviewer.md"), "---\nname: reviewer\ndescription: user reviewer\n---\nuser");
	writeFileSync(join(userDir, "broken.md"), "---\nname: broken\n---\n");
	const found = discoverAgents(userDir);
	assert.deepEqual([...found.agents.keys()], ["reviewer"]);
	assert.equal(found.errors.length, 1);
	assert.match(found.errors[0]!, /broken\.md: missing description/);
	assert.equal(discoverAgents(join(root, "missing")).agents.size, 0);
});

test("an inline agent is composed from the call, on top of a saved one when named", () => {
	const inline = composeAgent(undefined, { instructions: "Review diffs.", tools: ["read"], autocompact: 10 });
	assert.deepEqual(inline, { name: "agent", description: "", prompt: "Review diffs.", tools: ["read"], disallowedTools: undefined, model: undefined, thinking: undefined, maxTurns: undefined, autocompact: 10, background: undefined, contextFiles: true, source: "inline" });
	const saved = parseAgentFile("---\nname: reviewer\ndescription: d\nmodel: m/x\nautocompact: 20\ntools: read, bash\n---\nBase role.", "/x/r.md").agent!;
	const built = composeAgent(saved, { instructions: "Also check tests.", autocompact: 5 });
	assert.equal(built.prompt, "Base role.\n\nAlso check tests.");
	assert.equal(built.autocompact, 5, "the call wins");
	assert.deepEqual(built.tools, ["read", "bash"]);
	assert.equal(built.source, "user");
});

test("config falls back to defaults, merges excludes, and reports a broken or retired setting", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agents-config-"));
	assert.deepEqual(loadConfig(join(dir, "missing.json")).config.excludeTools, DEFAULT_EXCLUDED_TOOLS);
	assert.equal(loadConfig(join(dir, "missing.json")).config.autocompact, undefined, "agents get their full window by default");
	writeFileSync(join(dir, "c.json"), JSON.stringify({ maxConcurrent: 2, autocompact: "15%", excludeTools: ["web_search"], worktreeDir: "~/wt" }));
	const { config } = loadConfig(join(dir, "c.json"));
	assert.equal(config.maxConcurrent, 2);
	assert.equal(config.autocompact, 15);
	assert.ok(config.excludeTools.includes("web_search") && config.excludeTools.includes("Agent"));
	assert.ok(config.worktreeDir?.endsWith("/wt") && !config.worktreeDir.startsWith("~"));
	writeFileSync(join(dir, "old.json"), JSON.stringify({ contextBudget: 100000 }));
	assert.match(loadConfig(join(dir, "old.json")).error!, /contextBudget is no longer supported/);
	writeFileSync(join(dir, "bad.json"), "{");
	assert.match(loadConfig(join(dir, "bad.json")).error!, /bad\.json/);
});

test("the turn budget warns once near the limit and cuts tools at it, steering only continuing turns", () => {
	const turns: BudgetState = { turns: 0, warned: false, exhausted: false, blockedCalls: 0 };
	const kinds = Array.from({ length: 10 }, () => budgetAfterTurn(turns, { continuing: true, maxTurns: 10 }).kind);
	assert.deepEqual(kinds.slice(6), ["none", "warn", "none", "exhaust"]);
	assert.equal(turns.exhausted, true);
	const final: BudgetState = { turns: 9, warned: true, exhausted: false, blockedCalls: 0 };
	assert.equal(budgetAfterTurn(final, { continuing: false, maxTurns: 10 }).kind, "none", "a final answer is left alone");
	budgetAtPromptStart(turns);
	assert.deepEqual(turns, { turns: 0, warned: false, exhausted: false, blockedCalls: 0 });
});

test("autocompact triggers at its share of the window, then not again until the context has grown", () => {
	const state: AutocompactState = { armed: false, interrupted: false, compacting: false, floorPending: false, disabled: false };
	assert.equal(autocompactDue(state, { tokens: 90_000, threshold: 100_000 }), false);
	assert.equal(autocompactDue(state, { tokens: null, threshold: 100_000 }), false, "unknown right after compacting");
	assert.equal(autocompactDue(state, { tokens: 100_000, threshold: undefined }), false, "no window, no threshold");
	assert.equal(autocompactDue(state, { tokens: 101_000, threshold: 100_000 }), true);
	state.floorPending = true;
	assert.equal(autocompactDue(state, { tokens: 104_000, threshold: 100_000 }), false, "a context that cannot shrink below the threshold does not compact every turn");
	assert.equal(state.nextAt, 154_000);
	assert.equal(autocompactDue(state, { tokens: 155_000, threshold: 100_000 }), true);
	assert.equal(autocompactDue({ ...state, disabled: true }, { tokens: 999_000, threshold: 100_000 }), false, "after a failure Pi's own threshold takes over");
});

test("a child notices the directories it works in, from file tools and from bash", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-paths-"));
	const repo = join(root, "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "a.ts"), "");
	assert.deepEqual(workedPaths("read", { path: "src/a.ts" }, repo), [join(repo, "src")]);
	assert.deepEqual(workedPaths("write", { path: join(repo, "new.ts") }, root), [repo], "a file about to be written");
	assert.deepEqual(workedPaths("bash", { command: `cd ${repo} && git status` }, root), [repo]);
	assert.deepEqual(workedPaths("bash", { command: `git -C "${repo}" log -1` }, root), [repo]);
	assert.deepEqual(workedPaths("bash", { command: `rg -n foo ${join(repo, "src", "a.ts")} /nonexistent` }, root), [join(repo, "src")]);
	assert.deepEqual(workedPaths("bash", { command: "echo hi" }, root), []);
});

test("child args and env carry the agent's model, prompt, tools and the subagent contract", () => {
	const args = buildChildArgs({
		model: "cpa/claude-opus-5",
		thinking: "high",
		appendPrompt: "# Subagent",
		tools: ["read", "bash"],
		excludeTools: ["Agent", "ask_user_question"],
		contextFiles: false,
		name: "reviewer: Review diff",
		sessionDir: "/s/agents",
	});
	assert.deepEqual(args, [
		"--mode", "rpc", "--session-dir", "/s/agents", "--model", "cpa/claude-opus-5", "--thinking", "high",
		"--append-system-prompt", "# Subagent", "--tools", "read,bash", "--exclude-tools", "Agent,ask_user_question",
		"--no-context-files", "--name", "reviewer: Review diff",
	]);
	assert.deepEqual(buildChildArgs({ model: "m/x", appendPrompt: "p", excludeTools: [], contextFiles: true, name: "n", sessionFile: "/f.jsonl" }).slice(0, 4), ["--mode", "rpc", "--session", "/f.jsonl"]);
	assert.ok(buildChildArgs({ model: "m/x", appendPrompt: "p", excludeTools: [], contextFiles: true, name: "n" }).includes("--no-session"));

	const env = buildChildEnv({ HERDR_PANE_ID: "p1", HERDR_ENV: "1", PATH: "/bin" }, { id: "ab12", name: "rev", type: "reviewer", maxTurns: 6, autocompact: 10, contextFiles: ["/w/AGENTS.md"], loadContextFiles: true });
	assert.equal(env.HERDR_PANE_ID, undefined, "a child never drives the parent's pane");
	assert.equal(env.PATH, "/bin");
	assert.equal(env.PI_AGENTS_CHILD, "1");
	assert.equal(env.PI_SUBAGENT_CHILD, "1");
	assert.equal(env.PI_SUBAGENT_RUN_ID, "ab12");
	assert.equal(env.PI_SUBAGENT_DEPTH, "1");
	const nested = { id: "x", name: "n", type: "t", maxTurns: 6, loadContextFiles: true };
	assert.equal(buildChildEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1" }, nested).PI_SUBAGENT_DEPTH, "2", "agents of a pi started inside a child are one level deeper");
	assert.equal(buildChildEnv({ PI_SUBAGENT_DEPTH: "junk" }, nested).PI_SUBAGENT_DEPTH, "1");
	assert.equal(env.PI_AGENTS_MAX_TURNS, "6");
	assert.equal(env.PI_AGENTS_AUTOCOMPACT, "10");
	assert.deepEqual(JSON.parse(env.PI_AGENTS_CONTEXT_FILES!), ["/w/AGENTS.md"]);
	assert.equal(env.PI_AGENTS_NO_CONTEXT_FILES, undefined);
	assert.ok(buildChildArgs({ model: "m", appendPrompt: "", tools: [], excludeTools: [], contextFiles: true, name: "n" }).includes("--no-tools"), "an empty allowlist is no tools, not every tool");
	assert.ok(!buildChildArgs({ model: "m", appendPrompt: "", excludeTools: [], contextFiles: true, name: "n" }).some((arg) => arg === "--no-tools" || arg === "--tools"));
	assert.equal(buildChildEnv({}, { id: "x", name: "n", type: "t", maxTurns: 6, loadContextFiles: true, tools: [] }).PI_AGENTS_TOOLS, "[]");
	const narrowed = { ...parseAgentFile("---\nname: helper\ndescription: d\ntools: read, bash\n---\n", "/x.md").agent! };
	assert.deepEqual(composeAgent(narrowed, { tools: [] }).tools, [], "a call's empty list overrides a saved agent's tools");
	assert.deepEqual(composeAgent(narrowed, {}).tools, ["read", "bash"]);
	assert.deepEqual(parseAgentFile("---\nname: none\ndescription: d\ntools: []\n---\n", "/y.md").agent!.tools, [], "a saved agent with tools: [] gets none");
	const limited = buildChildEnv({}, { id: "x", name: "n", type: "t", maxTurns: 6, loadContextFiles: true, tools: ["read"], denyTools: ["Agent"] });
	assert.deepEqual(JSON.parse(limited.PI_AGENTS_TOOLS!), ["read"]);
	assert.deepEqual(JSON.parse(limited.PI_AGENTS_DENY_TOOLS!), ["Agent"]);
	assert.equal(toolAllowed("srv_a_b", ["read", "srv_a_*"], []), true);
	assert.equal(toolAllowed("srv_x_b", ["read", "srv_a_*"], []), false);
	assert.equal(toolAllowed("bash", undefined, ["bash"]), false, "the denylist applies without an allowlist");
	assert.equal(toolAllowed("a.b", ["a*b"], []), true);
	assert.equal(toolAllowed("aXb", ["a.b"], []), false, "only * is special");
	const plain = buildChildEnv({ PI_AGENTS_AUTOCOMPACT: "9", PI_AGENTS_CONTEXT_FILES: "[\"/x\"]" }, { id: "x", name: "n", type: "t", maxTurns: 6, loadContextFiles: false });
	assert.equal(plain.PI_AGENTS_AUTOCOMPACT, undefined, "nothing inherited from the parent's own env");
	assert.equal(plain.PI_AGENTS_CONTEXT_FILES, undefined);
	assert.equal(plain.PI_AGENTS_NO_CONTEXT_FILES, "1");
});

test("the child prompt states the subagent contract, where it works, and how it compacts", () => {
	const saved = parseAgentFile("---\nname: scout\ndescription: d\n---\nYou scout.", "/x/s.md").agent!;
	const prompt = buildChildPrompt({
		name: "scout-2",
		definition: saved,
		cwd: "/w/feat-x",
		maxTurns: 40,
		autocompact: 10,
		contextWindow: 1_000_000,
		worktree: { path: "/w/feat-x", branch: "feat/x", base: "main", repoRoot: "/r", created: true },
	});
	assert.match(prompt, /You are "scout-2", a scout subagent/);
	assert.match(prompt, /You cannot start other subagents/);
	assert.match(prompt, /- Budget: 40 turns\. Your context is compacted at 10% of 1M \(100k\)/);
	assert.match(prompt, /You start in \/w\/feat-x, and every bash call starts there/);
	assert.match(prompt, /its AGENTS\.md instructions are added to that tool result/);
	assert.match(prompt, /git worktree \/w\/feat-x on branch feat\/x, created from origin\/main/);
	assert.ok(prompt.endsWith("You scout."));
	const inline = buildChildPrompt({ name: "s", definition: composeAgent(undefined, {}), cwd: "/repos/workbench", maxTurns: 40, worktreeDir: "/home/h/repos/worktrees" });
	assert.match(inline, /You are "s", a subagent working/);
	assert.match(inline, /- Budget: 40 turns\. Keep context lean/);
	assert.match(inline, /worktree add \/home\/h\/repos\/worktrees\/<branch-with-dashes> -b <branch> origin\/<default branch>/);
});

test("the line splitter breaks on LF only, so U+2028 inside JSON survives", () => {
	const lines: string[] = [];
	const feed = createLineSplitter((line) => lines.push(line));
	feed('{"a":"x\u2028y"}\r\n{"b"');
	feed(":1}\n\n");
	assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ a: "x\u2028y" }, { b: 1 }]);
});

test("the line splitter stays linear when a large record arrives in many chunks", () => {
	const lines: string[] = [];
	const feed = createLineSplitter((line) => lines.push(line));
	const record = JSON.stringify({ type: "message_end", text: "y".repeat(4 * 1024 * 1024) });
	const started = performance.now();
	for (let i = 0; i < record.length; i += 1024) feed(record.slice(i, i + 1024));
	feed("\n{\"n\":1}\n{\"n\":2}\n");
	const ms = performance.now() - started;
	assert.equal(lines.length, 3);
	assert.equal(lines[0], record);
	assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line)), [{ n: 1 }, { n: 2 }]);
	assert.ok(ms < 500, `4 MB record in 1 KB chunks took ${Math.round(ms)} ms`);
});

test("streamed tool arguments are parsed when a snapshot is taken, not on every delta", () => {
	const message = startAssistant();
	const args = JSON.stringify({ path: "src/big.ts", content: "z".repeat(50 * 1024) });
	const started = performance.now();
	applyAssistantEvent(message, { type: "toolcall_start", contentIndex: 0, id: "w1", toolName: "write" });
	for (let i = 0; i < args.length; i += 12) applyAssistantEvent(message, { type: "toolcall_delta", contentIndex: 0, delta: args.slice(i, i + 12) });
	const applyMs = performance.now() - started;
	assert.deepEqual(message.content[0]!.arguments, {}, "nothing parsed while only the parent holds it");
	assert.ok(applyMs < 200, `applying 4,300 deltas took ${Math.round(applyMs)} ms`);
	const call = snapshot(message).content[0]!;
	assert.equal((call.arguments as { path: string }).path, "src/big.ts");
	assert.equal((call.arguments as { content: string }).content.length, 50 * 1024);
	const again = performance.now();
	for (let i = 0; i < 1000; i++) snapshot(message);
	assert.ok(performance.now() - again < 100, "an unchanged snapshot does not parse again");
	applyAssistantEvent(message, { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "w1", name: "write", arguments: { path: "final.ts" } } });
	assert.deepEqual(snapshot(message).content[0]!.arguments, { path: "final.ts" }, "the final call replaces the preview");
});

test("worktree directory names flatten branch slashes", () => {
	assert.equal(worktreeDirName("feat/pi-agents"), "feat-pi-agents");
	assert.equal(worktreeDirName("hank/v1284 fe"), "hank-v1284-fe");
});

test("-e extensions are forwarded to children as absolute paths", () => {
	assert.deepEqual(
		forwardedExtensionArgs(["--model", "x", "-e", "./ext", "--extension=/abs/b", "--extension", "builtin:codemode", "-e"], "/work"),
		["-e", "/work/ext", "-e", "/abs/b", "-e", "builtin:codemode"],
	);
});

test("a restored agent's log is rebuilt from its session file, messages intact", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agents-transcript-"));
	const file = join(dir, "s.jsonl");
	const assistant = { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "rg foo" } }] };
	const result = { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "no matches" }] };
	const entries = [
		{ type: "session", id: "h" },
		{ type: "message", message: { role: "user", content: "find foo" } },
		{ type: "model_change", id: "m" },
		{ type: "message", message: assistant },
		{ type: "message", message: result },
	];
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\nnot json\n`);
	assert.deepEqual(loadLog(file), [
		{ kind: "message", message: { role: "user", content: "find foo" } },
		{ kind: "message", message: assistant },
		{ kind: "message", message: result },
	]);
	assert.equal(loadLog(join(dir, "missing.jsonl"))[0]?.kind, "notice");
});
