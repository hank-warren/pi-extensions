import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.js";
import { type AgentDefinition, composeAgent } from "../src/agents.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import piAgents from "../src/index.js";
import { AgentManager, type AgentRun } from "../src/manager.js";
import { ensureWorktree } from "../src/worktree.js";

const FAKE_PI = join(import.meta.dirname, "support", "fake-pi.mjs");
const general: AgentDefinition = composeAgent(undefined, {});

function managerWith(options: {
	maxConcurrent?: number;
	select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
	editor?: () => Promise<string | undefined>;
} = {}) {
	const finished: AgentRun[] = [];
	const context = createMockContext({ mode: "tui", hasUI: true, select: options.select, editor: options.editor });
	const manager = new AgentManager({
		config: () => ({ ...DEFAULT_CONFIG, maxConcurrent: options.maxConcurrent ?? 4, idleTtlSeconds: 60 }),
		ctx: () => context.ctx,
		spawnCommand: () => [process.execPath, FAKE_PI],
		sessionDir: () => undefined,
		onFinished: (run) => finished.push(run),
	});
	const create = (name = "worker") => manager.create({
		name,
		definition: general,
		description: "test task",
		model: "test/model",
		cwd: process.cwd(),
		background: true,
		maxTurns: 10,
		appendPrompt: "# Subagent",
	});
	return { manager, finished, create };
}

test("a run streams tool use and usage, finishes with its last answer, and resumes on a follow-up", async () => {
	const { manager, finished, create } = managerWith();
	try {
		const run = create();
		manager.start(run, "hello");
		await manager.waitFor(run);
		assert.equal(run.status, "done");
		assert.equal(run.result, "echo: hello");
		assert.equal(run.toolUses, 1);
		assert.deepEqual(run.toolLog, [{ head: "$", rest: "ls -la" }]);
		assert.equal(run.contextTokens, 1050);
		assert.ok(run.sessionFile?.startsWith("/tmp/fake-"));
		const roles = run.log.map((entry) => (entry.kind === "message" ? entry.message.role : entry.kind));
		assert.deepEqual(roles, ["user", "assistant"], "the child's own messages, as its session holds them");
		assert.equal(finished.length, 1);
		assert.ok(run.alive, "the process idles for follow-ups");

		const pid = run.proc!.pid;
		assert.equal(await manager.message(run, "again"), "started");
		await manager.waitFor(run);
		assert.equal(run.result, "echo: again");
		assert.equal(run.proc!.pid, pid, "a follow-up reuses the idle process");
		assert.equal(run.toolUses, 1, "counted per prompt, like the elapsed time");

		await manager.message(run, "FAIL");
		await manager.waitFor(run);
		assert.equal(run.status, "failed");
		assert.equal(run.result, undefined, "a follow-up without an answer does not report the previous one");
	} finally {
		await manager.dispose();
	}
});

test("steering reaches a running agent", async () => {
	const { manager, create } = managerWith();
	try {
		const run = create();
		manager.start(run, "SLOW work");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(run.status, "running");
		assert.equal(await manager.message(run, "wrap up"), "steered");
		await manager.waitFor(run);
		assert.equal(run.result, "steered: wrap up");
		const steers = run.log.filter((entry) => entry.kind === "message" && entry.message.role === "user" && entry.message.content === "wrap up");
		assert.equal(steers.length, 1, "the steer appears once, when the child delivers it");
	} finally {
		await manager.dispose();
	}
});

test("a child's dialog surfaces in the parent labeled with the agent, and the answer goes back", async () => {
	const titles: string[] = [];
	const { manager, create } = managerWith({
		select: async (title) => {
			titles.push(title);
			return "Block";
		},
	});
	try {
		const run = create("pusher");
		manager.start(run, "ASK push");
		await manager.waitFor(run);
		assert.deepEqual(titles, ["[pusher] Allow git push?"]);
		assert.equal(run.result, "dialog: Block");
		assert.equal(run.approval, undefined);
	} finally {
		await manager.dispose();
	}
});

test("a forwarded dialog closes once the tool call waiting on it is gone", async () => {
	let aborted = false;
	const { manager, create } = managerWith({
		select: (_title, _options, opts) =>
			new Promise((resolve) => {
				opts?.signal?.addEventListener("abort", () => {
					aborted = true;
					resolve(undefined);
				});
			}),
	});
	try {
		const run = create("orphan");
		manager.start(run, "ORPHAN");
		await manager.waitFor(run);
		assert.equal(aborted, true, "the parent's prompt does not outlive the child's interest in it");
		assert.equal(run.result, "orphaned");
		assert.equal(run.dialogs.size, 0);
	} finally {
		await manager.dispose();
	}
});

