import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_AGENTS, discoverAgents, parseAgentFile, projectAgentDirs } from "../src/agents.js";
import { budgetAfterTurn, budgetAtPromptStart, type BudgetState } from "../src/child.js";
import { DEFAULT_EXCLUDED_TOOLS, loadConfig } from "../src/config.js";
import { formatDuration, formatTokens, summarizeToolCall } from "../src/format.js";
import { contextLabel } from "../src/render.js";
import { forwardedExtensionArgs } from "../src/index.js";
import { buildChildArgs, buildChildEnv } from "../src/manager.js";
import { buildChildPrompt } from "../src/prompts.js";
import { createLineSplitter } from "../src/rpc.js";
import { loadTranscript } from "../src/transcript.js";
import { worktreeDirName } from "../src/worktree.js";

test("formatters match the panel's compact style", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(41_234), "41k");
	assert.equal(formatTokens(1_200_000), "1.2M");
	assert.equal(contextLabel(78_000, 150_000, 272_000), "78k/150k budget");
	assert.equal(contextLabel(78_000, undefined, 272_000), "78k/272k");
	assert.equal(contextLabel(78_000, undefined, undefined), "78k");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(125_000), "2m05s");
	assert.equal(formatDuration(3_780_000), "1h03m");
	assert.equal(summarizeToolCall("bash", { command: "rg -n   foo\n src" }), "Bash rg -n foo src");
	assert.equal(summarizeToolCall("read", { path: "/a/b.ts" }), "Read /a/b.ts");
	assert.equal(summarizeToolCall("codemode", { code: '// @options: {"x":1}\nconst r = await tools.bash({})' }), "Codemode const r = await tools.bash({})");
	assert.equal(summarizeToolCall("web_search", { query: "pi rpc" }), "web_search pi rpc");
});

test("an agent file parses Claude Code-style frontmatter and keeps the body as the prompt", () => {
	const { agent, error } = parseAgentFile(
		"---\nname: reviewer\ndescription: >\n  Reviews a diff\n  with fresh context.\ntools: read, bash\ndisallowedTools: [edit]\nmodel: cpa/claude-opus-5\neffort: high\nmaxTurns: 40\ncontextBudget: 150000\nbackground: false\ncontextFiles: false\n---\nYou review diffs.\n",
		"/x/reviewer.md",
		"user",
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
			contextBudget: 150000,
			background: false,
			contextFiles: false,
			source: "user",
			path: undefined,
		},
	);
});

test("agent files fail loudly on bad fields and skip name-less markdown", () => {
	assert.deepEqual(parseAgentFile("# notes\n", "/x/README.md", "user"), {});
	assert.match(parseAgentFile("---\nname: a\n---\n", "/x/a.md", "user").error!, /missing description/);
	assert.match(parseAgentFile("---\nname: a:b\ndescription: d\n---\n", "/x/a.md", "user").error!, /name must be/);
	assert.match(parseAgentFile("---\nname: a\ndescription: d\nthinking: huge\n---\n", "/x/a.md", "user").error!, /thinking must be/);
	assert.match(parseAgentFile("---\nname: [\n---\n", "/x/a.md", "user").error!, /invalid frontmatter/);
	assert.equal(parseAgentFile("---\nname: a\ndescription: d\nmodel: inherit\n---\n", "/x/a.md", "user").agent?.model, undefined);
});

