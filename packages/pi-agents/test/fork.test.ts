import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { composeAgent, parseAgentFile } from "../src/agents.js";
import { type Entry, FORK_ENTRY, FORK_NOTE, forkHistory, writeForkSession } from "../src/fork.js";
import { buildChildPrompt } from "../src/prompts.js";
import { loadLog } from "../src/transcript.js";
import { ensureWorktree, type Exec, parseRemoteHead } from "../src/worktree.js";

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content: unknown[]) => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage: {}, stopReason: "toolUse", timestamp: 2 });
const toolResult = (id: string, name: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 3 });
const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });

test("a fork resumes to exactly the parent's model context, with the call that started it closed", () => {
	const parent = SessionManager.inMemory("/work");
	parent.appendMessage(user("old question") as never);
	parent.appendMessage(assistant([{ type: "text", text: "old answer" }]) as never);
	const kept = parent.appendMessage(user("kept question") as never);
	parent.appendMessage(assistant([{ type: "text", text: "kept answer" }]) as never);
	parent.appendCompaction("summary of the old exchange", kept, 5000);
	parent.appendCustomEntry("plan-mode", { active: true });
	parent.appendModelChange("p", "m2");
	parent.appendCustomMessageEntry("note", "a custom message", true);
	const task = parent.appendMessage(user("current task") as never);
	parent.appendMessage(user("an abandoned branch") as never);
	parent.branch(task);
	parent.appendMessage(assistant([{ type: "text", text: "starting two" }, call("c1", "codemode"), call("c2", "bash")]) as never);
	parent.appendMessage(toolResult("c2", "bash", "done") as never);

	const dir = mkdtempSync(join(tmpdir(), "pi-agents-fork-"));
	const fork = writeForkSession({ contextEntries: parent.buildContextEntries() as unknown as Entry[], cwd: "/child", sessionDir: join(dir, "agents"), parentSession: "/parent.jsonl", now: 9 });
	assert.equal(fork.closed, 1);
	assert.equal(statSync(fork.file).mode & 0o777, 0o600);

	const child = SessionManager.open(fork.file);
	const closing = { role: "toolResult", toolCallId: "c1", toolName: "codemode", content: [{ type: "text", text: FORK_NOTE }], isError: false, timestamp: 9 };
	assert.deepEqual(child.buildSessionContext().messages, [...parent.buildSessionContext().messages, closing]);
	assert.equal(child.getHeader()?.parentSession, "/parent.jsonl");
	assert.equal(child.getHeader()?.cwd, "/child");
	// Extension state stays behind; only the marker is a custom entry.
	assert.deepEqual(child.getEntries().filter((entry) => entry.type === "custom").map((entry) => (entry as { customType: string }).customType), [FORK_ENTRY]);
	assert.equal(child.getEntries().some((entry) => entry.type === "model_change"), false);

	// The child's own transcript starts at the fork.
	const log = loadLog(fork.file);
	assert.deepEqual(log, [{ kind: "notice", text: `forked from the supervising session (${fork.messages} entries of its conversation)` }]);
	writeFileSync(fork.file, `${readFileSync(fork.file, "utf8")}${JSON.stringify({ type: "message", message: user("the forked task") })}\n`);
	assert.deepEqual(loadLog(fork.file).slice(1), [{ kind: "message", message: user("the forked task") }]);
});

test("a fork applies context edits, keeps branch summaries, and closes nothing when no call is pending", () => {
	const entry = (id: string, fields: Record<string, unknown>): Entry => ({ id, parentId: null, timestamp: "t", type: "message", ...fields });
	const { entries, closed } = forkHistory([
		entry("a", { message: user("keep") }),
		entry("b", { message: assistant([{ type: "text", text: "secret tool dump" }]) }),
		entry("c", { message: user("drop me") }),
		entry("s", { type: "branch_summary", fromId: "a", summary: "tried another way" }),
		entry("e1", { type: "context_edit", targetId: "b", replacement: { content: "pruned" } }),
		entry("e2", { type: "context_edit", targetId: "c", replacement: null }),
		entry("l", { type: "label", targetId: "a", label: "x" }),
	]);
	assert.equal(closed, 0);
	assert.deepEqual(entries.map((item) => item.id), ["a", "b", "s"]);
	assert.deepEqual(entries.map((item) => item.parentId), [null, "a", "b"]);
	assert.deepEqual((entries[1]!.message as { content: unknown }).content, [{ type: "text", text: "pruned" }]);
	assert.throws(() => writeForkSession({ contextEntries: [], cwd: "/w", sessionDir: mkdtempSync(join(tmpdir(), "pi-agents-fork-")) }), /no conversation to fork/);
});

test("fork is a call parameter or a saved agent's default, and a forked child is told what its history is", () => {
	const saved = parseAgentFile("---\nname: helper\ndescription: helps\ncontext: fork\n---\nbody", "/a/helper.md").agent!;
	assert.equal(saved.context, "fork");
	assert.equal(composeAgent(saved, {}).context, "fork");
	assert.equal(composeAgent(saved, { context: "fresh" }).context, "fresh");
	assert.equal(composeAgent(undefined, {}).context, undefined);
	assert.match(parseAgentFile("---\nname: x\ndescription: y\ncontext: clone\n---\n", "/a/x.md").error ?? "", /context must be one of fresh, fork/);

	const prompt = (forked: boolean) => buildChildPrompt({ name: "n", definition: composeAgent(undefined, {}), cwd: "/w", maxTurns: 10, forked });
	assert.match(prompt(true), /copy of the supervising session's/);
	assert.doesNotMatch(prompt(false), /copy of the supervising session's/);
});

const exec: Exec = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
			resolve({ stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
		});
	});

test("without origin/HEAD, the worktree base comes from origin's own HEAD", async () => {
	assert.equal(parseRemoteHead("ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n"), "trunk");
	assert.equal(parseRemoteHead("abc123\tHEAD\n"), undefined);

	const dir = mkdtempSync(join(tmpdir(), "pi-agents-worktree-"));
	const git = async (cwd: string, ...args: string[]) => {
		const result = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=trunk", ...args], { cwd });
		assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trim();
	};
	await git(dir, "init", "--bare", "origin.git");
	await git(dir, "init", "seed");
	await git(join(dir, "seed"), "commit", "--allow-empty", "-m", "seed");
	await git(join(dir, "seed"), "push", join(dir, "origin.git"), "trunk");
	await git(dir, "clone", "origin.git", "repo");
	const repo = join(dir, "repo");
	await git(repo, "remote", "set-head", "origin", "-d");

	const worktree = await ensureWorktree(exec, { repo, branch: "feat/x" }, { cwd: dir, worktreeDir: join(dir, "wt") });
	assert.equal(worktree.base, "trunk");
	assert.equal(worktree.path, join(dir, "wt", "feat-x"));
	assert.equal(await git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD"), "feat/x");

	await git(repo, "remote", "set-url", "origin", join(dir, "gone.git"));
	await assert.rejects(ensureWorktree(exec, { repo, branch: "feat/y" }, { cwd: dir, worktreeDir: join(dir, "wt") }), /no origin\/HEAD, and origin did not report its HEAD; pass worktree.base/);
});