test("an editor dialog from a child is declined without opening an uncancellable editor in the parent", async () => {
	let opened = 0;
	const { manager, create } = managerWith({
		editor: async () => {
			opened += 1;
			return "edited";
		},
	});
	try {
		const run = create("editor");
		manager.start(run, "EDIT");
		await manager.waitFor(run);
		assert.equal(opened, 0);
		assert.equal(run.result, "dialog: cancelled");
		assert.ok(run.log.some((entry) => entry.kind === "notice" && /declined an editor dialog \(Edit plan\)/.test(entry.text)));
	} finally {
		await manager.dispose();
	}
});

test("a follow-up sent while the old process is still shutting down starts a fresh one", async () => {
	const { manager, create } = managerWith();
	try {
		// Stopped mid-run, then resumed before the stop finished.
		const stopped = create("stopped");
		manager.start(stopped, "SLOW");
		await new Promise((resolve) => setTimeout(resolve, 150));
		const firstPid = stopped.proc!.pid;
		const stopping = manager.stop(stopped);
		assert.equal(stopped.status, "stopped");
		assert.equal(stopped.alive, false, "a stopping process takes no prompts");
		assert.equal(await manager.message(stopped, "resume"), "started");
		await stopping;
		await manager.waitFor(stopped);
		assert.equal(stopped.status, "done", "the old process's exit does not fail the new run");
		assert.equal(stopped.result, "echo: resume");
		assert.notEqual(stopped.proc!.pid, firstPid);

		// Stopped again while the follow-up waits for the old process: nothing is resurrected.
		const raced = create("raced");
		manager.start(raced, "hello");
		await manager.waitFor(raced);
		void raced.proc!.stop();
		assert.equal(await manager.message(raced, "again"), "started");
		await manager.stop(raced);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(raced.status, "stopped");
		assert.equal(raced.proc, undefined, "no new child was spawned after the stop");

		// Idle TTL firing just before a follow-up.
		const idle = create("idle");
		manager.start(idle, "hello");
		await manager.waitFor(idle);
		const idlePid = idle.proc!.pid;
		void idle.proc!.stop();
		assert.equal(await manager.message(idle, "again"), "started");
		await manager.waitFor(idle);
		assert.equal(idle.status, "done");
		assert.equal(idle.result, "echo: again");
		assert.notEqual(idle.proc!.pid, idlePid);
	} finally {
		await manager.dispose();
	}
});

test("provider errors, crashes and stops end the run with the right status", async () => {
	const { manager, create } = managerWith();
	try {
		const failing = create("failing");
		manager.start(failing, "FAIL");
		await manager.waitFor(failing);
		assert.equal(failing.status, "failed");
		assert.equal(failing.error, "529 overloaded");

		const crashing = create("crashing");
		manager.start(crashing, "EXIT");
		await manager.waitFor(crashing);
		assert.equal(crashing.status, "failed");
		assert.match(crashing.error!, /exited unexpectedly/);

		const slow = create("slow");
		manager.start(slow, "SLOW");
		await new Promise((resolve) => setTimeout(resolve, 150));
		await manager.stop(slow);
		assert.equal(slow.status, "stopped");
		assert.equal(slow.alive, false);
	} finally {
		await manager.dispose();
	}
});

test("runs past maxConcurrent queue and start as slots free", async () => {
	const { manager, create } = managerWith({ maxConcurrent: 1 });
	try {
		const first = create("first");
		const second = create("second");
		manager.start(first, "SLOW");
		manager.start(second, "queued work");
		assert.equal(second.status, "queued");
		await new Promise((resolve) => setTimeout(resolve, 150));
		await manager.message(first, "done");
		await manager.waitFor(first);
		await manager.waitFor(second);
		assert.equal(second.result, "echo: queued work");
	} finally {
		await manager.dispose();
	}
});

test("a run stopped for autocompact is not finished: it compacts and continues the same task", async () => {
	const { manager, finished, create } = managerWith();
	try {
		const run = create();
		manager.start(run, "COMPACT");
		await manager.waitFor(run);
		assert.equal(run.status, "done");
		assert.equal(run.result, "echo: Compaction completed. Continue.");
		assert.equal(finished.length, 1, "one result, after the continuation");
		const notices = run.log.filter((entry) => entry.kind === "notice").map((entry) => (entry as { text: string }).text);
		assert.ok(notices.includes("autocompact: compacting context, then continuing"));
	} finally {
		await manager.dispose();
	}
});