test("discovery layers built-ins, user agents, then project agents closest last", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-discovery-"));
	const userDir = join(root, "agent", "agents");
	mkdirSync(join(userDir, "review"), { recursive: true });
	writeFileSync(join(userDir, "review", "reviewer.md"), "---\nname: reviewer\ndescription: user reviewer\n---\nuser");
	writeFileSync(join(userDir, "scout.md"), "---\nname: scout\ndescription: my scout\nmodel: cpa/claude-sonnet-5\n---\n");
	writeFileSync(join(userDir, "broken.md"), "---\nname: broken\n---\n");
	const repo = join(root, "work", "repo");
	mkdirSync(join(root, "work", ".pi", "agents"), { recursive: true });
	mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
	writeFileSync(join(root, "work", ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: outer\n---\n");
	writeFileSync(join(repo, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: inner\n---\n");

	assert.deepEqual(projectAgentDirs(repo).slice(-2), [join(root, "work", ".pi", "agents"), join(repo, ".pi", "agents")]);
	const trusted = discoverAgents({ userDir, cwd: repo, includeProject: true });
	assert.equal(trusted.agents.get("reviewer")?.description, "inner");
	assert.equal(trusted.agents.get("scout")?.model, "cpa/claude-sonnet-5");
	assert.equal(trusted.agents.get("general-purpose")?.source, "builtin");
	assert.equal(trusted.errors.length, 1);
	assert.match(trusted.errors[0]!, /broken\.md: missing description/);

	const untrusted = discoverAgents({ userDir, cwd: repo, includeProject: false });
	assert.equal(untrusted.agents.get("reviewer")?.description, "user reviewer");
});

test("config falls back to defaults, merges excludes, and reports a broken file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agents-config-"));
	assert.deepEqual(loadConfig(join(dir, "missing.json")).config.excludeTools, DEFAULT_EXCLUDED_TOOLS);
	writeFileSync(join(dir, "c.json"), JSON.stringify({ maxConcurrent: 2, contextBudget: 0, excludeTools: ["web_search"], worktreeDir: "~/wt" }));
	const { config } = loadConfig(join(dir, "c.json"));
	assert.equal(config.maxConcurrent, 2);
	assert.equal(config.contextBudget, undefined, "an invalid value leaves the budget unset");
	assert.equal(loadConfig(join(dir, "missing.json")).config.contextBudget, undefined, "there is no global context budget by default");
	assert.ok(config.excludeTools.includes("web_search") && config.excludeTools.includes("Agent"));
	assert.ok(config.worktreeDir?.endsWith("/wt") && !config.worktreeDir.startsWith("~"));
	writeFileSync(join(dir, "bad.json"), "{");
	assert.match(loadConfig(join(dir, "bad.json")).error!, /bad\.json/);
});

test("the budget warns once near the limit and cuts tools at it, steering only continuing turns", () => {
	const state: BudgetState = { turns: 0, warned: false, exhausted: false, blockedCalls: 0 };
	const limits = { contextBudget: 100_000, maxTurns: 10 };
	assert.equal(budgetAfterTurn(state, { tokens: 50_000, continuing: true, ...limits }).kind, "none");
	const warn = budgetAfterTurn(state, { tokens: 76_000, continuing: true, ...limits });
	assert.equal(warn.kind, "warn");
	assert.match((warn as { message: string }).message, /76k\/100k tokens, 2\/10 turns/);
	assert.equal(budgetAfterTurn(state, { tokens: 80_000, continuing: true, ...limits }).kind, "none", "warns once");
	assert.equal(budgetAfterTurn(state, { tokens: 120_000, continuing: false, ...limits }).kind, "none", "a final answer is left alone");
	assert.equal(budgetAfterTurn(state, { tokens: 101_000, continuing: true, ...limits }).kind, "exhaust");
	assert.equal(state.exhausted, true);
	assert.equal(budgetAfterTurn(state, { tokens: 130_000, continuing: true, ...limits }).kind, "none");

	const unbudgeted: BudgetState = { turns: 0, warned: false, exhausted: false, blockedCalls: 0 };
	assert.equal(budgetAfterTurn(unbudgeted, { tokens: 900_000, continuing: true, maxTurns: 10 }).kind, "none", "no context budget: context never triggers");

	const turns: BudgetState = { turns: 0, warned: false, exhausted: false, blockedCalls: 0 };
	const kinds = Array.from({ length: 10 }, () => budgetAfterTurn(turns, { tokens: 1, continuing: true, maxTurns: 10 }).kind);
	assert.deepEqual(kinds.slice(6), ["none", "warn", "none", "exhaust"]);
});