test("in a child process the extension registers no tools, so a child can never start agents", () => {
	process.env.PI_AGENTS_CHILD = "1";
	try {
		const mock = createMockPi();
		piAgents(mock.pi);
		assert.deepEqual(mock.tools, []);
		assert.deepEqual(
			[...mock.events.keys()].sort(),
			["agent_settled", "before_agent_start", "before_provider_request", "session_compact", "tool_call", "tool_result", "turn_end"],
			"no agent_start hook: Pi's retries must not reset the budget",
		);
	} finally {
		delete process.env.PI_AGENTS_CHILD;
	}
});

test("agents are composed per call or start from a saved one, run behind codemode, and announce background results", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agents-tool-"));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ piCommand: [process.execPath, FAKE_PI] }));
	process.env.PI_AGENTS_CONFIG = join(dir, "config.json");
	const agentsDir = join(process.env.PI_CODING_AGENT_DIR!, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "reviewer.md"), "---\nname: reviewer\ndescription: Reviews diffs.\nautocompact: 10\n---\nYou review diffs.\n");
	const mock = createMockPi({ activeTools: ["read", "bash", "codemode", "Agent"] });
	const model = { provider: "test", id: "model", contextWindow: 1_000_000 };
	const context = createMockContext({
		cwd: dir,
		mode: "rpc",
		hasUI: true,
		model,
		models: [model],
		sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] },
	});
	piAgents(mock.pi);
	try {
		await mock.events.get("session_start")![0]!({ reason: "startup" }, context.ctx);
		// A tool's context cannot read the system prompt options, so the parent keeps its files from each prompt.
		await mock.events.get("before_agent_start")![0]!({ systemPrompt: "", systemPromptOptions: { contextFiles: [{ path: "/ws/AGENTS.md", content: "x" }] } }, context.ctx);
		const latest = (name: string) => mock.tools.filter((tool) => tool.name === name).at(-1) as unknown as {
			description: string;
			exposure?: string;
			execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
		};
		const agent = latest("Agent");
		assert.equal(agent.exposure, "codemode", "reached through codemode scripts when the session has codemode");
		assert.ok(!(mock.pi as unknown as { getActiveTools(): string[] }).getActiveTools().includes("Agent"), "and no longer declared to the model directly");
		assert.match(agent.description, /Saved agents[^\n]*\n- reviewer: Reviews diffs\./);
		const call = (params: Record<string, unknown>) => agent.execute("call-1", { description: "check the thing", prompt: "hi", ...params }, undefined, undefined, context.ctx);

		await assert.rejects(call({ agent: "nope" }), /No saved agent "nope". Saved agents: reviewer\./);
		await assert.rejects(call({ model: "other/x" }), /Unknown model "other\/x"/);
		await assert.rejects(call({ autocompact: 150 }), /autocompact is a percentage/);

		const foreground = await call({ run_in_background: false, instructions: "Be brief." });
		assert.equal(foreground.structuredContent?.status, "done");
		assert.equal(foreground.structuredContent?.name, "check-the-thing", "named after its description");
		assert.equal(foreground.structuredContent?.type, "", "composed inline, so no saved type");
		assert.match(foreground.content[0]!.text, /^echo: hi\n\n\[check-the-thing \(id \w+\) · done · 1 tool call · /);

		const saved = await call({ agent: "reviewer", run_in_background: false, autocompact: 20 });
		assert.equal(saved.structuredContent?.type, "reviewer");

		const background = await call({ name: "bg" });
		assert.match(background.content[0]!.text, /^Started bg \(id \w+, test\/model\) in the background/);
		for (let i = 0; i < 100 && mock.sentMessages.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
		const sent = mock.sentMessages[0] as { message: { customType: string; content: string }; options: Record<string, unknown> };
		assert.equal(sent.message.customType, "pi-agents-result");
		assert.match(sent.message.content, /<agent-result name="bg" id="\w+" status="done">/);
		assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "followUp" });
		const runs = mock.entries.filter((entry) => entry.customType === "pi-agents-run");
		assert.equal(runs.length, 3, "every run is persisted for resume");
		const inline = runs.find((entry) => (entry.data as { name: string }).name === "check-the-thing")!.data as { definition?: AgentDefinition; contextFiles?: string[] };
		assert.equal(inline.definition?.prompt, "Be brief.", "an inline agent's setup is kept for resume");
		assert.deepEqual(inline.contextFiles, ["/ws/AGENTS.md"], "children follow the parent's instruction files");
		const reviewer = runs.find((entry) => (entry.data as { name: string }).name === saved.structuredContent?.name)!.data as { definition?: AgentDefinition; autocompact?: number };
		assert.equal(reviewer.definition, undefined, "a saved agent is restored from its file");
		assert.equal(reviewer.autocompact, 20, "a call overrides the saved agent");

		// A follow-up to the finished agent reports back again (the viewer uses the same path).
		const resumed = await latest("SendMessage").execute("call-2", { to: "bg", message: "more" }, undefined, undefined, context.ctx);
		assert.match(resumed.content[0]!.text, /bg resumed in the background/);
		for (let i = 0; i < 100 && mock.sentMessages.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
		const second = mock.sentMessages[1] as { message: { content: string } } | undefined;
		assert.match(second?.message.content ?? "", /echo: more/);
	} finally {
		await mock.events.get("session_shutdown")![0]!({}, context.ctx);
		delete process.env.PI_AGENTS_CONFIG;
	}
});

test("without codemode the agent tools are ordinary direct tools", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	const context = createMockContext({ mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] } });
	piAgents(mock.pi);
	try {
		await mock.events.get("session_start")![0]!({ reason: "startup" }, context.ctx);
		const agent = mock.tools.filter((tool) => tool.name === "Agent").at(-1) as unknown as { exposure?: string };
		assert.equal(agent.exposure, "direct");
	} finally {
		await mock.events.get("session_shutdown")![0]!({}, context.ctx);
	}
});

test("a worktree is created from origin's default branch beside the repo, then reused", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-wt-"));
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
	git(root, "clone", "-q", join(root, "origin.git"), "repo");
	const repo = join(root, "repo");
	writeFileSync(join(repo, "a.txt"), "a");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");
	git(repo, "push", "-q", "origin", "HEAD:main");
	git(repo, "remote", "set-head", "origin", "main");
	mkdirSync(join(root, "plain"));

	const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
		try {
			return { stdout: git(options?.cwd ?? root, ...args), stderr: "", code: 0 };
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; status?: number };
			return { stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? ""), code: failure.status ?? 1 };
		}
	};
	const created = await ensureWorktree(exec, { repo: "repo", branch: "feat/x" }, { cwd: root });
	assert.deepEqual({ ...created, repoRoot: undefined }, { path: join(root, "worktrees", "feat-x"), branch: "feat/x", base: "main", repoRoot: undefined, created: true });
	assert.ok(existsSync(join(root, "worktrees", "feat-x", "a.txt")));
	const reused = await ensureWorktree(exec, { repo: join(root, "repo"), branch: "feat/x" }, { cwd: "/" });
	assert.equal(reused.created, false);
	const custom = await ensureWorktree(exec, { repo: "repo", branch: "fix/y", base: "origin/main" }, { cwd: root, worktreeDir: join(root, "elsewhere") });
	assert.equal(custom.path, join(root, "elsewhere", "fix-y"));
	await assert.rejects(ensureWorktree(exec, { repo: "plain", branch: "a" }, { cwd: root }), /not a git repository/);
	await assert.rejects(ensureWorktree(exec, { repo: "repo", branch: "bad..name" }, { cwd: root }), /invalid branch name/);
	await assert.rejects(ensureWorktree(exec, { repo: "repo", branch: "-x" }, { cwd: root }), /invalid branch name/);
	const marker = join(root, "pwned");
	await assert.rejects(
		ensureWorktree(exec, { repo: "repo", branch: "feat/z", base: `--upload-pack=touch ${marker}` }, { cwd: root }),
		/invalid base branch/,
	);
	await assert.rejects(ensureWorktree(exec, { repo: "repo", branch: "feat/z", base: "main:refs/heads/main" }, { cwd: root }), /invalid base branch/);
	assert.equal(existsSync(marker), false, "an option-shaped base never reaches git fetch");
});