test("a new prompt resets turns but starts exhausted when context is already over budget", () => {
	const state: BudgetState = { turns: 9, warned: true, exhausted: true, blockedCalls: 4 };
	assert.equal(budgetAtPromptStart(state, { tokens: 50_000, contextBudget: 100_000 }).kind, "none");
	assert.deepEqual(state, { turns: 0, warned: false, exhausted: false, blockedCalls: 0 });

	const over = budgetAtPromptStart(state, { tokens: 120_000, contextBudget: 100_000 });
	assert.equal(over.kind, "exhaust");
	assert.match((over as { message: string }).message, /120k\/100k tokens\). Tools are disabled/);
	assert.equal(state.exhausted, true, "tools are refused from the first call");

	assert.equal(budgetAtPromptStart(state, { tokens: 900_000 }).kind, "none", "no context budget, never exhausted by context");
	assert.equal(state.exhausted, false);
	budgetAtPromptStart(state, { tokens: 80_000, contextBudget: 100_000 });
	assert.equal(state.warned, true, "a prompt starting past 75% is not warned twice");
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

	const env = buildChildEnv({ HERDR_PANE_ID: "p1", HERDR_ENV: "1", PATH: "/bin" }, { id: "ab12", name: "rev", type: "reviewer", contextBudget: 5, maxTurns: 6 });
	assert.equal(env.HERDR_PANE_ID, undefined, "a child never drives the parent's pane");
	assert.equal(env.PATH, "/bin");
	assert.equal(env.PI_AGENTS_CHILD, "1");
	assert.equal(env.PI_SUBAGENT_CHILD, "1");
	assert.equal(env.PI_SUBAGENT_RUN_ID, "ab12");
	assert.equal(env.PI_AGENTS_CONTEXT_BUDGET, "5");
	assert.equal(env.PI_AGENTS_MAX_TURNS, "6");
	const unbudgeted = buildChildEnv({ PI_AGENTS_CONTEXT_BUDGET: "9" }, { id: "x", name: "n", type: "t", maxTurns: 6 });
	assert.equal(unbudgeted.PI_AGENTS_CONTEXT_BUDGET, undefined, "no budget, and none inherited from the parent's env");
});

test("the child prompt states the subagent contract, budget and worktree", () => {
	const scout = BUILTIN_AGENTS.find((agent) => agent.name === "scout")!;
	const prompt = buildChildPrompt({
		name: "scout-2",
		definition: scout,
		contextBudget: 120_000,
		maxTurns: 40,
		worktree: { path: "/w/feat-x", branch: "feat/x", base: "main", repoRoot: "/r", created: true },
	});
	assert.match(prompt, /You are "scout-2", a scout subagent/);
	assert.match(prompt, /You cannot start other subagents/);
	assert.match(prompt, /about 120k tokens of context and 40 turns/);
	assert.match(prompt, /git worktree \/w\/feat-x on branch feat\/x, created from origin\/main/);
	assert.ok(prompt.endsWith(scout.prompt));
	const unbudgeted = buildChildPrompt({ name: "s", definition: scout, maxTurns: 40 });
	assert.match(unbudgeted, /- Budget: 40 turns\./);
});

test("the line splitter breaks on LF only, so U+2028 inside JSON survives", () => {
	const lines: string[] = [];
	const feed = createLineSplitter((line) => lines.push(line));
	feed('{"a":"x\u2028y"}\r\n{"b"');
	feed(":1}\n\n");
	assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ a: "x\u2028y" }, { b: 1 }]);
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

test("a restored agent's transcript is rebuilt from its session file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agents-transcript-"));
	const file = join(dir, "s.jsonl");
	const entries = [
		{ type: "session", id: "h" },
		{ type: "message", message: { role: "user", content: "find foo" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "rg foo" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "no matches" }] } },
	];
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	assert.deepEqual(loadTranscript(file), [
		{ kind: "user", text: "find foo" },
		{ kind: "assistant", text: "looking" },
		{ kind: "tool", text: "Bash rg foo", toolCallId: "c1", status: "error", output: "no matches" },
	]);
	assert.equal(loadTranscript(join(dir, "missing.jsonl"))[0]?.kind, "notice");
});