test("a child adds the parent's instruction files, loads a directory's AGENTS.md on entry, and compacts at its autocompact share", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-child-"));
	const workspace = join(root, "workbench");
	const repo = join(root, "worktrees", "feat-x");
	const other = join(root, "other");
	for (const dir of [workspace, repo, join(other, "src")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "shared rules");
	writeFileSync(join(workspace, "AGENTS.md"), "workspace rules");
	writeFileSync(join(repo, "AGENTS.md"), "repo rules");
	writeFileSync(join(other, "CLAUDE.md"), "other repo rules");
	writeFileSync(join(other, "src", "a.ts"), "");
	Object.assign(process.env, {
		PI_AGENTS_CHILD: "1",
		PI_AGENTS_AUTOCOMPACT: "10",
		PI_AGENTS_CONTEXT_FILES: JSON.stringify([join(root, "AGENTS.md"), join(workspace, "AGENTS.md")]),
	});
	try {
		const mock = createMockPi();
		piAgents(mock.pi);
		const on = (name: string) => (...args: unknown[]) => mock.events.get(name)![0]!(...(args as [unknown, unknown]));
		const statuses: Array<[string, string | undefined]> = [];
		let tokens: number | null = 50_000;
		let aborted = 0;
		let compactOptions: { onComplete?: () => void } | undefined;
		const ctx = {
			cwd: repo,
			model: { contextWindow: 1_000_000 },
			getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
			ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]), notify: () => {} },
			abort: () => void (aborted += 1),
			compact: (options: { onComplete?: () => void }) => void (compactOptions = options),
		};

		// Pi loaded the worktree's chain; the parent's workspace file is added after the shared one.
		const contextFiles = [{ path: join(root, "AGENTS.md"), content: "shared rules" }, { path: join(repo, "AGENTS.md"), content: "repo rules" }];
		await on("before_agent_start")({ systemPrompt: "", systemPromptOptions: { contextFiles } }, ctx);
		assert.deepEqual(contextFiles.map((file) => file.content), ["shared rules", "workspace rules", "repo rules"]);

		// Working in another repository brings its instructions along, once.
		const result = await on("tool_result")({ toolName: "read", input: { path: join(other, "src", "a.ts") }, content: [{ type: "text", text: "file" }] }, ctx) as { content: Array<{ text: string }> };
		assert.equal(result.content.length, 2);
		assert.match(result.content[1]!.text, /Instructions for the directories you just worked in[\s\S]*CLAUDE\.md\n\nother repo rules/);
		assert.doesNotMatch(result.content[1]!.text, /shared rules|repo rules\n/, "nothing it already has");
		assert.equal(await on("tool_result")({ toolName: "bash", input: { command: `cd ${other} && ls` }, content: [] }, ctx), undefined, "not twice");

		// A codemode script's nested calls report through the script's own result.
		writeFileSync(join(workspace, "CLAUDE.md"), "unused: AGENTS.md wins");
		const nestedDir = join(root, "nested");
		mkdirSync(nestedDir);
		writeFileSync(join(nestedDir, "AGENTS.md"), "nested rules");
		assert.equal(await on("tool_result")({ toolName: "ls", input: { path: nestedDir }, parentToolCallId: "c1", content: [] }, ctx), undefined);
		const script = await on("tool_result")({ toolName: "codemode", input: { code: "" }, content: [] }, ctx) as { content: Array<{ text: string }> };
		assert.match(script.content[0]!.text, /nested rules/);

		// Below 10% of the window nothing happens; past it the next request stops, Pi compacts, the task continues.
		await on("turn_end")({ toolResults: [{}] }, ctx);
		await on("before_provider_request")({ payload: {} }, ctx);
		assert.equal(aborted, 0);
		tokens = 120_000;
		await on("turn_end")({ toolResults: [{}] }, ctx);
		await on("before_provider_request")({ payload: {} }, ctx);
		assert.equal(aborted, 1);
		assert.deepEqual(statuses.at(-1), ["pi-agents-compact", "compacting"], "the parent hears before the stopped run settles");
		await on("agent_settled")({}, ctx);
		assert.ok(compactOptions, "compacts through Pi, so compaction extensions apply");
		(compactOptions as unknown as { onError(error: Error): void }).onError(new Error("Nothing to compact (session too small)"));
		assert.deepEqual(mock.sentUserMessages.at(-1), { text: "Compaction completed. Continue.", options: undefined });
		await on("turn_end")({ toolResults: [{}] }, ctx);
		await on("before_provider_request")({ payload: {} }, ctx);
		assert.equal(aborted, 1, "too little history to summarize yet: wait for the context to grow, without giving up");
		tokens = 175_000;
		compactOptions = undefined;
		await on("turn_end")({ toolResults: [{}] }, ctx);
		await on("before_provider_request")({ payload: {} }, ctx);
		assert.equal(aborted, 2);
		await on("agent_settled")({}, ctx);
		compactOptions!.onComplete!();
		assert.deepEqual(mock.sentUserMessages.at(-1), { text: "Compaction completed. Continue.", options: undefined });
		assert.deepEqual(statuses.at(-1), ["pi-agents-compact", undefined]);
	} finally {
		for (const key of ["PI_AGENTS_CHILD", "PI_AGENTS_AUTOCOMPACT", "PI_AGENTS_CONTEXT_FILES"]) delete process.env[key];
	}
});
